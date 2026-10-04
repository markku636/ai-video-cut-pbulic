import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPORT_DEFAULTS, INSERT_DEFAULTS, type TrackV1 } from "../project/format";
import { rectQuad } from "../video/quad";

/** 自動儲存（B-02）：假計時器 + 手動放行的 project_save。 */
const h = vi.hoisted(() => {
  const pending: { json: string; resolve: () => void; reject: (e: Error) => void }[] = [];
  const written: string[] = [];
  const mode = { value: "manual" as "manual" | "ok" | "fail" };
  const projectSave = vi.fn(
    (_path: string, doc: unknown) =>
      new Promise<void>((resolve, reject) => {
        const json = JSON.stringify(doc);
        if (mode.value === "ok") {
          written.push(json);
          resolve();
        } else if (mode.value === "fail") reject(new Error("儲存錯誤：更新專案檔失敗：磁碟已滿。 (os error 112)"));
        else
          pending.push({
            json,
            resolve: () => {
              written.push(json);
              resolve();
            },
            reject,
          });
      }),
  );
  return { pending, written, mode, projectSave };
});

vi.mock("../api", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  api: { projectSave: h.projectSave, mediaCacheStatus: vi.fn(async () => ({ dir: "C:/cache", proxy: false })), cacheRead: vi.fn() },
}));

const { useProject } = await import("./project");
const { useEdits } = await import("./edits");
const { installAutosave, AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS, AUTOSAVE_RETRY_MS, AUTOSAVE_RETRY_MAX_MS } = await import("./autosave");

const M = "0123456789abcdef";
const PROJ = "C:/Users/demo/Desktop/範例-換色/專案 一.aivc.json";
const onError = vi.fn();
let uninstall: () => void = () => {};

function lastKeyframes(): number[] {
  const raw = h.written[h.written.length - 1];
  if (!raw) return [];
  return ((JSON.parse(raw) as { tracks: Record<string, TrackV1[]> }).tracks[M] ?? []).flatMap((t) => t.keyframes.map((k) => k.frame));
}

beforeEach(() => {
  vi.useFakeTimers();
  useEdits.getState().reset();
  useProject.setState({
    path: PROJ,
    dirty: false,
    createdAt: null,
    media: [{ id: M, path: "C:/Users/demo/Desktop/範例-換色/clip one.webm", name: "clip one.webm", fingerprint: "ab".repeat(32), probe: null, proxy: null, proxyState: "none" }],
    activeMediaId: M,
    profile: "cards",
    insertDefaults: INSERT_DEFAULTS,
    exportDefaults: EXPORT_DEFAULTS,
  });
  h.pending.length = 0;
  h.written.length = 0;
  h.mode.value = "manual";
  h.projectSave.mockClear();
  onError.mockClear();
  uninstall = installAutosave(onError);
});

afterEach(async () => {
  uninstall();
  for (let i = 0; i < 10 && h.pending.length; i++) {
    h.pending.shift()!.resolve();
    await vi.advanceTimersByTimeAsync(0);
  }
  vi.useRealTimers();
});

describe("自動儲存", () => {
  it("存檔途中的編輯：這次存完後會再自動存一次（舊版只看 dirty 翻面，永遠等不到）", async () => {
    const tid = useEdits.getState().addTrack(M, { frame: 10, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(h.pending).toHaveLength(1);
    useEdits.getState().setUserKeyframe(M, tid, 40, rectQuad(103, 100, 60, 90));
    h.pending.shift()!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(useProject.getState().dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(h.pending).toHaveLength(1);
    h.pending.shift()!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(lastKeyframes()).toEqual([10, 40]);
    expect(useProject.getState().dirty).toBe(false);
  });

  it("還在改就不存：最後一次編輯後滿 2 秒才存", async () => {
    h.mode.value = "ok";
    const tid = useEdits.getState().addTrack(M, { frame: 0, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    for (let i = 1; i <= 10; i++) {
      await vi.advanceTimersByTimeAsync(500);
      useEdits.getState().setUserKeyframe(M, tid, i, rectQuad(100 + i, 100, 60, 90));
    }
    expect(h.projectSave, "拖角點拖到一半不該存").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(h.projectSave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.projectSave).toHaveBeenCalledTimes(1);
    expect(lastKeyframes()).toHaveLength(11);
  });

  it("一直在改：從第一筆沒存的編輯起最晚 10 秒存一次", async () => {
    h.mode.value = "ok";
    const tid = useEdits.getState().addTrack(M, { frame: 0, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    let savedAt: number | null = null;
    for (let i = 1; i <= 30 && savedAt === null; i++) {
      await vi.advanceTimersByTimeAsync(500);
      if (h.projectSave.mock.calls.length) savedAt = i * 500;
      useEdits.getState().setUserKeyframe(M, tid, i, rectQuad(100 + i, 100, 60, 90));
    }
    expect(savedAt).toBe(AUTOSAVE_MAX_WAIT_MS);
  });

  it("失敗只提示一次；存成功之後再失敗才會再提示", async () => {
    h.mode.value = "fail";
    const tid = useEdits.getState().addTrack(M, { frame: 0, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatch(/os error 112/);
    expect(useProject.getState().dirty).toBe(true);
    useEdits.getState().setUserKeyframe(M, tid, 5, rectQuad(105, 100, 60, 90));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(h.projectSave).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    h.mode.value = "ok";
    useEdits.getState().setUserKeyframe(M, tid, 6, rectQuad(106, 100, 60, 90));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(useProject.getState().dirty).toBe(false);
    h.mode.value = "fail";
    useEdits.getState().setUserKeyframe(M, tid, 7, rectQuad(107, 100, 60, 90));
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("存失敗之後自己再排一次（退避），不是從此再也不存", async () => {
    // 訂閱只在 rev / dirty / path 變了才重新計時，失敗的 saveTo 一個都沒動 → 舊版「使用者停手 → 存一次 → 失敗」
    // 之後永遠不再嘗試，而提示只出現過那一次（B-08 的未儲存攔截不在這個分支裡，關掉就整份沒了）。
    h.mode.value = "fail";
    useEdits.getState().addTrack(M, { frame: 0, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(h.projectSave).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(AUTOSAVE_RETRY_MS);
    expect(h.projectSave, "失敗後要自己重試").toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_RETRY_MS * 2);
    expect(h.projectSave, "間隔加倍").toHaveBeenCalledTimes(3);
    expect(onError, "提示還是只有一次，不洗版").toHaveBeenCalledTimes(1);

    h.mode.value = "ok";
    await vi.advanceTimersByTimeAsync(AUTOSAVE_RETRY_MAX_MS);
    expect(useProject.getState().dirty, "磁碟恢復正常後不必等使用者再編輯就會存進去").toBe(false);
    expect(lastKeyframes()).toEqual([0]);
  });

  it("重試在解除之後停下來", async () => {
    h.mode.value = "fail";
    useEdits.getState().addTrack(M, { frame: 0, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    expect(h.projectSave).toHaveBeenCalledTimes(1);
    uninstall();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_RETRY_MAX_MS * 4);
    expect(h.projectSave).toHaveBeenCalledTimes(1);
  });

  it("沒有專案檔路徑不自動存；解除之後排定的也取消", async () => {
    h.mode.value = "ok";
    useProject.setState({ path: null });
    useEdits.getState().addTrack(M, { frame: 0, quad: rectQuad(100, 100, 60, 90), frames: 209 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS);
    expect(h.projectSave).not.toHaveBeenCalled();
    useProject.setState({ path: PROJ });
    useProject.getState().markDirty();
    uninstall();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS);
    expect(h.projectSave).not.toHaveBeenCalled();
  });
});
