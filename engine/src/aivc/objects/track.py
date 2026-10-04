"""ObjectTrack：一個被追蹤的物件＝逐幀遮罩（`.aivm`）＋逐幀錨點（`anchors.v1.json`）。

特效（`aivc.fx`）、匯出（`objects.export`）、外掛都從這裡拿資料；它只讀，不寫遮罩檔。
`frame(k)` 回 `ObjectFrame`：這一幀的遮罩、錨點，以及「參考錨點」（第一個可見幀，貼紙跟著縮放／旋轉時的基準）。
"""
from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .anchors import DEFAULT_ORDER, DEFAULT_WINDOW, Anchor, Anchors, load_or_compute


@dataclass(frozen=True)
class ObjectFrame:
    """特效在第 k 幀看到的一個物件。mask=None ＝ 這一幀物件不在（或沒算過）。"""

    mask: np.ndarray | None
    anchor: Anchor | None
    reference: Anchor | None = None
    lookup: Callable[[int], Anchor | None] | None = None  # 給 refFrame 指定別的參考幀用
    run_anchors: Callable[[int], tuple[Anchor, ...]] | None = field(default=None, compare=False)  # 第 N 段連續可見的所有錨點
    memo: dict[Any, Any] | None = field(default=None, compare=False)  # 同一個物件跨幀共用的快取（例如馬賽克的逐段格子大小）

    @property
    def visible(self) -> bool:
        return self.mask is not None and self.anchor is not None and self.anchor.visible


class ObjectTrack:
    def __init__(self, path: str, mask_file: object, anchors: Anchors, *, cache_hit: bool = False) -> None:
        self.path = path
        self.masks = mask_file
        self.anchors = anchors
        self.cache_hit = cache_hit
        self._ref = anchors.first_visible()
        self._runs: dict[int, tuple[Anchor, ...]] | None = None
        self.memo: dict[Any, Any] = {}

    @classmethod
    def open(
        cls, path: str | os.PathLike[str], *, window: int = DEFAULT_WINDOW, order: int = DEFAULT_ORDER, cache: bool = True, ctx: Any = None,
    ) -> ObjectTrack:
        """讀一次檔：遮罩與錨點快取鍵用同一份位元組（別的行程同時在改這個檔也不會配錯）。
        ctx（可省）：沒有快取、要算錨點時送 `objects.anchors` 進度、可取消。"""
        from .. import atomic
        from ..seg.maskfile import MaskFile

        p = Path(path)
        raw = atomic.read_bytes(p)
        mf = MaskFile.from_bytes(raw, str(p))
        anchors, hit = load_or_compute(p, window=window, order=order, cache=cache, mask_file=mf, raw=raw, ctx=ctx)
        return cls(str(p), mf, anchors, cache_hit=hit)

    @property
    def width(self) -> int:
        return int(self.anchors.width)

    @property
    def height(self) -> int:
        return int(self.anchors.height)

    def mask(self, k: int) -> np.ndarray | None:
        return self.masks.get(int(k))  # type: ignore[attr-defined]

    def anchor(self, k: int) -> Anchor | None:
        return self.anchors.at(k)

    def visible(self, k: int) -> bool:
        a = self.anchors.at(k)
        return bool(a is not None and a.visible)

    def reference(self) -> Anchor | None:
        return self._ref

    def run_anchors(self, run: int) -> tuple[Anchor, ...]:
        """第 run 段連續可見的錨點（k 遞增）。第一次呼叫時一次分好所有段。"""
        if self._runs is None:
            runs: dict[int, list[Anchor]] = {}
            for k in self.anchors.ks():
                a = self.anchors.frames[k]
                if a.visible and a.run is not None:
                    runs.setdefault(int(a.run), []).append(a)
            self._runs = {r: tuple(v) for r, v in runs.items()}
        return self._runs.get(int(run), ())

    def frame(self, k: int) -> ObjectFrame:
        a = self.anchors.at(k)
        m = self.mask(k) if a is not None and a.visible else None
        return ObjectFrame(m, a, self._ref, self.anchors.at, self.run_anchors, self.memo)
