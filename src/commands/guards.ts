import { runningJob } from "../pipeline/engineJob";
import type { TrackV1 } from "../project/format";
import { useEdits, shotAt } from "../store/edits";
import { engineReady, useEngine } from "../store/engine";
import { useJobs } from "../store/jobs";
import { usePlayback } from "../store/playback";
import { selectActiveMedia, useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useTimeline } from "../store/timeline";
import { useUi } from "../store/ui";
import { useStage } from "../stage/viewMode";
import { OK, bumpCommandTick } from "./registry";
import type { Enabled } from "./types";

/**
 * 指令的守門（enabled）：讀 store 的 getState()。
 * 這裡的字串是 zh key，會直接顯示在 tooltip 與 toast 上 —— 每一句都要進 locales（本檔在 TABLE_SOURCES 的 commands/ 下）。
 * 「不灰掉要解釋」：why 講的是「還缺什麼」，不是「按下去會怎樣」。
 */

export function activeId(): string | null {
  return useProject.getState().activeMediaId;
}

export function needsMedia(): Enabled {
  return activeId() ? OK : { ok: false, why: "先開啟一支影片" };
}

/** 要能播 / 看幀：proxy 建好了才行。 */
export function needsProxy(): Enabled {
  const m = needsMedia();
  if (!m.ok) return m;
  const media = selectActiveMedia(useProject.getState());
  if (media?.proxyState === "building") return { ok: false, why: "proxy 還在建，等一下" };
  return media?.proxy ? OK : { ok: false, why: "還沒有 proxy（引擎就緒後會自動建）" };
}

export function needsEngine(): Enabled {
  if (engineReady()) return OK;
  const st = useEngine.getState();
  if (st.pyenv && st.pyenv.state !== "ready") return { ok: false, why: "引擎尚未安裝（說明 › 安裝引擎）" };
  return { ok: false, why: "引擎尚未就緒" };
}

export function selectedTrackId(): string | null {
  return useTimeline.getState().selectedTrackId;
}

/** 選中的 track（任何種類）；沒選 / 不在這支媒體 → null。 */
export function selectedTrackNow(): TrackV1 | null {
  const id = selectedTrackId();
  const mediaId = activeId();
  if (!id || !mediaId) return null;
  return (useEdits.getState().tracks[mediaId] ?? []).find((t) => t.id === id) ?? null;
}

/** 選中了一條 track（平面或物件都行）：刪除這類兩種都適用的動作。 */
export function needsAnyTrack(): Enabled {
  const m = needsMedia();
  if (!m.ok) return m;
  return selectedTrackNow() ? OK : { ok: false, why: "先在時間軸選一條追蹤" };
}

/**
 * 選中了一條**平面** track。關鍵幀 / 解算 / 遮罩提示 / 角釘匯出…全是平面追蹤的動作；
 * 選中的是物件 track 時講清楚去哪裡編輯（外掛的指令用同一個守門，也就跟著擋掉物件）。
 */
export function needsTrack(): Enabled {
  const m = needsMedia();
  if (!m.ok) return m;
  const t = selectedTrackNow();
  if (!t) return { ok: false, why: "先在時間軸選一條追蹤" };
  return t.kind === "object" ? { ok: false, why: "選中的是物件：這個動作只適用平面追蹤（物件在「物件」分頁編輯）" } : OK;
}

/** 選中了一條物件 track。 */
export function needsObjectTrack(): Enabled {
  const m = needsMedia();
  if (!m.ok) return m;
  const t = selectedTrackNow();
  return t?.kind === "object" ? OK : { ok: false, why: "先在「物件」分頁選一個物件" };
}

/** 選中的 track 沒有解算 / 遮罩 job 在跑。 */
export function needsIdleTrack(): Enabled {
  const t = needsTrack();
  if (!t.ok) return t;
  const id = selectedTrackId()!;
  return runningJob("track", undefined, id) || runningJob("mask", undefined, id) ? { ok: false, why: "這條追蹤正在解算中" } : OK;
}

/** 播放線這一幀落在某個鏡頭裡。 */
export function needsShot(): Enabled {
  const m = needsMedia();
  if (!m.ok) return m;
  const shots = useEdits.getState().shots[activeId()!] ?? [];
  return shotAt(shots, usePlayback.getState().frame) ? OK : { ok: false, why: "這一幀不在任何鏡頭裡（先偵測鏡頭）" };
}

export function needsRange(): Enabled {
  const m = needsMedia();
  if (!m.ok) return m;
  return useTimeline.getState().range ? OK : { ok: false, why: "先用 I / O 標一段範圍" };
}

export function needsHistory(dir: "undo" | "redo"): Enabled {
  const d = useEdits.getState();
  const n = dir === "undo" ? d.past.length : d.future.length;
  return n ? OK : { ok: false, why: dir === "undo" ? "還沒有可以復原的動作" : "沒有可以重做的動作" };
}

export function needsKeyframe(): Enabled {
  const t = needsTrack();
  if (!t.ok) return t;
  const tl = useTimeline.getState();
  if (tl.selectedKeyframe) return OK;
  // 沒點選菱形：看播放線這一幀有沒有關鍵幀
  const tr = (useEdits.getState().tracks[activeId()!] ?? []).find((x) => x.id === tl.selectedTrackId);
  return tr?.keyframes.some((k) => k.frame === usePlayback.getState().frame) ? OK : { ok: false, why: "這一幀沒有關鍵幀" };
}

export function needsExportRunning(): Enabled {
  return runningJob("export") ? OK : { ok: false, why: "沒有進行中的輸出" };
}

/**
 * enabled() 讀的東西一變就 bump；只挑會影響「能不能做」的欄位。
 * **排除 playback.frame**（計畫 §8）：rVFC 每幀回寫，訂了它工具列會每幀重算 30 次 getState()。
 * needsShot / needsKeyframe 讀 frame 但不訂閱它 —— 選單開著時它們每次 render 本來就會重算。
 */
let installed = false;
export function installCommandReactivity(): () => void {
  if (installed) return () => {};
  installed = true;
  const uns = [
    useProject.subscribe((s, p) => {
      if (s.activeMediaId !== p.activeMediaId || s.media !== p.media || s.dirty !== p.dirty || s.path !== p.path || s.profile !== p.profile) bumpCommandTick();
    }),
    useEdits.subscribe((s, p) => {
      if (s.shots !== p.shots || s.tracks !== p.tracks || s.pluginMedia !== p.pluginMedia || s.pluginProject !== p.pluginProject || s.past !== p.past || s.future !== p.future) bumpCommandTick();
    }),
    useTimeline.subscribe((s, p) => {
      // pendingIn / pendingOut：只標了一端時「清除入點 / 跳到出點」的可用狀態看它們（範圍選取）
      if (
        s.tool !== p.tool || s.range !== p.range || s.pendingIn !== p.pendingIn || s.pendingOut !== p.pendingOut || s.selectedTrackId !== p.selectedTrackId ||
        s.selectedKeyframe !== p.selectedKeyframe || s.loopRange !== p.loopRange || s.pxPerFrame !== p.pxPerFrame
      )
        bumpCommandTick();
    }),
    usePlayback.subscribe((s, p) => {
      // rate / muted / volume：傳輸列的速度選單與靜音鈕用 checked() 打勾（播放控制）；都是使用者操作才變，不是每幀
      if (s.playing !== p.playing || s.followMode !== p.followMode || s.loop !== p.loop || s.rate !== p.rate || s.muted !== p.muted || s.volume !== p.volume) bumpCommandTick();
    }),
    useEngine.subscribe((s, p) => {
      if (s.info !== p.info || s.pyenv !== p.pyenv) bumpCommandTick();
    }),
    useSettings.subscribe((s, p) => {
      if (s.ffmpeg !== p.ffmpeg || s.s !== p.s || s.loaded !== p.loaded) bumpCommandTick();
    }),
    useUi.subscribe((s, p) => {
      if (s.tab !== p.tab || s.railOpen !== p.railOpen || s.density !== p.density) bumpCommandTick();
    }),
    // 舞台的圖層開關 / 檢視模式（checked() 讀它們）；abFlicker 每次按住放開都會變，不訂
    useStage.subscribe((s, p) => {
      if (s.viewMode !== p.viewMode || s.showMasks !== p.showMasks || s.showSurface !== p.showSurface || s.showGrid !== p.showGrid || s.showTrackHud !== p.showTrackHud || s.darkenImage !== p.darkenImage) bumpCommandTick();
    }),
    useJobs.subscribe((s, p) => {
      if (s.jobs !== p.jobs) bumpCommandTick();
    }),
  ];
  return () => {
    installed = false;
    for (const u of uns) u();
  };
}
