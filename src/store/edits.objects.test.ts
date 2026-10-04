// 物件 track 的 edits 動作：新增（一次好幾條 = 一筆 undo）、重新命名、換色、改範圍、刪除、特效 / 替換，
// 以及既有的鏡頭動作（換鏡頭清單、切鏡頭、重跑偵測）遇到物件 track 時不會把它弄丟。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildProjectFile, EXPORT_DEFAULTS, INSERT_DEFAULTS, OBJECT_COLORS, type ShotV1, type TrackV1 } from "../project/format";
import { parseProjectFile } from "../project/sanitize";
import { rectQuad } from "../video/quad";

const markDirty = vi.fn();
vi.mock("./project", () => ({ useProject: { getState: () => ({ markDirty }) } }));

const { useEdits, hasUserEdits, newObjectTrackId, nextObjectColor, OBJECT_EDIT_LABEL } = await import("./edits");

const M = "m1";
const shot = (id: string, a: number, b: number): ShotV1 => ({ id, startFrame: a, endFrame: b, kind: "wide", source: "auto" });
const objInit = (id: string, range: [number, number], extra: Partial<Parameters<ReturnType<typeof useEdits.getState>["addObjectTracks"]>[1][number]> = {}) => ({
  id,
  label: `物件 ${id}`,
  source: { type: "text" as const, text: "face", phrase: "face" },
  range,
  referenceFrame: range[0] + 1,
  ...extra,
});
const lastPatch = () => { const p = useEdits.getState().past; return p[p.length - 1]; };
const tracks = (): TrackV1[] => useEdits.getState().tracks[M] ?? [];

beforeEach(() => {
  useEdits.getState().reset();
  markDirty.mockClear();
});

describe("addObjectTracks", () => {
  it("一次加好幾條 = 一筆 undo；shotId = 涵蓋範圍起點的鏡頭；顏色依序挑沒用過的", () => {
    useEdits.getState().setShots(M, [shot("s1", 0, 100), shot("s2", 100, 300)]);
    const before = useEdits.getState().past.length;
    const ids = useEdits.getState().addObjectTracks(M, [objInit("a", [10, 90]), objInit("b", [150, 220]), objInit("c", [0, 300], { color: "#123456" })]);
    expect(ids).toEqual(["a", "b", "c"]);
    const s = useEdits.getState();
    expect(s.past.length).toBe(before + 1);
    expect(s.past[s.past.length - 1].label).toBe(OBJECT_EDIT_LABEL.add);
    expect(tracks().map((t) => [t.id, t.kind, t.shotId, t.color])).toEqual([
      ["a", "object", "s1", OBJECT_COLORS[0]],
      ["b", "object", "s2", OBJECT_COLORS[1]],
      ["c", "object", "s1", "#123456"],
    ]);
    expect(tracks()[0].range).toEqual([10, 90]);
    expect(tracks()[0].referenceFrame).toBe(11);
    expect(markDirty).toHaveBeenCalled();
    useEdits.getState().undo();
    expect(tracks()).toEqual([]);
    useEdits.getState().redo();
    expect(tracks().map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  it("還沒偵測鏡頭：補一個涵蓋整支的鏡頭（跟新增平面追蹤一樣）；鏡頭之間的缺口補一段不重疊的", () => {
    useEdits.getState().addObjectTracks(M, [{ ...objInit("a", [5, 50]), frames: 400 }]);
    expect(useEdits.getState().shots[M]).toEqual([{ id: tracks()[0].shotId, startFrame: 0, endFrame: 400, kind: "unknown", source: "user" }]);
    useEdits.getState().reset();
    useEdits.getState().setShots(M, [shot("s1", 0, 100), shot("s2", 200, 300)]);
    useEdits.getState().addObjectTracks(M, [objInit("gap", [120, 180])]);
    const host = useEdits.getState().shots[M].find((x) => x.id === tracks()[0].shotId)!;
    expect([host.startFrame, host.endFrame]).toEqual([100, 200]);
  });

  it("已經有的 id、空範圍略過；全部略過就不留 undo", () => {
    useEdits.getState().addObjectTracks(M, [{ ...objInit("a", [0, 10]), frames: 100 }]);
    const n = useEdits.getState().past.length;
    expect(useEdits.getState().addObjectTracks(M, [objInit("a", [0, 10]), objInit("z", [5, 5])])).toEqual([]);
    expect(useEdits.getState().past.length).toBe(n);
  });

  it("寫進專案檔就是契約的形狀，讀回來一樣", () => {
    useEdits.getState().addObjectTracks(M, [{ ...objInit("a", [0, 10]), frames: 100 }]);
    const s = useEdits.getState();
    const media = [{ id: M, path: "D:\\v.mp4", name: "v.mp4", fingerprint: "ab".repeat(32), probe: null, proxy: null }];
    const doc = buildProjectFile({ media, activeMediaId: M, profile: "generic", shots: s.shots, tracks: s.tracks, insertDefaults: INSERT_DEFAULTS, exportDefaults: EXPORT_DEFAULTS }, { name: "x", version: "0" });
    const t = (doc.tracks as unknown as Record<string, Record<string, unknown>[]>)[M][0];
    expect(Object.keys(t)).toEqual(["id", "shotId", "label", "kind", "referenceFrame", "keyframes", "color", "source", "range"]);
    const back = parseProjectFile(JSON.parse(JSON.stringify(doc)) as unknown);
    expect(back.report.total).toBe(0);
    expect(back.file.tracks[M]).toEqual(s.tracks[M]);
  });
});

describe("setObjectFields（重新命名 / 換色 / 範圍 / 最佳幀）", () => {
  beforeEach(() => {
    useEdits.getState().setShots(M, [shot("s1", 0, 100), shot("s2", 100, 300)]);
    useEdits.getState().addObjectTracks(M, [objInit("a", [10, 90])]);
  });

  it("每一種改動一筆 undo、標籤講改了什麼；沒變 / 空名字 / 壞色碼不留 undo", () => {
    const st = () => useEdits.getState();
    expect(st().setObjectFields(M, "a", { label: "  車牌 " })).toBe(true);
    expect(tracks()[0].label).toBe("車牌");
    expect(lastPatch().label).toBe(OBJECT_EDIT_LABEL.rename);
    expect(st().setObjectFields(M, "a", { color: "#00FF00" })).toBe(true);
    expect(lastPatch().label).toBe(OBJECT_EDIT_LABEL.recolor);
    const n = st().past.length;
    expect(st().setObjectFields(M, "a", { label: "車牌" })).toBe(false);
    expect(st().setObjectFields(M, "a", { label: "   " })).toBe(false);
    expect(st().setObjectFields(M, "a", { color: "green" })).toBe(false);
    expect(st().past.length).toBe(n);
    st().undo();
    expect(tracks()[0].color).toBe(OBJECT_COLORS[0]);
    st().undo();
    expect(tracks()[0].label).toBe("物件 a");
  });

  it("改範圍：shotId 跟著搬到涵蓋新起點的鏡頭；反向範圍不收", () => {
    expect(useEdits.getState().setObjectFields(M, "a", { range: [150, 250] })).toBe(true);
    expect(tracks()[0].range).toEqual([150, 250]);
    expect(tracks()[0].shotId).toBe("s2");
    expect(lastPatch().label).toBe(OBJECT_EDIT_LABEL.range);
    expect(useEdits.getState().setObjectFields(M, "a", { range: [50, 20] })).toBe(false);
    useEdits.getState().undo();
    expect(tracks()[0].shotId).toBe("s1");
  });

  it("平面 track 不吃這個動作", () => {
    const id = useEdits.getState().addTrack(M, { frame: 5, quad: rectQuad(0, 0, 10, 10) });
    expect(useEdits.getState().setObjectFields(M, id, { label: "x" })).toBe(false);
  });
});

describe("removeTracks / effects / replace", () => {
  beforeEach(() => {
    useEdits.getState().setShots(M, [shot("s1", 0, 300)]);
    useEdits.getState().addObjectTracks(M, [objInit("a", [0, 50]), objInit("b", [20, 80])]);
  });

  it("刪好幾條 = 一筆 undo，undo 原樣回來（含位置）", () => {
    useEdits.getState().removeTracks(M, ["a", "b", "nope"]);
    expect(tracks()).toEqual([]);
    expect(lastPatch().label).toBe(OBJECT_EDIT_LABEL.remove);
    useEdits.getState().undo();
    expect(tracks().map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("特效整份換掉；空陣列拿掉 effects 鍵（不寫空陣列）", () => {
    const fx = [{ id: "m", enabled: true, type: "mosaic", shape: "ellipse" }];
    useEdits.getState().setTrackEffects(M, "a", fx);
    expect(tracks()[0].effects).toEqual(fx);
    useEdits.getState().setTrackEffects(M, "a", []);
    expect("effects" in tracks()[0]).toBe(false);
    useEdits.getState().undo();
    expect(tracks()[0].effects).toEqual(fx);
  });

  it("拖數值：同一個 coalesceKey 連續改合併成一筆 undo，undo 一次回到拖之前", () => {
    const n = useEdits.getState().past.length;
    const fx = (block: number) => [{ id: "m", enabled: true, type: "mosaic", block }];
    for (const b of [8, 12, 16, 20]) useEdits.getState().setTrackEffects(M, "a", fx(b), OBJECT_EDIT_LABEL.effects, { coalesceKey: "fx:a:m:block" });
    expect(useEdits.getState().past.length).toBe(n + 1);
    expect(tracks()[0].effects).toEqual(fx(20));
    useEdits.getState().undo();
    expect("effects" in tracks()[0]).toBe(false);
  });

  it("隱私打碼：新增物件時一起掛特效，跟新增同一筆 undo", () => {
    const n = useEdits.getState().past.length;
    const mosaic = { id: "p1", enabled: true, type: "mosaic", shape: "ellipse", expand: 6 };
    useEdits.getState().addObjectTracks(M, [objInit("c", [0, 40], { effects: [mosaic] }), objInit("d", [0, 40])]);
    expect(useEdits.getState().past.length).toBe(n + 1);
    expect(tracks().find((t) => t.id === "c")!.effects).toEqual([mosaic]);
    expect("effects" in tracks().find((t) => t.id === "d")!).toBe(false);
    // 寫檔帶得出去（契約：effects 只在非空時寫）
    const s = useEdits.getState();
    const media = [{ id: M, path: "D:\\v.mp4", name: "v.mp4", fingerprint: "ab".repeat(32), probe: null, proxy: null }];
    const doc = buildProjectFile({ media, activeMediaId: M, profile: "generic", shots: s.shots, tracks: s.tracks, insertDefaults: INSERT_DEFAULTS, exportDefaults: EXPORT_DEFAULTS }, { name: "x", version: "0" });
    const disk = (doc.tracks as unknown as Record<string, Record<string, unknown>[]>)[M].find((t) => t.id === "c")!;
    expect(disk.effects).toEqual([mosaic]);
    expect(parseProjectFile(JSON.parse(JSON.stringify(doc)) as unknown).file.tracks[M].find((t) => t.id === "c")!.effects).toEqual([mosaic]);
    useEdits.getState().undo();
    expect(tracks().map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("替換內容只給平面 track", () => {
    const pid = useEdits.getState().addTrack(M, { frame: 5, quad: rectQuad(0, 0, 10, 10) });
    const rep = { kind: "image" as const, path: "D:\\ad.png", fit: "cover" as const, offsetFrames: 0, loop: "loop" as const };
    useEdits.getState().setTrackReplace(M, "a", rep);
    expect(tracks()[0].replace).toBeUndefined();
    useEdits.getState().setTrackReplace(M, pid, rep);
    expect(tracks().find((t) => t.id === pid)!.replace).toEqual(rep);
    useEdits.getState().setTrackReplace(M, pid, null);
    expect("replace" in tracks().find((t) => t.id === pid)!).toBe(false);
  });
});

describe("既有的鏡頭 / 偵測動作遇到物件 track", () => {
  it("物件 track 算「使用者動過」：外掛重跑偵測（replaceDetector）不會把它換掉", () => {
    useEdits.getState().setShots(M, [shot("s1", 0, 300)]);
    useEdits.getState().addObjectTracks(M, [objInit("a", [0, 50])]);
    expect(hasUserEdits(tracks()[0])).toBe(true);
    useEdits.getState().applyDetection(M, { shots: [shot("d1", 0, 300)], tracks: [] }, "自動偵測", { replaceDetector: true });
    expect(tracks().map((t) => [t.id, t.shotId, t.stale])).toEqual([["a", "d1", false]]);
  });

  it("換鏡頭清單：物件 track 依範圍起點搬家（不標 stale：沒有解要重算）", () => {
    useEdits.getState().setShots(M, [shot("s1", 0, 300)]);
    useEdits.getState().addObjectTracks(M, [objInit("a", [150, 200])]);
    useEdits.getState().setShots(M, [shot("x1", 0, 100), shot("x2", 100, 300)]);
    expect(tracks()[0].shotId).toBe("x2");
    expect(tracks()[0].stale).toBe(false);
  });

  it("切鏡頭：範圍起點在切點之後的物件 track 跟著去後半段", () => {
    useEdits.getState().setShots(M, [shot("s1", 0, 300)]);
    useEdits.getState().addObjectTracks(M, [objInit("early", [10, 200]), objInit("late", [160, 250])]);
    useEdits.getState().splitShot(M, 150);
    const [early, late] = tracks();
    expect(early.shotId).toBe("s1");
    expect(late.shotId).not.toBe("s1");
  });
});

describe("輔助", () => {
  it("newObjectTrackId 不重複、不撞到清單裡的 id", () => {
    const a = newObjectTrackId([], 1000);
    const b = newObjectTrackId([{ id: a }], 1000);
    expect(a).toMatch(/^obj-/);
    expect(b).not.toBe(a);
  });

  it("nextObjectColor：挑還沒用過的，全用過就輪回去", () => {
    const used = OBJECT_COLORS.map((c, i) => ({ kind: "object", color: c, id: String(i) }) as TrackV1);
    expect(nextObjectColor([])).toBe(OBJECT_COLORS[0]);
    expect(nextObjectColor(used.slice(0, 2))).toBe(OBJECT_COLORS[2]);
    expect(nextObjectColor(used, 1)).toBe(OBJECT_COLORS[1]);
  });
});
