"""bench outside 的純函式：排除區遮罩 → 逐幀「遮罩外」比對 → 摘要（計畫 §11：沒動到的地方真的沒動？）。

排除區 = ∪(每條 track 在該幀的 alpha 區) 再膨脹 `dilate_px`（預設 3）。alpha 區優先用渲染時 `--emit-matte` 吐出的
alpha PNG（合成器最終真的寫過的地方）；沒有就用 遮罩(.aivm) ∪ 四角足跡(solve H)。為什麼還要膨脹 3 px：
合成器寫回 dilate(alpha>0, 1 px) 內的亮度、色度是 2×2 區塊 max-pool（comp/_color.write_back），
再加編碼器的區塊邊界擴散；3 px 剛好蓋過這些、又遠小於牌與牌之間的距離。

門檻：無損（ffv1 等）→ 三個平面在排除區外**逐位元相同**；有損 → 排除區外三平面合併 PSNR ≥ min_psnr（45 dB）。
每幀也記錄排除區**內**有幾個像素變了（information：合成到底有沒有發生），不當門檻。
"""
from __future__ import annotations

import math
from typing import Any, Iterable, Sequence

import numpy as np

from . import common as C

LOSSLESS_CODECS: frozenset[str] = frozenset({"ffv1", "huffyuv", "ffvhuff", "utvideo", "rawvideo", "magicyuv", "libx264rgb"})


def exclusion_mask(
    w: int,
    h: int,
    quads: Iterable[np.ndarray | None] = (),
    masks: Iterable[np.ndarray | None] = (),
    alphas: Iterable[np.ndarray | None] = (),
    dilate_px: int = 3,
) -> np.ndarray:
    """∪(四角足跡, 遮罩, alpha>0) 膨脹 dilate_px → bool (h, w)。全部 None → 全 False。"""
    acc = np.zeros((int(h), int(w)), dtype=bool)
    for q in quads:
        if q is not None:
            acc |= C.quad_footprint(q, w, h)
    for m in masks:
        if m is not None:
            mm = np.asarray(m, dtype=bool)
            if mm.shape != acc.shape:
                raise ValueError(f"遮罩尺寸 {mm.shape} 與幀 {(h, w)} 不同")
            acc |= mm
    for a in alphas:
        if a is not None:
            aa = np.asarray(a)
            if aa.shape != acc.shape:
                raise ValueError(f"alpha 尺寸 {aa.shape} 與幀 {(h, w)} 不同")
            acc |= aa > 0
    return C.dilate_bool(acc, dilate_px)


def compare_outside(
    src: Sequence[np.ndarray], out: Sequence[np.ndarray], excl: np.ndarray
) -> dict[str, Any]:
    """src/out = (y, u, v) uint8 平面；excl = 亮度排除區 bool。回單幀數字（psnr 為 inf 代表逐位元相同）。"""
    sy, su, sv = src
    oy, ou, ov = out
    if sy.shape != oy.shape or su.shape != ou.shape or sv.shape != ov.shape:
        raise ValueError(f"來源 {sy.shape}/{su.shape} 與輸出 {oy.shape}/{ou.shape} 平面尺寸不同")
    keep_y = ~np.asarray(excl, dtype=bool)
    keep_c = ~C.pool2x2_any(excl, su.shape)
    sse_y, nd_y, n_y = C.sse_masked(sy, oy, keep_y)
    sse_u, nd_u, n_u = C.sse_masked(su, ou, keep_c)
    sse_v, nd_v, n_v = C.sse_masked(sv, ov, keep_c)
    # 排除區內改了幾個亮度像素（information）
    _sse_in, nd_in, n_in = C.sse_masked(sy, oy, ~keep_y) if excl.any() else (0.0, 0, 0)
    return {
        "identical": bool(nd_y == 0 and nd_u == 0 and nd_v == 0),
        "psnr": C.psnr_from_sse(sse_y + sse_u + sse_v, n_y + n_u + n_v),
        "psnrY": C.psnr_from_sse(sse_y, n_y),
        "psnrU": C.psnr_from_sse(sse_u, n_u),
        "psnrV": C.psnr_from_sse(sse_v, n_v),
        "nDiffOutside": int(nd_y + nd_u + nd_v),
        "nOutside": int(n_y),
        "nDiffInside": int(nd_in),
        "nInside": int(n_in),
    }


def summarize(rows: list[dict[str, Any]], *, lossless: bool, min_psnr: float, max_list: int = 20) -> dict[str, Any]:
    """rows = 每幀 compare_outside 結果 + "k"。回門檻判定與最差幀清單。"""
    if not rows:
        return {"ok": False, "frames": 0, "reason": "沒有任何幀可比對"}
    psnrs = [r["psnr"] for r in rows]
    finite = [p for p in psnrs if math.isfinite(p)]
    min_psnr_seen = min(psnrs)
    ident = sum(1 for r in rows if r["identical"])
    if lossless:
        bad = [r for r in rows if not r["identical"]]
        ok = not bad
    else:
        bad = [r for r in rows if r["psnr"] < min_psnr]
        ok = not bad
    bad.sort(key=lambda r: (r["psnr"], -r["nDiffOutside"]))
    return {
        "ok": bool(ok),
        "mode": "lossless" if lossless else "lossy",
        "frames": len(rows),
        "identicalFrames": ident,
        "framesWithOutsideDiff": len(rows) - ident,
        "minPsnr": min_psnr_seen,
        "meanPsnrFinite": (sum(finite) / len(finite)) if finite else math.inf,
        "compositedFrames": sum(1 for r in rows if r["nDiffInside"] > 0),
        "threshold": {"lossless": lossless, "minPsnr": None if lossless else float(min_psnr)},
        "failures": [{"k": r["k"], "psnr": r["psnr"], "nDiffOutside": r["nDiffOutside"], "nDiffInside": r["nDiffInside"]} for r in bad[:max_list]],
        "nFailures": len(bad),
    }
