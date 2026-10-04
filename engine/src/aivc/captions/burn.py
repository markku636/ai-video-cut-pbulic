"""字幕燒錄（研究規格 §5.3 H、§5.5）：第 k 個 proxy 幀的字幕畫布 → 只在 alpha 範圍內混進 yuv420p 平面。

render.py 的掛勾是 `yield plan.captions.apply(last_out, k)`，所以 apply() 的紀律是：
- 這一幀沒有字幕 → **回傳同一個物件**（`is`）；定格重送、範圍外的幀零複製。
- 有字幕 → `fr.with_planes(y.copy(), u.copy(), v.copy())`，**永遠不改傳進來的幀**：render_frames 對同一個來源幀
  （定格／卡片合成快取）會重送同一份物件，但字幕狀態每個 k 都不同。
- Y 只寫 alpha > 0 的像素；色度寫 2×2 平均 alpha > 0 的樣本 → 字幕框外逐位元相同（測試斷言）。

混色在 **gamma 編碼的 Y'CbCr** 裡做（跟任何字幕／圖文軟體一樣，字幕顏色本來就是 sRGB 8-bit 定義的）：
    Y  = a·Yoff + Yscale·(Kr·R + Kg·G + Kb·B)ₚ + (1 − a)·Y_in            （ₚ = 預乘值）
    Cb = a·128 + Cscale·((B − Y')/(2(1−Kb)))ₚ + (1 − a)·Cb_in           （色度用 2×2 平均的預乘值與 alpha）
矩陣／range 取自這一幀（bt709|bt601、tv|pc），係數表共用 comp/_color.py：白字在 tv 是 Y=235、pc 是 255。
"""
from __future__ import annotations

from bisect import bisect_right
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Iterable

import numpy as np

from . import anim as A
from .fonts import FontSpec, missing_cjk_warning, resolve_font
from .layout import CueLayout, layout_cue
from .presets import effective_segmentation, effective_style
from .raster import Rasterizer, over, parse_color, rounded_rect
from .text import has_cjk, is_cjk_lang


def pick_color(colors: dict[str, Any], state: str, emphasis: bool) -> str:
    """明確指定的狀態色優先；沒指定 → 強調色（強調詞）或文字色。卡拉OK 的 future=#FFFFFF 會蓋過強調色，這是刻意的（還沒唱到）。"""
    base = colors.get("emphasis") if emphasis else colors.get("text")
    base = base or colors.get("text") or "#FFFFFF"
    explicit = colors.get(state)
    return str(explicit or base)


def blend_rgba_into_yuv(y: np.ndarray, u: np.ndarray, v: np.ndarray, x0: int, y0: int, canvas: np.ndarray, matrix: str = "bt709", color_range: str = "tv") -> bool:
    """預乘 RGBA 畫布（float32 0..1）混進三個平面（就地）。回傳是否真的寫了任何樣本。"""
    from ..comp import _color as C

    H, W = y.shape
    h, w = canvas.shape[:2]
    # 對齊到偶數座標，色度 2×2 區塊才完整；補出來的像素 alpha=0，不影響結果
    ex0, ey0 = x0 - (x0 & 1), y0 - (y0 & 1)
    ex1, ey1 = x0 + w, y0 + h
    ex1 += ex1 & 1
    ey1 += ey1 & 1
    buf = np.zeros((ey1 - ey0, ex1 - ex0, 4), np.float32)
    buf[y0 - ey0 : y0 - ey0 + h, x0 - ex0 : x0 - ex0 + w] = canvas
    # 裁到畫面內（仍保持偶數起點；終點若是奇數畫面邊緣就讓色度那一格只用畫面內像素）
    cx0, cy0 = max(ex0, 0), max(ey0, 0)
    cx1, cy1 = min(ex1, W + (W & 1)), min(ey1, H + (H & 1))
    if cx1 <= cx0 or cy1 <= cy0:
        return False
    buf = buf[cy0 - ey0 : cy1 - ey0, cx0 - ex0 : cx1 - ex0]
    a = buf[..., 3]
    if not np.any(a > 0):
        return False
    m = C.matrix_coeffs(matrix if matrix in ("bt709", "bt601") else "bt709")
    rp = C.range_params(color_range)
    R, G, B = buf[..., 0], buf[..., 1], buf[..., 2]
    yl = m.kr * R + m.kg * G + m.kb * B
    # ---- Y ----
    iy1, ix1 = min(cy1, H), min(cx1, W)
    ys = (slice(cy0, iy1), slice(cx0, ix1))
    ay = a[: iy1 - cy0, : ix1 - cx0]
    yin = y[ys].astype(np.float32)
    yout = rp.y_off * ay + rp.y_scale * yl[: iy1 - cy0, : ix1 - cx0] + (1.0 - ay) * yin
    yw = ay > 0
    y[ys] = np.where(yw, np.clip(np.rint(yout), 0, 255), yin).astype(np.uint8)
    # ---- 色度（2×2 平均預乘值）----
    hh, ww = (cy1 - cy0) // 2, (cx1 - cx0) // 2
    if hh <= 0 or ww <= 0:
        return True

    def pool(p: np.ndarray) -> np.ndarray:
        return p[: hh * 2, : ww * 2].reshape(hh, 2, ww, 2).mean(axis=(1, 3))

    a2 = pool(a)
    cbp = pool((B - yl) / m.cb_scale)
    crp = pool((R - yl) / m.cr_scale)
    ch_h, ch_w = u.shape
    uy0, ux0 = cy0 // 2, cx0 // 2
    uy1, ux1 = min(uy0 + hh, ch_h), min(ux0 + ww, ch_w)
    cs = (slice(uy0, uy1), slice(ux0, ux1))
    a2 = a2[: uy1 - uy0, : ux1 - ux0]
    cw = a2 > 0
    for plane, cp in ((u, cbp), (v, crp)):
        cin = plane[cs].astype(np.float32)
        cout = C.C_ZERO * a2 + rp.c_scale * cp[: uy1 - uy0, : ux1 - ux0] + (1.0 - a2) * cin
        plane[cs] = np.where(cw, np.clip(np.rint(cout), 0, 255), cin).astype(np.uint8)
    return True


@dataclass
class _CueCtx:
    cue: dict[str, Any]
    style: dict[str, Any]
    layout: CueLayout
    raster: Rasterizer


class CaptionBurner:
    """一條 CaptionTrackV1 的逐幀燒錄器。字型／版面／精靈都惰性建立並快取（長片只為出現的則付成本）。"""

    def __init__(self, track: dict[str, Any], width: int, height: int, fps: tuple[int, int], *, font: FontSpec | None = None, supersample: int = 2) -> None:
        self.track = track
        self.width, self.height = int(width), int(height)
        self.fps = (int(fps[0]), int(fps[1]))
        self.language = str(track.get("language") or "")
        self.cues = sorted((c for c in track.get("cues") or [] if not c.get("hidden") and c.get("words")), key=lambda c: int(c["startFrame"]))
        self._starts = [int(c["startFrame"]) for c in self.cues]
        self.track_style = effective_style(track)
        self.segmentation = track.get("segmentation") or effective_segmentation(track.get("presetId"), self.language)
        self.font = font or resolve_font(self.track_style, self.language)
        self.supersample = supersample
        self._ctx: dict[str, _CueCtx] = {}
        self._rasters: dict[tuple, Rasterizer] = {}
        self._canvas_cache: OrderedDict[tuple, np.ndarray] = OrderedDict()
        self.warnings: list[dict[str, Any]] = []
        # 需要中日韓字形：語言是中日韓、或任何一則有中日韓字（英文 track 夾中文專有名詞也算）
        needs_cjk = is_cjk_lang(self.language) or any(has_cjk(str(w.get("text", ""))) for c in self.cues for w in c.get("words") or [])
        fw = missing_cjk_warning(self.font, needs_cjk)
        if fw is not None:
            self.warnings.append(fw)

    # ---- 查詢 ----
    def cues_at(self, k: int) -> list[dict[str, Any]]:
        i = bisect_right(self._starts, k) - 1
        out = []
        # 段不重疊時最多一則；容忍舊檔的重疊，往回多看幾則
        for j in range(i, max(-1, i - 4), -1):
            c = self.cues[j]
            if int(c["startFrame"]) <= k < int(c["endFrame"]):
                out.append(c)
        return out[::-1]

    @property
    def frames(self) -> int:
        return sum(int(c["endFrame"]) - int(c["startFrame"]) for c in self.cues)

    def raster_for(self, style: dict[str, Any]) -> Rasterizer:
        font_px = float((style.get("font") or {}).get("sizePctShortSide") or 5.2) / 100.0 * min(self.width, self.height)
        key = (round(font_px, 3), repr(style.get("stroke")), repr(style.get("shadow")), (style.get("colors") or {}).get("stroke"), (style.get("font") or {}).get("letterSpacingEm"))
        r = self._rasters.get(key)
        if r is None:
            r = Rasterizer(self.font, font_px, style, supersample=self.supersample)
            self._rasters[key] = r
        return r

    def context(self, cue: dict[str, Any]) -> _CueCtx:
        cid = str(cue.get("id"))
        c = self._ctx.get(cid)
        if c is None or c.cue is not cue:
            style = effective_style(self.track, cue) if cue.get("styleOverride") else self.track_style
            raster = self.raster_for(style)
            lay = layout_cue(cue, style, self.segmentation, self.width, self.height, raster)
            if lay.overflow and not any(w.get("cueId") == cid for w in self.warnings):
                self.warnings.append({"cueId": cid, "kind": "overflow"})
            c = _CueCtx(cue, style, lay, raster)
            self._ctx[cid] = c
        return c

    # ---- 畫布 ----
    def cue_canvas(self, cue: dict[str, Any], k: int) -> tuple[int, int, np.ndarray] | None:
        import cv2

        cc = self.context(cue)
        st, lay, raster = cc.style, cc.layout, cc.raster
        an = st.get("animation") or {}
        ca = A.cue_anim(an, k, lay.start, lay.end, self.fps)
        if ca.opacity <= 1e-4:
            return None
        bx0, by0, bx1, by1 = lay.box
        words = cue.get("words") or []
        states = A.word_states([int(w["startFrame"]) for w in words], [int(w["endFrame"]) for w in words], lay.end, k)
        word_anim = an.get("word") or "none"
        colors = st.get("colors") or {}
        box = st.get("box") or {}
        box_mode = box.get("mode") or "none"
        em = lay.font_px

        draws: list[tuple] = []  # (精靈參數…)，同時當成畫布快取鍵
        rects: list[tuple] = []
        if box_mode == "line":
            pad = float(box.get("padEm") or 0.0) * em
            for ln in lay.lines:
                rects.append((ln.left - pad, ln.baseline - lay.ascent - pad * 0.5, ln.left + ln.width + pad, ln.baseline + lay.descent + pad * 0.5))
        elif box_mode == "activeWord":
            act = next((i for i, s in enumerate(states) if s.state == A.ACTIVE), None)
            if act is not None:
                pad = float(box.get("padEm") or 0.0) * em
                r_cur = self._word_rect(lay, act, pad)
                if r_cur is not None:
                    if word_anim == "boxMove" and act > 0:
                        r_prev = self._word_rect(lay, act - 1, pad)
                        t = A.box_move_t(states[act], k, self.fps, float(an.get("wordMs") or 0.0))
                        if r_prev is not None and t < 1.0:
                            r_cur = tuple(p + (c - p) * t for p, c in zip(r_prev, r_cur))
                    rects.append(r_cur)
        for ln in lay.lines:
            center_y = ln.baseline - (lay.ascent - lay.descent) / 2.0
            items = []
            for p in ln.pieces:
                ws = states[p.word]
                w = words[p.word]
                emph = bool(w.get("emphasis"))
                text = p.text
                if word_anim == "typewriter":
                    total = len(str(w.get("text", "")).strip())
                    n = A.typewriter_chars(ws, total) - p.char_offset
                    if n <= 0:
                        continue
                    text = text[:n]
                color = pick_color(colors, ws.state, emph)
                pop = 1.0
                if word_anim == "pop":
                    pop = A.word_pop_scale(ws, k, self.fps, float(an.get("activeScale") or 1.0), float(an.get("wordMs") or 0.0))
                s = A.scale_bucket(lay.scale * p.static_scale * pop)
                wipe = None
                if word_anim == "karaokeWipe" and ws.state == A.ACTIVE:
                    wipe = (pick_color(colors, A.FUTURE, emph), round(ws.progress * 64) / 64)
                items.append((p, text, color, s, pop, wipe))
            # 跳字：放大的詞把同一行的鄰居往兩側推開、整行中心不變（以詞中心原地放大會吃掉詞間空白，描邊疊在一起）
            if any(it[4] != 1.0 for it in items):
                widths = [it[0].w * it[4] for it in items]
                gaps = [items[i + 1][0].x - (items[i][0].x + items[i][0].w) for i in range(len(items) - 1)]
                left = ln.left + ln.width / 2.0 - (sum(widths) + sum(gaps)) / 2.0
                centers = []
                for i in range(len(items)):
                    centers.append(left + widths[i] / 2.0)
                    left += widths[i] + (gaps[i] if i < len(gaps) else 0.0)
            else:
                centers = [it[0].x + it[0].w / 2.0 for it in items]
            for (p, text, color, s, _pop, wipe), cx in zip(items, centers):
                draws.append((text, color, s, round(cx, 2), center_y, ln.baseline, p.w, wipe))
        key = (str(cue.get("id")), tuple(tuple(round(v, 2) if isinstance(v, float) else v for v in r) for r in rects), tuple(draws))
        base = self._canvas_cache.get(key)
        if base is None:
            base = np.zeros((by1 - by0, bx1 - bx0, 4), np.float32)
            box_rgba = parse_color(box.get("color"), (0.0, 0.0, 0.0, 0.6))
            radius = float(box.get("radiusEm") or 0.0) * em
            for r in rects:
                rx0, ry0 = int(round(r[0])), int(round(r[1]))
                rx1, ry1 = int(round(r[2])), int(round(r[3]))
                if rx1 > rx0 and ry1 > ry0:
                    over(base, rounded_rect(rx1 - rx0, ry1 - ry0, radius, box_rgba), rx0 - bx0, ry0 - by0)
            placed = []
            for text, color, s, cx, center_y, baseline, width_static, wipe in draws:
                fill = raster.sprite(text, color, s, "fill")
                adv = fill.advance
                # 以詞中心縮放（跳字／強調放大時字不會往右長）；打字機的前綴沿用整個詞的左緣
                pen_x = int(round(cx - width_static / 2.0)) if word_anim == "typewriter" else int(round(cx - adv / 2.0))
                pen_y = int(round(center_y + (baseline - center_y) * (s / lay.scale)))
                placed.append((text, color, s, wipe, fill, pen_x, pen_y))
            # 兩趟：先貼整則的陰影＋描邊，再貼字面 → 粗描邊不會蓋到隔壁詞的字
            for text, _color, s, _wipe, _fill, pen_x, pen_y in placed:
                under = raster.sprite(text, "", s, "under")
                over(base, under.rgba, pen_x + under.ox - bx0, pen_y + under.oy - by0)
            for text, _color, s, wipe, fill, pen_x, pen_y in placed:
                rgba = fill.rgba
                if wipe is not None:
                    fut = raster.sprite(text, wipe[0], s, "fill")
                    rgba = fut.rgba.copy()
                    cut = -fill.ox + wipe[1] * fill.advance
                    ci = int(np.floor(cut))
                    frac = cut - ci
                    if ci > 0:
                        rgba[:, : min(ci, rgba.shape[1])] = fill.rgba[:, : min(ci, rgba.shape[1])]
                    if 0 <= ci < rgba.shape[1] and frac > 0:
                        rgba[:, ci] = fill.rgba[:, ci] * frac + fut.rgba[:, ci] * (1.0 - frac)
                over(base, rgba, pen_x + fill.ox - bx0, pen_y + fill.oy - by0)
            self._canvas_cache[key] = base
            if len(self._canvas_cache) > 16:
                self._canvas_cache.popitem(last=False)
        else:
            self._canvas_cache.move_to_end(key)
        canvas = base
        dy = ca.dy_em * em
        if abs(ca.scale - 1.0) > 1e-4 or abs(dy) > 1e-3:
            cx, cy = lay.center[0] - bx0, lay.center[1] - by0
            M = np.array([[ca.scale, 0.0, (1.0 - ca.scale) * cx], [0.0, ca.scale, (1.0 - ca.scale) * cy + dy]], np.float32)
            canvas = cv2.warpAffine(base, M, (base.shape[1], base.shape[0]), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
        if ca.opacity < 1.0:
            canvas = canvas * np.float32(ca.opacity)
        return bx0, by0, canvas

    @staticmethod
    def _word_rect(lay: CueLayout, wi: int, pad: float) -> tuple[float, float, float, float] | None:
        xs = [(p.x, p.x + p.w, ln) for ln in lay.lines for p in ln.pieces if p.word == wi]
        if not xs:
            return None
        ln = xs[0][2]
        return (min(a for a, _b, _l in xs) - pad, ln.baseline - lay.ascent - pad, max(b for _a, b, _l in xs) + pad, ln.baseline + lay.descent + pad)

    def overlays(self, k: int) -> list[tuple[int, int, np.ndarray]]:
        out = []
        for cue in self.cues_at(k):
            c = self.cue_canvas(cue, k)
            if c is not None:
                out.append(c)
        return out

    # ---- 燒錄 ----
    def apply(self, fr: Any, k: int) -> Any:
        if not self.cues_at(k):
            return fr
        layers = self.overlays(k)
        if not layers:
            return fr
        y, u, v = fr.y.copy(), fr.u.copy(), fr.v.copy()
        matrix = getattr(fr, "matrix", "bt709") or "bt709"
        rng = getattr(fr, "color_range", "tv") or "tv"
        wrote = False
        for x0, y0, canvas in layers:
            wrote |= blend_rgba_into_yuv(y, u, v, x0, y0, canvas, matrix, rng)
        if not wrote:
            return fr
        return fr.with_planes(y, u, v)

    def rgba_frame(self, k: int) -> np.ndarray:
        """整個畫面大小的直通 alpha RGBA uint8（captions.preview 與決定性測試用）。"""
        full = np.zeros((self.height, self.width, 4), np.float32)
        for x0, y0, canvas in self.overlays(k):
            over(full, canvas, x0, y0)
        a = full[..., 3:4]
        rgb = np.where(a > 0, full[..., :3] / np.maximum(a, 1e-6), 0.0)
        return np.clip(np.rint(np.concatenate([rgb, a], axis=-1) * 255.0), 0, 255).astype(np.uint8)

    def boxes_at(self, k: int) -> list[tuple[int, int, int, int]]:
        return [self.context(c).layout.box for c in self.cues_at(k)]

    def to_json(self) -> dict[str, Any]:
        return {
            "cues": len(self.cues),
            "frames": self.frames,
            "preset": self.track.get("presetId"),
            "language": self.language,
            "font": self.font.to_json(),
            "warnings": list(self.warnings),
        }


def burner_for(track: dict[str, Any] | None, width: int, height: int, fps: tuple[int, int], mode: str = "auto") -> CaptionBurner | None:
    """render 的 --captions auto|on|off：auto = track.enabled；on = 有 track 就燒（不管 enabled）；off = 不燒。"""
    if mode == "off" or not track:
        return None
    if mode == "auto" and not track.get("enabled"):
        return None
    b = CaptionBurner(track, width, height, fps)
    return b if b.cues else None


def iter_visible_frames(burner: CaptionBurner, k0: int, k1: int) -> Iterable[int]:
    for c in burner.cues:
        a, b = max(k0, int(c["startFrame"])), min(k1, int(c["endFrame"]))
        yield from range(a, b)
