// 外掛登記表：只有一張清單，**不 import 任何 store 或 UI**（核心各處在「呼叫當下」來問，不在模組載入時快取）。
//
// 為什麼不在模組載入時就算好：外掛模組一定會 import 核心的 store，所以 store 一定比外掛先建好 ——
// 在 store 建立時就讀外掛（預設分頁、預設工作模式…）只會讀到空清單。登記之後由 src/plugins/init.ts 補一次。
import type { AivcPlugin } from "./api";

const list: AivcPlugin[] = [];
let version = 0;

/** 登記（同 id 再登記一次 = 取代，熱更新冪等）。 */
export function registerPlugin(p: AivcPlugin): void {
  const i = list.findIndex((x) => x.id === p.id);
  if (i >= 0) list[i] = p;
  else list.push(p);
  version++;
}

/** 目前登記的外掛（依登記順序）。 */
export function plugins(): readonly AivcPlugin[] {
  return list;
}

/** 登記表變了幾次（給需要快取的呼叫端比對）。 */
export function pluginsVersion(): number {
  return version;
}

/** 測試用：清空。 */
export function resetPlugins(): void {
  list.length = 0;
  version++;
}

/** 把每個外掛的某個陣列型接點攤平成一份（依登記順序）。 */
export function collect<T>(pick: (p: AivcPlugin) => readonly T[] | undefined): T[] {
  const out: T[] = [];
  for (const p of list) {
    const xs = pick(p);
    if (xs) out.push(...xs);
  }
  return out;
}
