"""sequence — 序列（V1 磁吸主軌＋音訊軌）的純函式對應表（設計 docs/editor-m2-design.md §3.1、§3.3、§7.1）。

剪輯語意（split／ripple／trim…）只在 TS `src/sequence/ops.ts` 一份（決策 12）；引擎這邊只**讀**序列：
序列幀 t → (媒體, 來源 proxy 幀 k)、樣本換算、`-c:a copy` 閘門。TS 鏡像在 `src/sequence/map.ts`，
兩邊共用 `fixtures/sequence/map-cases.json` 的期望值，防止雙實作漂移。
"""
from __future__ import annotations

from .model import (
    Placed,
    audio_abs_us,
    describe,
    duration_frames,
    is_untouched,
    is_untouched_with,
    item_at,
    map_frame,
    map_frame_placed,
    place_video,
    round_half_up,
    samples_of_frame,
    total_samples,
    video_abs_us,
)

__all__ = [
    "Placed",
    "audio_abs_us",
    "describe",
    "duration_frames",
    "is_untouched",
    "is_untouched_with",
    "item_at",
    "map_frame",
    "map_frame_placed",
    "place_video",
    "round_half_up",
    "samples_of_frame",
    "total_samples",
    "video_abs_us",
]
