// Inspector「片段」頁的數字（docs/editor-m2-design.md §12 Inspector clip、§7.3 各鏈參數表、§13 M2.15「Inspector 的數值與 plan 一致」）。
//
// 純函式，不碰 store / React：
// - 片段在序列上的位置、來源入出點、時長；
// - 這個片段在輸出混音裡的那一條鏈：inUs / outUs / L / delay / leadPad / 靜態增益 —— 算式逐項照 engine `media/audio_graph.py`
//   （`_chain`、`build` 的 A0 與音軌兩段），`fixtures/sequence/inspector-chains.json` 由 Python 產生、兩邊的測試讀同一份，
//   公式漂移時兩邊一起紅；
// - 片段峰值（peaks.v1.bin 的 5 ms 桶，跟 render.py `_peak_resolver` 同一個桶範圍）；
// - 範圍內的 VFR 事實（CfrMap runs 的定格重複幀、來源斷層）與替換目標摘要。
//
// 為什麼要跟引擎逐項對得上：使用者在 Inspector 看到「音訊相對視訊 −6.5 ms、入點 2.000000 s」，打開輸出計畫卻是別的數字，
// 兩邊就都不可信了。
import { PEAKS_PPS, type PeaksMip } from "../audio/peaks";
import { SEQ_SAMPLE_RATE, SILENCE_DB, type AudioClipV2, type AudioInfoV2, type AudioLaneV2, type ClipGainV2, type Rational, type SequenceV2, type VideoClipV2 } from "../project/format";
import type { SeqCtx } from "../sequence/context";
import { audioAbsUs, floorDiv, placedSampleLength, placeVideo, samplesOfFrame, videoAbsUs, type PlacedItem } from "../sequence/map";

/** 輸出混音裡某個片段的那一條鏈（engine audio_graph.Chain.to_json 的子集）。 */
export interface ChainFacts {
  inUs: number;
  outUs: number;
  /** L：序列樣本。 */
  length: number;
  /** 序列樣本。 */
  delay: number;
  /** 入點早於串流起點 / 落在 pts 斷層裡時，前面補的靜音（48 kHz 樣本）。 */
  leadPad: number;
  /** 靜態增益：片段增益＋軌道推桿（A0 = 原音推桿）＋整條同值的自動化。 */
  gainDb: number;
  /** 自動化曲線的最大值（峰值估計的上界；沒有運算式時 0）。 */
  envMaxDb: number;
}

/** 這個片段不會出現在混音裡的原因（對應引擎 build 的略過條件）；null = 會出聲。 */
export type SilentReason = "clipDisabled" | "originalMuted" | "detached" | "busMuted" | "laneMuted" | "noAudio" | "gainSilent" | "afterEnd" | null;

/** Python `round_half_up(num, den)`：num/den 四捨五入，x.5 往 +∞。 */
export function roundHalfUpDiv(num: number, den: number): number {
  return floorDiv(2 * num + den, 2 * den);
}

/** 入點之前「還沒有聲音」的 µs（audio_graph `_lead_pad_us`）：早於串流起點，或落在 pts 斷層裡。 */
export function leadPadUs(info: Pick<AudioInfoV2, "startUs" | "gaps">, inUs: number): number {
  let pad = info.startUs - inUs;
  for (const g of info.gaps) if (g.atUs <= inUs && inUs < g.atUs + g.durUs) pad = Math.max(pad, g.atUs + g.durUs - inUs);
  return Math.max(0, pad);
}

/** 自動化對靜態增益與峰值上界的貢獻（audio_graph `_chain` 的 env_const / env_max）。整條 ≤ −90 dB 回 null（視為靜音）。 */
export function envelopeContribution(g: ClipGainV2): { constDb: number; maxDb: number } | null {
  const dbs = g.envelope.map((p) => p.db);
  if (!dbs.length) return { constDb: 0, maxDb: 0 };
  if (Math.max(...dbs) <= SILENCE_DB) return null;
  if (dbs.every((d) => d === dbs[0])) return { constDb: dbs[0], maxDb: 0 };
  return { constDb: 0, maxDb: Math.max(...dbs) };
}

function chainOf(g: ClipGainV2, info: AudioInfoV2, inUs: number, outUs: number, length: number, delay: number, busDb: number): ChainFacts | null {
  const env = envelopeContribution(g);
  if (!env || g.gainDb <= SILENCE_DB) return null;
  return {
    inUs,
    outUs,
    length,
    delay,
    leadPad: roundHalfUpDiv(leadPadUs(info, inUs) * SEQ_SAMPLE_RATE, 1_000_000),
    gainDb: g.gainDb + busDb + env.constDb,
    envMaxDb: env.maxDb,
  };
}

// ---------------------------------------------------------------- V1 片段

export interface V1ClipFacts {
  kind: "v1";
  clip: VideoClipV2;
  placed: PlacedItem;
  /** 序列幀 [t0, t1)。 */
  t0: number;
  t1: number;
  frames: number;
  /** 原音在序列上的樣本位置與長度。 */
  startSample: number;
  lengthSamples: number;
  /** 音訊串流相對影片第一幀（µs）：startUs − videoStartUs；純音訊或還沒分析 = null。 */
  audioOffsetUs: number | null;
  info: AudioInfoV2 | null;
  chain: ChainFacts | null;
  silent: SilentReason;
}

export function v1ClipFacts(seq: SequenceV2, clipId: string, ctx: SeqCtx): V1ClipFacts | null {
  const placed = placeVideo(seq).find((p) => p.item.id === clipId);
  if (!placed || placed.item.kind !== "clip") return null;
  const clip = placed.item;
  const info = ctx.media(clip.mediaId)?.audio ?? null;
  const startSample = samplesOfFrame(placed.t0, seq.fps);
  const lengthSamples = placedSampleLength(placed, seq.fps);
  let silent: SilentReason = null;
  let chain: ChainFacts | null = null;
  if (!clip.enabled) silent = "clipDisabled";
  else if (clip.audio.detachedTo !== undefined) silent = "detached";
  else if (!clip.audio.enabled) silent = "originalMuted";
  else if (seq.original.muted || seq.original.gainDb <= SILENCE_DB) silent = "busMuted";
  else if (!info) silent = "noAudio";
  else {
    // 沒有影片起點（純音訊檔當 V1？）時以音訊起點對齊，同 audio_graph 的 note
    const vs = info.videoStartUs ?? info.startUs;
    chain = chainOf(clip.audio, info, videoAbsUs(clip.srcIn, seq.fps, vs), videoAbsUs(clip.srcOut, seq.fps, vs), lengthSamples, startSample, seq.original.gainDb);
    if (!chain) silent = "gainSilent";
  }
  return {
    kind: "v1",
    clip,
    placed,
    t0: placed.t0,
    t1: placed.t1,
    frames: placed.t1 - placed.t0,
    startSample,
    lengthSamples,
    audioOffsetUs: info && info.videoStartUs !== null ? info.startUs - info.videoStartUs : null,
    info,
    chain,
    silent,
  };
}

// ---------------------------------------------------------------- 音訊片段

export interface AudioClipFacts {
  kind: "audio";
  clip: AudioClipV2;
  lane: AudioLaneV2;
  info: AudioInfoV2 | null;
  /** 來源入點的容器絕對時間（µs）；還沒分析 = null。 */
  srcInUs: number | null;
  /** 片段在序列上的小數幀位置（時間碼顯示用）。 */
  startFrame: number;
  endFrame: number;
  chain: ChainFacts | null;
  silent: SilentReason;
}

export function audioClipFacts(seq: SequenceV2, clipId: string, ctx: SeqCtx): AudioClipFacts | null {
  const lane = seq.audioLanes.find((l) => l.clips.some((c) => c.id === clipId));
  const clip = lane?.clips.find((c) => c.id === clipId);
  if (!lane || !clip) return null;
  const src = clip.source;
  const info = (src.type === "media" ? ctx.media(src.mediaId)?.audio : ctx.audioMedia(src.audioId)?.audio) ?? null;
  const srcInUs = info ? audioAbsUs(clip.srcIn, info) : null;
  const seqSamples = samplesOfFrame(placeVideo(seq).reduce((t, p) => Math.max(t, p.t1), 0), seq.fps);
  let silent: SilentReason = null;
  let chain: ChainFacts | null = null;
  if (lane.muted || lane.gainDb <= SILENCE_DB) silent = "laneMuted";
  else if (!clip.enabled) silent = "clipDisabled";
  else if (clip.start >= seqSamples) silent = "afterEnd";
  else if (!info || srcInUs === null) silent = "noAudio";
  else {
    // outUs = inUs + ceil(length·1e6 / 48000)（audio_graph build 的音軌段）
    chain = chainOf(clip, info, srcInUs, srcInUs + -floorDiv(-clip.length * 1_000_000, SEQ_SAMPLE_RATE), clip.length, clip.start, lane.gainDb);
    if (!chain) silent = "gainSilent";
  }
  return {
    kind: "audio",
    clip,
    lane,
    info,
    srcInUs,
    startFrame: (clip.start * seq.fps.num) / (SEQ_SAMPLE_RATE * seq.fps.den),
    endFrame: ((clip.start + clip.length) * seq.fps.num) / (SEQ_SAMPLE_RATE * seq.fps.den),
    chain,
    silent,
  };
}

// ---------------------------------------------------------------- 峰值

const PEAK_BUCKET_US = 1_000_000 / PEAKS_PPS;

/**
 * 來源在 [inUs, outUs) 內的峰值（dBFS）：同 render.py `_peak_resolver` 的桶範圍（floor(in/5ms) .. ceil(out/5ms)）。
 * 範圍內全靜音回 −120（遠低於任何門檻）；峰值還沒算好回 null。
 */
export function sourcePeakDbfs(mip: PeaksMip | null, inUs: number, outUs: number): number | null {
  if (!mip) return null;
  const lv = mip.levels[0];
  const lo = Math.max(0, Math.floor(inUs / PEAK_BUCKET_US));
  const hi = Math.min(lv.n, Math.ceil(outUs / PEAK_BUCKET_US));
  let m = 0;
  for (let i = lo; i < hi; i++) m = Math.max(m, Math.abs(lv.mins[i]), Math.abs(lv.maxs[i]));
  return m > 0 ? 20 * Math.log10(m / 127) : -120;
}

/** 套上鏈的靜態增益與自動化最大值之後的峰值上界（估計，同 audio_graph.estimate_peak_dbfs 的單路）。 */
export function chainPeakDbfs(sourcePeak: number | null, chain: ChainFacts | null): number | null {
  if (sourcePeak === null || !chain) return null;
  return sourcePeak + chain.gainDb + chain.envMaxDb;
}

// ---------------------------------------------------------------- VFR 事實

export interface VfrFacts {
  /** 範圍內的定格重複幀數（CfrMap 讓相鄰兩個 k 顯示同一個來源幀）。 */
  duplicates: number;
  /** 範圍內可見的來源斷層（≥ 40 ms）：從 k 開始畫面才恢復。 */
  gaps: { k: number; gapMs: number }[];
}

/**
 * index.v1.json（pts_ms 與 cfr.runs `[[k0, src0, count], …]`）→ proxy 幀 [srcIn, srcOut) 內的 VFR 事實。
 * 重複只會出現在 run 交界（新 run 的 src0 = 上一個 run 的最後一個 src，mediaCache.summarizeCfr 同一個判準）；
 * 片段第一幀跟片段外的前一幀相同不算（片段裡看不到那一次重複）。形狀不對回 null。
 */
export function vfrFactsInRange(raw: unknown, srcIn: number, srcOut: number): VfrFacts | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { pts_ms?: unknown; cfr?: { runs?: unknown } };
  const pts = r.pts_ms;
  const runs = r.cfr?.runs;
  if (!Array.isArray(pts) || !Array.isArray(runs)) return null;
  const out: VfrFacts = { duplicates: 0, gaps: [] };
  let lastSrc = -1;
  for (const run of runs) {
    if (!Array.isArray(run) || run.length !== 3 || !run.every((x) => Number.isInteger(x))) return null;
    const [k0, s0, c] = run as number[];
    if (lastSrc >= 0 && s0 === lastSrc && k0 > srcIn && k0 < srcOut) out.duplicates++;
    // 這個 run 內每個新出現的來源幀：跟前一個來源幀的間隔 ≥ 40 ms 就是斷層（畫面在 k 才恢復）
    for (let j = 0; j < c; j++) {
      const s = s0 + j;
      const k = k0 + j;
      if (s === lastSrc || s <= 0 || k <= srcIn || k >= srcOut) continue;
      const a = pts[s - 1];
      const b = pts[s];
      if (typeof a === "number" && typeof b === "number" && b - a >= 40) out.gaps.push({ k, gapMs: Math.round((b - a) * 1000) / 1000 });
    }
    lastSrc = s0 + c - 1;
  }
  return out;
}

// ---------------------------------------------------------------- 時間格式

/** µs → "hh:mm:ss.mmm"（負數帶 −；Inspector 的來源入點）。 */
export function formatUsClock(us: number): string {
  const neg = us < 0;
  const ms = Math.round(Math.abs(us) / 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const f = ms % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${neg ? "−" : ""}${p(h)}:${p(m)}:${p(s)}.${p(f, 3)}`;
}

/** 樣本 → 秒（兩位小數）；淡化長度等顯示用。 */
export function secondsOfSamples(samples: number, sr: number = SEQ_SAMPLE_RATE): string {
  return (samples / sr).toFixed(2);
}

/** 自動化點 at（片段內序列樣本）→ 絕對序列時間的小數幀。 */
export function frameOfClipSample(startSample: number, at: number, fps: Rational): number {
  return ((startSample + at) * fps.num) / (SEQ_SAMPLE_RATE * fps.den);
}
