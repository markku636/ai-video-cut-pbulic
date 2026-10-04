// 手動選取（舞台工具「選取物件」）的 session 與引擎參數：點 / Alt＋點 / 框、換幀重來、退一步、
// 預覽的 latest-wins（rev 對不上的結果丟掉）、seg.select 的參數、修正的傳播範圍。
import { beforeEach, describe, expect, it } from "vitest";
import { boxFromDrag, hasPrompts, nextObjectLabel, parseSelectPreview, propagatedMasks, refineSpan, selectArgs, useSelection } from "./selection";

const st = () => useSelection.getState();
const fakeBitmap = () => ({ close: () => {} }) as unknown as ImageBitmap;
const preview = { mask: "C:\\c\\select\\s1\\mask.png", overlay: "o.png", box: null, area: 10, score: 0.9, backend: { name: "sam2", fallback: true, reason: "x" } };

beforeEach(() => st().end());

describe("selection session", () => {
  it("點 = 加選、Alt = 減選、框只有一個；每次改動 rev +1", () => {
    st().addPoint("m1", 10, { x: 5, y: 6, label: 1 });
    st().addPoint("m1", 10, { x: 7, y: 8, label: 0 });
    st().setBox("m1", 10, [1, 2, 30, 40]);
    st().setBox("m1", 10, [2, 3, 30, 40]);
    const s = st().session!;
    expect(s.points.map((p) => p.label)).toEqual([1, 0]);
    expect(s.box).toEqual([2, 3, 30, 40]);
    expect(s.rev).toBe(4);
    expect(hasPrompts(s)).toBe(true);
  });

  it("換了幀 = 從新的一組開始（修正目標保留）；換了媒體目標也不帶", () => {
    st().start("m1", 10, "obj-1");
    st().addPoint("m1", 10, { x: 1, y: 1, label: 1 });
    st().addPoint("m1", 20, { x: 2, y: 2, label: 1 });
    expect(st().session!.frame).toBe(20);
    expect(st().session!.points).toHaveLength(1);
    expect(st().session!.targetTrackId).toBe("obj-1");
    st().addPoint("m2", 20, { x: 2, y: 2, label: 1 });
    expect(st().session!.targetTrackId).toBeNull();
  });

  it("退一步：先拿掉點、再拿掉框；什麼都不剩就清掉預覽", () => {
    st().setBox("m1", 0, [0, 0, 5, 5]);
    st().addPoint("m1", 0, { x: 1, y: 1, label: 1 });
    st().setPreview(st().session!.rev, preview, fakeBitmap());
    st().undoLast();
    expect(st().session!.points).toEqual([]);
    expect(st().session!.preview).not.toBeNull();
    st().undoLast();
    expect(st().session!.box).toBeNull();
    expect(st().session!.preview).toBeNull();
    expect(st().session!.bitmap).toBeNull();
  });

  it("預覽 latest-wins：回來時 rev 已經變了 → 丟掉（不會「點了 A 看到 B」）", () => {
    st().addPoint("m1", 0, { x: 1, y: 1, label: 1 });
    const old = st().session!.rev;
    st().addPoint("m1", 0, { x: 2, y: 2, label: 1 });
    st().setPreview(old, preview, fakeBitmap());
    expect(st().session!.preview).toBeNull();
    st().setPreview(st().session!.rev, preview, fakeBitmap());
    expect(st().session!.status).toBe("done");
    expect(st().session!.previewRev).toBe(st().session!.rev);
  });
});

describe("seg.select 參數", () => {
  it("單幀預覽：點 x,y[:neg]、框 x,y,w,h、px 座標、一位小數", () => {
    expect(selectArgs({ video: "v.mp4", frame: 12, points: [{ x: 10.04, y: 20.96, label: 1 }, { x: 3, y: 4, label: 0 }], box: [1.25, 2, 30, 40], out: "C:\\o" })).toEqual({
      video: "v.mp4",
      frame: 12,
      point: ["10,21", "3,4:neg"],
      box: ["1.3,2,30,40"],
      coords: "px",
      out: "C:\\o",
    });
  });
  it("傳播與修正：propagate K0:K1、from_masks", () => {
    const a = selectArgs({ video: "v", frame: 50, points: [], box: [0, 0, 5, 5], out: "o", propagate: [0, 120], from: "C:\\t\\masks.aivm", sam: "small" });
    expect(a.propagate).toBe("0:120");
    expect(a.from_masks).toBe("C:\\t\\masks.aivm");
    expect(a.sam).toBe("small");
  });
  it("回傳值：預覽遮罩路徑、分數、後端；傳播出來的遮罩檔", () => {
    expect(parseSelectPreview({ mask: "m.png", overlay: "o.png", box: [1, 2, 3, 4], area: 12, score: 0.5, backend: { name: "sam3", fallback: false } })).toEqual({ mask: "m.png", overlay: "o.png", box: [1, 2, 3, 4], area: 12, score: 0.5, backend: { name: "sam3", fallback: false, reason: "" } });
    expect(propagatedMasks({ propagated: { masks: "C:\\o\\obj1\\masks.aivm" } })).toBe("C:\\o\\obj1\\masks.aivm");
    expect(propagatedMasks({ propagated: null })).toBeNull();
  });
});

describe("修正範圍與拖框", () => {
  it("refineSpan：涵蓋物件原本的範圍與選的範圍，一定包含 K，夾在影片內", () => {
    expect(refineSpan(80, [10, 120], [100, 250], 300)).toEqual([10, 250]);
    expect(refineSpan(280, [10, 120], [0, 100], 300)).toEqual([0, 281]);
    expect(refineSpan(5, undefined, null, 0)).toEqual([5, 6]);
  });
  it("boxFromDrag：任意方向拖都行；太小（< 2 px）不算框", () => {
    expect(boxFromDrag([50, 60], [10, 20])).toEqual([10, 20, 40, 40]);
    expect(boxFromDrag([5, 5], [6, 30])).toBeNull();
  });
  it("新物件的名字往後跳、不撞名", () => {
    expect(nextObjectLabel([], "物件")).toBe("物件 1");
    expect(nextObjectLabel(["人臉", "物件 2"], "物件")).toBe("物件 3");
  });
});
