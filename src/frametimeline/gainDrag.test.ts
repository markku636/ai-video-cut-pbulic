// M2.15 音訊片段的增益手勢（§9.5 拖淡化把手 / 拖音量線 / Alt+點音量線、§13 M2.15）：
// 純函式規則（吸附、夾住、細調、拖到底 = 靜音、新增點不改變曲線）＋ 接上 edits store（預覽不碰 store、放開一筆 undo、
// 隱含序列在同一筆實體化，undo 回到 null 且追蹤資料參照不變 I1）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectMediaV2 } from "../project/format";
import { makeSeqCtx } from "../sequence/context";
import { envelopeDbAt } from "../sequence/envelope";
import { A_MUSIC, M1, M2, aclip, lane, seqOf, vclip } from "../sequence/testkit";
import { validateSequence } from "../sequence/validate";
import { rectQuad } from "../video/quad";

const project: { markDirty: () => void; media: ProjectMediaV2[]; activeMediaId: string | null } = { markDirty: () => {}, media: [], activeMediaId: null };
vi.mock("../store/project", () => ({ useProject: { getState: () => project } }));

const { useEdits, SEQ_EDIT_LABEL } = await import("../store/edits");
const { viewSequenceOf } = await import("./layoutSequence");
const G = await import("./gainDrag");
const { envelopePointsXY } = await import("./seqGeometry");

const FPS = { num: 30, den: 1 };
const ROW = { top: 101, h: 38 };
const CTX = () => makeSeqCtx(project.media, useEdits.getState().audioMedia);

function musicSeq(over: Parameters<typeof aclip>[4] = {}, laneOver: Parameters<typeof lane>[3] = {}) {
  return seqOf([vclip("c1", "m1", 0, 300)], [lane("l1", "music", [aclip("a1", A_MUSIC.id, 48000, 96000, over)], laneOver)]);
}
const A1 = { kind: "audio", clipId: "a1", laneId: "l1" } as const;
const gainOf = (seq: ReturnType<typeof musicSeq>) => seq.audioLanes[0].clips[0];

function begin(seq: ReturnType<typeof musicSeq>, mode: "fadeIn" | "fadeOut" | "gain" | "point", extra: Partial<Parameters<typeof G.beginGainDrag>[2]> = {}) {
  const b = G.beginGainDrag(seq, A1, { mode, row: ROW, y: 60, fps: FPS, ...extra });
  if (!b.ok) throw new Error(`refused: ${b.reason}`);
  return b.drag;
}

describe("淡化把手", () => {
  it("淡入吸到幀邊界、夾在 [0, 長度 − 淡出]；Alt = 樣本級", () => {
    const seq = musicSeq({ fadeOut: 24000 });
    const d = begin(seq, "fadeIn");
    // 片段從 48000 開始；游標在 48000 + 10 000.4（≈ 6.25 幀）→ 吸到第 6 幀邊界 = 9600
    let r = G.updateGainDrag(d, { sample: 58000.4, y: 60, fps: FPS });
    expect(r.gain.fadeIn).toBe(9600);
    expect(r.tip).toEqual({ kind: "fadeIn", samples: 9600 });
    r = G.updateGainDrag(d, { sample: 58000.4, y: 60, fps: FPS, free: true });
    expect(r.gain.fadeIn).toBe(10000);
    // 拖過頭：淡入 + 淡出 ≤ 長度
    r = G.updateGainDrag(d, { sample: 999999, y: 60, fps: FPS });
    expect(r.gain.fadeIn).toBe(96000 - 24000);
    expect(r.gain.fadeOut).toBe(24000);
    // 拖回片段前面 = 0；回到原值 = origin 同一個參照（沒有變化就不 commit）
    r = G.updateGainDrag(d, { sample: 0, y: 60, fps: FPS });
    expect(r.seq).toBe(d.origin);
    expect(G.gainCommitOf(d, r)).toBeNull();
    expect(validateSequence(G.updateGainDrag(d, { sample: 60000, y: 0, fps: FPS }).seq, makeSeqCtx([M1], [A_MUSIC]))).toEqual([]);
  });

  it("淡出從片段尾端往回量", () => {
    const d = begin(musicSeq(), "fadeOut");
    const r = G.updateGainDrag(d, { sample: 48000 + 96000 - 16000, y: 60, fps: FPS });
    expect(r.gain.fadeOut).toBe(16000);
  });
});

describe("音量線（片段增益）", () => {
  it("上下拖依音量線的 dB 刻度平移、0.1 dB 一格；Shift = 每像素 0.1 dB；拖出列底 = 靜音", () => {
    const d = begin(musicSeq({ gainDb: -12 }), "gain", { y: 120 });
    const up = G.updateGainDrag(d, { sample: 0, y: 110, fps: FPS });
    // 列內 32 px 對 60 dB（+12..−48）：y 120 = −18 dB、y 110 = +0.75 dB → 平移 +18.75 → −12 + 18.75 = 6.75 → 6.8
    expect(up.gain.gainDb).toBeCloseTo(6.8, 6);
    expect(Number.isInteger(Math.round(up.gain.gainDb * 10))).toBe(true);
    const fine = G.updateGainDrag(d, { sample: 0, y: 123, fps: FPS, fine: true });
    expect(fine.gain.gainDb).toBe(-12.3);
    const floor = G.updateGainDrag(d, { sample: 0, y: ROW.top + ROW.h + 20, fps: FPS });
    expect(floor.gain.gainDb).toBe(-96);
    expect(floor.tip).toEqual({ kind: "gain", db: -96 });
    expect(G.updateGainDrag(d, { sample: 0, y: 120, fps: FPS }).seq).toBe(d.origin);
  });

  it("鎖定的音軌、已分離的原音：按下就拒絕", () => {
    expect(G.beginGainDrag(musicSeq({}, { locked: true }), A1, { mode: "gain", row: ROW, y: 60, fps: FPS })).toEqual({ ok: false, reason: "locked" });
    const detached = seqOf([vclip("c1", "m1", 0, 300, { audio: { enabled: false, detachedTo: "d1", gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [] } })], [lane("l2", "other", [aclip("d1", A_MUSIC.id, 0, 480000)])]);
    expect(G.beginGainDrag(detached, { kind: "original", clipId: "c1" }, { mode: "gain", row: ROW, y: 60, fps: FPS })).toEqual({ ok: false, reason: "detached" });
    expect(G.beginGainDrag(detached, { kind: "original", clipId: "nope" }, { mode: "gain", row: ROW, y: 60, fps: FPS })).toEqual({ ok: false, reason: "notFound" });
  });

  it("A0 原音（V1 片段）：長度 = S(t1) − S(t0)，改的是片段的 audio", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 30), vclip("c2", "m1", 100, 160)]);
    const b = G.beginGainDrag(seq, { kind: "original", clipId: "c2" }, { mode: "fadeOut", row: ROW, y: 60, fps: FPS });
    if (!b.ok) throw new Error("refused");
    expect(b.drag.clip.start).toBe(48000);
    expect(b.drag.clip.length).toBe(96000);
    const r = G.updateGainDrag(b.drag, { sample: 48000 + 96000 - 48000, y: 60, fps: FPS });
    const c2 = r.seq.video[1];
    expect(c2.kind === "clip" && c2.audio.fadeOut).toBe(48000);
  });
});

describe("自動化點", () => {
  it("Alt+點音量線：新增的點取曲線在那裡的值（聽起來不變），索引正確，沒拖也要 commit", () => {
    const seq = musicSeq({ envelope: [{ at: 0, db: 0 }, { at: 96000, db: -12 }] });
    const d = begin(seq, "point", { addAtSample: 48000 + 48000 });
    expect(d.created).toBe(true);
    expect(d.pointIndex).toBe(1);
    const env = gainOf(d.origin).envelope;
    expect(env).toEqual([{ at: 0, db: 0 }, { at: 48000, db: -6 }, { at: 96000, db: -12 }]);
    for (const at of [0, 12000, 48000, 70000, 96000]) expect(envelopeDbAt(env, at)).toBeCloseTo(envelopeDbAt(gainOf(seq).envelope, at), 9);
    expect(G.gainCommitOf(d, null)).toEqual(gainOf(d.origin));
  });

  it("拖點：時間夾在前後兩點之間、dB = 游標 dB − 片段增益；Shift 細調", () => {
    const seq = musicSeq({ gainDb: -6, envelope: [{ at: 0, db: 0 }, { at: 48000, db: 0 }, { at: 96000, db: 0 }] });
    const d = begin(seq, "point", { pointIndex: 1, y: 120 });
    let r = G.updateGainDrag(d, { sample: 48000 + 200000, y: 120, fps: FPS, fine: true });
    expect(gainOf(r.seq).envelope[1].at).toBe(96000);
    r = G.updateGainDrag(d, { sample: 48000 + 24000, y: 120, fps: FPS, fine: true });
    expect(gainOf(r.seq).envelope[1]).toEqual({ at: 24000, db: 0 });
    // 不細調：y 120 = 總 −18 dB，片段增益 −6 → 點 −12
    expect(gainOf(G.updateGainDrag(d, { sample: 48000 + 24000, y: 120, fps: FPS }).seq).envelope[1].db).toBe(-12);
    r = G.updateGainDrag(d, { sample: 48000 + 24000, y: 130, fps: FPS, fine: true });
    expect(gainOf(r.seq).envelope[1].db).toBe(-1);
    expect(r.tip).toEqual({ kind: "point", db: -1, totalDb: -7, at: 24000 });
    r = G.updateGainDrag(d, { sample: 48000 + 24000, y: ROW.top + ROW.h + 30, fps: FPS });
    expect(gainOf(r.seq).envelope[1].db).toBe(-96);
  });

  it("刪點、選取指到不存在的點、選取圈的位置跟畫出來的點一致", () => {
    const seq = musicSeq({ gainDb: -3, envelope: [{ at: 0, db: 0 }, { at: 48000, db: -10 }] });
    const sel = { target: A1, index: 1 };
    expect(G.envPointOf(seq, sel)?.point).toEqual({ at: 48000, db: -10 });
    expect(gainOf(G.deleteEnvelopePoint(seq, sel)).envelope).toEqual([]);
    expect(G.envPointOf(seq, { target: A1, index: 5 })).toBeNull();
    expect(G.deleteEnvelopePoint(seq, { target: A1, index: 5 })).toBe(seq);
    const layout = { a0Y: 60, a0H: 36, lanes: [{ laneId: "l1", y: ROW.top - 1, h: ROW.h + 2 }] };
    const view = { scrollFrame: 0, pxPerFrame: 2 };
    const c = gainOf(seq);
    const drawn = envelopePointsXY({ gain: c, startSample: c.start, length: c.length, fps: FPS, view, top: ROW.top, h: ROW.h });
    expect(G.envPointXY(seq, layout, view, sel)).toEqual(drawn[1]);
  });

  it("游標：把手左右、音量線上下（Alt = copy）、點 = move、鎖定 = not-allowed、本體不歸這裡", () => {
    const base = { kind: "audioClip", clipId: "a1", laneId: "l1", frame: 0, sample: 0 } as const;
    expect(G.gainCursorOf({ ...base, part: "fadeIn" }, false, false)).toBe("ew-resize");
    expect(G.gainCursorOf({ ...base, part: "gainLine" }, false, false)).toBe("ns-resize");
    expect(G.gainCursorOf({ ...base, part: "gainLine" }, true, false)).toBe("copy");
    expect(G.gainCursorOf({ ...base, part: "envPoint", pointIndex: 0 }, false, false)).toBe("move");
    expect(G.gainCursorOf({ ...base, part: "gainLine" }, false, true)).toBe("not-allowed");
    expect(G.gainCursorOf({ ...base, part: "body" }, false, false)).toBeNull();
    expect(G.gainPressOf({ kind: "clip", clipId: "c1", frame: 0, part: "body" }, false)).toBeNull();
  });
});

describe("增益手勢 × edits store", () => {
  beforeEach(() => {
    useEdits.getState().reset();
    project.media = [M1, M2];
    project.activeMediaId = "m1";
  });

  it("A0 原音在隱含序列上拖淡入：預覽不碰 store；放開一筆「淡入」、同一筆實體化，undo 回到 null（I1）", () => {
    const st = useEdits.getState;
    st().load("m1", {});
    st().addTrack("m1", { frame: 10, quad: rectQuad(100, 100, 60, 90), frames: 1797 });
    const before = st();
    const pastLen = before.past.length;
    const view = viewSequenceOf(null, { ...M1, proxy: M1.proxy! })!;
    const b = G.beginGainDrag(view, { kind: "original", clipId: "clip-1" }, { mode: "fadeIn", row: ROW, y: 60, fps: view.fps });
    if (!b.ok) throw new Error("refused");
    const res = G.updateGainDrag(b.drag, { sample: 48000, y: 60, fps: view.fps });
    expect(st().sequence).toBeNull();
    expect(st().past.length).toBe(pastLen);

    expect(G.commitGainDrag(b.drag, res, st().editSequence, SEQ_EDIT_LABEL)).toBe(true);
    const after = st();
    expect(after.past.length).toBe(pastLen + 1);
    expect(after.past[after.past.length - 1].label).toBe("淡入");
    const clip = after.sequence!.video[0];
    expect(clip.kind === "clip" && clip.audio.fadeIn).toBe(48000);
    expect(validateSequence(after.sequence!, CTX())).toEqual([]);
    expect(after.tracks).toBe(before.tracks);
    expect(after.shots).toBe(before.shots);

    st().undo();
    expect(st().sequence).toBeNull();
    expect(st().tracks).toBe(before.tracks);
  });

  it("Alt+點新增自動化點沒拖：一筆「音量自動化」", () => {
    const st = useEdits.getState;
    st().load("m1", {});
    const view = viewSequenceOf(null, { ...M1, proxy: M1.proxy! })!;
    const b = G.beginGainDrag(view, { kind: "original", clipId: "clip-1" }, { mode: "point", row: ROW, y: 60, fps: view.fps, addAtSample: 96000 });
    if (!b.ok) throw new Error("refused");
    expect(G.commitGainDrag(b.drag, null, st().editSequence, SEQ_EDIT_LABEL)).toBe(true);
    expect(st().past[st().past.length - 1].label).toBe("音量自動化");
    const clip = st().sequence!.video[0];
    expect(clip.kind === "clip" && clip.audio.envelope).toEqual([{ at: 96000, db: 0 }]);
  });
});
