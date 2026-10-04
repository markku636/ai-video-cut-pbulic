// 壞掉的專案檔不該讓時間軸靜靜地壞掉：每一條對應一種「進了 store 才會發作」的資料。
import { describe, expect, it } from "vitest";
import { buildProjectFile, EXPORT_DEFAULTS, INSERT_DEFAULTS, SCHEMA_VERSION } from "./format";
import { migrate } from "./migrate";
import { emptyReport, isJsonValue, parseProjectFile, sanitizeInsert, sanitizeQuad, sanitizeShots, sanitizeTracks, validFrame } from "./sanitize";

// 這裡不登記任何外掛（= 開源版）。牌外掛的鍵（cardSlots / deck / slotId / identity…）怎麼驗在
// plugins/cards/frontend/project/sanitize.test.ts；沒有外掛時核心原樣保留它們（下面「沒有外掛」那一組）。

const Q = { p: [[0, 0], [100, 0], [100, 80], [0, 80]] };
const BOWTIE = { p: [[0, 0], [100, 80], [100, 0], [0, 80]] };
const proxy = { version: 1, fps: { num: 30, den: 1 }, frames: 1797, width: 1280, height: 720, scale: 1, path: "C:\\c\\proxy.mp4" };

function track(extra: Record<string, unknown> = {}) {
  return { id: "t1", shotId: "s1", label: "牌 1", kind: "planar", referenceFrame: 10, trackingRegion: null, keyframes: [{ frame: 10, quad: Q, source: "user" }], prompts: [], adjust: { points: [], enabled: false }, options: { method: "classic", motionModel: "perspective", smoothing: 0.4 }, insert: null, regionPolicy: "full", stale: false, ...extra };
}

describe("validFrame", () => {
  it("有限整數、≥0、< frames", () => {
    expect(validFrame(0, 100)).toBe(true);
    expect(validFrame(99, 100)).toBe(true);
    expect(validFrame(100, 100)).toBe(false);
    expect(validFrame(-1, 100)).toBe(false);
    expect(validFrame(1.5, 100)).toBe(false);
    expect(validFrame("abc", 100)).toBe(false);
    expect(validFrame(Number.NaN, null)).toBe(false);
    expect(validFrame(5000, null)).toBe(true); // 沒有 proxy 不驗上限
  });
});

describe("sanitizeQuad", () => {
  it("凸的留、蝴蝶結丟、NaN 丟、少一點丟", () => {
    expect(sanitizeQuad(Q)).toEqual(Q);
    expect(sanitizeQuad(BOWTIE)).toBeNull();
    expect(sanitizeQuad({ p: [[0, 0], [Number.NaN, 0], [100, 80], [0, 80]] })).toBeNull();
    expect(sanitizeQuad({ p: [[0, 0], [100, 0], [100, 80]] })).toBeNull();
    expect(sanitizeQuad("x")).toBeNull();
  });
});

describe("sanitizeShots", () => {
  it("排序、endFrame 可等於 frames、超出 / 反向丟", () => {
    const r = emptyReport();
    const out = sanitizeShots(
      [
        { id: "b", startFrame: 60, endFrame: 100, kind: "wide", source: "auto" },
        { id: "a", startFrame: 0, endFrame: 60, kind: "close", source: "user" },
        { id: "bad1", startFrame: 90, endFrame: 101 },
        { id: "bad2", startFrame: 50, endFrame: 40 },
        { id: "bad3", startFrame: "x", endFrame: 40 },
      ],
      100,
      r,
    );
    expect(out.map((s) => s.id)).toEqual(["a", "b"]);
    expect(out[1].kind).toBe("wide");
    expect(r.dropped.shots).toBe(3);
  });
  it("不是陣列回空的而不是丟例外", () => {
    const r = emptyReport();
    expect(sanitizeShots("boom", 10, r)).toEqual([]);
    expect(sanitizeShots(undefined, 10, r)).toEqual([]);
    expect(r.dropped.shots).toBe(1);
  });
});

describe("sanitizeTracks", () => {
  const shots = new Set(["s1"]);
  it("**{frame:'abc'} 的關鍵幀丟掉並回報**，track 本身留著", () => {
    const r = emptyReport();
    const out = sanitizeTracks([track({ keyframes: [{ frame: "abc", quad: Q }, { frame: 20, quad: Q }, { frame: 30, quad: BOWTIE }] })], 1797, shots, r);
    expect(out).toHaveLength(1);
    expect(out[0].keyframes.map((k) => k.frame)).toEqual([20]);
    expect(r.dropped.keyframes).toBe(2);
  });
  it("關鍵幀 ≥ proxy.frames 丟；同一幀兩個關鍵幀只留第一個", () => {
    const r = emptyReport();
    const out = sanitizeTracks([track({ keyframes: [{ frame: 1797, quad: Q }, { frame: 5, quad: Q }, { frame: 5, quad: Q }] })], 1797, shots, r);
    expect(out[0].keyframes.map((k) => k.frame)).toEqual([5]);
    expect(r.dropped.keyframes).toBe(2);
  });
  it("提示點 label 只收 0 / 1；沒剩下點的提示整筆丟", () => {
    const r = emptyReport();
    const out = sanitizeTracks([track({ prompts: [{ frame: 1, points: [{ x: 1, y: 2, label: 1 }, { x: 1, y: 2, label: 2 }, { x: 1, y: 2, label: "1" }] }, { frame: 2, points: [{ x: 1, y: 2, label: 5 }] }] })], 1797, shots, r);
    expect(out[0].prompts).toHaveLength(1);
    expect(out[0].prompts[0].points).toHaveLength(1);
    expect(r.dropped.promptPoints).toBe(3);
    expect(r.dropped.prompts).toBe(1);
  });
  it("shotId 指不到鏡頭 / 重複 id → 整條丟", () => {
    const r = emptyReport();
    const out = sanitizeTracks([track({ shotId: "nope" }), track(), track()], 1797, shots, r);
    expect(out).toHaveLength(1);
    expect(r.dropped.tracks).toBe(2);
  });
  it("referenceFrame 超出 → null；regionPolicy 不是值 → full；trackingRegion 非凸 → null + 回報", () => {
    const r = emptyReport();
    const out = sanitizeTracks([track({ referenceFrame: 9999, regionPolicy: "!!", trackingRegion: BOWTIE }), track({ id: "t2", regionPolicy: 3 })], 1797, shots, r);
    expect(out[0].referenceFrame).toBeNull();
    expect(out[0].regionPolicy).toBe("full");
    expect(out[1].regionPolicy).toBe("full");
    expect(out[0].trackingRegion).toBeNull();
    expect(r.dropped.trackingRegion).toBe(1);
  });
  it("regionPolicy 不認得但像一個值（沒裝的外掛加的，例如 keepBarcode）→ 原樣保留；hold 照收", () => {
    const r = emptyReport();
    const out = sanitizeTracks([track({ regionPolicy: "keepBarcode" }), track({ id: "t2", regionPolicy: "hold" })], 1797, shots, r);
    expect(out.map((t) => t.regionPolicy)).toEqual(["keepBarcode", "hold"]);
    expect(r.total).toBe(0);
  });
  it("adjust 參考點：primaryFrame 壞掉退回自己的 frame；cornerIndex 只收 0–3", () => {
    const r = emptyReport();
    const out = sanitizeTracks([track({ adjust: { enabled: true, points: [{ id: "p1", frame: 3, cornerIndex: 7, xy: [1, 2], locked: true, primaryFrame: "x" }] } })], 1797, shots, r);
    const p = out[0].adjust.points[0];
    expect(p.cornerIndex).toBeNull();
    expect(p.primaryFrame).toBe(3);
    expect(p.locked).toBe(true);
    expect(out[0].adjust.enabled).toBe(true);
  });
});

describe("sanitizeInsert", () => {
  it("null 留 null；半套子物件整組丟並回報；數值夾範圍", () => {
    const r = emptyReport();
    expect(sanitizeInsert(null, r)).toBeNull();
    const out = sanitizeInsert({ macro: "full", opacity: 150, edge: { choke: 1 }, motionBlur: { shutterAngle: 400, samples: 20 }, resample: { kernel: "lanczos3" } }, r);
    expect(out).toMatchObject({ macro: "full", opacity: 100, motionBlur: { shutterAngle: 360, shutterPhase: "centered", samples: 9 }, resample: { kernel: "lanczos3", clamp: true } });
    expect(out?.edge).toBeUndefined();
    expect(r.dropped["insert.edge"]).toBe(1);
  });
});

describe("parseProjectFile（整份）", () => {
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    app: { name: "AI Video Cut", version: "0.0.1" },
    media: [{ id: "m1", path: "D:\\v\\clip.webm", name: "clip.webm", fingerprint: "ab".repeat(32), probe: null, proxy }],
    activeMediaId: "m1",
    profile: "cards",
    shots: { m1: [{ id: "s1", startFrame: 0, endFrame: 1797, kind: "close", source: "auto" }], ghost: [] },
    tracks: { m1: [track({ keyframes: [{ frame: 10, quad: Q, source: "user" }, { frame: 1797, quad: Q }] })] },
    cardSlots: { m1: [{ id: "Player1", target: "9D" }] },
    deck: { styleId: "demo-deck", source: "builtin" },
  };
  it("正常檔：形狀完整、缺的段落補預設、幀號依該媒體的 proxy.frames 驗", () => {
    const { file, report } = parseProjectFile(doc);
    expect(file.media[0].proxy?.frames).toBe(1797);
    expect(file.tracks.m1[0].keyframes.map((k) => k.frame)).toEqual([10]);
    expect(file.insertDefaults).toEqual(INSERT_DEFAULTS);
    expect(file.exportDefaults.trackData.format).toBe("nuke");
    expect(file.profile).toBe("cards");
    expect(report.dropped.keyframes).toBe(1);
    expect(report.dropped.orphanMedia).toBe(1);
  });
  it("activeMediaId 指不到媒體 → 第一個媒體", () => {
    expect(parseProjectFile({ ...doc, activeMediaId: "zzz" }).file.activeMediaId).toBe("m1");
  });
  it("proxy 中繼資料壞掉 → 當作沒有 proxy，關鍵幀就不驗上限", () => {
    const d2 = { ...doc, media: [{ ...doc.media[0], proxy: { fps: "30" } }] };
    const { file, report } = parseProjectFile(d2);
    expect(file.media[0].proxy).toBeNull();
    expect(file.tracks.m1[0].keyframes).toHaveLength(2);
    expect(report.dropped.proxy).toBe(1);
  });
  it("沒有 media 陣列 / 版本沒升 → 擲錯", () => {
    expect(() => parseProjectFile({ schemaVersion: SCHEMA_VERSION })).toThrow(/media/);
    expect(() => parseProjectFile({ schemaVersion: 0, media: [] })).toThrow(/migrate/);
  });
  it("migrate → parse 鏈：v0 骨架能一路變成乾淨的 v1", () => {
    const { file, report } = parseProjectFile(migrate({ media: [{ id: "a", path: "x.webm" }] }).doc);
    expect(file.schemaVersion).toBe(1);
    expect(file.media[0].proxy).toBeNull();
    expect(file.shots.a).toEqual([]);
    expect(report.total).toBe(0);
  });
  it("永遠不序列化像祕密的東西", () => {
    const json = JSON.stringify(parseProjectFile(doc).file).toLowerCase();
    for (const bad of ["api_key", "apikey", "x-api-key", "secret", "password", "token"]) expect(json).not.toContain(bad);
  });
});

describe("引擎寫的專案檔（審查 25：proxy 沒有 path）", () => {
  // 引擎 ProxyMetaV1.to_json：{fps, frames, width, height, scale, version}，沒有 path
  const engineProxy = { fps: { num: 30, den: 1 }, frames: 1797, width: 1280, height: 720, scale: 1, version: 1 };
  const doc = {
    schemaVersion: SCHEMA_VERSION,
    media: [{ id: "m1", path: "D:\\v\\clip.webm", name: "clip.webm", fingerprint: "ab".repeat(32), probe: null, proxy: engineProxy }],
    activeMediaId: "m1",
    shots: { m1: [{ id: "shot1", startFrame: 0, endFrame: 1797, kind: "close", source: "auto" }, { id: "big", startFrame: 100, endFrame: 99999 }] },
    tracks: { m1: [track({ shotId: "shot1", keyframes: [{ frame: 10, quad: Q, source: "detector" }, { frame: 5000, quad: Q }] })] },
    cardSlots: { m1: [] },
  };
  it("不回報 dropped.proxy；幀數上限照樣用 proxy.frames 驗；proxy 留給 refreshProxy 從快取目錄補", () => {
    const { file, report } = parseProjectFile(doc);
    expect(report.dropped.proxy).toBeUndefined();
    expect(file.media[0].proxy).toBeNull();
    // endFrame 99999 > 1797、關鍵幀 5000 ≥ 1797 → 照樣丟
    expect(file.shots.m1.map((s) => s.id)).toEqual(["shot1"]);
    expect(report.dropped.shots).toBe(1);
    expect(file.tracks.m1[0].keyframes.map((k) => k.frame)).toEqual([10]);
    expect(report.dropped.keyframes).toBe(1);
    expect(report.total).toBe(2);
  });
  it("proxy 真的壞掉（沒有 frames）仍然回報並關掉上限檢查", () => {
    const { file, report } = parseProjectFile({ ...doc, media: [{ ...doc.media[0], proxy: { fps: { num: 30, den: 1 }, width: 1, height: 1 } }] });
    expect(report.dropped.proxy).toBe(1);
    expect(file.shots.m1).toHaveLength(2);
  });
});

describe("track 的 extra / identity / staleReason（審查 6 / 24）", () => {
  const shots = new Set(["s1"]);
  it("引擎攤平在 track 頂層的鍵收進 extra；寫檔時攤回頂層（render 讀 track.identity.rotation）；再讀回來一樣", () => {
    const r = emptyReport();
    const identity = { card: "QD", score: 0.91, margin: 0.2, rotation: 90, top: [{ cardId: "QD", score: 0.91, rotation: 90 }] };
    const [t] = sanitizeTracks([track({ identity, faceDown: true, detections: { frames: [1, 2], landscape: true } })], 1797, shots, r);
    expect(r.total).toBe(0);
    expect(t.extra).toEqual({ identity, faceDown: true, detections: { frames: [1, 2], landscape: true } });
    const doc = buildProjectFile(
      { media: [{ id: "m1", path: "D:\\v.webm", name: "v.webm", fingerprint: "", probe: null, proxy: null }], activeMediaId: "m1", profile: "generic", shots: { m1: [{ id: "s1", startFrame: 0, endFrame: 1797, kind: "close", source: "auto" }] }, tracks: { m1: [t] }, insertDefaults: INSERT_DEFAULTS, exportDefaults: EXPORT_DEFAULTS },
      { name: "t", version: "0" },
    );
    const onDisk = JSON.parse(JSON.stringify(doc)) as { tracks: { m1: Record<string, unknown>[] } };
    expect(onDisk.tracks.m1[0].extra).toBeUndefined();
    expect((onDisk.tracks.m1[0].identity as { rotation: number }).rotation).toBe(90);
    expect(onDisk.tracks.m1[0].faceDown).toBe(true);
    const again = parseProjectFile(onDisk);
    expect(again.report.total).toBe(0);
    expect(again.file.tracks.m1[0].extra).toEqual(t.extra);
  });
  it("extra 不能蓋掉已知欄位；非 JSON 值與 __proto__ 丟並回報；identity 是外掛的鍵（沒有外掛時原樣收進 extra）", () => {
    const r = emptyReport();
    const raw = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    const [t] = sanitizeTracks([track({ ...raw, weird: Number.NaN, fn: () => 1, identity: { card: "9S", rotation: "90", score: 1 }, extra: { note: "ok", id: "hijack" } })], 1797, shots, r);
    expect(t.id).toBe("t1");
    expect(t.extra).toEqual({ note: "ok", identity: { card: "9S", rotation: "90", score: 1 } });
    expect(Object.getPrototypeOf(t.extra)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(r.dropped["track.extra"]).toBe(3);
    expect(r.dropped["track.identity"]).toBeUndefined();
    expect(isJsonValue({ a: [1, "x", null, { b: false }] })).toBe(true);
    expect(isJsonValue({ a: Number.POSITIVE_INFINITY })).toBe(false);
  });
  it("staleReason 只在 stale 時保留；沒有 extra 的 track 不長出 extra 鍵", () => {
    const r = emptyReport();
    const out = sanitizeTracks([track({ stale: true, staleReason: "target" }), track({ id: "t2", stale: false, staleReason: "target" }), track({ id: "t3", stale: true, staleReason: "bogus" })], 1797, shots, r);
    expect(out.map((t) => t.staleReason)).toEqual(["target", undefined, undefined]);
    expect(out.every((t) => !("extra" in t))).toBe(true);
    expect(r.total).toBe(0);
  });
});

describe("exportDefaults.quality", () => {
  it("沒選過（缺、null、非數字、負數）→ null，交給引擎依 codec 決定；數字保留", () => {
    const base = { schemaVersion: SCHEMA_VERSION, media: [] as unknown[] };
    for (const q of [undefined, null, "high", -1]) {
      expect(parseProjectFile({ ...base, exportDefaults: { ...EXPORT_DEFAULTS, quality: q } }).file.exportDefaults.quality).toBeNull();
    }
    expect(parseProjectFile({ ...base, exportDefaults: { ...EXPORT_DEFAULTS, quality: 20 } }).file.exportDefaults.quality).toBe(20);
    expect(EXPORT_DEFAULTS.quality).toBeNull();
  });
});

describe("沒有外掛：外掛擁有的鍵原樣保留", () => {
  const shots = new Set(["s1"]);
  it("track 的 slotId 收進 extra（存檔時攤回頂層）；options / insert 不認得的鍵照留", () => {
    const r = emptyReport();
    const [t] = sanitizeTracks(
      [track({ slotId: "p1", options: { method: "classic", motionModel: "perspective", smoothing: 0.4, templateCard: "8H" }, insert: { macro: "full", flip: { faceDownStart: true }, relight: { keepHighlights: 50, sheenLock: "card" } } })],
      1797,
      shots,
      r,
    );
    expect(r.total).toBe(0);
    expect(t.extra).toEqual({ slotId: "p1" });
    expect((t.options as unknown as Record<string, unknown>).templateCard).toBe("8H");
    expect((t.insert as unknown as Record<string, unknown>).flip).toEqual({ faceDownStart: true });
    expect(t.insert?.relight?.sheenLock).toBe("card");
  });
  it("頂層 cardSlots / deck 不進 file（由 project extras 帶著走）；profile 不認得但像值 → 原樣", () => {
    const { file, report } = parseProjectFile({ schemaVersion: SCHEMA_VERSION, media: [], profile: "cards", cardSlots: {}, deck: { styleId: "x" } });
    expect(file.profile).toBe("cards");
    expect(file.plugin).toEqual({ media: {}, project: {} });
    expect(report.total).toBe(0);
    expect(parseProjectFile({ schemaVersion: SCHEMA_VERSION, media: [], profile: 42 }).file.profile).toBe("generic");
  });
});
