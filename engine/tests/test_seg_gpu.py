"""@gpu：SAM 2.1 串流煙霧測試（計畫 E0 0.3 / §11 `test_sam2_smoke`）。

AIVC_RUN_GPU_TESTS=1 才跑；需要範例影片與（首次）網路下載權重。
量測數字用 `-s` 印出來；門檻刻意寬鬆（這是煙霧測試，不是量尺）。
"""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import pytest

from aivc.seg import _frames, rle
from aivc.seg.backend import LABEL_ADD, LABEL_REDUCE

pytestmark = pytest.mark.gpu

ANCHOR = 1101  # 37.9 s：6 個平面全在、靜止、人物雙手交握

# 錨定幀 6 張牌的框（x, y, w, h；來源像素）。由白色四邊形偵測得到，橫放的第 1/6 張與鄰牌相連被合併，依鄰牌邊界手動切開。
BOXES: list[tuple[float, float, float, float]] = [
    (63, 408, 166, 82),  # 9♣（橫放）
    (230, 408, 139, 82),  # 8♥
    (370, 410, 135, 82),  # 6♠
    (717, 413, 133, 81),  # Q♦
    (853, 414, 137, 81),  # J♠
    (992, 415, 160, 80),  # Q♣（橫放）
]


@pytest.fixture(scope="module")
def backend():
    from aivc.seg.sam2_hf import Sam2HfBackend

    b = Sam2HfBackend(variant="small")
    yield b
    b.unload()


def test_sam2_smoke_forward(sample_video: Path, backend) -> None:
    import torch

    video = str(sample_video)
    index = _frames.scan(video)
    anchor_rgb = _frames.read_frame(video, ANCHOR, index)
    boxes = BOXES

    t0 = time.perf_counter()
    loaded = backend.loaded()
    load_s = time.perf_counter() - t0
    torch.cuda.reset_peak_memory_stats()

    session = backend.open_session((index.width, index.height))
    try:
        for i, b in enumerate(boxes, start=1):
            m = session.add_prompt(ANCHOR, i, anchor_rgb, box=b)
            area = rle.area(m)
            assert 0.5 * b[2] * b[3] <= area <= 1.5 * b[2] * b[3], f"物件 {i} 錨定遮罩面積 {area} 與框 {b} 差太多"

        n = 30
        results = list(session.propagate_frames(_frames.iter_frames(video, ANCHOR + 1, ANCHOR + 1 + n, index), "fwd"))
    finally:
        stats = session.stats
        session.close()

    assert [r.k for r in results] == list(range(ANCHOR + 1, ANCHOR + 1 + n))
    ok = 0
    for r in results:
        assert set(r.masks) == set(range(1, 7))
        for i, b in enumerate(boxes, start=1):
            m = r.masks[i]
            assert m.shape == (index.height, index.width) and m.dtype == bool
            if 0.5 * b[2] * b[3] <= rle.area(m) <= 1.5 * b[2] * b[3]:
                ok += 1
    # 1101..1131 牌靜止、無遮擋：幾乎每幀每張牌都該追到
    assert ok >= 0.9 * n * 6, f"只有 {ok}/{n * 6} 個 (幀, 牌) 面積合理"

    mem_mb = torch.cuda.max_memory_allocated() / 2**20
    print(
        f"\n[sam2 smoke] model={loaded.model_id} load={load_s:.2f}s (cached={loaded.load_seconds:.2f}s) "
        f"prompt={stats.prompt_seconds / max(stats.prompt_frames, 1):.3f}s/obj "
        f"propagate={stats.s_per_frame:.4f}s/frame ({n} frames × 6 obj) max_mem={mem_mb:.0f}MB "
        f"gpu_preprocess={loaded.preprocess_on_device}"
    )
    assert stats.s_per_frame < 0.3, "E0 閘門 (b)：>0.3 s/幀要改 hiera-tiny 預設"


def test_sam2_backward_and_points(sample_video: Path, backend) -> None:
    """反向傳播旗標 + 加選／減選點：同一 session 先 fwd 再 bwd，遮罩存在且面積合理。

    實測：牌**正中央**一點會選到 ~10×8 px 的條碼灰塊（≈0.05× 框面積）而不是整張牌；
    再在紙面上補一個加選點（累加、不清舊點）就變成整張牌。UI 的「點一下」流程必須能這樣逐點修。
    """
    video = str(sample_video)
    index = _frames.scan(video)
    anchor_rgb = _frames.read_frame(video, ANCHOR, index)
    b = BOXES[1]  # 8♥
    cx, cy = b[0] + b[2] / 2, b[1] + b[3] / 2
    box_area = b[2] * b[3]
    session = backend.open_session((index.width, index.height))
    try:
        m_centre = session.add_prompt(ANCHOR, 1, anchor_rgb, points=[(cx, cy, LABEL_ADD)])
        assert 0 < rle.area(m_centre) < 0.2 * box_area, "中央一點預期只選到條碼塊"
        m0 = session.add_prompt(ANCHOR, 1, anchor_rgb, points=[(cx - 0.3 * b[2], cy, LABEL_ADD)])  # 累加：紙面加選
        assert 0.7 * box_area <= rle.area(m0) <= 1.1 * box_area, "補一點紙面加選後應是整張牌"
        # 減選：點在牌外的桌布上不該改變什麼（遮罩仍在牌上）
        m1 = session.add_prompt(ANCHOR, 1, anchor_rgb, points=[(cx, b[1] + b[3] + 40, LABEL_REDUCE)])
        assert rle.iou(m0, m1) > 0.8
        fwd = list(session.propagate_frames(_frames.iter_frames(video, ANCHOR + 1, ANCHOR + 6, index), "fwd"))
        bwd = list(session.propagate_frames(_frames.iter_frames_reversed(video, ANCHOR - 5, ANCHOR, index), "bwd"))
        with pytest.raises(ValueError):
            list(session.propagate_frames(_frames.iter_frames(video, ANCHOR + 1, ANCHOR + 3, index), "bwd"))  # 方向錯
    finally:
        session.close()
    assert [r.k for r in fwd] == list(range(ANCHOR + 1, ANCHOR + 6))
    assert [r.k for r in bwd] == list(range(ANCHOR - 1, ANCHOR - 6, -1))
    for r in fwd + bwd:
        assert 0.5 * b[2] * b[3] <= rle.area(r.masks[1]) <= 1.5 * b[2] * b[3]
