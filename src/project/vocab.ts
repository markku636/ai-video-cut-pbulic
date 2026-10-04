// 可以由外掛加值的核心列舉欄位（track.regionPolicy、insert.relight.sheenLock）。磁碟上的字串不變。
//
// 規則：核心的值與外掛登記的值是「認得的值」；不認得但長得像識別字的值**原樣保留**——它可能屬於沒裝的外掛
// （開源版打開牌專案，regionPolicy "keepBarcode" 不能因為不認得就被改成 full 存回去）。
// 外掛如果是這個欄位詞彙的權威（例如 cards 讓所有不認得的 regionPolicy 讀成 keepBarcode），在它的 sanitizeTrack 裡改。
//
// 這個檔在 check-i18n 的 TABLE_SOURCES：label 是 zh key。
import type { VocabValue } from "../plugins/api";
import { collect, plugins } from "../plugins/registry";

/** 不認得、但看起來是一個值（不是壞資料）的字串：原樣保留。 */
export function isForeignValue(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(v);
}

/** 依 `after` 把外掛的值插進核心的清單（找不到錨點 = 接在最後）。 */
function merged(core: readonly VocabValue[], extra: readonly VocabValue[]): VocabValue[] {
  const out = [...core];
  for (const v of extra) {
    if (out.some((x) => x.id === v.id)) continue;
    const i = v.after ? out.findIndex((x) => x.id === v.after) : -1;
    if (i >= 0) out.splice(i + 1, 0, v);
    else out.push(v);
  }
  return out;
}

/** 核心的區域策略：整面替換／保持不動。 */
export const CORE_REGION_POLICIES: readonly VocabValue[] = [
  { id: "full", label: "整面替換" },
  { id: "hold", label: "保持不動" },
];

export function regionPolicies(): VocabValue[] {
  return merged(
    CORE_REGION_POLICIES,
    collect((p) => p.vocabulary?.regionPolicy?.values),
  );
}

/** 新追蹤的區域策略：外掛宣告的預設（第一個），沒有就整面替換。 */
export function defaultRegionPolicy(): string {
  for (const p of plugins()) {
    const d = p.vocabulary?.regionPolicy?.default;
    if (d) return d;
  }
  return "full";
}

/** 核心的反光鎖定：plate（反光跟著鏡頭）。 */
export const CORE_SHEEN_LOCKS: readonly VocabValue[] = [{ id: "plate" }];

export function sheenLocks(): VocabValue[] {
  return merged(
    CORE_SHEEN_LOCKS,
    collect((p) => p.vocabulary?.sheenLock?.values),
  );
}

/** 選單用：值 → zh key（沒有標籤的就是值本身）。 */
export function vocabLabel(list: readonly VocabValue[], id: string): string {
  return list.find((v) => v.id === id)?.label ?? id;
}
