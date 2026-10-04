import { crisp, type Palette } from "../stage/paint";
import { xOfFrame, type FrameRange } from "../store/timeline";

/**
 * 範圍列（尺規與鏡頭帶之間）的純算術與繪圖。
 *
 * 從 draw.ts 拆出來：draw.ts 已經四百多行，而範圍列有自己的命中規則（hit.ts 用同一組常數），
 * 放一起的話改握把寬度要在兩個大檔之間找數字。
 */

/** 範圍端點握把的命中容忍（px）。比菱形小一點：握把貼著本體，容忍太大會讓短範圍的本體點不到。 */
export const RANGE_HANDLE_HIT_PX = 5;
/** 本體夠寬才畫 Premiere 式三條握紋 / 帶內長度字；太窄時硬畫會糊成一團。 */
export const RANGE_GRIP_MIN_PX = 24;
export const RANGE_LABEL_MIN_PX = 60;
/** 握把實心寬度。 */
export const RANGE_HANDLE_W = 3;
/** 空帶提示字左右各要留的空白；放不下就不畫（半截字比沒有字更糟）。 */
export const RANGE_HINT_PAD_PX = 12;

export type RangePart = "in" | "out" | "body";

export interface RangeBandGeometry {
  /** 本體在畫面上的 x（已夾在 [-1, width+1]）；null = 沒有完整範圍或整段在畫面外。 */
  body: { x0: number; x1: number } | null;
  /** 兩端握把的真實 x（不夾；畫面外的握把不畫）。 */
  inX: number | null;
  outX: number | null;
  grips: boolean;
  label: boolean;
  /** 只標了單邊時畫括號：`in` = `[`、`out` = `]`。 */
  brackets: { x: number; side: "in" | "out" }[];
}

/**
 * 範圍列要畫什麼。握紋 / 長度字看的是**可見**寬度：範圍一半捲出畫面時，
 * 字要擠在看得到的那段裡，不然會畫到畫面外去、使用者以為字不見了。
 */
export function rangeBandGeometry(
  range: FrameRange | null,
  pendingIn: number | null,
  pendingOut: number | null,
  scrollFrame: number,
  pxPerFrame: number,
  width: number,
): RangeBandGeometry {
  const xf = (f: number) => xOfFrame(f, scrollFrame, pxPerFrame);
  const brackets: RangeBandGeometry["brackets"] = [];
  if (!range) {
    if (pendingIn != null) brackets.push({ x: xf(pendingIn), side: "in" });
    if (pendingOut != null) brackets.push({ x: xf(pendingOut), side: "out" });
    return { body: null, inX: null, outX: null, grips: false, label: false, brackets };
  }
  const inX = xf(range.in);
  const outX = xf(range.out);
  const x0 = Math.max(-1, inX);
  const x1 = Math.min(width + 1, outX);
  const visible = x1 > x0 && outX >= 0 && inX <= width;
  const w = visible ? x1 - x0 : 0;
  return {
    body: visible ? { x0, x1 } : null,
    inX,
    outX,
    grips: w > RANGE_GRIP_MIN_PX,
    label: w > RANGE_LABEL_MIN_PX,
    brackets,
  };
}

export interface RangeBandDraw {
  y: number;
  h: number;
  width: number;
  scrollFrame: number;
  pxPerFrame: number;
  range: FrameRange | null;
  pendingIn: number | null;
  pendingOut: number | null;
  /** 滑鼠停在哪一段（握把亮起來，告訴使用者「這裡可以拖」）。 */
  hover: RangePart | null;
  /** 正在拖（本體整段亮起來）。 */
  dragging: boolean;
  /**
   * 帶內長度字的候選，長的在前（「00:00:02:10 · 70 幀」、「70 幀」）：放得下哪個就畫哪個。
   * 呼叫端先 t() 好，這個檔不碰 i18n。
   */
  labels: readonly string[];
  /**
   * 還沒有範圍時畫在帶子中央的提示字（呼叫端先 t() 好；null / 空字串＝不畫）。
   *
   * 為什麼需要：沒有範圍時這條帶子就是一條素色的細條，畫面上**沒有任何東西**說它可以拖。
   * 建立範圍的四種方法（I / O、拖這條帶子、時間軸任何地方 Shift+拖、右鍵）全都要先知道才用得到，
   * 於是「選取區間」變成一個藏起來的功能 —— 使用者回報時就是這樣：功能早就做好了，但找不到。
   */
  emptyHint?: string | null;
  /** 滑鼠停在範圍列的空白處（提示字亮一點，回應「這裡真的可以按」）。 */
  hoverEmpty?: boolean;
}

/** 沒有範圍時的置中提示字。放不下就不畫：半截字比沒有字更糟。 */
function drawEmptyHint(ctx: CanvasRenderingContext2D, d: RangeBandDraw, pal: Palette): void {
  const text = d.emptyHint;
  if (!text) return;
  ctx.font = "9px Inter Variable, system-ui, sans-serif";
  const w = ctx.measureText(text).width;
  if (w + RANGE_HINT_PAD_PX * 2 > d.width) return;
  ctx.textBaseline = "middle";
  ctx.fillStyle = pal("fg", d.hoverEmpty ? 0.75 : 0.4);
  ctx.fillText(text, Math.round((d.width - w) / 2), d.y + d.h / 2 + 0.5);
}

export function drawRangeBand(ctx: CanvasRenderingContext2D, d: RangeBandDraw, pal: Palette): void {
  const { y, h, width } = d;
  ctx.fillStyle = pal("inset", 0.5);
  ctx.fillRect(0, y, width, h);
  const g = rangeBandGeometry(d.range, d.pendingIn, d.pendingOut, d.scrollFrame, d.pxPerFrame, width);

  // 完全空的時候才提示：已經標了單邊（括號）就是「正在選」，那時候再叫人來選會很吵
  if (!g.body && !g.brackets.length) drawEmptyHint(ctx, d, pal);

  if (g.body) {
    const { x0, x1 } = g.body;
    ctx.fillStyle = pal("accent", d.dragging ? 0.5 : 0.35);
    ctx.fillRect(x0, y, x1 - x0, h);
    if (g.grips) {
      // Premiere 的三條握紋：暗示「中間可以抓著平移」
      const cx = Math.round((x0 + x1) / 2);
      ctx.strokeStyle = pal("fg", d.hover === "body" || d.dragging ? 0.85 : 0.55);
      ctx.lineWidth = 1;
      for (const dx of [-3, 0, 3]) {
        ctx.beginPath();
        ctx.moveTo(crisp(cx + dx), y + 2);
        ctx.lineTo(crisp(cx + dx), y + h - 2);
        ctx.stroke();
      }
      if (g.label && d.labels.length) {
        ctx.font = "9px Inter Variable, system-ui, sans-serif";
        ctx.textBaseline = "middle";
        // 字放在握紋右邊；可見寬度不夠放長字就退短字，都放不下就不放（寧可沒有，不要蓋到握把上）
        const fit = d.labels.find((text) => cx + 8 + ctx.measureText(text).width < x1 - RANGE_HANDLE_W - 2);
        if (fit) {
          ctx.fillStyle = pal("fg", 0.9);
          ctx.fillText(fit, cx + 8, y + h / 2 + 0.5);
        }
      }
    }
  }

  for (const [x, part] of [
    [g.inX, "in"],
    [g.outX, "out"],
  ] as const) {
    if (x == null || x < -RANGE_HANDLE_W || x > width + RANGE_HANDLE_W) continue;
    ctx.fillStyle = pal("accent", d.hover === part ? 1 : 0.85);
    // 握把往範圍內側長：in 在邊界右邊、out 在邊界左邊，兩端貼在一起時才不會互相蓋掉
    const hx = part === "in" ? Math.round(x) : Math.round(x) - RANGE_HANDLE_W;
    const extra = d.hover === part ? 1 : 0;
    ctx.fillRect(hx - (part === "in" ? 0 : extra), y, RANGE_HANDLE_W + extra, h);
  }

  if (g.brackets.length) {
    ctx.strokeStyle = pal("accent");
    ctx.lineWidth = 1.5;
    for (const b of g.brackets) {
      if (b.x < -6 || b.x > width + 6) continue;
      const x = crisp(b.x);
      const arm = b.side === "in" ? 4 : -4;
      ctx.beginPath();
      ctx.moveTo(x + arm, y + 1);
      ctx.lineTo(x, y + 1);
      ctx.lineTo(x, y + h - 1);
      ctx.lineTo(x + arm, y + h - 1);
      ctx.stroke();
    }
  }
}
