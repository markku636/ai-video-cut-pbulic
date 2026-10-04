# ai-video-cut 里程碑 2 設計：序列剪輯與音訊（design only）

> 2026-09-17，基準：worktree `ai-video-cut-range`（branch `feat/range-select`，HEAD `ce6ceef`，v0.0.6 + M1 範圍／傳輸列／右鍵／媒體資訊）。
> 參考：Premiere Pro、DaVinci Resolve、Final Cut Pro、CapCut 桌面版，以及同一位使用者天天在用的 `ai-music-cut`（快捷鍵與滑鼠手勢以它為第一優先，市售軟體為第二優先）。
> 本文件只做設計，不改程式碼。濾鏡圖已在內建 ffmpeg **n8.1.2** 上實跑驗證（§7.5），spike 腳本與產物在 `scratchpad/editor/m2spike/`。

---

## 0. 一頁摘要

1. **資料模型**：專案 schema 升到 v2，新增 `sequence: SequenceV2 | null` 與 `audioMedia: AudioMediaV2[]`。`sequence === null` 叫「隱含序列」＝目前媒體整段、未剪，所有 v0.0.6 行為（含 `-c:a copy`）原封不動。第一次剪輯時才在同一筆 undo 裡把序列「實體化」。
2. **V1 是磁吸主軌**（FCP primary storyline／CapCut 主軌）：片段的位置由順序推得，不存 start；需要空白時用 `GapV2` 片段。音訊軌（A1…An）不磁吸，位置用序列樣本（48 kHz 整數）存。
3. **原音**是 V1 片段自帶的元件（`VideoClipV2.audio`，FCP 式），跟著片段走、畫在 A0「原音」列。「分離音訊」才變成 A 軌上的獨立 `AudioClipV2`（可做 J/L cut）。
4. **替換永遠依來源幀 k 計算**：序列只是一張 `t → (mediaId, k)` 的對應表。序列編輯不碰 `tracks/shots/cardSlots/masks/solves`，渲染依 (mediaId, k) 合成，同一來源幀出現在序列哪裡、出現幾次，輸出的像素都逐位元相同。
5. **渲染**：視訊依序列逐幀取 (media, k) → 既有 `composite_at` → rawvideo 管線；音訊每個片段一條 `atrim → asetpts → aresample(async) → apad/atrim → afade → volume → adelay` 鏈，`amix normalize=0` 混成剛好 `S(T)` 個樣本，濾鏡圖寫檔用 `-/filter_complex <file>` 傳。**只有「序列等於單一未動過的整段片段、且沒有任何音訊片段」時才走 `-c:a copy`**。
6. **時間對齊一律靠容器絕對 pts**（`-copyts`），不數樣本、不用輸入端 `-ss`：實測數樣本在 1 s 音訊斷層後整段早 1.000 s；輸入端 `-ss` 在 Opus/WebM 上晚 48 樣本（1 ms）；pts 加 `aresample async=1` 的誤差 ≤ 2 樣本。
7. **UI**：時間軸分「序列 Sequence／素材 Source」兩個空間（Premiere 的 Program／Source monitor）；序列空間多了 V1 片段列、A0 原音波形列、A1…An 音訊軌（左側 DOM 軌道標頭：M 靜音、鎖定、同步鎖、推桿）；追蹤車道透過對應表畫在片段底下。
8. **快捷鍵**：`B` 在播放線分割（與 ai-music-cut 同）、`Ctrl+\` 分割（Resolve）、`Delete` 波紋刪除（ai-music-cut／FCP／CapCut）、`Shift+Delete` 刪除留空隙、`D` 停用片段（Resolve）、`Ctrl+Alt+L` 分離音訊（Resolve 的 link 鍵）、`Ctrl+Shift+[ / ]` 波紋修剪到播放線（Resolve）、`F` 對應幀（Premiere／Resolve）、`Shift+N` 吸附（ai-music-cut 的 N 已被「新增追蹤」佔用）。
9. **里程碑**：19 個步驟（M2.0～M2.18），每步 ≤ 半天、各自可出貨；序列 UI 在 M2.17 之前藏在設定旗標「序列剪輯（預覽）」後面。

### 0.1 待使用者決定（有建議值，不擋 M2.0～M2.8）

| # | 問題 | 建議 | 理由 |
|---|---|---|---|
| Q1 | `Ctrl+B` 要不要從「收合側欄」改成「分割」？（Resolve／FCP／CapCut 都是 Ctrl/Cmd+B 分割） | **M2 不動**，先給 `B` 與 `Ctrl+\`；M2 結束後再看使用者習慣 | 改既有鍵是破壞性的；`B` 已經跟 ai-music-cut 一致 |
| Q2 | Delete 的預設語意：波紋刪除（ai-music-cut／FCP／CapCut）還是留空隙（Premiere／Resolve 的 Backspace） | **波紋刪除**，Shift+Delete 留空隙 | 同一位使用者在 ai-music-cut 已經是這個肌肉記憶 |
| Q3 | 音樂軌預設要不要跟著 V1 波紋移動（sync lock） | **音樂軌預設關、旁白／音效軌預設開** | ai-music-cut `mix.rs`：「墊樂釘在成品時間上，剪輯再動音樂不該跟著跑」 |
| Q4 | 輸出時要不要預設加限幅器 | **預設關**，`render.plan` 估峰值 > −1 dBFS 時提示 | `alimiter` 預設 `level=true` 會自動拉響度、`latency=false` 會讓聲音晚 5 ms，兩個預設都是坑 |

---

## 1. 範圍與不變式

### 1.1 M2 要做
- 由一或多支媒體組成的序列：在播放線分割、刪除、波紋刪除、修剪片段兩端、停用片段；可以把媒體加到序列（接在結尾或插在播放線）。拖曳調整順序放到後面（§13 M2.later），但引擎從第一天起就支援任意順序。
- 音訊：保留原音、範圍內靜音或閃避（duck）、加入音訊片段（音樂／旁白／音效檔）放在音訊軌、增益、淡入淡出、波形顯示、分離音訊。錄旁白只設計介面與存檔位置（§13 M2.later）。
- 渲染依序列產出，音訊依規則重新混音。
- schema v2 與 v1 升版、undo 整合、時間軸 UI、指令、右鍵選單。

### 1.2 不變式（每條都有對應測試，§13）
- **I1 追蹤資料不受剪輯影響**：任何 `sequence.*`／`audio.*` 動作的 commit，`before.tracks === after.tracks`、`before.shots === after.shots`、`before.cardSlots === after.cardSlots`（比物件參照）；不會把任何 track 標成 stale。
- **I2 依來源幀合成**：序列輸出第 t 幀，等於「只渲染來源、第 k 幀」逐位元相同（用 ffv1 無損驗證），其中 `(media, k) = map(t)`。
- **I3 輸出長度精確**：視訊剛好 `T = seqDuration` 幀；音訊解碼後剛好 `S(T) = floor(T · 48000 · den / num)` 個樣本（編碼器的 pre-skip／priming 由容器補償，解碼後仍是 S(T)）。**例外（M2.0 實測）**：mp4／AAC 解碼後會多 0～1023 個樣本 —— edit list 只補償開頭的 priming、不裁最後一個 1024 幀的尾端 padding（多出來的在結尾，不影響對齊）；mkv／pcm 與 webm／Opus 剛好 S(T)。
- **I4 v1 專案零回歸**：`sequence === null` 或「未動過」時，`render.plan` 的 golden 與 `test_render` 全部不必改。
- **I5 降版安全**：專案沒用到 v2 功能時寫出 `schemaVersion: 1`，v0.0.6 仍打得開（§4.3）。
- **I6 片段不重疊**：同一條音訊軌內片段不重疊；V1 由結構保證。

---

## 2. 市售軟體對照（用詞與行為）

| 概念 | Premiere Pro | Resolve | Final Cut Pro | CapCut 桌面 | ai-music-cut | **ai-video-cut M2** |
|---|---|---|---|---|---|---|
| 序列 | Sequence | Timeline | Project | 草稿時間軸 | EDL（keeps） | **序列 Sequence**（一個專案一條） |
| 主軌磁吸 | 無（Sync Lock 近似） | 無 | Primary storyline | 主軌磁吸 | 剪掉自動接合 | **V1 磁吸**，空白＝`GapV2` |
| 空白 | 空白區 | 空白區 | Gap clip | 無 | 提起＝留白靜音 | **GapV2**（黑畫面＋靜音） |
| 分割 | Ctrl+K（Add Edit）、C 剃刀 | Ctrl+B / Ctrl+\、B 刀片模式 | Cmd+B、B 刀片工具 | Ctrl+B | **B**（在播放線切一刀，再按一次移除切點） | **B**（同 ai-music-cut）＋ `Ctrl+\` |
| 波紋刪除 | Shift+Delete | Ripple Delete | Delete（主軌） | Delete（主軌） | **Delete** | **Delete** |
| 刪除留空隙 | Delete／Backspace | Delete Selected | Shift+Delete（Replace with Gap） | — | **Shift+Delete**（提起） | **Shift+Delete** |
| 範圍提取／提起 | `'` Extract／`;` Lift | — | — | — | Delete／Shift+Delete 作用於選取 | 範圍為焦點時 Delete／Shift+Delete |
| 停用片段 | Shift+E（Enable） | D | V | — | — | **D** |
| 分離音訊 | Ctrl+L（Unlink） | Ctrl+Alt+L（Link） | Ctrl+Shift+S（Detach Audio） | 右鍵「分離音訊」 | — | **Ctrl+Alt+L** |
| 修剪到播放線 | Q／W（波紋） | Ctrl+Shift+[ / ] | Option+[ / ] | Q／W | — | **Ctrl+Shift+[ / ]**（Q 已是「顯示表面」） |
| 對應幀 | F（Match Frame） | F | Shift+F | — | — | **F** |
| 吸附 | S | N | N | 工具列磁鐵 | N | **Shift+N**（N＝新增追蹤） |
| 上／下一個剪輯點 | ↑／↓ | ↑／↓ | ↑／↓ | — | — | 序列空間 **↑／↓**（素材空間仍是鏡頭） |
| 預設音訊轉場 | Ctrl+Shift+D | — | — | — | — | **Ctrl+Shift+D**（套預設淡入淡出） |
| 淡入淡出把手 | 片段轉場／關鍵幀 | 片段角落把手 | 片段角落把手 | 片段角落把手 | overlay fade_in/out_ms | **片段角落把手** |
| 音量線 | Rubber band＋Ctrl 點加關鍵幀 | 音量線＋Alt 點加點 | 音量線＋Option 點 | 音量關鍵幀 | overlay points（dB 域內插） | **音量線＋Alt 點加點**（dB 域內插） |
| 同步鎖 | Sync Lock（軌道標頭） | Auto Track Selector | Connected clips | 主軌連動 | 墊樂釘成品時間 | **syncLock**（軌道標頭，音樂軌預設關） |

**快捷鍵以 ai-music-cut 為第一優先的理由**：使用者明確要求「參考 ai-music-cut 的操作」（M1 需求 f），而且兩個 App 由同一個人交替使用；ai-music-cut 的 `B`、`Delete`、`Shift+Delete` 語意剛好也跟 FCP／CapCut 一致。

---

## 3. 資料模型

### 3.1 時間單位（全部是整數，沒有浮點秒）

| 量 | 單位 | 為什麼 |
|---|---|---|
| V1 片段 `srcIn/srcOut` | 該媒體的 **proxy 幀 k**（CFR） | 追蹤、遮罩、解算、關鍵幀全部以 k 為鍵（決策 3）；分割必然幀準 |
| 序列位置 t | **序列幀**（`sequence.fps`，= V1 所有媒體的 proxy fps） | 播放線、範圍、縮圖都以幀算 |
| 音訊片段 `start/length/fadeIn/fadeOut/envelope.at` | **序列樣本**（48 000 Hz 整數） | 樣本級修剪；與 fps 無關；1 幀在 29.97 fps 是 1601.6 樣本，存幀會丟精度 |
| 音訊片段 `srcIn` | **來源原生取樣率的樣本**，0 ＝ 音訊串流的 `start_time` | 修剪不經過重取樣；可為負（前面補靜音） |
| 衍生的來源時間 | 微秒整數（`startUs`、`videoStartUs`） | ffmpeg `atrim start` 的解析度就是 µs |

換算（TS `src/sequence/map.ts` 與 Python `aivc/sequence/model.py` 各一份，共用 golden）：

```text
S(t)            = floor(t · 48000 · fps.den / fps.num)            // 序列幀 t 的起始樣本；一律從絕對 t 算，不累加
clipLen(c)      = S(t1) − S(t0)                                    // 相鄰片段鋪滿不留縫、不重疊（29.97 fps 也成立）
absUs(k, media) = videoStartUs + round(k · 1e6 · fps.den / fps.num) // proxy 幀 k 的容器絕對時間
absUs(srcIn, a) = a.startUs + round(srcIn · 1e6 / a.sampleRate)     // 音訊片段入點的容器絕對時間
```

`S(t)` 刻意用 floor 並從 t 直接算：每片段各自 round 會在片段接縫留下 ±1 樣本的縫或重疊，200 個片段後就漂 200 樣本。

### 3.2 TS 型別（`src/project/format.ts`，SoT）

```ts
export const SCHEMA_VERSION = 2 as const;
/** 實際寫進檔案的版本：沒用到 v2 功能就寫 1（§4.3），v0.0.6 還打得開。 */
export type WrittenSchemaVersion = 1 | 2;

export const SEQ_SAMPLE_RATE = 48000 as const;
/** 片段邊緣自動的防爆音淡化（ms）；使用者的淡入淡出比它長就不另外加。 */
export const DEFAULT_EDGE_DECLICK_MS = 3;
/** ≤ 這個 dB 視為 −∞（靜音）。 */
export const SILENCE_DB = -90;

/** afade 的 tri / qsin；Web Audio 預覽用 linearRamp / 正弦 setValueCurve。 */
export type FadeCurve = "linear" | "equalPower";
export type AudioRole = "music" | "voiceover" | "sfx" | "other";

/** 音量自動化點。at：相對片段起點的序列樣本；兩點之間在 dB 域線性內插（同 ai-music-cut OverlayPoint）。 */
export interface GainPointV2 {
  at: number;
  db: number;
}

/** 片段層的音訊參數（V1 原音與音訊片段共用同一組欄位，渲染與預覽只寫一套）。 */
export interface ClipGainV2 {
  gainDb: number;          // −96..+12
  fadeIn: number;          // 序列樣本
  fadeOut: number;         // 序列樣本；fadeIn + fadeOut ≤ length（sanitize 等比縮）
  fadeCurve: FadeCurve;
  envelope: GainPointV2[]; // 依 at 排序、at ∈ [0, length]
}

/** V1 片段自帶的原音（FCP 式元件）：跟著片段走，波紋編輯不必另外搬音訊。 */
export interface ClipAudioV2 extends ClipGainV2 {
  /** false = 原音靜音（「靜音原音」或已分離）。 */
  enabled: boolean;
  /** 分離出去的 AudioClipV2.id；有值時 enabled 必為 false。 */
  detachedTo?: string;
}

export interface VideoClipV2 {
  kind: "clip";
  id: string;
  mediaId: string;
  /** proxy 幀，含。 */
  srcIn: number;
  /** proxy 幀，不含。 */
  srcOut: number;
  /** false = 停用：佔時間、輸出黑畫面與靜音（Resolve D／Premiere Enable）。 */
  enabled: boolean;
  audio: ClipAudioV2;
  label?: string;
}

/** 磁吸主軌上的空白（FCP Gap clip）：黑畫面＋靜音。 */
export interface GapV2 {
  kind: "gap";
  id: string;
  /** 序列幀。 */
  length: number;
}

export type VideoItemV2 = VideoClipV2 | GapV2;

/** 音訊片段的來源：專案裡的影片媒體（分離出來的原音）或純音訊媒體。 */
export type AudioSourceRefV2 = { type: "media"; mediaId: string } | { type: "audio"; audioId: string };

export interface AudioClipV2 extends ClipGainV2 {
  id: string;
  source: AudioSourceRefV2;
  /** 序列樣本。 */
  start: number;
  /** 序列樣本，≥ 1。 */
  length: number;
  /** 來源原生取樣率的樣本；0 = 音訊串流 start_time；可為負（前面補靜音，分離「音訊晚於影片開始」的原音會遇到）。 */
  srcIn: number;
  /** false = 片段靜音。 */
  enabled: boolean;
  /** 從哪個 V1 片段分離出來（畫「原音」徽章、日後重新連結用）。 */
  detachedFrom?: string;
  label?: string;
}

export interface AudioLaneV2 {
  id: string;
  /** "A1 音樂"；可改名。 */
  name: string;
  role: AudioRole;
  /** 靜音會影響輸出（Resolve／Premiere 的軌道靜音都會）；獨奏只是監聽，放 UI state 不存檔。 */
  muted: boolean;
  locked: boolean;
  /** V1 波紋編輯時這條軌要不要跟著移（Premiere Sync Lock）；音樂預設 false、其他預設 true。 */
  syncLock: boolean;
  /** 軌道推桿。 */
  gainDb: number;
  /** 依 start 排序、不重疊。 */
  clips: AudioClipV2[];
}

export interface SequenceV2 {
  id: string;
  name: string;
  /** = V1 所有媒體的 proxy fps（M2 不做 conform；不同 fps 的媒體要先用同 fps 重建 proxy）。 */
  fps: Rational;
  /** 來源像素尺寸（合成器在來源像素空間工作）；M2 要求 V1 所有媒體同尺寸、同色彩範圍與矩陣。 */
  width: number;
  height: number;
  sampleRate: typeof SEQ_SAMPLE_RATE;
  /** V1 磁吸主軌：位置 = 前面所有項目長度之和。 */
  video: VideoItemV2[];
  /** A0「原音」匯流排（V1 片段原音的軌道推桿）。 */
  original: { muted: boolean; gainDb: number };
  audioLanes: AudioLaneV2[];
  audio: { edgeDeclickMs: number; limiter: boolean };
}

/** 衍生的音訊時間資訊（引擎 audio.v1.json 的摘要）：可重生、不進 undo、缺了就標 stale 重算。 */
export interface AudioInfoV2 {
  codec: string;
  sampleRate: number;
  channels: number;
  channelLayout: string | null;
  /** 音訊串流 start_time（容器絕對時間，µs）。mp3 的 LAME 延遲會出現在這裡（實測 25 057 µs）。 */
  startUs: number;
  /** 影片第一幀的 pts（index.pts_ms[0]，µs）；純音訊檔為 null。 */
  videoStartUs: number | null;
  /** 以 pts 對齊並補滿斷層後的原生樣本數。 */
  nSamples: number;
  /** pts 斷層（> 20 ms）：媒體資訊對話框顯示，渲染時由 aresample async 補靜音。 */
  gaps: { atUs: number; durUs: number }[];
}

export interface AudioMediaV2 {
  /** "a-" + 指紋前 16 碼（與影片 mediaId 分開命名，同一支 mp4 可以同時當影片與音樂來源）。 */
  id: string;
  path: string;
  name: string;
  fingerprint: string;
  probe: MediaProbe | null;
  role: AudioRole;
  audio: AudioInfoV2 | null;
}

export type ProjectMediaV2 = ProjectMediaV1 & { audio?: AudioInfoV2 | null };

export interface ProjectFileV2 extends Omit<ProjectFileV1, "schemaVersion" | "media"> {
  schemaVersion: WrittenSchemaVersion;
  media: ProjectMediaV2[];
  /** null = 隱含序列（目前媒體整段、未剪）。寫成 v1 時整個鍵省略。 */
  sequence: SequenceV2 | null;
  /** 寫成 v1 時整個鍵省略。 */
  audioMedia: AudioMediaV2[];
}

export const DEFAULT_CLIP_GAIN: ClipGainV2 = { gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [] };
export const DEFAULT_CLIP_AUDIO: ClipAudioV2 = { enabled: true, ...DEFAULT_CLIP_GAIN };
```

**為什麼原音是片段元件、不是 A 軌上的連結片段**：V1 磁吸之後，原音若是獨立片段，每個波紋動作都要同步搬一份，還要處理「連結群組被使用者拖散」的狀態；FCP 的元件模型讓 99% 的情況（原音跟著畫面）零成本，J/L cut 這 1% 用「分離音訊」解決。

**為什麼獨奏不存檔**：獨奏是監聽行為；存進專案會讓「上次忘了取消獨奏」直接影響輸出。

**為什麼 `audioMedia` 與 `media` 分開**：現有程式大量假設 `media[]` 是有 proxy、有 track 的影片（`needsProxy`、Sidebar 重建 proxy、StartScreen、activeMediaId）。音訊檔混進去，任何一個漏掉的守門都會讓舞台去播一支 mp3。

### 3.3 Python 型別（`engine/src/aivc/project/schema.py`）

規則沿用 v1：磁碟上 camelCase、dataclass snake_case、`extra` 保留不認得的鍵、載入時丟棄並回報（不擲錯）。

```python
SCHEMA_VERSION = 2
SEQ_SAMPLE_RATE = 48_000
FADE_CURVES = ("linear", "equalPower")
AUDIO_ROLES = ("music", "voiceover", "sfx", "other")
GAIN_DB_MIN, GAIN_DB_MAX = -96.0, 12.0


@dataclass
class GainPointV2:
    at: int          # 相對片段起點的序列樣本
    db: float


@dataclass
class ClipGainV2:
    gain_db: float = 0.0
    fade_in: int = 0
    fade_out: int = 0
    fade_curve: str = "linear"
    envelope: list[GainPointV2] = field(default_factory=list)


@dataclass
class ClipAudioV2(ClipGainV2):
    enabled: bool = True
    detached_to: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class VideoClipV2:
    id: str
    media_id: str
    src_in: int                      # proxy 幀（含）
    src_out: int                     # proxy 幀（不含）
    enabled: bool = True
    audio: ClipAudioV2 = field(default_factory=ClipAudioV2)
    label: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)
    kind: str = "clip"


@dataclass
class GapV2:
    id: str
    length: int                      # 序列幀
    extra: dict[str, Any] = field(default_factory=dict)
    kind: str = "gap"


@dataclass
class AudioSourceRefV2:
    type: str                        # "media" | "audio"
    ref_id: str                      # 磁碟上是 mediaId / audioId


@dataclass
class AudioClipV2(ClipGainV2):
    id: str = ""
    source: AudioSourceRefV2 | None = None
    start: int = 0                   # 序列樣本
    length: int = 0                  # 序列樣本
    src_in: int = 0                  # 原生樣本，可為負
    enabled: bool = True
    detached_from: str | None = None
    label: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class AudioLaneV2:
    id: str
    name: str
    role: str = "other"
    muted: bool = False
    locked: bool = False
    sync_lock: bool = True
    gain_db: float = 0.0
    clips: list[AudioClipV2] = field(default_factory=list)
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class SequenceV2:
    id: str
    name: str
    fps: Rational
    width: int
    height: int
    sample_rate: int = SEQ_SAMPLE_RATE
    video: list[VideoClipV2 | GapV2] = field(default_factory=list)
    original_muted: bool = False
    original_gain_db: float = 0.0
    audio_lanes: list[AudioLaneV2] = field(default_factory=list)
    edge_declick_ms: float = 3.0
    limiter: bool = False
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class AudioInfoV2:
    codec: str
    sample_rate: int
    channels: int
    channel_layout: str | None
    start_us: int
    video_start_us: int | None
    n_samples: int
    gaps: list[tuple[int, int]] = field(default_factory=list)   # (at_us, dur_us)


@dataclass
class AudioMediaV2:
    id: str
    path: str
    name: str = ""
    fingerprint: str = ""
    probe: dict[str, Any] | None = None
    role: str = "other"
    audio: AudioInfoV2 | None = None
    extra: dict[str, Any] = field(default_factory=dict)


# ProjectFileV1 改名 ProjectFile（保留 ProjectFileV1 別名給舊 import），新增：
#   sequence: SequenceV2 | None = None
#   audio_media: list[AudioMediaV2] = field(default_factory=list)
# from_json：schemaVersion ∈ {1, 2}，> 2 拒絕；v1 檔 sequence=None、audio_media=[]。


def written_version(p: "ProjectFile") -> int:
    """與 TS buildProjectFile 同一條規則（§4.3）。"""
    return 2 if (p.sequence is not None or p.audio_media) else 1
```

純函式對應（`engine/src/aivc/sequence/model.py`，TS 鏡像 `src/sequence/map.ts`）：

```python
def samples_of_frame(t: int, fps: Rational, sr: int = SEQ_SAMPLE_RATE) -> int:
    return (t * sr * fps.den) // fps.num

@dataclass(frozen=True)
class Placed:
    item: VideoClipV2 | GapV2
    t0: int   # 序列幀（含）
    t1: int   # 序列幀（不含）

def place_video(seq: SequenceV2) -> list[Placed]: ...
def duration_frames(seq: SequenceV2) -> int: ...
def map_frame(seq: SequenceV2, t: int) -> tuple[VideoClipV2 | None, int | None]:
    """t → (片段, 來源 proxy 幀 k)；空白或停用回 (None, None)（輸出黑畫面）。"""
def is_untouched(seq: SequenceV2 | None, project: "ProjectFile") -> bool:
    """`-c:a copy` 閘門（§7.1）。"""
```

TS／Python 兩份實作會漂移，所以共用 `fixtures/sequence/map-cases.json`（30/1、30000/1001、24000/1001、25/1；空白、停用、同一來源幀用兩次、倒序片段），兩邊的測試讀同一份期望值，做法同指紋測試向量。

### 3.4 衍生快取（`<app_cache_dir>/media/<fp16>/`）

**`audio.v1.json`**（引擎 op `media.audio_info`，CLI `aivc audio-info`）：只解音訊串流一趟（約 500 倍即時），記錄 `codec, sampleRate, channels, channelLayout, startUs, videoStartUs, nSamples, gaps[]`。為什麼不塞進 `index.v1.json`：舊快取沒有這段，加欄位等於讓每個人的 index 重解一次視訊。

**`peaks.v1.bin`**（Rust `peaks.rs`，Tauri 指令 `media_peaks(jobId, path, fingerprint)`，不需要 Python 引擎）：移植 ai-music-cut `media.rs` 的 `Analyzer`（min／max／RMS／零交越，5 ms 桶，去掉 ebur128）。唯一的差別是**時間原點**：

```text
ffmpeg -nostdin -hide_banner -loglevel error -copyts -i <src> -vn -map 0:a:0
       -af aresample=48000:async=1:min_hard_comp=0.020:first_pts=0 -ac 1 -f f32le pipe:1
```

`-copyts` 加 `first_pts=0` 讓第 i 個桶就是**容器絕對時間** [5i, 5i+5) ms：前面補靜音、負的起點（Opus pre-skip 標成 −7 ms）被裁掉、中間斷層補靜音。跟渲染用同一個時間域，波形畫在哪，聲音就出在哪。

```text
"AIVP" | u32 version=1 | u32 pps=200 | u32 sr=48000 | u32 n_buckets | u64 total_samples | i64 stream_start_us
→ i8[n] min → i8[n] max → u8[n] rms(−60..0 dBFS) → u8[n] zero-cross
```

換新的 magic（不沿用 `AIPK`）：時間原點不同，拿 ai-music-cut 的解析器讀會安靜地錯位，magic 不同才會當場擲錯（ai-music-cut `analysis_header_ok` 的教訓）。

### 3.5 sanitize（TS `project/sanitize.ts` 與 Python `from_json` 同一套規則）

| 對象 | 規則 | 處置 |
|---|---|---|
| V1 片段 | `mediaId` 存在；`0 ≤ srcIn < srcOut`；proxy 已知時 `srcOut ≤ proxy.frames` | 媒體不存在 → 丟片段；超界 → **保留並標離線**（proxy 以不同 fps 重建時，片段不能被默默刪掉） |
| V1 片段 fps／尺寸 | 引用媒體的 proxy fps ≠ `sequence.fps`，或尺寸不同 | 保留、警告；`render.plan` 擲 `Invalid`「請以 N/D fps 重建 proxy」 |
| Gap | `length ≥ 1` | 丟 |
| 音訊片段 | 來源存在；`start ≥ 0`；`length ≥ 1`；`srcIn ≥ −10·sr` | 丟 |
| 同軌重疊 | 依 start 排序後，與前一個重疊 | 丟後者並回報 |
| 淡入淡出 | `fadeIn + fadeOut > length` | 等比縮小 |
| 自動化點 | at 超出 [0, length] → 夾住；未排序 → 排序；db 夾在 [−96, +12] | 修正 |
| 分離參照 | `detachedTo` 指向不存在的片段 | 清掉並把 `audio.enabled` 設回 true；`detachedFrom` 懸空 → 清掉 |
| id | 序列內所有片段 id（V1＋所有軌）要唯一 | 重複的重新發號 |

---

## 4. 升版 v1 → v2

### 4.1 TS（`src/project/migrate.ts`）

```ts
/** 1 → 2：只加兩個鍵。隱含序列（null）就是 v1 的行為，所以不需要任何 proxy 幀數也能升。 */
const toV2: MigrationStep = (doc) => ({
  ...doc,
  schemaVersion: 2,
  sequence: isRecord(doc.sequence) ? doc.sequence : null,
  audioMedia: Array.isArray(doc.audioMedia) ? doc.audioMedia : [],
});

const STEPS: Record<number, MigrationStep> = { 1: toV1, 2: toV2 };
```

**刻意不在升版時就產生一條「整段片段」的序列**：v1 檔的 `media[].proxy` 可能是 null（幀數未知），硬產一條會需要哨兵值（`srcOut: null`），而哨兵值會滲進每一個剪輯函式。用 `null` 表示隱含序列，第一次剪輯時才在 `edits.ts` 裡實體化（需要 proxy 就緒，指令守門 `needsProxy`）。

### 4.2 Python（`schema.py`）
- `from_json` 接受 1 與 2；`ver > 2` 拒絕（訊息同 v1：「請更新 AI Video Cut」）。
- v1 檔讀進來 `sequence=None`、`audio_media=[]`；`to_json` 用 `written_version()`。

### 4.3 最低版本寫檔（降版安全）

`buildProjectFile` 與 Python `to_json` 都算 `written = sequence !== null || audioMedia.length ? 2 : 1`；寫 1 時**省略** `sequence` 與 `audioMedia` 兩個鍵。

**為什麼**：App 每 2 秒自動存檔。沒有這條規則的話，使用者用新版打開舊專案、什麼都沒剪，檔案就被悄悄升成 v2，退回 v0.0.6 會被「較新版本」擋在門外。這條規則讓「只要沒剪輯就能降版」成立；開始剪輯之後才不可逆，而且那時本來就該不可逆（v0.0.6 不懂序列，打開會輸出錯的片子）。

測試：`fixtures/project/v1/*.aivc.json` 讀進來再寫出，除了 `updatedAt` 以外逐位元相同。

---

## 5. 編輯語意（`src/sequence/ops.ts`，純函式，回傳新的 `SequenceV2`，結構共享）

### 5.1 實體化
`materialize(media: ProjectMediaV2): SequenceV2`：`fps = proxy.fps`、`width/height = probe.video`、一個 `clip-1 = [0, proxy.frames)`、`audio = DEFAULT_CLIP_AUDIO`、`original = {muted:false, gainDb:0}`、`audioLanes = []`、`audio = {edgeDeclickMs: 3, limiter: false}`。所有剪輯動作的入口都是 `ensureSequence()`：序列為 null 就先實體化，然後在**同一筆 commit** 裡做動作，一次 Ctrl+Z 回到 null。

### 5.2 動作一覽

| 函式 | 行為 | 波紋對音訊軌的影響（`syncLock=true` 的軌） |
|---|---|---|
| `splitAt(seq, t, target)` | target = 選取的片段／全部未鎖定的軌。V1：`[srcIn,srcOut)` 切成 `[srcIn,k)`＋`[k,srcOut)`；原音自動化點依位置分到兩邊，並在切點兩側補內插點保持曲線；淡入留前段、淡出留後段。音訊片段同理（樣本級）。 | 無 |
| `joinThroughEdit(seq, t)` | 播放線剛好在「同一媒體、來源連續（左 srcOut == 右 srcIn）」的切點上 → 合併（ai-music-cut「再按一次 B 移除切點」）。 | 無 |
| `rippleDelete(seq, ids)` | V1 片段移除、後面往前補；音訊片段移除（音訊軌本身不磁吸，不補）。 | 移除 V1 的 `[a,b)`（L = S(b)−S(a)）：完全在 b 之後 → `start −= L`；完全在 `[a,b)` 內 → 刪除；跨 a 或 b → 切開，保留 `[a,b)` 以外的部分並接回（Premiere Extract 語意） |
| `lift(seq, ids)` | V1 片段換成同長度的 `GapV2`（相鄰 gap 合併）；音訊片段直接移除。 | 無 |
| `extractRange(seq, range)` / `liftRange` | 以範圍為對象的 rippleDelete／lift：先在 in、out 兩點 `splitAt` 全部軌，再對中間做。 | 同 rippleDelete |
| `trimEdge(seq, id, edge, delta, {ripple})` | V1 一律波紋（磁吸）：`srcIn/srcOut` 夾在 `[0, proxy.frames]`、長度 ≥ 1 幀；音訊片段預設不波紋，樣本級，Alt 拖曳時才不吸附到幀。 | V1 在點 P 變長 Δ：start ≥ P → `+Δ`；跨 P 的片段在 P 切開、後段 `+Δ`。變短同 rippleDelete。 |
| `setEnabled(seq, ids, bool)` | V1 停用＝黑畫面＋靜音；音訊片段停用＝靜音。 | 無 |
| `detachAudio(seq, clipId, info)` | 在 role `other`、syncLock 開的軌（沒有就新建「A1 原音（分離）」）新增 `AudioClipV2`：`source={type:"media"}`、`start=S(t0)`、`length=S(t1)−S(t0)`、`srcIn = round((videoStartUs + absOffsetUs(k=srcIn) − startUs) · sr / 1e6)`，增益／淡化／自動化照抄；原片段 `audio.enabled=false, detachedTo`。 | 無 |
| `addAudioClip(seq, laneId, src, atSample, info)` | 長度 = 來源剩餘長度換成 48 kHz；和既有片段重疊時放到該軌第一個放得下的位置，放不下就開新軌（不做覆寫，覆寫編輯留到 M2.later）。 | 無 |
| `moveAudioClip(seq, id, laneId, start)` | 目標位置重疊 → 拒絕並回傳最近可放的位置（UI 拖曳時顯示紅框）。 | 無 |
| `setGain / setFades / setEnvelope` | 修改 `ClipGainV2`，並夾住數值。 | 無 |
| `duckRange(seq, laneSel, range, db, rampSamples)` | 對 `laneSel`（"A0" 或 laneId[]）範圍內的每個片段寫 4 個自動化點（範圍前 ramp 處 0 dB → 範圍起點 db → 範圍終點 db → 範圍後 ramp 處 0 dB），已存在的點在 `[in−ramp, out+ramp]` 內先清掉；跨片段邊界時各片段自己補內插點。`muteRange` = `duckRange(db = −96, ramp = 5 ms)`。 | 無 |
| `appendMedia / insertMedia(seq, media, t?)` | 加一個整段片段到結尾，或在 t（吸到最近剪輯點）插入；fps／尺寸不符擲 `SequenceError`（UI 顯示「請以 30/1 重建 proxy」）。 | 插入 = 在 P 變長 Δ |
| `removeMediaRefs(seq, mediaId)` | 移除媒體前先刪掉引用它的片段（同一筆 commit）。 | 同 rippleDelete |
| `validateSequence(seq)` | 回傳違反 I6、id 重複、淡化超長等問題清單；每個 op 的測試都跑它。 | — |

**音樂軌預設不跟著波紋移動（syncLock=false）**：一刀剪掉 V1 中間 3 秒，墊樂整條停在原地、長度不變，這是做片的人要的；要跟畫面鎖死的旁白與音效才開同步鎖（§0.1 Q3）。

---

## 6. undo 整合（`src/store/edits.ts`）

```ts
export const PROJECT_SCOPE = "*project" as const;

export interface Snapshot {
  shots: ShotV1[];
  tracks: TrackV1[];
  cardSlots: CardSlotV1[];
  deck: DeckRefV1;
  /** 專案層（同 deck）：每筆 patch 都帶，LIFO undo 才能還原一致的整體狀態。 */
  sequence: SequenceV2 | null;
  audioMedia: AudioMediaV2[];
}

interface EditsStore {
  // …M1 既有欄位
  sequence: SequenceV2 | null;
  audioMedia: AudioMediaV2[];
  /** 所有序列 / 音訊動作的單一入口：f 拿到的是實體化過的序列；回傳 null = 沒變（不留空 undo）。 */
  editSequence: (label: string, f: (seq: SequenceV2, ctx: SeqCtx) => SequenceV2 | null, opts?: { audioMedia?: AudioMediaV2[] }) => boolean;
  loadSequence: (seq: SequenceV2 | null, audioMedia: AudioMediaV2[]) => void;
}
```

- `commit(mediaId, …)`：序列動作用 `PROJECT_SCOPE` 當 mediaId；`apply()` 遇到 `PROJECT_SCOPE` 只寫 `deck/sequence/audioMedia`，不動 per-media 的 map（不然 `shots["*project"]` 這種垃圾鍵會被存進檔案）。
- **I1 由結構保證**：`editSequence` 呼叫 `commit` 時只給 `{ sequence, audioMedia }`，`tracks/shots/cardSlots` 沿用 before 的參照。
- **LIFO 一致性**：每筆 patch 都帶完整的專案層欄位，所以只要 undo/redo 嚴格照順序，`past[top].after` 永遠等於現況。
- **`clear(mediaId)` 必須改**：M1 的 `clear` 會從歷史**中間**抽掉某個媒體的 patch，但專案層欄位（deck，現在多了 sequence）沒辦法從中間抽。規則改成：移除媒體時先 `editSequence("移除媒體（含序列片段）", removeMediaRefs)`，然後清空整個 past/future，並提示「已清除復原歷史」。這是 M1 就存在的 deck 隱患，一起修掉。
- 衍生欄位（`media[].audio`、`audioMedia[].audio`、peaks）不進 undo，寫法同 `markSolved`。
- 標籤（進 `check-i18n` 的 TABLE_SOURCES）：「分割片段」「合併切點」「波紋刪除」「刪除片段（留空隙）」「提取範圍」「移除範圍（留空隙）」「停用片段」「啟用片段」「修剪片段」「分離音訊」「加入媒體到序列」「加入音訊」「移動音訊片段」「音訊增益」「淡入」「淡出」「淡化曲線」「音量自動化」「閃避範圍」「靜音範圍」「清除音量自動化」「新增音軌」「刪除音軌」「音軌靜音」「同步鎖」「音軌推桿」「移除媒體（含序列片段）」。

---

## 7. 渲染演算法

### 7.1 什麼時候 `-c:a copy`

```text
isUntouched(seq, project) =
  seq == null
  || ( seq.video.length == 1 && item.kind == "clip" && item.enabled
       && item.srcIn == 0 && item.srcOut == proxy.frames
       && item.audio == DEFAULT_CLIP_AUDIO (enabled、0 dB、無淡化、無自動化、未分離)
       && !seq.original.muted && seq.original.gainDb == 0
       && seq.audioLanes 全部沒有片段 )
```

- 成立 → 走 v0.0.6 原路徑（含 `--range --trim` 的 `-ss/-t` 封包級裁切），I4 零回歸。「B 切一刀再按 B 合併」後序列雖然已實體化，仍會回到 copy 路徑（比的是值，不是 null）。
- 不成立 → `audio_mode = "mix"`，依容器重新編碼（webm → libopus 160k、mp4/mov → aac 160k、mkv → flac），`dropped += ["音軌重新混音（原因：…）"]`，原因列出分割次數、停用片段、增益或淡化、音訊片段數。`exportDefaults.audio == "copy"` 在這種情況視同 auto 並記一條 note，不擲錯（使用者沒辦法在不剪輯的前提下滿足它）。

### 7.2 視訊：序列幀 → (media, k) → 合成

```python
def render_sequence_frames(ctx, seq, plans: dict[str, RenderPlan], sources: dict[str, FrameSource], window):
    placed = place_video(seq)                       # 前綴和，bisect 查 t
    black = black_frame(seq.width, seq.height, color_range=first_media.range)   # tv: Y16 U128 V128；pc: Y0
    last_key, last_out = None, None
    for t in range(*window):
        ctx.check_cancel()
        clip, k = map_frame_placed(placed, t)
        if clip is None or not clip.enabled:
            yield black; continue
        m = clip.media_id
        src = cfr[m].src_index(k)                   # VFR 定格：多個 k 對到同一來源幀
        key = (m, src, tuple(k in j.frames for j in plans[m].jobs))
        if key != last_key:
            fr = sources[m].get(src)                # 片段內循序解；跨片段時 seek 到 ≤ 目標的關鍵幀
            last_out = composite_at(fr, k, plans[m], ctx)   # 依來源 k：H(k±1)、遮罩、顆粒種子全以 k 為準
            last_key = key
        yield last_out
```

- `plans[m]` 就是既有的 `build_plan(media m)`，但 `job.frames` 限制在序列實際用到的 k 集合；沒被序列用到的 track 放進 `skipped`（原因「不在序列使用範圍內」），省掉白算。
- **顆粒種子要改**：現行 `seed = seed + len(jobs) * 7919` 取決於 job 的**順序**；序列渲染只要少建一個 job，後面每條 track 的顆粒就不同，I2 會失敗。改成 `seed + stable_hash(track.id)`（M2.7，同時更新 golden）。
- `--emit-matte / --emit-faces` 在序列渲染時以**序列幀 t** 編號（放進 `media/<mediaId>/` 子目錄），這樣才能跟輸出片直接疊；加 `--source` 渲染時維持 k 編號。
- 範例 WebM 只有 18 個關鍵幀：每個跨片段的 seek 最壞往前解約 100 幀（約 0.15 s，見 `media/source.py` 註解），每個切點只付一次。

### 7.3 音訊：每個片段一條鏈

每個「會發聲」的片段（V1 片段 `enabled && audio.enabled && !original.muted`，以及未靜音軌上 `enabled` 的音訊片段）產生一個 ffmpeg 輸入與一條鏈：

```text
輸入：-i <來源檔>        （不加 -ss：§7.5 實測輸入端 seek 在 Opus/WebM 晚 48 樣本）
鏈：
[i:a]atrim=start=<inUs>:end=<outUs>          ← 容器絕對時間（全域 -copyts），6 位小數 = µs
    ,asetpts=PTS-STARTPTS                     ← 片段內相對時間；保留內部斷層的 pts
    ,aresample=48000:async=1:min_hard_comp=0.020:first_pts=0   ← 斷層補靜音、重取樣到 48 kHz
    ,aformat=sample_fmts=fltp:channel_layouts=stereo           ← 單聲道來源改用 pan=stereo|c0=c0|c1=c0（見下）
    [,adelay=delays=<leadPad>S:all=1]         ← 只有 inUs < 串流 start 時（分離原音、音訊晚於影片開始）
    ,apad,atrim=end_sample=<L>                ← 精確長度（尾端不足補靜音、多的裁掉）
    [,asetnsamples=n=240:p=0,volume=eval=frame:volume='<envelope expr>']   ← 有自動化點才加；p=0 否則長度被墊長
    ,afade=t=in:ss=0:ns=<max(fadeIn, D)>:curve=<tri|qsin>
    ,afade=t=out:ss=<L−max(fadeOut, D)>:ns=<max(fadeOut, D)>:curve=<tri|qsin>
    [,volume=volume=<clipGain + laneGain>dB]  ← 0 dB 時省略
    ,adelay=delays=<delay>S:all=1[cN]
混音：
[c1]…[cN]amix=inputs=N:duration=longest:dropout_transition=0:normalize=0
    ,apad,atrim=end_sample=<S(T)>
    [,alimiter=limit=0.891:attack=5:release=50:level=0:latency=1]   ← sequence.audio.limiter 才加
    [aout]
```

參數：

| 符號 | V1 片段（t0..t1、media m） | 音訊片段 |
|---|---|---|
| `inUs` | `m.audio.videoStartUs + round(srcIn·1e6·den/num)` | `a.startUs + round(srcIn·1e6/sr_native)` |
| `outUs` | `m.audio.videoStartUs + round(srcOut·1e6·den/num)` | `inUs + ceil(length·1e6/48000) + 1 個原生樣本` |
| `L` | `S(t1) − S(t0)` | `length` |
| `delay` | `S(t0)` | `start` |
| `leadPad` | `max(0, round((a.startUs − inUs)·48000/1e6))` | 同左 |
| `D`（防爆音） | `round(edgeDeclickMs · 48)` = 144 | 同左 |

各項選擇的理由：
- **`-copyts`＋絕對時間**：不用知道容器的 `format.start_time`（Python probe 沒有這欄）；mp3 的 LAME 延遲（實測 `start_time=0.025057`）自然帶進來。rawvideo 管線的 pts 本來就從 0 開始，不受影響。
- **`asetpts=PTS-STARTPTS` 而不是 `N/SR/TB`**：數樣本會把來源內的斷層壓掉。實測 1 s 斷層之後，數樣本法讓後面的聲音整段早 1.000 s；Chrome 錄影（分頁靜音、系統忙）很常有這種斷層，視訊那邊是 CfrMap 定格，音訊必須留白才對得上。
- **`amix normalize=0`**：預設會把每一路除以路數，三路就各小 9.5 dB（ai-music-cut `mix.rs` 已踩過）。
- **`apad` 接 `atrim=end_sample`**：`apad` 不給長度會無限補，交給 `atrim` 剪在精確樣本數，比 `apad=whole_len` 在「來源比需要長」時也成立。
- **防爆音淡化**：剪在波形中間必有爆音；3 ms 聽不出淡化，但足以消掉接縫。零交越貼齊（ai-music-cut 的做法）會讓音訊相對畫面偏移 1～2 ms，影片剪輯裡 A/V 對齊比較重要，所以改用微淡化。
- **單聲道**：`aformat=channel_layouts=stereo` 會自動插入重新混音，而 swr 把 mono（FC）混到 L/R 用 center mix level −3 dB，整段變小聲。單聲道來源明確寫 `pan=stereo|c0=c0|c1=c0`；5.1 以上交給 `aresample` 預設的 ITU 降混，並記 note。
- **濾鏡圖寫檔**：`-/filter_complex <out>.part.audio.txt`（FFmpeg 7 起的 `-/opt file` 語法，n8.1.2 實測可用）。自動化運算式幾十段就會撞到 Windows 32 767 字元的命令列上限（ai-music-cut `mix.rs` 開頭記錄過這個理由）。檔案跟 `.part` 一起清掉。
- **自動化點用 `asetnsamples=240` + `volume eval=frame`**：`eval=frame` 每個音訊 frame 求值一次，Opus 解出來一 frame 是 20 ms，階梯會有拉鍊雜音；切成 5 ms 一 frame 後聽不出來。運算式在 dB 域線性內插：`pow(10, dB(t)/20)`。
- **限幅器兩個預設都是坑**：`level` 預設 true 會把輸出自動拉到 limit（改變響度）、`latency` 預設 false 會讓聲音晚 attack 毫秒（破壞 A/V 對齊）；兩個都必須明寫。

**太多片段時的退路**：同時開啟的輸入 > 32 個（每個輸入一個 demux/decode 執行緒）→ 改成兩段式：每條軌先各自渲成 48 kHz f32 WAV stem（每次一張小圖），再把 stems 混成 `[aout]`。stem 暫存檔放 `<out>.part.stems/`，完成或取消都清掉。

**範圍輸出 `--range T0:T1 --trim`**：先建整條混音，最後接 `atrim=start_sample=S(T0):end_sample=S(T1),asetpts=PTS-STARTPTS`。範圍外的片段照樣解碼（音訊解碼很便宜）；最佳化（直接略過範圍外的鏈）留到 M2.later。

### 7.4 範例：兩個片段＋一段音樂

**專案**
- 媒體 `m1` = `sample_clip1.webm`：1280×720、proxy 30/1、N = 1797；Opus 48 kHz 立體聲；`videoStartUs = 0`、`audio.startUs = 0`（公式照帶，真實數值以 `audio.v1.json` 為準）。
- 音訊媒體 `a-5f…` = `bgm.mp3`：44.1 kHz 立體聲；`startUs = 25 057`（LAME 延遲 1105 樣本）。

```json
{
  "schemaVersion": 2,
  "sequence": {
    "id": "seq-1", "name": "sample_clip1", "fps": { "num": 30, "den": 1 }, "width": 1280, "height": 720, "sampleRate": 48000,
    "video": [
      { "kind": "clip", "id": "c1", "mediaId": "m1", "srcIn": 60, "srcOut": 360, "enabled": true,
        "audio": { "enabled": true, "gainDb": 0, "fadeIn": 0, "fadeOut": 0, "fadeCurve": "linear", "envelope": [] } },
      { "kind": "clip", "id": "c2", "mediaId": "m1", "srcIn": 930, "srcOut": 1380, "enabled": true,
        "audio": { "enabled": true, "gainDb": -3, "fadeIn": 0, "fadeOut": 48000, "fadeCurve": "equalPower", "envelope": [] } }
    ],
    "original": { "muted": false, "gainDb": 0 },
    "audioLanes": [
      { "id": "lane-1", "name": "A1 音樂", "role": "music", "muted": false, "locked": false, "syncLock": false, "gainDb": 0,
        "clips": [
          { "id": "a1", "source": { "type": "audio", "audioId": "a-5f…" }, "start": 48000, "length": 960000, "srcIn": 88200,
            "enabled": true, "gainDb": -12, "fadeIn": 96000, "fadeOut": 144000, "fadeCurve": "equalPower",
            "envelope": [ { "at": 420000, "db": 0 }, { "at": 432000, "db": -10 }, { "at": 624000, "db": -10 }, { "at": 636000, "db": 0 } ] }
        ] }
    ],
    "audio": { "edgeDeclickMs": 3, "limiter": false }
  },
  "audioMedia": [ { "id": "a-5f…", "path": "D:\\music\\bgm.mp3", "name": "bgm.mp3", "fingerprint": "5f…", "probe": null, "role": "music", "audio": null } ]
}
```

（`envelope` 就是在序列 10.0～14.0 s 閃避 −10 dB、前後 0.25 s 斜坡的結果：音樂從序列 1.0 s 開始，所以片段內是 8.75／9.0／13.0／13.25 s。）

**序列與各鏈的數字**（T = 300 + 450 = 750 幀，S(T) = 1 200 000）

| 鏈 | 輸入 | inUs → outUs | L | delay | 淡入 | 淡出 | 增益 |
|---|---|---|---|---|---|---|---|
| c1 | 1 = sample_clip1.webm | 0 + 60·1e6/30 = 2 000 000 → 12 000 000 | S(300) − S(0) = 480 000 | 0 | 144 tri（防爆音） | 144 tri（防爆音） | 0 dB |
| c2 | 2 = sample_clip1.webm | 31 000 000 → 46 000 000 | S(750) − S(300) = 720 000 | 480 000 | 144 tri（防爆音） | 48 000 qsin | −3 dB |
| a1 | 3 = bgm.mp3 | 25 057 + 88 200·1e6/44 100 = 2 025 057 → 22 025 057 | 960 000 | 48 000 | 96 000 qsin | 144 000 qsin | −12 dB（軌 0 dB） |

同一支來源用兩個 `-i`、不用 `asplit`：`asplit` 把兩條鏈綁在同一個解碼器上，其中一條還沒輪到的時候，另一條的輸出會堆在 `amix` 的 FIFO 裡；分開輸入時，ffmpeg 7+ 的排程器只會去讀 `amix` 缺資料的那一路（背壓），記憶體有上界。

**濾鏡圖檔 `out.webm.part.audio.txt`**（逐字，已在 n8.1.2 實跑）

```text
[1:a]atrim=start=2.000000:end=12.000000,asetpts=PTS-STARTPTS,aresample=48000:async=1:min_hard_comp=0.020:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end_sample=480000,afade=t=in:ss=0:ns=144:curve=tri,afade=t=out:ss=479856:ns=144:curve=tri,adelay=delays=0S:all=1[c1];
[2:a]atrim=start=31.000000:end=46.000000,asetpts=PTS-STARTPTS,aresample=48000:async=1:min_hard_comp=0.020:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end_sample=720000,afade=t=in:ss=0:ns=144:curve=tri,afade=t=out:ss=672000:ns=48000:curve=qsin,volume=volume=-3dB,adelay=delays=480000S:all=1[c2];
[3:a]atrim=start=2.025057:end=22.025057,asetpts=PTS-STARTPTS,aresample=48000:async=1:min_hard_comp=0.020:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end_sample=960000,asetnsamples=n=240:p=0,volume=eval=frame:volume='if(lt(t,8.75),1,if(lt(t,9),pow(10,-10*(t-8.75)/0.25/20),if(lt(t,13),pow(10,-10/20),if(lt(t,13.25),pow(10,-10*(13.25-t)/0.25/20),1))))',afade=t=in:ss=0:ns=96000:curve=qsin,afade=t=out:ss=816000:ns=144000:curve=qsin,volume=volume=-12dB,adelay=delays=48000S:all=1[m1];
[c1][c2][m1]amix=inputs=3:duration=longest:dropout_transition=0:normalize=0,apad,atrim=end_sample=1200000[aout]
```

（c2 的淡出 48 000 > D，所以淡出端不另外加防爆音淡化；a1 兩端的使用者淡化都比 D 長，也一樣。）

**完整命令**（`media/encoder.py` 擴充：`audio_inputs`、`filter_script`、`map_audio="[aout]"`）

```text
ffmpeg -hide_banner -nostdin -loglevel error -progress pipe:1 -y -copyts
  -f rawvideo -pix_fmt yuv420p -video_size 1280x720 -framerate 30/1 -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 -i pipe:0
  -i "D:\…\sample_clip1.webm"
  -i "D:\…\sample_clip1.webm"
  -i "D:\music\bgm.mp3"
  -/filter_complex "D:\out\final.webm.part.audio.txt"
  -map 0:v:0 -map "[aout]"
  -c:v libvpx-vp9 -crf 16 -b:v 0 -row-mt 1 -pix_fmt yuv420p -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709
  -c:a libopus -b:a 160k
  -f webm "D:\out\final.webm.part"
```

視訊端送 750 幀：t = 0..299 → m1 的 k = 60..359；t = 300..749 → k = 930..1379；每一幀都走 `composite_at(fr, k, plans["m1"])`。

**29.97 fps 變體**（同樣的片段，fps = 30000/1001）：c1 的 `inUs/outUs` = 2 002 000 → 12 012 000、L = S(300) = floor(300 × 1601.6) = 480 480；c2 = 31 031 000 → 46 046 000、delay = 480 480、L = S(750) − S(300) = 1 201 200 − 480 480 = 720 720；總長 S(750) = 1 201 200。片段剛好鋪滿（這組數字進 `map-cases.json`）。

### 7.5 spike 實測（內建 ffmpeg n8.1.2，2026-09-17，`scratchpad/editor/m2spike/`）

合成素材：`src.webm`（VP9＋Opus，50 s，**每個整秒**一個 10 ms 1 kHz 脈衝，−6 dBFS）、`bgm.mp3`（44.1 kHz，每個整秒一個 10 ms 2 kHz 脈衝＋−26 dBFS 440 Hz 底音）。視訊端用 lavfi `color` 代替 rawvideo 管線。量測方法：1 kHz／2 kHz 解調後取 5 ms 滑動平均的包絡，找越過峰值一半的點；偵測器本身的偏差先在來源上量好（−121／−117 樣本）再扣掉。

| 項目 | 結果 |
|---|---|
| §7.4 濾鏡圖語法、`-/filter_complex` 檔案、`adelay …S`、`afade ss/ns`、`volume eval=frame` | 全部可用 |
| 輸出樣本數（ffv1＋pcm_s16le mkv） | **1 200 000**（精確） |
| 輸出樣本數（libopus WebM 解碼後） | **1 200 000**（容器時長 25.008 s 是 Opus pre-skip，解碼後精確） |
| c1／c2 脈衝位置誤差（不加 `-ss`、依 pts 裁切） | **≤ 2 樣本（0.04 ms）**，兩個片段一致 |
| 同上，但輸入端加 `-ss (start−0.5)` | **+48 樣本（1.0 ms）** → 不採用 |
| 音樂脈衝位置（`startUs` 25 057 帶入） | **0 樣本**誤差 |
| 音樂增益 −12 dB（來源 −6.28 dBFS） | −18.28 dBFS（理論 −18.28） |
| 閃避 −10 dB | −28.27（理論 −28.28） |
| 淡入 qsin 中點（片段 1.0 s，共 2 s） | −21.23（理論 −21.29） |
| 淡出 qsin 剩 2/3、1/3 | −19.54／−24.33（理論 −19.53／−24.30） |
| 1 s pts 斷層來源（5～6 s 丟掉），片段 3～10 s | pts 法：脈衝在 0,1,[2 留白],3,4,5,6 s（**正確**）；數樣本法：0,1,2,3,4,5 s（**斷層後整段早 1.000 s**）。**M2.0 更正**：本 spike 原本記成「0,1,2,[3 缺],4,5,6」，是素材做錯 —— 在編碼前用 `aselect` 丟幀，Opus pre-skip 讓一個封包跨過斷層、6 s 的脈衝被搬到 5 s；M2.0 改成封包層丟包（`-bsf:a noise=drop`）重量，結論（pts 法正確、數樣本法早 1.000 s）不變 |

~~還沒驗、列入 M2.0~~ **M2.0 已驗**（數字見 `docs/measurements.md`「M2.0 A/V sync spike」）：rawvideo 管線＋`-copyts`（無損輸出脈衝誤差 ≤ 2 樣本）；mp4（H.264＋AAC，priming 由 edit list 補償，解碼後尾端多 128 樣本，見 I3 例外）；1 小時來源、片段在第 55 分鐘（2.45 s、峰值 25 MiB）；`-copyts` 下 mkv／webm／mp4 muxer 兩條串流 start_time 都是 0，不需要 `-avoid_negative_ts`。

### 7.6 引擎介面

- `media/audio_graph.py`：`build(seq, project, window) -> AudioGraph{inputs:[{path, chainId, clipId}], text, total_samples, notes, peak_estimate_dbfs}`。純函式，不碰 ffmpeg；golden `fixtures/sequence/two-clips-music.graph.txt`（就是 §7.4 那張圖）。
- `media/encode_plan.py`：`EncodeSpec.audio` 多一個 `"mix"`；`EncodePlan.audio_mode ∈ {copy, encode, mix, none}`。plan() 仍然是唯一的一份（決策 6）。
- `media/encoder.py`：`ffmpeg_args(..., audio_inputs=[...], filter_script=Path|None, copyts=bool)`。
- `ops/render.py`：`render.plan` / `render.run` 新參數 `sequence: "auto" | "ignore"`（CLI `--source` = ignore）。`auto` 且序列存在又不是 untouched → `render_sequence_frames` + 音訊圖。plan JSON 新增：

```json
"sequence": { "id": "seq-1", "frames": 750, "duration": "00:00:25:00", "clips": 2, "gaps": 0, "disabled": 0, "audioClips": 1, "untouched": false },
"audio": { "mode": "mix", "codec": "libopus", "reasons": ["分割 / 修剪過片段", "片段增益或淡化", "加入 1 段音訊"],
           "inputs": 3, "samples": 1200000, "graph": "<濾鏡圖全文>", "peakEstimateDbfs": -4.2 }
```

- `aivc audio-mix <project> -o mix.wav [--range T0:T1]`：只跑音訊圖輸出 WAV（QA 用，也可以拿來比對 App 預覽）。
- `aivc seq show <project>`：人類可讀的片段表（序列 TC、來源 TC、k 範圍、替換數）。**M2 的 CLI 不提供剪輯寫入**：剪輯語意在 TS（決策 12），Python 再寫一份一定漂移；要自動化剪輯走 M6 的 MCP → App bridge。
- `peakEstimateDbfs`：由各來源 `peaks.v1.bin` 的桶峰值 × 增益／淡化／自動化的上界相加（保守估計），> −1 dBFS 時 plan 加 note「可能削波：建議降低音樂增益或開啟限幅器」。

---

## 8. App 預覽播放（序列空間）

### 8.1 視訊
- 新 `stage/sequencePlayer.ts`：`playback.seqFrame`（序列幀，新欄位）與 `playback.frame`（**維持 M1 語意：目前媒體的 proxy 幀 k**，舞台疊層、追蹤、遮罩程式全部不用改）。
- 暫停時 seek(t)：`map(t)` → 媒體不同就切 `activeMediaId`（`<video>` 換 src）→ `seekToFrame(k)`（M1 的 +0.5 幀、rVFC 收尾）。空白或停用 → 舞台顯示黑底加「空白」或「已停用」浮水印。
- 播放時：rVFC 回報 k ≥ `clip.srcOut − 1` → 下一個項目：同媒體就 seek 到 `srcIn`，換媒體就換 src 後 seek，空白則用 ticker 以序列 fps 前進黑畫面。**接點會頓約 50～150 ms**（GOP 15 的 proxy 要 seek 解碼）；無縫的雙播放器（預先 seek 好下一段、在接點切換可見性）排在 M2.later。
- J／L 轉盤、範圍播放、循環在序列空間都以 seqFrame 運作（M1 的 `playRange` 參數化「幀空間」）。

### 8.2 原音（A0）
- 聲音直接來自 `<video>` 元素（與畫面天然同步）。增益、淡化、自動化、閃避、靜音的預覽：
  - **首選**：`MediaElementAudioSourceNode → GainNode`，用 `setValueCurveAtTime` 排程，與渲染同一套 dB 曲線（`src/audio/gainCurve.ts` 純函式，給預覽與波形繪製共用）。
  - **前提（M2.11 spike）**：proxy 由 `convertFileSrc` 的 asset protocol 提供；跨來源媒體若沒有 CORS 標頭，`MediaElementSource` 會輸出靜音。要驗 `crossOrigin="anonymous"` 加 Tauri asset protocol 的回應標頭。
  - **退路**：rVFC 每幀設 `element.volume`（30 Hz 階梯，只是預覽）。
- 接點提前 1 幀把元素音量拉到 0、seek 完成再恢復，避免聽到切點之後的幾毫秒。

### 8.3 音訊軌（A1…An）
- `src/audio/preview.ts`：`AudioContext` 加每個音訊媒體一份 `AudioBuffer`（`fetch(convertFileSrc(path))` → `decodeAudioData`）。> 10 分鐘的檔案改用 `<audio>` 元素＋`MediaElementSource`，避免 5 分鐘立體聲就吃 115 MB 的 f32。
- 排程：播放開始時以 `ctx.currentTime` 為錨，把播放視窗（目前位置起 10 s，滾動補排）內的片段各建一個 `AudioBufferSourceNode.start(when, offsetSec, durSec)` → 片段 GainNode（淡化＋自動化曲線）→ 軌道 GainNode（推桿、靜音、獨奏）→ master（`playback.volume`）。
- 時鐘：視訊為主。rVFC 每幀算出「應該在的序列時間」，和 Web Audio 推算的時間差 > 40 ms 就重排（舊的 source 5 ms 淡出停掉、新的淡入）。
- 精度聲明（寫進說明）：預覽 ±10 ms、瀏覽器解碼器的 mp3 延遲處理可能和 ffmpeg 差一個 frame；**輸出以渲染為準**；要逐樣本確認就用「輸出音訊預覽（WAV）」（`aivc audio-mix`）。

---

## 9. 時間軸 UI

### 9.1 兩個空間

`timeline.space: "sequence" | "source"`，時間軸上方的分段控制「序列｜素材：sample_clip1.webm」，`Alt+1`／`Alt+2` 切換。
- **序列空間**（序列存在，或隱含序列）：座標 = 序列幀。隱含序列畫成一個整段片段，看起來跟 M1 幾乎一樣，第一次剪輯之前使用者不會感覺到任何變化。
- **素材空間**：M1 的時間軸原樣（鏡頭帶、縮圖、追蹤車道），另外加兩樣：尺規下方 3 px 橘線標出「已用於序列」的 k 範圍（FCP 瀏覽器的 used-media 指示）；可開關的 A0 波形列（追蹤時也看得到聲音）。
- `F`（對應幀）：序列 → 素材並跳到 k；素材空間按 `F` → 回到序列中第一個使用這個 k 的位置（沒有就提示「這一幀沒有用在序列裡」）。

### 9.2 版面（序列空間，由上而下）

| 列 | 高 | 內容 |
|---|---|---|
| 尺規 | 22 | 序列 TC（M1） |
| 範圍列 | 10 | M1 |
| **V1 片段** | 44 | 片段矩形，內嵌縮圖（依片段的 k 抓 `thumb_strip`）、左上標籤（媒體名／片段名）、右上徽章「替換 3」（此片段來源範圍內有 target 的 track 數）、停用畫斜線、空白畫虛框、離線畫紅框「媒體離線」 |
| **A0 原音** | 36 | 每個片段一段波形（依片段 k 範圍對到 peaks），乘上增益／淡化／自動化後的包絡（波形跟著閃避變小，Resolve／FCP 做法）；淡化三角、音量線；已分離的片段畫成淡灰「已分離 → A1」 |
| 追蹤車道群組 | 可摺疊 | 「追蹤（6）」標頭；展開後每條 track 兩列（M1 的解算／使用者列），**透過對應表分段畫在各片段底下**；車道標籤帶媒體名「m1 · Player1」 |
| **A1…An** | 40（可調 16／40／72） | 音訊片段：圓角矩形、波形、名稱、增益值、淡化把手、音量線、自動化點 |
| 空白放置區 | 24 | 「把音訊檔拖到這裡新增音軌」 |

**左側軌道標頭 `frametimeline/TrackHeaders.tsx`**（DOM，寬 132 px，canvas 右移）：用 DOM 而不是畫在 canvas 上，按鈕才有 focus ring、tooltip、鍵盤可達性。

| 列 | 標頭內容 |
|---|---|
| V1 | 「V1 影像」 |
| A0 | 「A0 原音」、M（靜音）、推桿（dB，雙擊歸零） |
| A1… | 名稱（雙擊改名）、角色圖示（音樂／旁白／音效）、M、鎖定、同步鎖（Premiere 的 sync lock 圖示）、推桿 |
| 追蹤群組 | 摺疊箭頭、數量 |

主題 token（`themes.ts` 加在 `// @colors-end` 前，`check-theme-tokens` 會檢查）：`clip-video`、`clip-audio`、`clip-selected`、`clip-disabled`、`clip-offline`、`gap`、`waveform`、`waveform-rms`、`gain-line`、`fade`、`envelope-point`、`used-in-sequence`。

### 9.3 繪圖（`frametimeline/drawSequence.ts`，純函式，node 可測）
- `layoutSequenceRows(seq, trackIds, laneHeights, {tracksCollapsed})` → 各列 y／h。
- 片段矩形 `x0 = xOfFrame(t0)`、`x1 = xOfFrame(t1)`；音訊片段 `t = sample · num / (48000 · den)`（小數幀）。
- **波形**：`src/audio/peaks.ts` 解析 `AIVP` 後在 worker 建 mip（每層 ×4：5 ms、20 ms、80 ms、320 ms、1.28 s，每層各存 min／max）；繪製時選「每像素 ≤ 4 桶」的最細一層，每個像素畫一條 min→max 的直線（外層 `waveform`），內層畫 ±RMS（`waveform-rms`，Resolve／Audition 的雙色）；振幅乘上 `gainCurve(t)`。
- 追蹤車道分段：對每個片段、每條屬於該媒體的 track，把 `solvedRuns` 的 k 平移 `t0 − srcIn` 後裁在 `[t0, t1)` 內畫；菱形同理。
- 範圍陰影、播放線、hover 線沿用 M1。

### 9.4 命中測試（`frametimeline/hitSequence.ts`，純函式）

新的 `TimelineHit` 種類：`clip{clipId, frame, part: "body"|"edgeIn"|"edgeOut"}`、`gap{gapId, frame}`、`audioClip{clipId, laneId, sample, part: "body"|"edgeIn"|"edgeOut"|"fadeIn"|"fadeOut"|"gainLine"|"envPoint", pointIndex?}`、`audioLane{laneId, frame}`、`tracksHeader`。

同一個位置有多個候選時的優先序（寫成測試）：淡化把手（片段頂端角落 8×8 px，hover 或選取時才出現）> 片段邊緣 ±6 px > 自動化點 ±5 px > 音量線 ±4 px > 本體。邊緣兩側都是片段時，取游標所在的那一側（避免 1 幀片段永遠抓不到另一端，同 M1 `hitRangePart` 的規則）。

### 9.5 滑鼠互動

| 手勢 | V1 片段 | 音訊片段 | 參考 |
|---|---|---|---|
| 點 | 選取（`timeline.focus = "clip"`），播放線不動 | 同左 | Premiere／Resolve |
| Ctrl+點 | 加入／移出選取 | 同左 | 通用 |
| Shift+點 | 同軌延伸選取到這裡 | 同左 | ai-music-cut（Shift 延伸） |
| 拖邊緣 | 波紋修剪；tooltip「修剪開頭 −12 幀｜來源入點 00:00:02:12」；吸附播放線／剪輯點／範圍端點／關鍵幀 | 修剪（不波紋），吸附到幀；**Alt** 拖曳 = 樣本級 | Premiere 修剪 tooltip |
| 拖本體 | M2 不動（重新排序見 M2.later） | 水平移動（吸附）、垂直換軌；重疊時紅框並回彈 | Resolve |
| 拖淡化把手 | — | 設定淡入／淡出長度；tooltip 顯示秒與樣本 | Resolve／FCP |
| 拖音量線 | — | 上下調增益（Shift 細調 0.1 dB）；tooltip「−12.0 dB」 | Premiere rubber band |
| Alt+點音量線 | — | 加自動化點；拖點改位置／dB；Delete 刪點（focus = 自動化點） | Resolve |
| 雙擊 | 素材空間開啟並跳到對應 k（= F） | 開 Inspector「片段」頁 | Resolve 雙擊開片段 |
| 右鍵 | §11 | §11 | — |
| 從檔案總管拖音訊檔進來 | — | 放在游標所在軌的游標時間（吸附）；拖到空白放置區就新增軌（依副檔名與長度猜角色：> 60 s 猜 music） | CapCut |
| 從 Sidebar 拖媒體到 V1 | 插入到最近的剪輯點 | — | Premiere 插入 |
| 刀片工具（`Shift+B`） | 點 = 在游標處分割（虛線預覽、吸附）；Shift+點 = 全部軌 | 同左 | Premiere C／Resolve B |
| Esc | 取消選取；刀片工具退回選取工具 | 同左 | ai-music-cut `select.clear` |

---

## 10. 指令與快捷鍵

新增 `CommandGroup`：`"sequence"`（選單列「序列」）與 `"audio"`（選單列「音訊」）。所有新指令都走註冊表（`registry.test.ts` 的 `duplicateChords` 必須是空的）。

### 10.1 刪除鍵依焦點派發

M1 把 `Delete/Backspace` 綁在 `edit.deleteKeyframe`、`Shift+Delete` 綁在 `edit.deleteTrack`。M2 把這兩組鍵移給兩個派發指令，原本兩個指令保留在選單與右鍵、拿掉快捷鍵（`shortcutOf` 顯示派發鍵）：

| `timeline.focus`（最後一次點到的東西） | `edit.delete`（Delete／Backspace） | `edit.deleteAlt`（Shift+Delete／Shift+Backspace） |
|---|---|---|
| `clip`（V1 或音訊片段） | `sequence.rippleDelete` | `sequence.lift` |
| `range`（序列空間、最後操作是拖範圍或 I／O） | `sequence.extractRange` | `sequence.liftRange` |
| `envPoint` | 刪自動化點 | 刪自動化點 |
| `keyframe` | `edit.deleteKeyframe`（M1） | `edit.deleteTrack`（M1 相容） |
| `track`（點了車道） | —（停用，why：「先選片段、範圍或關鍵幀」） | `edit.deleteTrack`（M1 相容） |
| 無 | 有選取片段 → 同 clip；否則停用 | 同左 |

焦點規則：點片段 → clip；點菱形 → keyframe；點車道 → track；拖範圍或按 I／O → range；Alt+點音量線 → envPoint；Esc 清成 null。狀態列最右邊顯示「Delete：波紋刪除 2 個片段」這種提示，讓使用者按下去之前就知道會發生什麼。

### 10.2 新指令表

| id | 標題 | 快捷鍵 | 參考 | enabled |
|---|---|---|---|---|
| `sequence.split` | 在播放線分割（再按一次合併切點） | **B**、`Ctrl+\` | ai-music-cut B／Resolve Split Clip | needsProxy；播放線在片段內部或在可合併的切點上 |
| `sequence.splitAll` | 在播放線分割所有軌 | `Ctrl+Shift+\` | Premiere Add Edit to All Tracks | 同上 |
| `sequence.tool.blade` | 工具：刀片 | `Shift+B` | Resolve B／Premiere C | needsProxy |
| `edit.delete` | 刪除（波紋） | Delete、Backspace | ai-music-cut／FCP／CapCut | 依焦點（§10.1） |
| `edit.deleteAlt` | 刪除（留空隙） | Shift+Delete、Shift+Backspace | ai-music-cut 提起／FCP Replace with Gap | 依焦點 |
| `sequence.rippleDelete` | 波紋刪除片段 | （派發） | Premiere Ripple Delete | needsClipSelection |
| `sequence.lift` | 刪除片段（留空隙） | （派發） | Premiere Clear | needsClipSelection |
| `sequence.extractRange` | 提取範圍（後面接上） | （派發） | Premiere Extract `'` | needsRange ∧ space=sequence |
| `sequence.liftRange` | 移除範圍（留空隙） | （派發） | Premiere Lift `;` | 同上 |
| `sequence.toggleEnabled` | 停用／啟用片段 | **D** | Resolve D | needsClipSelection |
| `sequence.detachAudio` | 分離音訊 | `Ctrl+Alt+L` | Resolve Link／FCP Detach Audio | 選取的 V1 片段有原音且未分離 |
| `sequence.rippleTrimStart` | 修剪開頭到播放線（波紋） | `Ctrl+Shift+[` | Resolve Ripple Start to Playhead | 播放線在片段內 |
| `sequence.rippleTrimEnd` | 修剪結尾到播放線（波紋） | `Ctrl+Shift+]` | Resolve Ripple End to Playhead | 同上 |
| `sequence.matchFrame` | 對應幀（序列 ⇄ 素材） | **F** | Premiere／Resolve F | needsProxy |
| `sequence.prevEdit` / `nextEdit` | 上／下一個剪輯點 | ↑／↓（序列空間） | Premiere／Resolve | space=sequence |
| `playback.markShot`（改） | 序列空間：將播放線所在片段設為範圍；素材空間：鏡頭（M1） | X | Premiere／Resolve Mark Clip | M1 |
| `sequence.appendMedia` | 將目前媒體接到序列結尾 | — | FCP Append（E 被佔用） | needsProxy；fps／尺寸相符 |
| `sequence.insertMedia` | 在播放線插入目前媒體 | — | FCP Insert | 同上 |
| `sequence.selectAll` | 全選片段 | `Ctrl+A`（序列空間） | 通用 | space=sequence |
| `sequence.settings` | 序列設定… | — | Premiere Sequence Settings | 序列存在 |
| `view.timelineSequence` / `view.timelineSource` | 時間軸：序列／素材 | `Alt+1`／`Alt+2` | Premiere Program／Source | — |
| `view.toggleSnap` | 吸附 | `Shift+N` | ai-music-cut N（N 已被佔） | — |
| `view.toggleWaveforms` | 顯示波形 | — | — | — |
| `audio.import` | 加入音訊檔… | — | Premiere Import | — |
| `audio.addAtPlayhead` | 在播放線加入音訊… | — | CapCut | — |
| `audio.newLane` | 新增音軌 | — | — | — |
| `audio.toggleClipMute` | 靜音／取消靜音片段 | — | — | needsAudioSelection |
| `audio.applyDefaultFades` | 套用預設淡入淡出（0.5 s） | `Ctrl+Shift+D` | Premiere 預設音訊轉場 | needsAudioSelection |
| `audio.duckRange` | 在範圍內閃避（−10 dB） | — | — | needsRange ∧ 範圍內有音訊片段 |
| `audio.muteRange` | 在範圍內靜音 | — | — | 同上 |
| `audio.clearAutomation` | 清除音量自動化 | — | — | needsAudioSelection |
| `audio.renderPreview` | 輸出音訊預覽（WAV）… | — | — | needsEngine ∧ 序列存在 |
| `audio.recordVoiceOver` | 錄旁白…（M2.later） | — | Premiere Voice-over Record | 停用，why：「下一版」 |

**不綁鍵的理由**：`Q`（顯示表面）、`W`（留給 Q 的對稱鍵）、`C`（從遮罩取角）、`N`（新增追蹤）、`M`（傳播遮罩）、`S`（切鏡頭）、`A`（加選）、`V`（表面工具）、`Ctrl+K`（命令面板）、`Ctrl+D`（找物件）、`Ctrl+L`（循環）、`Ctrl+I`（媒體資訊）、`Ctrl+Shift+S`（另存）都已被 M1 或 v0.0.6 佔用；市售軟體在這些鍵上的對應功能只放選單、右鍵與命令面板（關鍵字含英文名：`razor`、`blade`、`ripple`、`detach`、`unlink`、`duck`、`fade`）。

**S（切鏡頭）與 B（分割片段）的混淆**：兩者都是「切」。說明文字寫清楚：`S` 是「切鏡頭（給追蹤用，不影響輸出）」、`B` 是「分割片段（剪輯）」；序列空間按 `S` 時 toast 補一句「要剪片請按 B」（每個 session 只提示一次）。

---

## 11. 右鍵選單新增（`commands/menuModel.ts`）

`TimelineContextTarget` 新增 `clip`、`gap`、`audioClip`、`audioLane`、`laneHeader`。選單都走 `cmd()`／`adhoc()`，停用項目顯示原因。

**V1 片段 `clipMenuItems`**
1. 在播放線分割（B）／在這裡分割（點到的幀）
2. 波紋刪除（Delete）／刪除（留空隙）（Shift+Delete）
3. 停用片段（D，勾選狀態）
4. ─ 原音 ▸：靜音原音（勾選）／分離音訊（Ctrl+Alt+L）／淡入 ▸（無、0.5 s、1 s、2 s）／淡出 ▸／增益 ▸（+3、0、−3、−6、−12 dB、自訂…）
5. ─ 修剪開頭到播放線（Ctrl+Shift+[）／修剪結尾到播放線（Ctrl+Shift+]）
6. 將片段設為範圍（X）
7. ─ 在素材中開啟（對應幀，F）／在此片段新增追蹤（跳到素材空間並觸發 `track.new`）
8. 在這裡加入音訊…
9. 片段資訊…（開 Inspector「片段」頁）

**空白 `gapMenuItems`**：刪除空白（後面接上）／在這裡插入目前媒體。

**音訊片段 `audioClipMenuItems`**
1. 分割／波紋刪除／刪除
2. 靜音片段（勾選）
3. 增益 ▸（同上）；淡入 ▸；淡出 ▸；淡化曲線 ▸（線性、等功率，勾選）
4. ─ 在範圍內閃避（−10 dB）／在範圍內靜音（沒有範圍時停用，why：「先按 I／O 或拖出範圍」）／清除音量自動化
5. ─ 移到新音軌／替換音訊檔…／在檔案總管中顯示
6. 來自原音時：「跳到來源片段」

**音訊軌空白 `audioLaneMenuItems`**：在這裡加入音訊…／新增音軌／刪除音軌（非空時停用）／靜音軌（勾選）／同步鎖（勾選）／角色 ▸（音樂、旁白、音效、其他）

**範圍 `rangeMenuItems`（M1）追加**（序列空間）：提取範圍（後面接上）／移除範圍（留空隙）／在範圍內閃避所有音樂軌／在範圍內靜音原音／只輸出範圍（M1）

**尺規與空白 `frameMenuItems`（M1）追加**：在這裡分割所有軌／在這裡加入音訊…

**舞台 `stageMenuItems`（M1）追加**（序列空間）：在播放線分割／停用此片段／在素材中開啟

**Sidebar 媒體 `mediaMenuItems`（M1）追加**：接到序列結尾／在播放線插入；音訊媒體：加到播放線、在檔案總管中顯示、從專案移除（有片段在用時確認「會一併刪除 N 個片段」）

---

## 12. Inspector、對話框與專業資訊

- **Inspector 新頁 `clip`**（`RailTab` 加 `"clip"`，選到片段時自動切過去；可釘住）：
  - V1 片段：媒體名與路徑；**來源 TC 入／出**（k 與媒體 timecode 標籤換算）；**序列 TC 入／出**；時長（幀＋TC）；proxy fps 與 scale；此範圍的 VFR 事實（「含 3 個定格重複幀（來源斷層 1.20 s @ 00:00:01:06）」，來自 CfrMap runs）；**替換目標**：此範圍內有 target 的 track 列表「Player1 8♥ → 9♦，解算 297/300 幀，hold 3」；原音：codec／取樣率／聲道、**音訊相對視訊 −6.5 ms**（`startUs − videoStartUs`）、增益、淡化、自動化點數。
  - 音訊片段：檔名、codec／取樣率／聲道／位元率、來源入點（`hh:mm:ss.mmm`＋樣本）、序列位置、長度、增益、淡化與曲線、自動化點表（可編輯）、**片段峰值**（peaks 算的 dBFS，套增益後的估計）、所屬軌。
- **狀態列**：序列空間顯示「序列 00:00:12:03｜m1 00:00:33:03（k 993）」，兩個時間碼同時給。
- **輸出對話框**（M1 ExportDialog 擴充）：來源選擇「序列 seq-1（25.0 s，2 片段、1 音樂）／只輸出目前素材（忽略序列）」；音訊一行白話「音訊：重新混音 → Opus 160 kbps（原因：分割 2 處、加入 1 段音樂）」或「音訊：直接複製（序列未修改）」；範圍綁序列的 in／out；可能削波的警告；輸出後驗收：`ffprobe` 視訊幀數 = T、音訊解碼樣本數 = S(T)（mp4／AAC 允許多 0～1023，§1.2 I3 例外），時長差 ≤ 1 幀。
- **序列設定對話框**：fps 與尺寸（M2 唯讀，顯示「由 V1 媒體決定」）、取樣率 48 kHz（唯讀）、防爆音淡化 ms、限幅器、預設淡化長度、輸出音訊位元率。
- **媒體資訊對話框**（M1）追加：音訊相對視訊延遲、pts 斷層清單、nSamples（來自 `audio.v1.json`）。

---

## 13. 里程碑拆解（每步 ≤ 半天、各自可出貨）

每一步結束都要：`npm run check`、`cargo test --no-default-features`、引擎 CPU suite（`PYTHONPATH=…\engine\src`、pyenv python、`PYTHONUTF8=1`）全綠，並做一個繁中 Conventional Commit（版號依當時的 package.json）。序列 UI 在 M2.17 之前藏在 `settings.experimental.sequence`（設定頁「序列剪輯（預覽）」，預設關）後面，所以 M2.9～M2.16 中途出貨不會讓使用者看到半成品。

| 步驟 | 內容 | 驗收測試 | 估時 |
|---|---|---|---|
| **M2.0** spike | `scripts/make-av-sync-fixture.mjs`（內建 ffmpeg 產生脈衝素材：WebM VP9＋Opus、MP4 H.264＋AAC、含 1 s 斷層版、mp3）；以 rawvideo 管線跑 §7.4 的圖；1 小時來源、片段在 55 分鐘處量峰值 RSS 與耗時；mp4 輸出 priming 驗證。數字寫進 `docs/measurements.md` | 各容器脈衝誤差 ≤ 2 樣本；解碼樣本數 = S(T)；1 小時案例 RSS < 500 MB；斷層素材 pts 法正確 | 3 h |
| **M2.1** TS schema v2 | `format.ts` 型別與預設、`migrate.ts` toV2、`sanitize.ts` 序列規則、`buildProjectFile` 最低版本寫檔、`fixtures/project/v2/two-clips-music.aivc.json` | v1 fixture 讀進寫出除 `updatedAt` 外逐位元相同且 `schemaVersion: 1`；v2 fixture 的 sanitize 警告清單 golden；重疊、懸空 detached、淡化超長各一個案例 | 3 h |
| **M2.2** Python schema＋對應 | `schema.py` v2 dataclasses、`written_version`、`sequence/model.py`；`fixtures/sequence/map-cases.json` 兩邊共用 | pytest：v1／v2 讀寫往返、`extra` 保留；TS 與 Python 都通過 map-cases（含 29.97 鋪滿性質：Σ片段長 = S(T)）；`schemaVersion 3` 拒絕 | 3 h |
| **M2.3** TS 剪輯純函式 | `src/sequence/ops.ts`（§5.2 全部）、`validateSequence` | ≥ 40 個 vitest 案例；每個案例都跑 `validateSequence`；syncLock 開／關各一組；分割後自動化曲線在切點兩側取樣值不變（誤差 < 0.01 dB） | 4 h |
| **M2.4** undo 整合 | `edits.ts` 的 Snapshot／`PROJECT_SCOPE`／`editSequence`／`loadSequence`；`clear` 規則；`store/project.ts` 讀檔與存檔接線；i18n 標籤與 `en.ts` | 分割後 undo：`sequence` 回到 null 且 `tracks` 參照相同（I1）；追蹤 patch 與序列 patch 交錯 20 步來回 undo／redo 一致；移除媒體會清歷史；自動存檔往返 | 3 h |
| **M2.5** 引擎 audio_info | `media/audio_info.py`、op `media.audio_info`、`audio.v1.json`、Python probe 補音訊 `start_us`；前端開檔時跑並寫入 `media[].audio` | pytest：合成素材的 `startUs`（mp3 25 057）、`gaps`（1 s 斷層素材）、`nSamples`；缺快取時標 stale 重算 | 3 h |
| **M2.6** 音訊圖建構（純函式）＋plan | `media/audio_graph.py`、`encode_plan` 的 `mix` 模式、`render.plan` 輸出 `sequence`／`audio` 區塊、`is_untouched` | golden：§7.4 圖逐字相同；案例：29.97、inUs 早於串流開始（leadPad）、停用片段、靜音軌、空白、單聲道 pan、範圍 trim、> 32 輸入改走 stem；v1 專案的 plan golden 不變（I4） | 4 h |
| **M2.7** 序列渲染 | `render_sequence_frames`、encoder 多輸入＋`-/filter_complex` 檔、`--source`、顆粒種子改用 track id、`aivc audio-mix`、`aivc seq show` | CPU pytest：幀號編進像素的合成素材做倒序兩片段，輸出每幀的幀號等於對應表；ffv1 驗 I2（序列 t 幀 == 來源 k 幀逐位元）；mkv＋pcm 驗 I3 與脈衝對齊；既有 `test_render` 在更新顆粒 golden 後全綠 | 4 h |
| **M2.8** Rust peaks＋TS 解析 | `peaks.rs`（移植 Analyzer）、`media_peaks` 指令、`src/audio/peaks.ts`＋mip worker、`pipeline/peaks.ts`（inflight Map＋job，照 ai-music-cut `waveform.ts` 的形狀） | cargo test：打包版面、header 驗證、magic 不符擲錯；vitest：golden bytes 解析、mip 每層 min／max 正確；快取命中不重算 | 3 h |
| **M2.9** 時間軸：V1＋A0 繪圖（旗標後） | `timeline.space`、`layoutSequenceRows`、`drawSequence.ts`（片段、縮圖、徽章、停用、空白、A0 波形與增益包絡、追蹤車道分段）、分段控制 | draw 測試：版面快照、片段 x 座標、追蹤分段平移；29.97 時音訊片段的 x 誤差 < 0.5 px | 4 h |
| **M2.10** 軌道標頭＋音訊軌繪圖＋命中 | `TrackHeaders.tsx`、A1…An 繪圖、`hitSequence.ts`、主題 token | 命中優先序測試（淡化把手 > 邊緣 > 自動化點 > 音量線 > 本體）；1 幀片段兩端都抓得到；`check-theme-tokens` 綠 | 4 h |
| **M2.11** 序列預覽播放 | `stage/sequencePlayer.ts`、`playback.seqFrame`、接點 seek／換媒體、空白前進、A0 增益（先做 MediaElementSource 的 CORS spike，失敗走 volume 退路） | 純函式 `nextBoundaryAction(seq, t)` 測試；手動腳本（`scripts/measure/`）：播放線永遠不會顯示片段 `[srcIn, srcOut)` 以外的幀；接點頓挫 ≤ 150 ms（scrub-drops 量尺） | 4 h |
| **M2.12** 分割／刪除／停用＋選單＋派發 | §10 的 split／splitAll／blade／edit.delete／edit.deleteAlt／rippleDelete／lift／extract／liftRange／toggleEnabled／matchFrame／prev/nextEdit、`timeline.focus`、`clipMenuItems`／`gapMenuItems`／範圍與尺規追加、ShortcutsHelp | `duplicateChords` 為空；隱含序列上按 B 會實體化並分割，一次 Ctrl+Z 回到 null；焦點派發表 7 種情況各一個測試；menuModel 測試：片段目標選單內容與停用原因 | 4 h |
| **M2.13** 修剪＋吸附 | `trimDrag.ts`（照 `rangeDrag.ts` 的無狀態重算風格）、邊緣拖曳、Ctrl+Shift+[ ]、吸附目標加片段邊緣、`view.toggleSnap`、tooltip | 純函式測試：夾在媒體邊界、長度 ≥ 1 幀、V1 波紋位移、syncLock 軌跟著動、Esc 還原、吸附指示 | 3 h |
| **M2.14** 加媒體到序列＋匯入音訊＋音訊片段放置 | append／insert、Sidebar 拖放、`audioMedia` 匯入（檔案對話框與 OS 拖放）、音訊軌新增、`addAudioClip`／`moveAudioClip`、peaks job | 拖入 wav／mp3／m4a／flac／opus：片段出現在放下的幀（吸附）；fps 不符顯示可操作錯誤；Ctrl+Z 一次移除片段與 audioMedia；純音訊檔的 `media_probe` 通過（ffmpeg.rs 的「音視訊皆無才錯」） | 4 h |
| **M2.15** 音訊片段編輯＋Inspector「片段」頁 | 增益線、淡化把手、自動化點、`duckRange`／`muteRange`／`clearAutomation`、`detachAudio`、`audioClipMenuItems`／`audioLaneMenuItems`、Inspector clip 頁、狀態列雙時間碼 | duck 跨兩個片段兩邊都有點；分離後的 `srcIn` 在 `startUs ≠ videoStartUs` 時正確（測試用 startUs = 6 500、videoStartUs = 0）；音訊圖 golden 含運算式；Inspector 的數值與 plan 一致 | 4 h |
| **M2.16** A 軌 Web Audio 預覽 | `src/audio/preview.ts`、`gainCurve.ts`（預覽與繪圖共用）、軌道靜音與獨奏、重排同步 | `planAudioSources(seq, t, window)` 純函式測試；手動：60 s 播放漂移 < 40 ms；閃避與淡化聽得到且與波形包絡一致 | 4 h |
| **M2.17** 輸出 UI＋驗收＋打開旗標 | ExportDialog 序列來源／音訊白話／削波警告、輸出後 ffprobe 驗收、序列設定對話框、`AIVC_DEV_EXPORT` 支援序列、旗標預設改開、README 與說明 | E2E：範例影片兩片段＋音樂 → 750 幀、音訊 1 200 000 樣本（mp4 輸出允許多 0～1023）、時長差 ≤ 1 幀；`aivc bench av-sync` 對脈衝素材通過；未剪輯的專案輸出與 v0.0.6 相同（`-c:a copy`、封包數 1000 = 1000） | 4 h |
| **M2.18** proxy 音訊對齊（proxy v2） | proxy 產生改用 §7.3 的鏈（`-copyts`＋`atrim start=videoStartUs`＋async），`proxy.v1.json` 的 `version` 升 2，舊 proxy 標 stale | 在 `audio.startUs ≠ videoStartUs` 的素材上，proxy 的 A/V 誤差 ≤ 1 ms（v1 proxy 會差 `videoStartUs − startUs`） | 2 h |

**M2.later（不在本輪）**
- V1 拖曳重新排序（Ctrl+拖＝插入移動）與 Ctrl+X／Ctrl+V 片段（ai-music-cut `edit.move` 的語意）。
- 雙播放器無縫預覽。
- 錄旁白：WebView2 `getUserMedia` 加 `MediaRecorder`（audio/webm;codecs=opus）→ Rust 寫到 `<專案>.assets/vo/VO-001.webm` → 匯入 → 片段放在錄音起點。支援預捲 2 s、倒數；延遲補償 = `AudioContext.outputLatency` 加輸入延遲，並可在設定手動微調（Premiere／Resolve 都有這個欄位）。也可以參考 ai-music-cut `record.rs` 的 raw-body IPC 路線。
- 自動閃避：`sidechaincompress`，旁白軌驅動音樂軌。
- 混合 fps／尺寸的 conform（最自然的做法是用序列 fps 重建 proxy，本架構的 proxy 本來就是從 VFR 產生的 CFR）。
- 多條序列、音量表（AnalyserNode）、響度正規化（loudnorm 兩段式：−14 LUFS 串流平台、−23 LUFS EBU R128）、多音軌來源（MOV 雙麥）、覆寫式編輯、drop-frame 時間碼。

---

## 14. 風險

### 14.1 VFR 來源的 A/V 同步
| 風險 | 說明 | 對策 |
|---|---|---|
| 視訊與音訊用了不同的時間定義 | 視訊端 k → CfrMap「(k+0.5)/fps 時螢幕上的來源幀」；音訊端若用數樣本，遇到斷層就整段錯位 | 音訊一律用容器絕對 pts（`-copyts`＋`atrim start=videoStartUs + k/fps`）＋`aresample async=1` 補斷層；§7.5 已實測（數樣本法斷層後早 1.000 s） |
| 輸入端 `-ss` 的誤差 | Opus/WebM 的 pts 是整數 ms，seek 後第一個封包的 pts 捨入，實測晚 48 樣本 | 不用 `-ss`，從頭解（音訊解碼 ~500 倍即時）；1 小時來源的成本在 M2.0 量 |
| 定格跨越切點 | CfrMap 的定格（範例在 k=1..36）剛好被切開時，切點兩側顯示同一個來源幀 | 預期行為；刀片 hover tooltip 提示「此處為定格重複幀（來源斷層）」 |
| mp3 沒有 LAME 標頭 | 沒有標頭時 ffmpeg 無法得知 encoder delay，音樂整體晚約 24～26 ms（相對音樂自己的時間軸，不影響 A/V） | 只影響音樂的絕對位置；Inspector 顯示「未偵測到編碼延遲資訊」 |
| AAC priming（mp4） | 1024／2112 樣本的 priming 靠 edit list；外來 mp4 的 edit list 可能是錯的 | M2.0 以脈衝素材驗 mp4 路徑；`audio_info` 把 `startUs` 為負的情況記成 note |
| `-copyts` 的副作用 | 全域旗標；muxer 可能遇到負 timestamp | 每條鏈都 `asetpts=PTS-STARTPTS`、混音輸出從 0 開始；M2.0 驗 mp4／webm muxer；必要時加 `-avoid_negative_ts make_zero` |
| proxy 的預覽聲音偏移 | 現行 proxy 不帶 `-copyts`、音訊以檔案起點為 0；`startUs < videoStartUs` 時預覽聲音晚 | M2.18 proxy v2；在那之前 Inspector 顯示偏移量 |
| 預覽時鐘漂移 | `<video>` 與 `AudioContext` 各有時鐘 | 以視訊為主，> 40 ms 重排；聲明「預覽 ±10 ms、以輸出為準」 |
| asset protocol 的 CORS | `MediaElementSource` 遇到沒有 CORS 標頭的跨來源媒體會輸出靜音 | M2.11 先做 spike；退路是用 `element.volume` 做 30 Hz 近似 |

### 14.2 CFR proxy 上的幀準分割
| 風險 | 說明 | 對策 |
|---|---|---|
| 分割只能落在 proxy 幀邊界 | 來源是 VFR，被 CfrMap 丟掉的來源幀（抖動）沒辦法單獨切到 | 設計上可接受（輸出本來就是 CFR）；媒體資訊顯示丟幀數 |
| 預覽 seek 顯示錯幀 | 瀏覽器 seek 在幀邊界上會二選一 | 沿用 M1 的 +0.5 幀偏移與 rVFC 收尾；`seek-accuracy` 量尺在序列接點各跑一次 |
| 引擎 seek 解碼錯幀 | VP9 altref／hidden frame、關鍵幀稀疏 | FrameSource 以 pts 對回 PtsIndex（不是數解出來第幾幀）；M2.7 加測試：隨機 k 用 seek 解出來的平面 == 循序解（逐位元） |
| 縮圖在接點差一幀 | `-ss` 精度 | 沿用 `thumbs.rs` 的「退半幀」；片段內縮圖以片段 k 取樣 |
| 29.97 的時間碼 | 目前 `timecode()` 是 non-drop（每秒 30 格），一小時差 3.6 s | M2 的序列 TC 標「NDF」；drop-frame 放 M2.later |
| 顆粒種子跟 job 順序有關 | 序列渲染只建部分 job 時，顆粒會跟「來源渲染」不同，破壞 I2 | M2.7 改成 `stable_hash(track.id)`，更新 golden |

### 14.3 樣本級修剪
| 風險 | 說明 | 對策 |
|---|---|---|
| 片段接縫的縫隙或重疊 | 每個片段各自 round | `S(t)` 一律 floor、從絕對 t 算；map-cases 測「Σ片段長 = S(T)」 |
| 重取樣邊緣 | swr 的濾波器在硬切處振鈴、前後幾個樣本失真 | 先在原生取樣率 `atrim`，重取樣後再 `atrim=end_sample`；3 ms 防爆音淡化蓋掉振鈴 |
| 長度被悄悄墊長 | `asetnsamples` 預設 `p=1` 會把最後一個 frame 補零 | 寫死 `p=0`；最後再 `apad,atrim=end_sample=S(T)` 收斂 |
| 音量被縮小 | `amix` 預設 `normalize=1` | 寫死 `normalize=0`，golden 檢查 |
| 限幅器改響度、加延遲 | `alimiter` 預設 `level=true`、`latency=false` | 預設不加；加的時候明寫 `level=0:latency=1` |
| `volume eval=frame` 的階梯雜音 | 一個 frame 20 ms | `asetnsamples=n=240`（5 ms） |
| 命令列長度 | Windows 32 767 字元 | `-/filter_complex <file>` |
| 輸入太多 | 每個 `-i` 一條 demux/decode 執行緒 | > 32 個輸入改走每軌 stem 兩段式 |
| `atrim start` 的解析度 | µs；超過 6 位小數會被截斷而不是四捨五入 | 一律印 `%.6f`，值由整數 µs 算出 |
| 單聲道與多聲道 | 自動降混或升混的係數會改變響度 | mono 明寫 `pan`；5.1 以上記 note |
| 同一來源共用解碼器 | `asplit` 會讓 `amix` FIFO 無上限堆積 | 每條鏈一個 `-i`，靠 ffmpeg 7+ 排程器的背壓；M2.0 量峰值 RSS |

### 14.4 其他
- **Schema／undo**：降版（§4.3 最低版本寫檔）；`clear(mediaId)` 從中間抽 patch 會破壞專案層欄位（§6，連 M1 的 deck 一起修）；proxy 以不同 fps 重建時片段超界 → 標離線，不刪除。
- **TS／Python 雙實作漂移**：對應表與 `isUntouched` 各有一份 → 共用 `map-cases.json`；剪輯寫入只有 TS 一份（CLI 唯讀）。
- **快捷鍵搬家**：Delete／Shift+Delete 從「刪關鍵幀／刪追蹤」改成依焦點派發；狀態列即時顯示「Delete 會做什麼」，ShortcutsHelp 與 CHANGELOG 明寫。
- **效能**：跨片段 seek（範例最壞 ~0.15 s／切點）；1 小時檔案的 peaks 解碼約 20～40 s（Jobs 顯示進度、可取消）；波形 mip 讓整段適配時每像素 ≤ 4 桶。
- **使用者心智**：鏡頭（追蹤用）與片段（剪輯用）是兩個「切」；隱含序列第一次剪輯時實體化，UI 要在序列分段控制上顯示「已剪輯」小點，讓「現在輸出會重新混音」這件事看得到。

---

## 15. 決策紀錄（本設計新增）

| # | 決策 | 理由 |
|---|---|---|
| D1 | `sequence: null` ＝ 隱含序列，第一次剪輯才實體化 | v1 升版不需要 proxy 幀數；未剪輯的專案行為與輸出完全不變 |
| D2 | V1 磁吸，空白用 GapV2 | 位置不用存、波紋天然成立；空白仍可表達 |
| D3 | 原音是 V1 片段元件，分離後才是 A 軌片段 | 99% 情況零同步成本，J/L cut 由分離解決 |
| D4 | 音訊時間：序列樣本 48 kHz、來源原生樣本；fps 換算一律從絕對 t 算 | 樣本級精度；片段鋪滿不留縫 |
| D5 | 對齊用容器絕對 pts（`-copyts`），不數樣本、不用輸入端 `-ss` | §7.5 實測 |
| D6 | 每片段一個 `-i`＋一條鏈，濾鏡圖寫檔 | 背壓、命令列長度 |
| D7 | `-c:a copy` 只在 `isUntouched` 時 | 使用者要求；比的是值不是 null |
| D8 | 最低版本寫檔 | 自動存檔不會悄悄讓舊版打不開 |
| D9 | 刪除鍵依焦點派發；B／Delete／Shift+Delete 對齊 ai-music-cut | 同一位使用者的肌肉記憶 |
| D10 | 音樂軌預設不跟波紋（syncLock=false） | 墊樂釘在成品時間（ai-music-cut `mix.rs`） |
| D11 | 獨奏不存檔、靜音會影響輸出 | 監聽狀態不該改變成品 |
| D12 | peaks 在 Rust、時間原點＝容器絕對時間、新 magic `AIVP` | 不依賴 Python 引擎；和渲染同一個時間域；magic 不同，讀錯會當場擲錯而不是默默錯位 |
| D13 | 替換、追蹤、遮罩永遠以來源 k 為鍵，序列只是對應表 | 剪輯永遠不會讓 tracks／masks 失效（I1、I2） |
