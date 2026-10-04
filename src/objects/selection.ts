/**
 * 手動選取物件（舞台工具「選取物件」；引擎 `seg.select`，契約 docs/tracking-api.md §6.2）。
 *
 * 一次選取 = 一個 session：同一幀上的加選點（點一下）、減選點（Alt＋點）、一個框（拖曳）。每次改動就送一次
 * 單幀 `seg.select`（沒有 --propagate，幾百毫秒），把回來的 mask.png 疊在舞台上 —— 使用者看著結果補點。
 * 滿意了按「追蹤這個物件」：同一組提示加 `--propagate K0:K1` 沿範圍傳播（長工作，有進度、可取消），
 * 再 `objects.adopt` 搬進 `tracks/<新 id>/masks.aivm`、建物件 track。
 *
 * 修正既有物件（`object.refine`）：session 帶 targetTrackId。送 `--from tracks/<id>/masks.aivm --propagate`：
 * 引擎保留 K 之前的幀、只從 K 往後重算（§6.2 的合併規則），adopt 回同一個 track id（遮罩在 undo 之外，同解算）。
 *
 * 這個檔：上面是純函式與 store（測試直接載），`runPreview` / `commitSelection` 才碰引擎。
 */
import { create } from "zustand";
import type { FindScope } from "./find";

export interface SelectPoint {
  x: number;
  y: number;
  /** 1 = 加選、0 = 減選。 */
  label: 0 | 1;
}

export type SelectStatus = "idle" | "running" | "done" | "error";

export interface SelectPreview {
  /** mask.png（0/255）的絕對路徑。 */
  mask: string;
  overlay: string;
  box: [number, number, number, number] | null;
  area: number;
  score: number | null;
  backend: { name: string; fallback: boolean; reason: string };
}

export interface SelectionSession {
  /** 輸出資料夾名（媒體快取的 select/<id>）。 */
  id: string;
  mediaId: string;
  /** 提示所在的幀（proxy 幀）。換幀 = 新的一組提示。 */
  frame: number;
  points: SelectPoint[];
  /** [x, y, w, h]（來源像素）；最多一個。 */
  box: [number, number, number, number] | null;
  /** 修正既有物件：那條物件 track 的 id；null = 選一個新物件。 */
  targetTrackId: string | null;
  /** 每次提示改動 +1（latest-wins：預覽回來時 rev 對不上就再送一次）。 */
  rev: number;
  status: SelectStatus;
  /** 最後一次成功預覽對應的 rev（舞台只畫這個 rev 的遮罩才不會「點了 A 看到 B」）。 */
  previewRev: number;
  preview: SelectPreview | null;
  /** 預覽的遮罩位圖（白色 alpha；上色在畫的時候做）。 */
  bitmap: ImageBitmap | null;
  error: string | null;
}

interface SelectionStore {
  session: SelectionSession | null;
  /** 「追蹤這個物件」的範圍（預設播放線所在鏡頭）。 */
  scope: FindScope;
  /** 傳播 job 在跑（按鈕灰掉、不能再送）。 */
  committing: boolean;
  start: (mediaId: string, frame: number, targetTrackId?: string | null) => void;
  addPoint: (mediaId: string, frame: number, p: SelectPoint) => void;
  setBox: (mediaId: string, frame: number, box: [number, number, number, number]) => void;
  /** 拿掉最後一個提示（先點、再框）；什麼都不剩就清掉預覽。 */
  undoLast: () => void;
  clearPrompts: () => void;
  setScope: (s: FindScope) => void;
  setCommitting: (v: boolean) => void;
  /** 預覽回來（rev 對得上才收）。 */
  setPreview: (rev: number, preview: SelectPreview, bitmap: ImageBitmap | null) => void;
  setStatus: (status: SelectStatus, error?: string | null) => void;
  end: () => void;
}

let sessionSeq = 0;
export function selectionId(now = Date.now()): string {
  return `s${now.toString(36)}${(sessionSeq++).toString(36)}`;
}

/** 這一組提示能不能送（至少一個點或一個框）。 */
export function hasPrompts(s: Pick<SelectionSession, "points" | "box"> | null): boolean {
  return !!s && (s.points.length > 0 || !!s.box);
}

function fresh(mediaId: string, frame: number, targetTrackId: string | null): SelectionSession {
  return { id: selectionId(), mediaId, frame, points: [], box: null, targetTrackId, rev: 0, status: "idle", previewRev: -1, preview: null, bitmap: null, error: null };
}

/** 提示要落在 session 那一幀；換了幀（或媒體）就從新的一組開始（同一個修正目標）。 */
function onFrame(s: SelectionSession | null, mediaId: string, frame: number): SelectionSession {
  if (s && s.mediaId === mediaId && s.frame === frame) return s;
  s?.bitmap?.close();
  return fresh(mediaId, frame, s && s.mediaId === mediaId ? s.targetTrackId : null);
}

export const useSelection = create<SelectionStore>((set, get) => ({
  session: null,
  scope: "shot",
  committing: false,
  start: (mediaId, frame, targetTrackId = null) => {
    get().session?.bitmap?.close();
    set({ session: fresh(mediaId, frame, targetTrackId) });
  },
  addPoint: (mediaId, frame, p) => {
    const s = onFrame(get().session, mediaId, frame);
    set({ session: { ...s, points: [...s.points, p], rev: s.rev + 1, error: null } });
  },
  setBox: (mediaId, frame, box) => {
    const s = onFrame(get().session, mediaId, frame);
    set({ session: { ...s, box, rev: s.rev + 1, error: null } });
  },
  undoLast: () => {
    const s = get().session;
    if (!s || !hasPrompts(s)) return;
    const next = s.points.length ? { ...s, points: s.points.slice(0, -1) } : { ...s, box: null };
    if (!hasPrompts(next)) s.bitmap?.close();
    set({ session: hasPrompts(next) ? { ...next, rev: s.rev + 1 } : { ...next, rev: s.rev + 1, preview: null, bitmap: null, previewRev: -1, status: "idle" } });
  },
  clearPrompts: () => {
    const s = get().session;
    if (!s) return;
    s.bitmap?.close();
    set({ session: { ...s, points: [], box: null, rev: s.rev + 1, preview: null, bitmap: null, previewRev: -1, status: "idle", error: null } });
  },
  setScope: (scope) => set({ scope }),
  setCommitting: (committing) => set({ committing }),
  setPreview: (rev, preview, bitmap) => {
    const s = get().session;
    if (!s || rev !== s.rev) {
      bitmap?.close();
      return;
    }
    if (s.bitmap && s.bitmap !== bitmap) s.bitmap.close();
    set({ session: { ...s, preview, bitmap, previewRev: rev, status: "done", error: null } });
  },
  setStatus: (status, error = null) => {
    const s = get().session;
    if (s) set({ session: { ...s, status, error } });
  },
  end: () => {
    get().session?.bitmap?.close();
    set({ session: null, committing: false });
  },
}));

// ────────────────────────────────────────────────────────────────────────────
// 引擎參數與結果（純函式）
// ────────────────────────────────────────────────────────────────────────────

const fmt = (v: number) => String(Math.round(v * 10) / 10);

export interface SelectRequest {
  video: string;
  frame: number;
  points: readonly SelectPoint[];
  box: readonly [number, number, number, number] | null;
  out: string;
  /** [k0, k1)：要傳播就給（K 必須在裡面）。 */
  propagate?: [number, number] | null;
  /** 修正：既有遮罩檔（--from）。 */
  from?: string | null;
  sam?: string;
}

/** `seg.select` 的 args（鍵 = CLI dest 名；座標是來源像素 px）。 */
export function selectArgs(r: SelectRequest): Record<string, unknown> {
  return {
    video: r.video,
    frame: r.frame,
    point: r.points.map((p) => `${fmt(p.x)},${fmt(p.y)}${p.label === 0 ? ":neg" : ""}`),
    box: r.box ? [r.box.map(fmt).join(",")] : [],
    coords: "px",
    out: r.out,
    ...(r.propagate ? { propagate: `${r.propagate[0]}:${r.propagate[1]}` } : {}),
    ...(r.from ? { from_masks: r.from } : {}),
    ...(r.sam ? { sam: r.sam } : {}),
  };
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function parseSelectPreview(raw: unknown): SelectPreview {
  const o = rec(raw) ?? {};
  const b = rec(o.backend) ?? {};
  const box = Array.isArray(o.box) && o.box.length === 4 && o.box.every((x) => typeof x === "number") ? (o.box as [number, number, number, number]) : null;
  return {
    mask: typeof o.mask === "string" ? o.mask : "",
    overlay: typeof o.overlay === "string" ? o.overlay : "",
    box,
    area: typeof o.area === "number" ? o.area : 0,
    score: typeof o.score === "number" ? o.score : null,
    backend: { name: typeof b.name === "string" ? b.name : "", fallback: b.fallback === true, reason: typeof b.reason === "string" ? b.reason : "" },
  };
}

/** 傳播結果的遮罩檔路徑（select.v1.json 的 propagated.masks）；沒有 → null。 */
export function propagatedMasks(raw: unknown): string | null {
  const p = rec(rec(raw)?.propagated);
  return p && typeof p.masks === "string" && p.masks ? p.masks : null;
}

/**
 * 修正既有物件時的傳播範圍：涵蓋「這條物件原本的範圍」與「使用者選的範圍」，而且一定包含 K
 * （引擎要求 K0 ≤ K < K1；--from 只重算 [K, K1)，K 之前的幀原樣保留）。
 */
export function refineSpan(k: number, trackRange: readonly [number, number] | undefined, scope: readonly [number, number] | null, frames: number): [number, number] {
  let a = Math.min(k, trackRange?.[0] ?? k, scope?.[0] ?? k);
  let b = Math.max(k + 1, trackRange?.[1] ?? k + 1, scope?.[1] ?? k + 1);
  a = Math.max(0, a);
  b = frames > 0 ? Math.min(frames, b) : b;
  return [a, Math.max(a + 1, b)];
}

/** 拖曳夠遠才算框（螢幕像素）；短於這個是點一下。 */
export const DRAG_BOX_MIN_PX = 6;

/** 兩個來源像素點 → 框 [x, y, w, h]（任意方向拖都行）；太小 → null。 */
export function boxFromDrag(a: readonly [number, number], b: readonly [number, number], minSide = 2): [number, number, number, number] | null {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  const w = Math.abs(a[0] - b[0]);
  const h = Math.abs(a[1] - b[1]);
  return w >= minSide && h >= minSide ? [x, y, w, h] : null;
}

/** 新物件的名字：「物件 N」（N = 這支媒體第幾個物件；撞名往後跳）。 */
export function nextObjectLabel(existing: readonly string[], base: string): string {
  const taken = new Set(existing);
  for (let n = existing.length + 1; ; n++) {
    const name = `${base} ${n}`;
    if (!taken.has(name)) return name;
  }
}
