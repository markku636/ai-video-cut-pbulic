"""推論裝置與精度的唯一決策點：CUDA → MPS（僅 macOS）→ CPU（僅 AIVC_ALLOW_CPU=1）。

為什麼集中在這裡：
- 以前 seg / doctor 各自寫死 "cuda" 與 bfloat16，macOS（Apple Silicon，MPS）完全跑不起來；判斷散在各處，
  一改就漏，所以「用哪個裝置、用哪個 dtype、GPU 記憶體怎麼量」只在這一個模組決定。
- 專案頭號風險是「安靜地用 CPU 跑」（PATH 上的 torch +cpu 版 import 全成功、SAM 以 0.2 fps 跑且不報錯），
  所以 CPU **不是**自動退路：沒有 GPU 就擲 `DeviceUnavailable`，除非明確設 `AIVC_ALLOW_CPU=1`（CI 的 CPU 測試用）。
  Rust 端（pyenv.rs 閘門）認的也是字面值 "1"，兩邊必須一致，所以這裡不接受 true/yes 之類的寫法。

dtype 規則（`preferred_dtype`）：
- cuda → bfloat16：Ampere 以上原生支援，sm_120 實測 GEMM 正常；維持 Windows 版一直以來的行為。
- mps  → float16：Metal 原生的半精度是 fp16；bf16 在 MPS 上較晚才補上、運算覆蓋面比 fp16 窄，Apple GPU 也沒有 bf16 的硬體優勢。
  碰到不支援或數值出問題時的退路（依序）：
  1. 個別運算 MPS 沒有 kernel → `env.apply_model_env()` 在 darwin 預設 `PYTORCH_ENABLE_MPS_FALLBACK=1`，
     只有那一個運算退回 CPU，其餘仍在 GPU（比整條退 CPU 快得多）。
  2. fp16 溢位出 NaN／運算不收 fp16 → `seg.sam2_hf` 偵測到後呼叫 `mark_mps_float16_unusable()`，
     同一個行程之後再載模型就改用 float32（引擎 sidecar 是長駐行程，使用者重試一次即可）。
  3. 想一開始就用 float32（例如已知某台機器 fp16 有問題）→ 設 `AIVC_MPS_DTYPE=float32`。
- cpu  → float32：CPU 上半精度矩陣乘法沒有比較快，且部分運算沒有半精度實作。

所有函式都可以傳入 `torch` 模組（測試用假物件注入）；不傳才真的 import torch，
而且 import 前一定先 `env.apply_model_env()`（HF_HOME / MPS fallback 必須在 torch 讀環境變數前設好）。
"""
from __future__ import annotations

import os
import platform
import subprocess
import sys
from typing import Any

ALLOW_CPU_ENV = "AIVC_ALLOW_CPU"
MPS_DTYPE_ENV = "AIVC_MPS_DTYPE"

BACKENDS = ("cuda", "mps", "cpu")

# mps fp16 是否已被判定不可用（同行程黏著；見模組說明的退路 2）
_MPS_FP16_BROKEN: str | None = None


class DeviceUnavailable(RuntimeError):
    """要求的（或預設的）推論裝置不可用。`hint` 是給使用者的下一步。"""

    def __init__(self, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.hint = hint


# ------------------------------------------------------------------ 基本探測
def allow_cpu() -> bool:
    return os.environ.get(ALLOW_CPU_ENV) == "1"


def _torch(torch_mod: Any | None) -> Any:
    if torch_mod is not None:
        return torch_mod
    from . import env

    env.apply_model_env()
    import torch  # noqa: WPS433

    return torch


def cuda_available(torch_mod: Any | None = None) -> bool:
    t = _torch(torch_mod)
    try:
        return bool(t.cuda.is_available())
    except Exception:  # noqa: BLE001
        return False


def mps_built(torch_mod: Any | None = None) -> bool:
    t = _torch(torch_mod)
    mps = getattr(getattr(t, "backends", None), "mps", None)
    try:
        return bool(mps is not None and mps.is_built())
    except Exception:  # noqa: BLE001
        return False


def mps_available(torch_mod: Any | None = None) -> bool:
    """只在 darwin 回 True：MPS 是 Apple Metal，其他平台就算 API 存在也沒有意義。"""
    if sys.platform != "darwin":
        return False
    t = _torch(torch_mod)
    mps = getattr(getattr(t, "backends", None), "mps", None)
    try:
        return bool(mps is not None and mps.is_available())
    except Exception:  # noqa: BLE001
        return False


def device_kind(device: str | None) -> str:
    """"cuda:1" → "cuda"；None / 空字串 → ""。"""
    return (device or "").split(":", 1)[0].strip().lower()


# ------------------------------------------------------------------ 純決策（可在任何主機上測）
def decide_backend(
    sys_platform: str,
    machine: str,
    *,
    cuda: bool,
    mps_is_built: bool,
    mps: bool,
    allow_cpu_flag: bool,
    torch_version: str | None = None,
) -> tuple[str | None, str | None]:
    """回傳 (backend, reason)。

    backend 為 "cuda" / "mps" / "cpu"，或 None（沒有可用的 GPU、也沒放行 CPU）。
    reason 是「為什麼沒有 GPU」的白話說明（有 GPU 時為 None）；backend 是 "cpu" 時也會帶，讓呼叫端印警告。
    """
    if cuda:
        return "cuda", None
    if sys_platform == "darwin" and mps:
        return "mps", None
    reason = _no_gpu_reason(sys_platform, machine, mps_is_built=mps_is_built, torch_version=torch_version)
    if allow_cpu_flag:
        return "cpu", reason
    return None, reason


def _no_gpu_reason(sys_platform: str, machine: str, *, mps_is_built: bool, torch_version: str | None) -> str:
    v = torch_version or "?"
    if sys_platform == "darwin":
        if machine.lower() not in ("arm64", "aarch64"):
            return (
                f"這台 Mac 的 Python 是 {machine}（Intel Mac，或在 Rosetta 轉譯下執行）："
                "本引擎的 GPU 加速（MPS）只支援 Apple Silicon（M1 以後），PyTorch 2.14 也沒有 Intel Mac 版本"
            )
        if not mps_is_built:
            return f"torch {v} 編譯時沒有 MPS 支援（torch.backends.mps.is_built() 為 False）：請重新安裝引擎，從 PyPI 裝 macOS 版 torch"
        return (
            "torch.backends.mps.is_available() 為 False：Apple GPU（MPS）不可用。"
            "需要 macOS 14 以上的 Apple Silicon Mac；在虛擬機裡通常沒有 Metal GPU"
        )
    if sys_platform in ("win32", "linux"):
        if torch_version and "+cu" not in torch_version:
            return (
                f"torch {v} 不是 CUDA 版，永遠不會用到 GPU（常見原因：用到 PATH 上全域 python 的 CPU 版 torch）；"
                "請重新安裝引擎（會從 cu130 index 裝 +cu130 版）"
            )
        return (
            "torch.cuda.is_available() 為 False：沒有偵測到可用的 NVIDIA GPU。"
            "確認有 NVIDIA 顯示卡、驅動版本 R580 以上（CUDA 13.0 需要）"
        )
    return f"不支援的平台 {sys_platform}：GPU 加速只支援 Windows / Linux（NVIDIA CUDA）與 macOS（Apple Silicon MPS）"


def _unavailable_hint(sys_platform: str) -> str:
    if sys_platform == "darwin":
        return "跑 `aivc doctor` 看 MPS 檢查結果；只想在 CPU 上測試才設 AIVC_ALLOW_CPU=1"
    return "跑 `aivc doctor` 檢查 venv 的 torch 是否為 +cu130；只想在 CPU 上測試才設 AIVC_ALLOW_CPU=1"


# ------------------------------------------------------------------ 選裝置
def select_device(torch_mod: Any | None = None) -> str:
    """自動選：cuda → mps（darwin）→ cpu（只在 AIVC_ALLOW_CPU=1）；都不行擲 DeviceUnavailable。"""
    t = _torch(torch_mod)
    backend, reason = decide_backend(
        sys.platform,
        platform.machine(),
        cuda=cuda_available(t),
        mps_is_built=mps_built(t),
        mps=mps_available(t),
        allow_cpu_flag=allow_cpu(),
        torch_version=getattr(t, "__version__", None),
    )
    if backend is None:
        raise DeviceUnavailable(reason or "沒有可用的 GPU", _unavailable_hint(sys.platform))
    return backend


def resolve_device(requested: str | None, torch_mod: Any | None = None) -> str:
    """把呼叫端要求的裝置字串變成實際可用的裝置；不可用就擲 DeviceUnavailable（絕不悄悄換成 CPU）。

    - None / "" / "auto" → `select_device()`。
    - "cuda" / "cuda:N" → 需要 CUDA。唯一例外：在 macOS 上要求**不帶編號的** "cuda" 且 MPS 可用 → "mps"。
      原因：ops（`aivc seg --device`、`aivc run --device`）歷來的預設值是字面 "cuda"，意思是「用 GPU」；
      macOS 上 CUDA 永遠不存在，那個要求不可能被滿足，換成 Mac 唯一的 GPU 不違反「不安靜退 CPU」的原則。
    - "mps" → 需要 darwin 且 MPS 可用。
    - "cpu" → 需要 AIVC_ALLOW_CPU=1。
    """
    t = _torch(torch_mod)
    kind = device_kind(requested)
    if kind in ("", "auto"):
        return select_device(t)
    hint = _unavailable_hint(sys.platform)
    if kind == "cuda":
        if cuda_available(t):
            return str(requested).strip()
        if sys.platform == "darwin" and str(requested).strip().lower() == "cuda" and mps_available(t):
            return "mps"
        _, reason = decide_backend(
            sys.platform,
            platform.machine(),
            cuda=False,
            mps_is_built=mps_built(t),
            mps=mps_available(t),
            allow_cpu_flag=False,
            torch_version=getattr(t, "__version__", None),
        )
        if sys.platform == "darwin":
            reason = "macOS 沒有 CUDA；" + (reason or "請改用 --device mps 或 auto")
        raise DeviceUnavailable(f"CUDA 不可用：{reason}", hint)
    if kind == "mps":
        if mps_available(t):
            return "mps"
        if sys.platform != "darwin":
            raise DeviceUnavailable(f"MPS 只存在於 macOS（目前平台 {sys.platform}）", hint)
        _, reason = decide_backend(
            sys.platform, platform.machine(), cuda=False, mps_is_built=mps_built(t), mps=False, allow_cpu_flag=False,
            torch_version=getattr(t, "__version__", None),
        )
        raise DeviceUnavailable(reason or "MPS 不可用", hint)
    if kind == "cpu":
        if allow_cpu():
            return "cpu"
        raise DeviceUnavailable(
            "拒絕在 CPU 上跑模型（會慢到不能用，而且以前出事都是『安靜地跑在 CPU』）",
            "只有 CI／除錯才設 AIVC_ALLOW_CPU=1；一般使用請讓它自動選 GPU（--device auto）",
        )
    raise DeviceUnavailable(f"未知的裝置 {requested!r}，可選 auto / cuda / mps / cpu", "")


# ------------------------------------------------------------------ 精度
def mark_mps_float16_unusable(reason: str) -> None:
    """MPS fp16 在這台機器上出事（NaN／運算不支援）：同行程之後改用 float32。"""
    global _MPS_FP16_BROKEN  # noqa: PLW0603
    _MPS_FP16_BROKEN = reason or "float16 不可用"


def reset_mps_float16_state() -> None:
    """測試用：清掉黏著的 fp16 失效狀態。"""
    global _MPS_FP16_BROKEN  # noqa: PLW0603
    _MPS_FP16_BROKEN = None


def mps_float16_broken() -> str | None:
    return _MPS_FP16_BROKEN


def preferred_dtype_name(device: str | None) -> str:
    """"bfloat16" / "float16" / "float32"（純字串版，給報告與測試用）。"""
    kind = device_kind(device)
    if kind == "cuda":
        return "bfloat16"
    if kind == "mps":
        forced = (os.environ.get(MPS_DTYPE_ENV) or "").strip().lower()
        if forced in ("float32", "fp32", "32"):
            return "float32"
        if _MPS_FP16_BROKEN is not None:
            return "float32"
        return "float16"
    return "float32"


def preferred_dtype(device: str | None, torch_mod: Any | None = None) -> Any:
    t = _torch(torch_mod)
    return getattr(t, preferred_dtype_name(device))


def is_mps_dtype_error(exc: BaseException) -> bool:
    """MPS 對 fp16 運算不支援時的例外（訊息各版本不一，只認同時提到 MPS 與半精度的）。"""
    low = str(exc).lower()
    return "mps" in low and any(k in low for k in ("float16", "half", "fp16"))


# ------------------------------------------------------------------ 記憶體
def synchronize(device: str, torch_mod: Any | None = None) -> None:
    t = _torch(torch_mod)
    kind = device_kind(device)
    if kind == "cuda":
        t.cuda.synchronize()
    elif kind == "mps":
        t.mps.synchronize()


def empty_cache(torch_mod: Any | None = None) -> None:
    t = _torch(torch_mod)
    try:
        if cuda_available(t):
            t.cuda.empty_cache()
        if mps_available(t):
            t.mps.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def reset_peak_memory_stats(torch_mod: Any | None = None) -> None:
    """CUDA 才有峰值統計；MPS 沒有對應 API（見 max_memory_allocated_mb），不做事。"""
    t = _torch(torch_mod)
    try:
        if cuda_available(t):
            t.cuda.reset_peak_memory_stats()
    except Exception:  # noqa: BLE001
        pass


def max_memory_allocated_mb(torch_mod: Any | None = None) -> float | None:
    """GPU 峰值記憶體（MB）；沒有 GPU 回 None。

    MPS 沒有「峰值」API：用 `torch.mps.driver_allocated_memory()`（Metal 驅動替這個行程配置的總量，含快取）。
    快取配置器用完不會還給驅動，所以跑完一段後它接近峰值、略偏高 —— 當成上限估計，不是精確峰值。
    """
    t = _torch(torch_mod)
    try:
        if cuda_available(t):
            return float(t.cuda.max_memory_allocated()) / (1024 * 1024)
        if mps_available(t):
            return float(t.mps.driver_allocated_memory()) / (1024 * 1024)
    except Exception:  # noqa: BLE001
        return None
    return None


def current_memory_allocated_mb(torch_mod: Any | None = None) -> int | None:
    t = _torch(torch_mod)
    try:
        if cuda_available(t):
            return int(t.cuda.memory_allocated() // (1024 * 1024))
        if mps_available(t):
            return int(t.mps.current_allocated_memory() // (1024 * 1024))
    except Exception:  # noqa: BLE001
        return None
    return None


# ------------------------------------------------------------------ 描述（hello / doctor）
def _sysctl(name: str) -> str | None:
    try:
        out = subprocess.run(["sysctl", "-n", name], capture_output=True, text=True, timeout=3, check=False)
        s = out.stdout.strip()
        return s or None
    except Exception:  # noqa: BLE001
        return None


def apple_chip_name() -> str | None:
    """"Apple M2 Pro" 之類；取不到回 None。"""
    return _sysctl("machdep.cpu.brand_string")


def unified_memory_mb() -> int | None:
    s = _sysctl("hw.memsize")
    try:
        return int(s) // (1024 * 1024) if s else None
    except ValueError:
        return None


def describe(torch_mod: Any | None = None) -> dict[str, Any]:
    """裝置摘要（camelCase，給 serve hello 與 doctor 共用）。不擲例外：torch import 失敗也回得出來。

    鍵：backend（cuda/mps/cpu/None）、device（顯示名稱）、capability（CUDA sm 版本）、memoryMB、
    unifiedMemory（Apple Silicon 是共用記憶體，數字是整機 RAM）、dtype、cuda、mps、mpsBuilt、allowCpu、reason、torch。
    """
    info: dict[str, Any] = {
        "backend": None,
        "device": None,
        "capability": None,
        "memoryMB": None,
        "unifiedMemory": False,
        "dtype": None,
        "cuda": False,
        "mps": False,
        "mpsBuilt": False,
        "allowCpu": allow_cpu(),
        "reason": None,
        "torch": None,
    }
    try:
        t = _torch(torch_mod)
    except Exception as e:  # noqa: BLE001
        info["reason"] = f"import torch 失敗：{type(e).__name__}: {e}"
        return info
    info["torch"] = getattr(t, "__version__", None)
    info["cuda"] = cuda_available(t)
    info["mpsBuilt"] = mps_built(t)
    info["mps"] = mps_available(t)
    backend, reason = decide_backend(
        sys.platform,
        platform.machine(),
        cuda=info["cuda"],
        mps_is_built=info["mpsBuilt"],
        mps=info["mps"],
        allow_cpu_flag=info["allowCpu"],
        torch_version=info["torch"],
    )
    info["backend"] = backend
    info["reason"] = reason
    try:
        if backend == "cuda":
            info["device"] = t.cuda.get_device_name(0)
            cc = t.cuda.get_device_capability(0)
            info["capability"] = f"{cc[0]}.{cc[1]}"
            info["memoryMB"] = int(t.cuda.get_device_properties(0).total_memory // (1024 * 1024))
        elif backend == "mps":
            info["device"] = apple_chip_name() or "Apple GPU"
            info["memoryMB"] = unified_memory_mb()
            info["unifiedMemory"] = True
        elif backend == "cpu":
            info["device"] = platform.processor() or platform.machine() or "CPU"
    except Exception as e:  # noqa: BLE001
        info["reason"] = f"查詢裝置資訊失敗：{type(e).__name__}: {e}"
    if backend is not None:
        info["dtype"] = preferred_dtype_name(backend)
    return info
