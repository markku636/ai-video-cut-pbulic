"""`aivc serve`：JSONL sidecar（計畫 §5.8），Rust `engine.rs` 透過 stdin/stdout 呼叫 op。

線路格式（一行一 JSON，UTF-8）：
  請求  {"id","op","args"}
  事件  {"id","event":"progress","stage","done","total","eta_s"} | {"id","event":"log","level","message"} | {"id","event":"artifact","path","kind"}
  回覆  恰一次 {"id","ok":true,"result"} 或 {"id","ok":false,"error":{"kind","message","hint"}}

執行緒模型：
- 主執行緒＝讀取執行緒。控制 op（hello/ping/cancel/shutdown）在這裡**立刻**處理，不排隊 —— 否則 SAM 跑 5 分鐘時
  Rust 的 ping 會 timeout 兩次然後把我們砍掉重啟。
- 業務 op 進一條 queue，**唯一一條 worker 執行緒**嚴格序列執行（兩個 SAM 同跑必 OOM，計畫決策 8）。
- 例外：註冊時 `light=True`（`ops.LIGHT_OPS` 白名單）的短 op 走第二條 queue ＋ `aivc-light` 執行緒（B-06）。
  以前 render.plan 閒置 0.06 s，排在 pipeline.run 後面要 39–87 s，App 60 s 就逾時、而且逾時後照樣執行。
  light op 保證非 gpu、只讀；兩條 lane 各自序列。`AIVC_LIGHT_LANE=0` 關掉（全部回到單一 worker）。
- shutdown：先對所有工作設取消、再回覆、主迴圈結束後等兩條 worker 收尾（ffmpeg 被 kill、.part 清掉、回 Canceled）；
  Rust 端 stop() 收到回覆後會等行程自己退出（≤3 s）才硬殺（B-09）。
- 寫 stdout 只透過 `_emit()`，一把鎖，一行一 flush；**絕不**寫任何未經請求的東西到 stdout。stderr 只放 traceback／警告。

Windows 管線教訓（local_asr.rs）：讀取迴圈遇到非 UTF-8 或壞 JSON 的行**跳過並繼續**，不能結束迴圈；
progress 事件 ≥250 ms 節流（**每個 stage 各自節流**，stage 或 step 換了一定送）；大 payload 一律走檔案路徑。

Windows 死結（2026-09-17 App 內煙霧測試抓到、scratchpad/deadlock/repro.py 重現）：主執行緒在管線 stdin 上做
同步 `ReadFile` 等下一行時，worker 執行緒第一次載入帶 Fortran／OpenBLAS runtime 的原生擴充（scipy.linalg、
transformers → scipy.optimize → SAM2）會在 DLL 初始化時查詢標準輸入 handle；同步 I/O 在同一個 file object 上
序列化 → 初始化卡到 stdin 來下一行為止。Rust 在工作進行中不送 ping，所以 `pipeline.run` 會在 seg 開頭永久停住
（第一次整合跑停了 4 小時）。修法：`serve_forever` 先把管線 stdin 複製成私有 fd 給讀取迴圈用，再把行程的
標準輸入（fd 0 與 STD_INPUT_HANDLE）指到 NUL —— 原生 runtime 查到的是 NUL，不再碰管線。
"""
from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, BinaryIO, TextIO

from . import env
from ._version import __version__
from .errors import Canceled, OpError, exception_line, from_exception
from .progress import Throttle

PROTOCOL = 1
CONTROL_OPS = ("hello", "ping", "cancel", "shutdown")
MAX_LINE_WARN = 64 * 1024


@dataclass
class Job:
    id: Any  # 原樣回傳（str 或 int）
    op: str
    args: dict[str, Any]
    cancel: threading.Event = field(default_factory=threading.Event)
    started_at: float | None = None
    lane: str = "main"  # main | light


class ServeCtx:
    """op 執行期的 Ctx：事件帶請求 id、進度 250 ms 節流、取消旗標由 cancel op 設定。"""

    def __init__(self, server: "Server", job: Job) -> None:
        self._server = server
        self._job = job
        # 每個 stage 一個節流器：以前整個 job 共用一個，`pipeline.run` 的 step 標記（index/shots/detect/seg）
        # 常在上一個子 stage 的事件 250 ms 內送出而被吃掉，UI 看不到換步驟
        self._throttles: dict[str, Throttle] = {}
        self._last_key: tuple[str, Any] | None = None
        self._started = time.monotonic()
        # 每個 stage 自己的起點 (時刻, 那時的 done)：eta 只能用「這個 stage 走了多久」外推（B-14）
        self._stage_started: dict[str, tuple[float, int]] = {}

    def progress(self, stage: str, done: int, total: int, **extra: Any) -> None:
        th = self._throttles.get(stage)
        if th is None:
            th = self._throttles[stage] = Throttle()
        key = (stage, extra.get("step"))
        changed = key != self._last_key
        ready = th.ready(done, total)  # 一定要呼叫（更新節流器的時間戳）
        if not (ready or changed):
            return
        self._last_key = key
        now = time.monotonic()
        started = self._stage_started.get(stage)
        if started is None or done < started[1]:  # 沒看過這個 stage，或 done 倒退（同一個 stage 又跑一輪）→ 重新起算
            started = self._stage_started[stage] = (now, int(done))
        ev: dict[str, Any] = {"id": self._job.id, "event": "progress", "stage": stage, "done": int(done), "total": int(total)}
        # eta 以前用 self._started（整個 job 的起點）算：pipeline.run 跑到 track 的第一筆時，
        # 前面 seg 花掉的時間全被算進「每單位進度的成本」，實測 2/836 那一筆回 11213.5 s（本階段實際 39.9 s）。
        # 改成從**這個 stage 的第一筆**起算；本 stage 還沒有任何進展（advanced == 0）時不送 eta，寧可不顯示也不騙人。
        if total > 0 and 0 < done < total:
            elapsed = now - started[0]
            advanced = int(done) - started[1]
            if advanced > 0 and elapsed > 0:
                ev["eta_s"] = round(elapsed * (total - done) / advanced, 1)
        ev.update(extra)
        self._server._emit(ev)

    def log(self, level: str, message: str) -> None:
        self._server._emit({"id": self._job.id, "event": "log", "level": level, "message": message})

    def check_cancel(self) -> None:
        if self._job.cancel.is_set():
            raise Canceled()

    def artifact(self, path: str, kind: str = "") -> None:
        self._server._emit({"id": self._job.id, "event": "artifact", "path": env.normalize_path(path), "kind": kind})


class Server:
    def __init__(self, stdin: BinaryIO, stdout: BinaryIO, stderr: TextIO, *, torch_probe: bool = True) -> None:
        self._in = stdin
        self._out = stdout
        self._err = stderr
        self._torch_probe = torch_probe
        self._out_lock = threading.Lock()
        self._jobs_lock = threading.Lock()
        self._jobs: dict[Any, Job] = {}  # 排隊中 + 執行中
        self._queue: "queue.Queue[Job | None]" = queue.Queue()
        self._busy: Job | None = None
        self._stopping = threading.Event()
        self._started = time.monotonic()
        self._worker = threading.Thread(target=self._worker_loop, name="aivc-worker", daemon=True)
        self._n_done = 0
        # 輕量 lane（B-06）：light op 專用，與主 worker 並行
        self._light_enabled = os.environ.get("AIVC_LIGHT_LANE", "1").strip() != "0"
        self._light_queue: "queue.Queue[Job | None]" = queue.Queue()
        self._light_busy: Job | None = None
        self._light_worker = threading.Thread(target=self._worker_loop, args=(self._light_queue,), name="aivc-light", daemon=True)

    # ------------------------------------------------------------ output
    def _emit(self, obj: dict[str, Any]) -> None:
        line = json.dumps(obj, ensure_ascii=False, default=_json_default).encode("utf-8") + b"\n"
        if len(line) > MAX_LINE_WARN:
            self._warn(f"stdout 單行 {len(line)} bytes 超過 64 KB（op={obj.get('event') or 'reply'} id={obj.get('id')!r}）：大 payload 應走檔案路徑")
        with self._out_lock:
            self._out.write(line)
            self._out.flush()

    def _reply_ok(self, rid: Any, result: Any) -> None:
        self._emit({"id": rid, "ok": True, "result": result})

    def _reply_err(self, rid: Any, kind: str, message: str, hint: str = "") -> None:
        self._emit({"id": rid, "ok": False, "error": {"kind": kind, "message": message, "hint": hint}})

    def _warn(self, msg: str) -> None:
        try:
            self._err.write(f"aivc serve: {msg}\n")
            self._err.flush()
        except Exception:  # noqa: BLE001
            pass

    # ------------------------------------------------------------ main loop
    def run(self) -> int:
        from .ops import LOAD_ERRORS, load_all

        try:
            load_all()
        except Exception as e:  # noqa: BLE001
            # op 模組壞掉不能讓 sidecar 起不來：記到 stderr，hello 仍可回，壞的 op 呼叫時會是 Invalid
            self._warn(f"載入 ops 失敗：{type(e).__name__}: {e}")
            self._err.write(traceback.format_exc())
        # load_all 逐模組收集到的問題：每一筆都講清楚是哪個模組／哪支 op（不然只會看到「未知 op」）
        for msg in LOAD_ERRORS:
            self._warn(msg)
        self._worker.start()
        self._light_worker.start()
        try:
            while not self._stopping.is_set():
                raw = self._in.readline()
                if not raw:
                    break  # stdin EOF：Rust 端關了，我們也收
                self._handle_line(raw)
        except KeyboardInterrupt:
            pass
        finally:
            self._shutdown()
        return 0

    def _handle_line(self, raw: bytes) -> None:
        raw = raw.strip()
        if not raw:
            return
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            self._warn(f"stdin 有一行不是 UTF-8（{len(raw)} bytes），跳過")
            return
        try:
            req = json.loads(text)
        except json.JSONDecodeError as e:
            self._warn(f"stdin 有一行不是 JSON（{e.msg}），跳過：{text[:80]!r}")
            return
        if not isinstance(req, dict):
            self._warn(f"請求不是物件，跳過：{text[:80]!r}")
            return
        rid = req.get("id")
        if not isinstance(rid, (str, int)) or isinstance(rid, bool):
            self._warn(f"請求缺 id（str|int），跳過：{text[:80]!r}")
            return
        op = req.get("op")
        if not isinstance(op, str) or not op:
            self._reply_err(rid, "Invalid", "請求缺 op")
            return
        args = req.get("args")
        if args is None:
            args = {}
        if not isinstance(args, dict):
            self._reply_err(rid, "Invalid", "args 必須是物件")
            return
        if op in CONTROL_OPS:
            self._control(rid, op, args)
            return
        self._enqueue(rid, op, args)

    # ------------------------------------------------------------ control ops（讀取執行緒）
    def _control(self, rid: Any, op: str, args: dict[str, Any]) -> None:
        if op == "hello":
            self._reply_ok(rid, self.hello_info(probe_torch=bool(args.get("torch", self._torch_probe))))
        elif op == "ping":
            self._reply_ok(rid, self.ping_info())
        elif op == "cancel":
            target = args.get("id", args.get("jobId", args.get("job_id")))
            with self._jobs_lock:
                job = self._jobs.get(target)
            if job is not None:
                job.cancel.set()
            self._reply_ok(rid, {"id": target, "found": job is not None, "running": job is not None and job.started_at is not None})
        elif op == "shutdown":
            # 先取消再回覆：Rust 收到回覆時工作已經在收尾（kill ffmpeg、刪 .part），不會在半途被硬殺留下殘檔
            self._cancel_all()
            self._reply_ok(rid, {"shutdown": True})
            self._stopping.set()

    def hello_info(self, *, probe_torch: bool = True) -> dict[str, Any]:
        info: dict[str, Any] = {
            "version": __version__,
            "protocol": PROTOCOL,
            "python": sys.version.split()[0],
            "executable": sys.executable,
            "pid": os.getpid(),
            "loadErrors": list(_load_errors()),
            # 已載入的外掛（aivc.plugins）：App 依此決定要不要開外掛的功能（例：牌局外掛 name=cards）。舊 App 不讀這個鍵
            "plugins": _plugins(),
            "torch": None,
            "cuda": False,
            "device": None,
            "capability": None,
            # 以下是跨平台欄位（舊 App 只讀上面四個，多出來的鍵不影響它）：
            # backend＝模型實際會用的裝置 cuda／mps／cpu（cpu 只在 AIVC_ALLOW_CPU=1；沒有可用裝置是 None，原因在 deviceReason）
            "backend": None,
            "mps": False,
            "memoryMB": None,  # cuda：顯示卡總 VRAM；mps：整機統一記憶體（unifiedMemory=True）
            "unifiedMemory": False,
            "dtype": None,
            "deviceReason": None,
        }
        if probe_torch:
            try:
                env.apply_model_env()
                import torch  # noqa: WPS433  （惰性：首次 import 10–40 s，只有 hello 付這個代價）

                from . import device as dev

                # 裝置判斷只在 aivc.device 做（cuda → mps → 放行時 cpu）：以前這裡自己問 torch.cuda，Mac 上永遠回「沒有裝置」
                d = dev.describe(torch)
                info["torch"] = torch.__version__
                info["cuda"] = bool(d["cuda"])
                info["mps"] = bool(d["mps"])
                info["backend"] = d["backend"]
                info["device"] = d["device"]
                info["capability"] = d["capability"]
                info["memoryMB"] = d["memoryMB"]
                info["unifiedMemory"] = bool(d["unifiedMemory"])
                info["dtype"] = d["dtype"]
                info["deviceReason"] = d["reason"]
                self._backend = d["backend"]
            except Exception as e:  # noqa: BLE001
                info["torchError"] = f"{type(e).__name__}: {e}"
        try:
            import cv2  # noqa: WPS433

            info["cv2"] = cv2.__version__
        except Exception:  # noqa: BLE001
            info["cv2"] = None
        return info

    def ping_info(self) -> dict[str, Any]:
        busy = self._busy
        light_busy = self._light_busy
        with self._jobs_lock:
            queued = sum(1 for j in self._jobs.values() if j.started_at is None)
            light_queued = sum(1 for j in self._jobs.values() if j.started_at is None and j.lane == "light")
        vram: int | None = None
        backend: str | None = getattr(self, "_backend", None)
        torch = sys.modules.get("torch")  # 不為了 ping 去 import torch
        if torch is not None:
            from . import device as dev

            # cuda：memory_allocated；mps：torch.mps.current_allocated_memory（MPS 沒有 per-device 統計，這是本行程張量用量）。
            # 以前只問 cuda，Mac 上 vram_used_mb 永遠是 null，看不出 SAM 吃了多少共用記憶體。
            try:
                if dev.cuda_available(torch):
                    backend = "cuda"
                elif dev.mps_available(torch):
                    backend = "mps"
                elif backend is None and dev.allow_cpu():
                    backend = "cpu"
                vram = dev.current_memory_allocated_mb(torch)
            except Exception:  # noqa: BLE001
                vram = None
        return {
            "uptime_s": round(time.monotonic() - self._started, 1),
            "busy_id": busy.id if busy else None,  # 主 worker（長工作）；舊 App 讀這三個鍵
            "busy_op": busy.op if busy else None,
            "queued": queued,  # 兩條 lane 合計還沒開始的
            "lanes": {
                "main": {"busy_id": busy.id if busy else None, "busy_op": busy.op if busy else None, "queued": queued - light_queued},
                "light": {
                    "busy_id": light_busy.id if light_busy else None,
                    "busy_op": light_busy.op if light_busy else None,
                    "queued": light_queued,
                    "enabled": self._light_enabled,
                },
            },
            "done": self._n_done,
            "backend": backend,  # cuda／mps／cpu；hello 還沒探過 torch、也還沒有 op 載入 torch 時是 None
            "vram_used_mb": vram,  # 名稱沿用（App 已在讀）；mps 時是共用記憶體裡本行程張量的用量
        }

    # ------------------------------------------------------------ business ops（worker）
    def _enqueue(self, rid: Any, op: str, args: dict[str, Any]) -> None:
        from .ops import REGISTRY

        if op not in REGISTRY:
            self._reply_err(rid, "Invalid", f"未知 op {op!r}", f"可用：{', '.join(sorted(REGISTRY))}")
            return
        light = self._light_enabled and bool(getattr(REGISTRY[op], "light", False))
        job = Job(rid, op, args, lane="light" if light else "main")
        with self._jobs_lock:
            if rid in self._jobs:
                self._reply_err(rid, "Invalid", f"id {rid!r} 已有進行中的請求")
                return
            self._jobs[rid] = job
        (self._light_queue if light else self._queue).put(job)

    def _worker_loop(self, q: "queue.Queue[Job | None] | None" = None) -> None:
        q = self._queue if q is None else q
        while True:
            job = q.get()
            if job is None:
                return
            self._run_job(job)

    def _set_busy(self, job: Job, value: Job | None) -> None:
        if job.lane == "light":
            self._light_busy = value
        else:
            self._busy = value

    def _run_job(self, job: Job) -> None:
        from .ops import REGISTRY

        if job.cancel.is_set():
            self._finish(job)
            self._reply_err(job.id, "Canceled", "已取消（尚未開始）")
            return
        job.started_at = time.monotonic()
        self._set_busy(job, job)
        ctx = ServeCtx(self, job)
        try:
            op = REGISTRY[job.op]
            result = op.fn(job.args, ctx)
            if isinstance(result, dict):
                result = {k: v for k, v in result.items() if not k.startswith("_")}  # _exit_code/_human 是 CLI 專用
            self._finish(job)
            self._reply_ok(job.id, result)
        except Canceled:
            self._finish(job)
            self._reply_err(job.id, "Canceled", "已取消")
        except OpError as e:
            self._finish(job)
            w = e.to_wire()
            # stderr ＝ engine.log：以前 OpError 只走回覆線路，App 崩完之後去翻 log 什麼都沒有（B-11）。
            # 死因常常只在 hint 裡（ffmpeg 的 Permission denied / No space left on device）。
            self._warn(f"op {job.op} 失敗 {w['kind']}: {w['message']}" + (f" | {w['hint']}" if w["hint"] else ""))
            self._reply_err(job.id, w["kind"], w["message"], w["hint"])
        except BaseException as e:  # noqa: BLE001  未捕捉例外：回 Internal，行程繼續活著
            tb = traceback.format_exc()
            try:
                self._err.write(tb)
                self._err.flush()
            except Exception:  # noqa: BLE001
                pass
            self._finish(job)
            err = from_exception(e, tb=tb)
            w = err.to_wire()
            self._reply_err(job.id, w["kind"], w["message"], w["hint"] or exception_line(tb))

    def _finish(self, job: Job) -> None:
        with self._jobs_lock:
            self._jobs.pop(job.id, None)
            self._n_done += 1  # 兩條 lane 都會加：+= 不是原子操作
        self._set_busy(job, None)

    # ------------------------------------------------------------ shutdown
    def _cancel_all(self) -> None:
        with self._jobs_lock:
            jobs = list(self._jobs.values())
        for j in jobs:
            j.cancel.set()

    def _shutdown(self) -> None:
        self._stopping.set()
        self._cancel_all()
        self._queue.put(None)
        self._light_queue.put(None)
        # worker 是 daemon；兩條 lane 合計最多等 5 s 讓進行中的 op 回 Canceled（ffmpeg 被 kill、.part 清掉），之後直接離開
        deadline = time.monotonic() + 5.0
        for t in (self._worker, self._light_worker):
            if t.is_alive():
                t.join(timeout=max(0.0, deadline - time.monotonic()))


def _plugins() -> list[dict[str, Any]]:
    """已載入的外掛（沒探索過也不會炸）。"""
    try:
        from . import plugins

        return [p.to_json() for p in plugins.loaded()]
    except Exception:  # noqa: BLE001
        return []


def _load_errors() -> list[str]:
    """load_all() 收集到的載入問題（沒 import 過 ops 也不會炸）。"""
    try:
        from .ops import LOAD_ERRORS

        return list(LOAD_ERRORS)
    except Exception:  # noqa: BLE001
        return []


def _json_default(o: Any) -> Any:
    """讓 numpy 標量／Path 等常見型別能上線路；其他型別退回 str。"""
    try:
        import numpy as np  # noqa: WPS433

        if isinstance(o, np.generic):
            return o.item()
        if isinstance(o, np.ndarray):
            return o.tolist()
    except Exception:  # noqa: BLE001
        pass
    if isinstance(o, os.PathLike):
        return os.fspath(o)
    return str(o)


STD_INPUT_HANDLE = -10


def detach_std_input() -> BinaryIO | None:
    """Windows：回傳讀管線用的私有 binary stream，並把行程標準輸入（fd 0、sys.stdin、STD_INPUT_HANDLE）改指 NUL。

    為什麼（見模組 docstring 的「Windows 死結」）：同步 I/O 在同一個 file object 上序列化，主執行緒卡在管線
    ReadFile 時，別的執行緒載入原生 DLL 查標準輸入就會一起卡住。`os.dup` 得到的是 DuplicateHandle（同一個
    file object），所以讀取仍走管線；關鍵是讓**標準輸入 handle** 不再指向管線，初始化碼查到的是 NUL。
    非 Windows 或 stdin 不是真 fd（測試注入 BytesIO）→ 回 None，呼叫端照舊用 sys.stdin.buffer。
    """
    if os.name != "nt":
        return None
    try:
        fd0 = sys.stdin.fileno() if sys.stdin is not None else 0
    except (AttributeError, OSError, ValueError):
        return None
    try:
        pipe_fd = os.dup(fd0)
        nul_fd = os.open(os.devnull, os.O_RDONLY)
        os.dup2(nul_fd, fd0)  # UCRT _dup2 對 fd 0 也會 SetStdHandle；下面再明確設一次不依賴實作細節
        os.close(nul_fd)
        import ctypes
        import msvcrt

        ctypes.windll.kernel32.SetStdHandle(STD_INPUT_HANDLE, ctypes.c_void_p(msvcrt.get_osfhandle(fd0)))
        sys.stdin = open(fd0, "r", encoding="utf-8", closefd=False)  # 第三方讀 sys.stdin 只會拿到 EOF
        return os.fdopen(pipe_fd, "rb")
    except Exception as e:  # noqa: BLE001  隔離失敗不能讓 sidecar 起不來，退回舊行為並留紀錄
        try:
            sys.stderr.write(f"aivc serve: 無法把標準輸入從管線隔離（{type(e).__name__}: {e}），原生模組載入可能死結\n")
        except Exception:  # noqa: BLE001
            pass
        return None


def serve_forever(*, torch_probe: bool = True) -> int:
    """給 ops/serve.py 呼叫：把 stdout 切到 binary（避免文字層再編碼一次），跑到 shutdown 或 stdin EOF。"""
    env.ensure_utf8_stdio()
    env.apply_model_env()
    stdin = detach_std_input() or getattr(sys.stdin, "buffer", sys.stdin)
    stdout = getattr(sys.stdout, "buffer", sys.stdout)
    return Server(stdin, stdout, sys.stderr, torch_probe=torch_probe).run()
