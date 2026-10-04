"""外掛探索與載入（M1：選配功能做成外掛，例：`plugins/cards`；開源版沒有它）。

外掛是一個獨立的 Python 發行套件（例：`aivc-cards`，import 名 `aivc_cards`），兩種方式被找到：
1. entry point 群組 `aivc.plugins`（安裝版：外掛 wheel 的 pyproject 寫 `[project.entry-points."aivc.plugins"]`）；
2. 環境變數 `AIVC_PLUGINS`＝逗號分隔的模組名（開發／測試：PYTHONPATH 指到外掛的 src，免安裝）。
同一個模組兩邊都列只載一次。`AIVC_NO_PLUGINS=1`（安全模式）兩邊都不看。

外掛的約定：entry point（或 AIVC_PLUGINS 的模組）指到一個模組或可呼叫物件；模組要有 `register(host)`。
`register` 收到 `PluginHost`：用它登記掛勾（`aivc.hooks`）、import 自己的 op 模組（`@aivc.ops.register` 照舊，
op 名與 CLI 子命令跟搬家前一字不差）。模組可另帶 `PLUGIN_NAME`、`__version__`（hello 回報用）。

壞掉的外掛（import 失敗、register 擲例外）**不能拖垮核心**：記一筆到 `aivc.ops.LOAD_ERRORS`（serve 逐筆 warn、
hello.loadErrors 回給 App），並把它這次登記的 op 與掛勾整批撤掉——不留下半套（半套比沒有更難查：例如 schema 欄位
登記了、op 卻沒有）。

載入時機：`aivc.ops.load_all()`（CLI 建 parser、serve 啟動）在核心 op 之後呼叫 `ensure_loaded()`；
`aivc.hooks` 第一次被查詢時也會呼叫（函式庫用法、測試）。冪等、可重入（外掛的 register 裡查掛勾不會遞迴）、執行緒安全。
"""
from __future__ import annotations

import importlib
import os
import threading
from dataclasses import dataclass, field
from typing import Any, Callable

ENTRY_POINT_GROUP = "aivc.plugins"
ENV_PLUGINS = "AIVC_PLUGINS"
# 安全模式：設成 1 就完全不探索外掛（entry point 與 AIVC_PLUGINS 都不看）——查「是不是外掛害的」、或在裝了外掛的環境裡當開源版跑
ENV_NO_PLUGINS = "AIVC_NO_PLUGINS"
API_VERSION = 1


@dataclass(frozen=True)
class PluginInfo:
    name: str
    module: str
    version: str | None
    source: str  # "entry-point" | "env"
    ops: tuple[str, ...] = ()

    def to_json(self) -> dict[str, Any]:
        return {"name": self.name, "module": self.module, "version": self.version, "source": self.source, "ops": list(self.ops)}


_lock = threading.RLock()
_loading = False
_done = False
_loaded: dict[str, PluginInfo] = {}  # module 名 → info
_failed: dict[str, str] = {}  # module 名 → 錯誤訊息


class PluginHost:
    """`register(host)` 拿到的東西：登記掛勾、import op 模組、回報非致命問題。"""

    api_version = API_VERSION

    def __init__(self, name: str, module: str) -> None:
        self.name = name
        self.module = module

    # ---- 掛勾（見 aivc.hooks 的表）----
    def add(self, kind: str, value: Any) -> Any:
        from . import hooks

        return hooks.add(kind, value, owner=self.name)

    def add_insert_source(self, source: Any) -> Any:
        return self.add("insert-source", source)

    def add_param_group(self, group: Any) -> Any:
        return self.add("param-group", group)

    def add_schema_field(self, f: Any) -> Any:
        return self.add("schema-field", f)

    def add_track_check(self, fn: Callable[..., None]) -> Any:
        return self.add("track-check", fn)

    def add_composite_mode(self, mode: Any) -> Any:
        return self.add("composite-mode", mode)

    def add_face_stage(self, stage: Any) -> Any:
        return self.add("face-stage", stage)

    def add_track_method(self, method: Any) -> Any:
        return self.add("track-method", method)

    def add_op_args(self, op: str, add_arguments: Callable[[Any], None]) -> Any:
        from .hooks import OpArgs

        return self.add("op-args", OpArgs(op, add_arguments))

    def set_content_note(self, text: str) -> Any:
        return self.add("content-note", str(text))

    def add_render_finish(self, fn: Callable[..., None]) -> Any:
        return self.add("render-finish", fn)

    # ---- op 模組 ----
    def import_ops(self, package: str) -> list[str]:
        """import 套件底下每一個（非底線開頭的）模組讓它們的 `@register` 生效。

        跟核心 `load_all` 同一個紀律：一個模組壞掉只讓它自己的 op 消失，並記一筆說清楚是哪一個。"""
        import pkgutil

        from .ops import LOAD_ERRORS

        pkg = importlib.import_module(package)
        done: list[str] = []
        for m in pkgutil.iter_modules(pkg.__path__):
            if m.name.startswith("_"):
                continue
            full = f"{package}.{m.name}"
            try:
                importlib.import_module(full)
                done.append(full)
            except Exception as e:  # noqa: BLE001
                LOAD_ERRORS.append(f"{full} 載入失敗（外掛 {self.name}；這個模組的 op 全部不可用）：{type(e).__name__}: {e}")
        return done

    def error(self, message: str) -> None:
        from .ops import LOAD_ERRORS

        LOAD_ERRORS.append(f"外掛 {self.name}：{message}")


def _env_modules() -> list[str]:
    return [s.strip() for s in os.environ.get(ENV_PLUGINS, "").split(",") if s.strip()]


def _entry_points() -> list[Any]:
    try:
        from importlib.metadata import entry_points

        return list(entry_points(group=ENTRY_POINT_GROUP))
    except Exception:  # noqa: BLE001  壞掉的 metadata 不能讓引擎起不來
        return []


def _resolve_register(obj: Any) -> tuple[Callable[[PluginHost], None], Any]:
    """entry point／模組 → (register, 模組物件)。"""
    import types

    if isinstance(obj, types.ModuleType):
        reg = getattr(obj, "register", None)
        if not callable(reg):
            raise TypeError(f"外掛模組 {obj.__name__} 沒有 register(host)")
        return reg, obj
    if callable(obj):
        mod = importlib.import_module(getattr(obj, "__module__", "") or "builtins")
        return obj, mod
    raise TypeError(f"外掛進入點 {obj!r} 不是模組也不是可呼叫物件")


def load_plugin(target: str, *, name: str | None = None, source: str = "env", loader: Callable[[], Any] | None = None) -> PluginInfo | None:
    """載入一個外掛（target＝模組名或 `模組:屬性`）。失敗回 None 並記到 LOAD_ERRORS；成功回 PluginInfo。

    回滾：先記下 op 註冊表與掛勾的現況，register 擲例外就把這次新增的 op 與這個 owner 的掛勾全部撤掉。"""
    from . import hooks
    from .ops import CLI_INDEX, LOAD_ERRORS, REGISTRY

    module_name = target.split(":", 1)[0]
    package = module_name.split(".", 1)[0]

    def mine(op_name: str) -> bool:
        # 「這個外掛的 op」＝定義在外掛自己套件裡的 op。外掛 import 核心 op 模組時順帶註冊的核心 op 不算（回滾時不能撤掉它們）
        op = REGISTRY.get(op_name)
        return op is not None and str(getattr(op.fn, "__module__", "")).split(".", 1)[0] == package

    with _lock:
        if module_name in _loaded:
            return _loaded[module_name]
        if module_name in _failed:
            return None
        before_ops = set(REGISTRY)
        label = name or module_name
        try:
            if loader is not None:
                obj = loader()
            else:
                mod = importlib.import_module(module_name)
                obj = getattr(mod, target.split(":", 1)[1]) if ":" in target else mod
            reg, mod = _resolve_register(obj)
            label = name or str(getattr(mod, "PLUGIN_NAME", "") or module_name)
            reg(PluginHost(label, module_name))
        except Exception as e:  # noqa: BLE001
            for op_name in [o for o in set(REGISTRY) - before_ops if mine(o)]:
                cli = REGISTRY[op_name].cli
                REGISTRY.pop(op_name, None)
                if cli and CLI_INDEX.get(cli) is not None and CLI_INDEX[cli].name == op_name:
                    CLI_INDEX.pop(cli, None)
            hooks.remove_owner(label)
            msg = f"外掛 {label}（{module_name}）載入失敗（它的 op 與掛勾全部不可用）：{type(e).__name__}: {e}"
            LOAD_ERRORS.append(msg)
            _failed[module_name] = msg
            return None
        version = getattr(mod, "__version__", None)
        info = PluginInfo(label, module_name, None if version is None else str(version), source, tuple(sorted(o for o in set(REGISTRY) - before_ops if mine(o))))
        _loaded[module_name] = info
        return info


def ensure_loaded() -> list[PluginInfo]:
    """探索並載入所有外掛（冪等）。entry point 先、AIVC_PLUGINS 後；同一個模組只載一次。"""
    global _loading, _done  # noqa: PLW0603
    if _done:
        return loaded()
    with _lock:
        if _done or _loading:
            return loaded()
        _loading = True
        try:
            if os.environ.get(ENV_NO_PLUGINS, "").strip() not in ("", "0"):
                _done = True
                return loaded()
            for ep in _entry_points():
                load_plugin(str(ep.value), name=ep.name, source="entry-point", loader=ep.load)
            for m in _env_modules():
                load_plugin(m, source="env")
            _done = True
        finally:
            _loading = False
    return loaded()


def loaded() -> list[PluginInfo]:
    return list(_loaded.values())


def is_loaded(name: str) -> bool:
    """name 可以是外掛名（"cards"）或模組名（"aivc_cards"）。"""
    return any(p.name == name or p.module == name for p in _loaded.values())


def failures() -> dict[str, str]:
    return dict(_failed)


@dataclass
class _Snapshot:
    loading: bool
    done: bool
    loaded: dict[str, PluginInfo] = field(default_factory=dict)
    failed: dict[str, str] = field(default_factory=dict)


def _snapshot() -> _Snapshot:
    """測試用：記下探索狀態（配合 `_restore` 在測試後還原）。"""
    return _Snapshot(_loading, _done, dict(_loaded), dict(_failed))


def _restore(s: _Snapshot) -> None:
    global _loading, _done  # noqa: PLW0603
    with _lock:
        _loading, _done = s.loading, s.done
        _loaded.clear()
        _loaded.update(s.loaded)
        _failed.clear()
        _failed.update(s.failed)


def _reset() -> None:
    """測試用：忘掉「已經探索過」，下次 ensure_loaded() 重新探索（已登記的 op／掛勾不動，由呼叫端自己處理）。"""
    _restore(_Snapshot(False, False))
