import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const { estimateSeconds, parseVoices, ttsFileName } = await import("./tts");

describe("parseVoices", () => {
  it("引擎形狀 → 型別；沒 id 的丟掉、沒名字用 id", () => {
    expect(parseVoices({ speakers: [{ id: "v1", name: "小美", gender: "female", engine: "cosyvoice3" }, { id: "v2" }, { name: "沒 id" }, null] })).toEqual([
      { id: "v1", name: "小美", gender: "female", engine: "cosyvoice3" },
      { id: "v2", name: "v2", gender: null, engine: null },
    ]);
    expect(parseVoices(null)).toEqual([]);
  });
});

describe("estimateSeconds", () => {
  it("中文 4.5 字／秒、英文 2.5 詞／秒、語速倍率", () => {
    expect(estimateSeconds("一二三四五六七八九")).toBe(2);
    expect(estimateSeconds("one two three four five")).toBe(2);
    expect(estimateSeconds("一二三四五六七八九", 2)).toBe(1);
    expect(estimateSeconds("")).toBe(0);
  });
});

describe("ttsFileName", () => {
  it("時間戳＋副檔名", () => {
    expect(ttsFileName(1234)).toBe("vo-1234.wav");
    expect(ttsFileName(1234, "mp3")).toBe("vo-1234.mp3");
  });
});
