"""特效的純數學（只吃 numpy 陣列、不讀檔、不碰 ctx）。輸入輸出都是**線性光** RGB float32（`comp/_color` 的工作空間）。

- 馬賽克在線性光裡平均（等於攝影機真的用比較少的像素拍）：在 gamma 值上平均會讓亮暗交界的格子偏暗。
- 調色的亮度用 BT.709 係數（`comp/_color.KR/KG/KB`）在線性光算，跟 write_back 回寫用的是同一組係數。
- 貼紙／文字不在這裡（`fx/overlay.py`）：它們是在 gamma 空間混的（理由見那裡）。
"""
from __future__ import annotations

import math

import numpy as np

from ..comp import _color
from .params import ColorFx, ReplaceColor

_EPS = np.float32(1e-6)
LUMA = np.array([_color.KR, _color.KG, _color.KB], np.float32)


def srgb_to_linear(rgb: tuple[float, ...] | np.ndarray) -> np.ndarray:
    """0..1 的 sRGB（視為 BT.709 OETF 編碼，與 `_color.rgb8_to_linear` 同一條曲線）→ 線性。"""
    return _color.oetf_inverse(np.asarray(rgb, np.float32)[..., :3])


def luma(lin: np.ndarray) -> np.ndarray:
    """線性光亮度（..., 1）。"""
    return (lin[..., :3] @ LUMA)[..., None]


def hue_matrix(degrees: float) -> np.ndarray:
    """保持亮度的色相旋轉矩陣（SVG feColorMatrix hueRotate；每列和為 1 → 灰色不變色）。"""
    t = math.radians(float(degrees))
    c, s = math.cos(t), math.sin(t)
    return np.array([
        [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928],
        [0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283],
        [0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072],
    ], np.float32)


def _smoothstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    if e1 <= e0:
        return (x >= e0).astype(np.float32)
    t = np.clip((x - np.float32(e0)) / np.float32(e1 - e0), 0.0, 1.0)
    return (t * t * (3.0 - 2.0 * t)).astype(np.float32)


def replace_color(lin: np.ndarray, rep: ReplaceColor) -> np.ndarray:
    """色度接近 source 的像素換成 target 的色度、保留明暗比例（見 params.ReplaceColor）。

    比對用的是線性光的色度座標 c = rgb / (r+g+b)：跟亮度無關，陰影裡與亮處的同一塊紅色會一起被換。
    很暗的像素（r+g+b < 0.02）色度是雜訊，權重漸淡到 0，免得黑色背景被當成任何顏色。"""
    src = srgb_to_linear(rep.source)
    dst = srgb_to_linear(rep.target)
    s = lin.sum(axis=-1, keepdims=True)
    c = lin / np.maximum(s, _EPS)
    cs = src / max(float(src.sum()), 1e-6)
    d = np.linalg.norm(c - cs, axis=-1)
    w = 1.0 - _smoothstep(rep.tolerance, rep.tolerance + rep.softness, d)
    w = w * np.clip((s[..., 0] - 0.003) / 0.017, 0.0, 1.0)
    y = luma(lin)
    y_src = max(float(src @ LUMA), 1e-6)
    new = dst * (y / np.float32(y_src))
    w3 = w[..., None].astype(np.float32)
    return (lin * (1.0 - w3) + new * w3).astype(np.float32)


def color_transform(lin: np.ndarray, fx: ColorFx) -> np.ndarray:
    """ColorFx 的整條調色（順序見 params.ColorFx）；結果夾在 [0, 1]（線性光）。"""
    x = lin.astype(np.float32, copy=True)
    if fx.replace is not None:
        x = replace_color(x, fx.replace)
    if fx.hue % 360.0 != 0.0:
        x = x @ hue_matrix(fx.hue).T
    sat = fx.saturation * (1.0 - fx.desaturate)
    if sat != 1.0:
        y = luma(x)
        x = y + np.float32(sat) * (x - y)
    if fx.tint is not None and fx.tint_amount > 0.0:
        t = srgb_to_linear(fx.tint)
        ty = max(float(t @ LUMA), 1e-6)
        y = luma(x)
        col = y * (t / np.float32(ty))
        a = np.float32(fx.tint_amount)
        x = x * (1.0 - a) + col * a
    if fx.brightness != 1.0:
        x = x * np.float32(fx.brightness)
    return np.clip(x, 0.0, 1.0).astype(np.float32)


def block_starts(origin_win: int, size: int, grid_origin: int, block: int) -> np.ndarray:
    """視窗 [origin_win, origin_win+size) 裡格子的起點（視窗座標，含 0）。格線在 grid_origin + n×block。"""
    first = (grid_origin - origin_win) % block
    starts = {0}
    starts.update(range(first, size, block))
    return np.array(sorted(s for s in starts if 0 <= s < size), np.intp)


def pixelate(lin: np.ndarray, win_x0: int, win_y0: int, block: int, grid_x0: int = 0, grid_y0: int = 0) -> np.ndarray:
    """把視窗切成對齊 (grid_x0, grid_y0) 的 block×block 格子，每格換成格內平均（邊緣的不完整格子照樣平均）。"""
    h, w = lin.shape[:2]
    b = max(1, int(block))
    rs = block_starts(win_y0, h, grid_y0, b)
    cs = block_starts(win_x0, w, grid_x0, b)
    sums = np.add.reduceat(np.add.reduceat(lin.astype(np.float64), rs, axis=0), cs, axis=1)
    rh = np.diff(np.append(rs, h))
    cw = np.diff(np.append(cs, w))
    means = sums / (rh[:, None] * cw[None, :])[..., None]
    return np.repeat(np.repeat(means, rh, axis=0), cw, axis=1).astype(np.float32)


def glow_alpha(mask: np.ndarray, radius: float, spread: float, intensity: float) -> np.ndarray:
    """外光暈的 alpha：遮罩長大 spread → 高斯（sigma = radius/2）→ × intensity，**物件本身是 0**（不動物件像素）。"""
    import cv2

    m = mask.astype(np.uint8)
    sp = int(round(spread))
    if sp > 0:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * sp + 1, 2 * sp + 1))
        m = cv2.dilate(m, k)
    r = max(1.0, float(radius))
    ks = 2 * int(math.ceil(r)) + 1
    # BORDER_REPLICATE：視窗被畫面邊切掉時，預設的 REFLECT_101 會把物件鏡射成畫面外的幻影，貼邊的光暈亮一倍
    g = cv2.GaussianBlur(m.astype(np.float32), (ks, ks), r / 2.0, borderType=cv2.BORDER_REPLICATE)
    a = np.clip(g * np.float32(intensity), 0.0, 1.0) * (~mask.astype(bool)).astype(np.float32)
    a[a < 1.0 / 512.0] = 0.0
    return a.astype(np.float32)


def screen(base: np.ndarray, color_lin: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """線性光 screen：`1 − (1 − 底)(1 − 光×alpha)`（亮處不會爆白）。alpha (h, w)。"""
    light = np.asarray(color_lin, np.float32)[None, None, :] * alpha[..., None]
    return (1.0 - (1.0 - base) * (1.0 - light)).astype(np.float32)


def blur_radius(fx_radius: float | str, strength: float, min_radius: float, box: tuple[float, float, float, float]) -> int:
    if fx_radius != "auto":
        return max(1, int(round(float(fx_radius))))
    return max(int(round(min_radius)), int(round(strength * min(box[2], box[3]))))


def mosaic_block(block: float | str, blocks: float, min_block: int, box: tuple[float, float, float, float]) -> int:
    if block != "auto":
        return max(2, int(round(float(block))))
    return max(int(min_block), int(round(min(box[2], box[3]) / float(blocks))))


#: 馬賽克格子的遲滯：理想格子大小（或物件框原點）離目前用的值超過這麼多 px 才換。> 0.5 才有遲滯帶。
MOSAIC_HYSTERESIS = 0.75


def mosaic_series(
    boxes: list[tuple[int, tuple[float, float, float, float]]], block: float | str, blocks: float, min_block: int, align: str,
) -> dict[int, tuple[int, int, int]]:
    """一段連續可見的 [(k, 框)…]（k 遞增）→ 每幀 (格子大小, 格線原點 x, y)。

    為什麼要整段一起算：`block auto` 逐幀算 round(短邊 ÷ blocks)，SAM 遮罩 ±1 px 的抖動讓短邊卡在四捨五入的邊界時，
    格子在 7、8 px 之間來回跳（實測靜止的 75 px 臉 60 幀跳 13 次）→ 每跳一次整片馬賽克重新切格、畫面在「沸騰」。
    這裡從段頭往後掃、加遲滯（理想值離目前值超過 MOSAIC_HYSTERESIS 才換）；`align object` 的格線原點同樣處理。
    結果只跟整段的錨點有關，所以單幀預覽（fx-preview）與整段渲染一定一樣。"""
    out: dict[int, tuple[int, int, int]] = {}
    cur_b: int | None = None
    gx: int | None = None
    gy: int | None = None
    for k, box in boxes:
        if block == "auto":
            ideal = min(box[2], box[3]) / float(blocks)
            if cur_b is None or abs(ideal - cur_b) > MOSAIC_HYSTERESIS:
                cur_b = max(int(min_block), int(round(ideal)))
            b = cur_b
        else:
            b = mosaic_block(block, blocks, min_block, box)
        if align == "object":
            # 原點只在模 b 的意義下有差：遲滯放到 b/4（8 px 的格子＝2 px），遮罩邊 ±1 px 的抖動不會讓格線跟著抖；
            # 物件真的在移動時，格線以 ≤ b/4 的落後跟上
            hyst = max(MOSAIC_HYSTERESIS, b / 4.0)
            if gx is None or abs(box[0] - gx) > hyst:
                gx = int(round(box[0]))
            if gy is None or abs(box[1] - gy) > hyst:
                gy = int(round(box[1]))
            out[int(k)] = (b, gx, gy)
        else:
            out[int(k)] = (b, 0, 0)
    return out
