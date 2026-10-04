import { describe, expect, it } from "vitest";
import { contextRequestOf, contextTargetOf, setTimelineContextMenuHandler, timelineContextMenuHandler } from "./contextMenu";

const range = { in: 100, out: 200 };

describe("frametimeline/contextMenu", () => {
  it("每種命中翻成穩定的目標形狀", () => {
    expect(contextTargetOf({ kind: "ruler", frame: 5 }, null)).toEqual({ kind: "timeline", frame: 5, zone: "ruler" });
    expect(contextTargetOf({ kind: "range", part: "body", frame: 150 }, range)).toEqual({ kind: "range", frame: 150, part: "body", range });
    expect(contextTargetOf({ kind: "range", part: "out", frame: 199 }, range)).toMatchObject({ kind: "range", part: "out" });
    expect(contextTargetOf({ kind: "range", part: "empty", frame: 50 }, range)).toEqual({ kind: "timeline", frame: 50, zone: "range" });
    // 沒有範圍時就算 hit 說 body 也不能給出 range 目標（選單會拿 range.in 去用）
    expect(contextTargetOf({ kind: "range", part: "body", frame: 50 }, null)).toEqual({ kind: "timeline", frame: 50, zone: "range" });
    expect(contextTargetOf({ kind: "shots", shotId: "s2", frame: 160 }, null)).toEqual({ kind: "shot", frame: 160, shotId: "s2" });
    expect(contextTargetOf({ kind: "shots", shotId: null, frame: 160 }, null)).toEqual({ kind: "timeline", frame: 160, zone: "shots" });
    expect(contextTargetOf({ kind: "thumbs", frame: 1 }, null)).toMatchObject({ zone: "thumbs" });
    expect(contextTargetOf({ kind: "solved", trackId: "a", frame: 9 }, null)).toEqual({ kind: "lane", frame: 9, trackId: "a", row: "solved" });
    expect(contextTargetOf({ kind: "user", trackId: "a", frame: 9 }, null)).toEqual({ kind: "lane", frame: 9, trackId: "a", row: "user" });
    expect(contextTargetOf({ kind: "keyframe", trackId: "a", frame: 12 }, null)).toEqual({ kind: "keyframe", frame: 12, trackId: "a" });
    expect(contextTargetOf({ kind: "reference", trackId: "a", frame: 30 }, null)).toEqual({ kind: "reference", frame: 30, trackId: "a" });
    expect(contextTargetOf({ kind: "empty", frame: 3 }, null)).toMatchObject({ zone: "empty" });
  });

  it("inRange：點擊幀在 [in, out) 內（out 本身不算）", () => {
    expect(contextRequestOf({ kind: "ruler", frame: 100 }, range, 1, 2)).toMatchObject({ clientX: 1, clientY: 2, inRange: true, range });
    expect(contextRequestOf({ kind: "ruler", frame: 200 }, range, 1, 2).inRange).toBe(false);
    expect(contextRequestOf({ kind: "ruler", frame: 150 }, null, 1, 2).inRange).toBe(false);
  });

  it("處理器註冊：解除只清自己那一個", () => {
    const a = () => {};
    const b = () => {};
    const offA = setTimelineContextMenuHandler(a);
    const offB = setTimelineContextMenuHandler(b);
    offA();
    expect(timelineContextMenuHandler()).toBe(b);
    offB();
    expect(timelineContextMenuHandler()).toBeNull();
  });
});
