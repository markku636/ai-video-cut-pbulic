// 序列空間的音訊片段增益手勢（docs/editor-m2-design.md §9.5「拖淡化把手 / 拖音量線 / Alt+點音量線」、§13 M2.15）：
// 淡入淡出把手、音量線（片段增益）、自動化點（新增、拖曳、刪除）。V1 片段的原音（A0 列）與音軌上的音訊片段共用同一套。
//
// 風格同 trimDrag.ts：純函式、每次 update 都從拖曳開始時的 origin 重算（拖過頭再拖回來就是 origin 同一個參照，不累積誤差）；
// 預覽只活在 FrameTimeline 的 ref 裡，放開才 commit 一筆 undo。為什麼不邊拖邊寫 store：拖一條音量線會洗出上百筆「音訊增益」，
// Esc 也得靠 undo 才還原得回來。
//
// commit 寫的是「最後的絕對值」（增益 dB、淡化樣本、整條自動化曲線），不是差量：隱含序列在 editSequence 裡才實體化，
// 實體化出來的片段 id 與預覽用的檢視序列一致（layoutSequence.viewSequenceOf），絕對值套上去結果就一樣。
import { create } from "zustand";
import { GAIN_DB_MAX, GAIN_DB_MIN, type ClipGainV2, type GainPointV2, type Rational, type SequenceV2 } from "../project/format";
import { setEnvelope, setFades, setGain } from "../sequence/audioOps";
import { envelopeDbAt } from "../sequence/envelope";
import { placedSampleLength, placeVideo, samplesOfFrame } from "../sequence/map";
import type { SeqHit } from "./hitSequence";
import { frameOfSampleExact, xOfSample, type SeqView, type SequenceLayout } from "./layoutSequence";
import { gainDbToY, gainYToDb } from "./seqGeometry";

// ---------------------------------------------------------------- 對象

/** 增益手勢的對象：V1 片段的原音（A0 列）或音軌上的音訊片段。 */
export type GainTarget = { kind: "original"; clipId: string } | { kind: "audio"; clipId: string; laneId: string };

export interface GainClipRef {
  gain: ClipGainV2;
  /** 片段在序列上的起點（序列樣本）。V1 原音 = S(t0)。 */
  start: number;
  /** 序列樣本長度。V1 原音 = S(t1) − S(t0)。 */
  length: number;
  /** 音軌鎖定：拖不動（audioOps.mapGains 也會跳過鎖定軌，這裡是讓手勢在按下時就拒絕並講原因）。 */
  locked: boolean;
  /** 原音已分離：聲音在音軌上，A0 這一段沒有增益可以調。 */
  detached: boolean;
}

export function gainClipOf(seq: SequenceV2, target: GainTarget): GainClipRef | null {
  if (target.kind === "original") {
    const p = placeVideo(seq).find((x) => x.item.id === target.clipId);
    if (!p || p.item.kind !== "clip") return null;
    return { gain: p.item.audio, start: samplesOfFrame(p.t0, seq.fps), length: placedSampleLength(p, seq.fps), locked: false, detached: p.item.audio.detachedTo !== undefined };
  }
  const lane = seq.audioLanes.find((l) => l.id === target.laneId) ?? seq.audioLanes.find((l) => l.clips.some((c) => c.id === target.clipId));
  const c = lane?.clips.find((x) => x.id === target.clipId);
  if (!lane || !c) return null;
  return { gain: c, start: c.start, length: c.length, locked: lane.locked, detached: false };
}

export function sameGainTarget(a: GainTarget | null | undefined, b: GainTarget | null | undefined): boolean {
  return !!a && !!b && a.kind === b.kind && a.clipId === b.clipId;
}

/** 命中 → 增益手勢的對象（A0 原音 / 音訊片段）；其他列回 null。 */
export function gainTargetOfHit(hit: SeqHit | null | undefined): GainTarget | null {
  if (!hit) return null;
  if (hit.kind === "original") return { kind: "original", clipId: hit.clipId };
  if (hit.kind === "audioClip") return { kind: "audio", clipId: hit.clipId, laneId: hit.laneId };
  return null;
}

export type GainDragMode = "fadeIn" | "fadeOut" | "gain" | "point";

/**
 * 按下去會開始哪一種增益手勢（hitSequence 已經照 §9.4 的優先序決定了部位）：
 * 淡化把手 → 淡化；自動化點 → 拖點；音量線 → Alt＝新增點再拖、否則拖整條增益。本體 / 邊緣不歸這裡管。
 */
export function gainPressOf(hit: SeqHit | null | undefined, alt: boolean): { target: GainTarget; mode: GainDragMode; pointIndex: number | null; add: boolean } | null {
  const target = gainTargetOfHit(hit);
  if (!target || !hit || (hit.kind !== "original" && hit.kind !== "audioClip")) return null;
  switch (hit.part) {
    case "fadeIn":
    case "fadeOut":
      return { target, mode: hit.part, pointIndex: null, add: false };
    case "envPoint":
      return hit.pointIndex === undefined ? null : { target, mode: "point", pointIndex: hit.pointIndex, add: false };
    case "gainLine":
      return alt ? { target, mode: "point", pointIndex: null, add: true } : { target, mode: "gain", pointIndex: null, add: false };
    default:
      return null;
  }
}

/** 片段所在列的 y 範圍（跟 hitSequence / drawSequence 同一個內縮：列 y+1、高 h−2）。 */
export function gainRowOf(layout: Pick<SequenceLayout, "a0Y" | "a0H" | "lanes">, target: GainTarget): { top: number; h: number } | null {
  if (target.kind === "original") return { top: layout.a0Y + 1, h: layout.a0H - 2 };
  const row = layout.lanes.find((l) => l.laneId === target.laneId);
  return row ? { top: row.y + 1, h: row.h - 2 } : null;
}

// ---------------------------------------------------------------- 數值規則

/** 增益與自動化點都以 0.1 dB 為一格（tooltip 顯示一位小數，存的值跟看到的一致）。 */
export const GAIN_STEP_DB = 0.1;
/** Shift 細調：每像素 0.1 dB（§9.5「Shift 細調 0.1 dB」）。 */
export const FINE_DB_PER_PX = 0.1;
/** 拖到列底下再往下這麼多 px ＝ −∞（靜音）：音量線可視範圍只到 −48 dB，閃避到靜音要有一個到得了的地方。 */
export const SILENCE_PULL_PX = 6;

export function roundDb(db: number): number {
  const v = Math.round(db / GAIN_STEP_DB) * GAIN_STEP_DB;
  // 0.1 的倍數在浮點上會變成 −3.0000000000000004；toFixed 再轉回數字，存進專案檔的值才是乾淨的 −3
  return Math.max(GAIN_DB_MIN, Math.min(GAIN_DB_MAX, Number(v.toFixed(1)) || 0));
}

/** 游標 y → 音量線上的總 dB（片段增益＋自動化）；拖出列底 SILENCE_PULL_PX 以上 = 靜音。 */
export function dragYToDb(y: number, row: { top: number; h: number }): number {
  if (y > row.top + row.h + SILENCE_PULL_PX) return GAIN_DB_MIN;
  return gainYToDb(y, row.top, row.h);
}

/** 樣本吸到幀邊界 S(round(t))；free（Alt）＝樣本級。 */
export function snapSample(sample: number, fps: Rational, free: boolean): number {
  if (free) return Math.round(sample);
  return samplesOfFrame(Math.round(frameOfSampleExact(sample, fps)), fps);
}

// ---------------------------------------------------------------- 拖曳

export interface GainDrag {
  target: GainTarget;
  mode: GainDragMode;
  /** 拖曳開始時的序列（Alt+點新增的點已經在裡面）。 */
  origin: SequenceV2;
  clip: GainClipRef;
  row: { top: number; h: number };
  anchorY: number;
  /** mode = point 時拖哪一點（origin 裡的索引）。 */
  pointIndex: number | null;
  /** Alt+點新增了一點：沒拖動也要 commit（點本身就是這次的編輯）。 */
  created: boolean;
}

export type BeginGainResult = { ok: true; drag: GainDrag } | { ok: false; reason: "notFound" | "locked" | "detached" };

export interface BeginGainInput {
  mode: GainDragMode;
  row: { top: number; h: number };
  y: number;
  pointIndex?: number | null;
  /** Alt+點音量線：在這個序列樣本新增一點（值取曲線在那裡的值，曲線形狀不變；接著拖就是改它）。 */
  addAtSample?: number | null;
  fps: Rational;
  free?: boolean;
}

export function beginGainDrag(seq: SequenceV2, target: GainTarget, input: BeginGainInput): BeginGainResult {
  const clip = gainClipOf(seq, target);
  if (!clip) return { ok: false, reason: "notFound" };
  if (clip.locked) return { ok: false, reason: "locked" };
  if (clip.detached) return { ok: false, reason: "detached" };
  let origin = seq;
  let ref = clip;
  let pointIndex = input.pointIndex ?? null;
  let created = false;
  if (input.mode === "point" && input.addAtSample != null) {
    const at = Math.max(0, Math.min(clip.length, snapSample(input.addAtSample, input.fps, !!input.free) - clip.start));
    const env = clip.gain.envelope;
    const point: GainPointV2 = { at, db: roundDb(envelopeDbAt(env, at)) };
    // 插在同一個 at 的既有點後面：setEnvelope 是穩定排序，新點的索引就是「at ≤ 新點」的點數
    const index = env.filter((p) => p.at <= at).length;
    const next = [...env.slice(0, index), point, ...env.slice(index)];
    origin = setEnvelope(seq, [target.clipId], next);
    const r = gainClipOf(origin, target);
    if (!r) return { ok: false, reason: "notFound" };
    ref = r;
    pointIndex = index;
    created = true;
  }
  if (input.mode === "point" && (pointIndex === null || pointIndex < 0 || pointIndex >= ref.gain.envelope.length)) return { ok: false, reason: "notFound" };
  return { ok: true, drag: { target, mode: input.mode, origin, clip: ref, row: input.row, anchorY: input.y, pointIndex, created } };
}

export interface GainUpdateInput {
  /** 游標所在的小數序列樣本（layoutSequence.sampleOfX）。 */
  sample: number;
  y: number;
  fps: Rational;
  /** Shift：音量 0.1 dB / px 細調。 */
  fine?: boolean;
  /** Alt：時間不吸到幀（樣本級）。 */
  free?: boolean;
}

export type GainTip =
  | { kind: "fadeIn" | "fadeOut"; samples: number }
  | { kind: "gain"; db: number }
  | { kind: "point"; db: number; totalDb: number; at: number };

export interface GainResult {
  seq: SequenceV2;
  /** 編輯後這個片段的增益參數（commit 用的絕對值）。 */
  gain: ClipGainV2;
  tip: GainTip;
}

function withGain(drag: GainDrag, seq: SequenceV2): ClipGainV2 {
  return gainClipOf(seq, drag.target)?.gain ?? drag.clip.gain;
}

export function updateGainDrag(drag: GainDrag, input: GainUpdateInput): GainResult {
  const { clip, origin, target } = drag;
  const g = clip.gain;
  const id = [target.clipId];
  const dy = input.y - drag.anchorY;
  switch (drag.mode) {
    case "fadeIn": {
      const s = snapSample(input.sample, input.fps, !!input.free);
      const fadeIn = Math.max(0, Math.min(clip.length - g.fadeOut, s - clip.start));
      const seq = fadeIn === g.fadeIn ? origin : setFades(origin, id, { fadeIn });
      return { seq, gain: withGain(drag, seq), tip: { kind: "fadeIn", samples: fadeIn } };
    }
    case "fadeOut": {
      const s = snapSample(input.sample, input.fps, !!input.free);
      const fadeOut = Math.max(0, Math.min(clip.length - g.fadeIn, clip.start + clip.length - s));
      const seq = fadeOut === g.fadeOut ? origin : setFades(origin, id, { fadeOut });
      return { seq, gain: withGain(drag, seq), tip: { kind: "fadeOut", samples: fadeOut } };
    }
    case "gain": {
      const delta = input.fine ? -dy * FINE_DB_PER_PX : dragYToDb(input.y, drag.row) - dragYToDb(drag.anchorY, drag.row);
      // 拖出列底 = 靜音（dragYToDb 回 −96）；其他情況照差量平移，按下的位置不會先跳一下
      const db = input.y > drag.row.top + drag.row.h + SILENCE_PULL_PX && !input.fine ? GAIN_DB_MIN : roundDb(g.gainDb + delta);
      const seq = db === g.gainDb ? origin : setGain(origin, id, db);
      return { seq, gain: withGain(drag, seq), tip: { kind: "gain", db } };
    }
    case "point": {
      const i = drag.pointIndex ?? 0;
      const env = g.envelope;
      const p = env[i];
      const lo = i > 0 ? env[i - 1].at : 0;
      const hi = i + 1 < env.length ? env[i + 1].at : clip.length;
      const at = Math.max(lo, Math.min(hi, snapSample(input.sample, input.fps, !!input.free) - clip.start));
      const db = input.fine ? roundDb(p.db - dy * FINE_DB_PER_PX) : input.y > drag.row.top + drag.row.h + SILENCE_PULL_PX ? GAIN_DB_MIN : roundDb(dragYToDb(input.y, drag.row) - g.gainDb);
      const seq = at === p.at && db === p.db ? origin : setEnvelope(origin, id, env.map((q, j) => (j === i ? { at, db } : q)));
      return { seq, gain: withGain(drag, seq), tip: { kind: "point", db, totalDb: g.gainDb + db, at } };
    }
  }
}

/** 放開時要 commit 的絕對值；沒有變化（而且不是新增點）回 null。 */
export function gainCommitOf(drag: GainDrag, res: GainResult | null): ClipGainV2 | null {
  if (!res) return drag.created ? drag.clip.gain : null;
  if (res.seq === drag.origin && !drag.created) return null;
  return res.gain;
}

export type EditSequenceFn = (label: string, f: (seq: SequenceV2) => SequenceV2 | null) => boolean;

/** 把增益參數（絕對值）套到序列上的某個片段：只改這個手勢會動到的欄位。 */
export function applyClipGain(seq: SequenceV2, target: GainTarget, mode: GainDragMode, gain: ClipGainV2): SequenceV2 | null {
  if (!gainClipOf(seq, target)) return null;
  const id = [target.clipId];
  switch (mode) {
    case "fadeIn":
    case "fadeOut":
      return setFades(seq, id, { fadeIn: gain.fadeIn, fadeOut: gain.fadeOut });
    case "gain":
      return setGain(seq, id, gain.gainDb);
    case "point":
      return setEnvelope(seq, id, gain.envelope);
  }
}

/** undo 標籤對應（SEQ_EDIT_LABEL 的鍵）。 */
export const GAIN_LABEL_KEY: Record<GainDragMode, "fadeIn" | "fadeOut" | "gain" | "envelope"> = { fadeIn: "fadeIn", fadeOut: "fadeOut", gain: "gain", point: "envelope" };

export function commitGainDrag(drag: GainDrag, res: GainResult | null, editSequence: EditSequenceFn, labels: Record<"fadeIn" | "fadeOut" | "gain" | "envelope", string>): boolean {
  const gain = gainCommitOf(drag, res);
  if (!gain) return false;
  return editSequence(labels[GAIN_LABEL_KEY[drag.mode]], (seq) => applyClipGain(seq, drag.target, drag.mode, gain));
}

// ---------------------------------------------------------------- 自動化點的選取與刪除

export interface EnvPointSelection {
  target: GainTarget;
  index: number;
}

interface EnvPointStore {
  /** 選中的自動化點（焦點 envPoint 時 Delete 刪它）。不存檔、不進 undo：選取是操作狀態。 */
  sel: EnvPointSelection | null;
  select: (sel: EnvPointSelection | null) => void;
}

export const useEnvPointSelection = create<EnvPointStore>((set) => ({
  sel: null,
  select: (sel) => set({ sel }),
}));

/** 選取還指得到存在的點嗎（undo / 刪片段之後可能指到不存在的索引）。 */
export function envPointOf(seq: SequenceV2 | null, sel: EnvPointSelection | null): { clip: GainClipRef; point: GainPointV2 } | null {
  if (!seq || !sel) return null;
  const clip = gainClipOf(seq, sel.target);
  const point = clip?.gain.envelope[sel.index];
  return clip && point ? { clip, point } : null;
}

/** 刪掉一個自動化點（鎖定軌、索引超界回原序列）。 */
export function deleteEnvelopePoint(seq: SequenceV2, sel: EnvPointSelection): SequenceV2 {
  const hit = envPointOf(seq, sel);
  if (!hit || hit.clip.locked) return seq;
  const rest = hit.clip.gain.envelope.filter((_, i) => i !== sel.index);
  // 剩下的點全是 0 dB ＝ 聽起來跟沒有自動化一樣：清成 []，`-c:a copy` 閘門（isUntouched）才會回來。
  // 不整條 simplify：使用者刻意放的共線點（之後要拖）不該因為刪了別的點就消失
  return setEnvelope(seq, [sel.target.clipId], rest.every((p) => p.db === 0) ? [] : rest);
}

/** 選中點在畫面上的位置（FrameTimeline 畫選取圈用；跟 seqGeometry.envelopePointsXY 同一個算式）。 */
export function envPointXY(seq: SequenceV2, layout: Pick<SequenceLayout, "a0Y" | "a0H" | "lanes">, view: SeqView, sel: EnvPointSelection | null): { x: number; y: number } | null {
  const hit = envPointOf(seq, sel);
  const row = sel && gainRowOf(layout, sel.target);
  if (!hit || !row) return null;
  return { x: xOfSample(hit.clip.start + hit.point.at, seq.fps, view), y: gainDbToY(hit.clip.gain.gainDb + hit.point.db, row.top, row.h) };
}

// ---------------------------------------------------------------- 游標與提示

/** hover 在增益部位上的游標：把手 = 左右、音量線 = 上下（Alt＝加點用 copy）、點 = move；鎖定 = not-allowed。 */
export function gainCursorOf(hit: SeqHit | null | undefined, alt: boolean, locked: boolean): string | null {
  const press = gainPressOf(hit, alt);
  if (!press) return null;
  if (locked) return "not-allowed";
  switch (press.mode) {
    case "fadeIn":
    case "fadeOut":
      return "ew-resize";
    case "gain":
      return "ns-resize";
    case "point":
      return press.add ? "copy" : "move";
  }
}
