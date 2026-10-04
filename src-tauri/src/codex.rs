//! Codex CLI 後端（`codex exec`）：兩種用法。
//!
//! 1. **助手（工具迴圈）**：`codex exec --json --sandbox read-only --skip-git-repo-check` 加上幾個 `-c` 覆寫，
//!    **只在這一次執行**把 App 的 MCP server 登記進去 —— 不碰使用者的 `~/.codex/config.toml`：
//!    - `mcp_servers.aivc.url="http://127.0.0.1:<port>/mcp"`
//!    - `mcp_servers.aivc.bearer_token_env_var="AIVC_MCP_TOKEN"`（token 走子程序的環境變數，不上命令列）
//!    - `mcp_servers.aivc.tool_timeout_sec=…`（codex 預設 60 秒，追蹤／輸出這類長工具不夠）
//!    - `mcp_servers.aivc.default_tools_approval_mode="approve"`（exec 沒有人可以回答 codex 自己的核准提問；
//!      會改東西的工具由 **App** 問使用者，見前端 assistant/mcpBridge.ts）
//!
//!    鍵名對照 codex-cli 0.160.0：`codex mcp add --url … --bearer-token-env-var …` 寫進 config.toml 的就是這兩個鍵，
//!    執行檔裡的設定結構也列著 `tool_timeout_sec`、`default_tools_approval_mode`（auto｜prompt｜writes｜approve）。
//!    `--json` 的 JSONL 事件（thread.started / item.* / turn.*）轉成跟 claude 一樣的 `claude-stream` 事件；
//!    多輪用 `codex exec resume <thread id> -` 接（resume 不吃 `--sandbox`，改用 `-c sandbox_mode=…`）。
//! 2. **結構化產出**（App 主導的「提案 → 驗收」迴圈用）：`--output-schema <file> -o <file> -i <圖>…`，
//!    零工具、結果從 `-o` 的檔案讀（stdout 混著事件流，硬撈容易撿到別的 JSON）。
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde_json::Value;
use tauri::{AppHandle, State};
use tokio::io::AsyncWriteExt;

use crate::agent::{self, AgentEvent, CliBin, CliStatus};
use crate::commands::AppState;
use crate::error::{AppError, AppResult};
use crate::mcp;

/// 助手模式給 codex 的工具逾時（秒）：App 這邊自己有每支工具的逾時，codex 不要比它先放棄。
pub const AGENT_TOOL_TIMEOUT_SECS: u64 = mcp::MAX_TOOL_TIMEOUT_SECS;

// ---------------- 執行檔解析 ----------------

/// npm shim 旁邊的原生 exe（`@openai/codex` 依平台裝的那一包）。
pub fn codex_native_beside_shim(shim: &Path) -> Option<PathBuf> {
    let dir = shim.parent()?;
    let base = dir.join("node_modules").join("@openai").join("codex");
    let candidates = [
        base.join("node_modules").join("@openai").join("codex-win32-x64").join("vendor").join("x86_64-pc-windows-msvc").join("bin").join("codex.exe"),
        base.join("node_modules").join("@openai").join("codex-win32-arm64").join("vendor").join("aarch64-pc-windows-msvc").join("bin").join("codex.exe"),
        base.join("vendor").join("x86_64-pc-windows-msvc").join("bin").join("codex.exe"),
        base.join("vendor").join("aarch64-pc-windows-msvc").join("bin").join("codex.exe"),
        base.join("vendor").join("x86_64-pc-windows-msvc").join("codex").join("codex.exe"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

fn classify(path: String) -> CliBin {
    let lower = path.to_lowercase();
    if cfg!(windows) && (lower.ends_with(".cmd") || lower.ends_with(".bat")) {
        // npm shim：`cmd /C` 會把 `-c key="value"` 的引號吃掉，所以一定先找底下的原生 exe，
        // 其次用 node 直接跑 codex.js（node 的參數解析不經過 cmd），最後才退回 cmd /C。
        if let Some(exe) = codex_native_beside_shim(Path::new(&path)) {
            return CliBin::new(exe.to_string_lossy().into_owned());
        }
        if let Some(js) = Path::new(&path).parent().map(|d| d.join("node_modules").join("@openai").join("codex").join("bin").join("codex.js")).filter(|p| p.is_file()) {
            return CliBin { program: "node".into(), prefix: vec![js.to_string_lossy().into_owned()], display: path };
        }
        return CliBin { program: "cmd".to_string(), prefix: vec!["/C".to_string(), path.clone()], display: path };
    }
    CliBin::new(path)
}

pub async fn resolve_codex_bin() -> Option<CliBin> {
    if let Ok(p) = std::env::var("AIVC_CODEX_BIN") {
        if !p.trim().is_empty() {
            return Some(classify(p));
        }
    }
    agent::find_on_path("codex").await.map(classify)
}

/// `codex login status`：結束碼 0 = 有登入（ChatGPT 或 API key）。只讀本機的 auth.json，不連網。
async fn codex_logged_in(bin: &CliBin) -> bool {
    let mut c = bin.command();
    c.args(["login", "status"]).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    matches!(tokio::time::timeout(std::time::Duration::from_secs(10), c.output()).await, Ok(Ok(o)) if o.status.success())
}

// ---------------- 組指令 ----------------

/// 助手模式這一輪的選項。
#[derive(Debug, Default, Clone)]
pub struct AgentOpts<'a> {
    /// App 的 MCP URL（`http://127.0.0.1:<port>/mcp`）。
    pub mcp_url: &'a str,
    /// 接續的 thread id；有給就走 `exec resume`。
    pub session_id: Option<&'a str>,
    pub model: Option<&'a str>,
    /// 附在提示上的圖（`-i`）。
    pub images: &'a [String],
}

/// TOML 字串（`-c` 的值會先被當成 TOML 解析）。
pub fn toml_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\""))
}

/// 只在這次執行把 App 的 MCP server 登記進去的 `-c` 覆寫。
pub fn mcp_overrides(url: &str) -> Vec<String> {
    let n = mcp::SERVER_NAME;
    [
        format!("mcp_servers.{n}.url={}", toml_str(url)),
        format!("mcp_servers.{n}.bearer_token_env_var={}", toml_str(mcp::TOKEN_ENV)),
        format!("mcp_servers.{n}.tool_timeout_sec={AGENT_TOOL_TIMEOUT_SECS}"),
        format!("mcp_servers.{n}.default_tools_approval_mode={}", toml_str("approve")),
    ]
    .into_iter()
    .flat_map(|kv| ["-c".to_string(), kv])
    .collect()
}

/// 組助手模式的參數（純函式，可測）。提示走 stdin：新對話不給位置參數（codex 會讀 stdin），
/// resume 要明確給 `-`。
pub fn agent_args(o: &AgentOpts) -> Vec<String> {
    let mut v: Vec<String> = vec!["exec".into()];
    let resume = o.session_id.map(str::trim).filter(|s| !s.is_empty());
    if resume.is_some() {
        v.push("resume".into());
    }
    v.extend(["--json".to_string(), "--skip-git-repo-check".to_string()]);
    if resume.is_some() {
        v.extend(["-c".to_string(), format!("sandbox_mode={}", toml_str("read-only"))]);
    } else {
        v.extend(["--sandbox".to_string(), "read-only".to_string()]);
    }
    v.extend(mcp_overrides(o.mcp_url));
    if let Some(m) = o.model.map(str::trim).filter(|s| !s.is_empty()) {
        v.extend(["-m".to_string(), m.to_string()]);
    }
    for img in o.images {
        v.extend(["-i".to_string(), img.clone()]);
    }
    if let Some(sid) = resume {
        v.extend([sid.to_string(), "-".to_string()]);
    }
    v
}

/// 結構化產出的參數。`-i` 每張各自帶旗標（它吃多個值，接在後面的位置參數會被當成圖）。
pub fn structured_args(schema_path: &Path, out_path: &Path, model: Option<&str>, images: &[String]) -> Vec<String> {
    let mut v: Vec<String> = ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral"].iter().map(|s| s.to_string()).collect();
    for img in images {
        v.extend(["-i".to_string(), img.clone()]);
    }
    v.extend([
        "--output-schema".to_string(),
        schema_path.to_string_lossy().into_owned(),
        "-o".to_string(),
        out_path.to_string_lossy().into_owned(),
    ]);
    if let Some(m) = model.map(str::trim).filter(|s| !s.is_empty()) {
        v.extend(["-m".to_string(), m.to_string()]);
    }
    v
}

/// codex 沒有 `--append-system-prompt`：系統提示接在使用者提示前面一起送進 stdin。
pub fn compose_prompt(system_prompt: Option<&str>, prompt: &str) -> String {
    match system_prompt.map(str::trim).filter(|s| !s.is_empty()) {
        Some(sp) => format!("{sp}\n\n---\n\n{prompt}"),
        None => prompt.to_string(),
    }
}

// ---------------- 解析 JSONL ----------------

/// `codex exec --json` 的事件 → `claude-stream` 事件。有狀態：要記 thread id（`turn.completed` 不帶）與開始時間。
#[derive(Debug)]
pub struct CodexParser {
    req: String,
    session_id: Option<String>,
    started: std::time::Instant,
    /// 這一輪已經送過幾則 agent_message（第二則起前面補空行）。
    messages: usize,
    last_message: String,
}

impl CodexParser {
    pub fn new(req: &str, session_id: Option<String>) -> Self {
        Self { req: req.to_string(), session_id, started: std::time::Instant::now(), messages: 0, last_message: String::new() }
    }

    fn ev(&self, kind: &str) -> AgentEvent {
        AgentEvent::new(&self.req, kind)
    }

    pub fn parse(&mut self, line: &str) -> Vec<AgentEvent> {
        let Ok(v) = serde_json::from_str::<Value>(line) else { return Vec::new() };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("thread.started") => {
                self.session_id = v.get("thread_id").and_then(|s| s.as_str()).map(String::from).or(self.session_id.take());
                vec![AgentEvent { session_id: self.session_id.clone(), ..self.ev("system") }]
            }
            Some("item.started") => self.item(v.get("item"), false),
            Some("item.completed") => self.item(v.get("item"), true),
            Some("turn.completed") => vec![AgentEvent {
                session_id: self.session_id.clone(),
                is_error: Some(false),
                text: Some(self.last_message.clone()),
                duration_ms: Some(self.started.elapsed().as_millis() as u64),
                ..self.ev("result")
            }],
            Some("turn.failed") => {
                let msg = v.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("codex 這一輪失敗").to_string();
                vec![
                    AgentEvent { text: Some(msg.clone()), ..self.ev("error") },
                    AgentEvent {
                        session_id: self.session_id.clone(),
                        is_error: Some(true),
                        text: Some(msg),
                        duration_ms: Some(self.started.elapsed().as_millis() as u64),
                        ..self.ev("result")
                    },
                ]
            }
            Some("error") => {
                let msg = v.get("message").and_then(|m| m.as_str()).unwrap_or("codex 錯誤").to_string();
                vec![AgentEvent { text: Some(msg), ..self.ev("error") }]
            }
            _ => Vec::new(),
        }
    }

    fn item(&mut self, item: Option<&Value>, done: bool) -> Vec<AgentEvent> {
        let Some(it) = item else { return Vec::new() };
        let s = |k: &str| it.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        match it.get("type").and_then(|t| t.as_str()) {
            Some("agent_message") if done => {
                let text = s("text");
                if text.trim().is_empty() {
                    return Vec::new();
                }
                let out = if self.messages > 0 { format!("\n\n{text}") } else { text.clone() };
                self.messages += 1;
                self.last_message = text;
                vec![AgentEvent { text: Some(out), ..self.ev("text") }]
            }
            Some("mcp_tool_call") => {
                // 跟 claude 一樣的全名，前端只要一種剝前綴的寫法
                let name = format!("mcp__{}__{}", s("server"), s("tool"));
                if !done {
                    return vec![AgentEvent { tool: Some(name), ..self.ev("tool") }];
                }
                let err = it.get("error").filter(|e| !e.is_null());
                let failed = err.is_some() || s("status") == "failed" || it.pointer("/result/is_error").and_then(|b| b.as_bool()) == Some(true);
                let text = match err {
                    Some(e) => e.get("message").and_then(|m| m.as_str()).map(String::from).unwrap_or_else(|| e.to_string()),
                    None => mcp_result_text(it.get("result")),
                };
                vec![AgentEvent { text: Some(agent::preview(&text)), is_error: Some(failed), ..self.ev("tool_result") }]
            }
            Some("command_execution") => {
                if !done {
                    return vec![AgentEvent { tool: Some(format!("shell: {}", s("command"))), ..self.ev("tool") }];
                }
                let failed = it.get("exit_code").and_then(|c| c.as_i64()).is_some_and(|c| c != 0) || s("status") == "failed";
                vec![AgentEvent { text: Some(agent::preview(&s("aggregated_output"))), is_error: Some(failed), ..self.ev("tool_result") }]
            }
            Some("error") if done => vec![AgentEvent { text: Some(s("message")), ..self.ev("error") }],
            _ => Vec::new(),
        }
    }
}

/// MCP 工具結果（`{content:[…]}`）→ 摘要文字；圖寫成 `[圖]`。
fn mcp_result_text(result: Option<&Value>) -> String {
    let Some(r) = result else { return String::new() };
    match r.get("content").and_then(|c| c.as_array()) {
        Some(arr) => arr
            .iter()
            .filter_map(|x| match x.get("type").and_then(|t| t.as_str()) {
                Some("text") => x.get("text").and_then(|t| t.as_str()).map(String::from),
                Some("image") => Some("[圖]".to_string()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        None => r.to_string(),
    }
}

/// 把 `-o` 寫出來的那份最後訊息解析成 JSON（容忍 ```json 圍欄與前後多一句話）。
pub fn parse_last_message(text: &str) -> Option<Value> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        return Some(v);
    }
    let stripped = t.trim_start_matches("```json").trim_start_matches("```JSON").trim_start_matches("```").trim_end_matches("```").trim();
    serde_json::from_str::<Value>(stripped).ok().or_else(|| {
        let s = t.find('{')?;
        let e = t.rfind('}')?;
        if e > s {
            serde_json::from_str::<Value>(&t[s..=e]).ok()
        } else {
            None
        }
    })
}

/// 附圖只收 App 資料／快取目錄底下的 PNG（跟 MCP 工具結果的圖同一條規則）。
fn checked_images(state: &AppState, images: Option<Vec<String>>) -> AppResult<Vec<String>> {
    let roots = state.mcp.image_roots();
    images
        .unwrap_or_default()
        .into_iter()
        .map(|p| mcp::image_allowed(Path::new(&p), &roots).map(|c| c.to_string_lossy().into_owned()).map_err(|why| AppError::Invalid(format!("{p}：{why}"))))
        .collect()
}

// ---------------- commands ----------------

#[tauri::command]
pub async fn codex_detect() -> CliStatus {
    let Some(bin) = resolve_codex_bin().await else {
        return CliStatus::default();
    };
    let version = agent::cli_version(&bin).await;
    let logged_in = version.is_some() && codex_logged_in(&bin).await;
    CliStatus { installed: version.is_some(), version, logged_in, path: Some(bin.display) }
}

/// 助手送出一次問答（codex）。事件與 claude 相同（`claude-stream`）；取消用 `claude_cancel`。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn codex_send(
    app: AppHandle,
    state: State<'_, AppState>,
    req_id: String,
    prompt: String,
    session_id: Option<String>,
    model: Option<String>,
    system_prompt: Option<String>,
    images: Option<Vec<String>>,
) -> AppResult<()> {
    let bin = resolve_codex_bin().await.ok_or_else(|| AppError::Agent("找不到 codex CLI。安裝：npm i -g @openai/codex，然後執行 codex login".into()))?;
    let mcp_bridge = state.mcp.clone();
    if mcp_bridge.port() == 0 {
        return Err(AppError::Agent("App 內建的 MCP server 沒有啟動，助手連不到工具".into()));
    }
    let images = checked_images(&state, images)?;
    let workspace = agent::workspace_dir(&app).await?;
    let model = model.filter(|m| !m.trim().is_empty()).or_else(|| Some(state.settings.read().codex_model.clone()));
    let url = mcp_bridge.url();
    let args = agent_args(&AgentOpts { mcp_url: &url, session_id: session_id.as_deref(), model: model.as_deref(), images: &images });
    let mut cmd = bin.command();
    cmd.args(&args).current_dir(&workspace).env(mcp::TOKEN_ENV, &mcp_bridge.token);
    let full = compose_prompt(system_prompt.as_deref(), &prompt);
    let req = req_id.clone();
    let app2 = app.clone();
    agent::spawn_job(&state, req_id, async move {
        let mut parser = CodexParser::new(&req, session_id.filter(|s| !s.trim().is_empty()));
        let sink = move |ev: AgentEvent| {
            use tauri::Emitter;
            let _ = app2.emit("claude-stream", ev);
        };
        agent::run_streaming(cmd, "codex", full, req, move |line| parser.parse(line), sink).await
    });
    Ok(())
}

/// 結構化產出：給 schema（OpenAI 的嚴格模式：每個物件都要 `additionalProperties:false`、屬性全列進 required）、
/// 可以附圖，回一份符合 schema 的 JSON。零工具、一次回合 —— App 自己主導「提案 → 執行 → 截圖驗收 → 再提案」。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn codex_structured(
    app: AppHandle,
    state: State<'_, AppState>,
    prompt: String,
    schema: Value,
    model: Option<String>,
    system_prompt: Option<String>,
    images: Option<Vec<String>>,
    timeout_ms: Option<u64>,
) -> AppResult<Value> {
    let bin = resolve_codex_bin().await.ok_or_else(|| AppError::Agent("找不到 codex CLI。安裝：npm i -g @openai/codex，然後執行 codex login".into()))?;
    let images = checked_images(&state, images)?;
    let workspace = agent::workspace_dir(&app).await?;
    let model = model.filter(|m| !m.trim().is_empty()).or_else(|| Some(state.settings.read().codex_model.clone()));
    let full = compose_prompt(system_prompt.as_deref(), &prompt);
    structured(&bin, &workspace, full, &schema, model.as_deref(), &images, timeout_ms.unwrap_or(240_000)).await
}

/// 結構化產出的本體（不碰 Tauri，整合測試也用）。
pub async fn structured(bin: &CliBin, workspace: &Path, prompt: String, schema: &Value, model: Option<&str>, images: &[String], timeout_ms: u64) -> AppResult<Value> {
    let dir = std::env::temp_dir().join(format!("aivc-codex-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.map_err(|e| AppError::Io(format!("建立暫存資料夾失敗：{e}")))?;
    let schema_path = dir.join("schema.json");
    let out_path = dir.join("out.txt");
    tokio::fs::write(&schema_path, serde_json::to_vec(schema).unwrap_or_default()).await.map_err(|e| AppError::Io(format!("寫入 schema 失敗：{e}")))?;

    let mut cmd = bin.command();
    cmd.args(structured_args(&schema_path, &out_path, model, images))
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let result = async {
        let mut child = cmd.spawn().map_err(|e| AppError::Agent(format!("啟動 codex 失敗：{e}")))?;
        if let Some(mut stdin) = child.stdin.take() {
            tokio::spawn(async move {
                let _ = stdin.write_all(prompt.as_bytes()).await;
                let _ = stdin.shutdown().await;
            });
        }
        let timeout = std::time::Duration::from_millis(timeout_ms);
        let out = match tokio::time::timeout(timeout, child.wait_with_output()).await {
            Ok(r) => r.map_err(|e| AppError::Agent(format!("codex 執行失敗：{e}")))?,
            Err(_) => return Err(AppError::Timeout(timeout_ms)),
        };
        let last = tokio::fs::read_to_string(&out_path).await.unwrap_or_default();
        if let Some(v) = parse_last_message(&last) {
            return Ok(v);
        }
        if !out.status.success() {
            // stdout 是事件流：turn.failed / error 的訊息比 stderr 的雜訊（技能載入警告…）有用
            let stdout = String::from_utf8_lossy(&out.stdout);
            let mut p = CodexParser::new("", None);
            let errs: Vec<String> = stdout.lines().flat_map(|l| p.parse(l)).filter(|e| e.kind == "error").filter_map(|e| e.text).collect();
            let msg = if errs.is_empty() { agent::stderr_tail(&String::from_utf8_lossy(&out.stderr), 400) } else { errs.join("；") };
            return Err(AppError::Agent(if msg.is_empty() { format!("codex 以結束碼 {:?} 退出", out.status.code()) } else { msg }));
        }
        Err(AppError::Agent("codex 沒有回出符合 schema 的 JSON".into()))
    }
    .await;
    let _ = tokio::fs::remove_dir_all(&dir).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn after<'a>(a: &'a [String], flag: &str) -> Vec<&'a str> {
        a.windows(2).filter(|w| w[0] == flag).map(|w| w[1].as_str()).collect()
    }

    #[test]
    fn agent_args_register_our_mcp_server_for_this_run_only() {
        let a = agent_args(&AgentOpts { mcp_url: "http://127.0.0.1:4567/mcp", session_id: None, model: Some("gpt-5.5"), images: &[] });
        assert_eq!(&a[..3], ["exec", "--json", "--skip-git-repo-check"]);
        assert_eq!(after(&a, "--sandbox"), ["read-only"]);
        let cs = after(&a, "-c");
        assert!(cs.contains(&"mcp_servers.aivc.url=\"http://127.0.0.1:4567/mcp\""), "{cs:?}");
        assert!(cs.contains(&"mcp_servers.aivc.bearer_token_env_var=\"AIVC_MCP_TOKEN\""), "{cs:?}");
        assert!(cs.contains(&"mcp_servers.aivc.tool_timeout_sec=3600"), "{cs:?}");
        assert!(cs.contains(&"mcp_servers.aivc.default_tools_approval_mode=\"approve\""), "{cs:?}");
        assert_eq!(after(&a, "-m"), ["gpt-5.5"]);
        // token 不上命令列（走環境變數）；新對話不給位置參數（提示讀 stdin）
        assert!(!a.iter().any(|x| x.contains("Bearer")));
        assert_ne!(a.last().map(String::as_str), Some("-"));
        assert!(!a.contains(&"resume".to_string()));
    }

    #[test]
    fn resume_uses_thread_id_stdin_and_config_sandbox() {
        let imgs = vec!["C:/cache/f.png".to_string()];
        let a = agent_args(&AgentOpts { mcp_url: "u", session_id: Some("T-1"), model: None, images: &imgs });
        assert_eq!(&a[..2], ["exec", "resume"]);
        assert!(!a.contains(&"--sandbox".to_string()), "resume 不吃 --sandbox");
        assert!(after(&a, "-c").contains(&"sandbox_mode=\"read-only\""));
        assert_eq!(after(&a, "-i"), ["C:/cache/f.png"]);
        assert_eq!(&a[a.len() - 2..], ["T-1", "-"]);
        assert!(!a.contains(&"-m".to_string()));
    }

    #[test]
    fn toml_strings_are_escaped() {
        assert_eq!(toml_str("a\"b\\c"), "\"a\\\"b\\\\c\"");
    }

    #[test]
    fn structured_args_read_result_from_file_and_attach_each_image() {
        let imgs = vec!["a.png".to_string(), "b.png".to_string()];
        let a = structured_args(Path::new("/tmp/s.json"), Path::new("/tmp/o.txt"), Some("m1"), &imgs);
        assert_eq!(after(&a, "--output-schema"), ["/tmp/s.json"]);
        assert_eq!(after(&a, "-o"), ["/tmp/o.txt"]);
        assert_eq!(after(&a, "-i"), ["a.png", "b.png"]);
        assert_eq!(after(&a, "--sandbox"), ["read-only"]);
        assert_eq!(after(&a, "-m"), ["m1"]);
        assert!(a.contains(&"--skip-git-repo-check".to_string()) && a.contains(&"--ephemeral".to_string()));
        // `-i` 吃多個值：後面不能接任何位置參數
        let last_i = a.iter().rposition(|x| x == "-i").unwrap();
        assert!(a[last_i + 2].starts_with("--"));
        let none = structured_args(Path::new("s"), Path::new("o"), Some("  "), &[]);
        assert!(!none.contains(&"-m".to_string()) && !none.contains(&"-i".to_string()));
    }

    #[test]
    fn system_prompt_goes_before_the_question() {
        assert_eq!(compose_prompt(Some("你是助手"), "幫我"), "你是助手\n\n---\n\n幫我");
        assert_eq!(compose_prompt(Some("  "), "幫我"), "幫我");
        assert_eq!(compose_prompt(None, "幫我"), "幫我");
    }

    #[test]
    fn parses_codex_jsonl_into_claude_stream_events() {
        let mut p = CodexParser::new("r", None);
        let lines = [
            r#"{"type":"thread.started","thread_id":"T-9"}"#,
            r#"{"type":"turn.started"}"#,
            r#"{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"想一下"}}"#,
            r#"{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"aivc","tool":"view_frame","arguments":{"frame":3},"status":"in_progress"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"aivc","tool":"view_frame","arguments":{"frame":3},"result":{"content":[{"type":"text","text":"ok"},{"type":"image","data":"xx","mimeType":"image/png"}]},"status":"completed"}}"#,
            r#"{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"dir","status":"in_progress"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"dir","aggregated_output":"x","exit_code":1,"status":"failed"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"第一段"}}"#,
            r#"{"type":"item.completed","item":{"id":"item_4","type":"agent_message","text":"第二段"}}"#,
            r#"{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}"#,
        ];
        let ev: Vec<AgentEvent> = lines.iter().flat_map(|l| p.parse(l)).collect();
        let kinds: Vec<&str> = ev.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["system", "tool", "tool_result", "tool", "tool_result", "text", "text", "result"]);
        assert_eq!(ev[0].session_id.as_deref(), Some("T-9"));
        assert_eq!(ev[1].tool.as_deref(), Some("mcp__aivc__view_frame"));
        assert_eq!(ev[2].text.as_deref(), Some("ok\n[圖]"));
        assert_eq!(ev[2].is_error, Some(false));
        assert_eq!(ev[3].tool.as_deref(), Some("shell: dir"));
        assert_eq!(ev[4].is_error, Some(true));
        assert_eq!(ev[5].text.as_deref(), Some("第一段"));
        assert_eq!(ev[6].text.as_deref(), Some("\n\n第二段"), "第二則訊息前面補空行");
        assert_eq!(ev[7].session_id.as_deref(), Some("T-9"));
        assert_eq!(ev[7].text.as_deref(), Some("第二段"));
        assert_eq!(ev[7].is_error, Some(false));
    }

    #[test]
    fn codex_failures_become_error_and_failed_result() {
        let mut p = CodexParser::new("r", Some("T-1".into()));
        let tool_err = p.parse(r#"{"type":"item.completed","item":{"type":"mcp_tool_call","server":"aivc","tool":"x","error":{"message":"使用者拒絕"},"status":"failed"}}"#);
        assert_eq!(tool_err[0].text.as_deref(), Some("使用者拒絕"));
        assert_eq!(tool_err[0].is_error, Some(true));
        let failed = p.parse(r#"{"type":"turn.failed","error":{"message":"usage limit"}}"#);
        assert_eq!(failed.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), ["error", "result"]);
        assert_eq!(failed[1].is_error, Some(true));
        assert_eq!(failed[1].session_id.as_deref(), Some("T-1"), "resume 的 thread id 沿用");
        assert_eq!(p.parse(r#"{"type":"error","message":"reconnecting"}"#)[0].kind, "error");
        assert!(p.parse("garbage").is_empty());
    }

    #[test]
    fn parses_last_message_variants() {
        assert_eq!(parse_last_message(r#"{"a":1}"#).unwrap()["a"], 1);
        assert_eq!(parse_last_message("```json\n{\"a\":2}\n```").unwrap()["a"], 2);
        assert_eq!(parse_last_message("結果：\n{\"a\":3}\n希望有幫助").unwrap()["a"], 3);
        assert!(parse_last_message("").is_none());
        assert!(parse_last_message("完全沒有 JSON").is_none());
    }

    #[test]
    fn shim_resolution_prefers_the_native_exe() {
        let d = std::env::temp_dir().join(format!("aivc-codex-shim-{}", uuid::Uuid::new_v4()));
        let shim = d.join("codex.cmd");
        std::fs::create_dir_all(&d).unwrap();
        assert!(codex_native_beside_shim(&shim).is_none());
        let exe = d.join("node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe");
        std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
        std::fs::write(&exe, b"").unwrap();
        assert_eq!(codex_native_beside_shim(&shim), Some(exe));
        let _ = std::fs::remove_dir_all(&d);
    }
}
