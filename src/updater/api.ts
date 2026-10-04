import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * 自動更新的 Rust 邊界（src-tauri/src/updater.rs；lib.rs 的 invoke_handler 登記了 updater_status / update_check / update_download / update_cancel / update_install）。
 * 跟 src/api.ts 分開放是刻意的：這組指令只有 src/updater/ 用，payload 也是 camelCase（Rust 端 `rename_all = "camelCase"`）；
 * 設定檔裡的那一份（`AppSettings.updater`）才照磁碟格式用 snake_case，型別在 src/api.ts。
 *
 * 前端**不直接用** `@tauri-apps/plugin-updater`：它的 install() 會跳過「先停引擎與 ffmpeg」，capabilities 也沒給 updater 權限。
 * process 外掛只用 relaunch()：macOS / Linux 裝完舊行程還在跑，要自己重啟（Windows 由安裝程式重開）。
 */

/** 停用原因的代碼（`UpdaterStatus.reasonCode`）。 */
export type UpdaterReasonCode = "no_config" | "no_pubkey" | "no_endpoint" | "bad_config_endpoint" | "bad_endpoint";

export interface UpdaterStatus {
  enabled: boolean;
  reasonCode: UpdaterReasonCode | (string & {}) | null;
  /** 停用原因（繁中原文；認不得 reasonCode 時才直接顯示）。 */
  reason: string | null;
  currentVersion: string;
  /** 實際會去問的 latest.json 網址（覆寫或設定檔的第一個）。 */
  endpoint: string | null;
  /** tauri.conf.json 的第一個 endpoint（設定頁的 placeholder）。 */
  defaultEndpoint: string | null;
  /** 正在用設定裡的覆寫網址。 */
  overridden: boolean;
  /** 這個版本接不接受覆寫網址（私有建置是 false：填了也不會用）。 */
  overrideAllowed: boolean;
  /** debug build：不跑背景檢查，安裝會被 Rust 拒絕。 */
  devBuild: boolean;
}

/** `update_check` 找到新版時的回覆。 */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  /** latest.json 的 notes：一律當純文字顯示（不當 HTML / Markdown 解析）。 */
  notes: string | null;
  /** RFC 3339（UTC）。 */
  date: string | null;
}

/** `update-progress` 事件。`verifying` 時還沒驗完簽章：下載完成 ≠ 可以安裝。 */
export interface UpdateProgress {
  phase: "downloading" | "verifying" | "installing";
  downloaded: number;
  /** Content-Length；伺服器沒給就是 null。 */
  total: number | null;
}

export interface DownloadOutcome {
  /** 使用者按了「取消下載」：不是錯誤，回到「有新版本」。 */
  canceled: boolean;
}

export interface InstallOutcome {
  /** macOS / Linux：裝好了，要呼叫 relaunch()。Windows 走不到回覆（App 已被安裝程式接手）。 */
  restartRequired: boolean;
}

export const updaterApi = {
  status: () => invoke<UpdaterStatus>("updater_status"),
  /** 已是最新回 null；停用、連不上、格式不對都會 reject（訊息是 Rust 翻好的人話）。 */
  check: (timeoutMs?: number) => invoke<UpdateInfo | null>("update_check", { timeoutMs: timeoutMs ?? null }),
  /** 下載 → 驗簽，安裝檔留在 Rust（已經下載過同一版就直接回）。不碰引擎、不關 App。 */
  download: () => invoke<DownloadOutcome>("update_download"),
  /** 取消進行中的下載；回 true＝真的叫停了一個下載（安裝階段不能取消）。 */
  cancel: () => invoke<boolean>("update_cancel"),
  /** 停引擎與 ffmpeg → 安裝已下載的那一版（App 會關閉）。有工作在跑、或還沒下載完時 Rust 會拒絕。 */
  install: () => invoke<InstallOutcome>("update_install"),
  relaunch: () => relaunch(),
};

export function listenUpdateProgress(cb: (p: UpdateProgress) => void): Promise<UnlistenFn> {
  return listen<UpdateProgress>("update-progress", (ev) => cb(ev.payload));
}
