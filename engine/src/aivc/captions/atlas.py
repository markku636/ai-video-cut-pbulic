"""舞台預覽用的版面 + 精靈圖集（captions.layout；研究規格 §5.1 layout.v1.json）。

為什麼預覽不在 TS 自己畫字：Canvas 2D 的字型度量、描邊、陰影跟 Pillow 不一樣，斷行位置會差一兩個字 ——
使用者在舞台上看到的字幕要跟燒進成品的一模一樣。所以版面只在引擎算一次，精靈（每個詞 × future/active/past 顏色）
也由引擎點陣化成一張 PNG，TS 只做「依 anim.ts 的縮放／透明度把精靈貼上去」。

檔案：`<cache>/media/<fp16>/captions/<layoutKey>/layout.v1.json` + `atlas.v1.png`（直通 alpha）。
每個詞的 `sprites`：
- `future`/`active`/`past`：完整精靈（陰影＋描邊＋字面，已套強調色規則）—— 單趟逐詞貼上就能用。
- `under`（陰影＋描邊，跟顏色無關）＋ `fill.{future,active,past}`（只有字面）：想跟燒錄**逐像素一致**時用兩趟：
  整則所有詞的 under 先畫、再畫字面（粗描邊才不會蓋到隔壁詞的字；單趟時後面的詞的描邊會壓到前一個詞）。
精靈矩形 `[sx, sy, sw, sh, ox, oy]`：全部是圖集像素（字級 × supersample）；ox/oy 是精靈左上角相對於筆位（左、基線）的位移。
TS 繪製（k = s / supersample，s = 動畫縮放）：`drawImage(atlas, sx, sy, sw, sh, penX + ox·k, baselineY + oy·k, sw·k, sh·k)`。
跳字（word = pop）：放大的詞以詞中心放大，同一行其他詞依「放大後寬度 + 原詞距」重排、整行中心不變；
垂直以文字中心為樞紐：baselineY = cy + (baseline − cy)·s，cy = baseline − (ascent − descent)/2。
卡拉OK 擦色：active 詞在 x < penX + p·(w·s) 畫 active 字面、其餘畫 future 字面（p = anim 的 progress）。
`chars`（打字機）是每個前綴的前進量（1× 像素）。
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

import numpy as np

from . import anim as A
from .burn import CaptionBurner, pick_color

ATLAS_W = 2048
ATLAS_MAX_H = 8192
# 2（2026-09-17）：行尾 。，、 不顯示、換行量寬不算它們 —— 舊的 layout.v1.json／atlas 精靈還帶著句號，快取鍵要換
LAYOUT_CODE_VERSION = 2


def layout_key(track: dict[str, Any], width: int, height: int, fps: tuple[int, int], k0: int, k1: int, font: dict[str, Any], supersample: float) -> str:
    cues = [c for c in track.get("cues") or [] if int(c["endFrame"]) > k0 and int(c["startFrame"]) < k1]
    blob = json.dumps(
        {"v": LAYOUT_CODE_VERSION, "size": [width, height], "fps": list(fps), "range": [k0, k1], "preset": track.get("presetId"), "style": track.get("style"), "seg": track.get("segmentation"), "lang": track.get("language"), "cues": cues, "font": font, "ss": supersample},
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
    )
    return hashlib.sha1(blob.encode("utf-8")).hexdigest()[:16]


class _Shelf:
    def __init__(self, width: int) -> None:
        self.width = width
        self.x = 0
        self.y = 0
        self.row_h = 0
        self.height = 0

    def place(self, w: int, h: int) -> tuple[int, int] | None:
        if w > self.width:
            return None
        if self.x + w > self.width:
            self.y += self.row_h + 1
            self.x, self.row_h = 0, 0
        if self.y + h > ATLAS_MAX_H:
            return None
        pos = (self.x, self.y)
        self.x += w + 1
        self.row_h = max(self.row_h, h)
        self.height = max(self.height, self.y + h)
        return pos


def build_layout(burner: CaptionBurner, k0: int, k1: int) -> tuple[dict[str, Any], np.ndarray]:
    """回傳 (layout JSON, 圖集 RGBA uint8 直通 alpha)。"""
    from .raster import Rasterizer

    cues = [c for c in burner.cues if int(c["endFrame"]) > k0 and int(c["startFrame"]) < k1]
    ss = 1.25
    shelf = _Shelf(ATLAS_W)
    placed: list[tuple[int, int, np.ndarray]] = []
    sprite_index: dict[tuple, list[int]] = {}
    out_cues = []
    warnings = list(burner.warnings)
    full = False
    ss_rasters: dict[int, Rasterizer] = {}
    for cue in cues:
        cc = burner.context(cue)
        lay, st = cc.layout, cc.style
        colors = st.get("colors") or {}
        # 圖集精靈用 ss 倍字級點陣化：跳字放大到 1.15×1.1 時預覽仍清楚
        key = id(cc.raster)
        rs = ss_rasters.get(key)
        if rs is None:
            rs = Rasterizer(burner.font, cc.raster.font_px * ss, st, supersample=burner.supersample)
            ss_rasters[key] = rs
        lines_json = []
        for ln in lay.lines:
            words_json = []
            for p in ln.pieces:
                w = (cue.get("words") or [])[p.word]
                emph = bool(w.get("emphasis"))
                sprites: dict[str, Any] = {}
                fills: dict[str, list[int]] = {}
                wanted = [(st, "all") for st in (A.FUTURE, A.ACTIVE, A.PAST)] + [("under", "under")] + [(st, "fill") for st in (A.FUTURE, A.ACTIVE, A.PAST)]
                for state, layer in wanted:
                    color = "" if layer == "under" else pick_color(colors, state, emph)
                    sk = (id(rs), p.text, color, round(lay.scale * p.static_scale, 4), layer)
                    rect = sprite_index.get(sk)
                    if rect is None and not full:
                        spr = rs.sprite(p.text, color, lay.scale * p.static_scale, layer)
                        h, wd = spr.rgba.shape[:2]
                        pos = shelf.place(wd, h)
                        if pos is None:
                            full = True
                            warnings.append({"kind": "atlasFull", "cueId": cue.get("id")})
                        else:
                            placed.append((pos[0], pos[1], spr.rgba))
                            # 全部用圖集像素（ss 倍字級）；TS 除以 supersample 回到 1×，不在這裡四捨五入丟精度
                            rect = [pos[0], pos[1], wd, h, spr.ox, spr.oy]
                            sprite_index[sk] = rect
                    if rect is not None:
                        (fills if layer == "fill" else sprites)[state] = rect
                if fills:
                    sprites["fill"] = fills
                wj: dict[str, Any] = {"i": p.word, "x": round(p.x, 2), "w": round(p.w, 2), "sprites": sprites}
                if p.char_offset:
                    wj["c"] = p.char_offset
                if emph:
                    wj["emphasis"] = True
                if (st.get("animation") or {}).get("word") == "typewriter":
                    f = rs.font(lay.scale * p.static_scale)
                    wj["chars"] = [round(float(f.getlength(p.text[: n + 1])) / ss, 2) for n in range(len(p.text))]
                words_json.append(wj)
            lines_json.append({"y": round(ln.top, 2), "h": round(ln.height, 2), "baseline": round(ln.baseline, 2), "x": round(ln.left, 2), "w": round(ln.width, 2), "words": words_json})
        cj: dict[str, Any] = {
            "id": cue.get("id"), "start": lay.start, "end": lay.end, "box": list(lay.box), "center": [round(lay.center[0], 2), round(lay.center[1], 2)],
            "fontPx": round(lay.font_px, 3), "ascent": round(lay.ascent, 2), "descent": round(lay.descent, 2), "lines": lines_json,
        }
        if st is not burner.track_style:
            cj["style"] = st
        if lay.overflow:
            cj["overflow"] = True
        out_cues.append(cj)
    h = max(1, shelf.height)
    atlas = np.zeros((h, ATLAS_W, 4), np.float32)
    for x, y, rgba in placed:
        hh, ww = rgba.shape[:2]
        atlas[y : y + hh, x : x + ww] = rgba
    a = atlas[..., 3:4]
    rgb = np.where(a > 0, atlas[..., :3] / np.maximum(a, 1e-6), 0.0)
    atlas8 = np.clip(np.rint(np.concatenate([rgb, a], axis=-1) * 255.0), 0, 255).astype(np.uint8)
    doc = {
        "version": 1,
        "size": [burner.width, burner.height],
        "fps": {"num": burner.fps[0], "den": burner.fps[1]},
        "range": [k0, k1],
        "font": burner.font.to_json(),
        "atlas": {"path": "atlas.v1.png", "w": ATLAS_W, "h": h, "supersample": ss},
        "style": burner.track_style,
        "cues": out_cues,
        "warnings": warnings,
    }
    return doc, atlas8
