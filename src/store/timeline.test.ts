import { beforeEach, describe, expect, it } from "vitest";
import { clampZoom, frameInRange, frameOfX, intersectRange, MAX_PX_PER_FRAME, nextZoom, rangeEnds, rangeLength, useTimeline, xOfFrame } from "./timeline";

describe("timeline zoom", () => {
  it("clampZoom 夾在 [fit, MAX]", () => {
    expect(clampZoom(0.1, 2)).toBe(2);
    expect(clampZoom(10_000, 2)).toBe(MAX_PX_PER_FRAME);
    expect(clampZoom(8, 2)).toBe(8);
  });
  it("nextZoom 放大從 fit 起算、縮回 fit 回 null", () => {
    expect(nextZoom(null, 2, 1.25)).toBeCloseTo(2.5);
    expect(nextZoom(2.5, 2, 0.8)).toBeNull();
    expect(nextZoom(null, 2, 0.8)).toBeNull();
    expect(nextZoom(40, 2, 2)).toBe(MAX_PX_PER_FRAME);
  });
  it("zoomBy 以錨點幀為中心：錨點的螢幕 x 不動", () => {
    useTimeline.setState({ pxPerFrame: 4, fitPxPerFrame: 1, scrollFrame: 100 });
    const xBefore = xOfFrame(150, 100, 4);
    useTimeline.getState().zoomBy(2, 150);
    const s = useTimeline.getState();
    expect(s.pxPerFrame).toBe(8);
    expect(xOfFrame(150, s.scrollFrame, 8)).toBeCloseTo(xBefore);
  });
  it("x ↔ frame 互逆", () => {
    expect(frameOfX(xOfFrame(123, 50, 3), 50, 3)).toBeCloseTo(123);
  });
});

describe("in / out（I / O）", () => {
  beforeEach(() => useTimeline.setState({ range: null, pendingIn: null, pendingOut: null }));

  it("先 I 再 O 組成範圍；只標了入點時**不會**產生範圍", () => {
    expect(useTimeline.getState().markIn(50)).toBe(false);
    expect(useTimeline.getState().range).toBeNull();
    expect(useTimeline.getState().pendingIn).toBe(50);
    expect(useTimeline.getState().markOut(90)).toBe(true);
    expect(useTimeline.getState().range).toEqual({ in: 50, out: 90 });
    expect(useTimeline.getState().pendingIn).toBeNull();
  });
  it("先 O 再 I 也可以", () => {
    expect(useTimeline.getState().markOut(90)).toBe(false);
    expect(useTimeline.getState().markIn(50)).toBe(true);
    expect(useTimeline.getState().range).toEqual({ in: 50, out: 90 });
  });
  it("已經有範圍時 I / O 只換那一端", () => {
    useTimeline.getState().setRange({ in: 20, out: 80 });
    expect(useTimeline.getState().markIn(30)).toBe(true);
    expect(useTimeline.getState().range).toEqual({ in: 30, out: 80 });
    expect(useTimeline.getState().markOut(70)).toBe(true);
    expect(useTimeline.getState().range).toEqual({ in: 30, out: 70 });
  });
  it("出點在入點之前 → 改成重新標出點，不做反向範圍", () => {
    useTimeline.getState().markIn(90);
    expect(useTimeline.getState().markOut(50)).toBe(false);
    expect(useTimeline.getState().range).toBeNull();
    expect(useTimeline.getState().pendingOut).toBe(50);
  });
  it("setRange 正規化（反向 / 小數）、丟掉 0 幀的範圍、清除也清單邊標記", () => {
    useTimeline.getState().setRange({ in: 50.4, out: 10.2 });
    expect(useTimeline.getState().range).toEqual({ in: 10, out: 50 });
    useTimeline.getState().setRange({ in: 10, out: 10 });
    expect(useTimeline.getState().range).toBeNull();
    useTimeline.getState().markIn(5);
    useTimeline.getState().setRange(null);
    expect(useTimeline.getState().pendingIn).toBeNull();
  });
  it("1 幀的範圍 [k, k+1) 是合法的", () => {
    useTimeline.getState().markIn(10);
    expect(useTimeline.getState().markOut(11)).toBe(true);
    expect(useTimeline.getState().range).toEqual({ in: 10, out: 11 });
  });
});

describe("範圍：清單端 / 整段 / 縮放到範圍", () => {
  beforeEach(() => useTimeline.setState({ range: null, pendingIn: null, pendingOut: null, pxPerFrame: null, fitPxPerFrame: 0.5, viewWidth: 900, scrollFrame: 0 }));

  it("setRange 會清掉單邊暫存（不然下一次 I / O 會拿舊的暫存當另一端）", () => {
    useTimeline.getState().markIn(5);
    useTimeline.getState().setRange({ in: 10, out: 20 });
    expect(useTimeline.getState().pendingIn).toBeNull();
  });

  it("Alt+I 清入點：出點留成暫存；Alt+O 反之；只有暫存時清掉那一端", () => {
    useTimeline.getState().setRange({ in: 10, out: 50 });
    useTimeline.getState().clearIn();
    expect(useTimeline.getState()).toMatchObject({ range: null, pendingIn: null, pendingOut: 50 });
    // 再按 I 就組回範圍
    expect(useTimeline.getState().markIn(20)).toBe(true);
    expect(useTimeline.getState().range).toEqual({ in: 20, out: 50 });
    useTimeline.getState().clearOut();
    expect(useTimeline.getState()).toMatchObject({ range: null, pendingIn: 20, pendingOut: null });
    useTimeline.getState().clearOut(); // 沒有出點：不動
    expect(useTimeline.getState().pendingIn).toBe(20);
    useTimeline.getState().clearIn();
    expect(useTimeline.getState().pendingIn).toBeNull();
  });

  it("rangeAll = [0, frames)；0 幀的影片不產生範圍", () => {
    useTimeline.getState().rangeAll(1797);
    expect(useTimeline.getState().range).toEqual({ in: 0, out: 1797 });
    useTimeline.getState().rangeAll(0);
    expect(useTimeline.getState().range).toBeNull();
  });

  it("zoomToRange：範圍佔可視寬 90% 並置中；幾乎整段時回到適配；沒有範圍回 false", () => {
    expect(useTimeline.getState().zoomToRange()).toBe(false);
    useTimeline.getState().setRange({ in: 840, out: 910 });
    expect(useTimeline.getState().zoomToRange(null, 1797)).toBe(true);
    const s = useTimeline.getState();
    expect(s.pxPerFrame).toBeCloseTo((900 * 0.9) / 70);
    const x0 = xOfFrame(840, s.scrollFrame, s.pxPerFrame!);
    const x1 = xOfFrame(910, s.scrollFrame, s.pxPerFrame!);
    expect(x0).toBeCloseTo(45);
    expect(x1).toBeCloseTo(855);
    // 整段（1797 幀 @ fit 0.5 px/幀 = 898 px）→ 算出來比 fit 還小 → 適配
    expect(useTimeline.getState().zoomToRange({ in: 0, out: 1797 }, 1797)).toBe(true);
    expect(useTimeline.getState().pxPerFrame).toBeNull();
    expect(useTimeline.getState().scrollFrame).toBe(0);
  });

  it("zoomToRange 捲動夾在尾端：最後幾幀的範圍不會把時間軸捲到影片外", () => {
    useTimeline.getState().zoomToRange({ in: 1790, out: 1797 }, 1797);
    const s = useTimeline.getState();
    const viewFrames = 900 / s.pxPerFrame!;
    expect(s.scrollFrame).toBeCloseTo(Math.max(0, 1797 - viewFrames));
  });

  it("純函式：rangeEnds / rangeLength / frameInRange / intersectRange", () => {
    expect(rangeEnds({ range: { in: 1, out: 9 }, pendingIn: 3, pendingOut: null })).toEqual({ in: 1, out: 9 });
    expect(rangeEnds({ range: null, pendingIn: 3, pendingOut: null })).toEqual({ in: 3, out: null });
    expect(rangeLength({ in: 840, out: 910 })).toBe(70);
    expect(rangeLength(null)).toBe(0);
    expect(frameInRange({ in: 10, out: 20 }, 10)).toBe(true);
    expect(frameInRange({ in: 10, out: 20 }, 20)).toBe(false);
    expect(intersectRange({ in: 10, out: 100 }, 60, 866)).toEqual({ in: 60, out: 100 });
    expect(intersectRange({ in: 10, out: 60 }, 60, 866)).toBeNull();
    expect(intersectRange(null, 0, 10)).toBeNull();
  });
});

describe("selection", () => {
  it("選關鍵幀同時選它的 track；換 track 清掉關鍵幀", () => {
    useTimeline.getState().selectKeyframe({ trackId: "t1", frame: 3 });
    expect(useTimeline.getState().selectedTrackId).toBe("t1");
    useTimeline.getState().selectTrack("t2");
    expect(useTimeline.getState().selectedKeyframe).toBeNull();
  });
});
