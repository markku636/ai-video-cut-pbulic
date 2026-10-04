"""疊色預覽 PNG（CLI 產出、E0 目測用；App 端有自己的 MaskLayer）。"""
from __future__ import annotations

import os
from collections.abc import Mapping
from pathlib import Path

import numpy as np

# 物件配色（RGB），依 obj_id 取模；避開桌布藍與紙白。
PALETTE: tuple[tuple[int, int, int], ...] = (
    (255, 80, 80),
    (80, 220, 80),
    (255, 200, 40),
    (220, 80, 220),
    (60, 220, 220),
    (255, 140, 40),
    (160, 120, 255),
    (120, 255, 180),
)


def color_for(obj_id: int) -> tuple[int, int, int]:
    return PALETTE[(int(obj_id) - 1) % len(PALETTE)]


def overlay(
    rgb: np.ndarray,
    masks: Mapping[int, np.ndarray],
    boxes: Mapping[int, tuple[float, float, float, float]] | None = None,
    alpha: float = 0.45,
    title: str | None = None,
) -> np.ndarray:
    """回傳疊好色的 RGB8 影像（不改輸入）。遮罩填色 + 輪廓線；boxes 畫細框。"""
    import cv2

    out = rgb.astype(np.float32).copy()
    for obj_id, m in masks.items():
        if m is None or not m.any():
            continue
        c = np.array(color_for(obj_id), np.float32)
        sel = m.astype(bool)
        out[sel] = out[sel] * (1 - alpha) + c * alpha
    out8 = out.clip(0, 255).astype(np.uint8)
    for obj_id, m in masks.items():
        if m is None or not m.any():
            continue
        contours, _ = cv2.findContours(m.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(out8, contours, -1, color_for(obj_id), 1, lineType=cv2.LINE_AA)
    if boxes:
        for obj_id, (x, y, w, h) in boxes.items():
            cv2.rectangle(out8, (int(round(x)), int(round(y))), (int(round(x + w)), int(round(y + h))), color_for(obj_id), 1)
            cv2.putText(out8, str(obj_id), (int(x), max(12, int(y) - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, color_for(obj_id), 1, cv2.LINE_AA)
    if title:
        cv2.putText(out8, title, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2, cv2.LINE_AA)
    return out8


def save_png(path: str | os.PathLike[str], rgb: np.ndarray) -> str:
    """cv2.imwrite 對非 ASCII 路徑（Windows）會安靜失敗，改用 imencode + 一般檔案寫入。"""
    import cv2

    from .. import atomic

    p = Path(path)
    ok, buf = cv2.imencode(".png", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    if not ok:
        raise RuntimeError(f"PNG 編碼失敗：{p}")
    atomic.write_bytes(p, buf.tobytes())  # 暫存檔 + os.replace：讀的人不會看到寫一半的 PNG
    return str(p)


def save_mask_png(path: str | os.PathLike[str], mask: np.ndarray) -> str:
    """bool 遮罩存成 0/255 灰階 PNG（golden fixture 用）。"""
    import cv2

    from .. import atomic

    p = Path(path)
    ok, buf = cv2.imencode(".png", (mask.astype(np.uint8) * 255))
    if not ok:
        raise RuntimeError(f"PNG 編碼失敗：{p}")
    atomic.write_bytes(p, buf.tobytes())
    return str(p)


def load_mask_png(path: str | os.PathLike[str]) -> np.ndarray:
    import cv2

    data = np.fromfile(os.fspath(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise RuntimeError(f"讀不到 PNG：{path}")
    return img > 127
