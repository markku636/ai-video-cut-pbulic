import { api, errMessage } from "../api";
import { APP_NAME, PROJECT_EXT, VIDEO_EXTENSIONS, isProjectPath, isVideoPath } from "../brand";
import { exportTrackData, trackDataExtension, type TrackDataOpts } from "../export/trackData";
import { sequencePlayhead, viewSequenceOf } from "../frametimeline/layoutSequence";
import { t } from "../i18n";
import { propagateMasks, type PropagateDir } from "../pipeline/mask";
import { ensureProxy } from "../pipeline/proxy";
import { clearSolveFrames, quadFromMask as quadFromMaskOp, resolveAround, solveTrack, trackJobRunning } from "../pipeline/track";
import { defaultProjectFileName, type Rational, type ReferencePointV1, type TrackDataFormat, type Quad } from "../project/format";
import { reportSummary } from "../project/sanitize";
import { useEdits, shotAt } from "../store/edits";
import { openDialog, type SettingsFocus } from "../store/dialogs";
import { engineReady } from "../store/engine";
import { nextShuttle, usePlayback } from "../store/playback";
import { activeFrames, selectActiveMedia, useProject } from "../store/project";
import { plugins } from "../plugins/registry";
import { rememberRecent, sequenceEditingEnabled, useSettings } from "../store/settings";
import { confidenceBand, solveAt, useSolves } from "../store/solves";
import { useJobs } from "../store/jobs";
import { effectiveSpace, useTimeline, type FrameRange } from "../store/timeline";
import { useUi, type RailTab } from "../store/ui";
import { timecode } from "../time";
import { clampFrame } from "../video/frames";
import { applyHQuad, rectQuad, type Pt } from "../video/quad";
import { copyToClipboard, pickOpenFile, pickSaveFile, toast } from "../ui";

/**
 * App 層的動作：只碰 store / api / toast / t，不需要 React；指令表、快捷鍵、面板、（M6）MCP 都直接呼叫。
 * 播放控制**只寫 store**（seek / setPlaying）：VideoStage 訂閱 store 去驅動 <video>，這裡不碰 stage/。
 */

export { rememberRecent };

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

// ---- 檔案 ----

export async function openMedia(path?: string): Promise<void> {
  try {
    const p =
      path ??
      (await pickOpenFile([
        { name: t("影片 / 專案"), extensions: [...VIDEO_EXTENSIONS, "json"] },
        { name: t("影片"), extensions: VIDEO_EXTENSIONS },
        { name: t("AI Video Cut 專案"), extensions: ["json"] },
      ]));
    if (!p) return;
    if (isProjectPath(p)) {
      const parsed = await useProject.getState().loadFrom(p);
      rememberRecent(p);
      const dropped = reportSummary(parsed.report);
      if (dropped) {
        const [n, parts] = dropped.split("|");
        toast.info(t("已載入專案，略過 {n} 筆壞掉的資料（{parts}）", { n, parts }));
      } else toast.success(t("已載入專案"));
      // 專案裡的媒體：proxy 缺的補建（引擎沒就緒會靜靜略過）
      for (const m of useProject.getState().media) void ensureProxy(m.id).catch(() => {});
      return;
    }
    if (!isVideoPath(p)) {
      toast.error(t("不支援的檔案：{name}", { name: fileName(p) }));
      return;
    }
    // 開影片 = 這一支重新決定外掛的 session 狀態（例如牌外掛：清掉上一次開始畫面卡片留下的 session 意圖，卡片開完檔才重新設）
    for (const pl of plugins()) pl.lifecycle?.beforeOpenVideo?.();
    const id = await useProject.getState().openMedia(p);
    rememberRecent(p);
    void ensureProxy(id).catch((e) => toast.error(errMessage(e)));
  } catch (e) {
    toast.error(errMessage(e));
  }
}

export async function saveProject(opts?: { as?: boolean }): Promise<void> {
  const st = useProject.getState();
  try {
    let target = opts?.as ? null : st.path;
    if (!target) {
      const name = defaultProjectFileName(selectActiveMedia(st)?.name ?? null);
      target = await pickSaveFile(name, [{ name: t("AI Video Cut 專案"), extensions: ["json"] }]);
      if (!target) return;
      if (!target.toLowerCase().endsWith(PROJECT_EXT)) target = target.replace(/\.json$/i, "") + PROJECT_EXT;
    }
    await st.saveTo(target);
    rememberRecent(target);
    toast.success(t("已儲存"));
  } catch (e) {
    toast.error(errMessage(e));
  }
}

export function openSettings(focus: SettingsFocus = null): void {
  openDialog("settings", { focus });
}

export function openExport(range?: FrameRange | null): void {
  openDialog("export", { range: range ?? null });
}

export function openPath(path: string): void {
  void api.openPath(path).catch((e) => toast.error(errMessage(e)));
}

/** 引擎日誌 `<data_root>/logs/engine.log`；檔還沒生出來就開 logs 資料夾。 */
export async function openLogs(): Promise<void> {
  const paths = useSettings.getState().paths;
  if (!paths) return toast.error(t("還沒拿到 App 路徑"));
  const sep = paths.logs_dir.includes("\\") ? "\\" : "/";
  const file = `${paths.logs_dir}${sep}engine.log`;
  try {
    const [exists] = await api.pathsExist([file]);
    await api.openPath(exists ? file : paths.logs_dir);
  } catch (e) {
    toast.error(errMessage(e));
  }
}

// ---- 播放 ----

export function currentFrame(): number {
  return usePlayback.getState().frame;
}

export function seekTo(frame: number): void {
  const frames = activeFrames();
  usePlayback.getState().seek(frames > 0 ? clampFrame(frame, frames) : Math.max(0, Math.round(frame)));
}

export function stepFrames(n: number): void {
  seekTo(currentFrame() + n);
}

/** J / L 轉盤：倒轉沒有負 playbackRate，靠 stage 的 ticker 逐幀 step（計畫 §8 playerRef）。K 給了關鍵幀，停用 Space。 */
export function shuttle(key: "J" | "K" | "L", opts: { slow: boolean }): void {
  const pb = usePlayback.getState();
  const next = nextShuttle(pb.shuttle, key, opts);
  // 不在這裡寫 playing：store.playing 是 <video> play / pause 事件的鏡射（VideoStage），
  // 轉盤前進時元素一直在播，先寫成 false 會讓時間軸的跟隨捲動以為停了（stage/playerRef.applyShuttle）
  pb.setShuttle(next);
}

/**
 * 標入 / 出點用的「現在這一幀」與對應的 fps。
 *
 * `timeline.range` 的單位跟著空間走（store/timeline 的註解）：序列空間是**序列幀 t**、素材空間是 proxy 幀 k。
 * 以前這裡無條件用 `currentFrame()`（＝playback.frame＝媒體 k），所以在序列空間按 I / O 標出來的範圍座標是錯的，
 * 接著 playRange 播到、extractRange 刪到的都是別的一段（只有「隱含序列」t == k 時碰巧對，因此平常測不出來）。
 * 時間軸上**拖曳**建立的範圍一直是對的（走畫布座標＝當前空間）。
 */
function markPoint(): { frame: number; fps: Rational } | null {
  const media = selectActiveMedia(useProject.getState());
  const mediaFps = media?.proxy?.fps ?? { num: 30, den: 1 };
  if (effectiveSpace(useTimeline.getState().space, sequenceEditingEnabled()) !== "sequence") {
    return { frame: currentFrame(), fps: mediaFps };
  }
  const seq = viewSequenceOf(useEdits.getState().sequence, media ?? null);
  if (!seq) return { frame: currentFrame(), fps: mediaFps };
  const pb = usePlayback.getState();
  const t = sequencePlayhead(seq, useProject.getState().activeMediaId, pb.frame, pb.seqFrame);
  // 這一幀沒有用在序列裡（例如在素材空間 seek 到被剪掉的片段）：標了也指不到東西，講清楚比默默標錯好
  return t === null ? null : { frame: t, fps: seq.fps };
}

export function markIn(): void {
  const p = markPoint();
  if (!p) return void toast.info(t("播放線這一幀沒有用在序列裡"));
  if (!useTimeline.getState().markIn(p.frame)) toast.info(t("入點 {at}　再按 O 標出點", { at: timecode(p.frame, p.fps) }));
}

export function markOut(): void {
  const p = markPoint();
  if (!p) return void toast.info(t("播放線這一幀沒有用在序列裡"));
  if (!useTimeline.getState().markOut(p.frame)) toast.info(t("出點 {at}　再按 I 標入點", { at: timecode(p.frame, p.fps) }));
}

// ---- 選中的 track / 鏡頭 ----

export function selectedTrack() {
  const mediaId = useProject.getState().activeMediaId;
  const id = useTimeline.getState().selectedTrackId;
  if (!mediaId || !id) return null;
  const t = (useEdits.getState().tracks[mediaId] ?? []).find((x) => x.id === id);
  return t ? { mediaId, track: t } : null;
}

/** 選中 track 在某幀的表面：解算得到的 H 投影模板四角；沒有解就退回最近的關鍵幀。 */
export function surfaceAt(trackId: string, frame: number): Quad | null {
  const sel = selectedTrack();
  const tr = sel?.track.id === trackId ? sel.track : null;
  const s = useSolves.getState().byTrack[trackId];
  const f = s ? solveAt(s, frame) : null;
  if (s && f && f.state !== 0 && f.state !== 3) return applyHQuad(f.h, rectQuad(0, 0, s.template.w, s.template.h));
  if (!tr?.keyframes.length) return null;
  let best = tr.keyframes[0];
  for (const k of tr.keyframes) if (Math.abs(k.frame - frame) < Math.abs(best.frame - frame)) best = k;
  return best.quad;
}

/** 依 auto_resolve 設定：釘完就重解相鄰區間（引擎就緒時）。 */
function maybeResolve(mediaId: string, trackId: string, frame: number): void {
  if (!useSettings.getState().s.engine.auto_resolve || !engineReady()) return;
  void resolveAround(mediaId, trackId, frame).catch((e) => toast.error(errMessage(e)));
}

export function setKeyframeAtPlayhead(): void {
  const sel = selectedTrack();
  if (!sel) return;
  const f = currentFrame();
  const q = surfaceAt(sel.track.id, f);
  if (!q) return toast.info(t("這一幀還沒有可用的表面：先拖出一個框"));
  useEdits.getState().setUserKeyframe(sel.mediaId, sel.track.id, f, q);
  maybeResolve(sel.mediaId, sel.track.id, f);
}

/** Delete：選了菱形就刪那個；否則刪播放線這一幀的關鍵幀。 */
export function deleteKeyframe(): void {
  const sel = selectedTrack();
  if (!sel) return;
  const tl = useTimeline.getState();
  const frame = tl.selectedKeyframe?.trackId === sel.track.id ? tl.selectedKeyframe.frame : currentFrame();
  if (!sel.track.keyframes.some((k) => k.frame === frame)) return toast.info(t("這一幀沒有關鍵幀"));
  if (sel.track.keyframes.length === 1) return toast.info(t("這是最後一個關鍵幀：要拿掉整條追蹤請用「刪除追蹤」"));
  useEdits.getState().removeKeyframe(sel.mediaId, sel.track.id, frame);
  tl.selectKeyframe(null);
  maybeResolve(sel.mediaId, sel.track.id, frame);
}

export function deleteTrack(): void {
  const sel = selectedTrack();
  if (!sel) return;
  useEdits.getState().removeTrack(sel.mediaId, sel.track.id);
  useSolves.getState().remove(sel.track.id);
  useTimeline.getState().selectTrack(null);
}

/** 「還原為解算值」＝拿掉這一幀的使用者硬釘，讓解算的結果回來。 */
export function revertFrameToSolved(): void {
  const sel = selectedTrack();
  if (!sel) return;
  const f = currentFrame();
  const kf = sel.track.keyframes.find((k) => k.frame === f);
  if (!kf || kf.source !== "user") return toast.info(t("這一幀沒有使用者硬釘"));
  if (sel.track.keyframes.length === 1) return toast.info(t("這是最後一個關鍵幀：要拿掉整條追蹤請用「刪除追蹤」"));
  useEdits.getState().removeKeyframe(sel.mediaId, sel.track.id, f);
  maybeResolve(sel.mediaId, sel.track.id, f);
}

export function shotCutAtPlayhead(): void {
  const mediaId = useProject.getState().activeMediaId;
  if (!mediaId) return;
  const f = currentFrame();
  if (!useEdits.getState().splitShot(mediaId, f)) toast.info(t("這裡切不了：播放線在鏡頭邊界上，或不在任何鏡頭裡"));
}

export function shotMergeAtPlayhead(): void {
  const mediaId = useProject.getState().activeMediaId;
  if (!mediaId) return;
  const shot = shotAt(useEdits.getState().shots[mediaId] ?? [], currentFrame());
  if (!shot) return toast.info(t("這一幀不在任何鏡頭裡（先偵測鏡頭）"));
  if (!useEdits.getState().mergeShots(mediaId, shot.id)) toast.info(t("這已經是最後一個鏡頭，沒有下一個可以合併"));
}

export function newTrackAtPlayhead(quad?: Quad): void {
  const m = selectActiveMedia(useProject.getState());
  if (!m) return;
  openDialog("newTrack", { frame: currentFrame(), ...(quad ? { quad } : {}) });
}

// ---- 參考影格 / 追蹤傳輸 ----

export function setReferenceFrame(): void {
  const sel = selectedTrack();
  if (!sel) return;
  useEdits.getState().setTrackFields(sel.mediaId, sel.track.id, { referenceFrame: currentFrame() }, "設參考影格");
}

export function goToReferenceFrame(): void {
  const sel = selectedTrack();
  if (!sel) return;
  if (sel.track.referenceFrame == null) return toast.info(t("這條追蹤還沒有參考影格（Shift+K 設定）"));
  seekTo(sel.track.referenceFrame);
}

function guardSolve(): { mediaId: string; trackId: string } | null {
  const sel = selectedTrack();
  if (!sel) return null;
  if (trackJobRunning(sel.track.id)) {
    toast.info(t("這條追蹤正在解算中"));
    return null;
  }
  return { mediaId: sel.mediaId, trackId: sel.track.id };
}

/** 追到頭 / 追到尾 / 從此幀重追（傳輸控制列；絕不為修 12 幀重解 1762 幀）。 */
export function runSolve(mode: "toStart" | "toEnd" | "retrackFwd" | "retrackBwd" | "stepFwd" | "stepBwd" | "resolveAround" | "workBackwards"): void {
  const g = guardSolve();
  if (!g) return;
  const f = currentFrame();
  const p =
    mode === "toEnd"
      ? solveTrack(g.mediaId, g.trackId, { from: f })
      : mode === "toStart"
        ? solveTrack(g.mediaId, g.trackId, { to: f + 1, backwards: true })
        : mode === "retrackFwd"
          ? solveTrack(g.mediaId, g.trackId, { retrackFrom: f })
          : mode === "retrackBwd" || mode === "workBackwards"
            ? solveTrack(g.mediaId, g.trackId, { retrackFrom: f, backwards: true })
            : mode === "stepFwd"
              ? solveTrack(g.mediaId, g.trackId, { from: f, to: f + 2 })
              : mode === "stepBwd"
                ? solveTrack(g.mediaId, g.trackId, { from: Math.max(0, f - 1), to: f + 1, backwards: true })
                : resolveAround(g.mediaId, g.trackId, f);
  void p.catch((e) => toast.error(errMessage(e)));
}

export function stopSolve(): void {
  const sel = selectedTrack();
  if (!sel) return;
  const j = useJobs.getState();
  const running = j.jobs.find((x) => x.trackId === sel.track.id && (x.status === "running" || x.status === "queued"));
  if (running) j.cancel(running.id);
  else toast.info(t("沒有進行中的解算"));
}

/** 清除之前 / 之後 / 全部（前端先砍畫面上的解；引擎那邊下次解算時用 clear_* 同步）。 */
export function clearSolve(which: "backwards" | "forwards" | "all"): void {
  const sel = selectedTrack();
  if (!sel) return;
  const f = currentFrame();
  if (which === "all") {
    useSolves.getState().remove(sel.track.id);
    useEdits.getState().markSolved(sel.mediaId, []);
    return;
  }
  clearSolveFrames(sel.track.id, (x) => (which === "backwards" ? x.k >= f : x.k <= f));
  if (engineReady() && !trackJobRunning(sel.track.id)) {
    void solveTrack(sel.mediaId, sel.track.id, which === "backwards" ? { clearBackwards: f } : { clearForwards: f }).catch(() => {});
  }
}

/** 用遮罩取角（`geom.quad_from_mask`：讀 tracks/<tid>/masks.aivm 的這一幀，SAM 遮罩 → 四角）。 */
export async function quadFromMask(): Promise<void> {
  const sel = selectedTrack();
  if (!sel) return;
  if (!engineReady()) return toast.info(t("引擎尚未就緒"));
  const f = currentFrame();
  try {
    // 目前表面的左上角當參考，讓四角順序（TL,TR,BR,BL）跟表面一致
    const cur = surfaceAt(sel.track.id, f);
    const r = await quadFromMaskOp(sel.mediaId, sel.track.id, f, cur ? cur.p[0] : undefined);
    if (!r) return toast.info(t("這條追蹤還沒有遮罩檔：先加選幾個點再傳播（M）"));
    if (!r.quad || r.quad.length !== 4) return toast.info(t("這一幀的遮罩取不出四角（{method}）", { method: r.method }));
    const quad: Quad = { p: r.quad.map(([x, y]) => [x, y]) as Quad["p"] };
    useEdits.getState().setUserKeyframe(sel.mediaId, sel.track.id, f, quad, { source: "detector", label: "從遮罩取角" });
    toast.info(t("已從遮罩取角（信心 {pct}%）", { pct: Math.round(r.conf * 100) }));
    maybeResolve(sel.mediaId, sel.track.id, f);
  } catch (e) {
    toast.error(errMessage(e));
  }
}

export function propagate(dir: PropagateDir): void {
  const g = guardSolve();
  if (!g) return;
  void propagateMasks(g.mediaId, g.trackId, dir, currentFrame()).catch((e) => toast.error(errMessage(e)));
}

export function clearPromptsAll(): void {
  const sel = selectedTrack();
  if (!sel) return;
  if (!sel.track.prompts.length) return toast.info(t("這條追蹤沒有提示點"));
  useEdits.getState().clearPrompts(sel.mediaId, sel.track.id);
}

// ---- AdjustTrack ----

export function toggleAdjustMode(): void {
  const sel = selectedTrack();
  if (!sel) return;
  const enabled = !sel.track.adjust.enabled;
  useEdits.getState().setTrackFields(sel.mediaId, sel.track.id, { adjust: { ...sel.track.adjust, enabled } }, enabled ? "進入調整追蹤" : "離開調整追蹤");
  // Point Lock 在 M1 後續修正搬到 Alt+L（Shift+L 讓給慢速轉盤），提示文字要跟著改，否則使用者照按會變成往前慢放
  toast.info(enabled ? t("調整追蹤：拖參考點微調、Alt+L 鎖定") : t("已回到追蹤模式"));
}

/** 加一個參考點：吸附到表面的下一個角（0→1→2→3 輪），基準幀 = 現在。 */
export function addReferencePoint(): void {
  const sel = selectedTrack();
  if (!sel) return;
  const f = currentFrame();
  const q = surfaceAt(sel.track.id, f);
  if (!q) return toast.info(t("這一幀還沒有可用的表面：先拖出一個框"));
  const used = new Set(sel.track.adjust.points.filter((p) => p.frame === f).map((p) => p.cornerIndex));
  const corner = ([0, 1, 2, 3] as const).find((i) => !used.has(i));
  if (corner == null) return toast.info(t("這一幀四個角都已經有參考點了"));
  const pt: ReferencePointV1 = { id: `rp-${Date.now().toString(36)}-${corner}`, frame: f, cornerIndex: corner, xy: q.p[corner], locked: false, primaryFrame: f };
  useEdits.getState().setTrackFields(sel.mediaId, sel.track.id, { adjust: { enabled: true, points: [...sel.track.adjust.points, pt] } }, "加參考點");
}

/** Alt+方向鍵：微調這一幀的參考點（1 px；Shift 0.1 px）。沒有參考點就微調表面所有角（＝平移硬釘）。 */
export function nudge(dx: number, dy: number): void {
  const sel = selectedTrack();
  if (!sel) return;
  const f = currentFrame();
  const pts = sel.track.adjust.points.filter((p) => p.frame === f && !p.locked);
  if (pts.length) {
    const ids = new Set(pts.map((p) => p.id));
    const points = sel.track.adjust.points.map((p) => (ids.has(p.id) ? { ...p, xy: [p.xy[0] + dx, p.xy[1] + dy] as Pt } : p));
    useEdits.getState().setTrackFields(sel.mediaId, sel.track.id, { adjust: { ...sel.track.adjust, points } }, "微調參考點");
    return;
  }
  const q = surfaceAt(sel.track.id, f);
  if (!q) return;
  const kf = sel.track.keyframes.find((k) => k.frame === f);
  const locked = kf?.lockedCorners ?? [false, false, false, false];
  const moved: Quad = { p: q.p.map(([x, y], i) => (locked[i] ? [x, y] : [x + dx, y + dy])) as Quad["p"] };
  useEdits.getState().setUserKeyframe(sel.mediaId, sel.track.id, f, moved, { lockedCorners: kf?.lockedCorners, label: "微調表面" });
  maybeResolve(sel.mediaId, sel.track.id, f);
}

/** Point Lock：鎖住這一幀的參考點；沒有參考點就鎖關鍵幀的四個角（全鎖 ↔ 全解）。 */
export function toggleLock(): void {
  const sel = selectedTrack();
  if (!sel) return;
  const f = currentFrame();
  const pts = sel.track.adjust.points.filter((p) => p.frame === f);
  if (pts.length) {
    const allLocked = pts.every((p) => p.locked);
    const points = sel.track.adjust.points.map((p) => (p.frame === f ? { ...p, locked: !allLocked } : p));
    useEdits.getState().setTrackFields(sel.mediaId, sel.track.id, { adjust: { ...sel.track.adjust, points } }, allLocked ? "解除鎖定" : "鎖定參考點");
    return;
  }
  const kf = sel.track.keyframes.find((k) => k.frame === f);
  if (!kf) return toast.info(t("這一幀沒有關鍵幀或參考點可以鎖"));
  const allLocked = kf.lockedCorners?.every(Boolean) ?? false;
  const lockedCorners: [boolean, boolean, boolean, boolean] = allLocked ? [false, false, false, false] : [true, true, true, true];
  useEdits.getState().setUserKeyframe(sel.mediaId, sel.track.id, f, kf.quad, { lockedCorners, source: kf.source, label: allLocked ? "解除鎖定" : "鎖定四角" });
}

export function setPrimaryFrame(): void {
  const sel = selectedTrack();
  if (!sel) return;
  if (!sel.track.adjust.points.length) return toast.info(t("還沒有參考點"));
  const f = currentFrame();
  const points = sel.track.adjust.points.map((p) => ({ ...p, primaryFrame: f }));
  useEdits.getState().setTrackFields(sel.mediaId, sel.track.id, { adjust: { ...sel.track.adjust, points } }, "設主要參考影格");
}

// ---- 導覽 ----

export function stepKeyframe(dir: 1 | -1): void {
  const sel = selectedTrack();
  if (!sel) return;
  const f = currentFrame();
  const ks = sel.track.keyframes.map((k) => k.frame);
  const next = dir > 0 ? ks.find((k) => k > f) : [...ks].reverse().find((k) => k < f);
  if (next == null) return toast.info(dir > 0 ? t("後面沒有關鍵幀了") : t("前面沒有關鍵幀了"));
  seekTo(next);
  useTimeline.getState().selectKeyframe({ trackId: sel.track.id, frame: next });
}

export function stepShot(dir: 1 | -1): void {
  const mediaId = useProject.getState().activeMediaId;
  if (!mediaId) return;
  const shots = useEdits.getState().shots[mediaId] ?? [];
  const f = currentFrame();
  const next = dir > 0 ? shots.find((s) => s.startFrame > f) : [...shots].reverse().find((s) => s.startFrame < f);
  if (!next) return toast.info(dir > 0 ? t("後面沒有鏡頭了") : t("前面沒有鏡頭了"));
  seekTo(next.startFrame);
}

/** Alt+[ ]：直接跳到最差幀（紅 / 琥珀）。 */
export function stepLowConfidence(dir: 1 | -1): void {
  const sel = selectedTrack();
  if (!sel) return;
  const s = useSolves.getState().byTrack[sel.track.id];
  if (!s) return toast.info(t("這條追蹤還沒有解算結果"));
  const f = currentFrame();
  const bad = s.frames.filter((x) => confidenceBand(x) !== "good").map((x) => x.k);
  const next = dir > 0 ? bad.find((k) => k > f) : [...bad].reverse().find((k) => k < f);
  if (next == null) return toast.info(dir > 0 ? t("後面沒有低信心的幀了") : t("前面沒有低信心的幀了"));
  seekTo(next);
}

// ---- 追蹤資料匯出（引擎 export.track；匯出器只有 Python 一份）----

/** 專案 exportDefaults.trackData → export.track 的選項（format 可覆寫）。 */
export function trackDataOptsFromDefaults(format?: TrackDataFormat): TrackDataOpts {
  const td = useProject.getState().exportDefaults.trackData;
  return { format: format ?? td.format, flavour: td.flavour, baked: td.baked, frameOffset: td.frameOffset };
}

/** 複製 Nuke / AE 角釘文字到剪貼簿（選中的 track）。 */
export async function copyTrackData(format: TrackDataFormat): Promise<void> {
  const sel = selectedTrack();
  if (!sel) return;
  if (!engineReady()) return toast.info(t("引擎尚未就緒"));
  try {
    const r = await exportTrackData(sel.mediaId, sel.track.id, trackDataOptsFromDefaults(format));
    if (!r.text || !r.keys) return toast.info(t("沒有可匯出的幀（全部 lost）"));
    await copyToClipboard(r.text, format === "nuke" ? t("已複製 Nuke CornerPin2D（{n} 個 key）", { n: r.keys }) : t("已複製 After Effects 關鍵幀（{n} 個 key）", { n: r.keys }));
  } catch (e) {
    toast.error(errMessage(e));
  }
}

/** 存成檔案（ExportTrackDataDialog 的「存成檔案」）：選路徑 → 引擎直接寫檔（UTF-8、無 BOM、LF）。 */
export async function saveTrackDataFile(mediaId: string, trackId: string, opts: TrackDataOpts, baseName: string): Promise<boolean> {
  const ext = trackDataExtension(opts.format);
  const target = await pickSaveFile(`${baseName}.${ext}`, [{ name: opts.format === "nuke" ? "Nuke" : "After Effects", extensions: [ext] }]);
  if (!target) return false;
  try {
    const r = await exportTrackData(mediaId, trackId, { ...opts, out: target });
    toast.success(t("已存成 {name}（{n} 個 key）", { name: fileName(r.out ?? target), n: r.keys }));
    return true;
  } catch (e) {
    toast.error(errMessage(e));
    return false;
  }
}

// ---- 其他 ----

export function openRailTab(tab: RailTab): void {
  useUi.getState().setTab(tab);
}

/** 視窗標題：`<專案檔名>[ •] — AI Video Cut`。 */
export function appTitle(): string {
  const p = useProject.getState();
  return p.path ? `${fileName(p.path)}${p.dirty ? " •" : ""} — ${APP_NAME}` : APP_NAME;
}
