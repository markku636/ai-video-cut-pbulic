import type { LucideIcon } from "lucide-react";
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Ban,
  Clock,
  Copy,
  Eye,
  FileText,
  Film,
  FolderSearch,
  HardDrive,
  ImageDown,
  Layers,
  Merge,
  Move3d,
  Play,
  RefreshCw,
  Scissors,
  SkipBack,
  SkipForward,
  SquareDashed,
  Target,
  Trash2,
  ZoomIn,
} from "lucide-react";
import { api, errMessage, type Rational } from "../api";
import { setTimelineContextMenuHandler, type TimelineContextRequest, type TimelineContextTarget } from "../frametimeline/contextMenu";
import { t } from "../i18n";
import { runningJob } from "../pipeline/engineJob";
import { detectShots, ensureProxy } from "../pipeline/proxy";
import type { MenuGroupContribution, TrackMenuContext } from "../plugins/api";
import { collect, plugins } from "../plugins/registry";
import type { ShotV1, TrackV1 } from "../project/format";
import { canCopyImage, canSaveBinaryFile, copyFrameToClipboard, saveFrameAsPng } from "../stage/frameGrab";
import { play, playRange, seekToFrame } from "../stage/playerRef";
import { openMediaInfo } from "../store/dialogs";
import { shotAt, useEdits } from "../store/edits";
import { engineReady, pyenvReady } from "../store/engine";
import { useJobs } from "../store/jobs";
import { useMasks } from "../store/masks";
import { FOLLOW_MODES, usePlayback, type FollowMode } from "../store/playback";
import { useProject, type MediaItem } from "../store/project";
import { useSolves } from "../store/solves";
import { useTimeline, type FrameRange } from "../store/timeline";
import { timecode } from "../time";
import { copyToClipboard, toast, uiConfirm } from "../ui";
import { openContextMenu, type MenuPoint } from "../ui/ContextMenu";
import type { MenuItem } from "../ui/MenuPanel";
import { SHOT_KIND_LABEL } from "../video/labels";
import * as A from "./appActions";
import { needsEngine, needsMedia, needsProxy } from "./guards";
import { OK, command, commandsIn, runCommand, runCommandObject } from "./registry";
import { formatShortcut } from "./shortcut";
import type { Command, CommandGroup, CoreCommandGroup, Enabled, Surface } from "./types";
import { withUndoToast } from "./undoToast";
// M2.12 序列剪輯的右鍵（片段 / 空白 / 範圍與尺規追加）：獨立一段 import，免得跟同一波其他群組改同一份 import 清單互相覆蓋
import { BetweenHorizontalStart, LocateFixed, Move, PlusCircle, SquareSplitHorizontal, Volume2 } from "lucide-react";
import { contextTargetOf } from "../frametimeline/contextMenu";
import { toTimelineHit, type SeqHit } from "../frametimeline/hitSequence";
import { SEQ_SAMPLE_RATE, type SequenceV2 } from "../project/format";
import { durationFrames, mapFrame, placeVideo, samplesOfFrame } from "../sequence/map";
import { canSplitAt, closeGap, inSequenceSpace, insertActiveMediaAt, needsSequenceSpace, openInSource, seekSequenceNow, splitAtFrame, splitClipAt, viewSequenceNow } from "./sequenceCommands";
// M2.14 側欄媒體右鍵追加（接到序列結尾／在播放線插入）：同樣獨立一段 import
import { ListEnd } from "lucide-react";
import { addMediaToSequence } from "../pipeline/audio";
import { sequenceEditingEnabled } from "../store/settings";
// M2.15 音訊片段 / 音軌右鍵：指令在 audioClipCommands.ts，這裡只依 id 列（同樣獨立一段 import）
import { AUDIO_CLIP_MENU_GROUPS, AUDIO_LANE_MENU_GROUPS, CLIP_AUDIO_MENU_IDS, RANGE_AUDIO_MENU_IDS, setAudioMenuContext } from "./audioClipCommands";

/**
 * 指令 → 選單項目。選單列、工具列下拉、各處右鍵都從這裡產生，
 * 所以「停用原因放 tooltip」「quick 排在 dialog 前面」「section 之間畫線」只寫一次。
 *
 * 右鍵選單（規格 §2）的原則：
 * - 能對到註冊表的一律用指令（enabled / 停用原因 / 快捷鍵提示都跟著指令走）；指令還沒登記的功能就不列。
 * - 需要「點擊處的幀 / 那個鏡頭」的項目是臨時指令（adhoc）：同樣走 runCommandObject，
 *   停用時點下去照樣 toast 原因、例外照樣接住；快捷鍵提示借對應的正式指令（例如「在這裡設入點」顯示 I）。
 * - 選單太長會超出 700 px 高的視窗：次要的一組收進子選單（解算 ▸、縮放 ▸、追蹤資料 ▸）。
 * - 外掛在固定的位置注入項目（plugins/api.ts MenuContribution）；下面的積木（compact / item / adhoc…）也給外掛用。
 */

/** 命令面板右側 / 選單列的群組標籤（核心的；外掛的群組見 groupLabel）。 */
export const GROUP_LABEL: Record<CoreCommandGroup, string> = {
  file: "檔案",
  edit: "編輯",
  view: "檢視",
  playback: "播放",
  object: "物件",
  track: "追蹤",
  adjust: "調整追蹤",
  mask: "遮罩",
  captions: "字幕",
  export: "輸出",
  ai: "AI",
  help: "說明",
};

/** 選單列的順序（Nuke / Fusion 一類桌面軟體的慣例：檔案 › 編輯 › 檢視 › 播放 › 工作群組 › 說明）。 */
const CORE_MENU_ORDER: readonly CoreCommandGroup[] = ["file", "edit", "view", "playback", "object", "track", "adjust", "mask", "captions", "export", "ai", "help"];
/** 快捷鍵說明的順序：最常用的播放 / 追蹤在前。 */
const CORE_HELP_ORDER: readonly CoreCommandGroup[] = ["playback", "object", "track", "adjust", "mask", "captions", "edit", "view", "export", "file", "ai", "help"];

function pluginGroups(): MenuGroupContribution[] {
  return collect((p) => p.menus?.groups);
}

function withPluginGroups(core: readonly CommandGroup[], anchor: "menuAfter" | "helpAfter"): CommandGroup[] {
  const out: CommandGroup[] = [...core];
  for (const g of pluginGroups()) {
    if (out.includes(g.id)) continue;
    const i = out.indexOf(g[anchor]);
    if (i >= 0) out.splice(i + 1, 0, g.id);
    else out.push(g.id);
  }
  return out;
}

/** 選單列的群組（核心 + 外掛，依外掛宣告的位置插入）。 */
export function menuBarGroups(): CommandGroup[] {
  return withPluginGroups(CORE_MENU_ORDER, "menuAfter");
}

/** 快捷鍵說明的群組順序。 */
export function shortcutHelpGroups(): CommandGroup[] {
  return withPluginGroups(CORE_HELP_ORDER, "helpAfter");
}

/** 群組標籤（zh key）：核心的、外掛的，都不認得就是 id 本身。 */
export function groupLabel(g: CommandGroup): string {
  return (GROUP_LABEL as Record<string, string>)[g] ?? pluginGroups().find((x) => x.id === g)?.label ?? g;
}

export interface ToMenuOpts {
  /** 用簡易模式的白話標籤（v1 沒有簡易殼，保留欄位）。 */
  simpleLabel?: boolean;
  /** 不顯示快捷鍵提示。 */
  noShortcut?: boolean;
  /** 這個原因的停用項目直接不畫（例如舞台右鍵裡「先選一條追蹤」是廢話）。 */
  hideWhy?: string;
  /** 覆蓋標籤。 */
  label?: string;
}

export function commandLabel(c: Command, simple = false): string {
  const key = simple && c.simpleLabel ? c.simpleLabel : c.title;
  return t(key, c.titleParams);
}

export function commandToMenuItem(c: Command, opts: ToMenuOpts = {}): MenuItem | null {
  const en = c.enabled();
  if (!en.ok && opts.hideWhy && en.why === opts.hideWhy) return null;
  const label = opts.label ?? commandLabel(c, opts.simpleLabel);
  const kids = c.children?.();
  return {
    label,
    icon: c.icon,
    shortcut: opts.noShortcut || !c.shortcuts?.length ? undefined : formatShortcut(c.shortcuts[0]),
    checked: c.checked?.(),
    muted: !en.ok,
    title: en.ok ? (opts.simpleLabel && c.simpleHint ? t(c.simpleHint) : undefined) : t(en.why),
    dataId: c.id,
    children: kids ? () => kids.map((k) => commandToMenuItem(k, { noShortcut: true })).filter((x): x is MenuItem => !!x) : undefined,
    onClick: kids ? undefined : () => void runCommandObject(c, "menu"),
  };
}

/** 一串指令 → 依 section 插分隔線的選單；頭尾與連續的分隔線會被收掉。 */
export function commandsToMenu(cmds: Command[], opts: ToMenuOpts = {}): MenuItem[] {
  const out: MenuItem[] = [];
  let lastSection: string | undefined;
  let first = true;
  for (const c of cmds) {
    const it = commandToMenuItem(c, opts);
    if (!it) continue;
    if (!first && c.section !== lastSection) out.push({ separator: true });
    out.push(it);
    lastSection = c.section;
    first = false;
  }
  return collapseSeparators(out);
}

export function collapseSeparators(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const it of items) {
    if (it.separator) {
      if (!out.length || out[out.length - 1].separator) continue;
      out.push(it);
    } else out.push(it);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

export function groupMenu(group: CommandGroup, surface: Surface = "menu", opts: ToMenuOpts = {}): MenuItem[] {
  if (group === "ai" && surface === "menu") return aiMenu(opts);
  return commandsToMenu(commandsIn(group, surface), opts);
}

/**
 * 「AI」選單（CapCut 的 AI 工具面板、Premiere 的 AI 分頁）：把散在字幕／編輯／遮罩／輸出各群組的 AI 功能集中一份。
 * 指令本身還在原來的群組（字幕選單照樣有「產生字幕」），這裡只是**第二個入口** —— 使用者想找「AI 能幫我什麼」時不必翻五個選單。
 * 順序照使用頻率：先字幕與從字幕長出來的東西，再文字稿剪輯，再影像處理，最後是助手與建議分頁。
 */
export const AI_MENU_IDS: readonly (readonly string[])[] = [
  ["captions.generate", "captions.chapters", "ai.highlights", "captions.refine"],
  ["sequence.removeFillers", "sequence.removeSilence"],
  ["mask.blurBackground", "mask.removeObject", "export.reframeVideo"],
  ["ai.tts"],
  ["view.rail.assistant", "view.rail.advice"],
];

export function aiMenu(opts: ToMenuOpts = {}): MenuItem[] {
  const listed = new Set(AI_MENU_IDS.flat());
  // 之後登記在 ai 群組、但還沒排進上面那張表的指令也要看得到，不然「加了指令卻在選單找不到」查不出原因
  const rest = commandsToMenu(commandsIn("ai", "menu").filter((c) => !listed.has(c.id)), opts);
  return collapseSeparators([...AI_MENU_IDS.flatMap((ids) => [{ separator: true } as MenuItem, ...byIds([...ids], opts)]), { separator: true }, ...rest]);
}

export function byIds(ids: string[], opts: ToMenuOpts = {}): MenuItem[] {
  const out: MenuItem[] = [];
  for (const id of ids) {
    const c = command(id);
    if (!c) continue;
    const it = commandToMenuItem(c, opts);
    if (it) out.push(it);
  }
  return out;
}

/** 工具列「更多 ▾」：檢視 / 輸出 / 說明。 */
export function moreMenuItems(): MenuItem[] {
  return collapseSeparators([...groupMenu("view", "menu"), { separator: true }, ...groupMenu("export", "menu"), { separator: true }, ...groupMenu("help", "menu")]);
}

// ============================================================================
// 右鍵選單的積木
// ============================================================================

/** 右鍵裡「先選一條追蹤」是廢話 —— 點在表面 / 車道上就隱含選了；空白處另有一組。 */
const TRACK_WHY = "先在時間軸選一條追蹤";
export const CTX: ToMenuOpts = { hideWhy: TRACK_WHY };
export const SEP: MenuItem = { separator: true };

export type Maybe = MenuItem | null | undefined | false;

function isMaybeList(x: Maybe | readonly Maybe[]): x is readonly Maybe[] {
  return Array.isArray(x);
}

/** 濾掉沒有的項目、收分隔線。 */
export function compact(list: readonly (Maybe | readonly Maybe[])[]): MenuItem[] {
  const flat: MenuItem[] = [];
  const push = (y: Maybe) => {
    if (y) flat.push(y);
  };
  for (const x of list) {
    if (isMaybeList(x)) x.forEach(push);
    else push(x);
  }
  return collapseSeparators(flat);
}

function hasItems(items: MenuItem[]): boolean {
  return items.some((it) => !it.separator);
}

/** 第一列的資訊標題（灰字、鍵盤跳過）。 */
export function header(text: string): MenuItem {
  return { label: text, disabled: true, dataId: "ctx.header" };
}

export function both(...fs: (() => Enabled)[]): () => Enabled {
  return () => {
    for (const f of fs) {
      const r = f();
      if (!r.ok) return r;
    }
    return OK;
  };
}

export interface AdhocSpec {
  /** zh key（顯示時 t() 過）。 */
  title: string;
  titleParams?: Record<string, string | number>;
  icon?: LucideIcon;
  /** 借這個正式指令的快捷鍵當提示（沒登記就不顯示）。 */
  shortcutOf?: string;
  enabled?: () => Enabled;
  checked?: () => boolean;
  run: () => void | Promise<void>;
}

/** 臨時指令：沒有登記在註冊表，但跟正式指令走同一條「停用要解釋、例外要接住」的路。 */
export function adhoc(id: string, s: AdhocSpec): Command {
  return {
    id,
    title: s.title,
    titleParams: s.titleParams,
    group: "view",
    icon: s.icon,
    shortcuts: s.shortcutOf ? command(s.shortcutOf)?.shortcuts : undefined,
    checked: s.checked,
    surfaces: ["context"],
    enabled: s.enabled ?? (() => OK),
    run: s.run,
  };
}

export function item(c: Command | null | undefined, opts: ToMenuOpts & { danger?: boolean } = CTX): MenuItem | null {
  if (!c) return null;
  const it = commandToMenuItem(c, opts);
  return it && opts.danger ? { ...it, danger: true } : it;
}

export function cmd(id: string, opts: ToMenuOpts & { danger?: boolean } = CTX): MenuItem | null {
  return item(command(id), opts);
}

/** 有登記正式指令就用它（其他組做的版本行為一致）；還沒登記就用這裡的等價實作。 */
function preferCmd(id: string, fallback: () => Command | null, opts: ToMenuOpts = CTX): MenuItem | null {
  return item(command(id) ?? fallback(), opts);
}

/**
 * 「在這裡…」：借正式指令的守門 / 圖示 / 快捷鍵，執行前先把播放線移到點擊的幀。
 * 指令沒登記 → 不列。只用在守門不看播放線的指令（needsTrack / needsIdleTrack 這類）。
 */
function atFrame(baseId: string, id: string, title: string, frame: number, icon?: LucideIcon): MenuItem | null {
  const base = command(baseId);
  if (!base) return null;
  return item({
    ...base,
    id,
    title,
    titleParams: undefined,
    icon: icon ?? base.icon,
    children: undefined,
    checked: undefined,
    run: async () => {
      A.seekTo(frame);
      await base.run();
    },
  });
}

function submenu(id: string, label: string, icon: LucideIcon | undefined, kids: () => Maybe[]): MenuItem | null {
  if (!hasItems(compact(kids()))) return null;
  return { label, icon, dataId: id, children: () => compact(kids()) };
}

// ---- 共用的讀取 / 動作 ----

const FALLBACK_FPS: Rational = { num: 30, den: 1 };

function activeMedia(): MediaItem | null {
  const p = useProject.getState();
  return p.activeMediaId ? p.media.find((m) => m.id === p.activeMediaId) ?? null : null;
}

function mediaById(id: string): MediaItem | null {
  return useProject.getState().media.find((m) => m.id === id) ?? null;
}

function fpsOf(m: MediaItem | null): Rational {
  return m?.proxy?.fps ?? m?.probe?.video?.r_frame_rate ?? FALLBACK_FPS;
}

function sortedShots(shots: readonly ShotV1[]): ShotV1[] {
  return [...shots].sort((a, b) => a.startFrame - b.startFrame);
}

// ---- 外掛的注入點（plugins/api.ts MenuContribution / TrackContribution）----

/** 這條追蹤在外掛眼中的附註（例如 cards 的「8♥ → 9♦」）；沒有外掛或沒有附註 = null。 */
function pluginTrackSummary(mediaId: string | null | undefined, tr: TrackV1 | null | undefined): string | null {
  if (!tr) return null;
  const media = mediaId ? useEdits.getState().pluginMedia[mediaId] : undefined;
  for (const p of plugins()) {
    const s = p.tracks?.summary?.(media, tr);
    if (s) return s;
  }
  return null;
}

/** 標題：「標籤 · 外掛附註」。 */
function withSummary(label: string, mediaId: string | null, tr: TrackV1 | null | undefined): string {
  const s = pluginTrackSummary(mediaId, tr);
  return s ? `${label} · ${s}` : label;
}

/** 外掛在舞台表面 / 車道右鍵注入的項目（依登記順序）。 */
function pluginTrackItems(kind: "stageTrack" | "lane", ctx: TrackMenuContext): Maybe[] {
  return plugins().flatMap((p) => p.menus?.[kind]?.(ctx) ?? []);
}

/** 範圍的標題：「00:00:28:00–00:00:30:10 · 70 幀（2.33 秒）」。out 是不含的邊界，顯示的也是它。 */
export function rangeTitle(r: FrameRange, fps: Rational): string {
  const n = Math.max(0, r.out - r.in);
  const secs = fps.num > 0 ? (n * fps.den) / fps.num : 0;
  return t("{a}–{b} · {n} 幀（{s} 秒）", { a: timecode(r.in, fps), b: timecode(r.out, fps), n, s: secs.toFixed(2) });
}

function markAt(which: "in" | "out", frame: number): void {
  const tl = useTimeline.getState();
  const done = which === "in" ? tl.markIn(frame) : tl.markOut(frame);
  if (done) return;
  const at = timecode(frame, fpsOf(activeMedia()));
  toast.info(which === "in" ? t("入點 {at}　再按 O 標出點", { at }) : t("出點 {at}　再按 I 標入點", { at }));
}

export function setRangeTo(a: number, b: number): void {
  useTimeline.getState().setRange({ in: a, out: b });
}

/** 縮放到一段 [a, b)：範圍佔可視寬度 90%（store 的 zoomToRange 與 Z 同一套）。 */
function zoomTo(a: number, b: number): void {
  useTimeline.getState().zoomToRange({ in: a, out: b }, activeMedia()?.proxy?.frames);
}

async function playFrom(frame: number): Promise<void> {
  await seekToFrame(frame);
  play();
}

function playSpan(a: number, b: number, loop: boolean): void {
  playRange(a, b, { loop });
}

function canCutAt(shots: readonly ShotV1[], frame: number): Enabled {
  const m = needsMedia();
  if (!m.ok) return m;
  return shots.some((s) => s.startFrame < frame && frame < s.endFrame) ? OK : { ok: false, why: "這裡切不了：在鏡頭邊界上，或不在任何鏡頭裡" };
}

function cutAt(frame: number): Promise<void> {
  const mediaId = useProject.getState().activeMediaId;
  if (!mediaId) return Promise.resolve();
  return withUndoToast(t("已切鏡頭"), () => {
    if (!useEdits.getState().splitShot(mediaId, frame)) toast.info(t("這裡切不了：在鏡頭邊界上，或不在任何鏡頭裡"));
  });
}

/** 範圍相關的「清除」：有完整範圍才有清單端；只有單邊暫存時清那一端。 */
function clearItems(range: FrameRange | null, pendingIn: number | null, pendingOut: number | null): Maybe[] {
  const tl = () => useTimeline.getState();
  const hasIn = range != null || pendingIn != null;
  const hasOut = range != null || pendingOut != null;
  return [
    hasIn && preferCmd("playback.clearIn", () => adhoc("ctx.clearIn", { title: "清除入點（保留出點）", icon: ArrowLeftToLine, run: () => tl().clearIn() })),
    hasOut && preferCmd("playback.clearOut", () => adhoc("ctx.clearOut", { title: "清除出點（保留入點）", icon: ArrowRightToLine, run: () => tl().clearOut() })),
    range && cmd("playback.clearRange"),
  ];
}

function playRangeItem(r: FrameRange): MenuItem | null {
  return preferCmd("playback.playRange", () => adhoc("ctx.playRange", { title: "播放範圍（入點到出點）", icon: Play, enabled: needsProxy, run: () => playSpan(r.in, r.out, useTimeline.getState().loopRange) }));
}

function zoomToRangeItem(r: FrameRange): MenuItem | null {
  return preferCmd("view.zoomToRange", () => adhoc("ctx.zoomToRange", { title: "時間軸縮放到範圍", icon: ZoomIn, enabled: needsMedia, run: () => zoomTo(r.in, r.out) }));
}

/**
 * 範圍選單的「輸出這一幀」：輸出**右鍵點的那一幀**（夾進範圍內），不是播放線（M1 驗收 M1）。
 * 右鍵不移動播放線（Resolve 慣例），播放線常常根本不在這段範圍裡 —— 照指令本身取播放線，會輸出一張跟這個選單無關的幀。
 * 借 export.frame 的守門 / 圖示，標籤帶時間碼讓人按下去之前就知道是哪一幀；點在出點握把上命中的是 out（不含），夾回 out−1。
 */
function exportFrameInRangeItem(r: FrameRange, frame: number, fps: Rational): MenuItem | null {
  const base = command("export.frame");
  if (!base) return null;
  const f = Math.max(r.in, Math.min(r.out - 1, Math.round(frame)));
  return item({
    ...base,
    id: "ctx.range.exportFrame",
    title: "輸出這一幀（{tc}）…",
    titleParams: { tc: timecode(f, fps) },
    children: undefined,
    checked: undefined,
    run: () => A.openExport({ in: f, out: f + 1 }),
  });
}

const FOLLOW_LABEL: Record<FollowMode, string> = { page: "翻頁（播到邊緣換一頁）", center: "置中（播放線固定在中間）", off: "關（不自動捲動）" };

function followSubmenu(): MenuItem | null {
  return submenu("ctx.follow", t("跟隨播放線"), Move3d, () =>
    FOLLOW_MODES.map((m) =>
      item(
        adhoc(`ctx.follow.${m}`, {
          title: FOLLOW_LABEL[m],
          checked: () => usePlayback.getState().followMode === m,
          run: () => usePlayback.getState().setFollowMode(m),
        }),
      ),
    ),
  );
}

function zoomSubmenu(range: FrameRange | null): MenuItem | null {
  return submenu("ctx.zoom", t("縮放時間軸"), ZoomIn, () => [...byIds(["view.zoomIn", "view.zoomOut", "view.zoomFit"], CTX), range && zoomToRangeItem(range)]);
}

const VIEW_MODE_IDS = ["view.mode.normal", "view.mode.stabilized", "view.mode.replaced", "view.mode.split", "view.mode.difference"];
// captions.toggleVisible 在選單列放在 檢視 › 圖層（feat/captions），右鍵的圖層子選單要跟選單列一致；沒登記（測試 / 舊組合）時 byIds 會略過
const LAYER_IDS = ["view.toggleMasks", "view.toggleSurface", "view.toggleGrid", "view.toggleTrackHud", "view.toggleDarkenImage", "captions.toggleVisible"];
/** 舞台空白處右鍵的字幕編輯（有字幕才列）：都以播放線為準，跟右鍵當下舞台畫的那一幀一致。 */
const STAGE_CAPTION_IDS = ["captions.splitAtPlayhead", "captions.insertCue", "captions.deleteCue"];

function viewModeSubmenu(): MenuItem | null {
  return submenu("ctx.viewMode", t("檢視模式"), Eye, () => byIds(VIEW_MODE_IDS, CTX));
}

function layersSubmenu(): MenuItem | null {
  return submenu("ctx.layers", t("圖層"), Layers, () => byIds(LAYER_IDS, CTX));
}

// ---- 此幀畫面 ----

async function copyFramePng(frame: number): Promise<void> {
  const m = activeMedia();
  if (!m?.proxy) return;
  try {
    const g = await copyFrameToClipboard(m.proxy.path, frame, m.proxy.fps);
    toast.success(t("已複製此幀畫面（{w}×{h}）", { w: g.width, h: g.height }));
  } catch (e) {
    toast.error(t("複製此幀畫面失敗：{msg}", { msg: errMessage(e) }));
  }
}

async function saveFramePng(frame: number): Promise<void> {
  const m = activeMedia();
  if (!m?.proxy) return;
  const stem = m.name.replace(/\.[^.]+$/, "");
  try {
    const g = await saveFrameAsPng(m.proxy.path, frame, m.proxy.fps, `${stem}.f${frame}.png`);
    if (g) toast.success(t("已存成 PNG（{w}×{h}）", { w: g.width, h: g.height }));
  } catch (e) {
    toast.error(t("另存此幀失敗：{msg}", { msg: errMessage(e) }));
  }
}

function frameImageItems(frame: number, caps: { copy: boolean; save: boolean }): Maybe[] {
  return [
    caps.copy && item(adhoc("ctx.frame.copyPng", { title: "複製此幀畫面（PNG）", icon: Copy, enabled: needsProxy, run: () => copyFramePng(frame) })),
    caps.save && item(adhoc("ctx.frame.savePng", { title: "另存此幀為 PNG…", icon: ImageDown, enabled: needsProxy, run: () => saveFramePng(frame) })),
  ];
}

// ============================================================================
// 舞台（VideoStage）
// ============================================================================

export interface StageMenuCtx {
  /** 右鍵當下的播放線幀（舞台畫的就是這一幀）。 */
  frame: number;
  /** 右鍵落在哪一條 track 的表面上（null = 空白處）。 */
  trackId: string | null;
  /** 這一幀有沒有關鍵幀。 */
  hasKeyframe: boolean;
  /** 這一幀是使用者硬釘（才列「還原為解算值」）；沒給就看 hasKeyframe。 */
  hasUserKeyframe?: boolean;
  /** 表面的標題（track 標籤）。 */
  trackLabel?: string;
  /** 右鍵落在的那條 track（外掛依它注入項目，例如 cards 的「換成… ▸」）。 */
  track?: TrackV1 | null;
  mediaId?: string | null;
  range?: FrameRange | null;
  fps?: Rational;
  /** 平台能力（預設當場偵測；測試明確給）。 */
  canCopyImage?: boolean;
  canSaveImage?: boolean;
  /** 目前影片有字幕軌（feat/captions）：空白處右鍵才列字幕編輯。 */
  hasCaptions?: boolean;
}

/**
 * VideoStage 右鍵（計畫 §9、規格 §2.3 G）。
 * 點在表面上：播放 → 關鍵幀（設 / 取角 / 參考影格 / 還原 / 移除）→ 加選減選 → 外掛的項目 → 檢視 → 此幀畫面 → 新增 / 刪除追蹤。
 * 點在空白處：播放 → 新增追蹤 / 偵測 → 檢視 → 此幀畫面與時間碼。
 */
export function stageMenuItems(ctx: StageMenuCtx): MenuItem[] {
  const caps = { copy: ctx.canCopyImage ?? canCopyImage(), save: ctx.canSaveImage ?? canSaveBinaryFile() };
  const playback: Maybe[] = [cmd("playback.toggle"), ctx.range && playRangeItem(ctx.range)];
  if (!ctx.trackId) {
    const fps = ctx.fps ?? fpsOf(activeMedia());
    return compact([
      playback,
      SEP,
      byIds(["track.new", ...collect((p) => p.menus?.stageEmpty), "object.find", "object.tool.select"], CTX),
      SEP,
      // 字幕畫在下三分之一、通常不在追蹤表面上，所以只放空白處；沒有字幕軌時整段不出現，免得三條都是灰的
      ctx.hasCaptions ? byIds(STAGE_CAPTION_IDS, CTX) : null,
      SEP,
      viewModeSubmenu(),
      layersSubmenu(),
      byIds(["view.maximizeStage", "view.mediaInfo"], CTX),
      SEP,
      frameImageItems(ctx.frame, caps),
      item(
        adhoc("ctx.frame.copyTimecode", {
          title: "複製此幀時間碼",
          icon: Clock,
          enabled: needsMedia,
          run: () => void copyToClipboard(`${timecode(ctx.frame, fps)} · ${ctx.frame}`, t("已複製時間碼")),
        }),
      ),
    ]);
  }
  // 物件 track（點在它的外接框上）：沒有關鍵幀 / 解算，只有物件自己的動作
  if (ctx.track?.kind === "object") {
    return compact([
      ctx.trackLabel ? header(ctx.trackLabel) : null,
      playback,
      SEP,
      byIds(["object.jump", "object.refine", "object.rename"], CTX),
      SEP,
      viewModeSubmenu(),
      layersSubmenu(),
      SEP,
      frameImageItems(ctx.frame, caps),
      SEP,
      cmd("object.delete", { ...CTX, danger: true }),
    ]);
  }
  return compact([
    ctx.trackLabel ? header(withSummary(ctx.trackLabel, ctx.mediaId ?? null, ctx.track)) : null,
    playback,
    SEP,
    byIds(["track.setKeyframe", "track.fromMask", "track.setReferenceFrame"], CTX),
    (ctx.hasUserKeyframe ?? ctx.hasKeyframe) && cmd("edit.revertFrameToSolved"),
    ctx.hasKeyframe && cmd("edit.deleteKeyframe", { ...CTX, danger: true }),
    SEP,
    byIds(["mask.tool.addSelection", "mask.tool.reduceSelection"], CTX),
    SEP,
    ctx.track && pluginTrackItems("stageTrack", { mediaId: ctx.mediaId ?? null, track: ctx.track, frame: ctx.frame }),
    byIds(["track.options"], CTX),
    SEP,
    viewModeSubmenu(),
    layersSubmenu(),
    SEP,
    frameImageItems(ctx.frame, caps),
    SEP,
    cmd("track.new"),
    cmd("edit.deleteTrack", { ...CTX, danger: true }),
  ]);
}

/** 右鍵當下的舞台情境（讀 store）。 */
export function stageMenuCtxNow(trackId: string | null): StageMenuCtx {
  const mediaId = useProject.getState().activeMediaId;
  const frame = usePlayback.getState().frame;
  const edits = useEdits.getState();
  const tr = mediaId && trackId ? (edits.tracks[mediaId] ?? []).find((x) => x.id === trackId) ?? null : null;
  const kf = tr?.keyframes.find((k) => k.frame === frame);
  return {
    frame,
    trackId: tr ? tr.id : null,
    hasKeyframe: !!kf,
    hasUserKeyframe: kf?.source === "user",
    trackLabel: tr?.label,
    track: tr,
    mediaId,
    range: useTimeline.getState().range,
    fps: fpsOf(activeMedia()),
    hasCaptions: !!(mediaId && edits.captions[mediaId]),
  };
}

// ============================================================================
// 時間軸（FrameTimeline）
// ============================================================================

export interface TimelineMenuCtx {
  target: TimelineContextTarget;
  mediaId: string | null;
  frames: number;
  fps: Rational;
  range: FrameRange | null;
  pendingIn: number | null;
  pendingOut: number | null;
  shots: ShotV1[];
  tracks: TrackV1[];
  /**
   * 時間軸座標空間（M2.12）。沒給 = 素材空間（M1 的選單原樣）。
   * 序列空間時 target.frame、range、frames、fps 都是**序列**的；鏡頭 / 追蹤範圍操作是來源 k 的，不能拿序列幀去做（會作用在另一段畫面上），所以不列。
   */
  space?: "sequence" | "source";
  /** 序列空間要剪的序列（隱含序列 = 作用中媒體整段）。 */
  seq?: SequenceV2 | null;
}

export function timelineMenuCtxNow(target: TimelineContextTarget): TimelineMenuCtx {
  const m = activeMedia();
  const tl = useTimeline.getState();
  const e = useEdits.getState();
  const mediaId = m?.id ?? null;
  const seq = inSequenceSpace() ? viewSequenceNow() : null;
  return {
    target,
    mediaId,
    frames: seq ? durationFrames(seq) : m?.proxy?.frames ?? 0,
    fps: seq ? seq.fps : fpsOf(m),
    range: tl.range,
    pendingIn: tl.pendingIn,
    pendingOut: tl.pendingOut,
    shots: mediaId ? e.shots[mediaId] ?? [] : [],
    tracks: mediaId ? e.tracks[mediaId] ?? [] : [],
    space: seq ? "sequence" : "source",
    seq,
  };
}

function inRange(ctx: TimelineMenuCtx): boolean {
  const r = ctx.range;
  return !!r && ctx.target.frame >= r.in && ctx.target.frame < r.out;
}

/** 時間軸右鍵的總入口：依點到的東西分派。 */
export function timelineMenuItems(ctx: TimelineMenuCtx): MenuItem[] {
  const tg = ctx.target;
  switch (tg.kind) {
    case "keyframe": {
      const tr = ctx.tracks.find((x) => x.id === tg.trackId);
      return tr ? keyframeMenuItems(ctx, tr, tg.frame) : [];
    }
    case "reference": {
      const tr = ctx.tracks.find((x) => x.id === tg.trackId);
      return tr ? referenceMenuItems(ctx, tr) : [];
    }
    case "lane": {
      const tr = ctx.tracks.find((x) => x.id === tg.trackId);
      return tr ? laneMenuItems(ctx, tr, tg.frame) : [];
    }
    case "range":
      return rangeMenuItems(ctx);
    case "shot": {
      const shot = ctx.shots.find((s) => s.id === tg.shotId);
      const shotItems = shot && ctx.mediaId ? shotMenuItems({ shot, shots: ctx.shots, mediaId: ctx.mediaId, fps: ctx.fps, frames: ctx.frames, frame: tg.frame }) : [];
      return compact([inRange(ctx) && rangeSummaryItems(ctx), SEP, shotItems]);
    }
    case "timeline":
      return compact([inRange(ctx) && rangeSummaryItems(ctx), SEP, frameMenuItems(ctx, tg.frame)]);
  }
}

/** A：尺規 / 範圍列空白 / 縮圖列 / 空白處。 */
export function frameMenuItems(ctx: TimelineMenuCtx, frame: number): MenuItem[] {
  const seq = ctx.space === "sequence" ? ctx.seq ?? null : null;
  // 序列空間的 frame 是序列幀：鏡頭是來源 k 的，拿序列幀去找鏡頭 / 切鏡頭會作用在另一段畫面上
  const shot = seq ? null : shotAt(ctx.shots, frame);
  return compact([
    item(adhoc("ctx.playFromHere", { title: "從這裡播放", icon: Play, enabled: needsProxy, run: () => (seq ? playFromSequence(seq, frame) : playFrom(frame)) })),
    item(adhoc("ctx.markInHere", { title: "在這裡設入點", icon: ArrowLeftToLine, shortcutOf: "playback.markIn", enabled: needsMedia, run: () => markAt("in", frame) })),
    item(adhoc("ctx.markOutHere", { title: "在這裡設出點", icon: ArrowRightToLine, shortcutOf: "playback.markOut", enabled: needsMedia, run: () => markAt("out", frame) })),
    shot && item(adhoc("ctx.shotToRange", { title: "將此處鏡頭設為範圍", icon: SquareDashed, shortcutOf: "playback.markShot", run: () => setRangeTo(shot.startFrame, shot.endFrame) })),
    ctx.frames > 0 &&
      (seq
        ? // 正式指令 playback.rangeAll 取的是作用中媒體的 proxy 幀數；序列空間的「整段」是序列長度 T
          item(adhoc("ctx.seq.rangeAll", { title: "整條序列設為範圍", icon: SquareDashed, enabled: needsSequenceSpace, run: () => useTimeline.getState().rangeAll(ctx.frames) }))
        : preferCmd("playback.rangeAll", () => adhoc("ctx.rangeAll", { title: "整支影片設為範圍", icon: SquareDashed, enabled: needsMedia, run: () => useTimeline.getState().rangeAll(ctx.frames) }))),
    SEP,
    seq ? sequenceFrameItems(frame) : item(adhoc("ctx.cutHere", { title: "在這裡切鏡頭", icon: Scissors, shortcutOf: "edit.shotCutAt", enabled: () => canCutAt(ctx.shots, frame), run: () => cutAt(frame) })),
    SEP,
    clearItems(ctx.range, ctx.pendingIn, ctx.pendingOut),
    SEP,
    zoomSubmenu(ctx.range),
    followSubmenu(),
  ]);
}

/** 右鍵的幀落在範圍內時，放在最上面的精簡範圍段（完整版在範圍列本體上）。 */
function rangeSummaryItems(ctx: TimelineMenuCtx): Maybe[] {
  const r = ctx.range;
  if (!r) return [];
  return [
    header(rangeTitle(r, ctx.fps)),
    playRangeItem(r),
    cmd("playback.loop"),
    zoomToRangeItem(r),
    cmd("export.range"),
    // 序列空間：範圍是序列幀，追蹤 / 遮罩 / 辨識的範圍版指令吃的是來源 k，換成序列的「提取範圍」
    ctx.space === "sequence" ? cmd("sequence.extractRange") : submenu("ctx.rangeOps", t("範圍內的操作"), Target, () => byIds(RANGE_TRACK_OPS, CTX)),
  ];
}

/** 範圍版的追蹤 / 遮罩 / 辨識（來源 k 空間）。 */
const RANGE_TRACK_OPS = ["mask.propagateRange", "track.solveRange"];
/** 範圍選單的序列追加（§11）：閃避 / 靜音是 M2.15 的指令，登記了才列。 */
const RANGE_SEQUENCE_AUDIO_OPS = RANGE_AUDIO_MENU_IDS;

/** B：範圍列本體 / 握把。 */
export function rangeMenuItems(ctx: TimelineMenuCtx): MenuItem[] {
  const r = ctx.range;
  if (!r) return [];
  const seqSpace = ctx.space === "sequence";
  return compact([
    header(rangeTitle(r, ctx.fps)),
    playRangeItem(r),
    cmd("playback.loop"),
    zoomToRangeItem(r),
    SEP,
    // §11 範圍選單的序列追加：提取（後面接上）／移除（留空隙），放在輸出前面 —— 剪輯是這個選單在序列空間最常做的事
    seqSpace && [cmd("sequence.extractRange", { ...CTX, danger: true }), cmd("sequence.liftRange"), ...byIds(RANGE_SEQUENCE_AUDIO_OPS, CTX)],
    SEP,
    cmd("export.range"),
    exportFrameInRangeItem(r, ctx.target.frame, ctx.fps),
    SEP,
    !seqSpace && byIds(RANGE_TRACK_OPS, CTX),
    SEP,
    preferCmd("playback.gotoIn", () => adhoc("ctx.gotoIn", { title: "跳到入點", icon: SkipBack, enabled: needsMedia, run: () => A.seekTo(r.in) })),
    preferCmd("playback.gotoOut", () => adhoc("ctx.gotoOut", { title: "跳到出點（範圍最後一幀）", icon: SkipForward, enabled: needsMedia, run: () => A.seekTo(r.out - 1) })),
    clearItems(r, null, null),
  ]);
}

export interface ShotMenuCtx {
  shot: ShotV1;
  shots: ShotV1[];
  mediaId: string;
  fps: Rational;
  frames: number;
  /** 點在鏡頭帶上的幀（才有「在這裡切鏡頭」）；側欄的鏡頭列沒有。 */
  frame: number | null;
}

/** C：鏡頭帶 / 左側欄鏡頭列。 */
export function shotMenuItems(ctx: ShotMenuCtx): MenuItem[] {
  const list = sortedShots(ctx.shots);
  const i = list.findIndex((s) => s.id === ctx.shot.id);
  if (i < 0) return [];
  const s = list[i];
  const prev = i > 0 ? list[i - 1] : null;
  const next = i + 1 < list.length ? list[i + 1] : null;
  const len = s.endFrame - s.startFrame;
  const title = t("鏡頭 {n} · {a}–{b} · {len} 幀 · {kind}", { n: i + 1, a: timecode(s.startFrame, ctx.fps), b: timecode(s.endFrame, ctx.fps), len, kind: t(SHOT_KIND_LABEL[s.kind]) });
  const merge = (id: string) =>
    withUndoToast(t("已合併鏡頭"), () => {
      useEdits.getState().mergeShots(ctx.mediaId, id);
    });
  return compact([
    header(title),
    item(adhoc("ctx.shot.toRange", { title: "將此鏡頭設為範圍", icon: SquareDashed, shortcutOf: "playback.markShot", run: () => setRangeTo(s.startFrame, s.endFrame) })),
    item(adhoc("ctx.shot.play", { title: "播放此鏡頭", icon: Play, enabled: needsProxy, run: () => playSpan(s.startFrame, s.endFrame, false) })),
    item(adhoc("ctx.shot.gotoStart", { title: "跳到鏡頭開頭", icon: SkipBack, enabled: needsMedia, run: () => A.seekTo(s.startFrame) })),
    item(adhoc("ctx.shot.gotoEnd", { title: "跳到鏡頭結尾", icon: SkipForward, enabled: needsMedia, run: () => A.seekTo(Math.max(s.startFrame, s.endFrame - 1)) })),
    item(adhoc("ctx.shot.zoom", { title: "縮放到此鏡頭", icon: ZoomIn, enabled: needsMedia, run: () => zoomTo(s.startFrame, s.endFrame) })),
    SEP,
    ctx.frame != null && item(adhoc("ctx.shot.cutHere", { title: "在這裡切鏡頭", icon: Scissors, shortcutOf: "edit.shotCutAt", enabled: () => canCutAt(list, ctx.frame!), run: () => cutAt(ctx.frame!) })),
    item(adhoc("ctx.shot.mergePrev", { title: "與上一個鏡頭合併", icon: Merge, enabled: () => (prev ? OK : { ok: false, why: "這已經是第一個鏡頭" }), run: () => (prev ? merge(prev.id) : undefined) })),
    item(adhoc("ctx.shot.mergeNext", { title: "與下一個鏡頭合併", icon: Merge, enabled: () => (next ? OK : { ok: false, why: "這已經是最後一個鏡頭" }), run: () => merge(s.id) })),
    SEP,
    item(adhoc("ctx.shot.redetect", { title: "重新偵測鏡頭切點", icon: RefreshCw, enabled: () => shotDetectGuard(ctx.mediaId), run: () => redetectShots(ctx.mediaId) })),
  ]);
}

function trackTitle(ctx: TimelineMenuCtx, tr: TrackV1): string {
  const list = sortedShots(ctx.shots);
  const i = list.findIndex((s) => s.id === tr.shotId);
  const parts = [tr.label];
  if (i >= 0) parts.push(t("鏡頭 {n}", { n: i + 1 }));
  const summary = pluginTrackSummary(ctx.mediaId, tr);
  if (summary) parts.push(summary);
  return parts.join(" · ");
}

/** D：追蹤車道（解算列 / 使用者列；FrameTimeline 右鍵時已選取那條 track）。 */
export function laneMenuItems(ctx: TimelineMenuCtx, tr: TrackV1, frame: number): MenuItem[] {
  const shot = ctx.shots.find((s) => s.id === tr.shotId);
  const [a, b] = shot ? [shot.startFrame, shot.endFrame] : [0, ctx.frames];
  const inShot = frame >= a && frame < b;
  return compact([
    header(trackTitle(ctx, tr)),
    inShot && atFrame("track.setKeyframe", "ctx.lane.keyframeHere", "在這裡設關鍵幀", frame),
    inShot && atFrame("track.setReferenceFrame", "ctx.lane.referenceHere", "在這裡設為參考影格", frame),
    cmd("track.goToReferenceFrame"),
    SEP,
    inShot && atFrame("track.retrackFromHere", "ctx.lane.retrackHere", "從這裡重追", frame),
    submenu("ctx.lane.solve", t("解算"), RefreshCw, () => [
      ...byIds(["track.trackToStart", "track.stepTrackBack", "track.stopTrack", "track.stepTrackFwd", "track.trackToEnd", "track.solveRange"], CTX),
      SEP,
      ...byIds(["track.clearBackwards", "track.clearForwards", "track.clearAll"], CTX),
    ]),
    byIds(["playback.prevLowConfidence", "playback.nextLowConfidence"], CTX),
    ctx.frames > 0 && item(adhoc("ctx.lane.shotToRange", { title: "將此追蹤的鏡頭設為範圍", icon: SquareDashed, run: () => setRangeTo(a, b) })),
    SEP,
    pluginTrackItems("lane", { mediaId: ctx.mediaId, track: tr, frame }),
    SEP,
    byIds(["track.options", "track.insert"], CTX),
    submenu("ctx.lane.trackData", t("追蹤資料"), FileText, () => byIds(["file.exportTrackData", "export.copyNukeCornerPin", "export.copyAeCornerPin"], CTX)),
    SEP,
    cmd("edit.deleteTrack", { ...CTX, danger: true }),
  ]);
}

/** E：關鍵幀菱形（FrameTimeline 右鍵時已選取菱形並 seek 過去，指令的「這一幀」就是它）。 */
export function keyframeMenuItems(_ctx: TimelineMenuCtx, tr: TrackV1, frame: number): MenuItem[] {
  const kf = tr.keyframes.find((k) => k.frame === frame);
  const locked = kf?.lockedCorners?.filter(Boolean).length ?? 0;
  const parts = [t("關鍵幀 {k}", { k: frame })];
  if (kf) parts.push(t(kf.source === "user" ? "使用者硬釘" : "偵測器"));
  if (locked) parts.push(t("鎖定 {n} 角", { n: locked }));
  return compact([
    header(parts.join(" · ")),
    byIds(["adjust.toggleLock", "track.fromMask", "track.setReferenceFrame"], CTX),
    kf?.source === "user" && cmd("edit.revertFrameToSolved"),
    SEP,
    cmd("edit.deleteKeyframe", { ...CTX, danger: true }),
  ]);
}

/** F：使用者列上的參考影格錨標。 */
export function referenceMenuItems(ctx: TimelineMenuCtx, tr: TrackV1): MenuItem[] {
  const mediaId = ctx.mediaId;
  return compact([
    header(tr.referenceFrame != null ? `${t("參考影格 {k}", { k: tr.referenceFrame })} · ${tr.label}` : tr.label),
    cmd("track.goToReferenceFrame"),
    item(command("track.setReferenceFrame"), { ...CTX, label: t("在播放線重新設定參考影格") }),
    tr.referenceFrame != null &&
      !!mediaId &&
      item(
        adhoc("ctx.ref.clear", {
          title: "清除參考影格",
          icon: Ban,
          run: () => useEdits.getState().setTrackFields(mediaId, tr.id, { referenceFrame: null }, "清除參考影格"),
        }),
      ),
  ]);
}

// ============================================================================
// 序列時間軸（M2.12，docs/editor-m2-design.md §11）：V1 片段 / 空白 / 音訊片段；範圍與尺規的追加在上面兩支裡
// ============================================================================

/** 片段右鍵「原音 ▸」：M2.15 的音訊指令登記了才出現（沒有任何一條時整個子選單不列）。 */
const CLIP_ORIGINAL_AUDIO_IDS = CLIP_AUDIO_MENU_IDS;
/** 片段右鍵「修剪到播放線」：M2.13 的指令。 */
const CLIP_TRIM_IDS = ["sequence.rippleTrimStart", "sequence.rippleTrimEnd"];

export interface SeqItemMenuCtx {
  seq: SequenceV2;
  /** 右鍵點到的序列幀。 */
  frame: number;
  /** 標題列的媒體名；沒給用 id。 */
  mediaName?: (mediaId: string) => string;
}

function placedItem(seq: SequenceV2, id: string) {
  return placeVideo(seq).find((p) => p.item.id === id) ?? null;
}

/** 從序列幀 t 播放：t 落在作用中媒體的片段上就等 seek 完成再播（同 M1 playFrom）；其他情況交給序列 seek（M2.11 的播放器接手換媒體 / 空白）。 */
async function playFromSequence(seq: SequenceV2, frame: number): Promise<void> {
  const m = mapFrame(seq, frame);
  if (m.item?.kind === "clip" && m.itemK !== null && m.item.mediaId === useProject.getState().activeMediaId) await seekToFrame(m.itemK);
  else seekSequenceNow(frame);
  play();
}

/** 尺規 / 空白處的序列追加（§11「尺規與空白 frameMenuItems 追加」）：在這裡分割所有軌、在這裡加入音訊…（M2.14 的指令登記了才列）。 */
/**
 * 「在這裡…」：借一個「在播放線做某事」的指令，先把播放線移到點擊處再跑它。
 *
 * **`enabled` 不能照抄那個指令的**：那些指令是 `needsPlayheadInSequence`，而選單是在
 * 「還沒 seek 過去」的時候建的 —— 播放線停在序列外時整條會顯示成停用
 * （「播放線這一幀沒有用在序列裡」），但實際上按下去是會成功的。
 * 改用點擊處自己的條件，跟「在這裡分割所有軌」同一個作法。測試裡有這個情形（播放線 k=0 不在序列上）。
 *
 * 標題也要換掉：原標題是「在**播放線**插入空白」，在右鍵選單裡會講錯位置。
 */
function seekThenRun(frame: number, commandId: string, id: string, title: string): Maybe {
  const c = command(commandId);
  if (!c) return null;
  return item({
    ...c,
    id,
    title,
    titleParams: undefined,
    children: undefined,
    checked: undefined,
    enabled: needsSequenceSpace,
    run: async () => {
      seekSequenceNow(frame);
      await c.run();
    },
  });
}

function addMarkerHereItem(frame: number): Maybe {
  return seekThenRun(frame, "sequence.addMarker", "ctx.seq.markerHere", "在這裡加標記");
}

function sequenceFrameItems(frame: number): Maybe[] {
  return [
    item(adhoc("ctx.seq.splitAllHere", { title: "在這裡分割所有軌", icon: SquareSplitHorizontal, shortcutOf: "sequence.splitAll", enabled: () => canSplitAt(frame, "all"), run: () => void splitAtFrame(frame, "all") })),
    addMarkerHereItem(frame),
    seekThenRun(frame, "sequence.insertGap", "ctx.seq.insertGapHere", "在這裡插入空白（3 秒）"),
    seekThenRun(frame, "audio.addAtPlayhead", "ctx.seq.addAudioHere", "在這裡加入音訊…"),
  ];
}

/** 片段右鍵的共用段：在播放線分割（B）／在這裡分割、波紋刪除／留空隙、停用。V1 與音訊片段共用（指令本身吃「選取」，右鍵時已選好）。 */
function clipEditItems(clipId: string, frame: number, inside: boolean): Maybe[] {
  return [
    cmd("sequence.split"),
    item(
      adhoc("ctx.clip.splitHere", {
        title: "在這裡分割",
        icon: Scissors,
        enabled: both(needsSequenceSpace, () => (inside ? OK : { ok: false, why: "點在片段邊界上，這裡切不了" })),
        run: () => void splitClipAt(clipId, frame),
      }),
    ),
    SEP,
    // 剪下 / 複製 / 貼上是通用順序；缺了剪下會讓人以為這裡沒有剪貼簿
    cmd("sequence.cutClips"),
    cmd("sequence.copyClips"),
    cmd("sequence.duplicate"),
    cmd("sequence.pasteClips"),
    SEP,
    cmd("sequence.rippleDelete", { ...CTX, danger: true }),
    cmd("sequence.lift"),
    cmd("sequence.toggleEnabled"),
    cmd("sequence.renameClip"),
  ];
}

/**
 * 片段的微調（滑移 / 滑內容 / 換順序）收成子選單。
 *
 * 這六個都是鍵盤動作（Alt+, / Alt+. 之類），不放在右鍵裡就只剩「看過說明文件的人才知道」。
 * 但一次攤六條會把片段選單推到視窗外，所以照檔頭的原則收成一層（「次要的一組收進子選單」）。
 */
const CLIP_NUDGE_IDS = ["sequence.nudgeLeft", "sequence.nudgeRight", "sequence.slipLeft", "sequence.slipRight", "sequence.moveItemLeft", "sequence.moveItemRight"];

/** V1 片段右鍵（§11 clipMenuItems）。 */
export function clipMenuItems(ctx: SeqItemMenuCtx, clipId: string): MenuItem[] {
  const p = placedItem(ctx.seq, clipId);
  if (!p || p.item.kind !== "clip") return [];
  const c = p.item;
  const fps = ctx.seq.fps;
  // 點到的幀對應的來源 k（「在素材中開啟」跳到點的位置，不是片段開頭）；夾在片段內，點在出點邊緣時取最後一幀
  const k = c.srcIn + Math.max(0, Math.min(p.t1 - p.t0 - 1, ctx.frame - p.t0));
  return compact([
    header(t("{name} · 來源 {in}–{out}（{n} 幀）", { name: ctx.mediaName?.(c.mediaId) ?? c.mediaId, in: timecode(c.srcIn, fps), out: timecode(c.srcOut, fps), n: c.srcOut - c.srcIn })),
    // 播放放在最上面：右鍵一個片段最想做的第一件事是聽 / 看它（鏡頭選單也是這個順序）
    item(adhoc("ctx.clip.play", { title: "播放這個片段", icon: Play, enabled: needsProxy, run: () => playSpan(p.t0, p.t1, false) })),
    SEP,
    clipEditItems(clipId, ctx.frame, ctx.frame > p.t0 && ctx.frame < p.t1),
    SEP,
    submenu("ctx.clip.original", t("原音"), Volume2, () => byIds(CLIP_ORIGINAL_AUDIO_IDS, CTX)),
    submenu("ctx.clip.nudge", t("微調"), Move, () => byIds(CLIP_NUDGE_IDS, CTX)),
    SEP,
    byIds(CLIP_TRIM_IDS, CTX),
    // 延伸編輯（roll）跟修剪是同一類動作：都在動剪接點，只是這個不改序列總長
    cmd("sequence.extendEdit"),
    // 有正式指令（X）就用它：右鍵與快捷鍵做同一件事（多選時整個選取都算），沒登記才退回只設這一個片段
    preferCmd("sequence.markClip", () => adhoc("ctx.clip.toRange", { title: "將片段設為範圍", icon: SquareDashed, enabled: needsSequenceSpace, run: () => setRangeTo(p.t0, p.t1) })),
    SEP,
    item(adhoc("ctx.clip.openInSource", { title: "在素材中開啟（對應幀）", icon: LocateFixed, shortcutOf: "sequence.matchFrame", enabled: needsProxy, run: () => openInSource(c.mediaId, k) })),
    // 追蹤永遠在素材空間做（k 為鍵，§1.2 I1）：先跳過去再新增，免得在序列空間建了一條看不到的追蹤
    command("track.new") && item(adhoc("ctx.clip.newTrack", { title: "在此片段新增追蹤", icon: PlusCircle, enabled: needsProxy, run: () => openInSource(c.mediaId, k, () => void runCommand("track.new", "context")) })),
    cmd("audio.addAtPlayhead"),
    cmd("audio.clipInfo"),
  ]);
}

/** 空白右鍵（§11 gapMenuItems）：刪除空白（後面接上）／在這裡插入目前媒體。 */
export function gapMenuItems(ctx: SeqItemMenuCtx, gapId: string): MenuItem[] {
  const p = placedItem(ctx.seq, gapId);
  if (!p || p.item.kind !== "gap") return [];
  const at = p.t0;
  return compact([
    header(t("空白 · {n} 幀", { n: p.item.length })),
    item(adhoc("ctx.gap.close", { title: "刪除空白（後面接上）", icon: BetweenHorizontalStart, enabled: needsSequenceSpace, run: () => closeGap(gapId) }), { ...CTX, danger: true }),
    item(adhoc("ctx.gap.insertMedia", { title: "在這裡插入目前媒體", icon: Film, enabled: both(needsSequenceSpace, needsProxy), run: () => void insertActiveMediaAt(at) })),
    SEP,
    item(adhoc("ctx.gap.toRange", { title: "將空白設為範圍", icon: SquareDashed, enabled: needsSequenceSpace, run: () => setRangeTo(p.t0, p.t1) })),
  ]);
}

/** 音訊片段右鍵的剪輯段（分割／刪除／停用；增益、淡化、閃避在 M2.15 加）。 */
export function audioClipMenuItems(ctx: SeqItemMenuCtx, clipId: string): MenuItem[] {
  const lane = ctx.seq.audioLanes.find((l) => l.clips.some((c) => c.id === clipId));
  const clip = lane?.clips.find((c) => c.id === clipId);
  if (!lane || !clip) return [];
  const s = samplesOfFrame(ctx.frame, ctx.seq.fps);
  return compact([
    header(clip.label ? `${lane.name} · ${clip.label}` : lane.name),
    // 音訊片段的 start / length 是序列樣本，換成幀要往外取整，不然頭尾會被切掉一點
    item(
      adhoc("ctx.audioClip.play", {
        title: "播放這個片段",
        icon: Play,
        enabled: needsProxy,
        run: () => {
          const per = ctx.seq.fps.num / (ctx.seq.fps.den * SEQ_SAMPLE_RATE);
          playSpan(Math.floor(clip.start * per), Math.ceil((clip.start + clip.length) * per), false);
        },
      }),
    ),
    SEP,
    clipEditItems(clipId, ctx.frame, clip.start < s && s < clip.start + clip.length),
    // M2.15：靜音、增益 ▸／淡入 ▸／淡出 ▸／曲線 ▸、範圍內閃避／靜音、移到新音軌…（§11 音訊片段 2～6）
    ...AUDIO_CLIP_MENU_GROUPS.flatMap((ids) => [SEP, byIds(ids, CTX)]),
  ]);
}

/** 音軌空白處右鍵（§11 audioLaneMenuItems）：指令吃「按右鍵的那一條」，打開前先記下來。 */
export function audioLaneMenuItems(ctx: SeqItemMenuCtx, laneId: string): MenuItem[] {
  const lane = ctx.seq.audioLanes.find((l) => l.id === laneId);
  if (!lane) return [];
  setAudioMenuContext({ laneId, frame: ctx.frame });
  return compact([
    header(lane.name),
    item(adhoc("ctx.audioLane.playFromHere", { title: "從這裡播放", icon: Play, enabled: needsProxy, run: () => playFromSequence(ctx.seq, ctx.frame) })),
    ...AUDIO_LANE_MENU_GROUPS.flatMap((ids) => [SEP, byIds(ids, CTX)]),
  ]);
}

/** 序列空間時間軸右鍵的總入口：片段 / 空白 / 音訊片段有自己的選單，其餘（尺規、範圍、車道、菱形）沿用 timelineMenuItems。 */
export function sequenceMenuItems(hit: SeqHit, ctx: TimelineMenuCtx): MenuItem[] {
  const seq = ctx.seq;
  if (!seq) return timelineMenuItems(ctx);
  const ic: SeqItemMenuCtx = { seq, frame: hit.frame, mediaName: (id) => mediaById(id)?.name ?? id };
  switch (hit.kind) {
    case "clip":
    case "original":
      return clipMenuItems(ic, hit.clipId);
    case "gap":
      return gapMenuItems(ic, hit.gapId);
    case "audioClip":
      return audioClipMenuItems(ic, hit.clipId);
    case "audioLane": {
      const items = audioLaneMenuItems(ic, hit.laneId);
      return items.length > 1 ? items : timelineMenuItems(ctx);
    }
    default:
      return timelineMenuItems(ctx);
  }
}

/**
 * 序列空間的右鍵（FrameTimeline 在 hitSequence 命中時呼叫）。先選取點到的東西：
 * 片段沒在選取裡 → 只選它（Premiere / Resolve 右鍵會選取），在選取裡 → 保留多選、焦點回到片段；
 * 車道 / 菱形照 M1（選 track / 選菱形並把播放線移到序列上被點的那一次出現）。右鍵不移動播放線。
 */
export function openSequenceContextMenu(req: { clientX: number; clientY: number; hit: SeqHit }): void {
  const hit = req.hit;
  const tl = useTimeline.getState();
  const clipId = hit.kind === "clip" || hit.kind === "original" || hit.kind === "audioClip" ? hit.clipId : hit.kind === "gap" ? hit.gapId : null;
  if (clipId) {
    if (tl.selectedClipIds.includes(clipId)) tl.setFocus("clip");
    else tl.selectClips([clipId]);
  } else if (hit.kind === "solved" || hit.kind === "user" || hit.kind === "reference") tl.selectTrack(hit.trackId);
  else if (hit.kind === "keyframe") {
    tl.selectKeyframe({ trackId: hit.trackId, frame: hit.k });
    seekSequenceNow(hit.frame);
  }
  openContextMenu({ x: req.clientX, y: req.clientY }, () => sequenceMenuItems(hit, timelineMenuCtxNow(contextTargetOf(toTimelineHit(hit), useTimeline.getState().range))));
}

// ============================================================================
// 左側欄：媒體列
// ============================================================================

function proxyRebuildGuard(id: string): Enabled {
  const m = mediaById(id);
  if (!m) return { ok: false, why: "先開啟一支影片" };
  if (m.proxyState === "building") return { ok: false, why: "proxy 還在建，等一下" };
  if (!engineReady() && !pyenvReady()) return needsEngine();
  return OK;
}

function shotDetectGuard(id: string): Enabled {
  const m = mediaById(id);
  if (!m) return { ok: false, why: "先開啟一支影片" };
  if (!engineReady()) return needsEngine();
  if (m.proxyState === "building") return { ok: false, why: "proxy 還在建，等一下" };
  if (m.proxyState !== "ready") return { ok: false, why: "還沒有 proxy（引擎就緒後會自動建）" };
  if (runningJob("shots", id)) return { ok: false, why: "鏡頭偵測進行中" };
  return OK;
}

function busyGuard(id: string): Enabled {
  const busy = useJobs.getState().jobs.some((j) => j.mediaId === id && (j.status === "queued" || j.status === "running"));
  return busy ? { ok: false, why: "這支影片還有工作在跑，等它結束再清" } : OK;
}

async function redetectShots(mediaId: string): Promise<void> {
  const ok = await uiConfirm(t("重新偵測會取代目前的鏡頭切點（可以復原）。要繼續嗎？"), { confirmText: t("重新偵測") });
  if (!ok) return;
  try {
    const shots = await detectShots(mediaId);
    toast.success(t("偵測到 {n} 個鏡頭", { n: shots.length }));
  } catch (e) {
    toast.error(errMessage(e));
  }
}

async function rebuildProxy(id: string): Promise<void> {
  const ok = await uiConfirm(t("重建 proxy 會重新轉檔整支影片，可能要幾分鐘。要繼續嗎？"), { confirmText: t("重建 proxy") });
  if (!ok) return;
  try {
    await ensureProxy(id, { force: true });
    toast.success(t("proxy 已重建"));
  } catch (e) {
    toast.error(errMessage(e));
  }
}

async function clearMediaCache(id: string): Promise<void> {
  const m = mediaById(id);
  if (!m) return;
  const ok = await uiConfirm(t("清除「{name}」的快取：proxy、索引、縮圖、遮罩與解算都會刪掉，之後自動重建 proxy，追蹤要重新解算。要繼續嗎？", { name: m.name }), {
    danger: true,
    confirmText: t("清除"),
  });
  if (!ok) return;
  const trackIds = (useEdits.getState().tracks[id] ?? []).map((x) => x.id);
  // 先讓舞台放掉 proxy.mp4：播放器還開著那個檔時，Windows 上整個資料夾刪不掉
  useProject.getState().updateMedia(id, { proxy: null, proxyState: "none" });
  await new Promise((r) => setTimeout(r, 250));
  try {
    await api.mediaCacheClear(id);
  } catch (e) {
    toast.error(errMessage(e));
    void useProject.getState().refreshProxy(id);
    return;
  }
  // 磁碟上的解與遮罩沒了：畫面上的也要一起清，追蹤標成待重解，不然看起來像還在
  useSolves.getState().clearMedia(trackIds);
  for (const tid of trackIds) useMasks.getState().clearTrack(tid);
  if (trackIds.length) useEdits.getState().markStale(id, trackIds);
  toast.success(t("已清除快取"));
  void ensureProxy(id).catch((e) => toast.error(errMessage(e)));
}

async function removeMediaFromProject(id: string): Promise<void> {
  const m = mediaById(id);
  if (!m) return;
  const e = useEdits.getState();
  const hasWork = (e.tracks[id]?.length ?? 0) > 0 || plugins().some((p) => p.menus?.mediaHasWork?.(id));
  // 移除會連編輯歷史一起清（store/project.ts removeMedia），無法復原：有東西才問，空的直接移
  if (hasWork && !(await uiConfirm(t("從專案移除「{name}」？這支影片的追蹤、格位與編輯歷史會一起移除，無法復原（影片檔本身不會刪）。", { name: m.name }), { danger: true, confirmText: t("移除") }))) return;
  useProject.getState().removeMedia(id);
}

/** I：左側欄媒體列。 */
/** 這支媒體的 proxy 好了沒（加入序列要 proxy 的幀數與 fps）。 */
function mediaProxyReady(mediaId: string): Enabled {
  return mediaById(mediaId)?.proxy ? OK : { ok: false, why: "proxy 還沒建好，建好之後才能加入序列" };
}

export function mediaMenuItems(mediaId: string): MenuItem[] {
  const m = mediaById(mediaId);
  if (!m) return [];
  const isActive = useProject.getState().activeMediaId === m.id;
  const info = command("view.mediaInfo");
  return compact([
    !isActive && item(adhoc("ctx.media.activate", { title: "設為作用中", icon: Film, run: () => useProject.getState().setActive(m.id) })),
    info &&
      item({
        ...info,
        id: "ctx.media.info",
        enabled: () => OK,
        // 直接開「這一列」的資訊，不先設為作用中（M1 驗收 L5）：切換作用中媒體會把播放線歸零、清掉範圍與選取（shell/Workspace），
        // 只是想看一眼另一支的規格卻把手上的工作狀態洗掉。對話框本來就吃 mediaId、看得了非作用中的那支
        run: () => openMediaInfo(m.id),
      }),
    item(adhoc("ctx.media.reveal", { title: "在資料夾中顯示", icon: FolderSearch, run: () => A.openPath(m.path) })),
    item(adhoc("ctx.media.copyPath", { title: "複製檔案路徑", icon: Copy, run: () => void copyToClipboard(m.path, t("已複製檔案路徑")) })),
    // §11 媒體右鍵追加（序列剪輯旗標開著才列）：對「這一列」的媒體動作，不必先設成作用中。
    // 只擋「還沒有 proxy」；fps / 尺寸不符由 addMediaToSequence 顯示帶修正按鈕的錯誤（先灰掉的話使用者看不到怎麼修）
    sequenceEditingEnabled() && [
      SEP,
      item(adhoc("ctx.media.appendToSequence", { title: "接到序列結尾", icon: ListEnd, enabled: () => mediaProxyReady(m.id), run: () => void addMediaToSequence(m.id, "append") })),
      item(adhoc("ctx.media.insertAtPlayhead", { title: "在播放線插入", icon: BetweenHorizontalStart, enabled: () => mediaProxyReady(m.id), run: () => void addMediaToSequence(m.id, "insert") })),
    ],
    SEP,
    item(adhoc("ctx.media.rebuildProxy", { title: "重建 proxy", icon: RefreshCw, enabled: () => proxyRebuildGuard(m.id), run: () => rebuildProxy(m.id) })),
    item(adhoc("ctx.media.redetectShots", { title: "重新偵測鏡頭切點", icon: Scissors, enabled: () => shotDetectGuard(m.id), run: () => redetectShots(m.id) })),
    item(adhoc("ctx.media.clearCache", { title: "清除快取…", icon: HardDrive, enabled: () => busyGuard(m.id), run: () => clearMediaCache(m.id) })),
    SEP,
    item(adhoc("ctx.media.remove", { title: "從專案移除", icon: Trash2, run: () => removeMediaFromProject(m.id) }), { ...CTX, danger: true }),
  ]);
}

// ============================================================================
// 掛點：各元件的 onContextMenu 只呼叫這幾支
// ============================================================================

type MenuEvent = MenuPoint & { preventDefault?: () => void; stopPropagation?: () => void };

/** 時間軸（FrameTimeline 已先選好車道 / 菱形的 track 並 seek 到菱形）。 */
export function openTimelineContextMenu(req: TimelineContextRequest): void {
  const tg = req.target;
  if (tg.kind === "lane" || tg.kind === "keyframe" || tg.kind === "reference") {
    const mediaId = useProject.getState().activeMediaId;
    const tr = mediaId ? (useEdits.getState().tracks[mediaId] ?? []).find((x) => x.id === tg.trackId) : null;
    // 外掛跟著選它自己的東西（例如 cards：格位跟著 track 選，車道右鍵的「換成…」才有對象）
    if (tr && mediaId) for (const p of plugins()) p.menus?.onTrackContext?.(mediaId, tr);
  }
  openContextMenu({ x: req.clientX, y: req.clientY }, () => timelineMenuItems(timelineMenuCtxNow(tg)));
}

// FrameTimeline 沒拿到 onContextMenuAt prop 時找這個全域掛點。本模組在啟動時就被選單列載入，
// 掛在這裡不必再動 Workspace；時間軸那邊只認得「一個處理器」，這一行就是全部的接線。
setTimelineContextMenuHandler(openTimelineContextMenu);

/** 舞台：`trackId` 是右鍵落在哪條 track 的表面上（null = 空白處）。先選取它，track 指令才有對象。 */
export function openStageContextMenu(e: MenuEvent, trackId: string | null): void {
  const mediaId = useProject.getState().activeMediaId;
  const tr = mediaId && trackId ? (useEdits.getState().tracks[mediaId] ?? []).find((x) => x.id === trackId) ?? null : null;
  if (tr) {
    const tl = useTimeline.getState();
    tl.selectTrack(tr.id);
    for (const p of plugins()) p.menus?.onTrackContext?.(mediaId!, tr);
  }
  const id = tr?.id ?? null;
  openContextMenu(e, () => stageMenuItems(stageMenuCtxNow(id)));
}

/** 「物件」分頁那一列的右鍵選單：呼叫端先選取那個物件，指令都作用在「選取的物件」上（跟舞台上點外接框同一組）。 */
export function objectRowMenuItems(label: string): MenuItem[] {
  return compact([header(label), byIds(["object.jump", "object.refine", "object.rename"], CTX), SEP, cmd("object.delete", { ...CTX, danger: true })]);
}

export function openMediaContextMenu(e: MenuEvent, mediaId: string): void {
  openContextMenu(e, () => mediaMenuItems(mediaId));
}

/** 左側欄鏡頭列（沒有「點擊的幀」，所以沒有「在這裡切鏡頭」）。 */
export function openShotContextMenu(e: MenuEvent, shotId: string): void {
  openContextMenu(e, () => {
    const m = activeMedia();
    if (!m) return [];
    const shots = useEdits.getState().shots[m.id] ?? [];
    const shot = shots.find((s) => s.id === shotId);
    return shot ? shotMenuItems({ shot, shots, mediaId: m.id, fps: fpsOf(m), frames: m.proxy?.frames ?? 0, frame: null }) : [];
  });
}
