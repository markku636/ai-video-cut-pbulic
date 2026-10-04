#!/usr/bin/env node
// 版號單一事實來源是 package.json；這支把它鏡射到另外三個地方：
//   src-tauri/Cargo.toml          [package] version   （cargo / tauri bundle 讀這裡）
//   src-tauri/tauri.conf.json     version             （安裝檔 / 關於對話框讀這裡）
//   engine/src/aivc/_version.py   __version__         （`aivc --version`、sidecar hello 的版本比對讀這裡）
// 再加上每個引擎外掛的 plugins/<名稱>/engine/src/<套件>/_version.py（有幾個算幾個；開源版沒有 plugins/ 就一個都沒有）：
// 外掛的 register() 版本跟核心不同就拒絕載入，所以外掛版號也必須跟著走。
//
// 為什麼不是各自手改：ai-music-cut 到 v0.136 是「發版時記得同步」，三處對不上時症狀是「關於」顯示的
// 版本跟 GitHub Release 的 tag 不一致。本專案 sidecar 的 hello 會比對 App 與引擎版本、不符即拒絕啟動
// （計畫 §5.8）—— 所以不同步不是美觀問題，是開不起來。build 一開始就跑這支。
//
// 用法：
//   node scripts/sync-version.mjs            寫入（已一致的檔案不重寫 → idempotent；`npm run build` 先跑這支）
//   node scripts/sync-version.mjs --check    只比對，不一致 exit 1（CI 用；不寫任何檔）
//   node scripts/sync-version.mjs --strict   目標檔不存在也算失敗（預設是警告後跳過：殼層與引擎分頭建，早期會缺）
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VERSION_RE } from "./lib/release-checks.mjs";

// 路徑有空白時 import.meta.url 會是 %20，一定要走 fileURLToPath
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const STRICT = args.includes("--strict");

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const version = pkg.version;
// 預先發布只准 -alpha[.N] / -beta[.N] / -rc[.N]：引擎 wheel 的檔名是 PEP 440（setuptools 正規化），
// App（pyenv.rs / wheel_refresh.rs）與 build-engine-wheel.mjs 都靠 release-checks.mjs 的對照比版本，其他後綴對不上
if (typeof version !== "string" || !APP_VERSION_RE.test(version)) {
  console.error(`[sync-version] package.json 的 version 要是 X.Y.Z 或 X.Y.Z-alpha.N / -beta.N / -rc.N：${JSON.stringify(version)}`);
  process.exit(1);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `__version__ = "x.y.z"`（核心與外掛的 _version.py 同一種格式）。 */
function locatePyVersion(text) {
  const m = /^(__version__\s*=\s*")([^"]*)(")/m.exec(text);
  if (!m) return null;
  return {
    old: m[2],
    replace: (next) => text.slice(0, m.index) + m[1] + next + m[3] + text.slice(m.index + m[0].length),
  };
}

/** 引擎外掛的版號檔：plugins/<名稱>/engine/src/<套件>/_version.py（照名稱排序，輸出穩定）。 */
function pluginVersionFiles() {
  const base = join(ROOT, "plugins");
  if (!existsSync(base)) return [];
  const out = [];
  for (const name of readdirSync(base).sort()) {
    const src = join(base, name, "engine", "src");
    if (!existsSync(src)) continue;
    for (const pkg of readdirSync(src).sort()) {
      if (existsSync(join(src, pkg, "_version.py"))) out.push(`plugins/${name}/engine/src/${pkg}/_version.py`);
    }
  }
  return out;
}

/**
 * 每個目標一個 `locate(text)`：回傳 { old, replace(next) } 或 null（找不到欄位）。
 * 全部用文字替換而不是 parse → stringify：重寫會改掉鍵順序 / 縮排 / 註解，diff 會被雜訊淹沒。
 */
const TARGETS = [
  {
    file: "src-tauri/Cargo.toml",
    locate(text) {
      // 只動 [package] 區塊裡的 version = "…"；[dependencies] 裡每個 crate 都有 version，不能碰。
      // (?:(?!^\[)[^\n]*\n)*? 逐行懶惰前進、遇到下一個 [section] 就停。
      const m = /(^\[package\][^\n]*\n(?:(?!^\[)[^\n]*\n)*?^version\s*=\s*")([^"]*)(")/m.exec(text);
      if (!m) return null;
      return {
        old: m[2],
        replace: (next) => text.slice(0, m.index) + m[1] + next + m[3] + text.slice(m.index + m[0].length),
      };
    },
  },
  {
    file: "src-tauri/tauri.conf.json",
    locate(text) {
      // 先 parse 確認是合法 JSON 且頂層有 version，再只換頂層那一個（兩格縮排＝頂層鍵）。
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return null;
      }
      if (typeof json.version !== "string") return null;
      const re = new RegExp(`^(\\s{2}"version"\\s*:\\s*")${escapeRe(json.version)}(")`, "m");
      if (!re.test(text)) return null;
      return { old: json.version, replace: (next) => text.replace(re, `$1${next}$2`) };
    },
  },
  { file: "engine/src/aivc/_version.py", locate: locatePyVersion },
  ...pluginVersionFiles().map((file) => ({ file, locate: locatePyVersion })),
];

let changed = 0;
let drift = 0;
let missing = 0;
let broken = 0;
for (const t of TARGETS) {
  const p = join(ROOT, t.file);
  if (!existsSync(p)) {
    missing++;
    if (STRICT) console.error(`[sync-version] ${t.file} 不存在`);
    else console.warn(`[sync-version] ${t.file} 不存在（跳過；殼層 / 引擎尚未建立時是正常的）`);
    continue;
  }
  const before = readFileSync(p, "utf8");
  const hit = t.locate(before);
  if (!hit) {
    broken++;
    console.error(`[sync-version] ${t.file} 找不到版號欄位（格式變了？）`);
    continue;
  }
  if (hit.old === version) {
    console.log(`[sync-version] ${t.file} 已是 ${version}`);
    continue;
  }
  drift++;
  if (CHECK) {
    console.error(`[sync-version] ${t.file} 是 ${hit.old}，package.json 是 ${version}`);
    continue;
  }
  writeFileSync(p, hit.replace(version));
  changed++;
  console.log(`[sync-version] ${t.file} ${hit.old} → ${version}`);
}

if (broken || (STRICT && missing) || (CHECK && drift)) process.exit(1);
console.log(
  CHECK
    ? `[sync-version] OK（${version}${missing ? `；${missing} 個目標尚不存在` : ""}）`
    : `[sync-version] 完成（${version}，改了 ${changed} 個檔案${missing ? `；${missing} 個目標尚不存在` : ""}）`,
);
