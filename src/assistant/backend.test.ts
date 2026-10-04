import { describe, expect, it } from "vitest";
import { agentBackendOf } from "./backend";
import { cliSystemPrompt, type AssistantState } from "./systemPrompt";

describe("agentBackendOf", () => {
  it("認得的三種原樣；其他（舊設定沒有這個鍵、手改壞的、未來版本寫的）一律當 http", () => {
    expect(agentBackendOf("http")).toBe("http");
    expect(agentBackendOf("claude-cli")).toBe("claude-cli");
    expect(agentBackendOf("codex-cli")).toBe("codex-cli");
    expect(agentBackendOf(undefined)).toBe("http");
    expect(agentBackendOf("claude")).toBe("http");
    expect(agentBackendOf(3)).toBe("http");
  });
});

describe("cliSystemPrompt", () => {
  const s: AssistantState = {
    name: "clip.mp4",
    durationSeconds: 12,
    fps: 24,
    width: 1920,
    height: 1080,
    range: { start: 1, end: 3 },
    playheadSeconds: 2.5,
    markers: 0,
    hasCaptions: false,
    hasSequence: true,
    shots: 2,
    outDir: "D:\\out",
  };

  it("帶這一刻的狀態，但不帶 JSON 計畫格式與工具表（那些走 MCP）", () => {
    const p = cliSystemPrompt(s, "zh-TW");
    expect(p).toContain("clip.mp4");
    expect(p).toContain("播放線：2.5 秒");
    expect(p).toContain("1.0–3.0 秒");
    expect(p).not.toContain('"steps"');
    expect(p).not.toContain("blur_background:");
    expect(p).not.toContain("D:\\out");
    expect(p).toContain("繁體中文");
  });

  it("英文介面回英文；沒開影片要講", () => {
    expect(cliSystemPrompt(s, "en")).toContain("Reply in English.");
    expect(cliSystemPrompt(null, "zh-TW")).toContain("沒有開啟任何影片");
  });
});
