import { AudioLines, Eraser, FolderSearch, Info, ListPlus, Lock, Music, Settings2, SlidersHorizontal, Split, Trash2, TrendingDown, TrendingUp, Unlink, Volume2, VolumeX, WavesHorizontal } from "lucide-react";
import { create } from "zustand";
import { api } from "../api";
import { envPointOf, deleteEnvelopePoint, useEnvPointSelection } from "../frametimeline/gainDrag";
import { t } from "../i18n";
import { setRailTab } from "../inspector/_contracts";
import { AUDIO_EXTENSIONS, importAudioFiles } from "../pipeline/audio";
import { SEQ_SAMPLE_RATE, type AudioClipV2, type AudioLaneV2, type AudioRole, type FadeCurve, type SequenceV2, type VideoClipV2 } from "../project/format";
import { applyDefaultFades, clearAutomation, detachAudio, duckRange, moveToNewLane, muteRange, removeLane, setFades, setGain, setLane, setOriginalAudioEnabled } from "../sequence/audioOps";
import { makeSeqCtx } from "../sequence/context";
import { placeVideo } from "../sequence/map";
import { setEnabled } from "../sequence/ops";
import { openDialog } from "../store/dialogs";
import { SEQ_EDIT_LABEL, useEdits } from "../store/edits";
import { useProject } from "../store/project";
import { sequenceEditingEnabled, useSettings } from "../store/settings";
import { useTimeline } from "../store/timeline";
import { pickOpenFiles, toast, uiPrompt } from "../ui";
import { OK, bumpCommandTick, registerCommands } from "./registry";
import { ENVELOPE_POINT_DELETE_COMMAND, needsClipSelection, needsSequenceSpace, seekSequenceNow, selectedClipIdsIn, viewSequenceNow } from "./sequenceCommands";
import type { Command, Enabled, Surface } from "./types";
import { withUndoToast } from "./undoToast";

/**
 * 音訊片段編輯指令（docs/editor-m2-design.md §10.2 音訊那幾列、§11 片段 / 音訊片段 / 音軌右鍵、§13 M2.15）：
 * 分離音訊（Ctrl+Alt+L）、靜音原音 / 片段、增益 ▸、淡入 ▸、淡出 ▸、淡化曲線 ▸、套用預設淡入淡出（Ctrl+Shift+D）、
 * 清除音量自動化、範圍內閃避 / 靜音、刪除自動化點（Delete 派發的目標）、移到新音軌、在檔案總管中顯示、跳到來源片段、
 * 片段資訊…、序列設定…，以及音軌右鍵（靜音軌、同步鎖、角色 ▸、刪除音軌、在這裡加入音訊…）。
 *
 * 為什麼獨立一個檔、不併進 sequenceCommands.ts：M2.15 跟同一波的其他群組（預覽播放、proxy）平行開發，
 * sequenceCommands 是那邊也可能動到的檔；menuModel.ts 已經依 id 列這些指令（CLIP_ORIGINAL_AUDIO_IDS、RANGE_SEQUENCE_AUDIO_OPS），
 * 所以這裡登記了，選單就自動長出來。
 *
 * 對象一律是「時間軸的片段選取」（右鍵會先選取點到的片段，§11）：V1 片段 = 它的原音、音訊片段 = 它自己。
 * 旗標（settings.experimental.sequence）關：不在任何表面、沒有鍵，跟 sequenceCommands 同一套 gate。
 * 每一條的 title / why 是 zh key（本目錄在 check-i18n 的 TABLE_SOURCES）。
 */

const L = SEQ_EDIT_LABEL;
const SECTION = "音訊";
const SURFACES: Surface[] = ["menu", "palette", "context"];
const CTX_ONLY: Surface[] = ["context"];

/** SEQ_EDIT_LABEL 沒有的 undo 標籤（留在本檔：commands/ 在 i18n 稽核的標籤表範圍內）。 */
export const AUDIO_EDIT_LABEL = {
  muteOriginal: "靜音原音",
  unmuteOriginal: "取消靜音原音",
  muteClip: "靜音片段",
  unmuteClip: "取消靜音片段",
  applyFades: "套用預設淡入淡出",
  deletePoint: "刪除自動化點",
  laneRole: "音軌角色",
  sequenceSettings: "序列設定",
} as const;

export const NO_GAIN_TARGET_WHY = "選取的片段沒有可以調整的聲音（空白、已分離的原音或鎖定音軌上的片段）";
export const NO_RANGE_WHY = "先按 I／O 或拖出範圍";
export const LANE_CONTEXT_WHY = "在音軌上按右鍵";

// ============================================================================
// 本機偏好：預設淡化長度（序列設定對話框可改；不進專案檔 —— 那是「我習慣怎麼剪」，不是這支片的內容）
// ============================================================================

const PREFS_KEY = "aivc:audioPrefs";
/** Premiere 預設音訊轉場的常見設定 0.5 s。 */
export const DEFAULT_FADE_SECONDS = 0.5;

export function parseAudioPrefs(raw: string | null): { defaultFadeSeconds: number } {
  try {
    const v = raw ? (JSON.parse(raw) as { defaultFadeSeconds?: unknown }) : null;
    const s = typeof v?.defaultFadeSeconds === "number" && Number.isFinite(v.defaultFadeSeconds) ? v.defaultFadeSeconds : DEFAULT_FADE_SECONDS;
    return { defaultFadeSeconds: Math.max(0, Math.min(60, s)) };
  } catch {
    return { defaultFadeSeconds: DEFAULT_FADE_SECONDS };
  }
}

function loadPrefs() {
  try {
    return parseAudioPrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return parseAudioPrefs(null);
  }
}

interface AudioPrefsStore {
  defaultFadeSeconds: number;
  setDefaultFadeSeconds: (s: number) => void;
}

export const useAudioPrefs = create<AudioPrefsStore>((set) => ({
  ...loadPrefs(),
  setDefaultFadeSeconds: (s) => {
    const next = parseAudioPrefs(JSON.stringify({ defaultFadeSeconds: s }));
    set(next);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      /* 私密視窗 / 沒有 localStorage：只影響這次 session */
    }
  },
}));

export function defaultFadeSamples(): number {
  return Math.round(useAudioPrefs.getState().defaultFadeSeconds * SEQ_SAMPLE_RATE);
}

// ============================================================================
// 選取 → 對象
// ============================================================================

export interface AudioSelection {
  /** 選取裡的 V1 片段（含已分離、已靜音原音的）。 */
  v1: VideoClipV2[];
  /** 選取裡的音訊片段與它所在的音軌。 */
  audio: { clip: AudioClipV2; lane: AudioLaneV2 }[];
  /** 可以調增益 / 淡化 / 自動化的片段 id：未分離的 V1 原音、未鎖定音軌上的音訊片段。 */
  gainIds: string[];
}

export function audioSelectionOf(seq: SequenceV2 | null, selected: readonly string[]): AudioSelection {
  const out: AudioSelection = { v1: [], audio: [], gainIds: [] };
  if (!seq) return out;
  const sel = new Set(selected);
  for (const it of seq.video) {
    if (it.kind !== "clip" || !sel.has(it.id)) continue;
    out.v1.push(it);
    if (it.audio.detachedTo === undefined) out.gainIds.push(it.id);
  }
  for (const lane of seq.audioLanes) {
    for (const c of lane.clips) {
      if (!sel.has(c.id)) continue;
      out.audio.push({ clip: c, lane });
      if (!lane.locked) out.gainIds.push(c.id);
    }
  }
  return out;
}

function selectionNow(): AudioSelection {
  const seq = viewSequenceNow();
  return audioSelectionOf(seq, selectedClipIdsIn(seq));
}

/** 選取片段的增益參數（V1 = 原音；只算 gainIds 裡的）。 */
function gainsOf(s: AudioSelection) {
  const ids = new Set(s.gainIds);
  return [...s.v1.filter((c) => ids.has(c.id)).map((c) => c.audio), ...s.audio.filter((a) => ids.has(a.clip.id)).map((a) => a.clip)];
}

function ctxNow() {
  return makeSeqCtx(useProject.getState().media, useEdits.getState().audioMedia);
}

function all(...fs: (() => Enabled)[]): () => Enabled {
  return () => {
    for (const f of fs) {
      const r = f();
      if (!r.ok) return r;
    }
    return OK;
  };
}

function needsGainTargets(): Enabled {
  const s = needsClipSelection();
  if (!s.ok) return s;
  return selectionNow().gainIds.length ? OK : { ok: false, why: NO_GAIN_TARGET_WHY };
}

/** 走 editSequence 並把擲出來的 SequenceError 變成 toast（鎖定、找不到來源…），回傳有沒有留下一筆 undo。 */
function edit(label: string, f: (seq: SequenceV2) => SequenceV2 | null): boolean {
  try {
    return useEdits.getState().editSequence(label, (seq) => f(seq));
  } catch (e) {
    toast.error(t("無法修改序列：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
    return false;
  }
}

// ============================================================================
// 分離音訊（Ctrl+Alt+L）
// ============================================================================

/** 可以分離的 V1 片段：原音開著、還沒分離、媒體已經有音訊時間資訊（media.audio_info）。 */
export function detachableIds(seq: SequenceV2 | null, selected: readonly string[], hasAudioInfo: (mediaId: string) => boolean): { ids: string[]; why: string | null } {
  const s = audioSelectionOf(seq, selected);
  const candidates = s.v1.filter((c) => c.audio.enabled && c.audio.detachedTo === undefined);
  if (!candidates.length) return { ids: [], why: "選取的片段沒有可以分離的原音（已分離或已靜音）" };
  const ready = candidates.filter((c) => hasAudioInfo(c.mediaId));
  if (!ready.length) return { ids: [], why: "還在分析原音的時間資訊，稍後再試" };
  return { ids: ready.map((c) => c.id), why: null };
}

function detachPlanNow() {
  const seq = viewSequenceNow();
  const ctx = ctxNow();
  return detachableIds(seq, selectedClipIdsIn(seq), (id) => !!ctx.media(id)?.audio);
}

function needsDetach(): Enabled {
  const s = needsClipSelection();
  if (!s.ok) return s;
  const p = detachPlanNow();
  return p.why ? { ok: false, why: p.why } : OK;
}

function runDetach(): void {
  const { ids } = detachPlanNow();
  if (!ids.length) return;
  void withUndoToast(t("已分離 {n} 個片段的音訊", { n: ids.length }), () => {
    try {
      useEdits.getState().editSequence(L.detachAudio, (seq, ctx) => ids.reduce((acc, id) => detachAudio(acc, id, ctx), seq));
    } catch (e) {
      toast.error(t("無法修改序列：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
    }
  });
}

// ============================================================================
// 靜音
// ============================================================================

function originalMuteState(): { ids: string[]; allMuted: boolean } {
  const s = selectionNow();
  const clips = s.v1.filter((c) => c.audio.detachedTo === undefined);
  return { ids: clips.map((c) => c.id), allMuted: clips.length > 0 && clips.every((c) => !c.audio.enabled) };
}

function clipMuteState(): { ids: string[]; allMuted: boolean } {
  const s = selectionNow();
  const clips = s.audio.filter((a) => !a.lane.locked);
  return { ids: clips.map((a) => a.clip.id), allMuted: clips.length > 0 && clips.every((a) => !a.clip.enabled) };
}

// ============================================================================
// 增益 / 淡化 / 曲線（子選單）
// ============================================================================

export const GAIN_PRESETS_DB = [3, 0, -3, -6, -12] as const;
export const FADE_PRESETS_S = [0, 0.5, 1, 2] as const;

/** 「−3 dB」這種寫法（負號用 U+2212，跟時間軸上的增益標籤一致）。 */
export function signedDb(db: number): string {
  return `${db > 0 ? "+" : db < 0 ? "−" : ""}${Math.abs(db)}`;
}

/** 使用者輸入的 dB（接受 −、-、＋、全形數字前的空白、尾端 dB）；看不懂回 null。 */
export function parseDbInput(raw: string): number | null {
  const s = raw.trim().replace(/[−–—－]/g, "-").replace(/＋/g, "+").replace(/\s*db$/i, "");
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function gainPresetCommands(): Command[] {
  const presets: Command[] = GAIN_PRESETS_DB.map((db) => ({
    id: `audio.gain.${db}`,
    title: "{db} dB",
    titleParams: { db: signedDb(db) },
    group: "edit",
    icon: Volume2,
    surfaces: CTX_ONLY,
    checked: () => {
      const g = gainsOf(selectionNow());
      return g.length > 0 && g.every((x) => x.gainDb === db);
    },
    enabled: needsGainTargets,
    run: () => void edit(L.gain, (seq) => setGain(seq, selectionNow().gainIds, db)),
  }));
  presets.push({
    id: "audio.gain.custom",
    title: "自訂…",
    group: "edit",
    icon: SlidersHorizontal,
    surfaces: CTX_ONLY,
    enabled: needsGainTargets,
    run: async () => {
      const cur = gainsOf(selectionNow())[0]?.gainDb ?? 0;
      const raw = await uiPrompt(t("增益（dB，−96～+12）"), { title: t("片段增益"), defaultValue: String(cur) });
      if (raw == null) return;
      const db = parseDbInput(raw);
      if (db === null) {
        toast.error(t("看不懂「{v}」：請輸入 −96 到 +12 之間的數字", { v: raw }));
        return;
      }
      edit(L.gain, (seq) => setGain(seq, selectionNow().gainIds, db));
    },
  });
  return presets;
}

function fadePresetCommands(which: "fadeIn" | "fadeOut"): Command[] {
  return FADE_PRESETS_S.map((s) => {
    const samples = Math.round(s * SEQ_SAMPLE_RATE);
    return {
      id: `audio.${which}.${s}`,
      title: s === 0 ? "無" : "{s} 秒",
      titleParams: s === 0 ? undefined : { s },
      group: "edit",
      surfaces: CTX_ONLY,
      checked: () => {
        const g = gainsOf(selectionNow());
        return g.length > 0 && g.every((x) => x[which] === samples);
      },
      enabled: needsGainTargets,
      run: () => void edit(which === "fadeIn" ? L.fadeIn : L.fadeOut, (seq) => setFades(seq, selectionNow().gainIds, { [which]: samples })),
    } satisfies Command;
  });
}

const CURVE_LABEL: Record<FadeCurve, string> = { linear: "線性", equalPower: "等功率" };

function curveCommands(): Command[] {
  return (Object.keys(CURVE_LABEL) as FadeCurve[]).map((curve) => ({
    id: `audio.fadeCurve.${curve}`,
    title: CURVE_LABEL[curve],
    group: "edit",
    surfaces: CTX_ONLY,
    checked: () => {
      const g = gainsOf(selectionNow());
      return g.length > 0 && g.every((x) => x.fadeCurve === curve);
    },
    enabled: needsGainTargets,
    run: () => void edit(L.fadeCurve, (seq) => setFades(seq, selectionNow().gainIds, { fadeCurve: curve })),
  }));
}

// ============================================================================
// 範圍內閃避 / 靜音
// ============================================================================

/** 閃避的深度與斜坡：−10 dB、前後 0.25 s（設計 §7.4 的例子）。 */
export const DUCK_DB = -10;
export const DUCK_RAMP_SAMPLES = 12_000;

export type LaneSel = "A0" | string[];

/**
 * 「在範圍內閃避 / 靜音」作用在哪幾條：選取裡有音訊片段 → 它們的音軌；選取裡有 V1 片段 → A0 原音；
 * 什麼都沒選 → 閃避預設對音樂軌（墊樂最常被閃避）、靜音預設對原音（§11 範圍選單的兩項）。
 */
export function rangeAudioTargets(seq: SequenceV2, selected: readonly string[], kind: "duck" | "mute"): LaneSel {
  const s = audioSelectionOf(seq, selected);
  if (s.audio.length) return [...new Set(s.audio.map((a) => a.lane.id))];
  if (s.v1.length) return "A0";
  return kind === "duck" ? musicLaneIds(seq) : "A0";
}

export function musicLaneIds(seq: SequenceV2): string[] {
  return seq.audioLanes.filter((l) => l.role === "music" && !l.locked).map((l) => l.id);
}

function rangeNow(): { in: number; out: number } | null {
  return useTimeline.getState().range;
}

/** 範圍內的閃避 / 靜音計畫：做了會變的序列；沒東西可做時回原因。 */
function rangePlan(kind: "duck" | "mute", sel: (seq: SequenceV2) => LaneSel): { seq: SequenceV2; laneSel: LaneSel; range: { in: number; out: number } } | { why: string } {
  const s = needsSequenceSpace();
  if (!s.ok) return { why: s.why };
  const r = rangeNow();
  if (!r) return { why: NO_RANGE_WHY };
  const seq = viewSequenceNow()!;
  const laneSel = sel(seq);
  if (Array.isArray(laneSel) && !laneSel.length) return { why: "沒有音樂軌：先選要閃避的音訊片段" };
  const next = kind === "duck" ? duckRange(seq, laneSel, r, DUCK_DB, DUCK_RAMP_SAMPLES) : muteRange(seq, laneSel, r);
  if (next === seq) return { why: kind === "duck" ? "範圍內沒有可以閃避的音訊片段" : "範圍內沒有可以靜音的音訊片段" };
  return { seq: next, laneSel, range: r };
}

function rangeCommand(id: string, title: string, kind: "duck" | "mute", sel: (seq: SequenceV2) => LaneSel, keywords: string[], on: boolean, surfaces: Surface[]): Command {
  return {
    id,
    title,
    group: "edit",
    section: SECTION,
    icon: kind === "duck" ? TrendingDown : VolumeX,
    ...gate(on, surfaces),
    keywords,
    enabled: () => {
      const p = rangePlan(kind, sel);
      return "why" in p ? { ok: false, why: p.why } : OK;
    },
    run: () => {
      const p = rangePlan(kind, sel);
      if ("why" in p) return;
      const label = kind === "duck" ? L.duckRange : L.muteRange;
      edit(label, (seq) => (kind === "duck" ? duckRange(seq, p.laneSel, p.range, DUCK_DB, DUCK_RAMP_SAMPLES) : muteRange(seq, p.laneSel, p.range)));
    },
  };
}

// ============================================================================
// 自動化點（Delete 派發的目標）
// ============================================================================

function needsEnvPoint(): Enabled {
  const s = needsSequenceSpace();
  if (!s.ok) return s;
  if (useTimeline.getState().focus !== "envPoint") return { ok: false, why: "先 Alt+點音量線新增，或點選一個自動化點" };
  const hit = envPointOf(viewSequenceNow(), useEnvPointSelection.getState().sel);
  if (!hit) return { ok: false, why: "選取的自動化點已經不在了" };
  return hit.clip.locked ? { ok: false, why: "音軌已鎖定" } : OK;
}

function runDeleteEnvPoint(): void {
  const sel = useEnvPointSelection.getState().sel;
  if (!sel) return;
  if (edit(AUDIO_EDIT_LABEL.deletePoint, (seq) => deleteEnvelopePoint(seq, sel))) {
    useEnvPointSelection.getState().select(null);
    const tl = useTimeline.getState();
    tl.setFocus(tl.selectedClipIds.length ? "clip" : null);
  }
}

// ============================================================================
// 單一音訊片段
// ============================================================================

function singleAudio(): { clip: AudioClipV2; lane: AudioLaneV2 } | null {
  const s = selectionNow();
  return s.audio.length === 1 ? s.audio[0] : null;
}

function needsSingleAudio(): Enabled {
  const s = needsClipSelection();
  if (!s.ok) return s;
  return singleAudio() ? OK : { ok: false, why: "先選一個音訊片段" };
}

/** 音訊片段的來源檔路徑（分離的原音 = 影片檔、音樂 = 音訊檔）。 */
export function audioSourcePath(clip: AudioClipV2): string | null {
  const src = clip.source;
  if (src.type === "media") return useProject.getState().media.find((m) => m.id === src.mediaId)?.path ?? null;
  return useEdits.getState().audioMedia.find((a) => a.id === src.audioId)?.path ?? null;
}

function jumpToSourceClip(): void {
  const a = singleAudio();
  const seq = viewSequenceNow();
  const from = a?.clip.detachedFrom;
  if (!seq || !from) return;
  const p = placeVideo(seq).find((x) => x.item.id === from);
  if (!p) return;
  useTimeline.getState().selectClips([from]);
  seekSequenceNow(p.t0);
}

/** 片段資訊…（§11 最後一項、音訊片段雙擊）：切到 Inspector「片段」頁並展開側欄。 */
export function openClipInspector(clipId?: string): void {
  if (clipId) {
    const tl = useTimeline.getState();
    if (!tl.selectedClipIds.includes(clipId)) tl.selectClips([clipId]);
  }
  setRailTab("clip");
}

// ============================================================================
// 音軌右鍵（對象 = 按右鍵的那一條，選單開啟前由 menuModel 設定）
// ============================================================================

export interface AudioMenuContext {
  laneId: string;
  /** 右鍵點到的序列幀（「在這裡加入音訊…」放的位置）。 */
  frame: number;
}

let laneContext: AudioMenuContext | null = null;

/** menuModel 在打開音軌右鍵前呼叫（選單項目是註冊表指令，指令本身不知道點在哪一條）。 */
export function setAudioMenuContext(ctx: AudioMenuContext | null): void {
  laneContext = ctx;
}

function contextLane(): AudioLaneV2 | null {
  const seq = viewSequenceNow();
  return laneContext && seq ? seq.audioLanes.find((l) => l.id === laneContext!.laneId) ?? null : null;
}

function needsLaneContext(): Enabled {
  const s = needsSequenceSpace();
  if (!s.ok) return s;
  return contextLane() ? OK : { ok: false, why: LANE_CONTEXT_WHY };
}

const ROLE_LABEL: Record<AudioRole, string> = { music: "音樂", voiceover: "旁白", sfx: "音效", other: "其他" };

function laneRoleCommands(): Command[] {
  return (Object.keys(ROLE_LABEL) as AudioRole[]).map((role) => ({
    id: `audio.lane.role.${role}`,
    title: ROLE_LABEL[role],
    group: "edit",
    surfaces: CTX_ONLY,
    checked: () => contextLane()?.role === role,
    enabled: needsLaneContext,
    run: () => {
      const lane = contextLane();
      if (lane) edit(AUDIO_EDIT_LABEL.laneRole, (seq) => setLane(seq, lane.id, { role }));
    },
  }));
}

async function addAudioOnContextLane(): Promise<void> {
  const ctx = laneContext;
  const seq = viewSequenceNow();
  if (!ctx || !seq) return;
  const paths = await pickOpenFiles([{ name: t("音訊"), extensions: [...AUDIO_EXTENSIONS] }]);
  if (!paths.length) return;
  await importAudioFiles(paths, { kind: "drop", plan: { frame: ctx.frame, snapped: false, zone: { kind: "lane", laneId: ctx.laneId } }, fps: seq.fps });
}

// ============================================================================
// 指令表
// ============================================================================

function gate(on: boolean, surfaces: Surface[], shortcuts?: string[], manual = false): Pick<Command, "surfaces" | "shortcuts" | "shortcutManual"> {
  return on ? { surfaces, shortcuts, ...(manual ? { shortcutManual: true } : {}) } : { surfaces: [] };
}

/** 片段右鍵「原音 ▸」（V1 片段）列哪些指令（menuModel 依 id 取）。 */
export const CLIP_AUDIO_MENU_IDS = ["audio.toggleOriginalMute", "sequence.detachAudio", "audio.gain", "audio.fadeIn", "audio.fadeOut", "audio.applyDefaultFades", "audio.clearAutomation"];

/** 音訊片段右鍵（§11）接在「分割／刪除／停用」之後的各段。 */
export const AUDIO_CLIP_MENU_GROUPS: string[][] = [
  ["audio.toggleClipMute"],
  ["audio.gain", "audio.fadeIn", "audio.fadeOut", "audio.fadeCurve", "audio.applyDefaultFades"],
  ["audio.duckRange", "audio.muteRange", "audio.clearAutomation"],
  ["audio.moveToNewLane", "audio.revealInExplorer", "audio.jumpToSourceClip"],
  ["audio.clipInfo"],
];

/** 音軌空白處右鍵（§11 audioLaneMenuItems）。 */
export const AUDIO_LANE_MENU_GROUPS: string[][] = [["audio.lane.addHere", "audio.newLane", "audio.lane.delete"], ["audio.lane.mute", "audio.lane.syncLock", "audio.lane.role"]];

/** 範圍右鍵的序列追加（§11「在範圍內閃避所有音樂軌／在範圍內靜音原音」）。 */
export const RANGE_AUDIO_MENU_IDS = ["audio.duckMusicInRange", "audio.muteOriginalInRange"];

export function audioClipCommands(on: boolean = sequenceEditingEnabled()): Command[] {
  const gainKids = gainPresetCommands();
  const fadeInKids = fadePresetCommands("fadeIn");
  const fadeOutKids = fadePresetCommands("fadeOut");
  const curveKids = curveCommands();
  const roleKids = laneRoleCommands();
  return [
    {
      id: "sequence.detachAudio",
      title: "分離音訊",
      group: "edit",
      section: SECTION,
      icon: Unlink,
      ...gate(on, SURFACES, ["Ctrl+Alt+L"]),
      keywords: ["detach audio", "unlink", "split audio", "j cut", "l cut"],
      enabled: needsDetach,
      run: runDetach,
    },
    {
      id: "audio.toggleOriginalMute",
      title: "靜音原音",
      group: "edit",
      section: SECTION,
      icon: VolumeX,
      ...gate(on, ["palette", "context"]),
      keywords: ["mute original audio"],
      checked: () => originalMuteState().allMuted,
      enabled: all(needsClipSelection, () => (originalMuteState().ids.length ? OK : { ok: false, why: "選取的片段沒有原音（空白或已分離）" })),
      run: () => {
        const { ids, allMuted } = originalMuteState();
        edit(allMuted ? AUDIO_EDIT_LABEL.unmuteOriginal : AUDIO_EDIT_LABEL.muteOriginal, (seq) => setOriginalAudioEnabled(seq, ids, allMuted));
      },
    },
    {
      id: "audio.toggleClipMute",
      title: "靜音片段",
      group: "edit",
      section: SECTION,
      icon: VolumeX,
      ...gate(on, SURFACES),
      keywords: ["mute clip"],
      checked: () => clipMuteState().allMuted,
      enabled: all(needsClipSelection, () => (clipMuteState().ids.length ? OK : { ok: false, why: "先選未鎖定音軌上的音訊片段" })),
      run: () => {
        const { ids, allMuted } = clipMuteState();
        edit(allMuted ? AUDIO_EDIT_LABEL.unmuteClip : AUDIO_EDIT_LABEL.muteClip, (seq) => setEnabled(seq, ids, allMuted));
      },
    },
    { id: "audio.gain", title: "增益", group: "edit", section: SECTION, icon: Volume2, ...gate(on, CTX_ONLY), keywords: ["gain", "volume"], enabled: needsGainTargets, children: () => gainKids, run: () => {} },
    { id: "audio.fadeIn", title: "淡入", group: "edit", section: SECTION, icon: TrendingUp, ...gate(on, CTX_ONLY), keywords: ["fade in"], enabled: needsGainTargets, children: () => fadeInKids, run: () => {} },
    { id: "audio.fadeOut", title: "淡出", group: "edit", section: SECTION, icon: TrendingDown, ...gate(on, CTX_ONLY), keywords: ["fade out"], enabled: needsGainTargets, children: () => fadeOutKids, run: () => {} },
    { id: "audio.fadeCurve", title: "淡化曲線", group: "edit", section: SECTION, icon: WavesHorizontal, ...gate(on, CTX_ONLY), keywords: ["fade curve", "equal power"], enabled: needsGainTargets, children: () => curveKids, run: () => {} },
    // 子選單的每一項也登記（測試與 bridge 可以直接跑 audio.gain.-3）；旗標關時一樣不在任何表面
    ...[...gainKids, ...fadeInKids, ...fadeOutKids, ...curveKids].map((c) => ({ ...c, ...gate(on, CTX_ONLY) })),
    {
      id: "audio.applyDefaultFades",
      title: "套用預設淡入淡出",
      group: "edit",
      section: SECTION,
      icon: AudioLines,
      ...gate(on, SURFACES, ["Ctrl+Shift+D"]),
      keywords: ["default audio transition", "fade", "crossfade"],
      enabled: needsGainTargets,
      run: () => {
        const ids = selectionNow().gainIds;
        const n = defaultFadeSamples();
        edit(AUDIO_EDIT_LABEL.applyFades, (seq) => applyDefaultFades(seq, ids, n));
      },
    },
    {
      id: "audio.clearAutomation",
      title: "清除音量自動化",
      group: "edit",
      section: SECTION,
      icon: Eraser,
      ...gate(on, SURFACES),
      keywords: ["clear automation", "keyframes", "rubber band"],
      enabled: all(needsGainTargets, () => (gainsOf(selectionNow()).some((g) => g.envelope.length) ? OK : { ok: false, why: "選取的片段沒有音量自動化" })),
      run: () => void edit(L.clearAutomation, (seq) => clearAutomation(seq, selectionNow().gainIds)),
    },
    rangeCommand("audio.duckRange", "在範圍內閃避（−10 dB）", "duck", (seq) => rangeAudioTargets(seq, selectedClipIdsIn(seq), "duck"), ["duck", "ducking", "lower music"], on, SURFACES),
    rangeCommand("audio.muteRange", "在範圍內靜音", "mute", (seq) => rangeAudioTargets(seq, selectedClipIdsIn(seq), "mute"), ["mute range", "silence"], on, SURFACES),
    rangeCommand("audio.duckMusicInRange", "在範圍內閃避所有音樂軌", "duck", musicLaneIds, ["duck music"], on, ["palette", "context"]),
    rangeCommand("audio.muteOriginalInRange", "在範圍內靜音原音", "mute", () => "A0", ["mute original"], on, ["palette", "context"]),
    {
      id: ENVELOPE_POINT_DELETE_COMMAND,
      title: "刪除自動化點",
      group: "edit",
      section: SECTION,
      icon: Trash2,
      // Delete / Shift+Delete 是 edit.delete 派發過來的（焦點 envPoint）：這裡只顯示鍵
      ...gate(on, ["palette", "context"], ["Delete"], true),
      keywords: ["delete keyframe", "automation point"],
      enabled: needsEnvPoint,
      run: runDeleteEnvPoint,
    },
    {
      id: "audio.moveToNewLane",
      title: "移到新音軌",
      group: "edit",
      section: SECTION,
      icon: ListPlus,
      ...gate(on, ["palette", "context"]),
      keywords: ["move to new track"],
      enabled: all(needsSingleAudio, () => (singleAudio()?.lane.locked ? { ok: false, why: "音軌已鎖定" } : OK)),
      run: () => {
        const a = singleAudio();
        if (a) edit(L.moveAudio, (seq) => moveToNewLane(seq, a.clip.id));
      },
    },
    {
      id: "audio.revealInExplorer",
      title: "在檔案總管中顯示",
      group: "edit",
      section: SECTION,
      icon: FolderSearch,
      ...gate(on, CTX_ONLY),
      keywords: ["reveal", "show in explorer", "finder"],
      enabled: all(needsSingleAudio, () => (singleAudio() && audioSourcePath(singleAudio()!.clip) ? OK : { ok: false, why: "找不到這個片段的來源檔" })),
      run: () => {
        const a = singleAudio();
        const p = a && audioSourcePath(a.clip);
        if (p) void api.openPath(p).catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
      },
    },
    {
      id: "audio.jumpToSourceClip",
      title: "跳到來源片段",
      group: "edit",
      section: SECTION,
      icon: Split,
      ...gate(on, CTX_ONLY),
      enabled: all(needsSingleAudio, () => {
        const from = singleAudio()?.clip.detachedFrom;
        const seq = viewSequenceNow();
        return from && seq?.video.some((v) => v.id === from) ? OK : { ok: false, why: "這個片段不是從影片分離出來的原音" };
      }),
      run: jumpToSourceClip,
    },
    {
      id: "audio.clipInfo",
      title: "片段資訊…",
      group: "edit",
      section: SECTION,
      icon: Info,
      ...gate(on, SURFACES),
      keywords: ["clip info", "inspector", "properties"],
      enabled: needsClipSelection,
      run: () => openClipInspector(),
    },
    {
      id: "sequence.settings",
      title: "序列設定…",
      group: "edit",
      section: "序列剪輯",
      icon: Settings2,
      ...gate(on, ["menu", "palette"]),
      keywords: ["sequence settings", "limiter", "declick"],
      enabled: needsSequenceSpace,
      run: () => openDialog("sequenceSettings"),
    },

    // ---- 音軌右鍵 ----
    {
      id: "audio.lane.addHere",
      title: "在這裡加入音訊…",
      group: "edit",
      section: SECTION,
      icon: Music,
      ...gate(on, CTX_ONLY),
      enabled: needsLaneContext,
      run: () => addAudioOnContextLane(),
    },
    {
      id: "audio.lane.delete",
      title: "刪除音軌",
      group: "edit",
      section: SECTION,
      icon: Trash2,
      ...gate(on, CTX_ONLY),
      enabled: all(needsLaneContext, () => (contextLane()?.clips.length ? { ok: false, why: "音軌裡還有片段：先刪掉片段" } : OK)),
      run: () => {
        const lane = contextLane();
        if (lane) edit(L.deleteLane, (seq) => removeLane(seq, lane.id));
      },
    },
    {
      id: "audio.lane.mute",
      title: "靜音軌",
      group: "edit",
      section: SECTION,
      icon: VolumeX,
      ...gate(on, CTX_ONLY),
      checked: () => !!contextLane()?.muted,
      enabled: needsLaneContext,
      run: () => {
        const lane = contextLane();
        if (lane) edit(L.laneMute, (seq) => setLane(seq, lane.id, { muted: !lane.muted }));
      },
    },
    {
      id: "audio.lane.syncLock",
      title: "同步鎖",
      group: "edit",
      section: SECTION,
      icon: Lock,
      ...gate(on, CTX_ONLY),
      checked: () => !!contextLane()?.syncLock,
      enabled: needsLaneContext,
      run: () => {
        const lane = contextLane();
        if (lane) edit(L.syncLock, (seq) => setLane(seq, lane.id, { syncLock: !lane.syncLock }));
      },
    },
    { id: "audio.lane.role", title: "角色", group: "edit", section: SECTION, icon: Music, ...gate(on, CTX_ONLY), enabled: needsLaneContext, children: () => roleKids, run: () => {} },
    ...roleKids.map((c) => ({ ...c, ...gate(on, CTX_ONLY) })),
  ];
}

/** 旗標一變整張表重新登記；焦點 / 自動化點選取 / 本機偏好變了只要重算可用狀態。 */
export function installAudioClipCommandReactivity(): () => void {
  const uns = [
    useSettings.subscribe((s, p) => {
      if (s.experimental.sequence !== p.experimental.sequence) registerCommands(audioClipCommands(s.experimental.sequence));
    }),
    useEnvPointSelection.subscribe(() => bumpCommandTick()),
  ];
  return () => {
    for (const u of uns) u();
  };
}
