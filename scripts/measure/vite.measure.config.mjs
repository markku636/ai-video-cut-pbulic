// 量尺專用的 Vite 設定：跟 vite.config.ts 一樣，只是關掉 HMR 與檔案監看。
//
// 為什麼要有：App 模式的量尺一跑就是一分鐘以上（seq-playback.mjs 的漂移要播滿 60 s），
// 期間有人存檔（或平行的 worktree 工作在改檔），HMR 會把模組換掉、甚至把整棵 App 疊第二份上去（README「兩個會讓你白量的坑」第 1 條），
// 量出來的數字就不算數。關掉之後頁面載入時是哪一版就量哪一版。
//
// 用法：npx vite --config scripts/measure/vite.measure.config.mjs，再另外啟動 debug 版 App（見 README.md）。
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vite";
import base from "../../vite.config.ts";

export default mergeConfig(base, {
  root: fileURLToPath(new URL("../..", import.meta.url)),
  server: { hmr: false, watch: { ignored: ["**/*"] } },
});
