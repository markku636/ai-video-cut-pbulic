"""asr — 本機語音辨識（faster-whisper 1.2.1 / CTranslate2 4.8.2）。

模組分工（重依賴一律在函式內 import；`aivc --help`、CPU 測試都不會載入 ctranslate2）：
- cuda_dll.py  Windows 上把 nvidia-cublas-cu12 的 bin 放進 PATH（os.add_dll_directory 單獨用實測無效）
- models.py    模型別名／HF repo 與釘版 revision／VRAM 表、語言別名、預設 prompt、失敗分類與退路表
- audio.py     PyAV 直接從來源解 16 kHz 單聲道 float32（含第一個音訊封包的時間，用來對齊 proxy 幀）
- whisper.py   載入／下載（位元組進度）／轉錄（GPU float16 → int8_float16 → CPU int8 退路）
- cache.py     ASR 快取鍵與路徑 `<cache>/media/<fp16>/asr/<key16>.v1.json`
- llm.py       選配：OpenAI 相容端點（LM Studio）校對，連不上就略過
- doctor.py    env.doctor 的非阻斷 asr 區段
"""
from __future__ import annotations
