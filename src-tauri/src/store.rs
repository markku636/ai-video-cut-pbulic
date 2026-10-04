//! App 設定持久化 + OS keychain + 三個資料目錄。
//!
//! - `settings.json` 放 `<app_config_dir>`（原子寫入：tmp + rename）。
//! - 金鑰**只存 OS keychain**（service `ai-video-cut`），永不落地磁碟、永不回傳前端（只回「有沒有」）。
//!   A0 沒有任何金鑰；M6 的 LLM 供應商用同一組 `kc_set/kc_get`。
//! - 目錄：`app_config_dir`（設定）、`app_cache_dir`（`media/<fp16>/` 衍生資料，可清）、
//!   `app_local_data_dir`（pyenv / models / tools / logs —— **不是** Roaming 的 app_data_dir，
//!   6 GB 的 venv 進漫遊設定檔是真 bug）。
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

pub const SETTINGS_FILE: &str = "settings.json";
/// keychain service 名。**定一次永不改** —— 換了名字舊使用者存的金鑰就找不到了（ai-music-cut 的教訓）。
pub const KEYCHAIN_SERVICE: &str = "ai-video-cut";

fn default_lang() -> String {
    "zh-TW".to_string()
}

fn default_anthropic_base_url() -> String {
    "https://api.anthropic.com".to_string()
}

/// AI 助手後端的預設：舊使用者升級上來維持原本的 HTTP 端點（引擎 assistant.chat），不會突然改去找 claude CLI。
pub fn default_agent_backend() -> String {
    "http".to_string()
}

fn default_openai_base_url() -> String {
    // 地端 LM Studio 的 OpenAI 相容端點（計畫 §2）；M6 才會用到。
    "http://localhost:1234/v1".to_string()
}

/// 引擎相關設定。欄位名鏡射前端 `store/settings.ts` 的 `engine`（snake_case ↔ camelCase 由 api.ts 轉）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct EngineSettings {
    /// SAM 2.1 變體："small"（預設）| "large"。
    pub sam_variant: String,
    /// 允許選配 SAM 3 後端（gated 權重，只選配不內建）。
    pub allow_sam3: bool,
    /// "classic"（SIFT/AKAZE + MAGSAC + ECC，預設）| "dense"（留 Protocol，v1 不實作）。
    pub tracker: String,
    /// 使用者微調關鍵幀 / 提示點後自動重解鄰近區間。
    pub auto_resolve: bool,
    /// pyenv / models / logs 的根目錄；None ＝ `app_local_data_dir()`。C: 剩不多時搬到 D:。
    pub data_root: Option<String>,
}

impl Default for EngineSettings {
    fn default() -> Self {
        Self {
            sam_variant: "small".to_string(),
            allow_sam3: false,
            tracker: "classic".to_string(),
            auto_resolve: true,
            data_root: None,
        }
    }
}

/// 輸出預設。真正的編碼計畫是 Python `encode_plan.plan()`（唯一一份）；這裡只是它的輸入。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ExportDefaults {
    /// "auto"（同來源容器：webm→libvpx-vp9、mp4→hevc_nvenc→libopenh264 fallback）或明確的 ffmpeg encoder 名。
    pub codec: String,
    /// "draft" | "standard" | "high"（引擎映射成各 codec 的 crf / cq）。
    pub quality: String,
    /// "copy"（-c:a copy，容器不接受時引擎才轉 aac 並列在 dropped）| "aac"。
    pub audio: String,
}

impl Default for ExportDefaults {
    fn default() -> Self {
        Self { codec: "auto".to_string(), quality: "high".to_string(), audio: "copy".to_string() }
    }
}

/// App 全域設定（磁碟格式）。**沒有任何 secret 欄位**——金鑰在 keychain。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    /// ffmpeg 執行檔或其所在目錄；空＝自動偵測（PATH / 內建 / 常見安裝路徑）。
    pub ffmpeg_path: Option<String>,
    pub lang: String,
    pub output_dir: Option<String>,
    pub recent_projects: Vec<String>,
    /// 覆寫受管 venv 的 python（等同 `AIVC_PYTHON` 環境變數；**絕不退回 PATH**）。
    pub python_override: Option<String>,
    pub engine: EngineSettings,
    pub export_defaults: ExportDefaults,
    /// LLM 供應商（M6 才用；A0 保留欄位讓設定檔格式不必再升版）。金鑰在 keychain。
    #[serde(default = "default_anthropic_base_url")]
    pub llm_anthropic_base_url: String,
    #[serde(default)]
    pub llm_anthropic_model: String,
    #[serde(default = "default_openai_base_url")]
    pub llm_openai_base_url: String,
    #[serde(default)]
    pub llm_openai_model: String,
    /// AI 配音（Seal-TTS）伺服器位址；空＝功能關著。金鑰在 keychain（`tts_api_key`）。
    #[serde(default)]
    pub tts_base_url: String,
    /// App 自動更新：自動檢查開關、更新來源覆寫、略過的版本、上次檢查時間（欄位與預設值見 updater.rs）。
    pub updater: crate::updater::UpdaterSettings,
    /// AI 助手的後端：`"http"`（引擎的 assistant.chat，打上面的 LLM 端點；預設＝舊行為）｜`"claude-cli"`｜`"codex-cli"`
    /// （本機 CLI 用使用者自己的訂閱登入，透過 App 內建的 MCP server 直接操作 App）。不認得的值當 http。
    #[serde(default = "default_agent_backend")]
    pub agent_backend: String,
    /// claude CLI 的 `--model`；空＝claude 自己的預設。
    #[serde(default)]
    pub claude_model: String,
    /// codex CLI 的 `-m`；空＝codex 自己的設定（`~/.codex/config.toml`）。
    #[serde(default)]
    pub codex_model: String,
    /// 內建 MCP server 的固定 port；0＝每次啟動隨機（預設）。固定之後，外部的 Claude Code / Codex 登記一次就好
    /// （token 還是每次啟動都換）。改了要重新啟動 App 才生效。
    #[serde(default)]
    pub mcp_port: u16,
    /// 外掛（例如牌組風格 `deck_style_id`）與不認得的鍵原樣保留 —— 舊使用者存的值不會因為 core 不認得就被洗掉；
    /// 前端外掛自己讀寫。攤平在最上層（磁碟上不會多一層 `extra`）；金鑰一樣不准放這裡（只進 keychain）。
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            ffmpeg_path: None,
            lang: default_lang(),
            output_dir: None,
            recent_projects: Vec::new(),
            python_override: None,
            engine: EngineSettings::default(),
            export_defaults: ExportDefaults::default(),
            llm_anthropic_base_url: default_anthropic_base_url(),
            llm_anthropic_model: String::new(),
            llm_openai_base_url: default_openai_base_url(),
            llm_openai_model: String::new(),
            tts_base_url: String::new(),
            updater: crate::updater::UpdaterSettings::default(),
            agent_backend: default_agent_backend(),
            claude_model: String::new(),
            codex_model: String::new(),
            mcp_port: 0,
            extra: serde_json::Map::new(),
        }
    }
}

pub fn app_config_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_config_dir()
        .map_err(|e| AppError::Storage(format!("無法取得設定目錄：{e}")))
}

/// 媒體快取（proxy / 索引 / 縮圖 / 遮罩 / 解算）放 cache dir，可隨時清。
pub fn app_cache_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_cache_dir()
        .map_err(|e| AppError::Storage(format!("無法取得快取目錄：{e}")))
}

/// 本機資料（pyenv / models / tools / logs）：Windows `%LOCALAPPDATA%\net.markkulab.aivideocut`、
/// macOS `~/Library/Application Support/net.markkulab.aivideocut`、Linux `${XDG_DATA_HOME:-~/.local/share}/net.markkulab.aivideocut`。
/// 引擎 `env.data_root()` 與 `bootstrap-engine.sh` 的預設資料根必須算出同一個位置（App 另外以 `AIVC_DATA_ROOT` 明確傳給它們）。
pub fn app_local_data_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_local_data_dir()
        .map_err(|e| AppError::Storage(format!("無法取得本機資料目錄：{e}")))
}

/// 讀取目錄下的 JSON 檔。檔案不存在回 `T::default()`。
pub async fn read_json_in<T: DeserializeOwned + Default>(dir: &Path, file: &str) -> AppResult<T> {
    let path = dir.join(file);
    match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice::<T>(&bytes)
            .map_err(|e| AppError::Storage(format!("解析 {file} 失敗：{e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(AppError::Storage(format!("讀取 {file} 失敗：{e}"))),
    }
}

/// 原子寫入目錄下的 JSON 檔（見 [`write_atomic`]）。
pub async fn write_json_in<T: Serialize>(dir: &Path, file: &str, value: &T) -> AppResult<()> {
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| AppError::Storage(format!("序列化 {file} 失敗：{e}")))?;
    write_atomic(&dir.join(file), bytes).await.map_err(|(stage, e)| {
        AppError::Storage(match stage {
            WriteStage::Write => format!("寫入 {file} 失敗：{e}"),
            WriteStage::Replace => format!("更新 {file} 失敗：{e}"),
        })
    })
}

/// [`write_atomic`] 在哪一步失敗（呼叫端各自翻成「寫入…失敗 / 更新…失敗」）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteStage {
    /// 建目錄 / 寫 tmp / fsync。
    Write,
    /// tmp 換成正式檔。
    Replace,
}

/// 原子寫入 `path`：同目錄的**唯一** tmp（`{name}.{uuid}.tmp`）→ fsync → replace。
///
/// - tmp 名稱不共用：舊版固定 `{path}.tmp`，兩筆寫入重疊時先 rename 的把 tmp 搬走，另一筆 os error 2
///   （自動儲存 + Ctrl+S、自動儲存 + 匯出前的 projectFileFor 都會撞）。
/// - 同一路徑的寫入在行程內排隊（先到先寫，後呼叫的那份留在磁碟上）；不同路徑互不等待。
/// - 失敗時刪掉 tmp，不在使用者的專案資料夾留垃圾；被硬殺留下的舊 tmp 由 `sweep_stale_tmp` 在下一次寫入時清掉
///   （唯一檔名的代價：不會再被下一次寫入蓋掉，所以要自己收）。
/// - Windows：別的行程（引擎的 Python `read_text`、防毒）短暫開著目標檔時 replace 會 os error 5 / 32，
///   退避重試幾次（總計約 0.3 秒）再放棄。
pub async fn write_atomic(path: &Path, bytes: Vec<u8>) -> Result<(), (WriteStage, std::io::Error)> {
    let key = lock_key(path);
    let lock = WRITE_LOCKS.lock().entry(key.clone()).or_default().clone();
    let res = {
        let _guard = lock.lock().await;
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || write_atomic_blocking(&path, &bytes))
            .await
            .unwrap_or_else(|e| Err((WriteStage::Write, std::io::Error::other(e))))
    };
    let mut locks = WRITE_LOCKS.lock();
    // 只剩表裡那份和自己手上這份 = 沒人在排隊，收掉（不然每個開過的專案路徑都留一個 entry）
    if std::sync::Arc::strong_count(&lock) == 2 {
        locks.remove(&key);
    }
    res
}

type PathLocks = parking_lot::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>;
static WRITE_LOCKS: std::sync::LazyLock<PathLocks> = std::sync::LazyLock::new(Default::default);

/// 排隊用的鍵：絕對路徑；Windows 不分大小寫、`/` 與 `\` 等價（前端兩種都會送）。
fn lock_key(path: &Path) -> String {
    let abs = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let s = abs.to_string_lossy().into_owned();
    if cfg!(windows) {
        s.replace('/', "\\").to_lowercase()
    } else {
        s
    }
}

fn write_atomic_blocking(path: &Path, bytes: &[u8]) -> Result<(), (WriteStage, std::io::Error)> {
    let name = path
        .file_name()
        .ok_or_else(|| (WriteStage::Write, std::io::Error::new(std::io::ErrorKind::InvalidInput, "路徑沒有檔名")))?;
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).map_err(|e| (WriteStage::Write, e))?;
    }
    sweep_stale_tmp(path, name);
    let mut tmp_name = name.to_os_string();
    tmp_name.push(format!(".{}.tmp", uuid::Uuid::new_v4().simple()));
    let tmp = path.with_file_name(tmp_name);
    let res = write_then_replace(&tmp, path, bytes);
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

/// tmp 名稱唯一化的代價：行程被硬殺（App 強制關閉、當機）時留下的 `{name}.{uuid}.tmp` 不會再被下一次寫入蓋掉，
/// 會在使用者的專案資料夾裡越積越多。開工前掃一次同名目標的 tmp，夠舊的（＝不可能是別的行程正在寫的）就刪掉。
///
/// 只認 `{name}.{32 位 hex}.tmp`：不會誤刪使用者自己的 `.tmp`，也不會碰到別的檔案的 tmp。
fn sweep_stale_tmp(path: &Path, name: &std::ffi::OsStr) {
    /// 這麼久以前建立的 tmp 一定不是「正在寫」的那顆（一次寫入是毫秒級；留一分鐘給極慢的磁碟／防毒）。
    const STALE: std::time::Duration = std::time::Duration::from_secs(60);
    let Some(dir) = path.parent() else { return };
    let Some(prefix) = name.to_str().map(|n| format!("{n}.")) else { return };
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let now = std::time::SystemTime::now();
    for e in rd.flatten() {
        let Ok(fname) = e.file_name().into_string() else { continue };
        let Some(mid) = fname.strip_prefix(&prefix).and_then(|r| r.strip_suffix(".tmp")) else { continue };
        if mid.len() != 32 || !mid.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > STALE);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

fn write_then_replace(tmp: &Path, path: &Path, bytes: &[u8]) -> Result<(), (WriteStage, std::io::Error)> {
    use std::io::Write;
    let mut f = std::fs::File::create(tmp).map_err(|e| (WriteStage::Write, e))?;
    f.write_all(bytes).map_err(|e| (WriteStage::Write, e))?;
    // 先落盤再 replace：斷電 / 當機時要嘛舊檔、要嘛完整新檔，不會換成一個還沒寫到磁碟的空殼
    f.sync_all().map_err(|e| (WriteStage::Write, e))?;
    drop(f);
    replace_with_retry(tmp, path).map_err(|e| (WriteStage::Replace, e))
}

fn replace_with_retry(from: &Path, to: &Path) -> std::io::Result<()> {
    // 5 ERROR_ACCESS_DENIED / 32 ERROR_SHARING_VIOLATION / 33 ERROR_LOCK_VIOLATION：別的行程暫時開著目標檔
    const BACKOFF_MS: [u64; 7] = [5, 10, 20, 40, 60, 80, 100];
    let mut attempt = 0;
    loop {
        match std::fs::rename(from, to) {
            Err(e) if cfg!(windows) && matches!(e.raw_os_error(), Some(5 | 32 | 33)) && attempt < BACKOFF_MS.len() => {
                std::thread::sleep(std::time::Duration::from_millis(BACKOFF_MS[attempt]));
                attempt += 1;
            }
            other => return other,
        }
    }
}

pub async fn read_json<T: DeserializeOwned + Default>(app: &AppHandle, file: &str) -> AppResult<T> {
    read_json_in(&app_config_dir(app)?, file).await
}

pub async fn write_json<T: Serialize>(app: &AppHandle, file: &str, value: &T) -> AppResult<()> {
    write_json_in(&app_config_dir(app)?, file, value).await
}

// ---- keychain ----

/// 寫入 keychain。secret 為空字串時視為「刪除該項」。
pub fn kc_set(account: &str, secret: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .map_err(|e| AppError::Storage(format!("keychain 開啟失敗：{e}")))?;
    if secret.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry
        .set_password(secret)
        .map_err(|e| AppError::Storage(format!("keychain 寫入失敗：{e}")))?;
    Ok(())
}

/// 讀取 keychain。不存在或任何錯誤都回 None（不洩漏 secret，只記 account）。
pub fn kc_get(account: &str) -> Option<String> {
    let entry = match keyring::Entry::new(KEYCHAIN_SERVICE, account) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[store] keychain 開啟失敗 ({account})：{e}");
            return None;
        }
    };
    match entry.get_password() {
        Ok(p) => Some(p),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            eprintln!("[store] keychain 讀取失敗 ({account})：{e}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("aivc-store-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[tokio::test]
    async fn settings_roundtrip_and_defaults() {
        let dir = tmpdir();
        let s: AppSettings = read_json_in(&dir, SETTINGS_FILE).await.unwrap();
        assert_eq!(s.lang, "zh-TW");
        assert_eq!(s.engine.sam_variant, "small");
        assert!(s.engine.auto_resolve);
        assert_eq!(s.export_defaults.audio, "copy");
        assert!(s.extra.is_empty(), "全新的設定沒有任何外掛鍵");
        let mut s2 = s.clone();
        s2.engine.data_root = Some("D:\\aivc-data".into());
        s2.recent_projects.push("x.aivc.json".into());
        write_json_in(&dir, SETTINGS_FILE, &s2).await.unwrap();
        let back: AppSettings = read_json_in(&dir, SETTINGS_FILE).await.unwrap();
        assert_eq!(back.engine.data_root.as_deref(), Some("D:\\aivc-data"));
        assert_eq!(back.recent_projects.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 設定連續改兩下（兩筆 settings_save 重疊）：舊版共用 `settings.json.tmp`，其中一筆 os error 2。
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn overlapping_settings_writes_never_fail() {
        let dir = std::env::temp_dir().join(format!("aivc 設定 測試-{}", uuid::Uuid::new_v4()));
        let a = AppSettings {
            recent_projects: (0..400).map(|i| format!("C:/Users/user/Desktop/客戶 影片/專案 {i}.aivc.json")).collect(),
            ..Default::default()
        };
        let b = AppSettings { lang: "en".into(), ..Default::default() };
        let (mut failed, mut first_err) = (0, None);
        for _ in 0..100 {
            let (ra, rb) = tokio::join!(write_json_in(&dir, SETTINGS_FILE, &a), write_json_in(&dir, SETTINGS_FILE, &b));
            for r in [ra, rb] {
                if let Err(e) = r {
                    failed += 1;
                    first_err.get_or_insert_with(|| e.to_string());
                }
            }
        }
        let back: AppSettings = read_json_in(&dir, SETTINGS_FILE).await.unwrap();
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!((failed, leftovers.len()), (0, 0), "失敗 {failed}、殘留 {leftovers:?}；例：{first_err:?}");
        assert_eq!(back.lang, "en", "後呼叫的那份要贏");
    }

    /// 唯一 tmp 名的代價：被硬殺留下的 `{name}.{uuid}.tmp` 不會再被下一次寫入蓋掉，會在使用者的專案資料夾
    /// 裡越積越多（舊版固定 `{name}.tmp`，下一次寫入就覆蓋掉）。夠舊的自己收，別人的 `.tmp` 不碰。
    #[tokio::test]
    async fn stale_temp_files_are_swept_on_the_next_write() {
        let dir = tmpdir();
        std::fs::create_dir_all(&dir).unwrap();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
        let mine_stale = dir.join(format!("{SETTINGS_FILE}.{}.tmp", uuid::Uuid::new_v4().simple()));
        let mine_fresh = dir.join(format!("{SETTINGS_FILE}.{}.tmp", uuid::Uuid::new_v4().simple()));
        let other_file = dir.join(format!("專案 一.aivc.json.{}.tmp", uuid::Uuid::new_v4().simple()));
        let users_own = dir.join("settings.json.tmp"); // 不是 `{uuid}.tmp` 的形狀 → 不是我們的
        for p in [&mine_stale, &mine_fresh, &other_file, &users_own] {
            std::fs::write(p, b"leftover").unwrap();
        }
        for p in [&mine_stale, &other_file, &users_own] {
            std::fs::File::options().write(true).open(p).unwrap().set_modified(old).unwrap();
        }

        write_json_in(&dir, SETTINGS_FILE, &AppSettings::default()).await.unwrap();

        let exists = |p: &std::path::Path| p.exists();
        let (a, b, c, d) = (exists(&mine_stale), exists(&mine_fresh), exists(&other_file), exists(&users_own));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(!a, "自己留下的舊 tmp 要清掉");
        assert!(b, "剛建立的 tmp 可能是別的行程正在寫");
        assert!(c, "別的檔案的 tmp 不歸這次寫入管");
        assert!(d, "形狀不符的 .tmp 可能是使用者自己的檔");
    }

    /// 舊版設定檔缺欄位 → 走預設值，不可整份讀失敗（巢狀的 engine 也一樣）。
    #[tokio::test]
    async fn settings_tolerates_missing_fields() {
        let dir = tmpdir();
        std::fs::write(dir.join(SETTINGS_FILE), r#"{"lang":"en","engine":{"sam_variant":"large"}}"#).unwrap();
        let s: AppSettings = read_json_in(&dir, SETTINGS_FILE).await.unwrap();
        assert_eq!(s.lang, "en");
        assert_eq!(s.engine.sam_variant, "large");
        assert_eq!(s.engine.tracker, "classic");
        assert_eq!(s.export_defaults.codec, "auto");
        // AI 後端（v0.0.7 新增）：舊使用者維持 HTTP 端點、MCP 隨機 port，模型交給各 CLI 自己的預設
        assert_eq!(s.agent_backend, "http");
        assert_eq!((s.claude_model.as_str(), s.codex_model.as_str(), s.mcp_port), ("", "", 0));
        assert!(s.extra.is_empty(), "新欄位不會掉進 extra");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn agent_backend_settings_roundtrip() {
        let dir = tmpdir();
        let s = AppSettings { agent_backend: "codex-cli".into(), claude_model: "sonnet".into(), codex_model: "gpt-5.5".into(), mcp_port: 47123, ..Default::default() };
        write_json_in(&dir, SETTINGS_FILE, &s).await.unwrap();
        let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join(SETTINGS_FILE)).unwrap()).unwrap();
        assert_eq!(raw["agent_backend"], "codex-cli");
        assert_eq!(raw["mcp_port"], 47123);
        let back: AppSettings = read_json_in(&dir, SETTINGS_FILE).await.unwrap();
        assert_eq!((back.agent_backend.as_str(), back.claude_model.as_str(), back.codex_model.as_str(), back.mcp_port), ("codex-cli", "sonnet", "gpt-5.5", 47123));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 舊設定檔裡 core 已經不認得的鍵（牌組風格 `deck_style_id` 改歸外掛管、其他外掛的巢狀物件）：
    /// 讀進來 → 寫回 → 再讀，值與鍵序都原樣、仍攤平在最上層；認得的欄位照常運作。
    /// 以前 serde 會默默丟掉不認得的鍵 —— 升級後使用者選過的值就被洗成外掛的預設。
    #[tokio::test]
    async fn plugin_and_unknown_keys_survive_a_write_back() {
        let dir = tmpdir();
        std::fs::write(
            dir.join(SETTINGS_FILE),
            r#"{"lang":"en","deck_style_id":"my-deck","engine":{"sam_variant":"large"},"somePlugin":{"x":1,"list":[1.5,"a",null],"nested":{"y":true}}}"#,
        )
        .unwrap();
        let plugin = serde_json::json!({"x": 1, "list": [1.5, "a", null], "nested": {"y": true}});
        let keys = |m: &serde_json::Map<String, serde_json::Value>| m.keys().cloned().collect::<Vec<_>>();

        let s: AppSettings = read_json_in(&dir, SETTINGS_FILE).await.unwrap();
        // 認得的欄位照常（缺的補預設），而且不會跑進 extra
        assert_eq!(s.lang, "en");
        assert_eq!((s.engine.sam_variant.as_str(), s.engine.tracker.as_str()), ("large", "classic"));
        assert_eq!(s.llm_anthropic_base_url, "https://api.anthropic.com");
        assert_eq!(keys(&s.extra), ["deck_style_id", "somePlugin"]);
        assert_eq!(s.extra["deck_style_id"], "my-deck");
        assert_eq!(s.extra["somePlugin"], plugin);

        // 使用者改了一個認得的欄位 → 整份寫回（settings_set 走的就是這條）
        let mut s2 = s.clone();
        s2.lang = "zh-TW".into();
        write_json_in(&dir, SETTINGS_FILE, &s2).await.unwrap();

        // 磁碟上：外掛鍵還在最上層、原樣，不會被包進一層 "extra"
        let raw: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join(SETTINGS_FILE)).unwrap()).unwrap();
        assert_eq!(raw["lang"], "zh-TW");
        assert_eq!(raw["deck_style_id"], "my-deck");
        assert_eq!(raw["somePlugin"], plugin);
        assert!(raw.get("extra").is_none(), "flatten：磁碟格式不能多一層 extra");

        let back: AppSettings = read_json_in(&dir, SETTINGS_FILE).await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(back.lang, "zh-TW");
        assert_eq!(back.engine.sam_variant, "large");
        assert_eq!(keys(&back.extra), ["deck_style_id", "somePlugin"]);
        assert_eq!(back.extra, s.extra, "外掛鍵與不認得的鍵原樣保留");
    }

    /// 設定檔序列化後絕不能出現金鑰欄位（金鑰只在 keychain）。
    #[test]
    fn settings_have_no_secret_fields() {
        let json = serde_json::to_string(&AppSettings::default()).unwrap().to_lowercase();
        assert!(!json.contains("api_key") && !json.contains("apikey") && !json.contains("secret") && !json.contains("token"));
    }

    #[test]
    fn keychain_service_name_is_pinned() {
        // 定一次永不改：換了舊使用者的金鑰就找不到
        assert_eq!(KEYCHAIN_SERVICE, "ai-video-cut");
    }
}
