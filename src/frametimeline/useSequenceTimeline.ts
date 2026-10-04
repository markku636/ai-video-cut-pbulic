// FrameTimeline 的序列空間接線（docs/editor-m2-design.md §9）：把 project / edits / timeline / playback / peaks 攤成
// drawSequence.ts 與 hitSequence.ts 要的純資料。FrameTimeline 只在「現在是序列空間」時呼叫這裡，素材空間（M1）一行都不經過。
//
// 為什麼獨立成檔：FrameTimeline.tsx 本身已經是 M1 的手勢中心，序列空間的資料組裝（多媒體縮圖、峰值、徽章、跨媒體 track）
// 塞進去會讓兩個空間的程式交錯在同一個 500 行的元件裡；拆出來之後 M2.11～M2.15 改序列行為也不必碰 M1 的手勢。
import { useEffect, useMemo } from "react";
import { ensurePeaks, peaksOf, peaksSourceOfAudioMedia, peaksSourceOfMedia, usePeaks } from "../pipeline/peaks";
import type { AudioSourceRefV2, SequenceV2 } from "../project/format";
import { durationFrames, isUntouched, mapFrame, placeVideo, type PlacedItem } from "../sequence/map";
import { useEdits } from "../store/edits";
import { usePlayback } from "../store/playback";
import { useProject, type MediaItem } from "../store/project";
import { useSettings } from "../store/settings";
import { useSolves } from "../store/solves";
import { effectiveSpace, useTimeline } from "../store/timeline";
import { ROW } from "./draw";
import type { SeqAudioSourceView, SeqDrawLabels, SeqDrawState, SeqMediaView, SeqTrackLane } from "./drawSequence";
import type { SeqHitTrack } from "./hitSequence";
import { layoutSequenceRows, sequencePlayhead, usedSourceRanges, viewSequenceOf, type SeqTrackRef, type SeqView, type SequenceLayout } from "./layoutSequence";
import { badgeCount, clipThumbSlots, visibleItemSpans, type BadgeTrack } from "./seqGeometry";
import { trackHasTarget } from "../plugins/queries";
import type { TrackHeaderTrack } from "./TrackHeaders";
import { useSequenceView } from "./TrackHeaders";
import { ensureThumbTiles, getThumbTile, normalizeFingerprint } from "./useThumbStrip";

export interface SequenceTimeline {
  /** 實驗旗標開著（分段控制要不要出現）。 */
  enabled: boolean;
  /** 現在畫序列空間（旗標開、選了序列、而且有東西可畫）。 */
  active: boolean;
  /** 畫的序列（隱含序列 = 作用中媒體整段）；active 為 false 時可能是 null。 */
  seq: SequenceV2 | null;
  /** edits.sequence 是 null（還沒剪過）。 */
  implicit: boolean;
  /** 已剪輯（isUntouched 不成立）：分段控制上的小點，讓「輸出會重新混音」看得到（§14.4）。 */
  edited: boolean;
  placed: readonly PlacedItem[];
  frames: number;
  layout: SequenceLayout | null;
  trackRefs: readonly SeqTrackRef[];
  headerTracks: readonly TrackHeaderTrack[];
  /** 素材空間的「已用於序列」k 範圍（只有實體序列才有：隱含序列整段都用到，畫一整條橘線只是雜訊）。 */
  usedRanges: readonly [number, number][];
}

const NO_PLACED: readonly PlacedItem[] = [];
const NO_RANGES: readonly [number, number][] = [];

/** V1 用到的媒體 id（依第一次出現的順序：追蹤群組的車道順序跟片段順序一致）。 */
export function sequenceMediaIds(seq: Pick<SequenceV2, "video"> | null): string[] {
  const out: string[] = [];
  for (const it of seq?.video ?? []) if (it.kind === "clip" && !out.includes(it.mediaId)) out.push(it.mediaId);
  return out;
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

export function useSequenceTimeline(): SequenceTimeline {
  const enabled = useSettings((s) => s.experimental.sequence);
  const space = useTimeline((s) => s.space);
  const selectedTrackId = useTimeline((s) => s.selectedTrackId);
  const stored = useEdits((s) => s.sequence);
  const tracksByMedia = useEdits((s) => s.tracks);
  const media = useProject((s) => s.media);
  const activeId = useProject((s) => s.activeMediaId);
  const tracksCollapsed = useSequenceView((s) => s.tracksCollapsed);
  const laneHeights = useSequenceView((s) => s.laneHeights);

  const activeMedia = useMemo(() => media.find((m) => m.id === activeId) ?? null, [media, activeId]);
  const seq = useMemo(() => (enabled ? viewSequenceOf(stored, activeMedia) : null), [enabled, stored, activeMedia]);
  const active = !!seq && effectiveSpace(space, enabled) === "sequence";
  const placed = useMemo(() => (seq ? placeVideo(seq) : NO_PLACED), [seq]);
  const frames = useMemo(() => (seq ? durationFrames(seq) : 0), [seq]);

  const mediaIds = useMemo(() => sequenceMediaIds(seq), [seq]);
  const trackRefs = useMemo<SeqTrackRef[]>(() => (active ? mediaIds.flatMap((mid) => (tracksByMedia[mid] ?? []).map((tr) => ({ id: tr.id, mediaId: mid }))) : []), [active, mediaIds, tracksByMedia]);
  const headerTracks = useMemo<TrackHeaderTrack[]>(() => {
    if (!active) return [];
    const multi = mediaIds.length > 1;
    const all = mediaIds.flatMap((mid) => (tracksByMedia[mid] ?? []).map((tr) => ({ tr, mid })));
    const selected = all.some((x) => x.tr.id === selectedTrackId) ? selectedTrackId : all[0]?.tr.id ?? null;
    // 只有一支媒體時不加媒體名：「clip1 · Player1」在 132 px 的標頭裡只剩前半段，而且每一條都一樣
    return all.map(({ tr, mid }) => ({ id: tr.id, label: multi ? `${stripExt(media.find((m) => m.id === mid)?.name ?? mid)} · ${tr.label}` : tr.label, selected: tr.id === selected }));
  }, [active, mediaIds, tracksByMedia, selectedTrackId, media]);
  const layout = useMemo(() => (active && seq ? layoutSequenceRows(seq, trackRefs, laneHeights, { tracksCollapsed }) : null), [active, seq, trackRefs, laneHeights, tracksCollapsed]);

  const edited = useMemo(() => !isUntouched(stored, (id) => media.find((m) => m.id === id)?.proxy?.frames ?? null), [stored, media]);
  const usedRanges = useMemo(() => (enabled && stored && activeId ? usedSourceRanges(stored, activeId) : NO_RANGES), [enabled, stored, activeId]);

  // 波形峰值：序列用到的每個來源各算一次（Rust 有磁碟快取；ensurePeaks 自己去重）。
  // 依「來源集合」的字串當依賴，不依序列物件：拖推桿時序列每一步都換物件，不能每一步都去叫一次（失敗的來源會一直冒工作列）
  const audioMedia = useEdits((s) => s.audioMedia);
  const peakSources = useMemo(() => {
    if (!active || !seq) return [];
    const out = mediaIds.flatMap((mid) => {
      const m = media.find((x) => x.id === mid);
      return m ? [peaksSourceOfMedia(m)] : [];
    });
    for (const lane of seq.audioLanes) {
      for (const c of lane.clips) {
        if (c.source.type === "media") {
          const id = c.source.mediaId;
          const m = media.find((x) => x.id === id);
          if (m) out.push(peaksSourceOfMedia(m));
        } else {
          const id = c.source.audioId;
          const am = audioMedia.find((x) => x.id === id);
          if (am) out.push(peaksSourceOfAudioMedia(am));
        }
      }
    }
    return out;
  }, [active, seq, mediaIds, media, audioMedia]);
  const peakKey = [...new Set(peakSources.map((p) => `${p.fingerprint}|${p.hasAudio ? 1 : 0}`))].sort().join(",");
  useEffect(() => {
    const seen = new Set<string>();
    for (const src of peakSources) {
      if (seen.has(src.fingerprint)) continue;
      seen.add(src.fingerprint);
      // 失敗 / 取消已經寫進工作清單了，這裡只是不要變成 unhandled rejection
      ensurePeaks(src).catch(() => {});
    }
    // peakSources 每次序列變動都換陣列；只在來源集合真的變了才重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peakKey]);

  return {
    enabled,
    active,
    seq,
    implicit: stored === null,
    edited,
    placed,
    frames,
    layout,
    trackRefs,
    headerTracks,
    usedRanges,
  };
}

// ---- 非 hook：draw() / pointer handler 當下讀 store ----

/** playback.seqFrame（M2.11 的序列播放器才會寫）；還沒有這個欄位時 null。用字串讀是為了不在型別上依賴還沒落地的欄位。 */
function playbackSeqFrame(): number | null {
  const v = (usePlayback.getState() as unknown as Record<string, unknown>).seqFrame;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 序列空間現在的播放線（序列幀）；目前的來源幀沒用在序列裡 → null。 */
export function sequencePlayheadNow(st: Pick<SequenceTimeline, "seq" | "placed">): number | null {
  if (!st.seq) return null;
  return sequencePlayhead(st.seq, useProject.getState().activeMediaId, usePlayback.getState().frame, playbackSeqFrame(), st.placed);
}

/**
 * 序列空間的 seek（尺規 scrub、點菱形）。M2.11 的序列播放器會接手（換媒體、空白前進）；在那之前的退路：
 * t 落在作用中媒體的片段上 → seek 到對應的 k（停用片段也可以看它的畫面）；落在空白或別支媒體 → 不動。
 * 為什麼不切 activeMediaId：Workspace 換媒體時會把播放線歸零、清範圍，退路會變成「點一下就跳回開頭」。
 */
export function seekSequence(st: Pick<SequenceTimeline, "seq" | "placed" | "frames">, t: number): void {
  if (!st.seq) return;
  const tt = Math.max(0, Math.min(Math.max(0, st.frames - 1), Math.round(t)));
  const m = mapFrame(st.seq, tt, st.placed);
  if (m.item?.kind === "clip" && m.itemK !== null && m.item.mediaId === useProject.getState().activeMediaId) usePlayback.getState().seek(m.itemK);
}

function mediaViewOf(m: MediaItem | undefined, id: string): SeqMediaView {
  if (!m) return { name: id, frames: null, missing: true, tileAt: null, peaks: null, videoStartUs: 0 };
  const fp = normalizeFingerprint(m.fingerprint) ?? normalizeFingerprint(m.id);
  return {
    name: m.name,
    frames: m.proxy?.frames ?? null,
    tileAt: fp && m.proxy ? (start) => getThumbTile(fp, start, ROW.thumbs) : null,
    peaks: peaksOf(m.fingerprint),
    videoStartUs: m.audio?.videoStartUs ?? 0,
  };
}

export interface SeqDrawExtras {
  width: number;
  scrollFrame: number;
  pxPerFrame: number;
  hoverFrame: number | null;
  hoverClipId: string | null;
  rangeHover: SeqDrawState["rangeHover"];
  rangeDragging: boolean;
  rangeLabels: readonly string[];
  rangeEmptyHint: string | null;
  rangeHoverEmpty: boolean;
  snapFrame: number | null;
  thumbW: number;
  labels: SeqDrawLabels;
}

/**
 * 這一幀要畫的 SeqDrawState（在 draw() 裡呼叫；讀 store 的當下值，不經 React state）。
 * 同一次呼叫內的媒體 / 音訊來源查詢有快取：200 個片段引用同一支媒體時只組一次檢視。
 */
export function buildSeqDrawState(st: SequenceTimeline, x: SeqDrawExtras): SeqDrawState | null {
  const { seq, layout } = st;
  if (!seq || !layout) return null;
  const project = useProject.getState();
  const edits = useEdits.getState();
  const tl = useTimeline.getState();
  const pb = usePlayback.getState();
  const solves = useSolves.getState().byTrack;

  const mediaCache = new Map<string, SeqMediaView>();
  const media = (id: string) => {
    let v = mediaCache.get(id);
    if (!v) {
      v = mediaViewOf(
        project.media.find((m) => m.id === id),
        id,
      );
      mediaCache.set(id, v);
    }
    return v;
  };
  const audioSource = (ref: AudioSourceRefV2): SeqAudioSourceView | undefined => {
    if (ref.type === "media") {
      const id = ref.mediaId;
      const m = project.media.find((mm) => mm.id === id);
      if (!m) return undefined;
      return { name: m.name, peaks: peaksOf(m.fingerprint), startUs: m.audio?.startUs ?? 0, sampleRate: m.audio?.sampleRate ?? 48000 };
    }
    const id = ref.audioId;
    const am = edits.audioMedia.find((a) => a.id === id);
    if (!am) return undefined;
    return { name: am.name, peaks: peaksOf(am.fingerprint), startUs: am.audio?.startUs ?? 0, sampleRate: am.audio?.sampleRate ?? 48000 };
  };

  const badgeTracks: BadgeTrack[] = [];
  const lanes: SeqTrackLane[] = [];
  const selectedId = st.trackRefs.some((r) => r.id === tl.selectedTrackId) ? tl.selectedTrackId : st.trackRefs[0]?.id ?? null;
  for (const mid of sequenceMediaIds(seq)) {
    const shots = edits.shots[mid] ?? [];
    const pluginMedia = edits.pluginMedia[mid];
    const frames = project.media.find((m) => m.id === mid)?.proxy?.frames ?? Number.MAX_SAFE_INTEGER;
    for (const tr of edits.tracks[mid] ?? []) {
      const shot = shots.find((s) => s.id === tr.shotId);
      const range: [number, number] = shot ? [shot.startFrame, shot.endFrame] : [0, frames];
      // 有替換目標的 track（外掛說的，例如 cards：連結的格位指定了要換成哪張牌）才算進片段徽章
      badgeTracks.push({ mediaId: mid, range, hasTarget: trackHasTarget(pluginMedia, tr) });
      lanes.push({
        id: tr.id,
        mediaId: mid,
        label: tr.label,
        selected: tr.id === selectedId,
        stale: tr.stale,
        keyframes: tr.keyframes.map((k) => ({ frame: k.frame, source: k.source, locked: !!k.lockedCorners?.some(Boolean) })),
        referenceFrame: tr.referenceFrame,
        solve: solves[tr.id]?.frames ?? null,
        shotRange: shot ? [shot.startFrame, shot.endFrame] : null,
      });
    }
  }

  return {
    width: x.width,
    scrollFrame: x.scrollFrame,
    pxPerFrame: x.pxPerFrame,
    seq,
    placed: st.placed,
    frames: st.frames,
    currentFrame: sequencePlayheadNow(st),
    range: tl.range,
    pendingIn: tl.pendingIn,
    pendingOut: tl.pendingOut,
    loop: pb.loop,
    hoverFrame: x.hoverFrame,
    rangeHover: x.rangeHover,
    rangeDragging: x.rangeDragging,
    rangeLabels: x.rangeLabels,
    rangeEmptyHint: x.rangeEmptyHint,
    rangeHoverEmpty: x.rangeHoverEmpty,
    snapFrame: x.snapFrame,
    media,
    audioSource,
    badgeOf: (clip) => badgeCount(clip, badgeTracks),
    tracks: lanes,
    selectedKeyframe: tl.selectedKeyframe,
    hoverClipId: x.hoverClipId,
    thumbW: x.thumbW,
    labels: x.labels,
    layout,
  };
}

/** 命中測試要的 track 資料（跨媒體）。 */
export function seqHitTracksNow(st: Pick<SequenceTimeline, "seq">): SeqHitTrack[] {
  const edits = useEdits.getState();
  return sequenceMediaIds(st.seq).flatMap((mid) => (edits.tracks[mid] ?? []).map((tr) => ({ id: tr.id, mediaId: mid, keyframes: tr.keyframes.map((k) => k.frame), referenceFrame: tr.referenceFrame })));
}

/**
 * 可視範圍內每個片段要的縮圖 tile（跨媒體、依片段的 k；只抓畫得到的）。每次重畫都可以叫：
 * ensureThumbTiles 對已有 / 在飛 / 退避中的格子是幾個 Set 查詢。
 */
export function ensureSequenceThumbs(st: Pick<SequenceTimeline, "placed">, view: SeqView, width: number, thumbW: number): void {
  const want = new Map<string, number[]>();
  for (const sp of visibleItemSpans(st.placed, view, width)) {
    if (sp.item.kind !== "clip") continue;
    const ks = clipThumbSlots(sp, sp.item.srcIn, view, width, thumbW).map((s) => s.k);
    const cur = want.get(sp.item.mediaId);
    if (cur) cur.push(...ks);
    else want.set(sp.item.mediaId, ks);
  }
  const media = useProject.getState().media;
  for (const [mid, ks] of want) {
    const m = media.find((x) => x.id === mid);
    if (m?.proxy && ks.length) ensureThumbTiles(normalizeFingerprint(m.fingerprint) ?? m.id, m.proxy, ks, ROW.thumbs);
  }
}

/** 波形峰值載入完成時要重畫（FrameTimeline 訂閱用）。 */
export const subscribePeaks = (f: () => void) => usePeaks.subscribe(f);
