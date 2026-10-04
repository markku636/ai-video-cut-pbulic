"""sidecar 兩個整合時才抓到的 bug 的回歸測試（2026-09-17 App 內煙霧測試）。

1. Windows 死結：主執行緒卡在管線 stdin 的同步 ReadFile 時，worker 執行緒 import 原生擴充（scipy.linalg）
   會卡到 stdin 來下一行為止。修正前這個測試的 job 要等 ping 才會完成；修正後不送任何東西也要在幾秒內完成。
2. 進度節流：整個 job 共用一個節流器時，`pipeline.run` 的 step 標記常在上一個子 stage 事件 250 ms 內被吃掉。
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from aivc.serve import Job, ServeCtx

ENGINE = Path(__file__).resolve().parents[1]
FAKE_OPS_DIR = ENGINE / "tests" / "fixtures" / "protocol"


@pytest.mark.skipif(os.name != "nt", reason="同步 I/O 序列化是 Windows 行為")
def test_worker_native_import_does_not_wait_for_stdin() -> None:
    pytest.importorskip("scipy")
    env = dict(os.environ)
    env["PYTHONUTF8"] = "1"
    env["AIVC_EXTRA_OPS"] = "aivc_native_ops"
    env["PYTHONPATH"] = os.pathsep.join([str(FAKE_OPS_DIR), str(ENGINE / "src"), env.get("PYTHONPATH", "")])
    proc = subprocess.Popen(
        [sys.executable, "-X", "utf8", "-m", "aivc", "serve"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
    )
    replies: dict[str, dict[str, Any]] = {}

    def reader() -> None:
        assert proc.stdout is not None
        for raw in proc.stdout:
            try:
                obj = json.loads(raw.decode("utf-8"))
            except ValueError:
                continue
            if "ok" in obj:
                replies[str(obj["id"])] = obj

    threading.Thread(target=reader, daemon=True).start()

    def send(obj: dict[str, Any]) -> None:
        assert proc.stdin is not None
        proc.stdin.write((json.dumps(obj) + "\n").encode("utf-8"))
        proc.stdin.flush()

    def wait_for(rid: str, timeout: float) -> dict[str, Any] | None:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if rid in replies:
                return replies[rid]
            time.sleep(0.05)
        return None

    try:
        send({"id": "h", "op": "hello", "args": {"torch": False}})  # 不讓 hello 預先載入 torch（那會掩蓋問題）
        assert wait_for("h", 60) is not None, "hello 沒回"
        send({"id": "j", "op": "test.native_import", "args": {"modules": ["scipy.linalg"]}})
        # 修正前：這裡一直等不到（直到下一行 stdin 進來）；修正後 scipy.linalg 冷載入 < 1 s
        got = wait_for("j", 20)
        assert got is not None, "worker 的原生 import 卡住了：標準輸入 handle 仍指向管線"
        assert got["ok"] is True
    finally:
        try:
            send({"id": "s", "op": "shutdown"})
            proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            proc.kill()


class _Recorder:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def _emit(self, obj: dict[str, Any]) -> None:
        self.events.append(obj)


def test_progress_throttle_is_per_stage_and_step_changes_always_emit() -> None:
    rec = _Recorder()
    ctx = ServeCtx(rec, Job("j", "pipeline.run", {}))  # type: ignore[arg-type]
    # 同一個 job 在 250 ms 內連續換 step：每個 step 標記都必須送出
    for i, step in enumerate(["probe", "index", "shots", "detect", "seg"]):
        ctx.progress("pipeline", i, 9, step=step)
        ctx.progress("detect" if step == "detect" else "sub", 1, 100)  # 子 stage 事件夾在中間
    steps = [e.get("step") for e in rec.events if e["stage"] == "pipeline"]
    assert steps == ["probe", "index", "shots", "detect", "seg"]
    # 同 stage、同 step 的密集事件仍被節流（不能把管線寫爆）
    before = len(rec.events)
    for d in range(2, 60):
        ctx.progress("sub", d, 100)
    assert len(rec.events) - before <= 2


def test_detach_std_input_is_noop_for_injected_streams(monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc import serve

    # 測試注入 BytesIO（沒有真 fd）時必須回 None、不動 sys.stdin
    fake = io.TextIOWrapper(io.BytesIO(b""))
    monkeypatch.setattr(sys, "stdin", fake)
    assert serve.detach_std_input() is None
    assert sys.stdin is fake
