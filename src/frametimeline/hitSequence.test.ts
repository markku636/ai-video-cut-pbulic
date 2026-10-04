// 序列空間命中測試（M2.10 驗收：淡化把手 > 邊緣 > 自動化點 > 音量線 > 本體；1 幀片段兩端都抓得到）。
import { describe, expect, it } from "vitest";
import { aclip, FPS30, gap, lane, seqOf, vclip } from "../sequence/testkit";
import { hitSequence, hoverClipIdOf, pickEdge, toTimelineHit, type SeqHitData } from "./hitSequence";
import { layoutSequenceRows } from "./layoutSequence";
import { gainDbToY, markerBand } from "./seqGeometry";

/** 30 fps：1 幀 = 1600 樣本。 */
const F = 1600;

describe("frametimeline/hitSequence：優先序（同一個點把候選一個一個拿掉）", () => {
  const view = { scrollFrame: 0, pxPerFrame: 1, frames: 1000 };
  /** 同一個游標 x：片段從 x=100 開始時在淡入把手內、離入點邊緣 4 px。 */
  const PX = 104;

  function setup(clipStartFrames: number, over: Parameters<typeof aclip>[4] = {}, handles = true) {
    const seq = seqOf([vclip("v", "m1", 0, 1000)], [lane("A1", "music", [aclip("c", "a-music", clipStartFrames * F, 200 * F, { gainDb: 12, ...over })])], FPS30);
    const L = layoutSequenceRows(seq, [], { A1: 72 });
    const row = L.lanes[0];
    const data: SeqHitData = { seq, fadeHandles: () => handles };
    // 游標 y：音量線（+12 dB 在片段頂端下 3 px）往下 1 px，同時落在淡化把手（片段頂端 8 px）內
    const lineY = gainDbToY(12, row.y + 1, row.h - 2);
    return { hit: (x: number, y = lineY + 1) => hitSequence(x, y, L, view, data), lineY, row };
  }

  it("淡化把手 > 片段邊緣 > 自動化點 > 音量線 > 本體", () => {
    // 淡入把手 [100,108] 內
    expect(setup(100).hit(PX)).toMatchObject({ kind: "audioClip", clipId: "c", laneId: "A1", part: "fadeIn" });
    // 把手沒顯示（沒 hover / 沒選取）→ 邊緣
    expect(setup(100, {}, false).hit(PX)).toMatchObject({ kind: "audioClip", part: "edgeIn" });
    // 片段往左移到 x=90（邊緣 14 px 外），在 x=104 放一個自動化點（0 dB，疊在 +12 的片段增益上 = 線同高）
    expect(setup(90, { envelope: [{ at: 14 * F, db: 0 }] }, false).hit(PX)).toMatchObject({ kind: "audioClip", part: "envPoint", pointIndex: 0 });
    // 拿掉自動化點 → 音量線
    expect(setup(90, {}, false).hit(PX)).toMatchObject({ kind: "audioClip", part: "gainLine" });
    // 音量線拉到最底（−48 dB）→ 本體
    expect(setup(90, { gainDb: -48 }, false).hit(PX)).toMatchObject({ kind: "audioClip", part: "body" });
    // 把手顯示時，即使邊緣、自動化點、音量線全部疊在同一點，還是把手贏
    expect(setup(100, { envelope: [{ at: 4 * F, db: 0 }] }, true).hit(PX)).toMatchObject({ part: "fadeIn" });
  });

  it("自動化點 ±5 px、音量線 ±4 px；淡出把手在片段尾端；軌上空白處 = audioLane", () => {
    const s = setup(90, { envelope: [{ at: 14 * F, db: 0 }] }, false);
    expect(s.hit(109, s.lineY + 1)).toMatchObject({ part: "envPoint" });
    expect(s.hit(110, s.lineY + 1)).toMatchObject({ part: "gainLine" });
    expect(s.hit(150, s.lineY + 4)).toMatchObject({ part: "gainLine" });
    expect(s.hit(150, s.lineY + 5)).toMatchObject({ part: "body" });
    expect(setup(90).hit(286)).toMatchObject({ part: "fadeOut" });
    expect(setup(90).hit(500)).toMatchObject({ kind: "audioLane", laneId: "A1" });
  });
});

describe("frametimeline/hitSequence：邊緣", () => {
  it("pickEdge：取最近；平手取游標那一側；同一個片段兩端平手看中點", () => {
    const spans = [
      { x0: 0, x1: 400 },
      { x0: 400, x1: 404 },
      { x0: 404, x1: 804 },
    ];
    expect(pickEdge(399, spans)).toEqual({ index: 0, part: "edgeOut" });
    expect(pickEdge(400, spans)).toEqual({ index: 1, part: "edgeIn" }); // 剛好在接點上 → 右邊的片段（[t0, t1) 半開）
    expect(pickEdge(401, spans)).toEqual({ index: 1, part: "edgeIn" });
    expect(pickEdge(403, spans)).toEqual({ index: 1, part: "edgeOut" });
    expect(pickEdge(402, spans)).toEqual({ index: 1, part: "edgeOut" });
    expect(pickEdge(405, spans)).toEqual({ index: 2, part: "edgeIn" });
    expect(pickEdge(200, spans)).toBeNull();
    expect(pickEdge(810, spans)).toEqual({ index: 2, part: "edgeOut" });
    expect(pickEdge(811, spans)).toBeNull();
  });

  it("V1 的 1 幀片段兩端都抓得到（4 px/幀，以及縮小到 0.5 px/幀的小數游標）", () => {
    const seq = seqOf([vclip("a", "m1", 0, 100), vclip("one", "m1", 100, 101), vclip("b", "m1", 101, 201)]);
    const L = layoutSequenceRows(seq, []);
    const y = L.v1Y + 10;
    const at = (x: number, px: number) => hitSequence(x, y, L, { scrollFrame: 0, pxPerFrame: px, frames: 201 }, { seq });
    expect(at(401, 4)).toMatchObject({ kind: "clip", clipId: "one", part: "edgeIn" });
    expect(at(403, 4)).toMatchObject({ kind: "clip", clipId: "one", part: "edgeOut" });
    expect(at(398, 4)).toMatchObject({ clipId: "a", part: "edgeOut" });
    expect(at(406, 4)).toMatchObject({ clipId: "b", part: "edgeIn" });
    expect(at(200, 4)).toMatchObject({ clipId: "a", part: "body" });
    expect(at(50.1, 0.5)).toMatchObject({ clipId: "one", part: "edgeIn" });
    expect(at(50.4, 0.5)).toMatchObject({ clipId: "one", part: "edgeOut" });
    expect(at(49.9, 0.5)).toMatchObject({ clipId: "a", part: "edgeOut" });
  });

  it("音軌上的 1 幀片段兩端也抓得到（音軌不磁吸：片段之間可以有空隙）", () => {
    const seq = seqOf([vclip("v", "m1", 0, 1000)], [lane("A1", "sfx", [aclip("s1", "a-vo", 100 * F, F), aclip("s2", "a-vo", 101 * F, 50 * F)])]);
    const L = layoutSequenceRows(seq, []);
    const y = L.lanes[0].y + 30; // 本體中段（不在把手、不在音量線上）
    const at = (x: number) => hitSequence(x, y, L, { scrollFrame: 0, pxPerFrame: 4, frames: 1000 }, { seq });
    expect(at(401)).toMatchObject({ kind: "audioClip", clipId: "s1", part: "edgeIn" });
    expect(at(403)).toMatchObject({ kind: "audioClip", clipId: "s1", part: "edgeOut" });
    expect(at(405)).toMatchObject({ kind: "audioClip", clipId: "s2", part: "edgeIn" });
    expect(at(396)).toMatchObject({ kind: "audioClip", clipId: "s1", part: "edgeIn" }); // 片段左邊的空白、6 px 內
    expect(at(390)).toEqual({ kind: "audioLane", laneId: "A1", frame: 98 });
  });

  it("空白沒有邊緣可拖：空白上靠近片段的地方抓到片段的邊緣，其他地方是 gap", () => {
    const seq = seqOf([vclip("a", "m1", 0, 100), gap("g", 50), vclip("b", "m1", 100, 200)]);
    const L = layoutSequenceRows(seq, []);
    const at = (x: number) => hitSequence(x, L.v1Y + 5, L, { scrollFrame: 0, pxPerFrame: 1, frames: 250 }, { seq });
    expect(at(103)).toMatchObject({ kind: "clip", clipId: "a", part: "edgeOut" });
    expect(at(125)).toEqual({ kind: "gap", gapId: "g", frame: 125 });
    expect(at(147)).toMatchObject({ kind: "clip", clipId: "b", part: "edgeIn" });
    // 序列結尾之後：沒有片段（frame 夾在最後一幀）
    expect(at(400)).toEqual({ kind: "empty", frame: 249 });
  });
});

describe("frametimeline/hitSequence：各列", () => {
  const seq = seqOf(
    [vclip("c2", "m1", 930, 1230, { audio: { enabled: true, gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [] } }), gap("g", 10), vclip("c1", "m1", 60, 360, { audio: { enabled: false, detachedTo: "d1", gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear", envelope: [] } })],
    [lane("A1", "other", [aclip("d1", "a-vo", 310 * F, 300 * F, { detachedFrom: "c1" })])],
  );
  const tracks = [{ id: "t1", mediaId: "m1", keyframes: [100, 1000], referenceFrame: 120 }];
  const L = layoutSequenceRows(seq, tracks);
  const view = { scrollFrame: 0, pxPerFrame: 1, frames: 610 };
  const data: SeqHitData = { seq, tracks, range: { in: 50, out: 150 } };
  const at = (x: number, y: number) => hitSequence(x, y, L, view, data);

  it("尺規、範圍列、A0 原音（已分離的片段只剩本體）、追蹤標頭、放置區、底下空白", () => {
    expect(at(80, 5)).toEqual({ kind: "ruler", frame: 80 });
    expect(at(100, L.rangeY + 3)).toEqual({ kind: "range", part: "body", frame: 100 });
    const a0Line = gainDbToY(0, L.a0Y + 1, L.a0H - 2);
    expect(at(150, a0Line)).toMatchObject({ kind: "original", clipId: "c2", part: "gainLine", frame: 150, sample: 150 * F });
    expect(at(150, L.a0Y + L.a0H - 3)).toMatchObject({ kind: "original", clipId: "c2", part: "body" });
    expect(at(400, a0Line)).toMatchObject({ kind: "original", clipId: "c1", part: "body" });
    // 10 幀的空白在 1 px/幀時兩側邊緣都在 6 px 內：邊緣優先（平手、游標不在任何一側的本體上 → 右邊片段的入點）
    expect(at(305, L.a0Y + 20)).toMatchObject({ kind: "original", clipId: "c1", part: "edgeIn" });
    expect(hitSequence(305 * 4, L.a0Y + 20, L, { ...view, pxPerFrame: 4 }, data)).toEqual({ kind: "gap", gapId: "g", frame: 305 });
    expect(at(10, L.tracksHeaderY + 3)).toEqual({ kind: "tracksHeader", frame: 10 });
    expect(at(10, L.dropY + 3)).toEqual({ kind: "dropZone", frame: 10 });
    expect(at(10, L.height + 40)).toEqual({ kind: "empty", frame: 10 });
  });

  it("追蹤車道：序列幀 + 對應的來源 k；菱形在序列裡的每一次出現都點得到；參考影格錨標", () => {
    const row = L.rows[0];
    expect(at(320, row.solvedY + 2)).toEqual({ kind: "solved", trackId: "t1", frame: 320, k: 70 });
    expect(at(305, row.solvedY + 2)).toEqual({ kind: "solved", trackId: "t1", frame: 305, k: null }); // 空白上
    // k 100 在 c1（t = 310 + 40 = 350）、k 1000 在 c2（t = 70）
    expect(at(352, row.userY + 5)).toEqual({ kind: "keyframe", trackId: "t1", frame: 350, k: 100 });
    expect(at(66, row.userY + 5)).toEqual({ kind: "keyframe", trackId: "t1", frame: 70, k: 1000 });
    expect(at(372, row.userY + 5)).toEqual({ kind: "reference", trackId: "t1", frame: 370, k: 120 });
    expect(at(500, row.userY + 5)).toEqual({ kind: "user", trackId: "t1", frame: 500, k: 250 });
  });

  it("轉成 M1 形狀（右鍵選單）：車道與菱形換成來源 k，序列專屬目標當時間軸空白", () => {
    const row = L.rows[0];
    expect(toTimelineHit(at(352, row.userY + 5))).toEqual({ kind: "keyframe", trackId: "t1", frame: 100 });
    expect(toTimelineHit(at(320, row.solvedY + 2))).toEqual({ kind: "solved", trackId: "t1", frame: 70 });
    expect(toTimelineHit(at(305, row.solvedY + 2))).toEqual({ kind: "empty", frame: 305 });
    expect(toTimelineHit(at(100, L.rangeY + 3))).toEqual({ kind: "range", part: "body", frame: 100 });
    expect(toTimelineHit(at(150, L.v1Y + 20))).toEqual({ kind: "empty", frame: 150 });
    expect(hoverClipIdOf(at(150, L.v1Y + 20))).toBe("c2");
    expect(hoverClipIdOf(at(400, L.lanes[0].y + 30))).toBe("d1");
    expect(hoverClipIdOf(at(10, 5))).toBeNull();
  });
});

describe("標記命中：畫得到就要點得到", () => {
  const withMarks = (markers: { id: string; t: number; name: string }[]) => ({ ...seqOf([vclip("v", "m1", 0, 1000)], [], FPS30), markers });
  const seq = withMarks([
    { id: "mk-1", t: 100, name: "開場" },
    { id: "mk-2", t: 300, name: "" },
  ]);
  const L = layoutSequenceRows(seq, []);
  const band = markerBand(L);
  const view = { scrollFrame: 0, pxPerFrame: 1, frames: 1000 };
  const at = (x: number, y = band.y + 1, s: import("../project/format").SequenceV2 = seq) => hitSequence(x, y, L, view, { seq: s });

  it("點在旗子上回 marker（帶名字），超過半寬就回尺規", () => {
    expect(at(100)).toEqual({ kind: "marker", markerId: "mk-1", frame: 100, name: "開場" });
    expect(at(104).kind).toBe("marker"); // 半寬 4 px，邊界算命中
    expect(at(105).kind).toBe("ruler");
    expect(at(96).kind).toBe("marker");
    expect(at(95).kind).toBe("ruler");
  });

  it("標記只佔尺規下緣：上面是刻度（尺規），下面已經是範圍列", () => {
    expect(at(100, band.y - 1).kind).toBe("ruler");
    expect(at(100, band.y + band.h - 1).kind).toBe("marker"); // 帶內最後一列仍算
    // band 底 = 尺規底 = 範圍列的頂，所以再下一 px 是 range 而不是 ruler
    expect(at(100, band.y + band.h).kind).toBe("range");
  });

  it("沒有標記的序列一律回尺規", () => {
    expect(at(100, band.y + 1, seqOf([vclip("v", "m1", 0, 1000)], [], FPS30)).kind).toBe("ruler");
  });

  it("兩個旗子疊在一起時回最靠近游標的那個（靠 x 距離，不是靠順序）", () => {
    const close = withMarks([
      { id: "a", t: 100, name: "" },
      { id: "b", t: 103, name: "" },
    ]);
    const hit = at(102, band.y + 1, close);
    expect(hit.kind === "marker" && hit.markerId).toBe("b");
  });

  it("toTimelineHit 把標記當尺規 —— 落到 default 會變成 empty，那就成了拖曳掃描", () => {
    expect(toTimelineHit({ kind: "marker", markerId: "x", frame: 42, name: "" })).toEqual({ kind: "ruler", frame: 42 });
  });
});
