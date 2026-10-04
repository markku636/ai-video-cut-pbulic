"""把裁切路徑套到 yuv420 幀（reframe/apply.py）。

最重要的一條是 `test_逐位元等於來源那一塊`：自動重構圖不該讓畫質變差，
它只是決定留下哪一塊。這條一紅就代表某處偷偷做了重取樣。
"""

from __future__ import annotations

import numpy as np
import pytest

from aivc.media.source import Yuv420
from aivc.reframe.apply import crop_frame, crop_frames, resize_frame
from aivc.reframe.path import CropRect, ReframeError


def _frame(w: int = 64, h: int = 48) -> Yuv420:
    rng = np.random.default_rng(7)
    return Yuv420(
        y=rng.integers(16, 235, (h, w), dtype=np.uint8),
        u=rng.integers(16, 240, (h // 2, w // 2), dtype=np.uint8),
        v=rng.integers(16, 240, (h // 2, w // 2), dtype=np.uint8),
        src_idx=3, pts_ms=100.0, key=True, matrix="bt709", color_range="tv", transfer="bt709", meta={"a": 1},
    )


class TestCropFrame:
    def test_逐位元等於來源那一塊(self) -> None:
        fr = _frame()
        r = CropRect(x=8, y=4, w=24, h=32)
        out = crop_frame(fr, r)
        assert (out.width, out.height) == (24, 32)
        assert np.array_equal(out.y, fr.y[4:36, 8:32])
        # 色度是半解析度：對應的切片是亮度的一半
        assert np.array_equal(out.u, fr.u[2:18, 4:16])
        assert np.array_equal(out.v, fr.v[2:18, 4:16])

    def test_保留色彩與時間中繼資料(self) -> None:
        out = crop_frame(_frame(), CropRect(x=2, y=2, w=20, h=20))
        assert (out.matrix, out.color_range, out.transfer) == ("bt709", "tv", "bt709")
        assert out.src_idx == 3 and out.pts_ms == 100.0 and out.key is True and out.meta == {"a": 1}

    def test_三個平面都連續(self) -> None:
        # encoder 逐平面 tobytes()，非連續的切片會被靜默複製或寫出錯的位元組
        out = crop_frame(_frame(), CropRect(x=8, y=4, w=24, h=32))
        assert out.y.flags["C_CONTIGUOUS"] and out.u.flags["C_CONTIGUOUS"] and out.v.flags["C_CONTIGUOUS"]

    def test_整幀是免複製的直通(self) -> None:
        fr = _frame()
        assert crop_frame(fr, CropRect(x=0, y=0, w=64, h=48)) is fr

    def test_奇數座標要擋下來(self) -> None:
        # 從奇數位置切色度等於要求「半個色度樣本」，只能重取樣生出來 → 平移時顏色會抖
        for bad in [CropRect(1, 0, 20, 20), CropRect(0, 1, 20, 20), CropRect(0, 0, 21, 20), CropRect(0, 0, 20, 21)]:
            with pytest.raises(ReframeError):
                crop_frame(_frame(), bad)

    def test_超出幀外要擋下來(self) -> None:
        for bad in [CropRect(-2, 0, 20, 20), CropRect(60, 0, 20, 20), CropRect(0, 40, 20, 20)]:
            with pytest.raises(ReframeError):
                crop_frame(_frame(), bad)


class TestResizeFrame:
    def test_尺寸與色度比例(self) -> None:
        out = resize_frame(_frame(), (32, 24))
        assert (out.width, out.height) == (32, 24)
        assert out.u.shape == (12, 16) and out.v.shape == (12, 16)

    def test_同尺寸是直通(self) -> None:
        fr = _frame()
        assert resize_frame(fr, (64, 48)) is fr

    def test_奇數尺寸要擋下來(self) -> None:
        for bad in [(31, 24), (32, 23), (0, 24)]:
            with pytest.raises(ReframeError):
                resize_frame(_frame(), bad)


class TestCropFrames:
    def test_逐幀對應各自的矩形(self) -> None:
        frames = [_frame() for _ in range(3)]
        rects = [CropRect(0, 0, 20, 20), CropRect(4, 4, 20, 20), CropRect(8, 8, 20, 20)]
        outs = list(crop_frames(frames, rects))
        assert [(o.width, o.height) for o in outs] == [(20, 20)] * 3
        assert np.array_equal(outs[1].y, frames[1].y[4:24, 4:24])

    def test_幀比矩形多時沿用最後一個(self) -> None:
        # 渲染範圍與規劃範圍差一兩幀是常見的（取消、trim、VFR 換算），不值得為此丟掉整支成品
        outs = list(crop_frames([_frame() for _ in range(5)], [CropRect(0, 0, 20, 20)]))
        assert len(outs) == 5 and all((o.width, o.height) == (20, 20) for o in outs)

    def test_沒有矩形就原樣放行(self) -> None:
        frames = [_frame() for _ in range(2)]
        assert list(crop_frames(frames, [])) == frames

    def test_順便縮到指定尺寸(self) -> None:
        outs = list(crop_frames([_frame()], [CropRect(0, 0, 24, 32)], resize_to=(48, 64)))
        assert (outs[0].width, outs[0].height) == (48, 64)
