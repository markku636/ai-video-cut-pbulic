import type { CaptionCueV1, CaptionStyleV1, CaptionTrackV1, CaptionWordV1, Rational } from "../../project/format";
import { CLOSING_PUNCT, OPENING_PUNCT, cueAtFrame, effectiveStyle, freshLayoutCue, needsSpace, type LayoutCueV1, type LoadedCaptionLayout, type SpriteRect, type SpriteState } from "../../store/captions";
import type { Palette } from "../paint";
import type { StageGeometry } from "../useStageGeometry";

/**
 * 字幕圖層（規格 §5.3 E–G / §5.7 Stage）：舞台上即時畫目前這一幀的字幕，換預設、改字、微調時間馬上看得到。
 *
 * 兩條路：
 * 1. **引擎版面 + 精靈圖集**（captions.layout 產生的 layout.v1.json / atlas.v1.png）：斷行、位置、字形都是引擎算的，
 *    這裡只依動畫曲線把精靈貼上去 —— 舞台上看到的就是燒進成品的樣子。
 * 2. **canvas 近似**：剛改完字、新版面還在路上，或引擎沒開時用。規則逐條照引擎（aivc/captions/layout.py、linebreak.py）：
 *    安全區、錨點、字級 = 短邊 %、窮舉斷行成本、pick_color、逐字縮放以字中心為樞紐；差別只在字型度量與描邊演算法。
 *
 * 動畫曲線與逐字狀態是純函式，跟 aivc/captions/anim.py 逐值相同（共用 anim.golden.json），而且只看整數 proxy 幀 k：
 * τ = (k + 0.5 − k_event)·den/num，暫停在某一幀看到的就是燒進那一幀的狀態。穩定 / 差異檢視由 VideoStage 決定不畫。
 */

// ---------------------------------------------------------------------------
// 動畫曲線（規格 §5.3 F；= aivc/captions/anim.py）
// ---------------------------------------------------------------------------

export function clamp01(x: number): number {
  return x <= 0 || Number.isNaN(x) ? 0 : x >= 1 ? 1 : x;
}

/** 1 − (1 − t)³（t 夾在 [0,1]）；0.5 → 0.875。 */
export function easeOutCubic(t: number): number {
  const u = clamp01(t);
  return 1 - (1 - u) ** 3;
}

/** 1 + 2.70158·(t−1)³ + 1.70158·(t−1)²（t 夾在 [0,1]）；0.5 → 1.0876975、峰值 1.1000 在 t ≈ 0.5801。 */
export function easeOutBack(t: number): number {
  const x = clamp01(t) - 1;
  return 1 + 2.70158 * x ** 3 + 1.70158 * x ** 2;
}

export const SPRING = { amplitudeEm: 0.25, zeta: 0.35, freqHz: 5 } as const;

/** 彈簧位移（em，負 = 往上）：−A·e^(−ζω₀τ)·cos(ω_d τ)，ω₀ = 2π·5、ω_d = ω₀√(1−ζ²) ≈ 29.43；0.356 s 收斂到 2%。τ < 0 → −A。 */
export function springDy(tauS: number, a: number = SPRING.amplitudeEm, zeta: number = SPRING.zeta, freqHz: number = SPRING.freqHz): number {
  if (tauS < 0) return -a;
  const w0 = 2 * Math.PI * freqHz;
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  return -a * Math.exp(-zeta * w0 * tauS) * Math.cos(wd * tauS);
}

/** 事件錨點時間（秒）：τ = (k + 0.5 − k_event)·den/num（幀中心，第一幀淡入不會整幀全透明）。 */
export function tauSeconds(k: number, kEvent: number, fps: Rational): number {
  return ((k + 0.5 - kEvent) * fps.den) / fps.num;
}

/** 縮放量化到 1/64（引擎精靈快取同一粒度）。 */
export function quantizeScale(s: number): number {
  return Math.round(s * 64) / 64;
}

// ---------------------------------------------------------------------------
// 逐字狀態（規格 §5.3 E）
// ---------------------------------------------------------------------------

export type WordState = SpriteState;

/** 第 i 個字的作用中區間 A_i = [s_i, s_{i+1})；最後一個字作用到段結束；至少 1 幀。 */
export function activeWindow(words: readonly Pick<CaptionWordV1, "startFrame">[], i: number, cueEnd: number): [number, number] {
  const s = words[i].startFrame;
  const e = i + 1 < words.length ? words[i + 1].startFrame : cueEnd;
  return [s, Math.max(e, s + 1)];
}

export function wordStateAt(words: readonly Pick<CaptionWordV1, "startFrame">[], i: number, k: number, cueEnd: number): WordState {
  const [s, e] = activeWindow(words, i, cueEnd);
  if (k < s) return "future";
  return k < e ? "active" : "past";
}

/** 卡拉OK 抹色 / 打字機進度：clamp((k + 0.5 − s)/max(1, e − s), 0, 1)。 */
export function wipeProgress(word: Pick<CaptionWordV1, "startFrame" | "endFrame">, k: number): number {
  return clamp01((k + 0.5 - word.startFrame) / Math.max(1, word.endFrame - word.startFrame));
}

/** 打字機：過去的字全顯示、未來的字不顯示、作用中的字顯示 ceil(p·len) 個字元。 */
export function typewriterChars(state: WordState, progress: number, len: number): number {
  if (state === "past") return len;
  if (state === "future") return 0;
  return Math.min(len, Math.ceil(progress * len));
}

export interface CueAnim {
  opacity: number;
  scale: number;
  /** 垂直位移（em；負 = 往上）。 */
  dyEm: number;
}

/** 段的進場 / 退場（= anim.cue_anim；縮放不量化，量化在繪製時做）。 */
export function cueAnimAt(anim: CaptionStyleV1["animation"], cue: Pick<CaptionCueV1, "startFrame" | "endFrame">, k: number, fps: Rational): CueAnim {
  const tau = tauSeconds(k, cue.startFrame, fps);
  const tIn = anim.cueInMs > 0 ? (tau * 1000) / anim.cueInMs : 1;
  let opacity = 1;
  let scale = 1;
  let dyEm = 0;
  if (anim.cueIn === "fade") opacity = clamp01(tIn);
  else if (anim.cueIn === "pop") {
    scale = 0.7 + 0.3 * easeOutBack(tIn);
    opacity = easeOutCubic(tIn);
  } else if (anim.cueIn === "slideUp") dyEm = 0.3 * (1 - easeOutCubic(tIn));
  else if (anim.cueIn === "spring") {
    dyEm = springDy(tau);
    scale = 0.6 + 0.4 * easeOutBack(tIn);
  }
  if (anim.cueOut === "fade" && anim.cueOutMs > 0) {
    const remainS = ((cue.endFrame - (k + 0.5)) * fps.den) / fps.num;
    opacity *= clamp01((remainS * 1000) / anim.cueOutMs);
  }
  return { opacity, scale, dyEm };
}

/** 跳字的逐字縮放（= anim.word_pop_scale）：作用中 easeOutBack 彈大、離開後 easeOutCubic 回落；wordMs ≤ 0 → 直接切換。 */
export function wordPopScale(state: WordState, activated: number, deactivated: number, k: number, fps: Rational, activeScale: number, wordMs: number): number {
  if (state === "future" || activeScale === 1) return 1;
  if (wordMs <= 0) return state === "active" ? activeScale : 1;
  if (state === "active") return 1 + (activeScale - 1) * easeOutBack(Math.min(1, (tauSeconds(k, activated, fps) * 1000) / wordMs));
  return 1 + (activeScale - 1) * (1 - easeOutCubic(Math.min(1, (tauSeconds(k, deactivated, fps) * 1000) / wordMs)));
}

/** 方框從上一個字滑到這個字的進度（= anim.box_move_t）。 */
export function boxMoveT(activated: number, k: number, fps: Rational, wordMs: number): number {
  return wordMs <= 0 ? 1 : easeOutCubic((tauSeconds(k, activated, fps) * 1000) / wordMs);
}

/** 顏色（= burn.pick_color）：明確指定的狀態色優先；沒指定 → 強調字用強調色、其他用文字色。 */
export function pickColor(colors: CaptionStyleV1["colors"], state: WordState, emphasis: boolean): string {
  const base = (emphasis ? colors.emphasis : colors.text) || colors.text || "#FFFFFF";
  return colors[state] || base;
}

// ---------------------------------------------------------------------------
// canvas 近似版面（= aivc/captions/layout.py + linebreak.py）
// ---------------------------------------------------------------------------

/** 安全區矩形 [x0, y0, x1, y1]（= layout.safe_rect）：auto = 直式（H/W ≥ 1.5）用短影音邊界，否則 EBU R95 的 5%。 */
export function safeRect(mode: CaptionStyleV1["layout"]["safeArea"], w: number, h: number): [number, number, number, number] {
  if (mode === "none") return [0, 0, w, h];
  if (mode === "shorts" || (mode === "auto" && h / Math.max(w, 1) >= 1.5)) return [0.06 * w, 0.08 * h, w - 0.12 * w, h - 0.18 * h];
  return [0.05 * w, 0.05 * h, 0.95 * w, 0.95 * h];
}

export interface LineBreakResult {
  /** 每一行的 [起, 迄) token 索引。 */
  lines: [number, number][];
  widths: number[];
  /** 實際用的字寬倍率（1 / 0.9 / 0.8）。 */
  scale: number;
  overflow: boolean;
}

// ---- 行尾的 。，、 不顯示（= aivc/captions/text.py strip_line_end / trim_line_end_punct / strip_line_end_tokens）----
// Netflix 繁中規範：行尾不放逗號、句號、頓號（問號、驚嘆號、刪節號、引號保留）。標點仍留在資料裡（匯出、改字、句末換行加分都看原文），
// 只有「畫出來的字」與「量行寬」拿掉 —— 引擎燒錄這樣做，舞台近似不跟著做的話，同一段字幕舞台上多一個句號、斷行也會差一個字。
const LINE_END_RE = /[\s。，、]+$/u;

/** 一行的顯示文字：拿掉行尾的 。，、（可連續、夾空白）；整行只剩這些標點時原樣返回（不產生空白字幕）。 */
export function stripLineEnd(s: string): string {
  return s.replace(LINE_END_RE, "") || s;
}

/** 同 stripLineEnd 但允許變成空字串：量「這個 token 落在行尾時畫面上剩多寬」用。 */
export function trimLineEndPunct(s: string): string {
  return s.replace(LINE_END_RE, "");
}

/**
 * 同一行的 token → 拿掉行尾 。，、 之後的顯示字串；長度不變（整個被拿掉的 token 變空字串，呼叫端略過）。
 * 逐 token 而不是整行字串：每個詞的時間 / 顏色狀態還是照原本的索引。整行都是這些標點時原樣返回。
 */
export function stripLineEndTokens(tokens: readonly string[]): string[] {
  const out = tokens.map((t) => t.trim());
  for (let i = out.length - 1; i >= 0; i--) {
    out[i] = out[i].replace(LINE_END_RE, "");
    if (out[i]) break;
  }
  return out.some(Boolean) ? out : tokens.map((t) => t.trim());
}

const SENTENCE_MARKS = "。？！.?!";
const CLAUSE_MARKS = "，、,;:；：";
const CLOSING_QUOTES = "」』）》〉】\"'”’)]}";
const CJK_LETTER_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

function lastChar(s: string): string {
  return [...s.trimEnd()].pop() ?? "";
}

function endsSentence(s: string): boolean {
  const cs = [...s.trimEnd()];
  while (cs.length && CLOSING_QUOTES.includes(cs[cs.length - 1])) cs.pop();
  return !!cs.length && SENTENCE_MARKS.includes(cs[cs.length - 1]);
}

function lineCost(tokens: readonly string[], lines: [number, number][], widths: number[], maxW: number, pauseAfter: readonly boolean[]): number {
  let cost = 0;
  for (let li = 0; li < lines.length; li++) {
    const [a, b] = lines[li];
    if (li < lines.length - 1) {
      cost += 100 * ((maxW - widths[li]) / maxW) ** 2;
      const last = tokens[b - 1];
      if (endsSentence(last)) cost -= 30;
      else if (CLAUSE_MARKS.includes(lastChar(last)) || pauseAfter[b - 1]) cost -= 15;
      // 金字塔（下寬上窄）：上一行比下一行寬，每超出 1 個百分點 +20
      if (widths[li] > widths[li + 1]) cost += 20 * (((widths[li] - widths[li + 1]) / maxW) * 100);
    }
    if (b - a === 1) {
      const t = tokens[a].trim();
      const cjk = [...t].filter((ch) => CJK_LETTER_RE.test(ch)).length;
      if (cjk === 1) cost += 60;
      else if (!cjk && [...t].filter((ch) => /[A-Za-z0-9]/.test(ch)).length <= 3 && /\p{L}/u.test(t)) cost += 40;
    }
  }
  return cost;
}

/**
 * 行內斷行（= linebreak.break_lines 的前兩步）：字寬 ×1、×0.9、×0.8 依序試；每一種倍率窮舉 ≤ maxLines 行的合法切法，
 * 一行放得下就一行，否則取成本最低。禁則：收尾標點不能在行首、開頭標點不能在行尾。都放不下 → null。
 * `tails[i]`：第 i 個 token 落在行尾時省下的寬度（拿掉 。，、，見 lineEndTails）—— 行寬（放不放得下、金字塔比較）都扣掉它，
 * 否則「……效果。」會因為畫面上不存在的句號被擠成兩行；句末 / 逗號後換行的加分仍看原本的 token。
 */
export function breakLines(tokens: readonly string[], widths: readonly number[], spaces: readonly number[], maxW: number, maxLines: number, pauseAfter: readonly boolean[] = [], tails: readonly number[] = []): LineBreakResult | null {
  const n = tokens.length;
  if (!n) return { lines: [], widths: [], scale: 1, overflow: false };
  const breakable: number[] = [];
  for (let j = 1; j < n; j++) {
    const b = [...tokens[j]][0] ?? "";
    const a = [...tokens[j - 1]].pop() ?? "";
    if (!CLOSING_PUNCT.includes(b) && !OPENING_PUNCT.includes(a)) breakable.push(j);
  }
  for (const scale of [1, 0.9, 0.8]) {
    const widthOf = (a: number, b: number) => {
      let w = 0;
      for (let i = a; i < b; i++) w += (widths[i] + (i > a ? spaces[i] ?? 0 : 0)) * scale;
      return b > a ? w - (tails[b - 1] ?? 0) * scale : w;
    };
    let best: { cost: number; lines: [number, number][]; widths: number[] } | null = null;
    const consider = (cuts: number[]) => {
      const bounds = [0, ...cuts, n];
      const lines: [number, number][] = [];
      const ws: number[] = [];
      for (let i = 0; i + 1 < bounds.length; i++) {
        const w = widthOf(bounds[i], bounds[i + 1]);
        if (w > maxW + 1e-6) return;
        lines.push([bounds[i], bounds[i + 1]]);
        ws.push(w);
      }
      const cost = lineCost(tokens, lines, ws, maxW, pauseAfter);
      if (!best || cost < best.cost - 1e-9) best = { cost, lines, widths: ws };
    };
    consider([]);
    if (best) return { lines: (best as { lines: [number, number][] }).lines, widths: (best as { widths: number[] }).widths, scale, overflow: false };
    if (maxLines >= 2) for (const b1 of breakable) consider([b1]);
    if (maxLines >= 3) for (let x = 0; x < breakable.length; x++) for (let y = x + 1; y < breakable.length; y++) consider([breakable[x], breakable[y]]);
    const found = best as { lines: [number, number][]; widths: number[] } | null;
    if (found) return { lines: found.lines, widths: found.widths, scale, overflow: false };
  }
  return null;
}

/** 最後的退路（= linebreak._greedy）：貪婪換行，行數不設限，標 overflow。行寬一樣扣掉行尾 token 的 tails（同 breakLines）。 */
export function greedyLines(widths: readonly number[], spaces: readonly number[], maxW: number, scale: number, tails: readonly number[] = []): LineBreakResult {
  const tail = (i: number) => (tails[i] ?? 0) * scale;
  const lines: [number, number][] = [];
  const ws: number[] = [];
  let a = 0;
  let w = 0;
  for (let i = 0; i < widths.length; i++) {
    const add = (widths[i] + (i > a ? spaces[i] ?? 0 : 0)) * scale;
    // 候選行 = 目前這行再加上 i：它的行尾是 i，所以扣 i 的 tail（= _line_width(cand)）
    if (i > a && w + add - tail(i) > maxW) {
      lines.push([a, i]);
      ws.push(w - tail(i - 1));
      a = i;
      w = widths[i] * scale;
    } else w += add;
  }
  if (widths.length) {
    lines.push([a, widths.length]);
    ws.push(w - tail(widths.length - 1));
  }
  return { lines, widths: ws, scale, overflow: true };
}

export interface ApproxPiece {
  word: number;
  text: string;
  x: number;
  w: number;
  staticScale: number;
}

export interface ApproxLine {
  top: number;
  height: number;
  /** 文字垂直中心（canvas textBaseline = middle 用）。 */
  cy: number;
  left: number;
  width: number;
  pieces: ApproxPiece[];
}

export interface ApproxLayout {
  fontPx: number;
  strokePx: number;
  lines: ApproxLine[];
  /** 文字區塊中心（段縮放 / 位移的樞紐）。 */
  center: [number, number];
  /** 文字外框（含描邊），選中框用。 */
  box: { x: number; y: number; w: number; h: number };
  overflow: boolean;
}

export type MeasureFn = (text: string, fontPx: number) => number;

/**
 * 一段字幕在 W×H 畫面上的近似版面（來源 px）。規則同 layout.layout_cue：可用寬 = min(maxWidthPct·W, 安全區寬) − 2·描邊、
 * 強調字的 emphasisScale 算進寬度、停頓 ≥ 4 幀斷行加分；bottom 錨點 offsetYPct 往上、top / middle 往下；結果夾在安全區內。
 */
export function layoutCue(cue: Pick<CaptionCueV1, "words">, style: CaptionStyleV1, w: number, h: number, measure: MeasureFn, maxLines = 2): ApproxLayout {
  const [sx0, sy0, sx1, sy1] = safeRect(style.layout.safeArea, w, h);
  const basePx = (style.font.sizePctShortSide / 100) * Math.min(w, h);
  const strokePx = Math.round((style.stroke.widthPct / 100) * basePx);
  const maxW = Math.max(1, Math.min((style.layout.maxWidthPct / 100) * w, sx1 - sx0) - 2 * strokePx);
  const emph = style.animation.emphasisScale || 1;
  const words = cue.words;
  const tokens = words.map((wd) => (style.font.uppercaseLatin ? wd.text.trim().toUpperCase() : wd.text.trim()));
  const statics = words.map((wd) => (wd.emphasis ? emph : 1));
  const ls = style.font.letterSpacingEm * basePx;
  const textW = (t: string, i: number) => (measure(t, basePx) + ls * [...t].length) * statics[i];
  const widths = tokens.map(textW);
  // 落在行尾時拿掉 。，、 省下的寬度（沒有這些標點 = 0，不必再量）
  const tails = tokens.map((t, i) => {
    const trimmed = trimLineEndPunct(t);
    return trimmed === t ? 0 : Math.max(0, widths[i] - (trimmed ? textW(trimmed, i) : 0));
  });
  const spaceW = measure(" ", basePx);
  const spaces = tokens.map((t, i) => (i > 0 && needsSpace(tokens[i - 1], t, style.font.cjkLatinSpace) ? spaceW : 0));
  const pauseAfter = words.map((wd, i) => i + 1 < words.length && words[i + 1].startFrame - wd.endFrame >= 4);
  const r = breakLines(tokens, widths, spaces, maxW, Math.max(1, Math.min(3, Math.round(maxLines))), pauseAfter, tails) ?? greedyLines(widths, spaces, maxW, 0.8, tails);
  const fontPx = basePx * r.scale;
  const lineH = style.layout.lineHeight * fontPx;
  const totalH = Math.max(1, r.lines.length) * lineH;
  const off = (style.layout.offsetYPct / 100) * h;
  let top: number;
  if (style.layout.anchor === "top") top = sy0 + off;
  else if (style.layout.anchor === "middle") top = (h / Math.max(w, 1) >= 1.5 ? 0.7 : 0.78) * h + off - totalH / 2;
  else top = sy1 - totalH - off;
  top = Math.min(Math.max(top, sy0), Math.max(sy0, sy1 - totalH));

  const lines: ApproxLine[] = r.lines.map(([a, b], li) => {
    const pieces: ApproxPiece[] = [];
    let x = 0;
    // 顯示字串拿掉行尾 。，、；整個被拿掉的 token 不產生 piece，詞距看「前一個有畫出來的詞」（= layout.py 的 prev_t）
    const shown = stripLineEndTokens(tokens.slice(a, b));
    let prev: string | null = null;
    for (let i = a; i < b; i++) {
      const t = shown[i - a];
      if (!t) continue;
      if (prev != null && needsSpace(prev, t, style.font.cjkLatinSpace)) x += spaceW * r.scale;
      const adv = (t === tokens[i] ? widths[i] : textW(t, i)) * r.scale;
      pieces.push({ word: i, text: t, x, w: adv, staticScale: statics[i] });
      prev = t;
      x += adv;
    }
    const lw = x;
    const left = style.layout.align === "left" ? sx0 + strokePx : style.layout.align === "right" ? sx1 - strokePx - lw : (sx0 + sx1) / 2 - lw / 2;
    for (const p of pieces) p.x += left;
    const lt = top + li * lineH;
    return { top: lt, height: lineH, cy: lt + lineH / 2, left, width: lw, pieces };
  });
  const x0 = Math.min(...lines.map((l) => l.left));
  const x1 = Math.max(...lines.map((l) => l.left + l.width));
  return {
    fontPx,
    strokePx,
    lines,
    center: [(x0 + x1) / 2, top + totalH / 2],
    box: { x: x0 - strokePx, y: top - strokePx, w: x1 - x0 + 2 * strokePx, h: totalH + 2 * strokePx },
    overflow: r.overflow,
  };
}

// ---------------------------------------------------------------------------
// 繪製
// ---------------------------------------------------------------------------

export interface CaptionLayerState {
  mediaId: string;
  track: CaptionTrackV1 | null;
  frame: number;
  fps: Rational;
  /** 字幕面板選中的段：畫一個虛線框，改字 / 微調時知道在動哪一段。 */
  selectedCueId: string | null;
  /** 引擎版面（沒有 / 過期就走 canvas 近似）。 */
  layout: LoadedCaptionLayout | null;
}

function fontCss(style: CaptionStyleV1, px: number): string {
  const fam = style.font.families.map((f) => (/^(serif|sans-serif|monospace|system-ui)$/.test(f) ? f : `"${f.replace(/"/g, "")}"`)).join(", ");
  return `${style.font.weight} ${px}px ${fam || "sans-serif"}`;
}

/** 近似版面快取：同一個 cue 物件 + 同樣的版面參數不重量字（播放時每幀只有動畫在變）。 */
const approxCache = new WeakMap<CaptionCueV1, { key: string; layout: ApproxLayout }>();

function approxKey(style: CaptionStyleV1, w: number, h: number, maxLines: number): string {
  const { font, layout, stroke, animation } = style;
  return [w, h, maxLines, font.families.join("|"), font.weight, font.sizePctShortSide, font.letterSpacingEm, font.uppercaseLatin, font.cjkLatinSpace, layout.maxWidthPct, layout.lineHeight, layout.align, layout.anchor, layout.offsetYPct, layout.safeArea, stroke.widthPct, animation.emphasisScale].join(";");
}

function roundRect(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, r: number): void {
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x0 + rr, y0);
  ctx.arcTo(x1, y0, x1, y1, rr);
  ctx.arcTo(x1, y1, x0, y1, rr);
  ctx.arcTo(x0, y1, x0, y0, rr);
  ctx.arcTo(x0, y0, x1, y0, rr);
  ctx.closePath();
  ctx.fill();
}

type Rect4 = [number, number, number, number];

function lerpRect(a: Rect4, b: Rect4, t: number): Rect4 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}

/** 作用中字的方框（= burn._word_rect + boxMove 插值）；wordRect(i) 回那個字所有片段的外框。 */
function activeWordBox(words: readonly CaptionWordV1[], k: number, cueEnd: number, fps: Rational, style: CaptionStyleV1, wordRect: (i: number) => Rect4 | null): Rect4 | null {
  const act = words.findIndex((_, i) => wordStateAt(words, i, k, cueEnd) === "active");
  if (act < 0) return null;
  let r = wordRect(act);
  if (r && style.animation.word === "boxMove" && act > 0) {
    const prev = wordRect(act - 1);
    const t = boxMoveT(words[act].startFrame, k, fps, style.animation.wordMs);
    if (prev && t < 1) r = lerpRect(prev, r, t);
  }
  return r;
}

/** 段級變換：以文字區塊中心縮放、往下 dy。 */
function applyCueTransform(ctx: CanvasRenderingContext2D, center: [number, number], anim: CueAnim, fontPx: number): void {
  const s = quantizeScale(anim.scale);
  const dy = anim.dyEm * fontPx;
  ctx.translate(center[0], center[1] + dy);
  ctx.scale(s, s);
  ctx.translate(-center[0], -center[1]);
  ctx.globalAlpha = anim.opacity;
}

/** 引擎版面 + 圖集：`drawImage(atlas, sx, sy, sw, sh, penX + ox·q, baseline + oy·q, sw·q, sh·q)`，q = 動畫縮放 / supersample。 */
function drawFromAtlas(ctx: CanvasRenderingContext2D, lc: LayoutCueV1, l: LoadedCaptionLayout, cue: CaptionCueV1, style: CaptionStyleV1, k: number, fps: Rational): boolean {
  const words = cue.words;
  const ss = l.doc.atlas.supersample;
  const an = style.animation;
  // 精靈缺任何一個狀態（圖集滿了）就整段退回近似，不要畫出缺字的一段
  if (lc.lines.some((ln) => ln.words.some((p) => !p.sprites.future || !p.sprites.active || !p.sprites.past || p.i >= words.length))) return false;
  const anim = cueAnimAt(an, cue, k, fps);
  if (anim.opacity <= 1e-4) return true;
  ctx.save();
  applyCueTransform(ctx, lc.center, anim, lc.fontPx);

  const em = lc.fontPx;
  const pad = style.box.padEm * em;
  ctx.fillStyle = style.box.color;
  if (style.box.mode === "line") for (const ln of lc.lines) roundRect(ctx, ln.x - pad, ln.baseline - lc.ascent - pad * 0.5, ln.x + ln.w + pad, ln.baseline + lc.descent + pad * 0.5, style.box.radiusEm * em);
  else if (style.box.mode === "activeWord") {
    const wordRect = (i: number): Rect4 | null => {
      const ps = lc.lines.flatMap((ln) => ln.words.filter((p) => p.i === i).map((p) => ({ ln, p })));
      if (!ps.length) return null;
      const ln = ps[0].ln;
      return [Math.min(...ps.map((x) => x.p.x)) - pad, ln.baseline - lc.ascent - pad, Math.max(...ps.map((x) => x.p.x + x.p.w)) + pad, ln.baseline + lc.descent + pad];
    };
    const r = activeWordBox(words, k, cue.endFrame, fps, style, wordRect);
    if (r) roundRect(ctx, r[0], r[1], r[2], r[3], style.box.radiusEm * em);
  }

  // 引擎每個詞都給了 under + fill 才走兩趟（跟 burn.py 同一個疊法）；舊快取 / 圖集滿時退回單趟完整精靈
  const twoPass = lc.lines.every((ln) => ln.words.every((p) => p.under && p.fill));
  for (const ln of lc.lines) {
    const centerY = ln.baseline - (lc.ascent - lc.descent) / 2;
    const items: { p: (typeof ln.words)[number]; st: WordState; pop: number; clipW: number | null }[] = [];
    for (const p of ln.words) {
      const word = words[p.i];
      const st = wordStateAt(words, p.i, k, cue.endFrame);
      const [a, b] = activeWindow(words, p.i, cue.endFrame);
      const pop = an.word === "pop" ? wordPopScale(st, a, b, k, fps, an.activeScale, an.wordMs) : 1;
      let clipW: number | null = null;
      if (an.word === "typewriter") {
        const total = [...word.text.trim()].length;
        const n = typewriterChars(st, wipeProgress(word, k), total) - (p.c ?? 0);
        if (n <= 0) continue;
        const adv = p.chars?.[Math.min(n, p.chars.length) - 1];
        if (adv != null && n < (p.chars?.length ?? 0)) clipW = adv;
      }
      items.push({ p, st, pop, clipW });
    }
    const centers = popLineCenters(items.map((it) => it.p), items.map((it) => it.pop), ln.x, ln.w);
    const placed = items.map((it, j) => {
      const s = quantizeScale(it.pop);
      // 強調的靜態縮放已經烤進精靈；基線位移要連它一起算（= burn：center_y + (baseline − center_y)·(s / lay.scale)）
      const penX = an.word === "typewriter" ? it.p.x : centers[j] - (it.p.w * s) / 2;
      const penY = centerY + (ln.baseline - centerY) * s * (it.p.emphasis ? an.emphasisScale || 1 : 1);
      return { ...it, s, q: s / ss, penX, penY };
    });
    const blit = (d: (typeof placed)[number], rect: SpriteRect, clipW: number | null) => {
      if (clipW != null) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(d.penX - em, ln.y - em, clipW * d.s + em, ln.h + 2 * em);
        ctx.clip();
      }
      ctx.drawImage(l.atlas, rect[0], rect[1], rect[2], rect[3], d.penX + rect[4] * d.q, d.penY + rect[5] * d.q, rect[2] * d.q, rect[3] * d.q);
      if (clipW != null) ctx.restore();
    };
    // 第一趟：整行的陰影＋描邊（兩趟模式才有）
    if (twoPass) for (const d of placed) blit(d, d.p.under!, d.clipW);
    // 第二趟：字面（單趟模式就是完整精靈）
    for (const d of placed) {
      const face = (st: WordState): SpriteRect => (twoPass ? d.p.fill![st]! : d.p.sprites[st]!);
      if (an.word === "karaokeWipe" && d.st === "active") {
        // 未唱到的顏色打底，已唱到的部分（p 比例）用作用中顏色蓋上去
        blit(d, face("future"), null);
        blit(d, face("active"), wipeProgress(words[d.p.i], k) * d.p.w);
        continue;
      }
      blit(d, face(d.st), d.clipW);
    }
  }
  ctx.restore();
  return true;
}

/**
 * 跳字時整行重排（= burn.py cue_canvas）：放大的詞以自己的中心放大，同一行的鄰居依「放大後寬度 + 原詞距」往兩側推，整行中心不變。
 * 以詞中心原地放大會吃掉詞間空白、描邊疊在一起。沒有任何詞在放大時回原本的詞中心。
 */
export function popLineCenters(pieces: readonly { x: number; w: number }[], pops: readonly number[], lineX: number, lineW: number): number[] {
  if (!pops.some((s) => s !== 1)) return pieces.map((p) => p.x + p.w / 2);
  const widths = pieces.map((p, i) => p.w * pops[i]);
  const gaps = pieces.slice(0, -1).map((p, i) => pieces[i + 1].x - (p.x + p.w));
  let left = lineX + lineW / 2 - (widths.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0)) / 2;
  return widths.map((w, i) => {
    const c = left + w / 2;
    left += w + (gaps[i] ?? 0);
    return c;
  });
}

/** 陰影位移 / 模糊**不吃** canvas 變換矩陣（規範如此），要換成位圖像素：來源 px × 舞台縮放 × DPR。 */
function applyShadow(ctx: CanvasRenderingContext2D, shadow: NonNullable<CaptionStyleV1["shadow"]>, fontPx: number, geo: StageGeometry): void {
  const k = (fontPx * geo.pxPerSrc * geo.dpr) / 100;
  ctx.shadowColor = shadow.color;
  ctx.shadowOffsetX = shadow.dxPct * k;
  ctx.shadowOffsetY = shadow.dyPct * k;
  ctx.shadowBlur = shadow.blurPct * k;
}

function drawApprox(ctx: CanvasRenderingContext2D, geo: StageGeometry, lay: ApproxLayout, cue: CaptionCueV1, style: CaptionStyleV1, k: number, fps: Rational): void {
  const words = cue.words;
  const an = style.animation;
  const anim = cueAnimAt(an, cue, k, fps);
  if (anim.opacity <= 1e-4) return;
  ctx.save();
  applyCueTransform(ctx, lay.center, anim, lay.fontPx);
  const em = lay.fontPx;
  const pad = style.box.padEm * em;
  ctx.fillStyle = style.box.color;
  if (style.box.mode === "line") for (const ln of lay.lines) roundRect(ctx, ln.left - pad, ln.cy - em / 2 - pad * 0.5, ln.left + ln.width + pad, ln.cy + em / 2 + pad * 0.5, style.box.radiusEm * em);
  else if (style.box.mode === "activeWord") {
    const wordRect = (i: number): Rect4 | null => {
      const ln = lay.lines.find((l) => l.pieces.some((p) => p.word === i));
      const p = ln?.pieces.find((x) => x.word === i);
      return ln && p ? [p.x - pad, ln.cy - em / 2 - pad, p.x + p.w + pad, ln.cy + em / 2 + pad] : null;
    };
    const r = activeWordBox(words, k, cue.endFrame, fps, style, wordRect);
    if (r) roundRect(ctx, r[0], r[1], r[2], r[3], style.box.radiusEm * em);
  }
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  const cc = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
  if ("letterSpacing" in cc) cc.letterSpacing = `${style.font.letterSpacingEm * em}px`;

  for (const ln of lay.lines) {
    for (const p of ln.pieces) {
      const word = words[p.word];
      const st = wordStateAt(words, p.word, k, cue.endFrame);
      let text = p.text;
      if (an.word === "typewriter") {
        // 字數進度以詞的原文長度算（行尾 。，、 被拿掉的詞也一樣，= layout.py 的 char_offset），畫出來的最多到顯示字串為止
        const n = typewriterChars(st, wipeProgress(word, k), [...word.text.trim()].length);
        if (!n) continue;
        text = [...text].slice(0, n).join("");
      }
      const [a, b] = activeWindow(words, p.word, cue.endFrame);
      const s = quantizeScale(p.staticScale * (an.word === "pop" ? wordPopScale(st, a, b, k, fps, an.activeScale, an.wordMs) : 1));
      ctx.save();
      // 以字中心為樞紐縮放（打字機以左緣，前綴才不會左右晃）；字的自然寬 = 版面寬 ÷ 強調縮放，縮放後剛好填回版面寬
      const nw = p.w / p.staticScale;
      const wx = an.word === "typewriter" ? p.x : p.x + p.w / 2;
      ctx.translate(wx, ln.cy);
      ctx.scale(s, s);
      ctx.translate(-wx, -ln.cy);
      ctx.font = fontCss(style, em);
      const x = an.word === "typewriter" ? p.x : wx - nw / 2;
      const drawText = (color: string) => {
        // 陰影只打在最底下那一層（有描邊就打在描邊上），填色再疊一次陰影會糊掉描邊
        if (lay.strokePx > 0) {
          if (style.shadow) applyShadow(ctx, style.shadow, em * s, geo);
          ctx.strokeStyle = style.colors.stroke;
          ctx.lineWidth = lay.strokePx * 2;
          ctx.strokeText(text, x, ln.cy);
          ctx.shadowColor = "transparent";
        } else if (style.shadow) applyShadow(ctx, style.shadow, em * s, geo);
        ctx.fillStyle = color;
        ctx.fillText(text, x, ln.cy);
        ctx.shadowColor = "transparent";
      };
      if (an.word === "karaokeWipe" && st === "active") {
        drawText(pickColor(style.colors, "future", !!word.emphasis));
        ctx.save();
        ctx.beginPath();
        ctx.rect(x - em, ln.top - em, em + wipeProgress(word, k) * nw, ln.height + 2 * em);
        ctx.clip();
        ctx.fillStyle = pickColor(style.colors, "active", !!word.emphasis);
        ctx.fillText(text, x, ln.cy);
        ctx.restore();
      } else drawText(pickColor(style.colors, st, !!word.emphasis));
      ctx.restore();
    }
  }
  ctx.restore();
}

export function drawCaptionLayer(ctx: CanvasRenderingContext2D, geo: StageGeometry, state: CaptionLayerState, pal: Palette): void {
  const track = state.track;
  if (!track || !track.cues.length || geo.rect.w <= 0) return;
  const k = state.frame;
  const cue = cueAtFrame(track.cues, k);
  if (!cue || cue.hidden || !cue.words.length) return;
  const style = effectiveStyle(track, cue);
  const fresh = freshLayoutCue(state.layout, state.mediaId, track, cue);
  // 版面的座標系：引擎版面是它自己的輸出尺寸（doc.size），近似版面用來源尺寸；都等比例映到內容矩形
  const W = fresh ? state.layout!.doc.size[0] : geo.srcW;
  const H = fresh ? state.layout!.doc.size[1] : geo.srcH;
  const unit = geo.rect.w / Math.max(1, W);

  ctx.save();
  ctx.translate(geo.rect.x, geo.rect.y);
  ctx.scale(unit, unit);
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();
  let box: { x: number; y: number; w: number; h: number; overflow: boolean };
  if (fresh && drawFromAtlas(ctx, fresh, state.layout!, cue, fresh.style ?? style, k, state.fps)) {
    box = { x: fresh.box[0], y: fresh.box[1], w: fresh.box[2] - fresh.box[0], h: fresh.box[3] - fresh.box[1], overflow: !!fresh.overflow };
  } else {
    const key = approxKey(style, W, H, track.segmentation.maxLines);
    let hit = approxCache.get(cue);
    if (!hit || hit.key !== key) {
      const measure: MeasureFn = (text, px) => {
        ctx.font = fontCss(style, px);
        return ctx.measureText(text).width;
      };
      ctx.save();
      hit = { key, layout: layoutCue(cue, style, W, H, measure, track.segmentation.maxLines) };
      ctx.restore();
      approxCache.set(cue, hit);
    }
    drawApprox(ctx, geo, hit.layout, cue, style, k, state.fps);
    box = { ...hit.layout.box, overflow: hit.layout.overflow };
  }
  ctx.restore();

  if (state.selectedCueId === cue.id) {
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = box.overflow ? pal("warning", 0.9) : pal("accent", 0.9);
    const x = geo.rect.x + box.x * unit;
    const y = geo.rect.y + box.y * unit;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(box.w * unit), Math.round(box.h * unit));
    ctx.restore();
  }
}
