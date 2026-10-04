"""ffmpeg 子行程（計畫 §6.7）：解析路徑（env.ffmpeg_bin）、-progress pipe:1 解析、唯一 .part→rename（被鎖先擋、成品不丟）、stderr 排空、取消即 kill。

- 一律 list 參數 + CREATE_NO_WINDOW，永不 shell=True（路徑有空格、中文）。
- `-progress pipe:1` 每隔一段吐 `key=value` 行（out_time_us / frame / speed / progress=continue|end）；
  stdout/stderr 各一條 daemon thread 讀到 EOF，否則管線塞滿 ffmpeg 會卡死（ai-music-cut local_asr.rs 的教訓）。
- 編碼器「有列」≠「能用」（NVENC 沒卡／驅動舊會列出但失敗）：`encoder_usable()` 用 lavfi 黑幀試編 2 幀。
"""
from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterable, Iterator

from .. import atomic, env
from ..ops import OpError

CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0
_STDERR_TAIL = 40


def popen_kwargs() -> dict[str, Any]:
    kw: dict[str, Any] = {}
    if sys.platform == "win32":
        kw["creationflags"] = CREATE_NO_WINDOW
    return kw


def exe(name: str = "ffmpeg") -> str:
    """ffmpeg / ffprobe 的完整路徑；找不到擲 OpError(Ffmpeg)。"""
    try:
        return env.ffmpeg_bin(name)
    except FileNotFoundError as e:
        raise OpError("Ffmpeg", str(e), hint="設定 AIVC_FFMPEG_DIR 指向含 ffmpeg.exe / ffprobe.exe 的目錄，或安裝到 PATH") from e


def run(args: list[str], *, timeout: float | None = None, input: bytes | None = None, check: bool = True) -> subprocess.CompletedProcess[bytes]:
    """一次跑完、收集輸出（probe、抽單幀、-encoders 這種短命令）。"""
    try:
        cp = subprocess.run(args, input=input, capture_output=True, timeout=timeout, **popen_kwargs())
    except subprocess.TimeoutExpired as e:
        raise OpError("Timeout", f"{Path(args[0]).name} 超過 {timeout}s 沒回應", hint=" ".join(args[:8])) from e
    except OSError as e:
        raise OpError("Ffmpeg", f"啟動 {args[0]} 失敗：{e}") from e
    if check and cp.returncode != 0:
        tail = cp.stderr.decode("utf-8", "replace").strip().splitlines()[-_STDERR_TAIL:]
        raise OpError("Ffmpeg", f"{Path(args[0]).name} 退出碼 {cp.returncode}", hint="\n".join(tail))
    return cp


@lru_cache(maxsize=1)
def list_encoders() -> frozenset[str]:
    """`ffmpeg -encoders` 列出的名字（快取一次）。"""
    cp = run([exe("ffmpeg"), "-hide_banner", "-encoders"], timeout=60, check=False)
    names: set[str] = set()
    for line in cp.stdout.decode("utf-8", "replace").splitlines():
        parts = line.split()
        # 格式： " V....D libopenh264          OpenH264 …"；flag 欄 6 碼，首碼 V/A/S
        if len(parts) >= 2 and len(parts[0]) == 6 and parts[0][0] in "VAS":
            names.add(parts[1])
    return frozenset(names)


@lru_cache(maxsize=None)
def encoder_usable(name: str, timeout: float = 45.0) -> bool:
    """用 lavfi 黑幀試編 2 幀；NVENC 列出來不代表這台機器能用。"""
    if name not in list_encoders():
        return False
    args = [
        exe("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "error",
        "-f", "lavfi", "-i", "color=c=black:s=320x240:r=30:d=0.2",
        "-frames:v", "2", "-pix_fmt", "yuv420p", "-c:v", name, "-f", "null", "-",
    ]
    try:
        cp = run(args, timeout=timeout, check=False)
    except OpError:
        return False
    return cp.returncode == 0


def first_usable(candidates: Iterable[str]) -> str | None:
    for c in candidates:
        if encoder_usable(c):
            return c
    return None


PART_STALE_S = 24 * 3600  # 保險線：連 pid 都判不出來的殘留 .part，超過這麼久才清
_REPLACE_BACKOFF_S = (0.1, 0.2, 0.4, 0.8)  # 換入成品時被鎖：約 1.5 s 內重試（防毒／縮圖預覽短暫握著）
_PROBE_BACKOFF_S = (0.05, 0.1)  # 開工前探測：很快放棄，被播放器開著的檔不會自己放開

# `_is_lock_error` / `_retry_os` 是 `aivc.atomic` 的同一套規則（只有 Windows 的 WinError 5/32/33 算「被開著」；
# POSIX 的 EACCES 是真的沒權限，重試只會拖 1.5 s 再回報一個錯誤的診斷）。這裡保留名字給既有測試與呼叫端。
_is_lock_error = atomic.is_lock_error


def _retry_os(fn: Any, backoff: Iterable[float]) -> None:
    atomic.retry_os(fn, backoff)


def ensure_replaceable(out: Path) -> None:
    """開工前確認成品換得進去（計畫：B-09 fail fast）：`out` 已存在就改名成探測名再改回來。

    為什麼要先探：以前要等整段編碼完、`os.replace(part, out)` 才撞到「播放器開著舊檔」（Windows 不帶
    FILE_SHARE_DELETE 開檔就不能被取代），整段渲染白跑。rename 探測與 os.replace 需要的權限相同，
    沒被鎖的檔是 no-op（兩次 rename 各幾十微秒）。改回失敗（極罕見：探測名剛好被別人抓住）時重試，
    還是不行就把**現在的檔名**講清楚，絕不默默讓使用者的舊檔消失。
    """
    if out.is_dir():
        raise OpError("Invalid", f"輸出路徑是資料夾：{out}", hint="請在存檔對話框選一個檔名")
    if not out.exists():
        return
    if os.name != "nt":
        # POSIX 的 rename 一定蓋得過開著的檔，探測不到任何東西，卻會在兩次 rename 之間留下
        # `<out>.<pid>-<8hex>.probe`（當機／被 kill 時使用者上一支成品就消失在這個名字底下）。
        # 那邊真正會擋住輸出的是「目錄不能寫」，直接驗那個就好。
        if not os.access(out.parent, os.W_OK | os.X_OK):
            raise OpError("Io", "輸出資料夾沒有寫入權限", hint=str(out.parent))
        return
    if _is_readonly(out):
        # Windows 的 os.replace 蓋不過唯讀檔（rename 探測卻會過）
        raise OpError("Io", "輸出檔是唯讀的，無法取代；請取消唯讀或換一個檔名", hint=str(out))
    probe = out.with_name(f"{out.name}.{os.getpid()}-{uuid.uuid4().hex[:8]}.probe")
    try:
        _retry_os(lambda: os.rename(out, probe), _PROBE_BACKOFF_S)
    except FileNotFoundError:
        return  # 剛好被刪掉：沒有東西要取代
    except OSError as e:
        if _is_lock_error(e):
            raise OpError("Io", "輸出檔正被其他程式開啟（例如播放器），請先關閉再輸出", hint=str(out)) from e
        raise OpError("Io", f"輸出檔無法取代：{e}", hint=str(out)) from e
    try:
        _retry_os(lambda: os.rename(probe, out), _REPLACE_BACKOFF_S)
    except OSError as e:
        raise OpError("Io", f"檢查輸出檔時無法改回原名：舊檔目前在 {probe.name}", hint=str(probe)) from e


def _is_readonly(p: Path) -> bool:
    """Windows 的唯讀**屬性**（`os.access(p, W_OK)` 在 Windows 上也只反映這個位元，但它對 ACL 拒絕的檔會回 True，
    容易被誤讀成「可以取代」；直接驗屬性位元，語意才跟註解一致）。ACL 那種只有真的 rename 才測得出來。"""
    if os.name != "nt":
        return False
    try:
        import stat as _stat

        return bool(os.stat(p).st_file_attributes & _stat.FILE_ATTRIBUTE_READONLY)  # type: ignore[attr-defined]
    except (OSError, AttributeError):
        return False


def _sweep_stale_parts(out: Path, now: float | None = None) -> None:
    """清掉 `<out>.<pid>-<8hex>.part` 裡「寫它的行程已經不在了」的那些。

    為什麼不只看時間（B-09 回歸）：改成唯一檔名之後，每一次被硬殺的渲染都會留一顆新的 .part，24 h 的門檻
    讓它們在使用者的輸出資料夾裡無限累積（舊版固定 `<out>.part`，最多留一顆而且下次渲染就蓋掉）。
    檔名裡有 pid，直接問作業系統那個 pid 還在不在最準；判不出來（pid 被重用、查不到）才退回 24 h 的保險線。

    **舊版的 `<out>.part` 不在清單裡**：那個名字在上一版是「編碼完成、只是換不進去」的完整成品（REL-4），
    刪掉它就等於刪掉使用者唯一一份輸出，與「完成的成品絕不刪」直接矛盾。留著不動。
    """
    now = time.time() if now is None else now
    try:
        names = os.listdir(out.parent)
    except OSError:
        return
    for name in names:
        pid = atomic.owner_pid(name, out.name, ".part")
        if pid is None:
            continue
        p = out.with_name(name)
        if atomic.is_inflight(p):
            continue  # 這個行程自己正在寫的
        try:
            if not p.is_file():
                continue
            # 自己的 pid ＋ 沒在 in-flight 名單上 ＝ 上一輪取消／失敗時沒刪成功的（sidecar 是長命行程）
            if pid != os.getpid() and atomic.pid_alive(pid) and now - p.stat().st_mtime <= PART_STALE_S:
                continue
            p.unlink()
        except OSError:
            pass


def _recover_orphan_probes(out: Path) -> None:
    """`ensure_replaceable` 的兩次 rename 之間被砍掉 → 使用者上一支成品卡在 `<out>.<pid>-<8hex>.probe`。

    這個名字以前沒有任何人會清也沒有人會救：`out` 不見了、成品在一個播放器打不開的副檔名底下。
    開工前掃一次：寫它的行程不在了就救回來——`out` 空著就直接改回 `out`，`out` 已經有新的成品就
    改名成 `<stem> (aivc N)<ext>`（絕不覆蓋任何既有檔）。
    """
    try:
        names = os.listdir(out.parent)
    except OSError:
        return
    for name in names:
        pid = atomic.owner_pid(name, out.name, ".probe")
        if pid is None or atomic.pid_alive(pid):
            continue
        p = out.with_name(name)
        try:
            if not p.is_file():
                continue
            if not out.exists():
                os.rename(p, out)
            else:
                _preserve_as_sibling(p, out)
        except OSError:
            pass


def _preserve_as_sibling(part: Path, out: Path) -> Path | None:
    """成品換不進 `out`：改名成 `<stem> (aivc N)<ext>`（N 從 1 起、不覆寫任何既有檔）。改名也失敗 → None（part 原地保留）。"""
    for n in range(1, 1000):
        cand = out.with_name(f"{out.stem} (aivc {n}){out.suffix}")
        try:
            fd = os.open(cand, os.O_CREAT | os.O_EXCL | os.O_WRONLY)  # 先佔名：兩個同時救援的渲染不會互蓋
        except FileExistsError:
            continue
        except OSError:
            return None
        os.close(fd)
        try:
            _retry_os(lambda: os.replace(part, cand), _REPLACE_BACKOFF_S)
            return cand
        except OSError:
            _unlink_quiet(cand)
            return None
    return None


@contextmanager
def atomic_output(out: Path) -> Iterator[Path]:
    """yield 唯一的 `<out>.<pid>-<8hex>.part`；成功換成 out，編碼失敗／取消一定把這個 .part 清掉。

    - 開工前（yield 之前）：救回沒人認領的 `.probe`（上一支成品）→ `out` 被鎖 → 立刻 Io（不白跑整段渲染）
      → 清掉「寫它的行程已經不在」的殘留 `.part`（舊版固定名的 `<out>.part` 不碰，那可能是完整成品）。
    - 收尾：換入被鎖就退避重試約 1.5 s；還是不行 → 成品改名 `<stem> (aivc N)<ext>` 並擲 Io 講出新檔名。
      **編碼完成的成品絕不刪**（以前下一次渲染同名輸出會先刪掉上次留下的完整 .part）。
    """
    out = Path(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    _recover_orphan_probes(out)
    ensure_replaceable(out)
    _sweep_stale_parts(out)
    part = out.with_name(f"{out.name}.{os.getpid()}-{uuid.uuid4().hex[:8]}.part")
    try:
        with atomic.inflight(part):
            yield part
    except BaseException:
        _unlink_quiet(part)
        raise
    if not part.exists():
        raise OpError("Ffmpeg", f"ffmpeg 沒有產出 {part.name}")
    try:
        _retry_os(lambda: os.replace(part, out), _REPLACE_BACKOFF_S)
    except OSError as e:
        kept = _preserve_as_sibling(part, out)
        if kept is not None:
            raise OpError("Io", f"輸出完成，但原檔被其他程式鎖住；成品另存為 {kept.name}", hint=str(kept)) from e
        raise OpError("Io", f"輸出完成，但無法寫到 {out.name}；成品保留在 {part.name}", hint=str(part)) from e


def _unlink_quiet(p: Path) -> None:
    atomic.unlink_quiet(p)  # Windows：子行程剛死、檔案句柄可能還沒釋放 → 退避幾次


class FfmpegProcess:
    """啟動一支 ffmpeg，可從 stdin 餵 rawvideo。stdout 讀 -progress，stderr 排空留尾巴。"""

    def __init__(self, args: list[str]) -> None:
        self.args = args
        self.proc: subprocess.Popen[bytes] | None = None
        self.progress: dict[str, str] = {}
        self.stderr_tail: deque[str] = deque(maxlen=_STDERR_TAIL)
        self._threads: list[threading.Thread] = []
        self.started_at = 0.0

    def start(self, stdin: bool = True) -> "FfmpegProcess":
        try:
            self.proc = subprocess.Popen(
                self.args,
                stdin=subprocess.PIPE if stdin else subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                **popen_kwargs(),
            )
        except OSError as e:
            raise OpError("Ffmpeg", f"啟動 ffmpeg 失敗：{e}") from e
        self.started_at = time.monotonic()
        for name, fn in (("stdout", self._drain_stdout), ("stderr", self._drain_stderr)):
            t = threading.Thread(target=fn, name=f"ffmpeg-{name}", daemon=True)
            t.start()
            self._threads.append(t)
        return self

    def _drain_stdout(self) -> None:
        assert self.proc and self.proc.stdout
        for raw in self.proc.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if "=" in line:
                k, _, v = line.partition("=")
                self.progress[k.strip()] = v.strip()

    def _drain_stderr(self) -> None:
        assert self.proc and self.proc.stderr
        for raw in self.proc.stderr:
            self.stderr_tail.append(raw.decode("utf-8", "replace").rstrip())

    @property
    def out_time_us(self) -> int:
        try:
            return int(self.progress.get("out_time_us", "0") or 0)
        except ValueError:
            return 0

    def write(self, data: bytes) -> None:
        assert self.proc and self.proc.stdin
        try:
            self.proc.stdin.write(data)
        except (BrokenPipeError, OSError) as e:
            self._join(2.0)
            raise OpError("Ffmpeg", "ffmpeg 提前結束（寫入管線失敗）", hint=self.tail_text()) from e

    def finish(self, timeout: float = 600.0) -> int:
        """關 stdin、等結束；非零退出碼擲 OpError(Ffmpeg) 附 stderr 尾巴。"""
        assert self.proc
        if self.proc.stdin:
            try:
                self.proc.stdin.close()
            except OSError:
                pass
        try:
            rc = self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired as e:
            self.kill()
            raise OpError("Timeout", f"ffmpeg 收尾超過 {timeout}s") from e
        self._join(5.0)
        if rc != 0:
            raise OpError("Ffmpeg", f"ffmpeg 退出碼 {rc}", hint=self.tail_text())
        return rc

    #: 被 kill 之後最多等多久（B-09 收尾預算）：Rust `Engine::stop` 只留 2.5–3 s 就硬殺 sidecar，
    #: 這裡等 5 s + drain 2 s 的話，`.part` 根本來不及被 `atomic_output` 刪掉。三段預算要由內而外遞增：
    #: kill 1.2 s ＋ drain 0.4 s < serve `_shutdown` 的 5 s < Rust 的 2.5–3 s 之後才會用到的硬殺。
    KILL_WAIT_S = 1.2
    KILL_DRAIN_S = 0.4

    def kill(self) -> None:
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.kill()
            except OSError:
                pass
            try:
                self.proc.wait(timeout=self.KILL_WAIT_S)
            except subprocess.TimeoutExpired:
                pass
        self._join(self.KILL_DRAIN_S)

    def _join(self, timeout: float) -> None:
        for t in self._threads:
            t.join(timeout)

    def tail_text(self) -> str:
        return "\n".join(self.stderr_tail)

    @property
    def elapsed(self) -> float:
        return time.monotonic() - self.started_at if self.started_at else 0.0


def extract_frame_rgb24(video: str, frame_index: int, vf: str = "") -> bytes:
    """用 ffmpeg 抽第 n 個解碼幀成 rgb24 raw（測試對照用；`select=eq(n,K)`）。"""
    filt = f"select=eq(n\\,{frame_index})"
    if vf:
        filt += "," + vf
    cp = run(
        [exe("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "error", "-i", video, "-vf", filt, "-vsync", "0",
         "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        timeout=300,
    )
    return cp.stdout
