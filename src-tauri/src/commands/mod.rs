//! Tauri command 薄層：`AppState` + 設定 / ffmpeg / 媒體快取 / 縮圖 / 專案 / pyenv / 引擎 / 開啟路徑。
//!
//! 指令名 snake_case、參數由 Tauri 從 TS 的 camelCase 轉過來（`jobId` → `job_id`）。
//! 這裡不放邏輯：能測的都在各模組的純函式裡；這裡只做取 state、算路徑、呼叫。
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::{engine, ffmpeg, media, peaks, project, pyenv, store, thumbs};

pub struct AppState {
    /// M6 的 LLM 供應商用；A0 只建好（rustls，不碰 OpenSSL）。
    pub http: reqwest::Client,
    /// 解析後的 ffmpeg / ffprobe 路徑快取；設定變更時清空重解析。
    pub ffmpeg: Arc<Mutex<Option<ffmpeg::FfmpegBins>>>,
    pub settings: Arc<RwLock<store::AppSettings>>,
    /// 可取消工作的旗標（key = job_id）：Rust 端自己跑的長迴圈定期檢查（引擎的取消走 `engine.cancel`）。
    pub cancel_flags: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// 安裝檔內建的 ffmpeg 目錄（setup 時從 resource_dir 算出；dev / 未內建時為 None）。
    pub bundled_ffmpeg: Arc<RwLock<Option<PathBuf>>>,
    /// 最近一次偵測到的受管 Python 環境狀態（啟動時非阻塞偵測、安裝後更新）。
    pub pyenv: Arc<RwLock<pyenv::PyEnvStatus>>,
    /// 常駐引擎監督。
    pub engine: Arc<engine::Engine>,
    /// 內建 MCP server（claude / codex CLI 連進來操作 App）。
    pub mcp: Arc<crate::mcp::McpBridge>,
    /// MCP server 起不來、或固定 port 用不了而退回隨機的原因（設定畫面顯示）。
    pub mcp_error: Arc<RwLock<Option<String>>>,
    /// 進行中的助手 CLI 工作（key = req_id）；abort 會連同子程序一起收掉（kill_on_drop）。
    pub agent_jobs: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .user_agent(concat!("ai-video-cut/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("http client"),
            ffmpeg: Arc::new(Mutex::new(None)),
            settings: Arc::new(RwLock::new(store::AppSettings::default())),
            cancel_flags: Arc::new(Mutex::new(HashMap::new())),
            bundled_ffmpeg: Arc::new(RwLock::new(None)),
            pyenv: Arc::new(RwLock::new(pyenv::PyEnvStatus::default())),
            engine: Arc::new(engine::Engine::new()),
            mcp: Arc::new(crate::mcp::McpBridge::new()),
            mcp_error: Arc::new(RwLock::new(None)),
            agent_jobs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// App 更新正要安裝（`Engine::set_update_lock`，見 updater.rs）：不再開 ffmpeg、引擎、引擎安裝 ——
    /// 安裝程式要覆寫的 `resources\ffmpeg\*` 不能又被新的子行程鎖住。
    pub fn ensure_not_updating(&self) -> AppResult<()> {
        if self.engine.update_locked() {
            return Err(AppError::Invalid(engine::UPDATE_LOCKED_MSG.into()));
        }
        Ok(())
    }

    /// MCP 工具結果的圖可以從哪裡讀：App 的快取 / 本機資料 / 設定 / 資料目錄，加上設定的引擎資料根。
    /// 輸出資料夾**不算**（那是使用者的資料夾，裡面什麼都可能有）。
    pub fn mcp_image_roots(&self, app: &AppHandle) -> Vec<PathBuf> {
        let mut roots: Vec<PathBuf> = [store::app_cache_dir(app).ok(), store::app_local_data_dir(app).ok(), store::app_config_dir(app).ok(), app.path().app_data_dir().ok()]
            .into_iter()
            .flatten()
            .collect();
        if let Ok(p) = self.pyenv_paths(app) {
            roots.push(p.root);
        }
        roots
    }

    /// 取得（並快取）ffmpeg / ffprobe。更新安裝途中回錯（呼叫端拿到它才會 spawn ffmpeg）。
    pub async fn ffmpeg_bins(&self) -> AppResult<ffmpeg::FfmpegBins> {
        self.ensure_not_updating()?;
        if let Some(b) = self.ffmpeg.lock().clone() {
            return Ok(b);
        }
        let custom = self.settings.read().ffmpeg_path.clone();
        let bundled = self.bundled_ffmpeg.read().clone();
        let b = ffmpeg::resolve(custom.as_deref(), bundled.as_deref())
            .await
            .ok_or_else(|| AppError::Ffmpeg("找不到 ffmpeg / ffprobe，請安裝或在設定指定路徑".into()))?;
        *self.ffmpeg.lock() = Some(b.clone());
        Ok(b)
    }

    pub fn cancel_flag(&self, job_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.cancel_flags.lock().insert(job_id.to_string(), flag.clone());
        flag
    }

    pub fn clear_flag(&self, job_id: &str) {
        self.cancel_flags.lock().remove(job_id);
    }

    pub fn pyenv_paths(&self, app: &AppHandle) -> AppResult<pyenv::PyEnvPaths> {
        let s = self.settings.read().clone();
        pyenv::paths(app, &s)
    }

    /// `requirements.lock.txt`：正式版在 resources/engine，dev 在 repo 的 engine/。
    pub fn lock_file(&self, app: &AppHandle) -> Option<PathBuf> {
        let rd = app.path().resource_dir().ok();
        pyenv::engine_source_dir(rd.as_deref()).map(|d| d.join(pyenv::LOCK_FILE))
    }

    /// 內建的引擎 wheel（resources/engine/aivc-*.whl）；None ＝ dev 走 `-e engine`。
    pub fn engine_wheel(&self, app: &AppHandle) -> Option<PathBuf> {
        let rd = app.path().resource_dir().ok();
        pyenv::find_engine_wheel(rd.as_deref())
    }

    /// 引擎引導腳本：`AIVC_BOOTSTRAP_SCRIPT` → 內建 `resources/engine/<腳本>` → repo `scripts/`（dev）。
    /// 腳本依 OS：Windows `bootstrap-engine.ps1`、macOS / Linux `bootstrap-engine.sh`（`pyenv::BOOTSTRAP_SCRIPT`）。
    pub fn bootstrap_script(&self, app: &AppHandle) -> AppResult<PathBuf> {
        let rd = app.path().resource_dir().ok();
        pyenv::bootstrap_script(rd.as_deref()).ok_or_else(|| {
            AppError::PyEnv(format!(
                "找不到引擎引導腳本 {s}（安裝檔應含 resources/engine/{s}；也可用環境變數 {e} 指定）",
                s = pyenv::BOOTSTRAP_SCRIPT,
                e = pyenv::ENV_BOOTSTRAP_SCRIPT
            ))
        })
    }

    /// 啟動引擎要用的 python / 快取目錄 / ffmpeg 目錄 / 環境變數。
    pub async fn engine_config(&self, app: &AppHandle) -> AppResult<engine::StartConfig> {
        // wheel_refresh 會跑 uv、引擎啟動會開 python：更新安裝途中都不准
        self.ensure_not_updating()?;
        let settings = self.settings.read().clone();
        let paths = pyenv::paths(app, &settings)?;
        let python = pyenv::resolve_python(&paths, settings.python_override.as_deref())
            .ok_or_else(|| AppError::PyEnv("尚未安裝引擎環境（設定 → 引擎 → 安裝）".into()))?;
        // App 更新後第一次啟動引擎：venv 裡還是舊版的引擎 wheel → 先換成安裝檔內建的（不重抓 torch；規則見 wheel_refresh.rs）
        if self.engine.state() != engine::EngineState::Ready {
            let rd = app.path().resource_dir().ok();
            crate::wheel_refresh::ensure_fresh(rd.as_deref(), &paths, &python, self.lock_file(app).as_deref()).await;
        }
        // ffmpeg 找不到不擋引擎啟動：引擎自己還有 resources → PATH 的退路，真的沒有會在 op 裡報 Ffmpeg 錯誤
        let ffmpeg_dir = match self.ffmpeg_bins().await {
            Ok(b) => Path::new(&b.ffmpeg).parent().map(Path::to_path_buf),
            Err(_) => None,
        };
        let cache_dir = store::app_cache_dir(app)?;
        let env = pyenv::engine_env(&paths, ffmpeg_dir.as_deref(), &cache_dir);
        Ok(engine::StartConfig { python, cache_dir, ffmpeg_dir, env, log_path: Some(paths.logs.join("engine.log")) })
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

/// 路徑正規化：Windows 上 `std::fs::canonicalize` 會回 `\\?\C:\…`（verbatim），ffmpeg / asset protocol /
/// 使用者眼睛都吃不下；`dunce::canonicalize` 在能簡化時去掉前綴。檔案不存在時退回純字串層的 `simplified`。
pub fn clean_path(p: &str) -> String {
    let path = Path::new(p.trim());
    match dunce::canonicalize(path) {
        Ok(c) => c.to_string_lossy().into_owned(),
        Err(_) => dunce::simplified(path).to_string_lossy().into_owned(),
    }
}

/// 前端錯誤 / 除錯訊息 → stderr（tauri dev 終端可見）。
#[tauri::command]
pub fn client_log(msg: String) {
    eprintln!("[client] {msg}");
}

/// dev 煙霧測試用：只在 debug build、只回 `AIVC_DEV_*`（AIVC_DEV_OPEN / _TRACK / _EXPORT）；release 一律 None。
#[tauri::command]
pub fn dev_env(name: String) -> Option<String> {
    dev_env_value(&name)
}

pub fn dev_env_value(name: &str) -> Option<String> {
    if !cfg!(debug_assertions) || !name.starts_with("AIVC_DEV_") {
        return None;
    }
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

#[derive(Serialize, Debug, PartialEq)]
pub struct AppPlatform {
    /// `std::env::consts::OS`：windows | macos | linux
    pub os: &'static str,
    /// `std::env::consts::ARCH`：x86_64 | aarch64
    pub arch: &'static str,
    /// 安裝檔是否內建 ffmpeg（只有 Windows 版內建 LGPL build；macOS / Linux 用系統的，缺了要提示 brew / apt 安裝）。
    pub bundled_ffmpeg: bool,
    /// 引導腳本檔名（安裝面板顯示「會執行什麼」用）。
    pub bootstrap_script: &'static str,
}

pub fn app_platform_info() -> AppPlatform {
    AppPlatform {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        bundled_ffmpeg: cfg!(windows),
        bootstrap_script: pyenv::BOOTSTRAP_SCRIPT,
    }
}

/// 前端依平台切換提示（`brew install ffmpeg` / `sudo apt install ffmpeg`、MPS / CUDA 的硬體需求文字）。
/// 不讓前端猜 `navigator.userAgent`：WebKitGTK / WKWebView 的 UA 字串不可靠，而且拿不到 CPU 架構。
#[tauri::command]
pub fn app_platform() -> AppPlatform {
    app_platform_info()
}

/// 前端骨架屏完成首次繪製後呼叫：顯示主視窗（配合 tauri.conf.json 的 visible:false 消除白屏）。
#[tauri::command]
pub fn show_main_window(window: tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

// ---------------- 設定 ----------------

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> store::AppSettings {
    state.settings.read().clone()
}

#[tauri::command]
pub async fn settings_set(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: store::AppSettings,
) -> AppResult<store::AppSettings> {
    store::write_json(&app, store::SETTINGS_FILE, &settings).await?;
    *state.settings.write() = settings.clone();
    *state.ffmpeg.lock() = None; // ffmpeg_path 可能變了 → 下次重解析
    // 引擎資料根可能搬了：MCP 工具結果的圖跟著新位置走
    state.mcp.set_image_roots(state.mcp_image_roots(&app));
    Ok(settings)
}

// ---------------- 金鑰（keychain） ----------------

/// 允許的帳號名。**白名單而不是任意字串**：這兩支指令等於開放前端讀寫作業系統的
/// 憑證儲存，放任 account 自由帶入的話，一個被注入的字串就能去摸別的服務的項目。
const SECRET_ACCOUNTS: &[&str] = &["llm_anthropic_api_key", "tts_api_key"];

fn check_account(account: &str) -> AppResult<()> {
    if SECRET_ACCOUNTS.contains(&account) {
        Ok(())
    } else {
        Err(AppError::Invalid(format!("不認得的金鑰名稱：{account}")))
    }
}

/// 寫入金鑰（空字串＝刪掉）。**金鑰只進 keychain，不進 settings.json、不進 log。**
#[tauri::command]
pub fn secret_set(account: String, secret: String) -> AppResult<()> {
    check_account(&account)?;
    store::kc_set(&account, &secret)
}

/// 有沒有存過這個金鑰。
///
/// **刻意只回 bool，不回金鑰本身。** 前端唯一需要知道的是「要不要顯示成已設定」；
/// 把金鑰送進 webview 只會讓它多一個外洩的面（devtools、錯誤回報、截圖）。
/// 真正要用金鑰的地方是引擎呼叫，那條路由 Rust 直接取出來帶進去。
#[tauri::command]
pub fn secret_has(account: String) -> AppResult<bool> {
    check_account(&account)?;
    Ok(store::kc_get(&account).is_some())
}

#[derive(Serialize)]
pub struct AppPaths {
    pub config_dir: String,
    pub cache_dir: String,
    pub local_data_dir: String,
    /// 實際生效的引擎資料根（設定 `engine.data_root` 或 local_data_dir）。
    pub data_root: String,
    pub logs_dir: String,
}

#[tauri::command]
pub fn app_paths(app: AppHandle, state: State<'_, AppState>) -> AppResult<AppPaths> {
    let p = state.pyenv_paths(&app)?;
    Ok(AppPaths {
        config_dir: store::app_config_dir(&app)?.to_string_lossy().into_owned(),
        cache_dir: store::app_cache_dir(&app)?.to_string_lossy().into_owned(),
        local_data_dir: store::app_local_data_dir(&app)?.to_string_lossy().into_owned(),
        data_root: p.root.to_string_lossy().into_owned(),
        logs_dir: p.logs.to_string_lossy().into_owned(),
    })
}

// ---------------- ffmpeg / 媒體 ----------------

#[derive(Serialize)]
pub struct FfmpegStatus {
    pub found: bool,
    pub ffmpeg_path: Option<String>,
    pub ffprobe_path: Option<String>,
    pub version: Option<String>,
    pub source: Option<String>,
    /// `-encoders` 列出的（有列 ≠ 能用）。
    pub encoders: Vec<ffmpeg::EncoderInfo>,
    /// `check` 裡真的試編過關的名字（lavfi 黑幀 2 幀）。
    pub usable: Vec<String>,
}

#[tauri::command]
pub async fn ffmpeg_detect(state: State<'_, AppState>, custom: Option<String>, check: Option<Vec<String>>) -> AppResult<FfmpegStatus> {
    // 狀態列每 30 秒重新偵測一次（會跑 ffmpeg -encoders 與試編）：更新安裝途中不跑
    state.ensure_not_updating()?;
    let custom = custom
        .filter(|s| !s.trim().is_empty())
        .or_else(|| state.settings.read().ffmpeg_path.clone());
    let bundled = state.bundled_ffmpeg.read().clone();
    match ffmpeg::resolve(custom.as_deref(), bundled.as_deref()).await {
        Some(b) => {
            *state.ffmpeg.lock() = Some(b.clone());
            let encoders = ffmpeg::encoders(&b).await.unwrap_or_default();
            let mut usable = Vec::new();
            for name in check.unwrap_or_default().into_iter().take(8) {
                if encoders.iter().any(|e| e.name == name) && ffmpeg::encoder_usable(&b, &name).await {
                    usable.push(name);
                }
            }
            Ok(FfmpegStatus {
                found: true,
                ffmpeg_path: Some(b.ffmpeg),
                ffprobe_path: Some(b.ffprobe),
                version: Some(b.version),
                source: Some(b.source),
                encoders,
                usable,
            })
        }
        None => Ok(FfmpegStatus {
            found: false,
            ffmpeg_path: None,
            ffprobe_path: None,
            version: None,
            source: None,
            encoders: Vec::new(),
            usable: Vec::new(),
        }),
    }
}

#[tauri::command]
pub async fn media_probe(state: State<'_, AppState>, path: String) -> AppResult<ffmpeg::MediaProbe> {
    let bins = state.ffmpeg_bins().await?;
    ffmpeg::probe(&bins, &clean_path(&path)).await
}

#[tauri::command]
pub async fn media_fingerprint(path: String) -> AppResult<String> {
    tokio::task::spawn_blocking(move || ffmpeg::fingerprint(&path))
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
}

#[tauri::command]
pub fn media_cache_status(app: AppHandle, fingerprint: String) -> AppResult<media::CacheStatus> {
    Ok(media::cache_status(&media::media_dir(&app, &fingerprint)?))
}

#[tauri::command]
pub async fn media_cache_clear(app: AppHandle, fingerprint: Option<String>) -> AppResult<()> {
    let root = store::app_cache_dir(&app)?.join("media");
    let target = match fingerprint {
        Some(fp) => media::media_dir(&app, &fp)?,
        None => root,
    };
    if target.exists() {
        tokio::fs::remove_dir_all(&target).await?;
    }
    Ok(())
}

/// 波形峰值（M2.8，設計 §3.4）：`<快取>/media/<fp16>/peaks.v1.bin`，有快取（header 驗過）直接回，否則 ffmpeg 解一趟。
/// 回原始 bytes（ArrayBuffer，前端 `src/audio/peaks.ts` 解析）；進度走 `media-progress`（phase `peaks`）。
/// `duration_ms` 只用來算進度百分比（範例 WebM 沒有時長標頭，前端從 audio.v1.json / proxy 補）。
/// 取消旗標已接（`cancel_flags[job_id]`），但目前沒有指令去設它：前端放棄等待時 ffmpeg 會算完並寫進快取。
#[tauri::command]
pub async fn media_peaks(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    path: String,
    fingerprint: String,
    duration_ms: Option<u64>,
) -> AppResult<tauri::ipc::Response> {
    let bins = state.ffmpeg_bins().await?;
    let dir = media::media_dir(&app, &fingerprint)?;
    let flag = state.cancel_flag(&job_id);
    let r = peaks::ensure(&bins, &clean_path(&path), &dir, duration_ms, flag, |pct| media::emit_progress(&app, &job_id, "peaks", pct)).await;
    state.clear_flag(&job_id);
    Ok(tauri::ipc::Response::new(r?.0))
}

/// 讀快取目錄裡的一個檔（或一段）：回原始 bytes（ArrayBuffer），零 JSON 開銷。
/// 遮罩檔 `.aivm` 依 index 讀單幀、`solve.v1.json`、`faces/<k>.png` 都走這一支；有路徑穿越防護。
#[tauri::command]
pub async fn cache_read(
    app: AppHandle,
    fingerprint: String,
    rel_path: String,
    offset: Option<u64>,
    len: Option<u64>,
) -> AppResult<tauri::ipc::Response> {
    let dir = media::media_dir(&app, &fingerprint)?;
    let p = media::safe_join(&dir, &rel_path)?;
    Ok(tauri::ipc::Response::new(media::read_range(&p, offset, len).await?))
}

/// 時間軸縮圖條：對快取裡的 `proxy.mp4` 抽 `count`（≤64）張連續幀拼成一張 PNG，回路徑（前端 convertFileSrc）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn thumb_strip(
    app: AppHandle,
    state: State<'_, AppState>,
    fingerprint: String,
    fps_num: u32,
    fps_den: u32,
    start_frame: u32,
    count: u32,
    h: u32,
) -> AppResult<String> {
    let bins = state.ffmpeg_bins().await?;
    let dir = media::media_dir(&app, &fingerprint)?;
    let proxy = dir.join(media::PROXY_FILE);
    let out = thumbs::thumb_strip(&bins, &proxy, fps_num, fps_den, start_frame, count, h, &dir.join(media::THUMBS_DIR)).await?;
    Ok(clean_path(&out.to_string_lossy()))
}

// ---------------- 專案 / 檔案 ----------------

#[tauri::command]
pub async fn project_save(path: String, doc: serde_json::Value) -> AppResult<()> {
    project::save(&path, &doc).await
}

#[tauri::command]
pub async fn project_load(path: String) -> AppResult<serde_json::Value> {
    project::load(&path).await
}

/// 寫一份純文字檔（Nuke `.nk` 片段 / AE 關鍵幀文字 / 筆記）。
///
/// 只做這一件事：建好上層資料夾、以 UTF-8 覆寫。**不加 BOM** —— Nuke 讀到 BOM 會當成語法錯誤。
#[tauri::command]
pub async fn write_text_file(path: String, content: String) -> AppResult<()> {
    let p = PathBuf::from(&path);
    if let Some(dir) = p.parent() {
        tokio::fs::create_dir_all(dir).await.map_err(|e| AppError::Io(format!("建立資料夾失敗：{e}")))?;
    }
    tokio::fs::write(&p, content.as_bytes()).await.map_err(|e| AppError::Io(format!("寫入失敗：{e}")))?;
    Ok(())
}

#[tauri::command]
pub fn open_path(path: String) -> AppResult<()> {
    let p = PathBuf::from(clean_path(&path));
    if !p.exists() {
        return Err(AppError::NotFound(path));
    }
    crate::proc::reveal(&p);
    Ok(())
}

#[tauri::command]
pub fn open_external(url: String) -> AppResult<()> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err(AppError::Invalid("僅允許開啟 http / https 連結".into()));
    }
    crate::proc::open_url(u);
    Ok(())
}

/// 一批路徑存不存在（輸出撞名用）。前端在決定檔名前先問一次，
/// 不然 `.part` → rename 會把磁碟上已經有的檔靜靜蓋掉（媒體清單裡沒有 ≠ 磁碟上沒有）。
#[tauri::command]
pub async fn paths_exist(paths: Vec<String>) -> AppResult<Vec<bool>> {
    let mut out = Vec::with_capacity(paths.len());
    for p in &paths {
        out.push(!p.trim().is_empty() && tokio::fs::metadata(p).await.is_ok());
    }
    Ok(out)
}

// ---------------- pyenv ----------------

/// 偵測受管 Python 環境（跑一次 venv python，≤90 s）；結果也發 `pyenv-status`。
#[tauri::command]
pub async fn pyenv_status(app: AppHandle, state: State<'_, AppState>) -> AppResult<pyenv::PyEnvStatus> {
    // 安裝途中不偵測：venv 已建、torch 還沒裝時 detect 會回 broken，蓋掉 installing → 畫面又出現「安裝引擎」
    if pyenv::install_in_progress() {
        let st = pyenv::PyEnvStatus { state: "installing".into(), message: "安裝中".into(), ..Default::default() };
        return Ok(st);
    }
    let paths = state.pyenv_paths(&app)?;
    let override_ = state.settings.read().python_override.clone();
    let lock = state.lock_file(&app);
    let st = pyenv::detect(&paths, override_.as_deref(), lock.as_deref()).await;
    *state.pyenv.write() = st.clone();
    pyenv::emit_status(&app, &st);
    Ok(st)
}

/// 安裝時實際會執行的 argv —— 畫面上要先給人看過再按。有內建 wheel 就帶 `-Wheel`（macOS / Linux 是 `--wheel`），
/// 沒有（dev）就是 `-e engine`。
#[tauri::command]
pub fn pyenv_install_command(app: AppHandle, state: State<'_, AppState>, with_models: Option<bool>) -> AppResult<Vec<String>> {
    let paths = state.pyenv_paths(&app)?;
    let script = state.bootstrap_script(&app)?;
    let wheel = state.engine_wheel(&app);
    Ok(pyenv::install_command(&script, &paths.root, with_models.unwrap_or(false), wheel.as_deref()))
}

/// 一鍵安裝引擎環境；輸出逐行走 `pyenv-install` 事件，完成後 `pyenv-status`。
#[tauri::command]
pub async fn pyenv_install(app: AppHandle, state: State<'_, AppState>, job_id: String, with_models: Option<bool>) -> AppResult<bool> {
    // 行程內旗標才是真正的互斥（pyenv.state 會被 pyenv_status / 啟動偵測改寫）；guard 活到本函式結束
    let Some(_installing) = pyenv::try_begin_install() else {
        return Err(AppError::PyEnv("已經在安裝中".into()));
    };
    // 先拿旗標再看更新鎖：updater 是先舉鎖再看 install_in_progress，兩邊都 SeqCst，至少有一邊會看到對方
    state.ensure_not_updating()?;
    let paths = state.pyenv_paths(&app)?;
    let lock = state.lock_file(&app);
    let wheel = state.engine_wheel(&app);
    let script = state.bootstrap_script(&app)?;
    // 腳本最後的 doctor 閘門要找得到 ffmpeg：App 能解析到（含 Homebrew 等常見目錄）就交給它；找不到不擋安裝，閘門會講清楚
    let ffmpeg_dir = state.ffmpeg_bins().await.ok().and_then(|b| Path::new(&b.ffmpeg).parent().map(Path::to_path_buf));
    state.pyenv.write().state = "installing".into();
    let r = pyenv::install(app.clone(), job_id, paths.clone(), lock.clone(), with_models.unwrap_or(false), wheel, script, ffmpeg_dir).await;
    let override_ = state.settings.read().python_override.clone();
    let st = pyenv::detect(&paths, override_.as_deref(), lock.as_deref()).await;
    *state.pyenv.write() = st;
    r
}

// ---------------- 引擎 ----------------

/// 使用者主動啟動 / 重新啟動（清 Broken）。
#[tauri::command]
pub async fn engine_start(app: AppHandle, state: State<'_, AppState>) -> AppResult<engine::EngineInfo> {
    let cfg = state.engine_config(&app).await?;
    state.engine.start(&engine::app_sink(&app), &cfg).await?;
    Ok(state.engine.info())
}

#[tauri::command]
pub async fn engine_stop(app: AppHandle, state: State<'_, AppState>) -> AppResult<engine::EngineInfo> {
    state.engine.stop(Some(&engine::app_sink(&app))).await;
    Ok(state.engine.info())
}

#[tauri::command]
pub fn engine_state(state: State<'_, AppState>) -> engine::EngineInfo {
    state.engine.info()
}

/// 短呼叫（`media.probe`、`render.plan --dry-run`、`env.doctor`…）：同步等結果。`timeout_ms` 預設 60 s。
#[tauri::command]
pub async fn engine_call(
    app: AppHandle,
    state: State<'_, AppState>,
    op: String,
    args: Option<serde_json::Value>,
    timeout_ms: Option<u64>,
) -> AppResult<serde_json::Value> {
    let cfg = state.engine_config(&app).await?;
    let t = timeout_ms.map(Duration::from_millis).unwrap_or(engine::DEFAULT_CALL_TIMEOUT);
    let args = inject_secrets(&op, args.unwrap_or(serde_json::json!({})));
    state.engine.call(&engine::app_sink(&app), &cfg, &op, args, t).await
}

/// 金鑰在這裡才加進去，**不經過 webview**。
///
/// 前端只知道「有沒有設定過」（`secret_has`）；真正的字串從 keychain 直接進引擎的參數。
/// 這樣 devtools、錯誤回報、截圖都看不到它。引擎那邊也不會把它寫進結果或 log
/// （`ops/assistant.py` 有測試守這件事）。
fn inject_secrets(op: &str, mut args: serde_json::Value) -> serde_json::Value {
    // AI 配音：所有 `tts.*` 都打同一台 Seal-TTS，金鑰一律由 keychain 來（前端帶的丟掉）
    if op.starts_with("tts.") {
        if let Some(obj) = args.as_object_mut() {
            obj.remove("api_key");
            if let Some(key) = store::kc_get("tts_api_key") {
                obj.insert("api_key".into(), serde_json::Value::String(key));
            }
        }
        return args;
    }
    // 所有 `assistant.*`（對話、章節、精華…）都可能打 Anthropic；`assistant.models` 只 GET 本機端點、沒有 provider 欄位，下面那關就回了
    if !op.starts_with("assistant.") {
        return args;
    }
    let wants_anthropic = args.get("provider").and_then(|v| v.as_str()) == Some("anthropic");
    if !wants_anthropic {
        return args;
    }
    if let Some(obj) = args.as_object_mut() {
        // 金鑰**只有一個來源**：keychain。前端帶來的一律先丟掉，
        // 免得日後某處不小心把一把 key 放進參數裡，而我們以為它是從 keychain 來的。
        obj.remove("api_key");
        if let Some(key) = store::kc_get("llm_anthropic_api_key") {
            obj.insert("api_key".into(), serde_json::Value::String(key));
        }
    }
    args
}

/// 長工作：立即回；進度走 `engine-progress`、結束走 `engine-job-done`（都帶 `job_id`）。`gpu` 預設 true。
#[tauri::command]
pub async fn engine_job_start(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    op: String,
    args: Option<serde_json::Value>,
    gpu: Option<bool>,
) -> AppResult<()> {
    let cfg = state.engine_config(&app).await?;
    state.engine.start_job(engine::app_sink(&app), cfg, job_id, op, args.unwrap_or(serde_json::json!({})), gpu.unwrap_or(true))
}

#[tauri::command]
pub async fn engine_job_cancel(app: AppHandle, state: State<'_, AppState>, job_id: String) -> AppResult<()> {
    state.engine.cancel(&engine::app_sink(&app), &job_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn paths_exist_reports_existing_and_missing() {
        let dir = std::env::temp_dir().join(format!("aivc pe 測試-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.mp4");
        std::fs::write(&a, b"x").unwrap();
        let b = dir.join("b.mp4");
        let r = paths_exist(vec![a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned(), String::new()]).await.unwrap();
        assert_eq!(r, vec![true, false, false]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clean_path_strips_verbatim_prefix() {
        let dir = std::env::temp_dir().join(format!("aivc clean 路徑-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("v.webm");
        std::fs::write(&f, b"x").unwrap();
        let plain = clean_path(&f.to_string_lossy());
        assert!(!plain.starts_with("\\\\?\\"), "{plain}");
        assert!(Path::new(&plain).is_file());
        #[cfg(windows)]
        {
            // std canonicalize 會給 \\?\ 前綴；餵進去要能還原成一般路徑
            let verbatim = std::fs::canonicalize(&f).unwrap();
            let vs = verbatim.to_string_lossy().into_owned();
            assert!(vs.starts_with("\\\\?\\"), "前提：std 給的是 verbatim，{vs}");
            let cleaned = clean_path(&vs);
            assert!(!cleaned.starts_with("\\\\?\\"), "{cleaned}");
            assert_eq!(cleaned, plain);
            // 不存在的檔：仍然要去掉前綴（純字串層）
            let missing = format!("\\\\?\\{}", dir.join("nope.webm").display());
            let c = clean_path(&missing);
            assert!(!c.starts_with("\\\\?\\"), "{c}");
            assert!(c.ends_with("nope.webm"));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn app_platform_matches_the_build_target() {
        let p = app_platform_info();
        assert_eq!(p.os, std::env::consts::OS);
        assert_eq!(p.arch, std::env::consts::ARCH);
        assert_eq!(p.bundled_ffmpeg, p.os == "windows", "只有 Windows 安裝檔內建 ffmpeg");
        assert_eq!(p.bootstrap_script, pyenv::bootstrap_script_name(p.os));
        let v = serde_json::to_value(&p).unwrap();
        for k in ["os", "arch", "bundled_ffmpeg", "bootstrap_script"] {
            assert!(v.get(k).is_some(), "前端讀 {k}");
        }
    }

    #[test]
    fn dev_env_only_exposes_aivc_dev_names() {
        std::env::set_var("AIVC_DEV_OPEN", "D:\\x.webm");
        std::env::set_var("PATH_LEAK_TEST", "secret");
        if cfg!(debug_assertions) {
            assert_eq!(dev_env_value("AIVC_DEV_OPEN").as_deref(), Some("D:\\x.webm"));
        }
        assert_eq!(dev_env_value("PATH_LEAK_TEST"), None, "只有 AIVC_DEV_* 能被前端讀");
        assert_eq!(dev_env_value("PATH"), None);
        std::env::remove_var("AIVC_DEV_OPEN");
        std::env::remove_var("PATH_LEAK_TEST");
    }
}

#[cfg(test)]
mod secret_tests {
    use super::*;

    /// 白名單以外的 account 一律擋下：這兩支指令等於開放前端讀寫作業系統的憑證儲存。
    #[test]
    fn only_whitelisted_accounts() {
        assert!(check_account("llm_anthropic_api_key").is_ok());
        for bad in ["", "other-service", "llm_anthropic_api_key ", "../../etc"] {
            assert!(check_account(bad).is_err(), "應該擋下：{bad}");
        }
    }

    /// 其他 op 一律不碰參數（只有助手的對話需要金鑰）。
    #[test]
    fn other_ops_untouched() {
        let a = serde_json::json!({ "video": "x.mp4" });
        assert_eq!(inject_secrets("render.run", a.clone()), a);
        assert_eq!(inject_secrets("assistant.models", a.clone()), a);
    }

    /// 本機端點（openai 相容）不需要金鑰，也不該被塞。
    #[test]
    fn local_provider_gets_no_key() {
        let a = serde_json::json!({ "endpoint": "http://localhost:1234/v1" });
        let out = inject_secrets("assistant.chat", a);
        assert!(out.get("api_key").is_none());
        let b = serde_json::json!({ "provider": "openai" });
        assert!(inject_secrets("assistant.chat", b).get("api_key").is_none());
    }

    /// 章節、精華等其他 `assistant.*` op 跟對話同一套（前端的 key 丟掉、keychain 的塞進去）；非 assistant 的 op 一律不碰。
    #[test]
    fn other_assistant_ops_get_the_same_treatment() {
        let a = serde_json::json!({ "provider": "anthropic", "api_key": "前端塞的", "project": "x.aivc.json" });
        let out = inject_secrets("assistant.chapters", a);
        assert_ne!(out.get("api_key").and_then(|v| v.as_str()), Some("前端塞的"));
        let b = serde_json::json!({ "provider": "anthropic", "api_key": "前端塞的" });
        assert_eq!(inject_secrets("captions.refine", b.clone()), b);
    }

    /// `tts.*` 不看 provider：前端帶的金鑰一律丟掉，keychain 有才塞。
    #[test]
    fn tts_ops_take_key_from_keychain_only() {
        let a = serde_json::json!({ "endpoint": "http://x", "api_key": "前端塞的", "voice": "v1" });
        let out = inject_secrets("tts.synth", a);
        assert_ne!(out.get("api_key").and_then(|v| v.as_str()), Some("前端塞的"));
        assert_eq!(out.get("voice").and_then(|v| v.as_str()), Some("v1"));
        if store::kc_get("tts_api_key").is_none() {
            assert!(out.get("api_key").is_none());
        }
    }

    /// 前端帶來的 api_key 一律丟掉：金鑰只有 keychain 一個來源。
    #[test]
    fn frontend_supplied_key_is_discarded() {
        let a = serde_json::json!({ "provider": "anthropic", "api_key": "前端塞的" });
        let out = inject_secrets("assistant.chat", a);
        let got = out.get("api_key").and_then(|v| v.as_str());
        assert_ne!(got, Some("前端塞的"), "前端帶來的金鑰不可以被沿用");
        // 沒存過就完全沒有這個鍵（引擎會回「Anthropic 需要金鑰」並說去哪裡填）
        if store::kc_get("llm_anthropic_api_key").is_none() {
            assert!(got.is_none());
        }
    }
}
