import type { Quad } from "../../project/format";
import { HANDLE_DRAW_PX } from "../hit";
import type { Palette } from "../paint";
import type { StageGeometry } from "../useStageGeometry";

/**
 * 追蹤區域 Tracking Region 圖層：跟表面不同色的第二個多邊形，可獨立編輯（計畫 §9「全部對照中價值最高的一項」）。
 * 表面 = 要換掉的整個平面；追蹤區域 = 拿去追的特徵（例如印刷邊框與角落的圖案，排除會變的部分）——
 * 「永遠不要追你要換掉的那塊亮面」。null = 同表面，這層就不畫。
 */
export interface TrackingRegionState {
  /** 來源像素；null = 與表面相同。 */
  quad: Quad | null;
  /** 選中 track 的區域才畫把手。 */
  editable: boolean;
  activeCorner: number | null;
}

export function drawTrackingRegionLayer(ctx: CanvasRenderingContext2D, geo: StageGeometry, state: TrackingRegionState, pal: Palette): void {
  const q = state.quad;
  if (!q || geo.rect.w <= 0) return;
  const color = pal("accent");
  ctx.save();
  ctx.lineJoin = "round";
  ctx.beginPath();
  q.p.forEach((p, i) => {
    const s = geo.toScreen(p);
    if (i === 0) ctx.moveTo(s[0], s[1]);
    else ctx.lineTo(s[0], s[1]);
  });
  ctx.closePath();
  ctx.fillStyle = pal("accent", 0.08);
  ctx.fill();
  ctx.setLineDash([6, 3]);
  ctx.strokeStyle = pal("app", 0.7);
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);
  if (state.editable) {
    for (let i = 0; i < 4; i++) {
      const s = geo.toScreen(q.p[i]);
      const r = state.activeCorner === i ? HANDLE_DRAW_PX / 2 + 1.5 : HANDLE_DRAW_PX / 2;
      // 圓形把手：跟表面的方形把手分得開
      ctx.beginPath();
      ctx.arc(s[0], s[1], r, 0, Math.PI * 2);
      ctx.fillStyle = state.activeCorner === i ? color : pal("fg");
      ctx.fill();
      ctx.strokeStyle = pal("app", 0.9);
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  ctx.restore();
}
