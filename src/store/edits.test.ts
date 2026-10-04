import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildProjectFile, EXPORT_DEFAULTS, INSERT_DEFAULTS, type Quad, type ShotV1, type TrackV1 } from "../project/format";
import { parseProjectFile } from "../project/sanitize";
import { rectQuad } from "../video/quad";

const markDirty = vi.fn();
vi.mock("./project", () => ({ useProject: { getState: () => ({ markDirty }) } }));

// 格位 / 牌組的動作（setSlotTarget、linkTrackToSlot、setDeck…）在牌外掛：plugins/cards/frontend/store/cardEdits.test.ts
const { useEdits, MAX_HISTORY, stepsTo, hasUserEdits, staleTarget, PROJECT_SCOPE } = await import("./edits");

const M = "m1";
const Q: Quad = rectQuad(100, 100, 60, 90);
const Q2: Quad = rectQuad(120, 110, 60, 90);

function shot(id: string, a: number, b: number): ShotV1 {
  return { id, startFrame: a, endFrame: b, kind: "close", source: "auto" };
}

/** 外掛換目標的樣子（例如 cards 的 setSlotTarget）：點名的 track 標「只差目標」，一筆 undo。 */
function retarget(ids: readonly string[]): void {
  const tracks = (useEdits.getState().tracks[M] ?? []).map((t: TrackV1) => (ids.includes(t.id) ? staleTarget(t) : t));
  useEdits.getState().commitEdit(M, "設定目標牌", { tracks });
}

beforeEach(() => {
  useEdits.getState().reset();
  markDirty.mockClear();
});

describe("edits store：undo / redo", () => {
  it("addTrack 建 track（沒有鏡頭時補一個涵蓋整支的鏡頭）→ undo 回到空 → redo 再回來", () => {
    const st = useEdits.getState();
    const id = st.addTrack(M, { frame: 10, quad: Q, frames: 500 });
    let s = useEdits.getState();
    expect(s.tracks[M]).toHaveLength(1);
    expect(s.tracks[M][0].id).toBe(id);
    expect(s.tracks[M][0].keyframes).toEqual([{ frame: 10, quad: Q, source: "user" }]);
    expect(s.tracks[M][0].referenceFrame).toBe(10);
    expect(s.shots[M]).toEqual([{ id: s.tracks[M][0].shotId, startFrame: 0, endFrame: 500, kind: "unknown", source: "user" }]);
    expect(s.past).toHaveLength(1);
    expect(markDirty).toHaveBeenCalled();
    st.undo();
    s = useEdits.getState();
    expect(s.tracks[M]).toEqual([]);
    expect(s.shots[M]).toEqual([]);
    expect(s.future).toHaveLength(1);
    st.redo();
    s = useEdits.getState();
    expect(s.tracks[M]).toHaveLength(1);
    expect(s.past).toHaveLength(2 - 1);
    expect(s.future).toHaveLength(0);
  });

  it("setUserKeyframe 同一幀覆寫、依幀排序、標 stale；removeKeyframe 是另一筆 undo", () => {
    const st = useEdits.getState();
    const id = st.addTrack(M, { frame: 10, quad: Q, frames: 500 });
    st.markSolved(M, [id]);
    expect(useEdits.getState().tracks[M][0].stale).toBe(false);
    st.setUserKeyframe(M, id, 5, Q2);
    st.setUserKeyframe(M, id, 10, Q2);
    let t = useEdits.getState().tracks[M][0];
    expect(t.keyframes.map((k) => k.frame)).toEqual([5, 10]);
    expect(t.keyframes[1].quad).toEqual(Q2);
    expect(t.stale).toBe(true);
    // markSolved 不記 undo：addTrack + 2 次 setUserKeyframe = 3 筆
    expect(useEdits.getState().past).toHaveLength(3);
    st.removeKeyframe(M, id, 5);
    t = useEdits.getState().tracks[M][0];
    expect(t.keyframes.map((k) => k.frame)).toEqual([10]);
    st.undo();
    expect(useEdits.getState().tracks[M][0].keyframes.map((k) => k.frame)).toEqual([5, 10]);
    // 移除不存在的幀不會留下空 undo
    const n = useEdits.getState().past.length;
    st.removeKeyframe(M, id, 999);
    expect(useEdits.getState().past).toHaveLength(n);
  });

  it("新的 commit 會清掉 future（分岔的歷史不能重做）", () => {
    const st = useEdits.getState();
    const id = st.addTrack(M, { frame: 10, quad: Q, frames: 500 });
    st.setUserKeyframe(M, id, 20, Q2);
    st.undo();
    expect(useEdits.getState().future).toHaveLength(1);
    st.setUserKeyframe(M, id, 30, Q2);
    expect(useEdits.getState().future).toHaveLength(0);
    expect(useEdits.getState().tracks[M][0].keyframes.map((k) => k.frame)).toEqual([10, 30]);
  });

  it("jumpTo：跳到第 0 個狀態再跳回來，等價於連續 undo / redo", () => {
    const st = useEdits.getState();
    const id = st.addTrack(M, { frame: 10, quad: Q, frames: 500 });
    st.setUserKeyframe(M, id, 20, Q2);
    st.setUserKeyframe(M, id, 30, Q2);
    st.jumpTo(0);
    expect(useEdits.getState().tracks[M]).toEqual([]);
    expect(useEdits.getState().past).toHaveLength(0);
    st.jumpTo(3);
    expect(useEdits.getState().tracks[M][0].keyframes.map((k) => k.frame)).toEqual([10, 20, 30]);
    expect(stepsTo(3, 0, 1)).toEqual({ undo: 2, redo: 0 });
    expect(stepsTo(1, 2, 3)).toEqual({ undo: 0, redo: 2 });
    expect(stepsTo(1, 2, 99)).toEqual({ undo: 0, redo: 2 });
  });

  it("歷史最多 MAX_HISTORY 筆：多出來的最舊那幾筆被丟掉", () => {
    const st = useEdits.getState();
    const id = st.addTrack(M, { frame: 0, quad: Q, frames: 5000 });
    for (let i = 1; i <= MAX_HISTORY + 20; i++) st.setUserKeyframe(M, id, i, Q2);
    expect(useEdits.getState().past).toHaveLength(MAX_HISTORY);
    // 最舊的一筆已經不是 addTrack 了
    expect(useEdits.getState().past[0].label).toBe("設關鍵幀");
  });
});

describe("edits store：外掛狀態（pluginMedia / pluginProject）跟核心同一條 undo", () => {
  it("commitEdit：外掛的每媒體狀態只給部分鍵時與原本的合併，連同 track 一筆 undo；undo / redo 整份收回 / 放回", () => {
    const st = useEdits.getState();
    st.setShots(M, [shot("s1", 0, 100)]);
    const a = st.addTrack(M, { frame: 10, quad: Q });
    st.markSolved(M, [a]);
    const base = useEdits.getState().past.length;
    st.commitEdit(M, "外掛 A", { pluginMedia: { slots: [1, 2] } });
    st.commitEdit(M, "外掛 B", { pluginMedia: { other: "x" }, tracks: useEdits.getState().tracks[M].map((t) => staleTarget(t)) });
    let s = useEdits.getState();
    expect(s.past).toHaveLength(base + 2);
    expect(s.pluginMedia[M]).toEqual({ slots: [1, 2], other: "x" });
    expect(s.tracks[M][0].staleReason).toBe("target");
    st.undo();
    s = useEdits.getState();
    expect(s.pluginMedia[M]).toEqual({ slots: [1, 2] });
    expect(s.tracks[M][0].stale).toBe(false);
    st.undo();
    expect(useEdits.getState().pluginMedia[M]).toEqual({});
    st.redo();
    st.redo();
    expect(useEdits.getState().pluginMedia[M]).toEqual({ slots: [1, 2], other: "x" });
  });

  it("commitEdit：專案層的外掛狀態（例如牌組）掛在媒體的那一筆上也一起收回；PROJECT_SCOPE 只寫專案層", () => {
    const st = useEdits.getState();
    st.loadPluginProject({ deck: { styleId: "a" } });
    expect(useEdits.getState().past).toHaveLength(0);
    st.commitEdit(M, "換牌組", { pluginProject: { deck: { styleId: "b" } } });
    expect(useEdits.getState().pluginProject).toEqual({ deck: { styleId: "b" } });
    st.commitEdit(PROJECT_SCOPE, "專案設定", { pluginProject: { flag: true } });
    expect(useEdits.getState().pluginProject).toEqual({ deck: { styleId: "b" }, flag: true });
    expect(useEdits.getState().shots[PROJECT_SCOPE], "專案層的 patch 不能長出 shots['*project']").toBeUndefined();
    st.undo();
    st.undo();
    expect(useEdits.getState().pluginProject).toEqual({ deck: { styleId: "a" } });
  });

  it("applyDetection reconcile：外掛在同一筆 undo 裡改留下來的 track、寫自己的狀態；load / clear 帶著外掛狀態", () => {
    const st = useEdits.getState();
    st.setShots(M, [shot("s1", 0, 100)]);
    const mine = st.addTrack(M, { frame: 5, quad: Q, label: "我的" });
    const base = useEdits.getState().past.length;
    st.applyDetection(M, { tracks: [] }, "偵測", {
      reconcile: (kept) => ({ tracks: kept.map((t) => ({ ...t, label: `${t.label}*` })), pluginMedia: { found: 3 } }),
    });
    let s = useEdits.getState();
    expect(s.past).toHaveLength(base + 1);
    expect(s.tracks[M].map((t) => t.label)).toEqual(["我的*"]);
    expect(s.pluginMedia[M]).toEqual({ found: 3 });
    st.undo();
    s = useEdits.getState();
    expect(s.tracks[M].find((t) => t.id === mine)?.label).toBe("我的");
    expect(s.pluginMedia[M]).toEqual({});
    st.load("m2", { pluginMedia: { found: 1 } });
    expect(useEdits.getState().pluginMedia.m2).toEqual({ found: 1 });
    st.clear("m2");
    expect(useEdits.getState().pluginMedia.m2).toBeUndefined();
  });

  it("addTrack 的外掛鍵（fields）寫在 kind 後面；沒有外掛宣告預設時區域策略是整面替換", () => {
    const st = useEdits.getState();
    const id = st.addTrack(M, { frame: 10, quad: Q, frames: 100, fields: { slotId: "p1" } });
    const t = useEdits.getState().tracks[M].find((x) => x.id === id)!;
    const keys = Object.keys(t);
    expect(keys.indexOf("slotId")).toBe(keys.indexOf("kind") + 1);
    expect(t.regionPolicy).toBe("full");
  });
});

describe("edits store：鏡頭與批次", () => {
  it("applyDetection 一次建鏡頭 + 多條 track = 一筆 undo；已有的 track 不被洗掉", () => {
    const st = useEdits.getState();
    st.setShots(M, [shot("s1", 0, 100), shot("s2", 100, 200)]);
    const mine = st.addTrack(M, { frame: 5, quad: Q, label: "我的" });
    const base = useEdits.getState().past.length;
    const mk = (id: string, shotId: string) => ({ ...useEdits.getState().tracks[M][0], id, shotId, label: id, keyframes: [{ frame: 0, quad: Q, source: "detector" as const }] });
    st.applyDetection(M, { tracks: [mk("d1", "s1"), mk("d2", "s2"), mk("orphan", "nope"), mk(mine, "s1")] }, "偵測到 2 張牌");
    const s = useEdits.getState();
    expect(s.past).toHaveLength(base + 1);
    expect(s.tracks[M].map((t) => t.id)).toEqual([mine, "d1", "d2"]);
    expect(s.tracks[M][0].label).toBe("我的");
    st.undo();
    expect(useEdits.getState().tracks[M].map((t) => t.id)).toEqual([mine]);
  });

  it("splitShot / mergeShots：track 跟著鏡頭走；邊界或鏡頭外不切", () => {
    const st = useEdits.getState();
    st.setShots(M, [shot("s1", 0, 100)]);
    const late = st.addTrack(M, { frame: 70, quad: Q });
    const early = st.addTrack(M, { frame: 10, quad: Q });
    expect(st.splitShot(M, 0)).toBe(false);
    expect(st.splitShot(M, 100)).toBe(false);
    expect(st.splitShot(M, 50)).toBe(true);
    let s = useEdits.getState();
    expect(s.shots[M].map((x) => [x.startFrame, x.endFrame])).toEqual([[0, 50], [50, 100]]);
    const tail = s.shots[M][1];
    expect(s.tracks[M].find((t) => t.id === late)?.shotId).toBe(tail.id);
    expect(s.tracks[M].find((t) => t.id === early)?.shotId).toBe("s1");
    expect(st.mergeShots(M, tail.id)).toBe(false); // 最後一個沒有下一個可併
    expect(st.mergeShots(M, "s1")).toBe(true);
    s = useEdits.getState();
    expect(s.shots[M]).toHaveLength(1);
    expect(s.shots[M][0].endFrame).toBe(100);
    expect(s.tracks[M].every((t) => t.shotId === "s1")).toBe(true);
    st.undo();
    expect(useEdits.getState().shots[M]).toHaveLength(2);
  });

  it("setShots 拿掉鏡頭時，track 搬到涵蓋它關鍵幀的鏡頭，找不到就丟", () => {
    const st = useEdits.getState();
    st.setShots(M, [shot("s1", 0, 100), shot("s2", 100, 200)]);
    const a = st.addTrack(M, { frame: 150, quad: Q });
    const b = st.addTrack(M, { frame: 50, quad: Q });
    st.setShots(M, [shot("x", 0, 180)]);
    const s = useEdits.getState();
    expect(s.tracks[M].map((t) => t.id).sort()).toEqual([a, b].sort());
    expect(s.tracks[M].every((t) => t.shotId === "x")).toBe(true);
    st.setShots(M, [shot("y", 0, 100)]);
    expect(useEdits.getState().tracks[M].map((t) => t.id)).toEqual([b]);
  });

  it("addPrompt 同幀併入、clearPrompts 逐幀 / 全部", () => {
    const st = useEdits.getState();
    const id = st.addTrack(M, { frame: 10, quad: Q, frames: 100 });
    st.addPrompt(M, id, 10, [{ x: 1, y: 2, label: 1 }]);
    st.addPrompt(M, id, 10, [{ x: 3, y: 4, label: 0 }]);
    st.addPrompt(M, id, 20, [{ x: 5, y: 6, label: 1 }]);
    let t = useEdits.getState().tracks[M][0];
    expect(t.prompts.map((p) => [p.frame, p.points.length])).toEqual([[10, 2], [20, 1]]);
    st.clearPrompts(M, id, 10);
    t = useEdits.getState().tracks[M][0];
    expect(t.prompts.map((p) => p.frame)).toEqual([20]);
    st.clearPrompts(M, id);
    expect(useEdits.getState().tracks[M][0].prompts).toEqual([]);
    const n = useEdits.getState().past.length;
    st.clearPrompts(M, id); // 已經空了
    expect(useEdits.getState().past).toHaveLength(n);
  });

  it("clear 只清該媒體的資料與歷史；load 不記 undo", () => {
    const st = useEdits.getState();
    st.addTrack(M, { frame: 1, quad: Q, frames: 10 });
    st.addTrack("m2", { frame: 1, quad: Q, frames: 10 });
    st.clear(M);
    const s = useEdits.getState();
    expect(s.tracks[M]).toBeUndefined();
    expect(s.tracks.m2).toHaveLength(1);
    expect(s.past.every((p) => p.mediaId === "m2")).toBe(true);
    st.load(M, { shots: [shot("s1", 0, 10)] });
    expect(useEdits.getState().shots[M]).toHaveLength(1);
    expect(useEdits.getState().past).toHaveLength(1);
  });
});

describe("edits store：重跑偵測（審查 21 / 23）", () => {
  it("applyDetection 換掉鏡頭清單：留下來的使用者 track 搬到涵蓋它關鍵幀的新鏡頭（同 setShots），存檔再開不會被 sanitize 刪掉", () => {
    const st = useEdits.getState();
    // 還沒偵測鏡頭就先按 N：addTrack 補一個 shot-* 涵蓋整支
    const mine = st.addTrack(M, { frame: 150, quad: Q, frames: 400 });
    const userShot = useEdits.getState().tracks[M][0].shotId;
    st.markSolved(M, [mine]);
    st.applyDetection(M, { shots: [shot("shot1", 0, 100), shot("shot2", 100, 400)], tracks: [] }, "偵測", { replaceDetector: true });
    const s = useEdits.getState();
    expect(s.shots[M].map((x) => x.id)).toEqual(["shot1", "shot2"]);
    const t = s.tracks[M].find((x) => x.id === mine);
    expect(t?.shotId).not.toBe(userShot);
    expect(t?.shotId).toBe("shot2");
    // 換了鏡頭 = 解算相關的變更
    expect(t?.stale).toBe(true);
    expect(t?.staleReason).toBeUndefined();
    // 存檔 → 開檔：track 連關鍵幀都還在
    const doc = buildProjectFile(
      { media: [{ id: M, path: "D:\\v.webm", name: "v.webm", fingerprint: "", probe: null, proxy: null }], activeMediaId: M, profile: "generic", shots: s.shots, tracks: s.tracks, plugin: { media: s.pluginMedia, project: s.pluginProject }, insertDefaults: INSERT_DEFAULTS, exportDefaults: EXPORT_DEFAULTS },
      { name: "t", version: "0" },
    );
    const { file, report } = parseProjectFile(JSON.parse(JSON.stringify(doc)));
    expect(file.tracks[M].map((x) => x.id)).toEqual([mine]);
    expect(file.tracks[M][0].keyframes.map((k) => k.frame)).toEqual([150]);
    expect(report.dropped.tracks).toBeUndefined();
  });

});

describe("edits store：stale 原因（審查 24）", () => {
  it("markTargetsReady 只清「上次解算後只改了目標」的 stale；關鍵幀 / 選項改過的不清，也不會因為再換目標而降級", () => {
    const st = useEdits.getState();
    st.setShots(M, [shot("s1", 0, 100)]);
    const a = st.addTrack(M, { frame: 10, quad: Q });
    const b = st.addTrack(M, { frame: 10, quad: Q2 });
    const c = st.addTrack(M, { frame: 10, quad: Q });
    st.markSolved(M, [a, b, c]);
    st.setUserKeyframe(M, b, 20, Q2);
    st.setTrackOptions(M, c, { motionModel: "affine" });
    retarget([a, b, c]);
    const get = (id: string) => useEdits.getState().tracks[M].find((t) => t.id === id)!;
    expect(get(a).staleReason).toBe("target");
    expect(get(b).staleReason).toBeUndefined();
    expect(get(c).staleReason).toBeUndefined();

    st.markTargetsReady(M, [a, b, c]);
    expect([get(a).stale, get(b).stale, get(c).stale]).toEqual([false, true, true]);
    expect(get(a).staleReason).toBeUndefined();

    // 只差目標之後又釘了關鍵幀 → 升級成要重解
    retarget([a]);
    expect(get(a).staleReason).toBe("target");
    st.setUserKeyframe(M, a, 30, Q2);
    st.markTargetsReady(M, [a]);
    expect(get(a).stale).toBe(true);
    // 真的重解才清
    st.markSolved(M, [a, b, c]);
    expect([get(a).stale, get(b).stale, get(c).stale]).toEqual([false, false, false]);
  });
});

describe("edits store：快取被蓋掉 → markStale（審查 22）", () => {
  it("markStale 標「要重解」的 stale、不記 undo；只差目標的升級；已經要重解的沿用原物件；沒點名的不動", () => {
    const st = useEdits.getState();
    st.setShots(M, [shot("s1", 0, 100)]);
    const a = st.addTrack(M, { frame: 10, quad: Q });
    const b = st.addTrack(M, { frame: 20, quad: Q2 });
    const c = st.addTrack(M, { frame: 30, quad: Q });
    const d = st.addTrack(M, { frame: 40, quad: Q2 });
    st.markSolved(M, [a, b, d]);
    retarget([a, b]); // a、b → 只差目標
    st.markSolved(M, [a]);
    const get = (id: string) => useEdits.getState().tracks[M].find((t) => t.id === id)!;
    expect([get(a).stale, get(b).staleReason, get(c).stale, get(d).stale]).toEqual([false, "target", true, false]);
    const past = useEdits.getState().past.length;
    const cBefore = get(c);
    markDirty.mockClear();

    st.markStale(M, [a, b, c, "nope"]);
    expect(get(a).stale).toBe(true);
    expect(get(a).staleReason).toBeUndefined();
    expect(get(b).stale).toBe(true);
    expect(get(b).staleReason).toBeUndefined();
    expect(get(c)).toBe(cBefore);
    expect(get(d).stale).toBe(false);
    expect(useEdits.getState().past, "不記 undo：這是解算狀態不是使用者的編輯").toHaveLength(past);
    // stale / staleReason 會寫進專案檔 → 必須算一筆編輯（+rev）。不算的話，排在後面那筆存檔會被 rev 去重
    // 當成「這一版寫過了」而跳過：磁碟停在 stale:false，重開之後看到的是偵測的解算（B-02 審查 / REL-9）。
    expect(markDirty, "會改到存進檔裡的欄位就要 markDirty").toHaveBeenCalledTimes(1);
    // 升級成要重解之後 validateTargets 清不掉
    markDirty.mockClear();
    st.markTargetsReady(M, [a, b]);
    expect([get(a).stale, get(b).stale]).toEqual([true, true]);
    expect(markDirty, "沒有真的改到東西就不算編輯").not.toHaveBeenCalled();

    // 全部已經是要重解 → 不換 tracks 物件、也不算編輯；不存在的媒體不炸
    const list = useEdits.getState().tracks[M];
    st.markStale(M, [a, b, c]);
    expect(useEdits.getState().tracks[M]).toBe(list);
    expect(markDirty).not.toHaveBeenCalled();
    st.markStale("other", [a]);
    expect(useEdits.getState().tracks.other).toBeUndefined();
  });

  it("hasUserEdits：有使用者硬釘或 AdjustTrack 點才算；純偵測器關鍵幀不算（applyDetection replaceDetector 同一套規則）", () => {
    const st = useEdits.getState();
    st.setShots(M, [shot("s1", 0, 100)]);
    const id = st.addTrack(M, { frame: 10, quad: Q });
    const base = useEdits.getState().tracks[M][0];
    const det = { ...base, id: "det", keyframes: [{ frame: 10, quad: Q, source: "detector" as const }] };
    expect(hasUserEdits(base)).toBe(true);
    expect(hasUserEdits(det)).toBe(false);
    expect(hasUserEdits({ ...det, adjust: { points: [{ id: "r1", frame: 12, cornerIndex: 0, xy: [1, 2], locked: false, primaryFrame: 10 }], enabled: true } })).toBe(true);
    expect(id).toBe(base.id);
  });
});
