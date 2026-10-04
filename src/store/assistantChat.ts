import { create } from "zustand";
import { api, errMessage, listenClaudeStream, type AgentBackend, type ClaudeStreamEvent } from "../api";

/**
 * CLI 後端（claude / codex）的助手對話：送出 → `claude-stream` 事件逐步長出回覆、工具列、結果。
 *
 * HTTP 後端不走這裡（面板自己的「計畫 → 按執行」流程）。這裡的模型是**直接呼叫工具**的（經 App 的 MCP server），
 * 會改東西的那幾步由 store/mcpApprovals.ts 一步問一次人。
 *
 * 多輪：claude 用 session id（`--resume`）、codex 用 thread id（`exec resume`）。兩者不通用，
 * 所以 session 記著是哪個後端開的，換後端就從新對話開始。對話紀錄存在 localStorage（只是本機的方便，不是資料）。
 */
export interface ToolRow {
  /** 工具名（已去掉 `mcp__aivc__` 前綴）。 */
  name: string;
  result?: string;
  error?: boolean;
}

export interface ChatMsg {
  id: string;
  role: "user" | "assistant";
  text: string;
  tools: ToolRow[];
  error?: string;
  durationMs?: number;
}

type CliBackend = Exclude<AgentBackend, "http">;

interface ChatState {
  messages: ChatMsg[];
  sessionId: string | null;
  /** sessionId 是哪個後端開的。 */
  sessionBackend: CliBackend | null;
  busy: boolean;
  reqId: string | null;
}

interface ChatStore extends ChatState {
  /** 送出一句話。`systemPrompt` 每輪都送（裡面有這一刻的播放線、範圍…）。 */
  send: (backend: CliBackend, prompt: string, systemPrompt: string) => Promise<void>;
  cancel: () => Promise<void>;
  /** 清空＝新對話（不再 resume）。 */
  clear: () => void;
}

const STORAGE_KEY = "aivc:assistantChat";
const MAX_MSGS = 60;

/** `mcp__aivc__seek_to` → `seek_to`；別的（ToolSearch、shell: …）原樣。 */
export function toolNameOf(raw: string): string {
  const m = /^mcp__[^_]+(?:_[^_]+)*?__(.+)$/.exec(raw);
  return m ? m[1] : raw;
}

/** 一個串流事件套到最後一則助手訊息上（純函式，可測）。 */
export function applyEvent(m: ChatMsg, ev: ClaudeStreamEvent): ChatMsg {
  switch (ev.kind) {
    case "text":
      return { ...m, text: m.text + (ev.text ?? "") };
    case "tool":
      return { ...m, tools: [...m.tools, { name: toolNameOf(ev.tool ?? "tool") }] };
    case "tool_result": {
      // 先開始的先配：一次呼叫好幾支（平行工具呼叫）時，結果照呼叫的順序回來
      const tools = m.tools.slice();
      const i = tools.findIndex((x) => x.result === undefined);
      if (i >= 0) tools[i] = { ...tools[i], result: ev.text ?? "", error: ev.is_error ?? false };
      return { ...m, tools };
    }
    case "result":
      return {
        ...m,
        // 沒有串流文字（codex 只在最後給整段、或 claude 沒有 partial）時用 result 的文字
        text: m.text.trim() ? m.text : (ev.text ?? ""),
        durationMs: ev.duration_ms,
        error: ev.is_error ? (ev.text || m.error || "錯誤") : m.error,
      };
    case "error":
      return { ...m, error: ev.text || "錯誤" };
    default:
      return m;
  }
}

function load(): Pick<ChatState, "messages" | "sessionId" | "sessionBackend"> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<ChatState>;
      const backend = v.sessionBackend === "claude-cli" || v.sessionBackend === "codex-cli" ? v.sessionBackend : null;
      return { messages: Array.isArray(v.messages) ? v.messages.slice(-MAX_MSGS) : [], sessionId: typeof v.sessionId === "string" ? v.sessionId : null, sessionBackend: backend };
    }
  } catch {
    /* 私密視窗 / 測試環境沒有 localStorage */
  }
  return { messages: [], sessionId: null, sessionBackend: null };
}

function persist(s: Pick<ChatState, "messages" | "sessionId" | "sessionBackend">) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ messages: s.messages.slice(-MAX_MSGS), sessionId: s.sessionId, sessionBackend: s.sessionBackend }));
  } catch {
    /* 存不了就只在這次執行有效 */
  }
}

let listening: Promise<unknown> | null = null;
/** 最近一次送出（resume 失敗時丟掉 session 重送一次用）。 */
let last: { backend: CliBackend; prompt: string; systemPrompt: string; retried: boolean } | null = null;

export const useAssistantChat = create<ChatStore>((set, get) => {
  const patchLast = (fn: (m: ChatMsg) => ChatMsg) =>
    set((s) => {
      const msgs = s.messages.slice();
      const i = msgs.length - 1;
      if (i >= 0 && msgs[i].role === "assistant") msgs[i] = fn(msgs[i]);
      return { messages: msgs };
    });

  const onEvent = (ev: ClaudeStreamEvent) => {
    if (ev.req_id !== get().reqId) return;
    if ((ev.kind === "system" || ev.kind === "result") && ev.session_id) set({ sessionId: ev.session_id });
    if (ev.kind !== "done") return patchLast((m) => applyEvent(m, ev));
    const lastMsg = get().messages[get().messages.length - 1];
    const failed = !!lastMsg?.error && !lastMsg.text.trim();
    const resumed = !!get().sessionId;
    set({ busy: false, reqId: null });
    // 帶著 session 接續卻整輪失敗（session 過期、換過模型）→ 丟掉 session 重送一次
    if (failed && resumed && last && !last.retried) {
      const again = { ...last, retried: true };
      set((s) => ({ sessionId: null, sessionBackend: null, messages: s.messages.slice(0, -2) }));
      last = again;
      void get().send(again.backend, again.prompt, again.systemPrompt);
      return;
    }
    if (failed && resumed) set({ sessionId: null, sessionBackend: null });
    persist(get());
  };

  return {
    ...load(),
    busy: false,
    reqId: null,
    send: async (backend, prompt, systemPrompt) => {
      const text = prompt.trim();
      if (!text || get().busy) return;
      listening ??= listenClaudeStream(onEvent).catch(() => (listening = null));
      await listening;
      const reqId = `req-${Date.now().toString(36)}`;
      const keep = last?.retried && last.prompt === text;
      last = { backend, prompt: text, systemPrompt, retried: !!keep };
      // 換了後端：claude 的 session 跟 codex 的 thread 不通用
      if (get().sessionBackend && get().sessionBackend !== backend) set({ sessionId: null, sessionBackend: null });
      set((s) => ({
        busy: true,
        reqId,
        sessionBackend: backend,
        messages: [
          ...s.messages,
          { id: `${reqId}-u`, role: "user" as const, text, tools: [] },
          { id: `${reqId}-a`, role: "assistant" as const, text: "", tools: [] },
        ].slice(-MAX_MSGS),
      }));
      const sid = get().sessionId;
      try {
        if (backend === "codex-cli") await api.codexSend(reqId, text, sid, null, systemPrompt);
        else await api.claudeSend(reqId, text, sid, null, systemPrompt);
      } catch (e) {
        patchLast((m) => ({ ...m, error: errMessage(e) }));
        set({ busy: false, reqId: null });
        persist(get());
      }
    },
    cancel: async () => {
      const id = get().reqId;
      if (!id) return;
      await api.claudeCancel(id).catch(() => {});
      patchLast((m) => ({ ...m, error: m.error ?? "已取消" }));
      set({ busy: false, reqId: null });
      persist(get());
    },
    clear: () => {
      last = null;
      set({ messages: [], sessionId: null, sessionBackend: null });
      persist(get());
    },
  };
});
