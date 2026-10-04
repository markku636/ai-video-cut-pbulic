// 序列的 Web Audio 預覽（docs/editor-m2-design.md §8.2 A0 原音、§8.3 A1…An 音軌、§13 M2.16）。
//
// 分工：
// - A0（V1 片段的原音）聲音直接來自舞台的 <video>（跟畫面天然同步），這裡只管「增益 / 淡化 / 自動化 / 閃避 / 靜音」：
//   首選 MediaElementSource → GainNode，用 setValueCurveAtTime 一小段一小段往前排（曲線跟渲染同一份 gainCurve.ts）；
//   元素沒有 CORS（crossOrigin 沒設、或 asset protocol 回應不帶標頭）時 MediaElementSource 會輸出靜音 ——
//   那種情況退回每個 tick 設 element.volume（階梯、上限 1、只是預覽）。
// - A1…An：AudioContext 裡每個片段一個 AudioBufferSourceNode（> 10 分鐘的檔、以及影片檔來源改用 <audio> + MediaElementSource，
//   5 分鐘立體聲 f32 就要 115 MB）→ 片段 GainNode（淡化＋自動化曲線，一次排完整段）→ 軌道 GainNode（推桿、靜音、獨奏）→ master（音量）。
//
// 時鐘：視訊為主（stage/sequencePlayer.ts 的 SeqClock）。每呈現一幀就拿「畫面上的序列位置」跟「Web Audio 排程推算的位置」比，
// 差 > 40 ms 就重排（舊的 5 ms 淡出、新的 5 ms 淡入）；接點 seek / 換媒體時播放器先發 playing: false，這裡整個停掉，
// 等新片段的第一幀出來再從那裡接上 —— 不讓音樂在畫面頓住的 100 ms 裡自己往前跑。
//
// 精度聲明（說明文件也寫）：預覽 ±10 ms、瀏覽器解碼器的 mp3 延遲處理可能跟 ffmpeg 差一個 frame；輸出以渲染為準，
// 要逐樣本確認就用「輸出音訊預覽（WAV）」（aivc audio-mix）。
import { convertFileSrc } from "@tauri-apps/api/core";
import { create } from "zustand";
import type { AudioSourceRefV2, ClipGainV2, SequenceV2 } from "../project/format";
import { subscribeTick, TICK_PRIORITY } from "../preview/ticker";
import { placedAt } from "../sequence/map";
import { useEdits } from "../store/edits";
import { usePlayback } from "../store/playback";
import { useProject } from "../store/project";
import { seqVideoPosition, sequenceModeActive, subscribeSeqClock, type SeqClock } from "../stage/sequencePlayer";
import { A0_BUS_ID, clipGainFactor, declickSamples, laneBusGain, originalGainAt, sampleCurve } from "./gainCurve";

// =============================================================================
// 常數與純函式
// =============================================================================

export const SEQ_SR = 48000;
/** 一次往前排多遠（序列樣本）：10 s；播到剩一半就補下一段。 */
export const PLAN_WINDOW_SAMPLES = 10 * SEQ_SR;
/** 畫面與聲音差超過這麼多就重排（§8.3）。 */
export const DRIFT_RESYNC_MS = 40;
/** 重排、停止、進場的淡化（秒）：5 ms 聽不出淡化，但足以消掉硬切的爆音。 */
export const RAMP_SEC = 0.005;
/** 曲線取樣間距（序列樣本）：240 = 5 ms，跟渲染的 asetnsamples=240 同解析度。 */
export const CURVE_STEP_SAMPLES = 240;
/** 超過這個長度（秒）的來源不整檔解碼成 AudioBuffer，改用 <audio> 元素。 */
export const LONG_SOURCE_SEC = 600;
/** A0 曲線一次排多長（秒）：每個 tick 補到 now + 這個值。 */
const A0_CHUNK_SEC = 0.1;

/** 音訊片段來源的事實（路徑、原生取樣率、長度）。 */
export interface SourceInfo {
  path: string;
  /** 原生取樣率（srcIn 的單位）。 */
  sampleRate: number;
  /** 秒；不知道 = null（保守地走 <audio> 元素，不整檔解碼）。 */
  durationSec: number | null;
  /** 影片檔（分離出來的原音）：一律走元素 —— 不該為了聽聲音把整支影片讀進記憶體。 */
  video: boolean;
}

export type SourceLookup = (ref: AudioSourceRefV2) => SourceInfo | null;

export type SourceRoute = "buffer" | "element";

export function sourceRoute(info: Pick<SourceInfo, "durationSec" | "video">): SourceRoute {
  if (info.video || info.durationSec == null) return "element";
  return info.durationSec > LONG_SOURCE_SEC ? "element" : "buffer";
}

/** 一個要排進 Web Audio 的片段段落（planAudioSources 的結果）。 */
export interface PlannedSource {
  clipId: string;
  laneId: string;
  source: AudioSourceRefV2;
  /** 片段在序列上的起點 / 長度（序列樣本）。 */
  clipStart: number;
  clipLength: number;
  /** 從序列的哪個樣本開始出聲（= max(片段起點, fromSample)）。 */
  startSample: number;
  /** 出聲到哪（不含）= 片段終點：一旦開始就排到片段結束，跨視窗不切段（切段會在接縫留下爆音）。 */
  endSample: number;
  /** startSample 在片段內的位置（序列樣本）。 */
  atOffset: number;
  /** startSample 對應的來源秒數（0 = 音訊串流 start_time；負 = 片段開頭是補的靜音）。 */
  sourceSec: number;
  gain: ClipGainV2;
}

/**
 * [fromSample, fromSample + windowSamples) 內要出聲的片段（M2.16 驗收的純函式）。
 * - 停用的片段不排；靜音軌 / 被獨奏掉的軌**照排** —— 靜音與獨奏在軌道 GainNode 上切，按 M / S 要立刻生效，不能等重排。
 * - 已經在播的片段（起點在 from 之前）從 from 接著排：sourceSec 往後推同樣的量。
 * - 依 startSample 排序，同時開始的依軌道順序。
 */
export function planAudioSources(seq: Pick<SequenceV2, "audioLanes">, fromSample: number, windowSamples: number, sampleRateOf: (ref: AudioSourceRefV2) => number | null | undefined = () => null): PlannedSource[] {
  const from = Math.max(0, fromSample);
  const until = from + Math.max(0, windowSamples);
  const out: (PlannedSource & { lane: number })[] = [];
  seq.audioLanes.forEach((lane, laneIndex) => {
    for (const c of lane.clips) {
      if (!c.enabled || c.length <= 0) continue;
      const end = c.start + c.length;
      if (end <= from || c.start >= until) continue;
      const startSample = Math.max(c.start, from);
      const atOffset = startSample - c.start;
      const sr = sampleRateOf(c.source) || SEQ_SR;
      out.push({
        lane: laneIndex,
        clipId: c.id,
        laneId: lane.id,
        source: c.source,
        clipStart: c.start,
        clipLength: c.length,
        startSample,
        endSample: end,
        atOffset,
        sourceSec: c.srcIn / sr + atOffset / SEQ_SR,
        gain: c,
      });
    }
  });
  out.sort((a, b) => a.startSample - b.startSample || a.lane - b.lane);
  return out.map(({ lane: _lane, ...p }) => p);
}

/** 排程錨點：context 時間 anchorCtx 時聽到的是序列樣本 anchorSeq，之後以 rate 前進。 */
export interface ScheduleAnchor {
  anchorCtx: number;
  anchorSeq: number;
  rate: number;
}

/** 排程推算的序列位置（序列樣本）。 */
export function audioSeqAt(a: ScheduleAnchor, ctxTime: number): number {
  return a.anchorSeq + (ctxTime - a.anchorCtx) * SEQ_SR * a.rate;
}

/** 序列樣本什麼時候（context 時間）會被聽到。 */
export function ctxTimeOfSeq(a: ScheduleAnchor, seqSample: number): number {
  return a.anchorCtx + (seqSample - a.anchorSeq) / SEQ_SR / Math.max(1e-6, a.rate);
}

/**
 * performance.now() 的某一刻，喇叭正在出的是哪個 context 時間（getOutputTimestamp 的換算）：
 * rVFC 的 expectedDisplayTime 是「畫面上出現」的時刻，拿它換成「聲音上出現」的 context 時間才比得了同步。
 */
export function ctxTimeAtPerf(ts: { contextTime?: number; performanceTime?: number }, perfMs: number): number | null {
  if (typeof ts.contextTime !== "number" || typeof ts.performanceTime !== "number" || ts.performanceTime <= 0) return null;
  return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
}

/** 畫面位置減聲音位置（ms，正 = 聲音落後畫面）。 */
export function driftMs(videoSeqSample: number, audioSeqSample: number): number {
  return ((videoSeqSample - audioSeqSample) * 1000) / SEQ_SR;
}

/**
 * 片段 GainNode 的曲線：片段內 [atFrom, clipLength] 的倍率，中途進場（atFrom 超過防爆音長度）時前 RAMP_SEC 從 0 拉上來 ——
 * 從片段中間開始播，第一個樣本不是 0，硬開會爆音。點數上限 100 000（30 分鐘的片段也只要 400 KB）。
 */
export function clipCurve(g: ClipGainV2, clipLength: number, atFrom: number, declick: number, rate = 1): Float32Array {
  const span = Math.max(1, clipLength - atFrom);
  const step = Math.max(CURVE_STEP_SAMPLES, Math.ceil(span / 100_000));
  const ramp = RAMP_SEC * SEQ_SR * Math.max(0.25, rate);
  const midStart = atFrom > declick;
  return sampleCurve((at) => clipGainFactor(g, at, clipLength, 0, declick) * (midStart ? Math.min(1, (at - atFrom) / ramp) : 1), atFrom, clipLength, step);
}

// =============================================================================
// 監聽狀態（獨奏）：不存檔、不進 undo（§3.2「為什麼獨奏不存檔」）
// =============================================================================

interface AudioMonitorStore {
  /** 獨奏中的匯流排 id（lane id 或 "A0"）。 */
  solo: string[];
  /** A0 預覽走哪條路：graph = GainNode；volume = element.volume 退路；none = 還沒接上。 */
  a0Mode: "graph" | "volume" | "none";
  /** 這個 session 裡 asset protocol 的 CORS 失敗過（VideoStage 據此拿掉 crossOrigin 重掛 <video>）。 */
  corsBroken: boolean;
  toggleSolo: (id: string) => void;
  clearSolo: () => void;
}

export const useAudioMonitor = create<AudioMonitorStore>((set) => ({
  solo: [],
  a0Mode: "none",
  corsBroken: false,
  toggleSolo: (id) => set((s) => ({ solo: s.solo.includes(id) ? s.solo.filter((x) => x !== id) : [...s.solo, id] })),
  clearSolo: () => set((s) => (s.solo.length ? { solo: [] } : s)),
}));

export { A0_BUS_ID };

// =============================================================================
// 執行期
// =============================================================================

export interface PreviewDeps {
  createContext(): AudioContext | null;
  sequence(): SequenceV2 | null;
  lookup: SourceLookup;
  solo(): readonly string[];
  master(): { volume: number; muted: boolean };
  loadBuffer(ctx: AudioContext, info: SourceInfo): Promise<AudioBuffer | null>;
  createElement(info: SourceInfo): HTMLAudioElement | null;
  now(): number;
}

interface Voice {
  clipId: string;
  laneId: string;
  gain: GainNode;
  stop(at: number): void;
  /** 元素來源的位置校正（buffer 來源是樣本準的，不需要）。 */
  check?(ctxNow: number): void;
}

interface Session extends ScheduleAnchor {
  seq: SequenceV2;
  voices: Map<string, Voice>;
  plannedUntil: number;
  startedPerf: number;
  /** 暖機結束、錨點確認過了（見 REANCHOR_MS）。 */
  settled: boolean;
}

export interface PreviewStats {
  /** 開始排程的次數（開播、接點之後接上）。 */
  starts: number;
  /** 因為漂移 > 40 ms 重排的次數。 */
  resyncs: number;
  /** 開播暖機結束時重新對錨的次數（不算漂移）。 */
  reanchors: number;
  /** 比對次數（每呈現一幀一次）。 */
  samples: number;
  /** 暖機（開播後 300 ms 內）之後的最大 |漂移|（ms）。 */
  maxAbsDriftMs: number;
  lastDriftMs: number;
  /** 最近 4000 筆漂移（ms），量尺算分位數用。 */
  drifts: number[];
  /** 解碼失敗 / 讀不到的來源路徑。 */
  failed: string[];
}

function freshStats(): PreviewStats {
  return { starts: 0, resyncs: 0, reanchors: 0, samples: 0, maxAbsDriftMs: 0, lastDriftMs: 0, drifts: [], failed: [] };
}

const WARMUP_MS = 300;
/**
 * 暖機結束時偏差超過這個值就重新對錨一次（M2.16 量尺實測）：元素從暫停起步的頭幾幀，rVFC 的時間戳跟音訊輸出都還沒穩，
 * 拿第一幀當錨點會讓整段帶著約 −17 ms（一個 vsync）的固定偏差，60 s 裡再加上時鐘斜率就擦邊 40 ms。
 * 只在開播後做一次：5 ms 淡出淡入發生在音樂剛開始的 300 ms，聽不出來。
 */
const REANCHOR_MS = 5;

/** 取消已排的自動化（進行中的曲線也截斷）；舊 WebView 沒有 cancelAndHoldAtTime 時退回 cancelScheduledValues。 */
function holdAt(p: AudioParam, t: number): void {
  const anyP = p as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  if (typeof anyP.cancelAndHoldAtTime === "function") anyP.cancelAndHoldAtTime(t);
  else {
    p.cancelScheduledValues(t);
    p.setValueAtTime(p.value, t);
  }
}

export class SequenceAudioPreview {
  ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private lanes = new Map<string, GainNode>();
  private session: Session | null = null;
  private buffers = new Map<string, AudioBuffer | null | Promise<AudioBuffer | null>>();
  private elementPool = new Map<string, { el: HTMLAudioElement; node: MediaElementAudioSourceNode; busy: boolean }[]>();
  private a0: { el: HTMLVideoElement; node: MediaElementAudioSourceNode | null; gain: GainNode | null; until: number; live: boolean } | null = null;
  private videoNodes = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  stats: PreviewStats = freshStats();

  constructor(private deps: PreviewDeps) {}

  // ---- context ----

  /** 開播之前（使用者手勢內）叫：建立 / resume AudioContext、接上舞台元素、預先解碼音軌來源。 */
  beforePlay(seqMode: boolean): void {
    if (!seqMode) {
      // 素材空間：A0 若已接進 graph，增益一定要回 1（不然剛剛在序列裡的閃避會把 M1 的播放弄成靜音）
      this.a0Neutral();
      if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
      return;
    }
    const ctx = this.ensureContext();
    if (!ctx) return;
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    this.connectA0();
    const seq = this.deps.sequence();
    if (seq) this.prewarm(seq);
  }

  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const ctx = this.deps.createContext();
    if (!ctx) return null;
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.applyMaster();
    return ctx;
  }

  applyMaster(): void {
    if (!this.ctx || !this.master) return;
    const m = this.deps.master();
    this.master.gain.setTargetAtTime(m.muted ? 0 : Math.max(0, Math.min(1, m.volume)), this.ctx.currentTime, 0.01);
  }

  private laneNode(laneId: string): GainNode | null {
    const ctx = this.ctx;
    if (!ctx || !this.master) return null;
    let g = this.lanes.get(laneId);
    if (!g) {
      g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.master);
      this.lanes.set(laneId, g);
    }
    return g;
  }

  /** 軌道推桿 / 靜音 / 獨奏 → 軌道 GainNode（5 ms 平滑）。 */
  updateBuses(seq: SequenceV2 | null = this.session?.seq ?? this.deps.sequence()): void {
    const ctx = this.ctx;
    if (!ctx || !seq) return;
    const solo = this.deps.solo();
    const alive = new Set<string>();
    for (const lane of seq.audioLanes) {
      alive.add(lane.id);
      this.laneNode(lane.id)?.gain.setTargetAtTime(laneBusGain(lane, solo), ctx.currentTime, RAMP_SEC / 3);
    }
    for (const [id, g] of this.lanes) {
      if (alive.has(id)) continue;
      g.gain.setTargetAtTime(0, ctx.currentTime, RAMP_SEC / 3);
    }
  }

  // ---- 來源 ----

  private prewarm(seq: SequenceV2): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const lane of seq.audioLanes)
      for (const c of lane.clips) {
        const info = this.deps.lookup(c.source);
        if (info && sourceRoute(info) === "buffer") void this.buffer(info);
      }
  }

  private buffer(info: SourceInfo): Promise<AudioBuffer | null> | AudioBuffer | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const hit = this.buffers.get(info.path);
    if (hit !== undefined) return hit;
    const p = this.deps
      .loadBuffer(ctx, info)
      .catch(() => null)
      .then((b) => {
        this.buffers.set(info.path, b);
        if (!b && !this.stats.failed.includes(info.path)) this.stats.failed.push(info.path);
        // 解碼完成時已經在播：把剛剛排不進去的片段補上（從現在的位置接）
        if (b && this.session) this.fill(true);
        return b;
      });
    this.buffers.set(info.path, p);
    return p;
  }

  private element(info: SourceInfo): { el: HTMLAudioElement; node: MediaElementAudioSourceNode; busy: boolean } | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const pool = this.elementPool.get(info.path) ?? [];
    let slot = pool.find((s) => !s.busy);
    if (!slot) {
      const el = this.deps.createElement(info);
      if (!el) return null;
      let node: MediaElementAudioSourceNode;
      try {
        node = ctx.createMediaElementSource(el);
      } catch {
        return null;
      }
      slot = { el, node, busy: false };
      pool.push(slot);
      this.elementPool.set(info.path, pool);
    }
    slot.busy = true;
    return slot;
  }

  // ---- 時鐘 ----

  /** 序列播放器的時鐘（subscribeSeqClock）。 */
  onClock(c: SeqClock): void {
    if (!c.playing) {
      this.stopSession();
      this.a0Silence();
      return;
    }
    // A0 不需要 AudioContext 也要接上（element.volume 退路）
    if (this.a0) this.a0.live = true;
    const ctx = this.ctx;
    const seq = this.deps.sequence();
    if (!ctx || ctx.state !== "running" || !seq) return;
    const tAud = this.ctxTimeAt(c.perfMs);
    const s = this.session;
    if (!s || s.rate !== c.rate) {
      // 改速度（轉盤）是播放中途：時間戳是穩的，不必暖機
      this.startSession(seq, c.seqSample, tAud, c.rate, c.perfMs, !!s);
      return;
    }
    if (s.seq !== seq) {
      // 只有軌道層（推桿 / 靜音）變了：片段陣列參照都沒換 → 調匯流排就好，不必重排（拖推桿時不會一直斷音）
      if (sameClips(s.seq, seq)) {
        s.seq = seq;
        this.updateBuses(seq);
      } else {
        this.startSession(seq, c.seqSample, tAud, c.rate, c.perfMs, s.settled);
        return;
      }
    }
    const d = driftMs(c.seqSample, audioSeqAt(s, tAud));
    this.stats.samples++;
    this.stats.lastDriftMs = d;
    if (!s.settled) {
      if (c.perfMs - s.startedPerf < WARMUP_MS) return;
      s.settled = true;
      if (Math.abs(d) > REANCHOR_MS) {
        this.stats.reanchors++;
        this.startSession(seq, c.seqSample, tAud, c.rate, c.perfMs, true);
        return;
      }
    }
    this.stats.maxAbsDriftMs = Math.max(this.stats.maxAbsDriftMs, Math.abs(d));
    this.stats.drifts.push(d);
    if (this.stats.drifts.length > 4000) this.stats.drifts.splice(0, this.stats.drifts.length - 4000);
    if (Math.abs(d) > DRIFT_RESYNC_MS) {
      this.stats.resyncs++;
      this.startSession(seq, c.seqSample, tAud, c.rate, c.perfMs, true);
      return;
    }
    for (const v of s.voices.values()) v.check?.(ctx.currentTime);
    this.fill(false);
  }

  /** performance 時刻 → 那一刻被聽到的 context 時間。 */
  private ctxTimeAt(perfMs: number): number {
    const ctx = this.ctx!;
    const ts = typeof ctx.getOutputTimestamp === "function" ? ctx.getOutputTimestamp() : {};
    const t = ctxTimeAtPerf(ts, perfMs);
    if (t !== null) return t;
    const latency = (ctx as AudioContext & { outputLatency?: number }).outputLatency ?? ctx.baseLatency ?? 0;
    return ctx.currentTime - latency + (perfMs - this.deps.now()) / 1000;
  }

  /** settled = 錨點取自播放中途的穩定時間戳（重排、改序列、重錨），不需要暖機。 */
  private startSession(seq: SequenceV2, seqSample: number, tAud: number, rate: number, perfMs: number, settled = false): void {
    const ctx = this.ctx!;
    this.stopSession();
    const r = Math.max(0.25, rate);
    // 排程一定要在未來：畫面上的那一刻換算出來常常已經過去幾 ms，就往後挪、序列位置跟著往後推
    const when = Math.max(tAud, ctx.currentTime + 0.02);
    const anchorSeq = seqSample + (when - tAud) * SEQ_SR * r;
    this.session = { seq, anchorCtx: when, anchorSeq, rate: r, voices: new Map(), plannedUntil: anchorSeq, startedPerf: perfMs, settled };
    this.stats.starts++;
    this.updateBuses(seq);
    this.fill(false);
  }

  stopSession(): void {
    const s = this.session;
    this.session = null;
    if (!s || !this.ctx) return;
    const at = this.ctx.currentTime;
    for (const v of s.voices.values()) v.stop(at);
  }

  /** 補排到「現在 + 半個視窗」之外；force = 有來源剛解碼好，從現在的位置把缺的片段補上。 */
  private fill(force: boolean): void {
    const s = this.session;
    const ctx = this.ctx;
    if (!s || !ctx) return;
    const nowSeq = Math.max(s.anchorSeq, audioSeqAt(s, ctx.currentTime + 0.02));
    if (!force && s.plannedUntil > nowSeq + PLAN_WINDOW_SAMPLES / 2) return;
    const planned = planAudioSources(s.seq, nowSeq, PLAN_WINDOW_SAMPLES, (ref) => this.deps.lookup(ref)?.sampleRate);
    for (const p of planned) if (!s.voices.has(p.clipId)) this.schedule(s, p);
    s.plannedUntil = nowSeq + PLAN_WINDOW_SAMPLES;
  }

  private schedule(s: Session, p: PlannedSource): void {
    const ctx = this.ctx!;
    const info = this.deps.lookup(p.source);
    const lane = this.laneNode(p.laneId);
    if (!info || !lane) return;
    const route = sourceRoute(info);
    let buf: AudioBuffer | null = null;
    if (route === "buffer") {
      const b = this.buffer(info);
      if (!b || b instanceof Promise) return; // 還在解碼：解好之後 fill(true) 從當下接上
      buf = b;
    }
    const r = s.rate;
    // 起點落在過去（中途接上）→ 往後挪到「現在 + 一點」，來源位置同步往後推
    let startSample = p.startSample;
    let when = ctxTimeOfSeq(s, startSample);
    const earliest = ctx.currentTime + 0.01;
    if (when < earliest) {
      startSample += (earliest - when) * SEQ_SR * r;
      when = earliest;
    }
    if (startSample >= p.endSample) return;
    let at = startSample - p.clipStart;
    let offsetSec = p.sourceSec + (startSample - p.startSample) / SEQ_SR;
    // 片段開頭是補的靜音（srcIn 為負）：等到來源真的開始才出聲
    if (offsetSec < 0) {
      when += -offsetSec / r;
      at += -offsetSec * SEQ_SR;
      offsetSec = 0;
    }
    if (at >= p.clipLength) return;
    const durSeq = p.clipLength - at;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const declick = declickSamples(s.seq);
    const curve = clipCurve(p.gain, p.clipLength, at, declick, r);
    try {
      gain.gain.setValueCurveAtTime(curve, when, durSeq / SEQ_SR / r);
    } catch {
      gain.gain.setValueAtTime(clipGainFactor(p.gain, at, p.clipLength, 0, declick), when);
    }
    gain.connect(lane);
    const voiceBase = { clipId: p.clipId, laneId: p.laneId, gain };
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = r;
      src.connect(gain);
      try {
        src.start(when, Math.min(offsetSec, buf.duration), durSeq / SEQ_SR);
      } catch {
        return;
      }
      s.voices.set(p.clipId, {
        ...voiceBase,
        stop: (t) => {
          holdAt(gain.gain, t);
          gain.gain.linearRampToValueAtTime(0, t + RAMP_SEC);
          try {
            src.stop(t + RAMP_SEC + 0.002);
          } catch {
            /* 已經停了 */
          }
        },
      });
      return;
    }
    const slot = this.element(info);
    if (!slot) return;
    const { el, node } = slot;
    node.connect(gain);
    el.playbackRate = r;
    try {
      el.currentTime = offsetSec;
    } catch {
      /* 還沒有 metadata：play 之後瀏覽器會套用 */
    }
    const startTimer = setTimeout(() => void el.play().catch(() => {}), Math.max(0, (when - ctx.currentTime) * 1000));
    const endTimer = setTimeout(() => el.pause(), Math.max(0, (when - ctx.currentTime + durSeq / SEQ_SR / r) * 1000) + 50);
    const startCtx = when;
    const startOffset = offsetSec;
    s.voices.set(p.clipId, {
      ...voiceBase,
      stop: (t) => {
        clearTimeout(startTimer);
        clearTimeout(endTimer);
        holdAt(gain.gain, t);
        gain.gain.linearRampToValueAtTime(0, t + RAMP_SEC);
        setTimeout(() => {
          el.pause();
          try {
            node.disconnect(gain);
          } catch {
            /* 已經斷了 */
          }
          slot.busy = false;
        }, (RAMP_SEC + 0.01) * 1000);
      },
      // <audio> 的開播延遲不固定（十幾到幾十 ms）：位置偏超過門檻就直接校正元素時間
      check: (ctxNow) => {
        if (ctxNow < startCtx + 0.1 || el.paused) return;
        const expected = startOffset + (ctxNow - startCtx) * r;
        if (Math.abs(el.currentTime - expected) * 1000 > DRIFT_RESYNC_MS) el.currentTime = expected + 0.02 * r;
      },
    });
  }

  // ---- A0（舞台 <video> 的原音）----

  /** VideoStage 換了 <video> 元素（或第一次掛上）。 */
  attachVideo(el: HTMLVideoElement | null): void {
    if (this.a0?.el === el) return;
    if (this.a0) this.a0Neutral();
    this.a0 = el ? { el, node: null, gain: null, until: 0, live: false } : null;
    useAudioMonitor.setState({ a0Mode: "none" });
    // 已經有 context（之前在序列裡播過）→ 當場接上；沒有的話等第一次在序列模式開播（beforePlay，使用者手勢內）
    if (el && this.ctx) this.connectA0();
  }

  private connectA0(): void {
    const a = this.a0;
    const ctx = this.ctx;
    if (!a || !ctx || a.gain) return;
    // 沒有 CORS 的元素接進 graph 會變成永久靜音（而且接上就拿不下來）：只接 crossOrigin 的元素
    if (a.el.crossOrigin !== "anonymous" || useAudioMonitor.getState().corsBroken) {
      useAudioMonitor.setState({ a0Mode: "volume" });
      return;
    }
    try {
      const node = this.videoNodes.get(a.el) ?? ctx.createMediaElementSource(a.el);
      this.videoNodes.set(a.el, node);
      const gain = ctx.createGain();
      // 注意：不接 master —— 元素自己的 volume / muted 已經套了使用者音量（playerRef installPrefs），再乘一次會變平方
      node.connect(gain);
      gain.connect(ctx.destination);
      a.node = node;
      a.gain = gain;
      useAudioMonitor.setState({ a0Mode: "graph" });
    } catch {
      useAudioMonitor.setState({ a0Mode: "volume" });
    }
  }

  /** 素材空間 / 離開序列模式：原音不受序列增益影響。 */
  a0Neutral(): void {
    const a = this.a0;
    if (!a) return;
    a.live = false;
    if (a.gain && this.ctx) {
      holdAt(a.gain.gain, this.ctx.currentTime);
      a.gain.gain.setValueAtTime(1, this.ctx.currentTime + 0.001);
      a.until = 0;
    } else {
      const pb = this.deps.master();
      a.el.volume = Math.max(0, Math.min(1, pb.volume));
    }
  }

  /** 接點 / 暫停：5 ms 拉到 0，避免聽到切點之後的幾毫秒（§8.2）。 */
  private a0Silence(): void {
    const a = this.a0;
    if (!a) return;
    a.live = false;
    if (a.gain && this.ctx) {
      const t = this.ctx.currentTime;
      holdAt(a.gain.gain, t);
      a.gain.gain.linearRampToValueAtTime(0, t + RAMP_SEC);
      a.until = t + RAMP_SEC;
    } else if (sequenceModeActive()) {
      a.el.volume = 0;
    }
  }

  /** 每個 tick：依畫面上的序列位置補排 A0 曲線（graph）或設 element.volume（退路）。 */
  a0Tick(): void {
    const a = this.a0;
    if (!a || !a.live) return;
    const pos = seqVideoPosition();
    if (!pos || pos.el !== a.el) return;
    const solo = this.deps.solo();
    const spf = (SEQ_SR * pos.seq.fps.den) / pos.seq.fps.num;
    const factorAt = (tf: number) => {
      const p = placedAt(pos.placed, Math.max(0, Math.floor(tf)));
      return p ? originalGainAt(pos.seq, p, tf * spf, solo) : 0;
    };
    if (!a.gain || !this.ctx) {
      const pb = this.deps.master();
      a.el.volume = Math.max(0, Math.min(1, pb.volume * factorAt(pos.tf)));
      return;
    }
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (a.until > now + A0_CHUNK_SEC / 2) return;
    const rate = pos.el.playbackRate || 1;
    const latency = (ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0;
    const start = Math.max(a.until, now + 0.001);
    const fpsV = pos.seq.fps.num / pos.seq.fps.den;
    // 經過 graph 的樣本比喇叭早 outputLatency：context 時間 T 處理的是畫面時鐘 (T − now + latency) 之後的位置
    const tfAt = (ctxT: number) => pos.tf + (ctxT - now + latency) * fpsV * rate;
    const values = sampleCurve((ctxT) => factorAt(tfAt(ctxT)), start, start + A0_CHUNK_SEC, 0.005);
    try {
      if (a.until === 0 || a.until < now) {
        // 從靜音（接點 / 剛開播）接上：先 5 ms 拉到曲線起點，不硬跳
        holdAt(a.gain.gain, start);
        a.gain.gain.linearRampToValueAtTime(values[0], start + RAMP_SEC);
        a.gain.gain.setValueCurveAtTime(values, start + RAMP_SEC + 0.0005, A0_CHUNK_SEC);
        a.until = start + RAMP_SEC + 0.0005 + A0_CHUNK_SEC;
      } else {
        a.gain.gain.setValueCurveAtTime(values, start + 0.0005, A0_CHUNK_SEC);
        a.until = start + 0.0005 + A0_CHUNK_SEC;
      }
    } catch {
      a.until = 0;
    }
  }

  resetStats(): void {
    this.stats = freshStats();
  }

  private levelTap: AnalyserNode | null = null;

  /** 量尺 / 除錯：A0 接線狀態。 */
  a0Debug(): { attached: boolean; crossOrigin: string | null; node: boolean; gain: boolean; live: boolean; gainValue: number | null; sameAsStage: boolean } {
    const a = this.a0;
    const stage = typeof document !== "undefined" ? document.querySelector("[data-testid=video-stage] video") : null;
    return { attached: !!a, crossOrigin: a?.el.crossOrigin ?? null, node: !!a?.node, gain: !!a?.gain, live: !!a?.live, gainValue: a?.gain ? a.gain.gain.value : null, sameAsStage: !!a && a.el === stage };
  }

  /**
   * 量尺用：A0 GainNode 輸出的 RMS（dBFS；沒接上 graph 回 null）。
   * 為什麼要量：沒有 CORS 的元素接進 MediaElementSource 不會報錯，只會「安靜地」輸出 0 —— a0Mode 說 graph 不代表聽得到。
   */
  a0LevelDb(): number | null {
    const a = this.a0;
    const ctx = this.ctx;
    if (!a?.gain || !ctx) return null;
    if (!this.levelTap) {
      this.levelTap = ctx.createAnalyser();
      this.levelTap.fftSize = 2048;
      a.gain.connect(this.levelTap);
    }
    const buf = new Float32Array(this.levelTap.fftSize);
    this.levelTap.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    return rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
  }
}

/** 兩個序列的音訊片段是不是同一批（逐軌比 clips 陣列參照；軌道增加 / 刪除也算不同）。 */
export function sameClips(a: Pick<SequenceV2, "audioLanes">, b: Pick<SequenceV2, "audioLanes">): boolean {
  if (a.audioLanes.length !== b.audioLanes.length) return false;
  return a.audioLanes.every((l, i) => l.id === b.audioLanes[i].id && l.clips === b.audioLanes[i].clips);
}

// ---- 預設依賴（接 store 與瀏覽器）----

export function defaultSourceLookup(ref: AudioSourceRefV2): SourceInfo | null {
  if (ref.type === "audio") {
    const id = ref.audioId;
    const am = useEdits.getState().audioMedia.find((a) => a.id === id);
    if (!am) return null;
    const sr = am.audio?.sampleRate || SEQ_SR;
    const durationSec = am.audio ? am.audio.nSamples / sr : am.probe?.duration_ms ? am.probe.duration_ms / 1000 : null;
    return { path: am.path, sampleRate: sr, durationSec, video: false };
  }
  const id = ref.mediaId;
  const m = useProject.getState().media.find((x) => x.id === id);
  if (!m) return null;
  // proxy 保證 WebView 播得動（原檔可能是 mkv / HEVC）；proxy 音訊以檔案起點為 0，跟 srcIn 的「串流 start_time = 0」差 startUs − videoStartUs（M2.18 之前的已知偏移）
  return { path: m.proxy?.path ?? m.path, sampleRate: m.audio?.sampleRate || SEQ_SR, durationSec: null, video: true };
}

let engine: SequenceAudioPreview | null = null;

function browserDeps(): PreviewDeps {
  return {
    createContext: () => {
      const C = typeof window !== "undefined" ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined;
      if (!C) return null;
      try {
        return new C({ latencyHint: "interactive" });
      } catch {
        return null;
      }
    },
    sequence: () => (sequenceModeActive() ? (useEdits.getState().sequence ?? null) : null),
    lookup: defaultSourceLookup,
    solo: () => useAudioMonitor.getState().solo,
    master: () => {
      const pb = usePlayback.getState();
      return { volume: pb.volume, muted: pb.muted };
    },
    loadBuffer: async (ctx, info) => {
      const res = await fetch(convertFileSrc(info.path));
      if (!res.ok) return null;
      return await ctx.decodeAudioData(await res.arrayBuffer());
    },
    createElement: (info) => {
      if (typeof Audio === "undefined") return null;
      const el = new Audio();
      el.crossOrigin = "anonymous";
      el.preload = "auto";
      el.src = convertFileSrc(info.path);
      return el;
    },
    now: () => performance.now(),
  };
}

/** 單例（VideoStage 掛載時 installAudioPreview）。 */
export function audioPreview(): SequenceAudioPreview | null {
  return engine;
}

/** playerRef 委派的 beforePlay：開播手勢內 resume AudioContext。 */
export function audioBeforePlay(): void {
  engine?.beforePlay(sequenceModeActive());
}

/**
 * 掛上預覽：訂閱序列時鐘、音量、獨奏與序列變動，每個 tick 補 A0 曲線。重複呼叫無害（回傳的解除只有第一次有效）。
 */
export function installAudioPreview(): () => void {
  if (engine) return () => {};
  const e = new SequenceAudioPreview(browserDeps());
  engine = e;
  let unTick: (() => void) | null = null;
  const tick = () => e.a0Tick();
  const uns = [
    subscribeSeqClock((c) => {
      e.onClock(c);
      // A0 曲線只在序列播放中補；停下就退訂（暫停時不燒 CPU）
      if (c.playing && !unTick) {
        unTick = subscribeTick(tick, TICK_PRIORITY.effects);
      } else if (!c.playing && unTick) {
        unTick();
        unTick = null;
      }
    }),
    usePlayback.subscribe((s, p) => {
      if (s.volume !== p.volume || s.muted !== p.muted) e.applyMaster();
    }),
    useAudioMonitor.subscribe((s, p) => {
      if (s.solo !== p.solo) e.updateBuses();
    }),
    useEdits.subscribe((s, p) => {
      if (s.sequence !== p.sequence) e.updateBuses();
    }),
  ];
  exposeDevStats(e);
  return () => {
    uns.forEach((u) => u());
    unTick?.();
    e.stopSession();
    e.a0Neutral();
    engine = null;
  };
}

function exposeDevStats(e: SequenceAudioPreview): void {
  if (!import.meta.env?.DEV || typeof window === "undefined") return;
  const w = window as unknown as { __aivcSeq?: Record<string, unknown> };
  w.__aivcSeq = {
    ...(w.__aivcSeq ?? {}),
    audio: {
      stats: () => e.stats,
      reset: () => e.resetStats(),
      a0Mode: () => useAudioMonitor.getState().a0Mode,
      a0LevelDb: () => e.a0LevelDb(),
      a0Debug: () => e.a0Debug(),
      contextState: () => e.ctx?.state ?? "none",
      solo: useAudioMonitor,
    },
  };
}
