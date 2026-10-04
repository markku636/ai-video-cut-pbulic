import { create } from "zustand";
import type { AspectGuide } from "./aspectGuide";

/**
 * 舞台檢視模式與圖層開關（計畫 §9 VideoStage）。不持久化、不進專案檔：這是「現在想看什麼」，
 * 開檔時永遠從正常模式開始，才不會有人昨天切到差異模式、今天開檔看到一片黑以為壞了。
 *
 * normal 正常 / stabilized 穩定視圖 / replaced 替換 / split 並排 / difference 差異 ＝ Fusion Operation Mode 的對應。
 */
export type ViewMode = "normal" | "stabilized" | "replaced" | "split" | "difference";

export const VIEW_MODES: readonly ViewMode[] = ["normal", "stabilized", "replaced", "split", "difference"];

/** 熱鍵 1–5。 */
export function viewModeForHotkey(key: string): ViewMode | null {
  const i = Number.parseInt(key, 10);
  if (!Number.isInteger(i) || i < 1 || i > VIEW_MODES.length) return null;
  return VIEW_MODES[i - 1];
}

export function isViewMode(v: unknown): v is ViewMode {
  return typeof v === "string" && (VIEW_MODES as readonly string[]).includes(v);
}

/** 這些模式要有 comp.preview 的合成圖才有東西可畫。 */
export function needsPreview(mode: ViewMode): boolean {
  return mode === "replaced" || mode === "split" || mode === "difference";
}

/** 穩定視圖要有選中的 track（把誰釘住）。 */
export function needsSelectedTrack(mode: ViewMode): boolean {
  return mode === "stabilized";
}

/** TrackPanel 的模式：track 追蹤（拖角 = 硬釘）/ adjust 調整追蹤（參考點微調）。 */
export type TrackMode = "track" | "adjust";

interface StageStore {
  viewMode: ViewMode;
  /** 並排推桿位置 0–1（內容矩形的比例）。 */
  splitX: number;
  /** A/B 閃爍（按住 `\`）：true 時整張顯示替換結果。 */
  abFlicker: boolean;
  showMasks: boolean;
  showSurface: boolean;
  showGrid: boolean;
  showTrackHud: boolean;
  darkenImage: boolean;
  /** 軌跡長度（幀）；0 = 不畫。 */
  trailLength: number;
  /** 畫面比例參考線（構圖用，框外壓暗）；null = 不畫。 */
  aspectGuide: AspectGuide | null;
  trackMode: TrackMode;
  setViewMode: (m: ViewMode) => void;
  setSplitX: (x: number) => void;
  setAbFlicker: (v: boolean) => void;
  toggle: (key: "showMasks" | "showSurface" | "showGrid" | "showTrackHud" | "darkenImage") => void;
  setTrailLength: (n: number) => void;
  setAspectGuide: (a: AspectGuide | null) => void;
  setTrackMode: (m: TrackMode) => void;
}

export const useStage = create<StageStore>((set) => ({
  viewMode: "normal",
  splitX: 0.5,
  abFlicker: false,
  showMasks: true,
  showSurface: true,
  showGrid: true,
  showTrackHud: false,
  darkenImage: false,
  trailLength: 12,
  aspectGuide: null,
  trackMode: "track",
  setViewMode: (viewMode) => set({ viewMode }),
  setSplitX: (x) => set({ splitX: Math.max(0.02, Math.min(0.98, x)) }),
  setAbFlicker: (abFlicker) => set((s) => (s.abFlicker === abFlicker ? s : { abFlicker })),
  toggle: (key) => set((s) => ({ [key]: !s[key] }) as Partial<StageStore>),
  setTrailLength: (n) => set({ trailLength: Math.max(0, Math.min(120, Math.round(n))) }),
  setAspectGuide: (aspectGuide) => set({ aspectGuide }),
  setTrackMode: (trackMode) => set({ trackMode }),
}));
