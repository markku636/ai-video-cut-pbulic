import { ArrowLeft, ArrowRight, BetweenHorizontalStart, Bookmark, BookmarkX, Pencil, Scissors as ScissorsCut, Volume2, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, ClipboardCopy, ClipboardPaste, Eraser, MoveHorizontal, Replace, ChevronsDown, ChevronsUp, Clapperboard, Copy, Crosshair, Delete, EyeOff, LocateFixed, MousePointer2, Scissors, Slice, SquareDashed, SquareSplitHorizontal, Trash2 } from "lucide-react";
import { sequencePlayhead, viewSequenceOf } from "../frametimeline/layoutSequence";
// M2.13 修剪到播放線（Ctrl+Shift+[ / ]）：守門規則跟拖曳修剪共用 trimDrag.ts 那一份，跟 ops.rippleTrimToPlayhead 同步
import { ArrowLeftToLine, ArrowRightToLine } from "lucide-react";
import { trimToPlayheadCheck } from "../frametimeline/trimDrag";
// M2.14 加媒體到序列＋匯入音訊：流程（probe、錯誤提示、一筆 undo）都在 pipeline/audio.ts，指令只是入口
import { FilePlus, ListEnd, Music, Plus } from "lucide-react";
import { addAudioLane, addMediaToSequence, importAudioDialog } from "../pipeline/audio";
import { peaksOf, peaksSourceOfAudioMedia, peaksSourceOfMedia } from "../pipeline/peaks";
import { normalizeGainDb, peakDbOfRange, peakDbOfSamples, type PeakSource } from "../sequence/loudness";
import { seekSequence } from "../frametimeline/useSequenceTimeline";
import { t } from "../i18n";
import { SEQ_SAMPLE_RATE, type AudioSourceRefV2, type MarkerV2, type SequenceV2 } from "../project/format";
import { makeSeqCtx } from "../sequence/context";
import { clipIdsOf } from "../sequence/ids";
import { durationFrames, mapFrame, placedAt, placeVideo, projectFrames, samplesOfFrame } from "../sequence/map";
import { addMarker, canJoinAt, copyClips, duplicateClip, editPoints, extractRange, insertGap, insertMedia, joinThroughEdit, lift, liftRange, pasteClips, rippleDelete, rippleTrimToPlayhead, markerAt, markerNear, moveItemBy, removeMarker, renameMarker, rollEdit, setClipLabel, setGainsById, slideCapacity, slipCapacity, setEnabled, slideClip, slipClip, splitAt, type ClipSeed, type SplitTarget } from "../sequence/ops";
import { selectionSpan } from "../sequence/selectionSpan";
import { openDialog } from "../store/dialogs";
import { SEQ_EDIT_LABEL, useEdits } from "../store/edits";
import { usePlayback } from "../store/playback";
import { selectActiveMedia, useProject } from "../store/project";
import { sequenceEditingEnabled, useSettings } from "../store/settings";
import { effectiveSpace, useTimeline, type TimelineFocus } from "../store/timeline";
import { toast, uiPrompt } from "../ui";
import * as A from "./appActions";
import { needsProxy, needsRange } from "./guards";
import { OK, bumpCommandTick, command, registerCommands } from "./registry";
import type { Command, CommandGroup, Enabled, Surface } from "./types";
import { withUndoToast } from "./undoToast";

/**
 * 序列剪輯指令（docs/editor-m2-design.md §10、§13 M2.12）：分割 / 合併切點、刀片、波紋刪除 / 留空隙、範圍提取 / 移除、
 * 停用、對應幀、上 / 下一個剪輯點，以及「一顆鍵依情境派發」的四組派發指令。
 *
 * ## 為什麼要派發指令（dispatcher）
 * 同一顆鍵在 M1 已經有主人：Delete＝移除關鍵幀、Shift+Delete＝刪除追蹤、B＝分割字幕（feat/captions，CapCut 同鍵）、
 * ↑／↓ 與 Shift+[ ]＝上／下一個鏡頭。兩個指令綁同一個 chord 會雙擊發（registry.duplicateChords 守門），
 * 所以鍵交給一個派發指令（`edit.delete`、`edit.deleteAlt`、`edit.split`、`playback.prev/nextEditOrShot`），
 * 由它依「空間＋焦點」轉給真正做事的指令；原本的指令保留在選單 / 右鍵 / 命令面板，快捷鍵改成**只顯示**
 * （`shortcutManual`：註冊表不派發、不算撞鍵，但選單上照樣看得到「按哪顆」—— §10.1「shortcutOf 顯示派發鍵」的做法）。
 *
 * ## 實驗旗標（settings.experimental.sequence）
 * - 關：序列指令不出現在任何表面、不綁任何鍵；派發指令一律轉給 M1 的原主人，標題、群組、快捷鍵跟 M1 一模一樣。
 *   → 旗標關著的使用者在按鍵、選單、快捷鍵說明上看不到任何差別（M2.17 之前不出貨半成品）。
 * - 開：序列空間（時間軸上方選「序列」）才剪序列；素材空間仍是 M1 的行為（鏡頭、字幕、關鍵幀）。
 * 旗標一變就重新登記（installSequenceCommandReactivity），registerCommands 的 upsert 讓位置不跳。
 *
 * 每一條的 title / why 是 zh key（本目錄在 check-i18n 的 TABLE_SOURCES）。
 */

const L = SEQ_EDIT_LABEL;

// ============================================================================
// 讀目前狀態（非 hook；enabled() 與 run() 當下讀 store）
// ============================================================================

export const FLAG_WHY = "先在設定開啟「序列剪輯（預覽）」";
export const SPACE_WHY = "切到時間軸上方的「序列」再剪輯片段";
export const PLAYHEAD_WHY = "播放線這一幀沒有用在序列裡";
export const SELECTION_WHY = "先在時間軸點選片段";
export const FOCUS_WHY = "先選片段、範圍或關鍵幀";
export const NOT_YET_WHY = "這個動作還沒開放";

/**
 * 自動化點的刪除指令 id（M2.15 音訊片段編輯登記）。焦點是 envPoint 時 Delete / Shift+Delete 都轉給它；
 * 還沒登記的話派發指令灰掉並講「還沒開放」，而不是默默去刪片段。
 */
export const ENVELOPE_POINT_DELETE_COMMAND = "audio.deleteEnvelopePoint";

/** 序列空間正在作用：旗標開、而且時間軸選的是序列。 */
export function inSequenceSpace(): boolean {
  return effectiveSpace(useTimeline.getState().space, sequenceEditingEnabled()) === "sequence";
}

/** 要剪的序列：實體序列原樣；隱含序列（null）= 作用中媒體整段一個片段（跟時間軸畫的同一份，片段 id 也一致）。 */
export function viewSequenceNow(): SequenceV2 | null {
  return viewSequenceOf(useEdits.getState().sequence, selectActiveMedia(useProject.getState()) ?? null);
}

/** playback.seqFrame（M2.11 序列播放器寫）；欄位還沒落地時 null。用字串讀，型別上不依賴還沒合進來的欄位。 */
function playbackSeqFrame(): number | null {
  const v = (usePlayback.getState() as unknown as Record<string, unknown>).seqFrame;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 序列空間的播放線（序列幀）；目前的來源幀沒有用在序列裡 → null。 */
export function sequencePlayheadNow(seq: SequenceV2): number | null {
  return sequencePlayhead(seq, useProject.getState().activeMediaId, usePlayback.getState().frame, playbackSeqFrame());
}

/** 選取裡還存在於序列的片段 id（undo 之後被刪掉的片段自動不算）。 */
export function selectedClipIdsIn(seq: SequenceV2 | null, selected: readonly string[] = useTimeline.getState().selectedClipIds): string[] {
  if (!seq || !selected.length) return [];
  const ids = clipIdsOf(seq);
  return selected.filter((id) => ids.has(id));
}

function ctxNow() {
  return makeSeqCtx(useProject.getState().media, useEdits.getState().audioMedia);
}

// ============================================================================
// 守門
// ============================================================================

export function needsSequenceFlag(): Enabled {
  return sequenceEditingEnabled() ? OK : { ok: false, why: FLAG_WHY };
}

/** 序列空間、有 proxy（隱含序列要 proxy 的幀數才畫得出來）。 */
export function needsSequenceSpace(): Enabled {
  const f = needsSequenceFlag();
  if (!f.ok) return f;
  const p = needsProxy();
  if (!p.ok) return p;
  if (!inSequenceSpace()) return { ok: false, why: SPACE_WHY };
  return viewSequenceNow() ? OK : { ok: false, why: "還沒有 proxy（引擎就緒後會自動建）" };
}

function needsSequencePlayhead(): Enabled {
  const s = needsSequenceSpace();
  if (!s.ok) return s;
  return sequencePlayheadNow(viewSequenceNow()!) === null ? { ok: false, why: PLAYHEAD_WHY } : OK;
}

export function needsClipSelection(): Enabled {
  const s = needsSequenceSpace();
  if (!s.ok) return s;
  return selectedClipIdsIn(viewSequenceNow()).length ? OK : { ok: false, why: SELECTION_WHY };
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

// ============================================================================
// 分割 / 合併切點（B、Ctrl+\、Ctrl+Shift+\）
// ============================================================================

export type SplitPlan = { kind: "split" | "join"; t: number; target: SplitTarget } | { kind: "none"; why: string };

/**
 * 在序列幀 t 按下分割鍵要做什麼（純函式）：
 * 1. 剛好在「可以合併」的切點上 → 合併（ai-music-cut「再按一次 B 移除切點」）；
 * 2. 選取的片段有跨過 t 的 → 只切那幾個（Resolve：有選取就切選取的）；
 * 3. 否則切 base（B = 只切 V1、Ctrl+Shift+\ = 所有未鎖定的軌）；
 * 4. 什麼都切不到 → 回原因（在剪輯點或空白上）。
 * 用 ops 的「沒變回同一個參照」判斷切不切得到，規則只有 ops.ts 一份。
 */
export function planSplit(seq: SequenceV2, t: number, base: "v1" | "all", selected: readonly string[], ctx = ctxNow()): SplitPlan {
  if (canJoinAt(seq, t, ctx, base)) return { kind: "join", t, target: base };
  const s = samplesOfFrame(t, seq.fps);
  const p = placedAt(placeVideo(seq), t);
  const covering = selected.filter((id) => (p && p.item.id === id && t > p.t0) || seq.audioLanes.some((l) => !l.locked && l.clips.some((c) => c.id === id && c.start < s && s < c.start + c.length)));
  const target: SplitTarget = covering.length ? covering : base;
  if (splitAt(seq, t, ctx, target) !== seq) return { kind: "split", t, target };
  return { kind: "none", why: "播放線在剪輯點或空白上，沒有可以分割的片段" };
}

function splitPlanNow(base: "v1" | "all"): SplitPlan {
  const seq = viewSequenceNow();
  const t = seq ? sequencePlayheadNow(seq) : null;
  if (!seq || t === null) return { kind: "none", why: PLAYHEAD_WHY };
  return planSplit(seq, t, base, selectedClipIdsIn(seq));
}

function needsSplit(base: "v1" | "all"): () => Enabled {
  return () => {
    const p = needsSequencePlayhead();
    if (!p.ok) return p;
    const plan = splitPlanNow(base);
    return plan.kind === "none" ? { ok: false, why: plan.why } : OK;
  };
}

/**
 * 分割 / 合併：一律走 editSequence，隱含序列在同一筆 commit 裡實體化（一次 Ctrl+Z 回到 null）。
 * 計畫在 run 當下重算：選單開著時播放線可能已經移動。
 */
export function runSplit(base: "v1" | "all"): boolean {
  const plan = splitPlanNow(base);
  if (plan.kind === "none") {
    toast.info(t(plan.why));
    return false;
  }
  return useEdits.getState().editSequence(plan.kind === "join" ? L.join : L.split, (s, ctx) => (plan.kind === "join" ? joinThroughEdit(s, plan.t, ctx, plan.target) : splitAt(s, plan.t, ctx, plan.target)));
}

/** 在指定的序列幀、只切指定的片段（右鍵「在這裡分割」）。切不到回 false。 */
export function splitClipAt(clipId: string, frame: number): boolean {
  return useEdits.getState().editSequence(L.split, (s, ctx) => splitAt(s, frame, ctx, [clipId]));
}

/** 右鍵「在這裡分割（所有軌）」的守門：這個位置切得到東西嗎（不含合併：右鍵是明確的「切」）。 */
export function canSplitAt(frame: number, target: SplitTarget): Enabled {
  const s = needsSequenceSpace();
  if (!s.ok) return s;
  const seq = viewSequenceNow()!;
  return splitAt(seq, frame, ctxNow(), target) !== seq ? OK : { ok: false, why: "這裡沒有可以分割的片段（在剪輯點或空白上）" };
}

/** 在指定的序列幀分割（右鍵「在這裡分割所有軌」；target 同 ops.splitAt）。 */
export function splitAtFrame(frame: number, target: SplitTarget): boolean {
  return useEdits.getState().editSequence(L.split, (s, ctx) => splitAt(s, frame, ctx, target));
}

/** 刪除空白（後面接上）：空白的波紋刪除。 */
export function closeGap(gapId: string): Promise<void> {
  return withUndoToast(t("已刪除空白"), () => {
    useEdits.getState().editSequence(L.rippleDelete, (s, ctx) => rippleDelete(s, [gapId], ctx));
  });
}

/**
 * 在序列幀 t（吸到最近的剪輯點）插入目前媒體整段（右鍵「在這裡插入目前媒體」）。
 * fps / 尺寸不符時 ops 擲 SequenceError，runCommandObject 接住並 toast（「請以 30/1 fps 重建 … 的 proxy」）。
 */
export function insertActiveMediaAt(frame: number): boolean {
  const id = useProject.getState().activeMediaId;
  if (!id) return false;
  return useEdits.getState().editSequence(L.addMedia, (s, ctx) => {
    const m = ctx.media(id);
    return m ? insertMedia(s, m, frame, ctx) : null;
  });
}

// ============================================================================
// 刪除（依焦點派發，§10.1）
// ============================================================================

export type DeleteKind = "delete" | "deleteAlt";

export interface DeleteDispatchState {
  /** 旗標開而且在序列空間。 */
  sequenceSpace: boolean;
  focus: TimelineFocus;
  /** 有選取、而且還存在於序列的片段。 */
  hasClipSelection: boolean;
}

/**
 * Delete / Shift+Delete 要轉給哪個指令（純函式，§10.1 的表；七種情況各有一個測試）：
 *
 * | 焦點 | Delete | Shift+Delete |
 * |---|---|---|
 * | clip | sequence.rippleDelete | sequence.lift |
 * | range | sequence.extractRange | sequence.liftRange |
 * | envPoint | 刪自動化點 | 刪自動化點 |
 * | keyframe | edit.deleteKeyframe | edit.deleteTrack |
 * | track | 停用（先選片段、範圍或關鍵幀） | edit.deleteTrack |
 * | 無 | 有選取片段 → 同 clip；否則停用 | 同左 |
 *
 * 旗標關或在素材空間：M1 原樣（Delete＝移除關鍵幀、Shift+Delete＝刪除追蹤）—— 素材空間看不到片段，刪片段只會嚇到人。
 */
export function deleteDispatch(kind: DeleteKind, st: DeleteDispatchState): { id: string } | { why: string } {
  const pick = (a: string, b: string) => ({ id: kind === "delete" ? a : b });
  if (!st.sequenceSpace) return pick("edit.deleteKeyframe", "edit.deleteTrack");
  const focus = st.focus ?? (st.hasClipSelection ? "clip" : null);
  switch (focus) {
    case "clip":
      return pick("sequence.rippleDelete", "sequence.lift");
    case "range":
      return pick("sequence.extractRange", "sequence.liftRange");
    case "envPoint":
      return { id: ENVELOPE_POINT_DELETE_COMMAND };
    case "keyframe":
      return pick("edit.deleteKeyframe", "edit.deleteTrack");
    case "track":
      return kind === "delete" ? { why: FOCUS_WHY } : { id: "edit.deleteTrack" };
    default:
      return { why: FOCUS_WHY };
  }
}

export function deleteDispatchStateNow(): DeleteDispatchState {
  const seqSpace = inSequenceSpace();
  return {
    sequenceSpace: seqSpace,
    focus: useTimeline.getState().focus,
    hasClipSelection: seqSpace && selectedClipIdsIn(viewSequenceNow()).length > 0,
  };
}

/**
 * 狀態列的「按 Delete 會怎樣」提示（§10.1「Delete：波紋刪除 2 個片段」）；序列空間以外、或 Delete 現在不能做時回 null。
 * 已經 t() 過，直接顯示。
 */
export function deleteHintText(): string | null {
  const st = deleteDispatchStateNow();
  if (!st.sequenceSpace) return null;
  const d = deleteDispatch("delete", st);
  if ("why" in d) return null;
  const c = command(d.id);
  if (!c || !c.enabled().ok) return null;
  switch (d.id) {
    case "sequence.rippleDelete":
      return t("Delete：波紋刪除 {n} 個片段", { n: selectedClipIdsIn(viewSequenceNow()).length });
    case "sequence.extractRange": {
      const r = useTimeline.getState().range;
      return t("Delete：提取範圍（{n} 幀）", { n: r ? r.out - r.in : 0 });
    }
    case "edit.deleteKeyframe":
      return t("Delete：移除關鍵幀");
    case ENVELOPE_POINT_DELETE_COMMAND:
      return t("Delete：刪除自動化點");
    default:
      return null;
  }
}

/** 派發指令：enabled / run 都轉給目標指令，灰掉的原因就是目標的原因（toast 講的是真正缺什麼）。 */
function dispatcher(target: () => { id: string } | { why: string }): Pick<Command, "enabled" | "run"> {
  return {
    enabled: () => {
      const d = target();
      if ("why" in d) return { ok: false, why: d.why };
      const c = command(d.id);
      return c ? c.enabled() : { ok: false, why: NOT_YET_WHY };
    },
    run: () => {
      const d = target();
      if ("why" in d) return;
      // 外層 runCommandObject 已經問過 enabled；這裡直接跑目標，免得同一句停用原因 toast 兩次
      return command(d.id)?.run();
    },
  };
}

/**
 * 將選取的片段變成範圍（Final Cut 的 Mark Clip）。把「選這段 → 播它 / 刪它」從三步變兩步：
 * 按 X 之後焦點就是 range，接著 Delete 走 extractRange、`/` 走 playRange。
 */
function markSelectionAsRange(): void {
  const seq = viewSequenceNow();
  const span = seq ? selectionSpan(seq, selectedClipIdsIn(seq)) : null;
  if (span) useTimeline.getState().setRange(span);
}

function removedToast(n: number, gap: boolean): string {
  return gap ? t("已刪除 {n} 個片段（留空隙）", { n }) : t("已波紋刪除 {n} 個片段", { n });
}

async function deleteSelected(gap: boolean): Promise<void> {
  const seq = viewSequenceNow();
  const ids = selectedClipIdsIn(seq);
  if (!ids.length) return;
  let changed = false;
  await withUndoToast(removedToast(ids.length, gap), () => {
    changed = useEdits.getState().editSequence(gap ? L.lift : L.rippleDelete, (s, ctx) => (gap ? lift(s, ids) : rippleDelete(s, ids, ctx)));
  });
  if (!changed) {
    toast.info(t(gap ? "選取的只有空白或鎖定音軌上的片段，沒有東西被刪除" : "沒有可以刪除的片段（鎖定音軌上的片段不會被刪）"));
    return;
  }
  // 刪掉的片段不在了；留空隙時 V1 片段換成新的空白 id，舊選取一樣失效。清掉選取＝焦點回到無（下一次 Delete 不會誤刪別的）
  useTimeline.getState().selectClips([]);
}

async function deleteRange(gap: boolean): Promise<void> {
  const r = useTimeline.getState().range;
  if (!r) return;
  const n = r.out - r.in;
  let changed = false;
  await withUndoToast(gap ? t("已移除範圍（留空隙，{n} 幀）", { n }) : t("已提取範圍（{n} 幀）", { n }), () => {
    changed = useEdits.getState().editSequence(gap ? L.liftRange : L.extractRange, (s, ctx) => (gap ? liftRange(s, r) : extractRange(s, r, ctx)));
  });
  if (!changed) {
    toast.info(t("範圍裡沒有可以移除的畫面"));
    return;
  }
  // 提取之後那段時間已經不存在，範圍留著的話再按一次 Delete 會把後面接上來的畫面也刪掉（Premiere 的 Extract 也會清掉入出點）。
  // 留空隙不清：範圍正好框住新的空白，接著要放東西進去剛好用得到
  if (!gap) useTimeline.getState().setRange(null);
}

// ============================================================================
// 修剪到播放線（Ctrl+Shift+[ / ]，M2.13；Resolve Ripple Start/End to Playhead）
// ============================================================================

/** trimToPlayheadCheck 的原因 → 灰掉時講給使用者聽的 zh key。 */
const TRIM_WHY = {
  noSequence: "還沒有 proxy（引擎就緒後會自動建）",
  noPlayhead: PLAYHEAD_WHY,
  notOnClip: "播放線要停在片段上",
  atEdit: "播放線在切點上，沒有東西可修剪",
} as const;

function needsTrimToPlayhead(): Enabled {
  const s = needsSequenceSpace();
  if (!s.ok) return s;
  const seq = viewSequenceNow();
  const c = trimToPlayheadCheck(seq, seq && sequencePlayheadNow(seq));
  return c.ok ? OK : { ok: false, why: TRIM_WHY[c.reason] };
}

/**
 * 修剪開頭 / 結尾到播放線：一律波紋（V1 後面的片段與同步鎖軌跟著移）。
 * 播放線位置在 run 當下重算（選單開著時播放線可能已經動了）；隱含序列在同一筆 undo 裡實體化。
 */
/** 片段剪貼簿：跟系統剪貼簿一樣是 session 內的東西 —— 不進 undo、不存檔。 */
let clipBoard: ClipSeed[] = [];

function runCopyClips(): void {
  const seq = viewSequenceNow();
  const seeds = seq ? copyClips(seq, selectedClipIdsIn(seq)) : [];
  if (!seeds.length) return;
  clipBoard = seeds;
  toast.success(t("已複製 {n} 個片段", { n: seeds.length }));
}

/**
 * 剪下（Ctrl+X）= 抄進剪貼簿 + 波紋刪除。
 *
 * **只動 V1 片段**，跟複製 / 貼上一致：copyClips 抄不到音訊片段，若連它們一起刪掉
 * 就會變成「刪了卻貼不回來」的資料遺失。選取裡的音訊片段原封不動。
 *
 * 剪貼簿在刪除**成功之後**才寫入：什麼都沒刪掉（整批都在鎖定軌上）時不該把舊的剪貼簿蓋掉。
 * 剪貼簿是 session 狀態不進 undo，所以 Ctrl+Z 之後片段回來、複本還在（跟系統剪貼簿一樣）。
 */
async function runCutClips(): Promise<void> {
  const seq = viewSequenceNow();
  if (!seq) return;
  const sel = new Set(selectedClipIdsIn(seq));
  const ids = seq.video.filter((it) => it.kind === "clip" && sel.has(it.id)).map((it) => it.id);
  const seeds = copyClips(seq, ids);
  if (!seeds.length) {
    toast.info(t("選取裡沒有可以剪下的 V1 片段"));
    return;
  }
  let changed = false;
  await withUndoToast(t("已剪下 {n} 個片段", { n: seeds.length }), () => {
    changed = useEdits.getState().editSequence(L.rippleDelete, (s, ctx) => rippleDelete(s, ids, ctx));
  });
  if (!changed) return;
  clipBoard = seeds;
  useTimeline.getState().selectClips([]);
}

function needsClipboard(): Enabled {
  const s = needsSequenceSpace();
  if (!s.ok) return s;
  return clipBoard.length ? OK : { ok: false, why: "剪貼簿是空的" };
}

/** 貼在播放線（吸到最近的剪輯點）；播放線不在序列裡就接到結尾，跟 insertMedia 一致。 */
function runPasteClips(): Promise<void> | undefined {
  const seq = viewSequenceNow();
  if (!seq || !clipBoard.length) return undefined;
  const have = new Set(useProject.getState().media.map((m) => m.id));
  const seeds = clipBoard.filter((c) => have.has(c.mediaId));
  if (!seeds.length) {
    toast.error(t("複製的片段所屬媒體已不在專案裡"));
    return undefined;
  }
  const at = sequencePlayheadNow(seq) ?? durationFrames(seq);
  return withUndoToast(t("已貼上片段"), () => void useEdits.getState().editSequence(L.paste, (s, ctx) => pasteClips(s, seeds, at, ctx)));
}

/** 複製選取的片段：複本各自接在原片段後面，整批算一筆 undo。 */
function runDuplicate(): Promise<void> | undefined {
  const seq = viewSequenceNow();
  const ids = selectedClipIdsIn(seq);
  if (!seq || !ids.length) return undefined;
  return withUndoToast(t("已複製片段"), () => void useEdits.getState().editSequence(L.duplicate, (s, ctx) => ids.reduce((acc, id) => duplicateClip(acc, id, ctx), s)));
}

/** 滑移 / 滑內容一次只能對一個片段：選了兩個以上，「往右一幀」要誰讓出時間沒有明確答案。 */
function needsOneClip(): Enabled {
  const s = needsClipSelection();
  if (!s.ok) return s;
  return selectedClipIdsIn(viewSequenceNow()).length === 1 ? OK : { ok: false, why: "一次只能對一個片段做這個動作" };
}

/** 滑移一幀（, / .）：左右鄰居吸收位移，片段內容與序列總長都不變。 */
function runNudge(dir: -1 | 1): Promise<void> | undefined {
  const seq = viewSequenceNow();
  const ids = selectedClipIdsIn(seq);
  if (!seq || ids.length !== 1) return undefined;
  return withUndoToast(t("已滑移片段"), () => void useEdits.getState().editSequence(L.slide, (s, ctx) => slideClip(s, ids[0], dir, ctx)));
}

/**
 * 延伸編輯（Premiere Extend Edit）：把選取片段**離播放線較近的那個剪接點**移到播放線。
 * 走 roll 不走波紋 —— 序列總長不變、後面的東西不會被搬走，這正是它與 Ctrl+Shift+[ / ] 的差別。
 */
function runExtendEdit(): Promise<void> | undefined {
  const seq = viewSequenceNow();
  const at = seq && sequencePlayheadNow(seq);
  const ids = selectedClipIdsIn(seq);
  if (!seq || at == null || ids.length !== 1) return undefined;
  const p = placeVideo(seq).find((x) => x.item.id === ids[0]);
  if (!p) return undefined;
  const edge = at <= p.t0 ? p.t0 : at >= p.t1 ? p.t1 : at - p.t0 <= p.t1 - at ? p.t0 : p.t1;
  return withUndoToast(t("已延伸編輯"), () => void useEdits.getState().editSequence(L.roll, (s, ctx) => rollEdit(s, edge, at - edge, ctx)));
}

/**
 * 那個方向真的動得了嗎。動不了要**講原因**，而不是按下去靜默沒反應 ——
 * 頭尾的片段沒有鄰居可以吸收位移（那是波紋不是滑移）、來源用到頭了就滑不出更多內容。
 */
function needsRoom(kind: "slide" | "slip", dir: -1 | 1): () => Enabled {
  return () => {
    const s = needsOneClip();
    if (!s.ok) return s;
    const seq = viewSequenceNow();
    const id = seq ? selectedClipIdsIn(seq)[0] : null;
    if (!seq || !id) return s;
    const cap = kind === "slide" ? slideCapacity(seq, id, ctxNow()) : slipCapacity(seq, id, ctxNow());
    if ((dir > 0 ? cap.right : cap.left) > 0) return OK;
    return { ok: false, why: kind === "slide" ? "這個方向沒有鄰居可以吸收位移" : "來源在這個方向已經到頭了" };
  };
}

/** 在序列的這一端就換不了位置了 —— 灰掉並講原因，不要按了沒反應。 */
function needsReorder(dir: -1 | 1): () => Enabled {
  return () => {
    const s = needsOneClip();
    if (!s.ok) return s;
    const seq = viewSequenceNow();
    const id = seq ? selectedClipIdsIn(seq)[0] : null;
    if (!seq || !id) return s;
    const j = seq.video.findIndex((it) => it.id === id) + dir;
    return j >= 0 && j < seq.video.length ? OK : { ok: false, why: "已經在序列的這一端了" };
  };
}

/** 跟相鄰項目對調（重新排序）：序列總長與後面的項目都不動，聲音也不跟著跳。 */
function runMoveItem(dir: -1 | 1): Promise<void> | undefined {
  const seq = viewSequenceNow();
  const ids = selectedClipIdsIn(seq);
  if (!seq || ids.length !== 1) return undefined;
  return withUndoToast(t("已調整順序"), () => void useEdits.getState().editSequence(L.reorder, (s) => moveItemBy(s, ids[0], dir)));
}

/** 滑內容一幀：位置不動、只換來源區間（跟 nudge 正好互補）。 */
function runSlip(dir: -1 | 1): Promise<void> | undefined {
  const seq = viewSequenceNow();
  const ids = selectedClipIdsIn(seq);
  if (!seq || ids.length !== 1) return undefined;
  return withUndoToast(t("已滑內容"), () => void useEdits.getState().editSequence(L.slip, (s, ctx) => slipClip(s, ids[0], dir, ctx)));
}

/** 在播放線加標記。 */
function runAddMarker(): Promise<void> | undefined {
  const seq = viewSequenceNow();
  const at = seq && sequencePlayheadNow(seq);
  if (!seq || at == null) return undefined;
  return withUndoToast(t("已加入標記"), () => void useEdits.getState().editSequence(L.addMarker, (s) => addMarker(s, at)));
}

function markerHere(): MarkerV2 | null {
  const seq = viewSequenceNow();
  const at = seq && sequencePlayheadNow(seq);
  return seq && at != null ? markerAt(seq, at) : null;
}

function needsMarkerHere(): Enabled {
  const s = needsPlayheadInSequence();
  if (!s.ok) return s;
  return markerHere() ? OK : { ok: false, why: "播放線上沒有標記" };
}

function runDeleteMarker(): Promise<void> | undefined {
  const m = markerHere();
  if (!m) return undefined;
  return withUndoToast(t("已刪除標記"), () => void useEdits.getState().editSequence(L.deleteMarker, (s) => removeMarker(s, m.id)));
}

/** 改播放線上標記的字。加標記維持即時（Ctrl+M 按了就有），事後再命名 —— 跟 Premiere 一樣。 */
async function runRenameMarker(): Promise<void> {
  const m = markerHere();
  if (!m) return;
  const v = await uiPrompt(t("標記的字"), { defaultValue: m.name, placeholder: t("例如：這裡要配樂"), confirmText: t("儲存") });
  if (v == null) return;
  await withUndoToast(t("已改標記的字"), () => void useEdits.getState().editSequence(L.renameMarker, (s) => renameMarker(s, m.id, v.trim())));
}

/** 跳到前 / 後一個標記（沒有就不動）。 */
function runGoMarker(dir: -1 | 1): void {
  const seq = viewSequenceNow();
  const at = seq && sequencePlayheadNow(seq);
  if (!seq || at == null) return;
  const m = markerNear(seq, at, dir);
  if (m) seekSequenceNow(m.t);
}

/**
 * 重新命名選取的片段（Premiere / Resolve 的 rename clip）。
 * 時間軸本來就會優先顯示這個名字，只是一直沒有地方可以設。多選時整批同名（那是「標成同一類」的用法）。
 */
async function runRenameClip(): Promise<void> {
  const seq = viewSequenceNow();
  const ids = selectedClipIdsIn(seq);
  if (!seq || !ids.length) return;
  const cur = seq.video.find((it) => it.kind === "clip" && it.id === ids[0]);
  const now = cur && cur.kind === "clip" ? (cur.label ?? "") : "";
  const v = await uiPrompt(t("片段的名字"), { defaultValue: now, placeholder: t("留空 = 用媒體的檔名"), confirmText: t("儲存") });
  if (v == null) return;
  await withUndoToast(t("已重新命名"), () => void useEdits.getState().editSequence(L.rename, (s) => setClipLabel(s, ids, v)));
}

/**
 * 把偵測到的鏡頭切點套用到序列（Resolve 的 Scene Cut Detection → 一鍵把長鏡頭切成片段）。
 *
 * 鏡頭是**每支媒體**偵測的（來源幀），所以要先投影到序列時間；剪過的序列重複用同一段來源時，
 * 每個出現的位置都會被切。分割不波紋，所以幀座標不會因為先切了誰而位移，順序無所謂。
 * 已經是剪輯點的位置 splitAt 自己會跳過。
 */
function runSplitAtShots(): Promise<void> | undefined {
  const seq = viewSequenceNow();
  if (!seq) return undefined;
  const shots = useEdits.getState().shots;
  const ids = new Set<string>();
  for (const it of seq.video) if (it.kind === "clip") ids.add(it.mediaId);
  const ts = new Set<number>();
  for (const id of ids) {
    const ks = (shots[id] ?? []).map((sh) => sh.startFrame).filter((k) => k > 0);
    for (const t2 of projectFrames(seq, id, ks)) ts.add(t2);
  }
  const at = [...ts].sort((a, b) => a - b).filter((t2) => t2 > 0);
  if (!at.length) {
    toast.info(t("沒有鏡頭切點可以套用（先在素材空間按「偵測鏡頭」）"));
    return undefined;
  }
  return withUndoToast(t("已在 {n} 個鏡頭切點分割", { n: at.length }), () => void useEdits.getState().editSequence(L.splitAtShots, (s, ctx) => at.reduce((acc, t2) => splitAt(acc, t2, ctx), s)));
}

/** 某個音訊來源的波形與原生取樣率（影片的原音或匯入的音訊媒體）；拿不到就 null。 */
function sourcePeaks(src: AudioSourceRefV2): { peaks: PeakSource; rate: number } | null {
  if (src.type === "media") {
    const m = useProject.getState().media.find((x) => x.id === src.mediaId);
    const mip = m ? peaksOf(peaksSourceOfMedia(m).fingerprint) : null;
    const rate = m?.audio?.sampleRate;
    return mip && rate ? { peaks: mip.peaks, rate } : null;
  }
  const am = useEdits.getState().audioMedia.find((x) => x.id === src.audioId);
  const mip = am ? peaksOf(peaksSourceOfAudioMedia(am).fingerprint) : null;
  const rate = am?.audio?.sampleRate;
  return mip && rate ? { peaks: mip.peaks, rate } : null;
}

/**
 * 正規化選取片段的音量（每個剪輯器都有的 Normalize）：各自量自己的真實峰值，推到 −1 dBFS。
 *
 * 逐片段算 —— 整批套同一個增益不叫正規化，那只是調音量。
 * V1 片段的區間是幀、音軌片段是**來源樣本**（length 是序列樣本，要先換回來源的取樣率），
 * 兩條路在 loudness.ts 共用同一個峰值核心。
 * 波形還沒算好、或整段是數位靜音的片段跳過（後者要加無限大增益），而且**講出跳過幾個**。
 */
function runNormalize(): Promise<void> | undefined {
  const seq = viewSequenceNow();
  if (!seq) return undefined;
  const sel = new Set(selectedClipIdsIn(seq));
  const media = useProject.getState().media;
  const byId = new Map<string, number>();
  let skipped = 0;
  for (const it of seq.video) {
    if (it.kind !== "clip" || !sel.has(it.id)) continue;
    const m = media.find((x) => x.id === it.mediaId);
    const mip = m ? peaksOf(peaksSourceOfMedia(m).fingerprint) : null;
    const db = mip ? peakDbOfRange(mip.peaks, seq.fps, it.srcIn, it.srcOut) : null;
    if (db == null) {
      skipped++;
      continue;
    }
    byId.set(it.id, normalizeGainDb(db));
  }
  for (const l of seq.audioLanes) {
    if (l.locked) continue;
    for (const c of l.clips) {
      if (!sel.has(c.id)) continue;
      const sp = sourcePeaks(c.source);
      const db = sp ? peakDbOfSamples(sp.peaks, sp.rate, c.srcIn, c.srcIn + (c.length * sp.rate) / SEQ_SAMPLE_RATE) : null;
      if (db == null) {
        skipped++;
        continue;
      }
      byId.set(c.id, normalizeGainDb(db));
    }
  }
  if (!byId.size) {
    toast.info(t("沒有可以正規化的片段（波形還沒算好，或整段是靜音）"));
    return undefined;
  }
  const msg = skipped ? t("已正規化 {n} 個片段，跳過 {s} 個", { n: byId.size, s: skipped }) : t("已正規化 {n} 個片段", { n: byId.size });
  return withUndoToast(msg, () => void useEdits.getState().editSequence(L.normalize, (s) => setGainsById(s, byId)));
}

/** 全選可以動的片段：V1 片段與未鎖定音軌上的音訊片段（空白沒有身分、鎖定軌選了也動不了）。 */
function allSelectableIds(seq: SequenceV2 | null): string[] {
  if (!seq) return [];
  return [...seq.video.filter((it) => it.kind === "clip").map((it) => it.id), ...seq.audioLanes.filter((l) => !l.locked).flatMap((l) => l.clips.map((c) => c.id))];
}

function needsSelectable(): Enabled {
  const s = needsSequenceSpace();
  if (!s.ok) return s;
  return allSelectableIds(viewSequenceNow()).length ? OK : { ok: false, why: "序列裡沒有可以選的片段" };
}

/** 選取播放線正下方的片段（播放線在空隙上就清掉選取）。 */
function runSelectAtPlayhead(): void {
  const seq = viewSequenceNow();
  const at = seq && sequencePlayheadNow(seq);
  if (!seq || at == null) return;
  const hit = placedAt(placeVideo(seq), at);
  useTimeline.getState().selectClips(hit && hit.item.kind === "clip" ? [hit.item.id] : []);
}

/** 播放線要落在序列上才能在那裡插東西。 */
function needsPlayheadInSequence(): Enabled {
  const s = needsSequenceSpace();
  if (!s.ok) return s;
  const seq = viewSequenceNow();
  return seq && sequencePlayheadNow(seq) !== null ? OK : { ok: false, why: PLAYHEAD_WHY };
}

/** Final Cut 的 Insert Gap（⌥W）預設插 3 秒。 */
const GAP_SECONDS = 3;

/** 在播放線插入一段空白：後面往後推，同步鎖軌一起讓出同樣長的時間。 */
function runInsertGap(): Promise<void> | undefined {
  const seq = viewSequenceNow();
  const at = seq && sequencePlayheadNow(seq);
  if (!seq || at == null) return undefined;
  const n = Math.max(1, Math.round((GAP_SECONDS * seq.fps.num) / seq.fps.den));
  return withUndoToast(t("已插入空白"), () => void useEdits.getState().editSequence(L.insertGap, (s, ctx) => insertGap(s, at, n, ctx)));
}

function runTrimToPlayhead(edge: "in" | "out"): Promise<void> | undefined {
  const seq = viewSequenceNow();
  const at = seq && sequencePlayheadNow(seq);
  if (!seq || at == null) return undefined;
  return withUndoToast(t("已修剪片段"), () => void useEdits.getState().editSequence(L.trim, (s, ctx) => rippleTrimToPlayhead(s, at, edge, ctx)));
}

// ============================================================================
// 加媒體到序列 / 匯入音訊（M2.14）
// ============================================================================

/**
 * 把作用中媒體接到序列結尾 / 插在播放線（最近的剪輯點）。fps / 尺寸不符時 addMediaToSequence 自己顯示可操作的錯誤
 * （複製轉檔指令、建 proxy），所以守門只看「有沒有 proxy」—— 事先試跑一次 ops 來灰掉，使用者就看不到那顆修正按鈕了。
 */
function runAddActiveMedia(mode: "append" | "insert" | "overwrite"): void {
  const id = useProject.getState().activeMediaId;
  if (id) addMediaToSequence(id, mode);
}

// ============================================================================
// 停用 / 對應幀 / 剪輯點
// ============================================================================

/** D 的對象：選取裡的 V1 片段與音訊片段（空白沒有啟用狀態）。 */
function toggleTargets(seq: SequenceV2 | null): { ids: string[]; allDisabled: boolean } {
  if (!seq) return { ids: [], allDisabled: false };
  const sel = new Set(selectedClipIdsIn(seq));
  const states: { id: string; enabled: boolean }[] = [];
  for (const it of seq.video) if (it.kind === "clip" && sel.has(it.id)) states.push({ id: it.id, enabled: it.enabled });
  for (const l of seq.audioLanes) for (const c of l.clips) if (sel.has(c.id)) states.push({ id: c.id, enabled: c.enabled });
  return { ids: states.map((s) => s.id), allDisabled: states.length > 0 && states.every((s) => !s.enabled) };
}

function needsToggleTarget(): Enabled {
  const s = needsClipSelection();
  if (!s.ok) return s;
  return toggleTargets(viewSequenceNow()).ids.length ? OK : { ok: false, why: "選取的只有空白，沒有片段可以停用" };
}

/** 選取全部是停用的 → 啟用；只要有一個是啟用的 → 全部停用（Premiere Enable 對混合選取的做法：先統一成停用）。 */
function runToggleEnabled(): boolean {
  const { ids, allDisabled } = toggleTargets(viewSequenceNow());
  if (!ids.length) return false;
  return useEdits.getState().editSequence(allDisabled ? L.enable : L.disable, (s) => setEnabled(s, ids, allDisabled));
}

/**
 * Workspace 換作用中媒體時會在 effect 裡把播放線歸零、清範圍（shell/Workspace.tsx）；
 * 對應幀要跳到別支媒體的 k，得等那個 effect 跑完再 seek，不然剛設好的位置馬上被歸零。兩個 rAF 保證 React 已經 commit 並跑完 effect。
 */
function afterMediaSwitch(fn: () => void): void {
  if (typeof requestAnimationFrame !== "function") {
    setTimeout(fn, 0);
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/** 在素材空間開啟某支媒體的第 k 幀（對應幀、右鍵「在素材中開啟」共用）。then 在 seek 之後跑（例如新增追蹤）。 */
export function openInSource(mediaId: string, k: number, then?: () => void): void {
  useTimeline.getState().setSpace("source");
  const go = () => {
    A.seekTo(k);
    then?.();
  };
  if (useProject.getState().activeMediaId === mediaId) go();
  else {
    useProject.getState().setActive(mediaId);
    afterMediaSwitch(go);
  }
}

export type MatchFramePlan = { dir: "toSource"; mediaId: string; k: number } | { dir: "toSequence"; t: number } | { dir: "none"; why: string };

/**
 * F（§9.1）：序列空間 → 播放線片段的來源幀（停用的片段也算，它的畫面還在）；素材空間 → 序列裡第一個用到這個 k 的位置。
 */
export function planMatchFrame(seq: SequenceV2, space: "sequence" | "source", activeMediaId: string | null, k: number, seqT: number | null): MatchFramePlan {
  if (space === "sequence") {
    if (seqT === null) return { dir: "none", why: PLAYHEAD_WHY };
    const m = mapFrame(seq, seqT);
    if (m.item?.kind !== "clip" || m.itemK === null) return { dir: "none", why: "播放線在空白上，沒有對應的來源幀" };
    return { dir: "toSource", mediaId: m.item.mediaId, k: m.itemK };
  }
  for (const p of placeVideo(seq)) {
    const it = p.item;
    if (it.kind === "clip" && it.mediaId === activeMediaId && k >= it.srcIn && k < it.srcOut) return { dir: "toSequence", t: p.t0 + (k - it.srcIn) };
  }
  return { dir: "none", why: "這一幀沒有用在序列裡" };
}

function matchFramePlanNow(): MatchFramePlan {
  const seq = viewSequenceNow();
  if (!seq) return { dir: "none", why: "還沒有 proxy（引擎就緒後會自動建）" };
  const space = inSequenceSpace() ? "sequence" : "source";
  return planMatchFrame(seq, space, useProject.getState().activeMediaId, usePlayback.getState().frame, space === "sequence" ? sequencePlayheadNow(seq) : null);
}

function needsMatchFrame(): Enabled {
  const f = needsSequenceFlag();
  if (!f.ok) return f;
  const p = needsProxy();
  if (!p.ok) return p;
  const plan = matchFramePlanNow();
  return plan.dir === "none" ? { ok: false, why: plan.why } : OK;
}

function runMatchFrame(): void {
  const plan = matchFramePlanNow();
  if (plan.dir === "toSource") openInSource(plan.mediaId, plan.k);
  else if (plan.dir === "toSequence") {
    // 播放線的 k 不變，序列時間軸的播放線自己會落在第一次出現的位置；切空間就好
    useTimeline.getState().setSpace("sequence");
    seekSequenceNow(plan.t);
  }
}

/** 序列空間的 seek（M2.11 的序列播放器接手之前，frametimeline/useSequenceTimeline.seekSequence 是退路）。 */
export function seekSequenceNow(tt: number): void {
  const seq = viewSequenceNow();
  if (!seq) return;
  const placed = placeVideo(seq);
  seekSequence({ seq, placed, frames: durationFrames(seq) }, tt);
}

/** 上 / 下一個剪輯點（純函式）：0、每個項目的邊界、T；T 沒有畫面，夾到最後一幀。沒有了回 null。 */
export function neighborEditPoint(seq: SequenceV2, t: number, dir: 1 | -1): number | null {
  const T = durationFrames(seq);
  if (T <= 0) return null;
  const pts = editPoints(seq).map((p) => Math.min(p, T - 1));
  const hit = dir > 0 ? pts.find((p) => p > t) : [...pts].reverse().find((p) => p < t);
  return hit ?? null;
}

function needsEditPoint(dir: 1 | -1): () => Enabled {
  return () => {
    const p = needsSequencePlayhead();
    if (!p.ok) return p;
    const seq = viewSequenceNow()!;
    return neighborEditPoint(seq, sequencePlayheadNow(seq)!, dir) === null ? { ok: false, why: dir > 0 ? "後面沒有剪輯點了" : "前面沒有剪輯點了" } : OK;
  };
}

function runEditPoint(dir: 1 | -1): void {
  const seq = viewSequenceNow();
  const t0 = seq ? sequencePlayheadNow(seq) : null;
  if (!seq || t0 === null) return;
  const p = neighborEditPoint(seq, t0, dir);
  if (p !== null) seekSequenceNow(p);
}

// ============================================================================
// 指令表
// ============================================================================

/** 旗標開關都成立的快捷鍵接手：原主人改成只顯示（shortcutManual），真正派發的是下面的派發指令。 */
const DISPATCHED_BY: Record<string, string> = {
  "edit.deleteKeyframe": "edit.delete",
  "edit.deleteTrack": "edit.deleteAlt",
  "captions.splitAtPlayhead": "edit.split",
  "playback.prevShot": "playback.prevEditOrShot",
  "playback.nextShot": "playback.nextEditOrShot",
  "playback.markShot": "playback.markClipOrShot",
};

/**
 * 把 M1 / 字幕指令的鍵交給派發指令（回傳新陣列，不改原物件：commands.test 還會拿原表驗 M1 自己不撞鍵）。
 * commands/index.ts 登記前一定要過這一關，不然 Delete / B / ↑↓ 會同時打到兩個指令。
 */
export function handOverDispatchedChords(list: readonly Command[]): Command[] {
  return list.map((c) => (DISPATCHED_BY[c.id] && c.shortcuts?.length ? { ...c, shortcutManual: true } : c));
}

/** 被派發指令接手的原指令 id（測試與快捷鍵說明用）。 */
export function dispatchedCommandIds(): string[] {
  return Object.keys(DISPATCHED_BY);
}

const SEQ_SECTION = "序列剪輯";
const SEQ_SURFACES: Surface[] = ["menu", "palette", "context"];

/**
 * 序列剪輯指令表（含四組派發指令）。`on` = 實驗旗標：
 * 關的時候序列指令不在任何表面、沒有鍵；派發指令的標題 / 群組 / 鍵跟 M1 原主人一樣（快捷鍵說明逐字不變）。
 */
export function sequenceCommands(on: boolean = sequenceEditingEnabled()): Command[] {
  return [...dispatchCommands(on), ...sequenceOnlyCommands(on)];
}

/**
 * 四組派發指令。旗標關：標題 / 群組 / section / 鍵逐字照抄 M1 原主人，表面清空（原主人已經在選單與命令面板裡）；
 * 旗標開：序列版的標題（標題本身講清楚「依情境做不同事」），只進命令面板 —— 選單列放的是各自的正式指令，免得同一件事列兩次。
 */
function dispatchCommands(on: boolean): Command[] {
  const pick = <T>(onValue: T, offValue: T): T => (on ? onValue : offValue);
  const surfaces = pick<Surface[]>(["palette"], []);
  return [
    {
      id: "edit.split",
      title: pick("分割（序列時間軸：片段；素材時間軸：字幕）", "在播放線分割字幕"),
      group: pick<CommandGroup>("edit", "captions"),
      section: pick(SEQ_SECTION, "編輯"),
      icon: Scissors,
      shortcuts: pick(["B", "Ctrl+\\"], ["B"]),
      surfaces,
      keywords: ["split", "razor", "cut"],
      ...dispatcher(() => ({ id: inSequenceSpace() ? "sequence.split" : "captions.splitAtPlayhead" })),
    },
    {
      id: "edit.delete",
      title: pick("刪除（依焦點：片段波紋刪除／範圍提取／關鍵幀）", "移除關鍵幀"),
      group: "edit",
      section: pick(SEQ_SECTION, "追蹤"),
      icon: Trash2,
      shortcuts: ["Delete", "Backspace"],
      surfaces,
      keywords: ["delete", "ripple delete"],
      ...dispatcher(() => deleteDispatch("delete", deleteDispatchStateNow())),
    },
    {
      id: "edit.deleteAlt",
      title: pick("刪除留空隙（依焦點：片段／範圍；追蹤或關鍵幀時刪除追蹤）", "刪除追蹤"),
      group: "edit",
      section: pick(SEQ_SECTION, "追蹤"),
      icon: Trash2,
      shortcuts: pick(["Shift+Delete", "Shift+Backspace"], ["Shift+Delete"]),
      surfaces,
      keywords: ["lift", "delete", "gap"],
      ...dispatcher(() => deleteDispatch("deleteAlt", deleteDispatchStateNow())),
    },
    {
      id: "playback.prevEditOrShot",
      title: pick("上一個剪輯點（素材時間軸：上一個鏡頭）", "上一個鏡頭"),
      group: "playback",
      section: "導覽",
      icon: ChevronsUp,
      shortcuts: ["Shift+[", "ArrowUp"],
      surfaces,
      keywords: ["previous edit"],
      ...dispatcher(() => ({ id: inSequenceSpace() ? "sequence.prevEdit" : "playback.prevShot" })),
    },
    {
      id: "playback.nextEditOrShot",
      title: pick("下一個剪輯點（素材時間軸：下一個鏡頭）", "下一個鏡頭"),
      group: "playback",
      section: "導覽",
      icon: ChevronsDown,
      shortcuts: ["Shift+]", "ArrowDown"],
      surfaces,
      keywords: ["next edit"],
      ...dispatcher(() => ({ id: inSequenceSpace() ? "sequence.nextEdit" : "playback.nextShot" })),
    },
    {
      // Final Cut 的 Mark Clip 只有一顆 X：序列時間軸上是「這個片段」，素材時間軸上最接近的等價物是「這個鏡頭」
      id: "playback.markClipOrShot",
      title: pick("將片段設為範圍（素材時間軸：鏡頭）", "將播放線所在鏡頭設為範圍"),
      group: "playback",
      section: "範圍",
      icon: Clapperboard,
      shortcuts: ["X"],
      surfaces,
      keywords: ["mark clip", "range"],
      ...dispatcher(() => ({ id: inSequenceSpace() ? "sequence.markClip" : "playback.markShot" })),
    },
  ];
}

/** 序列限定的指令（分割、刪除、停用、導覽）。旗標關：不在任何表面、沒有鍵（enabled 也會講「先開旗標」）。 */
function sequenceOnlyCommands(on: boolean): Command[] {
  const gate = (surfaces: Surface[], shortcuts?: string[], manual = false): Pick<Command, "surfaces" | "shortcuts" | "shortcutManual"> =>
    on ? { surfaces, shortcuts, ...(manual ? { shortcutManual: true } : {}) } : { surfaces: [] };
  return [
    // ---- 範圍 ----
    {
      id: "sequence.markClip",
      title: "將選取片段設為範圍",
      group: "playback",
      section: "範圍",
      icon: SquareDashed,
      ...gate(SEQ_SURFACES, ["X"], true),
      keywords: ["mark clip", "range", "selection"],
      enabled: needsClipSelection,
      run: () => markSelectionAsRange(),
    },

    {
      id: "sequence.insertGap",
      title: "在播放線插入空白（3 秒）",
      group: "edit",
      section: SEQ_SECTION,
      icon: BetweenHorizontalStart,
      ...gate(SEQ_SURFACES, ["Alt+W"]),
      keywords: ["insert gap", "gap"],
      enabled: needsPlayheadInSequence,
      run: () => runInsertGap(),
    },

    {
      id: "sequence.addMarker",
      title: "在播放線加標記",
      group: "edit",
      section: SEQ_SECTION,
      icon: Bookmark,
      // Premiere 是 M，但這裡 M / Shift+M / Alt+M 都被遮罩傳播佔走了
      ...gate(SEQ_SURFACES, ["Ctrl+M"]),
      keywords: ["marker", "add marker"],
      enabled: needsPlayheadInSequence,
      run: () => runAddMarker(),
    },
    {
      id: "sequence.deleteMarker",
      title: "刪除播放線上的標記",
      group: "edit",
      section: SEQ_SECTION,
      icon: BookmarkX,
      ...gate(SEQ_SURFACES, ["Ctrl+Shift+M"]),
      keywords: ["marker", "delete marker"],
      enabled: needsMarkerHere,
      run: () => runDeleteMarker(),
    },
    {
      id: "sequence.renameMarker",
      title: "改播放線上標記的字",
      group: "edit",
      section: SEQ_SECTION,
      icon: Bookmark,
      ...gate(SEQ_SURFACES),
      keywords: ["marker", "rename marker"],
      enabled: needsMarkerHere,
      run: () => runRenameMarker(),
    },
    {
      id: "sequence.prevMarker",
      title: "跳到上一個標記",
      group: "playback",
      section: "導覽",
      icon: Bookmark,
      ...gate(SEQ_SURFACES),
      keywords: ["marker", "previous marker"],
      enabled: needsPlayheadInSequence,
      run: () => runGoMarker(-1),
    },
    {
      id: "sequence.nextMarker",
      title: "跳到下一個標記",
      group: "playback",
      section: "導覽",
      icon: Bookmark,
      ...gate(SEQ_SURFACES),
      keywords: ["marker", "next marker"],
      enabled: needsPlayheadInSequence,
      run: () => runGoMarker(1),
    },
    {
      id: "sequence.splitAtShots",
      title: "在偵測到的鏡頭切點分割",
      group: "edit",
      section: SEQ_SECTION,
      icon: Scissors,
      ...gate(SEQ_SURFACES),
      keywords: ["scene cut", "split at shots", "shots"],
      enabled: needsSequenceSpace,
      run: () => runSplitAtShots(),
    },
    {
      id: "sequence.renameClip",
      title: "重新命名選取的片段",
      group: "edit",
      section: SEQ_SECTION,
      icon: Pencil,
      ...gate(SEQ_SURFACES, ["F2"]),
      keywords: ["rename", "label"],
      enabled: needsClipSelection,
      run: () => runRenameClip(),
    },
    {
      id: "sequence.normalizeAudio",
      title: "正規化選取片段的音量",
      group: "edit",
      section: SEQ_SECTION,
      icon: Volume2,
      ...gate(SEQ_SURFACES),
      keywords: ["normalize", "loudness", "volume"],
      enabled: needsClipSelection,
      run: () => runNormalize(),
    },
    {
      id: "sequence.removeSilence",
      title: "移除靜音",
      group: "edit",
      section: SEQ_SECTION,
      icon: Slice,
      ...gate(SEQ_SURFACES),
      keywords: ["remove silence", "silence", "auto cut"],
      enabled: needsSequenceSpace,
      run: () => openDialog("removeSilence"),
    },
    {
      // 文字稿剪輯：判準是字幕的逐字時間碼，不是音量。跟移除靜音並排，兩個常常接著用
      // （先剪掉語助詞，再把留下來的停頓收掉）。
      id: "sequence.removeFillers",
      title: "移除語助詞（呃、嗯、重複的字）",
      group: "edit",
      section: SEQ_SECTION,
      icon: Eraser,
      ...gate(SEQ_SURFACES),
      keywords: ["filler", "um", "uh", "transcript", "text based editing", "語助詞", "贅字"],
      enabled: needsSequenceSpace,
      run: () => openDialog("removeFillers"),
    },
    {
      id: "sequence.selectAll",
      title: "全選片段",
      group: "edit",
      section: SEQ_SECTION,
      icon: MousePointer2,
      ...gate(SEQ_SURFACES, ["Ctrl+A"]),
      keywords: ["select all"],
      enabled: needsSelectable,
      run: () => useTimeline.getState().selectClips(allSelectableIds(viewSequenceNow())),
    },
    {
      id: "sequence.cutClips",
      title: "剪下選取的片段",
      group: "edit",
      section: SEQ_SECTION,
      icon: ScissorsCut,
      ...gate(SEQ_SURFACES, ["Ctrl+X"]),
      keywords: ["cut", "clipboard"],
      enabled: needsClipSelection,
      run: () => runCutClips(),
    },
    {
      id: "sequence.copyClips",
      title: "複製選取的片段到剪貼簿",
      group: "edit",
      section: SEQ_SECTION,
      icon: ClipboardCopy,
      ...gate(SEQ_SURFACES, ["Ctrl+C"]),
      keywords: ["copy", "clipboard"],
      enabled: needsClipSelection,
      run: () => runCopyClips(),
    },
    {
      id: "sequence.pasteClips",
      title: "在播放線貼上片段",
      group: "edit",
      section: SEQ_SECTION,
      icon: ClipboardPaste,
      ...gate(SEQ_SURFACES, ["Ctrl+V"]),
      keywords: ["paste", "clipboard"],
      enabled: needsClipboard,
      run: () => runPasteClips(),
    },
    {
      id: "sequence.duplicate",
      title: "複製選取的片段",
      group: "edit",
      section: SEQ_SECTION,
      icon: Copy,
      ...gate(SEQ_SURFACES, ["Alt+D"]),
      keywords: ["duplicate", "copy"],
      enabled: needsClipSelection,
      run: () => runDuplicate(),
    },
    {
      id: "sequence.nudgeLeft",
      title: "向左滑移一幀",
      group: "edit",
      section: SEQ_SECTION,
      icon: ChevronLeft,
      ...gate(SEQ_SURFACES, ["Alt+,"]),
      keywords: ["nudge", "slide left"],
      enabled: needsRoom("slide", -1),
      run: () => runNudge(-1),
    },
    {
      id: "sequence.nudgeRight",
      title: "向右滑移一幀",
      group: "edit",
      section: SEQ_SECTION,
      icon: ChevronRight,
      ...gate(SEQ_SURFACES, ["Alt+."]),
      keywords: ["nudge", "slide right"],
      enabled: needsRoom("slide", 1),
      run: () => runNudge(1),
    },
    {
      id: "sequence.moveItemLeft",
      title: "把片段往前挪一格",
      group: "edit",
      section: SEQ_SECTION,
      icon: ArrowLeft,
      ...gate(SEQ_SURFACES, ["Ctrl+Shift+ArrowLeft"]),
      keywords: ["reorder", "move clip"],
      enabled: needsReorder(-1),
      run: () => runMoveItem(-1),
    },
    {
      id: "sequence.moveItemRight",
      title: "把片段往後挪一格",
      group: "edit",
      section: SEQ_SECTION,
      icon: ArrowRight,
      ...gate(SEQ_SURFACES, ["Ctrl+Shift+ArrowRight"]),
      keywords: ["reorder", "move clip"],
      enabled: needsReorder(1),
      run: () => runMoveItem(1),
    },
    {
      id: "sequence.slipLeft",
      title: "向左滑內容一幀",
      group: "edit",
      section: SEQ_SECTION,
      icon: ChevronsLeft,
      ...gate(SEQ_SURFACES, ["Alt+Shift+,"]),
      keywords: ["slip"],
      enabled: needsRoom("slip", -1),
      run: () => runSlip(-1),
    },
    {
      id: "sequence.slipRight",
      title: "向右滑內容一幀",
      group: "edit",
      section: SEQ_SECTION,
      icon: ChevronsRight,
      ...gate(SEQ_SURFACES, ["Alt+Shift+."]),
      keywords: ["slip"],
      enabled: needsRoom("slip", 1),
      run: () => runSlip(1),
    },
    {
      id: "sequence.extendEdit",
      title: "延伸編輯到播放線",
      group: "edit",
      section: SEQ_SECTION,
      icon: MoveHorizontal,
      ...gate(SEQ_SURFACES, ["Shift+E"]),
      keywords: ["extend edit", "roll"],
      enabled: all(needsOneClip, needsPlayheadInSequence),
      run: () => runExtendEdit(),
    },
    {
      id: "sequence.selectClipAtPlayhead",
      title: "選取播放線上的片段",
      group: "edit",
      section: SEQ_SECTION,
      icon: Crosshair,
      ...gate(SEQ_SURFACES),
      keywords: ["select clip", "playhead"],
      enabled: needsPlayheadInSequence,
      run: () => runSelectAtPlayhead(),
    },

    // ---- 分割 ----
    {
      id: "sequence.split",
      title: "在播放線分割（再按一次合併切點）",
      group: "edit",
      section: SEQ_SECTION,
      icon: Scissors,
      ...gate(SEQ_SURFACES, ["B", "Ctrl+\\"], true),
      keywords: ["split", "razor", "cut", "add edit", "join"],
      enabled: needsSplit("v1"),
      run: () => void runSplit("v1"),
    },
    {
      id: "sequence.splitAll",
      title: "在播放線分割所有軌",
      group: "edit",
      section: SEQ_SECTION,
      icon: SquareSplitHorizontal,
      ...gate(SEQ_SURFACES, ["Ctrl+Shift+\\"]),
      keywords: ["split all", "add edit to all tracks", "razor"],
      enabled: needsSplit("all"),
      run: () => void runSplit("all"),
    },
    {
      // §9.5 Esc：取消選取、刀片退回選取工具、焦點清成無（ai-music-cut select.clear）。
      // enabled 刻意永遠 OK（旗標開時）：Esc 是隨手按的鍵，灰掉的話每按一次都會跳一句「沒有選取」的 toast
      id: "sequence.clearSelection",
      title: "取消選取（刀片工具退回選取）",
      group: "edit",
      section: SEQ_SECTION,
      icon: MousePointer2,
      ...gate(["palette"], ["Escape"]),
      keywords: ["deselect", "escape"],
      enabled: needsSequenceFlag,
      run: () => {
        const tl = useTimeline.getState();
        tl.selectClips([]);
        tl.setFocus(null);
        tl.setSeqTool("select");
      },
    },
    {
      id: "sequence.tool.blade",
      title: "工具：刀片",
      group: "edit",
      section: SEQ_SECTION,
      icon: Slice,
      ...gate(["menu", "palette"], ["Shift+B"]),
      keywords: ["blade", "razor"],
      checked: () => useTimeline.getState().seqTool === "blade",
      enabled: needsSequenceSpace,
      run: () => {
        const tl = useTimeline.getState();
        tl.setSeqTool(tl.seqTool === "blade" ? "select" : "blade");
      },
    },

    // ---- 刪除 ----
    {
      id: "sequence.rippleDelete",
      title: "波紋刪除片段",
      group: "edit",
      section: SEQ_SECTION,
      icon: Delete,
      ...gate(SEQ_SURFACES, ["Delete"], true),
      keywords: ["ripple delete"],
      enabled: needsClipSelection,
      run: () => deleteSelected(false),
    },
    {
      id: "sequence.lift",
      title: "刪除片段（留空隙）",
      group: "edit",
      section: SEQ_SECTION,
      icon: Trash2,
      ...gate(SEQ_SURFACES, ["Shift+Delete"], true),
      keywords: ["lift", "clear", "replace with gap"],
      enabled: needsClipSelection,
      run: () => deleteSelected(true),
    },
    {
      id: "sequence.extractRange",
      title: "提取範圍（後面接上）",
      group: "edit",
      section: SEQ_SECTION,
      icon: BetweenHorizontalStart,
      ...gate(SEQ_SURFACES, ["Delete"], true),
      keywords: ["extract", "ripple delete range"],
      enabled: all(needsSequenceSpace, needsRange),
      run: () => deleteRange(false),
    },
    {
      id: "sequence.liftRange",
      title: "移除範圍（留空隙）",
      group: "edit",
      section: SEQ_SECTION,
      icon: Trash2,
      ...gate(SEQ_SURFACES, ["Shift+Delete"], true),
      keywords: ["lift range"],
      enabled: all(needsSequenceSpace, needsRange),
      run: () => deleteRange(true),
    },

    // ---- 停用 ----
    {
      id: "sequence.toggleEnabled",
      title: "停用／啟用片段",
      group: "edit",
      section: SEQ_SECTION,
      icon: EyeOff,
      ...gate(SEQ_SURFACES, ["D"]),
      keywords: ["disable", "enable", "mute clip"],
      checked: () => toggleTargets(viewSequenceNow()).allDisabled,
      enabled: needsToggleTarget,
      run: () => void runToggleEnabled(),
    },

    // ---- 修剪到播放線（M2.13）：拖邊緣的鍵盤版，片段右鍵的 CLIP_TRIM_IDS 也列這兩條 ----
    {
      id: "sequence.rippleTrimStart",
      title: "修剪開頭到播放線（波紋）",
      group: "edit",
      section: SEQ_SECTION,
      icon: ArrowLeftToLine,
      ...gate(SEQ_SURFACES, ["Ctrl+Shift+["]),
      keywords: ["ripple trim", "trim start to playhead"],
      enabled: needsTrimToPlayhead,
      run: () => runTrimToPlayhead("in"),
    },
    {
      id: "sequence.rippleTrimEnd",
      title: "修剪結尾到播放線（波紋）",
      group: "edit",
      section: SEQ_SECTION,
      icon: ArrowRightToLine,
      ...gate(SEQ_SURFACES, ["Ctrl+Shift+]"]),
      keywords: ["ripple trim", "trim end to playhead"],
      enabled: needsTrimToPlayhead,
      run: () => runTrimToPlayhead("out"),
    },

    // ---- 加媒體 / 音訊（M2.14，§10.2）：沒有鍵（E、Q、W 等都被佔了），走選單、命令面板與右鍵 ----
    {
      id: "sequence.overwriteMedia",
      title: "在播放線覆蓋目前媒體",
      group: "edit",
      section: SEQ_SECTION,
      icon: Replace,
      // Avid / Premiere 的 overwrite 就是句點（nudge 讓到 Alt+.）
      ...gate(SEQ_SURFACES, ["."]),
      keywords: ["overwrite", "add to sequence"],
      enabled: all(needsSequenceFlag, needsProxy),
      run: () => runAddActiveMedia("overwrite"),
    },
    {
      id: "sequence.appendMedia",
      title: "將目前媒體接到序列結尾",
      group: "edit",
      section: SEQ_SECTION,
      icon: ListEnd,
      ...gate(["menu", "palette"]),
      keywords: ["append", "add to sequence"],
      enabled: all(needsSequenceFlag, needsProxy),
      run: () => runAddActiveMedia("append"),
    },
    {
      id: "sequence.insertMedia",
      title: "在播放線插入目前媒體",
      group: "edit",
      section: SEQ_SECTION,
      icon: BetweenHorizontalStart,
      // Avid / Premiere 的 splice-in 就是逗號；三點剪輯的核心操作值得拿到標準鍵（nudge 讓到 Alt+,）
      ...gate(SEQ_SURFACES, [","]),
      keywords: ["insert", "add to sequence", "splice in"],
      enabled: all(needsSequenceFlag, needsProxy),
      run: () => runAddActiveMedia("insert"),
    },
    {
      // 跟側欄音訊清單的「加入音訊檔…」同一個動作（對話框 → 放在播放線；序列還放不上去時只進清單並說明）
      id: "audio.import",
      title: "加入音訊檔…",
      group: "file",
      section: "音訊",
      icon: FilePlus,
      ...gate(["menu", "palette"]),
      keywords: ["import audio", "add audio", "music", "sound"],
      enabled: needsSequenceFlag,
      run: () => importAudioDialog(),
    },
    {
      // 片段右鍵與尺規的「在這裡加入音訊…」借用這一條（先把播放線移過去再跑）
      id: "audio.addAtPlayhead",
      title: "在播放線加入音訊…",
      group: "edit",
      section: SEQ_SECTION,
      icon: Music,
      ...gate(SEQ_SURFACES),
      keywords: ["add audio", "music", "sound", "voice over"],
      enabled: needsSequenceFlag,
      run: () => importAudioDialog(),
    },
    {
      id: "audio.newLane",
      title: "新增音軌",
      group: "edit",
      section: SEQ_SECTION,
      icon: Plus,
      ...gate(["menu", "palette"]),
      keywords: ["add track", "new audio track"],
      enabled: needsSequenceSpace,
      run: () => void addAudioLane(),
    },

    // ---- 導覽 ----
    {
      id: "sequence.matchFrame",
      title: "對應幀（序列 ⇄ 素材）",
      group: "playback",
      section: "導覽",
      icon: LocateFixed,
      ...gate(["menu", "palette"], ["F"]),
      keywords: ["match frame", "reveal source"],
      enabled: needsMatchFrame,
      run: runMatchFrame,
    },
    {
      id: "sequence.prevEdit",
      title: "上一個剪輯點",
      group: "playback",
      section: "導覽",
      icon: ChevronsUp,
      ...gate(["menu", "palette"], ["ArrowUp"], true),
      keywords: ["previous edit"],
      enabled: needsEditPoint(-1),
      run: () => runEditPoint(-1),
    },
    {
      id: "sequence.nextEdit",
      title: "下一個剪輯點",
      group: "playback",
      section: "導覽",
      icon: ChevronsDown,
      ...gate(["menu", "palette"], ["ArrowDown"], true),
      keywords: ["next edit"],
      enabled: needsEditPoint(1),
      run: () => runEditPoint(1),
    },
  ];
}

/**
 * guards.ts 的反應性沒有訂序列的欄位：焦點 / 片段選取 / 刀片 / 空間、序列本身（loadSequence 不動 past）、實驗旗標。
 * 旗標一變就重新登記整張序列指令表（表面與鍵跟著旗標變），registerCommands 會 bump 版本、hotkeys 重建鍵表。
 */
export function installSequenceCommandReactivity(): () => void {
  const uns = [
    useSettings.subscribe((s, p) => {
      if (s.experimental.sequence !== p.experimental.sequence) registerCommands(sequenceCommands(s.experimental.sequence));
    }),
    useTimeline.subscribe((s, p) => {
      if (s.focus !== p.focus || s.selectedClipIds !== p.selectedClipIds || s.seqTool !== p.seqTool || s.space !== p.space) bumpCommandTick();
    }),
    useEdits.subscribe((s, p) => {
      if (s.sequence !== p.sequence || s.audioMedia !== p.audioMedia) bumpCommandTick();
    }),
  ];
  return () => {
    for (const u of uns) u();
  };
}
