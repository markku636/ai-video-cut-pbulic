import { create } from "zustand";
import { api, errMessage } from "../api";
import { saveProject } from "../commands/appActions";
import { t } from "../i18n";
import { closeDialog, isDialogOpen, openDialog } from "../store/dialogs";
import { useEngine } from "../store/engine";
import { useJobs } from "../store/jobs";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { toast, uiConfirm } from "../ui";
import { listenUpdateProgress, updaterApi, type UpdateInfo, type UpdateProgress, type UpdaterStatus } from "./api";
import { CHECK_TIMEOUT_MS, FIRST_CHECK_DELAY_MS, RECHECK_TICK_MS, disabledReason, installBlocker, shouldAutoCheck, type InstallGuardInput } from "./policy";

/**
 * 自動更新的狀態機（App 層、不進專案檔、不進 undo）。
 *
 *   idle ──check──▶ checking ──▶ upToDate | available | error
 *   available ──install──▶ downloading ──▶ verifying ──▶ ready ──（守門、問存檔）──▶ installing ──▶（Windows：App 結束，安裝程式裝完重開）
 *        ▲                      │ 取消下載                                                     └──▶ restarting（macOS / Linux：relaunch()）
 *        └──────────────────────┘
 *   任何一步失敗 ──▶ error（update 還在：可以重試；已下載的安裝檔 Rust 留著，重試不必重新下載）
 *
 * - 背景檢查（`installUpdater`）：啟動後約 10 秒、之後每小時看一次「該不該檢查」；成功檢查過的 24 小時內不再連線。
 *   失敗一律安靜（只寫 log），使用者略過的版本不提示，dev / debug build 不檢查。
 * - 手動檢查（說明 › 檢查更新…、設定 › 更新）：已是最新 / 失敗都跳 toast，有新版直接開更新對話框。
 * - 安裝前的守門：有工作在跑 → 拒絕並說明；專案有未存的變更 → 問要不要先存（存好才裝，沒存成就不裝）。
 *   下載要好幾分鐘，使用者會按「在背景繼續」回去編輯，所以**下載完才守門、才問存檔**（`applyDownloaded`）：
 *   對話框還開著就接著問；關掉了（在背景）就把對話框叫回來停在 ready，讓使用者自己按安裝 —— 絕不在他編輯到一半時自己關掉 App。
 */
export type UpdatePhase =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "verifying"
  /** 下載完、驗過簽章，等使用者確認安裝。 */
  | "ready"
  | "installing"
  | "restarting"
  | "error";

export type CheckOutcome =
  | { kind: "available"; info: UpdateInfo }
  /** 背景檢查找到的是使用者略過的版本：不提示。 */
  | { kind: "skipped"; info: UpdateInfo }
  | { kind: "upToDate" }
  | { kind: "disabled"; reason: string }
  | { kind: "error"; message: string }
  /** 正在下載 / 安裝：不另外檢查。 */
  | { kind: "busy" };

interface UpdaterStore {
  status: UpdaterStatus | null;
  phase: UpdatePhase;
  /** 找到的新版（available 之後一路帶著，直到略過或發現已是最新）。 */
  update: UpdateInfo | null;
  progress: UpdateProgress | null;
  error: string | null;
  loadStatus: () => Promise<UpdaterStatus | null>;
  /** `silent`：背景檢查 —— 不切到 checking、失敗不吵、略過的版本不提示。 */
  check: (opts?: { silent?: boolean }) => Promise<CheckOutcome>;
  /** 下載（還沒下載的話）→ 守門、問存檔 → 安裝。ready 時直接從守門開始。 */
  install: () => Promise<void>;
  /** 取消進行中的下載（安裝階段不能取消）。 */
  cancelDownload: () => Promise<void>;
  /** 「略過這個版本」：記進設定，背景檢查不再提示這一版。 */
  skip: () => Promise<void>;
}

const BUSY: ReadonlySet<UpdatePhase> = new Set(["downloading", "verifying", "installing", "restarting"]);
const DOWNLOADING: ReadonlySet<UpdatePhase> = new Set(["downloading", "verifying"]);

export function isBusy(phase: UpdatePhase): boolean {
  return BUSY.has(phase);
}

function log(msg: string): void {
  void api.clientLog(`[updater] ${msg}`).catch(() => {});
}

/** 只有成功的檢查才記時間：離線時開 App，下次開還會再試，不必等一天。 */
async function recordCheck(now: number): Promise<void> {
  const st = useSettings.getState();
  await st.save({ updater: { ...st.s.updater, last_update_check: now } });
}

export function guardInput(): InstallGuardInput {
  const active = useJobs.getState().jobs.filter((j) => j.status === "queued" || j.status === "running").length;
  const eng = useEngine.getState();
  return { activeJobs: active, engineRunning: eng.info?.running.length ?? 0, engineQueued: eng.info?.queued.length ?? 0, pyenvInstalling: eng.pyenv?.state === "installing" };
}

/** 安裝會關掉 App：專案有未存的變更就先問；按了「儲存後安裝」但沒存成（取消另存、寫檔失敗）就不裝。 */
async function ensureSaved(): Promise<boolean> {
  if (!useProject.getState().dirty) return true;
  const ok = await uiConfirm(t("專案有未儲存的變更。安裝更新會關閉 App，要先儲存嗎？"), { title: t("安裝更新"), confirmText: t("儲存後安裝") });
  if (!ok) return false;
  // 跟「檔案 › 儲存專案」同一條路：沒有路徑的專案會跳另存對話框，存檔失敗由它自己 toast
  await saveProject();
  if (useProject.getState().dirty) {
    toast.error(t("專案沒有儲存，先不安裝更新"));
    return false;
  }
  return true;
}

/**
 * 下載好、驗過簽章之後才做的事：再守門一次（下載的這幾分鐘裡可能又開始了工作、又改了專案）、問存檔，都過了才裝。
 * 沒過就停在 ready（安裝檔 Rust 留著），使用者處理好再按一次「安裝並重新啟動」。失敗丟給 install() 的 catch。
 */
async function applyDownloaded(): Promise<void> {
  const why = installBlocker(guardInput(), t);
  if (why) {
    toast.error(why);
    return;
  }
  if (!(await ensureSaved())) return;
  const size = useUpdater.getState().progress?.total ?? null;
  useUpdater.setState({ phase: "installing", progress: { phase: "installing", downloaded: size ?? 0, total: size }, error: null });
  const r = await updaterApi.install();
  // Windows 走不到這裡：安裝程式接手後 App 就結束了，裝完由安裝程式重開
  if (r.restartRequired) {
    useUpdater.setState({ phase: "restarting" });
    try {
      await updaterApi.relaunch();
    } catch (e) {
      useUpdater.setState({ error: t("更新已安裝，但沒能自動重新啟動：請自己關掉再打開 App（{msg}）", { msg: errMessage(e) }) });
    }
  }
}

export const useUpdater = create<UpdaterStore>((set, get) => ({
  status: null,
  phase: "idle",
  update: null,
  progress: null,
  error: null,

  loadStatus: async () => {
    try {
      const status = await updaterApi.status();
      set({ status });
      return status;
    } catch (e) {
      // 非 Tauri 環境（vite preview）或舊版 Rust：當作沒有自動更新
      log(`status 失敗：${errMessage(e)}`);
      return null;
    }
  },

  check: async (opts = {}) => {
    const silent = !!opts.silent;
    if (BUSY.has(get().phase)) return { kind: "busy" };
    // 每次都重新問狀態：覆寫網址可能剛在設定頁改過
    const status = await get().loadStatus();
    if (!status || !status.enabled) {
      const reason = status ? disabledReason(status, t) : t("自動更新已停用");
      if (!silent) set({ phase: "error", error: reason });
      return { kind: "disabled", reason };
    }
    const before = get().phase;
    if (!silent) set({ phase: "checking", error: null });
    try {
      const info = await updaterApi.check(CHECK_TIMEOUT_MS);
      void recordCheck(Date.now()).catch(() => {});
      if (!info) {
        set({ phase: "upToDate", update: null, error: null, progress: null });
        return { kind: "upToDate" };
      }
      const skipped = useSettings.getState().s.updater.skipped_update_version;
      if (silent && skipped && skipped === info.version) {
        log(`v${info.version} 已被略過，不提示`);
        set({ phase: "idle", update: null, error: null });
        return { kind: "skipped", info };
      }
      // 同一版已經下載好了（ready）：背景檢查不要把它打回「還要下載」
      const keepReady = get().phase === "ready" && get().update?.version === info.version;
      set({ phase: keepReady ? "ready" : "available", update: info, error: null, ...(keepReady ? {} : { progress: null }) });
      return { kind: "available", info };
    } catch (e) {
      const message = errMessage(e);
      if (silent) {
        log(`背景檢查失敗：${message}`);
        // 背景檢查不改畫面：回到檢查前的樣子（例如本來就有一個可安裝的版本）
        if (get().phase === "checking") set({ phase: before });
        return { kind: "error", message };
      }
      set({ phase: "error", error: message });
      return { kind: "error", message };
    }
  },

  install: async () => {
    const { update, phase } = get();
    // ready 時問存檔的那段 phase 還不是 BUSY：連按兩次不能跑出兩輪（第二輪會撞上 Rust 的「已經在安裝」變成錯誤）
    if (!update || BUSY.has(phase) || installRunning) return;
    installRunning = true;
    try {
      await runInstall(phase);
    } finally {
      installRunning = false;
    }
  },

  cancelDownload: async () => {
    if (!DOWNLOADING.has(get().phase)) return;
    try {
      await updaterApi.cancel();
    } catch (e) {
      log(`取消下載失敗：${errMessage(e)}`);
    }
  },

  skip: async () => {
    const { update, phase } = get();
    if (!update || BUSY.has(phase)) return;
    const st = useSettings.getState();
    await st.save({ updater: { ...st.s.updater, skipped_update_version: update.version } });
    set({ phase: "idle", update: null, error: null, progress: null });
    closeDialog("update");
    toast.info(t("已略過 v{version}：之後的自動檢查不會再提示這一版", { version: update.version }));
  },
}));

/** 同一時間只跑一輪 install（見 install 的註解）。 */
let installRunning = false;

async function runInstall(phase: UpdatePhase): Promise<void> {
  const set = useUpdater.setState;
  const get = useUpdater.getState;
  const why = installBlocker(guardInput(), t);
  if (why) {
    toast.error(why);
    return;
  }
  // 事件可能比指令的回覆晚到：只在下載 / 安裝中才收，免得一個遲到的 verifying 把 ready 蓋回去
  const un = await listenUpdateProgress((p) => {
    if (BUSY.has(get().phase)) set({ progress: p, phase: p.phase });
  }).catch(() => null);
  try {
    if (phase !== "ready") {
      set({ phase: "downloading", progress: { phase: "downloading", downloaded: 0, total: null }, error: null });
      const r = await updaterApi.download();
      if (r.canceled) {
        set({ phase: "available", progress: null, error: null });
        return;
      }
      set({ phase: "ready", error: null });
      // 使用者按了「在背景繼續」：他可能正在編輯，不能自己裝（Windows 的安裝會直接結束 App）。叫回對話框，讓他自己按
      if (!isDialogOpen("update")) {
        openDialog("update");
        return;
      }
    }
    await applyDownloaded();
  } catch (e) {
    set({ phase: "error", error: errMessage(e) });
  } finally {
    un?.();
  }
}

/** 說明 › 檢查更新…、設定頁的「立即檢查」：結果一定要讓人看到（toast 或對話框）。 */
export async function checkForUpdatesManually(): Promise<CheckOutcome> {
  const r = await useUpdater.getState().check({ silent: false });
  switch (r.kind) {
    case "available":
    case "busy":
      openDialog("update");
      break;
    case "upToDate":
      toast.success(t("已是最新版本（v{version}）", { version: useUpdater.getState().status?.currentVersion ?? __APP_VERSION__ }));
      break;
    case "disabled":
      toast.info(t("自動更新已停用：{reason}", { reason: r.reason }));
      break;
    case "error":
      toast.error(t("檢查更新失敗：{msg}", { msg: r.message }));
      break;
  }
  return r;
}

/**
 * 背景檢查的一輪：設定讀到了、沒停用、使用者沒關掉、離上次成功檢查滿 24 小時才真的連線。回 true＝有檢查。
 * `dev` 預設看 vite 的 DEV（`npm run tauri dev`）；Rust 的 debug build 另外由 `status.devBuild` 擋。
 */
export async function maybeAutoCheck(opts: { now?: number; dev?: boolean } = {}): Promise<boolean> {
  await useSettings
    .getState()
    .load()
    .catch(() => {});
  const status = await useUpdater.getState().loadStatus();
  if (!status) return false;
  const s = useSettings.getState().s.updater;
  const go = shouldAutoCheck({
    dev: (opts.dev ?? import.meta.env.DEV) || status.devBuild,
    enabled: status.enabled,
    autoCheck: s.auto_check_updates,
    lastCheck: s.last_update_check,
    now: opts.now ?? Date.now(),
  });
  if (!go) return false;
  await useUpdater.getState().check({ silent: true });
  return true;
}

let installed = false;

/** App 掛載時呼叫一次：排背景檢查（不擋啟動）。回傳拆除函式（StrictMode 的雙 mount 冪等）。`dev` 只給測試覆寫。 */
export function installUpdater(opts: { dev?: boolean } = {}): () => void {
  if (installed) return () => {};
  installed = true;
  const tick = () => void maybeAutoCheck({ dev: opts.dev }).catch((e) => log(`背景檢查例外：${errMessage(e)}`));
  // 全域的 setTimeout（不是 window.）：單元測試跑在 node，假時鐘一樣接得到
  const first = setTimeout(tick, FIRST_CHECK_DELAY_MS);
  const every = setInterval(tick, RECHECK_TICK_MS);
  return () => {
    installed = false;
    clearTimeout(first);
    clearInterval(every);
  };
}
