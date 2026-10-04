"""追蹤模板：要追的表面影像（rgb8，直式 W<H）＋紙／墨遮罩＋各工作尺度的 SIFT 特徵快取。

為什麼要多尺度快取：模板可能是 630×880 的牌組 PNG，而近景牌在幀裡只有 ~125×85 px、遠景 45×35 px。
SIFT 描述子雖然尺度不變，但 ECC 是逐像素比對——模板必須縮到和 ROI 差不多的解析度，
否則 50 次迭代都在對 880 px 高的插值影像做梯度，慢又不準。尺度量化到 2^(n/2) 讓快取命中。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from ..geom import homography as hg

Array = np.ndarray

SIFT_CONTRAST = 0.02  # 預設 0.04 在低對比的印刷牌面上只剩十來個點；0.02 大約翻倍且外點由 MAGSAC 處理


def make_sift() -> cv2.SIFT:
    return cv2.SIFT_create(contrastThreshold=SIFT_CONTRAST, edgeThreshold=12)


def upright_sift(gray_u8: Array, mask: Array | None, angle_deg: float = 0.0, sift: cv2.SIFT | None = None) -> tuple[Array, Array | None]:
    """偵測 SIFT 關鍵點，把方向**全部釘成 angle_deg** 再算描述子（"upright" SIFT）。

    為什麼：娛樂場 jumbo-index 牌面的點數與花色在下緣是 180° 鏡射的複本；SIFT 描述子旋轉不變，
    所以每個特徵都有一個一模一樣的雙胞胎，2-NN ratio test 會把**全部**匹配殺光（合成牌實測 0 匹配）。
    釘死方向後雙胞胎的描述子就不同了。追蹤時模板→幀的旋轉由 H_prev 已知，幀側就釘成那個角度。
    同一位置多方向峰值的重複關鍵點在釘角度後會完全重複，依 (x,y,size) 去重。
    """
    sift = sift or make_sift()
    kps = sift.detect(gray_u8, mask)
    if not kps:
        return np.zeros((0, 2), np.float32), None
    seen: set[tuple[int, int, int]] = set()
    uniq = []
    for k in kps:
        key = (int(round(k.pt[0] * 10)), int(round(k.pt[1] * 10)), int(round(k.size * 10)))
        if key in seen:
            continue
        seen.add(key)
        k.angle = float(angle_deg % 360.0)
        uniq.append(k)
    uniq, desc = sift.compute(gray_u8, uniq)
    pts = np.array([k.pt for k in uniq], dtype=np.float32).reshape(-1, 2)
    return pts, (None if desc is None else desc.astype(np.float32))


def quantize_scale(s: float, lo: float = 1.0 / 16.0, hi: float = 8.0) -> float:
    """量化到 2^(n/2)（0.71, 1, 1.41, 2, …），並夾在 [lo, hi]。"""
    s = float(min(max(s, lo), hi))
    n = round(math.log2(s) * 2.0)
    return float(2.0 ** (n / 2.0))


@dataclass
class TemplateLevel:
    scale: float  # 名目尺度（快取鍵）
    sx: float  # 實際 x 尺度 = level 寬 / 原生寬（resize 會四捨五入到整數像素，差 0.3% 就是角點 0.5 px 偏差）
    sy: float
    gray: Array  # float32 0..1 (h,w)
    gray_u8: Array
    paper: Array  # uint8 0/255
    ink: Array  # uint8 0/255
    ecc_mask: Array  # uint8 0/255：紙面侵蝕 1 px（去掉反鋸齒邊界像素）
    kps: Array  # (N,2) float32，level 像素
    desc: Array | None  # (N,128) float32

    @property
    def wh(self) -> tuple[int, int]:
        return int(self.gray.shape[1]), int(self.gray.shape[0])


@dataclass
class Template:
    image: Array  # rgb8 (h,w,3)
    paper_mask: Array  # bool (h,w)
    ink_mask: Array  # bool (h,w)
    name: str = ""
    _levels: dict[float, TemplateLevel] = field(default_factory=dict, repr=False)

    def __init__(self, image: Array, paper_mask: Array | None = None, ink_mask: Array | None = None, name: str = "") -> None:
        img = np.asarray(image)
        if img.ndim == 2:
            img = np.repeat(img[:, :, None], 3, axis=2)
        if img.ndim != 3 or img.shape[2] not in (3, 4):
            raise ValueError(f"模板必須是 rgb8 (h,w,3)，收到 {img.shape}")
        if img.shape[2] == 4:
            alpha = img[:, :, 3]
            img = img[:, :, :3]
            if paper_mask is None:
                paper_mask = alpha > 127
        self.image = np.ascontiguousarray(img, dtype=np.uint8)
        h, w = self.image.shape[:2]
        self.paper_mask = np.ones((h, w), dtype=bool) if paper_mask is None else np.asarray(paper_mask, dtype=bool)
        if self.paper_mask.shape != (h, w):
            raise ValueError("paper_mask 尺寸與影像不符")
        if ink_mask is None:
            ink_mask = auto_ink_mask(self.image, self.paper_mask)
        self.ink_mask = np.asarray(ink_mask, dtype=bool)
        self.name = name
        self._levels = {}

    # ---- 幾何 ----
    @property
    def w(self) -> int:
        return int(self.image.shape[1])

    @property
    def h(self) -> int:
        return int(self.image.shape[0])

    @property
    def wh(self) -> tuple[int, int]:
        return self.w, self.h

    def corners(self) -> Array:
        return hg.template_corners(self.w, self.h)

    @property
    def area(self) -> float:
        return float(self.w * self.h)

    # ---- 尺度層 ----
    def level(self, scale: float) -> TemplateLevel:
        """取（或建）某工作尺度的灰階／遮罩／SIFT。scale 應先經 `quantize_scale`。"""
        key = round(float(scale), 6)
        lv = self._levels.get(key)
        if lv is None:
            lv = self._build_level(float(scale))
            self._levels[key] = lv
        return lv

    def _build_level(self, s: float) -> TemplateLevel:
        w = max(8, int(round(self.w * s)))
        h = max(8, int(round(self.h * s)))
        interp = cv2.INTER_AREA if s < 1.0 else cv2.INTER_CUBIC
        gray_full = cv2.cvtColor(self.image, cv2.COLOR_RGB2GRAY)
        gray_u8 = cv2.resize(gray_full, (w, h), interpolation=interp)
        paper = cv2.resize(self.paper_mask.astype(np.uint8) * 255, (w, h), interpolation=cv2.INTER_NEAREST)
        ink = cv2.resize(self.ink_mask.astype(np.uint8) * 255, (w, h), interpolation=cv2.INTER_NEAREST)
        ecc_mask = cv2.erode(paper, np.ones((3, 3), np.uint8))
        kps, desc = upright_sift(gray_u8, paper, 0.0)
        return TemplateLevel(
            scale=s,
            sx=w / self.w,
            sy=h / self.h,
            gray=gray_u8.astype(np.float32) / 255.0,
            gray_u8=gray_u8,
            paper=paper,
            ink=ink,
            ecc_mask=ecc_mask,
            kps=kps,
            desc=desc,
        )


def auto_ink_mask(image_rgb8: Array, paper_mask: Array) -> Array:
    """紙面內 Otsu 二值化，暗的那半當墨。全白紙（沒有墨）會回全 False。"""
    gray = cv2.cvtColor(np.asarray(image_rgb8, dtype=np.uint8), cv2.COLOR_RGB2GRAY)
    vals = gray[paper_mask]
    if vals.size < 4 or int(vals.max()) - int(vals.min()) < 24:
        return np.zeros_like(paper_mask, dtype=bool)
    thr, _ = cv2.threshold(vals.reshape(-1, 1), 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    return (gray < thr) & paper_mask


def load_template(path: str) -> Template:
    """讀任意 RGB(A) 模板圖：alpha>127 當紙面；沒有 alpha 就整張是紙。

    走 imageio（非 ASCII 路徑安全）；不存在 → FileNotFoundError，讀得到但解不出來 → ValueError。"""
    from ..imageio import imread_unicode

    try:
        img = imread_unicode(path, cv2.IMREAD_UNCHANGED)
    except OSError as e:
        raise FileNotFoundError(f"讀不到模板圖 {path}") from e
    if img.ndim == 2:
        rgb = cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)
        return Template(rgb, name=str(path))
    if img.shape[2] == 4:
        rgba = cv2.cvtColor(img, cv2.COLOR_BGRA2RGBA)
        return Template(rgba, name=str(path))
    return Template(cv2.cvtColor(img, cv2.COLOR_BGR2RGB), name=str(path))


def rectify(frame_rgb8: Array, H: Array, template_wh: tuple[int, int], scale: float = 1.0, interpolation: int = cv2.INTER_LINEAR) -> Array:
    """幀 → 模板空間（可帶超採樣 scale）。H 是模板原生 px → 幀 px。"""
    w, h = template_wh
    ow, oh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    # 用實際尺度（ow/w, oh/h）而不是名目 scale：與 Template.level 的 sx/sy 一致，否則 NCC 比對會差半像素
    M = hg.edge_to_cv(hg.normalize(H @ hg.scale_matrix(w / ow, h / oh)))  # level px → 幀 px（換成 cv2 中心慣例）
    return cv2.warpPerspective(frame_rgb8, M, (ow, oh), flags=interpolation | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)


def rounded_rect_mask(w: int, h: int, radius: float) -> Array:
    """圓角矩形紙面遮罩：像素 (i,j) 的中心 (i+½, j+½) 落在圓角矩形 [0,w]×[0,h] 內就算紙（邊界慣例）。"""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64) + 0.5
    r = float(radius)
    cx = np.clip(xx, r, w - r)
    cy = np.clip(yy, r, h - r)
    return (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r + 1e-9


def template_from_frame(frame_rgb8: Array, quad: Array, template_wh: tuple[int, int], corner_radius: float = 0.0, name: str = "") -> Template:
    """由某一幀的四角矯正出模板（E0：從乾淨靜止幀取 8♥；也是「光度輔助模板」的來源）。"""
    H = hg.template_to_quad(template_wh, quad)
    img = rectify(frame_rgb8, H, template_wh, 1.0, cv2.INTER_CUBIC)
    w, h = template_wh
    paper = rounded_rect_mask(w, h, corner_radius) if corner_radius > 0 else None
    return Template(img, paper_mask=paper, name=name)
