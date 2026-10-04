//! AI 助手的 CLI 後端：驅動本機 `claude`（使用者的 Claude 訂閱登入）。codex 在 `codex.rs`，兩者共用這裡的
//! 執行檔解析、串流執行器與 `claude-stream` 事件，前端不必分辨是誰在講話。承襲 ai-music-cut 的 agent.rs。
//!
//! - `-p --output-format stream-json --verbose --include-partial-messages`：NDJSON 逐行轉成 `claude-stream` 事件。
//! - `--mcp-config <workspace>/mcp.json --strict-mcp-config`：只連 App 內建的 MCP server（mcp.rs），使用者自己設定的
//!   其他 MCP server 一律不載入；`--allowedTools mcp__aivc` 只放行自家工具，`--permission-mode dontAsk` 讓清單外的
//!   一律自動拒絕（不會卡在權限提問）。
//! - 提示由 stdin 餵入（避開 Windows 命令列長度上限與引號轉義）；多輪以 `--resume <session id>` 串接。
//! - 工作目錄是 App 設定目錄下的 `agent-workspace/`，刻意沒有 CLAUDE.md（不載入使用者其他專案的記憶）。
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::commands::AppState;
use crate::error::{AppError, AppResult};
use crate::proc;

/// 解析後的 CLI 執行方式。npm 安裝的 `.cmd` shim 優先解析成底下的原生 exe（避開 `cmd /C` 的 8191 字元上限與引號地獄）。
#[derive(Debug, Clone, PartialEq)]
pub struct CliBin {
    pub program: String,
    pub prefix: Vec<String>,
    pub display: String,
}

impl CliBin {
    pub fn new(program: impl Into<String>) -> Self {
        let p = program.into();
        Self { program: p.clone(), prefix: Vec::new(), display: p }
    }

    pub fn command(&self) -> Command {
        let mut c = proc::cmd(&self.program);
        for a in &self.prefix {
            c.arg(a);
        }
        c
    }
}

/// 偵測結果（設定畫面）。
#[derive(Serialize, Debug, Clone, Default)]
pub struct CliStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub logged_in: bool,
    pub path: Option<String>,
}

/// 推送給前端的串流事件（事件名 `claude-stream`；codex 也轉成同一個形狀）。
#[derive(Clone, Serialize, Default, Debug, PartialEq)]
pub struct AgentEvent {
    pub req_id: String,
    /// "system" | "text" | "tool" | "tool_result" | "result" | "error" | "done"
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
}

impl AgentEvent {
    pub fn new(req_id: &str, kind: &str) -> Self {
        Self { req_id: req_id.to_string(), kind: kind.to_string(), ..Default::default() }
    }
}

/// 工具結果摘要給面板看的長度上限（字）。
pub const TOOL_RESULT_PREVIEW: usize = 300;

// ---------------- 執行檔解析 ----------------

/// 在 PATH 上找 `name`：Windows 優先原生 .exe，其次 npm 的 .cmd shim（交給 `shim_to_native` 換成 exe）。
pub(crate) async fn find_on_path(name: &str) -> Option<String> {
    let found = proc::which(name).await;
    let mut fallback: Option<String> = None;
    for line in found {
        let lower = line.to_lowercase();
        if cfg!(windows) {
            if lower.ends_with(".exe") {
                return Some(line);
            }
            if (lower.ends_with(".cmd") || lower.ends_with(".bat")) && fallback.is_none() {
                fallback = Some(line);
            }
        } else if fallback.is_none() {
            fallback = Some(line);
        }
    }
    fallback
}

/// npm shim 旁邊的原生 exe（純路徑運算 + 檔案存在檢查）；找不到回 None。
pub fn claude_native_beside_shim(shim: &Path) -> Option<PathBuf> {
    let dir = shim.parent()?;
    let exe = dir.join("node_modules").join("@anthropic-ai").join("claude-code").join("bin").join("claude.exe");
    exe.is_file().then_some(exe)
}

fn classify_claude(path: String) -> CliBin {
    let lower = path.to_lowercase();
    if cfg!(windows) && (lower.ends_with(".cmd") || lower.ends_with(".bat")) {
        if let Some(exe) = claude_native_beside_shim(Path::new(&path)) {
            return CliBin::new(exe.to_string_lossy().into_owned());
        }
        return CliBin { program: "cmd".to_string(), prefix: vec!["/C".to_string(), path.clone()], display: path };
    }
    CliBin::new(path)
}

/// `AIVC_CLAUDE_BIN` → PATH → `~/.local/bin/claude(.exe)`（原生安裝器的位置）。
pub async fn resolve_claude_bin() -> Option<CliBin> {
    if let Ok(p) = std::env::var("AIVC_CLAUDE_BIN") {
        if !p.trim().is_empty() {
            return Some(classify_claude(p));
        }
    }
    if let Some(p) = find_on_path("claude").await {
        return Some(classify_claude(p));
    }
    let home = proc::home_dir()?;
    let cand = home.join(".local").join("bin").join(if cfg!(windows) { "claude.exe" } else { "claude" });
    cand.exists().then(|| classify_claude(cand.to_string_lossy().into_owned()))
}

fn claude_logged_in() -> bool {
    if std::env::var("ANTHROPIC_API_KEY").map(|v| !v.trim().is_empty()).unwrap_or(false) {
        return true;
    }
    proc::home_dir().is_some_and(|h| h.join(".claude").join(".credentials.json").exists())
}

/// `<bin> --version` 的第一行（10 秒逾時）。
pub(crate) async fn cli_version(bin: &CliBin) -> Option<String> {
    let mut c = bin.command();
    c.arg("--version").stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let out = tokio::time::timeout(std::time::Duration::from_secs(10), c.output()).await.ok()?.ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
}

/// 助手工作目錄：設定目錄下，刻意沒有 CLAUDE.md / AGENTS.md（避免使用者其他專案的記憶被載入）。
pub(crate) async fn workspace_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = crate::store::app_config_dir(app)?.join("agent-workspace");
    tokio::fs::create_dir_all(&dir).await.map_err(|e| AppError::Storage(format!("建立助手工作目錄失敗：{e}")))?;
    Ok(dir)
}

// ---------------- claude：組指令 ----------------

/// `claude -p` 這一輪的選項。
#[derive(Debug, Default, Clone)]
pub struct ClaudeOpts<'a> {
    /// 有給 = agent 模式（連 App 的 MCP server、只放行自家工具）。
    pub mcp_config: Option<&'a Path>,
    pub session_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub system_prompt: Option<&'a str>,
}

/// 組 `claude` 的參數（純函式，可測）。
pub fn claude_args(o: &ClaudeOpts) -> Vec<String> {
    let mut v: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "dontAsk"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if let Some(cfg) = o.mcp_config {
        v.extend([
            "--mcp-config".to_string(),
            cfg.to_string_lossy().into_owned(),
            "--strict-mcp-config".to_string(),
            "--allowedTools".to_string(),
            format!("mcp__{}", crate::mcp::SERVER_NAME),
        ]);
    }
    if let Some(sp) = o.system_prompt.map(str::trim).filter(|s| !s.is_empty()) {
        v.extend(["--append-system-prompt".to_string(), sp.to_string()]);
    }
    if let Some(sid) = o.session_id.map(str::trim).filter(|s| !s.is_empty()) {
        v.extend(["--resume".to_string(), sid.to_string()]);
    }
    if let Some(m) = o.model.map(str::trim).filter(|s| !s.is_empty()) {
        v.extend(["--model".to_string(), m.to_string()]);
    }
    v
}

/// `--mcp-config` 的內容：只有 App 這一台（token 每次啟動都換，所以每輪重寫）。
pub fn claude_mcp_config(url: &str, token: &str) -> Value {
    serde_json::json!({
        "mcpServers": { crate::mcp::SERVER_NAME: { "type": "http", "url": url, "headers": { "Authorization": format!("Bearer {token}") } } }
    })
}

// ---------------- claude：解析串流 ----------------

fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(|x| match x.get("type").and_then(|t| t.as_str()) {
                Some("text") => x.get("text").and_then(|t| t.as_str()).map(String::from),
                Some("image") => Some("[圖]".to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

pub(crate) fn preview(s: &str) -> String {
    s.chars().take(TOOL_RESULT_PREVIEW).collect()
}

/// stream-json 的一行 → 前端事件（純函式）。外層是 system / stream_event / user / result 包裝。
pub fn parse_claude_line(req: &str, line: &str) -> Vec<AgentEvent> {
    let Ok(v) = serde_json::from_str::<Value>(line) else { return Vec::new() };
    let s = |p: &str| v.pointer(p).and_then(|x| x.as_str()).map(String::from);
    match v.get("type").and_then(|t| t.as_str()) {
        Some("system") if v.get("subtype").and_then(|x| x.as_str()) == Some("init") => {
            vec![AgentEvent { session_id: s("/session_id"), model: s("/model"), ..AgentEvent::new(req, "system") }]
        }
        Some("stream_event") => {
            let Some(ev) = v.get("event") else { return Vec::new() };
            match ev.get("type").and_then(|t| t.as_str()) {
                Some("content_block_delta") if ev.pointer("/delta/type").and_then(|t| t.as_str()) == Some("text_delta") => ev
                    .pointer("/delta/text")
                    .and_then(|t| t.as_str())
                    .map(|t| vec![AgentEvent { text: Some(t.to_string()), ..AgentEvent::new(req, "text") }])
                    .unwrap_or_default(),
                Some("content_block_start") if ev.pointer("/content_block/type").and_then(|t| t.as_str()) == Some("tool_use") => {
                    let name = ev.pointer("/content_block/name").and_then(|n| n.as_str()).unwrap_or("tool").to_string();
                    vec![AgentEvent { tool: Some(name), ..AgentEvent::new(req, "tool") }]
                }
                _ => Vec::new(),
            }
        }
        Some("user") => v
            .pointer("/message/content")
            .and_then(|c| c.as_array())
            .map(|content| {
                content
                    .iter()
                    .filter(|c| c.get("type").and_then(|t| t.as_str()) == Some("tool_result"))
                    .map(|c| AgentEvent {
                        text: Some(preview(&tool_result_text(c.get("content")))),
                        is_error: c.get("is_error").and_then(|b| b.as_bool()),
                        ..AgentEvent::new(req, "tool_result")
                    })
                    .collect()
            })
            .unwrap_or_default(),
        Some("result") => vec![AgentEvent {
            session_id: s("/session_id"),
            is_error: v.get("is_error").and_then(|b| b.as_bool()),
            text: s("/result"),
            duration_ms: v.get("duration_ms").and_then(|d| d.as_u64()),
            ..AgentEvent::new(req, "result")
        }],
        _ => Vec::new(),
    }
}

// ---------------- 共用：串流執行 ----------------

/// stderr 的尾巴給錯誤訊息用（CLI 常把一堆無關的警告印在前面）。
pub(crate) fn stderr_tail(s: &str, max_chars: usize) -> String {
    let t = s.trim();
    let n = t.chars().count();
    if n <= max_chars {
        t.to_string()
    } else {
        format!("…{}", t.chars().skip(n - max_chars).collect::<String>())
    }
}

/// 起子程序、餵 stdin、逐行解析 stdout 推事件，收尾送 `error`（非零結束碼）與 `done`。回結束碼。
///
/// 給 Tauri 指令與整合測試共用：事件往哪送由 `sink` 決定。取消＝把執行這個 future 的 task abort 掉
/// （`kill_on_drop` 會把子程序一起收掉）。
pub async fn run_streaming<P, S>(mut cmd: Command, label: &str, prompt: String, req: String, mut parse: P, sink: S) -> Option<i32>
where
    P: FnMut(&str) -> Vec<AgentEvent> + Send,
    S: Fn(AgentEvent) + Send + Sync,
{
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            sink(AgentEvent { text: Some(format!("啟動 {label} 失敗：{e}")), ..AgentEvent::new(&req, "error") });
            sink(AgentEvent { code: Some(-1), ..AgentEvent::new(&req, "done") });
            return Some(-1);
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        tokio::spawn(async move {
            let _ = stdin.write_all(prompt.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });
    }
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");
    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = BufReader::new(stderr).read_to_string(&mut s).await;
        s
    });
    // 不用 lines()：CLI 的輸出理論上是 UTF-8，但萬一夾到別的編碼，lines() 會回 Err 讓迴圈提早結束（管線塞滿 → 卡死）
    let mut rd = BufReader::new(stdout);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match rd.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                let line = line.trim();
                if !line.is_empty() {
                    for ev in parse(line) {
                        sink(ev);
                    }
                }
            }
        }
    }
    let status = child.wait().await;
    let err = err_task.await.unwrap_or_default();
    let code = status.ok().and_then(|s| s.code());
    if let Some(c) = code.filter(|c| *c != 0) {
        let tail = stderr_tail(&err, 800);
        let msg = if tail.is_empty() { format!("{label} 以結束碼 {c} 退出") } else { tail };
        sink(AgentEvent { text: Some(msg), ..AgentEvent::new(&req, "error") });
    }
    sink(AgentEvent { code, ..AgentEvent::new(&req, "done") });
    code
}

fn emitter(app: &AppHandle) -> impl Fn(AgentEvent) + Send + Sync + 'static {
    let app = app.clone();
    move |ev: AgentEvent| {
        let _ = app.emit("claude-stream", ev);
    }
}

/// 把一個串流工作掛到 `agent_jobs`（同 req_id 的舊工作先停掉），結束時自己摘掉。
pub(crate) fn spawn_job<F>(state: &AppState, req_id: String, fut: F)
where
    F: std::future::Future<Output = Option<i32>> + Send + 'static,
{
    if let Some(h) = state.agent_jobs.lock().remove(&req_id) {
        h.abort();
    }
    let jobs = state.agent_jobs.clone();
    let req2 = req_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let _ = fut.await;
        jobs.lock().remove(&req2);
    });
    state.agent_jobs.lock().insert(req_id, handle);
}

// ---------------- commands ----------------

#[tauri::command]
pub async fn claude_detect() -> CliStatus {
    match resolve_claude_bin().await {
        Some(bin) => {
            let version = cli_version(&bin).await;
            CliStatus { installed: version.is_some(), version, logged_in: claude_logged_in(), path: Some(bin.display) }
        }
        None => CliStatus { installed: false, version: None, logged_in: claude_logged_in(), path: None },
    }
}

/// 助手送出一次問答（多輪以 session_id + `--resume` 串接）。model 空＝用設定的 `claude_model`，再空＝claude 自己的預設。
#[tauri::command]
pub async fn claude_send(
    app: AppHandle,
    state: State<'_, AppState>,
    req_id: String,
    prompt: String,
    session_id: Option<String>,
    model: Option<String>,
    system_prompt: Option<String>,
) -> AppResult<()> {
    let bin = resolve_claude_bin().await.ok_or_else(|| AppError::Agent("找不到 claude CLI，請先安裝 Claude Code 並登入".into()))?;
    let workspace = workspace_dir(&app).await?;
    let mcp = state.mcp.clone();
    if mcp.port() == 0 {
        return Err(AppError::Agent("App 內建的 MCP server 沒有啟動，助手連不到工具".into()));
    }
    let cfg_path = workspace.join("mcp.json");
    let cfg = claude_mcp_config(&mcp.url(), &mcp.token);
    tokio::fs::write(&cfg_path, serde_json::to_vec(&cfg).unwrap_or_default()).await?;
    let model = model.filter(|m| !m.trim().is_empty()).or_else(|| Some(state.settings.read().claude_model.clone()));
    let args = claude_args(&ClaudeOpts {
        mcp_config: Some(&cfg_path),
        session_id: session_id.as_deref(),
        model: model.as_deref(),
        system_prompt: system_prompt.as_deref(),
    });
    let mut cmd = bin.command();
    cmd.args(&args).current_dir(&workspace);
    let req = req_id.clone();
    let sink = emitter(&app);
    spawn_job(&state, req_id, async move {
        let r2 = req.clone();
        run_streaming(cmd, "claude", prompt, req, move |line| parse_claude_line(&r2, line), sink).await
    });
    Ok(())
}

/// 停掉一個助手工作（claude 或 codex 都是這一支）。子程序隨 task 一起收掉。
#[tauri::command]
pub async fn claude_cancel(state: State<'_, AppState>, req_id: String) -> AppResult<()> {
    if let Some(h) = state.agent_jobs.lock().remove(&req_id) {
        h.abort();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_args_connect_only_our_mcp_server() {
        let cfg = PathBuf::from("C:/ws/mcp.json");
        let a = claude_args(&ClaudeOpts { mcp_config: Some(&cfg), session_id: Some("s-1"), model: Some("sonnet"), system_prompt: Some("狀態：…") });
        let at = |flag: &str| a.iter().position(|x| x == flag).map(|i| a[i + 1].clone());
        assert_eq!(&a[..2], ["-p", "--output-format"]);
        assert_eq!(at("--output-format").as_deref(), Some("stream-json"));
        assert!(a.contains(&"--verbose".to_string()) && a.contains(&"--include-partial-messages".to_string()));
        assert_eq!(at("--permission-mode").as_deref(), Some("dontAsk"));
        assert_eq!(at("--mcp-config").as_deref(), Some("C:/ws/mcp.json"));
        assert!(a.contains(&"--strict-mcp-config".to_string()), "使用者自己的 MCP server 不能載入");
        assert_eq!(at("--allowedTools").as_deref(), Some("mcp__aivc"));
        assert_eq!(at("--resume").as_deref(), Some("s-1"));
        assert_eq!(at("--model").as_deref(), Some("sonnet"));
        assert_eq!(at("--append-system-prompt").as_deref(), Some("狀態：…"));
        // 提示走 stdin，不在命令列上
        assert!(!a.iter().any(|x| x.contains("請幫我")));
    }

    #[test]
    fn empty_optionals_send_no_flags() {
        let a = claude_args(&ClaudeOpts { mcp_config: None, session_id: Some(" "), model: Some(""), system_prompt: Some("  ") });
        for f in ["--resume", "--model", "--append-system-prompt", "--mcp-config", "--allowedTools"] {
            assert!(!a.contains(&f.to_string()), "{f}");
        }
    }

    #[test]
    fn mcp_config_points_at_the_app_with_bearer() {
        let c = claude_mcp_config("http://127.0.0.1:9/mcp", "abc");
        assert_eq!(c["mcpServers"]["aivc"]["type"], "http");
        assert_eq!(c["mcpServers"]["aivc"]["url"], "http://127.0.0.1:9/mcp");
        assert_eq!(c["mcpServers"]["aivc"]["headers"]["Authorization"], "Bearer abc");
    }

    #[test]
    fn parses_stream_json_lines() {
        let init = parse_claude_line("r", r#"{"type":"system","subtype":"init","session_id":"S","model":"claude-x","tools":[]}"#);
        assert_eq!(init, vec![AgentEvent { session_id: Some("S".into()), model: Some("claude-x".into()), ..AgentEvent::new("r", "system") }]);

        let delta = parse_claude_line("r", r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}}"#);
        assert_eq!(delta[0].kind, "text");
        assert_eq!(delta[0].text.as_deref(), Some("你好"));

        // thinking / input_json 的 delta 不是給人看的字
        assert!(parse_claude_line("r", r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{"}}}"#).is_empty());

        let tool = parse_claude_line("r", r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp__aivc__seek_to","id":"t1"}}}"#);
        assert_eq!(tool[0].tool.as_deref(), Some("mcp__aivc__seek_to"));

        let long = "字".repeat(500);
        let tr = parse_claude_line(
            "r",
            &serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"text","text":long},{"type":"image","source":{}}],"is_error":true}]}}).to_string(),
        );
        assert_eq!(tr[0].kind, "tool_result");
        assert_eq!(tr[0].text.as_ref().unwrap().chars().count(), TOOL_RESULT_PREVIEW, "工具結果截短");
        assert_eq!(tr[0].is_error, Some(true));
        let img = parse_claude_line("r", r#"{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"text","text":"ok"},{"type":"image"}]}]}}"#);
        assert_eq!(img[0].text.as_deref(), Some("ok\n[圖]"));

        let res = parse_claude_line("r", r#"{"type":"result","subtype":"success","is_error":false,"result":"完成","session_id":"S","duration_ms":1234}"#);
        assert_eq!(res[0], AgentEvent { session_id: Some("S".into()), is_error: Some(false), text: Some("完成".into()), duration_ms: Some(1234), ..AgentEvent::new("r", "result") });

        assert!(parse_claude_line("r", "not json").is_empty());
        assert!(parse_claude_line("r", r#"{"type":"assistant","message":{}}"#).is_empty(), "完整訊息已經由 delta 送過，不重複");
    }

    #[test]
    fn stderr_tail_keeps_the_end() {
        assert_eq!(stderr_tail("  abc \n", 10), "abc");
        assert_eq!(stderr_tail("0123456789", 4), "…6789");
    }

    #[test]
    fn shim_resolution_needs_the_native_exe() {
        let d = std::env::temp_dir().join(format!("aivc-shim-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        let shim = d.join("claude.cmd");
        assert!(claude_native_beside_shim(&shim).is_none());
        let exe = d.join("node_modules").join("@anthropic-ai").join("claude-code").join("bin").join("claude.exe");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"").unwrap();
        assert_eq!(claude_native_beside_shim(&shim), Some(exe));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 執行器本身：用一個會印兩行再以非零結束的子程序，確認事件順序（解析 → error → done）。
    #[tokio::test]
    async fn run_streaming_reports_lines_then_error_then_done() {
        let (prog, args): (&str, Vec<&str>) = if cfg!(windows) {
            ("cmd", vec!["/C", "echo one& echo two& echo boom 1>&2& exit 3"])
        } else {
            ("sh", vec!["-c", "echo one; echo two; echo boom >&2; exit 3"])
        };
        let mut cmd = proc::cmd(prog);
        cmd.args(&args);
        let got = std::sync::Arc::new(parking_lot::Mutex::new(Vec::<AgentEvent>::new()));
        let g2 = got.clone();
        let code = run_streaming(
            cmd,
            "test",
            String::new(),
            "r".into(),
            |line| vec![AgentEvent { text: Some(line.to_string()), ..AgentEvent::new("r", "text") }],
            move |e| g2.lock().push(e),
        )
        .await;
        assert_eq!(code, Some(3));
        let ev = got.lock().clone();
        let kinds: Vec<&str> = ev.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["text", "text", "error", "done"]);
        assert_eq!(ev[0].text.as_deref(), Some("one"));
        assert!(ev[2].text.as_deref().unwrap().contains("boom"));
        assert_eq!(ev[3].code, Some(3));
    }
}
