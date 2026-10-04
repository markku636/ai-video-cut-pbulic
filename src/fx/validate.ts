/**
 * 特效參數的驗證：跟 `engine/src/aivc/fx/params.py` 同一組範圍與寫法。
 * 引擎遇到錯會整份特效檔拒收（ops 層 OpError Invalid），所以表單上先講清楚是哪一欄；
 * 不認得的特效類型只給提示（原樣保留，交給新版引擎），不算錯。
 * 這個檔在 check-i18n 的 CORE_TABLE_SOURCES（"fx/"）裡：msg 是 zh key。
 */
import type { EffectV1, JsonValueLite } from "../project/format";
import { activeEffects, EFFECT_META_KEYS, engineEffect, fieldValue } from "./effect";
import { isKnownEffectType, specOf, type EnumField, type FxField, type NumberField, type PairField } from "./schema";

export interface FxIssue {
  /** 欄位鍵；null = 整個特效。 */
  key: string | null;
  /** zh key */
  msg: string;
  params?: Record<string, string | number>;
  /** warn = 不擋（例如不認得的特效類型原樣保留）；error = 引擎會拒收。 */
  level: "error" | "warn";
}

const HEX = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function isChannel(x: unknown): boolean {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 255;
}

/** params.py parse_color 吃的寫法：#RRGGBB、#RRGGBBAA、[r,g,b(,a)] 0–255、"r,g,b"。 */
export function isEngineColor(v: unknown): boolean {
  if (Array.isArray(v)) return (v.length === 3 || v.length === 4) && v.every(isChannel);
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (s.startsWith("#")) return HEX.test(s);
  const parts = s.replace(/，/g, ",").split(",");
  return (parts.length === 3 || parts.length === 4) && parts.every((p) => p.trim() !== "" && isChannel(Number(p)));
}

/** 顏色 → `<input type=color>` 吃的 #RRGGBB（看不懂就 null）。 */
export function colorToHex6(v: unknown): string | null {
  if (typeof v === "string" && HEX.test(v.trim())) return v.trim().slice(0, 7).toUpperCase();
  let arr: number[] | null = null;
  if (Array.isArray(v) && v.length >= 3) arr = v.slice(0, 3).map(Number);
  else if (typeof v === "string" && !v.trim().startsWith("#")) {
    const p = v.split(",").map((x) => Number(x));
    if (p.length >= 3) arr = p.slice(0, 3);
  }
  if (!arr || arr.some((x) => !Number.isFinite(x))) return null;
  return `#${arr
    .map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}

/** 「不設＝自動」的數值欄位：表單上空白顯示「自動」。 */
export function isAutoValue(f: NumberField, v: JsonValueLite | undefined): boolean {
  return !!f.auto && (v === undefined || v === null || (typeof v === "string" && v.trim().toLowerCase() === "auto"));
}

function fmt(n: number): string {
  return Math.abs(n) >= 1e4 || (Math.abs(n) < 1e-3 && n !== 0) ? n.toExponential(0) : String(n);
}

const unset = (v: JsonValueLite | undefined): boolean => v === undefined || v === null;

/** 一個數值（含 auto）的問題；呼叫端決定 key。 */
export function numberIssue(f: Pick<NumberField, "min" | "max" | "int" | "auto">, v: JsonValueLite | undefined): Omit<FxIssue, "key" | "level"> | null {
  if (unset(v)) return null;
  if (f.auto && typeof v === "string" && v.trim().toLowerCase() === "auto") return null;
  if (typeof v !== "number" || !Number.isFinite(v)) return { msg: "要是數字" };
  if (f.int && !Number.isInteger(v)) return { msg: "要是整數" };
  if (v < f.min || v > f.max) return { msg: "超出範圍 {min}–{max}", params: { min: fmt(f.min), max: fmt(f.max) } };
  return null;
}

function enumOk(f: EnumField, v: JsonValueLite | undefined): boolean {
  return unset(v) || (typeof v === "string" && f.options.some((o) => o.value === v.trim().toLowerCase()));
}

function pairOk(f: PairField, v: JsonValueLite | undefined): boolean {
  return unset(v) || (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Number.isFinite(x) && x >= f.min && x <= f.max));
}

function textIssue(f: Extract<FxField, { kind: "text" | "file" }>, v: JsonValueLite | undefined): string | null {
  if (!unset(v) && typeof v !== "string") return "要是文字";
  if (f.required && (typeof v !== "string" || !v.trim())) return f.kind === "file" ? "要選一個檔案" : "必填";
  return null;
}

function fontIssues(e: EffectV1): FxIssue[] {
  const out: FxIssue[] = [];
  const fams = e.fontFamilies;
  if (!unset(fams) && !(Array.isArray(fams) && fams.every((x) => typeof x === "string"))) out.push({ key: "fontFamilies", msg: "字型清單要是文字", level: "error" });
  const w = numberIssue({ min: 100, max: 1000, int: true }, e.fontWeight);
  if (w) out.push({ key: "fontWeight", ...w, level: "error" });
  if (!unset(e.fontFile) && typeof e.fontFile !== "string") out.push({ key: "fontFile", msg: "要是文字", level: "error" });
  return out;
}

const REPLACE_KEYS = ["source", "target", "from", "to", "tolerance", "softness"];

function replaceColorIssues(key: string, v: JsonValueLite | undefined): FxIssue[] {
  if (unset(v)) return [];
  const err = (msg: string, params?: FxIssue["params"]): FxIssue => ({ key, msg, ...(params ? { params } : {}), level: "error" });
  if (typeof v !== "object" || Array.isArray(v)) return [err("換色要有原本的顏色與新的顏色")];
  const r = v as Record<string, JsonValueLite>;
  const out: FxIssue[] = [];
  const src = r.source ?? r.from;
  const dst = r.target ?? r.to;
  if (unset(src) || unset(dst)) out.push(err("換色要有原本的顏色與新的顏色"));
  else if (!isEngineColor(src) || !isEngineColor(dst)) out.push(err("顏色要寫成 #RRGGBB"));
  if (["tolerance", "softness"].some((k) => numberIssue({ min: 0, max: 1 }, r[k]))) out.push(err("容差與柔邊要在 0–1"));
  const extra = Object.keys(r).filter((k) => !REPLACE_KEYS.includes(k));
  if (extra.length) out.push(err("引擎不認得的欄位：{keys}", { keys: extra.join(", ") }));
  return out;
}

/** 一個欄位的問題。 */
function fieldIssues(f: FxField, e: EffectV1): FxIssue[] {
  const v = fieldValue(e, f.key);
  const one = (msg: string | null, params?: FxIssue["params"]): FxIssue[] => (msg ? [{ key: f.key, msg, ...(params ? { params } : {}), level: "error" }] : []);
  switch (f.kind) {
    case "number": {
      const i = numberIssue(f, v);
      return i ? one(i.msg, i.params) : [];
    }
    case "enum":
      return one(enumOk(f, v) ? null : "不是可用的選項");
    case "bool":
      return one(unset(v) || typeof v === "boolean" ? null : "要是開或關");
    case "color":
      return one(unset(v) || isEngineColor(v) ? null : "顏色要寫成 #RRGGBB");
    case "text":
    case "file":
      return one(textIssue(f, v));
    case "pair":
      return one(pairOk(f, v) ? null : "要是兩個數字 [x, y]");
    case "font":
      return fontIssues(e);
    case "replaceColor":
      return replaceColorIssues(f.key, v);
  }
}

const FOOTPRINT_KEYS = ["shape", "expand", "feather", "smooth"];

function footprintIssues(e: EffectV1): FxIssue[] {
  const fp = e.footprint;
  if (fp === undefined || fp === null) return [];
  if (typeof fp !== "object" || Array.isArray(fp)) return [{ key: "footprint", msg: "作用範圍要是物件", level: "error" }];
  const extra = Object.keys(fp).filter((k) => !FOOTPRINT_KEYS.includes(k));
  return extra.length ? [{ key: "footprint", msg: "引擎不認得的欄位：{keys}", params: { keys: extra.join(", ") }, level: "error" }] : [];
}

/** 一個特效的問題清單（空＝引擎會收）。不認得的 type 只給 warn：原樣保留，交給新版引擎。 */
export function validateEffect(e: EffectV1): FxIssue[] {
  const spec = specOf(String(e.type ?? "").trim().toLowerCase());
  if (!spec) return [{ key: null, msg: "不認得的特效「{type}」：原樣保留，這個版本的引擎不會套用", params: { type: String(e.type) }, level: "warn" }];
  const out: FxIssue[] = [];
  for (const g of spec.groups) for (const f of g.fields) out.push(...fieldIssues(f, e));
  out.push(...footprintIssues(e));
  const unknown = Object.keys(e).filter((k) => !EFFECT_META_KEYS.includes(k) && !spec.keys.includes(k));
  if (unknown.length) out.push({ key: null, msg: "引擎不認得的欄位：{keys}", params: { keys: unknown.join(", ") }, level: "error" });
  return out;
}

export function hasErrors(e: EffectV1): boolean {
  return validateEffect(e).some((i) => i.level === "error");
}

/** 整份堆疊有幾個會讓引擎拒收的錯（關掉的特效不送，不算）。 */
export function stackErrors(list: readonly EffectV1[] | undefined): number {
  return activeEffects(list).reduce((n, e) => n + validateEffect(e).filter((i) => i.level === "error").length, 0);
}

/** 送給引擎的堆疊：開著、認得、沒有錯的特效（壞的那一個不送，其他照樣預覽）。 */
export function enginePayload(list: readonly EffectV1[] | undefined): Record<string, JsonValueLite>[] {
  return activeEffects(list)
    .filter((e) => isKnownEffectType(String(e.type).trim().toLowerCase()) && !hasErrors(e))
    .map(engineEffect);
}
