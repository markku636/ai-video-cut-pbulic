// 引擎警告 → 介面文字（驗收 Low ×2）：英文介面不能冒出整句中文；本機 LLM 連不上 / 回傳壞掉時不能說「沒有修改建議」。
import { afterEach, describe, expect, it } from "vitest";
import { useLang } from "../i18n";
import en from "../locales/en";
import { engineWarningText, fallbackReasonText, isLlmFailure, parseEngineWarning, parseEngineWarnings, refineToasts } from "./captionWarnings";

afterEach(() => useLang.setState({ lang: "zh-TW", catalog: {} }));

const english = () => useLang.setState({ lang: "en", catalog: en });
const CJK = /[一-鿿]/;

// 引擎原始碼（專案沒有 @types/node，用 vite 的 ?raw 讀）：警告句型改了 / 加了新的，這裡會先紅
const ENGINE_SOURCES = import.meta.glob(["../../engine/src/aivc/asr/llm.py", "../../engine/src/aivc/asr/whisper.py", "../../engine/src/aivc/ops/asr.py", "../../engine/src/aivc/captions/normalize.py"], { eager: true, query: "?raw", import: "default" }) as Record<string, string>;

const ENGINE_KIND_SOURCES = import.meta.glob(["../../engine/src/aivc/captions/burn.py", "../../engine/src/aivc/captions/fonts.py"], { eager: true, query: "?raw", import: "default" }) as Record<string, string>;

/**
 * 原始碼裡所有 `warnings.append(...)` / `fallback_reason = ...` 的字串：f-string 裡的模組常數（`{BAD_OUTPUT_PREFIX}`）換成它的值，
 * 其他 {…} 換成樣本值 1。
 */
function engineTemplates(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const [file, src] of Object.entries(ENGINE_SOURCES)) {
    const consts = new Map([...src.matchAll(/^([A-Z][A-Z0-9_]*)\s*=\s*(["'])(.*?)\2\s*$/gm)].map((m) => [m[1], m[3]]));
    for (const m of src.matchAll(/(?:warnings\.append\(|fallback_reason = )f?(["'])(.*?)\1/g)) {
      out.push({ file, text: m[2].replace(/\{([^{}]*)\}/g, (_all, expr: string) => consts.get(expr.trim()) ?? "1") });
    }
  }
  return out;
}

describe("引擎原句 → 代碼 + 參數", () => {
  it("引擎原始碼裡每一則字幕警告 / 退路原因都認得（認不得的會退成「引擎警告：原文」）", () => {
    const tpl = engineTemplates();
    expect(Object.keys(ENGINE_SOURCES)).toHaveLength(4);
    expect(tpl.length).toBeGreaterThanOrEqual(8);
    for (const { file, text } of tpl) expect(parseEngineWarning(text)?.code, `${file}: ${text}`).not.toBeNull();
  });

  it("燒錄 / 字型的物件警告：引擎原始碼裡每一個 `\"kind\": \"…\"` 都是認得的代碼", () => {
    const kinds = new Set<string>();
    for (const src of Object.values(ENGINE_KIND_SOURCES)) for (const m of src.matchAll(/["']kind["']\s*:\s*["'](\w+)["']/g)) kinds.add(m[1]);
    expect(Object.keys(ENGINE_KIND_SOURCES)).toHaveLength(2);
    expect([...kinds].sort()).toEqual(expect.arrayContaining(["fontFallback", "overflow"]));
    english();
    for (const kind of kinds) expect(engineWarningText(parseEngineWarning({ kind, message: "中文原句", cueId: "c1" })!), kind).not.toMatch(/^Engine warning|[一-鿿]/);
  });

  it("參數拆得出來", () => {
    expect(parseEngineWarning("本機 LLM 端點 http://localhost:1234/v1 無法連線，略過校對")).toEqual({ code: "llmUnreachable", params: { endpoint: "http://localhost:1234/v1" }, message: "本機 LLM 端點 http://localhost:1234/v1 無法連線，略過校對" });
    expect(parseEngineWarning("第 2/5 批校對失敗（AttributeError: 'list' object has no attribute 'get'），保留原文")?.params).toEqual({ i: 2, n: 5, detail: "AttributeError: 'list' object has no attribute 'get'" });
    expect(parseEngineWarning("cuda/float16 失敗（oom）→ 改用 cuda/int8_float16：CUDA out of memory")?.params).toEqual({ from: "cuda/float16", kind: "oom", to: "cuda/int8_float16", detail: "CUDA out of memory" });
    expect(parseEngineWarning("12 段有語音但沒有辨識出文字（混語或自動偵測語言錯誤？）")).toMatchObject({ code: "speechWithoutText", params: { n: 12 } });
  });

  it("結構化形狀：{code, message, params} 物件、平行的 warningCodes；垃圾略過；同一句只留一次", () => {
    expect(parseEngineWarning({ code: "llmUnreachable", message: "x", endpoint: "http://h/v1" })).toEqual({ code: "llmUnreachable", params: { endpoint: "http://h/v1" }, message: "x" });
    expect(parseEngineWarning({ code: "llmBatchFailed", params: { i: 1, n: 2, detail: "bad json", junk: {} } })?.params).toEqual({ i: 1, n: 2, detail: "bad json" });
    expect(parseEngineWarning({ text: "3 個片段疑似幻覺（…）" })).toMatchObject({ code: "hallucinatedSegments", params: { n: 3 } });
    expect(parseEngineWarning("some new engine text", "llmBadOutput")).toMatchObject({ code: "llmBadOutput" });
    // 句型認得時以句型為準（參數比較完整），平行代碼不蓋掉
    expect(parseEngineWarning("本機 LLM 端點 h 無法連線，略過校對", "whatever")?.code).toBe("llmUnreachable");
    const list = parseEngineWarnings(["第 1/3 批校對失敗（ValueError: x），保留原文", "第 1/3 批校對失敗（ValueError: x），保留原文", "", 42, null, { nope: 1 }, "新句子"], ["llmBatchFailed"]);
    expect(list.map((w) => w.code)).toEqual(["llmBatchFailed", null]);
    expect(parseEngineWarnings("not a list")).toEqual([]);
  });
});

describe("英文介面不冒中文", () => {
  it("每一種已知警告翻成英文、參數帶進去", () => {
    english();
    const lines = [
      "本機 LLM 端點 http://localhost:1234/v1 無法連線，略過校對",
      "本機 LLM 端點沒有載入任何模型，略過校對",
      "第 2/5 批校對失敗（JSONDecodeError: Expecting value），保留原文",
      "OpenCC 無法載入（ImportError: opencc），略過繁簡轉換",
      "3 個片段疑似幻覺（壓縮比過高／無語音／黑名單），已標記未刪除",
      "2 段有語音但沒有辨識出文字（混語或自動偵測語言錯誤？）",
      "語言設為自動偵測：混合語言的影片可能整段掉字（檢查 gaps），建議明確指定語言",
      // asr/llm.py 回傳壞掉的三種尾巴：括號裡是引擎的中文說明，英文介面不能帶出來
      "本機 LLM 回傳格式不正確（第 1/2 批：頂層應該是物件，收到 list），保留原文",
      "本機 LLM 回傳格式不正確（第 2/2 批有 3 筆建議缺欄位或不是物件，已略過），其餘照常處理",
    ];
    const ws = parseEngineWarnings(lines);
    expect(ws.slice(-2).every((w) => w.code === "llmBadOutput" && isLlmFailure(w))).toBe(true);
    const out = ws.map((w) => engineWarningText(w));
    for (const s of out) expect(s, s).not.toMatch(CJK);
    expect(out[7]).toBe("The local LLM returned malformed output for batch 1/2; that part keeps the original text");
    expect(out[0]).toBe("Could not reach the local LLM endpoint http://localhost:1234/v1; proofreading skipped");
    expect(out[2]).toBe("Proofreading batch 2/5 failed (JSONDecodeError: Expecting value); original text kept");
    expect(out[4]).toContain("3 segments");
  });

  it("認不得的原文：翻好的通用前綴 + 原文；代碼認得但缺參數 → 不帶參數的句子（不會出現 {endpoint}）", () => {
    english();
    expect(engineWarningText({ code: null, params: {}, message: "字型找不到" })).toBe("Engine warning: 字型找不到");
    expect(engineWarningText({ code: "futureCode", params: {}, message: "" })).toBe("Engine warning: futureCode");
    expect(engineWarningText({ code: "llmUnreachable", params: {}, message: "" })).toBe("Could not reach the local LLM endpoint; proofreading skipped");
    expect(engineWarningText({ code: "llmBatchFailed", params: {}, message: "" })).toBe("The local LLM returned malformed output; original text kept");
  });

  it("輸出計畫的字幕警告：字型缺字只顯示檔名、排不下另外數", () => {
    english();
    const ws = parseEngineWarnings([
      { kind: "fontNoCjk", message: "字型 Arial（C:\\Windows\\Fonts\\arial.ttf）沒有中日韓字形，字幕的中文會顯示成方塊；請安裝 Noto Sans CJK TC 等中文字型，或在樣式指定字型檔", font: "C:\\Windows\\Fonts\\arial.ttf" },
      { cueId: "c3", kind: "overflow" },
      { cueId: "c9", kind: "overflow" },
    ]);
    expect(ws.map((w) => w.code)).toEqual(["fontNoCjk", "overflow", "overflow"]);
    expect(engineWarningText(ws[0])).toBe("Font arial.ttf has no CJK glyphs: Chinese in the captions will render as boxes. Install a Chinese font (e.g. Noto Sans CJK TC) or set a font file in the style");
    expect(engineWarningText({ code: "fontFallback", params: {}, message: "" })).toBe("No system font found: CJK characters in the captions will render as boxes");
  });

  it("中文介面：已知句型組回來跟引擎原句一致（不多一個前綴）", () => {
    const s = "本機 LLM 端點 http://h/v1 無法連線，略過校對";
    expect(engineWarningText(parseEngineWarning(s)!)).toBe(s);
  });

  it("裝置退路原因：OOM 換 int8 不是「改用 CPU」；認不得的也不會變成空白", () => {
    english();
    expect(fallbackReasonText("cuda/float16 失敗（oom）→ 改用 cuda/int8_float16：CUDA out of memory")).toBe("cuda/float16 failed (out of GPU memory); switched to cuda/int8_float16: CUDA out of memory");
    expect(fallbackReasonText("cuda/float16 失敗（cuda）→ 改用 cpu/int8：cublas64_12.dll not found")).toBe("cuda/float16 failed (CUDA libraries unavailable); switched to cpu/int8: cublas64_12.dll not found");
    expect(fallbackReasonText("GPU 爆了")).toBe("Speech recognition switched to a fallback device: GPU 爆了");
    expect(fallbackReasonText({ code: "deviceFallback", from: "cuda/float16", to: "cpu/int8", kind: "cuda" })).toBe("cuda/float16 failed (CUDA libraries unavailable); switched to cpu/int8");
    expect(fallbackReasonText(null)).toBeNull();
    expect(fallbackReasonText("")).toBeNull();
  });
});

describe("本機 LLM 校對的 toast", () => {
  const unreachable = parseEngineWarnings(["本機 LLM 端點 http://localhost:1234/v1 無法連線，略過校對"]);
  const batch = parseEngineWarnings(["第 1/3 批校對失敗（AttributeError: x），保留原文", "第 2/3 批校對失敗（AttributeError: y），保留原文"]);

  it("連不上 → 講連不上，不是「沒有修改建議」", () => {
    expect(unreachable.every(isLlmFailure)).toBe(true);
    expect(refineToasts({ count: 0, warnings: unreachable, failed: true })).toEqual([{ kind: "error", text: "本機 LLM 端點 http://localhost:1234/v1 無法連線，略過校對" }]);
  });
  it("回傳壞掉（每批都失敗）→ 第一則原因 + 其餘幾則", () => {
    english();
    expect(refineToasts({ count: 0, warnings: batch, failed: true })).toEqual([{ kind: "error", text: "Proofreading batch 1/3 failed (AttributeError: x); original text kept (+1 more like this)" }]);
  });
  it("部分批次失敗但有建議 → 兩則都跳；真的沒建議、也沒失敗 → 沒有修改建議", () => {
    expect(refineToasts({ count: 2, warnings: batch.slice(0, 1), failed: true }).map((x) => x.kind)).toEqual(["info", "error"]);
    expect(refineToasts({ count: 0, warnings: [], failed: false })).toEqual([{ kind: "info", text: "本機 LLM 沒有修改建議" }]);
    // reachable:false 卻沒附警告（形狀怪的舊引擎）：仍然講失敗
    expect(refineToasts({ count: 0, warnings: [], failed: true })[0].kind).toBe("error");
    // 非 LLM 的警告（例如 OpenCC）不影響「沒有修改建議」
    expect(refineToasts({ count: 0, warnings: parseEngineWarnings(["OpenCC 無法載入（x），略過繁簡轉換"]), failed: false })[0].text).toBe("本機 LLM 沒有修改建議");
  });
});
