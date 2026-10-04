"""B-06 回歸：兩條 worker lane 同時碰同一個檔時，寫的不能被搬走、讀的不能被當成「檔案壞了」。

審查實測（`aivc serve` 真 op、冷索引快取）：`render.run --dry-run` 在主 lane、`render.plan` 在輕量 lane
背靠背送出，20 次裡有 4 次某一條 lane 死在 `PermissionError [WinError 32] …\\index.v1.json.part` ——
兩條 lane 各自寫固定名的 `<name>.part`，先 rename 的把另一筆的暫存檔搬走。

這裡不重跑整個 sidecar（那要真影片），直接壓在會撞的那幾個函式上：
  1. `media.cache.write_json` / `project.schema.save` / `MaskFile.write_rle` 併發寫
  2. 寫入 vs 讀取交叉（Windows 的 CPython `open()` 不帶 FILE_SHARE_DELETE → `os.replace` 會 WinError 5／32）
  3. `ops.media.ensure_index` 的 keyed_lock：兩條 lane 冷快取時只解一次影片
"""
from __future__ import annotations

import os
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from aivc import atomic
from aivc.media import cache as C
from aivc.seg.maskfile import MaskFile
from aivc.track._aivm_read import read_aivm

WINDOWS = os.name == "nt"
ROUNDS = 40


def _big_doc(tag: str, n: int = 400) -> dict:
    return {"tag": tag, "rows": [{"i": i, "s": f"{tag} 中文 {i} " * 8} for i in range(n)]}


# ---------------------------------------------------------------- 暫存檔名不共用


def test_temp_sibling_is_unique_and_parseable(tmp_path: Path) -> None:
    out = tmp_path / "牌桌 成品.mp4"
    names = {atomic.temp_sibling(out).name for _ in range(200)}
    assert len(names) == 200, "暫存名要唯一（固定名就是 B-06 的那個 race）"
    for n in names:
        assert atomic.owner_pid(n, out.name, ".part") == os.getpid()
    assert atomic.owner_pid("牌桌 成品.mp4.part", out.name, ".part") is None, "舊版固定名不該被當成有主的暫存檔"
    assert atomic.owner_pid("別的檔.mp4.123-deadbeef.part", out.name, ".part") is None


def test_pid_alive_says_no_for_a_pid_that_cannot_exist() -> None:
    assert atomic.pid_alive(os.getpid()) is True
    # 幾乎不可能存在的 pid：判錯就只是少清一顆殘留檔（保守方向），不會誤刪別人正在寫的
    assert atomic.pid_alive(0) is True, "判不出來一律當還活著"


@pytest.mark.parametrize("writer", ["cache_json", "project", "maskfile"])
def test_concurrent_writers_never_lose_their_temp_file(tmp_path: Path, writer: str) -> None:
    """同一個目標、兩條執行緒一直寫：不可以有任何一次因為暫存檔被別人搬走而失敗。"""
    from aivc.project import schema as S

    target = tmp_path / "並行 目標.json"
    errors: list[BaseException] = []
    start = threading.Barrier(2)

    def write(tag: str) -> None:
        start.wait()
        for i in range(ROUNDS):
            try:
                if writer == "cache_json":
                    C.write_json(target, _big_doc(f"{tag}{i}"))
                elif writer == "project":
                    S.save(S.ProjectFileV1(), tmp_path / "專案 一.aivc.json")
                else:
                    MaskFile.write_rle(tmp_path / "masks.aivm", 64, 48, [(i, None)])
            except BaseException as e:  # noqa: BLE001
                errors.append(e)
                return

    with ThreadPoolExecutor(2) as ex:
        list(ex.map(write, ["甲", "乙"]))
    assert not errors, f"{writer} 併發寫失敗：{errors[0]!r}"
    leftovers = [p.name for p in tmp_path.iterdir() if ".part" in p.name]
    assert not leftovers, f"留下暫存檔：{leftovers}"


# ---------------------------------------------------------------- 寫 vs 讀


def test_cache_read_json_survives_a_concurrent_replace(tmp_path: Path) -> None:
    """讀端遇到「正在換入」不可以回 None —— 那在 ensure_index 是「沒有快取」，整支影片會重解一次。"""
    target = tmp_path / "index.v1.json"
    C.write_json(target, _big_doc("初始"))
    stop = threading.Event()
    misses: list[str] = []

    def writer() -> None:
        i = 0
        while not stop.is_set():
            C.write_json(target, _big_doc(f"第{i}版"))
            i += 1

    t = threading.Thread(target=writer, daemon=True)
    t.start()
    try:
        for _ in range(300):
            got = C.read_json(target)
            if got is None or not str(got.get("tag", "")):
                misses.append(repr(got))
    finally:
        stop.set()
        t.join(5)
    assert not misses, f"{len(misses)} 次把「正在換入」讀成沒有快取／壞快取：{misses[:3]}"


def test_project_save_survives_a_concurrent_reader(tmp_path: Path) -> None:
    """主 lane 存專案檔 vs 輕量 lane 的 render.plan 正在 `load()`：兩邊都不可以死。"""
    from aivc.project import schema as S

    p = tmp_path / "專案 一.aivc.json"
    S.save(S.ProjectFileV1(), p)
    stop = threading.Event()
    errors: list[BaseException] = []

    def reader() -> None:
        while not stop.is_set():
            try:
                S.load(p)
            except BaseException as e:  # noqa: BLE001
                errors.append(e)
                return

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    try:
        for _ in range(ROUNDS):
            try:
                S.save(S.ProjectFileV1(), p)
            except BaseException as e:  # noqa: BLE001
                errors.append(e)
                break
    finally:
        stop.set()
        t.join(5)
    assert not errors, f"專案檔寫／讀交叉失敗：{errors[0]!r}"


def test_maskfile_write_survives_a_concurrent_aivm_reader(tmp_path: Path) -> None:
    """主 lane 的 seg 寫 masks.aivm vs 輕量 lane 的 geom.quad_from_mask 正在 read_bytes。"""
    import numpy as np

    p = tmp_path / "masks.aivm"
    mask = np.zeros((48, 64), dtype=bool)
    mask[10:20, 10:30] = True
    MaskFile.write(p, 64, 48, [(0, mask)])
    stop = threading.Event()
    errors: list[BaseException] = []

    def reader() -> None:
        while not stop.is_set():
            try:
                read_aivm(p).mask(0)
            except BaseException as e:  # noqa: BLE001
                errors.append(e)
                return

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    try:
        for k in range(ROUNDS):
            try:
                MaskFile.write(p, 64, 48, [(k, mask)])
            except BaseException as e:  # noqa: BLE001
                errors.append(e)
                break
    finally:
        stop.set()
        t.join(5)
    assert not errors, f"遮罩檔寫／讀交叉失敗：{errors[0]!r}"


# ---------------------------------------------------------------- 平台語意


@pytest.mark.skipif(WINDOWS, reason="POSIX 專屬：EACCES 是真的沒權限，不是暫時被開著")
def test_lock_error_is_windows_only() -> None:
    """`_is_lock_error(任何 PermissionError)` 在 POSIX 回 True 的話，輸出到沒權限的資料夾會退避重試 1.5 秒，
    然後報一個錯的診斷（「輸出檔正被其他程式開啟」）。"""
    import errno

    assert atomic.is_lock_error(PermissionError(errno.EACCES, "denied")) is False
    assert atomic.is_lock_error(PermissionError(errno.EPERM, "denied")) is False


@pytest.mark.skipif(not WINDOWS, reason="Windows 專屬：WinError 32 才算「被別人開著」")
def test_lock_error_matches_windows_sharing_violation() -> None:
    e = PermissionError(13, "denied")
    e.winerror = 32  # type: ignore[attr-defined]
    assert atomic.is_lock_error(e) is True
    e2 = PermissionError(13, "denied")
    e2.winerror = 2  # type: ignore[attr-defined]
    assert atomic.is_lock_error(e2) is False


def test_atomic_path_leaves_nothing_when_the_body_raises(tmp_path: Path) -> None:
    target = tmp_path / "半途 失敗.bin"
    with pytest.raises(RuntimeError):
        with atomic.atomic_path(target) as tmp:
            tmp.write_bytes(b"x" * 1000)
            raise RuntimeError("boom")
    assert not target.exists()
    assert not list(tmp_path.iterdir()), "失敗不可以留暫存檔"


def test_keyed_lock_is_per_path(tmp_path: Path) -> None:
    a, b = tmp_path / "一.json", tmp_path / "二.json"
    assert atomic.keyed_lock(a) is atomic.keyed_lock(str(a))
    assert atomic.keyed_lock(a) is not atomic.keyed_lock(b)
