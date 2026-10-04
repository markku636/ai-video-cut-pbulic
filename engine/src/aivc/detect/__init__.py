"""detect — 不用模型的第一層：候選（`Candidate`）的共用形狀、SAM 提示轉換、幀讀寫。

輸出只是「候選」（quad + kind），精確邊界交給 seg/。所有座標都是**來源像素**（計畫 §3 決策 4）。
自動偵測器是外掛的事（例：牌局外掛 `aivc_cards.detect` 的桌布／白色四邊形偵測）；核心只處理使用者給的框與四角。
重的 import（cv2）放在函式內，讓 `aivc --help` 保持快。
"""
from __future__ import annotations

from .candidate import KIND_FACE_UP, Candidate, order_quad, quad_area, quad_is_convex

__all__ = [
    "KIND_FACE_UP",
    "Candidate",
    "order_quad",
    "quad_area",
    "quad_is_convex",
]
