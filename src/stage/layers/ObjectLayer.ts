import type { Palette } from "../paint";
import { withGeoTransform, type StageGeometry } from "../useStageGeometry";

/**
 * 物件 track 的舞台疊層。**刻意便宜**：
 * - 每個物件只畫這一幀的外接框＋名字（來自錨點 anchors.v1.json，查表，不解遮罩）—— 播放時一秒 30 次也只是幾個 strokeRect；
 * - 只有「選中的那一個物件、而且暫停著」才疊這一幀的遮罩（.aivm 讀一幀解碼，見 objects/maskFrame.ts，位圖進 LRU）；
 * - 手動選取 session 的預覽遮罩、拉框中的橡皮筋框也畫在這一層。
 *
 * 遮罩位圖是白色 alpha（來源尺寸），上色在這裡做（換顏色不必重解）：草稿 canvas 上 source-in 一次再拉伸到內容矩形。
 */
export interface ObjectBoxItem {
  trackId: string;
  label: string;
  color: string;
  /** 來源像素 [x, y, w, h]。 */
  bbox: [number, number, number, number];
  selected: boolean;
}

export interface ObjectLayerState {
  boxes: ObjectBoxItem[];
  /** 選中物件這一幀的遮罩（白色 alpha）＋顏色。 */
  mask: { bitmap: ImageBitmap; color: string } | null;
  /** 手動選取的預覽遮罩（白色 alpha）。 */
  selection: { bitmap: ImageBitmap | null; box: [number, number, number, number] | null; stale: boolean } | null;
  /** 拉框中（來源像素的兩個角）。 */
  rubber: { a: [number, number]; b: [number, number] } | null;
}

export const OBJECT_MASK_ALPHA = 0.42;
export const SELECTION_MASK_ALPHA = 0.5;

let scratch: HTMLCanvasElement | null = null;

function tinted(bitmap: ImageBitmap, color: string): HTMLCanvasElement | null {
  if (typeof document === "undefined") return null;
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

function drawMask(ctx: CanvasRenderingContext2D, geo: StageGeometry, bitmap: ImageBitmap, color: string, alpha: number): void {
  const img = tinted(bitmap, color);
  if (!img) return;
  const { rect } = geo;
  ctx.save();
  ctx.globalAlpha = alpha;
  withGeoTransform(ctx, geo, () => ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h));
  ctx.restore();
}

function screenRect(geo: StageGeometry, b: readonly [number, number, number, number]): [number, number, number, number] {
  const p0 = geo.toScreen([b[0], b[1]]);
  const p1 = geo.toScreen([b[0] + b[2], b[1] + b[3]]);
  return [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.abs(p1[0] - p0[0]), Math.abs(p1[1] - p0[1])];
}

export function drawObjectLayer(ctx: CanvasRenderingContext2D, geo: StageGeometry, state: ObjectLayerState, pal: Palette): void {
  if (geo.rect.w <= 0) return;
  if (state.mask) drawMask(ctx, geo, state.mask.bitmap, state.mask.color, OBJECT_MASK_ALPHA);

  // 沒選中的先畫，選中的最後畫在最上面
  const ordered = [...state.boxes.filter((b) => !b.selected), ...state.boxes.filter((b) => b.selected)];
  ctx.save();
  ctx.font = "11px Inter Variable, system-ui, sans-serif";
  ctx.textBaseline = "bottom";
  for (const b of ordered) {
    const [x, y, w, h] = screenRect(geo, b.bbox);
    ctx.strokeStyle = b.color;
    ctx.globalAlpha = b.selected ? 1 : 0.7;
    ctx.lineWidth = b.selected ? 2 : 1.25;
    ctx.setLineDash(b.selected ? [] : [5, 3]);
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
    if (b.label) {
      const tw = ctx.measureText(b.label).width + 8;
      ctx.setLineDash([]);
      ctx.globalAlpha = b.selected ? 0.95 : 0.75;
      ctx.fillStyle = b.color;
      ctx.fillRect(Math.round(x), Math.round(y) - 16, tw, 16);
      ctx.fillStyle = "rgb(0 0 0)";
      ctx.fillText(b.label, Math.round(x) + 4, Math.round(y) - 2);
    }
  }
  ctx.restore();

  const sel = state.selection;
  if (sel) {
    if (sel.bitmap) drawMask(ctx, geo, sel.bitmap, pal("accent"), sel.stale ? SELECTION_MASK_ALPHA * 0.5 : SELECTION_MASK_ALPHA);
    if (sel.box) {
      const [x, y, w, h] = screenRect(geo, sel.box);
      ctx.save();
      ctx.strokeStyle = pal("accent");
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
      ctx.restore();
    }
  }

  if (state.rubber) {
    const { a, b } = state.rubber;
    const r = screenRect(geo, [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])]);
    ctx.save();
    ctx.fillStyle = pal("accent", 0.12);
    ctx.fillRect(r[0], r[1], r[2], r[3]);
    ctx.strokeStyle = pal("accent");
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(Math.round(r[0]) + 0.5, Math.round(r[1]) + 0.5, Math.round(r[2]), Math.round(r[3]));
    ctx.restore();
  }
}
