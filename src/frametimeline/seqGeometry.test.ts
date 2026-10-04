// 序列時間軸幾何（M2.9 驗收：片段 x 座標、追蹤分段平移；增益包絡、把手與波形取樣位置）。
import { describe, expect, it } from "vitest";
import { PEAKS_PPS } from "../audio/peaks";
import type { ClipGainV2 } from "../project/format";
import { placeVideo, samplesOfFrame } from "../sequence/map";
import { aclip, FPS2997, FPS30, gap, seqOf, vclip } from "../sequence/testkit";
import type { SolveFrame } from "../store/solves";
import { IDENTITY_H } from "../video/quad";
import {
  audioBucketAt,
  audioClipSpan,
  badgeCount,
  bucketsPerPixel,
  clipGainFactor,
  clipThumbSlots,
  envelopePointsXY,
  fadeHandleRects,
  fadeShape,
  FADE_HANDLE_PX,
  GAIN_LINE_MIN_DB,
  gainDbToY,
  gainLinePoints,
  gainYToDb,
  mapSourceFrame,
  mapSourceSpan,
  polylineYAt,
  sequenceSolvedRuns,
  v1BucketAt,
  visibleItemSpans,
  type GainGeom,
} from "./seqGeometry";

const g = (over: Partial<ClipGainV2> = {}): ClipGainV2 => ({ gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [], ...over });
const sf = (k: number, conf: number, state: 0 | 1 | 2 | 3 = 1): SolveFrame => ({ k, h: IDENTITY_H, conf, state });

describe("frametimeline/seqGeometry：片段位置", () => {
  // 倒序兩片段＋空白：[0,300) = m1 k 930..1229、[300,310) 空白、[310,610) = m1 k 60..359
  const seq = seqOf([vclip("c2", "m1", 930, 1230), gap("g", 10), vclip("c1", "m1", 60, 360)]);
  const placed = placeVideo(seq);

  it("V1 片段的 x = xOfFrame(t0) / xOfFrame(t1)；可視範圍外的不回", () => {
    expect(visibleItemSpans(placed, { scrollFrame: 0, pxPerFrame: 2 }, 2000).map((s) => [s.item.id, s.x0, s.x1])).toEqual([
      ["c2", 0, 600],
      ["g", 600, 620],
      ["c1", 620, 1220],
    ]);
    // 捲到 305、寬 100 px → 可視幀 305..355：空白露出 5 幀、c1 露出前 45 幀；c2 右緣剛好在 x<0 之外
    expect(visibleItemSpans(placed, { scrollFrame: 305, pxPerFrame: 2 }, 100).map((s) => [s.item.id, s.x0, s.x1])).toEqual([
      ["g", -10, 10],
      ["c1", 10, 610],
    ]);
    // 右緣剛好貼在 x=0（0 px 寬）不算
    expect(visibleItemSpans(placed, { scrollFrame: 300, pxPerFrame: 2 }, 100).map((s) => s.item.id)).toEqual(["g", "c1"]);
  });

  it("縮圖從片段入點對齊、依片段的 k 取；捲動時跳過左邊看不到的", () => {
    // thumbW 78、px 2 → step 39 幀；c1 從 t=310 開始：第一張 k = 60（入點畫面）
    const slots = clipThumbSlots({ t0: 310, t1: 610 }, 60, { scrollFrame: 0, pxPerFrame: 2 }, 1300, 78);
    expect(slots[0]).toEqual({ t: 310, k: 60, x: 620 });
    expect(slots[1]).toEqual({ t: 349, k: 99, x: 698 });
    expect(slots.every((s) => (s.t - 310) % 39 === 0 && s.k === 60 + (s.t - 310))).toBe(true);
    // 捲到 500：t=466（x=-68，右緣 10 px 還看得到）要留、t=427 整張在左邊外面不取
    const scrolled = clipThumbSlots({ t0: 310, t1: 610 }, 60, { scrollFrame: 500, pxPerFrame: 2 }, 400, 78);
    expect(scrolled[0].t).toBe(466);
    expect(scrolled.map((s) => s.t)).toEqual([466, 505, 544, 583]);
    expect(clipThumbSlots({ t0: 0, t1: 10 }, 0, { scrollFrame: 0, pxPerFrame: 0 }, 400, 78)).toEqual([]);
  });

  it("音訊片段 x 用小數幀（29.97 fps 一幀 1601.6 樣本）", () => {
    const view = { scrollFrame: 0, pxPerFrame: 10 };
    expect(audioClipSpan(aclip("a", "x", 1601, 1601.6 * 10 - 1601), FPS2997, view).x0).toBeCloseTo(9.996, 3);
    expect(audioClipSpan(aclip("a", "x", 48000, 48000), FPS30, view)).toEqual({ x0: 300, x1: 600 });
  });
});

describe("frametimeline/seqGeometry：追蹤車道分段（k 平移 t0 − srcIn 後裁在 [t0, t1)）", () => {
  const seq = seqOf([vclip("c2", "m1", 930, 1230), gap("g", 10), vclip("c1", "m1", 60, 360), vclip("x", "m2", 0, 100)]);
  const placed = placeVideo(seq);

  it("來源範圍 → 每個用到它的片段各一段；別支媒體的片段不算", () => {
    expect(mapSourceSpan(placed, "m1", 0, 1797)).toEqual([
      { t0: 0, t1: 300, index: 0 },
      { t0: 310, t1: 610, index: 2 },
    ]);
    // 鏡頭 [1000, 1100) 只落在 c2：t = 1000 − 930 = 70 起
    expect(mapSourceSpan(placed, "m1", 1000, 1100)).toEqual([{ t0: 70, t1: 170, index: 0 }]);
    expect(mapSourceSpan(placed, "m1", 400, 900)).toEqual([]);
    expect(mapSourceFrame(placed, "m1", 100)).toEqual([350]);
    expect(mapSourceFrame(placed, "m1", 1229)).toEqual([299]);
    expect(mapSourceFrame(placed, "m1", 1230)).toEqual([]);
    expect(mapSourceFrame(placed, "m2", 0)).toEqual([610]);
  });

  it("信心帶平移到片段位置、在片段邊界切開、只掃可視範圍", () => {
    const frames = [sf(58, 0.9), sf(59, 0.9), sf(60, 0.9), sf(61, 0.9), sf(62, 0.2), sf(1228, 0.5), sf(1229, 0.5), sf(1230, 0.5)];
    const runs = sequenceSolvedRuns(frames, placed, "m1", { scrollFrame: 0, pxPerFrame: 1 }, 1000);
    expect(runs).toEqual([
      // c2（k 930..1229）只含 1228、1229 → t 298..299
      { x0: 298, x1: 300, band: "warn" },
      // c1（k 60..359）含 60、61（good）與 62（bad）→ t 310.. ；k 58、59 不在片段內，不畫
      { x0: 310, x1: 312, band: "good" },
      { x0: 312, x1: 313, band: "bad" },
    ]);
    // 同一段來源連續用兩次：兩個片段各畫一段，中間不會連成一條
    const twice = placeVideo(seqOf([vclip("a", "m1", 0, 10), vclip("b", "m1", 0, 10)]));
    const all = Array.from({ length: 10 }, (_, k) => sf(k, 0.9));
    expect(sequenceSolvedRuns(all, twice, "m1", { scrollFrame: 0, pxPerFrame: 2 }, 100)).toEqual([
      { x0: 0, x1: 20, band: "good" },
      { x0: 20, x1: 40, band: "good" },
    ]);
    // 捲到 t=305、寬 20 px：c2 不在畫面，c1 的 k 60..62 在 x 5..8
    expect(sequenceSolvedRuns(frames, placed, "m1", { scrollFrame: 305, pxPerFrame: 1 }, 20)).toEqual([
      { x0: 5, x1: 7, band: "good" },
      { x0: 7, x1: 8, band: "bad" },
    ]);
    expect(sequenceSolvedRuns([], placed, "m1", { scrollFrame: 0, pxPerFrame: 1 }, 100)).toEqual([]);
  });

  it("徽章：片段來源範圍內、有替換目標的 track 數", () => {
    const tracks = [
      { mediaId: "m1", range: [0, 100] as [number, number], hasTarget: true },
      { mediaId: "m1", range: [300, 360] as [number, number], hasTarget: true },
      { mediaId: "m1", range: [50, 70] as [number, number], hasTarget: false },
      { mediaId: "m2", range: [0, 100] as [number, number], hasTarget: true },
      { mediaId: "m1", range: [360, 400] as [number, number], hasTarget: true },
    ];
    expect(badgeCount({ mediaId: "m1", srcIn: 60, srcOut: 360 }, tracks)).toBe(2);
    expect(badgeCount({ mediaId: "m1", srcIn: 930, srcOut: 1230 }, tracks)).toBe(0);
    expect(badgeCount({ mediaId: "m2", srcIn: 0, srcOut: 1 }, tracks)).toBe(1);
  });
});

describe("frametimeline/seqGeometry：增益包絡", () => {
  it("音量線 dB ↔ y 互逆、+12 在頂、−48 以下貼底", () => {
    expect(gainDbToY(12, 100, 36)).toBe(103);
    expect(gainDbToY(GAIN_LINE_MIN_DB, 100, 36)).toBe(133);
    expect(gainDbToY(-96, 100, 36)).toBe(133);
    for (const db of [-40, -12, -3, 0, 6]) expect(gainYToDb(gainDbToY(db, 20, 40), 20, 40)).toBeCloseTo(db, 9);
    // 0 dB 在上方 1/5 處：往上推 +12 還有空間，往下的行程留給常用的閃避
    expect(gainDbToY(0, 0, 36)).toBe(9);
  });

  it("淡化形狀：linear = 線性、equalPower = 四分之一正弦", () => {
    expect(fadeShape(0.5, "linear")).toBe(0.5);
    expect(fadeShape(0.5, "equalPower")).toBeCloseTo(Math.SQRT1_2, 12);
    expect(fadeShape(-1, "equalPower")).toBe(0);
    expect(fadeShape(2, "linear")).toBe(1);
  });

  it("振幅倍率 = 增益 × 自動化（dB 域內插）× 淡入淡出；≤ −90 dB 視為靜音；bus 推桿疊加", () => {
    expect(clipGainFactor(g(), 100, 1000)).toBe(1);
    expect(clipGainFactor(g({ gainDb: -6 }), 100, 1000)).toBeCloseTo(10 ** (-6 / 20), 12);
    expect(clipGainFactor(g({ gainDb: -6 }), 100, 1000, -6)).toBeCloseTo(10 ** (-12 / 20), 12);
    const duck = g({ envelope: [{ at: 100, db: 0 }, { at: 200, db: -20 }] });
    expect(clipGainFactor(duck, 150, 1000)).toBeCloseTo(0.1 ** 0.5, 12); // −10 dB
    expect(clipGainFactor(duck, 900, 1000)).toBeCloseTo(0.1, 12); // hold 最後一點
    expect(clipGainFactor(g({ envelope: [{ at: 0, db: -96 }] }), 10, 100)).toBe(0);
    const fades = g({ fadeIn: 100, fadeOut: 200, fadeCurve: "linear" });
    expect(clipGainFactor(fades, 25, 1000)).toBeCloseTo(0.25, 12);
    expect(clipGainFactor(fades, 900, 1000)).toBeCloseTo(0.5, 12);
    expect(clipGainFactor(fades, 500, 1000)).toBe(1);
  });

  it("音量線折線：頭、片段內的點、尾；x 用序列樣本換小數幀；折線內插", () => {
    const geom: GainGeom = { gain: g({ gainDb: -6, envelope: [{ at: 48000, db: 0 }, { at: 96000, db: -12 }] }), startSample: 48000, length: 192000, fps: FPS30, view: { scrollFrame: 0, pxPerFrame: 1 }, top: 0, h: 66 };
    const pts = gainLinePoints(geom);
    expect(pts.map((p) => p.x)).toEqual([30, 60, 90, 150]);
    expect(pts.map((p) => gainYToDb(p.y, 0, 66))).toEqual([-6, -6, -18, -18].map((d) => expect.closeTo(d, 9)));
    expect(envelopePointsXY(geom).map((p) => p.x)).toEqual([60, 90]);
    expect(gainYToDb(polylineYAt(pts, 75), 0, 66)).toBeCloseTo(-12, 9);
    expect(polylineYAt(pts, 0)).toBe(pts[0].y);
    expect(polylineYAt(pts, 1e6)).toBe(pts[3].y);
    // 沒有自動化：水平線
    const flat = gainLinePoints({ ...geom, gain: g({ gainDb: 3 }) });
    expect(flat).toHaveLength(2);
    expect(flat[0].y).toBe(flat[1].y);
  });

  it("淡化把手：在淡化終點、夾在片段內側、8×8", () => {
    const r = fadeHandleRects(100, 300, 50, 100, 300);
    expect(r.fadeIn).toEqual({ x: 100, y: 50, w: FADE_HANDLE_PX, h: FADE_HANDLE_PX });
    expect(r.fadeOut).toEqual({ x: 292, y: 50, w: 8, h: 8 });
    const long = fadeHandleRects(100, 300, 50, 160, 240);
    expect(long.fadeIn.x).toBe(156);
    expect(long.fadeOut.x).toBe(236);
  });
});

describe("frametimeline/seqGeometry：波形取樣位置", () => {
  it("每像素桶數與片段起點的桶（V1 原音從 videoStartUs 起算、音訊片段從 startUs + srcIn 起算）", () => {
    // 30 fps、1 px/幀：一像素 = 33.3 ms = 6.67 桶
    expect(bucketsPerPixel(FPS30, 1)).toBeCloseTo(PEAKS_PPS / 30, 12);
    expect(bucketsPerPixel(FPS30, 0)).toBe(0);
    // 片段 t0 = 310、srcIn = 60：序列幀 310 = 來源 2.000 s = 桶 400；videoStartUs 6500 µs 多 1.3 桶
    expect(v1BucketAt(310, { t0: 310 }, 60, FPS30, 0)).toBeCloseTo(400, 9);
    expect(v1BucketAt(311.5, { t0: 310 }, 60, FPS30, 6500)).toBeCloseTo(400 + 10 + 1.3, 9);
    // 音樂：44.1 kHz、startUs 25057、srcIn 88200（2 s）、放在序列 1 s → 序列 1.5 s 是容器 2.525057 s
    const c = aclip("m", "a-music", 48000, 960000, { srcIn: 88200 });
    expect(audioBucketAt(72000, c, { startUs: 25057, sampleRate: 44100 })).toBeCloseTo(2.525057 * PEAKS_PPS, 6);
    // 29.97：S(t0) 起點的桶跟 V1 原音的桶一致（分離前後波形不跳）
    const t0 = 1234;
    const S0 = samplesOfFrame(t0, FPS2997);
    const detached = aclip("d", "x", S0, 1000, { srcIn: Math.round((t0 * 1001 * 48000) / 30000) });
    expect(Math.abs(audioBucketAt(S0, detached, { startUs: 0, sampleRate: 48000 }) - v1BucketAt(t0, { t0 }, t0, FPS2997, 0))).toBeLessThan(0.01);
  });
});
