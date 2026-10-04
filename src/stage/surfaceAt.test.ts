import { describe, expect, it } from "vitest";
import { DEFAULT_TRACK_OPTIONS, type TrackV1 } from "../project/format";
import type { Solve } from "../store/solves";
import { IDENTITY_H, rectQuad, translateQuad } from "../video/quad";
import { nearestKeyframe, quadOfSolveFrame, referenceSurface, stateOfSolveFrame, summarizeSolve, surfaceAt } from "./surfaceAt";

const kfQuad = rectQuad(10, 10, 40, 30);

function track(over: Partial<TrackV1> = {}): TrackV1 {
  return {
    id: "t1",
    shotId: "s1",
    label: "P1",
    kind: "planar",
    referenceFrame: null,
    trackingRegion: null,
    keyframes: [{ frame: 100, quad: kfQuad, source: "user" }],
    prompts: [],
    adjust: { points: [], enabled: false },
    options: DEFAULT_TRACK_OPTIONS,
    insert: null,
    regionPolicy: "full",
    stale: false,
    ...over,
  };
}

const solve: Solve = {
  version: 1,
  trackId: "t1",
  shot: [90, 130],
  anchorK: 100,
  template: { w: 63, h: 88 },
  frames: [
    { k: 100, h: IDENTITY_H, conf: 0.95, state: 2 },
    { k: 101, h: [1, 0, 5, 0, 1, 7, 0, 0, 1], conf: 0.8, state: 1 },
    { k: 102, h: IDENTITY_H, conf: 0.5, state: 1 },
    { k: 103, h: IDENTITY_H, conf: 0.9, state: 3 },
    { k: 104, h: IDENTITY_H, conf: 0.2, state: 1 },
  ],
};

describe("stage/surfaceAt", () => {
  it("使用者關鍵幀優先於解算（重跑 track 永不覆寫使用者關鍵幀）", () => {
    const s = surfaceAt(track(), solve, 100);
    expect(s?.state).toBe("user");
    expect(s?.quad).toEqual(kfQuad);
    expect(s?.keyframe?.source).toBe("user");
  });

  it("H_k 套在模板矩形上 = 這一幀的表面；state 依信心分三色", () => {
    const s = surfaceAt(track(), solve, 101);
    expect(s?.state).toBe("solver");
    expect(s?.quad).toEqual(translateQuad(rectQuad(0, 0, 63, 88), 5, 7));
    expect(surfaceAt(track(), solve, 102)?.state).toBe("occluded");
    expect(surfaceAt(track(), solve, 103)?.state).toBe("lost"); // state=3 即使 conf 高
    expect(surfaceAt(track(), solve, 104)?.state).toBe("lost"); // conf < 0.35
  });

  it("沒有解也沒有這幀的關鍵幀 → 借最近的關鍵幀、標 missing", () => {
    const tr = track({ keyframes: [{ frame: 100, quad: kfQuad, source: "user" }, { frame: 200, quad: rectQuad(0, 0, 1, 1), source: "detector" }] });
    const s = surfaceAt(tr, null, 140);
    expect(s?.state).toBe("missing");
    expect(s?.quad).toEqual(kfQuad); // 140 離 100 是 40、離 200 是 60
    expect(nearestKeyframe(tr, 150)?.frame).toBe(100); // 同距離取前面那個
    expect(surfaceAt(track({ keyframes: [] }), null, 5)).toBeNull();
  });

  it("偵測器關鍵幀有解時解算優先、沒解時用它自己（missing）", () => {
    const tr = track({ keyframes: [{ frame: 101, quad: kfQuad, source: "detector" }] });
    expect(surfaceAt(tr, solve, 101)?.state).toBe("solver");
    expect(surfaceAt(tr, null, 101)?.state).toBe("missing");
    expect(surfaceAt(tr, null, 101)?.keyframe?.source).toBe("detector");
  });

  it("退化的 H 回 null → 走 missing 而不是畫出一條線", () => {
    expect(quadOfSolveFrame(solve, { k: 1, h: [0, 0, 0, 0, 0, 0, 0, 0, 1], conf: 1, state: 1 })).toBeNull();
    expect(stateOfSolveFrame({ k: 0, h: IDENTITY_H, conf: 0.7, state: 1 })).toBe("solver");
    expect(stateOfSolveFrame({ k: 0, h: IDENTITY_H, conf: 0.35, state: 1 })).toBe("occluded");
  });

  it("referenceSurface：referenceFrame → anchorK → 第一個關鍵幀", () => {
    expect(referenceSurface(track({ referenceFrame: 101 }), solve)).toEqual(translateQuad(rectQuad(0, 0, 63, 88), 5, 7));
    expect(referenceSurface(track(), solve)).toEqual(kfQuad); // anchorK=100 是 user 關鍵幀
    expect(referenceSurface(track(), null)).toEqual(kfQuad);
    expect(referenceSurface(track({ keyframes: [] }), null)).toBeNull();
  });

  it("summarizeSolve 只算鏡頭範圍內、找出最差的一幀（lost 優先）", () => {
    const sum = summarizeSolve(solve, [100, 104]); // 100..103
    expect(sum).toMatchObject({ total: 4, solved: 3, lost: 1, occluded: 1 });
    expect(sum.worst?.k).toBe(103);
    expect(summarizeSolve(null, [0, 10])).toEqual({ total: 10, solved: 0, lost: 0, occluded: 0, worst: null });
  });
});
