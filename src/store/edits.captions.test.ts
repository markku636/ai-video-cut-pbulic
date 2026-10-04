// 字幕編輯的 undo：每個動作一筆；同一段連續打字 / 微調在 800 ms 內合併成一筆；沒變就不留空的一筆。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptionCueV1, CaptionTrackV1 } from "../project/format";
import { cueText, emptyCaptionTrack } from "./captions";

const markDirty = vi.fn();
vi.mock("./project", () => ({ useProject: { getState: () => ({ markDirty }) } }));

const { useEdits, COALESCE_MS } = await import("./edits");

const M = "m1";

function cue(id: string, text: string, start: number): CaptionCueV1 {
  const words = [...text].map((ch, i) => ({ text: ch, startFrame: start + i * 3, endFrame: start + i * 3 + 3 }));
  return { id, startFrame: start, endFrame: start + words.length * 3, words };
}

function track(): CaptionTrackV1 {
  return { ...emptyCaptionTrack("subtitle", "zh-TW"), cues: [cue("c1", "百家姓課堂", 0), cue("c2", "店家翻牌", 30)] };
}

let now = 1_000_000;

beforeEach(() => {
  useEdits.getState().reset();
  markDirty.mockClear();
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const caps = () => useEdits.getState().captions[M] ?? null;
const lastLabel = () => {
  const past = useEdits.getState().past;
  return past[past.length - 1]?.label;
};

describe("edits：字幕", () => {
  it("applyCaptions → undo 回到沒有字幕 → redo；再套同一個物件不留一筆", () => {
    const st = useEdits.getState();
    const tr = track();
    st.applyCaptions(M, tr);
    expect(caps()).toBe(tr);
    expect(useEdits.getState().past.map((p) => p.label)).toEqual(["產生字幕"]);
    st.applyCaptions(M, tr);
    expect(useEdits.getState().past).toHaveLength(1);
    st.undo();
    expect(caps()).toBeNull();
    st.redo();
    expect(caps()).toBe(tr);
    st.applyCaptions(M, null);
    expect(lastLabel()).toBe("刪除字幕");
    expect(markDirty).toHaveBeenCalled();
  });

  it("同一段連續打字（每次間隔 < 800 ms）合併成一筆；undo 一次回到打字前", () => {
    const st = useEdits.getState();
    st.applyCaptions(M, track());
    const before = caps();
    expect(st.setCueText(M, "c1", "百家姓課")).toBe(true);
    now += COALESCE_MS - 100;
    expect(st.setCueText(M, "c1", "百家姓課桌")).toBe(true);
    now += COALESCE_MS - 100;
    expect(st.setCueText(M, "c1", "百家姓課桌上")).toBe(true);
    expect(useEdits.getState().past.map((p) => p.label)).toEqual(["產生字幕", "編輯字幕文字"]);
    expect(cueText(caps()!.cues[0])).toBe("百家姓課桌上");
    st.undo();
    expect(caps()).toBe(before);
  });

  it("間隔超過 800 ms、或換一段打字 → 另一筆；沒變的文字不留一筆", () => {
    const st = useEdits.getState();
    st.applyCaptions(M, track());
    st.setCueText(M, "c1", "百家姓");
    now += COALESCE_MS + 1;
    st.setCueText(M, "c1", "百家");
    now += 10;
    st.setCueText(M, "c2", "店家翻開牌");
    expect(st.setCueText(M, "c2", "店家翻開牌")).toBe(false);
    expect(useEdits.getState().past.map((p) => p.label)).toEqual(["產生字幕", "編輯字幕文字", "編輯字幕文字", "編輯字幕文字"]);
  });

  it("undo 之後再打字不會併進舊的那筆（future 有東西時不合併）", () => {
    const st = useEdits.getState();
    st.applyCaptions(M, track());
    st.setCueText(M, "c1", "百家姓");
    st.undo();
    now += 10;
    st.setCueText(M, "c1", "百家");
    const past = useEdits.getState().past;
    expect(past).toHaveLength(2);
    expect(useEdits.getState().future).toHaveLength(0);
  });

  it("按住微調：同一段同一邊 800 ms 內合併；換邊另一筆；夾住沒動不留", () => {
    const st = useEdits.getState();
    st.applyCaptions(M, track());
    for (let i = 0; i < 5; i++) {
      now += 30;
      st.nudgeCue(M, "c1", 1, "end", 1000);
    }
    expect(caps()!.cues[0].endFrame).toBe(20);
    now += 30;
    st.nudgeCue(M, "c1", 1, "start", 1000);
    expect(useEdits.getState().past.map((p) => p.label)).toEqual(["產生字幕", "調整字幕時間", "調整字幕時間"]);
    expect(st.nudgeCue(M, "c1", 999, "end", 1000)).toBe(true);
    expect(st.nudgeCue(M, "c1", 1, "end", 1000)).toBe(false); // 已經貼到 c2
  });

  it("分割 / 合併 / 強調 / 隱藏 / 刪除 / 插入：各一筆 undo", () => {
    const st = useEdits.getState();
    st.applyCaptions(M, track());
    expect(st.splitCue(M, "c1", 2)).toBe(true);
    expect(caps()!.cues.map((c) => c.id)).toEqual(["c1", "c3", "c2"]);
    expect(st.mergeCueWithNext(M, "c1")).toBe(true);
    expect(st.toggleEmphasis(M, "c1", 0)).toBe(true);
    expect(st.setCueHidden(M, "c2", true)).toBe(true);
    expect(st.deleteCue(M, "c2")).toBe(true);
    // c2 剛刪掉：新段 id 從目前最大號往上編（c1 → c2），不會跟現存的撞
    expect(st.insertCueAt(M, 40, "新字幕", 45, 200)).toBe("c2");
    expect(st.splitCueAtFrame(M, 7)).toBe(true);
    expect(useEdits.getState().past.map((p) => p.label)).toEqual(["產生字幕", "分割字幕", "合併字幕", "切換強調", "隱藏字幕段", "刪除字幕段", "插入字幕段", "分割字幕"]);
    for (let i = 0; i < 7; i++) st.undo();
    expect(caps()!.cues.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(st.splitCue(M, "nope", 1)).toBe(false);
  });

  it("尋找取代：回傳次數、一筆 undo；沒有符合不留", () => {
    const st = useEdits.getState();
    st.applyCaptions(M, track());
    expect(st.findReplace(M, "家", "家人")).toBe(2);
    expect(cueText(caps()!.cues[1])).toBe("店家人翻牌");
    expect(st.findReplace(M, "不存在", "x")).toBe(0);
    expect(useEdits.getState().past.map((p) => p.label)).toEqual(["產生字幕", "取代字幕文字"]);
  });

  it("預設 / 樣式 / 燒入開關：只換樣式不動段；樣式連續調整合併；一樣的值不留", () => {
    const st = useEdits.getState();
    st.applyCaptions(M, track());
    const cues = caps()!.cues;
    st.setCaptionPreset(M, "pop");
    st.setCaptionPreset(M, "pop");
    expect(caps()!.cues).toBe(cues);
    st.setCaptionStyle(M, { font: { sizePctShortSide: 6 } });
    now += 50;
    st.setCaptionStyle(M, { font: { sizePctShortSide: 7 } });
    st.setCaptionStyle(M, { font: { sizePctShortSide: 7 } });
    expect(caps()!.style).toEqual({ font: { sizePctShortSide: 7 } });
    st.setCaptionsEnabled(M, false);
    st.setCaptionsEnabled(M, false);
    expect(useEdits.getState().past.map((p) => p.label)).toEqual(["產生字幕", "字幕預設樣式", "字幕樣式", "關閉燒入字幕"]);
    st.undo();
    expect(caps()!.enabled).toBe(true);
  });

  it("LLM 建議套用：一筆 undo、回傳改到幾段", () => {
    const st = useEdits.getState();
    st.applyCaptions(M, track());
    expect(st.applyCaptionProposals(M, [{ cueId: "c1", text: "百家姓課桌", emphasis: ["百家姓"] }, { cueId: "zz", text: "x" }])).toBe(1);
    expect(caps()!.cues[0].words.slice(0, 3).every((w) => w.emphasis)).toBe(true);
    expect(lastLabel()).toBe("套用 LLM 校對");
  });

  it("別的動作（追蹤）不會把字幕洗掉；load / clear / reset 處理字幕", () => {
    const st = useEdits.getState();
    st.applyCaptions(M, track());
    st.setShots(M, [{ id: "s1", startFrame: 0, endFrame: 100, kind: "wide", source: "user" }]);
    expect(caps()?.cues).toHaveLength(2);
    st.undo();
    expect(caps()?.cues).toHaveLength(2);
    st.load("m2", { captions: track() });
    expect(useEdits.getState().captions.m2?.cues).toHaveLength(2);
    st.clear("m2");
    expect("m2" in useEdits.getState().captions).toBe(false);
    st.reset();
    expect(useEdits.getState().captions).toEqual({});
  });

  it("沒有字幕 track 時的編輯動作都是 no-op", () => {
    const st = useEdits.getState();
    expect(st.setCueText(M, "c1", "x")).toBe(false);
    expect(st.insertCueAt(M, 0, "x", 10)).toBeNull();
    expect(st.findReplace(M, "a", "b")).toBe(0);
    st.setCaptionPreset(M, "pop");
    expect(useEdits.getState().past).toHaveLength(0);
  });
});
