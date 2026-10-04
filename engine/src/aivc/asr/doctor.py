"""env.doctor 的 asr 區段（**非阻斷**：語音辨識是選配功能，缺了不能讓整個引擎閘門失敗）。

回報 faster-whisper／CTranslate2 版本、CUDA 裝置數、cuBLAS 12 能不能載入、CUDA 支援的 compute types。
「能不能載入」要真的 LoadLibrary 一次：find_spec 找得到 wheel 不代表 DLL 相依都齊（CUDA 13 驅動跑 cuBLAS 12.9 是實測可以的）。
"""
from __future__ import annotations

import importlib.util
import sys
from typing import Any


def asr_section(probe_cuda: bool = True) -> dict[str, Any]:
    """probe_cuda=False 只查套件版本（importlib.metadata，不 import ctranslate2、不載 DLL）：給 `doctor --quick`，閘門要快。"""
    out: dict[str, Any] = {"fasterWhisper": None, "ctranslate2": None, "opencc": None, "cudaDevices": 0, "cublas12": None, "cudaComputeTypes": [], "notes": []}
    try:
        from importlib.metadata import version

        for key, dist in (("fasterWhisper", "faster-whisper"), ("ctranslate2", "ctranslate2"), ("opencc", "opencc")):
            try:
                out[key] = version(dist)
            except Exception:  # noqa: BLE001
                out[key] = None
    except Exception:  # noqa: BLE001
        pass
    if out["fasterWhisper"] is None or out["ctranslate2"] is None:
        out["notes"].append("沒有安裝 faster-whisper / ctranslate2：字幕產生不可用（重新安裝引擎依賴）")
        return out
    if not probe_cuda:
        out["cudaDevices"] = None
        return out
    from .cuda_dll import cublas_bin_dirs, ensure_cuda_dll_path

    ensure_cuda_dll_path()
    if sys.platform == "win32":
        import ctypes

        dirs = cublas_bin_dirs()
        try:
            ctypes.WinDLL("cublas64_12.dll")
            out["cublas12"] = True
        except OSError as e:
            out["cublas12"] = False
            out["notes"].append(f"cublas64_12.dll 無法載入（{e}）；GPU 轉錄會退回 CPU int8" + ("" if dirs else "：沒有安裝 nvidia-cublas-cu12"))
    elif importlib.util.find_spec("nvidia.cublas") is None:
        out["notes"].append("Linux 需要系統層級 libcublas.so.12（或在啟動前設定 LD_LIBRARY_PATH）才能用 GPU")
    try:
        import ctranslate2

        out["cudaDevices"] = int(ctranslate2.get_cuda_device_count())
        if out["cudaDevices"]:
            out["cudaComputeTypes"] = sorted(ctranslate2.get_supported_compute_types("cuda"))
    except Exception as e:  # noqa: BLE001
        out["notes"].append(f"ctranslate2 CUDA 查詢失敗：{type(e).__name__}: {e}")
    return out
