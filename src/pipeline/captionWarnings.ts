import { t as translate } from "../i18n";

/**
 * 引擎警告 / 裝置退路原因 → 介面文字（驗收 Low：英文介面直接冒出引擎的中文句子）。
 *
 * 為什麼要先轉成「代碼 + 參數」再翻：引擎的警告是給 CLI 看的人話，句子裡夾著端點網址、批次編號、例外訊息，
 * 整句拿去查翻譯表永遠查不到。所以：
 * 1. 引擎有給結構化代碼（`{code, message, params}` 物件、或跟 warnings 對齊的 `warningCodes` 陣列）就直接用；
 * 2. 沒給（目前的引擎）就用下面這張表把已知句型拆成代碼 + 參數 —— 表裡的正規表示式鏡射 aivc 的原句
 *    （asr/llm.py、captions/normalize.py、ops/asr.py、asr/whisper.py），句型改了這裡的測試會先紅；
 * 3. 認不得的原文照登，前面加一個翻好的通用前綴，至少讓英文使用者知道這是引擎的原話、不是介面壞掉。
 * 代碼一律 camelCase，跟專案檔其他列舉同一個慣例。
 */

export type EngineWarningCode =
  | "llmUnreachable"
  | "llmNoModel"
  | "llmBatchFailed"
  | "llmBadOutput"
  | "openccUnavailable"
  | "hallucinatedSegments"
  | "speechWithoutText"
  | "autoLanguage"
  | "deviceFallback"
  // 燒錄 / 版面的物件警告（captions/burn.py、fonts.missing_cjk_warning）：引擎本來就帶 `kind`，當代碼用
  | "fontFallback"
  | "fontNoCjk"
  | "overflow";

export interface EngineWarning {
  /** 認得的代碼；null = 認不得（顯示原文 + 通用前綴）。引擎給了表外的代碼也原樣放這裡，照樣走原文。 */
  code: string | null;
  params: Readonly<Record<string, string | number>>;
  /** 引擎的原句（沒有就空字串）。 */
  message: string;
}

type Params = Record<string, string | number>;

/** 已知句型：引擎原句 → 代碼 + 參數。順序有意義（先比較長、較具體的）。 */
const PATTERNS: readonly { code: EngineWarningCode; re: RegExp; params: (m: RegExpExecArray) => Params }[] = [
  { code: "llmUnreachable", re: /^本機 LLM 端點 (.+?) 無法連線/, params: (m) => ({ endpoint: m[1] }) },
  { code: "llmNoModel", re: /^本機 LLM 端點沒有載入任何模型/, params: () => ({}) },
  { code: "llmBatchFailed", re: /^第 (\d+)\/(\d+) 批校對失敗（([\s\S]*)），保留原文$/, params: (m) => ({ i: Number(m[1]), n: Number(m[2]), detail: m[3] }) },
  // asr/llm.py BAD_OUTPUT_PREFIX + 「（第 i/n 批：原因）」等三種尾巴；原因是引擎的中文說明，不帶進參數（英文介面會冒中文）
  { code: "llmBadOutput", re: /^本機 LLM 回傳格式不正確(?:（第 (\d+)\/(\d+) 批)?/, params: (m): Params => (m[1] ? { i: Number(m[1]), n: Number(m[2]) } : {}) },
  { code: "openccUnavailable", re: /^OpenCC 無法載入（([\s\S]*)），略過繁簡轉換/, params: (m) => ({ detail: m[1] }) },
  { code: "hallucinatedSegments", re: /^(\d+) 個片段疑似幻覺/, params: (m) => ({ n: Number(m[1]) }) },
  { code: "speechWithoutText", re: /^(\d+) 段有語音但沒有辨識出文字/, params: (m) => ({ n: Number(m[1]) }) },
  { code: "autoLanguage", re: /^語言設為自動偵測/, params: () => ({}) },
  // asr/whisper.py：f"{dev}/{ct} 失敗（{kind}）→ 改用 {nxt[0]}/{nxt[1]}：{msg[:160]}"
  { code: "deviceFallback", re: /^(\S+?\/\S+?) 失敗（(\w+)）→ 改用 (\S+?\/\S+?)：([\s\S]*)$/, params: (m) => ({ from: m[1], kind: m[2], to: m[3], detail: m[4] }) },
];

function scalarParams(v: unknown): Params {
  const out: Params = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, x] of Object.entries(v)) if (typeof x === "string" || (typeof x === "number" && Number.isFinite(x))) out[k] = x;
  return out;
}

function fromText(message: string): EngineWarning {
  for (const p of PATTERNS) {
    const m = p.re.exec(message);
    if (m) return { code: p.code, params: p.params(m), message };
  }
  return { code: null, params: {}, message };
}

const nonEmpty = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * 一則警告：字串（比對句型）、或物件 `{code|kind, message|text, params, ...其他純量欄位}`（燒錄的字型警告是 `{kind, message, font}`）；
 * `code` 是平行陣列給的代碼。垃圾 → null。
 */
export function parseEngineWarning(raw: unknown, code?: unknown): EngineWarning | null {
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    const hit = fromText(raw);
    return nonEmpty(code) && !hit.code ? { ...hit, code: nonEmpty(code) } : hit;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const message = nonEmpty(o.message) ?? nonEmpty(o.text) ?? "";
  // `kind` 只有在沒有 code 時才當代碼（燒錄警告的形狀）；有 code 時 kind 是參數（例如裝置退路的 oom / cuda）
  const kindIsCode = !nonEmpty(o.code) && !nonEmpty(code) && !!nonEmpty(o.kind);
  const c = nonEmpty(o.code) ?? nonEmpty(code) ?? nonEmpty(o.kind);
  const { code: _c, message: _m, text: _t, params: _p, ...rest } = o;
  if (kindIsCode) delete rest.kind;
  const params = { ...scalarParams(rest), ...scalarParams(o.params) };
  if (c) return { code: c, params, message };
  return message ? fromText(message) : null;
}

/** 引擎結果的 warnings（＋選配的平行 warningCodes）→ 清單；不是陣列 → 空。同一句重複只留一次（批次失敗常常一模一樣）。 */
export function parseEngineWarnings(list: unknown, codes?: unknown): EngineWarning[] {
  if (!Array.isArray(list)) return [];
  const cs = Array.isArray(codes) ? codes : [];
  const seen = new Set<string>();
  const out: EngineWarning[] = [];
  list.forEach((raw, i) => {
    const w = parseEngineWarning(raw, cs[i]);
    if (!w) return;
    const key = `${w.code ?? ""}|${w.message}|${JSON.stringify(w.params)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(w);
  });
  return out;
}

/** 本機 LLM 沒做成（連不上 / 沒載模型 / 回傳壞掉）：這種時候「沒有修改建議」是騙人的，要改講失敗原因。 */
export function isLlmFailure(w: EngineWarning): boolean {
  return w.code === "llmUnreachable" || w.code === "llmNoModel" || w.code === "llmBatchFailed" || w.code === "llmBadOutput";
}

type Tr = (zh: string, params?: Readonly<Record<string, string | number>>) => string;

const str = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "");

function deviceKindLabel(kind: string, t: Tr): string {
  switch (kind) {
    case "oom":
      return t("顯示記憶體不足");
    case "cuda":
      return t("CUDA 函式庫無法使用");
    default:
      return t("其他錯誤");
  }
}

/** 認不得的原文：通用前綴翻好、原文照登。 */
function rawText(w: EngineWarning, t: Tr): string {
  return t("引擎警告：{message}", { message: w.message || w.code || "" });
}

/**
 * 警告 → 目前語言的一句話。`t` 預設 module-level 的翻譯函式；元件裡傳 useT() 的，切語言才會重繪。
 * 參數刻意叫 `t`：scripts/check-i18n.mjs 只認 `t("…")` 字面量，換個名字這些句子就逃過漏翻稽核。
 * 認得的代碼缺了必要參數（例如引擎給了代碼卻沒給端點）就退到不帶參數的句子，不會出現「{endpoint}」字樣。
 */
export function engineWarningText(w: EngineWarning, t: Tr = translate): string {
  const p = w.params;
  switch (w.code) {
    case "llmUnreachable":
      return str(p.endpoint) ? t("本機 LLM 端點 {endpoint} 無法連線，略過校對", { endpoint: str(p.endpoint) }) : t("本機 LLM 端點無法連線，略過校對");
    case "llmNoModel":
      return t("本機 LLM 端點沒有載入任何模型，略過校對");
    case "llmBatchFailed":
      if (!str(p.i) || !str(p.n)) return t("本機 LLM 回傳格式不正確，保留原文");
      return str(p.detail) ? t("第 {i}/{n} 批校對失敗（{detail}），保留原文", { i: str(p.i), n: str(p.n), detail: str(p.detail) }) : t("第 {i}/{n} 批校對失敗，保留原文", { i: str(p.i), n: str(p.n) });
    case "llmBadOutput":
      return str(p.i) && str(p.n) ? t("本機 LLM 第 {i}/{n} 批回傳格式不正確，那部分保留原文", { i: str(p.i), n: str(p.n) }) : t("本機 LLM 回傳格式不正確，保留原文");
    case "openccUnavailable":
      return t("OpenCC 無法載入，略過繁簡轉換");
    case "hallucinatedSegments":
      return str(p.n) ? t("{n} 個片段疑似幻覺（壓縮比過高／無語音／黑名單），已標記未刪除", { n: str(p.n) }) : rawText(w, t);
    case "speechWithoutText":
      return str(p.n) ? t("{n} 段有語音但沒有辨識出文字（混語或自動偵測語言錯誤？）", { n: str(p.n) }) : rawText(w, t);
    case "autoLanguage":
      return t("語言設為自動偵測：混合語言的影片可能整段掉字，建議明確選語言");
    case "deviceFallback":
      return fallbackText(w, t);
    case "fontFallback":
      return t("找不到任何系統字型：字幕的中日韓字會顯示成方塊");
    case "fontNoCjk":
      // 引擎給字型檔路徑；只顯示檔名（完整路徑在英文 / 中文介面都太長，引擎 log 裡有）
      return str(p.font) ? t("字型 {font} 沒有中日韓字形：字幕的中文會顯示成方塊，請安裝中文字型（例如 Noto Sans CJK TC）或在樣式指定字型檔", { font: str(p.font).split(/[\\/]/).pop() ?? "" }) : t("字型沒有中日韓字形：字幕的中文會顯示成方塊，請安裝中文字型（例如 Noto Sans CJK TC）或在樣式指定字型檔");
    case "overflow":
      return t("有字幕段排不下（字太多或字級太大）");
    default:
      return rawText(w, t);
  }
}

/** 燒錄時字型缺字（燒出來會是方塊）：輸出對話框要擺在最顯眼的位置。 */
export function isFontWarning(w: EngineWarning): boolean {
  return w.code === "fontFallback" || w.code === "fontNoCjk";
}

function fallbackText(w: EngineWarning, t: Tr): string {
  const p = w.params;
  if (!str(p.from) || !str(p.to)) return w.message ? t("語音辨識改用備援裝置：{message}", { message: w.message }) : t("語音辨識改用備援裝置");
  const base = { from: str(p.from), to: str(p.to), kind: deviceKindLabel(str(p.kind), t) };
  return str(p.detail) ? t("{from} 失敗（{kind}），改用 {to}：{detail}", { ...base, detail: str(p.detail) }) : t("{from} 失敗（{kind}），改用 {to}", base);
}

export interface ToastSpec {
  kind: "info" | "error";
  text: string;
}

/**
 * 本機 LLM 校對的結果 → 要跳的 toast（純函式，指令層照著跳）。
 * 驗收 Low：端點連不上時引擎安靜地回「0 則建議 + 警告」，之前 UI 只看數字，跳「本機 LLM 沒有修改建議」—— 使用者以為字幕很完美。
 * 所以：有 LLM 失敗警告就講失敗原因（取代「沒有修改建議」）；有建議又有部分批次失敗，兩則都跳。
 * 同類警告只講第一則 + 其餘幾則（二十批全失敗不該跳二十行）。
 */
export function refineToasts(r: { count: number; warnings: readonly EngineWarning[]; failed: boolean }, t: Tr = translate): ToastSpec[] {
  const out: ToastSpec[] = [];
  if (r.count > 0) out.push({ kind: "info", text: t("本機 LLM 提了 {n} 段修改建議，請在字幕面板確認", { n: r.count }) });
  const fails = r.warnings.filter(isLlmFailure);
  if (fails.length) {
    const first = engineWarningText(fails[0], t);
    out.push({ kind: "error", text: fails.length > 1 ? t("{first}（另有 {n} 則同類警告）", { first, n: fails.length - 1 }) : first });
  } else if (r.failed) out.push({ kind: "error", text: t("本機 LLM 端點無法連線，略過校對") });
  else if (r.count === 0) out.push({ kind: "info", text: t("本機 LLM 沒有修改建議") });
  return out;
}

/** asr.transcribe 的 fallbackReason（字串或 `{code, ...}`）→ 一句話；沒有退路 → null。 */
export function fallbackReasonText(raw: unknown, t: Tr = translate): string | null {
  const w = parseEngineWarning(raw);
  // 句型比不到（code null）也仍然是退路原因：fallbackText 會退到「改用備援裝置：原文」，不是泛用的「引擎警告」
  return w ? fallbackText(w, t) : null;
}
