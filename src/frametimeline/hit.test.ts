import { describe, expect, it } from "vitest";
import { layoutRows, ROW } from "./draw";
import { edgeAtX, frameAtX, hitRangePart, hitTimeline } from "./hit";

const L = layoutRows(["a", "b"]);
const view = { scrollFrame: 100, pxPerFrame: 4, frames: 1000 };
const data = {
  shots: [
    { id: "s1", startFrame: 0, endFrame: 150 },
    { id: "s2", startFrame: 150, endFrame: 1000 },
  ],
  tracks: [
    { id: "a", keyframes: [120, 160] },
    { id: "b", keyframes: [] },
  ],
};

describe("frametimeline/hit", () => {
  it("frameAtX 用 xOfFrame 的反函式、四捨五入、夾在 [0, frames-1]", () => {
    expect(frameAtX(0, view)).toBe(100);
    expect(frameAtX(80, view)).toBe(120);
    expect(frameAtX(82, view)).toBe(121); // 20.5 → 121
    expect(frameAtX(-1000, view)).toBe(0);
    expect(frameAtX(1e9, view)).toBe(999);
  });

  it("尺規 / 鏡頭帶 / 縮圖列依 y 分列，鏡頭帶帶出鏡頭 id", () => {
    expect(hitTimeline(80, 5, L, view, data)).toEqual({ kind: "ruler", frame: 120 });
    expect(hitTimeline(80, L.shotsY + 1, L, view, data)).toEqual({ kind: "shots", shotId: "s1", frame: 120 });
    expect(hitTimeline(400, L.shotsY + 1, L, view, data)).toEqual({ kind: "shots", shotId: "s2", frame: 200 });
    expect(hitTimeline(80, L.thumbsY + 10, L, view, data)).toEqual({ kind: "thumbs", frame: 120 });
  });

  it("track 兩列：上列 solved、下列 user；菱形 6 px 內命中 keyframe、取最近的", () => {
    const rowA = L.rows[0];
    expect(hitTimeline(80, rowA.solvedY + 2, L, view, data)).toEqual({ kind: "solved", trackId: "a", frame: 120 });
    // x=80 正好是幀 120 的菱形
    expect(hitTimeline(80, rowA.userY + 5, L, view, data)).toEqual({ kind: "keyframe", trackId: "a", frame: 120 });
    // 5 px 外仍命中、7 px 外就是空的 user 列
    expect(hitTimeline(85, rowA.userY + 5, L, view, data)).toEqual({ kind: "keyframe", trackId: "a", frame: 120 });
    expect(hitTimeline(87, rowA.userY + 5, L, view, data).kind).toBe("user");
    // 兩個菱形都在容忍內時取近的（120 在 x=80、160 在 x=240 → 不會同時，用小 px 測）
    const tight = { scrollFrame: 100, pxPerFrame: 0.2, frames: 1000 }; // 120→4px, 160→12px
    expect(hitTimeline(9, rowA.userY + 5, L, tight, data)).toEqual({ kind: "keyframe", trackId: "a", frame: 160 });
    expect(hitTimeline(7, rowA.userY + 5, L, tight, data)).toEqual({ kind: "keyframe", trackId: "a", frame: 120 });
  });

  it("第二條 track 沒有關鍵幀 → user；列之間的間隙與底下 → empty", () => {
    const rowB = L.rows[1];
    expect(hitTimeline(80, rowB.userY + 3, L, view, data)).toEqual({ kind: "user", trackId: "b", frame: 120 });
    expect(hitTimeline(80, L.rows[0].y + L.rows[0].h + ROW.gap / 2, L, view, data).kind).toBe("empty");
    expect(hitTimeline(80, L.height + 50, L, view, data)).toEqual({ kind: "empty", frame: 120 });
  });
});

describe("frametimeline/hit：範圍列", () => {
  const withRange = { ...data, range: { in: 120, out: 140 } }; // x = 80..160

  it("edgeAtX 夾在 [0, frames]（不是 frames−1）：範圍可以一路拉到最後一幀", () => {
    expect(edgeAtX(1e9, view)).toBe(1000);
    expect(frameAtX(1e9, view)).toBe(999);
    expect(edgeAtX(-1e9, view)).toBe(0);
    expect(edgeAtX(82, view)).toBe(121);
  });

  it("範圍列在尺規與鏡頭帶之間；沒有範圍 → empty", () => {
    expect(hitTimeline(100, L.rangeY + 2, L, view, data)).toEqual({ kind: "range", part: "empty", frame: 125 });
    expect(hitTimeline(100, L.rangeY - 1, L, view, withRange).kind).toBe("ruler");
    expect(hitTimeline(100, L.shotsY, L, view, withRange).kind).toBe("shots");
  });

  it("握把容忍 5 px、本體、範圍外", () => {
    const y = L.rangeY + 5;
    expect(hitTimeline(84, y, L, view, withRange)).toEqual({ kind: "range", part: "in", frame: 121 });
    expect(hitTimeline(76, y, L, view, withRange)).toMatchObject({ kind: "range", part: "in" });
    expect(hitTimeline(74, y, L, view, withRange)).toMatchObject({ part: "empty" });
    expect(hitTimeline(120, y, L, view, withRange)).toMatchObject({ part: "body" });
    expect(hitTimeline(158, y, L, view, withRange)).toMatchObject({ part: "out" });
    expect(hitTimeline(170, y, L, view, withRange)).toMatchObject({ part: "empty" });
  });

  it("兩端重疊（短範圍 / 縮很小）取較近的一端，等距看中點哪一側", () => {
    const tiny = { scrollFrame: 0, pxPerFrame: 2, frames: 1000 }; // [50, 52) → x 100..104
    const r = { in: 50, out: 52 };
    expect(hitRangePart(100.5, r, tiny)).toBe("in");
    expect(hitRangePart(103.5, r, tiny)).toBe("out");
    expect(hitRangePart(101.9, r, tiny)).toBe("in");
    expect(hitRangePart(102, r, tiny)).toBe("out");
    // 1 幀、0.5 px/幀：兩端幾乎同一點，游標在右邊就要抓得到 out（不然拉不長）
    const r1 = { in: 100, out: 101 };
    const far = { scrollFrame: 0, pxPerFrame: 0.5, frames: 1000 };
    expect(hitRangePart(52, r1, far)).toBe("out");
    expect(hitRangePart(48, r1, far)).toBe("in");
  });
});

describe("frametimeline/hit：參考影格錨標", () => {
  it("菱形優先，沒有菱形時 5 px 內命中 reference", () => {
    const d = { ...data, tracks: [{ id: "a", keyframes: [120], referenceFrame: 130 }, { id: "b", keyframes: [], referenceFrame: null }] };
    const rowA = L.rows[0];
    expect(hitTimeline(120, rowA.userY + 5, L, view, d)).toEqual({ kind: "reference", trackId: "a", frame: 130 });
    expect(hitTimeline(126, rowA.userY + 5, L, view, d).kind).toBe("user");
    // 參考影格剛好是關鍵幀：抓菱形
    const same = { ...data, tracks: [{ id: "a", keyframes: [130], referenceFrame: 130 }] };
    expect(hitTimeline(120, rowA.userY + 5, L, view, same).kind).toBe("keyframe");
  });
});
