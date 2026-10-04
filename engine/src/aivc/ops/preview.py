"""`aivc preview-composite`／op `comp.preview_composite`：單張影像的合成測試（E0 任務 0.5 的精神）。

不需要專案檔、追蹤解、模板組：給一張幀 PNG、四角、新表面 PNG（可選原表面 PNG、可見遮罩 PNG），
輸出 normal（原幀）／replaced（合成）／split（並排推桿）／difference（|out−src|·gain^γ；遮罩外必須純黑）／zoom 五種檢視。
合成走 yuv420p 路徑（幀 PNG 先轉成 yuv420p 平面再合成再轉回），所以測的是與輸出相同的寫回紀律。

沒有 --template-orig 時採「白紙假設」：原模板＝全白，墨遮罩從矯正後的觀測自動推（暗或有彩度＝墨），
S = 觀測/白 ＝ 紙上觀測本身；有原表面的模板時用 --template-orig 換成 template-ratio。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from . import Ctx, OpError, register

VIEWS = ("normal", "replaced", "split", "difference", "zoom")


def _args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--frame", required=True, help="幀 PNG（RGB，視為 BT.709 gamma）")
    p.add_argument("--quad", required=True, help="x1,y1,x2,y2,x3,y3,x4,y4（TL,TR,BR,BL；連續像素座標）")
    p.add_argument("--template-new", required=True, help="新表面 PNG（可含 alpha＝輪廓）")
    p.add_argument("--template-orig", help="原表面 PNG；省略＝白紙假設")
    p.add_argument("--mask", help="可見遮罩 PNG（灰階；白＝可見）")
    p.add_argument("--ink-orig", help="原表面墨遮罩 PNG（省略＝自模板／觀測推導）")
    p.add_argument("--ink-new", help="新表面墨遮罩 PNG（省略＝自模板推導）")
    p.add_argument("--paper", help="紙／輪廓遮罩 PNG（省略＝模板 alpha 或全部）")
    p.add_argument("--barcode", help="保留原像素的區域 x,y,w,h（模板比例 0..1；keepBarcode 區域策略用）")
    p.add_argument("--target", default="card", choices=["card", "blank"], help="card＝貼上新表面（預設）；blank＝只留表面底色")
    p.add_argument("--macro", default=None, choices=["conservative", "standard", "full"])
    p.add_argument("--set", action="append", default=[], metavar="KEY=VAL", help="插入參數，例 edge.choke=1.0 motionBlur.shutterAngle=90（可重複）")
    p.add_argument("--prev-quad", help="前一幀四角（動態模糊）")
    p.add_argument("--next-quad", help="後一幀四角（動態模糊）")
    p.add_argument("--conf", type=float, default=1.0)
    p.add_argument("--frame-index", type=int, default=0)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--shot-kind", choices=["close", "wide"], default=None)
    p.add_argument("--view", default="replaced", choices=list(VIEWS))
    p.add_argument("--gain", type=float, default=4.0, help="difference 檢視增益")
    p.add_argument("--gamma", type=float, default=2.2, help="difference 檢視 gamma")
    p.add_argument("--zoom", type=int, default=4, help="zoom 檢視放大倍率")
    p.add_argument("-o", "--out", required=True, help="輸出 PNG")
    p.add_argument("--stats", help="另存統計 JSON")


def _with_defaults(args: dict[str, Any]) -> dict[str, Any]:
    """補上 CLI 旗標的預設值：sidecar 直接送 args（只有呼叫端給的鍵），沒有 argparse 幫忙填 target／gain／zoom…。
    舞台的替換預覽（src/pipeline/fxPreview.ts compositeArgs）只送 frame／quad／template_new／view／out，
    以前這裡一讀 args["target"] 就 KeyError。呼叫端給 None 的鍵也退回預設。"""
    p = argparse.ArgumentParser(add_help=False)
    _args(p)
    out = {a.dest: a.default for a in p._actions}
    out.update({k: v for k, v in args.items() if v is not None})
    return out


@register("comp.preview_composite", cli="preview-composite", help="單張影像換表面測試：幀 PNG + 四角 + 模板 → normal|replaced|split|difference|zoom PNG", args=_args)
def preview_composite(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    args = _with_defaults(args)
    import cv2
    import numpy as np

    from ..comp import _color
    from ..comp.blur import H_from_quad
    from ..comp.compositor import composite_frame, rectify_frame
    from ..comp.params import InsertParams
    from ..comp.region import barcode_mask_from_rect, derive_masks_from_template
    from ..imageio import imwrite_unicode

    ctx.progress("load", 0, 4)
    frame_rgb = _read_rgb(args["frame"])
    h, w = frame_rgb.shape[:2]
    if h % 2 or w % 2:  # yuv420p 需偶數
        frame_rgb = frame_rgb[: h - h % 2, : w - w % 2]
        h, w = frame_rgb.shape[:2]
    quad = _parse_quad(args["quad"])
    new_rgb, new_alpha = _read_rgba(args["template_new"])
    nh, nw = new_rgb.shape[:2]
    H = H_from_quad(quad, nw, nh)
    H_prev = H_from_quad(_parse_quad(args["prev_quad"]), nw, nh) if args.get("prev_quad") else None
    H_next = H_from_quad(_parse_quad(args["next_quad"]), nw, nh) if args.get("next_quad") else None

    params = InsertParams.from_macro(args["macro"]) if args.get("macro") else InsertParams()
    if args.get("set"):
        try:
            params = InsertParams.from_dict(_parse_sets(args["set"]), params)
        except ValueError as e:
            raise OpError("Invalid", str(e), "檢查 --set 的鍵名與值；群組用點分隔，例 edge.choke=1.0") from e

    planes = _color.rgb8_to_yuv420(frame_rgb)
    ink_new, paper = derive_masks_from_template(new_rgb, new_alpha)
    if args.get("ink_new"):
        ink_new = _read_mask(args["ink_new"], (nw, nh))
    if args.get("paper"):
        paper = _read_mask(args["paper"], (nw, nh))

    ctx.progress("masks", 1, 4)
    white_paper = not args.get("template_orig")
    if white_paper:
        # 白紙假設：原模板全白；墨從矯正後的觀測推（暗或有彩度）
        rect_lin = rectify_frame(planes, H, (nw, nh), (nw, nh))
        rect8 = _color.linear_to_rgb8(rect_lin)
        paper_lin = np.median(rect_lin[paper], axis=0) if paper.any() else np.array([0.8, 0.8, 0.8])
        # 相對紙色門檻：比紙暗 35% 或彩度高 → 墨
        lum = rect_lin.mean(axis=-1)
        sat = rect8.astype(np.int16).max(axis=-1) - rect8.astype(np.int16).min(axis=-1)
        ink_orig = ((lum < 0.65 * float(np.mean(paper_lin))) | (sat > 45)) & paper
        orig_rgb = np.full_like(new_rgb, 255)
    else:
        orig_rgb, orig_alpha = _read_rgba(args["template_orig"])
        if orig_rgb.shape[:2] != (nh, nw):
            orig_rgb = cv2.resize(orig_rgb, (nw, nh), interpolation=cv2.INTER_AREA)
            orig_alpha = None if orig_alpha is None else cv2.resize(orig_alpha, (nw, nh), interpolation=cv2.INTER_AREA)
        ink_orig, _ = derive_masks_from_template(orig_rgb, orig_alpha)
    if args.get("ink_orig"):
        ink_orig = _read_mask(args["ink_orig"], (nw, nh))
    barcode = barcode_mask_from_rect((nh, nw), _parse_rect(args["barcode"])) if args.get("barcode") else None
    alpha_vis = None
    if args.get("mask"):
        m = _imread(args["mask"], cv2.IMREAD_GRAYSCALE, "讀不到遮罩")
        if m.shape != (h, w):
            m = cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR)
        alpha_vis = m.astype(np.float32) / 255.0

    ctx.progress("composite", 2, 4)
    ctx.check_cancel()
    res = composite_frame(
        planes, H, alpha_vis, orig_rgb, new_rgb, ink_orig, ink_new, paper, H_prev, H_next, params,
        barcode_mask=barcode, target=args["target"], conf=float(args.get("conf", 1.0)),
        frame_index=int(args.get("frame_index", 0)), seed=int(args.get("seed", 0)), shot_kind=args.get("shot_kind"),
    )
    src8 = _color.yuv420_to_rgb8(planes)
    out8 = _color.yuv420_to_rgb8(res.out) if not res.stats.hold else src8  # type: ignore[arg-type]
    wm = res.write_mask_full() if not res.stats.hold else np.zeros((h, w), bool)

    ctx.progress("view", 3, 4)
    view = args["view"]
    diff = np.abs(out8.astype(np.int16) - src8.astype(np.int16))
    outside_nonzero = int((diff.max(axis=-1) > 0)[~wm].sum())
    inside_changed = int((diff.max(axis=-1) > 0)[wm].sum())
    if view == "normal":
        img = src8
    elif view == "replaced":
        img = out8
    elif view == "split":
        cx = int(round(quad[:, 0].mean()))
        img = src8.copy()
        img[:, cx:] = out8[:, cx:]
        img[:, max(cx - 1, 0) : cx + 1] = (255, 200, 0)
    elif view == "difference":
        d = np.clip(diff.astype(np.float32) * float(args["gain"]) / 255.0, 0.0, 1.0)
        img = np.clip(np.power(d, 1.0 / float(args["gamma"])) * 255.0 + 0.5, 0, 255).astype(np.uint8)
    else:  # zoom：ROI 附近原圖｜合成圖，nearest 放大
        x0, y0, x1, y1 = res.roi if not res.stats.hold else (0, 0, w, h)
        pad = 6
        x0, y0, x1, y1 = max(0, x0 - pad), max(0, y0 - pad), min(w, x1 + pad), min(h, y1 + pad)
        z = max(1, int(args["zoom"]))
        a = cv2.resize(src8[y0:y1, x0:x1], None, fx=z, fy=z, interpolation=cv2.INTER_NEAREST)
        b = cv2.resize(out8[y0:y1, x0:x1], None, fx=z, fy=z, interpolation=cv2.INTER_NEAREST)
        gap = np.full((a.shape[0], 4, 3), (255, 200, 0), np.uint8)
        img = np.hstack([a, gap, b])

    out_path = Path(args["out"])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        imwrite_unicode(out_path, cv2.cvtColor(img, cv2.COLOR_RGB2BGR))
    except (OSError, ValueError) as e:
        raise OpError("Io", f"寫不出 {out_path}：{e}") from e
    ctx.artifact(str(out_path), "png")
    ctx.progress("view", 4, 4)

    result = {
        "out": str(out_path),
        "view": view,
        "quad": quad.tolist(),
        "template_size": [nw, nh],
        "white_paper_assumption": white_paper,
        "params": params.to_dict(),
        "stats": res.stats.to_dict(),
        "outside_nonzero": outside_nonzero,  # difference 檢視在膨脹 alpha 外的非黑像素數，必須是 0
        "inside_changed": inside_changed,
    }
    if args.get("stats"):
        Path(args["stats"]).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


# ---------------------------------------------------------------------------
def _imread(path: str, flags: int, missing: str) -> Any:
    """非 ASCII 路徑安全的讀圖；不存在 → OpError(Io, f"{missing} {path}")，解不出來 → OpError(Io, 解碼失敗說明)。"""
    from ..imageio import imread_unicode

    try:
        return imread_unicode(path, flags)
    except OSError as e:
        raise OpError("Io", f"{missing} {path}") from e
    except ValueError as e:
        raise OpError("Io", str(e)) from e


def _read_rgb(path: str) -> Any:
    import cv2

    img = _imread(path, cv2.IMREAD_COLOR, "讀不到影像")
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def _read_rgba(path: str) -> tuple[Any, Any]:
    import cv2

    img = _imread(path, cv2.IMREAD_UNCHANGED, "讀不到影像")
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2RGB), None
    if img.shape[2] == 4:
        return cv2.cvtColor(img[..., :3], cv2.COLOR_BGR2RGB), img[..., 3]
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB), None


def _read_mask(path: str, wh: tuple[int, int]) -> Any:
    import cv2

    m = _imread(path, cv2.IMREAD_GRAYSCALE, "讀不到遮罩")
    if (m.shape[1], m.shape[0]) != wh:
        m = cv2.resize(m, wh, interpolation=cv2.INTER_AREA)
    return m > 127


def _parse_quad(s: str) -> Any:
    import numpy as np

    try:
        v = [float(x) for x in str(s).replace(";", ",").split(",") if x.strip()]
    except ValueError as e:
        raise OpError("Invalid", f"四角格式錯誤：{s!r}", "x1,y1,x2,y2,x3,y3,x4,y4") from e
    if len(v) != 8:
        raise OpError("Invalid", f"四角需要 8 個數字，收到 {len(v)}", "TL,TR,BR,BL 順序")
    return np.array(v, dtype=np.float64).reshape(4, 2)


def _parse_rect(s: str) -> tuple[float, float, float, float]:
    v = [float(x) for x in str(s).split(",")]
    if len(v) != 4:
        raise OpError("Invalid", f"--barcode 需要 x,y,w,h，收到 {s!r}")
    return v[0], v[1], v[2], v[3]


def _parse_sets(items: list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for it in items:
        if "=" not in it:
            raise OpError("Invalid", f"--set 需要 KEY=VAL，收到 {it!r}")
        key, val = it.split("=", 1)
        try:
            v: Any = json.loads(val)
        except json.JSONDecodeError:
            v = val
        cur = out
        parts = key.strip().split(".")
        for p in parts[:-1]:
            cur = cur.setdefault(p, {})
        cur[parts[-1]] = v
    return out
