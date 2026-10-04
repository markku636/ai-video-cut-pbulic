"""seg.rle：RLE 往返（隨機 + 牌形）、面積、IoU。CPU、不需範例影片。"""
from __future__ import annotations

import numpy as np
import pytest

from aivc.seg import rle


def _card(h: int, w: int, cx: float, cy: float, cw: float, ch: float, deg: float) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w]
    a = np.deg2rad(deg)
    dx, dy = xx + 0.5 - cx, yy + 0.5 - cy
    u = dx * np.cos(a) + dy * np.sin(a)
    v = -dx * np.sin(a) + dy * np.cos(a)
    return (np.abs(u) <= cw / 2) & (np.abs(v) <= ch / 2)


@pytest.mark.parametrize("seed", [0, 1, 2])
@pytest.mark.parametrize("shape", [(1, 1), (7, 5), (48, 64), (720, 1280)])
def test_roundtrip_random(seed: int, shape: tuple[int, int]) -> None:
    rng = np.random.default_rng(seed)
    m = rng.random(shape) < 0.3
    counts = rle.encode(m)
    assert isinstance(counts, bytes) and len(counts) > 0
    back = rle.decode(counts, *shape)
    assert back.dtype == bool and back.shape == shape
    np.testing.assert_array_equal(back, m)
    assert rle.rle_area(counts, *shape) == rle.area(m)


def test_roundtrip_card_shapes() -> None:
    h, w = 720, 1280
    for deg in (0, 12, 90, -30):
        m = _card(h, w, 300, 450, 120, 80, deg)
        counts = rle.encode(m)
        np.testing.assert_array_equal(rle.decode(counts, h, w), m)
        # 牌遮罩壓得很小：一張 120×80 的牌不到 1 KB
        assert len(counts) < 1024


def test_empty_and_full() -> None:
    h, w = 10, 12
    empty = np.zeros((h, w), bool)
    full = np.ones((h, w), bool)
    for m in (empty, full):
        counts = rle.encode(m)
        np.testing.assert_array_equal(rle.decode(counts, h, w), m)
    assert rle.rle_area(rle.encode(empty), h, w) == 0
    assert rle.rle_area(rle.encode(full), h, w) == h * w


def test_encode_accepts_uint8_and_nonfortran() -> None:
    m = np.zeros((6, 9), np.uint8)
    m[1:4, 2:7] = 1
    c1 = rle.encode(m)
    c2 = rle.encode(np.ascontiguousarray(m.astype(bool)))
    assert c1 == c2
    np.testing.assert_array_equal(rle.decode(c1, 6, 9), m.astype(bool))


def test_decode_rejects_bad_size() -> None:
    m = np.zeros((6, 9), bool)
    m[2, 3] = True
    counts = rle.encode(m)
    with pytest.raises(ValueError):
        rle.decode(counts, 0, 9)
    with pytest.raises(ValueError):
        rle.decode(counts, 6, -1)


def test_encode_rejects_non_2d() -> None:
    with pytest.raises(ValueError):
        rle.encode(np.zeros((2, 3, 4), bool))


def test_iou() -> None:
    a = np.zeros((10, 10), bool)
    b = np.zeros((10, 10), bool)
    a[0:5, :] = True
    b[2:7, :] = True
    assert rle.iou(a, b) == pytest.approx(30 / 70)
    assert rle.iou(a, a) == 1.0
    assert rle.iou(np.zeros((3, 3), bool), np.zeros((3, 3), bool)) == 1.0
    assert rle.iou(a, np.zeros((10, 10), bool)) == 0.0
    with pytest.raises(ValueError):
        rle.iou(a, np.zeros((3, 3), bool))
