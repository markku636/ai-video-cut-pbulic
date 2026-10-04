// 峰值正規化：dBFS 換算、區間夾住、數位靜音回 null。
import { describe, expect, it } from "vitest";
import { normalizeGainDb, NORMALIZE_TARGET_DB, peakDbOfRange, peakDbOfSamples } from "./loudness";

const FPS30 = { num: 30, den: 1 };
/** 前 100 桶振幅 12、後 100 桶滿格 127。 */
const peaks = () => {
  const mins = new Int8Array(200);
  const maxs = new Int8Array(200);
  for (let i = 0; i < 200; i++) {
    const v = i < 100 ? 12 : 127;
    mins[i] = -v;
    maxs[i] = v;
  }
  return { pps: 200, mins, maxs };
};

describe("peakDbOfRange", () => {
  it("滿格是 0 dBFS；振幅 12/127 約 −20.5 dBFS", () => {
    // 30 fps、200 pps → 每幀 6.67 桶；[20, 30) 幀落在滿格那半
    expect(peakDbOfRange(peaks(), FPS30, 20, 30)).toBeCloseTo(0, 5);
    expect(peakDbOfRange(peaks(), FPS30, 0, 10)).toBeCloseTo(20 * Math.log10(12 / 127), 5);
  });

  it("區間超出波形就夾住；整段數位靜音回 null（那種片段要加無限大增益，沒有意義）", () => {
    expect(peakDbOfRange(peaks(), FPS30, -50, 99999)).toBeCloseTo(0, 5);
    const silent = { pps: 200, mins: new Int8Array(200), maxs: new Int8Array(200) };
    expect(peakDbOfRange(silent, FPS30, 0, 30)).toBeNull();
    expect(peakDbOfRange({ pps: 0, mins: new Int8Array(4), maxs: new Int8Array(4) }, FPS30, 0, 1)).toBeNull();
    expect(peakDbOfRange({ pps: 200, mins: new Int8Array(0), maxs: new Int8Array(0) }, FPS30, 0, 1)).toBeNull();
  });
});

describe("peakDbOfSamples（音軌片段的 srcIn 是樣本不是幀）", () => {
  it("樣本換算到同一個桶區間，結果跟幀那條路一致", () => {
    // 48 kHz、200 pps → 每樣本 1/240 桶；前 100 桶 = 前 24000 樣本
    expect(peakDbOfSamples(peaks(), 48000, 0, 24000)).toBeCloseTo(20 * Math.log10(12 / 127), 5);
    expect(peakDbOfSamples(peaks(), 48000, 24000, 48000)).toBeCloseTo(0, 5);
    expect(peakDbOfSamples(peaks(), 0, 0, 100)).toBeNull();
  });
});

describe("normalizeGainDb", () => {
  it("目標減去量到的峰值，取到小數一位；預設目標 −1 dBFS", () => {
    expect(NORMALIZE_TARGET_DB).toBe(-1);
    expect(normalizeGainDb(-20.49)).toBe(19.5);
    expect(normalizeGainDb(0)).toBe(-1);
    expect(normalizeGainDb(-6, -3)).toBe(3);
  });
});
