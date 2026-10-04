import type { Quad } from "../../project/format";
import { gridLines, type Pt } from "../../video/quad";
import { HANDLE_DRAW_PX } from "../hit";
import type { Palette, TokenName } from "../paint";
import type { SurfaceState } from "../surfaceAt";
import type { StageGeometry } from "../useStageGeometry";

/**
 * 表面 Surface 圖層：四邊形 + 3×3 網格 Grid + 選中 track 的 4 個把手 6 px + 每角的鎖定 Lock 小鎖。
 * 網格滑出紋理 = 漂移（Mocha Show Grid），是肉眼最快看出 drift 的方式。
 * 顏色依 state 取主題 token：使用者硬釘與解算分兩色，因為兩列時間軸的紀律就是「重跑 track 永不覆寫使用者關鍵幀」。
 */
export interface SurfaceItem {
  trackId: string;
  label: string;
  /** 來源像素。 */
  quad: Quad;
  state: SurfaceState;
  selected: boolean;
  lockedCorners?: [boolean, boolean, boolean, boolean];
  stale?: boolean;
}

export interface SurfaceLayerState {
  items: SurfaceItem[];
  showGrid: boolean;
  /** 拖曳中的原始位置（虛線殘影）。 */
  ghost: Quad | null;
  /** 拖曳中把手正在拖的角（畫成實心大一號）。 */
  activeCorner: number | null;
}

export const STATE_TOKEN: Record<SurfaceState, TokenName> = {
  user: "user",
  solver: "solver",
  occluded: "occluded",
  lost: "lost",
  missing: "solver",
};

function pathQuad(ctx: CanvasRenderingContext2D, geo: StageGeometry, q: Quad) {
  ctx.beginPath();
  q.p.forEach((p, i) => {
    const s = geo.toScreen(p);
    if (i === 0) ctx.moveTo(s[0], s[1]);
    else ctx.lineTo(s[0], s[1]);
  });
  ctx.closePath();
}

/** 小鎖：8 px，鎖身方塊 + 鎖環弧線。 */
export function drawLockGlyph(ctx: CanvasRenderingContext2D, at: Pt, color: string, size = 8): void {
  const [x, y] = at;
  const bodyW = size;
  const bodyH = size * 0.6;
  const bx = x - bodyW / 2;
  const by = y - bodyH / 2 + size * 0.15;
  ctx.save();
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.fillRect(bx, by, bodyW, bodyH);
  ctx.beginPath();
  ctx.arc(x, by, size * 0.3, Math.PI, 0);
  ctx.stroke();
  ctx.restore();
}

export function drawSurfaceLayer(ctx: CanvasRenderingContext2D, geo: StageGeometry, state: SurfaceLayerState, pal: Palette): void {
  if (geo.rect.w <= 0) return;
  const ordered = [...state.items.filter((i) => !i.selected), ...state.items.filter((i) => i.selected)];
  ctx.save();
  ctx.lineJoin = "round";
  ctx.font = "11px Inter Variable, system-ui, sans-serif";
  ctx.textBaseline = "bottom";

  for (const item of ordered) {
    const token = STATE_TOKEN[item.state];
    const missing = item.state === "missing";
    const stroke = pal(token, missing ? 0.55 : 1);

    // 網格先畫（在邊框底下）
    if (state.showGrid && !missing) {
      ctx.save();
      ctx.strokeStyle = pal(token, item.selected ? 0.55 : 0.3);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const [a, b] of gridLines(item.quad, 3)) {
        const sa = geo.toScreen(a);
        const sb = geo.toScreen(b);
        ctx.moveTo(sa[0], sa[1]);
        ctx.lineTo(sb[0], sb[1]);
      }
      ctx.stroke();
      ctx.restore();
    }

    // 邊框：深色暈圈 + 彩線，白色表面上才看得見
    ctx.save();
    if (missing || item.stale) ctx.setLineDash(missing ? [5, 4] : [8, 3]);
    pathQuad(ctx, geo, item.quad);
    ctx.strokeStyle = pal("app", 0.7);
    ctx.lineWidth = item.selected ? 4 : 3;
    ctx.stroke();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = item.selected ? 2 : 1.25;
    ctx.stroke();
    ctx.restore();

    // 標籤：TL 角上方一個小藥丸
    const tl = geo.toScreen(item.quad.p[0]);
    const text = item.label;
    if (text) {
      const w = ctx.measureText(text).width + 8;
      const h = 15;
      const x = tl[0];
      const y = tl[1] - 6;
      ctx.fillStyle = pal("app", 0.75);
      ctx.fillRect(x, y - h, w, h);
      ctx.fillStyle = stroke;
      ctx.fillText(text, x + 4, y - 2);
    }

    // 把手與小鎖只給選中的
    if (item.selected) {
      for (let i = 0; i < 4; i++) {
        const s = geo.toScreen(item.quad.p[i]);
        const active = state.activeCorner === i;
        const r = active ? HANDLE_DRAW_PX / 2 + 1.5 : HANDLE_DRAW_PX / 2;
        ctx.fillStyle = active ? stroke : pal("fg");
        ctx.strokeStyle = pal("app", 0.9);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(s[0] - r, s[1] - r, r * 2, r * 2);
        ctx.fill();
        ctx.stroke();
        if (item.lockedCorners?.[i]) drawLockGlyph(ctx, [s[0] + 9, s[1] - 9], pal("user"));
      }
    } else if (item.lockedCorners) {
      for (let i = 0; i < 4; i++) {
        if (!item.lockedCorners[i]) continue;
        const s = geo.toScreen(item.quad.p[i]);
        drawLockGlyph(ctx, [s[0] + 8, s[1] - 8], pal("user", 0.8), 7);
      }
    }
  }

  if (state.ghost) {
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = pal("fg", 0.45);
    ctx.lineWidth = 1;
    pathQuad(ctx, geo, state.ghost);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}
