// 專案檔頂層的「核心 schema 不認得的鍵」（引擎 project.extra、沒裝的外掛的鍵…）。純函式。
//
// 為什麼要有這一層：parseProjectFile 建的是固定形狀的物件，頂層未知鍵一律不收。外掛的揭露句子、標記，
// 以及**沒裝的外掛**擁有的頂層鍵（開源版打開牌專案時的 cardSlots / deck）都在頂層 —— 開檔再存檔一次就洗掉，
// 那就壞了。所以載入時另外收一份 extras，存檔時再接回去（withProjectExtras：只補 doc 沒有的鍵，從不覆寫已知欄位）。
import { CORE_TOP_KEYS, pluginTopLevelKeys, type JsonValueLite } from "./format";
import { isJsonValue, type SanitizeReport } from "./sanitize";

/** 核心與外掛 schema 管的頂層鍵（含 M2 的 sequence / audioMedia：合併之後它們由 M2 的 sanitize 管，不能被當成 extras 接回去）。 */
export function knownTopKeys(): string[] {
  return [...CORE_TOP_KEYS, ...pluginTopLevelKeys().map((k) => k.key)];
}

const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);

export type ProjectExtras = Readonly<Record<string, JsonValueLite>>;

/** 頂層未知鍵：純 JSON 值、不是危險鍵才收；壞的回報 `extras`。 */
export function readProjectExtras(doc: unknown, r?: SanitizeReport): ProjectExtras {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return {};
  const known = knownTopKeys();
  const out: Record<string, JsonValueLite> = {};
  for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
    if (known.includes(k) || v === undefined) continue;
    if (UNSAFE.has(k) || !isJsonValue(v)) {
      if (r) {
        r.dropped.extras = (r.dropped.extras ?? 0) + 1;
        r.total += 1;
      }
      continue;
    }
    out[k] = v as JsonValueLite;
  }
  return out;
}

/** extras 接回 doc：只補 doc 沒有的鍵、接在既有鍵後面、從不覆寫；extras 空的 → 原物件（沒有 extras 的專案存檔逐位元不變）。 */
export function withProjectExtras<T extends object>(doc: T, x: ProjectExtras): T {
  const known = knownTopKeys();
  const add = Object.entries(x).filter(([k, v]) => v !== undefined && !UNSAFE.has(k) && !known.includes(k) && !Object.prototype.hasOwnProperty.call(doc, k));
  if (!add.length) return doc;
  const out: Record<string, unknown> = { ...(doc as Record<string, unknown>) };
  for (const [k, v] of add) out[k] = v;
  return out as T;
}
