"""`aivc bg-blur <影片> --masks <obj1/masks.aivm> -o 虛化.mp4`（op `bg.blur`）：主體留著、背景虛化或換色。

對標 CapCut / Riverside / Premiere 的人像模式。完整的路跟移除物件同一條，只差最後一步：

    aivc text-boxes <影片> --frame 0 --text "person"    # 文字 → 框
    aivc seg <影片> --frames 0:209 --box <上一步的框>     # 框 → 逐幀遮罩
    aivc bg-blur <影片> --masks <obj1/masks.aivm> -o 虛化.mp4

## 跟 inpaint 的三個差別

- **不用背景板**，所以沒有「鏡頭不能動」與「背景要露出過」那兩個守門員：這條路對任何素材都成立。
- **改的是遮罩外面**，不是裡面。所以每一幀都會重寫（不像 inpaint 可以原樣放行），
  ROI 一律是整張。
- **光暈**是這裡唯一會出問題的地方，解法在 `bg/blur.normalized_blur`（主體像素完全不參與模糊）。

## 這一幀找不到主體時

原樣放行、計進 `missingFrames`。兩個選擇都不好看（整片糊一下 vs 突然清楚一下），
但「不動」至少是**可逆**的：使用者看到 missingFrames 就知道是追蹤在那幾幀斷了，
該回去補遮罩，而不是以為虛化壞了。

## 只改該改的位元組

合成走 `comp/_color.write_back`（與平面替換、移除物件同一支）：在線性 RGB 裡混色再寫回
yuv420 平面。**不可以混用解碼器那一套轉換** —— write_back 寫的是差值，混用的誤差不會互相抵消。
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path
from typing import Any

from .. import env
from . import Ctx, OpError, register
from .inpaint import _encode, dilate_mask, open_masks, parse_frames, union_mask

STAGE = "bg.blur"
STAGE_MARK = "bg.mark"
#: 輸出品質（crf / cq）。0 是合法值（無損），所以取值一律 `is not None` 不可以用 `or`。
DEFAULT_CQ = 19
#: 主體佔畫面超過這個比例就擋下：遮罩八成框錯了（框到整個畫面），做下去只會得到一支原片。
MAX_SUBJECT_COVERAGE = 0.9


def _args(p: argparse.ArgumentParser) -> None:
    p.add_argument("video", help="影片（通常是 proxy）")
    p.add_argument("--masks", action="append", required=True, metavar="AIVM", help="aivc seg 寫出的 masks.aivm（可重複；多個主體會合併）")
    p.add_argument("-o", "--out", required=True, help="輸出影片")
    p.add_argument("--frames", default=None, metavar="K0:K1", help="只處理這段 proxy 幀（預設整支）")
    p.add_argument("--strength", type=float, default=None, help="虛化強度＝畫面寬度的百分比（預設 1.5；跟著寬度走才能在 720p 與 4K 上看起來一樣）")
    p.add_argument("--color", default=None, metavar="R,G,B", help="改成換純色背景（0-255），例如 0,120,0；給了就不虛化")
    p.add_argument("--dilate", type=int, default=None, help="主體遮罩先膨脹幾個像素（預設 2；SAM 的邊通常偏緊）")
    p.add_argument("--feather", type=int, default=None, help="主體邊緣羽化半徑（預設 3）")
    p.add_argument("--codec", default=None, help="輸出編碼器（預設 auto）")
    p.add_argument("--cq", type=int, default=None, help=f"輸出品質 crf / cq（預設 {DEFAULT_CQ}；0 = 無損）")


def _parse_color(s: str | None) -> tuple[float, float, float] | None:
    """`"R,G,B"`（0-255）→ tuple；沒給就 None（＝虛化）。"""
    if not s:
        return None
    parts = str(s).replace("，", ",").split(",")
    if len(parts) != 3:
        raise OpError("Invalid", f"--color 要寫成 R,G,B（拿到 {s!r}）")
    try:
        v = [float(x) for x in parts]
    except ValueError as e:
        raise OpError("Invalid", f"--color 不是數字：{s!r}") from e
    if any(not (0 <= x <= 255) for x in v):
        raise OpError("Invalid", f"--color 的每個分量要在 0-255 之間（拿到 {s!r}）")
    return (v[0], v[1], v[2])


def _mark_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("video", help="影片（通常是 proxy）")
    p.add_argument("--masks", action="append", required=True, metavar="AIVM", help="aivc seg 寫出的 masks.aivm（可重複；多個物件會各自標）")
    p.add_argument("-o", "--out", required=True, help="輸出影片")
    p.add_argument("--frames", default=None, metavar="K0:K1", help="只處理這段 proxy 幀（預設整支）")
    p.add_argument("--mode", default="contour", choices=["contour", "box", "fill"], help="描邊（沿輪廓）/ 方框（外接矩形）/ 填色（半透明蓋住）")
    p.add_argument("--color", default="255,64,64", metavar="R,G,B", help="線 / 填色的顏色（0-255，預設紅）")
    p.add_argument("--line-width", type=float, default=None, help="線寬＝畫面寬度的百分比（預設 0.35；跟著寬度走才能在 720p 與 4K 上看起來一樣）")
    p.add_argument("--opacity", type=float, default=None, help="填色的不透明度 0-1（只有 --mode fill 用得到，預設 0.28）")
    p.add_argument("--codec", default=None, help="輸出編碼器（預設 auto）")
    p.add_argument("--cq", type=int, default=None, help=f"輸出品質 crf / cq（預設 {DEFAULT_CQ}；0 = 無損）")


@register("bg.mark", cli="mark", help="描框 / 描邊：把追蹤到的東西標出來疊在畫面上", args=_mark_args)
def bg_mark(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    """`aivc mark <影片> --masks <obj1/masks.aivm> -o 標好的.mp4`

    跟虛化是同一條路的另一個出口：一樣吃 `aivc seg` 的遮罩，一樣在線性 RGB 裡合成，
    差別只在**畫什麼**。用途是教學片圈重點、產品展示指出零件、比賽影片標人。

    多個遮罩檔會**各自**標（不是取聯集）：兩隻手應該是兩個框，不是一個把兩隻都包住的大框。
    """
    import numpy as np

    from ..bg.outline import (
        DEFAULT_FILL_ALPHA,
        DEFAULT_WIDTH_PCT,
        composite_stroke,
        line_width_px,
        stroke_alpha,
    )
    from ..comp import _color
    from ..media.source import FrameSource
    from . import media as M
    from .render import ensure_out_not_source, frame_planes

    video = env.normalize_path(args["video"])
    if not Path(video).is_file():
        raise OpError("Io", f"找不到影片 {video}")
    out_path = Path(env.normalize_path(args["out"]))
    ensure_out_not_source(out_path, video)

    color = _parse_color(args.get("color")) or (255.0, 64.0, 64.0)
    mode = str(args.get("mode") or "contour")
    # 一律 `is None` 不可以用 `or`：0 是合法值，而 App 是直接送字典的（同 bg.blur 的理由）
    width_pct = DEFAULT_WIDTH_PCT if args.get("line_width") is None else float(args["line_width"])
    opacity = DEFAULT_FILL_ALPHA if args.get("opacity") is None else float(args["opacity"])
    if not (0.0 <= opacity <= 1.0):
        raise OpError("Invalid", f"--opacity 要在 0 到 1 之間（拿到 {opacity}）")

    ctx.progress(STAGE_MARK, 0, 2)
    mc, pr = M.open_media(video, ctx)
    index, cfr, _ = M.ensure_index(video, mc, pr, ctx)
    n_all, w, h = int(cfr.n_frames), int(pr.width), int(pr.height)
    k0, k1 = parse_frames(args.get("frames"), n_all)
    mask_files = open_masks(list(args["masks"]), w, h)
    lw = line_width_px(w, width_pct)
    color_lin = _color.rgb8_to_linear(np.array([[color]], np.uint8))[0, 0]

    missing = 0
    changed = 0

    with FrameSource(video, index, cfr, probe=pr, lru=8, ctx=ctx) as fs:

        def frames():  # noqa: ANN202
            nonlocal missing, changed
            for i, k in enumerate(range(k0, k1)):
                ctx.check_cancel()
                fr = fs.get_proxy_frame(k)
                # 每個物件各自標：兩隻手是兩個框，不是一個把兩隻都包住的大框
                a = np.zeros((h, w, 1), np.float32)
                for mf in mask_files:
                    m = mf.get(k)
                    if m is None or not m.any():
                        continue
                    a = np.maximum(a, stroke_alpha(m, mode, lw))  # type: ignore[arg-type]
                if not a.any():
                    missing += 1
                    yield fr  # 這一幀沒東西可標：原樣放行，位元組完全不動
                    continue
                if mode == "fill":
                    a = a * opacity
                roi = (0, 0, w, h)
                planes = frame_planes(fr)
                sub_orig = _color.yuv420_to_linear(planes, roi)
                sub_out = composite_stroke(sub_orig, color_lin, a)
                changed += 1
                pl = _color.write_back(planes, roi, sub_out, sub_orig, a[..., 0] > 0)
                ctx.progress(STAGE_MARK, 1 + i / max(1, k1 - k0), 2)
                yield fr.with_planes(pl.y, pl.u, pl.v)

        info = _encode(frames(), out_path, pr, cfr, k1 - k0, args, ctx, k_range=(k0, k1))

    ctx.artifact(str(out_path), "mark")
    label = {"contour": "描邊", "box": "方框", "fill": "填色"}[mode]
    result = {
        "video": video,
        "size": [w, h],
        "range": [k0, k1],
        "mode": mode,
        "color": list(color),
        "lineWidth": lw,
        "missingFrames": missing,
        "changedFrames": changed,
        "out": str(out_path),
        "frames": info["frames"],
        "bytes": info["bytes"],
        "seconds": info["seconds"],
    }
    nl = chr(10)  # f-string 裡不能放反斜線跳脫（3.10）；換行拉出來當變數最省事
    result["_human"] = (
        f"{info['frames']} 幀 → {out_path}（{info['bytes'] / 1e6:.1f} MB，{info['seconds']}s）{nl}"
        + f"  {label}  {tuple(int(c) for c in color)}"
        + (f"  線寬 {lw} px" if mode != "fill" else f"  不透明度 {opacity}")
        + f"  標了 {changed} 幀"
        + (f"{nl}  ⚠ 有 {missing} 幀找不到目標，那幾幀沒有標 —— 遮罩在那裡斷了" if missing else "")
    )
    return result


@register("bg.blur", cli="bg-blur", help="背景虛化 / 換色：主體留著，背景糊掉", args=_args)
def bg_blur(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    import numpy as np

    from ..bg.blur import (
        DEFAULT_DILATE,
        DEFAULT_FEATHER,
        DEFAULT_STRENGTH_PCT,
        blur_radius_px,
        blurred_background,
        solid_background,
        subject_coverage,
    )
    from ..comp import _color
    from ..inpaint.plate import blend, feather
    from ..media.source import FrameSource
    from . import media as M
    from .render import ensure_out_not_source, frame_planes

    video = env.normalize_path(args["video"])
    if not Path(video).is_file():
        raise OpError("Io", f"找不到影片 {video}")
    out_path = Path(env.normalize_path(args["out"]))
    ensure_out_not_source(out_path, video)

    color = _parse_color(args.get("color"))
    strength = DEFAULT_STRENGTH_PCT if args.get("strength") is None else float(args["strength"])
    # 一律 `is None` 不可以用 `or`：0 是合法值（不膨脹 / 不羽化），而且 App 是直接送字典的，
    # 沒送的鍵用 `or 0` 會變成硬邊，跟 CLI 的行為不一樣（移除物件踩過這個坑）。
    dilate = DEFAULT_DILATE if args.get("dilate") is None else int(args["dilate"])
    blur_px = DEFAULT_FEATHER if args.get("feather") is None else int(args["feather"])

    ctx.progress(STAGE, 0, 2)
    mc, pr = M.open_media(video, ctx)
    index, cfr, _ = M.ensure_index(video, mc, pr, ctx)
    n_all, w, h = int(cfr.n_frames), int(pr.width), int(pr.height)
    k0, k1 = parse_frames(args.get("frames"), n_all)
    mask_files = open_masks(list(args["masks"]), w, h)
    radius = blur_radius_px(w, strength)
    # 純色也要走線性空間：write_back 混色是在線性 RGB 裡做的
    color_lin = None if color is None else _color.rgb8_to_linear(np.array([[color]], np.uint8))[0, 0]

    missing = 0
    covered_sum = 0.0
    changed = 0

    with FrameSource(video, index, cfr, probe=pr, lru=8, ctx=ctx) as fs:

        def frames():  # noqa: ANN202
            nonlocal missing, covered_sum, changed
            for i, k in enumerate(range(k0, k1)):
                ctx.check_cancel()
                fr = fs.get_proxy_frame(k)
                m = union_mask(mask_files, k, h, w)
                if not m.any():
                    # 追蹤在這一幀斷了。整片糊一下與突然清楚一下都難看，但「不動」是可逆的：
                    # 使用者看到 missingFrames 就知道要回去補遮罩，而不是以為虛化壞了。
                    missing += 1
                    yield fr
                    continue
                a = feather(m, dilate, blur_px)  # (H, W, 1) float32，1 = 主體
                cov = subject_coverage(a)
                if cov > MAX_SUBJECT_COVERAGE:
                    raise OpError(
                        "Invalid",
                        f"第 {k} 幀的主體佔了畫面的 {cov * 100:.0f}%（上限 {MAX_SUBJECT_COVERAGE * 100:.0f}%）",
                        hint="遮罩八成框到整個畫面了；回「遮罩」分頁確認框的是主體本身",
                    )
                covered_sum += cov
                roi = (0, 0, w, h)  # 改的是遮罩**外面**，所以一律整張
                planes = frame_planes(fr)
                sub_orig = _color.yuv420_to_linear(planes, roi)
                bg = solid_background(sub_orig, color_lin) if color_lin is not None else blurred_background(sub_orig, a, radius)
                # alpha 是「主體」，要混入的是背景 → 用 1 - a
                sub_out = blend(sub_orig, bg, 1.0 - a)
                changed += 1
                pl = _color.write_back(planes, roi, sub_out, sub_orig, np.ones((h, w), bool))
                ctx.progress(STAGE, 1 + i / max(1, k1 - k0), 2)
                yield fr.with_planes(pl.y, pl.u, pl.v)

        info = _encode(frames(), out_path, pr, cfr, k1 - k0, args, ctx, k_range=(k0, k1))

    ctx.artifact(str(out_path), "bg")
    mode = "換色" if color is not None else "虛化"
    avg_cov = covered_sum / changed if changed else 0.0
    result = {
        "video": video,
        "size": [w, h],
        "range": [k0, k1],
        "mode": "color" if color is not None else "blur",
        "radius": None if color is not None else radius,
        "strength": None if color is not None else strength,
        "color": list(color) if color is not None else None,
        "subjectCoverage": round(avg_cov, 4),
        "missingFrames": missing,
        "changedFrames": changed,
        "out": str(out_path),
        "frames": info["frames"],
        "bytes": info["bytes"],
        "seconds": info["seconds"],
    }
    result["_human"] = (
        f"{info['frames']} 幀 → {out_path}（{info['bytes'] / 1e6:.1f} MB，{info['seconds']}s）\n"
        f"  背景{mode}"
        + (f"  半徑 {radius} px（強度 {strength}%）" if color is None else f"  {tuple(int(c) for c in color)}")
        + f"  主體平均佔畫面 {avg_cov * 100:.1f}%  改了 {changed} 幀"
        + (f"\n  ⚠ 有 {missing} 幀找不到主體，那幾幀原樣放行 —— 遮罩在那裡斷了，回「遮罩」分頁補一下" if missing else "")
    )
    return result
