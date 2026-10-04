// 專案檔內容的防禦性解析（計畫 §5.6 sanitize.ts：沿用 ai-music-cut 的 drop-and-report）。
//
// 專案檔會在機器之間複製、會被手改、會被不同版本的 App 寫過。壞掉的欄位進了 store 之後，
// 症狀出現的地方離原因很遠：`keyframes: [{ frame: "abc" }]` 不會當場報錯，而是讓時間軸畫出一個 NaN 位置的
// 菱形、追蹤器把 NaN 送進 findHomography 然後整條 track 靜靜地 lost。
//
// **壞掉的條目丟掉，不要整份拒絕開啟。** 少一個關鍵幀是可以接受的；因為一個壞欄位就打不開整個專案不行。
// 丟掉幾筆會回報數量（SanitizeReport），讓人知道發生過。
//
// 規則（計畫 §5.6）：幀號必為有限整數且 `< proxy.frames`（沒有 proxy 時只驗整數 ≥ 0）、quad 4 點凸、
// 提示點 label ∈ {0,1}。外掛登記的鍵（頂層、track、options、insert）交給外掛驗（src/plugins/api.ts）；
// 外掛不在時那些鍵原樣保留，存回去不會被洗掉。

import type { MediaProbe, ProxyMeta, Rational } from "../api";
import { plugins } from "../plugins/registry";
import { samplesOfFrame } from "../sequence/map";
import { CAPTION_PRESETS, isCaptionPresetId, presetSegmentation } from "../store/captions";
import { isConvex } from "../video/quad";
import { sanitizeProfile } from "./profiles";
import { isForeignValue } from "./vocab";
import {
  type AudioClipV2,
  type AudioInfoV2,
  type AudioLaneV2,
  type MarkerV2,
  type AudioMediaV2,
  type AudioSourceRefV2,
  type ClipAudioV2,
  type ClipGainV2,
  DEFAULT_EDGE_DECLICK_MS,
  defaultSyncLock,
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  type GainPointV2,
  isAudioRole,
  isFadeCurve,
  MAX_NEGATIVE_SRC_IN_SECONDS,
  type ProjectFileV2,
  type ProjectMediaV2,
  sameRational,
  SEQ_SAMPLE_RATE,
  type SequenceV2,
  type VideoClipV2,
  type VideoItemV2,
  writtenSchemaVersion,
  CAPTION_CUE_FLAGS,
  CAPTION_TRACK_KEYS,
  type CaptionCueFlag,
  type CaptionCueV1,
  type CaptionSegmentationV1,
  type CaptionSourceV1,
  type CaptionStyleV1,
  type CaptionTrackV1,
  type CaptionWordV1,
  DEFAULT_TRACK_OPTIONS,
  emptyPluginData,
  EXPORT_DEFAULTS,
  INSERT_DEFAULTS,
  INSERT_KEYS,
  isRecord,
  pluginLevelKeys,
  pluginTopLevelKeys,
  ProjectFormatError,
  SCHEMA_VERSION,
  type ExportDefaultsV1,
  type InsertDefaultsV1,
  type InsertV1,
  type KeyframeV1,
  type MotionModel,
  type PromptV1,
  type Quad,
  type ReferencePointV1,
  type ShotV1,
  type ShutterPhase,
  trackKeys,
  type TrackOptionsV1,
  type TrackV1,
  DEFAULT_REPLACE,
  type EffectV1,
  type JsonValueLite,
  OBJECT_COLORS,
  OBJECT_SOURCE_TYPES,
  type ObjectSourceV1,
  REPLACE_FITS,
  REPLACE_KINDS,
  REPLACE_LOOPS,
  type ReplaceV1,
  type TrackKind,
} from "./format";

/**
 * 「保留但改過」的項目（序列規則表 §3.5 的「保留並標離線」「等比縮小」「修正」「清掉」「重新發號」）。
 * 為什麼不算進 dropped：toast 會說「略過 N 筆壞掉的資料」，但這些東西一筆都沒丟；混進去會讓使用者以為剪輯被刪了。
 */
export type SanitizeWarningCode =
  /** sequence.fps 壞掉，改用第一個 V1 片段媒體的 proxy fps。 */
  | "sequence.fps"
  /** sequence 寬高壞掉，改為 0（render.plan 會擋）。 */
  | "sequence.size"
  | "sequence.sampleRate"
  /** 片段 srcOut 超過 proxy 幀數：保留並標離線（proxy 以不同 fps 重建時不能默默刪掉剪輯）。ref = 片段 id。 */
  | "sequence.offline"
  /** 媒體 proxy fps ≠ 序列 fps（每支媒體報一次）。ref = mediaId。 */
  | "sequence.fpsMismatch"
  /** 媒體尺寸 ≠ 序列尺寸（每支媒體報一次）。ref = mediaId。 */
  | "sequence.sizeMismatch"
  /** dB 超出 [−96, +12] 或不是數字，夾住。 */
  | "sequence.gain"
  /** 淡化長度無效歸零，或淡入＋淡出超過片段長度而等比縮小。 */
  | "sequence.fades"
  | "sequence.fadeCurve"
  /** 自動化點超出片段範圍、dB 超界或未排序，已修正。 */
  | "sequence.envelope"
  | "sequence.edgeDeclick"
  | "sequence.role"
  /** detachedTo 懸空（清掉並恢復原音），或指得到卻仍啟用原音（改為靜音，不然會兩份疊在一起）。 */
  | "sequence.detachedTo"
  | "sequence.detachedFrom"
  /** 片段 id 缺少或重複，重新發號。ref = 新 id。 */
  | "sequence.id"
  /** 音軌 id 缺少或重複，重新發號。ref = 新 id。 */
  | "sequence.laneId"
  | "audioMedia.role";

export interface SanitizeWarning {
  code: SanitizeWarningCode;
  /** 片段 / 媒體 / 音軌 id（看 code）。 */
  ref?: string;
}

export interface SanitizeReport {
  /** 每一類丟掉幾筆。全 0 表示這份檔案是乾淨的。 */
  dropped: Record<string, number>;
  total: number;
  /** 保留但修正過的項目（不算進 total）。 */
  warnings: SanitizeWarning[];
}

export function emptyReport(): SanitizeReport {
  return { dropped: {}, total: 0, warnings: [] };
}

/** 丟掉 n 筆並記進報告（外掛的 sanitize 也用這一支，回報的格式才一致）。 */
export function drop(r: SanitizeReport, key: string, n = 1): void {
  if (n <= 0) return;
  r.dropped[key] = (r.dropped[key] ?? 0) + n;
  r.total += n;
}

function warn(r: SanitizeReport, code: SanitizeWarningCode, ref?: string): void {
  r.warnings.push(ref === undefined ? { code } : { code, ref });
}

const rec = (v: unknown): Record<string, unknown> | null => (isRecord(v) ? v : null);
const fin = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** 幀號：有限整數、≥ 0、有 proxy 時 < frames。 */
export function validFrame(v: unknown, frames: number | null): v is number {
  if (!fin(v) || !Number.isInteger(v) || v < 0) return false;
  return frames == null || v < frames;
}

export function sanitizeQuad(v: unknown): Quad | null {
  const o = rec(v);
  if (!o || !Array.isArray(o.p) || o.p.length !== 4) return null;
  const p: [number, number][] = [];
  for (const c of o.p) {
    if (!Array.isArray(c) || c.length !== 2 || !fin(c[0]) || !fin(c[1])) return null;
    p.push([c[0], c[1]]);
  }
  const q: Quad = { p: p as Quad["p"] };
  return isConvex(q) ? q : null;
}

const SHOT_KINDS = new Set(["close", "wide", "unknown"]);

export function sanitizeShots(v: unknown, frames: number | null, r: SanitizeReport): ShotV1[] {
  if (!Array.isArray(v)) {
    drop(r, "shots", v == null ? 0 : 1);
    return [];
  }
  const out: ShotV1[] = [];
  for (const x of v) {
    const o = rec(x);
    // endFrame 不含，可以等於 frames
    if (!o || !str(o.id) || !validFrame(o.startFrame, frames) || !fin(o.endFrame) || !Number.isInteger(o.endFrame) || (o.endFrame as number) <= (o.startFrame as number) || (frames != null && (o.endFrame as number) > frames)) {
      drop(r, "shots");
      continue;
    }
    out.push({
      id: o.id,
      startFrame: o.startFrame as number,
      endFrame: o.endFrame as number,
      kind: SHOT_KINDS.has(o.kind as string) ? (o.kind as ShotV1["kind"]) : "unknown",
      source: o.source === "user" ? "user" : "auto",
    });
  }
  return out.sort((a, b) => a.startFrame - b.startFrame);
}

function sanitizeKeyframes(v: unknown, frames: number | null, r: SanitizeReport): KeyframeV1[] {
  if (!Array.isArray(v)) {
    drop(r, "keyframes", v == null ? 0 : 1);
    return [];
  }
  const out: KeyframeV1[] = [];
  const seen = new Set<number>();
  for (const x of v) {
    const o = rec(x);
    const quad = o ? sanitizeQuad(o.quad) : null;
    if (!o || !validFrame(o.frame, frames) || !quad || seen.has(o.frame)) {
      drop(r, "keyframes");
      continue;
    }
    seen.add(o.frame);
    const kf: KeyframeV1 = { frame: o.frame, quad, source: o.source === "detector" ? "detector" : "user" };
    if (Array.isArray(o.lockedCorners) && o.lockedCorners.length === 4) kf.lockedCorners = o.lockedCorners.map((b) => b === true) as KeyframeV1["lockedCorners"];
    out.push(kf);
  }
  return out.sort((a, b) => a.frame - b.frame);
}

function sanitizePrompts(v: unknown, frames: number | null, r: SanitizeReport): PromptV1[] {
  if (!Array.isArray(v)) {
    drop(r, "prompts", v == null ? 0 : 1);
    return [];
  }
  const out: PromptV1[] = [];
  for (const x of v) {
    const o = rec(x);
    if (!o || !validFrame(o.frame, frames) || !Array.isArray(o.points)) {
      drop(r, "prompts");
      continue;
    }
    const points: PromptV1["points"] = [];
    for (const p of o.points) {
      const q = rec(p);
      if (!q || !fin(q.x) || !fin(q.y) || (q.label !== 0 && q.label !== 1)) {
        drop(r, "promptPoints");
        continue;
      }
      points.push({ x: q.x, y: q.y, label: q.label });
    }
    // 一個沒有點的提示什麼都不做，也不留
    if (!points.length) {
      drop(r, "prompts");
      continue;
    }
    out.push({ frame: o.frame, points });
  }
  return out;
}

function sanitizeReferencePoints(v: unknown, frames: number | null, r: SanitizeReport): ReferencePointV1[] {
  if (!Array.isArray(v)) {
    drop(r, "referencePoints", v == null ? 0 : 1);
    return [];
  }
  const out: ReferencePointV1[] = [];
  for (const x of v) {
    const o = rec(x);
    if (!o || !str(o.id) || !validFrame(o.frame, frames) || !Array.isArray(o.xy) || !fin(o.xy[0]) || !fin(o.xy[1])) {
      drop(r, "referencePoints");
      continue;
    }
    const ci = o.cornerIndex;
    out.push({
      id: o.id,
      frame: o.frame,
      cornerIndex: ci === 0 || ci === 1 || ci === 2 || ci === 3 ? ci : null,
      xy: [o.xy[0], o.xy[1]],
      locked: o.locked === true,
      primaryFrame: validFrame(o.primaryFrame, frames) ? o.primaryFrame : o.frame,
    });
  }
  return out;
}

const MOTION_MODELS = new Set<MotionModel>(["translation", "similarity", "affine", "perspective"]);
/** TrackOptionsV1 裡由核心管的鍵。 */
const OPTION_KEYS: readonly string[] = ["method", "motionModel", "smoothing"];

function sanitizeOptions(v: unknown, r: SanitizeReport): TrackOptionsV1 {
  const o = rec(v);
  if (!o) return { ...DEFAULT_TRACK_OPTIONS };
  const out: TrackOptionsV1 = {
    method: o.method === "dense" ? "dense" : "classic",
    motionModel: MOTION_MODELS.has(o.motionModel as MotionModel) ? (o.motionModel as MotionModel) : "perspective",
    smoothing: fin(o.smoothing) ? Math.max(0, Math.min(1, o.smoothing)) : DEFAULT_TRACK_OPTIONS.smoothing,
  };
  // 外掛的鍵（例如模板牌碼）：有外掛宣告這一層 → 外掛驗；沒有 → 不認得的鍵原樣保留（可能屬於沒裝的外掛）
  if (pluginLevelKeys("optionKeys") === null) copyUnknown(o, OPTION_KEYS, out as unknown as Record<string, unknown>, r, "options.extra");
  else for (const p of plugins()) p.project?.sanitizeOptions?.(o, out, r);
  return out;
}

const MACROS = new Set(["conservative", "standard", "full", "custom"]);
const FALLOFFS = new Set(["linear", "smoothstep"]);
const PHASES = new Set(["centered", "start", "end", "custom"]);
const KERNELS = new Set(["nearest", "bilinear", "bicubic", "lanczos3"]);

function num(v: unknown, lo: number, hi: number): number | undefined {
  return fin(v) ? Math.max(lo, Math.min(hi, v)) : undefined;
}

/** InsertV1：每個子物件整組驗、壞的整組丟（半套參數比沒有更糟）。 */
export function sanitizeInsert(v: unknown, r: SanitizeReport): InsertV1 | null {
  if (v == null) return null;
  const o = rec(v);
  if (!o) {
    drop(r, "insert");
    return null;
  }
  const out: InsertV1 = { macro: MACROS.has(o.macro as string) ? (o.macro as InsertV1["macro"]) : "standard" };
  const op = num(o.opacity, 0, 100);
  if (op !== undefined) out.opacity = op;
  const mix = num(o.applyMix, 0, 100);
  if (mix !== undefined) out.applyMix = mix;
  const e = rec(o.edge);
  if (e && fin(e.choke) && fin(e.softness)) out.edge = { choke: e.choke, softness: e.softness, falloff: FALLOFFS.has(e.falloff as string) ? (e.falloff as "linear" | "smoothstep") : "linear" };
  else if (o.edge !== undefined) drop(r, "insert.edge");
  const oc = rec(o.occlusion);
  if (oc && fin(oc.dilate) && fin(oc.feather)) out.occlusion = { dilate: oc.dilate, feather: oc.feather };
  else if (o.occlusion !== undefined) drop(r, "insert.occlusion");
  const mb = rec(o.motionBlur);
  if (mb && fin(mb.shutterAngle)) {
    out.motionBlur = {
      shutterAngle: Math.max(0, Math.min(360, mb.shutterAngle)),
      shutterPhase: PHASES.has(mb.shutterPhase as string) ? (mb.shutterPhase as ShutterPhase) : "centered",
      samples: mb.samples === "auto" ? "auto" : fin(mb.samples) ? Math.max(1, Math.min(9, Math.round(mb.samples))) : "auto",
    };
  } else if (o.motionBlur !== undefined) drop(r, "insert.motionBlur");
  const rs = rec(o.resample);
  if (rs && KERNELS.has(rs.kernel as string)) out.resample = { kernel: rs.kernel as NonNullable<InsertV1["resample"]>["kernel"], clamp: rs.clamp !== false };
  else if (o.resample !== undefined) drop(r, "insert.resample");
  const rl = rec(o.relight);
  // 反光鎖定：核心只認得 plate；其他像識別字的值原樣保留（外掛加的值，例如 cards 的 "card"；外掛在時由外掛的 sanitizeInsert 定奪）
  if (rl && fin(rl.keepHighlights)) out.relight = { keepHighlights: Math.max(0, Math.min(100, rl.keepHighlights)), sheenLock: isForeignValue(rl.sheenLock) ? rl.sheenLock : "plate" };
  else if (o.relight !== undefined) drop(r, "insert.relight");
  const g = rec(o.grain);
  if (g && fin(g.amount)) out.grain = { mode: g.mode === "synthetic" ? "synthetic" : "measured", amount: Math.max(0, Math.min(200, g.amount)) };
  else if (o.grain !== undefined) drop(r, "insert.grain");
  // 外掛的設定組（例如牌外掛的 flip / paperRatio / smoothing / print）：有外掛宣告這一層 → 外掛驗，其他不認得的鍵照舊不收
  // （Python InsertParams 拒收未知鍵）；沒有任何外掛宣告 → 不認得的鍵原樣保留（可能屬於沒裝的外掛，不能被存檔洗掉）。
  // 只在檔案裡有才寫出來 —— 沒有這幾組的專案存回去逐位元相同。
  if (pluginLevelKeys("insertKeys") === null) copyUnknown(o, INSERT_KEYS, out as unknown as Record<string, unknown>, r, "insert.extra");
  else for (const p of plugins()) p.project?.sanitizeInsert?.(o, out, r);
  return out;
}

/** insertDefaults：缺什麼就用 INSERT_DEFAULTS 補（這裡每個欄位都必須有值）。核心以外的鍵（外掛的設定組）照 sanitizeInsert 留下的順序接在後面。 */
export function sanitizeInsertDefaults(v: unknown, r: SanitizeReport): InsertDefaultsV1 {
  const partial = sanitizeInsert(v, r);
  if (!partial) return { ...INSERT_DEFAULTS };
  const out: InsertDefaultsV1 = {
    macro: partial.macro,
    opacity: partial.opacity ?? INSERT_DEFAULTS.opacity,
    applyMix: partial.applyMix ?? INSERT_DEFAULTS.applyMix,
    edge: partial.edge ?? INSERT_DEFAULTS.edge,
    occlusion: partial.occlusion ?? INSERT_DEFAULTS.occlusion,
    motionBlur: partial.motionBlur ?? INSERT_DEFAULTS.motionBlur,
    resample: partial.resample ?? INSERT_DEFAULTS.resample,
    relight: partial.relight ?? INSERT_DEFAULTS.relight,
    grain: partial.grain ?? INSERT_DEFAULTS.grain,
  };
  for (const [k, x] of Object.entries(partial)) if (!INSERT_KEYS.includes(k) && x !== undefined) (out as unknown as Record<string, unknown>)[k] = x;
  return out;
}

/** 核心認得的區域策略（外掛加的值見 project/vocab.ts）。 */
const CORE_REGION_POLICIES = new Set(["full", "hold"]);

/** 會被當 setter / 原型鏈用的鍵：`JSON.parse` 會把 `"__proto__"` 做成普通屬性，但 `obj[k] = v` 會換掉原型。 */
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
/** extra 的巢狀深度上限：引擎寫的最深是 identity.variants.<name>（3 層），256 層的東西只會是壞檔或惡意檔。 */
const EXTRA_MAX_DEPTH = 32;

/** 純 JSON 值（null / 字串 / 布林 / 有限數 / 陣列 / 原型是 Object 的物件），沒有危險鍵、深度有上限。 */
export function isJsonValue(v: unknown, depth = 0): boolean {
  if (depth > EXTRA_MAX_DEPTH) return false;
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJsonValue(x, depth + 1));
  if (typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.entries(v as Record<string, unknown>).every(([k, x]) => !UNSAFE_KEYS.has(k) && isJsonValue(x, depth + 1));
}

/**
 * track 的 extra：磁碟上是攤平在 track 頂層的未知鍵（引擎 `TrackV1.extra`），記憶體裡的巢狀 `extra` 物件也收（parse 對兩種形狀冪等）。
 * 每個鍵各自驗：不是純 JSON 值的丟並回報 `track.extra`。外掛認得的鍵（例如 cards 的 identity）收好之後交給外掛再驗一次形狀。
 */
function sanitizeTrackExtra(o: Record<string, unknown>, r: SanitizeReport, kind: TrackKind = "planar"): Record<string, unknown> | undefined {
  const known = trackKeys(kind);
  const out: Record<string, unknown> = {};
  const take = (k: string, v: unknown) => {
    if (known.includes(k) || v === undefined) return;
    if (UNSAFE_KEYS.has(k) || !isJsonValue(v)) {
      drop(r, "track.extra");
      return;
    }
    out[k] = v;
  };
  const nested = rec(o.extra);
  if (nested) for (const [k, v] of Object.entries(nested)) take(k, v);
  // 頂層（引擎寫的）優先於巢狀
  for (const [k, v] of Object.entries(o)) take(k, v);
  for (const p of plugins()) p.project?.sanitizeTrackExtra?.(out, r);
  return Object.keys(out).length ? out : undefined;
}

export function sanitizeTracks(v: unknown, frames: number | null, shotIds: Set<string>, r: SanitizeReport): TrackV1[] {
  if (!Array.isArray(v)) {
    drop(r, "tracks", v == null ? 0 : 1);
    return [];
  }
  const out: TrackV1[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    const o = rec(x);
    // shotId 指不到任何鏡頭的 track 畫不出車道、也無法解算 —— 整條丟
    if (!o || !str(o.id) || seen.has(o.id) || !str(o.shotId) || !shotIds.has(o.shotId)) {
      drop(r, "tracks");
      continue;
    }
    if (o.kind === "object") {
      const obj = sanitizeObjectTrack(o, frames, r);
      if (obj) {
        seen.add(o.id);
        out.push(obj);
      } else drop(r, "tracks");
      continue;
    }
    seen.add(o.id);
    const adj = rec(o.adjust);
    const tr: TrackV1 = {
      id: o.id,
      shotId: o.shotId,
      label: typeof o.label === "string" ? o.label : o.id,
      kind: "planar",
      referenceFrame: validFrame(o.referenceFrame, frames) ? o.referenceFrame : null,
      trackingRegion: o.trackingRegion == null ? null : sanitizeQuad(o.trackingRegion),
      keyframes: sanitizeKeyframes(o.keyframes, frames, r),
      prompts: sanitizePrompts(o.prompts, frames, r),
      adjust: { points: sanitizeReferencePoints(adj?.points, frames, r), enabled: adj?.enabled === true },
      options: sanitizeOptions(o.options, r),
      insert: sanitizeInsert(o.insert, r),
      // 外掛加的值（例如 cards 的 keepBarcode）原樣保留；外掛在時由它的 sanitizeTrack 定奪不認得的值
      regionPolicy: CORE_REGION_POLICIES.has(o.regionPolicy as string) || isForeignValue(o.regionPolicy) ? (o.regionPolicy as string) : "full",
      stale: o.stale === true,
    };
    if (o.trackingRegion != null && !tr.trackingRegion) drop(r, "trackingRegion");
    // 外掛的 track 鍵（例如 cards 的 slotId）：接在 stale 後面，磁碟上的鍵順序跟以前一樣
    for (const p of plugins()) p.project?.sanitizeTrack?.(o, tr, r);
    // 原因只在 stale 時有意義；引擎 set_target 可能把 stale 改回 false 卻不動這個鍵（它在引擎是 extra）
    if (tr.stale && o.staleReason === "target") tr.staleReason = "target";
    // 新的可省略鍵接在最後：沒有的 track 存出來的鍵順序跟以前一樣
    const effects = sanitizeEffects(o.effects, r);
    if (effects) tr.effects = effects;
    const replace = sanitizeReplace(o.replace, r);
    if (replace) tr.replace = replace;
    const extra = sanitizeTrackExtra(o, r);
    if (extra) tr.extra = extra;
    out.push(tr);
  }
  return out;
}

// ---- 物件 track / 特效 / 替換（docs/tracking-api.md；契約見 format.ts）----

const HEX6 = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && HEX6.test(v);
}

/** 特效 id 與參數之外的鍵（id / enabled / type 由核心驗，其餘原樣交給引擎）。 */
const EFFECT_CORE_KEYS = new Set(["id", "enabled", "type"]);

/**
 * effects：不是陣列 → 整組丟（回報 effects）；每一筆要有 id（非空、不重複）與 type（非空字串），enabled 缺 = true；
 * 參數必須是純 JSON（壞的參數整筆丟，半套參數送進引擎只會換來看不懂的錯）。省略 / null → undefined（不寫）。
 */
export function sanitizeEffects(v: unknown, r: SanitizeReport): EffectV1[] | undefined {
  if (v == null) return undefined;
  if (!Array.isArray(v)) {
    drop(r, "effects");
    return undefined;
  }
  const out: EffectV1[] = [];
  const ids = new Set<string>();
  for (const x of v) {
    const o = rec(x);
    if (!o || !str(o.id) || ids.has(o.id) || !str(o.type) || (o.enabled !== undefined && typeof o.enabled !== "boolean")) {
      drop(r, "effects");
      continue;
    }
    const params: Record<string, JsonValueLite> = {};
    let ok = true;
    for (const [k, val] of Object.entries(o)) {
      if (EFFECT_CORE_KEYS.has(k) || val === undefined) continue;
      if (UNSAFE_KEYS.has(k) || !isJsonValue(val)) {
        ok = false;
        break;
      }
      params[k] = val as JsonValueLite;
    }
    if (!ok) {
      drop(r, "effects");
      continue;
    }
    ids.add(o.id);
    out.push({ id: o.id, enabled: o.enabled !== false, type: o.type, ...params });
  }
  return out;
}

/**
 * replace：kind / path 不對 → 整個丟（回報 replace）；fit / offsetFrames / loop 缺或壞 → 預設值（不回報：沒寫就是預設）。
 * 不認得的鍵原樣保留。
 */
export function sanitizeReplace(v: unknown, r: SanitizeReport): ReplaceV1 | undefined {
  if (v == null) return undefined;
  const o = rec(v);
  if (!o || !(REPLACE_KINDS as readonly unknown[]).includes(o.kind) || !str(o.path)) {
    drop(r, "replace");
    return undefined;
  }
  const out: ReplaceV1 = {
    kind: o.kind as ReplaceV1["kind"],
    path: o.path,
    fit: (REPLACE_FITS as readonly unknown[]).includes(o.fit) ? (o.fit as ReplaceV1["fit"]) : DEFAULT_REPLACE.fit,
    offsetFrames: fin(o.offsetFrames) && Number.isInteger(o.offsetFrames) ? o.offsetFrames : DEFAULT_REPLACE.offsetFrames,
    loop: (REPLACE_LOOPS as readonly unknown[]).includes(o.loop) ? (o.loop as ReplaceV1["loop"]) : DEFAULT_REPLACE.loop,
  };
  copyUnknown(o, ["kind", "path", "fit", "offsetFrames", "loop"], out as unknown as Record<string, unknown>, r, "replace.extra");
  return out;
}

/** 物件來源：type 不認得 → "select"（回報 track.source）；選填欄位型別不對就不收；不認得的鍵原樣保留。 */
export function sanitizeObjectSource(v: unknown, r: SanitizeReport): ObjectSourceV1 {
  const o = rec(v);
  if (!o || !(OBJECT_SOURCE_TYPES as readonly unknown[]).includes(o.type)) {
    drop(r, "track.source");
    return { type: "select" };
  }
  const out: ObjectSourceV1 = { type: o.type as ObjectSourceV1["type"] };
  if (typeof o.text === "string") out.text = o.text;
  if (typeof o.phrase === "string") out.phrase = o.phrase;
  if (typeof o.backend === "string") out.backend = o.backend;
  if (fin(o.score)) out.score = o.score;
  copyUnknown(o, ["type", "text", "phrase", "backend", "score"], out as unknown as Record<string, unknown>, r, "track.source");
  return out;
}

/** 物件 track 的範圍：整數、k0 < k1；有 proxy 時 k0 < frames，k1 夾到 frames（proxy 以不同 fps 重建時不要整條丟）。 */
export function sanitizeRange(v: unknown, frames: number | null): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const [a, b] = v as unknown[];
  if (!fin(a) || !fin(b) || !Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b <= a) return null;
  if (frames != null && a >= frames) return null;
  return [a, frames != null ? Math.min(b, frames) : b];
}

/**
 * kind:"object" 的 track。range 壞掉 → 整條丟（回 null，由呼叫端回報 tracks）：沒有範圍就不知道遮罩在哪幾幀。
 * 記憶體裡補上平面欄位的預設值（不寫回檔案，見 format.ts objectTrackToJson）。
 */
function sanitizeObjectTrack(o: Record<string, unknown>, frames: number | null, r: SanitizeReport): TrackV1 | null {
  const range = sanitizeRange(o.range, frames);
  if (!range) return null;
  const color = isHexColor(o.color) ? o.color : OBJECT_COLORS[0];
  if (o.color !== undefined && !isHexColor(o.color)) drop(r, "track.color");
  const tr: TrackV1 = {
    id: o.id as string,
    shotId: o.shotId as string,
    label: typeof o.label === "string" ? o.label : (o.id as string),
    kind: "object",
    referenceFrame: validFrame(o.referenceFrame, frames) ? o.referenceFrame : null,
    trackingRegion: null,
    keyframes: sanitizeKeyframes(o.keyframes ?? [], frames, r),
    prompts: [],
    adjust: { points: [], enabled: false },
    options: { ...DEFAULT_TRACK_OPTIONS },
    insert: null,
    regionPolicy: "full",
    stale: false,
    color,
    source: sanitizeObjectSource(o.source, r),
    range,
  };
  const effects = sanitizeEffects(o.effects, r);
  if (effects) tr.effects = effects;
  for (const p of plugins()) p.project?.sanitizeTrack?.(o, tr, r);
  const extra = sanitizeTrackExtra(o, r, "object");
  if (extra) tr.extra = extra;
  return tr;
}

export function sanitizeExportDefaults(v: unknown, r: SanitizeReport): ExportDefaultsV1 {
  const o = rec(v);
  if (!o) {
    drop(r, "exportDefaults", v == null ? 0 : 1);
    return { ...EXPORT_DEFAULTS, trackData: { ...EXPORT_DEFAULTS.trackData } };
  }
  const td = rec(o.trackData);
  return {
    codec: typeof o.codec === "string" ? o.codec : EXPORT_DEFAULTS.codec,
    quality: fin(o.quality) && o.quality >= 0 ? o.quality : null,
    audio: typeof o.audio === "string" ? o.audio : EXPORT_DEFAULTS.audio,
    trackData: {
      format: td?.format === "ae" ? "ae" : "nuke",
      flavour: td?.flavour === "cornerpin+transform" ? "cornerpin+transform" : "cornerpin",
      baked: td ? td.baked !== false : EXPORT_DEFAULTS.trackData.baked,
      frameOffset: td && fin(td.frameOffset) && Number.isInteger(td.frameOffset) ? td.frameOffset : EXPORT_DEFAULTS.trackData.frameOffset,
    },
  };
}

// ---- 字幕（feat/captions；規格 §5.1 驗證規則）----
//
// 跟 track 一樣 drop-and-report：一個壞掉的字（幀號是字串、跑出段外）丟那個字；段沒有字了才丟段；
// 整條 track 不是物件才整條丟。樣式是「部分覆寫」，壞掉的葉子（色碼不合 #RRGGBB[AA]、列舉值不認得）只丟那一片葉子 ——
// 半套樣式在這裡沒問題，因為有效樣式永遠是 PRESET ← track.style 合出來的，缺的欄位會回到預設值。
// 不認得的鍵（引擎之後加的）在 track / cue / word / style 每一層都保留：前端存檔不能把它們洗掉。

const COLOR_RE = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const MAX_CAPTION_TEXT = 500;
const WORD_SOURCES = new Set(["asr", "user", "llm"]);
const WORD_KEYS = new Set(["text", "startFrame", "endFrame", "prob", "emphasis", "source"]);
const CUE_KEYS = new Set(["id", "startFrame", "endFrame", "words", "speaker", "lang", "styleOverride", "hidden", "flags"]);

/** 未知鍵：純 JSON 值、非危險鍵才搬；壞的回報 `key`。 */
export function copyUnknown(o: Record<string, unknown>, known: Set<string> | readonly string[], out: Record<string, unknown>, r: SanitizeReport, key: string): void {
  const has = (k: string) => (known instanceof Set ? known.has(k) : known.includes(k));
  for (const [k, v] of Object.entries(o)) {
    if (has(k) || v === undefined) continue;
    if (UNSAFE_KEYS.has(k) || !isJsonValue(v)) {
      drop(r, key);
      continue;
    }
    out[k] = v;
  }
}

type LeafRule = (v: unknown) => boolean;
const isColor: LeafRule = (v) => typeof v === "string" && COLOR_RE.test(v);
const isColorOrNull: LeafRule = (v) => v === null || isColor(v);
const isNum = (lo: number, hi: number): LeafRule => (v) => fin(v) && v >= lo && v <= hi;
const oneOf = (...xs: readonly unknown[]): LeafRule => (v) => xs.includes(v);
const isBool: LeafRule = (v) => typeof v === "boolean";

/** 樣式每一片葉子的規則（部分覆寫：沒給的不驗）。子物件 → 葉子規則表。 */
const STYLE_RULES: Record<string, Record<string, LeafRule>> = {
  font: {
    families: (v) => Array.isArray(v) && v.length > 0 && v.length <= 16 && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 128),
    weight: oneOf(400, 500, 700, 800, 900),
    sizePctShortSide: isNum(0.5, 50),
    file: (v) => v === null || (typeof v === "string" && v.length <= 1024),
    letterSpacingEm: isNum(-1, 2),
    uppercaseLatin: isBool,
    cjkLatinSpace: isBool,
  },
  layout: {
    maxWidthPct: isNum(5, 100),
    lineHeight: isNum(0.5, 4),
    align: oneOf("center", "left", "right"),
    anchor: oneOf("bottom", "middle", "top"),
    offsetYPct: isNum(-100, 100),
    safeArea: oneOf("auto", "broadcast", "shorts", "none"),
  },
  colors: { text: isColor, future: isColorOrNull, active: isColorOrNull, past: isColorOrNull, emphasis: isColor, stroke: isColor },
  stroke: { widthPct: isNum(0, 100) },
  shadow: { color: isColor, dxPct: isNum(-100, 100), dyPct: isNum(-100, 100), blurPct: isNum(0, 100) },
  box: { mode: oneOf("none", "line", "activeWord"), color: isColor, padEm: isNum(0, 4), radiusEm: isNum(0, 4) },
  animation: {
    cueIn: oneOf("none", "fade", "pop", "slideUp", "spring"),
    cueInMs: isNum(0, 10_000),
    cueOut: oneOf("none", "fade"),
    cueOutMs: isNum(0, 10_000),
    word: oneOf("none", "karaoke", "karaokeWipe", "pop", "typewriter", "boxMove"),
    wordMs: isNum(0, 10_000),
    activeScale: isNum(0.1, 5),
    emphasisScale: isNum(0.1, 5),
  },
};

/** Partial<CaptionStyleV1>：壞葉子丟（回報 captions.style）、未知鍵留；`shadow: null` 是合法值（不要陰影）。 */
export function sanitizeCaptionStyle(v: unknown, r: SanitizeReport): Partial<CaptionStyleV1> {
  const o = rec(v);
  if (!o) {
    if (v != null) drop(r, "captions.style");
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [group, rules] of Object.entries(STYLE_RULES)) {
    if (!(group in o) || o[group] === undefined) continue;
    const g = o[group];
    if (group === "shadow" && g === null) {
      out.shadow = null;
      continue;
    }
    const go = rec(g);
    if (!go) {
      drop(r, "captions.style");
      continue;
    }
    const sub: Record<string, unknown> = {};
    for (const [leaf, ok] of Object.entries(rules)) {
      if (!(leaf in go) || go[leaf] === undefined) continue;
      if (ok(go[leaf])) sub[leaf] = go[leaf];
      else drop(r, "captions.style");
    }
    copyUnknown(go, Object.keys(rules), sub, r, "captions.style");
    out[group] = sub;
  }
  copyUnknown(o, Object.keys(STYLE_RULES), out, r, "captions.style");
  return out as Partial<CaptionStyleV1>;
}

/** 段落規則：缺的 / 壞的欄位用 preset 在該語言的值補（壞的回報 captions.segmentation）。 */
function sanitizeSegmentation(v: unknown, fallback: CaptionSegmentationV1, r: SanitizeReport): CaptionSegmentationV1 {
  const o = rec(v);
  if (!o) {
    if (v != null) drop(r, "captions.segmentation");
    return fallback;
  }
  const pick = <K extends keyof CaptionSegmentationV1>(k: K, ok: LeafRule): CaptionSegmentationV1[K] => {
    if (o[k] === undefined) return fallback[k];
    if (ok(o[k])) return o[k] as CaptionSegmentationV1[K];
    drop(r, "captions.segmentation");
    return fallback[k];
  };
  const posInt = (lo: number, hi: number): LeafRule => (x) => fin(x) && Number.isInteger(x) && x >= lo && x <= hi;
  const out: Record<string, unknown> = {
    mode: pick("mode", oneOf("sentence", "phrase", "word")),
    maxUnitsPerLine: pick("maxUnitsPerLine", posInt(1, 1000)),
    maxLines: pick("maxLines", oneOf(1, 2, 3)),
    maxWords: pick("maxWords", (x) => x === null || posInt(1, 1000)(x)),
    minDurationMs: pick("minDurationMs", isNum(0, 600_000)),
    maxDurationMs: pick("maxDurationMs", isNum(1, 600_000)),
    gapFrames: pick("gapFrames", posInt(0, 1000)),
    chainGapMs: pick("chainGapMs", isNum(0, 600_000)),
    lagOutMs: pick("lagOutMs", isNum(0, 600_000)),
    pauseBreakMs: pick("pauseBreakMs", isNum(0, 600_000)),
    snapToShots: pick("snapToShots", isBool),
    cpsWarn: pick("cpsWarn", (x) => x === null || isNum(0, 1000)(x)),
  };
  copyUnknown(o, Object.keys(out), out, r, "captions.segmentation");
  return out as unknown as CaptionSegmentationV1;
}

function sanitizeCaptionSource(v: unknown, r: SanitizeReport): CaptionSourceV1 | null {
  if (v == null) return null;
  const o = rec(v);
  if (!o || typeof o.model !== "string" || typeof o.asrPath !== "string") {
    drop(r, "captions.source");
    return null;
  }
  const out: Record<string, unknown> = {
    backend: "faster-whisper",
    model: o.model,
    device: o.device === "cpu" ? "cpu" : "cuda",
    computeType: typeof o.computeType === "string" ? o.computeType : "",
    asrLanguage: typeof o.asrLanguage === "string" ? o.asrLanguage : null,
    detected: typeof o.detected === "string" ? o.detected : null,
    languageProb: fin(o.languageProb) ? Math.max(0, Math.min(1, o.languageProb)) : null,
    asrPath: o.asrPath,
    transcribedAt: typeof o.transcribedAt === "string" ? o.transcribedAt : "",
  };
  copyUnknown(o, Object.keys(out), out, r, "captions.source");
  return out as unknown as CaptionSourceV1;
}

const int = (v: unknown): v is number => fin(v) && Number.isInteger(v);

function sanitizeCaptionWords(v: unknown, cueStart: number, cueEnd: number, r: SanitizeReport): CaptionWordV1[] {
  if (!Array.isArray(v)) {
    drop(r, "captions.words", v == null ? 0 : 1);
    return [];
  }
  const cand: CaptionWordV1[] = [];
  for (const x of v) {
    const o = rec(x);
    if (!o || typeof o.text !== "string" || o.text.length > MAX_CAPTION_TEXT || !int(o.startFrame) || !int(o.endFrame) || o.startFrame >= o.endFrame || o.startFrame < cueStart || o.endFrame > cueEnd) {
      drop(r, "captions.words");
      continue;
    }
    const w: Record<string, unknown> = { text: o.text, startFrame: o.startFrame, endFrame: o.endFrame };
    if (fin(o.prob) && o.prob >= 0 && o.prob <= 1) w.prob = o.prob;
    if (typeof o.emphasis === "boolean") w.emphasis = o.emphasis;
    if (WORD_SOURCES.has(o.source as string)) w.source = o.source;
    copyUnknown(o, WORD_KEYS, w, r, "captions.words.extra");
    cand.push(w as unknown as CaptionWordV1);
  }
  // 排序後丟掉跟前一個字重疊的（逐字高亮的「目前是哪個字」要唯一）
  cand.sort((a, b) => a.startFrame - b.startFrame);
  const out: CaptionWordV1[] = [];
  for (const w of cand) {
    if (out.length && w.startFrame < out[out.length - 1].endFrame) {
      drop(r, "captions.words");
      continue;
    }
    out.push(w);
  }
  return out;
}

function sanitizeCaptionCues(v: unknown, frames: number | null, r: SanitizeReport): CaptionCueV1[] {
  if (!Array.isArray(v)) {
    drop(r, "captions.cues", v == null ? 0 : 1);
    return [];
  }
  const cand: CaptionCueV1[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    const o = rec(x);
    // endFrame 不含，可以等於 frames（同鏡頭）
    if (!o || !str(o.id) || seen.has(o.id) || !int(o.startFrame) || !int(o.endFrame) || o.startFrame < 0 || o.startFrame >= o.endFrame || (frames != null && o.endFrame > frames)) {
      drop(r, "captions.cues");
      continue;
    }
    const words = sanitizeCaptionWords(o.words, o.startFrame, o.endFrame, r);
    // 沒有字的段沒有文字可以顯示、也沒有時間可以對，留著只會在時間軸上畫一塊空白
    if (!words.length) {
      drop(r, "captions.cues");
      continue;
    }
    seen.add(o.id);
    const c: Record<string, unknown> = { id: o.id, startFrame: o.startFrame, endFrame: o.endFrame, words };
    if (o.speaker === null || typeof o.speaker === "string") c.speaker = o.speaker;
    if (typeof o.lang === "string") c.lang = o.lang;
    if (o.styleOverride === null) c.styleOverride = null;
    else if (o.styleOverride !== undefined) c.styleOverride = sanitizeCaptionStyle(o.styleOverride, r);
    if (typeof o.hidden === "boolean") c.hidden = o.hidden;
    if (Array.isArray(o.flags)) {
      const flags = [...new Set(o.flags.filter((f): f is CaptionCueFlag => (CAPTION_CUE_FLAGS as readonly unknown[]).includes(f)))];
      if (flags.length !== o.flags.length) drop(r, "captions.flags", o.flags.length - flags.length);
      c.flags = flags;
    }
    copyUnknown(o, CUE_KEYS, c, r, "captions.cues.extra");
    cand.push(c as unknown as CaptionCueV1);
  }
  cand.sort((a, b) => a.startFrame - b.startFrame);
  const out: CaptionCueV1[] = [];
  for (const c of cand) {
    // 段重疊 = 同一幀兩段字疊在一起燒進去；後面那段丟掉並回報
    if (out.length && c.startFrame < out[out.length - 1].endFrame) {
      drop(r, "captions.cues");
      continue;
    }
    out.push(c);
  }
  return out;
}

/** 一條字幕 track（專案檔 / 引擎 captions.build 的回傳都走這裡）。不是物件 → null 並回報。 */
export function sanitizeCaptionTrack(v: unknown, frames: number | null, r: SanitizeReport): CaptionTrackV1 | null {
  const o = rec(v);
  if (!o) {
    drop(r, "captions", v == null ? 0 : 1);
    return null;
  }
  let presetId = CAPTION_PRESETS.subtitle.id;
  if (isCaptionPresetId(o.presetId)) presetId = o.presetId;
  else if (o.presetId !== undefined) drop(r, "captions.preset");
  const language = typeof o.language === "string" ? o.language : "";
  const track: CaptionTrackV1 = {
    enabled: o.enabled === true,
    language,
    source: sanitizeCaptionSource(o.source, r),
    presetId,
    style: sanitizeCaptionStyle(o.style, r),
    segmentation: sanitizeSegmentation(o.segmentation, presetSegmentation(presetId, language), r),
    cues: sanitizeCaptionCues(o.cues, frames, r),
  };
  const extra: Record<string, unknown> = {};
  const nested = rec(o.extra);
  if (nested) copyUnknown(nested, CAPTION_TRACK_KEYS, extra, r, "captions.extra");
  // 頂層（磁碟形狀）優先於巢狀
  copyUnknown(o, CAPTION_TRACK_KEYS, extra, r, "captions.extra");
  if (Object.keys(extra).length) track.extra = extra;
  return track;
}

/** 專案檔的 `captions`：只收指得到媒體的；缺 = 空物件（沒有字幕）。 */
export function sanitizeCaptions(v: unknown, framesOf: ReadonlyMap<string, number | null>, r: SanitizeReport): Record<string, CaptionTrackV1> {
  if (v == null) return {};
  const o = rec(v);
  if (!o) {
    drop(r, "captions");
    return {};
  }
  const out: Record<string, CaptionTrackV1> = {};
  for (const [mid, tr] of Object.entries(o)) {
    if (UNSAFE_KEYS.has(mid) || !framesOf.has(mid)) {
      drop(r, "orphanMedia");
      continue;
    }
    const t = sanitizeCaptionTrack(tr, framesOf.get(mid) ?? null, r);
    if (t) out[mid] = t;
  }
  return out;
}

interface SanitizedProxy {
  proxy: ProxyMeta | null;
  /** 幀號上限用的 frames：中繼資料本身是好的就有，即使 proxy 因為缺 path 而是 null。 */
  frames: number | null;
  /** 同上：序列 sanitize 比對 fps 用（引擎寫的檔沒有 path，fps 仍然可信）。 */
  fps: Rational | null;
}

function sanitizeProxy(v: unknown, r: SanitizeReport): SanitizedProxy {
  if (v == null) return { proxy: null, frames: null, fps: null };
  const o = rec(v);
  const fps = o ? rec(o.fps) : null;
  if (!o || !fps || !fin(fps.num) || !fin(fps.den) || fps.num <= 0 || fps.den <= 0 || !fin(o.frames) || !Number.isInteger(o.frames) || o.frames < 0 || !fin(o.width) || !fin(o.height)) {
    // proxy 中繼資料壞掉 → 當作沒有 proxy（stale），快取還在的話 openVideo 會重新讀回來
    drop(r, "proxy");
    return { proxy: null, frames: null, fps: null };
  }
  const rate = { num: fps.num, den: fps.den };
  // 引擎的 ProxyMetaV1.to_json 本來就不寫 path（pipeline.run 暫存檔、`aivc run` / `detect` 的輸出都是）：這不是壞資料，
  // 不回報；幀數照樣拿來驗 `< proxy.frames`。proxy 本身留 null —— 路徑只有前端知道（快取目錄），
  // loadFrom 之後的 refreshProxy 會用 readProxyMeta 從快取目錄補回完整的 ProxyMeta。
  if (!str(o.path)) return { proxy: null, frames: o.frames, fps: rate };
  return {
    proxy: { version: 1, fps: rate, frames: o.frames, width: o.width, height: o.height, scale: fin(o.scale) && o.scale > 0 ? o.scale : 1, path: o.path },
    frames: o.frames,
    fps: rate,
  };
}

/** 序列 sanitize 需要的媒體事實：proxy 幀數與 fps（即使 proxy 因缺 path 是 null）、來源尺寸、音訊資訊。 */
interface MediaFacts {
  frames: number | null;
  fps: Rational | null;
  /** probe.video 的寬高（序列在來源像素空間工作）。 */
  size: [number, number] | null;
  audio: AudioInfoV2 | null;
}

function probeSize(probe: MediaProbe | null): [number, number] | null {
  const v = rec(probe?.video);
  return v && int(v.width) && int(v.height) && v.width > 0 && v.height > 0 ? [v.width, v.height] : null;
}

function sanitizeMediaWithFrames(v: unknown, r: SanitizeReport): { media: ProjectMediaV2[]; frames: Map<string, number | null>; facts: Map<string, MediaFacts> } {
  if (!Array.isArray(v)) throw new ProjectFormatError("專案檔缺少 media 陣列");
  const out: ProjectMediaV2[] = [];
  const frames = new Map<string, number | null>();
  const facts = new Map<string, MediaFacts>();
  for (const m of v) {
    const o = rec(m);
    if (!o || !str(o.id) || !str(o.path) || frames.has(o.id)) {
      drop(r, "media");
      continue;
    }
    const px = sanitizeProxy(o.proxy, r);
    frames.set(o.id, px.frames);
    const probe = isRecord(o.probe) ? (o.probe as unknown as MediaProbe) : null;
    const item: ProjectMediaV2 = {
      id: o.id,
      path: o.path,
      name: typeof o.name === "string" && o.name ? o.name : o.path.split(/[\\/]/).pop() ?? o.path,
      fingerprint: typeof o.fingerprint === "string" ? o.fingerprint : "",
      probe,
      proxy: px.proxy,
    };
    // audio 只在鍵存在時才長出來（含 null）：v1 檔沒有這個鍵，讀進寫出才會逐位元相同（§4.3）
    if (o.audio !== undefined) item.audio = o.audio === null ? null : sanitizeAudioInfo(o.audio, r);
    out.push(item);
    facts.set(o.id, { frames: px.frames, fps: px.fps, size: probeSize(probe), audio: item.audio ?? null });
  }
  return { media: out, frames, facts };
}

export function sanitizeMedia(v: unknown, r: SanitizeReport): ProjectMediaV2[] {
  return sanitizeMediaWithFrames(v, r).media;
}

// ---- schema v2：序列與音訊（docs/editor-m2-design.md §3.5；Python project/schema.py 的 SequenceV2.from_json 是同一張規則表）----
//
// 跟 v1 一樣 drop-and-report，但序列多了一種「保留並修正」：片段超出 proxy 幀數不能刪（proxy 以別的 fps 重建時，
// 使用者的剪輯不能因為開檔就消失）、淡化超長等比縮小、懸空的分離參照清掉。那些記在 report.warnings，不算 dropped。
// 每一層不認得的鍵都保留（引擎或之後版本加的欄位不能被前端存檔洗掉），順序是「已知鍵在前、未知鍵在後」，同 Python to_json。

const SEQ_KEYS = ["id", "name", "fps", "width", "height", "sampleRate", "video", "original", "audioLanes", "audio", "markers"];
const CLIP_KEYS = ["kind", "id", "mediaId", "srcIn", "srcOut", "enabled", "audio", "label"];
const GAP_KEYS = ["kind", "id", "length"];
const GAIN_KEYS = ["gainDb", "fadeIn", "fadeOut", "fadeCurve", "envelope"];
const CLIP_AUDIO_KEYS = ["enabled", ...GAIN_KEYS, "detachedTo"];
const AUDIO_CLIP_KEYS = ["id", "source", "start", "length", "srcIn", "enabled", ...GAIN_KEYS, "detachedFrom", "label"];
const LANE_KEYS = ["id", "name", "role", "muted", "locked", "syncLock", "gainDb", "clips"];
const AUDIO_INFO_KEYS = ["codec", "sampleRate", "channels", "channelLayout", "startUs", "videoStartUs", "nSamples", "gaps"];
const AUDIO_MEDIA_KEYS = ["id", "path", "name", "fingerprint", "probe", "role", "audio"];

/** 樣本位置：有限數取最接近的整數（x.5 往 +∞，同 Python `_sample`）。別的寫入端可能寫出 48000.0000001，為了浮點尾巴丟整段音樂不划算。 */
function sampleOf(v: unknown): number | null {
  return fin(v) ? Math.floor(v + 0.5) : null;
}

function clampDb(v: unknown): number {
  return fin(v) ? Math.max(GAIN_DB_MIN, Math.min(GAIN_DB_MAX, v)) : 0;
}

/** 衍生的音訊時間資訊：缺欄位就整個當沒有（null = 缺快取，會重算），不是半套資料。 */
export function sanitizeAudioInfo(v: unknown, r: SanitizeReport): AudioInfoV2 | null {
  const o = rec(v);
  const vs = o?.videoStartUs;
  if (!o || !int(o.sampleRate) || o.sampleRate <= 0 || !int(o.channels) || o.channels <= 0 || !int(o.nSamples) || o.nSamples < 0 || !int(o.startUs) || (vs != null && !int(vs))) {
    drop(r, "audioInfo");
    return null;
  }
  const gaps: AudioInfoV2["gaps"] = [];
  for (const g of Array.isArray(o.gaps) ? o.gaps : []) {
    const go = rec(g);
    if (!go || !int(go.atUs) || !int(go.durUs) || go.durUs <= 0) {
      drop(r, "audioInfo.gaps");
      continue;
    }
    gaps.push({ atUs: go.atUs, durUs: go.durUs });
  }
  const out: Record<string, unknown> = {
    codec: typeof o.codec === "string" ? o.codec : "",
    sampleRate: o.sampleRate,
    channels: o.channels,
    channelLayout: typeof o.channelLayout === "string" ? o.channelLayout : null,
    startUs: o.startUs,
    videoStartUs: int(vs) ? vs : null,
    nSamples: o.nSamples,
    gaps,
  };
  copyUnknown(o, AUDIO_INFO_KEYS, out, r, "audioInfo.extra");
  return out as unknown as AudioInfoV2;
}

/** `audioMedia[]`：id 與 path 必填、id 不重複；壞的丟。 */
export function sanitizeAudioMedia(v: unknown, r: SanitizeReport): AudioMediaV2[] {
  if (v == null) return [];
  if (!Array.isArray(v)) {
    drop(r, "audioMedia");
    return [];
  }
  const out: AudioMediaV2[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    const o = rec(x);
    if (!o || !str(o.id) || !str(o.path) || seen.has(o.id)) {
      drop(r, "audioMedia");
      continue;
    }
    seen.add(o.id);
    if (!isAudioRole(o.role) && o.role != null) warn(r, "audioMedia.role", o.id);
    const item: Record<string, unknown> = {
      id: o.id,
      path: o.path,
      name: typeof o.name === "string" && o.name ? o.name : o.path.split(/[\\/]/).pop() ?? o.path,
      fingerprint: typeof o.fingerprint === "string" ? o.fingerprint : "",
      probe: isRecord(o.probe) ? o.probe : null,
      role: isAudioRole(o.role) ? o.role : "other",
      audio: o.audio == null ? null : sanitizeAudioInfo(o.audio, r),
    };
    copyUnknown(o, AUDIO_MEDIA_KEYS, item, r, "audioMedia.extra");
    out.push(item as unknown as AudioMediaV2);
  }
  return out;
}

/** 片段層音訊參數的「讀」：型別與範圍，不含依長度的修正（那要等片段位置排好，見 fixGainForLength）。 */
function loadGain(o: Record<string, unknown>, r: SanitizeReport, ref: string): ClipGainV2 {
  const gainDb = clampDb(o.gainDb);
  if (o.gainDb != null && o.gainDb !== gainDb) warn(r, "sequence.gain", ref);
  const fade = (raw: unknown): number => {
    if (raw == null) return 0;
    const n = sampleOf(raw);
    if (n === null || n < 0) {
      warn(r, "sequence.fades", ref);
      return 0;
    }
    return n;
  };
  const fadeIn = fade(o.fadeIn);
  const fadeOut = fade(o.fadeOut);
  if (o.fadeCurve != null && !isFadeCurve(o.fadeCurve)) warn(r, "sequence.fadeCurve", ref);
  const envelope: GainPointV2[] = [];
  if (o.envelope != null && !Array.isArray(o.envelope)) warn(r, "sequence.envelope", ref);
  for (const p of Array.isArray(o.envelope) ? o.envelope : []) {
    const po = rec(p);
    const at = po ? sampleOf(po.at) : null;
    if (!po || at === null || !fin(po.db)) {
      drop(r, "sequence.envelope");
      continue;
    }
    envelope.push({ at, db: po.db });
  }
  return { gainDb, fadeIn, fadeOut, fadeCurve: isFadeCurve(o.fadeCurve) ? o.fadeCurve : "linear", envelope };
}

/**
 * 依片段長度（序列樣本）修正：淡入＋淡出超長等比縮小、自動化點夾進 [0, length]、dB 夾住、依 at 排序（§3.5）。
 * 等比縮小一律 floor（`fadeIn·L / (fadeIn+fadeOut)` 取整），兩邊加起來保證 ≤ L；Python sanitize_gain 同一個算式。
 */
function fixGainForLength<T extends ClipGainV2>(g: T, length: number, r: SanitizeReport, ref: string): void {
  const total = g.fadeIn + g.fadeOut;
  if (length > 0 && total > length) {
    g.fadeIn = Math.floor((g.fadeIn * length) / total);
    g.fadeOut = Math.floor((g.fadeOut * length) / total);
    warn(r, "sequence.fades", ref);
  }
  let changed = false;
  const fixed = g.envelope.map((p) => {
    const at = length > 0 ? Math.max(0, Math.min(p.at, length)) : Math.max(0, p.at);
    const db = Math.max(GAIN_DB_MIN, Math.min(GAIN_DB_MAX, p.db));
    if (at !== p.at || db !== p.db) changed = true;
    return at === p.at && db === p.db ? p : { at, db };
  });
  // Array.prototype.sort 是穩定排序：同一個 at 的兩點（階梯）保留原順序，跟 Python sorted 一致
  const ordered = [...fixed].sort((a, b) => a.at - b.at);
  if (changed || ordered.some((p, i) => p !== fixed[i])) warn(r, "sequence.envelope", ref);
  g.envelope = ordered;
}

function sanitizeClipAudio(v: unknown, r: SanitizeReport, ref: string): ClipAudioV2 {
  const o = rec(v);
  if (!o) {
    // 缺 audio 是合法的簡寫（= 預設原音）；不是物件才值得一提
    if (v != null) warn(r, "sequence.gain", ref);
    return { enabled: true, gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [] };
  }
  const out: Record<string, unknown> = { enabled: typeof o.enabled === "boolean" ? o.enabled : true, ...loadGain(o, r, ref) };
  if (str(o.detachedTo)) out.detachedTo = o.detachedTo;
  copyUnknown(o, CLIP_AUDIO_KEYS, out, r, "sequence.extra");
  return out as unknown as ClipAudioV2;
}

function sanitizeSourceRef(v: unknown, r: SanitizeReport): AudioSourceRefV2 | null {
  const o = rec(v);
  if (!o) return null;
  const key = o.type === "media" ? "mediaId" : o.type === "audio" ? "audioId" : null;
  if (!key || !str(o[key])) return null;
  const out: Record<string, unknown> = { type: o.type, [key]: o[key] };
  copyUnknown(o, ["type", key], out, r, "sequence.extra");
  return out as unknown as AudioSourceRefV2;
}

function sanitizeAudioClip(v: unknown, facts: ReadonlyMap<string, MediaFacts>, audioMedia: ReadonlyMap<string, AudioMediaV2>, r: SanitizeReport): AudioClipV2 | null {
  const o = rec(v);
  const source = o ? sanitizeSourceRef(o.source, r) : null;
  if (!o || !source) {
    drop(r, "sequence.audioClips");
    return null;
  }
  // 來源必須在專案裡：純音訊片段指 audioMedia、分離出來的原音指 media
  let info: AudioInfoV2 | null;
  if (source.type === "media") {
    const f = facts.get(source.mediaId);
    if (!f) {
      drop(r, "sequence.audioClips");
      return null;
    }
    info = f.audio;
  } else {
    const am = audioMedia.get(source.audioId);
    if (!am) {
      drop(r, "sequence.audioClips");
      return null;
    }
    info = am.audio;
  }
  const start = sampleOf(o.start);
  const length = sampleOf(o.length);
  const srcIn = o.srcIn == null ? 0 : sampleOf(o.srcIn);
  const native = info?.sampleRate ?? SEQ_SAMPLE_RATE;
  if (start === null || start < 0 || length === null || length < 1 || srcIn === null || srcIn < -MAX_NEGATIVE_SRC_IN_SECONDS * native) {
    drop(r, "sequence.audioClips");
    return null;
  }
  const id = typeof o.id === "string" ? o.id : "";
  const out: Record<string, unknown> = { id, source, start, length, srcIn, enabled: typeof o.enabled === "boolean" ? o.enabled : true, ...loadGain(o, r, id) };
  fixGainForLength(out as unknown as ClipGainV2, length, r, id);
  if (str(o.detachedFrom)) out.detachedFrom = o.detachedFrom;
  if (typeof o.label === "string") out.label = o.label;
  copyUnknown(o, AUDIO_CLIP_KEYS, out, r, "sequence.extra");
  return out as unknown as AudioClipV2;
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** 序列 fps：壞掉時用第一個片段媒體的 proxy fps 補（序列 fps 本來就等於 V1 媒體的 proxy fps）；補不出來回 null。 */
function sequenceFps(o: Record<string, unknown>, rawVideo: readonly unknown[], facts: ReadonlyMap<string, MediaFacts>, r: SanitizeReport): Rational | null {
  const fo = rec(o.fps);
  if (fo && int(fo.num) && int(fo.den) && fo.num > 0 && fo.den > 0) return { num: fo.num, den: fo.den };
  for (const raw of rawVideo) {
    const mid = rec(raw)?.mediaId;
    const f = typeof mid === "string" ? facts.get(mid) : undefined;
    if (f?.fps) {
      warn(r, "sequence.fps");
      return { num: f.fps.num, den: f.fps.den };
    }
  }
  return null;
}

interface SeqFrame {
  fps: Rational;
  width: number;
  height: number;
}

function sanitizeVideoClip(it: Record<string, unknown>, id: string, facts: ReadonlyMap<string, MediaFacts>, frame: SeqFrame, mismatchWarned: Set<string>, r: SanitizeReport): VideoClipV2 | null {
  const mid = it.mediaId;
  const f = typeof mid === "string" ? facts.get(mid) : undefined;
  if (typeof mid !== "string" || !f || !int(it.srcIn) || !int(it.srcOut) || it.srcIn < 0 || it.srcOut <= it.srcIn) return null;
  // proxy 以不同 fps 重建時片段會超界：保留並標離線，不能默默刪掉使用者的剪輯
  if (f.frames != null && it.srcOut > f.frames) warn(r, "sequence.offline", id);
  // fps / 尺寸不符只警告（每支媒體一次）：render.plan 會擋下並請使用者以序列 fps 重建 proxy
  if (!mismatchWarned.has(mid)) {
    if (f.fps && !sameRational(f.fps, frame.fps)) {
      warn(r, "sequence.fpsMismatch", mid);
      mismatchWarned.add(mid);
    } else if (f.size && frame.width && (f.size[0] !== frame.width || f.size[1] !== frame.height)) {
      warn(r, "sequence.sizeMismatch", mid);
      mismatchWarned.add(mid);
    }
  }
  const clip: Record<string, unknown> = { kind: "clip", id, mediaId: mid, srcIn: it.srcIn, srcOut: it.srcOut, enabled: typeof it.enabled === "boolean" ? it.enabled : true, audio: sanitizeClipAudio(it.audio, r, id) };
  if (typeof it.label === "string") clip.label = it.label;
  copyUnknown(it, CLIP_KEYS, clip, r, "sequence.extra");
  return clip as unknown as VideoClipV2;
}

/** V1：壞項目丟；片段原音的淡化 / 自動化依片段在序列上的樣本長度修正。 */
function sanitizeVideoItems(rawVideo: readonly unknown[], facts: ReadonlyMap<string, MediaFacts>, frame: SeqFrame, r: SanitizeReport): VideoItemV2[] {
  const video: VideoItemV2[] = [];
  const mismatchWarned = new Set<string>();
  for (const raw of rawVideo) {
    const it = rec(raw);
    const id = typeof it?.id === "string" ? it.id : "";
    let item: VideoItemV2 | null = null;
    if (it?.kind === "gap" && int(it.length) && it.length >= 1) {
      const gap: Record<string, unknown> = { kind: "gap", id, length: it.length };
      copyUnknown(it, GAP_KEYS, gap, r, "sequence.extra");
      item = gap as unknown as VideoItemV2;
    } else if (it?.kind === "clip") item = sanitizeVideoClip(it, id, facts, frame, mismatchWarned, r);
    if (item) video.push(item);
    else drop(r, "sequence.video");
  }
  // 原音淡化的上限是片段在序列上的樣本長度 S(t1) − S(t0)：29.97 fps 時跟位置有關，所以等位置排好才修
  let t = 0;
  for (const it of video) {
    const len = it.kind === "clip" ? it.srcOut - it.srcIn : it.length;
    if (it.kind === "clip") fixGainForLength(it.audio, samplesOfFrame(t + len, frame.fps) - samplesOfFrame(t, frame.fps), r, it.id);
    t += len;
  }
  return video;
}

/** A0 原音匯流排與序列層音訊設定（`original` / `audio`）：缺或壞就用預設，未知鍵保留。 */
function sanitizeSeqAudioSettings(o: Record<string, unknown>, r: SanitizeReport): { original: SequenceV2["original"]; audio: SequenceV2["audio"] } {
  const oo = rec(o.original) ?? {};
  if (oo.gainDb != null && oo.gainDb !== clampDb(oo.gainDb)) warn(r, "sequence.gain", "A0");
  const original: Record<string, unknown> = { muted: typeof oo.muted === "boolean" ? oo.muted : false, gainDb: clampDb(oo.gainDb) };
  copyUnknown(oo, ["muted", "gainDb"], original, r, "sequence.extra");
  const ao = rec(o.audio) ?? {};
  let edgeDeclickMs = DEFAULT_EDGE_DECLICK_MS;
  if (ao.edgeDeclickMs != null) {
    if (fin(ao.edgeDeclickMs) && ao.edgeDeclickMs >= 0) edgeDeclickMs = ao.edgeDeclickMs;
    else warn(r, "sequence.edgeDeclick");
  }
  const audio: Record<string, unknown> = { edgeDeclickMs, limiter: typeof ao.limiter === "boolean" ? ao.limiter : false };
  copyUnknown(ao, ["edgeDeclickMs", "limiter"], audio, r, "sequence.extra");
  return { original: original as unknown as SequenceV2["original"], audio: audio as unknown as SequenceV2["audio"] };
}

/** 一條軌的片段：丟壞的、依 start 穩定排序、跟前一個重疊的丟（I6：同軌不重疊；丟後者，前面那段是使用者先放的）。 */
function sanitizeLaneClips(v: unknown, facts: ReadonlyMap<string, MediaFacts>, amById: ReadonlyMap<string, AudioMediaV2>, r: SanitizeReport): AudioClipV2[] {
  const cand: AudioClipV2[] = [];
  for (const c of Array.isArray(v) ? v : []) {
    const clip = sanitizeAudioClip(c, facts, amById, r);
    if (clip) cand.push(clip);
  }
  cand.sort((a, b) => a.start - b.start);
  const clips: AudioClipV2[] = [];
  for (const c of cand) {
    const prev = clips[clips.length - 1];
    if (prev && prev.start + prev.length > c.start) {
      drop(r, "sequence.overlap");
      continue;
    }
    clips.push(c);
  }
  return clips;
}

function sanitizeLanes(v: unknown, facts: ReadonlyMap<string, MediaFacts>, audioMedia: readonly AudioMediaV2[], r: SanitizeReport): AudioLaneV2[] {
  if (v != null && !Array.isArray(v)) drop(r, "sequence.audioLanes");
  const rawLanes: unknown[] = Array.isArray(v) ? v : [];
  const amById = new Map(audioMedia.map((a) => [a.id, a]));
  const rawLaneIds = rawLanes.map((x) => rec(x)?.id).filter((x): x is string => typeof x === "string");
  const laneIds = new Set<string>();
  const lanes: AudioLaneV2[] = [];
  for (const raw of rawLanes) {
    const lo = rec(raw);
    if (!lo) {
      drop(r, "sequence.audioLanes");
      continue;
    }
    let lid = str(lo.id) ? lo.id : "";
    if (!lid || laneIds.has(lid)) {
      lid = uniqueId("lane", new Set([...laneIds, ...rawLaneIds]));
      warn(r, "sequence.laneId", lid);
    }
    laneIds.add(lid);
    if (lo.role != null && !isAudioRole(lo.role)) warn(r, "sequence.role", lid);
    if (lo.gainDb != null && lo.gainDb !== clampDb(lo.gainDb)) warn(r, "sequence.gain", lid);
    const role = isAudioRole(lo.role) ? lo.role : "other";
    const lane: Record<string, unknown> = {
      id: lid,
      name: typeof lo.name === "string" ? lo.name : `A${lanes.length + 1}`,
      role,
      muted: typeof lo.muted === "boolean" ? lo.muted : false,
      locked: typeof lo.locked === "boolean" ? lo.locked : false,
      // 沒寫就依角色：音樂軌預設不跟 V1 波紋（§0.1 Q3）
      syncLock: typeof lo.syncLock === "boolean" ? lo.syncLock : defaultSyncLock(role),
      gainDb: clampDb(lo.gainDb),
      clips: sanitizeLaneClips(lo.clips, facts, amById, r),
    };
    copyUnknown(lo, LANE_KEYS, lane, r, "sequence.extra");
    lanes.push(lane as unknown as AudioLaneV2);
  }
  return lanes;
}

/** 序列內所有片段 id（V1＋所有軌）唯一：缺少或重複的依出現順序重新發號（`c1` → `c1-2`；缺 id 用 clip / gap / aclip 當底）。 */
function renumberSequenceIds(video: VideoItemV2[], lanes: AudioLaneV2[], r: SanitizeReport): void {
  const original = new Set<string>([...video.map((x) => x.id), ...lanes.flatMap((l) => l.clips.map((c) => c.id))].filter(Boolean));
  const taken = new Set<string>();
  const fix = (x: { id: string }, base: string) => {
    if (x.id && !taken.has(x.id)) {
      taken.add(x.id);
      return;
    }
    x.id = uniqueId(x.id || base, new Set([...taken, ...original]));
    warn(r, "sequence.id", x.id);
    taken.add(x.id);
  };
  for (const it of video) fix(it, it.kind === "gap" ? "gap" : "clip");
  for (const l of lanes) for (const c of l.clips) fix(c, "aclip");
}

/** 分離參照：detachedTo 懸空 → 清掉並恢復原音；指得到卻仍啟用原音 → 靜音（不然兩份疊在一起）；detachedFrom 懸空 → 清掉。 */
function fixDetachedRefs(video: VideoItemV2[], lanes: AudioLaneV2[], r: SanitizeReport): void {
  const audioIds = new Set(lanes.flatMap((l) => l.clips.map((c) => c.id)));
  const videoClipIds = new Set(video.filter((x): x is VideoClipV2 => x.kind === "clip").map((x) => x.id));
  for (const it of video) {
    if (it.kind !== "clip" || it.audio.detachedTo === undefined) continue;
    if (!audioIds.has(it.audio.detachedTo)) {
      delete it.audio.detachedTo;
      it.audio.enabled = true;
      warn(r, "sequence.detachedTo", it.id);
    } else if (it.audio.enabled) {
      it.audio.enabled = false;
      warn(r, "sequence.detachedTo", it.id);
    }
  }
  for (const l of lanes) {
    for (const c of l.clips) {
      if (c.detachedFrom !== undefined && !videoClipIds.has(c.detachedFrom)) {
        delete c.detachedFrom;
        warn(r, "sequence.detachedFrom", c.id);
      }
    }
  }
}

/**
 * `sequence`：null / 缺 = 隱含序列（§4.1）。整條只有在「連 fps 都推不出來」時才丟（變回隱含序列並回報）。
 * facts / audioMedia 必須是已經 sanitize 過的：片段的「來源存在」以它們為準。
 */
/** 標記：t 必須是非負整數，否則整筆丟掉（一個位置不明的記號沒有意義）；id 重複或缺就重發；依 t 排序。 */
function sanitizeMarkers(v: unknown, r: SanitizeReport): MarkerV2[] {
  if (v == null) return [];
  if (!Array.isArray(v)) {
    drop(r, "sequence.markers");
    return [];
  }
  const out: MarkerV2[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    const o = rec(raw);
    if (!o || !int(o.t) || (o.t as number) < 0) {
      drop(r, "sequence.markers");
      continue;
    }
    const want = str(o.id) ? (o.id as string) : "";
    const id = want && !seen.has(want) ? want : `mk-${out.length + 1}`;
    seen.add(id);
    out.push({ id, t: o.t as number, name: typeof o.name === "string" ? o.name : "" });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

export function sanitizeSequence(v: unknown, facts: ReadonlyMap<string, MediaFacts>, audioMedia: readonly AudioMediaV2[], r: SanitizeReport): SequenceV2 | null {
  if (v == null) return null;
  const o = rec(v);
  if (o && o.video != null && !Array.isArray(o.video)) drop(r, "sequence.video");
  const rawVideo: unknown[] = Array.isArray(o?.video) ? o.video : [];
  const fps = o ? sequenceFps(o, rawVideo, facts, r) : null;
  if (!o || !fps) {
    drop(r, "sequence");
    return null;
  }
  const sized = int(o.width) && int(o.height) && o.width > 0 && o.height > 0;
  if (!sized) warn(r, "sequence.size");
  if (o.sampleRate !== SEQ_SAMPLE_RATE) warn(r, "sequence.sampleRate");
  const frame: SeqFrame = { fps, width: sized ? (o.width as number) : 0, height: sized ? (o.height as number) : 0 };

  const video = sanitizeVideoItems(rawVideo, facts, frame, r);
  const { original, audio } = sanitizeSeqAudioSettings(o, r);
  const audioLanes = sanitizeLanes(o.audioLanes, facts, audioMedia, r);
  // 先發號再查參照：重複 id 的片段被改名後，參照查的是改名後的結果（同 Python 的順序）
  renumberSequenceIds(video, audioLanes, r);
  fixDetachedRefs(video, audioLanes, r);

  const seq: Record<string, unknown> = { id: str(o.id) ? o.id : "seq-1", name: typeof o.name === "string" ? o.name : "", fps, width: frame.width, height: frame.height, sampleRate: SEQ_SAMPLE_RATE, video, original, audioLanes, audio };
  const markers = sanitizeMarkers(o.markers, r);
  // 空的不寫：既有專案檔的位元組不能因為多了這個功能就變（黃金檔與 Python 共用）
  if (markers.length) seq.markers = markers;
  copyUnknown(o, SEQ_KEYS, seq, r, "sequence.extra");
  return seq as unknown as SequenceV2;
}

export interface ParsedProject {
  file: ProjectFileV2;
  report: SanitizeReport;
}

/**
 * 已經 migrate 過的 doc → ProjectFileV2 + 報告。
 * 接受 schemaVersion 1 與 2：App 在沒剪輯時寫的就是 v1（最低版本寫檔，§4.3），引擎與測試會直接把它丟進來；
 * v1 檔沒有 sequence / audioMedia 鍵，讀成 null / []（= 隱含序列）。< 1 表示沒 migrate、> 2 是未來版本，都擲錯。
 * 每個媒體的 frames 取自它的 proxy（沒有 proxy 就不驗上限）。
 */
export function parseProjectFile(doc: unknown): ParsedProject {
  if (!isRecord(doc)) throw new ProjectFormatError("專案檔不是 JSON 物件");
  const ver = doc.schemaVersion;
  if (!int(ver) || ver < 1) throw new ProjectFormatError(`專案檔版本 ${String(ver)} 尚未升版到 ${SCHEMA_VERSION}（先 migrate）`);
  if (ver > SCHEMA_VERSION) throw new ProjectFormatError(`這個專案檔是較新版本的 App 存的（v${ver}），本版只認得到 v${SCHEMA_VERSION}，請更新 AI Video Cut。`);
  const r = emptyReport();
  // frames 不從 media[].proxy 拿：引擎寫的檔 proxy 沒有 path → proxy 是 null，但幀數上限仍然要驗
  const { media, frames: framesOf, facts } = sanitizeMediaWithFrames(doc.media, r);
  const shotsIn = rec(doc.shots) ?? {};
  const tracksIn = rec(doc.tracks) ?? {};
  // 外掛登記的頂層鍵（沒有外掛 = 空的，那些鍵留給 project extras 原樣保留）
  const topKeys = pluginTopLevelKeys();
  const mediaKeys = topKeys.filter((k) => k.scope === "media");
  const mediaKeysIn = mediaKeys.map((k) => rec(doc[k.key]) ?? {});
  const plugin = emptyPluginData();
  const shots: Record<string, ShotV1[]> = {};
  const tracks: Record<string, TrackV1[]> = {};
  for (const m of media) {
    const frames = framesOf.get(m.id) ?? null;
    shots[m.id] = sanitizeShots(shotsIn[m.id], frames, r);
    tracks[m.id] = sanitizeTracks(tracksIn[m.id], frames, new Set(shots[m.id].map((s) => s.id)), r);
    // 每支媒體一份的外掛鍵（例如 cardSlots）：跟鏡頭 / track 同一個迴圈，回報的順序跟以前一樣
    if (mediaKeys.length) {
      const st: Record<string, unknown> = {};
      mediaKeys.forEach((k, i) => {
        st[k.key] = k.sanitize(mediaKeysIn[i][m.id], r);
      });
      plugin.media[m.id] = st;
    }
  }
  // 指到不存在媒體的段落整包丟
  for (const k of Object.keys(shotsIn)) if (!framesOf.has(k)) drop(r, "orphanMedia");
  const now = new Date().toISOString();
  const activeMediaId = typeof doc.activeMediaId === "string" && framesOf.has(doc.activeMediaId) ? doc.activeMediaId : media[0]?.id ?? null;
  const app = rec(doc.app);
  const captions = sanitizeCaptions(doc.captions, framesOf, r);
  // 版本無關地讀 v2 鍵：migrate 的 toV2 會原樣留下已存在的 sequence / audioMedia，直接 parse v1 檔時也要得到同一個結果
  const audioMedia = sanitizeAudioMedia(doc.audioMedia, r);
  const sequence = sanitizeSequence(doc.sequence, facts, audioMedia, r);
  // 專案層的外掛鍵（例如 deck）：在 insertDefaults 之前驗，回報的順序跟以前一樣
  const project: Record<string, unknown> = {};
  for (const k of topKeys) if (k.scope === "project") project[k.key] = k.sanitize(doc[k.key], r);
  plugin.project = project;
  const insertDefaults = sanitizeInsertDefaults(doc.insertDefaults, r);
  const exportDefaults = sanitizeExportDefaults(doc.exportDefaults, r);
  return {
    file: {
      // 「存回去會寫的版本」：序列整條壞掉被丟成 null、也沒有音訊媒體時就是 1（§4.3）
      schemaVersion: writtenSchemaVersion(sequence, audioMedia),
      app: { name: String(app?.name ?? ""), version: String(app?.version ?? "") },
      createdAt: typeof doc.createdAt === "string" ? doc.createdAt : now,
      updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : now,
      media,
      activeMediaId,
      profile: sanitizeProfile(doc.profile),
      shots,
      tracks,
      insertDefaults,
      exportDefaults,
      // 沒有字幕就不長出這個鍵（跟寫檔同一個規則：舊檔讀進來再存回去不多東西）
      ...(Object.keys(captions).length ? { captions } : {}),
      sequence,
      audioMedia,
      plugin,
    },
    report: r,
  };
}

/** 給 toast 用的一句話（"已略過 3 筆壞掉的資料（keyframes 2、prompts 1）"）。 */
export function reportSummary(r: SanitizeReport): string | null {
  if (!r.total) return null;
  const parts = Object.entries(r.dropped)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join("、");
  return `${r.total}|${parts}`;
}
