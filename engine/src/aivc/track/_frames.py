"""PyAV 幀讀取（暫代 media.source；整合時換掉）。

- 幀號 k = **來源解碼順序**索引（不是 CFR proxy 幀號；media 模組接手後由 CfrMap 對應）。
- 索引先 demux 一趟（不解碼）記每個封包的 pts 與關鍵幀；取幀時 seek 到 ≤ 目標的關鍵幀再解到目標，
  **以 pts 比對而不是數幀**（計畫：never trust seek() alone）。
- 範例只有 18 個關鍵幀（GOP ~100 幀），反向掃描若逐幀 seek 會慢 100×，所以快取容量 ≥ 最長 GOP，
  一次 miss 就把整段 GOP 解進快取，反向 pass 之後全部命中。
"""
from __future__ import annotations

from collections import OrderedDict
from pathlib import Path

import numpy as np


class VideoFrames:
    def __init__(self, path: str | Path, cache_frames: int | None = None) -> None:
        import av

        self.path = str(path)
        self._c = av.open(self.path)
        self._s = self._c.streams.video[0]
        self._s.thread_type = "AUTO"
        self.time_base = float(self._s.time_base) if self._s.time_base else 0.0
        pts: list[int] = []
        keys: list[bool] = []
        for pkt in self._c.demux(self._s):
            if pkt.pts is None:
                continue
            pts.append(int(pkt.pts))
            keys.append(bool(pkt.is_keyframe))
        order = np.argsort(np.asarray(pts, dtype=np.int64), kind="stable")
        self._pts = [pts[i] for i in order]
        self._key = [keys[i] for i in order]
        self._k_of_pts = {p: i for i, p in enumerate(self._pts)}
        self.n = len(self._pts)
        cc = self._s.codec_context
        self.width = int(cc.width)
        self.height = int(cc.height)
        gop = 1
        last = 0
        for i, kf in enumerate(self._key):
            if kf:
                gop = max(gop, i - last)
                last = i
        gop = max(gop, self.n - last)
        self.max_gop = gop
        self._cap = int(cache_frames) if cache_frames else min(320, max(64, gop + 8))
        self._cache: OrderedDict[int, np.ndarray] = OrderedDict()
        self._iter = None
        self._next_k: int | None = None
        self._c.seek(0)

    def __len__(self) -> int:
        return self.n

    def time_of(self, k: int) -> float:
        return self._pts[k] * self.time_base

    def index_at_time(self, t: float) -> int:
        """最後一個 pts ≤ t 的幀號。"""
        target = t / self.time_base if self.time_base else 0
        import bisect

        i = bisect.bisect_right(self._pts, target) - 1
        return max(0, min(self.n - 1, i))

    def close(self) -> None:
        try:
            self._c.close()
        except Exception:
            pass

    # ---- 取幀 ----
    def get(self, k: int) -> np.ndarray:
        k = int(k)
        if not (0 <= k < self.n):
            raise IndexError(f"幀 {k} 超出 [0,{self.n})")
        hit = self._cache.get(k)
        if hit is not None:
            self._cache.move_to_end(k)
            return hit
        if self._iter is None or self._next_k is None or k < self._next_k or k - self._next_k > self.max_gop:
            self._seek_to(k)
        for frame in self._iter:  # type: ignore[union-attr]
            kk = self._k_of_pts.get(int(frame.pts)) if frame.pts is not None else None
            if kk is None:
                continue
            arr = frame.to_ndarray(format="rgb24")
            self._put(kk, arr)
            self._next_k = kk + 1
            if kk == k:
                return arr
            if kk > k:
                break
        # 解碼器沒吐出目標 pts（罕見：隱藏幀）→ 退回最近的已解幀
        near = min(self._cache, key=lambda c: abs(c - k)) if self._cache else None
        if near is None:
            raise RuntimeError(f"解不到幀 {k}")
        return self._cache[near]

    def _seek_to(self, k: int) -> None:
        kk = k
        while kk > 0 and not self._key[kk]:
            kk -= 1
        self._c.seek(self._pts[kk], stream=self._s, backward=True, any_frame=False)
        self._iter = self._c.decode(self._s)
        self._next_k = None

    def _put(self, k: int, arr: np.ndarray) -> None:
        self._cache[k] = arr
        self._cache.move_to_end(k)
        while len(self._cache) > self._cap:
            self._cache.popitem(last=False)

    __call__ = get
