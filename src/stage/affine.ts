import type { Quad } from "../project/format";
import type { Pt } from "../video/quad";

/**
 * 2D 仿射矩陣 [a, b, c, d, e, f]（canvas setTransform 的順序）：x' = a·x + c·y + e，y' = b·x + d·y + f。
 *
 * 穩定視圖（Stabilized View）要把選中 track 的表面釘死在參考影格的位置。真正的做法是 inv(H_k)，
 * 但 canvas 2D 只有仿射、沒有投影變換；這裡用三個角（TL, TR, BL）解出仿射近似，殘留的透視分量
 * 在小平面上肉眼看不出來（45×35 px 的平面，透視項 < 0.5 px）。「有沒有抖」照樣看得出來。
 */
export type Affine = [number, number, number, number, number, number];

export const IDENTITY_AFFINE: Affine = [1, 0, 0, 1, 0, 0];

export function applyAffine(m: Affine, p: Pt): Pt {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/** m2 ∘ m1（先做 m1 再做 m2）。 */
export function composeAffine(m2: Affine, m1: Affine): Affine {
  return [
    m2[0] * m1[0] + m2[2] * m1[1],
    m2[1] * m1[0] + m2[3] * m1[1],
    m2[0] * m1[2] + m2[2] * m1[3],
    m2[1] * m1[2] + m2[3] * m1[3],
    m2[0] * m1[4] + m2[2] * m1[5] + m2[4],
    m2[1] * m1[4] + m2[3] * m1[5] + m2[5],
  ];
}

/**
 * 三點對三點的仿射：把 from 的 TL/TR/BL 映到 to 的 TL/TR/BL。
 * 退化（三點共線）回 null，呼叫端退回單位矩陣 —— 畫錯總比畫出 NaN 讓整層消失好。
 */
export function affineFromTriples(from: [Pt, Pt, Pt], to: [Pt, Pt, Pt]): Affine | null {
  const [p0, p1, p2] = from;
  const [q0, q1, q2] = to;
  // 以 p0 為原點的基底 u = p1-p0, v = p2-p0；解 M·u = q1-q0, M·v = q2-q0
  const ux = p1[0] - p0[0];
  const uy = p1[1] - p0[1];
  const vx = p2[0] - p0[0];
  const vy = p2[1] - p0[1];
  const det = ux * vy - vx * uy;
  if (Math.abs(det) < 1e-9) return null;
  const inv00 = vy / det;
  const inv01 = -vx / det;
  const inv10 = -uy / det;
  const inv11 = ux / det;
  const Ux = q1[0] - q0[0];
  const Uy = q1[1] - q0[1];
  const Vx = q2[0] - q0[0];
  const Vy = q2[1] - q0[1];
  // M = [U V] · inv([u v])
  const a = Ux * inv00 + Vx * inv10;
  const c = Ux * inv01 + Vx * inv11;
  const b = Uy * inv00 + Vy * inv10;
  const d = Uy * inv01 + Vy * inv11;
  const e = q0[0] - (a * p0[0] + c * p0[1]);
  const f = q0[1] - (b * p0[0] + d * p0[1]);
  const m: Affine = [a, b, c, d, e, f];
  return m.every((x) => Number.isFinite(x)) ? m : null;
}

/** 把 `current` 表面釘回 `reference` 表面的仿射（TL, TR, BL 三角）。 */
export function stabilizeAffine(current: Quad, reference: Quad): Affine {
  return affineFromTriples([current.p[0], current.p[1], current.p[3]], [reference.p[0], reference.p[1], reference.p[3]]) ?? IDENTITY_AFFINE;
}
