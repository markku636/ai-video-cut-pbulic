import { describe, expect, it } from "vitest";
import type { GainPointV2 } from "../project/format";
import { envelopeDbAt, fitGain, joinEnvelopes, simplifyEnvelope, sliceEnvelope, splitGain } from "./envelope";

const P = (at: number, db: number): GainPointV2 => ({ at, db });

describe("envelopeDbAt（同 ai-music-cut envelopeDb：dB 域線性內插、兩端 hold）", () => {
  it("空曲線 0 dB；第一點前 / 最後一點後維持端點值；中間線性內插", () => {
    const env = [P(100, -10), P(300, -20)];
    expect(envelopeDbAt([], 50)).toBe(0);
    expect(envelopeDbAt(env, 0)).toBe(-10);
    expect(envelopeDbAt(env, 1e9)).toBe(-20);
    expect(envelopeDbAt(env, 200)).toBe(-15);
  });

  it("階梯（同一個 at 兩點）：左側取先出現的、右側取後出現的", () => {
    const env = [P(0, 0), P(100, 0), P(100, -96), P(200, -96)];
    expect(envelopeDbAt(env, 100, "left")).toBe(0);
    expect(envelopeDbAt(env, 100, "right")).toBe(-96);
    expect(envelopeDbAt(env, 99)).toBe(0);
    expect(envelopeDbAt(env, 101)).toBe(-96);
  });
});

describe("slice / join / simplify", () => {
  const env = [P(420000, 0), P(432000, -10), P(624000, -10), P(636000, 0)];

  it("切開再接回，取樣值不變且點回到原樣（切點補的內插點消失）", () => {
    for (const cut of [1, 425000, 432000, 500000, 630000, 959999]) {
      const left = sliceEnvelope(env, 0, cut);
      const right = sliceEnvelope(env, cut, 960000);
      for (let x = 0; x <= 960000; x += 1237) {
        const v = x < cut ? envelopeDbAt(left, x) : envelopeDbAt(right, x - cut);
        expect(Math.abs(v - envelopeDbAt(env, x)), `cut ${cut} x ${x}`).toBeLessThan(0.01);
      }
      expect(joinEnvelopes(left, cut, right, 960000 - cut), `cut ${cut}`).toEqual(env);
    }
  });

  it("空曲線切出來、接回去都還是空的；一邊空一邊有曲線時，空的那段維持 0 dB", () => {
    expect(sliceEnvelope([], 10, 20)).toEqual([]);
    expect(joinEnvelopes([], 100, [], 50)).toEqual([]);
    const joined = joinEnvelopes([], 100, [P(0, -6)], 50);
    expect(envelopeDbAt(joined, 50)).toBe(0);
    expect(envelopeDbAt(joined, 100, "right")).toBe(-6);
    expect(envelopeDbAt(joined, 140)).toBe(-6);
  });

  it("simplify：共線點、重複點、跟鄰點同值的端點拿掉；全部是 0 dB 時回空陣列；階梯保留", () => {
    expect(simplifyEnvelope([P(0, 0), P(50, -5), P(100, -10)])).toEqual([P(0, 0), P(100, -10)]);
    expect(simplifyEnvelope([P(0, -3), P(10, -3), P(20, -6)])).toEqual([P(10, -3), P(20, -6)]);
    expect(simplifyEnvelope([P(0, 0), P(100, 0)])).toEqual([]);
    expect(simplifyEnvelope([P(0, -3), P(100, -3)])).toEqual([P(100, -3)]);
    expect(simplifyEnvelope([P(0, 0), P(100, 0), P(100, -96), P(200, 0)])).toEqual([P(100, 0), P(100, -96), P(200, 0)]);
  });
});

describe("fitGain / splitGain", () => {
  const g = { gainDb: -3, fadeIn: 600, fadeOut: 600, fadeCurve: "linear" as const, envelope: [P(0, 0), P(1000, -10)] };

  it("fitGain：長度夠就回傳同一個物件；超長等比縮（floor）、曲線裁在 length 並補內插點", () => {
    expect(fitGain(g, 2000)).toBe(g);
    const f = fitGain(g, 1000);
    expect([f.fadeIn, f.fadeOut]).toEqual([500, 500]);
    expect(f.envelope).toBe(g.envelope);
    const short = fitGain(g, 500);
    expect(short.fadeIn + short.fadeOut).toBeLessThanOrEqual(500);
    expect(short.envelope).toEqual([P(0, 0), P(500, -5)]);
  });

  it("splitGain：淡入留前段、淡出留後段，各自夾在長度內；增益兩段相同", () => {
    const [l, r] = splitGain(g, 400, 1600);
    expect([l.fadeIn, l.fadeOut, r.fadeIn, r.fadeOut]).toEqual([400, 0, 0, 600]);
    expect([l.gainDb, r.gainDb]).toEqual([-3, -3]);
    expect(envelopeDbAt(l.envelope, 400)).toBeCloseTo(-4, 9);
    expect(envelopeDbAt(r.envelope, 0)).toBeCloseTo(-4, 9);
  });
});
