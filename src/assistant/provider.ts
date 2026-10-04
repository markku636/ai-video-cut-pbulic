/**
 * 要打哪一個 LLM：本機端點，還是 Claude。
 *
 * **判準是「Claude 模型名稱有沒有填」**，不是另開一個下拉選單。理由：
 * 用 Claude 一定要指定模型（Anthropic 的 API 沒有「列出模型」可以自動挑），
 * 所以那個欄位本來就是必填的；把它同時當成開關，就少一個會跟實際設定對不起來的狀態
 * ——不會出現「選了 Claude 但沒填模型」或「填了模型卻還在打本機」這種組合。
 *
 * 金鑰不在這裡：它由 Rust 在引擎呼叫時從 keychain 直接塞進參數（`inject_secrets`），
 * 前端從頭到尾拿不到明文。
 */

export interface LlmSettingsLike {
  llm_openai_base_url: string;
  llm_openai_model: string;
  llm_anthropic_base_url: string;
  llm_anthropic_model: string;
}

export interface ProviderChoice {
  provider: "openai" | "anthropic";
  endpoint: string;
  /** 空字串＝讓引擎自己挑（只有本機端點做得到）。 */
  model: string;
}

/** null = 兩邊都沒設定好，面板要顯示「還沒設定 AI 端點」。 */
export function pickProvider(s: LlmSettingsLike): ProviderChoice | null {
  const claudeModel = s.llm_anthropic_model.trim();
  if (claudeModel) {
    const endpoint = s.llm_anthropic_base_url.trim();
    // 端點被清空時不要默默改打本機（那會讓人以為在用 Claude）
    return endpoint ? { provider: "anthropic", endpoint, model: claudeModel } : null;
  }
  const endpoint = s.llm_openai_base_url.trim();
  return endpoint ? { provider: "openai", endpoint, model: s.llm_openai_model.trim() } : null;
}

/** 引擎 `assistant.chat` 的參數（model 空字串時不送，讓引擎挑端點列出來的第一個）。 */
export function providerArgs(c: ProviderChoice): Record<string, unknown> {
  return { endpoint: c.endpoint, provider: c.provider, ...(c.model ? { model: c.model } : {}) };
}
