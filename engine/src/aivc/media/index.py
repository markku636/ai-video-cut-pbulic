"""PTS 索引（計畫 §5.1）：匯入時完整解碼一趟，記下每幀的 pts(ms) 與是否關鍵幀。

為什麼要完整解碼：範例 WebM 沒有 duration / nb_frames 標頭、只有 18 個關鍵幀、VFR 有 1.2 s 斷層；
容器層 index 不可信，只有「真的解出來的幀」算數。依 pts 排序（h264 B-frame 解碼輸出順序本來就對，
排序是保險）。1280×720 VP9 在 CPU 解約 600–700 fps → 60 s 片 ≈ 3 s。

檔案：`index.v1.json` = {version:1, fps:{num,den}, n, pts_ms:[…], key:[…], time_base:{num,den}, cfr:{…}}
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, Sequence

from .cache import read_json, write_json


class NoopCtx:
    """沒有 Ctx 時（函式庫呼叫、測試）用的空實作。"""

    def progress(self, stage: str, done: int, total: int, **extra: Any) -> None:
        pass

    def log(self, level: str, message: str) -> None:
        pass

    def check_cancel(self) -> None:
        pass

    def artifact(self, path: str, kind: str = "") -> None:
        pass


@dataclass
class PtsIndex:
    fps_num: int
    fps_den: int
    pts_ms: list[float]  # 依 pts 排序（= 顯示順序）；src_idx 就是這個 list 的下標
    key: list[bool]
    time_base_num: int = 1
    time_base_den: int = 1000

    @property
    def n(self) -> int:
        return len(self.pts_ms)

    @property
    def fps(self) -> Fraction:
        return Fraction(self.fps_num, self.fps_den)

    @property
    def time_base(self) -> Fraction:
        return Fraction(self.time_base_num, self.time_base_den)

    def pts_ticks(self, src_idx: int) -> int:
        """pts(ms) 轉回 stream time_base 的整數刻度（seek 用）。"""
        return int(round(self.pts_ms[src_idx] * self.time_base_den / (1000 * self.time_base_num)))

    def keyframe_at_or_before(self, src_idx: int) -> int:
        for i in range(src_idx, -1, -1):
            if self.key[i]:
                return i
        return 0

    def gaps(self, min_ms: float = 40.0) -> list[dict[str, float | int]]:
        """相鄰幀間隔 ≥ min_ms 的位置（VFR 診斷；範例：idx 1 有 1200 ms、idx 116 有 49 ms）。"""
        out: list[dict[str, float | int]] = []
        for i in range(1, self.n):
            d = self.pts_ms[i] - self.pts_ms[i - 1]
            if d >= min_ms:
                out.append({"src": i - 1, "pts_ms": self.pts_ms[i - 1], "gap_ms": round(d, 3)})
        return out

    # ---- 序列化 ----
    def to_json(self) -> dict[str, Any]:
        return {
            "version": 1,
            "fps": {"num": self.fps_num, "den": self.fps_den},
            "n": self.n,
            "pts_ms": [_num(x) for x in self.pts_ms],
            "key": self.key,
            "time_base": {"num": self.time_base_num, "den": self.time_base_den},
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> "PtsIndex":
        if d.get("version") != 1:
            raise ValueError(f"index 版本不支援：{d.get('version')}")
        tb = d.get("time_base") or {"num": 1, "den": 1000}
        idx = cls(
            int(d["fps"]["num"]),
            int(d["fps"]["den"]),
            [float(x) for x in d["pts_ms"]],
            [bool(x) for x in d["key"]],
            int(tb["num"]),
            int(tb["den"]),
        )
        if idx.n != int(d.get("n", idx.n)) or len(idx.key) != idx.n:
            raise ValueError("index 長度不一致")
        return idx

    @classmethod
    def from_decoded(
        cls,
        pts_ms: Sequence[float],
        key: Sequence[bool],
        fps: tuple[int, int],
        time_base: tuple[int, int] = (1, 1000),
    ) -> "PtsIndex":
        """從（可能亂序的）解碼輸出建索引：依 pts 穩定排序。"""
        if len(pts_ms) != len(key):
            raise ValueError("pts 與 key 長度不同")
        order = sorted(range(len(pts_ms)), key=lambda i: pts_ms[i])
        return cls(
            int(fps[0]),
            int(fps[1]),
            [float(pts_ms[i]) for i in order],
            [bool(key[i]) for i in order],
            int(time_base[0]),
            int(time_base[1]),
        )


def _num(x: float) -> float | int:
    return int(x) if float(x).is_integer() else x


def stream_fps(stream: Any) -> Fraction:
    """fps 取 r_frame_rate（PyAV base_rate）→ guessed → average → 30。範例：30/1，avg 是 None。"""
    for cand in (stream.base_rate, stream.guessed_rate, stream.average_rate):
        if cand:
            return Fraction(cand)
    return Fraction(30, 1)


def build_index(
    path: str | os.PathLike[str],
    ctx: Any | None = None,
    fps: tuple[int, int] | None = None,
    progress_every: int = 30,
) -> PtsIndex:
    """完整解碼一趟建 PtsIndex。fps 預設取 r_frame_rate，可覆寫（--fps）。"""
    import av  # 重 import 放函式內

    ctx = ctx or NoopCtx()
    pts_ms: list[float] = []
    key: list[bool] = []
    with av.open(os.fspath(path)) as c:
        v = c.streams.video[0]
        v.thread_type = "AUTO"  # 索引這趟只看 pts，不在意解碼延遲 → 多執行緒
        tb = Fraction(v.time_base)
        rate = Fraction(*fps) if fps else stream_fps(v)
        # 沒有 nb_frames 標頭時 total 只能估：duration×fps；再不行就用「目前已解的數量」
        est = 0
        if v.duration:
            est = int(v.duration * tb * rate) + 1
        elif c.duration:
            est = int(Fraction(c.duration, 1_000_000) * rate) + 1
        n = 0
        for frame in c.decode(v):
            if frame.pts is None:  # 沒 pts 的幀（罕見）：用 dts 兜，再不行就當上一幀 +1 tick
                p = frame.dts if frame.dts is not None else (int(Fraction(pts_ms[-1]) / 1000 / tb) + 1 if pts_ms else 0)
            else:
                p = frame.pts
            pts_ms.append(float(Fraction(p) * tb * 1000))
            key.append(bool(frame.key_frame))
            n += 1
            if n % progress_every == 0:
                ctx.check_cancel()
                ctx.progress("index", n, max(est, n))
        ctx.progress("index", n, n)
    if not pts_ms:
        raise ValueError(f"解不出任何影像幀：{path}")
    return PtsIndex.from_decoded(pts_ms, key, (rate.numerator, rate.denominator), (tb.numerator, tb.denominator))


def save_index(path: Path, index: PtsIndex, cfr: Any | None = None) -> Path:
    d = index.to_json()
    if cfr is not None:
        d["cfr"] = cfr.to_json()
    return write_json(path, d)


def load_index(path: Path) -> tuple[PtsIndex, dict[str, Any] | None] | None:
    """回 (PtsIndex, cfr json 或 None)；檔案缺／壞回 None（呼叫端重建）。"""
    d = read_json(path)
    if not d:
        return None
    try:
        return PtsIndex.from_json(d), d.get("cfr")
    except (KeyError, ValueError, TypeError):
        return None
