/**
 * 移除物件（引擎 `inpaint.remove`）：把追蹤到的東西從畫面上拿掉，用**其他幀真正拍到的**背景補回來。
 *
 * 遮罩就是「物件遮罩」那條路已經產生的 `.aivm`（`pipeline/mask.ts` → `maskHints`），
 * 所以這裡不做任何新的偵測：使用者已經框過、傳播過的東西直接拿來用。
 *
 * 分成「先算背景板」與「真的輸出」兩步，跟自動重構圖同一個理由：
 * 背景板幾秒就算完而且看一眼就知道這段素材行不行（鏡頭有沒有動、背景有沒有露出來過），
 * 輸出則要整支重新編碼。讓人先看那張圖，比讓人等完整支再發現不行好。
 */
import { api } from "../api";
import type { FrameRange } from "../store/timeline";
import { runEngineJob } from "./engineJob";

export interface RemoveObjectResult {
  video: string;
  size: [number, number];
  range: [number, number];
  samples: number;
  /** 首尾之間的整體平移量（像素）。這條路要靜止機位。 */
  cameraShift: number;
  /** 遮罩區域有多少比例的背景在別的幀露出過。 */
  coverage: number;
  /** 完全沒露出過、只能靠古典補繪的像素數（會糊）。 */
  inpaintedPixels: number;
  /** 乾淨取樣偏少、背景板不太可信的像素數。 */
  thinPixels: number;
  plate: string | null;
  /** 背景板的 base64 JPEG（`inline_plate`）：直接畫在對話框裡，不必開外部看圖程式。 */
  plateData: string | null;
  out: string | null;
  frames?: number;
  bytes?: number;
  changedFrames?: number;
  seconds?: number;
}

export interface RemoveObjectOpts {
  /** 這些遮罩檔（每個物件一個 `.aivm`）；由呼叫端從 `maskFileFor` 解出來。 */
  maskPaths: string[];
  /** 只處理這段 proxy 幀；null = 整支。 */
  range: FrameRange | null;
  /** 輸出影片；null = 只算背景板（這時 `platePath` 必填）。 */
  outPath: string | null;
  /** 背景板 PNG 的輸出位置。 */
  platePath: string | null;
  /** 連物件投下的影子一起移除（預設開）。關掉的話輪廓容易被自己的影子描出來。 */
  shadow: boolean;
  /** 合成時遮罩先膨脹幾個像素；null = 用引擎預設。 */
  dilate: number | null;
}

/** `<stem>.aivc.clean.<ext>`：與輸出對話框的 `<stem>.aivc.<ext>` 分開，才不會互相覆蓋。 */
export function defaultRemoveOut(src: string, outDir: string | null, ext = "mp4"): string {
  const sep = src.includes("\\") ? "\\" : "/";
  const base = src.split(/[\\/]/).pop() ?? "out";
  const stem = base.replace(/\.[^.]+$/, "");
  const dir = outDir ?? src.slice(0, Math.max(0, src.lastIndexOf(sep)));
  return `${dir}${sep}${stem}.aivc.clean.${ext}`;
}

/** 背景板 PNG 放在輸出影片旁邊、同一個前綴。 */
export function platePathFor(outPath: string): string {
  return `${outPath.replace(/\.[^.\\/]+$/, "")}.plate.png`;
}

/**
 * 引擎參數。`--shadow 1` 是「關掉影子處理」（比值門檻 1 = 沒有像素比背景板暗到算影子），
 * 所以關掉要送 1、開著就不送（用引擎預設）—— 不要在這裡複製一份預設值。
 */
export function removeArgs(video: string, o: RemoveObjectOpts): Record<string, unknown> {
  return {
    video,
    masks: o.maskPaths,
    ...(o.outPath ? { out: o.outPath } : {}),
    ...(o.platePath ? { emit_plate: o.platePath } : {}),
    // 一律要 inline 的背景板：幾十 KB，換來「不必離開對話框就看得到這段素材行不行」
    inline_plate: true,
    ...(o.range ? { frames: `${o.range.in}:${o.range.out}` } : {}),
    ...(o.shadow ? {} : { shadow: 1 }),
    ...(o.dilate != null ? { dilate: o.dilate } : {}),
  };
}

/** 只算背景板：幾秒，而且看一眼就知道這段素材行不行。 */
export async function planPlate(video: string, o: RemoveObjectOpts): Promise<RemoveObjectResult> {
  return api.engineCall<RemoveObjectResult>("inpaint.remove", removeArgs(video, { ...o, outPath: null }), 10 * 60_000);
}

export async function removeObject(mediaId: string, video: string, o: RemoveObjectOpts): Promise<RemoveObjectResult> {
  return runEngineJob<RemoveObjectResult>({ kind: "export", mediaId, op: "inpaint.remove", args: removeArgs(video, o), step: "移除物件" });
}

/**
 * 背景板算完之後的一行人話。`t` 由呼叫端傳（這個模組不碰 i18n，純函式才好測）。
 *
 * 講的順序是「有沒有問題」而不是「數字」：覆蓋率不足與鏡頭在動是這條路唯二會失敗的原因，
 * 兩者都已經在引擎端擋下來了，所以走到這裡時要講的是「還剩多少不確定」。
 */
export function removeSummary(r: RemoveObjectResult, t: (zh: string, vars?: Record<string, string | number>) => string): string {
  const parts = [t("取樣 {n} 幀", { n: r.samples }), t("背景覆蓋率 {p}%", { p: (r.coverage * 100).toFixed(1) })];
  if (r.inpaintedPixels) parts.push(t("{n} 個像素整段沒露出過（只能靠補繪，會糊）", { n: r.inpaintedPixels }));
  else if (r.thinPixels) parts.push(t("{n} 個像素的乾淨取樣偏少", { n: r.thinPixels }));
  if (r.cameraShift > 1) parts.push(t("鏡頭略有位移 {px} px", { px: r.cameraShift.toFixed(1) }));
  return parts.join("・");
}


// ────────────────────────────────────────────────────────────────────────────
// 用文字找要移除的東西（不需要先在專案裡建追蹤與遮罩）
//
// 三支既有的 op 串起來：`seg.text_boxes`（文字 → 框）→ `seg.run`（框 → 逐幀遮罩）
// → `inpaint.remove`（遮罩 → 補回背景）。**編排放在這裡而不是做成一支引擎 op**：
// `ops/run.py` 的前例是「op 用底層模組，不互相呼叫」，在引擎裡串會變成第三份
// SAM 傳播的實作（run.py 與 seg.py 已經各有一份）。
// ────────────────────────────────────────────────────────────────────────────

export interface TextBoxHit {
  box: [number, number, number, number];
  phrase: string;
  score: number;
}

/** 一次最多追幾個物件。SAM 2.1 逐幀傳播的時間與物件數成正比，四個已經很久了。 */
export const MAX_REMOVE_OBJECTS = 4;

/**
 * 在哪一幀找目標。取範圍的**中點**而不是第一幀：開頭常常是淡入、還沒入鏡、或鏡頭還在動，
 * 在那裡找不到東西的機率比中間高得多。
 */
export function anchorFrame(range: FrameRange | null, nFrames: number): number {
  const [a, b] = range ? [range.in, range.out] : [0, Math.max(1, nFrames)];
  return Math.max(a, Math.min(b - 1, Math.floor((a + b) / 2)));
}

/** 候選框 → `seg.run --box` 的字串陣列（依分數高到低，最多 `MAX_REMOVE_OBJECTS` 個）。 */
export function boxArgs(hits: readonly TextBoxHit[], max = MAX_REMOVE_OBJECTS): string[] {
  return [...hits]
    .sort((x, y) => y.score - x.score)
    .slice(0, Math.max(1, max))
    .map((h) => h.box.map((v) => Math.round(v)).join(","));
}

/** 遮罩要寫哪：輸出影片旁邊的 `<stem>.masks/`，使用者找得到也刪得掉。 */
export function maskDirFor(outPath: string): string {
  return `${outPath.replace(/\.[^.\\/]+$/, "")}.masks`;
}

export interface FindAndTrackResult {
  /** 找到的候選框（全部，不只用到的那幾個）。 */
  hits: TextBoxHit[];
  /** 實際追蹤的物件遮罩檔。 */
  maskPaths: string[];
  anchor: number;
}

/**
 * 文字 → 框 → 逐幀遮罩。**慢的那一步**（SAM 2.1 逐幀傳播），所以獨立成一步讓 UI 顯示進度，
 * 跑完之後「算背景板 / 移除並輸出」跟既有的那條路完全一樣。
 */
export async function findAndTrack(
  mediaId: string,
  video: string,
  text: string,
  range: FrameRange | null,
  nFrames: number,
  outPath: string,
  sam: string,
): Promise<FindAndTrackResult> {
  const anchor = anchorFrame(range, nFrames);
  const found = await api.engineCall<{ boxes: TextBoxHit[] }>("seg.text_boxes", { video, frame: anchor, text }, 10 * 60_000);
  const hits = found.boxes ?? [];
  if (!hits.length) throw new Error(`在第 ${anchor} 幀找不到「${text}」：換個說法（英文通常比較準），或把播放線移到目標清楚可見的地方再試`);

  const [k0, k1] = range ? [range.in, range.out] : [0, nFrames];
  const seg = await runEngineJob<{ objects?: { path: string }[] }>({
    kind: "mask",
    mediaId,
    op: "seg.run",
    args: { video, frames: `${k0}:${k1}`, box: boxArgs(hits), anchor, dir: "both", out: maskDirFor(outPath), sam, previews: 0 },
    step: "追蹤遮罩",
  });
  const maskPaths = (seg.objects ?? []).map((o) => o.path).filter(Boolean);
  if (!maskPaths.length) throw new Error("追蹤沒有產生任何遮罩");
  return { hits, maskPaths, anchor };
}
