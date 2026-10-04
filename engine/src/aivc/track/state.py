"""狀態機資料型別（計畫 §6.4、§5.5）：State、FrameSolve、Solve（solve.v1.json 讀寫）、TrackOptions、靜止偵測、等速預測。

solve.v1.json：`{version:1, trackId, shot:[k0,k1), referenceFrame, template:{w,h}, frames:[[k,h00..h21,conf,state],…]}`
h22 正規化為 1；state ∈ {0 none,1 tracking,2 static,3 lost}。LOST 幀的 8 個 h 寫 null（沒有幾何可信）。
HUD 側檔 `solve.hud.v1.json` 另存內點／外點／cc／vis／平滑前角點，給 TrackHudLayer 與 `bench jitter`。
"""
from __future__ import annotations

import json
import math
from collections import deque
from dataclasses import dataclass, field
from enum import IntEnum
from pathlib import Path

import numpy as np

from ..geom import homography as hg
from .classic import SolveParams

Array = np.ndarray


class State(IntEnum):
    NONE = 0
    TRACKING = 1
    STATIC = 2
    LOST = 3


@dataclass
class TrackOptions:
    motion_model: str = "perspective"  # translation|similarity|affine|perspective
    smoothing: int = 9  # Savitzky-Golay 視窗（奇數）；0 = 關
    smoothing_order: int = 2
    upsample: int = 1  # 遠景 2
    roi_dilate: float = 0.25
    reacquire_dilate: float = 1.0  # LOST 且沒遮罩時，用更大的 ROI 找特徵
    lost_vis: float = 0.15  # vis 低於此 → LOST
    predict_below_vis: float = 0.6  # vis 低於此 → 用等速外推當 H_prev（掃牌）
    reacquire_qc: float = 0.8  # 遮罩四角信心高於此才重取得
    reference_qc: float = 0.9  # 自動挑參考影格的門檻
    static_px: float = 0.3  # 靜止鎖：角點位移 < 0.3 px
    static_frames: int = 5  # 連續 5 幀
    static_ncc: float = 0.9  # 鎖住期間每幀 NCC 驗證
    aux_inlier_ratio: float = 0.3  # 內點比低於此 → 加光度輔助模板
    aux_min_cc: float = 0.8  # 但只有 ECC 很有把握時才拿該幀當輔助模板
    hold_below: float = 0.35  # conf 低於此合成器 hold（僅記錄，合成時推導）
    lost_after_failures: int = 3  # 沒遮罩時連續失敗幾幀才判 LOST
    solve: SolveParams = field(default_factory=SolveParams)


@dataclass
class FrameSolve:
    k: int
    H: Array | None
    conf: float
    state: State
    n_inliers: int = 0
    n_matches: int = 0
    cc: float = math.nan
    vis: float = 1.0
    qc: float = math.nan  # 遮罩四角信心（有用到才有）
    method: str = ""
    pinned: bool = False  # 使用者關鍵幀／參考影格：平滑不動
    H_raw: Array | None = None  # 平滑前
    matches_src: Array | None = None
    matches_dst: Array | None = None
    inlier_mask: Array | None = None

    def row(self) -> list:
        hs = [None] * 8 if self.H is None else [float(v) for v in hg.normalize(self.H).ravel()[:8]]
        return [int(self.k), *hs, round(float(self.conf), 4), int(self.state)]


@dataclass
class Solve:
    track_id: str
    shot: tuple[int, int]
    reference_frame: int | None
    template_wh: tuple[int, int]
    frames: dict[int, FrameSolve] = field(default_factory=dict)
    version: int = 1

    # ---- 查詢 ----
    def sorted_frames(self) -> list[FrameSolve]:
        return [self.frames[k] for k in sorted(self.frames)]

    def corners(self, k: int, raw: bool = False) -> Array | None:
        f = self.frames.get(k)
        if f is None:
            return None
        H = f.H_raw if raw and f.H_raw is not None else f.H
        return None if H is None else hg.quad_from_h(H, self.template_wh)

    def counts(self) -> dict[str, int]:
        c = {s.name.lower(): 0 for s in State}
        for f in self.frames.values():
            c[f.state.name.lower()] += 1
        return c

    # ---- 序列化 ----
    def to_json_obj(self) -> dict:
        return {
            "version": self.version,
            "trackId": self.track_id,
            "shot": [int(self.shot[0]), int(self.shot[1])],
            "referenceFrame": None if self.reference_frame is None else int(self.reference_frame),
            "template": {"w": int(self.template_wh[0]), "h": int(self.template_wh[1])},
            "frames": [f.row() for f in self.sorted_frames()],
        }

    def hud_json_obj(self) -> dict:
        rows = []
        for f in self.sorted_frames():
            row: dict = {
                "k": int(f.k),
                "state": int(f.state),
                "conf": round(float(f.conf), 4),
                "cc": None if not np.isfinite(f.cc) else round(float(f.cc), 4),
                "vis": round(float(f.vis), 4),
                "qc": None if not np.isfinite(f.qc) else round(float(f.qc), 4),
                "nInliers": int(f.n_inliers),
                "nMatches": int(f.n_matches),
                "method": f.method,
                "pinned": bool(f.pinned),
                "cornersRaw": None if f.H_raw is None else np.round(hg.quad_from_h(f.H_raw, self.template_wh), 3).tolist(),
                "corners": None if f.H is None else np.round(hg.quad_from_h(f.H, self.template_wh), 3).tolist(),
            }
            if f.matches_src is not None and len(f.matches_src):
                pairs = np.concatenate([f.matches_src, f.matches_dst], axis=1)
                inl = f.inlier_mask if f.inlier_mask is not None else np.zeros(len(pairs), bool)
                row["inliers"] = np.round(pairs[inl], 2).tolist()
                row["outliers"] = np.round(pairs[~inl], 2).tolist()
            rows.append(row)
        return {"version": 1, "trackId": self.track_id, "template": {"w": int(self.template_wh[0]), "h": int(self.template_wh[1])}, "frames": rows}

    def write(self, path: str | Path, hud_path: str | Path | None = None) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_json_obj(), ensure_ascii=False), encoding="utf-8")
        if hud_path is not None:
            Path(hud_path).write_text(json.dumps(self.hud_json_obj(), ensure_ascii=False), encoding="utf-8")

    @classmethod
    def from_json_obj(cls, obj: dict) -> Solve:
        if int(obj.get("version", 0)) != 1:
            raise ValueError(f"solve 版本 {obj.get('version')} 不支援（只讀 1）")
        s = cls(
            track_id=str(obj["trackId"]),
            shot=(int(obj["shot"][0]), int(obj["shot"][1])),
            reference_frame=None if obj.get("referenceFrame") is None else int(obj["referenceFrame"]),
            template_wh=(int(obj["template"]["w"]), int(obj["template"]["h"])),
        )
        for row in obj["frames"]:
            k = int(row[0])
            hs = row[1:9]
            H = None if any(v is None for v in hs) else np.append(np.asarray(hs, dtype=np.float64), 1.0).reshape(3, 3)
            s.frames[k] = FrameSolve(k=k, H=H, conf=float(row[9]), state=State(int(row[10])), pinned=(k == s.reference_frame))
        return s

    @classmethod
    def read(cls, path: str | Path) -> Solve:
        return cls.from_json_obj(json.loads(Path(path).read_text(encoding="utf-8")))


class StaticDetector:
    """連續 `frames` 幀角點位移 < `px` → 靜止（計畫 §6.4 步驟 4）。"""

    def __init__(self, px: float = 0.3, frames: int = 5) -> None:
        self.px = float(px)
        self.frames = int(frames)
        self._hist: deque[float] = deque(maxlen=self.frames)

    def reset(self) -> None:
        self._hist.clear()

    def push(self, motion_px: float) -> bool:
        self._hist.append(float(motion_px))
        return len(self._hist) == self.frames and all(m < self.px for m in self._hist)


class VelocityPredictor:
    """角點等速外推（掃牌時 vis 掉、遮罩不可靠，用上一步速度預測 H_prev）。速度每幀衰減避免失控。"""

    def __init__(self, decay: float = 0.9) -> None:
        self.decay = float(decay)
        self.last: Array | None = None
        self.vel: Array | None = None

    def reset(self) -> None:
        self.last = None
        self.vel = None

    def update(self, quad: Array) -> None:
        q = np.asarray(quad, dtype=np.float64).reshape(4, 2)
        if self.last is not None:
            self.vel = q - self.last
        self.last = q

    def predict(self) -> Array | None:
        if self.last is None:
            return None
        if self.vel is None:
            return self.last.copy()
        self.vel = self.vel * self.decay
        return self.last + self.vel
