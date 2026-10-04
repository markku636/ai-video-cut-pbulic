import { ChevronRight, type LucideIcon } from "lucide-react";
import { useEffect, type ComponentType } from "react";
import { useT } from "../i18n";
import type { BadgeTone } from "../plugins/api";
import { useActiveMediaId, useActiveTracks } from "../stage/active";
import { flaggedCueCount } from "../store/captions";
import { useEdits } from "../store/edits";
import { useJobs } from "../store/jobs";
import { RAIL_LIMITS, useUi } from "../store/ui";
import { IconButton } from "../ui/index";
import { toggleRailTab, useRailTab, type InspectorTab } from "./_contracts";
import AdvicePanel from "./AdvicePanel";
import AssistantPanel from "./AssistantPanel";
import CaptionsPanel from "./CaptionsPanel";
// M2.15 片段頁：序列剪輯旗標開著才出現在分頁條
import ClipPanel, { useClipPanelPrefs } from "./ClipPanel";
import { useSettings } from "../store/settings";
import { useTimeline } from "../store/timeline";
import HistoryPanel from "./HistoryPanel";
import JobsPanel from "./JobsPanel";
import type { CoreInspectorTab } from "./labels";
import MaskPanel from "./MaskPanel";
import ObjectsPanel from "./ObjectsPanel";
import { pluginTabs, railTabs } from "./tabs";
import TrackPanel from "./TrackPanel";

/**
 * 右側單一側欄 + 分頁（沿 ai-music-cut RightRail；計畫 §9 Inspector）：追蹤 / 物件遮罩 / 字幕 / 工作 / 歷史 / AI 助手，
 * 外掛的分頁（例如 cards 的「牌」）依它宣告的順序插進來。
 * 分頁條永遠在（收合時就是一條窄軌），分頁上的小數字讓人不開面板也看得到「幾條 track 過期 / 幾段字幕要看 / 幾個工作在跑」。
 * 分頁狀態存 store/ui（習慣，不進專案檔）；寬度可拖。
 */
type Tone = BadgeTone;
type Badge = { n: number; tone: Tone };

const TONE_CLASS: Record<Tone, string> = {
  danger: "bg-danger text-white",
  warning: "bg-warning text-black",
  info: "bg-accent text-white",
};

const CORE_PANELS: Record<CoreInspectorTab, ComponentType> = {
  objects: ObjectsPanel,
  captions: CaptionsPanel,
  clip: ClipPanel,
  track: TrackPanel,
  mask: MaskPanel,
  jobs: JobsPanel,
  history: HistoryPanel,
  advice: AdvicePanel,
  assistant: AssistantPanel,
};

function panelOf(tab: InspectorTab): ComponentType | null {
  if (Object.prototype.hasOwnProperty.call(CORE_PANELS, tab)) return CORE_PANELS[tab as CoreInspectorTab];
  return pluginTabs().find((x) => x.id === tab)?.panel ?? null;
}

function BadgeDot({ b }: { b: Badge }) {
  if (b.n <= 0) return null;
  return <span className={`absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-0.5 rounded-full text-[9px] leading-[14px] text-center ${TONE_CLASS[b.tone]}`}>{b.n > 99 ? "99+" : b.n}</span>;
}

/** 外掛分頁的小數字：外掛給的 hook 在這個小元件裡呼叫（每個分頁一個元件，hook 的呼叫順序固定）。 */
function PluginBadge({ useBadge }: { useBadge: () => Badge }) {
  const b = useBadge();
  return <BadgeDot b={b} />;
}

function TabButton({ id, label, icon: Glyph, active, badge, useBadge }: { id: InspectorTab; label: string; icon: LucideIcon; active: boolean; badge?: Badge; useBadge?: () => Badge }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={() => toggleRailTab(id)}
      className={`relative w-7 h-7 rounded-sm grid place-items-center ${active ? "bg-accent/20 text-accent" : "text-fg/50 hover:bg-fg/5"}`}
    >
      <Glyph size={15} />
      {badge && <BadgeDot b={badge} />}
      {useBadge && <PluginBadge useBadge={useBadge} />}
    </button>
  );
}

export default function Inspector() {
  const t = useT();
  const tab = useRailTab();
  const open = useUi((s) => s.railOpen);
  const width = useUi((s) => s.railWidth);
  const setRailOpen = useUi((s) => s.setRailOpen);
  const setRailWidth = useUi((s) => s.setRailWidth);
  const tracks = useActiveTracks();
  const jobs = useJobs((s) => s.jobs);
  const mediaId = useActiveMediaId();
  // 需要人看一眼的字幕段（低信心 / 疑似幻覺 / 太快 / 排不下）
  const captionFlags = useEdits((s) => flaggedCueCount(mediaId ? s.captions[mediaId] : null));

  const stale = tracks.filter((x) => x.stale && x.kind !== "object").length;
  const failed = jobs.filter((j) => j.status === "error").length;
  const running = jobs.filter((j) => j.status === "running" || j.status === "queued").length;

  const badges: Record<CoreInspectorTab, Badge> = {
    objects: { n: 0, tone: "info" },
    captions: { n: captionFlags, tone: "warning" },
    clip: { n: 0, tone: "info" },
    track: { n: stale, tone: "warning" },
    mask: { n: 0, tone: "info" },
    jobs: failed ? { n: failed, tone: "danger" } : { n: running, tone: "info" },
    history: { n: 0, tone: "info" },
    advice: { n: 0, tone: "info" },
    assistant: { n: 0, tone: "info" },
  };

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) => setRailWidth(startW + (startX - ev.clientX));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };

  // 選到片段時自動切到「片段」頁（§12「選到片段時自動切過去」）：只在側欄開著時切（不幫使用者把收起來的側欄彈開），
  // 選取變空不切回（使用者可能正要點下一個片段）；頁面上可以關掉這個習慣
  const sequenceFlag = useSettings((s) => s.experimental.sequence);
  useEffect(
    () =>
      useTimeline.subscribe((s, prev) => {
        if (s.selectedClipIds === prev.selectedClipIds || !s.selectedClipIds.length) return;
        if (s.selectedClipIds.length === prev.selectedClipIds.length && s.selectedClipIds.every((id, i) => id === prev.selectedClipIds[i])) return;
        const ui = useUi.getState();
        if (!useSettings.getState().experimental.sequence || !useClipPanelPrefs.getState().autoSwitch || !ui.railOpen || ui.tab === "clip") return;
        ui.setTab("clip");
      }),
    [],
  );
  const all = railTabs();
  const tabs = all.filter((x) => sequenceFlag || x.id !== "clip");
  const plugin = pluginTabs();

  const Panel = panelOf(tab);
  const current = all.find((x) => x.id === tab);

  return (
    <div className="shrink-0 flex min-h-0 h-full" data-testid="inspector">
      {open && (
        <div className="relative shrink-0 bg-panel border-l border-fg/10 flex flex-col min-h-0" style={{ width, minWidth: RAIL_LIMITS.min }}>
          <div onPointerDown={startResize} title={t("拖曳調整寬度")} className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40 z-10" />
          <div className="h-9 shrink-0 flex items-center px-3 border-b border-fg/10 text-[12px] font-medium text-fg/80">{current ? t(current.label) : null}</div>
          <div className="flex-1 min-h-0 flex flex-col">{Panel && <Panel />}</div>
        </div>
      )}
      {/* 分頁條永遠在，收合時就是一條窄軌 */}
      <div className="w-9 shrink-0 bg-bar border-l border-fg/10 flex flex-col items-center py-1.5 gap-1">
        {open && <IconButton icon={ChevronRight} label={t("收合側欄")} iconSize={15} box="w-7 h-7" onClick={() => setRailOpen(false)} />}
        {tabs.map((x) => {
          const core = Object.prototype.hasOwnProperty.call(badges, x.id) ? badges[x.id as CoreInspectorTab] : undefined;
          return <TabButton key={x.id} id={x.id} label={t(x.label)} icon={x.icon} active={open && tab === x.id} badge={core} useBadge={plugin.find((p) => p.id === x.id)?.useBadge} />;
        })}
      </div>
    </div>
  );
}
