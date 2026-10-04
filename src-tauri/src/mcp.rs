//! 內建 MCP server（Streamable HTTP，JSON-RPC 2.0）：讓 claude / codex CLI（App 自己開的，或使用者自己的
//! Claude Code / Codex 工作階段）連進來操作 App。承襲 ai-music-cut 的 mcp.rs。
//!
//! - 只綁 127.0.0.1；port 預設隨機（設定 `mcp_port` 可以固定，給外部工作階段用）；每次啟動隨機 bearer token。
//! - 工具目錄由前端登記（`mcp_set_tools`），呼叫時發 `mcp-tool-call` 事件給前端執行，
//!   前端以 `mcp_tool_result` 回寫 → oneshot 喚醒 HTTP 回應（預設 60 秒逾時；長工作的工具可以自己帶 `timeoutSecs`）。
//! - 工具結果可以帶圖：結果物件裡有 `images: [本機 PNG 路徑…]` 時，Rust 讀檔（**只收 App 資料／快取根目錄底下的**，
//!   其他路徑一律拒絕）並回 MCP 的 `{type:"image", data:<base64>, mimeType:"image/png"}`，接在文字區塊後面。
//! - 手刻協定（initialize / notifications/* / tools/list / tools/call / ping）；單一 POST 端點回 application/json，
//!   GET 回 405（不開 SSE 串流），DELETE 回 204。
//!
//! 不依賴 Tauri：轉發給前端的動作是一個 [`ToolSink`]（App 裡是 emit 事件，整合測試裡是假的工具），
//! 所以 `tests/` 可以直接起一個真的 server 給 claude / codex 連。
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::oneshot;

/// MCP 伺服器名。claude 的工具全名是 `mcp__aivc__<tool>`（`--allowedTools mcp__aivc` 放行整組），
/// codex 的設定鍵是 `mcp_servers.aivc.*`。**改名等於換一組設定**，外部工作階段登記過的也要重來。
pub const SERVER_NAME: &str = "aivc";
const PROTOCOL_VERSION: &str = "2025-06-18";
/// 工具預設逾時（等前端回寫）。
pub const DEFAULT_TOOL_TIMEOUT_SECS: u64 = 60;
/// 前端給的 `timeoutSecs` 上限（追蹤、輸出這類長工作）。
pub const MAX_TOOL_TIMEOUT_SECS: u64 = 3600;
/// codex 讀 bearer token 的環境變數名（`mcp_servers.aivc.bearer_token_env_var`）。
pub const TOKEN_ENV: &str = "AIVC_MCP_TOKEN";
/// 一次工具結果最多帶幾張圖、每張多大：模型看圖很貴，聯絡表一張就夠，不需要更多。
const MAX_IMAGES: usize = 8;
const MAX_IMAGE_BYTES: u64 = 8 * 1024 * 1024;

/// 給模型的操作守則。CLI 走 MCP `initialize` 拿到這段（claude / codex 都會放進系統提示）。
pub const INSTRUCTIONS: &str = "你正在操作 AI Video Cut（桌面影片工具：追蹤畫面上的任何東西，再對它做剪輯與特效）。\
你看不到畫面，也聽不到聲音；一切都從工具拿。\
\n\n【先看狀態】工具清單以 tools/list 為準（不同版本、不同外掛會多幾支）。使用者講「這裡／這段」時，先用查狀態的工具或系統提示裡的狀態（播放線、範圍、影片長度）定位，不要自己編時間。\
\n\n【時間與幀號】幀號是 proxy 的 CFR 幀號 k（0 起算）；範圍寫成 \"K0:K1\"，含頭不含尾。秒數換幀號用影片的 fps；set_range／seek_to 吃秒數，引擎類工具吃幀號。\
\n\n【座標】像素座標原點在左上；看圖讀座標時用 0–1000 正規化（norm1000：x_px = x/1000×寬、y_px = y/1000×高，1000 對到右／下邊界）。要看某一幀就用 view_frame（grid=true 會疊 0–1000 格線），結果會附上那張圖。\
\n\n【物件】「物件」是一條逐幀遮罩（masks.aivm）：用文字找（find：英文短名詞通常比較準，例如 face, license plate, red car），或在某一幀用點／框選（select；正點 = 要的、負點 = 不要的），再沿時間傳播。\
找到之後先看結果圖（overlay／縮圖／聯絡表）確認選對了再繼續；選錯就在那一幀補點重選，不要直接往下做。追蹤中段歪掉時，從歪掉的那一幀補修正點只往後重算。範圍請留在同一個鏡頭內（鏡頭切換會追丟）。\
\n\n【特效】物件可以掛特效：mosaic（馬賽克打碼）、blur（模糊）、color（調色／換色）、outline（描邊）、glow（光暈）、sticker（貼圖跟著物件走）、text（文字跟著物件走）。\
參數只用工具說明裡列的鍵（未知鍵會被拒絕）；隱私打碼常用 shape=ellipse。套用前先預覽一幀讓使用者看。\
\n\n【會改東西的工具】剪輯、輸出、寫檔這類工具標著「會改東西」，App 會先問使用者，使用者可能拒絕：被拒絕就停下來問他要怎麼做，不要換個工具繞過去，也不要重試同一個呼叫。\
打開對話框的工具只是把對話框開好，真正的執行由使用者在對話框裡按。\
\n\n【回報】做完用一兩句話說你做了什麼、結果在哪（輸出檔路徑、幀號範圍）；失敗就照工具回的原因講，不要猜。";

/// 前端登記的一支工具。`timeoutSecs` 只給 App 自己用（等前端回寫多久），`tools/list` 不會送出去。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
    #[serde(rename = "timeoutSecs", default, skip_serializing)]
    pub timeout_secs: Option<u64>,
}

/// 發給前端的工具呼叫（事件 `mcp-tool-call`）。
#[derive(Serialize, Clone, Debug)]
pub struct ToolCallEvent {
    pub id: String,
    pub name: String,
    pub args: Value,
}

/// 把一次工具呼叫交出去執行的地方（App：emit 事件給前端；測試：假工具）。
/// 執行完由呼叫端以 [`McpBridge::resolve`] 回寫同一個 id。
pub type ToolSink = Arc<dyn Fn(ToolCallEvent) + Send + Sync>;

pub struct McpBridge {
    port: AtomicU16,
    pub token: String,
    pub tools: RwLock<Vec<ToolDef>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    /// 工具結果的圖只能從這些目錄底下讀（App 的資料 / 快取 / 設定目錄）。
    image_roots: RwLock<Vec<PathBuf>>,
    sink: RwLock<Option<ToolSink>>,
}

impl McpBridge {
    pub fn new() -> Self {
        Self::with_token(random_token())
    }

    pub fn with_token(token: String) -> Self {
        Self {
            port: AtomicU16::new(0),
            token,
            tools: RwLock::new(Vec::new()),
            pending: Mutex::new(HashMap::new()),
            image_roots: RwLock::new(Vec::new()),
            sink: RwLock::new(None),
        }
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.port())
    }

    pub fn set_sink(&self, sink: ToolSink) {
        *self.sink.write() = Some(sink);
    }

    pub fn set_image_roots(&self, roots: Vec<PathBuf>) {
        *self.image_roots.write() = roots;
    }

    pub fn image_roots(&self) -> Vec<PathBuf> {
        self.image_roots.read().clone()
    }

    pub fn has_tool(&self, name: &str) -> bool {
        self.tools.read().iter().any(|t| t.name == name)
    }

    fn timeout_of(&self, name: &str) -> u64 {
        let t = self.tools.read().iter().find(|t| t.name == name).and_then(|t| t.timeout_secs);
        t.unwrap_or(DEFAULT_TOOL_TIMEOUT_SECS).clamp(1, MAX_TOOL_TIMEOUT_SECS)
    }

    /// 前端回寫工具結果。id 不認得（逾時後才回來）回 false。
    pub fn resolve(&self, id: &str, result: Result<Value, String>) -> bool {
        match self.pending.lock().remove(id) {
            Some(tx) => tx.send(result).is_ok(),
            None => false,
        }
    }

    /// 執行一支工具：交給 sink → 等 [`resolve`](Self::resolve)（逾時見 [`ToolDef::timeout_secs`]）。
    pub async fn call_tool(&self, name: &str, args: Value) -> Result<Value, String> {
        let sink = self.sink.read().clone().ok_or_else(|| "App 還沒準備好接工具呼叫".to_string())?;
        let call_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(call_id.clone(), tx);
        sink(ToolCallEvent { id: call_id.clone(), name: name.to_string(), args });
        let secs = self.timeout_of(name);
        match tokio::time::timeout(std::time::Duration::from_secs(secs), rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => Err("tool handler dropped".to_string()),
            Err(_) => {
                self.pending.lock().remove(&call_id);
                Err(format!("工具 {name} 超過 {secs} 秒沒有回應"))
            }
        }
    }
}

impl Default for McpBridge {
    fn default() -> Self {
        Self::new()
    }
}

/// 每次啟動一把：24 bytes 亂數的 hex（48 字）。
pub fn random_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// 綁定並啟動；回實際 port。`port` 0 = 隨機。固定 port 被占用時回錯誤，由呼叫端決定要不要退回隨機。
pub async fn serve(bridge: Arc<McpBridge>, port: u16) -> std::io::Result<u16> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port)).await?;
    let port = listener.local_addr()?.port();
    bridge.port.store(port, Ordering::Relaxed);
    let router = Router::new()
        .route("/mcp", post(handle).get(method_not_allowed).delete(|| async { StatusCode::NO_CONTENT }))
        .with_state(bridge);
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("[mcp] server stopped: {e}");
        }
    });
    Ok(port)
}

/// 先試固定 port，被占用就退回隨機（並回報原因）。回 (實際 port, 退回的原因)。
pub async fn serve_preferring(bridge: Arc<McpBridge>, port: u16) -> std::io::Result<(u16, Option<String>)> {
    if port != 0 {
        match serve(bridge.clone(), port).await {
            Ok(p) => return Ok((p, None)),
            Err(e) => {
                let why = format!("固定 port {port} 無法使用（{e}），改用隨機 port");
                return serve(bridge, 0).await.map(|p| (p, Some(why)));
            }
        }
    }
    serve(bridge, 0).await.map(|p| (p, None))
}

async fn method_not_allowed() -> StatusCode {
    StatusCode::METHOD_NOT_ALLOWED
}

/// 只收本機網頁來源（DNS rebinding 防護，MCP 規格建議）；沒有 Origin（CLI）照常放行。
pub fn origin_allowed(origin: Option<&str>) -> bool {
    let Some(o) = origin else { return true };
    let host = o.split("://").nth(1).unwrap_or(o);
    let host = host.split('/').next().unwrap_or(host);
    let host = if host.starts_with('[') { host.split(']').next().map(|h| &h[1..]).unwrap_or(host) } else { host.split(':').next().unwrap_or(host) };
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

async fn handle(State(bridge): State<Arc<McpBridge>>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    let auth = headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("");
    if auth != format!("Bearer {}", bridge.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if !origin_allowed(headers.get("origin").and_then(|v| v.to_str().ok())) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let req: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return Json(rpc_error(Value::Null, -32700, format!("parse error: {e}"))).into_response(),
    };
    // 批次請求：逐一處理（罕見）
    if let Some(arr) = req.as_array() {
        let mut out = Vec::new();
        for r in arr {
            if let Some(resp) = dispatch(&bridge, r).await {
                out.push(resp);
            }
        }
        return if out.is_empty() { StatusCode::ACCEPTED.into_response() } else { with_session(Json(Value::Array(out)).into_response()) };
    }
    match dispatch(&bridge, &req).await {
        Some(v) => with_session(Json(v).into_response()),
        None => StatusCode::ACCEPTED.into_response(), // notification
    }
}

fn with_session(mut r: Response) -> Response {
    r.headers_mut().insert("Mcp-Session-Id", HeaderValue::from_static("aivc-1"));
    r
}

fn rpc_error(id: Value, code: i64, message: String) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// 回 Some(JSON-RPC 回應物件) 或 None（通知，不回應）。
async fn dispatch(bridge: &Arc<McpBridge>, req: &Value) -> Option<Value> {
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let id = req.get("id").cloned();
    if method.starts_with("notifications/") {
        return None;
    }
    let id = id?;
    let result = match method {
        "initialize" => {
            let requested = req.pointer("/params/protocolVersion").and_then(|v| v.as_str()).unwrap_or(PROTOCOL_VERSION);
            json!({
                "protocolVersion": requested,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
                "instructions": INSTRUCTIONS
            })
        }
        "ping" => json!({}),
        "tools/list" => {
            let tools = bridge.tools.read().clone();
            json!({ "tools": tools })
        }
        "tools/call" => {
            let name = req.pointer("/params/name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            let args = req.pointer("/params/arguments").cloned().unwrap_or(json!({}));
            if !bridge.has_tool(&name) {
                return Some(rpc_error(id, -32602, format!("unknown tool {name}")));
            }
            match bridge.call_tool(&name, args).await {
                Ok(v) => {
                    let roots = bridge.image_roots();
                    let content = tokio::task::spawn_blocking(move || tool_content(&v, &roots))
                        .await
                        .unwrap_or_else(|e| vec![json!({ "type": "text", "text": format!("internal error: {e}") })]);
                    json!({ "content": content, "isError": false })
                }
                Err(msg) => json!({ "content": [{ "type": "text", "text": msg }], "isError": true }),
            }
        }
        _ => return Some(rpc_error(id, -32601, format!("method not found: {method}"))),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// 前端的工具結果 → MCP content blocks：一個文字區塊（結果 JSON，拿掉 `images`）＋每張圖一個 image 區塊。
/// 圖不合規（不在允許的根目錄、不是 PNG、太大、讀不到）不會讓整個呼叫失敗：那張略過，原因寫進文字區塊。
pub fn tool_content(value: &Value, roots: &[PathBuf]) -> Vec<Value> {
    use base64::Engine as _;
    let mut text_value = value.clone();
    let mut images: Vec<String> = Vec::new();
    if let Some(obj) = text_value.as_object_mut() {
        if let Some(Value::Array(arr)) = obj.remove("images") {
            images = arr.into_iter().filter_map(|v| v.as_str().map(String::from)).collect();
        }
    }
    let mut blocks = Vec::new();
    let mut notes = Vec::new();
    for (i, p) in images.iter().enumerate() {
        if i >= MAX_IMAGES {
            notes.push(format!("圖太多，只附前 {MAX_IMAGES} 張"));
            break;
        }
        match load_png(Path::new(p), roots) {
            Ok(bytes) => blocks.push(json!({
                "type": "image",
                "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                "mimeType": "image/png"
            })),
            Err(why) => notes.push(format!("略過圖 {p}：{why}")),
        }
    }
    let mut text = match &text_value {
        Value::String(s) => s.clone(),
        Value::Null => "ok".to_string(),
        other => serde_json::to_string(other).unwrap_or_default(),
    };
    if !notes.is_empty() {
        text.push_str("\n（");
        text.push_str(&notes.join("；"));
        text.push('）');
    }
    let mut out = vec![json!({ "type": "text", "text": text })];
    out.extend(blocks);
    out
}

/// 檢查並讀一張 PNG：副檔名 .png、真的存在、正規化之後落在某個允許的根目錄底下、檔頭是 PNG、不超過大小上限。
pub fn load_png(path: &Path, roots: &[PathBuf]) -> Result<Vec<u8>, String> {
    let canon = image_allowed(path, roots)?;
    let meta = std::fs::metadata(&canon).map_err(|e| format!("讀不到：{e}"))?;
    if !meta.is_file() {
        return Err("不是檔案".into());
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(format!("檔案太大（{} bytes）", meta.len()));
    }
    let bytes = std::fs::read(&canon).map_err(|e| format!("讀不到：{e}"))?;
    if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Err("不是 PNG".into());
    }
    Ok(bytes)
}

/// 路徑是否落在允許的根目錄底下（兩邊都先正規化：`..`、符號連結、大小寫都解掉之後才比）。
pub fn image_allowed(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let ext_ok = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("png"));
    if !ext_ok {
        return Err("只接受 .png".into());
    }
    let canon = dunce::canonicalize(path).map_err(|e| format!("找不到檔案（{e}）"))?;
    for r in roots {
        if let Ok(rc) = dunce::canonicalize(r) {
            if canon.starts_with(&rc) {
                return Ok(canon);
            }
        }
    }
    Err("不在 App 的資料／快取資料夾內，拒絕讀取".into())
}

/// 給使用者自己的 Claude Code / Codex 工作階段連進來的指令（設定畫面複製用）。
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct ExternalCommands {
    pub claude: String,
    /// codex：先設環境變數（token 每次啟動都換）再登記。
    pub codex_env: String,
    pub codex: String,
}

pub fn external_commands(url: &str, token: &str, windows: bool) -> ExternalCommands {
    ExternalCommands {
        claude: format!("claude mcp add --transport http {SERVER_NAME} {url} --header \"Authorization: Bearer {token}\""),
        codex_env: if windows { format!("$env:{TOKEN_ENV}=\"{token}\"") } else { format!("export {TOKEN_ENV}={token}") },
        codex: format!("codex mcp add {SERVER_NAME} --url {url} --bearer-token-env-var {TOKEN_ENV}"),
    }
}

// ---------------- commands ----------------

#[tauri::command]
pub fn mcp_set_tools(state: tauri::State<'_, crate::commands::AppState>, tools: Vec<ToolDef>) -> usize {
    let n = tools.len();
    *state.mcp.tools.write() = tools;
    n
}

#[tauri::command]
pub fn mcp_tool_result(state: tauri::State<'_, crate::commands::AppState>, id: String, result: Option<Value>, error: Option<String>) -> bool {
    match error {
        Some(e) => state.mcp.resolve(&id, Err(e)),
        None => state.mcp.resolve(&id, Ok(result.unwrap_or(Value::Null))),
    }
}

#[derive(Serialize)]
pub struct McpInfo {
    /// 0 = 沒有起來（見 `error`）。
    pub port: u16,
    pub url: String,
    pub tools: usize,
    /// 這次啟動的 token（只給設定畫面組外部連線指令；每次啟動都換）。
    pub token: String,
    pub token_env: &'static str,
    pub server_name: &'static str,
    /// 固定 port 用不了而退回隨機時的原因；server 起不來時的錯誤。
    pub error: Option<String>,
    pub commands: ExternalCommands,
}

#[tauri::command]
pub fn mcp_info(state: tauri::State<'_, crate::commands::AppState>) -> McpInfo {
    let m = &state.mcp;
    let url = m.url();
    McpInfo {
        port: m.port(),
        commands: external_commands(&url, &m.token, cfg!(windows)),
        url,
        tools: m.tools.read().len(),
        token: m.token.clone(),
        token_env: TOKEN_ENV,
        server_name: SERVER_NAME,
        error: state.mcp_error.read().clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("aivc-mcp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
        0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0xF0, 0x1F, 0x00, 0x05, 0x00,
        0x01, 0xFF, 0x89, 0x99, 0x3D, 0x1D, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn token_is_hex_48() {
        let t = random_token();
        assert_eq!(t.len(), 48);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(t, random_token(), "每次啟動都要換");
    }

    #[test]
    fn tool_def_timeout_is_app_only() {
        let d: ToolDef = serde_json::from_value(json!({ "name": "x", "description": "d", "inputSchema": { "type": "object" }, "timeoutSecs": 900 })).unwrap();
        assert_eq!(d.timeout_secs, Some(900));
        let out = serde_json::to_value(&d).unwrap();
        assert!(out.get("timeoutSecs").is_none(), "tools/list 不送 App 自己的逾時");
        assert_eq!(out["inputSchema"]["type"], "object");
    }

    #[test]
    fn images_inside_roots_become_image_blocks() {
        let root = tmpdir();
        let p = root.join("sub").join("frame.png");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, PNG_1X1).unwrap();
        let v = json!({ "ok": true, "message": "看這張", "images": [p.to_string_lossy()] });
        let c = tool_content(&v, std::slice::from_ref(&root));
        assert_eq!(c.len(), 2);
        assert_eq!(c[0]["type"], "text");
        assert!(!c[0]["text"].as_str().unwrap().contains("images"), "文字區塊不重複列路徑");
        assert_eq!(c[1]["type"], "image");
        assert_eq!(c[1]["mimeType"], "image/png");
        use base64::Engine as _;
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(c[1]["data"].as_str().unwrap()).unwrap(), PNG_1X1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn images_outside_roots_are_rejected_with_a_note() {
        let root = tmpdir();
        let other = tmpdir();
        let outside = other.join("secret.png");
        std::fs::write(&outside, PNG_1X1).unwrap();
        // `..` 繞出去也一樣擋
        let sneaky = root.join("..").join(other.file_name().unwrap()).join("secret.png");
        let notpng = root.join("x.png");
        std::fs::write(&notpng, b"hello").unwrap();
        let v = json!({ "images": [outside.to_string_lossy(), sneaky.to_string_lossy(), notpng.to_string_lossy(), root.join("missing.png").to_string_lossy(), "C:/Windows/win.ini"] });
        let c = tool_content(&v, std::slice::from_ref(&root));
        assert_eq!(c.len(), 1, "一張都不該附上：{c:?}");
        let text = c[0]["text"].as_str().unwrap();
        assert!(text.contains("拒絕讀取"), "{text}");
        assert!(text.contains("不是 PNG"), "{text}");
        assert!(text.contains("只接受 .png"), "{text}");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&other);
    }

    #[test]
    fn plain_results_are_one_text_block() {
        assert_eq!(tool_content(&json!("你好"), &[]), vec![json!({ "type": "text", "text": "你好" })]);
        assert_eq!(tool_content(&Value::Null, &[]), vec![json!({ "type": "text", "text": "ok" })]);
        let c = tool_content(&json!({ "a": 1 }), &[]);
        assert_eq!(c[0]["text"], "{\"a\":1}");
    }

    #[test]
    fn origin_check_only_allows_loopback() {
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("http://127.0.0.1:5173")));
        assert!(origin_allowed(Some("http://localhost")));
        assert!(origin_allowed(Some("http://[::1]:80")));
        assert!(!origin_allowed(Some("https://evil.example")));
        assert!(!origin_allowed(Some("http://127.0.0.1.evil.example")));
    }

    #[test]
    fn external_commands_carry_url_and_token() {
        let c = external_commands("http://127.0.0.1:4567/mcp", "abc", true);
        assert_eq!(c.claude, "claude mcp add --transport http aivc http://127.0.0.1:4567/mcp --header \"Authorization: Bearer abc\"");
        assert_eq!(c.codex, "codex mcp add aivc --url http://127.0.0.1:4567/mcp --bearer-token-env-var AIVC_MCP_TOKEN");
        assert_eq!(c.codex_env, "$env:AIVC_MCP_TOKEN=\"abc\"");
        assert_eq!(external_commands("u", "abc", false).codex_env, "export AIVC_MCP_TOKEN=abc");
    }

    /// 真的起一個 server，走 HTTP 打一輪：initialize → tools/list → tools/call（假工具立刻回寫）→ 錯 token 401。
    #[tokio::test]
    async fn server_roundtrip_over_http() {
        let bridge = Arc::new(McpBridge::with_token("t0k".into()));
        *bridge.tools.write() = vec![ToolDef { name: "echo".into(), description: "e".into(), input_schema: json!({ "type": "object" }), timeout_secs: Some(5) }];
        let b2 = bridge.clone();
        bridge.set_sink(Arc::new(move |ev: ToolCallEvent| {
            let b = b2.clone();
            tokio::spawn(async move {
                b.resolve(&ev.id, Ok(json!({ "echo": ev.args })));
            });
        }));
        let port = serve(bridge.clone(), 0).await.unwrap();
        assert_ne!(port, 0);
        let url = format!("http://127.0.0.1:{port}/mcp");
        let http = reqwest::Client::new();
        let post = |body: Value, tok: &'static str| http.post(&url).header("Authorization", format!("Bearer {tok}")).json(&body).send();

        let r: Value = post(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-03-26" } }), "t0k").await.unwrap().json().await.unwrap();
        assert_eq!(r["result"]["serverInfo"]["name"], "aivc");
        assert_eq!(r["result"]["protocolVersion"], "2025-03-26");
        assert!(r["result"]["instructions"].as_str().unwrap().contains("AI Video Cut"));

        let n = post(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), "t0k").await.unwrap();
        assert_eq!(n.status(), 202);

        let r: Value = post(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }), "t0k").await.unwrap().json().await.unwrap();
        assert_eq!(r["result"]["tools"][0]["name"], "echo");
        assert!(r["result"]["tools"][0].get("timeoutSecs").is_none());

        let r: Value = post(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "echo", "arguments": { "x": 1 } } }), "t0k").await.unwrap().json().await.unwrap();
        assert_eq!(r["result"]["isError"], false);
        assert_eq!(r["result"]["content"][0]["text"], "{\"echo\":{\"x\":1}}");

        let r: Value = post(json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "nope" } }), "t0k").await.unwrap().json().await.unwrap();
        assert_eq!(r["error"]["code"], -32602);

        let bad = post(json!({ "jsonrpc": "2.0", "id": 5, "method": "ping" }), "wrong").await.unwrap();
        assert_eq!(bad.status(), 401);
        let get = http.get(&url).header("Authorization", "Bearer t0k").send().await.unwrap();
        assert_eq!(get.status(), 405);
    }

    #[tokio::test]
    async fn tool_timeout_reports_an_error_and_forgets_the_call() {
        let bridge = Arc::new(McpBridge::with_token("t".into()));
        *bridge.tools.write() = vec![ToolDef { name: "slow".into(), description: String::new(), input_schema: json!({}), timeout_secs: Some(1) }];
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let s2 = seen.clone();
        bridge.set_sink(Arc::new(move |ev: ToolCallEvent| s2.lock().push(ev.id)));
        let err = bridge.call_tool("slow", json!({})).await.unwrap_err();
        assert!(err.contains("1 秒"), "{err}");
        let id = seen.lock()[0].clone();
        assert!(!bridge.resolve(&id, Ok(Value::Null)), "逾時之後才回來的結果沒有人等");
    }
}
