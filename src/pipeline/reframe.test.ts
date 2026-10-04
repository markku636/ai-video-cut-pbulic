// 自動重構圖的純函式：輸出範圍、比例回推、路徑還對不對得上、參數組裝、摘要文字。
//
// reframeMismatch 是這裡最重要的一支：規劃完之後使用者改了範圍或比例，引擎會報錯，
// 但那是在按下輸出、等了一段之後才看到。這支讓那件事在按鈕旁邊就說出來。
import { describe, expect, it } from "vitest";
import { applyArgs, aspectPair, cutsFromShots, defaultApplyOut, reframeArgs, reframeMismatch, reframeSidecars, reframeSummary, writeRange, type ReframePlanResult, type ReframeWant } from "./reframe";

const plan = (over: Partial<ReframePlanResult> = {}): ReframePlanResult => ({
  path: "p.json",
  source: [1920, 1080],
  size: [594, 1056],
  frames: 200,
  range: [0, 200],
  mode: "track",
  cuts: [0, 60],
  missing: 0,
  segments: 12,
  preview: null,
  previewData: null,
  ...over,
});

const want = (over: Partial<ReframeWant> = {}): ReframeWant => ({ aspect: "9:16", text: "person", range: null, trim: false, nFrames: 200, ...over });

describe("writeRange", () => {
  it("沒裁切就是整支", () => {
    expect(writeRange({ range: { in: 10, out: 50 }, trim: false, nFrames: 200 })).toEqual([0, 200]);
  });

  it("有範圍又裁切才是那一段", () => {
    expect(writeRange({ range: { in: 10, out: 50 }, trim: true, nFrames: 200 })).toEqual([10, 50]);
  });

  it("勾了裁切但沒有範圍仍然是整支", () => {
    expect(writeRange({ range: null, trim: true, nFrames: 200 })).toEqual([0, 200]);
  });
});

describe("aspectPair", () => {
  it("解析", () => {
    expect(aspectPair("9:16")).toEqual([9, 16]);
    expect(aspectPair("1:1")).toEqual([1, 1]);
  });

  it("source 不是比例", () => {
    expect(aspectPair("source")).toBeNull();
  });
});

describe("reframeMismatch", () => {
  it("沒要重構就永遠對得上", () => {
    expect(reframeMismatch(null, want({ aspect: "source" }))).toBeNull();
  });

  it("還沒規劃", () => {
    expect(reframeMismatch(null, want())).toBe("missing");
  });

  it("比例對得上（拿裁切尺寸回推，不另存一份狀態）", () => {
    expect(reframeMismatch(plan(), want({ aspect: "9:16" }))).toBeNull();
  });

  it("換了比例", () => {
    expect(reframeMismatch(plan(), want({ aspect: "1:1" }))).toBe("aspect");
    expect(reframeMismatch(plan({ size: [1056, 1056] }), want({ aspect: "1:1" }))).toBeNull();
  });

  it("範圍縮小仍然涵蓋得到", () => {
    expect(reframeMismatch(plan({ range: [0, 200] }), want({ range: { in: 50, out: 80 }, trim: true }))).toBeNull();
  });

  it("範圍超出規劃的就要重新規劃", () => {
    expect(reframeMismatch(plan({ range: [50, 100] }), want({ range: { in: 0, out: 200 }, trim: true }))).toBe("range");
  });

  it("規劃時裁了一段、之後取消裁切 → 輸出變成整支，涵蓋不到", () => {
    // 這是最容易踩到的一種：使用者規劃完才把「只輸出這一段」取消掉
    expect(reframeMismatch(plan({ range: [50, 100] }), want({ range: { in: 50, out: 100 }, trim: false }))).toBe("range");
  });
});

describe("reframeArgs", () => {
  it("基本形", () => {
    expect(reframeArgs("v.mp4", "o.json", want())).toEqual({ video: "v.mp4", out: "o.json", aspect: "9:16", text: "person", range: "0:200", inline_preview: true });
  });

  it("沒有文字就不送 text（引擎據此走靜態置中）", () => {
    expect(reframeArgs("v.mp4", "o.json", want({ text: "  " }))).not.toHaveProperty("text");
  });

  it("規劃的是整個輸出範圍", () => {
    expect(reframeArgs("v.mp4", "o.json", want({ range: { in: 10, out: 50 }, trim: true })).range).toBe("10:50");
  });

  it("算不出範圍時整個欄位不送（讓引擎取整支）", () => {
    // 「轉成直幅」那條路沒有專案、也就沒有 nFrames。送 0:0 的話引擎會回
    // 「K1 要大於 K0」，而那是在使用者按下規劃之後才看到的錯誤。
    expect(reframeArgs("v.mp4", "o.json", want({ nFrames: 0 }))).not.toHaveProperty("range");
  });

  it("零是合法值不能被吃掉", () => {
    // bias_y 0 與「沒給」在引擎端是同一個結果，但 zoom 0 不是 —— 一律用 != null 判斷
    const a = reframeArgs("v.mp4", "o.json", want(), { zoom: 0, biasY: 0, every: 0 });
    expect(a).toMatchObject({ zoom: 0, bias_y: 0, every: 0 });
  });

  it("鏡頭邊界用逗號串起來送；沒有就不送", () => {
    expect(reframeArgs("v.mp4", "o.json", want(), { cuts: [10, 200] }).cuts).toBe("10,200");
    expect(reframeArgs("v.mp4", "o.json", want(), { cuts: [] })).not.toHaveProperty("cuts");
    expect(reframeArgs("v.mp4", "o.json", want(), { cuts: null })).not.toHaveProperty("cuts");
  });

  it("沒給的調校參數不送，讓引擎用自己的預設", () => {
    const a = reframeArgs("v.mp4", "o.json", want(), { zoom: null });
    expect(a).not.toHaveProperty("zoom");
    expect(a).not.toHaveProperty("bias_y");
  });
});

describe("reframeSidecars", () => {
  it("跟輸出檔同目錄同前綴", () => {
    expect(reframeSidecars("D:\\out\\clip.aivc.mp4", "9:16")).toEqual({
      path: "D:\\out\\clip.aivc.9x16.reframe.json",
      preview: "D:\\out\\clip.aivc.9x16.reframe.png",
    });
  });

  it("不同比例不會互相覆蓋", () => {
    expect(reframeSidecars("o.mp4", "9:16").path).not.toBe(reframeSidecars("o.mp4", "1:1").path);
  });

  it("沒有副檔名也不會吃掉目錄名", () => {
    expect(reframeSidecars("D:\\my.dir\\out", "1:1").path).toBe("D:\\my.dir\\out.1x1.reframe.json");
  });
});

describe("reframeSummary", () => {
  const t = (zh: string, vars?: Record<string, string | number>) => zh.replace(/\{(\w+)\}/g, (_, k) => String(vars?.[k] ?? ""));

  it("靜態", () => {
    expect(reframeSummary(plan({ mode: "static", cuts: [0] }), t)).toBe("594×1056（200 幀）・靜態置中");
  });

  it("切點不算第 0 幀", () => {
    // 第 0 幀是「開場就位」不是鏡頭切換；算進去會讓每支片都至少有一個切點，使用者會去找那個不存在的切換
    expect(reframeSummary(plan({ cuts: [0] }), t)).toContain("全程平移");
    expect(reframeSummary(plan({ cuts: [0, 60, 120] }), t)).toContain("2 次鏡頭切換");
  });

  it("自動認出的鏡頭換點會單獨講（那條路上沒有別的方式知道）", () => {
    expect(reframeSummary(plan({ sceneCuts: 3 }), t)).toContain("認出 3 個鏡頭換點");
    expect(reframeSummary(plan({ sceneCuts: 0 }), t)).not.toContain("認出");
    expect(reframeSummary(plan({}), t)).not.toContain("認出");
  });

  it("漏偵測會講出來", () => {
    expect(reframeSummary(plan({ missing: 7 }), t)).toContain("7 幀沒偵測到");
  });

  it("沒漏就不提（不要為了有東西而吵）", () => {
    expect(reframeSummary(plan({ missing: 0 }), t)).not.toContain("沒偵測到");
  });
});

describe("applyArgs / defaultApplyOut（套到任何一支影片，不需要專案）", () => {
  it("不縮放就不送 size（整條路零重取樣）", () => {
    expect(applyArgs("v.mp4", "p.json", "o.mp4", null)).toEqual({ video: "v.mp4", path: "p.json", out: "o.mp4" });
  });

  it("要縮放就送 WxH", () => {
    expect(applyArgs("v.mp4", "p.json", "o.mp4", [1080, 1920]).size).toBe("1080x1920");
  });

  it("輸出檔名帶比例，不同比例不會互相覆蓋", () => {
    expect(defaultApplyOut("D:\\a\\clip.mp4", "9:16")).toBe("D:\\a\\clip.9x16.mp4");
    expect(defaultApplyOut("D:\\a\\clip.mp4", "1:1")).toBe("D:\\a\\clip.1x1.mp4");
  });

  it("沒有副檔名也不會吃掉目錄名", () => {
    expect(defaultApplyOut("D:\\my.dir\\out", "9:16")).toBe("D:\\my.dir\\out.9x16.mp4");
  });
});

describe("cutsFromShots", () => {
  it("取每個鏡頭的起點、遞增、去重", () => {
    expect(cutsFromShots([{ startFrame: 0 }, { startFrame: 300 }, { startFrame: 120 }])).toEqual([120, 300]);
  });

  it("第 0 幀不算切點（那是開場，不是切換）", () => {
    expect(cutsFromShots([{ startFrame: 0 }])).toEqual([]);
  });

  it("沒有鏡頭就是空的", () => {
    expect(cutsFromShots([])).toEqual([]);
  });
});
