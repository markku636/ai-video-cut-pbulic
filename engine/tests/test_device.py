"""aivc.device 的裝置／精度決策、doctor 閘門判定、sam2_hf 的裝置接線。

全部用假的 torch 模組注入（`sys.platform` / `platform.machine` 用 monkeypatch 改），
所以在任何主機（Windows + CUDA、CI 的 CPU Linux、Mac）上結果都一樣，不需要真的 GPU。
"""
from __future__ import annotations

import math
import os
import sys
import types
from dataclasses import dataclass, field
from typing import Any

import pytest

from aivc import device as dev
from aivc import doctor

ENV_KEYS = ("AIVC_ALLOW_CPU", "AIVC_MPS_DTYPE", "PYTORCH_ENABLE_MPS_FALLBACK", "HF_HOME", "TORCH_HOME")


@pytest.fixture(autouse=True)
def _isolate(monkeypatch: pytest.MonkeyPatch):
    """env.apply_model_env() 會 setdefault 環境變數、fp16 退路是行程內黏著狀態：每個測試前後都還原。"""
    saved = {k: os.environ.get(k) for k in ENV_KEYS}
    monkeypatch.delenv("AIVC_ALLOW_CPU", raising=False)
    monkeypatch.delenv("AIVC_MPS_DTYPE", raising=False)
    dev.reset_mps_float16_state()
    yield
    dev.reset_mps_float16_state()
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


# ------------------------------------------------------------------ 假 torch
@dataclass
class FakeTorch:
    """只實作 aivc.device / doctor 會碰到的面。"""

    cuda_ok: bool = False
    mps_ok: bool = False
    mps_is_built: bool = True
    version: str = "2.14.0"
    calls: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.__version__ = self.version
        self.float16, self.float32, self.bfloat16 = "fp16", "fp32", "bf16"
        self.version = types.SimpleNamespace(cuda="13.0" if "+cu" in self.version else None)
        t = self
        self.cuda = types.SimpleNamespace(
            is_available=lambda: t.cuda_ok,
            get_device_name=lambda i=0: "NVIDIA GeForce RTX 5070 Ti",
            get_device_capability=lambda i=0: (12, 0),
            get_device_properties=lambda i=0: types.SimpleNamespace(total_memory=16 * 1024**3),
            get_arch_list=lambda: ["sm_120"],
            max_memory_allocated=lambda: 512 * 1024**2,
            memory_allocated=lambda: 256 * 1024**2,
            reset_peak_memory_stats=lambda: t.calls.append("cuda.reset_peak"),
            empty_cache=lambda: t.calls.append("cuda.empty_cache"),
            synchronize=lambda: t.calls.append("cuda.sync"),
        )
        self.mps = types.SimpleNamespace(
            driver_allocated_memory=lambda: 3 * 1024**3,
            current_allocated_memory=lambda: 1024**3,
            empty_cache=lambda: t.calls.append("mps.empty_cache"),
            synchronize=lambda: t.calls.append("mps.sync"),
        )
        self.backends = types.SimpleNamespace(
            mps=types.SimpleNamespace(is_available=lambda: t.mps_ok, is_built=lambda: t.mps_is_built)
        )


def _on(monkeypatch: pytest.MonkeyPatch, plat: str, machine: str = "arm64") -> None:
    monkeypatch.setattr(dev.sys, "platform", plat)
    monkeypatch.setattr(dev.platform, "machine", lambda: machine)


# ------------------------------------------------------------------ decide_backend（純函式）
@pytest.mark.parametrize(
    ("plat", "machine", "cuda", "mps", "allow", "want"),
    [
        ("win32", "AMD64", True, False, False, "cuda"),
        ("linux", "x86_64", True, False, False, "cuda"),
        ("linux", "x86_64", False, False, False, None),
        ("win32", "AMD64", False, False, True, "cpu"),
        ("darwin", "arm64", False, True, False, "mps"),
        ("darwin", "arm64", False, True, True, "mps"),  # 放行 CPU 也要先用 GPU
        ("darwin", "arm64", False, False, False, None),
        ("darwin", "arm64", False, False, True, "cpu"),
        ("linux", "x86_64", False, True, False, None),  # 非 darwin 的 mps 旗標不算數
        ("win32", "AMD64", True, True, False, "cuda"),
    ],
)
def test_decide_backend_order(plat: str, machine: str, cuda: bool, mps: bool, allow: bool, want: str | None) -> None:
    backend, reason = dev.decide_backend(plat, machine, cuda=cuda, mps_is_built=True, mps=mps, allow_cpu_flag=allow, torch_version="2.14.0+cu130")
    assert backend == want
    # 有 GPU 就沒有理由；沒有 GPU（含放行 CPU）一定要說明為什麼
    assert (reason is None) == (backend in ("cuda", "mps"))


def test_no_gpu_reasons_are_plain_and_specific() -> None:
    def reason(plat: str, machine: str = "arm64", built: bool = True, v: str = "2.14.0") -> str:
        _, r = dev.decide_backend(plat, machine, cuda=False, mps_is_built=built, mps=False, allow_cpu_flag=False, torch_version=v)
        assert r
        return r

    assert "Intel" in reason("darwin", "x86_64") and "Apple Silicon" in reason("darwin", "x86_64")
    assert "is_built" in reason("darwin", built=False)
    assert "macOS 14" in reason("darwin")
    assert "CPU 版" in reason("win32", "AMD64", v="2.14.0+cpu")
    assert "R580" in reason("linux", "x86_64", v="2.14.0+cu130")
    assert "不支援的平台" in reason("freebsd14", "amd64")


# ------------------------------------------------------------------ select / resolve
def test_select_device_prefers_cuda_then_mps(monkeypatch: pytest.MonkeyPatch) -> None:
    _on(monkeypatch, "win32", "AMD64")
    assert dev.select_device(FakeTorch(cuda_ok=True)) == "cuda"
    _on(monkeypatch, "darwin", "arm64")
    assert dev.select_device(FakeTorch(mps_ok=True)) == "mps"


def test_select_device_refuses_silent_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    _on(monkeypatch, "linux", "x86_64")
    with pytest.raises(dev.DeviceUnavailable) as ei:
        dev.select_device(FakeTorch(version="2.14.0+cpu"))
    assert "CPU 版" in str(ei.value) and "AIVC_ALLOW_CPU" in ei.value.hint
    # 只認字面 "1"（和 Rust 閘門一致）
    monkeypatch.setenv("AIVC_ALLOW_CPU", "true")
    with pytest.raises(dev.DeviceUnavailable):
        dev.select_device(FakeTorch())
    monkeypatch.setenv("AIVC_ALLOW_CPU", "1")
    assert dev.select_device(FakeTorch()) == "cpu"


def test_select_device_mps_needs_darwin(monkeypatch: pytest.MonkeyPatch) -> None:
    _on(monkeypatch, "linux", "aarch64")
    t = FakeTorch(mps_ok=True)
    assert dev.mps_available(t) is False
    with pytest.raises(dev.DeviceUnavailable):
        dev.select_device(t)


def test_resolve_device(monkeypatch: pytest.MonkeyPatch) -> None:
    _on(monkeypatch, "win32", "AMD64")
    gpu = FakeTorch(cuda_ok=True, version="2.14.0+cu130")
    for req in (None, "", "auto", "AUTO"):
        assert dev.resolve_device(req, gpu) == "cuda"
    assert dev.resolve_device("cuda:1", gpu) == "cuda:1"
    with pytest.raises(dev.DeviceUnavailable) as ei:
        dev.resolve_device("cuda", FakeTorch(version="2.14.0+cu130"))
    assert str(ei.value).startswith("CUDA 不可用") and "+cu130" in ei.value.hint
    with pytest.raises(dev.DeviceUnavailable):
        dev.resolve_device("mps", gpu)
    with pytest.raises(dev.DeviceUnavailable):
        dev.resolve_device("cpu", gpu)
    monkeypatch.setenv("AIVC_ALLOW_CPU", "1")
    assert dev.resolve_device("cpu", gpu) == "cpu"
    with pytest.raises(dev.DeviceUnavailable):
        dev.resolve_device("xpu", gpu)


def test_resolve_bare_cuda_means_the_gpu_on_mac(monkeypatch: pytest.MonkeyPatch) -> None:
    """ops 的 --device 歷來預設字面 "cuda"：macOS 上換成 MPS，而不是整個 SAM 失敗。"""
    _on(monkeypatch, "darwin", "arm64")
    mac = FakeTorch(mps_ok=True)
    assert dev.resolve_device("cuda", mac) == "mps"
    assert dev.resolve_device("mps", mac) == "mps"
    with pytest.raises(dev.DeviceUnavailable):
        dev.resolve_device("cuda:0", mac)  # 明確指定編號就不猜
    with pytest.raises(dev.DeviceUnavailable) as ei:
        dev.resolve_device("cuda", FakeTorch(mps_ok=False))
    assert "macOS 沒有 CUDA" in str(ei.value) and "MPS" in ei.value.hint


# ------------------------------------------------------------------ dtype
def test_preferred_dtype_per_device(monkeypatch: pytest.MonkeyPatch) -> None:
    t = FakeTorch()
    assert dev.preferred_dtype_name("cuda") == "bfloat16" and dev.preferred_dtype("cuda:0", t) == "bf16"
    assert dev.preferred_dtype_name("mps") == "float16" and dev.preferred_dtype("mps", t) == "fp16"
    assert dev.preferred_dtype_name("cpu") == "float32" and dev.preferred_dtype("cpu", t) == "fp32"
    monkeypatch.setenv("AIVC_MPS_DTYPE", "float32")
    assert dev.preferred_dtype_name("mps") == "float32"
    assert dev.preferred_dtype_name("cuda") == "bfloat16", "AIVC_MPS_DTYPE 不影響 CUDA"


def test_mps_float16_sticky_fallback() -> None:
    assert dev.preferred_dtype_name("mps") == "float16"
    dev.mark_mps_float16_unusable("NaN")
    assert dev.mps_float16_broken() == "NaN"
    assert dev.preferred_dtype_name("mps") == "float32"
    assert dev.preferred_dtype_name("cuda") == "bfloat16"
    dev.reset_mps_float16_state()
    assert dev.preferred_dtype_name("mps") == "float16"


def test_is_mps_dtype_error() -> None:
    assert dev.is_mps_dtype_error(RuntimeError("MPS does not support float16 for this op"))
    assert dev.is_mps_dtype_error(TypeError("Cannot convert a MPS Tensor to half"))
    assert not dev.is_mps_dtype_error(RuntimeError("CUDA out of memory"))
    assert not dev.is_mps_dtype_error(NotImplementedError("aten::foo is not implemented for the MPS device"))


# ------------------------------------------------------------------ 記憶體 / describe
def test_memory_helpers(monkeypatch: pytest.MonkeyPatch) -> None:
    _on(monkeypatch, "win32", "AMD64")
    gpu = FakeTorch(cuda_ok=True)
    assert dev.max_memory_allocated_mb(gpu) == 512.0
    assert dev.current_memory_allocated_mb(gpu) == 256
    dev.reset_peak_memory_stats(gpu)
    dev.empty_cache(gpu)
    assert gpu.calls == ["cuda.reset_peak", "cuda.empty_cache"]
    assert dev.max_memory_allocated_mb(FakeTorch()) is None
    _on(monkeypatch, "darwin", "arm64")
    mac = FakeTorch(mps_ok=True)
    assert dev.max_memory_allocated_mb(mac) == 3072.0
    assert dev.current_memory_allocated_mb(mac) == 1024
    dev.reset_peak_memory_stats(mac)  # MPS 沒有峰值統計：不做事、不擲
    dev.empty_cache(mac)
    dev.synchronize("mps", mac)
    assert mac.calls == ["mps.empty_cache", "mps.sync"]


def test_describe_cuda(monkeypatch: pytest.MonkeyPatch) -> None:
    _on(monkeypatch, "win32", "AMD64")
    d = dev.describe(FakeTorch(cuda_ok=True, version="2.14.0+cu130"))
    assert d["backend"] == "cuda" and d["cuda"] is True and d["mps"] is False
    assert d["device"] == "NVIDIA GeForce RTX 5070 Ti" and d["capability"] == "12.0"
    assert d["memoryMB"] == 16384 and d["dtype"] == "bfloat16" and d["reason"] is None and d["torch"] == "2.14.0+cu130"


def test_describe_mps(monkeypatch: pytest.MonkeyPatch) -> None:
    _on(monkeypatch, "darwin", "arm64")
    monkeypatch.setattr(dev, "apple_chip_name", lambda: "Apple M3 Max")
    monkeypatch.setattr(dev, "unified_memory_mb", lambda: 36 * 1024)
    d = dev.describe(FakeTorch(mps_ok=True))
    assert d["backend"] == "mps" and d["device"] == "Apple M3 Max" and d["memoryMB"] == 36 * 1024
    assert d["unifiedMemory"] is True and d["dtype"] == "float16" and d["capability"] is None


def test_describe_without_gpu_does_not_raise(monkeypatch: pytest.MonkeyPatch) -> None:
    _on(monkeypatch, "linux", "x86_64")
    d = dev.describe(FakeTorch(version="2.14.0+cpu"))
    assert d["backend"] is None and d["dtype"] is None and "CPU 版" in d["reason"]
    monkeypatch.setenv("AIVC_ALLOW_CPU", "1")
    d = dev.describe(FakeTorch(version="2.14.0+cpu"))
    assert d["backend"] == "cpu" and d["allowCpu"] is True and d["dtype"] == "float32" and d["reason"]


# ------------------------------------------------------------------ doctor 閘門（純函式）
def G(**kw: Any) -> doctor.GateResult:
    base: dict[str, Any] = {"sys_platform": "win32", "machine": "AMD64", "torch_version": "2.14.0+cu130", "cuda_available": True}
    base.update(kw)
    return doctor.evaluate_gate(doctor.GateInput(**base))


def test_gate_cuda_pass_and_wrong_build() -> None:
    r = G()
    assert r.backend == "cuda" and not r.problems and r.checks == {"cuda_available": True, "torch_cu130": True}
    r = G(sys_platform="linux", machine="x86_64")
    assert r.backend == "cuda" and not r.problems
    r = G(torch_version="2.11.0+cu128")
    assert r.backend == "cuda" and r.checks["torch_cu130"] is False
    assert len(r.problems) == 1 and "+cu130" in r.problems[0]


def test_gate_cpu_torch_fails_loudly_on_windows_and_linux() -> None:
    for plat in ("win32", "linux"):
        r = G(sys_platform=plat, torch_version="2.14.0+cpu", cuda_available=False)
        assert r.backend is None and r.problems and not r.warnings
        assert r.checks == {"cuda_available": False, "torch_cu130": False}
        assert any("CPU 版" in p for p in r.problems)
    # 對的 torch、沒有 GPU（例如驅動太舊）：講驅動，不要誤導成 torch 版本問題
    r = G(cuda_available=False)
    assert r.backend is None and len(r.problems) == 1 and "R580" in r.problems[0]
    # 別的 CUDA 版又沒 GPU：兩件事都要講
    r = G(torch_version="2.11.0+cu128", cuda_available=False)
    assert len(r.problems) == 2 and "+cu130" in r.problems[0]


def test_gate_macos_mps() -> None:
    r = G(sys_platform="darwin", machine="arm64", torch_version="2.14.0", cuda_available=False, mps_built=True, mps_available=True)
    # PyPI 的 macOS torch 沒有 +cu130 後綴：不能拿 Windows 的建置檢查擋掉
    assert r.backend == "mps" and not r.problems and r.checks == {"mps_available": True}


def test_gate_macos_without_mps() -> None:
    r = G(sys_platform="darwin", machine="arm64", torch_version="2.14.0", cuda_available=False, mps_built=True, mps_available=False)
    assert r.backend is None and r.checks == {"mps_available": False}
    assert len(r.problems) == 1 and "mps.is_available()" in r.problems[0]
    r = G(sys_platform="darwin", machine="x86_64", torch_version="2.2.2", cuda_available=False, mps_built=True, mps_available=False)
    assert "Intel" in r.problems[0]


def test_gate_allow_cpu_turns_problems_into_warnings() -> None:
    r = G(sys_platform="linux", torch_version="2.14.0+cpu", cuda_available=False, allow_cpu=True)
    assert r.backend == "cpu" and not r.problems
    assert any("CPU 版" in w for w in r.warnings) and r.warnings[-1] == doctor.CPU_ALLOWED_WARNING
    r = G(sys_platform="darwin", machine="arm64", torch_version="2.14.0", cuda_available=False, mps_available=False, allow_cpu=True)
    assert r.backend == "cpu" and not r.problems and r.warnings
    # 放行 CPU 不影響有 GPU 的判定
    assert G(allow_cpu=True).backend == "cuda"


def test_doctor_exit_code_is_3_on_problems(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.setattr(doctor, "run", lambda quick=False: doctor.DoctorReport(problems=["torch.cuda.is_available() 為 False"]))
    assert doctor.main([]) == 3
    assert "FAIL:" in capsys.readouterr().out
    monkeypatch.setattr(doctor, "run", lambda quick=False: doctor.DoctorReport(warnings=["AIVC_ALLOW_CPU=1"]))
    assert doctor.main(["--json"]) == 0
    assert '"ok": true' in capsys.readouterr().out


# ------------------------------------------------------------------ doctor.run 的 MPS 路徑（真 torch 在 CPU 上代打）
def _mps_torch_on_cpu(real: Any, *, fp16_nonfinite: bool = False) -> FakeTorch:
    """假 torch：mps 可用，randn 忽略 device 在 CPU 上算（驗 doctor 的暖機流程，不驗 Metal）。"""
    t = FakeTorch(mps_ok=True)
    t.float16, t.float32, t.bfloat16 = real.float16, real.float32, real.bfloat16

    def randn(*shape: int, device: str | None = None, dtype: Any = None) -> Any:
        t.calls.append(f"randn:{device}:{dtype}")
        if fp16_nonfinite and dtype is real.float16:
            return real.full(shape, math.inf, dtype=real.float32)
        return real.randn(*shape, dtype=real.float32)

    t.randn = randn  # type: ignore[attr-defined]
    return t


def test_doctor_run_mps_path(monkeypatch: pytest.MonkeyPatch) -> None:
    real = pytest.importorskip("torch")
    fake = _mps_torch_on_cpu(real)
    _on(monkeypatch, "darwin", "arm64")
    monkeypatch.setitem(sys.modules, "torch", fake)
    monkeypatch.setattr(dev, "apple_chip_name", lambda: "Apple M2")
    monkeypatch.setattr(dev, "unified_memory_mb", lambda: 16384)
    r = doctor.run()
    assert r.backend == "mps" and r.mps_available and not r.cuda_available
    assert r.device == "Apple M2" and r.vram_mb == 16384 and r.unified_memory
    assert r.gemm_ok is True and r.gemm_dtype == "float16" and r.gemm_size == 1024
    assert r.checks["mps_available"] and r.checks["mps_matmul"]
    assert "torch_cu130" not in r.checks and r.bf16_gemm_ok is None
    assert not [p for p in r.problems if "torch" in p or "MPS" in p]
    assert "randn:mps:" + str(real.float16) in fake.calls
    assert os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK") == "1"
    assert "backend=mps" in doctor.format_human(r)


def test_doctor_run_mps_fp16_broken_falls_back_to_fp32(monkeypatch: pytest.MonkeyPatch) -> None:
    real = pytest.importorskip("torch")
    _on(monkeypatch, "darwin", "arm64")
    monkeypatch.setitem(sys.modules, "torch", _mps_torch_on_cpu(real, fp16_nonfinite=True))
    monkeypatch.setattr(dev, "apple_chip_name", lambda: None)
    monkeypatch.setattr(dev, "unified_memory_mb", lambda: None)
    r = doctor.run()
    assert r.backend == "mps" and r.gemm_ok is True and r.gemm_dtype == "float32"
    assert any("AIVC_MPS_DTYPE=float32" in w for w in r.warnings)
    assert not [p for p in r.problems if "MPS" in p]
    # 同行程（serve 裡跑 env.doctor）之後載 SAM 直接用 float32
    assert dev.preferred_dtype_name("mps") == "float32"


# ------------------------------------------------------------------ sam2_hf 的裝置接線
def _fake_transformers(monkeypatch: pytest.MonkeyPatch, loads: list[tuple[str, Any]]) -> None:
    class Model:
        def to(self, device: str) -> Model:
            loads.append(("to", device))
            return self

        def eval(self) -> Model:
            return self

    class Sam2VideoModel:
        @staticmethod
        def from_pretrained(model_id: str, dtype: Any = None) -> Model:
            loads.append(("model", dtype))
            return Model()

    class Sam2VideoProcessor:
        @staticmethod
        def from_pretrained(model_id: str) -> Any:
            def processor(**_kw: Any) -> Any:
                raise RuntimeError("no fast processor in tests")

            return processor

    mod = types.ModuleType("transformers")
    mod.Sam2VideoModel = Sam2VideoModel  # type: ignore[attr-defined]
    mod.Sam2VideoProcessor = Sam2VideoProcessor  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "transformers", mod)


def test_sam2_load_refuses_without_gpu(monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.seg import sam2_hf
    from aivc.seg.backend import SegModelError

    monkeypatch.setattr(sam2_hf, "_LOADED", None)
    _on(monkeypatch, "linux", "x86_64")
    monkeypatch.setitem(sys.modules, "torch", FakeTorch(version="2.14.0+cpu"))
    for req in (None, "cuda", "cpu"):
        with pytest.raises(SegModelError) as ei:
            sam2_hf.load("small", req)
        assert ei.value.kind == "Gpu" and ei.value.hint


def test_sam2_load_on_mac_uses_mps_fp16_and_reloads_after_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.seg import sam2_hf

    monkeypatch.setattr(sam2_hf, "_LOADED", None)
    _on(monkeypatch, "darwin", "arm64")
    fake = FakeTorch(mps_ok=True)
    monkeypatch.setitem(sys.modules, "torch", fake)
    loads: list[tuple[str, Any]] = []
    _fake_transformers(monkeypatch, loads)

    a = sam2_hf.Sam2HfBackend(variant="tiny", device="cuda").loaded()  # ops 的歷來預設
    assert a.device == "mps" and a.dtype == "fp16" and a.preprocess_on_device is False
    assert loads == [("model", "fp16"), ("to", "mps")]
    assert sam2_hf.load("tiny", None) is a, "同裝置同精度不重載"

    dev.mark_mps_float16_unusable("NaN")
    b = sam2_hf.load("tiny", None)
    assert b is not a and b.dtype == "fp32" and loads[-2:] == [("model", "fp32"), ("to", "mps")]
    assert "mps.empty_cache" in fake.calls
    monkeypatch.setattr(sam2_hf, "_LOADED", None)


def _session(real: Any, device: str, dtype: Any, model: Any = None) -> Any:
    from aivc.seg import sam2_hf

    processor = types.SimpleNamespace(
        init_video_session=lambda **_kw: types.SimpleNamespace(),
        post_process_masks=lambda masks, **_kw: [masks[0]],
    )
    loaded = sam2_hf.LoadedSam2(model, processor, "fake/sam", "tiny", device, 0.0, False, dtype)
    return sam2_hf.Sam2HfSession(loaded, (4, 4))


def _out(real: Any, value: float) -> Any:
    return types.SimpleNamespace(
        pred_masks=real.full((1, 1, 4, 4), value),
        object_score_logits=real.tensor([[1.0]]),
        object_ids=[1],
        frame_idx=0,
    )


def test_sam2_session_mps_fp16_nan_fails_loudly(monkeypatch: pytest.MonkeyPatch) -> None:
    real = pytest.importorskip("torch")
    from aivc.seg.backend import SegModelError

    s = _session(real, "mps", real.float16)
    fm = s._postprocess(_out(real, 5.0))
    assert fm.masks[1].all()
    with pytest.raises(SegModelError) as ei:
        s._postprocess(_out(real, math.nan))
    assert ei.value.kind == "Gpu" and "AIVC_MPS_DTYPE=float32" in ei.value.hint
    assert dev.preferred_dtype_name("mps") == "float32"


def test_sam2_session_mps_dtype_error_in_forward(monkeypatch: pytest.MonkeyPatch) -> None:
    real = pytest.importorskip("torch")
    from aivc.seg.backend import SegModelError

    def model(**_kw: Any) -> Any:
        raise RuntimeError("MPS: input types 'tensor<float16>' are not broadcast compatible (float16)")

    s = _session(real, "mps", real.float16, model)
    with pytest.raises(SegModelError) as ei:
        s._forward(frame_idx=0, frame=None)
    assert ei.value.kind == "Gpu" and dev.mps_float16_broken()


def test_sam2_session_cuda_path_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    """CUDA bf16 不做 NaN 偵測（維持 Windows 行為與效能）；dtype 取自 LoadedSam2，None 視同 bf16。"""
    real = pytest.importorskip("torch")
    s = _session(real, "cuda", None)
    assert s._dtype == real.bfloat16 and s._mps_fp16 is False
    fm = s._postprocess(_out(real, math.nan))
    assert not fm.masks[1].any()
    assert dev.mps_float16_broken() is None
