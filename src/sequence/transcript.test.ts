// 文字稿剪輯：從字幕的逐字時間碼算出要剪掉哪幾段。
//
// 最要緊的兩類案例：
// 1. **不能剪的東西不要剪** —— 口頭禪預設關（「那個紅色的」剪掉就壞了）、重複字要留最後一個。
// 2. **投影要對** —— 字幕是來源幀 k，序列是 t；剪過的序列兩者不相等。
import { describe, expect, it } from "vitest";
import type { CaptionCueV1, CaptionTrackV1, SequenceV2 } from "../project/format";
import {
  cueCutRanges,
  cuesInSequence,
  cueRange,
  DEFAULT_FILLER,
  fillerCutOfSequence,
  fillerSpans,
  isDiscourseMarker,
  isHesitation,
  normalizeWord,
  spansToRanges,
  totalFrames,
} from "./transcript";

const W = (text: string, startFrame: number, endFrame: number) => ({ text, startFrame, endFrame });

function cue(id: string, words: ReturnType<typeof W>[]): CaptionCueV1 {
  return { id, startFrame: words[0].startFrame, endFrame: words[words.length - 1].endFrame, words };
}

function track(...cues: CaptionCueV1[]): CaptionTrackV1 {
  return {
    enabled: true,
    language: "zh-TW",
    source: null,
    presetId: "clean" as CaptionTrackV1["presetId"],
    style: {},
    segmentation: { mode: "sentence", maxUnitsPerLine: 20, maxLines: 2, maxWords: null, minDurationMs: 300, maxDurationMs: 6000, gapFrames: 2, chainGapMs: 200, lagOutMs: 120, pauseBreakMs: 600, snapToShots: false, cpsWarn: 20 },
    cues,
  };
}

/** 一條 V1、一個片段、整支媒體都用上（t == k）。 */
function seqOf(mediaId: string, srcIn: number, srcOut: number): SequenceV2 {
  return {
    version: 2,
    fps: { num: 24, den: 1 },
    video: [{ kind: "clip", id: "c1", mediaId, srcIn, srcOut, enabled: true }],
    audioLanes: [],
  } as unknown as SequenceV2;
}

describe("normalizeWord", () => {
  it("剝掉標點與空白，英文轉小寫", () => {
    // ASR 的輸出是「呃，」這種字帶標點的形狀；不剝掉的話字典一個都對不上，而症狀是「按了沒反應」
    expect(normalizeWord("呃，")).toBe("呃");
    expect(normalizeWord(" Um, ")).toBe("um");
    expect(normalizeWord("「嗯」")).toBe("嗯");
  });

  it("只剩標點就回空字串", () => {
    expect(normalizeWord("，。")).toBe("");
  });
});

describe("isHesitation", () => {
  it("中英文的遲疑音都認得", () => {
    for (const s of ["呃", "嗯", "唔", "uh", "Um", "er", "hmm"]) expect(isHesitation(s)).toBe(true);
  });

  it("拉長的拼法也認得（uhhhh / ummmm）", () => {
    expect(isHesitation("uhhhh")).toBe(true);
    expect(isHesitation("Ummmm")).toBe(true);
  });

  it("真的詞不算", () => {
    for (const s of ["我", "那個", "所以", "and", "the", "啊"]) expect(isHesitation(s)).toBe(false);
  });

  it("空字串 / 純標點不算", () => {
    expect(isHesitation("")).toBe(false);
    expect(isHesitation("，")).toBe(false);
  });
});

describe("isDiscourseMarker", () => {
  it("口頭禪認得，但遲疑音不算口頭禪（兩類要分開，清單上才看得出差別）", () => {
    expect(isDiscourseMarker("那個")).toBe(true);
    expect(isDiscourseMarker("就是說")).toBe(true);
    expect(isDiscourseMarker("呃")).toBe(false);
  });
});

describe("fillerSpans", () => {
  it("找出遲疑音，帶回來源幀與在句中的位置", () => {
    const tr = track(cue("q1", [W("呃", 10, 14), W("我", 14, 18), W("覺得", 18, 24)]));
    expect(fillerSpans("m1", tr)).toEqual([{ mediaId: "m1", cueId: "q1", i0: 0, i1: 1, k0: 10, k1: 14, text: "呃", kind: "hesitation" }]);
  });

  it("相鄰的同類合併成一段（呃、呃 中間那點空白也是雜音）", () => {
    const tr = track(cue("q1", [W("呃", 10, 14), W("呃", 14, 20), W("好", 20, 24)]));
    const s = fillerSpans("m1", tr);
    expect(s).toHaveLength(1);
    expect([s[0].k0, s[0].k1, s[0].i1]).toEqual([10, 20, 2]);
  });

  it("中間隔了別的字就另起一段", () => {
    const tr = track(cue("q1", [W("呃", 10, 14), W("好", 14, 18), W("嗯", 18, 22)]));
    expect(fillerSpans("m1", tr)).toHaveLength(2);
  });

  it("口頭禪預設不找 —— 「那個紅色的」剪掉句子就壞了", () => {
    const tr = track(cue("q1", [W("那個", 0, 6), W("紅色的", 6, 14)]));
    expect(fillerSpans("m1", tr)).toEqual([]);
    expect(fillerSpans("m1", tr, { ...DEFAULT_FILLER, includeDiscourseMarkers: true })).toHaveLength(1);
  });

  it("重複字只剪前面的，最後一個要留（我我我覺得 → 還是說得出「我覺得」）", () => {
    const tr = track(cue("q1", [W("我", 0, 4), W("我", 4, 8), W("我", 8, 12), W("覺得", 12, 20)]));
    const s = fillerSpans("m1", tr);
    expect(s).toHaveLength(1);
    // 只吃前兩個「我」（0..8），第三個留下來
    expect([s[0].k0, s[0].k1, s[0].kind]).toEqual([0, 8, "repeat"]);
  });

  it("重複字可以關掉", () => {
    const tr = track(cue("q1", [W("我", 0, 4), W("我", 4, 8), W("好", 8, 12)]));
    expect(fillerSpans("m1", tr, { ...DEFAULT_FILLER, includeRepeats: false })).toEqual([]);
  });

  it("跨 cue 不合併（兩句之間本來就有停頓）", () => {
    const tr = track(cue("q1", [W("呃", 0, 4)]), cue("q2", [W("呃", 4, 8)]));
    expect(fillerSpans("m1", tr)).toHaveLength(2);
  });

  it("壞掉的時間（end ≤ start、NaN）跳過，不讓整批剪歪", () => {
    const tr = track(cue("q1", [W("呃", 10, 10), W("嗯", Number.NaN, 20), W("uh", 20, 26)]));
    expect(fillerSpans("m1", tr).map((s) => s.text)).toEqual(["uh"]);
  });

  it("沒有字幕軌就回空陣列", () => {
    expect(fillerSpans("m1", null)).toEqual([]);
    expect(fillerSpans("m1", track())).toEqual([]);
  });
});

describe("spansToRanges", () => {
  const spans = [
    { mediaId: "m1", cueId: "q1", i0: 0, i1: 1, k0: 10, k1: 14, text: "呃", kind: "hesitation" as const },
    { mediaId: "m2", cueId: "q9", i0: 0, i1: 1, k0: 50, k1: 60, text: "um", kind: "hesitation" as const },
  ];

  it("只取這支媒體的", () => {
    expect(spansToRanges(spans, "m1")).toEqual([{ in: 10, out: 14 }]);
    expect(spansToRanges(spans, "m2")).toEqual([{ in: 50, out: 60 }]);
    expect(spansToRanges(spans, "m3")).toEqual([]);
  });

  it("padding 往外長，而且不會變成負的幀號", () => {
    expect(spansToRanges(spans, "m1", 3)).toEqual([{ in: 7, out: 17 }]);
    expect(spansToRanges([{ ...spans[0], k0: 1, k1: 4 }], "m1", 5)).toEqual([{ in: 0, out: 9 }]);
  });

  it("pad 之後重疊的會合併", () => {
    const two = [
      { ...spans[0], k0: 10, k1: 14 },
      { ...spans[0], k0: 16, k1: 20 },
    ];
    expect(spansToRanges(two, "m1")).toEqual([
      { in: 10, out: 14 },
      { in: 16, out: 20 },
    ]);
    expect(spansToRanges(two, "m1", 2)).toEqual([{ in: 8, out: 22 }]);
  });
});

describe("cueRange", () => {
  it("整句的來源幀；壞的回 null", () => {
    expect(cueRange({ startFrame: 10, endFrame: 30 })).toEqual({ in: 10, out: 30 });
    expect(cueRange({ startFrame: 30, endFrame: 30 })).toBeNull();
    expect(cueRange({ startFrame: Number.NaN, endFrame: 30 })).toBeNull();
  });
});

describe("投影到序列（k → t）", () => {
  it("片段從中間開始時，序列幀不等於來源幀", () => {
    // 片段用的是來源 [100, 200)，放在序列 t=0 → 來源 k=110 落在 t=10
    const seq = seqOf("m1", 100, 200);
    expect(cueCutRanges(seq, "m1", [{ startFrame: 110, endFrame: 120 }])).toEqual([{ in: 10, out: 20 }]);
  });

  it("沒被用到的來源不剪", () => {
    const seq = seqOf("m1", 100, 200);
    expect(cueCutRanges(seq, "m1", [{ startFrame: 10, endFrame: 20 }])).toEqual([]);
  });

  it("只剪落在片段內的那一半", () => {
    const seq = seqOf("m1", 100, 200);
    expect(cueCutRanges(seq, "m1", [{ startFrame: 90, endFrame: 110 }])).toEqual([{ in: 0, out: 10 }]);
  });

  it("別支媒體的字幕不會剪到這一支", () => {
    expect(cueCutRanges(seqOf("m1", 0, 100), "m2", [{ startFrame: 10, endFrame: 20 }])).toEqual([]);
  });
});

describe("fillerCutOfSequence", () => {
  const tr = track(cue("q1", [W("呃", 10, 14), W("我", 14, 18), W("覺得", 18, 24), W("嗯", 24, 28)]));

  it("找出來、投影好，並回報總長", () => {
    const seq = seqOf("m1", 0, 100);
    const r = fillerCutOfSequence(seq, () => tr);
    expect(r.spans.map((s) => s.text)).toEqual(["呃", "嗯"]);
    expect(r.ranges).toEqual([
      { in: 10, out: 14 },
      { in: 24, out: 28 },
    ]);
    expect(totalFrames(r.ranges)).toBe(8);
    expect(r.missing).toEqual([]);
  });

  it("沒有字幕的媒體進 missing，不亂猜", () => {
    const r = fillerCutOfSequence(seqOf("m1", 0, 100), () => null);
    expect(r.missing).toEqual(["m1"]);
    expect(r.ranges).toEqual([]);
  });

  it("selected 可以只剪勾起來的那幾段", () => {
    const seq = seqOf("m1", 0, 100);
    const r = fillerCutOfSequence(seq, () => tr, DEFAULT_FILLER, (s) => s.text === "嗯");
    // spans 仍然是全部（清單要看得到沒勾的），ranges 只剩勾的那一段
    expect(r.spans).toHaveLength(2);
    expect(r.ranges).toEqual([{ in: 24, out: 28 }]);
  });

  it("同步鎖軌上有旁白的時間不剪（剪下去會把旁白從中間切斷）", () => {
    const seq = seqOf("m1", 0, 100);
    // 24 fps、SEQ_SAMPLE_RATE 取樣：讓鎖軌片段蓋住序列幀 20..40
    const withLane = {
      ...seq,
      audioLanes: [{ id: "a1", syncLock: true, clips: [{ start: 0, length: 0, enabled: true }] }],
    } as unknown as SequenceV2;
    const lanes = withLane.audioLanes as unknown as { clips: { start: number; length: number }[] }[];
    const perFrame = 48000 / 24;
    lanes[0].clips[0].start = 20 * perFrame;
    lanes[0].clips[0].length = 20 * perFrame;
    const r = fillerCutOfSequence(withLane, () => tr);
    // 10..14 照剪；24..28 落在鎖軌忙碌的 20..40 內 → 整段不剪
    expect(r.ranges).toEqual([{ in: 10, out: 14 }]);
  });

  it("空序列不爆", () => {
    const empty = { version: 2, fps: { num: 24, den: 1 }, video: [], audioLanes: [] } as unknown as SequenceV2;
    expect(fillerCutOfSequence(empty, () => tr)).toEqual({ spans: [], ranges: [], missing: [] });
  });
});

describe("cuesInSequence", () => {
  const cues = [
    { id: "a", startFrame: 0, endFrame: 20 },
    { id: "b", startFrame: 40, endFrame: 60 },
    { id: "c", startFrame: 80, endFrame: 100 },
  ];

  it("片段涵蓋的才算還在剪輯裡", () => {
    // 片段只用來源 [30, 70)
    expect([...cuesInSequence(seqOf("m1", 30, 70), "m1", cues)]).toEqual(["b"]);
  });

  it("只要有一格重疊就算（剪掉一半的句子仍然聽得到）", () => {
    expect([...cuesInSequence(seqOf("m1", 19, 21), "m1", cues)].sort()).toEqual(["a"]);
  });

  it("停用的片段不算 —— 停用等於現在不播", () => {
    const seq = seqOf("m1", 0, 200);
    (seq.video[0] as { enabled: boolean }).enabled = false;
    expect(cuesInSequence(seq, "m1", cues).size).toBe(0);
  });

  it("別支媒體的片段不算", () => {
    expect(cuesInSequence(seqOf("m2", 0, 200), "m1", cues).size).toBe(0);
  });

  it("空序列 → 一句都不在", () => {
    const empty = { version: 2, fps: { num: 24, den: 1 }, video: [], audioLanes: [] } as unknown as SequenceV2;
    expect(cuesInSequence(empty, "m1", cues).size).toBe(0);
  });
});
