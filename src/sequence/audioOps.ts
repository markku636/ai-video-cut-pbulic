// 音訊相關的序列剪輯純函式（docs/editor-m2-design.md §5.2 後半）：分離原音、加入 / 移動音訊片段、增益與淡化、
// 自動化（閃避 / 靜音範圍）、音軌本身的屬性。約定同 ops.ts：沒變回傳同一個參照、拒絕執行擲 SequenceError。
import {
  GAIN_DB_MIN,
  SEQ_SAMPLE_RATE,
  defaultSyncLock,
  type AudioClipV2,
  type AudioLaneV2,
  type AudioRole,
  type AudioSourceRefV2,
  type ClipGainV2,
  type FadeCurve,
  type GainPointV2,
  type SequenceV2,
} from "../project/format";
import { sourceAudioInfo, type SeqCtx } from "./context";
import { clampDb, envelopeDbAt, simplifyEnvelope } from "./envelope";
import { clipIdsOf, laneIdsOf, SequenceError, takeId } from "./ids";
import { fitsAt, insertSorted, mapShared, nearestFreeStart, repairDetachRefs } from "./laneEdit";
import { placeVideo, placedSampleLength, roundHalfUp, samplesOfFrame, videoAbsUs } from "./map";

/** 新音軌的預設名稱尾碼（使用者可改名；資料不是介面字串，所以不走 t()）。 */
const ROLE_LANE_NAMES: Record<AudioRole, string> = { music: "音樂", voiceover: "旁白", sfx: "音效", other: "音訊" };

/** muteRange 的斜坡：5 ms（48 kHz），短到聽不出淡化、長到不會爆音。 */
export const MUTE_RAMP_SAMPLES = 240;
/** 「套用預設淡入淡出」的長度：0.5 s（Premiere 預設音訊轉場的常見設定）。 */
export const DEFAULT_FADE_SAMPLES = 24000;

function newLane(seq: SequenceV2, role: AudioRole, opts: { id?: string; name?: string } = {}): AudioLaneV2 {
  return {
    id: opts.id ?? takeId(laneIdsOf(seq), "lane"),
    name: opts.name ?? `A${seq.audioLanes.length + 1} ${ROLE_LANE_NAMES[role]}`,
    role,
    muted: false,
    locked: false,
    syncLock: defaultSyncLock(role),
    gainDb: 0,
    clips: [],
  };
}

function replaceLane(seq: SequenceV2, lane: AudioLaneV2): SequenceV2 {
  return { ...seq, audioLanes: seq.audioLanes.map((l) => (l.id === lane.id ? lane : l)) };
}

// ---------------------------------------------------------------- 分離音訊

/**
 * 分離音訊（Ctrl+Alt+L）：V1 片段的原音變成音軌上的獨立片段（之後可以做 J/L cut），原片段原音靜音並記 detachedTo。
 * srcIn 以容器絕對時間換算：片段入點的視訊時間 − 音訊串流起點，再換成原生樣本 ——
 * `startUs ≠ videoStartUs`（音訊比畫面晚開始）時 srcIn 會是負的，前面補靜音，A/V 才對得上（§3.1、§7.3）。
 * 放在 role other、同步鎖開、未鎖定、放得下的第一條軌；沒有就新建「A{n} 原音（分離）」。增益、淡化、自動化照抄。
 */
export function detachAudio(seq: SequenceV2, clipId: string, ctx: SeqCtx, opts: { id?: string } = {}): SequenceV2 {
  const placed = placeVideo(seq);
  const p = placed.find((x) => x.item.id === clipId);
  if (!p || p.item.kind !== "clip") throw new SequenceError("notFound", `找不到片段 ${clipId}`, { id: clipId });
  const c = p.item;
  if (!c.audio.enabled || c.audio.detachedTo !== undefined) throw new SequenceError("noOriginalAudio", `片段 ${clipId} 的原音已經靜音或分離`, { id: clipId });
  const info = ctx.media(c.mediaId)?.audio;
  if (!info) throw new SequenceError("noAudioInfo", `媒體 ${c.mediaId} 還沒有音訊時間資訊（media.audio_info）`, { mediaId: c.mediaId });
  const start = samplesOfFrame(p.t0, seq.fps);
  const length = placedSampleLength(p, seq.fps);
  const inUs = videoAbsUs(c.srcIn, seq.fps, info.videoStartUs ?? 0);
  const srcIn = roundHalfUp(((inUs - info.startUs) * info.sampleRate) / 1e6);
  const id = opts.id ?? takeId(clipIdsOf(seq), "aclip");
  const { gainDb, fadeIn, fadeOut, fadeCurve, envelope } = c.audio;
  const clip: AudioClipV2 = { id, source: { type: "media", mediaId: c.mediaId }, start, length, srcIn, enabled: true, gainDb, fadeIn, fadeOut, fadeCurve, envelope: [...envelope], detachedFrom: c.id };
  if (c.label !== undefined) clip.label = c.label;
  const target = seq.audioLanes.find((l) => l.role === "other" && l.syncLock && !l.locked && fitsAt(l.clips, start, length));
  const lane = target ?? newLane(seq, "other", { name: `A${seq.audioLanes.length + 1} 原音（分離）` });
  const placedLane = { ...lane, clips: insertSorted(lane.clips, clip) };
  const audioLanes = target ? seq.audioLanes.map((l) => (l === target ? placedLane : l)) : [...seq.audioLanes, placedLane];
  const video = seq.video.map((it) => (it === c ? { ...c, audio: { ...c.audio, enabled: false, detachedTo: id } } : it));
  return { ...seq, video, audioLanes };
}

// ---------------------------------------------------------------- 加入 / 移動音訊片段

export interface AddAudioOptions {
  id?: string;
  /** 來源入點（原生樣本），預設 0。 */
  srcIn?: number;
  /** 片段長度（序列樣本），預設 = 來源剩餘長度換成 48 kHz。 */
  length?: number;
  /** 找不到軌時新建的角色；預設取 audioMedia 的 role，分離原音為 other。 */
  role?: AudioRole;
}

/**
 * 加入音訊片段（§5.2 addAudioClip）：放在 atSample（序列樣本）。
 * 和既有片段重疊時**時間不動、換軌**：先試指定的軌，再試同角色的其他未鎖定軌，都放不下就開一條新軌（CapCut 的行為）。
 * 為什麼不往後挪到放得下的地方：使用者是對著畫面放的（M2.14 驗收「片段出現在放下的幀」），挪時間比換軌更難發現。覆寫編輯留到 M2.later。
 */
export function addAudioClip(seq: SequenceV2, laneId: string | null, src: AudioSourceRefV2, atSample: number, ctx: SeqCtx, opts: AddAudioOptions = {}): SequenceV2 {
  const info = sourceAudioInfo(ctx, src);
  const srcIn = Math.round(opts.srcIn ?? 0);
  if (!info && opts.length == null) throw new SequenceError("noAudioInfo", "音訊來源還沒有時間資訊，不知道長度", { source: src });
  const length = Math.round(opts.length ?? Math.floor(((info!.nSamples - srcIn) * SEQ_SAMPLE_RATE) / info!.sampleRate));
  if (length < 1) throw new SequenceError("noAudioInfo", "音訊來源在入點之後沒有樣本", { source: src, srcIn });
  const start = Math.max(0, Math.round(atSample));
  const role: AudioRole = opts.role ?? (src.type === "audio" ? ctx.audioMedia(src.audioId)?.role : undefined) ?? "other";
  const id = opts.id ?? takeId(clipIdsOf(seq), "aclip");
  const clip: AudioClipV2 = { id, source: src, start, length, srcIn, enabled: true, gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [] };
  const preferred = seq.audioLanes.find((l) => l.id === laneId);
  const candRole = preferred?.role ?? role;
  const cands = [...(preferred ? [preferred] : []), ...seq.audioLanes.filter((l) => l !== preferred && l.role === candRole)];
  const target = cands.find((l) => !l.locked && fitsAt(l.clips, start, length));
  if (target) return replaceLane(seq, { ...target, clips: insertSorted(target.clips, clip) });
  const lane = newLane(seq, candRole);
  return { ...seq, audioLanes: [...seq.audioLanes, { ...lane, clips: [clip] }] };
}

/**
 * 移動音訊片段到 laneId 的 start（序列樣本）。重疊時拒絕：擲 overlap，detail.nearest 是最近放得下的起點（UI 拖曳時紅框並回彈）。
 * 來源軌或目標軌鎖定擲 locked。
 */
export function moveAudioClip(seq: SequenceV2, id: string, laneId: string, start: number): SequenceV2 {
  const from = seq.audioLanes.find((l) => l.clips.some((c) => c.id === id));
  const to = seq.audioLanes.find((l) => l.id === laneId);
  if (!from || !to) throw new SequenceError("notFound", `找不到片段 ${id} 或音軌 ${laneId}`, { id, laneId });
  if (from.locked || to.locked) throw new SequenceError("locked", "音軌已鎖定", { laneId: from.locked ? from.id : to.id });
  const c = from.clips.find((x) => x.id === id)!;
  const s = Math.max(0, Math.round(start));
  if (from === to && s === c.start) return seq;
  if (!fitsAt(to.clips, s, c.length, id)) throw new SequenceError("overlap", "目標位置跟同軌片段重疊", { nearest: nearestFreeStart(to.clips, c.length, s, id) });
  const moved = { ...c, start: s };
  if (from === to) return replaceLane(seq, { ...to, clips: insertSorted(to.clips.filter((x) => x.id !== id), moved) });
  return {
    ...seq,
    audioLanes: seq.audioLanes.map((l) => (l === from ? { ...l, clips: l.clips.filter((x) => x.id !== id) } : l === to ? { ...l, clips: insertSorted(l.clips, moved) } : l)),
  };
}

// ---------------------------------------------------------------- 增益 / 淡化 / 自動化

/** 對 ids 指到的片段層增益參數套 f：V1 片段改它的原音、音訊片段改自己（鎖定軌跳過）。length = 片段的序列樣本長度。 */
function mapGains(seq: SequenceV2, ids: ReadonlySet<string>, f: <T extends ClipGainV2>(g: T, length: number) => T): SequenceV2 {
  const placed = placeVideo(seq);
  const video = mapShared(seq.video, (it, i) => {
    if (it.kind !== "clip" || !ids.has(it.id)) return it;
    const audio = f(it.audio, placedSampleLength(placed[i], seq.fps));
    return audio === it.audio ? it : { ...it, audio };
  });
  const audioLanes = mapShared(seq.audioLanes, (l) => {
    if (l.locked) return l;
    const clips = mapShared(l.clips, (c) => (ids.has(c.id) ? f(c, c.length) : c));
    return clips === l.clips ? l : { ...l, clips };
  });
  return video === seq.video && audioLanes === seq.audioLanes ? seq : { ...seq, video, audioLanes };
}

/**
 * 逐片段設定增益：正規化時每個片段要加的 dB 都不一樣，setGain 的「全部同一個值」不夠用。
 * 沒列在 map 裡的片段完全不動；鎖定的音軌跳過。
 */
export function setGainsById(seq: SequenceV2, byId: ReadonlyMap<string, number>): SequenceV2 {
  if (!byId.size) return seq;
  const pick = <T extends ClipGainV2>(g: T, id: string): T => {
    const db = byId.get(id);
    if (db === undefined) return g;
    const v = clampDb(db);
    return g.gainDb === v ? g : { ...g, gainDb: v };
  };
  const video = mapShared(seq.video, (it) => {
    if (it.kind !== "clip") return it;
    const audio = pick(it.audio, it.id);
    return audio === it.audio ? it : { ...it, audio };
  });
  const audioLanes = mapShared(seq.audioLanes, (l) => {
    if (l.locked) return l;
    const clips = mapShared(l.clips, (c) => pick(c, c.id));
    return clips === l.clips ? l : { ...l, clips };
  });
  return video === seq.video && audioLanes === seq.audioLanes ? seq : { ...seq, video, audioLanes };
}

/** 片段增益（dB，夾在 [−96, +12]）。 */
export function setGain(seq: SequenceV2, ids: readonly string[], db: number): SequenceV2 {
  const v = clampDb(db);
  return mapGains(seq, new Set(ids), (g) => (g.gainDb === v ? g : { ...g, gainDb: v }));
}

export interface FadePatch {
  fadeIn?: number;
  fadeOut?: number;
  fadeCurve?: FadeCurve;
}

/** 淡入 / 淡出 / 曲線：長度夾在 [0, length]，淡入先佔、淡出拿剩下的（兩個加起來不超過片段長度）。 */
export function setFades(seq: SequenceV2, ids: readonly string[], patch: FadePatch): SequenceV2 {
  return mapGains(seq, new Set(ids), (g, length) => {
    const fadeIn = Math.max(0, Math.min(length, Math.round(patch.fadeIn ?? g.fadeIn)));
    const fadeOut = Math.max(0, Math.min(length - fadeIn, Math.round(patch.fadeOut ?? g.fadeOut)));
    const fadeCurve = patch.fadeCurve ?? g.fadeCurve;
    return fadeIn === g.fadeIn && fadeOut === g.fadeOut && fadeCurve === g.fadeCurve ? g : { ...g, fadeIn, fadeOut, fadeCurve };
  });
}

/** 套用預設淡入淡出（Ctrl+Shift+D）：兩端各 0.5 s，片段太短時各佔一半。 */
export function applyDefaultFades(seq: SequenceV2, ids: readonly string[], samples = DEFAULT_FADE_SAMPLES): SequenceV2 {
  return mapGains(seq, new Set(ids), (g, length) => {
    const n = Math.min(samples, Math.floor(length / 2));
    return g.fadeIn === n && g.fadeOut === n ? g : { ...g, fadeIn: n, fadeOut: n };
  });
}

/** 整條自動化曲線換掉：at 取整並夾進 [0, length]、dB 夾住、依 at 穩定排序。 */
export function setEnvelope(seq: SequenceV2, ids: readonly string[], points: readonly GainPointV2[]): SequenceV2 {
  return mapGains(seq, new Set(ids), (g, length) => {
    const envelope = points.map((p) => ({ at: Math.max(0, Math.min(length, Math.round(p.at))), db: clampDb(p.db) })).sort((a, b) => a.at - b.at);
    const same = envelope.length === g.envelope.length && envelope.every((p, i) => p.at === g.envelope[i].at && p.db === g.envelope[i].db);
    return same ? g : { ...g, envelope };
  });
}

export function clearAutomation(seq: SequenceV2, ids: readonly string[]): SequenceV2 {
  return mapGains(seq, new Set(ids), (g) => (g.envelope.length ? { ...g, envelope: [] } : g));
}

/** 靜音 / 取消靜音原音（V1 片段的 audio.enabled）；已分離的片段不動（它的聲音在音軌上）。 */
export function setOriginalAudioEnabled(seq: SequenceV2, ids: readonly string[], enabled: boolean): SequenceV2 {
  const idSet = new Set(ids);
  const video = mapShared(seq.video, (it) => (it.kind === "clip" && idSet.has(it.id) && it.audio.detachedTo === undefined && it.audio.enabled !== enabled ? { ...it, audio: { ...it.audio, enabled } } : it));
  return video === seq.video ? seq : { ...seq, video };
}

/**
 * 在一個片段的曲線上寫入閃避：絕對樣本的折線 (in−ramp, 原值) → (in, db) → (out, db) → (out+ramp, 原值)，
 * 換成片段內座標、裁在 [0, length] 內（跨片段邊界時各自補內插點），原本落在視窗內的點先清掉。
 * 「原值」取既有曲線在視窗兩端的值（沒有自動化時就是 0 dB，同設計 §5.2）：已經有自動化時才不會在視窗邊緣跳一下。
 */
function duckEnvelope(env: readonly GainPointV2[], clipStart: number, length: number, A: number, B: number, ramp: number, db: number): GainPointV2[] | null {
  const a0 = A - ramp - clipStart;
  const a3 = B + ramp - clipStart;
  if (a3 <= 0 || a0 >= length) return null;
  const poly: GainPointV2[] = [
    { at: a0, db: envelopeDbAt(env, a0, "left") },
    { at: A - clipStart, db },
    { at: B - clipStart, db },
    { at: a3, db: envelopeDbAt(env, a3, "right") },
  ];
  const lo = Math.max(0, a0);
  const hi = Math.min(length, a3);
  const clipped: GainPointV2[] = [];
  if (a0 < 0) clipped.push({ at: 0, db: envelopeDbAt(poly, 0, "right") });
  for (const p of poly) if (p.at >= lo && p.at <= hi) clipped.push(p);
  if (a3 > length) clipped.push({ at: length, db: envelopeDbAt(poly, length, "left") });
  const before = env.filter((p) => p.at < lo);
  const after = env.filter((p) => p.at > hi);
  return simplifyEnvelope([...before, ...clipped, ...after]);
}

/**
 * 閃避範圍（§5.2 duckRange）：laneSel = "A0"（V1 原音）或音軌 id 清單；range 是序列幀（不含 out）；ramp 是樣本。
 * 範圍內（含斜坡）的每個片段各寫自己的點；沒有片段碰到範圍時回傳原序列。
 */
export function duckRange(seq: SequenceV2, laneSel: "A0" | readonly string[], range: { in: number; out: number }, db: number, rampSamples: number): SequenceV2 {
  const A = samplesOfFrame(Math.max(0, range.in), seq.fps);
  const B = samplesOfFrame(Math.max(0, range.out), seq.fps);
  if (B <= A) return seq;
  const ramp = Math.max(0, Math.round(rampSamples));
  const v = clampDb(db);
  if (laneSel === "A0") {
    const placed = placeVideo(seq);
    const video = mapShared(seq.video, (it, i) => {
      // 已分離的片段聲音在音軌上（A0 那一列畫成「已分離 → A1」）：寫在它靜音的原音上聽不到，還會在重新連結時冒出來
      if (it.kind !== "clip" || it.audio.detachedTo !== undefined) return it;
      const envelope = duckEnvelope(it.audio.envelope, samplesOfFrame(placed[i].t0, seq.fps), placedSampleLength(placed[i], seq.fps), A, B, ramp, v);
      return envelope ? { ...it, audio: { ...it.audio, envelope } } : it;
    });
    return video === seq.video ? seq : { ...seq, video };
  }
  const sel = new Set(laneSel);
  const audioLanes = mapShared(seq.audioLanes, (l) => {
    if (!sel.has(l.id) || l.locked) return l;
    const clips = mapShared(l.clips, (c) => {
      const envelope = duckEnvelope(c.envelope, c.start, c.length, A, B, ramp, v);
      return envelope ? { ...c, envelope } : c;
    });
    return clips === l.clips ? l : { ...l, clips };
  });
  return audioLanes === seq.audioLanes ? seq : { ...seq, audioLanes };
}

/** 範圍內靜音 = 閃避到 −96 dB、5 ms 斜坡。 */
export function muteRange(seq: SequenceV2, laneSel: "A0" | readonly string[], range: { in: number; out: number }): SequenceV2 {
  return duckRange(seq, laneSel, range, GAIN_DB_MIN, MUTE_RAMP_SAMPLES);
}

// ---------------------------------------------------------------- 音軌

export function addLane(seq: SequenceV2, role: AudioRole, opts: { id?: string; name?: string } = {}): SequenceV2 {
  return { ...seq, audioLanes: [...seq.audioLanes, newLane(seq, role, opts)] };
}

/** 刪除音軌：裡面還有片段就擲 laneNotEmpty（選單上是停用狀態，這裡是最後一道防線）。 */
export function removeLane(seq: SequenceV2, laneId: string): SequenceV2 {
  const lane = seq.audioLanes.find((l) => l.id === laneId);
  if (!lane) return seq;
  if (lane.clips.length) throw new SequenceError("laneNotEmpty", `音軌 ${lane.name} 還有 ${lane.clips.length} 個片段`, { laneId, clips: lane.clips.length });
  return { ...seq, audioLanes: seq.audioLanes.filter((l) => l !== lane) };
}

export type LanePatch = Partial<Pick<AudioLaneV2, "name" | "role" | "muted" | "locked" | "syncLock" | "gainDb">>;

/** 改音軌屬性（名稱、角色、靜音、鎖定、同步鎖、推桿）。改角色不會自動改同步鎖：那是使用者明確設定過的東西。 */
export function setLane(seq: SequenceV2, laneId: string, patch: LanePatch): SequenceV2 {
  const lane = seq.audioLanes.find((l) => l.id === laneId);
  if (!lane) return seq;
  const next: AudioLaneV2 = { ...lane, ...patch, ...(patch.gainDb !== undefined ? { gainDb: clampDb(patch.gainDb) } : {}) };
  const same = (Object.keys(patch) as (keyof LanePatch)[]).every((k) => next[k] === lane[k]);
  return same ? seq : replaceLane(seq, next);
}

/** A0 原音匯流排（靜音、推桿）。 */
export function setOriginalBus(seq: SequenceV2, patch: Partial<SequenceV2["original"]>): SequenceV2 {
  const next = { ...seq.original, ...patch, ...(patch.gainDb !== undefined ? { gainDb: clampDb(patch.gainDb) } : {}) };
  return next.muted === seq.original.muted && next.gainDb === seq.original.gainDb ? seq : { ...seq, original: next };
}

/** 把音訊片段換到新音軌（右鍵「移到新音軌」）：時間不變。 */
export function moveToNewLane(seq: SequenceV2, id: string, opts: { laneId?: string } = {}): SequenceV2 {
  const from = seq.audioLanes.find((l) => l.clips.some((c) => c.id === id));
  if (!from) throw new SequenceError("notFound", `找不到片段 ${id}`, { id });
  if (from.locked) throw new SequenceError("locked", "音軌已鎖定", { laneId: from.id });
  const c = from.clips.find((x) => x.id === id)!;
  const lane = { ...newLane(seq, from.role, { id: opts.laneId }), clips: [c] };
  const audioLanes = [...seq.audioLanes.map((l) => (l === from ? { ...l, clips: l.clips.filter((x) => x.id !== id) } : l)), lane];
  return repairDetachRefs({ ...seq, audioLanes });
}
