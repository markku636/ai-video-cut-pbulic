// peaks.v1.bin 解析與 mip（M2.8）。golden 與 Rust src-tauri/src/peaks.rs 的 golden_fixture_matches_packer 共用同一份檔。
import { describe, expect, it } from "vitest";
import {
  MIP_FACTOR,
  MIP_LEVELS,
  PEAKS_HEADER_LEN,
  PeaksFormatError,
  bucketOfUs,
  buildMip,
  decodePeaksMip,
  parsePeaks,
  pickLevel,
  powerToRmsU8,
  rmsU8ToDb,
  sampleColumns,
  transferablesOf,
  type PeaksV1,
} from "./peaks";

interface Golden {
  hex: string;
  expect: { version: number; pps: number; sampleRate: number; nBuckets: number; totalSamples: number; streamStartUs: number; mins: number[]; maxs: number[]; rms: number[]; zx: number[] };
}

const FILES = import.meta.glob("../../fixtures/peaks/aivp-v1.golden.json", { eager: true, import: "default" }) as Record<string, unknown>;
const GOLDEN = FILES["../../fixtures/peaks/aivp-v1.golden.json"] as Golden;

function hexToBuf(hex: string): ArrayBuffer {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out.buffer;
}

/** 依 Rust Analyzer::finish 的版面手工打包。 */
function pack(opts: { mins: number[]; maxs: number[]; rms: number[]; zx?: number[]; total?: number; startUs?: number; version?: number; pps?: number; sr?: number }): ArrayBuffer {
  const n = opts.mins.length;
  const buf = new ArrayBuffer(PEAKS_HEADER_LEN + n * 4);
  const dv = new DataView(buf);
  new Uint8Array(buf, 0, 4).set([0x41, 0x49, 0x56, 0x50]); // "AIVP"
  dv.setUint32(4, opts.version ?? 1, true);
  dv.setUint32(8, opts.pps ?? 200, true);
  dv.setUint32(12, opts.sr ?? 48000, true);
  dv.setUint32(16, n, true);
  dv.setBigUint64(20, BigInt(opts.total ?? n * 240), true);
  dv.setBigInt64(28, BigInt(opts.startUs ?? 0), true);
  let off = PEAKS_HEADER_LEN;
  new Int8Array(buf, off, n).set(opts.mins);
  off += n;
  new Int8Array(buf, off, n).set(opts.maxs);
  off += n;
  new Uint8Array(buf, off, n).set(opts.rms);
  off += n;
  new Uint8Array(buf, off, n).set(opts.zx ?? opts.mins.map(() => 255));
  return buf;
}

/** 可重現的假資料（LCG）：min ≤ 0 ≤ max，rms 任意碼。 */
function synthetic(n: number, seed = 7): PeaksV1 {
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const mins: number[] = [];
  const maxs: number[] = [];
  const rms: number[] = [];
  for (let i = 0; i < n; i++) {
    mins.push(-Math.floor(rnd() * 128));
    maxs.push(Math.floor(rnd() * 128));
    rms.push(Math.floor(rnd() * 256));
  }
  return parsePeaks(pack({ mins, maxs, rms }));
}

describe("parsePeaks × fixtures/peaks/aivp-v1.golden.json（Rust／TS 共用）", () => {
  const p = parsePeaks(hexToBuf(GOLDEN.hex));
  const e = GOLDEN.expect;

  it("header 欄位與 Rust 打包的一致（含有號的 stream_start_us）", () => {
    expect([p.version, p.pps, p.sampleRate, p.nBuckets, p.totalSamples, p.streamStartUs]).toEqual([e.version, e.pps, e.sampleRate, e.nBuckets, e.totalSamples, e.streamStartUs]);
    expect(p.streamStartUs).toBe(-7000);
  });

  it("四段陣列逐桶相同", () => {
    expect(Array.from(p.mins)).toEqual(e.mins);
    expect(Array.from(p.maxs)).toEqual(e.maxs);
    expect(Array.from(p.rmsU8)).toEqual(e.rms);
    expect(Array.from(p.zx)).toEqual(e.zx);
  });

  it("RMS 碼換回 dB：斜坡 ±0.5 ≈ −10.75 dBFS，±1 方波 = 0 dBFS", () => {
    expect(rmsU8ToDb(p.rmsU8[0])).toBeCloseTo(-10.75, 0);
    expect(rmsU8ToDb(p.rmsU8[2])).toBe(0);
  });
});

describe("parsePeaks 拒絕壞檔", () => {
  const good = pack({ mins: [-1, -2], maxs: [1, 2], rms: [10, 20] });

  it("好檔讀得動", () => {
    expect(parsePeaks(good).nBuckets).toBe(2);
    expect(parsePeaks(pack({ mins: [], maxs: [], rms: [] })).nBuckets).toBe(0);
  });

  it("magic 不符（ai-music-cut 的 AIPK）當場擲 PeaksFormatError，不錯位讀取", () => {
    const aipk = good.slice(0);
    new Uint8Array(aipk, 0, 4).set([0x41, 0x49, 0x50, 0x4b]);
    expect(() => parsePeaks(aipk)).toThrow(PeaksFormatError);
    expect(() => parsePeaks(aipk)).toThrow(/magic/);
  });

  it("版本、桶設定、長度不符都擲錯", () => {
    expect(() => parsePeaks(pack({ mins: [0], maxs: [0], rms: [0], version: 2 }))).toThrow(/版本/);
    expect(() => parsePeaks(pack({ mins: [0], maxs: [0], rms: [0], pps: 100 }))).toThrow(PeaksFormatError);
    expect(() => parsePeaks(pack({ mins: [0], maxs: [0], rms: [0], sr: 44100 }))).toThrow(PeaksFormatError);
    expect(() => parsePeaks(good.slice(0, good.byteLength - 1))).toThrow(/長度/);
    const longer = new Uint8Array(good.byteLength + 1);
    longer.set(new Uint8Array(good));
    expect(() => parsePeaks(longer.buffer)).toThrow(/長度/);
    expect(() => parsePeaks(good.slice(0, PEAKS_HEADER_LEN - 1))).toThrow(/header/);
    expect(() => parsePeaks(new ArrayBuffer(3))).toThrow(PeaksFormatError);
  });
});

describe("buildMip", () => {
  it("5 層、每層 ×4（5 ms → 1.28 s），格數 = ceil(n / span)，第 0 層不複製", () => {
    const p = synthetic(1001);
    const mip = buildMip(p);
    expect(mip.levels.map((l) => l.span)).toEqual([1, 4, 16, 64, 256]);
    expect(mip.levels.map((l) => l.n)).toEqual([1001, 251, 63, 16, 4]);
    expect(mip.levels.length).toBe(MIP_LEVELS);
    expect(mip.levels[0].mins).toBe(p.mins);
  });

  it("每層每格的 min／max 等於它涵蓋的原始桶範圍的極值（含不滿一格的尾巴）", () => {
    const p = synthetic(1001, 42);
    const mip = buildMip(p);
    for (const lv of mip.levels) {
      for (let i = 0; i < lv.n; i++) {
        const a = i * lv.span;
        const b = Math.min(a + lv.span, p.nBuckets);
        let mn = 127;
        let mx = -127;
        for (let k = a; k < b; k++) {
          mn = Math.min(mn, p.mins[k]);
          mx = Math.max(mx, p.maxs[k]);
        }
        expect([lv.span, i, lv.mins[i], lv.maxs[i]]).toEqual([lv.span, i, mn, mx]);
      }
    }
  });

  it("RMS 在功率域依涵蓋桶數平均：第 1 層逐格精確，更粗的層與原始桶直接平均最多差 1 碼", () => {
    const p = synthetic(1001, 99);
    const mip = buildMip(p);
    const power = (c: number) => 10 ** (rmsU8ToDb(c) / 10);
    for (const lv of mip.levels.slice(1)) {
      for (let i = 0; i < lv.n; i++) {
        const a = i * lv.span;
        const b = Math.min(a + lv.span, p.nBuckets);
        let sum = 0;
        for (let k = a; k < b; k++) sum += power(p.rmsU8[k]);
        const want = powerToRmsU8(sum / (b - a));
        if (lv.span === MIP_FACTOR) expect(lv.rmsU8[i]).toBe(want);
        else expect(Math.abs(lv.rmsU8[i] - want)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("功率域而不是 dB 域：一個 0 dB 桶配三個靜音桶 ≈ −6 dB（dB 域平均會是 −45 dB）", () => {
    const mip = buildMip(parsePeaks(pack({ mins: [-127, 0, 0, 0], maxs: [127, 0, 0, 0], rms: [255, 0, 0, 0] })));
    expect(rmsU8ToDb(mip.levels[1].rmsU8[0])).toBeCloseTo(-6.02, 0);
  });

  it("空檔也建得出來（每層 0 格）", () => {
    const mip = decodePeaksMip(pack({ mins: [], maxs: [], rms: [] }));
    expect(mip.levels.map((l) => l.n)).toEqual([0, 0, 0, 0, 0]);
    expect(sampleColumns(mip, 0, 1, 3).max.every((v) => Number.isNaN(v))).toBe(true);
  });

  it("transfer 清單不重複（postMessage 遇到重複的 ArrayBuffer 會擲錯）：原始檔 1 個 + 每層 1 個", () => {
    const mip = buildMip(synthetic(300));
    const list = transferablesOf(mip);
    expect(new Set(list).size).toBe(list.length);
    expect(list.length).toBe(1 + (MIP_LEVELS - 1));
  });
});

describe("pickLevel / sampleColumns", () => {
  const mip = buildMip(synthetic(4096, 3));

  it("選每像素 ≤ 4 格裡最細的一層，超過最粗層就用最粗", () => {
    expect(pickLevel(mip, 0.25)).toBe(0);
    expect(pickLevel(mip, 4)).toBe(0);
    expect(pickLevel(mip, 4.01)).toBe(1);
    expect(pickLevel(mip, 16)).toBe(1);
    expect(pickLevel(mip, 17)).toBe(2);
    expect(pickLevel(mip, 1024)).toBe(4);
    expect(pickLevel(mip, 1e7)).toBe(4);
  });

  it("每欄的 min／max = 該欄原始桶範圍的極值（不論用哪一層，欄寬是層格寬的整數倍時）", () => {
    for (const bpp of [1, 4, 16, 64]) {
      const cols = sampleColumns(mip, 32, bpp, 20);
      expect(cols.level).toBe(pickLevel(mip, bpp));
      for (let x = 0; x < 20; x++) {
        const a = 32 + x * bpp;
        let mn = 127;
        let mx = -127;
        for (let k = a; k < a + bpp; k++) {
          mn = Math.min(mn, mip.peaks.mins[k]);
          mx = Math.max(mx, mip.peaks.maxs[k]);
        }
        expect([bpp, x, cols.min[x], cols.max[x]]).toEqual([bpp, x, Math.fround(mn / 127), Math.fround(mx / 127)]);
      }
    }
  });

  it("放大到一格好幾個像素：每個像素都畫所在那一格", () => {
    const cols = sampleColumns(mip, 10, 0.25, 8);
    for (let x = 0; x < 8; x++) {
      const k = 10 + Math.floor(x * 0.25);
      expect(cols.max[x]).toBeCloseTo(mip.peaks.maxs[k] / 127, 6);
    }
  });

  it("資料範圍外（容器起點之前、結尾之後）是 NaN；跨邊界的欄只取範圍內的格", () => {
    const cols = sampleColumns(mip, -3, 1, 6, 0);
    expect(Array.from(cols.max.slice(0, 3)).every(Number.isNaN)).toBe(true);
    expect(cols.max[3]).toBeCloseTo(mip.peaks.maxs[0] / 127, 6);
    const tail = sampleColumns(mip, 4094, 1, 4, 0);
    expect(Number.isNaN(tail.max[1])).toBe(false);
    expect(Number.isNaN(tail.max[2])).toBe(true);
    const straddle = sampleColumns(mip, -0.5, 1, 1, 0);
    expect(straddle.max[0]).toBeCloseTo(mip.peaks.maxs[0] / 127, 6);
  });

  it("RMS 振幅：0 dBFS → 1、碼 0（−60 dB 以下）→ 0", () => {
    const m = buildMip(parsePeaks(pack({ mins: [-127, 0], maxs: [127, 0], rms: [255, 0] })));
    const c = sampleColumns(m, 0, 1, 2);
    expect(c.rms[0]).toBeCloseTo(1, 6);
    expect(c.rms[1]).toBe(0);
  });

  it("容器 µs → 桶座標（mp3 LAME 延遲 25 057 µs 落在第 5 桶）", () => {
    expect(bucketOfUs(25_057)).toBeCloseTo(5.0114, 4);
    expect(Math.floor(bucketOfUs(4_999))).toBe(0);
    expect(bucketOfUs(5_000)).toBe(1);
  });
});
