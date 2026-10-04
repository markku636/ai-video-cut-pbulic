"""文字找物件的兩個後端，對 `ops/find.py` 長得一樣：`prepare()` 載模型、`find(frames, req, ctx)` → `FindRun`。

- `Sam3Finder`：SAM 3 影片模型逐幀偵測＋追蹤（`sam3_hf.Sam3TextTracker`），新出現的物件自動成為新實例。
- `OwlSam2Finder`（後備）：OWLv2 在錨定幀（`--samples` 可多看幾幀）找框 → 每個框一個物件 → SAM 2.1 雙向傳播。

**先 `prepare()` 再開始解碼**：引擎 worker 裡「PyAV 解碼器開著時第一次載模型」會卡死（見 seg/text_box.py 模組說明），
所以 ops 層一定先呼叫 `prepare()`，這裡的 `find()` 才開始取幀。

幀來源只要求 ProxyFrames 的幾個方法（`width/height/get/iter_frames/iter_frames_reversed`），測試可以給假的。
"""
from __future__ import annotations

import time
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from typing import Any, Protocol

import numpy as np

from .instances import InstanceTrack, is_same_object

STAGE = "seg.find"
#: 後備在取樣幀上跑 OWLv2 的那一下另外一個 stage：它夾在兩組傳播之間，用同一個 stage 會打亂傳播的 eta
STAGE_DETECT = "seg.find.detect"
DEFAULT_MAX = 8


class FrameAccess(Protocol):
    width: int
    height: int

    def get(self, k: int) -> np.ndarray: ...

    def iter_frames(self, k0: int, k1: int) -> Iterator[tuple[int, np.ndarray]]: ...

    def iter_frames_reversed(self, k0: int, k1: int) -> Iterator[tuple[int, np.ndarray]]: ...


@dataclass(frozen=True)
class FindRequest:
    k0: int
    k1: int  # 半開
    anchor: int
    phrases: tuple[str, ...]
    max_instances: int = DEFAULT_MAX
    threshold: float | None = None  # None ＝ 後端預設（OWLv2 0.1；SAM 3 用模型設定）
    samples: int = 1  # 後備：總共在幾幀找框（含錨定幀共 samples 幀）
    chunk: int | None = None  # SAM 3 分段長度；None ＝ 後端預設
    min_frames: int | None = None  # None ＝ 後端預設（SAM 3：min(3, 幀數)；後備：1）

    @property
    def n_frames(self) -> int:
        return self.k1 - self.k0


@dataclass
class FindRun:
    instances: list[InstanceTrack]
    overlay_frame: int | None = None  # 後端建議的疊色預覽幀（後備＝錨定幀）
    notes: list[str] = field(default_factory=list)
    dropped: int = 0  # 被 min_frames／去重／上限丟掉的候選數
    stats: dict[str, Any] = field(default_factory=dict)


def _cancellable(it: Iterable[tuple[int, np.ndarray]], ctx: Any) -> Iterator[tuple[int, np.ndarray]]:
    for k, rgb in it:
        ctx.check_cancel()
        yield k, rgb


# ---------------------------------------------------------------------------
# SAM 3
# ---------------------------------------------------------------------------
class Sam3Finder:
    name = "sam3"
    label = "SAM 3"

    def __init__(
        self, *, device: str | None = "auto", chunk: int | None = None, memory_window: int | None = 64,
        loader: Callable[[str | None], Any] | None = None,
    ) -> None:
        from . import sam3_hf

        self.device = device
        self.chunk = sam3_hf.DEFAULT_CHUNK if chunk is None else int(chunk)
        self.memory_window = memory_window
        self._loader = loader or sam3_hf.load_video
        self._loaded: Any = None

    def prepare(self) -> dict[str, Any]:
        self._loaded = self._loader(self.device)  # SegModelError（含 gated 說明）由 ops 層轉成 OpError
        return {"ids": [getattr(self._loaded, "model_id", "facebook/sam3")], "loadSeconds": round(float(getattr(self._loaded, "load_seconds", 0.0)), 3)}

    def find(self, frames: FrameAccess, req: FindRequest, ctx: Any) -> FindRun:
        from . import sam3_hf

        if self._loaded is None:
            self.prepare()
        W, H = int(frames.width), int(frames.height)
        chunk = self.chunk if req.chunk is None else int(req.chunk)
        # --max 也要在追蹤時就生效（不然人群鏡頭每張臉都追、每張都占 GPU 記憶體，最後才砍到 --max 個）
        tracker = sam3_hf.Sam3TextTracker(
            self._loaded, (W, H), chunk=chunk, memory_window=self.memory_window, new_det_threshold=req.threshold,
            max_objects=sam3_hf.object_cap(req.max_instances),
        )
        insts: dict[int, InstanceTrack] = {}
        processed: list[int] = []
        total = max(1, req.n_frames)
        t0 = time.perf_counter()
        ctx.progress(STAGE, 0, total, phase="track")
        for i, tf in enumerate(tracker.run(frames.iter_frames(req.k0, req.k1), list(req.phrases), ctx.check_cancel)):
            processed.append(tf.k)
            for g, m in tf.masks.items():
                inst = insts.get(g)
                if inst is None:
                    inst = InstanceTrack(g, tracker.phrase_of.get(g, ""), W, H, seed_frame=tf.k)
                    insts[g] = inst
                inst.add(tf.k, m, tf.scores.get(g))
            ctx.progress(STAGE, i + 1, total, phase="track", frame=tf.k, instances=len(insts))
        for inst in insts.values():
            inst.mark_absent(processed)
            inst.score = max(inst.frame_scores.values(), default=0.0)
        min_frames = req.min_frames if req.min_frames is not None else min(3, max(1, len(processed)))
        kept = [t for t in insts.values() if t.n_present >= min_frames]
        notes = [
            "SAM 3 串流模式沒有 hotstart 去重（要看未來幀），一閃而過的誤偵測以 min-frames 過濾"
            + (f"：丟掉 {len(insts) - len(kept)} 個少於 {min_frames} 幀的實例" if len(insts) > len(kept) else "")
        ]
        if tracker.stats.chunks > 1:
            notes.append(f"分成 {tracker.stats.chunks} 段處理（每段 {chunk} 幀），段界用遮罩 IoU 接回 {tracker.stats.relinked} 個實例")
        return FindRun(
            kept, overlay_frame=None, notes=notes, dropped=len(insts) - len(kept),
            stats={"frames": tracker.stats.frames, "chunks": tracker.stats.chunks, "relinked": tracker.stats.relinked,
                   "modelSeconds": round(tracker.stats.seconds, 3), "wallSeconds": round(time.perf_counter() - t0, 3)},
        )


# ---------------------------------------------------------------------------
# 後備：OWLv2 框 + SAM 2.1 傳播
# ---------------------------------------------------------------------------
def sample_frames(k0: int, k1: int, anchor: int, samples: int) -> list[int]:
    """錨定幀第一個，其餘在 [k0, k1) 均勻取樣（去重、遞增），**總共最多 samples 幀**（說明寫的就是總數）。

    先在範圍裡均勻取 samples 個點；錨定幀不在格點上時，拿它換掉**離它最近**的那個格點
    （以前是另外加上去，`--anchor 30 --samples 3` 會變成 4 幀、多跑一整段傳播）。"""
    a = int(anchor)
    n = max(1, int(samples))
    span = k1 - k0
    if n <= 1 or span <= 1:
        return [a]
    grid = sorted({k0 + int(round(i * (span - 1) / (n - 1))) for i in range(n)})
    if a not in grid:
        nearest = min(grid, key=lambda k: (abs(k - a), k))
        grid.remove(nearest)
    return [a] + sorted(set(grid) - {a})


class OwlSam2Finder:
    name = "sam2"
    label = "OWLv2 + SAM 2.1"

    def __init__(
        self,
        *,
        device: str | None = "auto",
        owl_variant: str = "base",
        sam_variant: str = "small",
        memory_window: int | None = 64,
        detect: Callable[..., list[Any]] | None = None,
        owl_loader: Callable[[str, str | None], Any] | None = None,
        backend: Any = None,
    ) -> None:
        from . import text_box
        from .sam2_hf import Sam2HfBackend

        self.device = device
        self.owl_variant = owl_variant
        self.sam_variant = sam_variant
        self._detect = detect or text_box.detect
        self._owl_load = owl_loader or text_box.load
        self._backend = backend or Sam2HfBackend(variant=sam_variant, device=device, memory_window=memory_window)
        self._owl: Any = None
        self._sam: Any = None

    def prepare(self) -> dict[str, Any]:
        t0 = time.perf_counter()
        self._owl = self._owl_load(self.owl_variant, self.device)
        self._sam = self._backend.loaded()
        ids = [getattr(self._owl, "model_id", "google/owlv2"), getattr(self._sam, "model_id", "facebook/sam2.1")]
        return {"ids": ids, "loadSeconds": round(time.perf_counter() - t0, 3)}

    def _candidates(self, rgb: np.ndarray, req: FindRequest) -> list[Any]:
        from . import text_box

        thr = text_box.DEFAULT_THRESHOLD if req.threshold is None else float(req.threshold)
        # 多要一些候選：OWLv2 沒有 NMS，前幾名常常是同一個物件的重複框，先拿多一點再去重
        return list(self._detect(rgb, ", ".join(req.phrases), variant=self.owl_variant, device=self.device, threshold=thr, max_boxes=max(64, req.max_instances * 8)))

    def find(self, frames: FrameAccess, req: FindRequest, ctx: Any) -> FindRun:
        if self._sam is None:
            self.prepare()
        W, H = int(frames.width), int(frames.height)
        instances: list[InstanceTrack] = []
        dropped = 0
        notes: list[str] = []
        t0 = time.perf_counter()
        groups = 0
        stats_frames = 0
        next_key = 1
        sample_ks = sample_frames(req.k0, req.k1, req.anchor, req.samples)
        for s in sample_ks:
            ctx.check_cancel()
            if len(instances) >= req.max_instances:
                break
            rgb = frames.get(s)
            ctx.progress(STAGE_DETECT, 0, 1, phase="detect", frame=s)
            cands = sorted(self._candidates(rgb, req), key=lambda c: -float(c.score))
            # 去重只在同一個片語內用「包含」：臉在人的框裡是使用者要的另一個東西（見 instances.is_same_object）
            existing = [(inst.phrase, b) for inst in instances if (b := inst.bbox(s)) is not None]
            chosen: list[Any] = []
            for c in cands:
                box = tuple(float(v) for v in c.box)
                ph = str(c.phrase)
                if any(is_same_object(box, ph, e, eph) for eph, e in existing) or any(is_same_object(box, ph, tuple(x.box), str(x.phrase)) for x in chosen):
                    dropped += 1
                    continue
                if len(instances) + len(chosen) >= req.max_instances:
                    dropped += 1
                    continue
                chosen.append(c)
            if not chosen:
                continue
            group = [InstanceTrack(next_key + i, str(c.phrase), W, H, score=float(c.score), seed_frame=s) for i, c in enumerate(chosen)]
            next_key += len(chosen)
            stats_frames += self._propagate(frames, s, group, [tuple(float(v) for v in c.box) for c in chosen], req, ctx, groups)
            groups += 1
            instances += group
        if not instances:
            notes.append(f"OWLv2 在第 {', '.join(map(str, sample_ks))} 幀沒找到符合「{', '.join(req.phrases)}」的東西（門檻 {req.threshold if req.threshold is not None else '預設 0.1'}）")
        notes.append("後備（OWLv2 + SAM 2.1）只在錨定幀" + ("與取樣幀" if len(sample_ks) > 1 else "") + "找框：那幾幀沒出現的物件找不到；範圍請限制在同一個鏡頭內")
        min_frames = 1 if req.min_frames is None else int(req.min_frames)
        kept = [t for t in instances if t.n_present >= min_frames]
        dropped += len(instances) - len(kept)
        return FindRun(
            kept, overlay_frame=int(req.anchor), notes=notes, dropped=dropped,
            stats={"groups": groups, "sampleFrames": sample_ks, "framesPropagated": stats_frames, "wallSeconds": round(time.perf_counter() - t0, 3)},
        )

    def _propagate(
        self, frames: FrameAccess, s: int, group: list[InstanceTrack], boxes: list[tuple[float, ...]], req: FindRequest, ctx: Any, group_index: int = 0,
    ) -> int:
        """一組（同一幀播種的）實例：在 s 下框 → 往後、往前傳播到範圍邊界。回傳傳播了幾幀。

        進度在各組之間**累加**（第 2 組從 per+1 開始、total＝2·per）：ServeCtx 的 eta 以「這個 stage 第一筆事件」為起點，
        done 每組都從 1 重來的話，第二組的 eta 會把第一組花的時間也算進去。"""
        W, H = int(frames.width), int(frames.height)
        session = self._backend.open_session((W, H))
        local = {i + 1: inst for i, inst in enumerate(group)}
        per = max(1, req.n_frames - 1)
        base = int(group_index) * per
        done = 0
        total = base + per
        try:
            rgb = frames.get(s)
            for oid, (inst, box) in zip(local, zip(group, boxes)):
                ctx.check_cancel()
                inst.add(s, session.add_prompt(s, oid, rgb, box=box))

            def record(fm: Any) -> None:
                nonlocal done
                for oid, m in fm.masks.items():
                    inst = local.get(int(oid))
                    if inst is None:
                        continue
                    inst.add(fm.k, m if fm.scores.get(oid, 0.0) >= 0 else None)
                done += 1
                ctx.progress(STAGE, min(total, base + done), total, phase="propagate", frame=fm.k, seed=s)

            if s + 1 < req.k1:
                for fm in session.propagate_frames(_cancellable(frames.iter_frames(s + 1, req.k1), ctx), "fwd"):
                    record(fm)
            if s > req.k0:
                for fm in session.propagate_frames(_cancellable(frames.iter_frames_reversed(req.k0, s), ctx), "bwd"):
                    record(fm)
        finally:
            session.close()
        for inst in group:
            inst.mark_absent(range(req.k0, req.k1))
        return done
