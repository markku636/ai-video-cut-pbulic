"""貼紙與文字：一張預乘 RGBA（sRGB gamma，0..1）擺到物件上。

## 擺放（`placement`）

- 錨點 anchor：物件身上的一點 —— `centroid`（重心）或外接框上的 9 個點（center、top、bottom-left…）。
  預設用**平滑後**的框／重心（`smooth`），貼紙不會跟著遮罩邊緣逐幀抖。
- 樞紐 pivot：貼紙自己身上要對準錨點的那一點（帽子：anchor top、pivot bottom）。
- 偏移 offset：`offsetUnits` bbox＝物件外接框寬／高的倍數（解析度無關，預設）或 px。
- 參考幀：`refFrame` 指定的幀（要可見），否則物件第一個可見幀。尺寸與旋轉都相對它：
  - `followScale`：倍率＝√(這一幀面積 ÷ 參考幀面積)（旋轉不變；外接框寬會隨旋轉變，不能拿來當大小）。
  - `followRotation`：角度差＝方向角（同一段連續可見時用展開過的連續角，跨段才用折回的差）。
    這時整個擺放跟著物件**剛體旋轉**：錨點與偏移都在參考幀算好，再繞重心轉過去 —— 歪頭時帽子還在頭頂上。
    不跟著轉時，錨點就是這一幀（軸對齊）外接框上的點。

## 為什麼在 gamma 空間混

貼紙 PNG 的半透明邊（陰影、反鋸齒）與字型的反鋸齒都是設計者在 sRGB 裡做出來、預期在 sRGB 裡疊的
（每一套剪輯軟體、字幕燒錄 `captions/burn.py` 都這樣）。在線性光裡疊，白字的邊會變粗、陰影變淡。
所以這兩種特效先把工作區轉回 gamma（`_color.oetf`）、預乘 over、再轉回線性；alpha 為 0 的像素直接沿用原值（不經過來回轉換）。
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np

from ..objects.anchors import Anchor, wrap180
from ..objects.track import ObjectFrame
from .params import FxError, StickerFx, TextFx, color_hex

_ANCHOR_UV = {
    "center": (0.5, 0.5), "top": (0.5, 0.0), "bottom": (0.5, 1.0), "left": (0.0, 0.5), "right": (1.0, 0.5),
    "top-left": (0.0, 0.0), "top-right": (1.0, 0.0), "bottom-left": (0.0, 1.0), "bottom-right": (1.0, 1.0),
}


def pivot_uv(name: str) -> tuple[float, float]:
    return _ANCHOR_UV[name]


def anchor_point(a: Anchor, name: str, smooth: bool) -> tuple[float, float] | None:
    if name == "centroid":
        return a.center(smooth)
    box = a.box(smooth)
    if box is None:
        return None
    u, v = _ANCHOR_UV[name]
    return box[0] + u * box[2], box[1] + v * box[3]


@dataclass(frozen=True)
class Placement:
    point: tuple[float, float]  # 樞紐要對準的畫面點（邊界座標）
    scale: float  # 相對參考幀的大小倍率（followScale 關掉時是 1）
    rotation: float  # 度，正＝螢幕上順時針
    ref_box: tuple[float, float, float, float]  # 參考幀的外接框（尺寸換算用）


def _reference(obj: ObjectFrame, fx: Any) -> Anchor:
    assert obj.anchor is not None
    if fx.ref_frame is not None and obj.lookup is not None:
        r = obj.lookup(int(fx.ref_frame))
        if r is not None and r.visible:
            return r
    if obj.reference is not None and obj.reference.visible:
        return obj.reference
    return obj.anchor


def placement(obj: ObjectFrame, fx: StickerFx | TextFx) -> Placement | None:
    a = obj.anchor
    if a is None or not a.visible:
        return None
    ref = _reference(obj, fx)
    sm = bool(fx.smooth)
    area_k = (a.smooth.area if sm and a.smooth is not None else float(a.area)) or 1.0
    area_r = (ref.smooth.area if sm and ref.smooth is not None else float(ref.area)) or 1.0
    s_rel = math.sqrt(max(area_k, 1e-6) / max(area_r, 1e-6)) if fx.follow_scale else 1.0
    ref_box = ref.box(sm) or a.box(sm)
    assert ref_box is not None
    dx, dy = fx.offset
    if fx.offset_units == "bbox":
        dx, dy = dx * ref_box[2], dy * ref_box[3]
    if fx.follow_rotation:
        # 段內連續角度（smooth 開＝平滑後的、關＝未平滑的展開角）才可以直接相減；拿不到就用折回的差（跨段同理）。
        # 以前 smooth:false 時 heading 忽略 continuous、回 (-90, 90] 的原值，跨過 ±90° 那一幀差變成 ~180°，貼紙整個翻過去
        cont = a.run is not None and a.run == ref.run and a.has_continuous_heading(sm) and ref.has_continuous_heading(sm)
        hk = a.heading(sm, continuous=cont) or 0.0
        hr = ref.heading(sm, continuous=cont) or 0.0
        dtheta = float(hk - hr) if cont else wrap180(hk - hr)
        cen_k, cen_r = a.center(sm), ref.center(sm)
        p_ref = anchor_point(ref, fx.anchor, sm)
        if cen_k is None or cen_r is None or p_ref is None:
            return None
        vx, vy = (p_ref[0] - cen_r[0] + dx) * s_rel, (p_ref[1] - cen_r[1] + dy) * s_rel
        t = math.radians(dtheta)
        c, s = math.cos(t), math.sin(t)
        point = (cen_k[0] + c * vx - s * vy, cen_k[1] + s * vx + c * vy)
        rot = dtheta + float(fx.rotation)
    else:
        p = anchor_point(a, fx.anchor, sm)
        if p is None:
            return None
        point = (p[0] + dx * s_rel, p[1] + dy * s_rel)
        rot = float(fx.rotation)
    return Placement(point, s_rel, rot, ref_box)


def sticker_width_px(fx: StickerFx, pl: Placement, frame_w: int) -> float:
    if fx.width_units == "bbox":
        base = fx.width * pl.ref_box[2]
    elif fx.width_units == "frame":
        base = fx.width * frame_w
    else:
        base = fx.width
    return max(1.0, base * pl.scale)


def text_px(fx: TextFx, pl: Placement, frame_h: int) -> float:
    if fx.size_units == "frame":
        base = fx.size * frame_h
    elif fx.size_units == "bbox":
        base = fx.size * pl.ref_box[3]
    else:
        base = fx.size
    return max(4.0, base * pl.scale)


# ---------------------------------------------------------------------------
# 圖源
# ---------------------------------------------------------------------------
@lru_cache(maxsize=16)
def _sticker_cached(path: str, mtime_ns: int, size: int) -> np.ndarray:
    import cv2

    from ..imageio import imread_unicode

    img = imread_unicode(path, cv2.IMREAD_UNCHANGED)
    if img.dtype == np.uint16:
        img = (img / 257.0).astype(np.uint8)
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    rgba = cv2.cvtColor(img, cv2.COLOR_BGRA2RGBA).astype(np.float32) / 255.0
    rgba[..., :3] *= rgba[..., 3:4]  # 預乘：縮放／旋轉時邊緣才不會帶出黑邊或白邊
    rgba.setflags(write=False)
    return rgba


def load_sticker(path: str) -> np.ndarray:
    """貼紙圖 → 預乘 RGBA float32（sRGB gamma 0..1）。快取鍵含 mtime：圖換了就重讀。"""
    p = Path(os.path.expanduser(path))
    try:
        st = p.stat()
    except OSError as e:
        raise FxError(f"找不到貼紙圖 {p}") from e
    try:
        return _sticker_cached(str(p), int(st.st_mtime_ns), int(st.st_size))
    except (OSError, ValueError) as e:
        raise FxError(f"讀不了貼紙圖 {p}：{e}") from e


@lru_cache(maxsize=64)
def _text_cached(fx: TextFx, font_px_q: float) -> tuple[np.ndarray, tuple[str, ...]]:
    from ..captions.fonts import missing_cjk_warning, resolve_font
    from ..captions.raster import Rasterizer, over, rounded_rect
    from ..captions.text import has_cjk

    fams = list(fx.font_families) or ["Microsoft JhengHei", "Noto Sans CJK TC", "PingFang TC", "Segoe UI", "Arial"]
    style: dict[str, Any] = {
        "font": {"families": fams, "file": fx.font_file, "weight": fx.font_weight},
        "stroke": {"widthPct": fx.stroke_width * 100.0},
        "colors": {"stroke": color_hex(fx.stroke_color)},
        "shadow": None,
    }
    needs_cjk = has_cjk(fx.text)
    lang = fx.language or ("zh" if needs_cjk else "en")
    spec = resolve_font(style, lang)
    warn = missing_cjk_warning(spec, needs_cjk)
    r = Rasterizer(spec, font_px_q, style, supersample=2)
    asc, desc = r.metrics()
    line_h = (asc + desc) * 1.15
    fill = color_hex(fx.color) or "#FFFFFF"
    placed: list[tuple[np.ndarray, float, float]] = []  # (sprite rgba, 左上 x, 左上 y)（畫布座標，未加 padding）
    lines = fx.text.split("\n")
    widths = [r.measure(t) for t in lines]
    maxw = max(widths) if widths else 0.0
    for i, (t, lw) in enumerate(zip(lines, widths)):
        if not t:
            continue
        spr = r.sprite(t, fill, 1.0, "all")
        pen_x = (maxw - lw) / 2.0
        base_y = asc + i * line_h
        placed.append((spr.rgba, pen_x + spr.ox, base_y + spr.oy))
    if not placed:
        return np.zeros((1, 1, 4), np.float32), ()
    x0 = min(x for _, x, _ in placed)
    y0 = min(y for _, _, y in placed)
    x1 = max(x + s.shape[1] for s, x, _ in placed)
    y1 = max(y + s.shape[0] for s, _, y in placed)
    pad = fx.padding * font_px_q if fx.background is not None else 1.0
    W = int(math.ceil(x1 - x0 + 2 * pad))
    H = int(math.ceil(y1 - y0 + 2 * pad))
    canvas = np.zeros((H, W, 4), np.float32)
    if fx.background is not None:
        canvas = rounded_rect(W, H, fx.radius * font_px_q, fx.background).astype(np.float32)
    for s, x, y in placed:
        over(canvas, s, int(round(x - x0 + pad)), int(round(y - y0 + pad)))
    canvas.setflags(write=False)
    warns = (warn["message"],) if warn else ()
    return canvas, warns


def render_text(fx: TextFx, font_px: float) -> tuple[np.ndarray, tuple[str, ...]]:
    """文字標籤 → 預乘 RGBA（sRGB gamma）＋警告（缺中文字型之類）。字級量化到 0.5 px 才能快取。"""
    return _text_cached(fx, max(4.0, round(float(font_px) * 2.0) / 2.0))


# ---------------------------------------------------------------------------
# 變形
# ---------------------------------------------------------------------------
def warp_rgba(rgba: np.ndarray, point: tuple[float, float], pivot: tuple[float, float], width_px: float, rotation: float,
              frame_w: int, frame_h: int) -> tuple[int, int, np.ndarray] | None:
    """預乘 RGBA → 畫面上的一塊（視窗原點, 預乘 RGBA）。樞紐 pivot（0..1）對準 point（邊界座標），寬 width_px，旋轉 rotation 度。

    cv2.warpAffine 的座標是像素中心（整數＝中心），這裡的座標是像素邊界，換算差 0.5（見式子）。
    縮小超過一半時先 INTER_AREA 縮一次（雙線性直接縮會鋸齒、閃爍）。
    視窗要包住雙線性的**整個**支撐：零邊界的 INTER_LINEAR 會把 alpha 往來源外暈開半個來源像素（放大 z 倍＝0.5·z 個畫面像素），
    所以四角各往外推半個來源像素再取整（以前只多 1 px，放大 3 倍以上的貼紙邊緣被硬切成一道台階）。"""
    import cv2

    sh, sw = rgba.shape[:2]
    if sw < 1 or sh < 1 or width_px <= 0:
        return None
    z = float(width_px) / sw
    src = rgba
    if z < 0.5:
        nw, nh = max(1, int(round(sw * z * 2))), max(1, int(round(sh * z * 2)))
        src = cv2.resize(np.ascontiguousarray(rgba), (nw, nh), interpolation=cv2.INTER_AREA)
        z = float(width_px) / nw
        sh, sw = src.shape[:2]
    t = math.radians(rotation)
    c, s = math.cos(t), math.sin(t)
    A = np.array([[c * z, -s * z], [s * z, c * z]], np.float64)
    pv = np.array([pivot[0] * sw, pivot[1] * sh], np.float64)
    P = np.array(point, np.float64)
    corners = np.array([[-0.5, -0.5], [sw + 0.5, -0.5], [sw + 0.5, sh + 0.5], [-0.5, sh + 0.5]], np.float64)
    fc = (corners - pv) @ A.T + P  # 邊界座標
    x0 = max(0, int(math.floor(fc[:, 0].min())) - 1)
    y0 = max(0, int(math.floor(fc[:, 1].min())) - 1)
    x1 = min(int(frame_w), int(math.ceil(fc[:, 0].max())) + 1)
    y1 = min(int(frame_h), int(math.ceil(fc[:, 1].max())) + 1)
    if x1 <= x0 or y1 <= y0:
        return None
    # 邊界座標 X = P + A(u − pv)；中心座標 Xc = X − 0.5、uc = u − 0.5 → Xc = A·uc + [P + A(0.5 − pv) − 0.5]
    tvec = P + A @ (np.array([0.5, 0.5]) - pv) - 0.5 - np.array([x0, y0], np.float64)
    M = np.hstack([A, tvec[:, None]]).astype(np.float64)
    out = cv2.warpAffine(np.ascontiguousarray(src, np.float32), M, (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR,
                         borderMode=cv2.BORDER_CONSTANT, borderValue=(0.0, 0.0, 0.0, 0.0))
    out[out[..., 3] <= 0.0] = 0.0
    return x0, y0, out


def over_gamma(base_lin: np.ndarray, premult: np.ndarray, opacity: float = 1.0) -> tuple[np.ndarray, np.ndarray]:
    """線性光底圖上用 gamma 空間的預乘 over 疊一張 RGBA；回 (新的線性光, alpha)。alpha=0 的像素原值照抄（不經過來回轉換）。"""
    from ..comp import _color

    a = premult[..., 3] * np.float32(opacity)
    sel = a > 0
    out = base_lin.copy()
    if not sel.any():
        return out, a
    g = _color.oetf(base_lin[sel])
    rgb = premult[..., :3][sel] * np.float32(opacity)
    mixed = rgb + g * (1.0 - a[sel])[:, None]
    out[sel] = _color.oetf_inverse(np.clip(mixed, 0.0, 1.0))
    return out, a
