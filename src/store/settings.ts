import { create } from "zustand";
import { api, type AppPaths, type AppSettings, type FfmpegStatus } from "../api";

/**
 * App 設定（鏡射 src-tauri/src/store.rs 的 AppSettings；欄位 snake_case 照磁碟格式，不在這裡轉 camelCase ——
 * 轉一層只會多一個會對不上的地方，ai-music-cut 就是這樣用的）。
 *
 * 沒有任何 secret 欄位：金鑰在 keychain（M6 才有）。設定檔缺欄位由 Rust `#[serde(default)]` 補，
 * 這裡的 DEFAULT_SETTINGS 是「Rust 還沒回來之前」與「非 Tauri 環境」的兜底，值要跟 store.rs 的 Default 一致。
 * 外掛的設定鍵（例如 cards 的 deck_style_id）不在這裡：Rust 原樣保留（AppSettings.extra），外掛自己給預設值。
 */
export const DEFAULT_SETTINGS: AppSettings = {
  ffmpeg_path: null,
  lang: "zh-TW",
  output_dir: null,
  recent_projects: [],
  python_override: null,
  engine: { sam_variant: "small", allow_sam3: false, tracker: "classic", auto_resolve: true, data_root: null },
  export_defaults: { codec: "auto", quality: "high", audio: "copy" },
  llm_anthropic_base_url: "https://api.anthropic.com",
  llm_anthropic_model: "",
  llm_openai_base_url: "http://localhost:1234/v1",
  llm_openai_model: "",
  tts_base_url: "",
  updater: { auto_check_updates: true, update_endpoint: "", skipped_update_version: "", last_update_check: 0 },
  // AI 後端：舊使用者維持 HTTP 端點（引擎 assistant.chat）；MCP 預設隨機 port
  agent_backend: "http",
  claude_model: "",
  codex_model: "",
  mcp_port: 0,
};

/**
 * 輸出時要試編的 encoder（有列 ≠ 能用；NVENC 常常有列但驅動不合）。
 * h264_videotoolbox / libx264：引擎 H.264 階梯在 macOS / Linux 實際會用到的兩個（Homebrew 與發行版的 ffmpeg 沒有 openh264）；
 * 不列進來的話，Mac / Linux 的輸出對話框只剩 VP9 可點名。Rust 端先看 `-encoders` 有沒有列才試編，
 * Windows 內建的 LGPL build 兩個都沒有 → 不多開任何 ffmpeg 子行程，也不會讓使用者點名 GPL 的 libx264。
 */
export const CHECK_ENCODERS = ["h264_nvenc", "hevc_nvenc", "libopenh264", "h264_videotoolbox", "libx264", "libvpx-vp9"];

/**
 * 實驗功能旗標（`settings.experimental.*`）。
 * - `sequence`：序列剪輯 —— 時間軸的序列空間、分割 / 刪除 / 修剪、音軌、序列輸出（docs/editor-m2-design.md §13）。
 *   M2.9～M2.16 中途出貨時預設關（使用者不會看到半成品）；M2.17 功能齊了，預設改成開。
 *   只改「沒存過」的預設：localStorage 裡明確存了 false 的人（在設定頁自己關掉的）維持關 —— 那是使用者的選擇，不是舊預設。
 *
 * 為什麼不放進 `s`（AppSettings）：實驗旗標是「這台機器要不要試新功能」，跟介面密度一樣是本機習慣，
 * 所以存 localStorage；日後轉正就直接拿掉旗標，不必動設定檔格式。（settings.json 現在會原樣保留不認得的鍵 ——
 * store.rs AppSettings.extra —— 那是給外掛的設定用的，不是給本機習慣用的。）
 */
export interface ExperimentalFlags {
  sequence: boolean;
}

export const DEFAULT_EXPERIMENTAL: ExperimentalFlags = { sequence: true };

const EXPERIMENTAL_KEY = "aivc:experimental";

/** 從 localStorage 的字串還原（純函式，測試用）：只收布林值，壞 JSON / 型別不對一律退回預設。 */
export function parseExperimental(raw: string | null): ExperimentalFlags {
  if (!raw) return DEFAULT_EXPERIMENTAL;
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof ExperimentalFlags, unknown>> | null;
    return { sequence: typeof v?.sequence === "boolean" ? v.sequence : DEFAULT_EXPERIMENTAL.sequence };
  } catch {
    return DEFAULT_EXPERIMENTAL;
  }
}

function loadExperimental(): ExperimentalFlags {
  try {
    return parseExperimental(localStorage.getItem(EXPERIMENTAL_KEY));
  } catch {
    // 私密視窗 / 停用儲存 / node 測試環境沒有 localStorage
    return DEFAULT_EXPERIMENTAL;
  }
}

interface SettingsStore {
  s: AppSettings;
  /** 實驗功能旗標（本機、localStorage；見 ExperimentalFlags）。 */
  experimental: ExperimentalFlags;
  setExperimental: (patch: Partial<ExperimentalFlags>) => void;
  loaded: boolean;
  ffmpeg: FfmpegStatus | null;
  paths: AppPaths | null;
  probing: boolean;
  load: () => Promise<void>;
  save: (patch: Partial<AppSettings>) => Promise<void>;
  /**
   * 重探 ffmpeg。`encoders: false` = 輕量重探：不送 `check`，沿用上一次試編過關的清單。
   * 引擎 / pyenv 的探測在 store/engine.ts。
   */
  probeAll: (opts?: { encoders?: boolean }) => Promise<void>;
}

/** StrictMode 的 dev 雙呼叫會讓 load 跑兩次（整合煙霧測試看到 app_paths 印兩行、ffmpeg 試編兩輪）：同一個 promise 共用。 */
let loading: Promise<void> | null = null;

export const useSettings = create<SettingsStore>((set, get) => ({
  s: DEFAULT_SETTINGS,
  experimental: loadExperimental(),
  setExperimental: (patch) => {
    const cur = get().experimental;
    const next = { ...cur, ...patch };
    // 沒變就不換物件：訂閱旗標的元件（時間軸、選單）不必重算
    if ((Object.keys(next) as (keyof ExperimentalFlags)[]).every((k) => next[k] === cur[k])) return;
    set({ experimental: next });
    try {
      localStorage.setItem(EXPERIMENTAL_KEY, JSON.stringify(next));
    } catch {
      /* 存不了就只在這次執行有效 */
    }
  },
  loaded: false,
  ffmpeg: null,
  paths: null,
  probing: false,
  load: () =>
    (loading ??= (async () => {
      try {
        const s = await api.settingsGet();
        set({ s: { ...DEFAULT_SETTINGS, ...s, engine: { ...DEFAULT_SETTINGS.engine, ...s.engine }, export_defaults: { ...DEFAULT_SETTINGS.export_defaults, ...s.export_defaults }, updater: { ...DEFAULT_SETTINGS.updater, ...s.updater } }, loaded: true });
      } catch {
        set({ loaded: true });
      }
      try {
        set({ paths: await api.appPaths() });
      } catch {
        /* 非 Tauri 環境（vite preview）略過 */
      }
      void get().probeAll();
    })()),
  save: async (patch) => {
    const next = { ...get().s, ...patch };
    set({ s: next }); // 樂觀更新，UI 立即反映
    try {
      const saved = await api.settingsSet(next);
      set({ s: { ...DEFAULT_SETTINGS, ...saved } });
      // data_root / python_override 變了，app_paths 也會變
      if ("engine" in patch || "python_override" in patch) set({ paths: await api.appPaths().catch(() => get().paths) });
    } catch {
      /* 寫檔失敗保留記憶體中的值；呼叫端可再試 */
    }
  },
  probeAll: async (opts = {}) => {
    if (get().probing) return;
    set({ probing: true });
    const withEncoders = opts.encoders !== false;
    const prev = get().ffmpeg;
    // `check` 會讓 Rust 對每個 encoder 真的用 lavfi 試編兩幀（ffmpeg.rs encoder_usable 沒有快取）：
    // 狀態列每 30 秒重探時帶著它，就是每 30 秒在忙碌的 GPU 上開 4 支 ffmpeg（其中兩支 NVENC）。
    const fresh = await api.ffmpegDetect(null, withEncoders ? CHECK_ENCODERS : undefined).catch(() => null);
    const ffmpeg = fresh && !withEncoders && prev?.found && prev.ffmpeg_path === fresh.ffmpeg_path ? { ...fresh, usable: prev.usable } : fresh;
    // 內容沒變就不換物件：訂閱 ffmpeg 的元件（狀態列、橫幅、指令反應性）不必每 30 秒重算一次
    const same = !!ffmpeg && !!prev && ffmpeg.found === prev.found && ffmpeg.ffmpeg_path === prev.ffmpeg_path && ffmpeg.version === prev.version && ffmpeg.source === prev.source && ffmpeg.usable.join(",") === prev.usable.join(",");
    set(same ? { probing: false } : { ffmpeg, probing: false });
  },
}));

/** 序列剪輯（預覽）開著沒有：指令守門 / 時間軸分段控制用的非 hook 版本。 */
export function sequenceEditingEnabled(): boolean {
  return useSettings.getState().experimental.sequence;
}

/** 最近開啟（設定檔，最多 10 筆）。 */
export function rememberRecent(path: string): void {
  const st = useSettings.getState();
  const next = [path, ...st.s.recent_projects.filter((p) => p !== path)].slice(0, 10);
  void st.save({ recent_projects: next });
}
