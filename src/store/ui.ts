// 介面外觀狀態（右側欄分頁 / 寬度 / 密度）。存 localStorage —— 這些是「習慣」，
// 不是專案內容，不該進專案檔、也不該跟著檔案走。
import { create } from "zustand";
import { defaultRailTab, isRailTab } from "../inspector/tabs";
import { workProfile } from "../project/profiles";

/**
 * Inspector 分頁 id（計畫 §8：track / mask / jobs / history / assistant；feat/captions 加 captions 字幕；M2.15 加 clip）。
 * 外掛可以加自己的分頁（例如 cards 的「牌」），所以是字串；清單與預設分頁見 inspector/tabs.ts。
 */
export type RailTab = string;
export type Density = "compact" | "normal" | "comfortable";
/**
 * 簡易 / 專業。v1 只有 Pro 殼（計畫 §8「只有 Pro 殼」）；型別與 Command.simple* 欄位保留不用，
 * 日後要做小白模式時不必再改註冊表。
 */
export type UiMode = "simple" | "pro";
/** 開始畫面選的「你想做什麼」= 專案 profile（核心的 generic 或外掛的；清單見 project/profiles.ts）。 */
export type WorkProfile = string;

/** 密度 → 根字級縮放。CSS 變數 --ui-scale 由 applyDensity 寫到 <html>。 */
export const DENSITY_SCALE: Record<Density, number> = {
  compact: 0.9,
  normal: 1,
  comfortable: 1.15,
};

const KEY = "aivc:ui";
const RAIL_MIN = 260;
const RAIL_MAX = 620;

interface Persisted {
  tab: RailTab;
  railOpen: boolean;
  railWidth: number;
  density: Density;
  mode: UiMode;
  profile: WorkProfile | null;
  /** 已經按過「知道了」的首次提示 id。 */
  hintsSeen: string[];
}

/** 預設值。分頁看有哪些外掛（呼叫當下才算：store 建立時外掛可能還沒登記，登記之後 plugins/init.ts 會 rehydrate）。 */
function defaults(): Persisted {
  return { tab: defaultRailTab(), railOpen: true, railWidth: 340, density: "normal", mode: "pro", profile: null, hintsSeen: [] };
}

/**
 * 從 localStorage 的字串還原（純函式，測試用）。
 * v1 只有專業殼，所以不論有沒有存過都是 pro；`mode` 欄位仍收下來（日後有簡易殼時老用戶的選擇不會丟）。
 * 分頁 / 工作模式只收「現在認得的」（外掛被拿掉之後殘留的值退回預設）。
 */
export function parsePersisted(raw: string | null): Persisted {
  const DEFAULTS = defaults();
  if (!raw) return DEFAULTS;
  try {
    const v = JSON.parse(raw) as Partial<Persisted>;
    return {
      tab: isRailTab(v.tab) ? v.tab : DEFAULTS.tab,
      railOpen: v.railOpen !== false,
      railWidth: Math.max(RAIL_MIN, Math.min(RAIL_MAX, Number(v.railWidth) || DEFAULTS.railWidth)),
      density: v.density === "compact" || v.density === "comfortable" ? v.density : "normal",
      mode: "pro",
      profile: typeof v.profile === "string" && workProfile(v.profile) ? v.profile : null,
      hintsSeen: Array.isArray(v.hintsSeen) ? v.hintsSeen.filter((x): x is string => typeof x === "string") : [],
    };
  } catch {
    return DEFAULTS;
  }
}

function load(): Persisted {
  try {
    return parsePersisted(localStorage.getItem(KEY));
  } catch {
    return defaults();
  }
}

function save(p: Persisted) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* 私密視窗 / 停用儲存 */
  }
}

/** 把密度寫進 <html> 的 CSS 變數（styles.css 用它縮放字級與列高）。 */
export function applyDensity(d: Density) {
  document.documentElement.style.setProperty("--ui-scale", String(DENSITY_SCALE[d]));
}

interface UiStore extends Persisted {
  setTab: (t: RailTab) => void;
  /** 點同一個分頁 = 收合；點別的 = 切過去並展開。 */
  toggleTab: (t: RailTab) => void;
  setRailOpen: (v: boolean) => void;
  setRailWidth: (w: number) => void;
  setDensity: (d: Density) => void;
  setMode: (m: UiMode) => void;
  setProfile: (p: WorkProfile | null) => void;
  markHintSeen: (id: string) => void;
  /** 重新讀 localStorage（外掛登記之後：store 建立時還不知道外掛的分頁 / 工作模式）。不寫回。 */
  rehydrate: () => void;
  /** 拖檔案進視窗的高亮（暫態）。 */
  dragOver: boolean;
  setDragOver: (v: boolean) => void;
}

export const useUi = create<UiStore>((set, get) => {
  const init = load();
  const persist = () => {
    const s = get();
    save({ tab: s.tab, railOpen: s.railOpen, railWidth: s.railWidth, density: s.density, mode: s.mode, profile: s.profile, hintsSeen: s.hintsSeen });
  };
  return {
    ...init,
    dragOver: false,
    rehydrate: () => set(load()),
    setDragOver: (dragOver) => set((s) => (s.dragOver === dragOver ? s : { dragOver })),
    setProfile: (profile) => {
      set({ profile });
      persist();
    },
    markHintSeen: (id) => {
      set((s) => (s.hintsSeen.includes(id) ? s : { hintsSeen: [...s.hintsSeen, id] }));
      persist();
    },
    setTab: (tab) => {
      set({ tab, railOpen: true });
      persist();
    },
    toggleTab: (tab) => {
      const s = get();
      set(s.railOpen && s.tab === tab ? { railOpen: false } : { tab, railOpen: true });
      persist();
    },
    setRailOpen: (railOpen) => {
      set({ railOpen });
      persist();
    },
    setRailWidth: (w) => {
      set({ railWidth: Math.max(RAIL_MIN, Math.min(RAIL_MAX, w)) });
      persist();
    },
    setDensity: (density) => {
      set({ density });
      applyDensity(density);
      persist();
    },
    setMode: (mode) => {
      set({ mode });
      persist();
    },
  };
});

export const RAIL_LIMITS = { min: RAIL_MIN, max: RAIL_MAX };
