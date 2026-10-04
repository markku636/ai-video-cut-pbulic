import type { Rational } from "../api";

/**
 * 引擎媒體快取（`<cache>/media/<fp16>/`）的唯讀解析：probe.v1.json / proxy.v1.json / shots.v1.json / index.v1.json。
 * 純函式、不碰 Tauri：對話框用 `api.cacheRead` 讀 bytes、`decodeJson` 之後丟進來。
 *
 * 形狀全部防禦式讀（快取是可重生的產物，舊版 / 寫到一半 / 手改都可能）：欄位不對就是 null，
 * 畫面顯示「—」並講原因，不拿看似可信的假數字填。
 */

/** 引擎 probe.v1.json（engine/src/aivc/media/probe.py `Probe`），色彩標籤取自**解出來的第一幀**。 */
export interface EngineProbe {
  codec: string | null;
  width: number | null;
  height: number | null;
  pixFmt: string | null;
  fps: Rational | null;
  startMs: number | null;
  durationMs: number | null;
  nbFrames: number | null;
  colorRange: string | null;
  colorSpace: string | null;
  colorPrimaries: string | null;
  colorTrc: string | null;
  /** 引擎色彩數學實際採用的矩陣："bt709" | "bt601"。 */
  matrixAssumed: string | null;
  /** "tag"（依標示）| "heuristic"（未標示，依高度推定）。 */
  matrixSource: string | null;
  rotation: number | null;
  hasAudio: boolean | null;
  audioCodec: string | null;
  /** "pyav" | "ffprobe"。 */
  source: string | null;
}

/** proxy.v1.json 原始內容（ops/media.py `proxy_op` 的 meta）。`ProxyMeta` 解析時丟掉的 codec / gop / audio / bytes 在這裡。 */
export interface ProxyInfo {
  width: number | null;
  height: number | null;
  frames: number | null;
  fps: Rational | null;
  scale: number | null;
  codec: string | null;
  gop: number | null;
  /** proxy 音軌編碼；null = 沒有音軌。 */
  audio: string | null;
  bytes: number | null;
  sourceFrames: number | null;
  seconds: number | null;
}

/** shots.v1.json（media/shots.py `save_shots`）。 */
export interface ShotsInfo {
  nFrames: number | null;
  threshold: number | null;
  minLen: number | null;
  cuts: { k: number; score: number; ptsMs: number | null }[];
}

export interface GapInfo {
  /** 斷層之前那個來源幀。 */
  src: number;
  ptsMs: number;
  gapMs: number;
}

/** index.v1.json 的摘要。**絕不帶 pts_ms / key 陣列**（2 小時的片是 20 萬個數字，複製出去沒人看得了）。 */
export interface IndexSummary {
  nSource: number;
  /** CFR 目標 fps（= proxy fps）。 */
  fps: Rational;
  timeBase: Rational | null;
  firstPtsMs: number;
  lastPtsMs: number;
  /** 最後 − 第一 + 中位間隔（最後一幀也要顯示一個間隔那麼久）。 */
  durationMs: number;
  /** (n − 1) × 1000 ÷ (最後 − 第一)。 */
  measuredFps: number | null;
  gaps: {
    minMs: number;
    medianMs: number;
    maxMs: number;
    /** 最大斷層之前那個來源幀與它的 pts。 */
    maxAtSrc: number;
    maxAtMs: number;
    over40Count: number;
    /** 前 20 筆（與引擎 `gap_stats` 同上限）。 */
    over40ms: GapInfo[];
  } | null;
  keyframes: number;
  gop: { meanFrames: number; maxFrames: number; maxMs: number } | null;
  /** 從 CFR runs 算（引擎 `CfrMap`）；舊快取沒有 cfr → null。 */
  cfr: CfrSummary | null;
}

export interface CfrSummary {
  nFrames: number;
  duplicates: number;
  dropped: number;
  runs: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function ratio(v: unknown): Rational | null {
  if (!isRecord(v)) return null;
  const n = num(v.num);
  const d = num(v.den);
  return n != null && d != null && n > 0 && d > 0 ? { num: n, den: d } : null;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

export function parseEngineProbe(raw: unknown): EngineProbe | null {
  if (!isRecord(raw) || raw.version !== 1) return null;
  return {
    codec: str(raw.codec),
    width: num(raw.width),
    height: num(raw.height),
    pixFmt: str(raw.pix_fmt),
    fps: ratio({ num: raw.fps_num, den: raw.fps_den }),
    startMs: num(raw.start_ms),
    durationMs: num(raw.duration_ms),
    nbFrames: num(raw.nb_frames),
    colorRange: str(raw.color_range),
    colorSpace: str(raw.color_space),
    colorPrimaries: str(raw.color_primaries),
    colorTrc: str(raw.color_trc),
    matrixAssumed: str(raw.matrix_assumed),
    matrixSource: str(raw.matrix_source),
    rotation: num(raw.rotation),
    hasAudio: typeof raw.has_audio === "boolean" ? raw.has_audio : null,
    audioCodec: str(raw.audio_codec),
    source: str(raw.source),
  };
}

export function parseProxyInfo(raw: unknown): ProxyInfo | null {
  if (!isRecord(raw) || raw.version !== 1) return null;
  return {
    width: num(raw.width),
    height: num(raw.height),
    frames: num(raw.frames),
    fps: ratio(raw.fps),
    scale: num(raw.scale),
    codec: str(raw.codec),
    gop: num(raw.gop),
    audio: str(raw.audio),
    bytes: num(raw.bytes),
    sourceFrames: num(raw.sourceFrames),
    seconds: num(raw.seconds),
  };
}

export function parseShotsInfo(raw: unknown): ShotsInfo | null {
  if (!isRecord(raw)) return null;
  const params = isRecord(raw.params) ? raw.params : {};
  const cuts = Array.isArray(raw.cuts)
    ? raw.cuts.flatMap((c) => {
        if (!isRecord(c)) return [];
        const k = num(c.k);
        const score = num(c.score);
        return k == null || score == null ? [] : [{ k, score, ptsMs: num(c.pts_ms) }];
      })
    : [];
  return { nFrames: num(raw.nFrames), threshold: num(params.threshold), minLen: num(params.minLen), cuts };
}

/** 相鄰時間戳間隔的統計。中位數取 `sorted[floor(n/2)]`，與引擎 `gap_stats` 一致（偶數個時取上中位），兩邊印出來的數字才對得上。 */
function gapStats(p: number[]): IndexSummary["gaps"] {
  const n = p.length;
  if (n < 2) return null;
  const d: number[] = new Array(n - 1);
  let maxI = 1;
  const over: GapInfo[] = [];
  let overCount = 0;
  for (let i = 1; i < n; i++) {
    const g = p[i] - p[i - 1];
    d[i - 1] = g;
    if (g > p[maxI] - p[maxI - 1]) maxI = i;
    if (g >= 40) {
      overCount++;
      if (over.length < 20) over.push({ src: i - 1, ptsMs: p[i - 1], gapMs: round3(g) });
    }
  }
  d.sort((a, b) => a - b);
  return {
    minMs: round3(d[0]),
    medianMs: round3(d[Math.floor(d.length / 2)]),
    maxMs: round3(d[d.length - 1]),
    maxAtSrc: maxI - 1,
    maxAtMs: p[maxI - 1],
    over40Count: overCount,
    over40ms: over,
  };
}

/**
 * 關鍵幀間距。平均 GOP = 來源幀數 ÷ 關鍵幀數（MediaInfo 的算法）；最長 GOP 同時給幀數與毫秒（VFR 片裡兩者不成比例：
 * 範例第一個 GOP 101 幀卻有 4.5 秒，因為裡面有 1.2 秒斷層）。開頭若不是關鍵幀（剪過的 open-GOP 片段）那一段也算一個 GOP。
 */
function gopStats(p: number[], key: unknown[], medianMs: number): { keyframes: number; gop: IndexSummary["gop"] } {
  const n = p.length;
  const keyIdx: number[] = [];
  for (let i = 0; i < n; i++) if (key[i]) keyIdx.push(i);
  if (!keyIdx.length) return { keyframes: 0, gop: null };
  const bounds = keyIdx[0] > 0 ? [0, ...keyIdx, n] : [...keyIdx, n];
  let maxFrames = 0;
  let maxMs = 0;
  for (let i = 0; i + 1 < bounds.length; i++) {
    const a = bounds[i];
    const b = bounds[i + 1];
    const end = b < n ? p[b] : p[n - 1] + medianMs;
    maxFrames = Math.max(maxFrames, b - a);
    maxMs = Math.max(maxMs, end - p[a]);
  }
  return { keyframes: keyIdx.length, gop: { meanFrames: n / keyIdx.length, maxFrames, maxMs: round3(maxMs) } };
}

/** index.v1.json → 摘要。形狀不對（版本、長度對不上、非數字）回 null：對話框顯示「讀不懂」，不猜。 */
export function summarizeIndex(raw: unknown): IndexSummary | null {
  if (!isRecord(raw) || raw.version !== 1) return null;
  const fps = ratio(raw.fps);
  const pts = raw.pts_ms;
  const key = raw.key;
  if (!fps || !Array.isArray(pts) || !Array.isArray(key) || pts.length === 0 || key.length !== pts.length) return null;
  if (!pts.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
  const p = pts as number[];
  const n = p.length;
  if (raw.n != null && raw.n !== n) return null;
  const gaps = gapStats(p);
  const span = p[n - 1] - p[0];
  const { keyframes, gop } = gopStats(p, key, gaps?.medianMs ?? 0);
  return {
    nSource: n,
    fps,
    timeBase: ratio(raw.time_base),
    firstPtsMs: p[0],
    lastPtsMs: p[n - 1],
    durationMs: round3(span + (gaps?.medianMs ?? 0)),
    measuredFps: n >= 2 && span > 0 ? ((n - 1) * 1000) / span : null,
    gaps,
    keyframes,
    gop,
    cfr: summarizeCfr(raw.cfr, n),
  };
}

/**
 * CFR runs `[[k0, src0, count], …]`（k0..k0+count−1 依序對到 src0..src0+count−1）→ 重複 / 丟幀數。
 * 不展開成逐幀陣列：run 內部一定是 1:1，重複只可能出現在 run 交界（新 run 的 src0 = 上一個 run 的最後一個 src），
 * 丟幀只可能是交界跳號或頭尾沒蓋到。runs 不連續、幀數或來源數對不上 → null（壞快取不能給出看似可信的數字）。
 */
export function summarizeCfr(raw: unknown, nSource: number): CfrSummary | null {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.runs)) return null;
  const nFrames = num(raw.nFrames);
  if (nFrames == null || num(raw.nSource) !== nSource) return null;
  let expectK = 0;
  let lastSrc = -1;
  let duplicates = 0;
  let dropped = 0;
  for (const r of raw.runs) {
    if (!Array.isArray(r) || r.length !== 3 || !r.every((x) => Number.isInteger(x))) return null;
    const [k0, s0, c] = r as number[];
    if (k0 !== expectK || c <= 0 || s0 < 0) return null;
    if (expectK > 0 && s0 === lastSrc) duplicates++;
    else if (s0 < lastSrc) return null; // 時間倒退：不是引擎寫的
    else dropped += s0 - lastSrc - 1;
    expectK += c;
    lastSrc = s0 + c - 1;
  }
  if (expectK !== nFrames || lastSrc >= nSource) return null;
  dropped += nSource - 1 - lastSrc;
  return { nFrames, duplicates, dropped, runs: raw.runs.length };
}
