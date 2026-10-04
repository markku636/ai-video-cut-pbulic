import { afterEach, describe, expect, it, vi } from "vitest";
import { useMcpApprovals } from "./mcpApprovals";

afterEach(() => {
  vi.useRealTimers();
  for (const p of useMcpApprovals.getState().pending) useMcpApprovals.getState().answer(p.id, false);
});

describe("useMcpApprovals", () => {
  it("排隊的請求在人按了之後各自回答，卡片收掉", async () => {
    const st = useMcpApprovals.getState();
    const a = st.request({ title: "剪掉選取的範圍", detail: "" });
    const b = st.request({ title: "輸出", detail: "out=x" });
    const [pa, pb] = useMcpApprovals.getState().pending;
    expect(pb.detail).toBe("out=x");
    st.answer(pb.id, true);
    st.answer(pa.id, false);
    await expect(a).resolves.toBe(false);
    await expect(b).resolves.toBe(true);
    expect(useMcpApprovals.getState().pending).toEqual([]);
  });

  it("沒人按：時間到自動拒絕", async () => {
    vi.useFakeTimers();
    const r = useMcpApprovals.getState().request({ title: "x", detail: "" }, 1000);
    expect(useMcpApprovals.getState().pending).toHaveLength(1);
    vi.advanceTimersByTime(1001);
    await expect(r).resolves.toBe(false);
    expect(useMcpApprovals.getState().pending).toHaveLength(0);
  });

  it("回答兩次、或回答不存在的 id 都無害", () => {
    const st = useMcpApprovals.getState();
    void st.request({ title: "x", detail: "" });
    const id = useMcpApprovals.getState().pending[0].id;
    st.answer(id, true);
    st.answer(id, false);
    st.answer("nope", true);
    expect(useMcpApprovals.getState().pending).toEqual([]);
  });
});
