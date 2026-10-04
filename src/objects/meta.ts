import { create } from "zustand";
import { api, decodeJson } from "../api";
import { parseVisibleRanges, type AdoptResult } from "./adopt";

/**
 * 物件 track 的衍生資訊（**不進 undo、不進專案檔**；可重生）：可見區段與逐幀外接框 / 重心。
 *
 * 來源：`<媒體快取>/tracks/<id>/anchors.v1.json`（引擎 ObjectTrack.open / objects.adopt 寫的錨點快取，
 * docs/tracking-api.md §4）。讀一次就留著；objects.adopt 重寫遮罩之後 invalidate。
 * 讀不到（舊版引擎、快取被清）→ 只有 adopt 當下回的 bestFrame / box，舞台退回只在最佳幀畫框。
 *
 * 為什麼舞台用錨點畫框而不是逐幀解遮罩：錨點是一份 JSON（每幀幾個數字），播放時每幀查表就好；
 * 逐幀解 RLE 一幀 1280×720 要掃一百萬個像素。遮罩只在暫停時、對選中的那一個物件才解（見 objects/maskFrame.ts）。
 */
export interface AnchorFrame {
  bbox: [number, number, number, number];
  centroid: [number, number];
}

export interface ObjectMeta {
  /** 含頭含尾。 */
  visibleRanges: [number, number][];
  /** 只有 visible 的幀；平滑過的框（smooth.bbox）優先，沒有就原值。 */
  frames: Map<number, AnchorFrame>;
  bestFrame: number | null;
  /** 遮罩尺寸 [W, H]（來源像素）；null = 不知道。 */
  size: [number, number] | null;
  /** "anchors" = 讀到完整錨點；"adopt" = 只有 adopt 回的摘要。 */
  from: "anchors" | "adopt";
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const quad4 = (v: unknown): [number, number, number, number] | null => (Array.isArray(v) && v.length === 4 && v.every(isNum) ? (v as [number, number, number, number]) : null);
const pair = (v: unknown): [number, number] | null => (Array.isArray(v) && v.length === 2 && v.every(isNum) ? (v as [number, number]) : null);

/** anchors.v1.json → ObjectMeta（防禦式：壞的幀略過）。 */
export function parseAnchors(raw: unknown): ObjectMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.format !== "aivc.anchors.v1") return null;
  const frames = new Map<number, AnchorFrame>();
  let best: number | null = null;
  let bestArea = -1;
  for (const f of Array.isArray(o.frames) ? o.frames : []) {
    if (!f || typeof f !== "object") continue;
    const x = f as Record<string, unknown>;
    if (x.visible !== true || !Number.isInteger(x.k)) continue;
    const sm = (x.smooth && typeof x.smooth === "object" ? x.smooth : {}) as Record<string, unknown>;
    const bbox = quad4(sm.bbox) ?? quad4(x.bbox);
    const c = pair(sm.centroid) ?? pair(x.centroid);
    if (!bbox) continue;
    frames.set(x.k as number, { bbox, centroid: c ?? [bbox[0] + bbox[2] / 2, bbox[1] + bbox[3] / 2] });
    const area = isNum(x.area) ? x.area : bbox[2] * bbox[3];
    if (area > bestArea) {
      bestArea = area;
      best = x.k as number;
    }
  }
  return { visibleRanges: parseVisibleRanges(o.visibleRanges), frames, bestFrame: best, size: pair(o.size), from: "anchors" };
}

/** 只有 adopt 的摘要時：最佳幀那一格的框。 */
export function metaFromAdopt(a: AdoptResult): ObjectMeta {
  const frames = new Map<number, AnchorFrame>();
  if (a.bestFrame != null && a.box) frames.set(a.bestFrame, { bbox: a.box, centroid: [a.box[0] + a.box[2] / 2, a.box[1] + a.box[3] / 2] });
  return { visibleRanges: a.visibleRanges, frames, bestFrame: a.bestFrame, size: null, from: "adopt" };
}

/** frame 在不在可見區段裡（含頭含尾）。 */
export function visibleAt(meta: Pick<ObjectMeta, "visibleRanges">, frame: number): boolean {
  return meta.visibleRanges.some(([a, b]) => frame >= a && frame <= b);
}

interface MetaStore {
  byTrack: Record<string, ObjectMeta | null>;
  /** 正在讀的（不重複送）。 */
  loading: Record<string, true>;
  put: (trackId: string, meta: ObjectMeta | null) => void;
  invalidate: (trackId: string) => void;
  clear: () => void;
}

export const useObjectMeta = create<MetaStore>((set) => ({
  byTrack: {},
  loading: {},
  put: (trackId, meta) =>
    set((s) => {
      const loading = { ...s.loading };
      delete loading[trackId];
      return { byTrack: { ...s.byTrack, [trackId]: meta }, loading };
    }),
  invalidate: (trackId) =>
    set((s) => {
      if (!(trackId in s.byTrack)) return s;
      const byTrack = { ...s.byTrack };
      delete byTrack[trackId];
      return { byTrack };
    }),
  clear: () => set({ byTrack: {}, loading: {} }),
}));

/** 讀錨點（有就不重讀）。讀不到 → 記 null（不一直重試；adopt 之後 invalidate 才會再讀）。 */
export async function ensureObjectMeta(mediaId: string, trackId: string): Promise<ObjectMeta | null> {
  const st = useObjectMeta.getState();
  if (trackId in st.byTrack) return st.byTrack[trackId];
  if (st.loading[trackId]) return null;
  useObjectMeta.setState((s) => ({ loading: { ...s.loading, [trackId]: true } }));
  let meta: ObjectMeta | null = null;
  try {
    meta = parseAnchors(decodeJson(await api.cacheRead(mediaId, `tracks/${trackId}/anchors.v1.json`)));
  } catch {
    meta = null;
  }
  // 讀的途中 adopt 先放了一份（noteAdopted）：不要用這次讀到的蓋掉它
  const now = useObjectMeta.getState();
  if (trackId in now.byTrack) {
    useObjectMeta.setState((s) => {
      const loading = { ...s.loading };
      delete loading[trackId];
      return { loading };
    });
    return now.byTrack[trackId];
  }
  now.put(trackId, meta);
  return meta;
}

/** adopt 完成：先放摘要（馬上畫得出最佳幀的框），再去讀完整錨點。 */
export function noteAdopted(mediaId: string, trackId: string, a: AdoptResult): void {
  useObjectMeta.getState().put(trackId, metaFromAdopt(a));
  void (async () => {
    try {
      const full = parseAnchors(decodeJson(await api.cacheRead(mediaId, `tracks/${trackId}/anchors.v1.json`)));
      if (full) useObjectMeta.getState().put(trackId, full);
    } catch {
      // 舊版引擎沒寫錨點：留著摘要
    }
  })();
}
