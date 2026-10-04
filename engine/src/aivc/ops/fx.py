"""物件特效的兩支 op：整段渲染（`fx.apply`）與單幀預覽（`fx.preview`）。

    aivc fx <video> --masks A.aivm [--masks B.aivm …] --effects stack.json -o out.mp4 [--frames K0:K1]
    aivc fx-preview <video> --masks A.aivm [...] --effects stack.json --frame K -o out.png [--compare] [--max-width N]

`--masks` 的順序就是物件編號 1..n；特效檔（格式見 `fx/params.py`）用編號、`"*"` 或遮罩檔路徑指定物件，
用路徑指定、但沒列在 `--masks` 的遮罩會自動加進來（所以 `--masks` 也可以完全不給）。`--effects` 可以是檔案路徑，
也可以直接是 JSON 字串（以 `{` 或 `[` 開頭；App 與 AI 不必先寫暫存檔）。特效檔裡的相對路徑（masks、貼紙 image、
文字 fontFile）先找**特效檔所在的資料夾**、那裡沒有才照目前目錄（`fx.params.load_stack`）。

解碼／編碼走跟 `bg.blur`、`inpaint.remove` 同一條路（FrameSource → 改平面 → media.encoder，音訊從來源複製；
`--frames K0:K1` 時音軌用 `-ss/-t` 裁成同一段，與 `render --range --trim` 相同）。
`--cq 0`＝無損：只有 FFV1（.mkv）、libx264（crf 0）、VP9（.webm，加 `-lossless 1`）做得到；
NVENC 的 `-cq 0` 是「自動」、位元率編碼器（openh264、VideoToolbox、mpeg4）根本不吃品質值 —— 選到這些時報錯，不默默輸出有損檔。
**沒有任何特效作用的幀原樣放行**（同一個物件，位元組完全不動）；有作用的幀只改作用範圍內的位元組（定義見 `fx/apply.py`）。
物件在某一幀不在（遮罩缺席）＝那個物件的特效那一幀不做，計進結果的 `objects[].absentFrames`（打碼斷掉的地方要讓人看得到）。

## fx.preview 為什麼不是 light（`register(..., light=True)`）

ops/__init__.py 的輕量 lane 規則：純 CPU、不碰 GPU、不改模組層共用狀態，寫檔走 `aivc.atomic`。fx.preview 前兩條都符合
（字型快取與貼紙快取是 lru_cache，執行緒安全；PNG 走 atomic），**但它要用 PyAV 解一幀**。seg/text_box.py 記錄過：
同一個行程裡「PyAV 解碼器開著時第一次載入模型」會卡死 —— 輕量 lane 與主 lane 同時跑，就可能剛好是
「預覽在解碼、主 lane 的 seg.find 在載 SAM」。冷快取時它還會觸發整支影片的索引建立（70–136 s）。
所以留在主 lane。要變成 light 的做法：預覽改讀 `aivc frame` 預先存好的幀（不碰 PyAV）或由主 lane 預熱解碼，
再把 `fx.preview` 加進 LIGHT_OPS 審查（那是 ops/__init__.py，不在這次的修改範圍內）。
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path
from typing import Any

from .. import env
from . import Ctx, OpError, register

STAGE = "fx.apply"
#: 開檔／建索引／算錨點那一段另外一個 stage：ServeCtx 的 eta 以 stage 的第一筆事件為起點，不能把這段算進每幀成本
STAGE_OPEN = "fx.apply.open"
DEFAULT_CQ = 19
#: --cq 0 真的無損的編碼器（ffv1 本來就無損；libx264 crf 0；libvpx-vp9 另外加 -lossless 1）
LOSSLESS_Q0 = frozenset({"ffv1", "libx264", "libvpx-vp9"})
CONTENT_NOTE = "Edited video. Effects applied to tracked objects by AI Video Cut."


def _common_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("video", help="影片路徑（通常是 proxy；遮罩要是對這支影片算的）")
    p.add_argument("--masks", action="append", default=[], metavar="AIVM", help="物件遮罩（可重複；順序＝物件編號 1..n）")
    p.add_argument("--effects", required=True, metavar="JSON", help="特效檔路徑，或直接給 JSON（以 { 或 [ 開頭）")
    p.add_argument("--window", type=int, default=None, help="錨點平滑視窗（幀，預設 9；0＝不平滑）")


def _apply_args(p: argparse.ArgumentParser) -> None:
    _common_args(p)
    p.add_argument("-o", "--out", required=True, help="輸出影片")
    p.add_argument("--frames", default=None, metavar="K0:K1", help="只輸出這段 proxy 幀（預設整支）")
    p.add_argument("--codec", default=None, help="輸出編碼器（預設 auto）")
    p.add_argument(
        "--cq", type=int, default=None,
        help=f"輸出品質 crf／cq（預設 {DEFAULT_CQ}）。0 = 無損：只有 .mkv（FFV1）、--codec libx264、.webm（VP9）做得到，其他編碼器（NVENC 等）會報錯",
    )


def _preview_args(p: argparse.ArgumentParser) -> None:
    _common_args(p)
    p.add_argument("--frame", type=int, required=True, help="proxy 幀號 K")
    p.add_argument("-o", "--out", required=True, help="輸出 PNG")
    p.add_argument("--max-width", type=int, default=0, help="縮到寬 ≤ N（0＝不縮）")
    p.add_argument("--compare", action="store_true", help="左右並排：原幀｜套特效後")


# ---------------------------------------------------------------- 共用
def parse_frames(s: str | None, n: int) -> tuple[int, int]:
    """`"K0:K1"` → 夾進 [0, n) 的半開區間；沒給就整支（與 inpaint／bg-blur 同一個語意）。"""
    if not s:
        return 0, n
    try:
        a, b = (int(v) for v in str(s).split(":"))
    except ValueError as e:
        raise OpError("Invalid", f"--frames 要寫成 K0:K1，拿到 {s!r}") from e
    a, b = max(0, min(a, n)), max(0, min(b, n))
    if b <= a:
        raise OpError("Invalid", f"--frames 的 K1 要大於 K0（夾進影片長度後拿到 {a}:{b}）")
    return a, b


def _norm(p: str) -> str:
    import os

    return os.path.normcase(os.path.abspath(env.normalize_path(str(p))))


def resolve(
    args: dict[str, Any], W: int, H: int, n_frames: int | None = None, ctx: Any = None,
) -> tuple[dict[int, Any], list[tuple[Any, tuple[Any, ...]]], list[Any]]:
    """--masks ＋ 特效檔 → (物件編號 → ObjectTrack, [(物件編號或 "*", 特效…)], 原始 stacks)。
    n_frames：proxy 幀數（給了就檢查遮罩的幀號沒有超出影片）；ctx：算錨點時送進度、可取消。"""
    from ..fx.overlay import load_sticker
    from ..fx.params import FxError, StickerFx, load_stack
    from ..objects.anchors import DEFAULT_WINDOW
    from ..objects.track import ObjectTrack
    from ..seg.maskfile import MaskFileError
    from .objects import check_mask_fits

    try:
        stacks = load_stack(args["effects"])
    except FxError as e:
        raise OpError("Invalid", f"特效檔：{e}") from e
    paths = [env.normalize_path(str(p)) for p in (args.get("masks") or [])]
    keys = {_norm(p): i + 1 for i, p in enumerate(paths)}
    for st in stacks:
        if isinstance(st.target, str) and st.target != "*" and _norm(st.target) not in keys:
            paths.append(env.normalize_path(st.target))
            keys[_norm(st.target)] = len(paths)
    if not paths:
        raise OpError("Invalid", "沒有任何物件：給 --masks，或在特效檔裡用 masks 指定遮罩檔")
    window = DEFAULT_WINDOW if args.get("window") is None else int(args["window"])
    if window < 0:
        raise OpError("Invalid", f"--window 不能是負的（拿到 {window}；0＝不平滑）")
    tracks: dict[int, Any] = {}
    for i, p in enumerate(paths, start=1):
        if not Path(p).is_file():
            raise OpError("Io", f"找不到遮罩檔 {p}", hint="先跑 aivc find／select／seg 產生 masks.aivm")
        try:
            t = ObjectTrack.open(p, window=window, ctx=ctx)
        except (MaskFileError, OSError, ValueError) as e:
            raise OpError("Invalid", f"讀不了遮罩檔 {p}：{e}") from e
        h = t.masks.header
        check_mask_fits(p, h.width, h.height, h.n_entries, h.last_k, W, H, n_frames)
        tracks[i] = t
    pairs: list[tuple[Any, tuple[Any, ...]]] = []
    for st in stacks:
        if st.target == "*":
            key: Any = "*"
        elif isinstance(st.target, int):
            if st.target not in tracks:
                raise OpError("Invalid", f"特效檔指定了物件 {st.target}，但只有 {len(tracks)} 個物件（--masks 的順序是 1..n）")
            key = st.target
        else:
            key = keys[_norm(st.target)]
        for e in st.effects:
            if isinstance(e, StickerFx):
                try:
                    load_sticker(e.image)  # 先讀一次：檔案不在就在開始渲染前講，不要渲染到一半才炸
                except FxError as err:
                    raise OpError("Io", str(err)) from err
        pairs.append((key, st.effects))
    return tracks, pairs, stacks


def _objects_at(tracks: dict[int, Any], k: int) -> dict[int, Any]:
    return {key: t.frame(k) for key, t in tracks.items()}


def _summary(tracks: dict[int, Any], pairs: list[tuple[Any, tuple[Any, ...]]]) -> list[dict[str, Any]]:
    from ..fx.params import effect_json

    out = []
    for key, t in tracks.items():
        effs = [e for k2, es in pairs if k2 == "*" or k2 == key for e in es]
        out.append({"object": key, "masks": t.path, "effects": [effect_json(e) for e in effs]})
    return out


def plan_encode(out_path: Path, probe: Any, args: dict[str, Any]) -> tuple[Any, list[str]]:
    """編碼計畫 ＋ 額外的視訊參數。`--cq 0` 但選到的編碼器做不到無損 → OpError(Invalid)（在解碼任何一幀之前）。"""
    from ..media import encode_plan as EP
    from .render import usable_encoders

    want = (args.get("codec") or "auto").strip() or "auto"
    quality = DEFAULT_CQ if args.get("cq") is None else int(args["cq"])
    spec = EP.EncodeSpec(
        container=None, codec=None if want == "auto" else want, quality=quality,
        audio="auto", gpu=True, out_path=str(out_path), content_note=CONTENT_NOTE,
    )
    plan = EP.plan(spec, EP.SourceInfo.from_probe(probe), usable_encoders(True))
    extra: list[str] = []
    if quality == 0:
        codec = str(plan.video_codec)
        if codec not in LOSSLESS_Q0:
            raise OpError(
                "Invalid", f"--cq 0（無損）用 {codec} 做不到：NVENC 的 -cq 0 是「自動」、位元率編碼器不吃品質值，輸出會是有損的",
                hint="要無損請輸出 .mkv（FFV1），或加 --codec libx264（ffmpeg 要有 libx264），或輸出 .webm（VP9 無損）",
            )
        if codec == "libvpx-vp9":
            extra = ["-lossless", "1"]  # VP9 的 crf 0 不保證無損，要明確開 lossless
    return plan, extra


def _encode(
    frames: Any, out_path: Path, probe: Any, cfr: Any, total: int, args: dict[str, Any], ctx: Ctx, *,
    plan: Any = None, extra_video_args: list[str] | None = None, k_range: tuple[int, int] | None = None,
) -> dict[str, Any]:
    """與 inpaint／bg-blur 同一條編碼路（音訊從來源複製），只是內容揭露句子寫「特效」而不是「移除物件」。
    k_range：只輸出 proxy 幀 [K0, K1) 時，音軌用 `-ss/-t` 裁成同一段（以前從來源 0 秒開始、長度是整支來源）。"""
    from ..media import encoder as EN
    from .inpaint import audio_trim_args

    if plan is None:
        plan, extra_video_args = plan_encode(out_path, probe, args)
    for n in plan.notes:
        ctx.log("info", f"編碼：{n}")
    audio_in = audio_trim_args(k_range, cfr)
    t0 = time.perf_counter()
    info = EN.write_frames(
        frames, plan, out_path, ctx, width=int(probe.width), height=int(probe.height), fps=(cfr.fps_num, cfr.fps_den), total=total,
        audio_source=str(Path(env.normalize_path(args["video"]))), stage="fx", audio_input_args=audio_in,
        extra_video_args=list(extra_video_args or []),
    )
    info["seconds"] = round(time.perf_counter() - t0, 3)
    return info


# ---------------------------------------------------------------- fx.apply
@register("fx.apply", cli="fx", help="物件特效渲染：每個物件一串特效（馬賽克／模糊／調色／描邊／光暈／貼紙／文字）", args=_apply_args)
def fx_apply(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..fx import apply_effects
    from ..media.source import FrameSource
    from . import media as M
    from .render import ensure_out_not_source

    video = env.normalize_path(str(args["video"]))
    if not Path(video).is_file():
        raise OpError("Io", f"找不到影片 {video}")
    out_path = Path(env.normalize_path(str(args["out"])))
    ensure_out_not_source(out_path, video)
    ctx.progress(STAGE_OPEN, 0, 1, phase="open")
    mc, pr = M.open_media(video, ctx)
    plan, extra_v = plan_encode(out_path, pr, args)  # --cq 0 做不到無損 → 在解碼／算錨點之前就報錯
    index, cfr, _ = M.ensure_index(video, mc, pr, ctx)
    W, H = int(pr.width), int(pr.height)
    k0, k1 = parse_frames(args.get("frames"), int(cfr.n_frames))
    tracks, pairs, _stacks = resolve(args, W, H, int(cfr.n_frames), ctx)
    changed = 0
    footprint_sum = 0
    absent = {key: 0 for key in tracks}
    warnings: list[str] = []

    with FrameSource(video, index, cfr, probe=pr, lru=8, ctx=ctx) as fs:

        def frames():  # noqa: ANN202
            nonlocal changed, footprint_sum
            for i, k in enumerate(range(k0, k1)):
                ctx.check_cancel()
                fr = fs.get_proxy_frame(k)
                objs = _objects_at(tracks, k)
                for key, o in objs.items():
                    if not o.visible:
                        absent[key] += 1
                res = apply_effects(fr, k, objs, pairs)
                for w in res.warnings:
                    if w not in warnings:
                        warnings.append(w)
                        ctx.log("warn", w)
                if res.changed:
                    changed += 1
                    footprint_sum += res.footprint_px
                ctx.progress(STAGE, i + 1, k1 - k0, frame=k)
                yield res.frame  # 沒改動時就是 fr 本身

        info = _encode(frames(), out_path, pr, cfr, k1 - k0, args, ctx, plan=plan, extra_video_args=extra_v, k_range=(k0, k1))

    ctx.artifact(str(out_path), "fx")
    objects = _summary(tracks, pairs)
    for o in objects:
        o["absentFrames"] = absent[o["object"]]
    total = k1 - k0
    result = {
        "video": video,
        "size": [W, H],
        "range": [k0, k1],
        "objects": objects,
        "changedFrames": changed,
        "unchangedFrames": total - changed,
        "avgFootprintPx": round(footprint_sum / changed, 1) if changed else 0.0,
        "warnings": warnings,
        "out": str(out_path),
        "frames": info["frames"],
        "bytes": info["bytes"],
        "seconds": info["seconds"],
    }
    nl = chr(10)
    result["_human"] = (
        f"{info['frames']} 幀 → {out_path}（{info['bytes'] / 1e6:.1f} MB，{info['seconds']}s）{nl}"
        + f"  {len(tracks)} 個物件，改了 {changed} 幀（{total - changed} 幀原樣放行）"
        + "".join(f"{nl}  ⚠ 物件 {o['object']} 有 {o['absentFrames']} 幀不在畫面（遮罩缺席），那幾幀它的特效沒有做" for o in objects if o["absentFrames"])
        + "".join(f"{nl}  ⚠ {w}" for w in warnings)
    )
    return result


# ---------------------------------------------------------------- fx.preview
@register("fx.preview", cli="fx-preview", help="物件特效單幀預覽 PNG（--compare 左右對照）", args=_preview_args)
def fx_preview(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    import numpy as np

    from ..fx import apply_effects
    from ..media.source import FrameSource
    from ..seg import preview, viz
    from . import media as M

    video = env.normalize_path(str(args["video"]))
    if not Path(video).is_file():
        raise OpError("Io", f"找不到影片 {video}")
    out = Path(env.normalize_path(str(args["out"])))
    t0 = time.perf_counter()
    mc, pr = M.open_media(video, ctx)
    index, cfr, _ = M.ensure_index(video, mc, pr, ctx)
    W, H, n = int(pr.width), int(pr.height), int(cfr.n_frames)
    K = int(args["frame"])
    if not 0 <= K < n:
        raise OpError("Invalid", f"--frame {K} 超出 proxy 幀範圍 [0, {n})")
    tracks, pairs, _stacks = resolve(args, W, H, n, ctx)
    with FrameSource(video, index, cfr, probe=pr, lru=2, ctx=ctx) as fs:
        fr = fs.get_proxy_frame(K)
        objs = _objects_at(tracks, K)
        res = apply_effects(fr, K, objs, pairs)
        after = res.frame.rgb8()
        before = fr.rgb8() if args.get("compare") else None
    img = after
    if before is not None:
        a = np.ascontiguousarray(before.copy())
        b = np.ascontiguousarray(after.copy())
        viz.title_bar(a, "before")
        viz.title_bar(b, f"after  k={K}")
        img = viz.contact_sheet([a, b], cols=2, gap=4)
    max_w = int(args.get("max_width") or 0)
    if max_w > 0 and img.shape[1] > max_w:
        import cv2

        img = cv2.resize(img, (max_w, max(1, int(round(img.shape[0] * max_w / img.shape[1])))), interpolation=cv2.INTER_AREA)
    path = preview.save_png(out, img)
    ctx.artifact(path, kind="preview")
    return {
        "frame": K,
        "t": round(float(K * cfr.fps_den / cfr.fps_num), 6),
        "out": path,
        "size": [int(img.shape[1]), int(img.shape[0])],
        "changed": res.changed,
        "footprintPx": res.footprint_px,
        "roi": list(res.roi) if res.roi else None,
        "applied": [{"object": k, "type": t} for k, t in res.applied],
        "skipped": [{"object": k, "reason": r} for k, r in res.skipped],
        "visible": {str(k): o.visible for k, o in objs.items()},
        "warnings": res.warnings,
        "seconds": round(time.perf_counter() - t0, 3),
        "_human": f"k={K} → {path}（{'改了 ' + str(res.footprint_px) + ' 個像素' if res.changed else '這一幀沒有特效作用'}）"
        + "".join(f"\n  ⚠ {w}" for w in res.warnings),
    }
