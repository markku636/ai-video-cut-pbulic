"""模型表、語言別名、預設 prompt、失敗分類與退路（純函式，CPU 測試直接測）。

VRAM 數字是這台 RTX 5090 的實測「載入後增加量」（研究規格 §1）；small/medium/base/tiny 沿用 ai-music-cut 的 int8 估計 ×1.3。
revision 釘在實際下載驗證過的 commit：HF 上 repo 會改名／被覆寫（large-v3-turbo 原 repo 已轉址到 dropbox-dash），
不釘版的話同一個「turbo」幾個月後可能是另一份權重，字幕時間會悄悄變。沒量過的模型不釘（None = main）。
"""
from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class ModelInfo:
    name: str
    repo: str
    revision: str | None
    vram_f16_mb: int
    vram_i8_mb: int
    disk_mb: int
    multilingual: bool = True


MODELS: dict[str, ModelInfo] = {
    "tiny": ModelInfo("tiny", "Systran/faster-whisper-tiny", "d90ca5fe260221311c53c58e660288d3deb8d356", 400, 250, 75),
    "base": ModelInfo("base", "Systran/faster-whisper-base", None, 600, 350, 145),
    "small": ModelInfo("small", "Systran/faster-whisper-small", "536b0662742c02347bc0e980a01041f333bce120", 1200, 900, 484),
    "medium": ModelInfo("medium", "Systran/faster-whisper-medium", None, 2600, 1700, 1530),
    "large-v3-turbo": ModelInfo("large-v3-turbo", "mobiuslabsgmbh/faster-whisper-large-v3-turbo", "0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf", 2600, 1900, 1620),
    "large-v3": ModelInfo("large-v3", "Systran/faster-whisper-large-v3", "edaa852ec7e145841d8ffdb056a99866b5f0a478", 4500, 2800, 3090),
}
ALIASES = {"turbo": "large-v3-turbo", "large-v3turbo": "large-v3-turbo", "large": "large-v3", "v3": "large-v3"}
DEFAULT_MODEL = "large-v3-turbo"
VRAM_HEADROOM = 1.25


def resolve_model(name: str | None, free_vram_mb: int | None = None, cuda: bool = True) -> ModelInfo:
    """`auto`：有 GPU 且空閒 VRAM ≥ 1.25×turbo → turbo；否則 small（CPU 上 turbo int8 RTF 0.32 還能用，但 small 快 3 倍）。"""
    n = (name or "auto").strip().lower()
    n = ALIASES.get(n, n)
    if n == "auto":
        if cuda and (free_vram_mb is None or free_vram_mb >= VRAM_HEADROOM * MODELS[DEFAULT_MODEL].vram_f16_mb):
            return MODELS[DEFAULT_MODEL]
        return MODELS["small"]
    if n in MODELS:
        return MODELS[n]
    if "/" in n:  # 使用者直接給 HF repo id（CTranslate2 轉換過的 Whisper）
        return ModelInfo(name or n, name or n, None, 3000, 2000, 0)
    raise ValueError(f"不認得的模型 {name!r}（可用：{', '.join(MODELS)}、auto，或 HF repo id）")


_LANG_ALIASES = {
    "zh-tw": "zh", "zh-hant": "zh", "zh-cn": "zh", "zh-hans": "zh", "zh-hk": "zh", "cmn": "zh", "chinese": "zh", "中文": "zh", "國語": "zh", "普通话": "zh",
    "yue": "yue", "cantonese": "yue", "粵語": "yue",
    "en-us": "en", "en-gb": "en", "english": "en",
    "ja-jp": "ja", "japanese": "ja", "ko-kr": "ko", "korean": "ko",
}


def asr_language(lang: str | None) -> str | None:
    """UI／輸出語言 → Whisper 語言碼；auto／空 → None（Whisper 用前 30 秒偵測；混語片會整段掉字，UI 要警告）。"""
    if lang is None:
        return None
    s = str(lang).strip().lower().replace("_", "-")
    if s in ("", "auto", "detect"):
        return None
    if s in _LANG_ALIASES:
        return _LANG_ALIASES[s]
    return s.split("-")[0]


def default_output_language(asr_lang: str | None, detected: str | None = None) -> str:
    """ASR 選中文 → zh-TW（規格決策 2：台灣繁體）；其他語言原樣。"""
    lang = asr_lang or detected or ""
    return "zh-TW" if lang == "zh" else lang


# 規格 §5.3 B.6：繁中 prompt 讓 Whisper 直接吐繁體＋全形標點（實測無 prompt 是簡體＋半形逗號）
PROMPT_ZH_TW = "以下是台灣繁體中文的逐字稿，使用全形標點。"
PROMPT_ZH_CN = "以下是普通话的逐字稿，使用全角标点。"


def default_prompt(asr_lang: str | None, output_language: str | None) -> str | None:
    if asr_lang != "zh":
        return None
    out = (output_language or "zh-TW").lower()
    return PROMPT_ZH_CN if out in ("zh-cn", "zh-hans", "zh-sg") else PROMPT_ZH_TW


# ---------------------------------------------------------------- 失敗分類與退路


_OOM = re.compile(r"out of memory|CUDA_ERROR_OUT_OF_MEMORY|CUBLAS_STATUS_ALLOC_FAILED|failed to allocate", re.I)
# 「target device or backend do not support efficient float16」這類 compute type 不支援也歸 cuda：換 CPU int8 才有解
_CUDA = re.compile(r"cublas|cudnn|nvrtc|cuda|libcu|no CUDA-capable device|CUBLAS_STATUS|driver version is insufficient|compute type|target device", re.I)


def classify_error(message: str) -> str:
    """oom | cuda | other。先判 OOM（OOM 訊息裡也常有 "CUDA" 字樣）。"""
    if _OOM.search(message or ""):
        return "oom"
    if _CUDA.search(message or ""):
        return "cuda"
    return "other"


def first_attempt(device: str, compute_type: str | None, cuda_available: bool) -> tuple[str, str]:
    d = (device or "auto").lower()
    ct = None if (compute_type or "auto").lower() in ("auto", "default", "") else compute_type
    if d == "cpu" or (d == "auto" and not cuda_available):
        return "cpu", ct or "int8"
    return "cuda", ct or "float16"


def next_attempt(kind: str, device: str, compute_type: str, allow_cpu: bool) -> tuple[str, str] | None:
    """退路表（研究規格 §5.4）：
    - GPU OOM：float16/bfloat16/float32 → int8_float16（同一張卡，VRAM 約 −30%）；int8 系列還 OOM → CPU int8。
    - CUDA 函式庫載入失敗（cublas64_12 找不到等）→ 直接 CPU int8（換 compute type 沒用）。
    - 其他錯誤不重試（模型壞掉、音訊壞掉，換裝置只會浪費時間）。
    device="cuda" 明確指定時 allow_cpu=False → 回 None，呼叫端擲 Gpu。"""
    if device != "cuda":
        return None
    if kind == "oom":
        if not compute_type.startswith("int8"):
            return "cuda", "int8_float16"
        return ("cpu", "int8") if allow_cpu else None
    if kind == "cuda":
        return ("cpu", "int8") if allow_cpu else None
    return None
