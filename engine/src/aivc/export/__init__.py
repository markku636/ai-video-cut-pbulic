"""追蹤資料匯出（計畫 §17.5）：Nuke CornerPin2D `.nk` 片段、After Effects 關鍵幀剪貼簿文字、遮罩／矯正後表面 PNG 序列。

全部是純函式（吃 `{k: quad}` 字典、吐字串），op 層 `ops/export_track.py` 只負責找檔案與寫檔；
`export-roundtrip` 量尺（§11）就是「匯出 → 解析 → 重建四角 → 對 solve.v1.json 誤差 < 0.01 px」。

子模組：`nuke_cornerpin`、`ae_keyframes`、`mattes`。這裡**不**把函式再匯出到套件層——`nuke_cornerpin` 同時是模組名
與函式名，重匯出會讓 `from aivc.export import nuke_cornerpin` 拿到函式而不是模組。
"""
from __future__ import annotations

__all__ = ["nuke_cornerpin", "ae_keyframes", "mattes"]
