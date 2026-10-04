"""取代用的素材（`track.replace`）：圖片／影片 → 每一幀要印的模板。

## 時間軸幀 → 素材幀（`source_index`）

    j = (k − origin) + offsetFrames              # origin＝track 所在鏡頭的第一幀；offsetFrames 以**時間軸（proxy）幀**計
    s = floor(j × (den_t / num_t) × (num_s / den_s))   # 時間軸 fps num_t/den_t → 素材 fps num_s/den_s（整數算，不累積誤差）

s 落在 [0, n)（n＝素材幀數）就用 s；超出時依 loop：
- `loop`：s mod n（負的 j 也照樣繞回來）
- `hold`：夾到 [0, n−1]（還沒開始＝第一幀、播完＝最後一幀定住）
- `stop`：這一幀不印（表面露出原本的樣子）；render 計畫裡這些幀不算進要合成的幀

圖片沒有時間：每一幀都是同一張（offsetFrames、loop 不影響）。

## fit（素材 → 模板 tw×th）

- `stretch`：直接縮放到 tw×th（比例不同就變形）。
- `contain`：等比縮到完全放進去、置中；空出來的地方 alpha＝0（露出原本的表面）。
- `cover`：等比縮到蓋滿、置中裁掉多的部分。

PNG 的 alpha 照用（半透明的地方原表面會透出來）。
"""
from __future__ import annotations

import os
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

import numpy as np

FITS = ("stretch", "contain", "cover")
LOOPS = ("loop", "hold", "stop")
VIDEO_LRU = 8  # 素材幀 → 模板的小快取（定格、重送同一幀時不重解、不重縮）
MIN_TEMPLATE_LONG_SIDE = 512  # 模板長邊至少這麼大（solve 的模板可能只有表面在幀裡的大小，合成器的超採樣會被它卡住）


def source_index(k: int, *, origin: int, offset: int, timeline_fps: tuple[int, int], source_fps: tuple[int, int], n_source: int, loop: str) -> int | None:
    """時間軸 proxy 幀 k → 素材幀號；`stop` 而且超出素材範圍 → None。定義見模組說明。"""
    if n_source <= 0:
        return None
    num_t, den_t = int(timeline_fps[0]), int(timeline_fps[1])
    num_s, den_s = int(source_fps[0]), int(source_fps[1])
    j = int(k) - int(origin) + int(offset)
    s = (j * den_t * num_s) // (num_t * den_s)
    if 0 <= s < n_source:
        return s
    if loop == "loop":
        return s % n_source
    if loop == "hold":
        return min(max(s, 0), n_source - 1)
    return None


def template_size(solve_wh: tuple[int, int], min_long: int = MIN_TEMPLATE_LONG_SIDE) -> tuple[int, int]:
    """模板尺寸：solve 模板的比例，長邊至少 min_long（H 用 render 的 H_scale 換算，不必重追）。"""
    tw, th = int(solve_wh[0]), int(solve_wh[1])
    s = max(1.0, float(min_long) / max(1, max(tw, th)))
    return max(1, int(round(tw * s))), max(1, int(round(th * s)))


def _resize(img: np.ndarray, wh: tuple[int, int], scale: float) -> np.ndarray:
    import cv2

    interp = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_CUBIC
    out = cv2.resize(img, (int(wh[0]), int(wh[1])), interpolation=interp)
    if out.dtype != np.uint8:
        out = np.clip(out, 0.0, 1.0).astype(np.float32)
    return out


def fit_rgba(rgb: np.ndarray, alpha: np.ndarray | None, wh: tuple[int, int], fit: str) -> tuple[np.ndarray, np.ndarray]:
    """rgb8 (h,w,3)＋alpha（float 0..1 或 None＝不透明）→ 模板尺寸的 (rgb8 (th,tw,3), alpha float32 (th,tw))。"""
    if fit not in FITS:
        raise ValueError(f"fit 要是 {FITS} 之一，收到 {fit!r}")
    tw, th = int(wh[0]), int(wh[1])
    h, w = int(rgb.shape[0]), int(rgb.shape[1])
    a = None if alpha is None else np.asarray(alpha, np.float32)
    if a is not None and a.min() >= 1.0:
        a = None
    if a is not None:
        # 預乘再縮：透明區的雜色不會滲到邊上
        pm = rgb.astype(np.float32) / 255.0 * a[..., None]
    if fit == "stretch":
        sx = min(tw / w, th / h)
        if a is None:
            out = _resize(rgb, (tw, th), sx)
            return np.ascontiguousarray(out), np.ones((th, tw), np.float32)
        pa = _resize(pm, (tw, th), sx)
        aa = _resize(a, (tw, th), sx)
        return _unpremultiply(pa, aa), aa
    s = min(tw / w, th / h) if fit == "contain" else max(tw / w, th / h)
    nw = max(1, int(round(w * s)))
    nh = max(1, int(round(h * s)))
    if fit == "cover":
        nw, nh = max(nw, tw), max(nh, th)
    if a is None:
        rs = _resize(rgb, (nw, nh), s)
        ra = np.ones((nh, nw), np.float32)
    else:
        ra = _resize(a, (nw, nh), s)
        rs = _unpremultiply(_resize(pm, (nw, nh), s), ra)
    out = np.zeros((th, tw, 3), np.uint8)
    oa = np.zeros((th, tw), np.float32)
    # 素材 [sx0, sx0+cw) → 模板 [dx0, dx0+cw)（contain：dx0 ≥ 0、置中；cover：sx0 ≥ 0、置中裁切）
    dx0, dy0 = (tw - nw) // 2, (th - nh) // 2
    sx0, sy0 = max(0, -dx0), max(0, -dy0)
    dx0, dy0 = max(0, dx0), max(0, dy0)
    cw, ch = min(nw - sx0, tw - dx0), min(nh - sy0, th - dy0)
    out[dy0 : dy0 + ch, dx0 : dx0 + cw] = rs[sy0 : sy0 + ch, sx0 : sx0 + cw]
    oa[dy0 : dy0 + ch, dx0 : dx0 + cw] = ra[sy0 : sy0 + ch, sx0 : sx0 + cw]
    return out, oa


def _unpremultiply(pm: np.ndarray, a: np.ndarray) -> np.ndarray:
    safe = np.where(a > 1e-4, a, 1.0)[..., None]
    return np.clip(np.round(pm / safe * 255.0), 0, 255).astype(np.uint8)


@dataclass
class ReplaceTemplate:
    """核心合成器的「插入模板」（見 ops/render.InsertSpec）：rgb8、alpha（覆蓋率）、ink_mask（沒有墨的概念 → 全 False）。"""

    rgb: np.ndarray
    alpha: np.ndarray
    ink_mask: np.ndarray = field(default=None)  # type: ignore[assignment]
    barcode_px: tuple[int, int, int, int] | None = None

    def __post_init__(self) -> None:
        if self.ink_mask is None:
            self.ink_mask = np.zeros(self.alpha.shape, bool)

    @property
    def size(self) -> tuple[int, int]:
        return int(self.rgb.shape[1]), int(self.rgb.shape[0])

    @property
    def paper(self) -> np.ndarray:
        return self.alpha > 0.5


def make_template(rgb: np.ndarray, alpha: np.ndarray | None, wh: tuple[int, int], fit: str) -> ReplaceTemplate:
    out, a = fit_rgba(rgb, alpha, wh, fit)
    if not (a > 0.5).any():
        # 素材整張透明（或縮到比一個像素還小）：合成器至少要有一個表面像素，退回整張不透明的 stretch
        out, a = fit_rgba(rgb, None, wh, "stretch")
    return ReplaceTemplate(np.ascontiguousarray(out), np.ascontiguousarray(a))


def read_image(path: str) -> tuple[np.ndarray, np.ndarray | None]:
    """任意圖檔 → (rgb8, alpha float32 或 None)。16 位元圖縮成 8 位元；非 ASCII 路徑安全（aivc.imageio）。"""
    import cv2

    from ..imageio import imread_unicode

    img = imread_unicode(path, cv2.IMREAD_UNCHANGED)
    if img.dtype == np.uint16:
        img = (img.astype(np.uint32) // 257).astype(np.uint8)
    elif img.dtype != np.uint8:
        img = np.clip(img.astype(np.float32), 0, 255).astype(np.uint8)
    if img.ndim == 2:
        return np.ascontiguousarray(cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)), None
    if img.shape[2] == 4:
        rgb = cv2.cvtColor(img[..., :3], cv2.COLOR_BGR2RGB)
        return np.ascontiguousarray(rgb), img[..., 3].astype(np.float32) / 255.0
    return np.ascontiguousarray(cv2.cvtColor(img[..., :3], cv2.COLOR_BGR2RGB)), None


class ReplaceImage:
    """圖片素材：讀一次；模板依 (尺寸, fit) 快取。"""

    kind = "image"
    n_frames: int | None = None  # 圖片沒有時間
    fps: tuple[int, int] | None = None

    def __init__(self, path: str) -> None:
        self.path = path
        self.rgb, self.alpha = read_image(path)
        self._tmpl: dict[tuple[tuple[int, int], str], ReplaceTemplate] = {}

    @property
    def size(self) -> tuple[int, int]:
        return int(self.rgb.shape[1]), int(self.rgb.shape[0])

    def template(self, s: int, wh: tuple[int, int], fit: str) -> ReplaceTemplate:
        key = (tuple(wh), fit)
        t = self._tmpl.get(key)  # type: ignore[arg-type]
        if t is None:
            t = self._tmpl[key] = make_template(self.rgb, self.alpha, wh, fit)  # type: ignore[index]
        return t

    def placeholder(self, wh: tuple[int, int], fit: str) -> ReplaceTemplate:
        return self.template(0, wh, fit)

    def close(self) -> None:
        pass

    def to_json(self) -> dict[str, Any]:
        return {"size": list(self.size), "frames": None, "fps": None}


class ReplaceVideo:
    """影片素材：開的時候只做 probe／索引（快取在這支影片自己的 media 快取，跟主影片同一套）；第一次要幀才開解碼器。

    `media.source.FrameSource` 走 CfrMap：素材幀號＝它自己 CFR proxy 的幀號（VFR 的缺幀變成定格），fps＝它的 proxy fps。"""

    kind = "video"

    def __init__(self, path: str, ctx: Any) -> None:
        from ..ops import media as M

        self.path = path
        self._ctx = ctx
        self._mc, self._probe = M.open_media(path, ctx)
        self._index, self._cfr, _ = M.ensure_index(path, self._mc, self._probe, ctx)
        self.n_frames = int(self._cfr.n_frames)
        self.fps = (int(self._cfr.fps_num), int(self._cfr.fps_den))
        self._fs: Any = None
        self._lru: OrderedDict[tuple[int, tuple[int, int], str], ReplaceTemplate] = OrderedDict()
        self.decoded = 0

    @property
    def size(self) -> tuple[int, int]:
        return int(self._probe.width), int(self._probe.height)

    def rgb(self, s: int) -> np.ndarray:
        from ..media.source import FrameSource

        if self._fs is None:
            self._fs = FrameSource(self.path, self._index, self._cfr, probe=self._probe, lru=4, ctx=self._ctx)
        self.decoded += 1
        return self._fs.get_proxy_frame(int(s)).rgb8()

    def template(self, s: int, wh: tuple[int, int], fit: str) -> ReplaceTemplate:
        key = (int(s), (int(wh[0]), int(wh[1])), fit)
        hit = self._lru.get(key)
        if hit is not None:
            self._lru.move_to_end(key)
            return hit
        t = make_template(self.rgb(s), None, wh, fit)
        self._lru[key] = t
        while len(self._lru) > VIDEO_LRU:
            self._lru.popitem(last=False)
        return t

    def placeholder(self, wh: tuple[int, int], fit: str) -> ReplaceTemplate:
        """不解碼的模板（計畫階段用）：rgb 全黑、alpha 是 fit 之後的覆蓋範圍（contain 的空白邊照實算）。"""
        w, h = self.size
        _rgb, a = fit_rgba(np.zeros((max(1, h), max(1, w), 3), np.uint8), None, wh, fit)
        return ReplaceTemplate(np.zeros((int(wh[1]), int(wh[0]), 3), np.uint8), a)

    def close(self) -> None:
        if self._fs is not None:
            self._fs.close()
            self._fs = None
        self._lru.clear()

    def to_json(self) -> dict[str, Any]:
        return {"size": list(self.size), "frames": self.n_frames, "fps": list(self.fps)}


def resolve_path(raw: str, project_path: Any) -> str:
    """replace.path：絕對路徑原樣；相對路徑以專案檔所在資料夾為準（與 media.path 同一個規則）。"""
    from .. import env

    p = env.normalize_path(str(raw))
    if not os.path.isabs(p) and project_path is not None:
        p = os.path.join(os.path.dirname(os.path.abspath(os.fspath(project_path))), p)
    return os.path.abspath(p)


def open_media(kind: str, path: str, ctx: Any) -> ReplaceImage | ReplaceVideo:
    if kind == "image":
        return ReplaceImage(path)
    if kind == "video":
        return ReplaceVideo(path, ctx)
    raise ValueError(f"replace.kind 要是 image 或 video，收到 {kind!r}")


def _ceil_div(a: int, b: int) -> int:
    return -(-a // b)


def frames_for_stop(n_source: int, *, origin: int, offset: int, timeline_fps: tuple[int, int], source_fps: tuple[int, int]) -> tuple[int, int]:
    """loop=stop 時素材有畫面的時間軸幀 [k_lo, k_hi)（半開）。給計畫／測試對數字用。"""
    num_t, den_t = int(timeline_fps[0]), int(timeline_fps[1])
    num_s, den_s = int(source_fps[0]), int(source_fps[1])
    # s = floor(j·A/B) ∈ [0, n) ⇔ j ∈ [0, ceil(n·B/A))，A＝den_t·num_s、B＝num_t·den_s
    a, b = den_t * num_s, num_t * den_s
    j_hi = _ceil_div(n_source * b, a)
    lo = int(origin) - int(offset)
    return lo, lo + j_hi


__all__ = [
    "FITS", "LOOPS", "ReplaceImage", "ReplaceTemplate", "ReplaceVideo", "fit_rgba", "frames_for_stop", "make_template",
    "open_media", "read_image", "resolve_path", "source_index", "template_size",
]
