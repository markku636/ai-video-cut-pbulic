"""env.cache_root() / env.data_root() 的預設必須等於 Tauri 的 app_cache_dir() / app_local_data_dir()（三個平台）。

App 啟動引擎時設 AIVC_CACHE_DIR = app_cache_dir()（Windows = %LOCALAPPDATA%\\net.markkulab.aivideocut）；
CLI 沒設時若落在別處（舊版是 data_root()/cache），CLI 做過的 proxy / 遮罩 App 看不到、整段重算。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from aivc import env

FP = "d171ec9031ba677f" + "0" * 48


@pytest.fixture
def clean_env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    for k in ("AIVC_CACHE_DIR", "AIVC_DATA_ROOT", "XDG_CACHE_HOME"):
        monkeypatch.delenv(k, raising=False)
    return monkeypatch


def test_windows_default_equals_app_cache_dir(clean_env: pytest.MonkeyPatch, tmp_path: Path) -> None:
    lad = tmp_path / "Local"
    clean_env.setattr(env.sys, "platform", "win32")
    clean_env.setenv("LOCALAPPDATA", str(lad))
    assert env.cache_root() == lad / "net.markkulab.aivideocut"
    # App 的實際版面：%LOCALAPPDATA%\net.markkulab.aivideocut\media\<fp16>
    assert env.media_cache_dir(FP) == lad / "net.markkulab.aivideocut" / "media" / "d171ec9031ba677f"
    # Windows 上 app_cache_dir 與 app_local_data_dir 同一層（media/ 和 pyenv/ 並排），不是 data_root/cache
    assert env.cache_root() == env.data_root()
    assert env.cache_root() != env.data_root() / "cache"


def test_moved_data_root_does_not_move_cache(clean_env: pytest.MonkeyPatch, tmp_path: Path) -> None:
    lad = tmp_path / "Local"
    clean_env.setattr(env.sys, "platform", "win32")
    clean_env.setenv("LOCALAPPDATA", str(lad))
    clean_env.setenv("AIVC_DATA_ROOT", str(tmp_path / "moved"))
    assert env.data_root() == tmp_path / "moved"
    # Rust app_cache_dir() 不看 AIVC_DATA_ROOT；CLI 預設也不能跟著搬
    assert env.cache_root() == lad / "net.markkulab.aivideocut"


def test_windows_without_localappdata_falls_back_like_data_root(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setattr(env.sys, "platform", "win32")
    clean_env.delenv("LOCALAPPDATA", raising=False)
    assert env.cache_root() == Path.home() / "AppData" / "Local" / "net.markkulab.aivideocut"


def test_cache_dir_override_wins(clean_env: pytest.MonkeyPatch, tmp_path: Path) -> None:
    clean_env.setattr(env.sys, "platform", "win32")
    clean_env.setenv("LOCALAPPDATA", str(tmp_path / "Local"))
    clean_env.setenv("AIVC_DATA_ROOT", str(tmp_path / "moved"))
    clean_env.setenv("AIVC_CACHE_DIR", str(tmp_path / "custom cache"))
    assert env.cache_root() == tmp_path / "custom cache"
    assert env.media_cache_dir(FP) == tmp_path / "custom cache" / "media" / "d171ec9031ba677f"


def test_macos_uses_library_caches(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setattr(env.sys, "platform", "darwin")
    assert env.cache_root() == Path.home() / "Library" / "Caches" / "net.markkulab.aivideocut"


def test_linux_uses_xdg_cache_home_then_dot_cache(clean_env: pytest.MonkeyPatch, tmp_path: Path) -> None:
    clean_env.setattr(env.sys, "platform", "linux")
    assert env.cache_root() == Path.home() / ".cache" / "net.markkulab.aivideocut"
    clean_env.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg"))
    assert env.cache_root() == tmp_path / "xdg" / "net.markkulab.aivideocut"
    # 相對路徑不合 XDG 規格 → 忽略
    clean_env.setenv("XDG_CACHE_HOME", "relative/cache")
    assert env.cache_root() == Path.home() / ".cache" / "net.markkulab.aivideocut"


# ---- data_root()：必須等於 Tauri app_local_data_dir()（bootstrap 腳本把 venv / 模型裝在那裡）----
@pytest.fixture
def clean_data_env(clean_env: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    clean_env.delenv("XDG_DATA_HOME", raising=False)
    return clean_env


def test_data_root_windows_unchanged(clean_data_env: pytest.MonkeyPatch, tmp_path: Path) -> None:
    clean_data_env.setattr(env.sys, "platform", "win32")
    clean_data_env.setenv("LOCALAPPDATA", str(tmp_path / "Local"))
    assert env.data_root() == tmp_path / "Local" / "net.markkulab.aivideocut"
    clean_data_env.delenv("LOCALAPPDATA")
    assert env.data_root() == Path.home() / "AppData" / "Local" / "net.markkulab.aivideocut"


def test_data_root_macos_uses_application_support(clean_data_env: pytest.MonkeyPatch, tmp_path: Path) -> None:
    clean_data_env.setattr(env.sys, "platform", "darwin")
    # LOCALAPPDATA 就算存在（例如從 Windows 帶過來的殼環境）也不能影響 macOS
    clean_data_env.setenv("LOCALAPPDATA", str(tmp_path / "Local"))
    assert env.data_root() == Path.home() / "Library" / "Application Support" / "net.markkulab.aivideocut"
    # macOS 上資料根與快取根分開（Application Support vs Caches），和 Tauri 一致
    assert env.cache_root() != env.data_root()


def test_data_root_linux_uses_xdg_data_home_then_local_share(clean_data_env: pytest.MonkeyPatch, tmp_path: Path) -> None:
    clean_data_env.setattr(env.sys, "platform", "linux")
    assert env.data_root() == Path.home() / ".local" / "share" / "net.markkulab.aivideocut"
    clean_data_env.setenv("XDG_DATA_HOME", str(tmp_path / "xdg-data"))
    assert env.data_root() == tmp_path / "xdg-data" / "net.markkulab.aivideocut"
    clean_data_env.setenv("XDG_DATA_HOME", "relative/data")
    assert env.data_root() == Path.home() / ".local" / "share" / "net.markkulab.aivideocut"


def test_data_root_override_wins_on_every_os(clean_data_env: pytest.MonkeyPatch, tmp_path: Path) -> None:
    clean_data_env.setenv("AIVC_DATA_ROOT", str(tmp_path / "moved root"))
    for plat in ("win32", "darwin", "linux"):
        clean_data_env.setattr(env.sys, "platform", plat)
        assert env.data_root() == tmp_path / "moved root"


def test_apply_model_env_sets_mps_fallback_only_on_macos(clean_data_env: pytest.MonkeyPatch, tmp_path: Path) -> None:
    import os

    clean_data_env.setenv("AIVC_DATA_ROOT", str(tmp_path / "root"))
    for k in ("HF_HOME", "TORCH_HOME"):
        clean_data_env.setenv(k, "x")
        clean_data_env.delenv(k)
    clean_data_env.setenv("PYTORCH_ENABLE_MPS_FALLBACK", "x")
    clean_data_env.delenv("PYTORCH_ENABLE_MPS_FALLBACK")
    clean_data_env.setattr(env.sys, "platform", "linux")
    env.apply_model_env()
    assert "PYTORCH_ENABLE_MPS_FALLBACK" not in os.environ
    assert os.environ["HF_HOME"] == str(tmp_path / "root" / "models" / "hf")
    clean_data_env.setattr(env.sys, "platform", "darwin")
    env.apply_model_env()
    assert os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] == "1"


# ---- ffmpeg_dir()：ffmpeg 與 ffprobe 必須同目錄；PATH 找不到再看 Homebrew / Linux 常見位置 ----
def _fake_ffmpeg_dir(d: Path, *, probe: bool = True) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    (d / env._exe("ffmpeg")).write_bytes(b"")
    if probe:
        (d / env._exe("ffprobe")).write_bytes(b"")
    return d


def test_ffmpeg_override_requires_ffprobe(clean_env: pytest.MonkeyPatch, tmp_path: Path) -> None:
    clean_env.setattr(env, "_BUNDLED_FFMPEG_DIRS", ())
    clean_env.setattr(env.shutil, "which", lambda _n: None)
    clean_env.setattr(env, "_common_ffmpeg_dirs", lambda: [])
    only_ffmpeg = _fake_ffmpeg_dir(tmp_path / "only", probe=False)
    clean_env.setenv("AIVC_FFMPEG_DIR", str(only_ffmpeg))
    assert env.ffmpeg_dir() is None
    both = _fake_ffmpeg_dir(tmp_path / "both")
    clean_env.setenv("AIVC_FFMPEG_DIR", str(both))
    assert env.ffmpeg_dir() == both


def test_ffmpeg_common_dirs_after_path(clean_env: pytest.MonkeyPatch, tmp_path: Path) -> None:
    clean_env.delenv("AIVC_FFMPEG_DIR", raising=False)
    clean_env.setattr(env, "_BUNDLED_FFMPEG_DIRS", ())
    clean_env.setattr(env.shutil, "which", lambda _n: None)  # Finder 啟動的 App：PATH 沒有 Homebrew
    half = _fake_ffmpeg_dir(tmp_path / "half", probe=False)
    brew = _fake_ffmpeg_dir(tmp_path / "brew")
    clean_env.setattr(env, "_common_ffmpeg_dirs", lambda: [tmp_path / "missing", half, brew])
    assert env.ffmpeg_dir() == brew


def test_ffmpeg_common_dirs_per_os(clean_env: pytest.MonkeyPatch) -> None:
    clean_env.setattr(env.sys, "platform", "win32")
    assert env._common_ffmpeg_dirs() == []
    clean_env.setattr(env.sys, "platform", "darwin")
    dirs = env._common_ffmpeg_dirs()
    assert Path("/opt/homebrew/bin") in dirs and Path("/opt/homebrew/opt/ffmpeg-full/bin") in dirs
    clean_env.setattr(env.sys, "platform", "linux")
    assert Path("/home/linuxbrew/.linuxbrew/bin") in env._common_ffmpeg_dirs()
    assert "apt install ffmpeg" in env.ffmpeg_install_hint()
    clean_env.setattr(env.sys, "platform", "darwin")
    assert "brew install ffmpeg" in env.ffmpeg_install_hint()
