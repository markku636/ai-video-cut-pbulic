// 自動更新的純規則：背景檢查節流、更新來源網址（與 Rust check_url_policy 同一組案例）、安裝前守門、顯示格式。
import { describe, expect, it } from "vitest";
import { AUTO_CHECK_INTERVAL_MS, disabledReason, endpointProblem, formatBytes, installBlocker, progressPct, releaseDate, shouldAutoCheck } from "./policy";

// 假翻譯：加前綴並做佔位符取代，確認文字真的經過呼叫端的 t
const t = (zh: string, params?: Readonly<Record<string, string | number>>) => `T:${zh.replace(/\{(\w+)\}/g, (w, k: string) => (params && k in params ? String(params[k]) : w))}`;

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const base = { dev: false, enabled: true, autoCheck: true, lastCheck: 0, now: NOW };

describe("shouldAutoCheck：背景檢查一天最多一次", () => {
  it("從沒檢查過 → 檢查；24 小時內檢查過 → 不檢查；滿 24 小時 → 檢查", () => {
    expect(shouldAutoCheck(base)).toBe(true);
    expect(shouldAutoCheck({ ...base, lastCheck: NOW - 60_000 })).toBe(false);
    expect(shouldAutoCheck({ ...base, lastCheck: NOW - AUTO_CHECK_INTERVAL_MS + 1 })).toBe(false);
    expect(shouldAutoCheck({ ...base, lastCheck: NOW - AUTO_CHECK_INTERVAL_MS })).toBe(true);
    expect(shouldAutoCheck({ ...base, lastCheck: NOW - 3 * AUTO_CHECK_INTERVAL_MS })).toBe(true);
  });
  it("關掉自動檢查、停用（沒公鑰 / 沒來源）、dev → 一律不檢查", () => {
    expect(shouldAutoCheck({ ...base, autoCheck: false })).toBe(false);
    expect(shouldAutoCheck({ ...base, enabled: false })).toBe(false);
    expect(shouldAutoCheck({ ...base, dev: true })).toBe(false);
  });
  it("記錄的時間在未來（時鐘被往回調）或壞掉：不能因此好幾天都不檢查", () => {
    expect(shouldAutoCheck({ ...base, lastCheck: NOW + 5 * AUTO_CHECK_INTERVAL_MS })).toBe(true);
    expect(shouldAutoCheck({ ...base, lastCheck: Number.NaN })).toBe(true);
    expect(shouldAutoCheck({ ...base, lastCheck: -5 })).toBe(true);
    // 一分鐘內的誤差不算未來（兩台機器的時鐘差一點點）
    expect(shouldAutoCheck({ ...base, lastCheck: NOW + 30_000 })).toBe(false);
  });
});

describe("endpointProblem：https 一律可以，http 只准本機", () => {
  it("可以的網址（空字串＝用內建來源）", () => {
    for (const ok of [
      "",
      "   ",
      "https://github.com/markku636/ai-video-cut-pbulic/releases/latest/download/latest.json",
      "https://example.com/aivc/{{target}}/{{arch}}/{{current_version}}",
      "http://localhost:8000/latest.json",
      "http://LOCALHOST/latest.json",
      "http://127.0.0.1:8080/latest.json",
      "http://127.0.0.2/x.json",
      "http://[::1]:9000/latest.json",
    ]) {
      expect(endpointProblem(ok, t), ok).toBeNull();
    }
  });
  it("不行的網址：說得出為什麼", () => {
    expect(endpointProblem("http://example.com/latest.json", t)).toMatch(/^T:只接受 https（http/);
    expect(endpointProblem("http://10.0.0.5/latest.json", t)).toMatch(/^T:只接受 https（http/);
    expect(endpointProblem("http://localhost.example.com/latest.json", t)).toMatch(/^T:只接受 https（http/);
    expect(endpointProblem("ftp://example.com/latest.json", t)).toBe("T:只接受 https 網址");
    expect(endpointProblem("file:///C:/latest.json", t)).toBe("T:只接受 https 網址");
    expect(endpointProblem("https://user:pw@example.com/latest.json", t)).toBe("T:網址不能含帳號或密碼");
    expect(endpointProblem("https://token@example.com/latest.json", t)).toBe("T:網址不能含帳號或密碼");
    expect(endpointProblem("not a url", t)).toBe("T:不是有效的網址");
  });
});

describe("installBlocker：有工作在跑就不裝", () => {
  const idle = { activeJobs: 0, engineRunning: 0, engineQueued: 0, pyenvInstalling: false };
  it("什麼都沒在跑 → 可以裝", () => {
    expect(installBlocker(idle, t)).toBeNull();
  });
  it("前端的工作、引擎回報的工作取較大的那個數字講", () => {
    expect(installBlocker({ ...idle, activeJobs: 2 }, t)).toBe("T:還有 2 個工作在執行或排隊：等它們完成（或取消）之後再安裝更新");
    expect(installBlocker({ ...idle, engineRunning: 1, engineQueued: 2 }, t)).toContain("還有 3 個工作");
    expect(installBlocker({ ...idle, activeJobs: 1, engineRunning: 1 }, t)).toContain("還有 1 個工作");
  });
  it("引擎環境正在安裝：優先講這個", () => {
    expect(installBlocker({ ...idle, activeJobs: 1, pyenvInstalling: true }, t)).toBe("T:引擎環境正在安裝：等它裝完再更新 App");
  });
});

describe("disabledReason", () => {
  it("認得的代碼翻成人話；認不得的退回 Rust 給的原文", () => {
    expect(disabledReason({ reasonCode: "no_pubkey", reason: "x" }, t)).toBe("T:這個版本還沒有設定更新簽章的公鑰，無法驗證更新檔");
    expect(disabledReason({ reasonCode: "no_endpoint", reason: "x" }, t)).toContain("私有建置");
    expect(disabledReason({ reasonCode: "bad_endpoint", reason: "x" }, t)).toContain("https");
    expect(disabledReason({ reasonCode: "something_new", reason: "Rust 的原文" }, t)).toBe("Rust 的原文");
    expect(disabledReason({ reasonCode: null, reason: null }, t)).toBe("T:自動更新已停用");
  });
});

describe("顯示格式", () => {
  it("formatBytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(56.4 * 1024 * 1024)).toBe("56.4 MB");
    expect(formatBytes(Number.NaN)).toBe("0 B");
  });
  it("progressPct：沒有總量 → null（進度條改不確定樣式），夾在 0–100", () => {
    expect(progressPct({ downloaded: 50, total: 200 })).toBe(25);
    expect(progressPct({ downloaded: 300, total: 200 })).toBe(100);
    expect(progressPct({ downloaded: 5, total: null })).toBeNull();
    expect(progressPct({ downloaded: 5, total: 0 })).toBeNull();
    expect(progressPct(null)).toBeNull();
  });
  it("releaseDate：RFC 3339 → 本地日期；壞掉的不顯示", () => {
    expect(releaseDate("2026-10-03T12:00:00Z")).toMatch(/^2026-10-0[34]$/);
    expect(releaseDate(null)).toBeNull();
    expect(releaseDate("not a date")).toBeNull();
  });
});
