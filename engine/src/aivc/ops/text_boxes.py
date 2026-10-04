"""`aivc text-boxes <video> --frame K --text "杯子, 手"`（op `seg.text_boxes`）：文字 → 候選框。

框是給 `seg.run --box x,y,w,h` 用的：這支只負責「文字 → 框」，追蹤本身仍然走既有的 SAM 2.1 管線
（理由與模型選擇見 `seg/text_box.py` 的模組說明）。輸出刻意附一段可以直接貼的 `--box …`，
因為這兩支的接法就是「把框抄過去」，少一次手動換算就少一次把 xyxy 當成 xywh 的機會。

只讀一幀：開放詞彙偵測是逐幀的，在整段上跑沒有意義（要的是「在這一幀指出目標」，
之後由 SAM 2.1 沿著幀傳播）。
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from .. import env
from . import Ctx, OpError, register

STAGE = "seg.text_boxes"


def _args(p: argparse.ArgumentParser) -> None:
    p.add_argument("video", help="影片（通常是 proxy）")
    p.add_argument("--frame", type=int, default=0, help="在哪一幀找（預設 0）")
    p.add_argument("--text", required=True, help='要找什麼，逗號分隔（例如 "杯子, 手"）；順序就是 seg 的物件 id 1..n')
    p.add_argument("--owl", default=None, help="OWLv2 變體：base（預設）｜large")
    p.add_argument("--threshold", type=float, default=None, help="分數門檻（預設 0.1）")
    p.add_argument("--max-boxes", type=int, default=None, help="最多回幾個框（預設 8）")
    p.add_argument("--device", default=None, help="cuda｜mps｜cpu｜auto（預設 auto）")


@register("seg.text_boxes", cli="text-boxes", help="文字提示 → 候選框（餵給 seg 的 --box）", args=_args, gpu=True)
def text_boxes(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..seg._frames import read_frame
    from ..seg.backend import SegModelError
    from ..seg.text_box import DEFAULT_MAX_BOXES, DEFAULT_THRESHOLD, DEFAULT_VARIANT, detect

    video = env.normalize_path(args["video"])
    if not Path(video).is_file():
        raise OpError("Io", f"找不到影片 {video}")
    k = int(args.get("frame") or 0)
    if k < 0:
        raise OpError("Invalid", f"--frame 不能是負的（拿到 {k}）")

    ctx.progress(STAGE, 0, 2)
    try:
        rgb = read_frame(video, k)
    except IndexError as e:
        raise OpError("Invalid", f"幀 {k} 超出影片範圍") from e

    ctx.progress(STAGE, 1, 2)
    try:
        found = detect(
            rgb,
            args["text"],
            variant=args.get("owl") or DEFAULT_VARIANT,
            device=args.get("device"),
            threshold=DEFAULT_THRESHOLD if args.get("threshold") is None else float(args["threshold"]),
            max_boxes=DEFAULT_MAX_BOXES if args.get("max_boxes") is None else int(args["max_boxes"]),
        )
    except SegModelError as e:
        raise OpError(e.kind, str(e), e.hint) from e
    ctx.progress(STAGE, 2, 2)

    h, w = int(rgb.shape[0]), int(rgb.shape[1])
    return {
        "frame": k,
        "size": [w, h],
        "boxes": [{"box": [round(v, 2) for v in b.box], "phrase": b.phrase, "score": round(b.score, 4)} for b in found],
        # 可以直接貼給 seg 的形式；沒找到就不給（空字串比一句假的指令好）
        "seg_args": " ".join(f"--box {b.box[0]:.0f},{b.box[1]:.0f},{b.box[2]:.0f},{b.box[3]:.0f}" for b in found),
    }
