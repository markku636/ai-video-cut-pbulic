import { useUi } from "../store/ui";
import { isRecord } from "../project/format";
import type { InspectorTab } from "./labels";
import { defaultRailTab, isRailTab, railTabs } from "./tabs";

/**
 * Inspector 端的契約轉接：store 三件（project / edits / engine）從 stage/_contracts 再匯出（單一落點），
 * 加上右側欄分頁的轉接器。
 *
 * store/ui.ts 的 tab 存的是分頁 id（核心的或外掛的）；`useRailTab` 擋掉 localStorage 裡殘留的舊值
 * 與「外掛已經不在」的分頁，退回預設分頁。
 */
export { useEdits, useEngine, useProject } from "../stage/_contracts";
export type { EditPatchLike, EditsStateLike, EngineStateLike, MediaItemLike, ProjectStateLike } from "../stage/_contracts";
export type { InspectorTab } from "./labels";

/** 目前所有分頁的 id（核心 + 外掛，依順序）。 */
export function inspectorTabs(): InspectorTab[] {
  return railTabs().map((t) => t.id);
}

export function isInspectorTab(v: unknown): v is InspectorTab {
  return isRailTab(v);
}

export function useRailTab(): InspectorTab {
  const tab = useUi((s) => s.tab);
  return isInspectorTab(tab) ? tab : defaultRailTab();
}

export function toggleRailTab(tab: InspectorTab): void {
  useUi.getState().toggleTab(tab);
}

export function setRailTab(tab: InspectorTab): void {
  useUi.getState().setTab(tab);
}

/** 讀 useUi 上「可能還沒有」的欄位（例如日後的 hintsSeen 之外的旗標）時用；現在只給測試 / 除錯。 */
export function uiFlag(name: string): boolean {
  const s: unknown = useUi.getState();
  return isRecord(s) && s[name] === true;
}
