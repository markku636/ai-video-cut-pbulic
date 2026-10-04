// 外掛探索：`plugins/<id>/frontend/index.ts`（default export = AivcPlugin）。main.tsx 第一個 import 這支。
//
// 這是核心**唯一**碰到 plugins/ 的地方，而且是用 import.meta.glob：資料夾不存在時 glob 是空物件，
// 開源版（沒有 plugins/）照樣編得過、跑得動，只是沒有任何外掛。
import type { AivcPlugin } from "./api";
import { initPluginDefaults } from "./init";
import { registerPlugin } from "./registry";

const FOUND = import.meta.glob<{ default: AivcPlugin }>("../../plugins/*/frontend/index.ts", { eager: true });

/** 找到的外掛（依路徑排序，登記順序穩定）。 */
export function discoveredPlugins(): AivcPlugin[] {
  return Object.keys(FOUND)
    .sort()
    .map((k) => FOUND[k].default)
    .filter((p): p is AivcPlugin => !!p && typeof p.id === "string");
}

/** 登記所有找到的外掛，並補上「store 建立時還不知道有外掛」的預設值。冪等。 */
export function installPlugins(): void {
  for (const p of discoveredPlugins()) registerPlugin(p);
  initPluginDefaults();
}

installPlugins();
