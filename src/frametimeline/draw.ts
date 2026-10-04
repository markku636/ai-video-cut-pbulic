import type { Rational } from "../api";
import type { ShotV1 } from "../project/format";
import { drawLockGlyph } from "../stage/layers/SurfaceLayer";
import { crisp, type Palette, type TokenName } from "../stage/paint";
import { confidenceBand, type ConfidenceBand, type SolveFrame } from "../store/solves";
import { xOfFrame } from "../store/timeline";
import { timecode } from "../time";
import { drawRangeBand, type RangePart } from "./rangeBand";

/**
 * FrameTimeline 的純繪圖與版面算術（計畫 §9 FrameTimeline）。列 = 尺規(timecode)、範圍列（rangeBand.ts）、鏡頭帶、縮圖列、
 * 每 track 兩列：上列「解算 Solved」逐幀紅綠燈信心帶、下列「使用者 User」硬釘實心菱形 / 偵測空心 /
 * 鎖定小鎖 / 參考影格錨標。兩列分離 = Flame `track_shape` vs `shape` 的紀律：重跑 track 永不覆寫使用者關鍵幀。
 *
 * 這個檔不碰 store、不碰 DOM（除了 ctx），版面與 run 合併都能在 node 測。
 */

export const ROW = {
  ruler: 22,
  /**
   * 範圍列（尺規與鏡頭帶之間）：拖出 / 拖端點 / 拖本體平移 in-out。
   * 單獨一列而不是疊在尺規上：尺規拖曳是 scrub，兩個手勢搶同一塊地方就得靠修飾鍵分辨，新手會一直誤觸。
   */
  range: 10,
  shots: 14,
  thumbs: 44,
  solved: 8,
  user: 20,
  gap: 2,
} as const;

/** 縮圖列的一格 = 32 幀（thumb_strip 的快取粒度）。 */
export const THUMB_TILE = 32;
export const DIAMOND = 5;
export const KEYFRAME_HIT_PX = 6;

export interface TrackRows {
  trackId: string;
  y: number;
  h: number;
  solvedY: number;
  solvedH: number;
  userY: number;
  userH: number;
}

export interface TimelineLayout {
  rulerY: number;
  rulerH: number;
  rangeY: number;
  rangeH: number;
  shotsY: number;
  shotsH: number;
  thumbsY: number;
  thumbsH: number;
  tracksY: number;
  rows: TrackRows[];
  height: number;
}

export function layoutRows(trackIds: string[], opts: { thumbs?: boolean } = {}): TimelineLayout {
  const thumbs = opts.thumbs ?? true;
  const rulerY = 0;
  const rangeY = rulerY + ROW.ruler;
  const shotsY = rangeY + ROW.range;
  const thumbsY = shotsY + ROW.shots;
  const thumbsH = thumbs ? ROW.thumbs : 0;
  const tracksY = thumbsY + thumbsH + ROW.gap;
  const rows: TrackRows[] = [];
  let y = tracksY;
  for (const trackId of trackIds) {
    const h = ROW.solved + ROW.user;
    rows.push({ trackId, y, h, solvedY: y, solvedH: ROW.solved, userY: y + ROW.solved, userH: ROW.user });
    y += h + ROW.gap;
  }
  return { rulerY, rulerH: ROW.ruler, rangeY, rangeH: ROW.range, shotsY, shotsH: ROW.shots, thumbsY, thumbsH, tracksY, rows, height: y };
}

// ---- 尺規 ----

/**
 * 主刻度間隔（幀）：1/2/5/10 幀，再往上是整數秒的階梯；取第一個主刻度間距 ≥ minLabelPx 的。
 * 次刻度 = 主刻度 /5（能整除且 ≥ 5 px）否則 /2，再不行就沒有次刻度。
 */
export function tickStep(pxPerFrame: number, fps: Rational, minLabelPx = 90): { major: number; minor: number } {
  const perSec = Math.max(1, Math.ceil(fps.num / fps.den));
  const secs = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  const cands = [1, 2, 5, 10, ...secs.map((s) => s * perSec)].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
  let major = cands[cands.length - 1];
  for (const c of cands) {
    if (c * pxPerFrame >= minLabelPx) {
      major = c;
      break;
    }
  }
  let minor = major;
  if (major % 5 === 0 && (major / 5) * pxPerFrame >= 5) minor = major / 5;
  else if (major % 2 === 0 && (major / 2) * pxPerFrame >= 5) minor = major / 2;
  return { major, minor };
}

export interface RulerTicks {
  major: number[];
  minor: number[];
  step: { major: number; minor: number };
}

export function rulerTicks(scrollFrame: number, pxPerFrame: number, width: number, fps: Rational, totalFrames: number): RulerTicks {
  const step = tickStep(pxPerFrame, fps);
  const first = Math.max(0, Math.floor(scrollFrame / step.minor) * step.minor);
  const last = Math.min(Math.max(0, totalFrames), Math.ceil(scrollFrame + width / pxPerFrame) + step.minor);
  const major: number[] = [];
  const minor: number[] = [];
  for (let f = first; f <= last; f += step.minor) {
    if (f % step.major === 0) major.push(f);
    else minor.push(f);
  }
  return { major, minor, step };
}

// ---- 解算信心帶 ----

export interface BandRun {
  x0: number;
  x1: number;
  band: ConfidenceBand;
}

export const BAND_TOKEN: Record<ConfidenceBand, TokenName> = { good: "solver", warn: "occluded", bad: "lost" };

/**
 * 逐幀信心 → 同色連續段（一幀一個 fillRect 在 1762 幀 × 6 條 track 上會是一萬個矩形）。
 * k 不連續（解有洞）就斷開；只回可視範圍內的段。
 */
export function solvedRuns(frames: SolveFrame[], scrollFrame: number, pxPerFrame: number, width: number): BandRun[] {
  const out: BandRun[] = [];
  let cur: { k0: number; k1: number; band: ConfidenceBand } | null = null;
  const flush = () => {
    if (!cur) return;
    const x0 = xOfFrame(cur.k0, scrollFrame, pxPerFrame);
    const x1 = xOfFrame(cur.k1 + 1, scrollFrame, pxPerFrame);
    // 嚴格不等：剛好貼在左緣外 / 右緣外的段是 0 px 寬，畫了也看不到
    if (x1 > 0 && x0 < width) out.push({ x0: Math.max(-1, x0), x1: Math.min(width + 1, x1), band: cur.band });
    cur = null;
  };
  for (const f of frames) {
    const band = confidenceBand(f);
    if (cur && f.k === cur.k1 + 1 && band === cur.band) {
      cur.k1 = f.k;
      continue;
    }
    flush();
    cur = { k0: f.k, k1: f.k, band };
  }
  flush();
  return out;
}

// ---- 縮圖 ----

export function tileStartOf(frame: number): number {
  return Math.floor(Math.max(0, frame) / THUMB_TILE) * THUMB_TILE;
}

/**
 * 縮圖列要畫哪幾幀：一張縮圖寬 thumbW px，每 step 幀放一張（step = ceil(thumbW / pxPerFrame)），
 * 對齊 step 的倍數，所以捲動時不會整排換人。整段適配 1762 幀 / 1200 px 時 step≈115，只抓十幾格 tile。
 */
export function thumbSampleFrames(scrollFrame: number, pxPerFrame: number, width: number, thumbW: number, totalFrames: number): number[] {
  if (pxPerFrame <= 0 || width <= 0 || totalFrames <= 0) return [];
  const step = Math.max(1, Math.ceil(thumbW / pxPerFrame));
  const first = Math.max(0, Math.floor(scrollFrame / step) * step);
  const out: number[] = [];
  for (let f = first; f < totalFrames && xOfFrame(f, scrollFrame, pxPerFrame) < width; f += step) out.push(f);
  return out;
}

// ---- 整張 ----

export interface LaneKeyframe {
  frame: number;
  source: "user" | "detector";
  locked: boolean;
}

export interface TrackLane {
  id: string;
  label: string;
  selected: boolean;
  stale: boolean;
  keyframes: LaneKeyframe[];
  referenceFrame: number | null;
  solve: SolveFrame[] | null;
  /** 所屬鏡頭 [start, end)；null = 未知。 */
  shotRange: [number, number] | null;
  /**
   * 物件 track：顏色與可見區段（含頭含尾；錨點還沒讀到時是 range 整段）。有這個欄位時解算列畫成物件顏色的色條，
   * 範圍外壓暗用 range 而不是鏡頭。
   */
  object?: { color: string; range: [number, number]; visible: readonly [number, number][] | null };
}

export interface DrawState {
  width: number;
  scrollFrame: number;
  pxPerFrame: number;
  fps: Rational;
  frames: number;
  currentFrame: number;
  range: { in: number; out: number } | null;
  pendingIn: number | null;
  pendingOut: number | null;
  loop: { in: number; out: number } | null;
  shots: ShotV1[];
  shotKindLabel: (kind: ShotV1["kind"]) => string;
  tracks: TrackLane[];
  selectedKeyframe: { trackId: string; frame: number } | null;
  /** null = 不畫縮圖列。 */
  thumbs: { tileAt: (start: number) => CanvasImageSource | null; thumbW: number } | null;
  hoverFrame: number | null;
  /** 範圍列：滑鼠停在哪一段、是否正在拖、帶內長度字候選（長的在前，已 t() 過）。 */
  rangeHover?: RangePart | null;
  rangeDragging?: boolean;
  rangeLabels?: readonly string[];
  /** 還沒有範圍時畫在範圍列中央的提示字（已 t() 過）；沒有範圍列就沒東西說它可以拖。 */
  rangeEmptyHint?: string | null;
  rangeHoverEmpty?: boolean;
  /** 拖範圍時吸附到的幀（畫一條虛線告訴使用者「吸到這裡了」）；null = 沒吸。 */
  snapFrame?: number | null;
  layout: TimelineLayout;
}

function fillSpan(ctx: CanvasRenderingContext2D, s: DrawState, f0: number, f1: number, y: number, h: number) {
  const x0 = Math.max(0, xOfFrame(f0, s.scrollFrame, s.pxPerFrame));
  const x1 = Math.min(s.width, xOfFrame(f1, s.scrollFrame, s.pxPerFrame));
  if (x1 > x0) ctx.fillRect(x0, y, x1 - x0, h);
}

function vline(ctx: CanvasRenderingContext2D, x: number, y0: number, y1: number) {
  ctx.beginPath();
  ctx.moveTo(crisp(x), y0);
  ctx.lineTo(crisp(x), y1);
  ctx.stroke();
}

function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - r, y);
  ctx.closePath();
}

export function drawFrameTimeline(ctx: CanvasRenderingContext2D, s: DrawState, pal: Palette): void {
  const { width, layout: L, scrollFrame, pxPerFrame } = s;
  const H = L.height;
  const xf = (f: number) => xOfFrame(f, scrollFrame, pxPerFrame);

  ctx.fillStyle = pal("well");
  ctx.fillRect(0, 0, width, H);

  // ---- 鏡頭帶 ----
  ctx.fillStyle = pal("inset");
  ctx.fillRect(0, L.shotsY, width, L.shotsH);
  ctx.font = "10px Inter Variable, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  s.shots.forEach((sh, i) => {
    const x0 = xf(sh.startFrame);
    const x1 = xf(sh.endFrame);
    if (x1 < 0 || x0 > width) return;
    ctx.fillStyle = pal("shot", i % 2 ? 0.2 : 0.32);
    fillSpan(ctx, s, sh.startFrame, sh.endFrame, L.shotsY, L.shotsH);
    ctx.strokeStyle = pal("shot", sh.source === "user" ? 1 : 0.7);
    ctx.lineWidth = 1;
    vline(ctx, x0, L.shotsY, L.shotsY + L.shotsH);
    if (x1 - x0 > 44) {
      ctx.fillStyle = pal("fg", 0.75);
      ctx.fillText(s.shotKindLabel(sh.kind), Math.max(x0, 0) + 4, L.shotsY + L.shotsH / 2);
    }
  });

  // ---- 縮圖列 ----
  if (s.thumbs && L.thumbsH > 0) {
    ctx.fillStyle = pal("inset", 0.6);
    ctx.fillRect(0, L.thumbsY, width, L.thumbsH);
    const { tileAt, thumbW } = s.thumbs;
    for (const f of thumbSampleFrames(scrollFrame, pxPerFrame, width, thumbW, s.frames)) {
      const x = xf(f);
      const start = tileStartOf(f);
      const tile = tileAt(start);
      if (tile) {
        const tw = "width" in tile ? Number(tile.width) : 0;
        const th = "height" in tile ? Number(tile.height) : 0;
        if (tw > 0 && th > 0) {
          const sw = tw / THUMB_TILE;
          try {
            ctx.drawImage(tile, (f - start) * sw, 0, sw, th, x, L.thumbsY, thumbW, L.thumbsH);
          } catch {
            /* 圖還沒解碼完 */
          }
          continue;
        }
      }
      ctx.fillStyle = pal("fg", 0.04);
      ctx.fillRect(x, L.thumbsY, thumbW - 1, L.thumbsH);
    }
  }

  // ---- 車道 ----
  ctx.font = "11px Inter Variable, system-ui, sans-serif";
  for (let i = 0; i < s.tracks.length; i++) {
    const tr = s.tracks[i];
    const row = L.rows[i];
    if (!row) break;
    ctx.fillStyle = tr.selected ? pal("accent", 0.1) : pal("fg", 0.03);
    ctx.fillRect(0, row.y, width, row.h);
    // 鏡頭範圍外壓暗：這條 track 不屬於那裡（物件 track 看自己的範圍）
    const span = tr.object ? tr.object.range : tr.shotRange;
    if (span) {
      ctx.fillStyle = pal("well", 0.55);
      fillSpan(ctx, s, 0, span[0], row.y, row.h);
      fillSpan(ctx, s, span[1], s.frames, row.y, row.h);
    }
    // 解算列（物件 track：看得到物件的幀畫成物件的顏色）
    if (tr.object) {
      ctx.save();
      ctx.fillStyle = tr.object.color;
      ctx.globalAlpha = tr.selected ? 0.85 : 0.6;
      for (const [a, b] of tr.object.visible ?? [[tr.object.range[0], tr.object.range[1] - 1]]) fillSpan(ctx, s, a, b + 1, row.solvedY + 1, row.solvedH - 2);
      ctx.restore();
    } else if (tr.solve) {
      for (const run of solvedRuns(tr.solve, scrollFrame, pxPerFrame, width)) {
        ctx.fillStyle = pal(BAND_TOKEN[run.band], 0.85);
        ctx.fillRect(run.x0, row.solvedY + 1, Math.max(1, run.x1 - run.x0), row.solvedH - 2);
      }
    } else {
      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = pal("fg", 0.2);
      ctx.lineWidth = 1;
      const y = crisp(row.solvedY + row.solvedH / 2);
      ctx.beginPath();
      ctx.moveTo(tr.shotRange ? Math.max(0, xf(tr.shotRange[0])) : 0, y);
      ctx.lineTo(tr.shotRange ? Math.min(width, xf(tr.shotRange[1])) : width, y);
      ctx.stroke();
      ctx.restore();
    }
    if (tr.stale) {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = pal("user", 0.7);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, crisp(row.solvedY));
      ctx.lineTo(width, crisp(row.solvedY));
      ctx.stroke();
      ctx.restore();
    }
    // 使用者列：基線 + 錨標 + 菱形
    const cy = row.userY + row.userH / 2;
    ctx.strokeStyle = pal("fg", 0.15);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tr.shotRange ? Math.max(0, xf(tr.shotRange[0])) : 0, crisp(cy));
    ctx.lineTo(tr.shotRange ? Math.min(width, xf(tr.shotRange[1])) : width, crisp(cy));
    ctx.stroke();
    if (tr.referenceFrame !== null) {
      const x = xf(tr.referenceFrame);
      if (x >= -8 && x <= width + 8) {
        ctx.strokeStyle = pal("info");
        ctx.fillStyle = pal("info");
        ctx.lineWidth = 1.5;
        vline(ctx, x, row.userY + 2, row.userY + row.userH - 2);
        ctx.beginPath();
        ctx.arc(crisp(x), row.userY + 4, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (const kf of tr.keyframes) {
      const x = xf(kf.frame);
      if (x < -DIAMOND - 2 || x > width + DIAMOND + 2) continue;
      const sel = s.selectedKeyframe?.trackId === tr.id && s.selectedKeyframe.frame === kf.frame;
      const r = sel ? DIAMOND + 2 : DIAMOND;
      diamond(ctx, Math.round(x), Math.round(cy), r);
      if (kf.source === "user") {
        ctx.fillStyle = pal("user");
        ctx.fill();
        ctx.strokeStyle = pal("app", 0.9);
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.fillStyle = pal("well");
        ctx.fill();
        ctx.strokeStyle = pal("user", 0.9);
        ctx.lineWidth = 1.25;
        ctx.stroke();
      }
      if (sel) {
        ctx.strokeStyle = pal("accent");
        ctx.lineWidth = 1.5;
        diamond(ctx, Math.round(x), Math.round(cy), r + 3);
        ctx.stroke();
      }
      if (kf.locked) drawLockGlyph(ctx, [x + 8, row.userY + 5], pal("user"), 6);
    }
    // 車道標籤（左上角，選中才亮）
    const label = tr.label;
    if (label) {
      const w = ctx.measureText(label).width + 8;
      ctx.fillStyle = pal("app", 0.75);
      ctx.fillRect(4, row.userY + 2, w, 15);
      ctx.fillStyle = tr.selected ? pal("accent") : pal("fg", 0.7);
      ctx.fillText(label, 8, row.userY + 2 + 7.5);
    }
  }

  // ---- in/out 陰影、循環、pending 旗標 ----
  const body0 = L.shotsY;
  if (s.range) {
    ctx.fillStyle = "rgb(0 0 0 / 0.35)";
    fillSpan(ctx, s, 0, s.range.in, body0, H - body0);
    fillSpan(ctx, s, s.range.out, s.frames, body0, H - body0);
    ctx.strokeStyle = pal("accent", 0.7);
    ctx.lineWidth = 1;
    vline(ctx, xf(s.range.in), body0, H);
    vline(ctx, xf(s.range.out), body0, H);
  }
  if (s.loop) {
    ctx.fillStyle = pal("accent", 0.08);
    fillSpan(ctx, s, s.loop.in, s.loop.out, body0, H - body0);
  }
  for (const pf of [s.pendingIn, s.pendingOut]) {
    if (pf == null) continue;
    ctx.strokeStyle = pal("accent");
    ctx.lineWidth = 1;
    vline(ctx, xf(pf), body0, H);
  }

  // ---- 範圍列（在尺規與鏡頭帶之間；本體外陰影從鏡頭帶開始，不會蓋到它）----
  drawRangeBand(
    ctx,
    {
      y: L.rangeY,
      h: L.rangeH,
      width,
      scrollFrame,
      pxPerFrame,
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

  // ---- 尺規（最後畫，蓋在陰影上）----
  ctx.fillStyle = pal("panel");
  ctx.fillRect(0, L.rulerY, width, L.rulerH);
  const ticks = rulerTicks(scrollFrame, pxPerFrame, width, s.fps, s.frames);
  ctx.strokeStyle = pal("fg", 0.25);
  ctx.lineWidth = 1;
  for (const f of ticks.minor) vline(ctx, xf(f), L.rulerY + L.rulerH - 4, L.rulerY + L.rulerH);
  ctx.strokeStyle = pal("fg", 0.5);
  ctx.fillStyle = pal("fg", 0.7);
  ctx.font = "10px JetBrains Mono Variable, JetBrains Mono, Consolas, monospace";
  ctx.textBaseline = "top";
  for (const f of ticks.major) {
    const x = xf(f);
    vline(ctx, x, L.rulerY + L.rulerH - 9, L.rulerY + L.rulerH);
    ctx.fillText(timecode(f, s.fps), x + 3, L.rulerY + 3);
  }
  ctx.strokeStyle = pal("fg", 0.1);
  ctx.beginPath();
  ctx.moveTo(0, crisp(L.rulerY + L.rulerH - 1));
  ctx.lineTo(width, crisp(L.rulerY + L.rulerH - 1));
  ctx.stroke();

  // ---- hover 線 ----
  if (s.hoverFrame != null) {
    ctx.strokeStyle = pal("fg", 0.3);
    ctx.lineWidth = 1;
    vline(ctx, xf(s.hoverFrame), 0, H);
  }

  // ---- 吸附指示：吸附一定要看得到，不然端點自己跳幾幀，使用者只會覺得「我明明放在這裡」----
  if (s.snapFrame != null) {
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = pal("accent", 0.9);
    ctx.lineWidth = 1;
    vline(ctx, xf(s.snapFrame), L.rangeY, H);
    ctx.restore();
  }

  // ---- 播放線：深色暈圈 + 2 px 亮線 + 上下三角（沿 PlayheadOverlay）----
  const px = xf(s.currentFrame);
  if (px >= -2 && px <= width + 2) {
    const x = crisp(px);
    ctx.strokeStyle = pal("app", 0.92);
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
    ctx.strokeStyle = pal("accent");
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
    ctx.fillStyle = pal("accent");
    for (const [tipY, baseY] of [
      [9, 0],
      [H - 9, H],
    ]) {
      ctx.beginPath();
      ctx.moveTo(x - 6, baseY);
      ctx.lineTo(x + 6, baseY);
      ctx.lineTo(x, tipY);
      ctx.closePath();
      ctx.fill();
    }
  }
}
