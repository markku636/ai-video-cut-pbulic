"""test_protocol 用的假 op 模組：由 `AIVC_EXTRA_OPS=aivc_fake_ops` 注入 `aivc serve`。

沒有任何真實工作：只驗證線路格式、進度順序、取消、錯誤映射。
"""
from __future__ import annotations

import time
from typing import Any

from aivc.ops import Ctx, OpError, register


@register("test.echo", help="回傳 args")
def echo(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    ctx.log("info", f"echo {sorted(args)}")
    return {"echo": args}


@register("test.slow", help="n 步、每步 sleep；每步 progress + check_cancel")
def slow(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    n = int(args.get("n", 10))
    dt = float(args.get("dt", 0.05))
    for i in range(n):
        ctx.check_cancel()
        time.sleep(dt)
        ctx.progress("slow", i + 1, n)
    return {"steps": n}


@register("test.fail_op", help="擲 OpError")
def fail_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    raise OpError(str(args.get("kind", "Model")), str(args.get("message", "模型缺")), str(args.get("hint", "aivc models pull")))


@register("test.boom", help="擲未捕捉例外")
def boom(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    raise RuntimeError(str(args.get("message", "kaboom")))


@register("test.artifact", help="送一個 artifact 事件")
def artifact(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    ctx.artifact(str(args.get("path", r"C:\tmp\x.aivm")), "mask")
    return {"_exit_code": 3, "_human": "hidden", "visible": True}
