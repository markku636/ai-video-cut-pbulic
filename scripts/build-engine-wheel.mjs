#!/usr/bin/env node
// 把 engine/ 打成 wheel 放進 src-tauri/resources/engine/，並複製兩份 requirements；tauri 的 bundle.resources
// （tauri.conf.json）會把整個目錄帶進安裝檔，pyenv.rs 首次執行時用它們建 venv（uv → venv → torch → lock → wheel）。
//
// 為什麼是 wheel 而不是把 engine/ 原始碼整包塞進安裝檔：wheel 是單一檔、可驗 sha256、`uv pip install --no-deps`
// 一步到位；檔名帶版本（aivc-0.0.4-py3-none-any.whl），pyenv.rs 靠檔名就能挑「等於 App 版本」的那一個
// （`pick_wheel`），hello 握手再比一次版本 —— 三處版號由 sync-version.mjs 從 package.json 鏡射。
//
// uv 的位置（依序）：--uv <path> → 環境變數 AIVC_UV → 引導腳本放的那一份（Windows %LOCALAPPDATA%\net.markkulab.aivideocut\tools\uv\uv.exe、
// macOS ~/Library/Application Support/net.markkulab.aivideocut/tools/uv/uv、Linux ${XDG_DATA_HOME:-~/.local/share}/net.markkulab.aivideocut/tools/uv/uv）
// → PATH 上的 uv（CI：astral-sh/setup-uv）。
//
// 一起複製的還有 scripts/bootstrap-engine.ps1、scripts/bootstrap-engine.sh 與 scripts/uv-manifest.json：正式版的 pyenv.rs
// 從 resources/engine/ 呼叫腳本（Windows 跑 .ps1、macOS / Linux 跑 .sh），腳本從同目錄讀釘版的 uv 下載資訊。
// 三個平台的安裝檔都帶齊兩支腳本與兩份 torch requirements（requirements-torch.txt 給 cu130、-macos 給 PyPI MPS）：
// 多幾 KB，換來「在哪個平台 build 都產出同一個 resources/engine/」，--check 也不用分平台。
//
// 引擎外掛（plugins/<名稱>/engine，例：plugins/cards 的 aivc-cards）也在這裡建成 wheel，跟核心 wheel 放同一個目錄
// （aivc_cards-0.0.7-py3-none-any.whl）：bootstrap-engine.* 裝完 aivc 之後把同目錄的 aivc_*-*.whl 一起裝上，
// 引擎靠 entry point（aivc.plugins）找到它們。開源版沒有 plugins/ → 一個外掛 wheel 都不建，--check 也要求一個都沒有
// （上次私有版建置留下的外掛 wheel 不能被開源安裝檔夾帶出去）。外掛版號跟核心同一個（sync-version.mjs 一起寫）。
//
// 用法：
//   node scripts/build-engine-wheel.mjs              建 wheel（核心＋外掛）、複製 txt / 腳本 / manifest、寫 README.txt（舊 wheel 先清掉）
//   node scripts/build-engine-wheel.mjs --uv <path>  指定 uv
//   node scripts/build-engine-wheel.mjs --check      只檢查輸出目錄齊不齊（wheel 版本＝package.json、外掛 wheel ＝ repo 裡的外掛、
//                                                    其餘檔案都在、manifest 形狀對）
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pep440Version } from "./lib/release-checks.mjs";

// 路徑有空白時 import.meta.url 會是 %20，一定要走 fileURLToPath
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = join(ROOT, "engine");
const PLUGINS = join(ROOT, "plugins");
const OUT = join(ROOT, "src-tauri", "resources", "engine");
const REQ_FILES = ["requirements-torch.txt", "requirements-torch-macos.txt", "requirements.lock.txt"];
// 引導腳本 + uv 釘版 manifest 也進 bundle：正式版的 pyenv.rs 從 resources/engine/ 呼叫腳本，腳本從同目錄讀 manifest
const SCRIPT_FILES = ["bootstrap-engine.ps1", "bootstrap-engine.sh", "uv-manifest.json"];
// uv-manifest.json 的 assets 必須涵蓋的平台（uv 的 target triple）與壓縮格式。
// Windows 那一行必須等於頂層 url / sha256（bootstrap-engine.ps1 只讀頂層）。
const UV_ASSETS = {
  "x86_64-pc-windows-msvc": "zip",
  "aarch64-apple-darwin": "tar.gz",
  "x86_64-apple-darwin": "tar.gz",
  "x86_64-unknown-linux-gnu": "tar.gz",
};
const WHEEL_RE = /^aivc-([^-]+)-py3-none-any\.whl$/;
// 外掛 wheel：發行名稱 aivc-<名稱> → 檔名 aivc_<名稱>-<版本>-…（底線，所以 WHEEL_RE 與 pyenv.rs 的 pick_wheel 都不會把它當核心）
const PLUGIN_WHEEL_RE = /^(aivc_[a-z0-9_]+)-([^-]+)-py3-none-any\.whl$/;

const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const uvArg = args.includes("--uv") ? args[args.indexOf("--uv") + 1] : undefined;

const log = (m) => console.log(`[engine-wheel] ${m}`);
const die = (m) => {
  console.error(`[engine-wheel] ${m}`);
  process.exit(1);
};

const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

// 與 src-tauri/resources/engine/README.txt（有入庫）逐字相同；內容不同才重寫，重跑不會產生 diff。
const README = `This directory holds the packaged Python engine that ships with the installer:

  aivc-<version>-py3-none-any.whl   the \`aivc\` package (engine + CLI), installed with --no-deps
  aivc_<name>-<version>-py3-none-any.whl
                                    optional engine plugins built from plugins/<name>/engine (none in
                                    the open-source build); the scripts install them with --no-deps
                                    right after aivc and the engine finds them by entry point
  requirements-torch.txt            torch/torchvision pins for Windows and Linux (cu130 index only)
  requirements-torch-macos.txt      torch/torchvision pins for macOS on Apple Silicon (PyPI, MPS)
  requirements.lock.txt             every other dependency, fully pinned
  bootstrap-engine.ps1              the installer script the app runs on Windows (copied from scripts/)
  bootstrap-engine.sh               the installer script the app runs on macOS and Linux (POSIX sh)
  uv-manifest.json                  pinned uv version + per-platform URL + sha256 the scripts download

On first run the app's pyenv.rs runs the script for its OS from this directory to build a
private virtual environment under the app data folder:
  Windows  powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File bootstrap-engine.ps1
           -> %LOCALAPPDATA%\\net.markkulab.aivideocut\\pyenv (Scripts\\python.exe)
  macOS    bash bootstrap-engine.sh --data-root ...
           -> ~/Library/Application Support/net.markkulab.aivideocut/pyenv (bin/python)
  Linux    bash bootstrap-engine.sh --data-root ...
           -> \${XDG_DATA_HOME:-~/.local/share}/net.markkulab.aivideocut/pyenv (bin/python)
(uv -> venv 3.12 -> torch (cu130 on Windows/Linux, PyPI MPS on macOS) -> lock -> wheel ->
plugin wheels -> \`aivc doctor\` gate) and stores sha256(requirements.lock.txt) in pyenv/.stamp so a changed
lock shows up as "stale". The wheel's version must equal the app version: pyenv.rs picks the
matching wheel by file name and the engine's hello handshake rejects a mismatch.
AIVC_BOOTSTRAP_SCRIPT overrides the script location (offline / patched installs).

Only this README is in version control; \`node scripts/build-engine-wheel.mjs\` produces the
wheel (uv build) and copies the other files here before packaging (release.yml runs it
before tauri-action on every platform). During development the app uses the repo's engine/
directory (editable install via scripts/bootstrap-engine.ps1 or .sh) unless a wheel is present here.
`;

/** 引導腳本把 uv 放在「資料根/tools/uv/」；資料根＝Tauri app_local_data_dir（與 bootstrap-engine.* 的預設一致）。 */
function bootstrapUvPath() {
  const app = "net.markkulab.aivideocut";
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, app, "tools", "uv", "uv.exe");
  }
  const home = process.env.HOME;
  if (process.platform === "darwin") return home && join(home, "Library", "Application Support", app, "tools", "uv", "uv");
  // dirs::data_local_dir()：XDG_DATA_HOME 是絕對路徑才採用
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.startsWith("/") ? xdg : home && join(home, ".local", "share");
  return base && join(base, app, "tools", "uv", "uv");
}

function findUv() {
  const cands = [uvArg, process.env.AIVC_UV, bootstrapUvPath(), "uv"].filter(Boolean);
  for (const c of cands) {
    if (c !== "uv" && !existsSync(c)) continue;
    const r = spawnSync(c, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return { path: c, version: r.stdout.trim() };
  }
  return null;
}

const listWheels = () => (existsSync(OUT) ? readdirSync(OUT).filter((f) => WHEEL_RE.test(f)) : []);
const listPluginWheels = () => (existsSync(OUT) ? readdirSync(OUT).filter((f) => PLUGIN_WHEEL_RE.test(f)).sort() : []);
const mb = (p) => (statSync(p).size / 1048576).toFixed(2);
const pyVersion = (file) => /^__version__\s*=\s*"([^"]*)"/m.exec(readFileSync(file, "utf8"))?.[1];

/**
 * repo 裡的引擎外掛：plugins/<名稱>/engine（有 pyproject.toml 的）→ { dir, dist, versionFile }。
 * dist 是 wheel 檔名用的正規化發行名稱（aivc-cards → aivc_cards）；版號檔是 src/<套件>/_version.py（sync-version.mjs 寫的那個）。
 */
function pluginEngines() {
  if (!existsSync(PLUGINS)) return [];
  const out = [];
  for (const name of readdirSync(PLUGINS).sort()) {
    const dir = join(PLUGINS, name, "engine");
    const pyproject = join(dir, "pyproject.toml");
    if (!existsSync(pyproject)) continue;
    const m = /^\[project\][^\n]*\n(?:(?!^\[)[^\n]*\n)*?^name\s*=\s*"([^"]+)"/m.exec(readFileSync(pyproject, "utf8"));
    if (!m) die(`${pyproject} 的 [project] 找不到 name`);
    const dist = m[1].toLowerCase().replace(/[-_.]+/g, "_");
    // bootstrap-engine.* 只裝同目錄的 aivc_*-*.whl：不是這個名字的外掛裝不上，在建置時就擋
    if (!/^aivc_[a-z0-9_]+$/.test(dist)) die(`${pyproject} 的發行名稱必須是 aivc-<名稱>（wheel 才會是 aivc_<名稱>-…），現在是 ${m[1]}`);
    const src = join(dir, "src");
    const versionFile = existsSync(src)
      ? readdirSync(src)
          .sort()
          .map((p) => join(src, p, "_version.py"))
          .find((p) => existsSync(p))
      : undefined;
    if (!versionFile) die(`${dir} 找不到 src/<套件>/_version.py`);
    out.push({ name, dir, dist, versionFile });
  }
  return out;
}

/** 外掛 wheel 對帳：repo 裡每個外掛正好一個、版本＝package.json；目錄裡多出 repo 沒有的外掛 wheel 也算錯。 */
function verifyPluginWheels() {
  const want = new Set(pluginEngines().map((p) => p.dist));
  const found = listPluginWheels();
  for (const w of found) {
    const [, dist, v] = PLUGIN_WHEEL_RE.exec(w);
    if (!want.has(dist)) die(`${OUT} 裡有 repo 沒有的外掛 wheel ${w}（別的建置留下的？開源版的安裝檔不能夾帶外掛）`);
    if (v !== version) die(`外掛 wheel ${w} 的版本 ${v} ≠ package.json ${version}（先跑 node scripts/sync-version.mjs）`);
  }
  for (const dist of want) {
    const n = found.filter((w) => PLUGIN_WHEEL_RE.exec(w)[1] === dist).length;
    if (n !== 1) die(`${OUT} 裡應該正好一個 ${dist} wheel，現在有 ${n} 個`);
  }
  return found;
}

function verifyOutput() {
  const wheels = listWheels();
  if (wheels.length !== 1) die(`${OUT} 裡應該正好一個 aivc wheel，現在有 ${wheels.length} 個：${wheels.join(", ") || "（無）"}`);
  const built = WHEEL_RE.exec(wheels[0])[1];
  // setuptools 把版本正規化成 PEP 440 才放進檔名（0.0.8-beta.1 → 0.0.8b1）：兩邊都正規化再比（pyenv.rs 的 py_version 同一套）
  if (pep440Version(built) !== pep440Version(version)) die(`wheel 版本 ${built} ≠ package.json ${version}（engine/src/aivc/_version.py 沒同步？先跑 node scripts/sync-version.mjs）`);
  const plugins = verifyPluginWheels();
  for (const f of [...REQ_FILES, ...SCRIPT_FILES]) {
    const p = join(OUT, f);
    if (!existsSync(p) || statSync(p).size === 0) die(`缺 ${p}`);
  }
  // manifest 形狀：version / url / sha256 必填。bootstrap-engine.ps1 本身容忍頂層 sha256 = null（只警告），
  // 但打包進安裝檔的 manifest 不行：頂層必須等於 assets 的 Windows 那一行，而 assets 一律要有 sha256（verifyUvAssets）。
  const manifest = JSON.parse(readFileSync(join(OUT, "uv-manifest.json"), "utf8"));
  if (typeof manifest.version !== "string" || !/^https:\/\/github\.com\/astral-sh\/uv\/releases\/download\//.test(manifest.url ?? "")) {
    die("uv-manifest.json 的 version / url 不對（url 必須是 astral-sh/uv 官方 release asset）");
  }
  if (!manifest.url.includes(`/${manifest.version}/`)) die(`uv-manifest.json 的 url 不含版本 ${manifest.version}`);
  if (!/^[0-9a-f]{64}$/.test(manifest.sha256 ?? "")) {
    die("uv-manifest.json 的 sha256 必須是 64 位小寫 hex（安裝檔不出沒驗證的 uv 下載）");
  }
  verifyUvAssets(manifest, readFileSync(join(OUT, "uv-manifest.json"), "utf8"));
  // .sh 帶 CR 的話 dash / bash 會報 `$'\r': command not found`，而且是在使用者機器上安裝到一半才炸。
  // .gitattributes 已經讓 *.sh 以 LF 檢出；這裡再擋一次（例如有人用會轉 CRLF 的編輯器改過再 build）。
  if (readFileSync(join(OUT, "bootstrap-engine.sh"), "utf8").includes("\r")) {
    die("bootstrap-engine.sh 含 CR（CRLF 行尾）：macOS / Linux 的 sh 會執行失敗，請轉成 LF");
  }
  return { wheel: wheels[0], plugins };
}

/**
 * assets：每個平台都要有、url 是該版本的官方資產、sha256 必填（POSIX 腳本沒有 sha256 就拒絕下載）。
 * 另外用 bootstrap-engine.sh 同一套「一行一個平台」的規則重解一次原始文字 —— JSON 合法但被格式化工具
 * 拆成多行時，JSON.parse 看不出來，sh 版卻會說找不到資產。
 */
function verifyUvAssets(manifest, rawText) {
  const assets = manifest.assets;
  if (!assets || typeof assets !== "object") die("uv-manifest.json 缺 assets（各平台的 uv 資產）");
  const lines = rawText.split(/\r?\n/);
  for (const [triple, ext] of Object.entries(UV_ASSETS)) {
    const a = assets[triple];
    const wantUrl = `https://github.com/astral-sh/uv/releases/download/${manifest.version}/uv-${triple}.${ext}`;
    if (!a || a.url !== wantUrl) die(`uv-manifest.json 的 assets.${triple}.url 應為 ${wantUrl}，實際 ${a?.url ?? "（缺）"}`);
    if (!/^[0-9a-f]{64}$/.test(a.sha256 ?? "")) die(`uv-manifest.json 的 assets.${triple}.sha256 必須是 64 位小寫 hex`);
    // 與 bootstrap-engine.sh 的 sed 規則對齊：行首（可有空白）"triple": 開頭，同一行內找得到 "url" 與 "sha256"
    const line = lines.find((l) => new RegExp(`^\\s*"${triple}"\\s*:`).test(l));
    const url = line && /"url"\s*:\s*"([^"]*)"/.exec(line)?.[1];
    const sha = line && /"sha256"\s*:\s*"([0-9a-fA-F]*)"/.exec(line)?.[1];
    if (url !== a.url || sha?.toLowerCase() !== a.sha256) {
      die(`uv-manifest.json 的 assets.${triple} 必須寫在同一行（bootstrap-engine.sh 以 sed 逐行讀取）`);
    }
  }
  const win = assets["x86_64-pc-windows-msvc"];
  if (manifest.url !== win.url || manifest.sha256 !== win.sha256) {
    die("uv-manifest.json 頂層 url / sha256（bootstrap-engine.ps1 讀的）必須等於 assets.x86_64-pc-windows-msvc");
  }
}

if (CHECK) {
  const { wheel: w, plugins } = verifyOutput();
  const extra = plugins.map((p) => ` + ${p} (${mb(join(OUT, p))} MB)`).join("");
  log(`OK ${w} (${mb(join(OUT, w))} MB)${extra} + ${[...REQ_FILES, ...SCRIPT_FILES].join(" + ")}`);
  process.exit(0);
}

// 版號閘門：wheel 檔名來自 _version.py，必須等於 package.json，否則 pyenv.rs 挑不到、hello 也會拒絕
const vpy = readFileSync(join(ENGINE, "src", "aivc", "_version.py"), "utf8");
const m = /^__version__\s*=\s*"([^"]*)"/m.exec(vpy);
if (!m) die("engine/src/aivc/_version.py 找不到 __version__");
if (m[1] !== version) die(`engine/src/aivc/_version.py 是 ${m[1]}，package.json 是 ${version}；先跑 node scripts/sync-version.mjs`);
// 外掛同一條：版本不同的外掛會被引擎拒絕載入（register 的版本護欄），安裝起來也是白裝
const pluginList = pluginEngines();
for (const p of pluginList) {
  const pv = pyVersion(p.versionFile);
  if (pv !== version) die(`${p.versionFile} 是 ${pv ?? "（找不到 __version__）"}，package.json 是 ${version}；先跑 node scripts/sync-version.mjs`);
}

const uv = findUv();
if (!uv) die("找不到 uv：用 --uv <path>、設 AIVC_UV，或先跑 scripts/bootstrap-engine.ps1 / bootstrap-engine.sh（會下載到資料根的 tools/uv）；CI 用 astral-sh/setup-uv");
log(`uv: ${uv.path} (${uv.version})`);

mkdirSync(OUT, { recursive: true });
// 安裝檔只該帶一個 wheel：pyenv.rs 會挑版本相符的，多帶只是白佔 MB、也讓 --check 說不清。
// 外掛 wheel 一起清：開源版（沒有 plugins/）不能把上次私有版建置留下的外掛帶進安裝檔
for (const w of [...listWheels(), ...listPluginWheels()]) {
  rmSync(join(OUT, w));
  log(`移除舊 wheel ${w}`);
}

// setuptools 在專案目錄的 build/ 裡組 wheel，而且不會清掉上次留下、這次已經不該帶的檔（刪掉的模組、改了
// exclude-package-data 的資料檔）——舊檔會原封進新 wheel。build/ 是 gitignore 的中間產物，每次建置前清掉。
const cleanBuildDir = (dir) => rmSync(join(dir, "build"), { recursive: true, force: true });

// --python 3.12：pyproject 釘 >=3.12,<3.13；不指定時 uv 可能拿 PATH 上的 3.10 去建 build env 然後失敗。
// 有裝 3.12（本機 / CI setup-python）就用它，沒有 uv 會自己抓一份受管的。
log(`uv build --wheel ${ENGINE} → ${OUT}`);
cleanBuildDir(ENGINE);
execFileSync(uv.path, ["build", "--wheel", "--python", "3.12", "--out-dir", OUT, ENGINE], { stdio: "inherit", cwd: ROOT });
for (const p of pluginList) {
  log(`uv build --wheel ${p.dir} → ${OUT}（外掛 ${p.name}）`);
  cleanBuildDir(p.dir);
  execFileSync(uv.path, ["build", "--wheel", "--python", "3.12", "--out-dir", OUT, p.dir], { stdio: "inherit", cwd: ROOT });
}

// uv build 會在 --out-dir 放一個內容 `*` 的 .gitignore（把它當 dist/ 用）；這裡的忽略規則在 repo 根 .gitignore，
// 而且 tauri 會把整個目錄當資源帶進安裝檔 —— 一個沒用的檔就別帶了。
const strayIgnore = join(OUT, ".gitignore");
if (existsSync(strayIgnore) && readFileSync(strayIgnore, "utf8").trim() === "*") {
  rmSync(strayIgnore);
}

for (const f of REQ_FILES) {
  copyFileSync(join(ENGINE, f), join(OUT, f));
}
for (const f of SCRIPT_FILES) {
  copyFileSync(join(ROOT, "scripts", f), join(OUT, f));
}
const readmePath = join(OUT, "README.txt");
if (!existsSync(readmePath) || readFileSync(readmePath, "utf8") !== README) {
  writeFileSync(readmePath, README);
  log("寫入 README.txt");
}

const { wheel, plugins: pluginWheels } = verifyOutput();
log(`完成：${wheel} (${mb(join(OUT, wheel))} MB)`);
for (const p of pluginWheels) log(`        ${p} (${mb(join(OUT, p))} MB)`);
for (const f of [...REQ_FILES, ...SCRIPT_FILES]) log(`        ${f} (${statSync(join(OUT, f)).size} bytes)`);
