"""合成器測試用的人造場景：已知模板、已知 H、已知光影梯度，渲染成 yuv420p 幀。

不需要範例影片、不需要 GPU。所有東西都在線性 RGB 算，最後才量化成 yuv420p，讓
「遮罩外逐位元相同」「identity 替換 PSNR」等測試有精確的 ground truth。
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from aivc.comp import _color
from aivc.comp.blur import H_from_quad

TMPL_W, TMPL_H = 220, 320  # 直式牌模板（原生）
FRAME_W, FRAME_H = 400, 300
PAPER8 = (236, 236, 232)
FELT_LIN = np.array([0.015, 0.05, 0.22], dtype=np.float32)


def make_template(kind: str = "orig", soft_px: float = 1.0) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """→ (rgb8, ink_mask, paper_mask, barcode_mask)，模板空間 (TMPL_H, TMPL_W)。
    kind="orig"：左上黑色方塊角標 + 右上紅菱形 + 中央灰條碼 + 下緣鏡射；kind="new"：不同形狀的角標（黑圓 + 紅方）。"""
    img = np.zeros((TMPL_H, TMPL_W, 3), dtype=np.uint8)
    img[...] = PAPER8
    ink = np.zeros((TMPL_H, TMPL_W), dtype=np.uint8)
    barcode = np.zeros((TMPL_H, TMPL_W), dtype=bool)

    def draw(canvas: np.ndarray, mask: np.ndarray, color: tuple[int, int, int]) -> None:
        canvas[mask.astype(bool)] = color
        ink[mask.astype(bool)] = 1

    yy, xx = np.mgrid[0:TMPL_H, 0:TMPL_W]
    if kind == "orig":
        idx = (xx >= 22) & (xx < 70) & (yy >= 24) & (yy < 96)  # 黑方塊角標
        dia = (np.abs(xx - 160) / 30 + np.abs(yy - 60) / 36) < 1.0  # 紅菱形
    else:
        idx = ((xx - 46) ** 2 + (yy - 60) ** 2) < 30**2  # 黑圓
        dia = (xx >= 130) & (xx < 190) & (yy >= 28) & (yy < 92)  # 紅方塊
    draw(img, idx, (20, 20, 20))
    draw(img, dia, (200, 30, 30))
    # 180° 鏡射
    idx_m = idx[::-1, ::-1]
    dia_m = dia[::-1, ::-1]
    draw(img, idx_m, (20, 20, 20))
    draw(img, dia_m, (200, 30, 30))
    # 條碦：中央灰塊（不算「身分墨」，但屬於 ink_orig 讓光影估計避開它）
    bc = (xx >= 95) & (xx < 125) & (yy >= 150) & (yy < 170)
    img[bc] = (120, 120, 120)
    ink[bc] = 1
    barcode |= bc
    if soft_px > 0:
        img = cv2.GaussianBlur(img, (0, 0), soft_px)
    # 圓角輪廓
    paper = rounded_rect_mask(TMPL_W, TMPL_H, radius=16)
    return img, ink.astype(bool), paper, barcode


def rounded_rect_mask(w: int, h: int, radius: int) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w]
    cx = np.clip(xx, radius - 0.5, w - radius - 0.5)
    cy = np.clip(yy, radius - 0.5, h - radius - 0.5)
    return ((xx - cx) ** 2 + (yy - cy) ** 2) <= radius**2


def gradient(shape_hw: tuple[int, int], lo: float = 0.72, hi: float = 1.06, tint=(1.0, 0.985, 1.05)) -> np.ndarray:
    """模板空間的光影：上下線性漸層 × 藍色偏（模擬桌布反光）。"""
    h, w = shape_hw
    ramp = np.linspace(lo, hi, h, dtype=np.float32)[:, None]
    g = np.repeat(ramp, w, axis=1)
    out = np.empty((h, w, 3), dtype=np.float32)
    for c in range(3):
        out[..., c] = g * np.float32(tint[c])
    return out


DEFAULT_QUAD = np.array([[110.0, 84.0], [246.0, 80.0], [258.0, 176.0], [104.0, 180.0]])  # 透視壓扁的直式牌


@dataclass
class Scene:
    planes: _color.Yuv420
    frame_lin: np.ndarray  # 量化前的線性幀（ground truth）
    H: np.ndarray
    quad: np.ndarray
    tmpl_orig: np.ndarray
    ink_orig: np.ndarray
    paper: np.ndarray
    barcode: np.ndarray
    tmpl_new: np.ndarray
    ink_new: np.ndarray
    card_alpha: np.ndarray  # 幀空間牌的覆蓋率（0..1）
    shade: np.ndarray  # 模板空間光影


def render_scene(
    quad: np.ndarray | None = None,
    *,
    noise_sigma: float = 0.0,
    seed: int = 7,
    shade: np.ndarray | None = None,
    soft_px: float = 1.0,
    frame_wh: tuple[int, int] = (FRAME_W, FRAME_H),
    tmpl_kind: str = "orig",
    ss: int = 4,
    ink_offset_px: tuple[int, int] = (0, 0),
) -> Scene:
    """把模板 × 光影以 H 貼進桌布幀（ss 倍超採樣後 INTER_AREA 縮回），可加高斯雜訊，量化成 yuv420p。

    ink_offset_px=(dx,dy)（模板 px）：「真印刷」相對模板平移——幀用平移後的牌面渲染，但回傳的 tmpl_orig／ink_orig
    仍是未平移的模板（模擬牌組字形與影片印刷沒對齊，A4 鬼影測試用）。紙色處平移不改變任何東西，所以用 np.roll 即可。"""
    quad = DEFAULT_QUAD.copy() if quad is None else np.asarray(quad, dtype=np.float64)
    W, H = frame_wh
    tmpl_orig, ink_orig, paper, barcode = make_template(tmpl_kind, soft_px)
    tmpl_new, ink_new, _, _ = make_template("new" if tmpl_kind == "orig" else "orig", soft_px)
    shade = gradient((TMPL_H, TMPL_W)) if shade is None else shade
    Hm = H_from_quad(quad, TMPL_W, TMPL_H)

    # 背景：桌布 + 輕微 vignette
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    vig = 1.0 - 0.25 * (((xx - W / 2) / W) ** 2 + ((yy - H / 2) / H) ** 2)
    bg = FELT_LIN[None, None, :] * vig[..., None]

    # 牌：模板線性 × 光影 → 幀（ss 網格）→ 縮回
    printed = tmpl_orig if ink_offset_px == (0, 0) else np.roll(tmpl_orig, (int(ink_offset_px[1]), int(ink_offset_px[0])), axis=(0, 1))
    face = _color.rgb8_to_linear(printed) * shade
    face[~paper] = FELT_LIN  # 圓角外＝桌布色（避免邊緣滲色）
    T = np.array([[1, 0, -0.5], [0, 1, -0.5], [0, 0, 1.0]])
    A = np.array([[ss, 0, 0], [0, ss, 0], [0, 0, 1.0]])
    M = T @ (A @ Hm) @ np.linalg.inv(T)
    col = cv2.warpPerspective(face, M, (W * ss, H * ss), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    sil = cv2.warpPerspective(paper.astype(np.float32), M, (W * ss, H * ss), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    col = cv2.resize(col, (W, H), interpolation=cv2.INTER_AREA)
    a = cv2.resize(sil, (W, H), interpolation=cv2.INTER_AREA)
    frame_lin = bg * (1 - a)[..., None] + col * a[..., None]
    if noise_sigma > 0:
        rng = np.random.default_rng(seed)
        frame_lin = frame_lin + rng.standard_normal(frame_lin.shape, dtype=np.float32) * np.float32(noise_sigma)
    frame_lin = np.clip(frame_lin, 0.0, 1.5).astype(np.float32)
    planes = _color.linear_to_yuv420(frame_lin)
    return Scene(planes, frame_lin, Hm, quad, tmpl_orig, ink_orig, paper, barcode, tmpl_new, ink_new, a.astype(np.float32), shade)


def psnr_u8(a: np.ndarray, b: np.ndarray, mask: np.ndarray | None = None) -> float:
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    if mask is not None:
        a, b = a[mask], b[mask]
    mse = float(np.mean((a - b) ** 2))
    return 99.0 if mse <= 1e-12 else 20.0 * np.log10(255.0 / np.sqrt(mse))
