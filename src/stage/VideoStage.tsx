import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Film } from "lucide-react";
import { audioBeforePlay, audioPreview, installAudioPreview, useAudioMonitor } from "../audio/preview";
import { openStageContextMenu } from "../commands/menuModel";
import { useT } from "../i18n";
import { pluginTrackKeys, type Quad, type TrackV1 } from "../project/format";
import type { PluginMediaState } from "../plugins/api";
import { plugins } from "../plugins/registry";
import { installCaptionLayoutSync } from "../pipeline/captions";
import { useCaptionLayout, useCaptionsUi } from "../store/captions";
import { useMasks } from "../store/masks";
import { cancelFxPreview, fxPreviewKey, getFxPreview, maskRev, planFxPreview, requestFxPreview, useFxPreview, type FxNote } from "../fx/preview";
import { runPreview } from "../objects/actions";
import { requestMaskFrame } from "../objects/maskFrame";
import { ensureObjectMeta, useObjectMeta } from "../objects/meta";
import { boxFromDrag, DRAG_BOX_MIN_PX, useSelection } from "../objects/selection";
import { useObjectsUi } from "../objects/ui";
import { usePlayback } from "../store/playback";
import { useSettings } from "../store/settings";
import { useSolves } from "../store/solves";
import { useTimeline } from "../store/timeline";
import { EmptyState } from "../ui/index";
import { VIEW_MODE_LABEL } from "../video/labels";
import { moveCorner, quadCenter, translateQuad, type Pt } from "../video/quad";
import { useEdits, useProject } from "./_contracts";
import { useActiveMedia } from "./active";
import { stabilizeAffine } from "./affine";
import { hitQuad, pickQuad, type CornerIndex } from "./hit";
import { drawCaptionLayer } from "./layers/CaptionLayer";
import { drawHudLayer, type MagnifierState } from "./layers/HudLayer";
import { drawMaskLayer, type MaskItem } from "./layers/MaskLayer";
import { drawObjectLayer, type ObjectBoxItem, type ObjectLayerState } from "./layers/ObjectLayer";
import { drawPreviewLayer, drawVideoFrame, SPLIT_HANDLE_PX, splitScreenX } from "./layers/PreviewLayer";
import { drawAspectGuideLayer } from "./layers/AspectGuideLayer";
import { drawSurfaceLayer, type SurfaceItem } from "./layers/SurfaceLayer";
import { drawDarken, drawTrackHudLayer } from "./layers/TrackHudLayer";
import { drawTrackingRegionLayer } from "./layers/TrackingRegionLayer";
import { palette, setupCanvas } from "./paint";
import { applyShuttle, seekToFrame, setPlayer } from "./playerRef";
import { getPreview, hashOf, hasPreviewProvider, previewKey, requestPreview, usePreviews } from "./previewStore";
import { consumeSeekReq, installSequencePlayer, onPresentedFrame, seekSequenceFrame, sequencePlaying, useSeqStage, type BlackReason } from "./sequencePlayer";
import { referenceSurface, surfaceAt, type SurfaceSample } from "./surfaceAt";
import { useRvfc } from "./useRvfc";
import { useStageGeometry, type StageGeometry } from "./useStageGeometry";
import { needsPreview, useStage, type ViewMode } from "./viewMode";

/**
 * 影片舞台（計畫 §9 VideoStage）：`<video src={convertFileSrc(proxy.mp4)}>` + 一張疊層 canvas。
 *
 * - 幀時鐘是 rVFC（useRvfc）：每呈現一幀 → 回寫 playback.frame → schedule() 重畫疊層；暫停時零 CPU。
 * - 疊層**不**透過 React state 重繪：所有 store 用 subscribe → schedule()，draw() 裡 getState() 讀最新值。
 *   React 只管 <video> 的 src / 可見性與游標樣式；一秒 30 次的重畫走不到 React。
 * - 座標一律來源像素（useStageGeometry.toVideo）；拖角放手才 commit 一次 setUserKeyframe。
 * - 檢視模式：stabilized / difference 把 <video> 藏起來（仍在解碼），影格由我們畫進 canvas。
 * - 右鍵選單：這裡只做命中（點在哪條 track 的表面上），內容與開啟在 commands/menuModel.ts（openStageContextMenu）。
 */

type DragState =
  | { kind: "corner"; trackId: string; target: "surface" | "region"; index: CornerIndex; start: Quad; live: Quad; moved: boolean }
  | { kind: "move"; trackId: string; start: Quad; live: Quad; startSrc: Pt; moved: boolean }
  | { kind: "split" };

/** 「選取物件」工具的拖曳：短於 DRAG_BOX_MIN_PX 是點一下（點），長的是框。座標是來源像素。 */
interface ObjDrag {
  startScreen: Pt;
  startSrc: [number, number];
  curSrc: [number, number];
  alt: boolean;
  moved: boolean;
}

type CursorStyle = "default" | "crosshair" | "move" | "grab" | "grabbing" | "col-resize" | "pointer";

function toScreenQuad(g: StageGeometry, q: Quad): Quad {
  return { p: [g.toScreen(q.p[0]), g.toScreen(q.p[1]), g.toScreen(q.p[2]), g.toScreen(q.p[3])] };
}

const NO_TRACKS: TrackV1[] = [];

/** 序列黑畫面的浮水印（zh key，en.ts 已有；§8.1「空白或停用 → 黑底加浮水印」）。 */
const BLACK_LABEL: Record<BlackReason, string> = { gap: "空白", disabled: "已停用", offline: "媒體離線" };

/**
 * 序列在空白 / 停用 / 離線片段上：整個影像區塗黑、中間一行浮水印，其他疊層都不畫 ——
 * 那一刻畫面上沒有任何來源幀，追蹤表面、遮罩、字幕畫上去都是在騙人（它們讀的 playback.frame 是上一個片段留下來的 k）。
 */
function drawSequenceBlack(ctx: CanvasRenderingContext2D, g: StageGeometry, label: string, pal: ReturnType<typeof palette>): void {
  ctx.fillStyle = "rgb(0 0 0)";
  ctx.fillRect(g.rect.x, g.rect.y, g.rect.w, g.rect.h);
  ctx.font = "13px Inter Variable, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = pal("fg", 0.45);
  ctx.fillText(label, g.rect.x + g.rect.w / 2, g.rect.y + g.rect.h / 2);
}

/** 點 / 框落在畫面外時夾回來源畫面內（引擎的提示座標要在影像裡）。 */
function clampSrc(g: StageGeometry, p: Pt): [number, number] {
  return [Math.max(0, Math.min(g.srcW - 0.5, p[0])), Math.max(0, Math.min(g.srcH - 0.5, p[1]))];
}

/** 這一幀外接框蓋住 p（來源像素）的物件 track；好幾個重疊時取面積最小的（通常是使用者要的那個）。 */
function objectAt(mediaId: string, frame: number, p: Pt): string | null {
  const metas = useObjectMeta.getState().byTrack;
  let best: { id: string; area: number } | null = null;
  for (const t of useEdits.getState().tracks[mediaId] ?? []) {
    if (t.kind !== "object") continue;
    const b = metas[t.id]?.frames.get(frame)?.bbox;
    if (!b || p[0] < b[0] || p[1] < b[1] || p[0] > b[0] + b[2] || p[1] > b[1] + b[3]) continue;
    const area = b[2] * b[3];
    if (!best || area < best.area) best = { id: t.id, area };
  }
  return best?.id ?? null;
}

/** 放開滑鼠：拖得夠遠 = 框（取代原本的框），不然 = 點（Alt = 減選）。改完立刻送單幀預覽。 */
function commitObjDrag(mediaId: string, frame: number, od: ObjDrag): void {
  const sel = useSelection.getState();
  if (od.moved) {
    const box = boxFromDrag(od.startSrc, od.curSrc);
    if (!box) return;
    sel.setBox(mediaId, frame, box);
  } else {
    sel.addPoint(mediaId, frame, { x: od.startSrc[0], y: od.startSrc[1], label: od.alt ? 0 : 1 });
  }
  void runPreview();
}

/**
 * 這一幀的物件疊層（沒有物件也沒有選取 → null，什麼都不畫）。
 * 框來自錨點（查表）；遮罩只在「選中的物件 × 暫停 × 遮罩圖層開著」時讀一幀（第一次讀是非同步的，讀好了 store 會叫重畫）。
 */
function objectLayerState(mediaId: string | null, tracks: TrackV1[], frame: number, selectedId: string | null, showMasks: boolean, drag: ObjDrag | null): ObjectLayerState | null {
  if (!mediaId) return null;
  const session = useSelection.getState().session;
  const objects = tracks.filter((x) => x.kind === "object");
  if (!objects.length && !session && !drag) return null;
  const metas = useObjectMeta.getState().byTrack;
  const boxes: ObjectBoxItem[] = [];
  for (const o of objects) {
    if (!(o.id in metas)) void ensureObjectMeta(mediaId, o.id);
    const f = metas[o.id]?.frames.get(frame);
    if (f) boxes.push({ trackId: o.id, label: o.label, color: o.color ?? "#FFFFFF", bbox: f.bbox, selected: o.id === selectedId });
  }
  let mask: ObjectLayerState["mask"] = null;
  const selObj = objects.find((o) => o.id === selectedId);
  if (selObj && showMasks && useObjectsUi.getState().showMask && !usePlayback.getState().playing) {
    const m = useMasks.getState();
    if (requestMaskFrame(mediaId, selObj.id, frame, m.has, m.put)) {
      const e = m.get(selObj.id, frame);
      if (e) mask = { bitmap: e.bitmap, color: selObj.color ?? "#FFFFFF" };
    }
  }
  const selection = session && session.mediaId === mediaId && session.frame === frame ? { bitmap: session.bitmap, box: session.box, stale: session.previewRev !== session.rev } : null;
  const rubber = drag?.moved ? { a: drag.startSrc, b: drag.curSrc } : null;
  return { boxes, mask, selection, rubber };
}

/**
 * 選中 track 的效果 / 替換預覽狀態（fx/preview.ts）。只有暫停時才去要圖：播放中每一幀都不一樣，要了也趕不上。
 * active＝這條 track 有東西可預覽（舞台改畫預覽圖、不畫 comp.preview）；note＝HUD 那一句（產生中 / 為什麼沒有）。
 */
function fxStageState(mediaId: string, tracks: TrackV1[], selectedId: string | null, frame: number, samples: { track: TrackV1; sample: SurfaceSample | null }[]): { active: boolean; image: CanvasImageSource | null; note: FxNote | null } | null {
  const track = selectedId && useFxPreview.getState().live ? tracks.find((x) => x.id === selectedId) : null;
  const sample = track ? samples.find((s) => s.track.id === track.id)?.sample ?? null : null;
  const plan = track ? planFxPreview(track, frame, mediaId, { quad: sample && sample.state !== "missing" ? sample.quad : null, rev: maskRev(track.id) }) : null;
  // 沒東西可預覽了（取消選取、關掉預覽、改成沒有特效）：還在等 debounce 的那個請求不必送了
  if (!plan || "skip" in plan) {
    cancelFxPreview();
    return plan ? { active: false, image: null, note: plan.skip } : null;
  }
  const e = getFxPreview(fxPreviewKey(plan.parts));
  if (e) return { active: true, image: e.img, note: e.note };
  const playing = usePlayback.getState().playing;
  if (playing) cancelFxPreview();
  else requestFxPreview(plan.parts);
  return { active: true, image: null, note: playing ? null : { key: "效果預覽產生中…" } };
}

/**
 * 預覽快取鍵的三個 hash：tracks 陣列 / 外掛的這支媒體狀態參考沒變就沿用，不要每幀 JSON.stringify 六條 track。
 * 外掛擁有的 track 鍵（例如 cards 的 slotId）算進 tracksHash；外掛的目標（例如每個格位要換成哪張牌）由外掛的 previewKey 決定。
 */
function useHashMemo() {
  const ref = useRef<{ tracks: TrackV1[] | null; media: PluginMediaState | undefined | null; tracksHash: string; targetsHash: string; insertHash: string }>({
    tracks: null,
    media: null,
    tracksHash: "",
    targetsHash: "",
    insertHash: "",
  });
  return (tracks: TrackV1[], media: PluginMediaState | undefined) => {
    const m = ref.current;
    if (m.tracks !== tracks) {
      m.tracks = tracks;
      const own = pluginTrackKeys();
      m.tracksHash = hashOf(tracks.map((t) => [t.id, t.keyframes, t.trackingRegion, t.regionPolicy, t.options, t.referenceFrame, ...own.map((k) => (t as unknown as Record<string, unknown>)[k])]));
      m.insertHash = hashOf(tracks.map((t) => t.insert));
    }
    if (m.media !== media) {
      m.media = media;
      const keys = plugins().flatMap((p) => (p.stage?.previewKey ? [p.stage.previewKey(media)] : []));
      m.targetsHash = hashOf(keys.length === 1 ? keys[0] : keys);
    }
    return m;
  };
}

export default function VideoStage() {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  videoRef.current = video;

  const media = useActiveMedia();
  const proxy = media?.proxy ?? null;
  const geo = useStageGeometry(containerRef, proxy);
  const geoRef = useRef<StageGeometry | null>(geo);
  geoRef.current = geo;
  const proxyPath = proxy?.path ?? null;
  const src = useMemo(() => (proxyPath ? convertFileSrc(proxyPath) : null), [proxyPath]);
  const viewMode = useStage((s) => s.viewMode);
  // 序列在空白 / 停用片段上：元素暫停著、畫面由 canvas 塗黑（M2.11）
  const seqBlack = useSeqStage((s) => s.black);
  const hideVideo = viewMode === "stabilized" || viewMode === "difference" || seqBlack !== null;
  const [cursor, setCursor] = useState<CursorStyle>("default");
  // A0 增益預覽要把 <video> 接進 Web Audio（MediaElementSource）：跨來源的 asset:// 沒有 CORS 模式時那條路只會輸出靜音。
  // 只在實驗旗標開著時才設 crossOrigin —— 旗標關的使用者完全走 M1 的載入方式；asset protocol 失敗過就拿掉重掛（退回 element.volume）
  const seqFlag = useSettings((s) => s.experimental.sequence);
  const corsBroken = useAudioMonitor((s) => s.corsBroken);
  const corsMode = seqFlag && !corsBroken;

  const dragRef = useRef<DragState | null>(null);
  const objDragRef = useRef<ObjDrag | null>(null);
  const hoverRef = useRef<Pt | null>(null);
  const rafRef = useRef(0);
  const hashes = useHashMemo();

  // ---- 序列播放器與 Web Audio 預覽（M2.11 / M2.16）：旗標關或素材空間時兩者都不接手任何東西 ----
  useEffect(() => {
    const unAudio = installAudioPreview();
    const unSeq = installSequencePlayer({ beforePlay: audioBeforePlay });
    return () => {
      unSeq();
      unAudio();
    };
  }, []);

  useEffect(() => {
    audioPreview()?.attachVideo(video);
  }, [video]);

  // ---- playerRef 綁定：指令 / 時間軸透過它控制播放 ----
  useEffect(() => {
    if (!video) return;
    setPlayer(video, proxy ? { fps: proxy.fps, frames: proxy.frames } : null);
    return () => setPlayer(null, null);
  }, [video, proxy]);

  // 元素事件是「有沒有在播」的唯一真相；store 只是鏡射。
  // 例外：序列在空白上播的時候元素是暫停的，但序列在播（傳輸列要亮 ⏸、時間軸要跟隨）
  useEffect(() => {
    if (!video) return;
    const sync = () => usePlayback.getState().setPlaying(sequencePlaying() || (!video.paused && !video.ended));
    video.addEventListener("play", sync);
    video.addEventListener("pause", sync);
    video.addEventListener("ended", sync);
    sync();
    return () => {
      video.removeEventListener("play", sync);
      video.removeEventListener("pause", sync);
      video.removeEventListener("ended", sync);
    };
  }, [video]);

  // 一次性 seek 請求（時間軸 / 指令 → playback.seek）
  const seekReq = usePlayback((s) => s.seekReq);
  useEffect(() => {
    // 序列播放器在接點上換媒體時，Workspace 的「換片 → 播放線歸零」會送來一個 seek(0)：吞掉，不然剛 seek 到的 k 被拉回開頭
    if (seekReq && videoRef.current && !consumeSeekReq(seekReq)) void seekToFrame(seekReq.frame);
  }, [seekReq]);

  // 序列空間的 seek（playback.seekSeq）：換媒體 / 空白 / 停用由序列播放器處理；不在序列模式時它什麼都不做
  const seqSeekReq = usePlayback((s) => s.seqSeekReq);
  useEffect(() => {
    if (seqSeekReq) seekSequenceFrame(seqSeekReq.frame);
  }, [seqSeekReq]);

  // 字幕：引擎版面 + 圖集跟著編輯 / 播放線視窗更新（舞台掛著才需要）
  useEffect(() => installCaptionLayoutSync(), []);

  // J/K/L 轉盤
  const shuttle = usePlayback((s) => s.shuttle);
  useEffect(() => {
    applyShuttle(shuttle);
  }, [shuttle, video]);

  // ---- 繪圖 ----
  const draw = useCallback(() => {
    rafRef.current = 0;
    const cv = canvasRef.current;
    const g = geoRef.current;
    const v = videoRef.current;
    if (!cv || !g) return;
    const ctx = setupCanvas(cv, g.containerW, g.containerH, g.dpr);
    if (!ctx || g.rect.w <= 0) return;
    const pal = palette();
    const black = useSeqStage.getState().black;
    if (black) {
      drawSequenceBlack(ctx, g, t(BLACK_LABEL[black]), pal);
      return;
    }
    const st = useStage.getState();
    const tl = useTimeline.getState();
    const frame = usePlayback.getState().frame;
    const mediaId = useProject.getState().activeMediaId;
    const edits = useEdits.getState();
    const tracks = mediaId ? edits.tracks[mediaId] ?? NO_TRACKS : NO_TRACKS;
    const pluginMedia = mediaId ? edits.pluginMedia[mediaId] : undefined;
    const solves = useSolves.getState().byTrack;
    const masks = useMasks.getState();
    const selectedId = tracks.some((x) => x.id === tl.selectedTrackId) ? tl.selectedTrackId : tracks[0]?.id ?? null;
    const drag = dragRef.current;

    // 每條 track 在這一幀的表面（拖曳中的用 live）
    const samples: { track: TrackV1; sample: SurfaceSample | null }[] = tracks.map((track) => {
      let sample = surfaceAt(track, solves[track.id] ?? null, frame);
      if (drag && drag.kind !== "split" && drag.trackId === track.id && (drag.kind === "move" || drag.target === "surface") && sample) sample = { ...sample, quad: drag.live, state: "user" };
      return { track, sample };
    });
    const selected = samples.find((s) => s.track.id === selectedId) ?? null;

    // 穩定視圖：把選中表面釘回參考影格（螢幕空間仿射）
    let gd = g;
    let mode: ViewMode = st.viewMode;
    if (mode === "stabilized") {
      const ref = selected ? referenceSurface(selected.track, solves[selected.track.id] ?? null) : null;
      if (selected?.sample && ref && selected.sample.state !== "missing") gd = g.withAffine(stabilizeAffine(toScreenQuad(g, selected.sample.quad), toScreenQuad(g, ref)));
      if (v) drawVideoFrame(ctx, gd, v);
    }

    // 效果 / 替換預覽（選中的 track 有特效或替換）：有就取代合成預覽；正常模式下暫停時整張蓋上
    let hint: string | null = null;
    const fx = mediaId && mode !== "stabilized" ? fxStageState(mediaId, tracks, tl.selectedTrackId, frame, samples) : null;
    if (fx?.note) hint = t(fx.note.key, fx.note.params);
    if (fx?.active) {
      const fxMode: ViewMode = needsPreview(mode) ? mode : "replaced";
      if (fx.image || fxMode !== "replaced") drawPreviewLayer(ctx, gd, { mode: fxMode, video: v, image: fx.image, splitX: st.splitX, abFlicker: st.abFlicker, labels: { original: t("原片"), replaced: t("效果") } }, pal);
    }

    // 合成預覽
    if (!fx?.active && (needsPreview(mode) || st.abFlicker)) {
      let image: CanvasImageSource | null = null;
      if (mediaId) {
        const h = hashes(tracks, pluginMedia);
        const parts = { mediaId, frame, tracksHash: h.tracksHash, targetsHash: h.targetsHash, insertHash: h.insertHash };
        image = getPreview(previewKey(parts));
        if (!image) requestPreview(parts);
      }
      if (!image) hint = hasPreviewProvider() ? t("預覽產生中…") : t("預覽尚未就緒：合成器在 A4 里程碑接上");
      if (needsPreview(mode) || st.abFlicker) {
        drawPreviewLayer(ctx, gd, { mode, video: v, image, splitX: st.splitX, abFlicker: st.abFlicker, labels: { original: t("原片"), replaced: t("替換") } }, pal);
      }
      if (mode === "difference" && !image) mode = "difference";
    }

    // 字幕（feat/captions）：在合成預覽之上、追蹤疊層之下。穩定 / 差異檢視不畫 —— 前者座標被仿射釘住、後者要看的是像素差
    const cap = useCaptionsUi.getState();
    const media = mediaId ? useProject.getState().media.find((m) => m.id === mediaId) : null;
    if (cap.showOnStage && mediaId && media?.proxy && mode !== "stabilized" && mode !== "difference") {
      drawCaptionLayer(ctx, g, { mediaId, track: edits.captions[mediaId] ?? null, frame, fps: media.proxy.fps, selectedCueId: cap.selectedCueId, layout: useCaptionLayout.getState().layout }, pal);
    }

    const surfaceQuads = samples.filter((s) => s.sample && s.sample.state !== "missing").map((s) => s.sample!.quad);
    if (st.showTrackHud && st.darkenImage) drawDarken(ctx, gd, surfaceQuads);

    if (st.showMasks) {
      const items: MaskItem[] = samples.filter((s) => s.track.kind !== "object").map((s) => ({
        trackId: s.track.id,
        bitmap: masks.get(s.track.id, frame)?.bitmap ?? null,
        selected: s.track.id === selectedId,
        fallbackQuad: s.sample?.quad ?? null,
      }));
      drawMaskLayer(ctx, gd, { items }, pal);
    }

    // 物件 track（框＋名字；選中且暫停時疊這一幀的遮罩）與「選取物件」的預覽
    const objLayer = objectLayerState(mediaId, tracks, frame, tl.selectedTrackId, st.showMasks, objDragRef.current);
    if (objLayer) drawObjectLayer(ctx, gd, objLayer, pal);

    if (st.showTrackHud && selected && st.trailLength > 0) {
      const solve = solves[selected.track.id] ?? null;
      const trail: Pt[] = [];
      for (let k = frame - st.trailLength; k <= frame; k++) {
        const s = k === frame ? selected.sample : surfaceAt(selected.track, solve, k);
        if (s && s.state !== "missing") trail.push(quadCenter(s.quad));
      }
      drawTrackHudLayer(ctx, gd, { points: null, trails: [trail] }, pal);
    }

    if (selected) {
      const regionQuad = drag && drag.kind === "corner" && drag.target === "region" && drag.trackId === selected.track.id ? drag.live : selected.track.trackingRegion;
      drawTrackingRegionLayer(ctx, gd, { quad: regionQuad, editable: tl.tool === "select", activeCorner: drag && drag.kind === "corner" && drag.target === "region" ? drag.index : null }, pal);
    }

    if (st.showSurface) {
      const items: SurfaceItem[] = samples
        .filter((s) => s.sample)
        .map((s) => ({
          trackId: s.track.id,
          label: s.track.label,
          quad: s.sample!.quad,
          state: s.sample!.state,
          selected: s.track.id === selectedId,
          lockedCorners: s.sample!.keyframe?.lockedCorners,
          stale: s.track.stale,
        }));
      const ghost = drag && drag.kind !== "split" && (drag.kind === "move" || drag.target === "surface") && drag.moved ? drag.start : null;
      const activeCorner = drag && drag.kind === "corner" && drag.target === "surface" ? drag.index : null;
      drawSurfaceLayer(ctx, gd, { items, showGrid: st.showGrid, ghost, activeCorner }, pal);
    }

    // 畫面比例參考線：成品畫框，所以用基礎幾何（不套穩定視圖的仿射），也畫在追蹤疊層之上
    if (st.aspectGuide) drawAspectGuideLayer(ctx, g, { aspect: st.aspectGuide, srcW: g.srcW, srcH: g.srcH }, pal);

    // HUD 不套仿射（貼在玻璃上）
    let magnifier: MagnifierState | null = null;
    if (drag && drag.kind === "corner" && v && hoverRef.current) {
      magnifier = { video: v, centerProxy: g.toProxy(drag.live.p[drag.index]), cursor: hoverRef.current, proxyW: g.proxyW, proxyH: g.proxyH };
    }
    const objTool = tl.tool === "objSelect";
    const session = useSelection.getState().session;
    const prompts = objTool ? (session && session.mediaId === mediaId && session.frame === frame ? session.points : []) : selected?.track.prompts.find((p) => p.frame === frame)?.points ?? [];
    const maskTool = tl.tool === "maskPos" || tl.tool === "maskNeg" || objTool;
    drawHudLayer(
      ctx,
      g,
      {
        prompts,
        cursor: hoverRef.current,
        crosshair: maskTool && !drag,
        magnifier,
        badge: st.viewMode === "normal" ? null : t(VIEW_MODE_LABEL[st.viewMode]),
        hint,
      },
      pal,
    );
  }, [t, hashes]);

  const schedule = useCallback(() => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(draw);
  }, [draw]);

  // 每呈現一幀：序列播放器換算 seqFrame（不在序列模式時立刻 return），再重畫疊層
  const onFrame = useCallback(
    (f: number, md: VideoFrameCallbackMetadata | null) => {
      onPresentedFrame(f, md);
      schedule();
    },
    [schedule],
  );
  useRvfc(video, proxy?.fps ?? null, onFrame);

  useEffect(() => {
    schedule();
    const offs = [
      useSeqStage.subscribe(schedule),
      useEdits.subscribe(schedule),
      useSolves.subscribe(schedule),
      useMasks.subscribe(schedule),
      useTimeline.subscribe(schedule),
      useStage.subscribe(schedule),
      usePreviews.subscribe(schedule),
      useCaptionsUi.subscribe(schedule),
      useCaptionLayout.subscribe(schedule),
      useObjectMeta.subscribe(schedule),
      useSelection.subscribe(schedule),
      useObjectsUi.subscribe(schedule),
      useFxPreview.subscribe(schedule),
      usePlayback.subscribe(schedule),
      useProject.subscribe(schedule),
    ];
    return () => {
      offs.forEach((f) => f());
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [schedule, geo]);

  // ---- pointer ----
  const localPt = (e: React.PointerEvent): Pt => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  /** 目前這一幀、每條 track 的螢幕四邊形（命中測試用）。 */
  const screenItems = (g: StageGeometry) => {
    const tl = useTimeline.getState();
    const frame = usePlayback.getState().frame;
    const mediaId = useProject.getState().activeMediaId;
    const tracks = mediaId ? useEdits.getState().tracks[mediaId] ?? NO_TRACKS : NO_TRACKS;
    const solves = useSolves.getState().byTrack;
    const selectedId = tracks.some((x) => x.id === tl.selectedTrackId) ? tl.selectedTrackId : tracks[0]?.id ?? null;
    const items = tracks
      .map((track) => ({ track, sample: surfaceAt(track, solves[track.id] ?? null, frame) }))
      .filter((x): x is { track: TrackV1; sample: SurfaceSample } => !!x.sample);
    return { items, selectedId, quads: items.map((it) => ({ quad: toScreenQuad(g, it.sample.quad), selected: it.track.id === selectedId })), frame, mediaId, tl };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const g = geoRef.current;
    if (!g) return;
    const pt = localPt(e);
    hoverRef.current = pt;
    const st = useStage.getState();
    if (st.viewMode === "split" && Math.abs(pt[0] - splitScreenX(g, st.splitX)) <= SPLIT_HANDLE_PX + 4) {
      dragRef.current = { kind: "split" };
      e.currentTarget.setPointerCapture(e.pointerId);
      setCursor("col-resize");
      return;
    }
    const { items, selectedId, quads, frame, mediaId, tl } = screenItems(g);
    if (!mediaId) return;

    if (tl.tool === "objSelect") {
      const v = clampSrc(g, g.toVideo(pt));
      objDragRef.current = { startScreen: pt, startSrc: v, curSrc: v, alt: e.altKey, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
      schedule();
      return;
    }
    if (tl.tool === "maskPos" || tl.tool === "maskNeg") {
      const sel = items.find((it) => it.track.id === selectedId);
      if (!sel) return;
      const [x, y] = g.toVideo(pt);
      useEdits.getState().addPrompt(mediaId, sel.track.id, frame, [{ x, y, label: tl.tool === "maskPos" ? 1 : 0 }]);
      schedule();
      return;
    }
    if (tl.tool === "shotCut") return;

    // 追蹤區域的把手（只有選中 track、select 工具）優先於表面
    const sel = items.find((it) => it.track.id === selectedId);
    if (sel && sel.track.trackingRegion && tl.tool === "select") {
      const h = hitQuad(pt, toScreenQuad(g, sel.track.trackingRegion));
      if (h && h.kind === "corner") {
        dragRef.current = { kind: "corner", trackId: sel.track.id, target: "region", index: h.index, start: sel.track.trackingRegion, live: sel.track.trackingRegion, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
        schedule();
        return;
      }
    }

    const picked = pickQuad(pt, quads);
    if (!picked) {
      // 沒點到平面表面：點在物件的外接框裡就選那個物件（框是這一幀的錨點）
      const obj = objectAt(mediaId, frame, g.toVideo(pt));
      if (obj) {
        tl.selectTrack(obj);
        schedule();
      }
      return;
    }
    const it = items[picked.index];
    if (it.track.id !== selectedId) {
      tl.selectTrack(it.track.id);
      // 第一下先選中；corner 工具下才順便開始拖
      if (tl.tool !== "corner") {
        schedule();
        return;
      }
    }
    if (picked.hit.kind === "corner") {
      dragRef.current = { kind: "corner", trackId: it.track.id, target: "surface", index: picked.hit.index, start: it.sample.quad, live: it.sample.quad, moved: false };
    } else {
      dragRef.current = { kind: "move", trackId: it.track.id, start: it.sample.quad, live: it.sample.quad, startSrc: g.toVideo(pt), moved: false };
      setCursor("grabbing");
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    schedule();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = geoRef.current;
    if (!g) return;
    const pt = localPt(e);
    hoverRef.current = pt;
    const od = objDragRef.current;
    if (od) {
      od.curSrc = clampSrc(g, g.toVideo(pt));
      od.moved = od.moved || Math.hypot(pt[0] - od.startScreen[0], pt[1] - od.startScreen[1]) >= DRAG_BOX_MIN_PX;
      schedule();
      return;
    }
    const d = dragRef.current;
    if (d) {
      if (d.kind === "split") {
        useStage.getState().setSplitX((pt[0] - g.rect.x) / g.rect.w);
      } else if (d.kind === "corner") {
        d.live = moveCorner(d.start, d.index, g.toVideo(pt));
        d.moved = true;
      } else {
        const cur = g.toVideo(pt);
        d.live = translateQuad(d.start, cur[0] - d.startSrc[0], cur[1] - d.startSrc[1]);
        d.moved = true;
      }
      schedule();
      return;
    }
    // 游標樣式
    const st = useStage.getState();
    const tl = useTimeline.getState();
    let c: CursorStyle = "default";
    if (st.viewMode === "split" && Math.abs(pt[0] - splitScreenX(g, st.splitX)) <= SPLIT_HANDLE_PX + 4) c = "col-resize";
    else if (tl.tool === "maskPos" || tl.tool === "maskNeg" || tl.tool === "objSelect") c = "crosshair";
    else if (tl.tool === "select" || tl.tool === "corner") {
      const { quads } = screenItems(g);
      const picked = pickQuad(pt, quads);
      if (picked) c = picked.hit.kind === "corner" ? "crosshair" : picked.hit.kind === "inside" || picked.hit.kind === "edge" ? "grab" : "pointer";
    }
    setCursor((prev) => (prev === c ? prev : c));
    schedule();
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>, commit: boolean) => {
    const od = objDragRef.current;
    if (od) {
      objDragRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      const mediaId = useProject.getState().activeMediaId;
      if (commit && mediaId) commitObjDrag(mediaId, usePlayback.getState().frame, od);
      schedule();
      return;
    }
    const d = dragRef.current;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d && d.kind !== "split" && d.moved && commit) {
      const mediaId = useProject.getState().activeMediaId;
      const frame = usePlayback.getState().frame;
      if (mediaId) {
        if (d.kind === "corner" && d.target === "region") useEdits.getState().setTrackingRegion(mediaId, d.trackId, d.live);
        else useEdits.getState().setUserKeyframe(mediaId, d.trackId, frame, d.live);
      }
    }
    setCursor("default");
    schedule();
  };

  const onPointerLeave = () => {
    hoverRef.current = null;
    schedule();
  };

  return (
    <div ref={containerRef} className="relative w-full h-full min-h-0 bg-well overflow-hidden select-none" data-testid="video-stage">
      {src ? (
        <video
          // crossOrigin 只在載入時生效：模式一變就換一個新元素（setPlayer 會當成換元素重新綁定）
          key={corsMode ? "cors" : "plain"}
          ref={setVideo}
          src={src}
          crossOrigin={corsMode ? "anonymous" : undefined}
          onError={(e) => {
            // CORS 模式下 asset protocol 沒回允許標頭 → 整支影片載不進來；這個 session 改回一般模式重掛（A0 預覽退回 element.volume）
            if (corsMode && e.currentTarget.error) useAudioMonitor.setState({ corsBroken: true });
          }}
          className="absolute inset-0 w-full h-full object-contain"
          style={{ visibility: hideVideo ? "hidden" : "visible" }}
          preload="auto"
          playsInline
          disablePictureInPicture
          controls={false}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <EmptyState icon={Film} title={media ? t("proxy 還沒產生，播放器等它好了才會出現") : t("開一支影片開始")} hint={media ? t("引擎就緒後會自動產生 proxy；進度在「工作」分頁。") : undefined} compact />
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ cursor, touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e, true)}
        onPointerCancel={(e) => endDrag(e, false)}
        onPointerLeave={onPointerLeave}
        onContextMenu={(e) => {
          e.preventDefault();
          // 拖角拖到一半按右鍵不開選單；命中與左鍵同一套（pickQuad），落在表面上就以那條 track 為對象
          const g = geoRef.current;
          if (!g || dragRef.current) return;
          const r = e.currentTarget.getBoundingClientRect();
          const { items, quads } = screenItems(g);
          const at: Pt = [e.clientX - r.left, e.clientY - r.top];
          const picked = pickQuad(at, quads);
          const mid = useProject.getState().activeMediaId;
          openStageContextMenu(e, picked ? items[picked.index].track.id : mid ? objectAt(mid, usePlayback.getState().frame, g.toVideo(at)) : null);
          schedule();
        }}
        aria-label={t("影片舞台")}
      />
    </div>
  );
}
