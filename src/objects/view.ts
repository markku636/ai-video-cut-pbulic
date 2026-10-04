/**
 * 物件分頁的顯示用純函式（測試直接載）：一條物件 track → 清單那一列要講的話。
 * 字串都是 zh key（畫面上 t() 過）；這個檔在 check-i18n 的 TABLE_SOURCES 裡。
 */
import type { TrackV1 } from "../project/format";
import { visibleFrameCount } from "./adopt";
import type { ObjectMeta } from "./meta";

/** 來源的說法。 */
export const OBJECT_SOURCE_LABEL = {
  text: "文字：{text}",
  textNoText: "用文字找",
  select: "手動選取",
  ai: "AI 選的",
} as const;

export interface ObjectRow {
  id: string;
  label: string;
  color: string;
  /** [k0, k1)。 */
  range: [number, number] | null;
  /** 可見幀數（有錨點才知道）；null = 不知道。 */
  visibleFrames: number | null;
  /** 可見區段（含頭含尾）；空 = 不知道或完全看不到。 */
  visibleRanges: [number, number][];
  effects: number;
  enabledEffects: number;
  source: { key: string; params?: Record<string, string> };
  bestFrame: number | null;
}

export function sourceText(t: TrackV1): { key: string; params?: Record<string, string> } {
  const s = t.source;
  if (!s) return { key: OBJECT_SOURCE_LABEL.select };
  if (s.type === "text") {
    const what = s.phrase && s.text && s.phrase !== s.text ? `${s.text}（${s.phrase}）` : s.text || s.phrase || "";
    return what ? { key: OBJECT_SOURCE_LABEL.text, params: { text: what } } : { key: OBJECT_SOURCE_LABEL.textNoText };
  }
  return { key: s.type === "ai" ? OBJECT_SOURCE_LABEL.ai : OBJECT_SOURCE_LABEL.select };
}

export function objectRow(t: TrackV1, meta: ObjectMeta | null | undefined): ObjectRow {
  const visible = meta?.visibleRanges ?? [];
  return {
    id: t.id,
    label: t.label,
    color: t.color ?? "#888888",
    range: t.range ?? null,
    visibleFrames: meta ? visibleFrameCount(visible) : null,
    visibleRanges: visible,
    effects: t.effects?.length ?? 0,
    enabledEffects: t.effects?.filter((e) => e.enabled).length ?? 0,
    source: sourceText(t),
    bestFrame: t.referenceFrame ?? meta?.bestFrame ?? null,
  };
}

/** 可見區段的短文字：「12–80、95–140」；超過 3 段只列前 3 段加「…」。 */
export function rangesText(ranges: readonly [number, number][], max = 3): string {
  if (!ranges.length) return "";
  const parts = ranges.slice(0, max).map(([a, b]) => (a === b ? `${a}` : `${a}–${b}`));
  return ranges.length > max ? `${parts.join("、")}…` : parts.join("、");
}

/** 只有物件 track，依清單順序。 */
export function objectTracks(tracks: readonly TrackV1[]): TrackV1[] {
  return tracks.filter((t) => t.kind === "object");
}
