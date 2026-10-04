import { create } from "zustand";

/**
 * FrameTimeline 的縮放 / 捲動 / 工具 / in-out（計畫 §8 store/timeline.ts：幀取代 ms；丟 snap/beats/skim）。
 *
 * `xOfFrame = (f - scrollFrame) * pxPerFrame`；pxPerFrame = null 代表「整段適配」，由 FrameTimeline 依容器寬度算 fitPxPerFrame。
 */

export const MAX_PX_PER_FRAME = 64;
/** 選取範圍至少 1 幀。 */
export const MIN_RANGE_FRAMES = 1;

/**
 * select 選 track / 關鍵幀；corner 拖表面（Surface）角；region 編輯追蹤區域（Tracking Region，第二個多邊形）；
 * maskPos / maskNeg 加選減選；shotCut 點一下切鏡頭。
 */
/** objSelect = 選取物件（點 = 加選、Alt＋點 = 減選、拖 = 框；objects/selection.ts）。 */
export type TimelineTool = "select" | "corner" | "region" | "maskPos" | "maskNeg" | "shotCut" | "objSelect";

export interface FrameRange {
  in: number;
  /** 不含。 */
  out: number;
}

/**
 * 時間軸的座標空間（docs/editor-m2-design.md §9.1，Premiere 的 Program / Source monitor）：
 * - `sequence`：座標 = 序列幀 t（V1 片段、A0 原音、A1…An 音軌）；
 * - `source`：座標 = 作用中媒體的 proxy 幀 k（M1 的時間軸原樣）。
 * 只有實驗旗標 `settings.experimental.sequence` 開著時才有差別（effectiveSpace）；旗標關著一律是 source。
 */
export type TimelineSpace = "sequence" | "source";

/** 旗標關著時永遠是素材空間：M2.17 之前使用者不會看到半成品的序列時間軸。 */
export function effectiveSpace(space: TimelineSpace, sequenceEnabled: boolean): TimelineSpace {
  return sequenceEnabled ? space : "source";
}

/**
 * 時間軸焦點＝「最後一次點到的東西」（docs/editor-m2-design.md §10.1）：Delete / Shift+Delete 依它派發。
 * 為什麼不直接看「有沒有選取」：片段、範圍、關鍵幀可以同時存在（選了片段又標了 I/O），
 * 只看選取的話 Delete 要猜使用者指哪一個；Premiere / Resolve 都是「最後操作的那個」勝出。
 * - clip：點片段（V1、空白、原音、音訊片段）；range：拖範圍或按 I / O；envPoint：Alt+點音量線；
 * - keyframe：點菱形；track：點車道；null：Esc 清掉，或焦點指的東西消失了。
 */
export type TimelineFocus = "clip" | "range" | "envPoint" | "keyframe" | "track" | null;

/**
 * 序列時間軸的工具（§9.5 刀片 Shift+B）。刻意跟 `tool`（舞台的表面 / 追蹤區域 / 遮罩工具）分開：
 * 共用一個欄位的話按 Shift+B 拿刀片，舞台上的追蹤區域就變成不能拖（VideoStage 只在 tool === "select" 時可編輯）。
 */
export type SequenceTool = "select" | "blade";

/**
 * 點片段時的選取規則（§9.5）：純函式，FrameTimeline 與右鍵共用。
 * - 一般點：只選它；Ctrl+點：加入 / 移出；Shift+點：從「同一列最後選的那個」延伸到這裡（ai-music-cut 的 Shift 延伸），
 *   `rowOrder` 是那一列的片段 id 依位置排序（沒給或錨點不在同列時退回一般點）。
 */
export function clickClipSelection(current: readonly string[], id: string, mods: { toggle?: boolean; extend?: boolean } = {}, rowOrder?: readonly string[]): string[] {
  if (mods.toggle) return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
  if (mods.extend && rowOrder) {
    const anchor = [...current].reverse().find((x) => rowOrder.includes(x));
    const a = anchor ? rowOrder.indexOf(anchor) : -1;
    const b = rowOrder.indexOf(id);
    if (a >= 0 && b >= 0) {
      const span = rowOrder.slice(Math.min(a, b), Math.max(a, b) + 1);
      // 其他列已選的保留（V1 選好之後 Shift 延伸音軌，不會把 V1 的選取洗掉）
      return [...current.filter((x) => !span.includes(x)), ...span];
    }
  }
  return [id];
}

interface TimelineStore {
  pxPerFrame: number | null;
  fitPxPerFrame: number;
  /** 時間軸可視區寬度（px）。 */
  viewWidth: number;
  /** 可視區左緣的幀號。 */
  scrollFrame: number;
  tool: TimelineTool;
  /** in/out 範圍（輸出範圍、循環播放）。 */
  range: FrameRange | null;
  /**
   * I / O 只標了一端時暫存在這裡（timeline.ts:101-102 的技巧）：不能先做一個 1 幀的範圍當佔位 ——
   * setRange 有最短長度，那種佔位會當場被丟掉，使用者按了 I 再按 O 什麼都不會發生。
   */
  pendingIn: number | null;
  pendingOut: number | null;
  loopRange: boolean;
  /** 一次性捲動請求（FrameTimeline 消費）。 */
  scrollReq: { frame: number; nonce: number } | null;
  /** 選中的 track（車道點選）；null = 沒選。 */
  selectedTrackId: string | null;
  /** 選中的關鍵幀（菱形點選）：Delete 刪它。 */
  selectedKeyframe: { trackId: string; frame: number } | null;
  /** 時間軸座標空間（序列 / 素材）；實際生效的空間看 effectiveSpace（實驗旗標）。 */
  space: TimelineSpace;
  /**
   * 切換空間（Alt+1 / Alt+2、分段控制）。兩個空間的總長不同（序列 T vs 媒體 proxy 幀數），
   * 留著舊的縮放 / 捲動會落在另一個空間的無意義位置，所以切換時回到整段適配；in / out 也一樣（素材的 k 範圍當成序列幀
   * 會默默選到另一段畫面，「只輸出範圍」就輸出錯的東西），跟 Workspace 換媒體時清範圍同一個理由。同一個空間再按一次什麼都不做。
   */
  setSpace: (space: TimelineSpace) => void;
  /** Delete / Shift+Delete 的派發依據（§10.1）；由 selectClips / setRange / selectKeyframe / selectTrack 順手設定。 */
  focus: TimelineFocus;
  /** 選取的序列片段 id（V1 片段、空白、音訊片段）；不存檔、不進 undo（選取是操作狀態）。 */
  selectedClipIds: readonly string[];
  /** 序列時間軸的工具（選取 / 刀片）。 */
  seqTool: SequenceTool;
  setFocus: (focus: TimelineFocus) => void;
  /** 換掉片段選取；非空 → 焦點變 clip，清空 → 焦點若是 clip 就清掉。 */
  selectClips: (ids: readonly string[]) => void;
  setSeqTool: (tool: SequenceTool) => void;
  setFit: (px: number, viewWidth?: number) => void;
  setPxPerFrame: (px: number | null) => void;
  zoomBy: (factor: number, anchorFrame?: number) => void;
  fit: () => void;
  setScrollFrame: (f: number) => void;
  scrollTo: (frame: number) => void;
  setTool: (t: TimelineTool) => void;
  setRange: (r: FrameRange | null) => void;
  markIn: (frame: number) => boolean;
  markOut: (frame: number) => boolean;
  /** Alt+I：只清入點。有完整範圍時出點留成 pendingOut（Resolve / Premiere 的 Clear In 不會連出點一起丟）。 */
  clearIn: () => void;
  /** Alt+O：只清出點；入點留成 pendingIn。 */
  clearOut: () => void;
  /** 整段設為範圍 [0, frames)。 */
  rangeAll: (frames: number) => void;
  /**
   * 縮放到範圍（Z）：範圍佔可視寬度 90%、左右各留 5%。沒給 r 就用目前的範圍；
   * 算出來比整段適配還寬（範圍幾乎等於整段）就回到適配。totalFrames 用來把捲動夾在尾端之內。
   */
  zoomToRange: (r?: FrameRange | null, totalFrames?: number) => boolean;
  toggleLoop: () => void;
  selectTrack: (id: string | null) => void;
  selectKeyframe: (sel: { trackId: string; frame: number } | null) => void;
}

/** 夾在 [fit, MAX]；fit 以下沒有意義（時間軸比容器窄）。 */
export function clampZoom(px: number, fit: number): number {
  const lo = Math.max(0.001, fit);
  return Math.max(lo, Math.min(MAX_PX_PER_FRAME, px));
}

/** 從目前值乘上倍率；落回 fit（含誤差）就回 null 代表整段適配。 */
export function nextZoom(cur: number | null, fit: number, factor: number): number | null {
  const next = clampZoom((cur ?? fit) * factor, fit);
  return next <= fit * 1.001 ? null : next;
}

const TOOLS: readonly TimelineTool[] = ["select", "corner", "region", "maskPos", "maskNeg", "shotCut", "objSelect"];

function readTool(): TimelineTool {
  try {
    const v = localStorage.getItem("aivc:tool");
    return TOOLS.includes(v as TimelineTool) ? (v as TimelineTool) : "select";
  } catch {
    return "select";
  }
}

const SPACE_KEY = "aivc:timelineSpace";

/** 上次用的空間（本機習慣，不進專案檔）；沒有 / 壞值 = 序列（Premiere 開專案預設看 Program）。 */
export function parseTimelineSpace(v: string | null): TimelineSpace {
  return v === "source" ? "source" : "sequence";
}

function readSpace(): TimelineSpace {
  try {
    return parseTimelineSpace(localStorage.getItem(SPACE_KEY));
  } catch {
    return "sequence";
  }
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeBool(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export const useTimeline = create<TimelineStore>((set, get) => ({
  pxPerFrame: null,
  fitPxPerFrame: 1,
  viewWidth: 800,
  scrollFrame: 0,
  tool: readTool(),
  range: null,
  pendingIn: null,
  pendingOut: null,
  loopRange: readBool("aivc:loopRange", false),
  scrollReq: null,
  selectedTrackId: null,
  selectedKeyframe: null,
  space: readSpace(),
  setSpace: (space) => {
    if (get().space === space) return;
    try {
      localStorage.setItem(SPACE_KEY, space);
    } catch {
      /* ignore */
    }
    // 範圍跟著清掉了，焦點若還指著範圍，下一次 Delete 會對一個不存在的範圍派發（變成灰掉的提示，而不是使用者以為的動作）
    set((s) => ({ space, pxPerFrame: null, scrollFrame: 0, range: null, pendingIn: null, pendingOut: null, focus: s.focus === "range" ? null : s.focus }));
  },
  focus: null,
  selectedClipIds: [],
  seqTool: "select",
  setFocus: (focus) => set((s) => (s.focus === focus ? s : { focus })),
  selectClips: (ids) =>
    set((s) => {
      const same = ids.length === s.selectedClipIds.length && ids.every((x, i) => x === s.selectedClipIds[i]);
      const focus: TimelineFocus = ids.length ? "clip" : s.focus === "clip" ? null : s.focus;
      if (same && focus === s.focus) return s;
      return { selectedClipIds: same ? s.selectedClipIds : [...ids], focus };
    }),
  setSeqTool: (seqTool) => set((s) => (s.seqTool === seqTool ? s : { seqTool })),
  setFit: (px, viewWidth) => set((s) => ({ fitPxPerFrame: Math.max(0.001, px), viewWidth: viewWidth ?? s.viewWidth })),
  setPxPerFrame: (px) => set({ pxPerFrame: px == null ? null : clampZoom(px, get().fitPxPerFrame) }),
  zoomBy: (factor, anchorFrame) =>
    set((s) => {
      const before = s.pxPerFrame ?? s.fitPxPerFrame;
      const px = nextZoom(s.pxPerFrame, s.fitPxPerFrame, factor);
      if (px === null) return { pxPerFrame: null, scrollFrame: 0 };
      // 以錨點幀為中心縮放：錨點在螢幕上的 x 不動
      if (anchorFrame == null) return { pxPerFrame: px };
      const x = (anchorFrame - s.scrollFrame) * before;
      return { pxPerFrame: px, scrollFrame: Math.max(0, anchorFrame - x / px) };
    }),
  fit: () => set({ pxPerFrame: null, scrollFrame: 0 }),
  setScrollFrame: (f) => set((s) => (Math.abs(s.scrollFrame - f) < 1e-6 ? s : { scrollFrame: Math.max(0, f) })),
  scrollTo: (frame) => set((s) => ({ scrollReq: { frame: Math.max(0, frame), nonce: (s.scrollReq?.nonce ?? 0) + 1 } })),
  setTool: (tool) => {
    try {
      localStorage.setItem("aivc:tool", tool);
    } catch {
      /* ignore */
    }
    set({ tool });
  },
  setRange: (r) => {
    if (!r) {
      set((s) => ({ range: null, pendingIn: null, pendingOut: null, focus: s.focus === "range" ? null : s.focus }));
      return;
    }
    const a = Math.round(Math.min(r.in, r.out));
    const b = Math.round(Math.max(r.in, r.out));
    const range = b - a < MIN_RANGE_FRAMES ? null : { in: Math.max(0, a), out: b };
    // 設了完整範圍，單邊暫存就過時了：留著的話 I/O 下一次會拿舊的 pending 當另一端，範圍會跳回去。
    // 焦點：設了範圍 = 使用者剛操作範圍（拖範圍、I/O、X），Delete 應該提取它（§10.1）
    set((s) => ({ range, pendingIn: null, pendingOut: null, focus: range ? "range" : s.focus === "range" ? null : s.focus }));
  },
  markIn: (frame) => {
    const s = get();
    const end = s.range && s.range.out > frame + MIN_RANGE_FRAMES - 1 ? s.range.out : s.pendingOut;
    if (end != null && end >= frame + MIN_RANGE_FRAMES) {
      set({ pendingIn: null, pendingOut: null });
      s.setRange({ in: frame, out: end });
      return true;
    }
    // 只標了一端也算「最後操作的是範圍」（§10.1 按 I／O → range）：這時按 Delete 會灰掉並提示「先用 I / O 標一段範圍」，而不是去刪片段
    set({ pendingIn: frame, pendingOut: null, range: null, focus: "range" });
    return false;
  },
  markOut: (frame) => {
    const s = get();
    const start = s.range && s.range.in <= frame - MIN_RANGE_FRAMES ? s.range.in : s.pendingIn;
    if (start != null && start <= frame - MIN_RANGE_FRAMES) {
      set({ pendingIn: null, pendingOut: null });
      s.setRange({ in: start, out: frame });
      return true;
    }
    set({ pendingOut: frame, pendingIn: null, range: null, focus: "range" });
    return false;
  },
  clearIn: () =>
    set((s) => {
      if (s.range) return { range: null, pendingIn: null, pendingOut: s.range.out };
      return s.pendingIn == null ? s : { pendingIn: null };
    }),
  clearOut: () =>
    set((s) => {
      if (s.range) return { range: null, pendingIn: s.range.in, pendingOut: null };
      return s.pendingOut == null ? s : { pendingOut: null };
    }),
  rangeAll: (frames) => get().setRange(frames >= MIN_RANGE_FRAMES ? { in: 0, out: Math.round(frames) } : null),
  zoomToRange: (r, totalFrames) => {
    const s = get();
    const range = r ?? s.range;
    if (!range) return false;
    const len = Math.max(MIN_RANGE_FRAMES, range.out - range.in);
    const w = Math.max(1, s.viewWidth);
    const px = clampZoom((w * 0.9) / len, s.fitPxPerFrame);
    if (px <= s.fitPxPerFrame * 1.001) {
      set({ pxPerFrame: null, scrollFrame: 0 });
      return true;
    }
    // 直接設 scrollFrame 而不是 scrollReq：scrollReq 的消費端會把幀置中，範圍要的是「左緣留 5%」
    const viewFrames = w / px;
    const maxScroll = totalFrames != null ? Math.max(0, totalFrames - viewFrames) : Number.POSITIVE_INFINITY;
    const scroll = Math.max(0, Math.min(maxScroll, range.in + len / 2 - viewFrames / 2));
    set({ pxPerFrame: px, scrollFrame: scroll });
    return true;
  },
  toggleLoop: () =>
    set((s) => {
      writeBool("aivc:loopRange", !s.loopRange);
      return { loopRange: !s.loopRange };
    }),
  // 焦點：選了車道 = track；取消選取（換媒體時 Workspace 會呼叫 null）時，指著追蹤 / 關鍵幀的焦點一起清掉
  selectTrack: (id) =>
    set((s) => {
      const focus: TimelineFocus = id ? "track" : s.focus === "track" || s.focus === "keyframe" ? null : s.focus;
      if (s.selectedTrackId === id && s.focus === focus) return s;
      return s.selectedTrackId === id ? { focus } : { selectedTrackId: id, selectedKeyframe: null, focus };
    }),
  selectKeyframe: (sel) =>
    set((s) =>
      sel
        ? { selectedKeyframe: sel, selectedTrackId: sel.trackId, focus: "keyframe" }
        : // 取消選菱形（刪掉之後）：車道還選著就退回 track，Shift+Delete 仍然是刪追蹤
          { selectedKeyframe: null, focus: s.focus === "keyframe" ? (s.selectedTrackId ? "track" : null) : s.focus },
    ),
}));

/** 幀 → 可視區 x（px）。 */
export function xOfFrame(frame: number, scrollFrame: number, pxPerFrame: number): number {
  return (frame - scrollFrame) * pxPerFrame;
}

/** 可視區 x → 幀（小數；呼叫端自己 floor / round）。 */
export function frameOfX(x: number, scrollFrame: number, pxPerFrame: number): number {
  return scrollFrame + x / pxPerFrame;
}

// ---- 範圍的純函式（傳輸列 / 右鍵選單 / 範圍版指令共用，不必各自重算 pending 的規則）----

/**
 * 目前的入 / 出點：完整範圍優先，否則是 I / O 的單邊暫存。out 是**不含**的邊界。
 * 「跳到出點」要跳 out−1（最後一個在範圍內的幀），這個換算留給呼叫端，因為暫存的 pendingOut 也是不含的邊界。
 */
export function rangeEnds(s: { range: FrameRange | null; pendingIn: number | null; pendingOut: number | null }): { in: number | null; out: number | null } {
  if (s.range) return { in: s.range.in, out: s.range.out };
  return { in: s.pendingIn, out: s.pendingOut };
}

export function rangeLength(r: FrameRange | null | undefined): number {
  return r ? Math.max(0, r.out - r.in) : 0;
}

/** f 在 [in, out) 內。 */
export function frameInRange(r: FrameRange | null | undefined, f: number): boolean {
  return !!r && f >= r.in && f < r.out;
}

/** 範圍 ∩ [a, b)；沒有交集（或交集短於最短範圍）回 null。範圍版的追蹤 / 遮罩指令只作用在「範圍 ∩ track 的鏡頭」。 */
export function intersectRange(r: FrameRange | null | undefined, a: number, b: number): FrameRange | null {
  if (!r) return null;
  const lo = Math.max(r.in, a);
  const hi = Math.min(r.out, b);
  return hi - lo >= MIN_RANGE_FRAMES ? { in: lo, out: hi } : null;
}
