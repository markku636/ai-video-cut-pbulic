// 序列空間時間軸的繪圖（docs/editor-m2-design.md §9.2–9.3；M2.9 V1＋A0＋追蹤分段、M2.10 A1…An）。
//
// 這個檔不碰 store、不碰 DOM（除了 ctx 與 sequencePalette 預設讀 CSS 變數）；「東西在哪個 x」全部在 seqGeometry.ts，
// 命中測試（hitSequence.ts）讀同一份幾何。FrameTimeline 只負責把 store 攤成 SeqDrawState。
import type { PeaksMip } from "../audio/peaks";
import { sampleColumns } from "../audio/peaks";
import type { AudioClipV2, AudioLaneV2, AudioSourceRefV2, FadeCurve, GapV2, SequenceV2, VideoClipV2 } from "../project/format";
import { samplesOfFrame, type PlacedItem } from "../sequence/map";
import { drawLockGlyph } from "../stage/layers/SurfaceLayer";
import { crisp, TOKEN, type TokenName } from "../stage/paint";
import { xOfFrame, type FrameRange } from "../store/timeline";
import { DARK_SEQUENCE, SEQUENCE_COLOR_VARS, type SequenceColors } from "../themes";
import { timecode } from "../time";
import { BAND_TOKEN, DIAMOND, rulerTicks, THUMB_TILE, tileStartOf, type TrackLane } from "./draw";
import type { SeqView, SequenceLayout } from "./layoutSequence";
import { drawRangeBand, type RangePart } from "./rangeBand";
import {
  audioBucketAt,
  audioClipSpan,
  bucketsPerPixel,
  clipGainFactor,
  clipThumbSlots,
  envelopePointsXY,
  fadeEdgesX,
  fadeHandleRects,
  fadeShape,
  gainLinePoints,
  mapSourceFrame,
  mapSourceSpan,
  markerBand,
  MARKER_HALF_W,
  sampleOfFrameExact,
  sequenceSolvedRuns,
  v1BucketAt,
  visibleItemSpans,
  type GainGeom,
  type ItemSpan,
  type XY,
} from "./seqGeometry";

// ---- 調色盤 ----

export type SeqTokenName = keyof SequenceColors;
export type SeqPalette = (name: TokenName | SeqTokenName, alpha?: number) => string;

function hexTriple(hex: string): string {
  const h = hex.replace("#", "");
  return `${Number.parseInt(h.slice(0, 2), 16)} ${Number.parseInt(h.slice(2, 4), 16)} ${Number.parseInt(h.slice(4, 6), 16)}`;
}

/** CSS 變數還沒寫進去（主題尚未套用的第一幀、測試）時的兜底：用深色預設，不要退回前景白（白色波形蓋滿整列很刺眼）。 */
const SEQ_FALLBACK = Object.fromEntries((Object.keys(DARK_SEQUENCE) as SeqTokenName[]).map((k) => [k, hexTriple(DARK_SEQUENCE[k])])) as Record<SeqTokenName, string>;

function isSeqToken(name: string): name is SeqTokenName {
  return Object.prototype.hasOwnProperty.call(SEQUENCE_COLOR_VARS, name);
}

/**
 * M1 語意色（stage/paint.ts TOKEN）＋序列色（themes.ts SEQUENCE_COLOR_VARS）合在一個函式裡。
 * 不擴充 paint.ts 的 TOKEN：VideoStage 疊層用不到序列色，TokenName 變大只會讓疊層的型別檢查變鬆。
 * `read` 預設讀 `<html>` 的 computed style；一次繪製每個名字只查一次。
 */
export function sequencePalette(read?: (cssVar: string) => string): SeqPalette {
  let reader = read;
  const cache = new Map<string, string>();
  return (name, alpha = 1) => {
    let v = cache.get(name);
    if (v === undefined) {
      if (!reader) {
        const cs = getComputedStyle(document.documentElement);
        reader = (n) => cs.getPropertyValue(n);
      }
      const seq = isSeqToken(name);
      v = reader(seq ? SEQUENCE_COLOR_VARS[name] : TOKEN[name as TokenName]).trim() || (seq ? SEQ_FALLBACK[name] : "248 248 242");
      cache.set(name, v);
    }
    return `rgb(${v} / ${alpha})`;
  };
}

// ---- 狀態 ----

export interface SeqMediaView {
  name: string;
  /** proxy 幀數；null = proxy 還沒好（沒有縮圖，但不是離線）。 */
  frames: number | null;
  /** 媒體已不在專案裡（片段保留、畫紅框）。 */
  missing?: boolean;
  tileAt: ((start: number) => CanvasImageSource | null) | null;
  peaks: PeaksMip | null;
  /** 影片第一幀的容器時間（µs）；audio_info 還沒跑時 0（§7.4「公式照帶」）。 */
  videoStartUs: number;
}

export interface SeqAudioSourceView {
  name: string;
  peaks: PeaksMip | null;
  startUs: number;
  sampleRate: number;
  missing?: boolean;
}

export interface SeqTrackLane extends TrackLane {
  mediaId: string;
}

export interface SeqDrawLabels {
  gap: string;
  disabled: string;
  offline: string;
  /** 原音被靜音（沒有分離）。 */
  muted: string;
  dropHint: string;
  badge: (n: number) => string;
  /** 「已分離 → A1」；找不到音軌名時 null。 */
  detached: (laneName: string | null) => string;
  gainDb: (db: number) => string;
}

export interface SeqDrawState {
  width: number;
  scrollFrame: number;
  pxPerFrame: number;
  seq: SequenceV2;
  placed: readonly PlacedItem[];
  /** 序列總幀數 T。 */
  frames: number;
  /** 序列空間的播放線；null = 目前的來源幀沒用在序列裡（不畫）。 */
  currentFrame: number | null;
  range: FrameRange | null;
  pendingIn: number | null;
  pendingOut: number | null;
  loop: FrameRange | null;
  hoverFrame: number | null;
  rangeHover?: RangePart | null;
  rangeDragging?: boolean;
  rangeLabels?: readonly string[];
  /** 還沒有範圍時畫在範圍列中央的提示字（已 t() 過）；沒有範圍列就沒東西說它可以拖。 */
  rangeEmptyHint?: string | null;
  rangeHoverEmpty?: boolean;
  snapFrame?: number | null;
  media: (mediaId: string) => SeqMediaView | undefined;
  audioSource: (ref: AudioSourceRefV2) => SeqAudioSourceView | undefined;
  badgeOf?: (clip: VideoClipV2) => number;
  tracks: readonly SeqTrackLane[];
  /** 同 timeline store：frame 是來源 k（菱形在序列裡出現幾次就亮幾次）。 */
  selectedKeyframe: { trackId: string; frame: number } | null;
  selectedClipIds?: ReadonlySet<string>;
  /** 滑鼠停在哪個片段上（淡化把手只在 hover / 選取時畫，§9.4）。 */
  hoverClipId?: string | null;
  thumbW: number;
  labels: SeqDrawLabels;
  layout: SequenceLayout;
}

type Ctx = CanvasRenderingContext2D;

// ---- 小積木 ----

function vline(ctx: Ctx, x: number, y0: number, y1: number) {
  ctx.beginPath();
  ctx.moveTo(crisp(x), y0);
  ctx.lineTo(crisp(x), y1);
  ctx.stroke();
}

function diamond(ctx: Ctx, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
}

function roundRectPath(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function clipTo(ctx: Ctx, x: number, y: number, w: number, h: number) {
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
}

function polyline(ctx: Ctx, pts: readonly XY[]) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
}

/** 片段在螢幕上的可畫範圍：夾在畫布左右各多 2 px（框線不會在畫布邊緣被切一半），放大時不會畫出幾十萬 px 寬的矩形。 */
function visibleX(x0: number, x1: number, width: number): [number, number] {
  return [Math.max(-2, x0), Math.min(width + 2, x1)];
}

/** 停用斜線（Resolve 停用片段的樣子）：只畫可視部分。 */
function hatch(ctx: Ctx, x0: number, x1: number, y: number, h: number, color: string) {
  ctx.save();
  clipTo(ctx, x0, y, x1 - x0, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let d = Math.floor(x0 / 6) * 6 - h; d < x1; d += 6) {
    ctx.moveTo(d, y + h);
    ctx.lineTo(d + h, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** 在 [x0, x1) 內放得下才畫的標籤：放不下就截斷加 …；連一個字都放不下就不畫（窄片段上一堆疊字比沒字更糟）。 */
function label(ctx: Ctx, text: string, x0: number, x1: number, y: number, h: number, fg: string, bg: string | null, align: "left" | "right" = "left") {
  const pad = 4;
  const avail = x1 - x0 - pad * 2;
  if (avail < 12 || !text) return;
  let s = text;
  let w = ctx.measureText(s).width;
  if (w > avail) {
    while (s.length > 1 && ctx.measureText(`${s}…`).width > avail) s = s.slice(0, -1);
    s = `${s}…`;
    w = ctx.measureText(s).width;
    if (w > avail) return;
  }
  const x = align === "left" ? x0 + pad : x1 - pad - w;
  if (bg) {
    ctx.fillStyle = bg;
    ctx.fillRect(x - 3, y, w + 6, h);
  }
  ctx.fillStyle = fg;
  ctx.fillText(s, x, y + h / 2);
}

interface WaveInput {
  mip: PeaksMip;
  xa: number;
  xb: number;
  top: number;
  h: number;
  startBucket: number;
  bpp: number;
  /** 螢幕 x（像素中心）→ 振幅倍率。 */
  factorAt: (x: number) => number;
  alpha: number;
}

/**
 * 波形欄：外層 min→max（waveform）、內層 ±RMS（waveform-rms），振幅乘 factorAt(x)。
 * 一欄一個 fillRect：比 path 快，而且 1 px 寬的矩形不會有 lineWidth 的半像素糊邊。
 */
function drawWaveform(ctx: Ctx, pal: SeqPalette, w: WaveInput) {
  const cols = Math.max(0, Math.ceil(w.xb - w.xa));
  if (!cols || w.bpp <= 0) return;
  const c = sampleColumns(w.mip, w.startBucket, w.bpp, cols);
  const mid = w.top + w.h / 2;
  const amp = Math.max(1, w.h / 2 - 1);
  const outer = pal("waveform", 0.75 * w.alpha);
  const inner = pal("waveformRms", 0.9 * w.alpha);
  for (let i = 0; i < cols; i++) {
    const mn = c.min[i];
    const mx = c.max[i];
    if (Number.isNaN(mn) || Number.isNaN(mx)) continue;
    const f = w.factorAt(w.xa + i + 0.5);
    if (f <= 0) continue;
    const y1 = Math.max(w.top, mid - Math.min(1, mx * f) * amp);
    const y2 = Math.min(w.top + w.h, mid - Math.max(-1, mn * f) * amp);
    ctx.fillStyle = outer;
    ctx.fillRect(w.xa + i, y1, 1, Math.max(1, y2 - y1));
    const r = Math.min(1, c.rms[i] * f) * amp;
    if (r >= 0.5) {
      ctx.fillStyle = inner;
      ctx.fillRect(w.xa + i, mid - r, 1, r * 2);
    }
  }
}

/** 淡化陰影：曲線上方壓暗、曲線本身描一條（Resolve / FCP 的片段角落淡化）。 */
function drawFade(ctx: Ctx, pal: SeqPalette, xStart: number, xEnd: number, top: number, h: number, curve: FadeCurve, dir: "in" | "out") {
  const w = xEnd - xStart;
  if (Math.abs(w) < 1) return;
  const n = curve === "equalPower" ? 12 : 1;
  const pts: XY[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    pts.push({ x: xStart + w * u, y: top + h - fadeShape(dir === "in" ? u : 1 - u, curve) * h });
  }
  ctx.beginPath();
  ctx.moveTo(xStart, top);
  ctx.lineTo(xEnd, top);
  for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  ctx.fillStyle = pal("well", 0.45);
  ctx.fill();
  polyline(ctx, pts);
  ctx.strokeStyle = pal("fade", 0.7);
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** 淡化陰影＋音量線＋自動化點＋（hover / 選取時）淡化把手；呼叫端已經 clip 在片段矩形內。 */
function drawGainOverlay(ctx: Ctx, pal: SeqPalette, g: GainGeom, x0: number, x1: number, handles: boolean, dim: boolean) {
  const { xFadeInEnd, xFadeOutStart } = fadeEdgesX(g);
  if (g.gain.fadeIn > 0) drawFade(ctx, pal, x0, xFadeInEnd, g.top, g.h, g.gain.fadeCurve, "in");
  if (g.gain.fadeOut > 0) drawFade(ctx, pal, xFadeOutStart, x1, g.top, g.h, g.gain.fadeCurve, "out");
  if (g.h < 22) return;
  polyline(ctx, gainLinePoints(g));
  ctx.strokeStyle = pal("gainLine", dim ? 0.4 : 0.9);
  ctx.lineWidth = 1;
  ctx.stroke();
  for (const p of envelopePointsXY(g)) {
    if (p.x < x0 - 4 || p.x > x1 + 4) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = pal("envelopePoint");
    ctx.fill();
    ctx.strokeStyle = pal("gainLine");
    ctx.stroke();
  }
  if (!handles) return;
  const r = fadeHandleRects(x0, x1, g.top, xFadeInEnd, xFadeOutStart);
  for (const rect of [r.fadeIn, r.fadeOut]) {
    ctx.fillStyle = pal("fade", 0.9);
    ctx.fillRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
    ctx.strokeStyle = pal("app", 0.9);
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 1.5, rect.y + 1.5, rect.w - 3, rect.h - 3);
  }
}

// ---- V1 ----

function drawGap(ctx: Ctx, s: SeqDrawState, pal: SeqPalette, gap: GapV2, xa: number, xb: number) {
  const L = s.layout;
  // 空白：虛框（FCP gap clip）——看得出「這裡有東西佔時間，只是沒有畫面」
  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = pal("gap", 0.7);
  ctx.lineWidth = 1;
  ctx.strokeRect(crisp(xa), L.v1Y + 2.5, Math.max(1, xb - xa - 1), L.v1H - 5);
  ctx.restore();
  if (s.selectedClipIds?.has(gap.id)) {
    ctx.strokeStyle = pal("clipSelected");
    ctx.lineWidth = 2;
    ctx.strokeRect(xa + 1, L.v1Y + 1, Math.max(1, xb - xa - 2), L.v1H - 2);
  }
  label(ctx, s.labels.gap, xa, xb, L.v1Y + L.v1H / 2 - 7, 14, pal("fg", 0.5), null);
}

function drawClipThumbs(ctx: Ctx, s: SeqDrawState, pal: SeqPalette, sp: ItemSpan, clip: VideoClipV2, m: SeqMediaView, xa: number, xb: number) {
  const L = s.layout;
  const tileAt = m.tileAt;
  if (!tileAt) return;
  ctx.save();
  clipTo(ctx, xa, L.v1Y + 1, xb - xa, L.v1H - 2);
  for (const slot of clipThumbSlots(sp, clip.srcIn, s, s.width, s.thumbW)) {
    const start = tileStartOf(slot.k);
    const tile = tileAt(start);
    const tw = tile && "width" in tile ? Number(tile.width) : 0;
    const th = tile && "height" in tile ? Number(tile.height) : 0;
    if (tile && tw > 0 && th > 0) {
      const sw = tw / THUMB_TILE;
      try {
        ctx.drawImage(tile, (slot.k - start) * sw, 0, sw, th, slot.x, L.v1Y + 1, s.thumbW, L.v1H - 2);
      } catch {
        /* 圖還沒解碼完 */
      }
    } else {
      ctx.fillStyle = pal("fg", 0.04);
      ctx.fillRect(slot.x, L.v1Y + 1, s.thumbW - 1, L.v1H - 2);
    }
  }
  ctx.restore();
}

function drawClip(ctx: Ctx, s: SeqDrawState, pal: SeqPalette, sp: ItemSpan, clip: VideoClipV2, xa: number, xb: number) {
  const L = s.layout;
  const top = L.v1Y;
  const h = L.v1H;
  const w = xb - xa;
  const m = s.media(clip.mediaId);
  // 離線：媒體不在專案裡，或 proxy 以不同 fps 重建後片段超界（§3.5：保留片段、標離線，不默默刪掉）
  const offline = !m || !!m.missing || (m.frames != null && clip.srcOut > m.frames);
  ctx.fillStyle = pal("clipVideo", clip.enabled ? 0.22 : 0.08);
  ctx.fillRect(xa, top + 1, w, h - 2);
  if (m && !offline) drawClipThumbs(ctx, s, pal, sp, clip, m, xa, xb);
  if (!clip.enabled) {
    ctx.fillStyle = pal("well", 0.55);
    ctx.fillRect(xa, top + 1, w, h - 2);
    hatch(ctx, xa, xb, top + 1, h - 2, pal("clipDisabled", 0.55));
  }

  // 外框：線寬 lw 往內縮 lw/2，整條落在片段內 —— 相鄰兩個片段的框不會疊成一條分不清的粗線
  const selected = !!s.selectedClipIds?.has(clip.id);
  const lw = offline || selected ? 2 : 1;
  ctx.lineWidth = lw;
  ctx.strokeStyle = offline ? pal("clipOffline") : selected ? pal("clipSelected") : pal(clip.enabled ? "clipVideo" : "clipDisabled", 0.9);
  ctx.strokeRect(xa + lw / 2, top + 1 + lw / 2, Math.max(1, w - lw), h - 2 - lw);

  // 左上標籤（片段名 / 媒體名）、右上徽章「替換 3」
  ctx.font = "10px Inter Variable, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const name = clip.label || m?.name || clip.mediaId;
  const badge = s.badgeOf?.(clip) ?? 0;
  const badgeText = badge > 0 ? s.labels.badge(badge) : "";
  const badgeW = badgeText ? ctx.measureText(badgeText).width + 14 : 0;
  const showBadge = !!badgeText && w > badgeW + 24;
  if (showBadge) label(ctx, badgeText, xa, xb, top + 3, 13, pal("app"), pal("user", 0.9), "right");
  const text = offline ? `${s.labels.offline} · ${name}` : clip.enabled ? name : `${s.labels.disabled} · ${name}`;
  label(ctx, text, xa, xb - (showBadge ? badgeW : 0), top + 3, 13, offline ? pal("clipOffline") : pal("fg", 0.9), pal("app", 0.7));
}

function drawV1(ctx: Ctx, s: SeqDrawState, pal: SeqPalette, spans: readonly ItemSpan[]) {
  const L = s.layout;
  ctx.fillStyle = pal("inset", 0.6);
  ctx.fillRect(0, L.v1Y, s.width, L.v1H);
  ctx.font = "10px Inter Variable, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  for (const sp of spans) {
    const [xa, xb] = visibleX(sp.x0, sp.x1, s.width);
    if (sp.item.kind === "gap") drawGap(ctx, s, pal, sp.item, xa, xb);
    else drawClip(ctx, s, pal, sp, sp.item, xa, xb);
  }
}

// ---- A0 原音 ----

function drawA0Clip(ctx: Ctx, s: SeqDrawState, pal: SeqPalette, sp: ItemSpan, clip: VideoClipV2) {
  const L = s.layout;
  const { seq } = s;
  const fps = seq.fps;
  const top = L.a0Y;
  const h = L.a0H;
  const [xa, xb] = visibleX(sp.x0, sp.x1, s.width);
  const w = xb - xa;
  const a = clip.audio;
  const detached = a.detachedTo !== undefined;
  const live = clip.enabled && a.enabled && !seq.original.muted;
  ctx.fillStyle = detached ? pal("clipDisabled", 0.12) : pal("clipAudio", live ? 0.14 : 0.06);
  ctx.fillRect(xa, top + 1, w, h - 2);
  ctx.strokeStyle = pal(detached ? "clipDisabled" : "clipAudio", 0.5);
  ctx.lineWidth = 1;
  ctx.strokeRect(xa + 0.5, top + 1.5, Math.max(1, w - 1), h - 3);
  if (detached) {
    // 已分離：聲音在 A 軌上，這裡只留一塊淡灰提示去哪找（§9.2）
    const lane = seq.audioLanes.find((l) => l.clips.some((c) => c.id === a.detachedTo));
    label(ctx, s.labels.detached(lane?.name ?? null), xa, xb, top + h / 2 - 7, 14, pal("fg", 0.5), null);
    return;
  }
  const S0 = samplesOfFrame(sp.t0, fps);
  const len = samplesOfFrame(sp.t1, fps) - S0;
  const m = s.media(clip.mediaId);
  ctx.save();
  clipTo(ctx, xa, top + 1, w, h - 2);
  if (m?.peaks) {
    drawWaveform(ctx, pal, {
      mip: m.peaks,
      xa,
      xb,
      top: top + 2,
      h: h - 4,
      startBucket: v1BucketAt(s.scrollFrame + xa / s.pxPerFrame, sp, clip.srcIn, fps, m.videoStartUs),
      bpp: bucketsPerPixel(fps, s.pxPerFrame),
      // 波形跟著增益 / 淡化 / 閃避縮放（Resolve / FCP 的做法）：看得到聲音被壓到哪裡，不必再去讀音量線
      factorAt: (x) => clipGainFactor(a, sampleOfFrameExact(s.scrollFrame + x / s.pxPerFrame, fps) - S0, len, seq.original.gainDb),
      alpha: live ? 1 : 0.35,
    });
  }
  const handles = s.hoverClipId === clip.id || !!s.selectedClipIds?.has(clip.id);
  drawGainOverlay(ctx, pal, { gain: a, startSample: S0, length: len, fps, view: s, top: top + 1, h: h - 2 }, sp.x0, sp.x1, handles, !live);
  ctx.restore();
  ctx.font = "10px Inter Variable, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  if (!a.enabled) label(ctx, s.labels.muted, xa, xb, top + 3, 13, pal("fg", 0.6), pal("app", 0.6));
  else if (a.gainDb !== 0 && w > 60) label(ctx, s.labels.gainDb(a.gainDb), xa, xb, top + h - 16, 13, pal("fg", 0.7), null, "right");
}

function drawA0(ctx: Ctx, s: SeqDrawState, pal: SeqPalette, spans: readonly ItemSpan[]) {
  const L = s.layout;
  ctx.fillStyle = pal("inset", 0.45);
  ctx.fillRect(0, L.a0Y, s.width, L.a0H);
  for (const sp of spans) if (sp.item.kind === "clip") drawA0Clip(ctx, s, pal, sp, sp.item);
}

// ---- 追蹤車道（分段畫在片段底下）----

type XSpan = [number, number];

/** 壓暗 [0, width) 裡不在 active 之內的部分（active 依 x 遞增）。 */
function shadeOutside(ctx: Ctx, active: readonly XSpan[], y: number, h: number, width: number) {
  let cursor = 0;
  for (const [a, b] of active) {
    if (a > cursor) ctx.fillRect(cursor, y, Math.min(width, a) - cursor, h);
    cursor = Math.max(cursor, b);
    if (cursor >= width) return;
  }
  if (cursor < width) ctx.fillRect(Math.max(0, cursor), y, width - Math.max(0, cursor), h);
}

function hsegments(ctx: Ctx, active: readonly XSpan[], y: number, width: number) {
  ctx.beginPath();
  for (const [a, b] of active) {
    if (b <= 0 || a >= width) continue;
    ctx.moveTo(Math.max(0, a), y);
    ctx.lineTo(Math.min(width, b), y);
  }
  ctx.stroke();
}

function drawTrackKeyframes(ctx: Ctx, s: SeqDrawState, pal: SeqPalette, tr: SeqTrackLane, userY: number, userH: number) {
  const cy = userY + userH / 2;
  if (tr.referenceFrame !== null) {
    for (const t of mapSourceFrame(s.placed, tr.mediaId, tr.referenceFrame)) {
      const x = xOfFrame(t, s.scrollFrame, s.pxPerFrame);
      if (x < -8 || x > s.width + 8) continue;
      ctx.strokeStyle = pal("info");
      ctx.fillStyle = pal("info");
      ctx.lineWidth = 1.5;
      vline(ctx, x, userY + 2, userY + userH - 2);
      ctx.beginPath();
      ctx.arc(crisp(x), userY + 4, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  for (const kf of tr.keyframes) {
    const sel = s.selectedKeyframe?.trackId === tr.id && s.selectedKeyframe.frame === kf.frame;
    const r = sel ? DIAMOND + 2 : DIAMOND;
    for (const t of mapSourceFrame(s.placed, tr.mediaId, kf.frame)) {
      const x = xOfFrame(t, s.scrollFrame, s.pxPerFrame);
      if (x < -DIAMOND - 2 || x > s.width + DIAMOND + 2) continue;
      diamond(ctx, Math.round(x), Math.round(cy), r);
      ctx.fillStyle = kf.source === "user" ? pal("user") : pal("well");
      ctx.fill();
      ctx.strokeStyle = kf.source === "user" ? pal("app", 0.9) : pal("user", 0.9);
      ctx.lineWidth = kf.source === "user" ? 1 : 1.25;
      ctx.stroke();
      if (sel) {
        ctx.strokeStyle = pal("accent");
        ctx.lineWidth = 1.5;
        diamond(ctx, Math.round(x), Math.round(cy), r + 3);
        ctx.stroke();
      }
      if (kf.locked) drawLockGlyph(ctx, [x + 8, userY + 5], pal("user"), 6);
    }
  }
}

function drawTrackRows(ctx: Ctx, s: SeqDrawState, pal: SeqPalette) {
  const L = s.layout;
  const { width } = s;
  if (L.tracksHeaderH > 0) {
    ctx.fillStyle = pal("panel", 0.6);
    ctx.fillRect(0, L.tracksHeaderY, width, L.tracksHeaderH);
  }
  for (const row of L.rows) {
    const tr = s.tracks.find((t) => t.id === row.trackId);
    if (!tr) continue;
    ctx.fillStyle = tr.selected ? pal("accent", 0.1) : pal("fg", 0.03);
    ctx.fillRect(0, row.y, width, row.h);
    // 有效段 = 這條 track 所屬鏡頭 ∩ 用到它媒體的片段；其餘壓暗（「這裡不是這條 track 的地盤」，同 M1 的鏡頭外壓暗）
    const range = tr.shotRange ?? [0, Number.MAX_SAFE_INTEGER];
    const active = mapSourceSpan(s.placed, tr.mediaId, range[0], range[1]).map((sp): XSpan => [xOfFrame(sp.t0, s.scrollFrame, s.pxPerFrame), xOfFrame(sp.t1, s.scrollFrame, s.pxPerFrame)]);
    ctx.fillStyle = pal("well", 0.55);
    shadeOutside(ctx, active, row.y, row.h, width);
    if (tr.solve) {
      for (const run of sequenceSolvedRuns(tr.solve, s.placed, tr.mediaId, s, width)) {
        ctx.fillStyle = pal(BAND_TOKEN[run.band], 0.85);
        ctx.fillRect(run.x0, row.solvedY + 1, Math.max(1, run.x1 - run.x0), row.solvedH - 2);
      }
    } else {
      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = pal("fg", 0.2);
      ctx.lineWidth = 1;
      hsegments(ctx, active, crisp(row.solvedY + row.solvedH / 2), width);
      ctx.restore();
    }
    if (tr.stale) {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = pal("user", 0.7);
      ctx.lineWidth = 1;
      hsegments(ctx, [[0, width]], crisp(row.solvedY), width);
      ctx.restore();
    }
    ctx.strokeStyle = pal("fg", 0.15);
    ctx.lineWidth = 1;
    hsegments(ctx, active, crisp(row.userY + row.userH / 2), width);
    drawTrackKeyframes(ctx, s, pal, tr, row.userY, row.userH);
  }
}

// ---- A1…An ----

function drawAudioClip(ctx: Ctx, s: SeqDrawState, pal: SeqPalette, lane: AudioLaneV2, c: AudioClipV2, top: number, h: number) {
  const fps = s.seq.fps;
  const { x0, x1 } = audioClipSpan(c, fps, s);
  const [xa, xb] = visibleX(x0, x1, s.width);
  const w = Math.max(1, xb - xa);
  const src = s.audioSource(c.source);
  const live = c.enabled && !lane.muted;
  const selected = !!s.selectedClipIds?.has(c.id);
  const offline = !src || !!src.missing;
  ctx.save();
  roundRectPath(ctx, xa, top + 1, w, h - 2, 3);
  ctx.fillStyle = pal("clipAudio", live ? 0.28 : 0.1);
  ctx.fill();
  ctx.clip();
  if (src?.peaks) {
    drawWaveform(ctx, pal, {
      mip: src.peaks,
      xa,
      xb,
      top: top + 2,
      h: h - 4,
      startBucket: audioBucketAt(sampleOfFrameExact(s.scrollFrame + xa / s.pxPerFrame, fps), c, src),
      bpp: bucketsPerPixel(fps, s.pxPerFrame),
      factorAt: (x) => clipGainFactor(c, sampleOfFrameExact(s.scrollFrame + x / s.pxPerFrame, fps) - c.start, c.length, lane.gainDb),
      alpha: live ? 1 : 0.35,
    });
  }
  if (!c.enabled) hatch(ctx, xa, xb, top + 1, h - 2, pal("clipDisabled", 0.5));
  drawGainOverlay(ctx, pal, { gain: c, startSample: c.start, length: c.length, fps, view: s, top: top + 1, h: h - 2 }, x0, x1, s.hoverClipId === c.id || selected, !live);
  ctx.restore();
  roundRectPath(ctx, xa + 0.5, top + 1.5, Math.max(1, w - 1), h - 3, 3);
  ctx.lineWidth = offline || selected ? 2 : 1;
  ctx.strokeStyle = offline ? pal("clipOffline") : selected ? pal("clipSelected") : pal("clipAudio", live ? 0.9 : 0.45);
  ctx.stroke();
  if (h < 24) return;
  ctx.font = "10px Inter Variable, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  const name = c.label || src?.name || "";
  const gainText = c.gainDb !== 0 ? s.labels.gainDb(c.gainDb) : "";
  const gw = gainText ? ctx.measureText(gainText).width + 10 : 0;
  const showGain = !!gainText && w > gw + 30;
  if (showGain) label(ctx, gainText, xa, xb, top + 3, 13, pal("fg", 0.75), null, "right");
  label(ctx, offline ? `${s.labels.offline} · ${name}` : name, xa, xb - (showGain ? gw : 0), top + 3, 13, offline ? pal("clipOffline") : pal("fg", 0.9), pal("app", 0.6));
}

function drawLane(ctx: Ctx, s: SeqDrawState, pal: SeqPalette, lane: AudioLaneV2, top: number, h: number) {
  ctx.fillStyle = pal("fg", lane.muted ? 0.015 : 0.03);
  ctx.fillRect(0, top, s.width, h);
  for (const c of lane.clips) {
    const { x0, x1 } = audioClipSpan(c, s.seq.fps, s);
    if (x1 <= 0) continue;
    // 軌內片段依 start 排序（I6）：第一個超出右緣的之後全部都在畫面外
    if (x0 >= s.width) break;
    drawAudioClip(ctx, s, pal, lane, c, top, h);
  }
}

// ---- 範圍、尺規、播放線（樣子跟素材空間 draw.ts 一致）----

function drawRangeShade(ctx: Ctx, s: SeqDrawState, pal: SeqPalette) {
  const L = s.layout;
  const H = L.height;
  const body0 = L.v1Y;
  const xf = (f: number) => xOfFrame(f, s.scrollFrame, s.pxPerFrame);
  const fill = (f0: number, f1: number) => {
    const a = Math.max(0, xf(f0));
    const b = Math.min(s.width, xf(f1));
    if (b > a) ctx.fillRect(a, body0, b - a, H - body0);
  };
  if (s.range) {
    ctx.fillStyle = "rgb(0 0 0 / 0.35)";
    fill(0, s.range.in);
    fill(s.range.out, s.frames);
    ctx.strokeStyle = pal("accent", 0.7);
    ctx.lineWidth = 1;
    vline(ctx, xf(s.range.in), body0, H);
    vline(ctx, xf(s.range.out), body0, H);
  }
  if (s.loop) {
    ctx.fillStyle = pal("accent", 0.08);
    fill(s.loop.in, s.loop.out);
  }
  for (const pf of [s.pendingIn, s.pendingOut]) {
    if (pf == null) continue;
    ctx.strokeStyle = pal("accent");
    ctx.lineWidth = 1;
    vline(ctx, xf(pf), body0, H);
  }
}

/**
 * 標記（Premiere / Resolve 的 marker）：尺規下緣一排小旗子。
 *
 * 畫在尺規裡而不是軌道上 —— 標記是「時間軸上的一個位置」，不屬於任何一軌。
 * 順序上排在 drawRuler 之後、播放線之前：標記要蓋得過刻度，但播放線要蓋得過標記。
 */
function drawMarkers(ctx: Ctx, s: SeqDrawState, pal: SeqPalette): void {
  const ms = s.seq.markers;
  if (!ms?.length) return;
  const { y, h } = markerBand(s.layout);
  const xs = ms.map((m) => Math.round(xOfFrame(m.t, s.scrollFrame, s.pxPerFrame)));

  ctx.fillStyle = pal("warning", 0.95);
  for (let i = 0; i < ms.length; i++) {
    const x = xs[i];
    if (x < -5 || x > s.width + 5) continue;
    ctx.beginPath();
    ctx.moveTo(x - MARKER_HALF_W, y);
    ctx.lineTo(x + MARKER_HALF_W, y);
    ctx.lineTo(x + MARKER_HALF_W, y + h - 3);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x - MARKER_HALF_W, y + h - 3);
    ctx.closePath();
    ctx.fill();
  }

  // 名字畫在旗子右邊，截到下一個標記之前 —— 擠在一起時 label() 會自己放棄，疊字比沒字更糟
  ctx.font = "10px JetBrains Mono Variable, JetBrains Mono, Consolas, monospace";
  ctx.textBaseline = "middle";
  const fg = pal("warning", 0.9);
  for (let i = 0; i < ms.length; i++) {
    const x = xs[i];
    if (!ms[i].name || x < -5 || x > s.width) continue;
    label(ctx, ms[i].name, x + MARKER_HALF_W + 1, Math.min(xs[i + 1] ?? s.width, s.width), y, h, fg, null);
  }
}

function drawRuler(ctx: Ctx, s: SeqDrawState, pal: SeqPalette, spans: readonly ItemSpan[]) {
  const L = s.layout;
  const xf = (f: number) => xOfFrame(f, s.scrollFrame, s.pxPerFrame);
  const bottom = L.rulerY + L.rulerH;
  ctx.fillStyle = pal("panel");
  ctx.fillRect(0, L.rulerY, s.width, L.rulerH);
  const ticks = rulerTicks(s.scrollFrame, s.pxPerFrame, s.width, s.seq.fps, s.frames);
  ctx.strokeStyle = pal("fg", 0.25);
  ctx.lineWidth = 1;
  for (const f of ticks.minor) vline(ctx, xf(f), bottom - 4, bottom);
  ctx.strokeStyle = pal("fg", 0.5);
  ctx.fillStyle = pal("fg", 0.7);
  ctx.font = "10px JetBrains Mono Variable, JetBrains Mono, Consolas, monospace";
  ctx.textBaseline = "top";
  for (const f of ticks.major) {
    const x = xf(f);
    vline(ctx, x, bottom - 9, bottom);
    ctx.fillText(timecode(f, s.seq.fps), x + 3, L.rulerY + 3);
  }
  // 剪輯點在尺規底緣標小三角：縮到整段適配時也看得出切了幾刀
  ctx.fillStyle = pal("clipVideo", 0.9);
  for (const sp of spans) {
    if (sp.t0 === 0) continue;
    ctx.beginPath();
    ctx.moveTo(sp.x0 - 3, bottom);
    ctx.lineTo(sp.x0 + 3, bottom);
    ctx.lineTo(sp.x0, bottom - 4);
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = pal("fg", 0.1);
  ctx.beginPath();
  ctx.moveTo(0, crisp(bottom - 1));
  ctx.lineTo(s.width, crisp(bottom - 1));
  ctx.stroke();
}

function drawPlayhead(ctx: Ctx, pal: SeqPalette, x: number, H: number, width: number) {
  if (x < -2 || x > width + 2) return;
  const cx = crisp(x);
  for (const [color, lw] of [
    [pal("app", 0.92), 6],
    [pal("accent"), 2],
  ] as const) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, H);
    ctx.stroke();
  }
  ctx.fillStyle = pal("accent");
  for (const [tipY, baseY] of [
    [9, 0],
    [H - 9, H],
  ]) {
    ctx.beginPath();
    ctx.moveTo(cx - 6, baseY);
    ctx.lineTo(cx + 6, baseY);
    ctx.lineTo(cx, tipY);
    ctx.closePath();
    ctx.fill();
  }
}

function drawDropZone(ctx: Ctx, s: SeqDrawState, pal: SeqPalette) {
  const L = s.layout;
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = pal("fg", 0.15);
  ctx.lineWidth = 1;
  ctx.strokeRect(4.5, L.dropY + 3.5, Math.max(1, s.width - 9), L.dropH - 7);
  ctx.restore();
  ctx.font = "11px Inter Variable, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.fillStyle = pal("fg", 0.4);
  ctx.fillText(s.labels.dropHint, 12, L.dropY + L.dropH / 2);
}

/**
 * 序列空間整張時間軸。圖層由下而上：背景 → V1 → A0 → 追蹤 → A1…An → 放置區 → 序列結尾後壓暗 → 範圍陰影 → 範圍列 → 尺規 → hover / 吸附 / 播放線。
 * 尺規、範圍列、播放線的樣子跟素材空間（draw.ts）一致：切空間時使用者只該看到「列變了」，不該看到尺規換了一套畫法。
 */
export function drawSequenceTimeline(ctx: Ctx, s: SeqDrawState, pal: SeqPalette): void {
  const { width, layout: L } = s;
  const H = L.height;
  ctx.fillStyle = pal("well");
  ctx.fillRect(0, 0, width, H);

  const spans = visibleItemSpans(s.placed, s, width);
  drawV1(ctx, s, pal, spans);
  drawA0(ctx, s, pal, spans);
  drawTrackRows(ctx, s, pal);
  for (const row of L.lanes) {
    const lane = s.seq.audioLanes.find((l) => l.id === row.laneId);
    if (lane) drawLane(ctx, s, pal, lane, row.y, row.h);
  }
  drawDropZone(ctx, s, pal);

  // 序列結尾之後沒有東西：壓暗，跟「空白片段」（有佔時間的黑畫面）分得開
  const endX = xOfFrame(s.frames, s.scrollFrame, s.pxPerFrame);
  if (endX < width) {
    ctx.fillStyle = pal("well", 0.5);
    ctx.fillRect(Math.max(0, endX), L.v1Y, width - Math.max(0, endX), L.dropY - L.v1Y);
  }

  drawRangeShade(ctx, s, pal);
  drawRangeBand(
    ctx,
    {
      y: L.rangeY,
      h: L.rangeH,
      width,
      scrollFrame: s.scrollFrame,
      pxPerFrame: s.pxPerFrame,
      range: s.range,
      pendingIn: s.pendingIn,
      pendingOut: s.pendingOut,
      hover: s.rangeHover ?? null,
      dragging: !!s.rangeDragging,
      labels: s.rangeLabels ?? [],
      emptyHint: s.rangeEmptyHint ?? null,
      hoverEmpty: !!s.rangeHoverEmpty,
    },
    pal,
  );
  drawRuler(ctx, s, pal, spans);
  drawMarkers(ctx, s, pal);

  if (s.hoverFrame != null) {
    ctx.strokeStyle = pal("fg", 0.3);
    ctx.lineWidth = 1;
    vline(ctx, xOfFrame(s.hoverFrame, s.scrollFrame, s.pxPerFrame), 0, H);
  }
  if (s.snapFrame != null) {
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = pal("accent", 0.9);
    ctx.lineWidth = 1;
    vline(ctx, xOfFrame(s.snapFrame, s.scrollFrame, s.pxPerFrame), L.rangeY, H);
    ctx.restore();
  }
  if (s.currentFrame != null) drawPlayhead(ctx, pal, xOfFrame(s.currentFrame, s.scrollFrame, s.pxPerFrame), H, width);
}

/**
 * 素材空間的「已用於序列」指示（§9.1，FCP 瀏覽器的 used-media）：尺規底緣 3 px 橘線標出序列用到的 k 範圍。
 * 畫在 drawFrameTimeline 之後蓋上去，素材空間的 M1 繪圖本身一行都不用改。
 */
export function drawUsedInSequence(ctx: Ctx, ranges: readonly [number, number][], view: SeqView, width: number, rulerBottom: number, pal: SeqPalette): void {
  ctx.fillStyle = pal("usedInSequence", 0.9);
  for (const [a, b] of ranges) {
    const x0 = Math.max(0, xOfFrame(a, view.scrollFrame, view.pxPerFrame));
    const x1 = Math.min(width, xOfFrame(b, view.scrollFrame, view.pxPerFrame));
    if (x1 > x0) ctx.fillRect(x0, rulerBottom - 3, Math.max(1, x1 - x0), 3);
  }
}

/** 增益顯示「+3.0 dB / 0.0 dB / −12.0 dB」：用真的減號（U+2212），跟正號同寬，一整欄數字才對得齊。 */
export function formatGainDb(db: number): string {
  return `${db > 0 ? "+" : db < 0 ? "−" : ""}${Math.abs(db).toFixed(1)} dB`;
}
