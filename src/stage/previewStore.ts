import { create } from "zustand";

/**
 * 合成預覽（`comp.preview` 的 PNG）快取與請求節流（計畫 §9 PreviewLayer：debounce 120 ms，
 * 快取鍵 `{frame, tracksHash, targetsHash, insertHash}`）。
 *
 * 這裡**不知道引擎**：誰去叫 comp.preview 由 pipeline 注入 `setPreviewProvider`（A4 才有）。
 * 舞台只負責：需要就問、拿到就記、鍵不變就不再問。這樣 stage 不用 import api / engine，
 * 單元測試也能在 node 跑鍵的計算。
 */
export interface PreviewKeyParts {
  mediaId: string;
  frame: number;
  tracksHash: string;
  targetsHash: string;
  insertHash: string;
}

export type PreviewProvider = (parts: PreviewKeyParts) => Promise<CanvasImageSource | null>;

/** FNV-1a 32 位；夠當快取鍵，不當安全用途。 */
export function hashOf(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function previewKey(p: PreviewKeyParts): string {
  return `${p.mediaId}:${p.frame}:${p.tracksHash}:${p.targetsHash}:${p.insertHash}`;
}

export const PREVIEW_CACHE_MAX = 60;
export const PREVIEW_DEBOUNCE_MS = 120;

const cache = new Map<string, CanvasImageSource>();
const inflight = new Set<string>();
let provider: PreviewProvider | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function setPreviewProvider(p: PreviewProvider | null): void {
  provider = p;
}

export function hasPreviewProvider(): boolean {
  return provider !== null;
}

/** 版本號：每次有新圖進來就 +1，讓 canvas 圖層知道要重畫（Map 是可變的）。 */
export const usePreviews = create<{ version: number }>(() => ({ version: 0 }));

function bump() {
  usePreviews.setState((s) => ({ version: s.version + 1 }));
}

export function getPreview(key: string): CanvasImageSource | null {
  const v = cache.get(key);
  if (!v) return null;
  // LRU：命中搬到最後
  cache.delete(key);
  cache.set(key, v);
  return v;
}

export function putPreview(key: string, img: CanvasImageSource): void {
  cache.delete(key);
  cache.set(key, img);
  while (cache.size > PREVIEW_CACHE_MAX) {
    const first = cache.keys().next().value as string;
    const old = cache.get(first);
    if (old && "close" in old && typeof (old as ImageBitmap).close === "function") (old as ImageBitmap).close();
    cache.delete(first);
  }
  bump();
}

/** 目標 / 關鍵幀一改就整批失效（鍵裡本來就含 hash，這裡只是釋放記憶體）。 */
export function clearPreviews(): void {
  for (const v of cache.values()) if ("close" in v && typeof (v as ImageBitmap).close === "function") (v as ImageBitmap).close();
  cache.clear();
  bump();
}

/**
 * 要求某一幀的預覽：120 ms 內只送最後一個（scrub 時每幀都要會把引擎打爆），
 * 同鍵在飛就不重送。沒有 provider 就什麼都不做（畫面顯示「預覽尚未就緒」）。
 */
export function requestPreview(parts: PreviewKeyParts, debounceMs = PREVIEW_DEBOUNCE_MS): void {
  if (!provider) return;
  const key = previewKey(parts);
  if (cache.has(key) || inflight.has(key)) return;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    if (!provider || cache.has(key) || inflight.has(key)) return;
    inflight.add(key);
    provider(parts)
      .then((img) => {
        if (img) putPreview(key, img);
      })
      .catch(() => {
        /* 失敗就讓下一次請求再試；錯誤由 pipeline 自己 toast */
      })
      .finally(() => inflight.delete(key));
  }, debounceMs);
}

/** 測試用。 */
export function __resetPreviews(): void {
  cache.clear();
  inflight.clear();
  provider = null;
  if (timer !== null) clearTimeout(timer);
  timer = null;
}
