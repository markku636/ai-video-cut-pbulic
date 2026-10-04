import { Activity, Bot, Boxes, Captions, Clapperboard, Crosshair, History, Lasso, ListChecks, Shapes, Sparkles, SquareDashed, Subtitles, Target, type LucideIcon } from "lucide-react";
import type { InspectorTabContribution } from "../plugins/api";
import { collect } from "../plugins/registry";
import { TAB_LABEL, type CoreInspectorTab } from "./labels";

/**
 * 右側欄分頁的中繼資料（核心的 + 外掛的），依 order 排序。面板元件在 Inspector.tsx（核心）／外掛的 panel。
 * 這裡**不 import 任何面板**：指令表（view.rail.*）與 ui store 也要讀分頁清單，不該因此把整個 Inspector 拉進來。
 *
 * 字幕排在「物件遮罩」之後：前四個是「對畫面做事」，後三個是工作 / 歷史 / 助手；
 * 片段（M2.15，序列剪輯）接在字幕後面：同樣是「對畫面 / 成品做事」的那一組。外掛的分頁依它宣告的 order 插進來。
 */
export interface RailTabMeta {
  id: string;
  /** zh key */
  label: string;
  /** zh key：「檢視 › 側欄」指令的標題；沒有 = 不登記指令。 */
  railTitle?: string;
  icon: LucideIcon;
  railIcon?: LucideIcon;
  order: number;
  default?: boolean;
}

const CORE_TABS: readonly (RailTabMeta & { id: CoreInspectorTab })[] = [
  // 物件排第一：開源版的主要用途是「追蹤任何東西，然後編輯它」（平面追蹤是其中一種）
  { id: "objects", label: TAB_LABEL.objects, railTitle: "側欄：物件", icon: Shapes, railIcon: Boxes, order: 5 },
  { id: "track", label: TAB_LABEL.track, railTitle: "側欄：追蹤", icon: Crosshair, railIcon: Target, order: 10 },
  { id: "mask", label: TAB_LABEL.mask, railTitle: "側欄：遮罩", icon: Lasso, railIcon: SquareDashed, order: 20 },
  { id: "captions", label: TAB_LABEL.captions, railTitle: "側欄：字幕", icon: Captions, railIcon: Subtitles, order: 30 },
  { id: "clip", label: TAB_LABEL.clip, icon: Clapperboard, order: 40 },
  { id: "jobs", label: TAB_LABEL.jobs, railTitle: "側欄：工作", icon: Activity, railIcon: ListChecks, order: 50 },
  { id: "history", label: TAB_LABEL.history, railTitle: "側欄：歷史", icon: History, railIcon: History, order: 60 },
  { id: "advice", label: TAB_LABEL.advice, railTitle: "側欄：建議", icon: Sparkles, railIcon: Sparkles, order: 70 },
  { id: "assistant", label: TAB_LABEL.assistant, railTitle: "側欄：AI 助手", icon: Bot, railIcon: Bot, order: 80 },
];

/** 核心沒有任何外掛宣告預設分頁時，第一次啟動打開的分頁。 */
export const CORE_DEFAULT_TAB: CoreInspectorTab = "objects";

export function pluginTabs(): InspectorTabContribution[] {
  return collect((p) => p.inspectorTabs);
}

/** 所有分頁（核心的 + 外掛的），依 order 排序（同 order 核心在前）。 */
export function railTabs(): RailTabMeta[] {
  const list: RailTabMeta[] = [...CORE_TABS, ...pluginTabs()];
  return list.map((t, i) => ({ t, i })).sort((a, b) => a.t.order - b.t.order || a.i - b.i).map((x) => x.t);
}

export function isRailTab(v: unknown): v is string {
  return typeof v === "string" && railTabs().some((t) => t.id === v);
}

/** 第一次啟動（沒存過）或存的分頁已經不存在（外掛被移除）時打開的分頁。 */
export function defaultRailTab(): string {
  return railTabs().find((t) => t.default)?.id ?? CORE_DEFAULT_TAB;
}
