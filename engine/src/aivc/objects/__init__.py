"""objects：ObjectTrack —「追蹤到的東西」這個可重用的積木（遮罩 + 錨點 + 匯出）。

找物件的方式有三種（`aivc find` 打字、`aivc select` 手動點／框、Claude Code／Codex 看圖給座標再 `select --coords norm1000`），
產物都是同一個 `.aivm`；這個套件把它變成特效與其他程式都能吃的資料：

- `anchors`  逐幀錨點（可見、面積、外接框、重心、方向角）＋ 不跨缺口的 Savitzky-Golay 平滑；`anchors.v1.json` 快取
- `track`    `ObjectTrack.open(masks.aivm)` → `frame(k)` 給特效用的 `ObjectFrame`
- `export`   JSON（`aivc.objecttrack.v1`）／CSV／PNG 遮罩序列（`aivc track-export`）

資料契約（欄位、座標定義、檔案格式）寫在 docs/tracking-api.md；改這裡的定義就要一起改那份文件。
"""
from __future__ import annotations
