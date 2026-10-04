"""`aivc inpaint <影片> --masks <obj1/masks.aivm> -o 乾淨的.mp4`（op `inpaint.remove`）：移除畫面裡的東西。

補進去的每一個像素都是**來源影片某一幀真正拍到的**，不是生成的（能做什麼、不能做什麼見
`aivc/inpaint/__init__.py`）。遮罩就是 `aivc seg` 寫出來的那份 `.aivm`，所以完整的路是：

    aivc text-boxes <影片> --frame 0 --text "hand"      # 文字 → 框
    aivc seg <影片> --frames 0:209 --box <上一步的框>     # 框 → 逐幀遮罩
    aivc inpaint <影片> --masks <obj1/masks.aivm> -o 乾淨的.mp4

## 兩個守門員（都會擋下而不是硬做）

- **鏡頭在動**：背景板的前提是「同一個座標每一幀都是同一塊背景」。相位相關量到整體平移
  超過 `--max-shift` 就報錯。硬做出來的東西看起來很怪但說不出哪裡怪，那比報錯糟得多。
- **背景從來沒露出來過**：遮罩區域的覆蓋率低於 `--min-coverage` 就報錯。
  那些像素只能靠古典補繪硬糊，使用者要知道的是「這段素材不適合」，不是看到一塊糊的自己猜。

兩個門檻都可以調鬆（`--max-shift 999` / `--min-coverage 0`），但預設會擋。

## 只改遮罩內的位元組

合成走 `comp/_color.write_back`（與平面替換同一支）：在線性 RGB 裡混色，只把羽化區域寫回
yuv420 平面，其餘位元組與來源**逐位元相同**。`--emit-plate` 可以把背景板存成 PNG 單獨看。
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path
from typing import Any

from .. import env
from . import Ctx, OpError, register

STAGE = "inpaint.remove"
#: 鏡頭平移的容忍上限（像素）。超過就不是「靜止機位」了。
DEFAULT_MAX_SHIFT = 2.0
#: 回傳 base64 背景板時縮到這個寬度。對話框裡只有幾百 px 寬，送原尺寸只是讓 JSONL 變大。
INLINE_PLATE_W = 900
#: 遮罩區域至少要有多少比例被真的補到，否則擋下。
DEFAULT_MIN_COVERAGE = 0.9
#: 算背景板時遮罩要膨脹多少。**刻意比合成用的寬**：漏遮的物件邊緣會污染中位數，
#: 而多排除一點背景幾乎沒有代價（那些像素在別的幀還是採得到）。
DEFAULT_PLATE_DILATE = 8
#: 一個像素至少要幾個乾淨取樣才算可信。一兩個樣本的中位數其實就是「相信那一幀」。
DEFAULT_MIN_SAMPLES = 3
#: 輸出品質（crf / cq）。0 是合法值（無損），所以取值一律 `is not None` 不可以用 `or`。
DEFAULT_CQ = 19
#: 合成時遮罩先膨脹幾個像素。SAM 的邊通常比物件緊一兩格。
DEFAULT_DILATE = 3
#: 邊緣羽化半徑。
DEFAULT_FEATHER = 7
#: 影子判定：比背景板暗到這個倍率以下就算影子（見 `inpaint/plate.shadow_mask`）。
DEFAULT_SHADOW = 0.85
#: 往物件外找影子的距離（像素）。影子一定貼著物件，太大會把整片較暗的背景吃進來。
DEFAULT_SHADOW_RADIUS = 24


def _args(p: argparse.ArgumentParser) -> None:
    p.add_argument("video", help="影片（通常是 proxy）")
    p.add_argument("--masks", action="append", required=True, metavar="AIVM", help="aivc seg 寫出的 masks.aivm（可重複；多個物件會合併）")
    p.add_argument("-o", "--out", default=None, help="輸出影片；不給就只算背景板（要配 --emit-plate）")
    p.add_argument("--frames", default=None, metavar="K0:K1", help="只處理這段 proxy 幀（預設整支）")
    p.add_argument("--samples", type=int, default=None, help="背景板取樣幾幀（預設 24）")
    p.add_argument("--dilate", type=int, default=None, help=f"合成時遮罩先膨脹幾個像素（預設 {DEFAULT_DILATE}；SAM 的邊通常偏緊）")
    p.add_argument("--plate-dilate", type=int, default=None, help=f"算背景板時遮罩膨脹幾個像素（預設 {DEFAULT_PLATE_DILATE}）；比合成用的寬，漏遮的邊才不會污染中位數")
    p.add_argument("--min-samples", type=int, default=None, help=f"一個像素至少要有幾個乾淨取樣才算可信（預設 {DEFAULT_MIN_SAMPLES}）")
    p.add_argument("--shadow", type=float, default=None, help=f"連影子一起移除：比背景板暗到這個倍率以下算影子（預設 {DEFAULT_SHADOW}；1 = 關掉）")
    p.add_argument("--shadow-radius", type=int, default=None, help=f"往物件外找影子多遠，像素（預設 {DEFAULT_SHADOW_RADIUS}）")
    p.add_argument("--feather", type=int, default=None, help=f"邊緣羽化半徑（預設 {DEFAULT_FEATHER}）")
    p.add_argument("--emit-plate", default=None, metavar="PNG", help="把背景板另存成 PNG")
    p.add_argument("--inline-plate", action="store_true", help="結果裡多帶一份 base64 的背景板（App 用：直接畫在對話框裡，不必開外部看圖程式）")
    p.add_argument("--max-shift", type=float, default=None, help=f"鏡頭平移容忍上限，像素（預設 {DEFAULT_MAX_SHIFT}；調大 = 明知鏡頭在動也要做）")
    p.add_argument("--min-coverage", type=float, default=None, help=f"遮罩區域最低覆蓋率（預設 {DEFAULT_MIN_COVERAGE}；0 = 不擋）")
    p.add_argument("--codec", default=None, help="輸出編碼器（預設 auto）")
    p.add_argument("--cq", type=int, default=None, help=f"輸出品質 crf / cq（預設 {DEFAULT_CQ}；0 = 無損）")


def parse_frames(s: str | None, n: int) -> tuple[int, int]:
    """`"K0:K1"` → 夾進 [0,n) 的半開區間；沒給就整支。"""
    if not s:
        return (0, n)
    parts = str(s).split(":")
    if len(parts) != 2:
        raise OpError("Invalid", f"--frames 要寫成 K0:K1（拿到 {s!r}）")
    try:
        a, b = int(parts[0]), int(parts[1])
    except ValueError as e:
        raise OpError("Invalid", f"--frames 不是數字：{s!r}") from e
    a, b = max(0, min(a, n)), max(0, min(b, n))
    if b <= a:
        raise OpError("Invalid", f"--frames 的 K1 要大於 K0（夾進影片長度後拿到 {a}:{b}）")
    return (a, b)


def union_mask(files: list[Any], k: int, h: int, w: int) -> Any:
    """多個物件的遮罩在同一幀取聯集。缺這一幀的檔案當作「這一幀沒有這個物件」。"""
    import numpy as np

    out = np.zeros((h, w), bool)
    for mf in files:
        m = mf.get(k)
        if m is not None:
            out |= m
    return out


def _inline_plate(plate: Any) -> str | None:
    """背景板 → base64 JPEG（縮到 `INLINE_PLATE_W` 寬）。給 App 直接畫在對話框裡。

    JPEG 不是 PNG：背景板是照片，同樣看得清楚的情況下 JPEG 只要幾分之一大小，
    而它要塞進 JSONL 回給 App。寫到磁碟的那一份（`--emit-plate`）仍然是無損 PNG。
    """
    import base64

    import cv2

    bgr = plate[:, :, ::-1]
    if bgr.shape[1] > INLINE_PLATE_W:
        h = max(1, int(round(bgr.shape[0] * INLINE_PLATE_W / bgr.shape[1])))
        bgr = cv2.resize(bgr, (INLINE_PLATE_W, h), interpolation=cv2.INTER_AREA)
    ok, enc = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, 82])
    return base64.b64encode(enc.tobytes()).decode("ascii") if ok else None


def dilate_mask(mask: Any, px: int) -> Any:
    """膨脹遮罩。算背景板時用得比合成時寬（見 `DEFAULT_PLATE_DILATE`）。"""
    import cv2

    if px <= 0:
        return mask
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * px + 1, 2 * px + 1))
    return cv2.dilate(mask.astype("uint8"), k).astype(bool)


def open_masks(paths: list[str], w: int, h: int) -> list[Any]:
    """開啟每個 `.aivm` 並檢查尺寸。尺寸不合是最常見的接錯（對原始檔跑 seg、對 proxy 跑 inpaint）。"""
    from ..seg.maskfile import MaskFile, MaskFileError

    out = []
    for p in paths:
        path = env.normalize_path(p)
        if not Path(path).is_file():
            raise OpError("Io", f"找不到遮罩檔 {path}", hint="先跑 aivc seg 產生 masks.aivm")
        try:
            mf = MaskFile.open(path)
        except MaskFileError as e:
            raise OpError("Invalid", f"讀不了遮罩檔 {path}：{e}") from e
        if (mf.width, mf.height) != (w, h):
            raise OpError(
                "Invalid",
                f"遮罩是 {mf.width}×{mf.height}，影片是 {w}×{h}",
                hint="seg 與 inpaint 要對同一支影片（通常是 proxy）跑",
            )
        out.append(mf)
    return out


@register("inpaint.remove", cli="inpaint", help="移除物件：用其他幀真正拍到的畫面補回背景", args=_args)
def inpaint_remove(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    import numpy as np

    from ..comp import _color
    from ..imageio import imwrite_unicode
    from ..inpaint.plate import (
        DEFAULT_SAMPLES,
        InpaintError,
        blend,
        camera_shift,
        coverage,
        even_roi,
        feather,
        fill_uncovered,
        median_plate,
        sample_counts,
        sample_indices,
        shadow_mask,
    )
    from ..media.source import FrameSource
    from . import media as M
    from .render import frame_planes

    video = env.normalize_path(args["video"])
    if not Path(video).is_file():
        raise OpError("Io", f"找不到影片 {video}")
    out_path = Path(env.normalize_path(args["out"])) if args.get("out") else None
    plate_png = env.normalize_path(args["emit_plate"]) if args.get("emit_plate") else None
    if out_path is None and plate_png is None:
        raise OpError("Invalid", "沒有指定輸出", hint="給 -o <影片> 或 --emit-plate <png>（或兩個都給）")
    if out_path is not None:
        from .render import ensure_out_not_source

        ensure_out_not_source(out_path, video)

    max_shift = DEFAULT_MAX_SHIFT if args.get("max_shift") is None else float(args["max_shift"])
    min_cov = DEFAULT_MIN_COVERAGE if args.get("min_coverage") is None else float(args["min_coverage"])
    n_samples = DEFAULT_SAMPLES if args.get("samples") is None else int(args["samples"])

    ctx.progress(STAGE, 0, 3)
    mc, pr = M.open_media(video, ctx)
    index, cfr, _ = M.ensure_index(video, mc, pr, ctx)
    n_all, w, h = int(cfr.n_frames), int(pr.width), int(pr.height)
    k0, k1 = parse_frames(args.get("frames"), n_all)
    mask_files = open_masks(list(args["masks"]), w, h)

    with FrameSource(video, index, cfr, probe=pr, lru=8, ctx=ctx) as fs:
        # ---- 1. 背景板 ----
        try:
            ks = sample_indices(k0, k1, n_samples)
        except InpaintError as e:
            raise OpError("Invalid", str(e)) from e
        rgbs = np.empty((len(ks), h, w, 3), np.uint8)
        msks = np.empty((len(ks), h, w), bool)  # 排除用（寬）
        raw = np.empty((len(ks), h, w), bool)  # 原始遮罩，只拿來算「要換掉哪裡」
        pd = DEFAULT_PLATE_DILATE if args.get("plate_dilate") is None else int(args["plate_dilate"])
        for i, k in enumerate(ks):
            ctx.check_cancel()
            rgbs[i] = fs.get_proxy_frame(k).rgb8()
            m = union_mask(mask_files, k, h, w)
            raw[i] = m
            msks[i] = dilate_mask(m, pd)
            ctx.progress(STAGE, i / max(1, len(ks)), 3)

        shift = camera_shift(rgbs[0], rgbs[-1]) if len(ks) > 1 else 0.0
        if shift > max_shift:
            raise OpError(
                "Invalid",
                f"鏡頭在動（首尾相差約 {shift:.1f} px，上限 {max_shift}）",
                hint="這條路要靜止機位；真的要做就調高 --max-shift，但補出來的會是別處的畫面",
            )

        min_samples = DEFAULT_MIN_SAMPLES if args.get("min_samples") is None else int(args["min_samples"])
        try:
            plate, covered = median_plate(rgbs, msks, min_samples=min_samples)
        except InpaintError as e:
            raise OpError("Internal", str(e)) from e
        # 覆蓋率只算「真的會被換掉的地方」＝原始遮罩，不是膨脹過的排除遮罩
        region = raw.any(axis=0)
        cov = coverage(covered, region)
        holes = int(np.count_nonzero(region & ~covered))
        thin = int(np.count_nonzero(region & (sample_counts(msks) < min_samples * 2)))
        if cov < min_cov:
            raise OpError(
                "Invalid",
                f"遮罩區域只有 {cov * 100:.1f}% 的背景在別的幀露出過（下限 {min_cov * 100:.0f}%）",
                hint="物件整段幾乎沒移動過，補不出真實背景；--min-coverage 0 可以硬做（會糊）",
            )
        if holes:
            plate = fill_uncovered(plate, covered)
        if plate_png:
            imwrite_unicode(plate_png, plate[:, :, ::-1])  # imwrite 吃 BGR
        plate_data = _inline_plate(plate) if args.get("inline_plate") else None
        ctx.progress(STAGE, 1, 3)

        result: dict[str, Any] = {
            "video": video,
            "size": [w, h],
            "range": [k0, k1],
            "samples": len(ks),
            "cameraShift": round(shift, 2),
            "coverage": round(cov, 4),
            "inpaintedPixels": holes,
            "thinPixels": thin,
            "plate": plate_png,
            "plateData": plate_data,
            "out": str(out_path) if out_path else None,
        }
        if out_path is None:
            ctx.progress(STAGE, 3, 3)
            result["_human"] = f"背景板 {w}×{h}  取樣 {len(ks)} 幀  覆蓋率 {cov * 100:.1f}%（{holes} 個像素靠補繪、{thin} 個取樣偏少）→ {plate_png}"
            return result

        # ---- 2. 逐幀合成並編碼 ----
        # **整條路都要走 `comp/_color` 自己的轉換**，不可以混用解碼器那一套（`Yuv420.rgb_linear()` /
        # `media.color.eotf`）。兩者的色度升採樣與曲線都不同，而 `write_back` 寫的是**差值**
        # （out − orig），所以混用的誤差不會互相抵消，會變成物件形狀的深色斑塊 —— 實測就是這樣，
        # 手被移掉了但原地留下一塊手形的暗影。
        plate_lin = _color.rgb8_to_linear(plate)
        # 一律 `is None` 不可以用 `or`：0 是合法值（不膨脹 / 不羽化）。而且更要命的是
        # **鍵不存在時**——CLI 走 argparse 會補上預設，但 App 是直接送字典的，
        # 沒送的鍵用 `or 0` 會變成「不膨脹也不羽化」＝硬邊，跟 CLI 的行為不一樣。
        dilate = DEFAULT_DILATE if args.get("dilate") is None else int(args["dilate"])
        blur = DEFAULT_FEATHER if args.get("feather") is None else int(args["feather"])
        shadow = DEFAULT_SHADOW if args.get("shadow") is None else float(args["shadow"])
        shadow_r = DEFAULT_SHADOW_RADIUS if args.get("shadow_radius") is None else int(args["shadow_radius"])
        want_shadow = shadow < 1.0 and shadow_r > 0
        changed = 0

        def frames():  # noqa: ANN202
            nonlocal changed
            for k in range(k0, k1):
                ctx.check_cancel()
                fr = fs.get_proxy_frame(k)
                m = union_mask(mask_files, k, h, w)
                if want_shadow and m.any():
                    # 影子不在 SAM 的遮罩裡。只換掉物件、留著影子，等於把輪廓描出來。
                    near = dilate_mask(m, shadow_r) & ~m
                    m = m | shadow_mask(fr.rgb8(), plate, near, shadow)
                a = feather(m, dilate, blur)
                roi = even_roi(a[..., 0] > 0, w, h)
                if roi is None:
                    yield fr  # 這一幀沒東西要改：原樣放行，位元組完全不動
                    continue
                x0, y0, x1, y1 = roi
                # 合成器的 Yuv420 與解碼器的 Yuv420 是兩個同名的型別；frame_planes / with_planes 是既有的橋接
                planes = frame_planes(fr)
                sub_orig = _color.yuv420_to_linear(planes, roi)
                sub_out = blend(sub_orig, plate_lin[y0:y1, x0:x1], a[y0:y1, x0:x1])
                changed += 1
                pl = _color.write_back(planes, roi, sub_out, sub_orig, a[y0:y1, x0:x1, 0] > 0)
                yield fr.with_planes(pl.y, pl.u, pl.v)

        info = _encode(frames(), out_path, pr, cfr, k1 - k0, args, ctx, k_range=(k0, k1))

    ctx.artifact(str(out_path), "inpaint")
    result.update({"frames": info["frames"], "bytes": info["bytes"], "changedFrames": changed, "seconds": info["seconds"]})
    result["_human"] = (
        f"{info['frames']} 幀 → {out_path}（{info['bytes'] / 1e6:.1f} MB，{info['seconds']}s）\n"
        f"  背景板取樣 {len(ks)} 幀  鏡頭平移 {shift:.1f} px  覆蓋率 {cov * 100:.1f}%"
        + (f"（{holes} 個像素靠補繪）" if holes else "")
        + (f"  ⚠ {thin} 個像素的乾淨取樣偏少，那裡的背景板不太可信" if thin else "")
        + f"  改了 {changed} 幀"
    )
    return result


def audio_trim_args(k_range: tuple[int, int] | None, cfr: Any) -> list[str]:
    """只輸出 proxy 幀 [K0, K1) 時，音訊輸入要加的 `-ss/-t`（與 render --range --trim 同一個式子）；整支就不加。
    以前沒有：`--frames` 的輸出音軌從來源 0 秒開始、長度是整支來源，聲音對不上畫面。"""
    if k_range is None:
        return []
    k0, k1 = int(k_range[0]), int(k_range[1])
    if k0 <= 0 and k1 >= int(cfr.n_frames):
        return []
    num, den = int(cfr.fps_num), int(cfr.fps_den)
    return ["-ss", f"{k0 * den / num:.6f}", "-t", f"{(k1 - k0) * den / num:.6f}"]


def _encode(
    frames: Any, out_path: Path, probe: Any, cfr: Any, total: int, args: dict[str, Any], ctx: Ctx, *, k_range: tuple[int, int] | None = None,
) -> dict[str, Any]:
    """照 proxy op 的方式挑編碼器並寫檔（音訊從來源複製；k_range＝只輸出這段幀時音軌也裁成同一段）。"""
    from ..media import encode_plan as EP
    from ..media import encoder as EN
    from .render import usable_encoders

    want = (args.get("codec") or "auto").strip() or "auto"
    usable = usable_encoders(True)
    spec = EP.EncodeSpec(
        container=None, codec=None if want == "auto" else want, quality=DEFAULT_CQ if args.get("cq") is None else int(args["cq"]),
        audio="auto", gpu=True, out_path=str(out_path),
        content_note="Edited video. Objects removed by AI Video Cut.",
    )
    plan = EP.plan(spec, EP.SourceInfo.from_probe(probe), usable)
    for n in plan.notes:
        ctx.log("info", f"編碼：{n}")
    t0 = time.perf_counter()
    info = EN.write_frames(
        frames, plan, out_path, ctx,
        width=int(probe.width), height=int(probe.height), fps=(cfr.fps_num, cfr.fps_den), total=total,
        audio_source=str(Path(env.normalize_path(args["video"]))), stage="inpaint", audio_input_args=audio_trim_args(k_range, cfr),
    )
    info["seconds"] = round(time.perf_counter() - t0, 3)
    return info
