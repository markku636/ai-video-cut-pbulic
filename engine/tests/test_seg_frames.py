"""seg._frames：封包索引、seek 到關鍵幀後的幀號正確性、倒序解碎。需要範例影片（沒有就 skip）。"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from aivc.seg import _frames


@pytest.fixture(scope="module")
def index(sample_video: Path) -> _frames.PacketIndex:
    return _frames.scan(str(sample_video))


def test_scan_matches_measured_facts(index: _frames.PacketIndex) -> None:
    assert index.n == 1762
    assert (index.width, index.height) == (1280, 720)
    assert index.keyframes[:3] == (0, 101, 202) and len(index.keyframes) == 18
    assert index.pts[:3] == (2, 36, 1236)  # 1.2 s 斷層在第 2 幀後
    assert index.nearest(30.9) == 891 and index.nearest(45.3) == 1323
    assert index.keyframe_at_or_before(891) == 808 and index.keyframe_at_or_before(0) == 0


def test_seeked_frames_have_expected_pts(sample_video: Path, index: _frames.PacketIndex) -> None:
    """seek 到 808 的關鍵幀後往前解到 891：每幀 pts 必須等於索引裡的 pts（幀號沒有偏移）。"""
    got = [(k, f.pts) for k, f in _frames.iter_video_frames(str(sample_video), 891, 896, index)]
    assert [k for k, _ in got] == [891, 892, 893, 894, 895]
    assert [p for _, p in got] == [index.pts[k] for k in range(891, 896)]


def test_from_start_and_seeked_decode_agree(sample_video: Path, index: _frames.PacketIndex) -> None:
    """跨關鍵幀邊界（100..103）：seek 路徑與從頭解的像素完全一致。"""
    seeked = {k: rgb for k, rgb in _frames.iter_frames(str(sample_video), 100, 104, index)}
    from_start = {k: rgb for k, rgb in _frames.iter_frames(str(sample_video), 0, 104, index) if k >= 100}
    assert sorted(seeked) == [100, 101, 102, 103]
    for k in seeked:
        np.testing.assert_array_equal(seeked[k], from_start[k])
        assert seeked[k].shape == (720, 1280, 3) and seeked[k].dtype == np.uint8


def test_reversed_iteration(sample_video: Path, index: _frames.PacketIndex) -> None:
    fwd = {k: rgb for k, rgb in _frames.iter_frames(str(sample_video), 895, 905, index)}
    rev = list(_frames.iter_frames_reversed(str(sample_video), 895, 905, index, chunk=4))
    assert [k for k, _ in rev] == list(range(904, 894, -1))
    for k, rgb in rev:
        np.testing.assert_array_equal(rgb, fwd[k])


def test_range_clamps_and_empty(sample_video: Path, index: _frames.PacketIndex) -> None:
    assert [k for k, _ in _frames.iter_video_frames(str(sample_video), 1760, 1800, index)] == [1760, 1761]
    assert list(_frames.iter_frames(str(sample_video), 50, 50, index)) == []
    with pytest.raises(IndexError):
        _frames.read_frame(str(sample_video), 5000, index)
