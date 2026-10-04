"""追蹤執行器（計畫 §6.4）：參考影格 → 雙向掃描 → 每幀 solve_frame → 狀態機 → 平滑。

狀態 none|tracking|static|lost：
- vis = 遮罩面積 / quad 面積 < 0.15 → LOST（手遮／牌不在）。沒遮罩時連續 N 幀特徵與 ECC 都失敗 → LOST（保留最後 H 當 hold 幾何）。
- LOST 中：遮罩四角 qc>0.8 就重取得；沒遮罩就用 1+100% 的大 ROI 找特徵。
- 連 5 幀角點位移 <0.3 px → STATIC，之後每幀只驗 NCC(rectify(k), anchor face) > 0.9，H 鎖死為中位數。
- 內點比 <0.3 且 ECC 有把握 → 把 rectify(k) 當光度輔助模板（幾何仍在標準模板座標 → 不漂移）。
- vis 掉（掃牌）→ 角點等速外推當 H_prev。
- 使用者關鍵幀 = 硬釘；參考影格也是釘。平滑（Savitzky-Golay）只在 TRACKING 段、不跨釘；STATIC 段中位數。

「模板→幀、永不鏈接」：每幀都是模板對幀重解，H_prev 只提供 ROI 位置與 ECC 種子，
所以連續 400 幀靜止牌不會累積漂移（這是 `bench jitter` STATIC 段 = 0 的前提）。
"""
from __future__ import annotations

import math
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

from ..geom import homography as hg
from ..geom.quad import quad_from_mask
from ..geom.smoothing import h_to_params, params_to_h, smooth_sequence
from ..ops import OpError
from .classic import SolveParams, solve_frame
from .state import FrameSolve, Solve, State, StaticDetector, TrackOptions, VelocityPredictor
from .template import Template, quantize_scale, rectify, template_from_frame

Array = np.ndarray


class _NullCtx:
    def progress(self, stage: str, done: int, total: int, **extra: Any) -> None: ...

    def log(self, level: str, message: str) -> None: ...

    def check_cancel(self) -> None: ...

    def artifact(self, path: str, kind: str = "") -> None: ...


@dataclass
class TrackInputs:
    get_frame: Callable[[int], Array]  # k → rgb8 (H,W,3)
    template: Template
    shot: tuple[int, int]  # [k0, k1)
    get_mask: Callable[[int], Array | None] | None = None  # k → bool (H,W) 或 None（= 全可見）
    reference_frame: int | None = None
    user_keyframes: dict[int, Array] = field(default_factory=dict)  # k → quad (4,2) 幀 px（硬釘）
    tracking_region: Array | None = None  # quad (4,2) 幀 px；None = 整個表面
    options: TrackOptions = field(default_factory=TrackOptions)
    track_id: str = "track"
    _region_cache: dict[tuple[int, int], Array] = field(default_factory=dict, repr=False)

    def mask(self, k: int) -> Array | None:
        if self.get_mask is None:
            return None
        m = self.get_mask(k)
        return None if m is None else np.asarray(m, dtype=bool)

    def region_mask(self, frame_wh: tuple[int, int]) -> Array | None:
        if self.tracking_region is None:
            return None
        m = self._region_cache.get(frame_wh)
        if m is None:
            W, Hh = frame_wh
            m8 = np.zeros((Hh, W), np.uint8)
            pts = (np.asarray(self.tracking_region, dtype=np.float64).reshape(4, 2) * 256.0).round().astype(np.int32)
            cv2.fillPoly(m8, [pts.reshape(-1, 1, 2)], 1, lineType=cv2.LINE_8, shift=8)
            m = m8.astype(bool)
            self._region_cache[frame_wh] = m
        return m


# ---------------------------------------------------------------------------
# 參考影格
# ---------------------------------------------------------------------------


def _refine_from_quad(inp: TrackInputs, k: int, quad: Array, area_anchor: float | None = None) -> tuple[Array, float]:
    """四角 → H，並用 ECC 精修一次（跳動閘門放寬：四角本身就是新的真值）。"""
    tmpl = inp.template
    H0 = hg.template_to_quad(tmpl.wh, quad)
    opt = inp.options
    frame = inp.get_frame(k)
    relaxed = SolveParams(**{**opt.solve.__dict__, "jump_frac": 0.25, "jump_min_px": 12.0})
    res = solve_frame(tmpl, frame, H0, inp.mask(k), inp.region_mask((frame.shape[1], frame.shape[0])), upsample=opt.upsample, motion_model=opt.motion_model, area_anchor=area_anchor, params=relaxed)
    return (res.H, res.conf) if res.ecc_ok else (H0, 0.5)


def find_reference(inp: TrackInputs, ctx: Any = None) -> tuple[int, Array, float]:
    """回 (k_ref, H_ref, qc)。優先序：指定的 reference_frame → 離鏡頭中點最近的使用者關鍵幀 → 第一個 qc>0.9 且靜止的遮罩幀。"""
    ctx = ctx or _NullCtx()
    k0, k1 = inp.shot
    opt = inp.options

    def from_frame(k: int) -> tuple[int, Array, float]:
        if k in inp.user_keyframes:
            H, _ = _refine_from_quad(inp, k, inp.user_keyframes[k])
            return k, H, 1.0
        m = inp.mask(k)
        if m is not None:
            qr = quad_from_mask(m)
            if qr.quad is None:
                raise OpError("Invalid", f"參考影格 {k} 的遮罩找不到四邊形", "換一個乾淨的靜止幀，或用 --quad 手動指定四角")
            H, _ = _refine_from_quad(inp, k, qr.quad)
            return k, H, qr.conf
        raise OpError("Invalid", f"參考影格 {k} 沒有四角來源（沒有關鍵幀也沒有遮罩）", "用 --quad x1,y1,…,x4,y4 指定該幀的表面四角")

    if inp.reference_frame is not None:
        k = int(inp.reference_frame)
        if not (k0 <= k < k1):
            raise OpError("Invalid", f"參考影格 {k} 不在鏡頭 [{k0},{k1}) 內")
        return from_frame(k)
    if inp.user_keyframes:
        mid = (k0 + k1) / 2.0
        k = min(inp.user_keyframes, key=lambda kk: abs(kk - mid))
        return from_frame(k)
    if inp.get_mask is not None:
        prev_q: Array | None = None
        streak = 0
        for k in range(k0, k1):
            ctx.check_cancel()
            ctx.progress("reference", k - k0, k1 - k0)
            m = inp.mask(k)
            if m is None:
                continue
            qr = quad_from_mask(m, ref_tl=None if prev_q is None else prev_q[0])
            if qr.quad is None or qr.conf <= opt.reference_qc:
                prev_q, streak = None, 0
                continue
            if prev_q is not None and hg.max_corner_jump(qr.quad, prev_q) < 1.0:
                streak += 1
            else:
                streak = 0
            prev_q = qr.quad
            if streak >= opt.static_frames - 1:
                kref = k - streak
                mref = inp.mask(kref)
                qref = quad_from_mask(mref) if mref is not None else qr
                H, _ = _refine_from_quad(inp, kref, qref.quad if qref.quad is not None else qr.quad)
                return kref, H, qref.conf
    raise OpError(
        "Invalid",
        "此鏡頭沒有乾淨的參考影格（沒有 conf>0.9 的靜止幀）",
        "請手動指定 --reference-frame K 與 --quad x1,y1,…,x4,y4（或提供遮罩檔）",
    )


# ---------------------------------------------------------------------------
# 逐幀狀態機
# ---------------------------------------------------------------------------


class _Tracker:
    def __init__(self, inp: TrackInputs, ctx: Any, area_anchor: float) -> None:
        self.inp = inp
        self.ctx = ctx
        self.opt = inp.options
        self.tmpl = inp.template
        self.area_anchor = float(area_anchor)
        self.face_scale = quantize_scale(math.sqrt(max(self.area_anchor, 1.0) / self.tmpl.area))
        self.state = State.TRACKING
        self.H_prev = np.eye(3)
        self.static = StaticDetector(self.opt.static_px, self.opt.static_frames)
        self.predictor = VelocityPredictor()
        self.recent: deque[Array] = deque(maxlen=self.opt.static_frames)
        self.H_static: Array | None = None
        self.anchor_face: Array | None = None
        self.aux: Template | None = None
        self.fail_run = 0
        self.pred_active = False

    def start(self, H_seed: Array, state: State = State.TRACKING) -> None:
        self.state = state if state in (State.TRACKING, State.STATIC) else State.TRACKING
        self.H_prev = hg.normalize(H_seed)
        self.static.reset()
        self.predictor.reset()
        self.predictor.update(hg.quad_from_h(self.H_prev, self.tmpl.wh))
        self.recent.clear()
        self.recent.append(self.H_prev)
        self.H_static = None
        self.anchor_face = None
        self.aux = None
        self.fail_run = 0
        self.pred_active = False

    # ---- 工具 ----
    def _quad(self, H: Array) -> Array:
        return hg.quad_from_h(H, self.tmpl.wh)

    def _vis(self, mask: Array, quad: Array, frame_wh: tuple[int, int]) -> float:
        from .classic import roi_from_quad

        x0, y0, x1, y1 = roi_from_quad(quad, frame_wh, dilate=self.opt.roi_dilate)
        area = hg.quad_area(quad)
        if area <= 1e-6:
            return 0.0
        return float(min(1.5, np.count_nonzero(mask[y0:y1, x0:x1]) / area))

    def _face_gray(self, frame: Array, H: Array) -> Array:
        return cv2.cvtColor(rectify(frame, H, self.tmpl.wh, self.face_scale), cv2.COLOR_RGB2GRAY).astype(np.float32)

    def _ncc(self, a: Array, b: Array) -> float:
        m = self.tmpl.level(self.face_scale).ecc_mask > 0
        if m.shape != a.shape:
            m = cv2.resize(m.astype(np.uint8), (a.shape[1], a.shape[0]), interpolation=cv2.INTER_NEAREST) > 0
        x, y = a[m], b[m]
        if x.size < 16:
            return 0.0
        x = x - x.mean()
        y = y - y.mean()
        d = float(np.sqrt((x * x).sum() * (y * y).sum()))
        return float((x * y).sum() / d) if d > 1e-9 else 0.0

    def _after(self, H: Array) -> None:
        self.H_prev = hg.normalize(H)
        self.predictor.update(self._quad(self.H_prev))

    # ---- 主步 ----
    def step(self, k: int) -> FrameSolve:
        inp, opt, tmpl = self.inp, self.opt, self.tmpl
        frame = inp.get_frame(k)
        frame_wh = (int(frame.shape[1]), int(frame.shape[0]))
        mask = inp.mask(k)
        region = inp.region_mask(frame_wh)

        # 硬釘：使用者關鍵幀直接定義幾何，狀態機從這裡重新出發
        if k in inp.user_keyframes:
            H = hg.template_to_quad(tmpl.wh, inp.user_keyframes[k])
            vis = 1.0 if mask is None else self._vis(mask, self._quad(H), frame_wh)
            self.state = State.TRACKING
            self.static.reset()
            self.recent.clear()
            self.recent.append(H)
            self.fail_run = 0
            self._after(H)
            return FrameSolve(k, H, 1.0, State.TRACKING, vis=vis, method="pin", pinned=True)

        # 等速預測（掃牌：vis 掉了、遮罩不可靠）
        H_prev = self.H_prev
        q_prev = self._quad(H_prev)
        if self.pred_active:
            qp = self.predictor.predict()
            if qp is not None and hg.is_convex(qp):
                H_prev = hg.template_to_quad(tmpl.wh, qp)
                q_prev = qp

        vis = 1.0 if mask is None else self._vis(mask, q_prev, frame_wh)
        if vis < opt.lost_vis:
            self.state = State.LOST
            self.static.reset()
            self.pred_active = True
            self.fail_run += 1
            return FrameSolve(k, None, 0.0, State.LOST, vis=vis, method="lost:vis")

        qc = math.nan
        reacquired_H: Array | None = None
        if self.state == State.LOST:
            if mask is not None:
                qr = quad_from_mask(mask, ref_tl=q_prev[0])
                if qr.quad is not None and qr.conf > opt.reacquire_qc:
                    reacquired_H = hg.template_to_quad(tmpl.wh, qr.quad)
                    qc = qr.conf
            if reacquired_H is None:
                relaxed = SolveParams(**{**opt.solve.__dict__, "jump_frac": 1.0, "jump_min_px": 1e9})
                res = solve_frame(tmpl, frame, H_prev, mask, region, upsample=opt.upsample, motion_model=opt.motion_model, area_anchor=self.area_anchor, roi_dilate=opt.reacquire_dilate, params=relaxed)
                if res.feature_ok:
                    reacquired_H = res.H
            if reacquired_H is None:
                self.fail_run += 1
                return FrameSolve(k, None, 0.0, State.LOST, vis=vis, qc=qc, method="lost")
            H_prev = reacquired_H
            q_prev = self._quad(H_prev)
            self.state = State.TRACKING
            self.static.reset()
            self.recent.clear()
            self.pred_active = False

        # 靜止鎖：只驗 NCC
        if self.state == State.STATIC and self.H_static is not None and self.anchor_face is not None:
            ncc = self._ncc(self._face_gray(frame, self.H_static), self.anchor_face)
            if ncc >= opt.static_ncc and vis >= opt.predict_below_vis:
                self._after(self.H_static)
                conf = min(1.0, 0.6 + 0.4 * ncc) * min(1.0, vis / 0.5)
                return FrameSolve(k, self.H_static.copy(), conf, State.STATIC, cc=ncc, vis=vis, method="static")
            # 解鎖：牌動了或被遮 → 回 TRACKING，從鎖住的 H 出發
            self.state = State.TRACKING
            self.static.reset()
            H_prev = self.H_static
            q_prev = self._quad(H_prev)

        res = solve_frame(
            tmpl,
            frame,
            H_prev,
            mask,
            region,
            upsample=opt.upsample,
            motion_model=opt.motion_model,
            area_anchor=self.area_anchor,
            quad_prev=q_prev,
            roi_dilate=opt.roi_dilate,
            ecc_template=self.aux,
            params=opt.solve,
        )
        ok = res.feature_ok or res.ecc_ok
        vis_factor = min(1.0, vis / 0.5)
        if ok:
            self.fail_run = 0
            H_k = res.H
            motion = hg.max_corner_jump(self._quad(H_k), self._quad(self.H_prev))
            self.recent.append(H_k)
            state = State.TRACKING
            if self.static.push(motion) and len(self.recent) >= opt.static_frames:
                self.H_static = params_to_h(np.median(np.stack([h_to_params(H) for H in self.recent]), axis=0))
                self.anchor_face = self._face_gray(frame, self.H_static)
                self.state = State.STATIC
                state = State.STATIC
                H_k = self.H_static.copy()
            else:
                self.state = State.TRACKING
            if res.n_matches and res.inlier_ratio < opt.aux_inlier_ratio and res.ecc_ok and np.isfinite(res.cc) and res.cc >= opt.aux_min_cc:
                self.aux = template_from_frame(frame, self._quad(H_k), tmpl.wh, name=f"aux@{k}")
            self.pred_active = vis < opt.predict_below_vis
            self._after(H_k)
            return FrameSolve(k, H_k, res.conf * vis_factor, state, res.n_inliers, res.n_matches, res.cc, vis, qc, res.method, matches_src=res.matches_src, matches_dst=res.matches_dst, inlier_mask=res.inlier_mask)

        # 兩段都失敗：保留（預測的）H_prev 當 hold 幾何、低信心；沒遮罩時連續失敗 N 幀才判 LOST
        self.fail_run += 1
        self.static.reset()
        state = State.TRACKING
        if mask is None and self.fail_run >= opt.lost_after_failures:
            state = State.LOST
            self.state = State.LOST
        H_k = res.H
        self._after(H_k)
        return FrameSolve(k, H_k, min(0.2, res.conf) * vis_factor, state, res.n_inliers, res.n_matches, res.cc, vis, qc, res.method + ":fail", matches_src=res.matches_src, matches_dst=res.matches_dst, inlier_mask=res.inlier_mask)


# ---------------------------------------------------------------------------
# 執行、清除、重追
# ---------------------------------------------------------------------------


def _apply_smoothing(solve: Solve, pins: set[int], opt: TrackOptions) -> None:
    ks = sorted(solve.frames)
    if not ks:
        return
    raw = [solve.frames[k].H_raw if solve.frames[k].H_raw is not None else solve.frames[k].H for k in ks]
    for k, H in zip(ks, raw):
        solve.frames[k].H_raw = None if H is None else np.asarray(H, dtype=np.float64).copy()
    states = [int(solve.frames[k].state) for k in ks]
    all_pins = set(pins) | {k for k in ks if solve.frames[k].pinned}
    new = smooth_sequence(ks, raw, states, all_pins, window=opt.smoothing, order=opt.smoothing_order)
    for k, H in zip(ks, new):
        solve.frames[k].H = H


def run_track(
    inp: TrackInputs,
    ctx: Any = None,
    *,
    k_from: int | None = None,
    k_to: int | None = None,
    existing: Solve | None = None,
    seed: tuple[int, Array] | None = None,
    directions: tuple[int, ...] = (1, -1),
) -> Solve:
    """跑整個鏡頭（或 [k_from,k_to) 子範圍）。`seed=(k, H)` 給定起點就不找參考影格（retrack 用）。"""
    ctx = ctx or _NullCtx()
    k0, k1 = inp.shot
    a = k0 if k_from is None else max(k0, int(k_from))
    b = k1 if k_to is None else min(k1, int(k_to))
    if b <= a:
        raise OpError("Invalid", f"追蹤範圍為空：[{a},{b})")
    tmpl = inp.template

    if seed is None:
        ref_k, H_ref, qc_ref = find_reference(inp, ctx)
        seed_k, H_seed = ref_k, H_ref
    else:
        seed_k, H_seed = int(seed[0]), hg.normalize(seed[1])
        ref_k, qc_ref = (existing.reference_frame if existing is not None else None), math.nan

    solve = existing if existing is not None else Solve(inp.track_id, (k0, k1), ref_k, tmpl.wh)
    if solve.reference_frame is None:
        solve.reference_frame = ref_k
    area_anchor = hg.quad_area(hg.quad_from_h(H_seed, tmpl.wh))
    if seed is None:
        solve.frames[ref_k] = FrameSolve(ref_k, H_ref, 1.0, State.TRACKING, vis=1.0, qc=qc_ref, method="reference", pinned=True)

    tracker = _Tracker(inp, ctx, area_anchor)
    total = max(1, b - a)
    done = 0
    for direction in directions:
        seed_state = State.TRACKING
        if existing is not None and seed_k in existing.frames and existing.frames[seed_k].state == State.STATIC:
            seed_state = State.STATIC
        tracker.start(H_seed, seed_state)
        if direction > 0:
            ks = range(max(seed_k + 1, a), b)
        else:
            ks = range(min(seed_k - 1, b - 1), a - 1, -1)
        for k in ks:
            ctx.check_cancel()
            fs = tracker.step(k)
            solve.frames[k] = fs
            done += 1
            ctx.progress("track", done, total, frame=k, state=int(fs.state))
    pins = set(inp.user_keyframes) | ({ref_k} if ref_k is not None else set())
    _apply_smoothing(solve, pins, inp.options)
    return solve


def clear_forwards(solve: Solve, k: int) -> Solve:
    """清除 k 之後（k 本身保留）的解。使用者關鍵幀活在專案檔，不在這裡，所以不必特別保護。"""
    for kk in [kk for kk in solve.frames if kk > k]:
        del solve.frames[kk]
    return solve


def clear_backwards(solve: Solve, k: int) -> Solve:
    """清除 k 之前（k 本身保留）的解。"""
    for kk in [kk for kk in solve.frames if kk < k]:
        del solve.frames[kk]
    return solve


def retrack_from(inp: TrackInputs, solve: Solve, k: int, ctx: Any = None, direction: int = 1) -> Solve:
    """從 k 起沿 direction 重追到鏡頭邊界；種子 = k 的使用者關鍵幀 → 鄰幀（k∓1）的解 → 參考影格。

    只清除並重解單側，所以修 12 幀不必重解 1762 幀（A3 `adjust-cost` 量尺）。
    """
    k0, k1 = inp.shot
    if not (k0 <= k < k1):
        raise OpError("Invalid", f"幀 {k} 不在鏡頭 [{k0},{k1}) 內")
    ctx = ctx or _NullCtx()
    if direction > 0:
        clear_forwards(solve, k - 1)
        nb = k - 1
    else:
        clear_backwards(solve, k + 1)
        nb = k + 1
    seed: tuple[int, Array] | None = None
    if k in inp.user_keyframes:
        H, _ = _refine_from_quad(inp, k, inp.user_keyframes[k])
        seed = (k - direction, H)  # 讓 k 本身也被（釘）處理：從 k∓1 出發
    elif nb in solve.frames and solve.frames[nb].H is not None:
        H = solve.frames[nb].H_raw if solve.frames[nb].H_raw is not None else solve.frames[nb].H
        seed = (nb, H)
    if seed is None:
        ref = solve.reference_frame
        if ref is not None and ref in solve.frames and solve.frames[ref].H is not None:
            seed = (ref, solve.frames[ref].H)
        else:
            inp2 = TrackInputs(**{**inp.__dict__, "_region_cache": {}})
            rk, H, _ = find_reference(inp2, ctx)
            seed = (rk, H)
    if direction > 0:
        return run_track(inp, ctx, k_from=k, existing=solve, seed=seed, directions=(1,))
    return run_track(inp, ctx, k_to=k + 1, existing=solve, seed=seed, directions=(-1,))
