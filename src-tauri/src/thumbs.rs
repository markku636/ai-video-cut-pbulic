//! 時間軸縮圖條：對 CFR proxy 抽 `count` 張連續幀、縮到高 `h`、橫向拼成一張 PNG，
//! 快取在媒體目錄的 `thumbs/`。畫面要哪一段就算哪一段（32 幀一格），不預算整支。
//!
//! 沿用 spectrum.rs 的紀律：已存在就短路、`.part` + rename、所有參數進檔名（任一項變就是另一張）、
//! `-ss` 放 `-i` 前面（輸入端 seek 才快；proxy GOP 15、精度靠預設的 accurate_seek）。
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};
use crate::ffmpeg::FfmpegBins;
use crate::proc;

/// 一條最多幾幀：tile 是一次算完整張，64 幀 × 高 48 是幾百 ms；再多就該切成兩條。
pub const MAX_COUNT: u32 = 64;
pub const MIN_HEIGHT: u32 = 16;
pub const MAX_HEIGHT: u32 = 256;

/// 檔名：起始幀 / 幀數 / 高度 / 版本。fps 不進檔名 —— 同一支 proxy 的 fps 是固定的，
/// 換 fps 等於換 proxy（快取目錄也不同）。
pub fn strip_name(start_frame: u32, count: u32, h: u32) -> String {
    format!("t-{start_frame}-{count}-h{h}-v1.png")
}

/// `-ss` 的秒數。**刻意退半幀**：ffmpeg 的 accurate seek 是「丟掉 pts < 目標的幀」，
/// 若目標剛好等於第 k 幀的 pts，格式化成 6 位小數時四捨五入往上（例如 2/30 → 0.066667 > 0.0666…）
/// 就會把第 k 幀丟掉、從 k+1 開始 —— 縮圖整條差一幀。目標放在 k−½ 幀：第 k−1 幀在目標前整整一幀
/// 必丟、第 k 幀在目標後半幀必留，對浮點誤差有一整個半幀的餘裕。
pub fn seek_seconds(start_frame: u32, fps_num: u32, fps_den: u32) -> f64 {
    if fps_num == 0 || fps_den == 0 {
        return 0.0;
    }
    let k = (start_frame as f64 - 0.5).max(0.0);
    k * fps_den as f64 / fps_num as f64
}

/// 產一條縮圖（已存在就直接回）。回傳 PNG 路徑。
#[allow(clippy::too_many_arguments)]
pub async fn thumb_strip(
    bins: &FfmpegBins,
    proxy: &Path,
    fps_num: u32,
    fps_den: u32,
    start_frame: u32,
    count: u32,
    h: u32,
    dir: &Path,
) -> AppResult<PathBuf> {
    if fps_num == 0 || fps_den == 0 {
        return Err(AppError::Invalid("fps 無效".into()));
    }
    if !proxy.is_file() {
        return Err(AppError::NotFound(format!("proxy 不存在：{}", proxy.display())));
    }
    let count = count.clamp(1, MAX_COUNT);
    let h = h.clamp(MIN_HEIGHT, MAX_HEIGHT);
    tokio::fs::create_dir_all(dir).await?;
    let out = dir.join(strip_name(start_frame, count, h));
    if out.is_file() {
        return Ok(out);
    }
    let part = dir.join(format!("{}.part.png", out.file_stem().and_then(|s| s.to_str()).unwrap_or("t")));
    // scale=-2:h：寬依比例、取偶數（yuv420 的色度要偶數）；tile={count}x1：橫向一排。
    // 到檔尾不足 count 幀時 tile 會用黑補滿 —— 前端只畫 proxy.frames 以內的格子，看不到補的那段。
    let vf = format!("scale=-2:{h}:flags=area,tile={count}x1");
    let mut c = proc::cmd(&bins.ffmpeg);
    c.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]);
    c.args(["-ss", &format!("{:.6}", seek_seconds(start_frame, fps_num, fps_den)), "-i"]);
    c.arg(proxy);
    c.args(["-an", "-frames:v", &count.to_string(), "-vf", &vf, "-frames:v", "1", "-f", "image2"]);
    c.arg(&part);
    let o = c.output().await.map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
    if !o.status.success() {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(AppError::Ffmpeg(format!("縮圖失敗：{}", String::from_utf8_lossy(&o.stderr).trim())));
    }
    tokio::fs::rename(&part, &out).await?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_name_is_stable_and_carries_every_param() {
        assert_eq!(strip_name(0, 32, 48), "t-0-32-h48-v1.png");
        assert_eq!(strip_name(1760, 64, 96), "t-1760-64-h96-v1.png");
        assert_ne!(strip_name(0, 32, 48), strip_name(0, 32, 49));
    }

    #[test]
    fn seek_lands_half_a_frame_before_the_target_frame() {
        // 30/1：第 0 幀從 0 開始（不能是負的）
        assert_eq!(seek_seconds(0, 30, 1), 0.0);
        // 第 2 幀 → 1.5/30 = 0.05；用整數秒去算避免浮點比較
        assert!((seek_seconds(2, 30, 1) - 0.05).abs() < 1e-12);
        // 30000/1001：第 30 幀 = 29.5 × 1001 / 30000
        let want = 29.5 * 1001.0 / 30000.0;
        assert!((seek_seconds(30, 30000, 1001) - want).abs() < 1e-12);
        // 目標一定嚴格介於第 k−1 與第 k 幀之間
        for k in 1u32..200 {
            let t = seek_seconds(k, 30000, 1001);
            let prev = (k - 1) as f64 * 1001.0 / 30000.0;
            let cur = k as f64 * 1001.0 / 30000.0;
            assert!(prev < t && t < cur, "k={k}");
        }
        assert_eq!(seek_seconds(5, 0, 1), 0.0);
    }
}
