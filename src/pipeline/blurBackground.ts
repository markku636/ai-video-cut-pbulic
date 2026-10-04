/**
 * 背景虛化 / 換色（引擎 `bg.blur`）：主體留著，背景糊掉或換成純色。
 *
 * 對標 CapCut、Riverside、Premiere 的人像模式。**前半跟「移除物件」是同一條路**
 * （文字 → 框 → 逐幀遮罩，`removeObject.findAndTrack`），差別只在最後一步：
 * 移除物件換掉遮罩**裡面**，這裡換掉遮罩**外面**。
 *
 * 所以這個檔只有參數與摘要，追蹤直接重用 —— 不要再抄一份 seg 的編排。
 */
import type { FrameRange } from "../store/timeline";
import { runEngineJob } from "./engineJob";

/** 強度＝畫面寬度的百分比。引擎的預設（實測 1.5，見 plugins/cards/docs/measurements.md）由引擎決定，這裡只放滑桿的範圍。 */
export const STRENGTH_MIN = 0.5;
export const STRENGTH_MAX = 4;
export const STRENGTH_STEP = 0.1;

export interface BlurBackgroundOpts {
  /** 主體的遮罩檔（每個物件一個 `.aivm`）。 */
  maskPaths: string[];
  /** 只處理這段 proxy 幀；null = 整支。 */
  range: FrameRange | null;
  outPath: string;
  /** 虛化強度（畫面寬度的百分比）；null = 用引擎預設。 */
  strength: number | null;
  /** 換成純色背景（`"R,G,B"`，0-255）；null = 虛化。 */
  color: string | null;
}

export interface BlurBackgroundResult {
  video: string;
  size: [number, number];
  range: [number, number];
  mode: "blur" | "color";
  radius: number | null;
  strength: number | null;
  color: number[] | null;
  /** 主體平均佔畫面的比例。太小 = 大概沒追到，太大 = 遮罩框錯了。 */
  subjectCoverage: number;
  /** 找不到主體、原樣放行的幀數。>0 代表遮罩在那幾幀斷了。 */
  missingFrames: number;
  changedFrames: number;
  out: string;
  frames?: number;
  bytes?: number;
  seconds?: number;
}

/** `<stem>.aivc.bg.<ext>`：跟輸出對話框與「移除物件」的檔名都分開，才不會互相覆蓋。 */
export function defaultBlurOut(src: string, outDir: string | null, ext = "mp4"): string {
  const sep = src.includes("\\") ? "\\" : "/";
  const base = src.split(/[\\/]/).pop() ?? "out";
  const stem = base.replace(/\.[^.]+$/, "");
  const dir = outDir ?? src.slice(0, Math.max(0, src.lastIndexOf(sep)));
  return `${dir}${sep}${stem}.aivc.bg.${ext}`;
}

/**
 * 引擎參數。`strength` 與 `color` 是互斥的：給了顏色就是換色，引擎不會再算虛化，
 * 所以送顏色時**不要**連 strength 一起送（送了不會錯，但結果裡的 strength 會是 null，
 * 兩邊對不起來很容易讓人以為參數沒吃到）。
 */
export function blurArgs(video: string, o: BlurBackgroundOpts): Record<string, unknown> {
  return {
    video,
    masks: o.maskPaths,
    out: o.outPath,
    ...(o.range ? { frames: `${o.range.in}:${o.range.out}` } : {}),
    ...(o.color ? { color: o.color } : o.strength != null ? { strength: o.strength } : {}),
  };
}

export async function blurBackground(mediaId: string, video: string, o: BlurBackgroundOpts): Promise<BlurBackgroundResult> {
  return runEngineJob<BlurBackgroundResult>({ kind: "export", mediaId, op: "bg.blur", args: blurArgs(video, o), step: "背景虛化" });
}

/** `{r, g, b}`（0-255）→ 引擎要的 `"R,G,B"`。 */
export function colorArg(hex: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

/**
 * 跑完之後的一行人話。講的順序是「有沒有問題」而不是「數字」：
 * `missingFrames` 是這條路唯一會默默做壞的東西（遮罩斷掉的那幾幀沒虛化），所以排最前面。
 */
export function blurSummary(r: BlurBackgroundResult, t: (zh: string, vars?: Record<string, string | number>) => string): string {
  const parts: string[] = [];
  if (r.missingFrames) parts.push(t("有 {n} 幀找不到主體，那幾幀沒有虛化", { n: r.missingFrames }));
  parts.push(r.mode === "color" ? t("背景換色") : t("虛化半徑 {px} px", { px: r.radius ?? 0 }));
  parts.push(t("主體平均佔畫面 {p}%", { p: (r.subjectCoverage * 100).toFixed(1) }));
  if (r.seconds != null) parts.push(t("{n} 幀・{s}s", { n: r.frames ?? 0, s: r.seconds }));
  return parts.join("・");
}
