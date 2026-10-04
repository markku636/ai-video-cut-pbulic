"""`apply_effects(frame, k, objects, stacks)`：一幀、多個物件、每個物件一串特效 → 新的一幀。

## 流程

1. 每個（物件, 特效）先**只算幾何**：作用範圍（alpha）與要讀的範圍（馬賽克要整格、模糊要核的半徑）。
   物件這一幀不在 → 這個物件的特效全部跳過（不做任何猜測；`fx` op 會把這種幀數回報出來）。
2. 要讀的範圍擴到偶數對齊、**互相碰到的併成一組**（`group_jobs`）→ 每組只把自己那塊轉成線性光
   （`comp/_color.yuv420_to_linear`，ROI 版）。兩個在對角的小物件不會變成整張畫面的浮點運算。
3. 組內依特效檔的順序逐一套用（後面的特效看得到前面的結果：先馬賽克再描邊，描邊畫在馬賽克上）。
   不同組互不相交、讀不到彼此的結果，所以順序關係與一個大 ROI 完全相同。
4. 每組寫回一次：`_color.write_back(planes, roi, out, orig, 寫入遮罩)`，寫入遮罩＝組內特效 alpha > 0 的聯集。
   `FxResult.roi`／`mask` 是所有組的外接框與合起來的作用範圍。

## 「作用範圍外逐位元相同」在 yuv420p 上的精確定義（測試 `tests/test_fx_apply.py` 逐條驗）

令 F ＝ 所有特效的作用範圍聯集（像素集合；遮罩類特效＝羽化後 alpha > 0、描邊／光暈＝線條／光的 alpha > 0、
貼紙與文字＝變形後 alpha > 0）。則：

- **Y（亮度）**：不在 F 裡的像素，Y 位元組與輸入完全相同（write_back 只寫遮罩內的 Y）。
- **U／V（色度）**：一個色度樣本對應一個 2×2 亮度區塊（奇數邊緣是 1×2／2×1／1×1）。區塊裡**沒有任何** F 的像素
  → 該樣本完全相同。區塊**部分**在 F 裡 → 樣本會變，變化量是區塊內各像素色度差的面積平均（F 外的像素差為 0，
  所以只吸收 F 內那幾個像素的變化）。這是 4:2:0 本身的限制：半個色度樣本沒辦法只改一半。
- F 內但特效結果剛好等於原值的像素（例如調色後顏色沒變）：差值為 0 → 位元也不變。

RGB8 輸入（預覽、測試）沒有色度子取樣：F 外的每個 RGB 位元組都相同。
"""
from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from ..comp import _color
from ..objects.track import ObjectFrame
from . import effects as E
from .footprint import Region, clamp_window, footprint_region
from .overlay import load_sticker, pivot_uv, placement, render_text, sticker_width_px, text_px, warp_rgba
from .params import BlurFx, ColorFx, GlowFx, MosaicFx, OutlineFx, StickerFx, TextFx


@dataclass
class FxResult:
    frame: Any  # 與輸入同型別（Yuv420 或 rgb8 ndarray）；沒有改動時就是輸入本身（is）
    changed: bool
    footprint_px: int = 0  # 寫入遮罩的亮度像素數
    roi: tuple[int, int, int, int] | None = None
    applied: list[tuple[Any, str]] = field(default_factory=list)
    skipped: list[tuple[Any, str]] = field(default_factory=list)  # (物件, 原因)：物件不在、特效是 no-op…
    warnings: list[str] = field(default_factory=list)
    mask: np.ndarray | None = None  # ROI 內的作用範圍 F（bool，形狀＝roi 的高×寬）；F 外的位元組不動

    def footprint(self, width: int, height: int) -> np.ndarray:
        """整張畫面大小的 F（測試與除錯用）。"""
        out = np.zeros((height, width), bool)
        if self.mask is not None and self.roi is not None:
            x0, y0, x1, y1 = self.roi
            out[y0:y1, x0:x1] = self.mask
        return out


# ---------------------------------------------------------------------------
# 工作（一個物件的一個特效）
# ---------------------------------------------------------------------------
class _Job:
    read: tuple[int, int, int, int]

    def run(self, work: np.ndarray, rx0: int, ry0: int) -> tuple[int, int, np.ndarray] | None:  # pragma: no cover - 介面
        raise NotImplementedError


def _sub(work: np.ndarray, box: tuple[int, int, int, int], rx0: int, ry0: int) -> np.ndarray:
    x0, y0, x1, y1 = box
    return work[y0 - ry0 : y1 - ry0, x0 - rx0 : x1 - rx0]


def _blend_into(sub: np.ndarray, eff: np.ndarray, a: np.ndarray) -> np.ndarray:
    """sub[a>0] ← sub·(1−a) + eff·a（就地）；回寫入遮罩。"""
    sel = a > 0
    if sel.any():
        aa = a[sel][:, None]
        sub[sel] = sub[sel] * (1.0 - aa) + eff[sel] * aa
    return sel


def _region_alpha_in(box: tuple[int, int, int, int], reg: Region) -> np.ndarray:
    x0, y0, x1, y1 = box
    a = np.zeros((y1 - y0, x1 - x0), np.float32)
    a[reg.y0 - y0 : reg.y1 - y0, reg.x0 - x0 : reg.x1 - x0] = reg.alpha
    return a


class _MosaicJob(_Job):
    def __init__(self, reg: Region, block: int, grid: tuple[int, int], opacity: float, W: int, H: int) -> None:
        gx, gy = grid
        b = block
        x0 = max(0, gx + math.floor((reg.x0 - gx) / b) * b)
        y0 = max(0, gy + math.floor((reg.y0 - gy) / b) * b)
        x1 = min(W, gx + math.ceil((reg.x1 - gx) / b) * b)
        y1 = min(H, gy + math.ceil((reg.y1 - gy) / b) * b)
        self.read = (x0, y0, x1, y1)
        self.reg, self.block, self.grid, self.opacity = reg, b, grid, opacity

    def run(self, work: np.ndarray, rx0: int, ry0: int) -> tuple[int, int, np.ndarray]:
        sub = _sub(work, self.read, rx0, ry0)
        pix = E.pixelate(sub, self.read[0], self.read[1], self.block, self.grid[0], self.grid[1])
        a = _region_alpha_in(self.read, self.reg) * np.float32(self.opacity)
        return self.read[0], self.read[1], _blend_into(sub, pix, a)


class _BlurJob(_Job):
    def __init__(self, reg: Region, radius: int, opacity: float) -> None:
        self.read = (reg.x0, reg.y0, reg.x1, reg.y1)
        self.reg, self.radius, self.opacity = reg, radius, opacity

    def run(self, work: np.ndarray, rx0: int, ry0: int) -> tuple[int, int, np.ndarray]:
        from ..bg.blur import normalized_blur

        sub = _sub(work, self.read, rx0, ry0)
        # 權重＝羽化前的硬範圍：只用物件自己的像素平均 → 背景顏色進不來（bg/blur 的光暈論證反過來用）
        blurred = normalized_blur(sub, self.reg.core.astype(np.float32), self.radius)
        return self.read[0], self.read[1], _blend_into(sub, blurred, self.reg.alpha * np.float32(self.opacity))


class _ColorJob(_Job):
    def __init__(self, reg: Region, fx: ColorFx) -> None:
        self.read = (reg.x0, reg.y0, reg.x1, reg.y1)
        self.reg, self.fx = reg, fx

    def run(self, work: np.ndarray, rx0: int, ry0: int) -> tuple[int, int, np.ndarray]:
        sub = _sub(work, self.read, rx0, ry0)
        a = self.reg.alpha * np.float32(self.fx.opacity)
        sel = a > 0
        if sel.any():
            out = E.color_transform(sub[sel], self.fx)
            aa = a[sel][:, None]
            sub[sel] = sub[sel] * (1.0 - aa) + out * aa
        return self.read[0], self.read[1], sel


class _StrokeJob(_Job):
    """描邊與外光暈：alpha 直接從遮罩算（不經過 Footprint）。"""

    def __init__(self, box: tuple[int, int, int, int], alpha: np.ndarray, color_lin: np.ndarray, mode: str) -> None:
        self.read = box
        self.alpha, self.color, self.mode = alpha, color_lin, mode

    def run(self, work: np.ndarray, rx0: int, ry0: int) -> tuple[int, int, np.ndarray]:
        sub = _sub(work, self.read, rx0, ry0)
        sel = self.alpha > 0
        if sel.any():
            if self.mode == "screen":
                out = E.screen(sub, self.color, self.alpha)
                sub[sel] = out[sel]
            else:
                aa = self.alpha[sel][:, None]
                sub[sel] = sub[sel] * (1.0 - aa) + self.color[None, :] * aa
        return self.read[0], self.read[1], sel


class _OverlayJob(_Job):
    def __init__(self, x0: int, y0: int, rgba: np.ndarray, opacity: float) -> None:
        self.read = (x0, y0, x0 + rgba.shape[1], y0 + rgba.shape[0])
        self.rgba, self.opacity = rgba, opacity

    def run(self, work: np.ndarray, rx0: int, ry0: int) -> tuple[int, int, np.ndarray]:
        from .overlay import over_gamma

        sub = _sub(work, self.read, rx0, ry0)
        out, a = over_gamma(sub, self.rgba, self.opacity)
        sel = a > 0
        sub[sel] = out[sel]
        return self.read[0], self.read[1], sel


# ---------------------------------------------------------------------------
# 規劃
# ---------------------------------------------------------------------------
def _mask_window(obj: ObjectFrame, margin: int, W: int, H: int) -> tuple[int, int, int, int] | None:
    assert obj.anchor is not None and obj.anchor.bbox is not None
    x, y, w, h = obj.anchor.bbox
    return clamp_window(x - margin, y - margin, x + w + margin, y + h + margin, W, H)


def _edge_padded(mask: np.ndarray, box: tuple[int, int, int, int], pad: int, W: int, H: int) -> tuple[np.ndarray, tuple[int, int, int, int]]:
    """視窗貼著畫面邊的那幾側，用 BORDER_REPLICATE 往外補 pad px（物件在畫面外「繼續延伸」）。
    回 (補過的遮罩, (上, 下, 左, 右) 補了幾 px)。描邊要這樣：findContours 會把視窗邊當成物件的邊界，
    貼著畫面邊的物件就沿著畫面邊被描出一條實心的線（線壓在物件**裡面**）。"""
    import cv2

    x0, y0, x1, y1 = box
    t = pad if y0 == 0 else 0
    b = pad if y1 == H else 0
    lft = pad if x0 == 0 else 0
    r = pad if x1 == W else 0
    if not (t or b or lft or r):
        return mask, (0, 0, 0, 0)
    m = cv2.copyMakeBorder(mask.astype(np.uint8), t, b, lft, r, cv2.BORDER_REPLICATE)
    return m.astype(bool), (t, b, lft, r)


def _mosaic_grid(e: MosaicFx, obj: ObjectFrame, box: tuple[float, float, float, float]) -> tuple[int, tuple[int, int]]:
    """這一幀的 (格子大小, 格線原點)。物件帶著整段錨點時用 `effects.mosaic_series`（整段一起算、有遲滯，格子不逐幀跳）；
    沒有（手組的 ObjectFrame）就逐幀算。"""
    a = obj.anchor
    if a is not None and a.run is not None and obj.run_anchors is not None:
        key = ("mosaic", e.block, e.blocks, e.min_block, e.align, e.footprint.smooth, int(a.run))
        memo = obj.memo if obj.memo is not None else {}
        series = memo.get(key)
        if series is None:
            seq = [(r.k, b) for r in obj.run_anchors(int(a.run)) if (b := r.box(e.footprint.smooth)) is not None]
            series = memo[key] = E.mosaic_series(seq, e.block, e.blocks, e.min_block, e.align)
        hit = series.get(int(a.k))
        if hit is not None:
            return hit[0], (hit[1], hit[2])
    block = E.mosaic_block(e.block, e.blocks, e.min_block, box)
    grid = (0, 0) if e.align == "frame" else (int(round(box[0])), int(round(box[1])))
    return block, grid


def plan_effect(e: Any, obj: ObjectFrame, W: int, H: int, warnings: list[str]) -> _Job | None:
    """一個特效 → 一個工作（只算幾何）。什麼都不會改（物件不在、不透明度 0、調色是恆等）→ None。"""
    if not obj.visible or obj.anchor is None or obj.mask is None:
        return None
    if getattr(e, "opacity", 1.0) <= 0.0:
        return None
    a = obj.anchor
    if isinstance(e, MosaicFx):
        reg = footprint_region(obj, e.footprint, W, H)
        box = a.box(e.footprint.smooth)
        if reg is None or box is None:
            return None
        block, grid = _mosaic_grid(e, obj, box)
        return _MosaicJob(reg, block, grid, e.opacity, W, H)
    if isinstance(e, BlurFx):
        box = a.box(e.footprint.smooth)
        if box is None:
            return None
        r = E.blur_radius(e.radius, e.strength, e.min_radius, box)
        reg = footprint_region(obj, e.footprint, W, H, margin=r + 2)
        return None if reg is None else _BlurJob(reg, r, e.opacity)
    if isinstance(e, ColorFx):
        if e.is_identity:
            return None
        reg = footprint_region(obj, e.footprint, W, H)
        return None if reg is None else _ColorJob(reg, e)
    if isinstance(e, OutlineFx):
        from ..bg.outline import DEFAULT_WIDTH_PCT, line_width_px, stroke_alpha

        ca = float(e.color[3])  # #RRGGBBAA 的 A：跟 opacity 相乘（以前被默默丟掉）
        if ca <= 0.0:
            return None
        lw = line_width_px(W, DEFAULT_WIDTH_PCT) if e.width == "auto" else max(1, int(round(float(e.width))))
        margin = lw + 2 * e.smooth + 4
        box = _mask_window(obj, margin, W, H)
        if box is None:
            return None
        x0, y0, x1, y1 = box
        sub = obj.mask[y0:y1, x0:x1]
        pads = (0, 0, 0, 0)
        if e.mode == "contour":  # 框線（box）貼畫面邊時畫在邊上是對的：那就是看得到的框
            sub, pads = _edge_padded(sub, box, margin, W, H)
        al = stroke_alpha(sub, e.mode, lw, e.smooth)[..., 0]  # type: ignore[arg-type]
        t, _b, lft, _r = pads
        al = al[t : t + (y1 - y0), lft : lft + (x1 - x0)] * np.float32(e.opacity * ca)
        return _StrokeJob(box, np.ascontiguousarray(al), E.srgb_to_linear(e.color), "over")
    if isinstance(e, GlowFx):
        ca = float(e.color[3])
        if ca <= 0.0:
            return None
        r = max(4.0, 0.02 * W) if e.radius == "auto" else float(e.radius)
        box = _mask_window(obj, int(math.ceil(e.spread + r)) + 3, W, H)
        if box is None:
            return None
        x0, y0, x1, y1 = box
        al = E.glow_alpha(obj.mask[y0:y1, x0:x1], r, e.spread, e.intensity) * np.float32(e.opacity * ca)
        if not np.any(al > 0):
            return None
        return _StrokeJob(box, al, E.srgb_to_linear(e.color), "screen")
    if isinstance(e, StickerFx):
        pl = placement(obj, e)
        if pl is None:
            return None
        rgba = load_sticker(e.image)
        w = sticker_width_px(e, pl, W)
        warped = warp_rgba(rgba, pl.point, pivot_uv(e.pivot), w, pl.rotation, W, H)
        return None if warped is None else _OverlayJob(warped[0], warped[1], warped[2], e.opacity)
    if isinstance(e, TextFx):
        pl = placement(obj, e)
        if pl is None:
            return None
        rgba, warns = render_text(e, text_px(e, pl, H))
        for msg in warns:
            if msg not in warnings:
                warnings.append(msg)
        warped = warp_rgba(rgba, pl.point, pivot_uv(e.pivot), float(rgba.shape[1]), pl.rotation, W, H)
        return None if warped is None else _OverlayJob(warped[0], warped[1], warped[2], e.opacity)
    raise TypeError(f"不認得的特效 {type(e).__name__}")


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------
def _pairs(stacks: Any, objects: Mapping[Any, ObjectFrame]) -> list[tuple[Any, Sequence[Any]]]:
    items = list(stacks.items()) if isinstance(stacks, Mapping) else list(stacks)
    out: list[tuple[Any, Sequence[Any]]] = []
    for key, effs in items:
        if key == "*":
            out += [(k, effs) for k in objects]
        else:
            out.append((key, effs))
    return out


def _frame_size(frame: Any) -> tuple[int, int]:
    if hasattr(frame, "y"):
        return int(frame.y.shape[1]), int(frame.y.shape[0])
    return int(frame.shape[1]), int(frame.shape[0])


def apply_effects(frame: Any, k: int, objects: Mapping[Any, ObjectFrame], stacks: Any) -> FxResult:
    """frame：解碼幀（有 y/u/v 的 Yuv420，media 或 comp 版都行）或 rgb8 ndarray (H, W, 3)。
    objects：物件鍵 → 這一幀的 ObjectFrame。stacks：`{物件鍵: [特效…]}` 或 `[(物件鍵, [特效…])…]`（鍵可以是 "*"）。"""
    W, H = _frame_size(frame)
    warnings: list[str] = []
    jobs: list[_Job] = []
    applied: list[tuple[Any, str]] = []
    skipped: list[tuple[Any, str]] = []
    for key, effs in _pairs(stacks, objects):
        obj = objects.get(key)
        if obj is None or not obj.visible:
            skipped.append((key, "absent"))
            continue
        for e in effs:
            job = plan_effect(e, obj, W, H, warnings)
            if job is None:
                skipped.append((key, f"{e.type}:noop"))
                continue
            jobs.append(job)
            applied.append((key, e.type))
    if not jobs:
        return FxResult(frame, False, 0, None, applied, skipped, warnings)
    groups = group_jobs([j.read for j in jobs], W, H)
    if not groups:
        return FxResult(frame, False, 0, None, applied, skipped, warnings)
    is_yuv = hasattr(frame, "y")
    planes = (
        _color.Yuv420(frame.y, frame.u, frame.v, getattr(frame, "matrix", "bt709") or "bt709", getattr(frame, "color_range", "tv") or "tv")
        if is_yuv else None
    )
    rgb = None if is_yuv else np.ascontiguousarray(frame[..., :3])
    done: list[tuple[tuple[int, int, int, int], np.ndarray]] = []
    for roi, members in groups:
        rx0, ry0, rx1, ry1 = roi
        if is_yuv:
            assert planes is not None
            orig = _color.yuv420_to_linear(planes, roi)
        else:
            assert rgb is not None
            orig = _color.rgb8_to_linear(np.ascontiguousarray(rgb[ry0:ry1, rx0:rx1]))
        work = orig.copy()
        write = np.zeros((ry1 - ry0, rx1 - rx0), bool)
        for ji in members:  # 組內照特效檔的順序（後面的看得到前面的結果）
            res = jobs[ji].run(work, rx0, ry0)
            if res is None:
                continue
            mx, my, m = res
            write[my - ry0 : my - ry0 + m.shape[0], mx - rx0 : mx - rx0 + m.shape[1]] |= m
        if not write.any():
            continue
        if is_yuv:
            assert planes is not None
            planes = _color.write_back(planes, roi, work, orig, write)
        else:
            assert rgb is not None
            rgb = _color.write_back_rgb8(rgb, roi, work, write)
        done.append((roi, write))
    bx0 = min(r[0] for r, _m in groups)
    by0 = min(r[1] for r, _m in groups)
    bx1 = max(r[2] for r, _m in groups)
    by1 = max(r[3] for r, _m in groups)
    roi_all = (bx0, by0, bx1, by1)
    if not done:
        return FxResult(frame, False, 0, roi_all, applied, skipped, warnings)
    mask_all = np.zeros((by1 - by0, bx1 - bx0), bool)
    for (rx0, ry0, rx1, ry1), wm in done:
        mask_all[ry0 - by0 : ry1 - by0, rx0 - bx0 : rx1 - bx0] |= wm
    n = int(np.count_nonzero(mask_all))
    if is_yuv:
        assert planes is not None
        out = frame.with_planes(planes.y, planes.u, planes.v) if hasattr(frame, "with_planes") else planes
    else:
        out = rgb
    return FxResult(out, True, n, roi_all, applied, skipped, warnings, mask_all)


def group_jobs(reads: Sequence[tuple[int, int, int, int]], W: int, H: int) -> list[tuple[tuple[int, int, int, int], list[int]]]:
    """各工作的讀取範圍（擴到偶數對齊）→ 互不相交的組 [(組的 ROI, [工作索引…（原順序）])…]。

    以前所有工作的讀取範圍取**一個**聯集外接框：兩個 80×80 的臉在對角，整張畫面都要轉線性光、寫回兩次
    （1080p 每幀 2 ms → 271 ms）。分組後每組各轉各的：組與組的 ROI 不相交（偶數對齊 → 也不共用色度樣本），
    誰都讀不到別組的結果，所以結果與一個大 ROI 逐位元相同，只是只算有用的那幾塊。組的外接框合併後若又碰到別組就再併。"""
    clusters: list[tuple[list[int], list[int]]] = []  # ([x0, y0, x1, y1], [索引…])
    for i, r in enumerate(reads):
        roi = _color.even_roi(r[0], r[1], r[2], r[3], W, H)
        if roi[2] <= roi[0] or roi[3] <= roi[1]:
            continue
        clusters.append((list(roi), [i]))
    merged = True
    while merged:
        merged = False
        for a in range(len(clusters)):
            for b in range(a + 1, len(clusters)):
                ra, rb = clusters[a][0], clusters[b][0]
                if ra[0] < rb[2] and rb[0] < ra[2] and ra[1] < rb[3] and rb[1] < ra[3]:
                    box = [min(ra[0], rb[0]), min(ra[1], rb[1]), max(ra[2], rb[2]), max(ra[3], rb[3])]
                    clusters[a] = (box, sorted(clusters[a][1] + clusters[b][1]))
                    del clusters[b]
                    merged = True
                    break
            if merged:
                break
    clusters.sort(key=lambda c: c[1][0])
    return [((c[0][0], c[0][1], c[0][2], c[0][3]), c[1]) for c in clusters]
