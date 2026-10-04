import { beforeEach, describe, expect, it } from "vitest";
import { useDialogs } from "./dialogs";

beforeEach(() => useDialogs.getState().closeAll());

describe("dialogs store", () => {
  it("open 疊上去、close 拿掉、isOpen 反映", () => {
    const d = useDialogs.getState();
    d.open("settings", { focus: "ffmpeg" });
    d.open("engineSetup");
    expect(useDialogs.getState().stack.map((e) => e.id)).toEqual(["settings", "engineSetup"]);
    expect(useDialogs.getState().isOpen("settings")).toBe(true);
    useDialogs.getState().close("settings");
    expect(useDialogs.getState().stack.map((e) => e.id)).toEqual(["engineSetup"]);
    expect(useDialogs.getState().isOpen("settings")).toBe(false);
  });
  it("重開同一個：同 props → 移到最上層、key 不變（不重掛）；props 不同 → key 遞增（重掛）", () => {
    const d = useDialogs.getState();
    d.open("export", { range: null });
    const k = useDialogs.getState().stack[0].key;
    d.open("about");
    d.open("export", { range: null });
    let st = useDialogs.getState().stack;
    expect(st.map((e) => e.id)).toEqual(["about", "export"]);
    expect(st[1].key).toBe(k);
    d.open("export", { range: { in: 10, out: 200 } });
    st = useDialogs.getState().stack;
    expect(st[1].key).not.toBe(k);
    expect(st[1].props).toEqual({ range: { in: 10, out: 200 } });
  });
  it("trackOptions 換一條 track 就重掛（抱著舊 trackId 的表單會改錯條）", () => {
    const d = useDialogs.getState();
    d.open("trackOptions", { trackId: "t1" });
    const k = useDialogs.getState().stack[0].key;
    d.open("trackOptions", { trackId: "t2" });
    expect(useDialogs.getState().stack).toHaveLength(1);
    expect(useDialogs.getState().stack[0].key).not.toBe(k);
  });
  it("關掉再開：key 遞增 = 重新掛載", () => {
    const d = useDialogs.getState();
    d.open("newTrack", { frame: 12 });
    const k1 = useDialogs.getState().stack[0].key;
    d.close("newTrack");
    d.open("newTrack", { frame: 12 });
    expect(useDialogs.getState().stack[0].key).toBeGreaterThan(k1);
  });
  it("closeTop 只關最上層", () => {
    const d = useDialogs.getState();
    d.open("settings");
    d.open("shortcuts");
    d.closeTop();
    expect(useDialogs.getState().stack.map((e) => e.id)).toEqual(["settings"]);
  });
  it("close 沒開著的對話框不會產生新的 state 物件", () => {
    const before = useDialogs.getState().stack;
    useDialogs.getState().close("about");
    expect(useDialogs.getState().stack).toBe(before);
  });
});
