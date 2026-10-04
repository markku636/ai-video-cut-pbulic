// 音訊軌（A1…An）的樣本級編輯積木：切片、移除一段時間（波紋）、插入一段時間、分離參照修補。
// V1 的波紋動作（ops.ts）與音訊片段動作（audioOps.ts）共用，規則只寫一份。
import { SEQ_SAMPLE_RATE, type AudioClipV2, type AudioLaneV2, type AudioSourceRefV2, type SequenceV2 } from "../project/format";
import { sourceAudioInfo, type SeqCtx } from "./context";
import { fitGain, sliceEnvelope } from "./envelope";
import { takeId } from "./ids";
import { roundHalfUp } from "./map";

/** 來源原生取樣率；還沒跑 audio_info 時當 48 kHz（只影響切開後 srcIn 前進多少）。 */
export function nativeRate(ctx: SeqCtx | undefined, c: AudioClipV2): number {
  return sourceAudioInfo(ctx, c.source)?.sampleRate ?? SEQ_SAMPLE_RATE;
}

/** 序列樣本 d → 來源原生樣本（x.5 往 +∞）。分割與合併用同一個算式，切開再接回時 srcIn 才對得上。 */
export function srcAdvance(d: number, sr: number): number {
  return roundHalfUp((d * sr) / SEQ_SAMPLE_RATE);
}

/**
 * 取出片段內 [from, to)（片段內相對序列樣本）成為新片段，start 由呼叫端決定。
 * 淡入只跟著「保留開頭」的那段、淡出只跟著「保留結尾」的那段（淡化屬於那一段內容）；曲線切出來、兩端補內插點。
 */
export function sliceAudioClip(c: AudioClipV2, from: number, to: number, sr: number, patch: { id?: string; start: number }): AudioClipV2 {
  const whole = from === 0 && to === c.length;
  const next: AudioClipV2 = {
    ...c,
    id: patch.id ?? c.id,
    start: patch.start,
    length: to - from,
    srcIn: c.srcIn + srcAdvance(from, sr),
    fadeIn: from === 0 ? c.fadeIn : 0,
    fadeOut: to === c.length ? c.fadeOut : 0,
    envelope: whole ? c.envelope : sliceEnvelope(c.envelope, from, to),
  };
  return fitGain(next, next.length);
}

/** 陣列 map 的結構共享版：每個元素都回傳自己時，回傳原陣列（呼叫端用參照判斷「沒變」）。 */
export function mapShared<T>(xs: readonly T[], f: (x: T, i: number) => T): T[] {
  let out: T[] | null = null;
  xs.forEach((x, i) => {
    const y = f(x, i);
    if (out === null && y !== x) out = xs.slice(0, i);
    if (out !== null) out.push(y);
  });
  return out ?? (xs as T[]);
}

/**
 * 從一條軌移除序列樣本 [A, B)，後面的往前補（Premiere Extract 語意，設計 §5.2 rippleDelete 那一欄）：
 * 完全在 B 之後 → start −= L；完全在 [A, B) 內 → 刪；跨 A 或 B → 切開、保留 [A, B) 以外的部分並接回。
 * removed 收集被整段刪掉的片段 id（分離參照要跟著清）。
 */
export function removeSampleRange(lane: AudioLaneV2, A: number, B: number, ctx: SeqCtx | undefined, taken: Set<string>, removed?: Set<string>): AudioLaneV2 {
  const L = B - A;
  if (L <= 0) return lane;
  let changed = false;
  const clips: AudioClipV2[] = [];
  for (const c of lane.clips) {
    const end = c.start + c.length;
    if (end <= A) {
      clips.push(c);
      continue;
    }
    changed = true;
    if (c.start >= B) {
      clips.push({ ...c, start: c.start - L });
      continue;
    }
    if (c.start >= A && end <= B) {
      removed?.add(c.id);
      continue;
    }
    const sr = nativeRate(ctx, c);
    if (c.start < A) clips.push(sliceAudioClip(c, 0, A - c.start, sr, { start: c.start }));
    // 兩邊都留下時後段要新 id；只留後段時沿用原 id（選取、分離參照都還指得到）
    if (end > B) clips.push(sliceAudioClip(c, B - c.start, c.length, sr, { id: c.start < A ? takeId(taken, "aclip") : c.id, start: A }));
  }
  return changed ? { ...lane, clips } : lane;
}

/**
 * 在序列樣本 P 插入 D 個樣本的時間（V1 在 P 變長 Δ，設計 §5.2 trimEdge 那一欄）：
 * start ≥ P → +D；跨 P 的片段在 P 切開、後段 +D。
 */
export function insertSamples(lane: AudioLaneV2, P: number, D: number, ctx: SeqCtx | undefined, taken: Set<string>): AudioLaneV2 {
  if (D <= 0) return lane;
  let changed = false;
  const clips: AudioClipV2[] = [];
  for (const c of lane.clips) {
    const end = c.start + c.length;
    if (end <= P) {
      clips.push(c);
      continue;
    }
    changed = true;
    if (c.start >= P) {
      clips.push({ ...c, start: c.start + D });
      continue;
    }
    const sr = nativeRate(ctx, c);
    clips.push(sliceAudioClip(c, 0, P - c.start, sr, { start: c.start }));
    clips.push(sliceAudioClip(c, P - c.start, c.length, sr, { id: takeId(taken, "aclip"), start: P + D }));
  }
  return changed ? { ...lane, clips } : lane;
}

/**
 * 修補分離參照：V1 片段的 detachedTo 指到已不存在的音訊片段 → 清掉（原音維持靜音：使用者刪的是那段聲音，不是要它回來）；
 * 音訊片段的 detachedFrom 指到已不存在的 V1 片段 → 清掉。renamed（合併切點時被併掉的 id → 留下來的 id）先套用。
 * 跟 sanitize 的差別：sanitize 讀檔時不知道發生過什麼，所以把原音恢復；這裡知道是剪輯刪掉的。
 */
export function repairDetachRefs(seq: SequenceV2, renamed?: ReadonlyMap<string, string>): SequenceV2 {
  const audioIds = new Set(seq.audioLanes.flatMap((l) => l.clips.map((c) => c.id)));
  const videoIds = new Set(seq.video.filter((x) => x.kind === "clip").map((x) => x.id));
  const video = mapShared(seq.video, (it) => {
    if (it.kind !== "clip" || it.audio.detachedTo === undefined) return it;
    const to = renamed?.get(it.audio.detachedTo) ?? it.audio.detachedTo;
    if (to === it.audio.detachedTo && audioIds.has(to)) return it;
    if (audioIds.has(to)) return { ...it, audio: { ...it.audio, detachedTo: to } };
    const { detachedTo: _gone, ...audio } = it.audio;
    return { ...it, audio };
  });
  const audioLanes = mapShared(seq.audioLanes, (l) => {
    const clips = mapShared(l.clips, (c) => {
      if (c.detachedFrom === undefined) return c;
      const from = renamed?.get(c.detachedFrom) ?? c.detachedFrom;
      if (from === c.detachedFrom && videoIds.has(from)) return c;
      if (videoIds.has(from)) return { ...c, detachedFrom: from };
      const { detachedFrom: _gone, ...rest } = c;
      return rest;
    });
    return clips === l.clips ? l : { ...l, clips };
  });
  return video === seq.video && audioLanes === seq.audioLanes ? seq : { ...seq, video, audioLanes };
}

/** 片段放在 [start, start+length) 會不會跟 clips（依 start 排序）重疊；ignoreId 是正在移動的片段自己。 */
export function fitsAt(clips: readonly AudioClipV2[], start: number, length: number, ignoreId?: string): boolean {
  const end = start + length;
  return clips.every((c) => c.id === ignoreId || c.start + c.length <= start || c.start >= end);
}

/** 最近放得下的起點（≥ 0）：候選是原位置、每個片段的尾端、每個片段開頭往前 length。一定有解（最後一個片段之後永遠放得下）。 */
export function nearestFreeStart(clips: readonly AudioClipV2[], length: number, start: number, ignoreId?: string): number {
  const others = clips.filter((c) => c.id !== ignoreId);
  const cands = [Math.max(0, start), ...others.map((c) => c.start + c.length), ...others.map((c) => c.start - length).filter((s) => s >= 0)];
  let best = Number.POSITIVE_INFINITY;
  for (const s of cands) if (fitsAt(others, s, length) && Math.abs(s - start) < Math.abs(best - start)) best = s;
  return best;
}

export function sameSourceRef(a: AudioSourceRefV2, b: AudioSourceRefV2): boolean {
  return a.type === "media" ? b.type === "media" && a.mediaId === b.mediaId : b.type === "audio" && a.audioId === b.audioId;
}

/** 依 start 插入並保持排序（同 start 放在後面）。 */
export function insertSorted(clips: readonly AudioClipV2[], c: AudioClipV2): AudioClipV2[] {
  const i = clips.findIndex((x) => x.start > c.start);
  return i < 0 ? [...clips, c] : [...clips.slice(0, i), c, ...clips.slice(i)];
}
