// M2.13 修剪拖曳接上 undo（§13 M2.13「Esc 還原」、§6 editSequence）：預覽中 store 一個位元都不動；
// 放開 = 一筆「修剪片段」、隱含序列在同一筆實體化，一次 Ctrl+Z 回到 null，追蹤資料參照不變（I1）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectMediaV2 } from "../project/format";
import { makeSeqCtx } from "../sequence/context";
import { A_MUSIC, M1, M2 } from "../sequence/testkit";
import { validateSequence } from "../sequence/validate";
import { rectQuad } from "../video/quad";

const project: { markDirty: () => void; media: ProjectMediaV2[]; activeMediaId: string | null } = { markDirty: () => {}, media: [], activeMediaId: null };
vi.mock("../store/project", () => ({ useProject: { getState: () => project } }));

const { useEdits, SEQ_EDIT_LABEL } = await import("../store/edits");
const { viewSequenceOf } = await import("./layoutSequence");
const { beginTrimDrag, cancelTrimDrag, commitTrimDrag, updateTrimDrag } = await import("./trimDrag");

const st = () => useEdits.getState();
const CTX = () => makeSeqCtx(project.media, st().audioMedia);

beforeEach(() => {
  st().reset();
  project.media = [M1, M2];
  project.activeMediaId = "m1";
});

function dragImplicitEnd(toRaw: number) {
  // 時間軸畫的是隱含序列的實體化檢視（viewSequenceOf），拖曳從它開始
  const view = viewSequenceOf(st().sequence, { ...M1, proxy: M1.proxy! })!;
  const b = beginTrimDrag(view, { kind: "v1", id: "clip-1", edge: "out" }, 1797);
  if (!b.ok) throw new Error("refused");
  return { drag: b.drag, res: updateTrimDrag(b.drag, toRaw, { pxPerFrame: 1, targets: [], ctx: CTX() }) };
}

describe("修剪拖曳 × edits store", () => {
  it("預覽與 Esc 都不碰 store；放開才 commit 一筆，隱含序列同一筆實體化，undo 回到 null（I1）", () => {
    st().load("m1", {});
    st().addTrack("m1", { frame: 10, quad: rectQuad(100, 100, 60, 90), frames: 1797 });
    const before = st();
    const pastLen = before.past.length;

    const { drag, res } = dragImplicitEnd(1500);
    expect(res.delta).toBe(-297);
    // 預覽：store 完全沒動
    expect(st().sequence).toBeNull();
    expect(st().past.length).toBe(pastLen);
    // Esc：丟掉預覽就是還原
    expect(cancelTrimDrag(drag).video[0]).toMatchObject({ srcIn: 0, srcOut: 1797 });
    expect(st().sequence).toBeNull();

    expect(commitTrimDrag(drag, res, st().editSequence, SEQ_EDIT_LABEL.trim)).toBe(true);
    const after = st();
    expect(after.past.length).toBe(pastLen + 1);
    expect(after.past[after.past.length - 1].label).toBe("修剪片段");
    expect(after.sequence?.video).toEqual([expect.objectContaining({ id: "clip-1", srcIn: 0, srcOut: 1500 })]);
    expect(after.sequence).toEqual(res.seq);
    expect(validateSequence(after.sequence!, CTX())).toEqual([]);
    expect(after.tracks).toBe(before.tracks);
    expect(after.shots).toBe(before.shots);
    expect(after.pluginMedia).toBe(before.pluginMedia);

    st().undo();
    expect(st().sequence).toBeNull();
    expect(st().tracks).toBe(before.tracks);
  });

  it("沒有移動（delta 0）不留 undo，隱含序列不會因為點一下邊緣就被實體化", () => {
    const { drag, res } = dragImplicitEnd(1797.4);
    expect(res.delta).toBe(0);
    expect(commitTrimDrag(drag, res, st().editSequence, SEQ_EDIT_LABEL.trim)).toBe(false);
    expect(st().sequence).toBeNull();
    expect(st().past).toEqual([]);
  });

  it("拖曳中序列被別的動作改過：commit 只重做這一端的修剪，不會把那個改動蓋掉", () => {
    const { drag, res } = dragImplicitEnd(1700);
    // 拖到一半，別的地方把原音靜音了（例如軌道標頭）
    st().editSequence(SEQ_EDIT_LABEL.laneMute, (s) => ({ ...s, original: { ...s.original, muted: true } }), { audioMedia: [A_MUSIC] });
    expect(commitTrimDrag(drag, res, st().editSequence, SEQ_EDIT_LABEL.trim)).toBe(true);
    expect(st().sequence?.original.muted).toBe(true);
    expect(st().sequence?.video[0]).toMatchObject({ srcOut: 1700 });
  });
});
