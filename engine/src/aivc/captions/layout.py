"""一則字幕的版面：安全區、錨點、換行、每個詞在畫面上的筆位（1× 像素，來源解析度）。

只有 Python 算版面：舞台預覽（TS CaptionLayer）讀 captions.layout 產生的 layout.v1.json，不自己排，
所以預覽與燒錄的斷行、位置永遠一致。

- 安全區 auto：H/W ≥ 1.5（直式短影音）→ 上 8%、下 18%、左 6%、右 12%（避開 TikTok/Reels 介面）；否則四邊 5%（EBU R95 圖文安全區）。
- 錨點 bottom/top 貼安全區；middle = 則中心在 78% H（橫式）／70% H（直式）—— 跳字／彈跳預設的市售慣例位置，不是正中央。
- 強調詞的 emphasisScale 是**靜態**放大（版面寬度就算進去），跳字動畫的 activeScale 疊在它上面。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable

from . import text as T
from .anim import ease_out_back
from .linebreak import break_lines


@dataclass
class Piece:
    word: int  # 詞索引（cue.words）
    text: str  # 顯示文字（可能已轉大寫；硬換行時是詞的一部分）
    char_offset: int  # 這段在詞內的起始字元（打字機）
    x: float  # 筆位左緣（1× 像素）
    w: float  # 前進量（含靜態強調縮放）
    static_scale: float = 1.0


@dataclass
class Line:
    top: float
    height: float
    baseline: float
    left: float  # 文字（不含描邊）左緣
    width: float
    pieces: list[Piece] = field(default_factory=list)


@dataclass
class CueLayout:
    cue_id: str
    start: int
    end: int
    font_px: float
    scale: float  # 換行重試用的字級倍率（1 / 0.9 / 0.8）
    ascent: float
    descent: float
    lines: list[Line]
    box: tuple[int, int, int, int]  # 畫布（含動畫／陰影餘裕），已裁到畫面內、偶數對齊
    center: tuple[float, float]  # 則級縮放／位移的樞紐（文字區塊中心，畫面座標）
    overflow: bool = False

    @property
    def pieces(self) -> list[tuple[Line, Piece]]:
        return [(ln, p) for ln in self.lines for p in ln.pieces]


def safe_rect(width: int, height: int, mode: str = "auto") -> tuple[float, float, float, float]:
    W, H = float(width), float(height)
    if mode == "none":
        return (0.0, 0.0, W, H)
    if mode == "shorts" or (mode == "auto" and H / max(W, 1.0) >= 1.5):
        return (0.06 * W, 0.08 * H, W - 0.12 * W, H - 0.18 * H)
    return (0.05 * W, 0.05 * H, 0.95 * W, 0.95 * H)


def _mixed_boundary(a: str, b: str) -> bool:
    x, y = a[-1:], b[:1]
    lat = lambda ch: bool(ch) and ch.isalnum() and not T.is_cjk_char(ch)  # noqa: E731
    return (T.is_cjk_char(x) and lat(y)) or (lat(x) and T.is_cjk_char(y))


def space_between_fn(space_w: float, cjk_latin_space: bool) -> Callable[[str, str], float]:
    """詞間距：拉丁詞之間一個空白；cjkLatinSpace 時中文字與英數之間也一個空白（跟 TS joinWords 同規則）。"""

    def f(a: str, b: str) -> float:
        if T.needs_space(a, b) or (cjk_latin_space and _mixed_boundary(a, b)):
            return space_w
        return 0.0

    return f


def max_anim_scale(anim: dict[str, Any]) -> tuple[float, float]:
    """(詞最大縮放, 則最大縮放)：easeOutBack 峰值 1.1 → 超出量 ×1.1。"""
    peak = 1.1
    word = 1.0
    if anim.get("word") == "pop":
        word = 1.0 + (float(anim.get("activeScale") or 1.0) - 1.0) * peak
    cue = 1.0
    if anim.get("cueIn") == "pop":
        cue = 0.7 + 0.3 * peak
    elif anim.get("cueIn") == "spring":
        cue = 0.6 + 0.4 * peak
    return max(1.0, word), max(1.0, cue)


def layout_cue(
    cue: dict[str, Any],
    style: dict[str, Any],
    segmentation: dict[str, Any],
    width: int,
    height: int,
    raster: Any,
) -> CueLayout:
    """raster：captions.raster.Rasterizer（字級 = 基準字級；量寬、字高都從它拿）。"""
    font = style.get("font") or {}
    lay = style.get("layout") or {}
    anim = style.get("animation") or {}
    box_style = style.get("box") or {}
    uppercase = bool(font.get("uppercaseLatin"))
    emph_scale = float(anim.get("emphasisScale") or 1.0)
    words = cue.get("words") or []
    tokens = [T.display_text(str(w.get("text", "")).strip(), uppercase) for w in words]
    static = [emph_scale if w.get("emphasis") else 1.0 for w in words]

    sx0, sy0, sx1, sy1 = safe_rect(width, height, str(lay.get("safeArea") or "auto"))
    stroke = raster.stroke_px()
    max_w = min(float(lay.get("maxWidthPct") or 90.0) / 100.0 * width, sx1 - sx0) - 2.0 * stroke
    space_w = raster.measure(" ")
    spacer = space_between_fn(space_w, bool(font.get("cjkLatinSpace", True)))

    # 量寬時要知道 token 屬於哪個詞（靜態強調縮放）；硬換行拆字後用 owner 對回
    def owners(toks: list[str]) -> list[int]:
        if len(toks) == len(tokens):
            return list(range(len(tokens)))
        out: list[int] = []
        for i, t in enumerate(tokens):
            out.extend([i] * (len(t) if (T.has_cjk(t) and len(t) > 1) else 1))
        return out

    measure_cache: dict[str, float] = {}

    def measure_plain(t: str) -> float:
        if t not in measure_cache:
            measure_cache[t] = raster.measure(t)
        return measure_cache[t]

    # break_lines 的 measure 只拿到字串：把強調縮放編進查表（同一字串可能同時是強調與非強調詞 → 取較寬者，保守）
    emph_text = {tokens[i] for i in range(len(tokens)) if static[i] != 1.0}
    # 換行會量「拿掉行尾 。，、 之後」的寬度：那個字串也要認得是強調詞，否則省下的寬度會被高估
    emph_text |= {T.trim_line_end_punct(t) for t in list(emph_text)}

    def measure(t: str) -> float:
        return measure_plain(t) * (emph_scale if t in emph_text else 1.0)

    pause_after = [False] * len(tokens)
    for i in range(len(words) - 1):
        # 停頓 ≥150 ms（約 4–5 幀）：換行加分，跟分段的規則一致
        gap = int(words[i + 1].get("startFrame", 0)) - int(words[i].get("endFrame", 0))
        pause_after[i] = gap >= 4
    res = break_lines(tokens, measure, max(1.0, max_w), int(segmentation.get("maxLines") or 2), spacer, pause_after)
    toks = res.tokens if res.tokens is not None else tokens
    own = owners(toks)
    scale = res.scale
    font_px = raster.font_px * scale
    asc, desc = raster.metrics(scale)
    line_h = float(lay.get("lineHeight") or 1.25) * font_px
    n_lines = max(1, len(res.lines))
    total_h = n_lines * line_h

    anchor = str(lay.get("anchor") or "bottom")
    off = float(lay.get("offsetYPct") or 0.0) / 100.0 * height
    if anchor == "top":
        top = sy0 + off
    elif anchor == "middle":
        cy = (0.70 if height / max(width, 1) >= 1.5 else 0.78) * height + off
        top = cy - total_h / 2.0
    else:
        top = sy1 - total_h - off
    top = min(max(top, sy0), max(sy0, sy1 - total_h))

    lines: list[Line] = []
    align = str(lay.get("align") or "center")
    for li, idx in enumerate(res.lines):
        pieces: list[Piece] = []
        x = 0.0
        char_pos: dict[int, int] = {}
        # 行尾的 。，、 不顯示（Netflix 繁中規範）；整個被拿掉的 token（單獨的「。」）不產生 piece。
        # char_offset 仍以原文計（打字機的字數進度是整個詞的原文長度），所以只改顯示字串、不改 toks。
        shown = T.strip_line_end_tokens([toks[ti] for ti in idx])
        prev_t: str | None = None
        for n, ti in enumerate(idx):
            t = shown[n]
            wi = own[ti]
            co = char_pos.get(wi, sum(len(toks[j]) for j in range(ti) if own[j] == wi))
            char_pos[wi] = co + len(toks[ti])
            if not t:
                continue
            if prev_t is not None:
                x += spacer(prev_t, t) * scale
            adv = raster.measure(t, scale) * static[wi]
            pieces.append(Piece(wi, t, co, x, adv, static[wi]))
            prev_t = t
            x += adv
        lw = x
        if align == "left":
            left = sx0 + stroke
        elif align == "right":
            left = sx1 - stroke - lw
        else:
            left = (sx0 + sx1) / 2.0 - lw / 2.0
        for p in pieces:
            p.x += left
        ltop = top + li * line_h
        baseline = ltop + (line_h - (asc + desc)) / 2.0 + asc
        lines.append(Line(ltop, line_h, baseline, left, lw, pieces))

    # 畫布：文字範圍 + 描邊 + 陰影 + 動畫餘裕（跳字放大、彈簧／上滑位移、方框內距）
    word_peak, cue_peak = max_anim_scale(anim)
    shadow = style.get("shadow") if isinstance(style.get("shadow"), dict) else None
    sh_ext = 0.0
    if shadow:
        sh_ext = (3.0 * float(shadow.get("blurPct") or 0) + max(abs(float(shadow.get("dxPct") or 0)), abs(float(shadow.get("dyPct") or 0)))) / 100.0 * font_px
    em = font_px
    motion = 0.0
    if anim.get("cueIn") == "slideUp":
        motion = 0.3 * em
    elif anim.get("cueIn") == "spring":
        motion = 0.25 * em
    pad_box = float(box_style.get("padEm") or 0.0) * em if (box_style.get("mode") or "none") != "none" else 0.0
    max_emph = max(static) if static else 1.0
    base_pad = stroke + sh_ext + pad_box + 0.15 * em * max_emph + 4.0
    widest = max((p.w for ln in lines for p in ln.pieces), default=0.0)
    pad_x = base_pad + widest * (word_peak - 1.0) / 2.0
    pad_y = base_pad + motion + em * (word_peak - 1.0)
    x0 = min((ln.left for ln in lines), default=0.0) - pad_x
    x1 = max((ln.left + ln.width for ln in lines), default=0.0) + pad_x
    y0 = top - pad_y
    y1 = top + total_h + pad_y
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    if cue_peak > 1.0:
        gx, gy = (x1 - x0) * (cue_peak - 1.0) / 2.0, (y1 - y0) * (cue_peak - 1.0) / 2.0
        x0, x1, y0, y1 = x0 - gx, x1 + gx, y0 - gy, y1 + gy
    bx0 = max(0, int(math.floor(x0)) & ~1)
    by0 = max(0, int(math.floor(y0)) & ~1)
    bx1 = min(int(width), int(math.ceil(x1)) + (int(math.ceil(x1)) & 1))
    by1 = min(int(height), int(math.ceil(y1)) + (int(math.ceil(y1)) & 1))
    text_cx = (min((ln.left for ln in lines), default=0.0) + max((ln.left + ln.width for ln in lines), default=0.0)) / 2.0
    return CueLayout(
        cue_id=str(cue.get("id")), start=int(cue["startFrame"]), end=int(cue["endFrame"]), font_px=font_px, scale=scale,
        ascent=asc, descent=desc, lines=lines, box=(bx0, by0, max(bx0 + 2, bx1), max(by0 + 2, by1)),
        center=(text_cx, top + total_h / 2.0), overflow=bool(res.overflow),
    )


__all__ = ["Piece", "Line", "CueLayout", "safe_rect", "layout_cue", "max_anim_scale", "space_between_fn", "ease_out_back"]
