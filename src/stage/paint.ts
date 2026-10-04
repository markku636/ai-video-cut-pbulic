/**
 * canvas 圖層共用的上色 / DPR 工具（VideoStage 疊層與 FrameTimeline 都用）。
 *
 * 顏色**只**從 CSS 變數讀（tailwind.config.js 顏色表 + styles.css / themes.ts 給值），
 * 這樣換主題時 canvas 跟 DOM 一起翻，而且 check-theme-tokens.mjs 管得到的名字這裡也一樣管得到。
 * 值是 "R G B" 三通道字串，拼成 `rgb(R G B / a)`。
 */

export const TOKEN = {
  user: "--c-track-user",
  solver: "--c-track-solver",
  lost: "--c-track-lost",
  occluded: "--c-track-occluded",
  maskPos: "--c-mask-pos",
  maskNeg: "--c-mask-neg",
  shot: "--c-shot",
  preview: "--c-preview",
  accent: "--c-accent",
  fg: "--c-fg",
  app: "--c-app",
  well: "--c-well",
  inset: "--c-inset",
  panel: "--c-panel",
  success: "--c-success",
  warning: "--c-warning",
  danger: "--c-danger",
  info: "--c-info",
} as const;

export type TokenName = keyof typeof TOKEN;

/** 沿用 ai-music-cut PlayheadOverlay.tsx 的 cssRgb：查不到值時退回前景白，不會畫出透明線。 */
export function cssRgb(varName: string, alpha = 1): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || "248 248 242";
  return `rgb(${v} / ${alpha})`;
}

/** 一次讀完整套語意色；每個圖層自己呼叫 getComputedStyle 會在一幀裡讀幾十次。 */
export type Palette = (name: TokenName, alpha?: number) => string;

export function palette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const cache = new Map<TokenName, string>();
  return (name, alpha = 1) => {
    let v = cache.get(name);
    if (v === undefined) {
      v = cs.getPropertyValue(TOKEN[name]).trim() || "248 248 242";
      cache.set(name, v);
    }
    return `rgb(${v} / ${alpha})`;
  };
}

/**
 * 把 canvas 的位圖尺寸對齊 CSS 尺寸 × DPR，回傳已 setTransform 的 ctx（之後全部用 CSS px 畫）。
 * 尺寸沒變就不重設 width/height —— 設一次就會把整張 canvas 清空並重新配置記憶體。
 */
export function setupCanvas(cv: HTMLCanvasElement, w: number, h: number, dpr: number): CanvasRenderingContext2D | null {
  const bw = Math.max(1, Math.round(w * dpr));
  const bh = Math.max(1, Math.round(h * dpr));
  if (cv.width !== bw || cv.height !== bh) {
    cv.width = bw;
    cv.height = bh;
  }
  if (cv.style.width !== `${w}px`) cv.style.width = `${w}px`;
  if (cv.style.height !== `${h}px`) cv.style.height = `${h}px`;
  const ctx = cv.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

/** 1 px 線要落在半格上才不會糊成 2 px 的灰線。 */
export function crisp(x: number): number {
  return Math.round(x) + 0.5;
}
