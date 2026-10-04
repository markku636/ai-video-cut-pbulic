// 序列空間版面（M2.9 驗收：版面快照、29.97 時音訊片段 x 誤差 < 0.5 px）與播放線 / 隱含序列的對應。
import { describe, expect, it } from "vitest";
import { samplesOfFrame } from "../sequence/map";
import { aclip, FPS2997, FPS30, gap, lane, seqOf, vclip } from "../sequence/testkit";
import { xOfFrame } from "../store/timeline";
import { ROW } from "./draw";
import {
  DEFAULT_LANE_HEIGHT,
  frameOfSampleExact,
  layoutSequenceRows,
  nextLaneHeight,
  normalizeLaneHeight,
  sampleOfX,
  SEQ_ROW,
  sequencePlayhead,
  usedSourceRanges,
  viewSequenceOf,
  xOfSample,
} from "./layoutSequence";

describe("frametimeline/layoutSequence：版面", () => {
  it("由上而下：尺規 → 範圍列 → V1 → A0 → 追蹤群組 → A1…An → 放置區（快照）", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 100)], [lane("A1", "music", []), lane("A2", "voiceover", [])]);
    const L = layoutSequenceRows(seq, [
      { id: "t1", mediaId: "m1" },
      { id: "t2", mediaId: "m1" },
    ], { A2: 72 });
    // 數字寫死：列高改了就一定要有人看過這張表（標頭 DOM 與 canvas 靠同一份數字對齊）
    expect(L).toEqual({
      rulerY: 0,
      rulerH: 22,
      rangeY: 22,
      rangeH: 10,
      v1Y: 32,
      v1H: 44,
      a0Y: 78,
      a0H: 36,
      tracksHeaderY: 116,
      tracksHeaderH: 16,
      tracksCollapsed: false,
      rows: [
        { trackId: "t1", mediaId: "m1", y: 134, h: 28, solvedY: 134, solvedH: 8, userY: 142, userH: 20 },
        { trackId: "t2", mediaId: "m1", y: 164, h: 28, solvedY: 164, solvedH: 8, userY: 172, userH: 20 },
      ],
      lanes: [
        { laneId: "A1", y: 194, h: 40 },
        { laneId: "A2", y: 236, h: 72 },
      ],
      dropY: 310,
      dropH: 24,
      height: 334,
    });
    // 尺規與範圍列跟素材空間同高：切空間時尺規不會跳
    expect(L.rulerH).toBe(ROW.ruler);
    expect(L.rangeH).toBe(ROW.range);
    expect(L.v1H).toBe(ROW.thumbs);
  });

  it("追蹤群組摺疊：track 不佔高度、標頭還在；沒有 track 時整組（含標頭）消失", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 100)], [lane("A1", "music", [])]);
    const folded = layoutSequenceRows(seq, [{ id: "t1", mediaId: "m1" }], {}, { tracksCollapsed: true });
    expect(folded.rows).toEqual([]);
    expect(folded.tracksHeaderH).toBe(SEQ_ROW.tracksHeader);
    expect(folded.lanes[0].y).toBe(folded.tracksHeaderY + SEQ_ROW.tracksHeader + SEQ_ROW.gap);
    const none = layoutSequenceRows(seq, []);
    expect(none.tracksHeaderH).toBe(0);
    expect(none.lanes[0].y).toBe(none.a0Y + SEQ_ROW.a0 + SEQ_ROW.gap);
    // 隱含序列之前（seq = null）也排得出來：沒有音軌
    expect(layoutSequenceRows(null, []).lanes).toEqual([]);
  });

  it("音軌高度只有 16 / 40 / 72 三檔：壞值退回預設、其他值取最近、切換鈕循環", () => {
    expect(normalizeLaneHeight(undefined)).toBe(DEFAULT_LANE_HEIGHT);
    expect(normalizeLaneHeight(Number.NaN)).toBe(40);
    expect(normalizeLaneHeight(20)).toBe(16);
    expect(normalizeLaneHeight(60)).toBe(72);
    expect([16, 40, 72].map(nextLaneHeight)).toEqual([40, 72, 16]);
  });
});

describe("frametimeline/layoutSequence：樣本 ↔ x", () => {
  it("29.97 fps：音訊片段的 x 用小數幀算，跟精確有理數的誤差 < 0.5 px（放大到 64 px/幀、1 小時處）", () => {
    const view = { scrollFrame: 107_000, pxPerFrame: 64 };
    for (const s of [samplesOfFrame(107_892, FPS2997) + 800, 172_799_999, 172_800_000 + 1601]) {
      // 精確值：t = s · 30000 / (48000 · 1001) 用 BigInt 算出整數部分與餘數，再換成 x
      const num = BigInt(s) * 30000n;
      const den = 48000n * 1001n;
      const whole = Number(num / den);
      const frac = Number(num % den) / Number(den);
      const exact = (whole - view.scrollFrame + frac) * view.pxPerFrame;
      expect(Math.abs(xOfSample(s, FPS2997, view) - exact)).toBeLessThan(0.5);
    }
  });

  it("29.97 fps：從 V1 分離出來的音訊片段（start = S(t0)）畫在 V1 片段邊緣的 0.5 px 內（每一幀都成立）", () => {
    const view = { scrollFrame: 0, pxPerFrame: 64 };
    let worst = 0;
    for (let t = 0; t < 5000; t++) worst = Math.max(worst, Math.abs(xOfSample(samplesOfFrame(t, FPS2997), FPS2997, view) - xOfFrame(t, 0, 64)));
    expect(worst).toBeLessThan(0.5);
    // 反過來 floor 成整數幀的畫法（錯的）會差到將近一整格：這條測試擋的就是它
    expect(frameOfSampleExact(1601, FPS2997)).toBeLessThan(1);
    expect(Math.abs(sampleOfX(xOfSample(123_456, FPS2997, view), FPS2997, view) - 123_456)).toBeLessThan(1e-6);
  });
});

describe("frametimeline/layoutSequence：隱含序列、播放線、已用範圍", () => {
  const active = { id: "m1", name: "sample_clip1.webm", proxy: { fps: FPS30, frames: 1797, width: 1280, height: 720, scale: 1 }, probe: null };

  it("隱含序列畫成作用中媒體整段一個片段（跟 materialize 同 id）；proxy 沒好就沒有東西可畫", () => {
    const v = viewSequenceOf(null, active)!;
    expect(v.video).toHaveLength(1);
    expect(v.video[0]).toMatchObject({ kind: "clip", id: "clip-1", mediaId: "m1", srcIn: 0, srcOut: 1797, enabled: true });
    expect(v.name).toBe("sample_clip1");
    expect(viewSequenceOf(null, { ...active, proxy: null })).toBeNull();
    expect(viewSequenceOf(null, null)).toBeNull();
    const real = seqOf([vclip("c1", "m1", 0, 10)]);
    expect(viewSequenceOf(real, active)).toBe(real);
  });

  it("播放線：seqFrame 跟 (媒體, k) 對得上就用它（同一來源幀用兩次時分得出是哪一次），否則第一次出現的位置", () => {
    // [0,100) = m1 k 0..99；[100,110) 空白；[110,210) = m1 k 50..149（k 50..99 出現兩次）
    const seq = seqOf([vclip("a", "m1", 0, 100), gap("g", 10), vclip("b", "m1", 50, 150)]);
    expect(sequencePlayhead(seq, "m1", 60)).toBe(60);
    expect(sequencePlayhead(seq, "m1", 60, 120)).toBe(120);
    expect(sequencePlayhead(seq, "m1", 60, 30)).toBe(60); // seqFrame 對到 k 30，跟 k 60 對不上 → 退回第一次出現
    expect(sequencePlayhead(seq, "m1", 140)).toBe(200);
    // k 沒用在序列裡：有 seqFrame 就留著它（空白上），沒有就不畫
    expect(sequencePlayhead(seq, "m1", 1000, 105)).toBe(105);
    expect(sequencePlayhead(seq, "m1", 1000)).toBeNull();
    expect(sequencePlayhead(seq, "other", 10)).toBeNull();
  });

  it("已用於序列的 k 範圍：排序、合併重疊與相鄰、只算這支媒體", () => {
    const seq = seqOf([vclip("a", "m1", 300, 400), vclip("b", "m2", 0, 50), vclip("c", "m1", 0, 100), vclip("d", "m1", 90, 120, { enabled: false }), vclip("e", "m1", 120, 130)]);
    expect(usedSourceRanges(seq, "m1")).toEqual([
      [0, 130],
      [300, 400],
    ]);
    expect(usedSourceRanges(seq, "m2")).toEqual([[0, 50]]);
    expect(usedSourceRanges(seqOf([gap("g", 5)], [lane("A1", "music", [aclip("x", "a-music", 0, 10)])]), "m1")).toEqual([]);
  });
});
