// 音量正規化（每個剪輯器都有的 Normalize）：從波形峰值算出「要加多少 dB 才會頂到目標」。
//
// 用真實峰值而不是 RMS / LUFS：峰值正規化的結果可預期（不會削波、不改動態），
// 而且只需要 peaks 已經有的 mins / maxs，不必另外跑一趟分析。
// 要做響度（LUFS）得在引擎端量，那是另一件事。
import type { Rational } from "../project/format";

/** peaks 的 mins / maxs 是 −127..127，除以 127 是振幅。 */
const AMP_MAX = 127;

/** 正規化的目標峰值：−1 dBFS 是業界慣例（留 1 dB 餘裕給編碼器的 inter-sample peak）。 */
export const NORMALIZE_TARGET_DB = -1;

/**
 * 來源幀區間 [srcIn, srcOut) 的真實峰值（dBFS）。
 *
 * 整段都是數位靜音（振幅 0）時回 null —— 那種片段「正規化」要加無限大的增益，沒有意義，
 * 呼叫端應該跳過而不是把它推到爆。區間超出波形範圍時夾住。
 */
export interface PeakSource {
  pps: number;
  mins: ArrayLike<number>;
  maxs: ArrayLike<number>;
}

/** 桶區間 [a, b) 的峰值；夾在波形範圍內，整段靜音回 null。幀與樣本兩條路共用這個核心。 */
function peakDbOfBuckets(peaks: PeakSource, a: number, b: number): number | null {
  const n = Math.min(peaks.mins.length, peaks.maxs.length);
  if (!n) return null;
  const lo = Math.max(0, Math.floor(a));
  const hi = Math.min(n, Math.ceil(b));
  let peak = 0;
  for (let i = lo; i < hi; i++) {
    const v = Math.max(Math.abs(peaks.mins[i]), Math.abs(peaks.maxs[i]));
    if (v > peak) peak = v;
  }
  return peak > 0 ? 20 * Math.log10(Math.min(1, peak / AMP_MAX)) : null;
}

export function peakDbOfRange(peaks: PeakSource, fps: Rational, srcIn: number, srcOut: number): number | null {
  if (!(peaks.pps > 0) || !(fps.num > 0)) return null;
  const perFrame = (peaks.pps * fps.den) / fps.num; // 桶 / 幀
  return peakDbOfBuckets(peaks, srcIn * perFrame, srcOut * perFrame);
}

/** 同上，但區間單位是**來源樣本** —— 音軌上的片段 srcIn 是樣本不是幀。 */
export function peakDbOfSamples(peaks: PeakSource, sampleRate: number, srcIn: number, srcOut: number): number | null {
  if (!(peaks.pps > 0) || !(sampleRate > 0)) return null;
  const perSample = peaks.pps / sampleRate; // 桶 / 樣本
  return peakDbOfBuckets(peaks, srcIn * perSample, srcOut * perSample);
}

/** 正規化到目標峰值要加的 dB（正 = 要拉大）。 */
export function normalizeGainDb(peakDb: number, targetDb: number = NORMALIZE_TARGET_DB): number {
  return Math.round((targetDb - peakDb) * 10) / 10;
}
