import type { Quad } from "../project/format";

/**
 * 四邊形的純幾何（來源像素空間，順序 TL, TR, BR, BL；計畫 §5.6）。
 * 這些在 VideoStage 的把手拖曳、sanitize 的凸性檢查、Surface 圖層的網格都會用到，只寫一份。
 */

export type Pt = [number, number];

/** 3×3 row-major 單應性（h22 正規化為 1）。solve.v1.json 的 `h00..h21` 加上 1 就是這個。 */
export type Homography = [number, number, number, number, number, number, number, number, number];

export const IDENTITY_H: Homography = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function applyH(h: Homography, p: Pt): Pt {
  const [x, y] = p;
  const w = h[6] * x + h[7] * y + h[8];
  // w≈0 是投影到無限遠（退化 H）：回 NaN 讓呼叫端用 isFinite 擋，不要靜靜算出一個巨大座標畫到畫面外
  if (Math.abs(w) < 1e-12) return [Number.NaN, Number.NaN];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

export function applyHQuad(h: Homography, q: Quad): Quad {
  return { p: [applyH(h, q.p[0]), applyH(h, q.p[1]), applyH(h, q.p[2]), applyH(h, q.p[3])] };
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/**
 * 凸且非退化（四個角的叉積同號、面積 > 0）。
 * 蝴蝶結（自交）、三點共線、兩點重合都回 false —— 這些 quad 的 H 沒有意義，追蹤器會直接發散。
 */
export function isConvex(q: Quad): boolean {
  const p = q.p;
  if (p.length !== 4) return false;
  for (const [x, y] of p) if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(p[i], p[(i + 1) % 4], p[(i + 2) % 4]);
    if (Math.abs(c) < 1e-9) return false;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** 鞋帶公式；順時針（螢幕座標 y 向下、TL→TR→BR→BL）為正。 */
export function quadArea(q: Quad): number {
  const p = q.p;
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % 4];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** 點在凸四邊形內（含邊）。非凸 quad 一律 false —— 命中測試不該對蝴蝶結有答案。 */
export function pointInQuad(pt: Pt, q: Quad): boolean {
  if (!isConvex(q)) return false;
  const p = q.p;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(p[i], p[(i + 1) % 4], pt);
    if (Math.abs(c) < 1e-9) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export function quadCenter(q: Quad): Pt {
  const p = q.p;
  return [(p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4, (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4];
}

/** 軸對齊矩形 → Quad（新 track 的預設表面）。 */
export function rectQuad(x: number, y: number, w: number, h: number): Quad {
  return { p: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] };
}

/**
 * 新平面 track 沒給四角時的預設框：畫面正中央、16:9、寬約畫面 40%（螢幕／海報／招牌的常見比例；直式畫面時以高為限）。
 * 整數像素，讓人拖四角對準。
 */
export function centeredBoxQuad(frameW: number, frameH: number, aspect = 16 / 9, frac = 0.4): Quad {
  let w = Math.max(2, Math.round(frameW * frac));
  let h = Math.max(2, Math.round(w / aspect));
  if (h > frameH * frac * 1.5) {
    h = Math.max(2, Math.round(frameH * frac));
    w = Math.max(2, Math.round(h * aspect));
  }
  return rectQuad(Math.round((frameW - w) / 2), Math.round((frameH - h) / 2), w, h);
}

export function translateQuad(q: Quad, dx: number, dy: number): Quad {
  return { p: q.p.map(([x, y]) => [x + dx, y + dy]) as Quad["p"] };
}

export function moveCorner(q: Quad, i: 0 | 1 | 2 | 3, to: Pt): Quad {
  const p = q.p.map((c) => [c[0], c[1]] as Pt) as Quad["p"];
  p[i] = [to[0], to[1]];
  return { p };
}

/** 兩點距離。 */
export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/**
 * 表面上的 3×3 網格線（Mocha Show Grid）：雙線性內插四角。
 * 網格滑出紋理 = 漂移，是肉眼最快看出 drift 的方式。回傳線段陣列 [from, to]。
 */
export function gridLines(q: Quad, n = 3): [Pt, Pt][] {
  const [tl, tr, br, bl] = q.p;
  const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const out: [Pt, Pt][] = [];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    out.push([lerp(tl, tr, t), lerp(bl, br, t)]);
    out.push([lerp(tl, bl, t), lerp(tr, br, t)]);
  }
  return out;
}
