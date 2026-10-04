"""暫用的 PyAV 幀解碼小工具（給 seg CLI 用；整合期換成 media.source.FrameSource，SegSession 協定不受影響）。

幀號 k ＝ **解碼輸出序號**（與計畫 §5.1 PtsIndex 一致）。範例 VP9/WebM 一封包一幀（實測 1762 封包＝1762 幀，
關鍵幀封包序號與解碼序號完全一致），所以先 demux 一遍建 `PacketIndex`（毫秒級），就能
「seek 到 ≤k0 的關鍵幀 → 往前解到 k0」而不必每次從頭解 100 幀。
seek 之後第一幀的 pts 必須等於索引裡那個關鍵幀的 pts，否則視為 seek 不可信、退回從頭解（正確性優先）。
顏色轉換用 swscale 預設（tags unknown → 601），只供分割與預覽，合成器的色彩咽喉在 media/color.py。
"""
from __future__ import annotations

import bisect
from collections.abc import Iterator
from dataclasses import dataclass
from fractions import Fraction
from typing import Any

import numpy as np


@dataclass(frozen=True)
class PacketIndex:
    pts: tuple[int, ...]  # 每幀 pts（stream time_base 單位），解碼序
    keyframes: tuple[int, ...]  # 關鍵幀的幀序號（遞增）
    time_base: Fraction
    width: int
    height: int

    @property
    def n(self) -> int:
        return len(self.pts)

    def seconds(self, k: int) -> float:
        return float(self.pts[k] * self.time_base)

    def keyframe_at_or_before(self, k: int) -> int:
        i = bisect.bisect_right(self.keyframes, k) - 1
        return self.keyframes[i] if i >= 0 else 0

    def nearest(self, seconds: float) -> int:
        """最接近某秒數的幀序號（CLI 用 `--frames` 給秒數時換算）。"""
        target = seconds / self.time_base
        i = bisect.bisect_left(self.pts, target)
        if i <= 0:
            return 0
        if i >= self.n:
            return self.n - 1
        return i if abs(self.pts[i] - target) < abs(self.pts[i - 1] - target) else i - 1


def scan(path: str) -> PacketIndex:
    """只 demux 不解碼：每個影像封包 = 一幀。"""
    import av

    pts: list[int] = []
    keys: list[int] = []
    with av.open(path) as c:
        s = c.streams.video[0]
        tb = Fraction(s.time_base) if s.time_base is not None else Fraction(1, 1000)
        width, height = s.codec_context.width, s.codec_context.height
        for pkt in c.demux(s):
            if pkt.pts is None:  # flush 封包
                continue
            if pkt.is_keyframe:
                keys.append(len(pts))
            pts.append(int(pkt.pts))
    if not pts:
        raise ValueError(f"{path} 沒有影像封包")
    return PacketIndex(tuple(pts), tuple(keys), tb, width, height)


def iter_video_frames(path: str, k0: int, k1: int, index: PacketIndex | None = None) -> Iterator[tuple[int, Any]]:
    """yield (k, av.VideoFrame) for k in [k0, k1)。"""
    import av

    idx = index or scan(path)
    k1 = min(k1, idx.n)
    if k0 < 0 or k0 >= k1:
        return
    kf = idx.keyframe_at_or_before(k0)
    with av.open(path) as c:
        s = c.streams.video[0]
        s.thread_type = "AUTO"
        start = kf
        decoder = None
        if kf > 0:
            c.seek(idx.pts[kf], stream=s, backward=True, any_frame=False)
            decoder = c.decode(s)
            first = next(decoder, None)
            if first is None or first.pts != idx.pts[kf]:
                decoder = None  # seek 落點不符預期 → 從頭解
        if decoder is None:
            c.seek(0, stream=s, backward=True, any_frame=False)
            decoder = c.decode(s)
            first = next(decoder, None)
            start = 0
            if first is None:
                return
        k = start
        frame = first
        while True:
            if k >= k1:
                return
            if k >= k0:
                yield k, frame
            frame = next(decoder, None)
            if frame is None:
                return
            k += 1


def iter_frames(path: str, k0: int, k1: int, index: PacketIndex | None = None) -> Iterator[tuple[int, np.ndarray]]:
    """yield (k, rgb8 ndarray (H, W, 3)) for k in [k0, k1)，遞增。"""
    for k, f in iter_video_frames(path, k0, k1, index):
        yield k, f.to_ndarray(format="rgb24")


def iter_frames_reversed(
    path: str, k0: int, k1: int, index: PacketIndex | None = None, chunk: int = 64
) -> Iterator[tuple[int, np.ndarray]]:
    """yield k1-1, k1-2, …, k0（遞減）。每次向前解一小段再倒著吐，避免整段留在記憶體。"""
    idx = index or scan(path)
    hi = min(k1, idx.n)
    while hi > k0:
        lo = max(k0, hi - chunk)
        buf = list(iter_frames(path, lo, hi, idx))
        for k, rgb in reversed(buf):
            yield k, rgb
        hi = lo


def read_frame(path: str, k: int, index: PacketIndex | None = None) -> np.ndarray:
    for _, rgb in iter_frames(path, k, k + 1, index):
        return rgb
    raise IndexError(f"幀 {k} 超出範圍")
