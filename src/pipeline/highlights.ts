import { t } from "../i18n";
import { isRecord, type SequenceV2 } from "../project/format";
import { pickProvider, providerArgs } from "../assistant/provider";
import type { SeqCtx } from "../sequence/context";
import { durationFrames } from "../sequence/map";
import { extractRange, type SeqFrameRange } from "../sequence/ops";
import { mergeRanges, projectToSequence } from "../sequence/silence";
import { useSettings } from "../store/settings";
import { CAPTIONS_JOB_KIND } from "./captions";
import { runEngineJob } from "./engineJob";
import { projectFileFor } from "./project";

/**
 * AI 精華片段（對標 Opus Clip、CapCut 的 AI 精華、Descript 的 Highlights）。
 *
 * 引擎 `assistant.highlights` 把字幕送給模型挑「最值得單獨拿出來的幾段」，起訖吸到字幕段邊界、長度夾在上下限、
 * 重疊只留分數高的。這裡把結果驗成型別，並提供「只留這幾段」的序列運算：其餘全部波紋刪除，
 * 跟移除靜音／語助詞同一條路（找範圍 → 反向 extractRange → 一筆 undo）。
 */

export interface HighlightClip {
  /** 來源（proxy）幀，半開。 */
  startFrame: number;
  endFrame: number;
  start: number;
  end: number;
  title: string;
  reason: string;
  /** 1–10。 */
  score: number;
  /** 每秒幾個字（字幕算的）；模型看不到的客觀訊號。 */
  cps: number;
}

export interface HighlightsResult {
  clips: HighlightClip[];
  model: string;
  warnings: string[];
}

export interface HighlightsOptions {
  count: number;
  minSeconds: number;
  maxSeconds: number;
  /** null = 跟字幕一樣。 */
  language: string | null;
}

export const DEFAULT_HIGHLIGHTS: HighlightsOptions = { count: 5, minSeconds: 15, maxSeconds: 60, language: null };

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** 引擎回覆 → 型別。壞掉的單筆丟掉（起訖不是數字、終點不在起點後）。 */
export function parseHighlightsResult(raw: unknown): HighlightsResult {
  const o = isRecord(raw) ? raw : {};
  const clips: HighlightClip[] = [];
  for (const x of Array.isArray(o.clips) ? o.clips : []) {
    if (!isRecord(x)) continue;
    const startFrame = Math.max(0, Math.round(num(x.startFrame, -1)));
    const endFrame = Math.round(num(x.endFrame, -1));
    if (num(x.startFrame, -1) < 0 || endFrame <= startFrame) continue;
    clips.push({
      startFrame,
      endFrame,
      start: num(x.start),
      end: num(x.end),
      title: typeof x.title === "string" ? x.title.trim() : "",
      reason: typeof x.reason === "string" ? x.reason.trim() : "",
      score: Math.max(1, Math.min(10, num(x.score, 5))),
      cps: num(x.cps),
    });
  }
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && !!s.trim()) : []);
  return { clips, model: typeof o.model === "string" ? o.model : "", warnings: strs(o.warnings) };
}

/** `[0, total)` 裡沒被 `kept` 蓋到的部分（依時間、已合併）。 */
export function complementRanges(kept: readonly SeqFrameRange[], total: number): SeqFrameRange[] {
  const out: SeqFrameRange[] = [];
  let cursor = 0;
  for (const r of mergeRanges(kept.filter((r) => r.out > r.in))) {
    const a = Math.max(0, r.in);
    const b = Math.min(total, r.out);
    if (a > cursor) out.push({ in: cursor, out: a });
    cursor = Math.max(cursor, b);
  }
  if (cursor < total) out.push({ in: cursor, out: total });
  return out;
}

/**
 * 序列只留下這幾段（來源幀範圍，屬於 `mediaId`）：其餘全部波紋刪除，順序照時間。
 * 一段都對不到序列時原樣回傳（呼叫端要講「這些段都不在序列上」）。
 */
export function keepOnlyRanges(seq: SequenceV2, mediaId: string, keep: readonly SeqFrameRange[], ctx?: SeqCtx): SequenceV2 {
  const kept = projectToSequence(seq, mediaId, keep);
  if (!kept.length) return seq;
  const gaps = complementRanges(kept, durationFrames(seq));
  // 倒序：先刪後面的，前面那些的序列座標才不會偏（同 RemoveSilenceDialog）
  return [...gaps].reverse().reduce((acc, r) => extractRange(acc, r, ctx), seq);
}

/** 跑引擎。端點與模型照設定（本機或 Claude）。 */
export async function runHighlights(mediaId: string, opts: HighlightsOptions = DEFAULT_HIGHLIGHTS): Promise<HighlightsResult> {
  const llm = pickProvider(useSettings.getState().s);
  if (!llm) throw new Error(t("還沒設定 AI 端點"));
  const project = await projectFileFor(mediaId);
  const raw = await runEngineJob<unknown>({
    kind: CAPTIONS_JOB_KIND,
    mediaId,
    op: "assistant.highlights",
    args: {
      project,
      media: mediaId,
      ...providerArgs(llm),
      count: Math.max(1, Math.round(opts.count)),
      min_len: Math.max(1, opts.minSeconds),
      max_len: Math.max(opts.minSeconds, opts.maxSeconds),
      ...(opts.language ? { language: opts.language } : {}),
    },
    gpu: false,
    step: t("AI 精華片段"),
  });
  return parseHighlightsResult(raw);
}
