// 字幕欄位的 drop-and-report 與往返：壞一個字丟一個字、沒字的段丟段；不認得的鍵每一層都留；沒有字幕的專案不寫 captions 鍵。
import { describe, expect, it } from "vitest";
import { buildProjectFile, defaultClipAudio, EXPORT_DEFAULTS, INSERT_DEFAULTS, SCHEMA_VERSION, type CaptionTrackV1, type ProjectSnapshot, type SequenceV2 } from "./format";
import { migrate } from "./migrate";
import { emptyReport, parseProjectFile, sanitizeCaptionStyle, sanitizeCaptionTrack, sanitizeCaptions } from "./sanitize";

// 共用 fixtures（專案沒有 @types/node：用 import.meta.glob 讀；captions.aivc.json 還沒放進來時就是沒有這個鍵）
const FIXTURES = import.meta.glob("../../engine/tests/fixtures/project/v1/*.aivc.json", { eager: true, import: "default" }) as Record<string, unknown>;
const fixture = (name: string): unknown => FIXTURES[`../../engine/tests/fixtures/project/v1/${name}`];
const engineProxy = { fps: { num: 30, den: 1 }, frames: 1797, width: 1280, height: 720, scale: 1, version: 1 };

function track(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true,
    language: "zh-TW",
    source: { backend: "faster-whisper", model: "large-v3-turbo", device: "cuda", computeType: "float16", asrLanguage: "zh", detected: "zh", languageProb: 0.97, asrPath: "C:\\c\\asr\\abc.v1.json", transcribedAt: "2026-09-17T00:00:00.000Z" },
    presetId: "pop",
    style: { colors: { active: "#FF0000" }, shadow: null },
    segmentation: { mode: "phrase", maxUnitsPerLine: 12, maxLines: 2, maxWords: 3, minDurationMs: 300, maxDurationMs: 2000, gapFrames: 0, chainGapMs: 300, lagOutMs: 150, pauseBreakMs: 300, snapToShots: false, cpsWarn: null },
    cues: [
      { id: "c1", startFrame: 0, endFrame: 30, words: [{ text: "百", startFrame: 0, endFrame: 10, prob: 0.9, source: "asr" }, { text: "家", startFrame: 10, endFrame: 20, prob: 0.3 }, { text: "樂。", startFrame: 20, endFrame: 30, emphasis: true }], flags: ["lowConfidence"] },
      { id: "c2", startFrame: 40, endFrame: 60, words: [{ text: " hello", startFrame: 40, endFrame: 60 }], speaker: null, lang: "en", hidden: true },
    ],
    ...extra,
  };
}

function doc(captions: unknown, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    app: { name: "AI Video Cut", version: "0.0.6" },
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
    media: [{ id: "m1", path: "D:\\v\\clip.webm", name: "clip.webm", fingerprint: "ab".repeat(32), probe: null, proxy: engineProxy }],
    activeMediaId: "m1",
    profile: "cards",
    shots: { m1: [] },
    tracks: { m1: [] },
    cardSlots: { m1: [] },
    deck: { styleId: "demo-deck", source: "builtin" },
    insertDefaults: INSERT_DEFAULTS,
    exportDefaults: EXPORT_DEFAULTS,
    ...(captions === undefined ? {} : { captions }),
    ...extra,
  };
}

function snapOf(file: ReturnType<typeof parseProjectFile>["file"]): ProjectSnapshot {
  return { media: file.media, activeMediaId: file.activeMediaId, profile: file.profile, shots: file.shots, tracks: file.tracks, plugin: file.plugin, insertDefaults: file.insertDefaults, exportDefaults: file.exportDefaults, captions: file.captions };
}

const APP = { name: "AI Video Cut", version: "0.0.6" };
const NOW = new Date("2026-09-17T01:00:00.000Z");

describe("sanitizeCaptionTrack", () => {
  it("乾淨的 track：零回報、形狀完整、optional 欄位照給的留", () => {
    const r = emptyReport();
    const t = sanitizeCaptionTrack(track(), 1797, r)!;
    expect(r.total).toBe(0);
    expect(t.presetId).toBe("pop");
    expect(t.style).toEqual({ colors: { active: "#FF0000" }, shadow: null });
    expect(t.cues[0].words[2]).toEqual({ text: "樂。", startFrame: 20, endFrame: 30, emphasis: true });
    expect(t.cues[1]).toMatchObject({ speaker: null, lang: "en", hidden: true });
    expect(t.source?.asrPath).toBe("C:\\c\\asr\\abc.v1.json");
  });

  it("幀號壞掉（字串 / 負數 / end ≤ start / 超過 proxy.frames）的段丟並回報；字跑出段外或重疊丟字", () => {
    const r = emptyReport();
    const t = sanitizeCaptionTrack(
      track({
        cues: [
          { id: "a", startFrame: "0", endFrame: 10, words: [{ text: "x", startFrame: 0, endFrame: 5 }] },
          { id: "b", startFrame: -1, endFrame: 10, words: [{ text: "x", startFrame: 0, endFrame: 5 }] },
          { id: "c", startFrame: 10, endFrame: 10, words: [{ text: "x", startFrame: 10, endFrame: 11 }] },
          { id: "d", startFrame: 1790, endFrame: 1800, words: [{ text: "x", startFrame: 1790, endFrame: 1795 }] },
          { id: "e", startFrame: 100, endFrame: 120, words: [{ text: "ok", startFrame: 100, endFrame: 110 }, { text: "out", startFrame: 115, endFrame: 125 }, { text: "lap", startFrame: 105, endFrame: 112 }, { text: 5, startFrame: 112, endFrame: 113 }] },
          { id: "f", startFrame: 1790, endFrame: 1797, words: [{ text: "end", startFrame: 1790, endFrame: 1797 }] },
        ],
      }),
      1797,
      r,
    )!;
    expect(t.cues.map((c) => c.id)).toEqual(["e", "f"]);
    expect(t.cues[0].words.map((w) => w.text)).toEqual(["ok"]);
    expect(r.dropped["captions.cues"]).toBe(4);
    expect(r.dropped["captions.words"]).toBe(3);
  });

  it("沒有字的段丟；重複 id / 重疊的段丟（後面那段）；段依時間排序", () => {
    const r = emptyReport();
    const w = (s: number) => [{ text: "字", startFrame: s, endFrame: s + 1 }];
    const t = sanitizeCaptionTrack(track({ cues: [{ id: "z", startFrame: 50, endFrame: 60, words: w(50) }, { id: "a", startFrame: 0, endFrame: 10, words: [] }, { id: "b", startFrame: 5, endFrame: 20, words: w(5) }, { id: "b", startFrame: 30, endFrame: 40, words: w(30) }, { id: "c", startFrame: 55, endFrame: 70, words: w(56) }] }), null, r)!;
    expect(t.cues.map((c) => c.id)).toEqual(["b", "z"]);
    expect(r.dropped["captions.cues"]).toBe(3);
  });

  it("文字 > 500 字元丟；flags 只收認得的；prob 不在 [0,1] 不留；source 只收 asr/user/llm", () => {
    const r = emptyReport();
    const t = sanitizeCaptionTrack(track({ cues: [{ id: "a", startFrame: 0, endFrame: 10, flags: ["tooFast", "bogus", "edited"], words: [{ text: "x".repeat(501), startFrame: 0, endFrame: 2 }, { text: "ok", startFrame: 2, endFrame: 4, prob: 1.5, source: "robot" }] }] }), 1797, r)!;
    expect(t.cues[0].words).toEqual([{ text: "ok", startFrame: 2, endFrame: 4 }]);
    expect(t.cues[0].flags).toEqual(["tooFast", "edited"]);
    expect(r.dropped["captions.words"]).toBe(1);
    expect(r.dropped["captions.flags"]).toBe(1);
  });

  it("不認得的 preset → subtitle 並回報；壞 source → null；segmentation 缺的欄位用 preset 在該語言的值補", () => {
    const r = emptyReport();
    const t = sanitizeCaptionTrack(track({ presetId: "neon", source: { model: 3 }, language: "en", segmentation: { maxLines: 7, maxWords: 2 } }), 1797, r)!;
    expect(t.presetId).toBe("subtitle");
    expect(t.source).toBeNull();
    expect(t.segmentation).toMatchObject({ mode: "sentence", maxUnitsPerLine: 42, maxLines: 2, maxWords: 2, cpsWarn: 20 });
    expect(r.dropped["captions.preset"]).toBe(1);
    expect(r.dropped["captions.source"]).toBe(1);
    expect(r.dropped["captions.segmentation"]).toBe(1);
  });

  it("樣式：壞色碼 / 列舉值只丟那片葉子，合法的 #RRGGBBAA 留；不認得的鍵留；shadow: null 合法", () => {
    const r = emptyReport();
    const s = sanitizeCaptionStyle({ colors: { text: "white", active: "#FFE600AA", future: null, glow: "#fff" }, layout: { anchor: "left", offsetYPct: 5 }, shadow: null, box: "big", sparkle: { on: true } }, r);
    expect(s).toEqual({ colors: { active: "#FFE600AA", future: null, glow: "#fff" }, layout: { offsetYPct: 5 }, shadow: null, sparkle: { on: true } });
    expect(r.dropped["captions.style"]).toBe(3);
  });

  it("不是物件 → null 並回報；__proto__ 之類的鍵不搬", () => {
    const r = emptyReport();
    expect(sanitizeCaptionTrack("nope", 1797, r)).toBeNull();
    expect(r.dropped.captions).toBe(1);
    const raw = JSON.parse('{"__proto__": {"polluted": true}, "x": 1}') as Record<string, unknown>;
    const t = sanitizeCaptionTrack({ ...track(), ...raw }, 1797, emptyReport())!;
    expect(t.extra).toEqual({ x: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("sanitizeCaptions / parseProjectFile", () => {
  it("指到不存在媒體的 track 丟（orphanMedia）", () => {
    const r = emptyReport();
    const out = sanitizeCaptions({ m1: track(), ghost: track() }, new Map([["m1", 1797]]), r);
    expect(Object.keys(out)).toEqual(["m1"]);
    expect(r.dropped.orphanMedia).toBe(1);
  });

  it("往返：parse → build → JSON → parse 相同；未知鍵在 track（攤平在頂層）/ cue / word / style 每一層都留", () => {
    const raw = track({
      engineNote: { v: 2 },
      style: { colors: { active: "#FF0000", neon: "#00FF00" }, futureThing: [1, 2] },
      cues: [{ id: "c1", startFrame: 0, endFrame: 10, words: [{ text: "字", startFrame: 0, endFrame: 10, phoneme: "zi4" }], karaokeLane: 2 }],
    });
    const first = parseProjectFile(doc({ m1: raw }));
    expect(first.report.total).toBe(0);
    const tr = first.file.captions!.m1;
    expect(tr.extra).toEqual({ engineNote: { v: 2 } });
    const built = buildProjectFile(snapOf(first.file), APP, { createdAt: first.file.createdAt }, NOW);
    const onDisk = JSON.parse(JSON.stringify(built)) as { captions: Record<string, Record<string, unknown>> };
    const disk = onDisk.captions.m1;
    expect(disk.extra).toBeUndefined();
    expect(disk.engineNote).toEqual({ v: 2 });
    expect(Object.keys(disk)[0]).toBe("engineNote"); // 未知鍵攤平在已知鍵之前（引擎鏡射同一個順序）
    const cues = disk.cues as Record<string, unknown>[];
    expect(cues[0].karaokeLane).toBe(2);
    expect((cues[0].words as Record<string, unknown>[])[0].phoneme).toBe("zi4");
    expect((disk.style as Record<string, unknown>).futureThing).toEqual([1, 2]);
    const again = parseProjectFile(onDisk);
    expect(again.report.total).toBe(0);
    expect(again.file.captions).toEqual(first.file.captions);
    expect(JSON.stringify(buildProjectFile(snapOf(again.file), APP, { createdAt: again.file.createdAt }, NOW))).toBe(JSON.stringify(built));
  });

  it("沒有字幕：parse 不長出 captions 鍵，build 也不寫；captions 全是 null 跟沒給輸出逐位元相同", () => {
    const parsed = parseProjectFile(doc(undefined));
    expect("captions" in parsed.file).toBe(false);
    const snap = snapOf(parsed.file);
    const a = JSON.stringify(buildProjectFile({ ...snap, captions: undefined }, APP, null, NOW));
    const b = JSON.stringify(buildProjectFile({ ...snap, captions: { m1: null } }, APP, null, NOW));
    const c = JSON.stringify(buildProjectFile({ ...snap, captions: {} }, APP, null, NOW));
    expect(a).toBe(b);
    expect(a).toBe(c);
    expect(a).not.toContain("captions");
  });

  it("既有 fixtures（minimal / broken）：加了字幕欄位之後輸出不變、也不長出 captions", () => {
    for (const name of ["minimal.aivc.json", "broken.aivc.json"]) {
      const raw = fixture(name);
      expect(raw, name).toBeDefined();
      const { file } = parseProjectFile(migrate(raw).doc);
      const out = buildProjectFile(snapOf(file), APP, { createdAt: file.createdAt }, NOW);
      expect(Object.keys(out), name).not.toContain("captions");
      const { captions: _c, ...snapNoCaptions } = snapOf(file);
      expect(JSON.stringify(out), name).toBe(JSON.stringify(buildProjectFile(snapNoCaptions, APP, { createdAt: file.createdAt }, NOW)));
    }
  });

  const shared = fixture("captions.aivc.json");
  it.skipIf(!shared)("共用 fixture captions.aivc.json：零回報，parse → build → parse 的 captions 相同", () => {
    const raw = JSON.parse(JSON.stringify(shared)) as unknown;
    const first = parseProjectFile(migrate(raw).doc);
    expect(first.report.dropped).toEqual({});
    const built = JSON.parse(JSON.stringify(buildProjectFile(snapOf(first.file), APP, { createdAt: first.file.createdAt }, NOW)));
    const again = parseProjectFile(built);
    expect(again.file.captions).toEqual(first.file.captions);
    const src = (raw as { captions?: Record<string, CaptionTrackV1> }).captions ?? {};
    expect(built.captions).toEqual(JSON.parse(JSON.stringify(src)));
  });
});

// 字幕（main）× schema v2 序列（feat/editor-m2）的護欄：釘「兩個功能的欄位互不吃掉對方」。
// 序列本身的 sanitize 規則在 sanitize.sequence.test.ts。
describe("字幕 × schema v2", () => {
  const seq: SequenceV2 = {
    id: "seq-1",
    name: "clip",
    fps: { num: 30, den: 1 },
    width: 1280,
    height: 720,
    sampleRate: 48000,
    video: [{ kind: "clip", id: "c1", mediaId: "m1", srcIn: 0, srcOut: 1797, enabled: true, audio: defaultClipAudio() }],
    original: { muted: false, gainDb: 0 },
    audioLanes: [],
    audio: { edgeDeclickMs: 3, limiter: false },
  };

  it("migrate v1 → v2 原樣保留 captions（toV2 只加 sequence / audioMedia 兩個鍵）", () => {
    const raw = doc({ m1: track() }, { schemaVersion: 1 });
    const { doc: up, applied } = migrate(JSON.parse(JSON.stringify(raw)));
    expect(applied).toEqual([2]);
    expect(up.schemaVersion).toBe(2);
    expect(up.captions).toEqual(raw.captions);
    expect(up.sequence).toBeNull();
    expect(up.audioMedia).toEqual([]);
  });

  it("共用 fixture captions.aivc.json（v1）升到 v2 後 captions 逐欄相同", () => {
    const raw = fixture("captions.aivc.json") as Record<string, unknown> | undefined;
    expect(raw).toBeDefined();
    const { doc: up } = migrate(JSON.parse(JSON.stringify(raw)));
    expect(up.schemaVersion).toBe(2);
    expect(up.captions).toEqual(raw!.captions);
  });

  it("buildProjectFile：只有字幕 → 寫 v1 且不帶序列鍵；有序列 → 寫 v2，captions 與 sequence / audioMedia 並存", () => {
    const base: ProjectSnapshot = {
      media: [],
      activeMediaId: null,
      profile: "generic",
      shots: {},
      tracks: {},
      insertDefaults: INSERT_DEFAULTS,
      exportDefaults: EXPORT_DEFAULTS,
      captions: { m1: track() as unknown as CaptionTrackV1 },
    };
    const v1 = buildProjectFile(base, APP, null, NOW);
    expect(v1.schemaVersion).toBe(1);
    expect(v1.captions?.m1).toBeDefined();
    expect(Object.keys(v1)).not.toContain("sequence");
    expect(Object.keys(v1)).not.toContain("audioMedia");

    const v2 = buildProjectFile({ ...base, sequence: seq }, APP, null, NOW);
    expect(v2.schemaVersion).toBe(2);
    expect(v2.captions).toEqual(v1.captions);
    expect(v2.sequence).toEqual(seq);
    expect(v2.audioMedia).toEqual([]);
  });

  it("parse：v2 檔的字幕與序列一起讀進來，互不影響對方的 sanitize 報告", () => {
    const withBoth = parseProjectFile(doc({ m1: track() }, { sequence: seq, audioMedia: [] }));
    const captionsOnly = parseProjectFile(doc({ m1: track() }, { schemaVersion: 1 }));
    expect(withBoth.report).toEqual(captionsOnly.report);
    expect(withBoth.file.captions).toEqual(captionsOnly.file.captions);
    expect(withBoth.file.sequence).toEqual(seq);
    expect([withBoth.file.schemaVersion, captionsOnly.file.schemaVersion]).toEqual([2, 1]);
  });
});
