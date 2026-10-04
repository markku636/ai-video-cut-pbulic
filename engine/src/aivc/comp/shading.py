"""光影估計（§6.6）：S = 觀測 / 理想（每通道），墨區內插、低通、高光加回。

    paper = vis ∧ paper_mask ∧ ¬dilate(ink_orig, inkDilate)
    S     = rect / max(tmpl_orig, 1e-3)   於 paper           ← 含色彩的照明（保留桌布藍反光）
    S_lp  = 多尺度正規化卷積(S, paper 權重)                    ← 同時做「墨區內插」與「低通」
    spec  = clip(median3(rect - S_lp·tmpl_orig), 0) · paper   ← 高光加回（median 濾掉單像素顆粒，只留大面積 sheen）
    residual = rect - S_lp·tmpl_orig                          ← 給 grain 量測用（模板空間版；合成器另有幀空間量測）

為什麼用正規化卷積而不是 cv2.inpaint：inpaint 只吃 8-bit、每通道分開跑且不低通；正規化卷積（num=G(S·w)，den=G(w)）
在有紙的地方就是加權低通，在墨洞裡自然由周圍紙外插，且 float32 每通道一次做完。墨洞（大 Q、大花色）可能有
十幾個 sigma 寬，單一 sigma 填不滿，所以用 sigma×{1,2,4,8,…} 金字塔：每個像素取「最細且權重密度 ≥ 0.05」的那層，
全部都填不到的像素用紙的平均。sigma 是各向異性的（工作模板通常被透視壓扁，等向 sigma 在牌上就不是圓的）。

generic profile（沒有原模板）：`estimate_shading_generic()` 用 lowpass(rect)/mean(rect on vis) 當 S（均勻反射率假設），
tmpl_orig 視為常數＝均值，spec=0。限制：新材質的絕對亮度只能靠自己（不知道原表面 albedo），文件已註明。

A4 pull-forward（觀測墨排除）：真印刷的字形／位置與牌組模板沒有完全對齊（範例 Q♦ vs SVGCards 重排版），只排除
**模板**墨會讓真墨漏進 S（S 在那裡是 0.05–0.4 而不是 0.8），低通後變成新牌面上的淡紅／淡黑鬼影，而且低通把周圍紙的
S_lp 也拉低 → spec = rect − S_lp·tmpl 在字模旁邊變成正的「假高光」，把新墨抬亮。`detect_observed_ink()` 用兩輪：
先以「模板紙 ∧ vis ∧ ¬dilate(模板墨)」的全域中位數當紙色剔掉明顯的墨，再對剩下的紙做大 sigma 正規化卷積得到**局部**
紙色（漸層與桌布藍反光都留在局部估計裡，不會被當成墨），最後逐像素比：色度座標差 > chroma 或亮度 < dark×局部紙亮度
→ 墨。觀測墨再膨脹 inkDilate 後與模板墨聯集排除，洞由同一個多尺度正規化卷積補。
"""
from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

MIN_PAPER_PX = 32
DENSITY_ACCEPT = 0.05


@dataclass
class ShadingEstimate:
    gain: np.ndarray  # S_lp (h,w,3) float32；乘到 tmpl_new 上
    spec: np.ndarray  # (h,w,3) float32 ≥ 0，paper 外為 0
    residual: np.ndarray  # rect - gain·base (h,w,3)，只有 paper 上有意義
    paper: np.ndarray  # bool (h,w)：實際用到的紙像素
    paper_px: int
    coverage: float  # paper_px / (paper_mask 且非墨) —— 手遮多少
    source: str  # "template-ratio" | "lowpass-mean" | "reference"
    base: np.ndarray  # (h,w,3) 「理想」影像：template-ratio＝tmpl_orig；lowpass-mean＝常數均值。recon = base·gain + spec
    observed_ink_px: int = 0  # A4：被 detect_observed_ink 額外排除的像素數（0 = 沒開或沒偵測到）
    observed_ink: np.ndarray | None = None  # A4：觀測墨遮罩（未膨脹；給 ink.match_ink 取墨反射率）


def dilate_mask(mask: np.ndarray, radius_px: float) -> np.ndarray:
    """bool 遮罩以橢圓核膨脹 radius（四捨五入到整數 px；0 → 不動）。"""
    r = int(round(radius_px))
    if r <= 0:
        return mask.astype(bool)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
    return cv2.dilate(mask.astype(np.uint8), k).astype(bool)


def normalized_conv_fill(values: np.ndarray, weight: np.ndarray, sigma_xy: tuple[float, float], fallback: np.ndarray) -> np.ndarray:
    """多尺度正規化卷積：values (h,w,3)、weight (h,w) 0..1 → 每像素都有值的 (h,w,3)。"""
    h, w = weight.shape
    sx, sy = max(float(sigma_xy[0]), 0.3), max(float(sigma_xy[1]), 0.3)
    wv = values * weight[..., None]
    out = np.zeros_like(values, dtype=np.float32)
    have = np.zeros((h, w), dtype=bool)
    scale = 1.0
    limit = 2.0 * max(h, w)
    while True:
        cur_sx, cur_sy = sx * scale, sy * scale
        num = cv2.GaussianBlur(wv, (0, 0), sigmaX=cur_sx, sigmaY=cur_sy, borderType=cv2.BORDER_REFLECT)
        den = cv2.GaussianBlur(weight, (0, 0), sigmaX=cur_sx, sigmaY=cur_sy, borderType=cv2.BORDER_REFLECT)
        ok = (den > DENSITY_ACCEPT) & ~have
        if ok.any():
            out[ok] = num[ok] / den[ok][:, None]
            have |= ok
        if have.all() or max(cur_sx, cur_sy) > limit:
            break
        scale *= 2.0
    if not have.all():
        out[~have] = fallback
    return out


def luma(lin: np.ndarray) -> np.ndarray:
    """BT.709 線性亮度 (…,3) → (…)。"""
    return 0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]


def chromaticity(lin: np.ndarray) -> np.ndarray:
    """色度座標 c = rgb / Σrgb（對亮度不變；紙 ≈ (⅓,⅓,⅓)+藍偏，紅墨 ≈ (0.8,0.12,0.07)）。"""
    s = np.maximum(lin.sum(axis=-1, keepdims=True), np.float32(1e-4))
    return (lin / s).astype(np.float32)


def detect_observed_ink(
    rect: np.ndarray,
    candidate: np.ndarray,
    *,
    chroma_thresh: float,
    dark_thresh: float,
    sigma_xy: tuple[float, float],
    search: np.ndarray | None = None,
) -> np.ndarray:
    """觀測到的墨（bool (h,w)）：與**局部**紙色相比，色度差 > chroma_thresh 或亮度 < dark_thresh × 紙亮度。

    candidate 是「可能是紙」的像素（模板紙 ∧ vis ∧ ¬dilate(模板墨)），只用來估紙色；search 是判定範圍（None ＝ candidate）。
    光影排除只需要 candidate 內的結果，但墨色比對（ink.match_ink）要真墨的**核心**，核心大多落在模板墨裡，所以呼叫端給
    search = 模板紙 ∧ vis。
    局部紙色用大 sigma（4× 光影 sigma、至少 6 px）的正規化卷積：太小會把每個字模旁的紙一起拉低、太大會吃掉漸層。
    """
    h, w = rect.shape[:2]
    cand = candidate.astype(bool)
    if int(cand.sum()) < MIN_PAPER_PX:
        return np.zeros((h, w), dtype=bool)
    # 第一輪：全域中位數紙色 → 剔掉明顯的墨（避免真墨拉低局部紙色估計）
    paper0 = np.median(rect[cand], axis=0).astype(np.float32)
    c0 = paper0 / max(float(paper0.sum()), 1e-4)
    l0 = float(luma(paper0[None])[0])
    c = chromaticity(rect)
    L = luma(rect)
    ink1 = (np.abs(c - c0[None, None, :]).max(axis=-1) > chroma_thresh) | (L < dark_thresh * l0)
    w1 = (cand & ~ink1).astype(np.float32)
    if float(w1.sum()) < MIN_PAPER_PX:
        w1 = cand.astype(np.float32)
    # 第二輪：局部紙色（正規化卷積，權重 = 第一輪認定的紙）
    sx, sy = max(4.0 * float(sigma_xy[0]), 6.0), max(4.0 * float(sigma_xy[1]), 6.0)
    local = normalized_conv_fill(rect, w1, (sx, sy), paper0)
    cl = chromaticity(local)
    ll = np.maximum(luma(local), np.float32(1e-4))
    ink2 = (np.abs(c - cl).max(axis=-1) > chroma_thresh) | (L < dark_thresh * ll)
    return ink2 & (cand if search is None else search.astype(bool))


def estimate_shading(
    rect: np.ndarray,
    vis: np.ndarray,
    tmpl_orig: np.ndarray,
    ink_orig: np.ndarray,
    paper_mask: np.ndarray | None,
    *,
    sigma_xy: tuple[float, float],
    ink_dilate_px: float,
    observed_ink: tuple[float, float] | None = None,
) -> ShadingEstimate | None:
    """template-ratio 光影。rect/tmpl_orig 同尺寸線性 (h,w,3)；vis、ink_orig、paper_mask 是 bool (h,w)。
    observed_ink=(chroma_thresh, dark_thresh) → 連觀測到的真墨（`detect_observed_ink`）一起排除；None ＝ 只排模板墨（舊行為）。
    紙像素不足（< MIN_PAPER_PX）→ None，由呼叫端決定 hold 或用參考幀。"""
    h, w = rect.shape[:2]
    pm = np.ones((h, w), dtype=bool) if paper_mask is None else paper_mask.astype(bool)
    ink_d = dilate_mask(ink_orig, ink_dilate_px)
    usable = pm & ~ink_d  # coverage 的分母：只看模板（手遮多少），不受觀測墨影響
    paper = usable & vis.astype(bool)
    obs_px = 0
    obs: np.ndarray | None = None
    if observed_ink is not None:
        obs = detect_observed_ink(rect, paper, chroma_thresh=observed_ink[0], dark_thresh=observed_ink[1], sigma_xy=sigma_xy, search=pm & vis.astype(bool))
        leak = obs & paper  # 模板墨膨脹圈外的真墨 ＝ 會漏進 S 的部分
        obs_px = int(leak.sum())
        if obs_px:
            paper &= ~dilate_mask(leak, ink_dilate_px)
    n = int(paper.sum())
    if n < MIN_PAPER_PX:
        return None
    denom = np.maximum(tmpl_orig, np.float32(1e-3))
    S = np.where(paper[..., None], rect / denom, 0.0).astype(np.float32)
    S = np.nan_to_num(S, nan=0.0, posinf=0.0, neginf=0.0)
    fallback = S[paper].mean(axis=0).astype(np.float32)
    gain = normalized_conv_fill(S, paper.astype(np.float32), sigma_xy, fallback)
    # 光影不該是負的；上限放寬到 8×（強高光），避免 1e-3 分母造成的天文數字
    gain = np.clip(gain, 0.0, 8.0)
    residual = (rect - gain * tmpl_orig).astype(np.float32)
    spec = cv2.medianBlur(residual, 3) if min(h, w) >= 3 else residual
    spec = np.clip(spec, 0.0, None) * paper[..., None]
    return ShadingEstimate(
        gain=gain,
        spec=spec.astype(np.float32),
        residual=residual,
        paper=paper,
        paper_px=n,
        coverage=float(n / max(int(usable.sum()), 1)),
        source="template-ratio",
        base=tmpl_orig.astype(np.float32, copy=False),
        observed_ink_px=obs_px,
        observed_ink=obs,
    )


def estimate_shading_generic(rect: np.ndarray, vis: np.ndarray, *, sigma_xy: tuple[float, float]) -> ShadingEstimate | None:
    """generic profile：S = lowpass(rect)/mean(rect on vis)，均勻反射率假設；spec=0。"""
    v = vis.astype(bool)
    n = int(v.sum())
    if n < MIN_PAPER_PX:
        return None
    mean = rect[v].mean(axis=0).astype(np.float32)
    mean = np.maximum(mean, np.float32(1e-3))
    rel = (rect / mean).astype(np.float32)
    gain = normalized_conv_fill(np.where(v[..., None], rel, 0.0).astype(np.float32), v.astype(np.float32), sigma_xy, np.ones(3, np.float32))
    gain = np.clip(gain, 0.0, 8.0)
    residual = (rect - gain * mean).astype(np.float32)
    base = np.empty_like(rect, dtype=np.float32)
    base[...] = mean.reshape(1, 1, 3)
    return ShadingEstimate(
        gain=gain,
        spec=np.zeros_like(rect, dtype=np.float32),
        residual=residual,
        paper=v,
        paper_px=n,
        coverage=float(n / v.size),
        source="lowpass-mean",
        base=base,
    )


def anisotropic_sigma(short_side_frac: float, tmpl_native_wh: tuple[int, int], work_wh: tuple[int, int]) -> tuple[float, float]:
    """shadingBlurSigma（牌短邊比例）→ 工作空間 (sigma_x, sigma_y)。短邊以原生模板算（牌的物理短邊），再各軸按縮放比換算。"""
    nw, nh = tmpl_native_wh
    ww, wh = work_wh
    short_native = float(min(nw, nh))
    s = short_side_frac * short_native
    return s * (ww / nw), s * (wh / nh)
