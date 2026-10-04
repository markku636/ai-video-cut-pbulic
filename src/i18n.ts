import { useMemo } from "react";
import { create } from "zustand";
import { plugins } from "./plugins/registry";

// 介面語言。以「繁中原文」作為 translation key，查無翻譯時回傳 key 本身（identity fallback）。
// 只做繁中 + 英文（計畫 §1）：ai-music-cut 的 ja / zh-Hans 目錄不移植，少兩份會過期的翻譯表。
export type Lang = "zh-TW" | "en";

const LANG_KEY = "aivc:lang";

export const LANGUAGES: readonly { id: Lang; label: string }[] = [
  { id: "zh-TW", label: "繁體中文" },
  { id: "en", label: "English" },
];

export interface Plural {
  one: string;
  other: string;
}

export type Catalog = Readonly<Record<string, string | Plural>>;
export type Params = Readonly<Record<string, string | number>>;

function isLang(v: unknown): v is Lang {
  return LANGUAGES.some((l) => l.id === v);
}

/** 讀取偏好；無 / 不合法一律回 zh-TW。 */
export function readStoredLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (isLang(v)) return v;
  } catch {
    /* localStorage 不可用時退回預設 */
  }
  return "zh-TW";
}

/** 以 `{name}` 為佔位符做執行期取代。 */
export function interpolate(tpl: string, params?: Params): string {
  if (!params) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (whole, key: string) => (key in params ? String(params[key]) : whole));
}

function selectForm(value: string | Plural, params?: Params): string {
  if (typeof value === "string") return value;
  return params && Number(params.n) === 1 ? value.one : value.other;
}

interface LangStore {
  lang: Lang;
  catalog: Catalog;
  setLang: (l: Lang) => Promise<void>;
}

const LOADERS: Record<Exclude<Lang, "zh-TW">, () => Promise<{ default: Catalog }>> = {
  en: () => import("./locales/en"),
};

/**
 * 核心的目錄 ＋ 外掛的目錄（plugins/api.ts locales；各自 lazy 載入）。外掛的鍵只補核心沒有的：
 * 同一句中文在核心已經有譯文時以核心為準（同一個 key 兩份譯文只會讓畫面上同一句話有兩種講法）。
 */
async function loadCatalog(l: Lang): Promise<Catalog> {
  if (l === "zh-TW") return {};
  const core = (await LOADERS[l]()).default;
  const extra = await Promise.all(plugins().map((p) => p.locales?.[l]?.().then((m) => m.default) ?? Promise.resolve({} as Catalog)));
  if (!extra.some((c) => Object.keys(c).length)) return core;
  return Object.assign({}, ...extra, core) as Catalog;
}

export const useLang = create<LangStore>((set) => ({
  lang: readStoredLang(),
  catalog: {},
  setLang: async (l) => {
    const catalog = await loadCatalog(l);
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      /* ignore */
    }
    applyDocLang(l);
    // 同步進 settings.json（延遲 import：i18n.ts 不靜態相依 Tauri runtime，單元測試不會拉進 api）。
    void import("./store/settings")
      .then((m) => m.useSettings.getState().save({ lang: l }))
      .catch(() => {});
    set({ lang: l, catalog });
  },
}));

function resolve(s: Pick<LangStore, "catalog">, zh: string, params?: Params): string {
  const hit = s.catalog[zh];
  return interpolate(hit === undefined ? zh : selectForm(hit, params), params);
}

/** 翻譯（module-level，可在 React 之外呼叫）。 */
export function t(zh: string, params?: Params): string {
  return resolve(useLang.getState(), zh, params);
}

/** 元件內用：訂閱語言，使切換時重繪（參考身分綁在 catalog 上，可放進 memo 依賴）。 */
export function useT(): typeof t {
  const catalog = useLang((s) => s.catalog);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo<typeof t>(() => (zh, params) => t(zh, params), [catalog]);
}

export function htmlLangAttr(l: string): string {
  if (l.startsWith("en")) return "en";
  return "zh-Hant";
}

export function applyDocLang(l: Lang): void {
  document.documentElement.lang = htmlLangAttr(l);
}
