"""FrameSource：PyAV 解碼的幀來源（順序疊代 + 隨機存取 + LRU），輸出 yuv420p planes。

隨機存取的鐵律：**seek 只能到關鍵幀、然後往前解到目標**。PyAV `seek(any_frame=True)` 落在非關鍵幀會讓
VP9 解碼器直接 InvalidDataError（實測）。範例只有 18 個關鍵幀（~3.4 s 一個）→ 最壞要往前解 ~100 幀（≈0.15 s）。
判斷：目標在游標之後且中間沒有更近的關鍵幀 → 直接往前解；否則 seek 到 ≤ 目標的關鍵幀。
幀身分靠 pts 對回 PtsIndex（不是數解出來第幾幀），所以 seek 落點偏早也不會錯位。
"""
from __future__ import annotations

import os
from bisect import bisect_left
from collections import OrderedDict
from dataclasses import dataclass, field
from fractions import Fraction
from typing import TYPE_CHECKING, Any, Iterator

if TYPE_CHECKING:
    import numpy as np

    from .cfr import CfrMap
    from .index import PtsIndex
    from .probe import Probe

_FORWARD_SLACK = 8  # 關鍵幀就在游標後 ≤8 幀時，直接解過去比 seek 便宜


@dataclass
class Yuv420:
    """一幀 yuv420p：三個 uint8 平面（各自 C-contiguous、與解碼器緩衝脫鉤）。"""

    y: "np.ndarray"
    u: "np.ndarray"
    v: "np.ndarray"
    src_idx: int = -1
    pts_ms: float = 0.0
    key: bool = False
    matrix: str = "bt709"  # 色彩數學用的矩陣（來自 probe.matrix_assumed）
    color_range: str = "tv"
    transfer: str = "bt709"
    meta: dict[str, Any] = field(default_factory=dict)

    @property
    def width(self) -> int:
        return int(self.y.shape[1])

    @property
    def height(self) -> int:
        return int(self.y.shape[0])

    def rgb_gamma(self, chroma_loc: str = "center") -> "np.ndarray":
        from . import color

        return color.yuv_to_rgb_gamma(self.y, self.u, self.v, matrix=self.matrix, full_range=self.color_range == "pc", chroma_loc=chroma_loc)

    def rgb_linear(self, chroma_loc: str = "center") -> "np.ndarray":
        """float32 (H,W,3) 線性全範圍 RGB（合成器的工作空間）。"""
        from . import color

        return color.eotf(self.rgb_gamma(chroma_loc), self.transfer)

    def rgb8(self, chroma_loc: str = "center") -> "np.ndarray":
        """uint8 (H,W,3) gamma 編碼全範圍 RGB（預覽／與 ffmpeg rgb24 對照）。

        center 色度走 color.yuv420_to_rgb8_fast（cv2 色度上採樣＋分條多執行緒，與 numpy 參考路徑逐位元相同）。"""
        from . import color

        if chroma_loc == "center":
            return color.yuv420_to_rgb8_fast(self.y, self.u, self.v, matrix=self.matrix, full_range=self.color_range == "pc")
        return color.rgb_gamma_to_rgb8(self.rgb_gamma(chroma_loc))

    def with_planes(self, y: "np.ndarray", u: "np.ndarray", v: "np.ndarray") -> "Yuv420":
        return Yuv420(y, u, v, self.src_idx, self.pts_ms, self.key, self.matrix, self.color_range, self.transfer, dict(self.meta))

    def resized(self, width: int, height: int) -> "Yuv420":
        """INTER_AREA 縮放三個平面（proxy 超過 max-height 時用；尺寸必為偶數）。"""
        import cv2

        if width == self.width and height == self.height:
            return self
        cw, ch = (width + 1) // 2, (height + 1) // 2
        y = cv2.resize(self.y, (width, height), interpolation=cv2.INTER_AREA)
        u = cv2.resize(self.u, (cw, ch), interpolation=cv2.INTER_AREA)
        v = cv2.resize(self.v, (cw, ch), interpolation=cv2.INTER_AREA)
        return self.with_planes(y, u, v)

    def to_bytes(self) -> bytes:
        """rawvideo yuv420p 位元組（Y 全部、U、V），餵 ffmpeg 管線用。"""
        import numpy as np

        return b"".join(np.ascontiguousarray(p).tobytes() for p in (self.y, self.u, self.v))

    @classmethod
    def from_av_frame(cls, frame: Any, src_idx: int = -1, pts_ms: float = 0.0, **color: Any) -> "Yuv420":
        import numpy as np

        if frame.format.name not in ("yuv420p", "yuvj420p"):
            frame = frame.reformat(format="yuv420p")  # 10-bit / 4:4:4 等：v1 一律降到 yuv420p
        planes = []
        for pl in frame.planes:
            buf = np.frombuffer(pl, dtype=np.uint8)
            rows = buf.reshape(pl.height, pl.line_size)[:, : pl.width]  # 去掉 stride padding
            planes.append(np.ascontiguousarray(rows))  # 複製：脫離 av 的緩衝生命週期
        return cls(planes[0], planes[1], planes[2], src_idx, pts_ms, bool(frame.key_frame), **color)

    @classmethod
    def blank(cls, width: int, height: int, y: int = 16, **color: Any) -> "Yuv420":
        import numpy as np

        return cls(
            np.full((height, width), y, np.uint8),
            np.full(((height + 1) // 2, (width + 1) // 2), 128, np.uint8),
            np.full(((height + 1) // 2, (width + 1) // 2), 128, np.uint8),
            **color,
        )


class FrameSource:
    """開一支影片：`iter_frames()` 順序解、`get(src_idx)` 隨機存取、`get_proxy_frame(k)` 走 CfrMap。CPU 解碼。"""

    def __init__(
        self,
        path: str | os.PathLike[str],
        index: "PtsIndex | None" = None,
        cfr: "CfrMap | None" = None,
        *,
        probe: "Probe | None" = None,
        lru: int = 64,
        ctx: Any | None = None,
    ) -> None:
        self.path = os.fspath(path)
        self._index = index
        self._cfr = cfr
        self._probe = probe
        self._ctx = ctx
        self._lru: OrderedDict[int, Yuv420] = OrderedDict()
        self._lru_size = max(1, lru)
        self._c: Any = None
        self._v: Any = None
        self._gen: Iterator[Any] | None = None
        self._cursor = 0  # 下一個順序解碼會吐出的 src_idx（估計；實際以 pts 對回索引）
        self.stats = {"seeks": 0, "decoded": 0, "lru_hits": 0}

    # ---- 生命週期 ----
    def __enter__(self) -> "FrameSource":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        self._gen = None
        if self._c is not None:
            try:
                self._c.close()
            finally:
                self._c = None
                self._v = None

    def _open(self) -> None:
        if self._c is not None:
            return
        import av

        self._c = av.open(self.path)
        self._v = self._c.streams.video[0]
        self._v.thread_type = "AUTO"

    # ---- 懶載入的中繼資料 ----
    @property
    def probe(self) -> "Probe":
        if self._probe is None:
            from .probe import probe as _probe

            self._probe = _probe(self.path)
        return self._probe

    @property
    def index(self) -> "PtsIndex":
        if self._index is None:
            from .index import build_index

            self._index = build_index(self.path, self._ctx)
        return self._index

    @property
    def cfr(self) -> "CfrMap":
        if self._cfr is None:
            from .cfr import CfrMap

            idx = self.index
            self._cfr = CfrMap.from_index(idx.pts_ms, (idx.fps_num, idx.fps_den))
        return self._cfr

    @property
    def n_frames(self) -> int:
        return self.index.n

    @property
    def fps(self) -> Fraction:
        return self.index.fps

    def _color_kwargs(self) -> dict[str, str]:
        p = self.probe
        return {"matrix": p.matrix_assumed, "color_range": p.range_or_default, "transfer": "bt709"}

    # ---- 解碼 ----
    def _wrap(self, frame: Any) -> Yuv420:
        idx = self.index
        tb = Fraction(frame.time_base) if frame.time_base is not None else idx.time_base
        pts_ms = float(Fraction(frame.pts if frame.pts is not None else frame.dts or 0) * tb * 1000)
        i = bisect_left(idx.pts_ms, pts_ms - 1e-6)
        if i >= idx.n or abs(idx.pts_ms[i] - pts_ms) > 1e-3:
            raise RuntimeError(f"解出的幀 pts={pts_ms} ms 不在索引裡（索引過期？重跑 aivc index --force）")
        fr = Yuv420.from_av_frame(frame, i, pts_ms, **self._color_kwargs())
        self._cursor = i + 1
        self.stats["decoded"] += 1
        self._remember(fr)
        return fr

    def _remember(self, fr: Yuv420) -> None:
        self._lru[fr.src_idx] = fr
        self._lru.move_to_end(fr.src_idx)
        while len(self._lru) > self._lru_size:
            self._lru.popitem(last=False)

    def _next(self) -> Yuv420 | None:
        self._open()
        if self._gen is None:
            self._gen = self._c.decode(self._v)
        try:
            frame = next(self._gen)
        except StopIteration:
            self._gen = None
            return None
        return self._wrap(frame)

    def _seek_to_key(self, key_idx: int) -> None:
        self._open()
        ticks = self.index.pts_ticks(key_idx)
        self._c.seek(ticks, stream=self._v, backward=True, any_frame=False)  # 只落關鍵幀；PyAV 會 flush 解碼器
        self._gen = self._c.decode(self._v)
        self._cursor = key_idx
        self.stats["seeks"] += 1

    def get(self, src_idx: int) -> Yuv420:
        """來源幀 src_idx（顯示順序）。LRU → 往前解 → seek 關鍵幀再往前解。"""
        idx = self.index
        if not 0 <= src_idx < idx.n:
            raise IndexError(f"來源幀 {src_idx} 超出 [0, {idx.n})")
        hit = self._lru.get(src_idx)
        if hit is not None:
            self._lru.move_to_end(src_idx)
            self.stats["lru_hits"] += 1
            return hit
        key_idx = idx.keyframe_at_or_before(src_idx)
        can_forward = self._gen is not None and self._cursor <= src_idx and key_idx <= self._cursor + _FORWARD_SLACK
        if not can_forward:
            self._seek_to_key(key_idx)
        while True:
            fr = self._next()
            if fr is None:
                raise RuntimeError(f"解到檔尾仍沒遇到來源幀 {src_idx}（索引過期？）")
            if fr.src_idx == src_idx:
                return fr
            if fr.src_idx > src_idx:
                # seek 落點比目標晚（不該發生）：退回更早的關鍵幀重來一次
                earlier = idx.keyframe_at_or_before(max(key_idx - 1, 0))
                if earlier == key_idx:
                    raise RuntimeError(f"seek 落在 {fr.src_idx}，晚於目標 {src_idx}，而且已經是第一個關鍵幀")
                self._seek_to_key(earlier)

    def iter_frames(self, start: int = 0, stop: int | None = None) -> Iterator[Yuv420]:
        """順序疊代 [start, stop)；每個來源幀只解一次。"""
        n = self.index.n
        stop = n if stop is None else min(stop, n)
        if start >= stop:
            return
        yield self.get(start)
        for i in range(start + 1, stop):
            yield self.get(i)

    def __iter__(self) -> Iterator[Yuv420]:
        return self.iter_frames()

    def get_proxy_frame(self, k: int) -> Yuv420:
        """proxy 第 k 幀 = 來源第 map[k] 幀（重複幀回同一個物件）。"""
        return self.get(self.cfr.src_index(k))
