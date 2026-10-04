import { beforeEach, describe, expect, it, vi } from "vitest";

// 指令表會 import 一大堆 store（含 api → Tauri）；只驗表本身，Tauri 呼叫全部 stub（同 commands.test.ts）
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const { coreCommands } = await import("./core");
const { TRACK_COMMANDS } = await import("./trackCommands");
// 牌的指令搬進外掛（plugins/cards）；以前跟它們放在同一個檔的輸出指令留在核心
const { EXPORT_COMMANDS } = await import("./exportCommands");
const { MEDIA_INFO_COMMANDS } = await import("./mediaInfoCommands");
const { CAPTION_COMMANDS } = await import("./captionCommands");
const { allCommands, command, duplicateChords, onSurface, registerCommands, resetCommands } = await import("./registry");
const { openMediaInfo, useDialogs } = await import("../store/dialogs");

beforeEach(() => {
  resetCommands();
  // 與 commands/index.ts 一致（含字幕指令），「Ctrl+I 沒被別人綁走」才是對整張表的保證
  registerCommands([...coreCommands(), ...TRACK_COMMANDS, ...EXPORT_COMMANDS, ...MEDIA_INFO_COMMANDS, ...CAPTION_COMMANDS]);
  useDialogs.getState().closeAll();
});

describe("媒體資訊指令", () => {
  it("和其他指令表放在一起時 id 不重複、Ctrl+I 沒有被別人綁走", () => {
    const ids = allCommands().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(duplicateChords()).toEqual([]);
    expect(command("media.info")?.shortcuts).toEqual(["Ctrl+I"]);
  });

  it("別名 view.mediaInfo 不綁快捷鍵、不上選單與命令面板（否則說明表和面板各出現兩次）", () => {
    const alias = command("view.mediaInfo")!;
    expect(alias.shortcuts ?? []).toEqual([]);
    expect(onSurface(alias, "palette") || onSurface(alias, "menu")).toBe(false);
    expect(onSurface(alias, "context")).toBe(true);
    expect(onSurface(command("media.info")!, "palette")).toBe(true);
  });

  it("沒開檔時停用並講原因", () => {
    expect(command("media.info")!.enabled()).toEqual({ ok: false, why: "先開啟一支影片" });
  });

  it("openMediaInfo：不指定媒體時 props 不帶 mediaId 鍵（DialogHost 才會用作用中的那支）", () => {
    openMediaInfo();
    expect(useDialogs.getState().stack).toEqual([expect.objectContaining({ id: "mediaInfo", props: {} })]);
    openMediaInfo("abc123");
    expect(useDialogs.getState().stack).toEqual([expect.objectContaining({ id: "mediaInfo", props: { mediaId: "abc123" } })]);
    openMediaInfo(null);
    expect("mediaId" in useDialogs.getState().stack[0].props).toBe(false);
  });
});
