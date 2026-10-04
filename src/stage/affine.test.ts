import { describe, expect, it } from "vitest";
import { rectQuad, translateQuad } from "../video/quad";
import { affineFromTriples, applyAffine, composeAffine, IDENTITY_AFFINE, stabilizeAffine } from "./affine";

describe("stage/affine", () => {
  it("平移過的表面釘回去 = 反向平移", () => {
    const ref = rectQuad(100, 100, 50, 30);
    const cur = translateQuad(ref, 20, -10);
    const m = stabilizeAffine(cur, ref);
    expect(m[4]).toBeCloseTo(-20);
    expect(m[5]).toBeCloseTo(10);
    for (let i = 0; i < 4; i++) {
      const p = applyAffine(m, cur.p[i]);
      expect(p[0]).toBeCloseTo(ref.p[i][0]);
      expect(p[1]).toBeCloseTo(ref.p[i][1]);
    }
  });

  it("旋轉 + 縮放也解得出來（三點精確、第四點對矩形也精確）", () => {
    const ref = rectQuad(0, 0, 100, 60);
    const th = Math.PI / 6;
    const s = 1.5;
    const rot = (p: [number, number]): [number, number] => [s * (p[0] * Math.cos(th) - p[1] * Math.sin(th)) + 40, s * (p[0] * Math.sin(th) + p[1] * Math.cos(th)) + 7];
    const cur = { p: ref.p.map(rot) as typeof ref.p };
    const m = stabilizeAffine(cur, ref);
    for (let i = 0; i < 4; i++) {
      const p = applyAffine(m, cur.p[i]);
      expect(p[0]).toBeCloseTo(ref.p[i][0], 6);
      expect(p[1]).toBeCloseTo(ref.p[i][1], 6);
    }
  });

  it("退化（三點共線）回 null，stabilizeAffine 退回單位矩陣", () => {
    expect(affineFromTriples([[0, 0], [1, 0], [2, 0]], [[0, 0], [1, 1], [2, 2]])).toBeNull();
    const flat = { p: [[0, 0], [10, 0], [20, 0], [30, 0]] as ReturnType<typeof rectQuad>["p"] };
    expect(stabilizeAffine(flat, rectQuad(0, 0, 10, 10))).toEqual(IDENTITY_AFFINE);
  });

  it("composeAffine(m2, m1) = 先 m1 再 m2", () => {
    const m1: typeof IDENTITY_AFFINE = [2, 0, 0, 2, 0, 0];
    const m2: typeof IDENTITY_AFFINE = [1, 0, 0, 1, 5, 7];
    const c = composeAffine(m2, m1);
    expect(applyAffine(c, [1, 1])).toEqual(applyAffine(m2, applyAffine(m1, [1, 1])));
    expect(applyAffine(c, [1, 1])).toEqual([7, 9]);
  });
});
