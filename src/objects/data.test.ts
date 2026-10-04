// 物件的資料讀取：objects.adopt 的回傳、anchors.v1.json（舞台的框）、masks.aivm 的 header / index（舞台只讀一幀）、
// 物件分頁那一列要講的話。
import { describe, expect, it } from "vitest";
import type { TrackV1 } from "../project/format";
import { adoptArgs, parseAdoptResult, rangeFromVisible, visibleFrameCount } from "./adopt";
import { AIVM_HEADER_BYTES, AIVM_INDEX_ENTRY_BYTES, findEntry, parseAivmHeader, parseAivmIndex } from "./maskFrame";
import { metaFromAdopt, parseAnchors, visibleAt } from "./meta";
import { objectRow, objectTracks, rangesText, sourceText } from "./view";

describe("objects.adopt", () => {
  it("參數名是 video / src / track_id；回傳值防禦式解析", () => {
    expect(adoptArgs("v.mp4", "C:\\f\\obj1", "obj-1")).toEqual({ video: "v.mp4", src: "C:\\f\\obj1", track_id: "obj-1" });
    const a = parseAdoptResult({ masks: "C:\\c\\tracks\\obj-1\\masks.aivm", visibleRanges: [[50, 60], [10, 20], [5, 1], "x"], bestFrame: 12, box: [1, 2, 3, 4], area: 9, thumb: "t.png" });
    expect(a.visibleRanges).toEqual([
      [10, 20],
      [50, 60],
    ]);
    expect(a.bestFrame).toBe(12);
    expect(parseAdoptResult(undefined)).toEqual({ masks: "", visibleRanges: [], bestFrame: null, box: null, area: 0, thumb: null });
  });
  it("可見區段（含頭含尾）→ 物件範圍（半開）；可見幀數", () => {
    expect(rangeFromVisible([[10, 20], [50, 60]], [0, 1])).toEqual([10, 61]);
    expect(rangeFromVisible([], [3, 9])).toEqual([3, 9]);
    expect(visibleFrameCount([[10, 20], [50, 60]])).toBe(22);
  });
});

describe("anchors.v1.json", () => {
  const doc = {
    format: "aivc.anchors.v1",
    size: [1280, 720],
    visibleRanges: [[10, 11]],
    frames: [
      { k: 9, computed: true, visible: false },
      { k: 10, computed: true, visible: true, area: 100, bbox: [1, 2, 10, 10], centroid: [6, 7], smooth: { bbox: [1.5, 2.5, 10, 10], centroid: [6.5, 7.5] } },
      { k: 11, computed: true, visible: true, area: 300, bbox: [3, 4, 20, 15] },
      { k: 12, visible: true },
    ],
  };
  it("只收看得到的幀；平滑過的框優先；面積最大的是最佳幀", () => {
    const m = parseAnchors(doc)!;
    expect([...m.frames.keys()]).toEqual([10, 11]);
    expect(m.frames.get(10)!.bbox).toEqual([1.5, 2.5, 10, 10]);
    expect(m.frames.get(11)!.centroid).toEqual([13, 11.5]);
    expect(m.bestFrame).toBe(11);
    expect(m.size).toEqual([1280, 720]);
    expect(visibleAt(m, 11)).toBe(true);
    expect(visibleAt(m, 12)).toBe(false);
    expect(parseAnchors({ format: "nope" })).toBeNull();
  });
  it("只有 adopt 的摘要：最佳幀那一格的框", () => {
    const m = metaFromAdopt({ masks: "", visibleRanges: [[0, 4]], bestFrame: 2, box: [0, 0, 4, 4], area: 16, thumb: null });
    expect([...m.frames.keys()]).toEqual([2]);
    expect(m.from).toBe("adopt");
  });
});

describe("masks.aivm header / index", () => {
  function file(entries: { k: number; off: number; len: number; flags: number }[]): ArrayBuffer {
    const buf = new ArrayBuffer(AIVM_HEADER_BYTES + entries.length * AIVM_INDEX_ENTRY_BYTES);
    const v = new DataView(buf);
    [0x41, 0x49, 0x56, 0x4d].forEach((b, i) => v.setUint8(i, b));
    v.setUint32(4, 1, true);
    v.setUint32(8, 640, true);
    v.setUint32(12, 360, true);
    v.setUint32(16, entries.length, true);
    v.setUint32(20, entries[0]?.k ?? 0, true);
    v.setUint32(24, entries[entries.length - 1]?.k ?? 0, true);
    v.setBigUint64(28, BigInt(AIVM_HEADER_BYTES), true);
    v.setBigUint64(36, BigInt(AIVM_HEADER_BYTES + entries.length * AIVM_INDEX_ENTRY_BYTES), true);
    v.setBigUint64(44, 999n, true);
    entries.forEach((e, i) => {
      const o = AIVM_HEADER_BYTES + i * AIVM_INDEX_ENTRY_BYTES;
      v.setUint32(o, e.k, true);
      v.setBigUint64(o + 4, BigInt(e.off), true);
      v.setUint32(o + 12, e.len, true);
      v.setUint8(o + 16, e.flags);
    });
    return buf;
  }

  it("header 52 bytes little-endian；magic 不對 → null", () => {
    const buf = file([{ k: 3, off: 0, len: 10, flags: 1 }]);
    const h = parseAivmHeader(buf.slice(0, AIVM_HEADER_BYTES))!;
    expect(h).toMatchObject({ version: 1, width: 640, height: 360, entries: 1, firstK: 3, lastK: 3, indexOff: 52, dataOff: 72, dataLen: 999 });
    expect(parseAivmHeader(new ArrayBuffer(52))).toBeNull();
    expect(parseAivmHeader(new ArrayBuffer(10))).toBeNull();
  });

  it("index 20 bytes 一筆；present 看 flags & 1；二分搜尋 k", () => {
    const entries = [
      { k: 3, off: 0, len: 10, flags: 1 },
      { k: 4, off: 10, len: 0, flags: 0 },
      { k: 9, off: 10, len: 7, flags: 1 },
    ];
    const buf = file(entries);
    const idx = parseAivmIndex(buf.slice(AIVM_HEADER_BYTES), entries.length);
    expect(idx).toEqual([
      { k: 3, off: 0, len: 10, present: true },
      { k: 4, off: 10, len: 0, present: false },
      { k: 9, off: 10, len: 7, present: true },
    ]);
    expect(findEntry(idx, 9)?.off).toBe(10);
    expect(findEntry(idx, 5)).toBeNull();
    expect(findEntry([], 1)).toBeNull();
  });
});

describe("物件分頁的一列", () => {
  const base = { id: "obj-1", shotId: "s1", label: "人臉", kind: "object", referenceFrame: 12, trackingRegion: null, keyframes: [], prompts: [], adjust: { points: [], enabled: false }, options: { method: "classic", motionModel: "perspective", smoothing: 0.4 }, insert: null, regionPolicy: "full", stale: false, color: "#FF5A5F", range: [10, 40] } as TrackV1;

  it("來源的說法：文字（含命中的英文片語）/ 手動 / AI", () => {
    expect(sourceText({ ...base, source: { type: "text", text: "人臉", phrase: "face" } })).toEqual({ key: "文字：{text}", params: { text: "人臉（face）" } });
    expect(sourceText({ ...base, source: { type: "text" } }).key).toBe("用文字找");
    expect(sourceText({ ...base, source: { type: "select" } }).key).toBe("手動選取");
    expect(sourceText({ ...base, source: { type: "ai" } }).key).toBe("AI 選的");
  });

  it("可見幀數只有讀到錨點才知道；特效數（含停用的）", () => {
    const row = objectRow({ ...base, effects: [{ id: "a", enabled: true, type: "mosaic" }, { id: "b", enabled: false, type: "blur" }] }, { visibleRanges: [[10, 20]], frames: new Map(), bestFrame: 15, size: null, from: "anchors" });
    expect(row.visibleFrames).toBe(11);
    expect(row.effects).toBe(2);
    expect(row.enabledEffects).toBe(1);
    expect(row.bestFrame).toBe(12);
    expect(objectRow(base, undefined).visibleFrames).toBeNull();
  });

  it("區段的短文字最多三段；只列物件 track", () => {
    expect(rangesText([[1, 5], [9, 9], [12, 20], [30, 31]])).toBe("1–5、9、12–20…");
    expect(rangesText([])).toBe("");
    expect(objectTracks([base, { ...base, id: "p", kind: "planar" }]).map((t) => t.id)).toEqual(["obj-1"]);
  });
});
