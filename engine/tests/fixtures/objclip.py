"""seg.find／seg.select／objects／fx 測試共用的合成素材（CPU、確定性）。

- `write_clip`：PyAV 現做一支 96×64、20 幀的 libx264 測試片：灰底上一個往右走的白方塊（全程都在）
  與一個從第 8 幀才出現的藍色長方形。`truth(k)` 回每幀的真實遮罩。
- `FakeSession`／`FakePromptBackend`：SAM 2.1 session 的替身 —— 在提示點／框中心取樣顏色，
  之後每幀找「顏色相近、離上一幀最近」的連通塊。夠用來驗 op 的檔案、幀號與合併邏輯，不驗分割品質。
- `fake_detect`：OWLv2 的替身 —— 「white」找白方塊、「blue」找藍長方形，並故意多吐一個重疊的重複框（測去重）。
"""
from __future__ import annotations

from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np

W, H, N = 96, 64, 20
BG = 90
WHITE = (250, 250, 250)
BLUE = (30, 40, 220)
BLUE_FROM = 8


def white_box(k: int) -> tuple[int, int, int, int]:
    x = 10 + 2 * k
    return x, 20, x + 12, 32


BLUE_BOX = (60, 40, 76, 50)


def frame_rgb(k: int) -> np.ndarray:
    img = np.full((H, W, 3), BG, np.uint8)
    x0, y0, x1, y1 = white_box(k)
    img[y0:y1, x0:x1] = WHITE
    if k >= BLUE_FROM:
        x0, y0, x1, y1 = BLUE_BOX
        img[y0:y1, x0:x1] = BLUE
    return img


def truth(k: int, which: str = "white") -> np.ndarray | None:
    m = np.zeros((H, W), bool)
    if which == "white":
        x0, y0, x1, y1 = white_box(k)
    else:
        if k < BLUE_FROM:
            return None
        x0, y0, x1, y1 = BLUE_BOX
    m[y0:y1, x0:x1] = True
    return m


def write_clip(path: Path, n: int = N) -> Path:
    import av

    with av.open(str(path), "w", format="matroska") as c:
        s = c.add_stream("libx264", rate=24)
        s.width, s.height = W, H
        s.pix_fmt = "yuv420p"
        s.time_base = Fraction(1, 24)
        s.codec_context.time_base = Fraction(1, 24)
        s.options = {"bf": "0", "crf": "0", "g": "6", "keyint_min": "6", "sc_threshold": "0"}
        for i in range(n):
            fr = av.VideoFrame.from_ndarray(frame_rgb(i), format="rgb24").reformat(format="yuv420p")
            fr.pts = i
            fr.time_base = Fraction(1, 24)
            for p in s.encode(fr):
                c.mux(p)
        for p in s.encode():
            c.mux(p)
    return path


# ---------------------------------------------------------------- 假分割
def _component(rgb: np.ndarray, color: np.ndarray, near: tuple[float, float] | None) -> np.ndarray:
    import cv2

    close = (np.abs(rgb.astype(np.int16) - color.astype(np.int16)).sum(axis=-1) < 90).astype(np.uint8)
    n, lab = cv2.connectedComponents(close)
    if n <= 1:
        return np.zeros(rgb.shape[:2], bool)
    best, best_d = 0, None
    for i in range(1, n):
        ys, xs = np.nonzero(lab == i)
        if near is None:
            d = -xs.size
        else:
            d = float(np.hypot(xs.mean() - near[0], ys.mean() - near[1]))
        if best_d is None or d < best_d:
            best, best_d = i, d
    return lab == best


class FakeSession:
    def __init__(self, size: tuple[int, int], log: list[Any] | None = None) -> None:
        from aivc.seg.backend import SessionStats

        self.frame_size = size
        self.stats = SessionStats()
        self.color: dict[int, np.ndarray] = {}
        self.last: dict[int, tuple[float, float]] = {}
        self.log = log if log is not None else []

    def add_prompt_frame(self, frame_idx: int, obj_id: int, frame_rgb: np.ndarray, *, points: Any = (), box: Any = None) -> Any:
        from aivc.seg.backend import FrameMasks

        self.log.append(("prompt", int(frame_idx), int(obj_id), [tuple(p) for p in points], None if box is None else tuple(box)))
        if box is not None:
            x, y, w, h = box
            cx, cy = x + w / 2.0, y + h / 2.0
        else:
            pos = [(x, y) for x, y, lb in points if lb == 1] or [(x, y) for x, y, _ in points]
            cx, cy = pos[0]
        c = frame_rgb[min(int(cy), self.frame_size[1] - 1), min(int(cx), self.frame_size[0] - 1)]
        self.color[obj_id] = c.astype(np.int16)
        m = _component(frame_rgb, self.color[obj_id], (cx, cy))
        if m.any():
            ys, xs = np.nonzero(m)
            self.last[obj_id] = (float(xs.mean()), float(ys.mean()))
        return FrameMasks(int(frame_idx), {obj_id: m}, {obj_id: 1.0 if m.any() else -1.0})

    def add_prompt(self, frame_idx: int, obj_id: int, frame_rgb: np.ndarray, *, points: Any = (), box: Any = None) -> np.ndarray:
        return self.add_prompt_frame(frame_idx, obj_id, frame_rgb, points=points, box=box).masks[obj_id]

    def propagate_frames(self, frames: Any, direction: str) -> Any:
        from aivc.seg.backend import FrameMasks

        for k, rgb in frames:
            self.log.append(("frame", int(k), direction))
            masks, scores = {}, {}
            for oid, c in self.color.items():
                m = _component(rgb, c, self.last.get(oid))
                masks[oid] = m
                scores[oid] = 1.0 if m.any() else -5.0
                if m.any():
                    ys, xs = np.nonzero(m)
                    self.last[oid] = (float(xs.mean()), float(ys.mean()))
            yield FrameMasks(int(k), masks, scores)

    def close(self) -> None:
        self.log.append(("close",))


class FakePromptBackend:
    name = "fake"

    def __init__(self, log: list[Any] | None = None) -> None:
        self.log = log if log is not None else []

    def loaded(self) -> Any:
        from types import SimpleNamespace

        return SimpleNamespace(model_id="fake/sam", variant="small", load_seconds=0.0, preprocess_on_device=False)

    def open_session(self, size: tuple[int, int]) -> FakeSession:
        return FakeSession(size, self.log)

    def unload(self) -> None:
        pass


def fake_detect(image_rgb: np.ndarray, text: str, **_kw: Any) -> list[Any]:
    """OWLv2 替身：回 TextBox（含一個故意重疊的低分重複框）。"""
    from aivc.seg.text_box import TextBox, parse_phrases

    out = []
    for ph in parse_phrases(text):
        color = np.array(WHITE if "white" in ph else BLUE if "blue" in ph else (-999, -999, -999))
        m = (np.abs(image_rgb.astype(np.int16) - color).sum(axis=-1) < 90)
        if not m.any():
            continue
        ys, xs = np.nonzero(m)
        x0, y0, x1, y1 = float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)
        score = 0.8 if "white" in ph else 0.6
        out.append(TextBox((x0, y0, x1 - x0, y1 - y0), ph, score))
        out.append(TextBox((x0 + 1, y0 + 1, x1 - x0 - 2, y1 - y0 - 1), ph, score * 0.5))  # 重複框
    return out
