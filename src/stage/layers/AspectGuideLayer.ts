import type { Palette } from "../paint";
import type { StageGeometry } from "../useStageGeometry";
import { cropSize, guideCoverage, type AspectGuide } from "../aspectGuide";

/**
 * 畫面比例參考線：框出「裁成 9:16 / 4:5 / 1:1 之後會留下哪一塊」，框外壓暗。
 *
 * 用途是**構圖**：直式短片的主體要放在框裡。所以框的尺寸跟自動重構圖真的會裁的那一塊
 * 逐像素相同（`stage/aspectGuide.ts` 與引擎同一條規則），照著擺就是照著輸出。
 *
 * 刻意畫在**基礎幾何**上（不套穩定視圖的仿射）：這是「成品畫框」而不是貼在內容上的東西，
 * 跟著內容抖反而看不出構圖。
 */
export interface AspectGuideState {
  aspect: AspectGuide;
  /** 來源尺寸（`StageGeometry.srcW/srcH`；框以來源像素算，跟輸出一致）。 */
  srcW: number;
  srcH: number;
}

/** 框外壓暗的不透明度。夠看出範圍，又不會暗到看不見框外有什麼。 */
const DIM_ALPHA = 0.45;

export function drawAspectGuideLayer(ctx: CanvasRenderingContext2D, g: StageGeometry, state: AspectGuideState, pal: Palette): void {
  const box = cropSize(state.srcW, state.srcH, state.aspect);
  if (!box || g.rect.w <= 0 || g.rect.h <= 0) return;
  const s = g.pxPerSrc;
  const x = g.rect.x + box.x * s;
  const y = g.rect.y + box.y * s;
  const w = box.w * s;
  const h = box.h * s;

  ctx.save();
  // 壓暗：用 even-odd 一次挖空，比畫四條長方形少四次填色，也不會在邊界重疊變深
  ctx.beginPath();
  ctx.rect(g.rect.x, g.rect.y, g.rect.w, g.rect.h);
  ctx.rect(x, y, w, h);
  ctx.fillStyle = `rgba(0,0,0,${DIM_ALPHA})`;
  ctx.fill("evenodd");

  ctx.strokeStyle = pal("accent", 0.9);
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));

  // 尺寸標在框的上緣內側：使用者要知道的是「輸出會是幾乘幾」
  const label = `${state.aspect}  ${box.w}×${box.h}  ${Math.round(guideCoverage(box, state.srcW, state.srcH) * 100)}%`;
  ctx.font = "11px ui-monospace, monospace";
  ctx.textBaseline = "top";
  const tw = ctx.measureText(label).width;
  const pad = 4;
  const bx = Math.min(Math.max(x + 4, g.rect.x + 2), g.rect.x + g.rect.w - tw - pad * 2 - 2);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(bx, y + 4, tw + pad * 2, 16);
  ctx.fillStyle = pal("accent", 1);
  ctx.fillText(label, bx + pad, y + 6);
  ctx.restore();
}
