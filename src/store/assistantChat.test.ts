// CLI 助手對話：串流事件怎麼長成一則回覆（純函式），與 resume / 換後端的 session 規則。
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn((..._args: unknown[]) => Promise.resolve(null));
let streamCb: ((ev: unknown) => void) | null = null;
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((name: string, cb: (e: { payload: unknown }) => void) => {
    if (name === "claude-stream") streamCb = (p) => cb({ payload: p });
    return Promise.resolve(() => {});
  }),
}));

const { applyEvent, toolNameOf, useAssistantChat } = await import("./assistantChat");
type Msg = Parameters<typeof applyEvent>[0];
const blank: Msg = { id: "a", role: "assistant", text: "", tools: [] };
const ev = (kind: string, extra: Record<string, unknown> = {}) => ({ req_id: "r", kind, ...extra }) as Parameters<typeof applyEvent>[1];

describe("toolNameOf", () => {
  it("去掉 mcp__aivc__ 前綴，其他原樣", () => {
    expect(toolNameOf("mcp__aivc__seek_to")).toBe("seek_to");
    expect(toolNameOf("mcp__aivc__view_frame")).toBe("view_frame");
    expect(toolNameOf("ToolSearch")).toBe("ToolSearch");
    expect(toolNameOf("shell: dir")).toBe("shell: dir");
  });
});

describe("applyEvent", () => {
  it("文字累加、工具列與結果配對、結果帶時間", () => {
    let m = blank;
    for (const e of [
      ev("text", { text: "好，" }),
      ev("tool", { tool: "mcp__aivc__seek_to" }),
      ev("tool", { tool: "mcp__aivc__cut_range" }),
      ev("tool_result", { text: "播放線移到第 3 幀" }),
      ev("tool_result", { text: "使用者沒有允許", is_error: true }),
      ev("text", { text: "剪好了" }),
      ev("result", { text: "好，剪好了", duration_ms: 1500, is_error: false }),
    ]) {
      m = applyEvent(m, e);
    }
    expect(m.text).toBe("好，剪好了");
    // 兩支一起呼叫（平行工具呼叫）、結果照呼叫順序回來：先開始的先配
    expect(m.tools).toEqual([
      { name: "seek_to", result: "播放線移到第 3 幀", error: false },
      { name: "cut_range", result: "使用者沒有允許", error: true },
    ]);
    expect(m.durationMs).toBe(1500);
    expect(m.error).toBeUndefined();
  });

  it("沒有串流文字（codex 只給整段）時用 result 的文字；失敗的 result 變錯誤", () => {
    expect(applyEvent(blank, ev("result", { text: "整段回覆", is_error: false })).text).toBe("整段回覆");
    const bad = applyEvent(blank, ev("result", { text: "usage limit", is_error: true }));
    expect(bad.error).toBe("usage limit");
    expect(applyEvent(blank, ev("error", { text: "codex 以結束碼 1 退出" })).error).toBe("codex 以結束碼 1 退出");
  });
});

describe("useAssistantChat", () => {
  beforeEach(() => {
    invoke.mockClear();
    // 上一個測試可能留著一輪沒收尾的（busy）
    useAssistantChat.setState({ busy: false, reqId: null });
    useAssistantChat.getState().clear();
  });

  it("送出走對的後端；session id 從事件拿到，下一輪帶著 resume", async () => {
    const st = useAssistantChat.getState();
    await st.send("claude-cli", "幫我剪", "系統");
    expect(invoke).toHaveBeenLastCalledWith("claude_send", expect.objectContaining({ prompt: "幫我剪", sessionId: null, systemPrompt: "系統" }));
    const req = useAssistantChat.getState().reqId!;
    streamCb!({ req_id: req, kind: "system", session_id: "S1" });
    streamCb!({ req_id: req, kind: "text", text: "好" });
    streamCb!({ req_id: "別人的", kind: "text", text: "不該出現" });
    streamCb!({ req_id: req, kind: "done", code: 0 });
    expect(useAssistantChat.getState().busy).toBe(false);
    const msgs = useAssistantChat.getState().messages;
    expect(msgs[msgs.length - 1].text).toBe("好");
    await useAssistantChat.getState().send("claude-cli", "再來", "系統");
    expect(invoke).toHaveBeenLastCalledWith("claude_send", expect.objectContaining({ sessionId: "S1" }));
  });

  it("換後端：claude 的 session 不帶給 codex", async () => {
    await useAssistantChat.getState().send("claude-cli", "一", "s");
    const req = useAssistantChat.getState().reqId!;
    streamCb!({ req_id: req, kind: "system", session_id: "S1" });
    streamCb!({ req_id: req, kind: "done", code: 0 });
    await useAssistantChat.getState().send("codex-cli", "二", "s");
    expect(invoke).toHaveBeenLastCalledWith("codex_send", expect.objectContaining({ sessionId: null }));
  });

  it("帶 session 接續卻整輪失敗 → 丟掉 session 重送一次（只一次）", async () => {
    await useAssistantChat.getState().send("claude-cli", "一", "s");
    let req = useAssistantChat.getState().reqId!;
    streamCb!({ req_id: req, kind: "system", session_id: "OLD" });
    streamCb!({ req_id: req, kind: "done", code: 0 });
    await useAssistantChat.getState().send("claude-cli", "二", "s");
    req = useAssistantChat.getState().reqId!;
    streamCb!({ req_id: req, kind: "error", text: "No conversation found" });
    streamCb!({ req_id: req, kind: "done", code: 1 });
    await vi.waitFor(() => expect(invoke).toHaveBeenLastCalledWith("claude_send", expect.objectContaining({ prompt: "二", sessionId: null })));
    // 重送的那一輪取代失敗的那一輪，不會留兩份「二」
    expect(useAssistantChat.getState().messages.filter((m) => m.role === "user" && m.text === "二")).toHaveLength(1);
  });
});
