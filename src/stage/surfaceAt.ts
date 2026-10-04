import type { KeyframeV1, Quad, TrackV1 } from "../project/format";
import { solveAt, type Solve, type SolveFrame } from "../store/solves";
import { applyHQuad, isConvex, rectQuad } from "../video/quad";

/**
 * 某一幀「表面在哪裡、是誰說的」。VideoStage 的 SurfaceLayer / MaskLayer 缺幀虛線、
 * TrackPanel 的狀態行、穩定視圖的釘點都問這一支，規則只寫一次。
 *
 * 顏色語意（theme token）：
 * - user：這一幀有使用者硬釘的關鍵幀 → 畫 quad 本身，解算不准蓋它（兩列時間軸的紀律）。
 * - solver：解算 conf ≥ 0.7。
 * - occluded：0.35 ≤ conf < 0.7 —— 合成時「保持不替換 hold」的那一段，用琥珀色提醒。
 * - lost：state=3 或 conf < 0.35。
 * - missing：這一幀什麼都沒有（沒關鍵幀、沒解）→ 借最近的關鍵幀畫虛線，讓人知道表面大概在哪。
 */
export type SurfaceState = "user" | "solver" | "occluded" | "lost" | "missing";

export interface SurfaceSample {
  quad: Quad;
  state: SurfaceState;
  /** 解算信心；user / missing 為 null。 */
  conf: number | null;
  /** 這幀的關鍵幀（有的話）。 */
  keyframe: KeyframeV1 | null;
}

export function keyframeAt(track: Pick<TrackV1, "keyframes">, frame: number): KeyframeV1 | null {
  return track.keyframes.find((k) => k.frame === frame) ?? null;
}

/** 距離最近的關鍵幀；同距離取前面那個（往回看比較符合「剛剛釘的」直覺）。 */
export function nearestKeyframe(track: Pick<TrackV1, "keyframes">, frame: number): KeyframeV1 | null {
  let best: KeyframeV1 | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const k of track.keyframes) {
    const d = Math.abs(k.frame - frame);
    if (d < bestD || (d === bestD && best && k.frame < best.frame)) {
      best = k;
      bestD = d;
    }
  }
  return best;
}

export function stateOfSolveFrame(f: SolveFrame): Exclude<SurfaceState, "user" | "missing"> {
  if (f.state === 3 || f.conf < 0.35) return "lost";
  return f.conf >= 0.7 ? "solver" : "occluded";
}

/**
 * H_k：模板像素（0..template.w, 0..template.h，矯正後的表面）→ 幀 k 的來源像素。
 * solve.v1.json 帶 `template` 尺寸就是為了這一步；表面 = H_k 套在模板矩形上。
 * 退化的 H（投影到無限遠 / 非凸）回 null，讓呼叫端走 missing 而不是畫出一條線。
 */
export function quadOfSolveFrame(solve: Pick<Solve, "template">, f: SolveFrame): Quad | null {
  const q = applyHQuad(f.h, rectQuad(0, 0, solve.template.w, solve.template.h));
  return isConvex(q) ? q : null;
}

export function surfaceAt(track: TrackV1, solve: Solve | null, frame: number): SurfaceSample | null {
  const kf = keyframeAt(track, frame);
  if (kf && kf.source === "user") return { quad: kf.quad, state: "user", conf: null, keyframe: kf };
  if (solve) {
    const f = solveAt(solve, frame);
    if (f) {
      const q = quadOfSolveFrame(solve, f);
      if (q) return { quad: q, state: stateOfSolveFrame(f), conf: f.conf, keyframe: kf };
    }
  }
  // 偵測器給的關鍵幀沒有解也還是個位置；比「借別幀」準
  if (kf) return { quad: kf.quad, state: "missing", conf: null, keyframe: kf };
  const near = nearestKeyframe(track, frame);
  return near ? { quad: near.quad, state: "missing", conf: null, keyframe: null } : null;
}

/** 參考影格的表面：使用者指定的 referenceFrame → 解的 anchorK → 最近的關鍵幀。穩定視圖釘住這個。 */
export function referenceSurface(track: TrackV1, solve: Solve | null): Quad | null {
  const ref = track.referenceFrame ?? solve?.anchorK ?? null;
  if (ref !== null) {
    const s = surfaceAt(track, solve, ref);
    if (s && s.state !== "missing") return s.quad;
  }
  return track.keyframes[0]?.quad ?? null;
}

/** 解算摘要（TrackPanel 狀態行 / Inspector 徽章）。range = 該鏡頭 [start, end)。 */
export interface SolveSummary {
  total: number;
  solved: number;
  lost: number;
  occluded: number;
  /** 最差的一幀（conf 最低、lost 優先）；沒有解就 null。 */
  worst: SolveFrame | null;
}

export function summarizeSolve(solve: Solve | null, range: [number, number]): SolveSummary {
  const total = Math.max(0, range[1] - range[0]);
  if (!solve) return { total, solved: 0, lost: 0, occluded: 0, worst: null };
  let solved = 0;
  let lost = 0;
  let occluded = 0;
  let worst: SolveFrame | null = null;
  for (const f of solve.frames) {
    if (f.k < range[0] || f.k >= range[1]) continue;
    const st = stateOfSolveFrame(f);
    if (st === "lost") lost++;
    else {
      solved++;
      if (st === "occluded") occluded++;
    }
    if (!worst || (st === "lost" && stateOfSolveFrame(worst) !== "lost") || f.conf < worst.conf) worst = f;
  }
  return { total, solved, lost, occluded, worst };
}
