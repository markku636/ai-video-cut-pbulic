"""逐幀主體框 → 逐幀裁切矩形（純函式，無 I/O、無 numpy 以外的依賴）。

## 為什麼是「固定大小的框在來源上平移」

自動重構圖有兩派做法：一派每幀重算裁切大小（主體小就推近、主體大就拉遠），一派固定大小只平移。
這裡選固定大小，理由是**呼吸感**：裁切大小每幀都變，等於畫面一直在微幅縮放，
而縮放倍率一變，重取樣的銳利度也跟著變，成品會有一層說不出哪裡怪的脈動。
要推近的人可以用 `zoom` 一次決定，整段維持同一個倍率。

固定大小還帶來一個很實際的好處：裁切變成**純記憶體切片**。`crop_size()` 只回「長寬比精確、
長寬都是偶數」的尺寸，而 `plan_path()` 只回偶數的 x / y，所以 yuv420 的三個平面都能直接切，
成品與來源逐位元相同 —— 沒有任何重取樣。代價是輸出尺寸不是 1080×1920 那種整數（見 `crop_size` 說明），
那是縮放的問題，不是裁切的問題，留給呼叫端決定。

## 鏡頭怎麼動（這裡是好不好看的全部）

三段機制疊起來，對應攝影師的三個習慣：

1. **盲區（deadzone）**：主體在畫面中央一帶晃動時**完全不動**。少了這個，鏡頭會跟著主體的
   每一次呼吸抖，是「一看就是機器裁的」最大來源。盲區只管「要不要開始追」，一旦開始追就即時跟，
   不會追到盲區邊緣就停（那會變成一格一格的跳）。
2. **速度與加速度上限**：手持或雲台都不可能瞬間到位。加速度上限給了淡入、
   「離目標越近越慢」（`follow_gain`）給了淡出，合起來就是一次有頭有尾的平移。
3. **切換而不是甩鏡**：目標中心一幀之內跳超過 `cut_threshold`（例如換了講話的人、或根本換了鏡頭），
   用**切**的直接到位。真人攝影師遇到這種情況也是切，硬追會變成一段沒有意義的甩鏡。
   鏡頭邊界（`cuts`）可以由呼叫端直接給，專案本來就有鏡頭偵測，那比猜準得多。

## 追不到的幀

偵測是逐幀的、一定會有漏。漏掉的幀**沿用上一個目標**而不是回到中央：
回中央會讓鏡頭在「有偵測」與「沒偵測」之間來回擺，比跟丟還難看。
整段都沒有偵測就停在中央，這時輸出等於一次靜態裁切 —— 仍然是可用的成品。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from fractions import Fraction

#: 常用的目標長寬比。值是約分過的 (w, h)。
ASPECT_PRESETS: dict[str, tuple[int, int]] = {
    "9:16": (9, 16),
    "4:5": (4, 5),
    "1:1": (1, 1),
    "16:9": (16, 9),
    "4:3": (4, 3),
    "2.39:1": (239, 100),
}


#: 主體黏著：候選分數達到最高分這個倍數就算「一樣強」，此時取離上一個主體最近的那個。
STICK_RATIO = 0.75


class ReframeError(ValueError):
    """規劃器自己的錯誤；呼叫端負責包成 OpError（純函式不該知道 op 層的型別）。"""


def parse_aspect(text: str) -> tuple[int, int]:
    """`"9:16"` / `"9x16"` / `"0.5625"` → 約分後的 (w, h)。

    小數也收（有些人習慣講 2.39），一律先化成分數再約分，所以 `"9:16"` 與 `"0.5625"` 得到同一個答案。
    """
    s = (text or "").strip().lower().replace("×", "x")
    if not s:
        raise ReframeError("長寬比是空的")
    if s in ASPECT_PRESETS:
        return ASPECT_PRESETS[s]
    sep = ":" if ":" in s else ("x" if "x" in s else ("/" if "/" in s else None))
    try:
        if sep:
            a, b = s.split(sep, 1)
            f = Fraction(str(float(a))).limit_denominator(10000) / Fraction(str(float(b))).limit_denominator(10000)
        else:
            f = Fraction(str(float(s))).limit_denominator(10000)
    except (ValueError, ZeroDivisionError) as e:
        raise ReframeError(f"看不懂的長寬比 {text!r}（試試 9:16 或 0.5625）") from e
    if f <= 0:
        raise ReframeError(f"長寬比要大於 0（拿到 {text!r}）")
    return (f.numerator, f.denominator)


@dataclass(frozen=True)
class Box:
    """來源像素座標的主體框（xywh，左上原點）。`score` 只在「框太多塞不下」時用來挑主體。"""

    x: float
    y: float
    w: float
    h: float
    score: float = 1.0

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2


@dataclass(frozen=True)
class ReframeOptions:
    """鏡頭的個性。長度單位一律是**裁切框的比例**、時間單位一律是**秒**，所以換解析度或換 fps 不必重調。"""

    aspect: tuple[int, int] = (9, 16)
    #: >1 裁得更小（推近）。1 = 塞得下的最大框。
    zoom: float = 1.0
    #: 盲區半徑，裁切框寬（或高）的比例。主體中心在這個帶內就完全不動。
    deadzone: float = 0.10
    #: 追到多近算追到；連同速度一起低於這個值才停下來。
    settle: float = 0.015
    #: 平移速度上限：每秒幾個裁切框寬。
    max_speed: float = 0.7
    #: 加速度上限：每秒² 幾個裁切框寬。這一項決定平移的「起步」有多軟。
    max_accel: float = 2.2
    #: 追焦增益（每秒）。越大越貼，越小越懶；它負責平移的「收尾」。
    follow_gain: float = 3.0
    #: 目標中心一幀跳超過**來源**寬（或高）的這個比例 → 用切的。
    cut_threshold: float = 0.35
    #: 主體黏著強度（見 `STICK_RATIO`）。0 = 關掉，永遠跟分數最高的。
    stick_ratio: float = STICK_RATIO
    #: 裁切框中心的固定偏移，單位是裁切框的比例。
    #: `bias_y = +0.08` 把框往下挪 8% 框高 → 主體在成品裡偏上（人像的頭頂留白）。
    bias_x: float = 0.0
    bias_y: float = 0.0

    def validated(self) -> "ReframeOptions":
        if self.zoom <= 0:
            raise ReframeError(f"zoom 要大於 0（拿到 {self.zoom}）")
        if not 0 <= self.deadzone < 0.5:
            raise ReframeError(f"deadzone 要在 [0, 0.5)（拿到 {self.deadzone}）")
        if self.max_speed <= 0 or self.max_accel <= 0 or self.follow_gain <= 0:
            raise ReframeError("max_speed / max_accel / follow_gain 都要大於 0")
        aw, ah = self.aspect
        if aw <= 0 or ah <= 0:
            raise ReframeError(f"長寬比要正數（拿到 {self.aspect}）")
        return self


@dataclass(frozen=True)
class CropRect:
    """來源像素座標的裁切矩形。x / y / w / h 保證都是偶數（yuv420 的色度平面要對齊）。"""

    x: int
    y: int
    w: int
    h: int


@dataclass(frozen=True)
class ReframePath:
    """規劃結果。`rects` 與輸入的幀數等長。"""

    source: tuple[int, int]
    size: tuple[int, int]
    rects: list[CropRect]
    #: 用「切」而不是平移的幀（含第 0 幀的就位）。UI 拿來畫標記、人拿來檢查切點對不對。
    cuts: list[int] = field(default_factory=list)
    #: 有幾幀完全沒有偵測（沿用了上一個目標）。太高就代表該換偵測參數，不是該調鏡頭。
    missing: int = 0

    @property
    def static(self) -> bool:
        """整段都沒動過 → 這其實是一次靜態裁切（呼叫端可以據此省掉逐幀路徑）。"""
        return len({(r.x, r.y) for r in self.rects}) <= 1


def _even_floor(v: float) -> int:
    return int(math.floor(v / 2) * 2)


def crop_size(src_w: int, src_h: int, aspect: tuple[int, int], zoom: float = 1.0) -> tuple[int, int]:
    """塞得進來源、長寬比**精確**、長寬都是偶數的最大裁切尺寸。

    為什麼要精確而不是「最大再四捨五入」：1920×1080 取 9:16 的理論最大是 607.5×1080，
    取整成 608×1080 的比例是 0.5630 不是 0.5625 —— 上傳平台會再補一次黑邊或再縮一次。
    改成找最大的 k 使 (9k, 16k) 都是偶數且塞得下，得到 594×1056：比例精確、
    比理論最大只少 2%，而且因為長寬都是偶數，裁切是純切片、零重取樣。
    """
    if src_w < 2 or src_h < 2:
        raise ReframeError(f"來源太小（{src_w}×{src_h}）")
    aw, ah = aspect
    g = math.gcd(aw, ah)
    aw, ah = aw // g, ah // g
    # (aw*k, ah*k) 都要是偶數：其中一邊是奇數時 k 必須是偶數
    step = 1 if (aw % 2 == 0 and ah % 2 == 0) else 2
    k = min(src_w / aw, src_h / ah) / max(zoom, 1e-9)
    k = int(math.floor(k / step) * step)
    if k < step:
        raise ReframeError(f"{src_w}×{src_h} 放不下 {aspect[0]}:{aspect[1]}（zoom={zoom}）")
    w, h = aw * k, ah * k
    if w > src_w or h > src_h:  # zoom < 1 時會超出來源，夾回去
        k = int(math.floor(min(src_w / aw, src_h / ah) / step) * step)
        w, h = aw * k, ah * k
    return (w, h)


def center_bounds(src: int, crop: int) -> tuple[float, float]:
    """裁切框中心在這條軸上的合法範圍。框跟來源一樣大時上下界相同（這條軸不能動）。"""
    half = crop / 2
    return (half, max(half, src - half))


def desired_center(
    boxes: list[Box],
    crop_w: float,
    crop_h: float,
    *,
    bias_x: float = 0.0,
    bias_y: float = 0.0,
    prev: tuple[float, float] | None = None,
    stick_ratio: float = STICK_RATIO,
) -> tuple[float, float] | None:
    """這一幀希望裁切框的中心在哪；沒有框就 None。

    多個框時**先試聯集**：塞得下就框住全部（兩個人同框比只框一個人好）。
    塞不下就得挑一個 —— 硬取聯集中心會讓每個人都半個在畫面外，是比跟丟更糟的結果。

    挑的時候**會黏住上一次跟的那個**（`prev`）：候選裡凡是分數達到最高分 `stick_ratio` 倍的，
    取離 `prev` 最近的。少了這一條，畫面裡兩個主體的分數只要每次偵測互換一次，
    結果就是鏡頭在兩人之間來回切 —— 實測一段七秒的雙手畫面會切六次，完全不能看。
    分數差距拉開（新主體明顯更像）時才換人，那才是真的該換。
    """
    if not boxes:
        return None
    if len(boxes) == 1:
        b = boxes[0]
        cx, cy = b.cx, b.cy
    else:
        x0 = min(b.x for b in boxes)
        y0 = min(b.y for b in boxes)
        x1 = max(b.x + b.w for b in boxes)
        y1 = max(b.y + b.h for b in boxes)
        if (x1 - x0) <= crop_w and (y1 - y0) <= crop_h:
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        else:
            b = pick_subject(boxes, prev, stick_ratio)
            cx, cy = b.cx, b.cy
    return (cx + bias_x * crop_w, cy + bias_y * crop_h)


def pick_subject(boxes: list[Box], prev: tuple[float, float] | None, stick_ratio: float = STICK_RATIO) -> Box:
    """框塞不下時跟誰。沒有 `prev` 就分數最高（同分取大的）；有 `prev` 就在「夠強的候選」裡取最近的。"""
    best = max(boxes, key=lambda z: (z.score, z.w * z.h))
    if prev is None or stick_ratio <= 0:
        return best
    strong = [b for b in boxes if b.score >= best.score * stick_ratio]
    return min(strong or [best], key=lambda z: (z.cx - prev[0]) ** 2 + (z.cy - prev[1]) ** 2)


def centers_from_boxes(
    boxes_per_frame: list[list[Box]], crop_w: float, crop_h: float, opts: "ReframeOptions"
) -> list[tuple[float, float] | None]:
    """逐幀（或逐取樣幀）算目標中心，並把「上一次跟的是誰」串下去。

    串 `prev` 是主體黏著唯一需要的狀態；抽樣偵測與逐幀偵測都走這一支，
    所以兩條路的換人行為一致。沒有偵測的幀不更新 `prev`（跟丟幾幀不該換人）。
    """
    out: list[tuple[float, float] | None] = []
    prev: tuple[float, float] | None = None
    for bs in boxes_per_frame:
        c = desired_center(bs, crop_w, crop_h, bias_x=opts.bias_x, bias_y=opts.bias_y, prev=prev, stick_ratio=opts.stick_ratio)
        if c is not None:
            prev = c
        out.append(c)
    return out


@dataclass(frozen=True)
class AxisParams:
    """一條軸的追焦參數，已經換算成**像素／幀**（跟 fps 與解析度脫鉤之後的樣子）。"""

    lo: float
    hi: float
    deadzone: float
    settle: float
    max_speed: float
    max_accel: float
    gain: float


def follow_axis(desired: list[float], params: AxisParams, cuts: set[int] | None = None) -> list[float]:
    """一條軸的追焦（盲區 → 加速度上限 → 收尾）。`desired` 已經補過洞、`cuts` 是要用切的幀。

    回傳每幀的中心位置。這支是整個模組最值得看的地方，也是測試最密的地方。
    """
    p = params
    cuts = cuts or set()
    out: list[float] = []
    x = 0.0
    v = 0.0
    moving = False
    for i, d_raw in enumerate(desired):
        d = min(max(d_raw, p.lo), p.hi)  # 先把目標夾進合法範圍，免得追一個永遠追不到的點
        if i == 0 or i in cuts:
            x, v, moving = d, 0.0, False
            out.append(x)
            continue
        err = d - x
        if not moving and abs(err) > p.deadzone:
            moving = True  # 盲區只管「要不要起步」；起步之後就即時跟，不是追到盲區邊緣就停
        if moving:
            if abs(err) <= p.settle and abs(v) <= p.settle:
                moving, v = False, 0.0
            else:
                vt = max(-p.max_speed, min(p.max_speed, err * p.gain))
                v = max(v - p.max_accel, min(v + p.max_accel, vt))
                x = min(max(x + v, p.lo), p.hi)
        else:
            v = 0.0
        out.append(x)
    return out


def fill_gaps(centers: list[tuple[float, float] | None], fallback: tuple[float, float]) -> tuple[list[tuple[float, float]], int]:
    """沒有偵測的幀沿用**上一個**目標；開頭就沒有的用下一個有的（都沒有才用 fallback）。

    回 (補好的序列, 補了幾幀)。往前找而不是回中央的理由見模組說明。
    """
    n = len(centers)
    missing = sum(1 for c in centers if c is None)
    if missing == n:
        return ([fallback] * n, missing)
    first = next(c for c in centers if c is not None)
    out: list[tuple[float, float]] = []
    last = first
    for c in centers:
        if c is not None:
            last = c
        out.append(last)
    return (out, missing)


def interpolate_centers(
    centers: list[tuple[float, float] | None], max_jump: tuple[float, float]
) -> list[tuple[float, float] | None]:
    """抽樣偵測留下的**內部**空洞用線性內插補起來；跳太遠的空洞不補。

    為什麼需要內插：`--every 6` 這種抽樣如果只靠 `fill_gaps` 沿用，目標訊號會變成六格一階的樓梯，
    追焦器雖然吃得下，但每一階都會重新起步一次，成品是一頓一頓的。

    為什麼跳太遠的**不能**補：鏡頭切在兩個取樣點之間時，內插會把「一幀就位」攤成六幀的甩鏡，
    而且攤平之後 `detect_cuts` 也認不出那是切點了。留成 None 交給 `fill_gaps` 沿用，
    跳躍就完整保留在下一個取樣點上，切點照樣偵得到。

    頭尾的空洞不碰（沒有兩端就沒有東西可內插），交給 `fill_gaps`。
    """
    n = len(centers)
    out = list(centers)
    known = [i for i, c in enumerate(centers) if c is not None]
    if len(known) < 2:
        return out
    mx, my = max_jump
    for a, b in zip(known, known[1:]):
        if b - a < 2:
            continue
        ca, cb = centers[a], centers[b]
        assert ca is not None and cb is not None
        if abs(cb[0] - ca[0]) > mx or abs(cb[1] - ca[1]) > my:
            continue  # 這一段之間有切點，保留跳躍
        for i in range(a + 1, b):
            t = (i - a) / (b - a)
            out[i] = (ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t)
    assert len(out) == n
    return out


def detect_cuts(centers: list[tuple[float, float]], src_w: int, src_h: int, threshold: float) -> set[int]:
    """目標中心一幀之內跳太遠 → 這一幀用切的。門檻是**來源**尺寸的比例（跟裁切大小無關）。"""
    if threshold <= 0:
        return set()
    tx, ty = src_w * threshold, src_h * threshold
    return {i for i in range(1, len(centers)) if abs(centers[i][0] - centers[i - 1][0]) > tx or abs(centers[i][1] - centers[i - 1][1]) > ty}


def plan_path(
    boxes_per_frame: list[list[Box]],
    src_size: tuple[int, int],
    fps: float,
    opts: ReframeOptions,
    *,
    cuts: list[int] | None = None,
) -> ReframePath:
    """逐幀主體框 → 逐幀裁切矩形。

    `cuts` 是呼叫端已知的鏡頭邊界（專案有鏡頭偵測，給了就比猜準）；
    另外還會自動補上「目標中心跳太遠」的幀。兩者聯集。
    """
    opts = opts.validated()
    cw, ch = crop_size(int(src_size[0]), int(src_size[1]), opts.aspect, opts.zoom)
    raw = centers_from_boxes(boxes_per_frame, cw, ch, opts)
    return plan_from_centers(raw, src_size, fps, opts, cuts=cuts)


def plan_from_centers(
    centers: list[tuple[float, float] | None],
    src_size: tuple[int, int],
    fps: float,
    opts: ReframeOptions,
    *,
    cuts: list[int] | None = None,
) -> ReframePath:
    """已經算好每幀目標中心時的入口（抽樣偵測 + `interpolate_centers` 之後走這裡）。

    `plan_path` 只是「框 → 中心」再轉呼叫這一支；兩條路共用同一個追焦器，
    所以逐幀偵測與抽樣偵測不會養出兩套手感。
    """
    opts = opts.validated()
    src_w, src_h = int(src_size[0]), int(src_size[1])
    n = len(centers)
    cw, ch = crop_size(src_w, src_h, opts.aspect, opts.zoom)
    if n == 0:
        return ReframePath(source=(src_w, src_h), size=(cw, ch), rects=[], cuts=[], missing=0)
    if fps <= 0:
        raise ReframeError(f"fps 要大於 0（拿到 {fps}）")

    filled, missing = fill_gaps(centers, (src_w / 2, src_h / 2))
    cut_set = detect_cuts(filled, src_w, src_h, opts.cut_threshold)
    for c in cuts or ():
        if 0 < c < n:
            cut_set.add(int(c))

    def axis(size_src: int, size_crop: int) -> AxisParams:
        lo, hi = center_bounds(size_src, size_crop)
        return AxisParams(
            lo=lo, hi=hi,
            deadzone=opts.deadzone * size_crop,
            settle=opts.settle * size_crop,
            max_speed=opts.max_speed * size_crop / fps,
            max_accel=opts.max_accel * size_crop / (fps * fps),
            gain=opts.follow_gain / fps,
        )

    xs = follow_axis([c[0] for c in filled], axis(src_w, cw), cut_set)
    ys = follow_axis([c[1] for c in filled], axis(src_h, ch), cut_set)
    rects = [CropRect(x=_snap(x - cw / 2, src_w - cw), y=_snap(y - ch / 2, src_h - ch), w=cw, h=ch) for x, y in zip(xs, ys)]
    return ReframePath(source=(src_w, src_h), size=(cw, ch), rects=rects, cuts=sorted(cut_set | {0}), missing=missing)


def _snap(v: float, limit: int) -> int:
    """左上角取偶數並夾進 [0, limit]。偶數是 yuv420 的硬性要求（色度平面是半解析度）。"""
    return max(0, min(_even_floor(max(0.0, v) + 1), _even_floor(limit)))


def static_path(src_size: tuple[int, int], n: int, opts: ReframeOptions) -> ReframePath:
    """完全不追焦的靜態置中裁切。沒有偵測可用、或使用者只想要「裁成直的」時的退路。"""
    opts = opts.validated()
    src_w, src_h = int(src_size[0]), int(src_size[1])
    cw, ch = crop_size(src_w, src_h, opts.aspect, opts.zoom)
    x = _snap(src_w / 2 - cw / 2 + opts.bias_x * cw, src_w - cw)
    y = _snap(src_h / 2 - ch / 2 + opts.bias_y * ch, src_h - ch)
    r = CropRect(x=x, y=y, w=cw, h=ch)
    return ReframePath(source=(src_w, src_h), size=(cw, ch), rects=[replace(r) for _ in range(n)], cuts=[0] if n else [], missing=n)


def segments(path: ReframePath) -> list[tuple[int, int, CropRect]]:
    """把逐幀矩形壓成 [(起, 迄不含, 矩形)]。給人看的摘要，也讓 JSON 小很多（靜態段佔大多數）。"""
    out: list[tuple[int, int, CropRect]] = []
    for i, r in enumerate(path.rects):
        if out and out[-1][2] == r:
            a, _, rr = out[-1]
            out[-1] = (a, i + 1, rr)
        else:
            out.append((i, i + 1, r))
    return out
