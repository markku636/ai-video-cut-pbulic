"""render 路徑的優雅退化（A4 pull-forward；計畫 §12「翻牌時手遮擋…2 幀 alpha 漸變；遮擋後從遮罩四角重取得」）。

問題：追蹤 conf < holdBelowConf（範例第 3 段掃牌 k≥1215：ECC 發散、conf 0.2）時合成器原本 hold ＝ 回原幀，
被插入的平面在那幾幀又「跳」回原樣、而且看得清楚。

每條 track、每幀依序決定（`Degrader.resolve`）：
1. tracked：conf ≥ 門檻且有 H → 照舊，記為最後一個好 H。
2. coarse（smoothing.coarseFromMask）：SAM 遮罩還在，兩種候選依序試——
   a. 追蹤 H 仍然貼著遮罩：遮罩像素 ≥ 93% 落在追蹤四邊形內、且遮罩蓋住四邊形 ≥ 45%（手指遮住一角時 IoU 會掉，
      但「可見部分都在四邊形內」仍成立 → 平面沒動、只是 ECC 被手騙了）。
   b. 遮罩四角 `geom.quad_from_mask`：IoU 閘門 ≥ 0.85（approxPolyDP／Hough 對遮罩的擬合品質），角點順序以前一個好四邊形的
      TL 對齊（旋轉一致），面積與參考四邊形比 ∈ [0.6, 1.6]、凸。
   兩者都還要通過**表面檢查**（`surface_check(quad, mask, planes)`，由插入來源提供；None ＝ 不檢查）：
   SAM 常在物件被拿走後改黏到背景上形狀相近的東西，幾何完全合理但裡面不是那個表面
   （例：牌局外掛檢查「遮罩∧四邊形內像不像白紙」，擋掉桌上印的空框與牌背）。
   而且 coarse 只在「之前已經有追蹤到的好幀」之後才允許（從沒追蹤到過 → 一律不畫）；coarse 幀本身會成為新的
   好幀，所以平面一路被拖走仍可連續 coarse。
3. fade（smoothing.fadeFrames，預設 2）：都不合理但距離最後一個好 H ≤ N 幀 → 用那個 H，opacity × (1 − i/(N+1))，
   不在一幀內瞬間跳回原樣。
4. hold：其餘。

動態模糊鄰幀：coarse 幀的 H_prev／H_next 用同一套規則解鄰幀（鄰幀還沒解碼，所以鄰幀只做幾何檢查、不做表面檢查）；
fade 幀不做動態模糊（最後一個好 H 是靜止的）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np

from .blur import H_from_quad, quad_from_H

INSIDE_FRAC = 0.93
COVER_FRAC = 0.45
IOU_GATE = 0.85
AREA_RANGE = (0.6, 1.6)
MIN_MASK_PX = 64


@dataclass
class Resolved:
    H: np.ndarray | None
    state: str  # tracked | coarse | fade | hold | lost
    opacity: float = 1.0
    reason: str = ""
    warp: Any = None  # 外掛的貼合式形變（例：彎曲的平面）；合成器的替代路徑才用，state 與 opacity 不受影響


def _area(q: np.ndarray) -> float:
    x, y = q[:, 0], q[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(np.roll(x, -1), y)))


def _convex(q: np.ndarray) -> bool:
    e = np.roll(q, -1, axis=0) - q
    cr = e[:, 0] * np.roll(e, -1, axis=0)[:, 1] - e[:, 1] * np.roll(e, -1, axis=0)[:, 0]
    return bool(np.all(cr > 1e-9) or np.all(cr < -1e-9))


def _crop_raster(quad: np.ndarray, mask: np.ndarray, pad: int = 4) -> tuple[np.ndarray, np.ndarray, tuple[int, int, int, int]]:
    """四邊形 ∪ 遮罩的 bbox 內：(四邊形光柵, 遮罩, bbox)。"""
    from ..geom.quad import raster_quad

    H, W = mask.shape
    ys, xs = np.nonzero(mask)
    x0 = max(0, int(min(xs.min(), np.floor(quad[:, 0].min()))) - pad)
    y0 = max(0, int(min(ys.min(), np.floor(quad[:, 1].min()))) - pad)
    x1 = min(W, int(max(xs.max(), np.ceil(quad[:, 0].max()))) + pad + 1)
    y1 = min(H, int(max(ys.max(), np.ceil(quad[:, 1].max()))) + pad + 1)
    if x1 <= x0 or y1 <= y0:
        return np.zeros((0, 0), bool), np.zeros((0, 0), bool), (0, 0, 0, 0)
    poly = raster_quad(quad, (y1 - y0, x1 - x0), (x0, y0)).astype(bool)
    return poly, mask[y0:y1, x0:x1].astype(bool), (x0, y0, x1, y1)


@dataclass
class Degrader:
    """一條 track 的逐幀退化狀態（render 依 k 遞增呼叫）。"""

    tmpl_wh: tuple[int, int]
    hold_below: float
    get_mask: Callable[[int], np.ndarray | None] | None
    get_H: Callable[[int], np.ndarray | None]
    get_conf: Callable[[int], float]
    coarse_from_mask: bool = True
    fade_frames: int = 2
    # 表面檢查（見模組說明 2.）：(四邊形, 遮罩, 本幀 yuv420p 或 Y 平面) → 是不是那個表面；None ＝ 不檢查
    surface_check: Callable[[np.ndarray, np.ndarray, Any], bool] | None = None
    ref_area: float | None = None
    last_good: tuple[int, np.ndarray] | None = None
    _geo_cache: dict[int, tuple[np.ndarray | None, str]] = field(default_factory=dict)

    def _mask(self, k: int) -> np.ndarray | None:
        if self.get_mask is None:
            return None
        m = self.get_mask(k)
        if m is None or int(np.count_nonzero(m)) < MIN_MASK_PX:
            return None
        return m.astype(bool)

    def _surface_ok(self, quad: np.ndarray, mask: np.ndarray, planes: Any) -> bool:
        return True if self.surface_check is None else bool(self.surface_check(quad, mask, planes))

    def _good(self, k: int) -> np.ndarray | None:
        H = self.get_H(k)
        if H is None or self.get_conf(k) < self.hold_below:
            return None
        return H

    def coarse_geometry(self, k: int, y_plane: Any = None) -> tuple[np.ndarray | None, str]:
        """coarse 候選（a 追蹤 H 貼遮罩 → b 遮罩四角）。y_plane=None 時略過紙面檢查（鄰幀動態模糊用）。"""
        if y_plane is None and k in self._geo_cache:
            return self._geo_cache[k]
        res = self._coarse_geometry(k, y_plane)
        if y_plane is None:
            self._geo_cache[k] = res
        return res

    def _coarse_geometry(self, k: int, y_plane: Any) -> tuple[np.ndarray | None, str]:
        from ..geom.quad import quad_from_mask

        m = self._mask(k)
        if m is None:
            return None, "no-mask"
        w, h = self.tmpl_wh
        ref_H = self.last_good[1] if self.last_good is not None else self.get_H(k)
        ref_q = None if ref_H is None else quad_from_H(ref_H, w, h)
        ref_area = self.ref_area or (None if ref_q is None else _area(ref_q))
        reasons: list[str] = []
        # a. 追蹤 H 仍貼著可見遮罩
        Ht = self.get_H(k)
        if Ht is not None:
            qt = quad_from_H(Ht, w, h)
            poly, mc, _ = _crop_raster(qt, m)
            inter = int((poly & mc).sum())
            inside = inter / max(int(mc.sum()), 1)
            cover = inter / max(int(poly.sum()), 1)
            if inside >= INSIDE_FRAC and cover >= COVER_FRAC:
                if y_plane is None or self._surface_ok(qt, m, y_plane):
                    return Ht, "track-in-mask"
                reasons.append("track:not-paper")
            else:
                reasons.append(f"track:inside={inside:.2f},cover={cover:.2f}")
        # b. 遮罩四角
        qr = quad_from_mask(m, ref_tl=None if ref_q is None else ref_q[0])
        if qr.quad is None or qr.iou < IOU_GATE:
            reasons.append(f"mask:{qr.method},iou={qr.iou:.2f}")
            return None, ";".join(reasons)
        q = np.asarray(qr.quad, np.float64)
        if not _convex(q):
            return None, ";".join(reasons + ["mask:concave"])
        if ref_area is not None and not (AREA_RANGE[0] <= _area(q) / max(ref_area, 1e-6) <= AREA_RANGE[1]):
            return None, ";".join(reasons + [f"mask:area={_area(q) / max(ref_area, 1e-6):.2f}"])
        if y_plane is not None and not self._surface_ok(q, m, y_plane):
            return None, ";".join(reasons + ["mask:not-paper"])
        return H_from_quad(q, w, h), f"mask-quad({qr.method},{qr.iou:.2f})"

    def resolve(self, k: int, y_plane: Any) -> Resolved:
        """y_plane：本幀 yuv420p（有 .y/.u/.v）或 Y 平面 ndarray。"""
        H = self.get_H(k)
        if H is not None and self.get_conf(k) >= self.hold_below:
            self.last_good = (k, H)
            if self.ref_area is None:
                w, h = self.tmpl_wh
                self.ref_area = _area(quad_from_H(H, w, h))
            return Resolved(H, "tracked")
        why = "lost" if H is None else f"conf {self.get_conf(k):.2f} < {self.hold_below:.2f}"
        if self.coarse_from_mask and self.last_good is None:
            why = f"{why}; never-tracked"  # 還沒被追蹤到過（例：翻過來之前的背面）→ 不做 coarse
        elif self.coarse_from_mask:
            Hc, reason = self.coarse_geometry(k, y_plane)
            if Hc is not None:
                self.last_good = (k, Hc)
                return Resolved(Hc, "coarse", 1.0, reason)
            why = f"{why}; {reason}"
        if self.last_good is not None and self.fade_frames > 0:
            i = k - self.last_good[0]
            if 0 < i <= self.fade_frames:
                return Resolved(self.last_good[1], "fade", 1.0 - i / (self.fade_frames + 1.0), why)
        return Resolved(None, "lost" if H is None else "hold", 0.0, why)

    def neighbour_H(self, k: int) -> np.ndarray | None:
        """鄰幀 H（動態模糊路徑）：好的追蹤 H → 否則 coarse 幾何（不做紙面檢查）→ None。"""
        H = self._good(k)
        if H is not None:
            return H
        if not self.coarse_from_mask:
            return None
        return self.coarse_geometry(k, None)[0]
