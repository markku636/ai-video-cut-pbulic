import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const { complementRanges, keepOnlyRanges, parseHighlightsResult } = await import("./highlights");
const { materialize, splitAt, rippleDelete } = await import("../sequence/ops");
const { durationFrames } = await import("../sequence/map");
const { MBIG } = await import("../sequence/testkit");

describe("parseHighlightsResult", () => {
  it("正常形狀；分數夾 1–10、壞的單筆丟掉", () => {
    const r = parseHighlightsResult({
      clips: [
        { startFrame: 900, endFrame: 1800, start: 30, end: 60, title: "a", reason: "r", score: 8, cps: 3.2 },
        { startFrame: 10, endFrame: 5, title: "倒過來" },
        { startFrame: "x", endFrame: 9 },
        { startFrame: 0, endFrame: 300, score: 99 },
      ],
      model: "m",
      warnings: ["w", 3],
    });
    expect(r.clips.map((c) => c.title)).toEqual(["a", ""]);
    expect(r.clips[1].score).toBe(10);
    expect(r).toMatchObject({ model: "m", warnings: ["w"] });
    expect(parseHighlightsResult(null).clips).toEqual([]);
  });
});

describe("complementRanges", () => {
  it("沒蓋到的部分", () => {
    expect(complementRanges([{ in: 30, out: 60 }, { in: 200, out: 250 }], 300)).toEqual([
      { in: 0, out: 30 },
      { in: 60, out: 200 },
      { in: 250, out: 300 },
    ]);
  });

  it("空的 = 整段；蓋滿 = 空；重疊先合併；超出總長截掉", () => {
    expect(complementRanges([], 300)).toEqual([{ in: 0, out: 300 }]);
    expect(complementRanges([{ in: 0, out: 300 }], 300)).toEqual([]);
    expect(complementRanges([{ in: 100, out: 200 }, { in: 150, out: 400 }], 300)).toEqual([{ in: 0, out: 100 }]);
  });
});

describe("keepOnlyRanges", () => {
  it("隱含序列：只剩兩段、順序照時間", () => {
    const seq = keepOnlyRanges(materialize(MBIG), "mbig", [{ in: 200, out: 250 }, { in: 30, out: 60 }]);
    const clips = seq.video.filter((v) => v.kind === "clip") as { srcIn: number; srcOut: number }[];
    expect(clips.map((c) => [c.srcIn, c.srcOut])).toEqual([
      [30, 60],
      [200, 250],
    ]);
    expect(durationFrames(seq)).toBe(80);
  });

  it("已經剪過的序列：範圍先對到序列座標再剪", () => {
    let seq = materialize(MBIG);
    seq = splitAt(seq, 100);
    seq = rippleDelete(seq, [seq.video[0].id]); // 剩來源 100–300
    const out = keepOnlyRanges(seq, "mbig", [{ in: 50, out: 150 }]); // 只有 100–150 還在序列上
    const clips = out.video.filter((v) => v.kind === "clip") as { srcIn: number; srcOut: number }[];
    expect(clips.map((c) => [c.srcIn, c.srcOut])).toEqual([[100, 150]]);
  });

  it("一段都對不到就原樣回傳", () => {
    const seq = materialize(MBIG);
    expect(keepOnlyRanges(seq, "other", [{ in: 0, out: 10 }])).toBe(seq);
  });
});
