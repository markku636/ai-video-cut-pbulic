/**
 * AI 助手的後端選擇（設定 `agent_backend`）。
 *
 * - `http`：既有的路線 —— 引擎 `assistant.chat` 打設定裡的 LLM 端點（本機 LM Studio / Ollama，或 Claude API），
 *   模型給一份 JSON 計畫、人按「執行」。舊使用者升級上來就是這個。
 * - `claude-cli` / `codex-cli`：本機的 Claude Code / Codex CLI，用使用者自己的訂閱登入；
 *   經 App 內建的 MCP server（src-tauri/src/mcp.rs）直接呼叫同一組工具（assistant/mcpBridge.ts）。
 */
import type { AgentBackend } from "../api";

export const AGENT_BACKENDS: readonly AgentBackend[] = ["http", "claude-cli", "codex-cli"];

/** 設定檔裡的字串 → 後端。不認得的值（手改設定、未來版本寫的）一律當 http：那是唯一不需要額外安裝的。 */
export function agentBackendOf(v: unknown): AgentBackend {
  return AGENT_BACKENDS.includes(v as AgentBackend) ? (v as AgentBackend) : "http";
}
