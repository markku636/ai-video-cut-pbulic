"""讓 CTranslate2 在 Windows 找得到 cuBLAS 12（研究規格 §1 量測）。

實測（RTX 5090、驅動 616.92、CUDA 13 驅動）：
- 不改 PATH：WhisperModel() 建構成功，第一次 encode 才炸 `Library cublas64_12.dll is not found or cannot be loaded`。
- 只用 os.add_dll_directory(<site-packages>/nvidia/cublas/bin)：同樣錯誤（CTranslate2 用 LoadLibrary 的預設搜尋順序，不看 DLL 目錄清單）。
- 在 import ctranslate2 **之前**把 nvidia/cublas/bin 放到行程 PATH 最前面：可以。cuDNN／nvrtc／CUDA runtime 的 wheel 都不需要
  （CTranslate2 wheel 自帶 cudnn64_9.dll）。
所以這裡兩個都做（add_dll_directory 無害），而且**冪等**：sidecar 常駐，每次轉錄都呼叫，PATH 不能越疊越長。
Linux 的 libcublas.so.12 要在行程啟動前進 LD_LIBRARY_PATH，行程內改不了 → 只回報，不處理（Linux 走 CPU 或文件說明）。
"""
from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path
from typing import Any, MutableMapping

_DLL_HANDLES: dict[str, Any] = {}


def cublas_bin_dirs() -> list[Path]:
    """nvidia-cublas-cu12 wheel 的 DLL 目錄（沒裝 → 空清單）。"""
    try:
        spec = importlib.util.find_spec("nvidia.cublas")
    except (ModuleNotFoundError, ValueError):
        return []
    if spec is None or not spec.submodule_search_locations:
        return []
    out = []
    for loc in spec.submodule_search_locations:
        for sub in ("bin", "lib"):
            d = Path(loc) / sub
            if d.is_dir():
                out.append(d)
    return out


def _norm(p: str) -> str:
    return os.path.normcase(os.path.normpath(p)) if p else ""


def ensure_cuda_dll_path(environ: MutableMapping[str, str] | None = None, dirs: list[Path] | None = None) -> list[str]:
    """把 cuBLAS 目錄前置到 PATH（已經在裡面就不動）。回傳這次**新加**的目錄。"""
    if sys.platform != "win32" and environ is None:
        return []
    env = os.environ if environ is None else environ
    cand = [str(d) for d in (cublas_bin_dirs() if dirs is None else dirs)]
    parts = [p for p in env.get("PATH", "").split(os.pathsep) if p]
    have = {_norm(p) for p in parts}
    added = [d for d in cand if _norm(d) not in have]
    if added:
        env["PATH"] = os.pathsep.join(added + parts)
    if environ is None and hasattr(os, "add_dll_directory"):
        for d in cand:
            if d not in _DLL_HANDLES:
                try:
                    _DLL_HANDLES[d] = os.add_dll_directory(d)  # 保留 handle：被 GC 會自動移除目錄
                except OSError:
                    pass
    return added
