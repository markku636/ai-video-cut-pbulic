"""背景板重建與合成（純函式：只吃 numpy 陣列，不讀檔、不碰 ctx）。

## 為什麼是中位數，不是平均

平均會被物件本身的顏色拉走：只要遮罩漏了一點邊，那一點的顏色就整個混進背景板。
中位數在**一半以下的取樣被污染**時完全不受影響 —— 而「遮罩比物件稍微小一點」
正是實務上最常見的失誤，所以這裡要的就是那個容錯。

代價是中位數要把所有取樣同時攤開來算。所以：取樣數固定（預設 24 幀），
而且**逐列帶處理**（`strip_rows`），峰值記憶體與影片解析度脫鉤，4K 也不會爆。

## 為什麼取樣而不是用全部的幀

背景板要的是「這個像素平常長什麼樣」，24 個樣本已經足夠穩。
用 200 幀只會讓記憶體與時間變成 8 倍，中位數幾乎不動。

## 羽化的方向

遮罩先**膨脹**再模糊，不是直接模糊。SAM 的遮罩邊緣通常比物件本身緊一兩個像素，
直接模糊會在物件外緣留一圈沒被蓋掉的原始像素 —— 看起來像描邊，比不處理還明顯。
"""

from __future__ import annotations

import warnings
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np

#: 預設取樣幀數。中位數在這個量級就已經穩，再多只是變慢。
DEFAULT_SAMPLES = 24
#: 逐列帶處理的高度：讓峰值記憶體與解析度脫鉤。
DEFAULT_STRIP_ROWS = 128


class InpaintError(ValueError):
    """這個模組自己的錯誤；呼叫端負責包成 OpError。"""


def sample_indices(k0: int, k1: int, n: int) -> list[int]:
    """`[k0, k1)` 裡等距取 n 個幀號（含頭尾、去重、遞增）。範圍比 n 短就全取。"""
    if k1 <= k0:
        raise InpaintError(f"範圍是空的（{k0}:{k1}）")
    if n < 1:
        raise InpaintError(f"取樣數要 ≥ 1（拿到 {n}）")
    total = k1 - k0
    if total <= n:
        return list(range(k0, k1))
    if n == 1:
        return [k0]
    return sorted({k0 + int(round(i * (total - 1) / (n - 1))) for i in range(n)})


def sample_counts(masks: "np.ndarray") -> "np.ndarray":
    """每個像素有幾個取樣**沒被蓋住**（＝真的參與了中位數）。

    `covered` 只說「有沒有至少一個」，但只有一兩個樣本的中位數等於「相信那一幀」——
    那一幀只要有一點沒遮乾淨，整個像素就錯了。要判斷背景板可不可信，看的是這個數。
    """
    import numpy as np

    return (~masks).sum(axis=0, dtype=np.uint16)


def median_plate(
    frames: "np.ndarray", masks: "np.ndarray", *, strip_rows: int = DEFAULT_STRIP_ROWS, min_samples: int = 1
) -> tuple["np.ndarray", "np.ndarray"]:
    """取樣幀 + 對應遮罩 → (背景板 uint8 (H,W,3), 可信的像素 bool (H,W))。

    `frames` (N,H,W,3) uint8、`masks` (N,H,W) bool（True = 被物件蓋住，這一幀的這個像素不採用）。
    可用樣本少於 `min_samples` 的像素回 `covered=False`、值填 0 —— 由呼叫端決定要不要用
    古典補繪補（`fill_uncovered`）。預設 1 ＝ 只要有一個樣本就算數（舊行為）；
    實務上建議 3 以上：一兩個樣本的中位數其實就是「相信那一幀」。
    """
    import numpy as np

    if frames.ndim != 4 or frames.shape[3] != 3:
        raise InpaintError(f"frames 要是 (N,H,W,3)（拿到 {frames.shape}）")
    if masks.shape != frames.shape[:3]:
        raise InpaintError(f"masks 形狀 {masks.shape} 對不上 frames {frames.shape[:3]}")
    if frames.shape[0] == 0:
        raise InpaintError("沒有取樣幀")
    n, h, w, _ = frames.shape
    plate = np.zeros((h, w, 3), np.uint8)
    covered = np.zeros((h, w), bool)
    rows = max(1, int(strip_rows))
    need = max(1, int(min_samples))
    for y0 in range(0, h, rows):
        y1 = min(h, y0 + rows)
        m = masks[:, y0:y1]
        cov = (~m).sum(axis=0) >= need
        f = frames[:, y0:y1].astype(np.float32)
        f[m] = np.nan  # (N,S,W) 的布林索引套在 (N,S,W,3) 上＝三個通道一起挖掉
        with warnings.catch_warnings():
            # 整串都被蓋住的像素會是 all-NaN slice，那是預期內的情況（由 covered 表示），不是警告
            warnings.simplefilter("ignore", RuntimeWarning)
            med = np.nanmedian(f, axis=0)
        np.nan_to_num(med, copy=False, nan=0.0)
        plate[y0:y1] = np.clip(med + 0.5, 0, 255).astype(np.uint8)
        covered[y0:y1] = cov
    return plate, covered


def fill_uncovered(plate: "np.ndarray", covered: "np.ndarray", radius: int = 5) -> "np.ndarray":
    """整段都沒露出來過的像素用古典補繪（Telea）補。

    **會糊**，而且沒有辦法不糊 —— 那些像素在整支影片裡從來沒被拍到過。
    呼叫端要把「補了多少比例」報出來：補得多就代表這段素材不適合這條路，
    使用者需要知道的是那件事，而不是看到一塊糊掉的區域自己猜。
    """
    import cv2
    import numpy as np

    holes = (~covered).astype(np.uint8)
    if not holes.any():
        return plate
    bgr = cv2.cvtColor(plate, cv2.COLOR_RGB2BGR)
    out = cv2.inpaint(bgr, holes, max(1, int(radius)), cv2.INPAINT_TELEA)
    return np.ascontiguousarray(cv2.cvtColor(out, cv2.COLOR_BGR2RGB))


def feather(mask: "np.ndarray", dilate: int = 3, blur: int = 7) -> "np.ndarray":
    """bool 遮罩 → float32 alpha (H,W) ∈ [0,1]。**先膨脹再模糊**（理由見模組說明）。"""
    import cv2
    import numpy as np

    a = (mask.astype(np.uint8)) * 255
    d = max(0, int(dilate))
    if d:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * d + 1, 2 * d + 1))
        a = cv2.dilate(a, k)
    b = max(0, int(blur))
    if b:
        ks = 2 * b + 1  # 高斯核一定要奇數
        a = cv2.GaussianBlur(a, (ks, ks), 0)
    return (a.astype(np.float32) / 255.0)[..., None]


def shadow_mask(
    frame: "np.ndarray", plate: "np.ndarray", near: "np.ndarray", drop: float = 0.85
) -> "np.ndarray":
    """物件投在背景上的影子：`near` 範圍內、比背景板**暗** `drop` 倍以上的像素。

    為什麼需要這一步：影子不在 SAM 的遮罩裡。只換掉物件、留著影子，
    成品就是一塊「沒有影子的乾淨背景」被自己的影子圍著 —— 輪廓反而被描出來，
    實測看起來像一隻綠色的手套。

    為什麼用**比值**而不是直接把遮罩膨脹一大圈：膨脹會連旁邊的東西一起吃掉
    （實測膨脹到 20 px 時牌的上緣被吞掉）。影子的定義是「比平常暗」，
    而旁邊那些不該動的東西（牌、籌碼）通常比背景**亮**，所以比值天然分得開。
    這跟換表面時的紙色比例合成（外掛）是同一種推理。

    `near` 由呼叫端決定（通常是「遮罩膨脹 N px 之後扣掉遮罩本身」）：
    影子一定貼著物件，不限範圍的話整片較暗的背景都會被當成影子。
    """
    import numpy as np

    f = frame.astype(np.float32).sum(axis=2)
    p = plate.astype(np.float32).sum(axis=2)
    # 寫成乘法而不是除法：背景板全黑的地方（例如信箱黑邊）不必特別防除以零，
    # 而且「0 < 0」自然就是 False —— 全黑的地方本來就沒有影子可言。
    return near & (f < p * np.float32(drop))


def blend(base: "np.ndarray", over: "np.ndarray", alpha: "np.ndarray") -> "np.ndarray":
    """`base` 上用 `alpha` 混入 `over`，回 float32。dtype 不拘（uint8 或線性 float 都吃）。

    合成器那條路要在**線性** RGB 裡混（與 `comp/` 一致），預覽那條路用 uint8 就夠。
    兩條路共用這一行，才不會養出兩種混色行為。
    """
    import numpy as np

    if base.shape != over.shape:
        raise InpaintError(f"兩張圖尺寸不同：{base.shape} vs {over.shape}")
    return base.astype(np.float32) * (1.0 - alpha) + over.astype(np.float32) * alpha


def composite(frame: "np.ndarray", plate: "np.ndarray", alpha: "np.ndarray") -> "np.ndarray":
    """`blend` 的 uint8 便利版。alpha 是 (H,W,1) float32。"""
    import numpy as np

    return np.clip(blend(frame, plate, alpha) + 0.5, 0, 255).astype(np.uint8)


def even_roi(mask: "np.ndarray", width: int, height: int) -> tuple[int, int, int, int] | None:
    """要寫回的區域外接框，**起點取偶數、終點取偶數**（或剛好是奇數尺寸畫面的右／下緣）。

    偶數是 `comp/_color.write_back` 的硬性要求：yuv420 的色度是 2×2 一格，
    從奇數位置寫回等於要寫半個色度樣本。這裡算錯的症狀是合成結果整體位移一格，
    所以獨立成一支純函式、獨立測。遮罩是空的回 None（這一幀沒東西要改）。
    """
    import numpy as np

    ys, xs = np.nonzero(mask)
    if ys.size == 0:
        return None
    x0 = int(xs.min()) & ~1
    y0 = int(ys.min()) & ~1
    x1 = min(width, (int(xs.max()) + 2) & ~1)
    y1 = min(height, (int(ys.max()) + 2) & ~1)
    return (x0, y0, x1, y1)


def camera_shift(a: "np.ndarray", b: "np.ndarray") -> float:
    """兩幀之間的整體平移量（像素）。用來判斷「鏡頭是不是在動」。

    背景板的前提是**同一個座標在每一幀都是同一塊背景**。鏡頭一動這個前提就不成立，
    補出來的會是別的地方的畫面。相位相關對整體平移最靈敏又便宜（一次 FFT），
    用它當守門員：超過門檻就擋下並說明，不要補出一段看起來很怪但說不出哪裡怪的影片。
    """
    import cv2
    import numpy as np

    ga = cv2.cvtColor(a, cv2.COLOR_RGB2GRAY).astype(np.float32)
    gb = cv2.cvtColor(b, cv2.COLOR_RGB2GRAY).astype(np.float32)
    win = cv2.createHanningWindow((ga.shape[1], ga.shape[0]), cv2.CV_32F)
    (dx, dy), _ = cv2.phaseCorrelate(ga, gb, win)
    return float(np.hypot(dx, dy))


def coverage(covered: "np.ndarray", region: "np.ndarray | None" = None) -> float:
    """有補到的比例。`region` 給了就只算那塊（＝要被換掉的地方，只有那裡的覆蓋率有意義）。"""
    import numpy as np

    if region is None:
        return float(covered.mean())
    n = int(np.count_nonzero(region))
    return 1.0 if n == 0 else float(np.count_nonzero(covered & region) / n)
