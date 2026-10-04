/**
 * 執行一份計畫。
 *
 * 分成兩半：**算參數**（`opArgs` / `frameOf`，純函式、可測）與**真的去做**（`runStep`，碰 store 與引擎）。
 * 會這樣切是因為錯得最兇的一定是參數：模型講「12 秒」，引擎要的是 proxy 幀；
 * 模型不知道影片在哪、遮罩要寫到哪、SAM 用哪個變體 —— 那些**不該由模型決定**，
 * 是這一層照目前的專案補上去的。工具表因此刻意不含 `video` 這種參數：少一個模型可以講錯的東西。
 */
import { api } from "../api";
import type { Rational } from "../api";
import { runCommand } from "../commands/registry";
import { runEngineJob } from "../pipeline/engineJob";
import { useTimeline } from "../store/timeline";
import { usePlayback } from "../store/playback";
import { defaultBlurOut } from "../pipeline/blurBackground";
import { reframeSidecars, type ReframeAspect } from "../pipeline/reframe";
import { defaultRemoveOut } from "../pipeline/removeObject";
import { sourceFrameToSequence } from "../pipeline/chapters";
import type { CaptionTrackV1, ShotV1 } from "../project/format";
import { addMarker } from "../sequence/ops";
import { openDialog } from "../store/dialogs";
import { SEQ_EDIT_LABEL, useEdits } from "../store/edits";
import type { PlanStep } from "./protocol";
import { describeHits, describeShots, searchTranscript, shotSpans, type ShotSpan, type TranscriptHit } from "./transcript";

/** 執行時才知道的東西，由呼叫端（面板）從目前的專案取出來。 */
export interface RunContext {
  mediaId: string;
  /** 影片檔路徑（引擎所有 op 的第一個參數）。 */
  video: string;
  fps: Rational;
  /** proxy 總幀數（秒 → 幀要夾在這裡面）。 */
  frames: number;
  /** 遮罩之類的中間產物寫哪。 */
  cacheDir: string;
  /** SAM 變體（設定裡的）。 */
  sam: string;
  /** 設定裡的輸出資料夾；null = 與來源同資料夾。 */
  outDir: string | null;
  /** 查詢工具的材料：目前的字幕與鏡頭（沒給就當沒有）。 */
  captions?: CaptionTrackV1 | null;
  shots?: readonly ShotV1[];
}

export interface StepResult {
  ok: boolean;
  /** 已經是人話，面板直接顯示。 */
  message: string;
  /** 給下一步用的東西（例如 find_subject 回的框）。 */
  data?: Record<string, unknown>;
}

/**
 * 秒 → proxy 幀，夾在 `[0, frames)`。
 *
 * 四捨五入不是無條件捨去：使用者講「12 秒」時心裡想的是那一刻，
 * 24 fps 下捨去與進位差 1 幀無所謂，但**超出影片長度**會讓引擎報一句看不懂的錯，
 * 所以一定要夾。
 */
export function frameOf(seconds: number, fps: Rational, frames: number): number {
  const f = Math.round((seconds * fps.num) / fps.den);
  return Math.max(0, Math.min(Math.max(0, frames - 1), f));
}

/** `"12,20"` 之類的範圍字串 → `[a, b)`；看不懂回 null。 */
export function parseFrameSpan(s: string): [number, number] | null {
  const m = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(s);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return b > a ? [a, b] : null;
}

/** 重構圖成品放哪：`<stem>.aivc.reframe.<ext>`，跟其他輸出分開才不會互相覆蓋。 */
export function defaultReframeOut(src: string, outDir: string | null, ext = "mp4"): string {
  return withSuffix(src, outDir, "reframe", ext);
}

/** 描框成品放哪：`<stem>.aivc.mark.<ext>`。 */
export function defaultMarkOut(src: string, outDir: string | null, ext = "mp4"): string {
  return withSuffix(src, outDir, "mark", ext);
}

/** `<outDir 或來源目錄>/<stem>.aivc.<tag>.<ext>`。各功能的成品分開才不會互相覆蓋。 */
function withSuffix(src: string, outDir: string | null, tag: string, ext: string): string {
  const sep = src.includes("\\") ? "\\" : "/";
  const base = src.split(/[\\/]/).pop() ?? "out";
  const stem = base.replace(/\.[^.]+$/, "");
  const dir = outDir ?? src.slice(0, Math.max(0, src.lastIndexOf(sep)));
  return `${dir}${sep}${stem}.aivc.${tag}.${ext}`;
}

/** 這一步的遮罩要寫哪：每次呼叫一個獨立資料夾，同一輪對話裡跑兩次才不會互相覆蓋。 */
export function maskDirOf(cacheDir: string, stamp: number): string {
  const sep = cacheDir.includes("\\") ? "\\" : "/";
  return `${cacheDir}${sep}assistant-${stamp}`;
}

/**
 * 工具的參數 → 引擎 op 的參數。
 *
 * 這裡補的全是**模型不該知道也不該猜**的東西：影片在哪、SAM 用哪個、遮罩寫哪、要不要出預覽圖。
 */
export function opArgs(toolName: string, args: Record<string, string | number | boolean>, ctx: RunContext, stamp = Date.now()): Record<string, unknown> {
  const base = { video: ctx.video };
  switch (toolName) {
    case "find_subject":
      return { ...base, frame: args.frame, text: args.text };
    case "track_subject":
      // 遮罩落點不由模型決定（同 video / sam）：每次一個獨立資料夾，跑兩次才不會互相覆蓋
      return { ...base, box: [String(args.box)], frames: args.frames, anchor: args.anchor, dir: "both", out: maskDirOf(ctx.cacheDir, stamp), sam: ctx.sam, previews: 0 };
    case "blur_background":
      return {
        ...base,
        masks: [String(args.masks)],
        // 模型不知道使用者的輸出資料夾在哪，編一個路徑只會寫到奇怪的地方（同 video / sam / 遮罩落點）
        out: String(args.out || defaultBlurOut(ctx.video, ctx.outDir)),
        ...(args.frames ? { frames: args.frames } : {}),
        ...(args.color ? { color: args.color } : args.strength != null ? { strength: args.strength } : {}),
      };
    case "mark_subject":
      return {
        ...base,
        masks: [String(args.masks)],
        out: String(args.out || defaultMarkOut(ctx.video, ctx.outDir)),
        ...(args.mode ? { mode: args.mode } : {}),
        ...(args.color ? { color: args.color } : {}),
        ...(args.opacity != null ? { opacity: args.opacity } : {}),
        ...(args.frames ? { frames: args.frames } : {}),
      };
    case "remove_object":
      return { ...base, masks: [String(args.masks)], out: String(args.out || defaultRemoveOut(ctx.video, ctx.outDir)), ...(args.frames ? { frames: args.frames } : {}) };
    case "auto_reframe": {
      // 路徑檔的落點跟對話框那條路算出同一個（reframeSidecars），模型不必也不該編
      const aspect = String(args.aspect) as ReframeAspect;
      const out = String(args.out || reframeSidecars(defaultReframeOut(ctx.video, ctx.outDir), aspect).path);
      return { ...base, aspect, out, ...(args.text ? { text: args.text } : {}) };
    }
    case "apply_reframe":
      return { ...base, path: args.path, out: String(args.out || defaultReframeOut(ctx.video, ctx.outDir)) };
    default:
      return { ...base, ...args };
  }
}

/** 跑很久的工具（追蹤、輸出）：走引擎 job（有進度與取消）；MCP 那邊也給它們長一點的逾時。 */
export const LONG_TOOLS: ReadonlySet<string> = new Set(["track_subject", "blur_background", "remove_object", "mark_subject", "auto_reframe", "apply_reframe"]);

/** view_frame 看哪一幀：frame 優先、其次 seconds、都沒給就是播放線；夾在影片範圍內。 */
export function viewFrameOf(args: Record<string, string | number | boolean>, ctx: RunContext, playhead: number): number {
  const last = Math.max(0, ctx.frames - 1);
  if (args.frame != null) return Math.max(0, Math.min(last, Math.round(Number(args.frame))));
  if (args.seconds != null) return frameOf(Number(args.seconds), ctx.fps, ctx.frames);
  return Math.max(0, Math.min(last, Math.round(playhead)));
}

/** view_frame 的圖放哪：這支媒體的快取資料夾（同一幀同一種重看就覆蓋，不會越堆越多）。 */
export function frameImageOf(cacheDir: string, k: number, grid: boolean): string {
  const sep = cacheDir.includes("\\") ? "\\" : "/";
  return `${cacheDir}${sep}assistant-frames${sep}frame-${k}${grid ? "-grid" : ""}.png`;
}

/** 只查不動的工具：材料是目前的字幕、鏡頭與畫面，回給模型的是秒數／圖。 */
async function runQuery(name: string, args: Record<string, string | number | boolean>, ctx: RunContext, t: (zh: string, vars?: Record<string, string | number>) => string): Promise<StepResult> {
  if (name === "view_frame") {
    // 看圖：存一張 PNG 在這支媒體的快取裡（MCP 只肯讀 App 快取／資料目錄底下的圖），路徑放進 data.images
    const k = viewFrameOf(args, ctx, usePlayback.getState().frame);
    const grid = args.grid !== false;
    const out = frameImageOf(ctx.cacheDir, k, grid);
    const data = await api.engineCall<Record<string, unknown>>("media.frame", { video: ctx.video, at: k, out, max_side: 1024, grid }, 60_000);
    const path = typeof data.out === "string" ? data.out : out;
    return { ok: true, message: humanOf(data) || t("第 {f} 幀", { f: k }), data: { ...data, images: [path] } };
  }
  if (name === "find_in_transcript") {
    const q = String(args.text ?? "");
    const total = searchTranscript(ctx.captions ?? null, q, ctx.fps, Number.MAX_SAFE_INTEGER).length;
    const hits = searchTranscript(ctx.captions ?? null, q, ctx.fps, 6);
    return { ok: true, message: total ? t("找到 {n} 處", { n: total }) : t("沒有找到"), data: { hits, total } };
  }
  const spans = shotSpans(ctx.shots ?? [], ctx.fps);
  return { ok: true, message: t("{n} 個鏡頭", { n: spans.length }), data: { spans } };
}

/** 一步的執行。呼叫端負責照順序 await —— 步驟常常互相依賴（先設範圍再剪）。 */
export async function runStep(step: PlanStep, ctx: RunContext, t: (zh: string, vars?: Record<string, string | number>) => string): Promise<StepResult> {
  if (step.problem) return { ok: false, message: step.problem };
  const { tool, args } = step;

  if (tool.kind === "state") {
    if (tool.name === "seek_to") {
      const f = args.frame != null ? Number(args.frame) : frameOf(Number(args.seconds ?? 0), ctx.fps, ctx.frames);
      usePlayback.getState().seek(f);
      return { ok: true, message: t("播放線移到第 {f} 幀", { f }) };
    }
    if (tool.name === "set_range") {
      const a = frameOf(Number(args.start_seconds), ctx.fps, ctx.frames);
      const b = frameOf(Number(args.end_seconds), ctx.fps, ctx.frames);
      if (b <= a) return { ok: false, message: t("終點要比起點晚") };
      useTimeline.getState().setRange({ in: a, out: b });
      return { ok: true, message: t("範圍設為 {a}–{b} 幀", { a, b }) };
    }
    if (tool.name === "narrate") {
      // 只開對話框、把字填好：合成要花錢／時間，聲音也該由人挑，所以真的合成永遠是人按的
      openDialog("tts", args.text != null && String(args.text).trim() ? { text: String(args.text) } : {});
      return { ok: true, message: t("已開啟 AI 配音對話框") };
    }
    if (tool.name === "add_marker") {
      // 標記在序列時間上；模型講的是來源秒數，落在剪掉的地方就沒有地方可放
      const f = frameOf(Number(args.seconds), ctx.fps, ctx.frames);
      const name = args.name != null ? String(args.name) : "";
      const ok = useEdits.getState().editSequence(SEQ_EDIT_LABEL.addMarker, (seq) => {
        const at = sourceFrameToSequence(seq, ctx.mediaId, f);
        return at == null ? null : addMarker(seq, at, name);
      });
      return ok ? { ok: true, message: t("在第 {f} 幀加了標記", { f }) } : { ok: false, message: t("這個時間落在序列上已經剪掉的地方，或那裡已經有標記") };
    }
    useTimeline.getState().setRange(null);
    return { ok: true, message: t("已清除範圍") };
  }

  if (tool.kind === "query") return runQuery(tool.name, args, ctx, t);

  if (tool.kind === "command") {
    const r = await runCommand(tool.target!, "assistant");
    // runCommand 擋下來時回的是指令自己那一句原因
    return r.ran ? { ok: true, message: t("已執行「{name}」", { name: t(tool.title) }) } : { ok: false, message: r.why ? t(r.why) : t("「{name}」現在不能執行", { name: t(tool.title) }) };
  }

  // 引擎 op：長的（追蹤、輸出）走 job 才有進度與取消，短的直接呼叫
  const a = opArgs(tool.name, args, ctx);
  const long = LONG_TOOLS.has(tool.name);
  const data = long
    ? await runEngineJob<Record<string, unknown>>({ kind: tool.name === "track_subject" ? "mask" : "export", mediaId: ctx.mediaId, op: tool.target!, args: a, step: t(tool.title) })
    : await api.engineCall<Record<string, unknown>>(tool.target!, a, 10 * 60_000);
  return { ok: true, message: humanOf(data) || t("已完成「{name}」", { name: t(tool.title) }), data };
}

/** 引擎結果裡的 `_human`（每個 op 都自己寫了一句人話）。沒有就回空字串。 */
export function humanOf(data: unknown): string {
  const h = data && typeof data === "object" ? (data as Record<string, unknown>)._human : null;
  return typeof h === "string" ? h.split("\n")[0] : "";
}

/**
 * 執行結果 → 回報給模型的一段文字。
 *
 * **這是「人機協作」真正閉環的那一塊。** 沒有它，多步流程會卡在第一步：
 * `find_subject` 找到的框只存在於結果裡，模型看不到，所以它沒辦法規劃接下來的
 * `track_subject`（那一步要框的座標），使用者得自己把座標讀出來再講一次。
 *
 * 只挑**下一步真的會用到**的欄位（框、遮罩路徑、輸出檔），不要把整包 JSON 倒回去：
 * 那會吃掉 context，而且小模型看到一堆無關欄位反而更容易亂編。
 */
export function resultNote(steps: readonly { tool: { name: string; title: string } }[], results: readonly StepResult[]): string {
  const lines: string[] = [];
  results.forEach((r, i) => {
    const s = steps[i];
    if (!s) return;
    const head = `${i + 1}. ${s.tool.title}：${r.ok ? "成功" : "失敗"} —— ${r.message}`;
    const facts = usefulFacts(s.tool.name, r.data);
    lines.push(facts ? `${head}\n   ${facts}` : head);
  });
  return lines.join("\n");
}

/** 這一步的結果裡，下一步用得到的是什麼（面板回報與 MCP 工具結果共用）。 */
export function usefulFacts(toolName: string, data: Record<string, unknown> | undefined): string {
  if (!data) return "";
  if (toolName === "view_frame") {
    const size = Array.isArray(data.sourceSize) ? (data.sourceSize as number[]).join("×") : "";
    return `第 ${data.frame ?? "?"} 幀${size ? `（原尺寸 ${size}）` : ""}${data.grid ? "，疊了 0–1000 座標格線" : ""}；圖：${Array.isArray(data.images) ? data.images.join("；") : ""}`;
  }
  if (toolName === "find_subject") {
    const boxes = Array.isArray(data.boxes) ? data.boxes : [];
    if (!boxes.length) return "沒有找到任何東西（換個說法，英文通常比較準）";
    return boxes
      .slice(0, 4)
      .map((b) => {
        const o = b as { box?: number[]; phrase?: string; score?: number };
        const xy = (o.box ?? []).map((v) => Math.round(v)).join(",");
        return `框 "${xy}"（${o.phrase ?? ""}，信心 ${o.score ?? "?"}）`;
      })
      .join("；");
  }
  if (toolName === "track_subject") {
    const objs = Array.isArray(data.objects) ? data.objects : [];
    const paths = objs.map((o) => (o as { path?: string }).path).filter(Boolean);
    return paths.length ? `遮罩檔：${paths.join("；")}` : "";
  }
  if (toolName === "find_in_transcript") return describeHits((Array.isArray(data.hits) ? data.hits : []) as TranscriptHit[], Number(data.total ?? 0));
  if (toolName === "list_shots") return describeShots((Array.isArray(data.spans) ? data.spans : []) as ShotSpan[]);
  if (typeof data.out === "string") return `輸出：${data.out}`;
  return "";
}
