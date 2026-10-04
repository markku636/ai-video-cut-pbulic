"""進度節流：≥250 ms 才送一次，但第一筆與最後一筆（done == total）一定送。

為什麼要節流：sidecar 的 progress 事件走 stdout 管線；逐幀（30 fps × 多鏡頭）不節流會把 64 KB 的
Windows 管線寫爆，Rust 端來不及讀就死鎖（local_asr.rs 的教訓）。CLI 端也一樣，stderr 洗版沒意義。
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

DEFAULT_INTERVAL_S = 0.25


class _Emitter(Protocol):
    def progress(self, stage: str, done: int, total: int, **extra: Any) -> None: ...


@dataclass
class Throttle:
    """純判斷器：`ready(done, total)` 回 True 表示這一筆該送。可注入時鐘方便測試。"""

    interval_s: float = DEFAULT_INTERVAL_S
    clock: Callable[[], float] = time.monotonic
    _last: float = field(default=float("-inf"), init=False, repr=False)
    _last_done: int | None = field(default=None, init=False, repr=False)

    def ready(self, done: int, total: int) -> bool:
        now = self.clock()
        is_first = self._last == float("-inf")
        is_last = total > 0 and done >= total
        if is_first or is_last or (now - self._last) >= self.interval_s:
            self._last = now
            self._last_done = done
            return True
        return False

    def reset(self) -> None:
        self._last = float("-inf")
        self._last_done = None


def eta_seconds(started_at: float, done: int, total: int, *, now: float | None = None) -> float | None:
    """線性外推的剩餘秒數；沒進度或已完成回 None。"""
    if total <= 0 or done <= 0:
        return None
    if done >= total:
        return 0.0
    now = time.monotonic() if now is None else now
    elapsed = max(now - started_at, 0.0)
    return round(elapsed * (total - done) / done, 1)


@dataclass
class ProgressReporter:
    """把「某個 stage 的 done/total」包成一個物件：`tick(done)` 自動節流、自動算 eta。

    用法：
        rep = ProgressReporter(ctx, "seg.propagate", total=n_frames)
        for k in range(n_frames):
            ctx.check_cancel(); ...; rep.tick(k + 1)
    """

    emitter: _Emitter
    stage: str
    total: int
    interval_s: float = DEFAULT_INTERVAL_S
    clock: Callable[[], float] = time.monotonic
    _throttle: Throttle = field(init=False, repr=False)
    _started: float = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._throttle = Throttle(self.interval_s, self.clock)
        self._started = self.clock()

    def tick(self, done: int, **extra: Any) -> bool:
        """回 True 表示真的送出去了。"""
        if not self._throttle.ready(done, self.total):
            return False
        eta = eta_seconds(self._started, done, self.total, now=self.clock())
        if eta is not None and "eta_s" not in extra:
            extra["eta_s"] = eta
        self.emitter.progress(self.stage, done, self.total, **extra)
        return True

    def finish(self, **extra: Any) -> None:
        """強制送最後一筆（done == total）。"""
        self._throttle.reset()
        self.tick(self.total, **extra)
