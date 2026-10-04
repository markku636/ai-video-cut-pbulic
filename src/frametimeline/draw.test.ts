import { describe, expect, it } from "vitest";
import type { SolveFrame } from "../store/solves";
import { IDENTITY_H } from "../video/quad";
import { layoutRows, ROW, rulerTicks, solvedRuns, THUMB_TILE, thumbSampleFrames, tickStep, tileStartOf } from "./draw";

const f = (k: number, conf: number, state: 0 | 1 | 2 | 3 = 1): SolveFrame => ({ k, h: IDENTITY_H, conf, state });

describe("frametimeline/draw：版面", () => {
  it("每 track 兩列（解算 + 使用者）疊在尺規 / 範圍列 / 鏡頭帶 / 縮圖列之下", () => {
    const L = layoutRows(["a", "b"]);
    expect(L.rulerY).toBe(0);
    // 範圍列夾在尺規與鏡頭帶之間：尺規拖曳是 scrub、範圍列拖曳是選範圍，兩個手勢不共用同一塊
    expect(L.rangeY).toBe(ROW.ruler);
    expect(L.rangeH).toBe(ROW.range);
    expect(L.shotsY).toBe(ROW.ruler + ROW.range);
    expect(L.thumbsY).toBe(ROW.ruler + ROW.range + ROW.shots);
    expect(L.tracksY).toBe(ROW.ruler + ROW.range + ROW.shots + ROW.thumbs + ROW.gap);
    expect(L.rows).toHaveLength(2);
    expect(L.rows[0].solvedY).toBe(L.tracksY);
    expect(L.rows[0].userY).toBe(L.tracksY + ROW.solved);
    expect(L.rows[1].y).toBe(L.rows[0].y + L.rows[0].h + ROW.gap);
    expect(L.height).toBe(L.rows[1].y + L.rows[1].h + ROW.gap);
  });

  it("沒有縮圖列時高度縮掉", () => {
    const L = layoutRows([], { thumbs: false });
    expect(L.thumbsH).toBe(0);
    expect(L.tracksY).toBe(ROW.ruler + ROW.range + ROW.shots + ROW.gap);
  });
});

describe("frametimeline/draw：尺規", () => {
  it("主刻度間距 ≥ 90 px；放大到每幀 64 px 時逐 2 幀標", () => {
    const fps = { num: 30000, den: 1001 };
    expect(tickStep(64, fps).major).toBe(2);
    // 整段適配 1762 幀 / 1200 px ≈ 0.68 px/幀 → 5 秒 = 150 幀 ≈ 102 px
    expect(tickStep(0.68, fps).major).toBe(150);
    expect(tickStep(0.68, fps).minor).toBe(30);
    // 太小的次刻度（< 5 px）就沒有次刻度
    const s = tickStep(0.05, fps);
    expect(s.minor * 0.05).toBeGreaterThanOrEqual(5);
  });

  it("rulerTicks 只回可視範圍附近、對齊間距、不超過總幀數", () => {
    const fps = { num: 30, den: 1 };
    const r = rulerTicks(100, 4, 400, fps, 1000); // 可視 100..200 幀（多一個 minor 的餘裕到 206）；major 30 幀=120px, minor 6 幀
    expect(r.step).toEqual({ major: 30, minor: 6 });
    expect(r.major).toEqual([120, 150, 180]);
    expect(r.minor[0]).toBe(96);
    expect(r.minor.every((x) => x % 6 === 0 && x % 30 !== 0)).toBe(true);
    const tail = rulerTicks(990, 4, 400, fps, 1000);
    expect(Math.max(...tail.major, ...tail.minor)).toBeLessThanOrEqual(1000);
  });
});

describe("frametimeline/draw：解算信心帶", () => {
  it("同色連續幀合成一段、k 不連續就斷開、只回可視範圍", () => {
    const frames = [f(0, 0.9), f(1, 0.95), f(2, 0.5), f(3, 0.4), f(5, 0.4), f(6, 0.1), f(7, 0.9, 3)];
    const runs = solvedRuns(frames, 0, 10, 1000);
    expect(runs).toEqual([
      { x0: 0, x1: 20, band: "good" },
      { x0: 20, x1: 40, band: "warn" },
      { x0: 50, x1: 60, band: "warn" }, // k=4 缺 → 斷開
      { x0: 60, x1: 80, band: "bad" }, // conf<0.35 與 state=3 都是 bad，連在一起
    ]);
    // 捲到 k=6：前面的段不在可視範圍（k=5 的 warn 段右緣剛好貼在 x=0，0 px 寬，不畫）
    const clipped = solvedRuns(frames, 6, 10, 100);
    expect(clipped).toEqual([{ x0: 0, x1: 20, band: "bad" }]);
    // 捲到 k=5.5：warn 段還露出 5 px，左緣夾成 -1
    expect(solvedRuns(frames, 5.5, 10, 100)[0]).toEqual({ x0: -1, x1: 5, band: "warn" });
  });
});

describe("frametimeline/draw：縮圖取樣", () => {
  it("tile 以 32 幀為界", () => {
    expect(tileStartOf(0)).toBe(0);
    expect(tileStartOf(31)).toBe(0);
    expect(tileStartOf(32)).toBe(32);
    expect(tileStartOf(1761)).toBe(Math.floor(1761 / THUMB_TILE) * THUMB_TILE);
  });

  it("每 step 幀一張、對齊 step 倍數、不超出畫面與總幀", () => {
    // thumbW 78 / 0.68 px/幀 → step 115
    const frames = thumbSampleFrames(0, 0.68, 1200, 78, 1762);
    expect(frames[0]).toBe(0);
    expect(frames[1]).toBe(115);
    expect(frames.every((x) => x % 115 === 0)).toBe(true);
    expect(frames[frames.length - 1]).toBeLessThan(1762);
    expect(frames.length).toBe(Math.ceil(1762 / 115));
    // 放大到 10 px/幀：step = 8，捲到 100 → 從 96 開始；120 落在 x=200（右緣外）不取
    const zoomed = thumbSampleFrames(100, 10, 200, 78, 1762);
    expect(zoomed[0]).toBe(96);
    expect(zoomed).toEqual([96, 104, 112]);
    expect(thumbSampleFrames(0, 0, 100, 78, 10)).toEqual([]);
  });
});
