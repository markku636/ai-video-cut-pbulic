// M2.12 分割／刪除／停用＋派發（docs/editor-m2-design.md §10、§13 M2.12 驗收）：
// duplicateChords 為空；隱含序列上按 B 會實體化並分割、一次 Ctrl+Z 回到 null；焦點派發表 7 種情況各一個測試。
import { beforeEach, describe, expect, it, vi } from "vitest";

// 指令表會 import 一大堆 store（含 api → Tauri）；Tauri 呼叫全部 stub
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const { coreCommands } = await import("./core");
const { TRACK_COMMANDS } = await import("./trackCommands");
// 牌的指令搬進外掛（plugins/cards）；以前跟它們放在同一個檔的輸出指令留在核心
const { EXPORT_COMMANDS } = await import("./exportCommands");
const { MEDIA_INFO_COMMANDS } = await import("./mediaInfoCommands");
const { CAPTION_COMMANDS } = await import("./captionCommands");
const S = await import("./sequenceCommands");
const { allCommands, command, duplicateChords, registerCommands, resetCommands, runCommand, setCommandHost } = await import("./registry");
const { chordKey, parseShortcut } = await import("./shortcut");
const { useEdits } = await import("../store/edits");
const { useProject } = await import("../store/project");
const { usePlayback } = await import("../store/playback");
const { useSettings } = await import("../store/settings");
const { useTimeline } = await import("../store/timeline");
const { isUntouched } = await import("../sequence/map");
const { validateSequence } = await import("../sequence/validate");
const { aclip, gap, lane, seqOf, vclip } = await import("../sequence/testkit");

type SequenceV2 = import("../project/format").SequenceV2;

const BASE = () => [...coreCommands(), ...TRACK_COMMANDS, ...EXPORT_COMMANDS, ...MEDIA_INFO_COMMANDS, ...CAPTION_COMMANDS];

/** 跟 commands/index.ts installCommands() 登記的一樣：原主人先交出鍵，再加上序列指令表。 */
function registerAll(flag: boolean) {
  resetCommands();
  useSettings.setState({ experimental: { sequence: flag } });
  registerCommands([...S.handOverDispatchedChords(BASE()), ...S.sequenceCommands(flag)]);
}

const PROXY = { version: 1 as const, fps: { num: 30, den: 1 }, frames: 300, width: 1280, height: 720, scale: 1, path: "p.mp4" };
const MEDIA = { id: "m1", path: "x.webm", name: "x.webm", fingerprint: "", probe: null, proxy: PROXY, proxyState: "ready" as const };

const info = vi.fn();
const error = vi.fn();

function chordOwners(): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of allCommands()) {
    if (c.shortcutManual) continue;
    for (const s of c.shortcuts ?? []) out.set(chordKey(parseShortcut(s)), c.id);
  }
  return out;
}

const seq = () => useEdits.getState().sequence as SequenceV2;

beforeEach(() => {
  registerAll(true);
  info.mockClear();
  error.mockClear();
  setCommandHost({ info, error, errMessage: (e) => (e instanceof Error ? e.message : String(e)) });
  useProject.setState({ activeMediaId: "m1", media: [MEDIA] });
  useEdits.getState().reset();
  useTimeline.setState({ space: "sequence", focus: null, selectedClipIds: [], seqTool: "select", range: null, pendingIn: null, pendingOut: null, selectedTrackId: null, selectedKeyframe: null });
  usePlayback.getState().seek(0);
});

describe("快捷鍵：派發指令接手，沒有撞鍵", () => {
  it("§10.2 M2.12 點名的指令都在", () => {
    for (const id of ["sequence.split", "sequence.splitAll", "sequence.tool.blade", "edit.delete", "edit.deleteAlt", "sequence.rippleDelete", "sequence.lift", "sequence.extractRange", "sequence.liftRange", "sequence.toggleEnabled", "sequence.matchFrame", "sequence.prevEdit", "sequence.nextEdit"]) {
      expect(command(id), id).toBeDefined();
    }
  });

  it("旗標開 / 關：duplicateChords 都是空的", () => {
    registerAll(true);
    expect(duplicateChords()).toEqual([]);
    registerAll(false);
    expect(duplicateChords()).toEqual([]);
  });

  it("旗標開：B / Ctrl+\\ / Delete / Shift+Delete / ↑↓ 歸派發指令；D、F、Shift+B、Ctrl+Shift+\\ 歸序列指令", () => {
    const o = chordOwners();
    expect(o.get("b")).toBe("edit.split");
    expect(o.get(chordKey(parseShortcut("Ctrl+\\")))).toBe("edit.split");
    expect(o.get("Delete")).toBe("edit.delete");
    expect(o.get("Backspace")).toBe("edit.delete");
    expect(o.get("S-Delete")).toBe("edit.deleteAlt");
    expect(o.get("S-Backspace")).toBe("edit.deleteAlt");
    expect(o.get("ArrowUp")).toBe("playback.prevEditOrShot");
    expect(o.get("ArrowDown")).toBe("playback.nextEditOrShot");
    expect(o.get("d")).toBe("sequence.toggleEnabled");
    expect(o.get("f")).toBe("sequence.matchFrame");
    expect(o.get("S-b")).toBe("sequence.tool.blade");
    expect(o.get(chordKey(parseShortcut("Ctrl+Shift+\\")))).toBe("sequence.splitAll");
    // Ctrl+B 維持收合側欄（§0.1 Q1）
    expect(o.get("C-b")).toBe("view.railToggle");
  });

  it("原主人保留鍵的顯示（選單上看得到按哪顆），但不再自己派發", () => {
    for (const id of S.dispatchedCommandIds()) {
      const c = command(id)!;
      expect(c.shortcutManual, id).toBe(true);
      expect(c.shortcuts?.length, id).toBeGreaterThan(0);
    }
    expect(command("sequence.split")!.shortcuts).toEqual(["B", "Ctrl+\\"]);
    expect(command("sequence.rippleDelete")!.shortcuts).toEqual(["Delete"]);
  });

  it("handOver 不改原本的指令物件（commands.test 還拿原表驗 M1 自己不撞鍵）", () => {
    const base = BASE();
    const before = base.find((c) => c.id === "edit.deleteKeyframe")!;
    S.handOverDispatchedChords(base);
    expect(before.shortcutManual).toBeUndefined();
  });

  it("旗標關：序列指令沒有鍵、不在任何表面；派發指令的標題 / 群組 / 鍵跟 M1 原主人一樣", () => {
    registerAll(false);
    const o = chordOwners();
    for (const k of ["d", "f", "S-b", "Escape", chordKey(parseShortcut("Ctrl+Shift+\\")), chordKey(parseShortcut("Ctrl+\\")), "S-Backspace"]) expect(o.get(k), k).toBeUndefined();
    for (const c of S.sequenceCommands(false)) expect(c.surfaces, c.id).toEqual([]);
    const pairs: [string, string][] = [
      ["edit.split", "captions.splitAtPlayhead"],
      ["edit.delete", "edit.deleteKeyframe"],
      ["edit.deleteAlt", "edit.deleteTrack"],
      ["playback.prevEditOrShot", "playback.prevShot"],
      ["playback.nextEditOrShot", "playback.nextShot"],
    ];
    for (const [d, orig] of pairs) {
      expect(command(d)!.title, d).toBe(command(orig)!.title);
      expect(command(d)!.group, d).toBe(command(orig)!.group);
      expect(command(d)!.shortcuts, d).toEqual(command(orig)!.shortcuts);
    }
  });

  it("旗標一變，序列指令表重新登記（表面與鍵跟著變）", () => {
    registerAll(false);
    const off = S.installSequenceCommandReactivity();
    try {
      useSettings.getState().setExperimental({ sequence: true });
      expect(command("sequence.toggleEnabled")!.shortcuts).toEqual(["D"]);
      expect(command("edit.split")!.shortcuts).toEqual(["B", "Ctrl+\\"]);
      useSettings.getState().setExperimental({ sequence: false });
      expect(command("sequence.toggleEnabled")!.shortcuts).toBeUndefined();
    } finally {
      off();
    }
  });

  it("沒開檔時所有指令的 enabled() 不會炸，而且會講原因", () => {
    useProject.setState({ activeMediaId: null, media: [] });
    for (const c of allCommands()) {
      const en = c.enabled();
      if (!en.ok) expect(en.why.length, c.id).toBeGreaterThan(0);
    }
  });
});

describe("焦點派發表（§10.1）", () => {
  const st = (focus: import("../store/timeline").TimelineFocus, hasClipSelection = false) => ({ sequenceSpace: true, focus, hasClipSelection });

  it("clip：Delete → 波紋刪除、Shift+Delete → 留空隙", () => {
    expect(S.deleteDispatch("delete", st("clip"))).toEqual({ id: "sequence.rippleDelete" });
    expect(S.deleteDispatch("deleteAlt", st("clip"))).toEqual({ id: "sequence.lift" });
  });
  it("range：Delete → 提取範圍、Shift+Delete → 移除範圍", () => {
    expect(S.deleteDispatch("delete", st("range", true))).toEqual({ id: "sequence.extractRange" });
    expect(S.deleteDispatch("deleteAlt", st("range", true))).toEqual({ id: "sequence.liftRange" });
  });
  it("envPoint：兩顆都刪自動化點", () => {
    expect(S.deleteDispatch("delete", st("envPoint"))).toEqual({ id: S.ENVELOPE_POINT_DELETE_COMMAND });
    expect(S.deleteDispatch("deleteAlt", st("envPoint"))).toEqual({ id: S.ENVELOPE_POINT_DELETE_COMMAND });
  });
  it("keyframe：Delete → 移除關鍵幀、Shift+Delete → 刪除追蹤（M1 相容）", () => {
    expect(S.deleteDispatch("delete", st("keyframe", true))).toEqual({ id: "edit.deleteKeyframe" });
    expect(S.deleteDispatch("deleteAlt", st("keyframe", true))).toEqual({ id: "edit.deleteTrack" });
  });
  it("track：Delete 停用並講原因、Shift+Delete → 刪除追蹤", () => {
    expect(S.deleteDispatch("delete", st("track"))).toEqual({ why: S.FOCUS_WHY });
    expect(S.deleteDispatch("deleteAlt", st("track"))).toEqual({ id: "edit.deleteTrack" });
  });
  it("無焦點但有選取片段 → 同 clip", () => {
    expect(S.deleteDispatch("delete", st(null, true))).toEqual({ id: "sequence.rippleDelete" });
    expect(S.deleteDispatch("deleteAlt", st(null, true))).toEqual({ id: "sequence.lift" });
  });
  it("無焦點、沒有選取 → 停用", () => {
    expect(S.deleteDispatch("delete", st(null))).toEqual({ why: S.FOCUS_WHY });
    expect(S.deleteDispatch("deleteAlt", st(null))).toEqual({ why: S.FOCUS_WHY });
  });
  it("旗標關 / 素材空間：不管焦點，一律 M1（移除關鍵幀 / 刪除追蹤）", () => {
    for (const focus of ["clip", "range", "envPoint", "track", null] as const) {
      expect(S.deleteDispatch("delete", { sequenceSpace: false, focus, hasClipSelection: true })).toEqual({ id: "edit.deleteKeyframe" });
      expect(S.deleteDispatch("deleteAlt", { sequenceSpace: false, focus, hasClipSelection: true })).toEqual({ id: "edit.deleteTrack" });
    }
  });
  it("自動化點的刪除指令還沒登記：派發指令灰掉講「還沒開放」，不會去刪片段", () => {
    useTimeline.setState({ focus: "envPoint", selectedClipIds: ["clip-1"] });
    expect(command("edit.delete")!.enabled()).toEqual({ ok: false, why: S.NOT_YET_WHY });
  });
});

describe("焦點由選取動作順手設定（store/timeline.ts）", () => {
  it("選片段 → clip；設範圍 / I / O → range；選菱形 → keyframe；選車道 → track；清掉時回到無", () => {
    const tl = () => useTimeline.getState();
    tl().selectClips(["clip-1"]);
    expect(tl().focus).toBe("clip");
    tl().setRange({ in: 10, out: 20 });
    expect(tl().focus).toBe("range");
    tl().selectKeyframe({ trackId: "t1", frame: 5 });
    expect(tl().focus).toBe("keyframe");
    tl().selectKeyframe(null);
    expect(tl().focus).toBe("track");
    tl().selectTrack(null);
    expect(tl().focus).toBeNull();
    tl().markIn(3);
    expect(tl().focus).toBe("range");
    tl().setRange(null);
    expect(tl().focus).toBeNull();
    tl().selectTrack("t1");
    expect(tl().focus).toBe("track");
    // 選取沒變的時候不換物件（訂閱者不必重算）
    tl().selectClips(["a", "b"]);
    const ids = tl().selectedClipIds;
    tl().selectClips(["a", "b"]);
    expect(tl().selectedClipIds).toBe(ids);
    tl().selectClips([]);
    expect(tl().focus).toBeNull();
  });
  it("換空間時範圍被清掉，指著範圍的焦點一起清", () => {
    useTimeline.getState().setRange({ in: 1, out: 9 });
    useTimeline.getState().setSpace("source");
    expect(useTimeline.getState().focus).toBeNull();
  });
});

describe("分割 / 合併切點（B）", () => {
  it("隱含序列上按 B：實體化＋分割同一筆 undo；一次 Ctrl+Z 回到 null，tracks 參照沒動（I1）", async () => {
    const tracksBefore = useEdits.getState().tracks;
    usePlayback.getState().seek(100);
    expect(command("edit.split")!.enabled()).toEqual({ ok: true });
    expect((await runCommand("edit.split", "hotkey")).ran).toBe(true);
    expect(seq().video.map((it) => (it.kind === "clip" ? [it.id, it.srcIn, it.srcOut] : it.id))).toEqual([
      ["clip-1", 0, 100],
      ["clip-2", 100, 300],
    ]);
    expect(validateSequence(seq())).toEqual([]);
    expect(useEdits.getState().past).toHaveLength(1);
    expect(useEdits.getState().past[0].label).toBe("分割片段");
    expect(useEdits.getState().tracks).toBe(tracksBefore);

    await runCommand("edit.undo", "hotkey");
    expect(useEdits.getState().sequence).toBeNull();
    expect(useEdits.getState().tracks).toBe(tracksBefore);
  });

  it("再按一次 B：合併切點，序列回到「未動過」（輸出回到 -c:a copy）", async () => {
    usePlayback.getState().seek(100);
    await runCommand("edit.split", "hotkey");
    await runCommand("edit.split", "hotkey");
    expect(useEdits.getState().past.map((p) => p.label)).toEqual(["分割片段", "合併切點"]);
    expect(seq().video).toHaveLength(1);
    expect(isUntouched(seq(), () => 300)).toBe(true);
  });

  it("播放線在剪輯點上（開頭）：B 灰掉講原因，不實體化", async () => {
    usePlayback.getState().seek(0);
    const en = command("sequence.split")!.enabled();
    expect(en.ok).toBe(false);
    expect((await runCommand("edit.split", "hotkey")).ran).toBe(false);
    expect(useEdits.getState().sequence).toBeNull();
    expect(useEdits.getState().past).toHaveLength(0);
  });

  it("素材空間 / 旗標關：B 還是分割字幕（沒有字幕時講字幕的原因），序列不動", async () => {
    usePlayback.getState().seek(100);
    useTimeline.setState({ space: "source" });
    expect(command("edit.split")!.enabled()).toEqual(command("captions.splitAtPlayhead")!.enabled());
    await runCommand("edit.split", "hotkey");
    expect(useEdits.getState().sequence).toBeNull();

    registerAll(false);
    useTimeline.setState({ space: "sequence" });
    expect(command("edit.split")!.enabled()).toEqual(command("captions.splitAtPlayhead")!.enabled());
    await runCommand("edit.split", "hotkey");
    expect(useEdits.getState().sequence).toBeNull();
  });

  it("planSplit：有選取的音訊片段跨過播放線 → 只切它；沒有 → 切 V1；Ctrl+Shift+\\ 切所有未鎖定的軌", () => {
    const s = seqOf([vclip("clip-1", "m1", 0, 300)], [lane("lane-1", "music", [aclip("a1", "a-music", 0, 480000)])]);
    const t = 100;
    expect(S.planSplit(s, t, "v1", ["a1"])).toEqual({ kind: "split", t, target: ["a1"] });
    expect(S.planSplit(s, t, "v1", [])).toEqual({ kind: "split", t, target: "v1" });
    expect(S.planSplit(s, t, "all", [])).toEqual({ kind: "split", t, target: "all" });
    const locked = seqOf([gap("gap-1", 300)], [lane("lane-1", "music", [aclip("a1", "a-music", 0, 480000)], { locked: true })]);
    expect(S.planSplit(locked, t, "all", ["a1"]).kind).toBe("none");
  });

  it("Ctrl+Shift+\\ 分割所有軌：V1 與同步鎖關的音樂軌都切", async () => {
    const s = seqOf([vclip("clip-1", "m1", 0, 300)], [lane("lane-1", "music", [aclip("a1", "a-music", 0, 480000)])]);
    useEdits.getState().loadSequence(s, []);
    usePlayback.getState().seek(100);
    await runCommand("sequence.splitAll", "hotkey");
    expect(seq().video).toHaveLength(2);
    expect(seq().audioLanes[0].clips.map((c) => [c.start, c.length])).toEqual([
      [0, 160000],
      [160000, 320000],
    ]);
  });
});

// M2.13（整合時補登記）：拖邊緣修剪的鍵盤版。規則在 trimDrag.trimToPlayheadCheck／ops.rippleTrimToPlayhead，這裡驗接線
describe("修剪到播放線（Ctrl+Shift+[ / ]）", () => {
  it("鍵歸 sequence.rippleTrimStart / rippleTrimEnd，沒有撞鍵；旗標關時沒有鍵", () => {
    const o = chordOwners();
    expect(o.get(chordKey(parseShortcut("Ctrl+Shift+[")))).toBe("sequence.rippleTrimStart");
    expect(o.get(chordKey(parseShortcut("Ctrl+Shift+]")))).toBe("sequence.rippleTrimEnd");
    expect(duplicateChords()).toEqual([]);
    registerAll(false);
    expect(chordOwners().get(chordKey(parseShortcut("Ctrl+Shift+[")))).toBeUndefined();
  });

  it("隱含序列：修剪開頭到播放線＝實體化＋波紋修剪同一筆 undo；一次 Ctrl+Z 回到 null", async () => {
    usePlayback.getState().seek(100);
    expect((await runCommand("sequence.rippleTrimStart", "hotkey")).ran).toBe(true);
    expect(seq().video.map((it) => (it.kind === "clip" ? [it.id, it.srcIn, it.srcOut] : it.id))).toEqual([["clip-1", 100, 300]]);
    expect(validateSequence(seq())).toEqual([]);
    expect(useEdits.getState().past.map((p) => p.label)).toEqual(["修剪片段"]);
    await runCommand("edit.undo", "hotkey");
    expect(useEdits.getState().sequence).toBeNull();
  });

  it("修剪結尾到播放線：出點落在播放線", async () => {
    usePlayback.getState().seek(100);
    await runCommand("sequence.rippleTrimEnd", "hotkey");
    expect(seq().video.map((it) => (it.kind === "clip" ? [it.srcIn, it.srcOut] : it.id))).toEqual([[0, 100]]);
  });

  it("播放線在切點上：灰掉並講原因，序列不動", async () => {
    usePlayback.getState().seek(0);
    expect(command("sequence.rippleTrimStart")!.enabled()).toEqual({ ok: false, why: "播放線在切點上，沒有東西可修剪" });
    expect((await runCommand("sequence.rippleTrimEnd", "hotkey")).ran).toBe(false);
    expect(useEdits.getState().sequence).toBeNull();
  });
});

// M2.14（整合時補登記）：加媒體到序列 / 音訊的指令入口；流程本身在 pipeline/audio.test.ts
describe("加媒體到序列 / 新增音軌", () => {
  it("§10.2 的 appendMedia / insertMedia / audio.import / addAtPlayhead / newLane 都在；旗標關時不在任何表面", () => {
    const ids = ["sequence.appendMedia", "sequence.insertMedia", "audio.import", "audio.addAtPlayhead", "audio.newLane"];
    for (const id of ids) expect(command(id), id).toBeDefined();
    registerAll(false);
    for (const id of ids) expect(command(id)!.surfaces, id).toEqual([]);
  });

  it("接到序列結尾：隱含序列實體化＋接上同一筆 undo；一次 Ctrl+Z 回到 null", async () => {
    expect((await runCommand("sequence.appendMedia", "palette")).ran).toBe(true);
    expect(seq().video.map((it) => (it.kind === "clip" ? [it.mediaId, it.srcIn, it.srcOut] : it.id))).toEqual([
      ["m1", 0, 300],
      ["m1", 0, 300],
    ]);
    expect(useEdits.getState().past.map((p) => p.label)).toEqual(["加入媒體到序列"]);
    await runCommand("edit.undo", "hotkey");
    expect(useEdits.getState().sequence).toBeNull();
  });

  it("新增音軌：要在序列空間；一筆「新增音軌」", async () => {
    useTimeline.setState({ space: "source" });
    expect(command("audio.newLane")!.enabled()).toEqual({ ok: false, why: S.SPACE_WHY });
    useTimeline.setState({ space: "sequence" });
    await runCommand("audio.newLane", "palette");
    expect(seq().audioLanes).toHaveLength(1);
    expect(useEdits.getState().past.map((p) => p.label)).toEqual(["新增音軌"]);
  });
});

describe("刪除（Delete / Shift+Delete 依焦點）", () => {
  function twoClips() {
    useEdits.getState().loadSequence(seqOf([vclip("clip-1", "m1", 0, 100), vclip("clip-2", "m1", 100, 300)]), []);
  }

  it("焦點 clip：Delete 波紋刪除選取的片段，後面往前補；選取清掉；一筆 undo", async () => {
    twoClips();
    useTimeline.getState().selectClips(["clip-1"]);
    expect(S.deleteHintText()).toBe("Delete：波紋刪除 1 個片段");
    await runCommand("edit.delete", "hotkey");
    expect(seq().video.map((it) => it.id)).toEqual(["clip-2"]);
    expect(useTimeline.getState().selectedClipIds).toEqual([]);
    expect(useTimeline.getState().focus).toBeNull();
    expect(useEdits.getState().past.map((p) => p.label)).toEqual(["波紋刪除"]);
  });

  it("焦點 clip：Shift+Delete 換成同長度的空白", async () => {
    twoClips();
    useTimeline.getState().selectClips(["clip-1"]);
    await runCommand("edit.deleteAlt", "hotkey");
    expect(seq().video.map((it) => (it.kind === "gap" ? ["gap", it.length] : it.id))).toEqual([["gap", 100], "clip-2"]);
  });

  it("焦點 range：Delete 提取範圍並清掉範圍；Shift+Delete 留空隙、範圍保留", async () => {
    twoClips();
    useTimeline.getState().setRange({ in: 50, out: 150 });
    await runCommand("edit.deleteAlt", "hotkey");
    expect(seq().video.map((it) => (it.kind === "gap" ? ["gap", it.length] : [it.srcIn, it.srcOut]))).toEqual([[0, 50], ["gap", 100], [150, 300]]);
    expect(useTimeline.getState().range).toEqual({ in: 50, out: 150 });

    twoClips();
    useTimeline.getState().setRange({ in: 50, out: 150 });
    await runCommand("edit.delete", "hotkey");
    expect(seq().video.map((it) => (it.kind === "clip" ? [it.srcIn, it.srcOut] : it.id))).toEqual([
      [0, 50],
      [150, 300],
    ]);
    expect(useTimeline.getState().range).toBeNull();
  });

  it("素材空間：Delete 還是 M1 的移除關鍵幀（沒選追蹤時講追蹤的原因），序列不動", async () => {
    twoClips();
    useTimeline.setState({ space: "source" });
    useTimeline.getState().selectClips(["clip-1"]);
    const en = command("edit.delete")!.enabled();
    expect(en).toEqual(command("edit.deleteKeyframe")!.enabled());
    await runCommand("edit.delete", "hotkey");
    expect(seq().video).toHaveLength(2);
  });

  it("隱含序列：選 clip-1（時間軸畫的整段片段）按 Delete → 整段刪掉；一次 undo 回到 null", async () => {
    useTimeline.getState().selectClips(["clip-1"]);
    await runCommand("edit.delete", "hotkey");
    expect(seq().video).toEqual([]);
    await runCommand("edit.undo", "hotkey");
    expect(useEdits.getState().sequence).toBeNull();
  });
});

describe("停用 / 對應幀 / 剪輯點", () => {
  it("D：選取有啟用的 → 全部停用；全部停用了 → 啟用；只選空白 → 灰掉", async () => {
    useEdits.getState().loadSequence(seqOf([vclip("clip-1", "m1", 0, 100), gap("gap-1", 10), vclip("clip-2", "m1", 100, 300, { enabled: false })]), []);
    useTimeline.getState().selectClips(["clip-1", "clip-2"]);
    await runCommand("sequence.toggleEnabled", "hotkey");
    expect(seq().video.filter((it) => it.kind === "clip").map((it) => it.kind === "clip" && it.enabled)).toEqual([false, false]);
    expect(command("sequence.toggleEnabled")!.checked!()).toBe(true);
    await runCommand("sequence.toggleEnabled", "hotkey");
    expect(seq().video.filter((it) => it.kind === "clip").map((it) => it.kind === "clip" && it.enabled)).toEqual([true, true]);
    expect(useEdits.getState().past.map((p) => p.label)).toEqual(["停用片段", "啟用片段"]);
    useTimeline.getState().selectClips(["gap-1"]);
    expect(command("sequence.toggleEnabled")!.enabled().ok).toBe(false);
  });

  it("planMatchFrame：序列 → 來源 k（停用片段也算）；空白講原因；素材 → 序列裡第一次出現的位置", () => {
    const s = seqOf([vclip("c1", "m1", 60, 360, { enabled: false }), gap("g", 30), vclip("c2", "m1", 930, 1380), vclip("c3", "m1", 100, 200)]);
    expect(S.planMatchFrame(s, "sequence", "m1", 0, 10)).toEqual({ dir: "toSource", mediaId: "m1", k: 70 });
    expect(S.planMatchFrame(s, "sequence", "m1", 0, 305).dir).toBe("none");
    expect(S.planMatchFrame(s, "source", "m1", 150, null)).toEqual({ dir: "toSequence", t: 90 });
    expect(S.planMatchFrame(s, "source", "m1", 5, null)).toEqual({ dir: "none", why: "這一幀沒有用在序列裡" });
  });

  it("F：序列空間 → 切到素材空間並跳到對應的 k；再按 F 回到序列", async () => {
    useEdits.getState().loadSequence(seqOf([vclip("clip-1", "m1", 200, 300), vclip("clip-2", "m1", 0, 100)]), []);
    usePlayback.getState().seek(250);
    await runCommand("sequence.matchFrame", "hotkey");
    expect(useTimeline.getState().space).toBe("source");
    expect(usePlayback.getState().frame).toBe(250);
    usePlayback.getState().seek(50);
    await runCommand("sequence.matchFrame", "hotkey");
    expect(useTimeline.getState().space).toBe("sequence");
    expect(usePlayback.getState().frame).toBe(50);
  });

  it("neighborEditPoint：0、邊界、T（夾到最後一幀）；沒有了回 null", () => {
    const s = seqOf([vclip("a", "m1", 0, 100), gap("g", 50), vclip("b", "m1", 100, 250)]);
    expect(S.neighborEditPoint(s, 10, 1)).toBe(100);
    expect(S.neighborEditPoint(s, 100, 1)).toBe(150);
    expect(S.neighborEditPoint(s, 150, 1)).toBe(299);
    expect(S.neighborEditPoint(s, 299, 1)).toBeNull();
    expect(S.neighborEditPoint(s, 150, -1)).toBe(100);
    expect(S.neighborEditPoint(s, 0, -1)).toBeNull();
  });

  it("↓：序列空間跳到下一個剪輯點；素材空間還是下一個鏡頭", async () => {
    useEdits.getState().loadSequence(seqOf([vclip("clip-1", "m1", 0, 100), vclip("clip-2", "m1", 100, 300)]), []);
    usePlayback.getState().seek(10);
    await runCommand("playback.nextEditOrShot", "hotkey");
    expect(usePlayback.getState().frame).toBe(100);
    useTimeline.setState({ space: "source" });
    expect(command("playback.nextEditOrShot")!.enabled()).toEqual(command("playback.nextShot")!.enabled());
  });

  it("Esc：取消選取、焦點清成無、刀片退回選取；沒東西可清時也不灰（不會每按一次 Esc 就跳 toast）", async () => {
    useTimeline.getState().selectClips(["clip-1"]);
    useTimeline.getState().setSeqTool("blade");
    await runCommand("sequence.clearSelection", "hotkey");
    expect(useTimeline.getState()).toMatchObject({ selectedClipIds: [], focus: null, seqTool: "select" });
    expect((await runCommand("sequence.clearSelection", "hotkey")).ran).toBe(true);
    expect(info).not.toHaveBeenCalled();
    expect(chordOwners().get("Escape")).toBe("sequence.clearSelection");
  });

  it("Shift+B：刀片工具開關，不動舞台的工具", async () => {
    const stageTool = useTimeline.getState().tool;
    await runCommand("sequence.tool.blade", "hotkey");
    expect(useTimeline.getState().seqTool).toBe("blade");
    expect(useTimeline.getState().tool).toBe(stageTool);
    await runCommand("sequence.tool.blade", "hotkey");
    expect(useTimeline.getState().seqTool).toBe("select");
  });
});

// I / O 的座標修正：timeline.range 的單位跟著空間走（序列幀 t vs 來源 proxy 幀 k）。
// 修正前 appActions.markIn/markOut 無條件用 playback.frame（＝來源 k），於是在序列空間標出來的範圍
// 會讓 playRange 播錯段、extractRange 刪錯段；只有「隱含序列」t == k 時碰巧對，所以平常測不出來。
describe("I / O 標點：範圍的座標跟著空間走", () => {
  /** 非隱含序列：片段取來源 100..200，所以序列幀 t 與來源幀 k 固定差 100。 */
  const nonImplicit = () => seqOf([vclip("clip-1", "m1", 100, 200)]);

  function at(k: number, t: number | null) {
    usePlayback.getState().seek(k);
    usePlayback.getState().setSeqFrame(t);
  }

  it("序列空間標序列幀、素材空間標來源幀（修正前兩者都是來源幀）", async () => {
    useEdits.getState().loadSequence(nonImplicit(), []);
    at(150, 50);

    useTimeline.setState({ space: "sequence" });
    await runCommand("playback.markIn", "hotkey");
    expect(useTimeline.getState().pendingIn).toBe(50);

    useTimeline.setState({ space: "source", range: null, pendingIn: null, pendingOut: null });
    await runCommand("playback.markIn", "hotkey");
    expect(useTimeline.getState().pendingIn).toBe(150);
  });

  it("序列空間：I / O 標出來的就是要刪 / 要播的那一段", async () => {
    useEdits.getState().loadSequence(nonImplicit(), []);
    useTimeline.setState({ space: "sequence" });
    at(120, 20);
    await runCommand("playback.markIn", "hotkey");
    at(160, 60);
    await runCommand("playback.markOut", "hotkey");
    expect(useTimeline.getState().range).toEqual({ in: 20, out: 60 });
  });

  // 使用者看到的提示走 ui.tsx 的 toast（不是 registry 注入的那個 info），這裡只驗「什麼都沒標」
  it("播放線這一幀沒有用在序列裡：什麼都不標，不會默默標到錯的幀", async () => {
    useEdits.getState().loadSequence(nonImplicit(), []);
    useTimeline.setState({ space: "sequence" });
    at(10, null); // 來源 10 不在片段的 [100, 200)
    await runCommand("playback.markIn", "hotkey");
    expect(useTimeline.getState().pendingIn).toBeNull();
    expect(useTimeline.getState().range).toBeNull();
  });
});

// X = Final Cut 的 Mark Clip：序列時間軸上是「這個片段」，素材時間軸上是「這個鏡頭」。
describe("X：把片段／鏡頭設為範圍", () => {
  it("X 歸派發指令，原主人保留鍵的顯示但不自己派發", () => {
    expect(chordOwners().get(chordKey(parseShortcut("X")))).toBe("playback.markClipOrShot");
    expect(command("playback.markShot")!.shortcutManual).toBe(true);
  });

  it("序列空間：選取的片段變成範圍，多選取聯集外框", async () => {
    useEdits.getState().loadSequence(seqOf([vclip("clip-1", "m1", 0, 100), gap("gap-1", 10), vclip("clip-2", "m1", 100, 200)]), []);
    useTimeline.getState().selectClips(["clip-1"]);
    await runCommand("playback.markClipOrShot", "hotkey");
    expect(useTimeline.getState().range).toEqual({ in: 0, out: 100 });
    expect(useTimeline.getState().focus).toBe("range");

    useTimeline.getState().selectClips(["clip-1", "clip-2"]);
    await runCommand("playback.markClipOrShot", "hotkey");
    expect(useTimeline.getState().range).toEqual({ in: 0, out: 210 });
  });

  it("序列空間沒選片段：灰掉並講原因（不會默默跑去標鏡頭）", () => {
    useEdits.getState().loadSequence(seqOf([vclip("clip-1", "m1", 0, 100)]), []);
    useTimeline.getState().selectClips([]);
    const en = command("playback.markClipOrShot")!.enabled();
    expect(en.ok).toBe(false);
    if (!en.ok) expect(en.why.length).toBeGreaterThan(0);
  });

  it("素材空間：轉回原本的「鏡頭設為範圍」", () => {
    useTimeline.setState({ space: "source" });
    expect(command("playback.markClipOrShot")!.enabled()).toEqual(command("playback.markShot")!.enabled());
  });
});

describe("播放選取（/）與繞著播放線播（Shift+/）", () => {
  it("兩顆鍵各有主人，而且沒有撞鍵", () => {
    expect(chordOwners().get(chordKey(parseShortcut("/")))).toBe("playback.playSelection");
    expect(chordOwners().get(chordKey(parseShortcut("Shift+/")))).toBe("playback.playAround");
    expect(duplicateChords()).toEqual([]);
  });

  it("播放選取不綁「先標範圍」：沒有範圍也不該灰掉（不然就違背了「播選取」）", () => {
    useTimeline.setState({ range: null, pendingIn: null, pendingOut: null });
    expect(command("playback.playSelection")!.enabled()).toEqual(command("playback.toggle")!.enabled());
  });
});
