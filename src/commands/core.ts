import { ChevronsLeft, ChevronsRight, Cog, Columns2, Crop, Diff, Download, Eye, FilePlus, FileText, FolderOpen, Grid3x3, History, Info, Keyboard, Languages, Layers, Lock, Moon, Move3d, Palette, PanelRight, Play, Redo2, Repeat, Save, Scissors, ScrollText, Search, SkipBack, SkipForward, Square, SquareDashed, Target, Trash2, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { LANGUAGES, useLang } from "../i18n";
import { openDialog, useDialogs } from "../store/dialogs";
import { useEdits } from "../store/edits";
import { usePlayback } from "../store/playback";
import { selectActiveMedia, useProject } from "../store/project";
import { sequenceEditingEnabled, useSettings } from "../store/settings";
import { effectiveSpace, useTimeline } from "../store/timeline";
import { useUi, type Density } from "../store/ui";
import { railTabs } from "../inspector/tabs";
import { workProfiles } from "../project/profiles";
import { sequencePlayhead, viewSequenceOf } from "../frametimeline/layoutSequence";
import { durationFrames } from "../sequence/map";
import { selectionSpan } from "../sequence/selectionSpan";
import { ASPECT_GUIDES } from "../stage/aspectGuide";
import { useStage, type ViewMode } from "../stage/viewMode";
import { useTheme } from "../theme";
import { THEMES } from "../themes";
import { VIEW_MODE_LABEL } from "../video/labels";
import * as A from "./appActions";
import { needsAnyTrack, needsHistory, needsKeyframe, needsMedia, needsProxy, needsRange, needsShot, needsTrack } from "./guards";
import { OK } from "./registry";
import type { Command, CommandGroup, Surface } from "./types";
import { withUndoToast } from "./undoToast";
import { t } from "../i18n";
// 傳輸列（播放群組）用到的：獨立一段 import，免得跟其他群組改同一行的 import 清單互相覆蓋
import { CirclePlay, Crosshair, FastForward, Gauge, Hash, ListVideo, Rewind, Volume2 } from "lucide-react";
import { SPEEDS } from "../store/playback";
import * as P from "../stage/playerRef";
// 吸附開關（view.toggleSnap）：同樣獨立一段 import
import { Magnet, SlidersHorizontal } from "lucide-react";
import { useSnap } from "../frametimeline/trimDrag";
import { toast } from "../ui";
import { bumpCommandTick } from "./registry";

/**
 * 核心指令表：檔案 / 編輯 / 檢視 / 播放 / 說明（計畫 §9「指令」）。追蹤 / 調整 / 遮罩在 trackCommands.ts，輸出在 exportCommands.ts；
 * 外掛的指令由外掛登記（plugins/api.ts commands）。
 *
 * 每一條的 title 是 zh key（會 t() 過），所以這個目錄在 scripts/check-i18n.mjs 的 TABLE_SOURCES 裡。
 * 快捷鍵寫在這裡就是唯一的一份：hotkeys.ts 派發、ShortcutsHelp 列表、tooltip 都從這裡讀。
 */

// ---- 播放選取 / 繞著播放線播（Final Cut 的 Play Selection `/` 與 Play Around `Shift+/`）----

/** 目前要剪的序列（序列空間才有）；素材空間或 proxy 還沒好 → null。 */
function seqNow() {
  if (effectiveSpace(useTimeline.getState().space, sequenceEditingEnabled()) !== "sequence") return null;
  return viewSequenceOf(useEdits.getState().sequence, selectActiveMedia(useProject.getState()) ?? null);
}

/** 選取的片段涵蓋的序列幀區間；沒在序列空間、沒選、或選的都已不存在 → null。 */
function selectedSpanNow() {
  const seq = seqNow();
  return seq ? selectionSpan(seq, useTimeline.getState().selectedClipIds) : null;
}

/**
 * 播放目前的「選取」：Final Cut 的 `/` 只有一顆鍵，選取是範圍或片段都吃。
 * 依 timeline.focus 派發（同 sequenceCommands 的 Delete 派發）：最後碰的是範圍就播範圍，是片段就播片段；
 * 兩個都沒有就退回普通播放（而不是什麼都不做）。播片段走 transient，不會去點亮「播放範圍」。
 */
function playSelection(): void {
  const tl = useTimeline.getState();
  if (tl.focus === "range" && tl.range) return void P.togglePlayRange();
  const span = selectedSpanNow();
  if (span) return void P.playRange(span.in, span.out, { loop: () => useTimeline.getState().loopRange, transient: true });
  if (tl.range) return void P.togglePlayRange();
  P.togglePlay();
}

/** Final Cut 的 Play Around 預設值：播放線前 3 秒、後 2 秒。 */
const AROUND_PRE_SEC = 3;
const AROUND_POST_SEC = 2;

/** 繞著播放線播一小段，用來反覆檢查接點。不循環、不佔用 I / O 範圍。 */
function playAround(): void {
  const pb = usePlayback.getState();
  const media = selectActiveMedia(useProject.getState());
  const seq = seqNow();
  const fps = seq?.fps ?? media?.proxy?.fps;
  const total = seq ? durationFrames(seq) : (media?.proxy?.frames ?? 0);
  if (!fps || total <= 0) return;
  const here = seq ? sequencePlayhead(seq, useProject.getState().activeMediaId, pb.frame, pb.seqFrame) : pb.frame;
  if (here === null) return void toast.info(t("播放線這一幀沒有用在序列裡"));
  const a = Math.max(0, here - Math.round((AROUND_PRE_SEC * fps.num) / fps.den));
  const b = Math.min(total, here + Math.round((AROUND_POST_SEC * fps.num) / fps.den));
  if (b <= a) return;
  P.playRange(a, b, { loop: false, from: a, transient: true });
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** 「檢視 › 側欄」的切換指令：分頁清單（核心 + 外掛）裡有 railTitle 的那些，依分頁順序。 */
function railTabCommands(): Command[] {
  return railTabs()
    .filter((x) => x.railTitle)
    .map<Command>((x) => ({
      id: `view.rail.${x.id}`,
      title: x.railTitle!,
      group: "view",
      section: "側欄",
      icon: x.railIcon ?? x.icon,
      checked: () => useUi.getState().railOpen && useUi.getState().tab === x.id,
      enabled: () => OK,
      run: () => useUi.getState().toggleTab(x.id),
    }));
}

const DENSITIES: { id: Density; title: string }[] = [
  { id: "compact", title: "緊湊" },
  { id: "normal", title: "標準" },
  { id: "comfortable", title: "寬鬆" },
];

const VIEW_MODES: { id: ViewMode; key: string; icon: typeof Eye }[] = [
  { id: "normal", key: "1", icon: Eye },
  { id: "stabilized", key: "2", icon: Lock },
  { id: "replaced", key: "3", icon: Layers },
  { id: "split", key: "4", icon: Columns2 },
  { id: "difference", key: "5", icon: Diff },
];

const TOGGLES: { id: string; title: string; k: "showMasks" | "showSurface" | "showGrid" | "showTrackHud" | "darkenImage"; icon: typeof Eye; shortcuts?: string[] }[] = [
  { id: "view.toggleMasks", title: "顯示遮罩", k: "showMasks", icon: SquareDashed, shortcuts: ["Shift+A"] },
  { id: "view.toggleSurface", title: "顯示表面", k: "showSurface", icon: Square, shortcuts: ["Q"] },
  { id: "view.toggleGrid", title: "顯示網格", k: "showGrid", icon: Grid3x3, shortcuts: ["G"] },
  { id: "view.toggleTrackHud", title: "顯示追蹤點（內點 / 外點 / 軌跡）", k: "showTrackHud", icon: Target, shortcuts: ["H"] },
  { id: "view.toggleDarkenImage", title: "壓暗畫面", k: "darkenImage", icon: Moon },
];

/**
 * 畫面比例參考線的子項：框出「裁成這個比例之後會留下哪一塊」，框外壓暗。
 *
 * 框的尺寸與自動重構圖真的會裁的那一塊**逐像素相同**（`stage/aspectGuide.ts` 與引擎同一條規則），
 * 所以照著這條線擺好的構圖，輸出就是那樣。這是拍直式短片時最常缺的一個東西：
 * 橫著拍、直著發，而在剪之前完全看不出主體會不會被切掉。
 */
const ASPECT_GUIDE_KIDS: Command[] = [
  {
    id: "view.aspectGuide.off",
    title: "關閉",
    group: "view" as CommandGroup,
    checked: () => useStage.getState().aspectGuide === null,
    enabled: () => OK,
    run: () => useStage.getState().setAspectGuide(null),
  },
  ...ASPECT_GUIDES.map<Command>((a) => ({
    id: `view.aspectGuide.${a.replace(":", "x")}`,
    title: a,
    group: "view" as CommandGroup,
    checked: () => useStage.getState().aspectGuide === a,
    enabled: () => OK,
    run: () => useStage.getState().setAspectGuide(a),
  })),
];

/**
 * 工作模式的子項（核心的 generic ＋ 外掛的，例如 cards；project/profiles.ts）。切換**不動任何資料**（追蹤、外掛的狀態都留著），
 * 只改「偵測要找什麼」與介面的形狀。
 *
 * 為什麼需要它：開始畫面的卡片決定 profile，但從「開啟影片」直接進來的專案一律是預設的那一個，
 * 而且在這之前沒有任何地方改得了 —— 想換工作模式的人只能關掉重開一個專案。
 */
function profileKids(): Command[] {
  return workProfiles().map(({ id: p, title, hint }) => ({
    id: `project.profile.${p}`,
    title,
    group: "file" as CommandGroup,
    section: "工作模式",
    icon: SlidersHorizontal,
    surfaces: [] as Surface[],
    keywords: [p],
    checked: () => useProject.getState().profile === p,
    enabled: () => OK,
    run: () => {
      if (useProject.getState().profile === p) return;
      useProject.getState().setProfile(p);
      toast.success(t("工作模式：{name}", { name: t(title) }));
      toast.info(t(hint));
    },
  }));
}

/** 核心指令表（呼叫當下才建：工作模式與側欄分頁的子項要看有哪些外掛）。 */
export function coreCommands(): Command[] {
  const PROFILE_KIDS = profileKids();
  return [
  // ---- 檔案 ----
  { id: "file.open", title: "開啟影片…", group: "file", section: "檔案", icon: FolderOpen, shortcuts: ["Ctrl+O"], surfaces: ["menu", "palette", "toolbar"], keywords: ["open", "video"], enabled: () => OK, run: () => A.openMedia() },
  {
    id: "file.recent",
    title: "最近開啟",
    group: "file",
    section: "檔案",
    icon: History,
    enabled: () => (useSettings.getState().s.recent_projects.length ? OK : { ok: false, why: "還沒有最近開啟的檔案" }),
    children: () =>
      useSettings.getState().s.recent_projects.map<Command>((p, i) => ({
        id: `file.recent.${i}`,
        title: baseName(p),
        group: "file",
        enabled: () => OK,
        run: () => A.openMedia(p),
      })),
    run: () => {},
  },
  { id: "file.new", title: "新專案", group: "file", section: "檔案", icon: FilePlus, enabled: () => OK, run: () => useProject.getState().newProject() },
  { id: "file.save", title: "儲存專案", group: "file", section: "檔案", icon: Save, shortcuts: ["Ctrl+S"], surfaces: ["menu", "palette", "toolbar"], badge: () => useProject.getState().dirty, enabled: () => OK, run: () => A.saveProject() },
  { id: "file.saveAs", title: "另存專案…", group: "file", section: "檔案", icon: Save, shortcuts: ["Ctrl+Shift+S"], enabled: () => OK, run: () => A.saveProject({ as: true }) },
  { id: "project.profile", title: "工作模式", group: "file", section: "工作模式", icon: SlidersHorizontal, keywords: ["profile", "mode"], children: () => PROFILE_KIDS, enabled: () => OK, run: () => {} },
  ...PROFILE_KIDS,
  { id: "file.exportTrackData", title: "匯出追蹤資料（Nuke / After Effects）…", group: "file", section: "輸出", icon: FileText, shortcuts: ["Ctrl+Shift+E"], keywords: ["nuke", "after effects", "corner pin", "export"], enabled: needsTrack, run: () => openDialog("exportTrackData", { trackId: useTimeline.getState().selectedTrackId ?? undefined }) },
  { id: "file.settings", title: "設定", group: "file", section: "設定", icon: Cog, shortcuts: ["Ctrl+,"], keywords: ["settings", "preferences"], enabled: () => OK, run: () => A.openSettings() },

  // ---- 編輯 ----
  { id: "edit.undo", title: "復原", group: "edit", section: "歷史", icon: Undo2, shortcuts: ["Ctrl+Z"], enabled: () => needsHistory("undo"), run: () => useEdits.getState().undo() },
  { id: "edit.redo", title: "重做", group: "edit", section: "歷史", icon: Redo2, shortcuts: ["Ctrl+Y", "Ctrl+Shift+Z"], enabled: () => needsHistory("redo"), run: () => useEdits.getState().redo() },
  { id: "edit.deleteKeyframe", title: "移除關鍵幀", group: "edit", section: "追蹤", icon: Trash2, shortcuts: ["Delete", "Backspace"], surfaces: ["menu", "palette", "context"], enabled: needsKeyframe, run: () => withUndoToast(t("已移除關鍵幀"), () => A.deleteKeyframe()) },
  { id: "edit.deleteTrack", title: "刪除追蹤", group: "edit", section: "追蹤", icon: Trash2, shortcuts: ["Shift+Delete"], surfaces: ["menu", "palette", "context"], enabled: needsAnyTrack, run: () => withUndoToast(t("已刪除追蹤"), () => A.deleteTrack()) },
  { id: "edit.revertFrameToSolved", title: "還原為解算值", group: "edit", section: "追蹤", icon: Undo2, surfaces: ["menu", "palette", "context"], keywords: ["revert", "solved"], enabled: needsTrack, run: () => A.revertFrameToSolved() },
  { id: "edit.shotCutAt", title: "在播放線切鏡頭", group: "edit", section: "鏡頭", icon: Scissors, shortcuts: ["S"], enabled: needsShot, run: () => withUndoToast(t("已切鏡頭"), () => A.shotCutAtPlayhead()) },
  { id: "edit.shotMerge", title: "與下一個鏡頭合併", group: "edit", section: "鏡頭", icon: Layers, enabled: needsShot, run: () => withUndoToast(t("已合併鏡頭"), () => A.shotMergeAtPlayhead()) },

  // ---- 檢視 ----
  { id: "view.zoomIn", title: "放大時間軸", group: "view", section: "縮放", icon: ZoomIn, shortcuts: ["Ctrl+=", "Ctrl+Shift+="], enabled: needsMedia, run: () => useTimeline.getState().zoomBy(1.25, usePlayback.getState().frame) },
  { id: "view.zoomOut", title: "縮小時間軸", group: "view", section: "縮放", icon: ZoomOut, shortcuts: ["Ctrl+-"], enabled: needsMedia, run: () => useTimeline.getState().zoomBy(0.8, usePlayback.getState().frame) },
  { id: "view.zoomFit", title: "整段適配", group: "view", section: "縮放", icon: ZoomOut, shortcuts: ["Ctrl+0"], enabled: needsMedia, run: () => useTimeline.getState().fit() },
  ...TOGGLES.map<Command>((x) => ({
    id: x.id,
    title: x.title,
    group: "view",
    section: "圖層",
    icon: x.icon,
    shortcuts: x.shortcuts,
    checked: () => useStage.getState()[x.k],
    enabled: () => OK,
    run: () => useStage.getState().toggle(x.k),
  })),
  {
    id: "view.aspectGuide",
    title: "畫面比例參考線",
    group: "view",
    section: "圖層",
    icon: Crop,
    keywords: ["aspect", "guide", "safe area", "9:16", "vertical", "直式"],
    children: () => ASPECT_GUIDE_KIDS,
    checked: () => useStage.getState().aspectGuide !== null,
    enabled: needsMedia,
    run: () => {},
  },
  ...ASPECT_GUIDE_KIDS,
  ...VIEW_MODES.map<Command>((m) => ({
    id: `view.mode.${m.id}`,
    title: VIEW_MODE_LABEL[m.id],
    group: "view",
    section: "檢視模式",
    icon: m.icon,
    shortcuts: [m.key],
    checked: () => useStage.getState().viewMode === m.id,
    enabled: () => OK,
    run: () => useStage.getState().setViewMode(m.id),
  })),
  // A/B 閃爍是「按住才亮」：hotkeys.ts 手寫 keydown / keyup；這裡只給說明表與命令面板一個入口（點一下 = 閃 300 ms）
  {
    id: "view.abFlicker",
    title: "A/B 閃爍（按住比對原片）",
    group: "view",
    section: "檢視模式",
    icon: Repeat,
    shortcuts: ["\\"],
    shortcutManual: true,
    enabled: needsProxy,
    run: () => {
      useStage.getState().setAbFlicker(true);
      window.setTimeout(() => useStage.getState().setAbFlicker(false), 300);
    },
  },
  ...railTabCommands(),
  { id: "view.railToggle", title: "收合 / 展開側欄", group: "view", section: "側欄", icon: PanelRight, shortcuts: ["Ctrl+B"], checked: () => !useUi.getState().railOpen, enabled: () => OK, run: () => useUi.getState().setRailOpen(!useUi.getState().railOpen) },
  { id: "view.follow", title: "跟隨播放線：翻頁 / 置中 / 關", group: "view", section: "時間軸", icon: Move3d, enabled: () => OK, run: () => usePlayback.getState().cycleFollow() },
  // 吸附（M2.13）：ai-music-cut 是 N，但這裡 N 已經是「新增追蹤」，所以 Shift+N（設計 §10.2）。拖曳中按住 Alt 仍然是暫時不吸
  {
    id: "view.toggleSnap",
    title: "吸附",
    group: "view",
    section: "時間軸",
    icon: Magnet,
    shortcuts: ["Shift+N"],
    keywords: ["snap", "magnet", "snapping"],
    checked: () => useSnap.getState().enabled,
    enabled: () => OK,
    run: () => {
      useSnap.getState().toggle();
      // 勾選狀態不在 guards.ts 訂閱的 store 裡：自己推一次，選單的勾勾才會跟著變
      bumpCommandTick();
      toast.info(useSnap.getState().enabled ? t("吸附：開") : t("吸附：關"));
    },
  },
  ...DENSITIES.map<Command>((d) => ({
    id: `view.density.${d.id}`,
    title: d.title,
    group: "view",
    section: "介面密度",
    checked: () => useUi.getState().density === d.id,
    enabled: () => OK,
    run: () => useUi.getState().setDensity(d.id),
  })),
  {
    id: "view.lang",
    title: "語言",
    group: "view",
    section: "外觀",
    icon: Languages,
    enabled: () => OK,
    children: () =>
      LANGUAGES.map<Command>((l) => ({
        id: `view.lang.${l.id}`,
        title: l.label,
        group: "view",
        checked: () => useLang.getState().lang === l.id,
        enabled: () => OK,
        run: () => void useLang.getState().setLang(l.id),
      })),
    run: () => {},
  },
  {
    id: "view.theme",
    title: "主題",
    group: "view",
    section: "外觀",
    icon: Palette,
    enabled: () => OK,
    children: () =>
      THEMES.map<Command>((th) => ({
        id: `view.theme.${th.id}`,
        title: th.label,
        group: "view",
        checked: () => useTheme.getState().themeId === th.id,
        enabled: () => OK,
        run: () => useTheme.getState().setThemeId(th.id),
      })),
    run: () => {},
  },

  // ---- 播放 ----
  // 播放 / 逐幀一律直接呼叫 stage/playerRef（ai-music-cut core.ts 的做法）：v0.0.6 的 A.togglePlay 只寫 store.playing，
  // 沒有人依它去驅動 <video> —— 狀態列亮 ▶、影片卻一直停著。逐幀走 playerRef 才會先暫停、連按不掉步
  { id: "playback.toggle", title: "播放 / 暫停", group: "playback", section: "播放", icon: Play, shortcuts: ["Space"], enabled: needsProxy, run: () => P.togglePlay() },
  { id: "playback.stepBack", title: "上一幀", group: "playback", section: "逐幀", icon: ChevronsLeft, shortcuts: ["ArrowLeft"], enabled: needsProxy, run: () => stepBy(-1) },
  { id: "playback.stepFwd", title: "下一幀", group: "playback", section: "逐幀", icon: ChevronsRight, shortcuts: ["ArrowRight"], enabled: needsProxy, run: () => stepBy(1) },
  { id: "playback.stepBack10", title: "後退 10 幀", group: "playback", section: "逐幀", icon: ChevronsLeft, shortcuts: ["Shift+ArrowLeft"], enabled: needsProxy, run: () => stepBy(-10) },
  { id: "playback.stepFwd10", title: "前進 10 幀", group: "playback", section: "逐幀", icon: ChevronsRight, shortcuts: ["Shift+ArrowRight"], enabled: needsProxy, run: () => stepBy(10) },
  { id: "playback.home", title: "跳到開頭", group: "playback", section: "跳轉", icon: SkipBack, shortcuts: ["Home"], enabled: needsProxy, run: () => A.seekTo(0) },
  { id: "playback.end", title: "跳到結尾", group: "playback", section: "跳轉", icon: SkipForward, shortcuts: ["End"], enabled: needsProxy, run: () => A.seekTo(Number.MAX_SAFE_INTEGER) },
  { id: "playback.shuttle", title: "轉盤：倒退 / 前進（J / L，連按加速）", group: "playback", section: "跳轉", icon: Repeat, shortcuts: ["J", "L"], shortcutManual: true, surfaces: [], enabled: needsProxy, run: () => {} },
  { id: "playback.markIn", title: "標入點", group: "playback", section: "範圍", icon: SquareDashed, shortcuts: ["I"], enabled: needsMedia, run: () => A.markIn() },
  { id: "playback.markOut", title: "標出點", group: "playback", section: "範圍", icon: SquareDashed, shortcuts: ["O"], enabled: needsMedia, run: () => A.markOut() },
  { id: "playback.clearRange", title: "清除範圍", group: "playback", section: "範圍", icon: SquareDashed, shortcuts: ["Alt+X"], enabled: needsRange, run: () => useTimeline.getState().setRange(null) },
  // L 是轉盤（hotkeys.ts 手寫派發）；註冊表的 chord 會先被派發，綁 L 的話鍵盤永遠叫不到轉盤。Ctrl+/ 是 Resolve 的 Loop
  { id: "playback.loop", title: "循環播放範圍", group: "playback", section: "範圍", icon: Repeat, shortcuts: ["Ctrl+L", "Ctrl+/"], checked: () => useTimeline.getState().loopRange, enabled: needsMedia, run: () => useTimeline.getState().toggleLoop() },
  { id: "playback.prevKeyframe", title: "上一個關鍵幀", group: "playback", section: "導覽", icon: ChevronsLeft, shortcuts: ["["], enabled: needsTrack, run: () => A.stepKeyframe(-1) },
  { id: "playback.nextKeyframe", title: "下一個關鍵幀", group: "playback", section: "導覽", icon: ChevronsRight, shortcuts: ["]"], enabled: needsTrack, run: () => A.stepKeyframe(1) },
  { id: "playback.prevShot", title: "上一個鏡頭", group: "playback", section: "導覽", icon: SkipBack, shortcuts: ["Shift+[", "ArrowUp"], enabled: needsMedia, run: () => A.stepShot(-1) },
  { id: "playback.nextShot", title: "下一個鏡頭", group: "playback", section: "導覽", icon: SkipForward, shortcuts: ["Shift+]", "ArrowDown"], enabled: needsMedia, run: () => A.stepShot(1) },
  { id: "playback.prevLowConfidence", title: "上一個低信心的幀", group: "playback", section: "導覽", icon: ChevronsLeft, shortcuts: ["Alt+["], enabled: needsTrack, run: () => A.stepLowConfidence(-1) },
  { id: "playback.nextLowConfidence", title: "下一個低信心的幀", group: "playback", section: "導覽", icon: ChevronsRight, shortcuts: ["Alt+]"], enabled: needsTrack, run: () => A.stepLowConfidence(1) },

  // ---- 播放：傳輸列（stage/Transport.tsx）的按鈕、快捷鍵、選單共用這幾條 ----
  { id: "playback.stop", title: "停止（回到開始播放的位置）", group: "playback", section: "播放", icon: Square, keywords: ["stop"], enabled: needsProxy, run: () => P.stop() },
  // Premiere 是 Ctrl+Shift+Space；Resolve 官方手冊的 Play In to Out 是 Alt+/
  { id: "playback.playRange", title: "播放範圍（入點到出點）", group: "playback", section: "範圍", icon: ListVideo, shortcuts: ["Ctrl+Shift+Space", "Alt+/"], keywords: ["play in to out", "range"], enabled: needsRange, run: () => P.togglePlayRange() },
  // Final Cut 的 Play Selection 就是 `/`（選取可以是範圍也可以是片段，所以只有一顆鍵）
  { id: "playback.playSelection", title: "播放選取", group: "playback", section: "範圍", icon: CirclePlay, shortcuts: ["/"], keywords: ["play selection", "selection"], enabled: needsProxy, run: () => playSelection() },
  // Final Cut 的 Play Around 是 Shift+/（在美式鍵盤上打出來是 ?，比對靠 shortcut.ts 的 SHIFTED_BASE_CODES）
  { id: "playback.playAround", title: "繞著播放線播（前 3 秒、後 2 秒）", group: "playback", section: "範圍", icon: Crosshair, shortcuts: ["Shift+/"], keywords: ["play around", "preroll"], enabled: needsProxy, run: () => playAround() },
  // J / L 鍵由 hotkeys.ts 手寫派發（要忽略 auto-repeat）；這兩條給按鈕與命令面板，實作同一支 A.shuttle
  { id: "playback.shuttleBack", title: "倒退轉盤（再按加速；倒退沒有聲音）", group: "playback", section: "播放", icon: Rewind, keywords: ["J", "shuttle", "rewind"], enabled: needsProxy, run: () => A.shuttle("J", { slow: false }) },
  { id: "playback.shuttleFwd", title: "前進轉盤（再按加速 1× / 2× / 4×）", group: "playback", section: "播放", icon: FastForward, keywords: ["L", "shuttle", "fast forward"], enabled: needsProxy, run: () => A.shuttle("L", { slow: false }) },
  {
    id: "playback.speed",
    title: "播放速度",
    group: "playback",
    section: "播放",
    icon: Gauge,
    keywords: ["speed", "rate"],
    enabled: needsProxy,
    children: () =>
      SPEEDS.map<Command>((r) => ({
        id: `playback.speed.${r}`,
        title: `${r}×`,
        group: "playback",
        checked: () => usePlayback.getState().rate === r,
        enabled: () => OK,
        run: () => usePlayback.getState().setRate(r),
      })),
    run: () => {},
  },
  { id: "playback.toggleMute", title: "靜音", group: "playback", section: "播放", icon: Volume2, keywords: ["mute", "volume"], checked: () => usePlayback.getState().muted, enabled: needsAudio, run: () => usePlayback.getState().toggleMute() },
  { id: "playback.gotoTimecode", title: "跳到時間碼 / 幀號…", group: "playback", section: "跳轉", icon: Hash, shortcuts: ["="], keywords: ["timecode", "goto", "frame"], enabled: needsProxy, run: () => usePlayback.getState().requestTimecodeFocus() },

  // ---- 說明 ----
  {
    id: "help.palette",
    title: "搜尋指令",
    group: "help",
    section: "說明",
    icon: Search,
    shortcuts: ["Ctrl+K", "Ctrl+Shift+P"],
    global: true,
    keywords: ["palette", "command"],
    enabled: () => OK,
    run: () => {
      const d = useDialogs.getState();
      if (d.isOpen("palette")) d.close("palette");
      else d.open("palette");
    },
  },
  { id: "help.shortcuts", title: "快捷鍵", group: "help", section: "說明", icon: Keyboard, shortcuts: ["F1"], global: true, enabled: () => OK, run: () => openDialog("shortcuts") },
  { id: "help.engineSetup", title: "安裝 / 檢查引擎…", group: "help", section: "引擎", icon: Download, keywords: ["engine", "install", "python", "cuda", "setup"], enabled: () => OK, run: () => openDialog("engineSetup", {}) },
  { id: "help.openLogs", title: "開啟引擎日誌", group: "help", section: "引擎", icon: ScrollText, keywords: ["log"], enabled: () => (useSettings.getState().paths ? OK : { ok: false, why: "還沒拿到 App 路徑" }), run: () => A.openLogs() },
  { id: "help.about", title: "關於", group: "help", section: "說明", icon: Info, enabled: () => OK, run: () => openDialog("about") },
];
}

// ---- 播放群組的小工具（function 宣告會提升，指令表在上面就能用）----

/** 逐幀：有播放器就走 playerRef（先暫停、連按累積意圖幀）；舞台還沒掛上 <video> 時退回只寫 store。 */
function stepBy(n: number): void {
  if (P.getPlayer()) void P.stepFrames(n);
  else A.stepFrames(n);
}

/** 有音軌才有音量可調；probe 還沒回來（null）先放行，別讓按鈕莫名灰掉。 */
function needsAudio() {
  const p = needsProxy();
  if (!p.ok) return p;
  const st = useProject.getState();
  const probe = st.media.find((m) => m.id === st.activeMediaId)?.probe;
  return probe && !probe.audio ? { ok: false as const, why: "這支影片沒有音軌" } : OK;
}
