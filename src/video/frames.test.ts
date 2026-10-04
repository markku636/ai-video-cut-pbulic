import { describe, expect, it } from "vitest";
import { clampFrame, frameDuration, frameOfMediaTime, mediaTimeOfFrame } from "./frames";

const F30 = { num: 30, den: 1 };
const F2997 = { num: 30000, den: 1001 };

describe("frames：30/1", () => {
  it("往返：每一幀 seek 到幀中央再讀回同一幀", () => {
    for (let k = 0; k < 2000; k++) expect(frameOfMediaTime(mediaTimeOfFrame(k, F30), F30)).toBe(k);
  });
  it("rVFC 的 mediaTime 落在幀邊界（k/fps）也要回 k，不能因浮點誤差變 k-1", () => {
    for (let k = 0; k < 2000; k++) expect(frameOfMediaTime(k / 30, F30)).toBe(k);
    // 1/30 * 30 在 IEEE 754 下不一定剛好是整數
    expect(frameOfMediaTime(0.1 * 3, F30)).toBe(9);
  });
  it("+0.5 幀偏移", () => {
    expect(mediaTimeOfFrame(0, F30)).toBeCloseTo(0.5 / 30, 12);
    expect(mediaTimeOfFrame(29, F30)).toBeCloseTo(29.5 / 30, 12);
  });
  it("負的 / 非有限時間回 0", () => {
    expect(frameOfMediaTime(-1, F30)).toBe(0);
    expect(frameOfMediaTime(Number.NaN, F30)).toBe(0);
  });
});

describe("frames：30000/1001", () => {
  it("往返 3000 幀", () => {
    for (let k = 0; k < 3000; k++) expect(frameOfMediaTime(mediaTimeOfFrame(k, F2997), F2997)).toBe(k);
  });
  it("邊界 k·1001/30000 也回 k", () => {
    for (let k = 0; k < 3000; k++) expect(frameOfMediaTime((k * 1001) / 30000, F2997)).toBe(k);
  });
  it("一幀長度", () => {
    expect(frameDuration(F2997)).toBeCloseTo(1001 / 30000, 12);
  });
});

describe("clampFrame", () => {
  it("夾在 [0, frames-1]", () => {
    expect(clampFrame(-3, 100)).toBe(0);
    expect(clampFrame(99.6, 100)).toBe(99);
    expect(clampFrame(150, 100)).toBe(99);
    expect(clampFrame(5, 0)).toBe(0);
  });
});
