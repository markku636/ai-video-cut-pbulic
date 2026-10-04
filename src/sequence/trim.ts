// 修剪片段一端（docs/editor-m2-design.md §5.2 trimEdge、§10.2 Ctrl+Shift+[ / ]）。
// V1（片段或空白）單位是幀、一律波紋；音訊片段單位是樣本、預設不波紋。夾得住的一律夾住，UI 拖曳時用 clampTrimDelta 顯示實際量。
import { SEQ_SAMPLE_RATE, type AudioClipV2, type AudioLaneV2, type SequenceV2, type VideoItemV2 } from "../project/format";
import { sourceAudioInfo, type SeqCtx } from "./context";
import { fitGain, shiftEnvelope, sliceEnvelope } from "./envelope";
import { clipIdsOf, SequenceError } from "./ids";
import { insertSamples, mapShared, nativeRate, srcAdvance } from "./laneEdit";
import { placedAt, placedSampleLength, placeVideo, samplesOfFrame, type PlacedItem } from "./map";
import { finish, rippleLanes, ripples } from "./seqEdit";

export type TrimEdge = "in" | "out";

export interface TrimOptions {
  /** 音訊片段：修剪時同軌後面的片段跟著移（V1 一律波紋，忽略這個選項）。 */
  ripple?: boolean;
}

function findAudio(seq: SequenceV2, id: string): { lane: AudioLaneV2; li: number; ci: number } | null {
  for (let li = 0; li < seq.audioLanes.length; li++) {
    const ci = seq.audioLanes[li].clips.findIndex((c) => c.id === id);
    if (ci >= 0) return { lane: seq.audioLanes[li], li, ci };
  }
  return null;
}

const clampNum = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** V1 項目邊緣實際能動多少幀：片段夾在 [0, proxy 幀數]、長度 ≥ 1；幀數未知時不能往後延長。空白長度 ≥ 1。 */
function clampV1Delta(it: VideoItemV2, edge: TrimEdge, delta: number, ctx: SeqCtx | undefined): number {
  const d = Math.round(delta);
  if (it.kind === "gap") return edge === "in" ? Math.min(d, it.length - 1) : Math.max(d, 1 - it.length);
  if (edge === "in") return clampNum(it.srcIn + d, 0, it.srcOut - 1) - it.srcIn;
  const frames = ctx?.media(it.mediaId)?.frames ?? null;
  // 已經離線（srcOut > 幀數）的片段可以縮短、不能再往外延長
  const maxOut = frames == null ? it.srcOut : Math.max(frames, it.srcOut);
  return clampNum(it.srcOut + d, it.srcIn + 1, maxOut) - it.srcOut;
}

/** 音訊片段邊緣實際能動多少樣本：長度 ≥ 1、不撞同軌鄰居（非波紋時）、不超出來源（srcIn 不低於 min(原值, 0)、尾端不超過 nSamples）。 */
function clampAudioDelta(lane: AudioLaneV2, ci: number, edge: TrimEdge, delta: number, ctx: SeqCtx | undefined, ripple: boolean): number {
  const c = lane.clips[ci];
  const d = Math.round(delta);
  const sr = nativeRate(ctx, c);
  if (edge === "in") {
    const minSrc = Math.min(c.srcIn, 0);
    const loSrc = -Math.floor(((c.srcIn - minSrc) * SEQ_SAMPLE_RATE) / sr);
    const prevEnd = ci > 0 ? lane.clips[ci - 1].start + lane.clips[ci - 1].length : 0;
    const lo = ripple ? loSrc : Math.max(loSrc, prevEnd - c.start);
    return clampNum(d, lo, c.length - 1);
  }
  const info = sourceAudioInfo(ctx, c.source);
  // 不知道來源多長時不讓它往外長（不然會長出一段靜音、還以為是素材）
  const maxLen = info ? Math.floor(((info.nSamples - c.srcIn) * SEQ_SAMPLE_RATE) / sr) : c.length;
  const room = ripple || ci + 1 >= lane.clips.length ? Number.POSITIVE_INFINITY : lane.clips[ci + 1].start - c.start;
  return clampNum(d, 1 - c.length, Math.max(0, Math.min(maxLen, room) - c.length));
}

/** 修剪實際會套用的量（UI 拖曳 tooltip 與吸附用）；找不到 id 回 0。V1 單位是幀、音訊片段是樣本。 */
export function clampTrimDelta(seq: SequenceV2, id: string, edge: TrimEdge, delta: number, ctx?: SeqCtx, opts: TrimOptions = {}): number {
  const it = seq.video.find((x) => x.id === id);
  if (it) return clampV1Delta(it, edge, delta, ctx);
  const f = findAudio(seq, id);
  return f ? clampAudioDelta(f.lane, f.ci, edge, delta, ctx, !!opts.ripple) : 0;
}

function trimV1(seq: SequenceV2, p: PlacedItem, edge: TrimEdge, d: number, ctx: SeqCtx | undefined): SequenceV2 {
  const it = p.item;
  const S = (t: number) => samplesOfFrame(t, seq.fps);
  let next: VideoItemV2;
  if (it.kind === "gap") next = { ...it, length: edge === "in" ? it.length - d : it.length + d };
  else if (edge === "in") {
    // 開頭往後修 d 幀：原本在 t0+d 的內容移到 t0，曲線跟著內容往前移；往前延長則往後移（hold 補前面）
    const shift = S(p.t0 + Math.abs(d)) - S(p.t0);
    const envelope = d > 0 ? sliceEnvelope(it.audio.envelope, shift, placedSampleLength(p, seq.fps)) : shiftEnvelope(it.audio.envelope, shift);
    next = { ...it, srcIn: it.srcIn + d, audio: { ...it.audio, envelope } };
  } else {
    const envelope = d < 0 ? sliceEnvelope(it.audio.envelope, 0, S(p.t1 + d) - S(p.t0)) : it.audio.envelope;
    next = { ...it, srcOut: it.srcOut + d, audio: envelope === it.audio.envelope ? it.audio : { ...it.audio, envelope } };
  }
  const video = [...seq.video.slice(0, p.index), next, ...seq.video.slice(p.index + 1)];
  const taken = clipIdsOf(seq);
  // V1 磁吸：長度變化發生在被修剪的那一端。縮短 = 那段時間從同步鎖軌移除；延長 = 在那一點插入時間
  const at = edge === "in" ? p.t0 : p.t1;
  let lanes: AudioLaneV2[];
  if ((edge === "in" && d > 0) || (edge === "out" && d < 0)) {
    const a = edge === "in" ? p.t0 : p.t1 + d;
    lanes = rippleLanes(seq, seq.audioLanes, [[a, a + Math.abs(d)]], ctx, taken);
  } else {
    const P = S(at);
    const D = S(at + Math.abs(d)) - P;
    lanes = mapShared(seq.audioLanes, (l) => (ripples(l) ? insertSamples(l, P, D, ctx, taken) : l));
  }
  return finish(seq, video, lanes);
}

function trimAudio(seq: SequenceV2, li: number, ci: number, edge: TrimEdge, d: number, ctx: SeqCtx | undefined, ripple: boolean): SequenceV2 {
  const lane = seq.audioLanes[li];
  const c = lane.clips[ci];
  let next: AudioClipV2;
  let shiftLater: number;
  if (edge === "in") {
    const envelope = d > 0 ? sliceEnvelope(c.envelope, d, c.length) : shiftEnvelope(c.envelope, -d);
    next = fitGain({ ...c, start: ripple ? c.start : c.start + d, length: c.length - d, srcIn: c.srcIn + srcAdvance(d, nativeRate(ctx, c)), envelope }, c.length - d);
    shiftLater = -d;
  } else {
    const envelope = d < 0 ? sliceEnvelope(c.envelope, 0, c.length + d) : c.envelope;
    next = fitGain({ ...c, length: c.length + d, envelope }, c.length + d);
    shiftLater = d;
  }
  const clips = lane.clips.map((x, i) => (i === ci ? next : ripple && i > ci ? { ...x, start: x.start + shiftLater } : x));
  const audioLanes = seq.audioLanes.map((l, i) => (i === li ? { ...lane, clips } : l));
  return finish(seq, seq.video, audioLanes);
}

/**
 * 修剪片段一端（§5.2 trimEdge）。delta 是「邊緣往後移多少」：in 邊 +delta 變短、out 邊 +delta 變長。
 * V1（片段或空白）單位是幀、一律波紋（磁吸），同步鎖軌跟著移；音訊片段單位是樣本、預設不波紋。
 * 超出範圍夾住（見 clampTrimDelta）；鎖定的軌擲 locked。
 */
export function trimEdge(seq: SequenceV2, id: string, edge: TrimEdge, delta: number, ctx?: SeqCtx, opts: TrimOptions = {}): SequenceV2 {
  const p = placeVideo(seq).find((x) => x.item.id === id);
  if (p) {
    const d = clampV1Delta(p.item, edge, delta, ctx);
    return d === 0 ? seq : trimV1(seq, p, edge, d, ctx);
  }
  const f = findAudio(seq, id);
  if (!f) throw new SequenceError("notFound", `找不到片段 ${id}`, { id });
  if (f.lane.locked) throw new SequenceError("locked", `音軌 ${f.lane.name} 已鎖定`, { laneId: f.lane.id });
  const d = clampAudioDelta(f.lane, f.ci, edge, delta, ctx, !!opts.ripple);
  return d === 0 ? seq : trimAudio(seq, f.li, f.ci, edge, d, ctx, !!opts.ripple);
}

/**
 * 修剪開頭 / 結尾到播放線（Ctrl+Shift+[ / ]，Resolve Ripple Start/End to Playhead）：播放線所在的 V1 片段。
 * 播放線不在片段內部（在空白上、剛好在切點）時不動。
 */
export function rippleTrimToPlayhead(seq: SequenceV2, t: number, edge: TrimEdge, ctx?: SeqCtx): SequenceV2 {
  const p = placedAt(placeVideo(seq), t);
  if (!p || p.item.kind !== "clip" || t <= p.t0) return seq;
  return edge === "in" ? trimEdge(seq, p.item.id, "in", t - p.t0, ctx) : trimEdge(seq, p.item.id, "out", t - p.t1, ctx);
}
