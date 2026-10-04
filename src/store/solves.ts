import { create } from "zustand";
import type { Homography } from "../video/quad";

/**
 * 追蹤解（`tracks/<trackId>/solve.v1.json`；計畫 §5.5）。**在 undo 之外**：解算結果是從專案向量狀態
 * 重算得到的光柵化產物，復原關鍵幀時不該跟著「復原」一份解 —— 重解就好。快取缺就標 stale。
 *
 * 0 none / 1 tracking / 2 static / 3 lost。「hold（不替換）」由 conf/state 在合成時推導，不儲存。
 */
export type TrackStateCode = 0 | 1 | 2 | 3;

export interface SolveFrame {
  /** proxy 幀號。 */
  k: number;
  /** h00..h21 加 h22=1 補成 3×3。 */
  h: Homography;
  conf: number;
  state: TrackStateCode;
}

export interface Solve {
  version: 1;
  trackId: string;
  /** [k0, k1)。 */
  shot: [number, number];
  anchorK: number;
  template: { w: number; h: number };
  frames: SolveFrame[];
}

interface SolvesStore {
  /** trackId → 解。 */
  byTrack: Record<string, Solve>;
  set: (trackId: string, solve: Solve) => void;
  remove: (trackId: string) => void;
  clearMedia: (trackIds: string[]) => void;
}

export const useSolves = create<SolvesStore>((set) => ({
  byTrack: {},
  set: (trackId, solve) => set((s) => ({ byTrack: { ...s.byTrack, [trackId]: solve } })),
  remove: (trackId) =>
    set((s) => {
      if (!(trackId in s.byTrack)) return s;
      const byTrack = { ...s.byTrack };
      delete byTrack[trackId];
      return { byTrack };
    }),
  clearMedia: (trackIds) =>
    set((s) => {
      const byTrack = { ...s.byTrack };
      for (const id of trackIds) delete byTrack[id];
      return { byTrack };
    }),
}));

/** solve.v1.json 原始列 `[k, h00..h21, conf, state]` → SolveFrame（h22 補 1）。 */
export function parseSolveRow(row: number[]): SolveFrame | null {
  if (row.length !== 11) return null;
  const [k, ...rest] = row;
  const h = [...rest.slice(0, 8), 1] as Homography;
  const conf = rest[8];
  const st = rest[9];
  if (!Number.isInteger(k) || k < 0 || !Number.isFinite(conf) || ![0, 1, 2, 3].includes(st)) return null;
  return { k, h, conf: Math.max(0, Math.min(1, conf)), state: st as TrackStateCode };
}

/** 某一幀的解（frames 依 k 排序，二分搜）。 */
export function solveAt(s: Solve, k: number): SolveFrame | null {
  let lo = 0;
  let hi = s.frames.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = s.frames[mid];
    if (f.k === k) return f;
    if (f.k < k) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

/** 紅綠燈信心帶：≥0.7 綠 / 0.35–0.7 琥珀 / <0.35 或 lost 紅（計畫 §9 FrameTimeline）。 */
export type ConfidenceBand = "good" | "warn" | "bad";

export function confidenceBand(f: SolveFrame): ConfidenceBand {
  if (f.state === 3 || f.conf < 0.35) return "bad";
  return f.conf >= 0.7 ? "good" : "warn";
}
