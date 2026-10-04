"""wheel 內容對帳：aivc 底下每一個非 .py 的檔案都必須真的進 wheel，而且從 wheel 解出來的套件讀得到。

為什麼要真的建 wheel：開發與 CI 都是 editable 安裝（直接讀 engine/src），資料檔漏打包在那裡永遠看不出來；
安裝檔帶的是 `node scripts/build-engine-wheel.mjs`（uv build）產的 wheel —— 2026-09-17 驗證者就是這樣抓到
presets.v1.json 沒進 wheel、安裝版一開有字幕的專案就 FileNotFoundError。

建置方式（依序）：uv（跟 build-engine-wheel.mjs 同一支；AIVC_UV → %LOCALAPPDATA% 的 bootstrap 版本 → PATH）→
目前 Python 裡的 setuptools PEP 517 後端（≥ 70.1 自帶 bdist_wheel，不需要網路）→ 兩者都沒有就 skip。
原始碼先複製到暫存目錄再建：setuptools 會在專案目錄寫 build/ 與 *.egg-info，不能弄髒工作樹。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

ENGINE = Path(__file__).resolve().parents[1]
PKG = ENGINE / "src" / "aivc"
# 這些不是資料檔：位元組碼快取、編輯器／建置殘留
_NOT_DATA_SUFFIXES = {".py", ".pyc", ".pyo", ".pyd"}
# 看到這些字樣就是「沒有網路抓不到建置後端」，不是打包設定錯：離線開發機 skip，不要紅燈
_OFFLINE_MARKERS = ("failed to fetch", "dns error", "error sending request", "network", "offline", "connection", "timed out")


def package_data_files() -> list[str]:
    """aivc 底下所有非 .py 的檔案（wheel 內路徑，例如 `aivc/captions/presets.v1.json`）。"""
    out: list[str] = []
    for p in PKG.rglob("*"):
        if not p.is_file() or "__pycache__" in p.parts or p.suffix.lower() in _NOT_DATA_SUFFIXES:
            continue
        if any(part.endswith(".egg-info") for part in p.parts):
            continue
        out.append(p.relative_to(PKG.parent).as_posix())
    return sorted(out)


def _find_uv() -> str | None:
    cands = [os.environ.get("AIVC_UV")]
    local = os.environ.get("LOCALAPPDATA")
    if local:
        cands.append(str(Path(local) / "net.markkulab.aivideocut" / "tools" / "uv" / ("uv.exe" if sys.platform == "win32" else "uv")))
    cands.append(shutil.which("uv"))
    for c in cands:
        if c and Path(c).is_file():
            return c
    return None


def _setuptools_can_build() -> bool:
    try:
        import setuptools
    except ImportError:
        return False
    try:
        major, minor = (int(x) for x in setuptools.__version__.split(".")[:2])
    except ValueError:
        return False
    return (major, minor) >= (70, 1)


def _copy_engine(dst: Path) -> Path:
    root = dst / "engine"
    root.mkdir(parents=True)
    for name in ("pyproject.toml", "README.md"):
        shutil.copy2(ENGINE / name, root / name)
    shutil.copytree(ENGINE / "src", root / "src", ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.egg-info", "build", "dist"))
    return root


def _build_wheel(tmp: Path) -> Path:
    src = _copy_engine(tmp)
    out = tmp / "dist"
    out.mkdir()
    uv = _find_uv()
    if uv is not None:
        # --python 用目前的直譯器：不讓 uv 另外下載 Python；建置後端（setuptools/wheel）照 pyproject 的 build-system 隔離安裝
        p = subprocess.run([uv, "build", "--wheel", "--out-dir", str(out), "--python", sys.executable, str(src)], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600, check=False)
        if p.returncode != 0:
            log = (p.stdout + p.stderr).lower()
            if any(m in log for m in _OFFLINE_MARKERS) and not _setuptools_can_build():
                pytest.skip(f"uv build 抓不到建置後端（離線？）：{p.stderr.strip()[-300:]}")
            if not _setuptools_can_build():
                raise AssertionError(f"uv build 失敗（exit {p.returncode}）：\n{p.stdout}\n{p.stderr}")
        else:
            wheels = sorted(out.glob("aivc-*.whl"))
            assert len(wheels) == 1, f"uv build 應該正好產出一個 aivc wheel：{[w.name for w in out.iterdir()]}"
            return wheels[0]
    if not _setuptools_can_build():
        pytest.skip("沒有 uv，目前的 Python 也沒有 setuptools ≥ 70.1：無法建 wheel")
    code = "import sys, setuptools.build_meta as b; print(b.build_wheel(sys.argv[1]))"
    p = subprocess.run([sys.executable, "-c", code, str(out)], cwd=str(src), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600, check=False)
    assert p.returncode == 0, f"setuptools build_wheel 失敗：\n{p.stdout}\n{p.stderr}"
    wheels = sorted(out.glob("aivc-*.whl"))
    assert len(wheels) == 1, f"build_wheel 應該正好產出一個 aivc wheel：{[w.name for w in out.iterdir()]}"
    return wheels[0]


def test_package_data_scan_finds_presets() -> None:
    """掃描本身要看得到已知的資料檔，否則下面的對帳是空轉。"""
    files = package_data_files()
    assert "aivc/captions/presets.v1.json" in files
    # 目前唯一的非 .py 檔就是它；新增其他副檔名時記得同步 pyproject 的 package-data（這條會提醒）
    unexpected = [f for f in files if not f.endswith(".json")]
    assert not unexpected, f"aivc 裡有非 JSON 的資料檔，pyproject.toml [tool.setuptools.package-data] 要加對應的樣式：{unexpected}"


def test_wheel_ships_every_package_data_file(tmp_path: Path) -> None:
    whl = _build_wheel(tmp_path)
    with zipfile.ZipFile(whl) as z:
        names = set(z.namelist())
        missing = [f for f in package_data_files() if f not in names]
        assert not missing, f"這些檔案沒進 wheel（pyproject.toml [tool.setuptools.package-data]）：{missing}"
        # 內容也要跟原始碼一致（不是空檔或舊版）
        shipped = json.loads(z.read("aivc/captions/presets.v1.json").decode("utf-8"))
        assert shipped == json.loads((PKG / "captions" / "presets.v1.json").read_text(encoding="utf-8"))
        z.extractall(tmp_path / "site")
    # 從解開的 wheel 載入預設表：PYTHONPATH 只放 wheel 內容，確保讀的不是 engine/src
    code = (
        "import os, sys, aivc, aivc.captions.presets as P; "
        "site = os.path.normcase(os.path.abspath(sys.argv[1])); "
        "assert os.path.normcase(os.path.abspath(aivc.__file__)).startswith(site), aivc.__file__; "
        "print(sorted(P.presets()))"
    )
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    env["PYTHONPATH"] = str(tmp_path / "site")
    p = subprocess.run([sys.executable, "-c", code, str(tmp_path / "site")], cwd=str(tmp_path), env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120, check=False)
    assert p.returncode == 0, p.stderr
    assert "pop" in p.stdout and "subtitle" in p.stdout
