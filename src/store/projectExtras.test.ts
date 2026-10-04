import { beforeEach, describe, expect, it, vi } from "vitest";

const markDirty = vi.fn();
vi.mock("./project", () => ({ useProject: { getState: () => ({ markDirty }) } }));

// 核心只管通用的 extras（不認得的頂層鍵）；牌外掛自己的標記 / session 意圖在外掛的測試：plugins/cards/frontend/store/vdSession.test.ts
const { useProjectExtras } = await import("./projectExtras");

beforeEach(() => {
  useProjectExtras.getState().reset();
  markDirty.mockClear();
});

describe("projectExtras store", () => {
  it("load 不標 dirty；patch 標 dirty、undefined 刪鍵、沒變不標", () => {
    const st = useProjectExtras.getState();
    st.load({ contentNote: "n" });
    expect(markDirty).not.toHaveBeenCalled();
    st.patch({ contentNote: "n" });
    expect(markDirty).not.toHaveBeenCalled();
    st.patch({ contentNote: undefined, other: 1 });
    expect(useProjectExtras.getState().extras).toEqual({ other: 1 });
    expect(markDirty).toHaveBeenCalledTimes(1);
    st.patch({ other: 2 }, { dirty: false });
    expect(markDirty).toHaveBeenCalledTimes(1);
  });
});
