import type { AudioStream, CacheStatus, MediaProbe, Rational, VideoStream } from "../api";
import { t } from "../i18n";
import type { ShotV1, TrackV1 } from "../project/format";
import type { EngineProbe, IndexSummary, ProxyInfo, ShotsInfo } from "./mediaCache";
import {
  bitDepthLabel,
  channelsLabel,
  chromaLocationLabel,
  codecLabel,
  codecShort,
  colorRangeLabel,
  colorRangeShort,
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
  isHdrTransfer,
  levelLabel,
  matrixLabel,
  padDisplay,
  pixFmtInfo,
  primariesLabel,
  PROGRESSIVE_ONLY_CODECS,
  reducedRatio,
  sampleFmtLabel,
  transferLabel,
} from "./mediaFormat";

/**
 * 「媒體資訊」的組裝層（計畫 M1 §3）：Rust ffprobe（`MediaProbe`）+ 引擎快取摘要（mediaCache.ts）+ 專案狀態
 * → 區塊（檔案 / 視訊 / 色彩 / 時間 / 音訊 / 引擎分析）→ 列，再輸出成文字（MediaInfo 風格）與 JSON。
 * 對話框只負責讀檔與畫，數字全在這裡算、這裡測。
 *
 * 為什麼要自己掃 index.v1.json 而不是信容器標頭：範例 WebM 沒有時長、沒有 nb_frames、avg_frame_rate 是 0/0，
 * MediaInfo 判斷 VFR 又只看檔頭幾十幀；我們的索引是整支解碼一趟的真實時間戳，是能講清楚「為什麼是 1797 幀」的唯一來源。
 *
 * 每一列沒有值時都要帶「為什麼沒有」（`note`）：專業使用者看到「—」第一個問題就是「是檔案沒有、還是程式沒讀」。
 */

// ============================================================ VFR 判斷

export type VfrReason =
  | { code: "gap"; maxMs: number; medianMs: number }
  | { code: "duplicates"; n: number }
  | { code: "dropped"; n: number }
  | { code: "rate"; measured: number; nominal: number; pct: number };

/**
 * 依整支索引判斷 VFR。任一成立就是 VFR：最大間隔 > 1.5 × 中位、CFR 對應有重複或丟幀、實測與標稱相差 > 0.5%。
 * 沒有索引回 null（容器標頭判斷不了；MediaInfo 看檔頭幾十幀常常判錯，我們不跟著猜）。
 */
export function detectVfr(index: IndexSummary | null, nominal: Rational | null): { vfr: boolean; reasons: VfrReason[] } | null {
  if (!index) return null;
  const reasons: VfrReason[] = [];
  const g = index.gaps;
  if (g && g.medianMs > 0 && g.maxMs > 1.5 * g.medianMs) reasons.push({ code: "gap", maxMs: g.maxMs, medianMs: g.medianMs });
  if (index.cfr?.duplicates) reasons.push({ code: "duplicates", n: index.cfr.duplicates });
  if (index.cfr?.dropped) reasons.push({ code: "dropped", n: index.cfr.dropped });
  if (nominal && index.measuredFps != null) {
    const nom = nominal.num / nominal.den;
    const pct = (Math.abs(index.measuredFps - nom) / nom) * 100;
    if (pct > 0.5) reasons.push({ code: "rate", measured: index.measuredFps, nominal: nom, pct });
  }
  return { vfr: reasons.length > 0, reasons };
}

export function vfrReasonText(r: VfrReason): string {
  switch (r.code) {
    case "gap":
      return t("最大間隔 {max} ms 超過中位 {median} ms 的 1.5 倍", { max: fixed(r.maxMs, 1), median: fixed(r.medianMs, 1) });
    case "duplicates":
      return t("CFR 對應補了 {n} 個重複幀", { n: r.n });
    case "dropped":
      return t("CFR 對應丟了 {n} 個來源幀", { n: r.n });
    case "rate":
      return t("實測 {measured} fps 與標稱 {nominal} fps 相差 {pct}%", { measured: fixed(r.measured, 2), nominal: fixed(r.nominal, 3), pct: fixed(r.pct, 2) });
  }
}

// ============================================================ 型別

export type InfoSectionId = "file" | "video" | "color" | "timing" | "audio" | "engine";

/** 這一列的值從哪裡來（畫面上小字標出來：「容器標示」和「解碼第一幀」不一致時，使用者要知道該信哪個）。 */
export type InfoSource = "ffprobe" | "engine" | "index" | "proxy" | "shots" | "project" | "derived" | "cache";

export interface InfoRow {
  /** 穩定 id（"video.codec"）：React key、測試、文件對照都用它。 */
  key: string;
  label: string;
  /** null = 沒有這個值；畫面顯示「—」，`note` 是原因（tooltip）。 */
  value: string | null;
  /** value 有值時是補充說明（小字）；value 為 null 時是「為什麼沒有」。 */
  note?: string;
  source?: InfoSource;
  warn?: boolean;
  mono?: boolean;
}

export interface InfoSection {
  id: InfoSectionId;
  title: string;
  rows: InfoRow[];
}

export interface InfoBadge {
  key: "vfr" | "untagged" | "hdr" | "noAudio" | "rotation" | "changed" | "probeError";
  tone: "warning" | "danger" | "info" | "neutral";
  label: string;
  title?: string;
}

export interface DerivedFacts {
  durationMs: number | null;
  durationSource: "container" | "videoStream" | "index" | "proxy" | null;
  overallBitrate: number | null;
  overallBitrateEstimated: boolean;
  nominalFps: Rational | null;
  measuredFps: number | null;
  vfr: boolean | null;
  vfrReasons: VfrReason[];
  bitsPerPixel: number | null;
  bitsPerPixelBasis: "video" | "overall" | null;
  /** 矩陣係數有沒有標示（容器或位元流任一）；沒有任何視訊資訊 → null。 */
  colorTagged: boolean | null;
  hdr: boolean;
  /** 重新 ffprobe 得到的指紋和專案記的不同：檔案在加入專案後被換掉 / 改過。 */
  fingerprintChanged: boolean;
}

export interface MediaInfoInput {
  media: { id: string; name: string; path: string; fingerprint: string };
  probe: MediaProbe | null;
  /** live = 剛剛重新 ffprobe；stored = 專案檔裡開檔當下存的（舊專案沒有補充欄位）。 */
  probeFrom: "live" | "stored" | null;
  /** 重新 ffprobe 失敗的原因（檔案被移走、改名、非 Tauri 環境）。 */
  probeError?: string | null;
  engineProbe: EngineProbe | null;
  index: IndexSummary | null;
  proxy: ProxyInfo | null;
  shots: ShotsInfo | null;
  cache: CacheStatus | null;
  /** 還在讀快取：引擎欄位顯示「讀取中」而不是「沒有」。 */
  loading?: boolean;
  project: {
    shots: ShotV1[];
    tracks: TrackV1[];
    /** 外掛追加在「引擎」段最後的列（例如 cards 的牌格位 / 牌組；plugins/api.ts MediaInfoContribution.rows）。 */
    extraRows?: InfoRow[];
    /** 外掛追加在「複製報告」JSON（tracks 後面）的鍵。 */
    extraReport?: Record<string, unknown>;
    /** 已載入記憶體的解（`useSolves`）有幾條屬於這支媒體。 */
    loadedSolves: number;
  };
}

export interface MediaInfoModel {
  title: string;
  chips: string[];
  badges: InfoBadge[];
  sections: InfoSection[];
  derived: DerivedFacts;
}

export function sourceLabel(s: InfoSource): string {
  switch (s) {
    case "ffprobe":
      return "ffprobe";
    case "engine":
      return t("引擎 probe");
    case "index":
      return t("索引");
    case "proxy":
      return "proxy";
    case "shots":
      return t("鏡頭偵測");
    case "project":
      return t("專案");
    case "derived":
      return t("推算");
    case "cache":
      return t("快取");
  }
}

// ============================================================ 推算

function nominalFpsOf(v: VideoStream | null, ep: EngineProbe | null): Rational | null {
  return v && v.r_frame_rate.num > 0 && v.r_frame_rate.den > 0 ? v.r_frame_rate : ep?.fps ?? null;
}

/** 時長來源優先序同 MediaInfo：容器標頭 → 視訊軌標頭 → 我們的索引 → proxy 幀數。 */
function durationOf(input: MediaInfoInput): Pick<DerivedFacts, "durationMs" | "durationSource"> {
  const { probe, index, proxy } = input;
  if (probe && probe.duration_ms > 0) return { durationMs: probe.duration_ms, durationSource: "container" };
  if (probe?.video?.duration_ms) return { durationMs: probe.video.duration_ms, durationSource: "videoStream" };
  if (index) return { durationMs: index.durationMs, durationSource: "index" };
  if (proxy?.frames && proxy.fps) return { durationMs: (proxy.frames * 1000 * proxy.fps.den) / proxy.fps.num, durationSource: "proxy" };
  return { durationMs: null, durationSource: null };
}

export function deriveFacts(input: MediaInfoInput): DerivedFacts {
  const { probe, index, engineProbe: ep } = input;
  const v = probe?.video ?? null;
  const nominalFps = nominalFpsOf(v, ep);
  const { durationMs, durationSource } = durationOf(input);

  // 容器沒標整體位元率時用 大小 ÷ 時長 估（含音訊與容器開銷，畫面上標「估計」）
  const estimate = probe?.bit_rate == null && !!probe && probe.size_bytes > 0 && !!durationMs;
  const overallBitrate = probe?.bit_rate ?? (estimate && probe && durationMs ? (probe.size_bytes * 8 * 1000) / durationMs : null);

  const vfr = detectVfr(index, nominalFps);
  const measuredFps = index?.measuredFps ?? null;

  // Bits/(Pixel×Frame)：有逐軌視訊位元率用它，沒有就用整體位元率（估計，含音訊）；fps 優先用實測（VFR 片的標稱 30 會高估分母）
  const fps = measuredFps ?? (nominalFps ? nominalFps.num / nominalFps.den : null);
  const w = v?.width ?? ep?.width ?? 0;
  const h = v?.height ?? ep?.height ?? 0;
  const basis = v?.bit_rate ?? overallBitrate;
  const bpp = basis && fps && w > 0 && h > 0 ? basis / (w * h * fps) : null;

  return {
    durationMs,
    durationSource,
    overallBitrate,
    overallBitrateEstimated: estimate,
    nominalFps,
    measuredFps,
    vfr: vfr ? vfr.vfr : null,
    vfrReasons: vfr?.reasons ?? [],
    bitsPerPixel: bpp,
    bitsPerPixelBasis: bpp == null ? null : v?.bit_rate ? "video" : "overall",
    colorTagged: v || ep ? !!(v?.color_space || ep?.colorSpace) : null,
    hdr: isHdrTransfer(v?.color_transfer) || isHdrTransfer(ep?.colorTrc),
    fingerprintChanged: input.probeFrom === "live" && !!probe?.fingerprint && !!input.media.fingerprint && probe.fingerprint !== input.media.fingerprint,
  };
}

/** 標頭列的晶片：「1280×720 · 30p · VP9 · VFR→CFR · Opus 2ch」。傳輸列的資訊晶片也可以直接用。 */
export function mediaChips(probe: MediaProbe | null, vfr: boolean | null, proxy?: ProxyInfo | null): string[] {
  const chips: string[] = [];
  const v = probe?.video ?? null;
  const w = v?.width || proxy?.width;
  const h = v?.height || proxy?.height;
  if (w && h) chips.push(`${w}×${h}`);
  const fps = v && v.r_frame_rate.num > 0 ? v.r_frame_rate : proxy?.fps ?? null;
  if (fps) chips.push(`${fixed(fps.num / fps.den, 3)}${v?.field_order && v.field_order !== "progressive" ? "i" : "p"}`);
  if (v) chips.push(codecShort(v.codec));
  if (vfr != null) chips.push(vfr ? "VFR→CFR" : "CFR");
  if (probe) chips.push(probe.audio ? `${codecShort(probe.audio.codec)} ${probe.audio.channels}ch` : t("無音軌"));
  return chips;
}

// ============================================================ 各區塊

/** 各區塊共用的前後文與「為什麼沒有」的說法。 */
interface Ctx {
  input: MediaInfoInput;
  d: DerivedFacts;
  v: VideoStream | null;
  a: AudioStream | null;
  ep: EngineProbe | null;
  loading: boolean;
  /** 補充欄位（ffmpeg.rs 後來才加）在舊專案的 probe 裡是 undefined：講清楚是「沒讀過」不是「檔案沒有」。 */
  extraWhy: (present: unknown, why: string) => string;
  noProbeWhy: string;
  engineWhy: string;
}

function makeCtx(input: MediaInfoInput, d: DerivedFacts): Ctx {
  const stored = input.probeFrom === "stored";
  const loading = !!input.loading;
  return {
    input,
    d,
    v: input.probe?.video ?? null,
    a: input.probe?.audio ?? null,
    ep: input.engineProbe,
    loading,
    // 開窗當下先用存的舊 probe 畫、重新 ffprobe 還在跑：這時講「讀取中」，跑完（或失敗）才講「舊版沒有這一欄」
    extraWhy: (present, why) => (present === undefined && stored ? (loading ? t("讀取中…") : t("專案裡存的是舊版讀取結果，沒有這一欄；重新讀取影片後才有")) : why),
    noProbeWhy: input.probeError ? t("讀不到影片資訊：{err}", { err: input.probeError }) : t("還沒有讀取影片資訊"),
    engineWhy: loading ? t("讀取中…") : t("引擎分析尚未執行：引擎就緒後建 proxy 時會產生"),
  };
}

function durationNote(c: Ctx): string {
  switch (c.d.durationSource) {
    case "container":
      return t("容器標頭");
    case "videoStream":
      return t("視訊軌標頭");
    case "index":
      return t("依時間戳：最後 − 第一 + 中位間隔（容器未標示）");
    case "proxy":
      return t("依 proxy 幀數 ÷ fps（容器未標示、還沒有索引）");
    default:
      return c.input.probe ? c.engineWhy : c.noProbeWhy;
  }
}

function fileRows(c: Ctx): InfoRow[] {
  const { input, d } = c;
  const probe = input.probe;
  const rows: InfoRow[] = [
    { key: "file.name", label: t("名稱"), value: input.media.name, source: "project" },
    { key: "file.path", label: t("路徑"), value: input.media.path, source: "project", mono: true },
  ];
  if (probe) {
    const long = probe.format_long_name;
    rows.push({ key: "file.container", label: t("容器"), value: long ? `${long}（${probe.container}）` : probe.container || null, note: long ? undefined : c.extraWhy(long, t("ffprobe 沒有回報容器全名")), source: "ffprobe" });
    rows.push({ key: "file.size", label: t("檔案大小"), value: formatBytes(probe.size_bytes), source: "ffprobe" });
  } else {
    rows.push({ key: "file.container", label: t("容器"), value: null, note: c.noProbeWhy });
    rows.push({ key: "file.size", label: t("檔案大小"), value: null, note: c.noProbeWhy });
  }
  rows.push({
    key: "file.duration",
    label: t("時長"),
    value: d.durationMs != null ? `${formatSeconds(d.durationMs)}（${formatHms(d.durationMs)}）` : null,
    note: durationNote(c),
    source: d.durationSource === "index" ? "index" : d.durationSource === "proxy" ? "proxy" : d.durationSource ? "ffprobe" : undefined,
  });
  rows.push({
    key: "file.bitrate",
    label: t("整體位元率"),
    value: d.overallBitrate != null ? formatBitrate(d.overallBitrate) : null,
    note: d.overallBitrate == null ? (probe ? t("容器沒有標示，也還算不出時長") : c.noProbeWhy) : d.overallBitrateEstimated ? t("估計：檔案大小 ÷ 時長，含音訊與容器開銷") : undefined,
    source: d.overallBitrateEstimated ? "derived" : "ffprobe",
  });
  rows.push({
    key: "file.created",
    label: t("建立時間"),
    value: probe?.creation_time ? formatCreationTime(probe.creation_time) : null,
    note: probe?.creation_time ? undefined : probe ? c.extraWhy(probe.creation_time, t("檔案沒有 creation_time 標籤（螢幕錄影、網頁錄影常見）")) : c.noProbeWhy,
    source: "ffprobe",
  });
  rows.push({
    key: "file.encoder",
    label: t("寫檔程式"),
    value: probe?.encoder ?? null,
    note: probe?.encoder ? undefined : probe ? c.extraWhy(probe.encoder, t("檔案沒有 encoder 標籤")) : c.noProbeWhy,
    source: "ffprobe",
  });
  rows.push({
    key: "file.fingerprint",
    label: t("指紋"),
    value: input.media.fingerprint || null,
    note: d.fingerprintChanged ? t("重新讀取的指紋是 {fp}：檔案在加入專案後被改過", { fp: probe?.fingerprint ?? "" }) : input.media.fingerprint ? t("blake3（大小 + 首尾各 4 MiB）；前 16 碼是快取目錄名") : t("還沒有指紋"),
    source: "project",
    mono: true,
    warn: d.fingerprintChanged,
  });
  return rows;
}

function videoRows(c: Ctx): InfoRow[] {
  const { v, d } = c;
  if (!v) return [{ key: "video.none", label: t("視訊軌"), value: null, note: c.input.probe ? t("這個檔案沒有視訊軌") : c.noProbeWhy }];
  const level = levelLabel(v.codec, v.level);
  // MediaInfo 的寫法：High@L4.1
  const profileLevel = v.profile && level ? `${v.profile}@L${level}` : v.profile ? v.profile : level ? `L${level}` : null;
  const dar = v.display_aspect_ratio;
  const sar = v.sample_aspect_ratio;
  const pf = pixFmtInfo(v.pix_fmt);
  const depth = v.bits_per_raw_sample ?? pf?.bitDepth ?? null;
  const scan = fieldOrderLabel(v.field_order);
  const progressiveOnly = PROGRESSIVE_ONLY_CODECS.has(v.codec);
  const bppFps = d.measuredFps ?? (d.nominalFps ? d.nominalFps.num / d.nominalFps.den : 0);
  return [
    { key: "video.codec", label: t("編碼"), value: codecLabel(v.codec), note: v.codec_long_name && v.codec_long_name !== codecLabel(v.codec) ? v.codec_long_name : undefined, source: "ffprobe" },
    { key: "video.profile", label: t("設定檔 / 等級"), value: profileLevel, note: profileLevel ? undefined : c.extraWhy(v.profile, t("ffprobe 沒有回報")), source: "ffprobe" },
    { key: "video.fourcc", label: "FourCC", value: v.codec_tag ?? null, note: v.codec_tag ? undefined : c.extraWhy(v.codec_tag, t("容器不用 FourCC（Matroska / WebM 用 CodecID）")), source: "ffprobe", mono: true },
    { key: "video.resolution", label: t("解析度"), value: v.width && v.height ? `${v.width} × ${v.height}` : null, note: v.width ? undefined : t("ffprobe 沒有回報"), source: "ffprobe" },
    {
      key: "video.aspect",
      label: t("顯示比例"),
      value: dar ? `${dar.num}:${dar.den} · ${fixed(dar.num / dar.den, 3)}` : v.width && v.height ? `${reducedRatio(v.width, v.height)} · ${fixed(v.width / v.height, 3)}` : null,
      note: sar
        ? sar.num === sar.den
          ? t("像素比 1:1（方形像素）")
          : t("像素比 {sar}（非方形像素：顯示時會拉伸）", { sar: `${sar.num}:${sar.den}` })
        : dar
          ? t("像素比未標示")
          : c.extraWhy(dar, t("由解析度推算，假設方形像素")),
      source: dar ? "ffprobe" : "derived",
      warn: !!sar && sar.num !== sar.den,
    },
    { key: "video.pixfmt", label: t("像素格式"), value: v.pix_fmt || null, note: pf?.alpha ? t("含 Alpha 通道") : pf?.fullRange ? t("yuvj：JPEG 全範圍") : undefined, source: "ffprobe", mono: true },
    {
      key: "video.chroma",
      label: t("色度取樣"),
      value: pf?.chroma ? (pf.model && pf.model !== "YUV" ? `${pf.model} ${pf.chroma}` : pf.chroma) : null,
      note: pf?.chroma ? undefined : t("看不出像素格式 {pix} 的色度取樣", { pix: v.pix_fmt || "—" }),
      source: "derived",
    },
    { key: "video.depth", label: t("位元深度"), value: depth ? bitDepthLabel(depth) : null, note: depth ? (v.bits_per_raw_sample ? undefined : t("由像素格式推得")) : t("ffprobe 沒有回報，像素格式也看不出來"), source: v.bits_per_raw_sample ? "ffprobe" : "derived" },
    {
      key: "video.scan",
      label: t("掃描方式"),
      value: scan ?? (progressiveOnly ? t("逐行") : null),
      note: scan ? undefined : progressiveOnly ? t("推定：{codec} 沒有交錯模式", { codec: codecShort(v.codec) }) : c.extraWhy(v.field_order, t("ffprobe 沒有回報掃描方式")),
      source: scan ? "ffprobe" : "derived",
      warn: !!v.field_order && v.field_order !== "progressive",
    },
    { key: "video.rotation", label: t("旋轉"), value: v.rotation ? `${v.rotation}°` : t("無（0°）"), note: v.rotation ? t("顯示矩陣：播放器會轉正顯示") : undefined, source: "ffprobe", warn: !!v.rotation },
    { key: "video.bframes", label: t("B 幀"), value: v.has_b_frames ? t("有（重排深度 {n}）", { n: v.has_b_frames }) : t("無"), source: "ffprobe" },
    { key: "video.bitrate", label: t("視訊位元率"), value: v.bit_rate ? formatBitrate(v.bit_rate) : null, note: v.bit_rate ? undefined : t("容器沒有逐軌位元率（WebM / Matroska 常見）；整體位元率見「檔案」"), source: "ffprobe" },
    {
      key: "video.bpp",
      label: t("每像素位元（Bits/(Pixel×Frame)）"),
      value: d.bitsPerPixel != null ? fixed(d.bitsPerPixel, 3) : null,
      note: d.bitsPerPixel == null ? t("需要位元率與幀率") : d.bitsPerPixelBasis === "video" ? t("視訊位元率 ÷（寬 × 高 × fps）") : t("估計：整體位元率（含音訊）÷（寬 × 高 × {fps} fps）", { fps: fixed(bppFps, 2) }),
      source: "derived",
    },
  ];
}

/** 容器 / 位元流兩個來源並列：VP9、H.264 的色彩資訊在位元流裡，開檔當下 codec context 常是 unspecified（probe.py 的註解）。 */
function dualColorRow(c: Ctx, key: string, label: string, fromProbe: string | null | undefined, fromEngine: string | null | undefined, fmt: (x: string | null | undefined) => string | null): InfoRow {
  const r = fmt(fromProbe);
  const e = fmt(fromEngine);
  if (!r && !e) return { key, label, value: null, note: c.ep || !c.loading ? t("容器與位元流都沒有標示") : t("容器沒有標示；位元流標籤讀取中…"), source: "ffprobe", warn: key === "color.matrix" };
  if (r && e && r !== e) return { key, label, value: t("容器：{a} · 位元流：{b}", { a: r, b: e }), note: t("兩者不一致：引擎以解碼出來的第一幀為準"), source: "engine", warn: true };
  if (r && e) return { key, label, value: r, note: t("容器與解碼第一幀一致"), source: "ffprobe" };
  if (e) return { key, label, value: e, note: t("只有位元流標示（解碼第一幀）"), source: "engine" };
  return { key, label, value: r, note: c.ep ? t("容器標示；解碼第一幀沒有標示") : undefined, source: "ffprobe" };
}

function colorRows(c: Ctx): InfoRow[] {
  const { v, ep, d } = c;
  if (!v && !ep) return [{ key: "color.none", label: t("色彩"), value: null, note: c.input.probe ? t("這個檔案沒有視訊軌") : c.noProbeWhy }];
  const matrixTag = v?.color_space ?? ep?.colorSpace ?? null;
  const rangeTag = v?.color_range ?? ep?.colorRange ?? null;
  const height = ep?.height ?? v?.height ?? 0;
  // 引擎還沒跑時用同一條規則（probe.py assumed_matrix：高 ≥ 576 當 BT.709）先講，引擎跑完以引擎為準
  const assumedKey = ep?.matrixAssumed ?? (matrixTag ? null : height >= 576 ? "bt709" : "bt601");
  const summaryMatrix = matrixLabel(matrixTag) ?? matrixLabel(assumedKey);
  const rows: InfoRow[] = [
    {
      key: "color.summary",
      label: t("色彩"),
      value: summaryMatrix
        ? matrixTag
          ? t("{matrix} · {range}", { matrix: summaryMatrix, range: colorRangeShort(rangeTag) })
          : t("{matrix} · {range}（推定：未標示色彩）", { matrix: summaryMatrix, range: colorRangeShort(rangeTag) })
        : null,
      note: summaryMatrix ? (d.hdr ? t("HDR 來源：v1 以 BT.709 近似") : undefined) : t("沒有足夠資訊判斷"),
      source: matrixTag ? "ffprobe" : "derived",
      warn: !matrixTag || d.hdr,
    },
    dualColorRow(c, "color.range", t("範圍"), v?.color_range, ep?.colorRange, colorRangeLabel),
    dualColorRow(c, "color.matrix", t("矩陣係數"), v?.color_space, ep?.colorSpace, matrixLabel),
    dualColorRow(c, "color.primaries", t("原色"), v?.color_primaries, ep?.colorPrimaries, primariesLabel),
    dualColorRow(c, "color.transfer", t("傳遞函數"), v?.color_transfer, ep?.colorTrc, transferLabel),
  ];
  if (v) {
    const loc = chromaLocationLabel(v.chroma_location);
    rows.push({ key: "color.chromaLocation", label: t("色度位置"), value: loc, note: loc ? undefined : c.extraWhy(v.chroma_location, t("沒有標示（VP9 等編碼不帶這個欄位）")), source: "ffprobe" });
  }
  const assumed = ep?.matrixAssumed ? matrixLabel(ep.matrixAssumed) : null;
  rows.push({
    key: "color.engine",
    label: t("引擎採用"),
    value: assumed
      ? ep?.matrixSource === "tag"
        ? t("{matrix}（依標示）", { matrix: assumed })
        : t("{matrix}（推定：未標示，高度 {h} {cmp} 576）", { matrix: assumed, h: height || "?", cmp: height >= 576 ? "≥" : "<" })
      : null,
    note: assumed ? (matrixTag ? undefined : t("輸出會依引擎採用值標記 {matrix} / {range}", { matrix: assumed, range: rangeTag ?? "tv" })) : c.engineWhy,
    source: "engine",
    warn: !!assumed && ep?.matrixSource !== "tag",
  });
  return rows;
}

function frameRateModeValue(index: IndexSummary | null, vfr: boolean | null): string | null {
  if (!index || vfr == null) return null;
  const fps = `${index.fps.num}/${index.fps.den}`;
  if (!vfr) return t("固定（CFR）：來源 {n} 幀與 {fps} proxy 一一對應", { n: index.nSource, fps });
  const g = index.gaps;
  const base = { n: index.nSource, fps, gap: g ? fixed(g.maxMs, 0) : "—", at: g ? fixed(g.maxAtMs / 1000, 3) : "—" };
  return index.cfr
    ? t("可變（VFR）：來源 {n} 幀，轉成 {fps} CFR proxy 補 {dup} 個重複幀、丟 {drop} 幀；最大斷層 {gap} ms（{at} 秒處）", { ...base, dup: index.cfr.duplicates, drop: index.cfr.dropped })
    : t("可變（VFR）：來源 {n} 幀；最大斷層 {gap} ms（{at} 秒處）", base);
}

function timingRows(c: Ctx): InfoRow[] {
  const { v, ep, d, input } = c;
  const { index, probe } = input;
  const nominal = d.nominalFps;
  const avg = v?.avg_frame_rate;
  const cfr = index?.cfr ?? null;
  const fpsRatio = index ? `${index.fps.num}/${index.fps.den}` : "";
  const mode = frameRateModeValue(index, d.vfr);
  const header = v?.nb_frames ?? ep?.nbFrames ?? null;
  const rows: InfoRow[] = [
    { key: "timing.nominalFps", label: t("標稱幀率"), value: nominal ? formatRationalFps(nominal) : null, note: nominal ? t("r_frame_rate：容器 / 位元流的基準幀率") : probe ? t("沒有標示") : c.noProbeWhy, source: v?.r_frame_rate.num ? "ffprobe" : "engine" },
    { key: "timing.avgFps", label: t("平均幀率"), value: avg && avg.num > 0 && avg.den > 0 ? formatRationalFps(avg) : null, note: avg && avg.num > 0 ? undefined : v ? t("容器未標示（WebM 常見）；看「實測幀率」") : c.noProbeWhy, source: "ffprobe" },
    {
      key: "timing.measuredFps",
      label: t("實測幀率"),
      value: index?.measuredFps != null ? `${fixed(index.measuredFps, 3)} fps` : null,
      note: index?.measuredFps != null ? t("依 {n} 個解碼時間戳：(n − 1) ÷ (最後 − 第一)", { n: index.nSource }) : c.engineWhy,
      source: "index",
    },
    { key: "timing.mode", label: t("幀率模式"), value: mode, note: mode ? undefined : c.loading ? t("讀取中…") : t("需要引擎索引（建 proxy 時產生）：容器標頭判斷不了 VFR"), source: "index", warn: !!d.vfr },
  ];
  if (d.vfrReasons.length) rows.push({ key: "timing.vfrReasons", label: t("判斷依據"), value: d.vfrReasons.map(vfrReasonText).join("；"), source: "derived" });
  rows.push({
    key: "timing.sourceFrames",
    label: t("來源幀數"),
    value: index ? String(index.nSource) : header != null ? String(header) : null,
    note: index ? (header != null ? (header === index.nSource ? t("與標頭一致") : t("標頭寫 {n} 幀，與實際解碼不同", { n: header })) : t("標頭未標示；這是實際解碼數")) : header != null ? t("標頭值（還沒有索引可核對）") : c.engineWhy,
    source: index ? "index" : "ffprobe",
    warn: !!index && header != null && header !== index.nSource,
  });
  rows.push({
    key: "timing.intervals",
    label: t("時間戳間隔"),
    value: index?.gaps ? t("最小 {min} · 中位 {median} · 最大 {max} ms", { min: fixed(index.gaps.minMs, 1), median: fixed(index.gaps.medianMs, 1), max: fixed(index.gaps.maxMs, 1) }) : null,
    note: index?.gaps ? undefined : index ? t("只有一幀") : c.engineWhy,
    source: "index",
  });
  if (index?.gaps) {
    const g = index.gaps;
    const shown = g.over40ms.slice(0, 5).map((x) => t("來源幀 {src} @ {at} 秒 +{gap} ms", { src: x.src, at: fixed(x.ptsMs / 1000, 3), gap: fixed(x.gapMs, 0) }));
    const more = g.over40Count > shown.length ? t("…另 {n} 處", { n: g.over40Count - shown.length }) : "";
    rows.push({
      key: "timing.gaps",
      label: t("斷層（≥ 40 ms）"),
      value: g.over40Count ? t("{n} 處：{list}", { n: g.over40Count, list: shown.join("；") }) + more : t("無"),
      note: g.over40Count ? t("斷層期間 proxy 會重複前一幀（定格），音訊不失步") : undefined,
      source: "index",
      warn: g.over40Count > 0,
    });
  }
  rows.push({
    key: "timing.cfr",
    label: t("CFR 對應"),
    value: cfr ? t("{frames} 幀 @ {fps} · 補 {dup} 個重複幀 · 丟 {drop} 幀 · {runs} 段", { frames: cfr.nFrames, fps: fpsRatio, dup: cfr.duplicates, drop: cfr.dropped, runs: cfr.runs }) : null,
    note: cfr ? t("時間軸的幀號就是這份 proxy 的幀號") : index ? t("索引裡沒有 CFR 對應（舊版快取）：重建 proxy 會補上") : c.engineWhy,
    source: "index",
  });
  rows.push({
    key: "timing.keyframes",
    label: t("關鍵幀"),
    value: index?.gop
      ? t("{n} 個（平均 GOP {mean} 幀，最長 {max} 幀 / {maxS} 秒）", { n: index.keyframes, mean: Math.round(index.gop.meanFrames), max: index.gop.maxFrames, maxS: fixed(index.gop.maxMs / 1000, 2) })
      : index
        ? t("{n} 個", { n: index.keyframes })
        : null,
    note: index?.gop ? t("GOP 越長，來源跳轉越慢（要從前一個關鍵幀解起）；proxy 固定 GOP 15") : index ? undefined : c.engineWhy,
    source: "index",
    warn: !!index?.gop && index.gop.maxMs > 5000,
  });
  rows.push({ key: "timing.duration", label: t("時長（視訊軌標頭）"), value: v?.duration_ms ? formatSeconds(v.duration_ms) : null, note: v?.duration_ms ? undefined : v ? t("標頭未標示（WebM 常見）；整體時長見「檔案」") : c.noProbeWhy, source: "ffprobe" });
  const startMs = v?.start_time_ms ?? ep?.startMs ?? null;
  rows.push({ key: "timing.start", label: t("起始時間"), value: startMs != null ? formatSeconds(startMs) : null, note: startMs != null ? t("第一幀的呈現時間戳；proxy 從 0 起算") : t("沒有標示"), source: v?.start_time_ms != null ? "ffprobe" : "engine" });
  const tb = v?.time_base ?? index?.timeBase ?? null;
  rows.push({ key: "timing.timeBase", label: "time_base", value: tb && tb.den > 0 ? `${tb.num}/${tb.den}` : null, note: tb ? undefined : t("沒有標示"), source: v ? "ffprobe" : "index", mono: true });
  rows.push({
    key: "timing.timecode",
    label: t("起始時間碼"),
    value: probe?.timecode ?? null,
    note: probe?.timecode ? t("檔案標籤；時間軸一律從 00:00:00:00 起算") : probe ? c.extraWhy(probe.timecode, t("檔案沒有時間碼標籤；時間軸從 00:00:00:00 起算")) : c.noProbeWhy,
    source: "ffprobe",
    mono: true,
  });
  return rows;
}

function audioRows(c: Ctx): InfoRow[] {
  const { a, v, input } = c;
  const { probe, proxy } = input;
  if (!probe) return [{ key: "audio.none", label: t("音軌"), value: null, note: c.noProbeWhy }];
  if (!a) return [{ key: "audio.none", label: t("音軌"), value: t("無音軌"), note: t("這支影片沒有音軌（播放無聲、輸出不含音訊）"), source: "ffprobe", warn: true }];
  const sf = sampleFmtLabel(a.sample_fmt);
  const delay = a.start_time_ms != null && v?.start_time_ms != null ? a.start_time_ms - v.start_time_ms : null;
  const rows: InfoRow[] = [
    { key: "audio.codec", label: t("編碼"), value: a.profile ? `${codecLabel(a.codec)} ${a.profile}` : codecLabel(a.codec), note: a.codec_long_name && a.codec_long_name !== codecLabel(a.codec) ? a.codec_long_name : undefined, source: "ffprobe" },
    { key: "audio.sampleRate", label: t("取樣率"), value: a.sample_rate ? `${fixed(a.sample_rate / 1000, 1)} kHz` : null, note: a.sample_rate ? undefined : t("ffprobe 沒有回報"), source: "ffprobe" },
    { key: "audio.channels", label: t("聲道"), value: a.channels ? channelsLabel(a.channels, a.channel_layout) : null, note: a.channels ? undefined : t("ffprobe 沒有回報"), source: "ffprobe" },
    { key: "audio.sampleFmt", label: t("取樣格式"), value: a.sample_fmt ?? null, note: a.sample_fmt ? (sf && sf !== a.sample_fmt ? sf : undefined) : c.extraWhy(a.sample_fmt, t("ffprobe 沒有回報")), source: "ffprobe", mono: true },
  ];
  if (a.bits_per_sample) rows.push({ key: "audio.depth", label: t("位元深度"), value: bitDepthLabel(a.bits_per_sample), source: "ffprobe" });
  rows.push(
    { key: "audio.bitrate", label: t("音訊位元率"), value: a.bit_rate ? formatBitrate(a.bit_rate) : null, note: a.bit_rate ? undefined : t("容器沒有逐軌位元率（WebM / Opus 常見）"), source: "ffprobe" },
    { key: "audio.duration", label: t("時長（音軌標頭）"), value: a.duration_ms ? formatSeconds(a.duration_ms) : null, note: a.duration_ms ? undefined : c.extraWhy(a.duration_ms, t("標頭未標示")), source: "ffprobe" },
    {
      key: "audio.delay",
      label: t("相對視訊延遲"),
      value: delay != null ? `${delay > 0 ? "+" : delay < 0 ? "−" : ""}${Math.abs(delay)} ms` : null,
      note: delay != null ? t("音訊起點 − 視訊起點（proxy 以 -c:a copy 保持同步）") : c.extraWhy(a.start_time_ms, t("需要音訊與視訊的起始時間")),
      source: "derived",
      warn: delay != null && Math.abs(delay) >= 40,
    },
    { key: "audio.proxy", label: t("proxy 音軌"), value: proxy ? (proxy.audio ? codecLabel(proxy.audio) : t("無")) : null, note: proxy ? t("proxy.mp4 裡播放用的音軌") : c.engineWhy, source: "proxy", warn: !!proxy && !proxy.audio },
  );
  return rows;
}

function proxyRow(c: Ctx): InfoRow {
  const proxy = c.input.proxy;
  if (!proxy) return { key: "engine.proxy", label: "Proxy", value: null, note: c.engineWhy, source: "proxy" };
  const parts = [
    proxy.width && proxy.height ? `${proxy.width}×${proxy.height}` : null,
    proxy.frames != null && proxy.fps ? t("{n} 幀 @ {fps}", { n: proxy.frames, fps: `${proxy.fps.num}/${proxy.fps.den}` }) : null,
    proxy.codec,
    proxy.gop ? `GOP ${proxy.gop}` : null,
    proxy.audio ? codecShort(proxy.audio) : null,
    proxy.bytes ? formatSize(proxy.bytes) : null,
    proxy.scale != null ? t("縮放 {s}", { s: fixed(proxy.scale, 4) }) : null,
  ].filter((x): x is string => !!x);
  return { key: "engine.proxy", label: "Proxy", value: parts.join(" · "), note: proxy.seconds != null ? t("建立耗時 {s} 秒", { s: fixed(proxy.seconds, 1) }) : undefined, source: "proxy" };
}

function engineRows(c: Ctx): InfoRow[] {
  const { input, ep } = c;
  const { cache, shots, project } = input;
  const autoShots = project.shots.filter((s) => s.source === "auto").length;
  const staleTracks = project.tracks.filter((x) => x.stale).length;
  const scores = shots?.cuts.map((x) => x.score) ?? [];
  return [
    {
      key: "engine.cache",
      label: t("快取"),
      value: cache ? t("proxy {proxy} · 索引 {index} · 縮圖 {thumbs}", { proxy: cache.proxy ? "✓" : "—", index: cache.index ? "✓" : "—", thumbs: cache.thumbs ? "✓" : "—" }) : null,
      note: cache ? cache.dir : c.loading ? t("讀取中…") : t("讀不到快取狀態"),
      source: "cache",
    },
    proxyRow(c),
    {
      key: "engine.probeSource",
      label: t("引擎讀取方式"),
      value: ep?.source === "pyav" ? t("PyAV（解碼第一幀）") : ep?.source === "ffprobe" ? t("ffprobe（PyAV 讀不了時的退路）") : ep?.source ?? null,
      note: ep ? undefined : c.engineWhy,
      source: "engine",
    },
    { key: "engine.shots", label: t("鏡頭"), value: project.shots.length ? t("{n} 個（自動 {auto} · 手動 {user}）", { n: project.shots.length, auto: autoShots, user: project.shots.length - autoShots }) : null, note: project.shots.length ? undefined : t("還沒有鏡頭：引擎就緒後會自動偵測"), source: "project" },
    {
      key: "engine.cuts",
      label: t("切點偵測"),
      value: !shots
        ? null
        : scores.length
          ? t("{n} 個切點，分數 {min}–{max}（門檻 {th}、最短 {len} 幀）", { n: scores.length, min: fixed(Math.min(...scores), 2), max: fixed(Math.max(...scores), 2), th: shots.threshold ?? "—", len: shots.minLen ?? "—" })
          : t("沒有切點（門檻 {th}）", { th: shots.threshold ?? "—" }),
      note: shots ? t("自動偵測的原始結果；手動切 / 合併不會改這一列") : c.loading ? t("讀取中…") : t("還沒跑鏡頭偵測"),
      source: "shots",
    },
    {
      key: "engine.tracks",
      label: t("追蹤"),
      value: project.tracks.length ? t("{n} 條（待重解 {stale} · 解已載入 {loaded}）", { n: project.tracks.length, stale: staleTracks, loaded: project.loadedSolves }) : null,
      note: project.tracks.length ? undefined : t("還沒有追蹤"),
      source: "project",
      warn: staleTracks > 0,
    },
    ...(project.extraRows ?? []),
  ];
}

function badgesOf(c: Ctx): InfoBadge[] {
  const { d, v, a, input } = c;
  const out: InfoBadge[] = [];
  if (input.probeError) out.push({ key: "probeError", tone: "danger", label: t("無法重新讀取影片"), title: input.probeError });
  if (d.fingerprintChanged) out.push({ key: "changed", tone: "danger", label: t("檔案已變更"), title: t("重新讀取的指紋和加入專案時不同：檔案被換掉或改過，追蹤與快取可能對不上") });
  if (d.vfr) out.push({ key: "vfr", tone: "warning", label: "VFR", title: d.vfrReasons.map(vfrReasonText).join("\n") });
  if (d.colorTagged === false) out.push({ key: "untagged", tone: "warning", label: t("未標示色彩"), title: t("容器與位元流都沒有標示矩陣係數；引擎依解析度推定") });
  if (d.hdr) out.push({ key: "hdr", tone: "warning", label: "HDR", title: t("HDR 來源：v1 以 BT.709 近似") });
  if (input.probe && !a) out.push({ key: "noAudio", tone: "neutral", label: t("無音軌") });
  if (v?.rotation) out.push({ key: "rotation", tone: "info", label: t("旋轉 {deg}°", { deg: v.rotation }) });
  return out;
}

export function deriveMediaInfo(input: MediaInfoInput): MediaInfoModel {
  const d = deriveFacts(input);
  const c = makeCtx(input, d);
  const sections: InfoSection[] = [
    { id: "file", title: t("檔案"), rows: fileRows(c) },
    { id: "video", title: t("視訊"), rows: videoRows(c) },
    { id: "color", title: t("色彩"), rows: colorRows(c) },
    { id: "timing", title: t("時間"), rows: timingRows(c) },
    { id: "audio", title: t("音訊"), rows: audioRows(c) },
    { id: "engine", title: t("引擎分析"), rows: engineRows(c) },
  ];
  return { title: input.media.name, chips: mediaChips(input.probe, d.vfr, input.proxy), badges: badgesOf(c), sections, derived: d };
}

// ============================================================ 匯出

/**
 * MediaInfo 風格純文字：區塊標題 + 「標籤（補到同一個顯示寬度）: 值（說明）」。貼到回報單 / 論壇的等寬字型下對得齊。
 * 欄寬取最長標籤 + 1：中英文標籤長度差很多，寫死欄寬不是太擠就是太空。
 */
export function mediaInfoText(model: MediaInfoModel, app: { name: string; version: string }): string {
  const rows = model.sections.flatMap((s) => s.rows);
  const width = Math.max(0, ...rows.map((r) => displayWidth(r.label))) + 1;
  const lines: string[] = [model.title, model.chips.join(" · ")];
  if (model.badges.length) lines.push(model.badges.map((b) => b.label).join(" · "));
  for (const s of model.sections) {
    lines.push("", s.title);
    for (const r of s.rows) {
      const value = r.value ?? "—";
      lines.push(`${padDisplay(r.label, width)}: ${r.note ? t("{value}（{note}）", { value, note: r.note }) : value}`);
    }
  }
  lines.push("", t("由 {app} {version} 產生", { app: app.name, version: app.version }));
  return lines.join("\n");
}

/**
 * 結構化 JSON（回報問題 / 腳本比對用）：原始 probe 值 + 索引摘要 + 推算結果。
 * 值不翻譯（鍵與代碼是資料）；**不含 pts_ms / key 陣列**（summarizeIndex 本來就不留）。
 */
export function mediaInfoJson(input: MediaInfoInput, model: MediaInfoModel, app: { name: string; version: string }): Record<string, unknown> {
  const { project } = input;
  return {
    app,
    media: { ...input.media },
    probeFrom: input.probeFrom,
    probe: input.probe,
    engineProbe: input.engineProbe,
    index: input.index,
    proxy: input.proxy,
    shots: {
      count: project.shots.length,
      auto: project.shots.filter((s) => s.source === "auto").length,
      user: project.shots.filter((s) => s.source === "user").length,
      cuts: input.shots?.cuts ?? null,
      params: input.shots ? { threshold: input.shots.threshold, minLen: input.shots.minLen } : null,
    },
    tracks: { count: project.tracks.length, stale: project.tracks.filter((x) => x.stale).length, loadedSolves: project.loadedSolves },
    ...(project.extraReport ?? {}),
    cache: input.cache,
    derived: model.derived,
  };
}
