import { describe, expect, it } from "vitest";
import {
  channelsLabel,
  chromaLocationLabel,
  codecLabel,
  codecShort,
  colorRangeLabel,
  displayWidth,
  fieldOrderLabel,
  fixed,
  formatBitrate,
  formatBytes,
  formatCreationTime,
  formatHms,
  formatRationalFps,
  formatSeconds,
  formatSize,
  groupThousands,
  isHdrTransfer,
  levelLabel,
  matrixLabel,
  padDisplay,
  pixFmtInfo,
  primariesLabel,
  reducedRatio,
  sampleFmtLabel,
  transferLabel,
} from "./mediaFormat";

// 測試跑在 zh-TW（沒有載入 en 目錄）：t() 回原文，所以這裡比對的是 zh key 本身

describe("數字與單位", () => {
  it("fixed 去尾零、千分位不跟語系", () => {
    expect([fixed(29.970029, 3), fixed(48, 1), fixed(0.10995, 3), fixed(1, 4)]).toEqual(["29.97", "48", "0.11", "1"]);
    expect([groupThousands(22768280), groupThousands(999), groupThousands(-1234567)]).toEqual(["22,768,280", "999", "-1,234,567"]);
  });

  it("檔案大小用 MiB 並附精確位元組", () => {
    expect(formatBytes(22768280)).toBe("21.7 MiB（22,768,280 位元組）");
    expect(formatSize(40388558)).toBe("38.5 MiB");
    expect(formatSize(5 * 1024 ** 3)).toBe("5.0 GiB");
    expect(formatSize(512)).toBeNull();
    expect(formatBytes(512)).toBe("512 位元組");
  });

  it("位元率十進位（kb/s = 1000 b/s，MediaInfo 慣例）", () => {
    expect(formatBitrate(3040026.7)).toBe("3.04 Mb/s");
    expect(formatBitrate(6639816)).toBe("6.64 Mb/s");
    expect(formatBitrate(191185)).toBe("191 kb/s");
    expect(formatBitrate(64000)).toBe("64 kb/s");
    expect(formatBitrate(31)).toBe("31 b/s");
  });

  it("幀率同時給小數與分數", () => {
    expect(formatRationalFps({ num: 30000, den: 1001 })).toBe("29.97 fps（30000/1001）");
    expect(formatRationalFps({ num: 24000, den: 1001 })).toBe("23.976 fps（24000/1001）");
    expect(formatRationalFps({ num: 30, den: 1 })).toBe("30 fps（30/1）");
  });

  it("時長與建立時間", () => {
    expect(formatSeconds(59916)).toBe("59.916 秒");
    expect(formatHms(59916)).toBe("00:00:59.916");
    expect(formatHms(3723500)).toBe("01:02:03.500");
    expect(formatCreationTime("2026-09-01T08:30:00.000000Z")).toBe("2026-09-01 08:30:00 UTC");
    expect(formatCreationTime("2026-09-01T08:30:00+08:00")).toBe("2026-09-01 08:30:00 +08:00");
    expect(formatCreationTime("yesterday")).toBe("yesterday");
  });
});

describe("編碼名與等級", () => {
  it("完整名 / 短名 / PCM 拆解", () => {
    expect([codecLabel("h264"), codecLabel("vp9"), codecLabel("opus"), codecLabel("weirdcodec"), codecLabel(null)]).toEqual(["H.264 / AVC", "VP9", "Opus", "WEIRDCODEC", "—"]);
    expect(codecLabel("pcm_s24le")).toBe("PCM 24-bit signed LE");
    expect(codecLabel("pcm_f32be")).toBe("PCM 32-bit float BE");
    expect([codecShort("h264"), codecShort("hevc"), codecShort("vp9"), codecShort("pcm_s16le"), codecShort("aac")]).toEqual(["H.264", "HEVC", "VP9", "PCM", "AAC"]);
  });

  it("level 依編碼換算：H.264 ×10、HEVC ×30、AV1 seq_level_idx", () => {
    expect([levelLabel("h264", 41), levelLabel("h264", 40), levelLabel("h264", 9)]).toEqual(["4.1", "4", "1b"]);
    expect([levelLabel("hevc", 123), levelLabel("hevc", 150), levelLabel("hevc", 186)]).toEqual(["4.1", "5", "6.2"]);
    expect([levelLabel("av1", 8), levelLabel("av1", 13), levelLabel("av1", 31)]).toEqual(["4.0", "5.1", null]);
    expect([levelLabel("vp9", 31), levelLabel("vp9", -99), levelLabel("vp9", null)]).toEqual(["3.1", null, null]);
    expect([levelLabel("mpeg2video", 8), levelLabel("prores", 3)]).toEqual(["Main", "3"]);
  });
});

describe("像素格式", () => {
  it("YUV 各種寫法", () => {
    expect(pixFmtInfo("yuv420p")).toEqual({ model: "YUV", chroma: "4:2:0", bitDepth: 8, alpha: false, fullRange: false });
    expect(pixFmtInfo("yuv420p10le")).toMatchObject({ chroma: "4:2:0", bitDepth: 10 });
    expect(pixFmtInfo("yuv422p12be")).toMatchObject({ chroma: "4:2:2", bitDepth: 12 });
    expect(pixFmtInfo("yuvj420p")).toMatchObject({ chroma: "4:2:0", bitDepth: 8, fullRange: true });
    expect(pixFmtInfo("yuva444p16le")).toMatchObject({ chroma: "4:4:4", bitDepth: 16, alpha: true });
    expect(pixFmtInfo("nv12")).toMatchObject({ chroma: "4:2:0", bitDepth: 8 });
    expect(pixFmtInfo("p010le")).toMatchObject({ chroma: "4:2:0", bitDepth: 10 });
    expect(pixFmtInfo("p216le")).toMatchObject({ chroma: "4:2:2", bitDepth: 16 });
    expect(pixFmtInfo("v210")).toMatchObject({ chroma: "4:2:2", bitDepth: 10 });
    expect(pixFmtInfo("uyvy422")).toMatchObject({ chroma: "4:2:2", bitDepth: 8 });
  });

  it("RGB / 灰階 / 其他", () => {
    expect(pixFmtInfo("gbrp12le")).toMatchObject({ model: "RGB", chroma: "4:4:4", bitDepth: 12, alpha: false });
    expect(pixFmtInfo("gbrap")).toMatchObject({ model: "RGB", bitDepth: 8, alpha: true });
    expect(pixFmtInfo("rgba")).toMatchObject({ model: "RGB", bitDepth: 8, alpha: true });
    expect(pixFmtInfo("rgb48le")).toMatchObject({ model: "RGB", bitDepth: 16 });
    expect(pixFmtInfo("gray16le")).toMatchObject({ model: "Gray", chroma: "4:0:0", bitDepth: 16 });
    expect(pixFmtInfo("grayf32le")).toMatchObject({ model: "Gray", bitDepth: 32 });
    expect(pixFmtInfo("xyz12le")).toMatchObject({ model: "XYZ", bitDepth: 12 });
    expect(pixFmtInfo("pal8")).toMatchObject({ model: "Palette", chroma: null, bitDepth: 8 });
    // 認不得：只從尾巴猜 9–16 位元
    expect(pixFmtInfo("bayer_rggb16le")).toMatchObject({ model: null, chroma: null, bitDepth: 16 });
    expect(pixFmtInfo("bayer_rggb8")).toMatchObject({ model: null, bitDepth: null });
    expect(pixFmtInfo("")).toBeNull();
  });
});

describe("色彩代碼", () => {
  it("範圍兩種叫法都給、矩陣 / 原色 / 傳遞函數用業界名", () => {
    expect([colorRangeLabel("tv"), colorRangeLabel("pc"), colorRangeLabel(null)]).toEqual(["有限範圍（tv，16–235）", "完整範圍（pc，0–255）", null]);
    expect([matrixLabel("bt709"), matrixLabel("smpte170m"), matrixLabel("bt2020nc"), matrixLabel("new-thing"), matrixLabel(null)]).toEqual(["BT.709", "BT.601 (SMPTE 170M)", "BT.2020 NCL", "new-thing", null]);
    expect([primariesLabel("smpte432"), transferLabel("smpte2084"), transferLabel("arib-std-b67"), transferLabel("iec61966-2-1")]).toEqual(["Display P3 (SMPTE EG 432)", "PQ (SMPTE ST 2084)", "HLG (ARIB STD-B67)", "sRGB (IEC 61966-2-1)"]);
    expect([isHdrTransfer("smpte2084"), isHdrTransfer("arib-std-b67"), isHdrTransfer("bt709"), isHdrTransfer(null)]).toEqual([true, true, false, false]);
  });

  it("色度位置與掃描方式", () => {
    expect(chromaLocationLabel("left")).toBe("左（left，MPEG-2 / H.264 預設）");
    expect(chromaLocationLabel("unknown-x")).toBe("unknown-x");
    expect([fieldOrderLabel("progressive"), fieldOrderLabel("tt"), fieldOrderLabel(null)]).toEqual(["逐行（progressive）", "交錯：上場優先（tt）", null]);
  });

  it("顯示比例約分；約不乾淨時給小數比", () => {
    expect([reducedRatio(1280, 720), reducedRatio(720, 480), reducedRatio(1920, 1080)]).toEqual(["16:9", "3:2", "16:9"]);
    expect([reducedRatio(1366, 768), reducedRatio(4096, 2160), reducedRatio(0, 10)]).toEqual(["1.779:1", "1.896:1", "—"]);
  });
});

describe("音訊與文字對齊", () => {
  it("取樣格式與聲道", () => {
    expect([sampleFmtLabel("fltp"), sampleFmtLabel("s16"), sampleFmtLabel("dblp"), sampleFmtLabel("weird"), sampleFmtLabel(null)]).toEqual(["32 位元浮點 · 平面", "16 位元整數", "64 位元浮點 · 平面", "weird", null]);
    expect([channelsLabel(2, "stereo"), channelsLabel(1, "mono"), channelsLabel(6, "5.1(side)"), channelsLabel(2, null)]).toEqual(["2 聲道（立體聲）", "1 聲道（單聲道）", "6 聲道（5.1(side)）", "2 聲道"]);
  });

  it("CJK 算兩格寬，補空白後冒號對齊", () => {
    expect([displayWidth("檔案大小"), displayWidth("FourCC"), displayWidth("B 幀")]).toEqual([8, 6, 4]);
    expect(displayWidth(padDisplay("檔案大小", 12))).toBe(12);
    expect(displayWidth(padDisplay("FourCC", 12))).toBe(12);
    // 標籤比欄寬還長時至少留一格
    expect(padDisplay("很長很長很長的標籤", 4).endsWith(" ")).toBe(true);
  });
});
