"""量尺共用小工具（純 numpy／cv2，無 I/O）。

- `output_frame_offset`：渲染輸出第 j 幀 ↔ proxy 第 k=j+offset 幀。輸出幀數 == N → offset 0；`--range K0:K1` 且輸出幀數
  == K1−K0（`render --trim` 的輸出）→ offset K0；其他幀數一律拒絕——幀數對不上時逐幀比對毫無意義，寧可早爆。
- `sse_masked` / `psnr_from_sse`：PSNR 只在 keep=True 的像素上算，三個平面可以先加總 SSE 再算一個 PSNR（避免
  「Y 過了 U 沒過」要三個門檻）。
- `dilate_bool` / `pool2x2_any`：遮罩膨脹與 yuv420p 色度（2×2 一個樣本）的對應遮罩。
- `quad_footprint`：四角 → 幀 bool 遮罩，用 1/256 px 的 shift 畫（與 track/runner.region_mask 同法），邊界像素不會少半格。
- `cyclic_corner_error`：標記四角 vs solve 四角的最大角點誤差，取 4 個循環位移的最小值——模板的「第一個角」是
  參考影格當時決定的，橫放牌（第三張）的偵測器四角序列跟 solve 模板的角序常差一格；牌是 122×80 的長方形，
  錯一格的位移會產生 >40 px 的誤差，所以取最小不會把真錯誤藏起來。
- `jsonable`：numpy 標量／陣列、inf/nan → 能 json.dumps 的型別（inf → "inf"、nan → None）。
"""
from __future__ import annotations

import math
from typing import Any, Iterable

import numpy as np

STATE_NAMES: dict[int, str] = {0: "none", 1: "tracking", 2: "static", 3: "lost"}
TRACKING, STATIC, LOST = 1, 2, 3


def output_frame_offset(n_out: int, n_frames: int, rng: tuple[int, int] | None) -> tuple[int, tuple[int, int]]:
    """回 (offset, (k_lo, k_hi))。見模組 docstring。"""
    n_out, n_frames = int(n_out), int(n_frames)
    if n_out == n_frames:
        lo, hi = (0, n_frames) if rng is None else (max(0, rng[0]), min(n_frames, rng[1]))
        return 0, (lo, hi)
    if rng is not None and n_out == rng[1] - rng[0]:
        return int(rng[0]), (int(rng[0]), int(rng[1]))
    want = f"{n_frames}" if rng is None else f"{n_frames}（完整）或 {rng[1] - rng[0]}（--range {rng[0]}:{rng[1]} --trim）"
    raise ValueError(f"渲染輸出有 {n_out} 幀，預期 {want}：輸出與專案對不上（不同來源／不同 --range？）")


# ---------------------------------------------------------------- PSNR


def sse_masked(a: np.ndarray, b: np.ndarray, keep: np.ndarray | None) -> tuple[float, int, int]:
    """(平方誤差和, 不同的像素數, 比對的像素數)；keep=None = 整個平面。"""
    if a.shape != b.shape:
        raise ValueError(f"平面尺寸不同：{a.shape} vs {b.shape}")
    if keep is None:
        d = a.astype(np.int32) - b.astype(np.int32)
        return float(np.dot(d.ravel(), d.ravel())), int(np.count_nonzero(d)), int(d.size)
    if keep.shape != a.shape:
        raise ValueError(f"遮罩尺寸 {keep.shape} 與平面 {a.shape} 不同")
    d = a[keep].astype(np.int32) - b[keep].astype(np.int32)
    return float(np.dot(d, d)), int(np.count_nonzero(d)), int(d.size)


def psnr_from_sse(sse: float, n: int, peak: float = 255.0) -> float:
    if n <= 0:
        return math.inf  # 沒有可比的像素（遮罩蓋滿）：視為「沒動」
    if sse <= 0.0:
        return math.inf
    return float(10.0 * math.log10(peak * peak * n / sse))


# ---------------------------------------------------------------- 遮罩


def dilate_bool(mask: np.ndarray, px: int) -> np.ndarray:
    """(2·px+1) 方形核膨脹；px ≤ 0 原樣回傳。"""
    import cv2

    m = np.asarray(mask, dtype=bool)
    if px <= 0 or not m.any():
        return m.copy()
    k = 2 * int(px) + 1
    return cv2.dilate(m.astype(np.uint8), np.ones((k, k), np.uint8)) > 0


def pool2x2_any(mask: np.ndarray, chroma_hw: tuple[int, int] | None = None) -> np.ndarray:
    """亮度遮罩 → 色度遮罩（2×2 任一為真）；奇數尺寸邊緣補齊。chroma_hw 指定就裁／補到那個尺寸。"""
    m = np.asarray(mask, dtype=bool)
    h, w = m.shape
    if h % 2 or w % 2:
        m = np.pad(m, ((0, h % 2), (0, w % 2)), mode="edge")
    out = m.reshape(m.shape[0] // 2, 2, m.shape[1] // 2, 2).any(axis=(1, 3))
    if chroma_hw is not None and out.shape != tuple(chroma_hw):
        fixed = np.zeros(chroma_hw, dtype=bool)
        hh, ww = min(out.shape[0], chroma_hw[0]), min(out.shape[1], chroma_hw[1])
        fixed[:hh, :ww] = out[:hh, :ww]
        out = fixed
    return out


def quad_footprint(quad: np.ndarray, w: int, h: int) -> np.ndarray:
    """四角（邊界慣例、幀 px）→ bool (h, w)。四角非有限值 → 全 False。"""
    import cv2

    q = np.asarray(quad, dtype=np.float64).reshape(4, 2)
    m = np.zeros((int(h), int(w)), np.uint8)
    if not np.all(np.isfinite(q)):
        return m.astype(bool)
    pts = np.round(q * 256.0).astype(np.int32).reshape(-1, 1, 2)
    cv2.fillPoly(m, [pts], 1, lineType=cv2.LINE_8, shift=8)
    return m.astype(bool)


# ---------------------------------------------------------------- 四角誤差


def cyclic_corner_error(label_quad: np.ndarray, solve_quad: np.ndarray) -> tuple[float, int]:
    """(最大角點距離, 用的位移)：對 4 個循環位移取最大角點距離的最小值。任一邊有非有限值 → (inf, 0)。"""
    a = np.asarray(label_quad, dtype=np.float64).reshape(4, 2)
    b = np.asarray(solve_quad, dtype=np.float64).reshape(4, 2)
    if not (np.all(np.isfinite(a)) and np.all(np.isfinite(b))):
        return math.inf, 0
    best, best_s = math.inf, 0
    for s in range(4):
        e = float(np.max(np.linalg.norm(a - np.roll(b, -s, axis=0), axis=1)))
        if e < best:
            best, best_s = e, s
    return best, best_s


def long_side(quad: np.ndarray) -> float:
    q = np.asarray(quad, dtype=np.float64).reshape(4, 2)
    return float(np.max(np.linalg.norm(np.roll(q, -1, axis=0) - q, axis=1)))


# ---------------------------------------------------------------- 連續段


def runs(ks: Iterable[int]) -> list[tuple[int, int]]:
    """已排序的整數 → 連續段 [(k0, k1), …]（k1 不含）。"""
    out: list[list[int]] = []
    for k in ks:
        k = int(k)
        if out and out[-1][1] == k:
            out[-1][1] = k + 1
        else:
            out.append([k, k + 1])
    return [(a, b) for a, b in out]


# ---------------------------------------------------------------- JSON


def jsonable(obj: Any) -> Any:
    """遞迴轉成 json.dumps 吃得下的型別：numpy → python、inf → "inf"、nan → None。"""
    if isinstance(obj, dict):
        return {str(k): jsonable(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [jsonable(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return jsonable(obj.tolist())
    if isinstance(obj, (np.bool_, bool)):
        return bool(obj)
    if isinstance(obj, (np.integer, int)):
        return int(obj)
    if isinstance(obj, (np.floating, float)):
        f = float(obj)
        if math.isnan(f):
            return None
        if math.isinf(f):
            return "inf" if f > 0 else "-inf"
        return f
    return obj


def rnd(x: float | None, nd: int = 3) -> float | str | None:
    """四捨五入但保留 inf/None（給人看的欄位）。"""
    if x is None:
        return None
    f = float(x)
    if math.isinf(f):
        return "inf"
    if math.isnan(f):
        return None
    return round(f, nd)
