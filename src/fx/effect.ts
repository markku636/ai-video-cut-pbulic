/**
 * 一個特效（EffectV1）的讀值、建立與堆疊編輯（純函式；store 的 setTrackEffects 收結果，一個動作一筆 undo）。
 * 欄位表在 schema.ts、驗證在 validate.ts。
 */
import type { EffectType, EffectV1, JsonValueLite } from "../project/format";

/** 不是參數的鍵（契約：引擎套用前拿掉）。 */
export const EFFECT_META_KEYS: readonly string[] = ["id", "enabled"];

const FOOTPRINT_SHORT = ["shape", "expand", "feather"];

/** 表單顯示的值：有存就用存的；footprint 的三個鍵也看 `footprint: {...}` 巢狀寫法（短鍵優先，跟引擎一樣）。 */
export function fieldValue(e: EffectV1, key: string): JsonValueLite | undefined {
  if (e[key] !== undefined) return e[key];
  if (FOOTPRINT_SHORT.includes(key)) {
    const fp = e.footprint;
    if (fp && typeof fp === "object" && !Array.isArray(fp)) return (fp as Record<string, JsonValueLite>)[key];
  }
  return undefined;
}

let fxSeq = 0;
/** 特效 id：同一條 track 裡唯一就好（時間＋計數，不必查清單）。 */
export function newEffectId(now = Date.now()): string {
  return `fx-${now.toString(36)}${(fxSeq++).toString(36)}`;
}

/** 新特效的起始參數：只放「必填」與「讓它一加上去就看得出效果」的鍵，其他交給引擎預設。 */
export function newEffect(type: EffectType, ctx: { label?: string; image?: string } = {}): EffectV1 {
  const base: EffectV1 = { id: newEffectId(), enabled: true, type };
  if (type === "text") return { ...base, text: ctx.label?.trim() || "Text" };
  if (type === "sticker") return { ...base, image: ctx.image ?? "" };
  // 調色一加上去就去色（看得出作用範圍）；之後再調色相、上色或換色
  if (type === "color") return { ...base, desaturate: 1 };
  return base;
}

/**
 * 隱私打碼的馬賽克：臉用橢圓（跟臉形），其他（車牌、螢幕…）用外接框；外擴一點，邊緣不會露出來。
 * phrase 是引擎片語（英文；find.instances[].phrase）。
 */
export function privacyMosaic(phrase?: string | null): EffectV1 {
  const face = !phrase || /\bface\b/i.test(phrase) || /臉/.test(phrase);
  return { id: newEffectId(), enabled: true, type: "mosaic", shape: face ? "ellipse" : "box", expand: 6 };
}

/** 引擎吃的形狀：拿掉 id / enabled（契約 §2）。 */
export function engineEffect(e: EffectV1): Record<string, JsonValueLite> {
  const out: Record<string, JsonValueLite> = {};
  for (const [k, v] of Object.entries(e)) if (!EFFECT_META_KEYS.includes(k)) out[k] = v;
  return out;
}

/** 開著的特效（送引擎預覽 / 輸出摘要用）。 */
export function activeEffects(list: readonly EffectV1[] | undefined): EffectV1[] {
  return (list ?? []).filter((e) => e.enabled !== false);
}

// ────────────────────────────────────────────────────────────────────────────
// 堆疊的編輯
// ────────────────────────────────────────────────────────────────────────────

/** 改一個參數：undefined = 拿掉這個鍵（回到引擎預設）。footprint 巢狀寫法的同名鍵一起拿掉，免得兩邊打架。 */
export function setParam(list: readonly EffectV1[], effectId: string, key: string, value: JsonValueLite | undefined): EffectV1[] {
  return list.map((e) => {
    if (e.id !== effectId) return e;
    const next: EffectV1 = { ...e };
    if (value === undefined) delete next[key];
    else next[key] = value;
    if (FOOTPRINT_SHORT.includes(key) && next.footprint && typeof next.footprint === "object" && !Array.isArray(next.footprint)) {
      const fp = { ...(next.footprint as Record<string, JsonValueLite>) };
      delete fp[key];
      if (Object.keys(fp).length) next.footprint = fp;
      else delete next.footprint;
    }
    return next;
  });
}

/** 一次改好幾個鍵（字型三件組、換色），同一筆 undo。 */
export function setParams(list: readonly EffectV1[], effectId: string, patch: Record<string, JsonValueLite | undefined>): EffectV1[] {
  let out = [...list];
  for (const [k, v] of Object.entries(patch)) out = setParam(out, effectId, k, v);
  return out;
}

export function setEnabled(list: readonly EffectV1[], effectId: string, enabled: boolean): EffectV1[] {
  return list.map((e) => (e.id === effectId ? { ...e, enabled } : e));
}

export function removeEffect(list: readonly EffectV1[], effectId: string): EffectV1[] {
  return list.filter((e) => e.id !== effectId);
}

/** 往前（-1）／往後（+1）搬一格；套用順序＝清單順序（後面的看得到前面的結果）。 */
export function moveEffect(list: readonly EffectV1[], effectId: string, dir: -1 | 1): EffectV1[] {
  const i = list.findIndex((e) => e.id === effectId);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return [...list];
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export function addEffect(list: readonly EffectV1[] | undefined, e: EffectV1): EffectV1[] {
  return [...(list ?? []), e];
}
