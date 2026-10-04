// 開發用的時間線記錄：把「App 走到哪一步」送進 Rust 的 client_log（tauri dev 終端 / 導向的 log 檔看得到）。
//
// 為什麼需要：前端平常只在出錯時 client_log。整合煙霧測試第一次跑的時候，pipeline.run 在 detect 之後卡了四小時，
// 終端上一行都沒有 —— 卡住的工作沒有錯誤可印，看起來跟「還沒開始」一模一樣。這裡把每個狀態轉換都印出來：
// 設定載入、pyenv、引擎狀態與 hello、媒體加入、proxy 狀態、每個 job 的狀態變化、引擎的 progress / log / artifact 事件、
// 每一筆 undo commit、專案檔路徑。
//
// 只在 `import.meta.env.DEV` 由 devBridge 掛上（正式打包 tree-shake 掉）。progress 事件每個 job 每 5 秒最多一行、
// stage 變了立刻印，免得把終端灌爆。
import { listen } from "@tauri-apps/api/event";
import { api, type EngineArtifactEvent, type EngineLogEvent, type EngineProgress } from "./api";
import { plugins } from "./plugins/registry";
import { useEdits } from "./store/edits";
import { useEngine } from "./store/engine";
import { useJobs } from "./store/jobs";
import { useProject } from "./store/project";
import { useSettings } from "./store/settings";

const PROGRESS_EVERY_MS = 5000;

function line(s: string): void {
  void api.clientLog(`[dev ${new Date().toISOString().slice(11, 23)}] ${s}`).catch(() => {});
}

let installed = false;

export function installDevLog(): void {
  if (installed) return;
  installed = true;
  line(`devLog installed; href=${location.href} visibility=${document.visibilityState}`);

  useSettings.subscribe((s, p) => {
    if (s.loaded && !p.loaded) {
      // 外掛的設定鍵（例如 cards 的「deck=<牌組 id>」）接在 lang 後面，位置跟以前一樣
      const extra = plugins()
        .map((pl) => pl.dev?.settingsInfo?.(s.s))
        .filter(Boolean)
        .map((x) => ` ${x}`)
        .join("");
      line(`settings loaded lang=${s.s.lang}${extra} ffmpeg_path=${s.s.ffmpeg_path ?? "(auto)"} recent=${s.s.recent_projects.length}`);
    }
    if (s.paths && s.paths !== p.paths) line(`app_paths ${JSON.stringify(s.paths)}`);
    if (s.ffmpeg && s.ffmpeg !== p.ffmpeg) line(`ffmpeg found=${s.ffmpeg.found} version=${s.ffmpeg.version} source=${s.ffmpeg.source} usable=[${s.ffmpeg.usable.join(",")}]`);
  });

  useEngine.subscribe((s, p) => {
    if (s.pyenv && s.pyenv !== p.pyenv) line(`pyenv state=${s.pyenv.state} device=${s.pyenv.device} torch=${s.pyenv.torch} cuda=${s.pyenv.cuda} lock_ok=${s.pyenv.lock_ok} msg=${s.pyenv.message}`);
    if (s.state !== p.state) line(`engine state ${p.state} -> ${s.state} pid=${s.info?.pid ?? "-"} hello=${JSON.stringify(s.info?.hello ?? null)}${s.info?.last_exc ? ` last_exc=${s.info.last_exc}` : ""}`);
    const q = s.info?.queued.join(",") ?? "";
    const r = s.info?.running.join(",") ?? "";
    if (q !== (p.info?.queued.join(",") ?? "") || r !== (p.info?.running.join(",") ?? "")) line(`engine jobs queued=[${q}] running=[${r}]`);
    if (s.error && s.error !== p.error) line(`engine error ${s.error}`);
  });

  useProject.subscribe((s, p) => {
    for (const m of s.media) {
      const prev = p.media.find((x) => x.id === m.id);
      if (!prev) {
        const v = m.probe?.video;
        line(`media added id=${m.id} fp=${m.fingerprint.slice(0, 16)}… path=${m.path} video=${v ? `${v.width}x${v.height} ${v.codec} r=${v.r_frame_rate.num}/${v.r_frame_rate.den} nb_frames=${v.nb_frames}` : "none"} duration_ms=${m.probe?.duration_ms}`);
      } else if (prev.proxyState !== m.proxyState || prev.proxy !== m.proxy) {
        line(`media ${m.id} proxyState ${prev.proxyState} -> ${m.proxyState}${m.proxy ? ` proxy=${m.proxy.width}x${m.proxy.height} frames=${m.proxy.frames} fps=${m.proxy.fps.num}/${m.proxy.fps.den} path=${m.proxy.path}` : ""}${m.error ? ` error=${m.error}` : ""}`);
      }
    }
    if (s.activeMediaId !== p.activeMediaId) line(`activeMediaId ${p.activeMediaId} -> ${s.activeMediaId}`);
    if (s.path !== p.path) line(`project path ${p.path} -> ${s.path}`);
    if (s.dirty !== p.dirty && !s.dirty && s.path) line(`project saved ${s.path}`);
  });

  useEdits.subscribe((s, p) => {
    if (s.past === p.past || s.past.length === 0) return;
    const top = s.past[s.past.length - 1];
    if (p.past[p.past.length - 1] === top) return;
    const id = top.mediaId;
    // 外掛可以在這一行後面加自己的數字（例如 cards 的「slots=4」）
    const extra = plugins()
      .map((pl) => pl.dev?.commitInfo?.(id))
      .filter(Boolean)
      .map((x) => ` ${x}`)
      .join("");
    line(`edit commit "${top.label}" media=${id} shots=${(s.shots[id] ?? []).length} tracks=${(s.tracks[id] ?? []).length}${extra}`);
  });

  useJobs.subscribe((s, p) => {
    for (const j of s.jobs) {
      const prev = p.jobs.find((x) => x.id === j.id);
      if (!prev) line(`job new ${j.kind} ${j.id} status=${j.status} step=${j.step}`);
      else if (prev.status !== j.status) line(`job ${j.kind} ${j.id} ${prev.status} -> ${j.status}${j.error ? ` error=${j.error}` : ""} (${Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000)}s)`);
      else if (prev.step !== j.step) line(`job ${j.kind} ${j.id} step "${prev.step}" -> "${j.step}"`);
    }
  });

  const lastAt = new Map<string, { at: number; stage: string; step: string }>();
  void listen<EngineProgress>("engine-progress", (ev) => {
    const e = ev.payload;
    const now = Date.now();
    const prev = lastAt.get(e.job_id);
    const step = typeof e.step === "string" ? e.step : "";
    if (prev && prev.stage === e.stage && prev.step === step && now - prev.at < PROGRESS_EVERY_MS) return;
    lastAt.set(e.job_id, { at: now, stage: e.stage, step });
    const extra = Object.entries(e)
      .filter(([k]) => !["job_id", "stage", "done", "total", "pct", "step"].includes(k))
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
      .join(" ");
    line(`progress ${e.job_id} stage=${e.stage}${step ? ` step=${step}` : ""} ${e.done ?? "?"}/${e.total ?? "?"} pct=${typeof e.pct === "number" ? e.pct.toFixed(1) : "-"}${extra ? ` ${extra}` : ""}`);
  }).catch(() => {});
  void listen<EngineLogEvent>("engine-log", (ev) => line(`engine-log ${ev.payload.job_id} [${ev.payload.level}] ${ev.payload.message}`)).catch(() => {});
  void listen<EngineArtifactEvent>("engine-artifact", (ev) => line(`artifact ${ev.payload.job_id} kind=${ev.payload.kind} ${ev.payload.path}`)).catch(() => {});
}

/** App.tsx 的 dev 煙霧鉤子用：一行時間線。 */
export const devLine = line;
