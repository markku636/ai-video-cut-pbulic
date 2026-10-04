import { describe, expect, it } from "vitest";
import { rectQuad } from "../video/quad";
import { distToSegment, EDGE_HIT_PX, HANDLE_HIT_PX, hitQuad, nearestCorner, pickQuad } from "./hit";

const q = rectQuad(100, 100, 200, 120); // TL(100,100) TR(300,100) BR(300,220) BL(100,220)

describe("stage/hit", () => {
  it("角在 12 px 內命中、超過就不是角", () => {
    expect(hitQuad([100 + HANDLE_HIT_PX - 0.5, 100], q)).toEqual({ kind: "corner", index: 0 });
    expect(hitQuad([300, 220 - 5], q)).toEqual({ kind: "corner", index: 2 });
    // 13 px 外：落在邊上（y=100 是 TL→TR 那條邊）
    expect(hitQuad([100 + HANDLE_HIT_PX + 1, 100], q)).toEqual({ kind: "edge", index: 0 });
  });

  it("角優先於邊、邊優先於內部", () => {
    // 正好在角上 → corner（雖然也在兩條邊與內部）
    expect(hitQuad([100, 100], q)).toEqual({ kind: "corner", index: 0 });
    // 邊中點 → edge 1（TR→BR 是 x=300）
    expect(hitQuad([300, 160], q)).toEqual({ kind: "edge", index: 1 });
    // 邊 6 px 內、角 12 px 外 → edge
    expect(hitQuad([200, 100 + EDGE_HIT_PX], q)).toEqual({ kind: "edge", index: 0 });
    // 中央 → inside
    expect(hitQuad([200, 160], q)).toEqual({ kind: "inside" });
  });

  it("外面回 null；handles:false 時只有 inside", () => {
    expect(hitQuad([50, 50], q)).toBeNull();
    expect(hitQuad([100, 100], q, { handles: false })).toEqual({ kind: "inside" });
    expect(hitQuad([100 - 5, 100], q, { handles: false })).toBeNull();
  });

  it("多個角都在範圍內時取最近的", () => {
    const tiny = rectQuad(0, 0, 10, 10);
    expect(nearestCorner([7, 1], tiny)).toBe(1); // 離 TR(10,0) 3.16、離 TL 7.07
  });

  it("distToSegment：投影落在線段外時取端點距離", () => {
    expect(distToSegment([0, 5], [10, 0], [20, 0])).toBeCloseTo(Math.hypot(10, 5));
    expect(distToSegment([15, 5], [10, 0], [20, 0])).toBe(5);
    // 退化線段
    expect(distToSegment([3, 4], [0, 0], [0, 0])).toBe(5);
  });

  it("pickQuad：選中的先問（含把手）、其餘依面積小到大", () => {
    const big = rectQuad(0, 0, 1000, 1000);
    const small = rectQuad(400, 400, 50, 50);
    // 沒選中：點在小的裡面 → 小的（面積小先問）
    expect(pickQuad([420, 420], [{ quad: big, selected: false }, { quad: small, selected: false }])?.index).toBe(1);
    // 大的被選中、點到大的角 → 大的 corner
    const r = pickQuad([2, 2], [{ quad: big, selected: true }, { quad: small, selected: false }]);
    expect(r).toEqual({ index: 0, hit: { kind: "corner", index: 0 } });
    // 未選中的沒有把手：點小的角上，回 inside 不是 corner
    const r2 = pickQuad([400, 400], [{ quad: big, selected: false }, { quad: small, selected: false }]);
    expect(r2).toEqual({ index: 1, hit: { kind: "inside" } });
    expect(pickQuad([-50, -50], [{ quad: big, selected: true }])).toBeNull();
  });
});
