/**
 * 物件特效的欄位表（跟引擎 `engine/src/aivc/fx/params.py` 一欄一欄對齊：鍵名、預設值、範圍、單位）。
 *
 * 為什麼前端要有一份：Inspector 的「效果」表單由這張表產生，送出前再用同一組範圍驗一次（validate.ts）——
 * 引擎遇到超出範圍或不認得的鍵會整份特效檔拒收（輸出到一半才報錯最糟），在表單上就講清楚是哪一欄。
 * 改引擎的範圍＝改這張表（`fx/schema.test.ts` 釘了幾個代表值）。
 *
 * 存檔形狀（契約）：`{id, enabled, type, ...params}`，params 是 camelCase、**只存使用者設過的鍵**（沒設＝引擎預設）；
 * 引擎套用前拿掉 id / enabled 再交給 parse_effect。表單只改它認得的鍵，不認得的鍵原樣保留（但會提示：引擎會拒收）。
 *
 * 這個檔在 check-i18n 的 CORE_TABLE_SOURCES（"fx/"）裡：label / hint / 選項名都是 zh key。
 */
import type { EffectType } from "../project/format";
import { EFFECT_TYPES } from "../project/format";

// ────────────────────────────────────────────────────────────────────────────
// 欄位定義
// ────────────────────────────────────────────────────────────────────────────

export interface FieldBase {
  /** camelCase 鍵名（就是存進專案檔、送給引擎的那個）。 */
  key: string;
  /** zh key */
  label: string;
  /** zh key（選用） */
  hint?: string;
}

export interface NumberField extends FieldBase {
  kind: "number";
  min: number;
  max: number;
  step: number;
  /** 引擎的預設值（表單沒設時顯示它）。 */
  def: number;
  int?: boolean;
  /** 可以是 "auto"（引擎依物件大小 / 畫面寬換算）。 */
  auto?: boolean;
  /** auto 欄位取消「自動」時先填的值。 */
  start?: number;
  /** 顯示在欄位後面的單位（zh key 或符號）。 */
  unit?: string;
}

export interface EnumField extends FieldBase {
  kind: "enum";
  options: readonly { value: string; label: string }[];
  def: string;
}

export interface BoolField extends FieldBase {
  kind: "bool";
  def: boolean;
}

export interface ColorField extends FieldBase {
  kind: "color";
  /** null = 預設不畫（tint / background）。 */
  def: string | null;
  nullable?: boolean;
}

export interface TextField extends FieldBase {
  kind: "text";
  required?: boolean;
  multiline?: boolean;
}

export interface FileField extends FieldBase {
  kind: "file";
  required?: boolean;
  filters: { name: string; extensions: string[] }[];
}

export interface PairField extends FieldBase {
  kind: "pair";
  min: number;
  max: number;
  step: number;
  def: [number, number];
}

/** 文字特效的字型（fontFamilies / fontFile / fontWeight 三個鍵一起編，跟字幕同一套選項）。 */
export interface FontField extends FieldBase {
  kind: "font";
}

/** 換色（color.replace：{source, target, tolerance, softness}；null = 不換）。 */
export interface ReplaceColorField extends FieldBase {
  kind: "replaceColor";
}

export type FxField = NumberField | EnumField | BoolField | ColorField | TextField | FileField | PairField | FontField | ReplaceColorField;

export interface FxGroup {
  /** zh key；null = 不顯示標題（主要欄位）。 */
  title: string | null;
  fields: readonly FxField[];
  /** 預設收起來（擺放、進階）。 */
  advanced?: boolean;
}

export interface FxSpec {
  type: EffectType;
  /** zh key */
  label: string;
  /** zh key：一句話說它做什麼。 */
  line: string;
  groups: readonly FxGroup[];
  /** 引擎 from_json 接受的全部鍵（camelCase，含別名與 type）；其他鍵引擎會拒收。 */
  keys: readonly string[];
}

// ────────────────────────────────────────────────────────────────────────────
// 共用欄位（params.py 的常數與 _placed / Footprint）
// ────────────────────────────────────────────────────────────────────────────

const PX = "px";

const opt = (value: string, label: string) => ({ value, label });

export const ANCHOR_OPTIONS = [
  opt("centroid", "重心"),
  opt("center", "中央"),
  opt("top", "上緣"),
  opt("bottom", "下緣"),
  opt("left", "左緣"),
  opt("right", "右緣"),
  opt("top-left", "左上"),
  opt("top-right", "右上"),
  opt("bottom-left", "左下"),
  opt("bottom-right", "右下"),
] as const;

/** pivot 沒有 centroid（params.py PIVOTS）。 */
export const PIVOT_OPTIONS = ANCHOR_OPTIONS.filter((o) => o.value !== "centroid");

const SHAPE: EnumField = { kind: "enum", key: "shape", label: "範圍形狀", options: [opt("mask", "沿輪廓"), opt("box", "外接框"), opt("ellipse", "橢圓")], def: "mask", hint: "橢圓／外接框用平滑過的框，打碼框不會逐幀抖" };
const expand = (def: number): NumberField => ({ kind: "number", key: "expand", label: "外擴", min: -64, max: 256, step: 1, def, unit: PX, hint: "負數＝往內縮" });
const feather = (def: number): NumberField => ({ kind: "number", key: "feather", label: "羽化", min: 0, max: 128, step: 0.5, def, unit: PX });
const OPACITY: NumberField = { kind: "number", key: "opacity", label: "不透明度", min: 0, max: 1, step: 0.05, def: 1 };

const FOOTPRINT_KEYS = ["footprint", "shape", "expand", "feather"] as const;

function footprintGroup(e: number, f: number): FxGroup {
  return { title: "作用範圍", fields: [SHAPE, expand(e), feather(f)] };
}

interface PlacedDefaults {
  anchor: string;
  pivot: string;
  offset: [number, number];
  followScale: boolean;
}

const PLACED_KEYS = ["anchor", "pivot", "offset", "offsetUnits", "followScale", "followRotation", "rotation", "smooth", "refFrame", "opacity"] as const;

function placedGroup(d: PlacedDefaults): FxGroup {
  return {
    title: "擺放",
    advanced: true,
    fields: [
      { kind: "enum", key: "anchor", label: "對準物件的", options: ANCHOR_OPTIONS, def: d.anchor },
      { kind: "enum", key: "pivot", label: "用自己的", options: PIVOT_OPTIONS, def: d.pivot },
      { kind: "pair", key: "offset", label: "偏移", min: -1e5, max: 1e5, step: 0.01, def: d.offset },
      { kind: "enum", key: "offsetUnits", label: "偏移單位", options: [opt("bbox", "外接框的倍數"), opt("px", "像素")], def: "bbox" },
      { kind: "bool", key: "followScale", label: "大小跟著物件", def: d.followScale },
      { kind: "bool", key: "followRotation", label: "跟著物件旋轉", def: false, hint: "給長形物件用；近圓形的物件方向量不準" },
      { kind: "number", key: "rotation", label: "額外旋轉", min: -3600, max: 3600, step: 1, def: 0, unit: "度" },
      { kind: "bool", key: "smooth", label: "用平滑後的位置", def: true },
      { kind: "number", key: "refFrame", label: "參考幀", min: 0, max: 2 ** 31, step: 1, def: Number.NaN, int: true, hint: "大小與角度的基準；空白＝第一個看得到的幀" },
      OPACITY,
    ],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 七種特效
// ────────────────────────────────────────────────────────────────────────────

const IMAGE_FILTERS = [{ name: "PNG / WebP / JPEG", extensions: ["png", "webp", "jpg", "jpeg"] }];

export const FX_SPECS: Readonly<Record<EffectType, FxSpec>> = {
  mosaic: {
    type: "mosaic",
    label: "馬賽克",
    line: "格子打碼（隱私最常用）",
    keys: ["type", "block", "blocks", "minBlock", "align", "opacity", ...FOOTPRINT_KEYS],
    groups: [
      {
        title: null,
        fields: [
          { kind: "number", key: "block", label: "格子大小", min: 2, max: 512, step: 1, def: Number.NaN, auto: true, start: 16, unit: PX, hint: "自動＝外接框短邊 ÷ 格數" },
          { kind: "number", key: "blocks", label: "格數（自動時）", min: 2, max: 200, step: 1, def: 10 },
          { kind: "number", key: "minBlock", label: "最小格子", min: 2, max: 256, step: 1, def: 4, int: true, unit: PX },
          { kind: "enum", key: "align", label: "格子對齊", options: [opt("frame", "畫面"), opt("object", "物件")], def: "frame", hint: "對齊物件：物件移動時格子跟著走，比較不會「爬」" },
          OPACITY,
        ],
      },
      footprintGroup(4, 1),
    ],
  },
  blur: {
    type: "blur",
    label: "模糊",
    line: "高斯模糊，只用物件自己的像素",
    keys: ["type", "radius", "strength", "minRadius", "opacity", ...FOOTPRINT_KEYS],
    groups: [
      {
        title: null,
        fields: [
          { kind: "number", key: "radius", label: "半徑", min: 1, max: 512, step: 1, def: Number.NaN, auto: true, start: 12, unit: PX, hint: "自動＝外接框短邊 × 強度" },
          { kind: "number", key: "strength", label: "強度（自動時）", min: 0.01, max: 2, step: 0.01, def: 0.2 },
          { kind: "number", key: "minRadius", label: "最小半徑", min: 1, max: 64, step: 0.5, def: 2, unit: PX },
          OPACITY,
        ],
      },
      footprintGroup(4, 2),
    ],
  },
  color: {
    type: "color",
    label: "調色",
    line: "色相、飽和、亮度、上色與換色（保留明暗）",
    keys: ["type", "hue", "saturation", "brightness", "desaturate", "tint", "tintAmount", "replace", "opacity", ...FOOTPRINT_KEYS],
    groups: [
      {
        title: null,
        fields: [
          { kind: "number", key: "hue", label: "色相", min: -360, max: 360, step: 1, def: 0, unit: "度" },
          { kind: "number", key: "saturation", label: "飽和度", min: 0, max: 4, step: 0.05, def: 1, unit: "×" },
          { kind: "number", key: "brightness", label: "亮度", min: 0, max: 8, step: 0.05, def: 1, unit: "×" },
          { kind: "number", key: "desaturate", label: "去色", min: 0, max: 1, step: 0.05, def: 0, hint: "1＝全灰" },
          { kind: "color", key: "tint", label: "上色", def: null, nullable: true },
          { kind: "number", key: "tintAmount", label: "上色量", min: 0, max: 1, step: 0.05, def: 0, hint: "設了上色但沒設量＝0.5" },
          { kind: "replaceColor", key: "replace", label: "換色" },
          OPACITY,
        ],
      },
      footprintGroup(0, 1),
    ],
  },
  outline: {
    type: "outline",
    label: "描邊",
    line: "沿輪廓或外接框畫線",
    keys: ["type", "color", "width", "mode", "smooth", "opacity"],
    groups: [
      {
        title: null,
        fields: [
          { kind: "color", key: "color", label: "顏色", def: "#FF4040" },
          { kind: "number", key: "width", label: "線寬", min: 0.5, max: 200, step: 0.5, def: Number.NaN, auto: true, start: 4, unit: PX, hint: "自動＝畫面寬的 0.35%" },
          { kind: "enum", key: "mode", label: "形狀", options: [opt("contour", "沿輪廓"), opt("box", "方框")], def: "contour" },
          { kind: "number", key: "smooth", label: "輪廓平滑", min: 0, max: 20, step: 1, def: 2, int: true, unit: PX },
          OPACITY,
        ],
      },
    ],
  },
  glow: {
    type: "glow",
    label: "光暈",
    line: "物件外圈一層柔光，物件本身不動",
    keys: ["type", "color", "radius", "intensity", "spread", "opacity"],
    groups: [
      {
        title: null,
        fields: [
          { kind: "color", key: "color", label: "顏色", def: "#FFFFFF" },
          { kind: "number", key: "radius", label: "半徑", min: 1, max: 512, step: 1, def: Number.NaN, auto: true, start: 24, unit: PX, hint: "自動＝畫面寬的 2%" },
          { kind: "number", key: "intensity", label: "強度", min: 0, max: 4, step: 0.05, def: 1 },
          { kind: "number", key: "spread", label: "擴張", min: 0, max: 256, step: 1, def: 2, unit: PX },
          OPACITY,
        ],
      },
    ],
  },
  sticker: {
    type: "sticker",
    label: "貼紙",
    line: "一張圖黏在物件上，跟著走",
    keys: ["type", "image", "width", "widthUnits", ...PLACED_KEYS],
    groups: [
      {
        title: null,
        fields: [
          { kind: "file", key: "image", label: "圖片", required: true, filters: IMAGE_FILTERS, hint: "透明背景的 PNG 效果最好" },
          { kind: "number", key: "width", label: "寬度", min: 1e-4, max: 1e5, step: 0.05, def: 1 },
          { kind: "enum", key: "widthUnits", label: "寬度單位", options: [opt("bbox", "外接框寬的倍數"), opt("px", "像素"), opt("frame", "畫面寬的比例")], def: "bbox" },
        ],
      },
      placedGroup({ anchor: "center", pivot: "center", offset: [0, 0], followScale: true }),
    ],
  },
  text: {
    type: "text",
    label: "文字",
    line: "標籤跟著物件走（字型同字幕）",
    keys: ["type", "text", "size", "sizeUnits", "color", "strokeColor", "strokeWidth", "background", "padding", "radius", "fontFamilies", "fontFile", "fontWeight", "language", "font", ...PLACED_KEYS],
    groups: [
      {
        title: null,
        fields: [
          { kind: "text", key: "text", label: "文字", required: true, multiline: true },
          { kind: "number", key: "size", label: "字級", min: 1e-4, max: 1e4, step: 0.005, def: 0.05 },
          { kind: "enum", key: "sizeUnits", label: "字級單位", options: [opt("frame", "畫面高的比例"), opt("px", "像素"), opt("bbox", "外接框高的比例")], def: "frame" },
          { kind: "color", key: "color", label: "文字顏色", def: "#FFFFFF" },
          { kind: "color", key: "strokeColor", label: "描邊顏色", def: "#000000" },
          { kind: "number", key: "strokeWidth", label: "描邊寬", min: 0, max: 0.5, step: 0.01, def: 0.12, hint: "字級的比例" },
          { kind: "color", key: "background", label: "底色", def: null, nullable: true },
          { kind: "number", key: "padding", label: "底色內距", min: 0, max: 2, step: 0.05, def: 0.3, unit: "em" },
          { kind: "number", key: "radius", label: "底色圓角", min: 0, max: 1, step: 0.05, def: 0.3, unit: "em" },
          { kind: "font", key: "fontFamilies", label: "字型" },
        ],
      },
      placedGroup({ anchor: "top", pivot: "bottom", offset: [0, -0.04], followScale: false }),
    ],
  },
};

export const FX_TYPE_LABEL: Readonly<Record<EffectType, string>> = Object.fromEntries(EFFECT_TYPES.map((t) => [t, FX_SPECS[t].label])) as Record<EffectType, string>;

export function isKnownEffectType(type: string): type is EffectType {
  return (EFFECT_TYPES as readonly string[]).includes(type);
}

export function specOf(type: string): FxSpec | null {
  return isKnownEffectType(type) ? FX_SPECS[type] : null;
}

/** 字型粗細的選項（字幕樣式那一套；引擎吃 100–1000 的整數）。 */
export const FONT_WEIGHTS: readonly number[] = [400, 500, 700, 800, 900];
export const FONT_FILTERS = [{ name: "TrueType / OpenType", extensions: ["ttf", "otf", "ttc"] }];

