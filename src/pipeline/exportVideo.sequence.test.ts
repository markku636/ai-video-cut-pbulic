// M2.17 輸出對話框的序列部分（docs/editor-m2-design.md §12、§13 M2.17）：摘要與重新混音的原因（鏡像引擎 mix_reasons）、
// 音訊一行白話、削波警告、序列範圍換成來源範圍、輸出後驗收（750 幀 / 1 200 000 樣本 / mp4 AAC 尾端容許 0～1023）、
// renderArgs 只有「只輸出素材」才送 sequence=ignore（v0.0.6 的 args 逐鍵不變）。
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const E = await import("./exportVideo");
const { A_MUSIC, aclip, gap, lane, seqOf, vclip } = await import("../sequence/testkit");
type RenderPlanResult = import("./exportVideo").RenderPlanResult;

const framesOf = (id: string) => (id === "m1" ? 1797 : id === "m2" ? 600 : null);

/** §7.4 的例子：兩個片段（300 + 450 幀）＋一段音樂。 */
const SEQ_74 = seqOf(
  [vclip("c1", "m1", 60, 360), vclip("c2", "m1", 930, 1380, { audio: { enabled: true, gainDb: -3, fadeIn: 0, fadeOut: 48000, fadeCurve: "equalPower", envelope: [] } })],
  [lane("lane-1", "music", [aclip("a1", A_MUSIC.id, 48000, 960000, { srcIn: 88200, gainDb: -12 })])],
);

function plan(over: Partial<RenderPlanResult> = {}): RenderPlanResult {
  return {
    out: "D:\\out\\final.webm",
    encode: { container: "webm", format: "webm", ext: ".webm", video_codec: "libvpx-vp9", video_args: [], audio_mode: "mix", audio_codec: "libopus", audio_args: [], color_args: [], gpu: false, deterministic: true, dropped: [], notes: [] },
    size: [1280, 720],
    fps: { num: 30, den: 1 },
    frames: { total: 750, write: 750, composite: 0 },
    range: null,
    trim: false,
    tracks: [],
    skipped: [],
    emitMatte: null,
    emitFaces: null,
    sequence: { id: "seq-1", frames: 750, duration: "00:00:25:00", fps: { num: 30, den: 1 }, clips: 2, gaps: 0, disabled: 0, audioClips: 1, untouched: false, range: null, trim: false },
    audio: { mode: "mix", codec: "libopus", reasons: [], inputs: 3, samples: 1_200_000, graph: "…", peakEstimateDbfs: -4.2, limiter: false, notes: [] },
    ...over,
  };
}

describe("序列摘要與重新混音的原因", () => {
  it("§7.4：25.0 秒、2 片段、1 音樂；原因依引擎的順序", () => {
    const s = E.sequenceExportSummary(SEQ_74, framesOf);
    expect(s).toMatchObject({ frames: 750, clips: 2, gaps: 0, audioClips: 1, musicClips: 1, untouched: false });
    expect(s.seconds).toBe(25);
    expect(s.reasons.map((r) => r.key)).toEqual(["分割／修剪過片段", "片段增益或淡化", "加入 {n} 段音訊"]);
  });

  it("未動過的整段片段（B 切一刀再合併也算）→ untouched、沒有原因；幀數未知、空白、停用、原音軌各自講", () => {
    expect(E.sequenceExportSummary(seqOf([vclip("c1", "m1", 0, 1797)]), framesOf)).toMatchObject({ untouched: true, reasons: [] });
    expect(E.mixReasonsOf(seqOf([vclip("c1", "mx", 0, 10)]), framesOf).map((r) => r.key)).toEqual(["媒體幀數未知（無法確認片段是整段）"]);
    const seq = { ...seqOf([vclip("c1", "m1", 0, 30, { enabled: false }), gap("g", 10), vclip("c2", "m1", 30, 60, { audio: { enabled: false, gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [] } })]), original: { muted: true, gainDb: 0 } };
    expect(E.mixReasonsOf(seq, framesOf)).toEqual([{ key: "分割／修剪過片段" }, { key: "{n} 段空白", params: { n: 1 } }, { key: "停用 {n} 個片段", params: { n: 1 } }, { key: "原音靜音或已分離" }, { key: "原音軌靜音或推桿" }]);
    expect(E.mixReasonsOf(seqOf([]), framesOf).map((r) => r.key)).toEqual(["序列是空的"]);
  });
});

describe("音訊一行白話", () => {
  it("重新混音講編碼（依容器）與原因；未修改講直接複製；none 講不輸出；沒有序列交回 M1", () => {
    const s = E.sequenceExportSummary(SEQ_74, framesOf);
    expect(E.audioSummaryPhrase(s, "auto", "D:\\o.webm")?.line).toEqual({ key: "音訊：重新混音 → {codec}", params: { codec: "Opus 160 kbps" } });
    expect(E.audioSummaryPhrase(s, "copy", "D:\\o.MP4")?.line.params).toEqual({ codec: "AAC 160 kbps" });
    expect(E.audioSummaryPhrase(s, "auto", "/o.mkv")?.line.params).toEqual({ codec: "FLAC" });
    expect(E.audioSummaryPhrase(s, "auto", "/o.avi")?.line).toEqual({ key: "音訊：重新混音" });
    expect(E.audioSummaryPhrase(s, "auto", "/o.webm")?.reasons).toHaveLength(3);
    expect(E.audioSummaryPhrase(E.sequenceExportSummary(seqOf([vclip("c1", "m1", 0, 1797)]), framesOf), "copy", "/o.webm")?.line.key).toBe("音訊：直接複製（序列未修改）");
    expect(E.audioSummaryPhrase(s, "none", "/o.webm")?.line.key).toBe("音訊：不輸出");
    expect(E.audioSummaryPhrase(null, "auto", "/o.webm")).toBeNull();
  });

  it("削波警告：估計峰值 > −1 dBFS 且沒開限幅器才講（§0.1 Q4）", () => {
    expect(E.clippingPeak(plan())).toBeNull();
    expect(E.clippingPeak(plan({ audio: { ...plan().audio!, peakEstimateDbfs: 1.3 } }))).toBe(1.3);
    expect(E.clippingPeak(plan({ audio: { ...plan().audio!, peakEstimateDbfs: 1.3, limiter: true } }))).toBeNull();
    expect(E.clippingPeak(plan({ audio: { ...plan().audio!, peakEstimateDbfs: null } }))).toBeNull();
    expect(E.clippingPeak({})).toBeNull();
  });
});

describe("範圍與 renderArgs", () => {
  it("序列範圍 → 來源範圍：落在同一個片段裡才換得過去", () => {
    expect(E.sourceRangeOfSequenceRange(SEQ_74, "m1", { in: 310, out: 400 })).toEqual({ in: 940, out: 1030 });
    expect(E.sourceRangeOfSequenceRange(SEQ_74, "m1", { in: 290, out: 310 })).toBeNull();
    expect(E.sourceRangeOfSequenceRange(SEQ_74, "m2", { in: 0, out: 10 })).toBeNull();
  });

  it("只有「只輸出目前素材」才送 sequence=ignore；auto / null 不送（v0.0.6 的 args 逐鍵不變）", () => {
    const base = { outPath: "o.mp4", range: null, codec: null, quality: null, audio: null };
    expect(E.renderArgs("p", "m1", { ...base, sequence: "ignore" })).toEqual({ project: "p", out: "o.mp4", media: "m1", sequence: "ignore" });
    expect(E.renderArgs("p", "m1", { ...base, sequence: "auto" })).toEqual({ project: "p", out: "o.mp4", media: "m1" });
    expect(E.renderArgs("p", "m1", { ...base, sequence: null })).toEqual({ project: "p", out: "o.mp4", media: "m1" });
  });

  it("自動重構圖：有路徑才送 reframe，沒有就一個鍵都不多", () => {
    const base = { outPath: "o.mp4", range: null, codec: null, quality: null, audio: null };
    expect(E.renderArgs("p", "m1", { ...base, reframe: "D:\p.reframe.json" })).toEqual({ project: "p", out: "o.mp4", media: "m1", reframe: "D:\p.reframe.json" });
    expect(E.renderArgs("p", "m1", { ...base, reframe: null })).toEqual({ project: "p", out: "o.mp4", media: "m1" });
    expect(E.renderArgs("p", "m1", base)).toEqual({ project: "p", out: "o.mp4", media: "m1" });
  });
});

describe("輸出後驗收（§13 M2.17 E2E：750 幀、1 200 000 樣本、時長差 ≤ 1 幀）", () => {
  it("webm：幀數與樣本數都要剛好", () => {
    const exp = E.expectationOf(plan());
    expect(exp).toEqual({ frames: 750, fps: { num: 30, den: 1 }, samples: 1_200_000, sampleRate: 48000, aacTailSlack: false });
    const ok = E.verifyExport(exp, { frames: 750, samples: 1_200_000, sampleRate: 48000 });
    expect(ok.ok).toBe(true);
    expect(ok.checks.map((c) => c.id)).toEqual(["frames", "samples", "duration"]);
    expect(E.verifyExport(exp, { frames: 749, samples: 1_200_000, sampleRate: 48000 }).ok).toBe(false);
    expect(E.verifyExport(exp, { frames: 750, samples: 1_200_001, sampleRate: 48000 }).ok).toBe(false);
    expect(E.verifyExport(exp, { frames: 750, samples: null, sampleRate: null }).ok).toBe(false);
  });

  it("mp4 AAC：尾端多 0～1023 樣本可以（edit list 不裁尾端 padding），少一個或多 1024 不行", () => {
    const exp = E.expectationOf(plan({ encode: { ...plan().encode, ext: ".mp4", container: "mp4" } }));
    expect(exp.aacTailSlack).toBe(true);
    expect(E.verifyExport(exp, { frames: 750, samples: 1_200_128, sampleRate: 48000 }).ok).toBe(true);
    expect(E.verifyExport(exp, { frames: 750, samples: 1_201_023, sampleRate: 48000 }).ok).toBe(true);
    expect(E.verifyExport(exp, { frames: 750, samples: 1_201_024, sampleRate: 48000 }).ok).toBe(false);
    expect(E.verifyExport(exp, { frames: 750, samples: 1_199_999, sampleRate: 48000 }).ok).toBe(false);
  });

  it("copy 路徑（序列未修改）只驗幀數；需不需要驗收看 plan.sequence", () => {
    const copy = plan({ encode: { ...plan().encode, audio_mode: "copy" }, sequence: { ...plan().sequence!, untouched: true }, audio: { ...plan().audio!, mode: "copy", samples: null } });
    const exp = E.expectationOf(copy);
    expect(exp.samples).toBeNull();
    expect(E.verifyExport(exp, { frames: 750, samples: 1_234_567, sampleRate: 48000 })).toEqual({ ok: true, checks: [{ id: "frames", ok: true, expected: 750, actual: 750 }] });
    expect(E.needsVerification(copy)).toBe(false);
    expect(E.needsVerification(plan())).toBe(true);
    expect(E.needsVerification(plan({ sequence: undefined, audio: undefined }))).toBe(false);
  });

  it("白話：一項一句", () => {
    const v = E.verifyExport(E.expectationOf(plan()), { frames: 750, samples: 1_200_000, sampleRate: 48000 });
    expect(E.verificationPhrases(v)).toEqual([
      { key: "視訊 {actual} / {expected} 幀 {mark}", params: { actual: 750, expected: 750, mark: "✓" } },
      { key: "音訊 {actual} / {expected} 樣本 {mark}", params: { actual: 1_200_000, expected: 1_200_000, mark: "✓" } },
      { key: "音訊與視訊長度差 {d} 幀 {mark}", params: { d: 0, mark: "✓" } },
    ]);
  });
});
