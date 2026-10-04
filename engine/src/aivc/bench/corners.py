"""bench corners 的純函式：labels JSON 格式、四角誤差、p@N 統計（計畫 §11：四角貼多準／會不會滑？）。

labels 檔格式（`aivc label-auto` 寫、`aivc bench-corners --labels` 讀；之後 `aivc label` 人工工具也寫同一格式）：

    {
      "version": 1,
      "source": "detector" | "human",          # detector = 自動產生，**不是**真值（見下）
      "warning": "…",                          # source=detector 時必帶，提醒讀者
      "project": "…", "createdAt": "…",        # 可選
      "frames": [
        {"k": 1091, "track": "shot3-Player1", "quad": [[x,y],[x,y],[x,y],[x,y]],   # 邊界慣例、幀 px、TL,TR,BR,BL（順時針）
         "method": "detector+refine", "state": "static", "slot": "Player1", "note": "…"}   # 其餘欄位任意，原樣保留
      ]
    }

誤差 = 標記四角 vs solve 四角的**最大角點距離**，對 4 個循環位移取最小（見 common.cyclic_corner_error 為什麼）。
標記到的幀 solve 沒有解（LOST／缺幀）→ 誤差 inf，算進 p@N 的分母當 miss：標記者說牌在那裡可追，追不到就是漏。

門檻（計畫 §11）：TRACKING+STATIC 幀 p@5 ≥ 0.90、p@15 ≥ 0.98；STATIC 幀平均 ≤ 1.0 px；遠景（shot.kind == wide）
p@(4% 牌長邊) ≥ 0.90。p@1 只記錄（計畫表也寫 p@1≥0.9，但偵測器產生的標記本身就有 1–2 px 的誤差，等有人工真值再升為門檻）。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import numpy as np

from . import common as C

LABELS_VERSION = 1
DETECTOR_WARNING = "自動標記：四角來自偵測器（白色遮罩輪廓直線擬合精修），不是人工真值。bench corners 用它量到的是 tracker 對偵測器的一致性，不是對真值的精度。"


@dataclass
class Label:
    k: int
    track: str
    quad: np.ndarray  # (4,2)
    extra: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        return {"k": int(self.k), "track": self.track, "quad": np.round(self.quad, 3).tolist(), **self.extra}


def parse_labels(obj: Any) -> tuple[list[Label], dict[str, Any]]:
    """labels JSON → (labels, meta)。格式不對擲 ValueError（訊息含第幾筆）。"""
    if not isinstance(obj, dict) or not isinstance(obj.get("frames"), list):
        raise ValueError('labels 必須是 {"version": 1, "source": "...", "frames": [...]}')
    ver = obj.get("version", 1)
    if int(ver) != LABELS_VERSION:
        raise ValueError(f"labels version {ver} 不支援（只讀 {LABELS_VERSION}）")
    out: list[Label] = []
    for i, row in enumerate(obj["frames"]):
        if not isinstance(row, dict):
            raise ValueError(f"frames[{i}] 不是物件")
        k, track, quad = row.get("k"), row.get("track"), row.get("quad")
        if not isinstance(k, int) or isinstance(k, bool) or k < 0:
            raise ValueError(f"frames[{i}].k={k!r} 必須是 ≥0 的整數")
        if not isinstance(track, str) or not track:
            raise ValueError(f"frames[{i}].track 必須是非空字串")
        try:
            q = np.asarray(quad, dtype=np.float64).reshape(4, 2)
        except (TypeError, ValueError) as e:
            raise ValueError(f"frames[{i}].quad 必須是 4 個 [x,y]") from e
        if not np.all(np.isfinite(q)):
            raise ValueError(f"frames[{i}].quad 含非有限值")
        out.append(Label(int(k), track, q, {kk: v for kk, v in row.items() if kk not in ("k", "track", "quad")}))
    meta = {k: v for k, v in obj.items() if k != "frames"}
    meta.setdefault("source", "unknown")
    return out, meta


def labels_document(labels: list[Label], *, source: str, **meta: Any) -> dict[str, Any]:
    """組出可寫檔的 labels JSON；source=detector 時強制帶 warning。"""
    doc: dict[str, Any] = {"version": LABELS_VERSION, "source": source}
    if source == "detector":
        doc["warning"] = DETECTOR_WARNING
    doc.update({k: v for k, v in meta.items() if v is not None})
    doc["frames"] = [lb.to_json() for lb in labels]
    return doc


# ---------------------------------------------------------------- 評估


def evaluate(
    labels: list[Label],
    solves: dict[str, Any],
    shot_kind_of: dict[str, str],
    *,
    min_p5: float = 0.90,
    min_p15: float = 0.98,
    max_static_mean: float = 1.0,
    wide_frac: float = 0.04,
    min_wide: float = 0.90,
    max_list: int = 20,
) -> dict[str, Any]:
    """labels + {trackId: Solve|None} + {trackId: shot kind} → 統計與門檻判定。"""
    rows: list[dict[str, Any]] = []
    unknown_tracks: set[str] = set()
    for lb in labels:
        solve = solves.get(lb.track)
        kind = shot_kind_of.get(lb.track, "unknown")
        wide = kind == "wide"
        ls = C.long_side(lb.quad)
        if solve is None:
            unknown_tracks.add(lb.track)
            rows.append({"k": lb.k, "track": lb.track, "state": None, "solved": False, "err": math.inf, "shift": 0, "longSide": ls, "wide": wide})
            continue
        f = solve.frames.get(lb.k)
        if f is None or f.H is None:
            rows.append({"k": lb.k, "track": lb.track, "state": None if f is None else C.STATE_NAMES.get(int(f.state)), "solved": False, "err": math.inf, "shift": 0, "longSide": ls, "wide": wide})
            continue
        q = solve.corners(lb.k)
        err, shift = C.cyclic_corner_error(lb.quad, q)
        rows.append({"k": lb.k, "track": lb.track, "state": C.STATE_NAMES.get(int(f.state)), "solved": True, "err": err, "shift": shift, "longSide": ls, "wide": wide})

    def frac_within(rs: list[dict[str, Any]], px: float | None = None, frac_of_long: float | None = None) -> float | None:
        if not rs:
            return None
        hit = 0
        for r in rs:
            lim = float(px) if px is not None else float(frac_of_long) * r["longSide"]
            hit += 1 if r["err"] <= lim else 0
        return hit / len(rs)

    moving = [r for r in rows if r["state"] in ("tracking", "static") or not r["solved"]]  # 未解的算 miss
    static = [r for r in rows if r["state"] == "static" and r["solved"]]
    wide_rows = [r for r in rows if r["wide"]]
    p5, p15, p1 = frac_within(moving, 5.0), frac_within(moving, 15.0), frac_within(static, 1.0)
    static_errs = [r["err"] for r in static]
    static_mean = (sum(static_errs) / len(static_errs)) if static_errs else None
    p_wide = frac_within(wide_rows, frac_of_long=wide_frac)
    checks = {
        "p5": None if p5 is None else bool(p5 >= min_p5),
        "p15": None if p15 is None else bool(p15 >= min_p15),
        "staticMean": None if static_mean is None else bool(static_mean <= max_static_mean),
        "wide": None if p_wide is None else bool(p_wide >= min_wide),
    }
    ok = all(v is not False for v in checks.values())
    per_track: dict[str, dict[str, Any]] = {}
    for tid in sorted({r["track"] for r in rows}):
        rs = [r for r in rows if r["track"] == tid]
        errs = [r["err"] for r in rs if math.isfinite(r["err"])]
        per_track[tid] = {
            "labels": len(rs),
            "unsolved": sum(1 for r in rs if not r["solved"]),
            "meanErr": (sum(errs) / len(errs)) if errs else None,
            "maxErr": max(errs) if errs else None,
            "p5": frac_within(rs, 5.0),
            "p15": frac_within(rs, 15.0),
        }
    worst = sorted(rows, key=lambda r: -r["err"] if math.isfinite(r["err"]) else -math.inf)
    worst = [r for r in rows if not math.isfinite(r["err"])] + [r for r in worst if math.isfinite(r["err"])]
    return {
        "ok": bool(ok),
        "labels": len(rows),
        "moving": len(moving),
        "static": len(static),
        "wide": len(wide_rows),
        "unsolved": sum(1 for r in rows if not r["solved"]),
        "unknownTracks": sorted(unknown_tracks),
        "p1": p1,
        "p5": p5,
        "p15": p15,
        "staticMean": static_mean,
        "staticMax": max(static_errs) if static_errs else None,
        "pWide": p_wide,
        "checks": checks,
        "threshold": {"p5": min_p5, "p15": min_p15, "staticMean": max_static_mean, "wideFrac": wide_frac, "pWide": min_wide},
        "perTrack": per_track,
        "rows": rows,
        "failures": [{"k": r["k"], "track": r["track"], "state": r["state"], "err": r["err"]} for r in worst if not (math.isfinite(r["err"]) and r["err"] <= 5.0)][:max_list],
    }
