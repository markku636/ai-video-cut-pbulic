"""`aivc frame <video> --at K --out f.png [--max-side 1024] [--grid]`（op `media.frame`）：把一幀存成 PNG。

給 Claude Code／Codex 這類看圖的 AI 用的第一步：
1. `aivc frame clip.mp4 --at 120 --out f.png --max-side 1024 --grid` → 看圖；`--grid` 疊上 0–1000 的座標格線與刻度。
2. 讀出物件的座標（0–1000）→ `aivc select clip.mp4 --frame 120 --coords norm1000 --point 512,430 --box 400,300,250,260 --out sel`
3. 看 `sel/overlay.png` 確認選對了，再 `--propagate`。

格線畫在**輸出圖**上：圖縮小過也照樣對得上，因為 norm1000 是相對於畫面寬高（x_px = x/1000 × 寬），跟像素無關。
幀號是 CFR proxy 幀號 k（與其他 op 一致）；色彩轉換用 `Yuv420.rgb8()`（與預覽、PNG 匯出同一條）。
"""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from .. import env
from . import Ctx, OpError, register


def _args(p: argparse.ArgumentParser) -> None:
    p.add_argument("video", help="影片路徑（通常是 proxy）")
    p.add_argument("--at", type=int, required=True, help="proxy 幀號 K")
    p.add_argument("--out", required=True, help="輸出 PNG")
    p.add_argument("--max-side", type=int, default=None, help="長邊縮到 ≤ N 像素（不放大；預設原尺寸）")
    p.add_argument("--grid", action="store_true", help="疊 0–1000 正規化座標格線（給 AI 讀座標；配 aivc select --coords norm1000）")


@register("media.frame", cli="frame", help="存一幀 PNG（--grid 疊 0–1000 座標格線，給看圖的 AI 讀座標）", args=_args)
def frame_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..seg import preview, viz
    from .track import ProxyFrames

    video = env.normalize_path(str(args["video"]))
    if not Path(video).is_file():
        raise OpError("Io", f"找不到影片 {video}")
    k = int(args["at"])
    max_side = args.get("max_side")
    if max_side is not None and int(max_side) < 16:
        raise OpError("Invalid", f"--max-side 至少 16（拿到 {max_side}）")
    out = Path(env.normalize_path(str(args["out"])))
    frames = ProxyFrames(video, ctx)
    try:
        if not 0 <= k < frames.n:
            raise OpError("Invalid", f"--at {k} 超出 proxy 幀範圍 [0, {frames.n})")
        rgb = frames.get(k)
        t = frames.seconds(k)
        W, H = frames.width, frames.height
    finally:
        frames.close()
    img, scale = viz.fit_max_side(rgb, None if max_side is None else int(max_side))
    if args.get("grid"):
        img = viz.grid_overlay(img)
    path = preview.save_png(out, img)
    ctx.artifact(path, kind="frame")
    h, w = img.shape[:2]
    return {
        "frame": k,
        "t": round(t, 6),
        "out": path,
        "size": [w, h],
        "sourceSize": [W, H],
        "scale": round(scale, 6),
        "grid": bool(args.get("grid")),
        "coords": {"norm1000": f"x_px = x / 1000 * {W}, y_px = y / 1000 * {H}", "px": f"x_px = x_img / {round(scale, 6)}"},
        "_human": f"k={k}（{t:.3f}s）→ {path}（{w}×{h}" + (f"，原尺寸 {W}×{H}" if scale != 1.0 else "") + ("，0–1000 格線" if args.get("grid") else "") + "）",
    }
