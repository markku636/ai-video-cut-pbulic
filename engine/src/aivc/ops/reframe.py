"""`aivc reframe <影片> --aspect 9:16 --text "person"`（op `reframe.plan`）：自動重構圖的規劃。

把橫幅影片裁成直幅／方形，鏡頭跟著主體走。這一支**只規劃、不渲染**：輸出是一份
`*.reframe.json`（見 `reframe/doc.py`），渲染時 `aivc render --reframe <那份 json>` 套上去。

## 為什麼規劃與渲染要分開

規劃要跑開放詞彙偵測（GPU、數十秒），渲染要跑編碼（數分鐘）。綁在一起的話，
「鏡頭跟錯人了」只能整支重跑。分開之後可以先花幾十秒規劃、用 `--preview` 看一眼、
不滿意就改 `--text` 或 `--bias-y` 再規劃一次 —— 改的是幾十秒的那一段。
路徑檔也是人看得懂的 JSON，真要手動改哪一段也改得動。

## 抽樣，不是逐幀

開放詞彙偵測每幀都跑太慢（CUDA 上一幀約 0.08 秒，5400 幀要七分鐘）。實際上主體
在相鄰幾幀之間幾乎不動，所以預設每 0.2 秒取樣一次（依 fps 換算成幀），中間用
`interpolate_centers` 補。抽樣會踩到的那個坑 —— 鏡頭切點落在兩個取樣點之間 ——
在那支純函式裡處理掉了（跳太遠就不內插，讓切點留到下一個取樣點）。

## 不給 `--text` 時

退成靜態置中裁切（`--bias-x/--bias-y` 仍然有效）。這不是降級的安慰獎：
訪談、固定機位的教學片本來就不需要追焦，靜態裁切又快又穩，而且完全不碰 GPU。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from .. import atomic, env
from . import Ctx, OpError, register

STAGE = "reframe.plan"
#: 每隔多久偵測一次（秒）。主體在 0.2 秒內移動的距離，追焦器本來就走不完。
#: **依 fps 換算成幀**而不是寫死幀數：寫死 6 的話 24 fps 是每 0.25 秒、60 fps 變成每 0.1 秒，
#: 同樣一支片子只因為畫格率高就多做一倍的偵測，而結果幾乎一樣。
DEFAULT_EVERY_SECONDS = 0.2


def default_every(fps: float) -> int:
    """依 fps 算預設的取樣間隔（幀）。至少 1。"""
    return max(1, int(round((fps if fps > 0 else 30.0) * DEFAULT_EVERY_SECONDS)))
#: 自動偵測鏡頭切換的預設門檻（實測值，見 `reframe/scene.py` 的常數說明）。
SCENE_DEFAULT = 0.35
#: 預覽聯絡表最多放幾格（再多一張圖就看不清了）。
PREVIEW_TILES = 6
#: 回傳 base64 聯絡表時縮到這個寬度。對話框裡只有幾百 px 寬，送原尺寸只是讓 JSONL 變大。
INLINE_PREVIEW_W = 900


def _args(p: argparse.ArgumentParser) -> None:
    p.add_argument("video", help="影片（通常是 proxy）")
    p.add_argument("--out", default=None, help="路徑檔輸出位置（預設：影片旁邊的 <名稱>.reframe.json）")
    p.add_argument("--aspect", default="9:16", help="目標長寬比：9:16（預設）｜4:5｜1:1｜16:9｜4:3｜2.39:1，或直接給 0.5625")
    p.add_argument("--text", default=None, help='要跟著誰，逗號分隔（例如 "person, face"）；不給就是靜態置中裁切')
    p.add_argument("--every", type=int, default=None, help=f"每幾幀偵測一次（預設依 fps 換算 {DEFAULT_EVERY_SECONDS} 秒：24 fps → 5、30 → 6、60 → 12）")
    p.add_argument("--range", default=None, metavar="K0:K1", help="只規劃 proxy 幀 [K0,K1)")
    p.add_argument("--zoom", type=float, default=1.0, help="推近倍率（>1 裁得更小；預設 1 = 塞得下的最大框）")
    p.add_argument("--deadzone", type=float, default=None, help="盲區半徑，裁切框寬的比例（預設 0.10）；調大＝鏡頭更懶")
    p.add_argument("--max-speed", type=float, default=None, help="平移速度上限：每秒幾個裁切框寬（預設 0.7）")
    p.add_argument("--cut-threshold", type=float, default=None, help="目標跳超過來源寬的這個比例就用切的（預設 0.35；0 = 一律用平移）")
    p.add_argument("--bias-x", type=float, default=0.0, help="裁切框中心的水平偏移（裁切框寬的比例）")
    p.add_argument("--bias-y", type=float, default=0.0, help="垂直偏移；正值把框往下挪 → 主體在成品裡偏上（人像的頭頂留白）")
    p.add_argument("--cuts", default=None, help="已知的鏡頭邊界，逗號分隔的幀號（專案有鏡頭偵測時給了比猜準）")
    p.add_argument("--scene-threshold", type=float, default=None, help=f"自動偵測鏡頭切換的門檻（預設 {SCENE_DEFAULT}，量出來的；0 = 關掉）")
    p.add_argument("--preview", default=None, help="輸出一張預覽聯絡表 PNG（等距取幾格裁好的畫面）")
    p.add_argument("--inline-preview", action="store_true", help="結果裡多帶一份 base64 的聯絡表（App 用：直接畫在對話框裡，不必開外部看圖程式）")
    p.add_argument("--owl", default=None, help="OWLv2 變體：base（預設）｜large")
    p.add_argument("--threshold", type=float, default=None, help="偵測分數門檻（預設 0.1）")
    p.add_argument("--max-boxes", type=int, default=None, help="每幀最多取幾個框（預設 8）")
    p.add_argument("--device", default=None, help="cuda｜mps｜cpu｜auto（預設 auto）")


def parse_cuts(text: str | None, n: int) -> list[int]:
    """`"10, 200"` → `[10, 200]`；超出範圍的安靜丟掉（鏡頭表可能比規劃範圍長）。"""
    if not text:
        return []
    out: list[int] = []
    for part in str(text).replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            k = int(float(part))
        except ValueError as e:
            raise OpError("Invalid", f"--cuts 不是數字：{part!r}") from e
        if 0 < k < n:
            out.append(k)
    return sorted(set(out))


def sample_frames(k0: int, k1: int, every: int) -> list[int]:
    """要偵測哪幾幀。一定含頭尾：尾巴漏掉的話最後一段會整段沿用，那通常正是主體離場的地方。"""
    if every < 1:
        raise OpError("Invalid", f"--every 要 ≥ 1（拿到 {every}）")
    ks = list(range(k0, k1, every))
    if k1 - 1 > k0 and (not ks or ks[-1] != k1 - 1):
        ks.append(k1 - 1)
    return ks


def options_from_args(args: dict[str, Any]) -> Any:
    """CLI 參數 → `ReframeOptions`。沒給的欄位用 dataclass 的預設，不在這裡重複一份。"""
    from ..reframe.path import ReframeError, ReframeOptions, parse_aspect

    try:
        aspect = parse_aspect(str(args.get("aspect") or "9:16"))
    except ReframeError as e:
        raise OpError("Invalid", str(e)) from e
    # 一律 `is not None` 而不是 `or`：`--zoom 0` 被 `or 1.0` 吞掉的話，不合法的值會安靜地變成預設，
    # 使用者看到的是「參數沒作用」而不是錯誤訊息（TS 端的 `Number("") === 0` 是同一族的坑）
    kw: dict[str, Any] = {"aspect": aspect}
    for cli, field in [("zoom", "zoom"), ("deadzone", "deadzone"), ("max_speed", "max_speed"),
                       ("cut_threshold", "cut_threshold"), ("bias_x", "bias_x"), ("bias_y", "bias_y")]:
        if args.get(cli) is not None:
            kw[field] = float(args[cli])
    try:
        return ReframeOptions(**kw).validated()
    except ReframeError as e:
        raise OpError("Invalid", str(e)) from e


def _contact_sheet(pf: Any, rects: list[Any], k0: int, out: str | None, inline: bool = False) -> str | None:
    """等距取幾格裁好的畫面併成一張 PNG。看「鏡頭有沒有跟對人」比看 JSON 快得多。

    `out` 給了就寫 PNG；`inline` 為真就另外回一份 base64 **JPEG**（App 直接畫在對話框裡）。
    兩者可以同時要：寫檔是給人留存與用外部工具看的，inline 是為了**不必離開對話框**。
    """
    import base64

    import cv2
    import numpy as np

    from ..imageio import imwrite_unicode

    n = len(rects)
    if n == 0:
        return None
    picks = sorted({int(round(i * (n - 1) / max(1, min(PREVIEW_TILES, n) - 1))) for i in range(min(PREVIEW_TILES, n))})
    tiles: list[np.ndarray] = []
    for i in picks:
        r = rects[i]
        rgb = pf.get(k0 + i)
        tile = rgb[r.y : r.y + r.h, r.x : r.x + r.w]
        h = 360
        w = max(2, int(round(tile.shape[1] * h / tile.shape[0])))
        tiles.append(cv2.resize(tile, (w, h), interpolation=cv2.INTER_AREA))
    sheet = cv2.cvtColor(np.concatenate(tiles, axis=1), cv2.COLOR_RGB2BGR)
    if out:
        imwrite_unicode(out, sheet)
    if not inline:
        return None
    # 對話框裡的寬度只有幾百 px，送原尺寸只是讓 JSONL 變大；縮到 900 寬就夠看了
    if sheet.shape[1] > INLINE_PREVIEW_W:
        h = max(1, int(round(sheet.shape[0] * INLINE_PREVIEW_W / sheet.shape[1])))
        sheet = cv2.resize(sheet, (INLINE_PREVIEW_W, h), interpolation=cv2.INTER_AREA)
    # JPEG 不是 PNG：聯絡表是照片，同樣看得清楚的情況下 PNG 要 150 KB、JPEG 只要三十幾 KB，
    # 而它要塞進 JSONL 回給 App。寫到磁碟的那一份仍然是 PNG（留存用）。
    ok, enc = cv2.imencode(".jpg", sheet, [cv2.IMWRITE_JPEG_QUALITY, 82])
    return base64.b64encode(enc.tobytes()).decode("ascii") if ok else None


@register("reframe.plan", cli="reframe", help="自動重構圖：規劃裁切路徑（鏡頭跟著主體走）", args=_args, gpu=True)
def reframe_plan(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..reframe.doc import to_doc
    from ..reframe.path import ReframeError, centers_from_boxes, crop_size, interpolate_centers, plan_from_centers, static_path
    from .track import ProxyFrames

    video = env.normalize_path(args["video"])
    if not Path(video).is_file():
        raise OpError("Io", f"找不到影片 {video}")
    opts = options_from_args(args)

    ctx.progress(STAGE, 0, 3)
    # **幀來源與 track.solve / seg.run 共用 ProxyFrames**（計畫決策 3）：幀號一律是 CFR proxy 幀 k，
    # probe 與 index 都走 media 模組的快取。第一版自己 `scan()` + `PR.probe()`，有兩個問題：
    # (1) `seg/_frames` 的解碼序號在 VFR 來源上與 proxy k 對不上（seg.py 的說明就是為此改掉的）；
    # (2) 直接 probe 會繞過快取，而在引擎 worker 裡那條路會卡住 —— 實測 App 送進來的請求
    #     停在第一次偵測之前、worker 完全沒吃 CPU，而同樣的參數用 CLI 跑 24 秒就完成。
    with ProxyFrames(video, ctx) as pf:
        n_all = len(pf)
        rng = _parse_range(args.get("range"), n_all)
        k0, k1 = rng if rng else (0, n_all)
        n = k1 - k0
        if n <= 0:
            raise OpError("Invalid", f"範圍是空的（{k0}:{k1}）")
        src = (pf.width, pf.height)
        fps = (int(pf.cfr.fps_num), int(pf.cfr.fps_den))
        fps_f = fps[0] / fps[1] if fps[1] else 30.0
        try:
            cw, ch = crop_size(src[0], src[1], opts.aspect, opts.zoom)
        except ReframeError as e:
            raise OpError("Invalid", str(e)) from e

        text = (args.get("text") or "").strip()
        cuts = parse_cuts(args.get("cuts"), n)
        meta: dict[str, Any] = {"aspect": f"{opts.aspect[0]}:{opts.aspect[1]}", "zoom": opts.zoom, "range": [k0, k1]}

        if not text:
            ctx.progress(STAGE, 2, 3)
            path = static_path(src, n, opts)
            meta["mode"] = "static"
            detected = 0
        else:
            meta["mode"] = "track"
            meta["text"] = text
            every = default_every(fps_f) if args.get("every") is None else int(args["every"])
            meta["every"] = every
            ks = sample_frames(k0, k1, every)
            scene_th = SCENE_DEFAULT if args.get("scene_threshold") is None else float(args["scene_threshold"])
            boxes, detected, auto_cuts = _detect_boxes(pf, ks, args, ctx, scene_th)
            # 使用者給的鏡頭邊界與自動偵測到的取聯集：兩邊都可能漏，但都不太會誤報
            cuts = sorted(set(cuts) | {c for c in auto_cuts if k0 < c < k1})
            meta["sceneCuts"] = len(auto_cuts)
            # 中心在這裡才算，而且是一次算完整串 —— 主體黏著需要「上一次跟的是誰」，
            # 那個狀態只存在於這一串裡，塞進偵測迴圈會讓兩件事糾纏在一起。
            centers = centers_from_boxes(boxes, cw, ch, opts)
            per_frame: list[tuple[float, float] | None] = [None] * n
            for k, c in zip(ks, centers):
                per_frame[k - k0] = c
            # 內插的門檻與切點門檻同一個數：兩個取樣點之間跳得比「該用切的」還遠就不內插
            jump = (src[0] * opts.cut_threshold, src[1] * opts.cut_threshold) if opts.cut_threshold > 0 else (1e18, 1e18)
            path = plan_from_centers(interpolate_centers(per_frame, jump), src, fps_f, opts, cuts=cuts)
            meta["detected"] = detected
            meta["sampled"] = len(ks)

        out_path = Path(env.normalize_path(args["out"])) if args.get("out") else Path(video).with_suffix(".reframe.json")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        doc = to_doc(path, fps=fps, meta=meta)
        # 原子寫入：render 會讀這份檔，半寫的 JSON 會讓它報一個跟真正原因無關的錯
        # （專案的慣例，見 media/cache.write_json；這裡不用那一支是因為它寫成一行，
        #  而路徑檔刻意留 indent 讓人打得開）
        with atomic.atomic_write(out_path, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=1)

        preview = args.get("preview")
        inline = bool(args.get("inline_preview"))
        preview_data = _contact_sheet(pf, path.rects, k0, env.normalize_path(preview) if preview else None, inline) if (preview or inline) else None
    ctx.progress(STAGE, 3, 3)

    moved = len({(r.x, r.y) for r in path.rects})
    return {
        "path": str(out_path),
        "source": list(src),
        "size": [cw, ch],
        "frames": n,
        "range": [k0, k1],
        "mode": meta["mode"],
        "cuts": path.cuts,
        "sceneCuts": meta.get("sceneCuts", 0),
        "missing": path.missing,
        "segments": len(doc["segments"]),
        "preview": env.normalize_path(preview) if preview else None,
        "previewData": preview_data,
        "_human": (
            f"{src[0]}×{src[1]} → {cw}×{ch}  {n} 幀  {meta['mode']}"
            + (f"  偵測到 {detected}/{meta.get('sampled', 0)} 個取樣幀" if text else "")
            + f"  {moved} 個位置、{len(path.cuts)} 個切點  → {out_path}"
        ),
    }


def _detect_boxes(pf: Any, ks: list[int], args: dict[str, Any], ctx: Ctx, scene_threshold: float) -> tuple[list[list[Any]], int, list[int]]:
    """在取樣幀上跑開放詞彙偵測，回每個取樣幀的框（找不到就空串列）與「有找到東西的取樣幀數」。

    **一趟循序取幀**（`ProxyFrames.iter_frames`）而不是逐幀跳著取：取樣本來就是遞增且密集的
    （預設每 0.2 秒一個），循序時解碼器每幀只解一次；跳著取會讓每個取樣都從前一個關鍵幀重解，
    GOP 大的來源等於重解幾百幀。

    順便**逐幀**算鏡頭切換的簽章（第三個回傳值）：幀都已經解出來了，多算一個 32×18 的縮圖
    幾乎不花成本，而且因為是逐幀算的，切點是幀準的 —— 只靠取樣點的話誤差會到 ±0.2 秒。
    """
    from ..reframe.path import Box
    from ..reframe.scene import frame_signature, scene_cuts
    from ..seg.backend import SegModelError
    from ..seg.text_box import DEFAULT_MAX_BOXES, DEFAULT_THRESHOLD, DEFAULT_VARIANT, detect, load

    text = str(args["text"])
    variant = args.get("owl") or DEFAULT_VARIANT
    device = args.get("device")
    threshold = DEFAULT_THRESHOLD if args.get("threshold") is None else float(args["threshold"])
    max_boxes = DEFAULT_MAX_BOXES if args.get("max_boxes") is None else int(args["max_boxes"])

    if not ks:
        return ([], 0, [])
    # **先把模型載進來，再開解碼器**：第一次 detect() 會載 OWLv2，而那時如果 PyAV 的解碼器
    # 正開著（ProxyFrames 的 FrameSource），在引擎 worker 裡會整個卡死 —— 實測 App 送進來的
    # 請求停在第一次偵測之前、worker 完全沒吃 CPU，而同樣參數用 CLI 跑 27 秒就完成。
    # `seg.text_boxes` 沒有這個問題，因為它是先 read_frame（讀完就關）再 detect。
    ctx.log("info", "載入開放詞彙偵測模型…")
    try:
        load(variant, device)
    except SegModelError as e:
        raise OpError(e.kind, str(e), e.hint) from e
    want = {k: i for i, k in enumerate(ks)}
    out: list[list[Any]] = [[] for _ in ks]
    found_any = 0
    done = 0
    sigs: list[tuple[int, Any]] = []
    for k, rgb in pf.iter_frames(ks[0], ks[-1] + 1):
        if scene_threshold > 0:
            sigs.append((k, frame_signature(rgb)))
        i = want.get(k)
        if i is None:
            continue
        ctx.check_cancel()
        try:
            found = detect(rgb, text, variant=variant, device=device, threshold=threshold, max_boxes=max_boxes)
        except SegModelError as e:
            raise OpError(e.kind, str(e), e.hint) from e
        boxes = [Box(x=b.box[0], y=b.box[1], w=b.box[2], h=b.box[3], score=b.score) for b in found]
        if boxes:
            found_any += 1
        out[i] = boxes
        done += 1
        ctx.progress(STAGE, 1 + done / max(1, len(ks)), 3)
    auto = scene_cuts(sigs, scene_threshold) if scene_threshold > 0 else []
    if auto:
        ctx.log("info", f"自動偵測到 {len(auto)} 個鏡頭切換")
    return out, found_any, auto


def _parse_range(s: Any, n_frames: int) -> tuple[int, int] | None:
    """`"K0:K1"` → 夾進 [0, n) 的半開區間；格式不對就擲 OpError。"""
    if not s:
        return None
    parts = str(s).split(":")
    if len(parts) != 2:
        raise OpError("Invalid", f"--range 要寫成 K0:K1（拿到 {s!r}）")
    try:
        a, b = int(parts[0]), int(parts[1])
    except ValueError as e:
        raise OpError("Invalid", f"--range 不是數字：{s!r}") from e
    a = max(0, min(a, n_frames))
    b = max(0, min(b, n_frames))
    if b <= a:
        raise OpError("Invalid", f"--range 的 K1 要大於 K0（夾進影片長度後拿到 {a}:{b}）")
    return (a, b)


# ---------------------------------------------------------------- 套用（不需要專案）

APPLY_STAGE = "reframe.apply"
#: 輸出品質（crf / cq）。0 是合法值（無損），取值一律 `is not None`。
APPLY_CQ = 19


def _apply_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("video", help="要裁的影片（任何檔案；不需要專案）")
    p.add_argument("--path", required=True, metavar="JSON", help="aivc reframe 產生的 *.reframe.json")
    p.add_argument("-o", "--out", required=True, help="輸出影片")
    p.add_argument("--size", default=None, metavar="WxH", help="再縮到這個尺寸（長寬都要偶數）；不給就輸出裁切尺寸，**零重取樣**")
    p.add_argument("--codec", default=None, help="輸出編碼器（預設 auto）")
    p.add_argument("--cq", type=int, default=None, help=f"輸出品質 crf / cq（預設 {APPLY_CQ}；0 = 無損）")


def parse_size(text: str | None) -> tuple[int, int] | None:
    """`"1080x1920"` → (1080, 1920)。長寬都要是 ≥2 的偶數（yuv420 的色度平面）。"""
    if not text:
        return None
    s = str(text).lower().replace("×", "x").replace("*", "x")
    parts = [t.strip() for t in s.split("x") if t.strip()]
    if len(parts) != 2:
        raise OpError("Invalid", f"--size 要寫成 WxH（拿到 {text!r}）")
    try:
        w, h = int(parts[0]), int(parts[1])
    except ValueError as e:
        raise OpError("Invalid", f"--size 不是數字：{text!r}") from e
    if w < 2 or h < 2 or w % 2 or h % 2:
        raise OpError("Invalid", f"--size 的長寬都要是 ≥2 的偶數（拿到 {w}×{h}）")
    return (w, h)


@register("reframe.apply", cli="reframe-apply", help="把規劃好的裁切路徑套到一支影片上（不需要專案）", args=_apply_args)
def reframe_apply(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    """`aivc reframe-apply <影片> --path p.reframe.json -o 直的.mp4`

    ## 為什麼要有這一支

    `render --reframe` 只對「專案 + 序列」那條路有用。但常見的需求是**手上已經有一支成片**
    （別的工具剪的、或這裡先輸出好的序列）想轉成直幅 —— 那條路上沒有專案可言。
    這一支只做「照路徑裁 + 重新編碼」，輸入是任何影片檔。

    序列輸出的重構圖也走這裡：先正常輸出序列成一支影片，再對那支跑 `reframe` 與這一支。
    序列幀與素材 proxy 幀是兩套幀號（見 `render.load_reframe` 的守門），
    但對「輸出好的那支影片」來說只有一套，問題自然消失。

    不給 `--size` 就輸出裁切尺寸，**整條路零重取樣**（見 `reframe/apply.py`）。
    """
    from ..media.source import FrameSource
    from ..reframe.apply import crop_frames
    from ..reframe.doc import from_doc
    from ..reframe.path import ReframeError
    from . import media as M

    video = env.normalize_path(args["video"])
    if not Path(video).is_file():
        raise OpError("Io", f"找不到影片 {video}")
    out_path = Path(env.normalize_path(args["out"]))
    from .render import ensure_out_not_source

    ensure_out_not_source(out_path, video)
    size = parse_size(args.get("size"))

    path_file = Path(env.normalize_path(args["path"]))
    if not path_file.is_file():
        raise OpError("Io", f"找不到重構圖路徑檔 {path_file}", hint="先跑 aivc reframe <影片> 產生")
    try:
        rf = from_doc(json.loads(path_file.read_text(encoding="utf-8")))
    except json.JSONDecodeError as e:
        raise OpError("Invalid", f"重構圖路徑檔不是合法 JSON：{e}") from e
    except ReframeError as e:
        raise OpError("Invalid", str(e)) from e

    ctx.progress(APPLY_STAGE, 0, 1)
    mc, pr = M.open_media(video, ctx)
    index, cfr, _ = M.ensure_index(video, mc, pr, ctx)
    n = int(cfr.n_frames)
    if tuple(rf.source) != (int(pr.width), int(pr.height)):
        raise OpError(
            "Invalid",
            f"路徑是對 {rf.source[0]}×{rf.source[1]} 規劃的，這支影片是 {pr.width}×{pr.height}",
            hint="對同一支影片重新跑一次 aivc reframe",
        )
    if len(rf.rects) != n:
        # 這裡刻意不像 render 那樣去對 meta.range：輸入就是一整支影片，路徑理應涵蓋它。
        # 對不上通常代表拿錯了路徑檔，猜比報錯糟。
        raise OpError(
            "Invalid",
            f"影片有 {n} 幀，路徑有 {len(rf.rects)} 幀",
            hint="路徑要對這支影片整支規劃（aivc reframe <這支影片>）",
        )

    ow, oh = size if size else rf.size
    with FrameSource(video, index, cfr, probe=pr, lru=8, ctx=ctx) as fs:

        def frames():  # noqa: ANN202
            for k in range(n):
                ctx.check_cancel()
                yield fs.get_proxy_frame(k)

        info = _apply_encode(crop_frames(frames(), rf.rects, resize_to=size), out_path, pr, cfr, n, (ow, oh), args, ctx, video)

    ctx.artifact(str(out_path), "reframe")
    return {
        "out": str(out_path),
        "source": list(rf.source),
        "size": [ow, oh],
        "frames": info["frames"],
        "bytes": info["bytes"],
        "seconds": info["seconds"],
        "resampled": bool(size),
        "_human": (
            f"{info['frames']} 幀 {rf.source[0]}×{rf.source[1]} → {ow}×{oh}"
            + ("（有縮放）" if size else "（零重取樣）")
            + f"  {info['bytes'] / 1e6:.1f} MB，{info['seconds']}s → {out_path}"
        ),
    }


def _apply_encode(frames: Any, out_path: Path, probe: Any, cfr: Any, total: int, size: tuple[int, int], args: dict[str, Any], ctx: Ctx, video: str) -> dict[str, Any]:
    """挑編碼器並寫檔（音訊從來源複製）。與 inpaint 的 `_encode` 同一個形狀，差在輸出尺寸不是來源尺寸。"""
    import time

    from ..media import encode_plan as EP
    from ..media import encoder as EN
    from .render import usable_encoders

    want = (args.get("codec") or "auto").strip() or "auto"
    spec = EP.EncodeSpec(
        container=None, codec=None if want == "auto" else want,
        quality=APPLY_CQ if args.get("cq") is None else int(args["cq"]),
        audio="auto", gpu=True, out_path=str(out_path),
        content_note="Edited video. Reframed by AI Video Cut.",
    )
    plan = EP.plan(spec, EP.SourceInfo.from_probe(probe), usable_encoders(True))
    for note in plan.notes:
        ctx.log("info", f"編碼：{note}")
    t0 = time.perf_counter()
    info = EN.write_frames(
        frames, plan, out_path, ctx,
        width=size[0], height=size[1], fps=(cfr.fps_num, cfr.fps_den), total=total,
        audio_source=video, stage="reframe",
    )
    info["seconds"] = round(time.perf_counter() - t0, 3)
    return info
