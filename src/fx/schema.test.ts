// 特效欄位表與驗證：跟引擎 engine/src/aivc/fx/params.py 同一組鍵、預設、範圍。
// 這些值改了＝契約改了：引擎與這張表要一起改（不然表單送出去的東西會被引擎整份拒收）。
import { describe, expect, it } from "vitest";
import { EFFECT_TYPES, type EffectV1 } from "../project/format";
import { addEffect, engineEffect, fieldValue, moveEffect, newEffect, privacyMosaic, removeEffect, setEnabled, setParam, setParams } from "./effect";
import { FX_SPECS, specOf, type FxField, type NumberField } from "./schema";
import { colorToHex6, enginePayload, isAutoValue, isEngineColor, stackErrors, validateEffect } from "./validate";

const fx = (type: string, params: Record<string, unknown> = {}): EffectV1 => ({ id: "e1", enabled: true, type, ...params }) as EffectV1;
const field = (type: keyof typeof FX_SPECS, key: string): FxField => FX_SPECS[type].groups.flatMap((g) => g.fields).find((f) => f.key === key)!;
const num = (type: keyof typeof FX_SPECS, key: string) => field(type, key) as NumberField;
const errs = (e: EffectV1) => validateEffect(e).filter((i) => i.level === "error");

describe("欄位表 = params.py", () => {
  it("七種特效都有表、type 名跟引擎一樣", () => {
    expect(Object.keys(FX_SPECS).sort()).toEqual([...EFFECT_TYPES].sort());
    for (const t of EFFECT_TYPES) expect(FX_SPECS[t].type).toBe(t);
  });

  it("每個表單欄位的鍵都是引擎收的鍵（字型欄位編三個鍵）", () => {
    for (const t of EFFECT_TYPES) {
      const keys = FX_SPECS[t].keys;
      for (const f of FX_SPECS[t].groups.flatMap((g) => g.fields)) {
        if (f.kind === "font") expect(["fontFamilies", "fontFile", "fontWeight"].every((k) => keys.includes(k))).toBe(true);
        else expect(keys, `${t}.${f.key}`).toContain(f.key);
      }
    }
  });

  it("代表性的範圍與預設（params.py 的 _num / _int / _auto_num）", () => {
    expect([num("mosaic", "block").min, num("mosaic", "block").max, num("mosaic", "block").auto]).toEqual([2, 512, true]);
    expect([num("mosaic", "blocks").min, num("mosaic", "blocks").max, num("mosaic", "blocks").def]).toEqual([2, 200, 10]);
    expect([num("mosaic", "minBlock").int, num("mosaic", "minBlock").def, num("mosaic", "minBlock").max]).toEqual([true, 4, 256]);
    expect([num("blur", "strength").min, num("blur", "strength").max, num("blur", "strength").def]).toEqual([0.01, 2, 0.2]);
    expect([num("color", "hue").min, num("color", "hue").max, num("color", "brightness").max, num("color", "saturation").max]).toEqual([-360, 360, 8, 4]);
    expect([num("outline", "width").min, num("outline", "smooth").int, num("outline", "smooth").max]).toEqual([0.5, true, 20]);
    expect([num("glow", "intensity").max, num("glow", "spread").max]).toEqual([4, 256]);
    expect([num("text", "strokeWidth").max, num("text", "padding").max, num("text", "radius").max, num("text", "size").def]).toEqual([0.5, 2, 1, 0.05]);
    expect([num("mosaic", "expand").min, num("mosaic", "expand").max, num("mosaic", "feather").max]).toEqual([-64, 256, 128]);
    // footprint 的預設依特效不同（Footprint("mask", 4, 1) / (4, 2) / (0, 1)）
    expect([num("mosaic", "expand").def, num("mosaic", "feather").def, num("blur", "feather").def, num("color", "expand").def]).toEqual([4, 1, 2, 0]);
    // 文字的擺放預設跟貼紙不一樣（anchor top、pivot bottom、往上 4%、不跟著縮放）
    expect((field("text", "anchor") as { def: string }).def).toBe("top");
    expect((field("sticker", "anchor") as { def: string }).def).toBe("center");
    expect((field("text", "followScale") as { def: boolean }).def).toBe(false);
  });

  it("pivot 沒有 centroid（params.py PIVOTS）", () => {
    const pivot = field("sticker", "pivot") as { options: readonly { value: string }[] };
    expect(pivot.options.map((o) => o.value)).not.toContain("centroid");
    expect((field("sticker", "anchor") as { options: readonly { value: string }[] }).options.map((o) => o.value)).toContain("centroid");
  });
});

describe("validateEffect", () => {
  it("新加的特效（除了還沒選圖的貼紙）引擎都收", () => {
    for (const t of EFFECT_TYPES) {
      const e = newEffect(t, { label: "臉" });
      if (t === "sticker") expect(errs(e).map((i) => i.key)).toEqual(["image"]);
      else expect(errs(e), t).toEqual([]);
    }
    expect(errs(newEffect("sticker", { image: "D:\\hat.png" }))).toEqual([]);
  });

  it("超出範圍、非整數、不是數字都標在那一欄", () => {
    expect(errs(fx("mosaic", { blocks: 1 }))).toMatchObject([{ key: "blocks", msg: "超出範圍 {min}–{max}" }]);
    expect(errs(fx("mosaic", { minBlock: 4.5 }))).toMatchObject([{ key: "minBlock", msg: "要是整數" }]);
    expect(errs(fx("blur", { strength: "lots" }))).toMatchObject([{ key: "strength", msg: "要是數字" }]);
    expect(errs(fx("text", { text: "hi", fontWeight: 1200 }))).toMatchObject([{ key: "fontWeight" }]);
  });

  it("auto 只給可以 auto 的欄位", () => {
    expect(errs(fx("mosaic", { block: "auto" }))).toEqual([]);
    expect(errs(fx("mosaic", { block: "AUTO" }))).toEqual([]);
    expect(errs(fx("mosaic", { blocks: "auto" }))).toMatchObject([{ key: "blocks" }]);
    expect(isAutoValue(num("mosaic", "block"), undefined)).toBe(true);
    expect(isAutoValue(num("mosaic", "block"), 16)).toBe(false);
  });

  it("不認得的鍵：引擎會拒收 → 錯；不認得的特效類型：原樣保留 → 只是提示", () => {
    expect(errs(fx("mosaic", { strength: 1 }))).toMatchObject([{ key: null, params: { keys: "strength" } }]);
    // smooth 只能寫在 footprint 裡，直接寫在 mosaic 上引擎不收
    expect(errs(fx("mosaic", { smooth: false }))).toHaveLength(1);
    expect(errs(fx("mosaic", { footprint: { shape: "box", smooth: false } }))).toEqual([]);
    expect(errs(fx("mosaic", { footprint: { blur: 1 } }))).toMatchObject([{ key: "footprint" }]);
    const unknown = validateEffect(fx("sparkle", { x: 1 }));
    expect(unknown).toMatchObject([{ level: "warn", params: { type: "sparkle" } }]);
  });

  it("必填：文字、貼紙圖", () => {
    expect(errs(fx("text", {}))).toMatchObject([{ key: "text", msg: "必填" }]);
    expect(errs(fx("text", { text: "  " }))).toMatchObject([{ key: "text" }]);
    expect(errs(fx("sticker", {}))).toMatchObject([{ key: "image", msg: "要選一個檔案" }]);
  });

  it("enum 跟引擎一樣不分大小寫；不在選項裡的標錯", () => {
    expect(errs(fx("mosaic", { shape: "Ellipse" }))).toEqual([]);
    expect(errs(fx("mosaic", { shape: "circle" }))).toMatchObject([{ key: "shape" }]);
    expect(errs(fx("sticker", { image: "a.png", pivot: "centroid" }))).toMatchObject([{ key: "pivot" }]);
  });

  it("顏色：#RRGGBB、#RRGGBBAA、[r,g,b(,a)]、\"r,g,b\"（parse_color 的四種寫法）", () => {
    for (const ok of ["#FF0000", "#ff000080", [255, 0, 0], [0, 0, 0, 128], "10,20,30", "10，20，30"]) expect(isEngineColor(ok), JSON.stringify(ok)).toBe(true);
    for (const bad of ["red", "#F00", [256, 0, 0], "1,2", 5, null]) expect(isEngineColor(bad), JSON.stringify(bad)).toBe(false);
    expect(errs(fx("outline", { color: "red" }))).toMatchObject([{ key: "color" }]);
    expect(colorToHex6("#ff000080")).toBe("#FF0000");
    expect(colorToHex6([1, 2, 255])).toBe("#0102FF");
    expect(colorToHex6("nope")).toBeNull();
  });

  it("換色：source/target（或 from/to）都要有、容差柔邊 0–1、沒有別的鍵", () => {
    expect(errs(fx("color", { replace: { source: "#FF0000", target: "#00FF00" } }))).toEqual([]);
    expect(errs(fx("color", { replace: { from: "#FF0000", to: "#00FF00", tolerance: 0.3 } }))).toEqual([]);
    expect(errs(fx("color", { replace: { source: "#FF0000" } }))).toMatchObject([{ key: "replace" }]);
    expect(errs(fx("color", { replace: { source: "#FF0000", target: "#00FF00", softness: 2 } }))).toMatchObject([{ key: "replace" }]);
    expect(errs(fx("color", { replace: { source: "#FF0000", target: "#00FF00", gamma: 1 } }))).toMatchObject([{ key: "replace" }]);
  });

  it("offset 是兩個數字", () => {
    expect(errs(fx("sticker", { image: "a.png", offset: [0, -0.5] }))).toEqual([]);
    expect(errs(fx("sticker", { image: "a.png", offset: [0] }))).toMatchObject([{ key: "offset" }]);
  });
});

describe("送給引擎的形狀", () => {
  it("拿掉 id / enabled，其他鍵原樣（camelCase）", () => {
    expect(engineEffect(fx("mosaic", { shape: "ellipse", minBlock: 6 }))).toEqual({ type: "mosaic", shape: "ellipse", minBlock: 6 });
  });

  it("關掉的、有錯的、不認得的不送；其餘照順序", () => {
    const list = [fx("mosaic"), { ...fx("blur"), id: "b", enabled: false }, { ...fx("glow", { intensity: 9 }), id: "g" }, { ...fx("sparkle"), id: "s" }, { ...fx("outline"), id: "o" }];
    expect(enginePayload(list)).toEqual([{ type: "mosaic" }, { type: "outline" }]);
    expect(stackErrors(list)).toBe(1);
    expect(enginePayload(undefined)).toEqual([]);
  });
});

describe("堆疊編輯（純函式）", () => {
  const a = fx("mosaic");
  const b = { ...fx("blur"), id: "b" };
  const c = { ...fx("text", { text: "x" }), id: "c" };

  it("改參數 / 拿掉參數；footprint 巢狀的同名鍵一起拿掉", () => {
    const withFp = { ...a, footprint: { shape: "box", feather: 3 } } as EffectV1;
    expect(fieldValue(withFp, "shape")).toBe("box");
    const next = setParam([withFp], "e1", "shape", "ellipse")[0];
    expect(next.shape).toBe("ellipse");
    expect(next.footprint).toEqual({ feather: 3 });
    const cleared = setParam([next], "e1", "feather", 2)[0];
    expect("footprint" in cleared).toBe(false);
    expect(setParam([a], "e1", "blocks", undefined)[0]).toEqual(a);
    expect(setParams([c], "c", { fontFamilies: ["Noto Sans TC"], fontWeight: 900, fontFile: undefined })[0]).toMatchObject({ fontFamilies: ["Noto Sans TC"], fontWeight: 900 });
  });

  it("加、刪、開關、上下搬（邊界不動）", () => {
    expect(addEffect(undefined, a)).toEqual([a]);
    expect(removeEffect([a, b], "e1")).toEqual([b]);
    expect(setEnabled([a], "e1", false)[0].enabled).toBe(false);
    expect(moveEffect([a, b, c], "c", -1).map((e) => e.id)).toEqual(["e1", "c", "b"]);
    expect(moveEffect([a, b, c], "e1", -1).map((e) => e.id)).toEqual(["e1", "b", "c"]);
    expect(moveEffect([a, b, c], "c", 1).map((e) => e.id)).toEqual(["e1", "b", "c"]);
  });

  it("新特效 id 不重複", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newEffect("mosaic").id));
    expect(ids.size).toBe(50);
  });

  it("隱私打碼：臉＝橢圓、其他（車牌）＝外接框，都外擴 6 px", () => {
    expect(privacyMosaic("face")).toMatchObject({ type: "mosaic", shape: "ellipse", expand: 6, enabled: true });
    expect(privacyMosaic("license plate")).toMatchObject({ shape: "box" });
    expect(privacyMosaic(null)).toMatchObject({ shape: "ellipse" });
    expect(errs(privacyMosaic("license plate"))).toEqual([]);
  });

  it("specOf 不分大小寫、不認得回 null", () => {
    expect(specOf("mosaic")?.label).toBe("馬賽克");
    expect(specOf("nope")).toBeNull();
  });
});
