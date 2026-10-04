// 序列剪輯純函式（docs/editor-m2-design.md §5）：輸入 SequenceV2、回傳新的 SequenceV2，結構共享。
//
// 約定：
// - **沒變就回傳同一個參照**（`next === seq`）：editSequence（M2.4）靠它不留空的 undo。
// - 拒絕執行（fps 不符、鎖定、重疊）擲 SequenceError，UI 依 code 顯示；夾得住的數值（修剪超出媒體範圍）一律夾住不擲錯。
// - 永遠不碰 tracks / shots / cardSlots：序列只是 t → (mediaId, k) 的對應表（I1、D13），這個模組根本沒有那些型別的入口。
// - 鎖定的音軌：動作跳過它（不刪、不切、不跟著波紋移）；syncLock 關的音軌不跟 V1 波紋（音樂預設關，§0.1 Q3）。
// - 音訊動作（分離、加入、移動、增益、閃避、音軌）在 audioOps.ts，這裡一併轉出。
import { DEFAULT_EDGE_DECLICK_MS, sameRational, SEQ_SAMPLE_RATE, defaultClipAudio, type AudioLaneV2, type GapV2, type MarkerV2, type ProjectMediaV2, type SequenceV2, type VideoClipV2, type VideoItemV2 } from "../project/format";
import type { SeqCtx, SeqMediaInfo } from "./context";
import { gainsJoinable, joinGain, splitGain } from "./envelope";
import { clipIdsOf, SequenceError, takeId } from "./ids";
import { insertSamples, mapShared, nativeRate, sameSourceRef, sliceAudioClip, srcAdvance } from "./laneEdit";
import { durationFrames, itemLength, placedAt, placedSampleLength, placeVideo, samplesOfFrame, type PlacedItem } from "./map";
import { clampFrame, finish, infoOf, mergeAdjacentGaps, removeAudioClipsById, rippleLanes, ripples } from "./seqEdit";

export * from "./audioOps";
export * from "./trim";
export { SequenceError, nextClipId, type SequenceErrorCode } from "./ids";

/** 序列幀範圍（不含 out）；形狀同 store/timeline 的 FrameRange，這裡不 import store。 */
export interface SeqFrameRange {
  in: number;
  out: number;
}

// ---------------------------------------------------------------- 實體化與剪輯點

/**
 * 隱含序列（null）→ 一個整段片段的實體序列（§5.1）。fps = proxy fps、尺寸 = 來源像素（probe.video）。
 * 所有剪輯入口先過 ensureSequence，實體化與動作在同一筆 commit，一次 Ctrl+Z 回到 null。
 */
export function materialize(media: ProjectMediaV2 | SeqMediaInfo, opts: { id?: string } = {}): SequenceV2 {
  const m = infoOf(media);
  if (m.frames == null || m.frames < 1 || !m.fps) throw new SequenceError("noProxy", `媒體 ${m.id} 還沒有 proxy（幀數未知），無法建立序列`, { mediaId: m.id });
  return {
    id: opts.id ?? "seq-1",
    name: m.name.replace(/\.[^.]+$/, ""),
    fps: { num: m.fps.num, den: m.fps.den },
    width: m.width ?? 0,
    height: m.height ?? 0,
    sampleRate: SEQ_SAMPLE_RATE,
    video: [{ kind: "clip", id: "clip-1", mediaId: m.id, srcIn: 0, srcOut: m.frames, enabled: true, audio: defaultClipAudio() }],
    original: { muted: false, gainDb: 0 },
    audioLanes: [],
    audio: { edgeDeclickMs: DEFAULT_EDGE_DECLICK_MS, limiter: false },
  };
}

export function ensureSequence(seq: SequenceV2 | null, media: ProjectMediaV2 | SeqMediaInfo | null | undefined): SequenceV2 {
  if (seq) return seq;
  if (!media) throw new SequenceError("notFound", "沒有作用中的媒體，無法建立序列");
  return materialize(media);
}

/** 剪輯點（序列幀，排序不重複）：0、每個 V1 項目的邊界、T。上／下一個剪輯點與插入吸附用。 */
export function editPoints(seq: SequenceV2): number[] {
  const out = [0];
  for (const p of placeVideo(seq)) if (p.t1 !== out[out.length - 1]) out.push(p.t1);
  return out;
}

/** 吸到最近的剪輯點（等距取前面那個）。 */
export function snapToEditPoint(seq: SequenceV2, t: number): number {
  let best = 0;
  for (const e of editPoints(seq)) if (Math.abs(e - t) < Math.abs(best - t)) best = e;
  return best;
}

// ---------------------------------------------------------------- 分割 / 合併切點

/** "v1" = 只切 V1（B）；"all" = V1 與所有未鎖定的音軌（Ctrl+Shift+\）；id 陣列 = 只切選取的片段。 */
export type SplitTarget = "v1" | "all" | readonly string[];

const pickV1 = (target: SplitTarget, id: string) => (typeof target === "string" ? true : target.includes(id));
const pickLane = (target: SplitTarget, lane: AudioLaneV2, id: string) => !lane.locked && (typeof target === "string" ? target === "all" : target.includes(id));

/** V1 片段在序列幀 t（t0 < t < t1）切成兩段；原音的淡化與曲線各自切開，右段拿新 id。 */
function splitVideoClip(p: PlacedItem, t: number, seq: SequenceV2, newId: string): [VideoClipV2, VideoClipV2] {
  const c = p.item as VideoClipV2;
  const k = c.srcIn + (t - p.t0);
  const st = samplesOfFrame(t, seq.fps);
  const [al, ar] = splitGain(c.audio, st - samplesOfFrame(p.t0, seq.fps), samplesOfFrame(p.t1, seq.fps) - st);
  return [
    { ...c, srcOut: k, audio: al },
    { ...c, id: newId, srcIn: k, audio: ar },
  ];
}

/** V1 在 t 切開（片段或空白）；t 不在任何項目內部時原陣列回傳。 */
function splitV1ItemAt(seq: SequenceV2, t: number, taken: Set<string>, pick: (id: string) => boolean = () => true): VideoItemV2[] {
  const p = placedAt(placeVideo(seq), t);
  if (!p || t <= p.t0 || !pick(p.item.id)) return seq.video;
  let parts: VideoItemV2[];
  if (p.item.kind === "clip") parts = splitVideoClip(p, t, seq, takeId(taken, "clip"));
  else {
    const gap: GapV2 = p.item;
    parts = [
      { ...gap, length: t - p.t0 },
      { ...gap, id: takeId(taken, "gap"), length: p.t1 - t },
    ];
  }
  return [...seq.video.slice(0, p.index), ...parts, ...seq.video.slice(p.index + 1)];
}

function splitLaneAt(lane: AudioLaneV2, s: number, ctx: SeqCtx | undefined, taken: Set<string>, pick: (id: string) => boolean): AudioLaneV2 {
  const i = lane.clips.findIndex((c) => c.start < s && s < c.start + c.length && pick(c.id));
  if (i < 0) return lane;
  const c = lane.clips[i];
  const sr = nativeRate(ctx, c);
  const left = sliceAudioClip(c, 0, s - c.start, sr, { start: c.start });
  const right = sliceAudioClip(c, s - c.start, c.length, sr, { id: takeId(taken, "aclip"), start: s });
  return { ...lane, clips: [...lane.clips.slice(0, i), left, right, ...lane.clips.slice(i + 1)] };
}

/**
 * 在播放線（序列幀 t）分割（ai-music-cut / Resolve 的 B）。V1 只切片段（空白切開沒有意義）；
 * 音訊片段在 S(t) 樣本切開。t 剛好在切點上什麼都不做（那是 joinThroughEdit 的工作）。
 */
export function splitAt(seq: SequenceV2, t: number, ctx?: SeqCtx, target: SplitTarget = "v1"): SequenceV2 {
  const taken = clipIdsOf(seq);
  const p = placedAt(placeVideo(seq), t);
  const video = p?.item.kind === "clip" ? splitV1ItemAt(seq, t, taken, (id) => pickV1(target, id)) : seq.video;
  const s = samplesOfFrame(t, seq.fps);
  const audioLanes = mapShared(seq.audioLanes, (l) => splitLaneAt(l, s, ctx, taken, (id) => pickLane(target, l, id)));
  return finish(seq, video, audioLanes);
}

/** 音訊軌上的樣本級分割（Alt + 刀片）：只動音軌，V1 不切。target 同 splitAt（"v1" 在這裡等於不切任何東西）。 */
export function splitAudioAt(seq: SequenceV2, sample: number, ctx?: SeqCtx, target: SplitTarget = "all"): SequenceV2 {
  const taken = clipIdsOf(seq);
  const audioLanes = mapShared(seq.audioLanes, (l) => splitLaneAt(l, Math.round(sample), ctx, taken, (id) => pickLane(target, l, id)));
  return finish(seq, seq.video, audioLanes);
}

function videoJoinable(a: VideoClipV2, b: VideoClipV2): boolean {
  return a.mediaId === b.mediaId && a.srcOut === b.srcIn && a.enabled === b.enabled && a.label === b.label && a.audio.enabled === b.audio.enabled && a.audio.detachedTo === b.audio.detachedTo && gainsJoinable(a.audio, b.audio);
}

function joinLaneAt(lane: AudioLaneV2, s: number, ctx: SeqCtx | undefined, pick: (id: string) => boolean, renamed: Map<string, string>): AudioLaneV2 {
  const i = lane.clips.findIndex((c, j) => c.start + c.length === s && lane.clips[j + 1]?.start === s);
  if (i < 0) return lane;
  const a = lane.clips[i];
  const b = lane.clips[i + 1];
  if (!pick(a.id) && !pick(b.id)) return lane;
  const contiguous = b.srcIn === a.srcIn + srcAdvance(a.length, nativeRate(ctx, a));
  if (!sameSourceRef(a.source, b.source) || !contiguous || a.enabled !== b.enabled || a.label !== b.label || a.detachedFrom !== b.detachedFrom || !gainsJoinable(a, b)) return lane;
  const merged = joinGain({ ...a, length: a.length + b.length }, a.length, b, b.length);
  renamed.set(b.id, a.id);
  return { ...lane, clips: [...lane.clips.slice(0, i), merged, ...lane.clips.slice(i + 2)] };
}

/**
 * 播放線剛好在「同一媒體、來源連續（左 srcOut == 右 srcIn）、其他參數一致」的切點上 → 合併
 * （ai-music-cut「再按一次 B 移除切點」）。曲線接回去時切點補的內插點會消失，所以「切一刀再合併」比值會回到原樣。
 */
export function joinThroughEdit(seq: SequenceV2, t: number, ctx?: SeqCtx, target: SplitTarget = "v1"): SequenceV2 {
  const placed = placeVideo(seq);
  const renamed = new Map<string, string>();
  let video = seq.video;
  const i = placed.findIndex((p) => p.t1 === t);
  const a = placed[i]?.item;
  const b = placed[i + 1]?.item;
  if (a?.kind === "clip" && b?.kind === "clip" && (pickV1(target, a.id) || pickV1(target, b.id)) && videoJoinable(a, b)) {
    const merged: VideoClipV2 = { ...a, srcOut: b.srcOut, audio: joinGain(a.audio, placedSampleLength(placed[i], seq.fps), b.audio, placedSampleLength(placed[i + 1], seq.fps)) };
    video = [...seq.video.slice(0, i), merged, ...seq.video.slice(i + 2)];
    renamed.set(b.id, a.id);
  }
  const s = samplesOfFrame(t, seq.fps);
  const audioLanes = mapShared(seq.audioLanes, (l) => (l.locked ? l : joinLaneAt(l, s, ctx, (id) => pickLane(target, l, id), renamed)));
  return finish(seq, video, audioLanes, renamed);
}

/** B 的啟用條件之一：這個位置可以合併切點。 */
export function canJoinAt(seq: SequenceV2, t: number, ctx?: SeqCtx, target: SplitTarget = "v1"): boolean {
  return joinThroughEdit(seq, t, ctx, target) !== seq;
}

// ---------------------------------------------------------------- 刪除

/** 被刪掉的 V1 項目在序列上佔的幀範圍（相鄰的併成一段），依位置排序。 */
function removedRanges(seq: SequenceV2, ids: ReadonlySet<string>): [number, number][] {
  const out: [number, number][] = [];
  for (const p of placeVideo(seq)) {
    if (!ids.has(p.item.id)) continue;
    const last = out[out.length - 1];
    if (last && last[1] === p.t0) last[1] = p.t1;
    else out.push([p.t0, p.t1]);
  }
  return out;
}

/**
 * 波紋刪除（Delete；ai-music-cut / FCP / CapCut）：V1 項目移除、後面往前補；音訊片段直接移除（不補位）。
 * 同步鎖開的軌移除 V1 被刪掉的那段時間（跨邊界的切開、接回）；音樂軌預設同步鎖關，整條停在原地。
 */
export function rippleDelete(seq: SequenceV2, ids: readonly string[], ctx?: SeqCtx): SequenceV2 {
  const idSet = new Set(ids);
  const ranges = removedRanges(seq, idSet);
  const taken = clipIdsOf(seq);
  const video = ranges.length ? mergeAdjacentGaps(seq.video.filter((it) => !idSet.has(it.id))) : seq.video;
  const lanes = rippleLanes(seq, removeAudioClipsById(seq.audioLanes, idSet), ranges, ctx, taken);
  return finish(seq, video, lanes);
}

/** 刪除留空隙（Shift+Delete）：V1 片段換成同長度的空白（相鄰空白合併）；音訊片段直接移除；不波紋。 */
export function lift(seq: SequenceV2, ids: readonly string[]): SequenceV2 {
  const idSet = new Set(ids);
  const taken = clipIdsOf(seq);
  const replaced = mapShared(seq.video, (it): VideoItemV2 => (it.kind === "clip" && idSet.has(it.id) ? { kind: "gap", id: takeId(taken, "gap"), length: itemLength(it) } : it));
  const video = replaced === seq.video ? seq.video : mergeAdjacentGaps(replaced);
  return finish(seq, video, removeAudioClipsById(seq.audioLanes, idSet));
}

/** 範圍兩端切開 V1 後，完全在 [a, b) 內的項目 id。 */
function v1CutRange(seq: SequenceV2, a: number, b: number, taken: Set<string>): { video: VideoItemV2[]; inside: Set<string> } {
  const s1 = { ...seq, video: splitV1ItemAt(seq, a, taken) };
  const video = splitV1ItemAt(s1, b, taken);
  const inside = new Set(
    placeVideo({ video })
      .filter((p) => p.t0 >= a && p.t1 <= b)
      .map((p) => p.item.id),
  );
  return { video, inside };
}

/**
 * 提取範圍（Premiere Extract `'`；範圍為焦點時的 Delete）：在 in、out 切開 V1，刪中間、後面往前補；
 * 同步鎖開的軌移除同一段時間（同 rippleDelete）。範圍夾在 [0, T]，空範圍不動。
 */
export function extractRange(seq: SequenceV2, range: SeqFrameRange, ctx?: SeqCtx): SequenceV2 {
  const a = clampFrame(seq, range.in);
  const b = clampFrame(seq, range.out);
  if (b <= a) return seq;
  const taken = clipIdsOf(seq);
  const { video, inside } = v1CutRange(seq, a, b, taken);
  return finish(seq, mergeAdjacentGaps(video.filter((it) => !inside.has(it.id))), rippleLanes(seq, seq.audioLanes, [[a, b]], ctx, taken));
}

/**
 * 移除範圍留空隙（Premiere Lift `;`；範圍為焦點時的 Shift+Delete）：V1 中間換成一塊空白。
 * 音軌不動 —— 跟 lift 一樣不波紋，旁白 / 音樂留在原位（要連聲音一起清就用 muteRange）。
 */
export function liftRange(seq: SequenceV2, range: SeqFrameRange): SequenceV2 {
  const a = clampFrame(seq, range.in);
  const b = clampFrame(seq, range.out);
  if (b <= a) return seq;
  const taken = clipIdsOf(seq);
  const { video, inside } = v1CutRange(seq, a, b, taken);
  if ([...inside].every((id) => video.find((it) => it.id === id)?.kind === "gap")) return seq;
  const first = video.findIndex((it) => inside.has(it.id));
  const kept = video.filter((it) => !inside.has(it.id));
  const next = [...kept.slice(0, first), { kind: "gap", id: takeId(taken, "gap"), length: b - a } as GapV2, ...kept.slice(first)];
  return finish(seq, mergeAdjacentGaps(next), seq.audioLanes);
}

// ---------------------------------------------------------------- 停用

/** 停用 / 啟用（D）：V1 停用 = 黑畫面＋靜音、仍佔時間；音訊片段停用 = 靜音。鎖定軌上的片段跳過。 */
export function setEnabled(seq: SequenceV2, ids: readonly string[], enabled: boolean): SequenceV2 {
  const idSet = new Set(ids);
  const video = mapShared(seq.video, (it) => (it.kind === "clip" && idSet.has(it.id) && it.enabled !== enabled ? { ...it, enabled } : it));
  const audioLanes = mapShared(seq.audioLanes, (l) => {
    if (l.locked) return l;
    const clips = mapShared(l.clips, (c) => (idSet.has(c.id) && c.enabled !== enabled ? { ...c, enabled } : c));
    return clips === l.clips ? l : { ...l, clips };
  });
  return finish(seq, video, audioLanes);
}

// ---------------------------------------------------------------- 加入 / 移除媒體

/** 媒體能不能放進這條序列：要有 proxy、fps 與尺寸相同（M2 不做 conform）。不行就擲 SequenceError。 */
export function assertMediaFits(seq: SequenceV2, media: ProjectMediaV2 | SeqMediaInfo): SeqMediaInfo & { frames: number } {
  const m = infoOf(media);
  if (m.frames == null || m.frames < 1 || !m.fps) throw new SequenceError("noProxy", `媒體 ${m.id} 還沒有 proxy（幀數未知）`, { mediaId: m.id });
  if (!sameRational(m.fps, seq.fps)) throw new SequenceError("fpsMismatch", `請以 ${seq.fps.num}/${seq.fps.den} fps 重建 ${m.name} 的 proxy`, { mediaId: m.id, expected: seq.fps, actual: m.fps });
  if (seq.width && m.width != null && m.height != null && (m.width !== seq.width || m.height !== seq.height)) {
    throw new SequenceError("sizeMismatch", `${m.name} 的尺寸 ${m.width}×${m.height} 跟序列 ${seq.width}×${seq.height} 不同`, { mediaId: m.id, expected: [seq.width, seq.height], actual: [m.width, m.height] });
  }
  return m as SeqMediaInfo & { frames: number };
}

/** 把整支媒體接到序列結尾（FCP Append）。 */
export function appendMedia(seq: SequenceV2, media: ProjectMediaV2 | SeqMediaInfo): SequenceV2 {
  const m = assertMediaFits(seq, media);
  const clip: VideoClipV2 = { kind: "clip", id: takeId(clipIdsOf(seq), "clip"), mediaId: m.id, srcIn: 0, srcOut: m.frames, enabled: true, audio: defaultClipAudio() };
  return finish(seq, [...seq.video, clip], seq.audioLanes);
}

/** 在 t（吸到最近的剪輯點）插入整支媒體（FCP Insert）：後面往後推，同步鎖軌在插入點插入同樣長的時間。 */
export function insertMedia(seq: SequenceV2, media: ProjectMediaV2 | SeqMediaInfo, t: number, ctx?: SeqCtx): SequenceV2 {
  const m = assertMediaFits(seq, media);
  const P = snapToEditPoint(seq, t);
  const i = placeVideo(seq).findIndex((p) => p.t0 === P);
  if (i < 0) return appendMedia(seq, m);
  const taken = clipIdsOf(seq);
  const clip: VideoClipV2 = { kind: "clip", id: takeId(taken, "clip"), mediaId: m.id, srcIn: 0, srcOut: m.frames, enabled: true, audio: defaultClipAudio() };
  const video = [...seq.video.slice(0, i), clip, ...seq.video.slice(i)];
  const A = samplesOfFrame(P, seq.fps);
  const D = samplesOfFrame(P + m.frames, seq.fps) - A;
  return finish(seq, video, mapShared(seq.audioLanes, (l) => (ripples(l) ? insertSamples(l, A, D, ctx, taken) : l)));
}

/**
 * 在 t（吸到最近的剪輯點）插入一段空白（FCP 的 Insert Gap，⌥W）：後面往後推，同步鎖軌插入同樣長的時間。
 * 跟 insertMedia 走同一條路，只是插進去的是 gap 而不是 clip；落在序列尾端就接在最後面。
 */
export function insertGap(seq: SequenceV2, t: number, frames: number, ctx?: SeqCtx): SequenceV2 {
  const n = Math.max(1, Math.round(frames));
  const P = snapToEditPoint(seq, t);
  const taken = clipIdsOf(seq);
  const g: GapV2 = { kind: "gap", id: takeId(taken, "gap"), length: n };
  const i = placeVideo(seq).findIndex((p) => p.t0 === P);
  const video = mergeAdjacentGaps(i < 0 ? [...seq.video, g] : [...seq.video.slice(0, i), g, ...seq.video.slice(i)]);
  const A = samplesOfFrame(P, seq.fps);
  const D = samplesOfFrame(P + n, seq.fps) - A;
  return finish(seq, video, mapShared(seq.audioLanes, (l) => (ripples(l) ? insertSamples(l, A, D, ctx, taken) : l)));
}

/**
 * 覆蓋（Avid / Premiere 的 overwrite，`.`）：把整支媒體蓋在播放線上，蓋掉的長度就是媒體長度。
 *
 * 跟 insert 的本質差別是**不推開後面的東西** —— 序列總長只有在蓋過尾端時才變長，
 * 所以音訊軌完全不動（insert 要讓同步鎖軌一起讓出時間，這裡不用）。
 * 播放線停在序列尾端之外：先補一段空白把時間軸拉過去，再把媒體接上。
 */
export function overwriteMedia(seq: SequenceV2, media: ProjectMediaV2 | SeqMediaInfo, t: number): SequenceV2 {
  const m = assertMediaFits(seq, media);
  const a = Math.max(0, Math.round(t));
  const taken = clipIdsOf(seq);
  const clip: VideoClipV2 = { kind: "clip", id: takeId(taken, "clip"), mediaId: m.id, srcIn: 0, srcOut: m.frames, enabled: true, audio: defaultClipAudio() };
  const dur = durationFrames(seq);
  if (a >= dur) {
    const pad: VideoItemV2[] = a > dur ? [{ kind: "gap", id: takeId(taken, "gap"), length: a - dur }] : [];
    return finish(seq, mergeAdjacentGaps([...seq.video, ...pad, clip]), seq.audioLanes);
  }
  const { video, inside } = v1CutRange(seq, a, Math.min(a + m.frames, dur), taken);
  const first = video.findIndex((it) => inside.has(it.id));
  const kept = video.filter((it) => !inside.has(it.id));
  const at = first < 0 ? kept.length : first;
  return finish(seq, mergeAdjacentGaps([...kept.slice(0, at), clip, ...kept.slice(at)]), seq.audioLanes);
}

/**
 * 片段的自訂名稱（Premiere / Resolve 的 rename clip）。
 *
 * 時間軸本來就會優先顯示它（drawSequence 的 `clip.label || 媒體名`）、sanitize 也一直保留著，
 * 只是從來沒有地方可以設。空字串 = 清掉，連鍵一起拿掉——不寫空值進專案檔。
 * 鎖定的音軌跳過。
 */
export function setClipLabel(seq: SequenceV2, ids: readonly string[], label: string): SequenceV2 {
  const want = label.trim();
  const idSet = new Set(ids);
  const put = <T extends { label?: string }>(x: T): T => {
    if (want) return x.label === want ? x : { ...x, label: want };
    if (x.label === undefined) return x;
    const { label: _drop, ...rest } = x;
    return rest as T;
  };
  const video = mapShared(seq.video, (it) => (it.kind === "clip" && idSet.has(it.id) ? put(it) : it));
  const audioLanes = mapShared(seq.audioLanes, (l) => {
    if (l.locked) return l;
    const clips = mapShared(l.clips, (c) => (idSet.has(c.id) ? put(c) : c));
    return clips === l.clips ? l : { ...l, clips };
  });
  return video === seq.video && audioLanes === seq.audioLanes ? seq : { ...seq, video, audioLanes };
}

/**
 * 把 V1 上的一個項目跟相鄰的那個對調（重新排序的最小單位；拖曳重排的地基）。
 *
 * 相鄰對調是**局部**操作：兩者長度之和不變，所以序列總長不變，**後面的項目位置完全不動**。
 * 音訊軌也不動 —— 使用者是在既有的聲音底下重排畫面（B-roll 換順序），
 * 讓旁白跟著跳反而是意外行為。要連聲音一起搬是「移動片段」不是「重新排序」，那是另一件事。
 *
 * 跟空白對調 = 把片段往前 / 後挪一整段空白，這是有用的副作用，刻意不擋。
 * 已經在頭 / 尾就回同一個參照。
 */
export function moveItemBy(seq: SequenceV2, id: string, delta: -1 | 1): SequenceV2 {
  const i = seq.video.findIndex((it) => it.id === id);
  return i < 0 ? seq : moveItemTo(seq, id, i + delta);
}

/**
 * 把 V1 上的一個項目搬到第 `toIndex` 格（拖曳重排用；相鄰對調是它的特例）。
 *
 * `toIndex` 是**搬移後**的目標索引，夾在 [0, 長度−1]。抽掉再插入，所以序列總長不變、
 * 音訊軌不動（理由同 moveItemBy）；夾住之後等於原位就回同一個參照。
 */
export function moveItemTo(seq: SequenceV2, id: string, toIndex: number): SequenceV2 {
  const i = seq.video.findIndex((it) => it.id === id);
  if (i < 0) return seq;
  const j = Math.max(0, Math.min(seq.video.length - 1, Math.round(toIndex)));
  if (j === i) return seq;
  const video = [...seq.video];
  const [item] = video.splice(i, 1);
  video.splice(j, 0, item);
  return finish(seq, mergeAdjacentGaps(video), seq.audioLanes);
}

// ---------------------------------------------------------------- 標記

const markersOf = (seq: SequenceV2): readonly MarkerV2[] => seq.markers ?? [];

/**
 * 在 t 加一個標記（夾在序列範圍內）。同一幀已經有標記就不加 —— 連按兩次不該長出兩個疊在一起的記號。
 * 標記依 t 排序存放（navigation 與繪製都靠這個順序）。
 */
export function addMarker(seq: SequenceV2, t: number, name = ""): SequenceV2 {
  const at = clampFrame(seq, Math.round(t));
  const cur = markersOf(seq);
  if (cur.some((m) => m.t === at)) return seq;
  const taken = new Set(cur.map((m) => m.id));
  let n = cur.length + 1;
  while (taken.has(`mk-${n}`)) n++;
  return { ...seq, markers: [...cur, { id: `mk-${n}`, t: at, name }].sort((x, y) => x.t - y.t) };
}

/** 刪掉一個標記；刪到一個都不剩時連鍵一起拿掉（空陣列不該寫進專案檔）。 */
export function removeMarker(seq: SequenceV2, id: string): SequenceV2 {
  const cur = markersOf(seq);
  const next = cur.filter((m) => m.id !== id);
  if (next.length === cur.length) return seq;
  if (!next.length) {
    const { markers: _drop, ...rest } = seq;
    return rest as SequenceV2;
  }
  return { ...seq, markers: next };
}

/** 改標記的字。 */
export function renameMarker(seq: SequenceV2, id: string, name: string): SequenceV2 {
  const cur = markersOf(seq);
  const hit = cur.find((m) => m.id === id);
  if (!hit || hit.name === name) return seq;
  return { ...seq, markers: cur.map((m) => (m.id === id ? { ...m, name } : m)) };
}

/** t 前 / 後最近的標記（dir −1 = 往前）；停在標記上時往同方向跳到下一個，不會原地不動。 */
export function markerNear(seq: SequenceV2, t: number, dir: -1 | 1): MarkerV2 | null {
  const ms = markersOf(seq);
  if (dir > 0) return ms.find((m) => m.t > t) ?? null;
  for (let i = ms.length - 1; i >= 0; i--) if (ms[i].t < t) return ms[i];
  return null;
}

/** 正好落在 t 上的標記。 */
export function markerAt(seq: SequenceV2, t: number): MarkerV2 | null {
  return markersOf(seq).find((m) => m.t === t) ?? null;
}

// ---------------------------------------------------------------- 複製 / 滑移

/**
 * 複製片段（Premiere / Resolve 的 Duplicate）：複本緊接在原片段後面，後面的往後推，
 * 同步鎖軌插入同樣長的時間 —— 跟 insertMedia 同一條路，只是插進去的是同一段來源。
 */
export function duplicateClip(seq: SequenceV2, clipId: string, ctx?: SeqCtx): SequenceV2 {
  const p = placeVideo(seq).find((x) => x.item.kind === "clip" && x.item.id === clipId);
  if (!p || p.item.kind !== "clip") return seq;
  const taken = clipIdsOf(seq);
  const copy: VideoClipV2 = { ...p.item, id: takeId(taken, "clip") };
  const video = [...seq.video.slice(0, p.index + 1), copy, ...seq.video.slice(p.index + 1)];
  const A = samplesOfFrame(p.t1, seq.fps);
  const D = samplesOfFrame(p.t1 + itemLength(p.item), seq.fps) - A;
  return finish(seq, video, mapShared(seq.audioLanes, (l) => (ripples(l) ? insertSamples(l, A, D, ctx, taken) : l)));
}

/** 尾端還能往後長幾幀（gap 無限；clip 受媒體長度限制，不知道媒體長度就當 0，寧可不動也不要超出來源）。 */
function growTail(it: VideoItemV2, ctx?: SeqCtx): number {
  if (it.kind === "gap") return Number.POSITIVE_INFINITY;
  const n = ctx?.media(it.mediaId)?.frames;
  return typeof n === "number" ? Math.max(0, n - it.srcOut) : 0;
}

/** 開頭還能往前長幾幀（clip 就是它前面還剩多少來源）。 */
function growHead(it: VideoItemV2): number {
  return it.kind === "gap" ? Number.POSITIVE_INFINITY : it.srcIn;
}

/** 還能被砍掉幾幀（gap 可以歸零消失；clip 至少留 1 幀）。 */
function shrinkable(it: VideoItemV2): number {
  return it.kind === "gap" ? it.length : Math.max(0, it.srcOut - it.srcIn - 1);
}

/** 片段左右各還能滑移幾幀（兩邊都要有鄰居才滑得動 —— 沒有鄰居可吸收的位移就是波紋，不是滑移）。 */
export function slideCapacity(seq: SequenceV2, clipId: string, ctx?: SeqCtx): { left: number; right: number } {
  const i = seq.video.findIndex((it) => it.kind === "clip" && it.id === clipId);
  const prev = i > 0 ? seq.video[i - 1] : undefined;
  const next = i >= 0 ? seq.video[i + 1] : undefined;
  if (!prev || !next) return { left: 0, right: 0 };
  const fin = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
  return { left: fin(Math.min(shrinkable(prev), growHead(next))), right: fin(Math.min(growTail(prev, ctx), shrinkable(next))) };
}

/** 尾端移動 n 幀（正 = 變長）。 */
function shiftTail(it: VideoItemV2, n: number): VideoItemV2 {
  return it.kind === "gap" ? { ...it, length: it.length + n } : { ...it, srcOut: it.srcOut + n };
}

/** 開頭移動 n 幀（正 = 從前面讓出 n 幀，自己變短）。 */
function shiftHead(it: VideoItemV2, n: number): VideoItemV2 {
  return it.kind === "gap" ? { ...it, length: it.length - n } : { ...it, srcIn: it.srcIn + n };
}

/** 複製到剪貼簿的片段：不帶 id（貼上時重新發），其餘照抄。 */
export type ClipSeed = Pick<VideoClipV2, "mediaId" | "srcIn" | "srcOut" | "enabled" | "audio">;

/** 選取的 V1 片段依時間順序抄成 ClipSeed（空白不抄 —— 貼上一塊「沒有內容」沒有意義）。 */
export function copyClips(seq: SequenceV2, ids: readonly string[]): ClipSeed[] {
  const want = new Set(ids);
  const out: ClipSeed[] = [];
  for (const it of seq.video) {
    if (it.kind === "clip" && want.has(it.id)) out.push({ mediaId: it.mediaId, srcIn: it.srcIn, srcOut: it.srcOut, enabled: it.enabled, audio: it.audio });
  }
  return out;
}

/**
 * 貼上（Ctrl+V）：把剪貼簿的片段插在 t（吸到最近的剪輯點），後面往後推、
 * 同步鎖軌讓出同樣長的時間 —— 跟 insertGap / insertMedia 同一條波紋路徑。
 * 落在序列尾端就接在最後面。
 */
export function pasteClips(seq: SequenceV2, seeds: readonly ClipSeed[], t: number, ctx?: SeqCtx): SequenceV2 {
  if (!seeds.length) return seq;
  const taken = clipIdsOf(seq);
  const made: VideoClipV2[] = seeds.map((c) => ({ kind: "clip", id: takeId(taken, "clip"), mediaId: c.mediaId, srcIn: c.srcIn, srcOut: c.srcOut, enabled: c.enabled, audio: c.audio }));
  const n = made.reduce((a, c) => a + (c.srcOut - c.srcIn), 0);
  const P = snapToEditPoint(seq, t);
  const i = placeVideo(seq).findIndex((x) => x.t0 === P);
  const video = mergeAdjacentGaps(i < 0 ? [...seq.video, ...made] : [...seq.video.slice(0, i), ...made, ...seq.video.slice(i)]);
  const A = samplesOfFrame(P, seq.fps);
  const D = samplesOfFrame(P + n, seq.fps) - A;
  return finish(seq, video, mapShared(seq.audioLanes, (l) => (ripples(l) ? insertSamples(l, A, D, ctx, taken) : l)));
}

/** 片段的來源區間還能往前 / 後滑幾幀（前面剩多少來源、後面剩多少來源）。 */
export function slipCapacity(seq: SequenceV2, clipId: string, ctx?: SeqCtx): { left: number; right: number } {
  const c = seq.video.find((it) => it.kind === "clip" && it.id === clipId);
  if (!c || c.kind !== "clip") return { left: 0, right: 0 };
  const frames = ctx?.media(c.mediaId)?.frames;
  return { left: Math.max(0, c.srcIn), right: typeof frames === "number" ? Math.max(0, frames - c.srcOut) : 0 };
}

/**
 * 滑內容（NLE 的 Slip）：片段在時間軸上的**位置與長度都不變**，只換它顯示的來源區間。
 *
 * 跟 slideClip 正好相反 —— slide 動位置、不動內容；slip 動內容、不動位置。
 * 鄰居完全不受影響，序列結構與音訊軌都不動；超出來源範圍的部分夾住（不擲錯）。
 */
export function slipClip(seq: SequenceV2, clipId: string, delta: number, ctx?: SeqCtx): SequenceV2 {
  const d = Math.round(delta);
  const i = seq.video.findIndex((it) => it.kind === "clip" && it.id === clipId);
  const c = i >= 0 ? seq.video[i] : undefined;
  if (!d || !c || c.kind !== "clip") return seq;
  const cap = slipCapacity(seq, clipId, ctx);
  const n = d > 0 ? Math.min(d, cap.right) : -Math.min(-d, cap.left);
  if (!n) return seq;
  const video = [...seq.video];
  video[i] = { ...c, srcIn: c.srcIn + n, srcOut: c.srcOut + n };
  return finish(seq, video, seq.audioLanes);
}

/** 剪接點（第 i 與第 i+1 項之間）左右各能 roll 幾幀。 */
export function rollCapacity(seq: SequenceV2, t: number, ctx?: SeqCtx): { left: number; right: number } {
  const i = placeVideo(seq).findIndex((x) => x.t1 === t);
  const A = i >= 0 ? seq.video[i] : undefined;
  const B = i >= 0 ? seq.video[i + 1] : undefined;
  if (!A || !B) return { left: 0, right: 0 };
  const fin = (n: number) => (Number.isFinite(n) ? Math.max(0, n) : 0);
  return { left: fin(Math.min(shrinkable(A), growHead(B))), right: fin(Math.min(growTail(A, ctx), shrinkable(B))) };
}

/**
 * 移動剪接點（Premiere 的 Extend Edit、NLE 的 roll）：兩側一個讓出、一個吸收，
 * **序列總長不變、音訊軌不動** —— 跟 rippleTrim 的差別就在這裡（那個會把後面整串搬走）。
 *
 * 與 slideClip 共用 shiftTail / shiftHead，但**不是同一件事**：roll 改的是兩側片段的來源範圍，
 * slide 跳過片段本身、只動它的左右鄰居，所以片段內容不變。連續 roll 一個片段的前後兩個剪接點，
 * 時間位置會跟 slide 一樣，但內容會跟著滑掉（那是 slip）。
 * t 必須正好落在一個剪輯點上；roll 不動的方向夾成 0（不擲錯）。
 */
export function rollEdit(seq: SequenceV2, t: number, delta: number, ctx?: SeqCtx): SequenceV2 {
  const d = Math.round(delta);
  const i = placeVideo(seq).findIndex((x) => x.t1 === t);
  if (!d || i < 0 || i + 1 >= seq.video.length) return seq;
  const cap = rollCapacity(seq, t, ctx);
  const n = d > 0 ? Math.min(d, cap.right) : -Math.min(-d, cap.left);
  if (!n) return seq;
  const video = [...seq.video];
  video[i] = shiftTail(video[i], n);
  video[i + 1] = shiftHead(video[i + 1], n);
  return finish(seq, mergeAdjacentGaps(video.filter((it) => it.kind !== "gap" || it.length > 0)), seq.audioLanes);
}

/**
 * 滑移片段（NLE 的 Slide）：片段的內容與長度都不變，左右鄰居一個讓出、一個吸收 n 幀。
 *
 * 這是磁吸軌上「把片段挪一格」唯一說得通的語意 —— V1 只有 clip 與 gap、沒有自由位置，
 * 真的「移動」一個片段必然要有人吸收那段時間。**序列總長不變，所以音訊軌完全不動**
 * （不像波紋要跟著搬），滑不動的方向夾成 0（不擲錯）。
 */
export function slideClip(seq: SequenceV2, clipId: string, delta: number, ctx?: SeqCtx): SequenceV2 {
  const d = Math.round(delta);
  const i = seq.video.findIndex((it) => it.kind === "clip" && it.id === clipId);
  if (!d || i < 0) return seq;
  const cap = slideCapacity(seq, clipId, ctx);
  const n = d > 0 ? Math.min(d, cap.right) : -Math.min(-d, cap.left);
  if (!n) return seq;
  const video = [...seq.video];
  video[i - 1] = shiftTail(video[i - 1], n);
  video[i + 1] = shiftHead(video[i + 1], n);
  return finish(seq, mergeAdjacentGaps(video.filter((it) => it.kind !== "gap" || it.length > 0)), seq.audioLanes);
}

/**
 * 移除媒體前先刪掉引用它的片段（同一筆 commit）：V1 片段波紋刪除，分離出來的原音片段連鎖定的軌也一起刪
 * —— 媒體都不在了，留著就是懸空的來源。
 */
export function removeMediaRefs(seq: SequenceV2, mediaId: string, ctx?: SeqCtx): SequenceV2 {
  const v1 = seq.video.filter((it) => it.kind === "clip" && it.mediaId === mediaId).map((it) => it.id);
  const next = rippleDelete(seq, v1, ctx);
  const ids = new Set(next.audioLanes.flatMap((l) => l.clips.filter((c) => c.source.type === "media" && c.source.mediaId === mediaId).map((c) => c.id)));
  return ids.size ? finish(next, next.video, removeAudioClipsById(next.audioLanes, ids, true)) : next;
}

/** 移除音訊媒體前刪掉所有用到它的音訊片段（含鎖定的軌）。 */
export function removeAudioMediaRefs(seq: SequenceV2, audioId: string): SequenceV2 {
  const ids = new Set(seq.audioLanes.flatMap((l) => l.clips.filter((c) => c.source.type === "audio" && c.source.audioId === audioId).map((c) => c.id)));
  return ids.size ? finish(seq, seq.video, removeAudioClipsById(seq.audioLanes, ids, true)) : seq;
}
