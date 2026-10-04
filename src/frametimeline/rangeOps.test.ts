import { describe, expect, it, vi } from "vitest";

// rangeOps 會 import pipeline（→ api → Tauri）；這裡只測純函式，Tauri 呼叫全部 stub
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const { pickRangePrompt, segRangeArgs, trackRangeSpan } = await import("./rangeOps");

const shots = [
  { id: "shot1", startFrame: 0, endFrame: 60 },
  { id: "shot2", startFrame: 60, endFrame: 926 },
];
const pt = (frame: number, n = 1) => ({ frame, points: Array.from({ length: n }, (_, i) => ({ x: 10 + i, y: 20, label: (i % 2) as 0 | 1 })) });

describe("rangeOps：範圍 ∩ 鏡頭", () => {
  it("取交集；沒有範圍 / 沒有鏡頭 / 不重疊 → null", () => {
    expect(trackRangeSpan({ shotId: "shot2" }, shots, { in: 28, out: 100 })).toEqual({ in: 60, out: 100 });
    expect(trackRangeSpan({ shotId: "shot2" }, shots, { in: 840, out: 2000 })).toEqual({ in: 840, out: 926 });
    expect(trackRangeSpan({ shotId: "shot1" }, shots, { in: 60, out: 100 })).toBeNull();
    expect(trackRangeSpan({ shotId: "shot2" }, shots, null)).toBeNull();
    expect(trackRangeSpan({ shotId: "gone" }, shots, { in: 0, out: 100 })).toBeNull();
  });
});

describe("rangeOps：挑提示幀（seg.run 要所有提示在同一幀、錨定幀在 --frames 內）", () => {
  const span = { in: 840, out: 910 };

  it("播放線那幀有提示且在範圍內 → 用它", () => {
    expect(pickRangePrompt([pt(850), pt(870)], span, 870)?.frame).toBe(870);
  });

  it("否則取範圍內離播放線最近的；等距取較早的", () => {
    expect(pickRangePrompt([pt(100), pt(850), pt(900)], span, 880)?.frame).toBe(900);
    expect(pickRangePrompt([pt(850), pt(870)], span, 860)?.frame).toBe(850);
    // 播放線在範圍外也照樣挑範圍內的
    expect(pickRangePrompt([pt(100), pt(845)], span, 5)?.frame).toBe(845);
  });

  it("範圍內沒有提示（或提示是空的）→ null；out 本身不算範圍內", () => {
    expect(pickRangePrompt([pt(100), pt(910)], span, 880)).toBeNull();
    expect(pickRangePrompt([{ frame: 850, points: [] }], span, 850)).toBeNull();
    expect(pickRangePrompt([], span, 850)).toBeNull();
  });
});

describe("rangeOps：seg.run args", () => {
  it("frames = 區間、anchor = 提示幀、point 格式同 propagateMasks、雙向", () => {
    const args = segRangeArgs({ video: "D:/v.webm", span: { in: 840, out: 910 }, prompt: pt(850, 2), out: "C:/cache/tracks/t1/seg", sam: "" });
    expect(args).toEqual({
      video: "D:/v.webm",
      frames: "840:910",
      point: ["850:10,20:reduce", "850:11,20:add"],
      anchor: 850,
      dir: "both",
      out: "C:/cache/tracks/t1/seg",
      sam: "small",
      previews: 0,
    });
  });
});
