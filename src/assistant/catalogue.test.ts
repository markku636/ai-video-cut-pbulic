// 工具表對得上真的指令嗎。
//
// 這條是**防止默默壞掉**：工具表裡的 target 是字串，指令改名或被刪掉時 tsc 抓不到，
// 症狀會是使用者叫助手做事、助手回一句「這個版本沒有那個指令」。
import { describe, expect, it, vi } from "vitest";

// 指令表會 import 一大堆 store（含 api → Tauri）；這裡只比對 id，Tauri 呼叫全部 stub（同 commands.test.ts）
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const { coreCommands } = await import("../commands/core");
const { TRACK_COMMANDS } = await import("../commands/trackCommands");
// 牌的指令搬進外掛（plugins/cards）；以前跟它們放在同一個檔的輸出指令留在核心
const { EXPORT_COMMANDS } = await import("../commands/exportCommands");
const { MEDIA_INFO_COMMANDS } = await import("../commands/mediaInfoCommands");
const { CAPTION_COMMANDS } = await import("../commands/captionCommands");
const { sequenceCommands } = await import("../commands/sequenceCommands");
const { TOOLS } = await import("./catalogue");

const ids = new Set(
  [...coreCommands(), ...TRACK_COMMANDS, ...EXPORT_COMMANDS, ...MEDIA_INFO_COMMANDS, ...CAPTION_COMMANDS, ...sequenceCommands(true)].map((c) => c.id),
);

describe("工具表 → 指令登記表", () => {
  it("每個 command 工具都對得上一個真的指令", () => {
    for (const t of TOOLS) {
      if (t.kind !== "command") continue;
      expect(ids.has(t.target!), `${t.name} → ${t.target}`).toBe(true);
    }
  });

  it("op 工具的 target 看起來像引擎 op（前綴.名字）", () => {
    for (const t of TOOLS) {
      if (t.kind !== "op") continue;
      expect(t.target, t.name).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });
});
