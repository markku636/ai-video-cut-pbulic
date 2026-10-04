// 字幕面板行內改字的延遲 commit（驗收 Low：自動捲動把正在打字的列捲出虛擬清單，卸載時最後幾個字被丟掉）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPendingCommit } from "./pendingCommit";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createPendingCommit", () => {
  it("連續打字只 commit 最後一次；停 300 ms 才送", () => {
    const commit = vi.fn();
    const p = createPendingCommit(commit, 300);
    p.schedule("百");
    vi.advanceTimersByTime(200);
    p.schedule("百家");
    vi.advanceTimersByTime(299);
    expect(commit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(commit.mock.calls).toEqual([["百家"]]);
    expect(p.isPending()).toBe(false);
  });

  it("卸載（flush）：還沒到 300 ms 的字立刻送出，計時器之後不會再送一次", () => {
    const commit = vi.fn();
    const p = createPendingCommit(commit, 300);
    p.schedule("百家姓");
    vi.advanceTimersByTime(100);
    p.flush(); // 元件卸載的 cleanup
    expect(commit.mock.calls).toEqual([["百家姓"]]);
    vi.advanceTimersByTime(1000);
    expect(commit).toHaveBeenCalledTimes(1);
    p.flush(); // blur 之後又卸載：沒有待送的值就什麼都不做
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("Esc（cancel）之後卸載不送；commit 途中重入 flush 不會重送", () => {
    const commit = vi.fn();
    const p = createPendingCommit(commit, 300);
    p.schedule("打錯");
    p.cancel();
    p.flush();
    vi.advanceTimersByTime(1000);
    expect(commit).not.toHaveBeenCalled();

    const inner = createPendingCommit((v) => {
      commit(v);
      inner.flush(); // store 更新 → 重繪 → 卸載 → cleanup 又 flush
    }, 300);
    inner.schedule("店家");
    inner.flush();
    expect(commit.mock.calls).toEqual([["店家"]]);
  });
});
