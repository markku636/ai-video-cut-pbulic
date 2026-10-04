#!/usr/bin/env node
// i18n 稽核：找出「畫面上會出現、但沒有進翻譯目錄」的中文字串。
//
// 為什麼需要兩種掃法：
// 1. `t("字面量")` —— 直接找得到。
// 2. `t(表[k])` —— 字串在**別的檔案**的標籤表裡（指令註冊表的 title / why、狀態標籤、
//    主題名稱、復原標籤、快捷鍵說明…）。只掃第 1 種的話，這些會整批漏掉，
//    症狀是切到英文之後畫面上冒出一片中文，而稽核卻說「零缺漏」。
//    這在 ai-music-cut v0.42.0 之前實際發生過。
//
// 本專案只有一個語言目錄（en）：繁中原文就是 key，identity fallback 回退到原文不會壞。
//
// 兩個範圍，各查各的：
// - **核心**（src/）只查核心的目錄 src/locales/en.ts —— 開源版沒有 plugins/，核心的每一句都要自己有譯文。
// - **外掛**（plugins/<id>/frontend/）查「核心目錄 ＋ 外掛自己的目錄 locales/en.ts」（執行時兩份合併，核心優先）。
//   外掛的標籤表 / 資料字串在 plugins/<id>/frontend/i18n.config.json（tableSources / notUi）。
//   外掛目錄裡的鍵核心已經有了也算錯：核心優先，外掛那一份永遠用不到，只會讓兩份譯文慢慢分岔。
//
// 不該翻譯的東西要明確排除，不能靠「反正沒人會注意」：
// codec 名（libvpx-vp9）、引擎 op id（track.solve）是**資料**，翻掉會讓管線對不上。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 路徑有空白時 import.meta.url 會是 %20，一定要走 fileURLToPath
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CJK = /[一-鿿]/;

/**
 * 核心的標籤表所在的檔案：這些檔的中文字串多半是靠 t(變數) 翻的。
 * 以 "/" 結尾的是整個目錄（指令註冊表：每一條的 title / why 都是 zh key）。
 */
const CORE_TABLE_SOURCES = [
  "commands/",
  "themes.ts",
  "store/edits.ts",
  "video/labels.ts",
  "dialogs/ShortcutsHelp.tsx",
  "dialogs/EngineSetupDialog.tsx",
  "dialogs/InsertOptionsDialog.tsx",
  "shell/startCards.ts",
  "shell/StatusBar.tsx",
  "inspector/labels.ts",
  // 右側欄分頁的標題與「檢視 › 側欄」指令名（以前寫在 commands/core.ts）
  "inspector/tabs.ts",
  // 「建議」分頁的文字表：t(變數) 解析，字面量掃描看不到
  "inspector/advice.ts",
  // 輸出尺寸的標籤表：t(變數) 解析，字面量掃描看不到
  "pipeline/reframe.ts",
  // AI 助手工具的顯示名稱：由面板 t(變數) 翻（catalogue.ts 的 describe 是寫給模型看的，不翻）
  "assistant/labels.ts",
  // 工作模式與可由外掛加值的列舉（區域策略…）的名稱
  "project/profiles.ts",
  "project/vocab.ts",
  // App 自動更新：指令 title（updater/commands.ts）由註冊表 t(變數) 翻；整個目錄都掃，日後加的標籤表不會漏
  "updater/",
  // 通用物件：建議片語、範圍與擋路的原因、清單那一列的說法（t(變數) 解析）
  "objects/",
  // 物件特效與替換：欄位表、選項名、驗證訊息（t(變數) 解析）
  "fx/",
];

/** 這些是資料不是介面文字，翻掉會壞掉（逐字比對）。目前沒有含 CJK 的資料字串；有了就加在這裡。 */
const NOT_UI = new Set([]);

/**
 * 形狀比對版的 NOT_UI：codec 名、引擎 op id。
 * 標籤表掃描會把同一行裡的每個字串都撿起來（例如 `{ id: "track.solve", title: "解算追蹤" }`），
 * 這張表讓「資料欄位」不論日後 CJK 判準放寬（全形標點、假名）都不會被當成漏翻。外掛自己的（牌碼、格位名…）在它的 i18n.config.json。
 */
const CORE_NOT_UI_RE = [
  /^(h264_nvenc|hevc_nvenc|av1_nvenc|libopenh264|libvpx-vp9|prores_ks|ffv1|aac|opus|copy)$/, // codec / encoder 名
  /^(media|seg|geom|track|comp|render|env|models|asr|captions)\.[a-z_]+$/, // 引擎 op id（計畫 §5.8；asr / captions = 動態字幕）
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function catalogKeys(path) {
  const text = readFileSync(path, "utf8");
  return new Set([...text.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)].map((m) => m[1]));
}

/**
 * 去掉字串字面量與註解：`.tsx` 裡剩下的 CJK 只可能是 **JSX 的文字內容**，
 * 也就是完全沒有包 t() 的硬寫中文 —— 上面兩種掃法都看不到它（它根本沒進任何字串）。
 *
 * 順序是先字串再註解：反過來的話字串裡的 `//`（網址之類）會被當成註解，把後面真正的內容一起吃掉。
 * 引號的規則不跨行，所以註解裡未成對的 `'`（don't）不會把後面整段吃掉。
 */
function stripStringsAndComments(src) {
  return src
    .replace(/"(?:[^"\\\n]|\\.)*"/g, " ")
    .replace(/'(?:[^'\\\n]|\\.)*'/g, " ")
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

/** 掃一個範圍（核心或一個外掛）的原始碼：回傳不在 `have` 裡的中文字串。 */
function scan({ label, srcDir, tableSources, notUi, have }) {
  const isNotUi = (s) => NOT_UI.has(s) || notUi.some((re) => re.test(s));
  const missing = [];
  for (const file of walk(srcDir)) {
    const rel = file.slice(srcDir.length + 1).replace(/\\/g, "/");
    if (rel.startsWith("locales/")) continue;
    const shown = `${label}${rel}`;
    const text = readFileSync(file, "utf8");

    for (const m of text.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)+)"/g)) {
      if (CJK.test(m[1]) && !have.has(m[1]) && !isNotUi(m[1])) missing.push({ scope: label, rel: shown, s: m[1], via: "t()" });
    }

    // 3. JSX 裡完全沒包 t() 的中文：切到英文時畫面上會直接冒出中文，而上面兩種掃法都看不到
    //    （它沒有進任何字串，所以既不是 t("字面量") 也不是標籤表的值）。
    //
    //    判準是「夾在 > 與 < 之間」＝ JSX 的文字節點。不用「剩下的 CJK 都算」是因為
    //    正則字面量（`/已存在|exists/i`）裡的中文會被誤報，而要正確剝掉正則就得先分辨
    //    `/` 是除法還是正則 —— 那是 parser 的工作，不是 lint 腳本的。
    if (rel.endsWith(".tsx")) {
      const stripped = stripStringsAndComments(text);
      // 文字節點裡不會有 ;()= —— 排除它們，箭頭函式的 `=>` 才不會當成開頭把後面好幾行程式碼一起吞進來
      for (const m of stripped.matchAll(/>([^<>;()=]*[一-鿿][^<>;()=]*)</g)) {
        const s = m[1].replace(/\{[^{}]*\}/g, "").trim();
        if (s && CJK.test(s)) missing.push({ scope: label, rel: `${shown}:${stripped.slice(0, m.index).split("\n").length}`, s, via: "JSX 沒包 t()" });
      }
    }

    if (tableSources.some((s) => (s.endsWith("/") ? rel.startsWith(s) : rel === s))) {
      for (const line of text.split("\n")) {
        const st = line.trim();
        if (st.startsWith("//") || st.startsWith("*") || st.startsWith("/*")) continue;
        for (const m of line.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
          const s = m[1].trim();
          if (s && CJK.test(s) && !have.has(s) && !isNotUi(s)) missing.push({ scope: label, rel: shown, s, via: "label table" });
        }
      }
    }
  }
  return missing;
}

const coreCatalogPath = join(ROOT, "src", "locales", "en.ts");
if (!existsSync(coreCatalogPath)) {
  console.error(`[check-i18n] 找不到 ${coreCatalogPath}：en 目錄是唯一的翻譯來源，沒有它就沒有東西可稽核`);
  process.exit(1);
}
const coreKeys = catalogKeys(coreCatalogPath);

const missing = scan({ label: "", srcDir: join(ROOT, "src"), tableSources: CORE_TABLE_SOURCES, notUi: CORE_NOT_UI_RE, have: coreKeys });
const problems = [];
const summary = [`en ${coreKeys.size}`];

// 外掛：plugins/<id>/frontend（開源版沒有 plugins/，這一段什麼都不做）
const PLUGINS = join(ROOT, "plugins");
for (const id of existsSync(PLUGINS) ? readdirSync(PLUGINS).sort() : []) {
  const srcDir = join(PLUGINS, id, "frontend");
  if (!existsSync(srcDir) || !statSync(srcDir).isDirectory()) continue;
  const cfgPath = join(srcDir, "i18n.config.json");
  const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8")) : {};
  const catPath = join(srcDir, "locales", "en.ts");
  const own = existsSync(catPath) ? catalogKeys(catPath) : new Set();
  for (const k of own) if (coreKeys.has(k)) problems.push(`  plugins/${id}/frontend/locales/en.ts：「${k}」核心目錄已經有了（核心優先，這一份用不到）`);
  const have = new Set([...coreKeys, ...own]);
  const notUi = [...CORE_NOT_UI_RE, ...(cfg.notUi ?? []).map((s) => new RegExp(s))];
  missing.push(...scan({ label: `plugins/${id}/frontend/`, srcDir, tableSources: cfg.tableSources ?? [], notUi, have }));
  summary.push(`${id} ${own.size}`);
}

// 同一句只報一次（核心與每個外掛各自算：外掛缺的那一句核心可能有、也可能沒有）
const seen = new Set();
const uniq = missing.filter((x) => {
  const key = `${x.scope}\0${x.s}`;
  return !seen.has(key) && seen.add(key);
});

if (uniq.length || problems.length) {
  if (uniq.length) {
    console.error(`[check-i18n] ${uniq.length} 個字串沒有進 en 目錄：`);
    // --all：全部列出（補翻譯時用）
    const limit = process.argv.includes("--all") ? Infinity : 40;
    for (const x of uniq.slice(0, limit)) console.error(`  ${x.rel} (${x.via}): ${x.s}`);
    if (uniq.length > limit) console.error(`  …還有 ${uniq.length - limit} 個`);
  }
  if (problems.length) {
    console.error(`[check-i18n] ${problems.length} 個外掛譯文跟核心重複：`);
    for (const p of problems) console.error(p);
  }
  process.exit(1);
}

console.log(`[check-i18n] OK（${summary.join(" · ")}）`);
