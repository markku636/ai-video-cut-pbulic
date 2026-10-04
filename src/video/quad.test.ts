import { describe, expect, it } from "vitest";
import type { Quad } from "../project/format";
import { applyH, applyHQuad, centeredBoxQuad, gridLines, IDENTITY_H, isConvex, moveCorner, pointInQuad, quadArea, rectQuad, translateQuad, type Homography } from "./quad";

const SQ: Quad = rectQuad(10, 10, 100, 80);

describe("isConvex", () => {
  it("矩形 / 透視壓扁的梯形是凸的", () => {
    expect(isConvex(SQ)).toBe(true);
    expect(isConvex({ p: [[0, 0], [100, 5], [95, 60], [8, 55]] })).toBe(true);
  });
  it("蝴蝶結（TR 與 BR 對調）不是", () => {
    expect(isConvex({ p: [[0, 0], [100, 80], [100, 0], [0, 80]] })).toBe(false);
  });
  it("三點共線 / 兩點重合 / NaN 不是", () => {
    expect(isConvex({ p: [[0, 0], [50, 0], [100, 0], [0, 80]] })).toBe(false);
    expect(isConvex({ p: [[0, 0], [0, 0], [100, 80], [0, 80]] })).toBe(false);
    expect(isConvex({ p: [[0, 0], [Number.NaN, 0], [100, 80], [0, 80]] })).toBe(false);
  });
  it("凹四邊形不是", () => {
    expect(isConvex({ p: [[0, 0], [100, 0], [50, 20], [0, 80]] })).toBe(false);
  });
});

describe("pointInQuad / area", () => {
  it("內、外、邊上", () => {
    expect(pointInQuad([50, 50], SQ)).toBe(true);
    expect(pointInQuad([5, 50], SQ)).toBe(false);
    expect(pointInQuad([10, 50], SQ)).toBe(true);
  });
  it("非凸一律 false", () => {
    expect(pointInQuad([50, 40], { p: [[0, 0], [100, 80], [100, 0], [0, 80]] })).toBe(false);
  });
  it("面積：順時針為正", () => {
    expect(quadArea(SQ)).toBe(8000);
  });
});

describe("applyH", () => {
  it("identity 不動", () => {
    expect(applyH(IDENTITY_H, [3, 4])).toEqual([3, 4]);
  });
  it("平移 + 縮放", () => {
    const h: Homography = [2, 0, 5, 0, 2, 7, 0, 0, 1];
    expect(applyH(h, [1, 1])).toEqual([7, 9]);
    expect(applyHQuad(h, rectQuad(0, 0, 1, 1)).p[2]).toEqual([7, 9]);
  });
  it("投影分母歸零回 NaN 而不是巨大座標", () => {
    const h: Homography = [1, 0, 0, 0, 1, 0, 0, 0, 0];
    expect(applyH(h, [1, 1]).every((v) => Number.isNaN(v))).toBe(true);
  });
});

describe("editing helpers", () => {
  it("moveCorner 只動一角且不改原物件", () => {
    const q = moveCorner(SQ, 2, [200, 200]);
    expect(q.p[2]).toEqual([200, 200]);
    expect(SQ.p[2]).toEqual([110, 90]);
  });
  it("translateQuad", () => {
    expect(translateQuad(SQ, 1, -1).p[0]).toEqual([11, 9]);
  });
  it("gridLines 3×3 有 4 條線", () => {
    const g = gridLines(SQ);
    expect(g).toHaveLength(4);
    expect(g[0][0][0]).toBeCloseTo(10 + 100 / 3);
  });
});

describe("centeredBoxQuad（新平面 track 的預設框）", () => {
  it("1080p：正中央、16:9、寬 40%（不是牌的直式比例）", () => {
    expect(centeredBoxQuad(1920, 1080)).toEqual(rectQuad(576, 324, 768, 432));
  });

  it("直式畫面也是 16:9 的橫框、在正中央", () => {
    const q = centeredBoxQuad(1080, 1920);
    const w = q.p[1][0] - q.p[0][0];
    const h = q.p[3][1] - q.p[0][1];
    expect(Math.abs(w / h - 16 / 9)).toBeLessThan(0.01);
    expect(Math.abs(q.p[0][0] + w / 2 - 540)).toBeLessThanOrEqual(1);
    expect(Math.abs(q.p[0][1] + h / 2 - 960)).toBeLessThanOrEqual(1);
  });

  it("很扁的畫面：以高為限，框不超出畫面", () => {
    const q = centeredBoxQuad(1000, 200);
    expect(q.p[0][1]).toBeGreaterThanOrEqual(0);
    expect(q.p[2][1]).toBeLessThanOrEqual(200);
    expect(q.p[0][0]).toBeGreaterThanOrEqual(0);
  });
});
