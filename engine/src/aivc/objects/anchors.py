"""逐幀錨點：可見、面積、外接框、重心、方向角，以及**不跨缺口**的 Savitzky-Golay 平滑版。

特效（貼紙跟著物件走、馬賽克框不抖）與匯出（給 AE／Nuke／其他程式）都吃這一份，所以它是資料契約的一部分
（docs/tracking-api.md）。幾個定義寫死在這裡，改了就是改契約：

- **座標是像素邊界座標**：像素 (i, j) 佔 [i, i+1) × [j, j+1)。外接框 `bbox = [x, y, w, h]` 半開，
  與 `aivc seg --box`、pycocotools `toBbox` 同一套；重心＝各像素中心 (i+0.5, j+0.5) 的平均，
  所以單一像素 (10, 20) 的 bbox 是 [10, 20, 1, 1]、重心 (10.5, 20.5)＝框中心。
- **方向角 angle**：`cv2.minAreaRect` 的**長邊**方向，度，(-90, 90]，從 +x 往 +y 量（影像 y 向下 → 正角度在螢幕上是順時針）。
  不用 minAreaRect 自己回的 angle（OpenCV 4.5 前後定義不同，4.14 對水平長方形回 -90°）：改從 `boxPoints` 取較長那條邊算。
  **elongation**＝那個矩形的長短邊比（≥ 1）。低於 1.25 的近正方形／圓形物件，長邊會在兩個方向間跳 90°（量測換邊，不是轉動）：
  實測一張 145×151 的臉，原始角度在 0° 與 90° 之間來回跳。
- **可見 visible**：`.aivm` 這一幀是 present 條目。`computed=false` ＝ 這一幀沒算過（沒有條目）。
- **平滑**：每段「連續可見」的幀各自做 SG（預設 window 9、order 2，與 `geom/smoothing.py` 的追蹤平滑同一組），
  分段規則直接用 `geom.smoothing._runs`（k 連續 + 都可見 才算同一段）——物件消失又出現時，兩段互不影響，
  不會把「消失前的位置」平均進「出現後的位置」。段太短（< 3 幀或 window ≤ order）就照抄原值。
  **window 一定是奇數**：給偶數會減 1（`effective_window`）。偶數視窗的 SG 是在兩個樣本中間求值，
  整段平滑值會往前偏半幀（20 px/幀的物件偏 10 px），段頭段尾又不偏 → 框在邊界跳一下。
- 角度先展開成段內連續的 `angleCont`（逐幀取離上一幀最近的等價角度，把換邊的跳動吃掉；規則見 `continuous_angles`）
  再平滑，`smooth.angle` 再折回 (-90, 90]。只用 180° 週期的話，臉的平滑角度會出現 65° 這種兩個跳動平均出來的假值。
  沒平滑的展開角另存在每幀的 `angleCont`（`smooth: false` 的跟著旋轉貼紙用它）。
  代價：相鄰兩幀真的轉超過 45° 的快速旋轉（近正方形的幀）會被當成反方向的小轉動。

快取：`anchors.v1.json` 放在遮罩檔旁邊（檔名 `masks.aivm` → `anchors.v1.json`；其他檔名 `<stem>.anchors.v1.json`），
鍵＝遮罩檔的大小＋mtime＋內容雜湊＋平滑參數＋程式版本，任何一個不同就重算。寫入走 `aivc.atomic`（唯一暫存名 + 換入重試）。
資料夾不能寫（唯讀媒體）就不快取，照樣回結果。
- **雜湊的就是解析的那一份位元組**（只讀一次檔）：以前解析與雜湊各讀一次，中間被別的行程換掉檔案時，
  會把舊遮罩算出的錨點存在新檔的雜湊底下，之後每次開新檔都命中這份錯的快取。
- **算完的結果先過一次 JSON 來回**再回傳：快取命中時回的是寫進檔案、四捨五入過的值，沒命中也要回一模一樣的值，
  不然第一次 `fx`／`fx-preview` 跟之後的輸出會差幾個像素（預覽對不上成品）。
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from collections.abc import Iterator
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import numpy as np

from .. import atomic

FORMAT = "aivc.anchors.v1"
#: 3：加 elongation、角度一律以 90° 週期展開；4：偶數視窗改奇數、每幀加未平滑的 angleCont、細長物件用 180° 週期展開、
#: 直線遮罩的 elongation 是有限值（舊快取自動重算）
CODE_VERSION = 4
DEFAULT_WINDOW = 9
DEFAULT_ORDER = 2
#: 計算錨點時每幾個條目送一次進度／檢查一次取消
PROGRESS_EVERY = 32
STAGE = "objects.anchors"

Box = tuple[float, float, float, float]
Point = tuple[float, float]


@dataclass(frozen=True)
class Smoothed:
    bbox: Box
    centroid: Point
    angle: float  # (-90, 90]
    angle_cont: float  # 段內連續（展開過）的角度
    area: float

    def to_json(self) -> dict[str, Any]:
        return {
            "bbox": [round(v, 3) for v in self.bbox],
            "centroid": [round(v, 3) for v in self.centroid],
            "angle": round(self.angle, 3),
            "angleCont": round(self.angle_cont, 3),
            "area": round(self.area, 2),
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> Smoothed:
        return cls(tuple(float(v) for v in d["bbox"]), tuple(float(v) for v in d["centroid"]), float(d["angle"]), float(d.get("angleCont", d["angle"])), float(d["area"]))  # type: ignore[arg-type]


@dataclass(frozen=True)
class Anchor:
    k: int
    computed: bool
    visible: bool
    area: int = 0
    bbox: Box | None = None
    centroid: Point | None = None
    angle: float | None = None
    run: int | None = None  # 屬於第幾段連續可見（0 起算）；不可見為 None
    smooth: Smoothed | None = None
    elongation: float | None = None  # 最小外接矩形長短邊比（≥ 1）；< NEAR_SQUARE 時 angle 不可信
    angle_cont: float | None = None  # 段內連續（展開過）、**沒平滑**的角度；第一幀＝angle

    # 特效用：平滑版優先、沒有就原值
    def box(self, smoothed: bool = True) -> Box | None:
        return self.smooth.bbox if smoothed and self.smooth is not None else self.bbox

    def center(self, smoothed: bool = True) -> Point | None:
        return self.smooth.centroid if smoothed and self.smooth is not None else self.centroid

    def heading(self, smoothed: bool = True, continuous: bool = False) -> float | None:
        """方向角。continuous＝段內連續（展開過、可以直接相減）；smoothed=False 時給未平滑的展開角
        （以前 smoothed=False 會忽略 continuous、回折回 (-90, 90] 的原值：跨過 ±90° 時角度差變成 ~180°）。"""
        if smoothed and self.smooth is not None:
            return self.smooth.angle_cont if continuous else self.smooth.angle
        if continuous and self.angle_cont is not None:
            return self.angle_cont
        return self.angle

    def has_continuous_heading(self, smoothed: bool = True) -> bool:
        """heading(smoothed, continuous=True) 真的是段內連續的角度（不是折回的原值）。"""
        return (self.smooth is not None) if smoothed else (self.angle_cont is not None)

    def to_json(self) -> dict[str, Any]:
        d: dict[str, Any] = {"k": self.k, "computed": self.computed, "visible": self.visible}
        if self.visible:
            d.update({
                "area": int(self.area),
                "bbox": [round(v, 3) for v in self.bbox or ()],
                "centroid": [round(v, 3) for v in self.centroid or ()],
                "angle": None if self.angle is None else round(self.angle, 3),
                "angleCont": None if self.angle_cont is None else round(self.angle_cont, 3),
                "elongation": None if self.elongation is None or not math.isfinite(self.elongation) else round(self.elongation, 4),
                "run": self.run,
                "smooth": None if self.smooth is None else self.smooth.to_json(),
            })
        return d

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> Anchor:
        vis = bool(d.get("visible"))
        if not vis:
            return cls(int(d["k"]), bool(d.get("computed", True)), False)
        sm = d.get("smooth")
        return cls(
            int(d["k"]), bool(d.get("computed", True)), True, int(d.get("area", 0)),
            tuple(float(v) for v in d["bbox"]), tuple(float(v) for v in d["centroid"]),  # type: ignore[arg-type]
            None if d.get("angle") is None else float(d["angle"]),
            None if d.get("run") is None else int(d["run"]),
            None if not sm else Smoothed.from_json(sm),
            None if d.get("elongation") is None else float(d["elongation"]),
            None if d.get("angleCont") is None else float(d["angleCont"]),
        )


@dataclass
class Anchors:
    width: int
    height: int
    frames: dict[int, Anchor]  # 只有 .aivm 有條目的幀（computed=true）
    window: int = DEFAULT_WINDOW
    order: int = DEFAULT_ORDER
    source: dict[str, Any] = field(default_factory=dict)

    def at(self, k: int) -> Anchor | None:
        return self.frames.get(int(k))

    def ks(self) -> list[int]:
        return sorted(self.frames)

    def visible_ranges(self) -> list[tuple[int, int]]:
        """連續可見的區段，**含頭含尾** [first, last]（與 find.v1.json 的 firstFrame/lastFrame 同一個語意）。"""
        out: list[tuple[int, int]] = []
        for k in self.ks():
            a = self.frames[k]
            if not a.visible:
                continue
            if out and out[-1][1] == k - 1 and self.frames.get(k - 1) is not None and self.frames[k - 1].visible:
                out[-1] = (out[-1][0], k)
            else:
                out.append((k, k))
        return out

    def first_visible(self) -> Anchor | None:
        for k in self.ks():
            if self.frames[k].visible:
                return self.frames[k]
        return None

    def iter_all(self, k0: int | None = None, k1: int | None = None) -> Iterator[Anchor]:
        """[k0, k1]（含頭含尾，預設＝有條目的最小到最大 k）的每一幀；沒有條目的幀給 computed=false。"""
        ks = self.ks()
        if not ks:
            return
        a = ks[0] if k0 is None else int(k0)
        b = ks[-1] if k1 is None else int(k1)
        for k in range(a, b + 1):
            yield self.frames.get(k) or Anchor(k, False, False)

    def to_json(self) -> dict[str, Any]:
        return {
            "format": FORMAT,
            "code": CODE_VERSION,
            "size": [self.width, self.height],
            "smoothing": {"method": "savgol", "window": self.window, "order": self.order},
            "source": self.source,
            "visibleRanges": [list(r) for r in self.visible_ranges()],
            "frames": [self.frames[k].to_json() for k in self.ks()],
        }

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> Anchors:
        if d.get("format") != FORMAT:
            raise ValueError(f"不是 {FORMAT}：{d.get('format')!r}")
        sm = d.get("smoothing") or {}
        frames = {int(f["k"]): Anchor.from_json(f) for f in d.get("frames", [])}
        w, h = d["size"]
        return cls(int(w), int(h), frames, int(sm.get("window", DEFAULT_WINDOW)), int(sm.get("order", DEFAULT_ORDER)), dict(d.get("source") or {}))


# ---------------------------------------------------------------------------
# 量測
# ---------------------------------------------------------------------------
def wrap180(angle: float) -> float:
    """任意角度 → (-90, 90]（方向沒有正反，週期 180°）。"""
    a = math.fmod(float(angle), 180.0)
    if a <= -90.0:
        a += 180.0
    elif a > 90.0:
        a -= 180.0
    return a


def rect_orientation(points: np.ndarray) -> tuple[float, float]:
    """點集（N×2，x,y）的最小外接矩形 → (長邊方向角 (-90, 90]，長短邊比 ≥ 1)。少於 3 點或退化回 (0, 1)。"""
    import cv2

    pts = np.asarray(points, np.float32).reshape(-1, 2)
    if len(pts) < 3:
        if len(pts) == 2 and np.any(pts[1] != pts[0]):
            # 1 px 寬的直線（細線、剛離開畫面的一條邊）：findContours 只給兩個端點。
            # 套同一條「各加 1」規則 → (長 + 1) / (0 + 1)，有限值（以前回 inf，JSON 變 null、CSV 變空白）
            d = pts[1] - pts[0]
            return wrap180(math.degrees(math.atan2(float(d[1]), float(d[0])))), float(np.hypot(*d)) + 1.0
        return 0.0, 1.0
    rect = cv2.minAreaRect(pts)
    box = cv2.boxPoints(rect)
    e1 = box[1] - box[0]
    e2 = box[2] - box[1]
    l1, l2 = float(np.hypot(*e1)), float(np.hypot(*e2))
    e = e1 if l1 >= l2 else e2
    if max(l1, l2) < 1e-6:
        return 0.0, 1.0
    # 輪廓點是像素中心，矩形邊長比真實寬度少 1 px：各加 1 再比，細長的小東西才不會被當成無限細
    elong = (max(l1, l2) + 1.0) / (min(l1, l2) + 1.0)
    return wrap180(math.degrees(math.atan2(float(e[1]), float(e[0])))), float(elong)


def long_side_angle(points: np.ndarray) -> float:
    """點集的最小外接矩形長邊方向，度，(-90, 90]。"""
    return rect_orientation(points)[0]


def measure_full(mask: np.ndarray) -> tuple[int, Box, Point, float, float] | None:
    """bool 遮罩 → (面積, bbox, 重心, 方向角, 長短邊比)；空遮罩回 None。座標定義見模組說明。"""
    import cv2

    ys, xs = np.nonzero(mask)
    if xs.size == 0:
        return None
    area = int(xs.size)
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    cx, cy = float(xs.mean()) + 0.5, float(ys.mean()) + 0.5
    cnts, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    pts = np.concatenate([c.reshape(-1, 2) for c in cnts], axis=0) if cnts else np.stack([xs, ys], axis=1)
    ang, elong = rect_orientation(pts)
    return area, (float(x0), float(y0), float(x1 - x0), float(y1 - y0)), (cx, cy), ang, elong


def measure(mask: np.ndarray) -> tuple[int, Box, Point, float] | None:
    """bool 遮罩 → (面積, bbox, 重心, 方向角)；空遮罩回 None。"""
    m = measure_full(mask)
    return None if m is None else m[:4]


#: 長短邊比低於這個值＝「近正方形」：最小外接矩形的長邊會在兩個方向之間跳 90°，angle 不能當成物件的方向。
NEAR_SQUARE = 1.25
#: 長短邊比 ≥ 這個值＝「確定是細長的」：長邊方向不會量錯，展開時改用 180° 週期（只能是長邊）。
#: 刻意比 NEAR_SQUARE 高很多：實測臉在 1.01–1.38 之間來回，不能讓臉在兩種規則之間切換（會灌進假跳動）。
ELONG_CONFIDENT = 1.6


def continuous_angles(raw: list[float], elongations: list[float | None] | None = None) -> np.ndarray:
    """一段連續可見的方向角 → 段內連續的角度（第一幀等於原值）。

    - 近正方形（或沒給長短邊比）的幀：取「離上一幀最近」的 **90°** 等價角度。最小外接矩形量到的是「矩形」的方向，
      近正方形時長邊會換邊、原始角度跳 90° —— 那是量測換邊，不是轉動。
    - 確定細長（elongation ≥ ELONG_CONFIDENT）的幀：取離上一幀最近的 **180°** 等價角度 —— 只能是長邊。
      只用 90° 規則的話，細長物件中途短暫變方（轉向鏡頭）、近正方形的量測飄過 45° 之後，展開角會永遠停在短邊
      （之後明明又是 4.8 倍長的長條，平滑角度卻差 90°）。這條規則讓它一回到細長就重新對回長邊。
    限制：近正方形的幀之間真的轉超過 45° 的東西（每秒轉一圈以上）會被誤判成反方向的小轉動，寫進文件。"""
    out = np.zeros(len(raw), np.float64)
    if not raw:
        return out
    out[0] = raw[0]
    for i in range(1, len(raw)):
        e = None if elongations is None else elongations[i]
        period = 180.0 if e is not None and e >= ELONG_CONFIDENT else 90.0
        half = period / 2.0
        d = (raw[i] - out[i - 1] + half) % period - half
        out[i] = out[i - 1] + d
    return out


# ---------------------------------------------------------------------------
# 平滑（不跨缺口）
# ---------------------------------------------------------------------------
def effective_window(window: int) -> int:
    """實際用的 SG 視窗：≤ 0 → 0（不平滑）；偶數 → 減 1（偶數視窗在兩個樣本中間求值，整段偏半幀，見模組說明）。"""
    w = int(window)
    if w <= 0:
        return 0
    return w - 1 if w % 2 == 0 else w


def _savgol(values: np.ndarray, window: int, order: int) -> np.ndarray:
    """values (n, c)；段太短或參數不合就原樣回傳（與 geom.smoothing.smooth_sequence 同一組規則）。"""
    n = values.shape[0]
    window = effective_window(window)
    if window <= 0 or n < 3:
        return values.copy()
    win = min(int(window), n if n % 2 == 1 else n - 1)
    if win <= order:
        return values.copy()
    from scipy.signal import savgol_filter

    return savgol_filter(values, win, order, axis=0, mode="interp")


def smooth_anchors(frames: dict[int, Anchor], window: int = DEFAULT_WINDOW, order: int = DEFAULT_ORDER) -> dict[int, Anchor]:
    """回新的 frames：每個可見幀補上 `run` 與 `smooth`。"""
    from ..geom.smoothing import STATE_TRACKING, _runs

    ks = sorted(frames)
    vis = [frames[k].visible for k in ks]
    out = dict(frames)
    for run_i, (a, b, _state) in enumerate(_runs(ks, [STATE_TRACKING] * len(ks), vis)):
        seg = [frames[ks[i]] for i in range(a, b)]
        # 段內連續角度（近正方形 90°、細長 180° 週期，理由見函式說明）
        cont = continuous_angles([float(s.angle or 0.0) for s in seg], [s.elongation for s in seg])
        vals = np.array([
            [s.centroid[0], s.centroid[1], s.bbox[0], s.bbox[1], s.bbox[0] + s.bbox[2], s.bbox[1] + s.bbox[3], float(s.area), c]  # type: ignore[index]
            for s, c in zip(seg, cont)
        ], np.float64)
        sm = _savgol(vals, window, order)
        for i, s in enumerate(seg):
            cx, cy, x0, y0, x1, y1, ar, ang = (float(v) for v in sm[i])
            if x1 < x0:
                x0 = x1 = (x0 + x1) / 2.0
            if y1 < y0:
                y0 = y1 = (y0 + y1) / 2.0
            out[s.k] = replace(
                s, run=run_i, angle_cont=float(cont[i]),
                smooth=Smoothed((x0, y0, x1 - x0, y1 - y0), (cx, cy), wrap180(ang), ang, max(0.0, ar)),
            )
    return out


# ---------------------------------------------------------------------------
# 計算／快取
# ---------------------------------------------------------------------------
def compute(mask_file: Any, *, window: int = DEFAULT_WINDOW, order: int = DEFAULT_ORDER, ctx: Any = None) -> Anchors:
    """`seg.maskfile.MaskFile` → Anchors（每個條目解一次碼、量一次）。

    ctx（可省）：每 PROGRESS_EVERY 個條目送一次 `objects.anchors` 進度、檢查一次取消 —— 一條 10 分鐘的 1080p 軌跡
    要算一兩分鐘，以前這段完全沒有進度、App 送取消也停不下來（主 lane 就這樣被占住）。"""
    from ..seg import rle

    W, H = int(mask_file.width), int(mask_file.height)
    window = effective_window(window)
    frames: dict[int, Anchor] = {}
    total = len(mask_file.frames()) if hasattr(mask_file, "frames") else 0
    if ctx is not None:
        ctx.progress(STAGE, 0, max(1, total))
    for i, (k, counts) in enumerate(mask_file.iter_rle(), start=1):
        if ctx is not None and i % PROGRESS_EVERY == 0:
            ctx.check_cancel()
            ctx.progress(STAGE, i, max(1, total))
        if counts is None:
            frames[int(k)] = Anchor(int(k), True, False)
            continue
        m = measure_full(rle.decode(counts, H, W))
        if m is None:
            frames[int(k)] = Anchor(int(k), True, False)
            continue
        area, bbox, cen, ang, elong = m
        frames[int(k)] = Anchor(int(k), True, True, area, bbox, cen, ang, elongation=elong)
    if ctx is not None:
        ctx.progress(STAGE, max(1, total), max(1, total))
    return Anchors(W, H, smooth_anchors(frames, window, order), int(window), int(order))


def canonical(anchors: Anchors) -> Anchors:
    """跟「寫進快取再讀回來」一模一樣的值（四捨五入、inf → None）：快取命中與沒命中必須回同一份數字。"""
    return Anchors.from_json(json.loads(json.dumps(anchors.to_json(), ensure_ascii=False)))


def cache_path(masks_path: str | os.PathLike[str]) -> Path:
    p = Path(masks_path)
    return p.with_name("anchors.v1.json") if p.name == "masks.aivm" else p.with_name(p.stem + ".anchors.v1.json")


def _source_key(masks_path: Path, raw: bytes, window: int, order: int) -> dict[str, Any]:
    st = masks_path.stat()
    return {
        "file": masks_path.name,
        "bytes": len(raw),
        "mtimeNs": int(st.st_mtime_ns),
        "blake2b": hashlib.blake2b(raw, digest_size=16).hexdigest(),
        "window": int(window),
        "order": int(order),
        "code": CODE_VERSION,
    }


def load_or_compute(
    masks_path: str | os.PathLike[str],
    *,
    window: int = DEFAULT_WINDOW,
    order: int = DEFAULT_ORDER,
    cache: bool = True,
    mask_file: Any = None,
    raw: bytes | None = None,
    ctx: Any = None,
) -> tuple[Anchors, bool]:
    """(Anchors, 是否命中快取)。

    mask_file 與 raw 要一起給（`ObjectTrack.open` 讀一次檔、解析與雜湊用**同一份位元組**）；只給 mask_file 不給 raw
    會擲 ValueError —— 那等於分兩次讀檔，中間檔案被換掉就會把舊遮罩的錨點存到新檔的雜湊底下（見模組說明）。"""
    from ..seg.maskfile import MaskFile

    p = Path(masks_path)
    if mask_file is not None and raw is None:
        raise ValueError("load_or_compute：給了 mask_file 也要給解析它的那份 raw 位元組（雜湊要對同一份內容）")
    window = effective_window(window)
    if raw is None:
        raw = atomic.read_bytes(p)
    key = _source_key(p, raw, window, order)
    cp = cache_path(p)
    if cache and cp.is_file():
        try:
            d = json.loads(atomic.read_text(cp))
            src = dict(d.get("source") or {})
            if d.get("format") == FORMAT and int(d.get("code", -1)) == CODE_VERSION and all(src.get(k) == v for k, v in key.items() if k != "mtimeNs"):
                return Anchors.from_json(d), True
        except (OSError, ValueError, KeyError, TypeError):
            pass  # 壞快取 → 重算
    mf = mask_file if mask_file is not None else MaskFile.from_bytes(raw, str(p))
    anchors = compute(mf, window=window, order=order, ctx=ctx)
    anchors.source = key
    anchors = canonical(anchors)
    if cache:
        try:
            atomic.write_text(cp, json.dumps(anchors.to_json(), ensure_ascii=False, separators=(",", ":")))
        except OSError:
            pass  # 唯讀資料夾：不快取，結果照用
    return anchors, False
