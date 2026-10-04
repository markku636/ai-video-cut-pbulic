import { describe, expect, it } from "vitest";
import type { Palette } from "../stage/paint";
import { drawRangeBand, RANGE_HANDLE_W, rangeBandGeometry } from "./rangeBand";

describe("frametimeline/rangeBand：幾何", () => {
  it("沒有範圍也沒有暫存 → 什麼都不畫", () => {
    expect(rangeBandGeometry(null, null, null, 0, 4, 400)).toEqual({ body: null, inX: null, outX: null, grips: false, label: false, brackets: [] });
  });

  it("只標了入點 / 出點 → 括號，不畫本體", () => {
    const g = rangeBandGeometry(null, 10, null, 0, 4, 400);
    expect(g.body).toBeNull();
    expect(g.brackets).toEqual([{ x: 40, side: "in" }]);
    expect(rangeBandGeometry(null, null, 25, 5, 4, 400).brackets).toEqual([{ x: 80, side: "out" }]);
  });

  it("本體 x 對齊幀邊界；寬 > 24 px 畫握紋、> 60 px 寫長度", () => {
    // [10, 30) @ 4 px/幀 = 40..120，80 px 寬
    const g = rangeBandGeometry({ in: 10, out: 30 }, null, null, 0, 4, 400);
    expect(g.body).toEqual({ x0: 40, x1: 120 });
    expect(g.inX).toBe(40);
    expect(g.outX).toBe(120);
    expect(g.grips).toBe(true);
    expect(g.label).toBe(true);
    // 5 幀 = 20 px：握紋和字都不畫（擠不下）
    const narrow = rangeBandGeometry({ in: 10, out: 15 }, null, null, 0, 4, 400);
    expect(narrow.grips).toBe(false);
    expect(narrow.label).toBe(false);
    // 10 幀 = 40 px：只有握紋
    const mid = rangeBandGeometry({ in: 10, out: 20 }, null, null, 0, 4, 400);
    expect(mid.grips).toBe(true);
    expect(mid.label).toBe(false);
  });

  it("握紋 / 字看可見寬度：範圍大半捲出畫面時不硬塞字", () => {
    // [0, 100) 捲到 95 → 只剩 5 幀 = 20 px 露出來
    const g = rangeBandGeometry({ in: 0, out: 100 }, null, null, 95, 4, 400);
    expect(g.body).toEqual({ x0: -1, x1: 20 });
    expect(g.inX).toBe(-380);
    expect(g.label).toBe(false);
    // 整段在畫面右邊外
    const off = rangeBandGeometry({ in: 500, out: 600 }, null, null, 0, 4, 400);
    expect(off.body).toBeNull();
    expect(off.grips).toBe(false);
  });
});

interface Call {
  op: string;
  args: number[];
  style?: string;
}

function recorder() {
  const calls: Call[] = [];
  const ctx = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textBaseline: "alphabetic",
    fillRect(...args: number[]) {
      calls.push({ op: "fillRect", args, style: String(this.fillStyle) });
    },
    beginPath() {},
    moveTo(...args: number[]) {
      calls.push({ op: "moveTo", args });
    },
    lineTo(...args: number[]) {
      calls.push({ op: "lineTo", args });
    },
    stroke() {
      calls.push({ op: "stroke", args: [] });
    },
    measureText: (s: string) => ({ width: s.length * 5 }),
    fillText(text: string, ...args: number[]) {
      calls.push({ op: `fillText:${text}`, args });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const pal: Palette = (name, alpha = 1) => `${name}/${alpha}`;

describe("frametimeline/rangeBand：繪圖", () => {
  const base = { y: 22, h: 10, width: 400, scrollFrame: 0, pxPerFrame: 4, pendingIn: null, pendingOut: null, hover: null, dragging: false, labels: ["00:00:00:20 · 20 幀", "20 幀"] };

  it("握把往範圍內側長：in 在邊界右邊、out 在邊界左邊", () => {
    const { ctx, calls } = recorder();
    drawRangeBand(ctx, { ...base, range: { in: 10, out: 30 } }, pal);
    const handles = calls.filter((c) => c.op === "fillRect" && c.style === "accent/0.85");
    expect(handles.map((c) => c.args)).toEqual([
      [40, 22, RANGE_HANDLE_W, 10],
      [120 - RANGE_HANDLE_W, 22, RANGE_HANDLE_W, 10],
    ]);
    // 80 px 寬、握紋中心 x=80：長字（18 字 × 5 px）放不下 → 退短字
    expect(calls.filter((c) => c.op.startsWith("fillText:")).map((c) => c.op)).toEqual(["fillText:20 幀"]);
  });

  it("放得下就畫長字（時間碼 · 幀數）", () => {
    const { ctx, calls } = recorder();
    // [0, 100) = 400 px
    drawRangeBand(ctx, { ...base, range: { in: 0, out: 100 } }, pal);
    expect(calls.filter((c) => c.op.startsWith("fillText:")).map((c) => c.op)).toEqual(["fillText:00:00:00:20 · 20 幀"]);
  });

  it("hover 的握把變亮變寬；沒有範圍時只有底色", () => {
    const { ctx, calls } = recorder();
    drawRangeBand(ctx, { ...base, range: { in: 10, out: 30 }, hover: "out" }, pal);
    expect(calls.find((c) => c.op === "fillRect" && c.style === "accent/1")?.args).toEqual([120 - RANGE_HANDLE_W - 1, 22, RANGE_HANDLE_W + 1, 10]);
    const empty = recorder();
    drawRangeBand(empty.ctx, { ...base, range: null }, pal);
    expect(empty.calls.filter((c) => c.op === "fillRect")).toEqual([{ op: "fillRect", args: [0, 22, 400, 10], style: "inset/0.5" }]);
  });
});

describe("frametimeline/rangeBand：空帶提示（「選取區間」找不到的那個 bug）", () => {
  const base = {
    y: 22,
    h: 10,
    width: 400,
    scrollFrame: 0,
    pxPerFrame: 4,
    pendingIn: null,
    pendingOut: null,
    hover: null,
    dragging: false,
    labels: [],
    emptyHint: "拖曳這裡選取區間",
  };
  const hints = (calls: Call[]) => calls.filter((c) => c.op.startsWith("fillText:"));

  it("沒有範圍時畫提示字，而且置中", () => {
    const { ctx, calls } = recorder();
    drawRangeBand(ctx, { ...base, range: null }, pal);
    // recorder 的 measureText 是每字 5 px：8 字 = 40 px，置中 → (400 - 40) / 2
    expect(hints(calls).map((c) => [c.op, c.args[0]])).toEqual([["fillText:拖曳這裡選取區間", 180]]);
  });

  it("有範圍就不畫（帶子已經在說話了）", () => {
    const { ctx, calls } = recorder();
    drawRangeBand(ctx, { ...base, range: { in: 10, out: 30 } }, pal);
    expect(hints(calls).map((c) => c.op)).not.toContain("fillText:拖曳這裡選取區間");
  });

  it("標了單邊（正在選）也不畫 —— 那時候再叫人來選很吵", () => {
    const { ctx, calls } = recorder();
    drawRangeBand(ctx, { ...base, range: null, pendingIn: 10 }, pal);
    expect(hints(calls)).toEqual([]);
  });

  it("滑鼠停在空白帶上時亮一點", () => {
    const dim = recorder();
    drawRangeBand(dim.ctx, { ...base, range: null }, pal);
    const lit = recorder();
    drawRangeBand(lit.ctx, { ...base, range: null, hoverEmpty: true }, pal);
    // 只比對 fillStyle：alpha 由 pal 帶出來（"fg/0.32" vs "fg/0.6"）
    expect(dim.ctx.fillStyle).not.toBe(lit.ctx.fillStyle);
  });

  it("窄到放不下就不畫（半截字比沒有字更糟）", () => {
    const { ctx, calls } = recorder();
    drawRangeBand(ctx, { ...base, range: null, width: 50 }, pal);
    expect(hints(calls)).toEqual([]);
  });

  it("沒給提示字就什麼都不畫（不是每個呼叫端都要提示）", () => {
    const { ctx, calls } = recorder();
    drawRangeBand(ctx, { ...base, range: null, emptyHint: null }, pal);
    expect(hints(calls)).toEqual([]);
  });
});
