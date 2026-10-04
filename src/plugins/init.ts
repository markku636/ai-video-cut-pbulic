// 外掛登記之後補一次「store 建立時還不知道有外掛」的預設值。
//
// 外掛模組一定會 import 核心的 store，所以 store 一定比外掛先建好：建立當下讀到的分頁清單、預設工作模式、
// 外掛的專案層初值都是「沒有外掛」的版本。這裡在登記完之後重算一次（只動「還沒被使用者碰過」的狀態）。
// 測試裡登記外掛之後也呼叫這一支（plugins/<id>/frontend 的測試輔助）。
import { initialPluginProject } from "../project/format";
import { defaultProfileId } from "../project/profiles";
import { useEdits } from "../store/edits";
import { useProject } from "../store/project";
import { useUi } from "../store/ui";

export function initPluginDefaults(): void {
  // 分頁 / 工作模式：localStorage 裡存的外掛分頁（例如「牌」）現在認得了
  useUi.getState().rehydrate();
  // 新專案的工作模式：還沒開任何東西才換（已經開了專案就是專案檔說了算）
  const p = useProject.getState();
  if (!p.path && !p.media.length && !p.dirty) useProject.setState({ profile: defaultProfileId() });
  // 外掛的專案層初值（例如預設牌組）：已經有值的鍵不動
  const e = useEdits.getState();
  const init = initialPluginProject();
  if (Object.keys(init).some((k) => !(k in e.pluginProject))) useEdits.setState({ pluginProject: { ...init, ...e.pluginProject } });
}
