"""pycocotools 壓縮 RLE 包裝：bool 遮罩 <-> counts bytes。

為什麼用 COCO RLE 而不是 PNG：一張 1280×720 的牌遮罩 RLE 只有幾十到幾百 bytes，
整個鏡頭幾百幀 × 6 張牌塞進一個 `.aivm` 也不到 1 MB，Rust/TS 端都有現成解碼器可對照
（pycocotools 的 counts 字串是 LEB128 變體，column-major/Fortran 序，三方實作都必須用同一個順序）。
"""
from __future__ import annotations

import warnings

import numpy as np


def encode(mask: np.ndarray) -> bytes:
    """bool（或 0/1 uint8）2D 遮罩 → 壓縮 RLE counts bytes（pycocotools 格式，Fortran 序）。"""
    from pycocotools import mask as _m

    if mask.ndim != 2:
        raise ValueError(f"encode 需要 2D 遮罩，拿到 shape={mask.shape}")
    arr = np.asfortranarray(mask.astype(np.uint8, copy=False))
    rle = _m.encode(arr)
    counts = rle["counts"]
    return counts if isinstance(counts, bytes) else counts.encode("ascii")


def decode(counts: bytes, height: int, width: int) -> np.ndarray:
    """壓縮 RLE counts bytes → bool 遮罩 (height, width)。"""
    from pycocotools import mask as _m

    if height <= 0 or width <= 0:
        raise ValueError(f"decode 需要正的尺寸，拿到 {height}x{width}")
    with warnings.catch_warnings():
        # pycocotools 2.0.x 對 numpy 2 的 __array__(copy=) 發 DeprecationWarning，與我們無關、也不影響結果
        warnings.simplefilter("ignore", DeprecationWarning)
        arr = _m.decode({"size": [int(height), int(width)], "counts": counts})
    if arr.shape != (height, width):
        raise ValueError(f"RLE 解出 {arr.shape}，預期 {(height, width)}（counts 與尺寸不合）")
    return np.ascontiguousarray(arr.astype(bool))


def area(mask: np.ndarray) -> int:
    """遮罩像素數。"""
    return int(np.count_nonzero(mask))


def rle_area(counts: bytes, height: int, width: int) -> int:
    """不解碼直接算面積（給 UI 列表／統計用）。"""
    from pycocotools import mask as _m

    return int(_m.area({"size": [int(height), int(width)], "counts": counts}))


def iou(a: np.ndarray, b: np.ndarray) -> float:
    """兩張 bool 遮罩的 IoU；兩張都空回 1.0（「都沒有東西」視為一致，量尺 mask IoU 才不會被空幀拖垮）。"""
    if a.shape != b.shape:
        raise ValueError(f"iou 尺寸不合：{a.shape} vs {b.shape}")
    a = a.astype(bool, copy=False)
    b = b.astype(bool, copy=False)
    union = int(np.count_nonzero(a | b))
    if union == 0:
        return 1.0
    return int(np.count_nonzero(a & b)) / union
