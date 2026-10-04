// M2.4 undo 整合（docs/editor-m2-design.md §6、§13 M2.4 驗收）：editSequence / PROJECT_SCOPE / clear 規則 / 音訊媒體。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioMediaV2, ProjectMediaV2, SequenceV2 } from "../project/format";
import { makeSeqCtx } from "../sequence/context";
import * as ops from "../sequence/ops";
import { A_MUSIC, CTX, M1, M2, M25, MNOPROXY } from "../sequence/testkit";
import { validateSequence } from "../sequence/validate";
import { rectQuad } from "../video/quad";

const markDirty = vi.fn();
const project: { markDirty: typeof markDirty; media: ProjectMediaV2[]; activeMediaId: string | null } = { markDirty, media: [], activeMediaId: null };
vi.mock("./project", () => ({ useProject: { getState: () => project } }));

const { useEdits, PROJECT_SCOPE, SEQ_EDIT_LABEL, historyAfterRemoval, carryAudioInfo, sequenceUsesMedia } = await import("./edits");

// 外掛的專案層狀態（例如牌外掛的牌組）掛在某支媒體的那一筆 patch 上：以前是 setDeck，現在是通用的 commitEdit
const DECK = { styleId: "demo-deck", source: "builtin" };
const setProjectState = (mediaId: string, deck: Record<string, unknown>) => useEdits.getState().commitEdit(mediaId, "切換牌組", { pluginProject: { deck } });

const Q = rectQuad(100, 100, 60, 90);
const L = SEQ_EDIT_LABEL;
const MUSIC = { type: "audio", audioId: "a-music" } as const;

const st = () => useEdits.getState();
const seq = () => st().sequence as SequenceV2;

beforeEach(() => {
  st().reset();
  markDirty.mockClear();
  project.media = [M1, M2, M25, MNOPROXY];
  project.activeMediaId = "m1";
});

describe("editSequence：實體化與 I1", () => {
  it("隱含序列上分割 → 實體化＋分割同一筆；undo 回到 null，tracks / shots / pluginMedia / captions 參照完全沒動（I1）", () => {
    st().load("m1", {});
    const trackId = st().addTrack("m1", { frame: 10, quad: Q, frames: 1797 });
    const before = st();
    expect(st().editSequence(L.split, (s, ctx) => ops.splitAt(s, 100, ctx))).toBe(true);

    const after = st();
    expect(after.sequence?.video.map((it) => it.id)).toEqual(["clip-1", "clip-2"]);
    expect(validateSequence(seq(), CTX)).toEqual([]);
    // I1：連 Record 本身的參照都相同（PROJECT_SCOPE 的 apply 不寫 per-media 的 map）
    expect(after.tracks).toBe(before.tracks);
    expect(after.shots).toBe(before.shots);
    expect(after.pluginMedia).toBe(before.pluginMedia);
    expect(after.captions).toBe(before.captions);
    expect(after.pluginProject).toBe(before.pluginProject);
    expect(after.tracks.m1[0].id).toBe(trackId);
    const p = after.past[after.past.length - 1];
    expect(p).toMatchObject({ label: "分割片段", mediaId: PROJECT_SCOPE });
    expect(p.before.sequence).toBeNull();
    expect(p.after.sequence).toBe(after.sequence);
    expect(p.after.tracks).toBe(p.before.tracks);
    expect(p.after.shots).toBe(p.before.shots);
    expect(p.after.pluginMedia).toBe(p.before.pluginMedia);
    expect(markDirty).toHaveBeenCalled();
    for (const rec of [after.shots, after.tracks, after.pluginMedia, after.captions]) expect(PROJECT_SCOPE in rec).toBe(false);

    st().undo();
    expect(st().sequence).toBeNull();
    expect(st().tracks).toBe(before.tracks);
    expect(st().tracks.m1).toBe(before.tracks.m1);
    expect(st().shots).toBe(before.shots);
    for (const rec of [st().shots, st().tracks, st().pluginMedia, st().captions]) expect(PROJECT_SCOPE in rec).toBe(false);

    st().redo();
    expect(st().sequence).toBe(p.after.sequence);
    expect(st().tracks).toBe(before.tracks);
  });

  it("沒剪到（在剪輯點上分割）或 f 回 null：不實體化、不留 undo、不標 dirty", () => {
    expect(st().editSequence(L.split, (s, ctx) => ops.splitAt(s, 0, ctx))).toBe(false);
    expect(st().editSequence(L.split, () => null)).toBe(false);
    expect(st().sequence).toBeNull();
    expect(st().past).toHaveLength(0);
    expect(markDirty).not.toHaveBeenCalled();
  });

  it("f 回 null 時連 opts.audioMedia 都不套", () => {
    expect(st().editSequence(L.addAudio, () => null, { audioMedia: [A_MUSIC] })).toBe(false);
    expect(st().audioMedia).toEqual([]);
  });

  it("實體化用作用中媒體；沒有作用中媒體 / 還沒有 proxy → 擲 SequenceError，狀態不變", () => {
    project.activeMediaId = "m2";
    st().editSequence(L.split, (s, ctx) => ops.splitAt(s, 10, ctx));
    expect(seq().video.map((it) => it.kind === "clip" && it.mediaId)).toEqual(["m2", "m2"]);
    st().reset();

    project.activeMediaId = "mnone";
    expect(() => st().editSequence(L.split, (s, ctx) => ops.splitAt(s, 10, ctx))).toThrow(expect.objectContaining({ name: "SequenceError", code: "noProxy" }));
    project.activeMediaId = null;
    expect(() => st().editSequence(L.split, (s, ctx) => ops.splitAt(s, 10, ctx))).toThrow(expect.objectContaining({ code: "notFound" }));
    expect(st().sequence).toBeNull();
    expect(st().past).toHaveLength(0);
  });

  it("f 擲錯（fps 不符）→ 原樣往外丟、狀態不變；已實體化的序列也不動", () => {
    st().editSequence(L.split, (s, ctx) => ops.splitAt(s, 100, ctx));
    const cur = st().sequence;
    expect(() => st().editSequence(L.addMedia, (s) => ops.appendMedia(s, M25))).toThrow(expect.objectContaining({ code: "fpsMismatch" }));
    expect(st().sequence).toBe(cur);
    expect(st().past).toHaveLength(1);
  });

  it("ctx 看得到專案媒體與「這一筆之後」的音訊媒體：匯入音樂並放上音軌是同一筆，一次 Ctrl+Z 兩個一起收回", () => {
    const ok = st().editSequence(L.addAudio, (s, ctx) => ops.addAudioClip(s, null, MUSIC, 48000, ctx), { audioMedia: [...st().audioMedia, A_MUSIC] });
    expect(ok).toBe(true);
    expect(st().audioMedia).toEqual([A_MUSIC]);
    expect(seq().audioLanes[0].clips[0]).toMatchObject({ source: MUSIC, start: 48000, length: 2880000 });
    expect(validateSequence(seq(), makeSeqCtx(project.media, st().audioMedia))).toEqual([]);
    expect(st().past).toHaveLength(1);
    st().undo();
    expect(st().sequence).toBeNull();
    expect(st().audioMedia).toEqual([]);
  });

  it("coalesceKey：連續拖推桿合併成一筆，undo 一次回到拖之前", () => {
    st().editSequence(L.addAudio, (s, ctx) => ops.addAudioClip(s, null, MUSIC, 0, ctx), { audioMedia: [A_MUSIC] });
    const placed = st().sequence;
    for (const db of [-1, -2, -3, -4]) st().editSequence(L.gain, (s) => ops.setGain(s, ["aclip-1"], db), { coalesceKey: "gain:aclip-1" });
    expect(st().past.map((p) => p.label)).toEqual(["加入音訊", "音訊增益"]);
    expect(seq().audioLanes[0].clips[0].gainDb).toBe(-4);
    st().undo();
    expect(st().sequence).toBe(placed);
  });

  it("追蹤 patch 與序列 patch 交錯 20 步：逐步 undo 到底、再逐步 redo 回來，每一步的整體狀態都跟當時一模一樣（參照相同）", () => {
    st().load("m1", {});
    let trackId = "";
    const steps: (() => void)[] = [
      () => st().editSequence(L.split, (s, ctx) => ops.splitAt(s, 100, ctx)),
      () => (trackId = st().addTrack("m1", { frame: 10, quad: Q, frames: 1797 })),
      () => st().editSequence(L.split, (s, ctx) => ops.splitAt(s, 400, ctx)),
      () => st().setUserKeyframe("m1", trackId, 20, rectQuad(110, 100, 60, 90)),
      () => st().editSequence(L.addAudio, (s, ctx) => ops.addAudioClip(s, null, MUSIC, 48000, ctx, { length: 96000 }), { audioMedia: [A_MUSIC] }),
      () => setProjectState("m1", { ...DECK, styleId: "other-deck" }),
      () => st().editSequence(L.rippleDelete, (s, ctx) => ops.rippleDelete(s, ["clip-2"], ctx)),
      () => st().addTrack("m1", { frame: 500, quad: Q, frames: 1797 }),
      () => st().editSequence(L.disable, (s) => ops.setEnabled(s, ["clip-3"], false)),
      () => st().setShots("m1", [{ id: "s1", startFrame: 0, endFrame: 1797, kind: "wide", source: "user" }]),
      () => st().editSequence(L.gain, (s) => ops.setGain(s, ["aclip-1"], -6)),
      () => st().setTrackOptions("m1", trackId, { smoothing: 0.7 }),
      () => st().editSequence(L.split, (s, ctx) => ops.splitAt(s, 200, ctx)),
      () => st().setTrackFields("m1", trackId, { label: "Player1" }, "改名"),
      () => st().editSequence(L.join, (s, ctx) => ops.joinThroughEdit(s, 200, ctx)),
      () => st().removeKeyframe("m1", trackId, 20),
      () => st().editSequence(L.enable, (s) => ops.setEnabled(s, ["clip-3"], true)),
      () => setProjectState("m1", DECK),
      () => st().removeAudioMedia("a-music"),
      () => st().removeTrack("m1", trackId),
    ];
    const view = () => {
      const s = st();
      return { shots: s.shots.m1, tracks: s.tracks.m1, pluginMedia: s.pluginMedia.m1, captions: s.captions.m1, pluginProject: s.pluginProject, sequence: s.sequence, audioMedia: s.audioMedia };
    };
    const same = (a: ReturnType<typeof view>, b: ReturnType<typeof view>, at: string) => {
      for (const k of Object.keys(a) as (keyof typeof a)[]) expect(a[k], `${at}: ${k}`).toBe(b[k]);
    };

    const states = [view()];
    steps.forEach((step, i) => {
      step();
      expect(st().past, `第 ${i + 1} 步沒有留下 undo`).toHaveLength(i + 1);
      if (st().sequence) expect(validateSequence(seq(), makeSeqCtx(project.media, st().audioMedia))).toEqual([]);
      states.push(view());
    });
    expect(st().past.filter((p) => p.mediaId === PROJECT_SCOPE)).toHaveLength(10);

    for (let i = steps.length; i > 0; i--) {
      st().undo();
      same(view(), states[i - 1], `undo 到第 ${i - 1} 步`);
      // LIFO 一致性：頂端那筆的 after 永遠等於現況
      const top = st().past[st().past.length - 1];
      if (top) expect(top.after.sequence).toBe(st().sequence);
    }
    expect(st().sequence).toBeNull();
    for (let i = 1; i <= steps.length; i++) {
      st().redo();
      same(view(), states[i], `redo 到第 ${i} 步`);
    }
    for (const rec of [st().shots, st().tracks, st().pluginMedia, st().captions]) expect(PROJECT_SCOPE in rec).toBe(false);

    // jumpTo 走的是同一套 undo / redo
    st().jumpTo(5);
    same(view(), states[5], "jumpTo(5)");
  });
});

describe("音訊媒體清單", () => {
  it("editAudioMedia：只動清單、不實體化序列（沒有作用中媒體也行）", () => {
    project.activeMediaId = null;
    expect(st().editAudioMedia(L.addAudio, (list) => [...list, A_MUSIC])).toBe(true);
    expect(st().editAudioMedia(L.addAudio, (list) => list)).toBe(false);
    expect(st().editAudioMedia(L.addAudio, () => null)).toBe(false);
    expect(st().sequence).toBeNull();
    expect(st().audioMedia).toEqual([A_MUSIC]);
    expect(st().past).toHaveLength(1);
    expect(st().past[0].mediaId).toBe(PROJECT_SCOPE);
  });

  it("editSequence 回傳同一個參照但 opts.audioMedia 變了：序列維持 null、只留清單那一筆", () => {
    expect(st().editSequence(L.addAudio, (s) => s, { audioMedia: [A_MUSIC] })).toBe(true);
    expect(st().sequence).toBeNull();
    expect(st().audioMedia).toEqual([A_MUSIC]);
  });

  it("removeAudioMedia：連片段（含鎖定的軌）一起刪，一筆 undo 兩個都回來；不存在的 id 不留 undo", () => {
    st().editSequence(L.addAudio, (s, ctx) => ops.addAudioClip(s, null, MUSIC, 0, ctx), { audioMedia: [A_MUSIC] });
    st().editSequence(L.syncLock, (s) => ops.setLane(s, "lane-1", { locked: true }));
    const placed = st().sequence;
    const list = st().audioMedia;
    expect(st().removeAudioMedia("ghost")).toBe(false);
    expect(st().removeAudioMedia("a-music")).toBe(true);
    expect(st().audioMedia).toEqual([]);
    expect(seq().audioLanes[0].clips).toEqual([]);
    expect(st().past[st().past.length - 1]).toMatchObject({ label: "移除音訊媒體", mediaId: PROJECT_SCOPE });
    st().undo();
    expect(st().sequence).toBe(placed);
    expect(st().audioMedia).toBe(list);
  });

  it("setAudioMediaInfo 不記 undo；undo 不相干的動作時，已算好的資訊帶過去（同指紋）", () => {
    const bare: AudioMediaV2 = { ...A_MUSIC, audio: null };
    st().editAudioMedia(L.addAudio, (l) => [...l, bare]);
    st().addTrack("m1", { frame: 1, quad: Q, frames: 10 });
    const n = st().past.length;
    st().setAudioMediaInfo("a-music", A_MUSIC.audio);
    st().setAudioMediaInfo("ghost", A_MUSIC.audio);
    expect(st().past).toHaveLength(n);
    expect(st().audioMedia[0].audio).toBe(A_MUSIC.audio);
    st().undo(); // addTrack 的快照裡清單還是 audio: null 的那份
    expect(st().audioMedia[0].audio).toBe(A_MUSIC.audio);
    st().undo(); // 匯入本身被復原 → 清單空了
    expect(st().audioMedia).toEqual([]);
  });

  it("carryAudioInfo：指紋不同不帶；沒得帶時回原參照", () => {
    const restored = [{ ...A_MUSIC, audio: null }];
    expect(carryAudioInfo(restored, [])).toBe(restored);
    expect(carryAudioInfo(restored, [{ ...A_MUSIC, fingerprint: "other" }])).toBe(restored);
    expect(carryAudioInfo(restored, [{ ...A_MUSIC, audio: null }])).toBe(restored);
    expect(carryAudioInfo(restored, [A_MUSIC])[0].audio).toBe(A_MUSIC.audio);
  });
});

describe("clear(mediaId)：移除媒體與復原歷史（§6）", () => {
  const appendM2 = () => st().editSequence(L.addMedia, (s) => ops.appendMedia(s, M2));

  it("序列用到被移除的媒體：片段一起刪、整個歷史清掉（回傳 true）、標 dirty", () => {
    appendM2();
    st().addTrack("m1", { frame: 1, quad: Q, frames: 10 });
    st().addTrack("m2", { frame: 1, quad: Q, frames: 10 });
    st().undo(); // future 也要清
    markDirty.mockClear();
    expect(st().clear("m2")).toBe(true);
    expect(st().past).toEqual([]);
    expect(st().future).toEqual([]);
    expect(seq().video.map((it) => it.kind === "clip" && it.mediaId)).toEqual(["m1"]);
    expect(sequenceUsesMedia(st().sequence, "m2")).toBe(false);
    expect(st().tracks.m2).toBeUndefined();
    expect(st().tracks.m1).toHaveLength(1);
    expect(markDirty).toHaveBeenCalled();
  });

  it("分離出來的原音片段也算「用到」：連鎖定的軌一起刪", () => {
    project.media = [M1, M2];
    appendM2();
    st().editSequence(L.detachAudio, (s, ctx) => ops.detachAudio(s, "clip-2", ctx));
    st().editSequence(L.syncLock, (s) => ops.setLane(s, s.audioLanes[0].id, { locked: true }));
    expect(sequenceUsesMedia(st().sequence, "m2")).toBe(true);
    st().clear("m2");
    expect(sequenceUsesMedia(st().sequence, "m2")).toBe(false);
    expect(validateSequence(seq(), CTX)).toEqual([]);
  });

  it("移除之後序列什麼都不剩 → 回到隱含序列（null）", () => {
    st().editSequence(L.split, (s, ctx) => ops.splitAt(s, 100, ctx));
    expect(st().clear("m1")).toBe(true);
    expect(st().sequence).toBeNull();
  });

  it("沒剪輯的專案（M1 的常見情況）：只抽掉這支媒體的 patch，其他媒體的歷史保留（回傳 false）", () => {
    st().addTrack("m1", { frame: 1, quad: Q, frames: 10 });
    st().addTrack("m2", { frame: 1, quad: Q, frames: 10 });
    st().addTrack("m1", { frame: 2, quad: Q, frames: 10 });
    expect(st().clear("m1")).toBe(false);
    expect(st().past.map((p) => p.mediaId)).toEqual(["m2"]);
    st().undo();
    expect(st().tracks.m2).toEqual([]);
  });

  it("這支媒體的 patch 改了專案層（外掛的專案層狀態，例如切換牌組）→ 抽不掉，整個清", () => {
    setProjectState("m1", { ...DECK, styleId: "other-deck" });
    st().addTrack("m2", { frame: 1, quad: Q, frames: 10 });
    expect(st().clear("m1")).toBe(true);
    expect(st().past).toEqual([]);
  });

  it("現在的序列已經不用它、但歷史裡的序列快照用過 → 整個清（不然 undo 會把指向不存在媒體的片段變回來）", () => {
    appendM2();
    st().editSequence(L.rippleDelete, (s, ctx) => ops.rippleDelete(s, ["clip-2"], ctx));
    const cur = st().sequence;
    expect(st().clear("m2")).toBe(true);
    expect(st().sequence).toBe(cur);
    expect(st().past).toEqual([]);
  });

  it("沒有歷史時：序列照樣清掉引用，回傳 false（沒有東西被丟掉，不必提示）", () => {
    const loaded = ops.appendMedia(ops.materialize(M1), M2);
    st().loadSequence(loaded, []);
    expect(st().clear("m2")).toBe(false);
    expect(seq().video).toHaveLength(1);
  });

  it("historyAfterRemoval 純函式：sequenceChanged 一律清", () => {
    st().addTrack("m2", { frame: 1, quad: Q, frames: 10 });
    const { past, future } = st();
    expect(historyAfterRemoval(past, future, "m1", true)).toEqual({ past: [], future: [], cleared: true });
    expect(historyAfterRemoval(past, future, "m1", false)).toEqual({ past, future, cleared: false });
  });
});

describe("load / reset", () => {
  it("loadSequence 不記 undo、不標 dirty；reset 回到隱含序列與空清單", () => {
    const s = ops.materialize(M1);
    st().loadSequence(s, [A_MUSIC]);
    expect(st().sequence).toBe(s);
    expect(st().audioMedia).toEqual([A_MUSIC]);
    expect(st().past).toHaveLength(0);
    expect(markDirty).not.toHaveBeenCalled();
    st().reset();
    expect(st().sequence).toBeNull();
    expect(st().audioMedia).toEqual([]);
  });
});
