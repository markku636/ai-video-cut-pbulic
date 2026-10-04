import { describe, expect, it, vi } from "vitest";

// Transport 會 import 指令表 / store（→ api → Tauri）；這裡只驗純函式，Tauri 呼叫全部 stub
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const { transportLayout, volumePopoverPos } = await import("./Transport");

describe("傳輸列版面（M1 驗收 M3：預設視窗寬度也調得到音量）", () => {
  it("預設視窗的影片欄約 760 px：列上放不下滑桿（音量改成滑過靜音鈕彈出）；夠寬才放回列上", () => {
    // VolumeControl 的 slider 參數就是 layout.fine：false = 彈出框模式
    expect(transportLayout(760).fine).toBe(false);
    expect(transportLayout(1199).fine).toBe(false);
    expect(transportLayout(1200).fine).toBe(true);
  });
});

describe("volumePopoverPos：音量彈出框貼在靜音鈕正上方", () => {
  const size = { width: 150, height: 44 };

  it("水平置中、下緣貼齊按鈕上緣（透明 padding 當橋，滑鼠往上移不會先離開）", () => {
    expect(volumePopoverPos({ left: 500, top: 600, width: 28 }, size, 1360)).toEqual({ left: 500 + 14 - 75, top: 556 });
  });

  it("靠視窗右緣（⋯ 貼邊、側欄收起）往左收；靠左緣往右收；不會跑出視窗上緣", () => {
    expect(volumePopoverPos({ left: 1330, top: 600, width: 28 }, size, 1360)).toEqual({ left: 1360 - 150 - 4, top: 556 });
    expect(volumePopoverPos({ left: 0, top: 600, width: 28 }, size, 1360)).toEqual({ left: 4, top: 556 });
    expect(volumePopoverPos({ left: 500, top: 20, width: 28 }, size, 1360).top).toBe(4);
  });
});
