// 「用文字找要移除的東西」的純函式：在哪一幀找、挑哪幾個框、遮罩寫哪。
import { describe, expect, it } from "vitest";
import { anchorFrame, boxArgs, maskDirFor, MAX_REMOVE_OBJECTS, type TextBoxHit } from "./removeObject";

const hit = (score: number, box: [number, number, number, number] = [10.4, 20.6, 30, 40]): TextBoxHit => ({ box, phrase: "hand", score });

describe("anchorFrame", () => {
  it("取範圍的中點，不是第一幀", () => {
    // 開頭常常是淡入、還沒入鏡、或鏡頭還在動，在那裡找不到東西的機率高得多
    expect(anchorFrame({ in: 100, out: 200 }, 500)).toBe(150);
  });

  it("沒有範圍就取整支的中點", () => {
    expect(anchorFrame(null, 200)).toBe(100);
  });

  it("永遠落在範圍內（含頭、不含尾）", () => {
    expect(anchorFrame({ in: 10, out: 11 }, 500)).toBe(10);
    expect(anchorFrame({ in: 0, out: 1 }, 500)).toBe(0);
  });

  it("幀數為 0 也不會回負的", () => {
    expect(anchorFrame(null, 0)).toBe(0);
  });
});

describe("boxArgs", () => {
  it("分數高的優先，座標取整", () => {
    expect(boxArgs([hit(0.3), hit(0.9, [1.2, 2.8, 3, 4])])).toEqual(["1,3,3,4", "10,21,30,40"]);
  });

  it("最多取 MAX_REMOVE_OBJECTS 個（SAM 逐幀傳播的時間與物件數成正比）", () => {
    const many = Array.from({ length: 8 }, (_, i) => hit(1 - i / 10));
    expect(boxArgs(many)).toHaveLength(MAX_REMOVE_OBJECTS);
  });

  it("上限至少是 1（傳 0 進來不該變成一個都不追）", () => {
    expect(boxArgs([hit(0.5)], 0)).toHaveLength(1);
  });

  it("不改動傳進來的陣列", () => {
    const hits = [hit(0.3), hit(0.9)];
    boxArgs(hits);
    expect(hits[0].score).toBe(0.3);
  });
});

describe("maskDirFor", () => {
  it("放在輸出影片旁邊", () => {
    expect(maskDirFor("D:\\a\\clip.aivc.clean.mp4")).toBe("D:\\a\\clip.aivc.clean.masks");
  });

  it("沒有副檔名也不會吃掉目錄名", () => {
    expect(maskDirFor("D:\\my.dir\\out")).toBe("D:\\my.dir\\out.masks");
  });
});
