import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Rational } from "../api";
// 序列空間的片段右鍵 / 刀片分割（M2.12 的指令層；VideoStage 也是直接叫 menuModel 的 openStageContextMenu）
import { openSequenceContextMenu } from "../commands/menuModel";
import { splitAtFrame, splitClipAt } from "../commands/sequenceCommands";
import { useT } from "../i18n";
import { makeSeqCtx, type SeqCtx } from "../sequence/context";
import { durationFrames, placeVideo } from "../sequence/map";
import { useEdits, useProject } from "../stage/_contracts";
import { activeShotsNow, shotOf, useActiveMedia, useActiveTracks } from "../stage/active";
import { palette, setupCanvas } from "../stage/paint";
import { moveItemTo } from "../sequence/ops";
import { SEQ_EDIT_LABEL } from "../store/edits";
import { usePlayback } from "../store/playback";
import { useSettings } from "../store/settings";
import { solveAt, useSolves } from "../store/solves";
import { clickClipSelection, frameOfX, rangeLength, useTimeline, xOfFrame, type FrameRange, type TimelineSpace } from "../store/timeline";
import { timecode } from "../time";
import { toast } from "../ui";
import { SHOT_KIND_LABEL, TRACK_STATE_LABEL } from "../video/labels";
import { contextRequestOf, timelineContextMenuHandler, type TimelineContextMenuHandler } from "./contextMenu";
import { drawFrameTimeline, layoutRows, ROW, thumbSampleFrames, type TrackLane } from "./draw";
import { drawSequenceTimeline, drawUsedInSequence, formatGainDb, sequencePalette, type SeqDrawLabels } from "./drawSequence";
import { edgeAtX, frameAtX, hitTimeline, type HitView, type TimelineHit } from "./hit";
import { hitSequence, hoverClipIdOf, toTimelineHit, type SeqHit } from "./hitSequence";
import { beginReorderDrag, reorderTipText, updateReorderDrag, type ReorderDrag, type ReorderPreview } from "./reorderDrag";
import type { RangePart } from "./rangeBand";
import {
  beginRangeDrag,
  cancelRangeDrag,
  collectSnapTargets,
  DRAG_THRESHOLD_PX,
  shiftClickRange,
  updateRangeDrag,
  type RangeDrag,
  type RangeDragMode,
  type SnapTarget,
} from "./rangeDrag";
import TrackHeaders, { useSequenceView } from "./TrackHeaders";
import {
  beginTrimDrag,
  collectTrimSnapTargets,
  commitTrimDrag,
  nearestTrimSnap,
  rangeSnapTargetsOf,
  trimHoverText,
  trimSnapLabel,
  trimTipInfo,
  trimTipText,
  updateTrimDrag,
  useSnap,
  type TrimDrag,
  type TrimResult,
  type TrimSnapTarget,
  type TrimTarget,
} from "./trimDrag";
// M2.15 音訊片段的增益手勢（淡化把手、音量線、自動化點）：規則在 gainDrag.ts，這裡只接指標事件與畫預覽
import { openClipInspector } from "../commands/audioClipCommands";
import { beginGainDrag, commitGainDrag, envPointXY, gainCursorOf, gainPressOf, gainRowOf, updateGainDrag, useEnvPointSelection, type GainDrag, type GainResult, type GainTip } from "./gainDrag";
import { sampleOfX } from "./layoutSequence";
import { buildSeqDrawState, ensureSequenceThumbs, seekSequence, seqHitTracksNow, sequencePlayheadNow, subscribePeaks, useSequenceTimeline, type SequenceTimeline } from "./useSequenceTimeline";
import { useThumbStrip } from "./useThumbStrip";
import { useObjectMeta } from "../objects/meta";

/**
 * 幀時間軸（計畫 §9 FrameTimeline）：DPR canvas，`xOfFrame = (f - scrollFrame) * pxPerFrame`。
 * wheel 捲動、Ctrl+wheel 以游標為錨縮放、尺規拖曳 scrub、車道點選 track、菱形點選 + seek；
 * follow 模式 page / center / off（拖曳中壓制，沿 PlayheadOverlay 的做法）。
 *
 * 範圍（in / out）：尺規下的範圍列拖出 / 拖握把 / 拖本體平移；任何列 Shift+拖曳新建；Shift+點延伸較近的一端；
 * 雙擊本體縮放到範圍、雙擊範圍列空白整段、雙擊鏡頭帶設為該鏡頭。拖曳規則在 rangeDrag.ts（純函式、有測試）。
 *
 * 跟 VideoStage 一樣不透過 React state 重畫：store subscribe → schedule()，draw() 裡 getState()。
 * 播放中 playback.frame 由 rVFC 每幀回寫，訂閱它就等於每呈現一幀重畫一次播放線。
 *
 * 兩個空間（docs/editor-m2-design.md §9.1，實驗旗標 settings.experimental.sequence 開著才有序列空間）：
 * - 素材空間：上面說的 M1 時間軸原樣，座標是作用中媒體的 proxy 幀 k；
 * - 序列空間：座標是序列幀 t，列換成 V1 片段 / A0 原音 / 追蹤分段 / A1…An（drawSequence.ts、hitSequence.ts），左邊多 DOM 軌道標頭。
 * 兩個空間共用縮放 / 捲動 / 範圍的 store 與同一套範圍手勢；「總幀數」「seek」「命中」三件事依空間分流（framesNow / seekNow / hitAt）。
 */
const THUMB_W = Math.round((ROW.thumbs * 16) / 9);
const EMPTY_FPS = { num: 30, den: 1 };

interface Tip {
  x: number;
  y: number;
  text: string;
}

interface RangeGesture {
  drag: RangeDrag;
  startX: number;
  moved: boolean;
  /** 按下時有按 Shift：沒拖動就當成 Shift+點（延伸選取）。 */
  shift: boolean;
  /** 從範圍列開始的（沒拖動 = 點範圍列 → seek，跟尺規一樣）。 */
  band: boolean;
  /** 拖曳開始時算好的吸附目標：拖曳中每個 pointermove 重算沒必要，播放線拖曳中也不會動。 */
  targets: SnapTarget[];
  /** 序列空間 Shift+按在片段上：沒拖動 = Shift+點片段 → 同列延伸選取（§9.5），拖了才是新建範圍。 */
  clipRow?: ClipRow | null;
}

/** 片段類命中（V1 片段 / 原音 / 空白 / 音訊片段）的 id 與「同一列」依位置排好的 id：點選與 Shift 延伸選取用。 */
interface ClipRow {
  id: string;
  rowOrder: string[];
}

/**
 * 命中的是可以點選的片段嗎？V1 片段與 A0 原音是同一個 V1 項目（同一列順序），空白也可以選（波紋刪除空白）；
 * 音訊片段的淡化把手 / 音量線 / 自動化點是 M2.15 的手勢，在那之前一律當本體點選。
 */
function clipRowOf(hit: SeqHit | null | undefined, s: Pick<SequenceTimeline, "seq" | "placed">): ClipRow | null {
  if (!hit || !s.seq) return null;
  const v1 = () => s.placed.map((p) => p.item.id);
  if (hit.kind === "clip" || hit.kind === "original") return { id: hit.clipId, rowOrder: v1() };
  if (hit.kind === "gap") return { id: hit.gapId, rowOrder: v1() };
  if (hit.kind === "audioClip") {
    const lane = s.seq.audioLanes.find((l) => l.id === hit.laneId);
    return { id: hit.clipId, rowOrder: lane ? [...lane.clips].sort((a, b) => a.start - b.start).map((c) => c.id) : [hit.clipId] };
  }
  return null;
}

/** 刀片（Shift+B）在這個命中上能做什麼：切點到的片段（V1 / 原音 / 音訊片段）、Shift = 所有軌；尺規、範圍列、追蹤車道不歸刀片管（照常 scrub / 選 track）。 */
function bladeActionOf(hit: SeqHit | null | undefined, shift: boolean): { all: true } | { all: false; clipId: string | null } | null {
  if (!hit) return null;
  switch (hit.kind) {
    case "clip":
    case "original":
    case "audioClip":
      return shift ? { all: true } : { all: false, clipId: hit.clipId };
    case "gap":
    case "audioLane":
      // 空白 / 空音軌上沒有東西可切；Shift 仍然是「這個時間點切所有軌」
      return shift ? { all: true } : { all: false, clipId: null };
    default:
      return null;
  }
}

interface PointerHit {
  x: number;
  y: number;
  /** M1 形狀（序列空間是 toTimelineHit 轉過的）：範圍手勢、游標、右鍵選單共用。 */
  hit: TimelineHit;
  /** 序列空間的原始命中；素材空間是 null。 */
  seq: SeqHit | null;
}

/**
 * 序列空間拖片段邊緣（M2.13，規則在 trimDrag.ts）。預覽只放在這個 ref 裡、放開才 commit 一筆 undo：
 * 拖曳中每個 pointermove 都寫 store 會洗出幾百筆歷史，Esc 也得靠 undo 才還原得回來。
 */
interface TrimGesture {
  drag: TrimDrag;
  startX: number;
  moved: boolean;
  /** 按下的片段：沒拖動就當成點一下片段（跟點本體一樣選取，播放線不動，§9.5）。 */
  pressRow: ClipRow | null;
  /** 按下時有 Ctrl / ⌘：點一下 = 加入 / 移出選取。 */
  toggle: boolean;
  /** 拖曳開始時算好的吸附目標（同 RangeGesture.targets 的理由）。 */
  targets: TrimSnapTarget[];
  /** 夾住延長量要的媒體幀數 / 音訊來源長度；拖曳中媒體清單不會變，開始時包一次。 */
  ctx: SeqCtx;
  result: TrimResult | null;
  /** 畫面用的預覽（序列換成修剪後的那份）；沒有變化時 null，直接畫 store 的序列。 */
  preview: SequenceTimeline | null;
}

/** 音訊片段的增益拖曳（M2.15，規則在 gainDrag.ts）：同 TrimGesture，預覽只在 ref 裡、放開才 commit 一筆。 */
interface GainGesture {
  drag: GainDrag;
  startX: number;
  startY: number;
  moved: boolean;
  result: GainResult | null;
  preview: SequenceTimeline | null;
}

function partMode(part: "in" | "out" | "body" | "empty"): RangeDragMode {
  return part === "body" ? "move" : part === "empty" ? "create" : part;
}

/** 命中的是不是可以修剪的邊緣：V1 列與 A0 原音列的邊緣都是 V1 項目的邊緣；音訊片段是它自己的。 */
function trimTargetOf(hit: SeqHit | null | undefined): TrimTarget | null {
  if (!hit) return null;
  if ((hit.kind === "clip" || hit.kind === "original") && (hit.part === "edgeIn" || hit.part === "edgeOut")) return { kind: "v1", id: hit.clipId, edge: hit.part === "edgeIn" ? "in" : "out" };
  if (hit.kind === "audioClip" && (hit.part === "edgeIn" || hit.part === "edgeOut")) return { kind: "audio", id: hit.clipId, laneId: hit.laneId, edge: hit.part === "edgeIn" ? "in" : "out" };
  return null;
}

function cursorFor(hit: TimelineHit, shift: boolean): string {
  if (hit.kind === "range") return hit.part === "in" || hit.part === "out" ? "ew-resize" : hit.part === "body" ? "grab" : "crosshair";
  return shift ? "crosshair" : "default";
}

/** 沒在拖東西時的游標：軌道群組標頭 = pointer；片段邊緣 = 修剪（鎖定的軌 = not-allowed）；Shift 或 scrub 中邊緣不算（那時按下去是範圍 / 還在 scrub）。 */
function hoverCursorOf(h: PointerHit, shift: boolean, scrubbing: boolean, locked: (t: TrimTarget) => boolean): string {
  if (h.seq?.kind === "tracksHeader") return "pointer";
  const edge = shift || scrubbing ? null : trimTargetOf(h.seq);
  if (edge) return locked(edge) ? "not-allowed" : "ew-resize";
  return cursorFor(h.hit, shift);
}

function secondsOf(frames: number, fps: Rational): string {
  return fps.num > 0 ? ((frames * fps.den) / fps.num).toFixed(2) : "0.00";
}

/** 命中的「目前空間幀」：序列空間的車道 / 菱形命中轉成 M1 形狀時 frame 會換成來源 k，hover 線與 scrub 要用序列幀。 */
function frameOfHit(h: PointerHit): number {
  return h.seq ? h.seq.frame : h.hit.frame;
}

/** 時間軸上方的空間切換「序列｜素材：檔名」（§9.1）；只有實驗旗標開著才出現。 */
function SpaceSwitch({ space, sourceName, edited, disabledSequence, onChange }: { space: TimelineSpace; sourceName: string; edited: boolean; disabledSequence: boolean; onChange: (s: TimelineSpace) => void }) {
  const t = useT();
  const opts: { value: TimelineSpace; label: string; title: string; disabled?: boolean }[] = [
    { value: "sequence", label: t("序列"), title: disabledSequence ? t("proxy 還沒好：序列要等 proxy 建好才看得到") : t("序列空間：剪輯後的成品時間"), disabled: disabledSequence },
    { value: "source", label: t("素材：{name}", { name: sourceName }), title: t("素材空間：目前媒體的原始時間（追蹤、遮罩在這裡做）") },
  ];
  return (
    <div className="sticky top-0 left-0 z-20 h-6 flex items-center gap-2 px-1.5 bg-panel border-b border-fg/10" data-testid="timeline-space">
      <div role="radiogroup" aria-label={t("時間軸空間")} className="inline-flex items-center gap-0.5 p-px rounded bg-inset border border-fg/10">
        {opts.map((o) => {
          const on = o.value === space;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={o.disabled}
              title={o.title}
              onClick={() => onChange(o.value)}
              className={
                "h-[18px] px-2 rounded-sm text-[11px] whitespace-nowrap max-w-[260px] truncate transition-colors disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-accent/60 " +
                (on ? "bg-accent text-on-accent" : "text-fg/60 hover:text-fg hover:bg-fg/10")
              }
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {edited && (
        <span className="inline-flex items-center gap-1 text-[11px] text-fg/55" title={t("序列已剪輯：輸出時音訊會重新混音")}>
          <span className="w-1.5 h-1.5 rounded-full bg-clip-selected" />
          {t("已剪輯")}
        </span>
      )}
    </div>
  );
}

export default function FrameTimeline({ onContextMenuAt }: { onContextMenuAt?: TimelineContextMenuHandler } = {}) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const media = useActiveMedia();
  const proxy = media?.proxy ?? null;
  const tracks = useActiveTracks();
  const layout = useMemo(() => layoutRows(tracks.map((x) => x.id), { thumbs: true }), [tracks]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const sq = useSequenceTimeline();
  const sqRef = useRef<SequenceTimeline>(sq);
  sqRef.current = sq;
  const seqLayout = sq.active ? sq.layout : null;
  const height = seqLayout?.height ?? layout.height;

  const rafRef = useRef(0);
  const drawRef = useRef<() => void>(() => {});
  const hoverRef = useRef<PointerHit | null>(null);
  const scrubRef = useRef(false);
  const rangeRef = useRef<RangeGesture | null>(null);
  const trimRef = useRef<TrimGesture | null>(null);
  const gainRef = useRef<GainGesture | null>(null);
  /** 按在片段本體上（已選取、播放線沒動）：拖過門檻才開始 scrub，保留「在時間軸上拖著找畫面」的手感。 */
  const pressRef = useRef<{ startClientX: number } | null>(null);
  // Ctrl+拖片段本體 = 重新排序（設計文件 §13 M2.later 指定的手勢）。平拖維持 scrub，兩者並存。
  // 拖曳中不碰 store：預覽只有一條畫在插入點的虛線（借 snapFrame 的機制），放開才 commit 一筆 undo。
  const reorderRef = useRef<{ drag: ReorderDrag; preview: ReorderPreview } | null>(null);
  /** 刀片工具 hover 的分割位置（序列幀，已吸附）：畫成吸附線當預覽。 */
  const bladeRef = useRef<number | null>(null);
  const snapRef = useRef<SnapTarget | null>(null);
  const lastFrameRef = useRef(-1);
  const [tip, setTip] = useState<Tip | null>(null);
  const [cursor, setCursorState] = useState("default");
  const setCursor = useCallback((c: string) => setCursorState((prev) => (prev === c ? prev : c)), []);

  const schedule = useCallback(() => {
    if (!rafRef.current) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        drawRef.current();
      });
    }
  }, []);
  const thumbs = useThumbStrip(proxy, ROW.thumbs, schedule);

  /** 目前空間的總幀數：序列空間 = 序列長度 T、素材空間 = proxy 幀數。 */
  const framesNow = useCallback(() => (sqRef.current.active ? sqRef.current.frames : proxy?.frames ?? 0), [proxy]);
  /** 目前空間的 fps（尺規、範圍 tooltip）。 */
  const fpsNow = useCallback((): Rational => (sqRef.current.active && sqRef.current.seq ? sqRef.current.seq.fps : proxy?.fps ?? EMPTY_FPS), [proxy]);
  /** 目前空間的 seek：序列空間走序列對應表（M2.11 之前只能在作用中媒體的片段上移動）。 */
  const seekNow = useCallback((frame: number) => {
    if (sqRef.current.active) seekSequence(sqRef.current, frame);
    else usePlayback.getState().seek(frame);
  }, []);
  /** 目前空間的播放線位置（序列空間可能是 null：這一幀沒用在序列裡）。 */
  const playheadNow = useCallback((): number | null => (sqRef.current.active ? sequencePlayheadNow(sqRef.current) : usePlayback.getState().frame), []);

  /** 目前捲動 / 縮放下的命中視圖（整段適配時 scroll 永遠是 0）。 */
  const viewNow = useCallback((): HitView => {
    const tl = useTimeline.getState();
    return { scrollFrame: tl.pxPerFrame === null ? 0 : tl.scrollFrame, pxPerFrame: tl.pxPerFrame ?? tl.fitPxPerFrame, frames: framesNow() };
  }, [framesNow]);

  /** 「入 00:00:28:00 · 出 00:00:30:10 · 70 幀（2.33 秒）」＋吸附到什麼。 */
  const rangeTipText = useCallback(
    (r: FrameRange, snap: SnapTarget | null) => {
      const fps = fpsNow();
      const len = rangeLength(r);
      const base = t("入 {in} · 出 {out} · {n} 幀（{s} 秒）", { in: timecode(r.in, fps), out: timecode(r.out, fps), n: len, s: secondsOf(len, fps) });
      if (!snap) return base;
      // 序列空間沒有鏡頭帶：那裡的 "shot" 目標是剪輯點（trimDrag.rangeSnapTargetsOf 換過來的）
      const shot = sqRef.current.active ? trimSnapLabel(t, "edit") : t("吸附：鏡頭切點");
      const what = snap.kind === "playhead" ? t("吸附：播放線") : snap.kind === "shot" ? shot : snap.kind === "keyframe" ? t("吸附：關鍵幀") : t("吸附：頭尾");
      return `${base} · ${what}`;
    },
    [t, fpsNow],
  );

  const seqLabels = useMemo<SeqDrawLabels>(
    () => ({
      gap: t("空白"),
      disabled: t("已停用"),
      offline: t("媒體離線"),
      muted: t("原音靜音"),
      dropHint: t("把音訊檔拖到這裡新增音軌"),
      badge: (n) => t("替換 {n}", { n }),
      detached: (lane) => (lane ? t("已分離 → {lane}", { lane }) : t("已分離")),
      gainDb: formatGainDb,
    }),
    [t],
  );

  // ---- draw ----
  const draw = useCallback(() => {
    const cv = canvasRef.current;
    const box = boxRef.current;
    if (!cv || !box) return;
    const w = box.clientWidth;
    if (w <= 0) return;
    const sqNow = sqRef.current;
    const SL = sqNow.active ? sqNow.layout : null;
    const L = layoutRef.current;
    const ctx = setupCanvas(cv, w, SL?.height ?? L.height, window.devicePixelRatio || 1);
    if (!ctx) return;
    const tl = useTimeline.getState();
    const pb = usePlayback.getState();
    const frames = framesNow();
    const fps = fpsNow();
    const fit = tl.pxPerFrame === null;
    const px = tl.pxPerFrame ?? tl.fitPxPerFrame;
    let scroll = fit ? 0 : tl.scrollFrame;

    // 跟隨：位置沒動（重畫來自捲動 / 縮放）就完全不插手，否則會把使用者捲走的畫面硬拉回來。
    // 拖範圍時也壓制：邊播邊拖握把，畫面自己翻頁會讓握把從游標底下跑掉
    const cur = playheadNow();
    const moved = cur !== null && cur !== lastFrameRef.current;
    if (cur !== null) lastFrameRef.current = cur;
    if (cur !== null && !fit && pb.followMode !== "off" && !scrubRef.current && !rangeRef.current && !trimRef.current && !gainRef.current && !document.hidden) {
      const viewFrames = w / px;
      const maxScroll = Math.max(0, frames - viewFrames);
      const clamp = (v: number) => Math.max(0, Math.min(maxScroll, v));
      const x = xOfFrame(cur, scroll, px);
      let next: number | null = null;
      if (pb.followMode === "center") {
        if (pb.playing || moved) next = clamp(cur - viewFrames / 2);
      } else if (moved && (x < 0 || x > w)) {
        // seek 到畫面外 → 直接把線帶到左側 1/4，別一頁一頁爬過去
        next = clamp(cur - viewFrames * 0.25);
      } else if (pb.playing && x > w * 0.88) {
        next = clamp(scroll + viewFrames * 0.8);
      }
      if (next !== null && Math.abs(next - scroll) > 1e-3) {
        tl.setScrollFrame(next);
        scroll = next;
      }
    }

    const g = rangeRef.current;
    const hoverHit = hoverRef.current?.hit;
    const rangeHover: RangePart | null =
      g && g.moved ? (g.drag.mode === "move" ? "body" : g.drag.mode === "create" ? null : g.drag.mode) : hoverHit?.kind === "range" && hoverHit.part !== "empty" ? hoverHit.part : null;
    const rangeLabels = tl.range ? [`${timecode(rangeLength(tl.range), fps)} · ${t("{n} 幀", { n: rangeLength(tl.range) })}`, t("{n} 幀", { n: rangeLength(tl.range) })] : [];
    // 空的範圍列要自己說它可以拖 —— 跟底下「把音訊檔拖到這裡新增音軌」同一個用法：
    // 空的控制項放一句淡提示。不這樣做的話「選取區間」對沒讀過快捷鍵的人等於不存在。
    const rangeEmptyHint = tl.range ? null : t("拖曳這裡選取區間");
    const rangeHoverEmpty = hoverHit?.kind === "range" && hoverHit.part === "empty";

    if (SL) {
      // 修剪中畫預覽（序列換成修剪後的那份；列的版面不變，修剪不增減音軌）
      const tg = trimRef.current;
      const gg = gainRef.current;
      const shown = tg?.preview ?? gg?.preview ?? sqNow;
      ensureSequenceThumbs(shown, { scrollFrame: scroll, pxPerFrame: px }, w, THUMB_W);
      const state = buildSeqDrawState(shown, {
        width: w,
        scrollFrame: scroll,
        pxPerFrame: px,
        hoverFrame: hoverRef.current && !tg?.moved ? frameOfHit(hoverRef.current) : null,
        hoverClipId: tg ? tg.drag.target.id : gg ? gg.drag.target.clipId : hoverClipIdOf(hoverRef.current?.seq),
        rangeHover,
        rangeDragging: !!g?.moved,
        rangeLabels,
        rangeEmptyHint,
        rangeHoverEmpty,
        // 修剪的吸附線畫在游標底下（拖曳前時間軸上的位置）：開頭波紋修剪時邊緣本身留在原地，線要告訴使用者「剪到這裡」。
        // 刀片工具 hover：同一條線當「會切在這裡」的預覽
        // （Shift+B 關掉刀片時游標可能沒動，所以還要看工具本身，不然會留一條舊的預覽線）
        snapFrame: reorderRef.current?.preview.insertFrame ?? (tg ? (tg.result?.snap ? tg.result.edgeFrame : null) : (tl.seqTool === "blade" ? bladeRef.current : null) ?? snapRef.current?.frame ?? null),
        thumbW: THUMB_W,
        labels: seqLabels,
      });
      // 片段選取（M2.12）：buildSeqDrawState 不讀選取，這裡補上；只留還在序列裡的 id 由 drawSequence 自己比對（找不到就不畫）
      const selectedIds = tl.selectedClipIds;
      if (state && selectedIds.length) state.selectedClipIds = new Set(selectedIds);
      // 播放線留在原本的序列位置（FCP 波紋修剪時播放線不跟著內容跑）：預覽的對應表會把它帶到別的地方
      if (state && tg?.preview) state.currentFrame = sequencePlayheadNow(sqNow);
      if (state) {
        const pal = sequencePalette();
        drawSequenceTimeline(ctx, state, pal);
        // 選中的自動化點（焦點 envPoint：Delete 會刪它）畫一圈：畫在繪圖層之後，免得被片段的波形蓋掉
        const esel = useEnvPointSelection.getState().sel;
        const xy = esel && tl.focus === "envPoint" && shown.seq && SL ? envPointXY(shown.seq, SL, { scrollFrame: scroll, pxPerFrame: px }, esel) : null;
        if (xy) {
          ctx.beginPath();
          ctx.arc(xy.x, xy.y, 5, 0, Math.PI * 2);
          ctx.strokeStyle = pal("clipSelected");
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
      return;
    }

    const shots = activeShotsNow();
    const solves = useSolves.getState().byTrack;
    const selectedId = tracks.some((x) => x.id === tl.selectedTrackId) ? tl.selectedTrackId : tracks[0]?.id ?? null;
    const lanes: TrackLane[] = tracks.map((tr) => {
      const shot = shotOf(shots, tr.shotId);
      return {
        id: tr.id,
        label: tr.label,
        selected: tr.id === selectedId,
        stale: tr.stale,
        keyframes: tr.keyframes.map((k) => ({ frame: k.frame, source: k.source, locked: !!k.lockedCorners?.some(Boolean) })),
        referenceFrame: tr.referenceFrame,
        solve: solves[tr.id]?.frames ?? null,
        shotRange: shot ? [shot.startFrame, shot.endFrame] : null,
        ...(tr.kind === "object" && tr.range ? { object: { color: tr.color ?? "#888888", range: tr.range, visible: useObjectMeta.getState().byTrack[tr.id]?.visibleRanges ?? null } } : {}),
      };
    });

    if (proxy) thumbs.ensure(thumbSampleFrames(scroll, px, w, THUMB_W, frames));

    drawFrameTimeline(
      ctx,
      {
        width: w,
        scrollFrame: scroll,
        pxPerFrame: px,
        fps,
        frames,
        currentFrame: pb.frame,
        range: tl.range,
        pendingIn: tl.pendingIn,
        pendingOut: tl.pendingOut,
        loop: pb.loop,
        shots,
        shotKindLabel: (k) => t(SHOT_KIND_LABEL[k]),
        tracks: lanes,
        selectedKeyframe: tl.selectedKeyframe,
        thumbs: proxy ? { tileAt: thumbs.tileAt, thumbW: THUMB_W } : null,
        hoverFrame: hoverRef.current?.hit.frame ?? null,
        rangeHover,
        rangeDragging: !!g?.moved,
        rangeLabels,
        rangeEmptyHint,
        rangeHoverEmpty,
        snapFrame: snapRef.current?.frame ?? null,
        layout: L,
      },
      palette(),
    );
    // 素材空間（旗標開著）：尺規底緣標出序列用到的 k 範圍（FCP 的 used-media 橘線）
    if (sqNow.usedRanges.length) drawUsedInSequence(ctx, sqNow.usedRanges, { scrollFrame: scroll, pxPerFrame: px }, w, L.rulerY + L.rulerH, sequencePalette());
  }, [t, proxy, tracks, thumbs, framesNow, fpsNow, playheadNow, seqLabels]);
  drawRef.current = draw;

  // 容器寬度 → fitPxPerFrame（整段適配）
  const totalFrames = sq.active ? sq.frames : proxy?.frames ?? 0;
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => {
      const w = box.clientWidth;
      if (w > 0) useTimeline.getState().setFit(w / Math.max(1, totalFrames), w);
      schedule();
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => ro.disconnect();
  }, [totalFrames, schedule]);

  useEffect(() => {
    schedule();
    const offs = [
      useTimeline.subscribe(schedule),
      usePlayback.subscribe(schedule),
      useEdits.subscribe(schedule),
      useSolves.subscribe(schedule),
      useObjectMeta.subscribe(schedule),
      useProject.subscribe(schedule),
      useSettings.subscribe(schedule),
      useSequenceView.subscribe(schedule),
      subscribePeaks(schedule),
      useEnvPointSelection.subscribe(schedule),
    ];
    return () => {
      offs.forEach((f) => f());
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
    // 序列內容變了但版面沒變（改增益、停用片段）時 draw 的依賴不會變：把序列本身也列進來，React 換完 sqRef 之後一定再畫一次
  }, [schedule, layout, seqLayout, draw, sq.seq, sq.active, sq.usedRanges]);

  // 一次性捲動請求（指令：跳到最差幀 / 關鍵幀）
  const scrollReq = useTimeline((s) => s.scrollReq);
  useEffect(() => {
    if (!scrollReq) return;
    const tl = useTimeline.getState();
    if (tl.pxPerFrame === null) return;
    const w = boxRef.current?.clientWidth ?? tl.viewWidth;
    const viewFrames = w / tl.pxPerFrame;
    tl.setScrollFrame(Math.max(0, Math.min(Math.max(0, framesNow() - viewFrames), scrollReq.frame - viewFrames / 2)));
  }, [scrollReq, framesNow]);

  // wheel：捲動 / Ctrl 縮放（passive:false 才能 preventDefault）
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      const tl = useTimeline.getState();
      const w = box.clientWidth;
      const frames = framesNow();
      const px = tl.pxPerFrame ?? tl.fitPxPerFrame;
      const x = e.clientX - box.getBoundingClientRect().left;
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const anchor = frameOfX(x, tl.pxPerFrame === null ? 0 : tl.scrollFrame, px);
        tl.zoomBy(e.deltaY < 0 ? 1.25 : 0.8, anchor);
        const n = useTimeline.getState();
        if (n.pxPerFrame !== null) {
          const maxScroll = Math.max(0, frames - w / n.pxPerFrame);
          if (n.scrollFrame > maxScroll) n.setScrollFrame(maxScroll);
        }
        return;
      }
      if (tl.pxPerFrame !== null) {
        e.preventDefault();
        const maxScroll = Math.max(0, frames - w / tl.pxPerFrame);
        tl.setScrollFrame(Math.max(0, Math.min(maxScroll, tl.scrollFrame + (e.deltaX || e.deltaY) / tl.pxPerFrame)));
      }
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => box.removeEventListener("wheel", onWheel);
  }, [framesNow]);

  // 拖範圍 / 修剪中按 Esc：還原成拖曳前。capture 階段先攔，不然全域快捷鍵（Esc 清選取之類）會跟著觸發。
  // 修剪的預覽從來沒進 store，丟掉 ref 就是還原（trimDrag.cancelTrimDrag 的語意）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const g = rangeRef.current;
      if ((!g && !trimRef.current && !gainRef.current) || e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (g) useTimeline.setState(cancelRangeDrag(g.drag));
      rangeRef.current = null;
      trimRef.current = null;
      // 增益預覽也從沒進 store；Alt+點新增的點還沒 commit，丟掉就等於沒加
      gainRef.current = null;
      snapRef.current = null;
      setTip(null);
      schedule();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [schedule]);

  // 刀片工具用鍵盤（Shift+B / Esc）切掉時游標可能沒動：十字游標與「在這裡分割」提示要當場收掉，不然看起來還在刀片模式
  useEffect(
    () =>
      useTimeline.subscribe((s, p) => {
        if (s.seqTool === p.seqTool || s.seqTool === "blade") return;
        bladeRef.current = null;
        setTip(null);
        setCursor("default");
      }),
    [setCursor],
  );

  // ---- pointer ----
  const hitAt = (e: React.MouseEvent<HTMLCanvasElement>): PointerHit => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const tl = useTimeline.getState();
    const s = sqRef.current;
    if (s.active && s.seq && s.layout) {
      const seq = hitSequence(x, y, s.layout, viewNow(), {
        seq: s.seq,
        placed: s.placed,
        range: tl.range,
        tracks: seqHitTracksNow(s),
        // §9.4：淡化把手只在 hover / 選取時出現；hover 由「游標在片段上」本身保證，所以這裡全部放行
      });
      return { x, y, hit: toTimelineHit(seq), seq };
    }
    const hit = hitTimeline(x, y, layoutRef.current, viewNow(), {
      shots: activeShotsNow(),
      tracks: tracks.map((tr) => ({ id: tr.id, keyframes: tr.keyframes.map((k) => k.frame), referenceFrame: tr.referenceFrame })),
      range: tl.range,
    });
    return { x, y, hit, seq: null };
  };

  const rawFrameAt = (x: number) => {
    const v = viewNow();
    return frameOfX(x, v.scrollFrame, v.pxPerFrame);
  };

  /** 序列空間的吸附目標（修剪用；範圍拖曳用 rangeSnapTargetsOf 轉過的版本）：播放線、剪輯點、範圍端點、選中 track 的關鍵幀、頭尾。 */
  const trimSnapTargetsNow = (): TrimSnapTarget[] => {
    const s = sqRef.current;
    if (!s.seq) return [];
    const tl = useTimeline.getState();
    const hitTracks = seqHitTracksNow(s);
    // 跟畫面上「亮起來的那條」一致：沒選時是第一條（同素材空間）；關鍵幀是來源 k，由 collectTrimSnapTargets 經對應表換成序列幀
    const sel = hitTracks.find((x) => x.id === tl.selectedTrackId) ?? hitTracks[0];
    return collectTrimSnapTargets(s.seq, { placed: s.placed, playhead: playheadNow(), range: tl.range, keyframes: sel ? { mediaId: sel.mediaId, frames: sel.keyframes } : null });
  };

  const snapTargetsNow = (): SnapTarget[] => {
    const frames = framesNow();
    if (sqRef.current.active) return rangeSnapTargetsOf(trimSnapTargetsNow());
    const tl = useTimeline.getState();
    // 跟畫面上「亮起來的那條」一致：沒選時畫的是第一條，吸附也用第一條的關鍵幀
    const sel = tracks.find((x) => x.id === tl.selectedTrackId) ?? tracks[0];
    return collectSnapTargets({ playhead: usePlayback.getState().frame, shots: activeShotsNow(), keyframes: sel?.keyframes.map((k) => k.frame), frames });
  };

  /** 點片段（§9.5）：一般點 = 只選它、Ctrl／⌘ = 加入 / 移出、Shift = 同列延伸；焦點跟著變 clip（Delete 派發看它）。播放線不動。 */
  const selectRow = (row: ClipRow, mods: { toggle?: boolean; extend?: boolean }) => {
    const tl = useTimeline.getState();
    tl.selectClips(clickClipSelection(tl.selectedClipIds, row.id, mods, row.rowOrder));
  };

  /** 刀片的分割位置：游標所在的幀邊界，吸附（播放線、剪輯點、範圍端點…）開著而且沒按 Alt 時吸過去。 */
  const bladeFrameAt = (x: number, alt: boolean): number => {
    const raw = rawFrameAt(x);
    const tl = useTimeline.getState();
    const snap = alt || !useSnap.getState().enabled ? null : nearestTrimSnap(raw, trimSnapTargetsNow(), tl.pxPerFrame ?? tl.fitPxPerFrame);
    return Math.max(0, Math.round(snap ? snap.frame : raw));
  };

  /** 刀片點下去：切點到的片段（Shift = 所有軌）。切不到（剛好在切點上 / 空白 / 鎖定軌）講原因，不默默沒反應。 */
  const runBlade = (action: NonNullable<ReturnType<typeof bladeActionOf>>, frame: number) => {
    let ok = false;
    try {
      if (action.all) ok = splitAtFrame(frame, "all");
      else if (action.clipId) ok = splitClipAt(action.clipId, frame);
    } catch (err) {
      // 隱含序列實體化失敗（proxy 正在重建）：狀態沒變，講清楚為什麼
      toast.error(t("無法修改序列：{msg}", { msg: err instanceof Error ? err.message : String(err) }));
      return;
    }
    if (!ok) toast.info(t("這裡沒有可以分割的片段（在剪輯點或空白上）"));
  };

  /** 序列空間的按下（範圍手勢、刀片、邊緣修剪已在外面處理）。片段本體 = 選取；音訊片段的淡化 / 音量拖曳在 M2.15。 */
  const seqPointerDown = (e: React.PointerEvent<HTMLCanvasElement>, hit: SeqHit) => {
    const tl = useTimeline.getState();
    const row = clipRowOf(hit, sqRef.current);
    if (row) {
      selectRow(row, { toggle: e.ctrlKey || e.metaKey });
      // Ctrl 按著＝準備重排。選取切換照舊發生（Ctrl+點仍然是加減選），拖起來才變成搬移。
      const seq = sqRef.current.seq;
      const d = (e.ctrlKey || e.metaKey) && seq && hit.kind === "clip" ? beginReorderDrag(seq, hit.clipId) : null;
      reorderRef.current = d ? { drag: d, preview: updateReorderDrag(d, hit.frame) } : null;
      pressRef.current = { startClientX: e.clientX };
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    switch (hit.kind) {
      // 點標記 = 精準跳到那一幀（不啟動拖曳掃描；旗子只有 9 px 寬，拖著走等於點不準）
      case "marker":
        seekNow(hit.frame);
        break;
      case "tracksHeader":
        useSequenceView.getState().toggleTracks();
        break;
      case "solved":
        tl.selectTrack(hit.trackId);
        seekNow(hit.frame);
        break;
      case "user":
        tl.selectTrack(hit.trackId);
        break;
      case "reference":
        tl.selectTrack(hit.trackId);
        seekNow(hit.frame);
        break;
      case "keyframe":
        tl.selectKeyframe({ trackId: hit.trackId, frame: hit.k });
        seekNow(hit.frame);
        break;
      default:
        // 點在空音軌 / 空白處（不是尺規）= 取消片段選取（Premiere / Resolve）；Ctrl 點空白不清，免得多選時手滑全沒了
        if ((hit.kind === "audioLane" || hit.kind === "empty" || hit.kind === "dropZone") && !(e.ctrlKey || e.metaKey)) tl.selectClips([]);
        scrubRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        seekNow(hit.frame);
    }
  };

  /** 增益部位的鎖定狀態（音訊片段所在的軌鎖定；A0 原音沒有鎖定）。 */
  const gainLockedOf = (hit: SeqHit | null | undefined): boolean => hit?.kind === "audioClip" && !!sqRef.current.seq?.audioLanes.find((l) => l.id === hit.laneId)?.locked;

  /** tooltip：淡化講秒與樣本、增益講 dB（−96 = 靜音）、自動化點講點的 dB 與總增益。 */
  const gainTipText = (tip: GainTip): string => {
    const db = (v: number) => (v <= -96 ? t("−∞（靜音）") : formatGainDb(v));
    switch (tip.kind) {
      case "fadeIn":
        return t("淡入 {s} 秒（{n} 樣本）", { s: (tip.samples / 48000).toFixed(2), n: tip.samples });
      case "fadeOut":
        return t("淡出 {s} 秒（{n} 樣本）", { s: (tip.samples / 48000).toFixed(2), n: tip.samples });
      case "gain":
        return t("增益 {db}", { db: db(tip.db) });
      case "point":
        return t("自動化點 {db}（總 {total}）", { db: db(tip.db), total: db(tip.totalDb) });
    }
  };

  /**
   * 按在增益部位上：先選取片段（已在選取裡就保留多選），自動化點另外設焦點 envPoint（Delete 刪點）；
   * Alt+點音量線在按下的位置新增一點並接著拖它。鎖定的軌講原因、不 scrub。
   */
  const startGain = (e: React.PointerEvent<HTMLCanvasElement>, hit: SeqHit, press: NonNullable<ReturnType<typeof gainPressOf>>) => {
    const s = sqRef.current;
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const row = s.seq && s.layout ? gainRowOf(s.layout, press.target) : null;
    if (!s.seq || !row) return;
    const b = beginGainDrag(s.seq, press.target, { mode: press.mode, row, y, pointIndex: press.pointIndex, addAtSample: press.add ? sampleOfX(x, s.seq.fps, viewNow()) : null, fps: s.seq.fps });
    if (!b.ok) {
      if (b.reason === "locked") toast.info(t("音軌已鎖定"));
      return;
    }
    const tl = useTimeline.getState();
    const clipRow = clipRowOf(hit, s);
    if (clipRow && !tl.selectedClipIds.includes(clipRow.id)) selectRow(clipRow, { toggle: e.ctrlKey || e.metaKey });
    if (b.drag.mode === "point" && b.drag.pointIndex !== null) {
      useEnvPointSelection.getState().select({ target: b.drag.target, index: b.drag.pointIndex });
      useTimeline.getState().setFocus("envPoint");
    } else if (useTimeline.getState().focus === "envPoint") {
      // 片段本來就在選取裡時 selectRow 不會跑：焦點要從上一個自動化點拉回片段，不然接著按 Delete 會刪到那個點
      useTimeline.getState().setFocus("clip");
    }
    gainRef.current = {
      drag: b.drag,
      startX: x,
      startY: y,
      moved: false,
      result: null,
      preview: b.drag.created ? { ...s, seq: b.drag.origin, placed: placeVideo(b.drag.origin), frames: durationFrames(b.drag.origin) } : null,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setCursor(gainCursorOf(hit, e.altKey, false) ?? "default");
  };

  /** 增益拖曳的一步：過了拖曳門檻才從 origin 重算。Shift = 0.1 dB / px、Alt = 時間樣本級。 */
  const moveGain = (gg: GainGesture, h: PointerHit, e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!gg.moved && Math.hypot(h.x - gg.startX, h.y - gg.startY) < DRAG_THRESHOLD_PX) return;
    gg.moved = true;
    const fps = gg.drag.origin.fps;
    const res = updateGainDrag(gg.drag, { sample: sampleOfX(h.x, fps, viewNow()), y: h.y, fps, fine: e.shiftKey, free: e.altKey });
    gg.result = res;
    gg.preview = res.seq === sqRef.current.seq ? null : { ...sqRef.current, seq: res.seq, placed: placeVideo(res.seq), frames: durationFrames(res.seq) };
    setTip({ x: h.x, y: h.y, text: gainTipText(res.tip) });
    schedule();
  };

  /** 放開增益拖曳：有移動（或 Alt+點新增了點）就 commit 一筆；沒動 = 只是點選（選取在按下時已經做了）。 */
  const finishGain = (gg: GainGesture) => {
    gainRef.current = null;
    setTip(null);
    if (!gg.moved && !gg.drag.created) return;
    try {
      commitGainDrag(gg.drag, gg.moved ? gg.result : null, useEdits.getState().editSequence, SEQ_EDIT_LABEL);
    } catch (err) {
      toast.error(t("無法修改序列：{msg}", { msg: err instanceof Error ? err.message : String(err) }));
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !proxy) return;
    const { x, hit, seq } = hitAt(e);
    const tl = useTimeline.getState();
    const pb = usePlayback.getState();

    // 刀片工具（Shift+B，§9.5）：排在範圍手勢前面 —— 刀片裡的 Shift+點是「切所有軌」，不是拉範圍
    const blade = sqRef.current.active && tl.seqTool === "blade" ? bladeActionOf(seq, e.shiftKey) : null;
    if (blade) {
      runBlade(blade, bladeFrameAt(x, e.altKey));
      schedule();
      return;
    }

    // 範圍手勢：範圍列上任何按下，或任何列 Shift+按下（不 seek、不選 track）
    if (hit.kind === "range" || e.shiftKey) {
      const mode = hit.kind === "range" ? partMode(hit.part) : "create";
      rangeRef.current = {
        drag: beginRangeDrag(mode, rawFrameAt(x), tl),
        startX: x,
        moved: false,
        shift: e.shiftKey,
        band: hit.kind === "range",
        targets: snapTargetsNow(),
        clipRow: e.shiftKey && hit.kind !== "range" ? clipRowOf(seq, sqRef.current) : null,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
      if (mode === "move") setCursor("grabbing");
      schedule();
      return;
    }

    // 片段邊緣：修剪（M2.13）。沒拖動就當成點一下片段，放開時再選取
    const trimTarget = trimTargetOf(seq);
    if (seq && trimTarget && sqRef.current.seq) {
      const b = beginTrimDrag(sqRef.current.seq, trimTarget, rawFrameAt(x));
      if (b.ok) {
        const ctx = makeSeqCtx(useProject.getState().media, useEdits.getState().audioMedia);
        trimRef.current = {
          drag: b.drag,
          startX: x,
          moved: false,
          pressRow: clipRowOf(seq, sqRef.current),
          toggle: e.ctrlKey || e.metaKey,
          targets: trimSnapTargetsNow(),
          ctx,
          result: null,
          preview: null,
        };
        e.currentTarget.setPointerCapture(e.pointerId);
        setCursor("ew-resize");
      }
      // 拒絕（鎖定的軌）時也不 scrub：按在鎖定片段邊緣上播放線跳走，會讓人以為修剪生效了；hover 提示已經寫了「已鎖定」
      schedule();
      return;
    }

    // 音訊片段的淡化把手 / 音量線 / 自動化點（M2.15）：hitSequence 已照優先序決定部位，邊緣（修剪）在上面先處理了
    const gainPress = sqRef.current.active ? gainPressOf(seq, e.altKey) : null;
    if (seq && gainPress) {
      startGain(e, seq, gainPress);
      schedule();
      return;
    }

    if (seq) {
      seqPointerDown(e, seq);
      schedule();
      return;
    }

    switch (hit.kind) {
      case "ruler":
      case "thumbs":
      case "shots":
      case "empty":
        scrubRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        pb.seek(hit.frame);
        break;
      case "solved":
        tl.selectTrack(hit.trackId);
        pb.seek(hit.frame);
        break;
      case "user":
        tl.selectTrack(hit.trackId);
        break;
      case "reference":
        tl.selectTrack(hit.trackId);
        pb.seek(hit.frame);
        break;
      case "keyframe":
        tl.selectKeyframe({ trackId: hit.trackId, frame: hit.frame });
        pb.seek(hit.frame);
        break;
    }
    schedule();
  };

  /** 序列空間專屬的 hover 說明（片段、空白、原音、音訊片段）；其他目標回 undefined 交給 M1 的說明。 */
  const seqTipText = (hit: SeqHit): string | null | undefined => {
    const s = sqRef.current;
    const seq = s.seq;
    if (!seq) return undefined;
    // 標記：畫在旗子旁邊的名字擠在一起時會被截掉，hover 給完整的那一份
    if (hit.kind === "marker") return hit.name || t("標記");
    // 邊緣（±6 px）：先告訴使用者這裡可以拖、拖了會發生什麼（V1 波紋 / 音訊不波紋 / 鎖定拖不動）
    const edge = trimTargetOf(hit);
    if (edge) return trimHoverText(t, edge, laneLockedOf(edge));
    // 增益部位（M2.15）：拖了會怎樣、有哪些修飾鍵
    const gp = gainPressOf(hit, false);
    if (gp) {
      if (gainLockedOf(hit)) return t("音軌已鎖定");
      if (gp.mode === "fadeIn") return t("拖曳調整淡入長度；Alt＝樣本級");
      if (gp.mode === "fadeOut") return t("拖曳調整淡出長度；Alt＝樣本級");
      if (gp.mode === "gain") return t("上下拖曳調整增益（放開後按住 Shift 細調）；Alt+點新增自動化點");
      return t("拖曳移動自動化點；選取後按 Delete 刪除");
    }
    switch (hit.kind) {
      case "clip": {
        const clip = seq.video.find((v) => v.id === hit.clipId);
        if (clip?.kind !== "clip") return null;
        const m = useProject.getState().media.find((x) => x.id === clip.mediaId);
        const fps = m?.proxy?.fps ?? seq.fps;
        const name = clip.label || m?.name || clip.mediaId;
        return t("{name} · 來源 {in}–{out}（{n} 幀）", { name, in: timecode(clip.srcIn, fps), out: timecode(clip.srcOut, fps), n: clip.srcOut - clip.srcIn });
      }
      case "gap": {
        const gap = seq.video.find((v) => v.id === hit.gapId);
        return gap?.kind === "gap" ? t("空白 · {n} 幀", { n: gap.length }) : null;
      }
      case "original": {
        const clip = seq.video.find((v) => v.id === hit.clipId);
        if (clip?.kind !== "clip") return null;
        if (clip.audio.detachedTo !== undefined) return t("原音已分離到音軌");
        return t("原音 · {db}", { db: formatGainDb(clip.audio.gainDb) });
      }
      case "audioClip": {
        const lane = seq.audioLanes.find((l) => l.id === hit.laneId);
        const c = lane?.clips.find((x) => x.id === hit.clipId);
        if (!c) return null;
        const src = c.source;
        const am = src.type === "audio" ? useEdits.getState().audioMedia.find((a) => a.id === src.audioId) : undefined;
        return `${c.label || am?.name || lane?.name || ""} · ${formatGainDb(c.gainDb)}`;
      }
      case "solved":
      case "user":
      case "keyframe":
      case "reference":
      case "range":
        return undefined;
      default:
        return null;
    }
  };

  /** 滑過解算列：人話原因；滑過菱形：關鍵幀資訊；滑過範圍列：範圍資訊或「可以拖」。 */
  const hoverTipText = (hit: TimelineHit): string | null => {
    switch (hit.kind) {
      case "solved": {
        const solve = useSolves.getState().byTrack[hit.trackId];
        const f = solve ? solveAt(solve, hit.frame) : null;
        return f ? `${t(TRACK_STATE_LABEL[f.state])} · ${t("信心 {pct}%", { pct: Math.round(f.conf * 100) })}` : t("這一幀還沒有解算");
      }
      case "keyframe": {
        const all = sqRef.current.active ? Object.values(useEdits.getState().tracks).flat() : tracks;
        const kf = all.find((x) => x.id === hit.trackId)?.keyframes.find((k) => k.frame === hit.frame);
        if (!kf) return null;
        return `${t("關鍵幀")} ${kf.frame} · ${kf.source === "user" ? t("使用者硬釘") : t("偵測器")}${kf.lockedCorners?.some(Boolean) ? ` · ${t("有鎖定的角")}` : ""}`;
      }
      case "reference":
        return `${t("參考影格")} ${hit.frame}`;
      case "range": {
        const range = useTimeline.getState().range;
        return range && hit.part !== "empty" ? rangeTipText(range, null) : t("拖曳建立範圍（時間軸任何地方 Shift+拖曳也可以）；雙擊＝整段");
      }
      default:
        return null;
    }
  };

  /** 修剪拖曳的一步：過了拖曳門檻才從 origin 重算預覽（trimDrag.updateTrimDrag）、更新 tooltip。Alt = 不吸附（音訊片段同時變樣本級）。 */
  const moveTrim = (tg: TrimGesture, h: PointerHit, alt: boolean) => {
    if (!tg.moved && Math.abs(h.x - tg.startX) < DRAG_THRESHOLD_PX) return;
    tg.moved = true;
    setCursor("ew-resize");
    schedule();
    const tl = useTimeline.getState();
    const targets = alt || !useSnap.getState().enabled ? [] : tg.targets;
    const res = updateTrimDrag(tg.drag, rawFrameAt(h.x), { pxPerFrame: tl.pxPerFrame ?? tl.fitPxPerFrame, targets, ctx: tg.ctx, free: alt });
    tg.result = res;
    tg.preview = res.seq === tg.drag.origin ? null : { ...sqRef.current, seq: res.seq, placed: placeVideo(res.seq), frames: durationFrames(res.seq) };
    const info = trimTipInfo(tg.drag, res);
    const sourceFps = info.mediaId ? useProject.getState().media.find((m) => m.id === info.mediaId)?.proxy?.fps : null;
    setTip({ x: h.x, y: h.y, text: trimTipText(t, info, { seqFps: tg.drag.origin.fps, sourceFps, sampleRate: tg.drag.origin.sampleRate, free: alt }) });
  };

  /** 音訊片段所在的軌鎖定了嗎（V1 沒有鎖定）。 */
  const laneLockedOf = (target: TrimTarget): boolean => target.kind === "audio" && !!sqRef.current.seq?.audioLanes.find((l) => l.id === target.laneId)?.locked;

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const h = hitAt(e);
    hoverRef.current = h;

    if (trimRef.current) {
      moveTrim(trimRef.current, h, e.altKey);
      return;
    }
    if (gainRef.current) {
      moveGain(gainRef.current, h, e);
      return;
    }

    const g = rangeRef.current;
    if (g) {
      if (!g.moved && Math.abs(h.x - g.startX) < DRAG_THRESHOLD_PX) return;
      g.moved = true;
      const tl = useTimeline.getState();
      // Alt = 暫時關吸附（N / S 已經被新增追蹤 / 切鏡頭佔走）；吸附開關（Shift+N）關著時也不吸
      const res = updateRangeDrag(g.drag, rawFrameAt(h.x), { frames: framesNow(), pxPerFrame: tl.pxPerFrame ?? tl.fitPxPerFrame, targets: e.altKey || !useSnap.getState().enabled ? [] : g.targets });
      snapRef.current = res.snap;
      tl.setRange(res.range);
      setTip({ x: h.x, y: h.y, text: rangeTipText(res.range, res.snap) });
      setCursor(g.drag.mode === "move" ? "grabbing" : g.drag.mode === "create" ? "crosshair" : "ew-resize");
      schedule();
      return;
    }

    // 重排拖曳：只更新預覽（插入點那條線），不碰 store、也不 scrub
    const rd = reorderRef.current;
    if (rd) {
      rd.preview = updateReorderDrag(rd.drag, h.seq ? h.seq.frame : frameOfHit(h));
      const tip = reorderTipText(rd.preview.delta, t);
      setTip((prev) => (tip ? (prev && prev.text === tip ? prev : { x: h.x, y: h.y, text: tip }) : null));
      setCursor("grabbing");
      schedule();
      return;
    }

    // 按在片段本體上（已選取）：拖過門檻才變成 scrub；只是點一下的話播放線不動（§9.5）
    const pr = pressRef.current;
    if (pr && !scrubRef.current && Math.abs(e.clientX - pr.startClientX) >= DRAG_THRESHOLD_PX) scrubRef.current = true;

    // 刀片工具 hover：游標變十字、吸附線預覽會切在哪、tooltip 講 Shift 的差別。拖曳 / scrub 中不預覽
    const blade = !scrubRef.current && !pr && sqRef.current.active && useTimeline.getState().seqTool === "blade" ? bladeActionOf(h.seq, e.shiftKey) : null;
    bladeRef.current = blade ? bladeFrameAt(h.x, e.altKey) : null;
    if (blade) {
      setCursor("crosshair");
      const text = blade.all ? t("在這裡分割所有軌") : blade.clipId ? t("在這裡分割") : null;
      setTip((prev) => (text ? (prev && prev.text === text && Math.abs(prev.x - h.x) < 24 ? prev : { x: h.x, y: h.y, text }) : null));
      schedule();
      return;
    }

    if (scrubRef.current) seekNow(frameOfHit(h));
    const gainCursor = !scrubRef.current && !e.shiftKey ? gainCursorOf(h.seq, e.altKey, gainLockedOf(h.seq)) : null;
    setCursor(gainCursor ?? hoverCursorOf(h, e.shiftKey, scrubRef.current, laneLockedOf));
    const seqText = h.seq ? seqTipText(h.seq) : undefined;
    const text = scrubRef.current && h.hit.kind === "range" ? null : seqText !== undefined ? seqText : hoverTipText(h.hit);
    setTip((prev) => (text ? (prev && prev.text === text && Math.abs(prev.x - h.x) < 24 ? prev : { x: h.x, y: h.y, text }) : null));
    schedule();
  };

  const finishRange = (e: React.PointerEvent<HTMLCanvasElement>, g: RangeGesture) => {
    rangeRef.current = null;
    snapRef.current = null;
    if (g.moved) {
      setTip(null);
      return;
    }
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const tl = useTimeline.getState();
    const frames = framesNow();
    if (g.shift && g.clipRow) {
      // 序列空間 Shift+點片段（沒拖）＝同列延伸選取（§9.5，ai-music-cut 的 Shift 延伸）；在尺規 / 空白處 Shift+點仍是延伸範圍
      selectRow(g.clipRow, { extend: true });
    } else if (g.shift) {
      const r = shiftClickRange(tl, edgeAtX(x, viewNow()), frames);
      if (r.kind === "range") tl.setRange(r.range);
      else useTimeline.setState({ range: null, pendingIn: r.frame, pendingOut: null });
    } else if (g.band) {
      // 點範圍列（沒拖）＝跟點尺規一樣 seek；範圍不動
      seekNow(frameAtX(x, viewNow()));
    }
  };

  /** 放開修剪：有移動就用最後的 delta commit 一筆「修剪片段」；沒移動 = 點一下邊緣，跟點片段本體一樣選取（播放線不動）。 */
  const finishTrim = (tg: TrimGesture) => {
    trimRef.current = null;
    snapRef.current = null;
    setTip(null);
    if (!tg.moved) {
      if (tg.pressRow) selectRow(tg.pressRow, { toggle: tg.toggle });
      return;
    }
    try {
      commitTrimDrag(tg.drag, tg.result, useEdits.getState().editSequence, SEQ_EDIT_LABEL.trim);
    } catch (err) {
      // 隱含序列實體化失敗（proxy 在拖曳中被重建）或片段在拖曳中被刪：狀態沒變，講清楚為什麼沒生效
      toast.error(t("修剪失敗：{msg}", { msg: err instanceof Error ? err.message : String(err) }));
    }
  };

  const endPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = rangeRef.current;
    if (g) finishRange(e, g);
    const rd = reorderRef.current;
    reorderRef.current = null;
    if (rd && rd.preview.delta !== 0) {
      // 跟修剪 / 增益一樣直接 commit（undo toast 是指令層的事，時間軸拖曳不經過它）
      useEdits.getState().editSequence(SEQ_EDIT_LABEL.reorder, (sq) => moveItemTo(sq, rd.drag.id, rd.preview.toIndex));
      setTip(null);
    }
    const tg = trimRef.current;
    if (tg) finishTrim(tg);
    const gg = gainRef.current;
    if (gg) finishGain(gg);
    pressRef.current = null;
    scrubRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    schedule();
  };

  // 系統搶走指標（切視窗、觸控取消）＝使用者沒有「放開」，範圍還原、修剪預覽丟掉，不要留一個拖到一半的狀態
  const onPointerCancel = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // 重排也一樣：預覽只活在 ref 裡，丟掉就等於沒發生過（store 從頭到尾沒被碰過）
    if (reorderRef.current) {
      reorderRef.current = null;
      setTip(null);
    }
    const g = rangeRef.current;
    if (g) {
      useTimeline.setState(cancelRangeDrag(g.drag));
      rangeRef.current = null;
      snapRef.current = null;
      setTip(null);
    }
    if (trimRef.current || gainRef.current) {
      trimRef.current = null;
      gainRef.current = null;
      snapRef.current = null;
      setTip(null);
    }
    endPointer(e);
  };

  const onPointerLeave = () => {
    hoverRef.current = null;
    bladeRef.current = null;
    if (!rangeRef.current && !trimRef.current && !gainRef.current) setTip(null);
    schedule();
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!proxy || e.shiftKey) return;
    const { hit, seq } = hitAt(e);
    // 雙擊音訊片段本體 = 開 Inspector「片段」頁（§9.5，Resolve 雙擊開片段）
    if (seq?.kind === "audioClip" && seq.part === "body") {
      openClipInspector(seq.clipId);
      return;
    }
    const tl = useTimeline.getState();
    const frames = framesNow();
    if (hit.kind === "range") {
      // 本體 = 縮放到範圍（ai-music-cut 的 Z）；空白 = 整段（AE 雙擊工作區回全長）
      if (hit.part === "body") tl.zoomToRange(null, frames);
      else if (hit.part === "empty") tl.rangeAll(frames);
    } else if (hit.kind === "shots" && hit.shotId) {
      const shot = shotOf(activeShotsNow(), hit.shotId);
      if (shot) {
        tl.setRange({ in: shot.startFrame, out: shot.endFrame });
        usePlayback.getState().seek(shot.startFrame);
      }
    }
    schedule();
  };

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (!proxy) return;
    const { hit, seq } = hitAt(e);
    const tl = useTimeline.getState();
    // 序列空間（M2.12）：片段 / 空白 / 音訊片段有自己的選單，右鍵先選取點到的東西；其他命中（尺規、範圍、車道、菱形）由它轉回時間軸選單。
    // 外面明確給了 onContextMenuAt 時照舊交給它（嵌入者自己決定選單）
    if (seq && !onContextMenuAt) {
      setTip(null);
      openSequenceContextMenu({ clientX: e.clientX, clientY: e.clientY, hit: seq });
      schedule();
      return;
    }
    // 右鍵不移動播放線（Resolve 慣例）；例外是車道與菱形：以 track 為對象的選單項目要先有對象
    if (hit.kind === "solved" || hit.kind === "user" || hit.kind === "reference") tl.selectTrack(hit.trackId);
    else if (hit.kind === "keyframe") {
      tl.selectKeyframe({ trackId: hit.trackId, frame: hit.frame });
      // 序列空間：hit.frame 是來源 k（選單以 k 為鍵），播放線要移到序列上被點的那一次出現
      if (seq) seekNow(seq.frame);
      else usePlayback.getState().seek(hit.frame);
    }
    setTip(null);
    const h = onContextMenuAt ?? timelineContextMenuHandler();
    h?.(contextRequestOf(hit, tl.range, e.clientX, e.clientY));
    schedule();
  };

  return (
    <div className="relative w-full h-full min-h-0 overflow-y-auto overflow-x-hidden bg-well select-none" data-testid="frame-timeline">
      {sq.enabled && media && (
        <SpaceSwitch
          space={sq.active ? "sequence" : "source"}
          sourceName={media.name}
          edited={sq.edited}
          disabledSequence={!sq.seq}
          onChange={(s) => useTimeline.getState().setSpace(s)}
        />
      )}
      <div className="flex min-w-0">
        {seqLayout && sq.seq && (
          <TrackHeaders layout={seqLayout} seq={sq.seq} tracks={sq.headerTracks} implicit={sq.implicit} onSelectTrack={(id) => useTimeline.getState().selectTrack(id)} />
        )}
        <div ref={boxRef} className="relative flex-1 min-w-0">
          <canvas
            ref={canvasRef}
            className="block"
            style={{ height, touchAction: "none", cursor }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPointer}
            onPointerCancel={onPointerCancel}
            onPointerLeave={onPointerLeave}
            onDoubleClick={onDoubleClick}
            onContextMenu={onContextMenu}
            aria-label={sq.active ? t("序列時間軸") : t("幀時間軸")}
          />
          {tip && (
            <div
              className="pointer-events-none absolute z-10 rounded bg-elevated border border-fg/10 shadow-e2 px-2 py-1 text-[11px] text-fg/85 whitespace-nowrap"
              style={{ left: Math.max(0, Math.min(tip.x + 12, (boxRef.current?.clientWidth ?? 0) - 260)), top: tip.y + 14 }}
              role="tooltip"
            >
              {tip.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
