"""描框 / 描邊的純函式（只吃 numpy 陣列，不讀檔、不碰 ctx）。

## 這支在做什麼

把追蹤到的東西**標出來**疊在畫面上：外接方框、沿著輪廓描邊、或半透明填色。
用途是教學片圈重點、產品展示指出某個零件、比賽影片標人——這些現在都得拿去別的軟體做。

## 為什麼不是「畫上去就好」

三件事決定它看起來像不像商業軟體做的：

1. **線要壓在物件外緣，不是中心**。`cv2.drawContours` 的線寬是往兩側長的，
   線寬 6 就有 3 px 壓進物件裡，細節會被吃掉。所以描邊先把遮罩外擴半個線寬再畫。
2. **遮罩邊緣有鋸齒**，直接描會抖。先羽化再取等高線（`smooth_mask`）。
3. **合成要在線性 RGB 裡混**，跟 `comp/` 與背景虛化同一條路 —— 混用會讓疊上去的顏色
   在亮區偏掉，而那是「看起來很廉價」的來源。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    import numpy as np

Mode = Literal["box", "contour", "fill"]

#: 線寬預設（畫面寬度的百分比）。跟虛化強度同一個理由：同一個像素寬度在 720p 與 4K 上粗細差很多。
DEFAULT_WIDTH_PCT = 0.35
#: 線寬下限（像素）。低於 1 畫不出來。
MIN_WIDTH_PX = 1
#: 半透明填色的預設不透明度。再高就看不清底下的東西了。
DEFAULT_FILL_ALPHA = 0.28
#: 取等高線之前的羽化半徑（像素）。SAM 的邊有鋸齒，直接描會抖。
DEFAULT_SMOOTH_PX = 2


class OutlineError(ValueError):
    """描框的輸入錯誤。"""


def line_width_px(width: int, pct: float = DEFAULT_WIDTH_PCT) -> int:
    """線寬百分比 → 像素（至少 `MIN_WIDTH_PX`）。"""
    if width <= 0:
        raise OutlineError(f"畫面寬度要是正的（給了 {width}）")
    if not (pct > 0):
        raise OutlineError(f"線寬要大於 0（給了 {pct}）")
    return max(MIN_WIDTH_PX, int(round(width * pct / 100.0)))


def bounding_box(mask: "np.ndarray") -> tuple[int, int, int, int] | None:
    """遮罩的外接方框 `(x0, y0, x1, y1)`（半開）；空遮罩回 None。"""
    import numpy as np

    ys, xs = np.nonzero(mask)
    if not len(xs):
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def smooth_mask(mask: "np.ndarray", radius: int = DEFAULT_SMOOTH_PX) -> "np.ndarray":
    """羽化再二值化：把 SAM 遮罩的鋸齒磨掉，描出來的線才不會逐幀抖。"""
    import cv2
    import numpy as np

    if radius <= 0:
        return mask.astype(bool)
    k = 2 * int(radius) + 1
    blurred = cv2.GaussianBlur(mask.astype(np.float32), (k, k), 0)
    return blurred > 0.5


def grow(mask: "np.ndarray", px: int) -> "np.ndarray":
    """把遮罩往外長 `px`。描邊時用來把線推到物件外緣（見模組說明第 1 點）。"""
    import cv2
    import numpy as np

    if px <= 0:
        return mask.astype(bool)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * int(px) + 1,) * 2)
    return cv2.dilate(mask.astype(np.uint8), k) > 0


def stroke_alpha(mask: "np.ndarray", mode: Mode, width: int, smooth: int = DEFAULT_SMOOTH_PX) -> "np.ndarray":
    """要在哪些像素上畫，以及畫多重 → (H, W, 1) 的 float32 alpha ∈ [0, 1]。

    - `box`：外接方框的框線。
    - `contour`：沿著物件輪廓，**線壓在物件外側**（遮罩先外擴半個線寬）。
    - `fill`：整個物件半透明填色（呼叫端再乘上不透明度）。

    空遮罩一律回全 0：那一幀沒有東西可標，呼叫端會原樣放行。
    """
    import cv2
    import numpy as np

    h, w = mask.shape[:2]
    out = np.zeros((h, w), np.uint8)
    m = smooth_mask(mask, smooth)
    if not m.any():
        return out.astype(np.float32)[..., None]

    lw = max(MIN_WIDTH_PX, int(width))
    if mode == "fill":
        out[m] = 255
    elif mode == "box":
        box = bounding_box(m)
        if box:
            x0, y0, x1, y1 = box
            cv2.rectangle(out, (x0, y0), (x1 - 1, y1 - 1), 255, lw)
    else:
        # 線寬往兩側長，所以先把遮罩外擴半個線寬，畫出來的線才整條在物件外面
        grown = grow(m, (lw + 1) // 2)
        cnts, _ = cv2.findContours(grown.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        cv2.drawContours(out, cnts, -1, 255, lw)
    return (out.astype(np.float32) / 255.0)[..., None]


def composite_stroke(base: "np.ndarray", color: "np.ndarray | tuple[float, float, float]", alpha: "np.ndarray") -> "np.ndarray":
    """在 `base` 上用 `alpha` 疊上純色。dtype 不拘（線性 float 或 uint8）。

    跟 `inpaint.plate.blend` 同一個形狀，分開一支是因為這裡的 over 是**純色**，
    不需要另外造一張整圖。
    """
    import numpy as np

    c = np.asarray(color, np.float32)
    if c.shape != (3,):
        raise OutlineError(f"顏色要是 3 個分量，給了 {c.shape}")
    if alpha.shape[:2] != base.shape[:2]:
        raise OutlineError(f"alpha 與影像尺寸不同：{alpha.shape[:2]} vs {base.shape[:2]}")
    a = alpha if alpha.ndim == 3 else alpha[..., None]
    return base.astype(np.float32) * (1.0 - a) + c * a
