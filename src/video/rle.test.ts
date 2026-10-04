import { describe, expect, it } from "vitest";
import { decodeCounts, encodeMask, maskArea, maskToRgba, rleToMask } from "./rle";

function rect(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = 1;
  return m;
}

describe("rle", () => {
  it("往返：矩形遮罩 encode → decode 逐位元相同", () => {
    const w = 13;
    const h = 7;
    const m = rect(w, h, 2, 1, 9, 5);
    const rle = encodeMask(m, w, h);
    expect(rle.size).toEqual([h, w]);
    expect(rleToMask(rle)).toEqual(m);
    expect(maskArea(rleToMask(rle))).toBe(7 * 4);
  });
  it("pycocotools 的已知向量：3×3 全 1 = counts 「09」（0 個 0、9 個 1）", () => {
    // pycocotools: encode(np.ones((3,3),order='F')) → {'size':[3,3],'counts':b'09'}
    expect(decodeCounts("09")).toEqual([0, 9]);
    expect(rleToMask({ size: [3, 3], counts: "09" })).toEqual(new Uint8Array(9).fill(1));
    expect(encodeMask(new Uint8Array(9).fill(1), 3, 3).counts).toBe("09");
  });
  it("column-major：左上角一個像素在 2×3（h=2,w=3）遮罩裡是 counts [0,1,5]", () => {
    // 像素 (x=0,y=0) 是 column-major 第 0 個；之後 5 個 0
    const m = new Uint8Array(6);
    m[0] = 1;
    const rle = encodeMask(m, 3, 2);
    expect(decodeCounts(rle.counts)).toEqual([0, 1, 5]);
    expect(rleToMask(rle)).toEqual(m);
  });
  it("(x=1,y=0) 在 h=2 的遮罩裡是 column-major 第 2 個（不是第 1 個）—— 弄反會變橫線", () => {
    const m = new Uint8Array(6);
    m[1] = 1; // row-major index 1 = (x=1,y=0)
    expect(decodeCounts(encodeMask(m, 3, 2).counts)).toEqual([2, 1, 3]);
  });
  it("差值編碎：第 3 個 run 起存差值，長 run 也對", () => {
    const w = 64;
    const h = 64;
    const m = rect(w, h, 10, 10, 50, 40);
    expect(rleToMask(encodeMask(m, w, h))).toEqual(m);
  });
  it("空遮罩與滿遮罩", () => {
    const empty = new Uint8Array(20);
    expect(rleToMask(encodeMask(empty, 5, 4))).toEqual(empty);
    const full = new Uint8Array(20).fill(1);
    expect(rleToMask(encodeMask(full, 5, 4))).toEqual(full);
  });
  it("超出 size 的 run 被截掉而不是越界寫入", () => {
    // 宣稱 2×2 但 counts 說有 10 個 1
    const m = rleToMask({ size: [2, 2], counts: encodeMask(new Uint8Array(10).fill(1), 5, 2).counts });
    expect(m.length).toBe(4);
    expect(maskArea(m)).toBe(4);
  });
  it("maskToRgba 只填 1 的像素", () => {
    const rgba = maskToRgba(new Uint8Array([1, 0]), [10, 20, 30], 0.5);
    expect([...rgba.slice(0, 4)]).toEqual([10, 20, 30, 128]);
    expect([...rgba.slice(4, 8)]).toEqual([0, 0, 0, 0]);
  });
});
