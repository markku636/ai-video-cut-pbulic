// 序列預覽播放器（docs/editor-m2-design.md §8.1、§13 M2.11）。
//
// 序列只是一張 t → (mediaId, k) 的對應表（D13），所以播放器不需要自己的解碼器：仍然是舞台上那一個 <video>（stage/playerRef），
// 這裡只決定「現在該讓它顯示哪支媒體的哪一幀」，以及片段接點上要做什麼：
// - 同一支媒體、來源連續（B 切一刀後的兩段）→ 什麼都不做，元素照播（不 seek 就沒有頓挫）；
// - 同一支媒體、不連續 → seek 到下一段的 srcIn（元素繼續播）；
// - 換媒體 → 切 activeMediaId（<video> 換 src）、綁好之後 seek 再播；
// - 空白 / 停用 / 離線 → 元素暫停、舞台畫黑底浮水印，用共用 ticker 以序列 fps 前進 seqFrame。
//
// 接點「提前」處理：每個 tick 看元素時鐘，離片段出點不到約一個 tick（最多半幀）就先動手，
// 不等 rVFC 回報最後一幀 —— 等它回報時下一幀（片段外的幀）可能已經解好上屏了（M2.11 驗收：播放線永遠不顯示 [srcIn, srcOut) 以外的幀）。
// 接點會頓約 50～150 ms（proxy GOP 要 seek 解碼）；無縫的雙播放器在 M2.later。
//
// playback.frame 維持 M1 語意（作用中媒體的 proxy 幀 k，useRvfc 照寫）；這裡另外寫 playback.seqFrame（序列幀 t）。
// 播放指令（Space、停止、逐幀、範圍播放、J/K/L）在序列模式下由 playerRef 轉給這裡（setSequenceDelegate），
// 旗標關著或在素材空間時 active() 為 false，playerRef 一行 M1 程式都不會繞過來。
import { create } from "zustand";
import { viewSequenceOf } from "../frametimeline/layoutSequence";
import type { Rational, SequenceV2, VideoClipV2 } from "../project/format";
import { subscribeTick, TICK_PRIORITY } from "../preview/ticker";
import { durationFrames, placeVideo, placedAt, type PlacedItem } from "../sequence/map";
import { useEdits } from "../store/edits";
import { playRangeAction, SHUTTLE_STOPPED, toggleAction, usePlayback, type Shuttle } from "../store/playback";
import { selectActiveMedia, useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { effectiveSpace, useTimeline } from "../store/timeline";
import { frameDuration, frameOfMediaTime } from "../video/frames";
import * as P from "./playerRef";

// =============================================================================
// 純函式（sequencePlayer.test.ts 直接測；不碰 store、不碰元素）
// =============================================================================

/** 舞台黑畫面的原因（浮水印文字：空白 / 已停用 / 媒體離線）。 */
export type BlackReason = "gap" | "disabled" | "offline";

export interface ClipTarget {
  kind: "clip";
  /** 要顯示的序列幀。 */
  t: number;
  /** 片段在序列上的 [t0, t1)。 */
  t0: number;
  t1: number;
  index: number;
  clip: VideoClipV2;
  mediaId: string;
  /** t 對應的來源 proxy 幀。 */
  k: number;
}

export interface BlackTarget {
  kind: "black";
  t: number;
  t0: number;
  t1: number;
  index: number;
  reason: BlackReason;
}

export interface EndTarget {
  kind: "end";
  /** 序列總幀數 T（播放線停在 T − 1）。 */
  t: number;
}

export type SeqTarget = ClipTarget | BlackTarget | EndTarget;

/**
 * 媒體的 proxy 幀數：null = 沒有 proxy（離線，舞台沒有東西可播）；undefined = 不知道（純函式測試的預設，視為可播）。
 * 片段的 srcOut 超過 proxy 幀數（proxy 以不同 fps 重建過）也算離線 —— sanitize 保留這種片段並標離線，不能去播它。
 */
export type FramesOf = (mediaId: string) => number | null | undefined;

const ANY_FRAMES: FramesOf = () => undefined;

function lastFrameOf(placed: readonly PlacedItem[]): number {
  return placed.length ? placed[placed.length - 1].t1 : 0;
}

/** 序列幀 t 要顯示什麼。t ≥ T（或空序列）→ end。 */
export function resolveSeqTarget(seq: Pick<SequenceV2, "video">, t: number, placed: readonly PlacedItem[] = placeVideo(seq), framesOf: FramesOf = ANY_FRAMES): SeqTarget {
  const T = lastFrameOf(placed);
  const tt = Math.max(0, Math.floor(t));
  const p = tt < T ? placedAt(placed, tt) : null;
  if (!p) return { kind: "end", t: T };
  const base = { t: tt, t0: p.t0, t1: p.t1, index: p.index };
  if (p.item.kind === "gap") return { kind: "black", reason: "gap", ...base };
  const clip = p.item;
  if (!clip.enabled) return { kind: "black", reason: "disabled", ...base };
  const frames = framesOf(clip.mediaId);
  if (frames === null || (typeof frames === "number" && clip.srcOut > frames)) return { kind: "black", reason: "offline", ...base };
  return { kind: "clip", clip, mediaId: clip.mediaId, k: clip.srcIn + (tt - p.t0), ...base };
}

/**
 * 接點上要做的事：
 * - none：t 不是所在項目的最後一幀（還沒到接點）；
 * - continue：下一個片段跟目前片段是同一支媒體、來源連續（左 srcOut == 右 srcIn）→ 元素照播、不 seek；
 * - seek：下一個片段在已載入的媒體上 → seek 到它的 srcIn；
 * - switch：下一個片段是別支媒體 → 換 src；
 * - black：下一個項目是空白 / 停用 / 離線 → 黑畫面前進；
 * - end：序列結束。
 */
export type BoundaryAction =
  | { kind: "none" }
  | { kind: "continue"; next: ClipTarget }
  | { kind: "seek"; next: ClipTarget }
  | { kind: "switch"; next: ClipTarget }
  | { kind: "black"; next: BlackTarget }
  | { kind: "end"; t: number };

export interface BoundaryOptions {
  placed?: readonly PlacedItem[];
  framesOf?: FramesOf;
  /** 舞台元素上現在載入的媒體（作用中媒體）；沒給 = 目前項目是片段的話就是它的媒體。 */
  loadedMediaId?: string | null;
}

/** 從 `from`（正在離開的項目，可為 null）進入 `next` 要做的事（接點與開播共用）。 */
export function transitionInto(next: SeqTarget, from: SeqTarget | null, loadedMediaId: string | null): Exclude<BoundaryAction, { kind: "none" }> {
  if (next.kind === "end") return { kind: "end", t: next.t };
  if (next.kind === "black") return { kind: "black", next };
  if (from?.kind === "clip" && from.mediaId === next.mediaId && from.k + 1 === next.k && from.t + 1 === next.t) return { kind: "continue", next };
  return next.mediaId === loadedMediaId ? { kind: "seek", next } : { kind: "switch", next };
}

/** 播放中顯示到序列幀 t（的那一幀）時，接點上該做什麼（見 BoundaryAction）。 */
export function nextBoundaryAction(seq: Pick<SequenceV2, "video">, t: number, opts: BoundaryOptions = {}): BoundaryAction {
  const placed = opts.placed ?? placeVideo(seq);
  const framesOf = opts.framesOf ?? ANY_FRAMES;
  const cur = resolveSeqTarget(seq, t, placed, framesOf);
  if (cur.kind === "end") return { kind: "end", t: cur.t };
  if (cur.t < cur.t1 - 1) return { kind: "none" };
  const loaded = opts.loadedMediaId !== undefined ? opts.loadedMediaId : cur.kind === "clip" ? cur.mediaId : null;
  return transitionInto(resolveSeqTarget(seq, cur.t1, placed, framesOf), cur, loaded);
}

/**
 * 從 start 開始、沿著「continue」接起來的一整段連續來源的終點：[start.t, endT) 在序列上、[start.k, endK) 在來源上一一對應。
 * 播放時只需要在 endT 前動手 —— B 切過但沒動過的片段不會在切點上頓一下。
 */
export function contiguousEnd(seq: Pick<SequenceV2, "video">, start: ClipTarget, placed: readonly PlacedItem[] = placeVideo(seq), framesOf: FramesOf = ANY_FRAMES): { endT: number; endK: number } {
  let endT = start.t1;
  // 片段數有限、每步 endT 嚴格變大，迴圈必然結束
  for (;;) {
    const a = nextBoundaryAction(seq, endT - 1, { placed, framesOf, loadedMediaId: start.mediaId });
    if (a.kind !== "continue") break;
    endT = a.next.t1;
  }
  return { endT, endK: start.k + (endT - start.t) };
}

/**
 * 同一個來源幀 (mediaId, k) 在序列裡可能出現好幾次：挑離 near 最近的那一次（沒有就 null）。
 * 用在「別人用 k 做了 seek」（素材空間的指令、M1 的 seek 請求）之後把 seqFrame 對回來。
 */
export function nearestOccurrence(placed: readonly PlacedItem[], mediaId: string, k: number, near: number): number | null {
  let best: number | null = null;
  for (const p of placed) {
    const it = p.item;
    if (it.kind !== "clip" || it.mediaId !== mediaId || k < it.srcIn || k >= it.srcOut) continue;
    const t = p.t0 + (k - it.srcIn);
    if (best === null || Math.abs(t - near) < Math.abs(best - near)) best = t;
  }
  return best;
}

/** 黑畫面前進：從 startT 開始、經過 elapsedMs（牆鐘）之後在第幾幀。1e-6 吸收 30000/1001 的浮點誤差。 */
export function gapFrameAt(startT: number, elapsedMs: number, fps: Rational, rate = 1): number {
  const frames = (Math.max(0, elapsedMs) / 1000) * (fps.num / fps.den) * Math.max(0, rate);
  return startT + Math.floor(frames + 1e-6);
}

/**
 * 接點要提前多少「媒體秒」動手：約 1.2 個 tick 的牆鐘（夾在 8～25 ms），乘播放速度；
 * 上限半幀 —— 片段的最後一幀至少要在畫面上停半幀，60 fps / 2× 播放時才不會把最後一幀整個吃掉。
 */
export function boundaryLeadSec(fps: Rational, rate: number, tickMs: number): number {
  const wall = Math.max(8, Math.min(25, 1.2 * (Number.isFinite(tickMs) ? tickMs : 16.7))) / 1000;
  return Math.min(0.5 * frameDuration(fps), wall * Math.max(0.25, rate));
}

/** 序列幀（可為小數）→ 序列樣本（小數；Web Audio 排程用，不進檔案）。 */
export function seqSampleOfFrame(tf: number, fps: Rational): number {
  return (tf * 48000 * fps.den) / fps.num;
}

// =============================================================================
// 執行期
// =============================================================================

/** 舞台要知道的序列狀態（VideoStage 訂閱：黑畫面浮水印、藏 <video>）。 */
interface SeqStageStore {
  black: BlackReason | null;
}
export const useSeqStage = create<SeqStageStore>(() => ({ black: null }));

/**
 * 序列時鐘（src/audio/preview.ts 訂閱）：視訊為主。影片階段每呈現一幀（rVFC）發一次、黑畫面階段每個 tick 發一次；
 * 接點 seek / 換媒體、暫停、停止時發 playing: false —— A 軌先停，等新片段的第一幀呈現再從那裡接上。
 */
export interface SeqClock {
  playing: boolean;
  /** perfMs 那一刻「畫面上」的序列位置（序列樣本，小數）。 */
  seqSample: number;
  /** performance.now() 時間軸（rVFC 的 expectedDisplayTime）。 */
  perfMs: number;
  rate: number;
}

type ClockListener = (c: SeqClock) => void;
const clockListeners = new Set<ClockListener>();

export function subscribeSeqClock(fn: ClockListener): () => void {
  clockListeners.add(fn);
  return () => clockListeners.delete(fn);
}

function emitClock(c: SeqClock): void {
  for (const fn of clockListeners) {
    try {
      fn(c);
    } catch {
      /* 監聽者出錯不影響播放 */
    }
  }
}

/** 執行期依賴（測試換成假的；預設接 store）。 */
export interface SeqEnv {
  /** 序列模式下要播的序列（隱含序列 = 作用中媒體整段）；不在序列模式回 null。 */
  sequence(): SequenceV2 | null;
  /** 舞台元素上載入的媒體（作用中媒體）。 */
  loadedMediaId(): string | null;
  framesOf: FramesOf;
  /** 換作用中媒體（<video> 換 src）。 */
  activate(mediaId: string): void;
  /** 時間軸的「循環播放」開關與範圍（序列空間裡是序列幀）。 */
  loopRange(): boolean;
  range(): { in: number; out: number } | null;
  now(): number;
}

let viewCache: { stored: SequenceV2 | null; media: unknown; seq: SequenceV2 | null } | null = null;

const defaultEnv: SeqEnv = {
  sequence: () => {
    if (!useSettings.getState().experimental.sequence) return null;
    if (effectiveSpace(useTimeline.getState().space, true) !== "sequence") return null;
    const stored = useEdits.getState().sequence;
    const media = selectActiveMedia(useProject.getState());
    // 隱含序列每次 materialize 都是新物件：依 (stored, 作用中媒體) 的參照快取，播放器才認得「序列沒變」
    if (!viewCache || viewCache.stored !== stored || viewCache.media !== media) viewCache = { stored, media, seq: viewSequenceOf(stored, media) };
    return viewCache.seq;
  },
  loadedMediaId: () => useProject.getState().activeMediaId,
  framesOf: (id) => useProject.getState().media.find((m) => m.id === id)?.proxy?.frames ?? null,
  activate: (id) => useProject.getState().setActive(id),
  loopRange: () => useTimeline.getState().loopRange,
  range: () => useTimeline.getState().range,
  now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()),
};

let env: SeqEnv = defaultEnv;

type Phase = "idle" | "video" | "black" | "switch";

interface RangeState {
  in: number;
  out: number;
  loop: () => boolean;
}

interface SwitchReq {
  target: ClipTarget;
  resume: boolean;
}

/** 量尺用的統計（scripts/measure/seq-playback.mjs 透過 window.__aivcSeq 讀）。 */
export interface SeqPlayerStats {
  /** 序列播放中呈現的幀數。 */
  presented: number;
  /** 呈現了不屬於目前片段、也不屬於剛離開的片段的幀（驗收要求 0）。 */
  outside: number;
  outsideSamples: { t: number; k: number; range: [number, number] }[];
  /** 接點（seek / 換媒體 / 進黑畫面）次數。 */
  boundaries: number;
  /** 接點 seek / 換媒體到新片段第一幀呈現的牆鐘（ms）。 */
  stallsMs: number[];
  /** 黑畫面實際走了多久 vs 應該多久（ms）。 */
  blackMs: { expected: number; actual: number }[];
}

function freshStats(): SeqPlayerStats {
  return { presented: 0, outside: 0, outsideSamples: [], boundaries: 0, stallsMs: [], blackMs: [] };
}

const S = {
  phase: "idle" as Phase,
  /** 使用者的意圖：在播（黑畫面時元素是暫停的，但序列在播）。 */
  playing: false,
  cur: null as ClipTarget | BlackTarget | null,
  /** 影片階段：連續來源的終點（接點）。 */
  endT: 0,
  endK: 0,
  /** 剛離開的片段的來源範圍：seek 還沒落地前元素可能再呈現一兩幀舊的，那些不算「片段外」。 */
  prevRange: null as [number, number] | null,
  blackAnchor: null as { t: number; ms: number; expectedEnd: number } | null,
  switchReq: null as SwitchReq | null,
  /** 換媒體時 Workspace 會發一個 seek(0)（換片 = 播放線歸零）；那一個要吞掉，不然剛 seek 到的 k 被拉回 0。 */
  swallow: null as { afterNonce: number; untilMs: number } | null,
  stallStart: null as number | null,
  /** crossBoundary → enterBlack 的傳遞欄位（黑畫面從哪一刻起算）；只在那一次呼叫期間有值。 */
  blackStartMs: null as number | null,
  origin: null as number | null,
  range: null as RangeState | null,
  shuttle: SHUTTLE_STOPPED as Shuttle,
  unTick: null as (() => void) | null,
  lastTickMs: 0,
  tickMs: 16.7,
  cache: null as { seq: SequenceV2; placed: PlacedItem[]; T: number } | null,
  stats: freshStats(),
};

function placedNow(): { seq: SequenceV2; placed: PlacedItem[]; T: number } | null {
  const seq = env.sequence();
  if (!seq) {
    S.cache = null;
    return null;
  }
  if (!S.cache || S.cache.seq !== seq) {
    const placed = placeVideo(seq);
    S.cache = { seq, placed, T: durationFrames(seq) };
  }
  return S.cache;
}

/** 序列模式作用中（旗標開、序列空間、而且有序列可播）。 */
export function sequenceModeActive(): boolean {
  return placedNow() !== null;
}

/** 序列在播（含黑畫面階段：那時元素是暫停的）。VideoStage 的 playing 鏡射看它。 */
export function sequencePlaying(): boolean {
  return S.playing && S.phase !== "idle";
}

function clampT(t: number, T: number): number {
  return Math.max(0, Math.min(Math.max(0, T - 1), Math.round(Number.isFinite(t) ? t : 0)));
}

/** 目前的序列幀：playback.seqFrame 有值就用；沒有就用 (作用中媒體, k) 第一次出現的位置；都沒有 0。 */
export function seqFrameNow(): number {
  const c = placedNow();
  if (!c) return 0;
  const pb = usePlayback.getState();
  if (typeof pb.seqFrame === "number" && Number.isFinite(pb.seqFrame)) return clampT(pb.seqFrame, c.T);
  const mid = env.loadedMediaId();
  const t = mid ? nearestOccurrence(c.placed, mid, pb.frame, 0) : null;
  return t ?? 0;
}

function setSeqFrame(t: number): void {
  usePlayback.getState().setSeqFrame(t);
}

function setBlack(reason: BlackReason | null): void {
  if (useSeqStage.getState().black !== reason) useSeqStage.setState({ black: reason });
}

function rateNow(): number {
  return S.shuttle.dir > 0 ? S.shuttle.speed : usePlayback.getState().rate;
}

function playEl(el: HTMLVideoElement): void {
  const pb = usePlayback.getState();
  // defaultPlaybackRate：換 src 的載入流程會把 playbackRate 重設成它（M1 applyRate 的同一個坑）
  el.defaultPlaybackRate = pb.rate;
  el.playbackRate = rateNow();
  void el.play().catch((e: unknown) => {
    // 只有自動播放政策擋下才收掉「在播」的意圖；AbortError 是接點上 pause / 換 src 打斷的，接下來自己會再 play
    if ((e as { name?: string } | null)?.name === "NotAllowedError") haltPlayback();
  });
}

function pauseEl(): void {
  const el = P.getPlayer();
  if (el && !el.paused) el.pause();
}

function ensureTick(): void {
  if (S.unTick) return;
  S.lastTickMs = env.now();
  S.unTick = subscribeTick(tick, TICK_PRIORITY.skip);
}

function stopTick(): void {
  S.unTick?.();
  S.unTick = null;
}

function stallClock(): void {
  emitClock({ playing: false, seqSample: 0, perfMs: env.now(), rate: rateNow() });
}

/** 進入一個目標（seek、開播、接點共用）。resume = 進去之後要不要播；boundary = 播放中的接點（計頓挫）。 */
function enter(target: SeqTarget, resume: boolean, boundary: boolean): void {
  const c = placedNow();
  if (!c) return;
  S.blackAnchor = null;
  if (target.kind === "end") atEnd();
  else if (target.kind === "black") enterBlack(target, resume);
  else enterClip(c, target, resume, boundary);
}

function enterBlack(target: BlackTarget, resume: boolean): void {
  if (S.cur?.kind === "clip") S.prevRange = [S.cur.clip.srcIn, S.endK];
  S.cur = target;
  S.phase = "black";
  S.switchReq = null;
  pauseEl();
  setBlack(target.reason);
  setSeqFrame(target.t);
  if (!resume) return;
  const end = Math.min(target.t1, S.range ? S.range.out : Number.POSITIVE_INFINITY);
  S.blackAnchor = { t: target.t, ms: S.blackStartMs ?? env.now(), expectedEnd: end };
  ensureTick();
}

function enterClip(c: { seq: SequenceV2; placed: PlacedItem[] }, target: ClipTarget, resume: boolean, boundary: boolean): void {
  if (S.cur?.kind === "clip" && S.phase === "video") S.prevRange = [S.cur.clip.srcIn, S.endK];
  setCurrentClip(c, target);
  setSeqFrame(target.t);
  if (boundary && resume) S.stallStart = env.now();
  if (S.phase === "switch" && S.switchReq && S.switchReq.target.mediaId === target.mediaId) {
    // 換媒體還沒綁好又來一個同媒體的目標（倒轉轉盤、連續 scrub）：更新目標就好，綁好之後 seek 到最新的那一個。
    // 不能在這裡 seek —— 元素上還是舊的 src
    S.switchReq = { target, resume: resume || S.switchReq.resume };
    return;
  }
  if (target.mediaId !== env.loadedMediaId()) {
    S.phase = "switch";
    S.switchReq = { target, resume };
    pauseEl();
    setBlack(null);
    S.swallow = { afterNonce: usePlayback.getState().seekReq?.nonce ?? 0, untilMs: env.now() + 2000 };
    // activate 一定會改 activeMediaId（上面比過不同）→ React 換 <video> 的 src → setPlayer 叫 onPlayerBound 接手。
    // 不能在這裡當場 seek：store 已經是新媒體，但元素要等 React commit 才換 src，現在 seek 的是舊片
    env.activate(target.mediaId);
    return;
  }
  S.phase = "video";
  S.switchReq = null;
  setBlack(null);
  const el = P.getPlayer();
  if (!el) return;
  const fps = c.seq.fps;
  const shown = !el.seeking && frameOfMediaTime(el.currentTime, fps) === target.k && usePlayback.getState().frame === target.k;
  if (!shown) void P.seekToFrame(target.k);
  if (resume) {
    ensureTick();
    // seek 還在飛時就叫 play：瀏覽器 seek 完直接接著播，比等 rVFC 再 play 少一段頓挫
    if (el.paused) playEl(el);
    else el.playbackRate = rateNow();
  }
}

function finishSwitch(): void {
  const req = S.switchReq;
  const el = P.getPlayer();
  if (!req || !el) return;
  S.switchReq = null;
  S.phase = "video";
  void P.seekToFrame(req.target.k);
  if (req.resume && S.playing) {
    ensureTick();
    playEl(el);
  }
}

function atEnd(): void {
  const c = placedNow();
  if (!c) return;
  if (S.playing && !S.range && env.loopRange() && !env.range() && c.T > 0) {
    // M1：循環開、沒有範圍 → 播到尾巴從頭來（Resolve 在時間軸尾端循環）；A 軌也要從頭排
    stallClock();
    enter(resolveSeqTarget(c.seq, 0, c.placed, env.framesOf), true, true);
    return;
  }
  haltPlayback();
  if (S.cur?.kind === "black") setSeqFrame(Math.max(0, c.T - 1));
  else if (S.cur?.kind === "clip") setSeqFrame(Math.max(0, Math.min(c.T - 1, S.endT - 1)));
}

/** 停下一切動作（不移動播放線）。 */
function haltPlayback(): void {
  const wasPlaying = S.playing;
  S.playing = false;
  S.stallStart = null;
  S.blackAnchor = null;
  if (S.switchReq) S.switchReq.resume = false;
  stopTick();
  pauseEl();
  if (S.range) {
    S.range = null;
    usePlayback.getState().setLoop(null);
  }
  if (S.shuttle.dir !== 0) {
    S.shuttle = SHUTTLE_STOPPED;
    const pb = usePlayback.getState();
    if (pb.shuttle.dir !== 0) pb.setShuttle(SHUTTLE_STOPPED);
    const el = P.getPlayer();
    if (el) el.playbackRate = pb.rate;
  }
  if (wasPlaying) stallClock();
  usePlayback.getState().setPlaying(false);
}

/**
 * 接點動手。blackStartMs：如果下一個是黑畫面，它從牆鐘的哪一刻開始算（performance.now 時間軸）——
 * 我們是在最後一幀「剛上屏」或「快結束」時就動手，黑畫面若從動手的那一刻算，每個接點都會讓序列時鐘慢上最多一幀。
 */
function crossBoundary(blackStartMs?: number): void {
  const c = placedNow();
  if (!c || !S.cur) return;
  const endT = S.cur.kind === "clip" ? S.endT : S.blackAnchor?.expectedEnd ?? S.cur.t1;
  if (S.range && endT >= S.range.out) {
    rangeEnded();
    return;
  }
  const a = nextBoundaryAction(c.seq, endT - 1, { placed: c.placed, framesOf: env.framesOf, loadedMediaId: env.loadedMediaId() });
  if (S.cur.kind === "black" && S.blackAnchor) {
    const expected = ((endT - S.blackAnchor.t) * frameDuration(c.seq.fps) * 1000) / Math.max(0.25, rateNow());
    S.stats.blackMs.push({ expected, actual: env.now() - S.blackAnchor.ms });
  }
  switch (a.kind) {
    case "none":
      // 版面在播放中被改過（剪輯）：重算接點就好
      resync();
      return;
    case "continue":
      enter(a.next, true, false);
      return;
    case "end":
      atEnd();
      return;
    case "black":
      // 進黑畫面不會頓（ticker 從接點接著走），A 軌不必停
      S.stats.boundaries++;
      S.blackStartMs = blackStartMs ?? null;
      enter(a.next, true, false);
      S.blackStartMs = null;
      return;
    case "seek":
    case "switch":
      S.stats.boundaries++;
      stallClock();
      enter(a.next, true, true);
      return;
  }
}

function rangeEnded(): void {
  const r = S.range;
  const c = placedNow();
  if (!r || !c) return;
  if (r.loop()) {
    stallClock();
    enter(resolveSeqTarget(c.seq, r.in, c.placed, env.framesOf), true, true);
    return;
  }
  const last = Math.max(r.in, r.out - 1);
  haltPlayback();
  // 停在範圍內的最後一幀，而不是範圍外的第一幀（M1 範圍播放同規則）
  enter(resolveSeqTarget(c.seq, last, c.placed, env.framesOf), false, false);
}

function tick(): void {
  const now = env.now();
  const dt = now - S.lastTickMs;
  S.lastTickMs = now;
  if (dt > 0 && dt < 200) S.tickMs = S.tickMs * 0.8 + dt * 0.2;
  const c = placedNow();
  if (!c) {
    deactivate();
    return;
  }
  if (S.shuttle.dir < 0) {
    reverseShuttleTick(dt);
    return;
  }
  if (!S.playing) {
    stopTick();
    return;
  }
  if (S.phase === "video" && S.cur?.kind === "clip") tickVideo(c.seq.fps, S.cur);
  else if (S.phase === "black" && S.cur?.kind === "black" && S.blackAnchor) tickBlack(c.seq.fps, S.blackAnchor, now);
}

/** 影片階段：時鐘離接點（或範圍出點）不到提前量就動手。seek 還在飛、元素還沒開始播時不判斷。 */
function tickVideo(fps: Rational, cur: ClipTarget): void {
  const el = P.getPlayer();
  if (!el || el.seeking || (el.paused && !el.ended)) return;
  const lead = boundaryLeadSec(fps, el.playbackRate || 1, S.tickMs);
  const rangeOutK = S.range && S.range.out < S.endT ? cur.k + (S.range.out - cur.t) : null;
  const limitSec = ((rangeOutK ?? S.endK) * fps.den) / fps.num;
  if (!el.ended && el.currentTime + lead < limitSec) return;
  if (rangeOutK !== null) rangeEnded();
  else crossBoundary(env.now() + (Math.max(0, limitSec - el.currentTime) * 1000) / Math.max(0.25, el.playbackRate || 1));
}

/** 黑畫面階段：牆鐘換成序列幀往前走，發時鐘給 A 軌（音樂在空白上照常出聲）。 */
function tickBlack(fps: Rational, anchor: { t: number; ms: number; expectedEnd: number }, now: number): void {
  const t = gapFrameAt(anchor.t, now - anchor.ms, fps, rateNow());
  if (t >= anchor.expectedEnd) {
    crossBoundary();
    return;
  }
  setSeqFrame(t);
  const tf = anchor.t + ((now - anchor.ms) / 1000) * (fps.num / fps.den) * rateNow();
  emitClock({ playing: true, seqSample: seqSampleOfFrame(tf, fps), perfMs: now, rate: rateNow() });
}

let reverseAcc = 0;
function reverseShuttleTick(dt: number): void {
  const c = placedNow();
  if (!c) return;
  const frameMs = frameDuration(c.seq.fps) * 1000;
  reverseAcc += Math.max(0, dt) * S.shuttle.speed;
  const n = Math.floor(reverseAcc / frameMs);
  if (n <= 0) return;
  reverseAcc -= n * frameMs;
  const target = seqFrameNow() - n;
  if (target <= 0) {
    enter(resolveSeqTarget(c.seq, 0, c.placed, env.framesOf), false, false);
    S.shuttle = SHUTTLE_STOPPED;
    usePlayback.getState().setShuttle(SHUTTLE_STOPPED);
    stopTick();
    return;
  }
  enter(resolveSeqTarget(c.seq, target, c.placed, env.framesOf), false, false);
}

/**
 * rVFC 每呈現一幀（VideoStage 的 useRvfc 回呼）。k 在目前的連續來源範圍內 → 換算 seqFrame、發時鐘；
 * 剛 seek 過來、元素還在呈現舊片段的幀 → 忽略；都不是 → 不是我們 seek 的（素材空間指令 / M1 seek 請求）→ 用最近的出現位置對回 seqFrame。
 */
export function onPresentedFrame(k: number, md: { mediaTime: number; expectedDisplayTime?: number } | null): void {
  const c = placedNow();
  if (!c || S.phase === "switch") return;
  if (S.phase === "black") {
    // 元素暫停、舞台塗黑；React 把 <video> 藏起來之前若又上屏一幀片段外的幀，量尺要看得到
    if (S.playing && S.prevRange && (k < S.prevRange[0] || k >= S.prevRange[1])) noteOutside(k, S.prevRange);
    return;
  }
  const cur = S.cur;
  if (cur?.kind === "clip" && cur.mediaId === env.loadedMediaId()) {
    const inCur = k >= cur.clip.srcIn && k < S.endK;
    const inPrev = !!S.prevRange && k >= S.prevRange[0] && k < S.prevRange[1];
    // 接點 seek 還沒落地：同一支媒體的新舊片段來源範圍重疊時，舊片段的幀也會「落在新片段裡」——
    // 只認 seek 目標附近的幀（落點是 k + 0.5 幀，第一個呈現的就是 k）
    const ambiguous = S.stallStart !== null && inPrev && (k < cur.k || k > cur.k + SETTLE_FRAMES);
    if (inCur && !ambiguous) {
      presentedInClip(c.seq.fps, cur, k, md);
      return;
    }
    if (inPrev) return;
    if (S.playing && S.phase === "video") {
      noteOutside(k, [cur.clip.srcIn, S.endK]);
      // 播放中 seek 還沒落地前的舊幀：不去改 seqFrame（等新片段的幀）
      if (S.stallStart !== null) return;
    }
  }
  adoptExternalSeek(c, k);
}

/**
 * 連續來源（或範圍）的最後一幀剛上屏 → 立刻動手，不等 tick。
 * 為什麼 tick 的提前量不夠（M2.11 量尺實測）：WebView2 的 currentTime 是每個事件迴圈更新一次的「官方播放位置」，
 * 會落後實際上屏的幀；只靠 rAF 看時鐘，序列尾巴暫停時曾經多呈現一幀片段外的幀。rVFC 在最後一幀上屏的當下就叫，
 * 離下一幀（片段外）還有整整一幀的時間。代價是最後一幀在畫面上停的時間變成 seek 的時間（反正接點本來就會頓）。
 * 回 true = 已經處理掉接點（呼叫端不要再發時鐘：發了會讓 A 軌以為還在播）。
 */
function lastFramePresented(fps: Rational, cur: ClipTarget, k: number, md: { mediaTime: number; expectedDisplayTime?: number } | null): boolean {
  const rangeOutK = S.range && S.range.out < S.endT ? cur.k + (S.range.out - cur.t) : null;
  if (k < (rangeOutK ?? S.endK) - 1) return false;
  if (rangeOutK !== null) {
    rangeEnded();
    return true;
  }
  const el = P.getPlayer();
  const shownAt = md?.expectedDisplayTime ?? env.now();
  crossBoundary(shownAt + (frameDuration(fps) * 1000) / Math.max(0.25, el?.playbackRate || 1));
  return true;
}

function noteOutside(k: number, range: [number, number]): void {
  S.stats.outside++;
  if (S.stats.outsideSamples.length < 20) S.stats.outsideSamples.push({ t: usePlayback.getState().seqFrame ?? -1, k, range });
}

/** 接點 seek 落地的判定窗（幀）：落點之後這幾幀內出現的才算新片段的幀。 */
const SETTLE_FRAMES = 8;

function presentedInClip(fps: Rational, cur: ClipTarget, k: number, md: { mediaTime: number; expectedDisplayTime?: number } | null): void {
  setSeqFrame(cur.t + (k - cur.k));
  S.prevRange = null;
  if (!S.playing) return;
  if (S.phase === "video" && lastFramePresented(fps, cur, k, md)) return;
  S.stats.presented++;
  if (S.stallStart !== null) {
    S.stats.stallsMs.push(env.now() - S.stallStart);
    S.stallStart = null;
  }
  const el = P.getPlayer();
  const mediaTime = md?.mediaTime ?? (k * fps.den) / fps.num;
  const tf = cur.t + (mediaTime * fps.num) / fps.den - cur.k;
  emitClock({ playing: true, seqSample: seqSampleOfFrame(tf, fps), perfMs: md?.expectedDisplayTime ?? env.now(), rate: el?.playbackRate || 1 });
}

/** 不是我們 seek 的幀（素材空間指令、M1 的 seek 請求）：用離目前 seqFrame 最近的出現位置對回來。 */
function adoptExternalSeek(c: { seq: SequenceV2; placed: PlacedItem[] }, k: number): void {
  const mid = env.loadedMediaId();
  if (!mid) return;
  const t = nearestOccurrence(c.placed, mid, k, seqFrameNow());
  if (t === null) return;
  const target = resolveSeqTarget(c.seq, t, c.placed, env.framesOf);
  if (target.kind !== "clip") return;
  setCurrentClip(c, target);
  if (S.phase === "idle") S.phase = "video";
  setSeqFrame(t);
}

function setCurrentClip(c: { seq: SequenceV2; placed: PlacedItem[] }, target: ClipTarget): void {
  S.cur = target;
  const end = contiguousEnd(c.seq, target, c.placed, env.framesOf);
  S.endT = end.endT;
  S.endK = end.endK;
}

/** 目前畫面上的序列位置（小數幀）與覆蓋它的 V1 項目（A0 增益預覽用）；不在影片階段回 null。 */
export function seqVideoPosition(): { seq: SequenceV2; placed: readonly PlacedItem[]; tf: number; el: HTMLVideoElement } | null {
  const c = placedNow();
  const el = P.getPlayer();
  const cur = S.cur;
  if (!c || !el || S.phase !== "video" || cur?.kind !== "clip") return null;
  const fps = c.seq.fps;
  // 播放中的時鐘是連續的：第 k 幀佔 [k/fps, (k+1)/fps)，所以位置就是 currentTime·fps（不扣 seek 用的 +0.5）
  const kf = (el.currentTime * fps.num) / fps.den;
  const tf = Math.max(cur.t0, Math.min(S.endT, cur.t + (kf - cur.k)));
  return { seq: c.seq, placed: c.placed, tf, el };
}

// ---- 給 playerRef（setSequenceDelegate）與 VideoStage 的入口 ----

/** 序列空間的 seek（playback.seekSeq → VideoStage → 這裡）。播放中 seek 會接著播（Premiere / Resolve 拖播放線時的行為）。 */
export function seekSequenceFrame(t: number): void {
  const c = placedNow();
  if (!c) return;
  if (S.range && (t < S.range.in || t >= S.range.out)) {
    S.range = null;
    usePlayback.getState().setLoop(null);
  }
  const tt = clampT(t, c.T);
  stallClockIfPlaying();
  enter(resolveSeqTarget(c.seq, tt, c.placed, env.framesOf), S.playing, S.playing);
}

function stallClockIfPlaying(): void {
  if (S.playing) stallClock();
}

export function sequencePlay(): void {
  const c = placedNow();
  if (!c || c.T <= 0) return;
  let t = seqFrameNow();
  // 停在最後一幀時從頭來，不然按了沒反應像壞掉（M1 play 同規則）
  if (t >= c.T - 1) t = 0;
  S.origin = t;
  S.playing = true;
  usePlayback.getState().setPlaying(true);
  enter(resolveSeqTarget(c.seq, t, c.placed, env.framesOf), true, false);
}

export function sequencePause(): void {
  haltPlayback();
}

export function sequenceTogglePlay(): void {
  const tl = useTimeline.getState();
  const t = seqFrameNow();
  switch (toggleAction({ shuttleDir: S.shuttle.dir, rangePlaying: S.range !== null, playing: S.playing, loopRange: tl.loopRange, range: tl.range, frame: t })) {
    case "stopShuttle":
    case "stopRange":
    case "pause":
      haltPlayback();
      return;
    case "playRangeFromHere":
      if (tl.range) sequencePlayRange(tl.range.in, tl.range.out, { loop: () => useTimeline.getState().loopRange, from: t });
      return;
    case "play":
      sequencePlay();
  }
}

export function sequenceTogglePlayRange(): void {
  const range = useTimeline.getState().range;
  const act = playRangeAction(S.range ? { in: S.range.in, out: S.range.out } : null, range);
  if (act === "stop") haltPlayback();
  else if (act === "play" && range) sequencePlayRange(range.in, range.out, { loop: () => useTimeline.getState().loopRange });
}

export function sequencePlayRange(inT: number, outT: number, opts: { loop?: boolean | (() => boolean); from?: number; transient?: boolean } = {}): () => void {
  const c = placedNow();
  if (!c || c.T <= 0) return () => {};
  haltPlayback();
  const a = clampT(Math.min(inT, outT), c.T);
  const b = Math.max(a + 1, Math.min(c.T, Math.max(inT, outT)));
  const loopOpt = opts.loop;
  const loop = typeof loopOpt === "function" ? loopOpt : () => loopOpt === true;
  const from = opts.from == null ? a : Math.max(a, Math.min(b - 1, Math.round(opts.from)));
  S.range = { in: a, out: b, loop };
  // 暫態播放（播選取的片段）不寫 playback.loop：那個欄位只是 UI 訊號（傳輸列亮燈 + 時間軸範圍淡底），
  // 真正的控制狀態是 S.range。使用者沒標範圍，就不該看起來像標了。
  if (!opts.transient) usePlayback.getState().setLoop({ in: a, out: b });
  S.origin = from;
  S.playing = true;
  usePlayback.getState().setPlaying(true);
  enter(resolveSeqTarget(c.seq, from, c.placed, env.framesOf), true, false);
  const handle = S.range;
  return () => {
    if (S.range === handle) haltPlayback();
  };
}

/** 停止：停下一切；正在動的時候才回到開播點（M1 stop 同規則）。 */
export function sequenceStop(): void {
  const moving = S.playing || S.shuttle.dir !== 0;
  const origin = S.origin;
  haltPlayback();
  if (moving && origin != null) seekSequenceFrame(origin);
}

export function sequenceStep(delta: number): Promise<number> {
  const c = placedNow();
  if (!c) return Promise.resolve(0);
  const target = clampT(seqFrameNow() + Math.round(delta), c.T);
  haltPlayback();
  enter(resolveSeqTarget(c.seq, target, c.placed, env.framesOf), false, false);
  return Promise.resolve(target);
}

/** J/K/L：前進用 playbackRate 播序列（接點照常處理）；倒退暫停元素、ticker 逐幀往回 seek（跨片段 / 空白也行）。 */
export function sequenceApplyShuttle(sh: Shuttle): void {
  const wasActive = S.shuttle.dir !== 0;
  if (sh.dir === 0) {
    if (!wasActive) return;
    S.shuttle = SHUTTLE_STOPPED;
    haltPlayback();
    return;
  }
  if (!wasActive && !S.playing) S.origin = seqFrameNow();
  if (S.range) {
    S.range = null;
    usePlayback.getState().setLoop(null);
  }
  S.shuttle = sh;
  if (sh.dir > 0) {
    const el = P.getPlayer();
    if (S.playing && el && S.phase === "video") {
      el.playbackRate = sh.speed;
      return;
    }
    S.playing = true;
    usePlayback.getState().setPlaying(true);
    const c = placedNow();
    if (!c) return;
    let t = seqFrameNow();
    if (t >= c.T - 1) t = 0;
    enter(resolveSeqTarget(c.seq, t, c.placed, env.framesOf), true, false);
    return;
  }
  // 倒退：沒有聲音、逐幀 seek
  if (S.playing) {
    S.playing = false;
    stallClock();
  }
  pauseEl();
  usePlayback.getState().setPlaying(false);
  reverseAcc = 0;
  S.lastTickMs = env.now();
  ensureTick();
}

/**
 * 元素綁好新的 src（playerRef.setPlayer 叫）：序列播放器正在換媒體的話，接著 seek 到新片段的 k、需要就播。
 */
export function onPlayerBound(): void {
  if (S.phase !== "switch" || !S.switchReq) return;
  if (env.loadedMediaId() !== S.switchReq.target.mediaId) return;
  finishSwitch();
}

/** 換媒體是序列播放器自己發起的（playerRef.setPlayer 據此不去重置轉盤 / 開播點）。 */
export function sequenceSwitching(): boolean {
  return S.phase === "switch" && S.switchReq !== null;
}

/**
 * 換媒體之後 Workspace 會 seek(0)；那一個請求要吞掉（回 true = VideoStage 不要去 seek）。
 * 只吞「換媒體之後的第一個、而且是 0 的」請求，2 秒內有效：之後使用者自己按 Home 仍然照做。
 */
export function consumeSeekReq(req: { frame: number; nonce: number } | null): boolean {
  const sw = S.swallow;
  if (!req || !sw) return false;
  if (env.now() > sw.untilMs) {
    S.swallow = null;
    return false;
  }
  if (req.nonce > sw.afterNonce && req.frame === 0) {
    S.swallow = null;
    return true;
  }
  return false;
}

/** 離開序列模式（旗標關、切到素材空間、序列消失）：停下序列自己的機制，元素留給 M1。 */
export function deactivate(): void {
  const had = S.phase !== "idle" || S.playing || S.unTick !== null;
  if (S.playing) stallClock();
  S.playing = false;
  S.phase = "idle";
  S.cur = null;
  S.switchReq = null;
  S.blackAnchor = null;
  S.stallStart = null;
  S.prevRange = null;
  stopTick();
  setBlack(null);
  if (S.range) {
    S.range = null;
    usePlayback.getState().setLoop(null);
  }
  if (S.shuttle.dir !== 0) S.shuttle = SHUTTLE_STOPPED;
  if (had) pauseEl();
}

/**
 * 序列變了（剪輯、換空間進來）：依目前的 seqFrame 重新對一次。播放中而且畫面上的幀仍然屬於同一段 → 只重算接點；
 * 否則 seek 到新的對應（例如正在播的片段被刪掉了）。
 */
export function resync(): void {
  const c = placedNow();
  if (!c) {
    deactivate();
    return;
  }
  if (S.phase === "switch") return;
  const target = resolveSeqTarget(c.seq, seqFrameNow(), c.placed, env.framesOf);
  if (keepsShownFrame(c, target)) return;
  if (S.playing) stallClock();
  enter(target, S.playing, S.playing);
}

/**
 * 序列變了、但畫面上的東西沒變（同媒體同一幀、或同一段空白）：只更新記帳，不 seek、不斷音 ——
 * 播放中拖推桿、改別的片段時，每一步都 seek 一次會讓畫面一直頓。
 */
function keepsShownFrame(c: { seq: SequenceV2; placed: PlacedItem[] }, target: SeqTarget): boolean {
  const cur = S.cur;
  if (target.kind === "black") {
    if (cur?.kind !== "black" || S.phase !== "black" || target.index !== cur.index) return false;
    S.cur = target;
    if (S.blackAnchor) S.blackAnchor.expectedEnd = Math.min(target.t1, S.range ? S.range.out : Number.POSITIVE_INFINITY);
    return true;
  }
  if (target.kind !== "clip" || target.mediaId !== env.loadedMediaId()) return false;
  const video = S.phase === "video";
  // 剛進序列模式（idle、沒在播）：畫面已經停在這一幀就不必 seek
  if (!video && !(S.phase === "idle" && !S.playing)) return false;
  const el = P.getPlayer();
  const shownK = video && el ? frameOfMediaTime(el.currentTime, c.seq.fps) : usePlayback.getState().frame;
  if (Math.abs(shownK - target.k) > (video ? 1 : 0)) return false;
  setCurrentClip(c, target);
  S.phase = "video";
  setSeqFrame(target.t);
  return true;
}

let installed = false;

/**
 * 掛上序列播放器（VideoStage 掛載時呼叫一次；重複呼叫無害）：
 * 向 playerRef 註冊委派，並在「序列模式開關 / 序列內容 / 作用中媒體」變動時重新對齊。
 */
export function installSequencePlayer(opts: { beforePlay?: () => void } = {}): () => void {
  if (installed) return () => {};
  installed = true;
  P.setSequenceDelegate({
    beforePlay: opts.beforePlay,
    active: sequenceModeActive,
    play: sequencePlay,
    pause: sequencePause,
    togglePlay: sequenceTogglePlay,
    togglePlayRange: sequenceTogglePlayRange,
    stop: sequenceStop,
    step: sequenceStep,
    playRange: sequencePlayRange,
    applyShuttle: sequenceApplyShuttle,
    switching: sequenceSwitching,
    bound: onPlayerBound,
    playing: sequencePlaying,
  });
  let lastSeq = placedNow()?.seq ?? null;
  const onChange = () => {
    const seq = env.sequence();
    if (seq === lastSeq) return;
    const entered = lastSeq === null && seq !== null;
    lastSeq = seq;
    if (!seq) deactivate();
    else if (entered) {
      // 剛進序列模式：seqFrame 以畫面上的 (媒體, k) 為準（素材空間裡可能 seek 過），不沿用舊值
      const c = placedNow();
      const mid = env.loadedMediaId();
      if (c && mid) {
        const pb = usePlayback.getState();
        const t = nearestOccurrence(c.placed, mid, pb.frame, pb.seqFrame ?? 0);
        if (t !== null) setSeqFrame(t);
      }
      // 素材空間正在播的時候切進序列空間：接手（不然片段接點沒人管，會一路播過被剪掉的地方）
      const el = P.getPlayer();
      const adopt = !!el && !el.paused && !el.ended;
      resync();
      if (adopt && placedNow()) {
        S.playing = true;
        S.origin = seqFrameNow();
        ensureTick();
      }
    } else resync();
  };
  const uns = [useSettings.subscribe(onChange), useTimeline.subscribe(onChange), useEdits.subscribe(onChange), useProject.subscribe(onChange)];
  exposeDevStats();
  return () => {
    installed = false;
    uns.forEach((u) => u());
    P.setSequenceDelegate(null);
  };
}

// ---- 量尺 / 測試 ----

export function sequencePlayerStats(): SeqPlayerStats {
  return S.stats;
}

export function resetSequencePlayerStats(): void {
  S.stats = freshStats();
}

function exposeDevStats(): void {
  if (!import.meta.env?.DEV || typeof window === "undefined") return;
  const w = window as unknown as { __aivcSeq?: Record<string, unknown> };
  w.__aivcSeq = { ...(w.__aivcSeq ?? {}), player: { stats: sequencePlayerStats, reset: resetSequencePlayerStats, phase: () => S.phase, seek: seekSequenceFrame } };
}

/** 測試用：換掉 store 依賴並把狀態歸零。 */
export function __setSeqEnv(e: Partial<SeqEnv> | null): void {
  env = e ? { ...defaultEnv, ...e } : defaultEnv;
  S.phase = "idle";
  S.playing = false;
  S.cur = null;
  S.endT = 0;
  S.endK = 0;
  S.prevRange = null;
  S.blackAnchor = null;
  S.switchReq = null;
  S.swallow = null;
  S.stallStart = null;
  S.origin = null;
  S.range = null;
  S.shuttle = SHUTTLE_STOPPED;
  stopTick();
  S.cache = null;
  S.stats = freshStats();
  viewCache = null;
  useSeqStage.setState({ black: null });
}

/** 測試用：直接跑一次 tick（node 沒有 rAF）。 */
export function __tickSequencePlayer(): void {
  tick();
}

/** 目前階段（測試 / 量尺）。 */
export function sequencePhase(): Phase {
  return S.phase;
}
