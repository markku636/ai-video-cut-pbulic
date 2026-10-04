"""`aivc serve [--cache-dir D] [--ffmpeg-dir D] [--no-torch-probe]`：常駐 JSONL sidecar（實作在 aivc.serve）。

sidecar 自己就是 stdout 的擁有者，所以這支 op **不回傳結果給 CLI 印**：迴圈結束後直接 `SystemExit(code)`，
否則 cli.py 會在 shutdown 之後再多印一行 JSON —— 那是「未經請求的 stdout」，Rust 端讀到會混亂。
"""
from __future__ import annotations

import argparse
import os
from typing import Any

from . import Ctx, register


def _args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--cache-dir", default=None, help="衍生資料快取根（=AIVC_CACHE_DIR）")
    p.add_argument("--ffmpeg-dir", default=None, help="ffmpeg/ffprobe 目錄（=AIVC_FFMPEG_DIR）")
    p.add_argument("--no-torch-probe", action="store_true", help="hello 不 import torch（測試／無 GPU 機器）")


@register("engine.serve", cli="serve", help="JSONL sidecar：stdin 收 {id,op,args}，stdout 回事件與回覆（給 Tauri engine.rs）", args=_args)
def serve_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    if args.get("cache_dir"):
        os.environ["AIVC_CACHE_DIR"] = str(args["cache_dir"])
    if args.get("ffmpeg_dir"):
        os.environ["AIVC_FFMPEG_DIR"] = str(args["ffmpeg_dir"])
    from ..serve import serve_forever

    code = serve_forever(torch_probe=not bool(args.get("no_torch_probe")))
    raise SystemExit(code)
