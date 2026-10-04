"""ObjectTrack 匯出：JSON（`aivc.objecttrack.v1`）、CSV（一幀一列）、PNG 遮罩序列。格式定義見 docs/tracking-api.md。

三種格式涵蓋的幀一樣：遮罩檔條目的最小 k 到最大 k（含頭含尾），中間沒有條目的幀照樣列出、標 `computed=false`
—— 對 AE／Nuke／試算表來說，「連續、一幀一列」比「跳著列」好用得多，缺的幀也看得出是缺。
時間 `t` 是 CFR proxy 的時間：`k × fps_den / fps_num`（與 UI 時間軸、render 同一個時基）。
每個讀檔函式（`read_json`／`read_csv`／`read_png_sequence`）都存在，是為了來回測試：寫出去的東西讀得回來、值一樣。
"""
from __future__ import annotations

import csv
import io
import json
import math
import os
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np

from .. import atomic
from .anchors import Anchor

FORMAT = "aivc.objecttrack.v1"
CSV_COLUMNS = (
    "k", "t", "computed", "visible", "area", "x", "y", "w", "h", "cx", "cy", "angle", "elong",
    "sx", "sy", "sw", "sh", "scx", "scy", "sangle", "sarea",
)


@dataclass(frozen=True)
class VideoInfo:
    path: str | None
    width: int
    height: int
    fps: tuple[int, int]
    frames: int  # proxy 幀數

    def seconds(self, k: int) -> float:
        return float(Fraction(int(k) * self.fps[1], self.fps[0])) if self.fps[0] else 0.0

    def to_json(self) -> dict[str, Any]:
        return {"path": self.path, "width": self.width, "height": self.height, "fps": [self.fps[0], self.fps[1]], "frames": self.frames}


def _frame_json(a: Anchor, video: VideoInfo | None) -> dict[str, Any]:
    d = a.to_json()
    if video is not None:
        d["t"] = round(video.seconds(a.k), 6)
    return d


def track_json(track: Any, video: VideoInfo | None) -> dict[str, Any]:
    """ObjectTrack → `aivc.objecttrack.v1` 文件（dict）。"""
    an = track.anchors
    frames = [_frame_json(a, video) for a in an.iter_all()]
    return {
        "format": FORMAT,
        "video": None if video is None else video.to_json(),
        "masks": {"path": str(track.path), "width": an.width, "height": an.height, "entries": len(an.frames), "present": sum(1 for a in an.frames.values() if a.visible)},
        "coordinates": "pixel-edge: pixel (i,j) covers [i,i+1)x[j,j+1); bbox=[x,y,w,h] half-open; angle=long side, degrees, (-90,90], +x toward +y",
        "smoothing": {"method": "savgol", "window": an.window, "order": an.order, "acrossGaps": False},
        "visibleRanges": [list(r) for r in an.visible_ranges()],
        "frames": frames,
    }


def write_json(path: str | os.PathLike[str], doc: dict[str, Any]) -> Path:
    return atomic.write_text(Path(path), json.dumps(doc, ensure_ascii=False, indent=1))


def read_json(path: str | os.PathLike[str]) -> dict[str, Any]:
    d = json.loads(atomic.read_text(Path(path)))
    if d.get("format") != FORMAT:
        raise ValueError(f"不是 {FORMAT}：{d.get('format')!r}")
    return d


def anchors_from_json(doc: dict[str, Any]) -> dict[int, Anchor]:
    """objecttrack JSON 的 frames → {k: Anchor}（只收 computed=true 的幀，與 Anchors.frames 同語意）。"""
    out: dict[int, Anchor] = {}
    for f in doc.get("frames", []):
        if not f.get("computed", True):
            continue
        g = {k: v for k, v in f.items() if k != "t"}
        a = Anchor.from_json(g)
        out[a.k] = a
    return out


# ---------------------------------------------------------------- CSV
def _num(v: float | None, nd: int = 3) -> str:
    """固定小數位再去掉尾端 0（不用 :g —— 它只留 6 位有效數字，4K 的座標會被截掉小數）。"""
    if v is None:
        return ""
    x = round(float(v), nd)
    if x == 0:
        x = 0.0  # 不要寫出 "-0"
    s = f"{x:.{nd}f}".rstrip("0").rstrip(".") if nd > 0 else str(int(x))
    return s or "0"


def csv_rows(track: Any, video: VideoInfo | None) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for a in track.anchors.iter_all():
        r = {c: "" for c in CSV_COLUMNS}
        r["k"] = str(a.k)
        r["t"] = "" if video is None else f"{video.seconds(a.k):.6f}"
        r["computed"] = "1" if a.computed else "0"
        r["visible"] = "1" if a.visible else "0"
        if a.visible and a.bbox is not None and a.centroid is not None:
            r["area"] = str(int(a.area))
            r["x"], r["y"], r["w"], r["h"] = (_num(v) for v in a.bbox)
            r["cx"], r["cy"] = (_num(v) for v in a.centroid)
            r["angle"] = _num(a.angle)
            r["elong"] = _num(a.elongation if a.elongation is not None and math.isfinite(a.elongation) else None)
            if a.smooth is not None:
                r["sx"], r["sy"], r["sw"], r["sh"] = (_num(v) for v in a.smooth.bbox)
                r["scx"], r["scy"] = (_num(v) for v in a.smooth.centroid)
                r["sangle"] = _num(a.smooth.angle)
                r["sarea"] = _num(a.smooth.area, 2)
        rows.append(r)
    return rows


def write_csv(path: str | os.PathLike[str], track: Any, video: VideoInfo | None) -> Path:
    buf = io.StringIO(newline="")
    w = csv.DictWriter(buf, fieldnames=list(CSV_COLUMNS), lineterminator="\n")
    w.writeheader()
    for r in csv_rows(track, video):
        w.writerow(r)
    return atomic.write_text(Path(path), buf.getvalue(), newline="")


def read_csv(path: str | os.PathLike[str]) -> list[dict[str, str]]:
    text = atomic.read_text(Path(path))
    return list(csv.DictReader(io.StringIO(text, newline="")))


# ---------------------------------------------------------------- PNG 序列
def png_name(k: int, prefix: str = "mask") -> str:
    return f"{prefix}_{int(k):06d}.png"


def stale_png_frames(out_dir: str | os.PathLike[str], keep: range, *, prefix: str = "mask") -> list[Path]:
    """資料夾裡 `<prefix>_<k>.png`（6 位以上數字）而 k 不在 keep 裡的檔 —— 上一次匯出留下來的幀。"""
    import re

    d = Path(out_dir)
    if not d.is_dir():
        return []
    pat = re.compile(rf"{re.escape(prefix)}_(\d{{6,}})\.png")
    out: list[Path] = []
    for p in d.iterdir():
        m = pat.fullmatch(p.name)
        if m and int(m.group(1)) not in keep and p.is_file():
            out.append(p)
    return sorted(out)


def write_png_sequence(out_dir: str | os.PathLike[str], track: Any, *, prefix: str = "mask", ctx: Any = None) -> list[Path]:
    """每一幀一張 8-bit 灰階 PNG（255＝物件、0＝不是）；物件不在／沒算過的幀寫全黑（有檔比缺檔好對序列）。
    另寫一份 `<prefix>_sequence.json`（幀號範圍、尺寸、哪些幀沒算過），讀序列的程式不必猜。

    重新匯出到同一個資料夾時，**先刪掉這次範圍外的 `<prefix>_%06d.png`**：AE／Nuke／`ffmpeg -i mask_%06d.png`
    照檔名認序列、不看 manifest，留著上一次的幀就會把兩個物件（或新舊兩版）混成一段。別的檔名一律不碰。
    ctx（可省）：逐幀送 `objects.export` 進度、可取消。"""
    import cv2

    d = Path(out_dir)
    d.mkdir(parents=True, exist_ok=True)
    W, H = track.width, track.height
    ks_all = [a.k for a in track.anchors.iter_all()]
    keep = range(ks_all[0], ks_all[-1] + 1) if ks_all else range(0)
    for p in stale_png_frames(d, keep, prefix=prefix):
        atomic.unlink_quiet(p)
    black: bytes | None = None
    written: list[Path] = []
    missing: list[int] = []
    n_total = max(1, len(ks_all))
    for i, a in enumerate(track.anchors.iter_all(), start=1):
        if ctx is not None:
            ctx.check_cancel()
            ctx.progress("objects.export", i, n_total, frame=a.k)
        p = d / png_name(a.k, prefix)
        m = track.mask(a.k) if a.visible else None
        if m is None:
            if black is None:
                ok, buf = cv2.imencode(".png", np.zeros((H, W), np.uint8))
                black = buf.tobytes()
            atomic.write_bytes(p, black)
            if not a.computed:
                missing.append(a.k)
        else:
            ok, buf = cv2.imencode(".png", m.astype(np.uint8) * 255)
            if not ok:
                raise OSError(f"PNG 編碼失敗：{p}")
            atomic.write_bytes(p, buf.tobytes())
        written.append(p)
    ks = ks_all
    manifest = {
        "format": "aivc.masksequence.v1",
        "pattern": f"{prefix}_%06d.png",
        "first": ks[0] if ks else None,
        "last": ks[-1] if ks else None,
        "size": [W, H],
        "notComputed": missing,
        "source": str(track.path),
    }
    atomic.write_text(d / f"{prefix}_sequence.json", json.dumps(manifest, ensure_ascii=False, indent=1))
    return written


def read_png_sequence(out_dir: str | os.PathLike[str], ks: list[int], *, prefix: str = "mask") -> dict[int, np.ndarray]:
    from ..seg.preview import load_mask_png

    return {int(k): load_mask_png(Path(out_dir) / png_name(k, prefix)) for k in ks}
