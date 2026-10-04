"""背景虛化的純函式（只吃 numpy 陣列，不讀檔、不碰 ctx）。

模組整體的理由見 `aivc/bg/__init__.py`。這裡最要緊的一支是 `normalized_blur`：
它是「主體邊緣不留光暈」的原因，而光暈是這個功能做得好不好唯一看得出來的地方。
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np


class BgError(ValueError):
    """背景合成的輸入錯誤（尺寸對不上、參數不合理）。"""


#: 預設強度：畫面寬度的百分比。
#:
#: **實測**（`close_2p2_d11` 的 proxy，1260×720，第 60 幀；整張的 Laplacian 變異數，
#: 原圖 = 63.4，數字是「還剩多少細節」）：
#:
#:     0.5%   r= 6px   4.60%   ← 洋裝的點點還看得見，等於沒虛化
#:     1.0%   r=13px   1.97%
#:     1.5%   r=19px   1.64%   ← 取這個
#:     2.0%   r=25px   1.53%
#:     3.0%   r=38px   1.47%
#:     4.0%   r=50px   1.46%
#:
#: 曲線在 1.0–1.5% 之間就壓平了：2% 之後每加一倍半徑只再拿掉 0.07 個百分點的細節，
#: 但核的成本一路漲。目視也一致 —— 1.5% 時材質與點點都沒了、構圖還在（人像模式要的就是這個），
#: 3% 開始連牌放在哪都看不出來。所以取 **1.5**：再高只是變慢。
DEFAULT_STRENGTH_PCT = 1.5
#: 上面那次實測的兩個參考點，測試拿它們守住「預設落在壓平之後、但還沒到看不出構圖」。
MEASURED_TOO_WEAK_PCT = 0.5
MEASURED_TOO_STRONG_PCT = 3.0
#: 半徑的下限（像素）。再小的核在視覺上等於沒做，只是白白重編碼一遍。
MIN_RADIUS_PX = 2
#: 主體遮罩合成前先膨脹幾個像素。SAM 的邊通常比主體緊一兩格，不補會沿著輪廓咬掉一圈。
DEFAULT_DILATE = 2
#: 主體邊緣的羽化半徑（像素）。硬邊會讓「貼上去」的感覺很明顯。
DEFAULT_FEATHER = 3


def blur_radius_px(width: int, strength_pct: float = DEFAULT_STRENGTH_PCT) -> int:
    """強度（畫面寬度的百分比）→ 模糊半徑（像素）。

    跟著寬度走是因為同一個像素半徑在 720p 與 4K 上是完全不同的視覺強度。
    低於 `MIN_RADIUS_PX` 的一律夾上去：再小的核等於沒做，但還是要重編碼一次。
    """
    if width <= 0:
        raise BgError(f"畫面寬度要是正的（給了 {width}）")
    if not (strength_pct > 0):
        raise BgError(f"強度要大於 0（給了 {strength_pct}）")
    return max(MIN_RADIUS_PX, int(round(width * strength_pct / 100.0)))


def normalized_blur(img: "np.ndarray", weight: "np.ndarray", radius: int) -> "np.ndarray":
    """加權模糊：只讓 `weight > 0` 的像素參與平均。

    `img` 是 (H, W, C) 的 float32，`weight` 是 (H, W) 或 (H, W, 1) 的 float32 ∈ [0, 1]。

    做法是 `blur(img * w) / blur(w)` —— 主體像素的權重是 0，所以它們不進分子也不進分母，
    結構上不可能把主體的顏色帶進背景。這就是主體邊緣不留光暈的原因（見模組說明）。

    權重整片為 0 的地方（例如主體正中央）分母會是 0：那些像素等一下會被主體蓋掉，
    填什麼都看不到，所以直接回原值，不做除法。
    """
    import cv2
    import numpy as np

    if img.ndim != 3:
        raise BgError(f"影像要是 (H, W, C)，給了 {img.shape}")
    w2 = weight if weight.ndim == 2 else weight[..., 0]
    if w2.shape != img.shape[:2]:
        raise BgError(f"權重與影像尺寸不同：{w2.shape} vs {img.shape[:2]}")
    r = max(1, int(radius))
    ks = 2 * r + 1  # 高斯核一定要奇數

    f = img.astype(np.float32, copy=False)
    wf = w2.astype(np.float32, copy=False)
    num = cv2.GaussianBlur(f * wf[..., None], (ks, ks), 0)
    den = cv2.GaussianBlur(wf, (ks, ks), 0)
    ok = den > 1e-4
    out = np.where(ok[..., None], num / np.maximum(den, 1e-4)[..., None], f)
    return out.astype(np.float32)


def blurred_background(rgb: "np.ndarray", subject_alpha: "np.ndarray", radius: int) -> "np.ndarray":
    """整張圖的「背景版本」：主體被排除在模糊之外。

    `subject_alpha` 是主體的羽化 alpha（(H, W) 或 (H, W, 1)，1 = 完全是主體）。
    回傳與 `rgb` 同形狀的 float32；呼叫端再用同一個 alpha 把主體混回去。
    """
    a = subject_alpha if subject_alpha.ndim == 2 else subject_alpha[..., 0]
    return normalized_blur(rgb, 1.0 - a, radius)


def solid_background(rgb: "np.ndarray", color: "np.ndarray | tuple[float, float, float]") -> "np.ndarray":
    """整張圖的「背景版本」＝純色。與 `blurred_background` 可以互換，供換背景色用。"""
    import numpy as np

    c = np.asarray(color, np.float32)
    if c.shape != (3,):
        raise BgError(f"顏色要是 3 個分量，給了 {c.shape}")
    return np.broadcast_to(c, rgb.shape).astype(np.float32).copy()


def subject_coverage(alpha: "np.ndarray") -> float:
    """主體佔畫面的比例（用 alpha 的平均，羽化區算部分）。

    UI 拿它講「這一幀幾乎整片都是主體」或「一個主體都沒找到」—— 兩種都代表追蹤出了問題，
    而不是背景虛化本身的問題。
    """
    import numpy as np

    a = alpha if alpha.ndim == 2 else alpha[..., 0]
    return float(np.clip(a, 0.0, 1.0).mean())
