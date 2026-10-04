import { useEffect } from "react";
import FrameTimeline from "../frametimeline/FrameTimeline";
import Inspector from "../inspector/Inspector";
import VideoStage from "../stage/VideoStage";
import Transport from "../stage/Transport";
import { ensureProxy } from "../pipeline/proxy";
import { collect } from "../plugins/registry";
import { loadSolve } from "../pipeline/track";
import { engineReady, useEngine } from "../store/engine";
import { useEdits } from "../store/edits";
import { usePlayback } from "../store/playback";
import { selectActiveMedia, useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { useUi, RAIL_LIMITS } from "../store/ui";
import Splitter from "./Splitter";
import { useResizable } from "./useResizable";

/**
 * 工作區（計畫 §8 Workspace）：[ 舞台（上） / 幀時間軸（下） ] | Inspector（右）。
 * 三個主角各自一個目錄（stage/、frametimeline/、inspector/），這裡只做版面與「換媒體時要做的事」。
 */
export default function Workspace() {
  const active = useProject(selectActiveMedia);
  const mediaId = active?.id ?? null;
  const railOpen = useUi((s) => s.railOpen);
  const railWidth = useUi((s) => s.railWidth);
  const setRailWidth = useUi((s) => s.setRailWidth);
  const timeline = useResizable({ storageKey: "aivc:timelineH", initial: 260, min: 140, max: () => window.innerHeight * 0.6, axis: "y" });
  const rail = useResizable({ storageKey: "aivc:railW", initial: railWidth, min: RAIL_LIMITS.min, max: RAIL_LIMITS.max, axis: "x", invert: true });
  const engineUp = useEngine((s) => s.info?.state === "ready");
  const tracks = useEdits((s) => (mediaId ? s.tracks[mediaId] : undefined));

  // 側欄寬度存兩份（useResizable 的 localStorage 與 ui store）；以拖曳結果為準同步回 store
  useEffect(() => {
    if (rail.size !== railWidth) setRailWidth(rail.size);
  }, [rail.size, railWidth, setRailWidth]);

  // 換媒體：播放線回 0、清選取、清範圍（選取只在真的換檔案時才清 —— ai-music-cut 的教訓）
  useEffect(() => {
    usePlayback.getState().seek(0);
    usePlayback.getState().setPlaying(false);
    const tl = useTimeline.getState();
    tl.selectTrack(null);
    tl.setRange(null);
    tl.fit();
  }, [mediaId]);

  // 引擎一就緒（或換媒體）：proxy 缺就補建
  useEffect(() => {
    if (mediaId && engineUp && engineReady()) void ensureProxy(mediaId).catch(() => {});
  }, [mediaId, engineUp]);

  // 專案載入後解算結果在快取裡：每條 track 讀一次 solve.v1.json（缺就算 stale）
  useEffect(() => {
    if (!mediaId || !tracks) return;
    for (const t of tracks) void loadSolve(mediaId, t.id);
    // 只在 track 清單「成員」變動時重讀，不是每次改關鍵幀都重讀
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId, tracks?.map((t) => t.id).join(",")]);

  if (!active) return null;
  // 外掛掛在工作區的層（例如牌外掛：[影片 | 牌局] 檢視列與蓋住舞台與時間軸的牌局檢視）
  const overlays = collect((p) => p.stageOverlays);

  return (
    <div className="flex-1 min-w-0 min-h-0 flex" data-testid="workspace">
      <div className="relative flex-1 min-w-0 min-h-0 flex flex-col bg-app">
        {/* 外掛的 top 層：最上面一條（不需要的專案完全不佔位）；overlay 層是最後一個子節點，蓋住舞台與時間軸 */}
        {overlays
          .filter((o) => o.slot === "top")
          .map((o) => (
            <o.component key={o.id} mediaId={mediaId} />
          ))}
        <div className="flex-1 min-h-0 relative bg-well" data-testid="stage-box">
          <VideoStage />
        </div>
        {/* 傳輸列貼在影片正下方（Resolve / Premiere 檢視器的位置），在分隔線之上：拖時間軸高度時它跟著影片走 */}
        <Transport />
        <Splitter axis="y" onPointerDown={timeline.onPointerDown} />
        <div className="shrink-0 bg-panel border-t border-fg/10 relative" style={{ height: timeline.size }} data-testid="timeline-box">
          <FrameTimeline />
        </div>
        {overlays
          .filter((o) => o.slot === "overlay")
          .map((o) => (
            <o.component key={o.id} mediaId={mediaId} />
          ))}
      </div>
      {railOpen && (
        <>
          <Splitter axis="x" onPointerDown={rail.onPointerDown} />
          <div className="shrink-0 bg-panel border-l border-fg/10 min-h-0 flex flex-col" style={{ width: rail.size }} data-testid="inspector-box">
            <Inspector />
          </div>
        </>
      )}
    </div>
  );
}
