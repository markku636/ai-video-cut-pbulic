import type { Quad } from "../../project/format";
import type { Pt } from "../../video/quad";
import type { Palette } from "../paint";
import type { StageGeometry } from "../useStageGeometry";

/**
 * 追蹤 HUD（Fusion Options tab 的對應）：MAGSAC 內點綠 / 外點紅圓點、可調長度的軌跡 Trails、
 * 畫面壓暗 Darken Image。solve.v1 目前沒帶逐點內外點，points 多半是 null；軌跡由 VideoStage
 * 用前 N 幀的表面中心算出來。
 */
export interface HudPoint {
  /** 來源像素。 */
  x: number;
  y: number;
  inlier: boolean;
}

export interface TrackHudState {
  points: HudPoint[] | null;
  /** 每條軌跡是依時間排序的來源像素點列（最後一點 = 目前幀）。 */
  trails: Pt[][];
}

export const DARKEN_ALPHA = 0.55;

/**
 * 壓暗：整個內容矩形蓋一層黑，再把表面挖掉。**要在其他圖層之前呼叫**——
 * destination-out 會把底下已畫的東西一起挖掉。
 */
export function drawDarken(ctx: CanvasRenderingContext2D, geo: StageGeometry, surfaces: Quad[], alpha = DARKEN_ALPHA): void {
  const { rect } = geo;
  if (rect.w <= 0) return;
  ctx.save();
  ctx.fillStyle = `rgb(0 0 0 / ${alpha})`;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillStyle = "rgb(0 0 0 / 1)";
  for (const q of surfaces) {
    ctx.beginPath();
    q.p.forEach((p, i) => {
      const s = geo.toScreen(p);
      if (i === 0) ctx.moveTo(s[0], s[1]);
      else ctx.lineTo(s[0], s[1]);
    });
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

export function drawTrackHudLayer(ctx: CanvasRenderingContext2D, geo: StageGeometry, state: TrackHudState, pal: Palette): void {
  if (geo.rect.w <= 0) return;
  ctx.save();
  // 軌跡：越舊越淡
  for (const trail of state.trails) {
    if (trail.length < 2) continue;
    for (let i = 1; i < trail.length; i++) {
      const a = geo.toScreen(trail[i - 1]);
      const b = geo.toScreen(trail[i]);
      const k = i / (trail.length - 1);
      ctx.strokeStyle = pal("solver", 0.15 + 0.75 * k);
      ctx.lineWidth = 1 + k;
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    }
  }
  if (state.points) {
    for (const p of state.points) {
      const s = geo.toScreen([p.x, p.y]);
      ctx.beginPath();
      ctx.arc(s[0], s[1], 2.5, 0, Math.PI * 2);
      ctx.fillStyle = p.inlier ? pal("solver") : pal("lost");
      ctx.fill();
    }
  }
  ctx.restore();
}
