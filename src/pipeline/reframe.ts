/**
 * 自動重構圖（引擎 `reframe.plan` + `render --reframe`）：把橫幅影片裁成直幅／方形，鏡頭跟著主體走。
 *
 * 分成兩步是引擎那邊的設計（見 `engine/src/aivc/ops/reframe.py`）：規劃要跑偵測（GPU、數十秒）、
 * 渲染要跑編碼（數分鐘），綁在一起的話「鏡頭跟錯人了」只能整支重跑。
 * 這裡的職責就是把那兩步接到輸出對話框上，外加一件 UI 才知道的事：
 * **規劃出來的路徑還對不對得上現在要輸出的範圍**（`reframeMismatch`）。
 *
 * 為什麼那件事要在 UI 擋：規劃完之後使用者可能改了範圍、改了比例，引擎收到對不上的路徑會報錯，
 * 但那是在**編碼開始之前**、按下輸出之後才看到。與其讓人白等一次，不如在按鈕旁邊先說。
 */
import { api } from "../api";
import type { FrameRange } from "../store/timeline";
import { runEngineJob } from "./engineJob";

/** 對外提供的目標比例。`source` = 不重構（維持原尺寸）。 */
export const REFRAME_ASPECTS = ["source", "9:16", "4:5", "1:1"] as const;
export type ReframeAspect = (typeof REFRAME_ASPECTS)[number];

export interface ReframePlanResult {
  /** 路徑檔位置（要原樣交給 render 的 `reframe` 參數）。 */
  path: string;
  source: [number, number];
  size: [number, number];
  frames: number;
  range: [number, number];
  /** `track` = 跟著主體；`static` = 靜態置中（沒給文字時）。 */
  mode: "track" | "static";
  cuts: number[];
  missing: number;
  segments: number;
  /** 引擎自己偵測到的鏡頭切換數（沒有專案時唯一的來源）。 */
  sceneCuts?: number;
  preview: string | null;
  /** 聯絡表的 base64 JPEG（`inline_preview`）：直接畫在對話框裡，不必開外部看圖程式。 */
  previewData: string | null;
}

export interface ReframeWant {
  aspect: ReframeAspect;
  /** 跟著誰（逗號分隔）；空的就是靜態置中裁切。 */
  text: string;
  range: FrameRange | null;
  trim: boolean;
  /** 素材的 proxy 幀數（不裁切時的輸出範圍就是 [0, nFrames)）。 */
  nFrames: number;
}

/** 這次輸出實際會寫出的素材幀範圍（與引擎 `RenderPlan.write_range` 同一個算法）。 */
export function writeRange(want: Pick<ReframeWant, "range" | "trim" | "nFrames">): [number, number] {
  return want.range && want.trim ? [want.range.in, want.range.out] : [0, want.nFrames];
}

/** `"9:16"` → `[9, 16]`；`source` 回 null。 */
export function aspectPair(a: ReframeAspect): [number, number] | null {
  if (a === "source") return null;
  const [w, h] = a.split(":").map(Number);
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? [w, h] : null;
}

/**
 * 已規劃的路徑跟現在想要的對不對得上；對得上回 null。
 *
 * 比例是拿**裁切尺寸**回推而不是記下當初選了什麼：引擎保證裁切尺寸的長寬比精確
 * （`crop_size` 的核心決策），所以 `size` 本身就是比例的可靠來源，少存一份就少一份會不同步的狀態。
 */
export function reframeMismatch(plan: ReframePlanResult | null, want: ReframeWant): "missing" | "aspect" | "range" | null {
  if (want.aspect === "source") return null;
  if (!plan) return "missing";
  const pair = aspectPair(want.aspect);
  if (!pair) return "aspect";
  const [aw, ah] = pair;
  if (plan.size[0] * ah !== plan.size[1] * aw) return "aspect";
  const [k0, k1] = writeRange(want);
  return plan.range[0] <= k0 && k1 <= plan.range[1] ? null : "range";
}

/** 規劃時要送的引擎參數。一律用 `!= null` 判斷，`0` 是合法值（`--cut-threshold 0` = 一律平移）。 */
export function reframeArgs(video: string, out: string, want: ReframeWant, tune: ReframeTune = {}): Record<string, unknown> {
  const [k0, k1] = writeRange(want);
  const text = want.text.trim();
  return {
    video,
    out,
    aspect: want.aspect,
    ...(text ? { text } : {}),
    // 規劃整個輸出範圍：使用者之後只縮小範圍的話，路徑仍然涵蓋得到（reframeMismatch 據此判斷）。
    // **算不出範圍時整個欄位不送**，讓引擎自己取「整支」——「轉成直幅」那條路沒有專案、
    // 也就沒有 nFrames，送 `0:0` 的話引擎會回「K1 要大於 K0」，而那是在使用者按下規劃之後
    // 才看到的錯誤（我第一版就是這樣，規劃鈕一直轉）。
    ...(k1 > k0 ? { range: `${k0}:${k1}` } : {}),
    ...(tune.zoom != null ? { zoom: tune.zoom } : {}),
    ...(tune.biasY != null ? { bias_y: tune.biasY } : {}),
    ...(tune.every != null ? { every: tune.every } : {}),
    ...(tune.cuts && tune.cuts.length ? { cuts: tune.cuts.join(",") } : {}),
    ...(tune.preview ? { preview: tune.preview } : {}),
    // 一律要 inline 的聯絡表：25 KB 左右，換來「不必離開對話框就看得到構圖」
    inline_preview: true,
  };
}

export interface ReframeTune {
  zoom?: number | null;
  /** 正值把裁切框往下挪 → 主體在成品裡偏上（人像的頭頂留白）。 */
  biasY?: number | null;
  every?: number | null;
  preview?: string | null;
  /**
   * 已知的鏡頭邊界（proxy 幀）。給了就比「目標中心跳太遠」這個猜測準：
   * 切點會落在真正換鏡頭的那一幀，而不是主體剛好移動很快的那一幀。
   */
  cuts?: readonly number[] | null;
}

/** 構圖預設：一句話講清楚它在幹嘛，而不是叫人猜 bias/zoom 要填多少。 */
export const REFRAME_FRAMINGS: { label: string; tune: Pick<ReframeTune, "zoom" | "biasY"> }[] = [
  { label: "置中", tune: { zoom: null, biasY: null } },
  { label: "人像（頭頂留白）", tune: { zoom: null, biasY: 0.08 } },
  { label: "推近一點", tune: { zoom: 1.25, biasY: null } },
  { label: "推近＋頭頂留白", tune: { zoom: 1.25, biasY: 0.08 } },
];

/** 路徑檔與預覽圖放哪：跟輸出檔同一個目錄、同一個檔名前綴，使用者找得到也刪得掉。 */
export function reframeSidecars(outPath: string, aspect: ReframeAspect): { path: string; preview: string } {
  const tag = aspect.replace(":", "x");
  const stem = outPath.replace(/\.[^.\\/]+$/, "");
  return { path: `${stem}.${tag}.reframe.json`, preview: `${stem}.${tag}.reframe.png` };
}

/** 規劃（引擎 `reframe.plan`）。逐幀偵測很慢，所以給長一點的逾時。 */
export async function planReframe(video: string, out: string, want: ReframeWant, tune: ReframeTune = {}): Promise<ReframePlanResult> {
  return api.engineCall<ReframePlanResult>("reframe.plan", reframeArgs(video, out, want, tune), 30 * 60_000);
}

/**
 * 規劃結果的一行人話。`t` 由呼叫端傳（這個模組不碰 i18n，才能被純測試直接跑）。
 *
 * 「切點」扣掉第 0 幀：那一格是「開場就位」，不是鏡頭切換，算進去會讓每支片至少都有一個切點，
 * 使用者看到「1 個切點」會去找那個不存在的切換。
 */
export function reframeSummary(r: ReframePlanResult, t: (zh: string, vars?: Record<string, string | number>) => string): string {
  const cuts = r.cuts.filter((c) => c > 0).length;
  const head = t("{w}×{h}（{n} 幀）", { w: r.size[0], h: r.size[1], n: r.frames });
  if (r.mode === "static") return `${head}・${t("靜態置中")}`;
  const parts = [head, cuts ? t("{n} 次鏡頭切換", { n: cuts }) : t("全程平移")];
  // 自動偵測到的鏡頭切換單獨講：那是「規劃有讀懂你的剪輯」的證據，
  // 而使用者在「轉成直幅」那條路上沒有別的方式知道這件事有沒有發生。
  if (r.sceneCuts) parts.push(t("認出 {n} 個鏡頭換點", { n: r.sceneCuts }));
  if (r.missing) parts.push(t("{n} 幀沒偵測到（沿用上一個目標）", { n: r.missing }));
  return parts.join("・");
}


/**
 * 鏡頭表 → 要送給引擎的切點（proxy 幀）。
 *
 * 取每個鏡頭的**起點**、去掉第 0 幀（那是開場，不是切換）並去重。
 * 引擎會把這些與它自己偵測到的「目標跳太遠」取聯集。
 */
export function cutsFromShots(shots: readonly { startFrame: number }[]): number[] {
  return [...new Set(shots.map((s) => s.startFrame).filter((f) => f > 0))].sort((a, b) => a - b);
}

/** 常用的輸出尺寸。`null` = 輸出裁切尺寸（零重取樣）。 */
export const REFRAME_OUT_SIZES: { label: string; size: [number, number] | null }[] = [
  { label: "裁切尺寸（零重取樣）", size: null },
  { label: "1080×1920", size: [1080, 1920] },
  { label: "720×1280", size: [720, 1280] },
  { label: "1080×1080", size: [1080, 1080] },
];

export interface ReframeApplyResult {
  out: string;
  source: [number, number];
  size: [number, number];
  frames: number;
  bytes: number;
  seconds: number;
  /** 有縮放 = 重取樣過；沒有就是純切片。 */
  resampled: boolean;
}

/** `reframe-apply` 的參數。`size` 給 null 就不縮放。 */
export function applyArgs(video: string, pathFile: string, out: string, size: [number, number] | null): Record<string, unknown> {
  return { video, path: pathFile, out, ...(size ? { size: `${size[0]}x${size[1]}` } : {}) };
}

/**
 * 把規劃好的路徑套到一支影片上（引擎 `reframe.apply`）。**不需要專案**。
 *
 * 這條路也是序列輸出要做重構圖的解法：先正常輸出序列成一支影片，再對那支規劃與套用。
 * 序列幀與素材 proxy 幀是兩套幀號，但對「輸出好的那一支」來說只有一套，問題自然消失。
 */
export async function applyReframe(mediaId: string, video: string, pathFile: string, out: string, size: [number, number] | null): Promise<ReframeApplyResult> {
  return runEngineJob<ReframeApplyResult>({ kind: "export", mediaId, op: "reframe.apply", args: applyArgs(video, pathFile, out, size), step: "轉成直幅" });
}

/** `<stem>.9x16.mp4`：跟來源同目錄，檔名帶比例，不同比例不會互相覆蓋。 */
export function defaultApplyOut(src: string, aspect: ReframeAspect): string {
  const tag = aspect.replace(":", "x");
  const stem = src.replace(/\.[^.\\/]+$/, "");
  return `${stem}.${tag}.mp4`;
}
