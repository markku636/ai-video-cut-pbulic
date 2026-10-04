// 序列空間時間軸的命中測試（docs/editor-m2-design.md §9.4）：純函式。
//
// 同一個位置有多個候選時的優先序（寫成測試）：淡化把手 > 片段邊緣 ±6 px > 自動化點 ±5 px > 音量線 ±4 px > 本體。
// 理由：越小、越難瞄準的東西優先 —— 本體佔了整個片段，永遠抓得到；把手只有 8×8，如果被邊緣搶走就再也拖不到。
// 邊緣兩側都是片段時取「游標所在的那一側」（同 M1 hitRangePart 的規則），不然 1 幀片段縮小之後只抓得到一端。
//
// 幾何全部來自 seqGeometry.ts（跟 drawSequence.ts 同一份），「畫在哪」與「點得到哪」不會分岔。
import type { AudioClipV2, ClipGainV2, SequenceV2 } from "../project/format";
import { placedAt, placeVideo, samplesOfFrame, type PlacedItem } from "../sequence/map";
import { frameOfX, xOfFrame, type FrameRange } from "../store/timeline";
import { KEYFRAME_HIT_PX } from "./draw";
import type { TimelineHit } from "./hit";
import { frameAtX, hitRangePart } from "./hit";
import { sampleOfX, type SequenceLayout } from "./layoutSequence";
import { RANGE_HANDLE_HIT_PX } from "./rangeBand";
import { audioClipSpan, envelopePointsXY, fadeEdgesX, fadeHandleRects, gainLinePoints, mapSourceFrame, markerBand, MARKER_HALF_W, polylineYAt, type GainGeom } from "./seqGeometry";

export const EDGE_HIT_PX = 6;
export const ENV_POINT_HIT_PX = 5;
export const GAIN_LINE_HIT_PX = 4;

/** 片段上的哪個部位。V1 片段只會有 body / edgeIn / edgeOut。 */
export type ClipPart = "body" | "edgeIn" | "edgeOut";
export type AudioPart = ClipPart | "fadeIn" | "fadeOut" | "gainLine" | "envPoint";

export type SeqHit =
  | { kind: "ruler"; frame: number }
  | { kind: "marker"; markerId: string; frame: number; name: string }
  | { kind: "range"; part: "in" | "out" | "body" | "empty"; frame: number }
  | { kind: "clip"; clipId: string; frame: number; part: ClipPart }
  | { kind: "gap"; gapId: string; frame: number }
  /** A0 列：V1 片段自帶的原音（邊緣就是 V1 片段的邊緣；已分離的片段只有 body / 邊緣）。 */
  | { kind: "original"; clipId: string; frame: number; sample: number; part: AudioPart; pointIndex?: number }
  | { kind: "audioClip"; clipId: string; laneId: string; frame: number; sample: number; part: AudioPart; pointIndex?: number }
  | { kind: "audioLane"; laneId: string; frame: number }
  | { kind: "tracksHeader"; frame: number }
  /** 追蹤車道：frame 是序列幀，k 是對應的來源幀（這個位置沒有這條 track 的媒體 = null）。 */
  | { kind: "solved"; trackId: string; frame: number; k: number | null }
  | { kind: "user"; trackId: string; frame: number; k: number | null }
  | { kind: "keyframe"; trackId: string; frame: number; k: number }
  | { kind: "reference"; trackId: string; frame: number; k: number }
  | { kind: "dropZone"; frame: number }
  | { kind: "empty"; frame: number };

export interface SeqHitView {
  scrollFrame: number;
  pxPerFrame: number;
  /** 序列總幀數 T（frame 夾在 [0, T−1]）。 */
  frames: number;
}

export interface SeqHitTrack {
  id: string;
  mediaId: string;
  keyframes: readonly number[];
  referenceFrame?: number | null;
}

export interface SeqHitData {
  seq: SequenceV2;
  placed?: readonly PlacedItem[];
  range?: FrameRange | null;
  tracks?: readonly SeqHitTrack[];
  /**
   * 這個片段的淡化把手現在抓不抓得到（§9.4「hover 或選取時才出現」）。沒給 = 抓得到：
   * 游標要落在把手上，本來就代表它停在那個片段上（hover），畫面上一定看得到把手。
   */
  fadeHandles?: (clipId: string) => boolean;
}

// ---- 邊緣 ----

export interface EdgeSpan {
  x0: number;
  x1: number;
}

/**
 * 一列裡離 x 最近、在容忍內的片段邊緣。平手時：
 * 1. 取「本體在游標那一側」的邊（游標在接點左邊 → 左片段的出點；右邊 → 右片段的入點；剛好在接點上 → 右片段，同 [t0, t1) 半開）；
 * 2. 同一個片段的兩端平手（片段比兩倍容忍還窄）→ 看游標在片段中點哪一側。
 * 回傳 spans 的索引與部位。
 */
export function pickEdge(x: number, spans: readonly EdgeSpan[], tolPx = EDGE_HIT_PX): { index: number; part: "edgeIn" | "edgeOut" } | null {
  let best: { index: number; part: "edgeIn" | "edgeOut"; d: number } | null = null;
  const better = (cand: { index: number; part: "edgeIn" | "edgeOut"; d: number }): boolean => {
    if (!best) return true;
    if (cand.d < best.d - 1e-9) return true;
    if (cand.d > best.d + 1e-9) return false;
    const sideOk = (c: typeof cand) => (c.part === "edgeIn" ? x >= spans[c.index].x0 : x <= spans[c.index].x1);
    const cs = sideOk(cand);
    const bs = sideOk(best);
    if (cs !== bs) return cs;
    if (cand.index === best.index) {
      const mid = (spans[cand.index].x0 + spans[cand.index].x1) / 2;
      return (x < mid) === (cand.part === "edgeIn");
    }
    // 兩個不同片段、兩邊都在游標那一側（x 剛好在接點上）：右邊的片段（入點）贏
    return cand.part === "edgeIn";
  };
  spans.forEach((sp, index) => {
    const dIn = Math.abs(x - sp.x0);
    const dOut = Math.abs(x - sp.x1);
    if (dIn <= tolPx) {
      const c = { index, part: "edgeIn" as const, d: dIn };
      if (better(c)) best = c;
    }
    if (dOut <= tolPx) {
      const c = { index, part: "edgeOut" as const, d: dOut };
      if (better(c)) best = c;
    }
  });
  const b = best as { index: number; part: "edgeIn" | "edgeOut"; d: number } | null;
  return b ? { index: b.index, part: b.part } : null;
}

// ---- 音訊部位（A0 原音與 A1…An 共用）----

interface AudioPartInput {
  x: number;
  y: number;
  geom: GainGeom;
  /** 片段在螢幕上的 x 範圍（不裁切）。 */
  x0: number;
  x1: number;
  handles: boolean;
  /** 已分離的原音：增益 / 淡化不在這裡，只剩本體。 */
  inert?: boolean;
}

/** 游標已知在片段本體範圍內、而且沒有抓到邊緣時：淡化把手之外的部位（把手在 pickAudioPart 先判）。 */
function audioBodyPart(p: AudioPartInput): { part: AudioPart; pointIndex?: number } {
  if (p.inert) return { part: "body" };
  let bestI = -1;
  let bestD = Infinity;
  envelopePointsXY(p.geom).forEach((pt, i) => {
    if (Math.abs(pt.x - p.x) > ENV_POINT_HIT_PX || Math.abs(pt.y - p.y) > ENV_POINT_HIT_PX) return;
    const d = Math.hypot(pt.x - p.x, pt.y - p.y);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  });
  if (bestI >= 0) return { part: "envPoint", pointIndex: bestI };
  const ly = polylineYAt(gainLinePoints(p.geom), p.x);
  if (Math.abs(ly - p.y) <= GAIN_LINE_HIT_PX) return { part: "gainLine" };
  return { part: "body" };
}

function fadeHandleAt(p: AudioPartInput): "fadeIn" | "fadeOut" | null {
  if (!p.handles || p.inert) return null;
  const { xFadeInEnd, xFadeOutStart } = fadeEdgesX(p.geom);
  const r = fadeHandleRects(p.x0, p.x1, p.geom.top, xFadeInEnd, xFadeOutStart);
  const inside = (q: { x: number; y: number; w: number; h: number }) => p.x >= q.x && p.x <= q.x + q.w && p.y >= q.y && p.y <= q.y + q.h;
  const inIn = inside(r.fadeIn);
  const inOut = inside(r.fadeOut);
  if (inIn && inOut) return Math.abs(p.x - (r.fadeIn.x + r.fadeIn.w / 2)) <= Math.abs(p.x - (r.fadeOut.x + r.fadeOut.w / 2)) ? "fadeIn" : "fadeOut";
  return inIn ? "fadeIn" : inOut ? "fadeOut" : null;
}

// ---- 各列 ----

function v1EdgeSpans(placed: readonly PlacedItem[], view: SeqHitView): { spans: EdgeSpan[]; items: PlacedItem[] } {
  // 空白沒有邊緣可拖（它的長度由兩側片段決定），只有片段參加邊緣競爭
  const items = placed.filter((p) => p.item.kind === "clip");
  return { items, spans: items.map((p) => ({ x0: xOfFrame(p.t0, view.scrollFrame, view.pxPerFrame), x1: xOfFrame(p.t1, view.scrollFrame, view.pxPerFrame) })) };
}

function hitV1(x: number, frame: number, view: SeqHitView, placed: readonly PlacedItem[]): SeqHit {
  const { spans, items } = v1EdgeSpans(placed, view);
  const edge = pickEdge(x, spans);
  if (edge) return { kind: "clip", clipId: items[edge.index].item.id, frame, part: edge.part };
  const p = placedAt(placed, Math.floor(frameOfX(x, view.scrollFrame, view.pxPerFrame)));
  if (!p) return { kind: "empty", frame };
  return p.item.kind === "gap" ? { kind: "gap", gapId: p.item.id, frame } : { kind: "clip", clipId: p.item.id, frame, part: "body" };
}

function hitA0(x: number, y: number, frame: number, layout: SequenceLayout, view: SeqHitView, data: SeqHitData, placed: readonly PlacedItem[]): SeqHit {
  const seq = data.seq;
  const sample = sampleOfX(x, seq.fps, view);
  const p = placedAt(placed, Math.floor(frameOfX(x, view.scrollFrame, view.pxPerFrame)));
  const top = layout.a0Y + 1;
  const h = layout.a0H - 2;
  // 把手先判（只在游標所在的片段上）：優先序最高
  if (p && p.item.kind === "clip") {
    const S0 = samplesOfFrame(p.t0, seq.fps);
    const input: AudioPartInput = {
      x,
      y,
      geom: { gain: p.item.audio as ClipGainV2, startSample: S0, length: samplesOfFrame(p.t1, seq.fps) - S0, fps: seq.fps, view, top, h },
      x0: xOfFrame(p.t0, view.scrollFrame, view.pxPerFrame),
      x1: xOfFrame(p.t1, view.scrollFrame, view.pxPerFrame),
      handles: data.fadeHandles?.(p.item.id) ?? true,
      inert: p.item.audio.detachedTo !== undefined,
    };
    const fade = fadeHandleAt(input);
    if (fade) return { kind: "original", clipId: p.item.id, frame, sample, part: fade };
    const { spans, items } = v1EdgeSpans(placed, view);
    const edge = pickEdge(x, spans);
    if (edge) return { kind: "original", clipId: items[edge.index].item.id, frame, sample, part: edge.part };
    return { kind: "original", clipId: p.item.id, frame, sample, ...audioBodyPart(input) };
  }
  const { spans, items } = v1EdgeSpans(placed, view);
  const edge = pickEdge(x, spans);
  if (edge) return { kind: "original", clipId: items[edge.index].item.id, frame, sample, part: edge.part };
  if (p && p.item.kind === "gap") return { kind: "gap", gapId: p.item.id, frame };
  return { kind: "empty", frame };
}

function hitLane(x: number, y: number, frame: number, row: { laneId: string; y: number; h: number }, view: SeqHitView, data: SeqHitData): SeqHit {
  const seq = data.seq;
  const lane = seq.audioLanes.find((l) => l.id === row.laneId);
  if (!lane) return { kind: "empty", frame };
  const sample = sampleOfX(x, seq.fps, view);
  const spans = lane.clips.map((c) => audioClipSpan(c, seq.fps, view));
  const under = lane.clips.findIndex((_, i) => x >= spans[i].x0 && x < spans[i].x1);
  const inputOf = (c: AudioClipV2, i: number): AudioPartInput => ({
    x,
    y,
    geom: { gain: c, startSample: c.start, length: c.length, fps: seq.fps, view, top: row.y + 1, h: row.h - 2 },
    x0: spans[i].x0,
    x1: spans[i].x1,
    handles: data.fadeHandles?.(c.id) ?? true,
  });
  const hit = (c: AudioClipV2, part: AudioPart, pointIndex?: number): SeqHit =>
    pointIndex === undefined ? { kind: "audioClip", clipId: c.id, laneId: lane.id, frame, sample, part } : { kind: "audioClip", clipId: c.id, laneId: lane.id, frame, sample, part, pointIndex };
  if (under >= 0) {
    const fade = fadeHandleAt(inputOf(lane.clips[under], under));
    if (fade) return hit(lane.clips[under], fade);
  }
  const edge = pickEdge(x, spans);
  if (edge) return hit(lane.clips[edge.index], edge.part);
  if (under >= 0) {
    const r = audioBodyPart(inputOf(lane.clips[under], under));
    return hit(lane.clips[under], r.part, r.pointIndex);
  }
  return { kind: "audioLane", laneId: lane.id, frame };
}

/** 序列幀 t 對到這條 track 的來源幀（t 所在的片段是這支媒體才有）。 */
function trackK(placed: readonly PlacedItem[], mediaId: string, t: number): number | null {
  const p = placedAt(placed, t);
  return p && p.item.kind === "clip" && p.item.mediaId === mediaId ? p.item.srcIn + (t - p.t0) : null;
}

function hitTrackRow(x: number, y: number, frame: number, row: SequenceLayout["rows"][number], view: SeqHitView, data: SeqHitData, placed: readonly PlacedItem[]): SeqHit {
  const track = data.tracks?.find((t) => t.id === row.trackId);
  if (!track) return { kind: "empty", frame };
  if (y < row.userY) return { kind: "solved", trackId: track.id, frame, k: trackK(placed, track.mediaId, frame) };
  // 菱形：同一個 k 在序列裡可能出現好幾次，取離游標最近的那一次
  let best: { t: number; k: number } | null = null;
  let bestD = KEYFRAME_HIT_PX;
  for (const k of track.keyframes) {
    for (const t of mapSourceFrame(placed, track.mediaId, k)) {
      const d = Math.abs(xOfFrame(t, view.scrollFrame, view.pxPerFrame) - x);
      if (d <= bestD) {
        bestD = d;
        best = { t, k };
      }
    }
  }
  if (best) return { kind: "keyframe", trackId: track.id, frame: best.t, k: best.k };
  const ref = track.referenceFrame;
  if (ref != null) {
    for (const t of mapSourceFrame(placed, track.mediaId, ref)) {
      if (Math.abs(xOfFrame(t, view.scrollFrame, view.pxPerFrame) - x) <= RANGE_HANDLE_HIT_PX) return { kind: "reference", trackId: track.id, frame: t, k: ref };
    }
  }
  return { kind: "user", trackId: track.id, frame, k: trackK(placed, track.mediaId, frame) };
}

/**
 * 標記旗子（畫在尺規下緣、蓋在刻度上）：**要比尺規先判**，不然永遠點不到。
 * 幾何跟 drawSequence 共用 markerBand / MARKER_HALF_W，不會出現「畫在這裡、點在那裡」。
 * 重疊時回**最靠近**的那個（旗子只有 9 px 寬，密集時靠 x 距離決定比靠順序合理）。
 */
function hitMarker(x: number, y: number, layout: SequenceLayout, view: SeqHitView, seq: SequenceV2): SeqHit | null {
  const ms = seq.markers;
  if (!ms?.length) return null;
  const band = markerBand(layout);
  if (y < band.y || y >= band.y + band.h) return null;
  let best: { m: (typeof ms)[number]; d: number } | null = null;
  for (const m of ms) {
    const d = Math.abs(x - Math.round(xOfFrame(m.t, view.scrollFrame, view.pxPerFrame)));
    if (d <= MARKER_HALF_W && (!best || d < best.d)) best = { m, d };
  }
  return best ? { kind: "marker", markerId: best.m.id, frame: best.m.t, name: best.m.name } : null;
}

export function hitSequence(x: number, y: number, layout: SequenceLayout, view: SeqHitView, data: SeqHitData): SeqHit {
  const frame = frameAtX(x, view);
  const placed = data.placed ?? placeVideo(data.seq);
  const within = (y0: number, h: number) => h > 0 && y >= y0 && y < y0 + h;
  const marker = hitMarker(x, y, layout, view, data.seq);
  if (marker) return marker;
  if (within(layout.rulerY, layout.rulerH)) return { kind: "ruler", frame };
  if (within(layout.rangeY, layout.rangeH)) return { kind: "range", part: hitRangePart(x, data.range, view), frame };
  if (within(layout.v1Y, layout.v1H)) return hitV1(x, frame, view, placed);
  if (within(layout.a0Y, layout.a0H)) return hitA0(x, y, frame, layout, view, data, placed);
  if (within(layout.tracksHeaderY, layout.tracksHeaderH)) return { kind: "tracksHeader", frame };
  for (const row of layout.rows) if (within(row.y, row.h)) return hitTrackRow(x, y, frame, row, view, data, placed);
  for (const row of layout.lanes) if (within(row.y, row.h)) return hitLane(x, y, frame, row, view, data);
  if (within(layout.dropY, layout.dropH)) return { kind: "dropZone", frame };
  return { kind: "empty", frame };
}

/**
 * 序列命中 → M1 的 TimelineHit（右鍵選單、M1 手勢共用的形狀）。
 * 序列專屬的目標（片段、空白、音軌…）的選單在 M2.12 / M2.15 才有；在那之前一律當成時間軸空白處，選單不會拿到錯的對象。
 * 車道與菱形換成**來源幀 k**：追蹤相關的選單項目（刪關鍵幀、從這裡解算）全部以 k 為鍵。
 */
export function toTimelineHit(hit: SeqHit): TimelineHit {
  switch (hit.kind) {
    case "ruler":
    case "range":
    case "empty":
      return hit;
    // 標記畫在尺規裡：游標與 hover 照尺規處理（不要落到 default 的 empty，那會變成拖曳掃描）
    case "marker":
      return { kind: "ruler", frame: hit.frame };
    case "solved":
    case "user":
      return hit.k === null ? { kind: "empty", frame: hit.frame } : { kind: hit.kind, trackId: hit.trackId, frame: hit.k };
    case "keyframe":
    case "reference":
      return { kind: hit.kind, trackId: hit.trackId, frame: hit.k };
    default:
      return { kind: "empty", frame: hit.frame };
  }
}

/** 游標停在哪個片段上（V1 / A0 / 音訊片段；hover 時才畫淡化把手）。 */
export function hoverClipIdOf(hit: SeqHit | null | undefined): string | null {
  if (!hit) return null;
  return hit.kind === "clip" || hit.kind === "original" || hit.kind === "audioClip" ? hit.clipId : null;
}
