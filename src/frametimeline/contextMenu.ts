import { frameInRange, type FrameRange } from "../store/timeline";
import type { TimelineHit } from "./hit";

/**
 * 時間軸右鍵的「點到了什麼」（純函式）＋ 選單掛點。
 *
 * 選單內容（menuModel.ts 的 timelineMenuItems / rangeMenuItems / shotMenuItems / laneMenuItems / keyframeMenuItems）
 * 由殼層那邊組；FrameTimeline 只負責把命中結果翻成穩定的目標形狀交出去。這樣選單可以改版而不必碰 canvas 的命中程式，
 * 反過來列高 / 版面改了也不會讓選單拿到錯的對象。
 *
 * 掛法二選一：`<FrameTimeline onContextMenuAt={…} />`，或在任何元件 mount 時 `setTimelineContextMenuHandler(fn)`
 * （回傳的函式在 unmount 時呼叫）。兩者都有時以 prop 為準。
 */
export type TimelineContextTarget =
  /** 尺規 / 範圍列空白 / 沒有鏡頭的鏡頭帶 / 縮圖列 / 車道之間的空白。 */
  | { kind: "timeline"; frame: number; zone: "ruler" | "range" | "shots" | "thumbs" | "empty" }
  /** 範圍列的本體或握把。 */
  | { kind: "range"; frame: number; part: "in" | "out" | "body"; range: FrameRange }
  | { kind: "shot"; frame: number; shotId: string }
  | { kind: "lane"; frame: number; trackId: string; row: "solved" | "user" }
  | { kind: "keyframe"; frame: number; trackId: string }
  | { kind: "reference"; frame: number; trackId: string };

export interface TimelineContextRequest {
  clientX: number;
  clientY: number;
  target: TimelineContextTarget;
  /** 目前的完整範圍（沒有 = null）。 */
  range: FrameRange | null;
  /** 點擊的幀落在範圍內：選單要把「範圍」那一段放最上面（規格 §2.3 B）。 */
  inRange: boolean;
}

export function contextTargetOf(hit: TimelineHit, range: FrameRange | null): TimelineContextTarget {
  switch (hit.kind) {
    case "ruler":
      return { kind: "timeline", frame: hit.frame, zone: "ruler" };
    case "range":
      if (range && hit.part !== "empty") return { kind: "range", frame: hit.frame, part: hit.part, range };
      return { kind: "timeline", frame: hit.frame, zone: "range" };
    case "shots":
      return hit.shotId ? { kind: "shot", frame: hit.frame, shotId: hit.shotId } : { kind: "timeline", frame: hit.frame, zone: "shots" };
    case "thumbs":
      return { kind: "timeline", frame: hit.frame, zone: "thumbs" };
    case "solved":
    case "user":
      return { kind: "lane", frame: hit.frame, trackId: hit.trackId, row: hit.kind };
    case "keyframe":
      return { kind: "keyframe", frame: hit.frame, trackId: hit.trackId };
    case "reference":
      return { kind: "reference", frame: hit.frame, trackId: hit.trackId };
    case "empty":
      return { kind: "timeline", frame: hit.frame, zone: "empty" };
  }
}

export function contextRequestOf(hit: TimelineHit, range: FrameRange | null, clientX: number, clientY: number): TimelineContextRequest {
  const target = contextTargetOf(hit, range);
  return { clientX, clientY, target, range, inRange: frameInRange(range, target.frame) };
}

export type TimelineContextMenuHandler = (req: TimelineContextRequest) => void;

let handler: TimelineContextMenuHandler | null = null;

/** 註冊右鍵處理器；回傳的函式只會清掉「自己」註冊的那一個（StrictMode 重掛時不會把新的清掉）。 */
export function setTimelineContextMenuHandler(h: TimelineContextMenuHandler | null): () => void {
  handler = h;
  return () => {
    if (handler === h) handler = null;
  };
}

export function timelineContextMenuHandler(): TimelineContextMenuHandler | null {
  return handler;
}
