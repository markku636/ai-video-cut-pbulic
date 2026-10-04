/**
 * 波形峰值 `peaks.v1.bin`（"AIVP"，Rust src-tauri/src/peaks.rs 產生；設計 §3.4 / §9.3）的解析與 mip。
 *
 * 純函式、不碰 DOM：主執行緒（沒有 Worker 時的退路、vitest）與 peaks.worker.ts 共用同一份。
 *
 * 時間原點是**容器絕對時間**：第 i 個桶 = [5i, 5i+5) ms（Rust 用 `-copyts` + `first_pts=0` 解碼）。
 * 跟渲染（§7.3 的 atrim 絕對時間）同一個時間域，時間軸把序列位置換成容器 µs 之後直接查桶，不必再扣起點。
 *
 * 版面（little-endian）：
 * `"AIVP" | u32 version=1 | u32 pps=200 | u32 sr=48000 | u32 n_buckets | u64 total_samples | i64 stream_start_us`
 * `→ i8[n] min → i8[n] max → u8[n] rms(−60..0 dBFS) → u8[n] zero-cross`
 *
 * 規則跟 Rust `PeaksHeader::parse` 一致（magic / 版本 / pps / sr / 長度剛好），兩邊對「什麼算壞檔」不會分岔；
 * 共用 golden 在 fixtures/peaks/aivp-v1.golden.json。
 */

/** "AIVP" 以 little-endian u32 讀出來的值。 */
export const PEAKS_MAGIC = 0x50564941;
export const PEAKS_VERSION = 1;
export const PEAKS_PPS = 200;
export const PEAKS_SAMPLE_RATE = 48000;
export const PEAKS_HEADER_LEN = 36;
/** 零交越欄位的「這個桶裡沒有」。 */
export const NO_ZERO_CROSS = 255;

/** mip 每層合併幾格：5 ms → 20 ms → 80 ms → 320 ms → 1.28 s（§9.3）。 */
export const MIP_FACTOR = 4;
export const MIP_LEVELS = 5;
/** 繪製時每個像素最多涵蓋幾格（超過就換粗一層）：再多一個像素要掃的格子就不是常數了。 */
export const MAX_BUCKETS_PER_PIXEL = 4;

export class PeaksFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeaksFormatError";
  }
}

export interface PeaksV1 {
  version: number;
  /** 每秒桶數（200）。 */
  pps: number;
  sampleRate: number;
  nBuckets: number;
  /** 分析器吃進去的樣本數（含容器起點之前補的靜音）。 */
  totalSamples: number;
  /** 音訊串流的 start_time（µs，可為負：Opus pre-skip）；只供顯示，桶的時間原點已經是容器 0。 */
  streamStartUs: number;
  /** −127..127，除以 127 是振幅。 */
  mins: Int8Array;
  maxs: Int8Array;
  /** 0..255 ↔ −60..0 dBFS。 */
  rmsU8: Uint8Array;
  /** 桶內第一個上升零交越的樣本位移（255 = 沒有）。 */
  zx: Uint8Array;
}

/** mip 的一層。第 0 層直接是解析出來的陣列（不複製）。 */
export interface PeakLevel {
  /** 這一層一格 = 幾個原始 5 ms 桶（MIP_FACTOR 的次方）。 */
  span: number;
  n: number;
  mins: Int8Array;
  maxs: Int8Array;
  rmsU8: Uint8Array;
}

export interface PeaksMip {
  peaks: PeaksV1;
  /** levels[0] = 原始桶；之後每層 ×MIP_FACTOR。 */
  levels: PeakLevel[];
}

/** 解析 peaks.v1.bin。任何不符都擲 PeaksFormatError（不猜、不部分讀）。陣列是 `buf` 上的 view，不複製。 */
export function parsePeaks(buf: ArrayBuffer): PeaksV1 {
  const len = buf.byteLength;
  if (len < 4) throw new PeaksFormatError(`peaks.v1.bin 太短（${len} byte）`);
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== PEAKS_MAGIC) {
    // ai-music-cut 的 analysis.bin（AIPK）時間原點不同，被當成這個格式讀會安靜地錯位 —— 所以一定要在這裡擲錯
    const magic = String.fromCharCode(...new Uint8Array(buf, 0, 4));
    throw new PeaksFormatError(`peaks.v1.bin magic 不符（${JSON.stringify(magic)}，應為 AIVP）`);
  }
  if (len < PEAKS_HEADER_LEN) throw new PeaksFormatError(`peaks.v1.bin header 不完整（${len} < ${PEAKS_HEADER_LEN} byte）`);
  const version = dv.getUint32(4, true);
  if (version !== PEAKS_VERSION) throw new PeaksFormatError(`peaks.v1.bin 版本 ${version} 不支援（這一版讀 ${PEAKS_VERSION}）`);
  const pps = dv.getUint32(8, true);
  const sampleRate = dv.getUint32(12, true);
  if (pps !== PEAKS_PPS || sampleRate !== PEAKS_SAMPLE_RATE) throw new PeaksFormatError(`peaks.v1.bin 桶設定不符（pps ${pps}、sr ${sampleRate}）`);
  const nBuckets = dv.getUint32(16, true);
  const want = PEAKS_HEADER_LEN + nBuckets * 4;
  if (len !== want) throw new PeaksFormatError(`peaks.v1.bin 長度不符（${len} ≠ ${want} byte）`);
  // u64 / i64 → number：樣本數到 2^53 是 5.9 萬年的 48 kHz，µs 是 285 年，都不會失真
  const totalSamples = Number(dv.getBigUint64(20, true));
  const streamStartUs = Number(dv.getBigInt64(28, true));
  let off = PEAKS_HEADER_LEN;
  const mins = new Int8Array(buf, off, nBuckets);
  off += nBuckets;
  const maxs = new Int8Array(buf, off, nBuckets);
  off += nBuckets;
  const rmsU8 = new Uint8Array(buf, off, nBuckets);
  off += nBuckets;
  const zx = new Uint8Array(buf, off, nBuckets);
  return { version, pps, sampleRate, nBuckets, totalSamples, streamStartUs, mins, maxs, rmsU8, zx };
}

export function rmsU8ToDb(v: number): number {
  return (v / 255) * 60 - 60;
}

/** 功率 → RMS 碼（與 Rust `db_to_u8` 同一條映射）。功率 ≤ 0 視為 −∞ → 0。 */
export function powerToRmsU8(power: number): number {
  if (!(power > 0)) return 0;
  const db = 10 * Math.log10(power);
  return Math.min(255, Math.max(0, Math.round(((db + 60) / 60) * 255)));
}

/** RMS 碼 → 功率的查表（碼 0 = −60 dBFS 以下，含數位靜音，當 −60 dB 的功率）。 */
const POWER_OF_RMS_U8: Float64Array = (() => {
  const t = new Float64Array(256);
  for (let c = 0; c < 256; c++) t[c] = 10 ** (rmsU8ToDb(c) / 10);
  return t;
})();

/**
 * 建 mip：每層 min 取子格最小、max 取最大、RMS 在**功率域**依涵蓋的原始桶數加權平均
 * （dB 域平均會被一個特別安靜的桶拉低，整段遠景波形看起來比實際小聲；尾端不滿一格的子格要照實際桶數加權）。
 * 每層的三個陣列放在同一個 ArrayBuffer，worker transfer 回主執行緒時只要列一個。
 */
export function buildMip(peaks: PeaksV1, levels = MIP_LEVELS): PeaksMip {
  const out: PeakLevel[] = [{ span: 1, n: peaks.nBuckets, mins: peaks.mins, maxs: peaks.maxs, rmsU8: peaks.rmsU8 }];
  for (let l = 1; l < Math.max(1, levels); l++) {
    const prev = out[l - 1];
    const span = prev.span * MIP_FACTOR;
    const n = Math.ceil(peaks.nBuckets / span);
    const store = new ArrayBuffer(n * 3);
    const mins = new Int8Array(store, 0, n);
    const maxs = new Int8Array(store, n, n);
    const rmsU8 = new Uint8Array(store, 2 * n, n);
    for (let i = 0; i < n; i++) {
      const c0 = i * MIP_FACTOR;
      const c1 = Math.min(c0 + MIP_FACTOR, prev.n);
      let mn = 127;
      let mx = -127;
      let power = 0;
      let weight = 0;
      for (let c = c0; c < c1; c++) {
        if (prev.mins[c] < mn) mn = prev.mins[c];
        if (prev.maxs[c] > mx) mx = prev.maxs[c];
        const w = Math.min(prev.span, peaks.nBuckets - c * prev.span);
        power += POWER_OF_RMS_U8[prev.rmsU8[c]] * w;
        weight += w;
      }
      mins[i] = mn;
      maxs[i] = mx;
      rmsU8[i] = powerToRmsU8(power / weight);
    }
    out.push({ span, n, mins, maxs, rmsU8 });
  }
  return { peaks, levels: out };
}

/** 選「每像素 ≤ maxPerPixel 格」裡最細的一層；最粗一層也超過就用最粗的。 */
export function pickLevel(mip: PeaksMip, rawBucketsPerPixel: number, maxPerPixel = MAX_BUCKETS_PER_PIXEL): number {
  for (let l = 0; l < mip.levels.length; l++) {
    if (rawBucketsPerPixel / mip.levels[l].span <= maxPerPixel) return l;
  }
  return mip.levels.length - 1;
}

/** 容器絕對時間（µs）→ 原始桶座標（小數；整數部分就是桶號）。 */
export function bucketOfUs(us: number, pps = PEAKS_PPS): number {
  return (us * pps) / 1e6;
}

export interface PeakColumns {
  /** 用了哪一層。 */
  level: number;
  /** −1..1；整格都在資料範圍外（起點之前 / 結尾之後）是 NaN，繪圖端跳過不畫。 */
  min: Float32Array;
  max: Float32Array;
  /** RMS 振幅 0..1（功率平均後開根號）；範圍外 NaN。 */
  rms: Float32Array;
}

/**
 * 把一段桶範圍攤成 `columns` 個像素欄：第 x 欄涵蓋原始桶 [start + x·bpp, start + (x+1)·bpp)。
 * 一欄至少取一格（放大到一格好幾個像素時，每個像素都畫那一格的 min→max）。
 */
export function sampleColumns(mip: PeaksMip, startBucket: number, rawBucketsPerPixel: number, columns: number, level = pickLevel(mip, rawBucketsPerPixel)): PeakColumns {
  const cols = Math.max(0, Math.floor(columns));
  const min = new Float32Array(cols);
  const max = new Float32Array(cols);
  const rms = new Float32Array(cols);
  const li = Math.min(Math.max(0, Math.floor(level)), mip.levels.length - 1);
  const lv = mip.levels[li];
  const nRaw = mip.peaks.nBuckets;
  const bpp = Math.max(0, rawBucketsPerPixel);
  for (let x = 0; x < cols; x++) {
    const a = startBucket + x * bpp;
    const b = a + bpp;
    if (nRaw === 0 || b <= 0 || a >= nRaw) {
      min[x] = max[x] = rms[x] = NaN;
      continue;
    }
    const i0 = Math.min(lv.n - 1, Math.floor(Math.max(0, a) / lv.span));
    const i1 = Math.min(lv.n, Math.max(i0 + 1, Math.ceil(Math.min(b, nRaw) / lv.span)));
    let mn = 127;
    let mx = -127;
    let power = 0;
    for (let i = i0; i < i1; i++) {
      if (lv.mins[i] < mn) mn = lv.mins[i];
      if (lv.maxs[i] > mx) mx = lv.maxs[i];
      power += POWER_OF_RMS_U8[lv.rmsU8[i]];
    }
    min[x] = mn / 127;
    max[x] = mx / 127;
    const code = powerToRmsU8(power / (i1 - i0));
    // 碼 0 是「−60 dB 以下」：畫成 0 而不是 −60 dB 的 0.001，靜音段內層才不會多一條細線
    rms[x] = code === 0 ? 0 : 10 ** (rmsU8ToDb(code) / 20);
  }
  return { level: li, min, max, rms };
}

/** mip 裡所有 typed array 底下的 ArrayBuffer（不重複）：worker postMessage 的 transfer 清單。 */
export function transferablesOf(mip: PeaksMip): ArrayBuffer[] {
  const set = new Set<ArrayBuffer>();
  const add = (a: ArrayBufferView) => {
    if (a.buffer instanceof ArrayBuffer) set.add(a.buffer);
  };
  const p = mip.peaks;
  [p.mins, p.maxs, p.rmsU8, p.zx].forEach(add);
  for (const l of mip.levels) [l.mins, l.maxs, l.rmsU8].forEach(add);
  return [...set];
}

/** 解析 + 建 mip（worker 與主執行緒退路共用）。 */
export function decodePeaksMip(buf: ArrayBuffer, levels = MIP_LEVELS): PeaksMip {
  return buildMip(parsePeaks(buf), levels);
}
