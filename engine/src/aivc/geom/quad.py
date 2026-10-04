"""遮罩 → 四角（計畫 §6.3）：最大 contour → approxPolyDP → 凸四邊形且 IoU>0.85；否則 Hough 四主線；再否則 minAreaRect（低信心）。

這是追蹤器的**重偵測器**（LOST 之後由 SAM2 遮罩重新取得 H）與參考影格挑選器，不是精修器：
精修交給 ECC。但回傳的角點仍做到子像素（對邊界像素中心做直線擬合、外推半像素），
因為 `template_to_quad(quad)` 直接當 ECC 的種子，差 1 px 就可能掉到錯的局部極值。
"""
from __future__ import annotations

import itertools
from dataclasses import dataclass

import cv2
import numpy as np

Array = np.ndarray

# 座標：findContours 給的是像素中心（整數），對外一律邊界慣例（見 geom/__init__），所以 contour 點先 +0.5。
# 為什麼再往外推 0.5：遮罩以「像素中心是否在形狀內」決定，邊界像素的中心平均落在真實邊緣內側半個像素，
# 擬合出的直線要沿外法線推 0.5 px 才是幾何邊。兩個 0.5 方向不同（一個是對角平移、一個沿法線），不能合併。
HALF = 0.5
EDGE_OFFSET_PX = 0.5


@dataclass
class QuadResult:
    quad: Array | None  # (4,2) TL,TR,BR,BL；None = 沒有可用形狀
    conf: float  # 0..1；poly 路徑 = IoU、Hough = 0.95·IoU、低信心路徑 ≤ 0.5
    method: str  # empty | poly | hough | hough-lowconf | minarea
    iou: float = 0.0


def order_quad(pts: Array, ref_tl: Array | None = None) -> Array:
    """四點排成順時針（影像座標 y 向下），起點取離 ref_tl 最近者；沒給 ref_tl 就取離影像左上最近（x+y 最小）。"""
    p = np.asarray(pts, dtype=np.float64).reshape(4, 2)
    c = p.mean(axis=0)
    ang = np.arctan2(p[:, 1] - c[1], p[:, 0] - c[0])
    p = p[np.argsort(ang)]  # y 向下時角度遞增＝視覺上順時針
    if ref_tl is None:
        start = int(np.argmin(p[:, 0] + p[:, 1]))
    else:
        r = np.asarray(ref_tl, dtype=np.float64).reshape(2)
        start = int(np.argmin(np.linalg.norm(p - r, axis=1)))
    return np.roll(p, -start, axis=0)


def _intersect(p1: Array, d1: Array, p2: Array, d2: Array) -> Array | None:
    cross = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(cross) < 1e-9:
        return None
    t = ((p2[0] - p1[0]) * d2[1] - (p2[1] - p1[1]) * d2[0]) / cross
    return p1 + t * d1


def refine_quad_by_lines(contour_pts: Array, quad: Array, band_px: float = 2.0, min_pts: int = 6) -> Array:
    """對每一邊附近的 contour 點做穩健直線擬合（DIST_HUBER），往外推半像素後相鄰相交 → 子像素四角。

    只取邊中段 8%–92% 的點：圓角牌的角落像素不在直線上，拿進來會把邊往內拉。
    """
    pts = np.asarray(contour_pts, dtype=np.float64).reshape(-1, 2)
    q = np.asarray(quad, dtype=np.float64).reshape(4, 2)
    centroid = q.mean(axis=0)
    lines: list[tuple[Array, Array]] = []
    for i in range(4):
        p, r = q[i], q[(i + 1) % 4]
        d = r - p
        L = np.linalg.norm(d)
        if L < 1e-6:
            return q
        u = d / L
        n = np.array([-u[1], u[0]])
        rel = pts - p
        t = rel @ u / L
        dist = np.abs(rel @ n)
        sel = (dist < band_px) & (t > 0.08) & (t < 0.92)
        if int(sel.sum()) >= min_pts:
            vx, vy, x0, y0 = cv2.fitLine(pts[sel].astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
            p0 = np.array([float(x0), float(y0)])
            u0 = np.array([float(vx), float(vy)])
            u0 /= np.linalg.norm(u0)
            n0 = np.array([-u0[1], u0[0]])
        else:
            p0, u0, n0 = p.copy(), u, n
        outward = n0 if np.dot((p + r) / 2 - centroid, n0) > 0 else -n0
        lines.append((p0 + EDGE_OFFSET_PX * outward, u0))
    out = q.copy()
    for j in range(4):
        (pa, ua), (pb, ub) = lines[(j - 1) % 4], lines[j]
        x = _intersect(pa, ua, pb, ub)
        if x is not None and np.all(np.isfinite(x)):
            out[j] = x
    return out


def offset_quad(quad: Array, d: float) -> Array:
    """每條邊沿外法線平移 d（負值＝內縮），相鄰邊重新相交。凸四邊形專用。"""
    q = np.asarray(quad, dtype=np.float64).reshape(4, 2)
    c = q.mean(axis=0)
    lines = []
    for i in range(4):
        p, r = q[i], q[(i + 1) % 4]
        u = r - p
        L = np.linalg.norm(u)
        if L < 1e-9:
            return q
        u = u / L
        n = np.array([-u[1], u[0]])
        if np.dot((p + r) / 2 - c, n) < 0:
            n = -n
        lines.append((p + d * n, u))
    out = q.copy()
    for j in range(4):
        (pa, ua), (pb, ub) = lines[(j - 1) % 4], lines[j]
        x = _intersect(pa, ua, pb, ub)
        if x is not None:
            out[j] = x
    return out


def raster_quad(quad: Array, shape: tuple[int, int], origin: tuple[int, int] = (0, 0)) -> Array:
    """「像素中心在四邊形內」的精確光柵（邊界慣例）。

    fillPoly 自己的規則是填 round(x0)..round(x1)，等於把多邊形往外撐 0.5 px；所以先換到中心座標（−0.5）
    再內縮 0.5 抵銷，用 shift=8 定點保住子像素。
    """
    h, w = shape
    poly = np.zeros((h, w), dtype=np.uint8)
    q = np.asarray(quad, dtype=np.float64).reshape(4, 2) - np.array(origin, dtype=np.float64) - HALF
    q = offset_quad(q, -HALF + 1e-3)
    pts = (q * 256.0).round().astype(np.int32)
    cv2.fillPoly(poly, [pts.reshape(-1, 1, 2)], 1, lineType=cv2.LINE_8, shift=8)
    return poly


def _raster_iou(mask_crop: Array, quad: Array, origin: tuple[int, int]) -> float:
    """多邊形與遮罩的 IoU，只在 crop 視窗內算。"""
    poly = raster_quad(quad, mask_crop.shape, origin)
    m = mask_crop.astype(bool)
    inter = int(np.count_nonzero(poly.astype(bool) & m))
    union = int(np.count_nonzero(poly.astype(bool) | m))
    return inter / union if union else 0.0


def _line_geometry(rho: float, theta: float) -> tuple[Array, Array]:
    n = np.array([np.cos(theta), np.sin(theta)])
    foot = rho * n
    u = np.array([-n[1], n[0]])
    return foot, u


def _distinct_lines(hough: Array, min_sep_px: float, max_lines: int = 8) -> list[tuple[Array, Array]]:
    kept: list[tuple[Array, Array]] = []
    for rho, theta in hough.reshape(-1, 2):
        foot, u = _line_geometry(float(rho), float(theta))
        dup = False
        for f2, u2 in kept:
            if abs(float(np.dot(u, u2))) > np.cos(np.deg2rad(10.0)):
                n2 = np.array([-u2[1], u2[0]])
                if abs(float(np.dot(foot - f2, n2))) < min_sep_px:
                    dup = True
                    break
        if not dup:
            kept.append((foot, u))
        if len(kept) >= max_lines:
            break
    return kept


def _quad_from_four_lines(lines: list[tuple[Array, Array]]) -> list[Array]:
    """4 條線有 3 種「對邊配對」；每種配對取 2×2 交點成四邊形。呼叫端用 IoU 挑最好的。"""
    out: list[Array] = []
    idx = [0, 1, 2, 3]
    for pairing in (((0, 1), (2, 3)), ((0, 2), (1, 3)), ((0, 3), (1, 2))):
        a, b = pairing
        pts = []
        ok = True
        for i in a:
            for j in b:
                x = _intersect(lines[idx[i]][0], lines[idx[i]][1], lines[idx[j]][0], lines[idx[j]][1])
                if x is None or not np.all(np.isfinite(x)):
                    ok = False
                    break
                pts.append(x)
            if not ok:
                break
        if ok and len(pts) == 4:
            out.append(order_quad(np.array(pts)))
    return out


def quad_from_mask(mask: Array, ref_tl: Array | None = None, iou_gate: float = 0.85) -> QuadResult:
    """遮罩（bool 或 0/1/255 uint8）→ 四角。見模組 docstring。"""
    m = (np.asarray(mask) > 0).astype(np.uint8)
    if int(m.sum()) < 16:
        return QuadResult(None, 0.0, "empty")
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return QuadResult(None, 0.0, "empty")
    cnt = max(contours, key=cv2.contourArea)
    if cv2.contourArea(cnt) < 16:
        return QuadResult(None, 0.0, "empty")
    cnt_pts = cnt.reshape(-1, 2).astype(np.float64) + HALF  # 中心 → 邊界慣例
    x, y, w, h = cv2.boundingRect(cnt)
    pad = 6
    x0, y0 = max(0, x - pad), max(0, y - pad)
    x1, y1 = min(m.shape[1], x + w + pad), min(m.shape[0], y + h + pad)
    crop = m[y0:y1, x0:x1]
    origin = (x0, y0)

    def finish(q: Array, method: str, iou: float, conf: float) -> QuadResult:
        return QuadResult(order_quad(q, ref_tl), float(conf), method, float(iou))

    # 1) approxPolyDP：乾淨的牌 95% 走這條
    approx = cv2.approxPolyDP(cnt, 0.02 * cv2.arcLength(cnt, True), True)
    if len(approx) == 4 and cv2.isContourConvex(approx):
        q = refine_quad_by_lines(cnt_pts, order_quad(approx.reshape(4, 2).astype(np.float64) + HALF))
        if _is_convex(q):
            iou = _raster_iou(crop, q, origin)
            if iou >= iou_gate:
                return finish(q, "poly", iou, iou)

    # 2) Hough 四主線：圓角＋遮擋讓 approxPolyDP 多出頂點時，四條長邊仍是投票最高的線
    best_q: Array | None = None
    best_iou = -1.0
    edges = np.zeros(crop.shape, dtype=np.uint8)
    cv2.drawContours(edges, [cnt - np.array([[x0, y0]])], -1, 255, 1)
    thr = max(8, int(0.15 * min(w, h)))
    hough = cv2.HoughLines(edges, 1, np.pi / 180.0, thr)
    if hough is not None and len(hough) >= 4:
        lines = _distinct_lines(hough, min_sep_px=max(4.0, 0.08 * min(w, h)))
        if len(lines) >= 4:
            for combo in itertools.combinations(range(len(lines)), 4):
                for q_local in _quad_from_four_lines([lines[i] for i in combo]):
                    if not _is_convex(q_local):
                        continue
                    q_img = q_local + np.array(origin, dtype=np.float64) + HALF  # Hough 在中心座標的 crop 上跑
                    q_img = refine_quad_by_lines(cnt_pts, q_img)
                    if not _is_convex(q_img):
                        continue
                    iou = _raster_iou(crop, q_img, origin)
                    if iou > best_iou:
                        best_iou, best_q = iou, q_img
    if best_q is not None and best_iou >= iou_gate:
        return finish(best_q, "hough", best_iou, 0.95 * best_iou)

    # 3) minAreaRect（低信心）：與 Hough 候選比 IoU 取較好者，但 conf 壓到 ≤ 0.5，讓重取得閘門（0.8）不會吃它
    rect = cv2.minAreaRect(cnt.astype(np.float32))
    q_min = refine_quad_by_lines(cnt_pts, order_quad(cv2.boxPoints(rect).astype(np.float64) + HALF))
    iou_min = _raster_iou(crop, q_min, origin) if _is_convex(q_min) else -1.0
    if best_q is not None and best_iou >= iou_min:
        return finish(best_q, "hough-lowconf", best_iou, min(0.5, best_iou))
    if iou_min < 0:
        return QuadResult(None, 0.0, "empty")
    return finish(q_min, "minarea", iou_min, min(0.5, iou_min))


def _is_convex(q: Array) -> bool:
    from .homography import is_convex

    return is_convex(q)
