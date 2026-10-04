"""`aivc select` 的提示：解析、座標換算（px｜norm1000）、在既有遮罩上補修正點的提示推導。

## 座標

- `px`：來源（proxy）像素，左上角 (0, 0)，x 向右、y 向下。框是 `x,y,w,h`（左上角＋寬高，與 `seg --box` 相同）。
- `norm1000`：兩軸各自正規化到 0–1000（給視覺模型用：它看的圖常被縮放過，給 0–1000 就不必知道原尺寸）。
  換算 `x_px = x / 1000 × W`、`y_px = y / 1000 × H`；框的 w、h 同樣各自乘 W/1000、H/1000。
  1000 對應畫面右／下**邊界**（不是最後一個像素的中心），與 `aivc frame --grid` 畫的格線一致。

## 補修正點（`--from`）

HF 的 SAM 2.1／SAM 3 影片模型不能在同一幀同時吃「舊遮罩」與「新點」（mask 與 point 提示互斥，
也沒有原版 SAM 2 拿上一次 logits 當 dense prompt 的那條路）。所以只給點、沒給框時，用舊遮罩推一組提示：
- **框**：舊遮罩在這一幀的外接框，再擴到包住新的加選點（外擴 2 px）。
- **錨點**：舊遮罩裡離邊界最遠的點（距離轉換的最大值）當一個加選點，避開新的減選點附近 —— 讓模型知道「還是同一個東西」。
給了框 ＝ 使用者要在這一幀**重新**框選，舊遮罩只用來保留前面的幀，不參與提示。

**只用跟使用者點擊一致的那部分舊遮罩**（`--from` 最常用在「中段追歪了」，那時舊遮罩本身就在錯的東西上）：
舊遮罩先切成連通塊（8 連通），
- 有加選點：只用「含有（或緊貼著）加選點」的連通塊推框與錨點；**所有加選點都不在舊遮罩上** ＝ 使用者在重新指定目標，
  不推導、原樣送使用者的點（不然錨點與框會把模型拉回舊的、錯的那個東西）。
- 只有減選點：丟掉含減選點的連通塊，用剩下的推；每一塊都含減選點（＝在同一個東西上修掉一部分）才全部保留。
限制：漏到旁邊、但跟正確物件**連在一起**的那塊無法自動切開（同一個連通塊）—— 那種情況請給 `--box` 重新框選。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .backend import LABEL_ADD, LABEL_REDUCE

COORDS = ("px", "norm1000")
NORM = 1000.0
_LABELS = {"": LABEL_ADD, "pos": LABEL_ADD, "add": LABEL_ADD, "+": LABEL_ADD, "1": LABEL_ADD, "positive": LABEL_ADD,
           "neg": LABEL_REDUCE, "reduce": LABEL_REDUCE, "-": LABEL_REDUCE, "0": LABEL_REDUCE, "negative": LABEL_REDUCE}


class PromptError(ValueError):
    """提示格式錯誤（ops 層轉成 OpError(Invalid)）。"""


@dataclass(frozen=True)
class SelectPrompts:
    """像素座標的提示。points：(x, y, label)；box：(x, y, w, h) 或 None。"""

    points: tuple[tuple[float, float, int], ...] = ()
    box: tuple[float, float, float, float] | None = None
    derived: dict[str, Any] = field(default_factory=dict)  # 從舊遮罩推出來的提示（給預覽與 JSON 看）

    @property
    def empty(self) -> bool:
        return not self.points and self.box is None

    def to_json(self) -> dict[str, Any]:
        return {
            "points": [[round(x, 2), round(y, 2), int(lb)] for x, y, lb in self.points],
            "box": None if self.box is None else [round(v, 2) for v in self.box],
            "derived": self.derived or None,
        }


def parse_point(s: str) -> tuple[float, float, int]:
    """`x,y` 或 `x,y:neg`（也吃 :pos/:add/:reduce/:1/:0）→ (x, y, label)，單位未換算。"""
    body, _, tag = str(s).strip().partition(":")
    try:
        x, y = (float(v) for v in body.replace("，", ",").split(","))
    except ValueError as e:
        raise PromptError(f"--point 要寫成 x,y 或 x,y:neg，拿到 {s!r}") from e
    key = tag.strip().lower()
    if key not in _LABELS:
        raise PromptError(f"--point 的標記只能是 pos（加選，預設）或 neg（減選），拿到 {s!r}")
    if not (np.isfinite(x) and np.isfinite(y)):
        raise PromptError(f"--point 座標不是有限數值：{s!r}")
    return x, y, _LABELS[key]


def parse_box(s: str) -> tuple[float, float, float, float]:
    try:
        x, y, w, h = (float(v) for v in str(s).replace("，", ",").split(","))
    except ValueError as e:
        raise PromptError(f"--box 要寫成 x,y,w,h，拿到 {s!r}") from e
    if not all(np.isfinite(v) for v in (x, y, w, h)):
        raise PromptError(f"--box 不是有限數值：{s!r}")
    if w <= 0 or h <= 0:
        raise PromptError(f"--box 寬高必須 > 0：{s!r}")
    return x, y, w, h


def norm1000_to_px(x: float, y: float, width: int, height: int) -> tuple[float, float]:
    return x / NORM * width, y / NORM * height


def px_to_norm1000(x: float, y: float, width: int, height: int) -> tuple[float, float]:
    return x / width * NORM, y / height * NORM


def to_pixels(
    points: list[tuple[float, float, int]],
    box: tuple[float, float, float, float] | None,
    coords: str,
    width: int,
    height: int,
) -> SelectPrompts:
    """原始提示 → 像素提示；norm1000 先檢查 0–1000 再換算。點與框最後都夾進畫面。"""
    if coords not in COORDS:
        raise PromptError(f"--coords 只能是 {'｜'.join(COORDS)}，拿到 {coords!r}")
    W, H = float(width), float(height)
    out_pts: list[tuple[float, float, int]] = []
    for x, y, lb in points:
        if coords == "norm1000":
            if not (0.0 <= x <= NORM and 0.0 <= y <= NORM):
                raise PromptError(f"norm1000 座標要在 0–1000 之間，拿到點 ({x:g}, {y:g})")
            x, y = norm1000_to_px(x, y, width, height)
        elif not (-0.5 <= x <= W + 0.5 and -0.5 <= y <= H + 0.5):
            raise PromptError(f"點 ({x:g}, {y:g}) 在畫面 {width}×{height} 外面（座標是 px；AI 給的 0–1000 座標請加 --coords norm1000）")
        out_pts.append((min(max(x, 0.0), W - 1e-3), min(max(y, 0.0), H - 1e-3), int(lb)))
    out_box = None
    if box is not None:
        x, y, w, h = box
        if coords == "norm1000":
            if not (0.0 <= x <= NORM and 0.0 <= y <= NORM and x + w <= NORM + 1e-6 and y + h <= NORM + 1e-6):
                raise PromptError(f"norm1000 框要落在 0–1000 之內，拿到 {box}")
            x, y = norm1000_to_px(x, y, width, height)
            w, h = w / NORM * W, h / NORM * H
        x0, y0 = max(0.0, x), max(0.0, y)
        x1, y1 = min(W, x + w), min(H, y + h)
        if x1 - x0 < 1.0 or y1 - y0 < 1.0:
            raise PromptError(f"框 {box} 與畫面 {width}×{height} 幾乎沒有交集")
        out_box = (x0, y0, x1 - x0, y1 - y0)
    return SelectPrompts(tuple(out_pts), out_box)


def interior_anchor(mask: np.ndarray, avoid: list[tuple[float, float]] = (), radius: float = 0.0) -> tuple[float, float] | None:
    """遮罩裡離邊界最遠的點（像素中心座標 +0.5 → 邊界座標系）；避開 avoid 周圍 radius 內。找不到回 None。"""
    import cv2

    m = mask.astype(np.uint8)
    if avoid and radius > 0:
        m = m.copy()
        for ax, ay in avoid:
            cv2.circle(m, (int(round(ax - 0.5)), int(round(ay - 0.5))), int(round(radius)), 0, -1)
    if not m.any():
        return None
    # 先補一圈 0：distanceTransform 把畫面外當成前景，貼著畫面邊的遮罩最遠點會落在邊上（實測 768 高的畫面錨點跑到 y=767.5）
    dist = cv2.distanceTransform(np.pad(m, 1), cv2.DIST_L2, 5)[1:-1, 1:-1]
    y, x = np.unravel_index(int(np.argmax(dist)), dist.shape)
    if dist[y, x] < 1.0:
        return None
    return float(x) + 0.5, float(y) + 0.5


#: 加選點離連通塊多近算「點在這塊上」（延伸舊遮罩）：max(這麼多 px, 連通塊外接框長邊 × NEAR_FRAC)。
NEAR_PX = 6.0
NEAR_FRAC = 0.15


def _components(mask: np.ndarray) -> tuple[np.ndarray, list[tuple[int, int, int, int]]]:
    """8 連通的連通塊 → (標籤圖, [(x0, y0, x1, y1) 半開]，索引 i 對應標籤 i+1)。"""
    import cv2

    n, labels, stats, _cent = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    boxes = [(int(stats[i, 0]), int(stats[i, 1]), int(stats[i, 0] + stats[i, 2]), int(stats[i, 1] + stats[i, 3])) for i in range(1, n)]
    return labels, boxes


def _label_at(labels: np.ndarray, x: float, y: float) -> int:
    """點 (x, y)（邊界座標）落在哪個連通塊；不在任何塊上回 0。"""
    h, w = labels.shape
    i, j = int(np.floor(y)), int(np.floor(x))
    if 0 <= i < h and 0 <= j < w:
        return int(labels[i, j])
    return 0


def _near(box: tuple[int, int, int, int], x: float, y: float) -> bool:
    x0, y0, x1, y1 = box
    dx = max(x0 - x, 0.0, x - x1)
    dy = max(y0 - y, 0.0, y - y1)
    margin = max(NEAR_PX, NEAR_FRAC * max(x1 - x0, y1 - y0))
    return math.hypot(dx, dy) <= margin


def refine_prompts(old_mask: np.ndarray | None, prompts: SelectPrompts, width: int, height: int) -> SelectPrompts:
    """`--from` 的提示推導（規則見模組說明）。沒有舊遮罩、或使用者給了框 → 原樣回傳。"""
    if prompts.box is not None or old_mask is None or not old_mask.any():
        return prompts
    adds = [(x, y) for x, y, lb in prompts.points if lb == LABEL_ADD]
    negs = [(x, y) for x, y, lb in prompts.points if lb == LABEL_REDUCE]
    labels, boxes = _components(old_mask)
    all_ids = set(range(1, len(boxes) + 1))
    neg_ids = {lab for lab in (_label_at(labels, x, y) for x, y in negs) if lab}
    if adds:
        keep = {i for i in all_ids if any(_label_at(labels, x, y) == i or _near(boxes[i - 1], x, y) for x, y in adds)}
        if not keep:
            # 加選點都不在舊遮罩上：使用者在重新指定目標，舊遮罩（多半就是追歪的那個東西）不參與提示
            return SelectPrompts(prompts.points, None, {"from": "user-points", "reason": "add-points-outside-old-mask"})
    else:
        keep = all_ids - neg_ids or all_ids  # 每一塊都有減選點 ＝ 在同一個東西上修掉一部分：全部保留
    region = np.isin(labels, sorted(keep))
    ys, xs = np.nonzero(region)
    x0, y0, x1, y1 = float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)
    for x, y in adds:
        x0, y0 = min(x0, x - 2.0), min(y0, y - 2.0)
        x1, y1 = max(x1, x + 2.0), max(y1, y + 2.0)
    x0, y0 = max(0.0, x0), max(0.0, y0)
    x1, y1 = min(float(width), x1), min(float(height), y1)
    box = (x0, y0, x1 - x0, y1 - y0)
    r = max(4.0, 0.08 * min(x1 - x0, y1 - y0))
    anchor = interior_anchor(region, negs, r)
    pts = list(prompts.points)
    derived: dict[str, Any] = {"box": [round(v, 2) for v in box], "from": "old-mask-bbox"}
    if len(keep) < len(all_ids):
        derived["droppedComponents"] = len(all_ids) - len(keep)
    if anchor is not None:
        pts = [(anchor[0], anchor[1], LABEL_ADD)] + pts
        derived["anchor"] = [round(anchor[0], 2), round(anchor[1], 2)]
    return SelectPrompts(tuple(pts), box, derived)
