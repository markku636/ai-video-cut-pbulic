import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuItem } from "../ui/MenuPanel";
import type { Command } from "./types";

// menuModel 的右鍵積木會 import store / pipeline（→ api → Tauri）；這裡只驗選單長相，Tauri 呼叫全部 stub
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const M = await import("./menuModel");
const { OK, commandsIn, registerCommands, resetCommands } = await import("./registry");
const { DEFAULT_TRACK_OPTIONS } = await import("../project/format");
const { useEdits } = await import("../store/edits");
const { useProject } = await import("../store/project");
const { useTimeline } = await import("../store/timeline");
const { timelineContextMenuHandler } = await import("../frametimeline/contextMenu");

// 這裡不登記任何外掛（= 開源版）：牌外掛注入的項目（換成… ▸、辨識這條追蹤的牌、格位列）在
// plugins/cards/frontend/commands/menus.test.ts 用同一套積木驗。
type ShotV1 = import("../project/format").ShotV1;
type TrackV1 = import("../project/format").TrackV1;
type TimelineMenuCtx = import("./menuModel").TimelineMenuCtx;
type TimelineContextTarget = import("../frametimeline/contextMenu").TimelineContextTarget;

function cmd(p: Partial<Command> & { id: string }): Command {
  return { title: p.id, group: "track", enabled: () => OK, run: () => {}, ...p };
}

function kids(it: MenuItem | undefined): MenuItem[] {
  if (!it) return [];
  return typeof it.children === "function" ? it.children() : (it.children ?? []);
}

/** 選單 → dataId 列（分隔線記成 ---）；標題列記成 # + 文字，順序一眼看得出來。 */
function ids(items: MenuItem[]): string[] {
  return items.map((i) => (i.separator ? "---" : i.dataId === "ctx.header" ? `# ${String(i.label)}` : String(i.dataId)));
}

function find(items: MenuItem[], id: string): MenuItem | undefined {
  return items.find((i) => i.dataId === id);
}

const FPS = { num: 30, den: 1 };
const TRACK_WHY = "先在時間軸選一條追蹤";

const track = (over: Partial<TrackV1> = {}): TrackV1 => ({
  id: "t1",
  shotId: "s2",
  label: "Player1",
  kind: "planar",
  referenceFrame: null,
  trackingRegion: null,
  keyframes: [],
  prompts: [],
  adjust: { points: [], enabled: false },
  options: DEFAULT_TRACK_OPTIONS,
  insert: null,
  regionPolicy: "full",
  stale: false,
  ...over,
});

const shots: ShotV1[] = [
  { id: "s1", startFrame: 0, endFrame: 60, kind: "wide", source: "auto" },
  { id: "s2", startFrame: 60, endFrame: 926, kind: "close", source: "auto" },
];

function tctx(target: TimelineContextTarget, over: Partial<TimelineMenuCtx> = {}): TimelineMenuCtx {
  return { target, mediaId: "m1", frames: 1797, fps: FPS, range: null, pendingIn: null, pendingOut: null, shots, tracks: [track()], ...over };
}

beforeEach(() => {
  resetCommands();
  useTimeline.setState({ range: null, pendingIn: null, pendingOut: null, selectedTrackId: null, selectedKeyframe: null });
  useProject.setState({ media: [], activeMediaId: null });
  useEdits.getState().reset();
});

describe("collapseSeparators", () => {
  it("頭尾與連續的分隔線收掉", () => {
    const sep = { separator: true };
    const a = { label: "a" };
    const b = { label: "b" };
    expect(M.collapseSeparators([sep, a, sep, sep, b, sep])).toEqual([a, sep, b]);
  });
});

describe("commandsToMenu", () => {
  it("section 變了才畫線；停用的變 muted + title；quick 先於 dialog", () => {
    registerCommands([
      cmd({ id: "x.dialog", section: "追蹤", pairId: "x", variant: "dialog" }),
      cmd({ id: "x.quick", section: "追蹤", pairId: "x", variant: "quick" }),
      cmd({ id: "y", section: "遮罩", enabled: () => ({ ok: false, why: "先開啟一支影片" }) }),
    ]);
    const items = M.commandsToMenu(commandsIn("track"));
    expect(ids(items)).toEqual(["x.quick", "x.dialog", "---", "y"]);
    const y = items[3];
    expect(y.muted).toBe(true);
    expect(y.title).toBe("先開啟一支影片");
    expect(items[0].muted).toBe(false);
  });
  it("hideWhy：那個原因的項目直接不畫", () => {
    registerCommands([cmd({ id: "a", enabled: () => ({ ok: false, why: TRACK_WHY }) }), cmd({ id: "b" })]);
    expect(M.commandsToMenu(commandsIn("track"), { hideWhy: TRACK_WHY }).map((i) => i.dataId)).toEqual(["b"]);
  });
  it("動態子指令變成子選單", () => {
    registerCommands([cmd({ id: "p", children: () => [cmd({ id: "p.1", title: "one" }), cmd({ id: "p.2", title: "two" })] })]);
    const [it] = M.commandsToMenu(commandsIn("track"));
    expect(kids(it).map((k) => k.label)).toEqual(["one", "two"]);
    expect(it.onClick).toBeUndefined();
  });
});

function seedStageCommands() {
  registerCommands([
    cmd({ id: "playback.toggle", group: "playback", shortcuts: ["Space"] }),
    cmd({ id: "track.setKeyframe", title: "設關鍵幀", shortcuts: ["K"] }),
    cmd({ id: "track.fromMask", title: "從遮罩取角", enabled: () => ({ ok: false, why: "引擎尚未就緒" }) }),
    cmd({ id: "track.setReferenceFrame" }),
    cmd({ id: "mask.tool.addSelection", group: "mask" }),
    cmd({ id: "mask.tool.reduceSelection", group: "mask" }),
    cmd({ id: "track.options" }),
    cmd({ id: "edit.revertFrameToSolved", group: "edit" }),
    cmd({ id: "edit.deleteKeyframe", group: "edit", shortcuts: ["Delete"] }),
    cmd({ id: "edit.deleteTrack", group: "edit" }),
    cmd({ id: "track.new", title: "新增追蹤", shortcuts: ["N"] }),
    cmd({ id: "view.mode.normal", group: "view", shortcuts: ["1"], checked: () => true }),
    cmd({ id: "view.mode.split", group: "view", shortcuts: ["4"] }),
    cmd({ id: "view.toggleMasks", group: "view" }),
  ]);
}

describe("stageMenuItems", () => {
  it("點在表面上：標題 → 播放 → 關鍵幀 → 加減選 →（外掛的項目）→ 追蹤選項 → 檢視 → 此幀畫面 → 新增 / 刪除；needsTrack 的原因隱藏、其他原因 muted", () => {
    seedStageCommands();
    const items = M.stageMenuItems({ frame: 100, trackId: "t1", hasKeyframe: true, hasUserKeyframe: true, trackLabel: "Player1", track: track(), mediaId: "m1", canCopyImage: true, canSaveImage: true });
    expect(ids(items)).toEqual([
      "# Player1",
      "playback.toggle",
      "---",
      "track.setKeyframe",
      "track.fromMask",
      "track.setReferenceFrame",
      "edit.revertFrameToSolved",
      "edit.deleteKeyframe",
      "---",
      "mask.tool.addSelection",
      "mask.tool.reduceSelection",
      "---",
      "track.options",
      "---",
      "ctx.viewMode",
      "ctx.layers",
      "---",
      "ctx.frame.copyPng",
      "ctx.frame.savePng",
      "---",
      "track.new",
      "edit.deleteTrack",
    ]);
    const fromMask = find(items, "track.fromMask")!;
    expect(fromMask.muted).toBe(true);
    expect(fromMask.title).toBe("引擎尚未就緒");
    expect(find(items, "track.setKeyframe")!.shortcut).toBe("K");
    expect(find(items, "edit.deleteTrack")!.danger).toBe(true);
    expect(find(items, "edit.deleteKeyframe")!.danger).toBe(true);
    // 檢視模式子選單：勾選狀態 + 快捷鍵提示跟著指令
    const modes = kids(find(items, "ctx.viewMode"));
    expect(ids(modes)).toEqual(["view.mode.normal", "view.mode.split"]);
    expect(modes[0].checked).toBe(true);
    expect(modes[1].shortcut).toBe("4");
  });

  it("沒有使用者硬釘就沒有「還原為解算值」；沒有關鍵幀就沒有「移除關鍵幀」；平台不能存圖就不列", () => {
    seedStageCommands();
    const a = ids(M.stageMenuItems({ frame: 10, trackId: "t1", hasKeyframe: true, hasUserKeyframe: false, canCopyImage: true, canSaveImage: false }));
    expect(a).not.toContain("edit.revertFrameToSolved");
    expect(a).toContain("edit.deleteKeyframe");
    expect(a).toContain("ctx.frame.copyPng");
    expect(a).not.toContain("ctx.frame.savePng");
    const b = ids(M.stageMenuItems({ frame: 10, trackId: "t1", hasKeyframe: false, canCopyImage: false, canSaveImage: false }));
    expect(b).not.toContain("edit.deleteKeyframe");
    expect(b).not.toContain("ctx.frame.copyPng");
    // 沒有外掛就沒有「換成…」
    expect(b).not.toContain("ctx.target");
  });

  it("有範圍才列「播放範圍」：已登記 playback.playRange 就用它，沒有就用等價的臨時項目", () => {
    seedStageCommands();
    const r = { in: 840, out: 910 };
    expect(ids(M.stageMenuItems({ frame: 0, trackId: null, hasKeyframe: false, range: r, fps: FPS, canCopyImage: false, canSaveImage: false }))).toContain("ctx.playRange");
    registerCommands([cmd({ id: "playback.playRange", group: "playback", shortcuts: ["Ctrl+Shift+Space"] })]);
    const items = M.stageMenuItems({ frame: 0, trackId: null, hasKeyframe: false, range: r, fps: FPS, canCopyImage: false, canSaveImage: false });
    expect(ids(items).slice(0, 2)).toEqual(["playback.toggle", "playback.playRange"]);
    expect(ids(M.stageMenuItems({ frame: 0, trackId: null, hasKeyframe: false, range: null, fps: FPS }))).not.toContain("playback.playRange");
  });

  it("點在空白處：播放 / 新增 / 檢視 / 此幀；沒登記的指令（放大檢視器、媒體資訊）不留空位", () => {
    seedStageCommands();
    const items = M.stageMenuItems({ frame: 852, trackId: null, hasKeyframe: false, fps: FPS, canCopyImage: true, canSaveImage: true });
    expect(ids(items)).toEqual(["playback.toggle", "---", "track.new", "---", "ctx.viewMode", "ctx.layers", "---", "ctx.frame.copyPng", "ctx.frame.savePng", "ctx.frame.copyTimecode"]);
    registerCommands([cmd({ id: "view.mediaInfo", group: "view", shortcuts: ["Ctrl+I"] })]);
    expect(ids(M.stageMenuItems({ frame: 852, trackId: null, hasKeyframe: false, fps: FPS, canCopyImage: false, canSaveImage: false }))).toContain("view.mediaInfo");
    expect(items.every((i) => i.separator || (typeof i.label === "string" && i.label.length > 0))).toBe(true);
  });

  it("字幕（feat/captions）：有字幕軌才在空白處列分割 / 插入 / 刪除；舞台顯示字幕跟選單列一樣放在圖層子選單", () => {
    seedStageCommands();
    registerCommands([
      cmd({ id: "captions.splitAtPlayhead", group: "captions", shortcuts: ["B"] }),
      cmd({ id: "captions.insertCue", group: "captions" }),
      cmd({ id: "captions.deleteCue", group: "captions" }),
      cmd({ id: "captions.toggleVisible", group: "view", shortcuts: ["Shift+C"], checked: () => true }),
    ]);
    const base = { frame: 852, trackId: null, hasKeyframe: false, fps: FPS, canCopyImage: false, canSaveImage: false };
    const without = ids(M.stageMenuItems(base));
    expect(without).not.toContain("captions.splitAtPlayhead");
    expect(without.filter((x, i) => x === "---" && without[i + 1] === "---")).toEqual([]);
    const items = M.stageMenuItems({ ...base, hasCaptions: true });
    expect(ids(items)).toEqual(["playback.toggle", "---", "track.new", "---", "captions.splitAtPlayhead", "captions.insertCue", "captions.deleteCue", "---", "ctx.viewMode", "ctx.layers", "---", "ctx.frame.copyTimecode"]);
    expect(find(items, "captions.splitAtPlayhead")!.shortcut).toBe("B");
    const layers = kids(find(items, "ctx.layers"));
    expect(ids(layers)).toEqual(["view.toggleMasks", "captions.toggleVisible"]);
    expect(layers[1].checked).toBe(true);
  });
});

describe("timelineMenuItems：尺規 / 空白處（A）", () => {
  it("從這裡播放、在這裡設入出點（借 I / O 的快捷鍵提示）、鏡頭與整段設為範圍、在這裡切鏡頭、縮放 ▸、跟隨 ▸", () => {
    registerCommands([
      cmd({ id: "playback.markIn", group: "playback", shortcuts: ["I"] }),
      cmd({ id: "playback.markOut", group: "playback", shortcuts: ["O"] }),
      cmd({ id: "edit.shotCutAt", group: "edit", shortcuts: ["S"] }),
      cmd({ id: "view.zoomIn", group: "view" }),
      cmd({ id: "view.zoomFit", group: "view" }),
    ]);
    const items = M.timelineMenuItems(tctx({ kind: "timeline", frame: 100, zone: "ruler" }));
    expect(ids(items)).toEqual(["ctx.playFromHere", "ctx.markInHere", "ctx.markOutHere", "ctx.shotToRange", "ctx.rangeAll", "---", "ctx.cutHere", "---", "ctx.zoom", "ctx.follow"]);
    expect(find(items, "ctx.markInHere")!.shortcut).toBe("I");
    expect(find(items, "ctx.markOutHere")!.shortcut).toBe("O");
    expect(find(items, "ctx.cutHere")!.shortcut).toBe("S");
    // 沒有範圍：縮放子選單不列「縮放到範圍」、沒有任何「清除」
    expect(ids(kids(find(items, "ctx.zoom")))).toEqual(["view.zoomIn", "view.zoomFit"]);
    expect(ids(kids(find(items, "ctx.follow")))).toEqual(["ctx.follow.page", "ctx.follow.center", "ctx.follow.off"]);
  });

  it("點在鏡頭邊界 / 鏡頭外：在這裡切鏡頭是 muted 並講原因；不在任何鏡頭就沒有「將此處鏡頭設為範圍」", () => {
    useProject.setState({ activeMediaId: "m1" });
    const onEdge = M.timelineMenuItems(tctx({ kind: "timeline", frame: 60, zone: "ruler" }));
    expect(find(onEdge, "ctx.cutHere")!.muted).toBe(true);
    expect(find(onEdge, "ctx.cutHere")!.title).toBe("這裡切不了：在鏡頭邊界上，或不在任何鏡頭裡");
    const outside = M.timelineMenuItems(tctx({ kind: "timeline", frame: 1500, zone: "empty" }));
    expect(ids(outside)).not.toContain("ctx.shotToRange");
  });

  it("只有入點暫存：只列「清除入點」；有完整範圍：清入 / 清出 / 清除範圍都在（已登記的指令優先）", () => {
    registerCommands([cmd({ id: "playback.clearRange", group: "playback", shortcuts: ["Alt+X"] })]);
    const pending = ids(M.timelineMenuItems(tctx({ kind: "timeline", frame: 5, zone: "thumbs" }, { pendingIn: 3 })));
    expect(pending).toContain("ctx.clearIn");
    expect(pending).not.toContain("ctx.clearOut");
    expect(pending).not.toContain("playback.clearRange");
    registerCommands([cmd({ id: "playback.clearIn", group: "playback", shortcuts: ["Alt+I"] })]);
    const full = ids(M.timelineMenuItems(tctx({ kind: "timeline", frame: 5, zone: "ruler" }, { range: { in: 840, out: 910 } })));
    expect(full).toEqual(expect.arrayContaining(["playback.clearIn", "ctx.clearOut", "playback.clearRange"]));
    expect(full).not.toContain("ctx.clearIn");
  });

  it("點擊的幀在範圍內：最上面一段是範圍（標題含時間碼與長度），範圍操作的子選單只在有登記時出現", () => {
    registerCommands([cmd({ id: "playback.loop", group: "playback", checked: () => true })]);
    const r = { in: 840, out: 910 };
    const items = M.timelineMenuItems(tctx({ kind: "timeline", frame: 850, zone: "ruler" }, { range: r }));
    expect(ids(items).slice(0, 5)).toEqual(["# 00:00:28:00–00:00:30:10 · 70 幀（2.33 秒）", "ctx.playRange", "playback.loop", "ctx.zoomToRange", "---"]);
    expect(find(items, "playback.loop")!.checked).toBe(true);
    expect(ids(items)).not.toContain("ctx.rangeOps");
    registerCommands([cmd({ id: "track.solveRange" })]);
    const withOps = M.timelineMenuItems(tctx({ kind: "timeline", frame: 850, zone: "ruler" }, { range: r }));
    expect(ids(kids(find(withOps, "ctx.rangeOps")))).toEqual(["track.solveRange"]);
    // 範圍外右鍵：沒有範圍那一段
    expect(ids(M.timelineMenuItems(tctx({ kind: "timeline", frame: 10, zone: "ruler" }, { range: r })))[0]).toBe("ctx.playFromHere");
  });
});

describe("timelineMenuItems：範圍列本體（B）", () => {
  it("完整的範圍選單；跳到入出點沒有登記指令時用等價項目；範圍被清掉就是空的", () => {
    registerCommands([cmd({ id: "export.range", group: "export" }), cmd({ id: "export.frame", group: "export" }), cmd({ id: "playback.gotoIn", group: "playback", shortcuts: ["Shift+I"] })]);
    const r = { in: 840, out: 910 };
    const items = M.timelineMenuItems(tctx({ kind: "range", frame: 860, part: "body", range: r }, { range: r }));
    expect(ids(items)).toEqual([
      "# 00:00:28:00–00:00:30:10 · 70 幀（2.33 秒）",
      "ctx.playRange",
      "ctx.zoomToRange",
      "---",
      "export.range",
      "ctx.range.exportFrame",
      "---",
      "playback.gotoIn",
      "ctx.gotoOut",
      "ctx.clearIn",
      "ctx.clearOut",
    ]);
    expect(find(items, "playback.gotoIn")!.shortcut).toBe("Shift+I");
    expect(M.timelineMenuItems(tctx({ kind: "range", frame: 860, part: "body", range: r }, { range: null }))).toEqual([]);
  });

  it("輸出這一幀＝右鍵點的那一幀（不是播放線），夾在範圍內；輸出範圍帶的是這段範圍（M1 驗收 M1）", async () => {
    const { useDialogs } = await import("../store/dialogs");
    const { usePlayback } = await import("../store/playback");
    const A = await import("./appActions");
    registerCommands([
      cmd({ id: "export.range", group: "export", run: () => A.openExport(useTimeline.getState().range) }),
      // 正式指令取播放線；範圍選單的版本必須換成點擊的幀
      cmd({ id: "export.frame", group: "export", run: () => A.openExport({ in: usePlayback.getState().frame, out: usePlayback.getState().frame + 1 }) }),
    ]);
    usePlayback.setState({ frame: 5 });
    const r = { in: 840, out: 910 };
    useTimeline.setState({ range: r });
    const exportProps = () => useDialogs.getState().stack.filter((d) => d.id === "export").pop()?.props;
    const run = async (frame: number, part: "in" | "out" | "body") => {
      useDialogs.setState({ stack: [] });
      const items = M.timelineMenuItems(tctx({ kind: "range", frame, part, range: r }, { range: r }));
      const it = find(items, "ctx.range.exportFrame")!;
      it.onClick!();
      await new Promise((res) => setTimeout(res, 0));
      return { label: it.label, props: exportProps() };
    };
    const body = await run(860, "body");
    expect(body.props).toEqual({ range: { in: 860, out: 861 } });
    expect(body.label).toBe("輸出這一幀（00:00:28:20）…");
    // 出點握把命中的是 out（不含）：夾回範圍內最後一幀
    expect((await run(910, "out")).props).toEqual({ range: { in: 909, out: 910 } });
    expect((await run(830, "in")).props).toEqual({ range: { in: 840, out: 841 } });

    useDialogs.setState({ stack: [] });
    const items = M.timelineMenuItems(tctx({ kind: "range", frame: 860, part: "body", range: r }, { range: r }));
    find(items, "export.range")!.onClick!();
    await new Promise((res) => setTimeout(res, 0));
    expect(exportProps()).toEqual({ range: r });
  });
});

describe("timelineMenuItems：鏡頭帶（C）", () => {
  it("標題（鏡頭序號 · 時間碼 · 幀數 · 鏡位）、設為範圍 / 播放 / 跳頭尾 / 縮放、在這裡切、合併前後、重新偵測", () => {
    const items = M.timelineMenuItems(tctx({ kind: "shot", frame: 100, shotId: "s2" }));
    expect(ids(items)).toEqual([
      "# 鏡頭 2 · 00:00:02:00–00:00:30:26 · 866 幀 · 近景",
      "ctx.shot.toRange",
      "ctx.shot.play",
      "ctx.shot.gotoStart",
      "ctx.shot.gotoEnd",
      "ctx.shot.zoom",
      "---",
      "ctx.shot.cutHere",
      "ctx.shot.mergePrev",
      "ctx.shot.mergeNext",
      "---",
      "ctx.shot.redetect",
    ]);
    // 最後一個鏡頭不能跟下一個合併：muted + 原因（點了會 toast，不是灰掉不解釋）
    const next = find(items, "ctx.shot.mergeNext")!;
    expect(next.muted).toBe(true);
    expect(next.title).toBe("這已經是最後一個鏡頭");
    expect(find(items, "ctx.shot.mergePrev")!.muted).toBe(false);
    // 側欄的鏡頭列沒有點擊的幀 → 沒有「在這裡切鏡頭」
    const side = M.shotMenuItems({ shot: shots[0], shots, mediaId: "m1", fps: FPS, frames: 1797, frame: null });
    expect(ids(side)).not.toContain("ctx.shot.cutHere");
    expect(find(side, "ctx.shot.mergePrev")!.title).toBe("這已經是第一個鏡頭");
  });

  it("「將此鏡頭設為範圍」真的設成 [start, end)", () => {
    const items = M.timelineMenuItems(tctx({ kind: "shot", frame: 100, shotId: "s2" }));
    find(items, "ctx.shot.toRange")!.onClick!();
    return Promise.resolve().then(() => expect(useTimeline.getState().range).toEqual({ in: 60, out: 926 }));
  });
});

describe("timelineMenuItems：車道 / 菱形 / 參考影格（D E F）", () => {
  function seedTrackCommands() {
    registerCommands([
      cmd({ id: "track.setKeyframe", shortcuts: ["K"] }),
      cmd({ id: "track.setReferenceFrame", shortcuts: ["Shift+K"] }),
      cmd({ id: "track.goToReferenceFrame" }),
      cmd({ id: "track.retrackFromHere", shortcuts: ["Shift+T"] }),
      cmd({ id: "track.trackToEnd" }),
      cmd({ id: "track.clearAll" }),
      cmd({ id: "export.copyNukeCornerPin", group: "export" }),
      cmd({ id: "edit.deleteTrack", group: "edit", shortcuts: ["Shift+Delete"] }),
      cmd({ id: "adjust.toggleLock", group: "adjust", shortcuts: ["Alt+L"] }),
      cmd({ id: "edit.revertFrameToSolved", group: "edit" }),
      cmd({ id: "edit.deleteKeyframe", group: "edit", shortcuts: ["Delete"] }),
    ]);
  }

  it("車道：標題（標籤 · 鏡頭）、在這裡設關鍵幀 / 參考影格 / 重追（借快捷鍵）、解算 ▸、追蹤資料 ▸、刪除；沒有外掛那一段整段收掉", () => {
    seedTrackCommands();
    const items = M.timelineMenuItems(tctx({ kind: "lane", frame: 100, trackId: "t1", row: "user" }));
    expect(ids(items)).toEqual([
      "# Player1 · 鏡頭 2",
      "ctx.lane.keyframeHere",
      "ctx.lane.referenceHere",
      "track.goToReferenceFrame",
      "---",
      "ctx.lane.retrackHere",
      "ctx.lane.solve",
      "ctx.lane.shotToRange",
      "---",
      "ctx.lane.trackData",
      "---",
      "edit.deleteTrack",
    ]);
    expect(find(items, "ctx.lane.keyframeHere")!.shortcut).toBe("K");
    expect(find(items, "ctx.lane.retrackHere")!.shortcut).toBe("Shift+T");
    expect(ids(kids(find(items, "ctx.lane.solve")))).toEqual(["track.trackToEnd", "---", "track.clearAll"]);
    expect(ids(kids(find(items, "ctx.lane.trackData")))).toEqual(["export.copyNukeCornerPin"]);
    expect(find(items, "edit.deleteTrack")!.danger).toBe(true);
    // 點在 track 的鏡頭外：「在這裡…」不列（那一幀不屬於這條追蹤）
    const outside = ids(M.timelineMenuItems(tctx({ kind: "lane", frame: 10, trackId: "t1", row: "solved" })));
    expect(outside).not.toContain("ctx.lane.keyframeHere");
    expect(outside).not.toContain("ctx.lane.retrackHere");
    // 那條 track 不見了（被刪 / 換媒體）：空選單，宿主就不開
    expect(M.timelineMenuItems(tctx({ kind: "lane", frame: 100, trackId: "nope", row: "user" }))).toEqual([]);
  });

  it("「在這裡設關鍵幀」先把播放線移到點擊的幀再跑正式指令", async () => {
    let firedAt = -1;
    const { usePlayback } = await import("../store/playback");
    registerCommands([cmd({ id: "track.setKeyframe", run: () => void (firedAt = usePlayback.getState().frame) })]);
    const items = M.timelineMenuItems(tctx({ kind: "lane", frame: 123, trackId: "t1", row: "user" }));
    find(items, "ctx.lane.keyframeHere")!.onClick!();
    await new Promise((r) => setTimeout(r, 0));
    expect(firedAt).toBe(123);
  });

  it("菱形：標題含來源與鎖定角數；只有使用者硬釘才有「還原為解算值」；移除是 danger", () => {
    seedTrackCommands();
    const kf = (source: "user" | "detector") => track({ keyframes: [{ frame: 912, quad: { p: [[0, 0], [1, 0], [1, 1], [0, 1]] }, source, lockedCorners: [true, true, false, false] }] });
    const user = M.timelineMenuItems(tctx({ kind: "keyframe", frame: 912, trackId: "t1" }, { tracks: [kf("user")] }));
    expect(ids(user)).toEqual(["# 關鍵幀 912 · 使用者硬釘 · 鎖定 2 角", "adjust.toggleLock", "track.setReferenceFrame", "edit.revertFrameToSolved", "---", "edit.deleteKeyframe"]);
    expect(find(user, "edit.deleteKeyframe")!.danger).toBe(true);
    const det = ids(M.timelineMenuItems(tctx({ kind: "keyframe", frame: 912, trackId: "t1" }, { tracks: [kf("detector")] })));
    expect(det[0]).toBe("# 關鍵幀 912 · 偵測器 · 鎖定 2 角");
    expect(det).not.toContain("edit.revertFrameToSolved");
  });

  it("參考影格錨標：前往、在播放線重新設定（改標籤）、清除（真的清成 null）", () => {
    seedTrackCommands();
    const tr = track({ referenceFrame: 300 });
    useEdits.getState().load("m1", { shots, tracks: [tr] });
    const items = M.timelineMenuItems(tctx({ kind: "reference", frame: 300, trackId: "t1" }, { tracks: [tr] }));
    expect(ids(items)).toEqual(["# 參考影格 300 · Player1", "track.goToReferenceFrame", "track.setReferenceFrame", "ctx.ref.clear"]);
    expect(find(items, "track.setReferenceFrame")!.label).toBe("在播放線重新設定參考影格");
    find(items, "ctx.ref.clear")!.onClick!();
    return new Promise((r) => setTimeout(r, 0)).then(() => expect(useEdits.getState().tracks.m1[0].referenceFrame).toBeNull());
  });
});

describe("mediaMenuItems（左側欄媒體列）", () => {
  const media = { id: "m1", path: "D:\\v\\a.webm", name: "a.webm", fingerprint: "f".repeat(64), probe: null, proxy: null, proxyState: "none" as const };

  it("非作用中才有「設為作用中」；媒體資訊只在指令登記後出現；重建 proxy 沒引擎時 muted 講原因；移除是 danger", async () => {
    // M2.17 起旗標預設開；這一條驗的是 M1 的媒體選單長相（序列追加在下面另一條）
    const { useSettings } = await import("../store/settings");
    useSettings.setState({ experimental: { sequence: false } });
    useProject.setState({ media: [media, { ...media, id: "m2", name: "b.webm" }] as never, activeMediaId: "m2" });
    const items = M.mediaMenuItems("m1");
    expect(ids(items)).toEqual(["ctx.media.activate", "ctx.media.reveal", "ctx.media.copyPath", "---", "ctx.media.rebuildProxy", "ctx.media.redetectShots", "ctx.media.clearCache", "---", "ctx.media.remove"]);
    expect(find(items, "ctx.media.rebuildProxy")!.muted).toBe(true);
    expect(find(items, "ctx.media.rebuildProxy")!.title).toBe("引擎尚未就緒");
    expect(find(items, "ctx.media.remove")!.danger).toBe(true);
    registerCommands([cmd({ id: "view.mediaInfo", group: "view", shortcuts: ["Ctrl+I"] })]);
    useProject.setState({ activeMediaId: "m1" });
    const active = ids(M.mediaMenuItems("m1"));
    expect(active.slice(0, 2)).toEqual(["ctx.media.info", "ctx.media.reveal"]);
    expect(M.mediaMenuItems("gone")).toEqual([]);
  });

  it("非作用中那一列的「媒體資訊」直接開那一支，不切換作用中媒體（切換會把播放線歸零、清掉範圍；M1 驗收 L5）", async () => {
    const { useDialogs } = await import("../store/dialogs");
    useDialogs.setState({ stack: [] });
    useProject.setState({ media: [media, { ...media, id: "m2", name: "b.webm" }] as never, activeMediaId: "m2" });
    // 正式指令只會開作用中的那支；右鍵版本不能退回呼叫它
    registerCommands([cmd({ id: "view.mediaInfo", group: "view", run: () => void useDialogs.getState().open("mediaInfo", { mediaId: "m2" }) })]);
    const items = M.mediaMenuItems("m1");
    expect(ids(items).slice(0, 2)).toEqual(["ctx.media.activate", "ctx.media.info"]);
    find(items, "ctx.media.info")!.onClick!();
    await new Promise((r) => setTimeout(r, 0));
    expect(useProject.getState().activeMediaId).toBe("m2");
    expect(useDialogs.getState().stack.map((d) => [d.id, d.props])).toEqual([["mediaInfo", { mediaId: "m1" }]]);
  });

  it("序列剪輯旗標開：多「接到序列結尾／在播放線插入」，沒有 proxy 時灰掉講原因；旗標關：跟 M1 一樣（§11，M2.14）", async () => {
    const { useSettings } = await import("../store/settings");
    useProject.setState({ media: [media] as never, activeMediaId: "m1" });
    useSettings.setState({ experimental: { sequence: false } });
    expect(ids(M.mediaMenuItems("m1"))).not.toContain("ctx.media.appendToSequence");
    useSettings.setState({ experimental: { sequence: true } });
    const items = M.mediaMenuItems("m1");
    expect(ids(items)).toEqual(expect.arrayContaining(["ctx.media.appendToSequence", "ctx.media.insertAtPlayhead"]));
    expect(find(items, "ctx.media.appendToSequence")!.muted).toBe(true);
    expect(find(items, "ctx.media.appendToSequence")!.title).toBe("proxy 還沒建好，建好之後才能加入序列");
    const withProxy = { ...media, proxy: { version: 1 as const, fps: FPS, frames: 90, width: 1280, height: 720, scale: 1, path: "p.mp4" }, proxyState: "ready" as const };
    useProject.setState({ media: [withProxy] as never });
    expect(find(M.mediaMenuItems("m1"), "ctx.media.insertAtPlayhead")!.muted).toBe(false);
    useSettings.setState({ experimental: { sequence: false } });
  });
});

describe("用真的指令表組每一種右鍵選單", () => {
  it("不會炸、每一列都有字、沒有連續或頭尾分隔線；已登記的範圍指令取代等價的臨時項目", async () => {
    const { coreCommands } = await import("./core");
    const { TRACK_COMMANDS } = await import("./trackCommands");
    const { EXPORT_COMMANDS } = await import("./exportCommands");
    const { MEDIA_INFO_COMMANDS } = await import("./mediaInfoCommands");
    // 與 installCommands() 同一份清單（沒有外掛）：媒體資訊晶片 / 右鍵的 view.mediaInfo 別名也要真的在
    registerCommands([...coreCommands(), ...TRACK_COMMANDS, ...EXPORT_COMMANDS, ...MEDIA_INFO_COMMANDS]);
    useProject.setState({ activeMediaId: "m1" });
    const tr = track({ referenceFrame: 300, keyframes: [{ frame: 912, quad: { p: [[0, 0], [1, 0], [1, 1], [0, 1]] }, source: "user" }] });
    useEdits.getState().load("m1", { shots, tracks: [tr] });
    useTimeline.setState({ selectedTrackId: "t1" });
    const r = { in: 840, out: 910 };
    const menus: MenuItem[][] = [
      M.stageMenuItems({ frame: 912, trackId: "t1", hasKeyframe: true, hasUserKeyframe: true, trackLabel: "Player1", track: tr, mediaId: "m1", range: r, canCopyImage: true, canSaveImage: true }),
      M.stageMenuItems({ frame: 912, trackId: null, hasKeyframe: false, range: r, fps: FPS, canCopyImage: true, canSaveImage: true }),
      M.timelineMenuItems(tctx({ kind: "timeline", frame: 850, zone: "ruler" }, { range: r, tracks: [tr] })),
      M.timelineMenuItems(tctx({ kind: "range", frame: 850, part: "body", range: r }, { range: r, tracks: [tr] })),
      M.timelineMenuItems(tctx({ kind: "shot", frame: 100, shotId: "s2" }, { tracks: [tr] })),
      M.timelineMenuItems(tctx({ kind: "lane", frame: 100, trackId: "t1", row: "solved" }, { range: r, tracks: [tr] })),
      M.timelineMenuItems(tctx({ kind: "keyframe", frame: 912, trackId: "t1" }, { tracks: [tr] })),
      M.timelineMenuItems(tctx({ kind: "reference", frame: 300, trackId: "t1" }, { tracks: [tr] })),
    ];
    const walk = (items: MenuItem[], depth = 0) => {
      expect(items.length).toBeGreaterThan(0);
      expect(items[0].separator).toBeFalsy();
      expect(items[items.length - 1].separator).toBeFalsy();
      items.forEach((it, i) => {
        if (it.separator) return expect(items[i + 1]?.separator).toBeFalsy();
        expect(typeof it.label === "string" && it.label.length > 0, String(it.dataId)).toBe(true);
        if (it.children && depth < 2) walk(kids(it), depth + 1);
      });
    };
    menus.forEach((m) => walk(m));
    // 範圍版的正式指令已登記：不該再出現等價的臨時項目
    const range = ids(menus[3]);
    expect(range).toEqual(expect.arrayContaining(["playback.playRange", "view.zoomToRange", "playback.gotoIn", "playback.gotoOut", "playback.clearIn", "playback.clearOut", "playback.clearRange"]));
    // 例外是「輸出這一幀」：它不是等價的替代品，而是借 export.frame 換成右鍵點的那一幀（跟車道的「在這裡…」同一類）
    expect(range).toContain("ctx.range.exportFrame");
    expect(range.filter((x) => x.startsWith("ctx.") && x !== "ctx.range.exportFrame")).toEqual([]);
    expect(ids(menus[2])).toContain("playback.rangeAll");
    // 車道上選中 track 後，track 指令不會因為「先選一條追蹤」被藏起來
    expect(ids(menus[5])).toEqual(expect.arrayContaining(["ctx.lane.keyframeHere", "track.goToReferenceFrame", "edit.deleteTrack"]));
    // 沒有外掛：牌的項目一個都不出現
    expect(menus.flatMap((m) => ids(m)).filter((x) => x.startsWith("card.") || x.startsWith("ctx.target") || x.startsWith("ctx.slot"))).toEqual([]);
  });
});

describe("接線", () => {
  it("載入 menuModel 就把時間軸右鍵處理器掛上（FrameTimeline 沒拿到 prop 時找它）", () => {
    expect(timelineContextMenuHandler()).toBe(M.openTimelineContextMenu);
  });
  it("rangeTitle", () => {
    expect(M.rangeTitle({ in: 0, out: 30 }, { num: 30000, den: 1001 })).toBe("00:00:00:00–00:00:01:00 · 30 幀（1.00 秒）");
  });
  it("選單列 / 快捷鍵說明的群組：沒有外掛就只有核心的", () => {
    expect(M.menuBarGroups()).toEqual(["file", "edit", "view", "playback", "object", "track", "adjust", "mask", "captions", "export", "ai", "help"]);
    expect(M.shortcutHelpGroups()).not.toContain("card");
  });
});

describe("序列空間的右鍵（M2.12：片段 / 空白 / 範圍與尺規追加）", () => {
  const PROXY = { version: 1 as const, fps: FPS, frames: 300, width: 1280, height: 720, scale: 1, path: "p.mp4" };
  const MEDIA = { id: "m1", path: "x.webm", name: "x.webm", fingerprint: "", probe: null, proxy: PROXY, proxyState: "ready" as const };

  async function setup() {
    const { sequenceCommands } = await import("./sequenceCommands");
    const { useSettings } = await import("../store/settings");
    const { seqOf, vclip, gap } = await import("../sequence/testkit");
    const { usePlayback } = await import("../store/playback");
    useSettings.setState({ experimental: { sequence: true } });
    registerCommands(sequenceCommands(true));
    useProject.setState({ activeMediaId: "m1", media: [MEDIA] });
    useTimeline.setState({ space: "sequence", focus: null, selectedClipIds: [] });
    // 播放線 k=0 沒有用在這條序列裡（片段從 k=60 開始）：「在播放線分割」要灰掉
    usePlayback.getState().seek(0);
    const seq = seqOf([vclip("clip-1", "m1", 60, 160), gap("gap-1", 30), vclip("clip-2", "m1", 200, 300)]);
    useEdits.getState().loadSequence(seq, []);
    return seq;
  }

  const sctx = (target: TimelineContextTarget, seq: import("../project/format").SequenceV2, over: Partial<TimelineMenuCtx> = {}) => tctx(target, { space: "sequence", seq, frames: 230, shots, ...over });

  it("V1 片段：內容、快捷鍵提示、停用原因（沒選取 / 播放線不在序列 / 點在邊界上）", async () => {
    const seq = await setup();
    const menu = () => M.clipMenuItems({ seq, frame: 50, mediaName: () => "x.webm" }, "clip-1");
    let items = menu();
    // 剪下 / 複製 / 貼上是通用順序；微調（滑移 / 滑內容 / 換順序）收成子選單，免得選單推出視窗外
    expect(ids(items)).toEqual(["# x.webm · 來源 00:00:02:00–00:00:05:10（100 幀）", "ctx.clip.play", "---", "sequence.split", "ctx.clip.splitHere", "---", "sequence.cutClips", "sequence.copyClips", "sequence.duplicate", "sequence.pasteClips", "---", "sequence.rippleDelete", "sequence.lift", "sequence.toggleEnabled", "sequence.renameClip", "---", "ctx.clip.nudge", "---", "sequence.rippleTrimStart", "sequence.rippleTrimEnd", "sequence.extendEdit", "sequence.markClip", "---", "ctx.clip.openInSource", "audio.addAtPlayhead"]);
    expect(find(items, "sequence.split")!.shortcut).toBe("B");
    expect(find(items, "sequence.rippleDelete")!.shortcut).toBe("Delete");
    expect(find(items, "sequence.rippleDelete")!.danger).toBe(true);
    expect(find(items, "sequence.copyClips")!.shortcut).toBe("Ctrl+C");
    expect(find(items, "sequence.duplicate")!.shortcut).toBe("Alt+D");
    expect(find(items, "sequence.pasteClips")!.shortcut).toBe("Ctrl+V");
    expect(find(items, "sequence.cutClips")!.shortcut).toBe("Ctrl+X");
    expect(find(items, "sequence.renameClip")!.shortcut).toBe("F2");
    // 微調子選單：六個鍵盤動作（滑移 / 滑內容 / 換順序）都在裡面，不然只有看過說明的人知道
    expect(ids(kids(find(items, "ctx.clip.nudge")!))).toEqual(["sequence.nudgeLeft", "sequence.nudgeRight", "sequence.slipLeft", "sequence.slipRight", "sequence.moveItemLeft", "sequence.moveItemRight"]);
    expect(find(items, "sequence.lift")!.shortcut).toBe("Shift+Delete");
    expect(find(items, "sequence.toggleEnabled")!.shortcut).toBe("D");
    expect(find(items, "ctx.clip.openInSource")!.shortcut).toBe("F");
    // 修剪到播放線（M2.13，整合時登記）：快捷鍵提示；播放線（k=0）沒用在序列裡時講同一句原因
    expect(find(items, "sequence.rippleTrimStart")!.shortcut).toBe("Ctrl+Shift+[");
    expect(find(items, "sequence.rippleTrimEnd")!.shortcut).toBe("Ctrl+Shift+]");
    expect(find(items, "sequence.rippleTrimStart")!.title).toBe("播放線這一幀沒有用在序列裡");
    // 沒選取：刪除 / 停用講「先點選片段」；播放線（k=0）沒用在序列裡：分割講原因
    expect(find(items, "sequence.rippleDelete")!.muted).toBe(true);
    expect(find(items, "sequence.rippleDelete")!.title).toBe("先在時間軸點選片段");
    expect(find(items, "sequence.split")!.title).toBe("播放線這一幀沒有用在序列裡");
    expect(find(items, "ctx.clip.splitHere")!.muted).toBe(false);

    useTimeline.getState().selectClips(["clip-1"]);
    items = menu();
    expect(find(items, "sequence.rippleDelete")!.muted).toBe(false);
    expect(find(items, "sequence.toggleEnabled")!.checked).toBe(false);
    // 點在片段的入點上：這裡切不了
    const edge = M.clipMenuItems({ seq, frame: 0 }, "clip-1");
    expect(find(edge, "ctx.clip.splitHere")!.title).toBe("點在片段邊界上，這裡切不了");
    // 其他群組的指令登記了才列：新增追蹤
    registerCommands([cmd({ id: "track.new", shortcuts: ["N"] })]);
    expect(ids(menu())).toEqual(expect.arrayContaining(["ctx.clip.newTrack"]));
    // 素材空間：序列動作講「切到序列」
    useTimeline.setState({ space: "source" });
    expect(find(menu(), "sequence.markClip")!.title).toBe("切到時間軸上方的「序列」再剪輯片段");
  });

  it("「在這裡分割」只切點到的那個片段；「將片段設為範圍」設序列幀範圍", async () => {
    const seq = await setup();
    const items = M.clipMenuItems({ seq, frame: 180 }, "clip-2");
    find(items, "ctx.clip.splitHere")!.onClick!();
    await Promise.resolve();
    const v = useEdits.getState().sequence!.video;
    expect(v.map((it) => (it.kind === "clip" ? [it.srcIn, it.srcOut] : it.kind))).toEqual([[60, 160], "gap", [200, 250], [250, 300]]);
    // 右鍵「將選取片段設為範圍」＝ X 那顆指令（真的右鍵時 openSequenceContextMenu 會先把點到的片段選起來）
    useTimeline.getState().selectClips(["clip-1"]);
    find(M.clipMenuItems({ seq: useEdits.getState().sequence!, frame: 10 }, "clip-1"), "sequence.markClip")!.onClick!();
    await Promise.resolve();
    expect(useTimeline.getState().range).toEqual({ in: 0, out: 100 });
    expect(useTimeline.getState().focus).toBe("range");
  });

  it("空白：刪除空白（後面接上）／在這裡插入目前媒體／設為範圍；刪除一筆 undo", async () => {
    const seq = await setup();
    const items = M.gapMenuItems({ seq, frame: 110 }, "gap-1");
    expect(ids(items)).toEqual(["# 空白 · 30 幀", "ctx.gap.close", "ctx.gap.insertMedia", "---", "ctx.gap.toRange"]);
    expect(find(items, "ctx.gap.close")!.danger).toBe(true);
    find(items, "ctx.gap.close")!.onClick!();
    await new Promise((r) => setTimeout(r, 0));
    expect(useEdits.getState().sequence!.video.map((it) => it.id)).toEqual(["clip-1", "clip-2"]);
    expect(useEdits.getState().past.map((p) => p.label)).toEqual(["波紋刪除"]);
    // 不是空白 / 找不到 → 空選單（不開）
    expect(M.gapMenuItems({ seq, frame: 10 }, "clip-1")).toEqual([]);
    expect(M.clipMenuItems({ seq, frame: 10 }, "gap-1")).toEqual([]);
  });

  it("尺規（序列空間）：多了「在這裡分割所有軌」，沒有來源 k 的「切鏡頭 / 鏡頭設為範圍」", async () => {
    const seq = await setup();
    const items = M.timelineMenuItems(sctx({ kind: "timeline", frame: 50, zone: "ruler" }, seq));
    expect(ids(items)).toContain("ctx.seq.splitAllHere");
    // audio.addAtPlayhead（M2.14）登記了 →「在這裡加入音訊…」出現
    expect(ids(items)).toContain("ctx.seq.addAudioHere");
    // 標記與插入空白：只有鍵盤入口的話等於只有看過說明的人知道
    expect(ids(items)).toContain("ctx.seq.markerHere");
    expect(ids(items)).toContain("ctx.seq.insertGapHere");
    // 標題不可以沿用「在播放線插入空白」：右鍵選單裡那句話會講錯位置
    expect(find(items, "ctx.seq.insertGapHere")!.label).toBe("在這裡插入空白（3 秒）");
    // 「在這裡加標記」借 sequence.addMarker（它加在播放線上）：先 seek 再跑，不另外寫一份邏輯
    expect(find(items, "ctx.seq.markerHere")!.shortcut).toBe("Ctrl+M");
    // 播放線（k=0）不在序列上，但「在這裡加標記」按下去會先 seek 過去 —— 所以不可以照抄
    // sequence.addMarker 的 enabled（那是 needsPlayheadInSequence），否則整條會假性停用
    expect(find(items, "ctx.seq.markerHere")!.muted).toBe(false);
    await find(items, "ctx.seq.markerHere")!.onClick!();
    await new Promise((r) => setTimeout(r, 0));
    expect(useEdits.getState().sequence!.markers?.map((m) => m.t)).toEqual([50]);
    expect(ids(items)).not.toContain("ctx.cutHere");
    expect(ids(items)).not.toContain("ctx.shotToRange");
    expect(find(items, "ctx.seq.splitAllHere")!.muted).toBe(false);
    // 整段 = 序列長度 T（230），不是作用中媒體的 proxy 幀數（300）
    registerCommands([cmd({ id: "playback.rangeAll", group: "playback" })]);
    const again = M.timelineMenuItems(sctx({ kind: "timeline", frame: 50, zone: "ruler" }, seq));
    expect(ids(again)).not.toContain("playback.rangeAll");
    find(again, "ctx.seq.rangeAll")!.onClick!();
    await Promise.resolve();
    expect(useTimeline.getState().range).toEqual({ in: 0, out: 230 });
    // 剪輯點上：切不了並講原因
    const onCut = M.timelineMenuItems(sctx({ kind: "timeline", frame: 100, zone: "ruler" }, seq));
    expect(find(onCut, "ctx.seq.splitAllHere")!.title).toBe("這裡沒有可以分割的片段（在剪輯點或空白上）");
    // 素材空間原樣
    expect(ids(M.timelineMenuItems(tctx({ kind: "timeline", frame: 100, zone: "ruler" })))).not.toContain("ctx.seq.splitAllHere");
  });

  it("範圍（序列空間）：提取範圍 / 移除範圍在前；追蹤範圍操作（來源 k）不列", async () => {
    const seq = await setup();
    registerCommands([cmd({ id: "track.solveRange" }), cmd({ id: "export.range", group: "export" })]);
    const r = { in: 20, out: 120 };
    useTimeline.getState().setRange(r);
    const items = M.timelineMenuItems(sctx({ kind: "range", frame: 50, part: "body", range: r }, seq, { range: r }));
    expect(ids(items)).toEqual(expect.arrayContaining(["sequence.extractRange", "sequence.liftRange", "export.range"]));
    expect(ids(items)).not.toContain("track.solveRange");
    expect(ids(items).indexOf("sequence.extractRange")).toBeLessThan(ids(items).indexOf("export.range"));
    expect(find(items, "sequence.extractRange")!.muted).toBe(false);
    // 範圍摘要段（右鍵在範圍內的尺規）：序列空間換成提取範圍
    const summary = M.timelineMenuItems(sctx({ kind: "timeline", frame: 50, zone: "ruler" }, seq, { range: r }));
    expect(ids(summary)).toContain("sequence.extractRange");
    expect(ids(summary)).not.toContain("ctx.rangeOps");
  });

  it("openSequenceContextMenu：右鍵片段會選取它（已在多選裡就保留多選、焦點回到片段）", async () => {
    await setup();
    M.openSequenceContextMenu({ clientX: 1, clientY: 1, hit: { kind: "clip", clipId: "clip-2", frame: 150, part: "body" } });
    expect(useTimeline.getState().selectedClipIds).toEqual(["clip-2"]);
    expect(useTimeline.getState().focus).toBe("clip");
    // 沒在選取裡 → 只選它
    M.openSequenceContextMenu({ clientX: 1, clientY: 1, hit: { kind: "gap", gapId: "gap-1", frame: 110 } });
    expect(useTimeline.getState().selectedClipIds).toEqual(["gap-1"]);
    // 已在多選裡 → 多選保留；之前拖了範圍（焦點 range）→ 焦點回到片段
    useTimeline.getState().selectClips(["clip-1", "clip-2"]);
    useTimeline.getState().setRange({ in: 0, out: 10 });
    expect(useTimeline.getState().focus).toBe("range");
    M.openSequenceContextMenu({ clientX: 1, clientY: 1, hit: { kind: "original", clipId: "clip-2", frame: 150, sample: 0, part: "body" } });
    expect(useTimeline.getState().selectedClipIds).toEqual(["clip-1", "clip-2"]);
    expect(useTimeline.getState().focus).toBe("clip");
  });
});
