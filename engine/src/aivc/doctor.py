"""環境閘門 `aivc doctor`。

失敗要**大聲**：PATH 上的 python 有 torch 2.14.0+cpu，import 全成功、cuda 回 False、
SAM 以 0.2 fps 跑而且不會報錯 —— 這是整個專案的頭號風險（計畫 §12）。
退出碼：0 通過；3 閘門未過（訊息含具體哪一項）。

通過條件（依平台，決策本體是純函式 `evaluate_gate`，可在任何主機上測）：
- Windows / Linux：torch 是 +cu130 ∧ torch.cuda.is_available() ∧ sm_XY ∈ arch list ∧ bf16 GEMM 結果有限。
- macOS（Apple Silicon）：torch.backends.mps.is_available() ∧ MPS 上的小矩陣乘法暖機成功。
  macOS 的 torch 來自 PyPI，版號沒有 +cu130 之類的後綴，所以不檢查建置後綴。
- 沒有 GPU：一律不通過；只有 AIVC_ALLOW_CPU=1（CI）時改成警告並通過。
"""
from __future__ import annotations

import importlib.util
import json
import math
import platform as _platform  # 別名：DoctorReport 有同名欄位 `platform`，類別本體裡會遮住模組
import sys
import time
from dataclasses import asdict, dataclass, field
from typing import Any

from . import device as dev
from . import env


@dataclass
class DoctorReport:
    python: str = sys.version.split()[0]
    executable: str = sys.executable
    platform: str = _platform.platform()
    machine: str = _platform.machine()
    torch: str | None = None
    torch_cuda_build: str | None = None
    backend: str | None = None  # "cuda" | "mps" | "cpu" | None（閘門判定用哪個裝置）
    cuda_available: bool = False
    mps_built: bool = False
    mps_available: bool = False
    allow_cpu: bool = False
    device: str | None = None
    capability: str | None = None
    arch_list: list[str] = field(default_factory=list)
    vram_mb: int | None = None  # Apple Silicon 是共用記憶體：這裡放整機 RAM（unified_memory=True）
    unified_memory: bool = False
    # bf16_gemm_* 只在 CUDA 路徑填（舊欄位，保留相容）；gemm_* 是跨平台的暖機結果
    bf16_gemm_ok: bool | None = None
    bf16_gemm_ms: float | None = None
    gemm_ok: bool | None = None
    gemm_ms: float | None = None
    gemm_dtype: str | None = None
    gemm_size: int | None = None
    cv2: str | None = None
    av: str | None = None
    pycocotools: bool = False
    transformers: str | None = None
    ffmpeg_dir: str | None = None
    ffmpeg_version: str | None = None
    data_root: str = ""
    checks: dict[str, bool] = field(default_factory=dict)
    problems: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.problems


# ------------------------------------------------------------------ 純決策
@dataclass(frozen=True)
class GateInput:
    """閘門需要的事實（全是純值，測試直接建構）。"""

    sys_platform: str
    machine: str
    torch_version: str
    cuda_available: bool
    mps_built: bool = False
    mps_available: bool = False
    allow_cpu: bool = False


@dataclass
class GateResult:
    backend: str | None
    checks: dict[str, bool] = field(default_factory=dict)
    problems: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


CPU_ALLOWED_WARNING = "AIVC_ALLOW_CPU=1：放行以 CPU 執行（只該用在 CI／除錯；SAM 2.1 在 CPU 上每幀要數秒）"


def evaluate_gate(g: GateInput) -> GateResult:
    """torch / 裝置層的閘門判定（不含需要實際跑 GPU 的 sm_XY 與 GEMM 暖機，那些在 run() 裡補）。"""
    backend, reason = dev.decide_backend(
        g.sys_platform,
        g.machine,
        cuda=g.cuda_available,
        mps_is_built=g.mps_built,
        mps=g.mps_available,
        allow_cpu_flag=g.allow_cpu,
        torch_version=g.torch_version,
    )
    res = GateResult(backend=backend)
    v = g.torch_version
    is_cu130 = v.endswith("+cu130")
    darwin = g.sys_platform == "darwin"

    if backend == "cuda":
        res.checks["cuda_available"] = True
        res.checks["torch_cu130"] = is_cu130
        if not is_cu130:
            res.problems.append(f"torch 是 {v}，需要 +cu130 版（其他 CUDA 版沒有 torch 2.14 的 sm_120 支援；全域 python 的 CPU 版更不能用）")
        return res
    if backend == "mps":
        res.checks["mps_available"] = True
        return res

    # 沒有 GPU（backend 是 None，或放行後的 "cpu"）
    msgs: list[str] = []
    if darwin:
        res.checks["mps_available"] = False
    else:
        res.checks["cuda_available"] = False
        res.checks["torch_cu130"] = is_cu130
        # 「不是 CUDA 版」的情況 reason 已經講了；是別的 CUDA 版（例如 +cu128）才另外點名要 +cu130
        if "+cu" in v and not is_cu130:
            msgs.append(f"torch 是 {v}，需要 +cu130 版")
    if reason:
        msgs.append(reason)
    if backend == "cpu":
        res.warnings.extend(msgs)
        res.warnings.append(CPU_ALLOWED_WARNING)
    else:
        res.problems.extend(msgs)
    return res


# ------------------------------------------------------------------ 實際探測
def _has(mod: str) -> bool:
    return importlib.util.find_spec(mod) is not None


def _gemm_once(torch: Any, device: str, dtype: Any, n: int) -> tuple[bool, float]:
    """n×n 矩陣乘法：先暖機一次（含 context / kernel 編譯 / lazy loading），再計時第二次。"""
    a = torch.randn(n, n, device=device, dtype=dtype)
    _ = (a @ a).float().sum().item()
    dev.synchronize(device, torch)
    t0 = time.perf_counter()
    s = (a @ a).float().sum().item()
    dev.synchronize(device, torch)
    ms = round((time.perf_counter() - t0) * 1000, 2)
    return math.isfinite(s), ms


def _check_cuda(r: DoctorReport, torch: Any, quick: bool) -> None:
    cc = torch.cuda.get_device_capability(0)
    r.capability = f"{cc[0]}.{cc[1]}"
    r.device = torch.cuda.get_device_name(0)
    r.arch_list = list(torch.cuda.get_arch_list())
    sm = f"sm_{cc[0]}{cc[1]}"
    r.checks["arch_in_build"] = sm in r.arch_list
    if not r.checks["arch_in_build"]:
        r.problems.append(f"這張卡 {sm} 不在 torch 編譯的 arch 清單 {r.arch_list}")
    r.vram_mb = int(torch.cuda.get_device_properties(0).total_memory // (1024 * 1024))
    if quick:
        return
    # 第一次呼叫含 CUDA context / cuBLAS 初始化與 lazy module loading（實測 12 秒），那不是 GEMM 的速度
    r.gemm_dtype, r.gemm_size = "bfloat16", 4096
    try:
        ok, ms = _gemm_once(torch, "cuda", torch.bfloat16, 4096)
        r.bf16_gemm_ok, r.bf16_gemm_ms = ok, ms
    except Exception as e:  # noqa: BLE001
        r.bf16_gemm_ok = False
        r.problems.append(f"bf16 GEMM 失敗：{type(e).__name__}: {e}")
    r.gemm_ok, r.gemm_ms = r.bf16_gemm_ok, r.bf16_gemm_ms
    r.checks["bf16_gemm"] = bool(r.bf16_gemm_ok)
    if r.bf16_gemm_ok is False and not any("GEMM" in p for p in r.problems):
        r.problems.append("bf16 GEMM 結果非有限值")


def _check_mps(r: DoctorReport, torch: Any, quick: bool) -> None:
    r.device = dev.apple_chip_name() or "Apple GPU"
    r.vram_mb = dev.unified_memory_mb()
    r.unified_memory = True
    if quick:
        return
    # 1024² 就夠驗「Metal 能配置、kernel 能編譯、數值有限」；Mac 是共用記憶體，暖機不該吃掉使用者的 RAM
    n = 1024
    want = dev.preferred_dtype_name("mps")
    tried: list[str] = []
    for name in dict.fromkeys([want, "float32"]):
        try:
            ok, ms = _gemm_once(torch, "mps", getattr(torch, name), n)
        except Exception as e:  # noqa: BLE001
            tried.append(f"{name}: {type(e).__name__}: {e}")
            continue
        if not ok:
            tried.append(f"{name}: 結果非有限值")
            continue
        r.gemm_ok, r.gemm_ms, r.gemm_dtype, r.gemm_size = True, ms, name, n
        if name != want:
            # env.doctor 也會在長駐的 serve 行程裡跑：記下來，同行程之後載 SAM 直接用 float32
            dev.mark_mps_float16_unusable(tried[0])
            r.warnings.append(
                f"MPS {want} 矩陣乘法失敗（{tried[0]}），float32 正常：SAM 2.1 可能在第一次推論時才自動改用 float32；"
                f"建議設 {dev.MPS_DTYPE_ENV}=float32"
            )
        break
    else:
        r.gemm_ok, r.gemm_dtype, r.gemm_size = False, want, n
        r.problems.append("MPS 矩陣乘法暖機失敗，Apple GPU 不能用：" + "；".join(tried))
    r.checks["mps_matmul"] = bool(r.gemm_ok)


def run(quick: bool = False) -> DoctorReport:
    env.apply_model_env()
    r = DoctorReport(data_root=str(env.data_root()), allow_cpu=dev.allow_cpu())

    # ---- torch / GPU ----
    torch: Any = None
    try:
        import torch  # noqa: WPS433
    except Exception as e:  # noqa: BLE001
        r.problems.append(f"import torch 失敗：{type(e).__name__}: {e}")
    if torch is not None:
        try:
            r.torch = str(torch.__version__)
            r.torch_cuda_build = torch.version.cuda
            r.cuda_available = dev.cuda_available(torch)
            r.mps_built = dev.mps_built(torch)
            r.mps_available = dev.mps_available(torch)
            g = evaluate_gate(
                GateInput(
                    sys_platform=sys.platform,
                    machine=r.machine,
                    torch_version=r.torch,
                    cuda_available=r.cuda_available,
                    mps_built=r.mps_built,
                    mps_available=r.mps_available,
                    allow_cpu=r.allow_cpu,
                )
            )
            r.backend = g.backend
            r.checks.update(g.checks)
            r.problems.extend(g.problems)
            r.warnings.extend(g.warnings)
            if g.backend == "cuda":
                _check_cuda(r, torch, quick)
            elif g.backend == "mps":
                _check_mps(r, torch, quick)
        except Exception as e:  # noqa: BLE001
            r.problems.append(f"torch 裝置檢查失敗：{type(e).__name__}: {e}")

    # ---- 其他套件（用 find_spec 探測，不真的 import 重的）----
    try:
        import cv2  # noqa: WPS433

        r.cv2 = cv2.__version__
        r.checks["cv2_lt_5"] = int(r.cv2.split(".")[0]) < 5
        if not r.checks["cv2_lt_5"]:
            r.problems.append(f"opencv {r.cv2} 是 5.x，API 不同；需要 4.x")
    except Exception as e:  # noqa: BLE001
        r.problems.append(f"import cv2 失敗：{type(e).__name__}: {e}")
    try:
        import av  # noqa: WPS433

        r.av = av.__version__
    except Exception as e:  # noqa: BLE001
        r.problems.append(f"import av 失敗：{type(e).__name__}: {e}")
    r.pycocotools = _has("pycocotools")
    if not r.pycocotools:
        r.problems.append("缺 pycocotools")
    if _has("transformers"):
        try:
            from importlib.metadata import version

            r.transformers = version("transformers")
        except Exception:  # noqa: BLE001
            r.transformers = "?"
    else:
        r.problems.append("缺 transformers")

    # ---- ffmpeg ----
    d = env.ffmpeg_dir()
    r.ffmpeg_dir = str(d) if d else None
    if d is None:
        r.problems.append(f"找不到 ffmpeg/ffprobe（AIVC_FFMPEG_DIR / 內建 resources / PATH / 常見安裝目錄）：{env.ffmpeg_install_hint()}")
    else:
        try:
            import subprocess

            out = subprocess.run(
                [env.ffmpeg_bin("ffmpeg"), "-version"], capture_output=True, text=True, timeout=10, check=False
            ).stdout
            r.ffmpeg_version = out.splitlines()[0] if out else None
        except Exception as e:  # noqa: BLE001
            r.problems.append(f"ffmpeg -version 失敗：{e}")
    return r


def format_human(r: DoctorReport) -> str:
    mem = f"{r.vram_mb} MB" + ("（共用記憶體）" if r.unified_memory else "")
    lines = [
        f"python      {r.python}  ({r.executable})",
        f"torch       {r.torch}  backend={r.backend}  cuda_build={r.torch_cuda_build}  cuda={r.cuda_available}  mps={r.mps_available}",
        f"gpu         {r.device}  cc={r.capability}  mem={mem}  arch={','.join(r.arch_list)}",
        f"gemm        ok={r.gemm_ok}  {r.gemm_ms} ms  ({r.gemm_dtype}, {r.gemm_size}²)",
        f"cv2 {r.cv2} | av {r.av} | pycocotools {r.pycocotools} | transformers {r.transformers}",
        f"ffmpeg      {r.ffmpeg_dir}  {r.ffmpeg_version}",
        f"data_root   {r.data_root}",
    ]
    if r.warnings:
        lines.append("WARN:")
        lines += [f"  - {w}" for w in r.warnings]
    if r.problems:
        lines.append("FAIL:")
        lines += [f"  - {p}" for p in r.problems]
    else:
        lines.append("OK")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    as_json = "--json" in argv
    quick = "--quick" in argv
    r = run(quick=quick)
    if as_json:
        d = asdict(r)
        d["ok"] = r.ok
        print(json.dumps(d, ensure_ascii=False))
    else:
        print(format_human(r))
    return 0 if r.ok else 3
