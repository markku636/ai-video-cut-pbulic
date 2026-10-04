"""附帶交付（計畫 §17.5）：`render --emit-matte DIR`（遮擋／插入 alpha PNG 序列）與 `--emit-faces DIR`（矯正後的表面）。

佈局：`<DIR>/<trackId>/<k:06d>.png`。alpha 是合成器最終用的 alpha（cover × occl × opacity × applyMix），
8-bit 灰階；「hold」的幀寫全黑（有檔比缺檔好對序列）；定格（同一來源幀重複多個 proxy k）的每個 k 也都有檔（`copy_frame`）。
牌面是 rgb8、模板尺寸（或呼叫端指定）。
PNG 用 cv2.imencode + 暫存檔 tofile + os.replace 而不是 imwrite：Windows 上 imwrite 吃不下非 ASCII 路徑。
"""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np


def frame_png_path(root: str | os.PathLike[str], track_id: str, k: int) -> Path:
    from ..project.paths import safe_component

    return Path(root) / safe_component(track_id) / f"{int(k):06d}.png"


def _write_png(path: Path, img: np.ndarray) -> Path:
    import cv2

    from .. import atomic

    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise OSError(f"PNG 編碼失敗：{path}")
    with atomic.atomic_path(path) as tmp:  # 讀的人不會看到寫一半的 PNG
        buf.tofile(str(tmp))
    return path


def write_matte(root: str | os.PathLike[str], track_id: str, k: int, alpha: np.ndarray | None, size_wh: tuple[int, int]) -> Path:
    """alpha (H,W) float 0..1 或 None（hold → 全黑）→ 8-bit 灰階 PNG。"""
    W, H = size_wh
    if alpha is None:
        a8 = np.zeros((H, W), dtype=np.uint8)
    else:
        a8 = np.clip(np.floor(np.asarray(alpha, dtype=np.float32) * 255.0 + 0.5), 0, 255).astype(np.uint8)
    return _write_png(frame_png_path(root, track_id, k), a8)


def write_face(root: str | os.PathLike[str], track_id: str, k: int, rgb8: np.ndarray) -> Path:
    """矯正後的表面 rgb8 (h,w,3) → PNG（cv2 要 BGR）。"""
    import cv2

    return _write_png(frame_png_path(root, track_id, k), cv2.cvtColor(np.ascontiguousarray(rgb8), cv2.COLOR_RGB2BGR))


def copy_frame(src_png: str | os.PathLike[str], root: str | os.PathLike[str], track_id: str, k: int) -> Path:
    """把已寫好的某幀 PNG 複製成第 k 幀。

    為什麼需要：render 對「同一來源幀對到多個 proxy k（定格）」只合成一次、重送同一份結果，
    但序列是依 proxy k 編號的（export-track 也對齊 proxy k），重複的 k 不補檔 Nuke/AE 讀序列就會缺幀或錯位。
    輸出影片那幾幀本來就是同一份合成結果，所以直接複製位元組（不重編 PNG）即與影片一致。"""
    import shutil

    dst = frame_png_path(root, track_id, k)
    src = Path(src_png)
    if src.resolve() == dst.resolve():
        return dst
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, dst)
    return dst
