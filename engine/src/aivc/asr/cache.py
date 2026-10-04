"""ASR 快取：`<cache>/media/<fp16>/asr/<key16>.v1.json`（研究規格 §5.1）。

key = sha1(模型 repo@revision、ASR 語言、prompt、熱詞、VAD 參數、範圍、beam、輸出語言與轉換、fps、ASR 程式版本)。
不含 device／compute type：GPU 與 CPU 的結果只有極小差異，換裝置不該讓使用者整片重跑。
程式版本（ASR_CODE_VERSION）改了清理規則就要 +1，舊快取自然失效。
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

# 2（2026-09-17）：decode_audio 依時間戳補回音訊斷層 —— 有斷層的來源舊快取的詞時間整段提早，必須重跑
ASR_CODE_VERSION = 2


def cache_key(params: dict[str, Any]) -> str:
    blob = json.dumps({"v": ASR_CODE_VERSION, **params}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]


def asr_dir(media_cache_root: Path) -> Path:
    return Path(media_cache_root) / "asr"


def asr_path(media_cache_root: Path, key: str) -> Path:
    return asr_dir(media_cache_root) / f"{key}.v1.json"


def newest(media_cache_root: Path) -> Path | None:
    d = asr_dir(media_cache_root)
    if not d.is_dir():
        return None
    files = sorted(d.glob("*.v1.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0] if files else None


def load(path: Path) -> dict[str, Any] | None:
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) and d.get("version") == 1 else None
