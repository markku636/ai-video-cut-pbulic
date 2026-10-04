"""文字點陣化（研究規格 §5.3 H）：一個詞 × 顏色狀態 × 縮放級距 → 預乘 RGBA 精靈（float32），LRU 快取。

- Pillow BASIC 版面（沒有 raqm 複雜排版：中日韓與拉丁沒問題，阿拉伯文／印度系文字不支援）。
- 超取樣用**整數倍**（預設 2×）再 INTER_AREA 縮回：整數倍時筆位（pen）在 1× 永遠落在整數像素，精靈位移可以精確寫成整數，
  燒錄、預覽 PNG、圖集三處拿到的是同一個像素（決定性測試靠這個）。
- 圖層由下而上：陰影（描邊輪廓位移 + 高斯模糊）→ 描邊 → 填色，全部在預乘空間合成；縮小預乘值才不會在字緣出現黑邊。
- 精靈分兩層：`under`（陰影＋描邊，跟填色無關）與 `fill`（只有填色），幾何框完全相同。燒錄先貼整則的 under、再貼 fill：
  粗描邊（跳字 12%、彈跳 14%）時相鄰詞的描邊才不會蓋到前一個詞的字面。`all` = 兩層合在一起（單詞預覽用）。
"""
from __future__ import annotations

import math
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any

import numpy as np

from .anim import scale_bucket
from .fonts import FontSpec, load_font

DEFAULT_SUPERSAMPLE = 2


def parse_color(hex_color: str | None, default: tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0)) -> tuple[float, float, float, float]:
    if not isinstance(hex_color, str) or not hex_color.startswith("#") or len(hex_color) not in (7, 9):
        return default
    try:
        r, g, b = (int(hex_color[i : i + 2], 16) / 255.0 for i in (1, 3, 5))
        a = int(hex_color[7:9], 16) / 255.0 if len(hex_color) == 9 else 1.0
    except ValueError:
        return default
    return (r, g, b, a)


@dataclass
class Sprite:
    rgba: np.ndarray  # (h, w, 4) float32，預乘 alpha，0..1
    ox: int  # 精靈左上角相對於筆位（左、基線）的位移，1× 像素
    oy: int
    advance: float  # 筆位前進量（1× 像素，含縮放）


def over(dst: np.ndarray, src: np.ndarray, x: int, y: int) -> None:
    """預乘 over：dst[y:, x:] = src + dst·(1 − src.a)，自動裁到 dst 範圍內。"""
    h, w = src.shape[:2]
    H, W = dst.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(W, x + w), min(H, y + h)
    if x1 <= x0 or y1 <= y0:
        return
    s = src[y0 - y : y1 - y, x0 - x : x1 - x]
    d = dst[y0:y1, x0:x1]
    d *= 1.0 - s[..., 3:4]
    d += s


class Rasterizer:
    def __init__(self, spec: FontSpec, font_px: float, style: dict[str, Any], supersample: int = DEFAULT_SUPERSAMPLE, cache_size: int = 512) -> None:
        self.spec = spec
        self.font_px = float(font_px)
        self.ss = max(1, int(supersample))
        stroke = style.get("stroke") or {}
        self.stroke_pct = float(stroke.get("widthPct") or 0.0)
        self.stroke_rgba = parse_color((style.get("colors") or {}).get("stroke"), (0.0, 0.0, 0.0, 1.0))
        sh = style.get("shadow")
        self.shadow = None
        if isinstance(sh, dict):
            self.shadow = (parse_color(sh.get("color"), (0.0, 0.0, 0.0, 0.63)), float(sh.get("dxPct") or 0.0), float(sh.get("dyPct") or 0.0), float(sh.get("blurPct") or 0.0))
        font = style.get("font") or {}
        self.letter_spacing_em = float(font.get("letterSpacingEm") or 0.0)
        self._cache: OrderedDict[tuple, Sprite] = OrderedDict()
        self._cache_size = cache_size
        self.hits = 0
        self.misses = 0

    # ---- 量測（1×，未縮放）----
    def font(self, scale: float = 1.0) -> Any:
        return load_font(self.spec, self.font_px * scale)

    def measure(self, text: str, scale: float = 1.0) -> float:
        f = self.font(scale)
        w = float(f.getlength(text))
        if self.letter_spacing_em and len(text) > 1:
            w += self.letter_spacing_em * self.font_px * scale * (len(text) - 1)
        return w

    def metrics(self, scale: float = 1.0) -> tuple[float, float]:
        asc, desc = self.font(scale).getmetrics()
        return float(asc), float(desc)

    def stroke_px(self, scale: float = 1.0) -> float:
        return self.stroke_pct / 100.0 * self.font_px * scale

    # ---- 精靈 ----
    def sprite(self, text: str, fill: str, scale: float = 1.0, layer: str = "all") -> Sprite:
        sc = scale_bucket(scale)
        key = (text, "" if layer == "under" else fill, sc, layer)
        hit = self._cache.get(key)
        if hit is not None:
            self._cache.move_to_end(key)
            self.hits += 1
            return hit
        self.misses += 1
        spr = self._render(text, parse_color(fill), sc, layer)
        self._cache[key] = spr
        if len(self._cache) > self._cache_size:
            self._cache.popitem(last=False)
        return spr

    def _draw_text(self, draw: Any, pen: tuple[float, float], text: str, font: Any, **kw: Any) -> None:
        if not self.letter_spacing_em or len(text) < 2:
            draw.text(pen, text, font=font, anchor="ls", **kw)
            return
        x, y = pen
        extra = self.letter_spacing_em * self.font_px * self._cur_scale * self.ss
        for ch in text:
            draw.text((x, y), ch, font=font, anchor="ls", **kw)
            x += float(font.getlength(ch)) + extra

    def _render(self, text: str, fill: tuple[float, float, float, float], scale: float, layer: str = "all") -> Sprite:
        import cv2
        from PIL import Image, ImageDraw, ImageFilter

        ss = self.ss
        self._cur_scale = scale
        font = load_font(self.spec, self.font_px * scale * ss)
        stroke = int(round(self.stroke_pct / 100.0 * self.font_px * scale * ss))
        l, t, r, b = font.getbbox(text or " ", anchor="ls", stroke_width=stroke)
        adv_ss = float(font.getlength(text))
        if self.letter_spacing_em and len(text) > 1:
            adv_ss += self.letter_spacing_em * self.font_px * scale * ss * (len(text) - 1)
            r = max(r, int(math.ceil(adv_ss)) + stroke)
        dx = dy = blur = 0.0
        if self.shadow is not None:
            _c, dxp, dyp, blp = self.shadow
            dx, dy, blur = (v / 100.0 * self.font_px * scale * ss for v in (dxp, dyp, blp))
        margin = int(math.ceil(3 * blur + max(abs(dx), abs(dy)))) + 2
        # 1× 的整數框（筆位在 1× 的 (0,0)）；乘回 ss 就是超取樣畫布，縮小時每個 ss×ss 區塊恰好對到一個像素
        l1 = int(math.floor((l - margin) / ss))
        t1 = int(math.floor((t - margin) / ss))
        r1 = int(math.ceil((r + margin) / ss))
        b1 = int(math.ceil((b + margin) / ss))
        w1, h1 = max(1, r1 - l1), max(1, b1 - t1)
        size = (w1 * ss, h1 * ss)
        pen = (float(-l1 * ss), float(-t1 * ss))

        def mask(offset: tuple[float, float] = (0.0, 0.0), sw: int = 0) -> np.ndarray:
            im = Image.new("L", size, 0)
            d = ImageDraw.Draw(im)
            kw: dict[str, Any] = {"fill": 255}
            if sw > 0:
                kw.update(stroke_width=sw, stroke_fill=255)
            self._draw_text(d, (pen[0] + offset[0], pen[1] + offset[1]), text, font, **kw)
            return np.asarray(im, dtype=np.float32) / 255.0

        fr, fg, fb, fa = fill
        if layer == "under":
            acc_a = np.zeros((size[1], size[0]), np.float32)
        else:
            acc_a = mask() * fa
        acc_c = np.stack([acc_a * fr, acc_a * fg, acc_a * fb], axis=-1)
        if layer == "fill":
            stroke_on, shadow_on = False, False
        else:
            stroke_on, shadow_on = stroke > 0, self.shadow is not None and self.shadow[0][3] > 0
        if stroke_on:
            sr, sg, sb, sa = self.stroke_rgba
            a_st = mask(sw=stroke) * sa
            k = a_st * (1.0 - acc_a)
            acc_c += np.stack([k * sr, k * sg, k * sb], axis=-1)
            acc_a += k
        if shadow_on:
            assert self.shadow is not None
            (hr, hg, hb, ha), *_ = self.shadow
            im = Image.new("L", size, 0)
            d = ImageDraw.Draw(im)
            kw = {"fill": 255}
            if stroke > 0:
                kw.update(stroke_width=stroke, stroke_fill=255)
            self._draw_text(d, (pen[0] + dx, pen[1] + dy), text, font, **kw)
            if blur > 0.25:
                im = im.filter(ImageFilter.GaussianBlur(radius=blur))
            a_sh = np.asarray(im, dtype=np.float32) / 255.0 * ha
            k = a_sh * (1.0 - acc_a)
            acc_c += np.stack([k * hr, k * hg, k * hb], axis=-1)
            acc_a += k
        rgba = np.concatenate([acc_c, acc_a[..., None]], axis=-1).astype(np.float32)
        if ss > 1:
            rgba = cv2.resize(rgba, (w1, h1), interpolation=cv2.INTER_AREA)
        return Sprite(np.ascontiguousarray(rgba, dtype=np.float32), l1, t1, adv_ss / ss)


def rounded_rect(w: int, h: int, radius: float, rgba: tuple[float, float, float, float], ss: int = 4) -> np.ndarray:
    """圓角矩形的預乘 RGBA 貼片（4× 超取樣反鋸齒）。"""
    import cv2
    from PIL import Image, ImageDraw

    w, h = max(1, int(w)), max(1, int(h))
    im = Image.new("L", (w * ss, h * ss), 0)
    ImageDraw.Draw(im).rounded_rectangle((0, 0, w * ss - 1, h * ss - 1), radius=max(0.0, radius * ss), fill=255)
    a = np.asarray(im, dtype=np.float32) / 255.0
    if ss > 1:
        a = cv2.resize(a, (w, h), interpolation=cv2.INTER_AREA)
    a = a * rgba[3]
    return np.stack([a * rgba[0], a * rgba[1], a * rgba[2], a], axis=-1).astype(np.float32)
