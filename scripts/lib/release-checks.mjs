// 發版腳本的小規則（純函式，src/updater/releaseChecks.test.ts 釘住）：scripts/release-local.mjs、build-engine-wheel.mjs 共用。
//
// - classifySigningKey：TAURI_SIGNING_PRIVATE_KEY 是「金鑰內容」還是「檔案路徑」。**正面認內容**（base64 解開是 minisign 框），
//   其餘才當路徑 —— 反過來猜（「短、沒換行、有斜線就是路徑」）會把真的金鑰內容當路徑，再在「檔案不存在」的錯誤訊息裡整串印出來。
// - sameRepo / urlPointsAtRepo：GitHub 的 owner/name 不分大小寫；「私有建置不准發到公開 repo」的守門要用同一套比法。
// - pep440Version：App 的 semver 版號在 wheel 檔名裡的寫法（setuptools 會正規化）。

/** minisign 金鑰 / 簽章框的第一行開頭（`tauri signer generate` 的私鑰檔是這個框的 base64）。 */
const MINISIGN_BOX = "untrusted comment:";

/**
 * TAURI_SIGNING_PRIVATE_KEY 的值是什麼。回 `{ kind: "empty" }`、`{ kind: "content" }` 或 `{ kind: "path", path }`。
 * 內容的兩種形狀都認：tauri 的單行 base64（解開是 minisign 框），以及直接貼上的兩行 minisign 框。
 */
export function classifySigningKey(value) {
  const v = String(value ?? "").trim();
  if (!v) return { kind: "empty" };
  if (v.includes("\n") || v.startsWith(MINISIGN_BOX)) return { kind: "content" };
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, "base64").toString("utf8").startsWith(MINISIGN_BOX)) return { kind: "content" };
  return { kind: "path", path: v };
}

/**
 * 「檔案不存在」的錯誤訊息裡能不能把值印出來：只有明顯是金鑰檔路徑（`.key` 結尾、看不出是金鑰內容）才印。
 * 其他情況一律不印 —— 寧可少一點線索，也不要把一把私鑰留在終端機捲動紀錄或 CI log 裡。
 */
export function printableKeyPath(value) {
  const c = classifySigningKey(value);
  return c.kind === "path" && /\.key$/i.test(c.path) && c.path.length < 512 ? c.path : null;
}

/** 兩個 GitHub owner/name 是不是同一個 repo（不分大小寫）。任一邊不是字串就是 false。 */
export function sameRepo(a, b) {
  return typeof a === "string" && typeof b === "string" && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** 網址是不是指到 github.com 上的這個 repo（含 Release 下載網址；主機與路徑都不分大小寫）。 */
export function urlPointsAtRepo(url, repo) {
  if (typeof repo !== "string" || !repo.includes("/")) return false;
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return false;
  const path = decodeURIComponent(u.pathname).toLowerCase().replace(/\/+$/, "");
  const want = `/${repo.trim().toLowerCase()}`;
  return path === want || path.startsWith(`${want}/`);
}

/** sync-version.mjs 准的版號：X.Y.Z，或帶 `-alpha[.N]` / `-beta[.N]` / `-rc[.N]` 的預先發布版（其他後綴 wheel 版號對不上）。 */
export const APP_VERSION_RE = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)(?:\.\d+)?)?$/;

/**
 * App 的 semver 版號 → PEP 440（wheel 檔名裡的寫法）：`0.0.8-beta.1` → `0.0.8b1`、`-alpha.2` → `a2`、`-rc.1` → `rc1`、
 * 沒寫數字是 0。已經是 PEP 440 的原樣回（冪等）。與 Rust 的 `pyenv::py_version` 同一套。
 */
export function pep440Version(v) {
  const s = String(v ?? "").trim().toLowerCase();
  const m = /^(\d+\.\d+\.\d+)-(alpha|a|beta|b|rc|c)(?:\.(\d+))?$/.exec(s);
  if (!m) return s;
  const tag = { alpha: "a", a: "a", beta: "b", b: "b", rc: "rc", c: "rc" }[m[2]];
  return `${m[1]}${tag}${Number(m[3] ?? 0)}`;
}
