// push 前的祕密掃描：只掃 git 追蹤的檔案，找 API key / token 樣式與不該入庫的檔名。
// 有命中就 exit 1（npm run check 會擋）。
//
// 本專案沒有雲端金鑰，但仍有三種東西會不小心進來：
//   * Hugging Face token（hf_…）—— 選配 SAM 3 是 gated 模型，有人會為了下載把 token 貼進腳本；
//   * `*.aivc.json` 專案檔 —— 裡面是使用者的媒體路徑與偵測結果（fixtures/ 下的 golden 除外）；
//   * `.env.local` —— AIVC_PYTHON 之類的本機路徑。
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 路徑有空白時 import.meta.url 會是 %20，一定要走 fileURLToPath；cwd 不一定在 repo（agent / CI 都會換目錄）
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const files = execSync("git ls-files", { encoding: "utf-8", cwd: ROOT })
  .split(/\r?\n/)
  .filter(Boolean);

const badNames = files
  .filter((f) => /(^|\/)\.env(\..*)?$/.test(f) && !f.endsWith(".env.example"))
  // 專案檔不入庫；任何 fixtures/ 目錄下的是刻意提交的 golden（根目錄的給 TS migrate() 測試、
  // engine/tests/fixtures/ 的給 Python schema 測試 —— 計畫 §5.6 兩邊共用同一份；.gitignore 也放行）
  .concat(files.filter((f) => f.endsWith(".aivc.json") && !/(^|\/)fixtures\//.test(f)));

const patterns = [
  { name: "X-API-Key literal", re: /x-api-key\s*[:=]\s*["']?[A-Za-z0-9_\-]{12,}/i },
  { name: "AIVC_* secret value", re: /\bAIVC_[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)\s*=\s*["']?[A-Za-z0-9_\-]{8,}/ },
  { name: "HF_TOKEN value", re: /\bHF_TOKEN\s*=\s*["']?hf_[A-Za-z0-9]{8,}/ },
  { name: "Hugging Face token", re: /\bhf_[A-Za-z0-9]{30,}\b/ },
  { name: "Anthropic key", re: /sk-ant-[A-Za-z0-9_\-]{20,}/ },
  { name: "generic sk- key", re: /\bsk-[A-Za-z0-9]{24,}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "Bearer literal", re: /Bearer\s+[A-Za-z0-9_\-\.]{24,}/ },
];

const hits = [];
for (const f of files) {
  // 二進位 / 媒體 / 模型 / lock 檔不掃：掃了只會有假命中（lock 裡的 integrity hash 長得像 token）
  if (/\.(png|ico|icns|jpg|jpeg|webp|woff2?|mp3|wav|ogg|webm|mp4|mkv|mov|aivm|pt|pth|safetensors|onnx|zip|lock)$/i.test(f)) continue;
  let text;
  try {
    text = readFileSync(join(ROOT, f), "utf-8");
  } catch {
    continue;
  }
  for (const p of patterns) {
    const m = text.match(p.re);
    if (m) hits.push(`${f}: ${p.name} → ${m[0].slice(0, 24)}…`);
  }
}

if (badNames.length || hits.length) {
  console.error("[check-secrets] 發現不該入庫的內容：");
  for (const n of badNames) console.error("  tracked secret file:", n);
  for (const h of hits) console.error("  ", h);
  process.exit(1);
}
console.log(`[check-secrets] OK（掃描 ${files.length} 個檔案）`);
