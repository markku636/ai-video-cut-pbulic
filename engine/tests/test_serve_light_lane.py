"""B-06：長工作佔著主 worker 時，`light=True` 的短 op（render.plan／captions.layout／geom.quad_from_mask）照樣秒回。

修正前（2026-09-17 實測，同一台機器、同一份專案）：render.plan 閒置 0.06 s，排在 pipeline.run 後面要 39.2 s
（有 SAM 時 86.9 s，App 的 60 s 逾時必炸）。修正後走 `aivc-light` 執行緒，主 worker 仍嚴格序列（兩個 gpu op 絕不同跑）。
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path
from typing import Any

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures" / "protocol"))
from serve_client import Client, make_scene  # noqa: E402

from aivc import env  # noqa: E402

LIGHT_FAKES = "aivc_fake_ops,aivc_light_ops"  # 假長工作 + 假 light op


@pytest.fixture
def client() -> Any:
    c = Client(extra_ops=LIGHT_FAKES)
    try:
        yield c
    finally:
        c.close()


def test_light_op_replies_while_main_worker_is_busy(client: Client) -> None:
    client.send({"id": "long", "op": "test.slow", "args": {"n": 100, "dt": 0.05}})  # 5 s
    client.wait_event(lambda e: e.get("id") == "long" and e.get("event") == "progress", 10)
    t = client.send({"id": "le", "op": "test.light_echo", "args": {"中文": "好"}})
    tr, r = client.reply("le", 10)
    assert tr - t < 1.0, f"light op 被長工作擋住 {tr - t:.2f}s"
    assert r["ok"] and r["result"] == {"echo": {"中文": "好"}, "thread": "aivc-light"}
    # ping 回報兩條 lane；舊鍵 busy_op 仍是主 worker
    client.send({"id": "pg", "op": "ping"})
    _, pg = client.reply("pg", 5)
    res = pg["result"]
    assert res["busy_op"] == "test.slow" and res["lanes"]["main"]["busy_op"] == "test.slow"
    assert res["lanes"]["light"]["busy_id"] is None and res["lanes"]["light"]["enabled"] is True
    # 長工作不受影響、完整跑完
    tl, rl = client.reply("long", 30)
    assert rl["ok"] and rl["result"] == {"steps": 100}
    assert tr < tl


def test_main_lane_stays_strictly_serial(client: Client) -> None:
    """非 light 的 op 仍排同一條 worker：第二個要等第一個回覆後才開始（決策 8：兩個 gpu op 不同跑）。"""
    client.send({"id": "a", "op": "test.slow", "args": {"n": 6, "dt": 0.05}})
    client.send({"id": "b", "op": "test.slow", "args": {"n": 6, "dt": 0.05}})
    ta, _ = client.reply("a", 10)
    first_b = client.wait_event(lambda e: e.get("id") == "b", 10)
    tb_first = next(t for t, e in client.events if e is first_b)
    assert tb_first >= ta, "主 worker 上的第二個 op 在第一個回覆前就開始了"
    client.reply("b", 10)


def test_light_lane_can_be_disabled() -> None:
    c = Client({"AIVC_LIGHT_LANE": "0"}, extra_ops=LIGHT_FAKES)
    try:
        c.send({"id": "long", "op": "test.slow", "args": {"n": 20, "dt": 0.05}})
        c.wait_event(lambda e: e.get("id") == "long", 10)
        c.send({"id": "le", "op": "test.light_echo", "args": {}})
        tl, _ = c.reply("long", 10)
        tr, r = c.reply("le", 10)
        assert tr >= tl and r["result"]["thread"] == "aivc-worker"
    finally:
        c.close()


def test_cancel_queued_light_job_never_runs(client: Client) -> None:
    client.send({"id": "ls", "op": "test.light_slow", "args": {"n": 20, "dt": 0.05}})
    client.wait_event(lambda e: e.get("id") == "ls", 10)
    client.send({"id": "le", "op": "test.light_echo", "args": {}})
    client.send({"id": "c", "op": "cancel", "args": {"id": "le"}})
    _, c = client.reply("c", 5)
    assert c["result"] == {"id": "le", "found": True, "running": False}
    _, r = client.reply("le", 10)
    assert r["ok"] is False and r["error"]["kind"] == "Canceled"
    assert not [e for _, e in client.events if e.get("id") == "le"], "排隊中被取消的 light op 不能執行"
    _, rs = client.reply("ls", 10)
    assert rs["ok"] and rs["result"]["thread"] == "aivc-light"


def test_shutdown_cancels_both_lanes_and_exits() -> None:
    c = Client(extra_ops=LIGHT_FAKES)
    try:
        c.send({"id": "m", "op": "test.slow", "args": {"n": 400, "dt": 0.05}})
        c.send({"id": "l", "op": "test.light_slow", "args": {"n": 400, "dt": 0.05}})
        c.wait_event(lambda e: e.get("id") == "m", 10)
        c.wait_event(lambda e: e.get("id") == "l", 10)
        c.send({"id": "s", "op": "shutdown"})
        ts, _ = c.reply("s", 5)
        for rid in ("m", "l"):
            _, r = c.reply(rid, 5)
            assert r["ok"] is False and r["error"]["kind"] == "Canceled", r
        assert c.proc.wait(timeout=5) == 0
        assert time.monotonic() - ts < 2.0
    finally:
        c.close()


def test_light_flag_rules() -> None:
    from aivc.ops import LIGHT_OPS, REGISTRY, load_all

    load_all()
    for name in LIGHT_OPS:
        assert name in REGISTRY, f"白名單上的 {name} 沒有註冊（改名了？）"
        assert REGISTRY[name].light and not REGISTRY[name].gpu
    assert not REGISTRY["render.run"].light and not REGISTRY["seg.run"].light
    # 外掛的長工作（例：牌局外掛的 pipeline.run）也不能進輕量 lane；沒裝外掛時就沒有它
    assert "pipeline.run" not in REGISTRY or not REGISTRY["pipeline.run"].light


def test_bad_light_gpu_op_degrades_to_the_main_lane_and_is_reported() -> None:
    """`gpu=True, light=True` 是寫錯程式，但以前是在 decorator 裡 raise：整個 op 模組 import 失敗，
    同一個檔裡**後面**的 op 全部安靜從 REGISTRY 消失（serve 只 warn 一次，呼叫端看到「未知 op」）。
    改成退回主 lane 並記進 LOAD_ERRORS：能力不消失、問題看得見。"""
    from aivc.ops import LOAD_ERRORS, REGISTRY, register

    before = len(LOAD_ERRORS)
    register("test.bad_light_gpu", gpu=True, light=True)(lambda args, ctx: {})
    sibling_ran = register("test.sibling_after_bad", gpu=True)(lambda args, ctx: {"ok": True})
    assert REGISTRY["test.bad_light_gpu"].gpu and not REGISTRY["test.bad_light_gpu"].light, "衝突時以 gpu 為準"
    assert "test.sibling_after_bad" in REGISTRY, "同檔後面的 op 不可以跟著消失"
    assert sibling_ran is not None
    assert any("test.bad_light_gpu" in m for m in LOAD_ERRORS[before:]), f"要留下可查的紀錄：{LOAD_ERRORS[before:]}"
    del REGISTRY["test.bad_light_gpu"], REGISTRY["test.sibling_after_bad"]
    del LOAD_ERRORS[before:]


# ---------------------------------------------------------------- 真的 op（合成場景、CPU、需要 ffmpeg）


@pytest.fixture
def scene(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")
    root = tmp_path / "換花色 輕量"
    root.mkdir()
    monkeypatch.setenv("AIVC_CACHE_DIR", str(root / "cache"))
    return make_scene(root, 48, tmp_path / "deck dir")


def _decode(path: Path) -> list[Any]:
    from aivc.media.source import FrameSource

    with FrameSource(path) as fs:
        return [fs.get(i) for i in range(fs.n_frames)]


def test_render_plan_replies_fast_while_main_worker_is_busy(scene: tuple[Path, Path]) -> None:
    ppath, _ = scene
    c = Client()  # 真的 op 靠白名單走 light lane，不需要假 light op
    try:
        plan_args = {"project": str(ppath), "out": str(ppath.with_name("匯出 plan.mkv")), "codec": "ffv1", "no_gpu": True}
        c.send({"id": "p0", "op": "render.plan", "args": plan_args})
        _, p0 = c.reply("p0", 60)
        assert p0["ok"], p0
        c.send({"id": "long", "op": "test.slow", "args": {"n": 200, "dt": 0.05}})  # 10 s
        c.wait_event(lambda e: e.get("id") == "long", 10)
        t = c.send({"id": "p1", "op": "render.plan", "args": plan_args})
        tr, p1 = c.reply("p1", 60)
        assert tr - t < 2.0, f"render.plan 被長工作擋住 {tr - t:.2f}s"
        assert p1["result"] == p0["result"]
        c.send({"id": "cl", "op": "cancel", "args": {"id": "long"}})
        c.reply("long", 10)
    finally:
        c.close()


def test_light_ops_concurrent_with_render_run_match_serial(scene: tuple[Path, Path]) -> None:
    """執行緒安全：render.run（主 worker）跑的同時丟一堆 render.plan / geom.quad_from_mask（light），
    成品逐位元等於單獨渲染、每個 light 回覆都等於閒置時的回覆。"""
    ppath, _ = scene
    from aivc.project import paths as P
    from aivc.project import schema as S

    proj = S.load(ppath).project
    masks = str(P.media_cache(proj.media[0].fingerprint).masks("t1"))
    c = Client()  # 真的 op 靠白名單走 light lane，不需要假 light op
    try:
        plan_args = {"project": str(ppath), "out": str(ppath.with_name("匯出 plan.mkv")), "codec": "ffv1", "no_gpu": True}
        quad_args = {"masks": masks, "frame": 3}
        c.send({"id": "p0", "op": "render.plan", "args": plan_args})
        c.send({"id": "q0", "op": "geom.quad_from_mask", "args": quad_args})
        _, p0 = c.reply("p0", 60)
        _, q0 = c.reply("q0", 60)
        assert p0["ok"] and q0["ok"] and q0["result"]["quad"] is not None
        serial_out = ppath.with_name("單獨 serial.mkv")
        c.send({"id": "r0", "op": "render.run", "args": {"project": str(ppath), "out": str(serial_out), "codec": "ffv1", "no_gpu": True}})
        _, r0 = c.reply("r0", 120)
        assert r0["ok"], r0

        conc_out = ppath.with_name("並行 concurrent.mkv")
        c.send({"id": "r1", "op": "render.run", "args": {"project": str(ppath), "out": str(conc_out), "codec": "ffv1", "no_gpu": True}})
        c.wait_event(lambda e: e.get("id") == "r1" and e.get("event") == "progress", 30)
        ids = []
        for i in range(25):
            c.send({"id": f"p{i + 1}", "op": "render.plan", "args": plan_args})
            c.send({"id": f"q{i + 1}", "op": "geom.quad_from_mask", "args": quad_args})
            ids += [f"p{i + 1}", f"q{i + 1}"]
        tr1, r1 = c.reply("r1", 120)
        assert r1["ok"], r1
        replies = {i: c.reply(i, 120) for i in ids}
        overlapped = sum(1 for t, _ in replies.values() if t < tr1)
        assert overlapped >= 2, f"light op 沒有與 render.run 重疊（{overlapped}），測不到並行"
        for i, (_, m) in replies.items():
            want = p0 if i.startswith("p") else q0
            assert m["ok"] and m["result"] == want["result"], (i, m)
        a, b = _decode(serial_out), _decode(conc_out)
        assert len(a) == len(b) == 48
        for k, (x, y) in enumerate(zip(a, b)):
            assert np.array_equal(x.y, y.y) and np.array_equal(x.u, y.u) and np.array_equal(x.v, y.v), k
        assert r1["result"]["tracks"] == r0["result"]["tracks"]
        assert not [p.name for p in ppath.parent.glob("*.part")]
    finally:
        c.close()


@pytest.mark.skipif(os.name != "nt", reason="同步 I/O 序列化是 Windows 行為")
def test_light_thread_native_import_does_not_wait_for_stdin() -> None:
    """Windows 死結回歸（test_serve_stdin 的 light 版）：主執行緒卡在管線 ReadFile 時，aivc-light 第一次載入
    帶 Fortran／OpenBLAS runtime 的擴充也不能等到 stdin 來下一行。之後不送任何東西，回覆也要在幾秒內到。"""
    pytest.importorskip("scipy")
    c = Client(extra_ops=LIGHT_FAKES)
    try:
        c.send({"id": "j", "op": "test.light_native_import", "args": {"modules": ["scipy.linalg"]}})
        _, r = c.reply("j", 20)
        assert r["ok"] is True and r["result"]["thread"] == "aivc-light"
    finally:
        c.close()
