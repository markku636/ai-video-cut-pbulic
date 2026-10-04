"""快取目錄佈局 `<app_cache_dir>/media/<fp16>/`（計畫 §5.3）。全部可重生；缺就重算。

    probe.v1.json   index.v1.json   shots.v1.json   proxy.mp4   proxy.v1.json   thumbs/   tracks/<trackId>/
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .. import atomic, env
from . import fingerprint as _fp


@dataclass(frozen=True)
class MediaCache:
    fingerprint: str  # 64 碼
    dir: Path

    @property
    def probe_json(self) -> Path:
        return self.dir / "probe.v1.json"

    @property
    def index_json(self) -> Path:
        return self.dir / "index.v1.json"

    @property
    def shots_json(self) -> Path:
        return self.dir / "shots.v1.json"

    @property
    def proxy_mp4(self) -> Path:
        return self.dir / "proxy.mp4"

    @property
    def proxy_json(self) -> Path:
        return self.dir / "proxy.v1.json"

    def ensure(self) -> Path:
        self.dir.mkdir(parents=True, exist_ok=True)
        return self.dir


def for_file(path: str | os.PathLike[str]) -> MediaCache:
    fp = _fp.fingerprint(path)
    return MediaCache(fingerprint=fp, dir=env.media_cache_dir(fp))


def write_json(path: Path, obj: dict[str, Any]) -> Path:
    """先寫**唯一**的 `.part` 再 rename：半寫的 JSON 不能被別人（Rust cache_read、另一條 lane）讀到。

    暫存名帶 pid + 亂數（`atomic.temp_sibling`）：兩條 worker lane 同時重建同一份 index 時，
    固定的 `<name>.part` 會互相搬走對方的暫存檔（B-06 實測會讓其中一條 lane 直接死掉）。
    """
    with atomic.atomic_write(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    return path


def read_json(path: Path) -> dict[str, Any] | None:
    """讀不到 / 壞掉回 None（＝沒有快取）。被別條 lane 的 `os.replace` 擋住時先退避重試，
    不然會誤判成「沒有快取」而整支影片重解一次索引。"""
    try:
        return json.loads(atomic.read_text(path))
    except (OSError, ValueError):
        return None
