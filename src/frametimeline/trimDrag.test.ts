// M2.13 邊緣修剪拖曳（docs/editor-m2-design.md §13 M2.13 驗收）：夾在媒體邊界、長度 ≥ 1 幀、V1 波紋位移、
// syncLock 軌跟著動、Esc 還原、吸附指示；外加音訊片段的幀吸附 / Alt 樣本級、吸附開關與修剪到播放線的守門。
import { describe, expect, it } from "vitest";
import * as ops from "../sequence/ops";
import { aclip, CTX, deepFreeze, FPS2997, gap, lane, ok, seqOf, vclip } from "../sequence/testkit";
import { samplesOfFrame } from "../sequence/map";
import {
  beginTrimDrag,
  cancelTrimDrag,
  collectTrimSnapTargets,
  formatSignedInt,
  formatSignedSeconds,
  nearestTrimSnap,
  rangeSnapTargetsOf,
  trimCommitOf,
  trimHoverText,
  trimTipInfo,
  trimTipText,
  trimToPlayheadCheck,
  updateTrimDrag,
  useSnap,
  type TrimDrag,
  type TrimTarget,
} from "./trimDrag";

const S30 = (t: number) => samplesOfFrame(t, { num: 30, den: 1 });
/** 4 px/幀、不吸附。 */
const FREE = { pxPerFrame: 4, targets: [], ctx: CTX };

function begin(seq: Parameters<typeof beginTrimDrag>[0], target: TrimTarget, anchorRaw: number): TrimDrag {
  const r = beginTrimDrag(seq, target, anchorRaw);
  if (!r.ok) throw new Error(`begin refused: ${r.reason}`);
  return r.drag;
}

const v1 = (seq: ReturnType<typeof seqOf>) => seq.video.map((it) => (it.kind === "clip" ? [it.id, it.srcIn, it.srcOut] : ["gap", it.length]));
const starts = (seq: ReturnType<typeof seqOf>, laneId: string) => seq.audioLanes.find((l) => l.id === laneId)!.clips.map((c) => [c.id, c.start, c.length]);

describe("trimDrag：吸附目標", () => {
  const seq = seqOf(
    [vclip("c1", "m1", 0, 100), vclip("c2", "m1", 200, 300), gap("g", 50)],
    [
      lane("A1", "music", [aclip("a1", "a-music", 1000, 1000), aclip("a2", "a-music", S30(30), S30(15))]),
      // 比 V1（T = 250）長的音效：尾端在 T 之後仍然是目標
      lane("A2", "sfx", [aclip("s1", "a-vo", S30(240), S30(30))]),
    ],
  );

  it("播放線 / V1 內部剪輯點 / 音訊片段兩端（精確樣本）/ 範圍 / 關鍵幀（經對應表）/ 頭尾；同位置保留先出現的種類", () => {
    const t = collectTrimSnapTargets(seq, { playhead: 100, range: { in: 10, out: 30 }, keyframes: { mediaId: "m1", frames: [50, 250, 150] } });
    expect(t).toEqual([
      { frame: 0, kind: "bound" },
      { frame: 0.625, sample: 1000, kind: "edit" },
      { frame: 1.25, sample: 2000, kind: "edit" },
      { frame: 10, kind: "range" },
      // 範圍出點 30 跟音訊片段開頭 S(30) 是同一個點：剪輯點先加入
      { frame: 30, sample: 48000, kind: "edit" },
      { frame: 45, sample: 72000, kind: "edit" },
      { frame: 50, kind: "keyframe" },
      // 100 同時是播放線與 V1 剪輯點：播放線優先
      { frame: 100, kind: "playhead" },
      // k=250 在 c2（來源 200..300，放在 100..200）→ 150；k=150 沒用在序列裡
      { frame: 150, kind: "keyframe" },
      { frame: 200, kind: "edit" },
      { frame: 240, sample: S30(240), kind: "edit" },
      { frame: 250, kind: "bound" },
      { frame: 270, sample: S30(270), kind: "edit" },
    ]);
  });

  it("6 px 內才吸，取最近；pxPerFrame 無效時不吸", () => {
    const t = collectTrimSnapTargets(seq, { playhead: 100 });
    expect(nearestTrimSnap(103, t, 4)).toBeNull();
    expect(nearestTrimSnap(101.4, t, 4)).toEqual({ frame: 100, kind: "playhead" });
    expect(nearestTrimSnap(1.1, t, 4)).toEqual({ frame: 1.25, sample: 2000, kind: "edit" });
    expect(nearestTrimSnap(100, t, 0)).toBeNull();
  });

  it("範圍拖曳用的目標：剪輯點換成 shot、丟掉範圍端點、四捨五入到整數幀並去重", () => {
    const t = collectTrimSnapTargets(seq, { playhead: 100, range: { in: 10, out: 30 } });
    expect(rangeSnapTargetsOf(t)).toEqual([
      { frame: 0, kind: "bound" },
      { frame: 1, kind: "shot" },
      { frame: 30, kind: "shot" },
      { frame: 45, kind: "shot" },
      { frame: 100, kind: "playhead" },
      { frame: 200, kind: "shot" },
      { frame: 240, kind: "shot" },
      { frame: 250, kind: "bound" },
      { frame: 270, kind: "shot" },
    ]);
  });

  it("吸附開關：沒存過 = 開；toggle 來回切", () => {
    const s = useSnap.getState();
    s.setEnabled(true);
    expect(useSnap.getState().enabled).toBe(true);
    useSnap.getState().toggle();
    expect(useSnap.getState().enabled).toBe(false);
    useSnap.getState().toggle();
    expect(useSnap.getState().enabled).toBe(true);
  });
});

describe("trimDrag：V1 波紋修剪", () => {
  const base = () =>
    deepFreeze(
      seqOf(
        [vclip("c1", "m1", 0, 300), vclip("c2", "m2", 0, 300)],
        [
          // 旁白軌（同步鎖開）與音樂軌（同步鎖關，§0.1 Q3）各一段，都在 c1 結尾之後
          lane("VO", "voiceover", [aclip("vo", "a-vo", S30(400), S30(30))]),
          lane("MU", "music", [aclip("mu", "a-music", S30(400), S30(30))]),
        ],
      ),
    );

  it("結尾往前 20 幀：後面的片段往前補、同步鎖軌跟著移、音樂軌不動；保留按下時游標與邊緣的距離", () => {
    const seq = base();
    const d = begin(seq, { kind: "v1", id: "c1", edge: "out" }, 301.5);
    expect(d.edgeAt).toBe(300);
    const r = updateTrimDrag(d, 281.5, FREE);
    expect(r).toMatchObject({ unit: "frame", delta: -20, requested: -20, snap: null, edgeFrame: 280, limit: null });
    ok(r.seq);
    expect(v1(r.seq)).toEqual([["c1", 0, 280], ["c2", 0, 300]]);
    expect(starts(r.seq, "VO")).toEqual([["vo", S30(380), S30(30)]]);
    expect(starts(r.seq, "MU")).toEqual([["mu", S30(400), S30(30)]]);
  });

  it("開頭往後 30 幀：邊緣留在原位（磁吸）、來源入點前進、後面整段往前移", () => {
    const seq = base();
    const d = begin(seq, { kind: "v1", id: "c2", edge: "in" }, 300);
    const r = updateTrimDrag(d, 330.2, FREE);
    expect(r.delta).toBe(30);
    ok(r.seq);
    expect(v1(r.seq)).toEqual([["c1", 0, 300], ["c2", 30, 300]]);
    expect(starts(r.seq, "VO")).toEqual([["vo", S30(370), S30(30)]]);
    expect(starts(r.seq, "MU")).toEqual([["mu", S30(400), S30(30)]]);
    expect(trimTipInfo(d, r)).toMatchObject({ unit: "frame", delta: 30, sourceFrame: 30, mediaId: "m2", length: 270, snap: null, limit: null });
  });

  it("夾在媒體邊界：往外延長最多到 proxy 幀數、入點不低於 0；沒有 ctx（幀數未知）不能延長", () => {
    const seq = base();
    const out = updateTrimDrag(begin(seq, { kind: "v1", id: "c1", edge: "out" }, 300), 5300, FREE);
    expect(out).toMatchObject({ delta: 1497, requested: 5000, limit: "source", edgeFrame: 1797 });
    expect(v1(ok(out.seq))[0]).toEqual(["c1", 0, 1797]);
    expect(trimTipInfo(begin(seq, { kind: "v1", id: "c1", edge: "out" }, 300), out)).toMatchObject({ sourceFrame: 1797, length: 1797, limit: "source" });

    const inn = updateTrimDrag(begin(seq, { kind: "v1", id: "c2", edge: "in" }, 300), 250, FREE);
    expect(inn).toMatchObject({ delta: 0, requested: -50, limit: "source" });
    expect(inn.seq).toBe(seq);

    const noCtx = updateTrimDrag(begin(seq, { kind: "v1", id: "c1", edge: "out" }, 300), 340, { pxPerFrame: 4, targets: [] });
    expect(noCtx).toMatchObject({ delta: 0, requested: 40, limit: "source" });
  });

  it("長度 ≥ 1 幀：開頭拖過結尾、結尾拖過開頭都停在 1 幀", () => {
    const seq = base();
    const a = updateTrimDrag(begin(seq, { kind: "v1", id: "c1", edge: "in" }, 0), 1000, FREE);
    expect(a).toMatchObject({ delta: 299, limit: "min" });
    expect(v1(ok(a.seq))[0]).toEqual(["c1", 299, 300]);
    const b = updateTrimDrag(begin(seq, { kind: "v1", id: "c2", edge: "out" }, 600), -1000, FREE);
    expect(b).toMatchObject({ delta: -299, limit: "min" });
    expect(v1(ok(b.seq))[1]).toEqual(["c2", 0, 1]);
  });

  it("空白的邊緣也能拖（長度 ≥ 1），碰到的限制一律是長度下限", () => {
    const seq = deepFreeze(seqOf([vclip("c1", "m1", 0, 30), gap("g", 10), vclip("c2", "m1", 30, 60)]));
    const r = updateTrimDrag(begin(seq, { kind: "v1", id: "g", edge: "out" }, 40), 0, FREE);
    expect(r).toMatchObject({ delta: -9, limit: "min" });
    expect(v1(ok(r.seq))).toEqual([["c1", 0, 30], ["gap", 1], ["c2", 30, 60]]);
    expect(trimTipInfo(begin(seq, { kind: "v1", id: "g", edge: "out" }, 40), r)).toMatchObject({ sourceFrame: null, mediaId: null, length: 1 });
  });

  it("無狀態重算：拖過頭再拖回原位 → 同一個 origin 參照；origin 從頭到尾沒被改（深凍結）；Esc = origin、commit = null", () => {
    const seq = base();
    const d = begin(seq, { kind: "v1", id: "c1", edge: "out" }, 300);
    updateTrimDrag(d, 100, FREE);
    updateTrimDrag(d, 900, FREE);
    const back = updateTrimDrag(d, 300.3, FREE);
    expect(back.seq).toBe(seq);
    expect(back.delta).toBe(0);
    expect(trimCommitOf(d, back)).toBeNull();
    expect(trimCommitOf(d, null)).toBeNull();
    expect(cancelTrimDrag(d)).toBe(seq);
    expect(v1(seq)).toEqual([["c1", 0, 300], ["c2", 0, 300]]);
  });

  it("commit 用最後的 delta 重做一次 trimEdge：結果跟預覽逐欄相同", () => {
    const seq = base();
    const d = begin(seq, { kind: "v1", id: "c1", edge: "out" }, 300);
    const r = updateTrimDrag(d, 250, FREE);
    const c = trimCommitOf(d, r)!;
    expect(c).toEqual({ id: "c1", edge: "out", delta: -50 });
    expect(ops.trimEdge(seq, c.id, c.edge, c.delta, CTX)).toEqual(r.seq);
  });
});

describe("trimDrag：吸附指示", () => {
  const seq = deepFreeze(seqOf([vclip("c1", "m1", 0, 300), vclip("c2", "m2", 0, 300)]));

  it("結尾吸到播放線：指示線在播放線上、提示種類是 playhead；Alt（free）不吸", () => {
    const targets = collectTrimSnapTargets(seq, { playhead: 250 });
    const d = begin(seq, { kind: "v1", id: "c1", edge: "out" }, 300);
    const r = updateTrimDrag(d, 251.2, { pxPerFrame: 4, targets, ctx: CTX });
    expect(r).toMatchObject({ delta: -50, snap: { frame: 250, kind: "playhead" }, edgeFrame: 250 });
    expect(trimTipInfo(d, r).snap).toBe("playhead");
    const alt = updateTrimDrag(d, 251.2, { pxPerFrame: 4, targets, ctx: CTX, free: true });
    expect(alt).toMatchObject({ delta: -49, snap: null, edgeFrame: 251 });
    // 吸附關（targets 空）跟 Alt 一樣
    expect(updateTrimDrag(d, 251.2, FREE)).toMatchObject({ delta: -49, snap: null });
  });

  it("開頭吸到播放線 = 修剪開頭到播放線（Ctrl+Shift+[ 的拖曳版），結果與 ops.rippleTrimToPlayhead 相同", () => {
    const targets = collectTrimSnapTargets(seq, { playhead: 350 });
    const d = begin(seq, { kind: "v1", id: "c2", edge: "in" }, 300);
    const r = updateTrimDrag(d, 349, { pxPerFrame: 4, targets, ctx: CTX });
    expect(r).toMatchObject({ delta: 50, snap: { frame: 350, kind: "playhead" }, edgeFrame: 350 });
    expect(r.seq).toEqual(ops.rippleTrimToPlayhead(seq, 350, "in", CTX));
  });

  it("吸到的位置被夾住 → 不回報吸附（邊緣不在那條線上）；吸回原位（delta 0）也不畫", () => {
    const short = deepFreeze(seqOf([vclip("c1", "m2", 0, 590), vclip("c2", "m1", 0, 100)]));
    // m2 只有 600 幀：往後延長到 650 的剪輯點會被夾在 600
    const targets = collectTrimSnapTargets(short, { playhead: 650 });
    const d = begin(short, { kind: "v1", id: "c1", edge: "out" }, 590);
    expect(updateTrimDrag(d, 649, { pxPerFrame: 4, targets, ctx: CTX })).toMatchObject({ delta: 10, requested: 60, snap: null, limit: "source" });
    const self = collectTrimSnapTargets(short, {});
    expect(updateTrimDrag(d, 590.9, { pxPerFrame: 4, targets: self, ctx: CTX })).toMatchObject({ delta: 0, snap: null });
  });

  it("V1 吸到小數幀的音訊片段邊緣：四捨五入到幀，指示線畫在實際落點", () => {
    const withAudio = deepFreeze(seqOf([vclip("c1", "m1", 0, 300)], [lane("A1", "music", [aclip("a", "a-music", S30(200) + 1000, 1000)])]));
    const targets = collectTrimSnapTargets(withAudio, {});
    // 片段在 200.625..201.25 幀；游標 201 離尾端（0.25 幀）比開頭（0.375 幀）近
    const r = updateTrimDrag(begin(withAudio, { kind: "v1", id: "c1", edge: "out" }, 300), 201, { pxPerFrame: 4, targets, ctx: CTX });
    expect(r).toMatchObject({ delta: -99, edgeFrame: 201, snap: { frame: 201.25, sample: S30(200) + 2000, kind: "edit" } });
  });
});

describe("trimDrag：音訊片段（不波紋、幀吸附、Alt 樣本級）", () => {
  // a1：序列 1.0 s 起 1 s；a2：3.0 s 起 1 s（同一條音樂軌，同步鎖關）
  const seq = deepFreeze(
    seqOf(
      [vclip("c1", "m1", 0, 300)],
      [lane("MU", "music", [aclip("a1", "a-music", 48000, 48000), aclip("a2", "a-music", 144000, 48000)]), lane("LK", "sfx", [aclip("lk", "a-vo", 0, 48000)], { locked: true })],
    ),
  );
  const target = (edge: "in" | "out"): TrimTarget => ({ kind: "audio", id: "a1", laneId: "MU", edge });

  it("預設吸到幀邊界 S(t)；Alt = 樣本級；同軌後面的片段不動（不波紋），V1 也不動", () => {
    const d = begin(seq, target("out"), 60);
    expect(d.edgeAt).toBe(96000);
    const r = updateTrimDrag(d, 70.3, FREE);
    expect(r).toMatchObject({ unit: "sample", delta: 16000, edgeFrame: 70, limit: null });
    ok(r.seq);
    expect(starts(r.seq, "MU")).toEqual([["a1", 48000, 64000], ["a2", 144000, 48000]]);
    expect(r.seq.video).toBe(seq.video);
    expect(trimTipInfo(d, r)).toMatchObject({ unit: "sample", delta: 16000, length: 64000, sourceFrame: null });

    const alt = updateTrimDrag(d, 70.3, { ...FREE, free: true });
    expect(alt.delta).toBe(16480);
    expect(alt.edgeFrame).toBeCloseTo(70.3, 9);
  });

  it("開頭往後：start 跟著移、來源入點前進（44.1 kHz 原生樣本）", () => {
    const r = updateTrimDrag(begin(seq, target("in"), 30), 45, FREE);
    expect(r.delta).toBe(24000);
    ok(r.seq);
    const c = r.seq.audioLanes[0].clips[0];
    expect([c.start, c.length, c.srcIn]).toEqual([72000, 24000, 22050]);
  });

  it("夾住的原因：長度下限 / 碰到相鄰片段 / 素材開頭", () => {
    expect(updateTrimDrag(begin(seq, target("in"), 30), 200, FREE)).toMatchObject({ delta: 47999, limit: "min" });
    expect(updateTrimDrag(begin(seq, target("out"), 60), 200, FREE)).toMatchObject({ delta: 48000, limit: "neighbor" });
    expect(updateTrimDrag(begin(seq, target("in"), 30), 0, FREE)).toMatchObject({ delta: 0, limit: "source" });
  });

  it("吸到別條軌的小數幀邊緣：用精確樣本，不是幀邊界", () => {
    const two = deepFreeze(seqOf([vclip("c1", "m1", 0, 300)], [lane("MU", "music", [aclip("a1", "a-music", 48000, 48000)]), lane("SF", "sfx", [aclip("s", "a-vo", 100000, 1000)])]));
    const targets = collectTrimSnapTargets(two, {});
    const r = updateTrimDrag(begin(two, target("out"), 60), 62.4, { pxPerFrame: 4, targets, ctx: CTX });
    expect(r).toMatchObject({ delta: 4000, snap: { sample: 100000, kind: "edit" }, edgeFrame: 62.5 });
  });

  it("29.97 fps：幀邊界是 floor(t · 1601.6)", () => {
    const s2997 = deepFreeze(seqOf([vclip("c1", "m2997", 0, 300)], [lane("MU", "music", [aclip("a1", "a-music", 0, 48000)])], FPS2997));
    const r = updateTrimDrag(begin(s2997, target("out"), 29.97), 39.97, FREE);
    // 邊緣在 48000（= 29.97 幀）+10 幀 → 39.97 → 四捨五入 40 → S(40) = floor(40 × 1601.6) = 64064
    expect(r.delta).toBe(64064 - 48000);
    ok(r.seq);
  });

  it("鎖定的軌不能拖；找不到的片段也拒絕", () => {
    expect(beginTrimDrag(seq, { kind: "audio", id: "lk", laneId: "LK", edge: "out" }, 30)).toEqual({ ok: false, reason: "locked" });
    expect(beginTrimDrag(seq, { kind: "audio", id: "nope", laneId: "MU", edge: "out" }, 30)).toEqual({ ok: false, reason: "notFound" });
    expect(beginTrimDrag(seq, { kind: "v1", id: "nope", edge: "in" }, 30)).toEqual({ ok: false, reason: "notFound" });
  });
});

describe("trimDrag：修剪到播放線（Ctrl+Shift+[ / ]）與提示格式", () => {
  const seq = seqOf([vclip("c1", "m1", 0, 300), gap("g", 30), vclip("c2", "m1", 600, 900)]);

  it("播放線要在片段內部；切點上、空白上、序列外、沒有播放線都不行，理由分開", () => {
    expect(trimToPlayheadCheck(seq, 150)).toEqual({ ok: true, clipId: "c1" });
    expect(trimToPlayheadCheck(seq, 400)).toEqual({ ok: true, clipId: "c2" });
    expect(trimToPlayheadCheck(seq, 0)).toEqual({ ok: false, reason: "atEdit" });
    expect(trimToPlayheadCheck(seq, 330)).toEqual({ ok: false, reason: "atEdit" });
    expect(trimToPlayheadCheck(seq, 310)).toEqual({ ok: false, reason: "notOnClip" });
    expect(trimToPlayheadCheck(seq, 5000)).toEqual({ ok: false, reason: "notOnClip" });
    expect(trimToPlayheadCheck(seq, null)).toEqual({ ok: false, reason: "noPlayhead" });
    expect(trimToPlayheadCheck(null, 10)).toEqual({ ok: false, reason: "noSequence" });
    // 守門說不行的位置，ops 也確實什麼都不做（同一個參照）
    for (const t of [0, 330, 310]) expect(ops.rippleTrimToPlayhead(seq, t, "in", CTX)).toBe(seq);
  });

  /** 測試用的 t：原文當 key，代入參數（同 i18n identity fallback）。 */
  const tt = (zh: string, p?: Readonly<Record<string, string | number>>) => zh.replace(/\{(\w+)\}/g, (_, k: string) => String(p?.[k] ?? `{${k}}`));

  it("tooltip：V1「修剪開頭 −12 幀｜來源入點 TC｜長度 TC」＋吸附＋限制；音訊換成秒，Alt 加註樣本級", () => {
    const s = deepFreeze(seqOf([vclip("c1", "m1", 60, 360), vclip("c2", "m1", 930, 1380)], [lane("MU", "music", [aclip("a", "a-music", 48000, 48000)])]));
    const d1 = begin(s, { kind: "v1", id: "c2", edge: "in" }, 300);
    const r1 = updateTrimDrag(d1, 288, { pxPerFrame: 4, targets: collectTrimSnapTargets(s, { playhead: 288 }), ctx: CTX });
    expect(trimTipText(tt, trimTipInfo(d1, r1), { seqFps: s.fps })).toBe("修剪開頭 −12 幀｜來源入點 00:00:30:18｜長度 00:00:15:12 · 吸附：播放線");

    const d2 = begin(s, { kind: "v1", id: "c1", edge: "out" }, 300);
    const r2 = updateTrimDrag(d2, 5000, FREE);
    expect(trimTipText(tt, trimTipInfo(d2, r2), { seqFps: s.fps })).toBe("修剪結尾 +1437 幀｜來源出點 00:00:59:27｜長度 00:00:57:27 · 已到素材邊界");

    const d3 = begin(s, { kind: "audio", id: "a", laneId: "MU", edge: "out" }, 60);
    const r3 = updateTrimDrag(d3, 45, { ...FREE, free: true });
    expect(trimTipText(tt, trimTipInfo(d3, r3), { seqFps: s.fps, free: true })).toBe("修剪結尾 −0.500 秒｜長度 0.500 秒 · 樣本級");

    expect(trimHoverText(tt, { kind: "v1", id: "c1", edge: "in" }, false)).toBe("拖曳修剪（後面的片段跟著移）；Alt 不吸附");
    expect(trimHoverText(tt, { kind: "audio", id: "a", laneId: "MU", edge: "in" }, false)).toBe("拖曳修剪；Alt＝樣本級、不吸附");
    expect(trimHoverText(tt, { kind: "audio", id: "a", laneId: "MU", edge: "in" }, true)).toBe("已鎖定");
  });

  it("正負號用真的減號；秒數 3 位小數", () => {
    expect([formatSignedInt(12), formatSignedInt(-12), formatSignedInt(0)]).toEqual(["+12", "−12", "0"]);
    expect([formatSignedSeconds(12000), formatSignedSeconds(-48000), formatSignedSeconds(0), formatSignedSeconds(10)]).toEqual(["+0.250", "−1.000", "0.000", "0.000"]);
  });
});
