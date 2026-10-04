import { describe, expect, it } from "vitest";
import indexJson from "../../fixtures/sample/cache/index.v1.json";
import probeJson from "../../fixtures/sample/cache/probe.v1.json";
import proxyJson from "../../fixtures/sample/cache/proxy.v1.json";
import shotsJson from "../../fixtures/sample/cache/shots.v1.json";
import { parseEngineProbe, parseProxyInfo, parseShotsInfo, summarizeCfr, summarizeIndex } from "./mediaCache";

/** 引擎 `CfrMap.to_list()` + `duplicate_count` + `dropped_sources()` 的逐幀版本：拿來對照「只看 run 交界」的快算法。 */
function bruteForceCfr(runs: number[][], nSource: number) {
  const map: number[] = [];
  for (const [, s0, c] of runs) for (let i = 0; i < c; i++) map.push(s0 + i);
  const seen = new Set(map);
  let dup = 0;
  for (let k = 1; k < map.length; k++) if (map[k] === map[k - 1]) dup++;
  let dropped = 0;
  for (let s = 0; s < nSource; s++) if (!seen.has(s)) dropped++;
  return { duplicates: dup, dropped };
}

describe("summarizeIndex：參考片段 sample_clip1.webm 的真實索引", () => {
  const s = summarizeIndex(indexJson)!;

  it("幀數、時間戳範圍、實測幀率與時長", () => {
    expect(s.nSource).toBe(1762);
    expect(s.fps).toEqual({ num: 30, den: 1 });
    expect(s.timeBase).toEqual({ num: 1, den: 1000 });
    expect([s.firstPtsMs, s.lastPtsMs]).toEqual([2, 59885]);
    // 最後 − 第一 + 中位間隔 = 59883 + 33
    expect(s.durationMs).toBe(59916);
    expect(s.measuredFps!).toBeCloseTo(29.4073, 3);
  });

  it("間隔統計與中位數取法和引擎 gap_stats 一致（1200 ms 與 49 ms 兩個斷層）", () => {
    expect(s.gaps).toMatchObject({ minMs: 33, medianMs: 33, maxMs: 1200, maxAtSrc: 1, maxAtMs: 36, over40Count: 2 });
    expect(s.gaps!.over40ms).toEqual([
      { src: 1, ptsMs: 36, gapMs: 1200 },
      { src: 116, ptsMs: 5036, gapMs: 49 },
    ]);
  });

  it("關鍵幀 18 個：平均 GOP = 1762 / 18，最長 101 幀；第一個 GOP 因 1.2 s 斷層有 4.5 秒", () => {
    expect(s.keyframes).toBe(18);
    expect(s.gop!.meanFrames).toBeCloseTo(97.889, 3);
    expect(s.gop!.maxFrames).toBe(101);
    expect(s.gop!.maxMs).toBe(4534);
  });

  it("CFR 對應：1797 幀、35 個重複、0 丟幀、36 段（與引擎 media.index 的輸出一致）", () => {
    expect(s.cfr).toEqual({ nFrames: 1797, duplicates: 35, dropped: 0, runs: 36 });
    const cfr = indexJson.cfr as { runs: number[][]; nSource: number };
    expect(bruteForceCfr(cfr.runs, cfr.nSource)).toEqual({ duplicates: 35, dropped: 0 });
  });

  it("摘要不帶逐幀陣列（複製成 JSON 時不會塞進 1762 個時間戳）", () => {
    const text = JSON.stringify(s);
    expect(text).not.toContain("pts_ms");
    expect(text.length).toBeLessThan(1200);
  });
});

describe("summarizeCfr：只看 run 交界的算法", () => {
  const cfr = (runs: number[][], nFrames: number, nSource: number) => ({ version: 1, fps: { num: 30, den: 1 }, nFrames, nSource, runs });

  it("交界跳號 = 丟幀、交界同號 = 重複、尾巴沒蓋到也算丟", () => {
    const runs = [
      [0, 0, 3],
      [3, 4, 2],
      [5, 5, 1],
      [6, 6, 1],
    ];
    // 第二段從 src 4 開始（src 3 被擠掉）、第三段 src 5 = 上一段最後一個（重複）、尾巴 src 7 沒人顯示
    expect(summarizeCfr(cfr(runs, 7, 8), 8)).toEqual({ nFrames: 7, duplicates: 1, dropped: 2, runs: 4 });
    expect(bruteForceCfr(runs, 8)).toEqual({ duplicates: 1, dropped: 2 });
  });

  it("開頭定格（同一個來源幀連續多個 count=1 的 run）每一個都算重複", () => {
    const runs = [
      [0, 0, 2],
      [2, 1, 1],
      [3, 1, 1],
      [4, 2, 3],
    ];
    expect(summarizeCfr(cfr(runs, 7, 5), 5)).toEqual({ nFrames: 7, duplicates: 2, dropped: 0, runs: 4 });
    expect(bruteForceCfr(runs, 5)).toEqual({ duplicates: 2, dropped: 0 });
  });

  it("壞快取回 null：不連續、幀數不符、來源數不符、時間倒退、超出來源", () => {
    expect(summarizeCfr(cfr([[0, 0, 2], [3, 2, 1]], 4, 3), 3)).toBeNull();
    expect(summarizeCfr(cfr([[0, 0, 3]], 4, 3), 3)).toBeNull();
    expect(summarizeCfr(cfr([[0, 0, 3]], 3, 3), 4)).toBeNull();
    expect(summarizeCfr(cfr([[0, 2, 2], [2, 0, 1]], 3, 4), 4)).toBeNull();
    expect(summarizeCfr(cfr([[0, 0, 5]], 5, 3), 3)).toBeNull();
    expect(summarizeCfr({ version: 2, runs: [] }, 3)).toBeNull();
    expect(summarizeCfr(null, 3)).toBeNull();
  });
});

describe("summarizeIndex：形狀檢查與邊界", () => {
  const base = { version: 1, fps: { num: 30, den: 1 }, n: 4, pts_ms: [0, 33, 67, 100], key: [false, true, false, false], time_base: { num: 1, den: 1000 } };

  it("開頭不是關鍵幀：那一段也算一個 GOP；沒有 cfr → null", () => {
    const s = summarizeIndex(base)!;
    expect(s.keyframes).toBe(1);
    expect(s.gop).toEqual({ meanFrames: 4, maxFrames: 3, maxMs: 100 });
    expect(s.cfr).toBeNull();
  });

  it("只有一幀：沒有間隔統計、沒有實測幀率、時長 0", () => {
    const s = summarizeIndex({ ...base, n: 1, pts_ms: [5], key: [true] })!;
    expect(s.gaps).toBeNull();
    expect(s.measuredFps).toBeNull();
    expect(s.durationMs).toBe(0);
    expect(s.gop).toEqual({ meanFrames: 1, maxFrames: 1, maxMs: 0 });
  });

  it("讀不懂就回 null，不猜", () => {
    expect(summarizeIndex({ ...base, version: 2 })).toBeNull();
    expect(summarizeIndex({ ...base, key: [true] })).toBeNull();
    expect(summarizeIndex({ ...base, n: 5 })).toBeNull();
    expect(summarizeIndex({ ...base, pts_ms: [0, "33", 67, 100] })).toBeNull();
    expect(summarizeIndex({ ...base, pts_ms: [], key: [] })).toBeNull();
    expect(summarizeIndex({ ...base, fps: { num: 0, den: 1 } })).toBeNull();
    expect(summarizeIndex("nope")).toBeNull();
  });
});

describe("其他快取檔", () => {
  it("probe.v1.json：色彩標籤取自解碼第一幀、矩陣由高度推定", () => {
    const p = parseEngineProbe(probeJson)!;
    expect(p).toMatchObject({ codec: "vp9", width: 1280, height: 720, pixFmt: "yuv420p", fps: { num: 30, den: 1 }, startMs: 2, durationMs: null, nbFrames: null });
    expect(p).toMatchObject({ colorRange: "tv", colorSpace: null, colorPrimaries: null, colorTrc: null, matrixAssumed: "bt709", matrixSource: "heuristic", source: "pyav", hasAudio: true, audioCodec: "opus" });
    expect(parseEngineProbe({ ...probeJson, version: 2 })).toBeNull();
  });

  it("proxy.v1.json：ProxyMeta 丟掉的 codec / gop / audio / bytes 都讀得到", () => {
    expect(parseProxyInfo(proxyJson)).toEqual({ width: 1280, height: 720, frames: 1797, fps: { num: 30, den: 1 }, scale: 1, codec: "h264_nvenc", gop: 15, audio: "aac", bytes: 40388558, sourceFrames: 1762, seconds: 3 });
    expect(parseProxyInfo({ version: 1, audio: null })).toMatchObject({ audio: null, codec: null });
  });

  it("shots.v1.json：門檻、最短長度與切點分數", () => {
    const s = parseShotsInfo(shotsJson)!;
    expect([s.nFrames, s.threshold, s.minLen]).toEqual([1797, 0.2, 12]);
    expect(s.cuts.map((c) => [c.k, c.score])).toEqual([
      [60, 0.3098],
      [926, 0.3598],
      [1358, 0.2988],
    ]);
    expect(parseShotsInfo({ cuts: [{ k: "x" }, null] })?.cuts).toEqual([]);
  });
});
