// 選取的片段 → 序列幀區間（「播放選取」與「將片段設為範圍」共用的那一步）。
//
// 為什麼獨立一個檔：算這件事只需要序列本身，不需要任何 store，所以放在中立模組讓 commands/core.ts
// 與 commands/sequenceCommands.ts 都能用，不必為了共用而把 core.ts 接到 sequenceCommands.ts 上。
import type { SequenceV2 } from "../project/format";
import { durationFrames, frameOfSample, placeVideo } from "./map";
import type { SeqFrameRange } from "./ops";

/**
 * 選取的片段（V1 片段 / 空白 / A0 原音 / 音訊軌片段）涵蓋的序列幀區間，半開 `[in, out)`。
 *
 * - **聯集外框**（`[min t0, max t1)`），跟 Final Cut 的 Play Selection 一致：選取不連續時，中間沒選到的
 *   片段也會落在區間裡。不回多段是因為 `playRange` / `sequencePlayRange` 都只吃單一 `(in, out)`。
 * - A0 原音那一列跟 V1 片段共用同一個 id（`frametimeline/FrameTimeline.tsx` 的 `clipRowOf`），所以
 *   `placeVideo` 一趟就同時涵蓋 V1 與 A0。
 * - **音訊軌片段不在 `placeVideo` 裡**：`AudioClipV2` 用**樣本**計時，要換算成序列幀。結尾用
 *   「最後一個樣本所在的幀 + 1」而不是 `frameOfSample(start + length)`，否則收在幀中間的片段會少算一幀。
 * - 選取裡已經不存在於序列的 id（undo 之後）自動忽略；全部都不存在就回 null。
 */
export function selectionSpan(seq: SequenceV2, ids: readonly string[]): SeqFrameRange | null {
  if (!ids.length) return null;
  const want = new Set(ids);
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;

  for (const p of placeVideo(seq)) {
    if (!want.has(p.item.id)) continue;
    if (p.t0 < lo) lo = p.t0;
    if (p.t1 > hi) hi = p.t1;
  }

  for (const lane of seq.audioLanes) {
    for (const c of lane.clips) {
      if (!want.has(c.id) || c.length <= 0) continue;
      const a = frameOfSample(c.start, seq.fps);
      const b = frameOfSample(c.start + c.length - 1, seq.fps) + 1;
      if (a < lo) lo = a;
      if (b > hi) hi = b;
    }
  }

  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
  // 夾在序列長度內：音訊片段可以排到 T 之後（輸出時會被切掉），播那一段沒有畫面也沒有意義
  const inF = Math.max(0, lo);
  const outF = Math.min(durationFrames(seq), hi);
  return outF > inF ? { in: inF, out: outF } : null;
}
