// 要打本機還是 Claude。判準是「Claude 模型名稱有沒有填」，所以這裡測的全是那個欄位的邊界。
import { describe, expect, it } from "vitest";
import { pickProvider, providerArgs, type LlmSettingsLike } from "./provider";

const s = (o: Partial<LlmSettingsLike> = {}): LlmSettingsLike => ({
  llm_openai_base_url: "http://localhost:1234/v1",
  llm_openai_model: "",
  llm_anthropic_base_url: "https://api.anthropic.com",
  llm_anthropic_model: "",
  ...o,
});

describe("pickProvider", () => {
  it("沒填 Claude 模型 → 打本機", () => {
    expect(pickProvider(s())).toEqual({ provider: "openai", endpoint: "http://localhost:1234/v1", model: "" });
  });

  it("填了 Claude 模型 → 改打 Claude", () => {
    expect(pickProvider(s({ llm_anthropic_model: "claude-sonnet-5" }))).toEqual({
      provider: "anthropic",
      endpoint: "https://api.anthropic.com",
      model: "claude-sonnet-5",
    });
  });

  it("只有空白不算填了", () => {
    expect(pickProvider(s({ llm_anthropic_model: "   " }))?.provider).toBe("openai");
  });

  it("Claude 端點被清空時回 null，不要默默改打本機 —— 那會讓人以為還在用 Claude", () => {
    expect(pickProvider(s({ llm_anthropic_model: "claude-sonnet-5", llm_anthropic_base_url: "  " }))).toBeNull();
  });

  it("本機端點也清空就是兩邊都沒設定好", () => {
    expect(pickProvider(s({ llm_openai_base_url: "" }))).toBeNull();
  });

  it("本機模型有填就用它（不然讓引擎挑端點的第一個）", () => {
    expect(pickProvider(s({ llm_openai_model: " qwen3 " }))?.model).toBe("qwen3");
  });
});

describe("providerArgs", () => {
  it("model 空的時候不送（讓引擎挑端點列出來的第一個）", () => {
    const a = providerArgs({ provider: "openai", endpoint: "http://x/v1", model: "" });
    expect(a).toEqual({ endpoint: "http://x/v1", provider: "openai" });
  });

  it("有 model 就送", () => {
    expect(providerArgs({ provider: "anthropic", endpoint: "https://a", model: "claude-sonnet-5" })).toEqual({
      endpoint: "https://a",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
  });

  it("永遠不帶 api_key —— 金鑰由 Rust 從 keychain 塞，前端碰不到明文", () => {
    expect(providerArgs({ provider: "anthropic", endpoint: "https://a", model: "m" })).not.toHaveProperty("api_key");
  });
});
