// 序列空間時間軸的版面與座標換算（docs/editor-m2-design.md §9.2–9.3）：純函式，不碰 store、不碰 DOM。
//
// 為什麼跟 draw.ts 的 layoutRows 分開：序列空間的列（V1 片段、A0 原音、追蹤群組、A1…An、放置區）跟素材空間完全不同，
// 硬塞進同一個版面物件會讓 M1 的命中與繪圖到處多出「這一列在這個空間存不存在」的判斷。兩個空間共用的只有尺規與範圍列，
// 高度常數直接沿用 draw.ts 的 ROW，兩邊的尺規才會對齊（切空間時尺規不會跳）。
import type { Rational, SequenceV2 } from "../project/format";
import { mapFrame, placeVideo, type PlacedItem } from "../sequence/map";
import { materialize } from "../sequence/ops";
import { xOfFrame } from "../store/timeline";
import { ROW, type TrackRows } from "./draw";

export const SEQ_ROW = {
  ruler: ROW.ruler,
  range: ROW.range,
  /** V1 片段列（內嵌縮圖；同 M1 縮圖列高，縮圖 tile 的快取可以共用）。 */
  v1: ROW.thumbs,
  a0: 36,
  /** 追蹤群組的標頭（「追蹤（6）」＋摺疊箭頭）。 */
  tracksHeader: 16,
  /** 放置區：「把音訊檔拖到這裡新增音軌」。 */
  drop: 24,
  gap: ROW.gap,
} as const;

/** 音軌高度三檔（§9.2「40（可調 16／40／72）」）：16 = 只看得到有沒有片段，72 = 修音量線用。 */
export const LANE_HEIGHTS = [16, 40, 72] as const;
export type LaneHeight = (typeof LANE_HEIGHTS)[number];
export const DEFAULT_LANE_HEIGHT: LaneHeight = 40;

/** 左側 DOM 軌道標頭寬（§9.2）；canvas 右移這麼多。 */
export const TRACK_HEADER_W = 132;

/** 任意數字 → 最接近的合法音軌高度（localStorage 讀回來的舊值 / 壞值不會讓版面長出奇怪的列高）。 */
export function normalizeLaneHeight(h: number | null | undefined): LaneHeight {
  if (typeof h !== "number" || !Number.isFinite(h)) return DEFAULT_LANE_HEIGHT;
  let best: LaneHeight = LANE_HEIGHTS[0];
  for (const c of LANE_HEIGHTS) if (Math.abs(c - h) < Math.abs(best - h)) best = c;
  return best;
}

/** 下一檔高度（標頭的高度切換鈕：16 → 40 → 72 → 16）。 */
export function nextLaneHeight(h: number): LaneHeight {
  const i = LANE_HEIGHTS.indexOf(normalizeLaneHeight(h));
  return LANE_HEIGHTS[(i + 1) % LANE_HEIGHTS.length];
}

export interface SeqTrackRows extends TrackRows {
  mediaId: string;
}

export interface SeqLaneRow {
  laneId: string;
  y: number;
  h: number;
}

export interface SequenceLayout {
  rulerY: number;
  rulerH: number;
  rangeY: number;
  rangeH: number;
  v1Y: number;
  v1H: number;
  a0Y: number;
  a0H: number;
  /** 追蹤群組標頭；沒有任何 track 時高度 0（整組不顯示）。 */
  tracksHeaderY: number;
  tracksHeaderH: number;
  tracksCollapsed: boolean;
  /** 群組摺疊時是空陣列（track 仍然存在，只是不佔高度）。 */
  rows: SeqTrackRows[];
  lanes: SeqLaneRow[];
  dropY: number;
  dropH: number;
  height: number;
}

export interface SeqTrackRef {
  id: string;
  mediaId: string;
}

/**
 * 序列空間的列（由上而下，§9.2）：尺規 → 範圍列 → V1 片段 → A0 原音 → 追蹤群組（可摺疊）→ A1…An → 放置區。
 * laneHeights 缺值 = 預設 40；列與列之間留 ROW.gap，跟 M1 的車道間距一樣。
 */
export function layoutSequenceRows(
  seq: Pick<SequenceV2, "audioLanes"> | null,
  tracks: readonly SeqTrackRef[],
  laneHeights: Readonly<Record<string, number>> = {},
  opts: { tracksCollapsed?: boolean } = {},
): SequenceLayout {
  const g = SEQ_ROW.gap;
  const rulerY = 0;
  const rangeY = rulerY + SEQ_ROW.ruler;
  const v1Y = rangeY + SEQ_ROW.range;
  const a0Y = v1Y + SEQ_ROW.v1 + g;
  let y = a0Y + SEQ_ROW.a0 + g;
  const tracksCollapsed = !!opts.tracksCollapsed;
  const tracksHeaderY = y;
  const tracksHeaderH = tracks.length ? SEQ_ROW.tracksHeader : 0;
  if (tracksHeaderH) y += tracksHeaderH + g;
  const rows: SeqTrackRows[] = [];
  if (!tracksCollapsed) {
    for (const t of tracks) {
      const h = ROW.solved + ROW.user;
      rows.push({ trackId: t.id, mediaId: t.mediaId, y, h, solvedY: y, solvedH: ROW.solved, userY: y + ROW.solved, userH: ROW.user });
      y += h + g;
    }
  }
  const lanes: SeqLaneRow[] = [];
  for (const lane of seq?.audioLanes ?? []) {
    const h = normalizeLaneHeight(laneHeights[lane.id]);
    lanes.push({ laneId: lane.id, y, h });
    y += h + g;
  }
  const dropY = y;
  const dropH = SEQ_ROW.drop;
  return {
    rulerY,
    rulerH: SEQ_ROW.ruler,
    rangeY,
    rangeH: SEQ_ROW.range,
    v1Y,
    v1H: SEQ_ROW.v1,
    a0Y,
    a0H: SEQ_ROW.a0,
    tracksHeaderY,
    tracksHeaderH,
    tracksCollapsed,
    rows,
    lanes,
    dropY,
    dropH,
    height: dropY + dropH,
  };
}

// ---- 座標換算 ----

export interface SeqView {
  scrollFrame: number;
  pxPerFrame: number;
}

/**
 * 序列樣本 → 小數序列幀：`t = sample · num / (48000 · den)`（§9.3）。
 * 不經過 frameOfSample（它是 floor 到整數幀）：音訊片段可以從幀中間開始，畫在整數幀上會在 29.97 fps 時偏掉最多一整格。
 */
export function frameOfSampleExact(sample: number, fps: Rational, sampleRate = 48000): number {
  return (sample * fps.num) / (sampleRate * fps.den);
}

/** 序列樣本 → x（px）。 */
export function xOfSample(sample: number, fps: Rational, view: SeqView, sampleRate = 48000): number {
  return xOfFrame(frameOfSampleExact(sample, fps, sampleRate), view.scrollFrame, view.pxPerFrame);
}

/** x → 小數序列樣本（命中測試回報 sample 用；呼叫端自己決定要不要吸附到幀）。 */
export function sampleOfX(x: number, fps: Rational, view: SeqView, sampleRate = 48000): number {
  const t = view.scrollFrame + x / view.pxPerFrame;
  return (t * sampleRate * fps.den) / fps.num;
}

// ---- 隱含序列與播放線 ----

/** 畫隱含序列需要的媒體事實（ProjectMediaV2 的子集）。 */
export interface ImplicitMediaLike {
  id: string;
  name: string;
  proxy: { fps: Rational; frames: number; width: number; height: number; scale: number } | null;
  probe?: { video?: { width: number; height: number } | null } | null;
}

/**
 * 時間軸要畫的序列：實體序列原樣；隱含序列（null）→ 作用中媒體整段一個片段（§9.1「隱含序列畫成一個整段片段，
 * 看起來跟 M1 幾乎一樣」）。只是畫，不 commit：真的剪下去才由 editSequence 在同一筆 undo 裡實體化。
 * 沒有作用中媒體或 proxy 還沒好 → null（時間軸退回素材空間的畫法）。
 * 直接呼叫 ops.ts 的 materialize（不自己再組一份）：實體化前後的序列 / 片段 id 一致，hover / 選取不會因為第一刀而跳掉。
 */
export function viewSequenceOf(seq: SequenceV2 | null, active: ImplicitMediaLike | null): SequenceV2 | null {
  if (seq) return seq;
  const px = active?.proxy;
  if (!active || !px || px.frames < 1) return null;
  const v = active.probe?.video;
  return materialize({
    id: active.id,
    name: active.name,
    frames: px.frames,
    fps: px.fps,
    width: v?.width ?? Math.round(px.width / (px.scale || 1)),
    height: v?.height ?? Math.round(px.height / (px.scale || 1)),
    audio: null,
  });
}

/**
 * 序列空間的播放線位置（序列幀）。
 * - `seqFrame`（playback.seqFrame，M2.11 的序列播放器寫）跟目前的 (作用中媒體, k) 對得上 → 用它：
 *   同一個來源幀在序列裡出現兩次時，只有播放器知道現在在哪一次。
 * - 對不上（素材空間 seek 過、或播放器還沒接）→ 第一個含 (媒體, k) 的片段位置。
 * - 都沒有（這一幀沒用在序列裡）→ seqFrame 原值；沒有就 null（不畫播放線）。
 */
export function sequencePlayhead(seq: SequenceV2, activeMediaId: string | null, k: number, seqFrame?: number | null, placed: readonly PlacedItem[] = placeVideo(seq)): number | null {
  if (typeof seqFrame === "number" && Number.isFinite(seqFrame)) {
    const m = mapFrame(seq, seqFrame, placed);
    if (m.item?.kind === "clip" && m.item.mediaId === activeMediaId && m.itemK === k) return seqFrame;
  }
  if (activeMediaId) {
    for (const p of placed) {
      const it = p.item;
      if (it.kind === "clip" && it.mediaId === activeMediaId && k >= it.srcIn && k < it.srcOut) return p.t0 + (k - it.srcIn);
    }
  }
  return typeof seqFrame === "number" && Number.isFinite(seqFrame) ? seqFrame : null;
}

/**
 * 素材空間「已用於序列」的 k 範圍（§9.1 FCP used-media 指示）：某媒體被 V1 片段用到的 [srcIn, srcOut)，排序後合併重疊 / 相鄰。
 * 停用的片段也算「用到」（它還在序列裡佔位，只是暫時黑畫面）。
 */
export function usedSourceRanges(seq: Pick<SequenceV2, "video">, mediaId: string): [number, number][] {
  const spans = seq.video.flatMap((it) => (it.kind === "clip" && it.mediaId === mediaId && it.srcOut > it.srcIn ? [[it.srcIn, it.srcOut] as [number, number]] : []));
  spans.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else out.push([s[0], s[1]]);
  }
  return out;
}
