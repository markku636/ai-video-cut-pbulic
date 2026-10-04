/// <reference lib="webworker" />
import { maskToRgba, rleToMask, type Rle } from "./rle";

/**
 * RLE → ImageBitmap 的 worker（最小接線；A2 才會被 store/masks.ts 大量使用）。
 * 訊息：{ id, rle, rgb, alpha } → { id, bitmap, area } 或 { id, error }。
 * bitmap 用 transfer 回去（零複製）；CSP 要有 `worker-src 'self' blob:`（計畫 §7 Cargo/tauri.conf 列）。
 */
export interface RleWorkerRequest {
  id: number;
  rle: Rle;
  rgb: [number, number, number];
  alpha: number;
}

export type RleWorkerResponse = { id: number; bitmap: ImageBitmap; area: number } | { id: number; error: string };

self.onmessage = async (ev: MessageEvent<RleWorkerRequest>) => {
  const { id, rle, rgb, alpha } = ev.data;
  try {
    const [h, w] = rle.size;
    const mask = rleToMask(rle);
    let area = 0;
    for (let i = 0; i < mask.length; i++) area += mask[i];
    const rgba = maskToRgba(mask, rgb, alpha);
    const bitmap = await createImageBitmap(new ImageData(rgba, w, h));
    (self as unknown as Worker).postMessage({ id, bitmap, area } satisfies RleWorkerResponse, [bitmap]);
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: e instanceof Error ? e.message : String(e) } satisfies RleWorkerResponse);
  }
};
