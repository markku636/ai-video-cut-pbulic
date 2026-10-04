import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const { formatSummaryText, formatYoutubeChapters, mmss, parseChaptersResult, sourceFrameToSequence } = await import("./chapters");
const { materialize, splitAt, rippleDelete } = await import("../sequence/ops");
const { MBIG } = await import("../sequence/testkit");

const FPS = { num: 30, den: 1 };

describe("parseChaptersResult", () => {
  it("正常形狀", () => {
    const r = parseChaptersResult({
      chapters: [{ frame: 900, seconds: 30, title: "策略" }, { frame: 0, seconds: 0, title: "開場" }],
      title: " T ",
      summary: "S",
      keywords: ["a", " ", 3, "b"],
      model: "m",
      warnings: ["w"],
    });
    // 依幀排序
    expect(r.chapters.map((c) => c.title)).toEqual(["開場", "策略"]);
    expect(r).toMatchObject({ title: "T", summary: "S", keywords: ["a", "b"], model: "m", warnings: ["w"] });
  });

  it("壞掉的單筆丟掉、整個形狀不對就是空", () => {
    expect(parseChaptersResult({ chapters: [{ frame: "x" }, null, { frame: 12.4, title: 5 }] }).chapters).toEqual([{ frame: 12, seconds: 0, title: "" }]);
    expect(parseChaptersResult(null).chapters).toEqual([]);
    expect(parseChaptersResult("x").keywords).toEqual([]);
  });
});

describe("YouTube 章節文字", () => {
  it("mmss", () => {
    expect(mmss(0)).toBe("0:00");
    expect(mmss(65)).toBe("1:05");
    expect(mmss(3661)).toBe("1:01:01");
    expect(mmss(59.6)).toBe("1:00");
  });

  it("用目前的幀與標題；沒標題用 —", () => {
    const text = formatYoutubeChapters([{ frame: 0, seconds: 0, title: "開場" }, { frame: 1950, seconds: 65, title: "" }], FPS);
    expect(text).toBe("0:00 開場\n1:05 —");
  });

  it("摘要文字：標題、摘要、hashtag；空的略過", () => {
    expect(formatSummaryText({ title: "T", summary: "S", keywords: ["百 家姓", "x"] })).toBe("T\n\nS\n\n#百家姓 #x");
    expect(formatSummaryText({ title: "", summary: "S", keywords: [] })).toBe("S");
  });
});

describe("sourceFrameToSequence", () => {
  // MBIG：300 幀、id "mbig"
  it("隱含序列：來源幀 = 序列幀", () => {
    const seq = materialize(MBIG);
    expect(sourceFrameToSequence(seq, "mbig", 0)).toBe(0);
    expect(sourceFrameToSequence(seq, "mbig", 123)).toBe(123);
    expect(sourceFrameToSequence(seq, "mbig", 300)).toBeNull();
    expect(sourceFrameToSequence(seq, "other", 10)).toBeNull();
  });

  it("剪掉開頭之後序列幀往前移；落在剪掉的地方回 null", () => {
    let seq = materialize(MBIG);
    seq = splitAt(seq, 100);
    seq = rippleDelete(seq, [seq.video[0].id]);
    expect(sourceFrameToSequence(seq, "mbig", 50)).toBeNull();
    expect(sourceFrameToSequence(seq, "mbig", 100)).toBe(0);
    expect(sourceFrameToSequence(seq, "mbig", 250)).toBe(150);
  });
});
