// selectionSpan：選取 → 序列幀區間（「播放選取」與「將片段設為範圍」共用）。
import { describe, expect, it } from "vitest";
import { selectionSpan } from "./selectionSpan";
import { aclip, FPS30, gap, lane, seqOf, vclip } from "./testkit";

// 三個 V1 片段各 100 幀：clip-1 [0,100)、gap-1 [100,110)、clip-2 [110,210)
const SEQ = () => seqOf([vclip("clip-1", "m1", 0, 100), gap("gap-1", 10), vclip("clip-2", "m1", 100, 200)]);

describe("selectionSpan", () => {
  it("沒選任何東西 → null", () => {
    expect(selectionSpan(SEQ(), [])).toBeNull();
  });

  it("選一個片段 → 它的 [t0, t1)", () => {
    expect(selectionSpan(SEQ(), ["clip-1"])).toEqual({ in: 0, out: 100 });
    expect(selectionSpan(SEQ(), ["clip-2"])).toEqual({ in: 110, out: 210 });
  });

  it("選空白也算（它在序列上佔位）", () => {
    expect(selectionSpan(SEQ(), ["gap-1"])).toEqual({ in: 100, out: 110 });
  });

  it("多選 → 聯集外框，中間沒選到的也落在區間裡（Final Cut 的 Play Selection 行為）", () => {
    expect(selectionSpan(SEQ(), ["clip-1", "clip-2"])).toEqual({ in: 0, out: 210 });
  });

  it("選取順序不影響結果", () => {
    expect(selectionSpan(SEQ(), ["clip-2", "clip-1"])).toEqual({ in: 0, out: 210 });
  });

  it("id 已經不在序列裡（undo 之後）→ 忽略；全部都不在 → null", () => {
    expect(selectionSpan(SEQ(), ["clip-1", "沒這個"])).toEqual({ in: 0, out: 100 });
    expect(selectionSpan(SEQ(), ["沒這個", "也沒有"])).toBeNull();
  });

  it("音訊軌片段走樣本換算；結尾收在幀中間時要含到那一幀", () => {
    // 48000 Hz / 30 fps = 1600 樣本一幀。3200..8000 = 幀 2 起、到幀 4 的中間
    const s = seqOf([vclip("clip-1", "m1", 0, 100)], [lane("lane-1", "music", [aclip("a1", "a-music", 3200, 4800)])], FPS30);
    expect(selectionSpan(s, ["a1"])).toEqual({ in: 2, out: 5 });
  });

  it("V1 與音訊混選 → 兩種時間軸換算後取聯集", () => {
    const s = seqOf([vclip("clip-1", "m1", 0, 100)], [lane("lane-1", "music", [aclip("a1", "a-music", 3200, 4800)])], FPS30);
    expect(selectionSpan(s, ["clip-1", "a1"])).toEqual({ in: 0, out: 100 });
  });

  it("音訊排到序列長度之後 → 夾在序列長度內（沒有畫面的那段播了也沒意義）", () => {
    // 序列只有 10 幀 = 16000 樣本；音訊排到 48000 樣本（幀 30）
    const s = seqOf([vclip("clip-1", "m1", 0, 10)], [lane("lane-1", "music", [aclip("a1", "a-music", 0, 48000)])], FPS30);
    expect(selectionSpan(s, ["a1"])).toEqual({ in: 0, out: 10 });
  });

  it("長度 0 的音訊片段不算", () => {
    const s = seqOf([vclip("clip-1", "m1", 0, 100)], [lane("lane-1", "music", [aclip("a1", "a-music", 3200, 0)])], FPS30);
    expect(selectionSpan(s, ["a1"])).toBeNull();
  });
});
