"""把規劃好的裁切路徑套到 yuv420 幀上。

## 為什麼這裡只有切片

`path.crop_size()` 保證裁切的 x / y / w / h 全是偶數，所以三個平面都能直接切：
Y 是 `y[y0:y0+h, x0:x0+w]`，U / V 是它的一半。**沒有任何重取樣**，
成品的每個位元組都是來源的原值 —— 換句話說，自動重構圖不會讓畫質變差，
它只是決定要留下哪一塊。這是「固定大小的框」那個設計決策換來的。

偶數為什麼是硬性要求：yuv420 的色度平面是半解析度，一個色度樣本對應 2×2 個亮度樣本。
從奇數位置切等於要求「半個色度樣本」，只能靠重取樣生出來，而那會在每一幀引入
跟裁切位置有關的微小色偏 —— 鏡頭平移時看起來就是顏色在抖。

## 縮放是另一回事

`resize_to` 是選配。不給就輸出裁切尺寸（例如 594×1056），那是零損失的路。
給了（例如要 1080×1920 的成品）就會重取樣一次，三個平面各自縮 —— 那正是 ffmpeg 的
`scale` 濾鏡在 yuv420 上做的事，所以結果與交給 ffmpeg 縮是同一個等級，
只是在這裡做省掉一次濾鏡圖。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Iterable, Iterator

from .path import CropRect, ReframeError

if TYPE_CHECKING:
    from ..media.source import Yuv420


def crop_frame(fr: "Yuv420", rect: CropRect) -> "Yuv420":
    """切一幀。矩形必須全偶數且落在幀內，否則擲 `ReframeError`（這是程式錯誤，不是使用者輸入錯）。"""
    import numpy as np

    from ..media.source import Yuv420

    x0, y0, w, h = rect.x, rect.y, rect.w, rect.h
    if x0 % 2 or y0 % 2 or w % 2 or h % 2:
        raise ReframeError(f"裁切矩形必須全偶數（拿到 {rect}）")
    if x0 < 0 or y0 < 0 or x0 + w > fr.width or y0 + h > fr.height:
        raise ReframeError(f"裁切矩形 {rect} 超出 {fr.width}×{fr.height}")
    if (x0, y0, w, h) == (0, 0, fr.width, fr.height):
        return fr  # 整幀就是目標：不必複製
    cx, cy, cw, ch = x0 // 2, y0 // 2, w // 2, h // 2
    return Yuv420(
        y=np.ascontiguousarray(fr.y[y0 : y0 + h, x0 : x0 + w]),
        u=np.ascontiguousarray(fr.u[cy : cy + ch, cx : cx + cw]),
        v=np.ascontiguousarray(fr.v[cy : cy + ch, cx : cx + cw]),
        src_idx=fr.src_idx, pts_ms=fr.pts_ms, key=fr.key,
        matrix=fr.matrix, color_range=fr.color_range, transfer=fr.transfer, meta=fr.meta,
    )


def resize_frame(fr: "Yuv420", size: tuple[int, int]) -> "Yuv420":
    """縮到指定尺寸（長寬都要偶數）。放大用 Lanczos、縮小用 INTER_AREA（縮小時 area 的摩爾紋最少）。"""
    import cv2
    import numpy as np

    from ..media.source import Yuv420

    w, h = int(size[0]), int(size[1])
    if w % 2 or h % 2 or w < 2 or h < 2:
        raise ReframeError(f"輸出尺寸要是 ≥2 的偶數（拿到 {w}×{h}）")
    if (w, h) == (fr.width, fr.height):
        return fr
    interp = cv2.INTER_AREA if (w < fr.width or h < fr.height) else cv2.INTER_LANCZOS4
    return Yuv420(
        y=np.ascontiguousarray(cv2.resize(fr.y, (w, h), interpolation=interp)),
        u=np.ascontiguousarray(cv2.resize(fr.u, (w // 2, h // 2), interpolation=interp)),
        v=np.ascontiguousarray(cv2.resize(fr.v, (w // 2, h // 2), interpolation=interp)),
        src_idx=fr.src_idx, pts_ms=fr.pts_ms, key=fr.key,
        matrix=fr.matrix, color_range=fr.color_range, transfer=fr.transfer, meta=fr.meta,
    )


def crop_frames(
    frames: Iterable["Yuv420"], rects: list[CropRect], *, resize_to: tuple[int, int] | None = None
) -> Iterator["Yuv420"]:
    """逐幀套用路徑的產生器（render 的管線就是接在這裡）。

    幀比矩形多時**沿用最後一個矩形**而不是報錯：渲染範圍與規劃範圍差一兩幀是常見的
    （取消、trim、VFR 換算），為了差一幀丟掉整支成品不划算。矩形是空的就原樣放行。
    """
    if not rects:
        yield from frames
        return
    last = rects[-1]
    for i, fr in enumerate(frames):
        out = crop_frame(fr, rects[i] if i < len(rects) else last)
        yield resize_frame(out, resize_to) if resize_to else out
