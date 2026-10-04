import { create } from "zustand";
import type { Rational } from "../api";

/**
 * 播放狀態（計畫 §8 store/playback.ts：幀取代 ms）。
 *
 * `frame` 由 rVFC 每個呈現幀回寫（stage/useRvfc.ts）；React 元件訂閱它會每幀重繪，
 * 所以只有 StatusBar 的幀號 / FrameTimeline 的播放線 / 傳輸列的時間碼這種本來就要每幀更新的地方才訂閱它。
 * 指令的 enabled() 反應性**排除**這個欄位（guards.ts）。
 *
 * `playing` 是 <video> 的鏡射（VideoStage 的元素事件回寫；playerRef 在「元素不會再發事件」的轉盤換檔時補寫）：
 * 指令要播就呼叫 stage/playerRef，**不要**拿這個欄位當開關 —— v0.0.6 的 Space 就是只寫了它，狀態列顯示 ▶、影片卻一直停著。
 */

/** 播放跟隨模式（沿用 ai-music-cut）：page 翻頁 / center 置中 / off。 */
export type FollowMode = "off" | "page" | "center";
export const FOLLOW_MODES: FollowMode[] = ["page", "center", "off"];

/** J/K/L 轉盤：倒轉沒有負 playbackRate，靠 ticker 逐幀 step（stage/playerRef.ts）。 */
export interface Shuttle {
  /** -1 倒退 / 0 停 / 1 前進。 */
  dir: -1 | 0 | 1;
  /** 1 / 2 / 4；slow = 0.5。 */
  speed: number;
}
export const SHUTTLE_STOPPED: Shuttle = { dir: 0, speed: 1 };

export interface LoopRange {
  in: number;
  /** 不含。 */
  out: number;
}

interface PlaybackStore {
  /** 目前顯示中的 proxy 幀號（rVFC 回寫；暫停 seek 完 seeked 也回寫）。 */
  frame: number;
  /**
   * 序列幀 t（docs/editor-m2-design.md §8.1；stage/sequencePlayer.ts 寫）。`frame` 維持 M1 語意（作用中媒體的 proxy 幀 k），
   * 舞台疊層、追蹤、遮罩全部照舊讀 k；這個欄位只回答「k 是序列裡的第幾次出現」—— 同一個來源幀用兩次時只有播放器知道。
   * null = 還沒進過序列模式（旗標關、或素材空間）；在空白上時 k 沒有意義，只有這個欄位在走。
   */
  seqFrame: number | null;
  /** 一次性序列 seek 請求（VideoStage 消費、交給序列播放器：換媒體 / 空白 / 停用都在那裡處理）。 */
  seqSeekReq: { frame: number; nonce: number } | null;
  playing: boolean;
  /** 一般播放 / 範圍播放的速度（速度選單）；轉盤作用中由轉盤的倍率覆蓋。 */
  rate: number;
  /** 0..1（<video>.volume）；存 localStorage，是「習慣」不是專案內容。 */
  volume: number;
  muted: boolean;
  /** 最近一次「開始播放」的幀：停止鈕回到這裡（REAPER / Audition 的 Stop 慣例）。 */
  playOrigin: number | null;
  followMode: FollowMode;
  /** 一次性 seek 請求（VideoStage 消費）；nonce 讓同一幀也能重複觸發。 */
  seekReq: { frame: number; nonce: number } | null;
  /** 範圍播放中的範圍（playerRef.playRange 設定；非 null ＝ 正在播範圍）。 */
  loop: LoopRange | null;
  shuttle: Shuttle;
  /** 一次性「把焦點放到時間碼欄位」請求（`=` 指令 → 傳輸列消費）；0 = 從沒要求過。 */
  tcFocus: number;
  seek: (frame: number) => void;
  setFrame: (frame: number) => void;
  /** 序列空間的 seek（序列幀 t）：先把 seqFrame 寫成目標（播放線立刻到位），實際換媒體 / 空白由序列播放器做。 */
  seekSeq: (t: number) => void;
  setSeqFrame: (t: number | null) => void;
  setPlaying: (b: boolean) => void;
  setRate: (r: number) => void;
  setVolume: (v: number) => void;
  setMuted: (b: boolean) => void;
  toggleMute: () => void;
  setPlayOrigin: (f: number | null) => void;
  cycleFollow: () => void;
  setFollowMode: (m: FollowMode) => void;
  setLoop: (l: LoopRange | null) => void;
  setShuttle: (s: Shuttle) => void;
  requestTimecodeFocus: () => void;
}

const VOLUME_KEY = "aivc:volume";
const MUTED_KEY = "aivc:muted";

/** localStorage 字串 → 音量（純函式，測試用）：壞值 / 沒存過一律 1，夾在 [0, 1]。 */
export function parseVolume(raw: string | null): number {
  if (raw == null || raw.trim() === "") return 1;
  const v = Number(raw);
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
}

// 私密視窗 / 停用儲存 / 縮圖擷取時 localStorage 會丟例外：讀不到就用預設，寫不進去就算了
function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

export const usePlayback = create<PlaybackStore>((set) => ({
  frame: 0,
  seqFrame: null,
  seqSeekReq: null,
  playing: false,
  rate: 1,
  volume: parseVolume(readStorage(VOLUME_KEY)),
  muted: readStorage(MUTED_KEY) === "1",
  playOrigin: null,
  followMode: "page",
  seekReq: null,
  loop: null,
  shuttle: SHUTTLE_STOPPED,
  tcFocus: 0,
  seek: (frame) => {
    const f = Math.max(0, Math.round(frame));
    set((s) => ({ frame: f, seekReq: { frame: f, nonce: (s.seekReq?.nonce ?? 0) + 1 } }));
  },
  setFrame: (frame) => set((s) => (s.frame === frame ? s : { frame })),
  seekSeq: (t) => {
    const f = Math.max(0, Math.round(Number.isFinite(t) ? t : 0));
    set((s) => ({ seqFrame: f, seqSeekReq: { frame: f, nonce: (s.seqSeekReq?.nonce ?? 0) + 1 } }));
  },
  setSeqFrame: (t) => set((s) => (s.seqFrame === t ? s : { seqFrame: t })),
  setPlaying: (b) => set((s) => (s.playing === b ? s : { playing: b })),
  setRate: (r) => set({ rate: Number.isFinite(r) && r > 0 ? r : 1 }),
  setVolume: (v) => {
    const vol = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1));
    writeStorage(VOLUME_KEY, String(vol));
    // 靜音時把音量拉上來＝想聽（YouTube / Premiere 的滑桿都這樣）；拉到 0 不改靜音旗標
    set((s) => {
      const muted = vol > 0 ? false : s.muted;
      if (muted !== s.muted) writeStorage(MUTED_KEY, muted ? "1" : "0");
      return { volume: vol, muted };
    });
  },
  setMuted: (b) => {
    writeStorage(MUTED_KEY, b ? "1" : "0");
    set((s) => (s.muted === b ? s : { muted: b }));
  },
  toggleMute: () =>
    set((s) => {
      writeStorage(MUTED_KEY, s.muted ? "0" : "1");
      return { muted: !s.muted };
    }),
  setPlayOrigin: (f) => set((s) => (s.playOrigin === f ? s : { playOrigin: f })),
  cycleFollow: () => set((s) => ({ followMode: FOLLOW_MODES[(FOLLOW_MODES.indexOf(s.followMode) + 1) % FOLLOW_MODES.length] })),
  setFollowMode: (m) => set({ followMode: m }),
  setLoop: (l) => set({ loop: l }),
  setShuttle: (shuttle) => set({ shuttle }),
  requestTimecodeFocus: () => set((s) => ({ tcFocus: s.tcFocus + 1 })),
}));

/** 點 J/L 一次 1x → 2x → 4x；反方向抵銷；K 停。slow = 按住 K 再點（0.5x）。 */
export function nextShuttle(cur: Shuttle, key: "J" | "K" | "L", opts: { slow: boolean }): Shuttle {
  if (key === "K") return SHUTTLE_STOPPED;
  const dir: -1 | 1 = key === "J" ? -1 : 1;
  if (opts.slow) return { dir, speed: 0.5 };
  if (cur.dir === dir) return { dir, speed: Math.min(4, cur.speed >= 1 ? cur.speed * 2 : 1) };
  if (cur.dir === -dir) return SHUTTLE_STOPPED;
  return { dir, speed: 1 };
}

// ---- 傳輸列的純邏輯（stage/playerRef.ts、stage/Transport.tsx、指令共用；抽成純函式才測得到）----

/** 速度選單（playback.speed）：慢速檢查追蹤 + 2× 快看。0.25 以下 WebView 會把音訊整個關掉，沒意義。 */
export const SPEEDS: readonly number[] = [0.25, 0.5, 0.75, 1, 1.5, 2];

/** 傳輸列的轉盤讀數："◀◀ 2×" / "▶▶ 0.5×"；停著回空字串。 */
export function shuttleLabel(s: Shuttle): string {
  if (s.dir === 0) return "";
  return `${s.dir < 0 ? "◀◀" : "▶▶"} ${s.speed}×`;
}

export type RangeAction = "play" | "loop" | "stop" | "leave";

/**
 * 範圍播放每幀問一次（共用 ticker，不是 4 Hz 的 timeupdate：那會多播最多 250 ms）。單位是秒（`<video>.currentTime`）。
 *
 * - `stop` / `loop`：時鐘過了出點（不含）的起點。
 * - `leave`：時鐘落在入點之前超過一幀 ＝ 使用者往回跳出這段（自然推進不會往回走）→ 結束範圍模式、照常播。
 *   往後跳出範圍分辨不出是「播過頭」還是「跳走」，那一半由 playerRef.seekToFrame 在 seek 當下判斷。
 */
export function rangeTick(t: number, startSec: number, endSec: number, loop: boolean, frameSec: number): RangeAction {
  if (t + 1e-6 < startSec - frameSec) return "leave";
  if (t + 1e-6 >= endSec) return loop ? "loop" : "stop";
  return "play";
}

export type ToggleAction = "stopShuttle" | "stopRange" | "pause" | "playRangeFromHere" | "play";

/**
 * Space / 播放鈕的唯一定義（按鈕與快捷鍵同一條路徑；中文輸入法下很多人只點按鈕）：
 * 轉盤在轉 → 停轉盤；在播範圍 → 停範圍；在播 → 暫停；
 * 循環開、有範圍、播放線在範圍內 → 從播放線開始循環播這段；其他 → 從播放線播。
 */
export function toggleAction(s: { shuttleDir: number; rangePlaying: boolean; playing: boolean; loopRange: boolean; range: LoopRange | null; frame: number }): ToggleAction {
  if (s.shuttleDir !== 0) return "stopShuttle";
  if (s.rangePlaying) return "stopRange";
  if (s.playing) return "pause";
  if (s.loopRange && s.range && s.frame >= s.range.in && s.frame < s.range.out) return "playRangeFromHere";
  return "play";
}

/** Ctrl+Shift+Space：一律從入點播；正在播的就是這一段 → 停。沒有範圍 → 什麼都不做（指令的 enabled 會先擋）。 */
export function playRangeAction(playingRange: LoopRange | null, range: LoopRange | null): "play" | "stop" | "none" {
  if (!range) return "none";
  if (playingRange && playingRange.in === range.in && playingRange.out === range.out) return "stop";
  return "play";
}

/** 全形數字 / 冒號 / 加減號 → 半形：中文輸入法開著打時間碼是常態，不該因此「看不懂」。 */
function toHalfWidth(s: string): string {
  return s.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/[−‒–—]/g, "-");
}

/**
 * 時間碼欄位的輸入 → 幀號（夾在 [0, frames−1]）；看不懂回 null。
 *
 * - `hh:mm:ss:ff` / `mm:ss:ff` / `ss:ff`（`;` 也算分隔，drop-frame 習慣）：每秒格數與 time.ts timecode() 一致（ceil(fps)），
 *   ff 超過每秒格數、mm/ss 非最高位卻 ≥ 60 → 看不懂（不偷偷進位，免得跳到意料外的地方）。
 * - 純整數 = 幀號（時間軸的單位就是幀）。
 * - `+N` / `-N` = 相對目前幀；`+1.5s` / `-2秒` = 相對秒數；`12.5s` = 絕對秒數。前面加號也可以接時間碼。
 */
export function parseTimecodeInput(text: string, fps: Rational, current: number, frames: number): number | null {
  let s = toHalfWidth(text).trim().replace(/\s+/g, "");
  let sign = 0;
  if (s[0] === "+" || s[0] === "-") {
    sign = s[0] === "+" ? 1 : -1;
    s = s.slice(1);
  }
  const n = parseFrameAmount(s, fps.num > 0 && fps.den > 0 ? fps.num / fps.den : 30);
  if (n === null) return null;
  const f = sign === 0 ? n : current + sign * n;
  if (frames <= 0) return 0;
  return Math.max(0, Math.min(frames - 1, Math.round(f)));
}

/** 不帶正負號的量（秒數 / 幀號 / 時間碼）→ 幀數；看不懂回 null。 */
function parseFrameAmount(s: string, fps: number): number | null {
  if (!s) return null;
  const sec = /^(\d+(?:\.\d+)?|\.\d+)(?:s|sec|秒)$/i.exec(s);
  if (sec) return Math.round(parseFloat(sec[1]) * fps);
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  if (/^\d+(?:[:;]\d+){1,3}$/.test(s)) return parseTimecodeParts(s.split(/[:;]/).map((x) => parseInt(x, 10)), Math.max(1, Math.ceil(fps)));
  return null;
}

/** [hh, mm, ss, ff] 的後段 → 幀數。由低到高：ss、mm、hh；只有最高位可以超過 59（「90:00」＝ 90 秒）。 */
function parseTimecodeParts(parts: number[], perSec: number): number | null {
  const ff = parts.pop()!;
  if (ff >= perSec) return null;
  const units = [1, 60, 3600];
  let secs = 0;
  for (let i = 0; i < parts.length; i++) {
    const v = parts[parts.length - 1 - i];
    if (i < parts.length - 1 && v >= 60) return null;
    secs += v * units[i];
  }
  return secs * perSec + ff;
}
