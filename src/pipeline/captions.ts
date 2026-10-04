import { api, decodeJson, errKind, errMessage, type EngineProgress } from "../api";
import { t } from "../i18n";
import { isRecord, type CaptionCueV1, type CaptionPresetId, type CaptionTrackV1, type Rational } from "../project/format";
import { emptyReport, sanitizeCaptionTrack } from "../project/sanitize";
import { cueText, effectiveStyle, framesOfMs, outputLanguageFor, parseLayoutDoc, useCaptionLayout, useCaptionsUi, type LoadedCaptionLayout, type RefineItem, type TranscribeOptions } from "../store/captions";
import { useEdits } from "../store/edits";
import { engineReady, useEngine } from "../store/engine";
import { useJobs, type JobKind } from "../store/jobs";
import { usePlayback } from "../store/playback";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import type { FrameRange } from "../store/timeline";
import { isLlmFailure, parseEngineWarnings, type EngineWarning } from "./captionWarnings";
import { mergeCaptionRange, rebuiltTrack } from "./captionsMerge";
import { dedupe, runEngineJob, runningJob } from "./engineJob";
import { cacheDirOf, joinPath, projectFileFor } from "./project";

/**
 * 字幕管線（規格 §5.4 / §5.7）：`asr.transcribe`（長工作，搶 GPU）→ `captions.build`（純函式、快，同步呼叫）→ 一筆 undo 收進 store。
 *
 * 跟牌的管線同一個原則：App 開著時 store 才是真相。引擎 op 讀的專案檔由 projectFileFor 先寫出來；
 * 會改專案的 op 一律 `no_save: true`，結果回來走 sanitize（drop-and-report）再進 store —— 引擎寫壞一個字，
 * 不該讓時間軸或舞台在很遠的地方才出事。
 *
 * args 是各 op argparse 的 dest 名：
 * - asr.transcribe：project / media / model / language / device / compute_type / beam_size / initial_prompt / hotwords [..] / vad_min_silence_ms / range "K0:K1" / force / keep_loaded
 * - captions.build：project / media / asr（ASR 快取檔路徑）/ preset / language（輸出語言）/ no_save
 * - captions.export：project / media / format srt|vtt|ass|txt / out / range / trim
 * - captions.refine：project / media / endpoint / model / tasks [..]（只回建議，不寫專案）
 * - captions.preview：project / media / frame / out（PNG）
 */

/** 工作清單的種類（標籤「字幕」在 video/labels.ts 與 inspector/labels.ts 的 JOB_KIND_LABEL）。 */
export const CAPTIONS_JOB_KIND: JobKind = "captions";

/** asr.transcribe 的回覆（規格 §5.4 Result）。 */
export interface AsrResult {
  path: string;
  language?: string | null;
  languageProb?: number | null;
  durationS?: number;
  device?: string;
  computeType?: string;
  model?: string;
  seconds?: number;
  rtf?: number;
  words?: number;
  segments?: number;
  /** VAD 判定有講話、卻沒有任何字的區段（秒）：混語片自動偵測時整段掉字的證據。 */
  gaps?: [number, number][];
  /** 引擎原句（或 `{code, message}` 物件）；一律過 captionWarnings.parseEngineWarnings 再顯示。 */
  warnings?: unknown[];
  /** 選配：跟 warnings 對齊的代碼（引擎有給就不必比對句型）。 */
  warningCodes?: unknown[];
  fallbackReason?: unknown;
}

/** 純函式：面板選項 → asr.transcribe args（vitest 驗這張表）。 */
export function transcribeArgs(project: string, mediaId: string, o: TranscribeOptions, range: FrameRange | null): Record<string, unknown> {
  return {
    project,
    media: mediaId,
    model: o.model,
    language: o.language || "auto",
    device: o.device,
    ...(o.initialPrompt.trim() ? { initial_prompt: o.initialPrompt.trim() } : {}),
    ...(o.hotwords.length ? { hotwords: o.hotwords } : {}),
    ...(range ? { range: `${range.in}:${range.out}` } : {}),
  };
}

export function buildArgs(project: string, mediaId: string, asrPath: string, preset: CaptionPresetId, outputLanguage: string | null): Record<string, unknown> {
  return { project, media: mediaId, asr: asrPath, preset, ...(outputLanguage ? { language: outputLanguage } : {}), no_save: true };
}

export type CaptionExportFormat = "srt" | "vtt" | "ass" | "txt";

export function exportArgs(project: string, mediaId: string, format: CaptionExportFormat, out: string, range: FrameRange | null = null, trim = false): Record<string, unknown> {
  return { project, media: mediaId, format, out, ...(range ? { range: `${range.in}:${range.out}` } : {}), ...(range && trim ? { trim: true } : {}) };
}

/** 引擎 progress 的 stage → 工作清單上的一行字（查不到就原樣）。 */
export function captionStageLabel(stage: string): string {
  if (stage.startsWith("asr.download")) return t("下載語音模型");
  if (stage.startsWith("asr.load")) return t("載入語音模型");
  if (stage.startsWith("asr")) return t("語音辨識");
  if (stage.startsWith("captions.refine") || stage.startsWith("refine")) return t("本機 LLM 校對");
  if (stage.startsWith("captions")) return t("字幕");
  return stage;
}

function relabel(p: EngineProgress): void {
  // runEngineJob 先用 video/labels 查表（沒有 asr 那幾個鍵）；這裡用字幕自己的表蓋掉顯示文字
  useJobs.getState().upsert({ id: p.job_id, step: captionStageLabel(p.stage) });
}

// 範圍重辨識 / 重新分段的段落合併是純函式，放在 captionsMerge.ts（驗收 Medium 1 的邊界要逐條測）；這裡轉出，呼叫端與既有測試不用改 import
export { mergeCaptionRange, mergeCuesInRange, rebuiltTrack, sourceRange } from "./captionsMerge";

function framesOf(mediaId: string): number | null {
  return useProject.getState().media.find((m) => m.id === mediaId)?.proxy?.frames ?? null;
}

function sanitizeBuilt(mediaId: string, raw: unknown): CaptionTrackV1 {
  const report = emptyReport();
  const track = sanitizeCaptionTrack(raw, framesOf(mediaId), report);
  if (!track) throw new Error(t("引擎回傳的字幕格式不正確"));
  return track;
}

export interface TranscribeSummary {
  cues: number;
  device: string | null;
  /** 引擎原值（字串 / 物件 / null）；顯示走 captionWarnings.fallbackReasonText。 */
  fallbackReason: unknown;
  warnings: EngineWarning[];
  gaps: [number, number][];
}

/**
 * 一鍵：辨識 → 分段 → 一筆 undo「產生字幕」。同一支媒體同時只跑一份（連點兩下拿同一個 promise）。
 * 失敗時把錯誤種類記在 useCaptionsUi.lastError（PyEnv = faster-whisper 沒裝，面板給「安裝 / 修復引擎」）。
 * 只重辨識一段（range）且已有字幕時：分段用 track 目前的預設、不是產生表單上的 —— 範圍內外同一套分段規則，合併後才不會半條 pop 半條 subtitle；
 * 合併規則見 captionsMerge.mergeCuesInRange（範圍外一個字都不動）。
 * 產生後的本機 LLM 校對（o.refine）由指令層接著跑（commands/captionCommands.generateCaptions）：結果要 toast，管線層不碰 UI。
 */
export function transcribeAndBuild(mediaId: string, o: TranscribeOptions, range: FrameRange | null): Promise<TranscribeSummary> {
  return dedupe(`captions:${mediaId}`, async () => {
    const ui = useCaptionsUi.getState();
    ui.setLastError(null);
    try {
      const project = await projectFileFor(mediaId);
      const asr = await runEngineJob<AsrResult>({
        kind: CAPTIONS_JOB_KIND,
        mediaId,
        op: "asr.transcribe",
        args: transcribeArgs(project, mediaId, o, range),
        gpu: o.device !== "cpu",
        step: t("語音辨識"),
        onProgress: relabel,
      });
      if (!asr?.path) throw new Error(t("語音辨識沒有回傳結果檔"));
      const before = useEdits.getState().captions[mediaId] ?? null;
      const preset = range && before ? before.presetId : o.preset;
      const built = await api.engineCall<unknown>("captions.build", buildArgs(project, mediaId, asr.path, preset, outputLanguageFor(o.language)), 120_000);
      const fresh = sanitizeBuilt(mediaId, built);
      // 合併用 build 回來「之後」的 store 值：辨識跑的這一兩分鐘使用者可能改了範圍外的字
      const prev = useEdits.getState().captions[mediaId] ?? null;
      const track = mergeCaptionRange(prev, { ...fresh, presetId: preset }, range);
      useEdits.getState().applyCaptions(mediaId, track, range ? "重新辨識範圍字幕" : "產生字幕");
      const summary: TranscribeSummary = { cues: track.cues.length, device: asr.device ?? null, fallbackReason: asr.fallbackReason ?? null, warnings: parseEngineWarnings(asr.warnings, asr.warningCodes), gaps: asr.gaps ?? [] };
      ui.setLastRun({ mediaId, device: summary.device, computeType: asr.computeType ?? null, fallbackReason: summary.fallbackReason, warnings: summary.warnings, gaps: summary.gaps, seconds: asr.seconds ?? null });
      return summary;
    } catch (e) {
      ui.setLastError({ mediaId, message: errMessage(e), kind: errKind(e) });
      throw e;
    }
  });
}

export function captionsRunning(mediaId?: string): boolean {
  return !!runningJob(CAPTIONS_JOB_KIND, mediaId);
}

export function cancelCaptions(mediaId?: string): boolean {
  const j = runningJob(CAPTIONS_JOB_KIND, mediaId);
  if (!j) return false;
  useJobs.getState().cancel(j.id);
  return true;
}

export interface RebuildSummary {
  /** 整條 track 重建後的段數。 */
  cues: number;
  /** 來源 ASR 只涵蓋這一段（範圍重辨識留下的）→ 只重建了這段，範圍外沒動；null = 整支重建。 */
  range: FrameRange | null;
}

/**
 * 依（新的）預設樣式重新分段：拿同一份 ASR 快取再跑一次 captions.build。樣式 / 燒入開關沿用；一筆 undo。
 * 來源是整支的 ASR → 段落整個換掉；來源是範圍重辨識留下的（source.range）→ 只重建範圍內的段、範圍外原樣
 * （驗收 Medium 1：之前一律整個換掉，範圍外的字幕整片消失）。
 * 沒有 ASR 來源（手打的字幕、舊檔）→ 擲錯，面板改提示重新辨識。
 */
export async function rebuildCaptions(mediaId: string, preset: CaptionPresetId): Promise<RebuildSummary> {
  const prev = useEdits.getState().captions[mediaId] ?? null;
  const asrPath = prev?.source?.asrPath;
  if (!prev || !asrPath) throw new Error(t("這份字幕沒有語音辨識來源，請重新產生字幕"));
  const project = await projectFileFor(mediaId);
  const built = await api.engineCall<unknown>("captions.build", buildArgs(project, mediaId, asrPath, preset, prev.language || null), 120_000);
  const fresh = sanitizeBuilt(mediaId, built);
  // 合併用引擎回來「之後」的 store 值（範圍外那些段要保留的是使用者現在看到的樣子）；
  // 期間整條字幕被刪了、或又跑了一次辨識換了來源 → 這份結果已經過期，套上去只會蓋掉比較新的東西
  const cur = useEdits.getState().captions[mediaId] ?? null;
  if (!cur || cur.source?.asrPath !== asrPath) throw new Error(t("字幕在重新分段期間被換掉了，請再按一次"));
  const { track, range } = rebuiltTrack(cur, fresh, preset, framesOf(mediaId));
  useEdits.getState().applyCaptions(mediaId, track, "依樣式重新分段");
  return { cues: track.cues.length, range };
}

// ---- 匯出 / 單幀預覽 ----

export interface CaptionExportResult {
  out?: string;
  path?: string;
  cues?: number;
}

export async function exportCaptions(mediaId: string, format: CaptionExportFormat, out: string, range: FrameRange | null = null, trim = false): Promise<CaptionExportResult> {
  const project = await projectFileFor(mediaId);
  return api.engineCall<CaptionExportResult>("captions.export", exportArgs(project, mediaId, format, out, range, trim), 120_000);
}

/** 引擎渲染這一幀的字幕疊層（最終長相）→ PNG 路徑。舞台上的 canvas 只是近似，對樣式時看這張。 */
export async function previewCaptionFrame(mediaId: string, frame: number): Promise<string> {
  const project = await projectFileFor(mediaId);
  const out = joinPath(await cacheDirOf(mediaId), "captions", `preview-${frame}.png`);
  const r = await api.engineCall<{ path?: string; out?: string }>("captions.preview", { project, media: mediaId, frame, out }, 60_000);
  return r?.path ?? r?.out ?? out;
}

// ---- 舞台用的引擎版面 + 圖集（captions.layout）----

const LAYOUT_DEBOUNCE_MS = 300;
/** 版面視窗：播放線前後各 90 秒（規格 §5.7）；播放線離視窗邊緣不到 30 秒就換視窗。 */
const LAYOUT_HALF_WINDOW_MS = 90_000;
const LAYOUT_EDGE_MS = 30_000;
/** 版面 op 失敗（引擎太舊、字型找不到…）之後，同一份字幕這段時間內不重試，改用 canvas 近似，不要每一幀敲一次引擎。 */
const LAYOUT_RETRY_MS = 15_000;

/** 引擎回的絕對路徑 → 快取讀取用的相對路徑（`<cache>/media/<fp16>/` 之後那段，分隔符一律 `/`）。 */
export function cacheRelPath(abs: string, mediaId: string): string | null {
  const parts = abs.split(/[\\/]+/).filter(Boolean);
  const i = parts.lastIndexOf(mediaId);
  if (i < 0 || i === parts.length - 1) return null;
  const rel = parts.slice(i + 1);
  return rel.includes("..") ? null : rel.join("/");
}

/** 以播放線為中心的版面視窗 [K0, K1)。 */
export function layoutWindow(frame: number, frames: number, fps: Rational): [number, number] {
  const half = framesOfMs(LAYOUT_HALF_WINDOW_MS, fps);
  const a = Math.max(0, frame - half);
  const b = frames > 0 ? Math.min(frames, frame + half) : frame + half;
  return [a, Math.max(a + 1, b)];
}

/**
 * 目前載入的版面還能不能用：同媒體、track 設定同參考、視窗內每一段都是請求當下那個物件（沒新增 / 刪除 / 修改），
 * 而且播放線離視窗邊緣還有 30 秒（到片頭片尾的邊不算）。
 */
export function layoutIsCurrent(l: LoadedCaptionLayout | null, mediaId: string, track: CaptionTrackV1, frame: number, frames: number, fps: Rational): boolean {
  if (!l || l.mediaId !== mediaId) return false;
  const s = l.sig;
  if (s.presetId !== track.presetId || s.style !== track.style || s.segmentation !== track.segmentation || s.language !== track.language) return false;
  const [a, b] = l.doc.range;
  const inWindow = track.cues.filter((c) => c.endFrame > a && c.startFrame < b);
  if (inWindow.some((c) => l.cues.get(c.id) !== c) || inWindow.length !== [...l.cues.values()].filter((c) => c.endFrame > a && c.startFrame < b).length) return false;
  const edge = framesOfMs(LAYOUT_EDGE_MS, fps);
  return (a <= 0 || frame - a >= edge) && (b >= frames || b - frame >= edge);
}

function closeImage(img: CanvasImageSource | undefined): void {
  const c = (img as { close?: () => void } | undefined)?.close;
  if (typeof c === "function") c.call(img);
}

let layoutFailure: { key: CaptionTrackV1; at: number } | null = null;

/** 需要的話向引擎要一份新的版面 + 圖集並放進 useCaptionLayout。任何失敗都安靜退回 canvas 近似（這是預覽，不是輸出）。 */
export async function refreshCaptionLayout(): Promise<void> {
  const mediaId = useProject.getState().activeMediaId;
  const media = useProject.getState().media.find((m) => m.id === mediaId);
  const track = mediaId ? useEdits.getState().captions[mediaId] ?? null : null;
  if (!mediaId || !media?.proxy || !track?.cues.length || !useCaptionsUi.getState().showOnStage || !engineReady()) return;
  const { fps, frames } = media.proxy;
  const frame = usePlayback.getState().frame;
  const cur = useCaptionLayout.getState().layout;
  if (layoutIsCurrent(cur, mediaId, track, frame, frames, fps)) return;
  if (layoutFailure && layoutFailure.key === track && Date.now() - layoutFailure.at < LAYOUT_RETRY_MS) return;
  // 請求當下的 cue 物件與設定：回來時逐段比對，期間又被改過的段自動退回近似
  const cues = new Map(track.cues.map((c) => [c.id, c]));
  const sig = { presetId: track.presetId, style: track.style, segmentation: track.segmentation, language: track.language };
  const [a, b] = layoutWindow(frame, frames, fps);
  try {
    // 暫存專案檔另開一個名字：不動使用者的專案檔（不自動存檔）、也不跟 pipeline.run 用的暫存檔搶
    const project = joinPath(await cacheDirOf(mediaId), "captions-layout.aivc.json");
    await useProject.getState().writeSnapshot(project);
    const r = await api.engineCall<{ path?: string; relPath?: string }>("captions.layout", { project, media: mediaId, range: `${a}:${b}` }, 60_000);
    // 引擎有回快取相對路徑（relPath）就直接用；舊版只回絕對路徑時自己從 <fp16>/ 之後切
    const rel = typeof r?.relPath === "string" && !r.relPath.includes("..") ? r.relPath : r?.path ? cacheRelPath(r.path, mediaId) : null;
    if (!rel) throw new Error("captions.layout: no path");
    const doc = parseLayoutDoc(decodeJson(await api.cacheRead(mediaId, rel)));
    if (!doc) throw new Error("captions.layout: bad layout.v1.json");
    const png = await api.cacheRead(mediaId, rel.replace(/[^/]+$/, doc.atlas.path));
    const atlas = await createImageBitmap(new Blob([png], { type: "image/png" }));
    if (useProject.getState().activeMediaId !== mediaId) {
      closeImage(atlas);
      return;
    }
    const prev = useCaptionLayout.getState().layout;
    useCaptionLayout.getState().setLayout({ mediaId, doc, atlas, byId: new Map(doc.cues.map((c) => [c.id, c])), cues, sig });
    if (prev) closeImage(prev.atlas);
    layoutFailure = null;
  } catch {
    layoutFailure = { key: track, at: Date.now() };
  }
}

/**
 * 舞台掛載時裝上：字幕改了（debounce 300 ms）、換媒體、引擎就緒、打開舞台字幕、播放線快出視窗 → 重新要版面。
 * 同時只跑一份；跑的期間又有變動就跑完再補一次。回傳拆除函式。
 */
export function installCaptionLayoutSync(): () => void {
  let timer: number | null = null;
  let running = false;
  let again = false;
  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await refreshCaptionLayout();
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule();
      }
    }
  };
  const schedule = (delay = LAYOUT_DEBOUNCE_MS) => {
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      void run();
    }, delay);
  };
  const offs = [
    useEdits.subscribe((s, p) => {
      if (s.captions !== p.captions) schedule();
    }),
    useProject.subscribe((s, p) => {
      if (s.activeMediaId === p.activeMediaId && s.media === p.media) return;
      const l = useCaptionLayout.getState().layout;
      if (l && l.mediaId !== s.activeMediaId) {
        useCaptionLayout.getState().setLayout(null);
        closeImage(l.atlas);
      }
      schedule(0);
    }),
    usePlayback.subscribe((s, p) => {
      // 播放線每幀都在動：只有「有版面、而且快出視窗」才排程（layoutIsCurrent 是幾個比較，便宜）
      if (s.frame === p.frame) return;
      const l = useCaptionLayout.getState().layout;
      if (!l) return;
      const media = useProject.getState().media.find((m) => m.id === l.mediaId);
      const track = useEdits.getState().captions[l.mediaId];
      if (media?.proxy && track && !layoutIsCurrent(l, l.mediaId, track, s.frame, media.proxy.frames, media.proxy.fps) && timer == null && !running) schedule();
    }),
    useEngine.subscribe((s, p) => {
      if (s.state !== p.state && s.state === "ready") schedule(0);
    }),
    useCaptionsUi.subscribe((s, p) => {
      if (s.showOnStage && !p.showOnStage) schedule(0);
    }),
  ];
  schedule(0);
  return () => {
    if (timer != null) window.clearTimeout(timer);
    for (const off of offs) off();
  };
}

// ---- 本機 LLM 校對（選配）----

/**
 * captions.refine 的回覆 → 面板的前 / 後對照。引擎形狀是 `{proposals: [{cueId, before, after, emphasis, accepted, reason}]}`；
 * 引擎自己擋掉的（相似度 / 長度比不合格，accepted: false）不給人看。也收 `{cues: [{id, text, emphasis}]}`（規格 §5.4 的 LLM 回應形狀）。
 * 「前」一律用 store 目前的文字：LLM 跑的這一兩分鐘使用者可能又改過。
 */
export function parseRefineResult(raw: unknown, cues: readonly CaptionCueV1[], cjkLatinSpace = false): RefineItem[] {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(o.proposals) ? o.proposals : Array.isArray(o.cues) ? o.cues : [];
  const byId = new Map(cues.map((c) => [c.id, c]));
  const out: RefineItem[] = [];
  for (const x of list) {
    if (!x || typeof x !== "object") continue;
    const it = x as Record<string, unknown>;
    if (it.accepted === false) continue;
    const id = typeof it.cueId === "string" ? it.cueId : typeof it.id === "string" ? it.id : null;
    const cue = id ? byId.get(id) : undefined;
    const text = typeof it.after === "string" ? it.after : typeof it.text === "string" ? it.text : null;
    if (!cue || text == null) continue;
    const before = cueText(cue, cjkLatinSpace);
    const after = text.trim();
    const emphasis = Array.isArray(it.emphasis) ? it.emphasis.filter((e): e is string => typeof e === "string" && !!e.trim()) : [];
    if (!after || (after === before && !emphasis.length)) continue;
    out.push({ cueId: cue.id, before, after, emphasis });
  }
  return out;
}

export interface RefineOutcome {
  /** 給人看的建議數（已放進 useCaptionsUi.proposal）。 */
  count: number;
  warnings: EngineWarning[];
  /** 本機 LLM 沒做成（連不上 / 沒模型 / 回傳壞掉）：這時「沒有修改建議」不是真的，要講失敗原因。 */
  failed: boolean;
}

/** captions.refine 回覆裡的警告；`reachable: false` 卻沒附對應警告（引擎舊版 / 形狀怪）也算失敗，補一則「連不上」。 */
export function refineWarnings(raw: unknown, endpoint: string): { warnings: EngineWarning[]; failed: boolean } {
  const o = isRecord(raw) ? raw : {};
  const warnings = parseEngineWarnings(o.warnings, o.warningCodes);
  if (o.reachable === false && !warnings.some(isLlmFailure)) warnings.unshift({ code: "llmUnreachable", params: endpoint ? { endpoint } : {}, message: "" });
  return { warnings, failed: warnings.some(isLlmFailure) };
}

/** 跑 captions.refine → 建議放進 useCaptionsUi.proposal（使用者按「套用」才進專案，一筆 undo）。 */
export function refineCaptions(mediaId: string): Promise<RefineOutcome> {
  return dedupe(`captions.refine:${mediaId}`, async () => {
    const s = useSettings.getState().s;
    const endpoint = s.llm_openai_base_url.trim();
    if (!endpoint) throw new Error(t("先在設定填本機 LLM 端點（OpenAI 相容）"));
    const track = useEdits.getState().captions[mediaId];
    if (!track?.cues.length) return { count: 0, warnings: [], failed: false };
    const project = await projectFileFor(mediaId);
    const raw = await runEngineJob<unknown>({
      kind: CAPTIONS_JOB_KIND,
      mediaId,
      op: "captions.refine",
      args: { project, media: mediaId, endpoint, ...(s.llm_openai_model.trim() ? { model: s.llm_openai_model.trim() } : {}), tasks: "tw,punct,typo,emphasis" },
      gpu: false,
      step: t("本機 LLM 校對"),
      onProgress: relabel,
    });
    const cur = useEdits.getState().captions[mediaId];
    const items = cur ? parseRefineResult(raw, cur.cues, effectiveStyle(cur).font.cjkLatinSpace) : [];
    useCaptionsUi.getState().setProposal(items.length ? { mediaId, items } : null);
    return { count: items.length, ...refineWarnings(raw, endpoint) };
  });
}
