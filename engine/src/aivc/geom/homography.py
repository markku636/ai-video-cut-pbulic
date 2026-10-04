"""單應性小工具：正規化、合成、反轉、換尺度、套用到點、退化檢查（計畫 §6.4 步驟 3、決策 13）。

為什麼自己寫而不用 cv2.perspectiveTransform 到處呼叫：這裡的函式全部是純 numpy、
可以在沒有影像的單元測試裡精確驗證（例如 `S·H·S⁻¹` 必須是解析等式，不是數值近似）。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

Array = np.ndarray


def normalize(H: Array) -> Array:
    """h22 → 1。h22 ≈ 0 代表模板原點被送到無窮遠，直接視為無效。"""
    H = np.asarray(H, dtype=np.float64)
    if H.shape != (3, 3):
        raise ValueError(f"H 必須是 3×3，收到 {H.shape}")
    d = H[2, 2]
    if not np.isfinite(d) or abs(d) < 1e-12:
        raise ValueError("h22 ≈ 0：單應性無法正規化")
    return H / d


def compose(*Hs: Array) -> Array:
    """`compose(A, B, C)` = A·B·C：先套 C、再 B、最後 A（矩陣乘法順序）。"""
    out = np.eye(3, dtype=np.float64)
    for H in Hs:
        out = out @ np.asarray(H, dtype=np.float64)
    return normalize(out)


def invert(H: Array) -> Array:
    return normalize(np.linalg.inv(np.asarray(H, dtype=np.float64)))


def scale_matrix(sx: float, sy: float | None = None) -> Array:
    return np.diag([float(sx), float(sx if sy is None else sy), 1.0])


def translation_matrix(dx: float, dy: float) -> Array:
    T = np.eye(3, dtype=np.float64)
    T[0, 2] = dx
    T[1, 2] = dy
    return T


def scale_space(H: Array, s: float) -> Array:
    """同一個空間整體放大 s 倍（例如遠景 2× ROI 追蹤）：H' = S·H·S⁻¹。

    來源與目的都乘 s，所以只有平移項會放大、投影列會縮小；縮回時 `scale_space(H', 1/s)` 解析還原。
    """
    S = scale_matrix(s)
    return normalize(S @ np.asarray(H, dtype=np.float64) @ np.linalg.inv(S))


def rescale(H: Array, s_src: float = 1.0, s_dst: float = 1.0) -> Array:
    """來源（模板）空間縮 s_src、目的（幀）空間縮 s_dst 之後的 H：diag(s_dst)·H·diag(1/s_src)。

    追蹤器內部在「工作尺度模板 → 放大 ROI」解，最後要換回「原生模板 → 原生幀」就靠這個。
    """
    return normalize(scale_matrix(s_dst) @ np.asarray(H, dtype=np.float64) @ scale_matrix(1.0 / s_src))


def shift_dst(H: Array, dx: float, dy: float) -> Array:
    """目的空間平移（ROI 座標 ↔ 幀座標）。"""
    return normalize(translation_matrix(dx, dy) @ np.asarray(H, dtype=np.float64))


def apply(H: Array, pts: Array) -> Array:
    """把 (N,2) 點套上 H。w ≤ 0 的點會回傳 ±inf/nan，由 `sane()` 擋，不在這裡擲錯。"""
    P = np.asarray(pts, dtype=np.float64).reshape(-1, 2)
    hom = np.concatenate([P, np.ones((P.shape[0], 1))], axis=1) @ np.asarray(H, dtype=np.float64).T
    with np.errstate(divide="ignore", invalid="ignore"):
        return hom[:, :2] / hom[:, 2:3]


# ---------------------------------------------------------------------------
# 半像素慣例（整個引擎對外的座標定義）
#
# 對外（solve.v1.json、專案檔 quad、Nuke/AE 匯出、canvas）一律用「邊界慣例」：像素 i 佔 [i, i+1)，
# 所以模板的物理四角就是 (0,0),(w,0),(w,h),(0,h)，遮罩第一個填滿的像素欄 100 的左緣在 x=100.0。
# OpenCV（SIFT keypoint、findTransformECC、warpPerspective、findContours）用「中心慣例」：像素 i 的中心在 i。
# 兩者差剛好 0.5 px：x_edge = x_center + 0.5。H 在兩個慣例間是精確的共軛：H_edge = T(½)·H_cv·T(−½)。
# 只在呼叫 cv2 的那一行轉換，其他地方一律邊界慣例——否則角點會系統性偏半像素，合成器貼牌就露白邊。
# ---------------------------------------------------------------------------
HALF_PIXEL = 0.5


def edge_to_cv(H_edge: Array) -> Array:
    """邊界慣例 H → OpenCV 中心慣例 H（拿去餵 warpPerspective / findTransformECC 的 warp）。"""
    return normalize(translation_matrix(-HALF_PIXEL, -HALF_PIXEL) @ np.asarray(H_edge, dtype=np.float64) @ translation_matrix(HALF_PIXEL, HALF_PIXEL))


def cv_to_edge(H_cv: Array) -> Array:
    """OpenCV 中心慣例 H（ECC 吐出來的）→ 邊界慣例 H。"""
    return normalize(translation_matrix(HALF_PIXEL, HALF_PIXEL) @ np.asarray(H_cv, dtype=np.float64) @ translation_matrix(-HALF_PIXEL, -HALF_PIXEL))


def template_corners(w: float, h: float) -> Array:
    """模板物理四角 TL,TR,BR,BL（邊界慣例）：(0,0),(w,0),(w,h),(0,h)。"""
    return np.array([[0.0, 0.0], [float(w), 0.0], [float(w), float(h)], [0.0, float(h)]], dtype=np.float64)


def homography_from_points(src: Array, dst: Array) -> Array:
    """4 對點的精確 DLT（float64 8×8 線性解）。不用 cv2.getPerspectiveTransform：它只吃 float32，
    在 1000 px 座標上會丟 1e-4 px，讓「解析換尺度精確」這類測試變成近似。"""
    S = np.asarray(src, dtype=np.float64).reshape(4, 2)
    D = np.asarray(dst, dtype=np.float64).reshape(4, 2)
    A = np.zeros((8, 8), dtype=np.float64)
    b = np.zeros(8, dtype=np.float64)
    for i in range(4):
        x, y = S[i]
        u, v = D[i]
        A[2 * i] = [x, y, 1, 0, 0, 0, -u * x, -u * y]
        A[2 * i + 1] = [0, 0, 0, x, y, 1, -v * x, -v * y]
        b[2 * i] = u
        b[2 * i + 1] = v
    try:
        h = np.linalg.solve(A, b)
    except np.linalg.LinAlgError as e:
        raise ValueError("四點退化（共線或重合），無法求單應性") from e
    return np.append(h, 1.0).reshape(3, 3)


def template_to_quad(template_wh: tuple[float, float], quad: Array) -> Array:
    """模板四角 → 影像四角 的單應性（邊界慣例、float64 精確）。"""
    w, h = template_wh
    return homography_from_points(template_corners(w, h), quad)


def quad_from_h(H: Array, template_wh: tuple[float, float]) -> Array:
    return apply(H, template_corners(*template_wh))


def signed_area(quad: Array) -> float:
    q = np.asarray(quad, dtype=np.float64).reshape(-1, 2)
    x, y = q[:, 0], q[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(np.roll(x, -1), y))


def quad_area(quad: Array) -> float:
    return abs(signed_area(quad))


def is_convex(quad: Array) -> bool:
    """四個相鄰邊的叉積同號且都不為 0（退化成線或自交都算不凸）。"""
    q = np.asarray(quad, dtype=np.float64).reshape(4, 2)
    if not np.all(np.isfinite(q)):
        return False
    e = np.roll(q, -1, axis=0) - q
    cross = e[:, 0] * np.roll(e, -1, axis=0)[:, 1] - e[:, 1] * np.roll(e, -1, axis=0)[:, 0]
    return bool(np.all(cross > 1e-9) or np.all(cross < -1e-9))


def long_side(quad: Array) -> float:
    q = np.asarray(quad, dtype=np.float64).reshape(4, 2)
    return float(np.max(np.linalg.norm(np.roll(q, -1, axis=0) - q, axis=1)))


def max_corner_jump(quad_a: Array, quad_b: Array) -> float:
    a = np.asarray(quad_a, dtype=np.float64).reshape(4, 2)
    b = np.asarray(quad_b, dtype=np.float64).reshape(4, 2)
    return float(np.max(np.linalg.norm(a - b, axis=1)))


def normalized_cond(H: Array, template_wh: tuple[float, float], quad: Array) -> float:
    """尺度／平移不變的條件數：先把模板 [0,w]×[0,h] 與 quad 的 bbox 都正規化到 [-1,1]² 再算 cond。

    為什麼不能直接 `cond(H)`：H 同時含「630×880 模板 → 122×80 足跡」的 ~0.1 縮放與 ~400 px 的平移，
    原生矩陣的條件數光是這樣就到 2e6（實測 E1 合成場景與範例近景皆如此），把每一個 ECC 解都當退化拒掉，
    整條 track 只剩參考影格有解。正規化後仿射映射的 cond ≈ 各向異性倍率（直式牌被壓扁 ≈ 2–4），
    只有真正的投影退化（cond ≫ 1e3）才會被 1e6 的門檻擋下。
    """
    H = np.asarray(H, dtype=np.float64)
    w, h = float(template_wh[0]), float(template_wh[1])
    q = np.asarray(quad, dtype=np.float64).reshape(4, 2)
    if not np.all(np.isfinite(q)):
        return math.inf
    lo, hi = q.min(axis=0), q.max(axis=0)
    c = (lo + hi) / 2.0
    # 目的端用**等向**尺度（bbox 較長的半邊）：只消掉整體縮放與平移，各向異性（壓扁）與投影退化仍反映在 cond 裡；
    # 若 x/y 各自正規化，被壓成一條線的 quad 也會被拉回單位正方形而看起來健康。
    s = max(float(np.max(hi - lo)) / 2.0, 1e-9)
    S_src_inv = np.array([[w / 2.0, 0.0, w / 2.0], [0.0, h / 2.0, h / 2.0], [0.0, 0.0, 1.0]])  # [-1,1]² → 模板
    S_dst = np.array([[1.0 / s, 0.0, -c[0] / s], [0.0, 1.0 / s, -c[1] / s], [0.0, 0.0, 1.0]])  # 幀 → [-1,1]²（等向）
    Hn = S_dst @ H @ S_src_inv
    if abs(Hn[2, 2]) < 1e-12 or not np.all(np.isfinite(Hn)):
        return math.inf
    return float(np.linalg.cond(Hn / Hn[2, 2]))


@dataclass(frozen=True)
class Sanity:
    ok: bool
    reason: str = ""
    det: float = math.nan
    cond: float = math.nan
    area_ratio: float = math.nan
    max_jump: float = math.nan


def sane(
    H: Array,
    template_wh: tuple[float, float],
    quad_prev: Array | None = None,
    area_anchor: float | None = None,
    *,
    cond_max: float = 1e6,
    area_range: tuple[float, float] = (0.5, 2.0),
    jump_min_px: float = 6.0,
    jump_frac: float = 0.08,
) -> Sanity:
    """退化檢查（計畫 §6.4 步驟 3）：凸、det(H[:2,:2])>0、cond<1e6、面積比 ∈ [0.5,2]、角點跳動 ≤ max(6 px, 8% 長邊)。

    四角的 w 分量必須全為正：負 w 代表角點跑到相機後面（翻牌翻到邊緣朝向鏡頭時特徵匹配常吐這種解），
    看起來像是「凹四邊形」但其實是投影翻面，一起擋掉。
    """
    H = np.asarray(H, dtype=np.float64)
    if H.shape != (3, 3) or not np.all(np.isfinite(H)):
        return Sanity(False, "non-finite")
    if abs(H[2, 2]) < 1e-12:
        return Sanity(False, "h22≈0")
    H = H / H[2, 2]
    det = float(np.linalg.det(H[:2, :2]))
    if det <= 0:
        return Sanity(False, "reflection (det≤0)", det=det)
    corners = template_corners(*template_wh)
    w = np.concatenate([corners, np.ones((4, 1))], axis=1) @ H[2]
    if np.any(w <= 1e-9):
        return Sanity(False, "corner behind camera (w≤0)", det=det)
    quad = apply(H, corners)
    if not is_convex(quad):
        return Sanity(False, "concave", det=det)
    if signed_area(quad) <= 0:  # 模板角是順時針（有號面積 > 0）；翻面就拒絕
        return Sanity(False, "orientation flipped", det=det)
    cond = normalized_cond(H, template_wh, quad)
    if not np.isfinite(cond) or cond > cond_max:
        return Sanity(False, f"ill-conditioned (cond={cond:.3g})", det=det, cond=cond)
    ratio = math.nan
    if area_anchor is not None and area_anchor > 0:
        ratio = quad_area(quad) / float(area_anchor)
        if not (area_range[0] <= ratio <= area_range[1]):
            return Sanity(False, f"area ratio {ratio:.3f} ∉ {area_range}", det=det, cond=cond, area_ratio=ratio)
    jump = math.nan
    if quad_prev is not None:
        qp = np.asarray(quad_prev, dtype=np.float64).reshape(4, 2)
        jump = max_corner_jump(quad, qp)
        limit = max(jump_min_px, jump_frac * long_side(qp))
        if jump > limit:
            return Sanity(False, f"corner jump {jump:.2f} px > {limit:.2f}", det=det, cond=cond, area_ratio=ratio, max_jump=jump)
    return Sanity(True, "", det=det, cond=cond, area_ratio=ratio, max_jump=jump)
