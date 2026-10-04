import { beforeEach, describe, expect, it, vi } from "vitest";

// 指令表會 import 一大堆 store（含 api → Tauri）；這裡只驗表本身，Tauri 呼叫全部 stub
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const { coreCommands } = await import("./core");
const { TRACK_COMMANDS } = await import("./trackCommands");
// 牌的指令搬進外掛（plugins/cards）；以前跟它們放在同一個檔的輸出指令留在核心
const { EXPORT_COMMANDS } = await import("./exportCommands");
const { MEDIA_INFO_COMMANDS } = await import("./mediaInfoCommands");
const { CAPTION_COMMANDS, targetCueId } = await import("./captionCommands");
const { duplicateChords, registerCommands, resetCommands, allCommands, command } = await import("./registry");
const { chordKey, parseShortcut } = await import("./shortcut");
const { useEdits } = await import("../store/edits");
const { useProject } = await import("../store/project");
const { usePlayback } = await import("../store/playback");
const { emptyCaptionTrack, useCaptionsUi } = await import("../store/captions");

// 與 commands/index.ts installCommands() 登記的清單一致：里程碑 1 的播放 / 範圍 / 媒體資訊快捷鍵也要一起驗撞鍵
const ALL = () => [...coreCommands(), ...TRACK_COMMANDS, ...EXPORT_COMMANDS, ...MEDIA_INFO_COMMANDS, ...CAPTION_COMMANDS];

beforeEach(() => {
  resetCommands();
  registerCommands(ALL());
  useEdits.getState().reset();
  useCaptionsUi.getState().selectCue(null);
  usePlayback.getState().setFrame(0);
});

describe("字幕指令表", () => {
  it("id 不跟任何既有指令重複", () => {
    const ids = ALL().map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("快捷鍵不跟既有的撞（B / Shift+C / E / Ctrl+F / Ctrl+Alt(+Shift)+←→）", () => {
    expect(duplicateChords()).toEqual([]);
    const chords = new Map(CAPTION_COMMANDS.flatMap((c) => (c.shortcuts ?? []).map((s) => [chordKey(parseShortcut(s)), c.id] as const)));
    expect(chords.get("b")).toBe("captions.splitAtPlayhead");
    expect(chords.get("S-c")).toBe("captions.toggleVisible");
    expect(chords.get("e")).toBe("captions.toggleEmphasis");
    expect(chords.get("C-f")).toBe("captions.findReplace");
    expect(chords.get("C-A-ArrowLeft")).toBe("captions.nudgeStartBack");
    expect(chords.get("C-A-S-ArrowRight")).toBe("captions.nudgeEndFwd");
    // Alt+方向鍵是 hotkeys.ts 手寫的參考點微調，字幕只能用帶 Ctrl 的
    for (const k of chords.keys()) expect(/^A-Arrow/.test(k)).toBe(false);
  });
  it("規格 §5.7 點名的指令都在", () => {
    for (const id of ["captions.generate", "captions.generateQuick", "captions.toggleVisible", "captions.splitAtPlayhead", "captions.mergeNext", "captions.findReplace", "captions.exportSrt", "captions.exportVtt", "captions.nudgeStartBack", "captions.nudgeEndFwd", "view.rail.captions"]) {
      expect(command(id), id).toBeDefined();
    }
  });
  it("沒開檔時 enabled() 不會炸，而且會講原因", () => {
    for (const c of allCommands()) {
      const en = c.enabled();
      if (!en.ok) expect(en.why.length, c.id).toBeGreaterThan(0);
    }
  });
  it("有字幕時：播放線上有段 → 分割 / 刪除可以做；對象優先用面板選中的段", () => {
    useProject.setState({ activeMediaId: "m1", media: [{ id: "m1", path: "x.webm", name: "x.webm", fingerprint: "", probe: null, proxy: { version: 1, fps: { num: 30, den: 1 }, frames: 300, width: 1280, height: 720, scale: 1, path: "p.mp4" }, proxyState: "ready" }] });
    const cues = [0, 40].map((s, n) => ({ id: `c${n + 1}`, startFrame: s, endFrame: s + 20, words: [..."百家姓"].map((ch, i) => ({ text: ch, startFrame: s + i * 5, endFrame: s + i * 5 + 5 })) }));
    useEdits.getState().load("m1", { captions: { ...emptyCaptionTrack("subtitle", "zh-TW"), cues } });
    usePlayback.getState().setFrame(6);
    expect(command("captions.splitAtPlayhead")!.enabled()).toEqual({ ok: true });
    expect(command("captions.deleteCue")!.enabled()).toEqual({ ok: true });
    expect(targetCueId()).toBe("c1");
    useCaptionsUi.getState().selectCue("c2");
    expect(targetCueId()).toBe("c2");
    expect(command("captions.mergeNext")!.enabled().ok).toBe(false);
    usePlayback.getState().setFrame(30);
    expect(command("captions.splitAtPlayhead")!.enabled().ok).toBe(false);
    expect(command("captions.toggleEmphasis")!.enabled().ok).toBe(false);
    useCaptionsUi.getState().selectWord({ cueId: "c2", index: 1 });
    expect(command("captions.toggleEmphasis")!.enabled()).toEqual({ ok: true });
  });
});
