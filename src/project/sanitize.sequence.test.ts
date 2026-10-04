// schema v2（序列與音訊）的 sanitize 與最低版本寫檔（docs/editor-m2-design.md §3.5、§4.3；步驟 M2.1 的驗收）。
// fixtures/project/v2/ 與 Python 共用：broken-sequence.report.json 是 TS 報告的 golden，Python 那邊比對同一份 fixture 的修正結果。
import { describe, expect, it } from "vitest";
import { durationFrames, totalSamples } from "../sequence/map";
import { readProjectExtras, withProjectExtras } from "./extras";
import { buildProjectFile, EXPORT_DEFAULTS, INSERT_DEFAULTS, type AudioClipV2, type ProjectSnapshot, type VideoClipV2 } from "./format";
import { migrate } from "./migrate";
import { emptyReport, parseProjectFile, type ParsedProject } from "./sanitize";

const V1 = import.meta.glob("../../engine/tests/fixtures/project/v1/*.aivc.json", { eager: true, import: "default" }) as Record<string, unknown>;
const V2 = import.meta.glob("../../fixtures/project/v2/*.json", { eager: true, import: "default" }) as Record<string, unknown>;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const v1Fixture = (name: string) => clone(V1[`../../engine/tests/fixtures/project/v1/${name}`]) as Record<string, unknown>;
const v2Fixture = (name: string) => clone(V2[`../../fixtures/project/v2/${name}`]) as Record<string, unknown>;

const APP = { name: "AI Video Cut", version: "0.0.6" };
const T0 = new Date("2026-09-17T01:00:00.000Z");
const T1 = new Date("2026-09-17T02:30:00.000Z");

function snapOf(file: ParsedProject["file"]): ProjectSnapshot {
  return { media: file.media, activeMediaId: file.activeMediaId, profile: file.profile, shots: file.shots, tracks: file.tracks, plugin: file.plugin, insertDefaults: file.insertDefaults, exportDefaults: file.exportDefaults, captions: file.captions, sequence: file.sequence, audioMedia: file.audioMedia };
}

/** 讀檔 → 寫檔的 JSON 文字（App 存檔用 2 格縮排）。 */
function saveText(file: ParsedProject["file"], now: Date): string {
  return JSON.stringify(buildProjectFile(snapOf(file), APP, { createdAt: file.createdAt }, now), null, 2);
}

const clip = (id: string, srcIn: number, srcOut: number, extra: Record<string, unknown> = {}) => ({ kind: "clip", id, mediaId: "m1", srcIn, srcOut, enabled: true, audio: { enabled: true, gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [] }, ...extra });
const aclip = (id: string, start: number, length: number, extra: Record<string, unknown> = {}) => ({ id, source: { type: "audio", audioId: "a-1" }, start, length, srcIn: 0, enabled: true, gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [], ...extra });

/** 最小 v2 專案：m1（30 fps、1797 幀、48 kHz 音訊）＋一支 44.1 kHz 音樂 a-1。 */
function doc(sequence: unknown, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    app: APP,
    createdAt: "2026-09-17T00:00:00.000Z",
    updatedAt: "2026-09-17T00:00:00.000Z",
    media: [
      {
        id: "m1",
        path: "D:\\v\\clip.webm",
        name: "clip.webm",
        fingerprint: "",
        probe: { video: { width: 1280, height: 720 } },
        proxy: { version: 1, fps: { num: 30, den: 1 }, frames: 1797, width: 1280, height: 720, scale: 1, path: "C:\\c\\proxy.mp4" },
        audio: { codec: "opus", sampleRate: 48000, channels: 2, channelLayout: "stereo", startUs: 0, videoStartUs: 0, nSamples: 2875200, gaps: [] },
      },
    ],
    activeMediaId: "m1",
    shots: { m1: [] },
    tracks: { m1: [] },
    cardSlots: { m1: [] },
    audioMedia: [{ id: "a-1", path: "D:\\music\\bgm.mp3", name: "bgm.mp3", fingerprint: "", probe: null, role: "music", audio: { codec: "mp3", sampleRate: 44100, channels: 2, channelLayout: "stereo", startUs: 25057, videoStartUs: null, nSamples: 2646000, gaps: [] } }],
    sequence,
    ...over,
  };
}

function seq(video: unknown[], lanes: unknown[] = [], over: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "seq-1", name: "clip", fps: { num: 30, den: 1 }, width: 1280, height: 720, sampleRate: 48000, video, original: { muted: false, gainDb: 0 }, audioLanes: lanes, audio: { edgeDeclickMs: 3, limiter: false }, ...over };
}

const lane = (clips: unknown[], over: Record<string, unknown> = {}) => ({ id: "lane-1", name: "A1 音樂", role: "music", muted: false, locked: false, syncLock: false, gainDb: 0, clips, ...over });

describe("最低版本寫檔（§4.3）：v1 讀進寫出除 updatedAt 外逐位元相同", () => {
  for (const name of ["minimal.aivc.json", "captions.aivc.json", "broken.aivc.json"]) {
    it(`${name}：v0.0.6 寫出的樣子 → migrate → parse → build，只有 updatedAt 不同、仍是 schemaVersion 1、沒有序列鍵`, () => {
      // 引擎 fixture 先正規化一次，得到「App 寫出的 v1 檔」（引擎寫的 proxy 沒有 path 等差異不是這條測試要驗的）
      const first = parseProjectFile(migrate(v1Fixture(name)).doc).file;
      const onDisk = saveText(first, T0);
      const parsedDisk = JSON.parse(onDisk) as Record<string, unknown>;
      expect(parsedDisk.schemaVersion, name).toBe(1);
      expect(Object.keys(parsedDisk), name).not.toContain("sequence");
      expect(Object.keys(parsedDisk), name).not.toContain("audioMedia");

      const reread = parseProjectFile(migrate(JSON.parse(onDisk)).doc);
      expect(reread.report.total, name).toBe(0);
      expect(reread.file.sequence).toBeNull();
      expect(reread.file.audioMedia).toEqual([]);
      expect(reread.file.schemaVersion).toBe(1);
      const again = saveText(reread.file, T1);
      expect(again, name).not.toBe(onDisk);
      expect(again.replace(`"updatedAt": "${T1.toISOString()}"`, `"updatedAt": "${T0.toISOString()}"`), name).toBe(onDisk);
    });
  }

  it("v1 檔不經 migrate 直接 parse 也接受（引擎 / 測試會這樣用）：sequence null、audioMedia []、media 不長出 audio 鍵", () => {
    const { file, report } = parseProjectFile(v1Fixture("minimal.aivc.json"));
    expect(file.schemaVersion).toBe(1);
    expect(file.sequence).toBeNull();
    expect(file.audioMedia).toEqual([]);
    expect("audio" in file.media[0]).toBe(false);
    expect(report.warnings).toEqual([]);
  });

  it("寫哪一版只看 sequence 與 audioMedia：只有音訊媒體也寫 2；兩個都沒有寫 1 且整個鍵省略", () => {
    const { file } = parseProjectFile(doc(null));
    expect(file.schemaVersion).toBe(2);
    const withAudio = buildProjectFile(snapOf(file), APP, null, T0);
    expect(withAudio.schemaVersion).toBe(2);
    expect(withAudio.sequence).toBeNull();
    expect(withAudio.audioMedia).toHaveLength(1);
    const none = buildProjectFile({ ...snapOf(file), audioMedia: [] }, APP, null, T0);
    expect(none.schemaVersion).toBe(1);
    expect("sequence" in none).toBe(false);
    expect("audioMedia" in none).toBe(false);
  });

  it("版本 < 1（沒 migrate）與 > 2（未來版本）擲錯；2 的檔 parse 成功", () => {
    expect(() => parseProjectFile({ schemaVersion: 0, media: [] })).toThrow(/migrate/);
    expect(() => parseProjectFile({ schemaVersion: 3, media: [] })).toThrow(/較新版本/);
    expect(() => parseProjectFile({ schemaVersion: 1.5, media: [] })).toThrow(/migrate/);
    expect(parseProjectFile({ schemaVersion: 2, media: [] }).file.sequence).toBeNull();
  });
});

describe("fixtures/project/v2/two-clips-music（§7.4 的專案）", () => {
  it("乾淨：零 dropped、零 warnings；寫回去（沒有外掛：牌的 cardSlots / deck 走 extras 原樣帶回）內容完全相同", () => {
    const raw = v2Fixture("two-clips-music.aivc.json");
    const { doc } = migrate(clone(raw));
    const { file, report } = parseProjectFile(doc);
    expect(report).toEqual(emptyReport());
    expect(file.schemaVersion).toBe(2);
    // App 存檔的路徑（store/project.ts saveTo）：buildProjectFile ＋ 載入時收的 extras
    const extras = readProjectExtras(doc);
    expect(Object.keys(extras).sort()).toEqual(["cardSlots", "deck"]);
    const out = withProjectExtras(buildProjectFile(snapOf(file), APP, { createdAt: file.createdAt }, T1), extras);
    expect(JSON.parse(JSON.stringify(out))).toEqual({ ...raw, updatedAt: T1.toISOString() });
    // 核心認得的鍵順序不變；外掛的鍵接在最後（有外掛時逐位元相同：plugins/cards/frontend/project/sanitize.test.ts）
    const core = (o: object) => Object.keys(o).filter((k) => !(k in extras));
    expect(core(out)).toEqual(core(raw));
  });

  it("數字跟設計 §7.4 對得上：T = 750 幀、S(T) = 1 200 000；音樂片段與閃避點原樣", () => {
    const { file } = parseProjectFile(v2Fixture("two-clips-music.aivc.json"));
    const s = file.sequence!;
    expect(durationFrames(s)).toBe(750);
    expect(totalSamples(s)).toBe(1_200_000);
    const a1 = s.audioLanes[0].clips[0];
    expect(a1).toMatchObject({ start: 48000, length: 960000, srcIn: 88200, gainDb: -12, fadeIn: 96000, fadeOut: 144000, fadeCurve: "equalPower" });
    expect(a1.envelope.map((p) => p.at)).toEqual([420000, 432000, 624000, 636000]);
    expect(file.audioMedia[0].audio?.startUs).toBe(25057);
    expect(file.media[0].audio?.nSamples).toBe(2875200);
  });
});

describe("fixtures/project/v2/broken-sequence：sanitize 報告 golden", () => {
  const golden = V2["../../fixtures/project/v2/broken-sequence.report.json"] as { dropped: Record<string, number>; total: number; warnings: unknown[]; again: unknown };
  const parsed = () => parseProjectFile(migrate(v2Fixture("broken-sequence.aivc.json")).doc);

  it("dropped 與 warnings 跟 golden 完全相同（含順序）", () => {
    const { report } = parsed();
    expect({ dropped: report.dropped, total: report.total, warnings: report.warnings }).toEqual({ dropped: golden.dropped, total: golden.total, warnings: golden.warnings });
  });

  it("修正後的值 = broken-sequence.sanitized.json（Python test_schema_v2 比對同一份：只比筆數會放過「兩邊丟的是不同筆」）", () => {
    const gold = V2["../../fixtures/project/v2/broken-sequence.sanitized.json"] as { media: unknown[]; sequence: unknown; audioMedia: unknown };
    const out = JSON.parse(saveText(parsed().file, T0)) as { media: Record<string, unknown>[]; sequence: unknown; audioMedia: unknown };
    expect(out.sequence).toEqual(gold.sequence);
    expect(out.audioMedia).toEqual(gold.audioMedia);
    // 原本沒有 audio 鍵的媒體不能長出 audio 鍵；proxy 不比（缺 path 的 proxy 在 TS 讀成 null 是 v1 既有規則）
    expect(out.media.map((m) => ("audio" in m ? { id: m.id, audio: m.audio } : { id: m.id }))).toEqual(gold.media);
  });

  it("寫出再讀：dropped 歸零，只剩媒體事實造成的三條警告（離線、fps 不符、尺寸不符）；再寫一次逐位元相同", () => {
    const { file } = parsed();
    const text = saveText(file, T0);
    const again = parseProjectFile(JSON.parse(text));
    expect(again.report).toEqual(golden.again);
    expect(saveText(again.file, T0)).toBe(text);
  });

  it("修正結果：離線片段保留、重複 id 重新發號、fps 用媒體補、取樣率改 48k、未知鍵每一層都留", () => {
    const s = parsed().file.sequence!;
    expect(s.fps).toEqual({ num: 30, den: 1 });
    expect(s.sampleRate).toBe(48000);
    expect(s.video.map((x) => x.id)).toEqual(["c1", "c2", "c1-2", "c4", "gap-2"]);
    expect((s.video[1] as VideoClipV2).srcOut).toBe(120);
    expect((s.video[1] as VideoClipV2).label).toBe("離線片段");
    expect((s as unknown as Record<string, unknown>).futureSeqKey).toEqual({ x: 1 });
    expect((s.video[3] as unknown as Record<string, unknown>).futureClipKey).toEqual([1, 2]);
    expect((s.original as unknown as Record<string, unknown>).futureBus).toBe(1);
    expect(s.audio).toEqual({ edgeDeclickMs: 3, limiter: false });
  });

  it("音軌：重複 id 改名、不認得的角色 → other、推桿夾到 +12；沒寫 syncLock 的音樂軌預設關", () => {
    const [l1, l2] = parsed().file.sequence!.audioLanes;
    expect(l1).toMatchObject({ id: "lane-1", role: "music", syncLock: false });
    expect(l2).toMatchObject({ id: "lane-2", role: "other", gainDb: 12, muted: true, syncLock: true });
  });

  it("media[].audio：鍵不存在不長出來、null 保留、壞的變 null 並回報；audioMedia 壞的 gap 丟、角色回 other", () => {
    const { file } = parsed();
    const byId = Object.fromEntries(file.media.map((m) => [m.id, m]));
    expect(byId.m1.audio?.startUs).toBe(6500);
    expect(byId.m2.audio).toBeNull();
    expect("audio" in byId.m3).toBe(false);
    expect(byId.m4.audio).toBeNull();
    expect(file.audioMedia.map((a) => [a.id, a.role, a.audio?.gaps.length])).toEqual([
      ["a-ok", "music", 0],
      ["a-badrole", "other", 0],
    ]);
  });
});

describe("§3.5 規則逐條", () => {
  it("audioMedia：id 與 path 都必填（缺 path 的不佔 id）、沒寫 name 用路徑最後一段（Python test_schema_v2 有同一組案例）", () => {
    const audioMedia = [{ id: "a-nopath" }, { id: "a-empty", path: "" }, { id: "a-nopath", path: "D:\\music\\later.wav" }, { id: "a-slash", path: "/home/u/sfx/hit.ogg", name: "" }];
    const { file, report } = parseProjectFile(doc(null, { audioMedia }));
    expect(file.audioMedia.map((a) => [a.id, a.path, a.name])).toEqual([
      ["a-nopath", "D:\\music\\later.wav", "later.wav"],
      ["a-slash", "/home/u/sfx/hit.ogg", "hit.ogg"],
    ]);
    expect(report.dropped.audioMedia).toBe(2);
  });

  it("標記：t 必須是非負整數（否則整筆丟掉），id 缺或重複就重發，依 t 排序", () => {
    const markers = [{ id: "b", t: 200, name: "後" }, { id: "a", t: 50, name: "前" }, { id: "a", t: 90 }, { t: 10 }, { id: "bad", t: -1 }, { id: "bad2", t: 1.5 }, { id: "bad3" }, "字串"];
    const { file, report } = parseProjectFile(doc(seq([clip("c1", 0, 300)], [], { markers })));
    expect(file.sequence!.markers?.map((m) => [m.id, m.t, m.name])).toEqual([
      ["mk-4", 10, ""],
      ["a", 50, "前"],
      ["mk-3", 90, ""],
      ["b", 200, "後"],
    ]);
    expect(report.dropped["sequence.markers"]).toBe(4);
  });

  it("標記：不是陣列就整個丟掉；空的不寫出去（既有檔案的位元組不能因為多了這個功能就變）", () => {
    const bad = parseProjectFile(doc(seq([clip("c1", 0, 300)], [], { markers: 42 })));
    expect(bad.file.sequence!.markers).toBeUndefined();
    expect(bad.report.dropped["sequence.markers"]).toBe(1);
    const none = parseProjectFile(doc(seq([clip("c1", 0, 300)], [], { markers: [] })));
    expect("markers" in none.file.sequence!).toBe(false);
    expect(none.report.dropped["sequence.markers"]).toBeUndefined();
  });

  it("同軌重疊：依 start 排序後跟前一個重疊的丟後者（檔案裡的順序不算數）；剛好相接不算重疊", () => {
    const { file, report } = parseProjectFile(doc(seq([clip("c1", 0, 300)], [lane([aclip("b", 48000, 48000), aclip("a", 0, 96000), aclip("c", 96000, 10)])])));
    expect(file.sequence!.audioLanes[0].clips.map((c) => c.id)).toEqual(["a", "c"]);
    expect(report.dropped["sequence.overlap"]).toBe(1);
    expect(report.warnings).toEqual([]);
  });

  it("懸空的分離參照：detachedTo 指不到 → 清掉並恢復原音；detachedFrom 指不到 → 清掉；成對的保留且原音維持靜音", () => {
    const video = [clip("c1", 0, 30, { audio: { enabled: false, gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [], detachedTo: "gone" } }), clip("c2", 30, 60, { audio: { enabled: false, gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [], detachedTo: "x2" } })];
    const clips = [aclip("x2", 48000, 48000, { source: { type: "media", mediaId: "m1" }, detachedFrom: "c2" }), aclip("x3", 96000, 100, { detachedFrom: "c9" })];
    const { file, report } = parseProjectFile(doc(seq(video, [lane(clips, { role: "other", syncLock: true })])));
    const [c1, c2] = file.sequence!.video as VideoClipV2[];
    expect(c1.audio.enabled).toBe(true);
    expect("detachedTo" in c1.audio).toBe(false);
    expect(c2.audio).toMatchObject({ enabled: false, detachedTo: "x2" });
    const [x2, x3] = file.sequence!.audioLanes[0].clips;
    expect(x2.detachedFrom).toBe("c2");
    expect("detachedFrom" in x3).toBe(false);
    expect(report.warnings).toEqual([
      { code: "sequence.detachedTo", ref: "c1" },
      { code: "sequence.detachedFrom", ref: "x3" },
    ]);
    expect(report.total).toBe(0);
  });

  it("淡化超長：等比縮小、各自 floor，加起來 ≤ 片段長度", () => {
    const { file, report } = parseProjectFile(doc(seq([clip("c1", 0, 300)], [lane([aclip("a", 0, 1000, { fadeIn: 999, fadeOut: 2 })])])));
    const a = file.sequence!.audioLanes[0].clips[0];
    expect([a.fadeIn, a.fadeOut]).toEqual([998, 1]);
    expect(a.fadeIn + a.fadeOut).toBeLessThanOrEqual(a.length);
    expect(report.warnings).toEqual([{ code: "sequence.fades", ref: "a" }]);
  });

  it("29.97 fps：原音淡化的上限是片段在序列上的樣本長度 S(t1) − S(t0)，同樣 1 幀在不同位置可以差 1 樣本", () => {
    const fps = { num: 30000, den: 1001 };
    const media = [{ id: "m1", path: "D:\\v.mp4", name: "v.mp4", fingerprint: "", probe: null, proxy: { version: 1, fps, frames: 100, width: 1920, height: 1080, scale: 1, path: "C:\\p.mp4" } }];
    const withFade = (id: string, a: number) => clip(id, a, a + 1, { audio: { enabled: true, gainDb: 0, fadeIn: 1602, fadeOut: 0, fadeCurve: "linear", envelope: [] } });
    const { file, report } = parseProjectFile(doc(seq([withFade("c1", 0), withFade("c2", 1)], [], { fps, width: 1920, height: 1080 }), { media, audioMedia: [] }));
    const [c1, c2] = file.sequence!.video as VideoClipV2[];
    expect(c1.audio.fadeIn).toBe(1601); // S(1) − S(0) = 1601
    expect(c2.audio.fadeIn).toBe(1602); // S(2) − S(1) = 1602
    expect(report.warnings).toEqual([{ code: "sequence.fades", ref: "c1" }]);
  });

  it("自動化點：at 夾進 [0, length]、dB 夾到 [−96, +12]、依 at 穩定排序（同一個 at 的階梯保留原順序）", () => {
    const env = [{ at: 500, db: -6 }, { at: 2000, db: 0 }, { at: 100, db: 30 }, { at: 500, db: -12 }, { at: -5, db: -300 }];
    const { file } = parseProjectFile(doc(seq([clip("c1", 0, 300)], [lane([aclip("a", 0, 1000, { envelope: env })])])));
    expect(file.sequence!.audioLanes[0].clips[0].envelope).toEqual([{ at: 0, db: -96 }, { at: 100, db: 12 }, { at: 500, db: -6 }, { at: 500, db: -12 }, { at: 1000, db: 0 }]);
  });

  it("音訊片段：來源不存在 / length < 1 / start < 0 丟；srcIn 下限是 −10 秒（依來源原生取樣率，44.1 kHz → −441 000）", () => {
    const clips = [aclip("ok-neg", 0, 10, { srcIn: -441000 }), aclip("too-neg", 100, 10, { srcIn: -441001 }), aclip("ghost", 200, 10, { source: { type: "audio", audioId: "nope" } }), aclip("zero", 300, 0), aclip("neg-start", -1, 10), aclip("bad-src", 400, 10, { source: { type: "cloud", url: "x" } })];
    const { file, report } = parseProjectFile(doc(seq([clip("c1", 0, 300)], [lane(clips)])));
    expect(file.sequence!.audioLanes[0].clips.map((c: AudioClipV2) => c.id)).toEqual(["ok-neg"]);
    expect(report.dropped["sequence.audioClips"]).toBe(5);
  });

  it("樣本位置的浮點尾巴取最接近的整數，不丟片段（別的寫入端可能寫出 48000.0000001）", () => {
    const { file, report } = parseProjectFile(doc(seq([clip("c1", 0, 300)], [lane([aclip("a", 48000.0000001, 959999.9999)])])));
    expect(file.sequence!.audioLanes[0].clips[0]).toMatchObject({ start: 48000, length: 960000 });
    expect(report.total).toBe(0);
  });

  it("V1：媒體不存在 / srcIn ≥ srcOut / gap 長度 < 1 丟；超過 proxy 幀數保留並標離線", () => {
    const { file, report } = parseProjectFile(doc(seq([clip("c1", 0, 300), { ...clip("c2", 0, 10), mediaId: "zz" }, clip("c3", 9, 9), { kind: "gap", id: "g", length: 0 }, clip("c4", 1700, 1900)])));
    expect(file.sequence!.video.map((x) => x.id)).toEqual(["c1", "c4"]);
    expect(report.dropped["sequence.video"]).toBe(3);
    expect(report.warnings).toEqual([{ code: "sequence.offline", ref: "c4" }]);
  });

  it("id 重複重新發號，新 id 不跟其他片段原本的 id 撞（c1, c1, c1-2 → c1, c1-3, c1-2）", () => {
    const { file } = parseProjectFile(doc(seq([clip("c1", 0, 10), clip("c1", 10, 20), clip("c1-2", 20, 30)])));
    expect(file.sequence!.video.map((x) => x.id)).toEqual(["c1", "c1-3", "c1-2"]);
  });

  it("整條序列只在 fps 推不出來時丟（變回隱含序列並回報，寫檔版本跟著回到 1）", () => {
    const bad = parseProjectFile(doc(seq([{ ...clip("c1", 0, 10), mediaId: "zz" }], [], { fps: null }), { audioMedia: [] }));
    expect(bad.file.sequence).toBeNull();
    expect(bad.report.dropped.sequence).toBe(1);
    expect(bad.file.schemaVersion).toBe(1);
    const recovered = parseProjectFile(doc(seq([clip("c1", 0, 10)], [], { fps: { num: 0, den: 1 } })));
    expect(recovered.file.sequence!.fps).toEqual({ num: 30, den: 1 });
    expect(recovered.report.warnings).toEqual([{ code: "sequence.fps" }]);
    const notObject = parseProjectFile(doc("seq"));
    expect(notObject.file.sequence).toBeNull();
    expect(notObject.report.dropped.sequence).toBe(1);
  });

  it("缺 audio 的 V1 片段 = 預設原音（不回報）；原音與軌道缺的欄位補預設", () => {
    const { file, report } = parseProjectFile(doc({ fps: { num: 30, den: 1 }, width: 1280, height: 720, sampleRate: 48000, video: [{ kind: "clip", id: "c1", mediaId: "m1", srcIn: 0, srcOut: 10 }], audioLanes: [{ id: "l", clips: [] }] }));
    const s = file.sequence!;
    expect((s.video[0] as VideoClipV2).audio).toEqual({ enabled: true, gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [] });
    expect(s.original).toEqual({ muted: false, gainDb: 0 });
    expect(s.audio).toEqual({ edgeDeclickMs: 3, limiter: false });
    expect(s.audioLanes[0]).toEqual({ id: "l", name: "A1", role: "other", muted: false, locked: false, syncLock: true, gainDb: 0, clips: [] });
    expect(s.id).toBe("seq-1");
    expect(report).toEqual(emptyReport());
  });

  it("__proto__ 之類的未知鍵不搬進序列物件", () => {
    const raw = JSON.parse('{"__proto__": {"polluted": true}, "note": "ok"}') as Record<string, unknown>;
    const { file } = parseProjectFile(doc(seq([{ ...clip("c1", 0, 10), ...raw }], [], raw)));
    expect((file.sequence!.video[0] as unknown as Record<string, unknown>).note).toBe("ok");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(file.sequence)).toBe(Object.prototype);
  });

  it("不動 v1 的部分：序列存在時 tracks / shots / captions 的結果跟沒有序列一樣", () => {
    const withSeq = parseProjectFile(doc(seq([clip("c1", 0, 10)])));
    const without = parseProjectFile(doc(null, { audioMedia: [] }));
    expect(withSeq.file.tracks).toEqual(without.file.tracks);
    expect(withSeq.file.shots).toEqual(without.file.shots);
    expect(withSeq.file.insertDefaults).toEqual(INSERT_DEFAULTS);
    expect(withSeq.file.exportDefaults).toEqual(EXPORT_DEFAULTS);
  });
});
