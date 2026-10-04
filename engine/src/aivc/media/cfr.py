"""VFR → CFR 對應（計畫 §5.1，純函式、無 numpy）。

    t0 = pts[0]
    N  = round((pts[-1] - t0) * fps) + 1                  # proxy 幀數
    map[k] = argmax_i { pts[i] <= t0 + (k + 0.5) / fps }   # 第 k 個 proxy 幀顯示哪個來源幀

也就是「時刻 (k+0.5)/fps 時螢幕上正顯示的那一幀」。來源缺幀（1.2 s 斷層）→ 同一來源幀重複多個 k（定格），
與任何播放器現況一致，音訊 `-c:a copy` 不失步；來源多幀擠在一個 slot（抖動）→ 只留最後一幀（丟幀）。
**相等時刻要用 <=，不是 <**：Chrome 錄影的 pts 是整數 ms，取樣時刻每 3 格就落在整數 ms 上，撞點很常見。
實測範例影片：<= 得到 35 個定格、0 丟幀（正確）；改成 < 會變成 583 定格 / 548 丟幀 —— 因為 33 ms 的間隔
剛好比 33.33 的格線短，「剛好到」的那幀若被推到下一格，下一格又同時輪到它的下一幀，它就被跳過了。

runs 儲存 `[[k0, src0, count], …]`：k0..k0+count-1 依序對到 src0..src0+count-1（1:1 段一筆搞定）；
重複幀（map[k]==map[k-1]）會開新的一筆 count=1。範例影片 1762 幀 → N=1797、約 40 筆。
"""
from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Any, Iterable, Sequence


@dataclass(frozen=True)
class CfrMap:
    fps_num: int
    fps_den: int
    n_frames: int  # N（proxy 幀數）
    n_source: int  # 來源幀數（index.n）
    runs: tuple[tuple[int, int, int], ...]  # (k0, src0, count)
    _starts: tuple[int, ...] = field(default=(), repr=False, compare=False)

    # ---- 建構 ----
    @classmethod
    def from_index(cls, pts_ms: Sequence[float], fps: tuple[int, int] | Fraction) -> "CfrMap":
        """pts_ms 必須已排序（PtsIndex 保證）。fps 為 (num, den) 或 Fraction。"""
        f = Fraction(*fps) if isinstance(fps, tuple) else Fraction(fps)
        if f <= 0:
            raise ValueError(f"fps 必須 > 0：{f}")
        n_src = len(pts_ms)
        if n_src == 0:
            raise ValueError("沒有任何幀")
        t0 = pts_ms[0]
        span_ms = pts_ms[-1] - t0
        # 用 Fraction 算 N，避免 59883*30/1000 這種浮點邊界；pts 本身是 float(ms)
        n = int(round(Fraction(span_ms).limit_denominator(1_000_000) * f / 1000)) + 1 if span_ms > 0 else 1
        period_ms = 1000 / f  # Fraction
        runs: list[tuple[int, int, int]] = []
        i = 0  # 單調遞增的來源游標：pts 與 t_k 都遞增，所以不用每次 bisect
        prev_src = -1
        for k in range(n):
            t_k = t0 + float((k + Fraction(1, 2)) * period_ms)
            while i + 1 < n_src and pts_ms[i + 1] <= t_k:
                i += 1
            src = i
            if runs and src == prev_src + 1 and runs[-1][0] + runs[-1][2] == k:
                k0, s0, c = runs[-1]
                runs[-1] = (k0, s0, c + 1)
            else:
                runs.append((k, src, 1))
            prev_src = src
        return cls.from_runs(f.numerator, f.denominator, n, n_src, runs)

    @classmethod
    def from_runs(cls, fps_num: int, fps_den: int, n_frames: int, n_source: int, runs: Iterable[Sequence[int]]) -> "CfrMap":
        rs = tuple((int(a), int(b), int(c)) for a, b, c in runs)
        # 驗證 runs 連續覆蓋 0..N-1（壞快取要早爆）
        expect = 0
        for k0, _s, c in rs:
            if k0 != expect or c <= 0:
                raise ValueError(f"runs 不連續：在 k={k0}（預期 {expect}）")
            expect += c
        if expect != n_frames:
            raise ValueError(f"runs 覆蓋 {expect} 幀，但 n_frames={n_frames}")
        return cls(fps_num, fps_den, n_frames, n_source, rs, tuple(r[0] for r in rs))

    # ---- 查詢 ----
    def src_index(self, k: int) -> int:
        if not 0 <= k < self.n_frames:
            raise IndexError(f"proxy 幀 {k} 超出 [0, {self.n_frames})")
        r = self.runs[bisect_right(self._starts, k) - 1]
        return r[1] + (k - r[0])

    def first_k_of_src(self, src: int) -> int | None:
        """來源幀 src 第一次出現的 proxy 幀；被丟掉的來源幀回 None。"""
        for k0, s0, c in self.runs:  # runs 很少（重複幀才會開新筆），線性掃就好
            if s0 <= src < s0 + c:
                return k0 + (src - s0)
        return None

    def to_list(self) -> list[int]:
        out: list[int] = []
        for _k0, s0, c in self.runs:
            out.extend(range(s0, s0 + c))
        return out

    @property
    def fps(self) -> Fraction:
        return Fraction(self.fps_num, self.fps_den)

    @property
    def duplicate_count(self) -> int:
        """map[k] == map[k-1] 的 k 數（定格幀數）。"""
        m = self.to_list()
        return sum(1 for a, b in zip(m, m[1:]) if a == b)

    def dropped_sources(self) -> list[int]:
        """沒有任何 proxy 幀顯示的來源幀（抖動擠掉）。"""
        seen = set(self.to_list())
        return [i for i in range(self.n_source) if i not in seen]

    # ---- 序列化 ----
    def to_json(self) -> dict[str, Any]:
        return {
            "version": 1,
            "fps": {"num": self.fps_num, "den": self.fps_den},
            "nFrames": self.n_frames,
            "nSource": self.n_source,
            "runs": [list(r) for r in self.runs],
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> "CfrMap":
        if d.get("version") != 1:
            raise ValueError(f"CfrMap 版本不支援：{d.get('version')}")
        return cls.from_runs(int(d["fps"]["num"]), int(d["fps"]["den"]), int(d["nFrames"]), int(d["nSource"]), d["runs"])
