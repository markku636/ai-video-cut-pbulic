"""合成器（§6.6 虛擬碼的實作）：一幀進、一幀出，遮罩外逐位元不變。

流程（全部線性 full-range float32 RGB；只在 ROI 內算）：
  1. 依 H(k-1),H(k),H(k+1) 規劃動態模糊樣本（blur.plan_blur）→ 樣本四角聯集 bbox + 邊緣/遮擋 padding = ROI（偶數對齊）。
  2. 工作模板空間 = supersample × 牌在幀中的足跡（不是原生 630×880：牌只有 120×80 px，原生解析度只是浪費且
     會讓「1.5% 短邊」的 sigma 與 2 px 墨膨脹失去意義），上限原生尺寸。模板／遮罩都 INTER_AREA 縮到工作尺寸。
  3. rect = 幀 → 工作模板（雙線性，觀測端不用 lanczos 以免手邊緣振鈴）；vis 同樣 warp 後 >0.5。
  4. 光影（shading.estimate_shading；沒有原模板時走 lowpass-mean）→ gain S_lp、spec。
  4b. 新面加工（外掛的 hooks.FaceStage，依登記順序；例：牌局外掛的墨色比對＋墨邊預模糊）。沒有外掛 → 原樣。
  5. 新面 face = region.compose_face（target/regionPolicy）。
  6. 每個模糊樣本：face 以選定核心 warp 到 ss 網格（BORDER_REPLICATE + clamp 到 face 的每通道 [min,max]），
     alpha 用**解析四邊形 SDF**（choke 內縮、softness 線性／smoothstep 過渡；至少 1 個 ss 像素寬確保反鋸齒）
     × warp(輪廓)（圓角）。預乘累加 → /n → INTER_AREA 縮回幀解析度（預乘縮回不會有暗邊）。
  7. 遮擋 occl（獨立於插入邊緣）：遮擋物 = 1-vis 在「內縮四邊形」內，distance-transform 膨脹 dilate px，高斯羽化。
  8. alpha = cover × occl × opacity × applyMix；out = frame(1-alpha) + colour_pm × (occl·mix)；顆粒 × alpha 加回。
     顆粒在**碼值（BT.709 gamma）域**加：量測是在紙上（線性 0.7–0.8）做的，編碼雜訊在碼值域近似等幅；直接在線性域加同一個
     sigma，到了黑墨（線性 0.02）等於 7× 的碼值雜訊，而且下緣被 Y=16 夾掉 → 黑墨被抬成灰（A4 量測：A♠ 墨反射率 0.028→0.054）。
A4 pull-forward：光影估計另外排除**觀測到的真墨**（shading.detect_observed_ink），避免原模板的墨漏進 S 造成鬼影。
外掛可以整幀接手（hooks.CompositeMode：claims(params) 為真就交給它，例：空白牌逐像素比值合成），參數與本函式相同。
  9. 只把 dilate(alpha>0, 1px) 寫回 yuv420p（色度 2×2 max），其餘位元組原樣（_color.write_back 寫差值）。

hold（回原幀、stats.hold=True）：regionPolicy=hold、applyMix/opacity=0、conf<holdBelowConf、ROI 在畫面外、
紙像素不足且沒有參考光影。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

from .. import hooks
from . import _color
from . import blur as blur_mod
from . import grain as grain_mod
from . import region as region_mod
from . import shading as shading_mod
from ._color import Yuv420
from .params import InsertParams
from .shading import ShadingEstimate

_KERNELS = {
    "nearest": cv2.INTER_NEAREST,
    "bilinear": cv2.INTER_LINEAR,
    "bicubic": cv2.INTER_CUBIC,
    "lanczos3": cv2.INTER_LANCZOS4,  # cv2 沒有 lanczos3；lanczos4 是最接近的（8×8 支撐，振鈴由 clamp 收）
}
MIN_WORK_PX = 16


@dataclass
class CompositeStats:
    hold: bool = False
    hold_reason: str = ""
    alpha_area: float = 0.0  # Σalpha（幀 px）
    alpha_max: float = 0.0
    write_pixels: int = 0  # dilate(alpha>0,1px) 的亮度像素數
    grain_sigma: tuple[float, float, float] = (0.0, 0.0, 0.0)  # 線性域
    grain_source: str = ""  # measured | synthetic | off
    displacement: float = 0.0  # 角點每幀位移（px）
    samples: int = 1
    shutter_frames: float = 0.0
    path_px: float = 0.0  # |d|·shutter_frames
    supersample: int = 0
    work_size: tuple[int, int] = (0, 0)  # (w,h)
    roi: tuple[int, int, int, int] = (0, 0, 0, 0)
    shading_source: str = ""
    paper_px: int = 0
    paper_coverage: float = 0.0
    observed_ink_px: int = 0  # A4：光影估計額外排除的觀測墨像素（工作空間）
    ink_match: str = ""  # 新面加工（外掛）記的墨色比對結果；沒有外掛時留空
    preblur_px: tuple[float, float] = (0.0, 0.0)  # 新面加工（外掛）記的墨邊預模糊（亮度, 色度）工作 px sigma
    kernel: str = ""
    target: str = ""
    region_policy: str = ""
    mode: str = "template-ratio"  # template-ratio（重畫整張新面＋光影估計）| 外掛替代路徑自己的名字（hooks.CompositeMode）

    def to_dict(self) -> dict[str, Any]:
        return {k: (list(v) if isinstance(v, tuple) else v) for k, v in self.__dict__.items()}


@dataclass
class CompositeResult:
    out: Yuv420 | np.ndarray
    stats: CompositeStats
    roi: tuple[int, int, int, int]
    alpha_roi: np.ndarray | None = None  # (rh,rw) float32 最終 alpha
    write_mask_roi: np.ndarray | None = None  # (rh,rw) bool
    shading: ShadingEstimate | None = None  # 給 sheenLock=card 當參考幀
    size: tuple[int, int] = (0, 0)  # (W,H)

    def alpha_full(self) -> np.ndarray:
        W, H = self.size
        a = np.zeros((H, W), dtype=np.float32)
        if self.alpha_roi is not None:
            x0, y0, x1, y1 = self.roi
            a[y0:y1, x0:x1] = self.alpha_roi
        return a

    def write_mask_full(self) -> np.ndarray:
        W, H = self.size
        m = np.zeros((H, W), dtype=bool)
        if self.write_mask_roi is not None:
            x0, y0, x1, y1 = self.roi
            m[y0:y1, x0:x1] = self.write_mask_roi
        return m


@dataclass
class FaceStageEnv:
    """新面加工（hooks.FaceStage）看得到的東西：全部在工作模板空間（線性 RGB float32、bool 遮罩），尺寸 work_wh。
    stage.apply(env) 回新的 tmpl_new_lin；要記統計就寫 env.stats。"""

    params: InsertParams
    target: str  # "card" | "blank"
    tmpl_new_lin: np.ndarray
    ink_new: np.ndarray
    ink_orig: np.ndarray
    paper: np.ndarray | None
    barcode: np.ndarray | None
    paper_rgb: np.ndarray
    rect: np.ndarray  # 幀 ROI 矯正到工作模板空間（線性）
    shading: ShadingEstimate
    ss: int  # supersample（幀 px → 工作 px）
    work_wh: tuple[int, int]
    stats: CompositeStats


# ---------------------------------------------------------------------------
# 座標小工具（連續座標 ↔ cv2 像素中心座標）
# ---------------------------------------------------------------------------
def _T(dx: float, dy: float) -> np.ndarray:
    return np.array([[1.0, 0.0, dx], [0.0, 1.0, dy], [0.0, 0.0, 1.0]], dtype=np.float64)


def _S(sx: float, sy: float) -> np.ndarray:
    return np.array([[sx, 0.0, 0.0], [0.0, sy, 0.0], [0.0, 0.0, 1.0]], dtype=np.float64)


def _cv(M: np.ndarray) -> np.ndarray:
    """連續座標矩陣 → cv2（整數＝像素中心）矩陣：T(-½)·M·T(+½)。"""
    return _T(-0.5, -0.5) @ M @ _T(0.5, 0.5)


def _apply(M: np.ndarray, pts: np.ndarray) -> np.ndarray:
    p = np.hstack([pts, np.ones((len(pts), 1))]) @ M.T
    return p[:, :2] / p[:, 2:3]


def _norm_H(H: np.ndarray) -> np.ndarray:
    H = np.asarray(H, dtype=np.float64).reshape(3, 3)
    if not np.all(np.isfinite(H)) or abs(H[2, 2]) < 1e-12:
        raise ValueError("H 不是有效的 3×3 homography")
    return H / H[2, 2]


def _resize_mask(mask: np.ndarray | None, wh: tuple[int, int], fill: bool) -> np.ndarray:
    if mask is None:
        return np.full((wh[1], wh[0]), fill, dtype=bool)
    m = mask.astype(np.float32)
    if m.shape[:2] != (wh[1], wh[0]):
        m = cv2.resize(m, wh, interpolation=cv2.INTER_AREA)
    return m > 0.5


def _resize_rgb8(img: np.ndarray, wh: tuple[int, int]) -> np.ndarray:
    if img.shape[:2] == (wh[1], wh[0]):
        return img
    return cv2.resize(img, wh, interpolation=cv2.INTER_AREA)


# ---------------------------------------------------------------------------
# alpha：解析四邊形 SDF
# ---------------------------------------------------------------------------
def quad_alpha(quad: np.ndarray, w: int, h: int, px_per_unit: float, choke_px: float, softness_px: float, falloff: str) -> np.ndarray:
    """凸四邊形（連續座標，網格像素中心在 i+0.5）→ (h,w) float32 alpha。
    sdf 以「幀 px」為單位（網格座標 / px_per_unit），choke 往內縮、softness 是過渡帶寬（至少 1 個網格像素，保證反鋸齒）。"""
    q = np.asarray(quad, dtype=np.float64).reshape(4, 2)
    xs = (np.arange(w, dtype=np.float64) + 0.5)[None, :]
    ys = (np.arange(h, dtype=np.float64) + 0.5)[:, None]
    area = 0.0
    for i in range(4):
        a, b = q[i], q[(i + 1) % 4]
        area += a[0] * b[1] - b[0] * a[1]
    sign = 1.0 if area >= 0 else -1.0
    sdf = None
    for i in range(4):
        a, b = q[i], q[(i + 1) % 4]
        ex, ey = b[0] - a[0], b[1] - a[1]
        L = max(float(np.hypot(ex, ey)), 1e-9)
        # cross(b-a, p-a) / |b-a|，sign 讓內側為正
        d = (ex * (ys - a[1]) - ey * (xs - a[0])) * (sign / L)
        sdf = d if sdf is None else np.minimum(sdf, d)
    assert sdf is not None
    sdf_px = sdf / px_per_unit
    soft = max(float(softness_px), 1.0 / px_per_unit)
    t = np.clip((sdf_px - choke_px) / soft + 0.5, 0.0, 1.0)
    if falloff == "smoothstep":
        t = t * t * (3.0 - 2.0 * t)
    return t.astype(np.float32)


def occlusion_alpha(vis_roi: np.ndarray, dilate_px: float, feather_px: float) -> np.ndarray:
    """遮擋透明度（1 = 可見）。vis_roi (rh,rw) float 0..1（SAM 可見遮罩，ROI 座標）。

    遮擋物 = 1 - vis；`dilate` 是把**遮擋物**長大（計畫寫 dilate(alpha_vis)，但參數叫 occlusion.dilate，
    而且把插入面畫到手的柔邊上是明顯的光暈，所以往「多遮一點」的方向做）；再高斯羽化（sigma = feather/2）。
    SAM 遮罩若在牌的外緣比四邊形小 1 px，這裡會多留一圈原始像素——牌緣是紙對紙，看不出來；
    曾試過「牌緣 rim 內信任幾何」的作法，結果手跨越牌緣時多畫一條 2.5 px 的牌，比遮罩差 1 px 更糟，已移除。"""
    occ = np.clip(1.0 - vis_roi.astype(np.float32), 0.0, 1.0).astype(np.float32)
    hard = occ >= 0.5
    if dilate_px > 0 and hard.any() and not hard.all():
        dist = cv2.distanceTransform((~hard).astype(np.uint8), cv2.DIST_L2, cv2.DIST_MASK_PRECISE)
        ramp = np.clip(dilate_px - dist + 1.0, 0.0, 1.0).astype(np.float32)
        occ = np.maximum(occ, ramp)
        occ[hard] = 1.0
    if feather_px > 0 and occ.any():
        occ = cv2.GaussianBlur(occ, (0, 0), feather_px * 0.5)
    return (1.0 - occ).astype(np.float32)


# ---------------------------------------------------------------------------
# 主函式
# ---------------------------------------------------------------------------
def composite_frame(
    frame: Yuv420 | np.ndarray,
    H: np.ndarray,
    alpha_vis: np.ndarray | None,
    tmpl_orig_rgb8: np.ndarray | None,
    tmpl_new_rgb8: np.ndarray,
    ink_orig_mask: np.ndarray | None,
    ink_new_mask: np.ndarray | None,
    paper_mask: np.ndarray | None,
    H_prev: np.ndarray | None = None,
    H_next: np.ndarray | None = None,
    params: InsertParams | None = None,
    *,
    barcode_mask: np.ndarray | None = None,
    target: str = "card",
    conf: float = 1.0,
    frame_index: int = 0,
    seed: int = 0,
    shot_kind: str | None = None,
    shading_ref: ShadingEstimate | None = None,
    matrix: str | None = None,
    color_range: str | None = None,
    occluder: np.ndarray | None = None,
    warp: Any = None,
    tmpl_alt_rgb8: np.ndarray | None = None,
    ink_alt_mask: np.ndarray | None = None,
) -> CompositeResult:
    """把新面合成到一幀。

    frame          yuv420p 平面（`Yuv420`）或 rgb8 (H,W,3)（視為 BT.709 gamma、full range）。
                   `Yuv420` 的 matrix（bt709|bt601）／color_range（tv|pc）決定 yuv↔線性的矩陣與 range；
                   奇數尺寸（色度 ceil(W/2)×ceil(H/2)）可以，ROI 會貼齊奇數的右緣／下緣。
    matrix / color_range  覆寫 frame 的色彩中繼資料（None＝用 frame 自己的；rgb8 輸入忽略）。輸出平面帶實際採用的那一組。
    H              3×3：模板**連續座標**（四角 (0,0),(w,0),(w,h),(0,h)，w/h = tmpl_new 的像素尺寸）→ 幀連續座標。
    alpha_vis      幀空間可見遮罩（bool 或 float 0..1；None＝全可見、不做遮擋）。
    tmpl_orig_rgb8 原面模板（None → lowpass-mean 光影）。tmpl_new_rgb8 新面（決定模板尺寸）。
    ink_orig_mask / ink_new_mask / paper_mask  模板空間 bool；paper_mask 同時是表面的輪廓（例：圓角）。None 可。
    H_prev / H_next  鄰幀 H（動態模糊路徑）。params 預設 InsertParams()（standard 巨集）。
    barcode_mask   模板空間 bool（keepBarcode 用）。target "card"（印新面）| "blank"（只留表面底色）。conf 追蹤信心（< holdBelowConf → hold）。
    frame_index / seed  顆粒種子。shot_kind "close"|"wide"（supersample auto）。shading_ref  參考幀光影（sheenLock=card、紙不足時）。
    occluder / warp / tmpl_alt_rgb8 / ink_alt_mask  只交給外掛的替代路徑（hooks.CompositeMode）：
                   occluder＝幀空間額外的遮擋物（bool 或 float 0..1）；warp＝貼合式形變（取代平面 H）；
                   tmpl_alt／ink_alt＝翹起來露出的「另一面」模板。核心的 template-ratio 路徑不用它們。
    """
    p = params or InsertParams()
    is_yuv = isinstance(frame, Yuv420)
    W, Hh = frame.size if is_yuv else (int(frame.shape[1]), int(frame.shape[0]))
    # 讀進線性與寫回差值必須用同一組矩陣／range（來源的 BT.601、full range 不能被當成 BT.709 tv 算）
    cmeta: dict[str, str] = {}
    if is_yuv:
        cmeta = {"matrix": matrix or frame.matrix, "color_range": color_range or frame.color_range}  # type: ignore[union-attr]
    stats = CompositeStats(target=target, region_policy=p.region_policy, kernel=p.resample.kernel)

    def untouched(reason: str) -> CompositeResult:
        stats.hold, stats.hold_reason = True, reason
        return CompositeResult(out=frame, stats=stats, roi=(0, 0, 0, 0), size=(W, Hh))

    if p.is_hold:
        return untouched("policy")
    if conf < p.smoothing.hold_below_conf:
        return untouched(f"conf {conf:.2f} < {p.smoothing.hold_below_conf:.2f}")
    if target not in ("card", "blank"):
        raise ValueError(f"target 必須是 'card' 或 'blank'，收到 {target!r}")
    for mode in hooks.composite_modes():
        if mode.claims(p):
            # 外掛的整條替代路徑（例：空白牌逐像素比值合成）：同一組參數、同一份 stats
            return mode.composite(
                frame, H, alpha_vis, tmpl_orig_rgb8, tmpl_new_rgb8, ink_new_mask, paper_mask, H_prev, H_next, p,
                target=target, frame_index=frame_index, seed=seed, matrix=matrix, color_range=color_range, stats=stats, occluder=occluder,
                warp=warp, tmpl_alt_rgb8=tmpl_alt_rgb8, ink_alt_mask=ink_alt_mask,
            )

    Hm = _norm_H(H)
    nh, nw = int(tmpl_new_rgb8.shape[0]), int(tmpl_new_rgb8.shape[1])

    # 1. 動態模糊規劃 + ROI
    plan = blur_mod.plan_blur(Hm, None if H_prev is None else _norm_H(H_prev), None if H_next is None else _norm_H(H_next), nw, nh, p.motion_blur)
    q0 = blur_mod.quad_from_H(Hm, nw, nh)
    wf = max(np.linalg.norm(q0[1] - q0[0]), np.linalg.norm(q0[2] - q0[3]))
    hf = max(np.linalg.norm(q0[3] - q0[0]), np.linalg.norm(q0[2] - q0[1]))
    if not np.isfinite(wf) or not np.isfinite(hf) or wf < 1 or hf < 1:
        return untouched("degenerate quad")
    ss = p.supersample_for(float(max(wf, hf)), shot_kind)
    ww = int(min(max(round(ss * wf), MIN_WORK_PX), nw))
    wh = int(min(max(round(ss * hf), MIN_WORK_PX), nh))
    pad = p.edge.softness + p.occlusion.dilate + 2.0 * p.occlusion.feather + 3.0
    bx0, by0, bx1, by1 = plan.union_bbox
    roi = _color.even_roi(bx0 - pad, by0 - pad, bx1 + pad, by1 + pad, W, Hh)
    if roi == (0, 0, 0, 0):
        return untouched("offscreen")
    x0, y0, x1, y1 = roi
    rw, rh = x1 - x0, y1 - y0
    stats.samples, stats.displacement, stats.shutter_frames, stats.path_px = plan.samples, plan.displacement_px, plan.shutter_frames, plan.path_px
    stats.supersample, stats.work_size, stats.roi = ss, (ww, wh), roi

    # 2. 幀 ROI → 線性；工作模板
    frame_lin = _color.yuv420_to_linear(frame, roi, **cmeta) if is_yuv else _color.rgb8_to_linear(frame[y0:y1, x0:x1])
    Sw = _S(nw / ww, nh / wh)  # 工作連續座標 → 原生連續座標
    H_work = Hm @ Sw  # 工作 → 幀
    tmpl_new_lin = _color.rgb8_to_linear(_resize_rgb8(tmpl_new_rgb8, (ww, wh)))
    tmpl_orig_lin = None if tmpl_orig_rgb8 is None else _color.rgb8_to_linear(_resize_rgb8(tmpl_orig_rgb8, (ww, wh)))
    ink_new_w = _resize_mask(ink_new_mask, (ww, wh), False)
    ink_orig_w = _resize_mask(ink_orig_mask, (ww, wh), False)
    paper_w = None if paper_mask is None else _resize_mask(paper_mask, (ww, wh), True)
    barcode_w = None if barcode_mask is None else _resize_mask(barcode_mask, (ww, wh), False)
    silhouette = None if paper_w is None else (paper_w | ink_new_w)
    src_for_paper = tmpl_orig_lin if tmpl_orig_lin is not None else tmpl_new_lin
    paper_rgb = region_mod.paper_colour(src_for_paper, np.ones((wh, ww), bool) if paper_w is None else paper_w, ink_orig_w if tmpl_orig_lin is not None else ink_new_w)
    if silhouette is not None:
        tmpl_new_lin = region_mod.fill_outside_silhouette(tmpl_new_lin, silhouette, paper_rgb)
        if tmpl_orig_lin is not None:
            tmpl_orig_lin = region_mod.fill_outside_silhouette(tmpl_orig_lin, silhouette, paper_rgb)

    # 3. rect：幀 ROI → 工作模板（WARP_INVERSE_MAP：dst(t) = src(M·t)，M = 工作 → ROI）
    M_rect = _cv(_T(-x0, -y0) @ H_work)
    inv_flags = cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP
    rect = cv2.warpPerspective(frame_lin, M_rect, (ww, wh), flags=inv_flags, borderMode=cv2.BORDER_REPLICATE)
    ones_roi = np.ones((rh, rw), dtype=np.float32)
    in_frame = cv2.warpPerspective(ones_roi, M_rect, (ww, wh), flags=inv_flags, borderMode=cv2.BORDER_CONSTANT, borderValue=0) > 0.5
    if alpha_vis is None:
        vis_roi = ones_roi
    else:
        vis_roi = np.ascontiguousarray(alpha_vis[y0:y1, x0:x1]).astype(np.float32)
    vis_w = cv2.warpPerspective(vis_roi, M_rect, (ww, wh), flags=inv_flags, borderMode=cv2.BORDER_CONSTANT, borderValue=0) > 0.5
    vis_w &= in_frame

    # 4. 光影
    sigma_xy = shading_mod.anisotropic_sigma(p.relight.shading_blur_sigma, (nw, nh), (ww, wh))
    ink_dilate_work = p.relight.ink_dilate * ss  # 幀 px → 工作 px（工作空間 ≈ ss × 幀足跡）
    source = p.relight.shading_source
    if source == "auto":
        source = "template-ratio" if tmpl_orig_lin is not None else "lowpass-mean"
    if source == "template-ratio" and tmpl_orig_lin is None:
        raise ValueError("shadingSource=template-ratio 需要 tmpl_orig_rgb8")
    if source == "template-ratio":
        obs_cfg = (p.relight.observed_ink_chroma, p.relight.observed_ink_dark) if p.relight.exclude_observed_ink else None
        est = shading_mod.estimate_shading(rect, vis_w, tmpl_orig_lin, ink_orig_w, paper_w, sigma_xy=sigma_xy, ink_dilate_px=ink_dilate_work, observed_ink=obs_cfg)  # type: ignore[arg-type]
    else:
        est = shading_mod.estimate_shading_generic(rect, vis_w, sigma_xy=sigma_xy)
    if est is None:
        if shading_ref is None:
            return untouched("no-paper")
        est = _fit_ref(shading_ref, (ww, wh))
    spec = est.spec
    if p.relight.sheen_lock == "card" and shading_ref is not None:
        spec = _fit_ref(shading_ref, (ww, wh)).spec
    stats.shading_source, stats.paper_px, stats.paper_coverage = est.source, est.paper_px, est.coverage
    stats.observed_ink_px = int(est.observed_ink_px)

    # 4b. 新面加工（外掛；都在模板空間、warp 之前）：依登記順序，每一段吃上一段的輸出
    stages = hooks.face_stages()
    if stages:
        env = FaceStageEnv(
            params=p, target=target, tmpl_new_lin=tmpl_new_lin, ink_new=ink_new_w, ink_orig=ink_orig_w, paper=paper_w, barcode=barcode_w,
            paper_rgb=paper_rgb, rect=rect, shading=est, ss=ss, work_wh=(ww, wh), stats=stats,
        )
        for stage in stages:
            env.tmpl_new_lin = stage.apply(env)
        tmpl_new_lin = env.tmpl_new_lin

    # 5. 新面
    face = region_mod.compose_face(
        tmpl_new=tmpl_new_lin, rect=rect, gain=est.gain, spec=spec, paper_rgb=paper_rgb,
        policy=p.region_policy, target=target, keep_highlights=p.relight.keep_highlights,
        barcode_mask=barcode_w, barcode_feather_px=1.0 * ss,
    )
    if face is None:
        return untouched("policy")

    # 6. 幀空間渲染（ss 網格、預乘累加）
    ssw, ssh = rw * ss, rh * ss
    A = _S(ss, ss) @ _T(-x0, -y0)  # 幀連續 → ss 網格連續
    kern = _KERNELS[p.resample.kernel]
    sil_f = None if silhouette is None else silhouette.astype(np.float32)
    if p.resample.clamp:
        sel = face if silhouette is None else face[silhouette]
        lo = sel.reshape(-1, 3).min(axis=0)
        hi = sel.reshape(-1, 3).max(axis=0)
    acc_c = np.zeros((ssh, ssw, 3), dtype=np.float32)
    acc_a = np.zeros((ssh, ssw), dtype=np.float32)
    for quad_i in plan.quads:
        H_i = blur_mod.H_from_quad(quad_i, nw, nh)
        M_i = A @ H_i @ Sw  # 工作 → ss 網格
        col = cv2.warpPerspective(face, _cv(M_i), (ssw, ssh), flags=kern, borderMode=cv2.BORDER_REPLICATE)
        if p.resample.clamp:
            col = np.clip(col, lo, hi)
        a = quad_alpha(_apply(A, quad_i), ssw, ssh, float(ss), p.edge.choke, p.edge.softness, p.edge.falloff)
        if sil_f is not None:
            a *= cv2.warpPerspective(sil_f, _cv(M_i), (ssw, ssh), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        acc_c += col * a[..., None]
        acc_a += a
    n = float(plan.samples)
    colour_pm = cv2.resize(acc_c / n, (rw, rh), interpolation=cv2.INTER_AREA)
    cover = cv2.resize(acc_a / n, (rw, rh), interpolation=cv2.INTER_AREA)
    cover = np.clip(cover, 0.0, 1.0)

    # 7. 遮擋 + 8. 合成
    occl = ones_roi if alpha_vis is None else occlusion_alpha(vis_roi, p.occlusion.dilate, p.occlusion.feather)
    mix = float(p.comp.opacity * p.comp.apply_mix)
    k = occl * np.float32(mix)
    alpha = cover * k
    out_lin = frame_lin * (1.0 - alpha)[..., None] + colour_pm * k[..., None]

    # 顆粒：幀空間量測（原牌面重投影 vs 幀，在紙上）→ 合成 → 只透過 alpha 加
    if p.grain.amount > 0:
        measured = None
        if p.grain.mode == "measured":
            measured = _measure_frame_grain(frame_lin, est, A, Hm, Sw, rw, rh, ss, kern, cover, occl)
        sigma, gsrc = grain_mod.resolve_sigma(measured, p.grain.mode)
        g = grain_mod.synth_grain(rh, rw, sigma, seed=grain_mod.frame_seed(seed, frame_index, p.grain.per_frame_seed), origin=(x0, y0), blocky8x8=p.grain.blocky8x8, amount=p.grain.amount)
        gmask = alpha if p.grain.apply_through_alpha_only else (alpha > 0).astype(np.float32)
        ref = (est.base * est.gain)[est.paper].reshape(-1, 3) if est.paper.any() else frame_lin.reshape(-1, 3)
        out_lin = grain_mod.add_in_code_domain(out_lin, g, gmask, np.median(ref, axis=0))
        stats.grain_sigma, stats.grain_source = (float(sigma[0]), float(sigma[1]), float(sigma[2])), gsrc
    else:
        stats.grain_source = "off"

    # 9. 寫回
    write_mask = cv2.dilate((alpha > 0).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    out = _color.write_back(frame, roi, out_lin, frame_lin, write_mask, **cmeta) if is_yuv else _color.write_back_rgb8(frame, roi, out_lin, write_mask)
    stats.alpha_area, stats.alpha_max, stats.write_pixels = float(alpha.sum()), float(alpha.max()), int(write_mask.sum())
    return CompositeResult(out=out, stats=stats, roi=roi, alpha_roi=alpha.astype(np.float32), write_mask_roi=write_mask, shading=est, size=(W, Hh))


def _fit_ref(ref: ShadingEstimate, wh: tuple[int, int]) -> ShadingEstimate:
    """參考幀光影尺寸不同時縮放到目前工作尺寸。"""
    if ref.gain.shape[:2] == (wh[1], wh[0]):
        return ref
    g = cv2.resize(ref.gain, wh, interpolation=cv2.INTER_LINEAR)
    s = cv2.resize(ref.spec, wh, interpolation=cv2.INTER_LINEAR)
    r = cv2.resize(ref.residual, wh, interpolation=cv2.INTER_LINEAR)
    b = cv2.resize(ref.base, wh, interpolation=cv2.INTER_AREA)
    pm = cv2.resize(ref.paper.astype(np.float32), wh, interpolation=cv2.INTER_AREA) > 0.5
    return ShadingEstimate(gain=g, spec=s, residual=r, paper=pm, paper_px=int(pm.sum()), coverage=ref.coverage, source="reference", base=b)


def _measure_frame_grain(
    frame_lin: np.ndarray,
    est: ShadingEstimate,
    A: np.ndarray,
    Hm: np.ndarray,
    Sw: np.ndarray,
    rw: int,
    rh: int,
    ss: int,
    kern: int,
    cover: np.ndarray,
    occl: np.ndarray,
) -> np.ndarray | None:
    """幀空間顆粒量測：把「理想影像 × 光影 + 高光」重投影回幀（單一 H、不模糊），與幀相減，
    只看 紙 ∧ cover≈1 ∧ 未遮擋 的像素。在模板空間量會被 rect 的雙線性上採樣壓低 std，所以在幀空間量。"""
    recon = est.base * est.gain + est.spec
    M0 = _cv(A @ Hm @ Sw)
    ssw, ssh = rw * ss, rh * ss
    re = cv2.warpPerspective(recon.astype(np.float32), M0, (ssw, ssh), flags=kern, borderMode=cv2.BORDER_REPLICATE)
    pm = cv2.warpPerspective(est.paper.astype(np.float32), M0, (ssw, ssh), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    re = cv2.resize(re, (rw, rh), interpolation=cv2.INTER_AREA)
    pm = cv2.resize(pm, (rw, rh), interpolation=cv2.INTER_AREA)
    mask = (pm > 0.99) & (cover > 0.99) & (occl > 0.99)
    if int(mask.sum()) < grain_mod.MIN_SAMPLES:
        return None
    return grain_mod.measure_sigma(frame_lin - re, mask)


# ---------------------------------------------------------------------------
# 給 ops / 辨識用的矯正工具
# ---------------------------------------------------------------------------
def rectify_frame(
    frame: Yuv420 | np.ndarray,
    H: np.ndarray,
    tmpl_wh: tuple[int, int],
    out_wh: tuple[int, int] | None = None,
    *,
    matrix: str | None = None,
    color_range: str | None = None,
) -> np.ndarray:
    """整幀 → 模板空間線性 RGB（out_wh 預設 = tmpl_wh）。H 慣例同 composite_frame；matrix／color_range 同 composite_frame。"""
    Hm = _norm_H(H)
    nw, nh = tmpl_wh
    ow, oh = out_wh or tmpl_wh
    is_yuv = isinstance(frame, Yuv420)
    lin = _color.yuv420_to_linear(frame, matrix=matrix, color_range=color_range) if is_yuv else _color.rgb8_to_linear(frame)
    M = _cv(Hm @ _S(nw / ow, nh / oh))
    return cv2.warpPerspective(lin, M, (ow, oh), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
