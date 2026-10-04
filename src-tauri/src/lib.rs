//! AI Video Cut 桌面殼（Tauri 2）。Rust 只做：設定、ffprobe / 指紋、快取目錄、縮圖、專案檔 IO、
//! 受管 Python 環境引導、常駐引擎監督。所有媒體邏輯在 Python 引擎 `aivc`（決策 2）。
//! 模組公開（`pub mod`）：這是 lib crate，測試 / 日後 CLI 直接用；不需要為未接線的函式加 allow(dead_code)。
pub mod agent;
pub mod codex;
pub mod commands;
pub mod engine;
pub mod error;
pub mod ffmpeg;
pub mod mcp;
pub mod media;
pub mod peaks;
pub mod proc;
pub mod project;
pub mod pyenv;
pub mod store;
pub mod thumbs;
// App 自動更新（updater.rs）與更新後的引擎 wheel 快速重裝（wheel_refresh.rs）
pub mod updater;
pub mod wheel_refresh;

use tauri::Manager;

use commands::AppState;

/// Linux + NVIDIA 專有驅動時 WebKitGTK 的 DMABUF renderer 會讓整個視窗空白（Wayland 與部分 X11 都有，Tauri 社群的已知問題）。
/// 純函式：`nvidia_driver` = `/proc/driver/nvidia` 存在（nouveau 不會建這個目錄）；`already_set` = 使用者自己設過就不動。
pub fn should_disable_webkit_dmabuf(nvidia_driver: bool, already_set: bool) -> bool {
    nvidia_driver && !already_set
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 必須在建立 webview 之前設（WebKitGTK 在初始化時讀一次），此時還沒有其他執行緒，set_var 安全。
    #[cfg(target_os = "linux")]
    {
        const DMABUF: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
        if should_disable_webkit_dmabuf(std::path::Path::new("/proc/driver/nvidia").exists(), std::env::var_os(DMABUF).is_some()) {
            std::env::set_var(DMABUF, "1");
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // 自動更新：外掛只提供檢查 / 下載 / 驗簽 / 安裝的底層，流程（先停引擎、進度事件、來源覆寫）在 updater.rs。
        // tauri.conf.json 一定要有 plugins.updater（含 pubkey 鍵），不然這裡初始化失敗、下面的 expect 讓 App 一開就 panic
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(AppState::new())
        .setup(|app| {
            let handle = app.handle().clone();
            let loaded: store::AppSettings =
                tauri::async_runtime::block_on(store::read_json(&handle, store::SETTINGS_FILE))
                    .unwrap_or_default();
            let mcp_port = loaded.mcp_port;
            *handle.state::<AppState>().settings.write() = loaded;
            // 內建 MCP server：claude / codex CLI（App 開的，或使用者自己的工作階段）連進來操作 App。
            // 工具呼叫轉成 `mcp-tool-call` 事件給前端執行（前端登記工具目錄並以 mcp_tool_result 回寫）。
            {
                let state = handle.state::<AppState>();
                let bridge = state.mcp.clone();
                bridge.set_image_roots(state.mcp_image_roots(&handle));
                let h = handle.clone();
                bridge.set_sink(std::sync::Arc::new(move |ev: mcp::ToolCallEvent| {
                    use tauri::Emitter;
                    let _ = h.emit("mcp-tool-call", ev);
                }));
                match tauri::async_runtime::block_on(mcp::serve_preferring(bridge, mcp_port)) {
                    Ok((port, why)) => {
                        eprintln!("[mcp] listening on 127.0.0.1:{port}");
                        if let Some(w) = why {
                            eprintln!("[mcp] {w}");
                            *state.mcp_error.write() = Some(w);
                        }
                    }
                    Err(e) => {
                        eprintln!("[mcp] failed to start: {e}");
                        *state.mcp_error.write() = Some(format!("MCP server 起不來：{e}"));
                    }
                }
            }
            // 安裝檔內建的 ffmpeg（bundle.resources）。dev 時 resource_dir 是 src-tauri，
            // 那裡也剛好有 resources/ffmpeg（fetch-ffmpeg.mjs 放的），所以本機也能測到同一條路徑。
            // macOS / Linux 版不內建 ffmpeg（目錄裡只有 README.txt）：try_candidate 找不到執行檔就會往常見目錄（Homebrew…）找。
            {
                let dir = app.path().resource_dir().ok().and_then(|r| ffmpeg::bundled_candidates(&r).into_iter().find(|d| d.is_dir()));
                if let Some(d) = dir {
                    eprintln!("[ffmpeg] bundled dir: {}", d.display());
                    *handle.state::<AppState>().bundled_ffmpeg.write() = Some(d);
                }
            }
            // 受管 Python 環境：非阻塞偵測（import torch 冷機十幾秒，不能擋視窗），結果走 `pyenv-status`。
            {
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    let st = {
                        let state = h.state::<AppState>();
                        let (paths, override_, lock) = {
                            let s = state.settings.read().clone();
                            (pyenv::paths(&h, &s), s.python_override.clone(), state.lock_file(&h))
                        };
                        match paths {
                            Ok(p) => pyenv::detect(&p, override_.as_deref(), lock.as_deref()).await,
                            Err(e) => pyenv::PyEnvStatus { state: "broken".into(), message: e.message(), ..Default::default() },
                        }
                    };
                    eprintln!("[pyenv] {} {}", st.state, st.message);
                    // 偵測（冷機 import torch 十幾秒）期間使用者可能已按下安裝：不要用過期的結果蓋掉 installing
                    if pyenv::install_in_progress() {
                        return;
                    }
                    *h.state::<AppState>().pyenv.write() = st.clone();
                    pyenv::emit_status(&h, &st);
                });
            }
            // 保險絲：視窗以 visible:false 啟動，正常由前端骨架屏呼叫 show_main_window；
            // 若前端 4 秒內沒呼叫（bundle 載入失敗 / JS 錯誤），強制顯示以免看起來像沒啟動。
            if let Some(w) = app.get_webview_window("main") {
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(4));
                    if !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::show_main_window,
            commands::app_platform,
            commands::client_log,
            commands::dev_env,
            commands::settings_get,
            commands::settings_set,
            commands::secret_set,
            commands::secret_has,
            commands::app_paths,
            commands::paths_exist,
            commands::open_path,
            commands::open_external,
            commands::write_text_file,
            commands::ffmpeg_detect,
            commands::media_probe,
            commands::media_fingerprint,
            commands::media_cache_status,
            commands::media_cache_clear,
            commands::media_peaks,
            commands::cache_read,
            commands::thumb_strip,
            commands::pyenv_status,
            commands::pyenv_install_command,
            commands::pyenv_install,
            commands::engine_start,
            commands::engine_stop,
            commands::engine_state,
            commands::engine_call,
            commands::engine_job_start,
            commands::engine_job_cancel,
            commands::project_save,
            commands::project_load,
            updater::updater_status,
            updater::update_check,
            updater::update_download,
            updater::update_cancel,
            updater::update_install,
            agent::claude_detect,
            agent::claude_send,
            agent::claude_cancel,
            codex::codex_detect,
            codex::codex_send,
            codex::codex_structured,
            mcp::mcp_set_tools,
            mcp::mcp_tool_result,
            mcp::mcp_info,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // App 關閉：禮貌 shutdown 引擎（兩秒沒走就殺），不留孤兒 python 佔著 GPU。
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let eng = app.state::<AppState>().engine.clone();
                tauri::async_runtime::block_on(async move {
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), eng.shutdown()).await;
                });
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dmabuf_workaround_only_for_nvidia_and_never_overrides_the_user() {
        assert!(should_disable_webkit_dmabuf(true, false));
        assert!(!should_disable_webkit_dmabuf(true, true), "使用者自己設了 0 / 1 就照他的");
        assert!(!should_disable_webkit_dmabuf(false, false), "Intel / AMD / nouveau 不需要，關掉 DMABUF 會變慢");
    }
}
