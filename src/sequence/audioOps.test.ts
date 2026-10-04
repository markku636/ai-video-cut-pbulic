// 音訊剪輯純函式（§5.2 後半）：分離原音、加入 / 移動 / 修剪音訊片段、增益淡化自動化、閃避、音軌。每個案例都跑 validateSequence。
import { describe, expect, it } from "vitest";
import type { SequenceV2, VideoClipV2 } from "../project/format";
import { envelopeDbAt } from "./envelope";
import { samplesOfFrame } from "./map";
import * as ops from "./ops";
import { aclip, clipsOf, CTX, lane, M1, ok, seqOf, spans, vclip } from "./testkit";

const MUSIC = { type: "audio", audioId: "a-music" } as const;

describe("detachAudio（Ctrl+Alt+L）", () => {
  it("srcIn 依容器絕對時間換算：startUs 6500、videoStartUs 0 時，k=0 → −312 樣本；k=60 → 95688", () => {
    const k0 = ok(ops.detachAudio(ops.materialize(M1), "clip-1", CTX));
    expect(clipsOf(k0, "lane-1")[0].srcIn).toBe(-312);
    const k60 = ok(ops.detachAudio(seqOf([vclip("c1", "m1", 60, 360)]), "c1", CTX));
    const [a] = clipsOf(k60, "lane-1");
    expect(a).toMatchObject({ id: "aclip-1", source: { type: "media", mediaId: "m1" }, start: 0, length: 480000, srcIn: 95688, detachedFrom: "c1", enabled: true });
  });

  it("新建「原音（分離）」軌（role other、同步鎖開）；原片段原音靜音並記 detachedTo；增益淡化曲線照抄", () => {
    const audio = { enabled: true, gainDb: -4, fadeIn: 2000, fadeOut: 3000, fadeCurve: "equalPower" as const, envelope: [{ at: 1000, db: -6 }] };
    const seq = seqOf([vclip("c1", "m1", 0, 300, { audio, label: "開場" })], [lane("mus", "music", [])]);
    const out = ok(ops.detachAudio(seq, "c1", CTX));
    const detachedLane = out.audioLanes[1];
    expect(detachedLane).toMatchObject({ id: "lane-1", name: "A2 原音（分離）", role: "other", syncLock: true });
    expect(detachedLane.clips[0]).toMatchObject({ gainDb: -4, fadeIn: 2000, fadeOut: 3000, fadeCurve: "equalPower", envelope: [{ at: 1000, db: -6 }], label: "開場" });
    expect((out.video[0] as VideoClipV2).audio).toMatchObject({ enabled: false, detachedTo: "aclip-1" });
  });

  it("第二個片段分離時沿用放得下的分離軌；已分離 / 沒有音訊資訊 / 不是片段 各擲對應的錯", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 300), vclip("c2", "m1", 300, 600), vclip("c3", "m25", 0, 10)]);
    const once = ops.detachAudio(seq, "c1", CTX);
    const twice = ok(ops.detachAudio(once, "c2", CTX));
    expect(twice.audioLanes).toHaveLength(1);
    expect(spans(twice.audioLanes[0].clips)).toEqual([
      [0, 480000, -312],
      [480000, 480000, 479688],
    ]);
    expect(() => ops.detachAudio(once, "c1", CTX)).toThrow(expect.objectContaining({ code: "noOriginalAudio" }));
    expect(() => ops.detachAudio(seq, "c3", CTX)).toThrow(expect.objectContaining({ code: "noAudioInfo" }));
    expect(() => ops.detachAudio(seq, "zz", CTX)).toThrow(expect.objectContaining({ code: "notFound" }));
  });

  it("分離出來的原音在同步鎖軌上：前面的 V1 片段波紋刪除後，它跟畫面一起往前移，A/V 仍對齊", () => {
    const seq = ops.detachAudio(seqOf([vclip("c1", "m1", 0, 300), vclip("c2", "m1", 300, 600)]), "c2", CTX);
    const out = ok(ops.rippleDelete(seq, ["c1"], CTX));
    expect(clipsOf(out, "lane-1")[0].start).toBe(0);
    expect((out.video[0] as VideoClipV2).audio.detachedTo).toBe("aclip-1");
  });
});

describe("addAudioClip / moveAudioClip", () => {
  it("加到沒有音軌的序列：依來源角色開「A1 音樂」、音樂軌同步鎖關；長度 = 來源長度換成 48 kHz", () => {
    const out = ok(ops.addAudioClip(ops.materialize(M1), null, MUSIC, 48000, CTX));
    expect(out.audioLanes[0]).toMatchObject({ id: "lane-1", name: "A1 音樂", role: "music", syncLock: false });
    expect(spans(out.audioLanes[0].clips)).toEqual([[48000, 2880000, 0]]);
    expect(out.audioLanes[0].clips[0].id).toBe("aclip-1");
  });

  it("放下的位置重疊：時間不動、換到同角色的其他軌；都放不下才開新軌；旁白角色開的軌同步鎖開", () => {
    const one = ops.addAudioClip(ops.materialize(M1), null, MUSIC, 0, CTX, { length: 96000 });
    const two = ok(ops.addAudioClip(one, "lane-1", MUSIC, 48000, CTX, { length: 96000 }));
    expect(two.audioLanes.map((l) => [l.id, l.clips.map((c) => c.start)])).toEqual([
      ["lane-1", [0]],
      ["lane-2", [48000]],
    ]);
    const three = ok(ops.addAudioClip(two, "lane-1", MUSIC, 96000, CTX, { length: 1000 }));
    expect(clipsOf(three, "lane-1").map((c) => c.start)).toEqual([0, 96000]);
    const vo = ok(ops.addAudioClip(three, null, { type: "audio", audioId: "a-vo" }, 0, CTX));
    expect(vo.audioLanes[2]).toMatchObject({ role: "voiceover", syncLock: true, name: "A3 旁白" });
  });

  it("沒有音訊資訊又沒給長度 → noAudioInfo；負的放置位置夾到 0", () => {
    const seq = ops.materialize(M1);
    expect(() => ops.addAudioClip(seq, null, { type: "audio", audioId: "ghost" }, 0, CTX)).toThrow(expect.objectContaining({ code: "noAudioInfo" }));
    const out = ok(ops.addAudioClip(seq, null, MUSIC, -500, CTX, { length: 10 }));
    expect(out.audioLanes[0].clips[0].start).toBe(0);
  });

  it("移動重疊 → 擲 overlap 並附最近放得下的起點；放得下就移（同軌重新排序、跨軌搬過去）", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 300)], [lane("A", "music", [aclip("a", "a-music", 0, 48000), aclip("b", "a-music", 96000, 48000)]), lane("B", "music", [])]);
    expect(() => ops.moveAudioClip(seq, "b", "A", 24000)).toThrow(expect.objectContaining({ code: "overlap", detail: { nearest: 48000 } }));
    const moved = ok(ops.moveAudioClip(seq, "a", "A", 200000));
    expect(clipsOf(moved, "A").map((c) => c.id)).toEqual(["b", "a"]);
    const across = ok(ops.moveAudioClip(seq, "b", "B", 24000));
    expect(clipsOf(across, "A").map((c) => c.id)).toEqual(["a"]);
    expect(spans(clipsOf(across, "B"))).toEqual([[24000, 48000, 0]]);
    expect(ops.moveAudioClip(seq, "a", "A", 0)).toBe(seq);
  });

  it("鎖定的軌不能移出也不能移入", () => {
    const seq = ok(seqOf([vclip("c1", "m1", 0, 300)], [lane("A", "music", [aclip("a", "a-music", 0, 1000)]), lane("L", "music", [], { locked: true })]));
    expect(() => ops.moveAudioClip(seq, "a", "L", 5000)).toThrow(expect.objectContaining({ code: "locked" }));
    expect(() => ops.moveAudioClip(ops.setLane(seq, "A", { locked: true }), "a", "A", 5000)).toThrow(expect.objectContaining({ code: "locked" }));
  });
});

describe("trimEdge（音訊片段，樣本級，預設不波紋）", () => {
  const twoOnLane = () => seqOf([vclip("c1", "m1", 0, 300)], [lane("A", "music", [aclip("a1", "a-music", 0, 96000), aclip("a2", "a-music", 144000, 96000, { srcIn: 44100 })])]);

  it("開頭往前延長：夾在前一個片段的尾端，srcIn 依 44.1 kHz 往回退；往後修到剩 1 樣本", () => {
    const seq = twoOnLane();
    expect(spans(clipsOf(ok(ops.trimEdge(seq, "a2", "in", -100000, CTX)), "A"))[1]).toEqual([96000, 144000, 0]);
    expect(spans(clipsOf(ok(ops.trimEdge(seq, "a2", "in", 200000, CTX)), "A"))[1]).toEqual([239999, 1, 132299]);
  });

  it("結尾往後延長：非波紋夾在下一個片段開頭；波紋時後面的片段跟著往後移；不能超出來源長度", () => {
    const seq = twoOnLane();
    expect(spans(clipsOf(ok(ops.trimEdge(seq, "a1", "out", 100000, CTX)), "A"))).toEqual([
      [0, 144000, 0],
      [144000, 96000, 44100],
    ]);
    expect(spans(clipsOf(ok(ops.trimEdge(seq, "a1", "out", 100000, CTX, { ripple: true })), "A"))).toEqual([
      [0, 196000, 0],
      [244000, 96000, 44100],
    ]);
    expect(ops.clampTrimDelta(seq, "a2", "out", 1e9, CTX, { ripple: true })).toBe(2880000 - 48000 - 96000);
  });

  it("結尾往內修：曲線裁掉、淡化收進新長度；鎖定的軌擲 locked", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 300)], [lane("A", "music", [aclip("a", "a-music", 0, 96000, { fadeIn: 40000, fadeOut: 40000, envelope: [{ at: 0, db: 0 }, { at: 96000, db: -12 }] })])]);
    const out = ok(ops.trimEdge(seq, "a", "out", -48000, CTX));
    const [a] = clipsOf(out, "A");
    expect([a.length, a.fadeIn + a.fadeOut <= 48000]).toEqual([48000, true]);
    expect(a.envelope).toEqual([
      { at: 0, db: 0 },
      { at: 48000, db: -6 },
    ]);
    expect(() => ops.trimEdge(ops.setLane(seq, "A", { locked: true }), "a", "out", -10, CTX)).toThrow(expect.objectContaining({ code: "locked" }));
    expect(() => ops.trimEdge(seq, "nope", "out", -10, CTX)).toThrow(expect.objectContaining({ code: "notFound" }));
  });
});

describe("增益 / 淡化 / 自動化", () => {
  it("setGain：V1 片段改原音、音訊片段改自己；夾在 [−96, +12]；值沒變回傳同一個參照", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 300)], [lane("A", "music", [aclip("a", "a-music", 0, 1000)])]);
    const out = ok(ops.setGain(seq, ["c1", "a"], 40));
    expect((out.video[0] as VideoClipV2).audio.gainDb).toBe(12);
    expect(clipsOf(out, "A")[0].gainDb).toBe(12);
    expect(ops.setGain(out, ["c1", "a"], 12)).toBe(out);
  });

  it("setFades：淡入先佔、淡出拿剩下的；applyDefaultFades 片段太短時兩端各佔一半", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 30)], [lane("A", "music", [aclip("a", "a-music", 0, 1000)])]);
    const out = ok(ops.setFades(seq, ["a"], { fadeIn: 800, fadeOut: 800, fadeCurve: "equalPower" }));
    expect(clipsOf(out, "A")[0]).toMatchObject({ fadeIn: 800, fadeOut: 200, fadeCurve: "equalPower" });
    const def = ok(ops.applyDefaultFades(seq, ["c1", "a"]));
    expect((def.video[0] as VideoClipV2).audio).toMatchObject({ fadeIn: 24000, fadeOut: 24000 });
    expect(clipsOf(def, "A")[0]).toMatchObject({ fadeIn: 500, fadeOut: 500 });
  });

  it("setEnvelope 排序、取整、夾住；clearAutomation 清空；靜音原音（已分離的不動）", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 300), vclip("c2", "m1", 300, 600)]);
    const env = ok(ops.setEnvelope(seq, ["c1"], [{ at: 900000, db: 0 }, { at: 10.4, db: -200 }]));
    expect((env.video[0] as VideoClipV2).audio.envelope).toEqual([
      { at: 10, db: -96 },
      { at: 480000, db: 0 },
    ]);
    expect(ops.clearAutomation(env, ["c1"])).toEqual(seq);
    const detached = ops.detachAudio(seq, "c2", CTX);
    const muted = ok(ops.setOriginalAudioEnabled(detached, ["c1", "c2"], false));
    expect((muted.video[0] as VideoClipV2).audio.enabled).toBe(false);
    expect(muted.video[1]).toBe(detached.video[1]);
  });
});

describe("duckRange / muteRange", () => {
  it("設計 §7.4 的數字：音樂從 1.0 s 開始，閃避序列 10–14 s、−10 dB、0.25 s 斜坡 → 片段內 8.75／9.0／13.0／13.25 s", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 750)], [lane("mus", "music", [aclip("a1", "a-music", 48000, 960000, { srcIn: 88200 })])]);
    const out = ok(ops.duckRange(seq, ["mus"], { in: 300, out: 420 }, -10, 12000));
    expect(clipsOf(out, "mus")[0].envelope).toEqual([
      { at: 420000, db: 0 },
      { at: 432000, db: -10 },
      { at: 624000, db: -10 },
      { at: 636000, db: 0 },
    ]);
  });

  it("跨兩個 V1 片段閃避原音（A0）：兩邊都有點，接起來的曲線跟一條完整的閃避曲線逐樣本一致", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 300), vclip("c2", "m1", 300, 600)]);
    const out = ok(ops.duckRange(seq, "A0", { in: 280, out: 320 }, -10, 16000));
    const [c1, c2] = out.video as VideoClipV2[];
    expect(c1.audio.envelope.length).toBeGreaterThan(0);
    expect(c2.audio.envelope.length).toBeGreaterThan(0);
    const S = (t: number) => samplesOfFrame(t, seq.fps);
    const expected = (x: number) => {
      const [w0, a, b, w1] = [S(280) - 16000, S(280), S(320), S(320) + 16000];
      if (x <= w0 || x >= w1) return 0;
      if (x < a) return (-10 * (x - w0)) / (a - w0);
      if (x <= b) return -10;
      return (-10 * (w1 - x)) / (w1 - b);
    };
    for (let x = 400000; x < 560000; x += 250) {
      const got = x < S(300) ? envelopeDbAt(c1.audio.envelope, x) : envelopeDbAt(c2.audio.envelope, x - S(300));
      expect(Math.abs(got - expected(x)), `x=${x}`).toBeLessThan(0.01);
    }
  });

  it("閃避 A0 跳過已分離的片段（它的聲音在音軌上，要閃避就選那條軌）", () => {
    const seq = ops.detachAudio(seqOf([vclip("c1", "m1", 0, 300), vclip("c2", "m1", 300, 600)]), "c2", CTX);
    const out = ok(ops.duckRange(seq, "A0", { in: 250, out: 350 }, -10, 4800));
    expect((out.video[0] as VideoClipV2).audio.envelope.length).toBeGreaterThan(0);
    expect(out.video[1]).toBe(seq.video[1]);
    const lanes = ok(ops.duckRange(seq, [seq.audioLanes[0].id], { in: 250, out: 350 }, -10, 4800));
    expect(clipsOf(lanes, seq.audioLanes[0].id)[0].envelope.length).toBeGreaterThan(0);
  });

  it("muteRange = −96 dB、5 ms 斜坡；範圍碰不到任何片段、或軌道鎖定 → 同一個參照", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 300)], [lane("A", "sfx", [aclip("a", "a-vo", 0, 48000)]), lane("L", "sfx", [aclip("b", "a-vo", 0, 48000)], { locked: true })]);
    const out = ok(ops.muteRange(seq, ["A", "L"], { in: 10, out: 20 }));
    expect(clipsOf(out, "A")[0].envelope).toEqual([
      { at: 15760, db: 0 },
      { at: 16000, db: -96 },
      { at: 32000, db: -96 },
      { at: 32240, db: 0 },
    ]);
    expect(out.audioLanes[1]).toBe(seq.audioLanes[1]);
    expect(ops.muteRange(seq, ["A"], { in: 100, out: 200 })).toBe(seq);
  });

  it("已經有自動化時，視窗外的點保留、視窗內的點清掉，視窗兩端接上原曲線的值（不跳）", () => {
    const envelope = [
      { at: 0, db: -6 },
      { at: 100000, db: -6 },
      { at: 200000, db: 0 },
    ];
    const seq = seqOf([vclip("c1", "m1", 0, 300)], [lane("A", "music", [aclip("a", "a-music", 0, 400000, { envelope })])]);
    const out = ok(ops.duckRange(seq, ["A"], { in: 60, out: 70 }, -20, 4800));
    const env = clipsOf(out, "A")[0].envelope;
    // (0, −6) 跟視窗起點 (91200, −6) 同值，hold 給出一樣的曲線，simplify 會把它併掉：比取樣值不比點
    expect(envelopeDbAt(env, 0)).toBe(-6);
    expect(env.some((p) => p.at === 100000)).toBe(false);
    expect(envelopeDbAt(env, 96000 - 4800)).toBeCloseTo(envelopeDbAt(envelope, 96000 - 4800), 9);
    expect(envelopeDbAt(env, 112000 + 4800)).toBeCloseTo(envelopeDbAt(envelope, 112000 + 4800), 9);
    expect(envelopeDbAt(env, 100000)).toBe(-20);
    expect(env[env.length - 1]).toEqual({ at: 200000, db: 0 });
  });
});

describe("音軌", () => {
  it("addLane 依角色給同步鎖（音樂關、其他開）；removeLane 非空擲 laneNotEmpty、空的刪掉", () => {
    let seq: SequenceV2 = ops.materialize(M1);
    seq = ok(ops.addLane(seq, "music"));
    seq = ok(ops.addLane(seq, "sfx"));
    expect(seq.audioLanes.map((l) => [l.id, l.name, l.syncLock])).toEqual([
      ["lane-1", "A1 音樂", false],
      ["lane-2", "A2 音效", true],
    ]);
    const withClip = ops.addAudioClip(seq, "lane-1", MUSIC, 0, CTX, { length: 10 });
    expect(() => ops.removeLane(withClip, "lane-1")).toThrow(expect.objectContaining({ code: "laneNotEmpty" }));
    expect(ok(ops.removeLane(seq, "lane-2")).audioLanes.map((l) => l.id)).toEqual(["lane-1"]);
    expect(ops.removeLane(seq, "nope")).toBe(seq);
  });

  it("setLane 夾推桿、值沒變回傳同一個參照；setOriginalBus；moveToNewLane 時間不變並修參照", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 300)], [lane("A", "voiceover", [aclip("a", "a-vo", 1000, 1000)])]);
    const s1 = ok(ops.setLane(seq, "A", { gainDb: 99, muted: true }));
    expect(s1.audioLanes[0]).toMatchObject({ gainDb: 12, muted: true });
    expect(ops.setLane(s1, "A", { muted: true })).toBe(s1);
    const s2 = ok(ops.setOriginalBus(s1, { muted: true, gainDb: -200 }));
    expect(s2.original).toEqual({ muted: true, gainDb: -96 });
    expect(ops.setOriginalBus(s2, { muted: true })).toBe(s2);
    const s3 = ok(ops.moveToNewLane(s2, "a"));
    expect(s3.audioLanes.map((l) => [l.id, l.role, l.clips.map((c) => c.start)])).toEqual([
      ["A", "voiceover", []],
      ["lane-1", "voiceover", [1000]],
    ]);
  });
});
