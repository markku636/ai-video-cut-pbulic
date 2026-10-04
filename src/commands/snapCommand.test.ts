// view.toggleSnap（M2.13，§10.2 吸附 Shift+N）：綁鍵、勾選狀態跟著吸附開關、執行會切換並推一次指令 tick（選單勾勾才會更新）。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
const bump = vi.fn();
vi.mock("./registry", async (importOriginal) => ({ ...(await importOriginal<typeof import("./registry")>()), bumpCommandTick: () => bump() }));

const { coreCommands } = await import("./core");
const { useSnap } = await import("../frametimeline/trimDrag");
const { useUi } = await import("../ui");

const cmd = coreCommands().find((c) => c.id === "view.toggleSnap")!;

beforeEach(() => {
  useSnap.getState().setEnabled(true);
  bump.mockClear();
});

describe("view.toggleSnap", () => {
  it("在檢視 › 時間軸、綁 Shift+N（N 是新增追蹤）", () => {
    expect(cmd).toMatchObject({ group: "view", section: "時間軸", shortcuts: ["Shift+N"] });
    expect(cmd.enabled()).toEqual({ ok: true });
  });

  it("執行：切換吸附、勾選狀態跟著變、推指令 tick、toast 說開 / 關", () => {
    const toasts = () => useUi.getState().toasts.map((x) => x.text);
    expect(cmd.checked?.()).toBe(true);
    void cmd.run();
    expect(useSnap.getState().enabled).toBe(false);
    expect(cmd.checked?.()).toBe(false);
    expect(bump).toHaveBeenCalledTimes(1);
    expect(toasts()).toContain("吸附：關");
    void cmd.run();
    expect(useSnap.getState().enabled).toBe(true);
    expect(toasts()).toContain("吸附：開");
  });
});
