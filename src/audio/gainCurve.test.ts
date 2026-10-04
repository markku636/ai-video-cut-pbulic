// 增益曲線（M2.16）：跟時間軸波形包絡（seqGeometry.clipGainFactor）逐點一致、防爆音淡化照渲染的 max(fade, D)、
// A0 原音在停用 / 分離 / 靜音 / 獨奏時的倍率、setValueCurveAtTime 用的取樣。
import { describe, expect, it } from "vitest";
import { clipGainFactor as drawGainFactor, fadeShape as drawFadeShape } from "../frametimeline/seqGeometry";
import type { ClipGainV2 } from "../project/format";
import { placeVideo, samplesOfFrame } from "../sequence/map";
import { FPS2997, gap, seqOf, vclip } from "../sequence/testkit";
import { busAudible, clipGainFactor, dbToGain, declickSamples, fadeShape, laneBusGain, originalGainAt, sampleCurve } from "./gainCurve";

const g = (over: Partial<ClipGainV2> = {}): ClipGainV2 => ({ gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [], ...over });

/** 固定種子的小 PRNG：失敗時重跑得出同一組輸入。 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe("跟時間軸波形包絡同一條曲線", () => {
  it("declick = 0 時與 seqGeometry.clipGainFactor 逐點相同（500 組隨機增益 × 各 20 個位置）", () => {
    const r = rng(20260917);
    for (let i = 0; i < 500; i++) {
      const length = 1000 + Math.floor(r() * 200_000);
      const env = Array.from({ length: Math.floor(r() * 5) }, () => ({ at: Math.floor(r() * length), db: -96 + r() * 108 })).sort((a, b) => a.at - b.at);
      const gain = g({ gainDb: -30 + r() * 42, fadeIn: Math.floor(r() * length * 0.4), fadeOut: Math.floor(r() * length * 0.4), fadeCurve: r() < 0.5 ? "linear" : "equalPower", envelope: env });
      const busDb = r() < 0.5 ? 0 : -12 + r() * 18;
      for (let j = 0; j < 20; j++) {
        const at = r() * length;
        expect(clipGainFactor(gain, at, length, busDb)).toBe(drawGainFactor(gain, at, length, busDb));
      }
    }
    for (const x of [-0.5, 0, 0.3, 0.5, 1, 1.5]) for (const c of ["linear", "equalPower"] as const) expect(fadeShape(x, c)).toBe(drawFadeShape(x, c));
  });
});

describe("clipGainFactor", () => {
  it("dB 相加、≤ −90 dB 視為靜音；equalPower 是 sin(x·π/2)（afade qsin）", () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-6)).toBeCloseTo(0.501187, 6);
    expect(dbToGain(-90)).toBe(0);
    expect(clipGainFactor(g({ gainDb: -40 }), 10, 100, -50)).toBe(0);
    expect(clipGainFactor(g({ fadeIn: 100, fadeCurve: "equalPower" }), 50, 1000)).toBeCloseTo(Math.SQRT1_2, 12);
    expect(clipGainFactor(g({ fadeOut: 100 }), 950, 1000)).toBeCloseTo(0.5, 12);
  });

  it("防爆音：兩端至少 D 個樣本的淡化（渲染的 afade ns = max(fade, D)）；使用者淡化比 D 長就只用使用者的", () => {
    const D = 144;
    expect(clipGainFactor(g(), 0, 48000, 0, D)).toBe(0);
    expect(clipGainFactor(g(), 72, 48000, 0, D)).toBeCloseTo(0.5, 12);
    expect(clipGainFactor(g(), 200, 48000, 0, D)).toBe(1);
    expect(clipGainFactor(g(), 48000 - 36, 48000, 0, D)).toBeCloseTo(0.25, 12);
    expect(clipGainFactor(g({ fadeIn: 4800 }), 2400, 48000, 0, D)).toBeCloseTo(0.5, 12);
    expect(declickSamples(seqOf([]))).toBe(144);
    expect(declickSamples({ audio: { edgeDeclickMs: 0, limiter: false } })).toBe(0);
  });

  it("自動化點在 dB 域內插（閃避 −10 dB 的斜坡中點是 −5 dB）", () => {
    const env = [
      { at: 1000, db: 0 },
      { at: 2000, db: -10 },
    ];
    expect(clipGainFactor(g({ envelope: env }), 1500, 10000)).toBeCloseTo(10 ** (-5 / 20), 12);
    expect(clipGainFactor(g({ envelope: env, gainDb: -3 }), 5000, 10000)).toBeCloseTo(10 ** (-13 / 20), 12);
  });
});

describe("sampleCurve（setValueCurveAtTime 的陣列）", () => {
  it("含兩端、間距不超過 step、至少 2 點", () => {
    const v = sampleCurve((x) => x, 0, 1000, 240);
    expect(v.length).toBe(6);
    expect(v[0]).toBe(0);
    expect(v[5]).toBe(1000);
    expect(v[1]).toBeCloseTo(200, 3);
    expect(sampleCurve(() => 1, 5, 5, 240).length).toBe(2);
  });
});

describe("匯流排：靜音、獨奏、推桿", () => {
  it("靜音一律聽不到；有獨奏時只聽獨奏的；推桿換成倍率", () => {
    expect(busAudible("l1", false, [])).toBe(true);
    expect(busAudible("l1", true, ["l1"])).toBe(false);
    expect(busAudible("l1", false, ["l2"])).toBe(false);
    expect(busAudible("A0", false, ["A0", "l2"])).toBe(true);
    expect(laneBusGain({ id: "l1", muted: false, gainDb: -6 }, [])).toBeCloseTo(0.501187, 6);
    expect(laneBusGain({ id: "l1", muted: false, gainDb: 0 }, ["l9"])).toBe(0);
  });
});

describe("originalGainAt（A0 原音預覽）", () => {
  const seq = seqOf(
    [
      vclip("c1", "m1", 0, 300, { audio: { enabled: true, gainDb: -6, fadeIn: 0, fadeOut: 48000, fadeCurve: "linear", envelope: [] } }),
      gap("g", 30),
      vclip("c2", "m1", 300, 600, { enabled: false }),
      vclip("c3", "m1", 600, 900, { audio: { enabled: false, detachedTo: "a1", gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [] } }),
    ],
    [],
  );
  const placedList = placeVideo(seq);
  const placed = (i: number) => placedList[i];

  it("片段增益＋A0 推桿＋淡出＋防爆音；位置用序列樣本", () => {
    const p = placed(0);
    expect(originalGainAt(seq, p, 48000)).toBeCloseTo(10 ** (-6 / 20), 12);
    expect(originalGainAt(seq, p, 480000 - 24000)).toBeCloseTo(10 ** (-6 / 20) * 0.5, 12);
    expect(originalGainAt(seq, p, 0)).toBe(0); // 防爆音起點
    expect(originalGainAt({ ...seq, original: { muted: false, gainDb: -6 } }, p, 48000)).toBeCloseTo(10 ** (-12 / 20), 12);
  });

  it("A0 靜音、被別的軌獨奏、空白、停用片段、已分離的原音 → 0；獨奏 A0 自己 → 照常", () => {
    const p = placed(0);
    expect(originalGainAt({ ...seq, original: { muted: true, gainDb: 0 } }, p, 48000)).toBe(0);
    expect(originalGainAt(seq, p, 48000, ["lane-1"])).toBe(0);
    expect(originalGainAt(seq, p, 48000, ["A0"])).toBeGreaterThan(0);
    expect(originalGainAt(seq, placed(1), 480000 + 100)).toBe(0);
    expect(originalGainAt(seq, placed(2), 700000)).toBe(0);
    expect(originalGainAt(seq, placed(3), 1000000)).toBe(0);
  });

  it("29.97 fps：片段長度用 S(t1) − S(t0)（跟渲染的 L 一樣），淡出終點落在 S(t1)", () => {
    const s = seqOf([vclip("c1", "m1", 0, 300, { audio: { enabled: true, gainDb: 0, fadeIn: 0, fadeOut: 4800, fadeCurve: "linear", envelope: [] } })], [], FPS2997);
    const p = { item: s.video[0], t0: 0, t1: 300, index: 0 };
    const L = samplesOfFrame(300, FPS2997);
    expect(L).toBe(480480);
    expect(originalGainAt(s, p, L - 2400)).toBeCloseTo(0.5, 12);
  });
});
