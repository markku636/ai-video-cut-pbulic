import { create } from "zustand";

/**
 * 遮罩位圖快取（計畫 §8：ImageBitmap LRU 120；**在 undo 之外**）。
 * 鍵 = `${trackId}:${frame}`。A0 只有形狀：MaskLayer 會從這裡 get()，A2 才由 pipeline/mask.ts 餵進來。
 *
 * 為什麼是 LRU 而不是全部留著：1280×720 一張 bitmap 約 3.7 MB，1762 幀 × 6 條 track 是 39 GB。
 * 120 張夠蓋住「來回 scrub 一段」的工作集，超過就丟最舊的（bitmap.close() 立刻還 GPU 記憶體）。
 */
export const MASK_LRU_MAX = 120;

export interface MaskEntry {
  bitmap: ImageBitmap;
  /** 遮罩像素數（vis = area(mask)/area(quad) 用）。 */
  area: number;
}

interface MasksStore {
  /** 插入順序 = LRU 順序（Map 保序）；get 會把命中的移到最後。 */
  cache: Map<string, MaskEntry>;
  /** 版本號：每次 put / clear 遞增，讓 canvas 圖層知道要重畫（Map 是可變的，不能靠參考比較）。 */
  version: number;
  put: (trackId: string, frame: number, entry: MaskEntry) => void;
  get: (trackId: string, frame: number) => MaskEntry | null;
  has: (trackId: string, frame: number) => boolean;
  clearTrack: (trackId: string) => void;
  clearAll: () => void;
}

export const maskKey = (trackId: string, frame: number) => `${trackId}:${frame}`;

export const useMasks = create<MasksStore>((set, get) => ({
  cache: new Map(),
  version: 0,
  put: (trackId, frame, entry) => {
    const cache = get().cache;
    const k = maskKey(trackId, frame);
    const old = cache.get(k);
    if (old && old.bitmap !== entry.bitmap) old.bitmap.close();
    cache.delete(k);
    cache.set(k, entry);
    while (cache.size > MASK_LRU_MAX) {
      const first = cache.keys().next().value as string;
      cache.get(first)?.bitmap.close();
      cache.delete(first);
    }
    set((s) => ({ version: s.version + 1 }));
  },
  get: (trackId, frame) => {
    const cache = get().cache;
    const k = maskKey(trackId, frame);
    const e = cache.get(k);
    if (!e) return null;
    // 命中就搬到最後（最近用過）
    cache.delete(k);
    cache.set(k, e);
    return e;
  },
  has: (trackId, frame) => get().cache.has(maskKey(trackId, frame)),
  clearTrack: (trackId) => {
    const cache = get().cache;
    const prefix = `${trackId}:`;
    let n = 0;
    for (const [k, e] of cache) {
      if (k.startsWith(prefix)) {
        e.bitmap.close();
        cache.delete(k);
        n++;
      }
    }
    if (n) set((s) => ({ version: s.version + 1 }));
  },
  clearAll: () => {
    for (const e of get().cache.values()) e.bitmap.close();
    get().cache.clear();
    set((s) => ({ version: s.version + 1 }));
  },
}));
