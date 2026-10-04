"""遮罩類特效的「作用範圍」：一張 alpha（0 ＝ 不碰這個像素）＋ 它所在的視窗。

為什麼要有視窗：一個 80×80 的臉在 4K 畫面上，整張畫面做膨脹／高斯是 8 MB 的白工。這裡只在
「物件外接框 + expand + feather + 邊界」的視窗裡算，回傳視窗原點，合成時再貼回去。

`alpha == 0` 的像素就是「作用範圍外」，`fx/apply.py` 保證它們的位元組不動。高斯羽化的尾巴小於 1/512 的直接歸零
（不然尾巴會一路拖到視窗邊，「範圍」就不是使用者以為的那個範圍）。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from ..objects.track import ObjectFrame
from .params import Footprint

ALPHA_FLOOR = 1.0 / 512.0


@dataclass
class Region:
    x0: int  # 視窗左上角（畫面座標）
    y0: int
    alpha: np.ndarray  # (h, w) float32 0..1；0 ＝ 範圍外
    core: np.ndarray  # (h, w) bool：羽化前的硬範圍（模糊只用這裡的像素平均）

    @property
    def x1(self) -> int:
        return self.x0 + int(self.alpha.shape[1])

    @property
    def y1(self) -> int:
        return self.y0 + int(self.alpha.shape[0])


def clamp_window(x0: float, y0: float, x1: float, y1: float, width: int, height: int) -> tuple[int, int, int, int] | None:
    a, b = max(0, int(math.floor(x0))), max(0, int(math.floor(y0)))
    c, d = min(int(width), int(math.ceil(x1))), min(int(height), int(math.ceil(y1)))
    if c <= a or d <= b:
        return None
    return a, b, c, d


def morph(mask: np.ndarray, px: float) -> np.ndarray:
    """膨脹（px > 0）／侵蝕（px < 0），橢圓核；回 bool。"""
    import cv2

    r = int(round(abs(px)))
    m = mask.astype(np.uint8)
    if r == 0:
        return m.astype(bool)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    out = cv2.dilate(m, k) if px > 0 else cv2.erode(m, k, borderType=cv2.BORDER_CONSTANT, borderValue=1)
    return out.astype(bool)


def feather_alpha(core: np.ndarray, feather: float) -> np.ndarray:
    """硬範圍 → 羽化 alpha。邊界用 BORDER_REPLICATE：視窗被畫面邊切掉時，預設的 REFLECT_101 會把物件鏡射到畫面外
    變成一個「幻影物件」，貼近畫面邊的 alpha 被灌大（實測 2 倍）。REPLICATE＝碰到畫面邊的物件照樣往外延續、沒碰到的是 0。"""
    import cv2

    a = core.astype(np.float32)
    f = int(math.ceil(max(0.0, float(feather))))
    if f > 0:
        a = cv2.GaussianBlur(a, (2 * f + 1, 2 * f + 1), 0, borderType=cv2.BORDER_REPLICATE)
    a[a < ALPHA_FLOOR] = 0.0
    return a


def _shape_core(shape: str, box: tuple[float, float, float, float], e: float, x0: int, y0: int, x1: int, y1: int) -> np.ndarray | None:
    """box／ellipse 在視窗 [x0, x1) × [y0, y1) 裡的硬範圍（bool）；橢圓半軸 ≤ 0 → None。"""
    bx, by, bw, bh = box
    xs = np.arange(x0, x1, dtype=np.float32) + 0.5
    ys = np.arange(y0, y1, dtype=np.float32) + 0.5
    if shape == "box":
        cx = (xs >= bx - e) & (xs < bx + bw + e)
        cy = (ys >= by - e) & (ys < by + bh + e)
        return cy[:, None] & cx[None, :]
    # ellipse：外接框的內切橢圓，半軸各加 expand
    rx, ry = bw / 2.0 + e, bh / 2.0 + e
    if rx <= 0 or ry <= 0:
        return None
    ccx, ccy = bx + bw / 2.0, by + bh / 2.0
    return (((xs[None, :] - ccx) / rx) ** 2 + ((ys[:, None] - ccy) / ry) ** 2) <= 1.0


def footprint_region(obj: ObjectFrame, fp: Footprint, width: int, height: int, *, margin: int = 0) -> Region | None:
    """物件這一幀的作用範圍。物件不在 → None。margin＝視窗再外擴幾 px（要讀周圍像素的特效用）。

    box／ellipse 開著 smooth 時，範圍＝「平滑框的形狀」**聯集**「這一幀原始框的形狀」：平滑只能讓範圍變大、不能變小。
    只用平滑框的話，物件抖動、急停、折返時 SG 跟不上，真正的物件會有一截露在範圍外 —— 隱私打碼漏出原圖
    （實測 ±8 px 手持晃動，60×80 的臉最多 488 px 沒打到；40 px/幀橫移後急停，11 欄沒打到）。"""
    if not obj.visible or obj.anchor is None or obj.mask is None:
        return None
    a = obj.anchor
    e = float(fp.expand)
    f = int(math.ceil(max(0.0, float(fp.feather))))
    box = a.bbox if fp.shape == "mask" else a.box(fp.smooth)
    if box is None:
        return None
    boxes = [box]
    if fp.shape != "mask" and a.bbox is not None and tuple(a.bbox) != tuple(box):
        boxes.append(a.bbox)
    pad = max(0.0, e) + f + 2 + int(margin)
    win = clamp_window(
        min(b[0] for b in boxes) - pad, min(b[1] for b in boxes) - pad,
        max(b[0] + b[2] for b in boxes) + pad, max(b[1] + b[3] for b in boxes) + pad, width, height,
    )
    if win is None:
        return None
    x0, y0, x1, y1 = win
    if fp.shape == "mask":
        core = morph(obj.mask[y0:y1, x0:x1], e)
    else:
        cores = [c for c in (_shape_core(fp.shape, b, e, x0, y0, x1, y1) for b in boxes) if c is not None]
        if not cores:
            return None
        core = cores[0]
        for c in cores[1:]:
            core = core | c
    alpha = feather_alpha(core, f)
    if not np.any(alpha > 0):
        return None
    return Region(x0, y0, alpha, core)
