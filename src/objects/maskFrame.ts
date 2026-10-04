/**
 * 從 `masks.aivm` 讀**一幀**遮罩（docs/tracking-api.md §3）：header 52 bytes ＋ index（每筆 20 bytes）讀一次留著，
 * 之後每一幀只用 `api.cacheRead(offset, len)` 讀那一幀的 RLE（幾 KB），解成 ImageBitmap。
 *
 * 舞台只在**暫停時、選中的那一個物件**才叫這裡（播放時用錨點畫框，見 objects/meta.ts）：一幀 1280×720 的遮罩
 * 解碼要掃一百萬個像素，每幀做一次會吃掉 rAF。位圖進 store/masks 的 LRU（鍵 = trackId:frame），同一幀不重解。
 */
import { api } from "../api";
import { maskToRgba, rleToMask } from "../video/rle";

export const AIVM_HEADER_BYTES = 52;
export const AIVM_INDEX_ENTRY_BYTES = 20;

export interface AivmHeader {
  version: number;
  width: number;
  height: number;
  entries: number;
  firstK: number;
  lastK: number;
  indexOff: number;
  dataOff: number;
  dataLen: number;
}

export interface AivmEntry {
  k: number;
  /** 相對 dataOff。 */
  off: number;
  len: number;
  /** flags & 1 = present。 */
  present: boolean;
}

/** header → 物件；magic 不對 / 太短 → null。全部 little-endian。 */
export function parseAivmHeader(buf: ArrayBuffer): AivmHeader | null {
  if (buf.byteLength < AIVM_HEADER_BYTES) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== 0x41 || v.getUint8(1) !== 0x49 || v.getUint8(2) !== 0x56 || v.getUint8(3) !== 0x4d) return null;
  return {
    version: v.getUint32(4, true),
    width: v.getUint32(8, true),
    height: v.getUint32(12, true),
    entries: v.getUint32(16, true),
    firstK: v.getUint32(20, true),
    lastK: v.getUint32(24, true),
    indexOff: Number(v.getBigUint64(28, true)),
    dataOff: Number(v.getBigUint64(36, true)),
    dataLen: Number(v.getBigUint64(44, true)),
  };
}

/** index 區塊 → 條目（依 k 遞增）。長度不足的尾巴略過。 */
export function parseAivmIndex(buf: ArrayBuffer, n: number): AivmEntry[] {
  const v = new DataView(buf);
  const out: AivmEntry[] = [];
  for (let i = 0; i < n && (i + 1) * AIVM_INDEX_ENTRY_BYTES <= buf.byteLength; i++) {
    const o = i * AIVM_INDEX_ENTRY_BYTES;
    out.push({ k: v.getUint32(o, true), off: Number(v.getBigUint64(o + 4, true)), len: v.getUint32(o + 12, true), present: (v.getUint8(o + 16) & 1) === 1 });
  }
  return out;
}

/** 二分搜尋（index 依 k 嚴格遞增）。 */
export function findEntry(index: readonly AivmEntry[], k: number): AivmEntry | null {
  let lo = 0;
  let hi = index.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = index[mid];
    if (e.k === k) return e;
    if (e.k < k) lo = mid + 1;
    else hi = mid - 1;
  }
  return null;
}

interface Opened {
  header: AivmHeader;
  index: AivmEntry[];
}

/** 每條 track 的 header + index（遮罩被 adopt 重寫時 forget）。 */
const opened = new Map<string, Promise<Opened | null>>();

function relOf(trackId: string): string {
  return `tracks/${trackId}/masks.aivm`;
}

async function open(mediaId: string, trackId: string): Promise<Opened | null> {
  const key = `${mediaId}:${trackId}`;
  let p = opened.get(key);
  if (!p) {
    p = (async () => {
      try {
        const header = parseAivmHeader(await api.cacheRead(mediaId, relOf(trackId), 0, AIVM_HEADER_BYTES));
        if (!header) return null;
        const bytes = header.entries * AIVM_INDEX_ENTRY_BYTES;
        const index = bytes ? parseAivmIndex(await api.cacheRead(mediaId, relOf(trackId), header.indexOff, bytes), header.entries) : [];
        return { header, index };
      } catch {
        return null;
      }
    })();
    opened.set(key, p);
  }
  const r = await p;
  if (!r) opened.delete(key); // 失敗不留：遮罩可能等一下才 adopt 進來
  return r;
}

/** 遮罩檔換了（objects.adopt / 刪除）：下次重讀 header。 */
export function forgetMaskFile(mediaId: string, trackId: string): void {
  opened.delete(`${mediaId}:${trackId}`);
  forgetMissing(mediaId, trackId);
}

/**
 * 讀一幀 → 白色 alpha 位圖。沒有遮罩檔 / 這一幀沒算過 / 物件不在 → null。
 * （`createImageBitmap` 在測試環境沒有；只在 App 裡呼叫。）
 */
export async function readMaskFrame(mediaId: string, trackId: string, k: number): Promise<{ bitmap: ImageBitmap; area: number } | null> {
  const f = await open(mediaId, trackId);
  if (!f) return null;
  const e = findEntry(f.index, k);
  if (!e || !e.present || e.len <= 0) return null;
  const raw = await api.cacheRead(mediaId, relOf(trackId), f.header.dataOff + e.off, e.len);
  const counts = new TextDecoder("ascii").decode(new Uint8Array(raw));
  const mask = rleToMask({ size: [f.header.height, f.header.width], counts });
  let area = 0;
  for (let i = 0; i < mask.length; i++) area += mask[i];
  const bitmap = await createImageBitmap(new ImageData(maskToRgba(mask, [255, 255, 255], 1), f.header.width, f.header.height));
  return { bitmap, area };
}

/** 正在讀的幀（同一幀不重送）；讀不到的幀記著，免得暫停在物件不在的幀上每次重畫都再讀一次。 */
const pending = new Set<string>();
const missing = new Set<string>();

/**
 * 舞台要畫「選中物件這一幀的遮罩」時呼叫：快取（store/masks LRU）裡沒有就讀一幀、放進去（訂閱者會重畫）。
 * 回傳 true = 已經在快取裡。`put` 由呼叫端給（store/masks 的 put），這個模組不依賴 zustand store，測得動。
 */
export function requestMaskFrame(mediaId: string, trackId: string, k: number, has: (trackId: string, k: number) => boolean, put: (trackId: string, k: number, e: { bitmap: ImageBitmap; area: number }) => void): boolean {
  if (has(trackId, k)) return true;
  const key = `${mediaId}:${trackId}:${k}`;
  if (pending.has(key) || missing.has(key)) return false;
  pending.add(key);
  void readMaskFrame(mediaId, trackId, k)
    .then((r) => {
      if (r) put(trackId, k, r);
      else missing.add(key);
    })
    .catch(() => missing.add(key))
    .finally(() => pending.delete(key));
  return false;
}

/** 遮罩檔換了：之前「讀不到」的記錄也作廢。 */
export function forgetMissing(mediaId: string, trackId: string): void {
  const prefix = `${mediaId}:${trackId}:`;
  for (const k of [...missing]) if (k.startsWith(prefix)) missing.delete(k);
}
