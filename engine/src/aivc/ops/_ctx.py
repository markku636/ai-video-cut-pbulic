"""CLI 用的 Ctx：進度印到 stderr（人類）或 stdout JSONL（--json）。sidecar 的 ServeCtx 在 serve.py。"""
from __future__ import annotations

import json
import sys
import time
from typing import Any

from . import Canceled


class CliCtx:
    def __init__(self, json_mode: bool = False, request_id: str = "cli") -> None:
        self.json_mode = json_mode
        self.request_id = request_id
        self._last_emit = 0.0
        self._canceled = False

    # ---- Ctx protocol ----
    def progress(self, stage: str, done: int, total: int, **extra: Any) -> None:
        now = time.monotonic()
        if now - self._last_emit < 0.25 and done < total:  # ≥250 ms 節流；最後一筆一定送
            return
        self._last_emit = now
        if self.json_mode:
            self._emit({"id": self.request_id, "event": "progress", "stage": stage, "done": done, "total": total, **extra})
        else:
            pct = (100 * done // total) if total else 0
            print(f"[{stage}] {done}/{total} {pct}%", file=sys.stderr, flush=True)

    def log(self, level: str, message: str) -> None:
        if self.json_mode:
            self._emit({"id": self.request_id, "event": "log", "level": level, "message": message})
        else:
            print(f"{level}: {message}", file=sys.stderr, flush=True)

    def check_cancel(self) -> None:
        if self._canceled:
            raise Canceled()

    def artifact(self, path: str, kind: str = "") -> None:
        if self.json_mode:
            self._emit({"id": self.request_id, "event": "artifact", "path": path, "kind": kind})
        else:
            print(f"artifact: {path}", file=sys.stderr, flush=True)

    # ---- helpers ----
    def cancel(self) -> None:
        self._canceled = True

    def _emit(self, obj: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
