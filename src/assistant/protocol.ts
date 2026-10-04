/**
 * 模型回來的東西 → 可以執行的計畫（純函式，不碰 store、不碰網路）。
 *
 * 這一層的工作只有一件：**擋下所有不合法的東西，而且講得出為什麼**。模型會幻想不存在的工具、
 * 漏參數、給超出範圍的數字、把秒數寫成字串；這些全都要在執行之前變成一句人看得懂的話，
 * 而不是執行到一半才炸。
 *
 * 設計上刻意**不**在這裡丟例外：一步壞掉不代表整個計畫沒用，UI 要能把好的步驟照常列出來、
 * 壞的那幾步標紅並寫原因，由人決定要不要跑其餘的。
 */
import { toolByName, type EnabledLookup, type ToolParam, type ToolSpec } from "./catalogue";

/** 模型講的一次工具呼叫（已經從它的輸出格式解出來）。 */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface PlanStep {
  tool: ToolSpec;
  args: Record<string, string | number | boolean>;
  /** null = 這一步可以跑；有值 = 為什麼不能跑（已經是人話，呼叫端直接顯示）。 */
  problem: string | null;
  /**
   * 模型多給了用不到的參數。不擋執行（那一步其餘都對），但值得講一聲。
   */
  unused?: string;
  /**
   * 「**現在**還不能按」的原因，例如「先用 I / O 標一段範圍」。不擋執行。
   *
   * 為什麼不是 problem：計畫裡前面的步驟會**改變狀態**——「set_range 之後再 cut_range」
   * 是完全正常的一份計畫，但建計畫的當下範圍還不存在，`enabled()` 當然說不行。
   * 在那個時間點把它當成錯誤，等於把最常見的一種計畫判死。
   * 真正的把關在執行時：`runCommand` 本來就會再問一次 `enabled()` 並回同一句原因。
   */
  warning?: string;
}

export interface Plan {
  steps: PlanStep[];
  /** 模型自己的說明（會顯示在計畫上方）。 */
  say: string;
}

/** 這一步能跑嗎。 */
export const runnable = (s: PlanStep): boolean => s.problem === null;

/**
 * 從模型的文字裡挖出工具呼叫。
 *
 * 接受兩種寫法，因為本機小模型與雲端模型的習慣不同，而**兩種都要能用**：
 * 1. 整段就是一個 JSON 物件 `{"say": "...", "steps": [{"tool": "...", "args": {...}}]}`
 * 2. 文字裡夾著 ```json ... ``` 區塊
 *
 * 解不出來時回 `null`（呼叫端當成「模型只是在講話，沒有要做事」），
 * 而不是丟例外 —— 助手回一句純文字是完全正常的。
 */
export function parseModelPlan(text: string): { say: string; calls: ToolCall[] } | null {
  const raw = extractJson(text);
  if (!raw) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const stepsRaw = Array.isArray(o.steps) ? o.steps : null;
  if (!stepsRaw) return null;
  const calls: ToolCall[] = [];
  for (const s of stepsRaw) {
    if (!s || typeof s !== "object") continue;
    const name = (s as Record<string, unknown>).tool;
    if (typeof name !== "string" || !name) continue;
    const args = (s as Record<string, unknown>).args;
    calls.push({ name, args: args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {} });
  }
  return { say: typeof o.say === "string" ? o.say : "", calls };
}

/** 從一段文字裡取出 JSON：整段、```json 區塊、或第一個 `{` 到最後一個 `}`。 */
function extractJson(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) return fence[1].trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  return a >= 0 && b > a ? t.slice(a, b + 1) : null;
}

/**
 * 一個參數的檢查。回 `[值, null]` 或 `[null, 原因]`。
 *
 * 數字**接受字串形式**（"12" → 12）：模型很常把數字寫成字串，為了這件事整步作廢不值得。
 * 但不接受空字串與看不懂的字，那些是真的錯。
 */
export function checkParam(p: ToolParam, v: unknown): [string | number | boolean, null] | [null, string] {
  if (p.type === "number") {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
    if (!Number.isFinite(n)) return [null, `${p.name} 要是數字（拿到 ${JSON.stringify(v)}）`];
    if (p.min != null && n < p.min) return [null, `${p.name} 不可以小於 ${p.min}（拿到 ${n}）`];
    if (p.max != null && n > p.max) return [null, `${p.name} 不可以大於 ${p.max}（拿到 ${n}）`];
    return [n, null];
  }
  if (p.type === "boolean") {
    if (typeof v === "boolean") return [v, null];
    if (v === "true") return [true, null];
    if (v === "false") return [false, null];
    return [null, `${p.name} 要是 true 或 false（拿到 ${JSON.stringify(v)}）`];
  }
  if (typeof v !== "string" || !v.trim()) return [null, `${p.name} 要是文字（拿到 ${JSON.stringify(v)}）`];
  if (p.choices && !p.choices.includes(v)) return [null, `${p.name} 只能是 ${p.choices.join(" / ")}（拿到 ${v}）`];
  return [v, null];
}

/**
 * 一次呼叫 → 一個計畫步驟。
 *
 * `enabledOf` 用來問「這個指令現在能不能按」：**權限完全沿用指令自己的 `enabled()`**，
 * 助手不會多開後門，而且不能做的時候回給使用者的是同一句人話。
 */
export function toStep(call: ToolCall, enabledOf?: EnabledLookup): PlanStep {
  const tool = toolByName(call.name);
  if (!tool) {
    return { tool: { name: call.name, kind: "command", title: call.name, describe: "", params: [] }, args: {}, problem: `不認得這個工具：${call.name}` };
  }
  const args: Record<string, string | number | boolean> = {};
  const problems: string[] = [];
  for (const p of tool.params) {
    const raw = call.args[p.name];
    if (raw === undefined || raw === null) {
      if (p.required) problems.push(`少了 ${p.name}`);
      continue;
    }
    const [v, why] = checkParam(p, raw);
    if (why !== null) problems.push(why);
    else args[p.name] = v as string | number | boolean;
  }
  // 模型多給的參數：**不擋**。那一步其餘的參數都對，多的只是沒人用；
  // 為了一個多餘的鍵把一份正確的計畫判死，是讓這種功能對小模型完全不能用的典型作法。
  // 但還是要講一聲：通常代表模型以為有這個功能（例如 fade），使用者值得知道。
  const extra = Object.keys(call.args).filter((k) => !tool.params.some((p) => p.name === k));

  // 指令不存在是**真的**不能跑（這個版本就是沒有）；「現在不能按」則只是提醒，見 PlanStep.warning
  let warning: string | undefined;
  if (!problems.length && tool.kind === "command" && tool.target && enabledOf) {
    const en = enabledOf(tool.target);
    if (en === null) problems.push(`這個版本沒有「${tool.title}」這個指令`);
    else if (!en.ok) warning = en.why;
  }
  return {
    tool,
    args,
    problem: problems.length ? problems.join("；") : null,
    ...(extra.length ? { unused: extra.join("、") } : {}),
    ...(warning ? { warning } : {}),
  };
}

/** 一整份計畫。步驟順序照模型給的（它們常常互相依賴：先設範圍再剪）。 */
export function buildPlan(parsed: { say: string; calls: ToolCall[] }, enabledOf?: EnabledLookup): Plan {
  return { say: parsed.say, steps: parsed.calls.map((c) => toStep(c, enabledOf)) };
}

/**
 * 計畫的一句摘要，給按鈕旁邊用。
 *
 * 會改東西的步數要**單獨講**：那是使用者按下去之前最該知道的事。
 */
export function planSummary(plan: Plan, t: (zh: string, vars?: Record<string, string | number>) => string): string {
  const ok = plan.steps.filter(runnable);
  if (!plan.steps.length) return t("沒有要做的事");
  if (!ok.length) return t("這份計畫的 {n} 步都不能執行", { n: plan.steps.length });
  const danger = ok.filter((s) => s.tool.danger).length;
  const bad = plan.steps.length - ok.length;
  const parts = [t("{n} 步", { n: ok.length })];
  if (danger) parts.push(t("其中 {n} 步會改東西", { n: danger }));
  if (bad) parts.push(t("{n} 步不能執行", { n: bad }));
  return parts.join("・");
}
