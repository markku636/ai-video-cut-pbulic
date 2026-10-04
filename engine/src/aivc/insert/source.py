"""`ReplaceInsertSource`：平面 track 的 `replace` → 核心通用合成器（ops/render 的插入來源介面，與外掛同一套）。

- claim：track 不是 object、有 replace → 讀素材（圖片讀一次；影片只做 probe／索引，第一次要幀才開解碼器）。
  素材在同一次 build_plan（含序列渲染的每支媒體）共用（session.cache，鍵＝正規化路徑＋種類）。
  檔案不在／讀不了 → InsertSkip（計畫 JSON 的 skipped 寫原因），不擲錯：一條壞掉的取代不該擋住整支輸出。
- build：插入參數照 track.insert／insertDefaults（光影、動態模糊、遮擋、顆粒都是核心的那一套）；paperRatio（外掛的空白牌
  比值合成）一律關掉——那是給白紙牌的，套在任意圖片上會把整張圖當墨色比值乘上去。
- job：`ReplaceTrackJob.frame_face` 每一幀換成素材那一幀的模板（影片）；loop=stop 超出素材的幀在 setup_jobs 就從
  job.frames 拿掉（計畫的合成幀數照實算、渲染時那幾幀原樣放行）。
"""
from __future__ import annotations

import os
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from ..ops.render import FrameFace, InsertSkip, InsertSpec, TrackJob, resolve_shutter_auto
from . import media as RM

_MEDIA = "replace.media"


@dataclass
class ReplaceBinding:
    """InsertSpec.slot：計畫 JSON 的 "slot" 取 .name；job 透過它拿每一幀的模板。"""

    name: str
    kind: str
    path: str
    fit: str
    offset: int
    loop: str
    media: Any  # RM.ReplaceImage | RM.ReplaceVideo
    origin: int  # 鏡頭第一幀（offsetFrames 從這裡算）
    timeline_fps: tuple[int, int]
    template_wh: tuple[int, int]

    def source_index(self, k: int) -> int | None:
        if self.kind == "image":
            return 0
        return RM.source_index(
            k, origin=self.origin, offset=self.offset, timeline_fps=self.timeline_fps, source_fps=self.media.fps, n_source=self.media.n_frames, loop=self.loop,
        )

    def template_at(self, k: int) -> RM.ReplaceTemplate | None:
        s = self.source_index(k)
        return None if s is None else self.media.template(s, self.template_wh, self.fit)

    def to_json(self) -> dict[str, Any]:
        return {
            "kind": self.kind, "path": self.path, "fit": self.fit, "offsetFrames": self.offset, "loop": self.loop,
            "templateSize": list(self.template_wh), "source": self.media.to_json(),
        }


@dataclass
class ReplaceTrackJob(TrackJob):
    """核心 TrackJob＋取代素材：每一幀印素材對應的那一幀（圖片每一幀都一樣）。"""

    stopped: int = 0  # loop=stop：鏡頭內因為素材已經播完／還沒開始而不印的幀

    def ext_json(self) -> dict[str, Any]:
        return {"replace": {**self.slot.to_json(), "stopped": self.stopped}}

    def frame_face(self, k: int, dec: Any) -> FrameFace:
        tmpl = self.slot.template_at(k)
        if tmpl is None:  # setup_jobs 已經拿掉這種幀；保險：印第一張（不會發生）
            tmpl = self.tmpl_new
        return FrameFace(tmpl, tmpl.paper if isinstance(tmpl, RM.ReplaceTemplate) else self.paper, "card", None)

    def close(self) -> None:
        self.slot.media.close()


class ReplaceInsertSource:
    name = "replace"

    def _media(self, mctx: Any, rp: Any, session: Any, ctx: Any) -> Any:
        path = RM.resolve_path(rp.path, getattr(mctx, "project_path", None))
        key = (_MEDIA, os.path.normcase(path), rp.kind)
        hit = session.cache.get(key)
        if hit is not None:
            return hit
        if not os.path.isfile(path):
            out: Any = InsertSkip(f"replace 的{'圖片' if rp.kind == 'image' else '影片'}不存在：{path}")
        else:
            try:
                out = RM.open_media(rp.kind, path, ctx)
            except Exception as e:  # noqa: BLE001  讀不了／解不開：這條 track 跳過、原因進計畫
                if type(e).__name__ == "Canceled":
                    raise
                out = InsertSkip(f"replace 的{'圖片' if rp.kind == 'image' else '影片'}讀不了：{path}（{e}）")
            else:
                if rp.kind == "video" and not out.n_frames:
                    out = InsertSkip(f"replace 的影片沒有任何幀：{path}")
        session.cache[key] = out
        return out

    def claim(self, mctx: Any, track: Any, session: Any) -> Any:
        rp = getattr(track, "replace", None)
        if rp is None or getattr(track, "is_object", False):
            return None
        ctx = getattr(session, "ctx", None)
        media = self._media(mctx, rp, session, ctx if ctx is not None else _NullCtx())
        if isinstance(media, InsertSkip):
            return media
        return (rp, media)

    def describe(self, project: Any, media_id: str, track: Any) -> dict[str, Any] | None:
        rp = getattr(track, "replace", None)
        if rp is None or getattr(track, "is_object", False):
            return None
        return {"slot": track.label or track.id, "replace": rp.kind, "path": Path(rp.path).name}

    def build(self, mctx: Any, ctx: Any, t: Any, shot: Any, solve: Any, claim: Any, session: Any) -> InsertSpec:
        from ..project import resolve as R

        rp, media = claim
        params = resolve_shutter_auto(R.insert_params_for(t, mctx.project), None, ctx, t.id)
        pr = params.group("paper_ratio")
        if pr is not None and getattr(pr, "enabled", False):
            params = replace(params, paper_ratio=replace(pr, enabled=False))
        wh = RM.template_size(tuple(solve.template_wh))
        binding = ReplaceBinding(
            name=t.label or t.id, kind=rp.kind, path=media.path, fit=rp.fit, offset=rp.offset_frames, loop=rp.loop, media=media,
            origin=int(shot.start_frame), timeline_fps=tuple(mctx.fps), template_wh=wh,
        )
        # 計畫階段不解碼影片：tmpl_new 用 fit 之後的覆蓋範圍（逐幀的內容在 frame_face 才解）
        first = media.placeholder(wh, rp.fit)
        return InsertSpec(
            slot=binding, params=params, target="card", target_code=Path(media.path).name, original=None, rotation=0,
            tmpl_new=first, tmpl_orig=None, template_wh=wh, job_cls=ReplaceTrackJob,
        )

    def setup_jobs(self, jobs: list[Any], mctx: Any, ctx: Any, session: Any) -> None:
        for j in jobs:
            if j.slot.kind != "video" or j.slot.loop != "stop":
                continue
            keep = {k for k in j.frames if j.slot.source_index(k) is not None}
            j.stopped = len(j.frames) - len(keep)
            j.frames = keep


class _NullCtx:
    def log(self, *_a: Any, **_k: Any) -> None:
        pass

    def progress(self, *_a: Any, **_k: Any) -> None:
        pass

    def check_cancel(self) -> None:
        pass

    def artifact(self, *_a: Any, **_k: Any) -> None:
        pass


SOURCE = ReplaceInsertSource()
