// 效果 / 替換的舞台預覽：要預覽什麼（planFxPreview）、節流與 latest-wins、取消與作廢。
// 預覽會打主 lane 的引擎：scrub 時每一幀都送會把真正的工作塞住，所以這幾條紀律要有測試盯著。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackV1 } from "../project/format";
import { rectQuad } from "../video/quad";
import {
  __resetFxPreviews,
  bumpMaskRev,
  cancelFxPreview,
  clearFxPreviews,
  fxPreviewKey,
  getFxPreview,
  maskRev,
  planFxPreview,
  requestFxPreview,
  setFxPreviewProvider,
  type FxPreviewEntry,
  type FxPreviewParts,
} from "./preview";

const obj = (over: Partial<TrackV1> = {}): TrackV1 =>
  ({
    id: "o1",
    shotId: "s1",
    label: "臉",
    kind: "object",
    referenceFrame: 5,
    trackingRegion: null,
    keyframes: [],
    prompts: [],
    adjust: { points: [], enabled: false },
    options: {},
    insert: null,
    regionPolicy: "full",
    stale: false,
    range: [0, 100],
    effects: [{ id: "m", enabled: true, type: "mosaic" }],
    ...over,
  }) as unknown as TrackV1;

const planar = (over: Partial<TrackV1> = {}): TrackV1 => ({ ...obj(), id: "p1", kind: "planar", range: undefined, effects: undefined, ...over }) as TrackV1;
const Q = rectQuad(10, 10, 100, 50);

describe("planFxPreview", () => {
  it("物件：開著的特效送引擎（拿掉 id / enabled）", () => {
    const p = planFxPreview(obj(), 10, "m1", { quad: null, rev: 0 });
    expect(p && "parts" in p && p.parts).toMatchObject({ kind: "effects", trackKind: "object", frame: 10, payload: JSON.stringify([{ type: "mosaic" }]) });
  });

  it("沒有特效 / 全關掉 → 不預覽（null，不打擾）；範圍外的幀也不送", () => {
    expect(planFxPreview(obj({ effects: [] }), 10, "m1", { quad: null, rev: 0 })).toBeNull();
    expect(planFxPreview(obj({ effects: [{ id: "m", enabled: false, type: "mosaic" }] }), 10, "m1", { quad: null, rev: 0 })).toBeNull();
    expect(planFxPreview(obj(), 100, "m1", { quad: null, rev: 0 })).toBeNull();
  });

  it("特效全都有錯 → 講原因、不送一份引擎一定拒收的東西", () => {
    const p = planFxPreview(obj({ effects: [{ id: "m", enabled: true, type: "mosaic", blocks: 9999 }] }), 10, "m1", { quad: null, rev: 0 });
    expect(p && "skip" in p).toBe(true);
  });

  it("平面：有替換就預覽替換（要有這一幀的四角）；沒有替換才看特效", () => {
    const rep = { kind: "image" as const, path: "D:\\ad.png", fit: "stretch" as const, offsetFrames: 0, loop: "loop" as const };
    const withRep = planar({ replace: rep, effects: [{ id: "g", enabled: true, type: "glow" }] });
    const p = planFxPreview(withRep, 3, "m1", { quad: Q, rev: 0 });
    expect(p && "parts" in p && p.parts).toMatchObject({ kind: "replace", quad: Q, payload: JSON.stringify(rep) });
    expect(planFxPreview(withRep, 3, "m1", { quad: null, rev: 0 })).toMatchObject({ skip: { key: "這一幀沒有表面：沒辦法預覽替換" } });
    const fxOnly = planFxPreview(planar({ effects: [{ id: "g", enabled: true, type: "glow" }] }), 3, "m1", { quad: Q, rev: 0 });
    expect(fxOnly && "parts" in fxOnly && fxOnly.parts.kind).toBe("effects");
    expect(planFxPreview(planar(), 3, "m1", { quad: Q, rev: 0 })).toBeNull();
  });

  it("物件 track 上的 replace 是未知鍵：不當替換預覽", () => {
    const t = obj({ replace: { kind: "image", path: "x.png", fit: "stretch", offsetFrames: 0, loop: "loop" } });
    const p = planFxPreview(t, 10, "m1", { quad: Q, rev: 0 });
    expect(p && "parts" in p && p.parts.kind).toBe("effects");
  });

  it("鍵：參數、幀、四角、遮罩版本任何一個變了就換", () => {
    const base = (planFxPreview(obj(), 10, "m1", { quad: null, rev: 0 }) as { parts: FxPreviewParts }).parts;
    const k = fxPreviewKey(base);
    expect(fxPreviewKey({ ...base })).toBe(k);
    expect(fxPreviewKey({ ...base, frame: 11 })).not.toBe(k);
    expect(fxPreviewKey({ ...base, rev: 1 })).not.toBe(k);
    expect(fxPreviewKey({ ...base, payload: "[]" })).not.toBe(k);
    expect(fxPreviewKey({ ...base, quad: Q })).not.toBe(k);
  });
});

describe("requestFxPreview：節流、latest-wins、取消", () => {
  const parts = (frame: number, trackId = "o1"): FxPreviewParts => ({ mediaId: "m1", trackId, trackKind: "object", frame, kind: "effects", payload: "[]", quad: null, rev: 0 });
  let calls: FxPreviewParts[];
  let resolvers: ((e: FxPreviewEntry | null) => void)[];

  beforeEach(() => {
    vi.useFakeTimers();
    __resetFxPreviews();
    calls = [];
    resolvers = [];
    setFxPreviewProvider((p) => {
      calls.push(p);
      return new Promise((r) => resolvers.push(r));
    });
  });
  afterEach(() => {
    __resetFxPreviews();
    vi.useRealTimers();
  });

  const entry = (note: string): FxPreviewEntry => ({ img: null, note: { key: note } });

  it("debounce 內只送最後一個（scrub 時中間的幀全丟）", async () => {
    for (let k = 0; k < 10; k++) requestFxPreview(parts(k));
    await vi.advanceTimersByTimeAsync(200);
    expect(calls.map((c) => c.frame)).toEqual([9]);
    resolvers[0](entry("ok"));
    await vi.advanceTimersByTimeAsync(0);
    expect(getFxPreview(fxPreviewKey(parts(9)))?.note?.key).toBe("ok");
  });

  it("同時只有一個在飛；飛回來時接著送最新的那個（中間的都丟）", async () => {
    requestFxPreview(parts(1));
    await vi.advanceTimersByTimeAsync(200);
    requestFxPreview(parts(2));
    await vi.advanceTimersByTimeAsync(200);
    requestFxPreview(parts(3));
    await vi.advanceTimersByTimeAsync(200);
    expect(calls.map((c) => c.frame)).toEqual([1]);
    resolvers[0](entry("1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((c) => c.frame)).toEqual([1, 3]);
  });

  it("已經有圖 / 正在飛的同一個鍵不重送", async () => {
    requestFxPreview(parts(1));
    await vi.advanceTimersByTimeAsync(200);
    requestFxPreview(parts(1));
    await vi.advanceTimersByTimeAsync(200);
    resolvers[0](entry("x"));
    await vi.advanceTimersByTimeAsync(0);
    requestFxPreview(parts(1));
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(1);
  });

  it("cancel 丟掉還沒送出的；clear 之後才回來的舊結果不進快取", async () => {
    requestFxPreview(parts(1));
    cancelFxPreview();
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(0);
    requestFxPreview(parts(2));
    await vi.advanceTimersByTimeAsync(200);
    clearFxPreviews();
    resolvers[0](entry("stale"));
    await vi.advanceTimersByTimeAsync(0);
    expect(getFxPreview(fxPreviewKey(parts(2)))).toBeNull();
  });

  it("provider 回 null（引擎在忙）不進快取：下一次請求會再送", async () => {
    requestFxPreview(parts(1));
    await vi.advanceTimersByTimeAsync(200);
    resolvers[0](null);
    await vi.advanceTimersByTimeAsync(0);
    requestFxPreview(parts(1));
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(2);
  });

  it("遮罩換了（bumpMaskRev）：版本 +1、那條 track 的快取清掉，別的 track 留著", async () => {
    requestFxPreview(parts(1, "o1"));
    await vi.advanceTimersByTimeAsync(200);
    resolvers[0](entry("a"));
    await vi.advanceTimersByTimeAsync(0);
    requestFxPreview(parts(1, "o2"));
    await vi.advanceTimersByTimeAsync(200);
    resolvers[1](entry("b"));
    await vi.advanceTimersByTimeAsync(0);
    expect(maskRev("o1")).toBe(0);
    bumpMaskRev("o1");
    expect(maskRev("o1")).toBe(1);
    expect(getFxPreview(fxPreviewKey(parts(1, "o1")))).toBeNull();
    expect(getFxPreview(fxPreviewKey(parts(1, "o2")))?.note?.key).toBe("b");
  });

  it("沒有 provider（測試、引擎沒裝）就什麼都不做", async () => {
    setFxPreviewProvider(null);
    requestFxPreview(parts(1));
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(0);
  });
});
