"""顆粒（§6.6 表「顆粒 Grain」列）：量測每通道 sigma、8×8 塊狀（VP9/H.264）、逐幀種子、只透過 alpha 施加。

為什麼要做：靜態顆粒（每幀相同）是所有 tech-check 清單裡的具名失敗；插入面若比周圍「乾淨」，眼睛立刻抓到。
模型（線性域）：
    n_c = σ_c · amount · ( √ρ · L + √(1-ρ) · N_c ),  ρ=0.75
  L 是三通道共用的「亮度顆粒」（編碼雜訊主要在亮度；色度 4:2:0 低解析度），N_c 是每通道獨立部分。
  L、N_c 都是單位變異數的「有色」雜訊：
    fine  = 高斯低通(白雜訊, σ_lp=0.6 px) 再正規化      ← DCT 量化雜訊不是白的
    block = 每 8×8 區塊一個常數（對齊幀座標的 8 格）      ← 區塊邊界的「階梯」感
    blocky8x8 on : g = √(1-β)·fine + √β·block，β=0.3；off：g = fine
施加：`add_in_code_domain()` 在碼值域加（A4：線性域同 sigma 會把黑墨抬灰）。
量測：`measure_sigma()` 用 MAD×1.4826（穩健，不被殘留墨邊／高光帶偏）；樣本 <64 回 NaN，由呼叫端退到 synthetic。
逐幀種子：`frame_seed(base, k)` 用 SplitMix64 混合，避免相鄰 k 的 rng 串流相關。
"""
from __future__ import annotations

import cv2
import numpy as np

DEFAULT_SYNTHETIC_SIGMA = np.array([0.0035, 0.0030, 0.0040], dtype=np.float32)  # 線性域；≈1/255 gamma 域 @中灰
RHO_LUMA = 0.75
BLOCK_MIX = 0.30
LOWPASS_SIGMA_PX = 0.6
MIN_SAMPLES = 64


def frame_seed(base_seed: int, frame_index: int, per_frame: bool = True) -> int:
    """SplitMix64 風格混合 → 64-bit 種子（可重現、鄰幀不相關）。per_frame=False 時每幀同一種子。"""
    x = (int(base_seed) * 0x9E3779B97F4A7C15 + (int(frame_index) if per_frame else 0) * 0xBF58476D1CE4E5B9 + 0x94D049BB133111EB) & 0xFFFFFFFFFFFFFFFF
    x ^= x >> 30
    x = (x * 0xBF58476D1CE4E5B9) & 0xFFFFFFFFFFFFFFFF
    x ^= x >> 27
    x = (x * 0x94D049BB133111EB) & 0xFFFFFFFFFFFFFFFF
    x ^= x >> 31
    return x


def measure_sigma(residual: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """每通道穩健 std（MAD·1.4826）於 mask 內；樣本不足 → 全 NaN。residual: (h,w,3) 線性。"""
    m = mask.astype(bool)
    if int(m.sum()) < MIN_SAMPLES:
        return np.full(3, np.nan, dtype=np.float32)
    vals = residual[m]  # (N,3)
    med = np.median(vals, axis=0)
    mad = np.median(np.abs(vals - med), axis=0)
    return (mad * 1.4826).astype(np.float32)


def _unit(x: np.ndarray) -> np.ndarray:
    s = float(x.std())
    return x / s if s > 1e-12 else x


def synth_grain(
    h: int,
    w: int,
    sigma: np.ndarray,
    *,
    seed: int,
    origin: tuple[int, int] = (0, 0),
    blocky8x8: bool = True,
    amount: float = 1.0,
    block: int = 8,
) -> np.ndarray:
    """(h,w,3) float32 線性域顆粒。origin=(x0,y0) 是 ROI 在幀中的位置，讓 8×8 區塊對齊幀的格線。"""
    if amount <= 0.0 or h <= 0 or w <= 0:
        return np.zeros((h, w, 3), dtype=np.float32)
    sig = np.asarray(sigma, dtype=np.float32).reshape(3)
    rng = np.random.default_rng(seed)
    x0, y0 = origin

    def coloured() -> np.ndarray:
        white = rng.standard_normal((h, w), dtype=np.float32)
        fine = _unit(cv2.GaussianBlur(white, (0, 0), LOWPASS_SIGMA_PX)) if LOWPASS_SIGMA_PX > 0 else white
        if not blocky8x8:
            return fine
        # 區塊常數：覆蓋 ROI 的區塊格（對齊幀 8 格），nearest 放大後裁到 ROI
        bx0, by0 = x0 // block, y0 // block
        bx1, by1 = (x0 + w - 1) // block + 1, (y0 + h - 1) // block + 1
        blocks = rng.standard_normal((by1 - by0, bx1 - bx0), dtype=np.float32)
        big = np.repeat(np.repeat(blocks, block, axis=0), block, axis=1)
        oy, ox = y0 - by0 * block, x0 - bx0 * block
        blk = big[oy : oy + h, ox : ox + w]
        return np.sqrt(1.0 - BLOCK_MIX, dtype=np.float32) * fine + np.sqrt(BLOCK_MIX, dtype=np.float32) * blk

    luma = coloured()
    out = np.empty((h, w, 3), dtype=np.float32)
    a, b = np.sqrt(RHO_LUMA, dtype=np.float32), np.sqrt(1.0 - RHO_LUMA, dtype=np.float32)
    for c in range(3):
        out[..., c] = (a * luma + b * coloured()) * (sig[c] * np.float32(amount))
    return out


def code_slope(level_lin: np.ndarray) -> np.ndarray:
    """BT.709 OETF 在線性值 L 的斜率 dV/dL（每通道）。"""
    L = np.maximum(np.asarray(level_lin, dtype=np.float32), np.float32(1e-6))
    return np.where(L < np.float32(0.018), np.float32(4.5), np.float32(1.099 * 0.45) * np.power(L, np.float32(-0.55))).astype(np.float32)


def add_in_code_domain(out_lin: np.ndarray, g_lin: np.ndarray, gmask: np.ndarray, ref_level_lin: np.ndarray) -> np.ndarray:
    """把「在線性 ref_level 量到的」顆粒換成碼值域等幅雜訊再加：V' = oetf(out) + g·slope(ref)·gmask，回線性。

    為什麼（A4）：VP9 量化雜訊在碼值域近似等幅；線性域同一個 sigma 放到黑墨上是 7× 的碼值雜訊，下緣再被 Y=16 夾掉 → 黑墨變灰。
    gmask==0 的像素原樣回傳（不做 oetf 往返，保證 alpha=0 處數值完全不動）。"""
    from . import _color

    m = gmask > 0
    if not m.any():
        return out_lin
    s = code_slope(np.asarray(ref_level_lin, np.float32).reshape(3))
    v = _color.oetf(out_lin[m]) + g_lin[m] * s[None, :] * gmask[m][:, None]
    res = out_lin.copy()
    res[m] = _color.oetf_inverse(v)
    return res


def resolve_sigma(measured: np.ndarray | None, mode: str) -> tuple[np.ndarray, str]:
    """measured 模式但量不到（NaN）→ 退到 synthetic 預設；回 (sigma, 來源字串)。"""
    if mode == "measured" and measured is not None and np.all(np.isfinite(measured)):
        return np.asarray(measured, dtype=np.float32), "measured"
    return DEFAULT_SYNTHETIC_SIGMA.copy(), "synthetic"
