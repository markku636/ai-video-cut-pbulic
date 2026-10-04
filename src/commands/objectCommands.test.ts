// 物件指令的可用狀態與快捷鍵：沒有外掛時 Ctrl+D = 找物件；平面追蹤的指令遇到選中的物件會講清楚原因；
// 「追蹤這個物件」要有選取提示；開始畫面的卡片格線與「追蹤任何東西」的接續動作。
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const { commandList } = await import("./index");
const { command, duplicateChords, registerCommands, resetCommands } = await import("./registry");
const { needsAnyTrack, needsObjectTrack, needsTrack } = await import("./guards");
const { chordClaimedByPlugin, needsSelection } = await import("./objectCommands");
const { useEdits } = await import("../store/edits");
const { useProject } = await import("../store/project");
const { useTimeline } = await import("../store/timeline");
const { useSelection } = await import("../objects/selection");
const { startGridClass, trackAnythingAction } = await import("../shell/startCards");
const { rectQuad } = await import("../video/quad");

const M = "m1";

beforeEach(() => {
  resetCommands();
  registerCommands(commandList(true));
  useEdits.getState().reset();
  useSelection.getState().end();
  useProject.setState({ activeMediaId: M, media: [{ id: M, path: "D:\\v.mp4", name: "v.mp4", fingerprint: "ab", probe: null, proxy: { version: 1, fps: { num: 30, den: 1 }, frames: 300, width: 1280, height: 720, scale: 1, path: "p" }, proxyState: "ready" }] } as never);
  useEdits.getState().setShots(M, [{ id: "s1", startFrame: 0, endFrame: 300, kind: "wide", source: "auto" }]);
  useTimeline.getState().selectTrack(null);
});

function addObject(): string {
  return useEdits.getState().addObjectTracks(M, [{ id: "obj-1", label: "人臉", source: { type: "text", text: "face" }, range: [0, 100], referenceFrame: 10 }])[0];
}

describe("快捷鍵", () => {
  it("沒有外掛：Ctrl+D = 找物件、W = 選取物件工具；整張表沒有撞鍵", () => {
    expect(chordClaimedByPlugin("Ctrl+D")).toBe(false);
    expect(command("object.find")?.shortcuts).toEqual(["Ctrl+D"]);
    expect(command("object.tool.select")?.shortcuts).toEqual(["W"]);
    expect(duplicateChords()).toEqual([]);
  });
});

describe("可用狀態", () => {
  it("平面追蹤的指令遇到選中的物件：不能做，而且講去哪裡編輯；刪除追蹤兩種都可以", () => {
    const pid = useEdits.getState().addTrack(M, { frame: 5, quad: rectQuad(0, 0, 10, 10) });
    const oid = addObject();
    useTimeline.getState().selectTrack(pid);
    expect(needsTrack().ok).toBe(true);
    expect(needsObjectTrack().ok).toBe(false);
    useTimeline.getState().selectTrack(oid);
    const why = needsTrack();
    expect(why.ok).toBe(false);
    expect(!why.ok && why.why).toMatch(/物件/);
    expect(needsObjectTrack().ok).toBe(true);
    expect(needsAnyTrack().ok).toBe(true);
    expect(command("track.setKeyframe")!.enabled().ok).toBe(false);
    expect(command("mask.tool.addSelection")!.enabled().ok).toBe(false);
    expect(command("edit.deleteTrack")!.enabled().ok).toBe(true);
    expect(command("object.rename")!.enabled().ok).toBe(true);
    expect(command("object.delete")!.enabled().ok).toBe(true);
  });

  it("物件指令沒選物件時講原因", () => {
    const en = command("object.refine")!.enabled();
    expect(en.ok).toBe(false);
    expect(!en.ok && en.why).toMatch(/物件/);
  });

  it("「追蹤這個物件」要有提示點或框、不能在傳播中", () => {
    expect(needsSelection().ok).toBe(false);
    useSelection.getState().addPoint(M, 10, { x: 5, y: 5, label: 1 });
    expect(needsSelection().ok).toBe(true);
    useSelection.getState().setCommitting(true);
    expect(needsSelection().ok).toBe(false);
    useSelection.getState().setCommitting(false);
    useSelection.getState().addPoint("other", 10, { x: 5, y: 5, label: 1 });
    expect(needsSelection().ok).toBe(false);
  });

  it("找物件只要有開影片；沒開影片時講原因", () => {
    expect(command("object.find")!.enabled().ok).toBe(true);
    useProject.setState({ activeMediaId: null } as never);
    expect(command("object.find")!.enabled().ok).toBe(false);
  });
});

describe("舞台右鍵", () => {
  it("點在物件上：只有物件自己的動作（沒有關鍵幀 / 加選減選）；空白處多了找物件 / 選取物件", async () => {
    const { stageMenuItems, stageMenuCtxNow } = await import("./menuModel");
    addObject();
    const ids = (xs: { separator?: boolean; dataId?: string }[]) => xs.filter((i) => !i.separator).map((i) => String(i.dataId));
    const onObj = ids(stageMenuItems({ ...stageMenuCtxNow("obj-1"), canCopyImage: false, canSaveImage: false }));
    expect(onObj).toEqual(expect.arrayContaining(["object.jump", "object.refine", "object.rename", "object.delete"]));
    expect(onObj).not.toContain("track.setKeyframe");
    expect(onObj).not.toContain("mask.tool.addSelection");
    const empty = ids(stageMenuItems({ ...stageMenuCtxNow(null), canCopyImage: false, canSaveImage: false }));
    expect(empty).toEqual(expect.arrayContaining(["track.new", "object.find", "object.tool.select"]));
  });
});

describe("開始畫面", () => {
  it("卡片格線：1 張一欄、2 / 4 張兩欄、3 張與 5 張以上三欄", () => {
    expect(startGridClass(1)).toBe("grid-cols-1");
    expect(startGridClass(2)).toContain("sm:grid-cols-2");
    expect(startGridClass(3)).toContain("sm:grid-cols-3");
    expect(startGridClass(4)).toContain("sm:grid-cols-2");
    expect(startGridClass(6)).toContain("sm:grid-cols-3");
  });
  it("追蹤任何東西：有字 → 開檔後用那句話找；沒字 → 開找物件；兩個次要連結", () => {
    expect(trackAnythingAction("go", " 人臉 ")).toEqual({ kind: "find", text: "人臉" });
    expect(trackAnythingAction("go", "  ")).toEqual({ kind: "findEmpty" });
    expect(trackAnythingAction("select", "x")).toEqual({ kind: "select" });
    expect(trackAnythingAction("ai", "logo")).toEqual({ kind: "ai", text: "logo" });
  });
});
