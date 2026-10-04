import type { Quad } from "../project/format";
import { dist, pointInQuad, type Pt } from "../video/quad";

/**
 * 表面四邊形的命中測試（螢幕 CSS px）。純函式，VideoStage 的 pointer 處理只呼叫這裡。
 *
 * 把手畫 6 px、命中 12 px（計畫 §9）：畫小是為了不遮住角落的紋理，命中大是因為遠景的平面只有 45×35 px、
 * 兩個角只差 35 px，再大就會互相搶。優先序：角 > 邊 > 內部 —— 角在邊上、邊在內部裡，反過來就永遠點不到角。
 */
export const HANDLE_HIT_PX = 12;
export const HANDLE_DRAW_PX = 6;
export const EDGE_HIT_PX = 6;

export type CornerIndex = 0 | 1 | 2 | 3;

export type QuadHit =
  | { kind: "corner"; index: CornerIndex }
  /** 邊 i 從 p[i] 到 p[(i+1)%4]。 */
  | { kind: "edge"; index: CornerIndex }
  | { kind: "inside" }
  | null;

/** 點到線段的最短距離。 */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return dist(p, a);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** 最近的角（在 tolerance 內）；多個角都在範圍內時取最近的那一個。 */
export function nearestCorner(pt: Pt, q: Quad, tolerance = HANDLE_HIT_PX): CornerIndex | null {
  let best: CornerIndex | null = null;
  let bestD = tolerance;
  for (let i = 0; i < 4; i++) {
    const d = dist(pt, q.p[i]);
    if (d <= bestD) {
      bestD = d;
      best = i as CornerIndex;
    }
  }
  return best;
}

export function nearestEdge(pt: Pt, q: Quad, tolerance = EDGE_HIT_PX): CornerIndex | null {
  let best: CornerIndex | null = null;
  let bestD = tolerance;
  for (let i = 0; i < 4; i++) {
    const d = distToSegment(pt, q.p[i], q.p[(i + 1) % 4]);
    if (d <= bestD) {
      bestD = d;
      best = i as CornerIndex;
    }
  }
  return best;
}

export interface HitOptions {
  handlePx?: number;
  edgePx?: number;
  /** false = 沒有把手（未選中的 track 只能整片點選）。 */
  handles?: boolean;
}

export function hitQuad(pt: Pt, q: Quad, opts: HitOptions = {}): QuadHit {
  const handles = opts.handles ?? true;
  if (handles) {
    const c = nearestCorner(pt, q, opts.handlePx ?? HANDLE_HIT_PX);
    if (c !== null) return { kind: "corner", index: c };
    const e = nearestEdge(pt, q, opts.edgePx ?? EDGE_HIT_PX);
    if (e !== null) return { kind: "edge", index: e };
  }
  return pointInQuad(pt, q) ? { kind: "inside" } : null;
}

/**
 * 多個 track 疊在一起時點到誰：先問選中的（它有把手），再依面積小→大問其餘的 ——
 * 小平面疊在大平面上時，點小的應該中小的。回傳 index（傳入陣列的索引）。
 */
export function pickQuad(pt: Pt, quads: { quad: Quad; selected: boolean }[], opts: HitOptions = {}): { index: number; hit: NonNullable<QuadHit> } | null {
  const sel = quads.findIndex((q) => q.selected);
  if (sel >= 0) {
    const h = hitQuad(pt, quads[sel].quad, opts);
    if (h) return { index: sel, hit: h };
  }
  const order = quads
    .map((q, i) => ({ i, area: Math.abs(areaOf(q.quad)) }))
    .filter((x) => x.i !== sel)
    .sort((a, b) => a.area - b.area);
  for (const { i } of order) {
    const h = hitQuad(pt, quads[i].quad, { ...opts, handles: false });
    if (h) return { index: i, hit: h };
  }
  return null;
}

function areaOf(q: Quad): number {
  const p = q.p;
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % 4];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}
