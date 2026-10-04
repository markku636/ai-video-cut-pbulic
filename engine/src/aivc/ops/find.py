"""`aivc find <video> --text "face, license plate" --out DIR`（op `seg.find`）：輸入文字找出畫面裡的東西，每個實例一個遮罩檔。

    aivc find <video> --text "face, license plate" [--frames K0:K1] [--anchor K] [--max 8] [--threshold T]
              [--backend auto|sam3|sam2] [--samples N] [--chunk N] [--min-frames N] --out DIR

產物（大 payload 全部落檔，結果 JSON 只有路徑與數字；與 `seg.run` 同一套格式，下游 bg-blur／inpaint／fx 直接吃）：

    DIR/obj<N>/masks.aivm   每個實例一個（N＝1..n，分數高的在前）
    DIR/obj<N>/thumb.png    那個實例「看得最清楚」那一幀的裁切縮圖（面積最大的幀）
    DIR/overlay.png         錨定幀（後備）或同時看得到最多實例的那一幀（SAM 3），每個實例疊色＋標編號
    DIR/find.v1.json        摘要（與 op 的回傳值相同）

後端（`--backend`，預設 auto；規則見 `seg/backends.py`）：
- **SAM 3**（facebook/sam3，需要在 Hugging Face 申請存取）：每一幀都偵測，新出現的物件自動成為新實例；
  串流模式沒有 hotstart 去重，所以預設丟掉少於 3 幀的實例（`--min-frames`）。
- **後備 OWLv2 + SAM 2.1**（本機沒有 SAM 3 權重時）：只在錨定幀（`--anchor`，預設範圍第一幀；`--samples N` 多看幾幀）
  用 OWLv2 找框，再用 SAM 2.1 往前後傳播。錨定幀沒出現的東西找不到；範圍請限制在同一個鏡頭內（鏡頭切換後 SAM 2.1 會追丟或黏錯）。

幀號一律是 CFR proxy 幀號 k（與 seg.run／track.solve／render 同一套，計畫決策 3）。
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Any

from .. import atomic, env
from . import Ctx, OpError, register

STAGE = "seg.find"
#: 每個階段各自一個 stage：ServeCtx 的 eta 以「這個 stage 的第一筆事件」為起點，前面的索引／載模型不能算進追蹤的每幀成本
STAGE_SCAN = "seg.find.scan"
STAGE_WRITE = "seg.find.write"
FORMAT = "aivc.find.v1"
SAM_VARIANTS = ("tiny", "small", "base", "large")


EPILOG = """後端與限制：
  SAM 3（facebook/sam3）：每幀偵測＋追蹤，物件中途出現也找得到。這個模型要先在 Hugging Face 申請存取
    （https://huggingface.co/facebook/sam3，作者審核），通過後設 HF_TOKEN 或 hf auth login，再 aivc models pull --sam3。
    串流模式沒有 hotstart 去重，偶爾會有一閃而過的誤偵測 → 預設丟掉少於 3 幀的實例（--min-frames）。
  後備 OWLv2 + SAM 2.1（本機沒有 SAM 3 權重時自動使用）：
    - 只在錨定幀（--anchor，預設 K0）找框；那一幀沒出現的物件找不到（--samples N 可多看幾幀，但每組多傳播一次）。
    - 鏡頭切換後 SAM 2.1 會追丟或黏到相似的東西：--frames 請限制在同一個鏡頭內（aivc shots 找切點）。
    - OWLv2 對長句／關係描述（「左邊那個人的臉」）弱，請用短的名詞片語（face、license plate、phone screen）。
  **--text 請用英文**：OWLv2 與 SAM 3 都只懂英文名詞片語；中文（「臉, 車牌」）在後備路線幾乎什麼都找不到，
    找到的也常是別的東西。偵測到中日韓文字會記一行 warn。
產物：DIR/obj<N>/masks.aivm、DIR/obj<N>/thumb.png、DIR/overlay.png、DIR/find.v1.json
  資料夾裡已經有「不是上一次 find 寫的」obj<N>/masks.aivm（例如用 select --obj N 加的）時，find 不會蓋掉它，跳過那個編號。"""


def _args(p: argparse.ArgumentParser) -> None:
    from ..seg.backends import BACKEND_CHOICES

    p.epilog = EPILOG
    p.formatter_class = argparse.RawDescriptionHelpFormatter
    p.add_argument("video", help="影片路徑（通常是 proxy）")
    p.add_argument("--text", required=True, help='要找什麼，逗號分隔的英文名詞片語（例如 "face, license plate"；OWLv2／SAM 3 只懂英文）')
    p.add_argument("--out", required=True, help="輸出目錄（obj<N>/masks.aivm、thumb.png、overlay.png、find.v1.json）")
    p.add_argument("--frames", default=None, metavar="K0:K1", help="幀範圍 [K0, K1)（proxy 幀號；預設整支）")
    p.add_argument("--anchor", type=int, default=None, help="後備在哪一幀找框（預設 K0）；SAM 3 每幀都偵測，這個只決定疊色預覽用哪一幀")
    p.add_argument("--max", dest="max_instances", type=int, default=None, help="最多幾個實例（預設 8）")
    p.add_argument("--threshold", type=float, default=None, help="偵測門檻：後備＝OWLv2 分數（預設 0.1）；SAM 3＝新實例的信心（預設用模型設定 0.7）")
    p.add_argument("--backend", choices=list(BACKEND_CHOICES), default=None, help="auto（預設；也可設環境變數 AIVC_SAM_BACKEND）：本機有 SAM 3 權重就用，否則 OWLv2 + SAM 2.1")
    p.add_argument("--samples", type=int, default=None, help="後備：總共在幾幀找框（錨定幀 + 均勻取樣；預設 1＝只看錨定幀）。找得到錨定幀沒出現的物件，但每多一組要多傳播一次")
    p.add_argument("--chunk", type=int, default=None, help="SAM 3：每幾幀換一個 session 限制記憶體（預設 600；0＝不分段）")
    p.add_argument("--min-frames", type=int, default=None, help="出現少於幾幀的實例丟掉（至少 1；SAM 3 預設 3；後備預設 1）")
    p.add_argument("--sam", choices=SAM_VARIANTS, default="small", help="後備用的 SAM 2.1 變體（預設 small）")
    p.add_argument("--owl", choices=["base", "large"], default="base", help="後備用的 OWLv2 變體（預設 base）")
    p.add_argument("--device", default="auto", help="推論裝置 auto｜cuda｜cuda:N｜mps｜cpu（cpu 需 AIVC_ALLOW_CPU=1）")


def parse_range(s: str | None, n: int) -> tuple[int, int]:
    if not s:
        return 0, n
    try:
        a, b = (int(v) for v in str(s).split(":"))
    except ValueError as e:
        raise OpError("Invalid", f"--frames 要寫成 K0:K1，拿到 {s!r}") from e
    if a < 0 or b <= a:
        raise OpError("Invalid", f"--frames 需要 0 <= K0 < K1，拿到 {a}:{b}")
    if b > n:
        raise OpError("Invalid", f"--frames 上限 {b} 超過 proxy 幀數 {n}")
    return a, b


def _seg_error(e: Exception) -> OpError:
    return OpError(getattr(e, "kind", "Model"), str(e), getattr(e, "hint", ""))


@register("seg.find", cli="find", help="輸入文字找物件：每個實例一個 .aivm＋縮圖＋編號疊色圖（SAM 3；沒有權重時 OWLv2 + SAM 2.1）", args=_args, gpu=True)
def seg_find(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..seg import text_box
    from ..seg.backend import SegModelError
    from ..seg.backends import choose, fallback_log_line
    from .track import ProxyFrames

    video = env.normalize_path(str(args["video"]))
    if not Path(video).is_file():
        raise OpError("Io", f"找不到影片 {video}")
    phrases = text_box.parse_phrases(str(args.get("text") or ""))
    if not phrases:
        raise OpError("Invalid", "沒有可用的文字（逗號分隔，例如 \"face, license plate\"）")
    out_dir = Path(env.normalize_path(str(args["out"])))
    max_raw = args.get("max_instances", args.get("max"))  # sidecar 也可以直接送 "max"
    max_n = 8 if max_raw is None else int(max_raw)
    if max_n < 1:
        raise OpError("Invalid", f"--max 至少 1（拿到 {max_n}）")
    samples = 1 if args.get("samples") is None else int(args["samples"])
    if samples < 1:
        raise OpError("Invalid", f"--samples 至少 1（拿到 {samples}）")
    if args.get("min_frames") is not None and int(args["min_frames"]) < 1:
        # 0 或負數會留下「一幀都沒出現」的實例（沒有框、沒有縮圖），下游每一處都得特判
        raise OpError("Invalid", f"--min-frames 至少 1（拿到 {int(args['min_frames'])}）")
    if args.get("chunk") is not None and int(args["chunk"]) < 0:
        raise OpError("Invalid", f"--chunk 不能是負的（拿到 {int(args['chunk'])}；0＝不分段）")
    try:
        choice = choose(args.get("backend"))
    except SegModelError as e:
        raise _seg_error(e) from e
    if choice.fallback:
        ctx.log("warn", fallback_log_line(choice, "find"))
    else:
        ctx.log("info", f"後端：{'SAM 3' if choice.name == 'sam3' else 'OWLv2 + SAM 2.1'}（{choice.reason}）")
    cjk = non_english_phrases(phrases)
    if cjk:
        ctx.log("warn", cjk_warning(cjk))

    if choice.name == "sam3":
        from .models import ensure_sam3

        ensure_sam3(ctx)  # 明確要 sam3、權重不在本機：在這裡下載（有進度、可取消），不讓 from_pretrained 默默抓
    # 掃描／建索引用自己的 stage：它可能要幾十秒，跟後面追蹤用同一個 stage 會讓 ServeCtx 的 eta 把這段也算進每幀成本
    ctx.progress(STAGE_SCAN, 0, 1, phase="scan")
    frames = ProxyFrames(video, ctx)
    try:
        return _find(args, ctx, video, frames, phrases, out_dir, max_n, samples, choice, [cjk_warning(cjk)] if cjk else [])
    finally:
        frames.close()


def non_english_phrases(phrases: list[str]) -> list[str]:
    """含中日韓文字的片語（OWLv2／SAM 3 的文字編碼器只懂英文）。"""
    from ..captions.text import has_cjk

    return [p for p in phrases if has_cjk(p)]


def cjk_warning(phrases: list[str]) -> str:
    return (
        f"片語 {'、'.join(phrases)} 不是英文：OWLv2／SAM 3 只懂英文名詞片語，中文幾乎找不到東西（找到的也常是別的物件）"
        "——請改用英文，例如 face, license plate"
    )


def _find(
    args: dict[str, Any], ctx: Ctx, video: str, frames: Any, phrases: list[str], out_dir: Path, max_n: int, samples: int, choice: Any,
    extra_notes: list[str] | None = None,
) -> dict[str, Any]:
    from ..seg import backends as B
    from ..seg.backend import SegModelError
    from ..seg.finders import FindRequest
    from ..seg.instances import order_instances
    from ..seg.sam2_hf import gpu_max_memory_mb

    k0, k1 = parse_range(args.get("frames"), int(frames.n))
    anchor = k0 if args.get("anchor") is None else int(args["anchor"])
    if not (k0 <= anchor < k1):
        raise OpError("Invalid", f"--anchor {anchor} 不在 --frames [{k0}, {k1}) 內")
    req = FindRequest(
        k0, k1, anchor, tuple(phrases), max_n,
        None if args.get("threshold") is None else float(args["threshold"]), samples,
        None if args.get("chunk") is None else int(args["chunk"]),
        None if args.get("min_frames") is None else int(args["min_frames"]),
    )
    finder = B.make_finder(choice, device=args.get("device") or "auto", sam_variant=args.get("sam") or "small", owl_variant=args.get("owl") or "base", chunk=req.chunk)
    t0 = time.perf_counter()
    try:
        dev_reset_peak()
        model = finder.prepare()  # 先載模型再解碼（seg/text_box.py：解碼器開著時首次載模型會卡死）
        run = finder.find(frames, req, ctx)
    except SegModelError as e:
        raise _seg_error(e) from e
    wall = time.perf_counter() - t0
    run.notes += list(extra_notes or [])
    ranked = order_instances(run.instances)
    over = ranked[max_n:]
    ranked = ranked[:max_n]
    if over:
        run.notes.append(f"超過 --max {max_n}：丟掉分數較低的 {len(over)} 個實例")
    foreign = foreign_objs(out_dir)
    ids = assign_ids(len(ranked), foreign)
    if foreign and any(i > n for n, i in enumerate(ids, start=1)):
        run.notes.append(f"資料夾裡已有不是上一次 find 寫的 {', '.join(f'obj{n}' for n in sorted(foreign))}（例如 select 加的）：沒有覆寫，跳過這些編號")
    stale = clean_stale(out_dir, set(ids))
    if stale:
        run.notes.append(f"清掉上一次 find 留在同一個資料夾、這次沒有的 {', '.join(stale)}")
    result = write_outputs(
        out_dir, frames, ranked, video=video, text=str(args.get("text")), phrases=phrases, k0=k0, k1=k1, anchor=anchor,
        backend=choice.to_json(), overlay_frame=run.overlay_frame if run.overlay_frame is not None else (anchor if args.get("anchor") is not None else None),
        ctx=ctx, ids=ids,
    )
    result["dropped"] = int(run.dropped + len(over))
    result["notes"] = run.notes
    result["model"] = model
    result["timing"] = {"wallSeconds": round(wall, 3), **run.stats}
    result["gpu"] = {"maxMemoryAllocatedMB": gpu_max_memory_mb()}
    atomic.write_text(out_dir / "find.v1.json", json.dumps(result, ensure_ascii=False, indent=1))
    ctx.artifact(str(out_dir / "find.v1.json"), kind="find")
    lines = [f"{len(ranked)} 個實例（{result['backend']['label']}{'，後備' if choice.fallback else ''}）→ {out_dir}"]
    for inst in result["instances"]:
        box_s = str([round(v) for v in inst["box"]]) if inst.get("box") is not None else "—"
        lines.append(f"  obj{inst['id']}  {inst['phrase']:<16} 分數 {inst['score']:.3f}  幀 {inst['firstFrame']}–{inst['lastFrame']}（最佳 {inst['bestFrame']}）  框 {box_s}")
    lines += [f"  註：{n}" for n in run.notes]
    lines.append(f"  疊色預覽：{result['overlay']['path']}")
    result["_human"] = "\n".join(lines)
    return result


def _previous_ids(out_dir: Path) -> set[int]:
    """上一次 find（同一個資料夾的 find.v1.json）寫過的 obj 編號；沒有或讀不懂 → 空集合。"""
    prev = out_dir / "find.v1.json"
    if not prev.is_file():
        return set()
    try:
        doc = json.loads(atomic.read_text(prev))
    except (OSError, ValueError):
        return set()
    if not isinstance(doc, dict) or doc.get("format") != FORMAT:
        return set()
    out: set[int] = set()
    for inst in doc.get("instances") or []:
        n = inst.get("id") if isinstance(inst, dict) else None
        if isinstance(n, int) and not isinstance(n, bool) and n >= 1:
            out.add(n)
    return out


def foreign_objs(out_dir: Path) -> set[int]:
    """資料夾裡有 masks.aivm、但**不是**上一次 find 寫的 obj<N>（例如使用者用 `select --obj N` 加進來的）。
    find 不能覆寫它們：以前 find 重跑會無條件寫 obj1..objN，把手動加的物件整條追蹤蓋掉。"""
    import re

    if not out_dir.is_dir():
        return set()
    prev = _previous_ids(out_dir)
    out: set[int] = set()
    for d in out_dir.iterdir():
        m = re.fullmatch(r"obj(\d+)", d.name)
        if m and int(m.group(1)) >= 1 and (d / "masks.aivm").exists() and int(m.group(1)) not in prev:
            out.add(int(m.group(1)))
    return out


def assign_ids(n: int, reserved: set[int]) -> list[int]:
    """n 個實例（已排序）→ obj 編號：從 1 起、跳過 reserved（別人的物件）。沒有 reserved 時就是 1..n。"""
    ids: list[int] = []
    k = 1
    while len(ids) < n:
        if k not in reserved:
            ids.append(k)
        k += 1
    return ids


def clean_stale(out_dir: Path, new_ids: int | set[int]) -> list[str]:
    """上一次 find 寫在同一個資料夾、這次沒有的 obj<N>（例如上次 6 個、這次 2 個）：不清掉的話 obj3..6 還躺在那裡，
    下游（fx、App）照資料夾掃會撿到舊的。只動上一次 find.v1.json 列出來的實例、只刪我們自己寫的那幾個檔，
    資料夾空了才移除 —— 使用者自己放進去的東西一個都不碰。new_ids：這次要寫的編號（給 int n ＝ 1..n）。"""
    keep = set(range(1, int(new_ids) + 1)) if isinstance(new_ids, int) else set(new_ids)
    removed: list[str] = []
    for n in sorted(_previous_ids(out_dir)):
        if n in keep:
            continue
        d = out_dir / f"obj{n}"
        if not d.is_dir():
            continue
        for name in ("masks.aivm", "thumb.png", "anchors.v1.json"):
            atomic.unlink_quiet(d / name)
        try:
            d.rmdir()
        except OSError:
            pass  # 裡面還有使用者的檔：留著
        removed.append(f"obj{n}")
    return removed


def dev_reset_peak() -> None:
    try:
        from .. import device as dev

        dev.reset_peak_memory_stats()
    except Exception:  # noqa: BLE001
        pass


def choose_overlay_frame(instances: list[Any], k0: int, k1: int) -> int:
    """SAM 3：同時看得到最多實例的那一幀（同數量取總面積最大、再取最早）。沒有實例＝K0。"""
    best_k, best_key = k0, (-1, -1)
    counts: dict[int, list[int]] = {}
    for inst in instances:
        for k in inst.present_frames():
            if k0 <= k < k1:
                counts.setdefault(k, []).append(inst.area(k))
    for k in sorted(counts):
        key = (len(counts[k]), sum(counts[k]))
        if key > best_key:
            best_k, best_key = k, key
    return best_k


def write_outputs(
    out_dir: Path, frames: Any, ranked: list[Any], *, video: str, text: str, phrases: list[str], k0: int, k1: int, anchor: int,
    backend: dict[str, Any], overlay_frame: int | None, ctx: Ctx, ids: list[int] | None = None,
) -> dict[str, Any]:
    """排好序的實例 → obj<N>/masks.aivm、thumb.png、overlay.png；回摘要（find.v1.json 的內容）。
    ids：每個實例的 obj 編號（預設 1..n；資料夾裡有別人的 obj<N> 時跳過那些號碼，見 `assign_ids`）。"""
    from ..seg import preview, viz
    from ..seg.maskfile import MaskFile

    out_dir.mkdir(parents=True, exist_ok=True)
    W, H = int(frames.width), int(frames.height)
    ids = list(range(1, len(ranked) + 1)) if ids is None else list(ids)
    ctx.progress(STAGE_WRITE, 0, max(1, len(ranked)), phase="write")
    instances: list[dict[str, Any]] = []
    for n_done, (i, inst) in enumerate(zip(ids, ranked), start=1):
        ctx.check_cancel()
        d = out_dir / f"obj{i}"
        st = MaskFile.write_rle(d / "masks.aivm", W, H, sorted(inst.rle.items()))
        ctx.artifact(st.path, kind="masks")
        best = inst.best_frame()
        box = inst.bbox(best) if best is not None else None
        thumb = None
        if best is not None:
            m = inst.mask(best)
            if m is not None:
                thumb = preview.save_png(d / "thumb.png", viz.thumbnail(frames.get(best), m, i))
                ctx.artifact(thumb, kind="thumb")
        instances.append({
            "id": i,
            "phrase": inst.phrase,
            "score": round(float(inst.score), 4),
            "firstFrame": inst.first_frame,
            "lastFrame": inst.last_frame,
            "bestFrame": best,
            "box": [round(v, 2) for v in box] if box is not None else None,
            "area": inst.area(best) if best is not None else 0,
            "framesPresent": st.n_present,
            "framesAbsent": st.n_absent,
            "seedFrame": inst.seed_frame,
            "masks": st.path,
            "thumb": thumb,
        })
        ctx.progress(STAGE_WRITE, n_done, max(1, len(ranked)), phase="write")
    ok = overlay_frame if overlay_frame is not None and k0 <= overlay_frame < k1 else choose_overlay_frame(ranked, k0, k1)
    masks = {i: inst.mask(ok) for i, inst in zip(ids, ranked)}
    title = f"k={ok}  t={frames.seconds(ok):.3f}s  instances={sum(1 for m in masks.values() if m is not None)}/{len(ranked)}"
    ov = preview.save_png(out_dir / "overlay.png", viz.numbered_overlay(frames.get(ok), masks, title=title))
    ctx.artifact(ov, kind="preview")
    fps = getattr(getattr(frames, "cfr", None), "fps_num", None), getattr(getattr(frames, "cfr", None), "fps_den", None)
    return {
        "format": FORMAT,
        "video": video,
        "text": text,
        "phrases": phrases,
        "backend": backend,
        "frames": {"k0": k0, "k1": k1, "anchor": anchor},
        "frameSize": [W, H],
        "fps": [fps[0], fps[1]] if fps[0] else None,
        "outDir": str(out_dir),
        "overlay": {"path": ov, "frame": ok},
        "instances": instances,
    }
