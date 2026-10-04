import type { Params } from "../i18n";
import type { UpdateProgress, UpdaterStatus } from "./api";

/**
 * 自動更新的規則（純函式，單元測試直接釘）：背景檢查的節流、更新來源網址、安裝前的守門、顯示用的格式。
 *
 * 文字一律由呼叫端傳進來的 `t` 翻（元件裡是 useT() 那一支，切語言才會重繪）；第一個參數直接寫中文字面量，
 * scripts/check-i18n.mjs 才掃得到、漏翻會 exit 1。
 */
export type Translate = (zh: string, params?: Params) => string;

/** 背景檢查：每天最多一次（成功的那一次才算，見 store.ts）。 */
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 啟動後先等這麼久再檢查：讓開檔、偵測引擎、ffmpeg 試編先跑完，不跟它們搶。 */
export const FIRST_CHECK_DELAY_MS = 10_000;
/** App 長時間開著時多久再看一次「該不該檢查」（真正會不會連線由 24 小時節流決定）。 */
export const RECHECK_TICK_MS = 60 * 60 * 1000;
/** 檢查（只抓 latest.json）的整體逾時；下載不設整體逾時（Rust 那邊只限「多久沒收到資料」）。 */
export const CHECK_TIMEOUT_MS = 20_000;

export interface AutoCheckInput {
  /** dev server（import.meta.env.DEV）或 debug build：不檢查（版號對不上 Release，也不能安裝）。 */
  dev: boolean;
  /** `UpdaterStatus.enabled`（公鑰 / 來源都設好了）。 */
  enabled: boolean;
  /** 設定 `updater.auto_check_updates`。 */
  autoCheck: boolean;
  /** 設定 `updater.last_update_check`（Unix 毫秒；0 = 從沒檢查過）。 */
  lastCheck: number;
  now: number;
}

/** 背景檢查要不要跑。 */
export function shouldAutoCheck(i: AutoCheckInput): boolean {
  if (i.dev || !i.enabled || !i.autoCheck) return false;
  if (!Number.isFinite(i.lastCheck) || i.lastCheck <= 0) return true;
  // 記錄的時間在未來（時鐘被往回調、設定檔被手改）：不能因此好幾天都不檢查
  if (i.lastCheck > i.now + 60_000) return true;
  return i.now - i.lastCheck >= AUTO_CHECK_INTERVAL_MS;
}

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * 更新來源網址哪裡不對（與 Rust `updater::check_url_policy` 同一套規則；真正把關的是 Rust，這裡只是讓設定頁當場講）。
 * 空字串＝用內建來源，不算錯。回 null＝可以用。
 */
export function endpointProblem(raw: string, t: Translate): string | null {
  const s = raw.trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return t("不是有效的網址");
  }
  if (u.username || u.password) return t("網址不能含帳號或密碼");
  if (u.protocol === "https:") return u.hostname ? null : t("網址缺主機名稱");
  if (u.protocol === "http:") return isLoopbackHost(u.hostname) ? null : t("只接受 https（http 只准 localhost / 127.0.0.1，給本機測試用）");
  return t("只接受 https 網址");
}

export interface InstallGuardInput {
  /** 前端工作清單裡排隊中 / 執行中的工作（引擎工作、proxy、匯出、引擎安裝…）。 */
  activeJobs: number;
  /** Rust 引擎監督回報的執行中 / 排隊中工作（engine-state 事件）。 */
  engineRunning: number;
  engineQueued: number;
  /** 引擎環境正在安裝（bootstrap 腳本還在跑）。 */
  pyenvInstalling: boolean;
}

/**
 * 安裝前的守門：有工作在跑就不裝（安裝會先停引擎，跑到一半的工作就沒了）。回 null＝可以裝。
 * 下載前、下載完各看一次（store.ts 的 install / applyDownloaded）—— 下載要幾分鐘，這段時間裡可能又開始了工作；
 * Rust 的 `update_install` 舉起更新鎖之後還會再擋一次（連還在等回覆的 AI 助手請求也算）。
 */
export function installBlocker(i: InstallGuardInput, t: Translate): string | null {
  if (i.pyenvInstalling) return t("引擎環境正在安裝：等它裝完再更新 App");
  const n = Math.max(i.activeJobs, i.engineRunning + i.engineQueued);
  if (n > 0) return t("還有 {n} 個工作在執行或排隊：等它們完成（或取消）之後再安裝更新", { n });
  return null;
}

/** 停用原因 → 人話。認不得的代碼退回 Rust 給的原文。 */
export function disabledReason(st: Pick<UpdaterStatus, "reasonCode" | "reason">, t: Translate): string {
  switch (st.reasonCode) {
    case "no_pubkey":
      return t("這個版本還沒有設定更新簽章的公鑰，無法驗證更新檔");
    case "no_endpoint":
      return t("這個版本沒有設定更新來源（例如私有建置）");
    case "no_config":
      return t("這個版本沒有設定自動更新");
    case "bad_config_endpoint":
      return t("內建的更新來源網址不合規定");
    case "bad_endpoint":
      return t("設定裡的更新來源網址不合規定（只接受 https；http 只准 localhost / 127.0.0.1）");
    default:
      return st.reason || t("自動更新已停用");
  }
}

/** 位元組 → 「12.3 MB」（安裝檔幾十 MB，用 MB 一位小數就夠讀）。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** 下載進度百分比（0–100，整數）；不知道總量 → null（進度條改成不確定樣式）。 */
export function progressPct(p: Pick<UpdateProgress, "downloaded" | "total"> | null | undefined): number | null {
  if (!p || !p.total || p.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((p.downloaded / p.total) * 100)));
}

/** latest.json 的 pub_date（RFC 3339）→ 本地日期「2026-10-03」；格式不對就不顯示。 */
export function releaseDate(date: string | null | undefined): string | null {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
