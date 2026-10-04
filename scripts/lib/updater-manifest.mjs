// latest.json（tauri-plugin-updater 的「靜態」格式）產生器：scripts/release-local.mjs 與 release.yml 的 publish-release 共用。
//
// 格式（外掛 updater.rs 的 RemoteRelease）：
//   { "version": "0.0.8", "notes": "…", "pub_date": "2026-10-03T12:00:00Z",
//     "platforms": { "windows-x86_64": { "signature": "<.sig 檔的內容>", "url": "https://…/AI.Video.Cut_0.0.8_x64-setup.exe" }, … } }
//
// 踩過 / 查過的規則：
// - signature 是 `.sig` 檔的**內容**（minisign 簽章框的 base64），不是路徑也不是網址；外掛拿它配 tauri.conf.json 的公鑰驗下載到的檔。
// - 外掛找平台時先找 `{os}-{arch}-{bundle}`（windows-x86_64-nsis），再找 `{os}-{arch}`（windows-x86_64）；
//   而且**先找平台、才比版本**：latest.json 缺了某個平台，那個平台連「已是最新」都會變成錯誤。publish 前一定要 `missingPlatforms`。
// - url 用固定 tag 的下載路徑（/releases/download/<tag>/<檔名>）：draft 的 untagged-xxx 網址轉正後就失效，
//   /releases/latest/download/<有版號的檔名> 在下一版發出後也會 404。
// - GitHub 上傳時把檔名裡的空白換成「.」（"AI Video Cut_0.0.8_x64-setup.exe" → "AI.Video.Cut_0.0.8_x64-setup.exe"）：
//   先自己換好再上傳，latest.json 的網址才對得上。
// - pub_date 必須是 RFC 3339，外掛解析失敗整份 latest.json 都不認。
// - App 開了 requireSignedVersion：簽章的 trusted comment 要帶 `version:`（tauri-cli 2.12 起 `tauri build` 自動寫），
//   而且要等於 latest.json 的 version，不然下載完驗簽就被拒。`buildLatestJson` 先擋，不發一份裝不起來的。

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** minisign 簽章檔 base64 解開後的開頭（`tauri signer sign` / `tauri build` 產生的 .sig 都是這個形狀）。 */
const SIG_PREFIX = "untrusted comment:";

/**
 * 安裝檔檔名 → 它服務的 updater 平台鍵（與 tauri-action 產生的 latest.json 同一套）。認不得的檔回空陣列。
 * - Windows NSIS：`*_x64-setup.exe` → windows-x86_64-nsis + windows-x86_64（本專案只出 NSIS，沒有 MSI 跟它搶 windows-x86_64）
 * - macOS：`*.app.tar.gz`（`--bundles app` 才會產生；只出 dmg 的話 macOS 沒有更新檔）→ darwin-<arch>-app + darwin-<arch>
 * - Linux：AppImage → linux-x86_64-appimage + linux-x86_64；deb → linux-x86_64-deb
 */
export function platformKeysForAsset(name) {
  const n = String(name);
  if (/_x64-setup\.exe$/i.test(n)) return ["windows-x86_64-nsis", "windows-x86_64"];
  if (/_arm64-setup\.exe$/i.test(n)) return ["windows-aarch64-nsis", "windows-aarch64"];
  if (/\.app\.tar\.gz$/i.test(n)) {
    if (/aarch64/i.test(n)) return ["darwin-aarch64-app", "darwin-aarch64"];
    if (/x64|x86_64/i.test(n)) return ["darwin-x86_64-app", "darwin-x86_64"];
    return [];
  }
  if (/_amd64\.AppImage$/i.test(n)) return ["linux-x86_64-appimage", "linux-x86_64"];
  if (/_amd64\.deb$/i.test(n)) return ["linux-x86_64-deb"];
  return [];
}

/** GitHub 上傳時會把空白換成「.」：先自己換（見檔頭）。 */
export function githubAssetName(fileName) {
  return String(fileName).replace(/ /g, ".");
}

/** GitHub Release 資產的下載網址（固定 tag 路徑）。 */
export function releaseAssetUrl(repo, tag, assetName) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`repo 要是 owner/name：${repo}`);
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;
}

/** RFC 3339、秒精度、UTC：2026-10-03T12:00:00Z。 */
export function rfc3339(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) throw new Error(`不是有效的時間：${date}`);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 看起來是不是 .sig 檔的內容（base64、解開是 minisign 簽章框）。擋掉「把路徑或網址當簽章」這種一定驗不過的錯。 */
export function isSignatureContent(sig) {
  const s = String(sig ?? "").trim();
  if (!s || !/^[A-Za-z0-9+/=\r\n]+$/.test(s)) return false;
  try {
    return Buffer.from(s, "base64").toString("utf8").startsWith(SIG_PREFIX);
  } catch {
    return false;
  }
}

/**
 * .sig 綁定的版本（trusted comment 裡的 `version:` 欄位；trusted comment 受簽章保護，改了就驗不過）。
 * 沒有這個欄位（tauri-cli 2.12 以前簽的）或不是 .sig 內容 → null。
 */
export function signedVersion(sig) {
  if (!isSignatureContent(sig)) return null;
  const text = Buffer.from(String(sig).trim(), "base64").toString("utf8");
  const line = text.split(/\r?\n/).find((l) => l.startsWith("trusted comment:"));
  if (!line) return null;
  const field = line
    .slice("trusted comment:".length)
    .trim()
    .split("\t")
    .find((f) => f.startsWith("version:"));
  return field ? field.slice("version:".length) : null;
}

/** 更新檔的網址：https，或本機測試伺服器的 http（與 App 的 updater::check_url_policy 同一套）。 */
function urlProblem(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return "不是有效的網址";
  }
  if (u.username || u.password) return "網址不能含帳號或密碼";
  if (u.protocol === "https:") return null;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (u.protocol === "http:" && (host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host))) return null;
  return "App 只接受 https（http 只准 localhost / 127.0.0.1）";
}

/**
 * 組 latest.json。
 * @param {{ version: string, notes?: string, pubDate?: Date | string, assets: { name: string, url: string, signature: string }[] }} input
 *   `assets[].name` 決定平台（`platformKeysForAsset`），`signature` 是 .sig 檔的內容。
 * 版本可以帶 v 前綴（外掛也接受），寫出去一律去掉。任何一項不合規定就丟錯（寧可不發，也不要發一份裝不起來的）。
 */
export function buildLatestJson({ version, notes = "", pubDate = new Date(), assets }) {
  const v = String(version ?? "").replace(/^v/, "");
  if (!SEMVER.test(v)) throw new Error(`版本不是 semver：${version}`);
  if (!Array.isArray(assets) || assets.length === 0) throw new Error("沒有任何更新檔");
  const platforms = {};
  for (const a of assets) {
    const keys = platformKeysForAsset(a.name);
    if (!keys.length) throw new Error(`認不得的更新檔（不知道是哪個平台）：${a.name}`);
    const why = urlProblem(a.url);
    if (why) throw new Error(`${a.name} 的網址 ${a.url}：${why}`);
    if (!isSignatureContent(a.signature)) throw new Error(`${a.name} 的簽章不是 .sig 檔的內容（要貼檔案內容，不是路徑或網址）`);
    const signed = signedVersion(a.signature);
    if (signed === null) throw new Error(`${a.name} 的簽章沒有綁版本（tauri-cli 2.12 以前簽的？App 開了 requireSignedVersion，會拒裝）：用 2.12 以上的 CLI 重建`);
    if (signed.replace(/^v/, "") !== v) throw new Error(`${a.name} 的簽章綁的是 ${signed}，latest.json 寫的是 ${v}：App 會拒裝（拿錯版本的安裝檔？）`);
    for (const k of keys) {
      if (platforms[k]) throw new Error(`平台 ${k} 重複：${platforms[k].url} 與 ${a.url}`);
      platforms[k] = { signature: String(a.signature).trim(), url: a.url };
    }
  }
  return { version: v, notes: String(notes ?? ""), pub_date: rfc3339(pubDate), platforms };
}

/** latest.json 缺了哪些平台（`required` 例：["windows-x86_64", "darwin-aarch64", "linux-x86_64"]）。 */
export function missingPlatforms(manifest, required) {
  const have = manifest && typeof manifest.platforms === "object" && manifest.platforms ? manifest.platforms : {};
  return required.filter((k) => !have[k] || !have[k].url || !have[k].signature);
}
