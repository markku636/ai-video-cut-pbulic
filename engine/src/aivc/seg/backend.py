"""分割後端協定（幀來源無關）。實作：`sam2_hf.Sam2HfBackend`；日後 `AIVC_SAM_BACKEND=sam3` 走同一協定。

提示（prompt）用詞對齊 UI／Kling／Photoshop 慣例（計畫 §17）：
- 點標籤 `LABEL_ADD = 1`    → **加選 Add Selection**（這一點屬於物件）
- 點標籤 `LABEL_REDUCE = 0` → **減選 Reduce Selection**（這一點不屬於物件，例如擋在前面的手）
- 框 `Box = (x, y, w, h)`   → 來源像素座標，左上角 + 寬高（專案檔與 detect 都用這個形狀；SAM 內部才轉 xyxy）

座標一律是**來源像素空間**（決策 4），幀號一律是呼叫端給的整數 k（引擎不解釋它是 proxy 幀還是來源幀）。

串流語意：session 只看得到你餵給它的幀。`add_prompt` 必須附上該幀的 RGB8 影像（SAM2 要算該幀特徵），
`propagate` 沿一個方向餵幀：'fwd' 幀號嚴格遞增、'bwd' 嚴格遞減，從錨定幀的鄰幀開始最準
（SAM2 的記憶庫只回看最近 6 幀 + 16 個物件指標；跳幀餵會退化但不會錯）。
"""
from __future__ import annotations

from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass, field
from typing import Literal, Protocol

import numpy as np

LABEL_ADD = 1  # 加選 Add Selection
LABEL_REDUCE = 0  # 減選 Reduce Selection

Point = tuple[float, float, int]  # (x, y, label)
Box = tuple[float, float, float, float]  # (x, y, w, h)
Direction = Literal["fwd", "bwd"]


class SegModelError(RuntimeError):
    """模型載入／GPU 問題；ops 層映射成 OpError(kind=Model|Gpu)。"""

    def __init__(self, kind: str, message: str, hint: str = "") -> None:
        super().__init__(message)
        self.kind = kind
        self.hint = hint


@dataclass(frozen=True)
class FrameMasks:
    """一幀所有物件的結果。`scores[obj] < 0` ＝ 模型認為物件不在畫面（SAM2 的 object score logit）。"""

    k: int
    masks: dict[int, np.ndarray]
    scores: dict[int, float]


@dataclass
class SessionStats:
    prompt_frames: int = 0
    prompt_seconds: float = 0.0
    propagated_frames: int = 0
    propagate_seconds: float = 0.0  # 只算模型前處理+推論+後處理，不含解碼
    per_frame_seconds: list[float] = field(default_factory=list)

    @property
    def s_per_frame(self) -> float:
        return self.propagate_seconds / self.propagated_frames if self.propagated_frames else 0.0


def validate_points(points: Sequence[Point]) -> list[Point]:
    out: list[Point] = []
    for p in points:
        if len(p) != 3:
            raise ValueError(f"點必須是 (x, y, label)，拿到 {p!r}")
        x, y, label = p
        if int(label) not in (LABEL_ADD, LABEL_REDUCE):
            raise ValueError(f"點標籤只能是 {LABEL_ADD}（加選）或 {LABEL_REDUCE}（減選），拿到 {label!r}")
        out.append((float(x), float(y), int(label)))
    return out


def validate_box(box: Box) -> Box:
    if len(box) != 4:
        raise ValueError(f"框必須是 (x, y, w, h)，拿到 {box!r}")
    x, y, w, h = (float(v) for v in box)
    if w <= 0 or h <= 0:
        raise ValueError(f"框的寬高必須 > 0，拿到 w={w} h={h}")
    return (x, y, w, h)


class SegSession(Protocol):
    """一個（鏡頭）串流分割 session。"""

    frame_size: tuple[int, int]  # (width, height)
    stats: SessionStats

    @property
    def object_ids(self) -> list[int]: ...

    def add_prompt(
        self,
        frame_idx: int,
        obj_id: int,
        frame_rgb: np.ndarray,
        *,
        points: Sequence[Point] = (),
        box: Box | None = None,
    ) -> np.ndarray:
        """在 frame_idx 幀對 obj_id 下提示，立刻回該幀的 bool 遮罩（UI「點一下就看到」）。
        給 box → 取代該物件在此幀的舊提示；只給 points → 累加到舊提示上（加選／減選逐點修）。"""
        ...

    def propagate_frames(self, frames: Iterable[tuple[int, np.ndarray]], direction: Direction) -> Iterator[FrameMasks]:
        """沿方向逐幀傳播；每餵一幀 yield 一個 FrameMasks（所有物件）。"""
        ...

    def propagate(self, frames: Iterable[tuple[int, np.ndarray]], direction: Direction) -> Iterator[tuple[int, int, np.ndarray]]:
        """`propagate_frames` 的攤平版：yield (k, obj_id, mask_bool)。"""
        ...

    def close(self) -> None: ...


class SegBackend(Protocol):
    name: str

    def open_session(self, frame_size: tuple[int, int]) -> SegSession: ...

    def unload(self) -> None:
        """釋放重模型（VRAM）。"""
        ...
