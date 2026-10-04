// 靜音偵測：門檻換算、區段聚合、padding 與幀轉換、投影到序列時間。
import { describe, expect, it } from "vitest";
import { DEFAULT_SILENCE, dbToU8, findSilentRanges, mergeRanges, projectToSequence, rmsDb, silentBucketRuns, silentRangesOfSequence, subtractRanges, syncLockedBusy } from "./silence";
import { aclip, lane, seqOf, vclip } from "./testkit";

const FPS30 = { num: 30, den: 1 };
/** 前 n 桶靜音、後 m 桶有聲。 */
const buckets = (parts: [quiet: boolean, n: number][]) => {
  const out: number[] = [];
  for (const [quiet, n] of parts) for (let i = 0; i < n; i++) out.push(quiet ? 0 : 255);
  return out;
};

describe("dB 換算", () => {
  it("rmsU8 0..255 對上 −60..0 dBFS，dbToU8 是它的反函式（夾在範圍內）", () => {
    expect(rmsDb(0)).toBe(-60);
    expect(rmsDb(255)).toBe(0);
    expect(Math.round(rmsDb(dbToU8(-40)))).toBe(-40);
    expect(dbToU8(-999)).toBe(0);
    expect(dbToU8(99)).toBe(255);
  });
});

describe("silentBucketRuns", () => {
  it("連續低於門檻的桶聚成半開區間，開頭與結尾的區段都收得到", () => {
    expect(silentBucketRuns(buckets([[true, 3], [false, 2], [true, 4]]), -40)).toEqual([
      { a: 0, b: 3 },
      { a: 5, b: 9 },
    ]);
    expect(silentBucketRuns(buckets([[false, 5]]), -40)).toEqual([]);
    expect(silentBucketRuns([], -40)).toEqual([]);
  });
});

describe("findSilentRanges", () => {
  it("長度不足的靜音整段跳過（句間停頓是節奏，不是贅餘）", () => {
    // 60 桶 = 300 ms < 預設的 500 ms
    expect(findSilentRanges({ pps: 200, rmsU8: buckets([[true, 60], [false, 200]]) }, FPS30)).toEqual([]);
  });

  it("夠長的靜音頭尾各留 padMs 再換成幀", () => {
    // 200 桶靜音 = 1 s；pad 100 ms = 20 桶 → [20, 180) 桶 → ×0.15 幀/桶 → [3, 27)
    expect(findSilentRanges({ pps: 200, rmsU8: buckets([[true, 200], [false, 200]]) }, FPS30)).toEqual([{ in: 3, out: 27 }]);
  });

  it("padding 比靜音本身還長就跳過 —— 那段沒有多餘的空白可以拿掉", () => {
    const opts = { ...DEFAULT_SILENCE, minSilenceMs: 100, padMs: 500 };
    expect(findSilentRanges({ pps: 200, rmsU8: buckets([[true, 40], [false, 40]]) }, FPS30, opts)).toEqual([]);
  });

  it("沒有波形就回空的，不要猜", () => {
    expect(findSilentRanges({ pps: 200, rmsU8: [] }, FPS30)).toEqual([]);
    expect(findSilentRanges({ pps: 0, rmsU8: buckets([[true, 999]]) }, FPS30)).toEqual([]);
  });
});

describe("silentRangesOfSequence（整個序列，不只作用中那一支）", () => {
  const quietThenLoud = { pps: 200, rmsU8: buckets([[true, 200], [false, 200]]) };
  const two = () => seqOf([vclip("a", "m1", 0, 100), vclip("b", "m2", 0, 100)]);

  it("每支用到的媒體各自找一次再投影合併 —— 只看作用中那一支會漏掉別支的靜音", () => {
    const r = silentRangesOfSequence(two(), () => quietThenLoud);
    expect(r.ranges).toEqual([
      { in: 3, out: 27 }, // m1 在 clip a（t0 = 0）
      { in: 103, out: 127 }, // m2 在 clip b（t0 = 100）
    ]);
    expect(r.missing).toEqual([]);
  });

  it("拿不到波形的媒體跳過並回報是哪幾支（還沒算完就不要亂猜，也不要安靜地少剪）", () => {
    const r = silentRangesOfSequence(two(), (id) => (id === "m1" ? quietThenLoud : null));
    expect(r.ranges).toEqual([{ in: 3, out: 27 }]);
    expect(r.missing).toEqual(["m2"]);
  });

  it("同一支媒體用了兩次只算一次波形；沒有片段就沒有範圍", () => {
    let calls = 0;
    const seq = seqOf([vclip("a", "m1", 0, 100), vclip("b", "m1", 100, 200)]);
    silentRangesOfSequence(seq, () => {
      calls++;
      return quietThenLoud;
    });
    expect(calls).toBe(1);
    expect(silentRangesOfSequence(seqOf([]), () => quietThenLoud).ranges).toEqual([]);
  });
});

describe("同步鎖軌的保護", () => {
  it("subtractRanges：中間被擋就切成兩段，整段被擋就消失，沒有 block 就原樣", () => {
    expect(subtractRanges([{ in: 0, out: 100 }], [{ in: 40, out: 60 }])).toEqual([
      { in: 0, out: 40 },
      { in: 60, out: 100 },
    ]);
    expect(subtractRanges([{ in: 0, out: 100 }], [{ in: 0, out: 100 }])).toEqual([]);
    expect(subtractRanges([{ in: 0, out: 10 }], [])).toEqual([{ in: 0, out: 10 }]);
    expect(subtractRanges([{ in: 0, out: 10 }], [{ in: 20, out: 30 }])).toEqual([{ in: 0, out: 10 }]);
  });

  it("syncLockedBusy：同步鎖軌的片段算，音樂軌（syncLock 關）不算，停用的不算", () => {
    // 30 fps / 48 kHz → 1600 樣本 = 1 幀
    const seq = seqOf(
      [vclip("a", "m1", 0, 100)],
      [
        lane("vo", "voiceover", [aclip("x", "a-vo", 8000, 8000)]),
        lane("music", "music", [aclip("m", "a-music", 0, 96000)]),
        lane("sfx", "other", [aclip("d", "a-sfx", 48000, 1600, { enabled: false })]),
      ],
    );
    expect(syncLockedBusy(seq)).toEqual([{ in: 5, out: 10 }]);
  });

  it("旁白壓在安靜的畫面上時，那一段不會被當成靜音剪掉（剪了等於把旁白從中間切斷）", () => {
    const quietThenLoud = { pps: 200, rmsU8: buckets([[true, 200], [false, 200]]) };
    const bare = seqOf([vclip("a", "m1", 0, 100)]);
    expect(silentRangesOfSequence(bare, () => quietThenLoud).ranges).toEqual([{ in: 3, out: 27 }]);

    const withVo = seqOf([vclip("a", "m1", 0, 100)], [lane("vo", "voiceover", [aclip("x", "a-vo", 8000, 8000)])]);
    expect(silentRangesOfSequence(withVo, () => quietThenLoud).ranges).toEqual([
      { in: 3, out: 5 },
      { in: 10, out: 27 },
    ]);
  });
});

describe("mergeRanges", () => {
  it("排序後把重疊與相接的併起來", () => {
    expect(mergeRanges([{ in: 30, out: 40 }, { in: 0, out: 10 }, { in: 10, out: 20 }])).toEqual([
      { in: 0, out: 20 },
      { in: 30, out: 40 },
    ]);
  });
});

describe("projectToSequence", () => {
  const seq = () => seqOf([vclip("c1", "m1", 0, 100), vclip("c2", "m1", 200, 300)]);

  it("逐片段取交集：剪掉沒被用到的來源，並換算成序列時間", () => {
    expect(
      projectToSequence(seq(), "m1", [
        { in: 50, out: 80 }, // 落在 c1
        { in: 150, out: 180 }, // 這段來源根本沒被用到
        { in: 250, out: 260 }, // 落在 c2：t0 100 + (250−200)
      ]),
    ).toEqual([
      { in: 50, out: 80 },
      { in: 150, out: 160 },
    ]);
  });

  it("別支媒體的片段不算；重疊的結果合併成一段", () => {
    expect(projectToSequence(seq(), "m2", [{ in: 0, out: 100 }])).toEqual([]);
    expect(
      projectToSequence(seq(), "m1", [
        { in: 10, out: 50 },
        { in: 40, out: 70 },
      ]),
    ).toEqual([{ in: 10, out: 70 }]);
  });

  it("一段來源被剪成兩個片段散在序列各處，兩處都要收到", () => {
    const split = seqOf([vclip("a", "m1", 0, 50), vclip("b", "m2", 0, 600), vclip("c", "m1", 50, 100)]);
    expect(projectToSequence(split, "m1", [{ in: 40, out: 60 }])).toEqual([
      { in: 40, out: 50 },
      { in: 650, out: 660 },
    ]);
  });
});
