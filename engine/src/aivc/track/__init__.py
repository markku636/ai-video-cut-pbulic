"""平面追蹤（計畫 §6.4、決策 13）：模板→幀、關鍵幀錨定、永不逐幀鏈接。

模組分工：
- `template.py`  模板（牌面影像 + 紙／墨遮罩 + 各尺度 SIFT 快取）、合成測試牌、由幀矯正出模板。
- `classic.py`   單幀解：SIFT + USAC_MAGSAC → ECC 精修 → 退化檢查。
- `state.py`     狀態機的資料型別（State / FrameSolve / Solve / TrackOptions）與靜止偵測、等速預測。
- `runner.py`    參考影格挑選、雙向掃描、重取得、靜止鎖、光度輔助模板、平滑；clear_forwards / clear_backwards / retrack_from。
- `_aivm_read.py` 最小 .aivm 讀取器（計畫 §5.4；seg 模組另有寫入端，整合時去重）。
- `_frames.py`   PyAV 幀讀取（暫代 media.source）。
"""
