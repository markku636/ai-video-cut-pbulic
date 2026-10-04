//! ffmpeg / ffprobe：偵測、探測媒體資訊（影片欄位完整版）、媒體指紋、編碼器清單與可用性。
//!
//! 所有子程序走 `proc::cmd`（不彈黑窗）；路徑一律以 OsStr 傳參（不經 shell），中文 / 空白安全。
//! 這裡只做「問 ffmpeg」；索引 / proxy / 編碼全在 Python 引擎（決策 2）。
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::proc;

#[derive(Debug, Clone, Serialize)]
pub struct FfmpegBins {
    pub ffmpeg: String,
    pub ffprobe: String,
    pub version: String,
    /// custom / path / bundled / common
    pub source: String,
}

/// 安裝檔內建的 ffmpeg 在 resource_dir 底下的相對位置。
/// tauri 的 `bundle.resources` 會保留來源目錄結構，所以 `src-tauri/resources/ffmpeg/`
/// 進到安裝目錄後就是 `<resource_dir>/resources/ffmpeg/`。
const BUNDLED_SUBDIR: [&str; 2] = ["resources", "ffmpeg"];

/// 內建版的候選目錄。抽成純函式才測得到 —— 這條路徑對不上時的症狀是
/// 「安裝完還是說找不到 ffmpeg」，而且完全沒有錯誤訊息可查。
///
/// `resource_dir` 各平台由 Tauri 算好：Windows（NSIS）是安裝目錄、macOS 是 `<App>.app/Contents/Resources`、
/// deb 是 `/usr/lib/<產品名>`、AppImage 是 `$APPDIR/usr/lib/<產品名>`；底下接的都是同一段 `resources/ffmpeg`。
pub fn bundled_candidate(resource_dir: &Path) -> PathBuf {
    let mut p = resource_dir.to_path_buf();
    for seg in BUNDLED_SUBDIR {
        p.push(seg);
    }
    p
}

/// 內建版的全部候選（依序，呼叫端取第一個存在的目錄）。一般就是 `bundled_candidate` 一個；
/// 另外容忍 macOS 拿到的是執行檔目錄 `<App>.app/Contents/MacOS`：Tauri 2 正常回 `Contents/Resources`，
/// 但它在 canonicalize 失敗、或 bundle 被手動搬動 / 重新簽章後退回 exe 目錄時，resources 其實在隔壁的 `Contents/Resources`。
pub fn bundled_candidates(resource_dir: &Path) -> Vec<PathBuf> {
    let mut v = vec![bundled_candidate(resource_dir)];
    let is_macos_exe_dir = resource_dir.file_name().is_some_and(|n| n == "MacOS")
        && resource_dir.parent().and_then(Path::file_name).is_some_and(|n| n == "Contents");
    if is_macos_exe_dir {
        if let Some(contents) = resource_dir.parent() {
            v.push(bundled_candidate(&contents.join("Resources")));
        }
    }
    v
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn sibling_probe(ffmpeg: &Path) -> Option<PathBuf> {
    let p = ffmpeg.parent()?.join(exe("ffprobe"));
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

async fn version_of(ffmpeg: &Path) -> Option<String> {
    let mut c = proc::cmd(&ffmpeg.to_string_lossy());
    c.arg("-version");
    let out = c.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let first = s.lines().next()?;
    // "ffmpeg version 7.1-essentials_build-www.gyan.dev Copyright ..."
    let v = first.strip_prefix("ffmpeg version ").unwrap_or(first);
    Some(v.split_whitespace().next().unwrap_or(v).to_string())
}

async fn try_candidate(path: PathBuf, source: &str) -> Option<FfmpegBins> {
    let ffmpeg = if path.is_dir() { path.join(exe("ffmpeg")) } else { path };
    if !ffmpeg.is_file() {
        return None;
    }
    let ffprobe = sibling_probe(&ffmpeg)?;
    let version = version_of(&ffmpeg).await?;
    Some(FfmpegBins {
        ffmpeg: ffmpeg.to_string_lossy().into_owned(),
        ffprobe: ffprobe.to_string_lossy().into_owned(),
        version,
        source: source.to_string(),
    })
}

fn windows_common_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    for root in ["C:\\", "D:\\"] {
        if let Ok(rd) = std::fs::read_dir(root) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_lowercase();
                if n.starts_with("ffmpeg") {
                    v.push(e.path().join("bin"));
                    v.push(e.path());
                }
            }
        }
    }
    if let Some(la) = std::env::var_os("LOCALAPPDATA") {
        v.push(PathBuf::from(la).join("Microsoft").join("WinGet").join("Links"));
    }
    if let Some(pf) = std::env::var_os("ProgramFiles") {
        v.push(PathBuf::from(pf).join("ffmpeg").join("bin"));
    }
    v
}

/// macOS / Linux 的常見安裝目錄（純函式：`os` 是 `std::env::consts::OS`、`home` 是 `$HOME`，兩種形狀在任何主機上都測得到）。
///
/// 為什麼 PATH 不夠：從 Finder / Dock 開的 App 拿到的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，
/// Homebrew 的 `/opt/homebrew/bin`（Apple Silicon）與 `/usr/local/bin`（Intel 版 Homebrew / 手動安裝）都不在裡面，
/// `brew install ffmpeg` 過的機器照樣「找不到 ffmpeg」。macOS / Linux 版不內建 ffmpeg，這一層就是主要的找法。
/// - `ffmpeg-full` 是 keg-only 公式，不會連進 `/opt/homebrew/bin`，要直接看它的 opt 目錄；
/// - MacPorts 是 `/opt/local/bin`；
/// - Linux：發行版套件在 `/usr/bin`（deb 的 depends 裝的就是它）、自行編譯在 `/usr/local/bin`、Homebrew on Linux 在
///   `/home/linuxbrew/.linuxbrew/bin` 或 `~/.linuxbrew/bin`、靜態 build 常被丟到 `~/.local/bin` / `~/bin`。
///   Snap 的 ffmpeg 不列：它的 ffprobe 叫 `ffmpeg.ffprobe`，不符合「同目錄的 ffprobe」規則。
pub fn unix_common_dirs(os: &str, home: Option<&Path>) -> Vec<PathBuf> {
    let fixed: &[&str] = if os == "macos" {
        &["/opt/homebrew/bin", "/usr/local/bin", "/opt/homebrew/opt/ffmpeg-full/bin", "/usr/local/opt/ffmpeg-full/bin", "/opt/local/bin", "/usr/bin"]
    } else {
        &["/usr/local/bin", "/usr/bin", "/home/linuxbrew/.linuxbrew/bin", "/opt/homebrew/bin"]
    };
    let mut v: Vec<PathBuf> = fixed.iter().map(PathBuf::from).collect();
    if os != "macos" {
        // has_root 而不是 is_absolute：語意相同（unix 上），但在 Windows 主機跑單元測試時 `/home/alice` 也算數
        if let Some(h) = home.filter(|h| h.has_root()) {
            v.push(h.join(".linuxbrew").join("bin"));
            v.push(h.join(".local").join("bin"));
            v.push(h.join("bin"));
        }
    }
    v
}

fn common_dirs() -> Vec<PathBuf> {
    if cfg!(windows) {
        windows_common_dirs()
    } else {
        unix_common_dirs(std::env::consts::OS, proc::home_dir().as_deref())
    }
}

/// 解析順序：使用者自訂路徑 → 安裝檔內建 → PATH（where / PATH 掃描）→ 常見安裝目錄（`common_dirs`，含 Homebrew）。
/// ffprobe 必須與 ffmpeg 同目錄（`sibling_probe`）。
///
/// 內建版排在 PATH **之前**（計畫決策 6：`AIVC_FFMPEG_DIR → resources/ffmpeg → PATH`）。ai-music-cut 是 PATH 優先，
/// 但這裡引擎的編碼計畫依賴內建 build 驗過的能力（libopenh264 確定性 fallback、ffv1／prores 中間檔、NVENC）與 LGPL 授權；
/// 2026-09-17 安裝版實測：使用者 PATH 上有 gyan.dev 7.1 essentials（GPL、沒有 libopenh264）→ 蓋過了內建 n8.1.2。
/// 想用自己的 build 請在設定指定路徑（自訂仍是第一順位）。
/// 只有 Windows 版內建：macOS / Linux 的 resources/ffmpeg 只有 README，內建這一格自然落空，實際靠 PATH 與常見目錄。
pub async fn resolve(custom: Option<&str>, bundled_dir: Option<&Path>) -> Option<FfmpegBins> {
    let path_hits: Vec<PathBuf> = proc::which("ffmpeg").await.into_iter().map(PathBuf::from).collect();
    for (cand, source) in resolution_order(custom, bundled_dir, &path_hits, common_dirs()) {
        if let Some(b) = try_candidate(cand, source).await {
            return Some(b);
        }
    }
    None
}

/// 候選清單（依序嘗試）。純函式：順序是這個模組最重要的政策，單元測試直接釘住它。
pub fn resolution_order(custom: Option<&str>, bundled_dir: Option<&Path>, path_hits: &[PathBuf], common: Vec<PathBuf>) -> Vec<(PathBuf, &'static str)> {
    let mut v: Vec<(PathBuf, &'static str)> = Vec::new();
    if let Some(c) = custom.map(str::trim).filter(|s| !s.is_empty()) {
        v.push((PathBuf::from(c), "custom"));
    }
    if let Some(d) = bundled_dir {
        v.push((d.to_path_buf(), "bundled"));
    }
    v.extend(path_hits.iter().cloned().map(|p| (p, "path")));
    v.extend(common.into_iter().map(|p| (p, "common")));
    v
}

// ---------------- probe ----------------

/// 有理數（fps / time_base）。時間模型是「整數幀號 + 有理數 fps」（決策 3），所以這裡不能是 f64。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Rational {
    pub num: i64,
    pub den: i64,
}

impl Rational {
    pub const ZERO: Rational = Rational { num: 0, den: 1 };

    pub fn is_zero(&self) -> bool {
        self.num == 0 || self.den == 0
    }

    pub fn as_f64(&self) -> f64 {
        if self.den == 0 {
            0.0
        } else {
            self.num as f64 / self.den as f64
        }
    }
}

/// 解析 ffprobe 的 `"30/1"` / `"30000/1001"` / `"0/0"` / `"30"`。分母 0 或解析失敗 → ZERO。
pub fn parse_rational(s: &str) -> Rational {
    let s = s.trim();
    if s.is_empty() {
        return Rational::ZERO;
    }
    let (n, d) = match s.split_once('/') {
        Some((n, d)) => (n.trim(), d.trim()),
        None => (s, "1"),
    };
    match (n.parse::<i64>(), d.parse::<i64>()) {
        (Ok(num), Ok(den)) if den != 0 => Rational { num, den },
        _ => Rational::ZERO,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AudioStream {
    pub codec: String,
    pub sample_rate: u32,
    pub channels: u32,
    /// 逐軌位元率；ffprobe 沒給時退 Matroska 的 `BPS` 標籤（mkvmerge 寫的統計）。WebM / Opus 常常兩者皆無。
    pub bit_rate: Option<u64>,
    // ---- 以下是「媒體資訊」對話框用的補充欄位 ----
    // 全部是 Option：專案檔裡存的是舊版 probe（沒有這些鍵），前端一律當「可能沒有」處理，
    // 所以新增欄位不必動專案 schema，也不會讓舊專案讀不進來。
    pub codec_long_name: Option<String>,
    /// AAC 的 "LC" / "HE-AAC" 等；多數編碼沒有。
    pub profile: Option<String>,
    /// "stereo" / "5.1(side)"；只有聲道數時 ffprobe 不給 → None。
    pub channel_layout: Option<String>,
    /// "fltp" / "s16"…（解碼後的取樣格式，不是位元流的位元深度）。
    pub sample_fmt: Option<String>,
    /// PCM 類才有意義的位元深度：`bits_per_sample`，其次 `bits_per_raw_sample`；0（有損編碼）→ None。
    pub bits_per_sample: Option<u32>,
    /// 逐軌時長：`duration`，其次 Matroska 的 `DURATION` 標籤（ffmpeg / mkvmerge 寫的 mkv 只有標籤沒有欄位）。
    pub duration_ms: Option<u64>,
    /// 起始時間（毫秒）；和影片軌相減就是 MediaInfo 的「相對於視訊的延遲」。
    pub start_time_ms: Option<i64>,
}

/// 影片軌。範例 WebM 的實況：`nb_frames`/`duration` **沒有**、`r_frame_rate` 30/1、`time_base` 1/1000、
/// 色彩 tags 全 unknown（→ None）—— 所以這些全是 Option，前端不可假設有值。
#[derive(Debug, Clone, Serialize)]
pub struct VideoStream {
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub pix_fmt: String,
    pub r_frame_rate: Rational,
    pub avg_frame_rate: Rational,
    pub time_base: Rational,
    pub nb_frames: Option<u64>,
    pub duration_ms: Option<u64>,
    pub start_time_ms: Option<i64>,
    pub color_range: Option<String>,
    pub color_space: Option<String>,
    pub color_transfer: Option<String>,
    pub color_primaries: Option<String>,
    /// 來自 side_data `Display Matrix` 的 rotation（度，ffprobe 原值，順時針為負）；沒有就是 0。
    pub rotation: i32,
    /// ffprobe 的 `has_b_frames`（重排深度；0 = 沒有 B-frame）。
    pub has_b_frames: u32,
    /// 逐軌位元率；ffprobe 沒給時退 Matroska 的 `BPS` 標籤。範例 WebM 兩者皆無 → None。
    pub bit_rate: Option<u64>,
    // ---- 以下是「媒體資訊」對話框用的補充欄位（全是 Option，理由同 AudioStream）----
    pub codec_long_name: Option<String>,
    /// "High" / "Main 10" / "Profile 0"。
    pub profile: Option<String>,
    /// ffprobe 的 `level` 原始整數（H.264 41 = 4.1、HEVC 123 = 4.1×30、AV1 是 seq_level_idx）；
    /// -99（未知）→ None。換算成人話依 codec 而異，放在前端的純函式裡做（有測試）。
    pub level: Option<i64>,
    /// FourCC（`codec_tag_string`，例如 "avc1" / "hvc1"）；Matroska / WebM 沒有 FourCC 會回 `[0][0][0][0]` → None。
    pub codec_tag: Option<String>,
    /// 位元流的位元深度（"8" / "10"）；VP9 等不回報時 None，前端再由 pix_fmt 推。
    pub bits_per_raw_sample: Option<u32>,
    /// "progressive" / "tt" / "bb" / "tb" / "bt"；VP9 / AV1 這類只有逐行的編碼通常不回報 → None。
    pub field_order: Option<String>,
    /// 4:2:0 的色度取樣位置（"left" / "center" / "topleft"…）；unspecified → None。
    pub chroma_location: Option<String>,
    /// 像素比（SAR）"1:1"；"0:1"（未知）→ None。
    pub sample_aspect_ratio: Option<Rational>,
    /// 顯示比例（DAR）"16:9"。
    pub display_aspect_ratio: Option<Rational>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MediaProbe {
    pub path: String,
    pub size_bytes: u64,
    /// 容器層 duration；範例 WebM 沒有 → 0。真長度要等引擎建索引（`index.v1.json`）。
    pub duration_ms: u64,
    pub container: String,
    pub audio: Option<AudioStream>,
    /// mp3 封面圖（attached_pic）不算影片。
    pub video: Option<VideoStream>,
    pub fingerprint: String,
    // ---- 以下是「媒體資訊」對話框用的補充欄位（全是 Option，理由同 AudioStream）----
    /// "QuickTime / MOV" / "Matroska / WebM"。
    pub format_long_name: Option<String>,
    /// 容器層整體位元率（含所有軌）；WebM 常常沒有 → None，前端改用 檔案大小 ÷ 時長 估計並標明。
    pub bit_rate: Option<u64>,
    /// 標籤 `creation_time`（ISO 8601 原字串，不轉時區）：容器層優先，其次影片軌。
    pub creation_time: Option<String>,
    /// 寫檔程式（`encoder` / Matroska 大寫 `ENCODER`）：容器層優先，其次影片軌。範例 WebM 是 "Chrome"。
    pub encoder: Option<String>,
    /// 起始時間碼標籤（"01:00:00;00"）：容器層 → 影片軌 → 任一軌（mp4 的 tmcd 資料軌）。
    pub timecode: Option<String>,
}

fn parse_num<T: std::str::FromStr>(v: &serde_json::Value) -> Option<T> {
    v.as_str().and_then(|s| s.parse::<T>().ok())
}

fn opt_str(v: &serde_json::Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty() && *s != "unknown").map(str::to_string)
}

fn secs_to_ms(v: &serde_json::Value) -> Option<f64> {
    parse_num::<f64>(v).filter(|d| d.is_finite()).map(|d| d * 1000.0)
}

/// 數字欄位：ffprobe 有時給字串（"8"）有時給數字（`bits_per_sample: 0`），兩種都收。
fn num_or_str<T: std::str::FromStr + TryFrom<u64>>(v: &serde_json::Value) -> Option<T> {
    if let Some(n) = v.as_u64() {
        return T::try_from(n).ok();
    }
    parse_num::<T>(v)
}

/// 標籤查詢不分大小寫：mp4 寫 `encoder`、Matroska 寫 `ENCODER` / `DURATION`，同一個意思。
pub fn tag_ci(tags: &serde_json::Value, key: &str) -> Option<String> {
    tags.as_object()?
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .and_then(|(_, v)| opt_str(v))
}

/// "16:9" / "1:1"；"0:1"、"N/A"、缺 → None（未知比例不能當 0 顯示）。
pub fn parse_aspect_ratio(v: &serde_json::Value) -> Option<Rational> {
    let (n, d) = v.as_str()?.trim().split_once(':')?;
    match (n.trim().parse::<i64>(), d.trim().parse::<i64>()) {
        (Ok(num), Ok(den)) if num > 0 && den > 0 => Some(Rational { num, den }),
        _ => None,
    }
}

/// Matroska 的 `DURATION` 標籤 "00:00:59.916000000"（h:mm:ss.fffffffff）→ 毫秒。
pub fn parse_hms_ms(s: &str) -> Option<u64> {
    let mut parts = s.trim().split(':');
    let (h, m, sec) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let total = h.parse::<f64>().ok()? * 3600.0 + m.parse::<f64>().ok()? * 60.0 + sec.parse::<f64>().ok()?;
    (total.is_finite() && total >= 0.0).then(|| (total * 1000.0).round() as u64)
}

/// 逐軌時長：`duration` 欄位，其次 Matroska `DURATION` 標籤。
fn stream_duration_ms(s: &serde_json::Value) -> Option<u64> {
    secs_to_ms(&s["duration"])
        .map(|d| d.round() as u64)
        .or_else(|| tag_ci(&s["tags"], "DURATION").and_then(|t| parse_hms_ms(&t)))
}

/// 逐軌位元率：`bit_rate` 欄位，其次 Matroska `BPS` 標籤（mkvmerge 的統計標籤）。
fn stream_bit_rate(s: &serde_json::Value) -> Option<u64> {
    parse_num::<u64>(&s["bit_rate"])
        .or_else(|| tag_ci(&s["tags"], "BPS").and_then(|t| t.parse::<u64>().ok()))
        .filter(|b| *b > 0)
}

/// FourCC：Matroska / WebM 沒有 → ffprobe 回 `[0][0][0][0]`，那不是資訊。
fn codec_tag_of(s: &serde_json::Value) -> Option<String> {
    opt_str(&s["codec_tag_string"]).filter(|t| !t.starts_with("[0]"))
}

/// 轉向：`side_data_list[].rotation`（Display Matrix）優先，其次舊式 `tags.rotate`。
pub fn rotation_of(stream: &serde_json::Value) -> i32 {
    if let Some(list) = stream["side_data_list"].as_array() {
        for sd in list {
            if let Some(r) = sd.get("rotation") {
                if let Some(f) = r.as_f64() {
                    return f.round() as i32;
                }
                if let Some(i) = parse_num::<f64>(r) {
                    return i.round() as i32;
                }
            }
        }
    }
    parse_num::<f64>(&stream["tags"]["rotate"]).map(|f| f.round() as i32).unwrap_or(0)
}

/// 從 ffprobe 的一個 stream 物件組 `VideoStream`（純函式，可餵範例 JSON 測）。
pub fn video_stream_from(s: &serde_json::Value) -> VideoStream {
    VideoStream {
        codec: s["codec_name"].as_str().unwrap_or("").to_string(),
        width: s["width"].as_u64().unwrap_or(0) as u32,
        height: s["height"].as_u64().unwrap_or(0) as u32,
        pix_fmt: s["pix_fmt"].as_str().unwrap_or("").to_string(),
        r_frame_rate: parse_rational(s["r_frame_rate"].as_str().unwrap_or("")),
        avg_frame_rate: parse_rational(s["avg_frame_rate"].as_str().unwrap_or("")),
        time_base: parse_rational(s["time_base"].as_str().unwrap_or("")),
        nb_frames: parse_num::<u64>(&s["nb_frames"]).filter(|n| *n > 0),
        // Matroska 的 DURATION 標籤也算標頭時長（ffmpeg 寫的 mkv 只有標籤）；前端目前只拿來顯示，不拿來算幀數
        duration_ms: stream_duration_ms(s),
        start_time_ms: secs_to_ms(&s["start_time"]).map(|d| d.round() as i64),
        color_range: opt_str(&s["color_range"]),
        color_space: opt_str(&s["color_space"]),
        color_transfer: opt_str(&s["color_transfer"]),
        color_primaries: opt_str(&s["color_primaries"]),
        rotation: rotation_of(s),
        has_b_frames: s["has_b_frames"].as_u64().unwrap_or(0) as u32,
        bit_rate: stream_bit_rate(s),
        codec_long_name: opt_str(&s["codec_long_name"]),
        profile: opt_str(&s["profile"]),
        // -99 = FF_LEVEL_UNKNOWN；其他負數也沒有意義
        level: s["level"].as_i64().filter(|l| *l >= 0),
        codec_tag: codec_tag_of(s),
        bits_per_raw_sample: num_or_str::<u32>(&s["bits_per_raw_sample"]).filter(|b| *b > 0),
        field_order: opt_str(&s["field_order"]),
        chroma_location: opt_str(&s["chroma_location"]).filter(|c| c != "unspecified"),
        sample_aspect_ratio: parse_aspect_ratio(&s["sample_aspect_ratio"]),
        display_aspect_ratio: parse_aspect_ratio(&s["display_aspect_ratio"]),
    }
}

/// 從 ffprobe 的一個音訊 stream 物件組 `AudioStream`（純函式）。
pub fn audio_stream_from(s: &serde_json::Value) -> AudioStream {
    AudioStream {
        codec: s["codec_name"].as_str().unwrap_or("").to_string(),
        sample_rate: parse_num::<u32>(&s["sample_rate"]).unwrap_or(0),
        channels: s["channels"].as_u64().unwrap_or(0) as u32,
        bit_rate: stream_bit_rate(s),
        codec_long_name: opt_str(&s["codec_long_name"]),
        profile: opt_str(&s["profile"]),
        channel_layout: opt_str(&s["channel_layout"]),
        sample_fmt: opt_str(&s["sample_fmt"]),
        bits_per_sample: num_or_str::<u32>(&s["bits_per_sample"])
            .filter(|b| *b > 0)
            .or_else(|| num_or_str::<u32>(&s["bits_per_raw_sample"]).filter(|b| *b > 0)),
        duration_ms: stream_duration_ms(s),
        start_time_ms: secs_to_ms(&s["start_time"]).map(|d| d.round() as i64),
    }
}

/// ffprobe `-show_format -show_streams` 的整份 JSON → `MediaProbe`（純函式；`fingerprint` 留空由呼叫端補）。
/// 抽出來是為了能用真實 ffprobe 輸出當 fixture 測「新欄位有沒有被讀到、序列化鍵名是否對得上 api.ts」。
pub fn probe_from_json(v: &serde_json::Value, path: &str, size_bytes: u64) -> AppResult<MediaProbe> {
    let fmt = &v["format"];
    let duration_ms = secs_to_ms(&fmt["duration"]).map(|d| d.round() as u64).unwrap_or(0);
    let container = fmt["format_name"].as_str().unwrap_or("").to_string();
    let streams = v["streams"].as_array().cloned().unwrap_or_default();
    let mut audio = None;
    let mut video = None;
    let mut video_json: Option<&serde_json::Value> = None;
    for s in &streams {
        match s["codec_type"].as_str() {
            Some("audio") if audio.is_none() => audio = Some(audio_stream_from(s)),
            Some("video") if video.is_none() => {
                let attached = s["disposition"]["attached_pic"].as_u64().unwrap_or(0) == 1;
                if !attached {
                    video = Some(video_stream_from(s));
                    video_json = Some(s);
                }
            }
            _ => {}
        }
    }
    // 影片工具：無音軌的檔（螢幕錄影、序列轉出的 mp4）是常態，只有兩者皆無才是「不是媒體」。
    if audio.is_none() && video.is_none() {
        return Err(AppError::Invalid("這個檔案沒有影像軌也沒有音軌".into()));
    }
    let null = serde_json::Value::Null;
    let vtags = video_json.map(|s| &s["tags"]).unwrap_or(&null);
    // 容器層優先：mp4 的 creation_time / encoder 容器與各軌都有，容器層才是「這個檔案」的；
    // 時間碼在 mp4 放在 tmcd 資料軌（codec_type = data），所以最後掃一遍所有軌。
    let from_fmt_or_video = |key: &str| tag_ci(&fmt["tags"], key).or_else(|| tag_ci(vtags, key));
    let timecode = from_fmt_or_video("timecode").or_else(|| streams.iter().find_map(|s| tag_ci(&s["tags"], "timecode")));
    Ok(MediaProbe {
        path: path.to_string(),
        size_bytes,
        duration_ms,
        container,
        audio,
        video,
        fingerprint: String::new(),
        format_long_name: opt_str(&fmt["format_long_name"]),
        bit_rate: parse_num::<u64>(&fmt["bit_rate"]).filter(|b| *b > 0),
        creation_time: from_fmt_or_video("creation_time"),
        encoder: from_fmt_or_video("encoder"),
        timecode,
    })
}

pub async fn probe(bins: &FfmpegBins, path: &str) -> AppResult<MediaProbe> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| AppError::NotFound(format!("{path}：{e}")))?;
    let mut c = proc::cmd(&bins.ffprobe);
    c.args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"]);
    c.arg(path);
    let out = c
        .output()
        .await
        .map_err(|e| AppError::Ffmpeg(format!("ffprobe 啟動失敗：{e}")))?;
    if !out.status.success() {
        return Err(AppError::Ffmpeg(format!(
            "ffprobe 失敗：{}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| AppError::Ffmpeg(format!("ffprobe 輸出解析失敗：{e}")))?;
    let mut probe = probe_from_json(&v, path, meta.len())?;
    let p = path.to_string();
    probe.fingerprint = tokio::task::spawn_blocking(move || fingerprint(&p))
        .await
        .map_err(|e| AppError::Io(e.to_string()))??;
    Ok(probe)
}

/// 媒體指紋：blake3(size_le_u64 ‖ 首 min(4 MiB, size) ‖ 尾 4 MiB（只在 size > 4 MiB 時））。
/// 不讀整檔；**Python `media/fingerprint.py` 必須逐位元重現**（共用測試向量），hex 前 16 碼為快取目錄名。
pub fn fingerprint(path: &str) -> AppResult<String> {
    const CHUNK: u64 = 4 * 1024 * 1024;
    let mut f = std::fs::File::open(path)?;
    let size = f.metadata()?.len();
    let mut h = blake3::Hasher::new();
    h.update(&size.to_le_bytes());
    let mut head = vec![0u8; CHUNK.min(size) as usize];
    f.read_exact(&mut head)?;
    h.update(&head);
    if size > CHUNK {
        f.seek(SeekFrom::Start(size - CHUNK))?;
        let mut tail = vec![0u8; CHUNK as usize];
        f.read_exact(&mut tail)?;
        h.update(&tail);
    }
    Ok(h.finalize().to_hex().to_string())
}

// ---------------- encoders ----------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EncoderInfo {
    pub name: String,
    /// "video" | "audio" | "subtitle"
    pub kind: String,
    pub description: String,
}

/// 解析 `ffmpeg -hide_banner -encoders` 的輸出：
/// ```text
/// Encoders:
///  V..... = Video
///  ...
///  ------
///  V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
/// ```
pub fn parse_encoders(out: &str) -> Vec<EncoderInfo> {
    let mut seen_rule = false;
    let mut v = Vec::new();
    for line in out.lines() {
        let t = line.trim();
        if !seen_rule {
            if t.starts_with("------") {
                seen_rule = true;
            }
            continue;
        }
        let mut parts = t.splitn(3, char::is_whitespace).filter(|s| !s.is_empty());
        let (Some(flags), Some(name)) = (parts.next(), parts.next()) else { continue };
        if flags.len() < 6 {
            continue;
        }
        let kind = match flags.chars().next() {
            Some('V') => "video",
            Some('A') => "audio",
            Some('S') => "subtitle",
            _ => continue,
        };
        v.push(EncoderInfo {
            name: name.to_string(),
            kind: kind.to_string(),
            description: parts.next().unwrap_or("").trim().to_string(),
        });
    }
    v
}

static ENCODERS_CACHE: parking_lot::Mutex<Option<HashMap<String, Vec<EncoderInfo>>>> = parking_lot::Mutex::new(None);

/// 這份 ffmpeg 列出的編碼器（依 ffmpeg 路徑快取；換了 ffmpeg 就重問）。
/// 「有列」≠「能用」—— NVENC 沒有驅動 / 沒有卡也會列出來，那要問 `encoder_usable`。
pub async fn encoders(bins: &FfmpegBins) -> AppResult<Vec<EncoderInfo>> {
    if let Some(v) = ENCODERS_CACHE.lock().as_ref().and_then(|m| m.get(&bins.ffmpeg).cloned()) {
        return Ok(v);
    }
    let mut c = proc::cmd(&bins.ffmpeg);
    c.args(["-hide_banner", "-encoders"]);
    let out = c.output().await.map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
    if !out.status.success() {
        return Err(AppError::Ffmpeg(format!("ffmpeg -encoders 失敗：{}", String::from_utf8_lossy(&out.stderr).trim())));
    }
    let list = parse_encoders(&String::from_utf8_lossy(&out.stdout));
    ENCODERS_CACHE.lock().get_or_insert_with(HashMap::new).insert(bins.ffmpeg.clone(), list.clone());
    Ok(list)
}

/// 編碼器名只允許 `[A-Za-z0-9_-]`（`libvpx-vp9` 真的帶連字號）：這個字串會進 ffmpeg 參數。
pub fn encoder_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 40
        && !name.starts_with('-')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 「不能用」的結果只記這麼久：試編失敗可能是暫時的（GPU 被別的程序佔滿、NVENC session 用完），
/// 使用者在設定頁按「偵測」重探時不該被舊的失敗卡住一整個 App 生命週期。
const USABLE_NEGATIVE_TTL: std::time::Duration = std::time::Duration::from_secs(60);

/// `encoder_usable` 的結果快取，鍵 = (ffmpeg 路徑, 編碼器名)。和 `ENCODERS_CACHE` 一樣換了 ffmpeg 就重問。
/// 可用（true）永久記住 —— 同一支 ffmpeg 同一張卡不會突然編不了；不可用（false）只記 `USABLE_NEGATIVE_TTL`。
/// 抽成獨立型別（`now` 由呼叫端給）才能不跑 ffmpeg、不碰全域 static 就測鍵與過期。
#[derive(Debug, Default)]
pub struct UsableCache {
    map: HashMap<(String, String), (bool, std::time::Instant)>,
}

impl UsableCache {
    pub fn get(&self, ffmpeg: &str, encoder: &str, now: std::time::Instant) -> Option<bool> {
        let (ok, at) = *self.map.get(&(ffmpeg.to_string(), encoder.to_string()))?;
        if ok || now.saturating_duration_since(at) < USABLE_NEGATIVE_TTL {
            Some(ok)
        } else {
            None
        }
    }

    pub fn put(&mut self, ffmpeg: &str, encoder: &str, ok: bool, now: std::time::Instant) {
        self.map.insert((ffmpeg.to_string(), encoder.to_string()), (ok, now));
    }
}

static USABLE_CACHE: parking_lot::Mutex<Option<UsableCache>> = parking_lot::Mutex::new(None);

/// 真的能不能用：lavfi 黑幀試編 2 幀丟到 null muxer（NVENC 沒卡 / 驅動太舊會在這裡失敗）。20 秒 timeout。
///
/// 有快取（`UsableCache`）：以前每次 `ffmpeg_detect` 帶 `check` 都真的開 ffmpeg 試編（NVENC 初始化
/// 可以拖到 20 秒 timeout），啟動與設定頁每次偵測都在（可能正忙的）GPU 上重跑一輪。
pub async fn encoder_usable(bins: &FfmpegBins, name: &str) -> bool {
    if !encoder_name_ok(name) {
        return false;
    }
    if let Some(ok) = USABLE_CACHE.lock().as_ref().and_then(|c| c.get(&bins.ffmpeg, name, std::time::Instant::now())) {
        return ok;
    }
    let mut c = proc::cmd(&bins.ffmpeg);
    c.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=256x256:r=30"]);
    c.args(["-frames:v", "2", "-pix_fmt", "yuv420p", "-c:v", name, "-f", "null", "-"]);
    let ok = matches!(tokio::time::timeout(std::time::Duration::from_secs(20), c.status()).await, Ok(Ok(st)) if st.success());
    // 鎖不跨 await：試編期間不擋住其他編碼器的查詢（同一把鎖不能被持有 20 秒）
    USABLE_CACHE.lock().get_or_insert_with(UsableCache::default).put(&bins.ffmpeg, name, ok, std::time::Instant::now());
    ok
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_stable_and_size_sensitive() {
        let dir = std::env::temp_dir().join(format!("aivc-fp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.bin");
        std::fs::write(&a, vec![7u8; 10_000]).unwrap();
        let f1 = fingerprint(a.to_str().unwrap()).unwrap();
        let f2 = fingerprint(a.to_str().unwrap()).unwrap();
        assert_eq!(f1, f2);
        std::fs::write(&a, vec![7u8; 10_001]).unwrap();
        assert_ne!(f1, fingerprint(a.to_str().unwrap()).unwrap());
        let empty = dir.join("e.bin");
        std::fs::write(&empty, b"").unwrap();
        assert_eq!(fingerprint(empty.to_str().unwrap()).unwrap().len(), 64);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 共用測試向量：Python `media/fingerprint.py` 要對同一組輸入算出同一個 hex。
    #[test]
    fn fingerprint_test_vector_for_python() {
        let dir = std::env::temp_dir().join(format!("aivc-fpv-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("v.bin");
        std::fs::write(&a, b"aivc").unwrap();
        // blake3(le64(4) ‖ b"aivc")
        let mut h = blake3::Hasher::new();
        h.update(&4u64.to_le_bytes());
        h.update(b"aivc");
        assert_eq!(fingerprint(a.to_str().unwrap()).unwrap(), h.finalize().to_hex().to_string());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolution_order_puts_bundled_before_path() {
        // 安裝版回歸：PATH 上的 gyan.dev 7.1 essentials 曾蓋過內建 LGPL build（決策 6：內建優先於 PATH）
        let bundled = PathBuf::from("C:/Users/u/AppData/Local/AI Video Cut/resources/ffmpeg");
        let path_hits = vec![PathBuf::from("C:/ffmpeg/bin/ffmpeg.exe")];
        let common = vec![PathBuf::from("C:/Program Files/ffmpeg/bin")];
        let order = resolution_order(Some("  D:/my/ffmpeg.exe "), Some(bundled.as_path()), &path_hits, common.clone());
        let sources: Vec<&str> = order.iter().map(|(_, s)| *s).collect();
        assert_eq!(sources, ["custom", "bundled", "path", "common"]);
        assert_eq!(order[0].0, PathBuf::from("D:/my/ffmpeg.exe"));
        assert_eq!(order[1].0, bundled);
        // 沒有自訂、沒有內建（dev）→ PATH 先
        let dev = resolution_order(Some("   "), None, &path_hits, common);
        assert_eq!(dev.iter().map(|(_, s)| *s).collect::<Vec<_>>(), ["path", "common"]);
    }

    #[test]
    fn bundled_candidate_matches_tauri_resource_layout() {
        // bundle.resources 保留來源目錄結構 → <resource_dir>/resources/ffmpeg
        let got = bundled_candidate(Path::new("C:/Program Files/AI Video Cut"));
        assert!(got.ends_with(Path::new("resources").join("ffmpeg")), "{got:?}");
        assert!(got.starts_with("C:/Program Files/AI Video Cut"));
    }

    #[test]
    fn bundled_candidates_cover_macos_app_and_linux_packages() {
        let rf = Path::new("resources").join("ffmpeg");
        // macOS .app：Tauri 的 resource_dir 是 Contents/Resources
        let app = Path::new("/Applications/AI Video Cut.app/Contents/Resources");
        assert_eq!(bundled_candidates(app), vec![app.join(&rf)]);
        // 退回執行檔目錄 Contents/MacOS 時：先照原樣，再看隔壁的 Contents/Resources
        let exe_dir = Path::new("/Applications/AI Video Cut.app/Contents/MacOS");
        assert_eq!(
            bundled_candidates(exe_dir),
            vec![exe_dir.join(&rf), Path::new("/Applications/AI Video Cut.app/Contents/Resources").join(&rf)]
        );
        // 只有名字叫 MacOS、上層不是 Contents → 不是 .app，不亂猜
        assert_eq!(bundled_candidates(Path::new("/tmp/MacOS")).len(), 1);
        // deb / AppImage：/usr/lib/<產品名>、$APPDIR/usr/lib/<產品名>
        for rd in ["/usr/lib/AI Video Cut", "/tmp/.mount_AI_VidXyz/usr/lib/AI Video Cut"] {
            assert_eq!(bundled_candidates(Path::new(rd)), vec![Path::new(rd).join(&rf)]);
        }
        // Windows NSIS（currentUser）
        let win = Path::new("C:\\Users\\alice\\AppData\\Local\\AI Video Cut");
        assert_eq!(bundled_candidates(win), vec![bundled_candidate(win)]);
    }

    #[test]
    fn unix_common_dirs_include_homebrew_and_distro_locations() {
        let home = Path::new("/home/alice");
        let mac = unix_common_dirs("macos", Some(Path::new("/Users/alice")));
        let pos = |v: &[PathBuf], p: &str| v.iter().position(|d| d == Path::new(p));
        // Apple Silicon Homebrew 排第一：從 Finder 開的 App 的 PATH 沒有它
        assert_eq!(pos(&mac, "/opt/homebrew/bin"), Some(0));
        for p in ["/usr/local/bin", "/usr/bin", "/opt/homebrew/opt/ffmpeg-full/bin", "/opt/local/bin"] {
            assert!(pos(&mac, p).is_some(), "macOS 要找 {p}");
        }
        assert!(pos(&mac, "/opt/homebrew/bin") < pos(&mac, "/usr/bin"), "Homebrew 優先於系統目錄");
        let linux = unix_common_dirs("linux", Some(home));
        for p in ["/usr/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", "/home/alice/.linuxbrew/bin", "/home/alice/.local/bin"] {
            assert!(pos(&linux, p).is_some(), "Linux 要找 {p}：{linux:?}");
        }
        // HOME 沒設 / 不是絕對路徑 → 不拼出相對路徑（那會變成相對於工作目錄去找）
        assert!(unix_common_dirs("linux", None).iter().all(|d| d.is_absolute() || d.starts_with("/")));
        assert!(unix_common_dirs("linux", Some(Path::new("relative"))).iter().all(|d| !d.starts_with("relative")));
    }

    /// 真的走一遍 unix 的解析：假 ffmpeg（shell 腳本）+ 同目錄 ffprobe，當成內建目錄與自訂路徑都要認得、版本字串要解析出來。
    #[cfg(unix)]
    #[tokio::test]
    async fn resolves_a_fake_unix_ffmpeg_with_sibling_ffprobe() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("aivc ffmpeg unix-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["ffmpeg", "ffprobe"] {
            let p = dir.join(name);
            std::fs::write(&p, "#!/bin/sh\necho \"ffmpeg version 7.1-test Copyright (c) the FFmpeg developers\"\n").unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        // 剛寫完就 exec 偶爾撞 ETXTBSY（平行測試的 fork 暫時繼承了寫入 fd）：重試幾次，不讓這個測試變成隨機紅燈
        let mut found = None;
        for _ in 0..20 {
            found = try_candidate(dir.clone(), "bundled").await;
            if found.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let b = found.expect("目錄形式");
        assert_eq!((b.version.as_str(), b.source.as_str()), ("7.1-test", "bundled"));
        assert_eq!(Path::new(&b.ffprobe), dir.join("ffprobe"));
        let c = resolve(Some(dir.join("ffmpeg").to_str().unwrap()), None).await.expect("自訂路徑（檔案形式）");
        assert_eq!(c.source, "custom");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn bundled_is_skipped_when_dir_has_no_ffmpeg() {
        // 目錄存在但裡面沒有 ffmpeg → 不能回傳半套結果，要往下一個候選找
        let dir = std::env::temp_dir().join(format!("aivc-bundled-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(try_candidate(dir.clone(), "bundled").await.is_none());
        // 只有 ffmpeg 沒有 ffprobe 也一樣不算數（sibling_probe）
        std::fs::write(dir.join(exe("ffmpeg")), b"not a real exe").unwrap();
        assert!(try_candidate(dir.clone(), "bundled").await.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rational_parsing() {
        assert_eq!(parse_rational("30/1"), Rational { num: 30, den: 1 });
        assert_eq!(parse_rational("30000/1001"), Rational { num: 30000, den: 1001 });
        assert_eq!(parse_rational("1/1000"), Rational { num: 1, den: 1000 });
        assert_eq!(parse_rational("0/0"), Rational::ZERO);
        assert_eq!(parse_rational("30"), Rational { num: 30, den: 1 });
        assert_eq!(parse_rational(""), Rational::ZERO);
        assert_eq!(parse_rational("abc"), Rational::ZERO);
        assert!(parse_rational("0/0").is_zero());
        assert!((Rational { num: 30000, den: 1001 }.as_f64() - 29.97).abs() < 0.001);
    }

    /// 範例 table_clip1.webm 的 ffprobe 實況（計畫 §2）：沒有 duration / nb_frames、tags 全 unknown。
    #[test]
    fn video_stream_from_the_sample_webm_shape() {
        let s: serde_json::Value = serde_json::from_str(
            r#"{"codec_type":"video","codec_name":"vp9","width":1280,"height":720,"pix_fmt":"yuv420p",
                "color_range":"tv","color_space":"unknown","color_transfer":"unknown","color_primaries":"unknown",
                "r_frame_rate":"30/1","avg_frame_rate":"0/0","time_base":"1/1000","start_time":"0.000000",
                "has_b_frames":0,"disposition":{"attached_pic":0}}"#,
        )
        .unwrap();
        let v = video_stream_from(&s);
        assert_eq!((v.codec.as_str(), v.width, v.height, v.pix_fmt.as_str()), ("vp9", 1280, 720, "yuv420p"));
        assert_eq!(v.r_frame_rate, Rational { num: 30, den: 1 });
        assert!(v.avg_frame_rate.is_zero());
        assert_eq!(v.time_base, Rational { num: 1, den: 1000 });
        assert_eq!(v.nb_frames, None);
        assert_eq!(v.duration_ms, None);
        assert_eq!(v.start_time_ms, Some(0));
        assert_eq!(v.color_range.as_deref(), Some("tv"));
        assert_eq!(v.color_space, None, "unknown 要變 None，前端才會走「高≥576 當 bt709」的假設");
        assert_eq!(v.rotation, 0);
        assert_eq!(v.has_b_frames, 0);
        assert_eq!(v.bit_rate, None);
    }

    #[test]
    fn video_stream_reads_rotation_frames_and_duration() {
        let s: serde_json::Value = serde_json::from_str(
            r#"{"codec_name":"h264","width":1920,"height":1080,"pix_fmt":"yuv420p","r_frame_rate":"30000/1001",
                "avg_frame_rate":"30000/1001","time_base":"1/30000","nb_frames":"1797","duration":"59.959900",
                "start_time":"0.033367","bit_rate":"8000000","has_b_frames":2,"color_space":"bt709",
                "side_data_list":[{"side_data_type":"Display Matrix","displaymatrix":"...","rotation":-90}]}"#,
        )
        .unwrap();
        let v = video_stream_from(&s);
        assert_eq!(v.nb_frames, Some(1797));
        assert_eq!(v.duration_ms, Some(59_960));
        assert_eq!(v.start_time_ms, Some(33));
        assert_eq!(v.bit_rate, Some(8_000_000));
        assert_eq!(v.has_b_frames, 2);
        assert_eq!(v.rotation, -90);
        assert_eq!(v.color_space.as_deref(), Some("bt709"));
        // 舊式 tags.rotate 也認得
        let s2: serde_json::Value = serde_json::from_str(r#"{"tags":{"rotate":"180"}}"#).unwrap();
        assert_eq!(rotation_of(&s2), 180);
    }

    /// 真實 ffprobe 輸出（ffmpeg 7.1 對 libx264 + aac + `-timecode` 轉出的 mp4，刪掉與測試無關的 disposition 等鍵）。
    /// 專業欄位（profile / level / FourCC / SAR / DAR / field_order / chroma_location / 時間碼 / 建立時間 / 寫檔程式）都在。
    const RICH_MP4_FFPROBE: &str = r#"{
        "streams": [
            {"index":0,"codec_name":"h264","codec_long_name":"H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10","profile":"High",
             "codec_type":"video","codec_tag_string":"avc1","codec_tag":"0x31637661","width":1920,"height":1080,
             "coded_width":1920,"coded_height":1080,"has_b_frames":2,"sample_aspect_ratio":"1:1","display_aspect_ratio":"16:9",
             "pix_fmt":"yuv420p","level":41,"color_range":"tv","color_space":"bt709","color_transfer":"bt709","color_primaries":"bt709",
             "chroma_location":"left","field_order":"progressive","refs":1,"r_frame_rate":"30000/1001","avg_frame_rate":"30000/1001",
             "time_base":"1/30000","start_pts":0,"start_time":"0.000000","duration_ts":30030,"duration":"1.001000",
             "bit_rate":"6639816","bits_per_raw_sample":"8","nb_frames":"30","disposition":{"default":1,"attached_pic":0},
             "tags":{"creation_time":"2026-09-01T08:30:00.000000Z","language":"und","handler_name":"VideoHandler",
                     "vendor_id":"[0][0][0][0]","encoder":"Lavc61.19.100 libx264","timecode":"01:00:00;00"}},
            {"index":1,"codec_name":"aac","codec_long_name":"AAC (Advanced Audio Coding)","profile":"LC","codec_type":"audio",
             "codec_tag_string":"mp4a","codec_tag":"0x6134706d","sample_fmt":"fltp","sample_rate":"48000","channels":2,
             "channel_layout":"stereo","bits_per_sample":0,"r_frame_rate":"0/0","avg_frame_rate":"0/0","time_base":"1/48000",
             "start_pts":0,"start_time":"0.000000","duration_ts":48000,"duration":"1.000000","bit_rate":"191185","nb_frames":"48",
             "disposition":{"default":1,"attached_pic":0},
             "tags":{"creation_time":"2026-09-01T08:30:00.000000Z","language":"und","handler_name":"SoundHandler"}},
            {"index":2,"codec_type":"data","codec_tag_string":"tmcd","codec_tag":"0x64636d74","time_base":"1/30000",
             "start_time":"0.000000","duration":"1.001000","bit_rate":"31","nb_frames":"1",
             "tags":{"creation_time":"2026-09-01T08:30:00.000000Z","handler_name":"TimeCodeHandler","timecode":"01:00:00;00"}}
        ],
        "format": {"filename":"rich.mp4","nb_streams":3,"format_name":"mov,mp4,m4a,3gp,3g2,mj2","format_long_name":"QuickTime / MOV",
                   "start_time":"0.000000","duration":"1.001000","size":"858138","bit_rate":"6858245","probe_score":100,
                   "tags":{"major_brand":"isom","minor_version":"512","compatible_brands":"isomiso2avc1mp41",
                           "creation_time":"2026-09-01T08:30:00.000000Z","encoder":"Lavf61.7.100"}}
    }"#;

    /// 範例 table_clip1.webm 的 ffprobe 7.1 實際輸出（刪 disposition 細項）：Chrome 錄影，沒有容器時長 / 位元率 /
    /// FourCC / field_order，level -99，音軌 opus bits_per_sample 0。
    const SAMPLE_WEBM_FFPROBE: &str = r#"{
        "streams": [
            {"index":0,"codec_name":"opus","codec_long_name":"Opus (Opus Interactive Audio Codec)","codec_type":"audio",
             "codec_tag_string":"[0][0][0][0]","codec_tag":"0x0000","sample_fmt":"fltp","sample_rate":"48000","channels":2,
             "channel_layout":"stereo","bits_per_sample":0,"initial_padding":0,"r_frame_rate":"0/0","avg_frame_rate":"0/0",
             "time_base":"1/1000","start_pts":0,"start_time":"0.000000","extradata_size":19,
             "disposition":{"default":1,"attached_pic":0},"tags":{"language":"eng"}},
            {"index":1,"codec_name":"vp9","codec_long_name":"Google VP9","profile":"Profile 0","codec_type":"video",
             "codec_tag_string":"[0][0][0][0]","codec_tag":"0x0000","width":1280,"height":720,"coded_width":1280,"coded_height":720,
             "closed_captions":0,"film_grain":0,"has_b_frames":0,"sample_aspect_ratio":"1:1","display_aspect_ratio":"16:9",
             "pix_fmt":"yuv420p","level":-99,"color_range":"tv","refs":1,"r_frame_rate":"30/1","avg_frame_rate":"0/0",
             "time_base":"1/1000","start_pts":2,"start_time":"0.002000",
             "disposition":{"default":1,"attached_pic":0},"tags":{"language":"eng","alpha_mode":"1"}}
        ],
        "format": {"filename":"D:/samples/table_clip1.webm","nb_streams":2,"format_name":"matroska,webm",
                   "format_long_name":"Matroska / WebM","start_time":"0.000000","size":"22768280","probe_score":100,
                   "tags":{"encoder":"Chrome"}}
    }"#;

    #[test]
    fn probe_from_json_reads_professional_fields_of_an_mp4() {
        let v: serde_json::Value = serde_json::from_str(RICH_MP4_FFPROBE).unwrap();
        let p = probe_from_json(&v, "D:/x/rich.mp4", 858_138).unwrap();
        assert_eq!(p.container, "mov,mp4,m4a,3gp,3g2,mj2");
        assert_eq!(p.format_long_name.as_deref(), Some("QuickTime / MOV"));
        assert_eq!(p.duration_ms, 1001);
        assert_eq!(p.bit_rate, Some(6_858_245));
        assert_eq!(p.creation_time.as_deref(), Some("2026-09-01T08:30:00.000000Z"));
        assert_eq!(p.encoder.as_deref(), Some("Lavf61.7.100"), "容器層的寫檔程式優先於影片軌的 Lavc…libx264");
        assert_eq!(p.timecode.as_deref(), Some("01:00:00;00"));
        assert_eq!(p.fingerprint, "", "指紋由 probe() 另外算");

        let v = p.video.as_ref().unwrap();
        assert_eq!(v.codec_long_name.as_deref(), Some("H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10"));
        assert_eq!((v.profile.as_deref(), v.level), (Some("High"), Some(41)));
        assert_eq!(v.codec_tag.as_deref(), Some("avc1"));
        assert_eq!(v.bits_per_raw_sample, Some(8), "ffprobe 給的是字串 \"8\"");
        assert_eq!(v.field_order.as_deref(), Some("progressive"));
        assert_eq!(v.chroma_location.as_deref(), Some("left"));
        assert_eq!(v.sample_aspect_ratio, Some(Rational { num: 1, den: 1 }));
        assert_eq!(v.display_aspect_ratio, Some(Rational { num: 16, den: 9 }));
        assert_eq!(v.bit_rate, Some(6_639_816));
        assert_eq!(v.duration_ms, Some(1001));
        assert_eq!(v.color_transfer.as_deref(), Some("bt709"));

        let a = p.audio.as_ref().unwrap();
        assert_eq!((a.codec.as_str(), a.profile.as_deref()), ("aac", Some("LC")));
        assert_eq!(a.codec_long_name.as_deref(), Some("AAC (Advanced Audio Coding)"));
        assert_eq!((a.sample_rate, a.channels, a.channel_layout.as_deref()), (48_000, 2, Some("stereo")));
        assert_eq!(a.sample_fmt.as_deref(), Some("fltp"));
        assert_eq!(a.bits_per_sample, None, "有損編碼的 bits_per_sample 0 不是資訊");
        assert_eq!(a.bit_rate, Some(191_185));
        assert_eq!(a.duration_ms, Some(1000));
        assert_eq!(a.start_time_ms, Some(0));
    }

    #[test]
    fn probe_from_json_sample_webm_leaves_missing_facts_as_none() {
        let v: serde_json::Value = serde_json::from_str(SAMPLE_WEBM_FFPROBE).unwrap();
        let p = probe_from_json(&v, "D:/samples/table_clip1.webm", 22_768_280).unwrap();
        assert_eq!(p.duration_ms, 0, "WebM 沒有容器時長（計畫 A0 出口條件）");
        assert_eq!(p.format_long_name.as_deref(), Some("Matroska / WebM"));
        assert_eq!(p.bit_rate, None);
        assert_eq!(p.creation_time, None);
        assert_eq!(p.encoder.as_deref(), Some("Chrome"));
        assert_eq!(p.timecode, None);
        let v = p.video.as_ref().unwrap();
        assert_eq!(v.profile.as_deref(), Some("Profile 0"));
        assert_eq!(v.level, None, "-99 = 未知");
        assert_eq!(v.codec_tag, None, "Matroska 沒有 FourCC：[0][0][0][0] 不能顯示成資訊");
        assert_eq!(v.bits_per_raw_sample, None);
        assert_eq!(v.field_order, None);
        assert_eq!(v.chroma_location, None);
        assert_eq!(v.sample_aspect_ratio, Some(Rational { num: 1, den: 1 }));
        assert_eq!(v.display_aspect_ratio, Some(Rational { num: 16, den: 9 }));
        assert_eq!((v.bit_rate, v.duration_ms, v.start_time_ms), (None, None, Some(2)));
        let a = p.audio.as_ref().unwrap();
        assert_eq!((a.codec.as_str(), a.channel_layout.as_deref(), a.sample_fmt.as_deref()), ("opus", Some("stereo"), Some("fltp")));
        assert_eq!((a.profile.as_deref(), a.bits_per_sample, a.bit_rate, a.duration_ms), (None, None, None, None));
        assert_eq!(a.start_time_ms, Some(0));
    }

    /// 序列化鍵名是前端的契約（src/api.ts MediaProbe / VideoStream / AudioStream）：改名會讓對話框整片變「—」而不報錯。
    #[test]
    fn probe_serializes_the_keys_api_ts_reads() {
        let v: serde_json::Value = serde_json::from_str(RICH_MP4_FFPROBE).unwrap();
        let j = serde_json::to_value(probe_from_json(&v, "D:/x/rich.mp4", 858_138).unwrap()).unwrap();
        for k in ["format_long_name", "bit_rate", "creation_time", "encoder", "timecode"] {
            assert!(j.get(k).is_some(), "MediaProbe.{k}");
        }
        for k in ["codec_long_name", "profile", "level", "codec_tag", "bits_per_raw_sample", "field_order", "chroma_location", "sample_aspect_ratio", "display_aspect_ratio"] {
            assert!(j["video"].get(k).is_some(), "VideoStream.{k}");
        }
        for k in ["codec_long_name", "profile", "channel_layout", "sample_fmt", "bits_per_sample", "duration_ms", "start_time_ms"] {
            assert!(j["audio"].get(k).is_some(), "AudioStream.{k}");
        }
        assert_eq!(j["video"]["display_aspect_ratio"], serde_json::json!({"num": 16, "den": 9}));
        assert_eq!(j["video"]["level"], serde_json::json!(41));
        // 沒有的值序列化成 null（不是省略鍵）：前端 `?? null` 兩種都吃，但 null 讓 JSON 複製出來的欄位齊全
        let w: serde_json::Value = serde_json::from_str(SAMPLE_WEBM_FFPROBE).unwrap();
        let jw = serde_json::to_value(probe_from_json(&w, "a.webm", 1).unwrap()).unwrap();
        assert!(jw["video"]["field_order"].is_null());
        assert!(jw["timecode"].is_null());
    }

    #[test]
    fn matroska_stream_tags_fill_duration_bitrate_and_encoder() {
        // ffmpeg / mkvmerge 寫的 mkv：逐軌沒有 duration / bit_rate 欄位，只有大寫標籤
        let v: serde_json::Value = serde_json::from_str(
            r#"{"streams":[
                {"codec_type":"video","codec_name":"hevc","profile":"Main 10","level":123,"pix_fmt":"yuv420p10le","width":3840,"height":2160,
                 "field_order":"tt","chroma_location":"topleft","sample_aspect_ratio":"0:1","display_aspect_ratio":"0:1",
                 "r_frame_rate":"25/1","avg_frame_rate":"25/1","time_base":"1/1000",
                 "tags":{"BPS":"42000000","DURATION":"00:01:02.500000000","ENCODER":"Lavc61 libx265"}},
                {"codec_type":"audio","codec_name":"pcm_s24le","sample_rate":"48000","channels":6,"channel_layout":"5.1(side)",
                 "bits_per_sample":24,"tags":{"DURATION":"00:01:02.480000000"}}
             ],"format":{"format_name":"matroska,webm","tags":{"ENCODER":"Lavf61.7.100"}}}"#,
        )
        .unwrap();
        let p = probe_from_json(&v, "a.mkv", 1).unwrap();
        assert_eq!(p.encoder.as_deref(), Some("Lavf61.7.100"), "Matroska 的大寫 ENCODER 也要認得");
        let vs = p.video.unwrap();
        assert_eq!(vs.duration_ms, Some(62_500));
        assert_eq!(vs.bit_rate, Some(42_000_000));
        assert_eq!((vs.level, vs.field_order.as_deref(), vs.chroma_location.as_deref()), (Some(123), Some("tt"), Some("topleft")));
        assert_eq!((vs.sample_aspect_ratio, vs.display_aspect_ratio), (None, None), "0:1 是未知比例");
        let a = p.audio.unwrap();
        assert_eq!((a.bits_per_sample, a.duration_ms, a.channel_layout.as_deref()), (Some(24), Some(62_480), Some("5.1(side)")));
        // 容器層沒有 encoder 時退到影片軌
        let v2: serde_json::Value = serde_json::from_str(r#"{"streams":[{"codec_type":"video","tags":{"encoder":"x"}}],"format":{}}"#).unwrap();
        assert_eq!(probe_from_json(&v2, "b", 1).unwrap().encoder.as_deref(), Some("x"));
    }

    #[test]
    fn probe_from_json_rejects_files_without_audio_or_video() {
        let v: serde_json::Value = serde_json::from_str(r#"{"streams":[{"codec_type":"subtitle"}],"format":{}}"#).unwrap();
        assert!(matches!(probe_from_json(&v, "a.srt", 1), Err(AppError::Invalid(_))));
        // mp3 封面圖（attached_pic）不算影片，只有它的話也不是媒體
        let v: serde_json::Value = serde_json::from_str(r#"{"streams":[{"codec_type":"video","disposition":{"attached_pic":1}}],"format":{}}"#).unwrap();
        assert!(probe_from_json(&v, "a.jpg", 1).is_err());
    }

    /// M2.14：純音訊檔（音樂 / 旁白 / 音效）要能開 —— 「音視訊皆無才錯」。帶封面圖的 mp3 / m4a 是最常見的形狀：
    /// 封面在 ffprobe 裡是一條 attached_pic 的影像串流，當成影片的話前端會以為是一支 1 幀的影片、Sidebar 會把它放進影片清單。
    #[test]
    fn probe_from_json_accepts_audio_only_files() {
        // 內建 ffmpeg（Lavf62.12）對 libmp3lame 44.1 kHz 95 s＋jpg 封面（-c:v copy -disposition:v:0 attached_pic）的實際輸出，刪掉無關的鍵
        let mp3: serde_json::Value = serde_json::from_str(
            r#"{"streams":[
                {"index":0,"codec_name":"mp3","codec_long_name":"MP3 (MPEG audio layer 3)","codec_type":"audio","sample_fmt":"fltp","sample_rate":"44100",
                 "channels":2,"channel_layout":"stereo","bits_per_sample":0,"time_base":"1/14112000","start_pts":353600,"start_time":"0.025057",
                 "duration":"95.000000","bit_rate":"128000","disposition":{"default":0,"attached_pic":0},"tags":{"encoder":"Lavc62.28"}},
                {"index":1,"codec_name":"mjpeg","codec_type":"video","profile":"Baseline","width":64,"height":64,"pix_fmt":"yuvj420p","level":-99,
                 "color_range":"pc","color_space":"bt470bg","r_frame_rate":"90000/1","avg_frame_rate":"0/0","time_base":"1/90000","start_pts":2255,
                 "start_time":"0.025056","duration":"95.000000","disposition":{"default":0,"attached_pic":1},"tags":{"comment":"Other"}}
             ],"format":{"format_name":"mp3","format_long_name":"MP2/3 (MPEG audio layer 2/3)","start_time":"0.025056","duration":"95.000000",
                         "size":"1521269","bit_rate":"128106","probe_score":24,"tags":{"encoder":"Lavf62.12.102"}}}"#,
        )
        .unwrap();
        let p = probe_from_json(&mp3, "D:/music/bgm.mp3", 1_521_269).unwrap();
        assert!(p.video.is_none(), "封面圖不是影片");
        let a = p.audio.as_ref().unwrap();
        assert_eq!((a.codec.as_str(), a.sample_rate, a.channels), ("mp3", 44_100, 2));
        assert_eq!(a.start_time_ms, Some(25), "LAME 延遲 25 057 µs（設計 §3.4）");
        assert_eq!((p.duration_ms, a.duration_ms, a.bits_per_sample), (95_000, Some(95_000), None));
        assert_eq!(p.encoder.as_deref(), Some("Lavf62.12.102"));

        // 純 wav：沒有影像串流、容器只有 duration
        let wav: serde_json::Value = serde_json::from_str(
            r#"{"streams":[{"codec_name":"pcm_s16le","codec_type":"audio","sample_rate":"48000","channels":1,"channel_layout":"mono","bits_per_sample":16,
                "start_time":"0.000000","duration":"1.500000","bit_rate":"768000"}],"format":{"format_name":"wav","duration":"1.500000"}}"#,
        )
        .unwrap();
        let p = probe_from_json(&wav, "D:/vo/旁白 01.wav", 144_078).unwrap();
        assert!(p.video.is_none());
        let a = p.audio.unwrap();
        assert_eq!((a.bits_per_sample, a.channel_layout.as_deref(), a.duration_ms), (Some(16), Some("mono"), Some(1500)));

        // Opus（Ogg）：沒有逐軌 duration，只有容器的；前端的長度退路要讀得到
        let opus: serde_json::Value = serde_json::from_str(
            r#"{"streams":[{"codec_name":"opus","codec_type":"audio","sample_rate":"48000","channels":2,"start_time":"-0.007000"}],
                "format":{"format_name":"ogg","duration":"30.000000"}}"#,
        )
        .unwrap();
        let p = probe_from_json(&opus, "take.opus", 1).unwrap();
        assert!(p.video.is_none());
        assert_eq!((p.duration_ms, p.audio.as_ref().unwrap().duration_ms, p.audio.as_ref().unwrap().start_time_ms), (30_000, None, Some(-7)));
    }

    /// 找得到真的 ffmpeg 才跑（`AIVC_FFMPEG_DIR` → repo 的 resources/ffmpeg → PATH，同 peaks.rs）；沙盒 CI 沒有就 SKIP。
    async fn real_bins() -> Option<FfmpegBins> {
        let env_dir = std::env::var_os("AIVC_FFMPEG_DIR").map(PathBuf::from);
        let repo_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("ffmpeg");
        let bundled = env_dir.filter(|d| d.is_dir()).unwrap_or(repo_dir);
        resolve(None, Some(&bundled)).await
    }

    /// M2.14 驗收「純音訊檔的 media_probe 通過」：用真的 ffmpeg 產生 wav／mp3（帶封面）／m4a／flac／opus，逐一走 `probe()`（含指紋）。
    #[tokio::test]
    async fn real_ffprobe_accepts_audio_only_files() {
        let Some(bins) = real_bins().await else {
            eprintln!("SKIP real_ffprobe_accepts_audio_only_files：找不到 ffmpeg");
            return;
        };
        let dir = std::env::temp_dir().join(format!("aivc 音訊 probe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // 封面先做成 jpg 檔再以 -c:v copy 掛上去：直接拿 lavfi color 加 -frames:v 1 混進 mp3，內建 n8.1 會在影像串流結束時把整個輸出收掉，
        // 音訊只剩 26 ms（實測），測到的就不是「一般的音樂檔」了
        let cover_jpg = dir.join("cover.jpg");
        let mut mk = proc::cmd(&bins.ffmpeg);
        mk.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64:d=0.04", "-frames:v", "1", "-update", "1"]);
        mk.arg(&cover_jpg);
        let have_cover = mk.output().await.map(|o| o.status.success()).unwrap_or(false);
        // (副檔名, 輸出參數, 要不要加封面圖)；m4a / mp3 加封面是因為那是從音樂軟體拖出來的檔最常見的樣子
        let cases: [(&str, &[&str], bool); 5] = [
            ("wav", &["-c:a", "pcm_s16le"], false),
            ("mp3", &["-c:a", "libmp3lame", "-b:a", "128k", "-id3v2_version", "3"], true),
            ("m4a", &["-c:a", "aac", "-b:a", "128k"], true),
            ("flac", &["-c:a", "flac"], false),
            ("opus", &["-c:a", "libopus", "-b:a", "96k"], false),
        ];
        let mut probed = Vec::new();
        for (ext, codec, cover) in cases {
            let out = dir.join(format!("音樂 {ext}.{ext}"));
            let mut c = proc::cmd(&bins.ffmpeg);
            c.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1.5"]);
            if cover && have_cover {
                c.arg("-i").arg(&cover_jpg);
                c.args(["-map", "0:a", "-map", "1:v", "-c:v", "copy", "-disposition:v:0", "attached_pic"]);
            }
            c.args(codec);
            c.arg(&out);
            let made = c.output().await.map(|o| o.status.success()).unwrap_or(false);
            if !made {
                // 使用者自己裝的 ffmpeg 可能沒有 libmp3lame / libopus：那不是 probe 的問題
                eprintln!("SKIP {ext}：這支 ffmpeg 產生不了測試檔");
                continue;
            }
            let p = probe(&bins, out.to_str().unwrap()).await.unwrap_or_else(|e| panic!("{ext} 的 probe 失敗：{e:?}"));
            assert!(p.video.is_none(), "{ext}：純音訊檔（含封面圖）不能被當成影片");
            let a = p.audio.as_ref().unwrap_or_else(|| panic!("{ext}：要有音軌"));
            assert_eq!(a.channels, 1, "{ext}");
            assert!(a.sample_rate == 48_000 || (ext == "mp3" && a.sample_rate == 44_100), "{ext} 取樣率 {}", a.sample_rate);
            let dur = a.duration_ms.or(Some(p.duration_ms).filter(|d| *d > 0)).unwrap_or(0);
            assert!((1400..=1700).contains(&dur), "{ext} 時長 {dur} ms：前端沒有引擎時靠它算片段長度");
            assert_eq!(p.fingerprint.len(), 64, "{ext}：指紋決定 audioMedia id");
            probed.push(ext);
        }
        let _ = std::fs::remove_dir_all(&dir);
        // wav / flac 是 ffmpeg 內建編碼器，任何一支 ffmpeg 都有：至少這兩個真的驗到，測試才不會整個空轉
        assert!(probed.contains(&"wav") && probed.contains(&"flac"), "實際驗到：{probed:?}");
    }

    #[test]
    fn aspect_ratio_and_hms_parsing() {
        assert_eq!(parse_aspect_ratio(&serde_json::json!("16:9")), Some(Rational { num: 16, den: 9 }));
        assert_eq!(parse_aspect_ratio(&serde_json::json!("0:1")), None);
        assert_eq!(parse_aspect_ratio(&serde_json::json!("N/A")), None);
        assert_eq!(parse_aspect_ratio(&serde_json::Value::Null), None);
        assert_eq!(parse_hms_ms("00:00:59.916000000"), Some(59_916));
        assert_eq!(parse_hms_ms("1:02:03.5"), Some(3_723_500));
        assert_eq!(parse_hms_ms("59.9"), None);
        assert_eq!(parse_hms_ms("a:b:c"), None);
        assert_eq!(tag_ci(&serde_json::json!({"ENCODER": " Chrome "}), "encoder").as_deref(), Some("Chrome"));
        assert_eq!(tag_ci(&serde_json::json!({"encoder": ""}), "encoder"), None);
    }

    #[test]
    fn parses_encoders_listing() {
        let out = "Encoders:\n V..... = Video\n A..... = Audio\n S..... = Subtitle\n .F.... = Frame-level multithreading\n ------\n V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)\n V..... libopenh264          OpenH264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)\n A....D aac                  AAC (Advanced Audio Coding)\n S..... webvtt               WebVTT subtitle\n";
        let v = parse_encoders(out);
        assert_eq!(v.len(), 4);
        assert_eq!(v[0], EncoderInfo { name: "h264_nvenc".into(), kind: "video".into(), description: "NVIDIA NVENC H.264 encoder (codec h264)".into() });
        assert_eq!(v[1].name, "libopenh264");
        assert_eq!(v[2].kind, "audio");
        assert_eq!(v[3].kind, "subtitle");
        // 分隔線之前的圖例不能被當成編碼器
        assert!(!v.iter().any(|e| e.name == "="));
        assert!(parse_encoders("").is_empty());
    }

    #[test]
    fn encoder_names_are_whitelisted_before_reaching_ffmpeg() {
        assert!(encoder_name_ok("h264_nvenc"));
        assert!(encoder_name_ok("libvpx-vp9"), "ffmpeg 的 VP9 encoder 名真的帶連字號");
        assert!(encoder_name_ok("prores_ks"));
        assert!(!encoder_name_ok(""));
        assert!(!encoder_name_ok("-f"), "不能以連字號開頭，否則會被當成旗標");
        assert!(!encoder_name_ok("h264 -f null"));
        assert!(!encoder_name_ok("a;b"));
    }

    #[test]
    fn usable_cache_is_keyed_by_ffmpeg_path_and_encoder() {
        let t0 = std::time::Instant::now();
        let mut c = UsableCache::default();
        assert_eq!(c.get("C:/ff/a/ffmpeg.exe", "h264_nvenc", t0), None, "沒問過 → 要真的試編");
        c.put("C:/ff/a/ffmpeg.exe", "h264_nvenc", true, t0);
        c.put("C:/ff/a/ffmpeg.exe", "hevc_nvenc", false, t0);
        assert_eq!(c.get("C:/ff/a/ffmpeg.exe", "h264_nvenc", t0), Some(true));
        assert_eq!(c.get("C:/ff/a/ffmpeg.exe", "hevc_nvenc", t0), Some(false));
        // 換了 ffmpeg（自訂路徑 / PATH 上另一支）→ 同名編碼器也要重問
        assert_eq!(c.get("C:/ff/b/ffmpeg.exe", "h264_nvenc", t0), None);
        // 同一支 ffmpeg 的另一個編碼器不能沾到別人的結果
        assert_eq!(c.get("C:/ff/a/ffmpeg.exe", "libopenh264", t0), None);
        // 鍵是 (路徑, 名) 的配對，不是字串串接：("a", "bc") 與 ("ab", "c") 不同
        c.put("x", "yz", true, t0);
        assert_eq!(c.get("xy", "z", t0), None);
    }

    #[test]
    fn usable_cache_keeps_success_but_expires_failure() {
        let t0 = std::time::Instant::now();
        let mut c = UsableCache::default();
        c.put("ffmpeg", "h264_nvenc", true, t0);
        c.put("ffmpeg", "hevc_nvenc", false, t0);
        let soon = t0 + std::time::Duration::from_secs(5);
        assert_eq!(c.get("ffmpeg", "hevc_nvenc", soon), Some(false), "短時間內重探不重跑 20 秒的 NVENC 試編");
        let later = t0 + USABLE_NEGATIVE_TTL + std::time::Duration::from_secs(1);
        assert_eq!(c.get("ffmpeg", "hevc_nvenc", later), None, "失敗可能是暫時的（GPU 忙），過期後要重試");
        assert_eq!(c.get("ffmpeg", "h264_nvenc", later), Some(true));
        // 重試成功就覆蓋掉舊的失敗
        c.put("ffmpeg", "hevc_nvenc", true, later);
        assert_eq!(c.get("ffmpeg", "hevc_nvenc", later), Some(true));
    }
}
