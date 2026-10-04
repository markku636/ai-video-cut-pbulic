"""專案檔 → 執行期物件（ops render / export-track 與外掛共用的**加法**輔助；不改 schema）。

負責的事只有「找到東西」：影片路徑、快取目錄、solve.v1.json、masks.aivm、track ↔ shot 的關聯、
track.insert 解析成 comp.params.InsertParams。外掛自己的關聯（例：牌局外掛的格位與牌組）在外掛裡。
重 import（av / cv2 / torch）一律放在函式內。
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .. import env
from ..ops import OpError
from . import paths as P
from . import schema as S

if TYPE_CHECKING:
    from ..comp.params import InsertParams
    from ..media.cfr import CfrMap
    from ..media.index import PtsIndex
    from ..media.probe import Probe
    from ..seg.maskfile import MaskFile
    from ..track.state import Solve

_HEX = re.compile(r"^[0-9a-fA-F]{16,64}$")


# ---------------------------------------------------------------- media / cache


def select_media(project: S.ProjectFileV1, media_id: str | None) -> S.MediaV1:
    if not project.media:
        raise OpError("Invalid", "專案檔沒有任何 media", "先跑 aivc detect / run 建立專案")
    if media_id:
        m = project.media_by_id(media_id)
        if m is None:
            raise OpError("Invalid", f"專案裡沒有 media {media_id!r}", f"有的：{[x.id for x in project.media]}")
        return m
    m = project.active_media()
    assert m is not None
    return m


def video_path_of(media: S.MediaV1, project_path: str | os.PathLike[str] | None) -> str:
    """media.path（絕對）→ 相對於專案檔目錄；都不存在擲 Io。"""
    cands = [media.path]
    if project_path is not None and media.path and not os.path.isabs(media.path):
        cands.insert(0, str(Path(project_path).resolve().parent / media.path))
    for c in cands:
        if c and os.path.isfile(c):
            return env.normalize_path(os.path.abspath(c))
    raise OpError("Io", f"找不到影片 {media.path!r}", "專案檔 media.path 指向的檔案不存在（搬過位置？）")


def fingerprint_of(media: S.MediaV1, video: str | None) -> str:
    fp = (media.fingerprint or "").strip().lower()
    if _HEX.match(fp):
        return fp
    if video is None:
        raise OpError("Invalid", "media 沒有指紋且找不到影片可算")
    return P.fingerprint_for(video)


def cache_for(media: S.MediaV1, video: str | None = None) -> P.MediaCache:
    return P.media_cache(fingerprint_of(media, video))


def solve_path(cache: P.MediaCache, track_id: str) -> Path:
    return cache.solve(track_id)


def load_solve(cache: P.MediaCache, track_id: str) -> "Solve | None":
    from ..track.state import Solve

    p = cache.solve(track_id)
    if not p.is_file():
        return None
    try:
        return Solve.read(p)
    except (ValueError, KeyError, OSError) as e:
        raise OpError("Invalid", f"solve 檔壞掉：{p}：{e}", "重跑 aivc track") from e


def open_masks(cache: P.MediaCache, track_id: str) -> "MaskFile | None":
    from ..seg.maskfile import MaskFile, MaskFileError

    p = cache.masks(track_id)
    if not p.is_file():
        return None
    try:
        return MaskFile.open(p)
    except MaskFileError as e:
        raise OpError("Invalid", f"遮罩檔壞掉：{p}：{e}", "重跑 aivc seg") from e


def mask_getter(mf: "MaskFile | None"):
    """`.aivm` → `k → bool 遮罩 | None`：沒有條目 = None（全可見）；**缺席條目 = 全零**（物件不在 → LOST），兩者語意不同。"""
    if mf is None:
        return None
    import numpy as np

    zeros = np.zeros((mf.height, mf.width), dtype=bool)

    def get(k: int):
        m = mf.get(int(k))
        if m is None and mf.has(int(k)):
            return zeros
        return m

    return get


# ---------------------------------------------------------------- track ↔ shot


def shot_of(project: S.ProjectFileV1, media_id: str, track: S.TrackV1) -> S.ShotV1 | None:
    return next((s for s in project.shots.get(media_id, []) if s.id == track.shot_id), None)


def select_tracks(project: S.ProjectFileV1, media_id: str, track_ids: list[str] | None) -> list[S.TrackV1]:
    tracks = list(project.tracks.get(media_id, []))
    if not track_ids:
        return tracks
    by_id = {t.id: t for t in tracks}
    missing = [t for t in track_ids if t not in by_id]
    if missing:
        raise OpError("Invalid", f"專案裡沒有 track {missing}", f"有的：{sorted(by_id)}")
    return [by_id[t] for t in track_ids]


# ---------------------------------------------------------------- insert → InsertParams


def insert_dict_for(track: S.TrackV1, project: S.ProjectFileV1) -> dict[str, Any]:
    """track.insert（None 欄位繼承 insertDefaults）→ comp.params.InsertParams.from_dict 吃的 camelCase dict。"""
    ins = S.resolve_insert(track.insert, project.insert_defaults)
    d: dict[str, Any] = {"macro": ins.macro, "regionPolicy": track.region_policy}
    if ins.opacity is not None:
        d["opacity"] = ins.opacity
    if ins.apply_mix is not None:
        d["applyMix"] = ins.apply_mix
    for key, sub in (("edge", ins.edge), ("occlusion", ins.occlusion), ("motionBlur", ins.motion_blur), ("resample", ins.resample), ("relight", ins.relight), ("grain", ins.grain)):
        if sub is not None:
            d[key] = sub.to_json()
    # extra 裡只放行 InsertParams 認得的別名（holdBelowConf）；其餘 TS 專用欄位不往合成器丟
    hb = ins.extra.get("holdBelowConf", ins.extra.get("holdBelow"))
    if isinstance(hb, (int, float)):
        d["holdBelowConf"] = float(hb)
    # A4：`smoothing`（coarseFromMask／fadeFrames）群組 TS schema 還沒有，專案檔裡以未知鍵保留在 extra；
    # 外掛的參數群組（hooks.ParamGroup，forward=True）同樣走 extra。是物件就原樣交給 InsertParams（它會驗證鍵名與範圍）。
    from .. import hooks

    for key in ("smoothing", *(g.json_key for g in hooks.param_groups() if g.forward)):
        v = ins.extra.get(key)
        if isinstance(v, dict) and v:
            d[key] = dict(v)
    return d


def insert_params_for(track: S.TrackV1, project: S.ProjectFileV1) -> "InsertParams":
    from ..comp.params import InsertParams

    try:
        return InsertParams.from_dict(insert_dict_for(track, project))
    except ValueError as e:
        raise OpError("Invalid", f"track {track.id} 的 insert 參數不合法：{e}") from e


# ---------------------------------------------------------------- 尺寸 / fps


def frame_size_of(media: S.MediaV1, probe: "Probe | None" = None) -> tuple[int, int]:
    """(width, height)：media.proxy → media.probe（Rust MediaProbe 兩種形狀）→ Probe。"""
    if media.proxy is not None and media.proxy.width > 0 and media.proxy.height > 0:
        return int(media.proxy.width), int(media.proxy.height)
    pr = media.probe or {}
    v = pr.get("video") if isinstance(pr.get("video"), dict) else pr
    if isinstance(v, dict) and v.get("width") and v.get("height"):
        return int(v["width"]), int(v["height"])
    if probe is not None:
        return int(probe.width), int(probe.height)
    raise OpError("Invalid", f"media {media.id} 沒有尺寸資訊", "先跑 aivc probe / proxy")


def fps_of(media: S.MediaV1, probe: "Probe | None" = None) -> tuple[int, int]:
    if media.proxy is not None:
        return int(media.proxy.fps.num), int(media.proxy.fps.den)
    if probe is not None:
        return int(probe.fps_num), int(probe.fps_den)
    return 30, 1


# ---------------------------------------------------------------- 一次打開全部


@dataclass
class MediaContext:
    project: S.ProjectFileV1
    project_path: Path
    media: S.MediaV1
    video: str
    cache: P.MediaCache
    probe: "Probe"
    index: "PtsIndex"
    cfr: "CfrMap"
    warnings: list[str]

    @property
    def media_id(self) -> str:
        return self.media.id

    @property
    def size(self) -> tuple[int, int]:
        return int(self.probe.width), int(self.probe.height)

    @property
    def fps(self) -> tuple[int, int]:
        return int(self.cfr.fps_num), int(self.cfr.fps_den)

    @property
    def n_frames(self) -> int:
        return int(self.cfr.n_frames)

    def tracks(self) -> list[S.TrackV1]:
        return list(self.project.tracks.get(self.media_id, []))

    def shots(self) -> list[S.ShotV1]:
        return list(self.project.shots.get(self.media_id, []))

    def save(self) -> Path:
        return S.save(self.project, self.project_path)


def open_media_context(project_path: str | os.PathLike[str], media_id: str | None, ctx: Any) -> MediaContext:
    """讀專案 → 找影片 → probe（快取）→ index/cfr（快取）→ MediaContext。"""
    from ..ops.media import ensure_index, open_media

    r = S.load(project_path)
    for w in r.warnings:
        ctx.log("warn", f"專案檔：{w}")
    media = select_media(r.project, media_id)
    video = video_path_of(media, project_path)
    mc, pr = open_media(video, ctx)
    want_fps = (media.proxy.fps.num, media.proxy.fps.den) if media.proxy is not None else None
    idx, cfr, _ = ensure_index(video, mc, pr, ctx, fps=want_fps)
    if media.proxy is not None and media.proxy.frames != cfr.n_frames:
        ctx.log("warn", f"專案 proxy.frames={media.proxy.frames} 但索引算出 {cfr.n_frames} 幀；以索引為準")
    if not media.fingerprint:
        media.fingerprint = mc.fingerprint
    cache = P.media_cache(mc.fingerprint)
    return MediaContext(r.project, Path(project_path).resolve(), media, video, cache, pr, idx, cfr, list(r.warnings))
