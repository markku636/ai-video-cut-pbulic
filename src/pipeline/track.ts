import { api, decodeJson } from "../api";
import type { Quad, TrackV1 } from "../project/format";
import { useEdits, shotAt } from "../store/edits";
import { useProject } from "../store/project";
import { parseSolveRow, useSolves, type Solve, type SolveFrame } from "../store/solves";
import { cacheDirOf, joinPath } from "./project";
import { dedupe, runEngineJob, runningJob } from "./engineJob";
import { templateCandidates } from "../plugins/queries";

/**
 * 追蹤解算（引擎 `track.solve`；計畫 §6.4 / §9 修正迴路）。
 *
 * 引擎吃的 args = CLI argparse 的 vars(ns)（key 是 dest 名；engine/ops/track.py `_args`）：
 * `video` / `template`（PNG 路徑，必填）/ `shot "K0:K1"` / `masks`（.aivm）/ `reference_frame` / `quad` / `keyframe` ["K:x1,y1,…,x4,y4"] /
 * `tracking_region` / `upsample` / `motion_model` / `no_smoothing` / `smoothing_window` / `track_id` / `out` / `no_hud` /
 * `clear_forwards` / `clear_backwards` / `retrack_from` / `backwards` / `k_from` / `k_to`。
 * 解出來的 solve.v1.json 由這裡讀回 store/solves（**在 undo 之外**）。
 */
export interface SolveOpts {
  from?: number;
  to?: number;
  clearForwards?: number;
  clearBackwards?: number;
  retrackFrom?: number;
  backwards?: boolean;
}

function quadArg(q: Quad): string {
  return q.p.map(([x, y]) => `${x},${y}`).join(",");
}

/**
 * 引擎 artifact 事件告訴我們的檔案位置（矯正後的表面 `kind:"face"`、遮罩 `kind:"masks"`）。
 * `pipeline.run` 把模板留在記憶體不落地，所以之後從 UI 重解要有一張模板 PNG：辨識時寫出的矯正表面就是它。
 */
export const faceHints = new Map<string, string>();
export const maskHints = new Map<string, string>();

async function firstExisting(cands: string[]): Promise<string | null> {
  if (!cands.length) return null;
  const ex = await api.pathsExist(cands).catch(() => cands.map(() => false));
  const i = ex.findIndex(Boolean);
  return i >= 0 ? cands[i] : null;
}

/** track 的遮罩檔：`pipeline.run` 寫 `tracks/<tid>/masks.aivm`；UI 的 seg.run 寫 `tracks/<tid>/seg/obj1/masks.aivm`。 */
export async function maskFileFor(cacheDir: string, trackId: string): Promise<string | null> {
  const hinted = maskHints.get(trackId);
  return firstExisting([...(hinted ? [hinted] : []), joinPath(cacheDir, "tracks", trackId, "masks.aivm"), joinPath(cacheDir, "tracks", trackId, "seg", "obj1", "masks.aivm")]);
}

/**
 * `track.solve --template` 的模板圖。優先序：
 * ① 辨識 / 偵測時寫出的矯正表面（artifact / `tracks/<tid>/<ref:06d>.png`）② 外掛給的候選（例如外掛素材目錄裡的模板圖）。
 * 都沒有回 null：不給 --template，引擎從參考影格的四角取模板（一般的平面：牆、螢幕、招牌；engine/ops/track.py
 * template_from_reference，存成 solve 旁邊的 template.png）。以前這裡直接丟錯，沒有外掛時「新增追蹤」解不了。
 */
export async function templatePathFor(mediaId: string, t: TrackV1, cacheDir: string): Promise<string | null> {
  const ref = t.referenceFrame ?? t.keyframes[0]?.frame ?? 0;
  const cands: string[] = [];
  const hinted = faceHints.get(t.id);
  if (hinted) cands.push(hinted);
  cands.push(joinPath(cacheDir, "tracks", t.id, `${String(ref).padStart(6, "0")}.png`));
  cands.push(joinPath(cacheDir, "tracks", t.id, "faces", `${ref}.png`));
  cands.push(...templateCandidates(mediaId, t));
  return firstExisting(cands);
}

export function trackJobRunning(trackId: string): boolean {
  return !!runningJob("track", undefined, trackId);
}

/** 讀快取的 solve.v1.json → store/solves。缺檔就移除舊解（快取被清 = 要重解）。 */
export async function loadSolve(mediaId: string, trackId: string): Promise<Solve | null> {
  const m = useProject.getState().media.find((x) => x.id === mediaId);
  if (!m) return null;
  try {
    const raw = decodeJson<{ version?: number; shot?: [number, number]; anchorK?: number; anchor_k?: number; referenceFrame?: number; template?: { w: number; h: number } | [number, number]; frames?: number[][] }>(
      await api.cacheRead(m.id, `tracks/${trackId}/solve.v1.json`),
    );
    const frames = (raw.frames ?? []).map(parseSolveRow).filter((f): f is SolveFrame => !!f);
    const tpl = Array.isArray(raw.template) ? { w: raw.template[0], h: raw.template[1] } : raw.template ?? { w: 630, h: 880 };
    const solve: Solve = {
      version: 1,
      trackId,
      shot: raw.shot ?? [0, 0],
      anchorK: raw.anchorK ?? raw.anchor_k ?? raw.referenceFrame ?? 0,
      template: tpl,
      frames,
    };
    useSolves.getState().set(trackId, solve);
    return solve;
  } catch {
    useSolves.getState().remove(trackId);
    return null;
  }
}

/** 跑一次解算（整段或子範圍）；完成後讀回解、清 stale。同一條 track 同時只跑一份。 */
export function solveTrack(mediaId: string, trackId: string, opts: SolveOpts = {}): Promise<Solve | null> {
  return dedupe(`track:${trackId}`, async () => {
    const e = useEdits.getState();
    const t = (e.tracks[mediaId] ?? []).find((x) => x.id === trackId);
    const m = useProject.getState().media.find((x) => x.id === mediaId);
    if (!t || !m) return null;
    const shot = (e.shots[mediaId] ?? []).find((s) => s.id === t.shotId) ?? shotAt(e.shots[mediaId] ?? [], t.keyframes[0]?.frame ?? 0);
    if (!shot) throw new Error("這條追蹤不在任何鏡頭裡");
    const cacheDir = await cacheDirOf(mediaId);
    const [template, masks] = await Promise.all([templatePathFor(mediaId, t, cacheDir), maskFileFor(cacheDir, t.id)]);
    const args: Record<string, unknown> = {
      video: m.path,
      ...(template ? { template } : {}),
      shot: `${shot.startFrame}:${shot.endFrame}`,
      track_id: t.id,
      motion_model: t.options.motionModel,
      keyframe: t.keyframes.map((k) => `${k.frame}:${quadArg(k.quad)}`),
      ...(masks ? { masks } : {}),
      ...(t.referenceFrame != null ? { reference_frame: t.referenceFrame } : {}),
      ...(t.trackingRegion ? { tracking_region: quadArg(t.trackingRegion) } : {}),
      // options.smoothing 0–1 → SG 視窗（奇數，3–15）；0 = 關
      ...(t.options.smoothing <= 0 ? { no_smoothing: true } : { smoothing_window: Math.max(3, Math.round(3 + t.options.smoothing * 12)) | 1 }),
      ...(shot.kind === "wide" ? { upsample: 2 } : {}),
      ...(opts.from != null ? { k_from: opts.from } : {}),
      ...(opts.to != null ? { k_to: opts.to } : {}),
      ...(opts.clearForwards != null ? { clear_forwards: opts.clearForwards } : {}),
      ...(opts.clearBackwards != null ? { clear_backwards: opts.clearBackwards } : {}),
      ...(opts.retrackFrom != null ? { retrack_from: opts.retrackFrom } : {}),
      ...(opts.backwards ? { backwards: true } : {}),
    };
    await runEngineJob({ kind: "track", mediaId, trackId, op: "track.solve", args, step: "追蹤" });
    const solve = await loadSolve(mediaId, trackId);
    useEdits.getState().markSolved(mediaId, [trackId]);
    return solve;
  });
}

/** 使用者釘了第 N 幀：只重解相鄰硬釘之間 (a < N < b)，不動其他區段（計畫 §9 修正迴路 ①）。 */
export function resolveAround(mediaId: string, trackId: string, frame: number): Promise<Solve | null> {
  const e = useEdits.getState();
  const t = (e.tracks[mediaId] ?? []).find((x) => x.id === trackId);
  if (!t) return Promise.resolve(null);
  const ks = t.keyframes.map((k) => k.frame).filter((k) => k !== frame);
  const shot = (e.shots[mediaId] ?? []).find((s) => s.id === t.shotId);
  const prev = Math.max(shot?.startFrame ?? 0, ...ks.filter((k) => k < frame));
  const nextCandidates = ks.filter((k) => k > frame);
  const next = nextCandidates.length ? Math.min(...nextCandidates) + 1 : shot?.endFrame;
  return solveTrack(mediaId, trackId, { from: prev, ...(next != null ? { to: next } : {}) });
}

/** 前端先把解砍掉一段（畫面立刻反映），引擎那邊用 clear_* 同步存回。 */
export function clearSolveFrames(trackId: string, keep: (f: SolveFrame) => boolean): void {
  const s = useSolves.getState().byTrack[trackId];
  if (!s) return;
  useSolves.getState().set(trackId, { ...s, frames: s.frames.filter(keep) });
}

/** `geom.quad_from_mask` 的回覆（engine/ops/track.py quad_from_mask_op）。 */
export interface QuadFromMaskResult {
  /** 4×[x,y]（TL,TR,BR,BL）；null = 那一幀遮罩缺席 / 取不出四角。 */
  quad: [number, number][] | null;
  conf: number;
  iou?: number;
  method: string;
}

/**
 * 遮罩 → 四角（sidecar 專用 op，args 是 camelCase：`{ masks: <aivm 路徑>, frame, refTl?: [x,y] }`）。
 * 沒有遮罩檔回 null（呼叫端提示先加選 / 傳播）。
 */
export async function quadFromMask(mediaId: string, trackId: string, frame: number, refTl?: [number, number]): Promise<QuadFromMaskResult | null> {
  const cacheDir = await cacheDirOf(mediaId);
  const masks = await maskFileFor(cacheDir, trackId);
  if (!masks) return null;
  return api.engineCall<QuadFromMaskResult>("geom.quad_from_mask", { masks, frame, ...(refTl ? { refTl } : {}) }, 30_000);
}
