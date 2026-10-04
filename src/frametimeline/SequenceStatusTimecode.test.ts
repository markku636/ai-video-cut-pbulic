// M2.15 狀態列的雙時間碼（docs/editor-m2-design.md §12「序列 00:00:12:03｜m1 00:00:33:03（k 993）」）。
import { describe, expect, it } from "vitest";
import { gap, seqOf, vclip } from "../sequence/testkit";
import { dualTimecodeOf } from "./SequenceStatusTimecode";

const mediaOf = (id: string) => (id === "m1" ? { name: "m1.webm", fps: { num: 30, den: 1 } } : undefined);

describe("dualTimecodeOf", () => {
  const seq = seqOf([vclip("c1", "m1", 600, 900), gap("g1", 30), vclip("c2", "m1", 990, 1200, { enabled: false })]);

  it("序列幀 t 與它對到的來源 k 同時給（媒體名去副檔名）", () => {
    // t = 363 → 在 c2 裡（300 + 30 = 330 起）→ k = 990 + 33 = 1023
    expect(dualTimecodeOf(seq, "m1", 1023, 363, mediaOf)).toEqual({ t: 363, seqTc: "00:00:12:03", source: { name: "m1", tc: "00:00:34:03", k: 1023, disabled: true } });
  });

  it("沒有 seqFrame（播放器還沒接）：用第一個含 (媒體, k) 的位置", () => {
    expect(dualTimecodeOf(seq, "m1", 700, null, mediaOf)).toMatchObject({ t: 100, source: { k: 700 } });
  });

  it("空白上：只有序列時間碼；來源幀沒用在序列裡、也沒有 seqFrame：null（回到 M1 的顯示）", () => {
    expect(dualTimecodeOf(seq, "m1", 0, 310, mediaOf)).toEqual({ t: 310, seqTc: "00:00:10:10", source: null });
    expect(dualTimecodeOf(seq, "m1", 5, null, mediaOf)).toBeNull();
  });
});
