import {
  ArrowLeftToLine,
  ArrowRightToLine,
  AudioLines,
  Captions,
  ChevronsLeft,
  ChevronsRight,
  Combine,
  FileText,
  Flame,
  Highlighter,
  ImageDown,
  ListTree,
  Plus,
  RefreshCw,
  Replace,
  Scissors,
  Sparkles,
  Square,
  Scissors as ScissorsCut,
  Trash2,
} from "lucide-react";
import { api, errMessage } from "../api";
import { pickProvider } from "../assistant/provider";
import { t } from "../i18n";
import { cancelCaptions, captionsRunning, exportCaptions, previewCaptionFrame, rebuildCaptions, refineCaptions, sourceRange, transcribeAndBuild, type CaptionExportFormat } from "../pipeline/captions";
import { engineWarningText, fallbackReasonText, isLlmFailure, refineToasts } from "../pipeline/captionWarnings";
import type { CaptionTrackV1 } from "../project/format";
import { cueAtFrame, emptyCaptionTrack, framesOfMs, insertCueAt, msOfFrame, outputLanguageFor, splitPointAt, useCaptionsUi, type NudgeEdge } from "../store/captions";
import { viewSequenceOf } from "../frametimeline/layoutSequence";
import { extractRange } from "../sequence/ops";
import { cueCutRanges } from "../sequence/transcript";
import { SEQ_EDIT_LABEL, useEdits } from "../store/edits";
import { openDialog } from "../store/dialogs";
import { usePlayback } from "../store/playback";
import { selectActiveMedia, useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useTimeline, type FrameRange } from "../store/timeline";
import { useUi } from "../store/ui";
import { formatMs } from "../time";
import { pickSaveFile, toast, uiConfirm } from "../ui";
import { activeId, needsEngine, needsMedia, needsProxy } from "./guards";
import { OK, bumpCommandTick } from "./registry";
import type { Command, Enabled } from "./types";
import { withUndoToast } from "./undoToast";

/**
 * 字幕指令（feat/captions；規格 §5.7 Commands）。一功能一 Command：面板按鈕、選單、命令面板、快捷鍵都派發這裡。
 *
 * 選單列有自己的「字幕」群組（CommandGroup "captions"），section 只決定分隔線：產生 / 校對 →「字幕」、編輯 →「編輯」、
 * 跳段 →「播放」、匯出 / 燒入 →「輸出」。例外：舞台顯示字幕放「檢視 › 圖層」（跟其他疊層開關一起）、側欄分頁在 core.ts 的 RAIL_TABS、
 * 安裝依賴放「說明」。
 *
 * 快捷鍵（commands.test / captionCommands.test 守門，不跟既有的撞）：
 * - B：在播放線分割（CapCut 同一顆鍵）；Shift+C：舞台顯示字幕；E：切換選中字的強調；Ctrl+F：尋找 / 取代；
 * - Ctrl+Alt+←/→：起點 ∓1 幀、Ctrl+Alt+Shift+←/→：終點 ∓1 幀（Alt+方向鍵已經給了參考點微調，只能加 Ctrl）。
 */

const SECTION = "字幕";
const NO_CAPTIONS = "還沒有字幕（字幕分頁 › 產生字幕）";

function both(...fs: (() => Enabled)[]): () => Enabled {
  return () => {
    for (const f of fs) {
      const r = f();
      if (!r.ok) return r;
    }
    return OK;
  };
}

export function activeCaptions(): CaptionTrackV1 | null {
  const id = activeId();
  return id ? useEdits.getState().captions[id] ?? null : null;
}

function activeFps() {
  return selectActiveMedia(useProject.getState())?.proxy?.fps ?? null;
}

function activeFrameCount(): number | null {
  return selectActiveMedia(useProject.getState())?.proxy?.frames ?? null;
}

export function needsCaptions(): Enabled {
  const m = needsMedia();
  if (!m.ok) return m;
  return activeCaptions()?.cues.length ? OK : { ok: false, why: NO_CAPTIONS };
}

/** 動作對象：面板選中的段（還存在的話），否則播放線上的段。 */
export function targetCueId(): string | null {
  const tr = activeCaptions();
  if (!tr) return null;
  const sel = useCaptionsUi.getState().selectedCueId;
  if (sel && tr.cues.some((c) => c.id === sel)) return sel;
  return cueAtFrame(tr.cues, usePlayback.getState().frame)?.id ?? null;
}

function needsCaptionTarget(): Enabled {
  const c = needsCaptions();
  if (!c.ok) return c;
  return targetCueId() ? OK : { ok: false, why: "先在字幕面板選一段，或把播放線移到字幕上" };
}

/**
 * 文字稿剪輯的單句版：**把這句底下的影片從序列上剪掉**（波紋，關空隙）。
 *
 * 跟 captions.deleteCue 是兩回事，而那正是使用者最容易搞混的地方：
 * 刪字幕段 = 這句話不再顯示字幕，畫面與聲音照舊；這一支 = 這段影片不見了。
 *
 * 字幕段**不會**一起刪：字幕是來源的逐字稿，來源還在（素材可以再放回去），
 * 而且字幕的 undo 是 per-media、序列的 undo 是 project scope，兩者併不成一筆。
 * 面板改用 cuesInSequence 把不在剪輯裡的句子標出來，剪完看得出來。
 */
function cutCueFromSequence(): void {
  const mediaId = activeId();
  const cueId = targetCueId();
  const tr = activeCaptions();
  if (!mediaId || !cueId || !tr) return;
  const cue = tr.cues.find((c) => c.id === cueId);
  if (!cue) return;
  const seq = viewSequenceOf(useEdits.getState().sequence, selectActiveMedia(useProject.getState()) ?? null);
  const ranges = seq ? cueCutRanges(seq, mediaId, [cue]) : [];
  if (!ranges.length) return void toast.info(t("這句在序列上找不到對應的畫面（可能已經被剪掉了）"));
  try {
    // 倒序：先刪後面的，前面那些的序列座標才不會偏
    useEdits.getState().editSequence(SEQ_EDIT_LABEL.cutCue, (sq, ctx) => [...ranges].reverse().reduce((acc, r) => extractRange(acc, r, ctx), sq));
    toast.success(t("已剪掉這句的畫面"));
  } catch (e) {
    toast.error(t("無法修改序列：{msg}", { msg: e instanceof Error ? e.message : String(e) }));
  }
}

function needsNextCue(): Enabled {
  const c = needsCaptionTarget();
  if (!c.ok) return c;
  const tr = activeCaptions()!;
  const i = tr.cues.findIndex((x) => x.id === targetCueId());
  return i >= 0 && i + 1 < tr.cues.length ? OK : { ok: false, why: "這已經是最後一段字幕" };
}

function needsSplitPoint(): Enabled {
  const c = needsCaptions();
  if (!c.ok) return c;
  return splitPointAt(activeCaptions()!.cues, usePlayback.getState().frame) ? OK : { ok: false, why: "播放線這裡沒有可以切的字幕（一段至少要兩個字）" };
}

function needsSelectedWord(): Enabled {
  const c = needsCaptions();
  if (!c.ok) return c;
  const sel = useCaptionsUi.getState().selectedWord;
  const cue = sel ? activeCaptions()!.cues.find((x) => x.id === sel.cueId) : null;
  return cue && sel && cue.words[sel.index] ? OK : { ok: false, why: "先在字幕面板點一個字" };
}

function needsCaptionsIdle(): Enabled {
  const id = activeId();
  return id && captionsRunning(id) ? { ok: false, why: "字幕正在產生中" } : OK;
}

function needsCaptionsRunning(): Enabled {
  const id = activeId();
  return id && captionsRunning(id) ? OK : { ok: false, why: "沒有進行中的字幕工作" };
}

function needsAsrSource(): Enabled {
  const c = needsCaptions();
  if (!c.ok) return c;
  return activeCaptions()?.source?.asrPath ? OK : { ok: false, why: "這份字幕沒有語音辨識來源，請重新產生字幕" };
}

function needsLlmEndpoint(): Enabled {
  return useSettings.getState().s.llm_openai_base_url.trim() ? OK : { ok: false, why: "先在設定填本機 LLM 端點（OpenAI 相容）" };
}

/** AI 配音要有 Seal-TTS 伺服器位址（金鑰在 keychain，這裡不看）。 */
function needsTts(): Enabled {
  return useSettings.getState().s.tts_base_url.trim() ? OK : { ok: false, why: "先在設定填 AI 配音的伺服器位址" };
}

/** 本機端點或 Claude 其中一個設定好就行（跟助手同一個判準：pickProvider）。 */
function needsLlm(): Enabled {
  return pickProvider(useSettings.getState().s) ? OK : { ok: false, why: "先在設定填 AI 助手的端點或 Claude 模型" };
}

// ---- 動作 ----

export function openCaptionsPanel(): void {
  useUi.getState().setTab("captions");
}

/** 有逐段修過、而且會被這次動作蓋掉的段（range null = 整條）。 */
function editedCuesIn(tr: CaptionTrackV1 | null, range: FrameRange | null): boolean {
  return !!tr?.cues.some((c) => c.flags?.includes("edited") && (!range || (c.endFrame > range.in && c.startFrame < range.out)));
}

/**
 * 用面板上次的選項產生字幕；會蓋掉逐段修過的字時先確認（一筆 undo 收得回來，但一次洗掉幾十段修改仍值得問一句）。
 * 只重辨識 I/O 範圍時，範圍外的段不會動（captionsMerge），所以只看範圍內有沒有修過的段。
 */
export async function generateCaptions(): Promise<void> {
  const mediaId = activeId();
  if (!mediaId) return;
  const opts = useCaptionsUi.getState().opts;
  const range = opts.scope === "range" ? useTimeline.getState().range : null;
  if (opts.scope === "range" && !range) {
    toast.info(t("先用 I / O 標一段範圍"));
    return;
  }
  if (editedCuesIn(activeCaptions(), range)) {
    const msg = range ? t("重新辨識會取代範圍內逐段修過的內容（範圍外不會動，可以復原）。要繼續嗎？") : t("重新產生字幕會取代目前逐段修過的內容（可以復原）。要繼續嗎？");
    if (!(await uiConfirm(msg, { confirmText: t("重新產生") }))) return;
  }
  openCaptionsPanel();
  try {
    const r = await transcribeAndBuild(mediaId, opts, range);
    toast.success(t("已產生 {n} 段字幕", { n: r.cues }));
    const fallback = fallbackReasonText(r.fallbackReason);
    if (fallback) toast.info(fallback);
    // 辨識本身帶了本機 LLM 的失敗（CLI 的 --llm-url 路徑）也講出來；其他警告在字幕面板的摘要裡
    const llmFail = r.warnings.find(isLlmFailure);
    if (llmFail) toast.error(engineWarningText(llmFail));
  } catch (e) {
    // 取消不算錯；其他錯誤由 lastError 顯示在面板（PyEnv 另給安裝按鈕），這裡再 toast 一次讓選單觸發的人也看得到
    const msg = errMessage(e);
    if (!/cancel|取消/i.test(msg)) toast.error(msg);
    return;
  }
  // 「產生後用本機 LLM 校對」：跟手動按校對同一條路，連不上 / 回傳壞掉會照實 toast（之前這裡把結果整個吞掉）。
  // 端點後來被清空時勾選值還留在 localStorage：沒端點就不跑，免得每次產生都跳一則「先填端點」。
  if (opts.refine && useSettings.getState().s.llm_openai_base_url.trim()) void refineActive();
}

function nudge(d: number, edge: NudgeEdge): void {
  const mediaId = activeId();
  const cueId = targetCueId();
  if (!mediaId || !cueId) return;
  if (!useEdits.getState().nudgeCue(mediaId, cueId, d, edge, activeFrameCount())) toast.info(t("已經貼齊前後段，不能再移"));
}

export function splitAtPlayhead(): void {
  const mediaId = activeId();
  if (mediaId) useEdits.getState().splitCueAtFrame(mediaId, usePlayback.getState().frame);
}

export function mergeTargetWithNext(): void {
  const mediaId = activeId();
  const cueId = targetCueId();
  if (mediaId && cueId) useEdits.getState().mergeCueWithNext(mediaId, cueId);
}

export function toggleSelectedEmphasis(): void {
  const mediaId = activeId();
  const sel = useCaptionsUi.getState().selectedWord;
  if (mediaId && sel) useEdits.getState().toggleEmphasis(mediaId, sel.cueId, sel.index);
}

/** 在播放線插一段（預設 1.5 秒、文字「新字幕」）；還沒有字幕 track 就連 track 一起建（同一筆 undo）。 */
export function insertCaptionAtPlayhead(): void {
  const mediaId = activeId();
  const fps = activeFps();
  if (!mediaId || !fps) return;
  const frame = usePlayback.getState().frame;
  const dur = framesOfMs(1500, fps);
  const text = t("新字幕");
  const tr = activeCaptions();
  let id: string | null;
  if (tr) id = useEdits.getState().insertCueAt(mediaId, frame, text, dur, activeFrameCount());
  else {
    const opts = useCaptionsUi.getState().opts;
    const base = emptyCaptionTrack(opts.preset, outputLanguageFor(opts.language) ?? (opts.language === "auto" ? "zh-TW" : opts.language));
    const r = insertCueAt(base.cues, frame, text, dur, activeFrameCount());
    id = r?.id ?? null;
    if (r) useEdits.getState().applyCaptions(mediaId, { ...base, cues: r.cues }, "插入字幕段");
  }
  if (!id) {
    toast.info(t("播放線這裡已經有字幕"));
    return;
  }
  openCaptionsPanel();
  useCaptionsUi.getState().selectCue(id);
}

export function stepCue(dir: 1 | -1): void {
  const tr = activeCaptions();
  if (!tr) return;
  const f = usePlayback.getState().frame;
  const next = dir > 0 ? tr.cues.find((c) => c.startFrame > f) : [...tr.cues].reverse().find((c) => c.startFrame < f && !(c.startFrame <= f && f < c.endFrame));
  if (!next) return toast.info(dir > 0 ? t("後面沒有字幕了") : t("前面沒有字幕了"));
  usePlayback.getState().seek(next.startFrame);
  useCaptionsUi.getState().selectCue(next.id);
}

const EXPORT_FILTER_NAME: Record<CaptionExportFormat, string> = { srt: "SubRip", vtt: "WebVTT", ass: "Advanced SubStation Alpha", txt: "Text" };

/** 選路徑 → 引擎 captions.export 寫檔（UTF-8、無 BOM、LF；隱藏段不輸出）。 */
export async function exportCaptionsAs(format: CaptionExportFormat): Promise<void> {
  const mediaId = activeId();
  const media = selectActiveMedia(useProject.getState());
  if (!mediaId || !media) return;
  const base = media.name.replace(/\.[^.]+$/, "");
  const target = await pickSaveFile(`${base}.${format}`, [{ name: EXPORT_FILTER_NAME[format], extensions: [format] }]);
  if (!target) return;
  try {
    const r = await exportCaptions(mediaId, format, target);
    const out = r.out ?? r.path ?? target;
    toast.success(t("已匯出字幕：{name}", { name: out.split(/[\\/]/).pop() ?? out }));
  } catch (e) {
    toast.error(errMessage(e));
  }
}

export async function previewThisFrame(): Promise<void> {
  const mediaId = activeId();
  if (!mediaId) return;
  try {
    const p = await previewCaptionFrame(mediaId, usePlayback.getState().frame);
    await api.openPath(p);
  } catch (e) {
    toast.error(errMessage(e));
  }
}

/**
 * 依目前樣式重新分段。來源 ASR 只涵蓋一段（範圍重辨識留下的）時只重建那段、範圍外不動 ——
 * 確認對話框只看會被蓋掉的段，toast 也講清楚動了哪一段，免得使用者以為整條都換了新樣式。
 */
export async function rebuildWithCurrentPreset(): Promise<void> {
  const mediaId = activeId();
  const tr = activeCaptions();
  if (!mediaId || !tr) return;
  const scope = sourceRange(tr.source, activeFrameCount());
  if (editedCuesIn(tr, scope)) {
    const msg = scope ? t("重新分段會取代語音辨識範圍內逐段修過的內容（範圍外不會動，可以復原）。要繼續嗎？") : t("重新分段會取代目前逐段修過的內容（可以復原）。要繼續嗎？");
    if (!(await uiConfirm(msg, { confirmText: t("重新分段") }))) return;
  }
  try {
    const r = await rebuildCaptions(mediaId, tr.presetId);
    const fps = activeFps();
    if (r.range && fps) toast.success(t("已重新分段 {a}–{b}（上次只辨識這段，範圍外的字幕沒有動）", { a: formatMs(msOfFrame(r.range.in, fps)), b: formatMs(msOfFrame(r.range.out, fps)) }));
    else toast.success(t("已重新分段成 {n} 段", { n: r.cues }));
  } catch (e) {
    toast.error(errMessage(e));
  }
}

export async function refineActive(): Promise<void> {
  const mediaId = activeId();
  if (!mediaId) return;
  openCaptionsPanel();
  try {
    const r = await refineCaptions(mediaId);
    for (const x of refineToasts(r)) toast[x.kind](x.text);
  } catch (e) {
    toast.error(errMessage(e));
  }
}

/**
 * guards.ts 的反應性沒有訂 useCaptionsUi（選中的字 / 舞台顯示開關）：這裡補訂，面板按鈕與選單勾選才會跟著變。
 * 不訂 proposal / lastRun 之類的顯示用欄位（不影響能不能做）。
 */
export function installCaptionCommandReactivity(): () => void {
  return useCaptionsUi.subscribe((s, p) => {
    if (s.selectedCueId !== p.selectedCueId || s.selectedWord !== p.selectedWord || s.showOnStage !== p.showOnStage) bumpCommandTick();
  });
}

function toggleBurnIn(): void {
  const mediaId = activeId();
  const tr = activeCaptions();
  if (mediaId && tr) useEdits.getState().setCaptionsEnabled(mediaId, !tr.enabled);
}

export const CAPTION_COMMANDS: Command[] = [
  // ---- 產生 ----
  { id: "captions.generate", title: "產生字幕…", group: "captions", section: SECTION, icon: Captions, pairId: "captions.generate", variant: "dialog", keywords: ["captions", "subtitles", "asr", "whisper", "transcribe", "字幕"], surfaces: ["menu", "palette", "toolbar"], enabled: needsMedia, run: () => openCaptionsPanel() },
  { id: "captions.generateQuick", title: "產生字幕（上次的設定）", group: "captions", section: SECTION, icon: Captions, pairId: "captions.generate", variant: "quick", keywords: ["captions", "subtitles", "asr", "whisper"], enabled: both(needsProxy, needsEngine, needsCaptionsIdle), run: () => generateCaptions() },
  { id: "captions.cancel", title: "停止產生字幕", group: "captions", section: SECTION, icon: Square, enabled: needsCaptionsRunning, run: () => void cancelCaptions(activeId() ?? undefined) },
  { id: "captions.refine", title: "本機 LLM 校對字幕", group: "captions", section: SECTION, icon: Sparkles, keywords: ["llm", "proofread", "lm studio"], enabled: both(needsCaptions, needsEngine, needsLlmEndpoint), run: () => refineActive() },
  // AI 章節與摘要：從字幕整理出章節標記、摘要、標題與 YouTube 章節文字（對標 Descript Chapters / YouTube 自動章節）
  { id: "captions.chapters", title: "AI 章節與摘要…", group: "captions", section: SECTION, icon: ListTree, keywords: ["chapters", "summary", "youtube", "章節", "摘要", "ai"], surfaces: ["menu", "palette", "toolbar"], enabled: both(needsCaptions, needsEngine, needsLlm), run: () => openDialog("chapters") },
  // AI 精華片段：從字幕挑出最值得單獨拿出來的幾段（對標 Opus Clip / CapCut AI 精華）。放在「AI」群組：那個選單集中所有 AI 功能
  { id: "ai.highlights", title: "AI 精華片段…", group: "ai", section: "AI", icon: Flame, keywords: ["highlights", "shorts", "clips", "best moments", "精華", "短影音", "ai"], surfaces: ["menu", "palette", "toolbar"], enabled: both(needsCaptions, needsEngine, needsLlm), run: () => openDialog("highlights") },
  // AI 配音：文字轉語音放到音軌（對標 CapCut 文字轉語音）。後端是自架 Seal-TTS，位址在設定、金鑰在 keychain
  { id: "ai.tts", title: "AI 配音（文字轉語音）…", group: "ai", section: "AI", icon: AudioLines, keywords: ["tts", "text to speech", "voice over", "narration", "配音", "旁白", "語音"], surfaces: ["menu", "palette", "toolbar"], enabled: both(needsMedia, needsTts), run: () => openDialog("tts", {}) },
  { id: "captions.rebuild", title: "依目前樣式重新分段", group: "captions", section: SECTION, icon: RefreshCw, enabled: both(needsAsrSource, needsEngine), run: () => rebuildWithCurrentPreset() },

  // ---- 編輯 ----
  { id: "captions.splitAtPlayhead", title: "在播放線分割字幕", group: "captions", section: "編輯", icon: Scissors, shortcuts: ["B"], surfaces: ["menu", "palette", "context"], enabled: needsSplitPoint, run: () => splitAtPlayhead() },
  { id: "captions.mergeNext", title: "與下一段字幕合併", group: "captions", section: "編輯", icon: Combine, enabled: needsNextCue, run: () => mergeTargetWithNext() },
  { id: "captions.insertCue", title: "在播放線插入字幕", group: "captions", section: "編輯", icon: Plus, enabled: needsProxy, run: () => insertCaptionAtPlayhead() },
  { id: "captions.deleteCue", title: "刪除這段字幕", group: "captions", section: "編輯", icon: Trash2, enabled: needsCaptionTarget, run: () => withUndoToast(t("已刪除字幕段"), () => void useEdits.getState().deleteCue(activeId()!, targetCueId()!)) },
  // 文字稿剪輯（Descript / CapCut / Premiere Text-Based Editing）：刪字就刪片。
  // 跟上面那一支只差一個字，但做的事完全不同，所以標題把「連影片一起」講明。
  { id: "captions.cutCue", title: "刪掉這句，連影片一起剪", group: "captions", section: "編輯", icon: ScissorsCut, keywords: ["transcript", "text based editing", "cut sentence", "文字稿"], enabled: needsCaptionTarget, run: () => cutCueFromSequence() },
  { id: "captions.toggleEmphasis", title: "切換強調（選中的字）", group: "captions", section: "編輯", icon: Highlighter, shortcuts: ["E"], surfaces: ["palette"], enabled: needsSelectedWord, run: () => toggleSelectedEmphasis() },
  { id: "captions.findReplace", title: "尋找 / 取代字幕文字", group: "captions", section: "編輯", icon: Replace, shortcuts: ["Ctrl+F"], keywords: ["find", "replace"], enabled: needsCaptions, run: () => (openCaptionsPanel(), useCaptionsUi.getState().setFind({ findOpen: true })) },
  { id: "captions.nudgeStartBack", title: "字幕起點提早 1 幀", group: "captions", section: "編輯", icon: ArrowLeftToLine, shortcuts: ["Ctrl+Alt+ArrowLeft"], surfaces: ["palette"], enabled: needsCaptionTarget, run: () => nudge(-1, "start") },
  { id: "captions.nudgeStartFwd", title: "字幕起點延後 1 幀", group: "captions", section: "編輯", icon: ArrowRightToLine, shortcuts: ["Ctrl+Alt+ArrowRight"], surfaces: ["palette"], enabled: needsCaptionTarget, run: () => nudge(1, "start") },
  { id: "captions.nudgeEndBack", title: "字幕終點提早 1 幀", group: "captions", section: "編輯", icon: ArrowLeftToLine, shortcuts: ["Ctrl+Alt+Shift+ArrowLeft"], surfaces: ["palette"], enabled: needsCaptionTarget, run: () => nudge(-1, "end") },
  { id: "captions.nudgeEndFwd", title: "字幕終點延後 1 幀", group: "captions", section: "編輯", icon: ArrowRightToLine, shortcuts: ["Ctrl+Alt+Shift+ArrowRight"], surfaces: ["palette"], enabled: needsCaptionTarget, run: () => nudge(1, "end") },
  {
    id: "captions.clear",
    title: "刪除全部字幕",
    group: "captions",
    section: "編輯",
    icon: Trash2,
    enabled: needsCaptions,
    run: async () => {
      const mediaId = activeId();
      if (!mediaId || !(await uiConfirm(t("刪除這支影片的全部字幕？（可以復原）"), { confirmText: t("刪除"), danger: true }))) return;
      useEdits.getState().applyCaptions(mediaId, null);
    },
  },

  // ---- 檢視 / 跳段 ----
  { id: "captions.toggleVisible", title: "舞台顯示字幕", group: "view", section: "圖層", icon: Captions, shortcuts: ["Shift+C"], checked: () => useCaptionsUi.getState().showOnStage, enabled: () => OK, run: () => useCaptionsUi.getState().setShowOnStage(!useCaptionsUi.getState().showOnStage) },
  { id: "captions.prevCue", title: "上一段字幕", group: "captions", section: "播放", icon: ChevronsLeft, enabled: needsCaptions, run: () => stepCue(-1) },
  { id: "captions.nextCue", title: "下一段字幕", group: "captions", section: "播放", icon: ChevronsRight, enabled: needsCaptions, run: () => stepCue(1) },

  // ---- 輸出 ----
  { id: "captions.toggleBurnIn", title: "輸出時燒入字幕", group: "captions", section: "輸出", icon: Flame, checked: () => !!activeCaptions()?.enabled, enabled: needsCaptions, run: () => toggleBurnIn() },
  { id: "captions.exportSrt", title: "匯出字幕 SRT…", group: "captions", section: "輸出", icon: FileText, keywords: ["srt", "subtitles"], enabled: both(needsCaptions, needsEngine), run: () => exportCaptionsAs("srt") },
  { id: "captions.exportVtt", title: "匯出字幕 WebVTT…", group: "captions", section: "輸出", icon: FileText, keywords: ["vtt", "webvtt"], enabled: both(needsCaptions, needsEngine), run: () => exportCaptionsAs("vtt") },
  { id: "captions.exportAss", title: "匯出字幕 ASS（含卡拉OK 時間）…", group: "captions", section: "輸出", icon: FileText, keywords: ["ass", "karaoke"], surfaces: ["palette"], enabled: both(needsCaptions, needsEngine), run: () => exportCaptionsAs("ass") },
  { id: "captions.exportTxt", title: "匯出逐字稿 TXT…", group: "captions", section: "輸出", icon: FileText, keywords: ["txt", "transcript"], surfaces: ["palette"], enabled: both(needsCaptions, needsEngine), run: () => exportCaptionsAs("txt") },
  { id: "captions.previewFrame", title: "引擎預覽此幀字幕", group: "captions", section: "輸出", icon: ImageDown, enabled: both(needsCaptions, needsEngine), run: () => previewThisFrame() },
  { id: "captions.installEngine", title: "安裝 / 修復語音辨識依賴", group: "help", section: SECTION, icon: RefreshCw, surfaces: ["palette"], enabled: () => OK, run: () => openDialog("engineSetup") },
];
