// 序列層的收尾積木：V1 結構變動後的原音收斂、空白合併、同步鎖軌的波紋。ops.ts 與 trim.ts 共用。
import type { AudioLaneV2, ProjectMediaV2, SequenceV2, VideoItemV2 } from "../project/format";
import { mediaInfoOf, type SeqCtx, type SeqMediaInfo } from "./context";
import { fitGain } from "./envelope";
import { mapShared, removeSampleRange, repairDetachRefs } from "./laneEdit";
import { durationFrames, placedSampleLength, placeVideo, samplesOfFrame } from "./map";

export function infoOf(m: ProjectMediaV2 | SeqMediaInfo): SeqMediaInfo {
  return "fingerprint" in m ? mediaInfoOf(m) : m;
}

/**
 * V1 結構變動之後（波紋、插入、修剪），片段在序列上的樣本長度 S(t1) − S(t0) 在 29.97 fps 時可能差 ±1：
 * 把原音的淡化與自動化點收進新長度，validateSequence 才會過。沒超出的片段原封不動。
 */
export function fitV1Audio(seq: SequenceV2): SequenceV2 {
  const placed = placeVideo(seq);
  const video = mapShared(seq.video, (it, i) => {
    if (it.kind !== "clip") return it;
    const audio = fitGain(it.audio, placedSampleLength(placed[i], seq.fps));
    return audio === it.audio ? it : { ...it, audio };
  });
  return video === seq.video ? seq : { ...seq, video };
}

/** 相鄰的空白併成一個（保留第一個的 id）：刪掉兩個空白中間的片段後，時間軸上不該出現兩塊接在一起的空白。 */
export function mergeAdjacentGaps(video: readonly VideoItemV2[]): VideoItemV2[] {
  const out: VideoItemV2[] = [];
  let changed = false;
  for (const it of video) {
    const last = out[out.length - 1];
    if (it.kind === "gap" && last?.kind === "gap") {
      out[out.length - 1] = { ...last, length: last.length + it.length };
      changed = true;
    } else out.push(it);
  }
  return changed ? out : (video as VideoItemV2[]);
}

/** 把新的 video / audioLanes 收尾：沒變回原序列；有變就修分離參照、收斂原音長度。 */
export function finish(seq: SequenceV2, video: VideoItemV2[], audioLanes: AudioLaneV2[], renamed?: ReadonlyMap<string, string>): SequenceV2 {
  if (video === seq.video && audioLanes === seq.audioLanes) return seq;
  return fitV1Audio(repairDetachRefs({ ...seq, video, audioLanes }, renamed));
}

/** 會跟著 V1 波紋移動的軌：未鎖定且同步鎖開。 */
export const ripples = (l: AudioLaneV2) => !l.locked && l.syncLock;

export function clampFrame(seq: SequenceV2, t: number): number {
  return Math.max(0, Math.min(durationFrames(seq), Math.round(t)));
}

/** 從未鎖定的軌刪掉指定 id 的音訊片段（音訊軌不磁吸，不補位）。 */
export function removeAudioClipsById(lanes: AudioLaneV2[], ids: ReadonlySet<string>, force = false): AudioLaneV2[] {
  return mapShared(lanes, (l) => {
    if (l.locked && !force) return l;
    const clips = l.clips.filter((c) => !ids.has(c.id));
    return clips.length === l.clips.length ? l : { ...l, clips };
  });
}

/** 同步鎖開的軌依序列幀範圍移除時間（從後面的範圍做起，前面範圍的樣本座標才不會被移動過）。 */
export function rippleLanes(seq: SequenceV2, lanes: AudioLaneV2[], ranges: readonly [number, number][], ctx: SeqCtx | undefined, taken: Set<string>): AudioLaneV2[] {
  let out = lanes;
  for (const [a, b] of [...ranges].reverse()) {
    const A = samplesOfFrame(a, seq.fps);
    const B = samplesOfFrame(b, seq.fps);
    out = mapShared(out, (l) => (ripples(l) ? removeSampleRange(l, A, B, ctx, taken) : l));
  }
  return out;
}
