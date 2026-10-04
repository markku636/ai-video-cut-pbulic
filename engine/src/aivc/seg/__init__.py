"""seg：物件遮罩（Object Mask）— SAM 2.1 串流分割、RLE、`.aivm` 遮罩檔（計畫 §5.4 / §6.2 / §17）。

子模組刻意分層，讓 CPU 測試不需要 torch：
- `rle`       pycocotools RLE 包裝（bool ndarray <-> counts bytes、面積、IoU）
- `maskfile`  `.aivm` 讀寫（Python 寫、Rust 依 k 讀、TS worker 解成 ImageBitmap 的三方共用格式）
- `backend`   SegBackend / SegSession 協定（幀來源無關；提示標籤 1=加選 Add Selection、0=減選 Reduce Selection）
- `sam2_hf`   transformers Sam2VideoModel 實作（重 import 全在函式內）
- `_frames`   暫用的 PyAV 幀解碼小工具（整合期會換成 media.source.FrameSource）
- `preview`   疊色預覽 PNG

「追蹤任何東西」（`aivc find`／`aivc select`）新增的幾層：
- `backends`  後端選擇 auto｜sam3｜sam2（SAM 3 權重不在本機 → OWLv2 + SAM 2.1 後備）＋ 工廠
- `sam3_hf`   SAM 3（facebook/sam3，gated）：文字 → 多實例的串流／分段追蹤；點／框用 SAM 3 追蹤器套 `Sam2HfSession`
- `finders`   文字找物件的兩個後端（`Sam3Finder`、`OwlSam2Finder`），對 ops 長得一樣
- `instances` 一個實例＝逐幀 RLE＋片語＋分數；外接框／面積不解碼直接從 RLE 算；IoU 接段、去重
- `prompts`   select 的提示：px｜norm1000 換算、`--from` 補修正點時從舊遮罩推導框與錨點
- `viz`       給人與 AI 驗收的圖：編號疊色、提示點／框、縮圖、聯絡表、0–1000 座標格線
"""
