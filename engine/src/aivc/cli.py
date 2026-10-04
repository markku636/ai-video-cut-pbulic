"""`aivc` 命令列入口：子命令全部來自 ops 註冊表（新增功能請加 `aivc/ops/<module>.py`，不要改這裡）。

全域旗標：--json（stdout 走 JSONL：progress/log/artifact 事件，最後一行是結果）、--version。
退出碼：0 ok / 2 參數或專案錯 / 3 環境閘門未過 / 4 模型缺 / 5 取消 / 1 其他。
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback

from . import env
from ._version import __version__
from .ops import CLI_INDEX, Canceled, OpError, load_all
from .ops._ctx import CliCtx

_EXIT_BY_KIND = {"Invalid": 2, "Io": 1, "Ffmpeg": 1, "Canceled": 5, "Timeout": 1, "Gpu": 3, "Model": 4, "PyEnv": 3, "Engine": 1, "Internal": 1}


def build_parser() -> argparse.ArgumentParser:
    load_all()
    p = argparse.ArgumentParser(prog="aivc", description=f"AI Video Cut engine {__version__}")
    p.add_argument("--version", action="version", version=__version__)
    p.add_argument("--json", action="store_true", help="stdout 輸出 JSONL 事件與結果（給程式讀）")
    sub = p.add_subparsers(dest="_cmd", metavar="<command>")
    for cli_name in sorted(CLI_INDEX):
        op = CLI_INDEX[cli_name]
        sp = sub.add_parser(cli_name, help=op.help, description=op.help)
        if op.add_arguments:
            op.add_arguments(sp)
        sp.set_defaults(_op=op.name)
    return p


def main(argv: list[str] | None = None) -> int:
    env.ensure_utf8_stdio()
    env.apply_model_env()
    parser = build_parser()
    ns = parser.parse_args(sys.argv[1:] if argv is None else argv)
    if not getattr(ns, "_cmd", None):
        parser.print_help()
        return 0
    op = CLI_INDEX[ns._cmd]
    args = {k: v for k, v in vars(ns).items() if not k.startswith("_") and k != "json"}
    ctx = CliCtx(json_mode=ns.json)
    if ns.json:
        # JSONL 是給程式讀的：一律 UTF-8，不跟著主控台的 code page 走（Windows 重導向到檔案時預設 cp950，中文全變問號）
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass
    try:
        result = op.fn(args, ctx)
    except Canceled:
        _emit_error(ns.json, {"kind": "Canceled", "message": "已取消", "hint": ""})
        return 5
    except OpError as e:
        _emit_error(ns.json, e.to_wire())
        return _EXIT_BY_KIND.get(e.kind, 1)
    except KeyboardInterrupt:
        _emit_error(ns.json, {"kind": "Canceled", "message": "已取消（Ctrl+C）", "hint": ""})
        return 5
    except Exception as e:  # noqa: BLE001
        tb = traceback.format_exc()
        _emit_error(ns.json, {"kind": "Internal", "message": f"{type(e).__name__}: {e}", "hint": tb.splitlines()[-1] if tb else ""})
        if not ns.json:
            print(tb, file=sys.stderr)
        return 1

    code = int(result.pop("_exit_code", 0)) if isinstance(result, dict) else 0
    human = result.pop("_human", None) if isinstance(result, dict) else None
    if ns.json:
        sys.stdout.write(json.dumps({"id": "cli", "ok": code == 0, "result": result}, ensure_ascii=False) + "\n")
    else:
        print(human if human is not None else json.dumps(result, ensure_ascii=False, indent=2))
    return code


def _emit_error(json_mode: bool, err: dict[str, str]) -> None:
    if json_mode:
        sys.stdout.write(json.dumps({"id": "cli", "ok": False, "error": err}, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    else:
        hint = f"\n  → {err['hint']}" if err.get("hint") else ""
        print(f"aivc: [{err['kind']}] {err['message']}{hint}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
