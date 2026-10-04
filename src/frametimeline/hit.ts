import { frameOfX, xOfFrame, type FrameRange } from "../store/timeline";
import { KEYFRAME_HIT_PX, type TimelineLayout } from "./draw";
import { RANGE_HANDLE_HIT_PX } from "./rangeBand";

/**
 * FrameTimeline 的命中測試：點在哪一列、哪條 track、哪個菱形（純函式）。
 * 錯一列在畫面上看起來像「點了沒反應」或「跳到別條 track」，所以列邊界全部在這裡對照 layoutRows 算。
 */
export type TimelineHit =
  | { kind: "ruler"; frame: number }
  /** 範圍列：in / out 握把、本體，或沒有範圍的空白處（拖了會新建）。 */
  | { kind: "range"; part: "in" | "out" | "body" | "empty"; frame: number }
  | { kind: "shots"; shotId: string | null; frame: number }
  | { kind: "thumbs"; frame: number }
  | { kind: "solved"; trackId: string; frame: number }
  | { kind: "keyframe"; trackId: string; frame: number }
  /** 使用者列上的參考影格錨標（菱形優先：兩者重疊時關鍵幀才是使用者要抓的東西）。 */
  | { kind: "reference"; trackId: string; frame: number }
  | { kind: "user"; trackId: string; frame: number }
  | { kind: "empty"; frame: number };

export interface HitView {
  scrollFrame: number;
  pxPerFrame: number;
  frames: number;
}

export interface HitData {
  shots: { id: string; startFrame: number; endFrame: number }[];
  tracks: { id: string; keyframes: number[]; referenceFrame?: number | null }[];
  /** 目前的完整範圍；沒給 = 沒有範圍（範圍列只會回 empty）。 */
  range?: FrameRange | null;
}

export function frameAtX(x: number, view: HitView): number {
  const f = Math.round(frameOfX(x, view.scrollFrame, view.pxPerFrame));
  return Math.max(0, Math.min(Math.max(0, view.frames - 1), f));
}

/**
 * x → 最近的**幀邊界**，夾在 [0, frames]。範圍是半開區間 [in, out)，out 可以等於 frames（到最後一幀為止），
 * 所以不能用 frameAtX（它夾在 frames−1，會讓範圍永遠少最後一幀）。
 */
export function edgeAtX(x: number, view: HitView): number {
  const f = Math.round(frameOfX(x, view.scrollFrame, view.pxPerFrame));
  return Math.max(0, Math.min(Math.max(0, view.frames), f));
}

/**
 * 範圍列的哪一段：握把容忍 RANGE_HANDLE_HIT_PX；兩端都在容忍內（短範圍 / 縮得很小）取較近的一端，
 * 等距時看游標在中點哪一側 —— 不然 1 幀的範圍永遠只抓得到 in、拉不長 out。
 */
export function hitRangePart(x: number, range: FrameRange | null | undefined, view: HitView, tolPx = RANGE_HANDLE_HIT_PX): "in" | "out" | "body" | "empty" {
  if (!range) return "empty";
  const inX = xOfFrame(range.in, view.scrollFrame, view.pxPerFrame);
  const outX = xOfFrame(range.out, view.scrollFrame, view.pxPerFrame);
  const dIn = Math.abs(x - inX);
  const dOut = Math.abs(x - outX);
  if (dIn <= tolPx || dOut <= tolPx) {
    if (dIn < dOut) return "in";
    if (dOut < dIn) return "out";
    return x < (inX + outX) / 2 ? "in" : "out";
  }
  return x > inX && x < outX ? "body" : "empty";
}

/** 使用者列：菱形（最近、容忍內）> 參考影格錨標 > 空白。 */
function hitUserRow(x: number, track: HitData["tracks"][number], view: HitView, frame: number, tolPx: number): TimelineHit {
  let best: number | null = null;
  let bestD = tolPx;
  for (const kf of track.keyframes) {
    const d = Math.abs(xOfFrame(kf, view.scrollFrame, view.pxPerFrame) - x);
    if (d <= bestD) {
      bestD = d;
      best = kf;
    }
  }
  if (best !== null) return { kind: "keyframe", trackId: track.id, frame: best };
  const ref = track.referenceFrame;
  if (ref != null && Math.abs(xOfFrame(ref, view.scrollFrame, view.pxPerFrame) - x) <= RANGE_HANDLE_HIT_PX) return { kind: "reference", trackId: track.id, frame: ref };
  return { kind: "user", trackId: track.id, frame };
}

export function hitTimeline(x: number, y: number, layout: TimelineLayout, view: HitView, data: HitData, tolPx = KEYFRAME_HIT_PX): TimelineHit {
  const frame = frameAtX(x, view);
  if (y >= layout.rulerY && y < layout.rulerY + layout.rulerH) return { kind: "ruler", frame };
  if (layout.rangeH > 0 && y >= layout.rangeY && y < layout.rangeY + layout.rangeH) return { kind: "range", part: hitRangePart(x, data.range, view), frame };
  if (y >= layout.shotsY && y < layout.shotsY + layout.shotsH) {
    const raw = frameOfX(x, view.scrollFrame, view.pxPerFrame);
    const shot = data.shots.find((s) => raw >= s.startFrame && raw < s.endFrame) ?? null;
    return { kind: "shots", shotId: shot?.id ?? null, frame };
  }
  if (layout.thumbsH > 0 && y >= layout.thumbsY && y < layout.thumbsY + layout.thumbsH) return { kind: "thumbs", frame };
  for (const row of layout.rows) {
    if (y < row.y || y >= row.y + row.h) continue;
    const track = data.tracks.find((t) => t.id === row.trackId);
    if (!track) break;
    if (y < row.userY) return { kind: "solved", trackId: track.id, frame };
    return hitUserRow(x, track, view, frame, tolPx);
  }
  return { kind: "empty", frame };
}
