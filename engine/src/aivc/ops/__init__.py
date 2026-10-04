"""op 註冊表：CLI 子命令與 sidecar `aivc serve` 共用同一份實作（計畫 §6.8 / §5.8）。

每個 op 是一支 `fn(args: dict, ctx: Ctx) -> dict`。
- CLI：`aivc <cli-name> ...` → argparse（由 op 的 `add_arguments` 定義旗標）→ `fn(vars(ns), CliCtx)`。
- sidecar：`{"id","op":"media.probe","args":{...}}` → `fn(args, ServeCtx)` → 回覆 `{"id","ok","result"}`。
新增功能＝在 `aivc/ops/<module>.py` 用 `@register(...)` 註冊一支 op；**不要改 cli.py**。
外掛（`aivc.plugins`：entry point 群組 `aivc.plugins` 或環境變數 AIVC_PLUGINS）在 `load_all()` 的最後載入，
它的 op 一樣用 `@register`；外掛也可以替核心 op 加 CLI 旗標（`hooks` 的 op-args，見 `_with_plugin_args`）。
"""
from __future__ import annotations

import argparse
import importlib
import pkgutil
from dataclasses import dataclass
from typing import Any, Callable, Protocol


class Ctx(Protocol):
    """op 執行期能拿到的東西：進度、log、取消檢查。CLI 與 sidecar 各有一個實作。"""

    def progress(self, stage: str, done: int, total: int, **extra: Any) -> None: ...

    def log(self, level: str, message: str) -> None: ...

    def check_cancel(self) -> None:
        """被取消時擲出 `Canceled`；長迴圈每幀呼叫一次。"""
        ...

    def artifact(self, path: str, kind: str = "") -> None:
        """提早可用的檔案（例如某鏡頭的遮罩檔）。"""
        ...


class Canceled(Exception):
    pass


class OpError(Exception):
    """op 的可預期錯誤。kind 鏡射 Rust error.rs：Invalid|Io|Ffmpeg|Canceled|Timeout|Gpu|Model|PyEnv|Agent|Engine|Internal。"""

    def __init__(self, kind: str, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.kind = kind
        self.hint = hint

    def to_wire(self) -> dict[str, str]:
        return {"kind": self.kind, "message": str(self), "hint": self.hint}


OpFn = Callable[[dict[str, Any], Ctx], dict[str, Any]]
ArgFn = Callable[[argparse.ArgumentParser], None]


@dataclass
class Op:
    name: str  # 命名空間名，例如 "media.probe"
    fn: OpFn
    cli: str | None  # CLI 子命令名；None = 只給 sidecar
    help: str = ""
    add_arguments: ArgFn | None = None
    gpu: bool = False  # True → Rust 端會先取 GPU semaphore
    light: bool = False  # True → sidecar 走輕量 worker（aivc-light），長工作跑的時候短呼叫照樣秒回


REGISTRY: dict[str, Op] = {}
CLI_INDEX: dict[str, Op] = {}
# load_all() 期間出的問題（模組 import 失敗、註冊旗標矛盾）。serve 會逐筆 warn 並放進 hello，
# 不讓「某個模組的 op 整批安靜消失、呼叫時只回『未知 op』」這種狀況查不出原因。
LOAD_ERRORS: list[str] = []

# 輕量 lane 白名單（B-06）：只放審過「與長工作同時跑也安全」的 op——純 CPU、不碰 GPU、不改模組層共用狀態
# （字型 lru_cache 的 FreeTypeFont 在 Pillow 內不放 GIL；遮罩檔讀進記憶體就關檔）。
#
# **不是唯讀**：`render.plan` 與 `captions.layout` 都會經 `project.resolve.open_media_context` 寫
# `probe.v1.json` / `index.v1.json`，`captions.layout` 另外寫 `captions/<key>/{atlas.v1.png,layout.v1.json}`。
# 與長工作同時跑安全的前提是這些寫入都走 `aivc.atomic`（唯一暫存名 + 換入／讀取退避重試），
# 而且冷快取時的索引重建由 `ops.media.ensure_index` 的 keyed_lock 擋成只做一次。
# 集中列在這裡而不是散在各 op 檔：新增一支要能一眼看到整份清單再審；外部 op 也可以 `register(..., light=True)`。
LIGHT_OPS = frozenset({"render.plan", "captions.layout", "geom.quad_from_mask"})


def _with_plugin_args(name: str, args: ArgFn | None) -> ArgFn:
    """建 CLI parser 時：op 自己的旗標 → 外掛替這支 op 加的旗標（hooks op-args，登記順序）。

    包在這裡而不是 cli.py：解析時才查登記表（外掛在 load_all 的最後才載入，比 @register 晚）。"""

    def add(p: argparse.ArgumentParser) -> None:
        if args is not None:
            args(p)
        from .. import hooks

        for extra in hooks.op_args(name):
            extra(p)

    return add


def register(name: str, *, cli: str | None = None, help: str = "", args: ArgFn | None = None, gpu: bool = False, light: bool = False):
    light = bool(light) or name in LIGHT_OPS
    if light and gpu:
        # 輕量 lane 與主 worker 並行：gpu op 放進去就會跟 SAM 同時佔 GPU（決策 8：兩個 SAM 同跑必 OOM）。
        # 這是寫錯程式，但在 decorator 裡 raise 會讓整個 op 模組 import 失敗、同一個檔後面的 op 全部安靜
        # 從 REGISTRY 消失（serve 只 warn 一次，呼叫端看到的是「未知 op」）。改成退回主 lane 並記一筆：
        # 能力不消失、錯誤看得到（LOAD_ERRORS → serve stderr + hello.loadErrors）。
        LOAD_ERRORS.append(f"op {name!r} 同時標了 gpu=True 與 light=True：已強制走主 worker")
        light = False

    def deco(fn: OpFn) -> OpFn:
        op = Op(name=name, fn=fn, cli=cli, help=help, add_arguments=_with_plugin_args(name, args), gpu=gpu, light=light)
        REGISTRY[name] = op
        if cli:
            if cli in CLI_INDEX and CLI_INDEX[cli].name != name:
                raise RuntimeError(f"CLI 子命令 {cli!r} 重複：{CLI_INDEX[cli].name} 與 {name}")
            CLI_INDEX[cli] = op
        return fn

    return deco


_loaded = False


def load_all() -> None:
    """import 所有 aivc.ops.* 模組讓它們註冊（惰性；重的 import 放在 op 函式內），最後載入外掛（aivc.plugins）。

    外掛壞掉（import 失敗、register 擲例外）只記一筆到 LOAD_ERRORS、撤掉它這次登記的東西，核心的 op 照常可用。"""
    global _loaded  # noqa: PLW0603
    if _loaded:
        return
    import aivc.ops as pkg

    # 逐個模組 import：一個模組壞掉不該讓其他模組的 op 也跟著不見，而且要說得出是「哪一個」壞了
    for m in pkgutil.iter_modules(pkg.__path__):
        if m.name.startswith("_"):
            continue
        try:
            importlib.import_module(f"aivc.ops.{m.name}")
        except Exception as e:  # noqa: BLE001
            LOAD_ERRORS.append(f"aivc.ops.{m.name} 載入失敗（這個模組的 op 全部不可用）：{type(e).__name__}: {e}")
    # 測試掛勾：AIVC_EXTRA_OPS="pkg.mod,pkg.mod2" 額外 import 外部 op 模組（test_protocol 用假 op 測 serve）。
    import os

    for name in filter(None, (s.strip() for s in os.environ.get("AIVC_EXTRA_OPS", "").split(","))):
        importlib.import_module(name)
    # 外掛（entry point 群組 aivc.plugins ＋ AIVC_PLUGINS）：核心 op 都註冊完才載入（外掛可能 import 核心的 op 模組）
    from .. import plugins

    try:
        plugins.ensure_loaded()
    except Exception as e:  # noqa: BLE001  探索本身炸掉（不是某個外掛）：記下來，核心照常
        LOAD_ERRORS.append(f"外掛探索失敗（所有外掛都不可用）：{type(e).__name__}: {e}")
    _loaded = True
