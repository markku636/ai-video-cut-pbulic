//! 媒體快取目錄 `<app_cache_dir>/media/<fp16>/`：**引擎擁有所有媒體邏輯**（索引 / proxy / 鏡頭 /
//! 遮罩 / 解算都是 Python 寫進來的），Rust 這邊只負責：目錄位置、狀態探測、安全讀檔（`cache_read`）。
//!
//! 目錄內容（計畫 §5.3）：`probe.v1.json index.v1.json shots.v1.json proxy.mp4 thumbs/ tracks/<id>/…`，
//! 全部可重生；缺了就是 `stale`，沒有專案 sidecar。
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::error::{AppError, AppResult};
use crate::store;

pub const PROXY_FILE: &str = "proxy.mp4";
pub const INDEX_FILE: &str = "index.v1.json";
pub const PROBE_FILE: &str = "probe.v1.json";
pub const SHOTS_FILE: &str = "shots.v1.json";
pub const THUMBS_DIR: &str = "thumbs";

/// `cache_read` 一次最多回多少（遮罩檔逐幀讀是幾 KB；整支 proxy 該走 asset protocol 而不是 IPC）。
pub const MAX_READ_BYTES: u64 = 64 * 1024 * 1024;

/// 指紋前 16 碼當目錄名。Python `env.media_cache_dir` 用同一個切法（`fingerprint[:16]`）。
pub fn media_dir(app: &AppHandle, fingerprint: &str) -> AppResult<PathBuf> {
    let fp: String = fingerprint.chars().take(16).collect();
    if fp.len() < 8 || !fp.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::Invalid("fingerprint 無效".into()));
    }
    let d = store::app_cache_dir(app)?.join("media").join(fp);
    std::fs::create_dir_all(&d)?;
    Ok(d)
}

#[derive(Serialize, Clone, Debug)]
pub struct CacheStatus {
    pub proxy: bool,
    pub index: bool,
    /// thumbs/ 目錄存在且裡面至少有一張。
    pub thumbs: bool,
    pub dir: String,
}

fn nonempty(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file() && m.len() > 0).unwrap_or(false)
}

pub fn cache_status(dir: &Path) -> CacheStatus {
    let thumbs = std::fs::read_dir(dir.join(THUMBS_DIR))
        .map(|rd| rd.flatten().any(|e| e.path().extension().is_some_and(|x| x == "png")))
        .unwrap_or(false);
    CacheStatus {
        proxy: nonempty(&dir.join(PROXY_FILE)),
        index: nonempty(&dir.join(INDEX_FILE)),
        thumbs,
        dir: dir.to_string_lossy().into_owned(),
    }
}

#[derive(Serialize, Clone)]
struct Progress<'a> {
    job_id: &'a str,
    phase: &'a str,
    pct: f32,
}

/// Rust 端自己跑的長工作（目前只有縮圖條）用的進度事件；引擎的進度走 `engine-progress`。
pub fn emit_progress(app: &AppHandle, job_id: &str, phase: &str, pct: f32) {
    let _ = app.emit("media-progress", Progress { job_id, phase, pct });
}

/// 把前端給的相對路徑接到快取目錄底下，**拒絕任何能逃出目錄的寫法**：
/// `..`、絕對路徑、磁碟前綴、`\\?\`、以及正規化後不在 `dir` 底下的結果。
///
/// 為什麼不用 canonicalize 比對就好：目標檔可能還不存在（引擎正在寫），canonicalize 會失敗；
/// 所以先做純字串層的元件檢查，再對「存在的那部分」做一次 starts_with 保險。
///
/// **元件切分不交給 `Path::components`**：它的規則跟著主機 OS 走 —— macOS / Linux 上 `\` 與 `:` 是一般檔名字元，
/// `..\x.png`、`C:\Windows\x` 會變成一個合法的 Normal 元件而放行，同一個相對路徑在 Windows 被拒、在 Linux 被收。
/// 改成三平台同一套：先把 `\` 當成分隔符（Windows 寫法的 `tracks\t1\masks.aivm` 在 macOS / Linux 也接得到），
/// 再拒絕任何 `:`（磁碟前綴 `C:`、NTFS 替代資料流 `a.png:x`；引擎產生的快取檔名都不會有冒號）。
pub fn safe_join(dir: &Path, rel: &str) -> AppResult<PathBuf> {
    let rel = rel.trim();
    if rel.is_empty() {
        return Err(AppError::Invalid("路徑不可為空".into()));
    }
    let norm = rel.replace('\\', "/");
    if norm.starts_with("//?/") || norm.starts_with("//./") {
        return Err(AppError::Invalid("路徑不合法".into()));
    }
    if norm.starts_with('/') || norm.contains(':') {
        return Err(AppError::Invalid("只接受相對於快取目錄的路徑".into()));
    }
    let mut out = dir.to_path_buf();
    for seg in norm.split('/') {
        match seg {
            "" | "." => {}
            ".." => return Err(AppError::Invalid("路徑不可包含 ..".into())),
            // Windows（Win32 路徑正規化）會吃掉元件結尾的 `.` 與空白：`.. `、`...` 實際上等於 `..` / `.`。
            // 正常檔名不會長這樣，三平台一律拒絕，不賭第二道防線
            s if s.trim_end_matches(['.', ' ']).is_empty() => {
                return Err(AppError::Invalid("路徑不可包含 ..".into()));
            }
            s => out.push(s),
        }
    }
    if !out.starts_with(dir) {
        return Err(AppError::Invalid("路徑逃出快取目錄".into()));
    }
    // 第二道：把「已存在的最深祖先」正規化後再比一次。字串層檢查擋不住 junction / symlink：
    // `tracks/evil` 若是指到 C:\Windows 的 junction，`tracks/evil/x` 每個元件都合法、卻讀到外面。
    // 目標本身可能還不存在（引擎正在寫），所以只對存在的那一段做 canonicalize。
    if let Some(e) = escapes_via_link(dir, &out) {
        return Err(e);
    }
    Ok(out)
}

/// `out` 已存在的最深祖先經 `dunce::canonicalize` 後不在 `dir`（同樣正規化）底下 → Some(錯誤)。
/// `dir` 本身不存在時沒東西可比（`media_dir` 一定先建好）→ None。
fn escapes_via_link(dir: &Path, out: &Path) -> Option<AppError> {
    let root = dunce::canonicalize(dir).ok()?;
    let mut probe = out;
    loop {
        if probe.exists() {
            let real = dunce::canonicalize(probe).ok()?;
            return (!real.starts_with(&root)).then(|| AppError::Invalid("路徑經由連結逃出快取目錄".into()));
        }
        probe = probe.parent()?;
    }
}

/// 讀檔的一段（`offset` / `len` 省略＝整檔）。回原始 bytes；大小上限 `MAX_READ_BYTES`。
pub async fn read_range(path: &Path, offset: Option<u64>, len: Option<u64>) -> AppResult<Vec<u8>> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| AppError::NotFound(format!("{}：{e}", path.display())))?;
    if !meta.is_file() {
        return Err(AppError::Invalid("不是檔案".into()));
    }
    let off = offset.unwrap_or(0).min(meta.len());
    let want = len.unwrap_or(meta.len().saturating_sub(off)).min(meta.len().saturating_sub(off));
    if want > MAX_READ_BYTES {
        return Err(AppError::Invalid(format!("一次最多讀 {} MB（要 {} MB）", MAX_READ_BYTES >> 20, want >> 20)));
    }
    let mut f = tokio::fs::File::open(path).await?;
    if off > 0 {
        f.seek(std::io::SeekFrom::Start(off)).await?;
    }
    let mut buf = vec![0u8; want as usize];
    f.read_exact(&mut buf).await?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("aivc media 測試-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn safe_join_accepts_plain_relative_paths() {
        let dir = tmpdir();
        assert_eq!(safe_join(&dir, "proxy.mp4").unwrap(), dir.join("proxy.mp4"));
        assert_eq!(safe_join(&dir, "tracks/t1/masks.aivm").unwrap(), dir.join("tracks").join("t1").join("masks.aivm"));
        assert_eq!(safe_join(&dir, "./thumbs/t-0-32-h48-v1.png").unwrap(), dir.join("thumbs").join("t-0-32-h48-v1.png"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn safe_join_rejects_traversal_and_absolute_paths() {
        let dir = tmpdir();
        for bad in ["../x", "a/../../b", "..", "/etc/passwd", "C:\\Windows\\x", "\\\\?\\C:\\x", "//?/C:/x", "", "  "] {
            assert!(safe_join(&dir, bad).is_err(), "{bad:?} 應被拒");
        }
        // 反斜線寫法：以前只在 Windows 被拒（macOS / Linux 上 `\` 是一般檔名字元），現在三平台一致
        for bad in ["\\x", "tracks\\..\\..\\x", "..\\x.png", "\\\\server\\share\\x", "\\\\.\\C:\\x", "C:x", "D:/x", "a.png:stream", "tracks/.. /x", "..."] {
            assert!(safe_join(&dir, bad).is_err(), "{bad:?} 應被拒");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn safe_join_treats_backslash_as_separator_on_every_os() {
        let dir = tmpdir();
        // Windows 寫法的相對路徑（`tracks\t1\masks.aivm`）在 macOS / Linux 也要接成三層，而不是一個叫 `tracks\t1\masks.aivm` 的檔
        assert_eq!(safe_join(&dir, "tracks\\t1\\masks.aivm").unwrap(), dir.join("tracks").join("t1").join("masks.aivm"));
        assert_eq!(safe_join(&dir, "tracks//t1/./masks.aivm").unwrap(), dir.join("tracks").join("t1").join("masks.aivm"));
        // 檔名本身含點（`.part`、版本號）照樣合法
        assert_eq!(safe_join(&dir, "thumbs/t-0-32-h48-v1.png.part").unwrap(), dir.join("thumbs").join("t-0-32-h48-v1.png.part"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// symlink 逃出（macOS / Linux 版的 junction 測試）：`tracks` 指到外面，`tracks/secret.txt` 每個元件都合法但實際在外面。
    #[cfg(unix)]
    #[test]
    fn safe_join_rejects_escape_through_symlink() {
        let dir = tmpdir();
        let outside = tmpdir();
        std::fs::write(outside.join("secret.txt"), b"s").unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("tracks")).unwrap();
        assert!(safe_join(&dir, "tracks/secret.txt").is_err(), "經 symlink 讀到外面要被拒");
        assert!(safe_join(&dir, "tracks/not-yet-written.bin").is_err(), "目標不存在也要用存在的祖先判");
        assert!(safe_join(&dir, "tracks").is_err(), "連結本身也不行");
        assert!(safe_join(&dir, "thumbs/t-0-32-h48-v1.png").is_ok());
        assert!(safe_join(&dir, "proxy.mp4").is_ok());
        // 快取根目錄本身在 symlink 底下（macOS 的 /var → /private/var）不能誤判成逃出
        let via_link = outside.join("cache-link");
        std::os::unix::fs::symlink(&dir, &via_link).unwrap();
        assert!(safe_join(&via_link, "proxy.mp4").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    /// junction 逃出：`tracks` 是指到外面的連結，`tracks/secret.txt` 每個元件都合法但實際在外面。
    /// `mklink /J` 不需要管理員權限；不可用（沙盒）就跳過。
    #[cfg(windows)]
    #[test]
    fn safe_join_rejects_escape_through_junction() {
        let dir = tmpdir();
        let outside = tmpdir();
        std::fs::write(outside.join("secret.txt"), b"s").unwrap();
        let link = dir.join("tracks");
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J", &link.to_string_lossy(), &outside.to_string_lossy()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !made || !link.join("secret.txt").is_file() {
            eprintln!("SKIP: mklink /J 不可用");
            let _ = std::fs::remove_dir_all(&dir);
            let _ = std::fs::remove_dir_all(&outside);
            return;
        }
        assert!(safe_join(&dir, "tracks/secret.txt").is_err(), "經 junction 讀到外面要被拒");
        assert!(safe_join(&dir, "tracks/not-yet-written.bin").is_err(), "目標不存在也要用存在的祖先判");
        assert!(safe_join(&dir, "tracks").is_err(), "連結本身也不行");
        // 正常的、還不存在的子路徑照樣放行（引擎正在寫的檔）
        assert!(safe_join(&dir, "thumbs/t-0-32-h48-v1.png").is_ok());
        assert!(safe_join(&dir, "proxy.mp4").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[tokio::test]
    async fn read_range_respects_offset_and_len() {
        let dir = tmpdir();
        let p = dir.join("f.bin");
        std::fs::write(&p, (0u8..=255).collect::<Vec<u8>>()).unwrap();
        assert_eq!(read_range(&p, None, None).await.unwrap().len(), 256);
        assert_eq!(read_range(&p, Some(10), Some(3)).await.unwrap(), vec![10, 11, 12]);
        // 超過檔尾就截到檔尾，不報錯（讀最後一幀的 RLE 常常剛好貼著 EOF）
        assert_eq!(read_range(&p, Some(250), Some(100)).await.unwrap(), vec![250, 251, 252, 253, 254, 255]);
        assert!(read_range(&p, Some(999), Some(1)).await.unwrap().is_empty());
        assert!(matches!(read_range(&dir.join("nope"), None, None).await, Err(AppError::NotFound(_))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn cache_status_reports_each_artifact() {
        let dir = tmpdir();
        let s = cache_status(&dir);
        assert!(!s.proxy && !s.index && !s.thumbs);
        std::fs::write(dir.join(PROXY_FILE), b"x").unwrap();
        std::fs::write(dir.join(INDEX_FILE), b"").unwrap(); // 空檔不算
        std::fs::create_dir_all(dir.join(THUMBS_DIR)).unwrap();
        std::fs::write(dir.join(THUMBS_DIR).join("t-0-32-h48-v1.png"), b"png").unwrap();
        let s = cache_status(&dir);
        assert!(s.proxy && !s.index && s.thumbs);
        assert_eq!(s.dir, dir.to_string_lossy());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
