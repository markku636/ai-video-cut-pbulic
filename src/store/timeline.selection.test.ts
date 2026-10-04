// M2.12 片段選取的純函式（docs/editor-m2-design.md §9.5：點＝只選它、Ctrl+點＝加入／移出、Shift+點＝同列延伸）。
import { describe, expect, it } from "vitest";
import { clickClipSelection } from "./timeline";

describe("clickClipSelection", () => {
  const row = ["clip-1", "gap-1", "clip-2", "clip-3"];

  it("一般點：只選它", () => {
    expect(clickClipSelection(["clip-1", "clip-2"], "clip-3")).toEqual(["clip-3"]);
  });

  it("Ctrl+點：加入 / 移出，其他保留", () => {
    expect(clickClipSelection(["clip-1"], "clip-2", { toggle: true })).toEqual(["clip-1", "clip-2"]);
    expect(clickClipSelection(["clip-1", "clip-2"], "clip-1", { toggle: true })).toEqual(["clip-2"]);
  });

  it("Shift+點：從同一列最後選的那個延伸到這裡（往前往後都行），別列的選取保留", () => {
    expect(clickClipSelection(["clip-1"], "clip-2", { extend: true }, row)).toEqual(["clip-1", "gap-1", "clip-2"]);
    expect(clickClipSelection(["a-1", "clip-3"], "gap-1", { extend: true }, row)).toEqual(["a-1", "gap-1", "clip-2", "clip-3"]);
  });

  it("Shift+點但同列沒有錨點（或沒給列順序）：退回一般點", () => {
    expect(clickClipSelection(["a-1"], "clip-2", { extend: true }, row)).toEqual(["clip-2"]);
    expect(clickClipSelection(["clip-1"], "clip-2", { extend: true })).toEqual(["clip-2"]);
  });
});
