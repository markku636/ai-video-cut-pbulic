// 序列對應表 × fixtures/sequence/map-cases.json（跟 Python aivc/sequence/model.py 共用同一份期望值，§3.3）。
import { describe, expect, it } from "vitest";
import type { SequenceV2 } from "../project/format";
import { audioAbsUs, durationFrames, floorDiv, frameOfSample, isUntouched, mapFrame, placeVideo, samplesOfFrame, totalSamples, videoAbsUs } from "./map";

interface MapCase {
  name: string;
  sequence: SequenceV2;
  expect: {
    durationFrames: number;
    totalSamples: number;
    placed: { id: string; kind: string; t0: number; t1: number; s0: number; s1: number }[];
    frames: { t: number; itemId: string | null; itemK: number | null; clipId: string | null; k: number | null }[];
    samplesOfFrame: [number, number][];
  };
}

interface MapCases {
  cases: MapCase[];
  absUs: {
    video: { fps: { num: number; den: number }; videoStartUs: number; k: number; us: number }[];
    audio: { startUs: number; sampleRate: number; srcIn: number; us: number }[];
  };
  untouched: { media: Record<string, { frames: number }>; cases: { name: string; sequence: SequenceV2 | null; expect: boolean }[] };
}

const FILES = import.meta.glob("../../fixtures/sequence/map-cases.json", { eager: true, import: "default" }) as Record<string, unknown>;
const CASES = FILES["../../fixtures/sequence/map-cases.json"] as MapCases;

describe("map-cases.json（TS／Python 共用 golden）", () => {
  it("fixture 載得到，而且涵蓋設計要求的 fps（30/1、30000/1001、24000/1001、25/1）", () => {
    expect(CASES.cases.length).toBeGreaterThanOrEqual(6);
    const rates = new Set(CASES.cases.map((c) => `${c.sequence.fps.num}/${c.sequence.fps.den}`));
    for (const r of ["30/1", "30000/1001", "24000/1001", "25/1"]) expect(rates).toContain(r);
  });

  for (const c of CASES.cases) {
    describe(c.name, () => {
      it("durationFrames / totalSamples / placed", () => {
        expect(durationFrames(c.sequence)).toBe(c.expect.durationFrames);
        expect(totalSamples(c.sequence)).toBe(c.expect.totalSamples);
        const placed = placeVideo(c.sequence).map((p) => ({ id: p.item.id, kind: p.item.kind, t0: p.t0, t1: p.t1, s0: samplesOfFrame(p.t0, c.sequence.fps), s1: samplesOfFrame(p.t1, c.sequence.fps) }));
        expect(placed).toEqual(c.expect.placed);
      });

      it("鋪滿性質：Σ(s1 − s0) = S(T)，相鄰片段不留縫也不重疊", () => {
        const placed = c.expect.placed;
        expect(placed.reduce((n, p) => n + (p.s1 - p.s0), 0)).toBe(c.expect.totalSamples);
        for (let i = 1; i < placed.length; i++) expect(placed[i].s0).toBe(placed[i - 1].s1);
      });

      it("frames：t → (項目, itemK, 渲染片段, k)", () => {
        const placed = placeVideo(c.sequence);
        for (const f of c.expect.frames) {
          const m = mapFrame(c.sequence, f.t, placed);
          expect({ t: f.t, itemId: m.item?.id ?? null, itemK: m.itemK, clipId: m.clip?.id ?? null, k: m.k }).toEqual(f);
        }
      });

      it("samplesOfFrame（含 1 小時以上的大 t，整數運算不漂）；frameOfSample 是它的反函數", () => {
        for (const [t, s] of c.expect.samplesOfFrame) {
          expect(samplesOfFrame(t, c.sequence.fps)).toBe(s);
          expect(frameOfSample(s, c.sequence.fps)).toBe(t);
          if (t > 0) expect(frameOfSample(s - 1, c.sequence.fps)).toBe(t - 1);
        }
      });
    });
  }

  it("absUs：視訊 videoStartUs + round(k·1e6·den/num)、音訊 startUs + round(srcIn·1e6/sr)（x.5 往 +∞，含負值）", () => {
    for (const v of CASES.absUs.video) expect(videoAbsUs(v.k, v.fps, v.videoStartUs), JSON.stringify(v)).toBe(v.us);
    for (const a of CASES.absUs.audio) expect(audioAbsUs(a.srcIn, a), JSON.stringify(a)).toBe(a.us);
  });

  it("isUntouched（-c:a copy 閘門）：比的是值不是 null；幀數未知的媒體保守地不 copy", () => {
    const frames = (id: string) => CASES.untouched.media[id]?.frames;
    for (const u of CASES.untouched.cases) expect(isUntouched(u.sequence, frames), u.name).toBe(u.expect);
  });
});

describe("整數工具", () => {
  it("floorDiv 在浮點商剛好差一點點到整數時仍然正確（負數也對）", () => {
    // 108000000 幀 × 48000 × 1001 ≈ 5.2e15：浮點除法會進位，校正後才是真正的 floor
    expect(floorDiv(108000000 * 48000 * 1001, 30000)).toBe(172972800000);
    expect(floorDiv(-7, 2)).toBe(-4);
    expect(floorDiv(7, 2)).toBe(3);
    const big = 2 ** 52 - 1;
    expect(floorDiv(big, 3)).toBe(Math.floor(big / 3));
  });

  it("t 超出 [0, T) 對不到任何項目", () => {
    const seq = CASES.cases[0].sequence;
    expect(mapFrame(seq, -1).item).toBeNull();
    expect(mapFrame(seq, durationFrames(seq)).item).toBeNull();
  });
});
