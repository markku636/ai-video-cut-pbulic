import { create } from "zustand";
import { useLang } from "../i18n";
import type { EngineWarning } from "../pipeline/captionWarnings";
import {
  CAPTION_PRESET_IDS,
  isRecord,
  type CaptionCueFlag,
  type CaptionCueV1,
  type CaptionPresetId,
  type CaptionSegmentationV1,
  type CaptionStyleV1,
  type CaptionTrackV1,
  type CaptionWordV1,
  type Rational,
} from "../project/format";

/**
 * 動態字幕的純邏輯（預設樣式 / 樣式合併 / 斷詞與重新配時 / 編輯 reducer / 尋找取代 / 幀↔時間）＋ 字幕面板的暫態 UI store。
 *
 * 為什麼編輯 reducer 寫成純函式放這裡、store/edits.ts 只負責 commit：
 * 分割 / 合併 / 微調這些規則（不重疊、每段 ≥ 1 幀、字在段內）是字幕資料的不變式，vitest 要能不開任何 store 直接驗；
 * edits.ts 只管「一個動作 = 一筆 undo」。
 *
 * 預設樣式表（CAPTION_PRESETS）是 SoT，引擎 `aivc/captions/presets.v1.json` 鏡射它（vitest 在那份檔存在時逐欄比對）。
 */

// ---------------------------------------------------------------------------
// 預設樣式（規格 §5.2；尺寸是畫面短邊的 %，中日韓字算 2 單位）
// ---------------------------------------------------------------------------

/** 系統字型回退清單（不內嵌字型：Windows 微軟正黑體、macOS 蘋方、Linux Noto Sans CJK；授權見 THIRD-PARTY-NOTICES）。 */
export const CAPTION_FONT_FAMILIES: readonly string[] = ["Microsoft JhengHei", "PingFang TC", "Noto Sans CJK TC", "Noto Sans TC", "sans-serif"];

export interface CaptionPresetV1 {
  id: CaptionPresetId;
  /** 中日韓語言一套、拉丁語言一套：同一個「一行 16 個中文字」換成英文是 42 個字母，不能共用單位上限。 */
  segmentation: { cjk: CaptionSegmentationV1; latin: CaptionSegmentationV1 };
  style: CaptionStyleV1;
}

const SUBTITLE_STYLE: CaptionStyleV1 = {
  font: { families: [...CAPTION_FONT_FAMILIES], weight: 700, sizePctShortSide: 5.2, file: null, letterSpacingEm: 0, uppercaseLatin: false, cjkLatinSpace: true },
  layout: { maxWidthPct: 90, lineHeight: 1.25, align: "center", anchor: "bottom", offsetYPct: 0, safeArea: "auto" },
  colors: { text: "#FFFFFF", future: null, active: null, past: null, emphasis: "#FFFFFF", stroke: "#000000" },
  stroke: { widthPct: 8 },
  shadow: { color: "#000000A0", dxPct: 0, dyPct: 3, blurPct: 3 },
  box: { mode: "none", color: "#00000099", padEm: 0.3, radiusEm: 0.2 },
  animation: { cueIn: "fade", cueInMs: 80, cueOut: "fade", cueOutMs: 80, word: "none", wordMs: 0, activeScale: 1, emphasisScale: 1 },
};

function seg(p: Partial<CaptionSegmentationV1> & Pick<CaptionSegmentationV1, "mode" | "maxUnitsPerLine">): CaptionSegmentationV1 {
  return { maxLines: 2, maxWords: null, minDurationMs: 400, maxDurationMs: 2500, gapFrames: 0, chainGapMs: 300, lagOutMs: 150, pauseBreakMs: 350, snapToShots: false, cpsWarn: null, ...p };
}

function style(patch: DeepPartial<CaptionStyleV1>): CaptionStyleV1 {
  return deepMerge(SUBTITLE_STYLE, patch);
}

const SUBTITLE_SEG = { mode: "sentence", maxLines: 2, maxWords: null, minDurationMs: 833, maxDurationMs: 7000, gapFrames: 2, chainGapMs: 500, lagOutMs: 400, pauseBreakMs: 700, snapToShots: true } as const;

export const CAPTION_PRESETS: Readonly<Record<CaptionPresetId, CaptionPresetV1>> = {
  subtitle: {
    id: "subtitle",
    segmentation: { cjk: seg({ ...SUBTITLE_SEG, maxUnitsPerLine: 32, cpsWarn: 9 }), latin: seg({ ...SUBTITLE_SEG, maxUnitsPerLine: 42, cpsWarn: 20 }) },
    style: SUBTITLE_STYLE,
  },
  karaoke: {
    id: "karaoke",
    segmentation: { cjk: seg({ mode: "phrase", maxUnitsPerLine: 24, maxWords: 5 }), latin: seg({ mode: "phrase", maxUnitsPerLine: 32, maxWords: 5 }) },
    style: style({
      font: { weight: 800, sizePctShortSide: 6.0 },
      colors: { text: "#FFFFFF", future: "#FFFFFF", active: "#FFD60A", past: "#FFD60A", emphasis: "#FFD60A" },
      stroke: { widthPct: 10 },
      animation: { cueIn: "fade", cueInMs: 60, cueOut: "fade", cueOutMs: 60, word: "karaokeWipe", wordMs: 0 },
    }),
  },
  pop: {
    id: "pop",
    segmentation: {
      cjk: seg({ mode: "phrase", maxUnitsPerLine: 12, maxWords: 3, minDurationMs: 300, maxDurationMs: 2000, pauseBreakMs: 300 }),
      latin: seg({ mode: "phrase", maxUnitsPerLine: 16, maxWords: 3, minDurationMs: 300, maxDurationMs: 2000, pauseBreakMs: 300 }),
    },
    style: style({
      font: { weight: 900, sizePctShortSide: 9.0, uppercaseLatin: true },
      layout: { anchor: "middle" },
      colors: { text: "#FFFFFF", active: "#FFE600", emphasis: "#22C55E" },
      stroke: { widthPct: 12 },
      shadow: { color: "#000000A0", dxPct: 0, dyPct: 4, blurPct: 3 },
      animation: { cueIn: "pop", cueInMs: 150, cueOut: "none", cueOutMs: 0, word: "pop", wordMs: 120, activeScale: 1.15, emphasisScale: 1.1 },
    }),
  },
  bounce: {
    id: "bounce",
    segmentation: {
      cjk: seg({ mode: "word", maxUnitsPerLine: 8, maxLines: 1, maxWords: 1, minDurationMs: 250, maxDurationMs: 1200, chainGapMs: 0, lagOutMs: 0, pauseBreakMs: 250 }),
      latin: seg({ mode: "word", maxUnitsPerLine: 16, maxLines: 1, maxWords: 1, minDurationMs: 250, maxDurationMs: 1200, chainGapMs: 0, lagOutMs: 0, pauseBreakMs: 250 }),
    },
    style: style({
      font: { weight: 900, sizePctShortSide: 11 },
      layout: { anchor: "middle" },
      colors: { text: "#FFFFFF", emphasis: "#FFE600" },
      stroke: { widthPct: 14 },
      animation: { cueIn: "spring", cueInMs: 180, cueOut: "none", cueOutMs: 0, word: "none", wordMs: 0 },
    }),
  },
  typewriter: {
    id: "typewriter",
    segmentation: { cjk: seg({ ...SUBTITLE_SEG, maxUnitsPerLine: 32, cpsWarn: 9 }), latin: seg({ ...SUBTITLE_SEG, maxUnitsPerLine: 42, cpsWarn: 20 }) },
    style: {
      ...style({
        box: { mode: "line", color: "#00000099", padEm: 0.3, radiusEm: 0.2 },
        stroke: { widthPct: 0 },
        animation: { cueIn: "none", cueInMs: 0, cueOut: "fade", cueOutMs: 100, word: "typewriter", wordMs: 0 },
      }),
      // 有底框就不需要陰影（深層合併不能把物件合併成 null，所以這一欄直接指定）
      shadow: null,
    },
  },
  boxHighlight: {
    id: "boxHighlight",
    segmentation: { cjk: seg({ mode: "phrase", maxUnitsPerLine: 20, maxWords: 5 }), latin: seg({ mode: "phrase", maxUnitsPerLine: 28, maxWords: 5 }) },
    style: style({
      font: { weight: 800, sizePctShortSide: 6.5 },
      box: { mode: "activeWord", color: "#7C3AED", padEm: 0.12, radiusEm: 0.25 },
      animation: { cueIn: "slideUp", cueInMs: 120, cueOut: "none", cueOutMs: 0, word: "boxMove", wordMs: 90 },
    }),
  },
};

export function isCaptionPresetId(v: unknown): v is CaptionPresetId {
  return typeof v === "string" && (CAPTION_PRESET_IDS as readonly string[]).includes(v);
}

/** zh / ja / ko（含 zh-TW、yue）→ 中日韓分段表。 */
export function isCjkLanguage(lang: string | null | undefined): boolean {
  return !!lang && /^(zh|ja|ko|yue|cmn|wuu)\b/i.test(lang);
}

export function presetSegmentation(id: CaptionPresetId, language: string | null | undefined): CaptionSegmentationV1 {
  const p = CAPTION_PRESETS[id] ?? CAPTION_PRESETS.subtitle;
  return { ...(isCjkLanguage(language) ? p.segmentation.cjk : p.segmentation.latin) };
}

// ---------------------------------------------------------------------------
// 樣式合併：PRESET ← track.style ← cue.styleOverride
// ---------------------------------------------------------------------------

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object | null ? DeepPartial<NonNullable<T[K]>> | Extract<T[K], null> : T[K] };

function plain(v: unknown): v is Record<string, unknown> {
  return isRecord(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/**
 * 深層合併：兩邊都是一般物件才往下走；陣列、null、純量一律整個換掉；undefined 不動。
 * null 要能「蓋掉」物件（shadow: null = 不要陰影、colors.future: null = 沿用 text），所以不能把 null 當成「沒給」。
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!plain(patch) || !plain(base)) return (patch === undefined ? base : (patch as T));
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const cur = out[k];
    out[k] = plain(cur) && plain(v) ? deepMerge(cur, v) : v;
  }
  return out as T;
}

export function effectiveStyle(track: Pick<CaptionTrackV1, "presetId" | "style">, cue?: Pick<CaptionCueV1, "styleOverride"> | null): CaptionStyleV1 {
  const preset = (CAPTION_PRESETS[track.presetId] ?? CAPTION_PRESETS.subtitle).style;
  const withTrack = deepMerge(preset, track.style);
  return cue?.styleOverride ? deepMerge(withTrack, cue.styleOverride) : withTrack;
}

// ---------------------------------------------------------------------------
// 幀 ↔ 時間（規格 §5.3 A）
// ---------------------------------------------------------------------------

/** 秒 → proxy 幀：floor(t·num/den + 0.5)。 */
export function frameOfSeconds(t: number, fps: Rational): number {
  return Math.floor((t * fps.num) / fps.den + 0.5);
}

/** proxy 幀 → 毫秒：round(k·1000·den/num)。30000/1001 的第 1799 幀 = 60027 ms。 */
export function msOfFrame(k: number, fps: Rational): number {
  return Math.round((k * 1000 * fps.den) / fps.num);
}

/** 毫秒長度 → 幀數（四捨五入）。 */
export function framesOfMs(ms: number, fps: Rational): number {
  return Math.round((ms * fps.num) / (fps.den * 1000));
}

function hms(ms: number, sep: string): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(t % 1000, 3)}`;
}

/** SRT：00:01:00,027。 */
export function srtTimestamp(ms: number): string {
  return hms(ms, ",");
}

/** WebVTT：00:01:00.027。 */
export function vttTimestamp(ms: number): string {
  return hms(ms, ".");
}

// ---------------------------------------------------------------------------
// 文字：寬度單位 / 斷詞 / 合字
// ---------------------------------------------------------------------------

const CJK_LETTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** 不能出現在行首 / 要黏在前一個字後面的標點（中英都算）。 */
export const CLOSING_PUNCT = "，。、；：？！」』）》〉】…—%,.;:?!)]}'\"”’";
/** 不能出現在行尾 / 要黏在下一個字前面的標點。 */
export const OPENING_PUNCT = "「『（《〈【([{“‘";
export const SENTENCE_END = "。？！.?!";

export function isCjkChar(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return (
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x20000 && c <= 0x3fffd)
  );
}

/** 顯示寬度單位：中日韓（含全形標點）算 2，其餘算 1（跟 segmentation.maxUnitsPerLine 同一把尺）。 */
export function displayUnits(s: string): number {
  let w = 0;
  for (const ch of s) w += isCjkChar(ch) ? 2 : 1;
  return w;
}

/**
 * 文字 → token：中日韓逐字、拉丁逐詞（空白切）；收尾標點黏前一個 token、開頭標點黏下一個 token。
 * 這跟引擎 ASR 正規化後的字粒度一致（中文 word 是一個字），重新配時才對得上。
 */
export function tokenizeText(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let pendingOpen = "";
  const flush = () => {
    if (cur) out.push(cur);
    cur = "";
  };
  for (const ch of text.normalize("NFC")) {
    if (/\s/u.test(ch)) {
      flush();
      continue;
    }
    if (CLOSING_PUNCT.includes(ch)) {
      if (cur) cur += ch;
      else if (out.length && !pendingOpen) out[out.length - 1] += ch;
      else {
        cur = pendingOpen + ch;
        pendingOpen = "";
      }
      continue;
    }
    if (OPENING_PUNCT.includes(ch)) {
      flush();
      pendingOpen += ch;
      continue;
    }
    if (CJK_LETTER.test(ch) || isCjkChar(ch)) {
      flush();
      out.push(pendingOpen + ch);
      pendingOpen = "";
      continue;
    }
    if (!cur) {
      cur = pendingOpen;
      pendingOpen = "";
    }
    cur += ch;
  }
  flush();
  if (pendingOpen) out.push(pendingOpen);
  return out;
}

const LATIN_ALNUM = /[\p{L}\p{N}]/u;
// 跟引擎 aivc/captions/text.py needs_space 同一組正規表示式：斷行量寬、匯出文字、面板顯示三邊空白才一致
const LATIN_TAIL = /[A-Za-z0-9)\]}"'.,!?;:%$]$/;
const LATIN_HEAD = /^[A-Za-z0-9([{"'$#@&+]/;

function isLatinAlnum(ch: string): boolean {
  return LATIN_ALNUM.test(ch) && !CJK_LETTER.test(ch) && !isCjkChar(ch);
}

/** 兩個 token 之間要不要空白：兩邊都是西文（needs_space）；`cjkLatinSpace` 時中文字（不含標點）與英數交界也要。 */
export function needsSpace(prev: string, next: string, cjkLatinSpace = false): boolean {
  if (!prev || !next) return false;
  if (LATIN_TAIL.test(prev) && LATIN_HEAD.test(next)) return true;
  if (!cjkLatinSpace) return false;
  const a = [...prev].pop() ?? "";
  const b = [...next][0] ?? "";
  return (CJK_LETTER.test(a) && isLatinAlnum(b)) || (isLatinAlnum(a) && CJK_LETTER.test(b));
}

/**
 * token → 顯示文字：拉丁詞之間補空白、中文字之間不補；`cjkLatinSpace` 時中文字與英數之間補一個空白（「使用 GPU 加速」）。
 * ASR 的拉丁詞常帶前導空白（" to"），先 trim 再決定，才不會出現雙空白。
 */
export function joinWords(words: readonly string[], cjkLatinSpace = false): string {
  let out = "";
  for (const raw of words) {
    const w = raw.trim();
    if (!w) continue;
    out += out && needsSpace(out, w, cjkLatinSpace) ? ` ${w}` : w;
  }
  return out;
}

export function cueText(cue: Pick<CaptionCueV1, "words">, cjkLatinSpace = false): string {
  return joinWords(
    cue.words.map((w) => w.text),
    cjkLatinSpace,
  );
}

// ---------------------------------------------------------------------------
// 重新配時（改字之後）
// ---------------------------------------------------------------------------

/** 把 tokens 併成最多 n 組（幀數不夠一字一幀時，後面的字合在一起）。 */
function packTokens(tokens: string[], n: number): string[] {
  if (tokens.length <= n) return tokens;
  const per = tokens.length / n;
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(joinWords(tokens.slice(Math.round(i * per), Math.round((i + 1) * per))));
  return out.filter(Boolean);
}

/**
 * 改字之後的字時間（規格 §5.7 retime.ts）：
 * - 字數沒變 → 沿用每個字原本的時間（改錯字是最常見的情況，卡拉OK 的逐字時間不該因為修一個字就全部洗掉）；
 * - 字數變了 → 在**舊的字時間總跨度**上依顯示寬度平均分配，每個字 ≥ 1 幀；跨度不夠就退到整段、再不夠就把字併起來。
 * 原本標了強調的字、文字一樣的話保留強調。回 null = 文字清空（呼叫端決定要不要刪段）。
 */
export function retimeWords(old: readonly CaptionWordV1[], text: string, cueStart: number, cueEnd: number): CaptionWordV1[] | null {
  let tokens = tokenizeText(text);
  if (!tokens.length) return null;
  if (tokens.length === old.length) {
    if (tokens.every((tk, i) => tk === old[i].text.trim())) return old.slice();
    return tokens.map((tk, i) => (tk === old[i].text.trim() ? old[i] : { text: tk, startFrame: old[i].startFrame, endFrame: old[i].endFrame, source: "user" as const, ...(old[i].emphasis ? { emphasis: true } : {}) }));
  }
  let start = old[0]?.startFrame ?? cueStart;
  let end = old[old.length - 1]?.endFrame ?? cueEnd;
  if (end - start < tokens.length) {
    start = cueStart;
    end = cueEnd;
  }
  if (end - start < tokens.length) tokens = packTokens(tokens, Math.max(1, end - start));
  const n = tokens.length;
  const weights = tokens.map((tk) => Math.max(1, displayUnits(tk)));
  const sum = weights.reduce((a, b) => a + b, 0);
  const total = end - start;
  const emph = new Set(old.filter((w) => w.emphasis).map((w) => w.text.trim()));
  const out: CaptionWordV1[] = [];
  let acc = 0;
  let prev = start;
  for (let i = 0; i < n; i++) {
    acc += weights[i];
    const ideal = i === n - 1 ? end : Math.round(start + (total * acc) / sum);
    const b = Math.min(end - (n - 1 - i), Math.max(prev + 1, ideal));
    out.push({ text: tokens[i], startFrame: prev, endFrame: b, source: "user", ...(emph.has(tokens[i]) ? { emphasis: true } : {}) });
    prev = b;
  }
  return out;
}

/**
 * 把字塞進 [start, end)：先往後推（不早於 start、不重疊），再往前壓（不晚於 end）。
 * 呼叫端保證 end - start ≥ 字數，這樣兩趟之後每個字都 ≥ 1 幀、都在段內（證明見 captions.test.ts 的邊界案例）。
 */
export function fitWords(words: readonly CaptionWordV1[], start: number, end: number): CaptionWordV1[] {
  const fwd: CaptionWordV1[] = [];
  let prevEnd = start;
  for (const w of words) {
    const s = Math.max(w.startFrame, prevEnd);
    const e = Math.max(s + 1, w.endFrame);
    fwd.push(s === w.startFrame && e === w.endFrame ? w : { ...w, startFrame: s, endFrame: e });
    prevEnd = e;
  }
  const out = fwd.slice();
  let nextStart = end;
  for (let i = out.length - 1; i >= 0; i--) {
    const w = out[i];
    const e = Math.min(w.endFrame, nextStart);
    const s = Math.min(w.startFrame, e - 1);
    if (s !== w.startFrame || e !== w.endFrame) out[i] = { ...w, startFrame: s, endFrame: e };
    nextStart = s;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 編輯 reducer（純函式；不能做 → 回 null，呼叫端就不留一筆空 undo）
// ---------------------------------------------------------------------------

export const LOW_CONFIDENCE_PROB = 0.45;

/** 使用者動過的段：低信心依剩下的字重算、版面 / 語速警告等引擎重算（overflow / tooFast 丟掉）、加 edited；疑似幻覺留著讓人自己決定刪不刪。 */
export function editedFlags(cue: Pick<CaptionCueV1, "flags" | "words">): CaptionCueFlag[] {
  const out: CaptionCueFlag[] = [];
  if (cue.words.some((w) => typeof w.prob === "number" && w.prob < LOW_CONFIDENCE_PROB)) out.push("lowConfidence");
  if (cue.flags?.includes("hallucination")) out.push("hallucination");
  out.push("edited");
  return out;
}

function touched(cue: CaptionCueV1): CaptionCueV1 {
  return { ...cue, flags: editedFlags(cue) };
}

/** 下一個段 id：c<最大編號+1>（引擎 captions.build 用 c1、c2…）。 */
export function nextCueId(cues: readonly Pick<CaptionCueV1, "id">[]): string {
  let n = 0;
  for (const c of cues) {
    const m = /^c(\d+)$/.exec(c.id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  const ids = new Set(cues.map((c) => c.id));
  let id = `c${n + 1}`;
  while (ids.has(id)) id = `c${++n + 1}`;
  return id;
}

export function cueIndex(cues: readonly CaptionCueV1[], cueId: string): number {
  return cues.findIndex((c) => c.id === cueId);
}

/** 涵蓋 frame 的段（二分搜尋；段依時間排序且不重疊）。 */
export function cueAtFrame<T extends Pick<CaptionCueV1, "startFrame" | "endFrame">>(cues: readonly T[], frame: number): T | null {
  let lo = 0;
  let hi = cues.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cues[mid];
    if (frame < c.startFrame) hi = mid - 1;
    else if (frame >= c.endFrame) lo = mid + 1;
    else return c;
  }
  return null;
}

/**
 * 在第 wordIndex 個字之前切開（1 ≤ wordIndex < 字數）：前段 [start, 那個字的起點)、後段 [那個字的起點, end)。
 * **字的時間一格都不動**，只是分給兩段 —— 這樣切完再合併會回到原樣。
 */
export function splitCue(cues: readonly CaptionCueV1[], cueId: string, wordIndex: number, newId = nextCueId(cues)): CaptionCueV1[] | null {
  const i = cueIndex(cues, cueId);
  if (i < 0) return null;
  const c = cues[i];
  if (!Number.isInteger(wordIndex) || wordIndex < 1 || wordIndex >= c.words.length) return null;
  const cut = c.words[wordIndex].startFrame;
  if (cut <= c.startFrame || cut >= c.endFrame) return null;
  const head = touched({ ...c, endFrame: cut, words: c.words.slice(0, wordIndex) });
  const tail = touched({ ...c, id: newId, startFrame: cut, words: c.words.slice(wordIndex) });
  return [...cues.slice(0, i), head, tail, ...cues.slice(i + 1)];
}

/** 播放線落在的段、離播放線最近的字邊界（CapCut 的 B 鍵）。 */
export function splitPointAt(cues: readonly CaptionCueV1[], frame: number): { cueId: string; wordIndex: number } | null {
  const c = cueAtFrame(cues, frame);
  if (!c || c.words.length < 2) return null;
  let best = -1;
  let bestD = Infinity;
  for (let j = 1; j < c.words.length; j++) {
    const d = Math.abs(c.words[j].startFrame - frame);
    if (d < bestD) {
      bestD = d;
      best = j;
    }
  }
  return best > 0 ? { cueId: c.id, wordIndex: best } : null;
}

/** 跟下一段合併：字串接、時間 [a.start, b.end)、樣式覆寫與講者沿用前段。中間的空隙併進來（段內可以有停頓）。 */
export function mergeCueWithNext(cues: readonly CaptionCueV1[], cueId: string): CaptionCueV1[] | null {
  const i = cueIndex(cues, cueId);
  if (i < 0 || i + 1 >= cues.length) return null;
  const a = cues[i];
  const b = cues[i + 1];
  const merged = touched({ ...a, endFrame: b.endFrame, words: [...a.words, ...b.words], flags: [...new Set([...(a.flags ?? []), ...(b.flags ?? [])])] });
  return [...cues.slice(0, i), merged, ...cues.slice(i + 2)];
}

export type NudgeEdge = "start" | "end" | "both";

/**
 * 微調段的起點 / 終點 / 整段（幀）。夾住：不跟前後段重疊、不出 [0, frames]、段長 ≥ 字數（每個字 ≥ 1 幀）。
 * 整段移動時字一起平移；只動一邊時字被 fitWords 擠進新範圍。夾完沒動 → null。
 */
export function nudgeCue(cues: readonly CaptionCueV1[], cueId: string, d: number, edge: NudgeEdge, frames: number | null = null): CaptionCueV1[] | null {
  const i = cueIndex(cues, cueId);
  if (i < 0 || !Number.isFinite(d) || d === 0) return null;
  const c = cues[i];
  const lo = i > 0 ? cues[i - 1].endFrame : 0;
  const hi = i + 1 < cues.length ? cues[i + 1].startFrame : frames != null && frames > 0 ? frames : Number.MAX_SAFE_INTEGER;
  const minLen = Math.max(1, c.words.length);
  const step = Math.round(d);
  let next: CaptionCueV1;
  if (edge === "both") {
    const dd = Math.max(lo - c.startFrame, Math.min(hi - c.endFrame, step));
    if (!dd) return null;
    next = { ...c, startFrame: c.startFrame + dd, endFrame: c.endFrame + dd, words: c.words.map((w) => ({ ...w, startFrame: w.startFrame + dd, endFrame: w.endFrame + dd })) };
  } else if (edge === "start") {
    const s = Math.max(lo, Math.min(c.endFrame - minLen, c.startFrame + step));
    if (s === c.startFrame) return null;
    next = { ...c, startFrame: s, words: fitWords(c.words, s, c.endFrame) };
  } else {
    const e = Math.min(hi, Math.max(c.startFrame + minLen, c.endFrame + step));
    if (e === c.endFrame) return null;
    next = { ...c, endFrame: e, words: fitWords(c.words, c.startFrame, e) };
  }
  const out = cues.slice();
  out[i] = touched(next);
  return out;
}

/** 改一段的文字（重新配時見 retimeWords）；文字清空或沒變 → null。 */
export function setCueText(cues: readonly CaptionCueV1[], cueId: string, text: string): CaptionCueV1[] | null {
  const i = cueIndex(cues, cueId);
  if (i < 0) return null;
  const c = cues[i];
  const words = retimeWords(c.words, text, c.startFrame, c.endFrame);
  if (!words || (words.length === c.words.length && words.every((w, j) => w === c.words[j]))) return null;
  const out = cues.slice();
  out[i] = touched({ ...c, words: fitWords(words, c.startFrame, c.endFrame) });
  return out;
}

export function toggleEmphasis(cues: readonly CaptionCueV1[], cueId: string, wordIndex: number): CaptionCueV1[] | null {
  const i = cueIndex(cues, cueId);
  if (i < 0) return null;
  const c = cues[i];
  const w = c.words[wordIndex];
  if (!w) return null;
  const { emphasis: _e, ...rest } = w;
  const nw: CaptionWordV1 = w.emphasis ? rest : { ...w, emphasis: true };
  const out = cues.slice();
  out[i] = { ...c, words: c.words.map((x, j) => (j === wordIndex ? nw : x)) };
  return out;
}

export function deleteCue(cues: readonly CaptionCueV1[], cueId: string): CaptionCueV1[] | null {
  const i = cueIndex(cues, cueId);
  return i < 0 ? null : [...cues.slice(0, i), ...cues.slice(i + 1)];
}

export function setCueHidden(cues: readonly CaptionCueV1[], cueId: string, hidden: boolean): CaptionCueV1[] | null {
  const i = cueIndex(cues, cueId);
  if (i < 0 || !!cues[i].hidden === hidden) return null;
  const { hidden: _h, ...rest } = cues[i];
  const out = cues.slice();
  out[i] = hidden ? { ...rest, hidden: true } : rest;
  return out;
}

/**
 * 在 frame 插一段新字幕（預設長 durationFrames，夾在前後段的空隙裡）。frame 落在既有段內 / 空隙不到 1 幀 → null。
 * 回傳新陣列與新段 id。
 */
export function insertCueAt(cues: readonly CaptionCueV1[], frame: number, text: string, durationFrames: number, frames: number | null = null): { cues: CaptionCueV1[]; id: string } | null {
  const f = Math.max(0, Math.round(frame));
  if (cueAtFrame(cues, f)) return null;
  const nextIdx = cues.findIndex((c) => c.startFrame > f);
  const limit = Math.min(nextIdx < 0 ? (frames != null && frames > 0 ? frames : Number.MAX_SAFE_INTEGER) : cues[nextIdx].startFrame, f + Math.max(1, Math.round(durationFrames)));
  if (limit <= f) return null;
  const words = retimeWords([], text, f, limit);
  if (!words) return null;
  const id = nextCueId(cues);
  const cue: CaptionCueV1 = { id, startFrame: f, endFrame: limit, words: words.map((w) => ({ ...w, source: "user" })), flags: ["edited"] };
  const at = nextIdx < 0 ? cues.length : nextIdx;
  return { cues: [...cues.slice(0, at), cue, ...cues.slice(at)], id };
}

// ---------------------------------------------------------------------------
// 尋找 / 取代
// ---------------------------------------------------------------------------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findMatchCount(text: string, query: string, caseSensitive = false): number {
  if (!query) return 0;
  return (text.match(new RegExp(escapeRe(query), caseSensitive ? "g" : "gi")) ?? []).length;
}

/** 有符合的段 id（依時間）。 */
export function findCues(cues: readonly CaptionCueV1[], query: string, opts: { caseSensitive?: boolean; cjkLatinSpace?: boolean } = {}): string[] {
  if (!query) return [];
  return cues.filter((c) => findMatchCount(cueText(c, opts.cjkLatinSpace), query, opts.caseSensitive) > 0).map((c) => c.id);
}

/** 全部取代（字面比對，不是正規表示式）：改到的段重新配時。回傳新陣列與取代次數；沒有任何符合 → null。 */
export function replaceInCues(cues: readonly CaptionCueV1[], query: string, replacement: string, opts: { caseSensitive?: boolean; cjkLatinSpace?: boolean; cueIds?: readonly string[] } = {}): { cues: CaptionCueV1[]; count: number } | null {
  if (!query) return null;
  const re = new RegExp(escapeRe(query), opts.caseSensitive ? "g" : "gi");
  const only = opts.cueIds ? new Set(opts.cueIds) : null;
  let count = 0;
  let out: CaptionCueV1[] = cues.slice();
  for (const c of cues) {
    if (only && !only.has(c.id)) continue;
    const text = cueText(c, opts.cjkLatinSpace);
    const n = findMatchCount(text, query, opts.caseSensitive);
    if (!n) continue;
    const next = setCueText(out, c.id, text.replace(re, () => replacement));
    if (!next) continue;
    out = next;
    count += n;
  }
  return count ? { cues: out, count } : null;
}

// ---------------------------------------------------------------------------
// LLM 校對建議
// ---------------------------------------------------------------------------

/**
 * 片語 → 逐字強調：把段的字（trim、小寫）串起來找片語，片語涵蓋到的每個字都標 emphasis。沒有任何改變回原陣列。
 * 規格 §5.4：強調要比對到「字的片段」，不是單一字元（LLM 挑出「樂」「8。」這種單字強調是實測到的失敗）。
 */
export function markEmphasis(words: readonly CaptionWordV1[], phrases: readonly string[]): readonly CaptionWordV1[] {
  const parts = words.map((w) => w.text.trim().toLowerCase());
  const starts: number[] = [];
  let joined = "";
  for (const p of parts) {
    starts.push(joined.length);
    joined += p;
  }
  const hit = new Set<number>();
  for (const ph of phrases) {
    const q = ph.replace(/\s+/g, "").toLowerCase();
    if (!q) continue;
    for (let at = joined.indexOf(q); at >= 0; at = joined.indexOf(q, at + q.length)) {
      for (let i = 0; i < parts.length; i++) if (starts[i] + parts[i].length > at && starts[i] < at + q.length) hit.add(i);
    }
  }
  if (![...hit].some((i) => !words[i].emphasis)) return words;
  return words.map((w, i) => (hit.has(i) && !w.emphasis ? { ...w, emphasis: true } : w));
}

/** 套用校對建議：改字（重新配時、來源標 llm）＋ 片語強調。回傳新陣列與實際改到幾段。 */
export function applyProposals(cues: readonly CaptionCueV1[], items: readonly { cueId: string; text: string; emphasis?: readonly string[] }[]): { cues: CaptionCueV1[]; changed: number } {
  let out: CaptionCueV1[] = cues.slice();
  let changed = 0;
  for (const it of items) {
    const i = cueIndex(out, it.cueId);
    if (i < 0) continue;
    const textChanged = setCueText(out, it.cueId, it.text);
    const base = textChanged ? textChanged[i] : out[i];
    const words = markEmphasis(base.words, it.emphasis ?? []);
    if (!textChanged && words === base.words) continue;
    // 只有這次新長出來的字標 llm；原本就在（物件沒換）的字維持原來的來源
    const kept = new Set(out[i].words);
    const next = (textChanged ?? out).slice();
    next[i] = { ...base, words: words.map((w) => (!kept.has(w) && w.source === "user" ? { ...w, source: "llm" as const } : w)) };
    out = next;
    changed++;
  }
  return { cues: out, changed };
}

// ---------------------------------------------------------------------------
// 其他查詢
// ---------------------------------------------------------------------------

/** 需要人看一眼的段（Inspector 分頁小數字）：低信心 / 疑似幻覺 / 太快 / 排不下。edited 不算。 */
export function isFlaggedCue(c: Pick<CaptionCueV1, "flags">): boolean {
  return !!c.flags?.some((f) => f !== "edited");
}

export function flaggedCueCount(track: Pick<CaptionTrackV1, "cues"> | null | undefined): number {
  return track ? track.cues.filter(isFlaggedCue).length : 0;
}

/** 手動字幕（沒跑語音辨識、直接在播放線插段）用的空 track：來源 null、樣式全部繼承預設、預設就燒入。 */
export function emptyCaptionTrack(presetId: CaptionPresetId, language: string): CaptionTrackV1 {
  return { enabled: true, language, source: null, presetId, style: {}, segmentation: presetSegmentation(presetId, language), cues: [] };
}

/** 輸出語言：ASR 選中文 → zh-TW（規格決策 2：台灣繁體）；自動 → 交給引擎依偵測結果決定。 */
export function outputLanguageFor(asrLanguage: string): string | null {
  if (!asrLanguage || asrLanguage === "auto") return null;
  return asrLanguage === "zh" ? "zh-TW" : asrLanguage;
}

// ---------------------------------------------------------------------------
// 字幕面板暫態（不進專案檔、不進 undo）
// ---------------------------------------------------------------------------

export type AsrModel = "large-v3-turbo" | "large-v3" | "medium" | "small" | "base" | "tiny";
export const ASR_MODELS: readonly AsrModel[] = ["large-v3-turbo", "large-v3", "medium", "small", "base", "tiny"];
export type AsrDevice = "auto" | "cuda" | "cpu";
export const ASR_LANGUAGES: readonly string[] = ["zh", "en", "ja", "ko", "yue", "auto"];

export interface TranscribeOptions {
  model: AsrModel;
  /** ASR 語言；"auto" = Whisper 自己偵測（混語片會整段掉字，UI 要警告）。 */
  language: string;
  device: AsrDevice;
  preset: CaptionPresetId;
  hotwords: string[];
  initialPrompt: string;
  /** 產生後用本機 LLM（設定的 OpenAI 相容端點）提校對建議；預設關，建議要人按「套用」才進專案。 */
  refine: boolean;
  /** all = 整支；range = 時間軸 I/O 範圍。 */
  scope: "all" | "range";
}

const OPTS_KEY = "aivc:captions:lastOpts";

export function defaultTranscribeOptions(uiLang: string = useLang.getState().lang): TranscribeOptions {
  return { model: "large-v3-turbo", language: uiLang.startsWith("zh") ? "zh" : "en", device: "auto", preset: "subtitle", hotwords: [], initialPrompt: "", refine: false, scope: "all" };
}

/** localStorage 字串 → 選項（純函式；壞值逐欄退回預設）。 */
export function parseTranscribeOptions(raw: string | null, uiLang?: string): TranscribeOptions {
  const d = defaultTranscribeOptions(uiLang);
  if (!raw) return d;
  try {
    const v = JSON.parse(raw) as Partial<TranscribeOptions>;
    return {
      model: ASR_MODELS.includes(v.model as AsrModel) ? (v.model as AsrModel) : d.model,
      language: typeof v.language === "string" && ASR_LANGUAGES.includes(v.language) ? v.language : d.language,
      device: v.device === "cuda" || v.device === "cpu" ? v.device : "auto",
      preset: isCaptionPresetId(v.preset) ? v.preset : d.preset,
      hotwords: Array.isArray(v.hotwords) ? v.hotwords.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, 200) : [],
      initialPrompt: typeof v.initialPrompt === "string" ? v.initialPrompt.slice(0, 500) : "",
      refine: v.refine === true,
      scope: v.scope === "range" ? "range" : "all",
    };
  } catch {
    return d;
  }
}

/** 熱詞輸入框：逗號 / 頓號 / 換行分隔，去重、去空白。 */
export function parseHotwords(s: string): string[] {
  return [
    ...new Set(
      s
        .split(/[,，、;\n]/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}

/** LLM 校對建議的一條（captions.refine 的結果，由前端對齊成「段 id → 前 / 後」）。 */
export interface RefineItem {
  cueId: string;
  before: string;
  after: string;
  emphasis: string[];
}

export interface CaptionsUiState {
  /** 舞台上畫字幕（檢視開關；不影響燒入）。 */
  showOnStage: boolean;
  selectedCueId: string | null;
  selectedWord: { cueId: string; index: number } | null;
  filter: "all" | "flagged";
  findOpen: boolean;
  query: string;
  replacement: string;
  caseSensitive: boolean;
  opts: TranscribeOptions;
  /**
   * 最近一次產生的摘要（device / 退回原因 / 警告），面板顯示用。
   * 警告已拆成代碼 + 參數、退路原因存引擎原值：顯示時才依目前語言組句（pipeline/captionWarnings），切語言不用重跑。
   */
  lastRun: { mediaId: string; device: string | null; computeType: string | null; fallbackReason: unknown; warnings: EngineWarning[]; gaps: [number, number][]; seconds: number | null } | null;
  /** 最近一次失敗（kind = 引擎錯誤種類；PyEnv 時面板給「安裝引擎」鈕）。 */
  lastError: { mediaId: string; message: string; kind: string | null } | null;
  proposal: { mediaId: string; items: RefineItem[] } | null;
  setShowOnStage: (v: boolean) => void;
  selectCue: (id: string | null) => void;
  selectWord: (sel: { cueId: string; index: number } | null) => void;
  setFilter: (f: "all" | "flagged") => void;
  setFind: (patch: Partial<Pick<CaptionsUiState, "findOpen" | "query" | "replacement" | "caseSensitive">>) => void;
  setOpts: (patch: Partial<TranscribeOptions>) => void;
  setLastRun: (r: CaptionsUiState["lastRun"]) => void;
  setLastError: (e: CaptionsUiState["lastError"]) => void;
  setProposal: (p: CaptionsUiState["proposal"]) => void;
}

function loadOpts(): TranscribeOptions {
  try {
    return parseTranscribeOptions(localStorage.getItem(OPTS_KEY));
  } catch {
    return defaultTranscribeOptions();
  }
}

export const useCaptionsUi = create<CaptionsUiState>((set, get) => ({
  showOnStage: true,
  selectedCueId: null,
  selectedWord: null,
  filter: "all",
  findOpen: false,
  query: "",
  replacement: "",
  caseSensitive: false,
  opts: loadOpts(),
  lastRun: null,
  lastError: null,
  proposal: null,
  setShowOnStage: (showOnStage) => set((s) => (s.showOnStage === showOnStage ? s : { showOnStage })),
  selectCue: (id) => set((s) => (s.selectedCueId === id ? s : { selectedCueId: id, selectedWord: s.selectedWord?.cueId === id ? s.selectedWord : null })),
  selectWord: (sel) => set(sel ? { selectedWord: sel, selectedCueId: sel.cueId } : { selectedWord: null }),
  setFilter: (filter) => set({ filter }),
  setFind: (patch) => set(patch),
  setOpts: (patch) => {
    const opts = { ...get().opts, ...patch };
    set({ opts });
    try {
      localStorage.setItem(OPTS_KEY, JSON.stringify(opts));
    } catch {
      /* 私密視窗 / 停用儲存：這次開著有效就好 */
    }
  },
  setLastRun: (lastRun) => set({ lastRun }),
  setLastError: (lastError) => set({ lastError }),
  setProposal: (proposal) => set({ proposal }),
}));

// ---------------------------------------------------------------------------
// 引擎版面 + 精靈圖集（captions.layout 的 layout.v1.json；規格 §5.1）
// ---------------------------------------------------------------------------
// 為什麼舞台優先用引擎的版面：canvas 的字型度量 / 描邊跟 Pillow 不一樣，斷行會差一兩個字；
// 引擎算好的版面 + 點陣化好的精靈貼上去，舞台上看到的就是燒進成品的樣子。引擎還沒回來（剛改完字、引擎沒開）時才退回 canvas 近似。

export type SpriteRect = [number, number, number, number, number, number];
export type SpriteState = "future" | "active" | "past";

export interface LayoutWordV1 {
  /** cue.words 的索引（硬換行時同一個字可能拆成好幾片）。 */
  i: number;
  x: number;
  w: number;
  /** 這一片在字內的起始字元（打字機）。 */
  c?: number;
  emphasis?: boolean;
  /** 打字機：每個前綴的前進量（1× px）。 */
  chars?: number[];
  sprites: Partial<Record<SpriteState, SpriteRect>>;
  /**
   * 兩趟繪製用（atlas.py：整行先畫所有詞的陰影＋描邊 `under`，再畫字面 `fill`）：粗描邊才不會蓋到隔壁詞的字，跟燒錄逐像素同一個疊法。
   * 引擎沒給（舊快取 / 圖集滿）時舞台退回 `sprites` 單趟。
   */
  under?: SpriteRect;
  fill?: Partial<Record<SpriteState, SpriteRect>>;
}

export interface LayoutLineV1 {
  y: number;
  h: number;
  baseline: number;
  x: number;
  w: number;
  words: LayoutWordV1[];
}

export interface LayoutCueV1 {
  id: string;
  start: number;
  end: number;
  box: [number, number, number, number];
  center: [number, number];
  fontPx: number;
  ascent: number;
  descent: number;
  lines: LayoutLineV1[];
  /** 這段有 styleOverride 時的有效樣式；沒有 = 用 doc.style。 */
  style?: CaptionStyleV1;
  overflow?: boolean;
}

export interface CaptionLayoutDocV1 {
  version: 1;
  size: [number, number];
  fps: Rational;
  range: [number, number];
  atlas: { path: string; w: number; h: number; supersample: number };
  style: CaptionStyleV1;
  cues: LayoutCueV1[];
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const nums = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(finite);

/** layout.v1.json → 型別化文件；形狀不對（版本、尺寸、圖集）回 null，壞掉的段 / 字 / 精靈個別略過。 */
export function parseLayoutDoc(raw: unknown): CaptionLayoutDocV1 | null {
  if (!isRecord(raw) || raw.version !== 1 || !nums(raw.size, 2) || !isRecord(raw.atlas) || !isRecord(raw.fps) || !isRecord(raw.style)) return null;
  const at = raw.atlas;
  if (typeof at.path !== "string" || !/^[\w.-]+$/.test(at.path) || !finite(at.supersample) || at.supersample <= 0) return null;
  if (!finite(raw.fps.num) || !finite(raw.fps.den) || raw.fps.num <= 0 || raw.fps.den <= 0) return null;
  const cues: LayoutCueV1[] = [];
  for (const c of Array.isArray(raw.cues) ? raw.cues : []) {
    if (!isRecord(c) || typeof c.id !== "string" || !finite(c.start) || !finite(c.end) || !nums(c.box, 4) || !nums(c.center, 2) || !finite(c.fontPx) || !finite(c.ascent) || !finite(c.descent) || !Array.isArray(c.lines)) continue;
    const lines: LayoutLineV1[] = [];
    for (const l of c.lines) {
      if (!isRecord(l) || !finite(l.y) || !finite(l.h) || !finite(l.baseline) || !finite(l.x) || !finite(l.w) || !Array.isArray(l.words)) continue;
      const words: LayoutWordV1[] = [];
      for (const w of l.words) {
        if (!isRecord(w) || !finite(w.i) || !finite(w.x) || !finite(w.w) || !isRecord(w.sprites)) continue;
        const sprites: Partial<Record<SpriteState, SpriteRect>> = {};
        for (const st of ["future", "active", "past"] as const) if (nums(w.sprites[st], 6)) sprites[st] = w.sprites[st] as SpriteRect;
        const rawFill = isRecord(w.sprites.fill) ? w.sprites.fill : null;
        const fill: Partial<Record<SpriteState, SpriteRect>> = {};
        if (rawFill) for (const st of ["future", "active", "past"] as const) if (nums(rawFill[st], 6)) fill[st] = rawFill[st] as SpriteRect;
        // 兩趟要 under + 三個 fill 全齊才用；缺一個就當沒有（舞台退回單趟完整精靈，不會畫出少描邊的字）
        const twoPass = nums(w.sprites.under, 6) && fill.future && fill.active && fill.past ? { under: w.sprites.under as SpriteRect, fill } : {};
        words.push({ i: w.i, x: w.x, w: w.w, sprites, ...twoPass, ...(finite(w.c) ? { c: w.c } : {}), ...(w.emphasis === true ? { emphasis: true } : {}), ...(Array.isArray(w.chars) && w.chars.every(finite) ? { chars: w.chars as number[] } : {}) });
      }
      lines.push({ y: l.y, h: l.h, baseline: l.baseline, x: l.x, w: l.w, words });
    }
    cues.push({ id: c.id, start: c.start, end: c.end, box: c.box as LayoutCueV1["box"], center: c.center as LayoutCueV1["center"], fontPx: c.fontPx, ascent: c.ascent, descent: c.descent, lines, ...(isRecord(c.style) ? { style: c.style as unknown as CaptionStyleV1 } : {}), ...(c.overflow === true ? { overflow: true } : {}) });
  }
  return {
    version: 1,
    size: raw.size as [number, number],
    fps: { num: raw.fps.num, den: raw.fps.den },
    range: nums(raw.range, 2) ? (raw.range as [number, number]) : [0, Number.MAX_SAFE_INTEGER],
    atlas: { path: at.path, w: finite(at.w) ? at.w : 0, h: finite(at.h) ? at.h : 0, supersample: at.supersample },
    style: raw.style as unknown as CaptionStyleV1,
    cues,
  };
}

/** 載入中的引擎版面：連同「請求當下」的 cue 物件與 track 設定，繪製時逐段比對物件參考，沒變的段才用精靈。 */
export interface LoadedCaptionLayout {
  mediaId: string;
  doc: CaptionLayoutDocV1;
  atlas: CanvasImageSource;
  byId: ReadonlyMap<string, LayoutCueV1>;
  /** 請求當下的 cue 物件（edits 每次改都換新物件，參考不同 = 這段版面過期）。 */
  cues: ReadonlyMap<string, CaptionCueV1>;
  sig: Pick<CaptionTrackV1, "presetId" | "style" | "segmentation" | "language">;
}

export const useCaptionLayout = create<{ layout: LoadedCaptionLayout | null; setLayout: (l: LoadedCaptionLayout | null) => void }>((set) => ({
  layout: null,
  setLayout: (layout) => set((s) => (s.layout === layout ? s : { layout })),
}));

/**
 * 這一段能不能用引擎版面畫：同一支媒體、track 設定（預設 / 樣式 / 分段 / 語言）與 cue 物件都跟請求當下同一個參考、而且版面裡有這段。
 * 任何一個不同 = 使用者剛改過、新版面還在路上 → 退回 canvas 近似。
 */
export function freshLayoutCue(l: LoadedCaptionLayout | null, mediaId: string, track: CaptionTrackV1, cue: CaptionCueV1): LayoutCueV1 | null {
  if (!l || l.mediaId !== mediaId) return null;
  const s = l.sig;
  if (s.presetId !== track.presetId || s.style !== track.style || s.segmentation !== track.segmentation || s.language !== track.language) return null;
  if (l.cues.get(cue.id) !== cue) return null;
  const lc = l.byId.get(cue.id);
  return lc && lc.start === cue.startFrame && lc.end === cue.endFrame ? lc : null;
}
