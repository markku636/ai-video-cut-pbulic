"""環境：資料目錄、AIVC_* 環境變數、HF/TORCH 快取位置、ffmpeg 解析。

一律在 import torch / transformers **之前** import 這個模組，因為 HF_HOME / TORCH_HOME
（以及 macOS 的 PYTORCH_ENABLE_MPS_FALLBACK）必須在那些套件讀取環境變數前設好；
否則模型會落在家目錄的 .cache（Windows 是 %USERPROFILE%\\.cache），解除安裝找不到。
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

APP_ID = "net.markkulab.aivideocut"
ENV_PREFIX = "AIVC_"


def data_root() -> Path:
    """App 資料根（venv / models / logs）。Rust 端對應 Tauri `app_local_data_dir()`。

    預設必須和 App 算出來的完全同一個目錄：bootstrap 腳本把 venv 與模型裝在那裡，
    CLI 與 App 啟動的引擎若各自落在不同位置，模型會下載兩份、App 也找不到 CLI 裝好的 venv。
    """
    override = os.environ.get(ENV_PREFIX + "DATA_ROOT")
    if override:
        return Path(override)
    return _os_data_local_base() / APP_ID


def _os_data_local_base() -> Path:
    """Tauri `app_local_data_dir()` = `dirs::data_local_dir()/<identifier>` 的 Python 版（不含 identifier）。

    Windows 是 LocalAppData（環境變數不在時退回 `~/AppData/Local`，維持舊行為）；
    macOS 是 `~/Library/Application Support`（dirs crate 的 data_local_dir 與 data_dir 在 macOS 相同）；
    其他（Linux）是 `$XDG_DATA_HOME` 或 `~/.local/share`。以前三個平台都用 `~/AppData/Local`，
    在 macOS / Linux 上會和 App 的資料根對不上。
    """
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local"))
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support"
    xdg = os.environ.get("XDG_DATA_HOME")
    # XDG 規格：相對路徑視為無效（dirs crate 同樣忽略），退回 ~/.local/share
    if xdg and os.path.isabs(xdg):
        return Path(xdg)
    return Path.home() / ".local" / "share"


def cache_root() -> Path:
    """衍生資料快取根；引擎自己在下面接 media/<fp16>/。Rust 端對應 app_cache_dir()。

    App 一律傳 AIVC_CACHE_DIR = Tauri `app_cache_dir()`；沒傳（CLI / 腳本直接跑）時的預設必須是
    **同一個目錄**，否則 CLI 算好的 proxy / 索引 / 遮罩 App 看不到、整段重算。以前預設是
    `data_root()/cache`，和 App 的 `%LOCALAPPDATA%\\net.markkulab.aivideocut` 差一層，兩邊各算一份。
    也不能跟著 AIVC_DATA_ROOT 走：Rust 端 app_cache_dir() 不管資料根搬到哪都不變。
    """
    override = os.environ.get(ENV_PREFIX + "CACHE_DIR")
    if override:
        return Path(override)
    return _os_cache_base() / APP_ID


def _os_cache_base() -> Path:
    """Tauri `app_cache_dir()` = `dirs::cache_dir()/<identifier>` 的 Python 版（不含 identifier）。

    Windows 是 LocalAppData（和 app_local_data_dir 同一層，所以 media/ 與 pyenv/ 並排），
    fallback 沿用 data_root() 的 `~/AppData/Local`；macOS 是 `~/Library/Caches`；
    其他（Linux）是 `$XDG_CACHE_HOME` 或 `~/.cache`。
    """
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local"))
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches"
    xdg = os.environ.get("XDG_CACHE_HOME")
    # XDG 規格：相對路徑視為無效（dirs crate 同樣忽略），退回 ~/.cache
    if xdg and os.path.isabs(xdg):
        return Path(xdg)
    return Path.home() / ".cache"


def media_cache_dir(fingerprint: str) -> Path:
    return cache_root() / "media" / fingerprint[:16]


def apply_model_env() -> None:
    """把 HF_HOME / TORCH_HOME 指進 App 資料目錄（若使用者沒自己設）。"""
    models = data_root() / "models"
    os.environ.setdefault("HF_HOME", str(models / "hf"))
    os.environ.setdefault("TORCH_HOME", str(models / "torch"))
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("CUDA_MODULE_LOADING", "LAZY")
    os.environ.setdefault("PYTHONUTF8", "1")
    if sys.platform == "darwin":
        # MPS 缺 kernel 的個別運算退回 CPU 算，而不是整個 forward 擲 NotImplementedError；
        # torch 在 import 時讀這個變數，所以只能在這裡（import torch 之前）設。見 aivc.device 的 dtype 退路說明。
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")


def normalize_path(p: str | os.PathLike[str]) -> str:
    """去掉 Windows 的 \\\\?\\ verbatim 前綴（ffmpeg 與 Tauri asset protocol 都吃不下）。"""
    s = os.fspath(p)
    if s.startswith("\\\\?\\UNC\\"):
        return "\\\\" + s[8:]
    if s.startswith("\\\\?\\"):
        return s[4:]
    return s


_BUNDLED_FFMPEG_DIRS = (
    # dev：repo 內 ai-music-cut 已下載的內建 ffmpeg；正式：App resources/ffmpeg
    Path(__file__).resolve().parents[3] / "src-tauri" / "resources" / "ffmpeg",
    Path(__file__).resolve().parents[4] / "ai-music-cut" / "src-tauri" / "resources" / "ffmpeg",
)


def _common_ffmpeg_dirs() -> list[Path]:
    """PATH 找不到時再看的常見安裝目錄（macOS / Linux；Windows 版內建 ffmpeg，不需要）。

    為什麼 PATH 不夠：從 Finder / Dock 開的 App 只繼承 launchd 的精簡 PATH（/usr/bin:/bin:/usr/sbin:/sbin），
    沒有 Homebrew 的 /opt/homebrew/bin；CLI 在終端機跑雖然有，但引擎要兩種啟動方式結果一致。
    `ffmpeg-full` 是 Homebrew 的 keg-only formula，不會連到 bin/，要看它自己的 opt 目錄。
    清單與 Rust 端 ffmpeg.rs 的 common_dirs 對齊。
    """
    if sys.platform == "win32":
        return []
    home = Path.home()
    return [
        Path("/opt/homebrew/bin"),
        Path("/opt/homebrew/opt/ffmpeg-full/bin"),
        Path("/usr/local/bin"),
        Path("/usr/local/opt/ffmpeg-full/bin"),
        Path("/home/linuxbrew/.linuxbrew/bin"),
        home / ".linuxbrew" / "bin",
        Path("/opt/local/bin"),  # MacPorts
        Path("/usr/bin"),
        home / ".local" / "bin",
    ]


def _has_ffmpeg_pair(d: Path) -> bool:
    return (d / _exe("ffmpeg")).is_file() and (d / _exe("ffprobe")).is_file()


def ffmpeg_dir() -> Path | None:
    """解析 ffmpeg 目錄：AIVC_FFMPEG_DIR → 內建 resources → PATH → 常見安裝目錄。

    每一層都要求 ffmpeg 與 ffprobe 在同一目錄（和 Rust 端 sibling_probe 同規則）：
    只有 ffmpeg 的目錄被選中，之後 ffmpeg_bin("ffprobe") 會回一個不存在的路徑、錯在很遠的地方。
    """
    override = os.environ.get(ENV_PREFIX + "FFMPEG_DIR")
    if override and _has_ffmpeg_pair(Path(override)):
        return Path(override)
    for d in _BUNDLED_FFMPEG_DIRS:
        if _has_ffmpeg_pair(d):
            return d
    found = shutil.which("ffmpeg")
    if found:
        d = Path(found).parent
        if (d / _exe("ffprobe")).is_file():
            return d
    for d in _common_ffmpeg_dirs():
        if _has_ffmpeg_pair(d):
            return d
    return None


def ffmpeg_install_hint() -> str:
    """找不到 ffmpeg 時給使用者的下一步（依平台）。"""
    if sys.platform == "darwin":
        return "macOS 請用 Homebrew 安裝：brew install ffmpeg（或設定 AIVC_FFMPEG_DIR）"
    if sys.platform == "win32":
        return "設定 AIVC_FFMPEG_DIR 或安裝到 PATH"
    return "Linux 請用套件管理員安裝：sudo apt install ffmpeg（Fedora：先啟用 RPM Fusion 再 sudo dnf install ffmpeg，官方庫的 ffmpeg-free 沒有 libx264）；或設定 AIVC_FFMPEG_DIR"


def ffmpeg_bin(name: str) -> str:
    d = ffmpeg_dir()
    if d is None:
        raise FileNotFoundError(f"找不到 ffmpeg/ffprobe：{ffmpeg_install_hint()}")
    return str(d / _exe(name))


def _exe(name: str) -> str:
    return f"{name}.exe" if sys.platform == "win32" else name


def ensure_utf8_stdio() -> None:
    """Windows 上 python 寫管線預設 cp950；sidecar 的 JSONL 必須是 UTF-8。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass
