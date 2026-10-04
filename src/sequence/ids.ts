// 序列剪輯的錯誤型別與 id 發號。
import type { SequenceV2 } from "../project/format";

export type SequenceErrorCode =
  /** 媒體還沒有 proxy（幀數未知）：不能實體化、不能加進序列。 */
  | "noProxy"
  /** 媒體 proxy fps ≠ 序列 fps（M2 不做 conform，UI 顯示「請以 N/D fps 重建 proxy」）。 */
  | "fpsMismatch"
  /** 媒體尺寸 ≠ 序列尺寸。 */
  | "sizeMismatch"
  | "notFound"
  /** 目標音軌鎖定中。 */
  | "locked"
  /** 放置位置跟同軌片段重疊；detail.nearest = 最近放得下的起點（樣本）。 */
  | "overlap"
  /** 缺 media.audio_info 的結果（不知道取樣率 / 起點 / 長度）。 */
  | "noAudioInfo"
  /** 片段原音已經分離或靜音。 */
  | "noOriginalAudio"
  /** 音軌裡還有片段，不能直接刪。 */
  | "laneNotEmpty";

/** 剪輯函式拒絕執行時擲出；message 是給開發者看的繁中說明，UI 依 code 顯示翻譯過的文字。 */
export class SequenceError extends Error {
  readonly code: SequenceErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(code: SequenceErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "SequenceError";
    this.code = code;
    this.detail = detail;
  }
}

/** 序列內所有片段 id（V1 項目＋所有軌的音訊片段；sanitize 保證它們唯一）。 */
export function clipIdsOf(seq: SequenceV2): Set<string> {
  const out = new Set<string>();
  for (const it of seq.video) out.add(it.id);
  for (const l of seq.audioLanes) for (const c of l.clips) out.add(c.id);
  return out;
}

export function laneIdsOf(seq: SequenceV2): Set<string> {
  return new Set(seq.audioLanes.map((l) => l.id));
}

/**
 * 發一個 `${prefix}-${n}`（n 從 1 起、取最小的空號）並登記進 taken。
 * 為什麼是可預測的遞增號而不是亂數：同一串動作重播（undo 後 redo、測試）要得到同一組 id，選取狀態才對得回去。
 */
export function takeId(taken: Set<string>, prefix: string): string {
  let n = 1;
  while (taken.has(`${prefix}-${n}`)) n++;
  const id = `${prefix}-${n}`;
  taken.add(id);
  return id;
}

/** 下一個會發出的片段 id（不登記）：呼叫端要先知道新片段 id 時用（例如加入音訊後選取它）。 */
export function nextClipId(seq: SequenceV2, prefix: "clip" | "gap" | "aclip"): string {
  return takeId(clipIdsOf(seq), prefix);
}
