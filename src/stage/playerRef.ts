import type { Rational } from "../api";
import { subscribeTick, TICK_PRIORITY } from "../preview/ticker";
import { playRangeAction, rangeTick, SHUTTLE_STOPPED, toggleAction, usePlayback, type Shuttle } from "../store/playback";
import { useTimeline } from "../store/timeline";
import { clampFrame, frameDuration, frameOfMediaTime, mediaTimeOfFrame } from "../video/frames";

/**
 * 單一 <video> 元素的全域參考（沿 ai-music-cut preview/playerRef.ts 的設計；計畫 §8）：
 * 指令 / 快捷鍵 / 時間軸 / 傳輸列不用穿過 React 樹就能控制播放。所有「幀 ↔ 秒」換算只走 video/frames.ts。
 *
 * - **播放一律呼叫這裡**，不要寫 playback.playing：那個欄位只是元素事件的鏡射（VideoStage）。
 * - seek 一律 `currentTime = (f + 0.5)·den/num`：落在幀中央，瀏覽器不會在幀邊界上二選一顯示前一幀
 *   （這 +0.5 是 seek-accuracy 量尺誤差為 0 的關鍵，計畫 §9）。
 * - seek 用 rVFC 收尾，不用 timeupdate（4 Hz）：呈現出那一幀的那一刻才算完成。
 *   seek 到同一個時間不會呈現新幀 → rVFC 不叫，所以 `seeked` 事件 + 50 ms 寬限當保底。
 * - 一次只有一個 seek 在飛：scrub 一秒幾十個請求，只留最後一個（pending），
 *   否則 WebView 會排隊解碼每一個中間幀、播放線落後手指半秒。
 * - 倒轉沒有負的 playbackRate：靠共用 ticker 逐幀往回 seek（靜音）。
 * - 速度 / 音量 / 靜音由這裡從 playback store 套到元素上（VideoStage 不必各開一個 effect）。
 */

interface PlayerMeta {
  fps: Rational;
  frames: number;
}

/**
 * 序列模式的委派（stage/sequencePlayer.ts 在 VideoStage 掛載時註冊；docs/editor-m2-design.md §8.1）。
 *
 * 為什麼用註冊而不是直接 import：sequencePlayer 本身要用這裡的 seekToFrame / getPlayer 操作元素，
 * 反過來再 import 它會變成循環相依；而且沒註冊（測試、旗標關）時這裡的每一條路徑都跟 M1 一模一樣。
 * `active()` 為 false（旗標關、素材空間、沒有序列）時全部不轉，一行 M1 程式都不繞。
 */
export interface SequenceDelegate {
  active(): boolean;
  play(): void;
  pause(): void;
  togglePlay(): void;
  togglePlayRange(): void;
  stop(): void;
  step(delta: number): Promise<number>;
  /** in / out 是序列幀（序列空間的範圍）。 */
  playRange(inFrame: number, outFrame: number, opts: PlayRangeOptions): () => void;
  applyShuttle(sh: Shuttle): void;
  /** 序列播放器自己在換媒體（接點）：setPlayer 看到 src 變了不要當成「換了一支片」去停轉盤 / 清開播點。 */
  switching(): boolean;
  /** 元素綁好新的 src（序列播放器等這個才 seek 到新媒體的 k）。 */
  bound(): void;
  /** 序列在播（黑畫面階段元素是暫停的，但序列在播）。 */
  playing(): boolean;
  /** 任何開播之前（使用者手勢內）：Web Audio 的 AudioContext 要在這時 resume（src/audio/preview.ts）。可省略。 */
  beforePlay?(): void;
}

let seqDelegate: SequenceDelegate | null = null;

export function setSequenceDelegate(d: SequenceDelegate | null): void {
  seqDelegate = d;
}

/** 現在由序列播放器接手嗎（旗標開、序列空間、有序列）。 */
export function sequenceDelegated(): boolean {
  return !!seqDelegate && seqDelegate.active();
}

function beforePlay(): void {
  try {
    seqDelegate?.beforePlay?.();
  } catch {
    /* 預覽音訊出問題不能擋播放 */
  }
}

let el: HTMLVideoElement | null = null;
let meta: PlayerMeta | null = null;
/**
 * 事件監聽綁在哪個元素上。VideoStage 在 proxy 物件換新（專案 store 更新）時會先 setPlayer(null) 再綁回**同一個**元素；
 * 那不算換播放器，範圍播放 / 轉盤不能因此被打斷。真的換了元素才重置。
 */
let bound: HTMLVideoElement | null = null;
/**
 * 綁定當下元素的 src。換媒體時 VideoStage 沿用同一個 <video>、只換 src，所以「同一個元素」不代表「同一支影片」：
 * 換 src 的載入流程會把元素暫停卻不發 pause 事件，範圍播放的 pause 監聽收不到 —— 從第 0 幀開始的範圍會一直掛著
 * 「播放中」（疊色、傳輸列按鈕亮著，Space 也沒反應）。比 src 才分得出「proxy 物件換新」與「換了一支」。
 */
let boundSrc = "";
let unbindEl: (() => void) | null = null;

export function setPlayer(e: HTMLVideoElement | null, m: PlayerMeta | null): void {
  // 序列播放器在接點上換媒體：同一個元素、只換 src。轉盤 / 開播點屬於「序列」不屬於某一支片，不能重置
  const seqSwitch = !!seqDelegate && seqDelegate.switching();
  let srcChanged = false;
  if (e && (e !== bound || e.src !== boundSrc)) {
    srcChanged = true;
    // 換元素或換媒體：上一支的範圍播放、轉盤（連 store 讀數一起歸零）、排隊中的 seek、停止鈕的回位點都不屬於這支了
    stopRange();
    if (!seqSwitch) haltShuttle();
    pending = null;
    inflight?.cancel();
    rangeEndedAtEnd = false;
    if (!seqSwitch) usePlayback.getState().setPlayOrigin(null);
    if (e !== bound) {
      unbindEl?.();
      unbindEl = bindElement(e);
      bound = e;
    }
    boundSrc = e.src;
  }
  // 播放器卸下（關片 / 換 proxy）：倒退轉盤的 ticker 不看元素，不停掉會一直空轉。範圍播放不用管 ——
  // 元素離開 DOM 會自己 pause，playRange 的 pause 監聽就收掉了；綁回同一個元素時也不會被誤殺
  if (!e && !seqSwitch) haltShuttle();
  el = e;
  meta = m;
  // 元素與 meta 都就位之後才通知：序列播放器接著就要 seekToFrame
  if (e && m && srcChanged) seqDelegate?.bound();
}

export function getPlayer(): HTMLVideoElement | null {
  return el;
}

export function playerMeta(): PlayerMeta | null {
  return meta;
}

// ---- 偏好（速度 / 音量 / 靜音）與元素事件 ----

let prefsInstalled = false;

/** store → 元素：只裝一次，套到「目前的」元素上（換元素不必重訂）。 */
function installPrefs(): void {
  if (prefsInstalled) return;
  prefsInstalled = true;
  usePlayback.subscribe((s, p) => {
    const v = el;
    if (!v) return;
    if (s.volume !== p.volume) v.volume = s.volume;
    if (s.muted !== p.muted) v.muted = s.muted;
    if (s.rate !== p.rate) applyRate(v);
  });
}

/** 轉盤前進時 playbackRate 歸轉盤管（applyShuttle 設倍率、停下時還原），速度選單不要去搶。 */
function applyRate(v: HTMLVideoElement): void {
  const r = usePlayback.getState().rate;
  // defaultPlaybackRate 也要設：換 src 時 load 演算法會把 playbackRate 重設成它，否則換片後速度默默回 1×
  v.defaultPlaybackRate = r;
  if (!shuttleStop) v.playbackRate = r;
}

function bindElement(v: HTMLVideoElement): () => void {
  installPrefs();
  const s = usePlayback.getState();
  v.volume = s.volume;
  v.muted = s.muted;
  applyRate(v);
  // 循環開、沒有範圍：播到尾巴從頭來（Resolve 在時間軸尾端循環）。有範圍的循環由 playRange 自己管
  const onEnded = () => {
    // 這個 ended 是範圍播放（例如最後一個鏡頭的「播放此鏡頭」）播到片尾收掉的：它已經停在該停的地方，
    // 不能再被「循環、沒有範圍 → 從頭來」接走，否則會從第 0 幀把整支播一遍
    const consumedByRange = rangeEndedAtEnd;
    rangeEndedAtEnd = false;
    // 序列模式：媒體播到尾巴只是一個接點，下一步由序列播放器決定（循環也是它管，而且是序列的尾巴不是這支片的）
    if (sequenceDelegated()) return;
    const tl = useTimeline.getState();
    if (consumedByRange || !tl.loopRange || tl.range || rangeStop || !meta) return;
    v.currentTime = mediaTimeOfFrame(0, meta.fps);
    void v.play().catch(() => {});
  };
  // 任何一次新的開播都讓舊記號作廢：記號只屬於「緊接在範圍收尾之後」的那一個 ended
  const onPlay = () => {
    rangeEndedAtEnd = false;
  };
  v.addEventListener("ended", onEnded);
  v.addEventListener("play", onPlay);
  return () => {
    v.removeEventListener("ended", onEnded);
    v.removeEventListener("play", onPlay);
  };
}

/** 元素現在的時鐘落在哪一幀（播放中會比呈現的幀超前一點；畫圖請用 rVFC 的幀）。 */
export function currentFrame(): number {
  if (!el || !meta) return usePlayback.getState().frame;
  return clampFrame(frameOfMediaTime(el.currentTime, meta.fps), meta.frames);
}

// ---- seek ----

interface Inflight {
  frame: number;
  cancel: () => void;
}

let inflight: Inflight | null = null;
let pending: number | null = null;
let idleWaiters: ((f: number) => void)[] = [];

/** 沒有在飛、也沒有排隊 → 立刻 resolve；否則等最後一個 seek 落地。 */
function whenIdle(): Promise<number> {
  if (!inflight && pending === null) return Promise.resolve(usePlayback.getState().frame);
  return new Promise((r) => idleWaiters.push(r));
}

const SEEKED_GRACE_MS = 50;
const SEEK_TIMEOUT_MS = 800;

function startSeek(f: number): Promise<number> {
  const p = el;
  const m = meta;
  if (!p || !m) return Promise.resolve(usePlayback.getState().frame);
  return new Promise<number>((resolve) => {
    let done = false;
    let rvfcId: number | null = null;
    let grace: ReturnType<typeof setTimeout> | null = null;
    const timeout = setTimeout(() => finish(frameOfMediaTime(p.currentTime, m.fps)), SEEK_TIMEOUT_MS);

    const finish = (shown: number) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (grace !== null) clearTimeout(grace);
      p.removeEventListener("seeked", onSeeked);
      if (rvfcId !== null && typeof p.cancelVideoFrameCallback === "function") p.cancelVideoFrameCallback(rvfcId);
      inflight = null;
      const shownClamped = clampFrame(shown, m.frames);
      usePlayback.getState().setFrame(shownClamped);
      resolve(shownClamped);
      if (pending !== null) {
        const n = pending;
        pending = null;
        void startSeek(n);
      } else {
        const ws = idleWaiters;
        idleWaiters = [];
        ws.forEach((w) => w(shownClamped));
      }
    };
    // seeked 先到：再等 rVFC 一小段，它才知道「畫面上是哪一幀」；等不到就用時鐘算
    const onSeeked = () => {
      if (grace === null) grace = setTimeout(() => finish(frameOfMediaTime(p.currentTime, m.fps)), SEEKED_GRACE_MS);
    };
    if (typeof p.requestVideoFrameCallback === "function") {
      rvfcId = p.requestVideoFrameCallback((_now, md) => finish(frameOfMediaTime(md.mediaTime, m.fps)));
    }
    p.addEventListener("seeked", onSeeked);
    inflight = { frame: f, cancel: () => finish(f) };
    p.currentTime = mediaTimeOfFrame(f, m.fps);
  });
}

/** 跳到某一幀；回傳實際呈現出來的幀號（等 rVFC / seeked）。 */
export function seekToFrame(frame: number): Promise<number> {
  if (!el || !meta) return Promise.resolve(usePlayback.getState().frame);
  const f = clampFrame(frame, meta.frames);
  // 範圍播放中跳到範圍外（拖尺規、點鏡頭、打時間碼）＝ 使用者離開這段：結束範圍模式、照常往下播
  //（Resolve「點滑桿中斷 Play In to Out 循環」）。跳到範圍內則繼續範圍播放
  if (rangeBounds && (f < rangeBounds.in || f >= rangeBounds.out)) rangeLeave?.();
  if (inflight) {
    // 已經在飛：只留最後一個
    pending = f;
    return whenIdle();
  }
  return startSeek(f);
}

/** 目前「意圖」上的幀：排隊中的 > 在飛的 > 元素時鐘。連按 → 鍵 10 次要前進 10 幀，不是 1 幀。 */
function intendedFrame(): number {
  return pending ?? inflight?.frame ?? currentFrame();
}

/** 逐幀步進（會先暫停；範圍播放 / 轉盤一併停下）。 */
export function stepFrames(delta: number): Promise<number> {
  const p = el;
  if (!p || !meta) return Promise.resolve(usePlayback.getState().frame);
  // 序列空間的逐幀：以序列幀走，跨片段 / 空白也照走（回傳序列幀）
  if (sequenceDelegated()) return seqDelegate!.step(delta);
  // 先算目標再停範圍：停範圍會 pause，時鐘不會再動，但 pending / inflight 仍是「意圖」
  const target = intendedFrame() + Math.round(delta);
  stopRange();
  haltShuttle();
  if (!p.paused) p.pause();
  return seekToFrame(target);
}

// ---- 播放 / 停止 ----

export function isPlaying(): boolean {
  return !!el && !el.paused && !el.ended;
}

/** 從播放線播（停在最後一幀時從頭來，不然按了沒反應像壞掉）。 */
export function play(): void {
  const p = el;
  const m = meta;
  if (!p || !p.src) return;
  beforePlay();
  if (sequenceDelegated()) {
    seqDelegate!.play();
    return;
  }
  haltShuttle();
  if (m && (p.ended || currentFrame() >= m.frames - 1)) p.currentTime = mediaTimeOfFrame(0, m.fps);
  usePlayback.getState().setPlayOrigin(m ? clampFrame(intendedFrame(), m.frames) : null);
  applyRate(p);
  void p.play().catch(() => {});
}

export function pause(): void {
  const p = el;
  if (!p) return;
  // 序列在黑畫面階段時元素本來就是暫停的，只暫停元素停不下序列的 ticker
  if (sequenceDelegated()) {
    seqDelegate!.pause();
    return;
  }
  if (!p.paused) p.pause();
}

/** Space / 播放鈕（語意見 store/playback.ts toggleAction）。 */
export function togglePlay(): void {
  const p = el;
  if (!p || !p.src) return;
  beforePlay();
  if (sequenceDelegated()) {
    seqDelegate!.togglePlay();
    return;
  }
  const pb = usePlayback.getState();
  const tl = useTimeline.getState();
  const frame = intendedFrame();
  switch (toggleAction({ shuttleDir: pb.shuttle.dir, rangePlaying: isRangePlaying(), playing: isPlaying(), loopRange: tl.loopRange, range: tl.range, frame })) {
    case "stopShuttle":
      haltShuttle();
      if (!p.paused) p.pause();
      return;
    case "stopRange":
      stopRange();
      return;
    case "pause":
      pause();
      return;
    case "playRangeFromHere":
      if (tl.range) playRange(tl.range.in, tl.range.out, { loop: loopRangeOn, from: frame });
      return;
    case "play":
      play();
  }
}

/** Ctrl+Shift+Space：從入點播到出點（循環跟著「循環播放範圍」開關）；正在播同一段就停。 */
export function togglePlayRange(): void {
  beforePlay();
  if (sequenceDelegated()) {
    seqDelegate!.togglePlayRange();
    return;
  }
  const range = useTimeline.getState().range;
  const act = playRangeAction(isRangePlaying() ? usePlayback.getState().loop : null, range);
  if (act === "stop") stopRange();
  else if (act === "play" && range) playRange(range.in, range.out, { loop: loopRangeOn });
}

/**
 * 停止：停下一切（範圍 / 轉盤 / 一般播放）；**正在動的時候**才回到最近一次開始播放的位置。
 * 已經停著（播 → 暫停 → 手動 scrub 到別處）再按停止不能把播放線拉回舊的開播點：那個位置早就不是使用者要的，
 * 看起來像播放線自己亂跳（Resolve / Premiere 停著時按 Stop 什麼都不做）。
 */
export function stop(): void {
  const p = el;
  if (!p) return;
  if (sequenceDelegated()) {
    seqDelegate!.stop();
    return;
  }
  const moving = isPlaying() || isRangePlaying() || shuttleStop !== null;
  const origin = usePlayback.getState().playOrigin;
  stopRange();
  haltShuttle();
  if (!p.paused) p.pause();
  if (moving && origin != null) void seekToFrame(origin);
}

/** 播放中切換循環要立刻生效：範圍播放每幀讀這個，不是開播當下凍結的值。 */
function loopRangeOn(): boolean {
  return useTimeline.getState().loopRange;
}

// ---- 範圍播放 ----

let rangeStop: (() => void) | null = null;
let rangeLeave: (() => void) | null = null;
let rangeBounds: { in: number; out: number } | null = null;
/**
 * 範圍播放是因為元素播到片尾而收掉的（沒有循環）：元素接著（或已經排好）會發 ended，
 * bindElement 的「循環 → 從頭來」看到這個記號就放過那一次。新的 play 事件 / 換媒體會清掉它。
 */
let rangeEndedAtEnd = false;

export function isRangePlaying(): boolean {
  return rangeStop !== null;
}

export function stopRange(): void {
  rangeStop?.();
}

export interface PlayRangeOptions {
  /** true / false，或每幀讀一次的 getter（播放中切換循環立即生效）。 */
  loop?: boolean | (() => boolean);
  /** 從範圍內的哪一幀開始（Space 在循環模式下從播放線接著播）；預設入點。 */
  from?: number;
  /**
   * 暫態播放（播「選取的片段」而不是 I / O 範圍）：一樣播到出點就停 / 循環，但**不寫 playback.loop**，
   * 所以傳輸列的「播放範圍」不會亮、時間軸也不會多一塊範圍淡底 —— 使用者沒有標範圍，不該看起來像標了。
   * 控制邏輯（isRangePlaying / rangeTick / seek 出界中斷）走 module 內的 rangeStop / rangeBounds，不受影響。
   */
  transient?: boolean;
}

/**
 * 播 [inFrame, outFrame)；到尾自動停在最後一幀（loop 則回到 in 重播）。
 * 收尾走共用 ticker 每幀問一次 `rangeTick`（`TICK_PRIORITY.range`），不是 timeupdate；
 * 期間 playback.loop 記錄範圍讓 FrameTimeline 畫陰影、傳輸列亮「播放範圍」。回傳停止函式。
 */
export function playRange(inFrame: number, outFrame: number, opts: PlayRangeOptions = {}): () => void {
  const p = el;
  const m = meta;
  if (!p || !m || !p.src) return () => {};
  beforePlay();
  // 序列空間的範圍是序列幀（時間軸在序列空間標的 I / O），交給序列播放器
  if (sequenceDelegated()) return seqDelegate!.playRange(inFrame, outFrame, opts);
  stopRange();
  haltShuttle();
  const a = clampFrame(Math.min(inFrame, outFrame), m.frames);
  const b = Math.max(a + 1, Math.min(m.frames, Math.max(inFrame, outFrame)));
  const loopOpt = opts.loop;
  const loopOn = typeof loopOpt === "function" ? loopOpt : () => loopOpt === true;
  const from = opts.from == null ? a : Math.max(a, Math.min(b - 1, Math.round(opts.from)));
  const pb = usePlayback.getState();
  if (!opts.transient) pb.setLoop({ in: a, out: b });
  pb.setPlayOrigin(from);
  // out 是不含的：時鐘一過幀 b 的起點就算播完
  const startSec = (a * m.fps.den) / m.fps.num;
  const endSec = (b * m.fps.den) / m.fps.num;
  const frameSec = frameDuration(m.fps);

  let stopped = false;
  let started = false;
  let unTick: (() => void) | null = null;

  const stop = (pauseEl: boolean) => {
    if (stopped) return;
    stopped = true;
    // 片尾收掉的兩條路（pause 事件先到、或 ticker 先看到時鐘過出點）都要留記號：
    // ticker 先到時監聽已經拆掉，但元素的 pause / ended 事件仍排在後面，ended 會打到 bindElement
    if (p.ended) rangeEndedAtEnd = true;
    unTick?.();
    p.removeEventListener("pause", onPause);
    p.removeEventListener("playing", onPlaying);
    if (rangeStop === stopHandle) {
      rangeStop = null;
      rangeLeave = null;
      rangeBounds = null;
    }
    usePlayback.getState().setLoop(null);
    if (pauseEl && !p.paused) p.pause();
  };
  const stopHandle = () => stop(true);
  const restart = () => {
    p.currentTime = mediaTimeOfFrame(a, m.fps);
  };
  // 還沒開始就收到 pause = 呼叫端剛 pause 過、事件晚一步打到我們（ai-music-cut playerRef 的坑）
  const onPause = () => {
    if (!started) return;
    // 範圍一路到片尾：元素自己 ended（先發 pause）比 tick 看到時鐘過出點還早 —— 循環時從入點再來，不是停下
    if (p.ended && loopOn()) {
      restart();
      void p.play().catch(() => stop(true));
      return;
    }
    stop(true);
  };
  const onPlaying = () => {
    started = true;
  };
  const tick = () => {
    switch (rangeTick(p.currentTime, startSec, endSec, loopOn(), frameSec)) {
      case "loop":
        restart();
        return;
      case "stop":
        stop(true);
        // 停在範圍內的最後一幀，而不是範圍外的第一幀
        void seekToFrame(b - 1);
        return;
      case "leave":
        stop(false);
        return;
      default:
    }
  };

  rangeStop = stopHandle;
  rangeLeave = () => stop(false);
  rangeBounds = { in: a, out: b };
  p.addEventListener("pause", onPause);
  p.addEventListener("playing", onPlaying);
  void seekToFrame(from).then(() => {
    if (stopped) return;
    unTick = subscribeTick(tick, TICK_PRIORITY.range);
    applyRate(p);
    p.play()
      .then(() => {
        started = true;
      })
      .catch(() => stop(true));
  });
  return stopHandle;
}

// ---- J/K/L 轉盤 ----

let shuttleStop: (() => void) | null = null;

function stopShuttle(): void {
  const s = shuttleStop;
  shuttleStop = null;
  s?.();
}

/**
 * 停轉盤並把 store 歸零（傳輸列的讀數才會消失）。先清掉 shuttleStop 再寫 store：
 * VideoStage 對 store 的 effect 接著呼叫 applyShuttle(停)，看到「沒有作用中的轉盤」就不會 pause ——
 * 否則 play() 剛開播就被自己停掉。
 */
function haltShuttle(): void {
  stopShuttle();
  const pb = usePlayback.getState();
  if (pb.shuttle.dir !== 0) pb.setShuttle(SHUTTLE_STOPPED);
}

/**
 * 套用轉盤狀態。順向用 playbackRate；倒退沒有負速率 —— 暫停元素、用 ticker 依 fps × 倍率
 * 累積該退幾幀再 seek（seek 佇列會把太密的請求合併，落點仍是準的）。退到 0 就停。
 */
export function applyShuttle(sh: Shuttle): void {
  if (sequenceDelegated()) {
    // M1 的轉盤若剛好在轉（素材空間按了 L 再切進序列空間），先收掉再交出去
    stopShuttle();
    if (sh.dir > 0) beforePlay();
    seqDelegate!.applyShuttle(sh);
    return;
  }
  const wasActive = shuttleStop !== null;
  stopShuttle();
  const p = el;
  const m = meta;
  if (!p || !m) return;
  if (sh.dir === 0) {
    // 只有真的有轉盤在轉才停：store 被 play() / Space 歸零時元素要繼續播
    if (wasActive && !p.paused) p.pause();
    return;
  }
  if (!wasActive && p.paused) usePlayback.getState().setPlayOrigin(clampFrame(intendedFrame(), m.frames));
  if (sh.dir > 0) {
    stopRange();
    p.playbackRate = sh.speed;
    void p.play().catch(() => {});
    // 已經在播時 play() 不會再發 play 事件（例如 Space 播放中再按 L）；鏡射要照元素的真相補寫一次，
    // 時間軸的置中跟隨看它
    usePlayback.getState().setPlaying(true);
    shuttleStop = () => {
      p.playbackRate = usePlayback.getState().rate;
    };
    return;
  }
  stopRange();
  if (!p.paused) p.pause();
  const frameMs = frameDuration(m.fps) * 1000;
  let acc = 0;
  let last = performance.now();
  const un = subscribeTick(() => {
    const now = performance.now();
    acc += (now - last) * sh.speed;
    last = now;
    const n = Math.floor(acc / frameMs);
    if (n <= 0) return;
    acc -= n * frameMs;
    const target = intendedFrame() - n;
    if (target <= 0) {
      void seekToFrame(0);
      usePlayback.getState().setShuttle(SHUTTLE_STOPPED);
      return;
    }
    void seekToFrame(target);
  }, TICK_PRIORITY.skip);
  shuttleStop = un;
}
