import { describe, expect, it } from "vitest";
import type { CaptionTrackV1, ShotV1 } from "../project/format";
import { describeHits, describeShots, looseText, searchTranscript, shotSpans } from "./transcript";

const FPS = { num: 30, den: 1 };

function cue(id: string, k0: number, k1: number, ...words: string[]) {
  const step = (k1 - k0) / Math.max(1, words.length);
  return { id, startFrame: k0, endFrame: k1, words: words.map((w, i) => ({ text: w, startFrame: Math.round(k0 + i * step), endFrame: Math.round(k0 + (i + 1) * step) })) };
}

const TRACK = {
  cues: [cue("c0", 0, 150, "大家好", "今天", "來聊", "百家姓"), cue("c1", 150, 600, "規則", "很簡單，", "比大小"), cue("c2", 900, 1200, "Hello", "World", "again")],
} as unknown as CaptionTrackV1;

describe("looseText", () => {
  it("去空白與標點、英文小寫", () => {
    expect(looseText("呃， Hello　World！")).toBe("呃helloworld");
  });
});

describe("searchTranscript", () => {
  it("找到就回秒數與那一句", () => {
    const hits = searchTranscript(TRACK, "百家姓", FPS);
    expect(hits).toEqual([{ cueId: "c0", start: 0, end: 5, text: "大家好今天來聊百家姓" }]);
  });

  it("標點與大小寫不影響", () => {
    expect(searchTranscript(TRACK, "很簡單 比大小", FPS)[0]?.cueId).toBe("c1");
    expect(searchTranscript(TRACK, "hello world", FPS)[0]?.cueId).toBe("c2");
  });

  it("沒有字幕 / 空查詢 / 沒找到都回空陣列", () => {
    expect(searchTranscript(null, "x", FPS)).toEqual([]);
    expect(searchTranscript(TRACK, "  ", FPS)).toEqual([]);
    expect(searchTranscript(TRACK, "不存在的話", FPS)).toEqual([]);
  });

  it("最多 limit 個", () => {
    const many = { cues: Array.from({ length: 10 }, (_, i) => cue(`c${i}`, i * 30, i * 30 + 30, "同一句")) } as unknown as CaptionTrackV1;
    expect(searchTranscript(many, "同一句", FPS, 3)).toHaveLength(3);
  });
});

describe("shotSpans / describe*", () => {
  const shots = [
    { id: "s2", startFrame: 60, endFrame: 300, kind: "wide", source: "auto" },
    { id: "s1", startFrame: 0, endFrame: 60, kind: "close", source: "auto" },
  ] as unknown as ShotV1[];

  it("依時間排序、1-based", () => {
    expect(shotSpans(shots, FPS)).toEqual([
      { index: 1, start: 0, end: 2 },
      { index: 2, start: 2, end: 10 },
    ]);
  });

  it("回報句只講秒數與那一句", () => {
    expect(describeHits(searchTranscript(TRACK, "規則", FPS), 1)).toBe("找到 1 處：5.0–20.0 秒「規則很簡單，比大小」");
    expect(describeHits([], 0)).toContain("沒有找到");
    expect(describeHits(searchTranscript(TRACK, "規則", FPS), 9)).toContain("共 9 處，只列前 1");
    expect(describeShots(shotSpans(shots, FPS))).toBe("2 個鏡頭：鏡頭 1：0.0–2.0 秒；鏡頭 2：2.0–10.0 秒");
    expect(describeShots([])).toContain("沒有偵測到");
  });
});
