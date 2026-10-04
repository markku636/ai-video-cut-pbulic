// 序列空間的邊緣修剪拖曳（docs/editor-m2-design.md §9.5「拖邊緣」、§10.2 Ctrl+Shift+[ / ]、§13 M2.13）。
//
// 跟 rangeDrag.ts 同一個風格：純函式、每次 update 都從拖曳開始時的 origin 序列重算（無狀態）。
// 為什麼不在拖曳中一步一步 commit：每個 pointermove 都寫進 edits 會洗出幾百筆 undo，Esc 還得靠 undo 還原；
// 這裡的預覽只活在 FrameTimeline 的 ref 裡，放開時才用最後的 delta 走 editSequence 一次（一筆 undo，隱含序列在同一筆實體化），
// Esc 直接丟掉預覽，store 從頭到尾沒被碰過。拖過頭再拖回來，算出來的就是同一個 origin 參照，不會累積誤差。
//
// 單位：V1（片段 / 空白）是整數幀、一律波紋（磁吸，trim.ts 會讓同步鎖軌跟著移）；
// 音訊片段是序列樣本、不波紋，預設吸到幀邊界 S(t)，按住 Alt 才是樣本級（也不吸附目標）。
//
// 吸附開關（view.toggleSnap，Shift+N）也放在這裡：它管的是時間軸拖曳的吸附（修剪與範圍拖曳共用），
// 跟這個模組的吸附目標是同一件事；本機習慣、不進專案檔（同 aivc:tool、aivc:loopRange）。
import { create } from "zustand";
import type { AudioClipV2, AudioLaneV2, Rational, SequenceV2 } from "../project/format";
import type { SeqCtx } from "../sequence/context";
import { itemLength, placedAt, placeVideo, samplesOfFrame, type PlacedItem } from "../sequence/map";
import { clampTrimDelta, trimEdge, type TrimEdge } from "../sequence/trim";
import { timecode } from "../time";
import { frameOfSampleExact } from "./layoutSequence";
import { SNAP_PX, type SnapKind, type SnapTarget } from "./rangeDrag";
import { mapSourceFrame } from "./seqGeometry";

// ---------------------------------------------------------------- 吸附開關

const SNAP_KEY = "aivc:snap";

function readSnap(): boolean {
  try {
    const v = localStorage.getItem(SNAP_KEY);
    // 沒存過 = 開（ai-music-cut 的預設也是開；拖到剪輯點上是最常見的意圖）
    return v == null ? true : v === "1";
  } catch {
    return true;
  }
}

interface SnapStore {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  toggle: () => void;
}

export const useSnap = create<SnapStore>((set, get) => ({
  enabled: readSnap(),
  setEnabled: (on) => {
    try {
      localStorage.setItem(SNAP_KEY, on ? "1" : "0");
    } catch {
      /* 私密視窗 / 沒有 localStorage：只影響這次 session */
    }
    set({ enabled: on });
  },
  toggle: () => get().setEnabled(!get().enabled),
}));

// ---------------------------------------------------------------- 吸附目標

/**
 * - playhead：播放線；edit：剪輯點（V1 內部接縫與音訊片段兩端）；range：範圍端點；keyframe：選中 track 的關鍵幀（對應到序列上）；
 * - bound：序列頭尾（0 與 T 不算剪輯點，提示「頭尾」比較貼近使用者看到的東西，同 M1）。
 */
export type TrimSnapKind = "playhead" | "edit" | "range" | "keyframe" | "bound";

export interface TrimSnapTarget {
  /** 序列幀；音訊片段邊緣可能是小數幀（片段不一定從幀邊界開始）。 */
  frame: number;
  /** 精確的序列樣本（只有音訊片段邊緣有）；沒有 = 幀邊界 S(frame)。 */
  sample?: number;
  kind: TrimSnapKind;
}

export interface TrimSnapSources {
  /** placeVideo(seq) 的結果（呼叫端通常已經算好了）；沒給就現算。 */
  placed?: readonly PlacedItem[];
  playhead?: number | null;
  range?: { in: number; out: number } | null;
  /** 選中 track 的關鍵幀（來源 k）：透過對應表換成序列幀，同一個 k 用兩次就有兩個目標。 */
  keyframes?: { mediaId: string; frames: readonly number[] } | null;
}

/**
 * 序列空間的吸附目標，依位置排序。同一個位置只留第一個出現的種類（播放線 > 剪輯點 > 範圍 > 關鍵幀 > 頭尾）：
 * 播放線優先的理由同 rangeDrag.collectSnapTargets（使用者剛剛在看的東西）。
 * 位置用序列樣本當鍵：音訊片段邊緣剛好在幀邊界上時，跟 V1 剪輯點是同一個點，不要出現兩個。
 * 不排除「正在拖的那一端」：拖過頭再拖回來會吸回原位（delta 0），這是想要的。
 */
export function collectTrimSnapTargets(seq: SequenceV2, src: TrimSnapSources = {}): TrimSnapTarget[] {
  const placed = src.placed ?? placeVideo(seq);
  const T = placed.length ? placed[placed.length - 1].t1 : 0;
  const out: { t: TrimSnapTarget; key: number }[] = [];
  const seen = new Set<number>();
  const add = (kind: TrimSnapKind, frame: number, sample?: number) => {
    if (!Number.isFinite(frame) || frame < 0) return;
    // 音訊片段可以比 V1 長（墊樂比影片長）：它的尾端在 T 之後仍然是有意義的目標（把 V1 延長到音樂結束）；其他目標夾在 [0, T]
    if (sample === undefined && frame > T) return;
    const key = sample ?? samplesOfFrame(frame, seq.fps);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ t: sample === undefined ? { frame, kind } : { frame, sample, kind }, key });
  };
  if (src.playhead != null && Number.isFinite(src.playhead)) add("playhead", Math.round(src.playhead));
  for (let i = 1; i < placed.length; i++) add("edit", placed[i].t0);
  for (const lane of seq.audioLanes) {
    for (const c of lane.clips) {
      add("edit", frameOfSampleExact(c.start, seq.fps), c.start);
      add("edit", frameOfSampleExact(c.start + c.length, seq.fps), c.start + c.length);
    }
  }
  if (src.range) {
    add("range", src.range.in);
    add("range", src.range.out);
  }
  if (src.keyframes) for (const k of src.keyframes.frames) for (const t of mapSourceFrame(placed, src.keyframes.mediaId, k)) add("keyframe", t);
  add("bound", 0);
  add("bound", T);
  return out.sort((a, b) => a.key - b.key).map((x) => x.t);
}

/** 最近的吸附目標（容忍 snapPx 以內）；等距取先出現的（已排序 → 較早的位置）。規則同 rangeDrag.nearestSnap。 */
export function nearestTrimSnap(pos: number, targets: readonly TrimSnapTarget[], pxPerFrame: number, snapPx = SNAP_PX): TrimSnapTarget | null {
  if (!(pxPerFrame > 0)) return null;
  const tol = snapPx / pxPerFrame;
  let best: TrimSnapTarget | null = null;
  let bestD = tol;
  for (const t of targets) {
    const d = Math.abs(t.frame - pos);
    if (d <= bestD && (best === null || d < bestD)) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

/**
 * 序列空間的範圍拖曳也吸剪輯點（M1 的 rangeDrag 只認得 playhead / shot / keyframe / bound）：
 * 剪輯點換成 "shot"（序列空間沒有鏡頭帶，這個種類在這裡就是「時間軸上的切點」，FrameTimeline 的提示改寫成「剪輯點」）；
 * 範圍端點不給（拖的就是範圍自己）；範圍只能落在整數幀，音訊片段邊緣四捨五入到幀，去重保留先出現的。
 */
export function rangeSnapTargetsOf(targets: readonly TrimSnapTarget[]): SnapTarget[] {
  const KIND: Record<Exclude<TrimSnapKind, "range">, SnapKind> = { playhead: "playhead", edit: "shot", keyframe: "keyframe", bound: "bound" };
  const byFrame = new Map<number, SnapTarget>();
  const order: Exclude<TrimSnapKind, "range">[] = ["playhead", "edit", "keyframe", "bound"];
  for (const kind of order) {
    for (const t of targets) {
      if (t.kind !== kind) continue;
      const frame = Math.round(t.frame);
      if (!byFrame.has(frame)) byFrame.set(frame, { frame, kind: KIND[kind] });
    }
  }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

// ---------------------------------------------------------------- 拖曳

/** 拖的是哪一端：V1 項目（V1 列或 A0 原音列的邊緣都是它）或某條音軌上的音訊片段。 */
export type TrimTarget = { kind: "v1"; id: string; edge: TrimEdge } | { kind: "audio"; id: string; laneId: string; edge: TrimEdge };

export interface TrimDrag {
  target: TrimTarget;
  /** 拖曳開始時的序列（隱含序列 = 畫出來的那份實體化檢視）；每次 update 都從它重算，Esc 就是回到它。 */
  origin: SequenceV2;
  /** 按下時的小數序列幀。 */
  anchorRaw: number;
  /** 被拖那一端在拖曳開始時的位置：V1 = 序列幀、音訊片段 = 序列樣本。 */
  edgeAt: number;
}

/** 為什麼拖不動：找不到（序列在按下之後被換掉）或音軌鎖定。 */
export type TrimRefusal = "notFound" | "locked";

export type BeginTrimResult = { ok: true; drag: TrimDrag } | { ok: false; reason: TrimRefusal };

function findAudio(seq: SequenceV2, laneId: string, id: string): { lane: AudioLaneV2; clip: AudioClipV2 } | null {
  const lane = seq.audioLanes.find((l) => l.id === laneId);
  const clip = lane?.clips.find((c) => c.id === id);
  return lane && clip ? { lane, clip } : null;
}

export function beginTrimDrag(seq: SequenceV2, target: TrimTarget, anchorRaw: number): BeginTrimResult {
  if (target.kind === "v1") {
    const p = placeVideo(seq).find((x) => x.item.id === target.id);
    if (!p) return { ok: false, reason: "notFound" };
    return { ok: true, drag: { target, origin: seq, anchorRaw, edgeAt: target.edge === "in" ? p.t0 : p.t1 } };
  }
  const f = findAudio(seq, target.laneId, target.id);
  if (!f) return { ok: false, reason: "notFound" };
  // 鎖定的軌：trimEdge 會擲 locked；在按下時就拒絕，游標與提示才能在拖之前告訴使用者
  if (f.lane.locked) return { ok: false, reason: "locked" };
  return { ok: true, drag: { target, origin: seq, anchorRaw, edgeAt: target.edge === "in" ? f.clip.start : f.clip.start + f.clip.length } };
}

/** 被夾住的原因（tooltip）：min = 長度下限（V1 1 幀、音訊 1 樣本）；source = 素材頭尾（或幀數未知不能延長）；neighbor = 碰到同軌相鄰的音訊片段。 */
export type TrimLimit = "min" | "source" | "neighbor";

export interface TrimUpdateContext {
  pxPerFrame: number;
  /** 空陣列 = 不吸附（吸附關、或按住 Alt）。 */
  targets: readonly TrimSnapTarget[];
  snapPx?: number;
  /** 媒體幀數、音訊來源長度（夾住延長量）；沒有時 V1 不能往外延長、音訊片段不能往外長。 */
  ctx?: SeqCtx;
  /** Alt：不吸附；音訊片段改成樣本級（不吸到幀邊界）。 */
  free?: boolean;
}

export interface TrimResult {
  /** 預覽用的序列；delta 為 0 時就是 origin 同一個參照。 */
  seq: SequenceV2;
  unit: "frame" | "sample";
  /** 實際套用的量（邊緣往後移多少；V1 幀 / 音訊樣本）。 */
  delta: number;
  /** 夾住前想要的量。 */
  requested: number;
  /** 吸到的目標；被夾住或沒有移動時為 null（不然提示會說吸到了、邊緣卻不在那裡）。 */
  snap: TrimSnapTarget | null;
  /** 被拖那一端在「拖曳前的時間軸」上現在的位置（小數序列幀）：吸附指示線畫在這裡，也就是游標底下。 */
  edgeFrame: number;
  limit: TrimLimit | null;
}

/** 每 1 序列幀幾個樣本（小數；29.97 fps 是 1601.6）。 */
function samplesPerFrame(seq: SequenceV2): number {
  return (seq.sampleRate * seq.fps.den) / seq.fps.num;
}

/** 開頭往後（requested > delta）或結尾往前（requested < delta）被擋 = 長度下限；反方向被擋才是素材 / 鄰居。 */
function shrinkBlocked(edge: TrimEdge, requested: number, delta: number): boolean {
  return edge === "in" ? requested > delta : requested < delta;
}

function v1Limit(seq: SequenceV2, target: TrimTarget, requested: number, delta: number): TrimLimit | null {
  if (requested === delta) return null;
  // 空白沒有素材，只會碰到長度下限
  const isGap = seq.video.find((x) => x.id === target.id)?.kind === "gap";
  return shrinkBlocked(target.edge, requested, delta) || isGap ? "min" : "source";
}

function audioLimit(drag: TrimDrag, requested: number, delta: number, ctx: SeqCtx | undefined): TrimLimit | null {
  if (requested === delta) return null;
  const { origin, target } = drag;
  if (shrinkBlocked(target.edge, requested, delta)) return "min";
  // 不管鄰居時（波紋模式的夾法）能不能走得更遠：能 = 是同軌相鄰的片段擋住的
  return clampTrimDelta(origin, target.id, target.edge, requested, ctx, { ripple: true }) !== delta ? "neighbor" : "source";
}

/** 夾住、產生預覽、決定要不要回報吸附（被夾住或沒移動時不回報：提示說吸到了、邊緣卻不在那條線上會誤導）。 */
function resultOf(drag: TrimDrag, requested: number, s: TrimSnapTarget | null, uc: TrimUpdateContext): Omit<TrimResult, "unit" | "edgeFrame" | "limit"> {
  const { origin, target } = drag;
  // `|| 0`：來源入點夾在 0 時 clamp 會算出 −0，tooltip 會印成「−0」
  const delta = clampTrimDelta(origin, target.id, target.edge, requested, uc.ctx) || 0;
  return {
    seq: delta === 0 ? origin : trimEdge(origin, target.id, target.edge, delta, uc.ctx),
    delta,
    requested,
    snap: s && delta === requested && delta !== 0 ? s : null,
  };
}

function updateV1Trim(drag: TrimDrag, moved: number, uc: TrimUpdateContext): TrimResult {
  // 保留按下時游標與邊緣的距離（邊緣命中有 ±6 px 容忍）：邊緣跟著游標的「位移」走，不會一按下就跳到游標底下
  const pos = drag.edgeAt + moved;
  const s = !uc.free && uc.targets.length ? nearestTrimSnap(pos, uc.targets, uc.pxPerFrame, uc.snapPx) : null;
  const r = resultOf(drag, (s ? Math.round(s.frame) : Math.round(pos)) - drag.edgeAt, s, uc);
  return { ...r, unit: "frame", edgeFrame: drag.edgeAt + r.delta, limit: v1Limit(drag.origin, drag.target, r.requested, r.delta) };
}

function updateAudioTrim(drag: TrimDrag, moved: number, uc: TrimUpdateContext): TrimResult {
  const { origin, edgeAt } = drag;
  const fps = origin.fps;
  const sr = origin.sampleRate;
  const posSample = edgeAt + moved * samplesPerFrame(origin);
  let at: number;
  let s: TrimSnapTarget | null = null;
  if (uc.free) at = Math.round(posSample);
  else {
    const posFrame = frameOfSampleExact(posSample, fps, sr);
    s = uc.targets.length ? nearestTrimSnap(posFrame, uc.targets, uc.pxPerFrame, uc.snapPx) : null;
    // 沒吸到目標也吸到幀邊界 S(t)（§9.5「修剪（不波紋），吸附到幀」）：對齊畫面切點是影片剪輯的常態，樣本級要明確按 Alt
    at = s?.sample ?? samplesOfFrame(Math.round(s ? s.frame : posFrame), fps, sr);
  }
  const r = resultOf(drag, at - edgeAt, s, uc);
  return { ...r, unit: "sample", edgeFrame: frameOfSampleExact(edgeAt + r.delta, fps, sr), limit: audioLimit(drag, r.requested, r.delta, uc.ctx) };
}

/** raw：現在游標的小數序列幀。每次都從 drag.origin 重算（無狀態）。 */
export function updateTrimDrag(drag: TrimDrag, raw: number, uc: TrimUpdateContext): TrimResult {
  const moved = raw - drag.anchorRaw;
  return drag.target.kind === "v1" ? updateV1Trim(drag, moved, uc) : updateAudioTrim(drag, moved, uc);
}

/** Esc / 指標被系統搶走：回到拖曳前（預覽從來沒進 store，丟掉就好；回傳 origin 讓呼叫端與測試確認）。 */
export function cancelTrimDrag(drag: TrimDrag): SequenceV2 {
  return drag.origin;
}

/** 放開時要 commit 的修剪；沒有移動（delta 0）回 null（不留空的 undo）。 */
export function trimCommitOf(drag: TrimDrag, res: TrimResult | null): { id: string; edge: TrimEdge; delta: number } | null {
  if (!res || res.delta === 0) return null;
  return { id: drag.target.id, edge: drag.target.edge, delta: res.delta };
}

/** edits store 的 editSequence 形狀（這裡不 import store：純函式模組不該把整個 store 圖拉進來）。 */
export type EditSequenceFn = (label: string, f: (seq: SequenceV2, ctx: SeqCtx) => SequenceV2 | null) => boolean;

/**
 * 放開：用最後的 delta 在「現在的」序列上重做一次 trimEdge（一筆 undo；隱含序列由 editSequence 在同一筆實體化，id 跟預覽一致）。
 * 為什麼不直接把預覽序列寫回去：拖曳中如果有別的東西改了序列（快捷鍵、自動化），整份覆蓋會把那個改動吃掉；
 * 重做一次 trimEdge 只動這一端，而且 trimEdge 自己會再夾一次。回傳有沒有留下一筆 undo。
 */
export function commitTrimDrag(drag: TrimDrag, res: TrimResult | null, editSequence: EditSequenceFn, label: string): boolean {
  const c = trimCommitOf(drag, res);
  if (!c) return false;
  return editSequence(label, (seq, ctx) => trimEdge(seq, c.id, c.edge, c.delta, ctx));
}

// ---------------------------------------------------------------- tooltip

export interface TrimTipInfo {
  target: TrimTarget;
  unit: "frame" | "sample";
  delta: number;
  /** V1 片段：修剪後的來源入點（開頭）或出點（結尾，不含），proxy 幀 k；空白與音訊片段為 null。 */
  sourceFrame: number | null;
  mediaId: string | null;
  /** 修剪後的長度：V1 幀 / 音訊樣本。 */
  length: number;
  snap: TrimSnapKind | null;
  limit: TrimLimit | null;
}

/** tooltip 要的數字（字串在 FrameTimeline 組，才能 t()）：「修剪開頭 −12 幀｜來源入點 00:00:02:12｜長度 …」。 */
export function trimTipInfo(drag: TrimDrag, res: TrimResult): TrimTipInfo {
  const base = { target: drag.target, unit: res.unit, delta: res.delta, snap: res.snap?.kind ?? null, limit: res.limit };
  if (drag.target.kind === "v1") {
    const it = res.seq.video.find((x) => x.id === drag.target.id);
    if (it?.kind === "clip") return { ...base, sourceFrame: drag.target.edge === "in" ? it.srcIn : it.srcOut, mediaId: it.mediaId, length: itemLength(it) };
    return { ...base, sourceFrame: null, mediaId: null, length: it ? itemLength(it) : 0 };
  }
  const f = findAudio(res.seq, drag.target.laneId, drag.target.id);
  return { ...base, sourceFrame: null, mediaId: null, length: f?.clip.length ?? 0 };
}

/** 翻譯函式的形狀（i18n.t / useT()）；由呼叫端傳進來，這個模組才不必 import 語言 store。 */
export type Translate = (zh: string, params?: Readonly<Record<string, string | number>>) => string;

const SNAP_LABEL: Record<TrimSnapKind, (t: Translate) => string> = {
  // 每個字面量都直接寫在 t("…") 裡：check-i18n 只認得這個形狀
  playhead: (t) => t("吸附：播放線"),
  edit: (t) => t("吸附：剪輯點"),
  range: (t) => t("吸附：範圍端點"),
  keyframe: (t) => t("吸附：關鍵幀"),
  bound: (t) => t("吸附：頭尾"),
};

const LIMIT_LABEL: Record<TrimLimit, (t: Translate) => string> = {
  min: (t) => t("已到最短長度"),
  source: (t) => t("已到素材邊界"),
  neighbor: (t) => t("碰到相鄰片段"),
};

export function trimSnapLabel(t: Translate, kind: TrimSnapKind): string {
  return SNAP_LABEL[kind](t);
}

function v1TipHead(t: Translate, info: TrimTipInfo, fps: { seq: Rational; source: Rational }): string {
  const d = formatSignedInt(info.delta);
  const len = timecode(info.length, fps.seq);
  const inEdge = info.target.edge === "in";
  if (info.sourceFrame == null) return inEdge ? t("修剪開頭 {d} 幀｜長度 {len}", { d, len }) : t("修剪結尾 {d} 幀｜長度 {len}", { d, len });
  // 來源時間碼用媒體自己的 fps（M2 序列 fps = proxy fps，但不要在這裡默默假設）
  const tc = timecode(info.sourceFrame, fps.source);
  return inEdge ? t("修剪開頭 {d} 幀｜來源入點 {tc}｜長度 {len}", { d, tc, len }) : t("修剪結尾 {d} 幀｜來源出點 {tc}｜長度 {len}", { d, tc, len });
}

/**
 * 拖曳中的 tooltip（§9.5「修剪開頭 −12 幀｜來源入點 00:00:02:12」＋長度、吸附到什麼、被什麼擋住）。
 * V1 的 delta 是邊緣位移（Premiere 慣例：往前拖是負的），音訊片段換成秒；Alt 樣本級時加註。
 */
export function trimTipText(t: Translate, info: TrimTipInfo, opts: { seqFps: Rational; sourceFps?: Rational | null; sampleRate?: number; free?: boolean }): string {
  const sr = opts.sampleRate ?? 48000;
  let head: string;
  if (info.unit === "frame") head = v1TipHead(t, info, { seq: opts.seqFps, source: opts.sourceFps ?? opts.seqFps });
  else {
    const d = formatSignedSeconds(info.delta, sr);
    const len = (info.length / sr).toFixed(3);
    head = info.target.edge === "in" ? t("修剪開頭 {d} 秒｜長度 {len} 秒", { d, len }) : t("修剪結尾 {d} 秒｜長度 {len} 秒", { d, len });
  }
  const parts = [head];
  if (info.unit === "sample" && opts.free) parts.push(t("樣本級"));
  if (info.snap) parts.push(SNAP_LABEL[info.snap](t));
  if (info.limit) parts.push(LIMIT_LABEL[info.limit](t));
  return parts.join(" · ");
}

/** 游標停在邊緣上（還沒按）的提示：V1 是波紋修剪、音訊片段不波紋；鎖定的軌直接說拖不動。 */
export function trimHoverText(t: Translate, target: TrimTarget, locked: boolean): string {
  if (locked) return t("已鎖定");
  return target.kind === "v1" ? t("拖曳修剪（後面的片段跟著移）；Alt 不吸附") : t("拖曳修剪；Alt＝樣本級、不吸附");
}

/** 帶正負號的整數：「+12」「−12」「0」。用真的減號（U+2212），同 formatGainDb。 */
export function formatSignedInt(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0";
}

/** 樣本 → 帶正負號的秒（3 位小數，ms 解析度）：「+0.250」「−1.000」「0.000」。 */
export function formatSignedSeconds(samples: number, sampleRate = 48000): string {
  const s = Math.abs(samples) / sampleRate;
  const txt = s.toFixed(3);
  if (txt === "0.000") return txt;
  return `${samples > 0 ? "+" : "−"}${txt}`;
}

// ---------------------------------------------------------------- 修剪到播放線（Ctrl+Shift+[ / ]）

export type TrimToPlayheadCheck = { ok: true; clipId: string } | { ok: false; reason: "noSequence" | "noPlayhead" | "notOnClip" | "atEdit" };

/**
 * Ctrl+Shift+[ / ] 能不能做（§10.2「播放線在片段內」）：回傳播放線所在的 V1 片段 id，或為什麼不行（指令層換成 zh 的 why）。
 * 規則與 ops.rippleTrimToPlayhead 一致：播放線要在片段**內部**（剛好在切點上 = 沒東西可修，空白不算片段）。
 */
export function trimToPlayheadCheck(seq: SequenceV2 | null, t: number | null, placed?: readonly PlacedItem[]): TrimToPlayheadCheck {
  if (!seq) return { ok: false, reason: "noSequence" };
  if (t == null || !Number.isFinite(t)) return { ok: false, reason: "noPlayhead" };
  const p = placedAt(placed ?? placeVideo(seq), Math.round(t));
  if (!p || p.item.kind !== "clip") return { ok: false, reason: "notOnClip" };
  if (Math.round(t) <= p.t0) return { ok: false, reason: "atEdit" };
  return { ok: true, clipId: p.item.id };
}
