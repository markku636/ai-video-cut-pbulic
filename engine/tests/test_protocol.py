"""`aivc serve` 的 JSONL 協定：真的 spawn 子行程（同一個 python），用假 op 模組（AIVC_EXTRA_OPS）驗證線路。

驗：hello、framing（多請求各恰一回覆、非 ASCII）、進度順序、中途 cancel、錯誤映射、非 UTF-8 行容忍、忙碌中 ping、shutdown。
"""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

ENGINE = Path(__file__).resolve().parents[1]
FAKE_OPS_DIR = ENGINE / "tests" / "fixtures" / "protocol"


class Client:
    """一個 serve 子行程 + 讀 stdout 的執行緒（stderr 也一定要有人排空，否則 Windows 64 KB 管線塞住）。"""

    def __init__(self, extra_args: list[str] | None = None) -> None:
        env = dict(os.environ)
        env["AIVC_EXTRA_OPS"] = "aivc_fake_ops"
        env["PYTHONPATH"] = os.pathsep.join([str(FAKE_OPS_DIR), str(ENGINE / "src"), env.get("PYTHONPATH", "")])
        env["PYTHONUTF8"] = "1"
        env.pop("AIVC_RUN_GPU_TESTS", None)
        self.proc = subprocess.Popen(
            [sys.executable, "-X", "utf8", "-m", "aivc", "serve", "--no-torch-probe", *(extra_args or [])],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=str(ENGINE),
            env=env,
        )
        self.lines: "queue.Queue[bytes]" = queue.Queue()
        self.stderr: list[str] = []
        self._t_out = threading.Thread(target=self._pump_out, daemon=True)
        self._t_err = threading.Thread(target=self._pump_err, daemon=True)
        self._t_out.start()
        self._t_err.start()

    def _pump_out(self) -> None:
        assert self.proc.stdout is not None
        for raw in self.proc.stdout:
            self.lines.put(raw)

    def _pump_err(self) -> None:
        assert self.proc.stderr is not None
        for raw in self.proc.stderr:
            self.stderr.append(raw.decode("utf-8", "replace").rstrip())

    def send_raw(self, data: bytes) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def send(self, obj: dict[str, Any]) -> None:
        self.send_raw(json.dumps(obj, ensure_ascii=False).encode("utf-8") + b"\n")

    def recv(self, timeout: float = 10.0) -> dict[str, Any]:
        raw = self.lines.get(timeout=timeout)
        text = raw.decode("utf-8")  # stdout 必須是合法 UTF-8
        assert text.endswith("\n") and "\n" not in text[:-1]
        return json.loads(text)

    def recv_until_reply(self, rid: Any, timeout: float = 15.0) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        """收集該 id 的事件直到回覆；其他 id 的訊息也存起來（回傳於 events）。"""
        deadline = time.monotonic() + timeout
        events: list[dict[str, Any]] = []
        while True:
            msg = self.recv(max(0.1, deadline - time.monotonic()))
            if msg.get("id") == rid and "ok" in msg:
                return events, msg
            events.append(msg)

    def close(self) -> None:
        try:
            if self.proc.poll() is None:
                self.send({"id": "bye", "op": "shutdown"})
                self.proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            self.proc.kill()
        finally:
            for s in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
                try:
                    if s:
                        s.close()
                except Exception:  # noqa: BLE001
                    pass


@pytest.fixture
def client() -> Any:
    c = Client()
    try:
        yield c
    finally:
        c.close()


def test_hello(client: Client) -> None:
    client.send({"id": "h1", "op": "hello", "args": {"torch": False}})
    r = client.recv()
    assert r["id"] == "h1" and r["ok"] is True
    res = r["result"]
    assert res["protocol"] == 1
    assert res["python"].startswith("3.12")
    assert res["torch"] is None and res["cuda"] is False and res["device"] is None
    # venv 的 python.exe 是 launcher，會再 spawn 真正的直譯器 → 子行程回報的 pid 與 Popen.pid 不同是正常的
    assert "version" in res and isinstance(res.get("pid"), int) and res["pid"] > 0
    assert res.get("cv2")  # cv2 一定要 import 得到


def test_framing_multiple_requests_each_exactly_one_reply(client: Client) -> None:
    for i in range(3):
        client.send({"id": f"e{i}", "op": "test.echo", "args": {"i": i, "text": "中文 ✓"}})
    got: dict[str, list[dict[str, Any]]] = {f"e{i}": [] for i in range(3)}
    n_log = 0
    deadline = time.monotonic() + 10
    while any(not any("ok" in m for m in v) for v in got.values()) and time.monotonic() < deadline:
        m = client.recv()
        if m.get("event") == "log":
            n_log += 1
            continue
        got[m["id"]].append(m)
    for i in range(3):
        replies = [m for m in got[f"e{i}"] if "ok" in m]
        assert len(replies) == 1, replies
        assert replies[0]["ok"] and replies[0]["result"] == {"echo": {"i": i, "text": "中文 ✓"}}
    assert n_log == 3
    # 序列執行：回覆順序 = 送出順序
    client.send({"id": 42, "op": "test.echo", "args": {}})  # 整數 id 也要原樣回
    _, r = client.recv_until_reply(42)
    assert r["id"] == 42 and r["result"] == {"echo": {}}


def test_progress_ordering_and_single_reply(client: Client) -> None:
    client.send({"id": "p1", "op": "test.slow", "args": {"n": 12, "dt": 0.05}})
    events, reply = client.recv_until_reply("p1")
    prog = [e for e in events if e.get("event") == "progress"]
    assert prog, events
    assert all(e["id"] == "p1" and e["stage"] == "slow" and e["total"] == 12 for e in prog)
    dones = [e["done"] for e in prog]
    assert dones == sorted(dones)
    assert dones[-1] == 12  # 最後一筆一定送（done == total）
    assert len(prog) <= 6  # 12 步 × 50 ms = 600 ms，250 ms 節流 → 最多首筆+2~3 筆+末筆
    assert reply["ok"] is True and reply["result"] == {"steps": 12}
    # 回覆後不會再有這個 id 的訊息
    client.send({"id": "ping-after", "op": "ping"})
    r = client.recv()
    assert r["id"] == "ping-after"


def test_cancel_mid_op_then_server_still_alive(client: Client) -> None:
    client.send({"id": "j1", "op": "test.slow", "args": {"n": 400, "dt": 0.05}})  # 20 s，若 cancel 沒效測試會 timeout
    first = client.recv()
    assert first.get("event") == "progress" and first["id"] == "j1"
    t0 = time.monotonic()
    client.send({"id": "c1", "op": "cancel", "args": {"id": "j1"}})
    seen_cancel_reply = False
    job_reply = None
    while job_reply is None:
        m = client.recv(timeout=5)
        if m.get("id") == "c1":
            assert m["ok"] and m["result"]["found"] is True and m["result"]["running"] is True
            seen_cancel_reply = True
        elif m.get("id") == "j1" and "ok" in m:
            job_reply = m
    assert seen_cancel_reply
    assert time.monotonic() - t0 < 3.0  # 合作式取消：一步之內
    assert job_reply["ok"] is False and job_reply["error"]["kind"] == "Canceled"
    # 行程還活著、可以接下一個
    client.send({"id": "e", "op": "test.echo", "args": {"after": "cancel"}})
    _, r = client.recv_until_reply("e")
    assert r["ok"] and r["result"]["echo"] == {"after": "cancel"}
    # cancel 不存在的 id
    client.send({"id": "c2", "op": "cancel", "args": {"id": "nope"}})
    r = client.recv()
    assert r["id"] == "c2" and r["ok"] and r["result"]["found"] is False


def test_cancel_queued_job_before_it_starts(client: Client) -> None:
    client.send({"id": "a", "op": "test.slow", "args": {"n": 8, "dt": 0.05}})
    client.send({"id": "b", "op": "test.slow", "args": {"n": 8, "dt": 0.05}})
    client.send({"id": "cb", "op": "cancel", "args": {"id": "b"}})
    replies: dict[str, dict[str, Any]] = {}
    while not {"a", "b", "cb"} <= set(replies):
        m = client.recv()
        if "ok" in m:
            replies[m["id"]] = m
    assert replies["cb"]["result"] == {"id": "b", "found": True, "running": False}
    assert replies["a"]["ok"] is True
    assert replies["b"]["ok"] is False and replies["b"]["error"]["kind"] == "Canceled"


def test_error_mapping(client: Client) -> None:
    client.send({"id": "f1", "op": "test.fail_op", "args": {"kind": "Model", "message": "缺 SAM2 權重", "hint": "aivc models pull"}})
    _, r = client.recv_until_reply("f1")
    assert r["ok"] is False and r["error"] == {"kind": "Model", "message": "缺 SAM2 權重", "hint": "aivc models pull"}

    client.send({"id": "f2", "op": "test.boom", "args": {"message": "kaboom 爆了"}})
    _, r = client.recv_until_reply("f2")
    assert r["ok"] is False
    assert r["error"]["kind"] == "Internal"
    assert r["error"]["message"] == "RuntimeError: kaboom 爆了"
    assert "RuntimeError: kaboom 爆了" in r["error"]["hint"]

    client.send({"id": "f3", "op": "no.such.op", "args": {}})
    _, r = client.recv_until_reply("f3")
    assert r["error"]["kind"] == "Invalid" and "no.such.op" in r["error"]["message"]

    client.send({"id": "f4", "op": "test.echo", "args": "not-a-dict"})
    _, r = client.recv_until_reply("f4")
    assert r["error"]["kind"] == "Invalid"

    client.send({"id": "f5"})
    _, r = client.recv_until_reply("f5")
    assert r["error"]["kind"] == "Invalid"

    # 行程仍活著；traceback 進了 stderr（不是 stdout）
    client.send({"id": "e", "op": "test.echo", "args": {}})
    _, r = client.recv_until_reply("e")
    assert r["ok"]
    time.sleep(0.2)
    assert any("RuntimeError: kaboom" in line for line in client.stderr)


def test_op_error_is_also_written_to_stderr(client: Client) -> None:
    """B-11：OpError 以前只走回覆線路，engine.log 裡什麼都沒有 —— 死因常常只在 hint 裡（ffmpeg 的 Permission denied）。"""
    client.send({"id": "f1", "op": "test.fail_op", "args": {"kind": "Ffmpeg", "message": "ffmpeg 提前結束（寫入管線失敗）", "hint": "Error opening output file: Permission denied"}})
    _, r = client.recv_until_reply("f1")
    assert r["ok"] is False
    # 回覆之後 stderr 可能還沒被 pump 讀到：等一下再看
    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline and not any("test.fail_op" in line for line in client.stderr):
        time.sleep(0.05)
    logged = [line for line in client.stderr if "test.fail_op" in line]
    assert logged, f"OpError 沒有寫到 stderr：{client.stderr[-5:]}"
    joined = "\n".join(logged)
    assert "Ffmpeg" in joined and "ffmpeg 提前結束（寫入管線失敗）" in joined
    assert "Permission denied" in joined, joined

    # 成功的 op 不會在 stderr 留下噪音
    before = len(client.stderr)
    client.send({"id": "ok1", "op": "test.echo", "args": {}})
    _, r = client.recv_until_reply("ok1")
    assert r["ok"]
    time.sleep(0.2)
    assert len(client.stderr) == before


def test_non_utf8_and_garbage_lines_are_skipped(client: Client) -> None:
    client.send_raw(b"\xff\xfe\xfd not utf8 \x80\n")
    client.send_raw(b"{this is not json\n")
    client.send_raw(b"[1,2,3]\n")
    client.send_raw(b'{"op":"ping"}\n')  # 沒 id → 跳過
    client.send_raw(b"\n\r\n")
    client.send({"id": "after", "op": "ping"})
    r = client.recv()
    assert r["id"] == "after" and r["ok"] is True
    assert r["result"]["busy_id"] is None
    time.sleep(0.2)
    assert any("不是 UTF-8" in line for line in client.stderr)
    assert any("不是 JSON" in line for line in client.stderr)


def test_ping_while_busy_reports_busy_id(client: Client) -> None:
    client.send({"id": "busy", "op": "test.slow", "args": {"n": 30, "dt": 0.05}})
    first = client.recv()
    assert first.get("event") == "progress"
    client.send({"id": "pg", "op": "ping"})
    # ping 在讀取執行緒即時回，不會排在 slow 之後
    got = None
    t0 = time.monotonic()
    while got is None:
        m = client.recv()
        if m.get("id") == "pg":
            got = m
    assert time.monotonic() - t0 < 1.0
    assert got["ok"] and got["result"]["busy_id"] == "busy" and got["result"]["busy_op"] == "test.slow"
    assert got["result"]["uptime_s"] >= 0 and got["result"]["queued"] == 0
    _, r = client.recv_until_reply("busy")
    assert r["ok"]
    client.send({"id": "pg2", "op": "ping"})
    r = client.recv()
    assert r["result"]["busy_id"] is None and r["result"]["done"] >= 1


def test_artifact_event_and_private_keys_stripped(client: Client) -> None:
    client.send({"id": "art", "op": "test.artifact", "args": {"path": r"C:\Users\x y\masks.aivm"}})
    events, r = client.recv_until_reply("art")
    arts = [e for e in events if e.get("event") == "artifact"]
    assert arts == [{"id": "art", "event": "artifact", "path": r"C:\Users\x y\masks.aivm", "kind": "mask"}]
    assert r["ok"] and r["result"] == {"visible": True}  # _exit_code/_human 不上線路


def test_shutdown_exits_cleanly() -> None:
    c = Client()
    try:
        c.send({"id": "s", "op": "shutdown"})
        r = c.recv()
        assert r == {"id": "s", "ok": True, "result": {"shutdown": True}}
        code = c.proc.wait(timeout=10)
        assert code == 0
        # shutdown 之後 stdout 沒有多餘的行
        time.sleep(0.2)
        assert c.lines.empty()
    finally:
        c.close()


def test_stdin_eof_shuts_down() -> None:
    c = Client()
    try:
        c.send({"id": "h", "op": "hello", "args": {"torch": False}})
        assert c.recv()["ok"]
        assert c.proc.stdin is not None
        c.proc.stdin.close()
        assert c.proc.wait(timeout=10) == 0
    finally:
        c.close()
