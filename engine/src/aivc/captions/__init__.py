"""captions — 動態字幕（詞級時間 → 字幕則 → 版面 → 點陣 → 燒進 yuv420p）。

模組分工（全部純 Python + numpy/Pillow/cv2；**不 import faster_whisper**，CPU 測試不需要模型）：
- text.py        CJK 判斷、顯示單位（CJK=2）、接字規則、標點類別
- timebase.py    ASR 秒 → proxy 幀（整數）與 SRT 毫秒
- presets.py     6 個預設（presets.v1.json，鏡射 TS `src/captions/presets.ts`）與樣式深合併
- model.py       專案檔 `captions` 欄位的 drop-and-report 驗證（schema.py 用；刻意零重依賴）
- normalize.py   ASR 詞清理：VAD 跨靜音修正、s2twp 繁體、全形標點、旗標、未覆蓋語音
- segment.py     詞 → 字幕則（硬斷點 + 成本最低的切點）
- timing.py      幀層級時間整理（lag-out、最短、chain、吸附鏡頭、無重疊）
- build.py       ASR 文件 → CaptionTrackV1（dict，camelCase）
- anim.py        動畫曲線與詞狀態（與 TS anim.ts 共用 golden）
- linebreak.py   則內換行（像素寬度、禁則、下重上輕）
- fonts.py / raster.py / layout.py / burn.py / atlas.py / export.py
"""
from __future__ import annotations
