import type { Rational } from "../api";

/**
 * 幀號 ↔ 媒體時間（計畫 §9 VideoStage）。時間軸的單位是整數 proxy 幀，`<video>` 的單位是秒；
 * 兩邊換算只有這兩支函式，其他地方不准自己乘除。
 *
 * - `frameOfMediaTime`：rVFC 給的 `mediaTime` 是那一幀的**呈現時間戳**（= k·den/num），浮點誤差會讓
 *   30·(k/30) 少個 1e-15 而 floor 成 k-1，所以加 1e-4 秒（遠小於半幀）再 floor。
 * - `mediaTimeOfFrame`：seek 到 (k+0.5)/fps 而不是 k/fps。`currentTime = k/fps` 剛好落在幀邊界，
 *   瀏覽器有時會顯示前一幀（邊界判定 <= vs <）；落在幀中央永遠只有一個答案。
 *   **這 +0.5 是 seek-accuracy 量尺誤差為 0 幀的關鍵**。
 */
export function frameOfMediaTime(t: number, fps: Rational): number {
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.floor((t * fps.num) / fps.den + 1e-4);
}

export function mediaTimeOfFrame(f: number, fps: Rational): number {
  return ((Math.max(0, f) + 0.5) * fps.den) / fps.num;
}

/** 一幀多長（秒）。 */
export function frameDuration(fps: Rational): number {
  return fps.den / fps.num;
}

/** 顯示用 fps（29.97 / 30）。 */
export function fpsLabel(fps: Rational): string {
  const v = fps.num / fps.den;
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, "");
}

/** 夾進 [0, frames-1]；frames ≤ 0 時回 0。 */
export function clampFrame(f: number, frames: number): number {
  if (frames <= 0) return 0;
  return Math.max(0, Math.min(frames - 1, Math.round(f)));
}
