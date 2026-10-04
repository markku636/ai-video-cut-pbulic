import { afterEach, describe, expect, it } from "vitest";
import indexJson from "../../fixtures/sample/cache/index.v1.json";
import probeJson from "../../fixtures/sample/cache/probe.v1.json";
import proxyJson from "../../fixtures/sample/cache/proxy.v1.json";
import shotsJson from "../../fixtures/sample/cache/shots.v1.json";
import type { MediaProbe } from "../api";
import { useLang } from "../i18n";
import en from "../locales/en";
import type { ShotV1 } from "../project/format";
import { displayWidth } from "./mediaFormat";
import mediaFormatSource from "./mediaFormat.ts?raw";
import { parseEngineProbe, parseProxyInfo, parseShotsInfo, summarizeIndex } from "./mediaCache";
import mediaInfoSource from "./mediaInfo.ts?raw";
import { deriveMediaInfo, detectVfr, mediaChips, mediaInfoJson, mediaInfoText, type InfoRow, type MediaInfoInput, type MediaInfoModel } from "./mediaInfo";

const FP = "d171ec9031ba677f9ee35bb109820ccfdbf33c804141f58ed28635727a4f7984";

/** 範例 WebM 經過新版 ffmpeg.rs 的 probe（欄位值取自 src-tauri 測試裡的真實 ffprobe 輸出）。 */
const SAMPLE_PROBE: MediaProbe = {
  path: "D:\\v\\sample_clip1.webm",
  size_bytes: 22768280,
  duration_ms: 0,
  container: "matroska,webm",
  audio: { codec: "opus", sample_rate: 48000, channels: 2, bit_rate: null, codec_long_name: "Opus (Opus Interactive Audio Codec)", profile: null, channel_layout: "stereo", sample_fmt: "fltp", bits_per_sample: null, duration_ms: null, start_time_ms: 0 },
  video: {
    codec: "vp9",
    width: 1280,
    height: 720,
    pix_fmt: "yuv420p",
    r_frame_rate: { num: 30, den: 1 },
    avg_frame_rate: { num: 0, den: 1 },
    time_base: { num: 1, den: 1000 },
    nb_frames: null,
    duration_ms: null,
    start_time_ms: 2,
    color_range: "tv",
    color_space: null,
    color_transfer: null,
    color_primaries: null,
    rotation: 0,
    has_b_frames: 0,
    bit_rate: null,
    codec_long_name: "Google VP9",
    profile: "Profile 0",
    level: null,
    codec_tag: null,
    bits_per_raw_sample: null,
    field_order: null,
    chroma_location: null,
    sample_aspect_ratio: { num: 1, den: 1 },
    display_aspect_ratio: { num: 16, den: 9 },
  },
  fingerprint: FP,
  format_long_name: "Matroska / WebM",
  bit_rate: null,
  creation_time: null,
  encoder: "Chrome",
  timecode: null,
};

const SHOTS: ShotV1[] = [
  { id: "shot1", startFrame: 0, endFrame: 60, kind: "unknown", source: "auto" },
  { id: "shot2", startFrame: 60, endFrame: 926, kind: "unknown", source: "auto" },
  { id: "shot3", startFrame: 926, endFrame: 1358, kind: "unknown", source: "auto" },
  { id: "shot4", startFrame: 1358, endFrame: 1797, kind: "close", source: "user" },
];

function sampleInput(over: Partial<MediaInfoInput> = {}): MediaInfoInput {
  return {
    media: { id: FP.slice(0, 16), name: "sample_clip1.webm", path: SAMPLE_PROBE.path, fingerprint: FP },
    probe: SAMPLE_PROBE,
    probeFrom: "live",
    probeError: null,
    engineProbe: parseEngineProbe(probeJson),
    index: summarizeIndex(indexJson),
    proxy: parseProxyInfo(proxyJson),
    shots: parseShotsInfo(shotsJson),
    cache: { proxy: true, index: true, thumbs: true, dir: "C:\\cache\\media\\d171ec9031ba677f" },
    loading: false,
    project: { shots: SHOTS, tracks: [], loadedSolves: 0 },
    ...over,
  };
}

function rowOf(model: MediaInfoModel, key: string): InfoRow {
  for (const s of model.sections) for (const r of s.rows) if (r.key === key) return r;
  throw new Error(`沒有 ${key} 這一列`);
}

const allRows = (m: MediaInfoModel) => m.sections.flatMap((s) => s.rows);

afterEach(() => useLang.setState({ lang: "zh-TW", catalog: {} }));

describe("deriveMediaInfo：範例 WebM（真實快取）", () => {
  const model = deriveMediaInfo(sampleInput());
  const v = (key: string) => rowOf(model, key).value;

  it("區塊順序與表頭", () => {
    expect(model.sections.map((s) => s.id)).toEqual(["file", "video", "color", "timing", "audio", "engine"]);
    expect(model.chips).toEqual(["1280×720", "30p", "VP9", "VFR→CFR", "Opus 2ch"]);
    expect(model.badges.map((b) => b.key)).toEqual(["vfr", "untagged"]);
  });

  it("推算：時長靠索引、整體位元率是估計值、bpp 用實測 fps", () => {
    const d = model.derived;
    expect([d.durationMs, d.durationSource]).toEqual([59916, "index"]);
    expect(d.overallBitrateEstimated).toBe(true);
    expect(d.overallBitrate!).toBeCloseTo((22768280 * 8 * 1000) / 59916, 3);
    expect(d.measuredFps!).toBeCloseTo(29.407, 3);
    expect(d.bitsPerPixel!).toBeCloseTo(0.1122, 4);
    expect(d.bitsPerPixelBasis).toBe("overall");
    expect([d.vfr, d.vfrReasons.map((r) => r.code)]).toEqual([true, ["gap", "duplicates", "rate"]]);
    expect([d.colorTagged, d.hdr, d.fingerprintChanged]).toEqual([false, false, false]);
  });

  it("檔案", () => {
    expect(v("file.container")).toBe("Matroska / WebM（matroska,webm）");
    expect(v("file.size")).toBe("21.7 MiB（22,768,280 位元組）");
    expect(v("file.duration")).toBe("59.916 秒（00:00:59.916）");
    expect(rowOf(model, "file.duration").note).toContain("依時間戳");
    expect(v("file.bitrate")).toBe("3.04 Mb/s");
    expect(rowOf(model, "file.bitrate")).toMatchObject({ source: "derived" });
    expect(v("file.encoder")).toBe("Chrome");
    expect(rowOf(model, "file.created")).toMatchObject({ value: null, note: "檔案沒有 creation_time 標籤（螢幕錄影、網頁錄影常見）" });
    expect(v("file.fingerprint")).toBe(FP);
  });

  it("視訊：VP9 沒回報的欄位要推得出來或講原因", () => {
    expect(v("video.codec")).toBe("VP9");
    expect(rowOf(model, "video.codec").note).toBe("Google VP9");
    expect(v("video.profile")).toBe("Profile 0");
    expect(rowOf(model, "video.fourcc")).toMatchObject({ value: null, note: "容器不用 FourCC（Matroska / WebM 用 CodecID）" });
    expect(v("video.resolution")).toBe("1280 × 720");
    expect(rowOf(model, "video.aspect")).toMatchObject({ value: "16:9 · 1.778", note: "像素比 1:1（方形像素）" });
    expect(v("video.chroma")).toBe("4:2:0");
    expect(rowOf(model, "video.depth")).toMatchObject({ value: "8 位元", note: "由像素格式推得", source: "derived" });
    expect(rowOf(model, "video.scan")).toMatchObject({ value: "逐行", note: "推定：VP9 沒有交錯模式", source: "derived" });
    expect(v("video.bframes")).toBe("無");
    expect(rowOf(model, "video.bitrate").value).toBeNull();
    expect(v("video.bpp")).toBe("0.112");
    expect(rowOf(model, "video.bpp").note).toBe("估計：整體位元率（含音訊）÷（寬 × 高 × 29.41 fps）");
  });

  it("色彩：未標示時講清楚是推定、引擎採用什麼", () => {
    expect(rowOf(model, "color.summary")).toMatchObject({ value: "BT.709 · 有限範圍（推定：未標示色彩）", warn: true });
    expect(rowOf(model, "color.range")).toMatchObject({ value: "有限範圍（tv，16–235）", note: "容器與解碼第一幀一致" });
    expect(rowOf(model, "color.matrix")).toMatchObject({ value: null, note: "容器與位元流都沒有標示", warn: true });
    expect(rowOf(model, "color.engine")).toMatchObject({ value: "BT.709（推定：未標示，高度 720 ≥ 576）", note: "輸出會依引擎採用值標記 BT.709 / tv" });
  });

  it("時間：VFR 一句話講完（來源幀、CFR 補幀、最大斷層位置）", () => {
    expect(v("timing.nominalFps")).toBe("30 fps（30/1）");
    expect(rowOf(model, "timing.avgFps")).toMatchObject({ value: null, note: "容器未標示（WebM 常見）；看「實測幀率」" });
    expect(v("timing.measuredFps")).toBe("29.407 fps");
    expect(v("timing.mode")).toBe("可變（VFR）：來源 1762 幀，轉成 30/1 CFR proxy 補 35 個重複幀、丟 0 幀；最大斷層 1200 ms（0.036 秒處）");
    expect(v("timing.vfrReasons")).toBe("最大間隔 1200 ms 超過中位 33 ms 的 1.5 倍；CFR 對應補了 35 個重複幀；實測 29.41 fps 與標稱 30 fps 相差 1.98%");
    expect(rowOf(model, "timing.sourceFrames")).toMatchObject({ value: "1762", note: "標頭未標示；這是實際解碼數" });
    expect(v("timing.intervals")).toBe("最小 33 · 中位 33 · 最大 1200 ms");
    expect(v("timing.gaps")).toBe("2 處：來源幀 1 @ 0.036 秒 +1200 ms；來源幀 116 @ 5.036 秒 +49 ms");
    expect(v("timing.cfr")).toBe("1797 幀 @ 30/1 · 補 35 個重複幀 · 丟 0 幀 · 36 段");
    expect(v("timing.keyframes")).toBe("18 個（平均 GOP 98 幀，最長 101 幀 / 4.53 秒）");
    expect(v("timing.start")).toBe("0.002 秒");
    expect(v("timing.timeBase")).toBe("1/1000");
    expect(rowOf(model, "timing.timecode").value).toBeNull();
  });

  it("音訊與引擎分析", () => {
    expect(v("audio.codec")).toBe("Opus");
    expect(v("audio.sampleRate")).toBe("48 kHz");
    expect(v("audio.channels")).toBe("2 聲道（立體聲）");
    expect(rowOf(model, "audio.sampleFmt")).toMatchObject({ value: "fltp", note: "32 位元浮點 · 平面" });
    expect(v("audio.delay")).toBe("−2 ms");
    expect(v("audio.proxy")).toBe("AAC");
    expect(v("engine.cache")).toBe("proxy ✓ · 索引 ✓ · 縮圖 ✓");
    expect(v("engine.proxy")).toBe("1280×720 · 1797 幀 @ 30/1 · h264_nvenc · GOP 15 · AAC · 38.5 MiB · 縮放 1");
    expect(v("engine.probeSource")).toBe("PyAV（解碼第一幀）");
    expect(v("engine.shots")).toBe("4 個（自動 3 · 手動 1）");
    expect(v("engine.cuts")).toBe("3 個切點，分數 0.3–0.36（門檻 0.2、最短 12 幀）");
    // 沒有外掛：「引擎」段最後一列是追蹤（牌格位 / 牌組那兩列是牌外掛加的）
    const engine = model.sections.find((s) => s.id === "engine")!;
    expect(engine.rows[engine.rows.length - 1].key).toBe("engine.tracks");
  });

  it("外掛的列接在「引擎」段最後；外掛的報告鍵接在 tracks 後面", () => {
    const extra = { key: "engine.plugin", label: "外掛", value: "1", source: "project" as const };
    const m2 = deriveMediaInfo(sampleInput({ project: { shots: SHOTS, tracks: [], loadedSolves: 0, extraRows: [extra], extraReport: { plugin: { n: 1 } } } }));
    const engine = m2.sections.find((s) => s.id === "engine")!;
    expect(engine.rows[engine.rows.length - 1]).toEqual(extra);
    const j = mediaInfoJson(sampleInput({ project: { shots: SHOTS, tracks: [], loadedSolves: 0, extraReport: { plugin: { n: 1 } } } }), m2, { name: "x", version: "0" }) as unknown as Record<string, unknown>;
    const keys = Object.keys(j);
    expect(keys.indexOf("plugin")).toBe(keys.indexOf("tracks") + 1);
    expect(j.plugin).toEqual({ n: 1 });
  });
});

describe("沒有值的列一律講原因", () => {
  const scenarios: [string, MediaInfoInput][] = [
    ["範例（全部資料）", sampleInput()],
    ["引擎還沒跑", sampleInput({ engineProbe: null, index: null, proxy: null, shots: null, cache: { proxy: false, index: false, thumbs: false, dir: "C:\\c" } })],
    ["讀取中", sampleInput({ engineProbe: null, index: null, proxy: null, shots: null, cache: null, loading: true })],
    ["檔案不見、也沒有存下來的 probe", sampleInput({ probe: null, probeFrom: null, probeError: "找不到檔案", engineProbe: null, index: null, proxy: null, shots: null, cache: null })],
    ["舊專案的 probe（沒有補充欄位）", sampleInput({ probe: oldProbe(), probeFrom: "stored", probeError: "找不到檔案" })],
    ["無音軌", sampleInput({ probe: { ...SAMPLE_PROBE, audio: null } })],
  ];
  it.each(scenarios)("%s", (_name, input) => {
    const model = deriveMediaInfo(input);
    for (const r of allRows(model)) {
      if (r.value == null) expect(r.note, r.key).toBeTruthy();
    }
    const keys = allRows(model).map((r) => r.key);
    expect(new Set(keys).size, "列的 key 不重複").toBe(keys.length);
  });

  it("引擎還沒跑：VFR 不猜、時長退不到索引", () => {
    const m = deriveMediaInfo(scenarios[1][1]);
    expect(m.derived.vfr).toBeNull();
    expect(m.chips).toEqual(["1280×720", "30p", "VP9", "Opus 2ch"]);
    expect(rowOf(m, "timing.mode")).toMatchObject({ value: null, note: "需要引擎索引（建 proxy 時產生）：容器標頭判斷不了 VFR" });
    expect(rowOf(m, "timing.measuredFps").note).toBe("引擎分析尚未執行：引擎就緒後建 proxy 時會產生");
    expect(m.derived.durationMs).toBeNull();
    // 引擎沒跑也要先講出「會用 BT.709」（同一條高度規則）
    expect(rowOf(m, "color.summary").value).toBe("BT.709 · 有限範圍（推定：未標示色彩）");
  });

  it("讀取中：引擎欄位說「讀取中」而不是「沒有」", () => {
    const m = deriveMediaInfo(scenarios[2][1]);
    expect(rowOf(m, "timing.cfr").note).toBe("讀取中…");
    expect(rowOf(m, "engine.cache").note).toBe("讀取中…");
  });

  it("舊專案 probe：補充欄位講「重新讀取才有」，不是「檔案沒有」", () => {
    const m = deriveMediaInfo(scenarios[4][1]);
    expect(rowOf(m, "video.fourcc").note).toBe("專案裡存的是舊版讀取結果，沒有這一欄；重新讀取影片後才有");
    expect(rowOf(m, "file.encoder").note).toBe("專案裡存的是舊版讀取結果，沒有這一欄；重新讀取影片後才有");
    expect(m.badges.map((b) => b.key)).toContain("probeError");
  });

  it("無音軌：一列說清楚並掛徽章", () => {
    const m = deriveMediaInfo(scenarios[5][1]);
    expect(m.sections.find((s) => s.id === "audio")!.rows).toEqual([expect.objectContaining({ key: "audio.none", value: "無音軌", warn: true })]);
    expect(m.badges.map((b) => b.key)).toContain("noAudio");
    expect(m.chips[m.chips.length - 1]).toBe("無音軌");
  });
});

function oldProbe(): MediaProbe {
  // v0.0.6 以前存進專案檔的形狀：沒有 format_long_name / codec_tag / profile… 這些鍵
  const v = SAMPLE_PROBE.video!;
  const a = SAMPLE_PROBE.audio!;
  return {
    path: SAMPLE_PROBE.path,
    size_bytes: SAMPLE_PROBE.size_bytes,
    duration_ms: 0,
    container: "matroska,webm",
    fingerprint: FP,
    audio: { codec: a.codec, sample_rate: a.sample_rate, channels: a.channels, bit_rate: null },
    video: {
      codec: v.codec,
      width: v.width,
      height: v.height,
      pix_fmt: v.pix_fmt,
      r_frame_rate: v.r_frame_rate,
      avg_frame_rate: v.avg_frame_rate,
      time_base: v.time_base,
      nb_frames: null,
      duration_ms: null,
      start_time_ms: 2,
      color_range: "tv",
      color_space: null,
      color_transfer: null,
      color_primaries: null,
      rotation: 0,
      has_b_frames: 0,
      bit_rate: null,
    },
  };
}

describe("CFR 的 H.264 mp4（專業欄位齊全）", () => {
  // 30 幀 @ 30000/1001、每 15 幀一個關鍵幀；CFR runs 一段 1:1
  const pts = Array.from({ length: 30 }, (_, k) => (k * 1001) / 30);
  const index = summarizeIndex({
    version: 1,
    fps: { num: 30000, den: 1001 },
    n: 30,
    pts_ms: pts,
    key: pts.map((_, k) => k % 15 === 0),
    time_base: { num: 1, den: 30000 },
    cfr: { version: 1, fps: { num: 30000, den: 1001 }, nFrames: 30, nSource: 30, runs: [[0, 0, 30]] },
  });
  const probe: MediaProbe = {
    ...SAMPLE_PROBE,
    path: "D:\\v\\rich.mp4",
    size_bytes: 858138,
    duration_ms: 1001,
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    format_long_name: "QuickTime / MOV",
    bit_rate: 6858245,
    creation_time: "2026-09-01T08:30:00.000000Z",
    encoder: "Lavf61.7.100",
    timecode: "01:00:00;00",
    video: {
      ...SAMPLE_PROBE.video!,
      codec: "h264",
      codec_long_name: "H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10",
      width: 1920,
      height: 1080,
      r_frame_rate: { num: 30000, den: 1001 },
      avg_frame_rate: { num: 30000, den: 1001 },
      time_base: { num: 1, den: 30000 },
      nb_frames: 30,
      duration_ms: 1001,
      start_time_ms: 0,
      color_space: "bt709",
      color_transfer: "bt709",
      color_primaries: "bt709",
      has_b_frames: 2,
      bit_rate: 6639816,
      profile: "High",
      level: 41,
      codec_tag: "avc1",
      bits_per_raw_sample: 8,
      field_order: "progressive",
      chroma_location: "left",
    },
    audio: { codec: "aac", sample_rate: 48000, channels: 2, bit_rate: 191185, codec_long_name: "AAC (Advanced Audio Coding)", profile: "LC", channel_layout: "stereo", sample_fmt: "fltp", bits_per_sample: null, duration_ms: 1000, start_time_ms: 0 },
  };
  const input = sampleInput({ probe, index, engineProbe: null, proxy: null, shots: null, media: { id: "m2", name: "rich.mp4", path: probe.path, fingerprint: FP } });
  const model = deriveMediaInfo(input);
  const v = (key: string) => rowOf(model, key).value;

  it("CFR 判定與表頭", () => {
    expect(model.derived.vfr).toBe(false);
    expect(model.derived.vfrReasons).toEqual([]);
    expect(v("timing.mode")).toBe("固定（CFR）：來源 30 幀與 30000/1001 proxy 一一對應");
    expect(model.chips).toEqual(["1920×1080", "29.97p", "H.264", "CFR", "AAC 2ch"]);
    expect(model.badges).toEqual([]);
    expect(rowOf(model, "timing.sourceFrames").note).toBe("與標頭一致");
  });

  it("容器與逐軌欄位直接用 ffprobe 的值", () => {
    expect(v("file.duration")).toBe("1.001 秒（00:00:01.001）");
    expect(rowOf(model, "file.duration").note).toBe("容器標頭");
    expect(v("file.bitrate")).toBe("6.86 Mb/s");
    expect(v("file.created")).toBe("2026-09-01 08:30:00 UTC");
    expect(v("video.profile")).toBe("High@L4.1");
    expect(v("video.fourcc")).toBe("avc1");
    expect(v("video.scan")).toBe("逐行（progressive）");
    expect(v("video.bframes")).toBe("有（重排深度 2）");
    expect(v("video.bitrate")).toBe("6.64 Mb/s");
    expect(rowOf(model, "video.depth")).toMatchObject({ value: "8 位元", source: "ffprobe" });
    expect(model.derived.bitsPerPixelBasis).toBe("video");
    expect(v("color.summary")).toBe("BT.709 · 有限範圍");
    expect(v("color.chromaLocation")).toBe("左（left，MPEG-2 / H.264 預設）");
    expect(v("timing.nominalFps")).toBe("29.97 fps（30000/1001）");
    expect(v("timing.timecode")).toBe("01:00:00;00");
    expect(v("audio.codec")).toBe("AAC LC");
    expect(v("audio.bitrate")).toBe("191 kb/s");
    expect(v("audio.delay")).toBe("0 ms");
  });

  it("檔案被換掉：指紋不同要標紅", () => {
    const m = deriveMediaInfo({ ...input, probe: { ...probe, fingerprint: "ff".repeat(32) } });
    expect(m.derived.fingerprintChanged).toBe(true);
    expect(m.badges.map((b) => b.key)).toContain("changed");
    expect(rowOf(m, "file.fingerprint").warn).toBe(true);
  });
});

describe("detectVfr", () => {
  it("沒有索引就不判斷", () => {
    expect(detectVfr(null, { num: 30, den: 1 })).toBeNull();
  });
  it("mediaChips 在沒有 probe 時退到 proxy 尺寸與 fps", () => {
    expect(mediaChips(null, null, parseProxyInfo(proxyJson))).toEqual(["1280×720", "30p"]);
  });
});

describe("匯出", () => {
  const input = sampleInput();
  const model = deriveMediaInfo(input);
  const app = { name: "AI Video Cut", version: "0.0.6" };

  it("文字：標籤補到同一個顯示寬度，冒號對齊", () => {
    const text = mediaInfoText(model, app);
    const lines = text.split("\n");
    expect(lines[0]).toBe("sample_clip1.webm");
    expect(lines[1]).toBe("1280×720 · 30p · VP9 · VFR→CFR · Opus 2ch");
    expect(text).toContain("可變（VFR）：來源 1762 幀");
    expect(lines[lines.length - 1]).toBe("由 AI Video Cut 0.0.6 產生");
    const width = displayWidth;
    const colons = lines.filter((l) => l.includes(": ") && /^[^\s]/.test(l) && !l.startsWith("sample")).map((l) => width(l.slice(0, l.indexOf(": "))));
    expect(colons.length).toBeGreaterThan(40);
    expect(new Set(colons)).toEqual(new Set([33]));
    // 沒有值的列：「—（原因）」
    expect(text).toMatch(/FourCC\s+: —（容器不用 FourCC/);
  });

  it("JSON：原始值 + 摘要，不含逐幀陣列", () => {
    const j = JSON.parse(JSON.stringify(mediaInfoJson(input, model, app)));
    expect(j.app).toEqual(app);
    expect(j.media.fingerprint).toBe(FP);
    expect(j.index.cfr).toEqual({ nFrames: 1797, duplicates: 35, dropped: 0, runs: 36 });
    expect(j.derived.vfr).toBe(true);
    expect(j.shots).toMatchObject({ count: 4, auto: 3, user: 1, params: { threshold: 0.2, minLen: 12 } });
    expect(j.probe.video.display_aspect_ratio).toEqual({ num: 16, den: 9 });
    const s = JSON.stringify(j);
    expect(s).not.toContain("pts_ms");
    expect(s).not.toContain('"key"');
  });
});

describe("英文目錄", () => {
  /** 原始碼裡的 t("字面量", …)：每一句都要在 en 目錄裡、而且 {佔位符} 要一模一樣（少一個就會把 {n} 原樣印出來）。 */
  function literals(src: string): string[] {
    return [...src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)+)"/g)].map((m) => m[1]);
  }
  const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it("每一句都有譯文且佔位符一致", () => {
    for (const zh of [...literals(mediaInfoSource), ...literals(mediaFormatSource)]) {
      const hit = en[zh];
      expect(hit, zh).toBeTypeOf("string");
      expect(holes(hit as string), zh).toEqual(holes(zh));
    }
  });

  it("切到英文：VFR 一句話與 bpp 讀起來像專業工具", () => {
    useLang.setState({ lang: "en", catalog: en });
    const m = deriveMediaInfo(sampleInput());
    expect(rowOf(m, "timing.mode").value).toBe("VFR: 1762 source frames, 35 duplicates / 0 dropped in 30/1 CFR proxy, largest gap 1200 ms at 0.036 s");
    expect(rowOf(m, "timing.keyframes").value).toBe("18 (avg GOP 98 frames, longest 101 frames / 4.53 s)");
    expect(rowOf(m, "color.summary").value).toBe("BT.709 limited range (assumed: tags missing)");
    expect(rowOf(m, "timing.nominalFps").value).toBe("30 fps (30/1)");
    expect(rowOf(m, "video.depth").value).toBe("8-bit");
    expect(rowOf(m, "file.size").value).toBe("21.7 MiB (22,768,280 bytes)");
  });
});
