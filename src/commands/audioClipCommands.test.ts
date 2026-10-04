// M2.15 音訊片段編輯指令（docs/editor-m2-design.md §10.2、§11、§13 M2.15 驗收）：
// 沒有撞鍵（Ctrl+Alt+L、Ctrl+Shift+D）；分離音訊在 startUs ≠ videoStartUs 時 srcIn 正確、隱含序列一次 undo 回 null；
// 閃避跨兩個片段兩邊都有點；增益 / 淡化子選單；Delete 在焦點 envPoint 時刪自動化點；音軌右鍵；音訊片段與音軌的選單內容。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuItem } from "../ui/MenuPanel";

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
const AC = await import("./audioClipCommands");
const M = await import("./menuModel");
const { command, duplicateChords, registerCommands, resetCommands, runCommand, setCommandHost } = await import("./registry");
const { chordKey, parseShortcut } = await import("./shortcut");
const { useEdits } = await import("../store/edits");
const { useProject } = await import("../store/project");
const { usePlayback } = await import("../store/playback");
const { useSettings } = await import("../store/settings");
const { useTimeline } = await import("../store/timeline");
const { useUi } = await import("../store/ui");
const { useEnvPointSelection } = await import("../frametimeline/gainDrag");
const { validateSequence } = await import("../sequence/validate");
const { A_MUSIC, aclip, lane, seqOf, vclip } = await import("../sequence/testkit");

type SequenceV2 = import("../project/format").SequenceV2;

const BASE = () => [...coreCommands(), ...TRACK_COMMANDS, ...EXPORT_COMMANDS, ...MEDIA_INFO_COMMANDS, ...CAPTION_COMMANDS];

function registerAll(flag: boolean) {
  resetCommands();
  useSettings.setState({ experimental: { sequence: flag } });
  registerCommands([...S.handOverDispatchedChords(BASE()), ...S.sequenceCommands(flag), ...AC.audioClipCommands(flag)]);
}

const PROXY = { version: 1 as const, fps: { num: 30, den: 1 }, frames: 300, width: 1280, height: 720, scale: 1, path: "p.mp4" };
/** 音訊比畫面晚 6.5 ms 開始（M2.15 驗收的數字）。 */
const AUDIO = { codec: "opus", sampleRate: 48000, channels: 2, channelLayout: "stereo", startUs: 6500, videoStartUs: 0, nSamples: 480000, gaps: [] };
const MEDIA = { id: "m1", path: "x.webm", name: "x.webm", fingerprint: "", probe: null, proxy: PROXY, proxyState: "ready" as const, audio: AUDIO };

const seq = () => useEdits.getState().sequence as SequenceV2;
const tl = () => useTimeline.getState();
const info = vi.fn();
const error = vi.fn();

beforeEach(() => {
  registerAll(true);
  info.mockClear();
  error.mockClear();
  setCommandHost({ info, error, errMessage: (e) => (e instanceof Error ? e.message : String(e)) });
  useProject.setState({ activeMediaId: "m1", media: [MEDIA] });
  useEdits.getState().reset();
  useTimeline.setState({ space: "sequence", focus: null, selectedClipIds: [], seqTool: "select", range: null, pendingIn: null, pendingOut: null, selectedTrackId: null, selectedKeyframe: null });
  useEnvPointSelection.getState().select(null);
  usePlayback.getState().seek(0);
});

function kids(it: MenuItem | undefined): MenuItem[] {
  if (!it) return [];
  return typeof it.children === "function" ? it.children() : (it.children ?? []);
}
const ids = (items: MenuItem[]) => items.map((i) => (i.separator ? "---" : i.dataId === "ctx.header" ? `# ${String(i.label)}` : String(i.dataId)));

describe("快捷鍵與登記", () => {
  it("旗標開 / 關：duplicateChords 都是空的；Ctrl+Alt+L = 分離音訊、Ctrl+Shift+D = 套用預設淡入淡出", () => {
    expect(duplicateChords()).toEqual([]);
    const owner = (chord: string) => {
      for (const id of ["sequence.detachAudio", "audio.applyDefaultFades"]) if (command(id)?.shortcuts?.some((s) => chordKey(parseShortcut(s)) === chordKey(parseShortcut(chord)))) return id;
      return null;
    };
    expect(owner("Ctrl+Alt+L")).toBe("sequence.detachAudio");
    expect(owner("Ctrl+Shift+D")).toBe("audio.applyDefaultFades");
    registerAll(false);
    expect(duplicateChords()).toEqual([]);
    expect(command("sequence.detachAudio")?.surfaces).toEqual([]);
    expect(command("sequence.detachAudio")?.shortcuts).toBeUndefined();
  });
});

describe("分離音訊（Ctrl+Alt+L）", () => {
  it("隱含序列：實體化＋分離同一筆 undo；srcIn 以 startUs − videoStartUs 換算（−312 樣本 = 前面補 6.5 ms 靜音）；一次 Ctrl+Z 回到 null", async () => {
    tl().selectClips(["clip-1"]);
    expect(command("sequence.detachAudio")!.enabled()).toEqual({ ok: true });
    await runCommand("sequence.detachAudio", "hotkey");
    const s = seq();
    expect(s.video[0].kind === "clip" && s.video[0].audio).toMatchObject({ enabled: false, detachedTo: s.audioLanes[0].clips[0].id });
    expect(s.audioLanes[0].clips[0]).toMatchObject({ source: { type: "media", mediaId: "m1" }, start: 0, length: 480000, srcIn: -312, detachedFrom: "clip-1" });
    expect(validateSequence(s)).toEqual([]);
    expect(useEdits.getState().past.map((p) => p.label)).toEqual(["分離音訊"]);
    // 已經分離：灰掉並講原因
    expect(command("sequence.detachAudio")!.enabled()).toMatchObject({ ok: false });
    await runCommand("edit.undo", "hotkey");
    expect(useEdits.getState().sequence).toBeNull();
  });

  it("媒體還沒有音訊時間資訊：灰掉、講「還在分析」", () => {
    useProject.setState({ media: [{ ...MEDIA, audio: null }] as never });
    tl().selectClips(["clip-1"]);
    expect(command("sequence.detachAudio")!.enabled()).toEqual({ ok: false, why: "還在分析原音的時間資訊，稍後再試" });
  });
});

describe("閃避 / 靜音範圍", () => {
  it("M2.15 驗收：閃避跨兩個片段，兩邊都有點（沒選取 → 音樂軌）", async () => {
    const s = seqOf([vclip("clip-1", "m1", 0, 300)], [lane("lane-1", "music", [aclip("a1", A_MUSIC.id, 0, 240000), aclip("a2", A_MUSIC.id, 240000, 240000)])]);
    useEdits.getState().loadSequence(s, [A_MUSIC]);
    tl().setRange({ in: 120, out: 180 });
    await runCommand("audio.duckRange", "palette");
    const [a1, a2] = seq().audioLanes[0].clips;
    expect(a1.envelope.length).toBeGreaterThan(0);
    expect(a2.envelope.length).toBeGreaterThan(0);
    expect(a1.envelope.some((p) => p.db === -10)).toBe(true);
    expect(a2.envelope.some((p) => p.db === -10)).toBe(true);
    expect(useEdits.getState().past.map((p) => p.label)).toEqual(["閃避範圍"]);
  });

  it("在範圍內靜音原音：寫在 A0（V1 片段的原音）；沒有範圍時灰掉講原因", async () => {
    expect(command("audio.muteOriginalInRange")!.enabled()).toEqual({ ok: false, why: AC.NO_RANGE_WHY });
    tl().setRange({ in: 30, out: 60 });
    await runCommand("audio.muteOriginalInRange", "context");
    const c = seq().video[0];
    expect(c.kind === "clip" && c.audio.envelope.some((p) => p.db === -96)).toBe(true);
  });

  it("選了音訊片段 → 對它的軌；選了 V1 片段 → A0；沒選 → 閃避對音樂軌、靜音對原音", () => {
    const s = seqOf([vclip("c1", "m1", 0, 300)], [lane("l1", "voiceover", [aclip("a1", A_MUSIC.id, 0, 48000)]), lane("l2", "music", [aclip("a2", A_MUSIC.id, 0, 48000)])]);
    expect(AC.rangeAudioTargets(s, ["a1"], "duck")).toEqual(["l1"]);
    expect(AC.rangeAudioTargets(s, ["c1"], "duck")).toBe("A0");
    expect(AC.rangeAudioTargets(s, [], "duck")).toEqual(["l2"]);
    expect(AC.rangeAudioTargets(s, [], "mute")).toBe("A0");
  });
});

describe("增益 / 淡化 / 自動化點", () => {
  function loadMusic() {
    const s = seqOf([vclip("clip-1", "m1", 0, 300)], [lane("lane-1", "music", [aclip("a1", A_MUSIC.id, 48000, 96000, { envelope: [{ at: 0, db: 0 }, { at: 48000, db: -6 }] })])]);
    useEdits.getState().loadSequence(s, [A_MUSIC]);
    tl().selectClips(["a1"]);
  }

  it("增益 ▸ −6 dB：選取的片段、一筆「音訊增益」、勾選狀態跟著變", async () => {
    loadMusic();
    const preset = command("audio.gain.-6")!;
    expect(preset.checked!()).toBe(false);
    await runCommand("audio.gain.-6", "context");
    expect(seq().audioLanes[0].clips[0].gainDb).toBe(-6);
    expect(preset.checked!()).toBe(true);
    expect(useEdits.getState().past.map((p) => p.label)).toEqual(["音訊增益"]);
  });

  it("淡入 ▸ 1 秒、淡化曲線 ▸ 等功率、套用預設淡入淡出（本機偏好 0.25 s）", async () => {
    loadMusic();
    await runCommand("audio.fadeIn.1", "context");
    expect(seq().audioLanes[0].clips[0].fadeIn).toBe(48000);
    await runCommand("audio.fadeCurve.equalPower", "context");
    expect(seq().audioLanes[0].clips[0].fadeCurve).toBe("equalPower");
    AC.useAudioPrefs.getState().setDefaultFadeSeconds(0.25);
    await runCommand("audio.applyDefaultFades", "hotkey");
    expect(seq().audioLanes[0].clips[0]).toMatchObject({ fadeIn: 12000, fadeOut: 12000 });
    AC.useAudioPrefs.getState().setDefaultFadeSeconds(AC.DEFAULT_FADE_SECONDS);
  });

  it("Delete 在焦點 envPoint 時刪選中的自動化點（派發表 §10.1）；清除音量自動化", async () => {
    loadMusic();
    useEnvPointSelection.getState().select({ target: { kind: "audio", clipId: "a1", laneId: "lane-1" }, index: 1 });
    tl().setFocus("envPoint");
    expect(S.deleteDispatch("delete", S.deleteDispatchStateNow())).toEqual({ id: "audio.deleteEnvelopePoint" });
    expect(command("edit.delete")!.enabled()).toEqual({ ok: true });
    await runCommand("edit.delete", "hotkey");
    // 剩下的點全是 0 dB → 清成 []（聽起來一樣，輸出閘門也回來）
    expect(seq().audioLanes[0].clips[0].envelope).toEqual([]);
    expect(useEnvPointSelection.getState().sel).toBeNull();
    expect(tl().focus).toBe("clip");
    expect(command("audio.clearAutomation")!.enabled()).toMatchObject({ ok: false });
  });

  it("靜音片段（音訊片段）與靜音原音（V1 片段）是兩個勾選", async () => {
    loadMusic();
    await runCommand("audio.toggleClipMute", "context");
    expect(seq().audioLanes[0].clips[0].enabled).toBe(false);
    expect(command("audio.toggleClipMute")!.checked!()).toBe(true);
    tl().selectClips(["clip-1"]);
    await runCommand("audio.toggleOriginalMute", "context");
    const c = seq().video[0];
    expect(c.kind === "clip" && c.audio.enabled).toBe(false);
  });

  it("片段資訊…：切到 Inspector「片段」頁", async () => {
    loadMusic();
    useUi.getState().setTab("cards");
    await runCommand("audio.clipInfo", "context");
    expect(useUi.getState().tab).toBe("clip");
  });
});

describe("右鍵選單（§11）", () => {
  function loadTwoLanes() {
    const s = seqOf([vclip("clip-1", "m1", 0, 300)], [lane("lane-1", "music", [aclip("a1", A_MUSIC.id, 0, 96000)]), lane("lane-2", "sfx", [])]);
    useEdits.getState().loadSequence(s, [A_MUSIC]);
    return s;
  }

  it("音訊片段：分割 / 刪除之後接 靜音、增益 ▸ 淡入 ▸ 淡出 ▸ 曲線 ▸、範圍內閃避 / 靜音、移到新音軌…、片段資訊", () => {
    const s = loadTwoLanes();
    tl().selectClips(["a1"]);
    const items = M.audioClipMenuItems({ seq: s, frame: 10 }, "a1");
    const got = ids(items);
    for (const id of ["audio.toggleClipMute", "audio.gain", "audio.fadeIn", "audio.fadeOut", "audio.fadeCurve", "audio.duckRange", "audio.muteRange", "audio.clearAutomation", "audio.moveToNewLane", "audio.revealInExplorer", "audio.clipInfo"]) expect(got, id).toContain(id);
    expect(got.indexOf("sequence.rippleDelete")).toBeLessThan(got.indexOf("audio.toggleClipMute"));
    expect(ids(kids(items.find((i) => i.dataId === "audio.gain")))).toEqual(["audio.gain.3", "audio.gain.0", "audio.gain.-3", "audio.gain.-6", "audio.gain.-12", "audio.gain.custom"]);
    // 沒有範圍：閃避項目灰掉並講原因
    expect(items.find((i) => i.dataId === "audio.duckRange")).toMatchObject({ muted: true });
    // 不是從影片分離出來的：「跳到來源片段」灰掉（右鍵裡仍列，講原因）
    expect(items.find((i) => i.dataId === "audio.jumpToSourceClip")).toMatchObject({ muted: true });
  });

  it("V1 片段「原音 ▸」：靜音原音、分離音訊、增益 ▸、淡入 ▸、淡出 ▸…", () => {
    const s = loadTwoLanes();
    tl().selectClips(["clip-1"]);
    const items = M.clipMenuItems({ seq: s, frame: 10 }, "clip-1");
    const original = kids(items.find((i) => i.dataId === "ctx.clip.original"));
    expect(ids(original)).toEqual(["audio.toggleOriginalMute", "sequence.detachAudio", "audio.gain", "audio.fadeIn", "audio.fadeOut", "audio.applyDefaultFades", "audio.clearAutomation"]);
    expect(ids(items)).toContain("audio.clipInfo");
  });

  it("音軌空白處：在這裡加入音訊…／新增音軌／刪除音軌（非空時停用）、靜音軌／同步鎖（勾選）／角色 ▸", async () => {
    const s = loadTwoLanes();
    const menu = M.audioLaneMenuItems({ seq: s, frame: 10 }, "lane-1");
    expect(ids(menu)).toEqual(["# lane-1", "ctx.audioLane.playFromHere", "---", "audio.lane.addHere", "audio.newLane", "audio.lane.delete", "---", "audio.lane.mute", "audio.lane.syncLock", "audio.lane.role"]);
    expect(menu.find((i) => i.dataId === "audio.lane.delete")).toMatchObject({ muted: true, title: "音軌裡還有片段：先刪掉片段" });
    expect(menu.find((i) => i.dataId === "audio.lane.syncLock")).toMatchObject({ checked: false });
    expect(ids(kids(menu.find((i) => i.dataId === "audio.lane.role")))).toEqual(["audio.lane.role.music", "audio.lane.role.voiceover", "audio.lane.role.sfx", "audio.lane.role.other"]);
    await runCommand("audio.lane.mute", "context");
    expect(seq().audioLanes[0].muted).toBe(true);
    await runCommand("audio.lane.role.voiceover", "context");
    expect(seq().audioLanes[0].role).toBe("voiceover");
    // 空的那條可以刪
    M.audioLaneMenuItems({ seq: seq(), frame: 10 }, "lane-2");
    await runCommand("audio.lane.delete", "context");
    expect(seq().audioLanes.map((l) => l.id)).toEqual(["lane-1"]);
  });

  it("範圍選單的序列追加：在範圍內閃避所有音樂軌／在範圍內靜音原音", () => {
    loadTwoLanes();
    tl().setRange({ in: 0, out: 30 });
    const ctx = M.timelineMenuCtxNow({ kind: "range", part: "body", frame: 10, range: { in: 0, out: 30 } });
    const got = ids(M.rangeMenuItems(ctx));
    expect(got).toContain("audio.duckMusicInRange");
    expect(got).toContain("audio.muteOriginalInRange");
  });
});

describe("小工具", () => {
  it("dB 輸入：接受 −、全形加號、尾端 dB；看不懂回 null", () => {
    expect(AC.parseDbInput("−3")).toBe(-3);
    expect(AC.parseDbInput("＋2.5 dB")).toBe(2.5);
    expect(AC.parseDbInput("abc")).toBeNull();
    expect(AC.signedDb(-12)).toBe("−12");
    expect(AC.signedDb(3)).toBe("+3");
    expect(AC.parseAudioPrefs("{\"defaultFadeSeconds\": 999}")).toEqual({ defaultFadeSeconds: 60 });
    expect(AC.parseAudioPrefs("nope")).toEqual({ defaultFadeSeconds: AC.DEFAULT_FADE_SECONDS });
  });
});
