"""保留區政策與替換目標（§6.6 `comp/region.py`）。

- regionPolicy：`full`＝整面替換；`keepBarcode`（預設）＝條碼區從**矯正後的原始像素**複製（條碼是 ~10×8 px 灰塊，
  不是身分特徵，複製原像素最保真）；`hold`＝保持不動（合成器直接回原幀）。UI 文案：整面替換／保留條碼區／保持不動。
- target `"blank"`：只留紙面 ＝ tmpl_paper × S_lp（紙色填滿整張，再乘光影；高光照樣加回，因為反光屬於場景不屬於墨）。
- `derive_masks_from_template()`：從模板 PNG 推 ink / paper 遮罩（沒有 deck.json 的 regions 時的 fallback；
  單張預覽 op 也用它）。
所有陣列都在**工作模板空間**（同尺寸），線性 RGB float32。
"""
from __future__ import annotations

import cv2
import numpy as np


def derive_masks_from_template(rgb8: np.ndarray, alpha8: np.ndarray | None = None, *, ink_thresh: int = 170, sat_thresh: int = 40) -> tuple[np.ndarray, np.ndarray]:
    """(ink, paper) bool 遮罩。paper = 不透明區（沒 alpha → 全部）；ink = 暗（mean<ink_thresh）或有彩度（max-min>sat_thresh）且在 paper 內。"""
    rgb = rgb8.astype(np.int16)
    paper = np.ones(rgb8.shape[:2], dtype=bool) if alpha8 is None else alpha8 > 127
    mean = rgb.mean(axis=-1)
    sat = rgb.max(axis=-1) - rgb.min(axis=-1)
    ink = ((mean < ink_thresh) | (sat > sat_thresh)) & paper
    return ink, paper


def paper_colour(tmpl_lin: np.ndarray, paper_mask: np.ndarray, ink_mask: np.ndarray | None) -> np.ndarray:
    """紙色 (3,)：paper 且非 ink 像素的中位數；沒有樣本 → 模板全圖中位數。"""
    m = paper_mask.astype(bool)
    if ink_mask is not None:
        m = m & ~ink_mask.astype(bool)
    if int(m.sum()) < 16:
        m = paper_mask.astype(bool) if int(paper_mask.sum()) >= 16 else np.ones_like(m)
    return np.median(tmpl_lin[m], axis=0).astype(np.float32)


def fill_outside_silhouette(tmpl_lin: np.ndarray, silhouette: np.ndarray, colour: np.ndarray) -> np.ndarray:
    """輪廓（圓角）外填紙色，避免 PNG 透明區的黑／垃圾色經反鋸齒邊緣滲進來。"""
    out = tmpl_lin.copy()
    out[~silhouette.astype(bool)] = colour
    return out


def barcode_mask_from_rect(shape_hw: tuple[int, int], rect_frac: tuple[float, float, float, float] | None) -> np.ndarray | None:
    """deck.json regions.barcode（x,y,w,h 以模板比例表示）→ 工作空間 bool 遮罩。None → None。"""
    if rect_frac is None:
        return None
    h, w = shape_hw
    x, y, bw, bh = rect_frac
    m = np.zeros((h, w), dtype=bool)
    x0, y0 = int(round(x * w)), int(round(y * h))
    x1, y1 = int(round((x + bw) * w)), int(round((y + bh) * h))
    m[max(0, y0) : min(h, y1), max(0, x0) : min(w, x1)] = True
    return m


def compose_face(
    *,
    tmpl_new: np.ndarray,
    rect: np.ndarray,
    gain: np.ndarray,
    spec: np.ndarray,
    paper_rgb: np.ndarray,
    policy: str,
    target: str,
    keep_highlights: float,
    barcode_mask: np.ndarray | None,
    barcode_feather_px: float = 1.0,
) -> np.ndarray | None:
    """新牌面（工作空間、線性）：hold → None。

    face = base × S_lp + spec × keepHighlights；base = tmpl_new（card）或 紙色（blank）。
    keepBarcode：條碼區以 1 px 羽化邊界從 rect（矯正原像素）複製，避免硬接縫。
    """
    if policy == "hold":
        return None
    if target == "blank":
        base = np.empty_like(tmpl_new)
        base[...] = paper_rgb.reshape(1, 1, 3)
    else:
        base = tmpl_new
    face = base * gain + spec * np.float32(keep_highlights)
    if policy == "keepBarcode" and barcode_mask is not None and barcode_mask.any():
        bm = barcode_mask.astype(np.float32)
        if barcode_feather_px > 0:
            bm = cv2.GaussianBlur(bm, (0, 0), barcode_feather_px * 0.5)
        bm = bm[..., None]
        face = face * (1.0 - bm) + rect * bm
    return face.astype(np.float32, copy=False)
