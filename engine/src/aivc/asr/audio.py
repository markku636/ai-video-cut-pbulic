"""PyAV 直接從來源解音訊 → 16 kHz 單聲道 float32（研究規格 §5.4：webm/Opus 實測可用，不需要先轉檔）。

為什麼要自己解而不是丟檔名給 faster-whisper：
- 要知道**第一個音訊樣本在來源時間軸的位置**（audio start），才能把 ASR 秒對到 proxy 幀；
- `--range K0:K1` 只辨識一段時，直接切 numpy 陣列，不必叫 ffmpeg 產暫存檔。
- VAD 另外跑一次拿語音區間（faster-whisper 內部算的區間不對外公開），「有語音但沒字」的 gaps 靠它。
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import numpy as np

SAMPLE_RATE = 16000


@dataclass
class DecodedAudio:
    samples: np.ndarray  # float32 單聲道 16 kHz
    start_s: float  # 第一個音訊幀在來源時間軸的時間（秒，可能是負的：Opus pre-skip）
    source_rate: int
    channels: int
    codec: str

    @property
    def duration_s(self) -> float:
        return len(self.samples) / SAMPLE_RATE


class NoAudio(Exception):
    pass


# 音訊幀的時間戳比「已輸出樣本數」晚超過這麼多 → 視為斷層、補靜音。
# 40 ms = 兩個 Opus 幀：容忍毫秒級時間基底的捨入抖動與重取樣器的濾波延遲（16 kHz 下約幾個樣本），真正的掉音（數百 ms）一定抓得到。
GAP_TOLERANCE_S = 0.04


def decode_audio(path: str | os.PathLike[str], ctx: Any = None, rate: int = SAMPLE_RATE) -> DecodedAudio:
    """解碼 + 重取樣；**依時間戳補回音訊斷層**。

    為什麼要補：MediaRecorder 錄的 WebM、剪接過的檔常有音訊封包斷層（時間戳跳過一段、中間沒有封包）。
    直接把解出來的樣本接起來，斷層之後的每個字都會提早「斷層長度」秒出現（驗證者指出：字幕整段漂移）。
    做法：每個音訊幀的預期位置 = (pts − 第一幀 pts)·rate；比目前輸出的樣本數多出 GAP_TOLERANCE_S 以上 → 先把重取樣器
    沖乾淨（它內部還壓著幾個樣本，不沖會排在靜音後面）、補零到預期位置、換一個新的重取樣器接著解。
    時間戳往回跳（重疊）不裁切：刪掉聲音比晚幾毫秒更糟。
    """
    import av

    with av.open(os.fspath(path)) as c:
        if not c.streams.audio:
            raise NoAudio("影片沒有音軌")
        st = c.streams.audio[0]
        st.thread_type = "AUTO"

        def new_resampler() -> Any:
            return av.AudioResampler(format="flt", layout="mono", rate=rate)

        resampler = new_resampler()
        chunks: list[np.ndarray] = []
        produced = 0
        start: float | None = None
        total_s = float(c.duration / 1_000_000) if c.duration else 0.0
        done = 0

        def push(frames: Any) -> None:
            nonlocal produced
            for rf in frames:
                a = rf.to_ndarray().reshape(-1).astype(np.float32, copy=False)
                chunks.append(a)
                produced += a.size

        for frame in c.decode(st):
            if frame.pts is not None and frame.time_base is not None:
                t = float(frame.pts * frame.time_base)
                if start is None:
                    start = t
                elif (t - start) * rate - produced > GAP_TOLERANCE_S * rate:
                    push(resampler.resample(None))  # 沖出重取樣器內部緩衝，靜音才會接在斷層前最後一個樣本後面
                    gap = int(round((t - start) * rate)) - produced
                    if gap > 0:
                        chunks.append(np.zeros(gap, np.float32))
                        produced += gap
                    resampler = new_resampler()
            push(resampler.resample(frame))
            done += 1
            if ctx is not None and done % 200 == 0:
                ctx.check_cancel()
                if total_s > 0 and frame.pts is not None and frame.time_base is not None:
                    ctx.progress("asr.load", int(float(frame.pts * frame.time_base) * 1000), int(total_s * 1000), step="audio")
        push(resampler.resample(None))
        samples = np.concatenate(chunks) if chunks else np.zeros(0, np.float32)
        return DecodedAudio(np.ascontiguousarray(samples), float(start or 0.0), int(st.rate or 0), int(st.channels or 0), str(st.codec_context.name))


def speech_regions(samples: np.ndarray, min_silence_ms: int = 500, speech_pad_ms: int = 200, rate: int = SAMPLE_RATE) -> list[tuple[float, float]]:
    """Silero VAD（faster-whisper 內建的 ONNX 版，CPU）→ [(start_s, end_s)]。"""
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    if samples.size == 0:
        return []
    opts = VadOptions(min_silence_duration_ms=int(min_silence_ms), speech_pad_ms=int(speech_pad_ms))
    return [(round(r["start"] / rate, 3), round(r["end"] / rate, 3)) for r in get_speech_timestamps(samples, opts)]
