"""專案檔的特效（track.effects）→ render 的特效 pass：平面合成之後、字幕燒入之前，每個 proxy 幀一次 `apply_effects`。

## 哪些 track、作用範圍是什麼

| track | 作用範圍（footprint） | 會套用的幀 |
|-------|------------------------|------------|
| object（`kind: "object"`） | `<快取>/tracks/<id>/masks.aivm`（`aivc adopt` 寫的）＋錨點 | 遮罩檔有 present 條目 ∩ `range`（半開；沒有＝不限）∩ `--range` |
| planar（`kind: "planar"`） | 有 masks.aivm 的幀用遮罩；沒有條目的幀用 solve 四角的多邊形 | （遮罩有條目 ∪ solve 有 H）∩ 鏡頭 ∩ `--range` |

物件在某一幀不在（遮罩缺席條目）＝那一幀它的特效不做，計進 `absentFrames`。
特效物件 `{id, enabled, type, ...參數}`：去掉 id／enabled 交給 `aivc.fx.params.parse_effect`（未知鍵報錯）。
不合法的特效在計畫裡標 `invalid` 並寫原因、渲染時跳過那一個；其他特效照做。

## 位元組保證

跟 `aivc fx` 相同（`fx/apply.py`）：特效作用範圍聯集 F 外的 Y 不變、完全沒碰到 F 的 2×2 區塊的色度不變；
沒有任何特效作用的幀原樣放行（同一個物件）。所以無損輸出時，F 外跟「沒有特效的渲染」逐位元相同。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import numpy as np

if TYPE_CHECKING:
    from ..project.resolve import MediaContext


@dataclass
class EffectEntry:
    id: str
    type: str
    enabled: bool
    status: str  # ok | disabled | invalid
    reason: str | None = None
    fx: Any = None  # 解析好的特效（fx.params 的 dataclass）；不是 ok 時 None

    def to_json(self) -> dict[str, Any]:
        d: dict[str, Any] = {"id": self.id, "type": self.type, "enabled": self.enabled, "status": self.status}
        if self.reason:
            d["reason"] = self.reason
        return d


def parse_entries(effects: list[dict[str, Any]] | None, where: str) -> list[EffectEntry]:
    """專案檔的特效陣列 → EffectEntry（逐筆驗；不合法的帶原因）。"""
    from ..fx.overlay import load_sticker
    from ..fx.params import FxError, StickerFx, parse_effect
    from ..project.schema import effect_enabled, effect_params

    out: list[EffectEntry] = []
    for i, e in enumerate(effects or []):
        eid, etype, on = str(e.get("id")), str(e.get("type")), effect_enabled(e)
        if not on:
            out.append(EffectEntry(eid, etype, False, "disabled"))
            continue
        try:
            fx = parse_effect(effect_params(e), f"{where}.effects[{i}]")
            if isinstance(fx, StickerFx):
                load_sticker(fx.image)  # 檔案不在：計畫就講，不要渲染到一半才知道
        except FxError as err:
            out.append(EffectEntry(eid, etype, True, "invalid", str(err)))
            continue
        out.append(EffectEntry(eid, etype, True, "ok", None, fx))
    return out


class _PlanarFootprint:
    """平面 track 的「物件」：有遮罩條目的幀用遮罩，其餘有 H 的幀用 solve 四角多邊形；錨點自己算（不寫快取）。"""

    def __init__(self, mask_file: Any, solve: Any, size: tuple[int, int], frames: set[int]) -> None:
        self.mf = mask_file
        self.solve = solve
        self.W, self.H = size
        self.frames = frames
        self._anchors: Any = None

    def mask(self, k: int) -> np.ndarray | None:
        if self.mf is not None and self.mf.has(int(k)):
            return self.mf.get(int(k))  # 缺席條目 → None（物件不在）
        return quad_mask(self.solve, int(k), (self.W, self.H))

    def _ensure(self) -> Any:
        if self._anchors is None:
            from ..objects.anchors import Anchor, Anchors, measure_full, smooth_anchors

            fr: dict[int, Any] = {}
            for k in sorted(self.frames):
                m = self.mask(k)
                got = None if m is None else measure_full(m)
                if got is None:
                    fr[k] = Anchor(k, True, False)
                    continue
                area, bbox, cen, ang, elong = got
                fr[k] = Anchor(k, True, True, area, bbox, cen, ang, elongation=elong)
            self._anchors = Anchors(self.W, self.H, smooth_anchors(fr))
        return self._anchors

    def frame(self, k: int) -> Any:
        from ..objects.track import ObjectFrame

        an = self._ensure()
        a = an.at(k)
        m = self.mask(k) if a is not None and a.visible else None
        return ObjectFrame(m, a, an.first_visible(), an.at)


def quad_mask(solve: Any, k: int, size: tuple[int, int]) -> np.ndarray | None:
    """solve 第 k 幀的四角多邊形（像素中心落在多邊形內＝在裡面）。沒有 H → None。"""
    import cv2

    from ..geom import homography as hg

    f = solve.frames.get(int(k))
    if f is None or f.H is None:
        return None
    tw, th = solve.template_wh
    q = hg.quad_from_h(f.H, (tw, th))
    if not np.all(np.isfinite(q)):
        return None
    W, H = size
    m = np.zeros((H, W), np.uint8)
    # 邊界座標 → cv2 的像素中心座標（減 0.5），4 位小數的定點
    pts = np.round((np.asarray(q, np.float64) - 0.5) * 16.0).astype(np.int32).reshape(-1, 1, 2)
    cv2.fillPoly(m, [pts], 1, lineType=cv2.LINE_8, shift=4)
    return m.astype(bool)


@dataclass
class FxTrack:
    track_id: str
    kind: str  # object | planar
    entries: list[EffectEntry]
    footprint: str | None = None  # masks | quad | masks+quad
    masks: str | None = None
    range: tuple[int, int] | None = None
    frames: set[int] = field(default_factory=set)
    skipped: str | None = None
    media_id: str | None = None  # 序列渲染才有（frames 仍是整支素材的 k；JSON 的 frames 改報 used_frames）
    used_frames: int | None = None
    source: Any = None  # ObjectTrack | _PlanarFootprint（第一次套用才開）
    opener: Any = None
    applied: int = 0  # 真的有特效作用的幀
    absent_ks: set[int] = field(default_factory=set)  # 範圍內遮罩的缺席條目（被遮住、離開畫面；計畫時就知道）
    absent_runtime: int = 0  # 渲染時才發現物件是空的幀（例：四角整個在畫面外）

    @property
    def absent(self) -> int:
        return len(self.absent_ks) + self.absent_runtime

    @property
    def active(self) -> list[Any]:
        return [e.fx for e in self.entries if e.status == "ok"]

    def object_frame(self, k: int) -> Any:
        if self.source is None:
            self.source = self.opener()
        return self.source.frame(k)

    def to_json(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "trackId": self.track_id,
            "kind": self.kind,
            "footprint": self.footprint,
            "masks": self.masks,
            "range": None if self.range is None else list(self.range),
            "frames": len(self.frames),
            "effects": [e.to_json() for e in self.entries],
            "skipped": self.skipped,
            "applied": self.applied,
            "absentFrames": self.absent,
        }
        if self.media_id is not None:
            d["mediaId"] = self.media_id
            d["frames"] = int(self.used_frames or 0)
        return d


@dataclass
class EffectsPlan:
    """一支媒體（或整個序列）的特效 pass。tracks 依專案裡的 track 順序；同一幀所有 track 的特效一次 apply_effects（只寫回一次）。"""

    tracks: list[FxTrack]
    warnings: list[str] = field(default_factory=list)

    @property
    def usable(self) -> list[FxTrack]:
        return [t for t in self.tracks if t.skipped is None]

    @property
    def n_frames(self) -> int:
        return len(set().union(*(t.frames for t in self.usable))) if self.usable else 0

    def apply(self, frame: Any, k: int, ctx: Any = None) -> Any:
        """一幀；沒有任何特效作用時回原物件（is）。"""
        from .apply import apply_effects

        here = [t for t in self.usable if k in t.frames]
        if not here:
            return frame
        objects = {t.track_id: t.object_frame(k) for t in here}
        pairs = [(t.track_id, tuple(t.active)) for t in here]
        res = apply_effects(frame, k, objects, pairs)
        for t in here:
            o = objects[t.track_id]
            if not o.visible:
                t.absent_runtime += 1
            elif any(key == t.track_id for key, _ty in res.applied):
                t.applied += 1
        for w in res.warnings:
            if w not in self.warnings:
                self.warnings.append(w)
                if ctx is not None:
                    ctx.log("warn", f"特效：{w}")
        return res.frame if res.changed else frame

    def to_json(self) -> list[dict[str, Any]]:
        return [t.to_json() for t in self.tracks]


def build(mctx: "MediaContext", ctx: Any, *, track_ids: list[str] | None, rng: tuple[int, int] | None) -> EffectsPlan | None:
    """一支媒體的特效 pass。專案裡沒有 object track、也沒有任何 track 帶 effects → None（計畫 JSON 不多任何鍵）。"""
    from ..project import resolve as R

    project, media_id = mctx.project, mctx.media_id
    W, H = mctx.size
    N = mctx.n_frames
    shots = {s.id: s for s in mctx.shots()}
    lo_all, hi_all = rng if rng is not None else (0, N)
    out: list[FxTrack] = []
    for t in R.select_tracks(project, media_id, track_ids):
        if not t.is_object and t.effects is None:
            continue
        ft = FxTrack(t.id, "object" if t.is_object else "planar", parse_entries(t.effects, f"track {t.id}"))
        out.append(ft)
        if not t.effects:
            ft.skipped = "沒有特效"
        elif not ft.active:
            n_bad = sum(1 for e in ft.entries if e.status == "invalid")
            ft.skipped = f"沒有可用的特效（{n_bad} 個不合法、{len(ft.entries) - n_bad} 個停用）" if n_bad else "特效全部停用"
        mpath = mctx.cache.masks(t.id)
        mf = None
        if mpath.is_file():
            try:
                mf = R.open_masks(mctx.cache, t.id)
            except Exception as e:  # noqa: BLE001  OpError(Invalid)：壞檔
                ft.skipped = ft.skipped or f"遮罩檔壞掉：{e}"
        if mf is not None and (mf.width, mf.height) != (W, H):
            ft.skipped = ft.skipped or f"遮罩尺寸 {mf.width}x{mf.height} ≠ 影片 {W}x{H}（重跑 aivc find／select 再 adopt）"
            mf = None
        if t.is_object:
            ft.range = t.frame_range
            if mf is None:
                ft.skipped = ft.skipped or f"沒有遮罩 {mpath}（先跑 aivc adopt）"
                continue
            ft.footprint, ft.masks = "masks", str(mpath)
            a, b = t.frame_range if t.frame_range is not None else (0, N)
            a, b = max(a, lo_all), min(b, hi_all, N)
            ft.frames = {k for k in mf.frames_present() if a <= k < b}
            ft.absent_ks = {k for k in mf.frames() if a <= k < b} - ft.frames  # 缺席條目（被遮住、離開畫面）
            ft.opener = (lambda p=str(mpath): _open_object(p))
        else:
            shot = shots.get(t.shot_id)
            if shot is None:
                ft.skipped = ft.skipped or f"shotId {t.shot_id!r} 不存在"
                continue
            solve = R.load_solve(mctx.cache, t.id)
            a, b = max(shot.start_frame, lo_all), min(shot.end_frame, hi_all, N)
            with_h = {k for k, f in solve.frames.items() if f.H is not None} if solve is not None else set()
            have_m = set(mf.frames_present()) if mf is not None else set()
            # 遮罩有條目的幀照遮罩（缺席＝不在）；沒條目的幀用 solve 四角
            no_entry_h = {k for k in with_h if mf is None or not mf.has(k)}
            ft.frames = {k for k in (have_m | no_entry_h) if a <= k < b}
            if mf is not None:
                ft.masks = str(mpath)
                ft.absent_ks = {k for k in mf.frames() if a <= k < b and k not in have_m}
            ft.footprint = "masks+quad" if (have_m and no_entry_h) else ("masks" if have_m else ("quad" if no_entry_h else None))
            if ft.footprint is None:
                ft.skipped = ft.skipped or "沒有遮罩也沒有 solve（先跑 aivc track 或 seg）"
                continue
            ft.opener = (lambda m=mf, s=solve, fr=frozenset(ft.frames): _PlanarFootprint(m, s, (W, H), set(fr)))
        if ft.skipped is None and not ft.frames:
            ft.skipped = "範圍內沒有任何一幀看得到它"
    return EffectsPlan(out) if out else None


def _open_object(path: str) -> Any:
    from ..objects.track import ObjectTrack

    return ObjectTrack.open(path)
