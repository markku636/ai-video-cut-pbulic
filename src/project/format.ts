// 專案檔（*.aivc.json）格式：schemaVersion 版本化；後端只搬運 JSON，結構在此定義（計畫 §5.6，TS 為 SoT）。
// Python `project/schema.py` 讀同一份 JSON、共用 engine/tests/fixtures/project/v1/ 與 fixtures/project/v2/。硬性規則：**不含任何祕密**。
//
// 幾個刻意的選擇：
// - keyframes 存 quad 不存 H：H 是解算結果，quad 才是使用者釘下去的東西；H 可以重算，quad 不能。
// - `insert` 的 null 欄位 = 繼承 `insertDefaults`（Silhouette 的「Default」哨兵），所以專案層改預設會跟著動。
//
// 外掛（plugins/<id>/，例如牌外掛）擁有的鍵不在這裡定義：頂層（cardSlots / deck）、track 頂層（slotId）、
// options / insert 裡的外掛鍵由外掛登記（src/plugins/api.ts ProjectFileContribution），型別由外掛用 module augmentation
// 補進下面的介面。外掛不在時這些鍵原樣保留（頂層走 project extras、track 走 extra、options / insert 走未知鍵保留），
// 磁碟格式一個位元組都不變。
import type { MediaProbe, ProxyMeta, Rational } from "../api";
import type { PluginMediaState, PluginProjectState } from "../plugins/api";
import { collect, plugins } from "../plugins/registry";

export type { Rational };

/**
 * 記憶體裡的 schema 版本（migrate 升到這一版）。v2 = 序列剪輯與音訊（docs/editor-m2-design.md §3）。
 * 寫檔時不一定寫這個數字：見 `writtenSchemaVersion`（最低版本寫檔，§4.3）。
 */
export const SCHEMA_VERSION = 2 as const;
/** 實際寫進檔案的版本：沒用到 v2 功能就寫 1（§4.3），v0.0.6 還打得開。 */
export type WrittenSchemaVersion = 1 | 2;

/** 來源像素空間的四邊形，順序 TL, TR, BR, BL。 */
export interface Quad {
  p: [[number, number], [number, number], [number, number], [number, number]];
}

export type ProjectMediaV1 = {
  id: string;
  path: string;
  name: string;
  fingerprint: string;
  probe: MediaProbe | null;
  /** 引擎 media.proxy 的中繼資料；null = 還沒產生 proxy（快取缺就標 stale 重生）。 */
  proxy: ProxyMeta | null;
};

export type ShotKind = "close" | "wide" | "unknown";

export interface ShotV1 {
  id: string;
  startFrame: number;
  /** 不含。 */
  endFrame: number;
  kind: ShotKind;
  source: "auto" | "user";
}

export interface KeyframeV1 {
  frame: number;
  quad: Quad;
  source: "user" | "detector";
  /** Point Lock：鎖住的角不再被重解動到。 */
  lockedCorners?: [boolean, boolean, boolean, boolean];
}

/** label 1 = 加選、0 = 減選（Kling / Photoshop 慣例）。 */
export interface PromptPointV1 {
  x: number;
  y: number;
  label: 0 | 1;
}

export interface PromptV1 {
  frame: number;
  points: PromptPointV1[];
}

/** AdjustTrack 的參考點。 */
export interface ReferencePointV1 {
  id: string;
  frame: number;
  /** 吸附到表面哪一角；null = 自訂特徵點。 */
  cornerIndex: 0 | 1 | 2 | 3 | null;
  xy: [number, number];
  locked: boolean;
  /** 主要參考影格（Mocha 紅 X）：這一點以哪一幀為基準。 */
  primaryFrame: number;
}

export type MotionModel = "translation" | "similarity" | "affine" | "perspective";
export type TrackMethod = "classic" | "dense";

/** 外掛可以在這裡加鍵（module augmentation，例如 cards 的 templateCard）；核心只管下面三個。 */
export interface TrackOptionsV1 {
  method: TrackMethod;
  motionModel: MotionModel;
  /** 0–1；UI「平滑 40%」對到 Savitzky-Golay window。 */
  smoothing: number;
}

export type InsertMacro = "conservative" | "standard" | "full" | "custom";
export type EdgeFalloff = "linear" | "smoothstep";
export type ShutterPhase = "centered" | "start" | "end" | "custom";
export type ResampleKernel = "nearest" | "bilinear" | "bicubic" | "lanczos3";
/**
 * 反光鎖定：plate = 反光跟著鏡頭（逐幀估）。外掛可以加值（`vocabulary.sheenLock`）；
 * 不認得的值原樣保留（可能屬於沒裝的外掛），磁碟上的字串不變。
 */
export type SheenLock = "plate" | (string & {});
export type GrainMode = "measured" | "synthetic";

/**
 * 插入參數（Nuke CornerPin2D / BCC / Mocha Insert 語意；計畫 §6.6 表）。全部欄位可省略 = 繼承 insertDefaults。
 * 外掛的設定組（例如牌外掛的 flip / paperRatio…）由外掛用 module augmentation 補進來。
 */
export interface InsertV1 {
  macro: InsertMacro;
  opacity?: number;
  applyMix?: number;
  edge?: { choke: number; softness: number; falloff: EdgeFalloff };
  occlusion?: { dilate: number; feather: number };
  motionBlur?: { shutterAngle: number; shutterPhase: ShutterPhase; samples: number | "auto" };
  resample?: { kernel: ResampleKernel; clamp: boolean };
  relight?: { keepHighlights: number; sheenLock: SheenLock };
  grain?: { mode: GrainMode; amount: number };
}

/** InsertV1 裡由核心管的鍵（其餘是外掛的或不認得的）。 */
export const INSERT_KEYS: readonly string[] = ["macro", "opacity", "applyMix", "edge", "occlusion", "motionBlur", "resample", "relight", "grain"];

/** insertDefaults 是 InsertV1 的「非 null 版本」：每個欄位都有值，作為繼承來源。外掛的設定組可省略（同 InsertV1）。 */
export interface InsertDefaultsV1 {
  macro: InsertMacro;
  opacity: number;
  applyMix: number;
  edge: { choke: number; softness: number; falloff: EdgeFalloff };
  occlusion: { dilate: number; feather: number };
  motionBlur: { shutterAngle: number; shutterPhase: ShutterPhase; samples: number | "auto" };
  resample: { kernel: ResampleKernel; clamp: boolean };
  relight: { keepHighlights: number; sheenLock: SheenLock };
  grain: { mode: GrainMode; amount: number };
}

/** 純 JSON 值（引擎的設定組原樣保留用）。 */
export type JsonValueLite = null | boolean | number | string | JsonValueLite[] | { [k: string]: JsonValueLite };
export type JsonObjectLite = { [k: string]: JsonValueLite };

/**
 * 區域策略（UI：整面替換／保持不動）。外掛可以加值（`vocabulary.regionPolicy`，例如 cards 的 keepBarcode）；
 * 不認得的值原樣保留，磁碟上的字串不變。
 */
export type RegionPolicy = "full" | "hold" | (string & {});

// ---- 通用物件（track anything；docs/tracking-api.md）----
// 物件 track 是 tracks[mediaId] 裡 kind:"object" 的一條：遮罩在 <媒體快取>/tracks/<trackId>/masks.aivm（跟平面 track 同一個位置），
// 由引擎 seg.find / seg.select 算、objects.adopt 搬進快取。**只加可省略的鍵、不升 schemaVersion**：
// 舊檔沒有物件 track 照樣開；舊版 App 讀到 kind:"object" 會當成平面 track（沒有關鍵幀，什麼都不做）。

/** track 的種類：平面（四角＋單應）或物件（逐幀遮罩）。 */
export type TrackKind = "planar" | "object";

/** 物件是怎麼來的：文字找（seg.find）、手動選（seg.select）、AI 選（之後接上；助手看圖給座標）。 */
export type ObjectSourceType = "text" | "select" | "ai";
export const OBJECT_SOURCE_TYPES: readonly ObjectSourceType[] = ["text", "select", "ai"];

/** 物件的來源。不認得的鍵原樣保留（引擎／AI 之後可能多寫東西）。 */
export interface ObjectSourceV1 {
  type: ObjectSourceType;
  /** 使用者打的字（整句，例如「人臉, 車牌」）。 */
  text?: string;
  /** 命中的片語（seg.find instances[].phrase）。 */
  phrase?: string;
  /** 後端名（"sam3" | "sam2"）。 */
  backend?: string;
  /** 偵測分數（後備＝OWLv2、SAM 3＝各幀最大值；兩者不可直接比）。 */
  score?: number;
}

/**
 * 特效（物件 track 與平面 track 都可以掛）。`type` 之外的鍵就是引擎 `aivc.fx.params.parse_effect` 吃的參數（camelCase），
 * 原封不動存；引擎套用前先拿掉 id / enabled 再解析（未知鍵會報錯，所以這裡不准自己發明參數）。
 * 前端只驗形狀（id / enabled / type / 參數是純 JSON），參數的值域由引擎驗：前端驗一份會跟引擎慢慢分岔。
 */
export type EffectType = "mosaic" | "blur" | "color" | "outline" | "glow" | "sticker" | "text";
export const EFFECT_TYPES: readonly EffectType[] = ["mosaic", "blur", "color", "outline", "glow", "sticker", "text"];

export interface EffectV1 {
  id: string;
  enabled: boolean;
  /** 不認得的 type 原樣保留（新版引擎的特效）。 */
  type: EffectType | (string & {});
  [param: string]: JsonValueLite;
}

/** 平面 track 的替換內容：圖片或影片貼進解出來的四邊形。 */
export type ReplaceKind = "image" | "video";
export type ReplaceFit = "stretch" | "contain" | "cover";
/** 影片比 track 短時：loop＝重播、hold＝停在最後一幀、stop＝之後不貼。 */
export type ReplaceLoop = "loop" | "hold" | "stop";
export const REPLACE_KINDS: readonly ReplaceKind[] = ["image", "video"];
export const REPLACE_FITS: readonly ReplaceFit[] = ["stretch", "contain", "cover"];
export const REPLACE_LOOPS: readonly ReplaceLoop[] = ["loop", "hold", "stop"];

export interface ReplaceV1 {
  kind: ReplaceKind;
  path: string;
  fit: ReplaceFit;
  /** 替換影片的第 0 幀對到 track 的哪一幀之後幾幀（可負）。 */
  offsetFrames: number;
  loop: ReplaceLoop;
}

/** 物件 track 預設的顏色輪替（新增時依序挑；色碼寫進檔案，換主題不會變）。 */
export const OBJECT_COLORS: readonly string[] = ["#FF5A5F", "#3BA7FF", "#FFC233", "#35C46A", "#B36BFF", "#FF8A3D", "#2EC4B6", "#F25CA2"];

export const DEFAULT_REPLACE: Omit<ReplaceV1, "kind" | "path"> = { fit: "stretch", offsetFrames: 0, loop: "loop" };

/** 外掛可以在這裡加 track 頂層的鍵（module augmentation，例如 cards 的 slotId）。 */
export interface TrackV1 {
  id: string;
  /** 物件 track：涵蓋 range 起點的鏡頭（滿足既有的驗證：指不到鏡頭的 track 整條丟）。 */
  shotId: string;
  label: string;
  kind: TrackKind;
  /** 取代隱形 anchor_k；UI「參考影格 [設定][前往]」。null = 引擎自己挑。 */
  referenceFrame: number | null;
  /** 追蹤區域（null = 同 surface）；surface = keyframes 的 quad。 */
  trackingRegion: Quad | null;
  keyframes: KeyframeV1[];
  prompts: PromptV1[];
  adjust: { points: ReferencePointV1[]; enabled: boolean };
  options: TrackOptionsV1;
  /** null = 全部繼承 insertDefaults。 */
  insert: InsertV1 | null;
  regionPolicy: RegionPolicy;
  /** 使用者改了關鍵幀 / 目標之後、還沒重解 → true；UI 橫幅提示。 */
  stale: boolean;
  /**
   * stale 的原因。只有 `"target"` 一個值：自從上次解算以來**只**改了替換目標 / 目標的連結（磁碟上的解還是對的，
   * 外掛的引擎 op 驗過可渲染就能清 stale）。省略 = 關鍵幀 / 選項 / 區域 / 鏡頭改過，或舊檔沒寫
   * ——一律當成要重解，驗證目標時不准清（不然 solve 早於那次修改、匯出卻顯示已解）。stale 為 false 時不寫。
   */
  staleReason?: "target";
  /**
   * 引擎寫在 track 上、前端 schema 不認得的鍵（Python `TrackV1.extra`：`detections` / `tracker`…，以及沒裝的外掛的鍵）。
   * **磁碟上是攤平在 track 物件頂層**（引擎 `to_json` 是 `d.update(self.extra)`、讀的時候 `_rest` 收回來），
   * 記憶體裡收成一個物件，寫檔時由 `trackToJson` 攤回去。丟掉它 = render 讀不到它要的東西。
   */
  extra?: Record<string, unknown>;

  // ---- 物件 track（kind:"object"）的鍵；平面 track 沒有（有的話是 extra）----
  /** "#RRGGBB"：清單色塊、舞台外框、遮罩疊色。 */
  color?: string;
  source?: ObjectSourceV1;
  /** 物件存在的幀範圍 [k0, k1)（半開，proxy 幀）。 */
  range?: [number, number];

  // ---- 兩種 track 都可以有 ----
  /** 特效堆疊（依序套用）；省略 = 沒有。 */
  effects?: EffectV1[];

  // ---- 只有平面 track ----
  /** 貼進四邊形的圖片 / 影片；省略 = 由外掛或 insert 決定（例如牌面）。 */
  replace?: ReplaceV1;
}

/**
 * 平面 TrackV1 裡由核心 schema 管的鍵；其餘的鍵是外掛登記的鍵（trackKeys()）或引擎的 extra（sanitize 收進 `extra`、寫檔時攤平）。
 * effects / replace 是新加的可省略鍵：沒有的 track 存出來逐位元不變。
 */
export const TRACK_KEYS: readonly string[] = ["id", "shotId", "label", "kind", "referenceFrame", "trackingRegion", "keyframes", "prompts", "adjust", "options", "insert", "regionPolicy", "stale", "staleReason", "extra", "effects", "replace"];

/**
 * 物件 track 在磁碟上的鍵（磁碟上的順序；契約見檔頭）。記憶體裡物件 track 也帶著平面的欄位（全是預設值），
 * 讓只認得平面 track 的程式碼不必到處判斷 —— **但寫檔時不寫**，那些鍵在物件 track 上是未知鍵（收進 extra 原樣保留）。
 */
export const OBJECT_TRACK_KEYS: readonly string[] = ["id", "shotId", "label", "kind", "referenceFrame", "keyframes", "color", "source", "range", "effects", "extra"];

/** 外掛登記的 track 頂層鍵（不收進 extra，留在 track 物件上）。 */
export function pluginTrackKeys(): string[] {
  return collect((p) => p.project?.trackKeys);
}

/** 不收進 extra 的 track 鍵：核心的（依種類）+ 外掛登記的。 */
export function trackKeys(kind: TrackKind = "planar"): readonly string[] {
  const base = kind === "object" ? OBJECT_TRACK_KEYS : TRACK_KEYS;
  const own = pluginTrackKeys();
  return own.length ? [...base, ...own] : base;
}

export function isObjectTrack(t: Pick<TrackV1, "kind">): boolean {
  return t.kind === "object";
}

/**
 * 記憶體的 TrackV1 → 磁碟形狀：extra 攤平到頂層（引擎的讀法），已知欄位優先，extra 不能蓋掉 id / shotId 之類。
 * 回傳型別仍是 TrackV1：攤平後沒有 `extra` 鍵（它本來就可省略），多出來的頂層鍵只是 TS 看不到的額外屬性。
 * 物件 track 只寫 OBJECT_TRACK_KEYS（＋外掛鍵＋extra）：記憶體裡補的平面預設值不寫出去。
 */
export function trackToJson(t: TrackV1): TrackV1 {
  if (t.kind === "object") return objectTrackToJson(t);
  const { extra, ...known } = t;
  if (!extra) return known;
  const keys = trackKeys();
  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) if (!keys.includes(k)) flat[k] = v;
  return { ...flat, ...known } as TrackV1;
}

function objectTrackToJson(t: TrackV1): TrackV1 {
  const src = t as unknown as Record<string, unknown>;
  const known: Record<string, unknown> = {};
  for (const k of OBJECT_TRACK_KEYS) if (k !== "extra" && src[k] !== undefined) known[k] = src[k];
  for (const k of pluginTrackKeys()) if (src[k] !== undefined) known[k] = src[k];
  const keys = trackKeys("object");
  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(t.extra ?? {})) if (!keys.includes(k)) flat[k] = v;
  // 已知鍵在前、未知鍵接在後面（引擎 to_json 也是先寫已知再 update(extra)）；flat 已濾掉已知鍵，蓋不到它們
  return { ...known, ...flat } as unknown as TrackV1;
}

/** 專案的工作模式（= 專案檔的 profile）。核心只有 generic；外掛可以加（例如 cards）。不認得的值原樣保留。 */
export type Profile = "generic" | (string & {});

export type TrackDataFormat = "nuke" | "ae";
export type TrackDataFlavour = "cornerpin" | "cornerpin+transform";

export interface ExportDefaultsV1 {
  codec: string;
  /** crf / cq；null ＝ 交給引擎依 codec 決定（VP9 16、NVENC 19）。數字＝使用者明確選過。 */
  quality: number | null;
  audio: string;
  trackData: { format: TrackDataFormat; flavour: TrackDataFlavour; baked: boolean; frameOffset: number };
}

// ---- 動態字幕（feat/captions；規格 §5.1，TS 為 SoT、Python project/schema.py 鏡射）----
// 為什麼是「可省略的頂層欄位」而不是升 schemaVersion：舊檔沒有這個鍵照樣能開、舊版 App 讀到新檔也只是忽略它，
// 兩邊都接受「不存在」就不需要 migrate。沒有字幕的專案**不寫**這個鍵，既有專案檔的輸出才會逐位元相同。
// 時間一律是整數 proxy 幀（跟鏡頭 / 關鍵幀同一把尺）：VFR 來源用毫秒會漂，燒入時也是逐 proxy 幀判斷。

export type CaptionPresetId = "subtitle" | "karaoke" | "pop" | "bounce" | "typewriter" | "boxHighlight";

export const CAPTION_PRESET_IDS: readonly CaptionPresetId[] = ["subtitle", "karaoke", "pop", "bounce", "typewriter", "boxHighlight"];

export type CaptionCueFlag = "lowConfidence" | "hallucination" | "tooFast" | "overflow" | "edited";

export const CAPTION_CUE_FLAGS: readonly CaptionCueFlag[] = ["lowConfidence", "hallucination", "tooFast", "overflow", "edited"];

export interface CaptionWordV1 {
  text: string;
  startFrame: number;
  /** 不含；> startFrame。 */
  endFrame: number;
  prob?: number;
  emphasis?: boolean;
  source?: "asr" | "user" | "llm";
}

export interface CaptionCueV1 {
  id: string;
  startFrame: number;
  /** 不含。 */
  endFrame: number;
  /** 依時間排序、互不重疊、全部落在 [startFrame, endFrame) 內。 */
  words: CaptionWordV1[];
  speaker?: string | null;
  lang?: string;
  styleOverride?: Partial<CaptionStyleV1> | null;
  hidden?: boolean;
  flags?: CaptionCueFlag[];
}

export interface CaptionSegmentationV1 {
  mode: "sentence" | "phrase" | "word";
  /** 中日韓一個字算 2 單位。 */
  maxUnitsPerLine: number;
  maxLines: 1 | 2 | 3;
  maxWords: number | null;
  minDurationMs: number;
  maxDurationMs: number;
  gapFrames: number;
  chainGapMs: number;
  lagOutMs: number;
  pauseBreakMs: number;
  snapToShots: boolean;
  cpsWarn: number | null;
}

export interface CaptionStyleV1 {
  font: { families: string[]; weight: 400 | 500 | 700 | 800 | 900; sizePctShortSide: number; file?: string | null; letterSpacingEm: number; uppercaseLatin: boolean; cjkLatinSpace: boolean };
  layout: { maxWidthPct: number; lineHeight: number; align: "center" | "left" | "right"; anchor: "bottom" | "middle" | "top"; offsetYPct: number; safeArea: "auto" | "broadcast" | "shorts" | "none" };
  colors: { text: string; future: string | null; active: string | null; past: string | null; emphasis: string; stroke: string };
  /** widthPct：字級 px 的百分比。 */
  stroke: { widthPct: number };
  shadow: { color: string; dxPct: number; dyPct: number; blurPct: number } | null;
  box: { mode: "none" | "line" | "activeWord"; color: string; padEm: number; radiusEm: number };
  animation: {
    cueIn: "none" | "fade" | "pop" | "slideUp" | "spring";
    cueInMs: number;
    cueOut: "none" | "fade";
    cueOutMs: number;
    word: "none" | "karaoke" | "karaokeWipe" | "pop" | "typewriter" | "boxMove";
    wordMs: number;
    activeScale: number;
    emphasisScale: number;
  };
}

export interface CaptionSourceV1 {
  backend: "faster-whisper";
  model: string;
  device: "cuda" | "cpu";
  computeType: string;
  asrLanguage: string | null;
  detected: string | null;
  languageProb: number | null;
  asrPath: string;
  transcribedAt: string;
  /**
   * asrPath 那份 ASR 檔涵蓋的 proxy 幀 [K0, K1)：只重辨識 I/O 範圍時由前端寫入（跟 ASR 檔自己的 `range` 同形狀）；沒有 / null = 整支。
   * 「依樣式重新分段」靠它只重建範圍內的段 —— 少了它，範圍 ASR 會被當成整支，範圍外的字幕整片消失（驗收 Medium 1）。
   * 刻意不列為 sanitize 的已知欄位：TS 與 Python 都當未知鍵原樣保留（schema.py 不必跟著改、round-trip 逐位元相同），
   * 所以型別是 unknown，讀的人一律過 pipeline/captions.ts 的 sourceRange() 驗證。
   */
  range?: unknown;
}

export interface CaptionTrackV1 {
  enabled: boolean;
  /** 輸出文字的語言（"zh-TW" | "en" …）。 */
  language: string;
  source: CaptionSourceV1 | null;
  presetId: CaptionPresetId;
  /** 有效樣式 = PRESET ← track.style ← cue.styleOverride（深層合併）。 */
  style: Partial<CaptionStyleV1>;
  segmentation: CaptionSegmentationV1;
  cues: CaptionCueV1[];
  /**
   * 前端 schema 不認得的鍵。跟 TrackV1.extra 同一個慣例：**磁碟上攤平在字幕 track 物件頂層**、記憶體裡收成物件，
   * 寫檔時由 captionTrackToJson 攤回去（sanitize 兩種形狀都收，parse 冪等）。引擎之後加的欄位才不會被前端存檔洗掉。
   */
  extra?: Record<string, unknown>;
}

/** CaptionTrackV1 裡由前端 schema 管的鍵；其餘是 extra。 */
export const CAPTION_TRACK_KEYS: readonly string[] = ["enabled", "language", "source", "presetId", "style", "segmentation", "cues", "extra"];

/** 記憶體形狀 → 磁碟形狀：extra 攤平到頂層、已知欄位優先（同 trackToJson）。 */
export function captionTrackToJson(t: CaptionTrackV1): CaptionTrackV1 {
  const { extra, ...known } = t;
  if (!extra) return known;
  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(extra)) if (!CAPTION_TRACK_KEYS.includes(k)) flat[k] = v;
  return { ...flat, ...known } as CaptionTrackV1;
}

export interface ProjectFileV1 {
  schemaVersion: 1;
  app: { name: string; version: string };
  createdAt: string;
  updatedAt: string;
  media: ProjectMediaV1[];
  activeMediaId: string | null;
  profile: Profile;
  shots: Record<string, ShotV1[]>;
  /** 寫檔形狀：track 的 extra 已攤平（見 trackToJson）；parseProjectFile 回的是記憶體形狀 TrackV1。 */
  tracks: Record<string, TrackV1[]>;
  // ← 外掛登記的頂層鍵寫在這裡（tracks 之後、insertDefaults 之前；例如 cards 的 cardSlots / deck）
  insertDefaults: InsertDefaultsV1;
  exportDefaults: ExportDefaultsV1;
  /** 每支媒體一條字幕 track；省略 = 沒有字幕（buildProjectFile 只在非空時寫）。 */
  captions?: Record<string, CaptionTrackV1>;
}

/** 核心管的頂層鍵（磁碟上的順序）。其餘是外掛登記的鍵（pluginTopLevelKeys）或 project extras（原樣保留）。 */
export const CORE_TOP_KEYS: readonly string[] = ["schemaVersion", "app", "createdAt", "updatedAt", "media", "activeMediaId", "profile", "shots", "tracks", "insertDefaults", "exportDefaults", "captions", "sequence", "audioMedia"];

/** 外掛登記的頂層鍵（依登記順序）。 */
export function pluginTopLevelKeys() {
  return collect((p) => p.project?.topLevel);
}

/**
 * 外掛擁有、進 undo 的專案狀態（記憶體形狀）：每支媒體一份（頂層對照表裡這支媒體的值）＋專案層一份。
 * 鍵 = 外掛登記的頂層鍵；值由外掛的 sanitize 產生、serialize 寫回。核心不解讀。
 */
export interface PluginProjectData {
  media: Record<string, PluginMediaState>;
  project: PluginProjectState;
}

export function emptyPluginData(): PluginProjectData {
  return { media: {}, project: {} };
}

/** 新專案的外掛專案層初值（每個 project scope 鍵的 initial()）。 */
export function initialPluginProject(): PluginProjectState {
  const out: Record<string, unknown> = {};
  for (const k of pluginTopLevelKeys()) if (k.scope === "project") out[k.key] = k.initial();
  return out;
}

/** 有沒有外掛在某一層（options / insert）宣告了鍵：有 → 外掛是這一層詞彙的權威，其他不認得的鍵照舊丟。 */
export function pluginLevelKeys(level: "optionKeys" | "insertKeys"): string[] | null {
  const has = plugins().some((p) => p.project?.[level] !== undefined);
  return has ? collect((p) => p.project?.[level]) : null;
}

/** 計畫 §6.6 表的預設值（720p・30fps・VP9・固定機位）。 */
export const INSERT_DEFAULTS: InsertDefaultsV1 = {
  macro: "standard",
  opacity: 100,
  applyMix: 100,
  edge: { choke: 0.6, softness: 0.8, falloff: "linear" },
  occlusion: { dilate: 1.0, feather: 1.2 },
  // 180° 快門 = 0.5 幀（Nuke shutter=0.5）；原稿 n=ceil(|d|) 是 360° 快門，會把快速翻轉的平面糊成兩倍（決策 17）
  motionBlur: { shutterAngle: 180, shutterPhase: "centered", samples: "auto" },
  // 白底黑字這種高對比細節不 clamp 會振鈴（§12 風險）
  resample: { kernel: "lanczos3", clamp: true },
  relight: { keepHighlights: 100, sheenLock: "plate" },
  grain: { mode: "measured", amount: 100 },
};

/** 三段巨集對應的覆寫（§6.6 表「巨集」列）。custom 不覆寫任何東西。 */
export const INSERT_MACROS: Record<Exclude<InsertMacro, "custom">, Partial<InsertDefaultsV1>> = {
  conservative: { edge: { choke: 1.0, softness: 1.2, falloff: "linear" }, opacity: 95 },
  standard: {},
  full: { edge: { choke: 0.3, softness: 0.5, falloff: "linear" }, opacity: 100 },
};

export const EXPORT_DEFAULTS: ExportDefaultsV1 = {
  // 假設 2：輸出預設「同來源容器」；codec 空字串 = 引擎 render.plan 依來源決定
  codec: "",
  // null：不要在專案層寫死畫質，否則會蓋過引擎依 codec 量過的預設（寫死 24 時 VP9 預設改 16 完全沒生效）
  quality: null,
  audio: "copy",
  trackData: { format: "nuke", flavour: "cornerpin", baked: true, frameOffset: 1 },
};

export const DEFAULT_TRACK_OPTIONS: TrackOptionsV1 = { method: "classic", motionModel: "perspective", smoothing: 0.4 };

/** 有效的 track 插入參數 = 專案預設 ← 巨集 ← track 自己的覆寫。 */
export function effectiveInsert(defaults: InsertDefaultsV1, insert: InsertV1 | null): InsertDefaultsV1 {
  const macro = insert?.macro ?? defaults.macro;
  const fromMacro = macro === "custom" ? {} : INSERT_MACROS[macro];
  const own: Partial<InsertDefaultsV1> = {};
  if (insert) {
    for (const k of Object.keys(insert) as (keyof InsertV1)[]) {
      if (k === "macro") continue;
      const v = insert[k];
      if (v !== undefined && v !== null) (own as Record<string, unknown>)[k] = v;
    }
  }
  return { ...defaults, ...fromMacro, ...own, macro };
}

// ======================================================================================
// schema v2：序列剪輯與音訊（docs/editor-m2-design.md §3.1–3.2）
//
// 時間單位全部是整數，沒有浮點秒：V1 片段用 proxy 幀 k、序列位置用序列幀 t、音訊片段用 48 kHz 序列樣本、
// 音訊片段的來源入點用來源原生取樣率的樣本。浮點秒在 200 個片段之後會漂出看得見的縫。
// ======================================================================================

export const SEQ_SAMPLE_RATE = 48000 as const;
/** 片段邊緣自動的防爆音淡化（ms）；使用者的淡入淡出比它長就不另外加。 */
export const DEFAULT_EDGE_DECLICK_MS = 3;
/** ≤ 這個 dB 視為 −∞（靜音）。 */
export const SILENCE_DB = -90;
/** 增益 / 自動化點的合法範圍（dB）；−96 是 muteRange 寫的值，+12 是推桿上限（同 Resolve）。 */
export const GAIN_DB_MIN = -96;
export const GAIN_DB_MAX = 12;

/** 音訊片段 srcIn 可為負（前面補靜音），但超過這麼多秒的負值只可能是壞資料（sanitize 丟片段，§3.5；Python 同名常數）。 */
export const MAX_NEGATIVE_SRC_IN_SECONDS = 10;

/** afade 的 tri / qsin；Web Audio 預覽用 linearRamp / 正弦 setValueCurve。 */
export type FadeCurve = "linear" | "equalPower";
export type AudioRole = "music" | "voiceover" | "sfx" | "other";
export const FADE_CURVES: readonly FadeCurve[] = ["linear", "equalPower"];
export const AUDIO_ROLES: readonly AudioRole[] = ["music", "voiceover", "sfx", "other"];

export function isFadeCurve(v: unknown): v is FadeCurve {
  return (FADE_CURVES as readonly unknown[]).includes(v);
}

export function isAudioRole(v: unknown): v is AudioRole {
  return (AUDIO_ROLES as readonly unknown[]).includes(v);
}

/** 兩個有理數 fps 是否相等（30/1 與 60/2 視為相同；交叉相乘，不經浮點）。 */
export function sameRational(a: Rational, b: Rational): boolean {
  return a.num * b.den === b.num * a.den;
}

/** 音量自動化點。at：相對片段起點的序列樣本；兩點之間在 dB 域線性內插（同 ai-music-cut OverlayPoint）。 */
export interface GainPointV2 {
  at: number;
  db: number;
}

/** 片段層的音訊參數（V1 原音與音訊片段共用同一組欄位，渲染與預覽只寫一套）。 */
export interface ClipGainV2 {
  /** −96..+12。 */
  gainDb: number;
  /** 序列樣本。 */
  fadeIn: number;
  /** 序列樣本；fadeIn + fadeOut ≤ length（sanitize 等比縮）。 */
  fadeOut: number;
  fadeCurve: FadeCurve;
  /** 依 at 排序、at ∈ [0, length]。 */
  envelope: GainPointV2[];
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

/** 序列標記（Premiere / Resolve 的 marker）：時間軸上的一個註記點，不影響輸出。 */
export interface MarkerV2 {
  id: string;
  /** 序列幀。 */
  t: number;
  /** 使用者打的字；空字串 = 只是個記號。 */
  name: string;
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
  /**
   * 依 t 由小到大排序；同一幀可以有多個。
   *
   * **沒有標記時整個鍵不寫出去**：專案檔有逐位元 round-trip 的黃金檔，而且與 Python 端共用同一份，
   * 無條件寫 `"markers":[]` 會讓所有既有檔案的位元組跟著變。
   */
  markers?: MarkerV2[];
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

/** audio 省略（undefined）＝ 還沒跑過 media.audio_info；寫檔時也省略，v1 檔讀進寫出才會逐位元相同。 */
export type ProjectMediaV2 = ProjectMediaV1 & { audio?: AudioInfoV2 | null };

/**
 * 記憶體形狀（parseProjectFile 的結果）：兩個 v2 鍵永遠存在。
 * schemaVersion 是「存回去會寫的版本」（writtenSchemaVersion），不是讀進來的版本：v2 檔的序列整條壞掉被丟成 null 時就是 1。
 */
export interface ProjectFileV2 extends Omit<ProjectFileV1, "schemaVersion" | "media"> {
  schemaVersion: WrittenSchemaVersion;
  media: ProjectMediaV2[];
  /** null = 隱含序列（目前媒體整段、未剪）。寫成 v1 時整個鍵省略。 */
  sequence: SequenceV2 | null;
  /** 寫成 v1 時整個鍵省略。 */
  audioMedia: AudioMediaV2[];
  /** 外掛登記的頂層鍵（記憶體形狀）；沒有外掛 = 空的，那些鍵原樣留在 project extras。 */
  plugin: PluginProjectData;
}

/**
 * 磁碟形狀（buildProjectFile 的結果）：寫成 v1 時沒有 sequence / audioMedia 兩個鍵；外掛的頂層鍵（例如 cardSlots）
 * 在 tracks 之後，型別上是 unknown。
 */
export type ProjectFileJson = Omit<ProjectFileV2, "sequence" | "audioMedia" | "plugin"> & Partial<Pick<ProjectFileV2, "sequence" | "audioMedia">> & { [pluginKey: string]: unknown };

export const DEFAULT_CLIP_GAIN: Readonly<ClipGainV2> = Object.freeze({ gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear" as FadeCurve, envelope: Object.freeze([]) as unknown as GainPointV2[] });
export const DEFAULT_CLIP_AUDIO: Readonly<ClipAudioV2> = Object.freeze({ enabled: true, ...DEFAULT_CLIP_GAIN });

/** 新物件版的 DEFAULT_CLIP_AUDIO：常數是凍結的（共用的 envelope 陣列被誰 push 一下，全專案的預設都會變）。 */
export function defaultClipAudio(): ClipAudioV2 {
  return { enabled: true, gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [] };
}

/** 音樂軌預設不跟 V1 波紋（墊樂釘在成品時間，ai-music-cut mix.rs；§0.1 Q3），旁白／音效／其他預設跟。 */
export function defaultSyncLock(role: AudioRole): boolean {
  return role !== "music";
}

/**
 * 最低版本寫檔（§4.3）：沒有實體化的序列、也沒有音訊媒體 → 寫 1。
 * 為什麼：App 每 2 秒自動存檔；沒有這條規則，新版打開舊專案什麼都沒剪，檔案就被悄悄升成 v2，退回 v0.0.6 打不開。
 * Python `written_version()` 是同一條規則。
 */
export function writtenSchemaVersion(sequence: SequenceV2 | null | undefined, audioMedia: readonly AudioMediaV2[] | null | undefined): WrittenSchemaVersion {
  return sequence != null || (audioMedia?.length ?? 0) > 0 ? 2 : 1;
}

export interface ProjectSnapshot {
  media: ProjectMediaV2[];
  activeMediaId: string | null;
  profile: Profile;
  shots: Record<string, ShotV1[]>;
  tracks: Record<string, TrackV1[]>;
  /** 外掛的狀態（每支媒體 + 專案層）；省略 = 沒有（外掛的鍵照樣寫，值由外掛的 serialize 決定，例如空陣列 / 預設值）。 */
  plugin?: PluginProjectData;
  insertDefaults: InsertDefaultsV1;
  exportDefaults: ExportDefaultsV1;
  /** null / 省略 = 這支媒體沒有字幕。 */
  captions?: Record<string, CaptionTrackV1 | null>;
  /** 省略 = null（M2.4 之前的呼叫端還沒接序列）。 */
  sequence?: SequenceV2 | null;
  /** 省略 = []。 */
  audioMedia?: AudioMediaV2[];
}

export function buildProjectFile(snap: ProjectSnapshot, app: { name: string; version: string }, prev?: Pick<ProjectFileV1, "createdAt"> | null, now: Date = new Date()): ProjectFileJson {
  const iso = now.toISOString();
  // 只留有 track 的媒體；一條都沒有就整個鍵不寫（舊專案存回去逐位元相同、舊版 App 讀到也不會多一個看不懂的空物件）
  const captions: Record<string, CaptionTrackV1> = {};
  for (const [mid, tr] of Object.entries(snap.captions ?? {})) if (tr) captions[mid] = captionTrackToJson(tr);
  const sequence = snap.sequence ?? null;
  const audioMedia = snap.audioMedia ?? [];
  // 字幕是可省略的頂層欄位、不影響寫出的版本號：只加字幕的專案仍寫 1，v0.0.6（含字幕分支）照樣打得開（§4.3）
  const written = writtenSchemaVersion(sequence, audioMedia);
  const doc: Record<string, unknown> = {
    schemaVersion: written,
    app,
    createdAt: prev?.createdAt ?? iso,
    updatedAt: iso,
    // audio 只在有值（含 null）時寫：undefined 的鍵不寫，v1 檔讀進寫出才不會多出 "audio" 這一行
    media: snap.media.map((m) => ({ id: m.id, path: m.path, name: m.name, fingerprint: m.fingerprint, probe: m.probe, proxy: m.proxy, ...(m.audio !== undefined ? { audio: m.audio } : {}) })),
    activeMediaId: snap.activeMediaId,
    profile: snap.profile,
    shots: snap.shots,
    // extra 要攤回 track 頂層：引擎 render 讀的是 track 上的鍵（= 記憶體裡 track.extra 的內容）
    tracks: Object.fromEntries(Object.entries(snap.tracks).map(([mid, list]) => [mid, list.map(trackToJson)])),
  };
  // 外掛的頂層鍵：一直以來的位置（tracks 之後、insertDefaults 之前），依登記順序。每支媒體一份的鍵只寫清單上還在的媒體
  for (const k of pluginTopLevelKeys()) {
    doc[k.key] = k.scope === "media" ? Object.fromEntries(snap.media.map((m) => [m.id, k.serialize(snap.plugin?.media[m.id]?.[k.key])])) : k.serialize(snap.plugin?.project[k.key]);
  }
  doc.insertDefaults = snap.insertDefaults;
  doc.exportDefaults = snap.exportDefaults;
  if (Object.keys(captions).length) doc.captions = captions;
  // 寫 1 時兩個鍵整個省略（不是寫 null）：v0.0.6 的 sanitize 不認得它們，引擎 v1 的 from_json 會收進 extra
  if (written === 2) {
    doc.sequence = sequence;
    doc.audioMedia = audioMedia;
  }
  return doc as ProjectFileJson;
}

export class ProjectFormatError extends Error {}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 專案檔預設檔名：<媒體名>.aivc.json。 */
export function defaultProjectFileName(mediaName: string | null): string {
  const base = (mediaName ?? "untitled").replace(/\.[^.]+$/, "");
  return `${base}.aivc.json`;
}
