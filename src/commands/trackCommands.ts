import {
  Aperture,
  Anchor,
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Eraser,
  FastForward,
  Flag,
  Lock,
  MinusCircle,
  MousePointer2,
  Move,
  PlusCircle,
  RefreshCw,
  Rewind,
  ScanSearch,
  Settings2,
  SlidersHorizontal,
  Square,
  SquareDashed,
  Target,
  Trash2,
  Undo2,
  Wand2,
} from "lucide-react";
// 範圍群組用到的圖示：獨立一段 import，免得跟其他群組改同一份 import 清單互相覆蓋
import { Clapperboard, StretchHorizontal, ZoomIn } from "lucide-react";
import { propagateSelectedTrackInRange, solveSelectedTrackInRange, trackRangeSpan } from "../frametimeline/rangeOps";
import { openDialog } from "../store/dialogs";
import { shotAt, useEdits } from "../store/edits";
import { activeFrames } from "../store/project";
import { usePlayback } from "../store/playback";
import { rangeEnds, useTimeline } from "../store/timeline";
import { MOTION_MODEL_LABEL } from "../video/labels";
import type { MotionModel } from "../project/format";
import * as A from "./appActions";
import { needsEngine, needsIdleTrack, needsMedia, needsProxy, needsRange, needsTrack, selectedTrackId, activeId } from "./guards";
import { OK } from "./registry";
import type { Command, Enabled } from "./types";

/**
 * 追蹤 / 調整追蹤 / 遮罩指令（計畫 §9）。用詞對齊 Mocha / Nuke / Fusion（決策 16）：
 * 表面 Surface ≠ 追蹤區域 Tracking Region、參考影格 Reference Frame、傳輸鍵式追蹤控制、AdjustTrack、加選 / 減選。
 */

function both(...fs: (() => Enabled)[]): () => Enabled {
  return () => {
    for (const f of fs) {
      const r = f();
      if (!r.ok) return r;
    }
    return OK;
  };
}

const MOTION_MODELS: MotionModel[] = ["translation", "similarity", "affine", "perspective"];

function currentMotionModel(): MotionModel | null {
  const mediaId = activeId();
  const id = selectedTrackId();
  if (!mediaId || !id) return null;
  return (useEdits.getState().tracks[mediaId] ?? []).find((t) => t.id === id)?.options.motionModel ?? null;
}

/**
 * 範圍版指令的守門：有範圍，而且範圍跟選中 track 的鏡頭有交集。
 * 放在這裡而不是 guards.ts：只有範圍版的追蹤 / 遮罩指令用得到，why 字串也跟著這張標籤表進 i18n 稽核。
 */
function needsRangeOnTrack(): Enabled {
  const mediaId = activeId();
  const id = selectedTrackId();
  if (!mediaId || !id) return OK;
  const e = useEdits.getState();
  const tr = (e.tracks[mediaId] ?? []).find((x) => x.id === id);
  if (!tr) return OK;
  return trackRangeSpan(tr, e.shots[mediaId] ?? [], useTimeline.getState().range) ? OK : { ok: false, why: "範圍與這條追蹤的鏡頭沒有重疊" };
}

function needsInPoint(): Enabled {
  const m = needsMedia();
  if (!m.ok) return m;
  return rangeEnds(useTimeline.getState()).in != null ? OK : { ok: false, why: "還沒有入點（I）" };
}

function needsOutPoint(): Enabled {
  const m = needsMedia();
  if (!m.ok) return m;
  return rangeEnds(useTimeline.getState()).out != null ? OK : { ok: false, why: "還沒有出點（O）" };
}

/** X：播放線所在鏡頭 → 範圍（Resolve / Premiere / FCP 的 Mark Clip）；不在任何鏡頭裡（還沒偵測）就整段。 */
function markShotAtPlayhead(): void {
  const mediaId = activeId();
  const frames = activeFrames();
  if (!mediaId || frames <= 0) return;
  const shot = shotAt(useEdits.getState().shots[mediaId] ?? [], usePlayback.getState().frame);
  useTimeline.getState().setRange(shot ? { in: shot.startFrame, out: shot.endFrame } : { in: 0, out: frames });
}

/**
 * 範圍（in / out）指令（規格 §1.2）。放在追蹤指令表的尾巴而不是 core.ts：範圍與它的時間軸手勢、範圍版追蹤 / 遮罩是同一組功能，
 * 分在同一個檔改起來才不會漏；指令 id 仍照慣例掛 playback / view 群組，選單與命令面板的分組不受檔案位置影響。
 * 播放範圍（playback.playRange）屬於傳輸列，在 core.ts。
 */
const RANGE_COMMANDS: Command[] = [
  { id: "playback.markShot", title: "將播放線所在鏡頭設為範圍", group: "playback", section: "範圍", icon: Clapperboard, shortcuts: ["X"], surfaces: ["menu", "palette", "context"], keywords: ["mark clip", "shot range"], enabled: needsProxy, run: () => markShotAtPlayhead() },
  { id: "playback.rangeAll", title: "整段設為範圍", group: "playback", section: "範圍", icon: StretchHorizontal, surfaces: ["menu", "palette", "context"], keywords: ["select all", "whole"], enabled: needsProxy, run: () => useTimeline.getState().rangeAll(activeFrames()) },
  { id: "playback.clearIn", title: "清除入點", group: "playback", section: "範圍", icon: Eraser, shortcuts: ["Alt+I"], surfaces: ["menu", "palette", "context"], enabled: needsInPoint, run: () => useTimeline.getState().clearIn() },
  { id: "playback.clearOut", title: "清除出點", group: "playback", section: "範圍", icon: Eraser, shortcuts: ["Alt+O"], surfaces: ["menu", "palette", "context"], enabled: needsOutPoint, run: () => useTimeline.getState().clearOut() },
  { id: "playback.gotoIn", title: "跳到入點", group: "playback", section: "範圍", icon: ArrowLeftToLine, shortcuts: ["Shift+I"], surfaces: ["menu", "palette", "context"], enabled: needsInPoint, run: () => A.seekTo(rangeEnds(useTimeline.getState()).in ?? 0) },
  // out 是不含的邊界：跳到 out−1 才是「範圍內最後一幀」，跳到 out 會落在範圍外（循環播放判定也會誤判離開範圍）
  { id: "playback.gotoOut", title: "跳到出點", group: "playback", section: "範圍", icon: ArrowRightToLine, shortcuts: ["Shift+O"], surfaces: ["menu", "palette", "context"], enabled: needsOutPoint, run: () => A.seekTo(Math.max(0, (rangeEnds(useTimeline.getState()).out ?? 1) - 1)) },
  { id: "view.zoomToRange", title: "縮放到範圍", group: "view", section: "縮放", icon: ZoomIn, shortcuts: ["Z"], surfaces: ["menu", "palette", "context"], keywords: ["zoom to selection", "zoom range"], enabled: needsRange, run: () => void useTimeline.getState().zoomToRange(null, activeFrames()) },
];

export const TRACK_COMMANDS: Command[] = [
  // ---- 追蹤 ----
  { id: "track.new", title: "新增追蹤（在播放線）", group: "track", section: "追蹤", icon: PlusCircle, shortcuts: ["N"], surfaces: ["menu", "palette", "context", "toolbar"], keywords: ["new track", "planar"], enabled: needsProxy, run: () => A.newTrackAtPlayhead() },
  { id: "track.tool.select", title: "工具：選取", group: "track", section: "工具", icon: MousePointer2, checked: () => useTimeline.getState().tool === "select", enabled: () => OK, run: () => useTimeline.getState().setTool("select") },
  { id: "track.tool.surface", title: "工具：表面（拖四角）", group: "track", section: "工具", icon: Square, shortcuts: ["V"], checked: () => useTimeline.getState().tool === "corner", enabled: () => OK, run: () => useTimeline.getState().setTool("corner") },
  { id: "track.tool.trackingRegion", title: "工具：追蹤區域", group: "track", section: "工具", icon: SquareDashed, shortcuts: ["R"], checked: () => useTimeline.getState().tool === "region", enabled: () => OK, run: () => useTimeline.getState().setTool("region") },
  { id: "track.setKeyframe", title: "在播放線設關鍵幀", group: "track", section: "關鍵幀", icon: Flag, shortcuts: ["K"], surfaces: ["menu", "palette", "context"], enabled: needsTrack, run: () => A.setKeyframeAtPlayhead() },
  { id: "track.fromMask", title: "從遮罩取角", group: "track", section: "關鍵幀", icon: Wand2, shortcuts: ["C"], surfaces: ["menu", "palette", "context"], enabled: both(needsTrack, needsEngine), run: () => A.quadFromMask() },
  { id: "track.setReferenceFrame", title: "設為參考影格", group: "track", section: "參考影格", icon: Anchor, shortcuts: ["Shift+K"], surfaces: ["menu", "palette", "context"], keywords: ["reference frame", "anchor"], enabled: needsTrack, run: () => A.setReferenceFrame() },
  { id: "track.goToReferenceFrame", title: "前往參考影格", group: "track", section: "參考影格", icon: Crosshair, enabled: needsTrack, run: () => A.goToReferenceFrame() },
  // 傳輸控制列（Fusion transport / Nuke clear all|backwards|forwards / AE analyze 1 frame）
  { id: "track.trackToStart", title: "追到頭", group: "track", section: "解算", icon: Rewind, enabled: both(needsIdleTrack, needsEngine), run: () => A.runSolve("toStart") },
  { id: "track.stepTrackBack", title: "往前解一幀", group: "track", section: "解算", icon: ChevronLeft, enabled: both(needsIdleTrack, needsEngine), run: () => A.runSolve("stepBwd") },
  { id: "track.stopTrack", title: "停止解算", group: "track", section: "解算", icon: Square, enabled: needsTrack, run: () => A.stopSolve() },
  { id: "track.stepTrackFwd", title: "往後解一幀", group: "track", section: "解算", icon: ChevronRight, enabled: both(needsIdleTrack, needsEngine), run: () => A.runSolve("stepFwd") },
  { id: "track.trackToEnd", title: "追到尾", group: "track", section: "解算", icon: FastForward, enabled: both(needsIdleTrack, needsEngine), run: () => A.runSolve("toEnd") },
  // 範圍版（規格 §1.3）：track.solve --from/--to 只重解「範圍 ∩ 鏡頭」，引擎把新解併回既有 solve
  { id: "track.solveRange", title: "只追範圍（入點→出點）", group: "track", section: "解算", icon: FastForward, surfaces: ["menu", "palette", "context"], keywords: ["range", "in out", "track range"], enabled: both(needsIdleTrack, needsRange, needsRangeOnTrack, needsEngine), run: () => solveSelectedTrackInRange() },
  { id: "track.retrackFromHere", title: "從此幀重追", group: "track", section: "解算", icon: RefreshCw, shortcuts: ["Shift+T"], enabled: both(needsIdleTrack, needsEngine), run: () => A.runSolve("retrackFwd") },
  { id: "track.clearBackwards", title: "清除之前的解", group: "track", section: "清除", icon: ArrowLeftToLine, enabled: needsIdleTrack, run: () => A.clearSolve("backwards") },
  { id: "track.clearForwards", title: "清除之後的解", group: "track", section: "清除", icon: ArrowRightToLine, enabled: needsIdleTrack, run: () => A.clearSolve("forwards") },
  { id: "track.clearAll", title: "清除全部的解", group: "track", section: "清除", icon: Trash2, enabled: needsIdleTrack, run: () => A.clearSolve("all") },
  {
    id: "track.motionModel",
    title: "動態模型",
    group: "track",
    section: "選項",
    icon: Move,
    enabled: needsTrack,
    children: () =>
      MOTION_MODELS.map<Command>((m) => ({
        id: `track.motionModel.${m}`,
        title: MOTION_MODEL_LABEL[m],
        group: "track",
        checked: () => currentMotionModel() === m,
        enabled: needsTrack,
        run: () => {
          const mediaId = activeId();
          const id = selectedTrackId();
          if (mediaId && id) useEdits.getState().setTrackOptions(mediaId, id, { motionModel: m });
        },
      })),
    run: () => {},
  },
  { id: "track.options", title: "追蹤選項…", group: "track", section: "選項", icon: Settings2, surfaces: ["menu", "palette", "context"], enabled: needsTrack, run: () => openDialog("trackOptions", { trackId: selectedTrackId()! }) },
  { id: "track.insert", title: "插入參數…", group: "track", section: "選項", icon: SlidersHorizontal, surfaces: ["menu", "palette", "context"], keywords: ["insert", "feather", "motion blur", "relight"], enabled: needsTrack, run: () => openDialog("insertOptions", { trackId: selectedTrackId()! }) },

  // ---- 調整追蹤（AdjustTrack）----
  { id: "adjust.mode", title: "調整追蹤模式", group: "adjust", section: "調整追蹤", icon: Target, shortcuts: ["U"], keywords: ["adjust track"], checked: () => !!A.selectedTrack()?.track.adjust.enabled, enabled: needsTrack, run: () => A.toggleAdjustMode() },
  { id: "adjust.addReferencePoint", title: "加參考點（吸附到下一個角）", group: "adjust", section: "參考點", icon: Crosshair, enabled: needsTrack, run: () => A.addReferencePoint() },
  { id: "adjust.nudge", title: "微調 1 px（Shift：0.1 px）", group: "adjust", section: "參考點", icon: Move, shortcuts: ["Alt+ArrowLeft", "Alt+ArrowRight", "Alt+ArrowUp", "Alt+ArrowDown"], shortcutManual: true, surfaces: [], enabled: needsTrack, run: () => {} },
  // Alt+L，不是 Shift+L：Shift+J / Shift+L 是 0.5× 慢速轉盤（hotkeys.ts 手寫派發，ai-music-cut 與剪輯軟體的 JKL 慣例）。
  // 註冊表的 chord 比手寫 switch 先派發，綁在 Shift+L 的話慢速前進永遠叫不到（M1 驗收 L6）；Alt+L 目前與 M2 規劃的鍵都沒有人用
  { id: "adjust.toggleLock", title: "鎖定 / 解除鎖定（Point Lock）", group: "adjust", section: "參考點", icon: Lock, shortcuts: ["Alt+L"], enabled: needsTrack, run: () => A.toggleLock() },
  { id: "adjust.setPrimaryFrame", title: "設為主要參考影格", group: "adjust", section: "參考點", icon: Anchor, enabled: needsTrack, run: () => A.setPrimaryFrame() },
  { id: "adjust.workBackwards", title: "反向修正（從此幀往前重解）", group: "adjust", section: "重解", icon: Undo2, enabled: both(needsIdleTrack, needsEngine), run: () => A.runSolve("workBackwards") },
  { id: "adjust.resolveAround", title: "重解相鄰區間", group: "adjust", section: "重解", icon: RefreshCw, enabled: both(needsIdleTrack, needsEngine), run: () => A.runSolve("resolveAround") },

  // ---- 遮罩（Object Mask）----
  { id: "mask.tool.addSelection", title: "加選（Add Selection）", group: "mask", section: "工具", icon: PlusCircle, shortcuts: ["A"], surfaces: ["menu", "palette", "context"], checked: () => useTimeline.getState().tool === "maskPos", enabled: needsTrack, run: () => useTimeline.getState().setTool("maskPos") },
  { id: "mask.tool.reduceSelection", title: "減選（Reduce Selection）", group: "mask", section: "工具", icon: MinusCircle, shortcuts: ["Shift+X"], surfaces: ["menu", "palette", "context"], checked: () => useTimeline.getState().tool === "maskNeg", enabled: needsTrack, run: () => useTimeline.getState().setTool("maskNeg") },
  { id: "mask.propagateForward", title: "往後傳播遮罩", group: "mask", section: "傳播", icon: ChevronRight, shortcuts: ["M"], enabled: both(needsIdleTrack, needsEngine), run: () => A.propagate("fwd") },
  { id: "mask.propagateBackward", title: "往前傳播遮罩", group: "mask", section: "傳播", icon: ChevronLeft, shortcuts: ["Shift+M"], enabled: both(needsIdleTrack, needsEngine), run: () => A.propagate("bwd") },
  { id: "mask.propagateBoth", title: "雙向傳播遮罩", group: "mask", section: "傳播", icon: ScanSearch, shortcuts: ["Alt+M"], enabled: both(needsIdleTrack, needsEngine), run: () => A.propagate("both") },
  // 範圍版：seg.run --frames 只跑「範圍 ∩ 鏡頭」（SAM 在長鏡頭上很慢，只修一小段時不必整段重算）
  { id: "mask.propagateRange", title: "在範圍內傳播遮罩", group: "mask", section: "傳播", icon: ScanSearch, surfaces: ["menu", "palette", "context"], keywords: ["range", "in out", "propagate range"], enabled: both(needsIdleTrack, needsRange, needsRangeOnTrack, needsEngine), run: () => propagateSelectedTrackInRange() },
  { id: "mask.clearPrompts", title: "清除所有提示點", group: "mask", section: "傳播", icon: Eraser, enabled: needsTrack, run: () => A.clearPromptsAll() },
  // 移除物件：遮罩的另一個用途 —— 把框出來的東西從畫面上拿掉（用其他幀真正拍到的背景補）
  { id: "mask.removeObject", title: "移除物件…", group: "mask", section: "傳播", icon: Wand2, surfaces: ["menu", "palette"], keywords: ["remove", "inpaint", "erase", "移除", "消除"], enabled: both(needsMedia, needsEngine), run: () => openDialog("removeObject") },
  // 背景虛化：跟移除物件是同一份遮罩的兩種用法 —— 一個換掉遮罩裡面，一個換掉外面
  { id: "mask.blurBackground", title: "背景虛化 / 換色…", group: "mask", section: "傳播", icon: Aperture, surfaces: ["menu", "palette"], keywords: ["blur", "background", "portrait", "bokeh", "人像", "去背", "虛化"], enabled: both(needsMedia, needsEngine), run: () => openDialog("blurBackground") },

  // ---- 範圍（in / out）----
  ...RANGE_COMMANDS,
];
