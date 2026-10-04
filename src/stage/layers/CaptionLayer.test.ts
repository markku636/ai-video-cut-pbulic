// 字幕動畫曲線 / 逐字狀態 / 近似版面：規格 §5.3 的數字直接寫死，再跟引擎共用的 anim.golden.json 逐值比（檔案在才比）。
import { describe, expect, it } from "vitest";
import type { CaptionWordV1 } from "../../project/format";
import { CAPTION_PRESETS, deepMerge } from "../../store/captions";
import {
  activeWindow,
  boxMoveT,
  breakLines,
  cueAnimAt,
  easeOutBack,
  easeOutCubic,
  greedyLines,
  layoutCue,
  pickColor,
  popLineCenters,
  quantizeScale,
  safeRect,
  springDy,
  stripLineEnd,
  stripLineEndTokens,
  tauSeconds,
  trimLineEndPunct,
  typewriterChars,
  wipeProgress,
  wordPopScale,
  wordStateAt,
  type MeasureFn,
} from "./CaptionLayer";

const F30 = { num: 30, den: 1 };

function words(starts: number[], ends: number[]): CaptionWordV1[] {
  return starts.map((s, i) => ({ text: `w${i}`, startFrame: s, endFrame: ends[i] }));
}

describe("緩動曲線（規格 §5.3 F）", () => {
  it("easeOutCubic(0.5) = 0.875；easeOutBack 0→0、1→1、0.5→1.0876975", () => {
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 9);
    expect(easeOutBack(0)).toBeCloseTo(0, 9);
    expect(easeOutBack(1)).toBeCloseTo(1, 9);
    expect(easeOutBack(0.5)).toBeCloseTo(1.0876975, 7);
  });
  it("easeOutBack 峰值 1.1000 在 t = 0.5801（±1e-4）", () => {
    let best = { t: 0, v: 0 };
    for (let i = 0; i <= 100_000; i++) {
      const t = i / 100_000;
      const v = easeOutBack(t);
      if (v > best.v) best = { t, v };
    }
    expect(Math.abs(best.t - 0.5801)).toBeLessThan(1e-4);
    expect(Math.abs(best.v - 1.1)).toBeLessThan(1e-4);
  });
  it("輸入夾在 [0,1]（跟引擎一樣）", () => {
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutBack(2)).toBe(1);
  });
  it("彈簧：τ=0 位移 −A、ω_d ≈ 29.43、0.356 s 之後包絡 ≤ 2%；τ<0 → −A", () => {
    expect(springDy(0, 1)).toBeCloseTo(-1, 9);
    expect(springDy(-0.1, 0.25)).toBe(-0.25);
    const wd = 2 * Math.PI * 5 * Math.sqrt(1 - 0.35 ** 2);
    expect(wd).toBeCloseTo(29.43, 2);
    for (let tau = 0.357; tau < 1.5; tau += 0.001) expect(Math.abs(springDy(tau, 1))).toBeLessThanOrEqual(0.02);
  });
  it("τ 取幀中心：(k + 0.5 − k_event)·den/num；縮放量化 1/64", () => {
    expect(tauSeconds(10, 10, F30)).toBeCloseTo(1 / 60, 12);
    expect(tauSeconds(1799, 0, { num: 30000, den: 1001 })).toBeCloseTo((1799.5 * 1001) / 30000, 12);
    expect(quantizeScale(1.0876975)).toBe(70 / 64);
  });
});

describe("逐字狀態（規格 §5.3 E）", () => {
  const ws = words([10, 16, 25], [14, 22, 30]);
  it("作用中區間 A_i = [s_i, s_{i+1})，最後一個字到段尾；邊界幀", () => {
    expect(activeWindow(ws, 0, 34)).toEqual([10, 16]);
    expect(activeWindow(ws, 2, 34)).toEqual([25, 34]);
    expect(wordStateAt(ws, 0, 9, 34)).toBe("future");
    expect(wordStateAt(ws, 0, 10, 34)).toBe("active");
    expect(wordStateAt(ws, 0, 15, 34)).toBe("active");
    expect(wordStateAt(ws, 0, 16, 34)).toBe("past");
    expect(wordStateAt(ws, 2, 33, 34)).toBe("active");
    expect(wordStateAt(ws, 2, 34, 34)).toBe("past");
  });
  it("抹色進度與打字機字元數", () => {
    expect(wipeProgress(ws[1], 16)).toBeCloseTo(0.5 / 6, 12);
    expect(wipeProgress(ws[1], 30)).toBe(1);
    expect(typewriterChars("active", wipeProgress(ws[1], 16), 5)).toBe(1);
    expect(typewriterChars("active", wipeProgress(ws[1], 19), 5)).toBe(3);
    expect(typewriterChars("future", 0, 5)).toBe(0);
    expect(typewriterChars("past", 0, 5)).toBe(5);
  });
  it("跳字縮放：作用中彈大、離開後回落、未來不動；wordMs 0 直接切換", () => {
    expect(wordPopScale("future", 16, 25, 15, F30, 1.15, 120)).toBe(1);
    expect(wordPopScale("active", 16, 25, 16, F30, 1.15, 120)).toBeCloseTo(1 + 0.15 * easeOutBack(1000 / 60 / 120), 9);
    expect(wordPopScale("active", 16, 25, 24, F30, 1.15, 120)).toBeCloseTo(1.15, 9);
    expect(wordPopScale("past", 16, 25, 25, F30, 1.15, 120)).toBeCloseTo(1 + 0.15 * (1 - easeOutCubic(1000 / 60 / 120)), 9);
    expect(wordPopScale("active", 16, 25, 20, F30, 1.15, 0)).toBe(1.15);
    expect(boxMoveT(16, 16, F30, 0)).toBe(1);
  });
  it("段動畫：pop 從 0.7 彈到 1、fade 出場在段尾歸零", () => {
    const pop = CAPTION_PRESETS.pop.style.animation;
    const a0 = cueAnimAt(pop, { startFrame: 10, endFrame: 40 }, 10, F30);
    expect(a0.scale).toBeCloseTo(0.7 + 0.3 * easeOutBack(1000 / 60 / 150), 9);
    expect(a0.opacity).toBeCloseTo(easeOutCubic(1000 / 60 / 150), 9);
    expect(cueAnimAt(pop, { startFrame: 10, endFrame: 40 }, 30, F30)).toEqual({ opacity: 1, scale: 1, dyEm: 0 });
    const sub = CAPTION_PRESETS.subtitle.style.animation;
    expect(cueAnimAt(sub, { startFrame: 10, endFrame: 40 }, 39, F30).opacity).toBeCloseTo(1000 / 60 / 80, 9);
    const spring = cueAnimAt(CAPTION_PRESETS.bounce.style.animation, { startFrame: 0, endFrame: 30 }, 0, F30);
    expect(spring.dyEm).toBeLessThan(0);
  });
  it("顏色（= burn.pick_color）：明確狀態色優先，否則強調色 / 文字色", () => {
    const pop = CAPTION_PRESETS.pop.style.colors;
    expect(pickColor(pop, "active", false)).toBe("#FFE600");
    expect(pickColor(pop, "active", true)).toBe("#FFE600");
    expect(pickColor(pop, "future", true)).toBe("#22C55E");
    expect(pickColor(pop, "past", false)).toBe("#FFFFFF");
    expect(pickColor(CAPTION_PRESETS.karaoke.style.colors, "future", true)).toBe("#FFFFFF");
  });
});

describe("跳字整行重排（= burn.py cue_canvas）", () => {
  it("沒有放大 → 詞中心不動；中間詞放大 1.2 → 兩側往外推、詞距不變、整行中心不變", () => {
    const pieces = [
      { x: 100, w: 40 },
      { x: 150, w: 60 },
      { x: 220, w: 40 },
    ];
    expect(popLineCenters(pieces, [1, 1, 1], 100, 160)).toEqual([120, 180, 240]);
    const c = popLineCenters(pieces, [1, 1.2, 1], 100, 160);
    // 總寬 40 + 72 + 40 + 詞距 10·2 = 172，左緣 = 180 − 86 = 94
    expect(c[0]).toBeCloseTo(114, 9);
    expect(c[1]).toBeCloseTo(94 + 40 + 10 + 36, 9);
    expect(c[2]).toBeCloseTo(94 + 40 + 10 + 72 + 10 + 20, 9);
    expect(c[1] - 36 - (c[0] + 20)).toBeCloseTo(10, 9); // 放大的詞跟左鄰居之間仍是原詞距
    expect((c[0] - 20 + c[2] + 20) / 2).toBeCloseTo(180, 9); // 整行中心不變
  });
});

// golden 由引擎 golden_cases() 產生；放在 repo 根 fixtures/ 或 engine/tests/fixtures/ 都收（專案沒有 @types/node，用 import.meta.glob 讀）
const GOLDEN_FILES = { ...import.meta.glob("../../../fixtures/captions/anim.golden.json", { eager: true, import: "default" }), ...import.meta.glob("../../../engine/tests/fixtures/captions/anim.golden.json", { eager: true, import: "default" }) };
const GOLDEN = Object.values(GOLDEN_FILES)[0];

describe.skipIf(!GOLDEN)("共用 golden（aivc/captions/anim.py golden_cases）", () => {
  interface Golden {
    fps: { num: number; den: number };
    easeOutCubic: Record<string, number>;
    easeOutBack: Record<string, number>;
    spring: Record<string, number>;
    words: { starts: number[]; ends: number[]; cueEnd: number; states: Record<string, [string, number][]> };
    wordPop: { activeScale: number; wordMs: number; word: number; scale: Record<string, number> };
    typewriter: { word: number; chars: number; count: Record<string, number> };
    cue: Record<string, Record<string, [number, number, number]>>;
  }
  const g = (GOLDEN ?? null) as Golden | null;
  const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

  it("緩動 / 彈簧", () => {
    for (const [t, v] of Object.entries(g!.easeOutCubic)) close(easeOutCubic(Number(t)), v);
    for (const [t, v] of Object.entries(g!.easeOutBack)) close(easeOutBack(Number(t)), v);
    for (const [t, v] of Object.entries(g!.spring)) close(springDy(Number(t), 1), v);
  });
  it("逐字狀態 / 抹色進度 / 跳字縮放 / 打字機", () => {
    const { starts, ends, cueEnd, states } = g!.words;
    const ws = words(starts, ends);
    for (const [k, list] of Object.entries(states)) {
      list.forEach(([st, p], i) => {
        expect(wordStateAt(ws, i, Number(k), cueEnd), `k=${k} i=${i}`).toBe(st);
        close(wipeProgress(ws[i], Number(k)), p);
      });
    }
    const wp = g!.wordPop;
    for (const [k, v] of Object.entries(wp.scale)) {
      const kk = Number(k);
      const [a, b] = activeWindow(ws, wp.word, cueEnd);
      close(wordPopScale(wordStateAt(ws, wp.word, kk, cueEnd), a, b, kk, g!.fps, wp.activeScale, wp.wordMs), v);
    }
    const tw = g!.typewriter;
    for (const [k, n] of Object.entries(tw.count)) {
      const kk = Number(k);
      expect(typewriterChars(wordStateAt(ws, tw.word, kk, cueEnd), wipeProgress(ws[tw.word], kk), tw.chars), `k=${k}`).toBe(n);
    }
  });
  it("段動畫（opacity, scale, dyEm）", () => {
    for (const [kind, byK] of Object.entries(g!.cue)) {
      const ms = kind === "fade" ? 80 : kind === "pop" ? 150 : kind === "slideUp" ? 120 : 180;
      const anim = deepMerge(CAPTION_PRESETS.subtitle.style.animation, { cueIn: kind, cueInMs: ms, cueOut: "fade", cueOutMs: 80 });
      for (const [k, [op, sc, dy]] of Object.entries(byK)) {
        const a = cueAnimAt(anim, { startFrame: 10, endFrame: 40 }, Number(k), g!.fps);
        close(a.opacity, op);
        close(a.scale, sc);
        close(a.dyEm, dy);
      }
    }
  });
});

describe("斷行（規格 §5.3 G，假寬度）", () => {
  const cjk = (s: string) => [...s].length * 10;
  it("放得下就一行", () => {
    const toks = ["今", "天", "天", "氣", "好"];
    const r = breakLines(toks, toks.map(cjk), toks.map(() => 0), 100, 2)!;
    expect(r.lines).toEqual([[0, 5]]);
    expect(r.scale).toBe(1);
  });
  it("不在收尾標點前斷、不在開頭標點後斷", () => {
    const toks = ["一", "二", "三", "四", "，", "「五", "六", "七", "八」"];
    const r = breakLines(toks, toks.map(cjk), toks.map(() => 0), 60, 2)!;
    for (const [a] of r.lines) expect(toks[a].startsWith("，")).toBe(false);
    for (const [, b] of r.lines) expect(toks[b - 1].endsWith("「")).toBe(false);
    expect(r.lines.length).toBe(2);
  });
  it("逗號後斷行加分、金字塔：寧可上短下長", () => {
    const toks = ["我", "們", "今", "天，", "一", "起", "去", "吃", "飯"];
    const r = breakLines(toks, toks.map(cjk), toks.map(() => 0), 60, 2)!;
    expect(r.lines).toEqual([
      [0, 4],
      [4, 9],
    ]);
    expect(r.widths[0]).toBeLessThanOrEqual(r.widths[1]);
  });
  it("孤行：一行只剩一個中文字要付代價", () => {
    const toks = ["一", "二", "三", "四", "五", "六", "七"];
    const r = breakLines(toks, toks.map(cjk), toks.map(() => 0), 60, 2)!;
    expect(r.lines.every(([a, b]) => b - a > 1)).toBe(true);
  });
  it("放不下 → 字寬 ×0.9 / ×0.8 重試；再不行 → null（呼叫端貪婪換行標 overflow）", () => {
    const toks = ["一二三四五六七"];
    expect(breakLines(toks, [66], [0], 60, 2)!.scale).toBe(0.9);
    expect(breakLines(toks, [74], [0], 60, 2)!.scale).toBe(0.8);
    expect(breakLines(toks, [100], [0], 60, 2)).toBeNull();
    const g = greedyLines([30, 30, 30, 30], [0, 0, 0, 0], 60, 0.8);
    expect(g.overflow).toBe(true);
    expect(g.lines.length).toBeGreaterThan(1);
  });
});

// 鏡射 engine/tests/test_captions.py 的 test_strip_line_end_punctuation_rules / test_linebreak_ignores_line_final_punctuation_width（同樣的輸入、同樣的答案）
describe("行尾的 。，、 不顯示（= aivc/captions/text.py strip_line_end）", () => {
  it("只拿掉行尾的全形逗號 / 句號 / 頓號；問號、驚嘆號、刪節號、引號收尾、拉丁標點不動；整行只剩標點原樣", () => {
    expect([stripLineEnd("效果。"), stripLineEnd("贏了，"), stripLineEnd("甲、乙、")]).toEqual(["效果", "贏了", "甲、乙"]);
    expect([stripLineEnd("好嗎？"), stripLineEnd("太棒了！"), stripLineEnd("然後…"), stripLineEnd("他說「好。」")]).toEqual(["好嗎？", "太棒了！", "然後…", "他說「好。」"]);
    expect([stripLineEnd("好，。 "), stripLineEnd("。"), stripLineEnd("card,"), stripLineEnd("table.")]).toEqual(["好", "。", "card,", "table."]);
    expect(trimLineEndPunct("。")).toBe("");
    expect(stripLineEndTokens(["字幕", "的", "效果。"])).toEqual(["字幕", "的", "效果"]);
    expect(stripLineEndTokens(["好", "。"])).toEqual(["好", ""]);
    expect(stripLineEndTokens(["。", "，"])).toEqual(["。", "，"]);
  });

  // 假寬度同引擎 fake_measure：10 × 顯示單位（中日韓字含全形標點 = 2）
  const units = (s: string) => [...s].length * 20;
  const tailsOf = (toks: string[]) => toks.map((t) => units(t) - units(trimLineEndPunct(t)));

  it("行寬不算行尾的句號：十個字剛好放滿 + 句號仍是一行；行中的逗號照算、上一行寬度不含行尾逗號", () => {
    const a = [..."一二三四五六七八九十", "。"];
    const r = breakLines(a, a.map(units), a.map(() => 0), 200, 2, [], tailsOf(a))!;
    expect(r.lines).toEqual([[0, a.length]]);
    expect(r.widths).toEqual([200]);
    expect(breakLines(a, a.map(units), a.map(() => 0), 200, 2)!.lines).toHaveLength(2); // 不扣行尾寬度時（修正前）會擠成兩行

    const b = [..."一二三四五六七八", "，", ..."甲乙丙丁戊己庚辛壬"];
    const r2 = breakLines(b, b.map(units), b.map(() => 0), 180, 2, [], tailsOf(b))!;
    expect(b[r2.lines[0][1] - 1]).toBe("，");
    expect(r2.widths).toEqual([160, 180]);
    // 貪婪退路一樣扣：候選行的行尾是句號時不算它的寬度
    const g = greedyLines(a.map(units), a.map(() => 0), 200, 1, tailsOf(a));
    expect(g.lines).toEqual([[0, a.length]]);
    expect(g.widths).toEqual([200]);
  });

  it("近似版面：行尾句號不畫、不佔行寬；單獨一個「。」的詞不產生 piece；打字機以詞的原文長度算進度", () => {
    const measure: MeasureFn = (text, px) => [...text].length * px;
    const cue = { words: ["字幕", "的", "效果。", "。"].map((t, i) => ({ text: t, startFrame: i * 10, endFrame: i * 10 + 10 })) };
    const lay = layoutCue(cue, CAPTION_PRESETS.subtitle.style, 1280, 720, measure);
    expect(lay.lines).toHaveLength(1);
    const ln = lay.lines[0];
    expect(ln.pieces.map((p) => [p.word, p.text])).toEqual([
      [0, "字幕"],
      [1, "的"],
      [2, "效果"],
    ]);
    expect(ln.width).toBeCloseTo(5 * lay.fontPx, 6);
    expect(ln.left + ln.width / 2).toBeCloseTo(640, 6);
  });
});

describe("近似版面（= aivc/captions/layout.py）", () => {
  const measure: MeasureFn = (text, px) => [...text].reduce((w, ch) => w + (/[　-鿿＀-￯]/.test(ch) ? px : px * 0.5), 0);
  const cue = { words: [..."百家姓課堂開始了"].map((ch, i) => ({ text: ch, startFrame: i * 3, endFrame: i * 3 + 3 })) };

  it("安全區：橫式四邊 5%、直式（H/W ≥ 1.5）短影音邊界", () => {
    expect(safeRect("auto", 1280, 720)).toEqual([64, 36, 1216, 684]);
    const v = safeRect("auto", 1080, 1920);
    expect(v[0]).toBeCloseTo(64.8, 6);
    expect(v[3]).toBeCloseTo(1574.4, 6);
    expect(safeRect("none", 10, 10)).toEqual([0, 0, 10, 10]);
  });
  it("標準字幕：底部貼安全區、置中、字級 = 短邊 5.2%", () => {
    const lay = layoutCue(cue, CAPTION_PRESETS.subtitle.style, 1280, 720, measure);
    expect(lay.fontPx).toBeCloseTo(37.44, 6);
    expect(lay.lines).toHaveLength(1);
    const ln = lay.lines[0];
    expect(ln.top + ln.height).toBeCloseTo(684, 6);
    expect(ln.left + ln.width / 2).toBeCloseTo(640, 6);
    expect(lay.overflow).toBe(false);
  });
  it("跳字：middle 錨點 = 段中心在 78% H（橫式）/ 70% H（直式）", () => {
    const pop = CAPTION_PRESETS.pop.style;
    expect(layoutCue({ words: cue.words.slice(0, 3) }, pop, 1280, 720, measure).center[1]).toBeCloseTo(0.78 * 720, 6);
    expect(layoutCue({ words: cue.words.slice(0, 3) }, pop, 1080, 1920, measure).center[1]).toBeCloseTo(0.7 * 1920, 6);
  });
  it("offsetYPct：bottom 往上、top 往下；結果夾在安全區內", () => {
    const st = deepMerge(CAPTION_PRESETS.subtitle.style, { layout: { offsetYPct: 10 } });
    const up = layoutCue(cue, st, 1280, 720, measure).lines[0];
    expect(up.top + up.height).toBeCloseTo(684 - 72, 6);
    const clamp = layoutCue(cue, deepMerge(st, { layout: { anchor: "top", offsetYPct: -50 } }), 1280, 720, measure).lines[0];
    expect(clamp.top).toBeCloseTo(36, 6);
  });
  it("太長的一段：換兩行；兩行都塞不下就縮字；再不行標 overflow", () => {
    const long = { words: [..."這是一段非常非常長的字幕內容需要換行才能放得下而且還要更長一點"].map((ch, i) => ({ text: ch, startFrame: i, endFrame: i + 1 })) };
    const lay = layoutCue(long, CAPTION_PRESETS.subtitle.style, 1280, 720, measure);
    expect(lay.lines.length).toBe(2);
    const huge = layoutCue({ words: [...long.words, ...long.words, ...long.words].map((x, i) => ({ ...x, startFrame: i, endFrame: i + 1 })) }, CAPTION_PRESETS.subtitle.style, 1280, 720, measure);
    expect(huge.overflow).toBe(true);
  });
});
