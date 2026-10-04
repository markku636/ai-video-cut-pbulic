import { beforeEach, describe, expect, it, vi } from "vitest";

// 指令表會 import 一大堆 store（含 api → Tauri）；這裡只驗表本身的一致性，Tauri 呼叫全部 stub
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const { commandList } = await import("./index");
const { duplicateChords, registerCommands, resetCommands, allCommands } = await import("./registry");
const { chordKey, parseShortcut } = await import("./shortcut");

// 就是 commands/index.ts installCommands() 登記的那一份（含字幕指令與 M2.12 序列指令，快捷鍵撞鍵要以整張表來驗）。
// 序列指令用旗標開的版本：鍵最多的那一份，撞鍵只會出現在這裡（旗標關的版本在 sequenceCommands.test 另外驗）。
// 這裡沒有登記任何外掛（= 開源版）；牌外掛登記之後的整張表在 plugins/cards/frontend/commands/commandTable.test.ts 驗。
const ALL = commandList(true);

beforeEach(() => {
  resetCommands();
  registerCommands(ALL);
});

describe("指令表一致性", () => {
  it("id 不重複", () => {
    const ids = ALL.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("沒有兩個指令綁同一個快捷鍵（會雙擊發）", () => {
    expect(duplicateChords()).toEqual([]);
  });
  it("hotkeys.ts 手寫派發的鍵（J / L 轉盤、Shift+J / Shift+L 慢速轉盤、反斜線 A/B 閃爍）沒有被註冊表的指令搶走", () => {
    // 註冊表的 chord 比手寫 switch 先派發：v0.0.6 把循環綁在 L，鍵盤從此叫不到前進轉盤；
    // Point Lock 以前綁 Shift+L，0.5× 慢速前進也一樣叫不到（M1 驗收 L6，已改 Alt+L）
    const manual = new Set(["J", "L", "Shift+J", "Shift+L", "\\"].map((s) => chordKey(parseShortcut(s))));
    const taken = allCommands()
      .filter((c) => !c.shortcutManual)
      .flatMap((c) => (c.shortcuts ?? []).map((s) => ({ id: c.id, chord: chordKey(parseShortcut(s)) })))
      .filter((x) => manual.has(x.chord));
    expect(taken).toEqual([]);
  });
  it("Point Lock 搬到 Alt+L，而且 Alt+L 只有它一個", () => {
    const lock = allCommands().find((c) => c.id === "adjust.toggleLock");
    expect(lock?.shortcuts).toEqual(["Alt+L"]);
    const altL = chordKey(parseShortcut("Alt+L"));
    const owners = allCommands().filter((c) => (c.shortcuts ?? []).some((s) => chordKey(parseShortcut(s)) === altL));
    expect(owners.map((c) => c.id)).toEqual(["adjust.toggleLock"]);
  });
  it("命令面板的清單沒有重複 key（子項同時也註冊成頂層指令時會重複）", async () => {
    // 工作模式與畫面比例參考線的子項都「既是 children 也是頂層指令」：
    // 前者為了能用 id 直接跑，後者為了出現在選單列那一組裡。面板展開 children 之後
    // 會再遇到同一個 id 一次 —— React 噴「two children with the same key」，
    // 而使用者看到的是同一條功能列兩遍。實機掃描抓到的。
    const { paletteEntries } = await import("../shell/CommandPalette");
    const keys = paletteEntries(allCommands()).map((e) => e.key);
    const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dup).toEqual([]);
  });

  it("有子項的指令，子項本身若也註冊了，兩邊指的是同一件事", () => {
    for (const c of allCommands()) {
      if (!c.children) continue;
      for (const k of c.children()) {
        const top = allCommands().find((x) => x.id === k.id);
        if (top) expect(top.title, k.id).toBe(k.title);
      }
    }
  });

  it("計畫 §9 點名的指令都在", () => {
    const ids = new Set(allCommands().map((c) => c.id));
    for (const id of [
      "file.open", "file.save", "file.saveAs", "file.settings", "file.exportTrackData",
      "edit.undo", "edit.redo", "edit.deleteKeyframe", "edit.deleteTrack", "edit.shotCutAt", "edit.shotMerge", "edit.revertFrameToSolved",
      "view.zoomIn", "view.zoomOut", "view.zoomFit", "view.toggleMasks", "view.toggleSurface", "view.toggleGrid", "view.toggleTrackHud", "view.toggleDarkenImage",
      "view.mode.normal", "view.mode.stabilized", "view.mode.replaced", "view.mode.split", "view.mode.difference", "view.abFlicker", "view.theme", "view.lang",
      "playback.toggle", "playback.stepBack", "playback.stepFwd", "playback.markIn", "playback.markOut", "playback.loop", "playback.prevKeyframe", "playback.nextKeyframe", "playback.prevLowConfidence", "playback.nextLowConfidence",
      "playback.playSelection", "playback.playAround", "playback.markShot", "sequence.insertGap", "sequence.duplicate", "sequence.nudgeLeft", "sequence.nudgeRight", "sequence.selectClipAtPlayhead", "sequence.overwriteMedia", "sequence.extendEdit", "sequence.addMarker", "sequence.deleteMarker", "sequence.renameMarker", "sequence.prevMarker", "sequence.nextMarker", "sequence.splitAtShots", "sequence.renameClip", "sequence.normalizeAudio", "sequence.removeSilence", "sequence.removeFillers", "captions.cutCue", "sequence.selectAll", "sequence.cutClips", "sequence.copyClips", "sequence.pasteClips", "sequence.moveItemLeft", "sequence.moveItemRight", "sequence.slipLeft", "sequence.slipRight",
      "track.new", "track.tool.surface", "track.tool.trackingRegion", "track.setReferenceFrame", "track.goToReferenceFrame", "track.trackToStart", "track.trackToEnd", "track.stepTrackBack", "track.stepTrackFwd", "track.stopTrack",
      "track.clearBackwards", "track.clearForwards", "track.clearAll", "track.retrackFromHere", "track.setKeyframe", "track.fromMask", "track.motionModel", "track.options",
      "adjust.mode", "adjust.addReferencePoint", "adjust.nudge", "adjust.toggleLock", "adjust.setPrimaryFrame", "adjust.workBackwards", "adjust.resolveAround",
      "mask.tool.addSelection", "mask.tool.reduceSelection", "mask.propagateForward", "mask.propagateBackward", "mask.propagateBoth", "mask.clearPrompts", "mask.removeObject", "mask.blurBackground",
      "export.video", "export.range", "export.frame", "export.cancel", "export.copyAeCornerPin", "export.copyNukeCornerPin", "export.mattesAndPasses",
      "help.shortcuts", "help.palette", "help.about", "help.engineSetup", "help.openLogs",
    ]) expect(ids.has(id), id).toBe(true);
  });
  it("沒開檔時 enabled() 不會炸，而且會講原因", () => {
    for (const c of allCommands()) {
      const en = c.enabled();
      if (!en.ok) expect(en.why.length, c.id).toBeGreaterThan(0);
    }
  });
  it("沒有外掛：牌的指令一個都不在、工作模式只有一般平面替換、側欄指令沒有「牌」", () => {
    const ids = allCommands().map((c) => c.id);
    expect(ids.filter((id) => id.startsWith("card.") || id === "file.deckImport")).toEqual([]);
    expect(ids.filter((id) => id.startsWith("project.profile."))).toEqual(["project.profile.generic"]);
    expect(ids.filter((id) => id.startsWith("view.rail."))).toEqual(["view.rail.objects", "view.rail.track", "view.rail.mask", "view.rail.captions", "view.rail.jobs", "view.rail.history", "view.rail.advice", "view.rail.assistant"]);
    expect(ids).not.toContain("card.recognizeRange");
    expect(ids).not.toContain("card.detectRange");
  });
});
