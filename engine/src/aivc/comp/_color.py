"""yuv420p（BT.709／BT.601、limited(tv)／full(pc) range）↔ 線性 full-range float32 RGB（計畫 §5.2）。

**這是 comp 模組自己的小實作**；media/color.py 由另一位同時撰寫，整合者之後去重。
精確定義（整合時請對照 media/color.py，兩邊必須一致，否則遮罩邊界會偷移 16/255）：

矩陣（預設 BT.709，Kr=0.2126、Kg=0.7152、Kb=0.0722；BT.601 是 Kr=0.299、Kg=0.587、Kb=0.114）
    limited(tv)：Y' 16..235 → 0..1，Cb/Cr 16..240 → -0.5..0.5
        y  = (Y' - 16) / 219,  cb = (Cb - 128) / 224,  cr = (Cr - 128) / 224
    full(pc)：與 media/color.py 相同用 255
        y  = Y' / 255,         cb = (Cb - 128) / 255,  cr = (Cr - 128) / 255
    R' = y + 2(1-Kr)·cr
    G' = y - Kb/Kg·2(1-Kb)·cb - Kr/Kg·2(1-Kr)·cr     # BT.709：0.18733、0.46813
    B' = y + 2(1-Kb)·cb
反向：y = Kr·R' + Kg·G' + Kb·B'，cb = (B' - y)/(2(1-Kb))，cr = (R' - y)/(2(1-Kr))。
矩陣／range 從 `Yuv420.matrix`／`Yuv420.color_range` 讀（預設 bt709／tv，舊呼叫端行為不變），也可以用參數覆寫。
為什麼不能寫死 BT.709 tv：SD 未標色彩的來源（高 < 576）在 probe 被判成 BT.601，手機／OBS 錄影常是 full range；
用錯矩陣新牌面的飽和紅會偏色（0.8/0.1/0.1 → 約 0.74/0.03/0.11），用錯 range 則整片牌面的黑白位準都錯。

轉移函數：**BT.709 OETF 的反函數**（Nuke 的 "rec709" colourspace；不是 BT.1886 gamma 2.4）
    V' < 0.081 : L = V'/4.5            （負值走同一線性段，讓 limited-range 的下衝可逆）
    否則       : L = ((V'+0.099)/1.099)^(1/0.45)
    正向對稱：L < 0.018 : V' = 4.5·L；否則 V' = 1.099·L^0.45 - 0.099
為什麼選 OETF⁻¹ 而不是 BT.1886：合成數學（比值重打光、線性混合）只需要「近似場景線性」且**可精確往返**；
OETF⁻¹ 有解析反函數，往返誤差 < 1e-6，BT.1886 的顯示端 gamma 2.4 對場景線性沒有更對。

色度：4:2:0 → 全解析度用 nearest（每個 2×2 區塊共用一個色度樣本；與 INTER_AREA 的 2×2 平均互為精確反函數，
write_back 的差值才不會在區塊邊界產生假差值）。media/color.py 為顯示用途採雙線性；合成器只能用這一套。
全解析度 → 4:2:0 用 2×2 平均（INTER_AREA）。

奇數尺寸（VP9／H.264 都允許，例如 853×481）：色度平面是 ceil(W/2)×ceil(H/2)，最後一欄／列色度樣本只蓋到 1 個亮度像素。
ROI 的起點必須偶數，終點必須偶數**或剛好是奇數的畫面邊緣**；色度索引一律用 ceil 對應，邊緣區塊的 2×2 平均只算畫面內的像素
（先複製邊緣補成偶數再平均，等價於「畫面內像素的平均」，仍是 nearest 上採樣的精確反函數）。

寫回紀律（`write_back`）：只改 `write_mask`（＝dilate(alpha>0, 1px)）內的 Y，色度只改 2×2 max-pool 後的樣本；
而且是**寫差值**：new = orig + round((forward(out) - forward(orig_roundtrip))·scale)。alpha=0 的像素 out==orig
→ 差值恰為 0 → 位元不變；邊界色度區塊只吸收有變動的那幾個像素的差值（面積平均），這就是 §5.2 要的
「遮罩外逐位元相同、遮罩內正確」。有變動的樣本夾在合法範圍（tv：Y 16..235、C 16..240；pc：0..255），
但範圍會放寬到包含原值：原本就在範圍外的 super-white／sub-black（例如 tv 來源的 Y=248、雜訊下衝 Y=8）
差值為 0 時一個位元都不動，差值小時也不會被硬拉回 235／16 造成跳階。
"""
from __future__ import annotations

from typing import NamedTuple

import cv2
import numpy as np

KR, KG, KB = 0.2126, 0.7152, 0.0722
_CB_SCALE = 2.0 * (1.0 - KB)  # 1.8556
_CR_SCALE = 2.0 * (1.0 - KR)  # 1.5748
_G_CB = KB / KG * _CB_SCALE  # 0.18733
_G_CR = KR / KG * _CR_SCALE  # 0.46813

Y_MIN, Y_MAX, Y_RANGE = 16.0, 235.0, 219.0
C_MIN, C_MAX, C_RANGE, C_ZERO = 16.0, 240.0, 224.0, 128.0


class _Matrix(NamedTuple):
    kr: float
    kg: float
    kb: float
    cb_scale: float  # 2(1-Kb)
    cr_scale: float  # 2(1-Kr)
    g_cb: float  # Kb/Kg·2(1-Kb)
    g_cr: float  # Kr/Kg·2(1-Kr)


def _make_matrix(kr: float, kg: float, kb: float) -> _Matrix:
    # Kg 用字面值、不用 1-Kr-Kb：BT.709 的衍生係數必須與舊版逐位元相同（float64 尾數差一點點就可能翻 float32 的最後一位）
    cb, cr = 2.0 * (1.0 - kb), 2.0 * (1.0 - kr)
    return _Matrix(kr, kg, kb, cb, cr, kb / kg * cb, kr / kg * cr)


_MATRICES: dict[str, _Matrix] = {
    "bt709": _make_matrix(KR, KG, KB),
    "bt601": _make_matrix(0.299, 0.587, 0.114),
}


class _Range(NamedTuple):
    y_off: float
    y_scale: float
    c_scale: float
    y_lo: float
    y_hi: float
    c_lo: float
    c_hi: float


_RANGES: dict[str, _Range] = {
    "tv": _Range(Y_MIN, Y_RANGE, C_RANGE, Y_MIN, Y_MAX, C_MIN, C_MAX),
    "pc": _Range(0.0, 255.0, 255.0, 0.0, 255.0, 0.0, 255.0),
}


def matrix_coeffs(matrix: str) -> _Matrix:
    try:
        return _MATRICES[matrix]
    except KeyError as e:
        raise ValueError(f"未知矩陣 {matrix!r}（bt709|bt601）") from e


# probe 走 ffprobe 退路時 color_range 可能是 "unknown"／None；與 media/color.py（只有 "pc" 才算 full）同義地當 tv，
# 但拼錯的字仍然擲錯，免得默默用錯 range
_RANGE_ALIASES = {"pc": "pc", "full": "pc", "jpeg": "pc", "tv": "tv", "limited": "tv", "mpeg": "tv", "unknown": "tv", "unspecified": "tv", "": "tv"}


def normalize_range(color_range: str | None) -> str:
    if color_range is None:
        return "tv"
    try:
        return _RANGE_ALIASES[str(color_range).lower()]
    except KeyError as e:
        raise ValueError(f"未知 color_range {color_range!r}（tv|pc）") from e


def range_params(color_range: str | None) -> _Range:
    return _RANGES[normalize_range(color_range)]


class Yuv420(NamedTuple):
    """yuv420p 三個平面（uint8）。y: (H,W)，u/v: (ceil(H/2),ceil(W/2))。

    matrix／color_range 是這幀的色彩中繼資料（bt709|bt601、tv|pc），合成器的 yuv↔線性轉換照它走；
    預設 bt709／tv 讓只給三個平面的舊呼叫端行為不變。"""

    y: np.ndarray
    u: np.ndarray
    v: np.ndarray
    matrix: str = "bt709"
    color_range: str = "tv"

    @property
    def size(self) -> tuple[int, int]:
        """(W, H)。"""
        return int(self.y.shape[1]), int(self.y.shape[0])

    def copy(self) -> "Yuv420":
        return Yuv420(self.y.copy(), self.u.copy(), self.v.copy(), self.matrix, self.color_range)


def _meta(planes: object, matrix: str | None, color_range: str | None) -> tuple[str, str]:
    """參數優先，否則讀平面自己的中繼資料（沒有就 bt709／tv）。"""
    m = matrix or getattr(planes, "matrix", None) or "bt709"
    r = normalize_range(color_range or getattr(planes, "color_range", None))
    matrix_coeffs(m)
    return m, r


# ---------------------------------------------------------------------------
# 轉移函數
# ---------------------------------------------------------------------------
def oetf_inverse(v: np.ndarray) -> np.ndarray:
    """BT.709 V' → 線性 L（float32）。"""
    v = np.asarray(v, dtype=np.float32)
    lo = v / np.float32(4.5)
    hi = np.power(np.maximum((v + np.float32(0.099)) / np.float32(1.099), 0.0, dtype=np.float32), np.float32(1.0 / 0.45))
    return np.where(v < np.float32(0.081), lo, hi).astype(np.float32, copy=False)


def oetf(l: np.ndarray) -> np.ndarray:
    """線性 L → BT.709 V'（float32）。"""
    l = np.asarray(l, dtype=np.float32)
    lo = l * np.float32(4.5)
    hi = np.float32(1.099) * np.power(np.maximum(l, 0.0, dtype=np.float32), np.float32(0.45)) - np.float32(0.099)
    return np.where(l < np.float32(0.018), lo, hi).astype(np.float32, copy=False)


# ---------------------------------------------------------------------------
# yuv420p → 線性 RGB
# ---------------------------------------------------------------------------
def ycbcr_to_linear(y: np.ndarray, cb: np.ndarray, cr: np.ndarray, matrix: str = "bt709") -> np.ndarray:
    """已正規化（y 0..1、cb/cr -0.5..0.5）且同解析度的三平面 → 線性 RGB (H,W,3)。"""
    k = matrix_coeffs(matrix)
    r = y + np.float32(k.cr_scale) * cr
    g = y - np.float32(k.g_cb) * cb - np.float32(k.g_cr) * cr
    b = y + np.float32(k.cb_scale) * cb
    return oetf_inverse(np.stack([r, g, b], axis=-1))


def _chroma_up_nearest(c: np.ndarray, w: int, h: int) -> np.ndarray:
    """色度 (ceil(h/2), ceil(w/2)) → 亮度 (h, w)：整數 2 倍 nearest 再裁掉奇數邊多出來的那一欄／列。"""
    ch, cw = c.shape
    up = cv2.resize(c, (2 * cw, 2 * ch), interpolation=cv2.INTER_NEAREST)
    return up[:h, :w]


def yuv420_to_linear(
    planes: Yuv420,
    roi: tuple[int, int, int, int] | None = None,
    *,
    matrix: str | None = None,
    color_range: str | None = None,
) -> np.ndarray:
    """yuv420p → 線性 RGB float32 (h,w,3)。

    roi=(x0,y0,x1,y1)：起點偶數對齊；終點偶數或剛好是奇數畫面邊緣。只轉該區域，色度多取 2 個樣本的邊，
    裁回後與整幅轉換**逐值相同**，這樣 ROI 邊界不會有「多做一次插值」的差異。
    matrix／color_range 預設讀 planes 的中繼資料。
    """
    mat, rng = _meta(planes, matrix, color_range)
    rp = range_params(rng)
    W, H = planes.size
    if roi is None:
        roi = (0, 0, W, H)
    x0, y0, x1, y1 = roi
    _check_even_roi(roi, W, H)
    pad = 4  # 亮度 px（= 2 色度樣本）
    px0, py0 = max(0, x0 - pad), max(0, y0 - pad)
    px1, py1 = min(W, x1 + pad), min(H, y1 + pad)
    y = (planes.y[py0:py1, px0:px1].astype(np.float32) - np.float32(rp.y_off)) / np.float32(rp.y_scale)
    # 色度索引用 ceil：px1 是奇數畫面邊緣時，最後一欄亮度仍要對到最後一個色度樣本（floor 會掉一欄 → nearest 把色度錯位 1 px）
    cx0, cx1, cy0, cy1 = px0 // 2, (px1 + 1) // 2, py0 // 2, (py1 + 1) // 2
    u = (planes.u[cy0:cy1, cx0:cx1].astype(np.float32) - np.float32(C_ZERO)) / np.float32(rp.c_scale)
    v = (planes.v[cy0:cy1, cx0:cx1].astype(np.float32) - np.float32(C_ZERO)) / np.float32(rp.c_scale)
    # nearest（每個 2×2 亮度區塊共用同一個色度樣本）而不是雙線性：write_back 寫的是差值，分析用的正向轉換
    # 必須能被 INTER_AREA 的 2×2 平均精確反轉，否則 identity 替換都會在色度區塊邊界留下 ±幾十 LSB 的假差值。
    # 代價是牌面內色度估計少了半像素的平滑，對 120 px 的牌與 1.5% 短邊的光影低通完全看不出來。
    uf = _chroma_up_nearest(u, px1 - px0, py1 - py0)
    vf = _chroma_up_nearest(v, px1 - px0, py1 - py0)
    rgb = ycbcr_to_linear(y, uf, vf, mat)
    return np.ascontiguousarray(rgb[y0 - py0 : y1 - py0, x0 - px0 : x1 - px0])


def yuv420_to_linear_bilinear(
    planes: Yuv420,
    roi: tuple[int, int, int, int] | None = None,
    *,
    matrix: str | None = None,
    color_range: str | None = None,
    chroma_location: str = "left",
    chroma_guided: bool = False,
    chroma_guided_radius: int = 2,
    chroma_guided_eps: float = 1e-3,
) -> tuple[np.ndarray, np.ndarray]:
    """yuv420p → (線性 RGB float32 (h,w,3), Y' 0..1 float32 (h,w))，色度用**雙線性**上採樣（可再用 Y′ 導引貼邊）。**只給分析用**。

    為什麼要另一條：`yuv420_to_linear` 故意用 nearest（每個 2×2 亮度區塊共用一個色度樣本），這樣 write_back 的差值
    才能被 INTER_AREA 精確反轉、位元不動；代價是色度在 2 px 的格子上跳，拿它算「像紙分數」會把手指邊界切成 2 px 階梯
    （2026-09-18 occlusion 階段：光是改雙線性，合成真值的鋸齒就從 10.9/100 px 降到 7.85，理想輪廓自己是 8.1）。
    寫回照舊用 nearest 的 `frame_lin`，這裡算出來的只進 matte。

    chroma_location：色度樣本相對亮度格的位置。"left"（MPEG-2／H.264 預設，本專案來源就是）＝水平與偶數欄共位、
    垂直置中 → 亮度 (x, y) 對到色度 (x/2, (y−0.5)/2)；"center"（JPEG/MPEG-1）＝兩軸都置中。
    """
    mat, rng = _meta(planes, matrix, color_range)
    rp = range_params(rng)
    W, H = planes.size
    if roi is None:
        roi = (0, 0, W, H)
    x0, y0, x1, y1 = roi
    _check_even_roi(roi, W, H)
    pad = 4  # 亮度 px（= 2 色度樣本）：雙線性只要 1 個樣本的邊，取 2 個保證裁回後與整幅轉換逐值相同
    px0, py0 = max(0, x0 - pad), max(0, y0 - pad)
    px1, py1 = min(W, x1 + pad), min(H, y1 + pad)
    yg = (planes.y[y0:y1, x0:x1].astype(np.float32) - np.float32(rp.y_off)) / np.float32(rp.y_scale)
    cx0, cx1, cy0, cy1 = px0 // 2, (px1 + 1) // 2, py0 // 2, (py1 + 1) // 2
    u = (planes.u[cy0:cy1, cx0:cx1].astype(np.float32) - np.float32(C_ZERO)) / np.float32(rp.c_scale)
    v = (planes.v[cy0:cy1, cx0:cx1].astype(np.float32) - np.float32(C_ZERO)) / np.float32(rp.c_scale)
    if chroma_location not in ("left", "center"):
        raise ValueError(f"未知 chroma_location {chroma_location!r}（left|center）")
    dy = 0.5 if chroma_location == "left" else 0.0  # left：垂直置中；center：兩軸都置中
    dx = 0.0 if chroma_location == "left" else 0.5
    xs = (np.arange(x0, x1, dtype=np.float32) - np.float32(dx)) / np.float32(2.0) - np.float32(cx0)
    ys = (np.arange(y0, y1, dtype=np.float32) - np.float32(dy)) / np.float32(2.0) - np.float32(cy0)
    mx, my = np.meshgrid(xs, ys)
    uf = cv2.remap(u, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    vf = cv2.remap(v, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    if chroma_guided:
        # 4:2:0 的色度只有一半解析度，雙線性上採樣後手指↔紙的色度邊界寬 2 px；用全解析度的 Y′ 當導引把色度
        # 邊貼齊亮度邊（He et al. guided filter）。手指與白紙在亮度上有清楚的階梯，色度自然跟著；
        # 平坦區（紙、皮膚內部）a≈0 → 退回 box 平均，不會放大色度雜訊。只影響 matte，寫回路徑不動。
        uf = _guided(yg, uf, chroma_guided_radius, chroma_guided_eps)
        vf = _guided(yg, vf, chroma_guided_radius, chroma_guided_eps)
    return np.ascontiguousarray(ycbcr_to_linear(yg, uf, vf, mat)), np.ascontiguousarray(yg)


def _guided(guide: np.ndarray, src: np.ndarray, radius: int, eps: float) -> np.ndarray:
    """單通道 guided filter（box 版，He et al. 2010 的標準式）。外掛裡有同式的一份；核心不依賴外掛，各自一份。"""
    r = max(int(radius), 1)
    k = (2 * r + 1, 2 * r + 1)

    def box(a: np.ndarray) -> np.ndarray:
        return cv2.boxFilter(a, -1, k, normalize=True, borderType=cv2.BORDER_REFLECT)

    g = guide.astype(np.float32)
    p_ = src.astype(np.float32)
    mg, mp = box(g), box(p_)
    a = (box(g * p_) - mg * mp) / (box(g * g) - mg * mg + np.float32(eps))
    b = mp - a * mg
    return (box(a) * g + box(b)).astype(np.float32)


def gamma_luma(lin: np.ndarray) -> np.ndarray:
    """線性 RGB → Y'（gamma 域亮度 0..1）。給沒有 yuv 平面的 rgb8 呼叫端（單元測試）當 guided filter 的導引影像。"""
    g = oetf(lin)
    return (np.float32(0.2126) * g[..., 0] + np.float32(0.7152) * g[..., 1] + np.float32(0.0722) * g[..., 2]).astype(np.float32)


# ---------------------------------------------------------------------------
# 線性 RGB → Y'CbCr（全解析度、正規化單位）
# ---------------------------------------------------------------------------
def linear_to_ycbcr(rgb_lin: np.ndarray, matrix: str = "bt709") -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    k = matrix_coeffs(matrix)
    p = oetf(rgb_lin)
    r, g, b = p[..., 0], p[..., 1], p[..., 2]
    y = np.float32(k.kr) * r + np.float32(k.kg) * g + np.float32(k.kb) * b
    cb = (b - y) / np.float32(k.cb_scale)
    cr = (r - y) / np.float32(k.cr_scale)
    return y, cb, cr


def _chroma_down_area(c: np.ndarray, cw: int, ch: int) -> np.ndarray:
    """全解析度 (h,w) → 色度 (ch,cw) 的 2×2 平均。奇數邊先複製邊緣補成偶數：邊緣區塊的平均＝畫面內那 1～2 個像素的平均。"""
    h, w = c.shape
    if (h, w) != (2 * ch, 2 * cw):
        c = np.pad(c, ((0, 2 * ch - h), (0, 2 * cw - w)), mode="edge")
    return cv2.resize(c, (cw, ch), interpolation=cv2.INTER_AREA)


def linear_to_yuv420(rgb_lin: np.ndarray, matrix: str = "bt709", color_range: str = "tv") -> Yuv420:
    """整幅線性 RGB → yuv420p（測試／預覽用的正向量化；合成器本體走 write_back）。奇數尺寸的色度是 ceil(W/2)×ceil(H/2)。"""
    rp = range_params(color_range)
    h, w = rgb_lin.shape[:2]
    y, cb, cr = linear_to_ycbcr(rgb_lin, matrix)
    cw, ch = (w + 1) // 2, (h + 1) // 2
    Y = np.clip(np.floor(y * np.float32(rp.y_scale) + np.float32(rp.y_off) + 0.5), 0, 255).astype(np.uint8)
    cb2 = _chroma_down_area(cb, cw, ch)
    cr2 = _chroma_down_area(cr, cw, ch)
    U = np.clip(np.floor(cb2 * np.float32(rp.c_scale) + C_ZERO + 0.5), 0, 255).astype(np.uint8)
    V = np.clip(np.floor(cr2 * np.float32(rp.c_scale) + C_ZERO + 0.5), 0, 255).astype(np.uint8)
    return Yuv420(Y, U, V, matrix, normalize_range(color_range))


# ---------------------------------------------------------------------------
# 8-bit RGB（PNG／預覽）
# ---------------------------------------------------------------------------
def rgb8_to_linear(rgb8: np.ndarray) -> np.ndarray:
    """8-bit gamma RGB（視為 BT.709 OETF 編碼、full range）→ 線性。模板 PNG 與幀都走這條，比值才一致。"""
    return oetf_inverse(rgb8.astype(np.float32) / np.float32(255.0))


def linear_to_rgb8(rgb_lin: np.ndarray) -> np.ndarray:
    return np.clip(np.floor(oetf(rgb_lin) * 255.0 + 0.5), 0, 255).astype(np.uint8)


def rgb8_to_yuv420(rgb8: np.ndarray, matrix: str = "bt709", color_range: str = "tv") -> Yuv420:
    return linear_to_yuv420(rgb8_to_linear(rgb8), matrix, color_range)


def yuv420_to_rgb8(planes: Yuv420) -> np.ndarray:
    return linear_to_rgb8(yuv420_to_linear(planes))


# ---------------------------------------------------------------------------
# 寫回
# ---------------------------------------------------------------------------
def chroma_write_mask(write_mask: np.ndarray) -> np.ndarray:
    """亮度寫回遮罩 → 色度遮罩（2×2 max-pool；奇數邊補 False，輸出 ceil(h/2)×ceil(w/2)）。"""
    h, w = write_mask.shape
    if h % 2 or w % 2:
        write_mask = np.pad(write_mask, ((0, h % 2), (0, w % 2)), mode="constant", constant_values=False)
        h, w = write_mask.shape
    m = write_mask.reshape(h // 2, 2, w // 2, 2)
    return m.any(axis=(1, 3))


def _add_delta(orig: np.ndarray, delta_code: np.ndarray, lo: float, hi: float) -> np.ndarray:
    """orig（uint8）＋碼值差 → 新值（float32，已四捨五入並夾範圍）。

    夾的範圍放寬到包含原值 [min(lo, orig), max(hi, orig)]：差值 0 的像素（alpha=0 的外圈、identity 替換）保證位元不變，
    即使原值本來就在 tv 合法範圍外（super-white 248、下衝 8）；舊版直接夾 16..235 會把這些像素改成 235／16，
    違反「alpha=0 位元不變」。範圍內原值的結果與舊公式逐位元相同。"""
    o = orig.astype(np.float32)
    new = np.floor(o + delta_code + np.float32(0.5))
    return np.clip(new, np.minimum(o, np.float32(lo)), np.maximum(o, np.float32(hi)))


def write_back(
    planes: Yuv420,
    roi: tuple[int, int, int, int],
    out_lin_roi: np.ndarray,
    orig_lin_roi: np.ndarray,
    write_mask_roi: np.ndarray,
    *,
    matrix: str | None = None,
    color_range: str | None = None,
) -> Yuv420:
    """把 ROI 內的合成結果寫回新的平面副本；write_mask 外的位元組保證與輸入相同。

    參數：roi 起點偶數、終點偶數或奇數畫面邊緣；out/orig 都是 ROI 的線性 RGB；write_mask_roi 是 bool (h,w)。
    matrix／color_range 預設讀 planes 的中繼資料（必須與產生 orig_lin_roi 的 yuv420_to_linear 相同），回傳的平面帶同一組中繼資料。
    """
    mat, rng = _meta(planes, matrix, color_range)
    rp = range_params(rng)
    x0, y0, x1, y1 = roi
    W, H = planes.size
    _check_even_roi(roi, W, H)
    if out_lin_roi.shape != orig_lin_roi.shape or out_lin_roi.shape[:2] != (y1 - y0, x1 - x0):
        raise ValueError("out/orig ROI 尺寸不符")
    if write_mask_roi.shape != (y1 - y0, x1 - x0):
        raise ValueError("write_mask ROI 尺寸不符")
    yo, cbo, cro = linear_to_ycbcr(np.nan_to_num(out_lin_roi, nan=0.0, posinf=0.0, neginf=0.0), mat)
    yr, cbr, crr = linear_to_ycbcr(orig_lin_roi, mat)
    mask = write_mask_roi.astype(bool)

    Y = planes.y.copy()
    sub = Y[y0:y1, x0:x1]
    new_y = _add_delta(sub, (yo - yr) * np.float32(rp.y_scale), rp.y_lo, rp.y_hi)
    sub[mask] = new_y[mask].astype(np.uint8)

    # 奇數畫面邊緣：ROI 寬／高可能是奇數，色度樣本數用 ceil（x0／y0 一定偶數，所以色度起點是 x0/2、y0/2）
    cw, ch = (x1 - x0 + 1) // 2, (y1 - y0 + 1) // 2
    dcb = _chroma_down_area(cbo - cbr, cw, ch)
    dcr = _chroma_down_area(cro - crr, cw, ch)
    mask2 = chroma_write_mask(mask)
    U, V = planes.u.copy(), planes.v.copy()
    su = U[y0 // 2 : y0 // 2 + ch, x0 // 2 : x0 // 2 + cw]
    sv = V[y0 // 2 : y0 // 2 + ch, x0 // 2 : x0 // 2 + cw]
    if su.shape != (ch, cw) or sv.shape != (ch, cw):
        raise ValueError(f"色度平面 {U.shape} 不是 ceil(H/2)×ceil(W/2)（幀 {W}x{H}）")
    new_u = _add_delta(su, dcb * np.float32(rp.c_scale), rp.c_lo, rp.c_hi)
    new_v = _add_delta(sv, dcr * np.float32(rp.c_scale), rp.c_lo, rp.c_hi)
    su[mask2] = new_u[mask2].astype(np.uint8)
    sv[mask2] = new_v[mask2].astype(np.uint8)
    return Yuv420(Y, U, V, mat, rng)


def write_back_rgb8(rgb8: np.ndarray, roi: tuple[int, int, int, int], out_lin_roi: np.ndarray, write_mask_roi: np.ndarray) -> np.ndarray:
    """rgb8 輸入版：只改 write_mask 內像素。"""
    x0, y0, x1, y1 = roi
    out = rgb8.copy()
    sub = out[y0:y1, x0:x1]
    new = linear_to_rgb8(np.nan_to_num(out_lin_roi, nan=0.0))
    m = write_mask_roi.astype(bool)
    sub[m] = new[m]
    return out


def _check_even_roi(roi: tuple[int, int, int, int], W: int, H: int) -> None:
    """起點必須偶數；終點必須偶數，或剛好等於奇數的畫面寬／高（奇數尺寸影片的右緣／下緣）。"""
    x0, y0, x1, y1 = roi
    if x0 % 2 or y0 % 2 or (x1 % 2 and x1 != W) or (y1 % 2 and y1 != H):
        raise ValueError(f"ROI 必須偶數對齊（yuv420p 色度 2×2；終點只有在奇數畫面邊緣可以是奇數）：{roi}")
    if not (0 <= x0 < x1 <= W and 0 <= y0 < y1 <= H):
        raise ValueError(f"ROI {roi} 超出 {W}x{H}")


def even_roi(x0: float, y0: float, x1: float, y1: float, W: int, H: int) -> tuple[int, int, int, int]:
    """把浮點 bbox 擴到偶數對齊並裁進畫面；空則回 None-like (0,0,0,0)。
    奇數尺寸的畫面：終點可能被裁成奇數的 W／H（_check_even_roi 允許、色度用 ceil 對應）。"""
    ax0 = max(0, (int(np.floor(x0)) // 2) * 2)
    ay0 = max(0, (int(np.floor(y0)) // 2) * 2)
    ax1 = min(W, ((int(np.ceil(x1)) + 1) // 2) * 2)
    ay1 = min(H, ((int(np.ceil(y1)) + 1) // 2) * 2)
    if ax1 <= ax0 or ay1 <= ay0:
        return (0, 0, 0, 0)
    return ax0, ay0, ax1, ay1
