import { describe, expect, it, vi } from "vitest";

// 這個對話框會 import pipeline（→ api → Tauri）；只驗數字欄位的退路，Tauri 呼叫全部 stub
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const { num } = await import("./RemoveSilenceDialog");

describe("移除靜音：數字欄位的退路", () => {
  it("正常的值直接用（含負數與小數 —— 門檻是 dBFS，本來就是負的）", () => {
    expect(num("-40", -1)).toBe(-40);
    expect(num("0.5", -1)).toBe(0.5);
    expect(num("500", 0)).toBe(500);
  });

  it("空字串、亂打的字、Infinity 一律退回預設值", () => {
    // 回 NaN 的話門檻比較全部變 false，畫面只會說「沒有找到靜音」，使用者不會知道是自己打錯
    expect(num("", -40)).toBe(-40);
    expect(num("abc", -40)).toBe(-40);
    expect(num("--3", -40)).toBe(-40);
    expect(num("Infinity", -40)).toBe(-40);
    expect(num("NaN", -40)).toBe(-40);
  });
});
