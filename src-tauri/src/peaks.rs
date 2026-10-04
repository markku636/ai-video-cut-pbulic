//! 波形峰值 `peaks.v1.bin`（M2.8，設計 §3.4 / 決策 D12）：一趟串流解碼，算 5 ms 桶的 min / max / RMS / 零交越。
//!
//! 移植自 ai-music-cut `media.rs` 的 `Analyzer`，拿掉 ebur128（剪輯時間軸只畫波形，不需要響度視窗）。
//! 放在 Rust 而不是 Python 引擎：波形是「開檔就要看得到」的東西，引擎沒裝、或正忙著 GPU 追蹤時也要能算。
//!
//! **唯一跟 ai-music-cut 不同的是時間原點**：`-copyts` ＋ `aresample first_pts=0`，第 i 個桶就是**容器絕對時間**
//! `[5i, 5i+5) ms`。前面補靜音（mp3 LAME 延遲 25 ms）、負的起點（Opus pre-skip 標成 −7 ms）被裁掉、中間的 pts 斷層補靜音。
//! 渲染（§7.3）也用容器絕對時間，所以波形畫在哪，聲音就出在哪。
//!
//! 版面（全部 little-endian）：
//! `"AIVP" | u32 version=1 | u32 pps=200 | u32 sr=48000 | u32 n_buckets | u64 total_samples | i64 stream_start_us`
//! `→ i8[n] min → i8[n] max → u8[n] rms(−60..0 dBFS) → u8[n] zero-cross`
//!
//! magic 刻意不沿用 `AIPK`：時間原點不同，拿 ai-music-cut 的解析器讀會**安靜地錯位**；magic 不同才會當場擲錯
//! （ai-music-cut `analysis_header_ok` 的教訓：版面一改、舊快取被當成新格式讀，波形亂掉卻完全不報錯）。
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::io::AsyncReadExt;

use crate::error::{AppError, AppResult};
use crate::ffmpeg::FfmpegBins;
use crate::proc;

/// 快取檔名（`<app_cache_dir>/media/<fp16>/peaks.v1.bin`）。
pub const PEAKS_FILE: &str = "peaks.v1.bin";
pub const MAGIC: &[u8; 4] = b"AIVP";
pub const FORMAT_VERSION: u32 = 1;
/// 每秒幾個桶：200 = 5 ms 一桶（與 ai-music-cut 同，TS 的 mip 第 0 層就是它）。
pub const PPS: u32 = 200;
/// 解碼輸出取樣率 = 序列取樣率（§3.1 `SEQ_SAMPLE_RATE`），桶與序列樣本整數對齊（240 樣本一桶）。
pub const SR: u32 = 48_000;
/// magic 4 + 四個 u32 + total_samples u64 + stream_start_us i64。
pub const HEADER_LEN: usize = 4 + 4 * 4 + 8 + 8;
/// 零交越欄位的「這個桶裡沒有」。
pub const NO_ZERO_CROSS: u8 = u8::MAX;
/// 串流起點比這個晚時，前面的靜音由分析器直接寫桶，不叫 ffmpeg 補（見 `leading_pad_samples`）。
const PAD_MARGIN_SAMPLES: u64 = SR as u64;

/// −60..0 dBFS → 0..255（與 ai-music-cut 同一條映射，TS `rmsU8ToDb` 是它的反函式）。
pub fn db_to_u8(db: f64) -> u8 {
    (((db + 60.0) / 60.0) * 255.0).round().clamp(0.0, 255.0) as u8
}

/// 串流分析器：每個樣本更新目前的 5 ms 桶。只持有「一桶」的暫存，一小時的來源也只留 4 × 720 000 byte 的結果。
pub struct Analyzer {
    bucket_len: usize,
    cur_min: f32,
    cur_max: f32,
    cur_sq: f64,
    cur_n: usize,
    mins: Vec<i8>,
    maxs: Vec<i8>,
    rms: Vec<u8>,
    /// 每個桶內第一個上升零交越（負 → 非負）的樣本位移；`NO_ZERO_CROSS` = 沒有。
    /// 剪輯時間軸暫時用不到，但保留欄位：日後「切點貼零交越」不必改版面、不必讓所有人重算一次快取。
    zx: Vec<u8>,
    cur_zx: u8,
    prev: f32,
    total: u64,
}

impl Default for Analyzer {
    fn default() -> Self {
        Self::new()
    }
}

impl Analyzer {
    pub fn new() -> Self {
        Self {
            bucket_len: (SR / PPS) as usize,
            cur_min: f32::MAX,
            cur_max: f32::MIN,
            cur_sq: 0.0,
            cur_n: 0,
            mins: Vec::new(),
            maxs: Vec::new(),
            rms: Vec::new(),
            zx: Vec::new(),
            cur_zx: NO_ZERO_CROSS,
            prev: 0.0,
            total: 0,
        }
    }

    /// 目前吃進去的樣本數（進度用）。
    pub fn total(&self) -> u64 {
        self.total
    }

    fn flush_bucket(&mut self) {
        if self.cur_n == 0 {
            return;
        }
        let q = |v: f32| (v.clamp(-1.0, 1.0) * 127.0).round() as i8;
        self.mins.push(q(self.cur_min));
        self.maxs.push(q(self.cur_max));
        let rms = (self.cur_sq / self.cur_n as f64).sqrt();
        let db = if rms > 0.0 { 20.0 * rms.log10() } else { -120.0 };
        self.rms.push(db_to_u8(db));
        self.zx.push(self.cur_zx);
        self.cur_min = f32::MAX;
        self.cur_max = f32::MIN;
        self.cur_sq = 0.0;
        self.cur_n = 0;
        self.cur_zx = NO_ZERO_CROSS;
    }

    #[inline]
    pub fn push_sample(&mut self, v: f32) {
        // NaN / inf（壞掉的解碼器輸出）當 0：一個 NaN 會讓整桶的 min/max 比較全部失效
        let v = if v.is_finite() { v } else { 0.0 };
        if v < self.cur_min {
            self.cur_min = v;
        }
        if v > self.cur_max {
            self.cur_max = v;
        }
        if self.cur_zx == NO_ZERO_CROSS && self.prev < 0.0 && v >= 0.0 && self.cur_n < NO_ZERO_CROSS as usize {
            self.cur_zx = self.cur_n as u8;
        }
        self.prev = v;
        self.cur_sq += (v as f64) * (v as f64);
        self.cur_n += 1;
        self.total += 1;
        if self.cur_n >= self.bucket_len {
            self.flush_bucket();
        }
    }

    pub fn push(&mut self, samples: &[f32]) {
        for &v in samples {
            self.push_sample(v);
        }
    }

    /// 吃 `n` 個 0.0，結果與 `push(&vec![0.0; n])` 逐位元相同，但整桶的部分直接寫、不逐樣本跑。
    /// 為什麼需要：MPEG-TS 之類的容器 start_time 可能是幾千秒，絕對時間原點下前面整段都是靜音，
    /// 讓 ffmpeg 補再經管線送過來是幾 GB 的零（`leading_pad_samples`）。
    pub fn push_silence(&mut self, mut n: u64) {
        if n == 0 {
            return;
        }
        // 前一個樣本是負的 → 第一個 0 就是上升零交越，交給一般路徑處理（位移要落在正確的桶）
        if self.prev < 0.0 {
            self.push_sample(0.0);
            n -= 1;
        }
        if n == 0 {
            return;
        }
        self.prev = 0.0;
        self.total += n;
        let bl = self.bucket_len as u64;
        if self.cur_n > 0 {
            let take = (bl - self.cur_n as u64).min(n);
            self.cur_min = self.cur_min.min(0.0);
            self.cur_max = self.cur_max.max(0.0);
            self.cur_n += take as usize;
            n -= take;
            if self.cur_n >= self.bucket_len {
                self.flush_bucket();
            }
        }
        let whole = (n / bl) as usize;
        let silent_rms = db_to_u8(-120.0);
        self.mins.resize(self.mins.len() + whole, 0);
        self.maxs.resize(self.maxs.len() + whole, 0);
        self.rms.resize(self.rms.len() + whole, silent_rms);
        self.zx.resize(self.zx.len() + whole, NO_ZERO_CROSS);
        let rest = n - whole as u64 * bl;
        if rest > 0 {
            self.cur_min = self.cur_min.min(0.0);
            self.cur_max = self.cur_max.max(0.0);
            self.cur_n += rest as usize;
        }
    }

    /// 打包成 `peaks.v1.bin`（版面見模組說明）。最後不足一桶的樣本照樣成一桶。
    pub fn finish(mut self, stream_start_us: i64) -> Vec<u8> {
        self.flush_bucket();
        let n = self.mins.len();
        let mut out = Vec::with_capacity(HEADER_LEN + n * 4);
        out.extend_from_slice(MAGIC);
        for v in [FORMAT_VERSION, PPS, SR, n as u32] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&self.total.to_le_bytes());
        out.extend_from_slice(&stream_start_us.to_le_bytes());
        out.extend(self.mins.iter().map(|v| *v as u8));
        out.extend(self.maxs.iter().map(|v| *v as u8));
        out.extend_from_slice(&self.rms);
        out.extend_from_slice(&self.zx);
        out
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeaksHeader {
    pub version: u32,
    pub pps: u32,
    pub sample_rate: u32,
    pub n_buckets: u32,
    pub total_samples: u64,
    pub stream_start_us: i64,
}

impl PeaksHeader {
    /// 驗 header 並確認整份長度湊得起來；任何一項不符都擲 `Invalid`（訊息說明是哪一項）。
    /// TS `parsePeaks` 用同一組規則，兩邊對「什麼算壞檔」的判斷不會分岔。
    pub fn parse(bytes: &[u8]) -> AppResult<Self> {
        if bytes.len() < 4 {
            return Err(AppError::Invalid(format!("peaks.v1.bin 太短（{} byte）", bytes.len())));
        }
        if &bytes[..4] != MAGIC {
            return Err(AppError::Invalid(format!(
                "peaks.v1.bin magic 不符（{:?}，應為 AIVP）：可能是 ai-music-cut 的 analysis.bin 或損毀的快取",
                String::from_utf8_lossy(&bytes[..4])
            )));
        }
        if bytes.len() < HEADER_LEN {
            return Err(AppError::Invalid(format!("peaks.v1.bin header 不完整（{} < {HEADER_LEN} byte）", bytes.len())));
        }
        let u32_at = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
        let mut b8 = [0u8; 8];
        b8.copy_from_slice(&bytes[20..28]);
        let total_samples = u64::from_le_bytes(b8);
        b8.copy_from_slice(&bytes[28..36]);
        let stream_start_us = i64::from_le_bytes(b8);
        let h = Self { version: u32_at(4), pps: u32_at(8), sample_rate: u32_at(12), n_buckets: u32_at(16), total_samples, stream_start_us };
        if h.version != FORMAT_VERSION {
            return Err(AppError::Invalid(format!("peaks.v1.bin 版本 {} 不支援（這一版讀 {FORMAT_VERSION}）", h.version)));
        }
        if h.pps != PPS || h.sample_rate != SR {
            return Err(AppError::Invalid(format!("peaks.v1.bin 桶設定不符（pps {}、sr {}）", h.pps, h.sample_rate)));
        }
        let want = HEADER_LEN as u64 + h.n_buckets as u64 * 4;
        if bytes.len() as u64 != want {
            return Err(AppError::Invalid(format!("peaks.v1.bin 長度不符（{} ≠ {want} byte）", bytes.len())));
        }
        Ok(h)
    }
}

/// 快取檔能不能直接用。
pub fn header_ok(bytes: &[u8]) -> bool {
    PeaksHeader::parse(bytes).is_ok()
}

/// ffprobe 的秒數字串 → µs，十進位逐位解析（不經浮點：`0.025057` 經 f64 再乘 1e6 會變成 25056.999…）。
/// 第 7 位小數四捨五入；`N/A`、空字串、非數字回 None。
pub fn parse_seconds_us(s: &str) -> Option<i64> {
    let s = s.trim();
    let (neg, body) = match s.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, s.strip_prefix('+').unwrap_or(s)),
    };
    let (int_part, frac_part) = match body.split_once('.') {
        Some((i, f)) => (i, f),
        None => (body, ""),
    };
    if (int_part.is_empty() && frac_part.is_empty()) || int_part.len() > 12 {
        return None;
    }
    if !int_part.bytes().all(|c| c.is_ascii_digit()) || !frac_part.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let int: i64 = if int_part.is_empty() { 0 } else { int_part.parse().ok()? };
    let mut us: i64 = 0;
    let fb = frac_part.as_bytes();
    for i in 0..6 {
        us = us * 10 + fb.get(i).map(|c| (c - b'0') as i64).unwrap_or(0);
    }
    if fb.get(6).is_some_and(|c| *c >= b'5') {
        us += 1;
    }
    let v = int * 1_000_000 + us;
    Some(if neg { -v } else { v })
}

/// ffprobe 問第一條音軌的起點與時長。
pub fn probe_args(src: &str) -> Vec<String> {
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=start_time,duration:format=duration", "-of", "json"]
        .iter()
        .map(|s| s.to_string())
        .chain(std::iter::once(src.to_string()))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioStart {
    /// 音訊串流 start_time（µs）；容器沒給就是 0（ffmpeg 自己也這樣當）。
    pub stream_start_us: i64,
    /// 串流時長，沒有就用容器時長；都沒有（範例 WebM）→ None，進度改成不確定。
    pub duration_us: Option<i64>,
}

/// ffprobe JSON → 起點 / 時長。沒有音軌擲 `Invalid`（前端在沒有音軌的媒體上本來就不該叫）。
pub fn parse_probe_json(v: &serde_json::Value) -> AppResult<AudioStart> {
    let stream = v["streams"].as_array().and_then(|a| a.first()).ok_or_else(|| AppError::Invalid("這個媒體沒有音軌，無法計算波形".into()))?;
    let secs = |x: &serde_json::Value| x.as_str().and_then(parse_seconds_us);
    let stream_start_us = secs(&stream["start_time"]).unwrap_or(0);
    let duration_us = secs(&stream["duration"]).or_else(|| secs(&v["format"]["duration"])).filter(|d| *d > 0);
    Ok(AudioStart { stream_start_us, duration_us })
}

/// 串流起點很晚時，前面有多少樣本由分析器直接補（`push_silence`），剩下的交給 ffmpeg `first_pts` 補。
///
/// 刻意留 1 秒給 ffmpeg 自己補：ffprobe 的 start_time 是封包層的值，解碼後第一個樣本只會等於或晚於它；
/// `first_pts` 比實際第一個樣本還晚的話 aresample 會把開頭**裁掉**（實測 first_pts=480、來源起點 5 ms → 少 240 樣本）。
/// 留 1 秒的餘裕，一般素材（起點 < 1 s）走的就是設計 §3.4 原封不動的 `first_pts=0`。
pub fn leading_pad_samples(stream_start_us: i64) -> u64 {
    if stream_start_us <= 0 {
        return 0;
    }
    let s = (stream_start_us as u128 * SR as u128 / 1_000_000) as u64;
    s.saturating_sub(PAD_MARGIN_SAMPLES)
}

/// 解碼參數（設計 §3.4 的指令；`first_pts` 見 `leading_pad_samples`）。
pub fn decode_args(src: &str, first_pts: u64) -> Vec<String> {
    let mut a: Vec<String> = ["-nostdin", "-hide_banner", "-loglevel", "error", "-copyts", "-i"].iter().map(|s| s.to_string()).collect();
    a.push(src.to_string());
    a.extend(["-vn", "-map", "0:a:0", "-af"].iter().map(|s| s.to_string()));
    a.push(format!("aresample={SR}:async=1:min_hard_comp=0.020:first_pts={first_pts}"));
    a.extend(["-ac", "1", "-f", "f32le", "pipe:1"].iter().map(|s| s.to_string()));
    a
}

/// f32le 位元組流 → 分析器。管線的一次 read 可能切在一個樣本中間：最多留 3 byte 到下一次。
#[derive(Default)]
pub struct F32leFeeder {
    pending: [u8; 4],
    np: usize,
}

impl F32leFeeder {
    pub fn feed(&mut self, mut data: &[u8], an: &mut Analyzer) {
        if self.np > 0 {
            let take = (4 - self.np).min(data.len());
            self.pending[self.np..self.np + take].copy_from_slice(&data[..take]);
            self.np += take;
            data = &data[take..];
            if self.np < 4 {
                // 這一次的 byte 全拿去補半個樣本了，還湊不滿：留著等下一次
                return;
            }
            an.push_sample(f32::from_le_bytes(self.pending));
        }
        let (samples, rest) = data.as_chunks::<4>();
        for ch in samples {
            an.push_sample(f32::from_le_bytes(*ch));
        }
        self.pending[..rest.len()].copy_from_slice(rest);
        self.np = rest.len();
    }
}

fn nonempty(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file() && m.len() > 0).unwrap_or(false)
}

async fn probe_start(bins: &FfmpegBins, src: &str) -> AppResult<AudioStart> {
    let mut c = proc::cmd(&bins.ffprobe);
    c.args(probe_args(src));
    let o = c.output().await.map_err(|e| AppError::Ffmpeg(format!("ffprobe 啟動失敗：{e}")))?;
    if !o.status.success() {
        return Err(AppError::Ffmpeg(format!("ffprobe 失敗：{}", String::from_utf8_lossy(&o.stderr).trim())));
    }
    let v: serde_json::Value = serde_json::from_slice(&o.stdout).map_err(|e| AppError::Ffmpeg(format!("ffprobe 輸出解析失敗：{e}")))?;
    parse_probe_json(&v)
}

/// 一趟串流解碼算峰值（不讀快取）。`duration_ms`：前端已知的時長（audio.v1.json / proxy），優先於 ffprobe 的值，只影響進度。
pub async fn compute<F: FnMut(f32) + Send>(
    bins: &FfmpegBins,
    src: &str,
    duration_ms: Option<u64>,
    cancel: Arc<AtomicBool>,
    mut on_progress: F,
) -> AppResult<Vec<u8>> {
    let start = probe_start(bins, src).await?;
    let pad = leading_pad_samples(start.stream_start_us);
    let duration_us = duration_ms.filter(|d| *d > 0).map(|d| d as i64 * 1000).or(start.duration_us);
    let expected = duration_us.map(|d| ((d + start.stream_start_us.max(0)) as f64 / 1e6 * SR as f64).max(1.0));

    let mut c = proc::cmd(&bins.ffmpeg);
    c.args(decode_args(src, pad));
    c.stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = c.spawn().map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
    let mut stdout = child.stdout.take().ok_or_else(|| AppError::Ffmpeg("ffmpeg stdout 未接上".into()))?;
    let mut stderr = child.stderr.take().ok_or_else(|| AppError::Ffmpeg("ffmpeg stderr 未接上".into()))?;
    // stderr 一定要有人讀：管線塞滿 64 KB 之後 ffmpeg 會卡在寫 log，stdout 這邊就永遠等不到 EOF
    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s).await;
        s
    });

    let mut an = Analyzer::new();
    an.push_silence(pad);
    let mut buf = vec![0u8; 256 * 1024];
    let mut feeder = F32leFeeder::default();
    let mut last_pct = -1.0f32;
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.start_kill();
            return Err(AppError::Canceled);
        }
        let n = stdout.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        feeder.feed(&buf[..n], &mut an);
        if let Some(exp) = expected {
            let pct = ((an.total() as f64 / exp) * 100.0).min(99.0) as f32;
            if pct - last_pct >= 2.0 {
                last_pct = pct;
                on_progress(pct);
            }
        }
    }
    let status = child.wait().await?;
    let err = err_task.await.unwrap_or_default();
    if !status.success() {
        let tail: Vec<&str> = err.lines().map(str::trim).filter(|l| !l.is_empty()).rev().take(3).collect();
        return Err(AppError::Ffmpeg(format!("波形解碼失敗：{}", tail.into_iter().rev().collect::<Vec<_>>().join(" / "))));
    }
    on_progress(100.0);
    Ok(an.finish(start.stream_start_us))
}

/// 有快取（header 驗過）直接回，否則算一次寫進 `dir/peaks.v1.bin`。回 `(bytes, 是否命中快取)`。
///
/// **一定要驗 header 才信快取**：只看「檔案非空」的話，版面改過的舊快取會被新解析器錯位讀取而且不報錯
/// （ai-music-cut v2 → v3 實際發生過）。驗不過就刪掉重算。
pub async fn ensure<F: FnMut(f32) + Send>(
    bins: &FfmpegBins,
    src: &str,
    dir: &Path,
    duration_ms: Option<u64>,
    cancel: Arc<AtomicBool>,
    on_progress: F,
) -> AppResult<(Vec<u8>, bool)> {
    let out = dir.join(PEAKS_FILE);
    if nonempty(&out) {
        let bytes = tokio::fs::read(&out).await?;
        match PeaksHeader::parse(&bytes) {
            Ok(_) => return Ok((bytes, true)),
            Err(e) => {
                eprintln!("[peaks] 快取不可用，重新計算：{}（{}）", out.display(), e.message());
                let _ = tokio::fs::remove_file(&out).await;
            }
        }
    }
    let bytes = compute(bins, src, duration_ms, cancel, on_progress).await?;
    // .part 帶亂數：前端放棄等待後同一支媒體可能又被要一次，兩個 ffmpeg 同時寫同一個 .part 會互相截斷
    let part = dir.join(format!("{PEAKS_FILE}.{}.part", uuid::Uuid::new_v4().simple()));
    tokio::fs::create_dir_all(dir).await?;
    tokio::fs::write(&part, &bytes).await?;
    if let Err(e) = tokio::fs::rename(&part, &out).await {
        // 寫快取失敗不擋這一次的結果（下次再算就好）
        eprintln!("[peaks] 寫入快取失敗：{e}");
        let _ = tokio::fs::remove_file(&part).await;
    }
    Ok((bytes, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("aivc peaks 測試-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn u32_at(b: &[u8], o: usize) -> u32 {
        u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
    }

    #[test]
    fn analyzer_packs_expected_layout() {
        let mut an = Analyzer::new();
        // 1 秒 440 Hz 正弦 @ −6 dBFS
        let n = SR as usize;
        let samples: Vec<f32> = (0..n).map(|i| 0.5 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / SR as f32).sin()).collect();
        an.push(&samples);
        let bytes = an.finish(-7000);
        assert_eq!(&bytes[..4], b"AIVP");
        assert_eq!(u32_at(&bytes, 4), FORMAT_VERSION);
        assert_eq!(u32_at(&bytes, 8), PPS);
        assert_eq!(u32_at(&bytes, 12), SR);
        let n_b = u32_at(&bytes, 16) as usize;
        assert_eq!(n_b, PPS as usize, "1 秒 = 200 桶");
        assert_eq!(u64::from_le_bytes(bytes[20..28].try_into().unwrap()), SR as u64);
        assert_eq!(i64::from_le_bytes(bytes[28..36].try_into().unwrap()), -7000, "負的起點（Opus pre-skip）要原樣保留");
        assert_eq!(bytes.len(), HEADER_LEN + n_b * 4);
        let maxs = &bytes[HEADER_LEN + n_b..HEADER_LEN + 2 * n_b];
        assert!(maxs.iter().all(|&m| (m as i8) >= 60), "峰值約 0.5 → ~63");
        let mins = &bytes[HEADER_LEN..HEADER_LEN + n_b];
        assert!(mins.iter().all(|&m| (m as i8) <= -60));
        let rms = &bytes[HEADER_LEN + 2 * n_b..HEADER_LEN + 3 * n_b];
        assert!(rms.iter().all(|&r| r > 200), "−9 dBFS RMS → 約 217");
        let zx = &bytes[HEADER_LEN + 3 * n_b..];
        assert!(zx.iter().all(|&z| z != NO_ZERO_CROSS), "440 Hz 每 5 ms 桶都有上升零交越");
        assert!(zx.iter().all(|&z| (z as u32) < SR / PPS), "位移落在桶內");
        let h = PeaksHeader::parse(&bytes).unwrap();
        assert_eq!(h, PeaksHeader { version: 1, pps: 200, sample_rate: 48000, n_buckets: 200, total_samples: 48000, stream_start_us: -7000 });
    }

    #[test]
    fn partial_last_bucket_and_empty_input() {
        let mut an = Analyzer::new();
        an.push(&vec![0.25f32; 241]);
        let b = an.finish(0);
        assert_eq!(u32_at(&b, 16), 2, "241 樣本 = 一整桶 + 1 個樣本的尾桶");
        assert!(header_ok(&b));
        let empty = Analyzer::new().finish(0);
        assert_eq!(empty.len(), HEADER_LEN, "沒有樣本也是合法檔（0 桶）");
        assert_eq!(PeaksHeader::parse(&empty).unwrap().n_buckets, 0);
    }

    #[test]
    fn push_silence_matches_pushing_zeros_byte_for_byte() {
        // 各種邊界：從桶中間開始、剛好整桶、跨很多桶、前一個樣本是負的（第一個 0 就是零交越）
        let pre_sets: [&[f32]; 4] = [&[], &[0.3; 100], &[-0.2, 0.1, -0.4], &[0.5; 240]];
        for pre in pre_sets {
            for n in [0u64, 1, 139, 140, 240, 241, 5000, 48_000 + 7] {
                let post = [-0.1f32, 0.6, -0.6];
                let mut a = Analyzer::new();
                a.push(pre);
                a.push(&vec![0.0; n as usize]);
                a.push(&post);
                let mut b = Analyzer::new();
                b.push(pre);
                b.push_silence(n);
                b.push(&post);
                assert_eq!(a.finish(123), b.finish(123), "pre={} n={n}", pre.len());
            }
        }
    }

    #[test]
    fn feeder_handles_reads_split_inside_a_sample() {
        let samples: Vec<f32> = (0..1000).map(|i| ((i * 37 % 200) as f32 - 100.0) / 101.0).collect();
        let bytes: Vec<u8> = samples.iter().flat_map(|v| v.to_le_bytes()).collect();
        let mut direct = Analyzer::new();
        direct.push(&samples);
        let want = direct.finish(0);
        for chunk in [1usize, 2, 3, 4, 5, 7, 4093] {
            let mut an = Analyzer::new();
            let mut f = F32leFeeder::default();
            for part in bytes.chunks(chunk) {
                f.feed(part, &mut an);
            }
            assert_eq!(an.total(), 1000, "chunk={chunk}");
            assert_eq!(an.finish(0), want, "chunk={chunk}");
        }
    }

    #[test]
    fn header_rejects_wrong_magic_version_and_length() {
        let good = {
            let mut a = Analyzer::new();
            a.push(&[0.1; 480]);
            a.finish(0)
        };
        assert!(header_ok(&good));

        // ai-music-cut 的 AIPK：時間原點不同，必須當場擲錯而不是錯位讀取
        let mut aipk = good.clone();
        aipk[..4].copy_from_slice(b"AIPK");
        let e = PeaksHeader::parse(&aipk).unwrap_err();
        assert!(matches!(e, AppError::Invalid(_)));
        assert!(e.message().contains("magic"), "{}", e.message());

        let mut v2 = good.clone();
        v2[4..8].copy_from_slice(&2u32.to_le_bytes());
        assert!(PeaksHeader::parse(&v2).unwrap_err().message().contains("版本"));

        let mut pps = good.clone();
        pps[8..12].copy_from_slice(&100u32.to_le_bytes());
        assert!(PeaksHeader::parse(&pps).is_err());

        let mut truncated = good.clone();
        truncated.pop();
        assert!(PeaksHeader::parse(&truncated).unwrap_err().message().contains("長度"));
        let mut longer = good.clone();
        longer.push(0);
        assert!(!header_ok(&longer), "多出來的尾巴也代表版面對不上");

        assert!(!header_ok(b""));
        assert!(!header_ok(b"AIV"));
        assert!(!header_ok(&good[..HEADER_LEN - 1]));
    }

    /// 與 TS `src/audio/peaks.test.ts` 共用的 golden：同一份 bytes，Rust 打包、TS 解析，兩邊都比對。
    #[test]
    fn golden_fixture_matches_packer() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../../fixtures/peaks/aivp-v1.golden.json")).unwrap();
        let mut an = Analyzer::new();
        for seg in fixture["segments"].as_array().unwrap() {
            let n = seg["n"].as_u64().unwrap() as usize;
            match seg["kind"].as_str().unwrap() {
                "ramp" => {
                    let (from, to) = (seg["from"].as_f64().unwrap() as f32, seg["to"].as_f64().unwrap() as f32);
                    for i in 0..n {
                        an.push_sample(from + (to - from) * i as f32 / (n - 1) as f32);
                    }
                }
                "silence" => an.push_silence(n as u64),
                "alternate" => {
                    let (a, b) = (seg["a"].as_f64().unwrap() as f32, seg["b"].as_f64().unwrap() as f32);
                    for i in 0..n {
                        an.push_sample(if i % 2 == 0 { a } else { b });
                    }
                }
                k => panic!("未知的 segment kind {k}"),
            }
        }
        let bytes = an.finish(fixture["streamStartUs"].as_i64().unwrap());
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, fixture["hex"].as_str().unwrap(), "打包結果與 golden 不同（版面改了就要升 FORMAT_VERSION 並重生 fixture）");
        let h = PeaksHeader::parse(&bytes).unwrap();
        let exp = &fixture["expect"];
        assert_eq!(h.n_buckets as u64, exp["nBuckets"].as_u64().unwrap());
        assert_eq!(h.total_samples, exp["totalSamples"].as_u64().unwrap());
        let n = h.n_buckets as usize;
        let col = |off: usize, signed: bool| -> Vec<i64> {
            bytes[HEADER_LEN + off * n..HEADER_LEN + (off + 1) * n].iter().map(|b| if signed { *b as i8 as i64 } else { *b as i64 }).collect()
        };
        let arr = |k: &str| -> Vec<i64> { exp[k].as_array().unwrap().iter().map(|v| v.as_i64().unwrap()).collect() };
        assert_eq!(col(0, true), arr("mins"));
        assert_eq!(col(1, true), arr("maxs"));
        assert_eq!(col(2, false), arr("rms"));
        assert_eq!(col(3, false), arr("zx"));
    }

    #[test]
    fn db_mapping() {
        assert_eq!(db_to_u8(0.0), 255);
        assert_eq!(db_to_u8(-60.0), 0);
        assert_eq!(db_to_u8(-120.0), 0);
        assert_eq!(db_to_u8(-30.0), 128);
        assert_eq!(db_to_u8(6.0), 255);
    }

    #[test]
    fn seconds_parse_exactly_to_microseconds() {
        assert_eq!(parse_seconds_us("0.025057"), Some(25_057), "mp3 LAME 延遲（設計 §3.2）");
        assert_eq!(parse_seconds_us("-0.007000"), Some(-7_000), "Opus pre-skip");
        assert_eq!(parse_seconds_us("0.000000"), Some(0));
        assert_eq!(parse_seconds_us("12"), Some(12_000_000));
        assert_eq!(parse_seconds_us("1.5"), Some(1_500_000));
        assert_eq!(parse_seconds_us("0.0000005"), Some(1), "第 7 位四捨五入");
        assert_eq!(parse_seconds_us("0.0000004"), Some(0));
        assert_eq!(parse_seconds_us("95443.717678"), Some(95_443_717_678), "MPEG-TS 繞回附近的大起點");
        assert_eq!(parse_seconds_us(".5"), Some(500_000));
        for bad in ["N/A", "", " ", "-", ".", "1e3", "0x10", "1.2.3", "abc", "9999999999999"] {
            assert_eq!(parse_seconds_us(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn probe_json_reads_start_and_duration_and_rejects_no_audio() {
        let v = serde_json::json!({"streams":[{"start_time":"0.025057","duration":"12.345000"}],"format":{"duration":"12.400000"}});
        assert_eq!(parse_probe_json(&v).unwrap(), AudioStart { stream_start_us: 25_057, duration_us: Some(12_345_000) });
        // 範例 WebM：串流沒有 duration、容器也沒有 → None（進度不確定，不擋計算）
        let webm = serde_json::json!({"streams":[{"start_time":"0.000000"}],"format":{}});
        assert_eq!(parse_probe_json(&webm).unwrap(), AudioStart { stream_start_us: 0, duration_us: None });
        let fmt_only = serde_json::json!({"streams":[{"start_time":"N/A"}],"format":{"duration":"3.000000"}});
        assert_eq!(parse_probe_json(&fmt_only).unwrap(), AudioStart { stream_start_us: 0, duration_us: Some(3_000_000) });
        let none = serde_json::json!({"streams":[],"format":{"duration":"3.0"}});
        assert!(matches!(parse_probe_json(&none), Err(AppError::Invalid(_))));
    }

    #[test]
    fn decode_args_use_container_absolute_time() {
        let a = decode_args("D:\\影片 1\\a.webm", 0);
        let i = a.iter().position(|x| x == "-i").unwrap();
        let copyts = a.iter().position(|x| x == "-copyts").unwrap();
        assert!(copyts < i, "-copyts 是輸入端之前的全域旗標");
        assert_eq!(a[i + 1], "D:\\影片 1\\a.webm", "路徑是單一 argv，不經 shell");
        assert!(!a.iter().any(|x| x == "-ss"), "不用輸入端 -ss（設計 §7.5：Opus/WebM 晚 48 樣本）");
        let joined = a.join(" ");
        assert!(joined.contains("-map 0:a:0"));
        assert!(joined.contains("aresample=48000:async=1:min_hard_comp=0.020:first_pts=0"));
        assert!(joined.ends_with("-ac 1 -f f32le pipe:1"));
        assert!(decode_args("x", 96_000).join(" ").contains("first_pts=96000"));
    }

    #[test]
    fn leading_pad_only_kicks_in_after_a_one_second_margin() {
        assert_eq!(leading_pad_samples(-7_000), 0);
        assert_eq!(leading_pad_samples(0), 0);
        assert_eq!(leading_pad_samples(25_057), 0, "一般素材走設計原本的 first_pts=0");
        assert_eq!(leading_pad_samples(1_000_000), 0);
        assert_eq!(leading_pad_samples(3_000_000), 96_000);
        assert_eq!(leading_pad_samples(10_000_000_000), 480_000_000 - 48_000);
    }

    fn fake_bins() -> FfmpegBins {
        FfmpegBins {
            ffmpeg: "aivc-不存在的-ffmpeg".into(),
            ffprobe: "aivc-不存在的-ffprobe".into(),
            version: "test".into(),
            source: "test".into(),
        }
    }

    #[tokio::test]
    async fn cache_hit_returns_bytes_without_running_ffmpeg() {
        let dir = tmpdir();
        let mut a = Analyzer::new();
        a.push(&[0.3; 1000]);
        let cached = a.finish(42);
        std::fs::write(dir.join(PEAKS_FILE), &cached).unwrap();
        // ffmpeg 路徑是假的：只要走到解碼就會擲錯，所以拿得到 bytes 就證明沒有重算
        let mut calls = 0;
        let (bytes, hit) = ensure(&fake_bins(), "nope.webm", &dir, None, Arc::new(AtomicBool::new(false)), |_| calls += 1).await.unwrap();
        assert!(hit);
        assert_eq!(bytes, cached);
        assert_eq!(calls, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn bad_cache_is_deleted_and_recomputed() {
        let dir = tmpdir();
        let mut aipk = Analyzer::new().finish(0);
        aipk[..4].copy_from_slice(b"AIPK");
        std::fs::write(dir.join(PEAKS_FILE), &aipk).unwrap();
        let r = ensure(&fake_bins(), "nope.webm", &dir, None, Arc::new(AtomicBool::new(false)), |_| {}).await;
        assert!(matches!(r, Err(AppError::Ffmpeg(_))), "壞快取不能被當成結果回傳，要去重算（這裡 ffprobe 是假的所以擲錯）");
        assert!(!dir.join(PEAKS_FILE).exists(), "驗不過的快取要刪掉");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 找得到真的 ffmpeg 才跑（`AIVC_FFMPEG_DIR` → repo 的 resources/ffmpeg → PATH）；沙盒 CI 沒有就 SKIP。
    async fn real_bins() -> Option<FfmpegBins> {
        let env_dir = std::env::var_os("AIVC_FFMPEG_DIR").map(std::path::PathBuf::from);
        let repo_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("ffmpeg");
        let bundled = env_dir.filter(|d| d.is_dir()).unwrap_or(repo_dir);
        crate::ffmpeg::resolve(None, Some(&bundled)).await
    }

    async fn make_offset_tone(bins: &FfmpegBins, out: &Path, offset_s: &str, dur_s: &str) -> bool {
        let mut c = proc::cmd(&bins.ffmpeg);
        c.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i"]);
        // 不用 lavfi sine：它的振幅固定 1/8（−18 dBFS），量化後峰值只有 16，跟靜音的界線太近
        c.arg(format!("aevalsrc=0.8*sin(2*PI*1000*t):s=48000:d={dur_s}"));
        c.args(["-output_ts_offset", offset_s, "-c:a", "flac", "-f", "matroska"]);
        c.arg(out);
        c.output().await.map(|o| o.status.success()).unwrap_or(false)
    }

    /// 時間原點的實測：串流從 0.5 s（一般路徑）與 3.0 s（分析器補靜音的快速路徑）開始，
    /// 桶 i 必須是容器絕對時間 [5i, 5i+5) ms —— 起點前全是靜音、起點後有訊號，兩條路徑的交界都對在同一桶。
    #[tokio::test]
    async fn real_ffmpeg_buckets_are_container_absolute_time() {
        let Some(bins) = real_bins().await else {
            eprintln!("SKIP: 找不到 ffmpeg，peaks 實跑測試略過");
            return;
        };
        let dir = tmpdir();
        for (offset, dur, first_signal_bucket) in [("0.5", "1", 100usize), ("3.0", "0.2", 600)] {
            let src = dir.join(format!("tone-{offset}.mka"));
            if !make_offset_tone(&bins, &src, offset, dur).await {
                eprintln!("SKIP: lavfi / flac 不可用");
                let _ = std::fs::remove_dir_all(&dir);
                return;
            }
            let mut last = 0.0f32;
            let bytes = compute(&bins, &src.to_string_lossy(), None, Arc::new(AtomicBool::new(false)), |p| last = p).await.unwrap();
            let h = PeaksHeader::parse(&bytes).unwrap();
            let offset_us = parse_seconds_us(offset).unwrap();
            assert_eq!(h.stream_start_us, offset_us);
            let dur_us = parse_seconds_us(dur).unwrap();
            assert_eq!(h.total_samples, ((offset_us + dur_us) * 48 / 1000) as u64, "offset={offset}：前面補靜音、總長 = 起點 + 時長");
            assert_eq!(last, 100.0, "結束時一定回報 100%");
            let n = h.n_buckets as usize;
            let maxs: Vec<i8> = bytes[HEADER_LEN + n..HEADER_LEN + 2 * n].iter().map(|b| *b as i8).collect();
            assert!(maxs[..first_signal_bucket].iter().all(|m| *m == 0), "offset={offset}：起點之前必須是靜音");
            assert!(maxs[first_signal_bucket] > 60, "offset={offset}：起點那一桶就要有訊號（{}）", maxs[first_signal_bucket]);
            assert!(maxs[first_signal_bucket..].iter().all(|m| *m > 60));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 手動量測真實素材（預設不跑）：
    /// `AIVC_PEAKS_SAMPLE=<媒體路徑> cargo test --no-default-features --lib peaks::tests::measure_sample -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn measure_sample() {
        let Some(path) = std::env::var_os("AIVC_PEAKS_SAMPLE") else {
            eprintln!("SKIP: 沒有設定 AIVC_PEAKS_SAMPLE");
            return;
        };
        let bins = real_bins().await.expect("找不到 ffmpeg");
        let t0 = std::time::Instant::now();
        let mut ticks = 0;
        let bytes = compute(&bins, &path.to_string_lossy(), None, Arc::new(AtomicBool::new(false)), |_| ticks += 1).await.unwrap();
        let h = PeaksHeader::parse(&bytes).unwrap();
        let n = h.n_buckets as usize;
        let loud = bytes[HEADER_LEN + 2 * n..HEADER_LEN + 3 * n].iter().filter(|r| **r > 0).count();
        eprintln!(
            "peaks: {:?} buckets={} total_samples={} ({:.3} s) stream_start_us={} bytes={} 非靜音桶={} 進度回報={} 耗時={:?}",
            path,
            h.n_buckets,
            h.total_samples,
            h.total_samples as f64 / SR as f64,
            h.stream_start_us,
            bytes.len(),
            loud,
            ticks,
            t0.elapsed()
        );
    }

    #[tokio::test]
    async fn real_ffmpeg_cancel_stops_decoding() {
        let Some(bins) = real_bins().await else {
            eprintln!("SKIP: 找不到 ffmpeg，peaks 取消測試略過");
            return;
        };
        let dir = tmpdir();
        let src = dir.join("tone.mka");
        if !make_offset_tone(&bins, &src, "0", "5").await {
            eprintln!("SKIP: lavfi / flac 不可用");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        let r = compute(&bins, &src.to_string_lossy(), None, Arc::new(AtomicBool::new(true)), |_| {}).await;
        assert!(matches!(r, Err(AppError::Canceled)));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
