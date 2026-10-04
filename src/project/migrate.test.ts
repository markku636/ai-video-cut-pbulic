import { describe, expect, it } from "vitest";
import { ProjectFormatError, SCHEMA_VERSION } from "./format";
import { migrate } from "./migrate";

describe("migrate", () => {
  it("目前版本原樣通過（applied 空）", () => {
    const doc = { schemaVersion: SCHEMA_VERSION, media: [], shots: {}, tracks: {}, cardSlots: {} };
    const r = migrate(doc);
    expect(r.from).toBe(SCHEMA_VERSION);
    expect(r.applied).toEqual([]);
    expect(r.doc).toBe(doc);
  });

  it("沒有 schemaVersion（0）→ 一路升到 2：v1 那步補 shots / tracks、media 補 proxy:null；v2 那步補隱含序列", () => {
    const r = migrate({ media: [{ id: "a", path: "x.webm" }], analysis: { a: {} } });
    expect(r.from).toBe(0);
    expect(r.applied).toEqual([1, 2]);
    expect(r.doc.schemaVersion).toBe(2);
    // profile 與外掛的頂層鍵（例如 cardSlots）不寫死：sanitize 補（工作模式 → 外掛宣告的 legacy，沒有就 generic）
    expect(r.doc.profile).toBeUndefined();
    expect("cardSlots" in r.doc).toBe(false);
    expect(r.doc.shots).toEqual({});
    expect((r.doc.media as Record<string, unknown>[])[0]).toEqual({ proxy: null, id: "a", path: "x.webm" });
    expect(r.doc.sequence).toBeNull();
    expect(r.doc.audioMedia).toEqual([]);
    // 不認得的舊欄位留著，讓 sanitize 決定要不要丟
    expect(r.doc.analysis).toBeDefined();
  });

  it("空物件也能升（等於全新的空專案，隱含序列）", () => {
    const r = migrate({});
    expect(r.doc.schemaVersion).toBe(2);
    expect(r.doc.media).toEqual([]);
    expect(r.doc.sequence).toBeNull();
    expect(r.doc.audioMedia).toEqual([]);
  });

  it("v1 → v2 只加兩個鍵：不產生整段片段的序列（proxy 可能還不知道幀數），其他欄位原封不動", () => {
    const v1 = { schemaVersion: 1, media: [{ id: "m1", path: "x.webm", proxy: null }], shots: { m1: [] }, tracks: { m1: [] }, cardSlots: { m1: [] }, deck: { styleId: "demo-deck", source: "builtin" }, captions: { m1: { enabled: true } } };
    const r = migrate(JSON.parse(JSON.stringify(v1)));
    expect(r.applied).toEqual([2]);
    expect(r.doc).toEqual({ ...v1, schemaVersion: 2, sequence: null, audioMedia: [] });
  });

  it("v1 檔已經帶著 sequence / audioMedia（手改或新版降回來）→ 原樣留給 sanitize 驗；形狀不對的換成 null / []", () => {
    const seq = { id: "seq-1", video: [] };
    const kept = migrate({ schemaVersion: 1, media: [], sequence: seq, audioMedia: [{ id: "a-1" }] });
    expect(kept.doc.sequence).toBe(seq);
    expect(kept.doc.audioMedia).toEqual([{ id: "a-1" }]);
    const bad = migrate({ schemaVersion: 1, media: [], sequence: [1, 2], audioMedia: { id: "a-1" } });
    expect(bad.doc.sequence).toBeNull();
    expect(bad.doc.audioMedia).toEqual([]);
  });

  it("版本大於目前才擲錯", () => {
    expect(() => migrate({ schemaVersion: SCHEMA_VERSION + 1 })).toThrow(ProjectFormatError);
    expect(() => migrate({ schemaVersion: 3 })).toThrow(/較新版本/);
    expect(() => migrate({ schemaVersion: 999 })).toThrow(/較新版本/);
  });

  it("不是物件 / 版本不是整數 → 擲錯", () => {
    expect(() => migrate("nope")).toThrow(ProjectFormatError);
    expect(() => migrate(null)).toThrow(ProjectFormatError);
    expect(() => migrate([])).toThrow(ProjectFormatError);
    expect(() => migrate({ schemaVersion: "1" })).toThrow(ProjectFormatError);
    expect(() => migrate({ schemaVersion: 1.5 })).toThrow(ProjectFormatError);
  });

  it("鏈式：每一步只做自己那一版（from + 1 .. SCHEMA_VERSION 逐步套用）", () => {
    const r = migrate({ schemaVersion: 0, media: [] });
    expect(r.applied).toEqual(Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1));
  });
});
