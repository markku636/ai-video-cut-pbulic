import { describe, expect, it } from "vitest";
import { buildGeometry, containRect } from "./useStageGeometry";

describe("stage/useStageGeometry（純算術）", () => {
  it("containRect：寬容器 → 左右留白（pillarbox）、高容器 → 上下留白（letterbox）", () => {
    const wide = containRect(2000, 720, 1280, 720);
    expect(wide).toEqual({ x: 360, y: 0, w: 1280, h: 720 });
    const tall = containRect(1280, 1000, 1280, 720);
    expect(tall).toEqual({ x: 0, y: 140, w: 1280, h: 720 });
    expect(containRect(0, 100, 16, 9)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });

  it("toScreen / toVideo 互為反函式，座標是來源像素（不是 proxy 像素）", () => {
    // 來源 1920×1080、proxy 縮到 1280×720（scale 2/3）、容器 640×360 → 一個來源像素 = 1/3 螢幕 px
    const geo = buildGeometry({ w: 640, h: 360 }, { width: 1280, height: 720, scale: 2 / 3 }, 2);
    expect(geo.srcW).toBeCloseTo(1920);
    expect(geo.srcH).toBeCloseTo(1080);
    expect(geo.pxPerSrc).toBeCloseTo(1 / 3);
    expect(geo.toScreen([0, 0])).toEqual([0, 0]);
    expect(geo.toScreen([1920, 1080])[0]).toBeCloseTo(640);
    const p: [number, number] = [123.4, 567.8];
    const back = geo.toVideo(geo.toScreen(p));
    expect(back[0]).toBeCloseTo(p[0]);
    expect(back[1]).toBeCloseTo(p[1]);
    // proxy px = 來源 × scale
    expect(geo.toProxy([1920, 1080])).toEqual([1280, 720]);
    expect(geo.screenToProxy([640, 360])[0]).toBeCloseTo(1280);
    expect(geo.dpr).toBe(2);
  });

  it("留白會被算進 toScreen 的位移", () => {
    const geo = buildGeometry({ w: 2000, h: 720 }, { width: 1280, height: 720, scale: 1 }, 1);
    expect(geo.rect.x).toBe(360);
    expect(geo.toScreen([0, 0])).toEqual([360, 0]);
    expect(geo.toVideo([360, 0])).toEqual([0, 0]);
    expect(geo.toVideo([1640, 720])).toEqual([1280, 720]);
  });

  it("withAffine 只動 toScreen，toVideo 不反解（穩定視圖只看不編輯）", () => {
    const geo = buildGeometry({ w: 1280, h: 720 }, { width: 1280, height: 720, scale: 1 }, 1);
    const pinned = geo.withAffine([1, 0, 0, 1, 10, -5]);
    expect(pinned.affine).toEqual([1, 0, 0, 1, 10, -5]);
    expect(pinned.toScreen([100, 100])).toEqual([110, 95]);
    expect(pinned.toVideo([110, 95])).toEqual([110, 95]);
    expect(geo.affine).toBeNull();
  });

  it("scale ≤ 0 視為 1，不會除以零", () => {
    const geo = buildGeometry({ w: 100, h: 100 }, { width: 100, height: 100, scale: 0 }, 1);
    expect(geo.srcW).toBe(100);
    expect(Number.isFinite(geo.pxPerSrc)).toBe(true);
  });
});
