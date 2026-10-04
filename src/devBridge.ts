// 開發用的自動化橋接：把幾個 store 與管線函式掛到 window.__aivc，
// 讓 CDP（WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222）能無視窗驅動與量測 UI 行為
//（scripts/measure 的 .mjs 量尺走這裡；計畫 §11）。
//
// 只在 `import.meta.env.DEV` 掛載 —— 正式打包時 main.tsx 的 if 會被 tree-shake 掉，window 上不會有任何東西。
// 這是 AIVC_DEV_* 煙霧鉤子的延伸：那些只能「開檔 / 追一條」，這裡可以量到毫秒與幀。
//
// 這幾個 store 一定要從**這裡**拿。自動化腳本手動 import("/src/store/x.ts") 會拿到
// 另一個模組實例（熱更新之後 App 用的是帶 ?t= 的網址），寫進去的值 App 根本讀不到 ——
// 量出來像是功能壞了，其實是在對一個平行世界說話。
import * as A from "./commands/appActions";
import { installDevLog } from "./devLog";
import { runCommand, useCommands } from "./commands/registry";
import { useLang } from "./i18n";
import { exportTrackData } from "./export/trackData";
import { runEngineJob } from "./pipeline/engineJob";
import { exportVideo, planExport } from "./pipeline/exportVideo";
import { propagateMasks } from "./pipeline/mask";
import { projectFileFor } from "./pipeline/project";
import { detectShots, ensureProxy } from "./pipeline/proxy";
import { loadSolve, quadFromMask, resolveAround, solveTrack } from "./pipeline/track";
import { tickCount, tickRunning } from "./preview/ticker";
import { useDialogs } from "./store/dialogs";
import { useEdits } from "./store/edits";
import { useEngine } from "./store/engine";
import { useJobs } from "./store/jobs";
import { useMasks } from "./store/masks";
import { usePlayback } from "./store/playback";
import { useProject } from "./store/project";
import { useSettings } from "./store/settings";
import { useProjectExtras } from "./store/projectExtras";
import { useSolves } from "./store/solves";
import { useTimeline } from "./store/timeline";
import { plugins } from "./plugins/registry";
import { useUi } from "./store/ui";
import { useStage } from "./stage/viewMode";

export interface DevBridge {
  playback: typeof usePlayback;
  timeline: typeof useTimeline;
  stage: typeof useStage;
  ui: typeof useUi;
  project: typeof useProject;
  edits: typeof useEdits;
  solves: typeof useSolves;
  masks: typeof useMasks;
  settings: typeof useSettings;
  engine: typeof useEngine;
  jobs: typeof useJobs;
  dialogs: typeof useDialogs;
  lang: typeof useLang;
  /** 專案檔頂層的 extras（核心不認得的鍵，外掛的標記之類）。 */
  projectExtras: typeof useProjectExtras;
  /** 指令註冊表：`runCommand("track.setKeyframe", "bridge")`。 */
  commands: typeof useCommands;
  runCommand: typeof runCommand;
  actions: typeof A;
  pipeline: {
    ensureProxy: typeof ensureProxy;
    detectShots: typeof detectShots;
    solveTrack: typeof solveTrack;
    resolveAround: typeof resolveAround;
    loadSolve: typeof loadSolve;
    quadFromMask: typeof quadFromMask;
    propagateMasks: typeof propagateMasks;
    planExport: typeof planExport;
    exportVideo: typeof exportVideo;
    exportTrackData: typeof exportTrackData;
    projectFileFor: typeof projectFileFor;
    runEngineJob: typeof runEngineJob;
    /** 外掛多掛的管線函式（例如 cards 的 runPipeline / detectCards…；plugins/api.ts dev.pipeline）。 */
    [plugin: string]: unknown;
  };
  ticker: () => { count: number; running: boolean };
  /**
   * seek 到某幀並等 rVFC 回寫（量 seek-accuracy：要求誤差 0 幀）。回實際停在哪一幀與花了多久。
   * 超時 2 s 回 -1 —— 沒有 proxy 或 <video> 還沒掛上。
   */
  measureSeek: (frame: number) => Promise<{ requested: number; landed: number; wallMs: number }>;
  /** 外掛多掛的東西（例如 cards 的 deal / vdTimeline / deckFaces / dealActions / cardEdits；plugins/api.ts dev.bridge）。 */
  [plugin: string]: unknown;
}

export function installDevBridge() {
  installDevLog();
  const measureSeek: DevBridge["measureSeek"] = (frame) =>
    new Promise((resolve) => {
      const t0 = performance.now();
      const target = Math.max(0, Math.round(frame));
      let done = false;
      const finish = (landed: number) => {
        if (done) return;
        done = true;
        un();
        window.clearTimeout(timer);
        resolve({ requested: target, landed, wallMs: performance.now() - t0 });
      };
      const un = usePlayback.subscribe((s, p) => {
        // seek 之後第一次 frame 變動（或已經在目標幀）就是「落地」
        if (s.frame !== p.frame || s.frame === target) finish(s.frame);
      });
      const timer = window.setTimeout(() => finish(-1), 2000);
      usePlayback.getState().seek(target);
    });

  (window as unknown as { __aivc: DevBridge }).__aivc = {
    playback: usePlayback,
    timeline: useTimeline,
    stage: useStage,
    ui: useUi,
    project: useProject,
    edits: useEdits,
    solves: useSolves,
    masks: useMasks,
    settings: useSettings,
    engine: useEngine,
    jobs: useJobs,
    dialogs: useDialogs,
    lang: useLang,
    projectExtras: useProjectExtras,
    commands: useCommands,
    runCommand,
    actions: A,
    pipeline: { ensureProxy, detectShots, solveTrack, resolveAround, loadSolve, quadFromMask, propagateMasks, planExport, exportVideo, exportTrackData, projectFileFor, runEngineJob, ...Object.assign({}, ...plugins().map((p) => p.dev?.pipeline?.() ?? {})) },
    ticker: () => ({ count: tickCount(), running: tickRunning() }),
    measureSeek,
    ...Object.assign({}, ...plugins().map((p) => p.dev?.bridge?.() ?? {})),
  };
}
