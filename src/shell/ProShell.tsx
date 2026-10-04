import { selectActiveMedia, useProject } from "../store/project";
import MenuBar from "./MenuBar";
import SetupBanner from "./SetupBanner";
import Sidebar from "./Sidebar";
import Splitter from "./Splitter";
import StartScreen from "./StartScreen";
import StatusBar from "./StatusBar";
import Toolbar from "./Toolbar";
import Workspace from "./Workspace";
import { useResizable } from "./useResizable";

/** 專業殼（v1 唯一的殼）：選單列 · 工具列 · 設定橫幅 · [媒體 / 鏡頭 | 舞台 + 時間軸 | Inspector] · 狀態列。 */
export default function ProShell() {
  const active = useProject(selectActiveMedia);
  const sidebar = useResizable({ storageKey: "aivc:sidebarW", initial: 272, min: 200, max: () => window.innerWidth * 0.35, axis: "x" });

  return (
    <>
      <MenuBar />
      <Toolbar />
      <SetupBanner />
      <div className="flex-1 flex min-h-0">
        <Sidebar width={sidebar.size} />
        <Splitter axis="x" onPointerDown={sidebar.onPointerDown} />
        {active ? <Workspace /> : <StartScreen />}
      </div>
      <StatusBar />
    </>
  );
}
