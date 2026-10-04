// 軌道標頭（M2.10）：列的位置照 layoutSequenceRows（跟 canvas 對齊）、每條音軌一個標頭、16 px 的矮軌只留名字與靜音。
// 靜態渲染（renderToStaticMarkup），不需要 DOM。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { aclip, lane, seqOf, vclip } from "../sequence/testkit";
import { layoutSequenceRows, TRACK_HEADER_W } from "./layoutSequence";
import TrackHeaders from "./TrackHeaders";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

describe("frametimeline/TrackHeaders", () => {
  const seq = seqOf(
    [vclip("c1", "m1", 0, 100)],
    [lane("A1", "music", [aclip("m", "a-music", 0, 48000)], { name: "A1 音樂", muted: true }), lane("A2", "sfx", [], { name: "A2 音效", syncLock: true })],
  );
  const tracks = [
    { id: "t1", mediaId: "m1" },
    { id: "t2", mediaId: "m1" },
  ];
  const layout = layoutSequenceRows(seq, tracks, { A2: 16 });
  const html = renderToStaticMarkup(
    createElement(TrackHeaders, {
      layout,
      seq,
      implicit: false,
      tracks: [
        { id: "t1", label: "Player1", selected: true },
        { id: "t2", label: "Banker1", selected: false },
      ],
    }),
  );

  it("寬 132 px、高度跟 canvas 同一份版面；每一列的 top 就是 layout 的 y", () => {
    expect(html).toContain(`width:${TRACK_HEADER_W}px;height:${layout.height}px`);
    for (const y of [layout.v1Y, layout.a0Y, layout.tracksHeaderY, layout.rows[0].y, layout.rows[1].y, layout.lanes[0].y, layout.lanes[1].y]) expect(html).toContain(`top:${y}px`);
  });

  it("V1 / A0 / 追蹤群組 / 每條 track / 每條音軌都有標頭；音軌靜音鈕反映狀態", () => {
    expect(html).toContain("V1 影像");
    expect(html).toContain("A0 原音");
    expect(html).toContain("追蹤（2）");
    expect(html).toContain("Player1");
    expect(html).toContain("Banker1");
    expect(html).toContain("A1 音樂");
    expect(html).toContain("A2 音效");
    // A1 已靜音：按鈕是「取消音軌靜音」且 aria-pressed=true；A2 沒靜音
    expect(html).toMatch(/aria-label="取消音軌靜音" aria-pressed="true"/);
    expect(html).toMatch(/aria-label="音軌靜音" aria-pressed="false"/);
  });

  it("40 px 的軌有鎖定、同步鎖、推桿；16 px 的矮軌只剩名字、靜音、高度切換", () => {
    // 依音軌名切出兩段標頭（A1 在前、A2 在後）
    const a1 = html.slice(html.indexOf("A1 音樂"), html.indexOf("A2 音效"));
    const a2 = html.slice(html.indexOf("A2 音效"));
    expect(a1).toContain("音軌鎖定");
    expect(a1).toContain("同步鎖：關（釘在成品時間）");
    expect(a1).toContain('type="range"');
    expect(a1).toContain("軌道高度");
    expect(a2).toContain("音軌靜音");
    expect(a2).toContain("軌道高度");
    expect(a2).not.toContain("音軌鎖定");
    expect(a2).not.toContain("同步鎖：");
    expect(a2).not.toContain('type="range"');
  });

  it("追蹤群組摺疊時不渲染 track 列，但群組標頭還在", () => {
    const folded = layoutSequenceRows(seq, tracks, {}, { tracksCollapsed: true });
    const out = renderToStaticMarkup(createElement(TrackHeaders, { layout: folded, seq, implicit: true, tracks: [{ id: "t1", label: "Player1", selected: true }] }));
    expect(out).toContain('aria-expanded="false"');
    expect(out).not.toContain(">Player1<");
    expect(out).toContain("序列還沒剪過：第一次剪輯時才建立");
  });
});
