"""色彩咽喉（計畫 §5.2）：yuv420p（limited range）⇄ 線性全範圍 float32 RGB，純 numpy。

    Y'CbCr (uint8, tv range) ─normalise─▶ R'G'B' (gamma, 0..1 名義) ─EOTF─▶ RGB linear float32
                                 ▲                                                  │
                                 └────────── OETF ◀── (合成器改完) ◀────────────────┘

決策：
- 矩陣：BT.709（Kr=0.2126, Kb=0.0722）或 BT.601（Kr=0.299, Kb=0.114）；係數依 tv/pc range 用 219/224 或 255。
- 色度：`chroma_loc="center"`（預設，計畫「半像素對位」：色度樣本在 2×2 亮度格中央）雙線性上採樣；
  另提供 "left"（MPEG-2/H.264 的 AVCHROMA_LOC_LEFT：水平對齊左邊亮度、垂直居中）。
- 反向色度縮小：`chroma_down="inverse"`（預設）是上採樣運算子的**精確左反元素**（每軸一個三對角解，
  D∘U = I），所以 yuv→rgb→yuv 在 float32 內無損、random 幀往返誤差 ≤ 1/255 —— 這保證合成器只改遮罩內
  像素時，遮罩邊界跨到的 2×2 色度格不會被平滑污染。它在色度 Nyquist 的增益是 2，會裁到 [1,254]。
  `"box"` 是普通 2×2 平均（較軟，看到振鈴時可切）。
- 轉移函數：`transfer="bt709"`（預設）用 BT.709 OETF 的反函數（精確常數 α=1.0993、β=0.0181，連續且單調），
  與 ffmpeg/zimg `zscale=t=linear` 相同、影片 tag 也是 bt709；`"srgb"` 備用。合成器的乘法式重打光
  對曲線選擇不敏感，但**同一條曲線來回**是必要條件，所以線性化與再編碼都只在這個檔裡。
  負值／>1 的值以奇函數延伸（sign·f(|x|)），random Y'CbCr 才能可逆。
- 8-bit 輸出 `rgb8`：R'G'B' 全範圍 ×255 四捨五入；Y'=16 → 0、Y'=235 → 255。
  熱路徑 `yuv420_to_rgb8_fast`（Yuv420.rgb8 用）色度上採樣借 cv2.resize、分條多執行緒，與這裡的 numpy 參考路徑逐位元相同（見檔尾）。
"""
from __future__ import annotations

import os
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Literal

import numpy as np

Matrix = Literal["bt709", "bt601"]
ChromaLoc = Literal["center", "left"]
Transfer = Literal["bt709", "srgb"]

_KR_KB: dict[str, tuple[float, float]] = {"bt709": (0.2126, 0.0722), "bt601": (0.299, 0.114)}

# BT.709 OETF 精確常數（讓 4.5β = αβ^0.45 − (α−1) 連續）
_A709 = 1.09929682680944
_B709 = 0.018053968510807


def _coeffs(matrix: str) -> tuple[float, float, float]:
    try:
        kr, kb = _KR_KB[matrix]
    except KeyError as e:
        raise ValueError(f"未知矩陣 {matrix!r}（bt709|bt601）") from e
    return kr, 1.0 - kr - kb, kb


def _weights(chroma_loc: str) -> tuple[tuple[float, float], tuple[float, float]]:
    """(垂直 (wa, wb), 水平 (wa, wb))：out[2i] 取 wa 的鄰居 i-1、out[2i+1] 取 wb 的鄰居 i+1。"""
    if chroma_loc == "center":
        return (0.25, 0.25), (0.25, 0.25)
    if chroma_loc == "left":
        return (0.25, 0.25), (0.0, 0.5)
    raise ValueError(f"未知 chroma_loc {chroma_loc!r}（center|left）")


# ---------------------------------------------------------------- 色度上／下採樣
def _up1d(x: np.ndarray, axis: int, wa: float, wb: float) -> np.ndarray:
    """沿 axis 2 倍雙線性：邊界鄰居 clamp（複製邊緣）。"""
    x = np.moveaxis(x, axis, 0)
    prev = np.concatenate([x[:1], x[:-1]], axis=0)
    nxt = np.concatenate([x[1:], x[-1:]], axis=0)
    even = (1.0 - wa) * x + wa * prev
    odd = (1.0 - wb) * x + wb * nxt
    out = np.stack([even, odd], axis=1).reshape((2 * x.shape[0],) + x.shape[1:])
    return np.moveaxis(out, 0, axis)


def upsample_chroma(c: np.ndarray, height: int, width: int, chroma_loc: str = "center") -> np.ndarray:
    """(ceil(h/2), ceil(w/2)) → (h, w) float32。"""
    (va, vb), (ha, hb) = _weights(chroma_loc)
    x = c.astype(np.float32, copy=False)
    x = _up1d(x, 0, va, vb)
    x = _up1d(x, 1, ha, hb)
    return x[:height, :width]


def _box2(x: np.ndarray) -> np.ndarray:
    h, w = x.shape
    if h % 2 or w % 2:  # 奇數尺寸：邊緣複製補齊到偶數
        x = np.pad(x, ((0, h % 2), (0, w % 2)), mode="edge")
    return x.reshape(x.shape[0] // 2, 2, x.shape[1] // 2, 2).mean(axis=(1, 3), dtype=np.float64)


def _solve_tridiag_axis0(d: np.ndarray, wa: float, wb: float) -> np.ndarray:
    """解 T x = d（沿 axis 0），T = box∘up 的一維矩陣：lower 0.5wa、diag 1−0.5(wa+wb)、upper 0.5wb，
    邊界 clamp 把掉出去的權重加回對角。嚴格對角優勢 → Thomas 演算法穩定。"""
    n = d.shape[0]
    lo, di, up = 0.5 * wa, 1.0 - 0.5 * (wa + wb), 0.5 * wb
    b = np.full(n, di, dtype=np.float64)
    b[0] += lo
    b[-1] += up
    cp = np.empty(n, dtype=np.float64)
    dp = np.empty_like(d, dtype=np.float64)
    cp[0] = up / b[0]
    dp[0] = d[0] / b[0]
    for i in range(1, n):
        denom = b[i] - lo * cp[i - 1]
        cp[i] = (up if i < n - 1 else 0.0) / denom
        dp[i] = (d[i] - lo * dp[i - 1]) / denom
    x = np.empty_like(dp)
    x[-1] = dp[-1]
    for i in range(n - 2, -1, -1):
        x[i] = dp[i] - cp[i] * x[i + 1]
    return x


def downsample_chroma(cf: np.ndarray, chroma_loc: str = "center", mode: str = "inverse") -> np.ndarray:
    """(h, w) → (ceil(h/2), ceil(w/2)) float32。mode = "inverse"（精確反元素）| "box"。"""
    b = _box2(cf.astype(np.float64, copy=False))
    if mode == "box":
        return b.astype(np.float32)
    if mode != "inverse":
        raise ValueError(f"未知 chroma_down {mode!r}（inverse|box）")
    (va, vb), (ha, hb) = _weights(chroma_loc)
    x = _solve_tridiag_axis0(b, va, vb)
    x = _solve_tridiag_axis0(x.T, ha, hb).T
    return x.astype(np.float32)


# ---------------------------------------------------------------- 矩陣
def yuv_to_rgb_gamma(
    y: np.ndarray, u: np.ndarray, v: np.ndarray, *, matrix: str = "bt709", full_range: bool = False, chroma_loc: str = "center"
) -> np.ndarray:
    """yuv420p planes (uint8) → gamma 編碼 R'G'B' float32 (H,W,3)，名義 0..1（不裁切，可能超界）。"""
    kr, kg, kb = _coeffs(matrix)
    h, w = y.shape
    yf = y.astype(np.float32)
    uf = upsample_chroma(u, h, w, chroma_loc)
    vf = upsample_chroma(v, h, w, chroma_loc)
    if full_range:
        ey = yf / 255.0
        ecb = (uf - 128.0) / 255.0
        ecr = (vf - 128.0) / 255.0
    else:
        ey = (yf - 16.0) / 219.0
        ecb = (uf - 128.0) / 224.0
        ecr = (vf - 128.0) / 224.0
    r = ey + 2.0 * (1.0 - kr) * ecr
    b = ey + 2.0 * (1.0 - kb) * ecb
    g = (ey - kr * r - kb * b) / kg
    return np.stack([r, g, b], axis=-1).astype(np.float32)


def rgb_gamma_to_yuv(
    rgb: np.ndarray,
    *,
    matrix: str = "bt709",
    full_range: bool = False,
    chroma_loc: str = "center",
    chroma_down: str = "inverse",
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """gamma 編碼 R'G'B' float32 (H,W,3) → yuv420p planes uint8（裁到合法範圍）。"""
    kr, kg, kb = _coeffs(matrix)
    rgb = rgb.astype(np.float32, copy=False)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    ey = kr * r + kg * g + kb * b
    ecb = (b - ey) / (2.0 * (1.0 - kb))
    ecr = (r - ey) / (2.0 * (1.0 - kr))
    if full_range:
        yf = ey * 255.0
        cbf = ecb * 255.0 + 128.0
        crf = ecr * 255.0 + 128.0
        lo, hi = 0.0, 255.0
    else:
        yf = ey * 219.0 + 16.0
        cbf = ecb * 224.0 + 128.0
        crf = ecr * 224.0 + 128.0
        lo, hi = 1.0, 254.0  # 允許 footroom/headroom（來源 tv range 資料本來就可能超出 16..235）
    yo = np.clip(np.rint(yf), lo, hi).astype(np.uint8)
    uo = np.clip(np.rint(downsample_chroma(cbf, chroma_loc, chroma_down)), lo, hi).astype(np.uint8)
    vo = np.clip(np.rint(downsample_chroma(crf, chroma_loc, chroma_down)), lo, hi).astype(np.uint8)
    return yo, uo, vo


# ---------------------------------------------------------------- 轉移函數
def _odd(f, x: np.ndarray) -> np.ndarray:  # noqa: ANN001
    return np.sign(x) * f(np.abs(x))


def eotf(v: np.ndarray, transfer: str = "bt709") -> np.ndarray:
    """gamma 編碼 → 線性（奇函數延伸；float32）。"""
    v = np.asarray(v, dtype=np.float32)
    if transfer == "bt709":
        knee = 4.5 * _B709

        def f(a: np.ndarray) -> np.ndarray:
            return np.where(a < knee, a / 4.5, np.power((a + (_A709 - 1.0)) / _A709, 1.0 / 0.45))

    elif transfer == "srgb":

        def f(a: np.ndarray) -> np.ndarray:
            return np.where(a <= 0.04045, a / 12.92, np.power((a + 0.055) / 1.055, 2.4))

    else:
        raise ValueError(f"未知 transfer {transfer!r}（bt709|srgb）")
    return _odd(f, v).astype(np.float32)


def oetf(lin: np.ndarray, transfer: str = "bt709") -> np.ndarray:
    """線性 → gamma 編碼（eotf 的反函數）。"""
    lin = np.asarray(lin, dtype=np.float32)
    if transfer == "bt709":

        def f(a: np.ndarray) -> np.ndarray:
            return np.where(a < _B709, 4.5 * a, _A709 * np.power(a, 0.45) - (_A709 - 1.0))

    elif transfer == "srgb":

        def f(a: np.ndarray) -> np.ndarray:
            return np.where(a <= 0.0031308, 12.92 * a, 1.055 * np.power(a, 1.0 / 2.4) - 0.055)

    else:
        raise ValueError(f"未知 transfer {transfer!r}（bt709|srgb）")
    return _odd(f, lin).astype(np.float32)


# ---------------------------------------------------------------- 端到端
def yuv420_to_rgb_linear(
    y: np.ndarray, u: np.ndarray, v: np.ndarray, *, matrix: str = "bt709", full_range: bool = False,
    transfer: str = "bt709", chroma_loc: str = "center",
) -> np.ndarray:
    return eotf(yuv_to_rgb_gamma(y, u, v, matrix=matrix, full_range=full_range, chroma_loc=chroma_loc), transfer)


def rgb_linear_to_yuv420(
    rgb_lin: np.ndarray, *, matrix: str = "bt709", full_range: bool = False, transfer: str = "bt709",
    chroma_loc: str = "center", chroma_down: str = "inverse",
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    return rgb_gamma_to_yuv(oetf(rgb_lin, transfer), matrix=matrix, full_range=full_range, chroma_loc=chroma_loc, chroma_down=chroma_down)


def rgb_gamma_to_rgb8(rgb: np.ndarray) -> np.ndarray:
    """R'G'B' 名義 0..1 → uint8 全範圍（裁切 + 四捨五入）。"""
    return np.clip(np.rint(rgb * 255.0), 0, 255).astype(np.uint8)


def rgb_linear_to_rgb8(rgb_lin: np.ndarray, transfer: str = "bt709") -> np.ndarray:
    return rgb_gamma_to_rgb8(oetf(rgb_lin, transfer))


def psnr(a: np.ndarray, b: np.ndarray, peak: float = 255.0) -> float:
    """兩個 uint8/float 平面的 PSNR（dB）；完全相同回 inf。"""
    d = a.astype(np.float64) - b.astype(np.float64)
    mse = float(np.mean(d * d))
    if mse == 0.0:
        return float("inf")
    return 10.0 * np.log10(peak * peak / mse)


# ---------------------------------------------------------------- 快速 yuv420p → rgb8（center 色度；逐位元等於上面的參考路徑）
# 每幀第一次轉 RGB（FrameCache 之後 seg/track/identify 共用）原本要 26 ms（1280×720）：_up1d 的 concatenate/stack
# 與整張 float32 暫存陣列。這裡同一套 float32 運算、同一個運算順序，只換掉慢的部分：
# - 2× 色度上採樣改 cv2.resize(INTER_LINEAR)：dst 偶數列取 0.75·自己 + 0.25·前一格、奇數列 0.75·自己 + 0.25·後一格，
#   邊界 clamp —— 與 _up1d(center) 同一組係數；uint8 值經兩軸插值都是 1/16 的整數倍且 < 256，float32 精確表示，
#   所以不論 cv2 內部加總順序或 SIMD 都得到相同位元。
# - 矩陣／×255／rint／clip 用 out= 就地運算，按列切條丟執行緒池（numpy ufunc 會放 GIL；各條寫 out 的不同列，不重疊）。
# 參考路徑（rgb_gamma_to_rgb8(yuv_to_rgb_gamma(...))）保留：chroma_loc="left"、非 uint8 輸入走它，測試也拿它當 oracle。
# AIVC_RGB8_THREADS=1 強制單執行緒（單執行緒也已經從 26 ms 降到約 10 ms）。
RGB8_THREADS_ENV = "AIVC_RGB8_THREADS"
_RGB8_MAX_THREADS = 8
_RGB8_MIN_PIXELS_PER_STRIP = 1 << 16  # 小於這個像素數的條不值得排程（7×5 測試幀、縮圖）
_rgb8_pool: tuple[int, int, ThreadPoolExecutor] | None = None  # (pid, workers, pool)；第一次用才建（不在 import 時）
_rgb8_pool_lock = threading.Lock()


def rgb8_threads() -> int:
    """切條數上限：AIVC_RGB8_THREADS（≥1）或 min(8, CPU 數)。"""
    raw = os.environ.get(RGB8_THREADS_ENV, "").strip()
    if raw:
        try:
            return max(1, int(raw))
        except ValueError:
            pass
    return max(1, min(_RGB8_MAX_THREADS, os.cpu_count() or 1))


def _rgb8_executor(workers: int) -> ThreadPoolExecutor:
    """行程內共用的執行緒池；fork 出來的子行程（pid 變了）或要更多 worker 時重建。

    換掉的舊池要 `shutdown(wait=False)`：只換參照的話舊的閒置執行緒留到行程結束。
    worker 數另外夾上限（`_RGB8_MAX_THREADS`，`AIVC_RGB8_THREADS` 調得更高時以它為準）：`threads=` 是測試用的
    旗標，傳一個大數字會照著開（實測 `threads=10000` 在 720 列的畫面上開出 720 條執行緒），而且那個過大的池
    會被之後的預設呼叫沿用。切幾條（`n`）不受影響，所以輸出仍然逐位元相同，只是同時跑的條數有上限。
    """
    global _rgb8_pool  # noqa: PLW0603
    workers = max(1, min(int(workers), max(_RGB8_MAX_THREADS, rgb8_threads())))
    with _rgb8_pool_lock:
        pid = os.getpid()
        if _rgb8_pool is None or _rgb8_pool[0] != pid or _rgb8_pool[1] < workers:
            old = _rgb8_pool
            _rgb8_pool = (pid, workers, ThreadPoolExecutor(max_workers=workers, thread_name_prefix="aivc-rgb8"))
            if old is not None and old[0] == pid:
                old[2].shutdown(wait=False)
        return _rgb8_pool[2]


def _rgb8_strip(
    y: np.ndarray, uf: np.ndarray, vf: np.ndarray, out: np.ndarray, r0: int, r1: int,
    full_range: bool, kr: float, kg: float, kb: float,
) -> None:
    """列 [r0, r1) 的 yuv_to_rgb_gamma + rgb_gamma_to_rgb8，運算順序與參考路徑逐項相同（float32 純量都先轉 float32）。"""
    f32 = np.float32
    ey = y[r0:r1].astype(np.float32)
    ecb = np.subtract(uf[r0:r1], f32(128.0))
    ecr = np.subtract(vf[r0:r1], f32(128.0))
    if full_range:
        np.divide(ey, f32(255.0), out=ey)
        np.divide(ecb, f32(255.0), out=ecb)
        np.divide(ecr, f32(255.0), out=ecr)
    else:
        np.subtract(ey, f32(16.0), out=ey)
        np.divide(ey, f32(219.0), out=ey)
        np.divide(ecb, f32(224.0), out=ecb)
        np.divide(ecr, f32(224.0), out=ecr)
    r = np.multiply(f32(2.0 * (1.0 - kr)), ecr, out=ecr)  # r = ey + 2(1−kr)·ecr
    np.add(ey, r, out=r)
    b = np.multiply(f32(2.0 * (1.0 - kb)), ecb, out=ecb)  # b = ey + 2(1−kb)·ecb
    np.add(ey, b, out=b)
    g = np.multiply(f32(kr), r)  # g = ((ey − kr·r) − kb·b) / kg
    np.subtract(ey, g, out=g)
    kb_b = np.multiply(f32(kb), b, out=ey)  # ey 之後用不到，拿來放 kb·b
    np.subtract(g, kb_b, out=g)
    np.divide(g, f32(kg), out=g)
    for ci, ch in enumerate((r, g, b)):
        np.multiply(ch, f32(255.0), out=ch)
        np.rint(ch, out=ch)
        np.clip(ch, f32(0.0), f32(255.0), out=ch)
        out[r0:r1, :, ci] = ch  # [0,255] 內的整數值 float32 → uint8，與 astype 相同


def yuv420_to_rgb8_fast(
    y: np.ndarray, u: np.ndarray, v: np.ndarray, *, matrix: str = "bt709", full_range: bool = False, threads: int | None = None,
) -> np.ndarray:
    """yuv420p planes (uint8) → uint8 (H,W,3) gamma 全範圍 RGB，center 色度。

    結果與 `rgb_gamma_to_rgb8(yuv_to_rgb_gamma(y, u, v, matrix=, full_range=, chroma_loc="center"))` 逐位元相同。
    非 uint8 或色度尺寸不是 ceil(h/2)×ceil(w/2) 時直接走參考路徑。
    threads=None：AIVC_RGB8_THREADS／CPU 數，且每條至少 65536 像素；明確給 threads 就照切（測試條邊界用）。
    """
    kr, kg, kb = _coeffs(matrix)
    h, w = y.shape if y.ndim == 2 else (0, 0)
    if (
        h == 0 or w == 0 or y.dtype != np.uint8 or u.dtype != np.uint8 or v.dtype != np.uint8
        or u.shape != ((h + 1) // 2, (w + 1) // 2) or v.shape != u.shape
    ):
        return rgb_gamma_to_rgb8(yuv_to_rgb_gamma(y, u, v, matrix=matrix, full_range=full_range, chroma_loc="center"))
    import cv2

    ch, cw = u.shape
    uf = cv2.resize(u.astype(np.float32), (2 * cw, 2 * ch), interpolation=cv2.INTER_LINEAR)[:h, :w]
    vf = cv2.resize(v.astype(np.float32), (2 * cw, 2 * ch), interpolation=cv2.INTER_LINEAR)[:h, :w]
    out = np.empty((h, w, 3), np.uint8)
    if threads is None:
        n = min(rgb8_threads(), h, max(1, (h * w) // _RGB8_MIN_PIXELS_PER_STRIP))
    else:
        n = min(max(1, int(threads)), h)
    if n <= 1:
        _rgb8_strip(y, uf, vf, out, 0, h, full_range, kr, kg, kb)
        return out
    bounds = [(h * i) // n for i in range(n + 1)]
    pool = _rgb8_executor(n)
    futs = [pool.submit(_rgb8_strip, y, uf, vf, out, bounds[i], bounds[i + 1], full_range, kr, kg, kb) for i in range(n)]
    for f in futs:
        f.result()
    return out
