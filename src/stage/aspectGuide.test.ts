// 畫面比例參考線的幾何：必須與引擎 `reframe/path.py` 的 crop_size() 逐值相同。
//
// 同一條規則有兩份實作（TS 畫線、Python 真的裁），所以這裡用**同一組已知答案**釘住。
// 下面的期望值跟 engine/tests/test_reframe_path.py 的 TestCropSize 是同一批數字；
// 哪天有人改了其中一邊，這裡會紅。
import { describe, expect, it } from "vitest";
import { ASPECT_GUIDES, cropSize, guideCoverage } from "./aspectGuide";

describe("cropSize：與引擎同一條規則", () => {
  it("1920×1080 取 9:16 = 594×1056（不是 607.5 取整的 608×1080）", () => {
    const r = cropSize(1920, 1080, "9:16")!;
    expect([r.w, r.h]).toEqual([594, 1056]);
    expect(r.w * 16).toBe(r.h * 9); // 比例精確
    expect(r.w % 2).toBe(0);
    expect(r.h % 2).toBe(0);
  });

  it("目標比來源寬時吃滿寬度", () => {
    expect(cropSize(1920, 1080, "16:9")).toMatchObject({ w: 1920, h: 1080 });
  });

  it("每個對外的比例都塞得進 1920×1080，而且長寬都是偶數", () => {
    for (const a of ASPECT_GUIDES) {
      const r = cropSize(1920, 1080, a)!;
      expect(r.w, a).toBeLessThanOrEqual(1920);
      expect(r.h, a).toBeLessThanOrEqual(1080);
      expect(r.w % 2, a).toBe(0);
      expect(r.h % 2, a).toBe(0);
    }
  });

  it("1260×720（專案的 proxy 尺寸）取 9:16 = 396×704", () => {
    // 實機量過的數字：aivc reframe 對這支 proxy 就是回這個尺寸
    expect(cropSize(1260, 720, "9:16")).toMatchObject({ w: 396, h: 704 });
  });

  it("置中，而且左上角也是偶數（跟裁切一樣的對齊要求）", () => {
    const r = cropSize(1920, 1080, "9:16")!;
    expect(r.x % 2).toBe(0);
    expect(r.y % 2).toBe(0);
    // 置中：左右剩下的空間差不超過 2 px（取偶數造成的）
    expect(Math.abs(r.x - (1920 - r.w - r.x))).toBeLessThanOrEqual(2);
  });

  it("來源太小回 null（呼叫端就不畫）", () => {
    expect(cropSize(1, 1, "9:16")).toBeNull();
    expect(cropSize(0, 0, "1:1")).toBeNull();
  });
});

describe("guideCoverage", () => {
  it("9:16 從 16:9 裡只留下三成左右", () => {
    const c = guideCoverage(cropSize(1920, 1080, "9:16"), 1920, 1080);
    expect(c).toBeGreaterThan(0.28);
    expect(c).toBeLessThan(0.32);
  });

  it("16:9 從 16:9 裡全留", () => {
    expect(guideCoverage(cropSize(1920, 1080, "16:9"), 1920, 1080)).toBe(1);
  });

  it("沒有框就是 0", () => {
    expect(guideCoverage(null, 1920, 1080)).toBe(0);
  });
});
