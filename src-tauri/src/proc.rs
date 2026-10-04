//! 子程序共用：不彈黑窗（Windows）、stdin 關閉、可執行檔查找（Windows `where`、其他平台掃 PATH）、
//! AppImage 環境變數清理（Linux）。
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;

use tokio::process::Command;

/// Win32 `CREATE_NO_WINDOW`：GUI App 起 console 子程序時不彈黑窗。其他平台沒有 console 視窗這回事，不需要對等旗標。
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 建立子程序指令：stdin 預設關閉（ffmpeg 遇到關閉的 stdin 會卡住的問題另以 `-nostdin` 處理）。
pub fn cmd(program: &str) -> Command {
    let mut c = Command::new(program);
    c.stdin(Stdio::null());
    // **Windows 上 Python 寫進「管線」用的是 ANSI 代碼頁（zh-TW 是 cp950），不是 UTF-8。**
    // 我們的 sidecar 用 ensure_ascii=False 輸出中文，所以那些 bytes 不是合法 UTF-8，
    // Rust 這邊 `lines()` 會回 Err、讀取迴圈直接結束 —— 沒有人再讀 stdout 之後管線塞滿，
    // python 就卡在下一次 flush，最後以結束碼 120 退出。
    // 短檔看不出來（寫不滿 64 KB），16 分鐘的節目必掛，而且中間的進度事件一直在被丟掉。
    // 對非 python 的程式（ffmpeg…）這兩個變數沒有作用，設了無害（macOS / Linux 的 locale 不是 UTF-8 時也一樣受用）。
    c.env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1");
    #[cfg(windows)]
    c.creation_flags(CREATE_NO_WINDOW);
    // 其他平台：不需要隱藏視窗；但從 AppImage 啟動時要把 AppRun 塞進來的函式庫路徑拿掉（見 `appimage_env_fixups`）
    #[cfg(not(windows))]
    for (k, v) in appimage_env() {
        match v {
            Some(v) => c.env(k, v),
            None => c.env_remove(k),
        };
    }
    c
}

/// 找可執行檔；回全部候選（依 PATH 順序）。找不到回空。
///
/// Windows 用 `where`（它懂 PATHEXT 與目前目錄的規則，換掉會改到既有行為）；
/// macOS / Linux 直接在程序內掃 PATH：精簡發行版 / 容器不一定裝 `which`（Debian 系它屬於 debianutils，Fedora minimal 沒有），
/// 少一次 spawn 也快。
pub async fn which(name: &str) -> Vec<String> {
    if cfg!(windows) {
        let mut c = cmd("where");
        c.arg(name);
        let out = match c.output().await {
            Ok(o) => o,
            Err(_) => return Vec::new(),
        };
        if !out.status.success() {
            return Vec::new();
        }
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect()
    } else {
        which_in(name, std::env::var_os("PATH").as_deref()).into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
    }
}

/// PATH 掃描（純函式，除了檔案系統查詢）：依序看每個目錄下的 `name`，是一般檔案且可執行才算；重複目錄只回一次。
/// `name` 含路徑分隔符（`./ffmpeg`、`/usr/bin/ffmpeg`）時不掃 PATH —— `which` 也是這樣，免得把相對路徑接到每個目錄後面。
pub fn which_in(name: &str, path_var: Option<&OsStr>) -> Vec<PathBuf> {
    if name.is_empty() || name.contains('/') || name.contains('\\') {
        return Vec::new();
    }
    let Some(pv) = path_var else { return Vec::new() };
    let mut out: Vec<PathBuf> = Vec::new();
    for dir in std::env::split_paths(pv) {
        // PATH 裡的空元素代表目前目錄；GUI App 的目前目錄是 `/`，拿它來找 ffmpeg 沒有意義也不安全
        if dir.as_os_str().is_empty() || !dir.has_root() {
            continue;
        }
        let cand = dir.join(name);
        if is_executable_file(&cand) && !out.contains(&cand) {
            out.push(cand);
        }
    }
    out
}

#[cfg(unix)]
fn is_executable_file(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(p: &Path) -> bool {
    p.is_file()
}

/// AppImage 的 AppRun（linuxdeploy 與它的 gtk / gstreamer 外掛）會把 `$APPDIR` 底下的路徑塞進 PATH、
/// `LD_LIBRARY_PATH`、`GST_PLUGIN_*`、`GIO_*`、`GTK_*`、`XDG_DATA_DIRS`… 子程序（系統的 bash / python / ffmpeg、
/// 開檔案總管的 xdg-open）繼承到就會載入 AppImage 裡版本不合的 .so 或外掛（GLib / GStreamer 符號錯誤、瀏覽器開不起來），
/// 甚至讓 `bash` / `python` 解析到 bundle 內的東西。
///
/// 規則（純函式）：值裡含 `appdir` 的變數，以 `:` 切開、拿掉落在 `appdir` 底下的項目；剩下的接回去，全被拿掉就刪除變數。
/// 只動「指向 AppImage 掛載點」的部分：使用者自己設的 `LD_LIBRARY_PATH`（例如 CUDA）原樣保留。
/// `appdir` 必須是 `/` 以外的絕對路徑，否則不做任何事（防止空字串 / `/` 把整個 PATH 清光）。
pub fn appimage_env_fixups<I, K, V>(appdir: &str, vars: I) -> Vec<(OsString, Option<OsString>)>
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<OsStr>,
    V: AsRef<OsStr>,
{
    let root = appdir.trim_end_matches('/');
    if !appdir.starts_with('/') || root.is_empty() {
        return Vec::new();
    }
    let under = |entry: &str| entry == root || entry.strip_prefix(root).is_some_and(|rest| rest.starts_with('/'));
    let mut out = Vec::new();
    for (k, v) in vars {
        let Some(val) = v.as_ref().to_str() else { continue };
        if !val.contains(root) {
            continue;
        }
        let kept: Vec<&str> = val.split(':').filter(|e| !under(e)).collect();
        if kept.len() == val.split(':').count() {
            continue; // 只是字串剛好含到，沒有一個項目真的落在 appdir 底下
        }
        let kept: Vec<&str> = kept.into_iter().filter(|e| !e.is_empty()).collect();
        let key = k.as_ref().to_os_string();
        out.push((key, if kept.is_empty() { None } else { Some(OsString::from(kept.join(":"))) }));
    }
    out
}

/// 本行程的 AppImage 清理結果（只算一次；不是從 AppImage 跑、或非 Linux → 空）。
#[cfg_attr(windows, allow(dead_code))]
fn appimage_env() -> &'static [(OsString, Option<OsString>)] {
    static FIXUPS: OnceLock<Vec<(OsString, Option<OsString>)>> = OnceLock::new();
    FIXUPS.get_or_init(|| {
        if !cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_none() {
            return Vec::new();
        }
        let Some(appdir) = std::env::var("APPDIR").ok() else { return Vec::new() };
        let mut v = appimage_env_fixups(&appdir, std::env::vars_os());
        // 這兩個只是在說「我是 AppImage」：傳給子程序只會讓別的程式（例如被 xdg-open 叫起來的另一個 AppImage）誤判
        for k in ["APPIMAGE", "APPDIR"] {
            if !v.iter().any(|(n, _)| n == k) {
                v.push((OsString::from(k), None));
            }
        }
        v
    })
}

/// std 的 Command（`reveal` / `open_url` 用）套同一份 AppImage 清理。
#[cfg(all(unix, not(target_os = "macos")))]
fn std_cmd(program: &str) -> std::process::Command {
    let mut c = std::process::Command::new(program);
    for (k, v) in appimage_env() {
        match v {
            Some(v) => c.env(k, v),
            None => c.env_remove(k),
        };
    }
    c
}

pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// 用 OS 檔案總管開啟並選取檔案（fire-and-forget）。
pub fn reveal(path: &std::path::Path) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("explorer");
        if path.is_file() {
            c.arg(format!("/select,{}", path.display()));
        } else {
            c.arg(path);
        }
        c.creation_flags(CREATE_NO_WINDOW);
        let _ = c.spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let mut c = std::process::Command::new("open");
        if path.is_file() {
            c.arg("-R");
        }
        c.arg(path);
        let _ = c.spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // xdg-open 沒有「選取檔案」的通用參數：開上層目錄
        let target = if path.is_file() { path.parent().unwrap_or(path) } else { path };
        let _ = std_cmd("xdg-open").arg(target).spawn();
    }
}

/// 以系統預設瀏覽器開啟外部連結（僅 http/https）。
pub fn open_url(url: &str) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", url]);
        c.creation_flags(CREATE_NO_WINDOW);
        let _ = c.spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std_cmd("xdg-open").arg(url).spawn();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appimage_fixups_strip_only_entries_under_the_mount() {
        let appdir = "/tmp/.mount_AI_VidAbc123";
        let vars = vec![
            ("PATH", "/tmp/.mount_AI_VidAbc123/usr/bin:/usr/local/bin:/usr/bin"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_AI_VidAbc123/usr/lib:/usr/local/cuda/lib64"),
            ("GST_PLUGIN_SYSTEM_PATH_1_0", "/tmp/.mount_AI_VidAbc123/usr/lib/gstreamer-1.0"),
            ("XDG_DATA_DIRS", "/tmp/.mount_AI_VidAbc123/usr/share:/usr/local/share:/usr/share"),
            ("HOME", "/home/alice"),
            // 前綴相同但不是掛載點底下（`…Abc1234`）→ 不動
            ("OTHER", "/tmp/.mount_AI_VidAbc1234/usr/lib"),
        ];
        let got = appimage_env_fixups(appdir, vars);
        let get = |k: &str| got.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(get("PATH"), Some(Some(OsString::from("/usr/local/bin:/usr/bin"))));
        assert_eq!(get("LD_LIBRARY_PATH"), Some(Some(OsString::from("/usr/local/cuda/lib64"))), "使用者自己的 CUDA 路徑要留著");
        assert_eq!(get("GST_PLUGIN_SYSTEM_PATH_1_0"), Some(None), "全是 bundle 內的 → 整個刪掉");
        assert_eq!(get("XDG_DATA_DIRS"), Some(Some(OsString::from("/usr/local/share:/usr/share"))));
        assert_eq!(get("HOME"), None, "無關的變數不出現在清單裡");
        assert_eq!(get("OTHER"), None);
        // appdir 不可靠時什麼都不做（不能把 PATH 清光）
        for bad in ["", "/", "relative/dir"] {
            assert!(appimage_env_fixups(bad, vec![("PATH", "/usr/bin:/bin")]).is_empty(), "{bad:?}");
        }
        // 結尾斜線視同沒有
        assert_eq!(appimage_env_fixups("/tmp/.mount_x/", vec![("P", "/tmp/.mount_x/bin:/bin")])[0].1, Some(OsString::from("/bin")));
    }

    #[test]
    fn which_in_scans_path_in_order_and_skips_relative_entries() {
        let dir = std::env::temp_dir().join(format!("aivc which 測試-{}", uuid::Uuid::new_v4()));
        let (a, b, c) = (dir.join("a"), dir.join("b"), dir.join("c"));
        for d in [&a, &b, &c] {
            std::fs::create_dir_all(d).unwrap();
        }
        let tool = "aivc-fake-tool";
        for d in [&b, &c] {
            let p = d.join(tool);
            std::fs::write(&p, b"#!/bin/sh\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        // a 裡同名的是目錄，不算
        std::fs::create_dir_all(a.join(tool)).unwrap();
        let pv = std::env::join_paths([a.clone(), b.clone(), c.clone(), b.clone(), PathBuf::from("relative")]).unwrap();
        assert_eq!(which_in(tool, Some(&pv)), vec![b.join(tool), c.join(tool)], "依 PATH 順序、去重、跳過相對目錄");
        assert!(which_in("nope-not-here", Some(&pv)).is_empty());
        assert!(which_in(tool, None).is_empty());
        assert!(which_in("", Some(&pv)).is_empty());
        assert!(which_in(&format!("b/{tool}"), Some(&pv)).is_empty(), "帶路徑的名字不掃 PATH");
        // 沒有執行權限的檔不算（unix）
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(c.join(tool), std::fs::Permissions::from_mode(0o644)).unwrap();
            assert_eq!(which_in(tool, Some(&pv)), vec![b.join(tool)]);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
