import type { InsertMacro, MotionModel, ShotKind, TrackDataFormat } from "../project/format";
import type { JobKind } from "../store/jobs";
import type { TrackStateCode } from "../store/solves";
import type { ProxyState } from "../store/project";

/**
 * 繁中標籤表（zh key；顯示時 t() 過）。enum 不准直接出現在畫面上（計畫 §17.6 ⑫）。
 * 這個檔在 check-i18n.mjs 的 TABLE_SOURCES 裡：每一句都要進 locales/en.ts。
 */

/** 解算狀態 0 none / 1 tracking / 2 static / 3 lost（solve.v1.json `state`）。 */
export const TRACK_STATE_LABEL: Record<TrackStateCode, string> = {
  0: "未解算",
  1: "追蹤中",
  2: "靜止",
  3: "遺失",
};

export const SHOT_KIND_LABEL: Record<ShotKind, string> = {
  close: "近景",
  wide: "遠景",
  unknown: "未知鏡位",
};

/** 動態模型階梯（Fusion Motion Type）。 */
export const MOTION_MODEL_LABEL: Record<MotionModel, string> = {
  translation: "平移",
  similarity: "平移＋旋轉＋縮放",
  affine: "仿射",
  perspective: "透視",
};

/** 檢視模式（Fusion Operation Mode 的對應；熱鍵 1–5）。 */
export const VIEW_MODE_LABEL = {
  normal: "正常",
  stabilized: "穩定視圖",
  replaced: "替換",
  split: "並排",
  difference: "差異",
} as const;

/** 工作種類（Sidebar 工作清單的徽章）。 */
export const JOB_KIND_LABEL: Record<JobKind, string> = {
  proxy: "建 proxy",
  thumbs: "縮圖",
  shots: "鏡頭偵測",
  mask: "遮罩",
  track: "追蹤",
  recognize: "辨識",
  preview: "預覽",
  export: "輸出",
  pyenv: "安裝引擎",
  models: "下載模型",
  captions: "字幕",
  tts: "AI 配音",
  objects: "物件",
};

/**
 * `pipeline.run` 的 stage（progress `stage:"pipeline", step:<name>`）與各 op 自己的 stage 名 → 人話。
 * key 是引擎那邊的名字（ops/run.py STAGES + 各 op 的 ctx.progress 第一個參數的第一段）。
 */
export const PIPELINE_STEP_LABEL: Record<string, string> = {
  probe: "讀取影片資訊",
  index: "建立幀索引",
  shots: "鏡頭偵測",
  detect: "偵測目標",
  seg: "物件遮罩",
  track: "追蹤解算",
  identify: "辨識目標",
  replace: "套用替換目標",
  render: "渲染輸出",
  done: "完成",
  proxy: "建 proxy",
  pipeline: "整條管線",
  // 字幕管線（asr.transcribe 的 stage 是 asr.load / asr.download / asr.decode，取第一段）
  asr: "語音辨識",
  captions: "字幕",
};

/** proxy 狀態（Sidebar 列 / StatusBar）。 */
export const PROXY_STATE_LABEL: Record<ProxyState, string> = {
  none: "尚未建 proxy",
  building: "建 proxy 中",
  ready: "可播放",
  stale: "proxy 過期",
  error: "proxy 失敗",
};

/** 插入巨集三段（Conservative / Standard / Full replace）。 */
export const INSERT_MACRO_LABEL: Record<InsertMacro, string> = {
  conservative: "保守",
  standard: "標準",
  full: "完整替換",
  custom: "自訂",
};

/** 追蹤資料匯出格式。 */
export const TRACK_DATA_FORMAT_LABEL: Record<TrackDataFormat, string> = {
  nuke: "Nuke CornerPin2D（.nk）",
  ae: "After Effects 角釘（剪貼簿文字）",
};
