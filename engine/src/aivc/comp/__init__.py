"""comp：比值重打光合成器（計畫 §6.6 / §5.2 / 決策 17）。

子模組（全部只依賴 numpy + cv2，沒有 torch；重的 import 放在各自模組頂端，
本 `__init__` 刻意不 import 任何東西，讓 `aivc --help` 保持輕量）：

- `params`      插入 Insert 參數表 `InsertParams`（§6.6 表格預設 + 三段巨集 + from_dict 繼承合併）
- `_color`      yuv420p(BT.709 limited) ↔ 線性 full-range float32 RGB；只寫回 dilate(alpha>0,1px)
- `shading`     光影估計：S = 觀測/理想（每通道）、墨區內插、低通、高光加回
- `blur`        動態模糊：沿 H(k-1)→H(k)→H(k+1) 角點路徑取樣，快門角度／相位語意（Nuke/BCC）
- `grain`       顆粒：量測 sigma、8×8 塊狀、逐幀種子、只透過 alpha 施加
- `region`      regionPolicy full|keepBarcode|hold、target "blank"、模板遮罩推導
- `compositor`  `composite_frame()`：把以上串起來，回傳新的 yuv 平面與統計

座標慣例（整個 comp 模組一致）：homography `H` 把「模板連續座標」映到「幀連續座標」，
像素 (i, j) 佔 [i, i+1)×[j, j+1)、中心在 (i+0.5, j+0.5)；模板四角 = (0,0),(w,0),(w,h),(0,h)。
cv2 的 warp 函式以整數為像素中心，所以每次呼叫 cv2 前都用 `T(-0.5)·H·T(+0.5)` 共軛（見 compositor._cv）。
"""
from __future__ import annotations

__all__ = ["params", "shading", "blur", "grain", "region", "compositor"]
