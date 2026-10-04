import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// 單一 Rust 邊界：所有 invoke 集中在此，型別對齊 src-tauri（payload 欄位 snake_case 照 Rust struct；
// invoke 參數 camelCase，Tauri 會轉成 Rust 的 snake_case 參數）。
// 這裡**只列 `src-tauri/src/commands/mod.rs` 真的有的指令**（lib.rs invoke_handler 那一串）。
// 引擎 op 的參數形狀（sidecar 收到的 args dict = CLI argparse 的 vars(ns)，key 是 dest 名）在 src/pipeline/*.ts 各自對照。

export interface Rational {
  num: number;
  den: number;
}

// ---- 設定（鏡射 store.rs AppSettings；欄位 snake_case 照磁碟格式）----

/** AI 助手的後端（store.rs `agent_backend`）。不認得的值一律當 "http"（見 assistant/backend.ts）。 */
export type AgentBackend = "http" | "claude-cli" | "codex-cli";

export interface EngineSettings {
  /** "small" | "large"；SAM 2.1 hiera 變體。 */
  sam_variant: string;
  /** SAM 3 是 gated 權重，預設關（計畫 §12 授權）。 */
  allow_sam3: boolean;
  /** "classic" | "dense"（dense 是 Protocol 預留，v1 只有 classic）。 */
  tracker: string;
  /** 拖角 / 加提示後自動重解（AdjustTrack 的 resolveAround）。 */
  auto_resolve: boolean;
  /** pyenv / models / tools / logs 的根；null = app_local_data_dir。venv 6–7 GB 要能搬到 D:。 */
  data_root: string | null;
}

export interface ExportDefaultsSettings {
  /** "auto" 或明確的 ffmpeg encoder 名。真正的編碼計畫在 Python encode_plan.plan()（唯一一份）。 */
  codec: string;
  /** "draft" | "standard" | "high"。 */
  quality: string;
  /** "copy" | "aac"。 */
  audio: string;
}

export interface AppSettings {
  ffmpeg_path: string | null;
  lang: string;
  output_dir: string | null;
  recent_projects: string[];
  /** AIVC_PYTHON 的設定檔版本：指定 venv python；null = 受管 venv。絕不退回 PATH（決策 9）。 */
  python_override: string | null;
  engine: EngineSettings;
  export_defaults: ExportDefaultsSettings;
  /** LLM 供應商（M6 才用；A0 保留欄位讓設定檔格式不必再升版）。金鑰在 keychain，不在這裡。 */
  llm_anthropic_base_url: string;
  llm_anthropic_model: string;
  llm_openai_base_url: string;
  llm_openai_model: string;
  /** AI 配音（Seal-TTS）伺服器位址；空＝功能關著。金鑰在 keychain（tts_api_key）。 */
  tts_base_url: string;
  /** App 自動更新（鏡射 updater.rs UpdaterSettings）。更新指令的型別與呼叫在 src/updater/api.ts。 */
  updater: UpdaterSettings;
  /** AI 助手後端："http"（引擎 assistant.chat → 上面的 LLM 端點）｜"claude-cli"｜"codex-cli"（本機 CLI 經內建 MCP server 操作 App）。 */
  agent_backend: AgentBackend;
  /** claude CLI 的 --model；空＝claude 自己的預設。 */
  claude_model: string;
  /** codex CLI 的 -m；空＝codex 自己的設定。 */
  codex_model: string;
  /** 內建 MCP server 的固定 port；0＝每次啟動隨機。改了要重新啟動 App。 */
  mcp_port: number;
  /**
   * 外掛的設定鍵（例如 cards 的 `deck_style_id`）：攤平在最上層，Rust `AppSettings.extra`（serde flatten）原樣保留、
   * 寫回去。core 不認得也不會洗掉；外掛自己讀寫、自己給預設值。金鑰一樣不准放這裡（只放 keychain）。
   */
  [pluginKey: string]: unknown;
}

export interface UpdaterSettings {
  /** 啟動後在背景檢查，一天最多一次。預設 true。 */
  auto_check_updates: boolean;
  /** 進階：覆寫 latest.json 的網址；空字串＝tauri.conf.json 的來源。只收 https（http 只准 localhost / 127.0.0.1）。 */
  update_endpoint: string;
  /** 「略過這個版本」記下的版號；背景檢查不再提示這一版。 */
  skipped_update_version: string;
  /** 上次成功檢查的時間（Unix 毫秒；0＝從沒檢查過）。 */
  last_update_check: number;
}

/** `ffmpeg -encoders` 的一列。「有列」不等於「能用」，能用看 FfmpegStatus.usable。 */
export interface EncoderInfo {
  name: string;
  /** "video" | "audio" | "subtitle" */
  kind: string;
  description: string;
}

export interface FfmpegStatus {
  found: boolean;
  ffmpeg_path: string | null;
  ffprobe_path: string | null;
  version: string | null;
  source: string | null;
  encoders: EncoderInfo[];
  /** `check` 裡真的試編過關的名字（lavfi 黑幀 2 幀）。 */
  usable: string[];
}

// ---- 探測（ffmpeg.rs 擴充版；計畫 §7 ffmpeg.rs 列）----

export interface AudioStream {
  codec: string;
  sample_rate: number;
  channels: number;
  bit_rate: number | null;
  // ---- 媒體資訊對話框用的補充欄位（ffmpeg.rs 後來才加）----
  // 一律 optional：專案檔存的是開檔當下的 probe，舊專案沒有這些鍵（undefined），新 probe 沒值時是 null。
  codec_long_name?: string | null;
  profile?: string | null;
  /** "stereo" / "5.1(side)"。 */
  channel_layout?: string | null;
  /** 解碼後取樣格式 "fltp" / "s16"。 */
  sample_fmt?: string | null;
  /** PCM 類的位元深度；有損編碼 → null。 */
  bits_per_sample?: number | null;
  duration_ms?: number | null;
  start_time_ms?: number | null;
}

export interface VideoStream {
  codec: string;
  width: number;
  height: number;
  pix_fmt: string;
  r_frame_rate: Rational;
  avg_frame_rate: Rational;
  time_base: Rational;
  /** 範例 webm 沒有 nb_frames / duration 標頭 → null；真實幀數由引擎 media.index 算。 */
  nb_frames: number | null;
  duration_ms: number | null;
  start_time_ms: number | null;
  color_range: string | null;
  color_space: string | null;
  color_transfer: string | null;
  color_primaries: string | null;
  /** displaymatrix 旋轉（度）；0 = 無。 */
  rotation: number;
  has_b_frames: number;
  bit_rate: number | null;
  // ---- 媒體資訊對話框用的補充欄位（optional 的理由同 AudioStream）----
  codec_long_name?: string | null;
  /** "High" / "Main 10" / "Profile 0"。 */
  profile?: string | null;
  /** ffprobe level 原始整數（H.264 41 = 4.1、HEVC 123 = 4.1）；換算見 video/mediaFormat.ts levelLabel。 */
  level?: number | null;
  /** FourCC（"avc1"）；Matroska 沒有 → null。 */
  codec_tag?: string | null;
  bits_per_raw_sample?: number | null;
  /** "progressive" / "tt" / "bb" / "tb" / "bt"。 */
  field_order?: string | null;
  chroma_location?: string | null;
  sample_aspect_ratio?: Rational | null;
  display_aspect_ratio?: Rational | null;
}

export interface MediaProbe {
  path: string;
  size_bytes: number;
  /** 容器層時長；範例 webm 沒有標頭 → 0（計畫 A0 出口條件明列）。 */
  duration_ms: number;
  container: string;
  audio: AudioStream | null;
  video: VideoStream | null;
  /** blake3 hex（64 碼）；前 16 碼是快取目錄名與 mediaId。 */
  fingerprint: string;
  // ---- 媒體資訊對話框用的補充欄位（optional 的理由同 AudioStream）----
  /** "QuickTime / MOV" / "Matroska / WebM"。 */
  format_long_name?: string | null;
  /** 容器層整體位元率（含所有軌）。 */
  bit_rate?: number | null;
  /** ISO 8601 原字串（容器層優先，其次影片軌）。 */
  creation_time?: string | null;
  /** 寫檔程式（範例 WebM 是 "Chrome"）。 */
  encoder?: string | null;
  /** 起始時間碼標籤 "01:00:00;00"。 */
  timecode?: string | null;
}

/**
 * `app_platform`（鏡射 commands/mod.rs AppPlatform）。前端靠它切換 ffmpeg 安裝指令與硬體需求列，
 * 不猜 `navigator.userAgent`：WKWebView / WebKitGTK 的 UA 不可靠，也拿不到 CPU 架構。值在建置時就定了，啟動時問一次即可。
 */
export interface AppPlatform {
  /** `std::env::consts::OS`。 */
  os: "windows" | "macos" | "linux" | (string & {});
  /** `std::env::consts::ARCH`。 */
  arch: "x86_64" | "aarch64" | (string & {});
  /** 安裝檔是否內建 ffmpeg：只有 Windows（LGPL build）。macOS / Linux 用使用者自己裝的（brew / 發行版套件）。 */
  bundled_ffmpeg: boolean;
  /** 引導腳本檔名：`bootstrap-engine.ps1` | `bootstrap-engine.sh`。 */
  bootstrap_script: string;
}

/** 閘門通過時實際用的後端。`cpu` 只在 `AIVC_ALLOW_CPU=1`（CI / 除錯）才會出現。 */
export type EngineBackend = "cuda" | "mps" | "cpu" | (string & {});

export interface AppPaths {
  config_dir: string;
  cache_dir: string;
  /** app_local_data_dir：pyenv / models / tools / logs（**不是** Roaming）。 */
  local_data_dir: string;
  /** 實際生效的引擎資料根（設定 engine.data_root 或 local_data_dir）。 */
  data_root: string;
  logs_dir: string;
}

/** `<app_cache_dir>/media/<fp16>/` 有什麼（計畫 §5.3）。 */
export interface CacheStatus {
  proxy: boolean;
  index: boolean;
  thumbs: boolean;
  dir: string;
}

/** `media-progress` 事件（Rust 自己跑的長工作；鏡射 media.rs Progress）。M2.8 起 `media_peaks` 用 phase `peaks`。 */
export interface MediaProgress {
  job_id: string;
  phase: string;
  /** 0–100。 */
  pct: number;
}

// ---- 引擎 proxy 中繼資料（快取 proxy.v1.json；計畫 §5.6 ProjectMediaV1.proxy）----

export interface ProxyMeta {
  version: 1;
  fps: Rational;
  frames: number;
  width: number;
  height: number;
  /** proxy 對來源的縮放比（1 = 同解析度；上限 1080p）。所有座標都在來源像素空間，畫到 proxy 上要乘它。 */
  scale: number;
  /** proxy.mp4 的絕對路徑（convertFileSrc 用）。引擎的 proxy.v1.json 沒有這欄，由前端用快取目錄補上。 */
  path: string;
}

// ---- pyenv（計畫 §7.1；鏡射 pyenv.rs PyEnvStatus）----

export type PyEnvState = "missing" | "stale" | "installing" | "ready" | "broken" | (string & {});

export interface PyEnvStatus {
  state: PyEnvState;
  /** 解析到的 python 路徑（null = missing）。 */
  python: string | null;
  torch: string | null;
  cuda: boolean;
  /** macOS 的 Metal 後端可用（`torch.backends.mps.is_available()`）；Windows / Linux 永遠 false。 */
  mps: boolean;
  /** 閘門通過時用的後端；閘門沒過 / 還沒裝就是 null（要知道「有沒有 GPU」看 cuda / mps，不看這欄）。 */
  backend: EngineBackend | null;
  /** GPU 名。venv 缺時改由 nvidia-smi（macOS 是 sysctl 的晶片名，例如「Apple M2 Pro (MPS)」）補上，讓「硬體需求」區塊在安裝前就能講話。 */
  device: string | null;
  arch: string[];
  lock_ok: boolean;
  message: string;
}

/** `pyenv-install` 事件：安裝過程逐行回報（形狀沿用 local_asr.rs 的 InstallEvent）。 */
export interface PyEnvInstallEvent {
  job_id: string;
  /** "step"（換一個階段）| "line"（一行輸出）| "done" */
  kind: "step" | "line" | "done" | (string & {});
  /** kind==="step" 時：base | uv | venv | torch | deps | wheel | gate | models */
  step?: string;
  line?: string;
  ok?: boolean;
  code?: number;
}

// ---- 引擎監督（計畫 §7.2；鏡射 engine.rs EngineInfo）----

export type EngineStateKind = "down" | "starting" | "ready" | "broken";

/** sidecar `hello` 的回覆（引擎給什麼就存什麼；這幾個欄位是協定保證的）。 */
export interface EngineHello {
  version?: string;
  protocol?: number;
  python?: string;
  torch?: string | null;
  cuda?: string | boolean | null;
  /** Apple Silicon 的 MPS 可用。舊版引擎的 hello 沒有這個鍵，所以是 optional（缺 = 不知道，不是 false）。 */
  mps?: boolean | null;
  /** 引擎實際選到的裝置後端（cuda → mps → cpu）；舊版引擎沒有這個鍵。 */
  backend?: EngineBackend | null;
  device?: string | null;
  [k: string]: unknown;
}

/** `engine-state` 事件 payload，也是 `engine_state` / `engine_start` / `engine_stop` 的回傳。 */
export interface EngineInfo {
  state: EngineStateKind;
  pid: number | null;
  hello: EngineHello | null;
  /** stderr 裡最後一行像例外的（死因）。 */
  last_exc: string | null;
  /** 10 分鐘視窗內的重啟次數（上限 3）。 */
  restarts: number;
  /** 等 GPU permit 的 job id（前端顯示 queued）。 */
  queued: string[];
  /** 已送進引擎、還沒回覆的 job id。 */
  running: string[];
}

/** sidecar 錯誤（鏡射 error.rs 與 engine/errors.py 的 kind 集合）。 */
export interface EngineError {
  kind: "Invalid" | "Io" | "Ffmpeg" | "Canceled" | "Timeout" | "Gpu" | "Model" | "PyEnv" | "Engine" | "Internal" | (string & {});
  message: string;
  hint: string;
}

export interface EngineProgress {
  job_id: string;
  /** op 自己命名的階段（"pipeline" / "detect" / "seg.propagate" / "track.all" / "identify" …）。 */
  stage: string;
  /** 0–100；Rust 由 done/total 算。 */
  pct?: number;
  done?: number;
  total?: number;
  eta_s?: number | null;
  /** 逐幀 op 目前在第幾幀（proxy 幀號）。 */
  frame?: number | null;
  message?: string | null;
  /** `pipeline.run` 的 `ctx.progress("pipeline", i, n, step=name)`：目前在哪個 stage（probe … render / done）。 */
  step?: string | null;
  /** 其他 op 專屬的附加欄位（track id、shot id、cards 數…），engine.rs 原樣轉發。 */
  [k: string]: unknown;
}

export interface EngineLogEvent {
  job_id: string;
  level: string;
  message: string;
}

export interface EngineArtifactEvent {
  job_id: string;
  path: string;
  kind: string;
}

export interface EngineJobDone {
  job_id: string;
  ok: boolean;
  result?: unknown;
  error?: EngineError;
}

/** 業務 op 名（＝CLI 子命令；計畫 §5.8 + engine/ops 實際註冊的名字）。`string & {}` 留給日後新增的 op。 */
export type EngineOp =
  | "media.probe"
  | "media.index"
  | "media.proxy"
  | "media.shots"
  | "media.thumb"
  | "seg.run"
  | "seg.open"
  | "seg.prompt"
  | "seg.propagate"
  | "seg.close"
  | "geom.quad_from_mask"
  | "track.solve"
  | "comp.preview"
  | "seg.text_boxes"
  | "render.plan"
  | "render.run"
  | "env.doctor"
  | "models.pull"
  | "models.unload"
  // 動態字幕（feat/captions；engine/src/aivc/ops/asr.py）
  | "asr.transcribe"
  | "asr.doctor"
  | "captions.build"
  | "captions.layout"
  | "captions.preview"
  | "captions.export"
  | "captions.refine"
  | (string & {});

// ---- 錯誤 ----

/** Rust `AppError` 序列化形狀。 */
export interface AppErrorShape {
  kind: string;
  code: string;
  message: string;
  status?: number | null;
}

export function isAppError(e: unknown): e is AppErrorShape {
  return !!e && typeof e === "object" && "code" in e && "message" in e;
}

export function isEngineError(e: unknown): e is EngineError {
  return !!e && typeof e === "object" && "kind" in e && "message" in e && "hint" in e;
}

/** hint 附在訊息後面時最多留幾行 / 幾個字（B-11）。ffmpeg 的 hint 是 stderr 尾巴，可以上百行。 */
export const HINT_MAX_LINES = 3;
export const HINT_MAX_CHARS = 400;

/**
 * 引擎 hint → 可以塞進一行錯誤訊息的尾巴：去掉空白行、只留最後 {@link HINT_MAX_LINES} 行、
 * 最多 {@link HINT_MAX_CHARS} 個字（從尾巴截，前面補 `…`）。
 *
 * 為什麼是「最後幾行」：真正的死因在 ffmpeg stderr 的最後（`Permission denied`、`No space left on device`），
 * 前面全是 banner 與 stream mapping。
 */
export function hintTail(hint: string): string {
  const lines = String(hint ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (!lines.length) return "";
  const tail = lines.slice(-HINT_MAX_LINES).join(" ");
  return tail.length > HINT_MAX_CHARS ? `…${tail.slice(tail.length - (HINT_MAX_CHARS - 1))}` : tail;
}

/**
 * 任何 catch 到的東西 → 可顯示的訊息。
 *
 * 引擎錯誤（`{kind,message,hint}`）的**死因只在 hint 裡**：`ffmpeg 提前結束（寫入管線失敗）` 的 message
 * 對使用者毫無幫助，`Permission denied` / `No space left on device` 才是。Gpu / Model / PyEnv 的建議也一樣。
 * 所以 hint 有東西、而且不是 message 的重複時就接在後面（形狀與 Rust `wire_error_to_app` 一致：`訊息（hint）`）。
 */
export function errMessage(e: unknown, fallback = "發生未知錯誤"): string {
  if (isEngineError(e)) {
    const hint = hintTail(e.hint);
    return hint && hint !== e.message.trim() && !e.message.includes(hint) ? `${e.message}（${hint}）` : e.message;
  }
  if (isAppError(e)) return e.message;
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return fallback;
}

export function errKind(e: unknown): string | null {
  return isAppError(e) || isEngineError(e) ? e.kind : null;
}

/** 取消的錯誤（Rust `Canceled` / 引擎 `Canceled`）：呼叫端要標成 canceled 而不是 error。 */
export function isCanceled(e: unknown): boolean {
  const k = errKind(e);
  return k === "canceled" || k === "Canceled";
}

// ---- AI 助手 CLI 後端與內建 MCP server（agent.rs / codex.rs / mcp.rs）----

/** claude / codex CLI 的偵測結果。 */
export interface CliStatus {
  installed: boolean;
  version: string | null;
  logged_in: boolean;
  path: string | null;
}

/** `claude-stream` 事件 payload（codex 也轉成這個形狀）。 */
export interface ClaudeStreamEvent {
  req_id: string;
  kind: "system" | "text" | "tool" | "tool_result" | "result" | "error" | "done";
  text?: string;
  session_id?: string;
  model?: string;
  tool?: string;
  is_error?: boolean;
  duration_ms?: number;
  code?: number;
}

/** `mcp-tool-call` 事件 payload：前端執行完以 `mcpToolResult(id, …)` 回寫。 */
export interface McpToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** 登記給 MCP server 的工具。`timeoutSecs` 只給 App 自己用（等前端回寫多久，預設 60 秒），不會送給模型。 */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  timeoutSecs?: number;
}

export interface McpInfo {
  /** 0 = server 沒有起來（看 error）。 */
  port: number;
  url: string;
  tools: number;
  /** 這次啟動的 bearer token（每次啟動都換；只用來組外部連線指令）。 */
  token: string;
  token_env: string;
  server_name: string;
  error: string | null;
  /** 給使用者自己的 Claude Code / Codex 工作階段連進來的指令。 */
  commands: { claude: string; codex_env: string; codex: string };
}

// ---- 事件 ----

export type JobEventName = "pyenv-install" | "engine-progress" | "engine-log" | "engine-artifact" | "engine-job-done";

/**
 * 監聽某個 job 的事件：**永遠**先比對 job_id（計畫 §7.3）。
 * 兩個 job 同時跑（proxy + shots）時漏掉這一行，A 的進度會畫到 B 的列上。
 */
export function listenJob<T extends { job_id: string }>(event: JobEventName, jobId: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (ev) => {
    if (ev.payload.job_id !== jobId) return;
    cb(ev.payload);
  });
}

/** 非 job 的狀態事件（引擎狀態燈 / pyenv 狀態）。 */
export function listenEngineState(cb: (info: EngineInfo) => void): Promise<UnlistenFn> {
  return listen<EngineInfo>("engine-state", (ev) => cb(ev.payload));
}

export function listenPyEnvStatus(cb: (st: PyEnvStatus) => void): Promise<UnlistenFn> {
  return listen<PyEnvStatus>("pyenv-status", (ev) => cb(ev.payload));
}

export const api = {
  showMainWindow: () => invoke<void>("show_main_window"),
  clientLog: (msg: string) => invoke<void>("client_log", { msg }),
  /** 只回 AIVC_DEV_* 開頭的環境變數（Rust 端擋其他名字；release 一律 null）。 */
  devEnv: (name: string) => invoke<string | null>("dev_env", { name }),
  settingsGet: () => invoke<AppSettings>("settings_get"),
  settingsSet: (settings: AppSettings) => invoke<AppSettings>("settings_set", { settings }),
  /**
   * 金鑰寫進系統 keychain（空字串＝刪掉）。**不會寫進 settings.json**（那支的測試禁止）。
   *
   * 讀不回來是刻意的：只有 `secretHas` 問得到「有沒有」。真正要用金鑰的是引擎呼叫，
   * 那條路由 Rust 直接從 keychain 取出來塞進參數（`inject_secrets`），不經過這裡。
   */
  secretSet: (account: string, secret: string) => invoke<void>("secret_set", { account, secret }),
  secretHas: (account: string) => invoke<boolean>("secret_has", { account }),
  appPaths: () => invoke<AppPaths>("app_paths"),
  /** 建置目標的 OS / 架構 / 是否內建 ffmpeg（同步、不碰磁碟）；store/engine.ts 啟動時問一次存起來。 */
  appPlatform: () => invoke<AppPlatform>("app_platform"),
  pathsExist: (paths: string[]) => invoke<boolean[]>("paths_exist", { paths }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  /** 寫純文字檔（Nuke .nk / AE 剪貼簿文字）。不加 BOM。 */
  writeTextFile: (path: string, content: string) => invoke<void>("write_text_file", { path, content }),
  /** `check`：要實際試編（lavfi 黑幀 2 幀）的 encoder 名，最多 8 個；有列 ≠ 能用。 */
  ffmpegDetect: (custom?: string | null, check?: string[]) => invoke<FfmpegStatus>("ffmpeg_detect", { custom: custom ?? null, check: check ?? null }),
  mediaProbe: (path: string) => invoke<MediaProbe>("media_probe", { path }),
  mediaFingerprint: (path: string) => invoke<string>("media_fingerprint", { path }),
  mediaCacheStatus: (fingerprint: string) => invoke<CacheStatus>("media_cache_status", { fingerprint }),
  mediaCacheClear: (fingerprint?: string | null) => invoke<void>("media_cache_clear", { fingerprint: fingerprint ?? null }),
  /**
   * 波形峰值 `peaks.v1.bin`（"AIVP"，設計 §3.4）：有快取直接回，否則 Rust 以 ffmpeg 解一趟（不需要 Python 引擎）。
   * 回原始 bytes，交給 `src/audio/peaks.ts` 解析；進度走 `media-progress`（job_id 過濾）。
   * durationMs 只用來算百分比（範例 WebM 沒有時長標頭）；沒有音軌 → Invalid 錯誤。只由 src/pipeline/peaks.ts 呼叫。
   */
  mediaPeaks: (jobId: string, path: string, fingerprint: string, durationMs?: number | null) =>
    invoke<ArrayBuffer>("media_peaks", { jobId, path, fingerprint, durationMs: durationMs ?? null }),
  /**
   * 讀快取目錄裡的一個檔（含路徑穿越防護；計畫 §5.3）。回原始 bytes（tauri::ipc::Response）。
   * offset / len 給 .aivm 依 index 只讀一幀的 RLE 用。
   */
  cacheRead: (fingerprint: string, relPath: string, offset?: number | null, len?: number | null) =>
    invoke<ArrayBuffer>("cache_read", { fingerprint, relPath, offset: offset ?? null, len: len ?? null }),
  /**
   * 縮圖列：快取 proxy.mp4 從 startFrame 起連續 count（≤64）幀、每張高 h px、tile={count}x1 成一張 PNG；
   * 回快取路徑 `thumbs/t-{start}-{count}-h{h}-v1.png`。命中快取就直接回（is_file 短路）。
   */
  thumbStrip: (fingerprint: string, fps: Rational, startFrame: number, count: number, h: number) =>
    invoke<string>("thumb_strip", { fingerprint, fpsNum: fps.num, fpsDen: fps.den, startFrame, count, h }),
  /** 偵測受管 Python 環境（跑一次 venv python，≤90 s）；結果也發 `pyenv-status`。 */
  pyenvStatus: () => invoke<PyEnvStatus>("pyenv_status"),
  /** 安裝時實際會執行的 argv（一條指令；畫面上先給人看過再按）。正式版沒有引導腳本時會回 PyEnv 錯誤。 */
  pyenvInstallCommand: (withModels = false) => invoke<string[]>("pyenv_install_command", { withModels }),
  /** 一鍵安裝；輸出逐行走 `pyenv-install` 事件，完成後 `pyenv-status`。回 true = 閘門通過。 */
  pyenvInstall: (jobId: string, withModels = false) => invoke<boolean>("pyenv_install", { jobId, withModels }),
  /** 使用者主動啟動 / 重新啟動（清 Broken）。 */
  engineStart: () => invoke<EngineInfo>("engine_start"),
  engineStop: () => invoke<EngineInfo>("engine_stop"),
  engineState: () => invoke<EngineInfo>("engine_state"),
  /** 短同步呼叫（`render.plan --dry-run`、`env.doctor`…）；長工作走 engineJobStart。timeoutMs 預設 60 s。 */
  engineCall: <T = unknown>(op: EngineOp, args: Record<string, unknown>, timeoutMs?: number) =>
    invoke<T>("engine_call", { op, args, timeoutMs: timeoutMs ?? null }),
  /** 前端 jobId 就是 wire id（決策 7）；先取 GPU permit → 進度 / 完成走事件。gpu 預設 true。 */
  engineJobStart: (jobId: string, op: EngineOp, args: Record<string, unknown>, gpu = true) =>
    invoke<void>("engine_job_start", { jobId, op, args, gpu }),
  engineJobCancel: (jobId: string) => invoke<void>("engine_job_cancel", { jobId }),
  projectSave: (path: string, doc: unknown) => invoke<void>("project_save", { path, doc }),
  projectLoad: (path: string) => invoke<unknown>("project_load", { path }),
  // ---- AI 助手 CLI 後端（串流走 `claude-stream` 事件，以 reqId 過濾）----
  claudeDetect: () => invoke<CliStatus>("claude_detect"),
  codexDetect: () => invoke<CliStatus>("codex_detect"),
  /** claude -p 一輪；sessionId 給了就 --resume。model null＝設定的 claude_model。 */
  claudeSend: (reqId: string, prompt: string, sessionId: string | null, model: string | null, systemPrompt: string | null) =>
    invoke<void>("claude_send", { reqId, prompt, sessionId, model, systemPrompt }),
  /** codex exec 一輪（只在這次執行以 -c 登記 App 的 MCP server）；sessionId＝thread id，給了就 exec resume。 */
  codexSend: (reqId: string, prompt: string, sessionId: string | null, model: string | null, systemPrompt: string | null, images?: string[]) =>
    invoke<void>("codex_send", { reqId, prompt, sessionId, model, systemPrompt, images: images ?? null }),
  /** 停掉一個助手工作（claude 或 codex）。 */
  claudeCancel: (reqId: string) => invoke<void>("claude_cancel", { reqId }),
  /**
   * codex 結構化產出（App 主導的「提案 → 執行 → 截圖驗收」迴圈用）：零工具、一次回合、可以附圖（只收 App 資料／快取目錄底下的 PNG）。
   * schema 要符合 OpenAI 嚴格模式（每個物件 additionalProperties:false、屬性全列進 required）。
   */
  codexStructured: <T = unknown>(prompt: string, schema: unknown, opts: { model?: string | null; systemPrompt?: string | null; images?: string[]; timeoutMs?: number } = {}) =>
    invoke<T>("codex_structured", { prompt, schema, model: opts.model ?? null, systemPrompt: opts.systemPrompt ?? null, images: opts.images ?? null, timeoutMs: opts.timeoutMs ?? null }),
  mcpSetTools: (tools: McpToolDef[]) => invoke<number>("mcp_set_tools", { tools }),
  mcpToolResult: (id: string, result: unknown, error: string | null) => invoke<boolean>("mcp_tool_result", { id, result, error }),
  mcpInfo: () => invoke<McpInfo>("mcp_info"),
};

export function listenClaudeStream(cb: (ev: ClaudeStreamEvent) => void): Promise<UnlistenFn> {
  return listen<ClaudeStreamEvent>("claude-stream", (ev) => cb(ev.payload));
}

export function listenMcpToolCall(cb: (call: McpToolCall) => void): Promise<UnlistenFn> {
  return listen<McpToolCall>("mcp-tool-call", (ev) => cb(ev.payload));
}

/** cache_read 回的 bytes → UTF-8 JSON。 */
export function decodeJson<T = unknown>(buf: ArrayBuffer): T {
  return JSON.parse(new TextDecoder("utf-8").decode(new Uint8Array(buf))) as T;
}
