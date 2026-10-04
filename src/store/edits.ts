import { create } from "zustand";
import {
  DEFAULT_TRACK_OPTIONS,
  initialPluginProject,
  OBJECT_COLORS,
  type AudioInfoV2,
  type AudioMediaV2,
  type CaptionCueV1,
  type CaptionPresetId,
  type CaptionStyleV1,
  type CaptionTrackV1,
  type EffectV1,
  type InsertV1,
  type ObjectSourceV1,
  type ReplaceV1,
  type KeyframeV1,
  type PromptPointV1,
  type Quad,
  type SequenceV2,
  type ShotV1,
  type TrackOptionsV1,
  type TrackV1,
} from "../project/format";
import type { PluginMediaState, PluginProjectState } from "../plugins/api";
import { defaultRegionPolicy } from "../project/vocab";
import { makeSeqCtx, type SeqCtx } from "../sequence/context";
import { ensureSequence, removeAudioMediaRefs, removeMediaRefs } from "../sequence/ops";
import * as C from "./captions";
import { useProject } from "./project";

/**
 * 專案的「向量狀態」＋ undo 歷史（計畫 §8 store/edits.ts，設計移植自 ai-music-cut 的 store/decisions.ts）。
 *
 * 進 undo 的只有使用者真的釘下去的東西：鏡頭邊界、track（關鍵幀 / 提示點 / 選項 / 插入參數）、外掛的狀態
 * （pluginMedia / pluginProject，例如 cards 外掛的格位與牌組）。
 * **遮罩與解算在 undo 之外**（store/masks.ts、store/solves.ts）：那是從這裡的向量狀態重算出來的光柵化產物，
 * 復原一個關鍵幀時不該跟著「復原」一份解 —— 重解就好，快取缺就標 stale。
 *
 * 每個動作 = 一次 commit = 一筆 undo。批次動作（applyDetection 一次建 6 條 track）也是一筆：
 * 套一次自動偵測卻要按六次 Ctrl+Z 才收得回去，那是不合理的。外掛的動作走 `commitEdit`，跟核心的動作在同一條歷史上。
 *
 * 這個檔案在 check-i18n.mjs 的 TABLE_SOURCES 裡：commit 的 label 是 zh key（歷史面板會 t() 過）。
 *
 * 序列剪輯（M2.4，docs/editor-m2-design.md §6）：序列與音訊媒體是**專案層**（同 pluginProject），不分媒體。
 * 序列動作一律走 `editSequence`，patch 的 mediaId 是 `PROJECT_SCOPE`；每一筆 patch（含追蹤動作的）都帶完整的
 * pluginProject / sequence / audioMedia，undo / redo 嚴格照順序時 `past[top].after` 永遠等於現況，專案層欄位才不會錯亂。
 */

/**
 * 專案層 patch 的 mediaId。為什麼不用 null 或 activeMediaId：歷史面板與 clear() 用 mediaId 分辨「這筆屬於誰」，
 * 掛在作用中媒體底下的話，移除那支媒體時會把序列的 patch 一起從歷史中間抽掉。星號開頭不會跟指紋 id 撞名。
 */
export const PROJECT_SCOPE = "*project" as const;

export interface Snapshot {
  shots: ShotV1[];
  tracks: TrackV1[];
  /** 外掛的「這支媒體」狀態（鍵 → 值，例如 cards 的格位）。commit 只給部分鍵時跟原本的合併。 */
  pluginMedia: PluginMediaState;
  /**
   * 外掛的專案層狀態（例如 cards 的牌組：不分媒體，但換了會讓辨識結果失效，所以跟著一起進快照）。
   * 每筆 patch 都帶，LIFO undo 才能還原一致的整體狀態。commit 只給部分鍵時跟原本的合併。
   */
  pluginProject: PluginProjectState;
  /** 這支媒體的字幕 track；null = 沒有字幕。字幕是使用者逐字修過的東西，跟關鍵幀一樣要能 undo。 */
  captions: CaptionTrackV1 | null;
  /** 專案層（同 pluginProject）：每筆 patch 都帶，LIFO undo 才能還原一致的整體狀態。null = 隱含序列（未剪輯）。 */
  sequence: SequenceV2 | null;
  /** 專案層：純音訊媒體清單（匯入音樂和把它放上音軌是同一筆 undo，所以清單本身也要在快照裡）。 */
  audioMedia: AudioMediaV2[];
}

/**
 * 序列 / 音訊動作的 undo 標籤（設計 §6 的清單）。放在這個檔案是因為它在 check-i18n 的 TABLE_SOURCES 裡：
 * 指令層呼叫 `editSequence(SEQ_EDIT_LABEL.split, …)`，字串只有這一份，漏翻的話稽核當場抓得到。
 */
export const SEQ_EDIT_LABEL = {
  split: "分割片段",
  join: "合併切點",
  rippleDelete: "波紋刪除",
  lift: "刪除片段（留空隙）",
  extractRange: "提取範圍",
  liftRange: "移除範圍（留空隙）",
  disable: "停用片段",
  enable: "啟用片段",
  trim: "修剪片段",
  detachAudio: "分離音訊",
  addMedia: "加入媒體到序列",
  insertGap: "插入空白",
  duplicate: "複製片段",
  overwrite: "覆蓋到序列",
  roll: "移動剪接點",
  paste: "貼上片段",
  slip: "滑內容",
  removeSilence: "移除靜音",
  removeFillers: "移除語助詞",
  cutCue: "剪掉這句的畫面",
  addMarker: "加入標記",
  chapters: "加入章節標記",
  highlights: "加入精華標記",
  keepHighlights: "只留精華片段",
  deleteMarker: "刪除標記",
  renameMarker: "改標記的字",
  normalize: "正規化音量",
  rename: "重新命名片段",
  splitAtShots: "在鏡頭切點分割",
  reorder: "調整片段順序",
  slide: "滑移片段",
  addAudio: "加入音訊",
  moveAudio: "移動音訊片段",
  gain: "音訊增益",
  fadeIn: "淡入",
  fadeOut: "淡出",
  fadeCurve: "淡化曲線",
  envelope: "音量自動化",
  duckRange: "閃避範圍",
  muteRange: "靜音範圍",
  clearAutomation: "清除音量自動化",
  newLane: "新增音軌",
  deleteLane: "刪除音軌",
  laneMute: "音軌靜音",
  syncLock: "同步鎖",
  laneGain: "音軌推桿",
  removeMedia: "移除媒體（含序列片段）",
  removeAudioMedia: "移除音訊媒體",
} as const;

/** clear() 回傳 true（整個復原歷史被清掉）時，UI 要給使用者的提示（zh key；呼叫端 t()）。 */
export const HISTORY_CLEARED_NOTICE = "已清除復原歷史";

export interface EditSequenceOptions {
  /** 同一筆 undo 裡一起換掉的音訊媒體清單（匯入音樂並放上音軌 / 移除音訊媒體連片段）；f 的 ctx 也看這份。 */
  audioMedia?: AudioMediaV2[];
  /** 連續同類動作合併成一筆（拖音量線 / 推桿），規則同字幕打字的 COALESCE_MS。 */
  coalesceKey?: string;
}

export interface Patch {
  label: string;
  /** 媒體 id；序列 / 音訊動作是 PROJECT_SCOPE。 */
  mediaId: string;
  /** 發生時間（epoch ms）；歷史面板顯示先後用。 */
  at: number;
  before: Snapshot;
  after: Snapshot;
  /**
   * 連續同類動作合併成一筆的鍵（字幕打字 / 按住微調）：跟頂端那一筆同鍵、而且在 COALESCE_MS 內 → 改寫頂端那筆的 after，
   * 不再推一筆新的。不然打一句話要按二十次 Ctrl+Z。
   */
  coalesceKey?: string;
}

/** 同一段字幕連續打字 / 微調在這個時間內合併成一筆 undo（規格 §5.7：800 ms）。 */
export const COALESCE_MS = 800;

export const MAX_HISTORY = 200;

/** 共用的空值 —— 每次現做一個新陣列會讓「沒改過」的快照比較失敗。 */
const EMPTY_SHOTS: ShotV1[] = [];
const EMPTY_TRACKS: TrackV1[] = [];
const EMPTY_PLUGIN_MEDIA: PluginMediaState = Object.freeze({});

export interface NewTrackInit {
  /** 第一個關鍵幀所在的幀（也是預設參考影格）。 */
  frame: number;
  quad: Quad;
  label?: string;
  /** 沒有任何鏡頭涵蓋 frame 時，自動建一個 [0, frames) 的鏡頭；不給就 [0, frame+1)。 */
  frames?: number | null;
  /** 外掛的 track 鍵（例如 cards 的 slotId）：寫在 kind 後面（磁碟上的鍵順序跟以前一樣）。 */
  fields?: Readonly<Record<string, unknown>>;
  options?: Partial<TrackOptionsV1>;
}

/** 新物件 track（seg.find 的一個實例 / seg.select 傳播的結果，遮罩已經 objects.adopt 進快取）。 */
export interface NewObjectTrackInit {
  /** 先決定好的 id：遮罩在建 track 之前就搬進 tracks/<id>/masks.aivm（見 newObjectTrackId）。 */
  id: string;
  label: string;
  source: ObjectSourceV1;
  /** [k0, k1) 半開。 */
  range: [number, number];
  /** 「看得最清楚」的幀（bestFrame）；null = 沒有。 */
  referenceFrame: number | null;
  /** 省略 = 依序挑一個還沒用過的顏色。 */
  color?: string;
  /** 沒有鏡頭涵蓋 range 起點時補一個 [0, frames) 的鏡頭；不給就 [0, range[1])。 */
  frames?: number | null;
  /** 一起掛上的特效（隱私打碼：每條新物件一個馬賽克；跟新增同一筆 undo）。 */
  effects?: EffectV1[];
}

/** 物件 track 可以直接改的欄位（重新命名 / 換色 / 改範圍 / 改最佳幀）。 */
export type ObjectTrackPatch = Partial<Pick<TrackV1, "label" | "color" | "range" | "referenceFrame">>;

/** 物件 track 動作的 undo 標籤（zh key；這個檔在 check-i18n 的 TABLE_SOURCES 裡）。 */
export const OBJECT_EDIT_LABEL = {
  add: "新增物件",
  rename: "重新命名物件",
  recolor: "物件顏色",
  range: "物件範圍",
  referenceFrame: "物件最佳幀",
  edit: "編輯物件",
  remove: "刪除物件",
  effects: "物件特效",
  replace: "替換內容",
} as const;

let objectSeq = 0;
/**
 * 新物件 track 的 id。**不能重用**：遮罩檔在 tracks/<id>/ 底下，復原掉的 track 再被同一個 id 拿走會讀到別人的遮罩，
 * 所以用時間 + 計數（36 進位），不用「目前清單裡第幾條」。
 */
export function newObjectTrackId(taken: readonly { id: string }[] = [], now = Date.now()): string {
  let id: string;
  do id = `obj-${now.toString(36)}${(objectSeq++).toString(36)}`;
  while (taken.some((x) => x.id === id));
  return id;
}

/** 依序挑一個這支媒體還沒用過的顏色（全用過就輪回去）。 */
export function nextObjectColor(tracks: readonly TrackV1[], offset = 0): string {
  const used = new Set(tracks.filter((t) => t.kind === "object" && t.color).map((t) => t.color!.toUpperCase()));
  const free = OBJECT_COLORS.filter((c) => !used.has(c));
  const pool = free.length ? free : OBJECT_COLORS;
  return pool[offset % pool.length];
}

/** 記憶體形狀的物件 track（平面欄位補預設值，寫檔時不寫；見 format.ts objectTrackToJson）。 */
export function makeObjectTrack(init: NewObjectTrackInit, shotId: string, color: string): TrackV1 {
  return {
    id: init.id,
    shotId,
    label: init.label.trim() || init.id,
    kind: "object",
    referenceFrame: init.referenceFrame,
    trackingRegion: null,
    keyframes: [],
    prompts: [],
    adjust: { points: [], enabled: false },
    options: { ...DEFAULT_TRACK_OPTIONS },
    insert: null,
    regionPolicy: "full",
    stale: false,
    color,
    source: init.source,
    range: [init.range[0], init.range[1]],
    ...(init.effects?.length ? { effects: init.effects.map((e) => ({ ...e })) } : {}),
  };
}

/** 涵蓋 frame 的鏡頭；沒有就補一個 [0, max(frame+1, frames)) 的（還沒偵測鏡頭時）。 */
function hostShot(shots: readonly ShotV1[], frame: number, frames: number | null | undefined, taken: { id: string }[]): { shots: ShotV1[]; host: ShotV1 } {
  const host = shots.find((s) => s.startFrame <= frame && frame < s.endFrame);
  if (host) return { shots: shots as ShotV1[], host };
  const made: ShotV1 = { id: newId("shot-", taken), startFrame: 0, endFrame: Math.max(frame + 1, frames ?? 0), kind: "unknown", source: "user" };
  // 補的鏡頭不能跟既有的重疊：從前一個鏡頭的尾巴到下一個鏡頭的頭
  const prev = shots.filter((s) => s.endFrame <= frame).sort((a, b) => b.endFrame - a.endFrame)[0];
  const next = shots.filter((s) => s.startFrame > frame).sort((a, b) => a.startFrame - b.startFrame)[0];
  if (prev) made.startFrame = prev.endFrame;
  if (next) made.endFrame = next.startFrame;
  return { shots: sortShots([...shots, made]), host: made };
}

export interface DetectionResult {
  shots?: ShotV1[];
  tracks?: TrackV1[];
}

export interface ApplyDetectionOptions {
  /** 先丟掉純偵測器產生、使用者沒動過的舊 track（重跑偵測時）。 */
  replaceDetector?: boolean;
  /**
   * 外掛在同一筆 undo 裡併自己的狀態（例如 cards 的格位：使用者挑過的目標不能被重跑偵測洗掉）。
   * 拿到「留下來的 track」（已搬家），回傳調整過的 track（例如改指新的格位 id）與要寫的外掛狀態。
   */
  reconcile?: (kept: TrackV1[]) => { tracks: TrackV1[]; pluginMedia?: PluginMediaState };
}

export interface CommitOptions {
  /** 連續同類動作合併成一筆（規則同字幕打字的 COALESCE_MS）。 */
  coalesceKey?: string;
}

/** LLM 校對建議套用時的一條（段 id → 新文字 + 要強調的片語）。 */
export interface CaptionProposalApply {
  cueId: string;
  text: string;
  emphasis?: string[];
}

export interface EditsStore {
  shots: Record<string, ShotV1[]>;
  tracks: Record<string, TrackV1[]>;
  /** 外掛的每媒體狀態：mediaId → 鍵 → 值（核心不解讀；進 undo）。 */
  pluginMedia: Record<string, PluginMediaState>;
  /** 外掛的專案層狀態：鍵 → 值（核心不解讀；進 undo）。 */
  pluginProject: PluginProjectState;
  /** 每支媒體的字幕 track（沒有 = null / 缺鍵）。 */
  captions: Record<string, CaptionTrackV1 | null>;
  /** 專案的序列；null = 隱含序列（作用中媒體整段、未剪），第一次剪輯時才在同一筆 undo 裡實體化（§5.1）。 */
  sequence: SequenceV2 | null;
  /** 純音訊媒體（音樂 / 旁白 / 音效檔）；跟 project.media 分開，理由見 format.ts AudioMediaV2。 */
  audioMedia: AudioMediaV2[];
  past: Patch[];
  future: Patch[];

  // ---- 序列剪輯（M2.4；純函式在 src/sequence/ops.ts）----
  /**
   * 所有序列 / 音訊動作的單一入口，一次呼叫 = 一筆 undo（label 用 SEQ_EDIT_LABEL）。
   * - f 拿到的是**實體化過**的序列：目前是 null 時先用作用中媒體 materialize，實體化與動作在同一筆 commit，一次 Ctrl+Z 回到 null。
   * - f 回傳 null = 做不了 / 沒事做，什麼都不留（連 opts.audioMedia 也不套）；
   *   回傳**同一個參照** = 序列沒變（ops.ts 的約定），隱含序列維持 null，只有 opts.audioMedia 變了才留一筆。
   * - f 擲的 SequenceError（fps 不符、鎖定、重疊…）與實體化失敗（沒有作用中媒體 / 還沒有 proxy）原樣往外丟，狀態不變。
   * - I1 由結構保證：這裡的 commit 只給 sequence / audioMedia，tracks / shots / 外掛狀態連參照都不動。
   * 回傳有沒有留下一筆 undo。
   */
  editSequence: (label: string, f: (seq: SequenceV2, ctx: SeqCtx) => SequenceV2 | null, opts?: EditSequenceOptions) => boolean;
  /** 只動音訊媒體清單、不需要序列（匯入音訊檔但還沒放上音軌）：不會實體化序列。f 回 null 或同一個參照 = 不留 undo。 */
  editAudioMedia: (label: string, f: (list: AudioMediaV2[]) => AudioMediaV2[] | null) => boolean;
  /** 從專案移除音訊媒體，連同用到它的音訊片段（含鎖定的軌）一起刪，一筆 undo（可復原：清單與片段都在快照裡）。 */
  removeAudioMedia: (audioId: string) => boolean;
  /** 衍生的音訊時間資訊（media.audio_info）：**不記 undo**，同 markSolved —— 那是快取，不是使用者的動作。 */
  setAudioMediaInfo: (audioId: string, info: AudioInfoV2 | null) => void;
  /** 專案載入：直接放入（不記 undo）。 */
  loadSequence: (seq: SequenceV2 | null, audioMedia: AudioMediaV2[]) => void;

  // ---- 字幕（feat/captions；每個動作一筆 undo，打字 / 微調在 COALESCE_MS 內合併）----
  /** 整條換掉（產生 / 重新分段 / 刪除字幕 = null）。 */
  applyCaptions: (mediaId: string, track: CaptionTrackV1 | null, label?: string) => void;
  setCueText: (mediaId: string, cueId: string, text: string) => boolean;
  splitCue: (mediaId: string, cueId: string, wordIndex: number) => boolean;
  /** 播放線落在的段、在最近的字邊界切（B）。 */
  splitCueAtFrame: (mediaId: string, frame: number) => boolean;
  mergeCueWithNext: (mediaId: string, cueId: string) => boolean;
  /** frames = proxy 總幀數（最後一段往後推的上限）。 */
  nudgeCue: (mediaId: string, cueId: string, dFrames: number, edge: C.NudgeEdge, frames?: number | null) => boolean;
  toggleEmphasis: (mediaId: string, cueId: string, wordIndex: number) => boolean;
  /** 全部取代；回傳取代次數（0 = 沒有符合，不留 undo）。 */
  findReplace: (mediaId: string, query: string, replacement: string, opts?: { caseSensitive?: boolean; cueIds?: readonly string[] }) => number;
  setCaptionPreset: (mediaId: string, presetId: CaptionPresetId) => void;
  /** 樣式深層合併進 track.style（null 值 = 明確關掉，例如 shadow: null）。 */
  setCaptionStyle: (mediaId: string, patch: C.DeepPartial<CaptionStyleV1>) => void;
  /** 燒入開關（render `--captions auto` 看它）。 */
  setCaptionsEnabled: (mediaId: string, enabled: boolean) => void;
  deleteCue: (mediaId: string, cueId: string) => boolean;
  setCueHidden: (mediaId: string, cueId: string, hidden: boolean) => boolean;
  /** 在 frame 插一段；回新段 id（落在既有段內 / 沒空間 → null）。 */
  insertCueAt: (mediaId: string, frame: number, text: string, durationFrames: number, frames?: number | null) => string | null;
  /** LLM 校對建議（使用者按「套用」之後）：一筆 undo。回傳實際改到幾段。 */
  applyCaptionProposals: (mediaId: string, items: readonly CaptionProposalApply[]) => number;

  /** 整份鏡頭清單換掉（引擎 media.shots 的結果 / 使用者手動編輯）。 */
  setShots: (mediaId: string, shots: ShotV1[], label?: string) => void;
  /** 在 frame 切一刀：frame 必須落在某個鏡頭內部（不是邊界）。回傳有沒有切成。 */
  splitShot: (mediaId: string, frame: number) => boolean;
  /** 把 shotId 與它的下一個鏡頭併成一個；下一個鏡頭的 track 改指到合併後的鏡頭。 */
  mergeShots: (mediaId: string, shotId: string) => boolean;
  /** 新 track（含第一個使用者關鍵幀）；回傳 trackId。 */
  addTrack: (mediaId: string, init: NewTrackInit) => string;
  removeTrack: (mediaId: string, trackId: string) => void;
  /** 使用者硬釘：同一幀已有就覆寫。標 stale。 */
  setUserKeyframe: (mediaId: string, trackId: string, frame: number, quad: Quad, opts?: { lockedCorners?: KeyframeV1["lockedCorners"]; source?: KeyframeV1["source"]; label?: string }) => void;
  removeKeyframe: (mediaId: string, trackId: string, frame: number) => void;
  /** 加選 / 減選提示點；同一幀已有提示就併進去。 */
  addPrompt: (mediaId: string, trackId: string, frame: number, points: PromptPointV1[]) => void;
  /** 清掉某一幀的提示；不給 frame = 全部。 */
  clearPrompts: (mediaId: string, trackId: string, frame?: number) => void;
  setTrackOptions: (mediaId: string, trackId: string, patch: Partial<TrackOptionsV1>) => void;
  /**
   * 插入參數。預設**合併**（insert 為 null 時先從 `{ macro: "custom" }` 長出來再合併；Inspector 逐欄改用）；
   * `replace` = 整份換掉；patch 為 null = 清掉，全部繼承 insertDefaults。不標 stale（只影響合成，不影響解算）。
   */
  setTrackInsert: (mediaId: string, trackId: string, patch: Partial<InsertV1> | null, opts?: { replace?: boolean }) => void;
  /** 追蹤區域（null = 同表面）；改了要標 stale。 */
  setTrackingRegion: (mediaId: string, trackId: string, quad: Quad | null) => void;
  /** 其餘 track 欄位（標籤 / 參考影格 / 追蹤區域 / 區域策略 / AdjustTrack）。 */
  setTrackFields: (mediaId: string, trackId: string, patch: Partial<Pick<TrackV1, "label" | "referenceFrame" | "trackingRegion" | "regionPolicy" | "adjust">>, label: string) => void;
  // ---- 物件 track（通用物件；每個動作一筆 undo）----
  /** 一次加好幾條（find 勾了好幾個實例）= 一筆 undo；回傳實際加進去的 id（id 已存在的略過）。 */
  addObjectTracks: (mediaId: string, inits: readonly NewObjectTrackInit[]) => string[];
  /** 重新命名 / 換色 / 改範圍 / 改最佳幀（只對物件 track）；範圍改了 shotId 跟著改到涵蓋新起點的鏡頭。 */
  setObjectFields: (mediaId: string, trackId: string, patch: ObjectTrackPatch, frames?: number | null) => boolean;
  /** 刪好幾條 track（任何種類）= 一筆 undo。 */
  removeTracks: (mediaId: string, trackIds: readonly string[]) => void;
  /** 整份特效堆疊換掉（空陣列 = 拿掉 effects 鍵）。物件與平面 track 都可以。 */
  /** coalesceKey：拖數值 / 連續打字合併成一筆 undo（同 COALESCE_MS）。 */
  setTrackEffects: (mediaId: string, trackId: string, effects: EffectV1[], label?: string, opts?: { coalesceKey?: string }) => void;
  /** 平面 track 的替換內容（null = 拿掉）。 */
  setTrackReplace: (mediaId: string, trackId: string, replace: ReplaceV1 | null, opts?: { coalesceKey?: string }) => void;
  /** 解算完成：清 stale（連同原因）。**不記 undo** —— 這不是使用者的動作。 */
  markSolved: (mediaId: string, trackIds: string[]) => void;
  /**
   * 磁碟上的解 / 遮罩被別人重寫、跟 store 的向量狀態對不上了（重跑 `pipeline.run` 用同一個 track id 蓋掉使用者釘過的 track 的快取）：
   * 標解算相關的 stale（只差目標的升級成要重解）。**不記 undo**，同 markSolved —— 這是快取的事，不是使用者的動作。
   */
  markStale: (mediaId: string, trackIds: string[]) => void;
  /**
   * 引擎驗過「目前的解 + 目標可以渲染」：只清 `staleReason === "target"` 的 stale（上次解算後只改過目標 / 連結）。
   * 因為關鍵幀 / 選項 / 區域 / 牌組而 stale 的不動 —— 磁碟上的解早於那些修改，要真的重解。不記 undo。
   */
  markTargetsReady: (mediaId: string, trackIds: string[]) => void;
  /**
   * 自動偵測結果整批套用（鏡頭 + track，外掛的狀態由 opts.reconcile 一起併），一筆 undo。預設只加不蓋（使用者釘過的 track 留著）；
   * `replaceDetector` = 先丟掉純偵測器產生、使用者沒動過的舊 track（重跑偵測時）。
   */
  applyDetection: (mediaId: string, det: DetectionResult, label?: string, opts?: ApplyDetectionOptions) => void;
  /**
   * 外掛（與核心）共用的提交入口：一次呼叫 = 一筆 undo（label 是 zh key）。next 沒給的欄位沿用原本的**參照**；
   * pluginMedia / pluginProject 只給部分鍵時跟原本的合併。mediaId 是 PROJECT_SCOPE 時只寫專案層欄位。
   */
  commitEdit: (mediaId: string, label: string, next: Partial<Snapshot>, opts?: CommitOptions) => void;

  undo: () => void;
  redo: () => void;
  /** 直接跳到歷史上的第 n 個狀態（0 = 初始）。內部就是連續 undo / redo。 */
  jumpTo: (index: number) => void;
  /** 專案載入：直接放入（不記 undo）。 */
  load: (mediaId: string, snap: { shots?: ShotV1[]; tracks?: TrackV1[]; pluginMedia?: PluginMediaState; captions?: CaptionTrackV1 | null }) => void;
  /** 外掛的專案層狀態直接放入（專案載入 / 不進 undo 的專案設定；不標 dirty）：跟原本的合併。 */
  loadPluginProject: (patch: PluginProjectState) => void;
  /**
   * 移除媒體（project.removeMedia 在媒體還在清單上時呼叫）：丟掉它的鏡頭 / track / 外掛狀態 / 字幕，序列裡引用它的片段一起刪。
   * 歷史的處理見 historyAfterRemoval；回傳 true = 整個復原歷史被清掉（UI 提示 HISTORY_CLEARED_NOTICE）。
   */
  clear: (mediaId: string) => boolean;
  /** 新專案：全部清空。 */
  reset: () => void;
}

let idSeq = 0;
function newId(prefix: string, taken: { id: string }[]): string {
  let id: string;
  do id = `${prefix}${(++idSeq).toString(36)}`;
  while (taken.some((x) => x.id === id));
  return id;
}

function sortShots(list: ShotV1[]): ShotV1[] {
  return list.slice().sort((a, b) => a.startFrame - b.startFrame);
}

function sortKeyframes(list: KeyframeV1[]): KeyframeV1[] {
  return list.slice().sort((a, b) => a.frame - b.frame);
}

/**
 * stale 的兩種原因（TrackV1.staleReason）：
 * - 解算相關（關鍵幀 / 提示點 / 選項 / 追蹤區域 / 參考影格 / 鏡頭，外掛的例如牌組）→ `staleSolve`：磁碟上的解早於這次修改，只有真的重解才能清；
 * - 只動到替換目標 / 目標的連結（外掛的，例如牌格位）→ `staleTarget`：解還是對的，引擎驗過可渲染就能清（`markTargetsReady`）。
 * 已經因為解算相關而 stale 的 track 再換目標**不能降級**成「只差目標」，否則驗證目標時會把沒重解的變更蓋掉。
 */
export function staleSolve(t: TrackV1): TrackV1 {
  const { staleReason: _reason, ...rest } = t;
  return { ...rest, stale: true };
}

export function staleTarget(t: TrackV1): TrackV1 {
  return t.stale ? t : { ...t, stale: true, staleReason: "target" };
}

function solved(t: TrackV1): TrackV1 {
  const { staleReason: _reason, ...rest } = t;
  return { ...rest, stale: false };
}

/**
 * 換了鏡頭清單後，指不到鏡頭的 track 搬家：掛到涵蓋它第一個關鍵幀（沒有就參考影格）的鏡頭並標 stale；找不到就整條丟。
 * setShots 與 applyDetection 共用 —— 留在 store 裡卻指著不存在的鏡頭，下次存檔再開會被 sanitize 連關鍵幀一起刪掉。
 */
export function rehomeTracks(tracks: readonly TrackV1[], shots: readonly ShotV1[]): TrackV1[] {
  return tracks
    .map((t) => {
      if (shots.some((s) => s.id === t.shotId)) return t;
      // 物件 track 住在涵蓋範圍起點的鏡頭（契約）；平面 track 看第一個關鍵幀，沒有就參考影格
      const k = t.kind === "object" && t.range ? t.range[0] : t.keyframes[0]?.frame ?? t.referenceFrame;
      const host = k == null ? undefined : shots.find((s) => s.startFrame <= k && k < s.endFrame);
      if (!host) return null;
      return t.kind === "object" ? { ...t, shotId: host.id } : { ...staleSolve(t), shotId: host.id };
    })
    .filter((t): t is TrackV1 => !!t);
}

/** 從目前位置跳到 target 需要做幾次 undo / redo（超出範圍夾住）。 */
export function stepsTo(pastLen: number, futureLen: number, target: number): { undo: number; redo: number } {
  const total = pastLen + futureLen;
  const t = Math.min(total, Math.max(0, Math.round(target)));
  return t < pastLen ? { undo: pastLen - t, redo: 0 } : { undo: 0, redo: t - pastLen };
}

/** commit 的 after：沒給的欄位沿用 before 的**參照**（I1 靠這個：序列動作的 after.tracks === before.tracks）。 */
function mergeSnapshot(before: Snapshot, next: Partial<Snapshot>): Snapshot {
  return {
    shots: next.shots ?? before.shots,
    tracks: next.tracks ?? before.tracks,
    // 外掛狀態只給部分鍵時跟原本的合併；沒給 = 原本的參照（專案層沒動的 patch，before === after）
    pluginMedia: next.pluginMedia ? { ...before.pluginMedia, ...next.pluginMedia } : before.pluginMedia,
    pluginProject: next.pluginProject ? { ...before.pluginProject, ...next.pluginProject } : before.pluginProject,
    // null 是合法值（刪掉字幕 / 回到隱含序列），不能用 ??
    captions: next.captions !== undefined ? next.captions : before.captions,
    sequence: next.sequence !== undefined ? next.sequence : before.sequence,
    audioMedia: next.audioMedia ?? before.audioMedia,
  };
}

/** 序列有沒有用到這支媒體：V1 片段，或從它分離出來的原音片段。 */
export function sequenceUsesMedia(seq: SequenceV2 | null, mediaId: string): boolean {
  if (!seq) return false;
  return seq.video.some((it) => it.kind === "clip" && it.mediaId === mediaId) || seq.audioLanes.some((l) => l.clips.some((c) => c.source.type === "media" && c.source.mediaId === mediaId));
}

/** 移除媒體之後什麼都不剩（V1 沒有項目、所有音軌沒有片段）。 */
function isEmptySequence(seq: SequenceV2): boolean {
  return seq.video.length === 0 && seq.audioLanes.every((l) => l.clips.length === 0);
}

/**
 * 移除媒體後的復原歷史（設計 §6「clear(mediaId) 必須改」）。
 *
 * M1 直接把這支媒體的 patch 從歷史**中間**抽掉；但專案層欄位（外掛的專案層狀態、sequence、audioMedia）每筆 patch 都帶一份，
 * 從中間抽掉一筆「有改到專案層」的 patch，前後兩筆的 before / after 就接不起來，undo 會跳到錯的狀態。所以：
 * - 移除動作本身改了序列（刪了引用它的片段）→ 現況已經不等於任何一筆 after，**整個清掉**；
 * - 歷史裡任何一份序列快照引用這支媒體 → undo 會把指向不存在媒體的片段變回來，**整個清掉**；
 * - 這支媒體的 patch 有改到專案層（例如切換牌組）→ 抽不掉，**整個清掉**；
 * - 其餘（只追蹤、沒剪輯的專案 —— M1 的常見情況）照 M1 只抽掉這支媒體的 patch：這些 patch 的專案層 before === after，
 *   抽掉之後前後仍然接得起來。為什麼不一律清：Sidebar 的移除鈕不先確認，誤加一支影片再移掉就賠上整份歷史太傷。
 * cleared = 真的丟掉了至少一筆（UI 才需要提示）。
 */
export function historyAfterRemoval(past: Patch[], future: Patch[], mediaId: string, sequenceChanged: boolean): { past: Patch[]; future: Patch[]; cleared: boolean } {
  const all = [...past, ...future];
  const checked = new Set<SequenceV2>();
  const uses = (seq: SequenceV2 | null) => {
    if (!seq || checked.has(seq)) return false;
    checked.add(seq);
    return sequenceUsesMedia(seq, mediaId);
  };
  const touchesProject = (p: Patch) => p.before.pluginProject !== p.after.pluginProject || p.before.sequence !== p.after.sequence || p.before.audioMedia !== p.after.audioMedia;
  const mustClear = sequenceChanged || all.some((p) => (p.mediaId === mediaId && touchesProject(p)) || uses(p.before.sequence) || uses(p.after.sequence));
  if (mustClear) return { past: [], future: [], cleared: all.length > 0 };
  return { past: past.filter((p) => p.mediaId !== mediaId), future: future.filter((p) => p.mediaId !== mediaId), cleared: false };
}

/**
 * undo / redo 換回快照裡的音訊媒體清單時，把「現在已經算好的」衍生音訊資訊帶過去（同 id、同指紋才帶）。
 * 為什麼：`audio` 是檔案內容的純函式（media.audio_info 的快取），不進 undo（設計 §6）；不帶的話，
 * 匯入音樂後資訊算好了、再 undo 一個不相干的動作，清單會被換回資訊還是 null 的那份，又要重跑一次。
 */
export function carryAudioInfo(restored: AudioMediaV2[], current: readonly AudioMediaV2[]): AudioMediaV2[] {
  if (restored === current || !current.length || !restored.length) return restored;
  const byId = new Map(current.map((a) => [a.id, a]));
  let changed = false;
  const out = restored.map((a) => {
    const c = byId.get(a.id);
    if (!c || c === a || !c.audio || c.audio === a.audio || c.fingerprint !== a.fingerprint) return a;
    changed = true;
    return { ...a, audio: c.audio };
  });
  return changed ? out : restored;
}

export const useEdits = create<EditsStore>((set, get) => {
  const snapshot = (mediaId: string): Snapshot => ({
    shots: get().shots[mediaId] ?? EMPTY_SHOTS,
    tracks: get().tracks[mediaId] ?? EMPTY_TRACKS,
    pluginMedia: get().pluginMedia[mediaId] ?? EMPTY_PLUGIN_MEDIA,
    pluginProject: get().pluginProject,
    captions: get().captions[mediaId] ?? null,
    sequence: get().sequence,
    audioMedia: get().audioMedia,
  });
  const apply = (mediaId: string, snap: Snapshot) => {
    const project = { pluginProject: snap.pluginProject, sequence: snap.sequence, audioMedia: carryAudioInfo(snap.audioMedia, get().audioMedia) };
    // 專案層 patch 只寫專案層欄位：不然 shots["*project"] 這種垃圾鍵會長進 store，存檔時再被寫進專案檔
    if (mediaId === PROJECT_SCOPE) return project;
    return {
      shots: { ...get().shots, [mediaId]: snap.shots },
      tracks: { ...get().tracks, [mediaId]: snap.tracks },
      pluginMedia: { ...get().pluginMedia, [mediaId]: snap.pluginMedia },
      captions: { ...get().captions, [mediaId]: snap.captions },
      ...project,
    };
  };
  const commit = (mediaId: string, label: string, next: Partial<Snapshot>, record = true, coalesceKey?: string) => {
    const before = snapshot(mediaId);
    const after = mergeSnapshot(before, next);
    const now = Date.now();
    const top = get().past[get().past.length - 1];
    if (record && coalesceKey && top && top.coalesceKey === coalesceKey && top.mediaId === mediaId && now - top.at <= COALESCE_MS && !get().future.length) {
      // 合併：頂端那筆的 before 不動（undo 一次回到打字前），after 換成現在，時間往後推（持續打字就一直合併）
      set((s) => ({ ...apply(mediaId, after), past: [...s.past.slice(0, -1), { ...top, at: now, after }] }));
    } else {
      set((s) => ({
        ...apply(mediaId, after),
        past: record ? [...s.past.slice(-(MAX_HISTORY - 1)), { label, mediaId, at: now, before, after, ...(coalesceKey ? { coalesceKey } : {}) }] : s.past,
        future: record ? [] : s.future,
      }));
    }
    useProject.getState().markDirty();
  };
  const captionsOf = (mediaId: string): CaptionTrackV1 | null => get().captions[mediaId] ?? null;
  /** 字幕段的 reducer 結果 → commit；reducer 回 null（不能做 / 沒變）就不留 undo。 */
  const commitCues = (mediaId: string, label: string, f: (cues: readonly CaptionCueV1[], track: CaptionTrackV1) => CaptionCueV1[] | null, coalesceKey?: string): boolean => {
    const tr = captionsOf(mediaId);
    if (!tr) return false;
    const cues = f(tr.cues, tr);
    if (!cues) return false;
    commit(mediaId, label, { captions: { ...tr, cues } }, true, coalesceKey);
    return true;
  };
  /**
   * 隱含序列（null）→ 用作用中媒體實體化。沒有作用中媒體 / 還沒有 proxy 時 ensureSequence 擲 SequenceError（notFound / noProxy），
   * 指令層的 needsProxy 守門本來就擋在前面，這裡擲錯只是保險。
   */
  const materializeActive = (): SequenceV2 => {
    const p = useProject.getState();
    return ensureSequence(null, p.media.find((m) => m.id === p.activeMediaId));
  };
  const trackOf = (mediaId: string, trackId: string): TrackV1 | undefined => (get().tracks[mediaId] ?? EMPTY_TRACKS).find((t) => t.id === trackId);
  const patchTrack = (mediaId: string, trackId: string, f: (t: TrackV1) => TrackV1): TrackV1[] | null => {
    const list = get().tracks[mediaId] ?? EMPTY_TRACKS;
    if (!list.some((t) => t.id === trackId)) return null;
    return list.map((t) => (t.id === trackId ? f(t) : t));
  };

  return {
    shots: {},
    tracks: {},
    pluginMedia: {},
    // store 建立時外掛多半還沒登記（外掛 import 核心，核心一定先建好）：登記之後 plugins/init.ts 會補上初值
    pluginProject: initialPluginProject(),
    captions: {},
    sequence: null,
    audioMedia: [],
    past: [],
    future: [],

    commitEdit: (mediaId, label, next, opts = {}) => commit(mediaId, label, next, true, opts.coalesceKey),

    // ---- 序列剪輯 ----
    editSequence: (label, f, opts = {}) => {
      const cur = get().sequence;
      const audioMedia = opts.audioMedia ?? get().audioMedia;
      // ctx 用「這一筆之後」的音訊媒體清單：匯入音樂並放上音軌時，f 要查得到新媒體的取樣率與長度
      const ctx = makeSeqCtx(useProject.getState().media, audioMedia);
      const base = cur ?? materializeActive();
      const next = f(base, ctx);
      if (next === null) return false;
      // 同一個參照 = 序列沒變：隱含序列不因為「試著剪但沒剪到」就被實體化（在剪輯點上按 B 不該讓檔案升成 v2）
      const sequence = next === base ? cur : next;
      if (sequence === cur && audioMedia === get().audioMedia) return false;
      commit(PROJECT_SCOPE, label, { sequence, audioMedia }, true, opts.coalesceKey);
      return true;
    },

    editAudioMedia: (label, f) => {
      const cur = get().audioMedia;
      const next = f(cur);
      if (!next || next === cur) return false;
      commit(PROJECT_SCOPE, label, { audioMedia: next });
      return true;
    },

    removeAudioMedia: (audioId) => {
      const cur = get().audioMedia;
      if (!cur.some((a) => a.id === audioId)) return false;
      const seq = get().sequence;
      commit(PROJECT_SCOPE, SEQ_EDIT_LABEL.removeAudioMedia, { audioMedia: cur.filter((a) => a.id !== audioId), sequence: seq && removeAudioMediaRefs(seq, audioId) });
      return true;
    },

    setAudioMediaInfo: (audioId, info) => {
      const cur = get().audioMedia;
      const hit = cur.find((a) => a.id === audioId);
      if (!hit || hit.audio === info) return;
      set({ audioMedia: cur.map((a) => (a.id === audioId ? { ...a, audio: info } : a)) });
    },

    loadSequence: (seq, audioMedia) => set({ sequence: seq, audioMedia }),

    // ---- 字幕 ----
    applyCaptions: (mediaId, track, label = "產生字幕") => {
      if (captionsOf(mediaId) === track) return;
      commit(mediaId, track ? label : "刪除字幕", { captions: track });
    },

    setCueText: (mediaId, cueId, text) => commitCues(mediaId, "編輯字幕文字", (cues) => C.setCueText(cues, cueId, text), `text:${cueId}`),

    splitCue: (mediaId, cueId, wordIndex) => commitCues(mediaId, "分割字幕", (cues) => C.splitCue(cues, cueId, wordIndex)),

    splitCueAtFrame: (mediaId, frame) =>
      commitCues(mediaId, "分割字幕", (cues) => {
        const at = C.splitPointAt(cues, frame);
        return at ? C.splitCue(cues, at.cueId, at.wordIndex) : null;
      }),

    mergeCueWithNext: (mediaId, cueId) => commitCues(mediaId, "合併字幕", (cues) => C.mergeCueWithNext(cues, cueId)),

    nudgeCue: (mediaId, cueId, dFrames, edge, frames = null) => commitCues(mediaId, "調整字幕時間", (cues) => C.nudgeCue(cues, cueId, dFrames, edge, frames), `nudge:${cueId}:${edge}`),

    toggleEmphasis: (mediaId, cueId, wordIndex) => commitCues(mediaId, "切換強調", (cues) => C.toggleEmphasis(cues, cueId, wordIndex)),

    findReplace: (mediaId, query, replacement, opts = {}) => {
      let count = 0;
      commitCues(mediaId, "取代字幕文字", (cues, tr) => {
        const r = C.replaceInCues(cues, query, replacement, { ...opts, cjkLatinSpace: C.effectiveStyle(tr).font.cjkLatinSpace });
        count = r?.count ?? 0;
        return r?.cues ?? null;
      });
      return count;
    },

    setCaptionPreset: (mediaId, presetId) => {
      const tr = captionsOf(mediaId);
      if (!tr || tr.presetId === presetId) return;
      // 只換樣式、不重新分段（段落是使用者可能逐段修過的東西）；要依新預設重新分段走 pipeline/captions.rebuildCaptions
      commit(mediaId, "字幕預設樣式", { captions: { ...tr, presetId } });
    },

    setCaptionStyle: (mediaId, patch) => {
      const tr = captionsOf(mediaId);
      if (!tr) return;
      const style = C.deepMerge(tr.style, patch);
      if (JSON.stringify(style) === JSON.stringify(tr.style)) return;
      commit(mediaId, "字幕樣式", { captions: { ...tr, style } }, true, "captionStyle");
    },

    setCaptionsEnabled: (mediaId, enabled) => {
      const tr = captionsOf(mediaId);
      if (!tr || tr.enabled === enabled) return;
      commit(mediaId, enabled ? "開啟燒入字幕" : "關閉燒入字幕", { captions: { ...tr, enabled } });
    },

    deleteCue: (mediaId, cueId) => commitCues(mediaId, "刪除字幕段", (cues) => C.deleteCue(cues, cueId)),

    setCueHidden: (mediaId, cueId, hidden) => commitCues(mediaId, hidden ? "隱藏字幕段" : "顯示字幕段", (cues) => C.setCueHidden(cues, cueId, hidden)),

    insertCueAt: (mediaId, frame, text, durationFrames, frames = null) => {
      let id: string | null = null;
      commitCues(mediaId, "插入字幕段", (cues) => {
        const r = C.insertCueAt(cues, frame, text, durationFrames, frames);
        id = r?.id ?? null;
        return r?.cues ?? null;
      });
      return id;
    },

    applyCaptionProposals: (mediaId, items) => {
      let changed = 0;
      commitCues(mediaId, "套用 LLM 校對", (cues) => {
        const r = C.applyProposals(cues, items);
        changed = r.changed;
        return r.changed ? r.cues : null;
      });
      return changed;
    },

    setShots: (mediaId, shots, label = "更新鏡頭") => {
      const next = sortShots(shots);
      commit(mediaId, label, { shots: next, tracks: rehomeTracks(get().tracks[mediaId] ?? EMPTY_TRACKS, next) });
    },

    splitShot: (mediaId, frame) => {
      const shots = get().shots[mediaId] ?? EMPTY_SHOTS;
      const host = shots.find((s) => s.startFrame < frame && frame < s.endFrame);
      if (!host) return false;
      const tail: ShotV1 = { id: newId("shot-", shots), startFrame: frame, endFrame: host.endFrame, kind: host.kind, source: "user" };
      const head: ShotV1 = { ...host, endFrame: frame, source: "user" };
      const next = sortShots([...shots.filter((s) => s.id !== host.id), head, tail]);
      // 關鍵幀全在切點之後的 track 跟著去後半段；跨界的留在前半段並標 stale（引擎會在下一次解算時提示要拆）
      const tracks = (get().tracks[mediaId] ?? EMPTY_TRACKS).map((t) => {
        if (t.shotId !== host.id) return t;
        // 物件 track 沒有關鍵幀也不用重解：範圍起點落在後半段就搬過去（遮罩檔不受鏡頭影響）
        if (t.kind === "object") return t.range && t.range[0] >= frame ? { ...t, shotId: tail.id } : t;
        const ks = t.keyframes.map((k) => k.frame);
        if (ks.length && ks.every((k) => k >= frame)) return { ...staleSolve(t), shotId: tail.id };
        if (ks.some((k) => k >= frame)) return staleSolve(t);
        return t;
      });
      commit(mediaId, "切鏡頭", { shots: next, tracks });
      return true;
    },

    mergeShots: (mediaId, shotId) => {
      const shots = sortShots(get().shots[mediaId] ?? EMPTY_SHOTS);
      const i = shots.findIndex((s) => s.id === shotId);
      if (i < 0 || i + 1 >= shots.length) return false;
      const a = shots[i];
      const b = shots[i + 1];
      const merged: ShotV1 = { ...a, endFrame: b.endFrame, kind: a.kind === b.kind ? a.kind : "unknown", source: "user" };
      const next = shots.filter((s) => s.id !== a.id && s.id !== b.id).concat(merged);
      const tracks = (get().tracks[mediaId] ?? EMPTY_TRACKS).map((t) => (t.shotId === b.id ? { ...staleSolve(t), shotId: merged.id } : t));
      commit(mediaId, "合併鏡頭", { shots: sortShots(next), tracks });
      return true;
    },

    addTrack: (mediaId, init) => {
      let shots = get().shots[mediaId] ?? EMPTY_SHOTS;
      let host = shots.find((s) => s.startFrame <= init.frame && init.frame < s.endFrame);
      if (!host) {
        // 還沒偵測鏡頭（或 frame 落在缺口）：補一個涵蓋整支的鏡頭，track 才有地方住
        const end = Math.max(init.frame + 1, init.frames ?? 0);
        host = { id: newId("shot-", shots), startFrame: 0, endFrame: end, kind: "unknown", source: "user" };
        shots = sortShots([...shots, host]);
      }
      const tracks = get().tracks[mediaId] ?? EMPTY_TRACKS;
      const id = newId("track-", tracks);
      const tr: TrackV1 = {
        id,
        shotId: host.id,
        label: init.label?.trim() || `Track ${tracks.length + 1}`,
        kind: "planar",
        // 外掛的 track 鍵（例如 cards 的 slotId）：位置跟以前的 slotId 一樣，存出來的鍵順序不變
        ...(init.fields ?? {}),
        referenceFrame: init.frame,
        trackingRegion: null,
        keyframes: [{ frame: init.frame, quad: init.quad, source: "user" }],
        prompts: [],
        adjust: { points: [], enabled: false },
        options: { ...DEFAULT_TRACK_OPTIONS, ...init.options },
        insert: null,
        regionPolicy: defaultRegionPolicy(),
        stale: true,
      };
      commit(mediaId, "新增追蹤", { shots, tracks: [...tracks, tr] });
      return id;
    },

    removeTrack: (mediaId, trackId) => {
      const list = get().tracks[mediaId] ?? EMPTY_TRACKS;
      if (!list.some((t) => t.id === trackId)) return;
      commit(mediaId, "移除追蹤", { tracks: list.filter((t) => t.id !== trackId) });
    },

    setUserKeyframe: (mediaId, trackId, frame, quad, opts = {}) => {
      const next = patchTrack(mediaId, trackId, (t) => {
        const kf: KeyframeV1 = { frame, quad, source: opts.source ?? "user", ...(opts.lockedCorners ? { lockedCorners: opts.lockedCorners } : {}) };
        return { ...staleSolve(t), keyframes: sortKeyframes([...t.keyframes.filter((k) => k.frame !== frame), kf]) };
      });
      if (next) commit(mediaId, opts.label ?? "設關鍵幀", { tracks: next });
    },

    removeKeyframe: (mediaId, trackId, frame) => {
      const t = trackOf(mediaId, trackId);
      if (!t || !t.keyframes.some((k) => k.frame === frame)) return;
      const next = patchTrack(mediaId, trackId, (x) => ({ ...staleSolve(x), keyframes: x.keyframes.filter((k) => k.frame !== frame) }));
      if (next) commit(mediaId, "移除關鍵幀", { tracks: next });
    },

    addPrompt: (mediaId, trackId, frame, points) => {
      if (!points.length) return;
      const next = patchTrack(mediaId, trackId, (t) => {
        const cur = t.prompts.find((p) => p.frame === frame);
        const merged = cur ? t.prompts.map((p) => (p.frame === frame ? { frame, points: [...p.points, ...points] } : p)) : [...t.prompts, { frame, points }];
        return { ...staleSolve(t), prompts: merged.sort((a, b) => a.frame - b.frame) };
      });
      if (next) commit(mediaId, points.every((p) => p.label === 1) ? "加選" : points.every((p) => p.label === 0) ? "減選" : "加選 / 減選", { tracks: next });
    },

    clearPrompts: (mediaId, trackId, frame) => {
      const t = trackOf(mediaId, trackId);
      if (!t) return;
      const keep = frame == null ? [] : t.prompts.filter((p) => p.frame !== frame);
      if (keep.length === t.prompts.length) return;
      const next = patchTrack(mediaId, trackId, (x) => ({ ...staleSolve(x), prompts: keep }));
      if (next) commit(mediaId, "清除提示點", { tracks: next });
    },

    setTrackOptions: (mediaId, trackId, patch) => {
      const next = patchTrack(mediaId, trackId, (t) => ({ ...staleSolve(t), options: { ...t.options, ...patch } }));
      if (next) commit(mediaId, "追蹤選項", { tracks: next });
    },

    setTrackInsert: (mediaId, trackId, patch, opts = {}) => {
      const next = patchTrack(mediaId, trackId, (t) => {
        if (patch === null) return { ...t, insert: null };
        if (opts.replace) return { ...t, insert: { macro: patch.macro ?? t.insert?.macro ?? "custom", ...patch } };
        const base: InsertV1 = t.insert ?? { macro: "custom" };
        return { ...t, insert: { ...base, ...patch, macro: patch.macro ?? base.macro } };
      });
      if (next) commit(mediaId, "插入參數", { tracks: next });
    },

    setTrackingRegion: (mediaId, trackId, quad) => {
      const t = trackOf(mediaId, trackId);
      if (!t || JSON.stringify(t.trackingRegion) === JSON.stringify(quad)) return;
      const next = patchTrack(mediaId, trackId, (x) => ({ ...staleSolve(x), trackingRegion: quad }));
      if (next) commit(mediaId, quad ? "追蹤區域" : "追蹤區域＝表面", { tracks: next });
    },

    setTrackFields: (mediaId, trackId, patch, label) => {
      // 參考影格 / 追蹤區域變了要重解；標籤 / 區域策略不用
      const affectsSolve = "referenceFrame" in patch || "trackingRegion" in patch || "adjust" in patch;
      const next = patchTrack(mediaId, trackId, (t) => (affectsSolve ? staleSolve({ ...t, ...patch }) : { ...t, ...patch }));
      if (next) commit(mediaId, label, { tracks: next });
    },

    addObjectTracks: (mediaId, inits) => {
      let shots = get().shots[mediaId] ?? EMPTY_SHOTS;
      const cur = get().tracks[mediaId] ?? EMPTY_TRACKS;
      const added: TrackV1[] = [];
      for (const init of inits) {
        if (cur.some((t) => t.id === init.id) || added.some((t) => t.id === init.id)) continue;
        if (!(init.range[1] > init.range[0])) continue;
        const h = hostShot(shots, init.range[0], init.frames ?? init.range[1], shots);
        shots = h.shots;
        const color = init.color && /^#[0-9a-fA-F]{6}$/.test(init.color) ? init.color : nextObjectColor([...cur, ...added]);
        added.push(makeObjectTrack(init, h.host.id, color));
      }
      if (!added.length) return [];
      commit(mediaId, OBJECT_EDIT_LABEL.add, { shots, tracks: [...cur, ...added] });
      return added.map((t) => t.id);
    },

    setObjectFields: (mediaId, trackId, patch, frames) => {
      const t = trackOf(mediaId, trackId);
      if (!t || t.kind !== "object") return false;
      const next: ObjectTrackPatch = {};
      if (patch.label !== undefined && patch.label.trim() && patch.label.trim() !== t.label) next.label = patch.label.trim();
      if (patch.color !== undefined && /^#[0-9a-fA-F]{6}$/.test(patch.color) && patch.color !== t.color) next.color = patch.color;
      if (patch.range && patch.range[1] > patch.range[0] && patch.range[0] >= 0 && (patch.range[0] !== t.range?.[0] || patch.range[1] !== t.range?.[1])) next.range = [patch.range[0], patch.range[1]];
      if (patch.referenceFrame !== undefined && patch.referenceFrame !== t.referenceFrame) next.referenceFrame = patch.referenceFrame;
      const keys = Object.keys(next) as (keyof ObjectTrackPatch)[];
      if (!keys.length) return false;
      let shots = get().shots[mediaId] ?? EMPTY_SHOTS;
      let shotId = t.shotId;
      if (next.range) {
        // 契約：shotId = 涵蓋範圍起點的鏡頭（存檔再開時 sanitize 用它驗）
        const h = hostShot(shots, next.range[0], frames ?? next.range[1], shots);
        shots = h.shots;
        shotId = h.host.id;
      }
      const label = keys.length > 1 ? OBJECT_EDIT_LABEL.edit : keys[0] === "label" ? OBJECT_EDIT_LABEL.rename : keys[0] === "color" ? OBJECT_EDIT_LABEL.recolor : keys[0] === "range" ? OBJECT_EDIT_LABEL.range : OBJECT_EDIT_LABEL.referenceFrame;
      const tracks = (get().tracks[mediaId] ?? EMPTY_TRACKS).map((x) => (x.id === trackId ? { ...x, ...next, shotId } : x));
      commit(mediaId, label, shots === get().shots[mediaId] ? { tracks } : { shots, tracks });
      return true;
    },

    removeTracks: (mediaId, trackIds) => {
      const ids = new Set(trackIds);
      const list = get().tracks[mediaId] ?? EMPTY_TRACKS;
      const gone = list.filter((t) => ids.has(t.id));
      if (!gone.length) return;
      const allObjects = gone.every((t) => t.kind === "object");
      const label = allObjects ? OBJECT_EDIT_LABEL.remove : "移除追蹤";
      commit(mediaId, label, { tracks: list.filter((t) => !ids.has(t.id)) });
    },

    setTrackEffects: (mediaId, trackId, effects, label = OBJECT_EDIT_LABEL.effects, opts = {}) => {
      const next = patchTrack(mediaId, trackId, (t) => {
        const { effects: _old, ...rest } = t;
        return effects.length ? { ...rest, effects } : rest;
      });
      if (next) commit(mediaId, label, { tracks: next }, true, opts.coalesceKey);
    },

    setTrackReplace: (mediaId, trackId, replace, opts = {}) => {
      const t = trackOf(mediaId, trackId);
      if (!t || t.kind === "object") return;
      const next = patchTrack(mediaId, trackId, (x) => {
        const { replace: _old, ...rest } = x;
        return replace ? { ...rest, replace } : rest;
      });
      if (next) commit(mediaId, OBJECT_EDIT_LABEL.replace, { tracks: next }, true, opts.coalesceKey);
    },

    // markSolved / markStale / markTargetsReady 改的是 TrackV1.stale / staleReason —— 那兩個欄位會寫進專案檔。
    // 不 markDirty() 的話 rev 不動，saveTo 的去重就會把排在後面那筆存檔當成「這一版寫過了」而跳過：
    // 記憶體說「要重解」、磁碟還停在 stale:false，而且 dirty 被清掉，之後也不會有自動儲存來補（REL-9／B-20）。
    // 不進 undo 歷史（這是解算結果的狀態，不是使用者的編輯），所以不走 commit。
    markSolved: (mediaId, trackIds) => {
      const list = get().tracks[mediaId];
      if (!list) return;
      const ids = new Set(trackIds);
      if (!list.some((t) => ids.has(t.id) && t.stale)) return;
      set((s) => ({ tracks: { ...s.tracks, [mediaId]: list.map((t) => (ids.has(t.id) ? solved(t) : t)) } }));
      useProject.getState().markDirty();
    },

    markStale: (mediaId, trackIds) => {
      const list = get().tracks[mediaId];
      if (!list) return;
      const ids = new Set(trackIds);
      // 已經是「要重解」的 stale 沿用原物件（訂閱者不必重算）；「只差目標」的要升級，否則 validateTargets 會把它清掉
      const hit = (t: TrackV1) => ids.has(t.id) && !(t.stale && !t.staleReason);
      if (!list.some(hit)) return;
      set((s) => ({ tracks: { ...s.tracks, [mediaId]: list.map((t) => (hit(t) ? staleSolve(t) : t)) } }));
      useProject.getState().markDirty();
    },

    markTargetsReady: (mediaId, trackIds) => {
      const list = get().tracks[mediaId];
      if (!list) return;
      const ids = new Set(trackIds);
      const clear = (t: TrackV1) => ids.has(t.id) && t.stale && t.staleReason === "target";
      if (!list.some(clear)) return;
      set((s) => ({ tracks: { ...s.tracks, [mediaId]: list.map((t) => (clear(t) ? solved(t) : t)) } }));
      useProject.getState().markDirty();
    },

    applyDetection: (mediaId, det, label = "自動偵測", opts = {}) => {
      const shots = det.shots ? sortShots(det.shots) : get().shots[mediaId] ?? EMPTY_SHOTS;
      const shotIds = new Set(shots.map((s) => s.id));
      // 偵測到的 track 只加不蓋：使用者釘過的 track 留著（重跑偵測不該洗掉手工）。
      // replaceDetector：關鍵幀全是偵測器給的（沒有任何使用者硬釘）的舊 track 視為「上一次偵測的結果」，換掉。
      let cur = get().tracks[mediaId] ?? EMPTY_TRACKS;
      if (opts.replaceDetector && det.tracks) cur = cur.filter(hasUserEdits);
      // 留下來的 track 可能指著被換掉的鏡頭（先按 N 畫一條 → addTrack 補的 shot-1，再跑偵測拿到 shot1..4）：
      // 跟 setShots 同一套規則搬家，不然存檔再開時 sanitize 會把整條連關鍵幀一起丟掉
      cur = rehomeTracks(cur, shots);
      // 外掛在同一筆 undo 裡併自己的狀態（例如 cards：使用者挑過的目標 / 自己連過的格位不能被重跑偵測洗掉）
      let pluginMedia: PluginMediaState | undefined;
      if (opts.reconcile) {
        const merged = opts.reconcile(cur);
        cur = merged.tracks;
        pluginMedia = merged.pluginMedia;
      }
      const curIds = new Set(cur.map((t) => t.id));
      const added = (det.tracks ?? []).filter((t) => !curIds.has(t.id) && shotIds.has(t.shotId));
      const tracks = det.tracks ? [...cur, ...added] : cur;
      commit(mediaId, label, { shots, tracks, ...(pluginMedia ? { pluginMedia } : {}) });
    },

    undo: () => {
      const p = get().past[get().past.length - 1];
      if (!p) return;
      set((s) => ({ ...apply(p.mediaId, p.before), past: s.past.slice(0, -1), future: [...s.future, p] }));
      useProject.getState().markDirty();
    },
    redo: () => {
      const p = get().future[get().future.length - 1];
      if (!p) return;
      set((s) => ({ ...apply(p.mediaId, p.after), future: s.future.slice(0, -1), past: [...s.past, p] }));
      useProject.getState().markDirty();
    },
    jumpTo: (index) => {
      const { past, future } = get();
      const { undo, redo } = stepsTo(past.length, future.length, index);
      for (let i = 0; i < undo; i++) get().undo();
      for (let i = 0; i < redo; i++) get().redo();
    },

    load: (mediaId, snap) =>
      set((s) => ({
        shots: { ...s.shots, [mediaId]: snap.shots ?? EMPTY_SHOTS },
        tracks: { ...s.tracks, [mediaId]: snap.tracks ?? EMPTY_TRACKS },
        pluginMedia: { ...s.pluginMedia, [mediaId]: snap.pluginMedia ?? EMPTY_PLUGIN_MEDIA },
        captions: { ...s.captions, [mediaId]: snap.captions ?? null },
      })),
    loadPluginProject: (patch) => set((s) => ({ pluginProject: { ...s.pluginProject, ...patch } })),
    clear: (mediaId) => {
      const s = get();
      // 序列裡引用它的片段一起刪（V1 波紋刪除、分離出來的原音連鎖定軌也刪）。ctx 要在媒體還在清單上時建：
      // 同步鎖軌被波紋切開的片段要查來源取樣率。什麼都不剩就回到隱含序列 —— 空序列不能預覽也不能輸出。
      const removed = s.sequence && removeMediaRefs(s.sequence, mediaId, makeSeqCtx(useProject.getState().media, s.audioMedia));
      const sequence = removed && removed !== s.sequence && isEmptySequence(removed) ? null : removed;
      const history = historyAfterRemoval(s.past, s.future, mediaId, sequence !== s.sequence);
      set((st) => {
        const shots = { ...st.shots };
        const tracks = { ...st.tracks };
        const pluginMedia = { ...st.pluginMedia };
        const captions = { ...st.captions };
        delete shots[mediaId];
        delete tracks[mediaId];
        delete pluginMedia[mediaId];
        delete captions[mediaId];
        return { shots, tracks, pluginMedia, captions, sequence, past: history.past, future: history.future };
      });
      if (sequence !== s.sequence) useProject.getState().markDirty();
      return history.cleared;
    },
    reset: () => set({ shots: {}, tracks: {}, pluginMedia: {}, pluginProject: initialPluginProject(), captions: {}, sequence: null, audioMedia: [], past: [], future: [] }),
  };
});

/**
 * 使用者動過這條 track（有硬釘的關鍵幀或 AdjustTrack 點）。重跑偵測（applyDetection replaceDetector）只留這種；
 * `pipeline.run` 蓋掉同 id 快取時也只有這種要標 stale 重解（純偵測器的 track 本來就是被換掉的那份）。
 */
export function hasUserEdits(t: TrackV1): boolean {
  // 物件 track 一定是使用者挑的（find 勾的 / 手動選的）：重跑外掛的自動偵測時不能被當成「上一次偵測的結果」換掉
  if (t.kind === "object") return true;
  return t.keyframes.some((k) => k.source === "user") || t.adjust.points.length > 0;
}

/** 目前這條 track 有幾個使用者硬釘（偵測空心不算）。 */
export function userKeyframeCount(t: TrackV1): number {
  return t.keyframes.filter((k) => k.source === "user").length;
}

/** 涵蓋 frame 的鏡頭。 */
export function shotAt(shots: readonly ShotV1[], frame: number): ShotV1 | null {
  return shots.find((s) => s.startFrame <= frame && frame < s.endFrame) ?? null;
}
