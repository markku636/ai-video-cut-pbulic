"""提示（prompt）轉換與 CLI 解析：使用者的 --box / --point / --quad 字串 ↔ 候選 / SAM 提示。

使用者手動給的框／四角在這裡變成與偵測器相同形狀的 `Candidate`（外掛的偵測器也產生同一種）；
seg/ 拿 `box_prompt()` 的 [x0,y0,x1,y1] 當 SAM2 的 box prompt。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .candidate import KIND_FACE_UP, Candidate, order_quad, quad_area, quad_is_convex


@dataclass
class UserPrompts:
    """使用者手動給的提示；三種可以同時存在（例如一個框加兩個減選點）。"""

    boxes: list[tuple[float, float, float, float]] = field(default_factory=list)  # x, y, w, h
    quads: list[list[list[float]]] = field(default_factory=list)  # TL,TR,BR,BL
    points: list[tuple[float, float, int]] = field(default_factory=list)  # x, y, label(1 加選 / 0 減選)

    def is_empty(self) -> bool:
        return not (self.boxes or self.quads or self.points)


def _floats(s: str, n: int | None, what: str) -> list[float]:
    parts = [p for p in s.replace(";", ",").split(",") if p.strip()]
    try:
        vals = [float(p) for p in parts]
    except ValueError as e:
        raise ValueError(f"{what} 要是逗號分隔的數字：{s!r}") from e
    if n is not None and len(vals) != n:
        raise ValueError(f"{what} 需要 {n} 個數字，收到 {len(vals)}：{s!r}")
    if not all(np.isfinite(vals)):
        raise ValueError(f"{what} 含非有限數：{s!r}")
    return vals


def parse_box(s: str) -> tuple[float, float, float, float]:
    """`x,y,w,h`（w、h 必須 > 0）。"""
    x, y, w, h = _floats(s, 4, "--box")
    if w <= 0 or h <= 0:
        raise ValueError(f"--box 的 w/h 必須 > 0：{s!r}")
    return x, y, w, h


def parse_quad(s: str) -> list[list[float]]:
    """`x1,y1,x2,y2,x3,y3,x4,y4`（任意順序，會整理成 TL,TR,BR,BL；必須是凸四邊形）。"""
    v = _floats(s, 8, "--quad")
    pts = np.asarray(v, dtype=np.float64).reshape(4, 2)
    if not quad_is_convex(pts):
        raise ValueError(f"--quad 不是凸四邊形：{s!r}")
    return [[float(x), float(y)] for x, y in order_quad(pts)]


def parse_point(s: str) -> tuple[float, float, int]:
    """`x,y[,label]`；label 省略＝1（加選）。"""
    v = _floats(s, None, "--point")
    if len(v) not in (2, 3):
        raise ValueError(f"--point 需要 x,y[,label]：{s!r}")
    label = int(v[2]) if len(v) == 3 else 1
    if label not in (0, 1):
        raise ValueError(f"--point 的 label 只能是 0 或 1：{s!r}")
    return v[0], v[1], label


def parse_prompts(boxes: list[str] | None, points: list[str] | None, quads: list[str] | None) -> UserPrompts:
    up = UserPrompts()
    for b in boxes or []:
        up.boxes.append(parse_box(b))
    for q in quads or []:
        up.quads.append(parse_quad(q))
    for pt in points or []:
        up.points.append(parse_point(pt))
    return up


def box_to_quad(box: tuple[float, float, float, float]) -> list[list[float]]:
    x, y, w, h = box
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]


def candidates_from_prompts(prompts: UserPrompts, frame_size: tuple[int, int] | None = None) -> list[Candidate]:
    """框與四角各變成一個 faceUp 候選（score 1.0，使用者給的就是真理）；點不會變候選（要 SAM 才有形狀）。"""
    out: list[Candidate] = []
    for b in prompts.boxes:
        out.append(_cand(box_to_quad(b), frame_size))
    for q in prompts.quads:
        out.append(_cand(q, frame_size))
    return out


def _cand(quad: list[list[float]], frame_size: tuple[int, int] | None) -> Candidate:
    q = np.asarray(quad, dtype=np.float64)
    if frame_size is not None:
        w, h = frame_size
        q[:, 0] = np.clip(q[:, 0], 0, w)
        q[:, 1] = np.clip(q[:, 1], 0, h)
    xs, ys = q[:, 0], q[:, 1]
    x0, y0, x1, y1 = int(np.floor(xs.min())), int(np.floor(ys.min())), int(np.ceil(xs.max())), int(np.ceil(ys.max()))
    return Candidate(
        quad=[[float(x), float(y)] for x, y in q],
        kind=KIND_FACE_UP,
        area=quad_area(q),
        fill_ratio=1.0,
        score=1.0,
        bbox=(x0, y0, x1 - x0, y1 - y0),
        center=(float(xs.mean()), float(ys.mean())),
    )


def box_prompt(c: Candidate, *, pad_frac: float = 0.05, frame_size: tuple[int, int] | None = None) -> list[float]:
    """候選 → SAM2 box prompt [x0, y0, x1, y1]（外接框外擴 pad_frac，讓圓角與軟邊也進去）。"""
    q = np.asarray(c.quad, dtype=np.float64)
    x0, y0 = q.min(axis=0)
    x1, y1 = q.max(axis=0)
    pw, ph = (x1 - x0) * pad_frac, (y1 - y0) * pad_frac
    x0, y0, x1, y1 = x0 - pw, y0 - ph, x1 + pw, y1 + ph
    if frame_size is not None:
        w, h = frame_size
        x0, x1 = max(0.0, x0), min(float(w), x1)
        y0, y1 = max(0.0, y0), min(float(h), y1)
    return [float(x0), float(y0), float(x1), float(y1)]
