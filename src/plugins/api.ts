// 外掛 API（AivcPlugin）：選配功能（例如 plugins/cards —— 特定物件的辨識與替換）長在 `plugins/<id>/frontend/`，
// 核心**從不 import plugins/**，只有 src/plugins/index.ts 用 import.meta.glob 找出有哪些外掛、登記進 registry.ts。
// 開源版沒有 plugins/ 資料夾：這裡宣告的每一個接點都是「沒有外掛時什麼都不做」，App 照樣編得過、跑得動。
//
// 這個檔只放型別（對核心模組只有 type import），外掛與核心都可以放心 import。
//
// 專案檔的硬性規則：外掛擁有的鍵在磁碟上的名字與位置一律不變（頂層 cardSlots / deck、track 的 slotId…）。
// 外掛不在時核心原樣保留它們（頂層走 project extras、track 走 extra、options / insert 走未知鍵保留）；
// 外掛在時交給外掛的 sanitize / serialize。見 project 段的說明。
import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { AppSettings } from "../api";
import type { Command } from "../commands/types";
import type { Catalog } from "../i18n";
import type { TrackFacts } from "../inspector/advice";
import type { InsertV1, TrackOptionsV1, TrackV1 } from "../project/format";
import type { ParsedProject, SanitizeReport } from "../project/sanitize";
import type { MenuItem } from "../ui/MenuPanel";
import type { InfoRow } from "../video/mediaInfo";

/** 外掛擁有、存在 edits store（進 undo）的「這支媒體」狀態：鍵（= 磁碟上的頂層鍵）→ 值。核心不解讀。 */
export type PluginMediaState = Readonly<Record<string, unknown>>;
/** 外掛擁有、存在 edits store（進 undo）的專案層狀態：鍵（= 磁碟上的頂層鍵）→ 值。 */
export type PluginProjectState = Readonly<Record<string, unknown>>;

export interface AivcPlugin {
  /** 穩定 id（"cards"）。 */
  id: string;

  // ---- 工作模式與開始畫面 ----
  /** 工作模式（= 專案檔的 profile）。 */
  profiles?: WorkProfileContribution[];
  /** 開始畫面「你想做什麼？」的卡片。 */
  startCards?: StartCardContribution[];
  /** 開始畫面任何一張卡片（含核心的）開檔成功之後：key = 那張卡片的 key（在 `after` 指令之前呼叫）。 */
  onStartCardOpened?: (key: string) => void;

  // ---- 指令、選單、工具列 ----
  /** 登記進 commands/registry 的指令（批次可以指定插在哪個指令前後，選單分段的先後跟著它）。 */
  commands?: CommandBatch[];
  menus?: MenuContribution;
  /** 工具列的主要按鈕（大圖示那一排）。 */
  toolbar?: ToolbarContribution[];

  // ---- 版面 ----
  /** 右側欄分頁。 */
  inspectorTabs?: InspectorTabContribution[];
  /** 掛在工作區（舞台 + 時間軸）上的 React 層。 */
  stageOverlays?: StageOverlayContribution[];
  /** 對話框（各自 lazy 載入）：id → 元件。openDialog(id) 打開。 */
  dialogs?: Record<string, DialogContribution>;
  /** 設定對話框的區段。 */
  settingsSections?: SettingsSectionContribution[];

  // ---- 輸出 ----
  /** 輸出路由（`export.video` / `export.range`）：回 true = 外掛接手了（開自己的對話框），核心不再開一般輸出對話框。 */
  exportRoute?: (kind: "video" | "range") => boolean;

  // ---- 翻譯 ----
  /** 外掛自己的翻譯目錄（lazy）：載入語言時與核心的目錄合併。鍵一樣是繁中原文。 */
  locales?: Partial<Record<"en", () => Promise<{ default: Catalog }>>>;

  // ---- 關於 ----
  /** 「關於」與「安裝／檢查引擎」的離線元件清單接在核心後面的列（外掛自帶的素材、模型；name / role 是 zh key）。 */
  offlineComponents?: readonly OfflineComponentContribution[];

  // ---- 專案檔與 store ----
  project?: ProjectFileContribution;
  /** 核心列舉欄位可以由外掛加值（磁碟上的字串不變）。 */
  vocabulary?: VocabularyContribution;
  lifecycle?: LifecycleContribution;

  // ---- 核心各處讀一點外掛狀態的接縫 ----
  tracks?: TrackContribution;
  advice?: AdviceContribution;
  mediaInfo?: MediaInfoContribution;
  stage?: StageContribution;
  engine?: EngineContribution;
  dev?: DevContribution;

  /** App 掛載時呼叫一次（指令反應性之類的訂閱）；回傳的函式在卸載時呼叫。 */
  activate?: () => (() => void) | void;
}

// ============================================================================
// 工作模式 / 開始畫面
// ============================================================================

export interface WorkProfileContribution {
  /** 寫進專案檔的 profile 值（"cards"）。 */
  id: string;
  /** zh key：「工作模式」選單的名稱。 */
  title: string;
  /** zh key：切換後的一句提示。 */
  hint: string;
  /** 新專案 / 第一次啟動的預設工作模式（多個都宣告時取排序最前面的）。 */
  default?: boolean;
  /** 舊檔沒寫 profile、或寫了不認得的值時讀成這個（App 早期只有這一種用途）。 */
  legacy?: boolean;
  /** 「還沒有任何追蹤」時的一鍵指令（自動偵測）；沒有 = 新增追蹤。 */
  detectCommand?: string;
  /** 新增追蹤對話框的預設名稱（zh key，{n} = 第幾條）；沒有 =「平面 {n}」。 */
  newTrackLabel?: string;
  /** 排序（核心的 generic 是 100）。 */
  order?: number;
}

export interface StartCardContribution {
  /** React key 與 `data-card`（同一個 profile 可以有好幾張卡片，例如牌外掛的兩張卡片都是 cards）。 */
  key: string;
  /** 點卡片 = 設這個工作模式。 */
  profile: string;
  /** zh key */
  title: string;
  /** zh key：一句說明 */
  line: string;
  icon: LucideIcon;
  /** 開檔成功後接著跑的指令 id（引擎就緒且指令 enabled 才跑）。 */
  after?: string;
  /** 排序（核心的「一般平面替換」是 100）。 */
  order?: number;
}

// ============================================================================
// 指令 / 選單 / 工具列
// ============================================================================

export interface CommandBatch {
  commands: readonly Command[];
  /**
   * 插在哪個已登記指令的前 / 後（選單的分段依「第一次出現」排序，所以位置決定分段在選單裡的先後）。
   * 都沒給 = 接在核心的追蹤指令後面（核心的輸出指令之前）。
   */
  before?: string;
  after?: string;
}

export interface MenuGroupContribution {
  /** 指令的 group 值（"card"）。 */
  id: string;
  /** zh key：選單列 / 命令面板上的名稱。 */
  label: string;
  /** 選單列上排在哪個群組後面。 */
  menuAfter: string;
  /** 快捷鍵說明裡排在哪個群組後面。 */
  helpAfter: string;
}

/** 右鍵選單裡「某條追蹤」的情境。 */
export interface TrackMenuContext {
  mediaId: string | null;
  track: TrackV1;
  /** 右鍵當下的幀（舞台 = 播放線；車道 = 點到的幀）。 */
  frame: number;
}

export interface MenuContribution {
  /** 選單列多出來的群組（例如「牌」）。 */
  groups?: MenuGroupContribution[];
  /** 舞台空白處右鍵：接在「新增追蹤」後面的指令 id。 */
  stageEmpty?: string[];
  /** 舞台表面（某條追蹤）右鍵：接在加選 / 減選那一段之後、「追蹤選項」之前。 */
  stageTrack?: (ctx: TrackMenuContext) => (MenuItem | null | false | undefined)[];
  /** 時間軸車道右鍵：接在「將此追蹤的鏡頭設為範圍」那一段之後、「追蹤選項」之前（自成一段）。 */
  lane?: (ctx: TrackMenuContext) => (MenuItem | null | false | undefined)[];
  /** 右鍵某條追蹤（舞台表面 / 時間軸車道 / 菱形 / 錨標）時，選取那條追蹤之後呼叫。 */
  onTrackContext?: (mediaId: string, track: TrackV1) => void;
  /** 「從專案移除」前要不要先確認：這支媒體有外掛自己的資料（例如牌格位）。 */
  mediaHasWork?: (mediaId: string) => boolean;
}

export interface OfflineComponentContribution {
  /** zh key：元件名稱與授權。 */
  name: string;
  /** zh key：在 App 裡做什麼。 */
  role: string;
}

export interface ToolbarContribution {
  /** 指令 id。 */
  id: string;
  /** 排在哪顆主要按鈕後面；沒給 = 最後。 */
  after?: string;
}

// ============================================================================
// 版面
// ============================================================================

export type BadgeTone = "warning" | "danger" | "info";

export interface InspectorTabContribution {
  id: string;
  /** zh key：分頁標題。 */
  label: string;
  /** zh key：「檢視 › 側欄」指令的標題（例如「側欄：牌」）；沒有 = 不登記指令。 */
  railTitle?: string;
  /** 分頁條上的圖示。 */
  icon: LucideIcon;
  /** 「檢視 › 側欄」指令的圖示（沒給用 icon）。 */
  railIcon?: LucideIcon;
  panel: ComponentType;
  /** 分頁上的小數字（React hook；每次渲染都會呼叫）。 */
  useBadge?: () => { n: number; tone: BadgeTone };
  /** 排序（核心：追蹤 10、遮罩 20、字幕 30、片段 40、工作 50、歷史 60、建議 70、助手 80）。 */
  order: number;
  /** 第一次啟動（沒存過）時打開這一頁。 */
  default?: boolean;
}

export interface StageOverlayContribution {
  id: string;
  /** top = 舞台上方一條（不佔位就回 null）；overlay = 工作區最後一個子節點（蓋住舞台與時間軸）。 */
  slot: "top" | "overlay";
  component: ComponentType<{ mediaId: string | null }>;
}

export interface DialogContribution {
  load: () => Promise<{ default: ComponentType<never> }>;
  /** media = 作用中媒體消失就自動關；track = 那條追蹤被刪就關（props.trackId）。 */
  needs: "none" | "media" | "track";
}

export interface SettingsSectionProps {
  /** 對話框裡的設定草稿（外掛的鍵也在裡面，Rust `AppSettings.extra` 原樣保留）。 */
  draft: AppSettings;
  commit: (patch: Partial<AppSettings>) => Promise<void>;
}

export interface SettingsSectionContribution {
  id: string;
  tab: "general" | "engine" | "cache";
  /** 插在哪個核心區段之前（"appearance" / "experimental"…）；沒給 = 分頁最後。 */
  before?: string;
  component: ComponentType<SettingsSectionProps>;
}

// ============================================================================
// 專案檔
// ============================================================================

/** 專案檔頂層的外掛鍵：值是 `{ <mediaId>: 這支媒體的值 }` 的對照表（例如 cardSlots）。 */
export interface MediaScopedKey<T = unknown> {
  key: string;
  scope: "media";
  /** 這支媒體在磁碟上的值（可能是 undefined / 壞的）→ 記憶體的值。壞的丟並回報（drop-and-report）。 */
  sanitize: (raw: unknown, r: SanitizeReport) => T;
  /** 記憶體的值（這支媒體沒有 = undefined）→ 磁碟上的值。 */
  serialize: (value: T | undefined) => unknown;
}

/** 專案檔頂層的外掛鍵：整個專案一份（例如 deck）。 */
export interface ProjectScopedKey<T = unknown> {
  key: string;
  scope: "project";
  sanitize: (raw: unknown, r: SanitizeReport) => T;
  serialize: (value: T | undefined) => unknown;
  /** 新專案的初值。 */
  initial: () => T;
}

export type TopLevelKey = MediaScopedKey | ProjectScopedKey;

export interface ProjectFileContribution {
  /**
   * 頂層的外掛鍵。寫檔時接在 `tracks` 後面、`insertDefaults` 前面（依登記順序）——
   * 就是 cardSlots / deck 一直以來的位置，存出來的檔逐位元不變。值存在 edits store（進 undo）。
   */
  topLevel?: TopLevelKey[];
  /** track 頂層的外掛鍵（不收進 extra，寫檔時留在 track 物件原本的位置）。 */
  trackKeys?: string[];
  /** 核心驗完 track 的已知欄位之後、staleReason / extra 之前呼叫：補外掛鍵、修正外掛相關的值。 */
  sanitizeTrack?: (raw: Record<string, unknown>, track: TrackV1, r: SanitizeReport) => void;
  /** track 的 extra（引擎寫的未知鍵）收好之後：外掛驗它認得的鍵（例如 identity），壞的自己刪掉並回報。 */
  sanitizeTrackExtra?: (extra: Record<string, unknown>, r: SanitizeReport) => void;
  /**
   * track.options 的外掛鍵。這一層有外掛宣告鍵時，外掛是這一層詞彙的權威：宣告的鍵交給 sanitizeOptions，
   * 其他不認得的鍵照舊丟掉；沒有任何外掛宣告時，不認得的鍵一律原樣保留（可能屬於沒裝的外掛）。
   */
  optionKeys?: string[];
  sanitizeOptions?: (raw: Record<string, unknown>, options: TrackOptionsV1, r: SanitizeReport) => void;
  /** insert / insertDefaults 的外掛鍵（規則同 optionKeys）。 */
  insertKeys?: string[];
  sanitizeInsert?: (raw: Record<string, unknown>, insert: InsertV1, r: SanitizeReport) => void;
  /** 載入專案檔：parse 之後、放進 store 之前（可以就地修 parsed.file，例如正規化外掛自己的值）。 */
  onLoad?: (doc: Record<string, unknown>, parsed: ParsedProject) => void;
}

export interface VocabValue {
  /** 磁碟上的字串。 */
  id: string;
  /** zh key（沒有 = 直接顯示 id）。 */
  label?: string;
  /** 在選單裡排在哪個值後面；沒給 = 最後。 */
  after?: string;
}

export interface VocabularyContribution {
  /** track.regionPolicy（核心：full / hold）。 */
  regionPolicy?: { values?: VocabValue[]; /** 新追蹤的預設值。 */ default?: string };
  /** insert.relight.sheenLock（核心：plate）。 */
  sheenLock?: { values?: VocabValue[] };
}

export interface LifecycleContribution {
  /** 開一支影片（不是專案檔）之前。 */
  beforeOpenVideo?: () => void;
  /** 新專案（store 清空時）。 */
  newProject?: () => void;
}

// ============================================================================
// 讀外掛狀態的接縫
// ============================================================================

export interface TrackTargetText {
  /** 例如格位名「Player1」。 */
  name: string;
  /** 原本的（例如「8♥」）。 */
  from: string;
  /** 要換成的（例如「9♦」）。 */
  to: string;
}

export interface TrackOptionField {
  /** track.options 上的外掛鍵（例如 templateCard）。 */
  key: string;
  /** zh key */
  label: string;
  /** zh key */
  hint?: string;
  placeholder?: string;
  /** 使用者輸入 → 值（空字串 = 拿掉這個鍵 → undefined）；不合法回 error（zh key + params）。 */
  parse: (input: string) => { value: string | undefined } | { error: string; params?: Record<string, string | number> };
}

export interface TrackContribution {
  /** 這條追蹤指定了要換成什麼（片段頁的說明列、序列時間軸的徽章）；null = 沒有。 */
  target?: (media: PluginMediaState | undefined, track: TrackV1) => TrackTargetText | null;
  /** 舞台表面 / 時間軸車道右鍵標題的附註（例如「8♥ → 9♦」）。 */
  summary?: (media: PluginMediaState | undefined, track: TrackV1) => string | null;
  /** Inspector 追蹤頁標題旁的徽章文字。 */
  badge?: (track: TrackV1) => string | null;
  /** 新增追蹤對話框的額外欄位；value 會寫進新 track 的外掛鍵（例如 slotId）。 */
  NewTrackFields?: ComponentType<{ mediaId: string; value: Readonly<Record<string, unknown>>; onChange: (v: Record<string, unknown>) => void }>;
  /** 追蹤選項對話框的文字欄位。 */
  optionFields?: TrackOptionField[];
  /** `track.solve --template` 找模板圖時，接在快取候選後面的路徑。 */
  templateCandidates?: (mediaId: string, track: TrackV1) => string[];
}

export interface PluginAdviceItem {
  code: string;
  kind: "problem" | "suggestion";
  params?: Record<string, string | number>;
  command?: string;
  /** head = 問題的最前面（引擎之後）；afterUnsolved = 建議的「還沒解算」之後；tail = 建議的最後。 */
  slot: "head" | "afterUnsolved" | "tail";
}

export interface AdviceContext {
  mediaId: string;
  profile: string;
  media: PluginMediaState | undefined;
  /** 核心攤平好的追蹤事實（解算、遮罩…）；trackList 是同一個順序的原始 track（外掛讀自己的鍵用）。 */
  tracks: readonly TrackFacts[];
  trackList: readonly TrackV1[];
}

export interface AdviceContribution {
  items: (ctx: AdviceContext) => PluginAdviceItem[];
  /** code → 標題 / 說明（zh key）。 */
  text: Record<string, { title: string; hint: string }>;
}

export interface MediaInfoContext {
  mediaId: string;
  media: PluginMediaState | undefined;
  project: PluginProjectState;
}

export interface MediaInfoContribution {
  /** 「引擎」段最後追加的列。 */
  rows?: (ctx: MediaInfoContext) => InfoRow[];
  /** 「複製報告」JSON 追加的鍵（接在 tracks 後面）。 */
  report?: (ctx: MediaInfoContext) => Record<string, unknown>;
}

export interface StageContribution {
  /** 舞台合成預覽快取鍵的一部分：這個值變了才重要預覽（例如每個格位的目標牌）。 */
  previewKey?: (media: PluginMediaState | undefined) => unknown;
  /** 現在不要送舞台預覽（例如外掛有自己的預覽 session，兩邊會互踢）。 */
  blockPreview?: () => boolean;
}

export interface EngineContribution {
  /** `render.plan` / `render.run` 的額外參數（例如牌組目錄 `deck`）。 */
  renderArgs?: (mediaId: string) => Record<string, unknown>;
}

export interface DevContribution {
  /** window.__aivc 多掛的東西（開發用自動化橋接，正式打包 tree-shake 掉）。 */
  bridge?: () => Record<string, unknown>;
  /** window.__aivc.pipeline 多掛的函式。 */
  pipeline?: () => Record<string, unknown>;
  /** `AIVC_DEV_TRACK` 煙霧測試：跑外掛的整條自動偵測，回一行日誌（null = 沒跑成）。 */
  autoTrack?: (mediaId: string) => Promise<string | null>;
  /** devLog 每筆 commit 那一行的附註（例如「slots=4」）。 */
  commitInfo?: (mediaId: string) => string;
  /** devLog「settings loaded」那一行的附註（接在 lang 後面，例如「deck=<牌組 id>」）。 */
  settingsInfo?: (s: AppSettings) => string;
}
