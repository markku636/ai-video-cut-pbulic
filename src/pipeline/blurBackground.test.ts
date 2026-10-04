// 背景虛化的純函式：參數組裝、檔名、顏色換算、摘要。
import { describe, expect, it } from "vitest";
import { blurArgs, blurSummary, colorArg, defaultBlurOut, type BlurBackgroundResult } from "./blurBackground";

const base = { maskPaths: ["m1.aivm"], range: null, outPath: "D:\\out.mp4", strength: null, color: null };

describe("blurArgs", () => {
  it("最小參數：不送 frames、不送 strength（用引擎預設）", () => {
    expect(blurArgs("v.mp4", base)).toEqual({ video: "v.mp4", masks: ["m1.aivm"], out: "D:\\out.mp4" });
  });

  it("有範圍才送 frames", () => {
    expect(blurArgs("v.mp4", { ...base, range: { in: 60, out: 160 } })).toMatchObject({ frames: "60:160" });
  });

  it("強度會送出去", () => {
    expect(blurArgs("v.mp4", { ...base, strength: 2.5 })).toMatchObject({ strength: 2.5 });
  });

  it("換色時不送 strength —— 兩者互斥，都送會讓結果裡的 strength 是 null，對不起來", () => {
    const a = blurArgs("v.mp4", { ...base, strength: 2.5, color: "0,120,0" });
    expect(a).toMatchObject({ color: "0,120,0" });
    expect(a).not.toHaveProperty("strength");
  });

  it("強度 0 不會被當成「沒指定」丟掉（`or` 會吃掉 0，這裡用 != null）", () => {
    // 0 其實會被引擎擋下（強度要大於 0），但要擋在引擎、由引擎講原因，不是在這裡默默消失
    expect(blurArgs("v.mp4", { ...base, strength: 0 })).toMatchObject({ strength: 0 });
  });
});

describe("defaultBlurOut", () => {
  it("跟輸出對話框與移除物件的檔名分開，不會互相覆蓋", () => {
    expect(defaultBlurOut("D:\\v\\clip.webm", null)).toBe("D:\\v\\clip.aivc.bg.mp4");
  });

  it("有指定資料夾就放那裡；POSIX 路徑也對", () => {
    expect(defaultBlurOut("/Users/a/clip.mp4", "/Users/a/out")).toBe("/Users/a/out/clip.aivc.bg.mp4");
  });
});

describe("colorArg", () => {
  it("#RRGGBB → R,G,B", () => {
    expect(colorArg("#0a78ff")).toBe("10,120,255");
    expect(colorArg("008000")).toBe("0,128,0");
  });

  it("看不懂就回 null（呼叫端才講得出「顏色不對」而不是送一個壞值給引擎）", () => {
    expect(colorArg("green")).toBeNull();
    expect(colorArg("#fff")).toBeNull();
    expect(colorArg("")).toBeNull();
  });
});

describe("blurSummary", () => {
  const t = (zh: string, v?: Record<string, string | number>) => (v ? zh.replace(/\{(\w+)\}/g, (_, k) => String(v[k])) : zh);
  const r = (o: Partial<BlurBackgroundResult>): BlurBackgroundResult =>
    ({ video: "v", size: [1260, 720], range: [0, 100], mode: "blur", radius: 19, strength: 1.5, color: null, subjectCoverage: 0.15, missingFrames: 0, changedFrames: 100, out: "o", ...o }) as BlurBackgroundResult;

  it("沒問題時講半徑與佔比", () => {
    expect(blurSummary(r({}), t)).toBe("虛化半徑 19 px・主體平均佔畫面 15.0%");
  });

  it("遮罩斷掉的幀排最前面 —— 那是這條路唯一會默默做壞的東西", () => {
    expect(blurSummary(r({ missingFrames: 7 }), t)).toMatch(/^有 7 幀找不到主體/);
  });

  it("換色模式不講半徑（沒有半徑）", () => {
    expect(blurSummary(r({ mode: "color", radius: null, color: [0, 128, 0] }), t)).toContain("背景換色");
  });
});
