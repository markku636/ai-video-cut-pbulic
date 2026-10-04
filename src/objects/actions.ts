/**
 * 物件的動作（碰引擎 / store / toast）：跑 seg.find、把勾選的實例收進專案、手動選取的預覽與傳播、修正、刪除、跳到最佳幀。
 * 純函式在 find.ts / selection.ts / adopt.ts（測試直接載）；這裡只做接線。指令表、面板、對話框都呼叫這裡。
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, errMessage, isCanceled } from "../api";
import { t } from "../i18n";
import { runEngineJob } from "../pipeline/engineJob";
import { cacheDirOf, joinPath } from "../pipeline/project";
import type { ObjectSourceV1 } from "../project/format";
import { newObjectTrackId, useEdits } from "../store/edits";
import { useJobs } from "../store/jobs";
import { useMasks } from "../store/masks";
import { usePlayback } from "../store/playback";
import { activeFrames, selectActiveMedia, useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useTimeline } from "../store/timeline";
import { useUi } from "../store/ui";
import { toast } from "../ui";
import { useAssistantDraft } from "../assistant/draft";
import { privacyMosaic } from "../fx/effect";
import { bumpMaskRev } from "../fx/preview";
import { clampFrame } from "../video/frames";
import { adoptMasks, rangeFromVisible, type AdoptResult } from "./adopt";
import { findArgs, findRunId, instanceLabels, instanceRange, instanceSource, parseFindResult, scopeFrames, type FindRequest, type FindResult, type FindScope, type ScopeContext } from "./find";
import { forgetMaskFile } from "./maskFrame";
import { noteAdopted, useObjectMeta } from "./meta";
import { hasPrompts, nextObjectLabel, parseSelectPreview, propagatedMasks, refineSpan, selectArgs, useSelection } from "./selection";

/** 物件分頁的 id（inspector/tabs.ts）。 */
export const OBJECTS_TAB = "objects";

function samVariant(): string {
  return useSettings.getState().s.engine.sam_variant || "small";
}

function activeMedia() {
  return selectActiveMedia(useProject.getState());
}

/** 目前的範圍情境（播放線、幀數、鏡頭、I/O）。 */
export function scopeContext(): ScopeContext {
  const mediaId = useProject.getState().activeMediaId;
  return {
    frame: usePlayback.getState().frame,
    frames: activeFrames(),
    shots: mediaId ? useEdits.getState().shots[mediaId] ?? [] : [],
    range: useTimeline.getState().range,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 用文字找（FindObjectDialog）
// ────────────────────────────────────────────────────────────────────────────

/** 跑 seg.find（長工作：工作清單有進度、可取消）。--out 在媒體快取的 find/<run>。 */
export async function runFind(mediaId: string, req: Omit<FindRequest, "out" | "sam">, onJob?: (cancel: () => void) => void): Promise<FindResult> {
  const out = joinPath(await cacheDirOf(mediaId), "find", findRunId());
  const p = runEngineJob<unknown>({ kind: "objects", mediaId, op: "seg.find", args: findArgs({ ...req, out, sam: samVariant() }), step: "找物件" });
  onJob?.(() => cancelObjectJobs(mediaId));
  return parseFindResult(await p);
}

/** 取消這支媒體上正在跑的物件工作（job 的 cancel 由 runEngineJob 掛在 jobs store 上）。 */
export function cancelObjectJobs(mediaId: string): void {
  for (const j of useJobs.getState().jobs) if (j.kind === "objects" && j.mediaId === mediaId && (j.status === "queued" || j.status === "running")) j.cancel?.();
}

/** find 之後要做什麼（開始畫面的卡片決定）：track = 只建物件；privacy = 建好之後打碼。 */
export type FindIntent = "track" | "privacy";

/**
 * 收進專案之後的接續動作（外掛或之後的功能可以掛；核心沒有用到）。
 * 隱私打碼的馬賽克**不在這裡**：它跟新增物件同一筆 undo（adoptFindInstances 直接把特效放進 addObjectTracks 的 init），
 * 不然復原一次只拿掉馬賽克、物件還在，要按兩次才回到找之前。
 */
export const afterAdoptHooks: Record<FindIntent, ((mediaId: string, trackIds: string[]) => void) | null> = {
  track: null,
  privacy: null,
};

export interface AdoptOutcome {
  ids: string[];
  failed: number;
  firstError: string | null;
}

/**
 * 把勾選的實例收進專案：每個先決定 id → objects.adopt 搬遮罩 → 一次 addObjectTracks（一筆 undo）。
 * 某一個 adopt 失敗不擋其他的（回報失敗數）。
 */
export async function adoptFindInstances(mediaId: string, result: FindResult, ticked: ReadonlySet<number>, userText: string, intent: FindIntent = "track"): Promise<AdoptOutcome> {
  const media = useProject.getState().media.find((m) => m.id === mediaId);
  if (!media) return { ids: [], failed: 0, firstError: null };
  const existing = (useEdits.getState().tracks[mediaId] ?? []).map((x) => x.label);
  const labels = instanceLabels(result, userText, existing);
  const taken: { id: string }[] = [...(useEdits.getState().tracks[mediaId] ?? [])];
  const inits = [];
  let failed = 0;
  let firstError: string | null = null;
  for (const inst of result.instances) {
    if (!ticked.has(inst.id)) continue;
    const id = newObjectTrackId(taken);
    taken.push({ id });
    try {
      const a = await adoptMasks(media.path, inst.masks, id);
      noteAdopted(mediaId, id, a);
      inits.push({
        id,
        label: labels.get(inst.id) ?? inst.phrase,
        source: instanceSource(result, inst, userText),
        range: rangeFromVisible(a.visibleRanges, instanceRange(inst, result.frames)),
        referenceFrame: a.bestFrame ?? inst.bestFrame,
        frames: activeFrames() || null,
        // 隱私打碼：每個收進來的物件一個馬賽克（臉用橢圓、車牌等用外接框）
        ...(intent === "privacy" ? { effects: [privacyMosaic(inst.phrase)] } : {}),
      });
    } catch (e) {
      failed++;
      firstError ??= errMessage(e);
    }
  }
  const ids = useEdits.getState().addObjectTracks(mediaId, inits);
  if (ids.length) {
    useTimeline.getState().selectTrack(ids[0]);
    useUi.getState().setTab(OBJECTS_TAB);
    afterAdoptHooks[intent]?.(mediaId, ids);
  }
  return { ids, failed, firstError };
}

/** 縮圖 / 疊色圖（媒體快取裡的 PNG）的 URL：asset protocol 直接讀檔（find 每次一個新資料夾，不必擔心快取）。 */
export function fileUrl(path: string | null | undefined): string | null {
  return path ? convertFileSrc(path) : null;
}

// ────────────────────────────────────────────────────────────────────────────
// 手動選取（舞台工具「選取物件」）
// ────────────────────────────────────────────────────────────────────────────

/** 進入選取工具（新物件）；已經在修正某個物件就保留目標。 */
export function startSelectTool(): void {
  const mediaId = useProject.getState().activeMediaId;
  if (!mediaId) return;
  const s = useSelection.getState().session;
  if (!s || s.mediaId !== mediaId) useSelection.getState().start(mediaId, usePlayback.getState().frame, null);
  useTimeline.getState().setTool("objSelect");
  useUi.getState().setTab(OBJECTS_TAB);
}

/** 修正選中的物件：從這一幀補點，按「從這一幀往後重算」時只重算 K 之後。 */
export function startRefine(trackId: string): void {
  const mediaId = useProject.getState().activeMediaId;
  if (!mediaId) return;
  useSelection.getState().start(mediaId, usePlayback.getState().frame, trackId);
  useTimeline.getState().setTool("objSelect");
  useUi.getState().setTab(OBJECTS_TAB);
}

export function cancelSelection(): void {
  useSelection.getState().end();
  if (useTimeline.getState().tool === "objSelect") useTimeline.getState().setTool("select");
}

let previewBusy = false;

/**
 * 送單幀 seg.select 預覽（latest-wins）：正在送的時候又點了一下 → 等這次回來再送最新的那組，不排一長串。
 * 結果的 rev 對不上（又改過了）就丟掉，舞台不會畫出「上一組提示」的遮罩。
 */
export async function runPreview(): Promise<void> {
  if (previewBusy) return;
  const st = useSelection.getState();
  const s = st.session;
  if (!s || !hasPrompts(s) || st.committing) return;
  const media = useProject.getState().media.find((m) => m.id === s.mediaId);
  if (!media) return;
  previewBusy = true;
  const rev = s.rev;
  st.setStatus("running");
  try {
    const out = joinPath(await cacheDirOf(s.mediaId), "select", s.id);
    const raw = await api.engineCall("seg.select", selectArgs({ video: media.path, frame: s.frame, points: s.points, box: s.box, out, sam: samVariant() }), 10 * 60_000);
    const preview = parseSelectPreview(raw);
    const bitmap = preview.mask ? await loadMaskPng(preview.mask).catch(() => null) : null;
    useSelection.getState().setPreview(rev, preview, bitmap);
  } catch (e) {
    const cur = useSelection.getState().session;
    if (cur && cur.rev === rev) useSelection.getState().setStatus("error", errMessage(e));
  } finally {
    previewBusy = false;
  }
  const after = useSelection.getState().session;
  if (after && hasPrompts(after) && after.rev !== after.previewRev && after.status !== "error") void runPreview();
}

/** mask.png（灰階 0/255，沒有 alpha）→ 白色 alpha 位圖（上色在畫的時候做）。每次都重讀（同一個檔名會被下一次預覽覆寫）。 */
export async function loadMaskPng(path: string): Promise<ImageBitmap> {
  const res = await fetch(`${convertFileSrc(path)}?v=${Date.now()}`, { cache: "no-store" });
  const src = await createImageBitmap(await res.blob());
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext("2d");
  if (!ctx) return src;
  ctx.drawImage(src, 0, 0);
  src.close();
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const on = d[i] > 127;
    d[i] = d[i + 1] = d[i + 2] = 255;
    d[i + 3] = on ? 255 : 0;
  }
  return createImageBitmap(img);
}

/**
 * 「追蹤這個物件」：同一組提示加 --propagate 沿範圍傳播（長工作），再 adopt。
 * - 新物件：範圍 = 使用者選的範圍；建一條物件 track。
 * - 修正（targetTrackId）：--from 既有遮罩，只從 K 往後重算；adopt 回同一個 id，範圍放大到新的可見區段。
 */
export async function commitSelection(scope: FindScope): Promise<string | null> {
  const st = useSelection.getState();
  const s = st.session;
  if (!s || !hasPrompts(s) || st.committing) return null;
  const media = useProject.getState().media.find((m) => m.id === s.mediaId);
  if (!media) return null;
  const frames = media.proxy?.frames ?? 0;
  const span = scopeFrames(scope, { ...scopeContext(), frame: s.frame });
  if (!span) {
    toast.info(t("先用 I / O 標一段範圍"));
    return null;
  }
  const target = s.targetTrackId ? (useEdits.getState().tracks[s.mediaId] ?? []).find((x) => x.id === s.targetTrackId && x.kind === "object") ?? null : null;
  const propagate: [number, number] = target ? refineSpan(s.frame, target.range, span, frames) : span[0] <= s.frame && s.frame < span[1] ? span : refineSpan(s.frame, undefined, span, frames);
  st.setCommitting(true);
  try {
    const cacheDir = await cacheDirOf(s.mediaId);
    const out = joinPath(cacheDir, "select", s.id);
    const from = target ? joinPath(cacheDir, "tracks", target.id, "masks.aivm") : null;
    const raw = await runEngineJob<unknown>({
      kind: "objects",
      mediaId: s.mediaId,
      trackId: target?.id,
      op: "seg.select",
      args: selectArgs({ video: media.path, frame: s.frame, points: s.points, box: s.box, out, propagate, from, sam: samVariant() }),
      step: target ? "修正物件" : "追蹤物件",
    });
    const masks = propagatedMasks(raw);
    if (!masks) throw new Error(t("傳播沒有產生遮罩"));
    if (target) {
      const a = await adoptMasks(media.path, masks, target.id);
      refreshAdopted(s.mediaId, target.id, a);
      const next = rangeFromVisible(a.visibleRanges, target.range ?? propagate);
      useEdits.getState().setObjectFields(s.mediaId, target.id, { range: next }, frames || null);
      toast.success(t("已從第 {k} 幀往後重算", { k: s.frame }));
      useSelection.getState().end();
      useTimeline.getState().setTool("select");
      return target.id;
    }
    const tracks = useEdits.getState().tracks[s.mediaId] ?? [];
    const id = newObjectTrackId(tracks);
    const a = await adoptMasks(media.path, masks, id);
    noteAdopted(s.mediaId, id, a);
    const source: ObjectSourceV1 = { type: "select" };
    const label = nextObjectLabel(tracks.filter((x) => x.kind === "object").map((x) => x.label), t("物件"));
    const ids = useEdits.getState().addObjectTracks(s.mediaId, [{ id, label, source, range: rangeFromVisible(a.visibleRanges, propagate), referenceFrame: a.bestFrame ?? s.frame, frames: frames || null }]);
    useSelection.getState().end();
    useTimeline.getState().setTool("select");
    if (ids[0]) {
      useTimeline.getState().selectTrack(ids[0]);
      toast.success(t("已建立物件「{name}」", { name: label }));
    }
    return ids[0] ?? null;
  } catch (e) {
    if (!isCanceled(e)) toast.error(errMessage(e));
    return null;
  } finally {
    useSelection.getState().setCommitting(false);
  }
}

/** 遮罩被 adopt 重寫：錨點、header、位圖快取全部作廢。 */
function refreshAdopted(mediaId: string, trackId: string, a: AdoptResult): void {
  forgetMaskFile(mediaId, trackId);
  useMasks.getState().clearTrack(trackId);
  useObjectMeta.getState().invalidate(trackId);
  bumpMaskRev(trackId);
  noteAdopted(mediaId, trackId, a);
}

// ────────────────────────────────────────────────────────────────────────────
// 清單上的動作
// ────────────────────────────────────────────────────────────────────────────

export function selectObject(trackId: string): void {
  useTimeline.getState().selectTrack(trackId);
}

/** 跳到最佳幀（referenceFrame；沒有就範圍起點）。 */
export function jumpToObject(trackId: string): void {
  const mediaId = useProject.getState().activeMediaId;
  const tr = mediaId ? (useEdits.getState().tracks[mediaId] ?? []).find((x) => x.id === trackId) : null;
  if (!tr) return;
  useTimeline.getState().selectTrack(trackId);
  const k = tr.referenceFrame ?? tr.range?.[0] ?? 0;
  const frames = activeFrames();
  usePlayback.getState().seek(frames > 0 ? clampFrame(k, frames) : k);
}

/** 刪物件（一筆 undo）。遮罩檔留在快取裡：undo 回來還讀得到（id 不重用，見 newObjectTrackId）。 */
export function deleteObjects(trackIds: readonly string[]): void {
  const mediaId = useProject.getState().activeMediaId;
  if (!mediaId || !trackIds.length) return;
  useEdits.getState().removeTracks(mediaId, trackIds);
  if (trackIds.includes(useTimeline.getState().selectedTrackId ?? "")) useTimeline.getState().selectTrack(null);
  const s = useSelection.getState().session;
  if (s?.targetTrackId && trackIds.includes(s.targetTrackId)) cancelSelection();
}

export function renameObject(trackId: string, label: string): boolean {
  const mediaId = useProject.getState().activeMediaId;
  return !!mediaId && useEdits.getState().setObjectFields(mediaId, trackId, { label });
}

export function recolorObject(trackId: string, color: string): boolean {
  const mediaId = useProject.getState().activeMediaId;
  return !!mediaId && useEdits.getState().setObjectFields(mediaId, trackId, { color });
}

/** 物件分頁是不是開著（舞台用：只有開著時才為選中的物件解遮罩）。 */
export function objectsTabOpen(): boolean {
  const ui = useUi.getState();
  return ui.railOpen && ui.tab === OBJECTS_TAB;
}

export function activeMediaPath(): string | null {
  return activeMedia()?.path ?? null;
}

/**
 * 「讓 AI 選」：AI 看圖給座標（media.frame --grid → seg.select --coords norm1000）由之後的任務接上。
 * 現在打開助手分頁、預填一句話，讓人看一眼再送出。
 */
export function askAiToPick(what?: string): void {
  const thing = what?.trim();
  useAssistantDraft.getState().setDraft(thing ? t("幫我在畫面上找出「{what}」並追蹤它", { what: thing }) : t("幫我挑出畫面裡最重要的物件並追蹤它"));
  useUi.getState().setTab("assistant");
}
