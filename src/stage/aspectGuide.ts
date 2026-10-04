/**
 * 畫面比例參考線：在舞台上框出「裁成 9:16 之後會留下哪一塊」。
 *
 * 為什麼要跟引擎算出**一模一樣**的框：這條線的用途是「拍 / 剪的時候把主體放進去」，
 * 它如果只是大概的比例框，使用者照著擺好、輸出之後卻差了 2%，那比沒有還糟。
 * 所以這裡把引擎 `aivc/reframe/path.py` 的 `crop_size()` 規則照抄一份（見下），
 * 並用同一組已知答案的案例釘住（1920×1080 取 9:16 = 594×1056）。
 *
 * 同一條規則有兩份實作是有漂移風險的，但替代方案是「為了畫一條線去呼叫引擎」——
 * 那會讓一個純視覺的輔助線依賴 GPU 行程有沒有啟動。取捨寫在這裡，測試負責擋漂移。
 */

/** 對外提供的比例。`null` = 關閉。 */
export const ASPECT_GUIDES = ["9:16", "4:5", "1:1", "16:9"] as const;
export type AspectGuide = (typeof ASPECT_GUIDES)[number];

export interface GuideRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

/**
 * 塞得進來源、長寬比**精確**、長寬都是偶數的最大裁切尺寸。
 *
 * 與 `engine/src/aivc/reframe/path.py: crop_size()` 同一條規則：
 * 找最大的 k 使 (aw·k, ah·k) 都是偶數且塞得下。偶數是 yuv420 的硬性要求，
 * 而「比例精確」是為了不讓上傳平台再補一次黑邊（1920×1080 取 9:16 的理論最大是
 * 607.5×1080，取整成 608 之後比例就不是 0.5625 了）。
 */
export function cropSize(srcW: number, srcH: number, aspect: AspectGuide): GuideRect | null {
  if (!(srcW >= 2) || !(srcH >= 2)) return null;
  const [rawW, rawH] = aspect.split(":").map(Number);
  if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW <= 0 || rawH <= 0) return null;
  const g = gcd(rawW, rawH);
  const aw = rawW / g;
  const ah = rawH / g;
  // 其中一邊是奇數時 k 必須是偶數，兩邊才都會是偶數
  const step = aw % 2 === 0 && ah % 2 === 0 ? 1 : 2;
  const k = Math.floor(Math.min(srcW / aw, srcH / ah) / step) * step;
  if (k < step) return null;
  const w = aw * k;
  const h = ah * k;
  return { x: Math.floor((srcW - w) / 4) * 2, y: Math.floor((srcH - h) / 4) * 2, w, h };
}

/** 比例框佔來源畫面的比例（給一句「會留下 55% 的畫面」用）。 */
export function guideCoverage(src: GuideRect | null, srcW: number, srcH: number): number {
  if (!src || srcW <= 0 || srcH <= 0) return 0;
  return (src.w * src.h) / (srcW * srcH);
}
