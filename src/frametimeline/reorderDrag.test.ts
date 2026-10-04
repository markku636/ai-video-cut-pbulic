// V1 拖曳重排的純狀態機：插入點用「抽掉自己之後的中點」算，預覽順序、搬了幾格、邊界。
import { describe, expect, it } from "vitest";
import { gap, seqOf, vclip } from "../sequence/testkit";
import { beginReorderDrag, reorderTargetIndex, reorderTipText, updateReorderDrag } from "./reorderDrag";

/** a=100 幀、b=50、c=100、d=30；總長 280。 */
const four = () => seqOf([vclip("a", "m1", 0, 100), vclip("b", "m1", 200, 250), vclip("c", "m1", 400, 500), vclip("d", "m1", 600, 630)]);
const ids = (v: { id: string }[]) => v.map((x) => x.id);

describe("reorderTargetIndex：抽掉自己之後比中點", () => {
  it("拖 a 時剩下 b(50) c(100) d(30)：過了 b 的中點才換到第 1 格", () => {
    const seq = four();
    expect(reorderTargetIndex(seq, "a", 0)).toBe(0);
    expect(reorderTargetIndex(seq, "a", 24)).toBe(0); // b 的中點是 25
    expect(reorderTargetIndex(seq, "a", 25)).toBe(1);
    expect(reorderTargetIndex(seq, "a", 99)).toBe(1); // c 的中點是 50+50=100
    expect(reorderTargetIndex(seq, "a", 100)).toBe(2);
  });

  it("超出尾端夾在最後一格；負的夾在 0", () => {
    const seq = four();
    expect(reorderTargetIndex(seq, "a", 99999)).toBe(2);
    expect(reorderTargetIndex(seq, "a", -50)).toBe(0);
  });

  it("空白也算一格（拖片段越過空白是有意義的動作）", () => {
    const seq = seqOf([vclip("a", "m1", 0, 100), gap("g", 40), vclip("b", "m1", 200, 250)]);
    expect(reorderTargetIndex(seq, "a", 19)).toBe(0); // g 的中點是 20
    expect(reorderTargetIndex(seq, "a", 20)).toBe(1);
  });
});

describe("updateReorderDrag：預覽順序與位移", () => {
  it("往後拖：預覽把自己插進新位置，其餘維持原序", () => {
    const seq = four();
    const drag = beginReorderDrag(seq, "a")!;
    const p = updateReorderDrag(drag, 120);
    expect(p.toIndex).toBe(2);
    expect(ids(p.video)).toEqual(["b", "c", "a", "d"]);
    expect(p.delta).toBe(2);
    // 插入點 = 它前面那些項目的長度和（b 50 + c 100）
    expect(p.insertFrame).toBe(150);
  });

  it("往前拖", () => {
    const seq = four();
    const drag = beginReorderDrag(seq, "d")!;
    const p = updateReorderDrag(drag, 0);
    expect(p.toIndex).toBe(0);
    expect(ids(p.video)).toEqual(["d", "a", "b", "c"]);
    expect(p.delta).toBe(-3);
    expect(p.insertFrame).toBe(0);
  });

  it("還在原位時 delta = 0（呼叫端據此不 commit，不要洗出空的 undo）", () => {
    const seq = four();
    const drag = beginReorderDrag(seq, "a")!;
    const p = updateReorderDrag(drag, 10);
    expect(p.delta).toBe(0);
    expect(ids(p.video)).toEqual(["a", "b", "c", "d"]);
  });

  it("每次 update 都從 origin 重算：拖過頭再拖回來等於沒動", () => {
    const seq = four();
    const drag = beginReorderDrag(seq, "a")!;
    updateReorderDrag(drag, 99999);
    updateReorderDrag(drag, 120);
    expect(updateReorderDrag(drag, 10).delta).toBe(0);
  });
});

describe("beginReorderDrag / 提示", () => {
  it("id 不在 V1 上回 null", () => {
    expect(beginReorderDrag(four(), "沒這個")).toBeNull();
  });

  it("還在原位不給提示（不要為了有東西而吵）", () => {
    const t = (zh: string, vars?: Readonly<Record<string, string | number>>) => `${zh}|${JSON.stringify(vars ?? {})}`;
    expect(reorderTipText(0, t)).toBeNull();
    expect(reorderTipText(-2, t)).toBe('往前 {n} 格|{"n":2}');
    expect(reorderTipText(3, t)).toBe('往後 {n} 格|{"n":3}');
  });
});
