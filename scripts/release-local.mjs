#!/usr/bin/env node
// 本機發版（Windows）：建引擎 wheel → 帶 updater overlay 打 NSIS 安裝檔（簽章）→ 收 setup.exe + .sig → 寫 latest.json →
// （加 --publish 才）用 gh 建 GitHub Release、上傳、轉正。
//
// 為什麼有這支：GitHub Actions 目前被帳單擋住，release.yml 跑不了；這是同一條路在本機走一遍（只出 Windows 的安裝檔）。
//
// 用法（repo 根目錄、PowerShell；完整說明見 docs/updater.md）：
//   $env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE\.tauri\ai-video-cut-updater.key"   # 金鑰「檔案路徑」或「內容」
//   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<產生金鑰時設的密碼>"                        # 沒設密碼就不用
//   node scripts/release-local.mjs              # 預設乾跑：建置、收檔、寫 release/<tag>/latest.json，只「印出」會跑的 gh 指令
//   node scripts/release-local.mjs --publish    # 真的發：draft → 上傳 → 轉正並標成 Latest（App 的預設來源才找得到）
//
// 選項：
//   --publish                       真的執行 gh release 指令（沒帶就只印出來）
//   --flavor public|cards           cards＝私有建置（多疊 plugins/cards/tauri.conf.overlay.json），不准上傳到公開 repo，
//                                   而且 overlay 要有自己的 plugins.updater.pubkey（跟公開版不同的一把金鑰）
//   --repo owner/name               Release 放在哪個 repo（預設：tauri.conf.json 更新來源網址裡的 GitHub repo；cards 要指定別的）
//   --tag vX.Y.Z                    預設 v<package.json 的 version>；-alpha.N / -beta.N / -rc.N 後綴＝預先發布（不會標成 Latest，App 不會自動找到）
//   --notes "…" / --notes-file <檔> 這一版的說明（App 的更新對話框以純文字顯示）
//   --base-url https://…/           安裝檔不放 GitHub、自己架站：latest.json 的 url 改成 <base-url><檔名>，也不跑 gh
//   --skip-build                    不重建，直接用 target 裡現有的 setup.exe 與 .sig（例如只想重寫 latest.json）
//
// 這支**不產生金鑰、不讀也不寫金鑰檔**：只檢查環境變數有沒有設（設成路徑時看檔案在不在），由 tauri CLI 自己讀。
// 環境變數的值**絕不印出來**（只有明顯是 .key 檔路徑才印）：它可能就是私鑰本身，見 scripts/lib/release-checks.mjs。
// 也不碰 git：tag 要自己先 push（gh release create 帶 --verify-tag，遠端沒有這個 tag 就停）。
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VERSION_RE, classifySigningKey, printableKeyPath, sameRepo, urlPointsAtRepo } from "./lib/release-checks.mjs";
import { buildLatestJson, githubAssetName, isSignatureContent, missingPlatforms, releaseAssetUrl, signedVersion } from "./lib/updater-manifest.mjs";

// 路徑有空白時 import.meta.url 會是 %20，一定要走 fileURLToPath
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UPDATER_OVERLAY = "src-tauri/tauri.updater.conf.json";
const CARDS_OVERLAY = "plugins/cards/tauri.conf.overlay.json";
const VALUE_FLAGS = ["--flavor", "--repo", "--tag", "--notes", "--notes-file", "--base-url"];
const BOOL_FLAGS = ["--publish", "--skip-build", "--help"];

const log = (m) => console.log(`[release] ${m}`);
const warn = (m) => console.warn(`[release] 注意：${m}`);
const die = (m) => {
  console.error(`[release] ${m}`);
  process.exit(1);
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (BOOL_FLAGS.includes(a)) out[a.slice(2)] = true;
    else if (VALUE_FLAGS.includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) die(`${a} 後面要接值`);
      out[a.slice(2)] = v;
    } else die(`不認得的參數：${a}（--help 看用法）`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}

const PUBLISH = !!args.publish;
const SKIP_BUILD = !!args["skip-build"];
const flavor = args.flavor ?? "public";
if (!["public", "cards"].includes(flavor)) die(`--flavor 只能是 public 或 cards：${flavor}`);
if (process.platform !== "win32") die("這支只出 Windows 的 NSIS 安裝檔，要在 Windows 上跑；macOS / Linux 用 .github/workflows/release.yml");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const version = pkg.version;
// 預先發布只准 alpha / beta / rc：引擎 wheel 的檔名是 PEP 440（0.0.8-beta.1 → 0.0.8b1），其他後綴對不上
if (!APP_VERSION_RE.test(version)) die(`package.json 的版本 ${version} 不是 X.Y.Z（或 X.Y.Z-alpha.N / -beta.N / -rc.N）`);
const tag = args.tag ?? `v${version}`;
if (tag.replace(/^v/, "") !== version) die(`tag ${tag} 跟 package.json 的版本 ${version} 對不上（latest.json 的版本與安裝檔都是 ${version}）`);
const prerelease = tag.includes("-");

const conf = JSON.parse(readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"));
const productName = conf.productName;
// 公開頻道的 repo 由 tauri.conf.json 的更新來源推出來（…/github.com/<owner>/<repo>/releases/…）：改來源只改那一個地方
const PUBLIC_REPO = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/releases\//.exec(conf.plugins?.updater?.endpoints?.[0] ?? "")?.[1] ?? null;
const repo = args.repo ?? PUBLIC_REPO;
const baseUrl = args["base-url"] ? args["base-url"].replace(/\/?$/, "/") : null;
if (baseUrl && !/^https:\/\//.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(baseUrl)) die(`--base-url 要是 https（測試可用 http://localhost / 127.0.0.1）：${baseUrl}`);
if (!baseUrl && !repo) die("tauri.conf.json 的更新來源不是 GitHub Release：用 --repo owner/name 或 --base-url 指定要發到哪裡");
if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) die(`--repo 要是 owner/name：${repo}`);
// 私有建置絕不能出現在公開頻道：開源版的使用者會被「更新」成私有版，私有版也會被開源版蓋掉。
// GitHub 的 owner/name 不分大小寫（--repo Markku636/AI-Video-Cut 一樣是公開 repo），--base-url 指到公開 repo 的 Release 也擋
if (flavor === "cards" && !baseUrl && sameRepo(repo, PUBLIC_REPO)) die(`--flavor cards 不能發到公開 repo ${PUBLIC_REPO}：用 --repo 指定私有 repo，或 --base-url 指定私有站`);
if (flavor === "cards" && baseUrl && PUBLIC_REPO && urlPointsAtRepo(baseUrl, PUBLIC_REPO)) die(`--flavor cards 的 --base-url 指到公開 repo ${PUBLIC_REPO}：換成私有站`);
const publicKey = String(conf.plugins?.updater?.pubkey ?? "").trim();
if (!publicKey) {
  die("tauri.conf.json 的 plugins.updater.pubkey 是空的：已安裝的 App 驗不了簽章，發了也裝不起來。先照 docs/updater.md 產生金鑰、把公鑰貼進去");
}
const overlays = [UPDATER_OVERLAY, ...(flavor === "cards" ? [CARDS_OVERLAY] : [])];
for (const o of overlays) if (!existsSync(join(ROOT, o))) die(`找不到 ${o}`);
if (flavor === "cards") {
  const cards = JSON.parse(readFileSync(join(ROOT, CARDS_OVERLAY), "utf8"));
  // 頻道要靠金鑰隔開，不是只靠網址：兩個版本共用 identifier（也就共用 settings.json），同一把金鑰的話
  // 任何一邊的安裝檔在另一邊都驗得過。私有建置一定要有自己的公鑰（與公開版不同），簽章也要用那把私鑰
  const cardsKey = String(cards.plugins?.updater?.pubkey ?? "").trim();
  if (!cardsKey || cardsKey === publicKey) {
    die(`${CARDS_OVERLAY} 要有自己的 plugins.updater.pubkey（另一把金鑰，不能跟公開版相同）；TAURI_SIGNING_PRIVATE_KEY 也要設成那一把的私鑰。見 docs/updater.md「私有建置」`);
  }
  if (cards.plugins?.updater?.allowEndpointOverride !== false) die(`${CARDS_OVERLAY} 要設 plugins.updater.allowEndpointOverride: false（設定裡的覆寫網址不能把私有建置接到公開頻道）`);
  const eps = cards.plugins?.updater?.endpoints;
  if (Array.isArray(eps) && eps.length === 0) warn(`${CARDS_OVERLAY} 清空了 endpoints：這個私有建置不會自動檢查更新，這份 latest.json 要等你把 endpoints 改成私有頻道才會被用到`);
}

function run(cmd, argv, opts = {}) {
  log(`$ ${[cmd, ...argv].map(quote).join(" ")}`);
  const r = spawnSync(cmd, argv, { cwd: ROOT, stdio: "inherit", env: process.env, ...opts });
  if (r.error) die(`${cmd} 跑不起來：${r.error.message}`);
  if (r.status !== 0) die(`${cmd} 失敗（exit ${r.status}）`);
}

function quote(a) {
  return /[\s"'&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
}

// ---- 1. 金鑰（只看環境變數，不讀檔）----
if (!SKIP_BUILD) {
  // 值本身絕不進任何訊息：先「正面」認出金鑰內容（base64 解開是 minisign 框），其餘才當路徑
  const key = classifySigningKey(process.env.TAURI_SIGNING_PRIVATE_KEY);
  if (key.kind === "empty") {
    die("沒有設 TAURI_SIGNING_PRIVATE_KEY（金鑰檔的路徑或內容）。tauri build 會在打包完才因為沒有私鑰而失敗；設定方式見 docs/updater.md");
  }
  if (key.kind === "path") {
    const shown = printableKeyPath(key.path);
    if (!existsSync(key.path)) {
      die(shown ? `TAURI_SIGNING_PRIVATE_KEY 指到的檔案不存在：${shown}` : "TAURI_SIGNING_PRIVATE_KEY 不是金鑰內容，當成路徑也找不到檔案（值不印出：它可能是金鑰本身）。檢查有沒有貼錯、或少貼了一段");
    }
    log(`簽章金鑰：${shown ?? "環境變數指到的金鑰檔"}（tauri CLI 自己讀）`);
  } else {
    log("簽章金鑰：環境變數裡的金鑰內容（不印出）");
  }
  if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
    warn("沒有設 TAURI_SIGNING_PRIVATE_KEY_PASSWORD：金鑰有密碼的話 tauri 會在建置最後問你（或簽章失敗）");
  }
}

// ---- 2. 版號三處同步（不寫檔，只檢查）----
run(process.execPath, ["scripts/sync-version.mjs", "--check", "--strict"]);

// ---- 3. 建置 ----
if (SKIP_BUILD) {
  log("--skip-build：沿用 target 裡現有的安裝檔");
} else {
  run(process.execPath, ["scripts/build-engine-wheel.mjs"]);
  // 直接用 node 跑 CLI 的 JS 入口：repo 路徑有空白，走 npx.cmd 要開 shell、引號容易出錯
  const cli = join(ROOT, "node_modules", "@tauri-apps", "cli", "tauri.js");
  if (!existsSync(cli)) die("找不到 @tauri-apps/cli：先 npm ci");
  run(process.execPath, [cli, "build", "--bundles", "nsis", ...overlays.flatMap((o) => ["--config", o])]);
}

// ---- 4. 收檔 ----
const targetDir = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(ROOT, "src-tauri", "target");
const nsisDir = join(targetDir, "release", "bundle", "nsis");
const exeName = `${productName}_${version}_x64-setup.exe`;
const exePath = join(nsisDir, exeName);
const sigPath = `${exePath}.sig`;
if (!existsSync(exePath)) die(`找不到安裝檔：${exePath}`);
if (!existsSync(sigPath)) die(`找不到簽章檔：${sigPath}（建置時沒有帶 ${UPDATER_OVERLAY}，或沒有私鑰）`);
// .sig 是公開的簽章（跟安裝檔一起上傳），不是金鑰
const signature = readFileSync(sigPath, "utf8").trim();
if (!isSignatureContent(signature)) die(`${sigPath} 不是 minisign 簽章檔`);
// App 開了 requireSignedVersion：簽章要綁這一版（tauri-cli 2.12 起自動寫）。--skip-build 撿到舊的 .sig 時在這裡就停
const signed = signedVersion(signature);
if (signed !== version) die(`${sigPath} 綁的版本是 ${signed ?? "（沒有，tauri-cli 2.12 以前簽的）"}，不是 ${version}：重新建置（npm ci 裝到 @tauri-apps/cli 2.12 以上）`);

const outDir = join(ROOT, "release", flavor === "cards" ? `${tag}-cards` : tag);
mkdirSync(outDir, { recursive: true });
const assetExe = githubAssetName(exeName);
const assetSig = githubAssetName(`${exeName}.sig`);
copyFileSync(exePath, join(outDir, assetExe));
copyFileSync(sigPath, join(outDir, assetSig));

// ---- 5. latest.json ----
let notes = args.notes ?? "";
if (args["notes-file"]) {
  if (!existsSync(args["notes-file"])) die(`找不到 --notes-file：${args["notes-file"]}`);
  notes = readFileSync(args["notes-file"], "utf8").trim();
}
const url = baseUrl ? `${baseUrl}${encodeURIComponent(assetExe)}` : releaseAssetUrl(repo, tag, assetExe);
const manifest = buildLatestJson({ version, notes, pubDate: new Date(), assets: [{ name: assetExe, url, signature }] });
const latestPath = join(outDir, "latest.json");
writeFileSync(latestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const notesPath = join(outDir, "release-notes.md");
writeFileSync(notesPath, `${notes || `AI Video Cut ${tag}`}\n`);
log(`已寫 ${latestPath}`);
log(`  version ${manifest.version} · pub_date ${manifest.pub_date} · platforms ${Object.keys(manifest.platforms).join(", ")}`);
log(`  url ${url}`);
const missing = missingPlatforms(manifest, ["darwin-aarch64", "linux-x86_64"]);
if (missing.length) warn(`這份 latest.json 只有 Windows（${missing.join("、")} 沒有）：那些平台的 App 檢查更新會得到「這一版沒有提供這個平台的更新檔」。三個平台都要的話用 release.yml`);

// ---- 6. 發布（--publish 才真的跑）----
const files = [join(outDir, assetExe), join(outDir, assetSig), latestPath];
if (baseUrl) {
  log(`--base-url：不跑 gh。把 ${outDir} 裡的 ${[assetExe, assetSig, "latest.json"].join("、")} 放到 ${baseUrl}`);
  if (flavor === "cards") {
    // 私有建置的 endpoints 被 overlay 清空時，設定頁的覆寫也不生效（updater.rs resolve_status）：來源只能寫在 overlay 裡
    log(`私有建置要找得到它：把 ${CARDS_OVERLAY} 的 plugins.updater.endpoints 改成 ["${baseUrl}latest.json"] 再建置`);
  } else {
    log(`App 的更新來源（tauri.conf.json 的 endpoints，或測試時在 設定 › 更新來源 覆寫）指到 ${baseUrl}latest.json`);
  }
  process.exit(0);
}

const ghCreate = ["release", "create", tag, "--repo", repo, "--draft", "--verify-tag", "--title", `AI Video Cut ${tag}`, "--notes-file", notesPath];
const ghUpload = ["release", "upload", tag, ...files, "--repo", repo, "--clobber"];
// 不是預先發布才標成 Latest：App 的預設來源是 /releases/latest/download/latest.json，GitHub 的 latest 不含 draft 與 prerelease
const ghPublish = ["release", "edit", tag, "--repo", repo, "--draft=false", ...(prerelease ? ["--prerelease"] : ["--prerelease=false", "--latest"])];

if (!PUBLISH) {
  log("乾跑（沒帶 --publish）：以下指令不會執行");
  for (const a of [ghCreate, ghUpload, ghPublish]) log(`  gh ${a.map(quote).join(" ")}`);
  log("確認 release/ 裡的檔案沒問題、tag 已 push 之後，加 --publish 再跑一次（可以帶 --skip-build 不重建）");
  process.exit(0);
}

const view = spawnSync("gh", ["release", "view", tag, "--repo", repo, "--json", "isDraft"], { cwd: ROOT, encoding: "utf8" });
if (view.error) die(`gh 跑不起來：${view.error.message}（先安裝 GitHub CLI 並 gh auth login）`);
if (view.status === 0) {
  // 已發布的 Release 不再往裡面塞檔（使用者可能已經下載過）；draft 就沿用（上次發到一半）
  const isDraft = JSON.parse(view.stdout || "{}").isDraft;
  if (!isDraft) die(`Release ${tag} 已經發布了，不再往裡面上傳；要重發請換一個版本號`);
  log(`沿用既有的 draft ${tag}`);
} else {
  run("gh", ghCreate);
}
run("gh", ghUpload);
run("gh", ghPublish);
log(`完成：https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`);
