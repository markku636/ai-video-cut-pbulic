// validateSequence 本身要抓得到問題（不然 ops 測試裡的 ok() 只是永遠回空陣列的擺設）。
import { describe, expect, it } from "vitest";
import type { SequenceV2 } from "../project/format";
import { aclip, CTX, gap, lane, seqOf, vclip } from "./testkit";
import { validateSequence } from "./validate";

const codes = (seq: SequenceV2) => validateSequence(seq, CTX).map((i) => `${i.code}:${i.ref ?? ""}`);

describe("validateSequence", () => {
  it("乾淨的序列回空陣列", () => {
    expect(validateSequence(seqOf([vclip("c1", "m1", 0, 300), gap("g", 10)], [lane("A", "music", [aclip("a", "a-music", 0, 10), aclip("b", "a-music", 10, 10)])]), CTX)).toEqual([]);
  });

  it("I6：同軌重疊、未排序；id 重複（V1 與音軌共用命名空間）；音軌 id 重複", () => {
    const seq = seqOf([vclip("x", "m1", 0, 300)], [lane("A", "music", [aclip("a", "a-music", 0, 100), aclip("b", "a-music", 50, 100), aclip("c", "a-music", 10, 5)]), lane("A", "sfx", [aclip("x", "a-vo", 0, 1)])]);
    expect(codes(seq)).toEqual(["overlap:b", "unsorted:c", "duplicateLaneId:A", "duplicateId:x"]);
  });

  it("V1：空白長度、來源範圍、媒體不存在、離線；淡化超長（原音長度依序列位置）、曲線未排序或超界", () => {
    const seq = seqOf([
      gap("g", 0),
      vclip("r", "m1", 5, 5),
      vclip("u", "ghost", 0, 10),
      vclip("o", "m1", 1700, 1800),
      vclip("f", "m1", 0, 1, { audio: { enabled: true, gainDb: 0, fadeIn: 1000, fadeOut: 601, fadeCurve: "linear", envelope: [{ at: 900, db: 0 }, { at: 100, db: 0 }, { at: 1601, db: 0 }] } }),
    ]);
    expect(codes(seq)).toEqual(["gapLength:g", "clipRange:r", "unknownMedia:u", "offline:o", "fadeTooLong:f", "envelopeOrder:f", "envelopeRange:f"]);
  });

  it("分離參照：detachedTo 懸空或原音還開著、detachedFrom 懸空；音訊來源不存在", () => {
    const seq = seqOf(
      [vclip("c1", "m1", 0, 300, { audio: { enabled: true, gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [], detachedTo: "a" } }), vclip("c2", "m1", 300, 600, { audio: { enabled: false, gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [], detachedTo: "gone" } })],
      [lane("A", "other", [aclip("a", "a-vo", 0, 10, { detachedFrom: "c9" }), aclip("b", "nope", 20, 10)])],
    );
    expect(codes(seq)).toEqual(["unknownSource:b", "detachedTo:c1", "detachedTo:c2", "detachedFrom:a"]);
  });

  it("序列層：fps、取樣率、增益超界、角色；不帶 ctx 時不檢查媒體存在與離線", () => {
    const seq = { ...seqOf([vclip("u", "ghost", 0, 10)], [lane("A", "music", [], { gainDb: 20, role: "bgm" as never })]), fps: { num: 0, den: 1 }, sampleRate: 44100 as never };
    expect(validateSequence(seq).map((i) => i.code)).toEqual(["fps", "sampleRate", "role", "gainRange"]);
  });
});
