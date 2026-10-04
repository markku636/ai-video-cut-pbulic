import type { PromptPointV1 } from "../../project/format";
import type { Pt } from "../../video/quad";
import { MAG_SIZE, magnifierCrosshair, magnifierPlacement, magnifierSourceRect } from "../magnifier";
import type { Palette } from "../paint";
import type { StageGeometry } from "../useStageGeometry";

/**
 * HUD：提示點（加選青 / 減選粉）、游標十字、放大鏡、左上角模式徽章、底部提示。
 * 這層永遠最後畫、永遠不套穩定視圖的仿射（HUD 是貼在玻璃上的，不跟畫面一起動）。
 */
export interface MagnifierState {
  video: CanvasImageSource;
  /** 放大鏡中心（proxy px）。 */
  centerProxy: Pt;
  /** 游標（螢幕 px），決定放大鏡放哪。 */
  cursor: Pt;
  proxyW: number;
  proxyH: number;
}

export interface HudLayerState {
  /** 目前幀、選中 track 的提示點（來源像素）。 */
  prompts: PromptPointV1[];
  cursor: Pt | null;
  /** 遮罩工具下畫十字。 */
  crosshair: boolean;
  magnifier: MagnifierState | null;
  /** 左上角：檢視模式名（正常模式不畫）。 */
  badge: string | null;
  /** 底部置中一句話（「預覽尚未就緒」）。 */
  hint: string | null;
}

export const PROMPT_RADIUS = 6;

function pill(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, pal: Palette, align: "left" | "center") {
  ctx.font = "11px Inter Variable, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const w = ctx.measureText(text).width + 12;
  const h = 20;
  const bx = align === "center" ? x - w / 2 : x;
  ctx.fillStyle = pal("app", 0.8);
  ctx.beginPath();
  ctx.roundRect(bx, y, w, h, 4);
  ctx.fill();
  ctx.fillStyle = pal("fg", 0.9);
  ctx.fillText(text, bx + 6, y + h / 2);
}

export function drawHudLayer(ctx: CanvasRenderingContext2D, geo: StageGeometry, state: HudLayerState, pal: Palette): void {
  const { rect } = geo;
  ctx.save();

  // 提示點：實心圓 + 白色 + / −
  for (const p of state.prompts) {
    const s = geo.toScreen([p.x, p.y]);
    ctx.beginPath();
    ctx.arc(s[0], s[1], PROMPT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = p.label === 1 ? pal("maskPos") : pal("maskNeg");
    ctx.fill();
    ctx.strokeStyle = pal("app", 0.9);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.strokeStyle = pal("app");
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s[0] - 3, s[1]);
    ctx.lineTo(s[0] + 3, s[1]);
    if (p.label === 1) {
      ctx.moveTo(s[0], s[1] - 3);
      ctx.lineTo(s[0], s[1] + 3);
    }
    ctx.stroke();
  }

  if (state.cursor && state.crosshair && rect.w > 0) {
    const [cx, cy] = state.cursor;
    ctx.strokeStyle = pal("fg", 0.5);
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(rect.x, Math.round(cy) + 0.5);
    ctx.lineTo(rect.x + rect.w, Math.round(cy) + 0.5);
    ctx.moveTo(Math.round(cx) + 0.5, rect.y);
    ctx.lineTo(Math.round(cx) + 0.5, rect.y + rect.h);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (state.magnifier) {
    const m = state.magnifier;
    const src = magnifierSourceRect(m.centerProxy, m.proxyW, m.proxyH);
    const [mx, my] = magnifierPlacement(m.cursor, { w: geo.containerW, h: geo.containerH });
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(mx, my, MAG_SIZE, MAG_SIZE, 6);
    ctx.clip();
    ctx.imageSmoothingEnabled = false; // 4× 就是要看見像素格
    ctx.fillStyle = "rgb(0 0 0)";
    ctx.fillRect(mx, my, MAG_SIZE, MAG_SIZE);
    try {
      ctx.drawImage(m.video, src.sx, src.sy, src.sw, src.sh, mx, my, MAG_SIZE, MAG_SIZE);
    } catch {
      /* 影格還沒解出來時 drawImage 會丟 InvalidState；下一幀再畫 */
    }
    ctx.restore();
    const [hx, hy] = magnifierCrosshair(m.centerProxy, src);
    ctx.strokeStyle = pal("user");
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mx + hx - 8, my + hy + 0.5);
    ctx.lineTo(mx + hx + 8, my + hy + 0.5);
    ctx.moveTo(mx + hx + 0.5, my + hy - 8);
    ctx.lineTo(mx + hx + 0.5, my + hy + 8);
    ctx.stroke();
    ctx.strokeStyle = pal("fg", 0.9);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(mx, my, MAG_SIZE, MAG_SIZE, 6);
    ctx.stroke();
  }

  if (state.badge) pill(ctx, state.badge, rect.x + 8, rect.y + 8, pal, "left");
  if (state.hint) pill(ctx, state.hint, rect.x + rect.w / 2, rect.y + rect.h - 30, pal, "center");
  ctx.restore();
}
