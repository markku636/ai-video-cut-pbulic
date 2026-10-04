"""B-12：測試裡用到的自訂 marker 一定要登記在 pyproject.toml。

沒登記的 marker 只會噴一行 PytestUnknownMarkWarning、測試照樣綠 —— 於是警告永遠在，真正重要的警告
就淹在裡面。2026-09-17 的稽核抓到的就是 `@pytest.mark.slow`（tests/test_media_color.py）。
"""
from __future__ import annotations

import re
import tomllib
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1]
TESTS = ENGINE / "tests"
# pytest 內建的 marker：不必（也不能）登記
BUILTIN = {"parametrize", "skip", "skipif", "xfail", "usefixtures", "filterwarnings", "timeout"}
MARK_RE = re.compile(r"@pytest\.mark\.([A-Za-z_][A-Za-z_0-9]*)")


def registered_markers() -> set[str]:
    cfg = tomllib.loads((ENGINE / "pyproject.toml").read_text(encoding="utf-8"))
    entries = cfg["tool"]["pytest"]["ini_options"]["markers"]
    return {e.split(":", 1)[0].strip() for e in entries}


def used_markers() -> dict[str, list[str]]:
    used: dict[str, list[str]] = {}
    for p in sorted(TESTS.rglob("*.py")):
        if p.name == Path(__file__).name:
            continue  # 這個檔自己的 docstring 裡就有 @pytest.mark.slow，不要把自己算進去
        for name in MARK_RE.findall(p.read_text(encoding="utf-8")):
            if name in BUILTIN:
                continue
            used.setdefault(name, []).append(p.name)
    return used


def test_every_custom_marker_is_registered() -> None:
    used = used_markers()
    missing = {k: sorted(set(v)) for k, v in used.items() if k not in registered_markers()}
    assert not missing, f"這些 marker 沒登記在 pyproject.toml 的 [tool.pytest.ini_options] markers：{missing}"


def test_the_markers_we_rely_on_are_actually_used() -> None:
    """反過來也擋一下：登記了卻沒人用的 marker 是死設定（gpu 由 conftest 的 skip 邏輯在用）。"""
    used = set(used_markers())
    assert {"gpu", "slow"} <= used, f"預期用得到的 marker 不見了：{used}"
