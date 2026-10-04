import { t } from "../i18n";
import { isRecord, type Rational, type SequenceV2 } from "../project/format";
import { pickProvider, providerArgs } from "../assistant/provider";
import { placeVideo } from "../sequence/map";
import { useSettings } from "../store/settings";
import { CAPTIONS_JOB_KIND } from "./captions";
import { runEngineJob } from "./engineJob";
import { projectFileFor } from "./project";

/**
 * AI 章節與摘要（對標 Descript 的 Chapters、YouTube Studio 的自動章節、CapCut 的 AI 摘要）。
 *
 * 引擎 `assistant.chapters` 把字幕送給模型、把回來的東西整理成「來源幀 + 標題」（起點吸到字幕段、第一章 0 秒、
 * 彼此至少隔幾秒 —— 時間的部分全在引擎，模型只講語意）。這裡做三件事：把結果驗成型別、算 YouTube 章節文字
 * （用**目前**的標題與幀，使用者在對話框改過標題也要跟著）、把來源幀對到序列幀好加標記。
 */

export interface Chapter {
  /** 來源（proxy）幀。 */
  frame: number;
  seconds: number;
  /** 空字串 = 引擎補的開場章，請使用者自己填。 */
  title: string;
}

export interface ChaptersResult {
  chapters: Chapter[];
  title: string;
  summary: string;
  keywords: string[];
  model: string;
  /** 引擎整理時修掉了什麼（模型的第一章不在 0、太近的章併掉…）。 */
  warnings: string[];
}

export interface ChaptersOptions {
  maxChapters: number;
  minGapSeconds: number;
  /** null = 跟字幕一樣。 */
  language: string | null;
}

export const DEFAULT_CHAPTERS: ChaptersOptions = { maxChapters: 12, minGapSeconds: 20, language: null };

/** 引擎回覆 → 型別。壞掉的單筆丟掉；整個形狀不對就是空清單（呼叫端當「模型沒給章節」）。 */
export function parseChaptersResult(raw: unknown): ChaptersResult {
  const o = isRecord(raw) ? raw : {};
  const chapters: Chapter[] = [];
  for (const x of Array.isArray(o.chapters) ? o.chapters : []) {
    if (!isRecord(x)) continue;
    const frame = typeof x.frame === "number" && Number.isFinite(x.frame) ? Math.max(0, Math.round(x.frame)) : null;
    if (frame == null) continue;
    const seconds = typeof x.seconds === "number" && Number.isFinite(x.seconds) ? x.seconds : 0;
    chapters.push({ frame, seconds, title: typeof x.title === "string" ? x.title.trim() : "" });
  }
  chapters.sort((a, b) => a.frame - b.frame);
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim()) : []);
  return {
    chapters,
    title: typeof o.title === "string" ? o.title.trim() : "",
    summary: typeof o.summary === "string" ? o.summary.trim() : "",
    keywords: strs(o.keywords),
    model: typeof o.model === "string" ? o.model : "",
    warnings: strs(o.warnings),
  };
}

/** YouTube 章節的時間碼：`m:ss`，一小時以上 `h:mm:ss`（跟引擎 `mmss` 同一條規則）。 */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

export function secondsOfFrame(frame: number, fps: Rational): number {
  return (frame * fps.den) / Math.max(1, fps.num);
}

/**
 * YouTube 描述欄的章節格式：每行「時間 標題」。YouTube 要求第一行是 0:00 而且至少三章，
 * 這裡照實輸出（第一章引擎已經釘在 0），不夠三章由對話框提醒。沒標題的章用「—」佔位。
 */
export function formatYoutubeChapters(chapters: readonly Chapter[], fps: Rational): string {
  return chapters.map((c) => `${mmss(secondsOfFrame(c.frame, fps))} ${c.title || "—"}`).join("\n");
}

/** 摘要區塊要複製的文字：標題、摘要、關鍵字（hashtag）。空的段落略過。 */
export function formatSummaryText(r: Pick<ChaptersResult, "title" | "summary" | "keywords">): string {
  const parts: string[] = [];
  if (r.title) parts.push(r.title);
  if (r.summary) parts.push(r.summary);
  if (r.keywords.length) parts.push(r.keywords.map((k) => `#${k.replace(/\s+/g, "")}`).join(" "));
  return parts.join("\n\n");
}

/**
 * 來源幀 → 序列幀。落在序列上已經剪掉的地方回 null（那一章沒有地方可以放標記）。
 * 同一支媒體在序列上出現兩次時取第一次 —— 章節是「內容」的標記，貼一次就夠。
 */
export function sourceFrameToSequence(seq: Pick<SequenceV2, "video">, mediaId: string, frame: number): number | null {
  for (const p of placeVideo(seq)) {
    const it = p.item;
    if (it.kind !== "clip" || it.mediaId !== mediaId) continue;
    if (frame >= it.srcIn && frame < it.srcOut) return p.t0 + (frame - it.srcIn);
  }
  return null;
}

/** 跑引擎。端點與模型照設定（本機或 Claude），專案檔先寫出來讓引擎讀得到目前的字幕。 */
export async function runChapters(mediaId: string, opts: ChaptersOptions = DEFAULT_CHAPTERS): Promise<ChaptersResult> {
  const llm = pickProvider(useSettings.getState().s);
  if (!llm) throw new Error(t("還沒設定 AI 端點"));
  const project = await projectFileFor(mediaId);
  const raw = await runEngineJob<unknown>({
    kind: CAPTIONS_JOB_KIND,
    mediaId,
    op: "assistant.chapters",
    args: {
      project,
      media: mediaId,
      ...providerArgs(llm),
      max_chapters: Math.max(1, Math.round(opts.maxChapters)),
      min_gap: Math.max(1, opts.minGapSeconds),
      ...(opts.language ? { language: opts.language } : {}),
    },
    gpu: false,
    step: t("AI 章節與摘要"),
  });
  return parseChaptersResult(raw);
}
