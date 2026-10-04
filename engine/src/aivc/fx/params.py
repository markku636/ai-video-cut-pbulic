"""物件特效參數：不可變 dataclass ＋ `from_json` 驗證（風格比照 `comp/params.py`，但這是 fx 自己的模組）。

- 鍵名吃 camelCase（JSON／App／AI 寫的特效檔）與 snake_case（Python）；未知鍵擲 `FxError`，
  錯誤訊息帶位置（`stacks[0].effects[1].opacity`），寫錯一個字不會被默默忽略。
- 顏色：`"#RRGGBB"`、`"#RRGGBBAA"`、`[r, g, b(, a)]`（0–255）或 `"r,g,b"`；內部存 sRGB 0..1 的 (r, g, b, a)。
- 遮罩類特效（mosaic／blur／color）共用 `Footprint`（作用範圍）：`shape` mask｜box｜ellipse、`expand`（px，負＝內縮）、
  `feather`（px）。也可以直接把這三個鍵寫在特效本身（`{"type": "mosaic", "shape": "ellipse", "expand": 8}`）。
- 長度單位：沒有註明的都是**幀像素**；`auto` 的值依物件外接框或畫面寬度換算（見各欄位說明），
  讓同一份特效檔在 720p 與 4K 上看起來一樣。

特效檔（`aivc fx --effects stack.json`）三種寫法都吃，`load_stack` 正規化成 `list[ObjectStack]`：

    {"stacks": [{"object": 1, "effects": [...]}, {"masks": "D:/x/obj2/masks.aivm", "effects": [...]}, {"object": "*", "effects": [...]}]}
    {"1": [...], "2": [...], "*": [...]}          ← 物件編號（--masks 的順序，1 起）或 "*"＝每個物件
    [ {...}, {...} ]                               ← 一串特效套到每個物件
"""
from __future__ import annotations

import json
import math
import os
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, ClassVar, Union

RGBA = tuple[float, float, float, float]

SHAPES = ("mask", "box", "ellipse")
ANCHORS = ("centroid", "center", "top", "bottom", "left", "right", "top-left", "top-right", "bottom-left", "bottom-right")
PIVOTS = tuple(a for a in ANCHORS if a != "centroid")
WIDTH_UNITS = ("bbox", "px", "frame")
OFFSET_UNITS = ("bbox", "px")
SIZE_UNITS = ("frame", "px", "bbox")


class FxError(ValueError):
    """特效參數不合法（ops 層轉成 OpError(Invalid)）。"""


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
def _snake(key: str) -> str:
    k = str(key).replace("-", "_")
    return re.sub(r"(?<!^)(?=[A-Z])", "_", k).lower()


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(r[:1].upper() + r[1:] for r in rest)


def _norm_keys(d: Mapping[str, Any], where: str) -> dict[str, Any]:
    if not isinstance(d, Mapping):
        raise FxError(f"{where} 要是物件（{{...}}），拿到 {type(d).__name__}")
    return {_snake(k): v for k, v in d.items()}


def _check_keys(d: Mapping[str, Any], allowed: set[str], where: str) -> None:
    extra = sorted(set(d) - allowed)
    if extra:
        raise FxError(f"{where} 沒有欄位 {', '.join(_camel(e) for e in extra)}（可用：{', '.join(sorted(_camel(a) for a in allowed))}）")


def _num(d: Mapping[str, Any], key: str, default: float, lo: float, hi: float, where: str) -> float:
    v = d.get(key, default)
    if v is None:
        v = default
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
        raise FxError(f"{where}.{_camel(key)} 要是有限數值，拿到 {v!r}")
    if not (lo <= float(v) <= hi):
        raise FxError(f"{where}.{_camel(key)}={v!r} 超出範圍 [{lo:g}, {hi:g}]")
    return float(v)


def _int(d: Mapping[str, Any], key: str, default: int | None, lo: int, hi: int, where: str) -> int | None:
    v = d.get(key, default)
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)) or float(v) != int(v):
        raise FxError(f"{where}.{_camel(key)} 要是整數，拿到 {v!r}")
    if not (lo <= int(v) <= hi):
        raise FxError(f"{where}.{_camel(key)}={v!r} 超出範圍 [{lo}, {hi}]")
    return int(v)


def _auto_num(d: Mapping[str, Any], key: str, lo: float, hi: float, where: str) -> float | str:
    v = d.get(key, "auto")
    if v is None or (isinstance(v, str) and v.strip().lower() == "auto"):
        return "auto"
    return _num({key: v}, key, 0.0, lo, hi, where)


def _bool(d: Mapping[str, Any], key: str, default: bool, where: str) -> bool:
    v = d.get(key, default)
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    if isinstance(v, str) and v.lower() in ("true", "false", "on", "off", "1", "0"):
        return v.lower() in ("true", "on", "1")
    if isinstance(v, (int, float)) and v in (0, 1):
        return bool(v)
    raise FxError(f"{where}.{_camel(key)} 要是 true/false，拿到 {v!r}")


def _enum(d: Mapping[str, Any], key: str, default: str, choices: Sequence[str], where: str) -> str:
    v = d.get(key, default)
    if v is None:
        v = default
    s = str(v).strip().lower()
    if s not in choices:
        raise FxError(f"{where}.{_camel(key)}={v!r} 不合法（可用：{'｜'.join(choices)}）")
    return s


def _str(d: Mapping[str, Any], key: str, default: str | None, where: str, *, required: bool = False) -> str | None:
    v = d.get(key, default)
    if v is None:
        if required:
            raise FxError(f"{where}.{_camel(key)} 必填")
        return None
    if not isinstance(v, str):
        raise FxError(f"{where}.{_camel(key)} 要是字串，拿到 {v!r}")
    if required and not v.strip():
        raise FxError(f"{where}.{_camel(key)} 不能是空字串")
    return v


def _pair(d: Mapping[str, Any], key: str, default: tuple[float, float], lo: float, hi: float, where: str) -> tuple[float, float]:
    v = d.get(key, default)
    if v is None:
        return default
    if isinstance(v, str):
        v = [p for p in v.replace("，", ",").split(",")]
    try:
        a, b = (float(x) for x in v)
    except (TypeError, ValueError) as e:
        raise FxError(f"{where}.{_camel(key)} 要是 [dx, dy]，拿到 {v!r}") from e
    for x in (a, b):
        if not math.isfinite(x) or not (lo <= x <= hi):
            raise FxError(f"{where}.{_camel(key)}={v!r} 超出範圍 [{lo:g}, {hi:g}]")
    return (a, b)


def parse_color(v: Any, where: str = "color") -> RGBA:
    """顏色 → sRGB 0..1 的 (r, g, b, a)。"""
    if isinstance(v, str):
        s = v.strip()
        if s.startswith("#"):
            h = s[1:]
            if len(h) in (6, 8) and re.fullmatch(r"[0-9a-fA-F]+", h):
                vals = [int(h[i : i + 2], 16) / 255.0 for i in range(0, len(h), 2)]
                return (vals[0], vals[1], vals[2], vals[3] if len(vals) == 4 else 1.0)
            raise FxError(f"{where} 要是 #RRGGBB 或 #RRGGBBAA，拿到 {v!r}")
        parts = s.replace("，", ",").split(",")
        if len(parts) in (3, 4):
            v = parts
        else:
            raise FxError(f"{where} 看不懂：{v!r}（用 #RRGGBB 或 r,g,b）")
    if isinstance(v, (list, tuple)) and len(v) in (3, 4):
        try:
            vals = [float(x) for x in v]
        except (TypeError, ValueError) as e:
            raise FxError(f"{where} 的分量要是數字：{v!r}") from e
        if any(not math.isfinite(x) or not (0 <= x <= 255) for x in vals):
            raise FxError(f"{where} 的分量要在 0–255：{v!r}")
        return (vals[0] / 255.0, vals[1] / 255.0, vals[2] / 255.0, vals[3] / 255.0 if len(vals) == 4 else 1.0)
    raise FxError(f"{where} 看不懂：{v!r}（用 #RRGGBB、#RRGGBBAA 或 [r,g,b]）")


def color_hex(c: RGBA | None) -> str | None:
    if c is None:
        return None
    vals = [int(round(max(0.0, min(1.0, x)) * 255)) for x in c]
    return "#" + "".join(f"{x:02X}" for x in (vals if vals[3] != 255 else vals[:3]))


def _color(d: Mapping[str, Any], key: str, default: str | None, where: str) -> RGBA | None:
    v = d.get(key, default)
    if v is None:
        return None
    return parse_color(v, f"{where}.{_camel(key)}")


# ---------------------------------------------------------------------------
# 作用範圍
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Footprint:
    """遮罩類特效改哪些像素：shape＝跟著遮罩輪廓／外接框／內切橢圓；expand 外擴（負＝內縮）、feather 羽化（px）。
    box／ellipse 預設用**平滑後**的外接框（`smooth`），隱私打碼的框不會跟著遮罩邊緣逐幀抖。"""

    shape: str = "mask"
    expand: float = 0.0
    feather: float = 0.0
    smooth: bool = True

    @classmethod
    def from_json(cls, d: Mapping[str, Any] | None, base: Footprint, where: str) -> Footprint:
        if not d:
            return base
        n = _norm_keys(d, where)
        _check_keys(n, {"shape", "expand", "feather", "smooth"}, where)
        return cls(
            _enum(n, "shape", base.shape, SHAPES, where),
            _num(n, "expand", base.expand, -64.0, 256.0, where),
            _num(n, "feather", base.feather, 0.0, 128.0, where),
            _bool(n, "smooth", base.smooth, where),
        )

    def to_json(self) -> dict[str, Any]:
        return {"shape": self.shape, "expand": self.expand, "feather": self.feather, "smooth": self.smooth}


_FOOTPRINT_KEYS = {"footprint", "shape", "expand", "feather"}


def _footprint(n: Mapping[str, Any], base: Footprint, where: str) -> Footprint:
    fp = Footprint.from_json(n.get("footprint"), base, f"{where}.footprint")
    short = {k: n[k] for k in ("shape", "expand", "feather") if k in n}
    return Footprint.from_json(short, fp, where) if short else fp


# ---------------------------------------------------------------------------
# 特效
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class MosaicFx:
    """馬賽克。`block` auto ＝ 外接框短邊 ÷ `blocks`（至少 `minBlock`）；`align` frame＝格子對齊畫面（標準做法），
    object＝對齊物件平滑後的外接框左上角（物件移動時格子跟著走、比較不「爬」）。"""

    type: ClassVar[str] = "mosaic"
    block: float | str = "auto"
    blocks: float = 10.0
    min_block: int = 4
    align: str = "frame"
    footprint: Footprint = field(default_factory=lambda: Footprint("mask", 4.0, 1.0))
    opacity: float = 1.0

    @classmethod
    def from_json(cls, n: Mapping[str, Any], where: str) -> MosaicFx:
        _check_keys(n, {"type", "block", "blocks", "min_block", "align", "opacity"} | _FOOTPRINT_KEYS, where)
        base = cls()
        return cls(
            _auto_num(n, "block", 2.0, 512.0, where),
            _num(n, "blocks", base.blocks, 2.0, 200.0, where),
            int(_int(n, "min_block", base.min_block, 2, 256, where) or base.min_block),
            _enum(n, "align", base.align, ("frame", "object"), where),
            _footprint(n, base.footprint, where),
            _num(n, "opacity", 1.0, 0.0, 1.0, where),
        )


@dataclass(frozen=True)
class BlurFx:
    """物件內高斯模糊（不留光暈：只用物件自己的像素平均，背景顏色不會被吸進來）。
    `radius` auto ＝ 外接框短邊 × `strength`（至少 `minRadius`）。"""

    type: ClassVar[str] = "blur"
    radius: float | str = "auto"
    strength: float = 0.2
    min_radius: float = 2.0
    footprint: Footprint = field(default_factory=lambda: Footprint("mask", 4.0, 2.0))
    opacity: float = 1.0

    @classmethod
    def from_json(cls, n: Mapping[str, Any], where: str) -> BlurFx:
        _check_keys(n, {"type", "radius", "strength", "min_radius", "opacity"} | _FOOTPRINT_KEYS, where)
        base = cls()
        return cls(
            _auto_num(n, "radius", 1.0, 512.0, where),
            _num(n, "strength", base.strength, 0.01, 2.0, where),
            _num(n, "min_radius", base.min_radius, 1.0, 64.0, where),
            _footprint(n, base.footprint, where),
            _num(n, "opacity", 1.0, 0.0, 1.0, where),
        )


@dataclass(frozen=True)
class ReplaceColor:
    """換色：色度接近 `source` 的像素換成 `target` 的色度，**保留原本的明暗**（亮度比例照舊）。
    tolerance／softness 是線性光色度座標 r/(r+g+b)… 的距離（0–1；0.12 大約是「同一個顏色的不同深淺」）。"""

    source: RGBA
    target: RGBA
    tolerance: float = 0.12
    softness: float = 0.08

    @classmethod
    def from_json(cls, d: Mapping[str, Any], where: str) -> ReplaceColor:
        n = _norm_keys(d, where)
        _check_keys(n, {"source", "target", "tolerance", "softness", "from", "to"}, where)
        src = n.get("source", n.get("from"))
        dst = n.get("target", n.get("to"))
        if src is None or dst is None:
            raise FxError(f"{where} 要有 source（或 from）與 target（或 to）兩個顏色")
        return cls(
            parse_color(src, f"{where}.source"), parse_color(dst, f"{where}.target"),
            _num(n, "tolerance", 0.12, 0.0, 1.0, where), _num(n, "softness", 0.08, 0.0, 1.0, where),
        )

    def to_json(self) -> dict[str, Any]:
        return {"source": color_hex(self.source), "target": color_hex(self.target), "tolerance": self.tolerance, "softness": self.softness}


@dataclass(frozen=True)
class ColorFx:
    """調色（全部在線性光裡算，`comp/_color` 的轉換）：順序是 replace → hue → saturation／desaturate → tint → brightness。
    hue：色相旋轉（度，保持亮度的 SVG hueRotate 矩陣）；saturation：倍率；brightness：線性光倍率（1＝不變）；
    tint：上色（保留亮度，tintAmount 0–1）；desaturate：0–1（1＝全灰）。"""

    type: ClassVar[str] = "color"
    hue: float = 0.0
    saturation: float = 1.0
    brightness: float = 1.0
    desaturate: float = 0.0
    tint: RGBA | None = None
    tint_amount: float = 0.0
    replace: ReplaceColor | None = None
    footprint: Footprint = field(default_factory=lambda: Footprint("mask", 0.0, 1.0))
    opacity: float = 1.0

    @classmethod
    def from_json(cls, n: Mapping[str, Any], where: str) -> ColorFx:
        _check_keys(n, {"type", "hue", "saturation", "brightness", "desaturate", "tint", "tint_amount", "replace", "opacity"} | _FOOTPRINT_KEYS, where)
        base = cls()
        tint = _color(n, "tint", None, where)
        amount = _num(n, "tint_amount", 0.5 if tint is not None and "tint_amount" not in n else 0.0, 0.0, 1.0, where)
        rep = n.get("replace")
        return cls(
            _num(n, "hue", 0.0, -360.0, 360.0, where),
            _num(n, "saturation", 1.0, 0.0, 4.0, where),
            _num(n, "brightness", 1.0, 0.0, 8.0, where),
            _num(n, "desaturate", 0.0, 0.0, 1.0, where),
            tint,
            amount,
            None if rep is None else ReplaceColor.from_json(rep, f"{where}.replace"),
            _footprint(n, base.footprint, where),
            _num(n, "opacity", 1.0, 0.0, 1.0, where),
        )

    @property
    def is_identity(self) -> bool:
        return (self.hue % 360.0 == 0.0 and self.saturation == 1.0 and self.brightness == 1.0 and self.desaturate == 0.0
                and (self.tint is None or self.tint_amount == 0.0) and self.replace is None)


@dataclass(frozen=True)
class OutlineFx:
    """描邊／方框（沿用 `bg/outline.stroke_alpha`：線壓在物件外側、先羽化再取輪廓）。width auto ＝ 畫面寬 0.35%。"""

    type: ClassVar[str] = "outline"
    color: RGBA = (1.0, 64 / 255.0, 64 / 255.0, 1.0)
    width: float | str = "auto"
    mode: str = "contour"
    smooth: int = 2
    opacity: float = 1.0

    @classmethod
    def from_json(cls, n: Mapping[str, Any], where: str) -> OutlineFx:
        _check_keys(n, {"type", "color", "width", "mode", "smooth", "opacity"}, where)
        base = cls()
        return cls(
            _color(n, "color", None, where) or base.color,
            _auto_num(n, "width", 0.5, 200.0, where),
            _enum(n, "mode", base.mode, ("contour", "box"), where),
            int(_int(n, "smooth", base.smooth, 0, 20, where) or 0),
            _num(n, "opacity", 1.0, 0.0, 1.0, where),
        )


@dataclass(frozen=True)
class GlowFx:
    """外光暈：物件外圈一層柔光（物件本身的像素不動）。radius auto ＝ 畫面寬 2%；spread＝先把遮罩長大幾 px 再模糊；
    合成用線性光的 screen（`1 − (1 − 底)(1 − 光)`），亮處不會爆白。"""

    type: ClassVar[str] = "glow"
    color: RGBA = (1.0, 1.0, 1.0, 1.0)
    radius: float | str = "auto"
    intensity: float = 1.0
    spread: float = 2.0
    opacity: float = 1.0

    @classmethod
    def from_json(cls, n: Mapping[str, Any], where: str) -> GlowFx:
        _check_keys(n, {"type", "color", "radius", "intensity", "spread", "opacity"}, where)
        base = cls()
        return cls(
            _color(n, "color", None, where) or base.color,
            _auto_num(n, "radius", 1.0, 512.0, where),
            _num(n, "intensity", base.intensity, 0.0, 4.0, where),
            _num(n, "spread", base.spread, 0.0, 256.0, where),
            _num(n, "opacity", 1.0, 0.0, 1.0, where),
        )


@dataclass(frozen=True)
class _Placed:
    """貼紙與文字共用的擺放參數（見 fx/overlay.py 的模組說明）。"""

    anchor: str = "center"
    pivot: str = "center"
    offset: tuple[float, float] = (0.0, 0.0)
    offset_units: str = "bbox"
    follow_scale: bool = True
    follow_rotation: bool = False
    rotation: float = 0.0
    smooth: bool = True
    ref_frame: int | None = None
    opacity: float = 1.0


_PLACED_KEYS = {"anchor", "pivot", "offset", "offset_units", "follow_scale", "follow_rotation", "rotation", "smooth", "ref_frame", "opacity"}


def _placed(n: Mapping[str, Any], base: Any, where: str) -> dict[str, Any]:
    return {
        "anchor": _enum(n, "anchor", base.anchor, ANCHORS, where),
        "pivot": _enum(n, "pivot", base.pivot, PIVOTS, where),
        "offset": _pair(n, "offset", base.offset, -1e5, 1e5, where),
        "offset_units": _enum(n, "offset_units", base.offset_units, OFFSET_UNITS, where),
        "follow_scale": _bool(n, "follow_scale", base.follow_scale, where),
        "follow_rotation": _bool(n, "follow_rotation", base.follow_rotation, where),
        "rotation": _num(n, "rotation", base.rotation, -3600.0, 3600.0, where),
        "smooth": _bool(n, "smooth", base.smooth, where),
        "ref_frame": _int(n, "ref_frame", base.ref_frame, 0, 1 << 31, where),
        "opacity": _num(n, "opacity", base.opacity, 0.0, 1.0, where),
    }


@dataclass(frozen=True)
class StickerFx(_Placed):
    """貼紙（RGBA 圖）黏在物件上。`width` 的單位 `widthUnits`：bbox＝物件外接框寬的倍數、px、frame＝畫面寬的比例。
    `followScale` 時尺寸跟著物件大小（相對參考幀）縮放；`followRotation` 時跟著方向角轉（offset 也一起轉）。"""

    type: ClassVar[str] = "sticker"
    image: str = ""
    width: float = 1.0
    width_units: str = "bbox"

    @classmethod
    def from_json(cls, n: Mapping[str, Any], where: str) -> StickerFx:
        _check_keys(n, {"type", "image", "width", "width_units"} | _PLACED_KEYS, where)
        base = cls()
        return cls(
            **_placed(n, base, where),
            image=str(_str(n, "image", None, where, required=True)),
            width=_num(n, "width", base.width, 1e-4, 1e5, where),
            width_units=_enum(n, "width_units", base.width_units, WIDTH_UNITS, where),
        )


@dataclass(frozen=True)
class TextFx(_Placed):
    """文字標籤（字型、描邊用字幕那一套：`captions.fonts`／`captions.raster`）。預設擺在物件正上方
    （anchor top、pivot bottom、往上 4% 框高）。`size` 單位 `sizeUnits`：frame＝畫面高的比例、px、bbox＝外接框高的比例。"""

    type: ClassVar[str] = "text"
    anchor: str = "top"
    pivot: str = "bottom"
    offset: tuple[float, float] = (0.0, -0.04)
    follow_scale: bool = False
    text: str = ""
    size: float = 0.05
    size_units: str = "frame"
    color: RGBA = (1.0, 1.0, 1.0, 1.0)
    stroke_color: RGBA = (0.0, 0.0, 0.0, 1.0)
    stroke_width: float = 0.12
    background: RGBA | None = None
    padding: float = 0.3
    radius: float = 0.3
    font_families: tuple[str, ...] = ()
    font_file: str | None = None
    font_weight: int = 700
    language: str | None = None

    @classmethod
    def from_json(cls, n: Mapping[str, Any], where: str) -> TextFx:
        _check_keys(n, {"type", "text", "size", "size_units", "color", "stroke_color", "stroke_width", "background", "padding", "radius",
                        "font_families", "font_file", "font_weight", "language", "font"} | _PLACED_KEYS, where)
        base = cls()
        fams = n.get("font_families")
        font = n.get("font")
        if isinstance(font, Mapping):  # 也吃字幕樣式的 {"font": {"families": [...], "file": ..., "weight": ...}}
            fn = _norm_keys(font, f"{where}.font")
            fams = fams if fams is not None else fn.get("families")
            n = {**n, "font_file": n.get("font_file", fn.get("file")), "font_weight": n.get("font_weight", fn.get("weight"))}
        elif font is not None:
            raise FxError(f"{where}.font 要是物件（{{families, file, weight}}）")
        if fams is not None and (not isinstance(fams, (list, tuple)) or not all(isinstance(f, str) for f in fams)):
            raise FxError(f"{where}.fontFamilies 要是字串陣列")
        return cls(
            **_placed(n, base, where),
            text=str(_str(n, "text", None, where, required=True)),
            size=_num(n, "size", base.size, 1e-4, 1e4, where),
            size_units=_enum(n, "size_units", base.size_units, SIZE_UNITS, where),
            color=_color(n, "color", None, where) or base.color,
            stroke_color=_color(n, "stroke_color", None, where) or base.stroke_color,
            stroke_width=_num(n, "stroke_width", base.stroke_width, 0.0, 0.5, where),
            background=_color(n, "background", None, where),
            padding=_num(n, "padding", base.padding, 0.0, 2.0, where),
            radius=_num(n, "radius", base.radius, 0.0, 1.0, where),
            font_families=tuple(fams or ()),
            font_file=_str(n, "font_file", None, where),
            font_weight=int(_int(n, "font_weight", base.font_weight, 100, 1000, where) or 700),
            language=_str(n, "language", None, where),
        )


Effect = Union[MosaicFx, BlurFx, ColorFx, OutlineFx, GlowFx, StickerFx, TextFx]
EFFECTS: dict[str, type] = {c.type: c for c in (MosaicFx, BlurFx, ColorFx, OutlineFx, GlowFx, StickerFx, TextFx)}


def parse_effect(d: Any, where: str = "effect") -> Effect:
    n = _norm_keys(d, where)
    t = str(n.get("type", "")).strip().lower()
    cls = EFFECTS.get(t)
    if cls is None:
        raise FxError(f"{where}.type={n.get('type')!r} 不認得（可用：{'｜'.join(EFFECTS)}）")
    return cls.from_json(n, where)  # type: ignore[attr-defined]


def effect_json(e: Effect) -> dict[str, Any]:
    """結果 JSON 用的摘要（camelCase；顏色寫回 hex）。"""
    from dataclasses import fields

    out: dict[str, Any] = {"type": e.type}
    for f in fields(e):
        v = getattr(e, f.name)
        if isinstance(v, Footprint) or isinstance(v, ReplaceColor):
            v = v.to_json()
        elif isinstance(v, tuple) and len(v) == 4 and all(isinstance(x, float) for x in v) and f.name in ("color", "tint", "stroke_color", "background"):
            v = color_hex(v)
        elif isinstance(v, tuple):
            v = list(v)
        out[_camel(f.name)] = v
    return out


# ---------------------------------------------------------------------------
# 特效檔
# ---------------------------------------------------------------------------
Target = Union[int, str]  # 物件編號（1 起）、"*"、或遮罩檔路徑


@dataclass(frozen=True)
class ObjectStack:
    target: Target
    effects: tuple[Effect, ...]


def _target(v: Any, where: str) -> Target:
    if isinstance(v, bool):
        raise FxError(f"{where} 要是物件編號（1 起）或 \"*\"，拿到 {v!r}")
    if isinstance(v, int):
        if v < 1:
            raise FxError(f"{where} 物件編號從 1 開始，拿到 {v}")
        return v
    s = str(v).strip()
    if s == "*" or s.lower() in ("all", "every"):
        return "*"
    if s.isdigit():
        return _target(int(s), where)
    return s  # 遮罩檔路徑


def _effects(v: Any, where: str) -> tuple[Effect, ...]:
    if not isinstance(v, (list, tuple)):
        raise FxError(f"{where} 要是特效陣列")
    return tuple(parse_effect(e, f"{where}[{i}]") for i, e in enumerate(v))


def parse_stack(doc: Any) -> list[ObjectStack]:
    """三種寫法 → list[ObjectStack]（見模組說明）。"""
    if isinstance(doc, (list, tuple)):
        return [ObjectStack("*", _effects(doc, "effects"))]
    if not isinstance(doc, Mapping):
        raise FxError(f"特效檔要是物件或陣列，拿到 {type(doc).__name__}")
    if "stacks" in doc:
        extra = sorted(set(doc) - {"stacks", "format", "version"})
        if extra:
            raise FxError(f"特效檔頂層沒有欄位 {', '.join(extra)}（可用：stacks、format、version）")
        st = doc["stacks"]
        if not isinstance(st, (list, tuple)):
            raise FxError("stacks 要是陣列")
        out: list[ObjectStack] = []
        for i, s in enumerate(st):
            w = f"stacks[{i}]"
            if not isinstance(s, Mapping):
                raise FxError(f"{w} 要是物件")
            keys = set(s)
            if not keys <= {"object", "masks", "effects"}:
                raise FxError(f"{w} 沒有欄位 {', '.join(sorted(keys - {'object', 'masks', 'effects'}))}（可用：object、masks、effects）")
            if ("object" in s) == ("masks" in s):
                raise FxError(f"{w} 要指定 object（編號或 \"*\"）或 masks（遮罩檔路徑）其中一個")
            tgt = _target(s["object"], f"{w}.object") if "object" in s else str(s["masks"])
            out.append(ObjectStack(tgt, _effects(s.get("effects", []), f"{w}.effects")))
        return out
    return [ObjectStack(_target(k, f"[{k!r}]"), _effects(v, f"[{k!r}]")) for k, v in doc.items()]


def rebase_path(path: str, base: Path) -> str:
    """特效檔裡的相對路徑：先找特效檔所在的資料夾（base），那裡有就用；沒有才照目前目錄（舊的語意，
    也是 find.v1.json 用相對 --out 時記下來的路徑的語意）。絕對路徑與 `~` 原樣。"""
    s = os.path.expanduser(str(path))
    if not s or os.path.isabs(s):
        return s
    cand = base / s
    if cand.exists():
        return str(cand)
    return s


def rebase_stack(stacks: list[ObjectStack], base: Path) -> list[ObjectStack]:
    """stacks[].masks、sticker.image、text.fontFile 的相對路徑換成相對 base（見 rebase_path）。"""
    from dataclasses import replace

    out: list[ObjectStack] = []
    for st in stacks:
        tgt = st.target
        if isinstance(tgt, str) and tgt != "*":
            tgt = rebase_path(tgt, base)
        effs: list[Effect] = []
        for e in st.effects:
            if isinstance(e, StickerFx):
                e = replace(e, image=rebase_path(e.image, base))
            elif isinstance(e, TextFx) and e.font_file:
                e = replace(e, font_file=rebase_path(e.font_file, base))
            effs.append(e)
        out.append(ObjectStack(tgt, tuple(effs)))
    return out


def load_stack(spec: Any) -> list[ObjectStack]:
    """檔案路徑、JSON 字串（以 { 或 [ 開頭）、或已解析的 dict/list。

    檔案路徑時，裡面的相對路徑（masks、貼紙 image、文字 fontFile）**先相對特效檔所在的資料夾**解析
    （`rebase_stack`）：sidecar 的目前目錄是 App 的工作目錄，只照目前目錄的話存成檔案的特效設定永遠找不到遮罩。
    直接給 JSON 字串／dict 時維持目前目錄的語意。"""
    if isinstance(spec, (Mapping, list, tuple)):
        return parse_stack(spec)
    s = str(spec).strip()
    if s.startswith("{") or s.startswith("["):
        try:
            return parse_stack(json.loads(s))
        except json.JSONDecodeError as e:
            raise FxError(f"--effects 的 JSON 壞掉：{e}") from e
    p = Path(os.path.expanduser(s))
    try:
        text = p.read_text(encoding="utf-8-sig")
    except OSError as e:
        raise FxError(f"讀不了特效檔 {p}：{e}") from e
    try:
        stacks = parse_stack(json.loads(text))
    except json.JSONDecodeError as e:
        raise FxError(f"特效檔 {p} 不是合法 JSON：{e}") from e
    return rebase_stack(stacks, p.resolve().parent)
