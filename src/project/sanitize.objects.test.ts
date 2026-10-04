// 物件 track（kind:"object"）、特效（effects）、替換（replace）的專案檔契約：
// 引擎（Python project/schema.py）與前端讀同一份 JSON，鍵名 camelCase、只加可省略的鍵、不升 schemaVersion，
// 不認得的鍵一律原樣來回（引擎 / AI 之後多寫的東西不能被前端存檔洗掉）。
import { describe, expect, it } from "vitest";
import { buildProjectFile, OBJECT_TRACK_KEYS, SCHEMA_VERSION, trackToJson, type TrackV1 } from "./format";
import { emptyReport, parseProjectFile, sanitizeEffects, sanitizeObjectSource, sanitizeRange, sanitizeReplace, sanitizeTracks } from "./sanitize";

const Q = { p: [[0, 0], [100, 0], [100, 80], [0, 80]] };
const proxy = { version: 1, fps: { num: 30, den: 1 }, frames: 300, width: 1280, height: 720, scale: 1, path: "C:\\c\\proxy.mp4" };
const shots = new Set(["s1", "s2"]);

/** 磁碟上的物件 track（契約的鍵順序）。 */
function objectTrack(extra: Record<string, unknown> = {}) {
  return {
    id: "obj-1",
    shotId: "s1",
    label: "人臉",
    kind: "object",
    referenceFrame: 42,
    keyframes: [],
    color: "#FF5A5F",
    source: { type: "text", text: "人臉, 車牌", phrase: "face", backend: "sam2", score: 0.61 },
    range: [10, 120],
    ...extra,
  };
}

function planarTrack(extra: Record<string, unknown> = {}) {
  return { id: "t1", shotId: "s1", label: "螢幕", kind: "planar", referenceFrame: 10, trackingRegion: null, keyframes: [{ frame: 10, quad: Q, source: "user" }], prompts: [], adjust: { points: [], enabled: false }, options: { method: "classic", motionModel: "perspective", smoothing: 0.4 }, insert: null, regionPolicy: "full", stale: false, ...extra };
}

function doc(tracks: unknown[]) {
  return {
    schemaVersion: 1,
    app: { name: "AI Video Cut", version: "0.0.7" },
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    media: [{ id: "m1", path: "D:\\v\\clip.mp4", name: "clip.mp4", fingerprint: "ab".repeat(32), probe: null, proxy }],
    activeMediaId: "m1",
    profile: "generic",
    shots: {
      m1: [
        { id: "s1", startFrame: 0, endFrame: 200, kind: "wide", source: "auto" },
        { id: "s2", startFrame: 200, endFrame: 300, kind: "close", source: "auto" },
      ],
    },
    tracks: { m1: tracks },
  };
}

/** parse → build（跟 App 存檔同一條路）；回寫出去的 tracks。 */
function roundTrip(d: ReturnType<typeof doc>) {
  const { file, report } = parseProjectFile(d);
  const built = buildProjectFile(file, file.app, { createdAt: d.createdAt }, new Date(d.updatedAt));
  return { file, report, built };
}

describe("物件 track：讀進來", () => {
  it("契約的每個欄位都收；記憶體裡補平面欄位的預設值（只認得平面的程式碼不會讀到 undefined）", () => {
    const r = emptyReport();
    const [t] = sanitizeTracks([objectTrack()], 300, shots, r);
    expect(r.total).toBe(0);
    expect(t.kind).toBe("object");
    expect(t.range).toEqual([10, 120]);
    expect(t.color).toBe("#FF5A5F");
    expect(t.source).toEqual({ type: "text", text: "人臉, 車牌", phrase: "face", backend: "sam2", score: 0.61 });
    expect(t.referenceFrame).toBe(42);
    expect(t.keyframes).toEqual([]);
    expect(t.prompts).toEqual([]);
    expect(t.options.motionModel).toBe("perspective");
    expect(t.stale).toBe(false);
    expect("extra" in t).toBe(false);
  });

  it("range 壞掉整條丟（不知道遮罩在哪幾幀）；k1 超出 proxy 夾住；k0 ≥ frames 丟", () => {
    const r = emptyReport();
    const out = sanitizeTracks(
      [objectTrack({ id: "a", range: [50, 40] }), objectTrack({ id: "b", range: "0:10" }), objectTrack({ id: "c", range: [10, 900] }), objectTrack({ id: "d", range: [300, 310] }), objectTrack({ id: "e", range: [1.5, 9] })],
      300,
      shots,
      r,
    );
    expect(out.map((t) => [t.id, t.range])).toEqual([["c", [10, 300]]]);
    expect(r.dropped.tracks).toBe(4);
    expect(sanitizeRange([5, 9000], null)).toEqual([5, 9000]);
  });

  it("顏色不是 #RRGGBB → 預設色並回報；色碼大小寫原樣（存回去逐位元相同）", () => {
    const r = emptyReport();
    const [a, b] = sanitizeTracks([objectTrack({ color: "red" }), objectTrack({ id: "obj-2", color: "#3ba7ff" })], 300, shots, r);
    expect(a.color).toMatch(/^#[0-9A-F]{6}$/);
    expect(b.color).toBe("#3ba7ff");
    expect(r.dropped["track.color"]).toBe(1);
  });

  it("source：type 不認得 → select 並回報；選填欄位型別不對不收；不認得的鍵原樣保留", () => {
    const r = emptyReport();
    expect(sanitizeObjectSource({ type: "magic" }, r)).toEqual({ type: "select" });
    expect(sanitizeObjectSource({ type: "ai", score: "high", phrase: 3, model: "claude", prompt: { x: 1 } }, r)).toEqual({ type: "ai", model: "claude", prompt: { x: 1 } });
    expect(r.dropped["track.source"]).toBe(1);
  });

  it("shotId 指不到鏡頭、重複 id → 整條丟（跟平面 track 同一條規則）", () => {
    const r = emptyReport();
    const out = sanitizeTracks([objectTrack(), objectTrack(), objectTrack({ id: "x", shotId: "nope" }), planarTrack({ id: "obj-1" })], 300, shots, r);
    expect(out.map((t) => t.id)).toEqual(["obj-1"]);
    expect(r.dropped.tracks).toBe(3);
  });
});

describe("物件 track：寫出去", () => {
  it("只寫契約的鍵（記憶體補的平面預設值不寫），順序 = 契約順序", () => {
    const [t] = sanitizeTracks([objectTrack({ effects: [{ id: "fx1", enabled: true, type: "mosaic", shape: "ellipse" }] })], 300, shots, emptyReport());
    const json = trackToJson(t) as unknown as Record<string, unknown>;
    expect(Object.keys(json)).toEqual(OBJECT_TRACK_KEYS.filter((k) => k !== "extra"));
    for (const k of ["trackingRegion", "prompts", "adjust", "options", "insert", "regionPolicy", "stale"]) expect(k in json).toBe(false);
  });

  it("沒有特效的物件 track 不長出 effects 鍵", () => {
    const [t] = sanitizeTracks([objectTrack()], 300, shots, emptyReport());
    expect("effects" in (trackToJson(t) as unknown as Record<string, unknown>)).toBe(false);
  });

  it("整份檔 parse → build：tracks 逐位元相同（含不認得的鍵：track 頂層、source 裡、特效參數裡）", () => {
    const d = doc([
      objectTrack({
        source: { type: "text", text: "face", phrase: "face", backend: "sam3", score: 0.9, frames: { k0: 0, k1: 200 } },
        effects: [
          { id: "fx1", enabled: true, type: "mosaic", shape: "ellipse", expand: 6, footprint: { feather: 2 } },
          { id: "fx2", enabled: false, type: "futureFx", wobble: [1, 2, 3] },
        ],
        anchors: "anchors.v1.json",
        visibleRanges: [[10, 60], [70, 119]],
      }),
      planarTrack(),
    ]);
    const { report, built } = roundTrip(d);
    expect(report.total).toBe(0);
    expect(JSON.stringify(built.tracks)).toBe(JSON.stringify(d.tracks));
  });

  it("物件 track 上的平面鍵（舊版 App 存過的）不認得 → 原樣保留", () => {
    const d = doc([objectTrack({ options: { method: "dense" }, stale: true, regionPolicy: "hold" })]);
    const { file, built } = roundTrip(d);
    expect(file.tracks.m1[0].extra).toEqual({ options: { method: "dense" }, stale: true, regionPolicy: "hold" });
    const out = (built.tracks as unknown as Record<string, Record<string, unknown>[]>).m1[0];
    expect(out.options).toEqual({ method: "dense" });
    expect(out.stale).toBe(true);
    expect(out.regionPolicy).toBe("hold");
  });

  it("parse 冪等：寫出去再讀回來，記憶體形狀一樣", () => {
    const d = doc([objectTrack({ effects: [{ id: "a", enabled: true, type: "blur" }] }), planarTrack({ effects: [{ id: "b", enabled: true, type: "outline", color: "#FFD400" }] })]);
    const first = roundTrip(d);
    const second = parseProjectFile(JSON.parse(JSON.stringify(first.built)) as unknown);
    expect(second.file.tracks).toEqual(first.file.tracks);
    expect(second.report.total).toBe(0);
  });

  it("沒有物件 track 的專案：寫出去的版本號照舊是 1（不升 schemaVersion）", () => {
    const { built } = roundTrip(doc([objectTrack()]));
    expect(built.schemaVersion).toBe(1);
    expect(SCHEMA_VERSION).toBe(2);
  });
});

describe("特效（effects）", () => {
  it("id / type 必填、id 不重複、enabled 缺 = true、參數原樣（未知鍵也留，由引擎驗）", () => {
    const r = emptyReport();
    const out = sanitizeEffects(
      [
        { id: "a", type: "mosaic", blocks: 12 },
        { id: "a", type: "blur" },
        { type: "blur" },
        { id: "b", type: "" },
        { id: "c", enabled: "yes", type: "glow" },
        { id: "d", enabled: false, type: "text", text: "車牌", offset: [0, -0.04] },
        { id: "e", type: "color", tint: Number.NaN },
        "mosaic",
      ],
      r,
    );
    expect(out).toEqual([
      { id: "a", enabled: true, type: "mosaic", blocks: 12 },
      { id: "d", enabled: false, type: "text", text: "車牌", offset: [0, -0.04] },
    ]);
    expect(r.dropped.effects).toBe(6);
  });

  it("省略 / null → 不寫；不是陣列 → 丟並回報", () => {
    const r = emptyReport();
    expect(sanitizeEffects(undefined, r)).toBeUndefined();
    expect(sanitizeEffects(null, r)).toBeUndefined();
    expect(sanitizeEffects({ type: "mosaic" }, r)).toBeUndefined();
    expect(r.dropped.effects).toBe(1);
    expect(sanitizeEffects([], r)).toEqual([]);
  });

  it("平面 track 也可以掛特效；沒有特效的平面 track 存出來的鍵跟以前一樣", () => {
    const r = emptyReport();
    const [a, b] = sanitizeTracks([planarTrack({ effects: [{ id: "o", enabled: true, type: "outline" }] }), planarTrack({ id: "t2" })], 300, shots, r);
    expect(a.effects).toEqual([{ id: "o", enabled: true, type: "outline" }]);
    expect("effects" in b).toBe(false);
    expect(Object.keys(trackToJson(b))).toEqual(Object.keys(planarTrack()));
  });
});

describe("替換（replace，平面 track）", () => {
  it("kind / path 必填，fit / offsetFrames / loop 缺或壞 → 預設值；不認得的鍵原樣", () => {
    const r = emptyReport();
    expect(sanitizeReplace({ kind: "video", path: "D:\\a.mp4" }, r)).toEqual({ kind: "video", path: "D:\\a.mp4", fit: "stretch", offsetFrames: 0, loop: "loop" });
    expect(sanitizeReplace({ kind: "image", path: "x.png", fit: "cover", offsetFrames: -3, loop: "hold", gamma: 2.2 }, r)).toEqual({ kind: "image", path: "x.png", fit: "cover", offsetFrames: -3, loop: "hold", gamma: 2.2 });
    expect(sanitizeReplace({ kind: "image", path: "x.png", fit: "zoom", offsetFrames: 1.5, loop: 3 }, r)).toEqual({ kind: "image", path: "x.png", fit: "stretch", offsetFrames: 0, loop: "loop" });
    expect(r.total).toBe(0);
    expect(sanitizeReplace({ kind: "gif", path: "x" }, r)).toBeUndefined();
    expect(sanitizeReplace({ kind: "image", path: "" }, r)).toBeUndefined();
    expect(r.dropped.replace).toBe(2);
  });

  it("平面 track 的 replace 來回逐位元相同；物件 track 上的 replace 不是契約的鍵 → 當未知鍵原樣保留", () => {
    const rep = { kind: "video", path: "D:\\ad.mp4", fit: "contain", offsetFrames: 12, loop: "stop" };
    const d = doc([planarTrack({ replace: rep }), objectTrack({ replace: { kind: "image", path: "z.png" } })]);
    const { file, built, report } = roundTrip(d);
    expect(report.total).toBe(0);
    expect(file.tracks.m1[0].replace).toEqual(rep);
    expect(file.tracks.m1[1].replace).toBeUndefined();
    expect(file.tracks.m1[1].extra).toEqual({ replace: { kind: "image", path: "z.png" } });
    expect(JSON.stringify(built.tracks)).toBe(JSON.stringify(d.tracks));
  });
});

describe("型別：TrackV1 的物件欄位都是可省略的", () => {
  it("平面 track 不需要 color / source / range", () => {
    const t: Pick<TrackV1, "kind" | "color" | "range"> = { kind: "planar" };
    expect(t.color).toBeUndefined();
  });
});
