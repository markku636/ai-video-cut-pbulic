import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, errMessage } from "./api";
import { installMcpBridge } from "./assistant/mcpBridge";
import { isProjectPath, isVideoPath } from "./brand";
import { installCommands } from "./commands";
import * as A from "./commands/appActions";
import { installHotkeys } from "./hotkeys";
import { importDroppedAudio } from "./pipeline/audio";
import { devExportSmoke, type AudioMode } from "./pipeline/exportVideo";
import { installStagePreview } from "./pipeline/stagePreview";
import { installFxPreview } from "./pipeline/fxPreview";
import { plugins } from "./plugins/registry";
import DialogHost from "./shell/DialogHost";
import McpApprovalHost from "./shell/McpApprovalHost";
import ProShell from "./shell/ProShell";
import { hideBootSplash } from "./shell/splash";
import { installAutosave } from "./store/autosave";
import { installEngineListeners } from "./store/engine";
import { useEdits } from "./store/edits";
import { useProject } from "./store/project";
import { useSettings } from "./store/settings";
import { useUi } from "./store/ui";
import { useStage } from "./stage/viewMode";
import { applyAppTheme, useTheme } from "./theme";
import { UiHost } from "./ui";
// App 自動更新：背景檢查（啟動後約 10 秒、一天最多一次），不擋啟動
import { installUpdater } from "./updater/store";

let devAutoOpened = false;

/**
 * App 根：啟動效果 + 唯一的殼。所有「動作」在 commands/（指令註冊表），所有對話框在 DialogHost。
 * 根層不掛 <video>：VideoStage 在 Workspace 裡（計畫 §8 App.tsx）。
 */
export default function App() {
  // 指令註冊表 + 反應性訂閱（冪等，StrictMode 跑兩次沒關係）
  useEffect(() => installCommands(), []);

  // 啟動：套主題、載設定、探工具狀態、撤開場畫面。
  useEffect(() => {
    applyAppTheme(useTheme.getState().themeId);
    void useSettings.getState().load();
    // React 已掛載 → 撤掉 index.html 的開場畫面。直接 remove() 的話，開場動畫在快的機器上只會閃一下，
    // 所以**從視窗出現算起**（不是從網頁開始載入）至少讓它待滿 SPLASH_MIN_MS 再淡出；細節見 shell/splash.ts。
    hideBootSplash();
    // dev 煙霧測試：AIVC_DEV_OPEN=<影片或專案> [AIVC_DEV_TRACK=1（整條 pipeline.run，不渲染）] [AIVC_DEV_EXPORT=<out.mp4>] npm run tauri dev
    void (async () => {
      if (devAutoOpened) return; // React StrictMode 會跑兩次 effect
      devAutoOpened = true;
      const p = await api.devEnv("AIVC_DEV_OPEN").catch(() => null);
      if (!p) return;
      const log = (tag: string) => (e: unknown) => void api.clientLog(`[dev ${tag}] ${errMessage(e)}`).catch(() => {});
      void api.clientLog(`[dev open] AIVC_DEV_OPEN=${p}`).catch(() => {});
      await A.openMedia(p);
      const id = useProject.getState().activeMediaId;
      void api.clientLog(`[dev open] activeMediaId=${id ?? "(none)"}`).catch(() => {});
      if (!id) return;
      if (await api.devEnv("AIVC_DEV_TRACK").catch(() => null)) {
        void api.clientLog(`[dev pipeline] start media=${id}`).catch(() => {});
        // 整條自動偵測由外掛提供（例如 cards 的 pipeline.run）；沒有外掛就只是開檔
        const run = plugins().find((pl) => pl.dev?.autoTrack)?.dev?.autoTrack;
        const r = run ? await run(id).catch(log("pipeline")) : null;
        if (r) void api.clientLog(r).catch(() => {});
        else if (!(useEdits.getState().tracks[id] ?? []).length) void api.clientLog("[dev pipeline] 沒有任何追蹤").catch(() => {});
      }
      const out = await api.devEnv("AIVC_DEV_EXPORT").catch(() => null);
      if (out) {
        const d = useProject.getState().exportDefaults;
        // M2.17：專案有序列就輸出序列（引擎 sequence=auto），重新渲染時接著驗收幀數與音訊樣本數，結果寫進日誌
        const lines = await devExportSmoke(id, { outPath: out, range: null, codec: d.codec || null, quality: d.quality, audio: (d.audio as AudioMode) || null }).catch(log("export"));
        for (const line of lines ?? []) void api.clientLog(line).catch(() => {});
      }
    })();
  }, []);

  // 引擎 / pyenv 狀態事件。
  //
  // `cancelled` 不是可有可無的防禦，是這裡的**正確性條件**：installEngineListeners 是非同步的，
  // 而 StrictMode 在 dev 會 mount → unmount → mount。第一次的 cleanup 跑在 promise 解決之前，
  // 那時 `un` 還是 undefined，於是什麼都沒拆；兩份監聽都留下來，每個事件都會處理兩次。
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    installEngineListeners()
      .then((f) => {
        if (cancelled) f();
        else un = f;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  // 內建 MCP server 的工具表 + 工具呼叫（claude / codex CLI 或使用者自己的工作階段呼叫 → 這裡執行 → 回寫）。
  // cancelled 的理由同上（StrictMode 的非同步競態會留下兩份監聽 = 每個工具跑兩次）。
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    installMcpBridge()
      .then((f) => {
        if (cancelled) f();
        else un = f;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  // 自動儲存：專案已有路徑且有未存的變更 → 最後一次編輯後 2 秒、持續編輯最晚 10 秒存一次；失敗提示一次。
  useEffect(() => installAutosave(), []);
  useEffect(() => installStagePreview(), []);
  useEffect(() => installUpdater(), []);
  // 效果 / 替換的舞台預覽（fx.preview / comp.preview_composite）
  useEffect(() => installFxPreview(), []);

  // 視窗標題跟著專案檔名 / dirty 走。
  useEffect(() => {
    const apply = () => {
      // 每筆編輯都會通知（rev +1），標題沒變就不碰 DOM
      const next = A.appTitle();
      if (document.title !== next) document.title = next;
    };
    apply();
    return useProject.subscribe(apply);
  }, []);

  // 拖放影片 / 專案檔 / 音訊檔（其他副檔名靜靜忽略，不 toast —— 拖一個資料夾進來不該被罵）。
  useEffect(() => {
    let un: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((ev) => {
        const ui = useUi.getState();
        if (ev.payload.type === "enter" || ev.payload.type === "over") {
          if (!ui.dragOver) ui.setDragOver(true);
          return;
        }
        ui.setDragOver(false);
        if (ev.payload.type !== "drop") return;
        // 音訊檔（M2.14）：序列剪輯旗標開著才收，放在放下的位置；旗標關著照舊靜靜忽略。
        // Tauri 給的是實體像素，elementFromPoint 要 CSS px（高 DPI 螢幕上差 1.5～2 倍，會放到別條軌）
        const dpr = window.devicePixelRatio || 1;
        importDroppedAudio(ev.payload.paths, { x: ev.payload.position.x / dpr, y: ev.payload.position.y / dpr });
        for (const p of ev.payload.paths) {
          if (isVideoPath(p) || isProjectPath(p)) void A.openMedia(p);
        }
      })
      .then((f) => {
        un = f;
      })
      .catch(() => {});
    return () => un?.();
  }, []);

  // 快捷鍵：絕大多數由指令註冊表派發；只有 J/L、Alt+方向鍵、`\` 手寫。
  useEffect(
    () =>
      installHotkeys({
        shuttle: A.shuttle,
        nudge: A.nudge,
        abFlicker: (down) => useStage.getState().setAbFlicker(down),
      }),
    [],
  );

  return (
    <div className="h-full flex flex-col">
      <ProShell />
      <DialogHost />
      <McpApprovalHost />
      <UiHost />
    </div>
  );
}
