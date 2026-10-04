"""動態模糊（決策 17、§6.6）：沿 H(k-1)→H(k)→H(k+1) 的角點路徑取 n 個 homography 樣本平均。

語意採 Nuke CornerPin2D / BCC：
- 快門角度 shutterAngle（預設 180° ＝ 0.5 幀 ＝ Nuke shutter 0.5）；shutter_frames = angle/360。
- 快門相位 shutterPhase：centered → 視窗 [-sf/2, +sf/2]；start → [0, sf]；end → [-sf, 0]；custom → [offset, offset+sf]。
- 取樣路徑長度 = 角點每幀位移 |d| × shutter_frames。**原稿 n=ceil(|d|) 等於 360° 快門，會把翻牌糊成兩倍**。
- samples auto = clamp(ceil(path / max_step_px), 1, max)；path < deadband(0.7 px) → n=1（單次 warp，不模糊）。
  間距（不是樣本數）才是品質指標：樣本是路徑上的一排 delta，墨邊的高斯 σ≈0.62 px 只能蓋住間距 ≲1 px 的梳齒，
  再寬就變成使用者看得見的「錯開的重影」。舊的 max_samples=9 在 path>9 px 時把間距撐到 1.2–3.6 px（見 params 的說明）。
- 樣本用中點法：t_i = open + (close-open)·(i+0.5)/n，所以 n=1 且 centered 時 t=0 ＝ 沒有模糊，
  結果與關掉動態模糊逐位元相同（這是「auto」能安全退化的原因）。

為什麼插值**角點**而不是矩陣：CornerPin 的關鍵幀就是角點；線性插值角點再重解 H 是所有主流工具的做法，
矩陣元素線性插值在透視項上會產生非物理的彎曲。前後幀缺一邊時用鏡射外推（等速假設）；兩邊都缺＝靜止。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

from .params import MotionBlurParams


def template_corners(w: float, h: float) -> np.ndarray:
    """模板四角（連續座標、TL,TR,BR,BL）。"""
    return np.array([[0.0, 0.0], [w, 0.0], [w, h], [0.0, h]], dtype=np.float64)


def quad_from_H(H: np.ndarray, w: float, h: float) -> np.ndarray:
    """H（模板連續座標→幀連續座標）套到模板四角 → (4,2) 幀座標。"""
    pts = np.hstack([template_corners(w, h), np.ones((4, 1))])
    q = pts @ np.asarray(H, dtype=np.float64).T
    return q[:, :2] / q[:, 2:3]


def H_from_quad(quad: np.ndarray, w: float, h: float) -> np.ndarray:
    """四角 → H（模板連續座標→幀連續座標）。"""
    src = template_corners(w, h).astype(np.float32)
    dst = np.asarray(quad, dtype=np.float32).reshape(4, 2)
    H = cv2.getPerspectiveTransform(src, dst)
    return np.asarray(H, dtype=np.float64)


def shutter_window(p: MotionBlurParams) -> tuple[float, float]:
    """(開, 關) 時刻，單位幀、相對第 k 幀。"""
    sf = p.shutter_frames
    if p.shutter_phase == "centered":
        return -sf / 2.0, sf / 2.0
    if p.shutter_phase == "start":
        return 0.0, sf
    if p.shutter_phase == "end":
        return -sf, 0.0
    return float(p.shutter_offset), float(p.shutter_offset) + sf


def corner_displacement(quad_prev: np.ndarray | None, quad: np.ndarray, quad_next: np.ndarray | None) -> float:
    """每幀角點位移 |d|（px）：四角、可用鄰幀的平均。沒有鄰幀 → 0。"""
    ds: list[float] = []
    if quad_prev is not None:
        ds.append(float(np.linalg.norm(quad - quad_prev, axis=1).mean()))
    if quad_next is not None:
        ds.append(float(np.linalg.norm(quad_next - quad, axis=1).mean()))
    return float(np.mean(ds)) if ds else 0.0


def corner_displacement_max(quad_prev: np.ndarray | None, quad: np.ndarray, quad_next: np.ndarray | None) -> float:
    """動得最快的那個角的每幀位移（px）。`corner_displacement` 是四角平均：牌繞著一角轉時平均只有最快角的 1/2–1/4。"""
    ds: list[float] = []
    if quad_prev is not None:
        ds.append(float(np.linalg.norm(quad - quad_prev, axis=1).max()))
    if quad_next is not None:
        ds.append(float(np.linalg.norm(quad_next - quad, axis=1).max()))
    return float(max(ds)) if ds else 0.0


def auto_samples(displacement_px: float, p: MotionBlurParams, fastest_px: float | None = None) -> int:
    """§6.6：n = clamp(ceil(path / max_step_px), 1, max_samples)；路徑長 < deadband → 1。

    fastest_px：動得最快的點（角／節點）的每幀位移。樣本數只看**平均**位移時，掀牌翹起來的那一端
    （平均 5 px、最快 34 px）樣本間距會拉到 2–3.7 px，點數印成幾個錯開的重影而不是一道模糊
    （2026-09-19 使用者：「拿起牌時點數會有偏移」；clip 125 k17–21、k47–48）。給了就再保證最快點的間距 ≤ 2·max_step_px，
    死區也改看最快點（k17：平均路徑 0.49 px 落在死區 → 完全沒模糊，翹起的角其實走了 5 px）。"""
    if p.enabled is False:
        return 1
    path = displacement_px * p.shutter_frames
    fast = max(float(fastest_px), displacement_px) * p.shutter_frames if fastest_px is not None else path
    if fast < p.deadband_px:
        return 1
    if p.samples != "auto":
        return max(1, int(p.samples))
    step = max(float(p.max_step_px), 1e-3)
    need = max(path / step, fast / (2.0 * step))
    return int(min(max(math.ceil(need - 1e-9), 1), p.max_samples))


def quad_at(quad_prev: np.ndarray | None, quad: np.ndarray, quad_next: np.ndarray | None, t: float) -> np.ndarray:
    """分段線性角點路徑：t∈[-1,0] 在 prev→k，t∈[0,1] 在 k→next；缺邊鏡射外推。"""
    if quad_prev is None and quad_next is None:
        return quad.copy()
    if quad_prev is None:
        quad_prev = quad - (quad_next - quad)  # type: ignore[operator]
    if quad_next is None:
        quad_next = quad + (quad - quad_prev)
    if t <= 0.0:
        return quad + (quad - quad_prev) * t  # t=-1 → prev
    return quad + (quad_next - quad) * t


@dataclass(frozen=True)
class BlurPlan:
    samples: int
    times: tuple[float, ...]  # 每個樣本的時刻（幀）
    quads: tuple[np.ndarray, ...]  # 每個樣本的四角（幀連續座標）
    displacement_px: float
    shutter_frames: float
    path_px: float  # |d|·sf

    @property
    def union_bbox(self) -> tuple[float, float, float, float]:
        allq = np.vstack(self.quads)
        return float(allq[:, 0].min()), float(allq[:, 1].min()), float(allq[:, 0].max()), float(allq[:, 1].max())


def plan_blur(
    H: np.ndarray,
    H_prev: np.ndarray | None,
    H_next: np.ndarray | None,
    tmpl_w: float,
    tmpl_h: float,
    p: MotionBlurParams,
) -> BlurPlan:
    """決定樣本數與每個樣本的四角。回傳的 quads 可直接餵 `H_from_quad` 得到每個樣本的 H。"""
    q = quad_from_H(H, tmpl_w, tmpl_h)
    qp = quad_from_H(H_prev, tmpl_w, tmpl_h) if H_prev is not None else None
    qn = quad_from_H(H_next, tmpl_w, tmpl_h) if H_next is not None else None
    d = corner_displacement(qp, q, qn)
    d_fast = corner_displacement_max(qp, q, qn)
    n = auto_samples(d, p, d_fast)
    if n <= 1:
        # 單樣本：centered 相位、死區內、或關閉 → t=0（與無模糊逐位元相同）；
        # start/end/custom 且超出死區 → 取視窗中點，維持 Nuke 的相位位移語意
        t_open, t_close = shutter_window(p)
        in_deadband = max(d, d_fast) * p.shutter_frames < p.deadband_px
        t = 0.0 if (p.enabled is False or in_deadband or p.shutter_phase == "centered") else (t_open + t_close) / 2.0
        return BlurPlan(1, (t,), (quad_at(qp, q, qn, t),), d, p.shutter_frames, d * p.shutter_frames)
    t_open, t_close = shutter_window(p)
    times = tuple(t_open + (t_close - t_open) * (i + 0.5) / n for i in range(n))
    quads = tuple(quad_at(qp, q, qn, t) for t in times)
    return BlurPlan(n, times, quads, d, p.shutter_frames, d * p.shutter_frames)
