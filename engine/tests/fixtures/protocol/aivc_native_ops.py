"""test_serve_stdin.py 用的假 op：在 worker 執行緒 import 帶原生 runtime 的擴充模組（重現 Windows stdin 死結）。

由 `AIVC_EXTRA_OPS=aivc_native_ops` 注入 `aivc serve`。
"""
from __future__ import annotations

import importlib
import time
from typing import Any

from aivc.ops import Ctx, register


@register("test.native_import", help="worker 執行緒 import 原生擴充（scipy.linalg 會載 OpenBLAS／Fortran runtime）")
def native_import(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    t = time.monotonic()
    for name in args.get("modules", ["scipy.linalg"]):
        importlib.import_module(name)
    return {"seconds": round(time.monotonic() - t, 3)}
