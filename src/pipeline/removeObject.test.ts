// 移除物件的純函式：輸出路徑、引擎參數、摘要文字。
//
// removeArgs 的重點是「關掉影子要送 1、開著不送」：預設值只能有引擎那一份，
// 在這裡再複製一份，兩邊遲早會不一樣。
import { describe, expect, it } from "vitest";
import { defaultRemoveOut, platePathFor, removeArgs, removeSummary, type RemoveObjectOpts, type RemoveObjectResult } from "./removeObject";

const opts = (over: Partial<RemoveObjectOpts> = {}): RemoveObjectOpts => ({
  maskPaths: ["D:\\c\\obj1\\masks.aivm"],
  range: null,
  outPath: "D:\\out.mp4",
  platePath: null,
  shadow: true,
  dilate: null,
  ...over,
});

const result = (over: Partial<RemoveObjectResult> = {}): RemoveObjectResult => ({
  video: "v.mp4",
  size: [1260, 720],
  range: [0, 209],
  samples: 24,
  cameraShift: 0.1,
  coverage: 1,
  inpaintedPixels: 0,
  thinPixels: 0,
  plate: null,
  plateData: null,
  out: null,
  ...over,
});

describe("defaultRemoveOut", () => {
  it("與輸出對話框的檔名分開（不會互相覆蓋）", () => {
    expect(defaultRemoveOut("D:\\a\\clip.mp4", null)).toBe("D:\\a\\clip.aivc.clean.mp4");
    expect(defaultRemoveOut("D:\\a\\clip.mp4", null)).not.toBe("D:\\a\\clip.aivc.mp4");
  });

  it("指定輸出目錄", () => {
    expect(defaultRemoveOut("D:\\a\\clip.webm", "E:\\out")).toBe("E:\\out\\clip.aivc.clean.mp4");
  });

  it("POSIX 路徑", () => {
    expect(defaultRemoveOut("/home/x/clip.mkv", null)).toBe("/home/x/clip.aivc.clean.mp4");
  });
});

describe("platePathFor", () => {
  it("放在輸出影片旁邊、同一個前綴", () => {
    expect(platePathFor("D:\\a\\clip.aivc.clean.mp4")).toBe("D:\\a\\clip.aivc.clean.plate.png");
  });

  it("沒有副檔名也不會吃掉目錄名", () => {
    expect(platePathFor("D:\\my.dir\\out")).toBe("D:\\my.dir\\out.plate.png");
  });
});

describe("removeArgs", () => {
  it("基本形", () => {
    expect(removeArgs("v.mp4", opts())).toEqual({ video: "v.mp4", masks: ["D:\\c\\obj1\\masks.aivm"], out: "D:\\out.mp4", inline_plate: true });
  });

  it("影子預設開著就不送參數（預設值只有引擎一份）", () => {
    expect(removeArgs("v.mp4", opts())).not.toHaveProperty("shadow");
  });

  it("關掉影子要送 1（比值門檻 1 = 沒有像素算得上影子）", () => {
    expect(removeArgs("v.mp4", opts({ shadow: false })).shadow).toBe(1);
  });

  it("只算背景板時不送 out", () => {
    const a = removeArgs("v.mp4", opts({ outPath: null, platePath: "p.png" }));
    expect(a).not.toHaveProperty("out");
    expect(a.emit_plate).toBe("p.png");
  });

  it("範圍", () => {
    expect(removeArgs("v.mp4", opts({ range: { in: 40, out: 80 } })).frames).toBe("40:80");
  });

  it("膨脹 0 是合法值不能被吃掉", () => {
    // 0 = 完全不膨脹（遮罩已經夠寬時會想這樣）；`||` 會把它變回引擎預設
    expect(removeArgs("v.mp4", opts({ dilate: 0 })).dilate).toBe(0);
    expect(removeArgs("v.mp4", opts({ dilate: null }))).not.toHaveProperty("dilate");
  });

  it("多個物件一起移除", () => {
    expect(removeArgs("v.mp4", opts({ maskPaths: ["a.aivm", "b.aivm"] })).masks).toEqual(["a.aivm", "b.aivm"]);
  });
});

describe("removeSummary", () => {
  const t = (zh: string, vars?: Record<string, string | number>) => zh.replace(/\{(\w+)\}/g, (_, k) => String(vars?.[k] ?? ""));

  it("一切正常時只講取樣與覆蓋率", () => {
    expect(removeSummary(result(), t)).toBe("取樣 24 幀・背景覆蓋率 100.0%");
  });

  it("有補繪的像素要講出來（那裡會糊）", () => {
    expect(removeSummary(result({ inpaintedPixels: 812 }), t)).toContain("812 個像素整段沒露出過");
  });

  it("有補繪時就不再重複講取樣偏少（同一件事的兩種程度）", () => {
    const s = removeSummary(result({ inpaintedPixels: 812, thinPixels: 900 }), t);
    expect(s).toContain("整段沒露出過");
    expect(s).not.toContain("乾淨取樣偏少");
  });

  it("鏡頭略有位移才提（0.1 px 不必吵）", () => {
    expect(removeSummary(result({ cameraShift: 0.1 }), t)).not.toContain("位移");
    expect(removeSummary(result({ cameraShift: 1.8 }), t)).toContain("1.8 px");
  });
});
