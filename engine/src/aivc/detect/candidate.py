"""偵測／提示的共用形狀：`Candidate`（一個四邊形候選）與四邊形小工具。

從牌局偵測器（現在在外掛 `aivc_cards.detect.white_quad`）拆出來的中性部分：使用者的 --box／--quad 提示（`prompts.py`）
與外掛的偵測器都產生同一種 `Candidate`，seg 與專案建立只認它。kind 是自由字串：核心只用 `KIND_FACE_UP`
（「看得到、要處理的平面」），外掛可以有自己的種類。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np

KIND_FACE_UP = "faceUp"


@dataclass
class Candidate:
    quad: list[list[float]]  # TL,TR,BR,BL；來源像素
    kind: str  # KIND_FACE_UP，或外掛自己的種類
    area: float  # 四邊形面積（px²）
    fill_ratio: float  # 白色像素 / 四邊形面積（偵測器量的；使用者給的是 1.0）
    score: float  # 0..1，粗略信心（幾何合格度）
    landscape: bool = False  # 相對多數候選旋轉 90°
    bbox: tuple[int, int, int, int] = (0, 0, 0, 0)
    center: tuple[float, float] = (0.0, 0.0)
    n_vertices: int = 4  # approxPolyDP 的頂點數（4 = 直接接受；>4 = minAreaRect 退路）

    @property
    def aspect(self) -> float:
        """長邊 / 短邊（用四邊形邊長平均，不受旋轉影響）。"""
        q = np.asarray(self.quad, dtype=np.float64)
        e = [float(np.linalg.norm(q[(i + 1) % 4] - q[i])) for i in range(4)]
        a = (e[0] + e[2]) / 2.0
        b = (e[1] + e[3]) / 2.0
        lo, hi = min(a, b), max(a, b)
        return hi / lo if lo > 1e-6 else float("inf")

    @property
    def image_aspect(self) -> float:
        """畫面上的寬/高（TL→TR 邊長 / TR→BR 邊長）；用來判斷橫放。"""
        q = np.asarray(self.quad, dtype=np.float64)
        w = (np.linalg.norm(q[1] - q[0]) + np.linalg.norm(q[2] - q[3])) / 2.0
        h = (np.linalg.norm(q[2] - q[1]) + np.linalg.norm(q[3] - q[0])) / 2.0
        return float(w / h) if h > 1e-6 else float("inf")

    def to_json(self) -> dict:
        return {
            "quad": [[round(float(x), 2), round(float(y), 2)] for x, y in self.quad],
            "kind": self.kind,
            "area": round(self.area, 1),
            "fillRatio": round(self.fill_ratio, 3),
            "score": round(self.score, 3),
            "landscape": self.landscape,
            "bbox": list(self.bbox),
            "center": [round(self.center[0], 2), round(self.center[1], 2)],
        }


def order_quad(pts: Sequence[Sequence[float]] | np.ndarray) -> np.ndarray:
    """任意順序的 4 點 → TL,TR,BR,BL（畫面座標 y 向下，順時針）。

    做法：以質心為中心依角度排序（畫面座標下角度遞增＝順時針），再旋轉讓起點是 x+y 最小的那個（左上）。
    """
    q = np.asarray(pts, dtype=np.float64).reshape(4, 2)
    c = q.mean(axis=0)
    ang = np.arctan2(q[:, 1] - c[1], q[:, 0] - c[0])
    q = q[np.argsort(ang)]
    start = int(np.argmin(q.sum(axis=1)))
    return np.roll(q, -start, axis=0)


def quad_is_convex(pts: Sequence[Sequence[float]] | np.ndarray, *, strict: bool = True) -> bool:
    """4 點是否為（非退化）凸四邊形：所有相鄰邊叉積同號且不為零。"""
    q = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
    if q.shape[0] != 4 or not np.all(np.isfinite(q)):
        return False
    sign = 0
    for i in range(4):
        a = q[(i + 1) % 4] - q[i]
        b = q[(i + 2) % 4] - q[(i + 1) % 4]
        cross = a[0] * b[1] - a[1] * b[0]
        if abs(cross) < 1e-9:
            if strict:
                return False
            continue
        s = 1 if cross > 0 else -1
        if sign == 0:
            sign = s
        elif s != sign:
            return False
    return sign != 0


def quad_area(pts: Sequence[Sequence[float]] | np.ndarray) -> float:
    q = np.asarray(pts, dtype=np.float64).reshape(4, 2)
    x, y = q[:, 0], q[:, 1]
    return float(abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2.0)
