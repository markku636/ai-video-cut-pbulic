"""bench jitter 的純函式：solve → 狀態連續段 → 四角二階差分統計（計畫 §11：靜止的平面會不會抖？）。

門檻：每個 STATIC 段（長度 ≥ min_run）四角的二階差分 c[k+1] − 2c[k] + c[k−1] **最大絕對值 == 0**（等價 std == 0）。
為什麼能要求精確 0 而不是「很小」：追蹤器在靜止鎖期間每幀寫的是同一個 H_static（track/runner），平滑步驟對 STATIC 段
取中位數（geom/smoothing），所以角點應該逐 bit 相同；只要有 1e-9 的差就代表某幀走了別的路徑（例如解鎖後重鎖成
另一個 H，卻沒有斷段），那正是使用者會看到「牌抖了一下」的原因。TRACKING 段記錄平滑前（HUD `cornersRaw`）／後
（solve `corners`）的二階差分 std/max，只給人看（移動段本來就該動）。
"""
from __future__ import annotations

from typing import Any

import numpy as np

from . import common as C


def second_diff(corners: np.ndarray) -> np.ndarray:
    """(n,4,2) → (n−2,4,2)；n < 3 回空陣列。"""
    c = np.asarray(corners, dtype=np.float64)
    if c.ndim != 3 or c.shape[0] < 3:
        return np.zeros((0, 4, 2), dtype=np.float64)
    return c[2:] - 2.0 * c[1:-1] + c[:-2]


def diff_stats(corners: np.ndarray) -> dict[str, Any] | None:
    """{"n", "secondDiffMax", "secondDiffStd", "firstDiffMax"}；n < 3 → None。"""
    c = np.asarray(corners, dtype=np.float64)
    if c.ndim != 3 or c.shape[0] < 3:
        return None
    d2 = second_diff(c)
    d1 = c[1:] - c[:-1]
    return {
        "n": int(c.shape[0]),
        "secondDiffMax": float(np.max(np.abs(d2))),
        "secondDiffStd": float(np.std(d2)),
        "firstDiffMax": float(np.max(np.abs(d1))) if d1.size else 0.0,
    }


def state_runs(frames: dict[int, Any]) -> list[tuple[int, int, int]]:
    """{k: FrameSolve} → [(state, k0, k1), …]：連續 k、同 state、H 不為 None 才接在同一段；缺幀／LOST(H None) 斷段。"""
    out: list[list[int]] = []
    for k in sorted(frames):
        f = frames[k]
        if getattr(f, "H", None) is None:
            continue
        st = int(f.state)
        if out and out[-1][0] == st and out[-1][2] == k:
            out[-1][2] = k + 1
        else:
            out.append([st, k, k + 1])
    return [(a, b, c) for a, b, c in out]


def corners_for(solve: Any, k0: int, k1: int, *, raw: bool = False) -> np.ndarray:
    """solve 的 [k0,k1) 四角 (n,4,2)。"""
    return np.stack([solve.corners(k, raw=raw) for k in range(k0, k1)])


def hud_corners_for(hud_frames: dict[int, dict[str, Any]], k0: int, k1: int, key: str) -> np.ndarray | None:
    """HUD 側檔（solve.hud.v1.json）的 cornersRaw / corners → (n,4,2)；任何一幀缺 → None。"""
    rows = []
    for k in range(k0, k1):
        r = hud_frames.get(k)
        if r is None or r.get(key) is None:
            return None
        rows.append(np.asarray(r[key], dtype=np.float64).reshape(4, 2))
    return np.stack(rows) if rows else None


def jitter_report(solve: Any, hud_frames: dict[int, dict[str, Any]] | None = None, *, min_run: int = 3) -> dict[str, Any]:
    """一條 track 的 jitter 報告：STATIC 段門檻 + TRACKING 段前後對比。"""
    runs = state_runs(solve.frames)
    static_rows: list[dict[str, Any]] = []
    static_d2: list[np.ndarray] = []
    tracking_after: list[np.ndarray] = []
    tracking_before: list[np.ndarray] = []
    short_static = 0
    for st, k0, k1 in runs:
        if k1 - k0 < min_run:
            if st == C.STATIC:
                short_static += 1
            continue
        c = corners_for(solve, k0, k1)
        if st == C.STATIC:
            s = diff_stats(c) or {}
            static_rows.append({"k0": k0, "k1": k1, "len": k1 - k0, **s, "ok": bool(s.get("secondDiffMax", 0.0) == 0.0)})
            static_d2.append(second_diff(c))
        elif st == C.TRACKING:
            tracking_after.append(second_diff(c))
            if hud_frames is not None:
                raw = hud_corners_for(hud_frames, k0, k1, "cornersRaw")
                if raw is not None:
                    tracking_before.append(second_diff(raw))

    def agg(chunks: list[np.ndarray]) -> dict[str, Any] | None:
        if not chunks:
            return None
        d = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
        if d.size == 0:
            return None
        return {"n": int(d.shape[0]), "secondDiffMax": float(np.max(np.abs(d))), "secondDiffStd": float(np.std(d))}

    st_agg = agg(static_d2)
    ok = all(r["ok"] for r in static_rows)
    return {
        "trackId": solve.track_id,
        "counts": solve.counts(),
        "staticRuns": static_rows,
        "staticRunsTooShort": short_static,
        "static": st_agg,
        "tracking": {"before": agg(tracking_before), "after": agg(tracking_after)},
        "ok": bool(ok),
        "failures": [{"k0": r["k0"], "k1": r["k1"], "secondDiffMax": r["secondDiffMax"]} for r in static_rows if not r["ok"]],
    }
