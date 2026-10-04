import { api } from "../api";
// M2.17 序列輸出的摘要與驗收（純函式在檔案最後一段）
import type { SequenceV2, VideoClipV2 } from "../project/format";
import { durationFrames, isUntouched, placedAt, placeVideo, type FramesOf } from "../sequence/map";
import { useJobs } from "../store/jobs";
import type { FrameRange } from "../store/timeline";
import { runEngineJob, runningJob } from "./engineJob";
import { renderArgs as pluginRenderArgs } from "../plugins/queries";
import { projectFileFor } from "./project";

/**
 * 輸出（引擎 `render.plan` / `render.run`；決策 6：encode_plan.plan() 只有 Python 一份，TS 只顯示結果）。
 *
 * args = engine/ops/render.py `_common_args` 的 dest 名：`project` / `out` / `media` / `codec` / `quality`（crf / cq **整數**）/
 * `audio auto|copy|encode|none` / `no_gpu` / `range "K0:K1"` / `trim` / `track` [ids] / `seed` / `emit_matte` / `emit_faces` /（外掛加的參數見 plugins/queries renderArgs）
 * `captions auto|on|off` / `captions_sidecar srt|vtt|ass` / `reframe <路徑檔>`；`render.run` 多一個 `dry_run`（= render.plan）。
 * null 的欄位不送，讓引擎用 exportDefaults / 容器預設；captions 是 auto 也不送（引擎預設就是 auto = 看字幕 track 的 enabled）。
 */
export type AudioMode = "auto" | "copy" | "encode" | "none";
/** 燒入字幕：auto = 跟字幕分頁「輸出時燒入」開關走；on = 有字幕就燒；off = 這次不燒。 */
export type CaptionsBurnMode = "auto" | "on" | "off";
export type CaptionsSidecar = "srt" | "vtt" | "ass";

export interface ExportOpts {
  outPath: string;
  /** 只合成這一段（proxy 幀）；仍寫出全部幀，除非 trim。 */
  range: FrameRange | null;
  trim?: boolean;
  /** null / "auto" = 引擎依容器決定。 */
  codec: string | null;
  /** crf / cq；null = exportDefaults。 */
  quality: number | null;
  audio: AudioMode | null;
  noGpu?: boolean;
  trackIds?: string[];
  seed?: number;
  emitMatte?: string | null;
  emitFaces?: string | null;
  captions?: CaptionsBurnMode | null;
  /** 編碼完成後另寫 `<輸出檔名>.<格式>`（--trim 時時間跟著平移）；null = 不寫。 */
  captionsSidecar?: CaptionsSidecar | null;
  /**
   * 字幕檔已存在時覆寫（引擎 `--overwrite-sidecar`）。引擎預設不覆寫、在編碼前就報錯：存檔對話框只問過影片檔，
   * 旁邊同名的 .srt 可能是使用者手修過的 —— 所以 ExportDialog 先問，使用者答應才帶這個旗標。
   */
  overwriteSidecar?: boolean;
  /**
   * 序列（M2.17，引擎 `sequence auto|ignore`）：null / "auto" = 專案有序列就輸出序列（不送，引擎預設就是 auto，v0.0.6 的 args 逐鍵不變）；
   * "ignore" = 只輸出目前素材（CLI `--source`），範圍是來源 proxy 幀。
   */
  sequence?: "auto" | "ignore" | null;
  /**
   * 自動重構圖的路徑檔（引擎 `--reframe`）：輸出尺寸改成裁切尺寸，鏡頭照路徑走。
   * null = 不重構，輸出維持合成尺寸。路徑由 `pipeline/reframe.ts` 的 `planReframe` 產生。
   */
  reframe?: string | null;
}

/** 引擎寫字幕檔的位置（= render.py RenderPlan.sidecar_path：輸出檔換副檔名，Path.with_suffix 只換最後一段）。 */
export function sidecarPathFor(outPath: string, format: CaptionsSidecar): string {
  const m = /^(.*?)(\.[^.\\/]*)?$/.exec(outPath);
  const stem = m?.[2] && m[1] && !/[\\/]$/.test(m[1]) ? m[1] : outPath;
  return `${stem}.${format}`;
}

/** RenderPlan.to_json 的 captions 區段（captions/burn.py CaptionBurner.to_json）：字型退路要讓使用者在輸出前看到。 */
export interface RenderPlanCaptions {
  cues: number;
  frames: number;
  preset: string;
  language?: string;
  font: { path: string | null; family?: string | null; cjk?: boolean; source?: string };
  /** 逐段排不下 `{kind: "overflow", cueId}`、字型缺字 `{kind: "fontNoCjk" | "fontFallback", message, font}`；顯示走 captionWarnings。 */
  warnings: { kind?: string; cueId?: string; message?: string; font?: string }[];
}

/** RenderPlan.to_json（engine/ops/render.py）。 */
export interface RenderPlanResult {
  out: string;
  encode: {
    container: string;
    format: string;
    ext: string;
    video_codec: string;
    video_args: string[];
    audio_mode: string;
    audio_codec: string | null;
    audio_args: string[];
    color_args: string[];
    gpu: boolean;
    deterministic: boolean;
    dropped: string[];
    notes: string[];
  };
  size: [number, number];
  fps: { num: number; den: number };
  frames: { total: number; write: number; composite: number };
  range: [number, number] | null;
  trim: boolean;
  /**
   * 要合成的 track。slot / target / original 是牌外掛的插入來源才有的（一般專案沒有）；
   * effects / replace 是通用的特效與替換（契約：track.effects / track.replace），引擎回報的形狀由 exportEdits.planEdits 寬鬆解析。
   */
  tracks: { id: string; shot?: string; kind?: string; slot?: string; target?: string; original?: string | null; rotation?: number; regionPolicy?: string; macro?: string; frames?: number; masks?: boolean; effects?: unknown; replace?: unknown }[];
  skipped: { trackId: string; reason: string }[];
  emitMatte: string | null;
  emitFaces: string | null;
  captions?: RenderPlanCaptions | null;
  captionsSidecar?: string | null;
  /** 字幕檔已經存在（沒帶 overwriteSidecar 時 render.run 會在編碼前報錯）。 */
  captionsSidecarExists?: boolean;
  /** 專案有序列時才有（engine render.py SequencePlan.sequence_json）；隱含序列 / --source 時整個鍵不存在（I4）。 */
  sequence?: RenderPlanSequence;
  /** 同上（SequencePlan.audio_json）。 */
  audio?: RenderPlanAudio;
  _human?: string;
}

export interface RenderPlanSequence {
  id: string;
  frames: number;
  duration: string;
  fps: { num: number; den: number };
  clips: number;
  gaps: number;
  disabled: number;
  audioClips: number;
  /** true = 序列等於未動過的整段片段：走 v0.0.6 原路徑（-c:a copy）。 */
  untouched: boolean;
  range: [number, number] | null;
  trim: boolean;
}

export interface RenderPlanAudio {
  mode: string;
  codec: string | null;
  /** 為什麼重新混音（引擎的中文句子；介面顯示用 TS 自己算的 mixReasonsOf，這份給日誌）。 */
  reasons: string[];
  inputs: number;
  /** mix 模式輸出的樣本數 S(T)（有 --trim 時是範圍內的）。 */
  samples: number | null;
  graph: string | null;
  /** 保守的峰值上界；來源的波形還沒算好時 null。 */
  peakEstimateDbfs: number | null;
  limiter: boolean;
  notes: string[];
}

/** run_render 的回覆。 */
export interface RenderResult {
  out: string;
  frames: number;
  bytes: number;
  seconds: number;
  fps: number | null;
  encoder: string;
  audio: { mode: string; codec: string | null; samples?: number | null };
  dropped: string[];
  notes: string[];
  skipped: { trackId: string; reason: string }[];
  plan?: RenderPlanResult;
  sequence?: RenderPlanSequence;
  _human?: string;
}

/** 純函式：UI 選項 → 引擎 args（vitest 驗這張表）。 */
export function renderArgs(project: string, mediaId: string, o: ExportOpts): Record<string, unknown> {
  return {
    project,
    out: o.outPath,
    media: mediaId,
    ...(o.codec && o.codec !== "auto" ? { codec: o.codec } : {}),
    ...(o.quality != null && Number.isFinite(o.quality) ? { quality: Math.round(o.quality) } : {}),
    ...(o.audio ? { audio: o.audio } : {}),
    ...(o.noGpu ? { no_gpu: true } : {}),
    ...(o.range ? { range: `${o.range.in}:${o.range.out}` } : {}),
    ...(o.range && o.trim ? { trim: true } : {}),
    ...(o.trackIds?.length ? { track: o.trackIds } : {}),
    ...(o.seed ? { seed: o.seed } : {}),
    ...(o.emitMatte ? { emit_matte: o.emitMatte } : {}),
    ...(o.emitFaces ? { emit_faces: o.emitFaces } : {}),
    ...(o.captions && o.captions !== "auto" ? { captions: o.captions } : {}),
    ...(o.captionsSidecar ? { captions_sidecar: o.captionsSidecar } : {}),
    ...(o.captionsSidecar && o.overwriteSidecar ? { overwrite_sidecar: true } : {}),
    ...(o.sequence === "ignore" ? { sequence: "ignore" } : {}),
    ...(o.reframe ? { reframe: o.reframe } : {}),
  };
}

/** 乾跑：只回計畫，不解碼不編碼（ExportDialog 的預覽區）。 */
export async function planExport(mediaId: string, o: ExportOpts): Promise<RenderPlanResult> {
  const project = await projectFileFor(mediaId);
  return api.engineCall<RenderPlanResult>("render.plan", { ...renderArgs(project, mediaId, o), ...pluginRenderArgs(mediaId) }, 60_000);
}

export async function exportVideo(mediaId: string, o: ExportOpts): Promise<RenderResult> {
  const project = await projectFileFor(mediaId);
  return runEngineJob<RenderResult>({ kind: "export", mediaId, op: "render.run", args: { ...renderArgs(project, mediaId, o), ...pluginRenderArgs(mediaId) }, step: "渲染輸出" });
}

export function exportRunning(mediaId?: string): boolean {
  return !!runningJob("export", mediaId);
}

export function cancelExport(mediaId?: string): boolean {
  const j = runningJob("export", mediaId);
  if (!j) return false;
  useJobs.getState().cancel(j.id);
  return true;
}

// ============================================================================
// M2.17 序列輸出：摘要、音訊白話、削波警告、輸出後驗收（docs/editor-m2-design.md §12「輸出對話框」、§13 M2.17）
// ============================================================================

/** 一句可翻譯的話：key 是 zh（t() 的鍵），params 是插值。 */
export interface Phrase {
  key: string;
  params?: Record<string, string | number>;
}

export interface SequenceExportSummary {
  name: string;
  frames: number;
  seconds: number;
  clips: number;
  gaps: number;
  disabled: number;
  audioClips: number;
  /** 音樂軌上的片段數（對話框的「1 音樂」）。 */
  musicClips: number;
  /** 等於未動過的整段片段 → v0.0.6 原路徑（-c:a copy）。 */
  untouched: boolean;
  /** 為什麼要重新混音（untouched 時空）。 */
  reasons: Phrase[];
}

/**
 * 重新混音的原因（engine `audio_graph.mix_reasons` 的鏡像，順序相同）。放在 TS 算而不是直接顯示計畫裡的句子：
 * 引擎給的是中文句子，英文介面會冒出中文；而且對話框一打開就要顯示，不必等「預覽編碼計畫」。
 */
export function mixReasonsOf(seq: SequenceV2, framesOf: FramesOf): Phrase[] {
  const clips = seq.video.filter((x): x is VideoClipV2 => x.kind === "clip");
  const gaps = seq.video.length - clips.length;
  const out: Phrase[] = [];
  const whole = (c: VideoClipV2) => {
    const n = framesOf(c.mediaId);
    return n == null ? null : c.srcIn === 0 && c.srcOut === n;
  };
  if (clips.length > 1 || clips.some((c) => whole(c) === false)) out.push({ key: "分割／修剪過片段" });
  else if (clips.some((c) => whole(c) === null)) out.push({ key: "媒體幀數未知（無法確認片段是整段）" });
  if (!clips.length && !gaps) out.push({ key: "序列是空的" });
  if (gaps) out.push({ key: "{n} 段空白", params: { n: gaps } });
  const disabled = clips.filter((c) => !c.enabled).length;
  if (disabled) out.push({ key: "停用 {n} 個片段", params: { n: disabled } });
  if (clips.some((c) => c.audio.gainDb !== 0 || c.audio.fadeIn !== 0 || c.audio.fadeOut !== 0 || c.audio.envelope.length > 0)) out.push({ key: "片段增益或淡化" });
  if (clips.some((c) => !c.audio.enabled)) out.push({ key: "原音靜音或已分離" });
  if (seq.original.muted || seq.original.gainDb !== 0) out.push({ key: "原音軌靜音或推桿" });
  const n = seq.audioLanes.reduce((a, l) => a + l.clips.length, 0);
  if (n) out.push({ key: "加入 {n} 段音訊", params: { n } });
  return out.length ? out : [{ key: "序列已修改" }];
}

export function sequenceExportSummary(seq: SequenceV2, framesOf: FramesOf): SequenceExportSummary {
  const frames = durationFrames(seq);
  const untouched = isUntouched(seq, framesOf);
  return {
    name: seq.name,
    frames,
    seconds: seq.fps.num > 0 ? (frames * seq.fps.den) / seq.fps.num : 0,
    clips: seq.video.filter((x) => x.kind === "clip").length,
    gaps: seq.video.filter((x) => x.kind === "gap").length,
    disabled: seq.video.filter((x) => x.kind === "clip" && !x.enabled).length,
    audioClips: seq.audioLanes.reduce((a, l) => a + l.clips.length, 0),
    musicClips: seq.audioLanes.filter((l) => l.role === "music").reduce((a, l) => a + l.clips.length, 0),
    untouched,
    reasons: untouched ? [] : mixReasonsOf(seq, framesOf),
  };
}

/** 輸出檔副檔名 → 重新混音的編碼（engine encode_plan CONTAINERS 的 audio_mix / audio_encode）。不認得的容器回 null。 */
export function mixCodecLabel(outPath: string): string | null {
  const ext = /\.([^.\\/]+)$/.exec(outPath)?.[1]?.toLowerCase();
  if (ext === "webm") return "Opus 160 kbps";
  if (ext === "mp4" || ext === "mov" || ext === "m4v") return "AAC 160 kbps";
  if (ext === "mkv") return "FLAC";
  return null;
}

/**
 * 音訊一行白話：「音訊：重新混音 → Opus 160 kbps（原因：…）」或「音訊：直接複製（序列未修改）」。
 * audio = none 時講「不輸出」；沒有序列（隱含序列、或選了只輸出素材）回 null，對話框照 M1 顯示。
 */
export function audioSummaryPhrase(summary: SequenceExportSummary | null, audio: AudioMode | null, outPath: string): { line: Phrase; reasons: Phrase[] } | null {
  if (!summary) return null;
  if (audio === "none") return { line: { key: "音訊：不輸出" }, reasons: [] };
  if (summary.untouched) return { line: { key: "音訊：直接複製（序列未修改）" }, reasons: [] };
  const codec = mixCodecLabel(outPath);
  return { line: codec ? { key: "音訊：重新混音 → {codec}", params: { codec } } : { key: "音訊：重新混音" }, reasons: summary.reasons };
}

/** 削波警告的門檻（engine audio_graph.PEAK_WARN_DBFS）。 */
export const PEAK_WARN_DBFS = -1;

/** 計畫估計會削波（而且沒開限幅器）→ 估計峰值；否則 null（峰值未知也是 null：波形還沒算好時不瞎猜）。 */
export function clippingPeak(plan: Pick<RenderPlanResult, "audio"> | null): number | null {
  const a = plan?.audio;
  if (!a || a.mode !== "mix" || a.limiter || a.peakEstimateDbfs == null) return null;
  return a.peakEstimateDbfs > PEAK_WARN_DBFS ? a.peakEstimateDbfs : null;
}

/**
 * 序列時間軸上標的範圍 → 「只輸出目前素材」時的來源範圍：兩端都落在同一個（這支媒體的）片段裡才換得過去，
 * 否則 null（範圍跨了剪輯點或別支媒體，沒有對應的一段來源）。
 */
export function sourceRangeOfSequenceRange(seq: SequenceV2, mediaId: string, r: FrameRange): FrameRange | null {
  const p = placedAt(placeVideo(seq), r.in);
  if (!p || p.item.kind !== "clip" || p.item.mediaId !== mediaId || r.out > p.t1) return null;
  return { in: p.item.srcIn + (r.in - p.t0), out: p.item.srcIn + (r.out - p.t0) };
}

// ---- 輸出後驗收 ----

export interface ExportExpectation {
  /** 視訊應有的幀數（plan.frames.write）。 */
  frames: number;
  fps: { num: number; den: number };
  /** 音訊應有的樣本數（mix 模式的 S(T)）；copy / none / 沒有音軌時 null（不驗樣本數）。 */
  samples: number | null;
  sampleRate: number;
  /** mp4 / mov 的 AAC：解碼後尾端會多 0～1023 個樣本（edit list 只補償開頭 priming，§1.2 I3 例外）。 */
  aacTailSlack: boolean;
}

export interface ExportMeasurement {
  frames: number | null;
  /** 解碼後的音訊樣本數（以 pts 對齊）；沒有音軌 null。 */
  samples: number | null;
  sampleRate: number | null;
}

export interface ExportCheck {
  id: "frames" | "samples" | "duration";
  ok: boolean;
  expected: number | null;
  actual: number | null;
}

export interface ExportVerification {
  ok: boolean;
  checks: ExportCheck[];
}

/** 期望值：只有序列重新混音時才驗樣本數（copy 路徑的音軌是來源原樣，長度本來就跟畫面無關）。 */
export function expectationOf(plan: RenderPlanResult): ExportExpectation {
  const samples = plan.audio?.mode === "mix" ? plan.audio.samples ?? null : null;
  const ext = plan.encode.ext.replace(/^\./, "").toLowerCase();
  return { frames: plan.frames.write, fps: plan.fps, samples, sampleRate: 48000, aacTailSlack: samples !== null && (ext === "mp4" || ext === "mov" || ext === "m4v") };
}

/**
 * 輸出後驗收（§12、§13 M2.17）：視訊幀數 = T；音訊解碼樣本數 = S(T)（mp4 / AAC 允許多 0～1023）；音訊與視訊長度差 ≤ 1 幀。
 * 純函式：量測由 measureExport 做。
 */
export function verifyExport(exp: ExportExpectation, m: ExportMeasurement): ExportVerification {
  const checks: ExportCheck[] = [{ id: "frames", ok: m.frames === exp.frames, expected: exp.frames, actual: m.frames }];
  if (exp.samples !== null) {
    const extra = m.samples === null ? -1 : m.samples - exp.samples;
    checks.push({ id: "samples", ok: exp.aacTailSlack ? extra >= 0 && extra <= 1023 : extra === 0, expected: exp.samples, actual: m.samples });
    const sr = m.sampleRate ?? exp.sampleRate;
    if (m.samples !== null && m.frames !== null && sr > 0 && exp.fps.num > 0) {
      const diffFrames = Math.abs(m.samples / sr - (m.frames * exp.fps.den) / exp.fps.num) * (exp.fps.num / exp.fps.den);
      // AAC 尾端多出來的樣本（最多 1023，約 0.64 幀 @30）也在容許的 1 幀內
      checks.push({ id: "duration", ok: diffFrames <= 1 + 1e-9, expected: 0, actual: Math.round(diffFrames * 1000) / 1000 });
    }
  }
  return { ok: checks.every((c) => c.ok), checks };
}

interface IndexOpResult {
  nSource?: number;
}

interface AudioInfoOpResult {
  audio?: { sampleRate: number; nSamples: number } | null;
}

/**
 * 量測輸出檔：引擎 `media.index`（整支解碼一趟數幀）與 `media.audio_info`（解音訊、以 pts 對齊的樣本數）。
 * 為什麼用引擎、不用 Rust 的 ffprobe：WebM 沒有 nb_frames，Opus 的 pre-skip 要解碼才扣得掉；兩個 op 都只吃 CPU，不搶 GPU permit。
 */
export async function measureExport(mediaId: string, outPath: string): Promise<ExportMeasurement> {
  const idx = await runEngineJob<IndexOpResult>({ kind: "export", mediaId, op: "media.index", args: { video: outPath }, gpu: false, step: "驗收輸出檔" });
  const au = await runEngineJob<AudioInfoOpResult>({ kind: "export", mediaId, op: "media.audio_info", args: { video: outPath }, gpu: false, step: "驗收輸出檔" });
  const a = au.audio ?? null;
  return { frames: typeof idx.nSource === "number" ? idx.nSource : null, samples: a ? a.nSamples : null, sampleRate: a ? a.sampleRate : null };
}

/** 驗收結果的白話（對話框與 dev 煙霧測試共用；key 是 zh）。 */
export function verificationPhrases(v: ExportVerification): Phrase[] {
  return v.checks.map((c): Phrase => {
    const mark = c.ok ? "✓" : "✗";
    if (c.id === "frames") return { key: "視訊 {actual} / {expected} 幀 {mark}", params: { actual: c.actual ?? "?", expected: c.expected ?? "?", mark } };
    if (c.id === "samples") return { key: "音訊 {actual} / {expected} 樣本 {mark}", params: { actual: c.actual ?? "?", expected: c.expected ?? "?", mark } };
    return { key: "音訊與視訊長度差 {d} 幀 {mark}", params: { d: c.actual ?? "?", mark } };
  });
}

/** 這次輸出要不要做輸出後驗收：序列真的重新渲染（不是 untouched 的 v0.0.6 原路徑）。 */
export function needsVerification(plan: RenderPlanResult | null | undefined): boolean {
  return !!plan?.sequence && !plan.sequence.untouched;
}

/**
 * dev 煙霧測試（AIVC_DEV_EXPORT）：照專案現況輸出（有序列就輸出序列），序列重新渲染時接著驗收，回傳要寫進日誌的幾行。
 * App.tsx 只負責讀環境變數與寫日誌。
 */
export async function devExportSmoke(mediaId: string, o: ExportOpts): Promise<string[]> {
  const plan = await planExport(mediaId, o);
  const seq = plan.sequence;
  const lines = [`[dev export] plan frames=${plan.frames.write} audio=${plan.encode.audio_mode}${seq ? ` sequence=${seq.id} untouched=${seq.untouched} clips=${seq.clips} gaps=${seq.gaps} audioClips=${seq.audioClips}` : ""}`];
  const r = await exportVideo(mediaId, o);
  lines.push(`[dev export] done ${r.out} frames=${r.frames} seconds=${r.seconds} audio=${r.audio.mode}`);
  if (needsVerification(plan)) {
    const v = verifyExport(expectationOf(plan), await measureExport(mediaId, r.out));
    lines.push(`[dev export] verify ok=${v.ok} ${JSON.stringify(v.checks)}`);
  }
  return lines;
}
