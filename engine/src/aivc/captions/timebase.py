"""ASR 時間（秒）→ proxy 幀號（整數），以及幀號 → 字幕檔毫秒（研究規格 §5.3 A）。

為什麼不直接存毫秒：App 的時間模型是「整數 CFR proxy 幀 + 有理數 fps」（media/cfr.py）。來源是 VFR，
proxy 第 k 幀在成品時間軸上就是 k·den/num 秒；字幕用幀號存，拖曳、分割、燒錄都不會因浮點毫秒漂移。

    tProxy = tAsr + offsetS                       # offsetS = audioStartS − fileStartS（+ --range 起點）
    f(t)   = floor(t·num/den + 0.5)               # 最近的幀邊界
    word   = [f(s), max(f(s)+1, f(e)))            # 每個詞至少 1 幀
    ms(k)  = round(k·1000·den/num)                # 30000/1001 fps 時 k=1799 → 60027 → 00:01:00,027

fileStartS = min(各串流起點)：ffmpeg 讀輸入檔時會把整個檔案的時間戳減掉這個值，所以成品裡的聲音
是在 (T − fileStartS) 被聽到；proxy 第 0 幀也在成品時間 0。
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from fractions import Fraction
from typing import Any


def frame_of(t_s: float, fps_num: int, fps_den: int) -> int:
    return int(math.floor(t_s * fps_num / fps_den + 0.5))


def frame_to_ms(k: int, fps_num: int, fps_den: int) -> int:
    """整數運算的四捨五入（避免 59999.5 之類的浮點邊界）。"""
    num = 2 * int(k) * 1000 * int(fps_den) + int(fps_num)
    return num // (2 * int(fps_num))


def ms_to_frames(ms: float, fps_num: int, fps_den: int) -> int:
    """時長（毫秒）→ 幀數（四捨五入；833 ms @24 fps = 20 幀 = Netflix 最短 20 幀）。"""
    return int(math.floor(ms * fps_num / (fps_den * 1000.0) + 0.5))


def frame_to_s(k: float, fps_num: int, fps_den: int) -> float:
    return float(k) * fps_den / fps_num


@dataclass(frozen=True)
class TimeMap:
    fps_num: int
    fps_den: int
    n_frames: int
    offset_s: float = 0.0

    @classmethod
    def from_cfr(cls, cfr: Any, offset_s: float = 0.0) -> "TimeMap":
        return cls(int(cfr.fps_num), int(cfr.fps_den), int(cfr.n_frames), float(offset_s))

    @property
    def fps(self) -> Fraction:
        return Fraction(self.fps_num, self.fps_den)

    def proxy_s(self, t_asr: float) -> float:
        return float(t_asr) + self.offset_s

    def frame(self, t_asr: float) -> int:
        """夾在 [0, n_frames]（n_frames 是 exclusive 終點的合法值）。"""
        return min(max(frame_of(self.proxy_s(t_asr), self.fps_num, self.fps_den), 0), self.n_frames)

    def word_frames(self, s: float, e: float) -> tuple[int, int]:
        a = self.frame(s)
        b = max(a + 1, self.frame(e))
        if a >= self.n_frames:  # 影片最後一幀之後的詞：壓在最後一幀
            a = max(0, self.n_frames - 1)
            b = self.n_frames
        return a, min(b, max(self.n_frames, a + 1))

    def ms(self, t_asr: float) -> int:
        return int(round(self.proxy_s(t_asr) * 1000.0))

    def frame_ms(self, k: int) -> int:
        return frame_to_ms(k, self.fps_num, self.fps_den)

    def frames(self, ms: float) -> int:
        return ms_to_frames(ms, self.fps_num, self.fps_den)

    def to_json(self) -> dict[str, Any]:
        return {"fps": {"num": self.fps_num, "den": self.fps_den}, "nFrames": self.n_frames, "offsetS": round(self.offset_s, 6)}
