// 情境提示跟著狀態走：每一種狀態都要看得到「下一步最像的那一句」。
import { describe, expect, it } from "vitest";
import { TOOLS } from "./catalogue";
import { suggestedPrompts, TOOL_TITLE } from "./labels";

describe("suggestedPrompts", () => {
  it("沒有字幕：先建議產生字幕，不建議要字幕的事", () => {
    const p = suggestedPrompts({ hasCaptions: false, hasRange: false, shots: 0, durationSeconds: 60 });
    expect(p[0]).toBe("幫我產生字幕");
    expect(p).not.toContain("幫我分章節、寫摘要");
    expect(p.length).toBeLessThanOrEqual(6);
  });

  it("有字幕：章節、精華、語助詞、找一句話", () => {
    const p = suggestedPrompts({ hasCaptions: true, hasRange: false, shots: 0, durationSeconds: 60 });
    expect(p.slice(0, 4)).toEqual(["幫我分章節、寫摘要", "找出最精彩的幾段", "把「呃」「嗯」那些語助詞拿掉", "跳到我講到「重點」的那句"]);
  });

  it("選了範圍：第一句就是剪掉這段", () => {
    const p = suggestedPrompts({ hasCaptions: true, hasRange: true, shots: 3, durationSeconds: 60 });
    expect(p[0]).toBe("把選取的範圍剪掉");
    expect(p).toContain("在鏡頭切點分割");
    // 有範圍時不建議「把 2 到 4 秒剪掉」（那是沒範圍時的示範句）
    expect(p).not.toContain("把 2 到 4 秒剪掉");
  });

  it("最多 6 句", () => {
    expect(suggestedPrompts({ hasCaptions: true, hasRange: true, shots: 9, durationSeconds: 600 })).toHaveLength(6);
  });
});

describe("TOOL_TITLE", () => {
  it("每個工具都有顯示名稱（少一個面板就會顯示英文 id）", () => {
    for (const tool of TOOLS) expect(TOOL_TITLE[tool.name as keyof typeof TOOL_TITLE], tool.name).toBeTruthy();
  });
});
