// 序列的時間對應表（docs/editor-m2-design.md §3.1、§3.3、§7.1）：純函式，沒有狀態、不碰 store。
//
// 序列只是一張 `t → (mediaId, k)` 的表（D13）：剪輯永遠不改 tracks / masks，渲染與預覽都靠這裡把序列幀換回來源 proxy 幀。
// Python `aivc/sequence/model.py` 有一份同樣的實作，兩邊讀同一份 `fixtures/sequence/map-cases.json` 驗證 —— 改公式要兩邊一起改。
//
// 全部是整數運算：浮點秒在 200 個片段之後會漂出看得見的縫（§3.1）。
import { SEQ_SAMPLE_RATE, type AudioInfoV2, type GapV2, type Rational, type SequenceV2, type VideoClipV2, type VideoItemV2 } from "../project/format";

/**
 * 整數的 floor(a / b)（b > 0）。a 可能到 1e15 等級（1 小時 × 48000 × 1001）：`Math.floor(a / b)` 的浮點商在接近整數時
 * 會進位成下一個整數，所以用商再以乘法校正一次（a、q·b 都 < 2^53，乘法是精確的）。
 */
export function floorDiv(a: number, b: number): number {
  let q = Math.floor(a / b);
  while (q * b > a) q--;
  while ((q + 1) * b <= a) q++;
  return q;
}

/** x.5 一律往 +∞（同 JS Math.round；Python 端不能用銀行家捨入的 round()）。 */
export function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

/**
 * 序列幀 t 的起始樣本：`S(t) = floor(t · 48000 · den / num)`。
 * 一律從絕對 t 算、不累加：每個片段各自 round 會在接縫留下 ±1 樣本的縫或重疊，200 個片段後就漂 200 樣本。
 */
export function samplesOfFrame(t: number, fps: Rational, sr: number = SEQ_SAMPLE_RATE): number {
  return floorDiv(t * sr * fps.den, fps.num);
}

/** 樣本 → 所在的序列幀（`S(t) ≤ s` 的最大 t）。音訊片段畫在時間軸上、吸附到幀時用。 */
export function frameOfSample(s: number, fps: Rational, sr: number = SEQ_SAMPLE_RATE): number {
  let t = floorDiv(s * fps.num, sr * fps.den);
  // S 是 floor 過的，反算可能差 1：往回校正到「S(t) ≤ s」成立
  while (samplesOfFrame(t, fps, sr) > s) t--;
  while (samplesOfFrame(t + 1, fps, sr) <= s) t++;
  return t;
}

/** V1 項目在序列上佔幾幀（M2 不做變速：1 個 proxy 幀 = 1 個序列幀）。 */
export function itemLength(it: VideoItemV2): number {
  return it.kind === "clip" ? it.srcOut - it.srcIn : it.length;
}

export interface PlacedItem<T extends VideoItemV2 = VideoItemV2> {
  item: T;
  /** 在 seq.video 裡的索引。 */
  index: number;
  /** 序列幀（含）。 */
  t0: number;
  /** 序列幀（不含）。 */
  t1: number;
}

/** V1 磁吸：位置 = 前面所有項目長度之和（§3.2）。 */
export function placeVideo(seq: Pick<SequenceV2, "video">): PlacedItem[] {
  const out: PlacedItem[] = [];
  let t = 0;
  seq.video.forEach((item, index) => {
    const t1 = t + itemLength(item);
    out.push({ item, index, t0: t, t1 });
    t = t1;
  });
  return out;
}

/** 序列總幀數 T。 */
export function durationFrames(seq: Pick<SequenceV2, "video">): number {
  let t = 0;
  for (const it of seq.video) t += itemLength(it);
  return t;
}

/** 序列總樣本數 S(T)：輸出音訊解碼後剛好這麼多樣本（I3）。 */
export function totalSamples(seq: Pick<SequenceV2, "video" | "fps">): number {
  return samplesOfFrame(durationFrames(seq), seq.fps);
}

/** V1 片段原音在序列上的樣本長度 S(t1) − S(t0)（29.97 fps 時跟位置有關）。 */
export function placedSampleLength(p: Pick<PlacedItem, "t0" | "t1">, fps: Rational): number {
  return samplesOfFrame(p.t1, fps) - samplesOfFrame(p.t0, fps);
}

/** 二分搜尋覆蓋 t 的項目（t 超出 [0, T) 回 null）。placed 必須是 placeVideo 的結果。 */
/**
 * 某支媒體的來源幀 k → 序列幀 t。
 *
 * 剪過的序列可能重複用同一段來源，所以一個 k 可能對到好幾個 t（回陣列、去重、排序）；
 * 完全沒被用到就回空的。`srcOut` 不含，所以落在片段尾巴之外的 k 不算。
 */
export function projectFrames(seq: Pick<SequenceV2, "video">, mediaId: string, ks: readonly number[]): number[] {
  const out: number[] = [];
  for (const p of placeVideo(seq)) {
    const it = p.item;
    if (it.kind !== "clip" || it.mediaId !== mediaId) continue;
    for (const k of ks) if (k >= it.srcIn && k < it.srcOut) out.push(p.t0 + (k - it.srcIn));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

export function placedAt(placed: readonly PlacedItem[], t: number): PlacedItem | null {
  let lo = 0;
  let hi = placed.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = placed[mid];
    if (t < p.t0) hi = mid - 1;
    else if (t >= p.t1) lo = mid + 1;
    else return p;
  }
  return null;
}

export interface FrameMapping {
  /** 覆蓋 t 的項目（gap 或 clip，含停用的）。 */
  item: VideoItemV2 | null;
  /** clip 的來源 proxy 幀（gap 為 null）；停用片段也有值（時間軸要畫它的縮圖）。 */
  itemK: number | null;
  /** 渲染用：空白或停用片段為 null（輸出黑畫面）。 */
  clip: VideoClipV2 | null;
  k: number | null;
}

/** t → (片段, 來源 proxy 幀 k)。map-cases.json 的 `frames` 就是這個函式的期望值。 */
export function mapFrame(seq: Pick<SequenceV2, "video">, t: number, placed: readonly PlacedItem[] = placeVideo(seq)): FrameMapping {
  const p = placedAt(placed, t);
  if (!p) return { item: null, itemK: null, clip: null, k: null };
  if (p.item.kind === "gap") return { item: p.item as GapV2, itemK: null, clip: null, k: null };
  const clip = p.item as VideoClipV2;
  const k = clip.srcIn + (t - p.t0);
  return clip.enabled ? { item: clip, itemK: k, clip, k } : { item: clip, itemK: k, clip: null, k: null };
}

/** proxy 幀 k 的容器絕對時間（µs）：`videoStartUs + round(k · 1e6 · den / num)`。 */
export function videoAbsUs(k: number, fps: Rational, videoStartUs: number): number {
  return videoStartUs + roundHalfUp((k * 1e6 * fps.den) / fps.num);
}

/** 音訊片段入點的容器絕對時間（µs）：`startUs + round(srcIn · 1e6 / sampleRate)`；srcIn 可為負。 */
export function audioAbsUs(srcIn: number, info: Pick<AudioInfoV2, "startUs" | "sampleRate">): number {
  return info.startUs + roundHalfUp((srcIn * 1e6) / info.sampleRate);
}

/** `-c:a copy` 閘門需要知道的媒體事實：proxy 幀數（不知道 = null，保守地不 copy）。 */
export type FramesOf = (mediaId: string) => number | null | undefined;

/**
 * 序列是否「等於單一未動過的整段片段、且沒有任何音訊片段」（§7.1，Python `is_untouched` 同規則）。
 * 比的是值不是 null：B 切一刀再按 B 合併，雖然已實體化，仍回到 `-c:a copy` 路徑。
 * 不看：fadeCurve（淡化長度都是 0 時不影響輸出）、軌道自己的 muted / gainDb、sequence.audio（單一整段片段沒有接縫）。
 */
export function isUntouched(seq: SequenceV2 | null, framesOf: FramesOf): boolean {
  if (seq === null) return true;
  if (seq.video.length !== 1) return false;
  const it = seq.video[0];
  if (it.kind !== "clip" || !it.enabled || it.srcIn !== 0) return false;
  const frames = framesOf(it.mediaId);
  if (frames == null || it.srcOut !== frames) return false;
  const a = it.audio;
  if (!a.enabled || a.gainDb !== 0 || a.fadeIn !== 0 || a.fadeOut !== 0 || a.envelope.length > 0 || a.detachedTo !== undefined) return false;
  if (seq.original.muted || seq.original.gainDb !== 0) return false;
  return seq.audioLanes.every((l) => l.clips.length === 0);
}
