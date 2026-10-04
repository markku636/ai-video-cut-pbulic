/**
 * `objects.adopt`（引擎）：把 find 的 obj<N> 或 select 傳播出來的 masks.aivm **原子地**複製進
 * `<媒體快取>/tracks/<trackId>/masks.aivm`、算錨點，回 {masks, visibleRanges, bestFrame, box, area, thumb}。
 * 物件 track 只認那個位置的遮罩（跟平面 track 同一個地方），find / select 的暫存資料夾之後清掉也沒關係。
 *
 * 純函式在上面（解析回傳值、算範圍），呼叫引擎的在下面。
 */
import { api } from "../api";

export interface AdoptResult {
  /** 搬好之後的遮罩檔（tracks/<id>/masks.aivm）。 */
  masks: string;
  /** 連續可見的區段，**含頭含尾**（anchors.v1.json 的 visibleRanges）。 */
  visibleRanges: [number, number][];
  bestFrame: number | null;
  box: [number, number, number, number] | null;
  area: number;
  thumb: string | null;
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

export function parseVisibleRanges(v: unknown): [number, number][] {
  if (!Array.isArray(v)) return [];
  const out: [number, number][] = [];
  for (const r of v) if (Array.isArray(r) && r.length === 2 && isInt(r[0]) && isInt(r[1]) && r[1] >= r[0] && r[0] >= 0) out.push([r[0], r[1]]);
  return out.sort((a, b) => a[0] - b[0]);
}

export function parseAdoptResult(raw: unknown): AdoptResult {
  const o = rec(raw) ?? {};
  const box = Array.isArray(o.box) && o.box.length === 4 && o.box.every((x) => typeof x === "number" && Number.isFinite(x)) ? (o.box as [number, number, number, number]) : null;
  return {
    masks: typeof o.masks === "string" ? o.masks : "",
    visibleRanges: parseVisibleRanges(o.visibleRanges),
    bestFrame: isInt(o.bestFrame) ? o.bestFrame : null,
    box,
    area: typeof o.area === "number" && Number.isFinite(o.area) ? o.area : 0,
    thumb: typeof o.thumb === "string" && o.thumb ? o.thumb : null,
  };
}

/** 可見區段（含頭含尾）→ 物件 track 的 range [k0, k1)（半開）；完全看不到 → fallback。 */
export function rangeFromVisible(visible: readonly [number, number][], fallback: [number, number]): [number, number] {
  if (!visible.length) return fallback;
  return [visible[0][0], visible[visible.length - 1][1] + 1];
}

/** 可見幀數（含頭含尾的區段加總）。 */
export function visibleFrameCount(visible: readonly [number, number][]): number {
  return visible.reduce((n, [a, b]) => n + (b - a + 1), 0);
}

/** 引擎的 args（鍵 = op 的參數名；docs 第 4 點：video / src / track_id）。 */
export function adoptArgs(video: string, src: string, trackId: string): Record<string, unknown> {
  return { video, src, track_id: trackId };
}

/** 複製 + 算錨點：幾秒的事（讀一次遮罩檔），走短呼叫；長片的錨點第一次要解完整個遮罩檔，給寬一點的時間。 */
export async function adoptMasks(video: string, src: string, trackId: string): Promise<AdoptResult> {
  return parseAdoptResult(await api.engineCall("objects.adopt", adoptArgs(video, src, trackId), 5 * 60_000));
}
