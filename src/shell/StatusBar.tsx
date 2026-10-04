import { useEffect, useState } from "react";
import { APP_NAME } from "../brand";
import { openSettings } from "../commands/appActions";
import { useT } from "../i18n";
import { jobProgressText } from "../pipeline/engineJob";
import { openDialog, openMediaInfo } from "../store/dialogs";
import { engineState, gpuName, useEngine } from "../store/engine";
import { useJobs } from "../store/jobs";
import { usePlayback } from "../store/playback";
import { selectActiveMedia, useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { timecode } from "../time";
import { fpsLabel } from "../video/frames";
import { JOB_KIND_LABEL, PROXY_STATE_LABEL } from "../video/labels";
// M2.15 序列空間的雙時間碼（序列 TC｜來源 TC（k））；素材空間照舊
import SequenceStatusTimecode from "../frametimeline/SequenceStatusTimecode";
// App 自動更新：找到新版才出現（點了開更新對話框）
import UpdateIndicator from "../updater/UpdateIndicator";

function Dot({ tone }: { tone: "ok" | "warn" | "bad" | "off" }) {
  const cls = tone === "ok" ? "bg-success" : tone === "warn" ? "bg-warning" : tone === "bad" ? "bg-danger" : "bg-fg/30";
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${cls}`} aria-hidden />;
}

/** 引擎狀態燈的顏色與人話（計畫 §7.2 Down|Starting|Ready|Broken）。 */
const ENGINE_LABEL = { down: "引擎：未啟動", starting: "引擎：啟動中", ready: "引擎：就緒", broken: "引擎：故障" } as const;
const ENGINE_TONE = { down: "off", starting: "warn", ready: "ok", broken: "bad" } as const;

/**
 * 狀態列：幀 / timecode、fps、proxy 狀態、引擎狀態燈、GPU 名、ffmpeg、進行中的工作、儲存狀態（計畫 §8 StatusBar）。
 * 這是少數訂閱 playback.frame 的元件（每幀重繪本來就是它的工作）。
 */
export default function StatusBar() {
  const t = useT();
  const ffmpeg = useSettings((s) => s.ffmpeg);
  const probeAll = useSettings((s) => s.probeAll);
  const frame = usePlayback((s) => s.frame);
  const playing = usePlayback((s) => s.playing);
  const active = useProject(selectActiveMedia);
  const dirty = useProject((s) => s.dirty);
  const path = useProject((s) => s.path);
  const info = useEngine((s) => s.info);
  const pyenv = useEngine((s) => s.pyenv);
  const jobs = useJobs((s) => s.jobs);
  const running = jobs.filter((j) => j.status === "running" || j.status === "queued");
  const busy = running.length > 0;
  // 「約剩 40 秒」要自己往下走：進度事件之間可能隔好幾秒，沒有這個計時器數字會卡住不動。
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [busy]);

  // 視窗聚焦時每 30 秒重探一次 ffmpeg（引擎狀態走事件，不用探）。
  useEffect(() => {
    const id = window.setInterval(() => {
      // 輕量重探：只看 ffmpeg 還在不在，不重跑 encoder 試編（那個只在啟動與設定頁「偵測」時做）
      if (document.hasFocus()) void probeAll({ encoders: false });
    }, 30_000);
    return () => window.clearInterval(id);
  }, [probeAll]);

  const fps = active?.proxy?.fps ?? active?.probe?.video?.r_frame_rate ?? null;
  const st = engineState({ info });
  const gpu = gpuName({ info, pyenv });
  const head = running[0];

  return (
    <div className="h-7 bg-panel border-t border-fg/10 px-3 flex items-center text-xs text-fg/40 gap-4 min-w-0" data-testid="statusbar">
      <span className="shrink-0">
        {APP_NAME} v{__APP_VERSION__}
      </span>
      {active && (
        <>
          <span className="mono shrink-0 text-fg/70 tabular-nums" title={t("幀號 / timecode")} data-testid="status-frame">
            <SequenceStatusTimecode fallback={fps ? `${timecode(frame, fps)} · ${frame}` : `${frame}`} />
            {playing ? " ▶" : ""}
          </span>
          {/* 點 fps 開媒體資訊（Resolve / Premiere 狀態列點格式也是開 clip 屬性）：VFR、斷層、色彩都在那裡 */}
          {fps && (
            <button type="button" onClick={() => openMediaInfo(active.id)} className="shrink-0 tabular-nums hover:text-fg/70" title={t("媒體資訊…")} data-testid="status-fps">
              {fpsLabel(fps)} fps
            </button>
          )}
          <span className="shrink-0 flex items-center gap-1.5" title={active.error ?? PROXY_STATE_LABEL[active.proxyState]}>
            <Dot tone={active.proxyState === "ready" ? "ok" : active.proxyState === "building" ? "warn" : active.proxyState === "none" ? "off" : "bad"} />
            {t(PROXY_STATE_LABEL[active.proxyState])}
          </span>
        </>
      )}
      <button
        type="button"
        onClick={() => openDialog("engineSetup", {})}
        className="flex items-center gap-1.5 shrink-0 hover:text-fg/70"
        title={info?.last_exc ? `${t(ENGINE_LABEL[st])}\n${info.last_exc}` : pyenv?.message || t(ENGINE_LABEL[st])}
        data-testid="status-engine"
      >
        <Dot tone={ENGINE_TONE[st]} />
        {t(ENGINE_LABEL[st])}
        {gpu && <span className="text-fg/30 truncate max-w-48">· {gpu}</span>}
      </button>
      <button
        type="button"
        onClick={() => openSettings("ffmpeg")}
        className="flex items-center gap-1.5 shrink-0 hover:text-fg/70"
        title={ffmpeg?.found ? `ffmpeg ${ffmpeg.version}\n${ffmpeg.source}：${ffmpeg.ffmpeg_path}` : t("找不到 ffmpeg，點擊到設定指定路徑")}
      >
        <Dot tone={ffmpeg == null ? "off" : ffmpeg.found ? "ok" : "bad"} />
        {ffmpeg?.found ? `ffmpeg ${ffmpeg.version?.split(" ")[0] ?? ""}` : t("找不到 ffmpeg")}
      </button>
      {head && (
        <span className="shrink-0 flex items-center gap-1.5 text-info" title={`${t(JOB_KIND_LABEL[head.kind])}${head.message ? ` · ${head.message}` : ""}`}>
          <Dot tone="warn" />
          {/* 目前在哪一步 + 單調總進度 + 約剩多久（B-14）：整條管線跑一分多鐘，「辨識 53%」既看不出在做物件遮罩，
              百分比還會做完一段就掉回 0%。jobProgressText 產出「物件遮罩（第 4/9 步）· 43% · 約剩 40 秒」。 */}
          {jobProgressText(head, t, tick)}
          {running.length > 1 ? ` (+${running.length - 1})` : ""}
        </span>
      )}
      <UpdateIndicator />
      <span className="ml-auto flex items-center gap-1.5 min-w-0">
        <Dot tone={dirty ? "warn" : "ok"} />
        <span className="shrink-0">{dirty ? t("未儲存") : t("已儲存")}</span>
        {path && (
          <span className="truncate text-fg/30" title={path}>
            {path}
          </span>
        )}
      </span>
    </div>
  );
}
