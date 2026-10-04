// 匯入音訊、把媒體放上序列（M2.14；docs/editor-m2-design.md §5.2 appendMedia／insertMedia／addAudioClip／moveAudioClip、
// §9.5 從檔案總管 / Sidebar 拖放、§13 M2.14）。
//
// 分工：非同步的事（probe、引擎 media.audio_info、peaks job）在這裡做完，才交給 store/project.ts 的 addAudioMedia
// 用**一筆** editSequence 落地 —— 一次 Ctrl+Z 同時拿掉音訊片段與新匯入的 audioMedia（驗收條件）。
// 純函式（副檔名、角色猜測、放置目標、錯誤文字、轉檔指令）跟動作放同一個檔，測試直接呼叫、不碰 store。
import { create } from "zustand";
import { errMessage, type MediaProbe } from "../api";
import { SEQ_ROW, frameOfSampleExact, layoutSequenceRows, viewSequenceOf, type SeqView, type SequenceLayout } from "../frametimeline/layoutSequence";
import { SNAP_PX } from "../frametimeline/rangeDrag";
import { useSequenceView } from "../frametimeline/TrackHeaders";
import { sequenceMediaIds, sequencePlayheadNow } from "../frametimeline/useSequenceTimeline";
import { t } from "../i18n";
import type { AudioInfoV2, AudioMediaV2, AudioRole, Rational, SequenceV2 } from "../project/format";
import { emptyReport, sanitizeAudioInfo } from "../project/sanitize";
import { durationFrames, placeVideo, samplesOfFrame } from "../sequence/map";
import { addLane, appendMedia, editPoints, insertMedia, moveAudioClip, overwriteMedia, SequenceError, snapToEditPoint, type SequenceErrorCode } from "../sequence/ops";
import { SEQ_EDIT_LABEL, useEdits } from "../store/edits";
import { engineReady, platformFamily, pyenvReady, useEngine, type PlatformFamily } from "../store/engine";
import { useProject, type AudioPlaceSpec } from "../store/project";
import { sequenceEditingEnabled, useSettings } from "../store/settings";
import { effectiveSpace, useTimeline } from "../store/timeline";
import { timecode } from "../time";
import { copyToClipboard, pickOpenFiles, toast, useUi } from "../ui";
import { fpsLabel } from "../video/frames";
import { dedupe, runEngineJob } from "./engineJob";
import { ensurePeaks, PEAKS_JOB_KIND, peaksSourceOfAudioMedia } from "./peaks";
import { ensureProxy } from "./proxy";

// ---------------------------------------------------------------- 副檔名與角色

/**
 * 認得的音訊副檔名（M2.14 驗收的 wav／mp3／m4a／flac／opus，加上常見的 ogg／aac／aiff／wma）。
 * 刻意不含 mp4 / webm：那兩個在 VIDEO_EXTENSIONS 裡，拖進來是開影片；要拿影片的聲音當音樂，之後走「分離音訊」。
 */
export const AUDIO_EXTENSIONS: readonly string[] = ["wav", "mp3", "m4a", "flac", "opus", "ogg", "oga", "aac", "aif", "aiff", "wma"];

export function isAudioPath(p: string): boolean {
  const name = p.split(/[\\/]/).pop() ?? p;
  const dot = name.lastIndexOf(".");
  return dot > 0 && AUDIO_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** probe 看到的音訊時長（ms）：音軌標頭優先，其次容器；都沒有（或是 0）→ null。 */
export function probeAudioDurationMs(probe: MediaProbe | null | undefined): number | null {
  const a = probe?.audio?.duration_ms;
  if (typeof a === "number" && Number.isFinite(a) && a > 0) return a;
  const c = probe?.duration_ms;
  return typeof c === "number" && Number.isFinite(c) && c > 0 ? c : null;
}

/** 長於這個就猜「音樂」（設計 §9.5：> 60 s 猜 music）。 */
export const MUSIC_MIN_MS = 60_000;
/** 短於（含）這個就猜「音效」：一聲叮、一段轉場刷聲。 */
export const SFX_MAX_MS = 10_000;
/** 檔名看得出是旁白 / 錄音。英文縮寫 vo 要前後不是字母，不然 "vocal"、"volume" 都會中。 */
const VOICE_NAME = /(^|[^a-z])(vo|voice|voiceover|narration|narrator)([^a-z]|$)|旁白|配音|口白|錄音/i;

/**
 * 依檔名與長度猜角色（CapCut 拖檔進來也是猜的）。角色決定新音軌的預設同步鎖：音樂關、旁白 / 音效開（§0.1 Q3）——
 * 猜錯的代價是「剪 V1 時音樂跟著跑 / 不跑」，所以只用確定性高的線索，不確定就回 other（同步鎖開，跟旁白一樣安全）。
 */
export function guessAudioRole(name: string, durationMs: number | null): AudioRole {
  const stem = name.replace(/\.[^.]+$/, "");
  if (VOICE_NAME.test(stem)) return "voiceover";
  if (durationMs == null) return "other";
  if (durationMs > MUSIC_MIN_MS) return "music";
  if (durationMs <= SFX_MAX_MS) return "sfx";
  return "other";
}

/** 沒有 audio_info（引擎還沒裝）時的片段長度退路：probe 時長 × 48 kHz（序列樣本）。不知道 → null。 */
export function probeLengthSamples(probe: MediaProbe | null | undefined): number | null {
  const ms = probeAudioDurationMs(probe);
  return ms == null ? null : Math.floor((ms * 48000) / 1000);
}

/**
 * 峰值檔的長度退路（probe 也沒有時長時）：Rust 解出來的樣本數是從容器時間 0 起算（前面補了靜音），
 * 片段 srcIn 0 = 音訊串流起點，所以扣掉起點之前那一段。
 */
export function peaksLengthSamples(p: { totalSamples: number; streamStartUs: number }): number | null {
  const lead = Math.round((Math.max(0, p.streamStartUs) * 48000) / 1e6);
  const n = p.totalSamples - lead;
  return n >= 1 ? n : null;
}

/** 「3:25」/「1:02:03」：音訊清單的長度欄（音訊檔沒有 fps，不用時間碼）。 */
export function formatAudioDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** 秒數：audio_info 的樣本數最準，其次 probe 的音軌 / 容器時長。 */
export function audioMediaSeconds(am: Pick<AudioMediaV2, "audio" | "probe">): number | null {
  if (am.audio && am.audio.sampleRate > 0) return am.audio.nSamples / am.audio.sampleRate;
  const ms = probeAudioDurationMs(am.probe);
  return ms == null ? null : ms / 1000;
}

/** Sidebar 音訊清單的第二行：「mp3 · 44.1 kHz · 2 ch · 3:25」。 */
export function audioMediaSummary(am: Pick<AudioMediaV2, "audio" | "probe">): string {
  const codec = am.audio?.codec || am.probe?.audio?.codec || "";
  const sr = am.audio?.sampleRate ?? am.probe?.audio?.sample_rate ?? 0;
  const ch = am.audio?.channels ?? am.probe?.audio?.channels ?? 0;
  const parts = [codec, sr > 0 ? `${Number((sr / 1000).toFixed(1))} kHz` : "", ch > 0 ? `${ch} ch` : "", formatAudioDuration(audioMediaSeconds(am))];
  return parts.filter(Boolean).join(" · ");
}

/** 序列裡用到這個音訊媒體的片段數（含鎖定的軌；移除前確認「會一併刪除 N 個片段」用）。 */
export function audioClipCount(seq: Pick<SequenceV2, "audioLanes"> | null, audioId: string): number {
  let n = 0;
  for (const l of seq?.audioLanes ?? []) for (const c of l.clips) if (c.source.type === "audio" && c.source.audioId === audioId) n++;
  return n;
}

// ---------------------------------------------------------------- 放置目標（純函式）

/** 音訊檔放在時間軸哪一列：某條音軌、放置區（新增音軌）、或其他列（依角色找軌）。 */
export type AudioDropZone = { kind: "lane"; laneId: string } | { kind: "newLane" } | { kind: "auto" };

/**
 * canvas 座標 y → 放置區域。音軌之間的間距算上面那一條（手往下偏一點不會掉到「依角色找軌」）；
 * 放置區以及它下面的空白（時間軸容器比 canvas 高時）都算「新增音軌」。
 */
export function audioDropZone(layout: Pick<SequenceLayout, "lanes" | "dropY">, y: number): AudioDropZone {
  for (const l of layout.lanes) if (y >= l.y && y < l.y + l.h + SEQ_ROW.gap) return { kind: "lane", laneId: l.laneId };
  if (y >= layout.dropY) return { kind: "newLane" };
  return { kind: "auto" };
}

/** 吸附候選（序列幀）：播放線、V1 剪輯點（含頭尾）、既有音訊片段的頭尾（四捨五入到幀）。 */
export function audioSnapFrames(seq: SequenceV2, playhead: number | null): number[] {
  const out = new Set<number>(editPoints(seq));
  if (playhead != null && Number.isFinite(playhead)) out.add(Math.round(playhead));
  for (const l of seq.audioLanes) {
    for (const c of l.clips) {
      out.add(Math.round(frameOfSampleExact(c.start, seq.fps)));
      out.add(Math.round(frameOfSampleExact(c.start + c.length, seq.fps)));
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** 小數幀 → 吸附後的整數幀（SNAP_PX 以內吸最近的候選，否則四捨五入到最近的幀；≥ 0）。 */
export function snapDropFrame(raw: number, pxPerFrame: number, targets: readonly number[], snap = true): { frame: number; snapped: boolean } {
  const r = Math.max(0, raw);
  if (snap && pxPerFrame > 0) {
    const tol = SNAP_PX / pxPerFrame;
    let best: number | null = null;
    for (const f of targets) if (Math.abs(f - r) <= tol && (best === null || Math.abs(f - r) < Math.abs(best - r))) best = f;
    if (best !== null) return { frame: Math.max(0, best), snapped: true };
  }
  return { frame: Math.round(r), snapped: false };
}

export interface TimelineSeqView {
  /** 時間軸畫的序列（隱含序列 = 作用中媒體整段）。 */
  seq: SequenceV2;
  layout: SequenceLayout;
  view: SeqView;
  playhead: number | null;
}

export interface TimelinePoint extends TimelineSeqView {
  /** canvas 座標（px）。x 夾在 ≥ 0（落在左側軌道標頭上 = 可視區左緣）。 */
  x: number;
  y: number;
}

export interface AudioDropPlan {
  frame: number;
  snapped: boolean;
  zone: AudioDropZone;
}

/** 音訊檔放在時間軸 (x, y) 時的計畫：幀（吸附）＋音軌。 */
export function planAudioDrop(p: TimelinePoint, opts: { snap?: boolean } = {}): AudioDropPlan {
  const raw = p.view.scrollFrame + p.x / Math.max(1e-9, p.view.pxPerFrame);
  const { frame, snapped } = snapDropFrame(raw, p.view.pxPerFrame, audioSnapFrames(p.seq, p.playhead), opts.snap !== false);
  return { frame, snapped, zone: audioDropZone(p.layout, p.y) };
}

/** 影片媒體放在時間軸 x 時插入的位置：最近的剪輯點（§9.5「從 Sidebar 拖媒體到 V1：插入到最近的剪輯點」，同 insertMedia）。 */
export function planMediaDrop(p: Pick<TimelinePoint, "seq" | "view" | "x">): number {
  return snapToEditPoint(p.seq, p.view.scrollFrame + p.x / Math.max(1e-9, p.view.pxPerFrame));
}

/** 音訊放置計畫 → store 的放置規格。 */
export function placeSpecOf(plan: AudioDropPlan, fps: Rational): AudioPlaceSpec {
  return { atSample: samplesOfFrame(plan.frame, fps), laneId: plan.zone.kind === "lane" ? plan.zone.laneId : null, newLane: plan.zone.kind === "newLane" };
}

// ---------------------------------------------------------------- 讀目前的時間軸（非 hook）

/** 目前的序列（隱含序列 = 作用中媒體整段；跟時間軸畫的是同一個物件形狀）；沒有 proxy 可實體化 → null。 */
export function sequenceNow(): SequenceV2 | null {
  const p = useProject.getState();
  return viewSequenceOf(useEdits.getState().sequence, p.media.find((m) => m.id === p.activeMediaId) ?? null);
}

/** 目前的序列播放線（序列幀）；播放中的來源幀沒用在序列裡 → null。 */
export function sequencePlayheadFrame(seq: SequenceV2): number | null {
  return sequencePlayheadNow({ seq, placed: placeVideo(seq) });
}

/**
 * 時間軸現在畫的序列版面（非 hook，規則同 useSequenceTimeline）：旗標關、素材空間、沒東西可畫 → null。
 * 為什麼自己再組一次而不是讓 FrameTimeline 匯出：拖放發生在時間軸元件之外（OS 拖放、Sidebar 拖曳），這時只有 store 可讀。
 */
export function timelineSeqViewNow(): TimelineSeqView | null {
  if (!sequenceEditingEnabled()) return null;
  const tl = useTimeline.getState();
  if (effectiveSpace(tl.space, true) !== "sequence") return null;
  const seq = sequenceNow();
  if (!seq) return null;
  const tracks = useEdits.getState().tracks;
  const refs = sequenceMediaIds(seq).flatMap((mid) => (tracks[mid] ?? []).map((tr) => ({ id: tr.id, mediaId: mid })));
  const sv = useSequenceView.getState();
  const layout = layoutSequenceRows(seq, refs, sv.laneHeights, { tracksCollapsed: sv.tracksCollapsed });
  // 整段適配時捲動永遠是 0（同 FrameTimeline viewNow）
  const view = { scrollFrame: tl.pxPerFrame === null ? 0 : tl.scrollFrame, pxPerFrame: tl.pxPerFrame ?? tl.fitPxPerFrame };
  return { seq, layout, view, playhead: sequencePlayheadFrame(seq) };
}

/** 視窗座標落在哪裡：序列時間軸（附 canvas 座標）、側欄、或其他地方。 */
export type ScreenTarget = { kind: "timeline"; point: TimelinePoint } | { kind: "sidebar" } | { kind: "other" };

export function screenTargetAt(clientX: number, clientY: number): ScreenTarget {
  if (typeof document === "undefined") return { kind: "other" };
  const el = document.elementFromPoint(clientX, clientY);
  if (el?.closest('[data-testid="sidebar"]')) return { kind: "sidebar" };
  const canvas = el?.closest('[data-testid="frame-timeline"]')?.querySelector("canvas");
  const now = canvas ? timelineSeqViewNow() : null;
  if (!canvas || !now) return { kind: "other" };
  const r = canvas.getBoundingClientRect();
  return { kind: "timeline", point: { ...now, x: Math.max(0, clientX - r.left), y: clientY - r.top } };
}

// ---------------------------------------------------------------- 匯入中的清單（Sidebar 顯示轉圈）

interface AudioImportsStore {
  /** 正在 probe / 分析音訊的檔名（顯示用）。 */
  pending: string[];
  begin: (names: readonly string[]) => void;
  end: (names: readonly string[]) => void;
}

export const useAudioImports = create<AudioImportsStore>((set) => ({
  pending: [],
  begin: (names) => set((s) => ({ pending: [...s.pending, ...names] })),
  end: (names) =>
    set((s) => {
      const rest = [...s.pending];
      for (const n of names) {
        const i = rest.indexOf(n);
        if (i >= 0) rest.splice(i, 1);
      }
      return { pending: rest };
    }),
}));

// ---------------------------------------------------------------- 引擎 audio_info

/**
 * 工作清單的種類：JobKind 還沒有「音訊」，暫借 thumbs（同 pipeline/peaks.ts 的理由，步驟文字另外寫清楚）。
 * 專屬的 kind 要動 store/jobs.ts、video/labels.ts、en.ts，不在 M2.14 的檔案範圍。
 */
export const AUDIO_INFO_JOB_KIND = PEAKS_JOB_KIND;
/** 工作清單上的步驟文字（zh key）。 */
export const AUDIO_INFO_STEP = "分析音訊";

/**
 * 引擎 `media.audio_info`（只解音訊一趟，約 500 倍即時）→ AudioInfoV2。引擎沒裝 → null（不擲錯：長度改用 probe 退路）。
 * 為什麼放片段之前先等它：片段長度 = 來源樣本數，probe 的時長在 VBR mp3 上可能差好幾秒，放上去之後才修正就是一筆使用者沒做的修改。
 */
export function fetchAudioInfo(am: Pick<AudioMediaV2, "id" | "path" | "fingerprint">): Promise<AudioInfoV2 | null> {
  if (!engineReady() && !pyenvReady()) return Promise.resolve(null);
  return dedupe(`audio-info:${am.fingerprint || am.path}`, async () => {
    const r = await runEngineJob<{ audio?: unknown } | null>({ kind: AUDIO_INFO_JOB_KIND, mediaId: am.id, op: "media.audio_info", args: { video: am.path }, gpu: false, step: AUDIO_INFO_STEP });
    return r && r.audio != null ? sanitizeAudioInfo(r.audio, emptyReport()) : null;
  });
}

const infoGaveUp = new Set<string>();

/** 清單裡還沒有 audio_info 的音訊媒體補算（開舊專案、當初引擎沒裝）；衍生資料，不記 undo。失敗一次就不再自動重試。 */
export async function ensureAudioMediaInfo(audioId: string): Promise<void> {
  const am = useEdits.getState().audioMedia.find((a) => a.id === audioId);
  if (!am || am.audio || infoGaveUp.has(am.id) || (!engineReady() && !pyenvReady())) return;
  try {
    const info = await fetchAudioInfo(am);
    if (info) useEdits.getState().setAudioMediaInfo(am.id, info);
    else infoGaveUp.add(am.id);
  } catch {
    infoGaveUp.add(am.id);
  }
}

// ---------------------------------------------------------------- 匯入音訊

/** 放在哪：只進清單、播放線（依角色找軌）、時間軸上的某一點。 */
export type AudioImportTarget = { kind: "list" } | { kind: "playhead" } | { kind: "drop"; plan: AudioDropPlan; fps: Rational };

/** 序列還放不上去（沒有作用中影片 / proxy 還沒好）時的說明。字串直接寫在 t 的引數裡：i18n 稽核只掃得到字面量，放進常數就漏掉了。 */
function listOnlyNotice(): string {
  return t("音訊已加入清單；影片的 proxy 建好之後才能放上音軌");
}

function placeSpecFor(target: AudioImportTarget): AudioPlaceSpec | null {
  if (target.kind === "list" || !sequenceEditingEnabled()) return null;
  if (target.kind === "drop") return placeSpecOf(target.plan, target.fps);
  const seq = sequenceNow();
  if (!seq) return null;
  return { atSample: samplesOfFrame(sequencePlayheadFrame(seq) ?? 0, seq.fps), laneId: null };
}

/** 落地：放得上就一筆 undo 放上音軌，放不上（序列還不存在）退回只進清單並說明。回傳放上去的片段 id。 */
function commitAudio(items: readonly AudioMediaV2[], lengths: Readonly<Record<string, number>>, target: AudioImportTarget): string[] {
  const project = useProject.getState();
  const spec = placeSpecFor(target);
  if (!spec) {
    project.addAudioMedia(items, null);
    if (target.kind !== "list" && sequenceEditingEnabled()) toast.info(listOnlyNotice());
    return [];
  }
  let clipIds: string[] = [];
  try {
    clipIds = project.addAudioMedia(items, { ...spec, lengths }).clipIds;
  } catch (e) {
    if (e instanceof SequenceError && (e.code === "noProxy" || e.code === "notFound")) {
      project.addAudioMedia(items, null);
      toast.info(listOnlyNotice());
      return [];
    }
    toast.error(t("無法修改序列：{msg}", { msg: errMessage(e) }));
    return [];
  }
  const unknown = items.filter((it) => !it.audio && !(lengths[it.id] >= 1));
  if (unknown.length) toast.info(t("還不知道「{name}」的長度，先放進音訊清單；引擎就緒後再放上音軌", { name: unknown[0].name }));
  // 剛放上去的片段直接選取（Premiere / CapCut 拖進來就是選取狀態）：接著按 Delete 會拿掉它、B 切它，不必再點一次
  if (clipIds.length) useTimeline.getState().selectClips(clipIds);
  return clipIds;
}

/** 長度退路：probe 時長 → Rust 峰值（不需要引擎）。 */
async function fallbackLength(am: AudioMediaV2): Promise<number | null> {
  const fromProbe = probeLengthSamples(am.probe);
  if (fromProbe != null) return fromProbe;
  try {
    const mip = await ensurePeaks(peaksSourceOfAudioMedia(am));
    return mip ? peaksLengthSamples(mip.peaks) : null;
  } catch {
    return null;
  }
}

/** probe 每個檔：沒有音軌 / 讀不了的當場 toast 並略過；同指紋的只留一份；新檔依檔名與長度猜角色。 */
async function probeAudioFiles(paths: readonly string[]): Promise<AudioMediaV2[]> {
  const items: AudioMediaV2[] = [];
  for (const p of paths) {
    try {
      const { item, existing } = await useProject.getState().probeAudio(p);
      if (!existing && !item.probe?.audio) {
        toast.error(t("「{name}」沒有音軌，無法當成音訊加入", { name: item.name }));
        continue;
      }
      if (items.some((x) => x.id === item.id)) continue;
      items.push(existing ? item : { ...item, role: guessAudioRole(item.name, probeAudioDurationMs(item.probe)) });
    } catch (e) {
      toast.error(t("無法匯入「{name}」：{msg}", { name: fileName(p), msg: errMessage(e) }));
    }
  }
  return items;
}

/**
 * 補 audio_info＋算退路長度。只有引擎**已經在跑**時才等 audio_info（幾百毫秒，換到逐樣本精確的長度）；
 * 引擎還沒起來（冷啟動要好幾秒）就先用 probe 長度放上去，資訊由 importAudioFiles 在背景補 —— 拖進來的檔不該等引擎開機才出現。
 * 引擎是單一 worker，並行送也是排隊；失敗退回 probe 長度，錯誤在工作清單上看得到。
 */
async function resolveAudioFacts(items: readonly AudioMediaV2[]): Promise<{ resolved: AudioMediaV2[]; lengths: Record<string, number> }> {
  const wait = engineReady();
  const resolved = wait ? await Promise.all(items.map(async (it) => (it.audio ? it : { ...it, audio: await fetchAudioInfo(it).catch(() => null) }))) : [...items];
  const lengths: Record<string, number> = {};
  for (const it of resolved) {
    if (it.audio) continue;
    const n = await fallbackLength(it);
    if (n != null) lengths[it.id] = n;
  }
  // 已在清單裡、這次才算出 audio_info 的：寫回清單（衍生資料，不記 undo）
  const listed = useEdits.getState().audioMedia;
  for (const it of resolved) if (it.audio && listed.some((a) => a.id === it.id && !a.audio)) useEdits.getState().setAudioMediaInfo(it.id, it.audio);
  return { resolved, lengths };
}

/**
 * 匯入音訊檔（對話框、OS 拖放、之後的指令都走這裡）：probe → audio_info（引擎在跑時）→ 一筆 undo 落地 → 背景算波形與補 audio_info。
 * 一次多個檔：接在一起放在同一條軌（Premiere 拖多個檔的行為），整批一筆 undo。回傳放上音軌的片段 id。
 */
export async function importAudioFiles(paths: readonly string[], target: AudioImportTarget): Promise<string[]> {
  const uniq = [...new Set(paths.filter(isAudioPath))];
  if (!uniq.length) return [];
  const names = uniq.map(fileName);
  useAudioImports.getState().begin(names);
  try {
    const items = await probeAudioFiles(uniq);
    if (!items.length) return [];
    const { resolved, lengths } = await resolveAudioFacts(items);
    const clipIds = commitAudio(resolved, lengths, target);
    // 波形在背景算（Rust 有磁碟快取）；失敗 / 取消寫在工作清單上
    for (const it of resolved) void ensurePeaks(peaksSourceOfAudioMedia(it)).catch(() => {});
    // 引擎沒在跑時沒等到的 audio_info：背景補（pyenv 裝好就會順便把引擎叫起來；沒裝就什麼都不做，渲染時引擎自己會算）
    for (const it of resolved) if (!it.audio) void ensureAudioMediaInfo(it.id);
    return clipIds;
  } finally {
    useAudioImports.getState().end(names);
  }
}

/** 「加入音訊檔…」：檔案對話框（可多選）→ 放在播放線。 */
export async function importAudioDialog(): Promise<void> {
  try {
    const paths = await pickOpenFiles([{ name: t("音訊"), extensions: [...AUDIO_EXTENSIONS] }]);
    if (paths.length) await importAudioFiles(paths, { kind: "playhead" });
  } catch (e) {
    toast.error(errMessage(e));
  }
}

/**
 * 從檔案總管拖進來的音訊檔（App.tsx 的 onDragDropEvent；座標是 CSS px）。序列剪輯旗標關著 → 回 false（照 M1 靜靜忽略）。
 * 落在序列時間軸 → 放在游標所在音軌的游標時間（吸附）；落在側欄 → 只進清單；其他地方 → 播放線。
 */
export function importDroppedAudio(paths: readonly string[], at: { x: number; y: number } | null): boolean {
  if (!sequenceEditingEnabled()) return false;
  const audio = paths.filter(isAudioPath);
  if (!audio.length) return false;
  // 拖放當下就決定位置：probe / audio_info 要幾百毫秒，等完才看游標會放到使用者已經移開的地方
  const where = at ? screenTargetAt(at.x, at.y) : ({ kind: "other" } as const);
  const target: AudioImportTarget =
    where.kind === "timeline" ? { kind: "drop", plan: planAudioDrop(where.point), fps: where.point.seq.fps } : where.kind === "sidebar" ? { kind: "list" } : { kind: "playhead" };
  void importAudioFiles(audio, target);
  return true;
}

/** 已在清單裡的音訊媒體放上音軌（Sidebar 的「加到播放線」、拖到時間軸）。 */
export async function placeAudioMedia(audioId: string, target: Exclude<AudioImportTarget, { kind: "list" }>): Promise<string[]> {
  const am = useEdits.getState().audioMedia.find((a) => a.id === audioId);
  if (!am) return [];
  const lengths: Record<string, number> = {};
  if (!am.audio) {
    const n = await fallbackLength(am);
    if (n != null) lengths[am.id] = n;
  }
  return commitAudio([am], lengths, target);
}

// ---------------------------------------------------------------- 影片媒體加到序列

/** 加入媒體失敗時的修正建議：複製轉檔指令（fps / 尺寸不符）、建 proxy、或沒有。 */
export type AddMediaFix = "conform" | "buildProxy" | null;

export interface AddMediaErrorView {
  text: string;
  fix: AddMediaFix;
  mediaId: string | null;
}

function ratOf(v: unknown): Rational | null {
  const o = v as { num?: unknown; den?: unknown } | null;
  return o && typeof o.num === "number" && typeof o.den === "number" && o.den !== 0 ? { num: o.num, den: o.den } : null;
}

function sizeOf(v: unknown): string {
  return Array.isArray(v) && v.length === 2 ? `${v[0]}×${v[1]}` : "?";
}

/**
 * appendMedia / insertMedia 的錯誤 → 使用者看得懂、而且知道下一步的訊息（§13 M2.14「fps 不符顯示可操作錯誤」）。
 * 為什麼不是設計草稿寫的「以 N/D fps 重建 proxy」：引擎的追蹤 / 字幕 op 會用來源 fps 重建索引，proxy 換 fps 之後
 * 下一次追蹤就把索引改回去、proxy 幀號對不上（ops/track.py ensure_index 不帶 fps）。所以修正方式是先把**檔案**轉成序列 fps。
 */
export function describeAddMediaError(e: unknown, nameOf: (mediaId: string) => string | undefined): AddMediaErrorView {
  if (!(e instanceof SequenceError)) return { text: t("無法修改序列：{msg}", { msg: errMessage(e) }), fix: null, mediaId: null };
  const id = typeof e.detail.mediaId === "string" ? e.detail.mediaId : null;
  const name = (id && nameOf(id)) || id || "";
  const code: SequenceErrorCode = e.code;
  if (code === "fpsMismatch") {
    const ex = ratOf(e.detail.expected);
    const ac = ratOf(e.detail.actual);
    const expected = ex ? fpsLabel(ex) : "?";
    return {
      text: t("無法加入「{name}」：它是 {actual} fps，序列是 {expected} fps。序列裡的影片要同 fps，請先把它轉成 {expected} fps 再加入", { name, actual: ac ? fpsLabel(ac) : "?", expected }),
      fix: "conform",
      mediaId: id,
    };
  }
  if (code === "sizeMismatch") {
    const expected = sizeOf(e.detail.expected);
    return { text: t("無法加入「{name}」：尺寸 {actual} 跟序列的 {expected} 不同。序列裡的影片要同尺寸，請先把它轉成 {expected} 再加入", { name, actual: sizeOf(e.detail.actual), expected }), fix: "conform", mediaId: id };
  }
  if (code === "noProxy") return { text: t("「{name}」的 proxy 還沒建好，建好之後才能加入序列", { name }), fix: "buildProxy", mediaId: id };
  return { text: t("無法修改序列：{msg}", { msg: e.message }), fix: null, mediaId: id };
}

export interface ConformInput {
  /** 設定偵測到的 ffmpeg；null = 用 PATH 上的 `ffmpeg`。 */
  ffmpegPath: string | null;
  family: PlatformFamily;
  src: string;
  fps: Rational;
  /** 要縮放 / 補邊到的尺寸；null = 尺寸已經相同。 */
  size: readonly [number, number] | null;
  /** ffmpeg 試編過關的編碼器（settings.ffmpeg.usable）。 */
  usable: readonly string[];
}

/** 轉檔用的視訊編碼器，依序挑第一個能用的：高品質、proxy 能吃的 H.264 優先，都沒有才 VP9 / mpeg4。 */
const CONFORM_ENCODERS: readonly { name: string; args: readonly string[]; ext: "mp4" | "webm" }[] = [
  { name: "h264_nvenc", args: ["-c:v", "h264_nvenc", "-preset", "p5", "-cq", "16"], ext: "mp4" },
  { name: "libx264", args: ["-c:v", "libx264", "-preset", "medium", "-crf", "16"], ext: "mp4" },
  { name: "h264_videotoolbox", args: ["-c:v", "h264_videotoolbox", "-b:v", "20M"], ext: "mp4" },
  { name: "libopenh264", args: ["-c:v", "libopenh264", "-b:v", "20M"], ext: "mp4" },
  { name: "libvpx-vp9", args: ["-c:v", "libvpx-vp9", "-crf", "18", "-b:v", "0", "-row-mt", "1"], ext: "webm" },
];
const CONFORM_FALLBACK = { name: "mpeg4", args: ["-c:v", "mpeg4", "-q:v", "2"], ext: "mp4" as const };

/**
 * 把影片轉成序列 fps / 尺寸的 ffmpeg 指令（複製到剪貼簿，使用者貼到終端機執行）。
 * - `fps` 濾鏡產生 CFR；尺寸不同時等比縮放＋補黑邊，不裁掉畫面。
 * - Windows 產生 PowerShell 語法（Windows 11 終端機預設）：路徑有空白時開頭一定要 `&`，字串用單引號（不展開 $ 與反引號）；
 *   其他平台是 sh 單引號。
 */
export function conformCommand(i: ConformInput): { command: string; output: string } {
  const enc = CONFORM_ENCODERS.find((e) => i.usable.includes(e.name)) ?? CONFORM_FALLBACK;
  const sep = i.src.includes("\\") ? "\\" : "/";
  const cut = Math.max(i.src.lastIndexOf("\\"), i.src.lastIndexOf("/"));
  const dir = cut >= 0 ? i.src.slice(0, cut) : "";
  const base = cut >= 0 ? i.src.slice(cut + 1) : i.src;
  const stem = base.replace(/\.[^.]+$/, "");
  const suffix = `_${fpsLabel(i.fps)}fps${i.size ? `_${i.size[0]}x${i.size[1]}` : ""}`;
  const output = `${dir ? dir + sep : ""}${stem}${suffix}.${enc.ext}`;
  const vf = [`fps=${i.fps.num}/${i.fps.den}`];
  if (i.size) {
    const [w, h] = i.size;
    vf.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease`, `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`, "setsar=1");
  }
  const audio = enc.ext === "webm" ? ["-c:a", "libopus", "-b:a", "160k"] : ["-c:a", "aac", "-b:a", "192k"];
  const ps = i.family === "windows";
  const q = (s: string) => (ps ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`);
  const exe = i.ffmpegPath ? q(i.ffmpegPath) : "ffmpeg";
  const args = ["-hide_banner", "-i", q(i.src), "-vf", q(vf.join(",")), ...enc.args, "-pix_fmt", "yuv420p", ...audio, q(output)];
  return { command: `${ps && i.ffmpegPath ? "& " : ""}${exe} ${args.join(" ")}`, output };
}

/** 錯誤 toast（帶一顆修正按鈕）。 */
function showAddMediaError(e: unknown): void {
  const p = useProject.getState();
  const v = describeAddMediaError(e, (id) => p.media.find((m) => m.id === id)?.name);
  const m = v.mediaId ? p.media.find((x) => x.id === v.mediaId) : undefined;
  let action: { label: string; onClick: () => void } | undefined;
  if (v.fix === "buildProxy" && m) {
    action = { label: t("建 proxy"), onClick: () => void ensureProxy(m.id, { startEngine: true }).catch((err) => toast.error(errMessage(err))) };
  } else if (v.fix === "conform" && m) {
    const seq = sequenceNow();
    if (seq) {
      const v0 = m.probe?.video;
      const sameSize = !v0 || (v0.width === seq.width && v0.height === seq.height);
      const settings = useSettings.getState();
      const { command, output } = conformCommand({
        ffmpegPath: settings.ffmpeg?.ffmpeg_path ?? null,
        family: platformFamily(useEngine.getState().platform),
        src: m.path,
        fps: seq.fps,
        size: sameSize ? null : [seq.width, seq.height],
        usable: settings.ffmpeg?.usable ?? [],
      });
      action = { label: t("複製轉檔指令"), onClick: () => void copyToClipboard(command, t("已複製轉檔指令：在終端機執行後，把「{name}」加入專案", { name: fileName(output) })) };
    }
  }
  // 修正步驟要讀完才按得到：比一般錯誤 toast 多留一點時間
  useUi.getState().pushToast("error", v.text, action ? { action, ttlMs: 12000 } : undefined);
}

/**
 * 把影片媒體放進序列：append = 接在結尾（FCP Append），insert = 在 at（預設播放線）最近的剪輯點插入（FCP Insert）。
 * 一筆 undo「加入媒體到序列」；隱含序列會在同一筆裡先實體化。失敗（fps / 尺寸不符、proxy 還沒好）顯示可操作的錯誤。
 */
export function addMediaToSequence(mediaId: string, mode: "append" | "insert" | "overwrite", at?: number): boolean {
  const m = useProject.getState().media.find((x) => x.id === mediaId);
  if (!m) return false;
  try {
    return useEdits.getState().editSequence(mode === "overwrite" ? SEQ_EDIT_LABEL.overwrite : SEQ_EDIT_LABEL.addMedia, (seq, ctx) => {
      if (mode === "append") return appendMedia(seq, m);
      // 播放線不在序列裡（素材空間看的來源幀沒被用到）→ 接在結尾，而不是插到開頭
      const t0 = at ?? sequencePlayheadFrame(seq) ?? durationFrames(seq);
      return mode === "overwrite" ? overwriteMedia(seq, m, t0) : insertMedia(seq, m, t0, ctx);
    });
  } catch (e) {
    showAddMediaError(e);
    return false;
  }
}

// ---------------------------------------------------------------- 音軌與移動

/** 新增音軌（一筆 undo「新增音軌」）。 */
export function addAudioLane(role: AudioRole = "other"): boolean {
  try {
    return useEdits.getState().editSequence(SEQ_EDIT_LABEL.newLane, (seq) => addLane(seq, role));
  } catch (e) {
    toast.error(t("無法修改序列：{msg}", { msg: errMessage(e) }));
    return false;
  }
}

export type MoveAudioResult = { ok: true; changed: boolean } | { ok: false; code: SequenceErrorCode; nearest: number | null };

/**
 * 移動音訊片段（一筆 undo「移動音訊片段」）。重疊 / 鎖定不擲錯，回傳原因與最近放得下的起點 ——
 * 拖曳的 UI 要畫紅框並回彈（§5.2 moveAudioClip），不是跳一個錯誤 toast。
 */
export function moveAudioClipTo(id: string, laneId: string, start: number): MoveAudioResult {
  try {
    return { ok: true, changed: useEdits.getState().editSequence(SEQ_EDIT_LABEL.moveAudio, (seq) => moveAudioClip(seq, id, laneId, start)) };
  } catch (e) {
    if (e instanceof SequenceError) return { ok: false, code: e.code, nearest: typeof e.detail.nearest === "number" ? e.detail.nearest : null };
    throw e;
  }
}

// ---------------------------------------------------------------- Sidebar 拖曳

export type SidebarDragPayload = { kind: "media"; mediaId: string } | { kind: "audio"; audioId: string };

/** 拖曳中的提示（跟著游標的標籤）：null = 這裡放不下（放開會取消）。 */
export function describeSidebarDrop(payload: SidebarDragPayload, clientX: number, clientY: number, opts: { snap?: boolean } = {}): string | null {
  const where = screenTargetAt(clientX, clientY);
  if (where.kind !== "timeline") return null;
  const p = where.point;
  if (payload.kind === "media") return t("插入到 {tc}", { tc: timecode(planMediaDrop(p), p.seq.fps) });
  const plan = planAudioDrop(p, opts);
  const tc = timecode(plan.frame, p.seq.fps);
  if (plan.zone.kind === "newLane") return t("新增音軌 · {tc}", { tc });
  if (plan.zone.kind === "lane") {
    const laneId = plan.zone.laneId;
    return t("放到 {lane} · {tc}", { lane: p.seq.audioLanes.find((l) => l.id === laneId)?.name ?? laneId, tc });
  }
  return t("放到音軌 · {tc}", { tc });
}

/** 放開：落在序列時間軸才動作，其他地方 = 取消（回 false）。 */
export function dropSidebarPayload(payload: SidebarDragPayload, clientX: number, clientY: number, opts: { snap?: boolean } = {}): boolean {
  const where = screenTargetAt(clientX, clientY);
  if (where.kind !== "timeline") return false;
  const p = where.point;
  if (payload.kind === "media") return addMediaToSequence(payload.mediaId, "insert", planMediaDrop(p));
  void placeAudioMedia(payload.audioId, { kind: "drop", plan: planAudioDrop(p, opts), fps: p.seq.fps });
  return true;
}
