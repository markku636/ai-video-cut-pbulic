// README 截圖用的 Vite 設定：跟 vite.config.ts 一模一樣，只是**不載入任何外掛**（plugins/<id>/frontend）。
//
// README 與部落格的截圖要呈現開源版（只有核心）：開始畫面四張通用卡片、分頁列沒有外掛的分頁。
// 不必搬動 plugins/ 資料夾 —— 這裡把 src/plugins/index.ts 的 import.meta.glob 換成空物件，效果等同「沒有 plugins/」。
//
// 用法（見 scripts/make-screenshots.mjs 開頭）：
//   npm run tauri dev -- --config scripts/screenshots.tauri.json
// （那份 overlay 把 beforeDevCommand 換成 `npx vite --config scripts/screenshots.vite.config.mjs`）
import base from "../vite.config.ts";

const coreOnly = {
  name: "aivc-screenshots-core-only",
  enforce: "pre",
  transform(code, id) {
    if (!id.replace(/\\/g, "/").endsWith("/src/plugins/index.ts")) return null;
    const out = code.replace(/import\.meta\.glob<([^>]*\})>\([^)]*\)/, "({} as Record<string, $1>)");
    if (out === code) throw new Error("screenshots.vite.config.mjs：src/plugins/index.ts 的 import.meta.glob 寫法變了，更新這裡的取代規則");
    return { code: out, map: null };
  },
};

export default { ...base, plugins: [coreOnly, ...(base.plugins ?? [])] };
