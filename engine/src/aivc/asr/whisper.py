"""faster-whisper 後端：下載（位元組進度）→ 載入 → 轉錄（含 GPU→CPU 退路）。

量測過的事實（研究規格 §1、§5.4）：
- CUDA 錯誤不在 WhisperModel() 建構時發生，而是第一次 encode；而 transcribe() 會**立刻**做語言偵測 encode，
  片段是惰性產生器 → try 要同時包住 transcribe() 呼叫與整個片段迴圈，錯誤才會在退路範圍內被接到。
- 新 GPU 第一次跑（tiny 首跑 22.6 s、第二次 1.9 s）是 CUDA 為這張卡編 kernel，每台機器一次；UI 要提示「第一次較慢」。
- 同一行程裡 torch cu130 與 CTranslate2（cuBLAS 12）交錯使用實測沒問題；CPU 模式在 torch 已載入時也沒有 OpenMP Error #15。
- 模型只在這一個工作期間駐留（除非 keep_loaded）：sidecar 同時可能要跑 SAM 2.1，VRAM 不能被閒置的 Whisper 佔住。
"""
from __future__ import annotations

import gc
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from ..ops import Canceled, OpError
from . import models as M
from .cuda_dll import ensure_cuda_dll_path

_LOADED: dict[tuple[str, str, str], Any] = {}
_LOCK = threading.Lock()


def import_backend() -> tuple[Any, Any]:
    """先放 cuBLAS 進 PATH 再 import（順序反了 CTranslate2 會先載失敗的 DLL 狀態）。缺套件 → PyEnv。"""
    ensure_cuda_dll_path()
    try:
        import ctranslate2
        import faster_whisper
    except ImportError as e:
        raise OpError("PyEnv", f"缺少語音辨識套件：{e}", "重新安裝引擎依賴（faster-whisper / ctranslate2 在 requirements.lock.txt）") from e
    return ctranslate2, faster_whisper


def cuda_device_count() -> int:
    try:
        ct2, _ = import_backend()
        return int(ct2.get_cuda_device_count())
    except OpError:
        raise
    except Exception:  # noqa: BLE001
        return 0


def _progress_tqdm(ctx: Any) -> type:
    """huggingface_hub snapshot_download 的 tqdm_class：只轉發位元組進度成 `asr.download` 事件（不印任何東西到 stderr）。"""
    from tqdm.auto import tqdm as base

    lock = threading.Lock()

    class _Tqdm(base):  # type: ignore[misc,valid-type]
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            kwargs.pop("name", None)
            kwargs["disable"] = True
            self._aivc_unit = kwargs.get("unit", "it")
            self._aivc_n = float(kwargs.get("initial", 0) or 0)
            super().__init__(*args, **kwargs)

        def update(self, n: float | None = 1) -> bool | None:
            self._aivc_n += float(n or 0)
            if self._aivc_unit == "B" and (self.total or 0) > 0:
                with lock:
                    ctx.progress("asr.download", int(self._aivc_n), int(self.total), unit="bytes")
            return super().update(n)

    return _Tqdm


def model_path(info: M.ModelInfo, ctx: Any, local_only: bool = False) -> str:
    """先試本機快取（離線、不打 HF API）；沒有才下載。下載失敗 → Model 錯誤。"""
    import huggingface_hub

    allow = ["config.json", "preprocessor_config.json", "model.bin", "tokenizer.json", "vocabulary.*"]
    try:
        return huggingface_hub.snapshot_download(info.repo, revision=info.revision, allow_patterns=allow, local_files_only=True)
    except Exception:  # noqa: BLE001
        if local_only:
            raise
    ctx.log("info", f"下載模型 {info.repo}@{(info.revision or 'main')[:8]}（約 {info.disk_mb} MB，只有第一次）")
    try:
        return huggingface_hub.snapshot_download(info.repo, revision=info.revision, allow_patterns=allow, tqdm_class=_progress_tqdm(ctx))
    except Exception as e:  # noqa: BLE001
        raise OpError("Model", f"模型下載失敗：{type(e).__name__}: {e}", "檢查網路或 HF_HOME 磁碟空間；離線環境可先在有網路的機器跑一次") from e


def load(info: M.ModelInfo, device: str, compute_type: str, ctx: Any) -> Any:
    _ct2, fw = import_backend()
    path = model_path(info, ctx)
    key = (path, device, compute_type)
    with _LOCK:
        m = _LOADED.get(key)
        if m is not None:
            return m
    t0 = time.perf_counter()
    ctx.progress("asr.load", 0, 1, model=info.name, device=device, computeType=compute_type)
    m = fw.WhisperModel(path, device=device, compute_type=compute_type)
    ctx.log("info", f"模型載入 {info.name} {device}/{compute_type}：{time.perf_counter() - t0:.2f}s")
    ctx.progress("asr.load", 1, 1, model=info.name, device=device, computeType=compute_type)
    with _LOCK:
        _LOADED[key] = m
    return m


def unload_all() -> int:
    with _LOCK:
        n = len(_LOADED)
        _LOADED.clear()
    gc.collect()
    return n


@dataclass
class RawTranscript:
    segments: list[dict[str, Any]]
    language: str
    language_prob: float
    duration_s: float
    device: str
    compute_type: str
    seconds: float  # 只算轉錄（不含載入），跟研究規格 §1 的 run time 同一個定義
    load_seconds: float = 0.0
    fallback_reason: str | None = None
    attempts: list[dict[str, str]] = field(default_factory=list)


def _segments_to_dicts(seg_iter: Any, duration: float, ctx: Any) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    total_ms = max(1, int(duration * 1000))
    for s in seg_iter:
        ctx.check_cancel()
        out.append(
            {
                "id": int(s.id),
                "start": round(float(s.start), 3),
                "end": round(float(s.end), 3),
                "text": s.text,
                "avg_logprob": round(float(s.avg_logprob), 4),
                "no_speech_prob": round(float(s.no_speech_prob), 4),
                "compression_ratio": round(float(s.compression_ratio), 4),
                "words": [{"start": round(float(w.start), 3), "end": round(float(w.end), 3), "word": w.word, "probability": round(float(w.probability), 4)} for w in (s.words or [])],
            }
        )
        ctx.progress("asr.decode", min(total_ms, int(float(s.end) * 1000)), total_ms)
    ctx.progress("asr.decode", total_ms, total_ms)
    return out


def transcribe(
    audio: np.ndarray,
    info: M.ModelInfo,
    ctx: Any,
    *,
    device: str = "auto",
    compute_type: str | None = None,
    language: str | None = None,
    initial_prompt: str | None = None,
    hotwords: list[str] | None = None,
    beam_size: int = 5,
    vad_min_silence_ms: int = 500,
    speech_pad_ms: int = 200,
) -> RawTranscript:
    cuda_ok = cuda_device_count() > 0
    dev, ct = M.first_attempt(device, compute_type, cuda_ok)
    if (device or "auto") == "cuda" and not cuda_ok:
        raise OpError("Gpu", "指定 --device cuda 但 CTranslate2 看不到任何 CUDA 裝置", "改用 --device auto（會退回 CPU int8）")
    allow_cpu = (device or "auto") != "cuda"
    attempts: list[dict[str, str]] = []
    fallback_reason: str | None = None
    duration = len(audio) / 16000.0
    while True:
        t_load = time.perf_counter()
        try:
            model = load(info, dev, ct, ctx)
            t0 = time.perf_counter()
            segs, tinfo = model.transcribe(
                audio,
                language=language,
                task="transcribe",
                beam_size=int(beam_size),
                word_timestamps=True,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": int(vad_min_silence_ms), "speech_pad_ms": int(speech_pad_ms)},
                condition_on_previous_text=False,
                initial_prompt=initial_prompt or None,
                hotwords=",".join(h for h in (hotwords or []) if h) or None,
                hallucination_silence_threshold=2.0,
            )
            out = _segments_to_dicts(segs, float(tinfo.duration or duration), ctx)
            return RawTranscript(out, str(tinfo.language), float(tinfo.language_probability), float(tinfo.duration or duration), dev, ct, time.perf_counter() - t0, t0 - t_load, fallback_reason, attempts)
        except (Canceled, OpError):
            raise
        except Exception as e:  # noqa: BLE001
            msg = f"{type(e).__name__}: {e}"
            kind = M.classify_error(msg)
            attempts.append({"device": dev, "computeType": ct, "error": msg[:300], "kind": kind})
            nxt = M.next_attempt(kind, dev, ct, allow_cpu)
            # 換 compute type 之前把失敗的模型放掉：OOM 時它正佔著 VRAM
            with _LOCK:
                for k in [k for k in _LOADED if k[1] == dev and k[2] == ct]:
                    _LOADED.pop(k, None)
            gc.collect()
            if nxt is None:
                if kind == "oom":
                    raise OpError("Gpu", f"GPU 記憶體不足：{msg}", "關掉其他佔用 VRAM 的程式，或改用 --device auto 允許退回 CPU") from e
                if kind == "cuda":
                    raise OpError("Gpu", f"CUDA 函式庫無法使用：{msg}", "重新安裝引擎依賴（nvidia-cublas-cu12），或改用 --device cpu") from e
                raise OpError("Model", f"語音辨識失敗：{msg}", "換一個模型或檢查音訊") from e
            fallback_reason = f"{dev}/{ct} 失敗（{kind}）→ 改用 {nxt[0]}/{nxt[1]}：{msg[:160]}"
            ctx.log("warn", fallback_reason)
            dev, ct = nxt
