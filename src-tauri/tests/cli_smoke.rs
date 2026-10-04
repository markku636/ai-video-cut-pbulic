//! 真機煙霧測試：起 App 的 MCP server（假工具：echo 與回一張圖的 snapshot），讓**真的** claude / codex CLI 連進來呼叫。
//!
//! 預設忽略（要登入、會用到模型額度）。手動跑：
//!
//! ```text
//! cd src-tauri
//! cargo test --no-default-features --test cli_smoke -- --ignored --nocapture --test-threads=1
//! ```
//!
//! 每支測試只送一個很短的提示。claude 用 `AIVC_SMOKE_CLAUDE_MODEL`（預設 haiku）、codex 用 `AIVC_SMOKE_CODEX_MODEL`
//! （預設＝codex 自己的設定）。驗的是：工具呼叫真的走到 App（假工具收到參數）、圖真的送到模型（請它說出圖的顏色）、
//! codex 的 `-c mcp_servers.aivc.*` 覆寫真的生效（沒有動到使用者的 ~/.codex/config.toml）。
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ai_video_cut_lib::agent::{self, AgentEvent, ClaudeOpts};
use ai_video_cut_lib::codex::{self, AgentOpts, CodexParser};
use ai_video_cut_lib::mcp::{self, McpBridge, ToolCallEvent, ToolDef};
use parking_lot::Mutex;
use serde_json::json;

fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
    }
    !c
}

/// 純色 PNG（stored deflate，不需要任何影像套件）。
fn png_solid(w: u32, h: u32, rgb: [u8; 3]) -> Vec<u8> {
    // 每列：濾波位元組 0 + w 個像素
    let row: Vec<u8> = std::iter::once(0u8).chain(rgb.iter().copied().cycle().take(3 * w as usize)).collect();
    let raw: Vec<u8> = row.iter().copied().cycle().take(row.len() * h as usize).collect();
    let mut z = vec![0x78, 0x01];
    let chunks: Vec<&[u8]> = raw.chunks(65535).collect();
    for (i, c) in chunks.iter().enumerate() {
        z.push(if i + 1 == chunks.len() { 1 } else { 0 });
        let len = c.len() as u16;
        z.extend_from_slice(&len.to_le_bytes());
        z.extend_from_slice(&(!len).to_le_bytes());
        z.extend_from_slice(c);
    }
    let (mut a, mut b) = (1u32, 0u32);
    for &x in &raw {
        a = (a + x as u32) % 65521;
        b = (b + a) % 65521;
    }
    z.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut chunk = |ty: &[u8], data: &[u8]| {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        let mut td = ty.to_vec();
        td.extend_from_slice(data);
        out.extend_from_slice(&td);
        out.extend_from_slice(&crc32(&td).to_be_bytes());
    };
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
    chunk(b"IHDR", &ihdr);
    chunk(b"IDAT", &z);
    chunk(b"IEND", &[]);
    out
}

struct Rig {
    bridge: Arc<McpBridge>,
    calls: Arc<Mutex<Vec<(String, serde_json::Value)>>>,
    root: PathBuf,
    workspace: PathBuf,
}

/// 起 server：兩支假工具；圖放在「App 資料根」底下（允許讀），另外放一張在根外面（必須被拒絕）。
async fn rig(tag: &str) -> Rig {
    let base = std::env::temp_dir().join(format!("aivc-smoke-{tag}-{}", uuid::Uuid::new_v4().simple()));
    let root = base.join("app-cache");
    let workspace = base.join("agent-workspace");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::write(root.join("snapshot.png"), png_solid(64, 64, [220, 20, 20])).unwrap();
    std::fs::write(base.join("outside.png"), png_solid(8, 8, [0, 0, 255])).unwrap();

    let bridge = Arc::new(McpBridge::new());
    bridge.set_image_roots(vec![root.clone()]);
    *bridge.tools.write() = vec![
        ToolDef {
            name: "echo".into(),
            description: "Echo the given text back. Use when asked to echo.".into(),
            input_schema: json!({ "type": "object", "properties": { "text": { "type": "string", "description": "text to echo" } }, "required": ["text"], "additionalProperties": false }),
            timeout_secs: None,
        },
        ToolDef {
            name: "snapshot".into(),
            description: "Grab the current video frame as an image (returned as an image block).".into(),
            input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
            timeout_secs: None,
        },
    ];
    let calls: Arc<Mutex<Vec<(String, serde_json::Value)>>> = Arc::new(Mutex::new(Vec::new()));
    let (b2, c2, snap, outside) = (bridge.clone(), calls.clone(), root.join("snapshot.png"), base.join("outside.png"));
    bridge.set_sink(Arc::new(move |ev: ToolCallEvent| {
        eprintln!("[smoke] tool call: {} {}", ev.name, ev.args);
        c2.lock().push((ev.name.clone(), ev.args.clone()));
        let result = match ev.name.as_str() {
            "echo" => json!({ "echo": ev.args.get("text").cloned().unwrap_or_default() }),
            _ => json!({ "message": "frame 0 grabbed", "images": [snap.to_string_lossy(), outside.to_string_lossy()] }),
        };
        let b = b2.clone();
        tokio::spawn(async move {
            b.resolve(&ev.id, Ok(result));
        });
    }));
    let port = mcp::serve(bridge.clone(), 0).await.unwrap();
    eprintln!("[smoke] MCP on 127.0.0.1:{port}");
    Rig { bridge, calls, root, workspace }
}

const PROMPT: &str = "Use the aivc tools: call echo with text \"ping-42\", then call snapshot. \
Finally reply in one short line with the echoed text and the main color of the snapshot image.";

fn collect() -> (Arc<Mutex<Vec<AgentEvent>>>, impl Fn(AgentEvent) + Send + Sync) {
    let ev = Arc::new(Mutex::new(Vec::new()));
    let e2 = ev.clone();
    (ev, move |e: AgentEvent| {
        if e.kind != "text" {
            eprintln!("[smoke] event {}: {}", e.kind, e.text.clone().or(e.tool.clone()).or(e.session_id.clone()).unwrap_or_default());
        }
        e2.lock().push(e)
    })
}

fn report(rig: &Rig, events: &[AgentEvent]) -> String {
    let text: String = events.iter().filter(|e| e.kind == "text").filter_map(|e| e.text.clone()).collect();
    let calls = rig.calls.lock().clone();
    eprintln!("[smoke] calls = {calls:?}");
    eprintln!("[smoke] final text = {text}");
    assert!(calls.iter().any(|(n, a)| n == "echo" && a["text"] == "ping-42"), "echo 沒有被呼叫：{calls:?}");
    assert!(calls.iter().any(|(n, _)| n == "snapshot"), "snapshot 沒有被呼叫：{calls:?}");
    let tool_results: Vec<String> = events.iter().filter(|e| e.kind == "tool_result").filter_map(|e| e.text.clone()).collect();
    eprintln!("[smoke] tool results = {tool_results:?}");
    let _ = std::fs::remove_dir_all(rig.root.parent().unwrap());
    text
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "需要登入的 claude CLI，會用到模型額度"]
async fn claude_cli_calls_our_mcp_tools() {
    let rig = rig("claude").await;
    let bin = agent::resolve_claude_bin().await.expect("找不到 claude");
    let cfg = rig.workspace.join("mcp.json");
    std::fs::write(&cfg, serde_json::to_vec(&agent::claude_mcp_config(&rig.bridge.url(), &rig.bridge.token)).unwrap()).unwrap();
    let model = std::env::var("AIVC_SMOKE_CLAUDE_MODEL").unwrap_or_else(|_| "haiku".into());
    let args = agent::claude_args(&ClaudeOpts { mcp_config: Some(&cfg), session_id: None, model: Some(&model), system_prompt: None });
    let mut cmd = bin.command();
    cmd.args(&args).current_dir(&rig.workspace);
    let (events, sink) = collect();
    let code = agent::run_streaming(cmd, "claude", PROMPT.into(), "smoke".into(), |l| agent::parse_claude_line("smoke", l), sink).await;
    let ev = events.lock().clone();
    assert_eq!(code, Some(0), "{ev:?}");
    assert!(ev.iter().any(|e| e.kind == "system" && e.session_id.is_some()), "沒有 session id（--resume 接不上）");
    assert!(ev.iter().any(|e| e.kind == "tool" && e.tool.as_deref() == Some("mcp__aivc__echo")));
    let text = report(&rig, &ev);
    assert!(text.to_lowercase().contains("ping-42"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "需要登入的 codex CLI，會用到模型額度"]
async fn codex_cli_calls_our_mcp_tools_via_config_overrides() {
    let rig = rig("codex").await;
    let bin = codex::resolve_codex_bin().await.expect("找不到 codex");
    let model = std::env::var("AIVC_SMOKE_CODEX_MODEL").ok();
    let url = rig.bridge.url();
    let args = codex::agent_args(&AgentOpts { mcp_url: &url, session_id: None, model: model.as_deref(), images: &[] });
    eprintln!("[smoke] codex {}", args.join(" "));
    let mut cmd = bin.command();
    cmd.args(&args).current_dir(&rig.workspace).env(mcp::TOKEN_ENV, &rig.bridge.token);
    let (events, sink) = collect();
    let mut parser = CodexParser::new("smoke", None);
    let code = agent::run_streaming(cmd, "codex", PROMPT.into(), "smoke".into(), move |l| parser.parse(l), sink).await;
    let ev = events.lock().clone();
    assert_eq!(code, Some(0), "{ev:?}");
    assert!(ev.iter().any(|e| e.kind == "system" && e.session_id.is_some()), "沒有 thread id（resume 接不上）");
    assert!(ev.iter().any(|e| e.kind == "result" && e.is_error == Some(false)));
    let text = report(&rig, &ev);
    assert!(text.to_lowercase().contains("ping-42"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "需要登入的 codex CLI，會用到模型額度"]
async fn codex_structured_reads_schema_output_and_images() {
    let base = std::env::temp_dir().join(format!("aivc-smoke-structured-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&base).unwrap();
    let img = base.join("frame.png");
    std::fs::write(&img, png_solid(64, 64, [20, 160, 40])).unwrap();
    let bin = codex::resolve_codex_bin().await.expect("找不到 codex");
    let schema = json!({
        "type": "object",
        "properties": { "color": { "type": "string" }, "ok": { "type": "boolean" } },
        "required": ["color", "ok"],
        "additionalProperties": false
    });
    let model = std::env::var("AIVC_SMOKE_CODEX_MODEL").ok();
    let v = codex::structured(
        &bin,
        Path::new(&base),
        "Look at the attached image. Return its main color as one lowercase English word, and ok=true.".into(),
        &schema,
        model.as_deref(),
        &[img.to_string_lossy().into_owned()],
        240_000,
    )
    .await
    .expect("structured");
    eprintln!("[smoke] structured = {v}");
    assert_eq!(v["ok"], true);
    assert!(v["color"].as_str().unwrap_or("").to_lowercase().contains("green"), "{v}");
    let _ = std::fs::remove_dir_all(&base);
}
