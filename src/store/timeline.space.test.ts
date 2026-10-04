// 時間軸空間（序列 / 素材，docs/editor-m2-design.md §9.1）：旗標關著永遠是素材、切換時回到整段適配、localStorage 壞值不炸。
import { describe, expect, it } from "vitest";
import { effectiveSpace, parseTimelineSpace, useTimeline } from "./timeline";

describe("store/timeline：space", () => {
  it("實驗旗標關著時一律是素材空間（M2.17 之前使用者看不到半成品）", () => {
    expect(effectiveSpace("sequence", false)).toBe("source");
    expect(effectiveSpace("source", false)).toBe("source");
    expect(effectiveSpace("sequence", true)).toBe("sequence");
    expect(effectiveSpace("source", true)).toBe("source");
  });

  it("還原：只認 source，其他（沒有、壞值）都是序列", () => {
    expect(parseTimelineSpace("source")).toBe("source");
    expect(parseTimelineSpace("sequence")).toBe("sequence");
    expect(parseTimelineSpace(null)).toBe("sequence");
    expect(parseTimelineSpace("garbage")).toBe("sequence");
  });

  it("切換空間回到整段適配、清掉 in / out（兩個空間的座標不同，留著會指到別段）；同一個空間什麼都不動", () => {
    useTimeline.setState({ space: "source", pxPerFrame: 8, scrollFrame: 120, range: { in: 10, out: 40 }, pendingIn: null, pendingOut: null });
    useTimeline.getState().setSpace("source");
    expect(useTimeline.getState()).toMatchObject({ space: "source", pxPerFrame: 8, scrollFrame: 120, range: { in: 10, out: 40 } });
    useTimeline.getState().setSpace("sequence");
    expect(useTimeline.getState()).toMatchObject({ space: "sequence", pxPerFrame: null, scrollFrame: 0, range: null, pendingIn: null, pendingOut: null });
    // node 沒有 localStorage：寫入失敗也照樣切換
    useTimeline.getState().setSpace("source");
    expect(useTimeline.getState().space).toBe("source");
  });
});
