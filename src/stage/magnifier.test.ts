import { describe, expect, it } from "vitest";
import { MAG_OFFSET, MAG_SIZE, magnifierCrosshair, magnifierPlacement, magnifierSourceRect } from "./magnifier";

describe("stage/magnifier", () => {
  it("4× 放大 128 px → 取樣 32×32，以中心點為中心", () => {
    const r = magnifierSourceRect([640, 360], 1280, 720);
    expect(r).toEqual({ sx: 624, sy: 344, sw: 32, sh: 32 });
    expect(magnifierCrosshair([640, 360], r)).toEqual([64, 64]);
  });

  it("貼邊時平移而不縮小（倍率不變），十字跟著偏", () => {
    const r = magnifierSourceRect([5, 5], 1280, 720);
    expect(r).toEqual({ sx: 0, sy: 0, sw: 32, sh: 32 });
    // 中心 (5,5) 在放大鏡裡是 5 × 4 = 20 px
    expect(magnifierCrosshair([5, 5], r)).toEqual([20, 20]);
    const r2 = magnifierSourceRect([1279, 719], 1280, 720);
    expect(r2).toEqual({ sx: 1248, sy: 688, sw: 32, sh: 32 });
    expect(magnifierCrosshair([1279, 719], r2)).toEqual([124, 124]);
  });

  it("影片比取樣窗還小就整張", () => {
    expect(magnifierSourceRect([10, 10], 20, 16)).toEqual({ sx: 0, sy: 0, sw: 20, sh: 16 });
  });

  it("放置：預設在游標右下，碰右 / 下緣就翻邊，永遠不出舞台", () => {
    const stage = { w: 1000, h: 600 };
    expect(magnifierPlacement([100, 100], stage)).toEqual([100 + MAG_OFFSET, 100 + MAG_OFFSET]);
    // 右緣：翻到左邊
    expect(magnifierPlacement([950, 100], stage)).toEqual([950 - MAG_OFFSET - MAG_SIZE, 100 + MAG_OFFSET]);
    // 下緣：翻到上面
    expect(magnifierPlacement([100, 560], stage)).toEqual([100 + MAG_OFFSET, 560 - MAG_OFFSET - MAG_SIZE]);
    // 舞台比放大鏡還小：夾到 0
    expect(magnifierPlacement([10, 10], { w: 100, h: 100 })).toEqual([0, 0]);
  });
});
