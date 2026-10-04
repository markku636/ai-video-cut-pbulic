//! 常駐 Python sidecar（`aivc serve`）監督（計畫 §7.2、協定 §5.8）。
//!
//! 一行一 JSON（UTF-8）。請求 `{"id","op","args"}` → 同一 `id` 的 `progress|log|artifact` 事件 →
//! **恰一次** `{"id","ok":true,"result"}` 或 `{"id","ok":false,"error":{kind,message,hint}}`。
//! 前端的 jobId 就是 wire id；控制 op（`hello/ping/cancel/shutdown`）由引擎的讀取執行緒即時處理。
//!
//! 藍本是 ai-music-cut `local_asr.rs` 踩過的坑：
//! - stdout 讀取迴圈必為 `loop { match next_line() { Ok(Some)=>…, Ok(None)=>break, Err(_)=>continue } }`：
//!   一行不是合法 UTF-8 就 `while let` 結束，之後沒人讀、管線塞滿（Windows 64 KB）、python 卡死。
//! - stderr **一定要排空**（同一個理由），留最後 8 行 + 最後一行像例外的（`SomeError: …`）當死因。
//! - 大 payload 走檔案路徑，不走管線（行長 < 64 KB）。
//!
//! 併發（決策 8）：引擎單一 worker 執行緒 + 這裡 `Semaphore(1)`；`start_job` **先取 permit 再送請求**，
//! 所以排隊中的工作在前端看得到 `queued`，而不是在引擎裡排隊。
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStderr, ChildStdout};
use tokio::sync::{oneshot, Semaphore};

use crate::error::{AppError, AppResult};
use crate::proc;

/// 事件出口。正式版是 `AppHandle`（`app.emit`）；測試用一個把事件收進 Vec 的假 sink。
///
/// 為什麼要多這一層：`AppHandle` 在單元測試裡造不出來（要整個 Tauri runtime + WebView），
/// 但計畫 §10 A1 要求用**假 python 腳本**測完整監督流程（回覆路由、timeout、退出→pending 失敗、取消）。
/// 抽成 trait 之後 `Engine` 對 Tauri 的唯一依賴就是這個 `emit`。
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, name: &str, payload: Value);
}

impl EventSink for AppHandle {
    fn emit(&self, name: &str, payload: Value) {
        let _ = Emitter::emit(self, name, payload);
    }
}

pub type Sink = Arc<dyn EventSink>;

/// commands 層用：把 `AppHandle` 包成 `Sink`（clone 很便宜，AppHandle 內部是 Arc）。
pub fn app_sink(app: &AppHandle) -> Sink {
    Arc::new(app.clone())
}

/// 首次 import torch + transformers 冷機 10–40 秒。
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(120);
pub const PING_INTERVAL: Duration = Duration::from_secs(15);
pub const PING_TIMEOUT: Duration = Duration::from_secs(10);
pub const PING_MAX_MISSES: u32 = 2;
/// 10 分鐘內最多 3 次重啟（＝ 4 次啟動）；超過就 Broken，等使用者按「重新啟動引擎」。
pub const RESTART_WINDOW: Duration = Duration::from_secs(600);
pub const MAX_RESTARTS: usize = 3;
pub const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(60);
pub const CANCEL_TIMEOUT: Duration = Duration::from_secs(5);
/// 送出 `shutdown` 到收到 ack 的上限。引擎是在讀取執行緒上直接回覆（先設取消旗標、回 ack，才開始收尾），
/// 所以正常是毫秒級；這個值只是「sidecar 完全沒反應」的認賠點。1.5 s 而不是 2 s：`STOP_BUDGET` 卡在 App 的
/// 5 秒退出預算之下，等 ack 多留一秒就等於少給引擎一秒收尾（B-09 預算倒置，見 `budgets_are_ordered`）。
pub const SHUTDOWN_GRACE: Duration = Duration::from_millis(1500);
/// 引擎回了 shutdown 之後，等它自己退出的上限（取消工作、kill ffmpeg、刪掉 `.part`、回 Canceled；實測 0.05–0.12 s）。
/// 以前一收到回覆就硬殺：使用者輸出資料夾留下 `<out>.part`、工作顯示「引擎錯誤：引擎已停止」（B-09）。
///
/// 這個值要蓋得住引擎那邊最壞情況的收尾（B-09 預算倒置）：`FfmpegProcess.kill()` 等子行程 1.2 s ＋
/// drain 0.4 s ＋ `atomic_output` 刪 `.part` 0.1 s ≈ 1.7 s，再加上 worker 回到 except 的時間。
/// 比它小的話 ffmpeg 還沒死我們就硬殺 sidecar，`.part` 留在使用者的輸出資料夾（而且現在是唯一檔名，會累積）。
pub const SHUTDOWN_EXIT_WAIT: Duration = Duration::from_secs(3);
/// `stop()` 整體上限：lib.rs 的 App 退出預算是 5 秒，硬殺要在那之前送出。
///
/// 必須 ≥ `SHUTDOWN_GRACE + SHUTDOWN_EXIT_WAIT`（`stop()` 用 `STOP_BUDGET − elapsed` 夾住等待，
/// elapsed 已經含了等 ack 的時間）；小於的話「ack 來得慢」會直接吃掉引擎收尾的時間 —— 舊值 4500 ms
/// 在 ack 花滿 2 s 時只留 2.5 s。`budgets_are_ordered` 測試把這個關係釘住。
pub const STOP_BUDGET: Duration = Duration::from_millis(4900);
/// 行程退出後最多等這麼久讓 stderr 讀到 EOF（死因要含最後一行例外）。
pub const STDERR_EOF_GRACE: Duration = Duration::from_millis(500);
/// 我們認得的協定版本；`hello.result.protocol` 不同就拒絕（引擎 wheel 與 App 版本脫鉤時的保險）。
pub const PROTOCOL_VERSION: u64 = 1;
pub const STDERR_TAIL_LINES: usize = 8;

pub const EV_STATE: &str = "engine-state";
pub const EV_PROGRESS: &str = "engine-progress";
pub const EV_LOG: &str = "engine-log";
pub const EV_ARTIFACT: &str = "engine-artifact";
pub const EV_JOB_DONE: &str = "engine-job-done";

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EngineState {
    Down,
    Starting,
    Ready,
    Broken,
}

/// `engine_state` 指令與 `engine-state` 事件的 payload。
#[derive(Serialize, Clone, Debug)]
pub struct EngineInfo {
    pub state: EngineState,
    pub pid: Option<u32>,
    /// `hello` 的 result（version / protocol / python / torch / cuda / device）。
    pub hello: Option<Value>,
    /// stderr 裡最後一行像例外的（死因）。
    pub last_exc: Option<String>,
    /// 10 分鐘視窗內的重啟次數。
    pub restarts: usize,
    /// 等 GPU permit 的 job id（前端顯示 queued）。
    pub queued: Vec<String>,
    /// 已送進引擎、還沒回覆的 job id。
    pub running: Vec<String>,
}

/// 引擎回的錯誤（wire 形狀，鏡射 Python `OpError.to_wire()`）。
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct WireError {
    pub kind: String,
    pub message: String,
    #[serde(default)]
    pub hint: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Reply {
    pub ok: bool,
    pub result: Value,
    pub error: Option<WireError>,
}

/// 一行 stdout 分類後的結果。
#[derive(Debug, PartialEq)]
pub enum Routed {
    /// `{"id", "ok", "result"|"error"}`
    Reply { id: String, reply: Reply },
    /// `{"id", "event": "progress"|"log"|"artifact", ...}`
    Event { id: String, event: String, payload: Value },
    /// 不是協定行（引擎 print 了別的東西）：忽略，但不能讓迴圈停。
    Ignored,
}

/// 純函式：一行 → Routed。抽出來才測得到（真的引擎要 GPU）。
pub fn route_line(line: &str) -> Routed {
    let line = line.trim();
    if !line.starts_with('{') {
        return Routed::Ignored;
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else { return Routed::Ignored };
    let Some(id) = v.get("id").and_then(Value::as_str).map(str::to_string) else { return Routed::Ignored };
    if let Some(ev) = v.get("event").and_then(Value::as_str) {
        return Routed::Event { id, event: ev.to_string(), payload: v };
    }
    let Some(ok) = v.get("ok").and_then(Value::as_bool) else { return Routed::Ignored };
    let error = if ok {
        None
    } else {
        Some(match v.get("error") {
            Some(e) => serde_json::from_value::<WireError>(e.clone()).unwrap_or_else(|_| WireError {
                kind: "Internal".into(),
                message: e.to_string(),
                hint: String::new(),
            }),
            None => WireError { kind: "Internal".into(), message: "引擎回 ok:false 但沒有 error".into(), hint: String::new() },
        })
    };
    Routed::Reply { id, reply: Reply { ok, result: v.get("result").cloned().unwrap_or(Value::Null), error } }
}

/// 請求的框架：單行 JSON + `\n`。serde_json 不會在字串外輸出裸換行，字串內的換行是 `\n` 兩個字元。
pub fn request_line(id: &str, op: &str, args: &Value) -> String {
    let mut s = serde_json::to_string(&json!({ "id": id, "op": op, "args": args })).unwrap_or_default();
    s.push('\n');
    s
}

/// 引擎事件名 → Tauri 事件名。認不得的事件丟掉（不是 panic：引擎升版可能加新事件）。
pub fn event_name(event: &str) -> Option<&'static str> {
    match event {
        "progress" => Some(EV_PROGRESS),
        "log" => Some(EV_LOG),
        "artifact" => Some(EV_ARTIFACT),
        _ => None,
    }
}

/// 事件 payload：把 wire 的 `id` 換成 `job_id`、拿掉 `event`；progress 順便算 `pct`（前端畫進度條不必每處自己除）。
pub fn event_payload(id: &str, event: &str, mut payload: Value) -> Value {
    if let Some(o) = payload.as_object_mut() {
        o.remove("id");
        o.remove("event");
        o.insert("job_id".into(), Value::String(id.to_string()));
        if event == "progress" && !o.contains_key("pct") {
            let done = o.get("done").and_then(Value::as_f64);
            let total = o.get("total").and_then(Value::as_f64).filter(|t| *t > 0.0);
            if let (Some(d), Some(t)) = (done, total) {
                o.insert("pct".into(), json!(((d / t) * 100.0).clamp(0.0, 100.0)));
            }
        }
    }
    payload
}

/// wire 的 `error.kind`（PascalCase，鏡射 Python）→ `AppError`。
pub fn wire_error_to_app(e: &WireError) -> AppError {
    let msg = if e.hint.trim().is_empty() { e.message.clone() } else { format!("{}（{}）", e.message, e.hint.trim()) };
    match e.kind.as_str() {
        "Invalid" => AppError::Invalid(msg),
        "Io" => AppError::Io(msg),
        "Ffmpeg" => AppError::Ffmpeg(msg),
        "Canceled" => AppError::Canceled,
        // Timeout(0) 的 message() 是「逾時（0 ms）」，會把 Python 的死因（「ffprobe 超過 60s 沒回應」）整個吃掉（B-11）
        "Timeout" => AppError::TimeoutMsg(msg),
        "Gpu" => AppError::Gpu(msg),
        "PyEnv" => AppError::PyEnv(msg),
        "Model" => AppError::Engine(format!("模型：{msg}")),
        // AI 助手（對外 LLM 端點）的失敗不是檔案讀寫，也不是引擎壞掉 —— 標成「檔案讀寫錯誤」會讓人去查磁碟
        "Agent" => AppError::Agent(msg),
        _ => AppError::Engine(msg),
    }
}

/// `AppError` → wire kind（反方向；`engine-job-done` 一律給前端 `{kind,message,hint}` 形狀）。
pub fn app_error_to_wire(e: &AppError) -> WireError {
    let kind = match e {
        AppError::Invalid(_) => "Invalid",
        AppError::Io(_) | AppError::NotFound(_) | AppError::Storage(_) => "Io",
        AppError::Ffmpeg(_) => "Ffmpeg",
        AppError::Canceled => "Canceled",
        AppError::Timeout(_) | AppError::TimeoutMsg(_) => "Timeout",
        AppError::Gpu(_) => "Gpu",
        AppError::PyEnv(_) => "PyEnv",
        AppError::Engine(_) => "Engine",
        AppError::Agent(_) => "Internal",
    };
    WireError { kind: kind.into(), message: e.message(), hint: String::new() }
}

/// `engine-job-done` 的 payload：`{job_id, ok, result}` 或 `{job_id, ok:false, error:{kind,message,hint}}`。
pub fn job_done_payload(job_id: &str, r: &Result<Reply, AppError>) -> Value {
    match r {
        Ok(Reply { ok: true, result, .. }) => json!({ "job_id": job_id, "ok": true, "result": result }),
        Ok(Reply { ok: false, error, .. }) => {
            json!({ "job_id": job_id, "ok": false, "error": error.clone().unwrap_or_default() })
        }
        Err(e) => json!({ "job_id": job_id, "ok": false, "error": app_error_to_wire(e) }),
    }
}

/// 重啟預算：視窗內的啟動次數 < 1 + MAX_RESTARTS 才准再啟動。`times` 是啟動時刻（呼叫端先 prune）。
pub fn budget_ok(times: &VecDeque<Instant>, now: Instant) -> bool {
    times.iter().filter(|t| now.duration_since(**t) <= RESTART_WINDOW).count() < 1 + MAX_RESTARTS
}

/// `hello` 的 result 合不合我們：協定版本必須相同；引擎版本（`_version.py`，由 sync-version.mjs 與
/// package.json 同步）必須等於 App 版本 —— 不同就代表 venv 裡裝的還是舊 wheel（App 升版但引擎沒重裝），
/// 這時 op 的參數形狀可能已經對不上，寧可拒絕啟動、叫使用者重新安裝引擎（計畫 §5.8）。
/// 缺 `protocol` 視為 1、缺 `version` 不比對（E1 早期的引擎可能還沒回）。
pub fn hello_compatible(result: &Value, app_version: &str) -> Result<(), String> {
    let p = result.get("protocol").and_then(Value::as_u64).unwrap_or(PROTOCOL_VERSION);
    if p != PROTOCOL_VERSION {
        return Err(format!("引擎協定版本 {p}，App 要 {PROTOCOL_VERSION}（請更新引擎或 App）"));
    }
    if let Some(v) = result.get("version").and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()) {
        if v != app_version.trim() {
            return Err(format!("引擎版本 {v} 與 App 版本 {app_version} 不同，請到「設定 → 引擎」重新安裝引擎"));
        }
    }
    Ok(())
}

/// 啟動引擎需要的東西（由 commands 從設定 / ffmpeg / 路徑算出來）。
#[derive(Clone, Debug)]
pub struct StartConfig {
    pub python: PathBuf,
    pub cache_dir: PathBuf,
    pub ffmpeg_dir: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    /// stderr 附掛到這個檔（`logs/engine.log`）。
    pub log_path: Option<PathBuf>,
}

/// `python -X utf8 -m aivc serve --cache-dir … [--ffmpeg-dir …]`
pub fn serve_args(cfg: &StartConfig) -> Vec<String> {
    let mut v: Vec<String> = ["-X", "utf8", "-m", "aivc", "serve", "--cache-dir"].iter().map(|s| s.to_string()).collect();
    v.push(cfg.cache_dir.to_string_lossy().into_owned());
    if let Some(ff) = &cfg.ffmpeg_dir {
        v.push("--ffmpeg-dir".into());
        v.push(ff.to_string_lossy().into_owned());
    }
    v
}

struct Live {
    stdin: tokio::sync::Mutex<ChildStdin>,
    pid: Option<u32>,
    kill_tx: Option<oneshot::Sender<()>>,
    gen: u64,
    #[allow(dead_code)]
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
}

struct JobEntry {
    #[allow(dead_code)]
    op: String,
    /// 拿到 GPU permit（含正在等引擎啟動 / 重啟的 hello）。
    running: bool,
    /// 請求行已完整寫進引擎 stdin：之後的取消才能走 wire `cancel{id}`（引擎先讀到請求、才認得這個 id）。
    sent: bool,
    /// running 但還沒 sent 時按下的取消：送出前檢查、寫完後再檢查一次（見 `run_job_request`）。
    cancel_requested: bool,
}

type PendingTx = oneshot::Sender<Result<Reply, AppError>>;

pub struct Engine {
    live: tokio::sync::Mutex<Option<Live>>,
    start_lock: tokio::sync::Mutex<()>,
    pending: Mutex<HashMap<String, PendingTx>>,
    jobs: Mutex<HashMap<String, JobEntry>>,
    pub gpu: Arc<Semaphore>,
    starts: Mutex<VecDeque<Instant>>,
    last_exc: Mutex<Option<String>>,
    stderr_tail: Mutex<VecDeque<String>>,
    state: Mutex<EngineState>,
    hello: Mutex<Option<Value>>,
    cfg: Mutex<Option<StartConfig>>,
    generation: AtomicU64,
    /// 使用者主動停止：waiter 不要把它報成「引擎死了」。
    stopping: AtomicBool,
    /// App 更新正要安裝（updater.rs 舉起）：不再啟動引擎、也不接新的呼叫 / 工作，安裝失敗時放下。
    update_lock: AtomicBool,
}

/// 更新安裝途中被擋下的呼叫 / 工作 / ffmpeg 收到的訊息。
pub const UPDATE_LOCKED_MSG: &str = "正在安裝 App 更新：引擎與 ffmpeg 已停用，App 會關閉、裝好後自動重新開啟";

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

impl Engine {
    pub fn new() -> Self {
        Self {
            live: tokio::sync::Mutex::new(None),
            start_lock: tokio::sync::Mutex::new(()),
            pending: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
            gpu: Arc::new(Semaphore::new(1)),
            starts: Mutex::new(VecDeque::new()),
            last_exc: Mutex::new(None),
            stderr_tail: Mutex::new(VecDeque::new()),
            state: Mutex::new(EngineState::Down),
            hello: Mutex::new(None),
            cfg: Mutex::new(None),
            generation: AtomicU64::new(0),
            stopping: AtomicBool::new(false),
            update_lock: AtomicBool::new(false),
        }
    }

    /// App 更新安裝前舉起（`updater::update_install`）：之後 `ensure_started` 一律回錯 —— 連已經 Ready 的引擎也不再接新的
    /// 呼叫，pinger 失敗也不會把它重新叫起來。舉起之後停引擎，NSIS 覆寫安裝目錄時才不會又冒出新的 python / ffmpeg。
    pub fn set_update_lock(&self, on: bool) {
        self.update_lock.store(on, Ordering::SeqCst);
    }

    pub fn update_locked(&self) -> bool {
        self.update_lock.load(Ordering::SeqCst)
    }

    /// 還在等回覆的短呼叫（`call`：id 以 `c-` 開頭；不含 hello / ping / 長工作）。例如 AI 助手的對話最多等 3 分鐘，
    /// 安裝更新會停引擎、把它以「已取消」結束 —— 守門要把它算進去，不能悄悄砍掉。
    pub fn pending_calls(&self) -> usize {
        self.pending.lock().keys().filter(|k| k.starts_with("c-")).count()
    }

    pub fn state(&self) -> EngineState {
        *self.state.lock()
    }

    pub fn info(&self) -> EngineInfo {
        let (queued, running): (Vec<String>, Vec<String>) = {
            let jobs = self.jobs.lock();
            let mut q: Vec<String> = jobs.iter().filter(|(_, j)| !j.running).map(|(k, _)| k.clone()).collect();
            let mut r: Vec<String> = jobs.iter().filter(|(_, j)| j.running).map(|(k, _)| k.clone()).collect();
            q.sort();
            r.sort();
            (q, r)
        };
        let now = Instant::now();
        let starts = self.starts.lock().iter().filter(|t| now.duration_since(**t) <= RESTART_WINDOW).count();
        EngineInfo {
            state: self.state(),
            pid: self.live.try_lock().ok().and_then(|l| l.as_ref().and_then(|x| x.pid)),
            hello: self.hello.lock().clone(),
            last_exc: self.last_exc.lock().clone(),
            restarts: starts.saturating_sub(1),
            queued,
            running,
        }
    }

    fn set_state(&self, sink: &Sink, st: EngineState) {
        *self.state.lock() = st;
        self.emit_state(sink);
    }

    pub fn emit_state(&self, sink: &Sink) {
        sink.emit(EV_STATE, serde_json::to_value(self.info()).unwrap_or(Value::Null));
    }

    fn idle(&self) -> bool {
        self.pending.lock().is_empty() && self.jobs.lock().is_empty()
    }

    fn fail_all_pending(&self, why: &str) {
        self.fail_all_pending_with(|| AppError::Engine(why.to_string()));
    }

    /// 使用者主動停止：還在等回覆的呼叫／工作是「被取消」，不是「引擎壞了」。
    fn fail_all_pending_with(&self, err: impl Fn() -> AppError) {
        let drained: Vec<PendingTx> = self.pending.lock().drain().map(|(_, tx)| tx).collect();
        for tx in drained {
            let _ = tx.send(Err(err()));
        }
    }

    fn death_message(&self, code: Option<i32>) -> String {
        let code = code.map(|c| c.to_string()).unwrap_or_else(|| "?".into());
        let exc = self.last_exc.lock().clone();
        let tail = self.stderr_tail.lock().iter().cloned().collect::<Vec<_>>().join(" / ");
        match exc {
            Some(e) => format!("engine exited {code}: {e}"),
            None if !tail.trim().is_empty() => format!("engine exited {code}: {tail}"),
            None => format!("engine exited {code}"),
        }
    }

    // ---------------- 啟動 ----------------

    /// 使用者主動「啟動 / 重新啟動」：清掉 Broken 與預算再啟動。
    pub async fn start(self: &Arc<Self>, sink: &Sink, cfg: &StartConfig) -> AppResult<()> {
        if self.state() == EngineState::Broken {
            *self.state.lock() = EngineState::Down;
            self.starts.lock().clear();
        }
        self.ensure_started(sink, cfg).await
    }

    /// 沒在跑就啟動（含 hello 握手）；已 Ready 直接回。
    ///
    /// 回 boxed future：`ensure_started` 會 spawn `pinger`，`pinger` 失敗時又呼叫 `ensure_started`，
    /// 兩個 async fn 互相包含會讓編譯器推不出 `Send`；把這一層裝成 `dyn Future + Send` 就切斷循環。
    pub fn ensure_started<'a>(
        self: &'a Arc<Self>,
        sink: &'a Sink,
        cfg: &'a StartConfig,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = AppResult<()>> + Send + 'a>> {
        Box::pin(self.ensure_started_impl(sink, cfg))
    }

    async fn ensure_started_impl(self: &Arc<Self>, sink: &Sink, cfg: &StartConfig) -> AppResult<()> {
        // 放在 Ready 的捷徑之前：更新安裝途中連已經在跑的引擎也不接新的呼叫（它馬上就要被停掉）
        if self.update_locked() {
            return Err(AppError::Invalid(UPDATE_LOCKED_MSG.into()));
        }
        if self.state() == EngineState::Ready && self.live.lock().await.is_some() {
            return Ok(());
        }
        let _g = self.start_lock.lock().await;
        if self.state() == EngineState::Ready && self.live.lock().await.is_some() {
            return Ok(());
        }
        if self.state() == EngineState::Broken {
            return Err(AppError::Engine("引擎 10 分鐘內重啟超過 3 次，已停用；請按「重新啟動引擎」或查看 logs/engine.log".into()));
        }
        // 預算
        {
            let now = Instant::now();
            let mut s = self.starts.lock();
            while s.front().is_some_and(|t| now.duration_since(*t) > RESTART_WINDOW) {
                s.pop_front();
            }
            if !budget_ok(&s, now) {
                drop(s);
                self.set_state(sink, EngineState::Broken);
                return Err(AppError::Engine(format!(
                    "引擎 {} 分鐘內重啟超過 {} 次，已停用；最後錯誤：{}",
                    RESTART_WINDOW.as_secs() / 60,
                    MAX_RESTARTS,
                    self.last_exc.lock().clone().unwrap_or_else(|| "（無）".into())
                )));
            }
            s.push_back(now);
        }
        if !cfg.python.is_file() {
            return Err(AppError::PyEnv(format!("找不到引擎的 python：{}", cfg.python.display())));
        }
        self.stopping.store(false, Ordering::Relaxed);
        *self.cfg.lock() = Some(cfg.clone());
        self.set_state(sink, EngineState::Starting);

        let mut c = proc::cmd(&cfg.python.to_string_lossy());
        c.args(serve_args(cfg));
        for (k, v) in &cfg.env {
            c.env(k, v);
        }
        c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut child = match c.spawn() {
            Ok(ch) => ch,
            Err(e) => {
                self.set_state(sink, EngineState::Down);
                return Err(AppError::Engine(format!("啟動引擎失敗：{e}")));
            }
        };
        let stdin = child.stdin.take().ok_or_else(|| AppError::Engine("拿不到引擎 stdin".into()))?;
        let stdout = child.stdout.take().ok_or_else(|| AppError::Engine("拿不到引擎 stdout".into()))?;
        let stderr = child.stderr.take().ok_or_else(|| AppError::Engine("拿不到引擎 stderr".into()))?;
        let pid = child.id();
        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        // stderr 讀到 EOF 才通知 waiter：行程退出與「最後一行例外」到達 Rust 之間有競速，
        // waiter 先看到退出就會把死因報成「engine exited 3」而漏掉 `RuntimeError: …`。
        let (stderr_done_tx, stderr_done_rx) = oneshot::channel::<()>();
        {
            let mut live = self.live.lock().await;
            let gen = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
            self.stderr_tail.lock().clear();
            *self.last_exc.lock() = None;
            *self.hello.lock() = None;
            let tasks = vec![
                tauri::async_runtime::spawn(Self::reader(self.clone(), sink.clone(), stdout)),
                tauri::async_runtime::spawn(Self::stderr_drain(self.clone(), stderr, cfg.log_path.clone(), stderr_done_tx)),
                tauri::async_runtime::spawn(Self::waiter(self.clone(), sink.clone(), gen, child, kill_rx, stderr_done_rx)),
            ];
            *live = Some(Live { stdin: tokio::sync::Mutex::new(stdin), pid, kill_tx: Some(kill_tx), gen, tasks });
        }
        eprintln!("[engine] spawned pid={pid:?} {}", cfg.python.display());

        match self.request_inner("hello", "hello", json!({}), Some(HELLO_TIMEOUT)).await {
            Ok(Reply { ok: true, result, .. }) => {
                if let Err(why) = hello_compatible(&result, env!("CARGO_PKG_VERSION")) {
                    self.kill_current().await;
                    self.set_state(sink, EngineState::Down);
                    return Err(AppError::Engine(why));
                }
                *self.hello.lock() = Some(result);
                self.set_state(sink, EngineState::Ready);
                let gen = self.generation.load(Ordering::SeqCst);
                tauri::async_runtime::spawn(Self::pinger(self.clone(), sink.clone(), gen));
                Ok(())
            }
            Ok(Reply { ok: false, error, .. }) => {
                self.kill_current().await;
                self.set_state(sink, EngineState::Down);
                let e = error.unwrap_or_default();
                Err(AppError::Engine(format!("引擎拒絕 hello：{}（{}）", e.message, e.hint)))
            }
            Err(AppError::Canceled) => {
                // 啟動途中使用者按了停止（stop() 把 pending 以 Canceled 結束）：等著的工作照實回「已取消」
                self.kill_current().await;
                self.set_state(sink, EngineState::Down);
                Err(AppError::Canceled)
            }
            Err(e) => {
                self.kill_current().await;
                self.set_state(sink, EngineState::Down);
                let why = self.last_exc.lock().clone().unwrap_or_else(|| self.stderr_tail.lock().iter().cloned().collect::<Vec<_>>().join(" / "));
                Err(AppError::Engine(format!("引擎啟動失敗：{}{}", e.message(), if why.trim().is_empty() { String::new() } else { format!("；{why}") })))
            }
        }
    }

    /// 送 kill 給 waiter 並清掉 Live；所有 pending 以「引擎已停止」失敗。
    async fn kill_current(&self) {
        self.kill_live().await;
        self.fail_all_pending("引擎已停止");
    }

    async fn kill_live(&self) {
        let taken = self.live.lock().await.take();
        if let Some(mut l) = taken {
            if let Some(tx) = l.kill_tx.take() {
                let _ = tx.send(());
            }
        }
    }

    // ---------------- 背景任務 ----------------

    async fn reader(me: Arc<Engine>, sink: Sink, stdout: ChildStdout) {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            let line = match lines.next_line().await {
                Ok(Some(l)) => l,
                Ok(None) => break,
                Err(_) => continue, // 壞的一行跳過就好；停下來就是管線死鎖
            };
            match route_line(&line) {
                Routed::Reply { id, reply } => {
                    let tx = me.pending.lock().remove(&id);
                    match tx {
                        Some(tx) => {
                            let _ = tx.send(Ok(reply));
                        }
                        None => eprintln!("[engine] 沒人等的回覆 id={id}（可能已逾時）"),
                    }
                }
                Routed::Event { id, event, payload } => {
                    if let Some(name) = event_name(&event) {
                        sink.emit(name, event_payload(&id, &event, payload));
                    }
                }
                Routed::Ignored => {
                    let t: String = line.chars().take(200).collect();
                    if !t.trim().is_empty() {
                        eprintln!("[engine] stdout 非協定行：{t}");
                    }
                }
            }
        }
    }

    async fn stderr_drain(me: Arc<Engine>, stderr: ChildStderr, log_path: Option<PathBuf>, done: oneshot::Sender<()>) {
        let mut log = log_path.and_then(|p| {
            if let Some(d) = p.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            std::fs::OpenOptions::new().create(true).append(true).open(p).ok()
        });
        let mut lines = BufReader::new(stderr).lines();
        loop {
            let l = match lines.next_line().await {
                Ok(Some(x)) => x,
                Ok(None) => break,
                Err(_) => continue,
            };
            if let Some(f) = log.as_mut() {
                use std::io::Write;
                let _ = writeln!(f, "{} {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"), l);
            }
            if crate::pyenv::is_exception_line(&l) {
                *me.last_exc.lock() = Some(l.trim().to_string());
            }
            let mut t = me.stderr_tail.lock();
            t.push_back(l);
            while t.len() > STDERR_TAIL_LINES {
                t.pop_front();
            }
        }
        let _ = done.send(());
    }

    async fn waiter(
        me: Arc<Engine>,
        sink: Sink,
        gen: u64,
        mut child: Child,
        kill_rx: oneshot::Receiver<()>,
        stderr_done: oneshot::Receiver<()>,
    ) {
        let status = tokio::select! {
            s = child.wait() => s.ok(),
            _ = kill_rx => {
                let _ = child.start_kill();
                child.wait().await.ok()
            }
        };
        let code = status.and_then(|s| s.code());
        // 行程已退出，stderr 很快就 EOF；等它讀完（上限半秒）死因才會含最後一行例外
        let _ = tokio::time::timeout(STDERR_EOF_GRACE, stderr_done).await;
        // 只有「還是目前這一代」才動狀態；舊一代的 waiter 遲到就只記 log
        {
            let mut live = me.live.lock().await;
            if live.as_ref().is_some_and(|l| l.gen == gen) {
                *live = None;
            } else if me.generation.load(Ordering::SeqCst) != gen {
                eprintln!("[engine] gen {gen} exited {code:?}（已被新一代取代）");
                return;
            }
        }
        let stopping = me.stopping.swap(false, Ordering::Relaxed);
        let why = if stopping { "引擎已停止".to_string() } else { me.death_message(code) };
        eprintln!("[engine] {why}");
        if stopping {
            me.fail_all_pending_with(|| AppError::Canceled);
        } else {
            me.fail_all_pending(&why);
        }
        if me.state() != EngineState::Broken {
            me.set_state(&sink, EngineState::Down);
        } else {
            me.emit_state(&sink);
        }
    }

    /// 閒置時每 15 秒 ping；連錯 2 次就殺掉重啟（預算內），否則 Broken。
    async fn pinger(me: Arc<Engine>, sink: Sink, gen: u64) {
        let mut misses = 0u32;
        loop {
            tokio::time::sleep(PING_INTERVAL).await;
            if me.generation.load(Ordering::SeqCst) != gen || me.state() != EngineState::Ready {
                return;
            }
            if !me.idle() {
                misses = 0;
                continue;
            }
            match me.request_inner(&format!("ping-{}", uuid::Uuid::new_v4()), "ping", json!({}), Some(PING_TIMEOUT)).await {
                Ok(Reply { ok: true, .. }) => misses = 0,
                _ => {
                    misses += 1;
                    eprintln!("[engine] ping 沒回（{misses}/{PING_MAX_MISSES}）");
                    if misses >= PING_MAX_MISSES {
                        *me.last_exc.lock() = Some("ping 連續沒有回應".into());
                        me.kill_current().await;
                        me.set_state(&sink, EngineState::Down);
                        let cfg = me.cfg.lock().clone();
                        if let Some(cfg) = cfg {
                            if let Err(e) = me.ensure_started(&sink, &cfg).await {
                                eprintln!("[engine] 重啟失敗：{}", e.message());
                            }
                        }
                        return;
                    }
                }
            }
        }
    }

    // ---------------- 請求 ----------------

    async fn write_line(&self, line: &str) -> AppResult<()> {
        let live = self.live.lock().await;
        let Some(l) = live.as_ref() else { return Err(AppError::Engine("引擎未啟動".into())) };
        let mut stdin = l.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await.map_err(|e| AppError::Engine(format!("寫入引擎失敗：{e}")))?;
        stdin.flush().await.map_err(|e| AppError::Engine(format!("寫入引擎失敗：{e}")))?;
        Ok(())
    }

    /// 送請求、等同一 id 的回覆（不做 ensure_started；hello / ping / cancel 用）。
    async fn request_inner(&self, id: &str, op: &str, args: Value, timeout: Option<Duration>) -> Result<Reply, AppError> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id.to_string(), tx);
        if let Err(e) = self.write_line(&request_line(id, op, &args)).await {
            self.pending.lock().remove(id);
            return Err(e);
        }
        let got = match timeout {
            Some(t) => match tokio::time::timeout(t, rx).await {
                Ok(r) => r,
                Err(_) => {
                    self.pending.lock().remove(id);
                    return Err(AppError::Timeout(t.as_millis() as u64));
                }
            },
            None => rx.await,
        };
        match got {
            Ok(r) => r,
            Err(_) => Err(AppError::Engine("引擎在回覆前結束".into())),
        }
    }

    /// 一般呼叫：確保引擎在跑 → 送 → 等回覆（有 timeout）。`ok:false` 直接映射成 `AppError`。
    pub async fn call(self: &Arc<Self>, sink: &Sink, cfg: &StartConfig, op: &str, args: Value, timeout: Duration) -> AppResult<Value> {
        self.ensure_started(sink, cfg).await?;
        let id = format!("c-{}", uuid::Uuid::new_v4());
        let reply = match self.request_inner(&id, op, args, Some(timeout)).await {
            Err(AppError::Timeout(ms)) => {
                // App 已經放棄這個呼叫：叫引擎取消（B-06）。還沒輪到的會直接回 Canceled、不再白佔 worker；
                // 以前 pending 移掉就算了，排在長工作後面的 op 之後照樣執行、再拖慢下一個工作。
                // 不等 cancel 的回覆（引擎的讀取執行緒會即時處理），逾時錯誤立刻回給前端。
                let me = self.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = me.send_wire_cancel(&id).await;
                });
                return Err(AppError::Timeout(ms));
            }
            r => r?,
        };
        match reply {
            Reply { ok: true, result, .. } => Ok(result),
            Reply { error, .. } => Err(wire_error_to_app(&error.unwrap_or_default())),
        }
    }

    /// 長工作：先登記（前端立刻看到 queued）→ 取 GPU permit → 送請求（id = job_id）→ 回覆時發 `engine-job-done`。
    pub fn start_job(self: &Arc<Self>, sink: Sink, cfg: StartConfig, job_id: String, op: String, args: Value, gpu: bool) -> AppResult<()> {
        if job_id.trim().is_empty() || job_id.len() > 128 {
            return Err(AppError::Invalid("job_id 無效".into()));
        }
        {
            let mut jobs = self.jobs.lock();
            if jobs.contains_key(&job_id) {
                return Err(AppError::Invalid(format!("job_id 重複：{job_id}")));
            }
            jobs.insert(job_id.clone(), JobEntry { op: op.clone(), running: false, sent: false, cancel_requested: false });
        }
        self.emit_state(&sink);
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let permit = if gpu { me.gpu.clone().acquire_owned().await.ok() } else { None };
            {
                let mut jobs = me.jobs.lock();
                match jobs.get_mut(&job_id) {
                    Some(j) => j.running = true,
                    None => return, // 排隊時被取消：cancel() 已經發過 engine-job-done
                }
            }
            me.emit_state(&sink);
            let r = match me.ensure_started(&sink, &cfg).await {
                Ok(()) => me.run_job_request(&job_id, &op, args).await,
                Err(e) => Err(e),
            };
            drop(permit);
            me.jobs.lock().remove(&job_id);
            sink.emit(EV_JOB_DONE, job_done_payload(&job_id, &r));
            me.emit_state(&sink);
        });
        Ok(())
    }

    /// 長工作的請求本體（引擎已 Ready）：送出前看取消旗標 → 寫請求行 → 標 `sent` 並再看一次旗標 → 等回覆。
    ///
    /// 為什麼要兩次檢查：job 在 `ensure_started` 期間（重啟中 hello 要 10–40 秒）就是 running，
    /// 這時的 wire cancel 不是寫不進去（引擎未啟動）就是排在 hello 後面、引擎回 found:false —— 取消被吃掉、
    /// job 照樣送出跑完還佔著 GPU。所以 `cancel()` 對「running 未 sent」只記旗標：
    /// - 送出前看到 → 不送，直接 Canceled；
    /// - 寫請求行途中才按 → 寫完看到旗標，由這裡補送 wire cancel（同一條 stdin，一定排在請求行之後，引擎認得 id）。
    async fn run_job_request(&self, job_id: &str, op: &str, args: Value) -> Result<Reply, AppError> {
        {
            let jobs = self.jobs.lock();
            if jobs.get(job_id).is_some_and(|j| j.cancel_requested) {
                return Err(AppError::Canceled);
            }
        }
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(job_id.to_string(), tx);
        if let Err(e) = self.write_line(&request_line(job_id, op, &args)).await {
            self.pending.lock().remove(job_id);
            return Err(e);
        }
        let late_cancel = {
            let mut jobs = self.jobs.lock();
            match jobs.get_mut(job_id) {
                Some(j) => {
                    j.sent = true;
                    j.cancel_requested
                }
                None => false,
            }
        };
        if late_cancel {
            let _ = self.send_wire_cancel(job_id).await;
        }
        match rx.await {
            Ok(r) => r,
            Err(_) => Err(AppError::Engine("引擎在回覆前結束".into())),
        }
    }

    async fn send_wire_cancel(&self, job_id: &str) -> AppResult<()> {
        let id = format!("cancel-{}", uuid::Uuid::new_v4());
        match self.request_inner(&id, "cancel", json!({ "id": job_id }), Some(CANCEL_TIMEOUT)).await {
            Ok(_) => Ok(()),
            Err(AppError::Timeout(_)) => Ok(()), // 引擎忙著算：cancel 會在讀取執行緒處理，回覆晚一點沒關係
            Err(e) => Err(e),
        }
    }

    /// 取消：排隊中 → 直接移除並發 `engine-job-done{Canceled}`；
    /// 執行中但請求還沒送進引擎（正在等引擎啟動 / 重啟）→ 記旗標，`run_job_request` 不送、以 Canceled 結束；
    /// 已送進引擎 → 送控制 op `cancel{id}`，引擎在下一個合作點擲 Canceled，該 job 自己的回覆會帶 `ok:false, kind:Canceled`。
    pub async fn cancel(&self, sink: &Sink, job_id: &str) -> AppResult<()> {
        let queued = {
            let mut jobs = self.jobs.lock();
            match jobs.get_mut(job_id) {
                None => return Ok(()), // 已經結束
                Some(j) if !j.running => {
                    jobs.remove(job_id);
                    true
                }
                Some(j) if !j.sent => {
                    j.cancel_requested = true;
                    return Ok(());
                }
                Some(_) => false,
            }
        };
        if queued {
            sink.emit(EV_JOB_DONE, job_done_payload(job_id, &Err(AppError::Canceled)));
            self.emit_state(sink);
            return Ok(());
        }
        self.send_wire_cancel(job_id).await
    }

    /// 使用者主動停止 / App 退出：先禮貌 `shutdown`（兩秒沒回就殺）；回了就等行程自己退出（≤3 秒、整體 ≤4.5 秒）再殺。
    ///
    /// 為什麼要等（B-09）：引擎收到 shutdown 會取消工作、kill ffmpeg、刪掉 `<out>.part` 再退出（實測 0.05–0.12 s）；
    /// 一收到回覆就硬殺，這些都來不及做。還沒回覆的工作／呼叫以 Canceled 結束（使用者按的停止），不是「引擎錯誤」。
    pub async fn stop(&self, sink: Option<&Sink>) {
        let t0 = Instant::now();
        self.stopping.store(true, Ordering::Relaxed);
        let gen = self.live.lock().await.as_ref().map(|l| l.gen);
        if let Some(gen) = gen {
            let acked = matches!(
                tokio::time::timeout(
                    SHUTDOWN_GRACE,
                    self.request_inner(&format!("shutdown-{}", uuid::Uuid::new_v4()), "shutdown", json!({}), Some(SHUTDOWN_GRACE)),
                )
                .await,
                Ok(Ok(Reply { ok: true, .. }))
            );
            if acked {
                let deadline = Instant::now() + SHUTDOWN_EXIT_WAIT.min(STOP_BUDGET.saturating_sub(t0.elapsed()));
                // waiter 看到行程退出（含 stderr 讀完）才會把這一代的 Live 清掉
                while Instant::now() < deadline && self.live.lock().await.as_ref().is_some_and(|l| l.gen == gen) {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }
        }
        self.kill_live().await;
        self.fail_all_pending_with(|| AppError::Canceled);
        *self.state.lock() = EngineState::Down;
        *self.hello.lock() = None;
        if let Some(s) = sink {
            self.emit_state(s);
        }
    }

    pub async fn shutdown(&self) {
        self.stop(None).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NullSink;

    impl EventSink for NullSink {
        fn emit(&self, _name: &str, _payload: Value) {}
    }

    /// 更新安裝前舉起 update_lock：連 python 都不找就回錯（不會啟動引擎、不會開 python 子行程）；放下後照常。
    #[test]
    fn update_lock_refuses_to_start_the_engine() {
        let eng = Arc::new(Engine::new());
        let sink: Sink = Arc::new(NullSink);
        let cfg = StartConfig { python: PathBuf::from("沒有這個 python.exe"), cache_dir: std::env::temp_dir(), ffmpeg_dir: None, env: Vec::new(), log_path: None };
        eng.set_update_lock(true);
        assert!(eng.update_locked());
        let e = tauri::async_runtime::block_on(eng.ensure_started(&sink, &cfg)).unwrap_err();
        assert!(matches!(e, AppError::Invalid(ref m) if m == UPDATE_LOCKED_MSG), "{e:?}");
        assert_eq!(eng.state(), EngineState::Down, "沒有嘗試啟動");
        eng.set_update_lock(false);
        assert!(!eng.update_locked());
        // 放下之後走正常的啟動流程（這裡 python 不存在 → 是啟動失敗，不是更新鎖）
        let e = tauri::async_runtime::block_on(eng.ensure_started(&sink, &cfg)).unwrap_err();
        assert!(!matches!(e, AppError::Invalid(ref m) if m == UPDATE_LOCKED_MSG), "{e:?}");
    }

    #[test]
    fn pending_calls_counts_only_short_calls() {
        let eng = Engine::new();
        for id in ["c-1", "c-2", "hello", "ping-1", "job-1"] {
            let (tx, _rx) = oneshot::channel();
            eng.pending.lock().insert(id.into(), tx);
        }
        assert_eq!(eng.pending_calls(), 2);
    }

    /// B-09 預算倒置：`stop()` 的等待是 `SHUTDOWN_EXIT_WAIT.min(STOP_BUDGET − elapsed)`，而 elapsed 已經
    /// 含了等 ack 的 `SHUTDOWN_GRACE`。三個常數沒有這個關係的話，「ack 回得慢」會安靜地吃掉引擎收尾的時間
    /// （ffmpeg 還沒死就硬殺 → `.part` 留在使用者的輸出資料夾，而且唯一檔名不會被下次渲染蓋掉）。
    /// 引擎那邊最壞情況約 1.7 s（FfmpegProcess.kill 1.2 + drain 0.4 + 刪 .part 0.1）。
    #[test]
    fn budgets_are_ordered() {
        assert!(
            STOP_BUDGET >= SHUTDOWN_GRACE + SHUTDOWN_EXIT_WAIT,
            "ack 花滿 SHUTDOWN_GRACE 時仍要留滿 SHUTDOWN_EXIT_WAIT 給引擎收尾：{STOP_BUDGET:?} < {SHUTDOWN_GRACE:?} + {SHUTDOWN_EXIT_WAIT:?}"
        );
        assert!(SHUTDOWN_EXIT_WAIT >= Duration::from_millis(2000), "要蓋得住引擎最壞情況的收尾（約 1.7 s）");
        // lib.rs 的 App 退出預算：`timeout(Duration::from_secs(5), eng.shutdown())`
        assert!(STOP_BUDGET < Duration::from_secs(5), "硬殺要在 App 退出預算之前送出");
    }

    #[test]
    fn routes_ok_reply() {
        let r = route_line(r#"{"id":"j1","ok":true,"result":{"frames":1797}}"#);
        match r {
            Routed::Reply { id, reply } => {
                assert_eq!(id, "j1");
                assert!(reply.ok);
                assert_eq!(reply.result["frames"], 1797);
                assert!(reply.error.is_none());
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn routes_error_reply_with_wire_error() {
        let r = route_line(r#"{"id":"j2","ok":false,"error":{"kind":"Gpu","message":"CUDA out of memory","hint":"關掉其他 GPU 程式"}}"#);
        match r {
            Routed::Reply { id, reply } => {
                assert_eq!(id, "j2");
                assert!(!reply.ok);
                let e = reply.error.unwrap();
                assert_eq!(e.kind, "Gpu");
                assert!(matches!(wire_error_to_app(&e), AppError::Gpu(m) if m.contains("關掉其他 GPU 程式")));
            }
            other => panic!("{other:?}"),
        }
        // ok:false 但 error 形狀壞掉 → 仍是 Reply（不能讓 job 永遠等）
        match route_line(r#"{"id":"j3","ok":false,"error":"boom"}"#) {
            Routed::Reply { reply, .. } => assert_eq!(reply.error.unwrap().kind, "Internal"),
            other => panic!("{other:?}"),
        }
        match route_line(r#"{"id":"j4","ok":false}"#) {
            Routed::Reply { reply, .. } => assert!(reply.error.is_some()),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn routes_events_and_ignores_junk() {
        match route_line(r#"{"id":"j1","event":"progress","stage":"seg","done":12,"total":100,"eta_s":3.5}"#) {
            Routed::Event { id, event, payload } => {
                assert_eq!((id.as_str(), event.as_str()), ("j1", "progress"));
                assert_eq!(payload["done"], 12);
            }
            other => panic!("{other:?}"),
        }
        for junk in ["", "   ", "hello world", "{not json", r#"{"ok":true}"#, r#"{"id":"x"}"#, r#"[1,2]"#, r#"{"id":5,"ok":true}"#] {
            assert_eq!(route_line(junk), Routed::Ignored, "{junk:?}");
        }
        // 中文（ensure_ascii=False）與 BOM / 前後空白都要吃
        match route_line("  {\"id\":\"中文\",\"ok\":true,\"result\":\"好\"}\r") {
            Routed::Reply { id, reply } => {
                assert_eq!(id, "中文");
                assert_eq!(reply.result, "好");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn event_payload_renames_id_and_adds_pct() {
        let p = event_payload("j1", "progress", json!({"id":"j1","event":"progress","stage":"seg","done":25,"total":100}));
        assert_eq!(p["job_id"], "j1");
        assert!(p.get("id").is_none() && p.get("event").is_none());
        assert_eq!(p["stage"], "seg");
        assert_eq!(p["pct"], 25.0);
        // total 0 不除、不 NaN
        let p0 = event_payload("j1", "progress", json!({"id":"j1","event":"progress","done":0,"total":0}));
        assert!(p0.get("pct").is_none());
        // 引擎自己給了 pct 就不覆寫
        let p2 = event_payload("j1", "progress", json!({"id":"j1","event":"progress","done":1,"total":2,"pct":99}));
        assert_eq!(p2["pct"], 99);
        let l = event_payload("j1", "log", json!({"id":"j1","event":"log","level":"warn","message":"x"}));
        assert_eq!(l["job_id"], "j1");
        assert!(l.get("pct").is_none());
        assert_eq!(event_name("progress"), Some(EV_PROGRESS));
        assert_eq!(event_name("log"), Some(EV_LOG));
        assert_eq!(event_name("artifact"), Some(EV_ARTIFACT));
        assert_eq!(event_name("telemetry"), None);
    }

    #[test]
    fn request_line_is_single_line_json_with_newline() {
        let s = request_line("j1", "media.probe", &json!({"path": "D:\\a b\\多行\n測試.webm"}));
        assert!(s.ends_with('\n'));
        assert_eq!(s.matches('\n').count(), 1, "字串內的換行要被跳脫成 \\n，整體只能一行");
        let v: Value = serde_json::from_str(s.trim_end()).unwrap();
        assert_eq!(v["id"], "j1");
        assert_eq!(v["op"], "media.probe");
        assert_eq!(v["args"]["path"], "D:\\a b\\多行\n測試.webm");
        // hello 的固定形狀（計畫 §5.8）
        assert_eq!(request_line("hello", "hello", &json!({})), "{\"id\":\"hello\",\"op\":\"hello\",\"args\":{}}\n");
    }

    #[test]
    fn job_done_payload_shapes() {
        let ok = job_done_payload("j1", &Ok(Reply { ok: true, result: json!({"n": 1}), error: None }));
        assert_eq!(ok, json!({"job_id":"j1","ok":true,"result":{"n":1}}));
        let we = WireError { kind: "Canceled".into(), message: "已取消".into(), hint: "".into() };
        let canceled = job_done_payload("j1", &Ok(Reply { ok: false, result: Value::Null, error: Some(we) }));
        assert_eq!(canceled["ok"], false);
        assert_eq!(canceled["error"]["kind"], "Canceled");
        let died = job_done_payload("j1", &Err(AppError::Engine("engine exited 1: RuntimeError: x".into())));
        assert_eq!(died["error"]["kind"], "Engine");
        assert!(died["error"]["message"].as_str().unwrap().contains("RuntimeError"));
        assert_eq!(job_done_payload("j", &Err(AppError::Timeout(5)))["error"]["kind"], "Timeout");
        assert_eq!(job_done_payload("j", &Err(AppError::Canceled))["error"]["kind"], "Canceled");
    }

    #[test]
    fn wire_kinds_map_both_ways() {
        let cases = [
            ("Invalid", "invalid"),
            ("Io", "io"),
            ("Ffmpeg", "ffmpeg"),
            ("Canceled", "canceled"),
            ("Timeout", "timeout"),
            ("Gpu", "gpu"),
            ("PyEnv", "pyenv"),
            ("Model", "engine"),
            ("Engine", "engine"),
            ("Internal", "engine"),
            ("SomethingNew", "engine"),
        ];
        for (wire, kind) in cases {
            let e = wire_error_to_app(&WireError { kind: wire.into(), message: "m".into(), hint: "h".into() });
            assert_eq!(e.kind(), kind, "{wire}");
        }
        // hint 要進訊息（那是 Rust 端 stderr 尾巴以外唯一的線索）
        let e = wire_error_to_app(&WireError { kind: "Internal".into(), message: "ValueError: x".into(), hint: "line 3".into() });
        assert!(e.message().contains("line 3"));
        assert_eq!(app_error_to_wire(&AppError::NotFound("f".into())).kind, "Io");
        assert_eq!(app_error_to_wire(&AppError::Agent("f".into())).kind, "Internal");
    }

    /// B-11：引擎回 Timeout 時，以前一律變成 `AppError::Timeout(0)`，UI 只看得到「逾時（0 ms）」，
    /// Python 給的死因（「ffprobe 超過 60s 沒回應」＋ hint）整個不見。
    #[test]
    fn wire_timeout_keeps_the_python_message_and_hint() {
        let e = wire_error_to_app(&WireError {
            kind: "Timeout".into(),
            message: "ffprobe 超過 60s 沒回應".into(),
            hint: "影片可能在網路磁碟上".into(),
        });
        let msg = e.message();
        assert!(msg.contains("ffprobe 超過 60s 沒回應"), "{msg}");
        assert!(msg.contains("影片可能在網路磁碟上"), "{msg}");
        assert!(!msg.contains("0 ms"), "{msg}");
        // 類別不變：前端與 i18n 仍然看到 timeout / ERR_TIMEOUT，回線路也還是 Timeout
        assert_eq!(e.kind(), "timeout");
        assert_eq!(e.code(), "ERR_TIMEOUT");
        assert_eq!(app_error_to_wire(&e).kind, "Timeout");
        // Rust 自己等超時的那條路不受影響（知道毫秒數時照舊）
        assert_eq!(AppError::Timeout(300).message(), "逾時（300 ms）");
    }

    #[test]
    fn restart_budget_allows_three_restarts_per_window() {
        let now = Instant::now();
        let mut t = VecDeque::new();
        assert!(budget_ok(&t, now), "第一次啟動");
        t.push_back(now);
        for _ in 0..MAX_RESTARTS {
            assert!(budget_ok(&t, now));
            t.push_back(now);
        }
        assert!(!budget_ok(&t, now), "1 + 3 次之後要擋");
        // 舊的掉出視窗就不算
        let old = VecDeque::from(vec![now - RESTART_WINDOW - Duration::from_secs(1); 10]);
        assert!(budget_ok(&old, now));
    }

    #[test]
    fn hello_protocol_and_version_check() {
        assert!(hello_compatible(&json!({"version":"0.0.1","protocol":1}), "0.0.1").is_ok());
        assert!(hello_compatible(&json!({"version":"0.0.1"}), "0.0.1").is_ok(), "缺 protocol 視為 1");
        assert!(hello_compatible(&json!({"protocol":1}), "0.0.1").is_ok(), "缺 version 不比對");
        let e = hello_compatible(&json!({"protocol":2,"version":"0.0.1"}), "0.0.1").unwrap_err();
        assert!(e.contains("協定"), "{e}");
        // App 升版、venv 裡還是舊 wheel：拒絕，訊息要指向重新安裝
        let e = hello_compatible(&json!({"protocol":1,"version":"0.0.3"}), "0.0.4").unwrap_err();
        assert!(e.contains("0.0.3") && e.contains("0.0.4") && e.contains("重新安裝"), "{e}");
        // 真的引擎回的 version 就是 _version.py，與 CARGO_PKG_VERSION 由 sync-version.mjs 同步
        assert!(hello_compatible(&json!({"protocol":1,"version":env!("CARGO_PKG_VERSION")}), env!("CARGO_PKG_VERSION")).is_ok());
    }

    #[test]
    fn serve_args_shape() {
        let cfg = StartConfig {
            python: PathBuf::from("C:\\x\\python.exe"),
            cache_dir: PathBuf::from("C:\\Users\\a b\\cache"),
            ffmpeg_dir: Some(PathBuf::from("D:\\ff")),
            env: vec![],
            log_path: None,
        };
        let a = serve_args(&cfg);
        assert_eq!(&a[..5], &["-X", "utf8", "-m", "aivc", "serve"]);
        assert_eq!(a[5], "--cache-dir");
        assert_eq!(a[6], "C:\\Users\\a b\\cache", "含空白的路徑是一個 argv");
        assert_eq!(&a[7..], &["--ffmpeg-dir", "D:\\ff"]);
        let no_ff = serve_args(&StartConfig { ffmpeg_dir: None, ..cfg });
        assert!(!no_ff.iter().any(|s| s == "--ffmpeg-dir"));
    }

    #[test]
    fn engine_state_serializes_lowercase() {
        assert_eq!(serde_json::to_value(EngineState::Ready).unwrap(), "ready");
        assert_eq!(serde_json::to_value(EngineState::Broken).unwrap(), "broken");
        let e = Engine::new();
        let info = e.info();
        assert_eq!(info.state, EngineState::Down);
        assert_eq!(info.restarts, 0);
        assert!(info.queued.is_empty() && info.running.is_empty());
        let v = serde_json::to_value(&info).unwrap();
        for k in ["state", "pid", "hello", "last_exc", "restarts", "queued", "running"] {
            assert!(v.get(k).is_some(), "{k}");
        }
    }
}

/// 用**假 python 腳本**跑真的監督流程（計畫 §10 A1 / §11）：回覆路由、進度事件、timeout、取消、退出 → pending 失敗、
/// 版本 / 協定拒絕、禮貌 shutdown。假引擎是寫進暫存目錄的 `aivc/__main__.py`，以 `PYTHONPATH` 蓋過 site-packages，
/// 所以 `serve_args`（`python -X utf8 -m aivc serve --cache-dir …`）一個字都不用改、走的就是正式路徑。
///
/// 找不到可用的 python（沙盒 CI / Windows 商店 stub）就印 SKIP 直接回，不算失敗 —— 純函式測試在上面那個 mod。
/// 全部用 `tauri::async_runtime::block_on`：Engine 內部用 `tauri::async_runtime::spawn`（全域 runtime），
/// 子行程也要在同一個 runtime 上建立才不會跨 runtime 等 wait。
#[cfg(test)]
mod fake_engine_tests {
    use super::*;
    use std::path::Path;

    /// 只認協定形狀（§5.8），沒有 torch。主執行緒＝讀取執行緒，控制 op 立刻回；業務 op 排進單一 worker。
    /// op：`echo`（兩個 progress + 一個 log，回 args）、`sleep{s}`（可取消）、`stuck{s}`（不理取消）、`junk`（先印一行非協定文字）、
    /// `die`（stderr 印 traceback 後 exit 3）、其他 → Invalid。`FAKE_PROTOCOL` / `FAKE_VERSION` 環境變數控制 hello，
    /// `FAKE_SHUTDOWN_EXIT_DELAY` 控制 shutdown 回覆後多久才退出。stderr（→ engine.log）記 `recv`／`exec`／`cancel` 給測試對帳。
    const FAKE_ENGINE_PY: &str = r#"
import json, os, queue, sys, threading, time

PROTOCOL = int(os.environ.get("FAKE_PROTOCOL", "1"))
VERSION = os.environ.get("FAKE_VERSION", "0.0.0")
_lock = threading.Lock()
_jobs = {}
_q = queue.Queue()


def _raw(text):
    with _lock:
        sys.stdout.write(text)
        sys.stdout.flush()


def emit(obj):
    _raw(json.dumps(obj, ensure_ascii=False) + "\n")


def ok(rid, result):
    emit({"id": rid, "ok": True, "result": result})


def err(rid, kind, message, hint=""):
    emit({"id": rid, "ok": False, "error": {"kind": kind, "message": message, "hint": hint}})


def worker():
    while True:
        rid, op, args, cancel = _q.get()
        try:
            if cancel.is_set():
                # 跟真引擎 serve._run_job 一樣：排隊中就被取消的不執行
                err(rid, "Canceled", "canceled before start")
                continue
            sys.stderr.write("exec op=" + str(op) + " id=" + str(rid) + "\n")
            sys.stderr.flush()
            if op == "echo":
                emit({"id": rid, "event": "progress", "stage": "echo", "done": 1, "total": 2})
                emit({"id": rid, "event": "log", "level": "info", "message": "half"})
                emit({"id": rid, "event": "progress", "stage": "echo", "done": 2, "total": 2})
                ok(rid, args)
            elif op == "sleep":
                secs = float(args.get("s", 1))
                end = time.monotonic() + secs
                while time.monotonic() < end:
                    if cancel.is_set():
                        err(rid, "Canceled", "canceled")
                        break
                    time.sleep(0.02)
                else:
                    ok(rid, {"slept": secs})
            elif op == "stuck":
                time.sleep(float(args.get("s", 30)))  # 不理取消（模擬載模型這種沒有合作點的階段）
                ok(rid, {"stuck": True})
            elif op == "junk":
                _raw("this is not a protocol line\n")
                ok(rid, "after-junk")
            elif op == "die":
                sys.stderr.write("Traceback (most recent call last):\n  File \"fake.py\", line 1, in <module>\nRuntimeError: boom\n")
                sys.stderr.flush()
                os._exit(3)
            else:
                err(rid, "Invalid", "unknown op " + str(op))
        finally:
            _jobs.pop(rid, None)


threading.Thread(target=worker, daemon=True).start()
sys.stderr.write("fake engine up\n")
sys.stderr.flush()
for raw in sys.stdin.buffer:
    try:
        req = json.loads(raw.decode("utf-8"))
    except Exception:
        continue
    rid, op, args = req.get("id"), req.get("op"), req.get("args") or {}
    if op == "hello":
        # 模擬冷機 import torch：hello 在唯一的 stdin 讀取執行緒上同步處理，期間後面的行（含 cancel）都讀不到
        time.sleep(float(os.environ.get("FAKE_HELLO_DELAY", "0")))
        ok(rid, {"version": VERSION, "protocol": PROTOCOL, "python": "fake"})
    elif op == "ping":
        ok(rid, {"uptime_s": 1})
    elif op == "cancel":
        ev = _jobs.get(args.get("id"))
        if ev is not None:
            ev.set()
        sys.stderr.write("cancel id=" + str(args.get("id")) + " found=" + str(ev is not None) + "\n")
        sys.stderr.flush()
        ok(rid, {"found": ev is not None})
    elif op == "shutdown":
        # 跟真引擎一樣：先取消所有工作再回覆，收尾後才退出；FAKE_SHUTDOWN_EXIT_DELAY 控制收尾要多久（很大 = 永遠不走）
        for ev in list(_jobs.values()):
            ev.set()
        ok(rid, None)
        time.sleep(float(os.environ.get("FAKE_SHUTDOWN_EXIT_DELAY", "0")))
        sys.stderr.write("fake graceful exit\n")
        sys.stderr.flush()
        os._exit(0)
    else:
        sys.stderr.write("recv op=" + str(op) + " id=" + str(rid) + "\n")
        sys.stderr.flush()
        ev = threading.Event()
        _jobs[rid] = ev
        _q.put((rid, op, args, ev))
"#;

    /// 把事件收進 Vec 的 sink。
    struct RecSink(Mutex<Vec<(String, Value)>>);

    impl EventSink for RecSink {
        fn emit(&self, name: &str, payload: Value) {
            self.0.lock().push((name.to_string(), payload));
        }
    }

    impl RecSink {
        fn find(&self, name: &str, pred: impl Fn(&Value) -> bool) -> Option<Value> {
            self.0.lock().iter().find(|(n, p)| n == name && pred(p)).map(|(_, p)| p.clone())
        }

        fn states(&self) -> Vec<String> {
            self.0.lock().iter().filter(|(n, _)| n == EV_STATE).map(|(_, p)| p["state"].as_str().unwrap_or("").to_string()).collect()
        }
    }

    /// `AIVC_TEST_PYTHON` → `python3` → `python`；要真的能跑 `-c` 才算（Windows 商店的 python stub 會 exit 9009）。
    fn find_python() -> Option<PathBuf> {
        let mut cands: Vec<PathBuf> =
            std::env::var("AIVC_TEST_PYTHON").ok().filter(|s| !s.trim().is_empty()).map(PathBuf::from).into_iter().collect();
        cands.push(PathBuf::from("python3"));
        cands.push(PathBuf::from("python"));
        for c in cands {
            let mut cmd = std::process::Command::new(&c);
            cmd.args(["-X", "utf8", "-c", "import sys;print(sys.executable)"]).stdin(Stdio::null());
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(proc::CREATE_NO_WINDOW);
            }
            if let Ok(o) = cmd.output() {
                if o.status.success() {
                    let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    if !p.is_empty() && Path::new(&p).is_file() {
                        return Some(PathBuf::from(p));
                    }
                }
            }
        }
        None
    }

    struct Fixture {
        dir: PathBuf,
        cfg: StartConfig,
        sink: Arc<RecSink>,
        engine: Arc<Engine>,
    }

    impl Fixture {
        fn sink(&self) -> Sink {
            self.sink.clone()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn fixture(extra_env: &[(&str, &str)]) -> Option<Fixture> {
        let Some(python) = find_python() else {
            eprintln!("SKIP: 找不到可用的 python，假引擎測試略過");
            return None;
        };
        // 路徑刻意含空白與中文（`01 qen3_tts` 這種目錄就是日常）
        let dir = std::env::temp_dir().join(format!("aivc fake engine 測試-{}", uuid::Uuid::new_v4()));
        let pkg = dir.join("pypath").join("aivc");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("__init__.py"), b"").unwrap();
        std::fs::write(pkg.join("__main__.py"), FAKE_ENGINE_PY).unwrap();
        let cache = dir.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let mut env = vec![
            ("PYTHONPATH".to_string(), dir.join("pypath").to_string_lossy().into_owned()),
            ("FAKE_VERSION".to_string(), env!("CARGO_PKG_VERSION").to_string()),
        ];
        for (k, v) in extra_env {
            env.retain(|(n, _)| n != k);
            env.push((k.to_string(), v.to_string()));
        }
        let cfg = StartConfig { python, cache_dir: cache, ffmpeg_dir: None, env, log_path: Some(dir.join("engine.log")) };
        Some(Fixture { dir, cfg, sink: Arc::new(RecSink(Mutex::new(Vec::new()))), engine: Arc::new(Engine::new()) })
    }

    async fn wait_for<T>(timeout: Duration, mut pred: impl FnMut() -> Option<T>) -> Option<T> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(v) = pred() {
                return Some(v);
            }
            if Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[test]
    fn fake_engine_handshake_call_and_progress_events() {
        let Some(f) = fixture(&[]) else { return };
        tauri::async_runtime::block_on(async {
            let sink = f.sink();
            f.engine.start(&sink, &f.cfg).await.expect("start");
            assert_eq!(f.engine.state(), EngineState::Ready);
            let info = f.engine.info();
            assert_eq!(info.hello.as_ref().unwrap()["python"], "fake");
            assert!(info.pid.is_some());
            let states = f.sink.states();
            assert!(states.contains(&"starting".to_string()) && states.last().map(String::as_str) == Some("ready"), "{states:?}");

            // call：結果原樣回（含中文）；進度轉成 engine-progress（job_id + pct、去掉 id/event）；log 轉 engine-log
            let r = f.engine.call(&sink, &f.cfg, "echo", json!({"x": 1, "中文": "好"}), Duration::from_secs(20)).await.unwrap();
            assert_eq!(r, json!({"x": 1, "中文": "好"}));
            let prog = f.sink.find(EV_PROGRESS, |p| p["done"] == 2).expect("progress 2/2");
            assert_eq!(prog["pct"], 100.0);
            assert!(prog["job_id"].as_str().unwrap().starts_with("c-"));
            assert!(prog.get("id").is_none() && prog.get("event").is_none());
            assert!(f.sink.find(EV_LOG, |p| p["message"] == "half").is_some());

            // 非協定行不會弄死讀取迴圈
            assert_eq!(f.engine.call(&sink, &f.cfg, "junk", json!({}), Duration::from_secs(20)).await.unwrap(), "after-junk");
            // ok:false 映射成 AppError（Invalid）
            assert!(matches!(f.engine.call(&sink, &f.cfg, "nope", json!({}), Duration::from_secs(20)).await, Err(AppError::Invalid(_))));

            // 禮貌 shutdown：假引擎收到 shutdown 就 exit 0；狀態 Down、pid 清掉、最後一個 engine-state 是 down
            f.engine.stop(Some(&sink)).await;
            assert_eq!(f.engine.state(), EngineState::Down);
            assert!(f.engine.info().pid.is_none());
            assert_eq!(f.sink.states().last().map(String::as_str), Some("down"));
        });
    }

    #[test]
    fn fake_engine_start_job_emits_progress_and_done() {
        let Some(f) = fixture(&[]) else { return };
        tauri::async_runtime::block_on(async {
            let sink = f.sink();
            // 引擎還沒啟動：start_job 自己會 ensure_started
            f.engine.start_job(sink.clone(), f.cfg.clone(), "j1".into(), "echo".into(), json!({"n": 7}), true).unwrap();
            assert!(
                matches!(f.engine.start_job(sink.clone(), f.cfg.clone(), "j1".into(), "echo".into(), json!({}), true), Err(AppError::Invalid(_))),
                "重複 job_id 立刻拒絕"
            );
            let done = wait_for(Duration::from_secs(60), || f.sink.find(EV_JOB_DONE, |p| p["job_id"] == "j1")).await.expect("engine-job-done j1");
            assert_eq!(done["ok"], true);
            assert_eq!(done["result"]["n"], 7);
            assert!(f.sink.find(EV_PROGRESS, |p| p["job_id"] == "j1" && p["done"] == 1).is_some());
            let info = f.engine.info();
            assert!(info.running.is_empty() && info.queued.is_empty(), "{info:?}");
            f.engine.stop(Some(&sink)).await;
        });
    }

    #[test]
    fn fake_engine_call_timeout_cleans_pending_and_engine_survives() {
        let Some(f) = fixture(&[]) else { return };
        tauri::async_runtime::block_on(async {
            let sink = f.sink();
            let r = f.engine.call(&sink, &f.cfg, "sleep", json!({"s": 2}), Duration::from_millis(300)).await;
            assert!(matches!(r, Err(AppError::Timeout(300))), "{r:?}");
            assert!(f.engine.pending.lock().is_empty(), "逾時的請求要從 pending 移掉");
            assert_eq!(f.engine.state(), EngineState::Ready, "逾時不等於引擎死了");
            // 遲到的回覆只會被記 log；引擎仍可用（worker 忙完 sleep 才輪到 echo）
            let r = f.engine.call(&sink, &f.cfg, "echo", json!({"ok": 1}), Duration::from_secs(20)).await.unwrap();
            assert_eq!(r["ok"], 1);
            f.engine.stop(Some(&sink)).await;
        });
    }

    fn log_of(f: &Fixture) -> String {
        std::fs::read_to_string(f.cfg.log_path.as_ref().unwrap()).unwrap_or_default()
    }

    /// B-06：短呼叫排在長工作後面逾時 → Rust 要送 wire `cancel{id}`，否則 App 放棄後引擎照樣執行、拖慢下一個工作。
    /// 修正前：逾時只移掉 pending；5 秒的 stale sleep 在長工作之後照跑，下一個工作要多等 5 秒，引擎也收不到 cancel。
    #[test]
    fn fake_engine_call_timeout_cancels_the_stale_request() {
        let Some(f) = fixture(&[]) else { return };
        tauri::async_runtime::block_on(async {
            let sink = f.sink();
            f.engine.start(&sink, &f.cfg).await.unwrap();
            f.engine.start_job(sink.clone(), f.cfg.clone(), "long".into(), "sleep".into(), json!({"s": 1.5}), true).unwrap();
            wait_for(Duration::from_secs(10), || log_of(&f).contains("exec op=sleep id=long").then_some(())).await.expect("long 已在執行");
            // 引擎單一 worker 被 long 佔著：這個呼叫永遠等不到回覆
            let r = f.engine.call(&sink, &f.cfg, "sleep", json!({"s": 5, "stale": true}), Duration::from_millis(100)).await;
            assert!(matches!(r, Err(AppError::Timeout(100))), "{r:?}");
            let t_timeout = Instant::now();
            let stale_id = wait_for(Duration::from_secs(5), || {
                log_of(&f).lines().find_map(|l| l.split("recv op=sleep id=").nth(1).filter(|id| id.starts_with("c-")).map(|id| id.trim().to_string()))
            })
            .await
            .expect("引擎收到了逾時的那個呼叫");
            wait_for(Duration::from_secs(3), || log_of(&f).contains(&format!("cancel id={stale_id} found=True")).then_some(()))
                .await
                .expect("逾時後 Rust 要送 cancel{id}（引擎要認得這個 id）");
            // 下一個工作不必等 stale 的 5 秒：long 剩 ~1.4 s 跑完就輪到它
            f.engine.start_job(sink.clone(), f.cfg.clone(), "next".into(), "echo".into(), json!({"n": 2}), true).unwrap();
            let d = wait_for(Duration::from_secs(15), || f.sink.find(EV_JOB_DONE, |p| p["job_id"] == "next")).await.expect("next 的 engine-job-done");
            assert_eq!(d["ok"], true);
            let waited = t_timeout.elapsed();
            assert!(waited < Duration::from_secs(4), "下一個工作被逾時的呼叫拖住了：{waited:?}");
            let log = log_of(&f);
            assert!(!log.contains(&format!("exec op=sleep id={stale_id}")), "逾時的呼叫不能再執行：{log}");
            f.engine.stop(Some(&sink)).await;
        });
    }

    /// B-09：stop() 收到 shutdown 回覆後要等引擎自己退出（它正在取消工作、kill ffmpeg、刪 .part），不能馬上硬殺；
    /// 執行中的工作回「已取消」而不是「引擎錯誤：引擎已停止」。修正前：回覆一到就 kill（0 秒）、log 沒有 graceful exit。
    #[test]
    fn fake_engine_stop_waits_for_graceful_exit() {
        let Some(f) = fixture(&[("FAKE_SHUTDOWN_EXIT_DELAY", "1")]) else { return };
        tauri::async_runtime::block_on(async {
            let sink = f.sink();
            f.engine.start(&sink, &f.cfg).await.unwrap();
            f.engine.start_job(sink.clone(), f.cfg.clone(), "render".into(), "sleep".into(), json!({"s": 30}), true).unwrap();
            wait_for(Duration::from_secs(10), || log_of(&f).contains("exec op=sleep id=render").then_some(())).await.expect("render 已在執行");
            let t0 = Instant::now();
            f.engine.stop(Some(&sink)).await;
            let took = t0.elapsed();
            assert!(took >= Duration::from_millis(900), "引擎 1 秒後才會自己退出，stop() 不能先殺：{took:?}");
            assert!(took < Duration::from_millis(2500), "引擎退出後 stop() 要馬上回：{took:?}");
            let d = wait_for(Duration::from_secs(5), || f.sink.find(EV_JOB_DONE, |p| p["job_id"] == "render")).await.expect("render 的 engine-job-done");
            assert_eq!(d["ok"], false);
            assert_eq!(d["error"]["kind"], "Canceled", "使用者按停止＝取消，不是引擎錯誤：{d}");
            assert!(log_of(&f).contains("fake graceful exit"), "引擎要自己跑完收尾退出，而不是被殺");
            assert_eq!(f.engine.state(), EngineState::Down);
            assert!(f.engine.info().pid.is_none());
        });
    }

    /// B-09：shutdown 回了但引擎一直不退出（卡在沒有合作點的階段）→ 3 秒後照樣硬殺，工作回 Canceled；整體不超過 App 退出預算。
    #[test]
    fn fake_engine_stop_kills_engine_that_never_exits() {
        let Some(f) = fixture(&[("FAKE_SHUTDOWN_EXIT_DELAY", "60")]) else { return };
        tauri::async_runtime::block_on(async {
            let sink = f.sink();
            f.engine.start(&sink, &f.cfg).await.unwrap();
            f.engine.start_job(sink.clone(), f.cfg.clone(), "stuck".into(), "stuck".into(), json!({"s": 60}), true).unwrap();
            wait_for(Duration::from_secs(10), || log_of(&f).contains("exec op=stuck id=stuck").then_some(())).await.expect("stuck 已在執行");
            let t0 = Instant::now();
            f.engine.stop(Some(&sink)).await;
            let took = t0.elapsed();
            assert!(took >= SHUTDOWN_EXIT_WAIT - Duration::from_millis(100), "先等引擎自己退出：{took:?}");
            assert!(took < STOP_BUDGET + Duration::from_millis(300), "不能超過 App 退出預算：{took:?}");
            let d = wait_for(Duration::from_secs(5), || f.sink.find(EV_JOB_DONE, |p| p["job_id"] == "stuck")).await.expect("stuck 的 engine-job-done");
            assert_eq!(d["error"]["kind"], "Canceled", "{d}");
            assert_eq!(f.engine.state(), EngineState::Down);
            assert!(f.engine.info().pid.is_none());
            // 真的被殺掉了：waiter 看到退出、log 沒有 graceful exit
            wait_for(Duration::from_secs(5), || f.sink.states().last().is_some_and(|s| s == "down").then_some(())).await.expect("down");
            assert!(!log_of(&f).contains("fake graceful exit"));
        });
    }

    #[test]
    fn fake_engine_cancel_running_and_queued_jobs() {
        let Some(f) = fixture(&[]) else { return };
        tauri::async_runtime::block_on(async {
            let sink = f.sink();
            f.engine.start(&sink, &f.cfg).await.unwrap();
            f.engine.start_job(sink.clone(), f.cfg.clone(), "long".into(), "sleep".into(), json!({"s": 30}), true).unwrap();
            // 先等 long 真的拿到 permit 再排第二個：兩個 start_job 各 spawn 一個 task，多執行緒 runtime 不保證先 spawn 的先搶到
            // permit；echo 先搶到的話它秒跑完、long 才 running，「long 執行中＋queued 排隊中」永遠等不到（CI ubuntu 連兩次踩到）
            wait_for(Duration::from_secs(10), || (f.engine.info().running == vec!["long".to_string()]).then_some(()))
                .await
                .expect("long 拿到 GPU permit");
            f.engine.start_job(sink.clone(), f.cfg.clone(), "queued".into(), "echo".into(), json!({}), true).unwrap();
            // 第二個要等 GPU permit：前端看得到 queued（引擎裡沒有它）
            wait_for(Duration::from_secs(10), || {
                let i = f.engine.info();
                (i.running == vec!["long".to_string()] && i.queued == vec!["queued".to_string()]).then_some(())
            })
            .await
            .expect("long 執行中、queued 排隊中");
            // 取消排隊中的：不經引擎、立刻 Canceled
            f.engine.cancel(&sink, "queued").await.unwrap();
            let d = f.sink.find(EV_JOB_DONE, |p| p["job_id"] == "queued").expect("queued 的 engine-job-done");
            assert_eq!(d["error"]["kind"], "Canceled");
            // 取消執行中的：送 cancel{id}，引擎在合作點回 ok:false Canceled
            f.engine.cancel(&sink, "long").await.unwrap();
            let d = wait_for(Duration::from_secs(10), || f.sink.find(EV_JOB_DONE, |p| p["job_id"] == "long")).await.expect("long 的 engine-job-done");
            assert_eq!(d["ok"], false);
            assert_eq!(d["error"]["kind"], "Canceled");
            wait_for(Duration::from_secs(5), || f.engine.info().running.is_empty().then_some(())).await.expect("running 清空");
            // 取消不存在的 job 是 no-op
            f.engine.cancel(&sink, "ghost").await.unwrap();
            f.engine.stop(Some(&sink)).await;
        });
    }

    /// 取消落在「job 已拿到 permit、正在等引擎啟動（hello 冷機 10–40 秒）」這段：不能被吃掉。
    /// 修正前：wire cancel 排在 hello 後面 → 5 秒逾時當成功 → 引擎回 found:false → hello 完成後 job 照送、跑滿 30 秒。
    #[test]
    fn fake_engine_cancel_while_engine_is_starting_is_not_lost() {
        let Some(f) = fixture(&[("FAKE_HELLO_DELAY", "3")]) else { return };
        tauri::async_runtime::block_on(async {
            let sink = f.sink();
            f.engine.start_job(sink.clone(), f.cfg.clone(), "slow".into(), "sleep".into(), json!({"s": 30}), true).unwrap();
            // job 已是 running、引擎行程已 spawn 但 hello 還沒回
            wait_for(Duration::from_secs(10), || {
                let i = f.engine.info();
                (i.running == vec!["slow".to_string()] && i.state == EngineState::Starting && i.pid.is_some()).then_some(())
            })
            .await
            .expect("slow running、引擎 starting");
            let t0 = Instant::now();
            f.engine.cancel(&sink, "slow").await.expect("取消本身不報錯");
            assert!(t0.elapsed() < Duration::from_secs(1), "未送出的 job 取消只記旗標，不等 wire 逾時：{:?}", t0.elapsed());
            let d = wait_for(Duration::from_secs(15), || f.sink.find(EV_JOB_DONE, |p| p["job_id"] == "slow"))
                .await
                .expect("slow 的 engine-job-done（應在 hello 完成後立刻 Canceled，而不是 30 秒後跑完）");
            assert_eq!(d["ok"], false);
            assert_eq!(d["error"]["kind"], "Canceled");
            let info = f.engine.info();
            assert!(info.running.is_empty() && info.queued.is_empty(), "{info:?}");
            assert_eq!(f.engine.state(), EngineState::Ready, "取消 job 不影響引擎本身");
            // GPU permit 已放掉：下一個 job 馬上跑得到
            f.engine.start_job(sink.clone(), f.cfg.clone(), "next".into(), "echo".into(), json!({"n": 1}), true).unwrap();
            let n = wait_for(Duration::from_secs(10), || f.sink.find(EV_JOB_DONE, |p| p["job_id"] == "next")).await.expect("next 的 engine-job-done");
            assert_eq!(n["ok"], true);
            // 被取消的 job 從沒送進引擎（假引擎把收到的業務 op 印到 stderr → engine.log；stderr 是另一個讀取任務，等它寫到）
            let log_path = f.cfg.log_path.clone().unwrap();
            let log = wait_for(Duration::from_secs(5), || {
                std::fs::read_to_string(&log_path).ok().filter(|l| l.contains("recv op=echo id=next"))
            })
            .await
            .expect("前提：engine.log 有記收到的 op");
            assert!(!log.contains("id=slow"), "取消的 job 不能送進引擎：{log}");
            f.engine.stop(Some(&sink)).await;
        });
    }

    /// 取消與送出競速：請求行寫進去之後才看到旗標 → 補送 wire cancel（排在請求行之後，引擎認得 id）。
    #[test]
    fn fake_engine_cancel_flag_seen_after_send_is_forwarded() {
        let Some(f) = fixture(&[]) else { return };
        tauri::async_runtime::block_on(async {
            let sink = f.sink();
            f.engine.start(&sink, &f.cfg).await.unwrap();
            f.engine.jobs.lock().insert("race".into(), JobEntry { op: "sleep".into(), running: true, sent: false, cancel_requested: false });
            let me = f.engine.clone();
            let h = tauri::async_runtime::spawn(async move { me.run_job_request("race", "sleep", json!({"s": 30})).await });
            // 模擬「寫請求行途中按取消」：旗標在 sent 之前設好，但 run_job_request 的送出前檢查已經過了
            // （直接設旗標也涵蓋：若送出前就看到 → 直接 Canceled；兩條路都必須以 Canceled 結束、不能跑滿 30 秒）
            wait_for(Duration::from_secs(5), || f.engine.pending.lock().contains_key("race").then_some(())).await.expect("race 已登記 pending");
            let sent_already = {
                let mut jobs = f.engine.jobs.lock();
                let j = jobs.get_mut("race").unwrap();
                j.cancel_requested = true;
                j.sent
            };
            if sent_already {
                // 已標 sent：走一般取消路徑
                f.engine.send_wire_cancel("race").await.unwrap();
            }
            let r = tokio::time::timeout(Duration::from_secs(10), h).await.expect("10 秒內結束").expect("join");
            match r {
                Ok(Reply { ok: false, error: Some(e), .. }) => assert_eq!(e.kind, "Canceled"),
                Err(AppError::Canceled) => {}
                other => panic!("應該是 Canceled：{other:?}"),
            }
            f.engine.jobs.lock().remove("race");
            f.engine.stop(Some(&sink)).await;
        });
    }

    #[test]
    fn fake_engine_death_fails_pending_with_last_exception_then_restarts() {
        let Some(f) = fixture(&[]) else { return };
        tauri::async_runtime::block_on(async {
            let sink = f.sink();
            let r = f.engine.call(&sink, &f.cfg, "die", json!({}), Duration::from_secs(30)).await;
            let Err(AppError::Engine(msg)) = r else { panic!("{r:?}") };
            assert!(msg.contains("exited 3"), "{msg}");
            assert!(msg.contains("RuntimeError: boom"), "死因要含 stderr 最後一行例外：{msg}");
            wait_for(Duration::from_secs(5), || (f.engine.state() == EngineState::Down).then_some(())).await.expect("down");
            assert!(f.engine.pending.lock().is_empty());
            assert_eq!(f.engine.info().last_exc.as_deref(), Some("RuntimeError: boom"));
            assert!(f.engine.info().pid.is_none());
            let log = std::fs::read_to_string(f.cfg.log_path.as_ref().unwrap()).unwrap_or_default();
            assert!(log.contains("RuntimeError: boom"), "stderr 要附掛到 engine.log：{log}");
            // 死掉之後再呼叫會自動重啟（預算內），計 1 次重啟
            let r = f.engine.call(&sink, &f.cfg, "echo", json!({"again": true}), Duration::from_secs(30)).await.unwrap();
            assert_eq!(r["again"], true);
            assert_eq!(f.engine.info().restarts, 1);
            f.engine.stop(Some(&sink)).await;
        });
    }

    #[test]
    fn fake_engine_rejects_protocol_and_version_mismatch() {
        if let Some(f) = fixture(&[("FAKE_PROTOCOL", "2")]) {
            tauri::async_runtime::block_on(async {
                let sink = f.sink();
                let e = f.engine.start(&sink, &f.cfg).await.unwrap_err();
                assert!(e.message().contains("協定"), "{}", e.message());
                assert_eq!(f.engine.state(), EngineState::Down);
                assert!(f.engine.info().pid.is_none(), "拒絕之後要把行程殺掉");
            });
        }
        if let Some(f) = fixture(&[("FAKE_VERSION", "9.9.9")]) {
            tauri::async_runtime::block_on(async {
                let sink = f.sink();
                let e = f.engine.start(&sink, &f.cfg).await.unwrap_err();
                assert!(e.message().contains("9.9.9") && e.message().contains("重新安裝"), "{}", e.message());
                assert_eq!(f.engine.state(), EngineState::Down);
                assert!(f.engine.info().hello.is_none());
            });
        }
    }
}
