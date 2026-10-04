// 靜音偵測（對標 Descript / CapCut 的「移除靜音」）：從波形峰值找出可以剪掉的段落。
//
// 全部是純函式，不碰 store、不碰引擎：吃 peaks 的 rmsU8，吐出幀範圍。
// 波形是**每支媒體**算的（來源幀 k），序列是 t → (mediaId, k) 的對應表，
// 所以找完還要 projectToSequence 投影到序列時間，才知道要刪哪幾段。
import { SEQ_SAMPLE_RATE, type SequenceV2 } from "../project/format";
import { placeVideo } from "./map";
import type { SeqFrameRange } from "./ops";

export interface SilenceOptions {
  /** 低於這個 dBFS 算靜音。 */
  thresholdDb: number;
  /** 短於這個長度的靜音不動 —— 句與句之間的自然停頓是節奏，不是贅餘。 */
  minSilenceMs: number;
  /** 每段靜音頭尾各留多少：切太貼會把字頭字尾咬掉。 */
  padMs: number;
}

/** 預設值照 Descript 一類工具的手感：−40 dBFS、500 ms 以上才算、頭尾各留 100 ms。 */
export const DEFAULT_SILENCE: SilenceOptions = { thresholdDb: -40, minSilenceMs: 500, padMs: 100 };

/** rmsU8（0..255 ↔ −60..0 dBFS）→ dBFS。 */
export function rmsDb(u8: number): number {
  return (u8 / 255) * 60 - 60;
}

/** dBFS → rmsU8 的門檻（夾在 0..255）。 */
export function dbToU8(db: number): number {
  return Math.max(0, Math.min(255, ((db + 60) / 60) * 255));
}

/** 連續低於門檻的桶聚成區段（半開區間 [a, b)，單位：桶）。 */
export function silentBucketRuns(rms: ArrayLike<number>, thresholdDb: number): { a: number; b: number }[] {
  const lim = dbToU8(thresholdDb);
  const out: { a: number; b: number }[] = [];
  let a = -1;
  for (let i = 0; i < rms.length; i++) {
    const quiet = rms[i] < lim;
    if (quiet && a < 0) a = i;
    else if (!quiet && a >= 0) {
      out.push({ a, b: i });
      a = -1;
    }
  }
  if (a >= 0) out.push({ a, b: rms.length });
  return out;
}

/**
 * 找出「可以剪掉」的靜音區間，單位是該媒體的來源幀。
 *
 * 長度不足 minSilenceMs 的整段跳過；其餘頭尾各留 padMs，留完之後長度 ≤ 0 的也跳過
 * （padding 比靜音本身還長，代表這段根本沒有多餘的空白可以拿掉）。
 */
export function findSilentRanges(peaks: { pps: number; rmsU8: ArrayLike<number> }, fps: { num: number; den: number }, opts: SilenceOptions = DEFAULT_SILENCE): SeqFrameRange[] {
  const { pps, rmsU8 } = peaks;
  if (!(pps > 0) || !rmsU8.length) return [];
  const minBuckets = (opts.minSilenceMs / 1000) * pps;
  const padBuckets = (opts.padMs / 1000) * pps;
  const perFrame = fps.num / fps.den / pps; // 幀 / 桶
  const out: SeqFrameRange[] = [];
  for (const r of silentBucketRuns(rmsU8, opts.thresholdDb)) {
    if (r.b - r.a < minBuckets) continue;
    const a = r.a + padBuckets;
    const b = r.b - padBuckets;
    if (b - a <= 0) continue;
    const f0 = Math.ceil(a * perFrame);
    const f1 = Math.floor(b * perFrame);
    if (f1 > f0) out.push({ in: f0, out: f1 });
  }
  return out;
}

/**
 * 把某支媒體的來源幀區間投影到序列時間。
 *
 * 一段來源可能被剪成好幾個片段散在序列各處，也可能整段沒被用到 —— 所以是逐片段取交集，
 * 只回真的出現在序列上的部分。回傳依序列時間排序且互不重疊。
 */
export function mergeRanges(ranges: readonly SeqFrameRange[]): SeqFrameRange[] {
  const sorted = [...ranges].sort((x, y) => x.in - y.in);
  const out: SeqFrameRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.in <= last.out) last.out = Math.max(last.out, r.out);
    else out.push({ ...r });
  }
  return out;
}

export function projectToSequence(seq: SequenceV2, mediaId: string, ranges: readonly SeqFrameRange[]): SeqFrameRange[] {
  const out: SeqFrameRange[] = [];
  for (const p of placeVideo(seq)) {
    const it = p.item;
    if (it.kind !== "clip" || it.mediaId !== mediaId) continue;
    for (const r of ranges) {
      const a = Math.max(r.in, it.srcIn);
      const b = Math.min(r.out, it.srcOut);
      if (b > a) out.push({ in: p.t0 + (a - it.srcIn), out: p.t0 + (b - it.srcIn) });
    }
  }
  return mergeRanges(out);
}

/**
 * 同步鎖軌上有片段的時間（序列幀，往外取整）。
 *
 * 這些時間**不能當成靜音剪掉**：extractRange 會波紋帶走同步鎖軌，畫面安靜不代表旁白也安靜，
 * 剪下去等於把旁白從中間切斷。音樂軌（syncLock 關）不跟波紋，不在此列。
 * 往外取整是刻意的 —— 保護寧可多一幀，不要少一幀。
 */
export function syncLockedBusy(seq: SequenceV2): SeqFrameRange[] {
  const per = (seq.fps.num || 1) / ((seq.fps.den || 1) * SEQ_SAMPLE_RATE); // 幀 / 樣本
  const out: SeqFrameRange[] = [];
  for (const l of seq.audioLanes) {
    if (!l.syncLock) continue;
    for (const c of l.clips) {
      if (!c.enabled) continue;
      out.push({ in: Math.floor(c.start * per), out: Math.ceil((c.start + c.length) * per) });
    }
  }
  return mergeRanges(out);
}

/** 從 ranges 裡挖掉 blocks 涵蓋的部分；一段被挖成兩段時兩段都留。 */
export function subtractRanges(ranges: readonly SeqFrameRange[], blocks: readonly SeqFrameRange[]): SeqFrameRange[] {
  if (!blocks.length) return ranges.map((r) => ({ ...r }));
  const out: SeqFrameRange[] = [];
  for (const r of ranges) {
    let cur = [{ ...r }];
    for (const b of blocks) {
      const next: SeqFrameRange[] = [];
      for (const x of cur) {
        if (b.out <= x.in || b.in >= x.out) {
          next.push(x);
          continue;
        }
        if (b.in > x.in) next.push({ in: x.in, out: b.in });
        if (b.out < x.out) next.push({ in: b.out, out: x.out });
      }
      cur = next;
    }
    out.push(...cur.filter((x) => x.out > x.in));
  }
  return out;
}

/**
 * 整個序列的靜音：**每支用到的媒體各自找一次再投影合併**。
 *
 * 只看作用中那一支是錯的 —— 序列裡接了三支素材時，另外兩支的靜音會整段留著。
 * 拿不到波形的媒體跳過（還沒算完就不要亂猜），`missing` 回報是哪幾支，UI 才講得出
 * 「有 2 支素材的波形還沒好」而不是安靜地少剪。
 *
 * 只看 V1 片段自己的原音：空白（gap）本來就沒有聲音，但那是「沒有畫面」不是「有畫面但安靜」，
 * 要清掉空白是另一個操作（closeGap）。
 */
export function silentRangesOfSequence(
  seq: SequenceV2,
  peaksFor: (mediaId: string) => { pps: number; rmsU8: ArrayLike<number> } | null,
  opts: SilenceOptions = DEFAULT_SILENCE,
): { ranges: SeqFrameRange[]; missing: string[] } {
  const ids: string[] = [];
  for (const it of seq.video) if (it.kind === "clip" && !ids.includes(it.mediaId)) ids.push(it.mediaId);
  const all: SeqFrameRange[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const p = peaksFor(id);
    if (!p) {
      missing.push(id);
      continue;
    }
    all.push(...projectToSequence(seq, id, findSilentRanges(p, seq.fps, opts)));
  }
  // 同步鎖軌上有旁白的時間挖掉：那些地方剪下去會把旁白從中間切斷
  return { ranges: subtractRanges(mergeRanges(all), syncLockedBusy(seq)), missing };
}
