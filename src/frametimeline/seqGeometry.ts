// 序列空間時間軸的幾何純函式（docs/editor-m2-design.md §9.2–9.4）：片段在哪個 x、縮圖放哪、追蹤怎麼分段、
// 音量線 / 自動化點 / 淡化把手的位置、波形從哪個桶開始取。
//
// 為什麼獨立一個檔：drawSequence.ts（畫）與 hitSequence.ts（點）必須對「東西在哪裡」有完全相同的答案 ——
// 畫在 x=100 的把手、命中卻算在 x=103，使用者看到的就是「點了沒反應」。兩邊都 import 這裡，不互相 import。
//
// 時間座標：V1 / 追蹤用序列幀 t（整數）；音訊片段用 48 kHz 序列樣本，換成**小數幀**（t = sample·num / (48000·den)），
// 不先 floor 成整數幀 —— 29.97 fps 一幀是 1601.6 樣本，floor 會讓音訊片段在放大時最多偏掉一整格。
import { PEAKS_PPS } from "../audio/peaks";
import { GAIN_DB_MAX, SEQ_SAMPLE_RATE, SILENCE_DB, type AudioClipV2, type ClipGainV2, type FadeCurve, type Rational, type VideoClipV2, type VideoItemV2 } from "../project/format";
import { envelopeDbAt } from "../sequence/envelope";
import type { PlacedItem } from "../sequence/map";
import { confidenceBand, type ConfidenceBand, type SolveFrame } from "../store/solves";
import { xOfFrame } from "../store/timeline";
import type { BandRun } from "./draw";
import { xOfSample, type SeqView } from "./layoutSequence";

// ---- 增益曲線（波形包絡、音量線共用）----

/**
 * 音量線的 dB → y：dB 域線性（同 ai-music-cut envDbToY），上緣 +12 dB、下緣 GAIN_LINE_MIN_DB；更小的值（閃避到 −96）貼底。
 * 線性 dB 是為了讓「兩個自動化點之間在 dB 域線性內插」畫出來剛好是直線：折線就是精確的曲線，不必逐像素算。
 */
export const GAIN_LINE_MIN_DB = -48;
const GAIN_LINE_PAD = 3;

/** 標記旗子的半寬（px）。畫與命中共用 —— 分開寫就會變成「點了沒反應」。 */
export const MARKER_HALF_W = 4;

/** 標記旗子佔的帶狀區（尺規下緣；尺規很矮時縮小但至少 4 px）。 */
export function markerBand(L: { rulerY: number; rulerH: number }): { y: number; h: number } {
  const h = Math.min(9, Math.max(4, L.rulerH - 2));
  return { y: L.rulerY + L.rulerH - h, h };
}

export function gainDbToY(db: number, top: number, h: number): number {
  const span = Math.max(1, h - GAIN_LINE_PAD * 2);
  const d = Math.max(GAIN_LINE_MIN_DB, Math.min(GAIN_DB_MAX, db));
  return top + GAIN_LINE_PAD + ((GAIN_DB_MAX - d) / (GAIN_DB_MAX - GAIN_LINE_MIN_DB)) * span;
}

/** gainDbToY 的反函式（M2.15 拖音量線用），夾在 [GAIN_LINE_MIN_DB, +12]。 */
export function gainYToDb(y: number, top: number, h: number): number {
  const span = Math.max(1, h - GAIN_LINE_PAD * 2);
  const f = Math.max(0, Math.min(1, (y - top - GAIN_LINE_PAD) / span));
  return GAIN_DB_MAX - f * (GAIN_DB_MAX - GAIN_LINE_MIN_DB);
}

/** afade 的形狀：linear = tri（線性）、equalPower = qsin（四分之一正弦）；x ∈ [0, 1]。 */
export function fadeShape(x: number, curve: FadeCurve): number {
  const v = Math.max(0, Math.min(1, x));
  return curve === "equalPower" ? Math.sin((v * Math.PI) / 2) : v;
}

/**
 * 片段內 at（相對片段起點的序列樣本，可為小數）的線性振幅倍率：片段增益＋自動化（dB）＋busDb，乘淡入淡出形狀。
 * ≤ SILENCE_DB 視為靜音（0）：閃避到 −96 的區段波形要真的消失，而不是剩一條 0.00002 倍的細線。
 * 跟渲染（§7.3 的 volume / afade 鏈）同一套語意，波形跟著閃避變小的位置就是聲音變小的位置。
 * （M2.16 的 Web Audio 預覽會把這支搬到 src/audio/gainCurve.ts 共用；在那之前只有時間軸用。）
 */
export function clipGainFactor(g: ClipGainV2, at: number, length: number, busDb = 0): number {
  const db = g.gainDb + envelopeDbAt(g.envelope, at) + busDb;
  if (db <= SILENCE_DB) return 0;
  let f = 10 ** (db / 20);
  if (g.fadeIn > 0 && at < g.fadeIn) f *= fadeShape(at / g.fadeIn, g.fadeCurve);
  if (g.fadeOut > 0 && at > length - g.fadeOut) f *= fadeShape((length - at) / g.fadeOut, g.fadeCurve);
  return f;
}

// ---- 片段位置 ----

export interface ItemSpan {
  index: number;
  item: VideoItemV2;
  t0: number;
  t1: number;
  x0: number;
  x1: number;
}

/** V1 項目 → 螢幕 x 區間；只回可視範圍內的（嚴格不等：剛好貼在左右緣外、0 px 寬的不算）。 */
export function visibleItemSpans(placed: readonly PlacedItem[], view: SeqView, width: number): ItemSpan[] {
  const out: ItemSpan[] = [];
  for (const p of placed) {
    const x0 = xOfFrame(p.t0, view.scrollFrame, view.pxPerFrame);
    const x1 = xOfFrame(p.t1, view.scrollFrame, view.pxPerFrame);
    if (x1 <= 0) continue;
    if (x0 >= width) break;
    out.push({ index: p.index, item: p.item, t0: p.t0, t1: p.t1, x0, x1 });
  }
  return out;
}

/** 音訊片段 → 螢幕 x 區間（小數幀換算，不 floor）。 */
export function audioClipSpan(c: Pick<AudioClipV2, "start" | "length">, fps: Rational, view: SeqView): { x0: number; x1: number } {
  return { x0: xOfSample(c.start, fps, view), x1: xOfSample(c.start + c.length, fps, view) };
}

export interface ThumbSlot {
  /** 序列幀。 */
  t: number;
  /** 來源 proxy 幀（抓縮圖用）。 */
  k: number;
  x: number;
}

/**
 * 片段內要畫哪幾張縮圖：每 step 幀一張（step = ceil(thumbW / pxPerFrame)），**從片段入點對齊** ——
 * 每個片段第一張縮圖就是它的入點畫面（看片段頭就知道切在哪），捲動時片段內的縮圖也不會整排換人。
 * 縮圖依片段的 k 抓（§9.2）：同一來源幀用在兩個片段，兩邊畫的是同一張。
 */
export function clipThumbSlots(p: { t0: number; t1: number }, srcIn: number, view: SeqView, width: number, thumbW: number): ThumbSlot[] {
  const px = view.pxPerFrame;
  if (px <= 0 || thumbW <= 0 || width <= 0 || p.t1 <= p.t0) return [];
  const step = Math.max(1, Math.ceil(thumbW / px));
  const skip = Math.max(0, Math.floor((view.scrollFrame - thumbW / px - p.t0) / step));
  const out: ThumbSlot[] = [];
  for (let t = p.t0 + skip * step; t < p.t1; t += step) {
    const x = xOfFrame(t, view.scrollFrame, px);
    if (x >= width) break;
    if (x + thumbW <= 0) continue;
    out.push({ t, k: srcIn + (t - p.t0), x });
  }
  return out;
}

// ---- 追蹤車道分段（§9.3：solvedRuns 的 k 平移 t0 − srcIn 後裁在 [t0, t1) 內）----

/** 來源 k 區間 [a, b) 在序列上的位置：每個用到這支媒體的片段各一段（同一段來源用兩次就出現兩次）。 */
export function mapSourceSpan(placed: readonly PlacedItem[], mediaId: string, a: number, b: number): { t0: number; t1: number; index: number }[] {
  const out: { t0: number; t1: number; index: number }[] = [];
  for (const p of placed) {
    const it = p.item;
    if (it.kind !== "clip" || it.mediaId !== mediaId) continue;
    const lo = Math.max(a, it.srcIn);
    const hi = Math.min(b, it.srcOut);
    if (hi > lo) out.push({ t0: p.t0 + (lo - it.srcIn), t1: p.t0 + (hi - it.srcIn), index: p.index });
  }
  return out;
}

/** 來源幀 k 在序列上的所有位置（關鍵幀菱形、參考影格錨標）。 */
export function mapSourceFrame(placed: readonly PlacedItem[], mediaId: string, k: number): number[] {
  const out: number[] = [];
  for (const p of placed) {
    const it = p.item;
    if (it.kind === "clip" && it.mediaId === mediaId && k >= it.srcIn && k < it.srcOut) out.push(p.t0 + (k - it.srcIn));
  }
  return out;
}

/** 第一個 k ≥ target 的索引（solve.frames 依 k 遞增，引擎 solve.v1.json 就是這個順序）。 */
function lowerBoundK(frames: readonly SolveFrame[], target: number): number {
  let lo = 0;
  let hi = frames.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].k < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 序列空間的解算信心帶：對每個屬於 mediaId 的片段，只掃「可視範圍 ∩ 片段」對應的 k，同色連續段合併，
 * 平移 t0 − srcIn 後換成 x。片段接縫一定斷開（兩個片段可能是不相連的來源，連成一段會讓人以為中間也解過）。
 */
export function sequenceSolvedRuns(frames: readonly SolveFrame[], placed: readonly PlacedItem[], mediaId: string, view: SeqView, width: number): BandRun[] {
  const out: BandRun[] = [];
  const px = view.pxPerFrame;
  if (px <= 0 || !frames.length) return out;
  const tv0 = Math.floor(view.scrollFrame);
  const tv1 = Math.ceil(view.scrollFrame + width / px) + 1;
  for (const p of placed) {
    const it = p.item;
    if (it.kind !== "clip" || it.mediaId !== mediaId) continue;
    const t0 = Math.max(p.t0, tv0);
    const t1 = Math.min(p.t1, tv1);
    if (t1 <= t0) continue;
    const shift = p.t0 - it.srcIn;
    let cur: { k0: number; k1: number; band: ConfidenceBand } | null = null;
    const flush = () => {
      if (!cur) return;
      const x0 = xOfFrame(cur.k0 + shift, view.scrollFrame, px);
      const x1 = xOfFrame(cur.k1 + 1 + shift, view.scrollFrame, px);
      if (x1 > 0 && x0 < width) out.push({ x0: Math.max(-1, x0), x1: Math.min(width + 1, x1), band: cur.band });
      cur = null;
    };
    for (let i = lowerBoundK(frames, t0 - shift); i < frames.length && frames[i].k < t1 - shift; i++) {
      const f = frames[i];
      const band = confidenceBand(f);
      if (cur && f.k === cur.k1 + 1 && band === cur.band) {
        cur.k1 = f.k;
        continue;
      }
      flush();
      cur = { k0: f.k, k1: f.k, band };
    }
    flush();
  }
  return out;
}

export interface BadgeTrack {
  mediaId: string;
  /** track 所屬鏡頭的 k 範圍 [a, b)。 */
  range: [number, number];
  /** 格位有替換目標（含 "blank"）：輸出時這條 track 會真的改畫面。 */
  hasTarget: boolean;
}

/** 片段右上徽章「替換 3」：此片段來源範圍內有替換目標的 track 數（§9.2）。 */
export function badgeCount(clip: Pick<VideoClipV2, "mediaId" | "srcIn" | "srcOut">, tracks: readonly BadgeTrack[]): number {
  let n = 0;
  for (const t of tracks) if (t.hasTarget && t.mediaId === clip.mediaId && t.range[0] < clip.srcOut && t.range[1] > clip.srcIn) n++;
  return n;
}

// ---- 音訊片段的把手、音量線、自動化點 ----

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface XY {
  x: number;
  y: number;
}

export const FADE_HANDLE_PX = 8;

/** 淡入 / 淡出把手：片段頂端、淡化長度的終點（淡化為 0 時在角落），8×8 px，永遠留在片段內側。 */
export function fadeHandleRects(x0: number, x1: number, top: number, xFadeInEnd: number, xFadeOutStart: number): { fadeIn: Rect; fadeOut: Rect } {
  const s = FADE_HANDLE_PX;
  const inX = Math.min(Math.max(xFadeInEnd - s / 2, x0), x1 - s);
  const outX = Math.max(Math.min(xFadeOutStart - s / 2, x1 - s), x0);
  return { fadeIn: { x: inX, y: top, w: s, h: s }, fadeOut: { x: outX, y: top, w: s, h: s } };
}

/** 片段增益相關幾何的輸入：V1 原音 = [S(t0), S(t1))、音訊片段 = start / length；top / h 是片段矩形。 */
export interface GainGeom {
  gain: ClipGainV2;
  startSample: number;
  length: number;
  fps: Rational;
  view: SeqView;
  top: number;
  h: number;
}

/** 淡入終點 / 淡出起點的 x。 */
export function fadeEdgesX(g: GainGeom): { xFadeInEnd: number; xFadeOutStart: number } {
  return {
    xFadeInEnd: xOfSample(g.startSample + g.gain.fadeIn, g.fps, g.view),
    xFadeOutStart: xOfSample(g.startSample + g.length - g.gain.fadeOut, g.fps, g.view),
  };
}

/** 自動化點的螢幕座標（y = 片段增益 + 點的 dB）。 */
export function envelopePointsXY(g: GainGeom): XY[] {
  return g.gain.envelope.map((p) => ({ x: xOfSample(g.startSample + p.at, g.fps, g.view), y: gainDbToY(g.gain.gainDb + p.db, g.top, g.h) }));
}

/** 音量線折線：片段頭、每個片段內的自動化點、片段尾（階梯的兩點都保留，垂直段也畫得出來）。 */
export function gainLinePoints(g: GainGeom): XY[] {
  const env = g.gain.envelope;
  const y = (db: number) => gainDbToY(g.gain.gainDb + db, g.top, g.h);
  const pts: XY[] = [{ x: xOfSample(g.startSample, g.fps, g.view), y: y(envelopeDbAt(env, 0, "right")) }];
  for (const p of env) if (p.at > 0 && p.at < g.length) pts.push({ x: xOfSample(g.startSample + p.at, g.fps, g.view), y: y(p.db) });
  pts.push({ x: xOfSample(g.startSample + g.length, g.fps, g.view), y: y(envelopeDbAt(env, g.length, "left")) });
  return pts;
}

/** 折線在 x 處的 y（頭尾之外夾住；垂直段取後一點，跟 envelopeDbAt 的 right 一致）。 */
export function polylineYAt(pts: readonly XY[], x: number): number {
  if (!pts.length) return NaN;
  if (x <= pts[0].x) return pts[0].y;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (x < b.x) return b.x - a.x <= 1e-9 ? b.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  }
  return pts[pts.length - 1].y;
}

// ---- 波形取樣位置（peaks 的時間原點是容器絕對時間，§3.4）----

/** 每像素涵蓋幾個 5 ms 原始桶（片段一律 1× 播放，V1 原音與音訊片段同一個算式）。 */
export function bucketsPerPixel(fps: Rational, pxPerFrame: number, pps = PEAKS_PPS): number {
  return pxPerFrame > 0 ? (pps * fps.den) / (fps.num * pxPerFrame) : 0;
}

/** A0：小數序列幀 t（落在片段 p 內）→ 原始桶座標。容器 µs = videoStartUs + (srcIn + (t − t0))·1e6·den/num（§3.1 absUs）。 */
export function v1BucketAt(t: number, p: { t0: number }, srcIn: number, fps: Rational, videoStartUs: number, pps = PEAKS_PPS): number {
  const us = videoStartUs + ((srcIn + (t - p.t0)) * 1e6 * fps.den) / fps.num;
  return (us * pps) / 1e6;
}

/** 音訊片段：小數序列樣本 s → 原始桶座標。容器 µs = startUs + srcIn·1e6/sr + (s − start)·1e6/48000。 */
export function audioBucketAt(s: number, c: Pick<AudioClipV2, "start" | "srcIn">, src: { startUs: number; sampleRate: number }, pps = PEAKS_PPS): number {
  const sr = src.sampleRate > 0 ? src.sampleRate : SEQ_SAMPLE_RATE;
  const us = src.startUs + (c.srcIn * 1e6) / sr + ((s - c.start) * 1e6) / SEQ_SAMPLE_RATE;
  return (us * pps) / 1e6;
}

/** 小數序列幀 → 小數序列樣本（波形逐欄算增益用）。 */
export function sampleOfFrameExact(t: number, fps: Rational): number {
  return (t * SEQ_SAMPLE_RATE * fps.den) / fps.num;
}
