import { beforeEach, describe, expect, it, vi } from "vitest";

// ui.tsx 會 import Tauri 的檔案對話框；這裡只驗 toast store
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const { toast, useUi } = await import("./ui");

describe("B-16：toast 可以帶一顆動作按鈕（輸出完成 → 顯示檔案）", () => {
  beforeEach(() => {
    useUi.setState({ toasts: [] });
  });

  it("toast.success 的 opts 一路透傳到 store（以前第二個參數被丟掉）", () => {
    const onClick = vi.fn();
    toast.success("輸出完成：a.mp4（209 幀，8.1 秒）", { action: { label: "顯示檔案", onClick }, ttlMs: 8000 });
    const [n] = useUi.getState().toasts;
    expect(n.kind).toBe("success");
    expect(n.action?.label).toBe("顯示檔案");
    n.action?.onClick();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("error / info 也吃得到 opts；沒給 opts 時照舊沒有按鈕", () => {
    toast.error("壞了", { action: { label: "看日誌", onClick: () => {} } });
    toast.info("嗨");
    const [a, b] = useUi.getState().toasts;
    expect(a.action?.label).toBe("看日誌");
    expect(b.action).toBeUndefined();
  });
});
