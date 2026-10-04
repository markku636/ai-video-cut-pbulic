"""「一個被找到的物件」在記憶體裡的樣子：逐幀 RLE＋片語＋分數（`seg.find` 的兩個後端共用）。

為什麼存 RLE 不存 bool：一段 300 幀 × 8 個物件的 720p bool 遮罩是 2 GB，RLE 只有幾百 KB；
摘要要的面積與外接框也都能**不解碼**直接從 RLE 算（pycocotools `area`／`toBbox`），
只有縮圖與疊色預覽那幾幀才真的解回 bool。

幀號 k 一律是呼叫端給的整數（ops 層給的是 CFR proxy 幀號）；`rle[k] = None` ＝「算過、物件不在」，
沒有鍵 ＝ 沒算過（與 `.aivm` 的缺席條目／沒有條目同一套語意，寫檔時直接照抄）。
"""
from __future__ import annotations

import warnings
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

import numpy as np

from . import rle as _rle

Box = tuple[float, float, float, float]  # (x, y, w, h)，來源像素、半開


def _rle_dict(counts: bytes, height: int, width: int) -> dict:
    return {"size": [int(height), int(width)], "counts": counts}


def rle_bbox(counts: bytes, height: int, width: int) -> Box | None:
    """不解碼直接算外接框 (x, y, w, h)；空遮罩回 None。"""
    from pycocotools import mask as _m

    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)  # pycocotools 對 numpy 2 的 __array__(copy=) 警告
        x, y, w, h = (float(v) for v in _m.toBbox(_rle_dict(counts, height, width)))
    if w <= 0 or h <= 0:
        return None
    return (x, y, w, h)


@dataclass
class InstanceTrack:
    """一個實例（物件）在一段幀範圍內的逐幀遮罩。

    - `key`：後端內唯一的編號（不是最後輸出的 obj 號碼；輸出順序由 `order_instances` 決定）。
    - `score`：實例層級的分數。OWLv2 後備＝播種那個框的偵測分數；SAM 3＝各幀偵測分數的最大值。
    - `seed_frame`：提示（框）下在哪一幀；SAM 3 是第一次被偵測到的那一幀。
    """

    key: int
    phrase: str
    width: int
    height: int
    score: float = 0.0
    seed_frame: int | None = None
    rle: dict[int, bytes | None] = field(default_factory=dict)
    frame_scores: dict[int, float] = field(default_factory=dict)

    def add(self, k: int, mask: np.ndarray | None, score: float | None = None) -> bool:
        """記一幀；回傳這一幀算不算「在」。mask=None 或全空 ＝ 算過、物件不在。"""
        if mask is not None and mask.shape != (self.height, self.width):
            raise ValueError(f"k={k} 遮罩 shape {mask.shape} 與實例尺寸 (H={self.height}, W={self.width}) 不合")
        present = mask is not None and bool(np.any(mask))
        if present:
            assert mask is not None
            self.rle[int(k)] = _rle.encode(mask)
        else:
            self.rle[int(k)] = None
        if score is not None and present:
            self.frame_scores[int(k)] = float(score)
        return present

    def mark_absent(self, ks: Iterable[int]) -> None:
        """補上「算過、物件不在」的條目（已經有條目的幀不動）。"""
        for k in ks:
            self.rle.setdefault(int(k), None)

    # ---- 查詢 ----
    def present_frames(self) -> list[int]:
        return sorted(k for k, c in self.rle.items() if c is not None)

    @property
    def n_present(self) -> int:
        return sum(1 for c in self.rle.values() if c is not None)

    @property
    def first_frame(self) -> int | None:
        p = self.present_frames()
        return p[0] if p else None

    @property
    def last_frame(self) -> int | None:
        p = self.present_frames()
        return p[-1] if p else None

    def area(self, k: int) -> int:
        c = self.rle.get(int(k))
        return 0 if c is None else _rle.rle_area(c, self.height, self.width)

    def bbox(self, k: int) -> Box | None:
        c = self.rle.get(int(k))
        return None if c is None else rle_bbox(c, self.height, self.width)

    def mask(self, k: int) -> np.ndarray | None:
        c = self.rle.get(int(k))
        return None if c is None else _rle.decode(c, self.height, self.width)

    def best_frame(self) -> int | None:
        """「看得最清楚」的一幀：面積最大的那一幀（同面積取最早）。

        為什麼用面積而不是分數：兩個後端的逐幀分數意義不同（SAM 3 是偵測分數、SAM 2.1 是物件存在 logit），
        面積對兩邊都是同一件事，也正是縮圖要的「最大、最完整的一眼」。"""
        best_k, best_a = None, -1
        for k in self.present_frames():
            a = self.area(k)
            if a > best_a:
                best_k, best_a = k, a
        return best_k


# ---------------------------------------------------------------------------
# 幾何小工具
# ---------------------------------------------------------------------------
def box_iou(a: Box, b: Box) -> float:
    """兩個 (x, y, w, h) 框的 IoU。"""
    ax0, ay0, aw, ah = a
    bx0, by0, bw, bh = b
    ix = max(0.0, min(ax0 + aw, bx0 + bw) - max(ax0, bx0))
    iy = max(0.0, min(ay0 + ah, by0 + bh) - max(ay0, by0))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def box_containment(a: Box, b: Box) -> float:
    """交集佔**較小那個框**的比例：小框整個落在大框裡時是 1（IoU 會很低，但其實是同一個東西）。"""
    ax0, ay0, aw, ah = a
    bx0, by0, bw, bh = b
    ix = max(0.0, min(ax0 + aw, bx0 + bw) - max(ax0, bx0))
    iy = max(0.0, min(ay0 + ah, by0 + bh) - max(ay0, by0))
    small = min(aw * ah, bw * bh)
    return ix * iy / small if small > 0 else 0.0


#: 兩個框算「同一個東西」的門檻：IoU ≥ 0.3，或小框有 ≥ 60% 落在大框裡。
#: OWLv2 對同一個物件會吐出好幾個彼此重疊的框（它沒有 NMS），這兩條是那種重複框的典型樣子。
DUP_IOU = 0.3
DUP_CONTAIN = 0.6


#: 不同片語的兩個框只有在幾乎重合時才算同一個東西（同義詞：「car, vehicle」對同一台車各吐一個框）。
#: 「包含」不能跨片語用：臉在人的框裡、手在人的框裡、車牌在車的框裡 —— 那是使用者分別要找的不同東西。
DUP_IOU_CROSS_PHRASE = 0.7


def is_duplicate(a: Box, b: Box, *, iou: float = DUP_IOU, contain: float = DUP_CONTAIN) -> bool:
    return box_iou(a, b) >= iou or box_containment(a, b) >= contain


def is_same_object(a: Box, phrase_a: str, b: Box, phrase_b: str) -> bool:
    """去重規則：同一個片語用 `is_duplicate`（OWLv2 對同一物件的重複框）；不同片語只看高 IoU（同義詞），
    不看包含 —— 否則「person, face」的臉整個落在人的框裡（包含 1.0）會被當成重複丟掉。"""
    if phrase_a == phrase_b:
        return is_duplicate(a, b)
    return box_iou(a, b) >= DUP_IOU_CROSS_PHRASE


def link_by_iou(
    prev: Mapping[int, np.ndarray],
    cur: Mapping[int, np.ndarray],
    threshold: float = 0.5,
    *,
    prev_labels: Mapping[int, str] | None = None,
    cur_labels: Mapping[int, str] | None = None,
) -> dict[int, int]:
    """同一幀的兩組遮罩一對一配對 → {cur_key: prev_key}（貪婪：IoU 高的先配，低於門檻不配）。

    SAM 3 分段處理時用它把新段的物件 id 接回舊段的全域 id（兩段在重疊的那一幀各算一次）。
    給了 labels 時只配同一個片語的（「臉」不能接到「車牌」上，即使剛好重疊）。"""
    pairs: list[tuple[float, int, int]] = []
    for ck, cm in cur.items():
        for pk, pm in prev.items():
            if prev_labels is not None and cur_labels is not None and prev_labels.get(pk) != cur_labels.get(ck):
                continue
            if cm.shape != pm.shape:
                continue
            union = int(np.count_nonzero(cm | pm))
            if union == 0:
                continue
            v = int(np.count_nonzero(cm & pm)) / union
            if v >= threshold:
                pairs.append((v, ck, pk))
    pairs.sort(key=lambda t: (-t[0], t[1], t[2]))
    out: dict[int, int] = {}
    used: set[int] = set()
    for _v, ck, pk in pairs:
        if ck in out or pk in used:
            continue
        out[ck] = pk
        used.add(pk)
    return out


def order_instances(instances: Iterable[InstanceTrack]) -> list[InstanceTrack]:
    """輸出順序：分數高的在前；同分先出現的在前；再同就照後端給的 key（穩定、可重現）。"""
    return sorted(instances, key=lambda t: (-round(float(t.score), 6), t.first_frame if t.first_frame is not None else 1 << 30, t.key))


def mask_centroid(mask: np.ndarray) -> tuple[float, float] | None:
    ys, xs = np.nonzero(mask)
    if xs.size == 0:
        return None
    return float(xs.mean()), float(ys.mean())
