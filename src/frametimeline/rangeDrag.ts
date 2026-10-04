import { MIN_RANGE_FRAMES, type FrameRange } from "../store/timeline";

/**
 * 範圍拖曳的純邏輯（新建 / 調整 in / 調整 out / 平移、吸附、Shift+點延伸）。
 *
 * 從 FrameTimeline 抽出來是因為這些規則全是邊界條件（越過另一端要互換、長度下限、夾在 [0, frames]、
 * 平移時兩端誰吸附），寫在 pointer handler 裡只能靠手點測；這裡用 node 測。
 *
 * 座標慣例：傳進來的 `raw` 是**小數幀**（frameOfX 的結果，還沒 round），回傳的範圍是整數幀邊界、半開區間 [in, out)。
 * 每次 update 都從拖曳開始時的 origin 重算（無狀態）：拖過頭再拖回來會回到原樣，不會累積誤差。
 */

/** 按下後移動超過這麼多 px 才算拖曳；否則當成點一下（Shift+點延伸、點範圍列 seek）。 */
export const DRAG_THRESHOLD_PX = 3;
/** 吸附距離（px）。 */
export const SNAP_PX = 6;

export type RangeDragMode = "create" | "in" | "out" | "move";

export type SnapKind = "playhead" | "shot" | "keyframe" | "bound";

export interface SnapTarget {
  frame: number;
  kind: SnapKind;
}

export interface RangeDrag {
  mode: RangeDragMode;
  /** 按下時的小數幀。 */
  anchorRaw: number;
  /** 拖曳前的範圍與單邊暫存（Esc 還原用）。 */
  origin: FrameRange | null;
  originPendingIn: number | null;
  originPendingOut: number | null;
}

export interface DragContext {
  /** 總幀數：範圍夾在 [0, frames]。 */
  frames: number;
  pxPerFrame: number;
  /** 空陣列 = 不吸附（按住 Alt）。 */
  targets: readonly SnapTarget[];
  snapPx?: number;
}

export interface DragResult {
  range: FrameRange;
  /** 吸到哪（畫指示線 / tooltip 寫「吸附到鏡頭切點」）；null = 沒吸。 */
  snap: SnapTarget | null;
}

/**
 * 吸附目標：播放線、鏡頭邊界、選中 track 的關鍵幀，加上頭尾。
 * 去重時保留**第一個**出現的種類（播放線最優先）：同一幀既是播放線又是切點時，提示「播放線」比較符合使用者剛剛在看的東西。
 */
export function collectSnapTargets(src: { playhead?: number | null; shots?: readonly { startFrame: number; endFrame: number }[]; keyframes?: readonly number[]; frames: number }): SnapTarget[] {
  const out: SnapTarget[] = [];
  const seen = new Set<number>();
  const add = (frame: number, kind: SnapKind) => {
    if (!Number.isFinite(frame) || frame < 0 || frame > src.frames || seen.has(frame)) return;
    seen.add(frame);
    out.push({ frame, kind });
  };
  if (src.playhead != null) add(Math.round(src.playhead), "playhead");
  for (const s of src.shots ?? []) {
    add(s.startFrame, "shot");
    add(s.endFrame, "shot");
  }
  for (const k of src.keyframes ?? []) add(k, "keyframe");
  add(0, "bound");
  add(src.frames, "bound");
  return out.sort((a, b) => a.frame - b.frame);
}

/** 最近的吸附目標（容忍 snapPx 以內）；沒有就回 null。等距時取先出現的（已排序 → 較早的幀）。 */
export function nearestSnap(raw: number, ctx: DragContext): SnapTarget | null {
  if (ctx.pxPerFrame <= 0) return null;
  const tol = (ctx.snapPx ?? SNAP_PX) / ctx.pxPerFrame;
  let best: SnapTarget | null = null;
  let bestD = tol;
  for (const t of ctx.targets) {
    const d = Math.abs(t.frame - raw);
    if (d <= bestD && (best === null || d < bestD)) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

function edge(raw: number, ctx: DragContext): { f: number; snap: SnapTarget | null } {
  const snap = nearestSnap(raw, ctx);
  const f = snap ? snap.frame : Math.round(raw);
  return { f: Math.max(0, Math.min(ctx.frames, f)), snap };
}

/** 長度下限 + 夾在 [0, frames]；太短時往「拖的方向」長出去，碰到邊界再往回長。 */
function normalize(a: number, b: number, frames: number, growRight: boolean): FrameRange {
  let lo = Math.min(a, b);
  let hi = Math.max(a, b);
  if (hi - lo < MIN_RANGE_FRAMES) {
    if (growRight) hi = lo + MIN_RANGE_FRAMES;
    else lo = hi - MIN_RANGE_FRAMES;
  }
  if (hi > frames) {
    hi = frames;
    lo = Math.min(lo, hi - MIN_RANGE_FRAMES);
  }
  if (lo < 0) {
    lo = 0;
    hi = Math.max(hi, MIN_RANGE_FRAMES);
  }
  return { in: lo, out: hi };
}

export function beginRangeDrag(mode: RangeDragMode, anchorRaw: number, state: { range: FrameRange | null; pendingIn: number | null; pendingOut: number | null }): RangeDrag {
  // 沒有範圍卻要調整端點 / 平移（理論上 hit 不會回這種組合）→ 當成新建，不要靜默不動
  const m: RangeDragMode = state.range ? mode : "create";
  return { mode: m, anchorRaw, origin: state.range, originPendingIn: state.pendingIn, originPendingOut: state.pendingOut };
}

export function updateRangeDrag(drag: RangeDrag, raw: number, ctx: DragContext): DragResult {
  const o = drag.origin;
  switch (drag.mode) {
    case "in":
    case "out": {
      if (!o) break;
      const e = edge(raw, ctx);
      // 越過另一端 → 兩端互換（被拖的那端變成另一端），長度下限往拖的方向長
      const fixed = drag.mode === "in" ? o.out : o.in;
      return { range: normalize(e.f, fixed, ctx.frames, e.f >= fixed), snap: e.snap };
    }
    case "move": {
      if (!o) break;
      const len = o.out - o.in;
      const delta = raw - drag.anchorRaw;
      const inRaw = o.in + delta;
      const outRaw = o.out + delta;
      // 兩端各自找吸附，取比較近的那一端去吸（Premiere / Resolve 平移片段都是這樣）
      const sIn = nearestSnap(inRaw, ctx);
      const sOut = nearestSnap(outRaw, ctx);
      let newIn = Math.round(inRaw);
      let snap: SnapTarget | null = null;
      if (sIn && (!sOut || Math.abs(sIn.frame - inRaw) <= Math.abs(sOut.frame - outRaw))) {
        newIn = sIn.frame;
        snap = sIn;
      } else if (sOut) {
        newIn = sOut.frame - len;
        snap = sOut;
      }
      const clamped = Math.max(0, Math.min(Math.max(0, ctx.frames - len), newIn));
      // 被邊界夾住時吸附位置就不成立了，不要還顯示「吸到切點」
      if (clamped !== newIn) snap = null;
      return { range: { in: clamped, out: clamped + len }, snap };
    }
    case "create":
      break;
  }
  // 新建：起點也吸附（從播放線 / 切點開始拉是最常見的情況），指示只畫正在動的那一端
  const a = edge(drag.anchorRaw, ctx);
  const b = edge(raw, ctx);
  return { range: normalize(a.f, b.f, ctx.frames, raw >= drag.anchorRaw), snap: b.snap };
}

/** Esc：還原成拖曳前（含單邊暫存，不然按過 I 的人拖一下再 Esc 會發現入點不見了）。 */
export function cancelRangeDrag(drag: RangeDrag): { range: FrameRange | null; pendingIn: number | null; pendingOut: number | null } {
  return { range: drag.origin, pendingIn: drag.originPendingIn, pendingOut: drag.originPendingOut };
}

export type ShiftClickResult = { kind: "range"; range: FrameRange } | { kind: "pendingIn"; frame: number };

/**
 * Shift+點一下（FCP / Premiere 的延伸選取）：
 * - 已有範圍：把**較近**的一端移到這裡（等距移 out，延長比縮短常見）。
 * - 只有單邊暫存：跟暫存那端組成範圍（按了 I 之後 Shift+點出點，不用再按 O）。
 * - 什麼都沒有：這幀當入點暫存。
 */
export function shiftClickRange(state: { range: FrameRange | null; pendingIn: number | null; pendingOut: number | null }, edgeFrame: number, frames: number): ShiftClickResult {
  const f = Math.max(0, Math.min(frames, Math.round(edgeFrame)));
  const r = state.range;
  if (r) {
    const moveIn = Math.abs(f - r.in) < Math.abs(f - r.out);
    const fixed = moveIn ? r.out : r.in;
    return { kind: "range", range: normalize(f, fixed, frames, f >= fixed) };
  }
  const other = state.pendingIn ?? state.pendingOut;
  if (other != null && other !== f) return { kind: "range", range: normalize(other, f, frames, f >= other) };
  return { kind: "pendingIn", frame: Math.min(f, Math.max(0, frames - MIN_RANGE_FRAMES)) };
}
