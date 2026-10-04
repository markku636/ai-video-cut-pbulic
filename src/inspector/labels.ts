import type { EngineStateKind } from "../api";
import type { TrackMode } from "../stage/viewMode";
import type { JobStatus } from "../store/jobs";
import type { TimelineTool } from "../store/timeline";

/**
 * Inspector 的繁中標籤表（zh key；顯示時 t() 過）。在 check-i18n.mjs 的 TABLE_SOURCES 裡：每一句都要進 locales/en.ts。
 * enum 值不准直接出現在畫面上，全部經過這裡。
 */

/** 核心的右側欄分頁；外掛可以加自己的（plugins/api.ts inspectorTabs，標籤由外掛給）。 */
export type CoreInspectorTab = "objects" | "track" | "mask" | "captions" | "clip" | "jobs" | "history" | "advice" | "assistant";
export type InspectorTab = CoreInspectorTab | (string & {});

export const TAB_LABEL: Record<CoreInspectorTab, string> = {
  // 通用物件（找物件 / 選取物件 / 物件清單）：「追蹤任何東西」的主頁
  objects: "物件",
  track: "追蹤",
  mask: "物件遮罩",
  captions: "字幕",
  clip: "片段",
  jobs: "工作",
  history: "歷史",
  // 規則式的檢查（inspector/advice.ts）：不需要模型，開著就有
  advice: "建議",
  // 自然語言助手：一句話 → 一份計畫（assistant/），要設定 LLM 端點
  assistant: "助手",
};

export const TRACK_MODE_LABEL: Record<TrackMode, string> = {
  track: "追蹤",
  adjust: "調整追蹤",
};

/** 遮罩面板的工具三段（select 只是「離開遮罩工具」）。 */
export const MASK_TOOL_LABEL: Record<Extract<TimelineTool, "select" | "maskPos" | "maskNeg">, string> = {
  select: "選取",
  maskPos: "加選",
  maskNeg: "減選",
};

/** 計畫 §8 的 JobKind；store/jobs.ts 現在還是舊表，所以用 string 鍵、查不到就顯示原字。 */
export const JOB_KIND_LABEL: Record<string, string> = {
  proxy: "產生 proxy",
  thumbs: "縮圖",
  shots: "鏡頭偵測",
  mask: "物件遮罩",
  track: "追蹤解算",
  recognize: "辨識",
  preview: "合成預覽",
  export: "輸出",
  tts: "AI 配音",
  pyenv: "安裝引擎環境",
  models: "下載模型",
  captions: "字幕",
  objects: "物件",
};

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: "排隊中",
  running: "執行中",
  done: "完成",
  error: "失敗",
  canceled: "已取消",
};

export const ENGINE_STATE_LABEL: Record<EngineStateKind, string> = {
  down: "未啟動",
  starting: "啟動中",
  ready: "就緒",
  broken: "故障",
};

/** 追蹤傳輸控制列（計畫 §9）：鍵 = 指令 id 的最後一段。 */
export const TRANSPORT_LABEL = {
  trackToStart: "追到頭",
  stepTrackBack: "上一幀",
  stopTrack: "停",
  stepTrackFwd: "下一幀",
  trackToEnd: "追到尾",
  clearBackwards: "清除之前",
  clearForwards: "清除之後",
  clearAll: "清除全部",
  retrackFromHere: "從此幀重追",
} as const;

export const KEYFRAME_SOURCE_LABEL = {
  user: "使用者硬釘",
  detector: "偵測器",
} as const;

/** 歷史面板的相對時間（history.ts relativeTimeParts 回鍵）。 */
export const RELATIVE_TIME_LABEL = {
  now: "剛剛",
  seconds: "{n} 秒前",
  minutes: "{n} 分前",
  hours: "{n} 小時前",
} as const;
