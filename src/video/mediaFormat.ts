import type { Rational } from "../api";
import { t } from "../i18n";

/**
 * 媒體資訊的顯示格式：數字、單位、編碼 / 像素格式 / 色彩代碼 → 人話。
 *
 * - 數字格式刻意不用 toLocaleString：測試要可重現，複製出去貼到回報單也不該隨系統語系變。
 * - 含中文的字串一律直接寫在 t() 的第一個引數裡（這個檔不在 check-i18n 的 TABLE_SOURCES，字面量掃描才抓得到漏翻）；
 *   代碼名（BT.709、H.264、PQ）是業界通用寫法，不翻。
 */

/** 去掉小數尾巴的 0（"29.970" → "29.97"、"48.0" → "48"）。 */
export function fixed(n: number, digits: number): string {
  const s = n.toFixed(digits);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** 千分位（不跟系統語系走）。 */
export function groupThousands(n: number): string {
  const s = String(Math.round(Math.abs(n)));
  return `${n < 0 ? "-" : ""}${s.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/** 二進位單位的短寫（「38.5 MiB」）；1 KiB 以下回 null（由呼叫端決定怎麼講位元組）。 */
export function formatSize(n: number): string | null {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? null : `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

/** 二進位單位（MiB）並附精確位元組數：「21.7 MiB（22,768,280 位元組）」。 */
export function formatBytes(n: number): string {
  const size = formatSize(n);
  return size ? t("{size}（{bytes} 位元組）", { size, bytes: groupThousands(n) }) : t("{n} 位元組", { n: groupThousands(n) });
}

/** 十進位位元率（MediaInfo 慣例 kb/s = 1000 b/s）。 */
export function formatBitrate(bps: number): string {
  if (bps >= 1e6) return `${fixed(bps / 1e6, 2)} Mb/s`;
  if (bps >= 1e3) return `${fixed(bps / 1e3, bps >= 1e5 ? 0 : 1)} kb/s`;
  return `${Math.round(bps)} b/s`;
}

/** 「29.97 fps（30000/1001）」：小數給人看、分數給要對幀的人看（時間模型是有理數，決策 3）。 */
export function formatRationalFps(r: Rational): string {
  return t("{fps} fps（{ratio}）", { fps: fixed(r.num / r.den, 3), ratio: `${r.num}/${r.den}` });
}

export function formatSeconds(ms: number): string {
  return t("{s} 秒", { s: fixed(ms / 1000, 3) });
}

/** 00:00:59.916（時長用；和時間軸的幀 timecode 分開寫法，避免被當成幀號）。 */
export function formatHms(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const p2 = (x: number) => String(x).padStart(2, "0");
  return `${p2(h)}:${p2(m)}:${p2(s)}.${String(total % 1000).padStart(3, "0")}`;
}

/** ISO 8601 → 「2026-09-01 08:30:00 UTC」；看不懂就原樣（不轉時區：標籤寫什麼就是什麼）。 */
export function formatCreationTime(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(iso.trim());
  if (!m) return iso;
  return `${m[1]} ${m[2]}${m[3] === "Z" ? " UTC" : m[3] ? ` ${m[3]}` : ""}`;
}

// ---------------- 編碼

const CODEC_NAME: Record<string, string> = {
  h264: "H.264 / AVC",
  hevc: "H.265 / HEVC",
  vvc: "H.266 / VVC",
  vp8: "VP8",
  vp9: "VP9",
  av1: "AV1",
  prores: "Apple ProRes",
  dnxhd: "Avid DNxHD / DNxHR",
  cfhd: "GoPro CineForm",
  mpeg4: "MPEG-4 Part 2",
  mpeg2video: "MPEG-2 Video",
  mpeg1video: "MPEG-1 Video",
  mjpeg: "Motion JPEG",
  ffv1: "FFV1",
  utvideo: "Ut Video",
  qtrle: "QuickTime Animation",
  rawvideo: "Raw video",
  png: "PNG",
  theora: "Theora",
  vc1: "VC-1",
  wmv3: "Windows Media Video 9",
  aac: "AAC",
  opus: "Opus",
  vorbis: "Vorbis",
  mp3: "MP3",
  mp2: "MPEG Audio Layer II",
  ac3: "Dolby Digital (AC-3)",
  eac3: "Dolby Digital Plus (E-AC-3)",
  truehd: "Dolby TrueHD",
  dts: "DTS",
  flac: "FLAC",
  alac: "Apple Lossless (ALAC)",
};

const CODEC_SHORT: Record<string, string> = { h264: "H.264", hevc: "HEVC", vvc: "VVC", prores: "ProRes", dnxhd: "DNxHD", mpeg2video: "MPEG-2", mpeg4: "MPEG-4", mjpeg: "MJPEG", eac3: "E-AC-3", ac3: "AC-3" };

/** 完整名稱（「H.264 / AVC」）；PCM 依名字拆（pcm_s24le → PCM 24-bit signed LE）。 */
export function codecLabel(name: string | null | undefined): string {
  if (!name) return "—";
  const pcm = /^pcm_([suf])(\d+)(le|be)?(planar)?$/.exec(name);
  if (pcm) return `PCM ${pcm[2]}-bit ${pcm[1] === "f" ? "float" : pcm[1] === "u" ? "unsigned" : "signed"}${pcm[3] ? ` ${pcm[3].toUpperCase()}` : ""}`;
  return CODEC_NAME[name] ?? name.toUpperCase();
}

/** 晶片用的短名（「VP9」「H.264」）。 */
export function codecShort(name: string | null | undefined): string {
  if (!name) return "—";
  if (name.startsWith("pcm_")) return "PCM";
  return CODEC_SHORT[name] ?? CODEC_NAME[name] ?? name.toUpperCase();
}

/**
 * ffprobe 的 level 原始整數 → 人話。各編碼的編法不同：H.264 = 級×10（41 → 4.1；9 是 1b）、HEVC = 級×30（123 → 4.1）、
 * VP9 = 級×10、AV1 是 seq_level_idx（8 → 4.0；31 = 不限）、MPEG-2 是列舉。認不得的原樣回數字。
 */
export function levelLabel(codec: string | null | undefined, level: number | null | undefined): string | null {
  if (level == null || level < 0) return null;
  switch (codec) {
    case "h264":
      return level === 9 ? "1b" : fixed(level / 10, 1);
    case "hevc":
      return fixed(level / 30, 1);
    case "vp9":
      return fixed(level / 10, 1);
    case "av1":
      return level === 31 ? null : `${2 + (level >> 2)}.${level & 3}`;
    case "mpeg2video":
      return ({ 4: "High", 6: "High 1440", 8: "Main", 10: "Low" } as Record<number, string>)[level] ?? String(level);
    default:
      return String(level);
  }
}

// ---------------- 像素格式

export interface PixFmtInfo {
  model: "YUV" | "RGB" | "Gray" | "XYZ" | "Palette" | null;
  /** "4:2:0" / "4:2:2" / "4:4:4"…；灰階 "4:0:0"；看不出來 null。 */
  chroma: string | null;
  bitDepth: number | null;
  alpha: boolean;
  /** yuvj*：JPEG 全範圍（舊式寫法，色彩範圍由像素格式決定）。 */
  fullRange: boolean;
}

const CHROMA_DIGITS: Record<string, string> = { "420": "4:2:0", "422": "4:2:2", "444": "4:4:4", "440": "4:4:0", "411": "4:1:1", "410": "4:1:0" };

type PixRule = [RegExp, (m: RegExpExecArray) => Omit<PixFmtInfo, "alpha" | "fullRange"> & Partial<Pick<PixFmtInfo, "alpha" | "fullRange">>];

const YUV = (chroma: string, bitDepth: number, alpha = false) => ({ model: "YUV" as const, chroma, bitDepth, alpha });
const RGB = (bitDepth: number, alpha = false) => ({ model: "RGB" as const, chroma: "4:4:4", bitDepth, alpha });
const depthOr8 = (s: string | undefined) => (s ? Number(s) : 8);

/** ffmpeg pix_fmt 名的規則表（依 libavutil/pixfmt.h 的命名慣例；le / be 後綴不影響顯示）。 */
const PIX_RULES: PixRule[] = [
  [/^(yuv|yuvj|yuva)(420|422|444|440|411|410)p(\d+)?(le|be)?$/, (m) => ({ ...YUV(CHROMA_DIGITS[m[2]], depthOr8(m[3]), m[1] === "yuva"), fullRange: m[1] === "yuvj" })],
  [/^nv(12|21)$/, () => YUV("4:2:0", 8)],
  [/^nv(16|61)$/, () => YUV("4:2:2", 8)],
  [/^nv(24|42)$/, () => YUV("4:4:4", 8)],
  [/^nv20(le|be)?$/, () => YUV("4:2:2", 10)],
  [/^p([024])(10|12|16)(le|be)?$/, (m) => YUV(m[1] === "0" ? "4:2:0" : m[1] === "2" ? "4:2:2" : "4:4:4", Number(m[2]))],
  [/^(yuyv|uyvy|yvyu)422$/, () => YUV("4:2:2", 8)],
  [/^y2(10|12)(le|be)?$/, (m) => YUV("4:2:2", Number(m[1]))],
  [/^v210$/, () => YUV("4:2:2", 10)],
  [/^vuya$/, () => YUV("4:4:4", 8, true)],
  [/^vuyx$/, () => YUV("4:4:4", 8)],
  [/^ayuv64(le|be)?$/, () => YUV("4:4:4", 16, true)],
  [/^xv30(le|be)?$/, () => YUV("4:4:4", 10)],
  [/^xv36(le|be)?$/, () => YUV("4:4:4", 12)],
  [/^grayf32(le|be)?$/, () => ({ model: "Gray", chroma: "4:0:0", bitDepth: 32 })],
  [/^gray(\d+)?(le|be)?$/, (m) => ({ model: "Gray", chroma: "4:0:0", bitDepth: depthOr8(m[1]) })],
  [/^ya(8|16)(le|be)?$/, (m) => ({ model: "Gray", chroma: "4:0:0", bitDepth: Number(m[1]), alpha: true })],
  [/^gbr(a)?pf(16|32)(le|be)?$/, (m) => RGB(Number(m[2]), !!m[1])],
  [/^gbr(a)?p(\d+)?(le|be)?$/, (m) => RGB(depthOr8(m[2]), !!m[1])],
  [/^(rgb|bgr)(24|48)(le|be)?$/, (m) => RGB(m[2] === "24" ? 8 : 16)],
  [/^(rgba|bgra|argb|abgr)$/, () => RGB(8, true)],
  [/^(rgba|bgra)64(le|be)?$/, () => RGB(16, true)],
  [/^(rgb0|bgr0|0rgb|0bgr)$/, () => RGB(8)],
  [/^x2(rgb|bgr)10(le|be)?$/, () => RGB(10)],
  [/^xyz12(le|be)?$/, () => ({ model: "XYZ", chroma: "4:4:4", bitDepth: 12 })],
  [/^pal8$/, () => ({ model: "Palette", chroma: null, bitDepth: 8 })],
];

/** ffmpeg pix_fmt 名 → 色彩模型 / 色度取樣 / 位元深度（MediaInfo 的 Chroma subsampling、Bit depth 兩欄）。 */
export function pixFmtInfo(pix: string | null | undefined): PixFmtInfo | null {
  if (!pix) return null;
  const p = pix.toLowerCase();
  for (const [re, build] of PIX_RULES) {
    const m = re.exec(p);
    if (m) return { alpha: false, fullRange: false, ...build(m) };
  }
  // 認不得的格式：只從尾巴的位元數猜深度（9–16 才像位元深度，其他數字多半是別的意思）
  const tail = /(\d+)(le|be)$/.exec(p);
  const bits = tail ? Number(tail[1]) : null;
  return { model: null, chroma: null, bitDepth: bits != null && bits >= 9 && bits <= 16 ? bits : null, alpha: false, fullRange: false };
}

export function bitDepthLabel(bits: number): string {
  return t("{n} 位元", { n: bits });
}

// ---------------- 色彩

/** 色彩範圍：tv / pc 是 ffmpeg 的叫法，limited / full 是調色軟體的叫法，兩個都給。 */
export function colorRangeLabel(r: string | null | undefined): string | null {
  if (r === "tv") return t("有限範圍（tv，16–235）");
  if (r === "pc") return t("完整範圍（pc，0–255）");
  return r ?? null;
}

export function colorRangeShort(r: string | null | undefined): string {
  return r === "pc" ? t("完整範圍") : t("有限範圍");
}

const MATRIX_NAME: Record<string, string> = {
  bt709: "BT.709",
  bt470bg: "BT.601 (BT.470BG)",
  smpte170m: "BT.601 (SMPTE 170M)",
  bt601: "BT.601",
  fcc: "FCC",
  smpte240m: "SMPTE 240M",
  ycgco: "YCgCo",
  bt2020nc: "BT.2020 NCL",
  bt2020c: "BT.2020 CL",
  smpte2085: "SMPTE 2085",
  "chroma-derived-nc": "Chroma-derived NCL",
  "chroma-derived-c": "Chroma-derived CL",
  ictcp: "ICtCp",
  rgb: "RGB (GBR)",
};

const PRIMARIES_NAME: Record<string, string> = {
  bt709: "BT.709",
  bt470m: "BT.470 System M",
  bt470bg: "BT.601 PAL (BT.470BG)",
  smpte170m: "BT.601 NTSC (SMPTE 170M)",
  smpte240m: "SMPTE 240M",
  film: "Generic film",
  bt2020: "BT.2020",
  smpte428: "SMPTE ST 428 (XYZ)",
  smpte431: "DCI-P3 (SMPTE RP 431)",
  smpte432: "Display P3 (SMPTE EG 432)",
  "jedec-p22": "JEDEC P22",
};

const TRANSFER_NAME: Record<string, string> = {
  bt709: "BT.709",
  gamma22: "Gamma 2.2 (BT.470M)",
  gamma28: "Gamma 2.8 (BT.470BG)",
  smpte170m: "BT.601 (SMPTE 170M)",
  smpte240m: "SMPTE 240M",
  linear: "Linear",
  log100: "Log 100:1",
  log316: "Log 316:1",
  "iec61966-2-4": "xvYCC (IEC 61966-2-4)",
  bt1361e: "BT.1361",
  "iec61966-2-1": "sRGB (IEC 61966-2-1)",
  "bt2020-10": "BT.2020 10-bit",
  "bt2020-12": "BT.2020 12-bit",
  smpte2084: "PQ (SMPTE ST 2084)",
  smpte428: "SMPTE ST 428",
  "arib-std-b67": "HLG (ARIB STD-B67)",
};

export const matrixLabel = (v: string | null | undefined): string | null => (v ? MATRIX_NAME[v] ?? v : null);
export const primariesLabel = (v: string | null | undefined): string | null => (v ? PRIMARIES_NAME[v] ?? v : null);
export const transferLabel = (v: string | null | undefined): string | null => (v ? TRANSFER_NAME[v] ?? v : null);

export function isHdrTransfer(v: string | null | undefined): boolean {
  return v === "smpte2084" || v === "arib-std-b67";
}

export function chromaLocationLabel(v: string | null | undefined): string | null {
  switch (v) {
    case "left":
      return t("左（left，MPEG-2 / H.264 預設）");
    case "center":
      return t("中央（center，JPEG / MPEG-1）");
    case "topleft":
      return t("左上（topleft，BT.2020 / DCI）");
    case "top":
      return t("上（top）");
    case "bottomleft":
      return t("左下（bottomleft）");
    case "bottom":
      return t("下（bottom）");
    default:
      return v ?? null;
  }
}

export function fieldOrderLabel(v: string | null | undefined): string | null {
  switch (v) {
    case "progressive":
      return t("逐行（progressive）");
    case "tt":
      return t("交錯：上場優先（tt）");
    case "bb":
      return t("交錯：下場優先（bb）");
    case "tb":
      return t("交錯：上場編碼、下場先顯示（tb）");
    case "bt":
      return t("交錯：下場編碼、上場先顯示（bt）");
    default:
      return v ?? null;
  }
}

/** 只有逐行模式的編碼：ffprobe 不回報 field_order 時可以直接說「逐行（推定）」而不是「—」。 */
export const PROGRESSIVE_ONLY_CODECS: ReadonlySet<string> = new Set(["vp8", "vp9", "av1", "theora", "png"]);

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : Math.abs(a);
}

/** 1280×720 → "16:9"；約不乾淨（1366×768 → 683:384）時改給小數比 "1.779:1"。 */
export function reducedRatio(w: number, h: number): string {
  if (w <= 0 || h <= 0) return "—";
  const g = gcd(w, h);
  const a = w / g;
  const b = h / g;
  return a <= 64 && b <= 64 ? `${a}:${b}` : `${fixed(w / h, 3)}:1`;
}

// ---------------- 音訊

/** 取樣格式 → 「32 位元浮點 · 平面」。 */
export function sampleFmtLabel(v: string | null | undefined): string | null {
  if (!v) return null;
  // 結尾 p = planar（fltp / s16p / dblp）；沒有任何非平面格式的名字以 p 結尾
  const planar = v.length > 1 && v.endsWith("p");
  const base = planar ? v.slice(0, -1) : v;
  const int = (bits: number) => t("{n} 位元整數", { n: bits });
  const float = (bits: number) => t("{n} 位元浮點", { n: bits });
  const desc = ({ u8: int(8), s16: int(16), s32: int(32), s64: int(64), flt: float(32), dbl: float(64) } as Record<string, string>)[base];
  if (!desc) return v;
  return planar ? `${desc} · ${t("平面")}` : desc;
}

export function channelsLabel(channels: number, layout: string | null | undefined): string {
  const name = layout === "mono" ? t("單聲道") : layout === "stereo" ? t("立體聲") : layout;
  return name ? t("{n} 聲道（{layout}）", { n: channels, layout: name }) : t("{n} 聲道", { n: channels });
}

// ---------------- 文字匯出對齊

const WIDE_RANGES: readonly [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
];

/** 顯示寬度：CJK / 全形算 2（等寬字型下對齊標籤用）。 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w += WIDE_RANGES.some(([lo, hi]) => c >= lo && c <= hi) ? 2 : 1;
  }
  return w;
}

export function padDisplay(s: string, width: number): string {
  return s + " ".repeat(Math.max(1, width - displayWidth(s)));
}
