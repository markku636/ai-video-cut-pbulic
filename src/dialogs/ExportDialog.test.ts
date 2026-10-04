import { describe, expect, it, vi } from "vitest";

// ExportDialog 會 import store / pipeline（→ api → Tauri）；這裡只驗開窗預設值的純函式，Tauri 呼叫全部 stub
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const { defaultOutPath, defaultTrim, initialQuality, parseQuality, revealPath } = await import("./ExportDialog");

describe("輸出對話框的開窗預設（M1 驗收 M1 / 規格 B9）", () => {
  it("帶著範圍開（輸出範圍、輸出這一幀、預覽此幀）預設只輸出那一段；整支輸出沒有裁切可言", () => {
    expect(defaultTrim({ in: 840, out: 910 })).toBe(true);
    expect(defaultTrim({ in: 12, out: 13 })).toBe(true);
    expect(defaultTrim(null)).toBe(false);
  });

  it("單幀預覽的預設檔名帶 f<幀號>，不會跟整支的成品同名互相覆蓋；範圍與整支沿用原本的檔名", () => {
    expect(defaultOutPath("D:\\v\\clip.webm", null, "webm", { in: 912, out: 913 })).toBe("D:\\v\\clip.aivc.f912.webm");
    expect(defaultOutPath("D:\\v\\clip.webm", null, "webm")).toBe("D:\\v\\clip.aivc.webm");
    expect(defaultOutPath("D:\\v\\clip.webm", null, "webm", { in: 840, out: 910 })).toBe("D:\\v\\clip.aivc.webm");
    // 設定了輸出資料夾、POSIX 路徑（macOS / Linux）
    expect(defaultOutPath("/Users/a/clip.mp4", "/Users/a/out", "mp4", { in: 0, out: 1 })).toBe("/Users/a/out/clip.aivc.f0.mp4");
  });
});

describe("品質開窗初值：存過的 0 不能被吃掉", () => {
  it("使用者存過無損（0）就用 0 —— `0 || 預設` 會把它換掉，這裡必須是 ??", () => {
    expect(initialQuality(0, 20)).toBe(0);
  });

  it("沒存過（null）才往下找預設；預設也沒有就用 16", () => {
    expect(initialQuality(null, 20)).toBe(20);
    expect(initialQuality(null, undefined)).toBe(16);
    expect(initialQuality(23, 20)).toBe(23);
  });
});

describe("品質欄位：空白 ≠ 0", () => {
  it("清空欄位算「沒指定」（呼叫端會送 null＝引擎預設），不是無損", () => {
    // Number("") 是 0，而 0 是合法的品質值（無損）→ 只用 isFinite 守會讓清空欄位變成大十幾倍的輸出
    expect(Number.isFinite(parseQuality(""))).toBe(false);
    expect(Number.isFinite(parseQuality("   "))).toBe(false);
    expect(Number.isFinite(parseQuality("abc"))).toBe(false);
  });

  it("真的打 0 就是 0（無損是使用者可以選的）；小數四捨五入", () => {
    expect(parseQuality("0")).toBe(0);
    expect(parseQuality("16")).toBe(16);
    expect(parseQuality("16.6")).toBe(17);
  });
});

describe("B-16：「顯示檔案」開的是真的輸出的那個檔", () => {
  it("有輸出過就開 r.out，欄位之後被改掉也不影響", () => {
    expect(revealPath("D:\\v\\clip.aivc.webm", "D:\\v\\改過的名字.webm")).toBe("D:\\v\\clip.aivc.webm");
  });

  it("還沒輸出過（null / 空字串）才退回欄位裡的路徑", () => {
    expect(revealPath(null, "D:\\v\\clip.aivc.webm")).toBe("D:\\v\\clip.aivc.webm");
    expect(revealPath("", "D:\\v\\clip.aivc.webm")).toBe("D:\\v\\clip.aivc.webm");
  });
});
