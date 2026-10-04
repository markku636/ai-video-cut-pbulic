// 序列的結構檢查（docs/editor-m2-design.md §5.2 validateSequence、§1.2 I6）。
//
// 跟 sanitize 的差別：sanitize 是「讀檔時把壞東西修掉」，這裡是「剪輯函式的輸出不該有任何問題」——
// 每個 op 的測試都跑一次，回傳空陣列才算過。所以規則比 sanitize 嚴：淡化超長、曲線未排序在這裡是錯，不是警告。
import { GAIN_DB_MAX, GAIN_DB_MIN, SEQ_SAMPLE_RATE, isFadeCurve, isAudioRole, type ClipGainV2, type SequenceV2 } from "../project/format";
import type { SeqCtx } from "./context";
import { placeVideo, placedSampleLength } from "./map";

export type SequenceIssueCode =
  | "fps"
  | "sampleRate"
  | "duplicateId"
  | "duplicateLaneId"
  | "gapLength"
  | "clipRange"
  | "unknownMedia"
  | "offline"
  | "fadeNegative"
  | "fadeTooLong"
  | "fadeCurve"
  | "gainRange"
  | "envelopeOrder"
  | "envelopeRange"
  | "audioClipRange"
  | "overlap"
  | "unsorted"
  | "unknownSource"
  | "detachedTo"
  | "detachedFrom"
  | "role";

export interface SequenceIssue {
  code: SequenceIssueCode;
  /** 片段 / 音軌 id。 */
  ref?: string;
}

const isInt = (v: number) => Number.isInteger(v);

function checkGain(g: ClipGainV2, length: number, ref: string, out: SequenceIssue[]): void {
  if (!isInt(g.fadeIn) || !isInt(g.fadeOut) || g.fadeIn < 0 || g.fadeOut < 0) out.push({ code: "fadeNegative", ref });
  else if (g.fadeIn + g.fadeOut > length) out.push({ code: "fadeTooLong", ref });
  if (!isFadeCurve(g.fadeCurve)) out.push({ code: "fadeCurve", ref });
  if (!(g.gainDb >= GAIN_DB_MIN && g.gainDb <= GAIN_DB_MAX)) out.push({ code: "gainRange", ref });
  for (let i = 0; i < g.envelope.length; i++) {
    const p = g.envelope[i];
    if (!isInt(p.at) || p.at < 0 || p.at > length || !(p.db >= GAIN_DB_MIN && p.db <= GAIN_DB_MAX)) out.push({ code: "envelopeRange", ref });
    if (i > 0 && g.envelope[i - 1].at > p.at) out.push({ code: "envelopeOrder", ref });
  }
}

/**
 * 回傳問題清單（空 = 合法）。ctx 可省略：省略時不檢查「媒體 / 音訊來源存在」與離線（純結構檢查）。
 * 離線（srcOut 超過 proxy 幀數）是合法狀態，但剪輯函式不該製造它，所以這裡也列出來。
 */
export function validateSequence(seq: SequenceV2, ctx?: SeqCtx): SequenceIssue[] {
  const out: SequenceIssue[] = [];
  if (!isInt(seq.fps.num) || !isInt(seq.fps.den) || seq.fps.num <= 0 || seq.fps.den <= 0) out.push({ code: "fps" });
  if (seq.sampleRate !== SEQ_SAMPLE_RATE) out.push({ code: "sampleRate" });
  const ids = new Set<string>();
  const seen = (id: string) => {
    if (!id || ids.has(id)) out.push({ code: "duplicateId", ref: id });
    ids.add(id);
  };
  const placed = placeVideo(seq);
  const videoClipIds = new Set<string>();
  for (const p of placed) {
    const it = p.item;
    seen(it.id);
    if (it.kind === "gap") {
      if (!isInt(it.length) || it.length < 1) out.push({ code: "gapLength", ref: it.id });
      continue;
    }
    videoClipIds.add(it.id);
    if (!isInt(it.srcIn) || !isInt(it.srcOut) || it.srcIn < 0 || it.srcOut <= it.srcIn) out.push({ code: "clipRange", ref: it.id });
    if (ctx) {
      const m = ctx.media(it.mediaId);
      if (!m) out.push({ code: "unknownMedia", ref: it.id });
      else if (m.frames != null && it.srcOut > m.frames) out.push({ code: "offline", ref: it.id });
    }
    checkGain(it.audio, placedSampleLength(p, seq.fps), it.id, out);
  }
  const laneIds = new Set<string>();
  const audioIds = new Set<string>();
  for (const lane of seq.audioLanes) {
    if (!lane.id || laneIds.has(lane.id)) out.push({ code: "duplicateLaneId", ref: lane.id });
    laneIds.add(lane.id);
    if (!isAudioRole(lane.role)) out.push({ code: "role", ref: lane.id });
    if (!(lane.gainDb >= GAIN_DB_MIN && lane.gainDb <= GAIN_DB_MAX)) out.push({ code: "gainRange", ref: lane.id });
    let prevEnd = -Infinity;
    let prevStart = -Infinity;
    for (const c of lane.clips) {
      seen(c.id);
      audioIds.add(c.id);
      if (!isInt(c.start) || !isInt(c.length) || !isInt(c.srcIn) || c.start < 0 || c.length < 1) out.push({ code: "audioClipRange", ref: c.id });
      if (c.start < prevStart) out.push({ code: "unsorted", ref: c.id });
      else if (c.start < prevEnd) out.push({ code: "overlap", ref: c.id });
      prevStart = c.start;
      prevEnd = Math.max(prevEnd, c.start + c.length);
      if (ctx) {
        const ok = c.source.type === "media" ? ctx.media(c.source.mediaId) : ctx.audioMedia(c.source.audioId);
        if (!ok) out.push({ code: "unknownSource", ref: c.id });
      }
      checkGain(c, c.length, c.id, out);
    }
  }
  for (const it of seq.video) {
    if (it.kind !== "clip" || it.audio.detachedTo === undefined) continue;
    // 分離出去的原音還在軌上時，片段原音必須靜音，不然渲染會出兩份
    if (!audioIds.has(it.audio.detachedTo) || it.audio.enabled) out.push({ code: "detachedTo", ref: it.id });
  }
  for (const lane of seq.audioLanes) {
    for (const c of lane.clips) if (c.detachedFrom !== undefined && !videoClipIds.has(c.detachedFrom)) out.push({ code: "detachedFrom", ref: c.id });
  }
  return out;
}
