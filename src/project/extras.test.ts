import { describe, expect, it } from "vitest";
// 這裡不登記任何外掛（= 開源版）：外掛擁有的頂層鍵（例如牌的 cardSlots / deck）在核心眼中就是 extras，原樣保留。
// 牌外掛的標記 / 格位純函式搬進了外掛：plugins/cards/frontend/project/extras.test.ts。
import { knownTopKeys, readProjectExtras, withProjectExtras } from "./extras";
import { emptyReport } from "./sanitize";

describe("readProjectExtras", () => {
  it("只收未知的頂層鍵；已知鍵（含 M2 的 sequence / audioMedia）與危險鍵不收", () => {
    const doc = JSON.parse('{"schemaVersion":1,"media":[],"sequence":{"x":1},"audioMedia":[],"captions":{},"contentNote":"n","pluginMarker":{"profile":"x"},"__proto__":{"polluted":1}}');
    const r = emptyReport();
    const x = readProjectExtras(doc, r);
    expect(Object.keys(x).sort()).toEqual(["contentNote", "pluginMarker"]);
    expect(r.dropped.extras).toBe(1);
    for (const k of knownTopKeys()) expect(k in x).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("不是純 JSON 值的丟並回報；不是物件 → 空", () => {
    const r = emptyReport();
    expect(readProjectExtras({ a: Number.NaN, b: [1, 2] }, r)).toEqual({ b: [1, 2] });
    expect(r.total).toBe(1);
    expect(readProjectExtras(null)).toEqual({});
    expect(readProjectExtras([1])).toEqual({});
  });
});

describe("withProjectExtras", () => {
  it("extras 空 → 同一個物件", () => {
    const doc = { a: 1 };
    expect(withProjectExtras(doc, {})).toBe(doc);
  });
  it("從不覆寫、接在後面、已知鍵不接", () => {
    const doc = { schemaVersion: 1, contentNote: "mine" };
    const out = withProjectExtras(doc, { contentNote: "other", pluginMarker: { profile: "x" }, media: [] });
    expect(out).toEqual({ schemaVersion: 1, contentNote: "mine", pluginMarker: { profile: "x" } });
    expect(Object.keys(out)).toEqual(["schemaVersion", "contentNote", "pluginMarker"]);
    expect(doc).toEqual({ schemaVersion: 1, contentNote: "mine" });
  });
});

describe("沒有外掛時外掛的頂層鍵是 extras", () => {
  it("cardSlots / deck 不在已知鍵裡：讀成 extras、存檔時原樣接回去（位置在既有鍵之後）", () => {
    expect(knownTopKeys()).not.toContain("cardSlots");
    expect(knownTopKeys()).not.toContain("deck");
    const doc = { schemaVersion: 2, media: [], cardSlots: { m1: [{ id: "p1" }] }, deck: { styleId: "demo-deck", source: "builtin" } };
    const x = readProjectExtras(doc);
    expect(x).toEqual({ cardSlots: { m1: [{ id: "p1" }] }, deck: { styleId: "demo-deck", source: "builtin" } });
    const out = withProjectExtras({ schemaVersion: 2, media: [] }, x);
    expect(Object.keys(out)).toEqual(["schemaVersion", "media", "cardSlots", "deck"]);
  });
});
