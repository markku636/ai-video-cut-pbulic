import type { EngineStateKind, MediaProbe, ProxyMeta } from "../api";
import type { InsertV1, PromptPointV1, Quad, ShotV1, TrackOptionsV1, TrackV1 } from "../project/format";
import type { PluginMediaState } from "../plugins/api";

/**
 * stage / frametimeline / inspector 拿 project / edits / engine 三個 store 的單一落點。
 *
 * 這三個 store 曾與這裡並行開發：當時檔尾是 STUB，讓兩邊不在編譯期互相卡住；現在檔尾改成 re-export 真的 store。
 * 這裡宣告的 *Like 介面留著當**契約文件**＝這三個目錄依賴的最小形狀（欄位名、動作簽名）。
 * store 多出來的欄位沒關係，少了或簽名不同 tsc 會在 re-export 的使用處抓到。
 */

// ---- useProject ----

export interface MediaItemLike {
  id: string;
  name: string;
  path: string;
  fingerprint: string;
  probe: MediaProbe | null;
  /** null = proxy 還沒好；VideoStage 沒有它就不掛 <video>。 */
  proxy: ProxyMeta | null;
}

export interface ProjectStateLike {
  media: MediaItemLike[];
  activeMediaId: string | null;
}

// ---- useEdits（undo 內的向量狀態；計畫 §8 store/edits.ts）----

export interface EditsSnapshotLike {
  shots: ShotV1[];
  tracks: TrackV1[];
  /** 外掛的這支媒體狀態（核心不解讀）。 */
  pluginMedia: PluginMediaState;
}

/** 一步可復原的變更（形狀照 ai-music-cut decisions.ts 的 Patch）。 */
export interface EditPatchLike {
  label: string;
  mediaId: string;
  /** epoch ms；歷史面板顯示先後用。 */
  at: number;
  before: EditsSnapshotLike;
  after: EditsSnapshotLike;
}

export interface EditsStateLike {
  shots: Record<string, ShotV1[]>;
  tracks: Record<string, TrackV1[]>;
  pluginMedia: Record<string, PluginMediaState>;
  past: EditPatchLike[];
  future: EditPatchLike[];
  /** 拖表面角放手 = 一個 commit；同幀已有關鍵幀就覆寫其 quad（source 變 user）。 */
  setUserKeyframe: (mediaId: string, trackId: string, frame: number, quad: Quad) => void;
  removeKeyframe: (mediaId: string, trackId: string, frame: number) => void;
  /** 同幀已有 prompt 就把 points 併進去。 */
  addPrompt: (mediaId: string, trackId: string, frame: number, points: PromptPointV1[]) => void;
  setTrackOptions: (mediaId: string, trackId: string, patch: Partial<TrackOptionsV1>) => void;
  /** insert 為 null 時要先從 { macro: "custom" } 長出來再合併。 */
  setTrackInsert: (mediaId: string, trackId: string, patch: Partial<InsertV1>) => void;
  /** 追蹤區域（null = 同表面）；改了要標 stale。 */
  setTrackingRegion: (mediaId: string, trackId: string, quad: Quad | null) => void;
  undo: () => void;
  redo: () => void;
  /** 跳到歷史第 n 個狀態（0 = 初始）。 */
  jumpTo: (index: number) => void;
}

// ---- useEngine（計畫 §7.2 引擎監督）----

export interface EngineStateLike {
  state: EngineStateKind;
  /** hello.device 的人話（"NVIDIA GeForce RTX 5070 Ti"）；沒有就 null。 */
  gpuName: string | null;
  message: string | null;
  restart: () => void | Promise<void>;
}

// ---- 真的 store（已落地）：以下三行取代原本的 STUB 區。*Like 介面留著當契約文件，
// 任何一邊改了形狀，tsc 會在這三行 re-export 的使用處抓到。
export { useProject } from "../store/project";
export { useEdits } from "../store/edits";
export { useEngine } from "../store/engine";
