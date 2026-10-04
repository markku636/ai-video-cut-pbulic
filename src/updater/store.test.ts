// 自動更新的狀態機：背景檢查（節流、略過的版本、失敗安靜）、手動檢查（toast / 開對話框）、安裝前守門（工作、未存檔；
// 下載完再守一次）、下載進度與取消、在背景下載完不自己裝、安裝成功 / 失敗、略過這個版本。Rust 指令全部以假的 invoke 回應。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadOutcome, InstallOutcome, UpdateInfo, UpdaterStatus } from "./api";

// ---- Tauri 與 UI 的替身（vi.mock 會被提到 import 之前；工廠裡延遲取用，才不會碰到 const 的 TDZ）----
type Handler = (ev: { payload: unknown }) => void;
const listeners = new Map<string, Handler>();
const invoke = vi.fn();
const relaunch = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
const uiConfirm = vi.fn();
const openDialog = vi.fn();
const closeDialog = vi.fn();
const saveProject = vi.fn();
const project = { dirty: false };
/** 更新對話框開著嗎（使用者按「在背景繼續」就是關著）。 */
let dialogOpen = true;

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: Handler) => {
    listeners.set(name, cb);
    return Promise.resolve(() => listeners.delete(name));
  },
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: () => relaunch() }));
vi.mock("../ui", () => ({ toast, uiConfirm: (...a: unknown[]) => uiConfirm(...a) }));
vi.mock("../store/dialogs", () => ({
  openDialog: (...a: unknown[]) => openDialog(...a),
  closeDialog: (...a: unknown[]) => closeDialog(...a),
  isDialogOpen: () => dialogOpen,
}));
vi.mock("../store/project", () => ({ useProject: { getState: () => project } }));
vi.mock("../commands/appActions", () => ({ saveProject: () => saveProject() }));

const { useUpdater, checkForUpdatesManually, maybeAutoCheck, installUpdater, guardInput } = await import("./store");
const { useSettings, DEFAULT_SETTINGS } = await import("../store/settings");
const { useJobs } = await import("../store/jobs");
const { useEngine } = await import("../store/engine");

const ENABLED: UpdaterStatus = {
  enabled: true,
  reasonCode: null,
  reason: null,
  currentVersion: "0.0.7",
  endpoint: "https://github.com/markku636/ai-video-cut-pbulic/releases/latest/download/latest.json",
  defaultEndpoint: "https://github.com/markku636/ai-video-cut-pbulic/releases/latest/download/latest.json",
  overridden: false,
  overrideAllowed: true,
  devBuild: false,
};
const NO_KEY: UpdaterStatus = { ...ENABLED, enabled: false, reasonCode: "no_pubkey", reason: "還沒有設定更新簽章的公鑰", endpoint: null };
const V8: UpdateInfo = { version: "0.0.8", currentVersion: "0.0.7", notes: "修好了很多東西\n- 第二行", date: "2026-10-03T12:00:00Z" };

let status: UpdaterStatus;
let checkReply: () => Promise<UpdateInfo | null>;
let downloadReply: () => Promise<DownloadOutcome>;
let installReply: () => Promise<InstallOutcome>;
let savedSettings: unknown[];

function calls(cmd: string) {
  return invoke.mock.calls.filter((c) => c[0] === cmd);
}

/** 等 microtask 跑完（store 裡的 await 鏈）。 */
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  status = ENABLED;
  checkReply = async () => null;
  downloadReply = async () => ({ canceled: false });
  installReply = async () => ({ restartRequired: true });
  savedSettings = [];
  project.dirty = false;
  dialogOpen = true;
  invoke.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
    switch (cmd) {
      case "updater_status":
        return status;
      case "update_check":
        return checkReply();
      case "update_download":
        return downloadReply();
      case "update_cancel":
        return true;
      case "update_install":
        return installReply();
      case "settings_set":
        savedSettings.push(args?.settings);
        return args?.settings;
      case "settings_get":
        return useSettings.getState().s;
      case "client_log":
        return null;
      default:
        throw new Error(`沒有這個假指令：${cmd}`);
    }
  });
  relaunch.mockResolvedValue(undefined);
  useSettings.setState({ s: { ...DEFAULT_SETTINGS, updater: { ...DEFAULT_SETTINGS.updater } }, loaded: true });
  useUpdater.setState({ status: null, phase: "idle", update: null, progress: null, error: null });
  useJobs.setState({ jobs: [] });
  useEngine.setState({ info: null, pyenv: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("背景檢查", () => {
  it("已是最新：狀態 upToDate、記下這次檢查的時間（24 小時節流用），不吵", async () => {
    const r = await useUpdater.getState().check({ silent: true });
    expect(r).toEqual({ kind: "upToDate" });
    expect(useUpdater.getState().phase).toBe("upToDate");
    await flush();
    expect(useSettings.getState().s.updater.last_update_check).toBeGreaterThan(0);
    expect(calls("update_check")[0][1]).toEqual({ timeoutMs: 20_000 });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("有新版：available（狀態列靠它出現提示），不自己開對話框、不自己裝", async () => {
    checkReply = async () => V8;
    const r = await useUpdater.getState().check({ silent: true });
    expect(r.kind).toBe("available");
    expect(useUpdater.getState()).toMatchObject({ phase: "available", update: V8 });
    expect(openDialog).not.toHaveBeenCalled();
    expect(calls("update_install")).toHaveLength(0);
  });

  it("使用者略過的版本：不提示；手動檢查照樣顯示", async () => {
    useSettings.setState({ s: { ...useSettings.getState().s, updater: { ...DEFAULT_SETTINGS.updater, skipped_update_version: "0.0.8" } } });
    checkReply = async () => V8;
    expect((await useUpdater.getState().check({ silent: true })).kind).toBe("skipped");
    expect(useUpdater.getState()).toMatchObject({ phase: "idle", update: null });
    expect((await useUpdater.getState().check({ silent: false })).kind).toBe("available");
    expect(useUpdater.getState().update).toEqual(V8);
  });

  it("失敗安靜：不 toast、不改畫面、只寫 log；也不記檢查時間（下次開 App 再試）", async () => {
    useUpdater.setState({ phase: "available", update: V8 });
    checkReply = async () => {
      throw { kind: "invalid", code: "ERR_INVALID", message: "連不上更新伺服器（離線，或網址不對）" };
    };
    const r = await useUpdater.getState().check({ silent: true });
    expect(r).toEqual({ kind: "error", message: "連不上更新伺服器（離線，或網址不對）" });
    expect(useUpdater.getState()).toMatchObject({ phase: "available", update: V8, error: null });
    expect(toast.error).not.toHaveBeenCalled();
    expect(calls("client_log").some((c) => String((c[1] as { msg: string }).msg).includes("連不上"))).toBe(true);
    await flush();
    expect(savedSettings).toHaveLength(0);
  });

  it("停用（沒有公鑰）：不連線，回停用原因", async () => {
    status = NO_KEY;
    const r = await useUpdater.getState().check({ silent: true });
    expect(r.kind).toBe("disabled");
    expect(calls("update_check")).toHaveLength(0);
    expect(useUpdater.getState().phase).toBe("idle");
  });

  it("maybeAutoCheck：24 小時內檢查過、關掉自動檢查、dev、debug build 都不連線", async () => {
    const now = Date.UTC(2026, 9, 3, 12);
    const withUpdater = (patch: Partial<typeof DEFAULT_SETTINGS.updater>) =>
      useSettings.setState({ s: { ...useSettings.getState().s, updater: { ...DEFAULT_SETTINGS.updater, ...patch } } });

    withUpdater({ last_update_check: now - 60 * 60 * 1000 });
    expect(await maybeAutoCheck({ now, dev: false })).toBe(false);
    withUpdater({ auto_check_updates: false });
    expect(await maybeAutoCheck({ now, dev: false })).toBe(false);
    withUpdater({});
    expect(await maybeAutoCheck({ now, dev: true })).toBe(false);
    status = { ...ENABLED, devBuild: true };
    expect(await maybeAutoCheck({ now, dev: false })).toBe(false);
    expect(calls("update_check")).toHaveLength(0);

    status = ENABLED;
    withUpdater({ last_update_check: now - 25 * 60 * 60 * 1000 });
    expect(await maybeAutoCheck({ now, dev: false })).toBe(true);
    expect(calls("update_check")).toHaveLength(1);
  });

  it("installUpdater：啟動後約 10 秒才檢查（不擋啟動），之後每小時再看一次節流", async () => {
    vi.useFakeTimers();
    const stop = installUpdater({ dev: false });
    expect(installUpdater({ dev: false })).toBeTypeOf("function"); // StrictMode 雙 mount：第二次不重排
    await vi.advanceTimersByTimeAsync(9_000);
    expect(calls("update_check")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(calls("update_check")).toHaveLength(1));
    await flush();
    expect(useSettings.getState().s.updater.last_update_check).toBeGreaterThan(0);
    // 一小時後再看一次：剛剛成功檢查過（last_update_check 有記），節流擋下
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await flush();
    expect(calls("updater_status").length).toBeGreaterThanOrEqual(3);
    expect(calls("update_check")).toHaveLength(1);
    stop();
  });
});

describe("手動檢查（說明 › 檢查更新…）", () => {
  it("已是最新 → toast；有新版 → 開更新對話框；失敗 → toast 錯誤並留在 error", async () => {
    await checkForUpdatesManually();
    expect(toast.success).toHaveBeenCalledWith("已是最新版本（v0.0.7）");

    checkReply = async () => V8;
    await checkForUpdatesManually();
    expect(openDialog).toHaveBeenCalledWith("update");

    checkReply = async () => {
      throw { kind: "invalid", code: "ERR_INVALID", message: "更新伺服器回應 404 Not Found" };
    };
    await checkForUpdatesManually();
    expect(toast.error).toHaveBeenCalledWith("檢查更新失敗：更新伺服器回應 404 Not Found");
    expect(useUpdater.getState()).toMatchObject({ phase: "error", error: "更新伺服器回應 404 Not Found" });
  });

  it("停用時講原因，不連線", async () => {
    status = NO_KEY;
    await checkForUpdatesManually();
    expect(toast.info).toHaveBeenCalledWith("自動更新已停用：這個版本還沒有設定更新簽章的公鑰，無法驗證更新檔");
    expect(calls("update_check")).toHaveLength(0);
  });

  it("下載中再按檢查：不另外連線，直接打開對話框看進度", async () => {
    useUpdater.setState({ phase: "downloading", update: V8 });
    const r = await checkForUpdatesManually();
    expect(r.kind).toBe("busy");
    expect(calls("update_check")).toHaveLength(0);
    expect(openDialog).toHaveBeenCalledWith("update");
  });
});

describe("安裝", () => {
  beforeEach(() => {
    useUpdater.setState({ status: ENABLED, phase: "available", update: V8 });
  });

  it("有工作在跑：拒絕並說明，完全不碰 Rust 的下載與安裝", async () => {
    useJobs.getState().upsert({ id: "job-1", kind: "export", status: "running" });
    await useUpdater.getState().install();
    expect(toast.error).toHaveBeenCalledWith("還有 1 個工作在執行或排隊：等它們完成（或取消）之後再安裝更新");
    expect(calls("update_download")).toHaveLength(0);
    expect(calls("update_install")).toHaveLength(0);
    expect(useUpdater.getState().phase).toBe("available");
  });

  it("引擎回報有工作 / 引擎環境安裝中：一樣擋", () => {
    useEngine.setState({ info: { state: "ready", pid: 1, hello: null, last_exc: null, restarts: 0, queued: ["a"], running: ["b"] } });
    expect(guardInput()).toMatchObject({ engineRunning: 1, engineQueued: 1, activeJobs: 0 });
    useEngine.setState({ pyenv: { state: "installing", python: null, torch: null, cuda: false, mps: false, backend: null, device: null, arch: [], lock_ok: false, message: "" } });
    expect(guardInput().pyenvInstalling).toBe(true);
  });

  it("專案沒存：下載完才問；按取消就不裝，停在 ready（安裝檔留著）", async () => {
    project.dirty = true;
    uiConfirm.mockResolvedValue(false);
    await useUpdater.getState().install();
    expect(calls("update_download")).toHaveLength(1);
    expect(uiConfirm).toHaveBeenCalledTimes(1);
    expect(saveProject).not.toHaveBeenCalled();
    expect(calls("update_install")).toHaveLength(0);
    expect(useUpdater.getState().phase).toBe("ready");
  });

  it("專案沒存：按「儲存後安裝」但沒存成（取消另存 / 寫檔失敗）→ 不裝", async () => {
    project.dirty = true;
    uiConfirm.mockResolvedValue(true);
    saveProject.mockResolvedValue(undefined); // 存檔失敗時 saveProject 自己 toast，dirty 還是 true
    await useUpdater.getState().install();
    expect(saveProject).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith("專案沒有儲存，先不安裝更新");
    expect(calls("update_install")).toHaveLength(0);
    expect(useUpdater.getState().phase).toBe("ready");
  });

  it("下載途中又改了專案（在背景繼續之後回去編輯）：下載完才問，存好才裝", async () => {
    let finish!: (v: DownloadOutcome) => void;
    downloadReply = () => new Promise<DownloadOutcome>((r) => (finish = r));
    uiConfirm.mockResolvedValue(true);
    saveProject.mockImplementation(async () => {
      project.dirty = false;
    });
    const done = useUpdater.getState().install();
    await vi.waitFor(() => expect(calls("update_download")).toHaveLength(1));
    expect(uiConfirm).not.toHaveBeenCalled();
    project.dirty = true; // 下載中編輯
    finish({ canceled: false });
    await done;
    expect(uiConfirm).toHaveBeenCalledTimes(1);
    expect(saveProject).toHaveBeenCalledTimes(1);
    expect(calls("update_install")).toHaveLength(1);
  });

  it("下載途中開始了工作：下載完再擋，停在 ready、不呼叫安裝", async () => {
    let finish!: (v: DownloadOutcome) => void;
    downloadReply = () => new Promise<DownloadOutcome>((r) => (finish = r));
    const done = useUpdater.getState().install();
    await vi.waitFor(() => expect(calls("update_download")).toHaveLength(1));
    useJobs.getState().upsert({ id: "job-2", kind: "export", status: "running" });
    finish({ canceled: false });
    await done;
    expect(toast.error).toHaveBeenCalledWith("還有 1 個工作在執行或排隊：等它們完成（或取消）之後再安裝更新");
    expect(calls("update_install")).toHaveLength(0);
    expect(useUpdater.getState().phase).toBe("ready");
  });

  it("下載完時對話框關著（在背景繼續）：不自己裝，把對話框叫回來停在 ready；之後按安裝才裝、不重新下載", async () => {
    dialogOpen = false;
    await useUpdater.getState().install();
    expect(useUpdater.getState().phase).toBe("ready");
    expect(openDialog).toHaveBeenCalledWith("update");
    expect(calls("update_install")).toHaveLength(0);

    dialogOpen = true;
    await useUpdater.getState().install();
    expect(calls("update_download")).toHaveLength(1);
    expect(calls("update_install")).toHaveLength(1);
    expect(useUpdater.getState().phase).toBe("restarting");
  });

  it("進度事件更新畫面；遲到的事件不會把 ready 蓋回去；macOS / Linux 裝完 relaunch()", async () => {
    let finishDownload!: (v: DownloadOutcome) => void;
    downloadReply = () => new Promise<DownloadOutcome>((r) => (finishDownload = r));
    let release!: (v: InstallOutcome) => void;
    installReply = () => new Promise<InstallOutcome>((r) => (release = r));
    const done = useUpdater.getState().install();
    await vi.waitFor(() => expect(calls("update_download")).toHaveLength(1));
    expect(useUpdater.getState().phase).toBe("downloading");

    const emit = listeners.get("update-progress");
    expect(emit).toBeTypeOf("function");
    emit!({ payload: { phase: "downloading", downloaded: 30, total: 120 } });
    expect(useUpdater.getState()).toMatchObject({ phase: "downloading", progress: { downloaded: 30, total: 120 } });
    emit!({ payload: { phase: "verifying", downloaded: 120, total: 120 } });
    expect(useUpdater.getState().phase).toBe("verifying");

    finishDownload({ canceled: false });
    await vi.waitFor(() => expect(calls("update_install")).toHaveLength(1));
    expect(useUpdater.getState().phase).toBe("installing");
    emit!({ payload: { phase: "installing", downloaded: 120, total: 120 } });
    expect(useUpdater.getState().phase).toBe("installing");

    release({ restartRequired: true });
    await done;
    expect(useUpdater.getState().phase).toBe("restarting");
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(listeners.has("update-progress")).toBe(false);
  });

  it("事件比指令的回覆晚到：遲到的 verifying 不會把 ready 蓋回去", async () => {
    dialogOpen = false;
    let finish!: (v: DownloadOutcome) => void;
    downloadReply = () => new Promise<DownloadOutcome>((r) => (finish = r));
    const done = useUpdater.getState().install();
    await vi.waitFor(() => expect(calls("update_download")).toHaveLength(1));
    const emit = listeners.get("update-progress")!;
    finish({ canceled: false });
    await vi.waitFor(() => expect(useUpdater.getState().phase).toBe("ready"));
    emit({ payload: { phase: "verifying", downloaded: 120, total: 120 } });
    expect(useUpdater.getState().phase).toBe("ready");
    await done;
  });

  it("取消下載：Rust 回 canceled → 回到 available，不裝、不算錯誤", async () => {
    let finish!: (v: DownloadOutcome) => void;
    downloadReply = () => new Promise<DownloadOutcome>((r) => (finish = r));
    const done = useUpdater.getState().install();
    await vi.waitFor(() => expect(calls("update_download")).toHaveLength(1));
    await useUpdater.getState().cancelDownload();
    expect(calls("update_cancel")).toHaveLength(1);
    finish({ canceled: true });
    await done;
    expect(useUpdater.getState()).toMatchObject({ phase: "available", update: V8, error: null, progress: null });
    expect(calls("update_install")).toHaveLength(0);
    // 沒在下載時按取消：不打 Rust
    await useUpdater.getState().cancelDownload();
    expect(calls("update_cancel")).toHaveLength(1);
  });

  it("安裝失敗：error 帶原因、update 留著（可以重試）；重試時不必重新檢查", async () => {
    installReply = async () => {
      throw { kind: "invalid", code: "ERR_INVALID", message: "還有 1 個引擎請求在等回覆（例如 AI 助手）：等它完成再安裝更新" };
    };
    await useUpdater.getState().install();
    expect(useUpdater.getState()).toMatchObject({ phase: "error", update: V8, error: "還有 1 個引擎請求在等回覆（例如 AI 助手）：等它完成再安裝更新" });
    expect(relaunch).not.toHaveBeenCalled();

    installReply = async () => ({ restartRequired: true });
    await useUpdater.getState().install();
    expect(calls("update_install")).toHaveLength(2);
    expect(calls("update_check")).toHaveLength(0);
    expect(useUpdater.getState().phase).toBe("restarting");
  });

  it("下載失敗（簽章驗不過）：error 帶原因，不呼叫安裝", async () => {
    downloadReply = async () => {
      throw { kind: "invalid", code: "ERR_INVALID", message: "更新檔的簽章驗證失敗，不安裝（The signature verification failed）" };
    };
    await useUpdater.getState().install();
    expect(useUpdater.getState()).toMatchObject({ phase: "error", update: V8, error: "更新檔的簽章驗證失敗，不安裝（The signature verification failed）" });
    expect(calls("update_install")).toHaveLength(0);
  });

  it("裝好了但 relaunch 失敗：講清楚要自己重開", async () => {
    relaunch.mockRejectedValue(new Error("permission denied"));
    await useUpdater.getState().install();
    expect(useUpdater.getState().phase).toBe("restarting");
    expect(useUpdater.getState().error).toContain("permission denied");
  });

  it("下載 / 安裝中：再按安裝、略過都不理", async () => {
    useUpdater.setState({ phase: "downloading" });
    await useUpdater.getState().install();
    await useUpdater.getState().skip();
    expect(calls("update_download")).toHaveLength(0);
    expect(calls("update_install")).toHaveLength(0);
    expect(savedSettings).toHaveLength(0);
  });

  it("ready 時連按兩次安裝（第一次還在問存檔）：只跑一輪", async () => {
    useUpdater.setState({ phase: "ready" });
    project.dirty = true;
    let answer!: (ok: boolean) => void;
    uiConfirm.mockImplementation(() => new Promise<boolean>((r) => (answer = r)));
    saveProject.mockImplementation(async () => {
      project.dirty = false;
    });
    const first = useUpdater.getState().install();
    await vi.waitFor(() => expect(uiConfirm).toHaveBeenCalledTimes(1));
    await useUpdater.getState().install();
    answer(true);
    await first;
    expect(uiConfirm).toHaveBeenCalledTimes(1);
    expect(calls("update_download")).toHaveLength(0);
    expect(calls("update_install")).toHaveLength(1);
  });

  it("已下載（ready）時背景檢查到同一版：維持 ready，不打回「還要下載」", async () => {
    useUpdater.setState({ phase: "ready" });
    checkReply = async () => V8;
    await useUpdater.getState().check({ silent: true });
    expect(useUpdater.getState().phase).toBe("ready");
  });
});

describe("略過這個版本", () => {
  it("記進設定、關掉對話框、狀態列的提示消失", async () => {
    useUpdater.setState({ status: ENABLED, phase: "available", update: V8 });
    await useUpdater.getState().skip();
    expect(useSettings.getState().s.updater.skipped_update_version).toBe("0.0.8");
    expect((savedSettings[savedSettings.length - 1] as { updater: { skipped_update_version: string } }).updater.skipped_update_version).toBe("0.0.8");
    expect(useUpdater.getState()).toMatchObject({ phase: "idle", update: null });
    expect(closeDialog).toHaveBeenCalledWith("update");
  });
});
