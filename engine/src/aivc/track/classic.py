"""單幀解 `solve_frame`：SIFT（模板 ↔ 幀 ROI）→ USAC_MAGSAC → ECC 精修（以特徵 H 為種子，絕不從 identity 起步）→ 退化檢查。

幾何全部在「模板原生 px → 幀 px」定義；內部為了速度與精度換到「工作尺度模板 → 放大 ROI」解，
最後用 `rescale` / `shift_dst` 解析換回，沒有任何數值近似（計畫 §6.4 遠景 `S·H·S⁻¹`）。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from ..geom import homography as hg
from .template import Template, quantize_scale, upright_sift

Array = np.ndarray

MOTION_MODELS = ("translation", "similarity", "affine", "perspective")


@dataclass
class SolveParams:
    min_inliers: int = 12
    ratio: float = 0.75
    ransac_px: float = 2.0
    ransac_iters: int = 5000
    ransac_conf: float = 0.9999
    ecc_iters: int = 50
    ecc_eps: float = 1e-5
    ecc_gauss: int = 5
    ecc_accept: float = 0.6
    jump_min_px: float = 6.0
    jump_frac: float = 0.08
    area_range: tuple[float, float] = (0.5, 2.0)
    cond_max: float = 1e6
    work_scale_boost: float = 1.0  # 工作尺度 = boost × sqrt(ROI 內牌面積 / 模板面積)


@dataclass
class FrameSolveResult:
    H: Array  # 模板原生 → 幀；失敗時＝H_prev（呼叫端用 method/conf 判斷）
    conf: float
    n_matches: int
    n_inliers: int
    cc: float  # ECC 相關係數；沒跑成 = nan
    feature_ok: bool
    ecc_ok: bool
    method: str  # feat+ecc | feat | prev+ecc | prev
    work_scale: float
    matches_src: Array = field(default_factory=lambda: np.zeros((0, 2), np.float32))  # 模板原生 px
    matches_dst: Array = field(default_factory=lambda: np.zeros((0, 2), np.float32))  # 幀 px
    inlier_mask: Array = field(default_factory=lambda: np.zeros((0,), bool))
    roi: tuple[int, int, int, int] = (0, 0, 0, 0)
    sanity: str = ""  # 最後一次被拒的理由（"" = 沒被拒）

    @property
    def inlier_ratio(self) -> float:
        return self.n_inliers / self.n_matches if self.n_matches else 0.0


def roi_from_quad(quad: Array, frame_wh: tuple[int, int], dilate: float = 0.25, min_size: int = 16) -> tuple[int, int, int, int]:
    """四角的 bbox 以中心為準放大 (1+dilate)，夾進幀內。回 (x0,y0,x1,y1) 整數、半開區間。"""
    q = np.asarray(quad, dtype=np.float64).reshape(4, 2)
    W, Hh = frame_wh
    c = q.mean(axis=0)
    half = (q.max(axis=0) - q.min(axis=0)) * 0.5 * (1.0 + dilate)
    half = np.maximum(half, min_size / 2.0)
    x0 = int(math.floor(c[0] - half[0]))
    y0 = int(math.floor(c[1] - half[1]))
    x1 = int(math.ceil(c[0] + half[0])) + 1
    y1 = int(math.ceil(c[1] + half[1])) + 1
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(W, x1), min(Hh, y1)
    return x0, y0, x1, y1


def _crop_mask(mask: Array | None, roi: tuple[int, int, int, int], upsample: int) -> Array | None:
    if mask is None:
        return None
    x0, y0, x1, y1 = roi
    m = (np.asarray(mask)[y0:y1, x0:x1] > 0).astype(np.uint8) * 255
    if upsample > 1:
        m = cv2.resize(m, (m.shape[1] * upsample, m.shape[0] * upsample), interpolation=cv2.INTER_NEAREST)
    return m


def _to_affine_2x3(H: Array, template_wh: tuple[int, int]) -> Array:
    """把 3×3 投影到仿射 2×3：投影項為 0 就直接截；否則用四角最小平方擬合（ECC 非 homography 模式要吃 2×3）。"""
    H = np.asarray(H, dtype=np.float64)
    if abs(H[2, 0]) < 1e-12 and abs(H[2, 1]) < 1e-12:
        return (H / H[2, 2])[:2, :].astype(np.float32)
    src = hg.template_corners(*template_wh).astype(np.float32)
    dst = hg.apply(H, src).astype(np.float32)
    A, _ = cv2.estimateAffine2D(src.reshape(-1, 1, 2), dst.reshape(-1, 1, 2), method=cv2.LMEDS)
    return (A if A is not None else np.eye(2, 3)).astype(np.float32)


def _from_affine_2x3(A: Array) -> Array:
    return hg.normalize(np.vstack([np.asarray(A, dtype=np.float64), [0.0, 0.0, 1.0]]))


def _estimate_model(src: Array, dst: Array, model: str, p: SolveParams) -> tuple[Array | None, Array]:
    """特徵對 → (3×3 H | None, inlier bool mask)。依動態模型選估計器。"""
    n = len(src)
    s = src.reshape(-1, 1, 2).astype(np.float32)
    d = dst.reshape(-1, 1, 2).astype(np.float32)
    if model == "perspective":
        if n < 4:
            return None, np.zeros(n, bool)
        H, m = cv2.findHomography(s, d, cv2.USAC_MAGSAC, p.ransac_px, maxIters=p.ransac_iters, confidence=p.ransac_conf)
        return (None if H is None else H), (np.zeros(n, bool) if m is None else m.ravel().astype(bool))
    if model in ("affine", "similarity"):
        if n < 3:
            return None, np.zeros(n, bool)
        fn = cv2.estimateAffine2D if model == "affine" else cv2.estimateAffinePartial2D
        A, m = fn(s, d, method=cv2.RANSAC, ransacReprojThreshold=p.ransac_px, maxIters=p.ransac_iters, confidence=p.ransac_conf)
        return (None if A is None else _from_affine_2x3(A)), (np.zeros(n, bool) if m is None else m.ravel().astype(bool))
    if model == "translation":
        if n < 1:
            return None, np.zeros(n, bool)
        dlt = dst - src
        med = np.median(dlt, axis=0)
        inl = np.linalg.norm(dlt - med, axis=1) <= p.ransac_px
        if inl.sum() == 0:
            return None, inl
        t = dlt[inl].mean(axis=0)
        return hg.translation_matrix(float(t[0]), float(t[1])), inl
    raise ValueError(f"未知 motion_model {model!r}；可用 {MOTION_MODELS}")


def sane_local(H: Array, template_wh: tuple[int, int], quad_prev: Array | None, area_anchor: float | None, p: SolveParams) -> hg.Sanity:
    """`hg.sane` 的平移歸零版：先把目的端原點移到「模板中心的像」再檢查。

    為什麼：`sane` 的鏡射判斷看 det(H[:2,:2])，那只在 H 沒有投影項、或平移很小時才等於 Jacobian 行列式。
    帶透視的 H 左上 2×2 其實是 A = J·w + p·[h20 h21]（p = 原點的像）；遠景牌在 (726,578)、足跡 40×26 px，
    p·[h20 h21] 比 J 大，det(A) 會變號 → 每個 ECC 解都被當「reflection (det≤0)」拒掉（E1 全片實測 shot2-Banker2
    ECC cc 0.96 卻 75/76 幀 prev:fail）。移到模板中心的像 p_c 之後 A' = w(c)·J(c)，det 的正負 = 模板中心處是否鏡射，
    才是想要的判斷。凸性／有號面積／面積比／角點跳動／正規化 cond 都與目的端平移無關，其餘判斷不變。
    """
    tw, th = template_wh
    pc = hg.apply(H, [[tw / 2.0, th / 2.0]])[0]
    if not np.all(np.isfinite(pc)):
        return hg.sane(H, template_wh, quad_prev, area_anchor, cond_max=p.cond_max, area_range=p.area_range, jump_min_px=p.jump_min_px, jump_frac=p.jump_frac)
    T = hg.translation_matrix(-float(pc[0]), -float(pc[1]))
    qp = None if quad_prev is None else np.asarray(quad_prev, dtype=np.float64).reshape(4, 2) - pc[None, :]
    return hg.sane(T @ np.asarray(H, dtype=np.float64), template_wh, qp, area_anchor, cond_max=p.cond_max, area_range=p.area_range, jump_min_px=p.jump_min_px, jump_frac=p.jump_frac)


def _ecc_motion(model: str) -> int:
    return {
        "perspective": cv2.MOTION_HOMOGRAPHY,
        "affine": cv2.MOTION_AFFINE,
        "similarity": cv2.MOTION_AFFINE,  # ECC 沒有相似變換模式；仿射是最接近的上位模型
        "translation": cv2.MOTION_TRANSLATION,
    }[model]


def solve_frame(
    template: Template,
    frame_rgb8: Array,
    H_prev: Array,
    visible_mask: Array | None = None,
    tracking_region_mask: Array | None = None,
    *,
    upsample: int = 1,
    motion_model: str = "perspective",
    area_anchor: float | None = None,
    quad_prev: Array | None = None,
    roi_dilate: float = 0.25,
    ecc_template: Template | None = None,
    params: SolveParams | None = None,
) -> FrameSolveResult:
    """見模組 docstring。

    - `H_prev`：上一幀（或等速預測）的解，同時是 ROI 中心與 ECC 的保底種子。
    - `visible_mask`：SAM2 可見遮罩（幀尺寸 bool），None = 全可見。
    - `tracking_region_mask`：追蹤區域（幀尺寸 bool），None = 整個表面。特徵偵測與 ECC 都只看它。
    - `upsample`：遠景 2× 放大 ROI 解，H 解析縮回。
    - `ecc_template`：光度輔助模板（同模板座標系），只換 ECC 用的影像，不換幾何。
    - `area_anchor`：參考影格牌面積（面積比閘門）。`quad_prev`：角點跳動比對的基準（預設 quad(H_prev)）。
    """
    p = params or SolveParams()
    if motion_model not in MOTION_MODELS:
        raise ValueError(f"未知 motion_model {motion_model!r}；可用 {MOTION_MODELS}")
    u = max(1, int(upsample))
    frame = np.asarray(frame_rgb8)
    Hh, W = frame.shape[:2]
    tw, th = template.wh
    H_prev = hg.normalize(H_prev)
    q_prev = hg.quad_from_h(H_prev, (tw, th)) if quad_prev is None else np.asarray(quad_prev, dtype=np.float64).reshape(4, 2)

    def fail(method: str, reason: str) -> FrameSolveResult:
        return FrameSolveResult(H_prev, 0.0, 0, 0, math.nan, False, False, method, 1.0, sanity=reason)

    if not np.all(np.isfinite(q_prev)):
        return fail("prev", "H_prev 無效")
    roi = roi_from_quad(q_prev, (W, Hh), dilate=roi_dilate)
    x0, y0, x1, y1 = roi
    if x1 - x0 < 8 or y1 - y0 < 8:
        return fail("prev", "ROI 落在幀外")

    # ---- ROI 與工作尺度 ----
    roi_rgb = frame[y0:y1, x0:x1]
    if u > 1:
        roi_rgb = cv2.resize(roi_rgb, ((x1 - x0) * u, (y1 - y0) * u), interpolation=cv2.INTER_CUBIC)
    roi_gray_u8 = cv2.cvtColor(np.ascontiguousarray(roi_rgb), cv2.COLOR_RGB2GRAY)
    roi_gray = roi_gray_u8.astype(np.float32) / 255.0
    proj_area = hg.quad_area(q_prev) * (u * u)
    s = quantize_scale(p.work_scale_boost * math.sqrt(max(proj_area, 1.0) / template.area))
    level = template.level(s)
    ecc_level = (ecc_template or template).level(s)
    if ecc_level.wh != level.wh:
        raise ValueError("ecc_template 尺寸必須與模板相同（同一模板座標系）")
    sx, sy = level.sx, level.sy  # 實際 level 尺度（非名目 s）
    # 幀 → ROI(放大) 座標：T = diag(u)·translate(-x0,-y0)
    T_roi = hg.scale_matrix(u) @ hg.translation_matrix(-x0, -y0)

    def to_work(H_native: Array) -> Array:
        """模板原生→幀 ⟶ 模板 level→ROI。"""
        return hg.normalize(T_roi @ H_native @ hg.scale_matrix(1.0 / sx, 1.0 / sy))

    def to_native(H_work: Array) -> Array:
        return hg.normalize(np.linalg.inv(T_roi) @ H_work @ hg.scale_matrix(sx, sy))

    # 幀側 upright SIFT 的方向 = H_prev 把模板 x 軸映到幀後的角度（模板側釘 0°）
    ax = hg.apply(H_prev, [[tw, th / 2.0]])[0] - hg.apply(H_prev, [[0.0, th / 2.0]])[0]
    frame_angle = float(np.degrees(np.arctan2(ax[1], ax[0]))) if np.all(np.isfinite(ax)) else 0.0

    # 幀側遮罩：可見 ∧ 追蹤區域 ∧ ROI 內
    vis_roi = _crop_mask(visible_mask, roi, u)
    reg_roi = _crop_mask(tracking_region_mask, roi, u)
    side_mask = np.full(roi_gray.shape, 255, np.uint8)
    if vis_roi is not None:
        side_mask &= vis_roi
    if reg_roi is not None:
        side_mask &= reg_roi

    # ---- 1) 特徵 ----
    H_seed = H_prev
    feature_ok = False
    n_matches = n_inl = 0
    m_src = np.zeros((0, 2), np.float32)
    m_dst = np.zeros((0, 2), np.float32)
    inl_mask = np.zeros((0,), bool)
    sanity_reason = ""
    if level.desc is not None and len(level.kps) >= 4 and int(np.count_nonzero(side_mask)) >= 64:
        kps_f, desc_f = upright_sift(roi_gray_u8, side_mask, frame_angle)
        if desc_f is not None and len(kps_f) >= 4:
            knn = cv2.BFMatcher(cv2.NORM_L2).knnMatch(level.desc, desc_f, k=2)
            good = [m[0] for m in knn if len(m) == 2 and m[0].distance < p.ratio * m[1].distance]
            if len(good) >= 4:
                # SIFT 座標是像素中心；+½ 換成邊界慣例（兩側同時平移，估出來的 H 直接就是邊界慣例）
                src_w = level.kps[[g.queryIdx for g in good]] + hg.HALF_PIXEL
                dst_w = kps_f[[g.trainIdx for g in good]] + hg.HALF_PIXEL
                n_matches = len(good)
                H_w, inl_mask = _estimate_model(src_w, dst_w, motion_model, p)
                n_inl = int(inl_mask.sum())
                # HUD 用：換回原生模板 px / 幀 px
                m_src = (src_w / np.array([sx, sy], dtype=np.float32)).astype(np.float32)
                m_dst = (hg.apply(np.linalg.inv(T_roi), dst_w)).astype(np.float32)
                if H_w is not None and n_inl >= p.min_inliers:
                    H_f = to_native(H_w)
                    chk = sane_local(H_f, (tw, th), q_prev, area_anchor, p)
                    if chk.ok:
                        H_seed, feature_ok = H_f, True
                    else:
                        sanity_reason = "feat: " + chk.reason

    # ---- 2) ECC 精修（種子 = 特徵解或 H_prev，絕不 identity）----
    ecc_ok = False
    cc = math.nan
    H_out = H_seed
    motion = _ecc_motion(motion_model)
    warp_work = to_work(H_seed)
    warp_cv = hg.edge_to_cv(warp_work)  # ECC / warpPerspective 吃中心慣例
    warp = warp_cv.astype(np.float32) if motion == cv2.MOTION_HOMOGRAPHY else _to_affine_2x3(warp_cv, level.wh)
    ecc_in_mask = cv2.warpPerspective(ecc_level.ecc_mask, warp_cv, (roi_gray.shape[1], roi_gray.shape[0]), flags=cv2.INTER_NEAREST)
    ecc_in_mask &= side_mask
    if int(np.count_nonzero(ecc_in_mask)) >= 64:
        criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, int(p.ecc_iters), float(p.ecc_eps))
        try:
            cc_val, warp_e = cv2.findTransformECC(ecc_level.gray, roi_gray, warp.copy(), motion, criteria, ecc_in_mask, int(p.ecc_gauss))
            cc = float(cc_val)
        except cv2.error:
            cc, warp_e = math.nan, None  # 發散／NaN：保留種子
        if warp_e is not None and np.isfinite(cc) and cc > p.ecc_accept:
            H_e_work = hg.cv_to_edge(warp_e.astype(np.float64) if motion == cv2.MOTION_HOMOGRAPHY else _from_affine_2x3(warp_e))
            H_e = to_native(H_e_work)
            chk = sane_local(H_e, (tw, th), q_prev, area_anchor, p)
            if chk.ok:
                H_out, ecc_ok = H_e, True
            else:
                sanity_reason = "ecc: " + chk.reason

    # ---- 3) 信心 ----
    if ecc_ok:
        base = 0.5 + 0.5 * min(1.0, (cc - p.ecc_accept) / max(1e-6, 1.0 - p.ecc_accept))
        if feature_ok:
            base = min(1.0, base + 0.05)
    elif feature_ok:
        base = min(0.6, 0.3 + 0.01 * n_inl)
    else:
        base = 0.2
    method = ("feat" if feature_ok else "prev") + ("+ecc" if ecc_ok else "")
    return FrameSolveResult(
        H=H_out,
        conf=float(base),
        n_matches=n_matches,
        n_inliers=n_inl,
        cc=cc,
        feature_ok=feature_ok,
        ecc_ok=ecc_ok,
        method=method,
        work_scale=s,
        matches_src=m_src,
        matches_dst=m_dst,
        inlier_mask=inl_mask,
        roi=roi,
        sanity=sanity_reason,
    )


def refine_from_quad(template: Template, frame_rgb8: Array, quad: Array, **kw) -> FrameSolveResult:
    """由四角（使用者關鍵幀／遮罩四角）起步：先 getPerspectiveTransform 再走 solve_frame 精修。"""
    H0 = hg.template_to_quad(template.wh, quad)
    return solve_frame(template, frame_rgb8, H0, **kw)
