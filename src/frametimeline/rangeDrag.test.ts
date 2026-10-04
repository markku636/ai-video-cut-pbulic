import { describe, expect, it } from "vitest";
import { beginRangeDrag, cancelRangeDrag, collectSnapTargets, nearestSnap, shiftClickRange, updateRangeDrag, type DragContext } from "./rangeDrag";

const none = { range: null, pendingIn: null, pendingOut: null };
/** 1000 幀、4 px/幀、不吸附。 */
const free: DragContext = { frames: 1000, pxPerFrame: 4, targets: [] };

describe("rangeDrag：吸附目標", () => {
  it("播放線 / 鏡頭邊界 / 關鍵幀 / 頭尾，去重保留先出現的種類，依幀排序", () => {
    const t = collectSnapTargets({ playhead: 150, shots: [{ startFrame: 0, endFrame: 150 }, { startFrame: 150, endFrame: 400 }], keyframes: [200, 1200], frames: 400 });
    expect(t).toEqual([
      { frame: 0, kind: "shot" },
      { frame: 150, kind: "playhead" },
      { frame: 200, kind: "keyframe" },
      { frame: 400, kind: "shot" },
    ]);
  });

  it("6 px 內才吸（與縮放有關：同樣 3 幀，放大時吸不到、縮小時吸得到）", () => {
    const targets = collectSnapTargets({ playhead: 100, frames: 1000 });
    expect(nearestSnap(103, { frames: 1000, pxPerFrame: 4, targets })).toBeNull(); // 12 px
    expect(nearestSnap(103, { frames: 1000, pxPerFrame: 2, targets })).toEqual({ frame: 100, kind: "playhead" }); // 6 px
    expect(nearestSnap(101.4, { frames: 1000, pxPerFrame: 4, targets })).toEqual({ frame: 100, kind: "playhead" });
    // 兩個都在容忍內：取近的
    const two = collectSnapTargets({ playhead: 100, keyframes: [104], frames: 1000 });
    expect(nearestSnap(102.6, { frames: 1000, pxPerFrame: 4, targets: two })?.frame).toBe(104);
  });
});

describe("rangeDrag：新建", () => {
  it("往右拖 / 往左拖都得到正向範圍；四捨五入到幀邊界", () => {
    const d = beginRangeDrag("create", 10.2, none);
    expect(updateRangeDrag(d, 29.6, free).range).toEqual({ in: 10, out: 30 });
    expect(updateRangeDrag(d, 3.4, free).range).toEqual({ in: 3, out: 10 });
  });

  it("拖回起點：至少 1 幀，往拖的方向長", () => {
    const d = beginRangeDrag("create", 10, none);
    expect(updateRangeDrag(d, 10.1, free).range).toEqual({ in: 10, out: 11 });
    expect(updateRangeDrag(d, 9.9, free).range).toEqual({ in: 9, out: 10 });
  });

  it("夾在 [0, frames]", () => {
    const d = beginRangeDrag("create", 990, none);
    expect(updateRangeDrag(d, 5000, free).range).toEqual({ in: 990, out: 1000 });
    expect(updateRangeDrag(beginRangeDrag("create", 5, none), -300, free).range).toEqual({ in: 0, out: 5 });
    // 在最尾端點下去再往右：還是一個合法的 1 幀範圍
    expect(updateRangeDrag(beginRangeDrag("create", 1000, none), 1001, free).range).toEqual({ in: 999, out: 1000 });
  });

  it("起點與終點都吸附，吸附資訊回報正在動的那端", () => {
    const ctx: DragContext = { frames: 1000, pxPerFrame: 4, targets: collectSnapTargets({ playhead: 100, shots: [{ startFrame: 100, endFrame: 250 }], frames: 1000 }) };
    const d = beginRangeDrag("create", 101, none);
    const r = updateRangeDrag(d, 249, ctx);
    expect(r.range).toEqual({ in: 100, out: 250 });
    expect(r.snap).toEqual({ frame: 250, kind: "shot" });
    // Alt（targets 空）：不吸
    expect(updateRangeDrag(d, 249, free)).toEqual({ range: { in: 101, out: 249 }, snap: null });
  });

  it("沒有範圍卻開始調整端點 / 平移 → 退回新建", () => {
    expect(beginRangeDrag("move", 5, none).mode).toBe("create");
    expect(beginRangeDrag("in", 5, none).mode).toBe("create");
  });
});

describe("rangeDrag：調整端點", () => {
  const st = { range: { in: 100, out: 200 }, pendingIn: null, pendingOut: null };

  it("拖 in / 拖 out 只動那一端", () => {
    expect(updateRangeDrag(beginRangeDrag("in", 100, st), 120.4, free).range).toEqual({ in: 120, out: 200 });
    expect(updateRangeDrag(beginRangeDrag("out", 200, st), 260, free).range).toEqual({ in: 100, out: 260 });
  });

  it("越過另一端 → 兩端互換；剛好碰到 → 保留 1 幀", () => {
    expect(updateRangeDrag(beginRangeDrag("in", 100, st), 230, free).range).toEqual({ in: 200, out: 230 });
    expect(updateRangeDrag(beginRangeDrag("out", 200, st), 40, free).range).toEqual({ in: 40, out: 100 });
    expect(updateRangeDrag(beginRangeDrag("in", 100, st), 200, free).range).toEqual({ in: 200, out: 201 });
    expect(updateRangeDrag(beginRangeDrag("out", 200, st), 100, free).range).toEqual({ in: 100, out: 101 });
  });

  it("每次都從 origin 重算：拖過頭再拖回來會回到原位", () => {
    const d = beginRangeDrag("out", 200, st);
    updateRangeDrag(d, 20, free);
    expect(updateRangeDrag(d, 200, free).range).toEqual({ in: 100, out: 200 });
  });

  it("端點吸附到關鍵幀", () => {
    const ctx: DragContext = { frames: 1000, pxPerFrame: 4, targets: collectSnapTargets({ keyframes: [150], frames: 1000 }) };
    const r = updateRangeDrag(beginRangeDrag("in", 100, st), 151.2, ctx);
    expect(r).toEqual({ range: { in: 150, out: 200 }, snap: { frame: 150, kind: "keyframe" } });
  });
});

describe("rangeDrag：平移", () => {
  const st = { range: { in: 100, out: 200 }, pendingIn: null, pendingOut: null };

  it("長度不變、夾在 [0, frames]", () => {
    const d = beginRangeDrag("move", 150, st);
    expect(updateRangeDrag(d, 175.3, free).range).toEqual({ in: 125, out: 225 });
    expect(updateRangeDrag(d, -500, free).range).toEqual({ in: 0, out: 100 });
    expect(updateRangeDrag(d, 5000, free).range).toEqual({ in: 900, out: 1000 });
  });

  it("兩端各自找吸附、取近的那端；被邊界夾住時不回報吸附", () => {
    const targets = collectSnapTargets({ playhead: 300, shots: [{ startFrame: 0, endFrame: 128 }], frames: 1000 });
    const ctx: DragContext = { frames: 1000, pxPerFrame: 4, targets };
    const d = beginRangeDrag("move", 150, st);
    // in 在 129（離 128 差 1 幀 = 4 px）、out 在 229 → in 吸到切點 128
    expect(updateRangeDrag(d, 179, ctx)).toEqual({ range: { in: 128, out: 228 }, snap: { frame: 128, kind: "shot" } });
    // out 在 299.5（離播放線 0.5 幀）、in 在 199.5 → out 吸到播放線
    expect(updateRangeDrag(d, 249.5, ctx)).toEqual({ range: { in: 200, out: 300 }, snap: { frame: 300, kind: "playhead" } });
    // 吸到頭 0 的 in：本來就在邊界內，保留吸附
    expect(updateRangeDrag(d, 51, ctx).snap).toEqual({ frame: 0, kind: "shot" });
  });
});

describe("rangeDrag：Esc 還原與 Shift+點", () => {
  it("cancel 回到拖曳前，包含單邊暫存", () => {
    const d = beginRangeDrag("create", 10, { range: null, pendingIn: 42, pendingOut: null });
    expect(cancelRangeDrag(d)).toEqual({ range: null, pendingIn: 42, pendingOut: null });
    const d2 = beginRangeDrag("move", 10, { range: { in: 5, out: 50 }, pendingIn: null, pendingOut: null });
    expect(cancelRangeDrag(d2).range).toEqual({ in: 5, out: 50 });
  });

  it("有範圍：移動較近的一端（等距移 out）", () => {
    const st = { range: { in: 100, out: 200 }, pendingIn: null, pendingOut: null };
    expect(shiftClickRange(st, 80, 1000)).toEqual({ kind: "range", range: { in: 80, out: 200 } });
    expect(shiftClickRange(st, 260, 1000)).toEqual({ kind: "range", range: { in: 100, out: 260 } });
    expect(shiftClickRange(st, 130, 1000)).toEqual({ kind: "range", range: { in: 130, out: 200 } });
    expect(shiftClickRange(st, 150, 1000)).toEqual({ kind: "range", range: { in: 100, out: 150 } });
  });

  it("只有單邊暫存：跟它組成範圍；什麼都沒有：當入點暫存", () => {
    expect(shiftClickRange({ range: null, pendingIn: 40, pendingOut: null }, 90, 1000)).toEqual({ kind: "range", range: { in: 40, out: 90 } });
    expect(shiftClickRange({ range: null, pendingIn: null, pendingOut: 90 }, 40, 1000)).toEqual({ kind: "range", range: { in: 40, out: 90 } });
    expect(shiftClickRange(none, 77, 1000)).toEqual({ kind: "pendingIn", frame: 77 });
    expect(shiftClickRange({ range: null, pendingIn: 77, pendingOut: null }, 77, 1000)).toEqual({ kind: "pendingIn", frame: 77 });
  });
});
