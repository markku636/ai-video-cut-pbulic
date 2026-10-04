"""模型與推論裝置在 op 層的行為（不連網、不需要 GPU）：

1. `aivc models pull`（op models.pull）：bootstrap-engine.ps1／.sh 呼叫的就是 `aivc models pull --sam small`，
   以前引擎沒有這個指令。snapshot_download 換成假的，驗證下載清單、冪等、進度事件、離線錯誤訊息與 CLI 形狀。
2. 裝置欄位與預設：MPS 記憶體不足要歸成 Gpu、serve 的 hello／ping 要回 backend（cuda／mps／cpu）與記憶體用量、
   `aivc seg`／`aivc run` 的 --device 預設是 auto。假 torch 注入，任何主機結果一樣。
"""
from __future__ import annotations

import io
import json
import os
import sys
import types
from pathlib import Path
from typing import Any

import pytest

from aivc import device as dev
from aivc import errors
from aivc.ops import Canceled, OpError, load_all
from aivc.ops import models as MO

# ---------------------------------------------------------------- 共用

# env.apply_model_env() 用 setdefault 寫這些變數（sys.platform 被改成 darwin 時還會加 MPS fallback）：每個測試前後還原
ENV_KEYS = ("AIVC_ALLOW_CPU", "HF_HOME", "HF_HUB_CACHE", "HF_HUB_OFFLINE", "TORCH_HOME", "PYTORCH_ENABLE_MPS_FALLBACK", "HF_HUB_DISABLE_TELEMETRY")


@pytest.fixture(autouse=True)
def _isolate_env() -> Any:
    saved = {k: os.environ.get(k) for k in ENV_KEYS}
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


class RecordingCtx:
    def __init__(self, cancel: bool = False) -> None:
        self.progress_calls: list[dict[str, Any]] = []
        self.logs: list[tuple[str, str]] = []
        self.cancel = cancel

    def progress(self, stage: str, done: int, total: int, **extra: Any) -> None:
        self.progress_calls.append({"stage": stage, "done": done, "total": total, **extra})

    def log(self, level: str, message: str) -> None:
        self.logs.append((level, message))

    def check_cancel(self) -> None:
        if self.cancel:
            raise Canceled()

    def artifact(self, path: str, kind: str = "") -> None:
        pass


class LocalEntryNotFoundError(Exception):
    """與 huggingface_hub.errors 同名（classify_error 只比型別名稱，不 import huggingface_hub）。"""


class ConnectError(Exception):
    pass


class GatedRepoError(Exception):
    pass


class FakeHub:
    """假 snapshot_download：記錄呼叫、在 cache_dir 底下照 HF 的快取結構寫檔，並驅動 tqdm_class 模擬進度。"""

    def __init__(self, *, fail: BaseException | None = None, partial: bool = False, truncated: bool = False) -> None:
        self.calls: list[dict[str, Any]] = []
        self.downloaded: set[str] = set()
        self.fail = fail
        self.partial = partial
        self.truncated = truncated  # 權重寫到一半（下載中斷／磁碟滿）

    def snapshot_dir(self, cache_dir: str, repo: str) -> Path:
        return Path(cache_dir) / ("models--" + repo.replace("/", "--")) / "snapshots" / "0123abcd"

    def __call__(self, **kw: Any) -> str:
        self.calls.append(kw)
        repo, cache_dir = kw["repo_id"], kw["cache_dir"]
        d = self.snapshot_dir(cache_dir, repo)
        if kw.get("local_files_only"):
            if repo in self.downloaded or d.is_dir():
                return str(d)
            raise LocalEntryNotFoundError("Cannot find an appropriate cached snapshot folder")
        if self.fail is not None:
            raise self.fail
        tq = kw.get("tqdm_class")
        if tq is not None:
            files = tq(total=3, desc="Fetching 3 files", unit="it")  # 檔數條：有位元組條之後不轉發
            transfer = tq(total=0, desc="Downloading bytes", unit="B", unit_scale=True)  # 網路傳輸條：不轉發
            recon = tq(total=0, desc="Reconstructing (incomplete total...)", unit="B", unit_scale=True)
            recon.total = 1000
            transfer.total = 900
            transfer.update(900)
            recon.update(400)
            recon.update(600)
            files.update(3)
            for b in (files, transfer, recon):
                b.close()
        d.mkdir(parents=True, exist_ok=True)
        for f in ("config.json", "preprocessor_config.json", "processor_config.json", "video_preprocessor_config.json"):
            (d / f).write_text("{}", encoding="utf-8")
        if not self.partial:
            (d / "model.safetensors").write_bytes(_safetensors_blob(1000, truncated=self.truncated))
        self.downloaded.add(repo)
        return str(d)


def _safetensors_blob(size: int, *, truncated: bool = False) -> bytes:
    """safetensors 的實際佈局：8 bytes 小端 header 長度 + header JSON + 張量資料。
    `snapshot_complete` 會驗這個檔頭自洽（只看「不是 0 bytes」抓不到下載中斷的半個檔）。"""
    header = b'{"__metadata__":{"format":"pt"}}'
    blob = len(header).to_bytes(8, "little") + header + bytes(size)
    return blob[: 8 + len(header) // 2] if truncated else blob


@pytest.fixture()
def hf_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "hf"
    monkeypatch.setenv("HF_HOME", str(home))
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
    return home


@pytest.fixture()
def hub(monkeypatch: pytest.MonkeyPatch, hf_home: Path) -> FakeHub:
    fake = FakeHub()
    monkeypatch.setattr(MO, "_snapshot_download", fake)
    return fake


def _online(fake: FakeHub) -> list[dict[str, Any]]:
    return [c for c in fake.calls if not c.get("local_files_only")]


# ---------------------------------------------------------------- models.pull


def test_registered_as_cli_models_with_pull_action() -> None:
    from aivc.ops import CLI_INDEX, REGISTRY

    load_all()
    op = REGISTRY["models.pull"]
    assert op.cli == "models" and CLI_INDEX["models"] is op and op.gpu is False


def test_variants_default_small_always_included() -> None:
    assert MO.variants_for(None) == ["small"]
    assert MO.variants_for("small") == ["small"]
    assert MO.variants_for("large") == ["small", "large"]
    assert MO.variants_for("tiny") == ["small", "tiny"]


def test_pull_downloads_small_into_hf_home(hub: FakeHub, hf_home: Path) -> None:
    ctx = RecordingCtx()
    r = MO.pull_op({"action": "pull", "sam": "small"}, ctx)
    assert [m["repo"] for m in r["models"]] == ["facebook/sam2.1-hiera-small"]
    m = r["models"][0]
    assert m["cached"] is False and m["bytes"] > 1000
    assert Path(m["path"]).is_relative_to(hf_home / "hub")
    assert r["hfHome"] == str(hf_home) and r["hubCache"] == str(hf_home / "hub")
    (call,) = _online(hub)
    # 只抓 transformers 要的檔（不抓同樣大的原版 .pt）、快取位置明確指定
    assert call["allow_patterns"] == ["*.json", "*.safetensors"] and call["cache_dir"] == str(hf_home / "hub")
    assert call["force_download"] is False


def test_pull_large_also_pulls_default_small(hub: FakeHub) -> None:
    r = MO.pull_op({"sam": "large"}, RecordingCtx())  # sidecar 路徑：args 沒有 action
    assert [m["repo"] for m in r["models"]] == ["facebook/sam2.1-hiera-small", "facebook/sam2.1-hiera-large"]
    assert [c["repo_id"] for c in _online(hub)] == ["facebook/sam2.1-hiera-small", "facebook/sam2.1-hiera-large"]


def test_pull_is_idempotent_and_offline_friendly(hub: FakeHub, monkeypatch: pytest.MonkeyPatch) -> None:
    MO.pull_op({"sam": "small"}, RecordingCtx())
    n_online = len(_online(hub))
    # 第二次：就算設了 HF_HUB_OFFLINE（沒網路）也要成功，而且完全不走下載
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    ctx = RecordingCtx()
    r = MO.pull_op({"sam": "small"}, ctx)
    assert r["models"][0]["cached"] is True and len(_online(hub)) == n_online
    assert any("已在本機快取" in msg for _, msg in ctx.logs)


def test_force_redownloads(hub: FakeHub) -> None:
    MO.pull_op({"sam": "small"}, RecordingCtx())
    r = MO.pull_op({"sam": "small", "force": True}, RecordingCtx())
    assert r["models"][0]["cached"] is False
    assert _online(hub)[-1]["force_download"] is True


def test_partial_snapshot_is_not_treated_as_cached(monkeypatch: pytest.MonkeyPatch, hf_home: Path) -> None:
    fake = FakeHub(partial=True)  # 中斷的下載：json 都在、safetensors 沒有
    monkeypatch.setattr(MO, "_snapshot_download", fake)
    with pytest.raises(OpError) as e:
        MO.pull_op({"sam": "small"}, RecordingCtx())
    assert e.value.kind == "Model" and "缺必要檔" in str(e.value)
    assert MO.cached_snapshot("facebook/sam2.1-hiera-small", hf_home / "hub") is None
    fake.partial = False
    r = MO.pull_op({"sam": "small"}, RecordingCtx())
    assert r["models"][0]["cached"] is False  # 半套快照要重新下載，不能回報「已在快取」


def test_truncated_weights_are_not_treated_as_cached(monkeypatch: pytest.MonkeyPatch, hf_home: Path) -> None:
    """下載中斷留下半個 model.safetensors（B-05）：以前 `snapshot_complete` 只看「不是 0 bytes」，
    所以 `aivc models pull` 印「已在快取」什麼也不做，SAM 每次都在同一個地方失敗 ——
    而錯誤訊息給的提示（跑 `aivc models pull`）正好是那個沒用的指令。只有 `--force` 救得回來。"""
    fake = FakeHub(truncated=True)
    monkeypatch.setattr(MO, "_snapshot_download", fake)
    with pytest.raises(OpError) as e:
        MO.pull_op({"sam": "small"}, RecordingCtx())
    assert e.value.kind == "Model" and "缺必要檔" in str(e.value)
    assert MO.cached_snapshot("facebook/sam2.1-hiera-small", hf_home / "hub") is None, "截斷的權重不算有快取"
    fake.truncated = False
    r = MO.pull_op({"sam": "small"}, RecordingCtx())
    assert r["models"][0]["cached"] is False, "壞掉的快取要重新下載，不能回報「已在快取」"


def test_progress_events_forward_written_bytes_only(hub: FakeHub) -> None:
    ctx = RecordingCtx()
    MO.pull_op({"sam": "small"}, ctx)
    ev = [p for p in ctx.progress_calls if p["unit"] == "bytes" and p["total"] == 1000]
    assert [(p["done"], p["total"]) for p in ev] == [(400, 1000), (1000, 1000)]
    assert all(p["stage"] == "models.pull" and p["repo"] == "facebook/sam2.1-hiera-small" for p in ctx.progress_calls)
    assert not any(p["total"] == 900 for p in ctx.progress_calls), "網路傳輸條不轉發（會與寫入位元組條互相跳動）"
    assert not any(p["unit"] == "files" for p in ctx.progress_calls), "有位元組進度時不轉發檔數條"


def test_progress_tqdm_falls_back_to_file_count_and_is_silent(capsys: pytest.CaptureFixture[str]) -> None:
    ctx = RecordingCtx()
    cls = MO.progress_tqdm(ctx, "facebook/sam2.1-hiera-small")
    bar = cls(total=4, desc="Fetching 4 files", name="huggingface_hub.snapshot_download")  # 舊版只給檔數條；name 要被吃掉
    bar.update(2)
    bar.update(2)
    bar.close()
    assert [(p["done"], p["total"], p["unit"]) for p in ctx.progress_calls] == [(2, 4, "files"), (4, 4, "files")]
    out = capsys.readouterr()
    assert out.out == "" and out.err == ""  # 進度條不能印到 stdout（--json）或 stderr


def test_cancel_during_download(hub: FakeHub) -> None:
    with pytest.raises(Canceled):
        MO.pull_op({"sam": "small"}, RecordingCtx(cancel=True))


def test_cancel_wrapped_by_hub_is_still_cancel(monkeypatch: pytest.MonkeyPatch, hf_home: Path) -> None:
    class XetDownloadError(Exception):
        pass

    def wrapped(**kw: Any) -> str:
        if kw.get("local_files_only"):
            raise LocalEntryNotFoundError("no")
        try:
            raise Canceled()
        except Canceled as c:
            raise XetDownloadError("download thread failed") from c

    monkeypatch.setattr(MO, "_snapshot_download", wrapped)
    with pytest.raises(Canceled):
        MO.pull_op({"sam": "small"}, RecordingCtx())


def _chained(outer: BaseException, cause: BaseException) -> BaseException:
    outer.__cause__ = cause
    return outer


def test_offline_error_is_model_with_actionable_hint(monkeypatch: pytest.MonkeyPatch, hf_home: Path) -> None:
    err = _chained(LocalEntryNotFoundError("An error happened while trying to locate the files on the Hub"), ConnectError("[Errno 111] Connection refused"))
    monkeypatch.setattr(MO, "_snapshot_download", FakeHub(fail=err))
    with pytest.raises(OpError) as e:
        MO.pull_op({"sam": "small"}, RecordingCtx())
    assert e.value.kind == "Model"
    assert "連不上 Hugging Face" in str(e.value) and "facebook/sam2.1-hiera-small" in str(e.value)
    hint = e.value.hint
    assert "HTTPS_PROXY" in hint and "HF_ENDPOINT" in hint
    assert "models--facebook--sam2.1-hiera-small" in hint and str(hf_home / "hub") in hint
    assert "第一次用到 SAM 2.1 時會自動下載" in hint


def test_hf_hub_offline_env_is_named(monkeypatch: pytest.MonkeyPatch, hf_home: Path) -> None:
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    monkeypatch.setattr(MO, "_snapshot_download", FakeHub(fail=LocalEntryNotFoundError("outgoing traffic has been disabled")))
    with pytest.raises(OpError) as e:
        MO.pull_op({"sam": "small"}, RecordingCtx())
    assert e.value.kind == "Model" and "HF_HUB_OFFLINE=1" in str(e.value)


def test_gated_and_disk_full_errors(hf_home: Path) -> None:
    hub_dir = hf_home / "hub"
    e = MO.classify_error(GatedRepoError("401 Client Error"), "facebook/sam2.1-hiera-large", hub_dir)
    assert e.kind == "Model" and "HF_TOKEN" in e.hint
    full = OSError(28, "No space left on device")
    e = MO.classify_error(_chained(RuntimeError("write failed"), full), "facebook/sam2.1-hiera-large", hub_dir)
    assert e.kind == "Io" and "磁碟空間不足" in str(e)


def test_cli_models_pull_json(hub: FakeHub, capsys: pytest.CaptureFixture[str]) -> None:
    from aivc.cli import main

    code = main(["--json", "models", "pull", "--sam", "large"])
    lines = [json.loads(x) for x in capsys.readouterr().out.strip().splitlines()]
    assert code == 0 and lines[-1]["ok"] is True
    assert [m["variant"] for m in lines[-1]["result"]["models"]] == ["small", "large"]
    assert any(x.get("event") == "progress" and x.get("stage") == "models.pull" for x in lines[:-1])


def test_cli_models_help_and_bad_args(capsys: pytest.CaptureFixture[str]) -> None:
    from aivc.cli import main

    # bootstrap-engine.sh 先跑 `aivc models --help` 判斷有沒有這個指令：必須退出碼 0
    with pytest.raises(SystemExit) as e:
        main(["models", "--help"])
    assert e.value.code == 0 and "pull" in capsys.readouterr().out
    with pytest.raises(SystemExit) as e:
        main(["models", "pull", "--sam", "huge"])
    assert e.value.code == 2
    with pytest.raises(SystemExit) as e:
        main(["models"])  # 沒給動作不能默默開始下載
    assert e.value.code == 2


def test_cli_offline_exit_code_is_model(monkeypatch: pytest.MonkeyPatch, hf_home: Path, capsys: pytest.CaptureFixture[str]) -> None:
    from aivc.cli import main

    monkeypatch.setattr(MO, "_snapshot_download", FakeHub(fail=_chained(LocalEntryNotFoundError("x"), ConnectError("refused"))))
    assert main(["models", "pull", "--sam", "small"]) == 4  # Model → 4；bootstrap .sh 把非 0 當警告、不擋安裝
    assert "連不上 Hugging Face" in capsys.readouterr().err


# ---------------------------------------------------------------- MPS 記憶體不足 → Gpu

MPS_OOM = (
    "MPS backend out of memory (MPS allocated: 17.52 GB, other allocations: 1.02 GB, max allowed: 18.13 GB). "
    "Tried to allocate 256.00 MB on private pool. Use PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0 to disable upper limit "
    "for memory allocations (may cause system failure)."
)


def test_mps_oom_is_gpu_error() -> None:
    e = errors.from_exception(RuntimeError(MPS_OOM))
    assert e.kind == "Gpu" and e.hint == errors.MPS_OOM_HINT
    assert "共用記憶體" in e.hint and "--sam tiny" in e.hint

    class OutOfMemoryError(RuntimeError):  # torch.OutOfMemoryError 的同名替身
        pass

    e = errors.from_exception(OutOfMemoryError(MPS_OOM))
    assert e.kind == "Gpu" and e.hint == errors.MPS_OOM_HINT
    e = errors.from_exception(MemoryError("MPS allocation failed"))
    assert e.kind == "Gpu" and e.hint == errors.MPS_OOM_HINT


def test_cuda_oom_unchanged_and_no_false_positive() -> None:
    e = errors.from_exception(RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB"))
    assert e.kind == "Gpu" and e.hint == errors.CUDA_OOM_HINT
    # 「timestamps」「room」這種子字串不能被當成 MPS OOM
    e = errors.from_exception(RuntimeError("no room left for timestamps in buffer"))
    assert e.kind == "Internal"
    e = errors.from_exception(RuntimeError("MPS does not support float64"))
    assert e.kind == "Internal"
    assert errors.from_exception(MemoryError("plain host allocation failed")).kind == "Internal"


# ---------------------------------------------------------------- serve hello／ping 的裝置欄位


def _fake_torch(*, cuda: bool = False, mps: bool = False, version: str = "2.14.0") -> Any:
    t = types.SimpleNamespace(__version__=version, float16="fp16", float32="fp32", bfloat16="bf16")
    t.cuda = types.SimpleNamespace(
        is_available=lambda: cuda,
        get_device_name=lambda i=0: "NVIDIA GeForce RTX 5070 Ti",
        get_device_capability=lambda i=0: (12, 0),
        get_device_properties=lambda i=0: types.SimpleNamespace(total_memory=16 * 1024**3),
        memory_allocated=lambda: 300 * 1024**2,
    )
    t.mps = types.SimpleNamespace(current_allocated_memory=lambda: 2 * 1024**3, driver_allocated_memory=lambda: 3 * 1024**3)
    t.backends = types.SimpleNamespace(mps=types.SimpleNamespace(is_available=lambda: mps, is_built=lambda: True))
    return t


def _server() -> Any:
    from aivc.serve import Server

    return Server(io.BytesIO(), io.BytesIO(), io.StringIO(), torch_probe=False)


def _on(monkeypatch: pytest.MonkeyPatch, plat: str, machine: str) -> None:
    monkeypatch.setattr(dev.sys, "platform", plat)
    monkeypatch.setattr(dev.platform, "machine", lambda: machine)
    monkeypatch.delenv("AIVC_ALLOW_CPU", raising=False)


def test_hello_and_ping_report_mps(monkeypatch: pytest.MonkeyPatch) -> None:
    _on(monkeypatch, "darwin", "arm64")
    monkeypatch.setattr(dev, "apple_chip_name", lambda: "Apple M3 Max")
    monkeypatch.setattr(dev, "unified_memory_mb", lambda: 36 * 1024)
    monkeypatch.setitem(sys.modules, "torch", _fake_torch(mps=True))
    s = _server()
    h = s.hello_info(probe_torch=True)
    assert "torchError" not in h, h.get("torchError")
    assert h["backend"] == "mps" and h["mps"] is True and h["cuda"] is False
    assert h["device"] == "Apple M3 Max" and h["memoryMB"] == 36 * 1024 and h["unifiedMemory"] is True
    assert h["dtype"] == "float16" and h["capability"] is None
    p = s.ping_info()
    assert p["backend"] == "mps" and p["vram_used_mb"] == 2048  # torch.mps.current_allocated_memory


def test_hello_and_ping_report_cuda(monkeypatch: pytest.MonkeyPatch) -> None:
    _on(monkeypatch, "win32", "AMD64")
    monkeypatch.setitem(sys.modules, "torch", _fake_torch(cuda=True, version="2.14.0+cu130"))
    s = _server()
    h = s.hello_info(probe_torch=True)
    assert h["backend"] == "cuda" and h["cuda"] is True and h["device"] == "NVIDIA GeForce RTX 5070 Ti"
    assert h["capability"] == "12.0" and h["memoryMB"] == 16384 and h["dtype"] == "bfloat16"
    p = s.ping_info()
    assert p["backend"] == "cuda" and p["vram_used_mb"] == 300


def test_hello_and_ping_cpu_only_when_allowed(monkeypatch: pytest.MonkeyPatch) -> None:
    _on(monkeypatch, "linux", "x86_64")
    monkeypatch.setitem(sys.modules, "torch", _fake_torch(version="2.14.0+cpu"))
    s = _server()
    h = s.hello_info(probe_torch=True)
    assert h["backend"] is None and h["deviceReason"] and s.ping_info()["backend"] is None
    monkeypatch.setenv("AIVC_ALLOW_CPU", "1")
    s = _server()
    h = s.hello_info(probe_torch=True)
    assert h["backend"] == "cpu" and h["cuda"] is False and h["mps"] is False
    p = s.ping_info()
    assert p["backend"] == "cpu" and p["vram_used_mb"] is None


def test_ping_does_not_import_torch(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delitem(sys.modules, "torch", raising=False)
    s = _server()
    p = s.ping_info()
    assert p["backend"] is None and p["vram_used_mb"] is None and "torch" not in sys.modules
    h = s.hello_info(probe_torch=False)
    assert h["backend"] is None and h["device"] is None and h["torch"] is None


# ---------------------------------------------------------------- --device 預設 auto


@pytest.mark.parametrize(
    "argv",
    [
        ["seg", "clip.mp4", "--frames", "0:10"],
    ],
)
def test_seg_and_run_device_default_auto(argv: list[str]) -> None:
    """（`run` 那條在牌局外掛的 test_run.py：`aivc run` 是外掛的 op。）"""
    from aivc.cli import build_parser

    ns = build_parser().parse_args(argv)
    assert ns.device == "auto"


def test_auto_resolves_like_select_device(monkeypatch: pytest.MonkeyPatch) -> None:
    _on(monkeypatch, "darwin", "arm64")
    assert dev.resolve_device("auto", _fake_torch(mps=True)) == "mps"
    _on(monkeypatch, "linux", "x86_64")
    assert dev.resolve_device("auto", _fake_torch(cuda=True, version="2.14.0+cu130")) == "cuda"
    with pytest.raises(dev.DeviceUnavailable):
        dev.resolve_device("auto", _fake_torch(version="2.14.0+cpu"))  # 沒有 GPU 也沒放行 CPU：報錯，不悄悄跑 CPU
