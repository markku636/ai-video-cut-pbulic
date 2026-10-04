"""`aivc seg` / op `seg.run`：對一段幀範圍下框／點提示，用 SAM 2.1 傳播，每個物件寫一個 `.aivm`（計畫 §6.2 / §6.8）。

    aivc seg <video> --frames K0:K1 --box x,y,w,h [--box ...] [--point [OBJ=]K:x,y:add|reduce ...]
             [--anchor K] [--dir fwd|bwd|both] [--out DIR] [--sam tiny|small|base|large]

- 一個 `--box` ＝ 一個物件，物件 id 依序 1..n；`--point` 用 `OBJ=` 指定物件（省略＝1），標籤 add＝加選、reduce＝減選。
- v1 限制：所有提示必須在同一幀（錨定幀）。多幀提示／refine 是後續 `seg.prompt`／`seg.propagate` 的事。
- 幀號是 **CFR proxy 幀號 k**（計畫決策 3）：前端送的鏡頭範圍／錨定幀都是 proxy k，寫出的 `.aivm` 也以 proxy k 為鍵，
  track.solve 與 render.run 才讀得對。幀來源與 track.solve 共用 `ProxyFrames`（media.ensure_index → FrameSource），
  不再用 seg/_frames.py 的解碼序號（VFR 範例 1762 幀 vs proxy 1797 幀，最後一個鏡頭會被判超出範圍）。
- 大 payload 全部落檔：`<out>/obj<N>/masks.aivm` + `<out>/preview_k<K>.png`；結果 JSON 只回路徑與數字。
"""
from __future__ import annotations

import argparse
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .. import env
from . import Ctx, OpError, register


def _args(p: argparse.ArgumentParser) -> None:
    p.add_argument("video", help="影片路徑")
    p.add_argument("--frames", required=True, metavar="K0:K1", help="幀範圍 [K0, K1)（proxy 幀號）")
    p.add_argument("--box", action="append", default=[], metavar="x,y,w,h", help="框提示；每個 --box 一個物件（id 1..n）")
    p.add_argument("--point", action="append", default=[], metavar="[OBJ=]K:x,y:add|reduce", help="點提示：add＝加選、reduce＝減選；OBJ 省略＝1")
    p.add_argument("--anchor", type=int, default=None, help="提示所在幀（預設：--point 的 K；沒有點就是 K0）")
    p.add_argument("--dir", choices=["fwd", "bwd", "both"], default="both", help="傳播方向（預設 both；錨定在 K0 時 bwd 自然為空）")
    p.add_argument("--out", default=None, help="輸出目錄（預設 <cache>/media/<fp16>/tracks）")
    p.add_argument("--sam", choices=["tiny", "small", "base", "large"], default="small", help="SAM 2.1 hiera 變體（預設 small）")
    p.add_argument("--memory-window", type=int, default=64, help="記憶庫保留距離（幀）；0 = 不修剪")
    p.add_argument("--overlap", choices=["exclusive", "independent"], default="exclusive", help="多物件重疊像素：exclusive＝每像素只給分數最高的物件")
    p.add_argument("--previews", type=int, default=3, help="疊色預覽 PNG 張數（均勻取樣，含錨定幀）")
    # 預設 auto（aivc.device.resolve_device：cuda → mps → 放行時 cpu）。以前寫死 "cuda"，Mac 上要靠 resolve_device 的特例偷偷換成 mps；
    # 明確指定 cuda／mps／cpu 仍照辦，不可用就報錯、絕不悄悄退 CPU
    p.add_argument("--device", default="auto", help="推論裝置 auto｜cuda｜cuda:N｜mps｜cpu（預設 auto；cpu 需 AIVC_ALLOW_CPU=1）")


@dataclass(frozen=True)
class SegRequest:
    k0: int
    k1: int
    anchor: int
    boxes: dict[int, tuple[float, float, float, float]]
    points: dict[int, list[tuple[float, float, int]]]
    direction: str

    @property
    def object_ids(self) -> list[int]:
        return sorted(set(self.boxes) | set(self.points))


def parse_range(s: str) -> tuple[int, int]:
    try:
        a, b = s.split(":")
        k0, k1 = int(a), int(b)
    except ValueError as e:
        raise OpError("Invalid", f"--frames 要 K0:K1，拿到 {s!r}") from e
    if k0 < 0 or k1 <= k0:
        raise OpError("Invalid", f"--frames 需要 0 <= K0 < K1，拿到 {k0}:{k1}")
    return k0, k1


def parse_box(s: str) -> tuple[float, float, float, float]:
    try:
        x, y, w, h = (float(v) for v in s.split(","))
    except ValueError as e:
        raise OpError("Invalid", f"--box 要 x,y,w,h，拿到 {s!r}") from e
    if w <= 0 or h <= 0:
        raise OpError("Invalid", f"--box 寬高必須 > 0：{s!r}")
    return (x, y, w, h)


def parse_point(s: str) -> tuple[int, int, float, float, int]:
    """`[OBJ=]K:x,y:add|reduce` → (obj, k, x, y, label)。"""
    obj = 1
    body = s
    if "=" in s:
        o, body = s.split("=", 1)
        try:
            obj = int(o)
        except ValueError as e:
            raise OpError("Invalid", f"--point 的 OBJ 必須是整數：{s!r}") from e
    parts = body.split(":")
    if len(parts) != 3:
        raise OpError("Invalid", f"--point 要 [OBJ=]K:x,y:add|reduce，拿到 {s!r}")
    try:
        k = int(parts[0])
        x, y = (float(v) for v in parts[1].split(","))
    except ValueError as e:
        raise OpError("Invalid", f"--point 座標格式錯誤：{s!r}") from e
    label_word = parts[2].strip().lower()
    labels = {"add": 1, "reduce": 0, "1": 1, "0": 0, "pos": 1, "neg": 0}
    if label_word not in labels:
        raise OpError("Invalid", f"--point 標籤只能是 add（加選）或 reduce（減選）：{s!r}")
    if obj < 1:
        raise OpError("Invalid", f"物件 id 必須 >= 1：{s!r}")
    return obj, k, x, y, labels[label_word]


def build_request(args: dict[str, Any]) -> SegRequest:
    k0, k1 = parse_range(args["frames"])
    boxes = {i + 1: parse_box(b) for i, b in enumerate(args.get("box") or [])}
    points: dict[int, list[tuple[float, float, int]]] = {}
    point_frames: set[int] = set()
    for s in args.get("point") or []:
        obj, k, x, y, label = parse_point(s)
        points.setdefault(obj, []).append((x, y, label))
        point_frames.add(k)
    if not boxes and not points:
        raise OpError("Invalid", "至少要一個 --box 或 --point")
    if len(point_frames) > 1:
        raise OpError("Invalid", f"v1 所有提示必須在同一幀，拿到 {sorted(point_frames)}")
    anchor = args.get("anchor")
    if anchor is None:
        anchor = next(iter(point_frames)) if point_frames else k0
    if point_frames and anchor not in point_frames:
        raise OpError("Invalid", f"--anchor {anchor} 與 --point 的幀 {sorted(point_frames)} 不合")
    if not (k0 <= anchor < k1):
        raise OpError("Invalid", f"錨定幀 {anchor} 不在 --frames [{k0}, {k1}) 內")
    return SegRequest(k0, k1, int(anchor), boxes, points, args.get("dir") or "both")


@dataclass
class _Collector:
    """逐幀把 bool 遮罩編成 RLE 收起來（不留 bool 陣列），順便留預覽幀影像。"""

    preview_ks: set[int]
    rle: dict[int, dict[int, bytes | None]] = field(default_factory=dict)  # obj -> k -> counts
    preview_rgb: dict[int, np.ndarray] = field(default_factory=dict)
    preview_masks: dict[int, dict[int, np.ndarray]] = field(default_factory=dict)  # k -> obj -> mask
    absent: dict[int, int] = field(default_factory=dict)

    def add(self, k: int, rgb: np.ndarray | None, masks: dict[int, np.ndarray], scores: dict[int, float]) -> None:
        from ..seg import rle as _rle

        for obj, m in masks.items():
            present = scores.get(obj, 0.0) >= 0 and bool(m.any())
            self.rle.setdefault(obj, {})[k] = _rle.encode(m) if present else None
            if not present:
                self.absent[obj] = self.absent.get(obj, 0) + 1
        if k in self.preview_ks and rgb is not None:
            self.preview_rgb[k] = rgb
            self.preview_masks[k] = {o: m for o, m in masks.items()}


@register("seg.run", cli="seg", help="SAM 2.1 物件遮罩：框／點提示 → 沿鏡頭傳播 → 每物件一個 .aivm", args=_args, gpu=True)
def seg_run(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from .track import ProxyFrames

    req = build_request(args)
    video = env.normalize_path(args["video"])
    if not Path(video).is_file():
        raise OpError("Io", f"找不到影片 {video}")

    ctx.progress("seg.scan", 0, 1)
    frames = ProxyFrames(video, ctx)
    try:
        if req.k1 > frames.n:
            raise OpError("Invalid", f"--frames 上限 {req.k1} 超過 proxy 幀數 {frames.n}")
        ctx.progress("seg.scan", 1, 1)
        return _seg_run(args, ctx, req, video, frames)
    finally:
        frames.close()


def _seg_run(args: dict[str, Any], ctx: Ctx, req: SegRequest, video: str, frames: Any) -> dict[str, Any]:
    from ..seg import preview
    from ..seg.backend import SegModelError
    from ..seg.maskfile import MaskFile
    from ..seg.sam2_hf import Sam2HfBackend, cuda_max_memory_mb, hf_cache_size_bytes

    fp = frames.mc.fingerprint  # 與 track.solve / run.py 同一個 media 快取目錄
    W, H = frames.width, frames.height
    out_dir = Path(env.normalize_path(args["out"])) if args.get("out") else frames.mc.dir / "tracks"
    out_dir.mkdir(parents=True, exist_ok=True)

    # 模型
    t0 = time.perf_counter()
    backend = Sam2HfBackend(
        variant=args.get("sam") or "small",
        device=args.get("device") or "auto",  # sidecar 的 args 沒帶 device 時與 CLI 預設一致
        memory_window=(args.get("memory_window") or None) if (args.get("memory_window") or 0) > 0 else None,
        non_overlapping=(args.get("overlap") or "exclusive") == "exclusive",
    )
    try:
        loaded = backend.loaded()
    except SegModelError as e:
        raise OpError(e.kind, str(e), e.hint) from e
    model_load_s = time.perf_counter() - t0
    ctx.log("info", f"模型 {loaded.model_id} 就緒（{loaded.load_seconds:.1f} s 載入，GPU 前處理={loaded.preprocess_on_device}）")

    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
    except Exception:  # noqa: BLE001
        pass

    # 提示（錨定幀）
    session = backend.open_session((W, H))
    anchor_rgb = frames.get(req.anchor)
    n_fwd = (req.k1 - 1 - req.anchor) if req.direction in ("fwd", "both") else 0
    n_bwd = (req.anchor - req.k0) if req.direction in ("bwd", "both") else 0
    total = n_fwd + n_bwd
    preview_ks = _pick_previews(req, int(args.get("previews") or 0))
    col = _Collector(preview_ks)
    try:
        anchor_masks: dict[int, np.ndarray] = {}
        for obj in req.object_ids:
            ctx.check_cancel()
            anchor_masks[obj] = session.add_prompt(
                req.anchor, obj, anchor_rgb, points=req.points.get(obj, ()), box=req.boxes.get(obj)
            )
        col.add(req.anchor, anchor_rgb, anchor_masks, {o: 1.0 for o in anchor_masks})
        for obj, m in anchor_masks.items():
            if not m.any():
                ctx.log("warn", f"物件 {obj} 在錨定幀 {req.anchor} 的遮罩為空，請檢查提示座標")

        # 傳播
        done = 0
        t_prop = time.perf_counter()
        ctx.progress("seg.propagate", 0, max(total, 1))

        def run(src: Iterator[tuple[int, np.ndarray]], direction: str) -> None:
            nonlocal done
            keep: dict[int, np.ndarray] = {}  # 只留預覽幀的影像

            def feed() -> Iterator[tuple[int, np.ndarray]]:
                for k, rgb in src:
                    ctx.check_cancel()
                    if k in preview_ks:
                        keep[k] = rgb
                    yield k, rgb

            for fm in session.propagate_frames(feed(), direction):
                col.add(fm.k, keep.pop(fm.k, None), fm.masks, fm.scores)
                done += 1
                ctx.progress("seg.propagate", done, max(total, 1), frame=fm.k)

        if n_fwd:
            run(frames.iter_frames(req.anchor + 1, req.k1), "fwd")
        if n_bwd:
            run(frames.iter_frames_reversed(req.k0, req.anchor), "bwd")
        propagate_wall_s = time.perf_counter() - t_prop
        stats = session.stats
    finally:
        session.close()

    # 落檔
    objects = []
    for obj in req.object_ids:
        path = out_dir / f"obj{obj}" / "masks.aivm"
        rles = col.rle.get(obj, {})
        st = MaskFile.write(path, W, H, ()) if not rles else MaskFile.write_rle(path, W, H, rles.items())
        ctx.artifact(str(path), kind="masks")
        objects.append(
            {
                "objId": obj,
                "path": str(path),
                "box": list(req.boxes[obj]) if obj in req.boxes else None,
                "nPoints": len(req.points.get(obj, [])),
                "framesPresent": st.n_present,
                "framesAbsent": st.n_absent,
                "fileBytes": st.file_bytes,
            }
        )

    previews = []
    for k in sorted(col.preview_rgb):
        img = preview.overlay(
            col.preview_rgb[k], col.preview_masks.get(k, {}), boxes=req.boxes if k == req.anchor else None,
            title=f"k={k}  t={frames.seconds(k):.3f}s" + ("  (anchor)" if k == req.anchor else ""),
        )
        previews.append(preview.save_png(out_dir / f"preview_k{k}.png", img))
        ctx.artifact(previews[-1], kind="preview")

    return {
        "video": video,
        "fingerprint": fp,
        "outDir": str(out_dir),
        "frames": {"k0": req.k0, "k1": req.k1, "anchor": req.anchor, "direction": req.direction, "n": total + 1},
        "frameSize": [W, H],
        "model": {
            "id": loaded.model_id,
            "variant": loaded.variant,
            "loadSeconds": round(loaded.load_seconds, 3),
            "loadSecondsThisCall": round(model_load_s, 3),
            "hfCacheBytes": hf_cache_size_bytes(loaded.model_id),
            "preprocessOnDevice": loaded.preprocess_on_device,
        },
        "timing": {
            "promptSeconds": round(stats.prompt_seconds, 3),
            "propagateModelSeconds": round(stats.propagate_seconds, 3),
            "propagateWallSeconds": round(propagate_wall_s, 3),
            "sPerFrameModel": round(stats.s_per_frame, 4),
            "sPerFrameWall": round(propagate_wall_s / total, 4) if total else 0.0,
            "framesPropagated": stats.propagated_frames,
        },
        "gpu": {"maxMemoryAllocatedMB": cuda_max_memory_mb()},
        "objects": objects,
        "previews": previews,
    }


def _pick_previews(req: SegRequest, n: int) -> set[int]:
    if n <= 0:
        return set()
    ks = {req.anchor}
    span = list(range(req.k0, req.k1)) if req.direction == "both" else (
        list(range(req.anchor, req.k1)) if req.direction == "fwd" else list(range(req.k0, req.anchor + 1))
    )
    if n > 1 and len(span) > 1:
        for i in range(n):
            ks.add(span[round(i * (len(span) - 1) / (n - 1))])
    return ks
