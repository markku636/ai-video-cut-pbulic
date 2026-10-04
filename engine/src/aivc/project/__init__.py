"""project — 專案檔 `*.aivc.json`（schema v1，TS `src/project/format.ts` 是 SoT，這裡讀寫同一份 camelCase JSON）與快取路徑。"""
from __future__ import annotations

from .paths import MediaCache, media_cache, safe_component
from .schema import (
    SCHEMA_VERSION,
    KeyframeV1,
    LoadResult,
    MediaV1,
    ProjectFileV1,
    PromptV1,
    Quad,
    ShotV1,
    TrackV1,
    load,
    loads,
    save,
)

__all__ = [
    "SCHEMA_VERSION",
    "KeyframeV1",
    "LoadResult",
    "MediaV1",
    "ProjectFileV1",
    "PromptV1",
    "Quad",
    "ShotV1",
    "TrackV1",
    "load",
    "loads",
    "save",
    "MediaCache",
    "media_cache",
    "safe_component",
]
