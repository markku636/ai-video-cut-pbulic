// 字幕純邏輯：幀↔時間、斷詞 / 合字、重新配時、編輯 reducer 的不變式（不重疊、每段 ≥ 1 幀、字在段內、切完再併回原樣）。
import { describe, expect, it } from "vitest";
import type { CaptionCueV1, CaptionWordV1 } from "../project/format";
import {
  CAPTION_PRESETS,
  applyProposals,
  cueAtFrame,
  cueText,
  deepMerge,
  deleteCue,
  displayUnits,
  editedFlags,
  effectiveStyle,
  emptyCaptionTrack,
  findCues,
  fitWords,
  flaggedCueCount,
  frameOfSeconds,
  framesOfMs,
  freshLayoutCue,
  insertCueAt,
  joinWords,
  markEmphasis,
  mergeCueWithNext,
  msOfFrame,
  needsSpace,
  nextCueId,
  nudgeCue,
  outputLanguageFor,
  parseHotwords,
  parseLayoutDoc,
  parseTranscribeOptions,
  presetSegmentation,
  replaceInCues,
  retimeWords,
  setCueHidden,
  setCueText,
  splitCue,
  splitPointAt,
  srtTimestamp,
  toggleEmphasis,
  tokenizeText,
  vttTimestamp,
  type LoadedCaptionLayout,
} from "./captions";
import { parsePersisted } from "./ui";

// 專案沒有 @types/node：跨目錄讀檔用 Vite 的 import.meta.glob（檔案不存在就是空物件）
const ENGINE_PRESETS = Object.values(import.meta.glob("../../engine/src/aivc/captions/presets.v1.json", { eager: true, import: "default" }))[0] as { version: number; presets: unknown } | undefined;
const NTSC = { num: 30000, den: 1001 };
const F30 = { num: 30, den: 1 };

function w(text: string, s: number, e: number, extra: Partial<CaptionWordV1> = {}): CaptionWordV1 {
  return { text, startFrame: s, endFrame: e, ...extra };
}

/** 中文逐字的段：每個字 3 幀、從 start 起。 */
function zhCue(id: string, text: string, start: number, pad = 0): CaptionCueV1 {
  const words = [...text].map((ch, i) => w(ch, start + i * 3, start + i * 3 + 3));
  return { id, startFrame: start, endFrame: start + words.length * 3 + pad, words };
}

/** 不變式：段依時間排序且不重疊、每段 ≥ 1 幀；字排序、不重疊、每個字 ≥ 1 幀、都在段內。 */
function assertValid(cues: readonly CaptionCueV1[]) {
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    expect(c.endFrame, c.id).toBeGreaterThan(c.startFrame);
    if (i > 0) expect(c.startFrame, c.id).toBeGreaterThanOrEqual(cues[i - 1].endFrame);
    let prev = c.startFrame;
    for (const x of c.words) {
      expect(x.startFrame, `${c.id}:${x.text}`).toBeGreaterThanOrEqual(prev);
      expect(x.endFrame, `${c.id}:${x.text}`).toBeGreaterThan(x.startFrame);
      expect(x.endFrame, `${c.id}:${x.text}`).toBeLessThanOrEqual(c.endFrame);
      prev = x.endFrame;
    }
  }
}

describe("幀 ↔ 時間（規格 §5.3 A）", () => {
  it("30000/1001 的第 1799 幀 = 60027 ms = SRT 00:01:00,027；VTT 用小數點", () => {
    expect(msOfFrame(1799, NTSC)).toBe(60027);
    expect(srtTimestamp(msOfFrame(1799, NTSC))).toBe("00:01:00,027");
    expect(vttTimestamp(msOfFrame(1799, NTSC))).toBe("00:01:00.027");
    expect(srtTimestamp(3_723_004)).toBe("01:02:03,004");
  });
  it("秒 → 幀是 floor(t·num/den + 0.5)；毫秒長度 → 幀數四捨五入", () => {
    expect(frameOfSeconds(0.88, F30)).toBe(26);
    expect(frameOfSeconds(1.0, NTSC)).toBe(30);
    expect(frameOfSeconds(0.0166, F30)).toBe(0);
    expect(frameOfSeconds(0.0167, F30)).toBe(1);
    expect(framesOfMs(1500, F30)).toBe(45);
    expect(framesOfMs(833, F30)).toBe(25);
  });
});

describe("斷詞 / 合字", () => {
  it("中文逐字、收尾標點黏前一個字、開頭標點黏下一個字", () => {
    expect(tokenizeText("欢迎来到百家姓课堂。")).toEqual(["欢", "迎", "来", "到", "百", "家", "姓", "课", "堂。"]);
    expect(tokenizeText("「你好」，GPU")).toEqual(["「你", "好」，", "GPU"]);
    expect(tokenizeText("紅心8。")).toEqual(["紅", "心", "8。"]);
  });
  it("拉丁逐詞（空白切），標點留在詞上；中英混排拆開", () => {
    expect(tokenizeText("  Hello,  world!  ")).toEqual(["Hello,", "world!"]);
    expect(tokenizeText("使用GPU加速")).toEqual(["使", "用", "GPU", "加", "速"]);
  });
  it("合字：拉丁詞之間補空白（ASR 的前導空白先 trim）、中文之間不補；cjkLatinSpace 才在中英交界補", () => {
    expect(joinWords([" to", " the", " table."])).toBe("to the table.");
    expect(joinWords(["Hello,", "world"])).toBe("Hello, world");
    expect(joinWords(["使", "用", "GPU", "加", "速"])).toBe("使用GPU加速");
    expect(joinWords(["使", "用", "GPU", "加", "速"], true)).toBe("使用 GPU 加速");
    expect(joinWords(["牌，", "GPU"], true)).toBe("牌，GPU");
    expect(needsSpace("8", "%")).toBe(false);
  });
  it("顯示寬度：中文 / 全形標點 2、其餘 1", () => {
    expect(displayUnits("百家姓")).toBe(6);
    expect(displayUnits("牌，a")).toBe(5);
  });
});

describe("retimeWords（改字之後的字時間）", () => {
  const old = [w("欢", 10, 13), w("迎", 13, 16), w("来", 16, 19), w("到", 19, 30, { prob: 0.3 })];
  it("字數不變：沿用每個字原本的時間，改到的字標 user", () => {
    const out = retimeWords(old, "歡迎來到", 10, 40)!;
    expect(out.map((x) => [x.startFrame, x.endFrame])).toEqual(old.map((x) => [x.startFrame, x.endFrame]));
    expect(out.map((x) => x.text)).toEqual(["歡", "迎", "來", "到"]);
    expect(out[1]).toBe(old[1]);
    expect(out[0].source).toBe("user");
  });
  it("字數改變：總跨度不變、中文逐字、依寬度分配、每字 ≥ 1 幀", () => {
    const out = retimeWords(old, "歡迎大家來到這裡", 10, 40)!;
    expect(out.map((x) => x.text)).toEqual([..."歡迎大家來到這裡"]);
    expect(out[0].startFrame).toBe(10);
    expect(out[out.length - 1].endFrame).toBe(30);
    assertValid([{ id: "c", startFrame: 10, endFrame: 40, words: out }]);
  });
  it("跨度不夠一字一幀：先退到整段，再不夠就把字併起來", () => {
    const tight = [w("a", 5, 6), w("b", 6, 7)];
    const out = retimeWords(tight, "one two three four", 5, 8)!;
    expect(out.length).toBeLessThanOrEqual(3);
    expect(out[0].startFrame).toBe(5);
    expect(out[out.length - 1].endFrame).toBe(8);
    assertValid([{ id: "c", startFrame: 5, endFrame: 8, words: out }]);
  });
  it("清空 → null", () => {
    expect(retimeWords(old, "   ", 10, 40)).toBeNull();
  });
});

describe("fitWords：把字塞進 [start, end)", () => {
  it("隨機案例：只要 end − start ≥ 字數，結果永遠合法", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let n = 0; n < 300; n++) {
      const count = 1 + Math.floor(rnd() * 6);
      const words: CaptionWordV1[] = [];
      let f = Math.floor(rnd() * 20);
      for (let i = 0; i < count; i++) {
        const s = f + Math.floor(rnd() * 3);
        const e = s + 1 + Math.floor(rnd() * 5);
        words.push(w(`w${i}`, s, e));
        f = e;
      }
      const start = Math.floor(rnd() * 30);
      const end = start + count + Math.floor(rnd() * 10);
      const out = fitWords(words, start, end);
      assertValid([{ id: "x", startFrame: start, endFrame: end, words: out }]);
      expect(out.length).toBe(count);
    }
  });
});

describe("編輯 reducer", () => {
  const cues = [zhCue("c1", "百家姓課堂", 0, 5), zhCue("c2", "店家翻牌", 40)];

  it("splitCue：在字邊界把段的幀分成兩半，字時間一格都不動；再合併回原樣", () => {
    const out = splitCue(cues, "c1", 2)!;
    expect(out.map((c) => c.id)).toEqual(["c1", "c3", "c2"]);
    expect(out[0]).toMatchObject({ startFrame: 0, endFrame: 6 });
    expect(out[1]).toMatchObject({ startFrame: 6, endFrame: 20 });
    expect([...out[0].words, ...out[1].words]).toEqual(cues[0].words);
    expect(out[0].flags).toContain("edited");
    assertValid(out);
    const back = mergeCueWithNext(out, "c1")!;
    expect(back[0]).toMatchObject({ id: "c1", startFrame: 0, endFrame: 20 });
    expect(back[0].words).toEqual(cues[0].words);
    expect(splitCue(cues, "c1", 0)).toBeNull();
    expect(splitCue(cues, "c1", 5)).toBeNull();
    expect(splitCue(cues, "nope", 1)).toBeNull();
  });

  it("splitPointAt：播放線落在的段、最近的字邊界；段只有一個字 → null", () => {
    expect(splitPointAt(cues, 7)).toEqual({ cueId: "c1", wordIndex: 2 });
    expect(splitPointAt(cues, 1)).toEqual({ cueId: "c1", wordIndex: 1 });
    expect(splitPointAt(cues, 30)).toBeNull();
    expect(splitPointAt([zhCue("x", "好", 0)], 1)).toBeNull();
  });

  it("mergeCueWithNext：最後一段不能合併", () => {
    expect(mergeCueWithNext(cues, "c2")).toBeNull();
  });

  it("nudgeCue：不跟前後段重疊、段長 ≥ 字數、不出 [0, frames]；整段移動時字一起平移", () => {
    const later = nudgeCue(cues, "c2", -100, "start")!;
    expect(later[1].startFrame).toBe(cues[0].endFrame);
    assertValid(later);
    const shrink = nudgeCue(cues, "c2", 100, "start")!;
    expect(shrink[1].endFrame - shrink[1].startFrame).toBe(cues[1].words.length);
    assertValid(shrink);
    expect(nudgeCue(cues, "c1", 999, "end")![0].endFrame).toBe(40);
    expect(nudgeCue(cues, "c2", 999, "end", 60)![1].endFrame).toBe(60);
    const moved = nudgeCue(cues, "c2", 3, "both", 100)!;
    expect(moved[1].startFrame).toBe(43);
    expect(moved[1].words.map((x) => x.startFrame)).toEqual(cues[1].words.map((x) => x.startFrame + 3));
    expect(nudgeCue(cues, "c1", -5, "both")).toBeNull(); // 已經在 0
    expect(nudgeCue(cues, "c1", 0, "start")).toBeNull();
  });

  it("setCueText：沒變 → null；改了 → 重新配時、標 edited、低信心依剩下的字重算", () => {
    expect(setCueText(cues, "c1", "百家姓課堂")).toBeNull();
    const low: CaptionCueV1[] = [{ id: "a", startFrame: 0, endFrame: 10, words: [w("hello", 0, 5, { prob: 0.2 }), w("world", 5, 10, { prob: 0.9 })], flags: ["lowConfidence", "tooFast"] }];
    const out = setCueText(low, "a", "hi world")!;
    expect(out[0].words[0]).toMatchObject({ text: "hi", source: "user" });
    expect(out[0].words[0].prob).toBeUndefined();
    expect(out[0].flags).toEqual(["edited"]);
    expect(editedFlags({ words: low[0].words, flags: ["hallucination"] })).toEqual(["lowConfidence", "hallucination", "edited"]);
  });

  it("toggleEmphasis / setCueHidden / deleteCue", () => {
    const on = toggleEmphasis(cues, "c1", 1)!;
    expect(on[0].words[1].emphasis).toBe(true);
    expect(toggleEmphasis(on, "c1", 1)![0].words[1]).not.toHaveProperty("emphasis");
    expect(toggleEmphasis(cues, "c1", 99)).toBeNull();
    const hid = setCueHidden(cues, "c2", true)!;
    expect(hid[1].hidden).toBe(true);
    expect(setCueHidden(hid, "c2", true)).toBeNull();
    expect(setCueHidden(hid, "c2", false)![1]).not.toHaveProperty("hidden");
    expect(deleteCue(cues, "c1")!.map((c) => c.id)).toEqual(["c2"]);
  });

  it("insertCueAt：落在段內 → null；夾在下一段之前；段 id 接著編", () => {
    expect(insertCueAt(cues, 5, "x", 30)).toBeNull();
    const r = insertCueAt(cues, 25, "新字幕", 45)!;
    expect(r.id).toBe("c3");
    expect(r.cues.map((c) => c.id)).toEqual(["c1", "c3", "c2"]);
    expect(r.cues[1]).toMatchObject({ startFrame: 25, endFrame: 40 });
    assertValid(r.cues);
    expect(insertCueAt([], 90, "x", 45, 100)!.cues[0].endFrame).toBe(100);
    expect(nextCueId([{ id: "c9" }, { id: "intro" }])).toBe("c10");
  });

  it("尋找 / 取代：字面比對（不是正規表示式）、改到的段重新配時、回傳次數", () => {
    const en: CaptionCueV1[] = [
      { id: "e1", startFrame: 0, endFrame: 20, words: [w(" the", 0, 5), w(" card", 5, 10), w(" is", 10, 15), w(" red.", 15, 20)] },
      { id: "e2", startFrame: 30, endFrame: 40, words: [w(" A+B", 30, 35), w(" card", 35, 40)] },
    ];
    expect(findCues(en, "CARD")).toEqual(["e1", "e2"]);
    expect(findCues(en, "CARD", { caseSensitive: true })).toEqual([]);
    expect(findCues(en, "A+B")).toEqual(["e2"]);
    const r = replaceInCues(en, "card", "heart")!;
    expect(r.count).toBe(2);
    expect(cueText(r.cues[0])).toBe("the heart is red.");
    assertValid(r.cues);
    expect(replaceInCues(en, "zzz", "x")).toBeNull();
    const zh = replaceInCues(cues, "課堂", "課桌上的書")!;
    expect(cueText(zh.cues[0])).toBe("百家姓課桌上的書");
    assertValid(zh.cues);
  });

  it("cueAtFrame：[start, end) 二分搜尋", () => {
    expect(cueAtFrame(cues, 0)?.id).toBe("c1");
    expect(cueAtFrame(cues, 19)?.id).toBe("c1");
    expect(cueAtFrame(cues, 20)).toBeNull();
    expect(cueAtFrame(cues, 51)?.id).toBe("c2");
    expect(cueAtFrame(cues, 52)).toBeNull();
  });

  it("待檢查段數：edited 不算", () => {
    expect(flaggedCueCount({ cues: [{ ...cues[0], flags: ["edited"] }, { ...cues[1], flags: ["tooFast"] }] })).toBe(1);
    expect(flaggedCueCount(null)).toBe(0);
  });
});

describe("LLM 建議", () => {
  const cue: CaptionCueV1 = { id: "c1", startFrame: 0, endFrame: 30, words: tokenizeText("店家翻開紅星8。").map((ch, i) => w(ch, i * 3, i * 3 + 3)) };
  it("markEmphasis：片語涵蓋到的字都標、找不到的略過、沒變回原陣列", () => {
    const m = markEmphasis(cue.words, ["紅心", "8"]);
    // 「紅心」不在原文裡（原文是紅星）→ 略過；「8」涵蓋到「8。」那個字
    expect(m.filter((x) => x.emphasis).map((x) => x.text)).toEqual(["8。"]);
    expect(markEmphasis(cue.words, ["黑桃"])).toBe(cue.words);
  });
  it("applyProposals：改字 + 片語強調，一次算完；新長出來的字標 llm", () => {
    const r = applyProposals([cue], [{ cueId: "c1", text: "店家翻開紅心8。", emphasis: ["紅心8"] }]);
    expect(r.changed).toBe(1);
    const words = r.cues[0].words;
    expect(cueText(r.cues[0])).toBe("店家翻開紅心8。");
    expect(words.filter((x) => x.emphasis).map((x) => x.text)).toEqual(["紅", "心", "8。"]);
    expect(words.find((x) => x.text === "心")?.source).toBe("llm");
    expect(words[0].source).toBeUndefined();
    expect(applyProposals([cue], [{ cueId: "zz", text: "x" }]).changed).toBe(0);
  });
});

describe("markEmphasis 細節", () => {
  it("大小寫不分、跨 token 的片語", () => {
    const words = [w(" Big", 0, 2), w(" Win", 2, 4), w(" today", 4, 6)];
    const m = markEmphasis(words, ["big win"]);
    expect(m.map((x) => !!x.emphasis)).toEqual([true, true, false]);
    const digits = [w("8", 0, 2), w("點", 2, 4)];
    expect(markEmphasis(digits, ["8"]).map((x) => !!x.emphasis)).toEqual([true, false]);
  });
});

describe("預設樣式 / 樣式合併", () => {
  it("presetSegmentation：中日韓一套、拉丁一套", () => {
    expect(presetSegmentation("subtitle", "zh-TW").maxUnitsPerLine).toBe(32);
    expect(presetSegmentation("subtitle", "en").maxUnitsPerLine).toBe(42);
    expect(presetSegmentation("pop", "ja")).toMatchObject({ maxUnitsPerLine: 12, maxWords: 3 });
    expect(presetSegmentation("bounce", "en")).toMatchObject({ mode: "word", maxWords: 1, maxLines: 1 });
  });
  it("深層合併：null 蓋掉物件（不要陰影）、undefined 不動、陣列整個換", () => {
    const base = CAPTION_PRESETS.subtitle.style;
    const m = deepMerge(base, { shadow: null, font: { families: ["X"], weight: undefined } });
    expect(m.shadow).toBeNull();
    expect(m.font.families).toEqual(["X"]);
    expect(m.font.weight).toBe(700);
    expect(base.shadow).not.toBeNull();
  });
  it("effectiveStyle = PRESET ← track.style ← cue.styleOverride", () => {
    const tr = { ...emptyCaptionTrack("pop", "zh-TW"), style: { colors: { active: "#FF0000" } } as never };
    const st = effectiveStyle(tr, { styleOverride: { layout: { anchor: "top" } } as never });
    expect(st.colors.active).toBe("#FF0000");
    expect(st.colors.emphasis).toBe("#22C55E");
    expect(st.layout.anchor).toBe("top");
    expect(st.animation.word).toBe("pop");
  });
  it("typewriter 沒有陰影、boxHighlight 是 activeWord 方框", () => {
    expect(CAPTION_PRESETS.typewriter.style.shadow).toBeNull();
    expect(CAPTION_PRESETS.boxHighlight.style.box.mode).toBe("activeWord");
  });
  it.skipIf(!ENGINE_PRESETS)("TS 預設表（SoT）＝ 引擎 presets.v1.json（逐欄）", () => {
    expect(ENGINE_PRESETS!.version).toBe(1);
    expect(ENGINE_PRESETS!.presets).toEqual(JSON.parse(JSON.stringify(CAPTION_PRESETS)));
  });
});

describe("面板選項 / 其他", () => {
  it("parseTranscribeOptions：沒存過 → 依 UI 語言；壞值逐欄退回", () => {
    expect(parseTranscribeOptions(null, "zh-TW")).toMatchObject({ model: "large-v3-turbo", language: "zh", device: "auto", preset: "subtitle", refine: false, scope: "all" });
    expect(parseTranscribeOptions(null, "en").language).toBe("en");
    const p = parseTranscribeOptions(JSON.stringify({ model: "huge", language: "klingon", device: "cpu", preset: "pop", hotwords: ["百家姓", 3, " "], refine: true, scope: "range" }), "zh-TW");
    expect(p).toMatchObject({ model: "large-v3-turbo", language: "zh", device: "cpu", preset: "pop", hotwords: ["百家姓"], refine: true, scope: "range" });
    expect(parseTranscribeOptions("{bad", "en").language).toBe("en");
  });
  it("parseHotwords：逗號 / 頓號 / 換行，去重去空白", () => {
    expect(parseHotwords("百家姓、店家, 玩家\n店家,,")).toEqual(["百家姓", "店家", "玩家"]);
  });
  it("outputLanguageFor：中文 → zh-TW、自動 → 交給引擎", () => {
    expect(outputLanguageFor("zh")).toBe("zh-TW");
    expect(outputLanguageFor("en")).toBe("en");
    expect(outputLanguageFor("auto")).toBeNull();
  });
  it("ui store 收 captions 分頁", () => {
    expect(parsePersisted(JSON.stringify({ tab: "captions" })).tab).toBe("captions");
  });
});

describe("引擎版面文件", () => {
  const doc = {
    version: 1,
    size: [1280, 720],
    fps: { num: 30, den: 1 },
    range: [0, 300],
    font: { path: "C:/Windows/Fonts/msjhbd.ttc" },
    atlas: { path: "atlas.v1.png", w: 2048, h: 64, supersample: 1.25 },
    style: CAPTION_PRESETS.subtitle.style,
    cues: [
      { id: "c1", start: 0, end: 20, box: [100, 600, 500, 680], center: [300, 640], fontPx: 37.44, ascent: 40, descent: 9, lines: [{ y: 610, h: 46.8, baseline: 645, x: 200, w: 200, words: [{ i: 0, x: 200, w: 40, sprites: { future: [0, 0, 60, 60, -5, -45], active: [61, 0, 60, 60, -5, -45], past: [0, 0, 60, 60, -5, -45], weird: [1] } }, { i: "x", x: 1, w: 1, sprites: {} }] }] },
      { id: "bad", start: "0" },
    ],
    warnings: [],
  };
  it("parseLayoutDoc：壞段 / 壞字 / 不認得的精靈狀態略過；圖集路徑不能帶目錄", () => {
    const p = parseLayoutDoc(doc)!;
    expect(p.cues.map((c) => c.id)).toEqual(["c1"]);
    expect(p.cues[0].lines[0].words).toHaveLength(1);
    expect(Object.keys(p.cues[0].lines[0].words[0].sprites)).toEqual(["future", "active", "past"]);
    expect(parseLayoutDoc({ ...doc, atlas: { ...doc.atlas, path: "../x.png" } })).toBeNull();
    expect(parseLayoutDoc({ ...doc, version: 2 })).toBeNull();
  });
  it("parseLayoutDoc：under + fill 三態齊全才收（兩趟繪製），缺一個就不收、退回單趟", () => {
    const r: number[] = [0, 0, 10, 10, -1, -8];
    const withWord = (sprites: Record<string, unknown>) => ({ ...doc, cues: [{ ...doc.cues[0], lines: [{ ...doc.cues[0].lines![0], words: [{ i: 0, x: 200, w: 40, sprites }] }] }] });
    const full = parseLayoutDoc(withWord({ future: r, active: r, past: r, under: r, fill: { future: r, active: r, past: r } }))!;
    const w = full.cues[0].lines[0].words[0];
    expect(w.under).toEqual(r);
    expect(Object.keys(w.fill!)).toEqual(["future", "active", "past"]);
    const partial = parseLayoutDoc(withWord({ future: r, active: r, past: r, under: r, fill: { future: r, active: r } }))!;
    expect(partial.cues[0].lines[0].words[0].under).toBeUndefined();
    expect(partial.cues[0].lines[0].words[0].fill).toBeUndefined();
  });
  it("freshLayoutCue：cue 物件或 track 設定換了參考 → 過期（退回近似）", () => {
    const track = { ...emptyCaptionTrack("subtitle", "zh-TW"), cues: [zhCue("c1", "百家姓", 0, 11)] };
    const cue = track.cues[0];
    const p = parseLayoutDoc(doc)!;
    const l: LoadedCaptionLayout = { mediaId: "m1", doc: p, atlas: {} as CanvasImageSource, byId: new Map(p.cues.map((c) => [c.id, c])), cues: new Map([["c1", cue]]), sig: { presetId: track.presetId, style: track.style, segmentation: track.segmentation, language: track.language } };
    expect(freshLayoutCue(l, "m1", track, cue)?.id).toBe("c1");
    expect(freshLayoutCue(l, "m2", track, cue)).toBeNull();
    expect(freshLayoutCue(l, "m1", { ...track, style: {} }, cue)).toBeNull();
    expect(freshLayoutCue(l, "m1", track, { ...cue })).toBeNull();
    expect(freshLayoutCue(null, "m1", track, cue)).toBeNull();
  });
});
