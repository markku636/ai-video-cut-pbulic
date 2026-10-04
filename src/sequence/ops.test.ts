// V1 剪輯純函式（§5.2 前半）：實體化、分割 / 合併、波紋刪除 / 留空隙、範圍提取、修剪、停用、加入 / 移除媒體。
// 每個案例都跑 validateSequence（ok()）；syncLock 開 / 關各有一組。
import { describe, expect, it } from "vitest";
import type { SequenceV2, VideoClipV2 } from "../project/format";
import { envelopeDbAt } from "./envelope";
import { durationFrames, isUntouched, mapFrame, placeVideo, projectFrames, samplesOfFrame } from "./map";
import * as ops from "./ops";
import { aclip, clipsOf, CTX, deepFreeze, FPS2997, gap, lane, M1, M2, M25, M2997, MBIG, MNOPROXY, ok, seqOf, spans, vclip } from "./testkit";

const S = (t: number) => samplesOfFrame(t, { num: 30, den: 1 });
const framesOf = (id: string) => CTX.media(id)?.frames;
const v1 = (seq: SequenceV2) => seq.video.map((it) => (it.kind === "clip" ? [it.mediaId, it.srcIn, it.srcOut] : ["gap", it.length]));

/** 三段 m1 片段各 300 幀（t 0..900，S = 1600·t）＋一條旁白軌（同步鎖開）＋一條音樂軌（同步鎖關）。 */
function threeClips(): SequenceV2 {
  return seqOf(
    [vclip("c1", "m1", 0, 300), vclip("c2", "m1", 300, 600), vclip("c3", "m1", 600, 900)],
    [
      lane("vo", "voiceover", [aclip("v1", "a-vo", 100000, 100000), aclip("v2", "a-vo", 400000, 200000, { fadeIn: 1000, fadeOut: 5000 }), aclip("v3", "a-vo", 600000, 100000), aclip("v4", "a-vo", 900000, 200000), aclip("v5", "a-vo", 1200000, 100000)]),
      lane("music", "music", [aclip("m", "a-music", 0, 1440000)]),
    ],
  );
}

describe("materialize / ensureSequence", () => {
  it("隱含序列 → 一個整段片段：fps = proxy、尺寸 = 來源、原音預設、untouched（-c:a copy 閘門仍成立）", () => {
    const seq = ok(ops.materialize(M1));
    expect(seq.fps).toEqual({ num: 30, den: 1 });
    expect([seq.width, seq.height, seq.sampleRate]).toEqual([1280, 720, 48000]);
    expect(v1(seq)).toEqual([["m1", 0, 1797]]);
    expect(seq.name).toBe("m1");
    expect(isUntouched(seq, framesOf)).toBe(true);
  });

  it("沒有 proxy 不能實體化（noProxy）；ensureSequence 已有序列就原樣回傳", () => {
    expect(() => ops.materialize(MNOPROXY)).toThrow(expect.objectContaining({ code: "noProxy" }));
    const seq = ops.materialize(M1);
    expect(ops.ensureSequence(seq, M2)).toBe(seq);
    expect(v1(ok(ops.ensureSequence(null, M2)))).toEqual([["m2", 0, 600]]);
    expect(() => ops.ensureSequence(null, null)).toThrow(ops.SequenceError);
  });

  it("剪輯點與吸附：0、每個邊界、T；等距取前面", () => {
    const seq = ok(threeClips());
    expect(ops.editPoints(seq)).toEqual([0, 300, 600, 900]);
    expect(ops.snapToEditPoint(seq, 449)).toBe(300);
    expect(ops.snapToEditPoint(seq, 450)).toBe(300);
    expect(ops.snapToEditPoint(seq, 451)).toBe(600);
  });
});

describe("splitAt / joinThroughEdit", () => {
  it("在片段中間切：兩段、右段新 id；對應表完全不變（同一個 t 還是同一個 k）", () => {
    const seq = ops.materialize(M1);
    const out = ok(ops.splitAt(seq, 500, CTX));
    expect(out.video.map((x) => x.id)).toEqual(["clip-1", "clip-2"]);
    expect(v1(out)).toEqual([
      ["m1", 0, 500],
      ["m1", 500, 1797],
    ]);
    for (const t of [0, 1, 499, 500, 501, 1796]) expect(mapFrame(out, t).k).toBe(mapFrame(seq, t).k);
    expect(isUntouched(out, framesOf)).toBe(false);
  });

  it("播放線在切點上 / 超出序列 → 同一個參照（不留空 undo）", () => {
    const seq = ok(threeClips());
    for (const t of [0, 300, 900, 1000, -5]) expect(ops.splitAt(seq, t, CTX)).toBe(seq);
  });

  it("B 切一刀再按 B 合併：比值回到原樣，isUntouched 重新成立", () => {
    const seq = ops.materialize(M1);
    const cut = ok(ops.splitAt(seq, 900, CTX));
    expect(ops.canJoinAt(cut, 900, CTX)).toBe(true);
    const joined = ok(ops.joinThroughEdit(cut, 900, CTX));
    expect(joined).toEqual(seq);
    expect(isUntouched(joined, framesOf)).toBe(true);
  });

  it("分割後原音自動化曲線在切點兩側取樣值不變（< 0.01 dB）；淡入留前段、淡出留後段", () => {
    const envelope = [
      { at: 0, db: 0 },
      { at: 300000, db: -20 },
      { at: 600000, db: -3 },
      { at: 960000, db: -6 },
    ];
    const seq = seqOf([vclip("c1", "m1", 0, 600, { audio: { enabled: true, gainDb: -2, fadeIn: 10000, fadeOut: 20000, fadeCurve: "equalPower", envelope } })]);
    const out = ok(ops.splitAt(seq, 250, CTX));
    const [l, r] = out.video as VideoClipV2[];
    const cut = S(250);
    for (let x = 0; x <= 960000; x += 997) {
      const v = x < cut ? envelopeDbAt(l.audio.envelope, x) : envelopeDbAt(r.audio.envelope, x - cut);
      expect(Math.abs(v - envelopeDbAt(envelope, x)), `x=${x}`).toBeLessThan(0.01);
    }
    expect(Math.abs(envelopeDbAt(l.audio.envelope, cut) - envelopeDbAt(envelope, cut))).toBeLessThan(0.01);
    expect(Math.abs(envelopeDbAt(r.audio.envelope, 0) - envelopeDbAt(envelope, cut))).toBeLessThan(0.01);
    expect([l.audio.fadeIn, l.audio.fadeOut, r.audio.fadeIn, r.audio.fadeOut]).toEqual([10000, 0, 0, 20000]);
    expect([l.audio.gainDb, r.audio.fadeCurve]).toEqual([-2, "equalPower"]);
    expect(ops.joinThroughEdit(out, 250, CTX)).toEqual(seq);
  });

  it("29.97 fps：兩段的樣本長度加起來剛好等於原片段（S 從絕對 t 算）", () => {
    const seq = ops.materialize(M2997);
    const out = ok(ops.splitAt(seq, 1001, CTX));
    const p = placeVideo(out);
    const len = (i: number) => samplesOfFrame(p[i].t1, FPS2997) - samplesOfFrame(p[i].t0, FPS2997);
    expect([len(0), len(1)]).toEqual([1603201, 3201599]);
    expect(len(0) + len(1)).toBe(samplesOfFrame(3000, FPS2997));
  });

  it("target：v1 只切 V1；all 連未鎖定的音軌一起切（鎖定的不切）；id 清單只切選到的片段", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 600)], [lane("music", "music", [aclip("mu", "a-music", 0, 960000)]), lane("vo", "voiceover", [aclip("vo1", "a-vo", 0, 480000)], { locked: true })]);
    const onlyV1 = ok(ops.splitAt(seq, 150, CTX, "v1"));
    expect(onlyV1.audioLanes).toBe(seq.audioLanes);
    const all = ok(ops.splitAt(seq, 150, CTX, "all"));
    expect(all.video).toHaveLength(2);
    expect(spans(clipsOf(all, "music"))).toEqual([
      [0, 240000, 0],
      [240000, 720000, 220500],
    ]);
    expect(clipsOf(all, "vo")).toBe(seq.audioLanes[1].clips);
    const picked = ok(ops.splitAt(seq, 150, CTX, ["mu"]));
    expect(picked.video).toBe(seq.video);
    expect(clipsOf(picked, "music")).toHaveLength(2);
  });

  it("音訊片段切開：右段 srcIn 依原生取樣率前進（44.1 kHz：240000 → 220500）；在同一點合併回原樣", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 600)], [lane("music", "music", [aclip("mu", "a-music", 48000, 960000, { srcIn: 1000, fadeIn: 5000, fadeOut: 7000 })])]);
    const out = ok(ops.splitAudioAt(seq, 288000, CTX));
    const [a, b] = clipsOf(out, "music");
    expect([a.length, a.fadeIn, a.fadeOut]).toEqual([240000, 5000, 0]);
    expect([b.start, b.length, b.srcIn, b.fadeIn, b.fadeOut]).toEqual([288000, 720000, 221500, 0, 7000]);
    expect(ops.joinThroughEdit(out, 180, CTX, "all")).toEqual(seq);
  });

  it("不能合併的切點：來源不連續、增益不同、停用狀態不同 → 同一個參照", () => {
    const gapInSource = ok(seqOf([vclip("a", "m1", 0, 100), vclip("b", "m1", 101, 200)]));
    expect(ops.joinThroughEdit(gapInSource, 100, CTX)).toBe(gapInSource);
    const cut = ops.splitAt(ops.materialize(M1), 100, CTX);
    const gained = ok(ops.setGain(cut, ["clip-2"], -6));
    expect(ops.canJoinAt(gained, 100, CTX)).toBe(false);
    const disabled = ok(ops.setEnabled(cut, ["clip-2"], false));
    expect(ops.canJoinAt(disabled, 100, CTX)).toBe(false);
  });
});

describe("rippleDelete（Delete）", () => {
  it("刪中間片段：後面往前補，對應表整段前移", () => {
    const seq = threeClips();
    const out = ok(ops.rippleDelete(seq, ["c2"], CTX));
    expect(v1(out)).toEqual([
      ["m1", 0, 300],
      ["m1", 600, 900],
    ]);
    expect(durationFrames(out)).toBe(600);
    expect(mapFrame(out, 300).k).toBe(mapFrame(seq, 600).k);
  });

  it("同步鎖開的軌移除同一段時間：之後的往前移、範圍內的刪、跨入點的截短、跨出點的留後段接回", () => {
    const out = ok(ops.rippleDelete(threeClips(), ["c2"], CTX));
    const vo = clipsOf(out, "vo");
    expect(vo.map((c) => c.id)).toEqual(["v1", "v2", "v4", "v5"]);
    expect(spans(vo)).toEqual([
      [100000, 100000, 0],
      [400000, 80000, 0],
      [480000, 140000, 60000],
      [720000, 100000, 0],
    ]);
    // 截短的那段：淡入是它的、淡出屬於被刪掉的尾巴
    expect([vo[1].fadeIn, vo[1].fadeOut]).toEqual([1000, 0]);
  });

  it("同步鎖關的音樂軌整條停在原地（同一個參照）；鎖定的軌就算同步鎖開也不動", () => {
    const base = threeClips();
    const seq = { ...base, audioLanes: [{ ...base.audioLanes[0], locked: true }, base.audioLanes[1]] };
    const out = ok(ops.rippleDelete(seq, ["c2"], CTX));
    expect(out.audioLanes[0]).toBe(seq.audioLanes[0]);
    expect(out.audioLanes[1]).toBe(seq.audioLanes[1]);
  });

  it("跨越整段被刪範圍的旁白：切成前後兩段、後段拿新 id 並接在入點", () => {
    const seq = seqOf(threeClips().video, [lane("vo", "voiceover", [aclip("long", "a-vo", 300000, 800000)])]);
    const out = ok(ops.rippleDelete(seq, ["c2"], CTX));
    expect(clipsOf(out, "vo").map((c) => [c.id, c.start, c.length, c.srcIn])).toEqual([
      ["long", 300000, 180000, 0],
      ["aclip-1", 480000, 140000, 660000],
    ]);
  });

  it("刪掉兩塊空白中間的片段 → 空白合併成一塊", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 100), gap("g1", 50), vclip("c2", "m1", 100, 200), gap("g2", 30), vclip("c3", "m1", 200, 300)]);
    const out = ok(ops.rippleDelete(seq, ["c2"], CTX));
    expect(v1(out)).toEqual([["m1", 0, 100], ["gap", 80], ["m1", 200, 300]]);
    expect(out.video[1].id).toBe("g1");
  });

  it("只刪音訊片段：不補位、V1 不動；不存在的 id → 同一個參照", () => {
    const seq = threeClips();
    const out = ok(ops.rippleDelete(seq, ["v3"], CTX));
    expect(out.video).toBe(seq.video);
    expect(spans(clipsOf(out, "vo"))).toEqual(spans(clipsOf(seq, "vo").filter((c) => c.id !== "v3")));
    expect(ops.rippleDelete(seq, ["nope"], CTX)).toBe(seq);
  });

  it("刪掉已分離原音的 V1 片段（分離軌同步鎖關）：音訊片段留著、detachedFrom 清掉", () => {
    const seq = ops.detachAudio(threeClips(), "c2", CTX);
    const detachedLane = seq.audioLanes[2];
    const unlocked = ops.setLane(seq, detachedLane.id, { syncLock: false });
    const out = ok(ops.rippleDelete(unlocked, ["c2"], CTX));
    const [a] = clipsOf(out, detachedLane.id);
    expect(a.start).toBe(S(300));
    expect("detachedFrom" in a).toBe(false);
  });

  it("29.97 fps：片段前移後樣本長度差 1，原音淡化自動收進新長度", () => {
    const fade = (n: number) => ({ enabled: true, gainDb: 0, fadeIn: n, fadeOut: 0, fadeCurve: "linear" as const, envelope: [] });
    const seq = seqOf([vclip("c1", "m2997", 0, 1, { audio: fade(1601) }), vclip("c2", "m2997", 1, 2, { audio: fade(1602) })], [], FPS2997);
    ok(seq);
    const out = ok(ops.rippleDelete(seq, ["c1"], CTX));
    expect((out.video[0] as VideoClipV2).audio.fadeIn).toBe(1601);
  });
});

describe("lift（Shift+Delete）", () => {
  it("V1 片段換成同長度空白，總長不變；同步鎖開的軌也不動", () => {
    const seq = threeClips();
    const out = ok(ops.lift(seq, ["c2"]));
    expect(v1(out)).toEqual([["m1", 0, 300], ["gap", 300], ["m1", 600, 900]]);
    expect(durationFrames(out)).toBe(900);
    expect(out.audioLanes).toBe(seq.audioLanes);
    expect(mapFrame(out, 400).clip).toBeNull();
  });

  it("旁邊已經有空白 → 合併；對空白 lift 什麼都不做", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 100), gap("g1", 50), vclip("c2", "m1", 100, 200)]);
    const out = ok(ops.lift(seq, ["c2"]));
    expect(v1(out)).toEqual([["m1", 0, 100], ["gap", 150]]);
    expect(ops.lift(seq, ["g1"])).toBe(seq);
  });

  it("刪掉分離出去的音訊片段：V1 的 detachedTo 清掉、原音維持靜音（使用者刪的就是那段聲音）", () => {
    const seq = ops.detachAudio(ops.materialize(M1), "clip-1", CTX);
    const out = ok(ops.lift(seq, ["aclip-1"]));
    const c = out.video[0] as VideoClipV2;
    expect(c.audio.enabled).toBe(false);
    expect("detachedTo" in c.audio).toBe(false);
  });
});

describe("extractRange / liftRange（範圍為焦點時的 Delete / Shift+Delete）", () => {
  it("提取片段內部的範圍：切開、刪中間、後面接上", () => {
    const out = ok(ops.extractRange(seqOf([vclip("c1", "m1", 0, 900)]), { in: 300, out: 450 }, CTX));
    expect(v1(out)).toEqual([
      ["m1", 0, 300],
      ["m1", 450, 900],
    ]);
    expect(mapFrame(out, 300).k).toBe(450);
  });

  it("跨片段與空白的範圍；同步鎖軌移除同一段時間（跨出點的留後段）", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 300), gap("g1", 100), vclip("c2", "m1", 300, 600)], [lane("vo", "voiceover", [aclip("x", "a-vo", 700000, 50000)])]);
    const out = ok(ops.extractRange(seq, { in: 200, out: 450 }, CTX));
    expect(v1(out)).toEqual([
      ["m1", 0, 200],
      ["m1", 350, 600],
    ]);
    expect(spans(clipsOf(out, "vo"))).toEqual([[320000, 30000, 20000]]);
  });

  it("範圍夾在 [0, T]；空範圍 → 同一個參照", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 300)]);
    expect(ops.extractRange(seq, { in: 200, out: 200 }, CTX)).toBe(seq);
    expect(ops.extractRange(seq, { in: 500, out: 900 }, CTX)).toBe(seq);
    expect(v1(ok(ops.extractRange(seq, { in: -50, out: 100 }, CTX)))).toEqual([["m1", 100, 300]]);
  });

  it("liftRange：中間換成一塊空白、總長不變、音軌不動；範圍整個落在空白上 → 同一個參照", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 900)], [lane("vo", "voiceover", [aclip("x", "a-vo", 500000, 50000)])]);
    const out = ok(ops.liftRange(seq, { in: 300, out: 450 }));
    expect(v1(out)).toEqual([["m1", 0, 300], ["gap", 150], ["m1", 450, 900]]);
    expect(out.audioLanes).toBe(seq.audioLanes);
    expect(ops.liftRange(out, { in: 310, out: 440 })).toBe(out);
  });
});

describe("trimEdge（V1 一律波紋）", () => {
  it("開頭往後修 10 幀：srcIn +10、總長 −10；同步鎖軌移除 [t0, t0+10) 的時間、音樂軌不動", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 300), vclip("c2", "m1", 300, 600)], [lane("vo", "voiceover", [aclip("x", "a-vo", 600000, 1000)]), lane("music", "music", [aclip("m", "a-music", 0, 960000)])]);
    const out = ok(ops.trimEdge(seq, "c2", "in", 10, CTX));
    expect(v1(out)).toEqual([
      ["m1", 0, 300],
      ["m1", 310, 600],
    ]);
    expect(clipsOf(out, "vo")[0].start).toBe(600000 - (S(310) - S(300)));
    expect(out.audioLanes[1]).toBe(seq.audioLanes[1]);
  });

  it("結尾往外延長：夾在 proxy 幀數；同步鎖軌在出點插入時間（跨出點的切開、後段往後）", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 1790)], [lane("vo", "voiceover", [aclip("x", "a-vo", 2800000, 100000), aclip("y", "a-vo", 2900000, 1000)])]);
    expect(ops.clampTrimDelta(seq, "c1", "out", 20, CTX)).toBe(7);
    const out = ok(ops.trimEdge(seq, "c1", "out", 20, CTX));
    expect(v1(out)).toEqual([["m1", 0, 1797]]);
    const D = S(1797) - S(1790);
    expect(clipsOf(out, "vo").map((c) => [c.start, c.length, c.srcIn])).toEqual([
      [2800000, 64000, 0],
      [2864000 + D, 36000, 64000],
      [2900000 + D, 1000, 0],
    ]);
  });

  it("結尾往內修：同步鎖軌移除 [t1−10, t1)；同步鎖關（音樂）不動", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 300), vclip("c2", "m1", 300, 600)], [lane("vo", "voiceover", [aclip("x", "a-vo", 470000, 20000)]), lane("music", "music", [aclip("m", "a-music", 470000, 20000)])]);
    const out = ok(ops.trimEdge(seq, "c1", "out", -10, CTX));
    expect(durationFrames(out)).toBe(590);
    // 旁白從 470000 開始、落在被移除的 [464000, 480000) 裡：只留 480000 之後的 10000 樣本，接在 464000
    expect(spans(clipsOf(out, "vo"))).toEqual([[464000, 10000, 10000]]);
    expect(clipsOf(out, "music")).toBe(seq.audioLanes[1].clips);
  });

  it("夾住：開頭不能早於 0、長度至少 1 幀；幀數未知的媒體不能往後延長；空白長度至少 1", () => {
    const seq = seqOf([vclip("c1", "m1", 30, 60), gap("g", 5)]);
    expect(v1(ok(ops.trimEdge(seq, "c1", "in", -100, CTX)))).toEqual([["m1", 0, 60], ["gap", 5]]);
    expect(v1(ok(ops.trimEdge(seq, "c1", "in", 100, CTX)))).toEqual([["m1", 59, 60], ["gap", 5]]);
    expect(ops.trimEdge(seq, "c1", "out", 50, undefined)).toBe(seq);
    expect(v1(ok(ops.trimEdge(seq, "g", "out", -99, CTX)))).toEqual([["m1", 30, 60], ["gap", 1]]);
    expect(v1(ok(ops.trimEdge(seq, "g", "in", -3, CTX)))).toEqual([["m1", 30, 60], ["gap", 8]]);
  });

  it("修剪開頭時原音曲線跟著內容走（同一個來源位置的 dB 不變）", () => {
    const envelope = [
      { at: 0, db: 0 },
      { at: 480000, db: -12 },
    ];
    const seq = seqOf([vclip("c1", "m1", 0, 300, { audio: { enabled: true, gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope } })]);
    const out = ok(ops.trimEdge(seq, "c1", "in", 100, CTX));
    const env = (out.video[0] as VideoClipV2).audio.envelope;
    expect(env).toEqual([
      { at: 0, db: -4 },
      { at: 320000, db: -12 },
    ]);
    expect(envelopeDbAt(env, 160000)).toBeCloseTo(envelopeDbAt(envelope, 320000), 9);
  });

  it("修剪到播放線（Ctrl+Shift+[ / ]）：播放線所在片段；在切點或空白上不動", () => {
    const seq = threeClips();
    expect(v1(ok(ops.rippleTrimToPlayhead(seq, 350, "in", CTX)))).toEqual([["m1", 0, 300], ["m1", 350, 600], ["m1", 600, 900]]);
    expect(v1(ok(ops.rippleTrimToPlayhead(seq, 350, "out", CTX)))).toEqual([["m1", 0, 300], ["m1", 300, 350], ["m1", 600, 900]]);
    expect(ops.rippleTrimToPlayhead(seq, 300, "in", CTX)).toBe(seq);
  });
});

describe("setEnabled（D）", () => {
  it("停用 V1：佔時間、渲染對應為 null（黑畫面）但 itemK 還在；啟用回來等於原樣", () => {
    const seq = ops.materialize(M1);
    const off = ok(ops.setEnabled(seq, ["clip-1"], false));
    expect(mapFrame(off, 10)).toMatchObject({ clip: null, k: null, itemK: 10 });
    expect(isUntouched(off, framesOf)).toBe(false);
    expect(ops.setEnabled(off, ["clip-1"], true)).toEqual(seq);
    expect(ops.setEnabled(seq, ["clip-1"], true)).toBe(seq);
  });

  it("音訊片段停用；鎖定的軌跳過", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 300)], [lane("vo", "voiceover", [aclip("x", "a-vo", 0, 1000)]), lane("lk", "sfx", [aclip("y", "a-vo", 0, 1000)], { locked: true })]);
    const out = ok(ops.setEnabled(seq, ["x", "y"], false));
    expect(clipsOf(out, "vo")[0].enabled).toBe(false);
    expect(out.audioLanes[1]).toBe(seq.audioLanes[1]);
  });
});

describe("setGainsById（逐片段增益）", () => {
  it("只動列在 map 裡的片段，其餘完全不動（含參照）；值夾在 [−96, +12]", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 100), vclip("c2", "m1", 200, 300)], [lane("vo", "voiceover", [aclip("a", "a-vo", 0, 48000)])]);
    const out = ok(ops.setGainsById(seq, new Map([["c1", 6], ["a", 999]])));
    expect((out.video[0] as VideoClipV2).audio.gainDb).toBe(6);
    expect(out.video[1]).toBe(seq.video[1]);
    expect(out.audioLanes[0].clips[0].gainDb).toBe(12); // 夾住
    expect(ops.setGainsById(seq, new Map())).toBe(seq);
    expect(ops.setGainsById(seq, new Map([["沒這個", 3]]))).toBe(seq);
  });

  it("鎖定的音軌跳過", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 100)], [lane("vo", "voiceover", [aclip("a", "a-vo", 0, 48000)], { locked: true })]);
    expect(ops.setGainsById(seq, new Map([["a", 6]]))).toBe(seq);
  });
});

describe("projectFrames（來源幀 → 序列幀）", () => {
  it("同一段來源被用兩次時兩個位置都回；超出片段範圍的不算；去重排序", () => {
    const seq = seqOf([vclip("a", "m1", 0, 100), vclip("b", "m2", 0, 50), vclip("c", "m1", 50, 150)]);
    // clip c 從 t=150 開始（100 + 50）
    expect(projectFrames(seq, "m1", [10, 60, 200])).toEqual([10, 60, 160]);
    expect(projectFrames(seq, "m2", [0])).toEqual([100]);
    expect(projectFrames(seq, "m9", [0])).toEqual([]);
    // srcOut 不含
    expect(projectFrames(seqOf([vclip("a", "m1", 0, 100)]), "m1", [100])).toEqual([]);
  });
});

describe("setClipLabel（片段命名）", () => {
  const base = () => seqOf([vclip("c1", "m1", 0, 100), vclip("c2", "m1", 200, 300)], [lane("vo", "voiceover", [aclip("a", "a-vo", 0, 48000)])]);

  it("V1 片段與音訊片段都能命名；沒選到的不動", () => {
    const seq = base();
    const out = ok(ops.setClipLabel(seq, ["c1", "a"], "  開場  "));
    expect((out.video[0] as VideoClipV2).label).toBe("開場"); // 去頭尾空白
    expect(out.audioLanes[0].clips[0].label).toBe("開場");
    expect(out.video[1]).toBe(seq.video[1]);
  });

  it("空字串把鍵整個拿掉（不寫空值進專案檔）；沒變就回同一個參照", () => {
    const named = ok(ops.setClipLabel(base(), ["c1"], "開場"));
    const cleared = ok(ops.setClipLabel(named, ["c1"], "   "));
    expect("label" in cleared.video[0]).toBe(false);
    expect(ops.setClipLabel(named, ["c1"], "開場")).toBe(named);
    const fresh = base();
    expect(ops.setClipLabel(fresh, ["c1"], "")).toBe(fresh); // 本來就沒有名字 → 不動
  });

  it("鎖定的音軌跳過", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 100)], [lane("vo", "voiceover", [aclip("a", "a-vo", 0, 48000)], { locked: true })]);
    expect(ops.setClipLabel(seq, ["a"], "x")).toBe(seq);
  });
});

describe("moveItemBy（重新排序）", () => {
  it("跟相鄰項目對調；序列總長與後面的項目位置都不動", () => {
    const seq = seqOf([vclip("a", "m1", 0, 100), vclip("b", "m1", 200, 250), vclip("c", "m1", 400, 500)], [lane("vo", "voiceover", [aclip("x", "a-vo", 0, 48000)])]);
    const out = ok(ops.moveItemBy(seq, "a", 1));
    expect(v1(out)).toEqual([
      ["m1", 200, 250],
      ["m1", 0, 100],
      ["m1", 400, 500],
    ]);
    expect(durationFrames(out)).toBe(durationFrames(seq));
    expect(out.video[2]).toBe(seq.video[2]); // 第三個完全沒動（含參照）
    expect(spans(clipsOf(out, "vo"))).toEqual(spans(clipsOf(seq, "vo"))); // 聲音不跟著跳
  });

  it("跟空白對調＝把片段挪過一整段空白（有用的副作用，刻意不擋）", () => {
    const seq = seqOf([gap("g", 40), vclip("a", "m1", 0, 100)]);
    expect(v1(ok(ops.moveItemBy(seq, "a", -1)))).toEqual([
      ["m1", 0, 100],
      ["gap", 40],
    ]);
  });

  it("已經在頭 / 尾、或 id 不存在就回同一個參照", () => {
    const seq = seqOf([vclip("a", "m1", 0, 100), vclip("b", "m1", 200, 250)]);
    expect(ops.moveItemBy(seq, "a", -1)).toBe(seq);
    expect(ops.moveItemBy(seq, "b", 1)).toBe(seq);
    expect(ops.moveItemBy(seq, "沒這個", 1)).toBe(seq);
  });

  it("對調後兩段空白相鄰會併起來", () => {
    const seq = seqOf([gap("g1", 10), vclip("a", "m1", 0, 100), gap("g2", 20)]);
    expect(v1(ok(ops.moveItemBy(seq, "a", -1)))).toEqual([
      ["m1", 0, 100],
      ["gap", 30],
    ]);
  });
});

describe("moveItemTo（拖曳重排的底層）", () => {
  const four = () => seqOf([vclip("a", "m1", 0, 100), vclip("b", "m1", 200, 250), vclip("c", "m1", 400, 500), vclip("d", "m1", 600, 630)]);

  it("搬到任意位置；toIndex 是搬移後的索引", () => {
    expect(v1(ok(ops.moveItemTo(four(), "a", 2))).map((x) => x[1])).toEqual([200, 400, 0, 600]);
    expect(v1(ok(ops.moveItemTo(four(), "d", 0))).map((x) => x[1])).toEqual([600, 0, 200, 400]);
  });

  it("夾在範圍內；夾完等於原位就回同一個參照", () => {
    const seq = four();
    expect(v1(ok(ops.moveItemTo(seq, "a", 999))).map((x) => x[1])).toEqual([200, 400, 600, 0]);
    expect(ops.moveItemTo(seq, "a", -5)).toBe(seq); // 夾成 0 = 原位
    expect(ops.moveItemTo(seq, "沒這個", 2)).toBe(seq);
  });

  it("總長不變；相鄰對調是它的特例（moveItemBy 走同一條路）", () => {
    const seq = four();
    expect(durationFrames(ok(ops.moveItemTo(seq, "a", 3)))).toBe(durationFrames(seq));
    expect(v1(ok(ops.moveItemBy(seq, "a", 1)))).toEqual(v1(ok(ops.moveItemTo(seq, "a", 1))));
  });
});

describe("標記", () => {
  const base = () => seqOf([vclip("c1", "m1", 0, 300)]);

  it("加在播放線、依 t 排序、同一幀不重複加；夾在序列範圍內", () => {
    let seq = ok(ops.addMarker(base(), 200, "第二個"));
    seq = ok(ops.addMarker(seq, 50, "第一個"));
    expect(seq.markers?.map((m) => [m.t, m.name])).toEqual([
      [50, "第一個"],
      [200, "第二個"],
    ]);
    expect(ops.addMarker(seq, 50, "又一個")).toBe(seq); // 同一幀已經有了
    expect(ok(ops.addMarker(base(), 99999)).markers?.[0].t).toBe(300); // 夾到序列尾端
  });

  it("刪到一個不剩時連鍵一起拿掉（空陣列不該寫進專案檔）", () => {
    const seq = ok(ops.addMarker(base(), 100));
    const id = seq.markers![0].id;
    const gone = ok(ops.removeMarker(seq, id));
    expect("markers" in gone).toBe(false);
    expect(ops.removeMarker(seq, "沒這個")).toBe(seq);
  });

  it("改字；沒變就回同一個參照", () => {
    const seq = ok(ops.addMarker(base(), 100, "舊"));
    const id = seq.markers![0].id;
    expect(ok(ops.renameMarker(seq, id, "新")).markers?.[0].name).toBe("新");
    expect(ops.renameMarker(seq, id, "舊")).toBe(seq);
    expect(ops.renameMarker(seq, "沒這個", "x")).toBe(seq);
  });

  it("往前 / 往後找最近的標記；停在標記上會跳到下一個而不是原地不動", () => {
    let seq = base();
    for (const t of [50, 100, 200]) seq = ops.addMarker(seq, t);
    expect(ops.markerNear(seq, 100, 1)?.t).toBe(200);
    expect(ops.markerNear(seq, 100, -1)?.t).toBe(50);
    expect(ops.markerNear(seq, 200, 1)).toBeNull();
    expect(ops.markerNear(seq, 50, -1)).toBeNull();
    expect(ops.markerAt(seq, 100)?.t).toBe(100);
    expect(ops.markerAt(seq, 101)).toBeNull();
  });
});

describe("slipClip（Slip）", () => {
  const three = () => seqOf([vclip("c1", "m1", 0, 100), vclip("c2", "m1", 200, 300), vclip("c3", "m1", 400, 500)], [lane("vo", "voiceover", [aclip("a", "a-vo", 0, 480000)])]);

  it("只換來源區間，位置與長度都不變，鄰居與音訊軌完全不動", () => {
    const seq = three();
    const out = ok(ops.slipClip(seq, "c2", 25, CTX));
    expect(v1(out)).toEqual([
      ["m1", 0, 100],
      ["m1", 225, 325],
      ["m1", 400, 500],
    ]);
    expect(durationFrames(out)).toBe(durationFrames(seq));
    expect(out.video[0]).toBe(seq.video[0]);
    expect(out.video[2]).toBe(seq.video[2]);
    expect(spans(clipsOf(out, "vo"))).toEqual(spans(clipsOf(seq, "vo")));
  });

  it("夾在來源範圍內：往前不能超過 srcIn 0，往後不能超過媒體長度", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 100), vclip("c2", "m1", 200, 300)]);
    expect(ops.slipCapacity(seq, "c1", CTX)).toEqual({ left: 0, right: 1697 });
    expect(ops.slipClip(seq, "c1", -5, CTX)).toBe(seq); // srcIn 已經在 0
    expect(v1(ok(ops.slipClip(seq, "c1", 99999, CTX)))[0]).toEqual(["m1", 1697, 1797]);
    expect(ops.slipClip(seq, "c1", 0, CTX)).toBe(seq);
  });

  it("slip 與 slide 互補：同一個片段 slip 不動位置、slide 不動內容", () => {
    const seq = deepFreeze(three());
    const slipped = ok(ops.slipClip(seq, "c2", 10, CTX));
    const slid = ok(ops.slideClip(seq, "c2", 10, CTX));
    const lens = (x: SequenceV2) => x.video.map((it) => (it.kind === "clip" ? it.srcOut - it.srcIn : it.length));
    expect(lens(slipped)).toEqual(lens(seq)); // slip：每段長度都沒變
    expect(v1(slipped)[1]).toEqual(["m1", 210, 310]); // 內容換了
    expect(v1(slid)[1]).toEqual(["m1", 200, 300]); // slide：內容原封不動
    expect(lens(slid)).not.toEqual(lens(seq)); // 鄰居長度變了
  });
});

describe("copyClips / pasteClips", () => {
  const seq2 = () => seqOf([vclip("c1", "m1", 0, 300), vclip("c2", "m1", 300, 600)], [lane("vo", "voiceover", [aclip("a", "a-vo", 0, 480000)]), lane("music", "music", [aclip("m", "a-music", 0, 960000)])]);

  it("複製依時間順序抄、空白不抄；貼上插在剪輯點並波紋推後，同步鎖軌讓出時間、音樂軌不動", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 300), gap("g", 50), vclip("c2", "m1", 300, 600)]);
    // 傳入順序顛倒，仍照時間軸順序抄
    expect(ops.copyClips(seq, ["c2", "g", "c1"])).toEqual([
      { mediaId: "m1", srcIn: 0, srcOut: 300, enabled: true, audio: seq.video[0].kind === "clip" ? seq.video[0].audio : undefined },
      { mediaId: "m1", srcIn: 300, srcOut: 600, enabled: true, audio: seq.video[2].kind === "clip" ? seq.video[2].audio : undefined },
    ]);
    const src = seq2();
    const out = ok(ops.pasteClips(src, ops.copyClips(src, ["c1"]), 300, CTX));
    expect(v1(out)).toEqual([
      ["m1", 0, 300],
      ["m1", 0, 300],
      ["m1", 300, 600],
    ]);
    expect(durationFrames(out)).toBe(durationFrames(src) + 300);
    expect(out.audioLanes[1]).toBe(src.audioLanes[1]);
  });

  it("貼在序列尾端就接在最後；剪貼簿是空的不動；不會改到輸入", () => {
    const src = deepFreeze(seq2());
    const seeds = ops.copyClips(src, ["c2"]);
    expect(v1(ok(ops.pasteClips(src, seeds, 99999, CTX)))).toEqual([
      ["m1", 0, 300],
      ["m1", 300, 600],
      ["m1", 300, 600],
    ]);
    expect(ops.pasteClips(src, [], 0, CTX)).toBe(src);
  });
});

describe("rollEdit（Extend Edit）", () => {
  const three = () => seqOf([vclip("c1", "m1", 0, 100), vclip("c2", "m1", 200, 300), vclip("c3", "m1", 400, 500)], [lane("vo", "voiceover", [aclip("a", "a-vo", 0, 480000)])]);

  it("把剪接點往右移：左邊變長、右邊變短，序列總長不變、音訊軌不動", () => {
    const seq = three();
    const out = ok(ops.rollEdit(seq, 100, 20, CTX));
    expect(v1(out)).toEqual([
      ["m1", 0, 120],
      ["m1", 220, 300],
      ["m1", 400, 500],
    ]);
    expect(durationFrames(out)).toBe(durationFrames(seq));
    expect(spans(clipsOf(out, "vo"))).toEqual(spans(clipsOf(seq, "vo")));
  });

  it("往左移；夾住在吸收方只剩 1 幀；不是剪輯點就不動", () => {
    const seq = three();
    expect(v1(ok(ops.rollEdit(seq, 100, -20, CTX)))[0]).toEqual(["m1", 0, 80]);
    expect(ops.rollCapacity(seq, 100, CTX)).toEqual({ left: 99, right: 99 });
    expect(v1(ok(ops.rollEdit(seq, 100, 999, CTX)))[1]).toEqual(["m1", 299, 300]);
    // 序列尾端不是「兩項之間」→ 沒有東西可以吸收
    expect(ops.rollEdit(seq, 300, 10, CTX)).toBe(seq);
    expect(ops.rollEdit(seq, 57, 10, CTX)).toBe(seq);
    expect(ops.rollEdit(seq, 100, 0, CTX)).toBe(seq);
  });

  it("roll 兩個剪接點 ≠ 滑移：時間位置一樣，但 roll 會連片段內容一起滑掉（slip）", () => {
    const seq = three();
    const slid = ok(ops.slideClip(seq, "c2", 15, CTX));
    // 第一次 roll 之後 c2 變短，第二個剪接點跟著從 215 移到 200
    const rolled = ok(ops.rollEdit(ok(ops.rollEdit(seq, 100, 15, CTX)), 200, 15, CTX));
    const t0 = (x: SequenceV2) => x.video.map((it) => (it.kind === "clip" ? it.srcOut - it.srcIn : it.length));
    expect(t0(rolled)).toEqual(t0(slid)); // 每一段的長度（＝時間位置）相同
    expect(v1(slid)[1]).toEqual(["m1", 200, 300]); // slide：內容原封不動
    expect(v1(rolled)[1]).toEqual(["m1", 215, 315]); // roll 兩次：內容跟著滑掉 15 幀
  });
});

describe("overwriteMedia（Avid / Premiere overwrite）", () => {
  const base = () => seqOf([vclip("c1", "m1", 0, 900)], [lane("vo", "voiceover", [aclip("a", "a-vo", 0, 480000)])]);

  it("蓋在中間：只換掉媒體長度那一段，序列總長不變，音訊軌完全不動（這就是與 insert 的差別）", () => {
    const seq = base();
    const out = ok(ops.overwriteMedia(seq, M2, 100));
    expect(v1(out)).toEqual([
      ["m1", 0, 100],
      ["m2", 0, 600],
      ["m1", 700, 900],
    ]);
    expect(durationFrames(out)).toBe(durationFrames(seq));
    expect(spans(clipsOf(out, "vo"))).toEqual(spans(clipsOf(seq, "vo")));
  });

  it("蓋過尾端就把序列拉長", () => {
    const out = ok(ops.overwriteMedia(base(), M2, 600));
    expect(v1(out)).toEqual([
      ["m1", 0, 600],
      ["m2", 0, 600],
    ]);
    expect(durationFrames(out)).toBe(1200);
  });

  it("播放線在尾端之外：補一段空白把時間軸拉過去再接上", () => {
    expect(v1(ok(ops.overwriteMedia(base(), M2, 1000)))).toEqual([
      ["m1", 0, 900],
      ["gap", 100],
      ["m2", 0, 600],
    ]);
  });

  it("fps / 尺寸不符、沒有 proxy 照樣擲錯；不會改到輸入", () => {
    const seq = deepFreeze(base());
    expect(() => ops.overwriteMedia(seq, M25, 0)).toThrow(expect.objectContaining({ code: "fpsMismatch" }));
    expect(() => ops.overwriteMedia(seq, MBIG, 0)).toThrow(expect.objectContaining({ code: "sizeMismatch" }));
    expect(() => ops.overwriteMedia(seq, MNOPROXY, 0)).toThrow(expect.objectContaining({ code: "noProxy" }));
    expect(v1(ok(ops.overwriteMedia(seq, M2, 0)))[0]).toEqual(["m2", 0, 600]);
  });
});

describe("duplicateClip / slideClip", () => {
  const three = () => seqOf([vclip("c1", "m1", 0, 100), vclip("c2", "m1", 200, 300), vclip("c3", "m1", 400, 500)]);

  it("複製：複本緊接在原片段後面，後面往後推；同步鎖軌讓出同樣長的時間，音樂軌不動", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 300), vclip("c2", "m1", 300, 600)], [lane("vo", "voiceover", [aclip("a", "a-vo", 400000, 200000)]), lane("music", "music", [aclip("m", "a-music", 0, 960000)])]);
    const out = ok(ops.duplicateClip(seq, "c1", CTX));
    expect(v1(out)).toEqual([
      ["m1", 0, 300],
      ["m1", 0, 300],
      ["m1", 300, 600],
    ]);
    expect(durationFrames(out)).toBe(durationFrames(seq) + 300);
    expect(out.video[1].id).not.toBe(out.video[0].id);
    expect(out.audioLanes[1]).toBe(seq.audioLanes[1]);
    expect(ops.duplicateClip(seq, "沒這個 id", CTX)).toBe(seq);
  });

  it("滑移：前面的鄰居讓出、後面的吸收，序列總長不變，音訊軌完全不動", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 100), vclip("c2", "m1", 200, 300), vclip("c3", "m1", 400, 500)], [lane("vo", "voiceover", [aclip("a", "a-vo", 0, 480000)])]);
    const right = ok(ops.slideClip(seq, "c2", 10, CTX));
    expect(v1(right)).toEqual([
      ["m1", 0, 110],
      ["m1", 200, 300],
      ["m1", 410, 500],
    ]);
    expect(durationFrames(right)).toBe(durationFrames(seq));
    expect(spans(clipsOf(right, "vo"))).toEqual(spans(clipsOf(seq, "vo")));
    expect(v1(ok(ops.slideClip(seq, "c2", -10, CTX)))).toEqual([
      ["m1", 0, 90],
      ["m1", 200, 300],
      ["m1", 390, 500],
    ]);
  });

  it("夾住：吸收方最多只能讓到剩 1 幀，超過的部分不動；沒有鄰居就完全滑不動", () => {
    const seq = three();
    expect(ops.slideCapacity(seq, "c2", CTX)).toEqual({ left: 99, right: 99 });
    expect(v1(ok(ops.slideClip(seq, "c2", 999, CTX)))).toEqual([
      ["m1", 0, 199],
      ["m1", 200, 300],
      ["m1", 499, 500],
    ]);
    // 頭尾的片段沒有可以吸收位移的鄰居 → 回同一個參照（那是波紋，不是滑移）
    expect(ops.slideCapacity(seq, "c1", CTX)).toEqual({ left: 0, right: 0 });
    expect(ops.slideClip(seq, "c1", 5, CTX)).toBe(seq);
    expect(ops.slideClip(seq, "c3", -5, CTX)).toBe(seq);
    expect(ops.slideClip(seq, "c2", 0, CTX)).toBe(seq);
  });

  it("空隙被讓完就消失，不留 0 長度的項目", () => {
    const seq = seqOf([gap("g1", 50), vclip("c2", "m1", 200, 300), gap("g3", 50)]);
    expect(v1(ok(ops.slideClip(seq, "c2", 50, CTX)))).toEqual([
      ["gap", 100],
      ["m1", 200, 300],
    ]);
  });

  it("不會改到輸入", () => {
    const seq = deepFreeze(three());
    expect(v1(ok(ops.slideClip(seq, "c2", 7, CTX)))[0]).toEqual(["m1", 0, 107]);
    expect(v1(ok(ops.duplicateClip(seq, "c2", CTX))).length).toBe(4);
  });
});

describe("insertGap（FCP Insert Gap）", () => {
  const base = () => seqOf([vclip("c1", "m1", 0, 300), vclip("c2", "m1", 300, 600)], [lane("vo", "voiceover", [aclip("a", "a-vo", 400000, 200000)]), lane("music", "music", [aclip("m", "a-music", 0, 960000)])]);

  it("吸到最近的剪輯點插入空白，後面往後推；同步鎖軌讓出同樣長的時間，音樂軌不動", () => {
    const seq = base();
    const out = ok(ops.insertGap(seq, 290, 90, CTX));
    expect(v1(out)).toEqual([
      ["m1", 0, 300],
      ["gap", 90],
      ["m1", 300, 600],
    ]);
    expect(durationFrames(out)).toBe(durationFrames(seq) + 90);
    // 插入點 300 幀 = 480000 樣本，剛好落在語音片段（400000..600000）中間 → 切開，後半往後推 90 幀（144000 樣本）
    expect(spans(clipsOf(out, "vo"))).toEqual([
      [400000, 80000, 0],
      [624000, 120000, 80000],
    ]);
    expect(out.audioLanes[1]).toBe(seq.audioLanes[1]);
  });

  it("落在序列尾端就接在最後面", () => {
    const out = ok(ops.insertGap(base(), 10000, 30, CTX));
    expect(v1(out)).toEqual([
      ["m1", 0, 300],
      ["m1", 300, 600],
      ["gap", 30],
    ]);
  });

  it("插在既有空白旁邊會合併成一段，不會留下兩段相鄰的空白", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 100), gap("g1", 40), vclip("c2", "m1", 100, 200)]);
    expect(v1(ok(ops.insertGap(seq, 100, 20)))).toEqual([
      ["m1", 0, 100],
      ["gap", 60],
      ["m1", 100, 200],
    ]);
  });

  it("長度至少 1 幀（0 或負數夾住），而且不會改到輸入", () => {
    const seq = deepFreeze(base());
    expect(v1(ok(ops.insertGap(seq, 300, 0, CTX)))[1]).toEqual(["gap", 1]);
    expect(v1(ok(ops.insertGap(seq, 300, -5, CTX)))[1]).toEqual(["gap", 1]);
  });
});

describe("appendMedia / insertMedia / removeMediaRefs", () => {
  it("接到結尾；fps 不符、尺寸不符、沒有 proxy 各擲對應的錯", () => {
    const seq = ops.materialize(M1);
    const out = ok(ops.appendMedia(seq, M2));
    expect(v1(out)).toEqual([
      ["m1", 0, 1797],
      ["m2", 0, 600],
    ]);
    expect(out.video[1].id).toBe("clip-2");
    expect(() => ops.appendMedia(seq, M25)).toThrow(expect.objectContaining({ code: "fpsMismatch", message: expect.stringContaining("30/1") }));
    expect(() => ops.appendMedia(seq, MBIG)).toThrow(expect.objectContaining({ code: "sizeMismatch" }));
    expect(() => ops.appendMedia(seq, MNOPROXY)).toThrow(expect.objectContaining({ code: "noProxy" }));
  });

  it("在播放線插入：吸到最近剪輯點；同步鎖軌在插入點插入時間（跨點的切開），音樂軌不動", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 300), vclip("c2", "m1", 300, 600)], [lane("vo", "voiceover", [aclip("a", "a-vo", 400000, 200000), aclip("b", "a-vo", 700000, 1000)]), lane("music", "music", [aclip("m", "a-music", 0, 960000)])]);
    const out = ok(ops.insertMedia(seq, M2, 290, CTX));
    expect(v1(out)).toEqual([
      ["m1", 0, 300],
      ["m2", 0, 600],
      ["m1", 300, 600],
    ]);
    expect(spans(clipsOf(out, "vo"))).toEqual([
      [400000, 80000, 0],
      [1440000, 120000, 80000],
      [1660000, 1000, 0],
    ]);
    expect(out.audioLanes[1]).toBe(seq.audioLanes[1]);
    expect(v1(ok(ops.insertMedia(seq, M2, 10000, CTX)))).toEqual(v1(ok(ops.appendMedia(seq, M2))));
  });

  it("移除媒體：V1 片段波紋刪除；分離出來的原音連鎖定的軌也一起刪（不留懸空來源）", () => {
    const base = seqOf([vclip("c1", "m1", 0, 300), vclip("c2", "m2", 0, 600), vclip("c3", "m1", 300, 600)]);
    const detached = ops.detachAudio(base, "c2", CTX);
    const locked = ops.setLane(detached, detached.audioLanes[0].id, { locked: true });
    const out = ok(ops.removeMediaRefs(locked, "m2", CTX));
    expect(v1(out)).toEqual([
      ["m1", 0, 300],
      ["m1", 300, 600],
    ]);
    expect(out.audioLanes[0].clips).toEqual([]);
    expect(ops.removeMediaRefs(out, "m2", CTX)).toBe(out);
  });

  it("移除音訊媒體：刪掉所有用到它的片段", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 300)], [lane("music", "music", [aclip("a", "a-music", 0, 1000), aclip("b", "a-vo", 2000, 1000)], { locked: true })]);
    const out = ok(ops.removeAudioMediaRefs(seq, "a-music"));
    expect(clipsOf(out, "music").map((c) => c.id)).toEqual(["b"]);
    expect(ops.removeAudioMediaRefs(out, "a-music")).toBe(out);
  });
});

describe("純函式性質", () => {
  it("輸入整個深凍結，所有動作都不改它（結構共享，不就地修改）", () => {
    const seq = deepFreeze(ops.detachAudio(threeClips(), "c1", CTX));
    const runs: ((s: SequenceV2) => SequenceV2)[] = [
      (s) => ops.splitAt(s, 150, CTX, "all"),
      (s) => ops.joinThroughEdit(ops.splitAt(s, 150, CTX), 150, CTX),
      (s) => ops.rippleDelete(s, ["c2", "v4"], CTX),
      (s) => ops.lift(s, ["c3", "aclip-1"]),
      (s) => ops.extractRange(s, { in: 100, out: 700 }, CTX),
      (s) => ops.liftRange(s, { in: 100, out: 700 }),
      (s) => ops.trimEdge(s, "c2", "in", 30, CTX),
      (s) => ops.trimEdge(s, "v2", "out", -500, CTX),
      (s) => ops.setEnabled(s, ["c1", "v1"], false),
      (s) => ops.insertMedia(s, M2, 300, CTX),
      (s) => ops.removeMediaRefs(s, "m1", CTX),
      (s) => ops.duckRange(s, "A0", { in: 250, out: 350 }, -10, 4800),
      (s) => ops.setFades(s, ["v2", "c2"], { fadeIn: 9000 }),
    ];
    for (const run of runs) ok(run(seq));
  });
});
