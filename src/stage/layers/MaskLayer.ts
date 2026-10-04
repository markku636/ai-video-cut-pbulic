import type { Quad } from "../../project/format";
import type { Palette } from "../paint";
import { withGeoTransform, type StageGeometry } from "../useStageGeometry";

/**
 * 遮擋遮罩 Occlusion Mask 圖層（計畫 §9）：選中 α.45、其他 α.18；缺幀就畫上一個表面的虛線。
 * 遮罩位圖是整張 proxy 幀大小的 alpha（.aivm → ImageBitmap），拉伸到內容矩形即可，
 * 不管它是 proxy 還是來源解析度都對得上 —— 兩者長寬比相同。
 *
 * 上色：位圖只有 alpha，要「用 alpha 當形狀填顏色」得先在草稿 canvas 上 source-in 一次；
 * 直接對主 ctx 用 source-in 會把底下已經畫好的東西一起染色。草稿 canvas 全模組共用一張。
 */
export interface MaskItem {
  trackId: string;
  bitmap: ImageBitmap | null;
  selected: boolean;
  /** 沒有位圖時畫這個（上一個有的表面 / 最近關鍵幀）。 */
  fallbackQuad: Quad | null;
}

export interface MaskLayerState {
  items: MaskItem[];
}

export const MASK_ALPHA_SELECTED = 0.45;
export const MASK_ALPHA_OTHER = 0.18;

let scratch: HTMLCanvasElement | null = null;

function tinted(bitmap: ImageBitmap, color: string): HTMLCanvasElement | null {
  if (!scratch) scratch = document.createElement("canvas");
  if (scratch.width !== bitmap.width || scratch.height !== bitmap.height) {
    scratch.width = bitmap.width;
    scratch.height = bitmap.height;
  }
  const c = scratch.getContext("2d");
  if (!c) return null;
  c.globalCompositeOperation = "source-over";
  c.clearRect(0, 0, scratch.width, scratch.height);
  c.drawImage(bitmap, 0, 0);
  c.globalCompositeOperation = "source-in";
  c.fillStyle = color;
  c.fillRect(0, 0, scratch.width, scratch.height);
  c.globalCompositeOperation = "source-over";
  return scratch;
}

export function drawMaskLayer(ctx: CanvasRenderingContext2D, geo: StageGeometry, state: MaskLayerState, pal: Palette): void {
  const { rect } = geo;
  if (rect.w <= 0) return;
  // 沒選中的先畫，選中的最後畫在最上面
  const ordered = [...state.items.filter((i) => !i.selected), ...state.items.filter((i) => i.selected)];
  for (const item of ordered) {
    if (item.bitmap) {
      const img = tinted(item.bitmap, pal("maskPos"));
      if (!img) continue;
      ctx.save();
      ctx.globalAlpha = item.selected ? MASK_ALPHA_SELECTED : MASK_ALPHA_OTHER;
      withGeoTransform(ctx, geo, () => ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h));
      ctx.restore();
      continue;
    }
    if (!item.fallbackQuad) continue;
    // 缺幀：上一表面的虛線，讓人知道「這幀還沒有遮罩，但表面大概在這」
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = pal("maskPos", item.selected ? 0.8 : 0.4);
    ctx.lineWidth = 1;
    ctx.beginPath();
    item.fallbackQuad.p.forEach((p, i) => {
      const s = geo.toScreen(p);
      if (i === 0) ctx.moveTo(s[0], s[1]);
      else ctx.lineTo(s[0], s[1]);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
}
