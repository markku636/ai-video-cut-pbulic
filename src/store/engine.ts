import { create } from "zustand";
import { api, errMessage, listenEngineState, listenPyEnvStatus, type AppPlatform, type EngineInfo, type EngineStateKind, type PyEnvStatus } from "../api";
import type { Params } from "../i18n";

/**
 * 引擎監督狀態（計畫 §7.2）+ 受管 Python 環境狀態（§7.1）+ 建置平台（`app_platform`）。**在 undo 之外**、不進專案檔。
 *
 * 來源：
 * - 指令回傳（engine_state / pyenv_status / app_platform）—— 啟動時拉一次；
 * - 事件（engine-state / pyenv-status）—— Rust 端狀態一變就推，StatusBar 的燈與 SetupBanner 靠它。
 *
 * `state / gpuName / message` 是攤平的衍生欄位（stage/_contracts.ts 的 EngineStateLike 要這三個名字），
 * 每次 info / pyenv 變動就重算，元件可以直接訂閱不用自己推。
 * GPU 名字優先拿 pyenv 的 `device`（nvidia-smi / sysctl 補的，引擎沒起來也有），其次 hello 的 `device`。
 */
interface EngineStore {
  info: EngineInfo | null;
  pyenv: PyEnvStatus | null;
  /** 建置目標（OS / 架構 / 是否內建 ffmpeg）；還沒問到或非 Tauri 環境是 null，helper 會退回「不猜平台」的文字。 */
  platform: AppPlatform | null;
  /** 衍生：引擎狀態；還沒問到 Rust 之前當作 down。 */
  state: EngineStateKind;
  /** 衍生：GPU 名（"NVIDIA GeForce RTX 5070 Ti"）；沒有就 null。 */
  gpuName: string | null;
  /** 衍生：人話（死因 / pyenv 訊息）。 */
  message: string | null;
  /** 正在探 pyenv（venv python 跑 import torch 要幾秒）。 */
  probing: boolean;
  /** 最近一次 start/stop 的錯誤（人話）。 */
  error: string | null;
  refresh: () => Promise<void>;
  probePyEnv: () => Promise<void>;
  /** 問一次 `app_platform`（值在建置時就定了，拿到後不再問）。 */
  loadPlatform: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  /** 使用者主動重啟（清 Broken）；= start。 */
  restart: () => Promise<void>;
  setInfo: (info: EngineInfo) => void;
  setPyEnv: (st: PyEnvStatus) => void;
}

function derive(info: EngineInfo | null, pyenv: PyEnvStatus | null): Pick<EngineStore, "state" | "gpuName" | "message"> {
  const d = pyenv?.device ?? (typeof info?.hello?.device === "string" ? info.hello.device : null);
  return {
    state: info?.state ?? "down",
    gpuName: d && d.trim() ? d : null,
    message: info?.last_exc ?? (pyenv?.message?.trim() ? pyenv.message : null),
  };
}

/** 進行中的 app_platform 呼叫：StrictMode 的 dev 雙 mount 會叫兩次 installEngineListeners，共用同一個 promise。 */
let platformLoading: Promise<void> | null = null;

export const useEngine = create<EngineStore>((set, get) => {
  const put = (patch: { info?: EngineInfo | null; pyenv?: PyEnvStatus | null }) =>
    set((s) => {
      const info = patch.info === undefined ? s.info : patch.info;
      const pyenv = patch.pyenv === undefined ? s.pyenv : patch.pyenv;
      return { info, pyenv, ...derive(info, pyenv) };
    });
  return {
    info: null,
    pyenv: null,
    platform: null,
    ...derive(null, null),
    probing: false,
    error: null,
    refresh: async () => {
      try {
        put({ info: await api.engineState() });
      } catch {
        /* 非 Tauri 環境 */
      }
    },
    probePyEnv: async () => {
      if (get().probing) return;
      set({ probing: true });
      try {
        put({ pyenv: await api.pyenvStatus() });
      } catch {
        /* 非 Tauri 環境 / 指令失敗：保留舊值 */
      } finally {
        set({ probing: false });
      }
    },
    loadPlatform: () => {
      if (get().platform) return Promise.resolve();
      return (platformLoading ??= api
        .appPlatform()
        .then((platform) => set({ platform }))
        .catch(() => {
          /* 非 Tauri 環境（vite preview）：留 null，畫面用不分平台的文字 */
        })
        .finally(() => {
          // 失敗時清掉，之後再叫還有機會重試；成功後靠上面的 platform 短路
          platformLoading = null;
        }));
    },
    start: async () => {
      set({ error: null });
      try {
        put({ info: await api.engineStart() });
      } catch (e) {
        set({ error: errMessage(e) });
        throw e;
      }
    },
    stop: async () => {
      try {
        put({ info: await api.engineStop() });
      } catch (e) {
        set({ error: errMessage(e) });
      }
    },
    restart: () => get().start(),
    setInfo: (info) => put({ info }),
    setPyEnv: (pyenv) => put({ pyenv }),
  };
});

/** 目前引擎狀態；還沒問到 Rust 之前當作 down。 */
export function engineState(s: Pick<EngineStore, "info"> = useEngine.getState()): EngineStateKind {
  return s.info?.state ?? "down";
}

export function engineReady(): boolean {
  return engineState() === "ready";
}

/** pyenv 裝好且閘門過了（missing / stale / broken 都不算）。 */
export function pyenvReady(s: Pick<EngineStore, "pyenv"> = useEngine.getState()): boolean {
  return s.pyenv?.state === "ready";
}

export function gpuName(s: Pick<EngineStore, "info" | "pyenv"> = useEngine.getState()): string | null {
  return derive(s.info, s.pyenv).gpuName;
}

/**
 * 掛事件監聽 + 拉一次初始狀態。回傳的 promise 解出拆除函式；
 * 呼叫端要用 App.tsx 的 `cancelled` 旗標處理 StrictMode 的 mount → unmount → mount。
 */
export async function installEngineListeners(): Promise<() => void> {
  const st = useEngine.getState();
  const uns = await Promise.all([listenEngineState(st.setInfo), listenPyEnvStatus(st.setPyEnv)]).catch(() => [] as (() => void)[]);
  void st.loadPlatform();
  void st.refresh();
  void st.probePyEnv();
  return () => {
    for (const u of uns) u();
  };
}

// ---------------- 依平台的提示（純函式；SetupBanner / EngineSetupDialog 用，單元測試直接釘） ----------------

/**
 * i18n 的 `t` 形狀。helper 收呼叫端傳進來的 t（元件裡是 useT() 那一個，切語言才會重繪），而不是自己 import 模組層的 t；
 * 呼叫時第一個參數一律直接寫中文字串字面量（不要先存變數），scripts/check-i18n.mjs 才掃得到、漏翻會 exit 1。
 */
export type Translate = (zh: string, params?: Params) => string;

export type PlatformFamily = "windows" | "macos" | "linux" | "unknown";

/**
 * 決定用哪一套提示。`app_platform` 還沒回（或非 Tauri 環境）時不猜 —— 唯一的例外是 pyenv 已經回報 MPS 可用，
 * 那一定是 Apple Silicon Mac（Windows / Linux 的偵測腳本 mps 永遠 false），先切到 Mac 的列，免得閃一下 NVIDIA 警告。
 */
export function platformFamily(platform: Pick<AppPlatform, "os"> | null | undefined, pyenv?: Pick<PyEnvStatus, "mps"> | null): PlatformFamily {
  switch (platform?.os) {
    case "windows":
      return "windows";
    case "macos":
      return "macos";
    case "linux":
      return "linux";
  }
  return !platform && pyenv?.mps ? "macos" : "unknown";
}

/**
 * ffmpeg 安裝指令。字面值集中在這裡：README 與 bootstrap-engine.sh 的提示改了要一起改，測試釘住它們。
 * - apt 多裝兩個 GStreamer 套件：Linux 的 WebKitGTK 預覽走 GStreamer 解碼，缺 libav / good 外掛時 proxy.mp4 會黑畫面；
 *   deb 安裝檔的 Depends 已經列了，這行是給 AppImage 使用者的。
 * - Fedora 官方庫只有 ffmpeg-free，完整的 ffmpeg 在 RPM Fusion，要先啟用那個庫。
 */
export const FFMPEG_INSTALL_CMD = {
  brew: "brew install ffmpeg",
  apt: "sudo apt install ffmpeg gstreamer1.0-libav gstreamer1.0-plugins-good",
  dnf: "sudo dnf install ffmpeg",
} as const;

export interface InstallCommand {
  id: keyof typeof FFMPEG_INSTALL_CMD;
  /** 套件管理器 / 發行版名稱（專有名詞，不翻）。 */
  label: string;
  cmd: string;
  /** 執行前要先做的事（沒有 Homebrew、要先開 RPM Fusion）；null = 直接貼上就能跑。 */
  note: string | null;
}

/**
 * 找不到 ffmpeg 時該叫使用者做什麼：
 * - `reinstall`：這個平台的安裝檔內建 ffmpeg（Windows）。解析順序是 自訂 → 內建 → PATH → 常見目錄，
 *   連內建都找不到代表安裝目錄壞了（被防毒隔離 / 檔案被刪）。叫使用者另外裝 ffmpeg 只是治標，還會改用 PATH 上
 *   沒驗過編碼能力的 build（Windows 刻意用內建的 LGPL 版），所以講「重新安裝」；
 * - `install`：macOS / Linux 不內建，給能直接複製貼上的指令；
 * - `unknown`：平台還沒問到，只講「找不到」與「指定路徑」，不亂給指令。
 */
export type FfmpegFix = { kind: "reinstall" } | { kind: "install"; commands: InstallCommand[] } | { kind: "unknown" };

export function ffmpegFix(platform: AppPlatform | null | undefined, t: Translate): FfmpegFix {
  if (!platform) return { kind: "unknown" };
  if (platform.bundled_ffmpeg) return { kind: "reinstall" };
  switch (platformFamily(platform)) {
    case "macos":
      return { kind: "install", commands: [{ id: "brew", label: "Homebrew", cmd: FFMPEG_INSTALL_CMD.brew, note: t("還沒有 Homebrew 就先到 brew.sh 安裝") }] };
    case "linux":
      return {
        kind: "install",
        commands: [
          { id: "apt", label: "Debian / Ubuntu", cmd: FFMPEG_INSTALL_CMD.apt, note: null },
          { id: "dnf", label: "Fedora", cmd: FFMPEG_INSTALL_CMD.dnf, note: t("要先啟用 RPM Fusion（官方庫只有 ffmpeg-free）") },
        ],
      };
    default:
      // 不內建 ffmpeg 的其他 OS（目前沒有出這種安裝檔）：沒有可靠的指令可給
      return { kind: "unknown" };
  }
}

export type HardwareRowId = "gpu" | "driver" | "cuda" | "arch" | "chip" | "mps" | "macos" | "backend" | "lock";

export interface HardwareRow {
  id: HardwareRowId;
  /** true = ✓；false = 警告；null = 還不知道（沒探過 / 只能講需求）。 */
  ok: boolean | null;
  text: string;
}

/**
 * 安裝面板「硬體需求」的每一列，照 pyenv.rs `gate` 的分支講人話：
 * - Windows / Linux：NVIDIA 顯示卡 → CUDA 可用（+cu130）→ sm_XY 架構在支援表 → lock；
 *   Linux 另外列驅動 R580+：cu130 的 wheel 要 CUDA 13 驅動，發行版預設的 nvidia 驅動常常更舊，症狀只是「CUDA 不可用」看不出原因。
 *   （Windows 維持原本四列不動：GeForce 驅動自動更新，這條很少是原因。）
 * - macOS：Apple Silicon 晶片 → MPS 可用 → macOS 14+ → lock；沒有 NVIDIA / CUDA / sm_XY，列出來只會在一台可以用的 Mac 上亮三個警告。
 * - 任何平台 backend === "cpu"（AIVC_ALLOW_CPU=1 放行）：多一列警告，免得以為在用 GPU。
 */
export function hardwareRows(input: { platform: AppPlatform | null; pyenv: PyEnvStatus | null; gpu: string | null }, t: Translate): HardwareRow[] {
  const { platform, pyenv, gpu } = input;
  const family = platformFamily(platform, pyenv);
  const rows = family === "macos" ? appleRows(platform, pyenv, gpu, t) : nvidiaRows(family, pyenv, gpu, t);
  if (pyenv?.backend === "cpu") rows.push({ id: "backend", ok: false, text: t("執行後端：CPU（AIVC_ALLOW_CPU=1 放行，非常慢，只供 CI / 除錯）") });
  rows.push({ id: "lock", ok: pyenv ? pyenv.lock_ok : null, text: pyenv?.lock_ok ? t("相依套件版本：與 lock 檔一致") : t("相依套件版本：與 lock 檔不一致（重新安裝可修）") });
  return rows;
}

function appleChipRow(platform: AppPlatform | null, pyenv: PyEnvStatus | null, gpu: string | null, t: Translate): HardwareRow {
  // 只出 aarch64 的 dmg，Intel Mac 本來就開不了；x86_64 只可能是自己編的 build，照實說不支援
  if (platform?.arch === "x86_64") return { id: "chip", ok: false, text: t("Intel Mac 不支援：引擎需要 Apple Silicon（M1 以後）的 MPS") };
  if (gpu) return { id: "chip", ok: true, text: t("晶片：{gpu}", { gpu }) };
  // pyenv 還沒回來時只講需求，不先亮「找不到」
  if (!pyenv) return { id: "chip", ok: null, text: t("晶片：需要 Apple Silicon（M1 以後）") };
  return { id: "chip", ok: false, text: t("找不到 Apple Silicon 晶片 —— 引擎需要 M1 以後的 Mac（MPS），Intel Mac 不支援") };
}

function appleRows(platform: AppPlatform | null, pyenv: PyEnvStatus | null, gpu: string | null, t: Translate): HardwareRow[] {
  const v = pyenv?.torch ?? "?";
  const mpsText = pyenv?.mps
    ? t("MPS（Metal）：可用（torch {v}）", { v })
    : pyenv?.torch
      ? t("MPS（Metal）：不可用（torch {v}；需要 Apple Silicon 與 macOS 14 以上）", { v })
      : t("MPS（Metal）：尚未可用（安裝時會從 PyPI 抓 PyTorch）");
  return [
    appleChipRow(platform, pyenv, gpu, t),
    { id: "mps", ok: pyenv ? pyenv.mps : null, text: mpsText },
    // dmg 的 LSMinimumSystemVersion 是 14.0，低於 14 的系統開不了 App，能看到這個面板就代表符合；torch 2.14 也只出 macOS 14 的 wheel
    { id: "macos", ok: true, text: t("macOS 14 Sonoma 以上：符合（App 的最低系統需求）") },
  ];
}

function nvidiaDriverRow(pyenv: PyEnvStatus | null, gpu: string | null, t: Translate): HardwareRow {
  // 讀不到驅動版本號（nvidia-smi 只問了名字與 VRAM）：CUDA 可用就代表驅動夠新；
  // 有卡、torch 也裝了、CUDA 卻不可用時，Linux 上最常見的原因是發行版預設的驅動比 R580 舊
  if (pyenv?.cuda) return { id: "driver", ok: true, text: t("NVIDIA 驅動：R580 以上（CUDA 13 可用）") };
  if (gpu && pyenv?.torch) return { id: "driver", ok: false, text: t("NVIDIA 驅動：CUDA 13 不可用，先確認驅動是 R580 以上") };
  return { id: "driver", ok: null, text: t("NVIDIA 驅動：需要 R580 以上（CUDA 13）") };
}

function nvidiaRows(family: PlatformFamily, pyenv: PyEnvStatus | null, gpu: string | null, t: Translate): HardwareRow[] {
  const rows: HardwareRow[] = [
    { id: "gpu", ok: gpu ? true : pyenv ? false : null, text: gpu ? t("顯示卡：{gpu}", { gpu }) : t("找不到 NVIDIA 顯示卡（或沒裝驅動）—— 引擎需要 CUDA，CPU 跑不動 SAM 2.1") },
  ];
  if (family === "linux") rows.push(nvidiaDriverRow(pyenv, gpu, t));
  rows.push(
    { id: "cuda", ok: pyenv ? pyenv.cuda : null, text: pyenv?.cuda ? t("CUDA：可用（torch {v}）", { v: pyenv.torch ?? "?" }) : t("CUDA：尚未可用（安裝時會抓 cu130 的 PyTorch）") },
    { id: "arch", ok: pyenv ? pyenv.arch.length > 0 : null, text: pyenv?.arch.length ? t("支援的架構：{list}", { list: pyenv.arch.join(", ") }) : t("架構表：安裝後才知道（要包含這張卡的 sm_XY）") },
  );
  return rows;
}
