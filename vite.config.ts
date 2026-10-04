import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 版本號單一事實來源：package.json（scripts/sync-version.mjs 鏡射到 tauri.conf.json / Cargo.toml / _version.py），
// 建置期注入 __APP_VERSION__。
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf-8"),
) as { version: string };

// 外掛（plugins/<id>/frontend/）從核心拿東西一律走 `@core/…`（= src/…）。tsconfig.json 的 paths 是同一張表；
// vitest 讀的也是這份設定 —— 別名只設在 tsc 那邊的話，測試會在 import 時才炸（以前真的發生過）。
const CORE_DIR = fileURLToPath(new URL("./src/", import.meta.url)).replace(/\\/g, "/");

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  resolve: {
    alias: [{ find: /^@core\//, replacement: CORE_DIR }],
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return "react-vendor";
        },
      },
    },
    chunkSizeWarningLimit: 700,
  },
  test: {
    environment: "node",
    // 外掛的測試跟著外掛走（plugins/ 不存在時這一條什麼都不收，開源版照樣跑得起來）
    include: ["src/**/*.test.ts", "plugins/*/frontend/**/*.test.ts"],
  },
});
