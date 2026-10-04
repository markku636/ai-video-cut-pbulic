"""B-09 優雅停止：shutdown 先取消所有工作再回覆；渲染到一半收到 shutdown → 回 Canceled、不留 .part、行程 1 秒內自己退出。

修正前（2026-09-17 稽核 REL-6）：Rust stop() 一收到 shutdown 回覆就硬殺，引擎的收尾（kill ffmpeg、刪 .part）來不及跑，
使用者的輸出資料夾留下 1.2 MB 的 `<out>.part`、工作顯示「引擎錯誤：引擎已停止」。Rust 端的等待在 engine.rs 的假引擎測試；
這裡釘住引擎這一側：回覆送出時取消旗標已經設好，真的 render.run 收尾乾淨。
"""
from __future__ import annotations

import io
import json
import sys
import time
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures" / "protocol"))
from serve_client import Client, make_scene  # noqa: E402

from aivc import env  # noqa: E402
from aivc.serve import Job, Server  # noqa: E402


class _Out(io.BytesIO):
    """記下 shutdown 回覆寫出的那一刻，排隊／執行中的工作是不是已經被設了取消。"""

    def __init__(self, job: Job) -> None:
        super().__init__()
        self.job = job
        self.cancel_at_reply: bool | None = None

    def write(self, b: Any) -> int:
        for line in bytes(b).splitlines():
            msg = json.loads(line)
            if msg.get("id") == "s" and "ok" in msg:
                self.cancel_at_reply = self.job.cancel.is_set()
        return super().write(b)


def test_shutdown_sets_cancel_before_replying() -> None:
    job = Job("render", "render.run", {})
    out = _Out(job)
    srv = Server(io.BytesIO(b'{"id":"s","op":"shutdown"}\n'), out, io.StringIO(), torch_probe=False)
    with srv._jobs_lock:
        srv._jobs[job.id] = job  # 模擬執行中的渲染（不用真的跑 worker）
    srv._handle_line(b'{"id":"s","op":"shutdown"}\n')
    assert out.cancel_at_reply is True, "Rust 收到回覆時工作必須已經在取消（之後才可能被硬殺）"
    assert srv._stopping.is_set()


@pytest.fixture
def scene(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")
    root = tmp_path / "換花色 停止"
    root.mkdir()
    monkeypatch.setenv("AIVC_CACHE_DIR", str(root / "cache"))
    return make_scene(root, 90, tmp_path / "deck dir")


def test_shutdown_mid_render_replies_canceled_and_leaves_no_part(scene: tuple[Path, Path]) -> None:
    ppath, _ = scene
    out_dir = ppath.parent / "輸出 資料夾"
    out = out_dir / "成品 stop.mkv"
    c = Client()
    try:
        c.send({"id": "r", "op": "render.run", "args": {"project": str(ppath), "out": str(out), "codec": "ffv1", "no_gpu": True}})
        c.wait_event(lambda e: e.get("id") == "r" and e.get("event") == "progress" and e.get("stage") == "render" and int(e.get("done") or 0) >= 5, 60)
        parts_mid = [p.name for p in out_dir.glob("*.part")]
        c.send({"id": "s", "op": "shutdown"})
        ts, s = c.reply("s", 5)
        assert s["ok"] is True
        tr, r = c.reply("r", 5)
        assert r["ok"] is False and r["error"]["kind"] == "Canceled", r
        assert c.proc.wait(timeout=5) == 0
        exit_s = time.monotonic() - ts
        assert exit_s < 1.0, f"收到 shutdown 後 {exit_s:.2f}s 才退出"
        assert parts_mid, "前提：渲染中途確實有 .part"
        assert not [p.name for p in out_dir.glob("*.part")], "不能留下 .part"
        assert not out.exists()
    finally:
        c.close()
