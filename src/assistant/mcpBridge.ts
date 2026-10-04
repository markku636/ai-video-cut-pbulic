/**
 * 助手工具表 ↔ App 內建的 MCP server（src-tauri/src/mcp.rs）。
 *
 * Rust 只當 JSON-RPC 轉發器：claude / codex 呼叫工具 → `mcp-tool-call` 事件 → 這裡執行 → `mcp_tool_result` 回寫。
 *
 * **執行路徑跟 HTTP 助手是同一條**：參數檢查走 `protocol.toStep`（同一套錯誤訊息、同一個 `enabled()` 權限），
 * 執行走 `run.runStep`（同一套「模型不該決定的參數由 App 補」）。多出來的只有兩件事：
 * - 會改東西（`danger`）的工具一步問一次人（store/mcpApprovals.ts）—— HTTP 助手是整份計畫按一次「執行」。
 * - 結果帶 `images`（view_frame 的 PNG）時 Rust 會把圖讀出來給看得到圖的模型。
 */
import { api, errMessage, listenMcpToolCall, type McpToolCall, type McpToolDef } from "../api";
import { command } from "../commands/registry";
import { t } from "../i18n";
import { useMcpApprovals } from "../store/mcpApprovals";
import { TOOLS, type EnabledLookup, type ToolSpec } from "./catalogue";
import { currentRunContext } from "./context";
import { toStep, type PlanStep } from "./protocol";
import { LONG_TOOLS, runStep, usefulFacts, type RunContext, type StepResult } from "./run";

/** 「會改東西」的工具等人按要時間：MCP 逾時要比 store/mcpApprovals.ts 的 APPROVAL_TIMEOUT_MS 長。 */
export const DANGER_TIMEOUT_SECS = 240;
/** 追蹤、輸出這類長工作。 */
export const LONG_TIMEOUT_SECS = 1800;

/** 一個參數 → JSON Schema。 */
function paramSchema(p: ToolSpec["params"][number]): Record<string, unknown> {
  const s: Record<string, unknown> = { type: p.type, description: p.describe };
  if (p.choices) s.enum = [...p.choices];
  if (p.min != null) s.minimum = p.min;
  if (p.max != null) s.maximum = p.max;
  return s;
}

/** 工具表的一支 → MCP 工具定義（純函式）。描述沿用 catalogue 寫給模型的那一句，會改東西的另外講清楚 App 會先問人。 */
export function toolDef(tool: ToolSpec): McpToolDef {
  const required = tool.params.filter((p) => p.required).map((p) => p.name);
  const description = tool.danger ? `${tool.describe}（會改專案或寫檔案：App 會先問使用者，使用者可能拒絕。）` : tool.describe;
  const timeoutSecs = LONG_TOOLS.has(tool.name) ? LONG_TIMEOUT_SECS : tool.danger ? DANGER_TIMEOUT_SECS : undefined;
  return {
    name: tool.name,
    description,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(tool.params.map((p) => [p.name, paramSchema(p)])),
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    },
    ...(timeoutSecs ? { timeoutSecs } : {}),
  };
}

export function toolDefs(tools: readonly ToolSpec[] = TOOLS): McpToolDef[] {
  return tools.map(toolDef);
}

/** 計畫步驟的參數 → 一行摘要（確認卡片上顯示）。 */
export function argsLine(step: PlanStep): string {
  return Object.entries(step.args)
    .map(([k, v]) => `${k}=${v}`)
    .join("  ");
}

/** 回給模型的結果（純函式）：人話、下一步用得到的事實、圖（交給 Rust 讀成 image block）。 */
export function mcpResultOf(step: PlanStep, r: StepResult): Record<string, unknown> {
  const facts = usefulFacts(step.tool.name, r.data);
  const images = Array.isArray(r.data?.images) ? (r.data!.images as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return {
    ok: r.ok,
    message: r.message,
    ...(facts ? { facts } : {}),
    ...(step.unused ? { ignoredArgs: step.unused } : {}),
    ...(images.length ? { images } : {}),
  };
}

export interface ExecDeps {
  context: () => Promise<RunContext | null>;
  /** 問人能不能跑這一步；回 false＝拒絕。 */
  approve: (step: PlanStep) => Promise<boolean>;
  run: (step: PlanStep, ctx: RunContext) => Promise<StepResult>;
  enabledOf: EnabledLookup;
}

const defaultDeps: ExecDeps = {
  context: currentRunContext,
  approve: (step) => useMcpApprovals.getState().request({ title: step.tool.title, detail: argsLine(step) }),
  run: (step, ctx) => runStep(step, ctx, t),
  enabledOf: (id) => command(id)?.enabled() ?? null,
};

/**
 * 執行一次 MCP 工具呼叫。成功回結果物件；不能做（參數錯、使用者拒絕、沒開影片、指令現在不能按）丟 Error，
 * 訊息是人話 —— MCP 那邊會變成 `isError: true` 的工具結果，模型看得到原因。
 */
export async function executeMcpTool(name: string, rawArgs: unknown, deps: ExecDeps = defaultDeps): Promise<Record<string, unknown>> {
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
  const step = toStep({ name, args }, deps.enabledOf);
  if (step.problem) throw new Error(step.problem);
  const ctx = await deps.context();
  if (!ctx) throw new Error("目前沒有開啟的影片：請使用者先開一支影片");
  if (step.tool.danger && !(await deps.approve(step))) {
    throw new Error(`使用者沒有允許「${step.tool.title}」。不要重試，先問使用者要怎麼做。`);
  }
  const r = await deps.run(step, ctx);
  if (!r.ok) throw new Error(r.message);
  return mcpResultOf(step, r);
}

/** 登記工具表（啟動時、工具表變了時）。非 Tauri 環境（vite preview、測試）靜靜略過。 */
export async function registerMcpTools(tools: readonly ToolSpec[] = TOOLS): Promise<void> {
  try {
    await api.mcpSetTools(toolDefs(tools));
  } catch {
    /* 非 Tauri 環境 */
  }
}

async function handleCall(call: McpToolCall): Promise<void> {
  try {
    const result = await executeMcpTool(call.name, call.args);
    await api.mcpToolResult(call.id, result, null);
  } catch (e) {
    await api.mcpToolResult(call.id, null, errMessage(e)).catch(() => {});
  }
}

/** 上一個還活著的監聽。多裝一次就把舊的拆掉 —— 同一個事件被聽兩次 = 每個工具跑兩次。 */
let activeBridge: (() => void) | null = null;

/** 登記工具並開始接工具呼叫事件；回 unlisten。 */
export async function installMcpBridge(): Promise<() => void> {
  activeBridge?.();
  activeBridge = null;
  await registerMcpTools();
  const un = await listenMcpToolCall((call) => void handleCall(call));
  activeBridge = () => {
    activeBridge = null;
    un();
  };
  return activeBridge;
}
