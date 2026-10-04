import { create } from "zustand";
import type { Quad, ReplaceV1, TrackV1 } from "../project/format";
import { hashOf } from "../stage/previewStore";
import { activeEffects } from "./effect";
import { enginePayload } from "./validate";

/**
 * 效果 / 替換的舞台預覽（選中的 track 有特效或替換、暫停時）：快取、節流、latest-wins。
 *
 * 跟 stage/previewStore（comp.preview）同一個紀律，但分開放：那邊的鍵是「整份專案的 tracks／targets／insert」，
 * 這邊只看**一條 track**（特效堆疊、替換設定、這一幀的四角、遮罩版本），改一個參數不必讓整個合成預覽失效。
 *
 * 這裡**不知道引擎**：誰去叫 fx.preview / comp.preview_composite 由 pipeline/fxPreview.ts 注入（setFxPreviewProvider），
 * 單元測試可以在 node 裡跑鍵、節流與取消。
 *
 * 取消安全：
 * - 只留**最後一個**請求（scrub 時中間的幀全部丟掉），同時只有一個在飛；飛回來時若又有新的請求，接著送新的。
 * - 送出去的結果照鍵存：使用者已經換了 track / 幀，舊結果只是進快取、不會被畫出來（舞台只拿目前的鍵）。
 * - clearFxPreviews 之後才回來的舊結果直接丟掉（epoch 不同），換片 / 關檔不會被舊圖污染。
 */

export type FxPreviewKind = "effects" | "replace";

export interface FxPreviewParts {
  mediaId: string;
  trackId: string;
  /** "object" | "planar"：物件的遮罩在 tracks/<id>/masks.aivm；平面的要先找（可能沒有）。 */
  trackKind: TrackV1["kind"];
  frame: number;
  kind: FxPreviewKind;
  /** effects：送給引擎的特效陣列 JSON；replace：ReplaceV1 JSON。 */
  payload: string;
  /** 平面替換：這一幀的四角（來源像素）。 */
  quad: Quad | null;
  /** 遮罩版本（修正物件、重新 adopt 之後 +1，舊預覽作廢）。 */
  rev: number;
}

/** 顯示在舞台 HUD 的一句話（zh key ＋ 參數；引擎的錯誤訊息原樣當 key，identity fallback）。 */
export interface FxNote {
  key: string;
  params?: Record<string, string | number>;
}

export interface FxPreviewEntry {
  img: CanvasImageSource | null;
  note: FxNote | null;
}

export type FxPreviewProvider = (parts: FxPreviewParts) => Promise<FxPreviewEntry | null>;

export function fxPreviewKey(p: FxPreviewParts): string {
  return `${p.mediaId}:${p.trackId}:${p.frame}:${p.kind}:${hashOf([p.payload, p.quad?.p ?? null, p.rev])}`;
}

/** 這條 track 這一幀要預覽什麼：parts＝去要；skip＝講原因不要；null＝沒有東西可預覽（不打擾）。 */
export type FxPreviewPlan = { parts: FxPreviewParts } | { skip: FxNote } | null;

function hasReplace(r: ReplaceV1 | undefined): r is ReplaceV1 {
  return !!r && typeof r.path === "string" && r.path.trim() !== "";
}

/**
 * 純函式：選中的 track → 預覽計畫。
 * - 物件：開著而且沒有錯的特效（enginePayload）；不在物件範圍內的幀不送（那一幀特效本來就不做）。
 * - 平面：有替換就預覽替換（要有這一幀的四角）；沒有替換但有特效就預覽特效（遮罩檔有沒有由 provider 判斷）。
 * - 特效全都有錯：講一句「先修正標紅的欄位」，不送一份引擎一定拒收的東西。
 */
export function planFxPreview(track: TrackV1, frame: number, mediaId: string, ctx: { quad: Quad | null; rev: number }): FxPreviewPlan {
  const base = { mediaId, trackId: track.id, trackKind: track.kind, frame, quad: null as Quad | null, rev: ctx.rev };
  if (track.kind !== "object" && hasReplace(track.replace)) {
    if (!ctx.quad) return { skip: { key: "這一幀沒有表面：沒辦法預覽替換" } };
    return { parts: { ...base, kind: "replace", payload: JSON.stringify(track.replace), quad: ctx.quad } };
  }
  const active = activeEffects(track.effects);
  if (!active.length) return null;
  if (track.kind === "object" && track.range && (frame < track.range[0] || frame >= track.range[1])) return null;
  const payload = enginePayload(track.effects);
  if (!payload.length) return { skip: { key: "特效有錯：先修正「效果」裡標紅的欄位" } };
  return { parts: { ...base, kind: "effects", payload: JSON.stringify(payload) } };
}

// ────────────────────────────────────────────────────────────────────────────
// 快取 / 節流
// ────────────────────────────────────────────────────────────────────────────

export const FX_PREVIEW_CACHE_MAX = 24;
export const FX_PREVIEW_DEBOUNCE_MS = 150;

const cache = new Map<string, FxPreviewEntry>();
const revs = new Map<string, number>();
let provider: FxPreviewProvider | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let pending: FxPreviewParts | null = null;
let inflightKey: string | null = null;
let epoch = 0;

/** 舞台的開關（不存檔）：關掉就只看原片。 */
interface FxPreviewUi {
  live: boolean;
  setLive: (v: boolean) => void;
  /** 有新圖 / 新說明進來就 +1，舞台重畫。 */
  version: number;
}

export const useFxPreview = create<FxPreviewUi>((set) => ({
  live: true,
  setLive: (live) => set({ live }),
  version: 0,
}));

function bump(): void {
  useFxPreview.setState((s) => ({ version: s.version + 1 }));
}

function closeImg(img: CanvasImageSource | null): void {
  if (img && "close" in img && typeof (img as ImageBitmap).close === "function") (img as ImageBitmap).close();
}

export function setFxPreviewProvider(p: FxPreviewProvider | null): void {
  provider = p;
}

export function getFxPreview(key: string): FxPreviewEntry | null {
  const v = cache.get(key);
  if (!v) return null;
  cache.delete(key);
  cache.set(key, v);
  return v;
}

function put(key: string, e: FxPreviewEntry): void {
  const old = cache.get(key);
  if (old && old.img !== e.img) closeImg(old.img);
  cache.delete(key);
  cache.set(key, e);
  while (cache.size > FX_PREVIEW_CACHE_MAX) {
    const first = cache.keys().next().value as string;
    closeImg(cache.get(first)?.img ?? null);
    cache.delete(first);
  }
  bump();
}

function fire(): void {
  timer = null;
  if (!provider || !pending || inflightKey) return;
  const parts = pending;
  pending = null;
  const key = fxPreviewKey(parts);
  if (cache.has(key)) return;
  inflightKey = key;
  const mine = epoch;
  provider(parts)
    .then((e) => {
      if (e && mine === epoch) put(key, e);
      else if (e) closeImg(e.img);
    })
    .catch(() => {
      /* 預覽失敗不吵人：下一次請求再試 */
    })
    .finally(() => {
      inflightKey = null;
      // 飛的時候又來了新的請求：接著送最新的那個（中間的都丟了）
      if (pending && timer === null) fire();
    });
}

/**
 * 要求一張預覽：debounce 內只留最後一個；同鍵已經有圖或正在飛就不送。
 * 沒有 provider（測試、引擎沒裝）就什麼都不做。
 */
export function requestFxPreview(parts: FxPreviewParts, debounceMs = FX_PREVIEW_DEBOUNCE_MS): void {
  if (!provider) return;
  const key = fxPreviewKey(parts);
  if (cache.has(key) || inflightKey === key) return;
  if (pending && fxPreviewKey(pending) === key && timer !== null) return;
  pending = parts;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(fire, debounceMs);
}

/** 丟掉還沒送出的請求（取消選取 / 關掉預覽）。正在飛的那個回來後照鍵進快取，不會被畫出來。 */
export function cancelFxPreview(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  pending = null;
}

/** 整批作廢（換片、關檔）；給 trackId 只清那一條。之後才回來的舊結果直接丟掉。 */
export function clearFxPreviews(trackId?: string): void {
  if (trackId === undefined) {
    epoch++;
    cancelFxPreview();
    for (const v of cache.values()) closeImg(v.img);
    cache.clear();
  } else {
    for (const [k, v] of [...cache.entries()]) {
      if (k.split(":")[1] !== trackId) continue;
      closeImg(v.img);
      cache.delete(k);
    }
  }
  bump();
}

/** 遮罩換了（修正物件 / 重新 adopt）：這條 track 的預覽版本 +1。 */
export function bumpMaskRev(trackId: string): void {
  revs.set(trackId, (revs.get(trackId) ?? 0) + 1);
  clearFxPreviews(trackId);
}

export function maskRev(trackId: string): number {
  return revs.get(trackId) ?? 0;
}

/** 測試用。 */
export function __resetFxPreviews(): void {
  cancelFxPreview();
  cache.clear();
  revs.clear();
  provider = null;
  inflightKey = null;
  epoch++;
}
