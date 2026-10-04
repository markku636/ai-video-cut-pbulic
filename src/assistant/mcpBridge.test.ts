// 工具表 → MCP 工具定義，以及 MCP 工具呼叫的執行路徑（參數檢查、沒開影片、會改東西的要人按、結果帶圖）。
import { describe, expect, it, vi } from "vitest";
import type { ExecDeps } from "./mcpBridge";
import type { RunContext } from "./run";

// mcpBridge 會 import api（Tauri）與指令登記表；這裡只測純函式與注入過依賴的執行路徑，Tauri 全部 stub
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const { TOOLS, toolByName } = await import("./catalogue");
const { DANGER_TIMEOUT_SECS, LONG_TIMEOUT_SECS, executeMcpTool, mcpResultOf, toolDef, toolDefs } = await import("./mcpBridge");
const { APPROVAL_TIMEOUT_MS } = await import("../store/mcpApprovals");
type Deps = ExecDeps;

const ctx: RunContext = { mediaId: "m1", video: "D:\\v\\a.mp4", fps: { num: 24, den: 1 }, frames: 240, cacheDir: "D:\\cache\\media\\ab", sam: "small", outDir: null };

function deps(over: Partial<Deps> = {}): Deps & { calls: { approve: number; run: number } } {
  const calls = { approve: 0, run: 0 };
  return {
    calls,
    context: async () => ctx,
    approve: async () => {
      calls.approve++;
      return true;
    },
    run: async () => {
      calls.run++;
      return { ok: true, message: "好了" };
    },
    enabledOf: () => ({ ok: true }),
    ...over,
  };
}

describe("toolDef（工具表 → MCP inputSchema）", () => {
  it("參數變成 JSON Schema：型別、說明、必填、列舉、上下限，不收多餘的鍵", () => {
    const d = toolDef(toolByName("auto_reframe")!);
    const schema = d.inputSchema as { type: string; properties: Record<string, Record<string, unknown>>; required?: string[]; additionalProperties: boolean };
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["aspect"]);
    expect(schema.properties.aspect).toMatchObject({ type: "string", enum: ["9:16", "1:1", "4:5", "16:9"] });
    const blur = toolDef(toolByName("blur_background")!).inputSchema as { properties: Record<string, Record<string, unknown>> };
    expect(blur.properties.strength).toMatchObject({ type: "number", minimum: 0.1, maximum: 8 });
  });

  it("沒有參數的工具不送空的 required", () => {
    const s = toolDef(toolByName("list_shots")!).inputSchema;
    expect(s).toEqual({ type: "object", properties: {}, additionalProperties: false });
  });

  it("會改東西的工具在說明裡講清楚 App 會先問人，逾時夠人按", () => {
    const d = toolDef(toolByName("cut_range")!);
    expect(d.description).toContain("App 會先問使用者");
    expect(d.timeoutSecs).toBe(DANGER_TIMEOUT_SECS);
    expect(DANGER_TIMEOUT_SECS * 1000).toBeGreaterThan(APPROVAL_TIMEOUT_MS);
    expect(toolDef(toolByName("seek_to")!).timeoutSecs).toBeUndefined();
  });

  it("追蹤、輸出這類長工作給長逾時（預設 60 秒會在 job 跑完前就放棄）", () => {
    expect(toolDef(toolByName("track_subject")!).timeoutSecs).toBe(LONG_TIMEOUT_SECS);
    expect(toolDef(toolByName("apply_reframe")!).timeoutSecs).toBe(LONG_TIMEOUT_SECS);
  });

  it("整份工具表都登記、名字不重複", () => {
    const defs = toolDefs();
    expect(defs).toHaveLength(TOOLS.length);
    expect(new Set(defs.map((d) => d.name)).size).toBe(defs.length);
    for (const d of defs) expect(d.name).toMatch(/^[a-z_]+$/);
  });
});

describe("executeMcpTool（MCP 工具呼叫的執行路徑）", () => {
  it("不認得的工具、缺參數、型別錯：丟人話錯誤，什麼都不跑", async () => {
    const d = deps();
    await expect(executeMcpTool("fade_in", {}, d)).rejects.toThrow("不認得這個工具");
    await expect(executeMcpTool("set_range", { start_seconds: 1 }, d)).rejects.toThrow("少了 end_seconds");
    await expect(executeMcpTool("seek_to", { seconds: "abc" }, d)).rejects.toThrow("seconds 要是數字");
    expect(d.calls.run).toBe(0);
  });

  it("沒有開啟的影片：直接回原因，不跳確認", async () => {
    const d = deps({ context: async () => null });
    await expect(executeMcpTool("cut_range", {}, d)).rejects.toThrow("沒有開啟的影片");
    expect(d.calls.approve).toBe(0);
  });

  it("會改東西的工具要人按；拒絕就不跑，而且叫模型不要重試", async () => {
    const d = deps({ approve: async () => false });
    await expect(executeMcpTool("cut_range", {}, d)).rejects.toThrow("不要重試");
    expect(d.calls.run).toBe(0);
    const ok = deps();
    await expect(executeMcpTool("cut_range", {}, ok)).resolves.toMatchObject({ ok: true, message: "好了" });
    expect(ok.calls).toEqual({ approve: 1, run: 1 });
  });

  it("只查不動的工具不問人", async () => {
    const d = deps();
    await executeMcpTool("list_shots", {}, d);
    await executeMcpTool("seek_to", { seconds: 3 }, d);
    expect(d.calls).toEqual({ approve: 0, run: 2 });
  });

  it("指令現在不能按（runStep 回 ok:false）→ 錯誤，原因原樣給模型", async () => {
    const d = deps({ run: async () => ({ ok: false, message: "先用 I / O 標一段範圍" }) });
    await expect(executeMcpTool("play_range", {}, d)).rejects.toThrow("先用 I / O 標一段範圍");
  });

  it("參數不是物件（null、陣列）當成沒給", async () => {
    const d = deps();
    await expect(executeMcpTool("list_shots", null, d)).resolves.toMatchObject({ ok: true });
    await expect(executeMcpTool("list_shots", [1, 2], d)).resolves.toMatchObject({ ok: true });
  });
});

describe("mcpResultOf（回給模型的結果）", () => {
  it("view_frame 的圖放進 images（Rust 讀成 image block），事實摘要也附上", () => {
    const step = { tool: toolByName("view_frame")!, args: { frame: 12 }, problem: null };
    const r = mcpResultOf(step, { ok: true, message: "k=12", data: { frame: 12, grid: true, sourceSize: [1920, 1080], images: ["D:\\cache\\f.png", 7] } });
    expect(r.images).toEqual(["D:\\cache\\f.png"]);
    expect(String(r.facts)).toContain("1920×1080");
    expect(String(r.facts)).toContain("0–1000");
  });

  it("沒有圖就不帶 images；模型多給的參數講一聲", () => {
    const step = { tool: toolByName("list_shots")!, args: {}, problem: null, unused: "fade" };
    const r = mcpResultOf(step, { ok: true, message: "3 個鏡頭", data: { spans: [] } });
    expect(r).not.toHaveProperty("images");
    expect(r.ignoredArgs).toBe("fade");
  });
});
