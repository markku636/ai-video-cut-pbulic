# 物件追蹤資料契約（ObjectTrack API）

> 給其他程式、外掛、AI 代理（Claude Code／Codex）讀寫「追蹤到的物件」用的格式說明。
> 實作在 `engine/src/aivc/seg/`（找物件）、`engine/src/aivc/objects/`（錨點與匯出）、`engine/src/aivc/fx/`（特效）、
> `engine/src/aivc/insert/`（平面 replace）、`engine/src/aivc/project/schema.py`（專案檔的鍵，第 10 節）。
> **改這份文件裡的任何定義＝改契約**：程式、測試（`tests/test_objects.py`、`tests/test_fx.py`、`tests/test_project_objects.py`、
> `tests/test_render_objects.py`）要一起改。

## 1. 流程總覽

```
找物件（三選一，產物都一樣）                     積木                          用法
────────────────────────────────────────    ─────────────────────────    ──────────────────────────────
aivc find   --text "face, license plate"  ┐                              aivc fx（打碼／調色／描邊／光暈／貼紙／文字）
aivc select --point / --box（手動）        ├→ obj<N>/masks.aivm ─→ anchors ─→ aivc track-export（JSON／CSV／PNG）
aivc frame --grid → AI 讀 0–1000 座標      ┘   （逐幀遮罩）       （逐幀錨點）  aivc bg-blur／mark／inpaint（既有）
  → aivc select --coords norm1000                                          外掛：ObjectTrack.open(...).frame(k)
```

驗收用的圖：`find` 的 `overlay.png`／`obj<N>/thumb.png`、`select` 的 `overlay.png`、`aivc preview-object` 的聯絡表、`aivc fx-preview --compare`。

## 2. 幀號、時間、座標

| 項目 | 定義 |
|------|------|
| 幀號 `k` | **CFR proxy 幀號**（與 UI 時間軸、`seg`、`track`、`render` 同一套；VFR 來源的缺幀會變成定格的多個 k）。 |
| 時間 `t` | `t = k × fps_den / fps_num`（秒；proxy 的 CFR 時基）。 |
| 像素座標 | **像素邊界座標**：像素 (i, j) 佔 [i, i+1) × [j, j+1)；原點左上、x 向右、y 向下。 |
| 外接框 `bbox` | `[x, y, w, h]`，半開（x..x+w）。與 `aivc seg --box`、pycocotools `toBbox` 相同。單一像素 (10, 20) 的框是 `[10, 20, 1, 1]`。 |
| 重心 `centroid` | 各像素**中心** (i+0.5, j+0.5) 的平均。單一像素 (10, 20) 的重心是 `[10.5, 20.5]`（＝框中心）。 |
| 方向角 `angle` | 最小外接矩形（`cv2.minAreaRect`）**長邊**的方向，度，範圍 (-90, 90]，從 +x 往 +y 量（螢幕上正角度＝順時針）。 |
| 長短邊比 `elongation` | 那個矩形的長邊 ÷ 短邊（≥ 1，一律是有限值）。兩邊各加 1 px 再比（輪廓點是像素中心）：1 px 寬、長 50 px 的直線是 51。**低於 1.25（近正方形、圓形，例如臉）時 `angle` 不可信**：長邊會在兩個方向間換邊、原始角度跳 90°（實測 145×151 的臉在 0° 與 90° 之間來回）。要穩定的方向請用 `smooth.angleCont`。 |
| `norm1000` | 兩軸各自正規化到 0–1000：`x_px = x / 1000 × 寬`、`y_px = y / 1000 × 高`；1000 對到右／下**邊界**。給看圖的 AI 用（`aivc frame --grid` 畫的就是這套格線）。框 `x,y,w,h` 的 w、h 也各自乘 寬/1000、高/1000。 |

## 3. `masks.aivm`（逐幀遮罩）

一個物件一個檔。全部 little-endian，無對齊補白（`seg/maskfile.py`）：

| 區塊 | 大小 | 內容 |
|------|------|------|
| header | 52 bytes | `b"AIVM"` · u32 version=1 · u32 width · u32 height · u32 n_entries · u32 first_k · u32 last_k · u64 index_off · u64 data_off · u64 data_len |
| index | n_entries × 20 bytes | 依 k 嚴格遞增：u32 k · u64 off（**相對 data_off**）· u32 len · u8 flags · u8 pad[3] |
| data | data_len | 逐幀 RLE counts bytes 串接 |

| 條目狀態 | 意義 |
|----------|------|
| 有條目、`flags & 1`（present） | 這一幀有遮罩；`data[off:off+len]` 是 pycocotools **壓縮 RLE counts**（column-major／Fortran 序），解碼尺寸 (height, width) |
| 有條目、flags = 0（len = 0） | 算過、**物件不在**（被遮住、離開畫面） |
| 沒有條目 | **沒算過**（範圍外、還沒傳播） |

寫入一律走唯一暫存名＋`os.replace`（`aivc.atomic`），讀的人不會看到寫一半的檔。Python 讀法：

```python
from aivc.seg.maskfile import MaskFile
mf = MaskFile.open("obj1/masks.aivm")
mf.frames()          # 有條目的 k（含物件不在的）
mf.get(120)          # bool ndarray (H, W)；不在或沒算過 → None（用 mf.has(k) 區分）
```

## 4. `anchors.v1.json`（逐幀錨點快取）

`ObjectTrack.open()` 第一次會算、之後讀快取。位置：`masks.aivm` 旁的 `anchors.v1.json`（其他檔名 → `<stem>.anchors.v1.json`）。
快取鍵＝遮罩檔大小＋內容雜湊（blake2b）＋平滑參數＋程式版本，任何一個不同就重算；資料夾不能寫就不快取。
遮罩檔只讀一次：解析的與雜湊的是同一份位元組（別的行程同時改這個檔也不會把舊遮罩的錨點存到新檔底下）。
沒命中快取時回的值也先過一次 JSON 來回（與寫進快取、之後命中讀回來的數字逐位相同 —— 第一次 `fx-preview` 與之後的成品一致）。
算錨點時有 `objects.anchors` 進度、可取消（`ObjectTrack.open(..., ctx=ctx)`；`fx`、`fx-preview`、`track-export` 都會傳）。

| 欄位 | 型別 | 說明 |
|------|------|------|
| `format` | `"aivc.anchors.v1"` | |
| `code` | int | 程式版本（換了就重算；目前 4） |
| `size` | `[W, H]` | 遮罩尺寸 |
| `smoothing` | `{method:"savgol", window, order}` | 預設 window 9、order 2（與 `geom/smoothing.py` 的追蹤平滑同一組）；window 0＝不平滑。**window 一定是奇數**：給偶數會減 1（記下來的就是實際用的值）——偶數視窗的 SG 在兩個樣本中間求值，整段平滑值偏半幀 |
| `source` | object | 快取鍵：`file`、`bytes`、`mtimeNs`、`blake2b`、`window`、`order`、`code` |
| `visibleRanges` | `[[first, last], …]` | 連續可見的區段，**含頭含尾** |
| `frames` | array | 每個**有條目**的幀一筆，見下表 |

每幀：

| 欄位 | 型別 | 說明 |
|------|------|------|
| `k` | int | proxy 幀號 |
| `computed` | bool | 遮罩檔有這一幀的條目（這個檔裡永遠是 true；匯出時沒算過的幀才是 false） |
| `visible` | bool | present 條目且遮罩非空 |
| `area` | int | 像素數（只有 visible 時才有以下欄位） |
| `bbox` | `[x, y, w, h]` | 見第 2 節 |
| `centroid` | `[cx, cy]` | 見第 2 節 |
| `angle` | float | 度，(-90, 90] |
| `angleCont` | float | 段內**連續**、**沒平滑**的角度（展開規則同下面的 `smooth.angleCont`；段的第一幀＝`angle`）。`smooth: false` 的跟著旋轉貼紙用它 |
| `elongation` | float | 最小外接矩形的長短邊比（≥ 1）；< 1.25 時 `angle` 不可信 |
| `run` | int | 第幾段連續可見（0 起算）。平滑與角度展開都只在同一段內做 |
| `smooth.bbox` / `smooth.centroid` / `smooth.area` | | Savitzky-Golay 平滑後的值（**不跨缺口**：物件消失又出現，兩段互不影響；段 < 3 幀照抄原值） |
| `smooth.angleCont` | float | 段內**連續**的角度再平滑。展開：近正方形的幀（`elongation` < 1.6）逐幀取離上一幀最近的 **90°** 等價角度（量測換邊的 90° 跳動被吃掉、跨過 ±90° 不跳）；確定細長的幀（≥ 1.6）取最近的 **180°** 等價角度 —— 只能是長邊，所以細長物件短暫變方、之後又變回長條時會重新對回長邊。跟著旋轉的貼紙用它算角度差。限制：近正方形的幀之間真的轉超過 45° 的快速旋轉會被當成反方向的小轉動 |
| `smooth.angle` | float | `angleCont` 折回 (-90, 90]（近正方形物件時它可能是短邊方向：重點是「穩定」，不是「長邊」） |

## 5. 匯出（`aivc track-export <video> --masks M.aivm --format json|csv|png --out PATH`）

三種格式涵蓋同一段幀：遮罩檔條目的**最小 k 到最大 k（含頭含尾）**，中間沒有條目的幀照樣列出、標 `computed=false`。
遮罩要是對這支影片算的：尺寸相同，**而且條目的幀號都在影片的 proxy 幀數內**（不然 OpError(Invalid)；`preview-object`、`fx` 同一條檢查）。

### 5.1 JSON：`aivc.objecttrack.v1`

| 欄位 | 說明 |
|------|------|
| `format` | `"aivc.objecttrack.v1"` |
| `video` | `{path, width, height, fps:[num, den], frames}`；`frames`＝proxy 總幀數 |
| `masks` | `{path, width, height, entries, present}` |
| `coordinates` | 座標定義的一行說明（同第 2 節） |
| `smoothing` | `{method:"savgol", window, order, acrossGaps:false}` |
| `visibleRanges` | 同 anchors |
| `frames[]` | 同 anchors 的每幀欄位，另加 `t`（秒）；沒算過的幀只有 `{k, computed:false, visible:false, t}` |

### 5.2 CSV（一幀一列，UTF-8、`\n` 換行）

| 欄 | 說明 |
|----|------|
| `k`, `t` | 幀號、秒 |
| `computed`, `visible` | 0／1 |
| `area`, `x`, `y`, `w`, `h`, `cx`, `cy`, `angle`, `elong` | 原值（不可見時空白；`elong`＝長短邊比） |
| `sx`, `sy`, `sw`, `sh`, `scx`, `scy`, `sangle`, `sarea` | 平滑後的值 |

數字固定 3 位小數再去掉尾端 0（不用科學記號、不寫 `-0`）。

### 5.3 PNG 遮罩序列（`--out` 是資料夾）

- `mask_000000.png`…：8-bit 灰階，255＝物件、0＝不是；檔名是 6 位數的 k。物件不在／沒算過的幀寫全黑（有檔比缺檔好對序列）。
- `mask_sequence.json`：`{format:"aivc.masksequence.v1", pattern:"mask_%06d.png", first, last, size:[W,H], notComputed:[k…], source}`。
- 重新匯出到同一個資料夾時，**先刪掉這次範圍外的 `mask_<6 位以上數字>.png`**（AE／Nuke／`ffmpeg -i mask_%06d.png` 照檔名認序列、
  不看 manifest，留著上一次的幀會把兩個物件或新舊兩版混成一段）。其他檔名一律不碰。

## 6. `aivc find` 與 `aivc select` 的輸出

### 6.1 `find.v1.json`（也是 op `seg.find` 的回傳值）

| 欄位 | 說明 |
|------|------|
| `format` | `"aivc.find.v1"` |
| `video`, `text`, `phrases` | 輸入；`phrases` 是逗號（半形、全形、頓號）分開、去重、保序的片語 |
| `backend` | `{name: "sam3"｜"sam2", label, requested: "auto"｜"sam3"｜"sam2", fallback: bool, reason}` |
| `frames` | `{k0, k1, anchor}`（`k1` 不含） |
| `frameSize`, `fps`, `outDir` | |
| `overlay` | `{path, frame}`：後備＝錨定幀；SAM 3＝同時看得到最多實例的幀 |
| `instances[]` | 依分數排序，`id`＝輸出資料夾 `obj<N>`（通常 1..n；資料夾裡已有**不是上一次 find 寫的** `obj<N>/masks.aivm`，例如 `select --obj N` 加的，就跳過那些編號、不覆寫） |
| `instances[].phrase` | 命中的片語 |
| `instances[].score` | 後備＝OWLv2 偵測分數；SAM 3＝各幀偵測分數的最大值（兩者不可直接比較） |
| `instances[].firstFrame` / `lastFrame` | 第一／最後一個看得到的幀（含） |
| `instances[].bestFrame` | 面積最大的幀（「看得最清楚」），縮圖用這一幀 |
| `instances[].box`, `area` | bestFrame 的外接框與面積 |
| `instances[].framesPresent` / `framesAbsent` | 遮罩檔裡 present／缺席條目數 |
| `instances[].seedFrame` | 後備：下框提示的幀；SAM 3：第一次偵測到的幀 |
| `instances[].masks`, `thumb` | 檔案路徑 |
| `dropped`, `notes`, `model`, `timing`, `gpu` | 被去重／過濾／超過上限的候選數、給人看的註記、模型與耗時 |

- `--text` 要用**英文**名詞片語（OWLv2 與 SAM 3 都只懂英文）；片語含中日韓文字時記一行 warn、`notes` 也寫一行。
- 後備的去重：OWLv2 沒有 NMS，同一個片語的重疊框（IoU ≥ 0.3 或小框 ≥ 60% 落在大框裡）只留分數高的；
  **不同片語**只有幾乎重合（IoU ≥ 0.7，同義詞如「car, vehicle」）才算同一個 —— 「person, face」的臉在人的框裡，兩個都留。
- `--samples N`＝**總共** N 幀（錨定幀不在均勻格點上時換掉離它最近的格點）。`--min-frames` 至少 1；`--chunk` 不能是負的。
- SAM 3：`--max` 在追蹤時就生效（暫時把模型的 `max_num_objects` 調成 max(4×max, 16)），人群鏡頭不會每張臉都追、都占 GPU 記憶體。
- 進度 stage：`seg.find.scan`（建索引）、`seg.find.detect`（後備在取樣幀找框）、`seg.find`（追蹤／傳播；後備多組時 done 累加）、
  `seg.find.write`（寫檔）；明確 `--backend sam3` 而權重不在本機時先有 `models.pull` 的下載進度（可取消）。

### 6.2 `select.v1.json`（也是 op `seg.select` 的回傳值）

| 欄位 | 說明 |
|------|------|
| `format` | `"aivc.select.v1"` |
| `frame`, `obj`, `frameSize`, `coords` | 選取的幀、物件編號、尺寸、輸入座標單位（`px`／`norm1000`） |
| `prompts` | 換成像素後的提示：`points: [[x, y, label]…]`（1＝加選、0＝減選）、`box`、`derived`（`--from` 時：`{from:"old-mask-bbox", box, anchor, droppedComponents?}`＝從舊遮罩推出的提示；`{from:"user-points", reason}`＝加選點都不在舊遮罩上、當成重新指定目標，只用使用者的點） |
| `backend`, `model` | 同 find（select 的後備標籤是 `SAM 2.1`） |
| `mask`, `overlay` | 這一幀的遮罩 PNG（0/255）、疊色＋提示圖 |
| `box`, `area` | 遮罩的外接框與面積 |
| `score` | sigmoid(object score logit)：模型認為「這一幀有這個物件」的信心 |
| `from` | `--from` 的路徑 |
| `propagated` | 沒傳播時 `null`；否則 `{range, recomputed:[K 或 K0, K1], masks, framesPresent, framesAbsent, keptFromOld:{before, after}｜null}` |

`--from` 的合併規則：舊檔 `k < K` 的條目原樣保留、`[K, K1)` 換成新算的、舊檔 `k ≥ K1` 的條目也保留（範圍外不碰）。

`--from` 只給點時的提示推導**只用與點擊一致的那部分舊遮罩**（舊遮罩在第 K 幀先切成連通塊）：
- 有加選點：只用含有（或緊貼著）加選點的連通塊推框與錨點；**所有加選點都不在舊遮罩上**＝重新指定目標，原樣送使用者的點。
- 只有減選點：丟掉含減選點的連通塊；每一塊都含減選點（在同一個東西上修掉一部分）才全部保留。
- 漏到旁邊、但跟正確物件連在一起的部分切不開（同一個連通塊）：那種情況給 `--box` 重新框選。

`--propagate` 沒給 `--obj`（也沒有 `--from`）而 `DIR/obj1/masks.aivm` 已經存在 → OpError(Invalid)，不默默蓋掉上一個物件；
新物件給下一個空號（`--obj 2`…），要重做 obj1 就明確給 `--obj 1`。

sidecar（`aivc serve`）直接送 args 時鍵名就是 CLI 的 dest（`max_instances`、`from_masks`、`min_frames`…）；
`seg.find` 也吃 `max`、`seg.select` 也吃 `from`。`seg.find` 重跑到同一個 `--out` 時，上一次 `find.v1.json` 列過、
這次沒有的 `obj<N>` 會被清掉（只刪它自己寫的 masks.aivm／thumb.png／anchors.v1.json，資料夾裡有別的檔就留著）。

## 7. 特效檔（`aivc fx --effects stack.json`）

三種寫法都可以（也可以直接把 JSON 字串當 `--effects` 的值）：

```json
{"stacks": [
  {"object": 1, "effects": [{"type": "mosaic", "shape": "ellipse", "expand": 6}]},
  {"masks": "D:/clip/find/obj2/masks.aivm", "effects": [{"type": "text", "text": "車牌"}]},
  {"object": "*", "effects": [{"type": "outline", "color": "#FFD400"}]}
]}
{"1": [{"type": "blur"}], "*": [{"type": "glow"}]}
[{"type": "mosaic"}]
```

- `object`：`--masks` 的順序（1 起）、或 `"*"`（每個物件）。`masks`：遮罩檔路徑（沒列在 `--masks` 會自動加進來）。
- 特效檔裡的相對路徑（`masks`、貼紙 `image`、文字 `fontFile`）：`--effects` 是**檔案**時先找特效檔所在的資料夾，那裡沒有才照目前目錄；
  直接給 JSON 字串時照目前目錄（sidecar 的目前目錄是 App 的工作目錄，存成檔案的特效設定請用相對特效檔的路徑或絕對路徑）。
- 鍵名 camelCase 或 snake_case 都可以；**未知鍵會報錯**（帶位置，例如 `stacks[0].effects[1].opacity`）。
- 顏色：`"#RRGGBB"`、`"#RRGGBBAA"`、`[r, g, b(, a)]`（0–255）或 `"r,g,b"`。所有特效都有 `opacity`（0–1）；
  顏色的 alpha（描邊、光暈、文字）與 `opacity` 相乘（`#FF000000`＝完全透明＝不畫）。
- 套用順序＝檔案裡的順序（後面的特效看得到前面的結果）。物件某一幀不在 → 它的特效那一幀不做（`aivc fx` 回報 `absentFrames`）。

遮罩類特效（mosaic、blur、color）共用作用範圍 `footprint`（可以寫成 `"footprint": {...}`，也可以把三個鍵直接寫在特效上）：

| 鍵 | 預設 | 說明 |
|----|------|------|
| `shape` | `mask` | `mask`＝沿遮罩輪廓；`box`＝外接框；`ellipse`＝外接框的內切橢圓（隱私打碼常用） |
| `expand` | 依特效 | 外擴 px（負＝內縮） |
| `feather` | 依特效 | 羽化半徑 px |
| `smooth` | `true` | box／ellipse 用平滑後的外接框（打碼框不會逐幀抖），**再聯集這一幀原始框的形狀**：平滑只會讓範圍變大，物件抖動、急停、折返時不會有一截露在範圍外 |

| `type` | 參數（預設） |
|--------|--------------|
| `mosaic` | `block`（`auto`＝外接框短邊 ÷ `blocks`）、`blocks`（10）、`minBlock`（4 px）、`align`（`frame`＝格子對齊畫面｜`object`＝對齊物件框）、footprint（mask, expand 4, feather 1）。`auto` 的格子大小（與 `object` 的格線原點）在每段連續可見內**從段頭往後帶遲滯算**：理想值離目前值超過 0.75 px（原點：max(0.75, 格子/4) px）才換 —— 遮罩 ±1 px 的抖動不會讓整片馬賽克逐幀重切；單幀預覽與整段渲染結果相同 |
| `blur` | `radius`（`auto`＝外接框短邊 × `strength`）、`strength`（0.2）、`minRadius`（2）、footprint（mask, 4, 2）。只用物件自己的像素平均，背景顏色不會被吸進來 |
| `color` | `hue`（度）、`saturation`（倍率 1）、`brightness`（線性光倍率 1）、`desaturate`（0–1）、`tint`（顏色）＋`tintAmount`（給了 tint 沒給量＝0.5）、`replace: {source, target, tolerance 0.12, softness 0.08}`、footprint（mask, 0, 1）。順序 replace → hue → 飽和 → tint → 亮度，全部在線性光算 |
| `outline` | `color`（#FF4040）、`width`（`auto`＝畫面寬 0.35%）、`mode`（`contour`｜`box`）、`smooth`（2 px）。`contour` 碰到畫面邊時，物件當成在畫面外繼續延伸（不會沿著畫面邊畫一條線） |
| `glow` | `color`（#FFFFFF）、`radius`（`auto`＝畫面寬 2%）、`intensity`（1）、`spread`（2 px）。只在物件外圈，物件本身不動 |
| `sticker` | `image`（PNG 路徑，必填）、`width`＋`widthUnits`（`bbox`＝外接框寬倍數｜`px`｜`frame`＝畫面寬比例；1.0 bbox）、擺放參數（下表） |
| `text` | `text`（必填，可含 `\n`）、`size`＋`sizeUnits`（`frame`＝畫面高比例 0.05｜`px`｜`bbox`）、`color`、`strokeColor`、`strokeWidth`（字級比例 0.12）、`background`（顏色或 null）、`padding`（em 0.3）、`radius`（em 0.3）、`fontFamilies`、`fontFile`、`fontWeight`（700）、`language`、擺放參數（預設 anchor top、pivot bottom、offset [0, -0.04]、followScale false） |

貼紙／文字的擺放參數：

| 鍵 | 預設 | 說明 |
|----|------|------|
| `anchor` | `center` | 物件身上的點：`centroid` 或外接框的 `center`／`top`／`bottom`／`left`／`right`／`top-left`／… |
| `pivot` | `center` | 貼紙自己身上對準錨點的點（帽子：anchor `top` + pivot `bottom`） |
| `offset` / `offsetUnits` | `[0, 0]` / `bbox` | 偏移；`bbox`＝參考幀外接框寬／高的倍數，`px`＝像素 |
| `followScale` | `true` | 大小跟著物件：倍率＝√(這一幀面積 ÷ 參考幀面積) |
| `followRotation` | `false` | 跟著方向角轉（同一段可見用連續角度差、跨段用折回的差）；錨點與偏移也繞重心一起轉。給長形物件用（`elongation` ≥ 1.25）；近圓形物件的方向本來就量不準 |
| `rotation` | `0` | 額外旋轉（度，正＝順時針） |
| `smooth` | `true` | 用平滑後的框／重心／角度（`false`＝原值；跟著旋轉時用每幀的 `angleCont`，跨過 ±90° 一樣連續） |
| `refFrame` | 第一個可見幀 | 大小與角度的參考幀（要可見） |

**位元組保證**（`fx/apply.py`）：令 F＝所有特效作用範圍的聯集（遮罩類＝羽化後 alpha > 0；描邊／光暈＝線條／光的 alpha > 0；貼紙／文字＝變形後 alpha > 0）。
F 外的 Y 位元組不變；一個色度樣本對應的 2×2 亮度區塊完全沒碰到 F → 該樣本不變（部分碰到的會吸收 F 內像素變化的面積平均：4:2:0 本身的限制）。
沒有任何特效作用的幀，`aivc fx` 原樣放行。貼紙與文字在 gamma 空間做預乘 over（PNG 與字型的半透明邊是照 sRGB 設計的）；其他特效在線性光。
多個物件時只轉換用得到的區域（讀取範圍互相碰到的併成一組、每組各自轉線性光與寫回），結果與一個大 ROI 逐位元相同。

## 8. 指令一覽

```
aivc find    <video> --text "face, license plate" [--frames K0:K1] [--anchor K] [--max 8] [--threshold T]
             [--backend auto|sam3|sam2] [--samples N] [--chunk N] [--min-frames N] --out DIR
aivc select  <video> --frame K (--point x,y[:neg] ... | --box x,y,w,h) [--coords px|norm1000]
             [--propagate K0:K1] [--from DIR/obj<N>/masks.aivm] [--obj N] [--backend auto|sam3|sam2] --out DIR
aivc frame   <video> --at K --out f.png [--max-side 1024] [--grid]
aivc preview-object <video> --masks M.aivm [--masks ...] [--frames K1,K2,…] --out sheet.png
aivc track-export   <video> --masks M.aivm --format json|csv|png --out PATH
aivc adopt   <video> --src DIR/obj<N>|M.aivm --track-id ID        # 收進快取 tracks/<ID>/masks.aivm（專案的 object track 用）
aivc fx         <video> --masks A.aivm [--masks B.aivm …] --effects stack.json -o out.mp4 [--frames K0:K1] [--cq N]
aivc fx-preview <video> --masks A.aivm [...] --effects stack.json --frame K -o out.png [--compare]
aivc models pull --sam3        # 需要 facebook/sam3 的存取權限＋HF token
```

- `aivc fx --frames K0:K1`：音軌也裁成同一段（`-ss K0/fps -t (K1−K0)/fps`，與 `render --range --trim` 相同）。
- `aivc fx --cq 0`＝無損：只有 `.mkv`（FFV1）、`--codec libx264`（crf 0）、`.webm`（VP9 加 `-lossless 1`）做得到；
  選到 NVENC（`-cq 0` 是「自動」）或位元率編碼器（openh264、VideoToolbox、mpeg4）時 OpError(Invalid)，不默默輸出有損檔。
- `aivc fx` 的進度：`fx.apply.open`（開檔、建索引）、`objects.anchors`（算錨點）、`fx.apply`（逐幀）、`fx`（編碼器）。

AI 代理（Claude Code／Codex）建議流程：`aivc frame --grid` 看圖 → 讀 0–1000 座標 → `aivc select --coords norm1000 …` →
看 `overlay.png`（不對就補 `--point x,y:neg`）→ `--propagate` → `aivc preview-object` 檢查整段 → 中段歪了用 `--from` 從那一幀補修正點
（追到別的東西上時，在對的東西上點加選就好：加選點都不在舊遮罩上會當成重新指定目標；漏出去的部分跟物件連在一起時改給 `--box`）。
第二個以後的物件記得給 `--obj N`。

## 9. 後端與限制

| 後端 | 何時用 | 能力 | 限制 |
|------|--------|------|------|
| SAM 3（`facebook/sam3`） | `--backend auto` 且權重在本機快取；或 `--backend sam3` | 每幀偵測＋追蹤，中途出現的物件自動成為新實例；點／框也用 SAM 3 追蹤器 | 需要在 Hugging Face 申請存取（作者人工審核）並設 token（`HF_TOKEN` 或 `hf auth login`）。串流模式沒有 hotstart 去重 → 預設丟掉少於 3 幀的實例。分段（預設 600 幀）時，段界上偵測分數不夠的舊實例會結束 |
| OWLv2 + SAM 2.1（後備） | auto 但 SAM 3 不可用；或 `--backend sam2` | 文字 → 錨定幀上的框 → SAM 2.1 雙向傳播；`--samples N` 多看幾幀 | 錨定幀（與取樣幀）沒出現的物件找不到；鏡頭切換後會追丟或黏錯（範圍請在同一個鏡頭內）；OWLv2 對長句／關係描述弱 |

auto 退到後備時引擎會記一行 warn log，結果 JSON 的 `backend.fallback` 是 true、`backend.reason` 說明原因。
明確要 `sam3` 但本機沒有權重也沒有 token → OpError(Model)：說明去哪裡申請、token 怎麼設；有 token 但沒權限 → 同樣的說明（Hub 回 403 GatedRepoError）。
明確要 `sam3`、有 token、權重不在本機 → `find`／`select` 先下載（與 `models pull --sam3` 同一條路：`models.pull` 進度、可取消），再載模型。

SAM 3 文字追蹤的記憶體：非條件幀輸出只留離目前幀 ≤ 64 幀的（不因為靠近條件幀而保留 —— SAM 3 每 16 幀 recondition 一次，
條件幀很密），處理過的幀的 `high_res_masks` 直接拿掉；`--max` 在追蹤時就限制同時追的物件數。

**驗證狀況（2026-10-03）**：OWLv2 + SAM 2.1 後備路線在真影片上跑過（find／select／fx，RTX 5090）。SAM 3 的程式碼對照 transformers 5.17 的原始碼撰寫、
只用假的 model／processor 驗過控制流程 —— 開發機的 Hugging Face 帳號沒有 facebook/sam3 的存取權，**沒有用真權重跑過**。
有權限的使用者第一次跑 SAM 3 時，請回報 `aivc find --backend sam3` 的結果。

## 10. 專案檔與 render（object track、特效、replace）

全部是 track 上**可省略**的鍵（磁碟上 camelCase、不升 `schemaVersion`）；沒用到的專案讀進寫出逐位元相同，
未知鍵照舊原樣保留。引擎讀檔時記下這幾個鍵在原檔的位置、寫回原位（`project/schema._reanchor`）；程式新建的 track 接在 `stale` 後面，
順序 `color, source, range, effects, replace`。實作：`project/schema.py`（`TrackV1`、`ObjectSourceV1`、`ReplaceV1`）。

### 10.1 object track（`tracks[mediaId][]`，`kind: "object"`）

| 鍵 | 說明 |
|----|------|
| `id`, `label` | 同平面 track；`id` 也是快取資料夾名（只能用英數與 `. _ -`） |
| `shotId` | range 起點所在的鏡頭（滿足既有的 track ↔ shot 驗證；不在那個鏡頭裡只警告） |
| `kind` | `"object"` |
| `referenceFrame` | 看得最清楚的一幀（`adopt` 回的 `bestFrame`） |
| `keyframes` | 可以是 `[]` |
| `color` | `"#RRGGBB"`（UI 顏色；壞值丟掉並警告） |
| `source` | `{type: "text"｜"select"｜"ai", text?, phrase?, backend?, score?}`（type 壞掉整個丟掉；其他子鍵原樣保存） |
| `range` | `[k0, k1]` 半開 proxy 幀；超過 proxy 幀數只警告，render 時夾進去 |
| `effects` | 見 10.3 |

遮罩在 `<media 快取>/tracks/<trackId>/masks.aivm`（與平面 track 的遮罩同一個位置），由 `objects.adopt` 放進去：

`aivc adopt <video> --src DIR/obj<N>|M.aivm --track-id ID`（op `objects.adopt`，args `{video, src, track_id}`）：
從影片指紋找到快取、檢查遮罩尺寸 = 影片尺寸、唯一暫存名＋`os.replace` 複製、算錨點快取 `anchors.v1.json` 與縮圖 `thumb.png`。
回 `{trackId, masks, visibleRanges（含頭含尾）, range（建議的半開 [第一個可見幀, 最後一個可見幀+1)）, bestFrame, box, area, thumb, frames:{entries, present, absent}, size}`。

### 10.2 平面 track 的 `replace`

`{kind: "image"｜"video", path, fit: "stretch"｜"contain"｜"cover", offsetFrames: int, loop: "loop"｜"hold"｜"stop"}`
（缺的選填鍵＝stretch／0／loop；相對路徑以專案檔所在資料夾為準）。核心的插入來源 `aivc/insert/`，排在外掛的插入來源**後面**
（同一條 track 外掛先問）：

- 合成走核心的通用合成器（光影 lowpass、動態模糊、遮擋＝遮罩、顆粒），**paperRatio 一律關**。H 來自 `solve.v1.json`
  （沒有 solve → 計畫的 skipped 寫原因）；模板＝solve 模板的比例、長邊至少 512 px（`H_scale` 換算）。
- fit：stretch 直接縮放；contain 等比放進去、置中，空白處 alpha 0（露出原表面）；cover 等比蓋滿、置中裁切。PNG 的 alpha 照用。
- 影片：PyAV（`media.source.FrameSource`，走素材自己的 CFR 索引，快取在素材自己的 media 快取）＋小 LRU。時間軸 proxy 幀 k → 素材幀：
  `j = (k − 鏡頭起點) + offsetFrames`（**offsetFrames 以時間軸幀計**），`s = floor(j · den_t/num_t · num_s/den_s)`（整數算）；
  s 超出 [0, n)：`loop` 取 s mod n、`hold` 夾到 [0, n−1]、`stop` 不印（這些幀從 job 拿掉，計畫的合成幀數照實算、輸出原樣放行）。
- 素材不存在／讀不了 → 那條 track 跳過，原因進計畫的 `skipped`（不讓整支輸出失敗）。
- 計畫 JSON 的 `tracks[]` 多一個 `replace`：`{kind, path, fit, offsetFrames, loop, templateSize, source:{size, frames, fps}, stopped}`。

### 10.3 特效（`effects`，object 與 planar track 都可以有）

`[{id, enabled, type, ...參數}]`；`id`／`type` 缺了該筆丟掉並警告。render 去掉 `id`／`enabled` 交給 `aivc.fx.params.parse_effect`
（第 7 節的格式，未知鍵報錯）。render 在平面合成**之後**、字幕燒入**之前**逐 proxy 幀套 `aivc.fx.apply_effects`（同一幀所有 track 一次寫回；
位元組保證同第 7 節）：

| track | 作用範圍 | 會套用的幀 |
|-------|----------|------------|
| object | `tracks/<id>/masks.aivm`＋錨點 | 遮罩 present 條目 ∩ `range` ∩ `--range` |
| planar | 有遮罩條目的幀用遮罩（缺席＝不在），沒有條目的幀用 solve 四角的多邊形 | ∩ 鏡頭 ∩ `--range` |

計畫 JSON（render.plan、render.run 的 `plan`／結果）**只有在專案有 object track 或任何 track 帶 effects 時**才多一個 `effects` 陣列，每條 track：
`{trackId, kind, footprint: "masks"｜"quad"｜"masks+quad"｜null, masks, range, frames, effects: [{id, type, enabled, status: "ok"｜"disabled"｜"invalid", reason?}], skipped: null｜原因, applied, absentFrames}`
（序列輸出另有 `mediaId`，`frames` 是序列實際用到的幀數）。跳過原因例：「沒有特效」「特效全部停用」「沒有可用的特效（N 個不合法…）」
「沒有遮罩 …（先跑 aivc adopt）」「沒有遮罩也沒有 solve」「範圍內沒有任何一幀看得到它」。object track 不是插入候選，不會出現在 `skipped`。

### 10.4 track.solve 不給 `--template`

一般的平面（牆、螢幕、招牌）：`aivc track <video> --shot K0:K1 --quad x1,y1,…,x4,y4 --reference-frame K`（或 `--keyframe K:…`）
→ 那一幀的四角矯正出模板（`track/template.template_from_frame`，尺寸＝四角在幀裡的大小，長邊上限 1024），存成 solve 旁的 `template.png`；
之後的 `--retrack-from`／`--clear-*` 沒給四角就重用它。回傳的 `template` 說明來源（`frame`／`saved`／`file`）。
沒紋理的區域（素色牆）SIFT 找不到特徵會追丟：四角要框住有紋理的東西（字、圖案、邊緣）。

輕量 lane：這幾支 op 都在主 lane（`fx.preview` 要用 PyAV 解碼，與主 lane 首次載入模型同時會卡死，見 `seg/text_box.py`）。
`render.plan` 本來就是 light；replace 影片素材的索引建立（第一次）與它在同一個 lane 跑，跟主影片的索引同性質。
