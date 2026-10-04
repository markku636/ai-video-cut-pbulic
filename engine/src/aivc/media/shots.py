"""鏡頭切點（計畫 §6.1）：一趟串流，160×90 亮度絕對差正規化 → score > threshold 且與上一切點相距 ≥ min_len 幀。

輸出以 **proxy 幀 k** 為單位（所有下游索引都是 k）：來源幀 i 的切點放在它第一次出現的 k = first_k_of_src(i)。
差分在**連續來源幀**之間算（重複的 proxy 幀差為 0，本來就不會是切點）。kind 一律 'unknown'，
close/wide 由牌偵測（面積中位數）之後再填。範例預期切在 2.0 / 30.9 / 45.3 s（ffmpeg scene>0.3 的結果）。

score 定義**與 ffmpeg `select=gt(scene,T)` 同尺度**（libavfilter vf_select.c get_scene_score）：
    mafd  = mean(|Y_small(i) − Y_small(i−1)|)      # 0..255
    score = clip(min(mafd, |mafd − mafd_prev|) / 100, 0, 1)
這樣計畫裡用 ffmpeg 量出來的「scene>0.3」門檻是同一個尺度。**但實測**範例三個切點在 160×90 是
0.36 / 0.31 / 0.299（全解析度 0.376 / 0.32 / 0.307），鏡頭內最大只有 0.146（1.2 s 斷層後那一幀）、其次 0.05；
0.3 會漏掉 45.3 s 那刀，所以預設門檻取兩群中間的 **0.2**（與計畫的 0.3 不同，量測見 docs/measurements）。
單純 mean/255 的話同一批切點只有 0.12–0.14。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable

if TYPE_CHECKING:
    import numpy as np

    from .cfr import CfrMap
    from .source import Yuv420

SMALL_W, SMALL_H = 160, 90
DEFAULT_THRESHOLD = 0.2  # 計畫寫 0.3；實測 45.3 s 切點只有 0.299，見模組 docstring
DEFAULT_MIN_LEN = 12


@dataclass
class Shot:
    id: str
    startFrame: int  # noqa: N815 — 鏡射 TS ShotV1（camelCase）
    endFrame: int  # noqa: N815 — exclusive
    kind: str = "unknown"
    source: str = "auto"

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


def downscale_luma(y: "np.ndarray", width: int = SMALL_W, height: int = SMALL_H) -> "np.ndarray":
    import cv2

    return cv2.resize(y, (width, height), interpolation=cv2.INTER_AREA).astype("float32")


def mafd(prev_small: "np.ndarray", cur_small: "np.ndarray") -> float:
    """mean absolute frame difference，0..255。"""
    import numpy as np

    return float(np.mean(np.abs(cur_small - prev_small)))


def cut_score(cur_mafd: float, prev_mafd: float) -> float:
    """ffmpeg scene score：min(mafd, |Δmafd|)/100，裁到 [0,1]。|Δmafd| 那項讓「一直在動」的鏡頭不被誤判成連續切點。"""
    return max(0.0, min(1.0, min(cur_mafd, abs(cur_mafd - prev_mafd)) / 100.0))


def detect_cuts(
    frames: Iterable["Yuv420"],
    cfr: "CfrMap",
    *,
    threshold: float = DEFAULT_THRESHOLD,
    min_len: int = DEFAULT_MIN_LEN,
    ctx: Any | None = None,
    total: int | None = None,
) -> list[dict[str, Any]]:
    """回切點 [{k, src, score, pts_ms}]（k = 新鏡頭第一幀）。frames 必須是顯示順序的來源幀。"""
    from .index import NoopCtx

    ctx = ctx or NoopCtx()
    cuts: list[dict[str, Any]] = []
    prev = None
    prev_mafd = 0.0
    last_cut_k = 0
    n = 0
    for fr in frames:
        n += 1
        small = downscale_luma(fr.y)
        if prev is not None:
            m = mafd(prev, small)
            score = cut_score(m, prev_mafd)
            prev_mafd = m
            k = cfr.first_k_of_src(fr.src_idx)
            if k is not None and score > threshold and k - last_cut_k >= min_len:
                cuts.append({"k": k, "src": fr.src_idx, "score": round(score, 4), "pts_ms": fr.pts_ms})
                last_cut_k = k
        prev = small
        if n % 30 == 0:
            ctx.check_cancel()
            ctx.progress("shots", n, max(total or 0, n))
    ctx.progress("shots", n, n)
    return cuts


def shots_from_cuts(cuts: list[dict[str, Any]], n_frames: int, min_len: int = DEFAULT_MIN_LEN) -> list[Shot]:
    bounds = [0] + [c["k"] for c in cuts if 0 < c["k"] < n_frames] + [n_frames]
    shots: list[Shot] = []
    for i in range(len(bounds) - 1):
        a, b = bounds[i], bounds[i + 1]
        if b <= a:
            continue
        if shots and b - a < min_len:  # 尾巴太短併進前一個鏡頭
            shots[-1].endFrame = b
            continue
        shots.append(Shot(id=f"shot{len(shots) + 1}", startFrame=a, endFrame=b))
    return shots


def detect_shots(
    frames: Iterable["Yuv420"],
    cfr: "CfrMap",
    *,
    threshold: float = DEFAULT_THRESHOLD,
    min_len: int = DEFAULT_MIN_LEN,
    ctx: Any | None = None,
    total: int | None = None,
) -> tuple[list[Shot], list[dict[str, Any]]]:
    cuts = detect_cuts(frames, cfr, threshold=threshold, min_len=min_len, ctx=ctx, total=total)
    return shots_from_cuts(cuts, cfr.n_frames, min_len), cuts


def save_shots(path: Path, shots: list[Shot], cuts: list[dict[str, Any]], cfr: "CfrMap", *, threshold: float, min_len: int) -> Path:
    from .cache import write_json

    return write_json(
        path,
        {
            "version": 1,
            "fps": {"num": cfr.fps_num, "den": cfr.fps_den},
            "nFrames": cfr.n_frames,
            "params": {"threshold": threshold, "minLen": min_len, "small": [SMALL_W, SMALL_H]},
            "shots": [s.to_json() for s in shots],
            "cuts": cuts,
        },
    )
