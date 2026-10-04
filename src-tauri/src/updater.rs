//! App 自動更新（tauri-plugin-updater 2.13）：狀態、檢查、下載（`update-progress` 事件，可取消）、裝前停引擎與子行程、安裝。
//!
//! 為什麼全部走自己的 Rust 指令，不讓前端直接用 `@tauri-apps/plugin-updater`：
//! - **裝之前一定要先停引擎與 ffmpeg。** Windows 的 `Update::install()` 啟動 NSIS 安裝程式後直接 `std::process::exit(0)`：
//!   `RunEvent::ExitRequested` 不會觸發（lib.rs 那段 engine.shutdown 不會跑），tokio 的 kill_on_drop 也不會。
//!   引擎的 ffmpeg 子行程鎖著 `<安裝目錄>\resources\ffmpeg\*`，NSIS 只殺 ai-video-cut.exe，覆寫就卡在「檔案使用中」。
//!   JS 的 `install()` 會繞過這一步，所以 capabilities **不給** `updater:*`，唯一的路是 `update_install`。
//! - 更新來源要能被設定覆寫（`settings.updater.update_endpoint`）；JS 的 `check()` 只吃設定檔裡的 endpoints。
//! - 下載進度、簽章驗證失敗、平台缺檔…要翻成人話（`friendly_error`）。
//!
//! 下載與安裝是兩支指令（`update_download` → `update_install`）：下載要好幾分鐘，使用者會按「在背景繼續」回去編輯；
//! 下載完前端要**再**看一次有沒有工作在跑、專案有沒有沒存的變更，問過才裝（Windows 的 install() 直接結束行程，不會有關閉提示）。
//! 下載途中可以 `update_cancel`。安裝時先舉 `Engine::set_update_lock`（之後引擎、ffmpeg、引擎安裝都不准再開），
//! 才看忙不忙、停引擎、收 ffmpeg —— 停的途中 UI 還能操作，不擋的話新的 python / ffmpeg 會在 exit(0) 之後活下來鎖住檔案。
//!
//! 安全規則（`check_url_policy`，有單元測試）：更新來源與下載網址只收 https；http 只准 localhost / 127.0.0.1 / [::1]
//! （本機測試伺服器，見 docs/updater.md）。tauri.conf.json 因此開了 `dangerousInsecureTransportProtocol`：外掛自己的檢查
//! 在 release build 連本機 http 也擋，規則改由這裡把關（設定檔的 endpoints、覆寫網址、latest.json 給的下載網址一律過同一關）。
//! 不論來源是什麼，安裝檔都要通過 `plugins.updater.pubkey` 的 minisign 簽章驗證才會安裝；公鑰是空的就整個停用
//! （`updater_status` 回 `enabled: false`、`reasonCode: "no_pubkey"`）—— 空公鑰時外掛照樣能檢查，卻會在下載到 100% 後
//! 以「Invalid encoding in minisign data」失敗，等於宣告了一個永遠裝不起來的更新。
//! `requireSignedVersion` 開著（tauri-cli 2.12 起簽章的 trusted comment 帶 `version:`，受簽章保護）：latest.json 本身沒有簽章，
//! 不開的話拿得到它的人可以宣稱「99.0.0」、配上舊版真的安裝檔與 .sig，把使用者降級成舊版。
//!
//! 對前端的 payload 是 camelCase（`currentVersion`、`reasonCode`），只有 `settings.json` 裡的 `updater` 設定沿用 snake_case
//! （設定檔整份都是 snake_case，見 store.rs）。
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::commands::AppState;
use crate::error::{AppError, AppResult};
use crate::{engine, pyenv};

/// 下載 / 驗簽 / 安裝的進度事件：`{ phase: "downloading" | "verifying" | "installing", downloaded, total }`。
pub const EV_PROGRESS: &str = "update-progress";
/// 檢查（只抓 latest.json）預設的整體逾時；前端可以帶 `timeoutMs` 覆寫（夾在 3–120 秒）。
pub const DEFAULT_CHECK_TIMEOUT: Duration = Duration::from_secs(20);
const MIN_CHECK_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_CHECK_TIMEOUT: Duration = Duration::from_secs(120);
/// 連線逾時（檢查與下載都套）。
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// 下載中「多久沒收到任何資料就放棄」。**不設整體逾時**：安裝檔約 60 MB，慢的網路要好幾分鐘，整體逾時只會讓它永遠下載不完。
pub const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// 舉起 Rust 端長工作的取消旗標後，最多等它們收掉多久（波形峰值的 ffmpeg 解碼看到旗標就 kill）。
const RUST_JOBS_GRACE: Duration = Duration::from_secs(2);
/// 下載途中多久看一次取消旗標。
const CANCEL_POLL: Duration = Duration::from_millis(100);
/// `plugins.updater` 裡給這支模組看的鍵（外掛不認得、會忽略）：false＝設定裡的覆寫網址不生效。
/// 私有建置（plugins/cards/tauri.conf.overlay.json）設 false：它跟開源版共用 identifier，也就共用 settings.json，
/// 開源版留下的覆寫網址（或使用者在設定頁填的）不能把私有建置接到公開頻道。
pub const ALLOW_OVERRIDE_KEY: &str = "allowEndpointOverride";
/// 進度事件至少隔這麼多位元組才發一次（另外也至少隔 1%）：60 MB 的安裝檔一塊 16 KB，逐塊發就是四千個事件。
pub const PROGRESS_MIN_STEP: u64 = 512 * 1024;

// ---------------- 設定 ----------------

/// 自動更新的設定（`settings.json` 的 `updater` 物件；鏡射前端 `api.ts` 的 `UpdaterSettings`）。
/// 舊版設定檔沒有這一段 → `#[serde(default)]` 補預設值（自動檢查開、沒有覆寫、沒有略過的版本）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct UpdaterSettings {
    /// 啟動後在背景檢查（每天最多一次，節流在前端 `src/updater/policy.ts`）。預設開。
    pub auto_check_updates: bool,
    /// 進階：覆寫更新來源（latest.json 的網址）；空字串＝用 tauri.conf.json 的 endpoints。規則見 `check_url_policy`。
    pub update_endpoint: String,
    /// 使用者按了「略過這個版本」的版號；背景檢查遇到同一版不再提示（手動檢查照樣顯示）。
    pub skipped_update_version: String,
    /// 上一次成功檢查的時間（Unix 毫秒；0＝從沒檢查過）。前端用它做 24 小時節流。
    pub last_update_check: u64,
}

impl Default for UpdaterSettings {
    fn default() -> Self {
        Self { auto_check_updates: true, update_endpoint: String::new(), skipped_update_version: String::new(), last_update_check: 0 }
    }
}

// ---------------- 網址規則 ----------------

/// 更新來源 / 下載網址的規則：https 一律可以；http 只准本機（localhost、127.0.0.0/8、::1 —— 本機測試伺服器用）；
/// 不准帶帳號密碼（設定檔是明文，而且 latest.json 的網址會出現在 log 與畫面上）。回 Err 時是給人看的原因。
pub fn check_url_policy(url: &Url) -> Result<(), String> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err("網址不能含帳號或密碼".into());
    }
    match url.scheme() {
        "https" if url.host_str().is_some_and(|h| !h.is_empty()) => Ok(()),
        "https" => Err("網址缺主機名稱".into()),
        "http" if is_loopback(url) => Ok(()),
        "http" => Err("只接受 https（http 只准 localhost / 127.0.0.1，給本機測試用）".into()),
        other => Err(format!("不支援 {other}: 網址（只接受 https）")),
    }
}

fn is_loopback(url: &Url) -> bool {
    match url.host_str() {
        Some(h) if h.eq_ignore_ascii_case("localhost") => true,
        // IPv6 的 host_str 帶方括號（[::1]）
        Some(h) => h.trim_start_matches('[').trim_end_matches(']').parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()),
        None => false,
    }
}

/// 使用者填的覆寫網址 → `Url`（去頭尾空白、解析、過 `check_url_policy`）。
pub fn validate_endpoint(raw: &str) -> Result<Url, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("網址是空的".into());
    }
    let url = Url::parse(s).map_err(|e| format!("不是有效的網址（{e}）"))?;
    check_url_policy(&url)?;
    Ok(url)
}

// ---------------- 狀態 ----------------

/// `updater_status` 的回覆，也是設定頁「更新」那一段的資料。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterStatus {
    pub enabled: bool,
    /// 停用原因的代碼（前端依它挑翻譯）：`no_config` | `no_pubkey` | `no_endpoint` | `bad_config_endpoint` | `bad_endpoint`。
    pub reason_code: Option<&'static str>,
    /// 停用原因（繁中人話；log、以及前端認不得代碼時用）。
    pub reason: Option<String>,
    pub current_version: String,
    /// 實際會去問的網址（覆寫或設定檔的第一個）；設定檔沒有來源時是 None。
    pub endpoint: Option<String>,
    /// tauri.conf.json 的第一個 endpoint（設定頁的 placeholder）。
    pub default_endpoint: Option<String>,
    /// 目前用的是設定裡的覆寫網址。
    pub overridden: bool,
    /// 這個版本接不接受覆寫網址（`plugins.updater.allowEndpointOverride`，預設 true；私有建置是 false）。
    pub override_allowed: bool,
    /// debug build：`update_install` 會拒絕（沒有安裝檔標記，裝下去會把正式版蓋到已安裝的那一份），背景檢查也不跑。
    pub dev_build: bool,
}

/// 由 `plugins.updater` 設定（tauri.conf.json，含 `--config` 疊上去的 overlay）與覆寫網址算出狀態與實際要問的網址（純函式）。
///
/// 順序：沒有設定 → 沒有公鑰 → 設定檔的網址不合規定 → 設定檔沒有網址 → 覆寫網址不合規定。
/// **設定檔沒有網址時覆寫也不生效**：私有建置（plugins/cards/tauri.conf.overlay.json）就是靠清空 endpoints 停用自動更新，
/// 不能讓一個覆寫網址又把它接回公開頻道、被開源版蓋掉。
/// **`allowEndpointOverride: false` 時覆寫一律不看**（設定檔的來源照用）：私有建置之後填了自己的來源也一樣，
/// 覆寫網址接不到公開頻道（再加上私有建置用另一把金鑰，見 docs/updater.md，公開版的安裝檔也驗不過）。
pub fn resolve_status(plugin_cfg: Option<&Value>, override_: &str, current_version: &str, dev_build: bool) -> (UpdaterStatus, Vec<Url>) {
    let mut st = UpdaterStatus {
        enabled: false,
        reason_code: None,
        reason: None,
        current_version: current_version.to_string(),
        endpoint: None,
        default_endpoint: None,
        overridden: false,
        override_allowed: true,
        dev_build,
    };
    let disabled = |mut st: UpdaterStatus, code: &'static str, why: String| {
        st.reason_code = Some(code);
        st.reason = Some(why);
        (st, Vec::new())
    };
    let Some(cfg) = plugin_cfg.filter(|v| v.is_object()) else {
        return disabled(st, "no_config", "這個版本沒有設定自動更新（tauri.conf.json 缺 plugins.updater）".into());
    };
    let configured: Vec<&str> = cfg.get("endpoints").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    st.default_endpoint = configured.first().map(|s| s.to_string());
    // 認得的只有 false；鍵不在、或不是布林 → 照預設允許（公開版不必寫這個鍵）
    st.override_allowed = cfg.get(ALLOW_OVERRIDE_KEY).and_then(Value::as_bool) != Some(false);
    if cfg.get("pubkey").and_then(Value::as_str).is_none_or(|k| k.trim().is_empty()) {
        return disabled(st, "no_pubkey", "還沒有設定更新簽章的公鑰（plugins.updater.pubkey 是空的）：無法驗證更新檔，自動更新停用".into());
    }
    let mut endpoints = Vec::with_capacity(configured.len());
    for raw in &configured {
        match validate_endpoint(raw) {
            Ok(u) => endpoints.push(u),
            Err(why) => return disabled(st, "bad_config_endpoint", format!("設定檔的更新來源 {raw} 不合規定：{why}")),
        }
    }
    if endpoints.is_empty() {
        return disabled(st, "no_endpoint", "這個版本沒有設定更新來源（plugins.updater.endpoints 是空的）".into());
    }
    if st.override_allowed && !override_.trim().is_empty() {
        match validate_endpoint(override_) {
            Ok(u) => {
                endpoints = vec![u];
                st.overridden = true;
            }
            Err(why) => return disabled(st, "bad_endpoint", format!("設定裡的更新來源網址不合規定：{why}")),
        }
    }
    st.endpoint = endpoints.first().map(Url::to_string);
    st.enabled = true;
    (st, endpoints)
}

fn current_status(app: &AppHandle, state: &AppState) -> (UpdaterStatus, Vec<Url>) {
    let over = state.settings.read().updater.update_endpoint.clone();
    resolve_status(app.config().plugins.0.get("updater"), &over, &app.package_info().version.to_string(), cfg!(debug_assertions))
}

#[tauri::command]
pub fn updater_status(app: AppHandle, state: State<'_, AppState>) -> UpdaterStatus {
    current_status(&app, &state).0
}

// ---------------- 錯誤 ----------------

/// 外掛的錯誤 → 給人看的一句話。外掛的英文原文只適合 log（「Could not fetch a valid release JSON from the remote」
/// 不會告訴使用者其實是 Release 還沒發、或 repo 是私有的）。
pub fn friendly_error(e: &tauri_plugin_updater::Error) -> String {
    use tauri_plugin_updater::Error as E;
    match e {
        E::EmptyEndpoints => "沒有設定更新來源".into(),
        E::ReleaseNotFound => "更新來源沒有回應可用的版本資訊（latest.json 不存在、Release 還沒發布，或來源不是公開的）".into(),
        E::TargetsNotFound(t) => format!("這一版沒有提供這個平台的更新檔（找過 {}）", t.join("、")),
        E::TargetNotFound(t) => format!("這一版沒有提供這個平台的更新檔（{t}）"),
        E::InsecureTransportProtocol => "更新來源必須是 https".into(),
        E::Reqwest(r) if r.is_timeout() => "連線逾時：更新伺服器沒有回應".into(),
        E::Reqwest(r) if r.is_connect() => "連不上更新伺服器（離線，或網址不對）".into(),
        E::Reqwest(r) => match r.status() {
            Some(s) => format!("更新伺服器回應 {s}"),
            None => format!("網路錯誤（{r}）"),
        },
        E::Network(m) => format!("下載失敗（{m}）"),
        E::Serialization(_) => "更新來源回的不是有效的版本資訊（latest.json 格式不對）".into(),
        E::Semver(_) => "更新來源的版本號格式不對".into(),
        E::Minisign(_) | E::Base64(_) | E::SignatureUtf8(_) => format!("更新檔的簽章驗證失敗，不安裝（{e}）"),
        E::SignedVersionMismatch { .. } | E::MissingSignedVersion => format!("更新檔的簽章與宣告的版本不符，不安裝（{e}）"),
        E::InvalidUpdaterFormat | E::BinaryNotFoundInArchive => format!("下載到的不是這個平台能安裝的更新檔（{e}）"),
        E::UnsupportedArch | E::UnsupportedOs => format!("這個平台不支援自動更新（{e}）"),
        _ => e.to_string(),
    }
}

fn updater_err(e: tauri_plugin_updater::Error) -> AppError {
    AppError::Invalid(friendly_error(&e))
}

// ---------------- 檢查 ----------------

/// `update_check` 的回覆（找到新版時）。`notes` 是 latest.json 的 notes（純文字顯示，不當 HTML）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    /// RFC 3339（UTC）；latest.json 沒有 pub_date 時是 None。
    pub date: Option<String>,
}

impl UpdateInfo {
    fn of(u: &Update) -> Self {
        Self {
            version: u.version.clone(),
            current_version: u.current_version.clone(),
            notes: u.body.clone().filter(|b| !b.trim().is_empty()),
            date: u
                .date
                .and_then(|d| chrono::DateTime::<chrono::Utc>::from_timestamp(d.unix_timestamp(), 0))
                .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        }
    }
}

/// 檢查到、還沒安裝的那一版。`Update` 留在 Rust（前端只拿到 `UpdateInfo`），裝的時候直接用；
/// 下載完、驗過簽章的 bytes 也留著：安裝被擋（有工作在跑）之後再按一次不必重新下載。
struct Pending {
    update: Update,
    bytes: Option<Arc<Vec<u8>>>,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);
/// 行程內唯一的「下載或安裝進行中」旗標（雙擊安裝、下載途中又按檢查）。
static BUSY: AtomicBool = AtomicBool::new(false);
/// 正在下載（`update_cancel` 只在這時有作用：安裝階段已經停了引擎，不能半途喊停）。
static DOWNLOADING: AtomicBool = AtomicBool::new(false);
/// `update_cancel` 舉的旗標；每次開始下載時放下。
static CANCEL_DOWNLOAD: AtomicBool = AtomicBool::new(false);

/// 換掉待安裝的版本。同一版（版號、網址、簽章都一樣）就沿用已下載的 bytes。
fn replace_pending(u: Option<Update>) {
    let mut p = PENDING.lock();
    let keep = match (p.as_ref(), u.as_ref()) {
        (Some(old), Some(new)) => same_release(&old.update, new).then(|| old.bytes.clone()).flatten(),
        _ => None,
    };
    *p = u.map(|update| Pending { update, bytes: keep });
}

fn same_release(a: &Update, b: &Update) -> bool {
    a.version == b.version && a.download_url == b.download_url && a.signature == b.signature
}

/// 檢查的整體逾時：前端給的（毫秒）夾在 3–120 秒；沒給用 20 秒。
pub fn check_timeout(timeout_ms: Option<u64>) -> Duration {
    timeout_ms.map(Duration::from_millis).unwrap_or(DEFAULT_CHECK_TIMEOUT).clamp(MIN_CHECK_TIMEOUT, MAX_CHECK_TIMEOUT)
}

/// 檢查更新：回 null（已是最新）或 `{version, currentVersion, notes, date}`；找到的那一版留在 Rust 等 `update_download`。
/// 停用（沒有公鑰 / 沒有來源 / 覆寫網址不合規定）時回錯誤，訊息就是停用原因。
#[tauri::command]
pub async fn update_check(app: AppHandle, state: State<'_, AppState>, timeout_ms: Option<u64>) -> AppResult<Option<UpdateInfo>> {
    if BUSY.load(Ordering::SeqCst) {
        return Err(AppError::Invalid("正在下載或安裝更新".into()));
    }
    let (st, endpoints) = current_status(&app, &state);
    if !st.enabled {
        return Err(AppError::Invalid(st.reason.unwrap_or_else(|| "自動更新已停用".into())));
    }
    // 來源是 https 就整條路只走 https（含轉址與之後的下載，client 設定會跟著 Update 走）：
    // 不讓一個轉址把 latest.json 或安裝檔降級成明文 http。只有本機測試伺服器（http://127.0.0.1）例外
    let https_only = endpoints.iter().all(|u| u.scheme() == "https");
    let updater = app
        .updater_builder()
        .endpoints(endpoints)
        .map_err(updater_err)?
        .timeout(check_timeout(timeout_ms))
        // 型別是外掛自帶的 reqwest 0.13（與 App 的 reqwest 0.12 不同），交給推論，不在這裡指名
        .configure_client(move |b| b.connect_timeout(CONNECT_TIMEOUT).read_timeout(READ_TIMEOUT).https_only(https_only))
        .build()
        .map_err(updater_err)?;
    let found = updater.check().await.map_err(updater_err)?;
    let Some(u) = found else {
        replace_pending(None);
        return Ok(None);
    };
    // latest.json 裡的下載網址也要過同一套規則（外掛只檢查 endpoints，不檢查下載網址）
    check_url_policy(&u.download_url).map_err(|why| AppError::Invalid(format!("更新檔的下載網址不合規定：{why}")))?;
    let info = UpdateInfo::of(&u);
    replace_pending(Some(u));
    Ok(Some(info))
}

// ---------------- 安裝 ----------------

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ProgressEvent {
    /// "downloading" | "verifying" | "installing"
    pub phase: &'static str,
    pub downloaded: u64,
    /// Content-Length；伺服器沒給就是 None（畫面只顯示已下載的量）。
    pub total: Option<u64>,
}

fn emit_progress(app: &AppHandle, phase: &'static str, downloaded: u64, total: Option<u64>) {
    let _ = app.emit(EV_PROGRESS, ProgressEvent { phase, downloaded, total });
}

/// 進度事件的節流：第一塊一定發；之後至少隔 `PROGRESS_MIN_STEP` 位元組、也至少隔 1%；到 100% 一定發。
#[derive(Default, Debug)]
pub struct ProgressGate {
    last: Option<u64>,
}

impl ProgressGate {
    pub fn should_emit(&mut self, downloaded: u64, total: Option<u64>) -> bool {
        let step = total.map(|t| t / 100).unwrap_or(0).max(PROGRESS_MIN_STEP);
        let emit = match self.last {
            None => true,
            Some(last) => downloaded >= last.saturating_add(step) || total.is_some_and(|t| downloaded >= t && last < t),
        };
        if emit {
            self.last = Some(downloaded);
        }
        emit
    }
}

/// 現在不能裝的原因（純函式）：引擎環境正在安裝、引擎還有工作在跑 / 排隊、或還有短呼叫在等回覆（AI 助手的對話可以等 3 分鐘，
/// 停引擎會把它以「已取消」結束）。None＝可以裝。
pub fn busy_reason(engine_running: usize, engine_queued: usize, pending_calls: usize, pyenv_installing: bool) -> Option<String> {
    if pyenv_installing {
        return Some("引擎環境正在安裝：等它裝完再更新 App".into());
    }
    let n = engine_running + engine_queued;
    if n > 0 {
        return Some(format!("還有 {n} 個引擎工作在執行或排隊：等它們完成（或取消）之後再安裝更新"));
    }
    (pending_calls > 0).then(|| format!("還有 {pending_calls} 個引擎請求在等回覆（例如 AI 助手）：等它完成再安裝更新"))
}

fn busy_now(state: &AppState) -> Option<String> {
    let info = state.engine.info();
    busy_reason(info.running.len(), info.queued.len(), state.engine.pending_calls(), pyenv::install_in_progress())
}

/// `update_download` 的回覆：`canceled`＝使用者按了取消（不是錯誤，畫面回到「有新版本」）。
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadOutcome {
    pub canceled: bool,
}

/// `update_install` 的回覆。Windows 走不到這裡（安裝程式接手後 App 直接結束、裝完自己重開）；
/// macOS / Linux 裝完舊行程還在跑，`restartRequired` 為 true，前端接著呼叫 `relaunch()`（process 外掛）。
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub restart_required: bool,
}

/// 跑 `fut`，途中 `flag` 舉起就丟掉它（drop 下載的 future＝關掉連線）並回 None。
pub async fn until_canceled<F: std::future::Future>(fut: F, flag: &AtomicBool) -> Option<F::Output> {
    let watch = async {
        while !flag.load(Ordering::SeqCst) {
            tokio::time::sleep(CANCEL_POLL).await;
        }
    };
    tokio::select! {
        r = fut => Some(r),
        () = watch => None,
    }
}

/// 下載（進度走 `update-progress`）→ 驗簽，bytes 留在 Rust 等 `update_install`。要先 `update_check` 找到新版。
/// 已經下載過同一版就直接回（安裝被擋、或使用者先按了「稍後」，再按一次不必重新下載）。
/// 這一步不碰引擎也不碰專案：使用者可以按「在背景繼續」回去工作，下載完前端會再守門、問過才呼叫 `update_install`。
#[tauri::command]
pub async fn update_download(app: AppHandle) -> AppResult<DownloadOutcome> {
    if cfg!(debug_assertions) {
        return Err(AppError::Invalid("開發版（debug build）不能安裝更新：請用安裝檔版本測試（見 docs/updater.md）".into()));
    }
    let Some(_busy) = pyenv::try_acquire(&BUSY) else {
        return Err(AppError::Invalid("已經在下載或安裝更新".into()));
    };
    let update = match PENDING.lock().as_ref() {
        Some(p) if p.bytes.is_some() => return Ok(DownloadOutcome { canceled: false }),
        Some(p) => p.update.clone(),
        None => return Err(AppError::Invalid("請先檢查更新".into())),
    };
    CANCEL_DOWNLOAD.store(false, Ordering::SeqCst);
    let got = {
        let _downloading = pyenv::try_acquire(&DOWNLOADING);
        until_canceled(download(&app, &update), &CANCEL_DOWNLOAD).await
    };
    let Some(bytes) = got else {
        return Ok(DownloadOutcome { canceled: true });
    };
    let bytes = Arc::new(bytes?);
    if let Some(p) = PENDING.lock().as_mut().filter(|p| same_release(&p.update, &update)) {
        p.bytes = Some(bytes);
    }
    Ok(DownloadOutcome { canceled: false })
}

/// 取消進行中的下載。回 true＝真的有一個下載被叫停；安裝階段（已經在停引擎）不能取消，回 false。
#[tauri::command]
pub fn update_cancel() -> bool {
    if !DOWNLOADING.load(Ordering::SeqCst) {
        return false;
    }
    CANCEL_DOWNLOAD.store(true, Ordering::SeqCst);
    true
}

/// 持有期間 `Engine::update_lock` 舉著；安裝失敗（含提早 return）drop 時放下。安裝成功就 `keep()`：
/// Windows 行程直接結束；macOS / Linux 接著 relaunch，磁碟上已經是新版，舊行程不該再啟動引擎。
struct UpdateLock<'a> {
    engine: &'a engine::Engine,
    keep: bool,
}

impl<'a> UpdateLock<'a> {
    fn raise(engine: &'a engine::Engine) -> Self {
        engine.set_update_lock(true);
        Self { engine, keep: false }
    }

    fn keep(mut self) {
        self.keep = true;
    }
}

impl Drop for UpdateLock<'_> {
    fn drop(&mut self) {
        if !self.keep {
            self.engine.set_update_lock(false);
        }
    }
}

/// 安裝已經下載、驗過簽章的那一版：舉更新鎖 → 再看一次忙不忙 → 停引擎與子行程 → 安裝。要先 `update_download`。
///
/// 順序有講究：**先舉鎖、才看忙不忙**（引擎工作 / 短呼叫 / 引擎環境安裝）。鎖舉起之後引擎、ffmpeg、引擎安裝都開不起來
/// （`Engine::ensure_started`、`AppState::ensure_not_updating`），停引擎、等 Rust 端工作、收 ffmpeg 的十幾秒裡
/// UI 還能操作，也不會再冒出新的子行程。有工作就放下鎖、拒絕並講原因（已下載的安裝檔留著，等工作結束再裝）。
/// debug build 一律拒絕（見 `UpdaterStatus::dev_build`）。
#[tauri::command]
pub async fn update_install(app: AppHandle, state: State<'_, AppState>) -> AppResult<InstallOutcome> {
    if cfg!(debug_assertions) {
        return Err(AppError::Invalid("開發版（debug build）不能安裝更新：請用安裝檔版本測試（見 docs/updater.md）".into()));
    }
    let Some(_busy) = pyenv::try_acquire(&BUSY) else {
        return Err(AppError::Invalid("已經在下載或安裝更新".into()));
    };
    let (update, bytes) = match PENDING.lock().as_ref() {
        Some(Pending { update, bytes: Some(b) }) => (update.clone(), b.clone()),
        Some(_) => return Err(AppError::Invalid("更新檔還沒下載完成".into())),
        None => return Err(AppError::Invalid("請先檢查更新".into())),
    };
    let lock = UpdateLock::raise(&state.engine);
    if let Some(why) = busy_now(&state) {
        return Err(AppError::Invalid(why));
    }
    emit_progress(&app, "installing", bytes.len() as u64, Some(bytes.len() as u64));
    prepare_for_install(&app, &state).await;
    // install() 是同步的（macOS 可能跳出管理員密碼視窗）：不佔 async worker。
    // Windows 成功時行程就在 install() 裡 exit(0)，下面那幾行不會執行；外掛預設的 on_before_exit 會先把視窗藏起來。
    let r = tauri::async_runtime::spawn_blocking(move || update.install(bytes.as_slice())).await;
    match r {
        Ok(Ok(())) => {
            lock.keep();
            Ok(InstallOutcome { restart_required: !cfg!(windows) })
        }
        Ok(Err(e)) => {
            restore_main_window(&app);
            Err(AppError::Invalid(format!("安裝失敗：{}", friendly_error(&e))))
        }
        Err(e) => {
            restore_main_window(&app);
            Err(AppError::Invalid(format!("安裝失敗：{e}")))
        }
    }
}

async fn download(app: &AppHandle, update: &Update) -> AppResult<Vec<u8>> {
    // 兩個回呼都要讀寫同一份計數：用原子量（Cell 不是 Sync，會讓整個指令的 future 變成 !Send）
    let got = AtomicU64::new(0);
    let total = AtomicU64::new(u64::MAX);
    let mut gate = ProgressGate::default();
    emit_progress(app, "downloading", 0, None);
    let bytes = update
        .download(
            |n, len| {
                let now = got.fetch_add(n as u64, Ordering::Relaxed) + n as u64;
                if let Some(t) = len {
                    total.store(t, Ordering::Relaxed);
                }
                if gate.should_emit(now, len) {
                    emit_progress(app, "downloading", now, len);
                }
            },
            // 這時還沒驗簽（外掛在回呼之後才驗；requireSignedVersion 也在那時比對簽章裡的版本）：「下載完成」不等於可以安裝
            || {
                let t = total.load(Ordering::Relaxed);
                emit_progress(app, "verifying", got.load(Ordering::Relaxed), (t != u64::MAX).then_some(t));
            },
        )
        .await
        .map_err(updater_err)?;
    Ok(bytes)
}

/// 安裝程式接手之前：停引擎（禮貌 shutdown：引擎自己取消工作、殺 ffmpeg、刪 `.part`；上限見 `engine::STOP_BUDGET`）、
/// 舉起 Rust 端長工作的取消旗標並等它們收掉、Windows 再把內建 ffmpeg 目錄裡還活著的 ffmpeg / ffprobe 收掉
/// （引擎被硬殺時留下的孫行程會鎖住 `resources\ffmpeg\*`，NSIS 覆寫不了）。
async fn prepare_for_install(app: &AppHandle, state: &AppState) {
    state.engine.stop(Some(&engine::app_sink(app))).await;
    let flags: Vec<_> = state.cancel_flags.lock().values().cloned().collect();
    for f in &flags {
        f.store(true, Ordering::Relaxed);
    }
    let deadline = Instant::now() + RUST_JOBS_GRACE;
    while !state.cancel_flags.lock().is_empty() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    #[cfg(windows)]
    {
        let dir = state.bundled_ffmpeg.read().clone();
        if let Some(dir) = dir {
            win::kill_bundled_ffmpeg(&dir).await;
        }
    }
}

/// 安裝失敗時把主視窗叫回來：外掛預設的 on_before_exit（`cleanup_before_exit`）在 Windows 會先把視窗藏起來，
/// 安裝程式沒能啟動的話 App 還在跑，卻看不到。
fn restore_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 收掉內建 ffmpeg 目錄裡的 ffmpeg / ffprobe 的 PowerShell 片段。目錄由環境變數 `AIVC_FFMPEG_SWEEP_DIR` 帶進來，
/// 不拼進指令字串（路徑裡的引號、`$` 不會變成程式碼）；只動執行檔在那個目錄底下的行程，使用者自己的 ffmpeg 不碰。
pub const SWEEP_SCRIPT: &str = "$d = $env:AIVC_FFMPEG_SWEEP_DIR.TrimEnd('\\') + '\\'; \
Get-Process -Name ffmpeg,ffprobe -ErrorAction SilentlyContinue | \
Where-Object { $_.Path -and $_.Path.StartsWith($d, [System.StringComparison]::OrdinalIgnoreCase) } | \
Stop-Process -Force -ErrorAction SilentlyContinue";

#[cfg(windows)]
mod win {
    use std::path::Path;
    use std::process::Stdio;
    use std::time::Duration;

    const SWEEP_TIMEOUT: Duration = Duration::from_secs(8);

    pub async fn kill_bundled_ffmpeg(dir: &Path) {
        let mut c = crate::proc::cmd("powershell");
        c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", super::SWEEP_SCRIPT])
            .env("AIVC_FFMPEG_SWEEP_DIR", dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        match tokio::time::timeout(SWEEP_TIMEOUT, c.status()).await {
            Ok(Ok(_)) => {}
            Ok(Err(e)) => eprintln!("[updater] 收 ffmpeg 失敗：{e}"),
            Err(_) => eprintln!("[updater] 收 ffmpeg 超過 {} 秒，略過", SWEEP_TIMEOUT.as_secs()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;

    const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEFCQ0RFRgpSV1RFU1RLRVk=";
    const GH: &str = "https://github.com/markku636/ai-video-cut-pbulic/releases/latest/download/latest.json";

    fn cfg(pubkey: &str, endpoints: &[&str]) -> Value {
        json!({ "pubkey": pubkey, "endpoints": endpoints, "windows": { "installMode": "passive" } })
    }

    #[test]
    fn endpoint_policy_https_only_except_loopback_http() {
        for ok in [GH, "https://example.com/aivc/{{target}}/{{arch}}/{{current_version}}", "  https://cdn.example.org/latest.json  "] {
            assert!(validate_endpoint(ok).is_ok(), "{ok}");
        }
        for ok in ["http://localhost:8000/latest.json", "http://LOCALHOST/latest.json", "http://127.0.0.1:8080/latest.json", "http://127.0.0.2/x.json", "http://[::1]:9000/latest.json"] {
            assert!(validate_endpoint(ok).is_ok(), "本機測試伺服器要准：{ok}");
        }
        for (bad, why) in [
            ("http://example.com/latest.json", "https"),
            ("http://10.0.0.5/latest.json", "https"),
            ("http://localhost.example.com/latest.json", "https"),
            ("ftp://example.com/latest.json", "不支援"),
            ("file:///C:/latest.json", "不支援"),
            ("https://user:pw@example.com/latest.json", "帳號"),
            ("https://token@example.com/latest.json", "帳號"),
            ("not a url", "不是有效的網址"),
            ("", "空"),
            ("   ", "空"),
        ] {
            let e = validate_endpoint(bad).unwrap_err();
            assert!(e.contains(why), "{bad} → {e}");
        }
    }

    #[test]
    fn empty_pubkey_disables_the_updater_with_a_reason() {
        for c in [cfg("", &[GH]), cfg("   ", &[GH]), json!({ "endpoints": [GH] })] {
            let (st, eps) = resolve_status(Some(&c), "", "0.0.7", false);
            assert!(!st.enabled);
            assert_eq!(st.reason_code, Some("no_pubkey"));
            assert!(st.reason.as_deref().unwrap().contains("公鑰"));
            assert!(eps.is_empty(), "停用時不能給出可用的網址");
            assert_eq!(st.default_endpoint.as_deref(), Some(GH), "設定頁仍要顯示預設來源");
            assert_eq!(st.current_version, "0.0.7");
        }
        let (st, _) = resolve_status(None, "", "0.0.7", false);
        assert_eq!((st.enabled, st.reason_code), (false, Some("no_config")));
        let (st, _) = resolve_status(Some(&json!("oops")), "", "0.0.7", false);
        assert_eq!(st.reason_code, Some("no_config"));
    }

    #[test]
    fn status_uses_config_endpoints_or_a_valid_override() {
        let c = cfg(PUBKEY, &[GH]);
        let (st, eps) = resolve_status(Some(&c), "", "0.0.7", true);
        assert!(st.enabled && !st.overridden && st.dev_build);
        assert_eq!(st.endpoint.as_deref(), Some(GH));
        assert_eq!(eps.len(), 1);
        // 覆寫：只問覆寫的那一個
        let (st, eps) = resolve_status(Some(&c), " http://127.0.0.1:8000/latest.json ", "0.0.7", false);
        assert!(st.enabled && st.overridden);
        assert_eq!(eps.iter().map(Url::as_str).collect::<Vec<_>>(), ["http://127.0.0.1:8000/latest.json"]);
        assert_eq!(st.default_endpoint.as_deref(), Some(GH));
        // 覆寫不合規定 → 停用並講原因（不是靜靜退回預設來源：使用者以為在測本機伺服器，其實在問 GitHub）
        let (st, eps) = resolve_status(Some(&c), "http://evil.example/latest.json", "0.0.7", false);
        assert_eq!((st.enabled, st.reason_code), (false, Some("bad_endpoint")));
        assert!(eps.is_empty());
        assert!(st.reason.unwrap().contains("https"));
        // 設定檔本身的來源不合規定（dangerousInsecureTransportProtocol 開著，外掛不擋，這裡要擋）
        let (st, _) = resolve_status(Some(&cfg(PUBKEY, &["http://releases.example.com/latest.json"])), "", "0.0.7", false);
        assert_eq!(st.reason_code, Some("bad_config_endpoint"));
    }

    /// 私有建置靠清空 endpoints 停用自動更新：覆寫網址不能把它接回公開頻道。
    #[test]
    fn no_configured_endpoint_ignores_the_override() {
        for c in [cfg(PUBKEY, &[]), json!({ "pubkey": PUBKEY })] {
            let (st, eps) = resolve_status(Some(&c), GH, "0.0.7", false);
            assert_eq!((st.enabled, st.reason_code, st.overridden), (false, Some("no_endpoint"), false));
            assert!(eps.is_empty());
        }
    }

    /// 私有建置填了自己的來源之後（allowEndpointOverride: false）：覆寫網址（開源版留在共用 settings.json 的、
    /// 或使用者在設定頁填的）一律不看，照樣問私有來源。
    #[test]
    fn override_is_ignored_when_the_build_forbids_it() {
        const PRIVATE: &str = "https://updates.example.com/aivc-cards/latest.json";
        let mut c = cfg(PUBKEY, &[PRIVATE]);
        c[ALLOW_OVERRIDE_KEY] = json!(false);
        for over in [GH, "http://127.0.0.1:8000/latest.json", "http://evil.example/latest.json", ""] {
            let (st, eps) = resolve_status(Some(&c), over, "0.0.7", false);
            assert!(st.enabled && !st.overridden && !st.override_allowed, "{over}");
            assert_eq!(eps.iter().map(Url::as_str).collect::<Vec<_>>(), [PRIVATE], "{over}");
        }
        // 鍵不在、或不是 false → 照舊可以覆寫（公開版）
        for v in [json!(true), json!("false"), Value::Null] {
            let mut c = cfg(PUBKEY, &[GH]);
            c[ALLOW_OVERRIDE_KEY] = v;
            let (st, eps) = resolve_status(Some(&c), "http://127.0.0.1:8000/latest.json", "0.0.7", false);
            assert!(st.override_allowed && st.overridden);
            assert_eq!(eps[0].as_str(), "http://127.0.0.1:8000/latest.json");
        }
    }

    #[test]
    fn status_serializes_camel_case_for_the_frontend() {
        let (st, _) = resolve_status(Some(&cfg("", &[GH])), "", "0.0.7", false);
        let v = serde_json::to_value(&st).unwrap();
        for k in ["enabled", "reasonCode", "reason", "currentVersion", "endpoint", "defaultEndpoint", "overridden", "overrideAllowed", "devBuild"] {
            assert!(v.get(k).is_some(), "前端讀 {k}：{v}");
        }
        assert_eq!(v["reasonCode"], "no_pubkey");
        let info = UpdateInfo { version: "0.0.8".into(), current_version: "0.0.7".into(), notes: None, date: None };
        let v = serde_json::to_value(&info).unwrap();
        assert_eq!(v["currentVersion"], "0.0.7");
        assert!(v.get("notes").is_some() && v.get("date").is_some());
        let v = serde_json::to_value(InstallOutcome { restart_required: true }).unwrap();
        assert_eq!(v["restartRequired"], true);
        let v = serde_json::to_value(DownloadOutcome { canceled: true }).unwrap();
        assert_eq!(v, json!({ "canceled": true }));
        let v = serde_json::to_value(ProgressEvent { phase: "downloading", downloaded: 3, total: None }).unwrap();
        assert_eq!(v, json!({ "phase": "downloading", "downloaded": 3, "total": null }));
    }

    #[test]
    fn check_timeout_is_clamped() {
        assert_eq!(check_timeout(None), DEFAULT_CHECK_TIMEOUT);
        assert_eq!(check_timeout(Some(10)), MIN_CHECK_TIMEOUT);
        assert_eq!(check_timeout(Some(15_000)), Duration::from_secs(15));
        assert_eq!(check_timeout(Some(3_600_000)), MAX_CHECK_TIMEOUT);
    }

    #[test]
    fn progress_gate_throttles_but_always_reports_first_and_last() {
        let mut g = ProgressGate::default();
        let total = 60 * 1024 * 1024; // 60 MB：1% = 600 KB > 512 KiB
        let mut emitted = Vec::new();
        let mut got = 0u64;
        while got < total {
            got = (got + 16 * 1024).min(total);
            if g.should_emit(got, Some(total)) {
                emitted.push(got);
            }
        }
        assert_eq!(emitted.first(), Some(&(16 * 1024)), "第一塊就要讓進度條動起來");
        assert_eq!(emitted.last(), Some(&total), "100% 一定要發");
        assert!(emitted.len() <= 102 && emitted.len() >= 90, "大約每 1% 一次：{}", emitted.len());
        // 沒有 Content-Length：每 512 KiB 一次
        let mut g = ProgressGate::default();
        let n = (1..=64u64).map(|i| i * 64 * 1024).filter(|d| g.should_emit(*d, None)).count();
        assert_eq!(n, 1 + (64 * 64 * 1024 - 64 * 1024) as usize / PROGRESS_MIN_STEP as usize);
    }

    #[test]
    fn busy_reason_blocks_running_jobs_and_engine_install() {
        assert_eq!(busy_reason(0, 0, 0, false), None);
        assert!(busy_reason(1, 0, 0, false).unwrap().contains("1 個"));
        assert!(busy_reason(0, 2, 0, false).unwrap().contains("2 個"));
        assert!(busy_reason(0, 0, 0, true).unwrap().contains("引擎環境正在安裝"));
        // 短呼叫（AI 助手的對話）也算：停引擎會把它悄悄取消
        let why = busy_reason(0, 0, 1, false).unwrap();
        assert!(why.contains("1 個引擎請求") && why.contains("AI 助手"), "{why}");
    }

    /// 取消下載：旗標舉起就丟掉下載的 future（關連線），不等它跑完；沒取消就照常拿到結果。
    #[tokio::test]
    async fn until_canceled_drops_the_download_when_the_flag_is_raised() {
        let flag = AtomicBool::new(false);
        assert_eq!(until_canceled(async { 7 }, &flag).await, Some(7));
        let started = Instant::now();
        let raise = async {
            tokio::time::sleep(Duration::from_millis(150)).await;
            flag.store(true, Ordering::SeqCst);
        };
        let (got, ()) = tokio::join!(until_canceled(std::future::pending::<u8>(), &flag), raise);
        assert_eq!(got, None);
        assert!(started.elapsed() < Duration::from_secs(5), "取消後很快就回：{:?}", started.elapsed());
    }

    /// 沒有在下載時按取消：不舉旗標（不然下一次下載一開始就被取消）。
    #[test]
    fn cancel_without_a_download_is_a_no_op() {
        assert!(!update_cancel());
        assert!(!CANCEL_DOWNLOAD.load(Ordering::SeqCst));
    }

    #[test]
    fn friendly_errors_explain_what_happened() {
        use tauri_plugin_updater::Error as E;
        assert!(friendly_error(&E::ReleaseNotFound).contains("latest.json"));
        let t = friendly_error(&E::TargetsNotFound(vec!["windows-x86_64-nsis".into(), "windows-x86_64".into()]));
        assert!(t.contains("windows-x86_64-nsis") && t.contains("平台"), "{t}");
        assert!(friendly_error(&E::EmptyEndpoints).contains("更新來源"));
        assert!(friendly_error(&E::InsecureTransportProtocol).contains("https"));
        assert!(friendly_error(&E::Network("Download request failed with status: 404".into())).contains("404"));
        assert!(friendly_error(&E::MissingSignedVersion).contains("簽章"));
    }

    /// 舊版設定檔沒有 `updater` → 預設值（自動檢查開）；只有一部分欄位 → 其餘補預設；來回存讀不掉值。
    #[tokio::test]
    async fn settings_get_defaults_for_existing_users() {
        let dir = std::env::temp_dir().join(format!("aivc updater 設定-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = crate::store::SETTINGS_FILE;
        std::fs::write(dir.join(file), r#"{"lang":"en","engine":{"sam_variant":"large"}}"#).unwrap();
        let s: crate::store::AppSettings = crate::store::read_json_in(&dir, file).await.unwrap();
        assert_eq!(s.updater, UpdaterSettings::default());
        assert!(s.updater.auto_check_updates, "預設要自動檢查");
        assert_eq!((s.updater.update_endpoint.as_str(), s.updater.skipped_update_version.as_str(), s.updater.last_update_check), ("", "", 0));

        std::fs::write(dir.join(file), r#"{"updater":{"auto_check_updates":false}}"#).unwrap();
        let s: crate::store::AppSettings = crate::store::read_json_in(&dir, file).await.unwrap();
        assert!(!s.updater.auto_check_updates, "使用者關掉的要留著");
        assert_eq!(s.updater.last_update_check, 0);

        let mut s2 = s.clone();
        s2.updater = UpdaterSettings { auto_check_updates: true, update_endpoint: "http://127.0.0.1:8000/latest.json".into(), skipped_update_version: "0.0.9".into(), last_update_check: 1_790_000_000_000 };
        crate::store::write_json_in(&dir, file, &s2).await.unwrap();
        let back: crate::store::AppSettings = crate::store::read_json_in(&dir, file).await.unwrap();
        assert_eq!(back.updater, s2.updater);
        let raw = std::fs::read_to_string(dir.join(file)).unwrap();
        assert!(raw.contains("\"updater\"") && raw.contains("\"last_update_check\""), "磁碟格式是 snake_case：{raw}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sweep_script_only_targets_the_bundled_ffmpeg_dir() {
        assert!(SWEEP_SCRIPT.contains("Get-Process -Name ffmpeg,ffprobe"));
        assert!(SWEEP_SCRIPT.contains("$env:AIVC_FFMPEG_SWEEP_DIR"), "目錄從環境變數進來，不拼進指令");
        assert!(SWEEP_SCRIPT.contains("StartsWith($d"), "只收執行檔在內建目錄底下的");
        assert!(!SWEEP_SCRIPT.contains('\n') && !SWEEP_SCRIPT.contains('\r'), "一個 -Command 參數");
    }

    // ---------------- 設定檔契約（tauri.conf.json 與兩份 overlay） ----------------

    fn read_json(p: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(p).unwrap_or_else(|e| panic!("{}：{e}", p.display()))).unwrap_or_else(|e| panic!("{} 不是 JSON：{e}", p.display()))
    }

    /// RFC 7396 JSON Merge Patch：`tauri build --config <overlay>` 疊設定檔的規則（陣列整個換掉、null 刪鍵）。
    fn merge_patch(target: &mut Value, patch: &Value) {
        match (target.as_object_mut(), patch.as_object()) {
            (Some(t), Some(p)) => {
                for (k, v) in p {
                    if v.is_null() {
                        t.remove(k);
                    } else {
                        merge_patch(t.entry(k.clone()).or_insert(Value::Null), v);
                    }
                }
            }
            _ => *target = patch.clone(),
        }
    }

    #[test]
    fn base_config_keeps_the_updater_resilient_and_unsigned_builds_working() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let conf = read_json(&root.join("tauri.conf.json"));
        let up = &conf["plugins"]["updater"];
        // 少了 plugins.updater 或 pubkey 鍵，外掛初始化失敗 → lib.rs 的 .expect() 讓 App 一開就 panic（Windows 上就是「點了沒反應」）
        assert!(up.is_object(), "tauri.conf.json 要有 plugins.updater");
        assert!(up["pubkey"].is_string(), "pubkey 鍵一定要在（空字串＝停用，見 resolve_status）");
        assert_eq!(up["windows"]["installMode"], "passive");
        let eps: Vec<&str> = up["endpoints"].as_array().expect("endpoints").iter().filter_map(Value::as_str).collect();
        assert!(!eps.is_empty(), "公開版要有預設的更新來源");
        for e in &eps {
            let u = validate_endpoint(e).unwrap_or_else(|why| panic!("{e}：{why}"));
            assert_eq!(u.scheme(), "https", "設定檔的來源一定是 https（http 只給本機測試的覆寫用）");
        }
        // http 本機測試要靠它；真正的規則在 check_url_policy
        assert_eq!(up["dangerousInsecureTransportProtocol"], true);
        // latest.json 沒有簽章：不綁版本的話，拿得到它的人可以把「99.0.0」配上舊版的安裝檔與 .sig，把使用者降級
        assert_eq!(up["requireSignedVersion"], true, "簽章要綁版本（tauri-cli 2.12 起 trusted comment 帶 version:）");
        // 外掛真的吃得下這份設定（多出來的 allowEndpointOverride 之類的鍵不能讓它初始化失敗 → App 一開就 panic）
        let parsed: tauri_plugin_updater::Config = serde_json::from_value(up.clone()).expect("外掛解析 plugins.updater");
        assert!(parsed.require_signed_version);
        // 沒有私鑰的人（開源貢獻者、CI 的 PR）也要 build 得起來：createUpdaterArtifacts 只放在 release overlay
        assert!(conf["bundle"].get("createUpdaterArtifacts").is_none(), "createUpdaterArtifacts 不能放在基本設定檔");
        let overlay = read_json(&root.join("tauri.updater.conf.json"));
        assert_eq!(overlay["bundle"]["createUpdaterArtifacts"], true);
        let mut merged = conf.clone();
        merge_patch(&mut merged, &overlay);
        assert_eq!(merged["plugins"]["updater"], conf["plugins"]["updater"], "updater overlay 只開簽章產物，不動來源");
    }

    /// requireSignedVersion 要靠簽章裡有版本：tauri-cli 2.11 簽出來的沒有，開了每一版都裝不起來。CLI 不能退回 2.12 以前。
    #[test]
    fn tauri_cli_records_the_version_in_signatures() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let minor_ok = |v: &str| {
            let nums: Vec<u64> = v.trim_start_matches(['^', '~', '=']).split(['.', '-']).take(2).map(|p| p.parse().unwrap_or(0)).collect();
            nums.len() == 2 && (nums[0] > 2 || (nums[0] == 2 && nums[1] >= 12))
        };
        let pkg = read_json(&repo.join("package.json"));
        let want = pkg["devDependencies"]["@tauri-apps/cli"].as_str().expect("devDependencies.@tauri-apps/cli");
        assert!(minor_ok(want), "package.json 的 @tauri-apps/cli 要 >= 2.12：{want}");
        let lock = read_json(&repo.join("package-lock.json"));
        let got = lock["packages"]["node_modules/@tauri-apps/cli"]["version"].as_str().expect("package-lock 的 @tauri-apps/cli");
        assert!(minor_ok(got), "package-lock.json 鎖的 @tauri-apps/cli 要 >= 2.12：{got}");
    }

    /// 私有建置（含 cards 外掛）疊上自己的 overlay 之後：自動更新停用，覆寫網址也接不回公開頻道。
    #[test]
    fn private_cards_build_never_updates_from_the_public_channel() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let overlay = root.join("..").join("plugins").join("cards").join("tauri.conf.overlay.json");
        // 開源版沒有 plugins/cards：沒有私有建置可驗
        if !overlay.is_file() {
            return;
        }
        let mut merged = read_json(&root.join("tauri.conf.json"));
        merge_patch(&mut merged, &read_json(&root.join("tauri.updater.conf.json")));
        merge_patch(&mut merged, &read_json(&overlay));
        let up = &merged["plugins"]["updater"];
        let public: Vec<Value> = read_json(&root.join("tauri.conf.json"))["plugins"]["updater"]["endpoints"].as_array().cloned().unwrap_or_default();
        for e in up["endpoints"].as_array().cloned().unwrap_or_default() {
            assert!(!public.contains(&e), "私有建置不能問公開頻道：{e}");
        }
        // 私有建置不接受覆寫網址：它跟開源版共用 identifier（也就共用 settings.json）
        assert_eq!(up[ALLOW_OVERRIDE_KEY], false, "cards overlay 要設 {ALLOW_OVERRIDE_KEY}: false");
        // 有私有來源的話一定要有自己的公鑰：同一把金鑰的話，開源版的安裝檔在私有建置也驗得過（反過來也是）
        let base_key = read_json(&root.join("tauri.conf.json"))["plugins"]["updater"]["pubkey"].clone();
        if up["endpoints"].as_array().is_some_and(|a| !a.is_empty()) {
            let k = up["pubkey"].as_str().unwrap_or("").trim();
            assert!(!k.is_empty() && json!(k) != base_key, "私有建置填了來源就要用另一把金鑰（cards overlay 設自己的 plugins.updater.pubkey）");
        }
        let _: tauri_plugin_updater::Config = serde_json::from_value(up.clone()).expect("外掛解析私有建置的 plugins.updater");
        // 用一把假的公鑰模擬「之後填了真的公鑰」：私有建置照樣停用（不是只靠公鑰還空著）
        let mut with_key = up.clone();
        with_key["pubkey"] = json!(PUBKEY);
        // 再模擬 docs/updater.md 教的「私有建置填了自己的來源」：覆寫網址指到公開頻道也接不過去
        let mut with_private = with_key.clone();
        with_private["endpoints"] = json!(["https://updates.example.com/aivc-cards/latest.json"]);
        for c in [&with_key, &with_private] {
            for over in ["", GH] {
                let (st, eps) = resolve_status(Some(c), over, "0.0.7", false);
                if st.enabled {
                    assert!(!st.overridden, "私有建置不吃覆寫：{over}");
                    assert!(eps.iter().all(|u| !public.contains(&json!(u.as_str()))), "私有頻道不能指到公開來源：{eps:?}");
                } else {
                    assert_eq!(st.reason_code, Some("no_endpoint"));
                }
            }
        }
    }

    #[test]
    fn capabilities_allow_restart_but_not_the_js_updater() {
        let caps = read_json(&Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities").join("default.json"));
        let perms: Vec<&str> = caps["permissions"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert!(perms.contains(&"process:allow-restart"), "macOS / Linux 裝完要 relaunch()");
        assert!(!perms.contains(&"process:allow-exit") && !perms.contains(&"process:default"), "只要 restart");
        assert!(!perms.iter().any(|p| p.starts_with("updater:")), "JS 直接 install 會跳過停引擎（見模組說明）：{perms:?}");
    }
}
