"""同一個檔同時被寫、被讀時的共用規則（B-02／B-06／B-09 的共同底層）。

`aivc serve` 有兩條 worker lane（main 與 light，B-06），加上 App（Rust）、防毒、預覽縮圖，
同一個 `index.v1.json`／`.aivc.json`／`masks.aivm` 隨時可能同時有人寫、有人讀。三條規則：

1. **暫存檔名不共用**。固定的 `<name>.part` 兩筆寫入重疊時，先 rename 的那筆把另一筆的暫存檔搬走，
   另一筆拿到 WinError 32／5 或 `FileNotFoundError`（實測 `aivc serve` 冷快取下 20 次有 4 次某條 lane 死掉）。
   一律 `<name>.<pid>-<8hex>.part` —— Rust `store.rs` 的 `{name}.{uuid}.tmp` 是同一件事的另一半。
2. **換入要重試**。Windows 的 CPython `open()` 不帶 `FILE_SHARE_DELETE`，只要有人正開著目標檔讀，
   `os.replace` 就是 WinError 5／32。退避重試約 0.3 s（鏡射 Rust `replace_with_retry`）。
3. **讀取也要重試**。`os.replace` 進行中去開目標檔會短暫 sharing violation。讀的人不重試就會誤判成
   「檔案壞了」——`media.cache.read_json` 甚至會當成沒有快取，整支影片重解一次索引（70–136 s）。

**只有 Windows 有這個問題**：POSIX 的 rename 蓋得過開著的檔，那邊的 `PermissionError` 是真的沒權限，
重試只會拖時間再回報一個錯誤的診斷（「輸出檔正被其他程式開啟」）。所以鎖定判斷限定 `os.name == "nt"`。
"""
from __future__ import annotations

import os
import threading
import time
import uuid
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import IO, Any, Callable

__all__ = [
    "READ_BACKOFF_S",
    "REPLACE_BACKOFF_S",
    "atomic_path",
    "atomic_write",
    "inflight",
    "is_inflight",
    "is_lock_error",
    "keyed_lock",
    "owner_pid",
    "pid_alive",
    "read_bytes",
    "read_text",
    "replace_retry",
    "retry_os",
    "temp_sibling",
    "unlink_quiet",
    "write_bytes",
    "write_text",
]

# 5 ERROR_ACCESS_DENIED / 32 ERROR_SHARING_VIOLATION / 33 ERROR_LOCK_VIOLATION
_WIN_LOCK_ERRORS = (5, 32, 33)
REPLACE_BACKOFF_S = (0.01, 0.02, 0.04, 0.06, 0.08, 0.1)  # 合計約 0.31 s，與 Rust replace_with_retry 同量級
READ_BACKOFF_S = (0.01, 0.02, 0.04, 0.08)  # 讀端只要撐過 replace 的瞬間，約 0.15 s


def is_lock_error(e: OSError) -> bool:
    """這個 OSError 是不是 Windows 的「檔案被別的程式開著」（可重試），而不是真的沒權限。"""
    if os.name != "nt":
        return False
    win = getattr(e, "winerror", None)
    if win is not None:
        return win in _WIN_LOCK_ERRORS
    return isinstance(e, PermissionError)


def retry_os(fn: Callable[[], Any], backoff: Iterable[float] = REPLACE_BACKOFF_S) -> Any:
    """`fn()` 遇到鎖定類 OSError 依 backoff 重試；最後一次的例外照丟（其他 OSError 立刻丟）。"""
    delays = list(backoff)
    for i in range(len(delays) + 1):
        try:
            return fn()
        except OSError as e:
            if i == len(delays) or not is_lock_error(e):
                raise
            time.sleep(delays[i])
    raise AssertionError("unreachable")


def temp_sibling(path: str | os.PathLike[str], suffix: str = ".part") -> Path:
    """`<name>.<pid>-<8hex><suffix>`：同目錄、行程間不會撞名，尾碼保留給清理用的樣式比對。"""
    p = Path(path)
    return p.with_name(f"{p.name}.{os.getpid()}-{uuid.uuid4().hex[:8]}{suffix}")


def owner_pid(name: str, target: str, suffix: str = ".part") -> int | None:
    """`<target>.<pid>-<8hex><suffix>` → pid；名字對不上回 None。"""
    if not name.startswith(target + ".") or not name.endswith(suffix):
        return None
    mid = name[len(target) + 1 : len(name) - len(suffix)]
    pid, sep, tail = mid.partition("-")
    if not sep or len(tail) != 8 or not pid.isdigit():
        return None
    try:
        int(tail, 16)
    except ValueError:
        return None
    return int(pid)


def pid_alive(pid: int) -> bool:
    """這個 pid 現在還在跑嗎（清殘留檔用；不確定時一律回 True，寧可留垃圾也不刪別人正在寫的檔）。"""
    if pid <= 0:
        return True
    if pid == os.getpid():
        return True
    if os.name == "nt":
        try:
            import ctypes
            import ctypes.wintypes as wt

            k = ctypes.WinDLL("kernel32", use_last_error=True)
            k.OpenProcess.argtypes = (wt.DWORD, wt.BOOL, wt.DWORD)
            k.OpenProcess.restype = wt.HANDLE
            k.GetExitCodeProcess.argtypes = (wt.HANDLE, ctypes.POINTER(wt.DWORD))
            k.GetExitCodeProcess.restype = wt.BOOL
            k.CloseHandle.argtypes = (wt.HANDLE,)
            h = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                # 87 ERROR_INVALID_PARAMETER ＝ 沒有這個 pid；其他（5 拒絕存取）代表行程在、只是我們看不到
                return ctypes.get_last_error() != 87
            code = wt.DWORD()
            ok = k.GetExitCodeProcess(h, ctypes.byref(code))
            k.CloseHandle(h)
            return (not ok) or code.value == 259  # 259 STILL_ACTIVE
        except Exception:  # noqa: BLE001 — ctypes 不可用就保守當還活著
            return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def unlink_quiet(p: str | os.PathLike[str], tries: int = 5) -> None:
    """刪不掉就算了（Windows：子行程剛死、句柄可能還沒釋放）。"""
    path = Path(p)
    for _ in range(tries):
        try:
            path.unlink(missing_ok=True)
            return
        except OSError:
            time.sleep(0.05)  # 合計約 0.25 s；停止引擎的預算只有 2.5 s，不能在這裡耗掉


def replace_retry(src: str | os.PathLike[str], dst: str | os.PathLike[str], backoff: Iterable[float] = REPLACE_BACKOFF_S) -> None:
    retry_os(lambda: os.replace(src, dst), backoff)


# ---------------------------------------------------------------- 正在寫的暫存檔（清殘留時要跳過）
_inflight_lock = threading.Lock()
_inflight: set[str] = set()


@contextmanager
def inflight(path: str | os.PathLike[str]) -> Iterator[None]:
    key = os.fspath(path)
    with _inflight_lock:
        _inflight.add(key)
    try:
        yield
    finally:
        with _inflight_lock:
            _inflight.discard(key)


def is_inflight(path: str | os.PathLike[str]) -> bool:
    with _inflight_lock:
        return os.fspath(path) in _inflight


# ---------------------------------------------------------------- 寫入
@contextmanager
def atomic_path(path: str | os.PathLike[str], suffix: str = ".part") -> Iterator[Path]:
    """yield 唯一的暫存路徑；離開時換成 `path`，途中擲例外就清掉暫存檔。"""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = temp_sibling(p, suffix)
    try:
        with inflight(tmp):
            yield tmp
            replace_retry(tmp, p)
    except BaseException:
        unlink_quiet(tmp)
        raise


@contextmanager
def atomic_write(path: str | os.PathLike[str], mode: str = "wb", **kw: Any) -> Iterator[IO[Any]]:
    """`with atomic_write(p, "w", encoding="utf-8") as f:` —— 寫暫存檔、關檔、換入。"""
    with atomic_path(path) as tmp, open(tmp, mode, **kw) as f:
        yield f


def write_bytes(path: str | os.PathLike[str], data: bytes) -> Path:
    with atomic_write(path, "wb") as f:
        f.write(data)
    return Path(path)


def write_text(path: str | os.PathLike[str], text: str, *, encoding: str = "utf-8", newline: str | None = None) -> Path:
    with atomic_write(path, "w", encoding=encoding, newline=newline) as f:
        f.write(text)
    return Path(path)


# ---------------------------------------------------------------- 讀取
def read_bytes(path: str | os.PathLike[str], backoff: Iterable[float] = READ_BACKOFF_S) -> bytes:
    """`Path.read_bytes()` 但撐得過別條 lane 正在 `os.replace` 的那一瞬間。"""
    return retry_os(lambda: Path(path).read_bytes(), backoff)


def read_text(path: str | os.PathLike[str], *, encoding: str = "utf-8", backoff: Iterable[float] = READ_BACKOFF_S) -> str:
    return retry_os(lambda: Path(path).read_text(encoding=encoding), backoff)


# ---------------------------------------------------------------- 同一個目標在行程內排隊
_keyed_lock_guard = threading.Lock()
_keyed_locks: dict[str, threading.Lock] = {}


def keyed_lock(key: str | os.PathLike[str]) -> threading.Lock:
    """同一個 key 永遠拿到同一把行程內的鎖（兩條 lane 要重建同一份快取時，第二條等第一條而不是各解一次）。

    故意不回收：key 是快取檔路徑，一次工作階段內就那幾個，留著比在解鎖時判斷有沒有人在等安全。
    """
    k = os.path.normcase(os.fspath(key))
    with _keyed_lock_guard:
        lock = _keyed_locks.get(k)
        if lock is None:
            lock = threading.Lock()
            _keyed_locks[k] = lock
        return lock
