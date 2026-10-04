// 輸出對話框的效果 / 替換摘要：引擎 render.plan 的回報讀得寬鬆（render 端由另一個任務依契約實作，鍵名還沒定案），
// 專案有、引擎沒列的要講出來（多半是引擎版本還不會輸出特效）。
import { describe, expect, it } from "vitest";
import type { TrackV1 } from "../project/format";
import { missingFromPlan, planEdits, projectEdits } from "./exportEdits";

const track = (id: string, over: Partial<TrackV1> = {}): TrackV1 => ({ id, label: `T ${id}`, kind: "planar", keyframes: [] , ...over }) as unknown as TrackV1;

describe("planEdits", () => {
  it("引擎完全沒回報這兩件事 → null（舊版引擎）", () => {
    expect(planEdits({ tracks: [{ id: "a", frames: 10 }] })).toBeNull();
    expect(planEdits(null)).toBeNull();
  });

  it("tracks[].effects / replace：字串、{type}、數量都認", () => {
    const r = planEdits({
      tracks: [
        { id: "a", effects: ["mosaic", { type: "text" }] },
        { id: "b", effects: 2, replace: { kind: "video", path: "x.mp4" } },
        { id: "c", effects: [], replace: null },
      ],
    });
    expect(r).toEqual([
      { trackId: "a", effects: ["mosaic", "text"], count: 2, replace: null },
      { trackId: "b", effects: [], count: 2, replace: "video" },
    ]);
  });

  it("頂層 effects[] / objects[] / replace[] 也認（trackId | track | id）", () => {
    const r = planEdits({ tracks: [], effects: [{ trackId: "a", type: "blur" }], objects: [{ track: "b", effects: [{ type: "glow" }] }], replace: [{ id: "p", kind: "image", path: "x.png" }] });
    expect(r).toEqual([
      { trackId: "a", effects: ["blur"], count: 1, replace: null },
      { trackId: "b", effects: ["glow"], count: 1, replace: null },
      { trackId: "p", effects: [], count: 0, replace: "image" },
    ]);
  });

  it("有回報但沒有東西 → 空陣列（不是 null）", () => {
    expect(planEdits({ tracks: [{ id: "a", effects: [] }] })).toEqual([]);
    expect(planEdits({ tracks: [], effects: [] })).toEqual([]);
  });
});

describe("projectEdits / missingFromPlan", () => {
  const tracks = [
    track("o1", { kind: "object", label: "臉", effects: [{ id: "m", enabled: true, type: "mosaic" }, { id: "x", enabled: false, type: "blur" }] }),
    track("o2", { kind: "object", effects: [{ id: "m", enabled: false, type: "mosaic" }] }),
    track("p1", { label: "螢幕", replace: { kind: "image", path: "D:\\ad.png", fit: "cover", offsetFrames: 0, loop: "loop" } }),
    track("p2", { label: "壞", effects: [{ id: "g", enabled: true, type: "glow", intensity: 99 }] }),
    // 物件 track 上的 replace 是未知鍵：不算替換
    track("o3", { kind: "object", replace: { kind: "image", path: "x.png", fit: "stretch", offsetFrames: 0, loop: "loop" } }),
  ];

  it("只算開著的特效；替換只算平面 track；錯誤數照 validate", () => {
    const p = projectEdits(tracks);
    expect(p.effects).toEqual([
      { trackId: "o1", label: "臉", types: ["mosaic"] },
      { trackId: "p2", label: "壞", types: ["glow"] },
    ]);
    expect(p.replace).toEqual([{ trackId: "p1", label: "螢幕", kind: "image" }]);
    expect(p.errors).toBe(1);
  });

  it("專案有、引擎計畫沒列的 → 列名字", () => {
    const p = projectEdits(tracks);
    expect(missingFromPlan(p, [{ trackId: "o1", effects: ["mosaic"], count: 1, replace: null }])).toEqual(["壞", "螢幕"]);
    expect(missingFromPlan(p, [{ trackId: "o1", effects: [], count: 1, replace: null }, { trackId: "p2", effects: [], count: 1, replace: null }, { trackId: "p1", effects: [], count: 0, replace: "image" }])).toEqual([]);
  });
});
