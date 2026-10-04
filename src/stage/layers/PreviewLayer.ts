import type { Palette } from "../paint";
import { withGeoTransform, type StageGeometry } from "../useStageGeometry";
import type { ViewMode } from "../viewMode";

/**
 * 合成預覽圖層（`comp.preview` PNG）——三種檢視模式在這裡畫：
 * - replaced 替換：整張蓋上預覽（沒有預覽就讓 <video> 透出來，HUD 提示「尚未就緒」）。
 * - split 並排：推桿右側是替換結果、左側是原片；**遮罩外兩邊逐位元相同**，推桿本身就是正確性儀器。
 * - difference 差異：|out − src|，gain 4。canvas 2D 沒有 gamma，gain 用 lighter 疊四次近似；
 *   遮罩外必須純黑 —— 不是黑就是合成器動到了不該動的像素。
 *
 * 影片本身由 <video> 元素顯示；difference / stabilized 要把影格畫進 canvas 才能運算，
 * 那時 VideoStage 會把 <video> 設成 visibility:hidden（仍在解碼，rVFC 照叫）。
 */
export interface PreviewLayerState {
  mode: ViewMode;
  video: HTMLVideoElement | null;
  image: CanvasImageSource | null;
  /** 並排推桿 0–1。 */
  splitX: number;
  /** A/B 閃爍：整張顯示替換結果。 */
  abFlicker: boolean;
  labels: { original: string; replaced: string };
}

export const DIFFERENCE_GAIN = 4;
export const SPLIT_HANDLE_PX = 6;

let scratch: HTMLCanvasElement | null = null;

function scratchCanvas(w: number, h: number): CanvasRenderingContext2D | null {
  if (!scratch) scratch = document.createElement("canvas");
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }
  return scratch.getContext("2d");
}

/** 並排推桿在螢幕上的 x。 */
export function splitScreenX(geo: StageGeometry, splitX: number): number {
  return geo.rect.x + geo.rect.w * splitX;
}

export function drawPreviewLayer(ctx: CanvasRenderingContext2D, geo: StageGeometry, state: PreviewLayerState, pal: Palette): void {
  const { rect } = geo;
  if (rect.w <= 0) return;
  const mode: ViewMode = state.abFlicker && state.mode !== "difference" && state.mode !== "stabilized" ? "replaced" : state.mode;

  if (mode === "replaced") {
    if (state.image) withGeoTransform(ctx, geo, () => ctx.drawImage(state.image!, rect.x, rect.y, rect.w, rect.h));
    return;
  }

  if (mode === "split") {
    const x = splitScreenX(geo, state.splitX);
    if (state.image) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, rect.y, rect.x + rect.w - x, rect.h);
      ctx.clip();
      withGeoTransform(ctx, geo, () => ctx.drawImage(state.image!, rect.x, rect.y, rect.w, rect.h));
      ctx.restore();
    }
    // 推桿：深色暈圈 + 亮線 + 中央把手
    ctx.save();
    ctx.strokeStyle = pal("app", 0.8);
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(x, rect.y);
    ctx.lineTo(x, rect.y + rect.h);
    ctx.stroke();
    ctx.strokeStyle = pal("preview");
    ctx.lineWidth = 2;
    ctx.stroke();
    const cy = rect.y + rect.h / 2;
    ctx.fillStyle = pal("preview");
    ctx.beginPath();
    ctx.arc(x, cy, SPLIT_HANDLE_PX + 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = pal("app");
    ctx.beginPath();
    ctx.moveTo(x - 5, cy);
    ctx.lineTo(x - 1.5, cy - 4);
    ctx.lineTo(x - 1.5, cy + 4);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x + 5, cy);
    ctx.lineTo(x + 1.5, cy - 4);
    ctx.lineTo(x + 1.5, cy + 4);
    ctx.closePath();
    ctx.fill();
    // 兩側標籤
    ctx.font = "11px Inter Variable, system-ui, sans-serif";
    ctx.textBaseline = "top";
    const tag = (text: string, tx: number, alignRight: boolean) => {
      const w = ctx.measureText(text).width + 10;
      const bx = alignRight ? tx - w - 8 : tx + 8;
      ctx.fillStyle = pal("app", 0.75);
      ctx.fillRect(bx, rect.y + 8, w, 17);
      ctx.fillStyle = pal("fg", 0.9);
      ctx.fillText(text, bx + 5, rect.y + 11);
    };
    tag(state.labels.original, x, true);
    tag(state.labels.replaced, x, false);
    ctx.restore();
    return;
  }

  if (mode === "difference") {
    ctx.save();
    ctx.fillStyle = "rgb(0 0 0)";
    withGeoTransform(ctx, geo, () => ctx.fillRect(rect.x, rect.y, rect.w, rect.h));
    ctx.restore();
    if (!state.image || !state.video) return;
    const dpr = geo.dpr;
    const w = Math.max(1, Math.round(rect.w * dpr));
    const h = Math.max(1, Math.round(rect.h * dpr));
    const sc = scratchCanvas(w, h);
    if (!sc) return;
    sc.globalCompositeOperation = "source-over";
    sc.clearRect(0, 0, w, h);
    sc.drawImage(state.video, 0, 0, w, h);
    sc.globalCompositeOperation = "difference";
    sc.drawImage(state.image, 0, 0, w, h);
    sc.globalCompositeOperation = "source-over";
    ctx.save();
    withGeoTransform(ctx, geo, () => {
      ctx.drawImage(scratch!, rect.x, rect.y, rect.w, rect.h);
      ctx.globalCompositeOperation = "lighter";
      for (let i = 1; i < DIFFERENCE_GAIN; i++) ctx.drawImage(scratch!, rect.x, rect.y, rect.w, rect.h);
    });
    ctx.restore();
  }
}

/** 穩定視圖 / 差異模式要自己把影格畫進 canvas（<video> 被隱藏）。 */
export function drawVideoFrame(ctx: CanvasRenderingContext2D, geo: StageGeometry, video: HTMLVideoElement): void {
  const { rect } = geo;
  if (rect.w <= 0 || video.readyState < 2) return;
  withGeoTransform(ctx, geo, () => ctx.drawImage(video, rect.x, rect.y, rect.w, rect.h));
}
