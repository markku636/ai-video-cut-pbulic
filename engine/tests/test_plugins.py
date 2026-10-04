"""外掛探索與載入（aivc/plugins.py）與掛勾登記表（aivc/hooks.py）。

- AIVC_PLUGINS 的模組、entry point（群組 aivc.plugins）都載得到；同一個模組只載一次；
- 壞掉的外掛（import 失敗、register 擲例外）記進 LOAD_ERRORS、它登記的 op 與掛勾整批撤掉，核心 op 照常；
- 安全模式 AIVC_NO_PLUGINS=1 不探索；`aivc --help` 沒有外掛時不列外掛的子命令；sidecar hello 回報 plugins／loadErrors。
測試用的外掛模組寫在 tmp 目錄（sys.path 暫時加上）；每個測試前後還原探索狀態與登記表，不影響同一個行程的其他測試。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Any, Iterator

import pytest

from aivc import hooks, plugins
from aivc.ops import CLI_INDEX, LOAD_ERRORS, REGISTRY, load_all

ENGINE = Path(__file__).resolve().parents[1]
CORE_OPS = {"render.run", "render.plan", "track.solve", "seg.run", "media.probe", "sequence.show", "comp.preview_composite"}
# 搬進牌局外掛的子命令：沒有外掛時一個都不能出現
CARD_COMMANDS = {
    "detect", "identify", "replace", "run", "deck-build", "deck-show", "deck-learn", "deck-faces", "deck-from-image", "deck-import",
    "vd-configure", "vd-verify-output", "render-timeline", "preview-frame", "bench-verify", "bench-whitespecks", "label-auto",
}

GOOD = '''
"""測試外掛：一支 op ＋ 一個內容揭露預設句。"""
from aivc.ops import register as _register

PLUGIN_NAME = "{name}"
__version__ = "1.2.3"


def register(host):
    @_register("test.{name}.echo", cli="test-{name}-echo", help="echo")
    def echo(args, ctx):
        return {{"echo": args.get("x")}}

    host.set_content_note("plugin {name} note {{version}}")
'''

BROKEN_REGISTER = '''
from aivc.ops import register as _register

PLUGIN_NAME = "{name}"


def register(host):
    @_register("test.{name}.half", cli="test-{name}-half", help="half")
    def half(args, ctx):
        return {{}}

    host.set_content_note("should be rolled back")
    raise RuntimeError("register 半途炸了")
'''


@pytest.fixture
def sandbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """乾淨的探索狀態：外掛模組放 tmp_path，結束後還原 op 註冊表、掛勾、LOAD_ERRORS、探索快照與 sys.modules。"""
    load_all()
    snap = plugins._snapshot()
    reg_before, cli_before, errs_before = dict(REGISTRY), dict(CLI_INDEX), list(LOAD_ERRORS)
    hooks_before = {k: list(v) for k, v in hooks._REG.items()}
    mods_before = set(sys.modules)
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.delenv(plugins.ENV_PLUGINS, raising=False)
    monkeypatch.delenv(plugins.ENV_NO_PLUGINS, raising=False)
    plugins._reset()
    monkeypatch.setattr(plugins, "_entry_points", lambda: [])
    try:
        yield tmp_path
    finally:
        REGISTRY.clear()
        REGISTRY.update(reg_before)
        CLI_INDEX.clear()
        CLI_INDEX.update(cli_before)
        LOAD_ERRORS[:] = errs_before
        for k in hooks._REG:
            hooks._REG[k] = hooks_before[k]
        plugins._restore(snap)
        for m in set(sys.modules) - mods_before:
            if m.startswith("aivc_testplug"):
                sys.modules.pop(m, None)


def _write(root: Path, name: str, body: str) -> None:
    (root / f"{name}.py").write_text(textwrap.dedent(body.format(name=name)), encoding="utf-8")


def test_env_plugin_loads_registers_op_and_hook(sandbox: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write(sandbox, "aivc_testplug_a", GOOD)
    monkeypatch.setenv(plugins.ENV_PLUGINS, " aivc_testplug_a , ,aivc_testplug_a")  # 空白、重複都容忍
    info = plugins.ensure_loaded()
    assert [(p.name, p.module, p.version, p.source, p.ops) for p in info] == [("aivc_testplug_a", "aivc_testplug_a", "1.2.3", "env", ("test.aivc_testplug_a.echo",))]
    assert REGISTRY["test.aivc_testplug_a.echo"].fn({"x": 7}, None) == {"echo": 7}  # type: ignore[arg-type]
    assert CLI_INDEX["test-aivc_testplug_a-echo"].name == "test.aivc_testplug_a.echo"
    assert hooks.content_note() == "plugin aivc_testplug_a note {version}"
    assert plugins.is_loaded("aivc_testplug_a") and plugins.ensure_loaded() == info  # 冪等
    assert info[0].to_json()["ops"] == ["test.aivc_testplug_a.echo"]


def test_entry_point_plugin_loads_once_even_if_also_in_env(sandbox: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write(sandbox, "aivc_testplug_b", GOOD)

    class EP:
        name = "bee"
        value = "aivc_testplug_b"

        def load(self) -> Any:
            import importlib

            return importlib.import_module("aivc_testplug_b")

    monkeypatch.setattr(plugins, "_entry_points", lambda: [EP()])
    monkeypatch.setenv(plugins.ENV_PLUGINS, "aivc_testplug_b")
    info = plugins.ensure_loaded()
    assert [(p.name, p.source) for p in info] == [("bee", "entry-point")]  # entry point 的名字優先；env 那筆不再載


def test_broken_plugins_are_reported_and_rolled_back_core_ops_survive(sandbox: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write(sandbox, "aivc_testplug_c", BROKEN_REGISTER)
    (sandbox / "aivc_testplug_d.py").write_text("raise ImportError('缺了某個依賴')\n", encoding="utf-8")
    (sandbox / "aivc_testplug_e.py").write_text("PLUGIN_NAME = 'e'\n", encoding="utf-8")  # 沒有 register
    _write(sandbox, "aivc_testplug_f", GOOD)
    monkeypatch.setenv(plugins.ENV_PLUGINS, "aivc_testplug_c,aivc_testplug_d,aivc_testplug_e,aivc_testplug_missing,aivc_testplug_f")
    before = len(LOAD_ERRORS)
    info = plugins.ensure_loaded()
    assert [p.module for p in info] == ["aivc_testplug_f"]  # 好的照樣載
    errs = LOAD_ERRORS[before:]
    assert len(errs) == 4, errs
    for mod in ("aivc_testplug_c", "aivc_testplug_d", "aivc_testplug_e", "aivc_testplug_missing"):
        assert any(mod in e and "載入失敗" in e for e in errs), (mod, errs)
    assert any("register 半途炸了" in e for e in errs) and any("缺了某個依賴" in e for e in errs)
    # 回滾：半途註冊的 op、CLI、掛勾全部撤掉
    assert "test.aivc_testplug_c.half" not in REGISTRY and "test-aivc_testplug_c-half" not in CLI_INDEX
    assert all(e.owner != "aivc_testplug_c" for k in hooks.KINDS for e in hooks.entries(k, load=False))
    assert hooks.content_note() == "plugin aivc_testplug_f note {version}"
    assert set(plugins.failures()) == {"aivc_testplug_c", "aivc_testplug_d", "aivc_testplug_e", "aivc_testplug_missing"}
    # 核心的 op 一支都沒少
    assert CORE_OPS <= set(REGISTRY)
    # 失敗的不重試（不會每次查詢都再炸一次、再記一筆）
    assert plugins.load_plugin("aivc_testplug_c") is None and len(LOAD_ERRORS) == before + 4


def test_doctor_lists_plugins_but_a_broken_one_does_not_fail_the_gate(sandbox: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`aivc doctor`（安裝腳本的閘門）列出外掛與載入失敗的外掛，但不進 problems、不改 exit code：壞外掛不能拖垮核心。"""
    from aivc import doctor as D
    from aivc.ops import doctor as OD

    _write(sandbox, "aivc_testplug_h", GOOD)
    _write(sandbox, "aivc_testplug_i", BROKEN_REGISTER)
    monkeypatch.setenv(plugins.ENV_PLUGINS, "aivc_testplug_h,aivc_testplug_i")
    monkeypatch.setattr(D, "run", lambda quick=False: D.DoctorReport())
    d = OD.doctor_op({"quick": True}, None)  # type: ignore[arg-type]
    assert d["ok"] is True and d["_exit_code"] == 0 and d["problems"] == []
    assert d["plugins"]["loaded"] == [{"name": "aivc_testplug_h", "module": "aivc_testplug_h", "version": "1.2.3", "source": "env"}]
    assert set(d["plugins"]["failed"]) == {"aivc_testplug_i"} and "register 半途炸了" in d["plugins"]["failed"]["aivc_testplug_i"]
    assert "外掛  aivc_testplug_h 1.2.3" in d["_human"] and "register 半途炸了" in d["_human"]


def test_safe_mode_skips_discovery(sandbox: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write(sandbox, "aivc_testplug_g", GOOD)
    monkeypatch.setenv(plugins.ENV_PLUGINS, "aivc_testplug_g")
    monkeypatch.setenv(plugins.ENV_NO_PLUGINS, "1")
    assert plugins.ensure_loaded() == [] and "test.aivc_testplug_g.echo" not in REGISTRY


def test_hooks_suspended_restores_and_remove_owner() -> None:
    sentinel = object()
    with hooks.suspended():
        hooks.add("insert-source", sentinel, owner="test-x")
        assert hooks.insert_sources() == [sentinel]
        with hooks.suspended("test-x"):
            assert hooks.insert_sources() == []
        assert hooks.insert_sources() == [sentinel]
        assert hooks.remove_owner("test-x") == 1 and hooks.insert_sources() == []
    assert sentinel not in hooks.insert_sources()
    with pytest.raises(ValueError):
        hooks.add("no-such-kind", 1, owner="x")


def _clean_env(**extra: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in ("AIVC_PLUGINS", "AIVC_NO_PLUGINS", "AIVC_EXTRA_OPS", "AIVC_RUN_GPU_TESTS")}
    env["PYTHONPATH"] = str(ENGINE / "src")
    env["PYTHONUTF8"] = "1"
    env.update(extra)
    return env


def test_cli_help_without_plugins_has_no_card_commands() -> None:
    """開源版的樣子：`aivc --help` 沒有任何牌局子命令（安全模式＝不管這台機器裝了什麼外掛）。"""
    p = subprocess.run([sys.executable, "-X", "utf8", "-m", "aivc", "--help"], cwd=str(ENGINE), env=_clean_env(AIVC_NO_PLUGINS="1"), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120, check=False)
    assert p.returncode == 0, p.stderr
    listed = {line.split()[0] for line in p.stdout.splitlines() if line.startswith("    ") and line.split() and not line.startswith("     ")}
    assert {"render", "render-plan", "track", "seg", "seq", "probe", "serve", "preview-composite"} <= listed, listed
    assert not (listed & CARD_COMMANDS), listed & CARD_COMMANDS


def test_serve_hello_reports_plugins_and_load_errors(tmp_path: Path) -> None:
    """壞外掛 → hello.loadErrors 有它、hello.plugins 沒有它，核心 op 照常回應（不是「未知 op」）。"""
    (tmp_path / "aivc_testplug_broken.py").write_text("def register(host):\n    raise RuntimeError('故意壞掉')\n", encoding="utf-8")
    env = _clean_env(AIVC_PLUGINS="aivc_testplug_broken")
    env["PYTHONPATH"] = os.pathsep.join([str(tmp_path), str(ENGINE / "src")])
    import threading

    proc = subprocess.Popen([sys.executable, "-X", "utf8", "-m", "aivc", "serve", "--no-torch-probe"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=str(ENGINE), env=env)
    replies: dict[str, Any] = {}
    err_lines: list[str] = []
    done = threading.Event()

    def pump_out() -> None:
        assert proc.stdout is not None
        for raw in proc.stdout:
            m = json.loads(raw.decode("utf-8"))
            if "ok" in m:
                replies[m["id"]] = m
            if {"h", "s"} <= set(replies):
                done.set()

    def pump_err() -> None:  # Windows 管線 64 KB：stderr 一定要有人讀
        assert proc.stderr is not None
        for raw in proc.stderr:
            err_lines.append(raw.decode("utf-8", "replace"))

    threading.Thread(target=pump_out, daemon=True).start()
    threading.Thread(target=pump_err, daemon=True).start()
    try:
        assert proc.stdin is not None
        for m in ({"id": "h", "op": "hello", "args": {"torch": False}}, {"id": "s", "op": "sequence.show", "args": {}}):
            proc.stdin.write((json.dumps(m) + "\n").encode("utf-8"))
        proc.stdin.flush()
        assert done.wait(120), replies
        proc.stdin.close()  # EOF → sidecar 自己收
        proc.wait(timeout=60)
    finally:
        if proc.poll() is None:
            proc.kill()
    err = "".join(err_lines).encode("utf-8")
    hello = replies["h"]["result"]
    assert hello["plugins"] == [] and any("aivc_testplug_broken" in e and "故意壞掉" in e for e in hello["loadErrors"]), hello
    s = replies["s"]
    assert s["ok"] is False and s["error"]["kind"] == "Invalid" and "未知 op" not in s["error"]["message"], s
    assert "aivc_testplug_broken" in err.decode("utf-8", "replace")  # stderr 也記一筆（serve 逐筆 warn）
