"""B-09 輸出安全（media/ffmpeg.atomic_output）：被鎖的輸出檔在開工前就失敗、編碼完成的成品絕不刪、.part 名字唯一。

修正前（2026-09-17 稽核 REL-4 重現）：
- 播放器開著舊檔 → 整段渲染跑完才在 os.replace 撞 WinError 5，完整成品留成 `<out>.part`；
- 下一次渲染同名輸出，開頭就把那個 `<out>.part`（上一次的完整成品）刪掉。
路徑刻意含空白與中文。
"""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

from aivc.media import ffmpeg as ff
from aivc.ops import OpError

DAY = 24 * 3600  # 保險線：連 pid 都判不出來的殘留 .part 才靠時間清
windows_only = pytest.mark.skipif(os.name != "nt", reason="開著的檔不能被取代是 Windows 行為（POSIX rename 蓋得過去）")


@pytest.fixture
def d(tmp_path: Path) -> Path:
    p = tmp_path / "換花色 測試"
    p.mkdir()
    return p


class Holder:
    """另一個行程用 CRT 預設（不帶 FILE_SHARE_DELETE）開著檔案，跟 VLC／Python open 一樣。"""

    def __init__(self, path: Path) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, "-c", "import sys; f = open(sys.argv[1], 'rb'); print('held', flush=True); sys.stdin.read()", str(path)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        )
        assert self.proc.stdout is not None
        assert self.proc.stdout.readline().strip() == b"held"

    def release(self) -> None:
        if self.proc.poll() is None:
            assert self.proc.stdin is not None
            self.proc.stdin.close()
            self.proc.wait(timeout=10)

    def __enter__(self) -> "Holder":
        return self

    def __exit__(self, *exc: object) -> None:
        self.release()


def _names(d: Path) -> list[str]:
    return sorted(p.name for p in d.iterdir())


def test_part_name_is_unique_and_success_leaves_only_output(d: Path) -> None:
    out = d / "成品 a.mp4"
    with ff.atomic_output(out) as p1:
        with ff.atomic_output(d / "成品 a.mp4") as p2:
            assert p1 != p2, "同名輸出的兩次渲染不能共用 .part（其中一個收尾會刪掉另一個的成品）"
            assert p1.name.startswith("成品 a.mp4.") and p1.name.endswith(".part")
            p2.write_bytes(b"second")
        p1.write_bytes(b"first")
    assert out.read_bytes() == b"first" and _names(d) == ["成品 a.mp4"]


def test_failure_inside_block_removes_only_its_part(d: Path) -> None:
    out = d / "b.mkv"
    with pytest.raises(RuntimeError):
        with ff.atomic_output(out) as part:
            part.write_bytes(b"half")
            raise RuntimeError("encode failed")
    assert _names(d) == []


def _dead_pid() -> int:
    """一個保證已經結束的 pid（開一支立刻結束的 python 再等它退出）。"""
    proc = subprocess.Popen([sys.executable, "-c", "pass"])
    proc.wait(timeout=30)
    return proc.pid


def test_leftover_part_of_a_dead_process_is_swept_and_a_live_one_is_kept(d: Path) -> None:
    """B-09 回歸：唯一檔名讓每一次被硬殺的渲染都留一顆新的 .part，只看 24 h 的話會在使用者的輸出資料夾裡
    無限累積（舊版固定名最多留一顆、下次渲染就蓋掉）。檔名裡有 pid：寫它的行程不在了就清掉。"""
    out = d / "成品 c.mp4"
    dead = d / f"成品 c.mp4.{_dead_pid()}-0123abcd.part"
    dead.write_bytes(b"killed mid-encode")
    mine = d / f"成品 c.mp4.{os.getpid()}-0badf00d.part"  # 自己留下的（上一輪取消時沒刪成功）
    mine.write_bytes(b"leftover from my own earlier render")
    alien = d / "成品 c.mp4.old.part"  # 不是我們的命名 → 不管多舊都不碰
    alien.write_bytes(b"not ours")
    old = time.time() - DAY - 3600
    os.utime(alien, (old, old))
    with ff.atomic_output(out) as part:
        part.write_bytes(b"new")
    names = _names(d)
    assert dead.name not in names, "寫它的行程已經不在了，這顆 .part 是殘留"
    assert mine.name not in names, "自己留下、又沒在寫的也是殘留（sidecar 是長命行程，pid 相同不代表正在寫）"
    assert alien.name in names
    assert out.read_bytes() == b"new"


def test_a_part_being_written_right_now_is_never_swept(d: Path) -> None:
    """同一個行程裡正在寫的 `.part`（in-flight 名單）不可以被另一次渲染的開場掃描刪掉。"""
    from aivc import atomic

    out = d / "成品 c.mp4"
    live = d / f"成品 c.mp4.{os.getpid()}-feedface.part"
    live.write_bytes(b"being written")
    with atomic.inflight(live):
        ff._sweep_stale_parts(out)
        assert live.is_file()
    ff._sweep_stale_parts(out)
    assert not live.exists(), "寫完（離開 in-flight）之後就是殘留"


def test_legacy_part_is_never_swept_even_when_ancient(d: Path) -> None:
    """舊版的 `<out>.part` 在上一版是「編碼完成、只是換不進去」的完整成品（REL-4）。
    以前的掃描把超過 24 h 的它一併刪掉，跟「完成的成品絕不刪」直接矛盾——那是使用者唯一一份輸出。"""
    out = d / "成品 c.mp4"
    legacy = d / "成品 c.mp4.part"
    legacy.write_bytes(b"finished render from the old build")
    old = time.time() - DAY - 3600
    os.utime(legacy, (old, old))
    with ff.atomic_output(out) as part:
        part.write_bytes(b"new")
    assert legacy.is_file() and legacy.read_bytes() == b"finished render from the old build"
    assert out.read_bytes() == b"new"


def test_orphan_probe_is_recovered_as_the_output(d: Path) -> None:
    """`ensure_replaceable` 的兩次 rename 之間被砍掉：使用者上一支成品卡在 `<out>.<pid>-<8hex>.probe`，
    `out` 不存在，而且以前沒有任何人會清也沒有人會救（播放器打不開那個副檔名）。"""
    out = d / "上一次 成品.mp4"
    orphan = d / f"上一次 成品.mp4.{_dead_pid()}-c3d613ee.probe"
    orphan.write_bytes(b"yesterday's delivered render")
    ff._recover_orphan_probes(out)
    assert out.read_bytes() == b"yesterday's delivered render"
    assert not orphan.exists()


def test_orphan_probe_never_overwrites_a_newer_output(d: Path) -> None:
    out = d / "上一次 成品.mp4"
    out.write_bytes(b"newer render")
    orphan = d / f"上一次 成品.mp4.{_dead_pid()}-c3d613ee.probe"
    orphan.write_bytes(b"yesterday")
    ff._recover_orphan_probes(out)
    assert out.read_bytes() == b"newer render"
    assert (d / "上一次 成品 (aivc 1).mp4").read_bytes() == b"yesterday", f"要救成兄弟檔：{_names(d)}"


def test_live_process_probe_is_left_alone(d: Path) -> None:
    """同一支渲染自己的探測檔（rename 出去、還沒改回來）不可以被別人搶走。"""
    out = d / "成品.mp4"
    mine = d / f"成品.mp4.{os.getpid()}-aabbccdd.probe"
    mine.write_bytes(b"in flight")
    ff._recover_orphan_probes(out)
    assert mine.is_file() and not out.exists()


def test_output_path_is_a_directory_fails_before_yield(d: Path) -> None:
    (d / "x.mp4").mkdir()
    ran = False
    with pytest.raises(OpError) as e:
        with ff.atomic_output(d / "x.mp4"):
            ran = True
    assert not ran and e.value.kind == "Invalid"


@windows_only
def test_locked_output_fails_before_encoding_starts(d: Path) -> None:
    out = d / "成品 locked.mp4"
    out.write_bytes(b"old-content-15b")
    with Holder(out):
        ran = False
        t0 = time.monotonic()
        with pytest.raises(OpError) as e:
            with ff.atomic_output(out) as part:
                ran = True
                part.write_bytes(b"x" * 100_000)
        took = time.monotonic() - t0
    assert not ran, "被鎖的輸出要在 yield 之前就失敗（不白跑整段渲染）"
    assert took < 0.5, took
    assert e.value.kind == "Io" and "其他程式" in str(e.value) and e.value.hint == str(out)
    assert out.read_bytes() == b"old-content-15b" and _names(d) == ["成品 locked.mp4"], "舊檔原封不動、不留探測檔"


@windows_only
def test_lock_taken_after_start_preserves_finished_render_as_sibling(d: Path) -> None:
    out = d / "成品 late.mp4"
    out.write_bytes(b"old")
    holder = None
    try:
        with pytest.raises(OpError) as e:
            with ff.atomic_output(out) as part:
                part.write_bytes(b"FINISHED RENDER")
                holder = Holder(out)  # 編碼期間使用者用播放器打開了舊檔
        sib = d / "成品 late (aivc 1).mp4"
        assert e.value.kind == "Io" and sib.name in str(e.value) and e.value.hint == str(sib)
        assert sib.read_bytes() == b"FINISHED RENDER", "成品不能丟"
        assert out.read_bytes() == b"old"
        assert not [n for n in _names(d) if n.endswith(".part")]
        # 還鎖著時再渲染一次：開工前就失敗，且救下來的成品不受影響
        with pytest.raises(OpError):
            with ff.atomic_output(out) as part:
                part.write_bytes(b"never")
        assert sib.read_bytes() == b"FINISHED RENDER"
        holder.release()
        # 放開後再渲染：成功寫到原檔名，救下來的 (aivc 1) 仍在；再救一次會用 (aivc 2) 不覆寫
        with ff.atomic_output(out) as part:
            part.write_bytes(b"third")
        assert out.read_bytes() == b"third" and sib.read_bytes() == b"FINISHED RENDER"
        holder = None
        with pytest.raises(OpError) as e2:
            with ff.atomic_output(out) as part:
                part.write_bytes(b"fourth")
                holder = Holder(out)
        assert "(aivc 2)" in str(e2.value) and (d / "成品 late (aivc 2).mp4").read_bytes() == b"fourth"
        assert sib.read_bytes() == b"FINISHED RENDER"
    finally:
        if holder is not None:
            holder.release()


@windows_only
def test_short_lock_at_finish_is_retried(d: Path) -> None:
    """防毒／縮圖預覽短暫握著舊檔：退避重試內放開就正常換入，不另存。"""
    out = d / "retry.mp4"
    out.write_bytes(b"old")
    with ff.atomic_output(out) as part:
        part.write_bytes(b"new")
        h = Holder(out)
        import threading

        threading.Timer(0.3, h.release).start()
    assert out.read_bytes() == b"new" and _names(d) == ["retry.mp4"]


@windows_only
def test_read_only_output_fails_fast(d: Path) -> None:
    import stat

    out = d / "ro.mp4"
    out.write_bytes(b"old")
    os.chmod(out, stat.S_IREAD)
    try:
        with pytest.raises(OpError) as e:
            with ff.atomic_output(out) as part:
                part.write_bytes(b"x")
        assert e.value.kind == "Io" and "唯讀" in str(e.value)
    finally:
        os.chmod(out, stat.S_IREAD | stat.S_IWRITE)
    assert _names(d) == ["ro.mp4"]
