// 找物件對話框的邏輯（純函式）：片語 → 引擎的英文、範圍、錨定幀、引擎參數、find.v1.json 解析、
// 物件名 / 來源、後備提示、擋路的原因。
import { describe, expect, it } from "vitest";
import type { ShotV1 } from "../project/format";
import {
  addSuggestion,
  defaultScope,
  defaultTicked,
  enginePhrase,
  engineText,
  fallbackNote,
  findAnchor,
  findArgs,
  findBlocker,
  instanceLabels,
  instanceRange,
  instanceSource,
  parseFindResult,
  parsePhrases,
  relToCache,
  scopeFrames,
  scopeUnavailable,
  type ScopeContext,
} from "./find";

const shots: ShotV1[] = [
  { id: "a", startFrame: 0, endFrame: 100, kind: "wide", source: "auto" },
  { id: "b", startFrame: 100, endFrame: 250, kind: "close", source: "auto" },
];
const ctx = (over: Partial<ScopeContext> = {}): ScopeContext => ({ frame: 120, frames: 300, shots, range: null, ...over });

/** seg.find 的回傳（docs/tracking-api.md §6.1 的形狀）。 */
const FIND = {
  format: "aivc.find.v1",
  video: "D:\\v.mp4",
  text: "face, license plate",
  phrases: ["face", "license plate"],
  backend: { name: "sam2", label: "OWLv2 + SAM 2.1", requested: "auto", fallback: true, reason: "本機沒有 facebook/sam3 權重" },
  frames: { k0: 100, k1: 250, anchor: 120 },
  frameSize: [1280, 720],
  fps: [30, 1],
  outDir: "C:\\cache\\media\\ab\\find\\f1",
  overlay: { path: "C:\\cache\\media\\ab\\find\\f1\\overlay.png", frame: 120 },
  instances: [
    { id: 1, phrase: "face", score: 0.61234, firstFrame: 100, lastFrame: 249, bestFrame: 140, box: [10, 20, 30, 40], area: 900, framesPresent: 150, framesAbsent: 0, seedFrame: 120, masks: "C:\\cache\\media\\ab\\find\\f1\\obj1\\masks.aivm", thumb: "C:\\cache\\media\\ab\\find\\f1\\obj1\\thumb.png" },
    { id: 2, phrase: "face", score: 0.4, firstFrame: 130, lastFrame: 200, bestFrame: 150, box: [100, 20, 30, 40], area: 700, framesPresent: 60, framesAbsent: 11, masks: "C:\\cache\\media\\ab\\find\\f1\\obj2\\masks.aivm", thumb: null },
    { id: 3, phrase: "license plate", score: 0.3, firstFrame: 105, lastFrame: 106, bestFrame: 105, box: null, area: 50, framesPresent: 2, framesAbsent: 0, masks: "C:\\x\\obj3\\masks.aivm" },
    { id: 4, phrase: "broken" },
  ],
  dropped: 2,
  notes: ["超過 --max 8"],
};

describe("片語", () => {
  it("分隔符跟引擎一樣（半形 / 全形逗號、頓號、換行），去重保序", () => {
    expect(parsePhrases(" 人臉，車牌、logo\n人臉 , ")).toEqual(["人臉", "車牌", "logo"]);
    expect(parsePhrases("  ")).toEqual([]);
  });
  it("建議片語與常見中文換成英文，其他原樣；引擎片語 → 使用者打的字", () => {
    expect(enginePhrase("人臉")).toBe("face");
    expect(enginePhrase("車牌")).toBe("license plate");
    expect(enginePhrase("Logo")).toBe("logo");
    expect(enginePhrase("red car")).toBe("red car");
    const e = engineText("人臉、臉, 車牌, red car");
    expect(e.text).toBe("face, license plate, red car");
    expect(e.display.get("face")).toBe("人臉");
    expect(e.display.get("red car")).toBe("red car");
  });
  it("按建議片語：加進輸入框，已經有就不重複", () => {
    expect(addSuggestion("", "人臉")).toBe("人臉");
    expect(addSuggestion("車牌", "人臉")).toBe("車牌, 人臉");
    expect(addSuggestion("人臉, 車牌", "人臉")).toBe("人臉, 車牌");
  });
});

describe("範圍與錨定幀", () => {
  it("鏡頭 / 整支 / I-O；播放線不在任何鏡頭裡 → 整支；沒有 I-O → null", () => {
    expect(scopeFrames("shot", ctx())).toEqual([100, 250]);
    expect(scopeFrames("shot", ctx({ frame: 280 }))).toEqual([0, 300]);
    expect(scopeFrames("clip", ctx())).toEqual([0, 300]);
    expect(scopeFrames("range", ctx())).toBeNull();
    expect(scopeFrames("range", ctx({ range: { in: 40, out: 999 } }))).toEqual([40, 300]);
    expect(scopeFrames("clip", ctx({ frames: 0 }))).toBeNull();
  });
  it("哪個範圍不能用、為什麼；預設：有 I-O 用 I-O，否則這個鏡頭", () => {
    expect(scopeUnavailable("range", ctx())).toBe("先用 I / O 標一段範圍");
    expect(scopeUnavailable("shot", ctx({ frames: 0 }))).toMatch(/proxy/);
    expect(scopeUnavailable("clip", ctx())).toBeNull();
    expect(defaultScope({ range: null })).toBe("shot");
    expect(defaultScope({ range: { in: 1, out: 5 } })).toBe("range");
  });
  it("錨定幀：播放線在範圍內就用它，否則範圍中點", () => {
    expect(findAnchor([100, 250], 120)).toBe(120);
    expect(findAnchor([100, 250], 20)).toBe(175);
    expect(findAnchor([10, 11], 0)).toBe(10);
  });
  it("「找」按鈕擋路的原因依序：正在找 → 引擎 → 範圍 → 沒打字", () => {
    const base = { text: "人臉", engineReady: true, scope: "shot" as const, ctx: ctx(), busy: false };
    expect(findBlocker(base)).toBeNull();
    expect(findBlocker({ ...base, busy: true })).toBe("正在找");
    expect(findBlocker({ ...base, engineReady: false })).toBe("引擎尚未就緒");
    expect(findBlocker({ ...base, scope: "range" })).toBe("先用 I / O 標一段範圍");
    expect(findBlocker({ ...base, text: " , " })).toMatch(/先打要找的東西/);
  });
});

describe("引擎參數與結果", () => {
  it("findArgs：鍵 = CLI dest 名、範圍 K0:K1、片語換成英文", () => {
    expect(findArgs({ video: "D:\\v.mp4", text: "人臉, 車牌", frames: [100, 250], anchor: 120, out: "C:\\c\\find\\f1", max: 4, sam: "small" })).toEqual({
      video: "D:\\v.mp4",
      text: "face, license plate",
      frames: "100:250",
      anchor: 120,
      out: "C:\\c\\find\\f1",
      max_instances: 4,
      sam: "small",
    });
  });
  it("parseFindResult：沒有 masks 的實例丟掉；後端、範圍、疊色圖、註記都收", () => {
    const r = parseFindResult(FIND);
    expect(r.instances.map((i) => i.id)).toEqual([1, 2, 3]);
    expect(r.backend).toEqual({ name: "sam2", label: "OWLv2 + SAM 2.1", fallback: true, reason: "本機沒有 facebook/sam3 權重" });
    expect(r.frames).toEqual({ k0: 100, k1: 250, anchor: 120 });
    expect(r.overlay?.frame).toBe(120);
    expect(r.instances[1].thumb).toBeNull();
    expect(r.instances[2].box).toBeNull();
    expect(r.dropped).toBe(2);
    expect(r.notes).toEqual(["超過 --max 8"]);
    expect(parseFindResult(null).instances).toEqual([]);
    expect([...defaultTicked(r)]).toEqual([1, 2, 3]);
  });
  it("實例 → 物件 track 的範圍（半開）：看不到就用 find 的範圍", () => {
    expect(instanceRange({ firstFrame: 100, lastFrame: 249 }, { k0: 100, k1: 250 })).toEqual([100, 250]);
    expect(instanceRange({ firstFrame: -1, lastFrame: -1 }, { k0: 100, k1: 250 })).toEqual([100, 250]);
  });
  it("物件名：用使用者打的字，同名加編號，避開已經有的名字；來源寫片語、後端、分數", () => {
    const r = parseFindResult(FIND);
    const names = instanceLabels(r, "人臉, 車牌", ["人臉"]);
    expect([...names.values()]).toEqual(["人臉 2", "人臉 3", "車牌"]);
    expect(instanceSource(r, r.instances[0], " 人臉, 車牌 ")).toEqual({ type: "text", text: "人臉, 車牌", phrase: "face", backend: "sam2", score: 0.6123 });
  });
  it("後備提示：退回時講原因（不擋流程），沒退就沒有", () => {
    expect(fallbackNote(parseFindResult(FIND).backend)?.params.reason).toBe("本機沒有 facebook/sam3 權重");
    expect(fallbackNote({ name: "sam3", label: "SAM 3", fallback: false, reason: "" })).toBeNull();
  });
  it("relToCache：快取底下的相對路徑（大小寫、斜線方向不拘）；不在底下 → null", () => {
    expect(relToCache("C:\\Cache\\media\\ab", "c:/cache/media/ab/find/f1/overlay.png")).toBe("find/f1/overlay.png");
    expect(relToCache("C:\\cache\\media\\ab\\", "D:\\other\\x.png")).toBeNull();
  });
});
