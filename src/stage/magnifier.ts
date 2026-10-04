import type { Pt } from "../video/quad";

/**
 * 拖把手 / 放參考點時游標旁的 4× 放大鏡（AE feature-region magnifier / Mocha Zoom Window）。
 * 遠景的平面只有 45×35 px，沒有它根本對不準角。純算術：來源矩形（proxy px）與放置位置（螢幕 px）。
 */
export const MAG_SIZE = 128;
export const MAG_ZOOM = 4;
/** 放大鏡與游標的間距。 */
export const MAG_OFFSET = 18;

export interface SourceRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * 以 center（proxy px）為中心取 size/zoom 見方；貼邊時**平移**而不是縮小 ——
 * 縮小會讓倍率變、十字對不上真實位置。影片比取樣窗還小時退回整張。
 */
export function magnifierSourceRect(center: Pt, videoW: number, videoH: number, zoom = MAG_ZOOM, size = MAG_SIZE): SourceRect {
  const sw = Math.min(videoW, size / zoom);
  const sh = Math.min(videoH, size / zoom);
  const sx = clamp(center[0] - sw / 2, 0, Math.max(0, videoW - sw));
  const sy = clamp(center[1] - sh / 2, 0, Math.max(0, videoH - sh));
  return { sx, sy, sw, sh };
}

/**
 * 取樣窗平移過後，游標真正對到的點在放大鏡裡的位置（相對放大鏡左上、螢幕 px）——
 * 十字要畫在這裡，不是永遠畫在正中央。
 */
export function magnifierCrosshair(center: Pt, src: SourceRect, size = MAG_SIZE): Pt {
  const kx = src.sw > 0 ? size / src.sw : 0;
  const ky = src.sh > 0 ? size / src.sh : 0;
  return [(center[0] - src.sx) * kx, (center[1] - src.sy) * ky];
}

/** 放在游標右下；碰到舞台右 / 下緣就翻到左 / 上。 */
export function magnifierPlacement(cursor: Pt, stage: { w: number; h: number }, size = MAG_SIZE, offset = MAG_OFFSET): Pt {
  let x = cursor[0] + offset;
  let y = cursor[1] + offset;
  if (x + size > stage.w) x = cursor[0] - offset - size;
  if (y + size > stage.h) y = cursor[1] - offset - size;
  return [clamp(x, 0, Math.max(0, stage.w - size)), clamp(y, 0, Math.max(0, stage.h - size))];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
