"""描框 / 描邊的純函式（bg/outline.py）。

最要緊的一條是 `test_描邊的線整條在物件外面`：`cv2.drawContours` 的線寬往兩側長，
不先外擴的話線會有一半壓進物件裡把細節吃掉。那是「看起來像不像商業軟體做的」的分水嶺，
而且只有量得出來，看不太出來。
"""

from __future__ import annotations

import numpy as np
import pytest

from aivc.bg.outline import (
    DEFAULT_WIDTH_PCT,
    MIN_WIDTH_PX,
    OutlineError,
    bounding_box,
    composite_stroke,
    grow,
    line_width_px,
    smooth_mask,
    stroke_alpha,
)


def disc(h: int = 80, w: int = 80, r: int = 20) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w]
    return ((yy - h // 2) ** 2 + (xx - w // 2) ** 2) < r * r


class TestLineWidth:
    def test_跟著畫面寬度走(self) -> None:
        # 同一個像素寬度在 720p 與 4K 上粗細差很多（同虛化強度的理由）
        assert line_width_px(1000, 0.5) == 5
        assert line_width_px(4000, 0.5) == 20

    def test_有下限(self) -> None:
        assert line_width_px(100, 0.01) == MIN_WIDTH_PX

    def test_不合理的輸入會講話(self) -> None:
        for args in ((0, 1.0), (1000, 0.0), (1000, -1.0)):
            with pytest.raises(OutlineError):
                line_width_px(*args)


class TestBoundingBox:
    def test_半開區間(self) -> None:
        m = np.zeros((50, 50), bool)
        m[10:20, 5:15] = True
        assert bounding_box(m) == (5, 10, 15, 20)

    def test_空遮罩回_None(self) -> None:
        assert bounding_box(np.zeros((10, 10), bool)) is None


class TestSmoothMask:
    def test_磨掉鋸齒但形狀還在(self) -> None:
        m = disc()
        s = smooth_mask(m, 2)
        # 面積變化不該超過一成（磨邊不是縮放）
        assert abs(int(s.sum()) - int(m.sum())) / m.sum() < 0.1

    def test_半徑_0_就原樣回(self) -> None:
        m = disc()
        assert np.array_equal(smooth_mask(m, 0), m)

    def test_單點雜訊會被磨掉(self) -> None:
        m = np.zeros((40, 40), bool)
        m[20, 20] = True
        assert not smooth_mask(m, 2).any()


class TestStrokeAlpha:
    def test_形狀與型別(self) -> None:
        a = stroke_alpha(disc(), "contour", 4)
        assert a.shape == (80, 80, 1) and a.dtype == np.float32
        assert a.min() >= 0 and a.max() <= 1

    def test_空遮罩全是_0_那一幀沒東西可標(self) -> None:
        a = stroke_alpha(np.zeros((40, 40), bool), "contour", 4)
        assert not a.any()

    def test_描邊的線整條在物件外面(self) -> None:
        # 線寬往兩側長：不先外擴的話會有一半壓進物件，把細節吃掉
        m = disc(r=20)
        a = stroke_alpha(m, "contour", 8, smooth=0)[..., 0] > 0
        inside = int((a & m).sum())
        total = int(a.sum())
        assert total > 0
        assert inside / total < 0.12, f"有 {inside}/{total} 的線壓在物件裡"

    def test_對照_不外擴的話會壓進去(self) -> None:
        # 這條是上面那條的對照組：證明外擴不是多餘的
        import cv2

        m = disc(r=20)
        naive = np.zeros(m.shape, np.uint8)
        cnts, _ = cv2.findContours(m.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        cv2.drawContours(naive, cnts, -1, 255, 8)
        a = naive > 0
        assert int((a & m).sum()) / int(a.sum()) > 0.3, "天真寫法本來就該壓進物件；沒壓代表對照沒意義"

    def test_方框是空心的(self) -> None:
        m = np.zeros((60, 60), bool)
        m[20:40, 20:40] = True
        a = stroke_alpha(m, "box", 2, smooth=0)[..., 0] > 0
        assert a[20, 20] and not a[30, 30], "方框中心不該被填滿"

    def test_填色會蓋住整個物件(self) -> None:
        m = disc()
        a = stroke_alpha(m, "fill", 4, smooth=0)[..., 0] > 0
        assert a[40, 40], "圓心該被填到"
        assert int((a & ~m).sum()) == 0, "填色不該溢出物件"

    def test_線寬至少_1(self) -> None:
        assert stroke_alpha(disc(), "contour", 0).any()


class TestGrow:
    def test_往外長(self) -> None:
        m = disc(r=10)
        assert int(grow(m, 3).sum()) > int(m.sum())

    def test_0_不動(self) -> None:
        m = disc()
        assert np.array_equal(grow(m, 0), m)


class TestCompositeStroke:
    def test_alpha_1_完全換成那個顏色(self) -> None:
        base = np.zeros((4, 4, 3), np.float32)
        out = composite_stroke(base, (1.0, 0.0, 0.0), np.ones((4, 4, 1), np.float32))
        assert np.allclose(out[0, 0], (1.0, 0.0, 0.0))

    def test_alpha_0_完全不動(self) -> None:
        base = np.full((4, 4, 3), 0.5, np.float32)
        out = composite_stroke(base, (1.0, 0.0, 0.0), np.zeros((4, 4, 1), np.float32))
        assert np.allclose(out, base)

    def test_半透明是線性混色(self) -> None:
        base = np.zeros((2, 2, 3), np.float32)
        out = composite_stroke(base, (1.0, 1.0, 1.0), np.full((2, 2, 1), 0.25, np.float32))
        assert np.allclose(out[0, 0], (0.25, 0.25, 0.25))

    def test_alpha_可以是_HW(self) -> None:
        base = np.zeros((4, 4, 3), np.float32)
        out = composite_stroke(base, (1.0, 0.0, 0.0), np.ones((4, 4), np.float32))
        assert np.allclose(out[0, 0], (1.0, 0.0, 0.0))

    def test_尺寸或顏色不對會講話(self) -> None:
        base = np.zeros((4, 4, 3), np.float32)
        with pytest.raises(OutlineError):
            composite_stroke(base, (1.0, 0.0), np.ones((4, 4, 1), np.float32))  # type: ignore[arg-type]
        with pytest.raises(OutlineError):
            composite_stroke(base, (1.0, 0.0, 0.0), np.ones((8, 8, 1), np.float32))


class TestDefaults:
    def test_線寬預設在合理範圍(self) -> None:
        # 1260 寬的 proxy 上約 4 px：看得見，但不會粗到蓋掉東西
        assert 3 <= line_width_px(1260, DEFAULT_WIDTH_PCT) <= 6
