"""test_serve_light_lane 用的假 op：`light=True` 的短 op（由 `AIVC_EXTRA_OPS=aivc_fake_ops,aivc_light_ops` 注入）。"""
from __future__ import annotations

import importlib
import threading
import time
from typing import Any

from aivc.ops import Ctx, register


@register("test.light_echo", help="輕量 lane：回傳 args 與執行緒名", light=True)
def light_echo(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    ctx.log("info", "light_echo ran")
    return {"echo": args, "thread": threading.current_thread().name}


@register("test.light_slow", help="輕量 lane：n 步 sleep（可取消）", light=True)
def light_slow(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    n = int(args.get("n", 10))
    dt = float(args.get("dt", 0.05))
    for i in range(n):
        ctx.check_cancel()
        time.sleep(dt)
        ctx.progress("light_slow", i + 1, n)
    return {"steps": n, "thread": threading.current_thread().name}


@register("test.light_native_import", help="輕量執行緒 import 帶原生 runtime 的擴充（Windows stdin 死結回歸）", light=True)
def light_native_import(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    t = time.monotonic()
    for name in args.get("modules", ["scipy.linalg"]):
        importlib.import_module(name)
    return {"seconds": round(time.monotonic() - t, 3), "thread": threading.current_thread().name}
