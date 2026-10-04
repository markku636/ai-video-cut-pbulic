"""insert：核心的插入來源——平面 track 的 `replace`（用圖片或影片取代追蹤到的表面）。

- `media`   取代用的素材：圖片讀一次、影片用 PyAV（`media.source.FrameSource`）隨機存取＋小 LRU；
            時間軸 proxy 幀 → 素材幀的對應（fps 換算、offsetFrames、loop／hold／stop）；fit（stretch／contain／cover）。
- `source`  `ReplaceInsertSource`：跟外掛同一套插入來源介面（claim／build／setup_jobs／describe，見 `ops/render.insert_sources`），
            交給核心的通用合成器（光影、動態模糊、遮擋；paperRatio 一律關）。

render 一律把它排在外掛的插入來源**後面**：同一條 track 外掛先問（牌局的格位優先），沒人接手、而且 track 有 replace 才輪到它。
"""
from __future__ import annotations
