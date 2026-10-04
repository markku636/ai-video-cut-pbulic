import { create } from "zustand";
import type { ProjectExtras } from "../project/extras";
import type { JsonValueLite } from "../project/format";
import { useProject } from "./project";

/**
 * 專案檔頂層的 extras（核心 schema 不認得的鍵：外掛的標記 / 揭露句子、沒裝的外掛的頂層鍵…）。
 * **不在 undo 裡**（專案設定用 toast.undo，不變量 I5）。
 *
 * 載入時 store/project.ts loadFrom 收進來（不標 dirty），存檔時用 withProjectExtras 接回去 ——
 * UI 存檔從不丟掉任何一個不認得的頂層鍵（不變量 I2）。外掛讀寫自己的鍵也走這裡（patch）。
 */
interface ProjectExtrasStore {
  extras: ProjectExtras;
  /** 載入（不標 dirty）。 */
  load: (x: ProjectExtras) => void;
  reset: () => void;
  /** undefined = 刪鍵。預設標 dirty。 */
  patch: (p: Record<string, JsonValueLite | undefined>, opts?: { dirty?: boolean }) => void;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function markDirty(opts?: { dirty?: boolean }): void {
  if (opts?.dirty === false) return;
  useProject.getState().markDirty();
}

export const useProjectExtras = create<ProjectExtrasStore>((set, get) => ({
  extras: {},
  load: (x) => set({ extras: x }),
  reset: () => set((s) => (Object.keys(s.extras).length ? { extras: {} } : s)),
  patch: (p, opts) => {
    const cur = get().extras;
    const next: Record<string, JsonValueLite> = { ...cur };
    let changed = false;
    for (const [k, v] of Object.entries(p)) {
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      if (v === undefined) {
        if (k in next) {
          delete next[k];
          changed = true;
        }
      } else if (!same(next[k], v)) {
        next[k] = v;
        changed = true;
      }
    }
    if (!changed) return;
    set({ extras: next });
    markDirty(opts);
  },
}));
