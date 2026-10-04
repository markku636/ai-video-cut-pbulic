"""移除物件的背景板重建（inpaint/plate.py）。

最重要的兩條：
- `test_遮罩漏邊時中位數不受影響`：平均會被物件顏色拉走，中位數不會。
  「遮罩比物件緊一點」是實務上最常見的失誤，容錯就是選中位數的全部理由。
- `test_逐列帶與一次算完結果相同`：分帶是為了記憶體，不可以改變結果。
"""

from __future__ import annotations

import numpy as np
import pytest

from aivc.inpaint.plate import (
    InpaintError,
    blend,
    even_roi,
    camera_shift,
    composite,
    coverage,
    feather,
    fill_uncovered,
    median_plate,
    sample_counts,
    sample_indices,
    shadow_mask,
)

H, W = 40, 60


def _scene(n: int = 9) -> tuple[np.ndarray, np.ndarray]:
    """靜止的灰背景 + 一個橫向移動的白方塊；遮罩剛好框住方塊。"""
    frames = np.full((n, H, W, 3), 80, np.uint8)
    masks = np.zeros((n, H, W), bool)
    for i in range(n):
        x = 2 + i * 6
        frames[i, 10:30, x : x + 6] = 255
        masks[i, 10:30, x : x + 6] = True
    return frames, masks


class TestSampleIndices:
    def test_等距含頭尾(self) -> None:
        assert sample_indices(0, 100, 5) == [0, 25, 50, 74, 99]

    def test_範圍比取樣數短就全取(self) -> None:
        assert sample_indices(10, 13, 8) == [10, 11, 12]

    def test_只取一個(self) -> None:
        assert sample_indices(10, 100, 1) == [10]

    def test_不合法(self) -> None:
        with pytest.raises(InpaintError):
            sample_indices(5, 5, 4)
        with pytest.raises(InpaintError):
            sample_indices(0, 10, 0)


class TestMedianPlate:
    def test_移動的物件被整個補掉(self) -> None:
        frames, masks = _scene()
        plate, cov = median_plate(frames, masks)
        assert cov.all(), "每個像素都該在某一幀露出過背景"
        assert (plate == 80).all(), "背景板應該是乾淨的灰底"

    def test_遮罩漏邊時中位數不受影響(self) -> None:
        # 遮罩每邊縮 1 px：物件的邊緣像素會混進取樣。平均會被拉高，中位數不會。
        frames, masks = _scene()
        tight = masks.copy()
        for i in range(tight.shape[0]):
            ys, xs = np.where(masks[i])
            tight[i] = False
            tight[i, ys.min() + 1 : ys.max(), xs.min() + 1 : xs.max()] = True
        plate, _ = median_plate(frames, tight)
        assert (plate == 80).all(), "中位數該擋掉漏進來的物件邊緣"
        naive = frames.astype(np.float32).copy()
        naive[tight] = np.nan
        assert np.nanmean(naive, axis=0).max() > 90, "這個情境下平均確實會被拉走（對照組）"

    def test_整段都被蓋住的像素標成沒補到(self) -> None:
        frames = np.full((4, H, W, 3), 80, np.uint8)
        masks = np.zeros((4, H, W), bool)
        masks[:, 5:9, 5:9] = True  # 從頭到尾都在這裡（貼死的台標）
        plate, cov = median_plate(frames, masks)
        assert not cov[5:9, 5:9].any()
        assert cov[20:, 20:].all()
        assert (plate[5:9, 5:9] == 0).all(), "沒補到的地方留 0，由呼叫端決定怎麼處理"

    def test_逐列帶與一次算完結果相同(self) -> None:
        frames, masks = _scene()
        a, ca = median_plate(frames, masks, strip_rows=H)
        b, cb = median_plate(frames, masks, strip_rows=7)
        assert np.array_equal(a, b) and np.array_equal(ca, cb)

    def test_形狀不對就擲錯(self) -> None:
        frames, masks = _scene()
        with pytest.raises(InpaintError):
            median_plate(frames[:, :, :, :2], masks)
        with pytest.raises(InpaintError):
            median_plate(frames, masks[:, :10])
        with pytest.raises(InpaintError):
            median_plate(frames[:0], masks[:0])


class TestSampleCounts:
    def test_數的是沒被蓋住的取樣(self) -> None:
        masks = np.zeros((5, 4, 4), bool)
        masks[:3, 0, 0] = True
        c = sample_counts(masks)
        assert c[0, 0] == 2 and c[1, 1] == 5

    def test_樣本太少的像素不算可信(self) -> None:
        # 只有一兩個樣本的中位數其實就是「相信那一幀」：那一幀沒遮乾淨，整個像素就錯
        frames = np.full((6, H, W, 3), 80, np.uint8)
        masks = np.zeros((6, H, W), bool)
        masks[:5, 3, 3] = True  # 這個像素只剩 1 個可用樣本
        _, cov_loose = median_plate(frames, masks, min_samples=1)
        _, cov_strict = median_plate(frames, masks, min_samples=3)
        assert cov_loose[3, 3] and not cov_strict[3, 3]
        assert cov_strict[10, 10], "樣本夠的像素不受影響"


class TestFillUncovered:
    def test_沒有洞就原樣回(self) -> None:
        plate = np.full((H, W, 3), 80, np.uint8)
        out = fill_uncovered(plate, np.ones((H, W), bool))
        assert out is plate

    def test_洞會被填掉(self) -> None:
        plate = np.full((H, W, 3), 80, np.uint8)
        plate[10:14, 10:14] = 0
        cov = np.ones((H, W), bool)
        cov[10:14, 10:14] = False
        out = fill_uncovered(plate, cov)
        assert out[10:14, 10:14].min() > 40, "補繪該拉近周圍的顏色，不是留黑"


class TestFeather:
    def test_先膨脹再模糊(self) -> None:
        # SAM 的遮罩常比物件緊一兩個 px；只模糊不膨脹會在物件外緣留一圈原始像素（看起來像描邊）
        m = np.zeros((H, W), bool)
        m[15:25, 20:30] = True
        a = feather(m, dilate=3, blur=0)
        assert a.shape == (H, W, 1)
        assert a[15:25, 20:30].min() == 1.0
        assert a[12, 20] == 1.0, "膨脹後外面三格也要全不透明"
        assert a[5, 5] == 0.0

    def test_模糊讓邊緣變成漸層(self) -> None:
        m = np.zeros((H, W), bool)
        m[15:25, 20:30] = True
        a = feather(m, dilate=0, blur=4)[..., 0]
        edge = a[20, 30:36]
        assert 0 < edge[0] < 1 and np.all(np.diff(edge) <= 1e-6), "外緣要單調遞減到 0"

    def test_都不做就是硬邊(self) -> None:
        m = np.zeros((H, W), bool)
        m[15:25, 20:30] = True
        a = feather(m, dilate=0, blur=0)[..., 0]
        assert set(np.unique(a)) == {0.0, 1.0}


class TestComposite:
    def test_alpha_一與零(self) -> None:
        f = np.full((H, W, 3), 10, np.uint8)
        p = np.full((H, W, 3), 200, np.uint8)
        assert (composite(f, p, np.ones((H, W, 1), np.float32)) == 200).all()
        assert (composite(f, p, np.zeros((H, W, 1), np.float32)) == 10).all()

    def test_半透明取中間(self) -> None:
        f = np.full((H, W, 3), 0, np.uint8)
        p = np.full((H, W, 3), 100, np.uint8)
        assert (composite(f, p, np.full((H, W, 1), 0.5, np.float32)) == 50).all()

    def test_尺寸不同就擲錯(self) -> None:
        with pytest.raises(InpaintError):
            composite(np.zeros((H, W, 3), np.uint8), np.zeros((H, W + 1, 3), np.uint8), np.zeros((H, W, 1), np.float32))


class TestShadowMask:
    """影子不在 SAM 的遮罩裡。只換掉物件、留著影子，等於把輪廓描出來（實測像一隻綠手套）。"""

    def _setup(self):  # noqa: ANN202
        plate = np.full((20, 20, 3), 100, np.uint8)
        frame = plate.copy()
        frame[5:9, 5:9] = 60  # 影子
        frame[12:16, 12:16] = 200  # 牌（比背景亮）
        near = np.zeros((20, 20), bool)
        near[3:18, 3:18] = True
        return frame, plate, near

    def test_抓得到比背景暗的影子(self) -> None:
        frame, plate, near = self._setup()
        assert shadow_mask(frame, plate, near)[5:9, 5:9].all()

    def test_不吃比背景亮的東西(self) -> None:
        # 膨脹一大圈會連牌一起吃掉；比值天然分得開
        frame, plate, near = self._setup()
        assert not shadow_mask(frame, plate, near)[12:16, 12:16].any()

    def test_只在_near_範圍內(self) -> None:
        # 影子一定貼著物件；不限範圍的話整片較暗的背景都會被當成影子
        frame, plate, near = self._setup()
        frame[18:20, 18:20] = 50
        assert not shadow_mask(frame, plate, near)[18:20, 18:20].any()

    def test_門檻(self) -> None:
        plate = np.full((4, 4, 3), 100, np.uint8)
        near = np.ones((4, 4), bool)
        assert not shadow_mask(np.full((4, 4, 3), 90, np.uint8), plate, near, 0.85).any()
        assert shadow_mask(np.full((4, 4, 3), 80, np.uint8), plate, near, 0.85).all()

    def test_背景全黑的地方沒有影子可言(self) -> None:
        # 信箱黑邊：兩邊都是 0，不該被當成影子（比較寫成乘法，0 < 0 自然是 False）
        z = np.zeros((4, 4, 3), np.uint8)
        assert not shadow_mask(z, z, np.ones((4, 4), bool)).any()


class TestBlend:
    def test_dtype_不拘且回_float32(self) -> None:
        # 合成器那條路在線性 float 裡混、預覽那條路用 uint8，兩條共用同一行
        lin = np.full((4, 4, 3), 0.2, np.float32)
        out = blend(lin, np.full((4, 4, 3), 0.8, np.float32), np.full((4, 4, 1), 0.25, np.float32))
        assert out.dtype == np.float32
        assert out == pytest.approx(0.35)


class TestEvenRoi:
    def test_起點終點都取偶數(self) -> None:
        # yuv420 的色度是 2×2 一格；從奇數位置寫回等於寫半個色度樣本
        m = np.zeros((40, 60), bool)
        m[11:23, 7:19] = True
        assert even_roi(m, 60, 40) == (6, 10, 20, 24)

    def test_剛好偶數時不會多長一格以外(self) -> None:
        m = np.zeros((40, 60), bool)
        m[10:20, 10:20] = True
        assert even_roi(m, 60, 40) == (10, 10, 20, 20)

    def test_貼到畫面邊緣時夾住(self) -> None:
        m = np.zeros((40, 60), bool)
        m[38:40, 58:60] = True
        assert even_roi(m, 60, 40) == (58, 38, 60, 40)

    def test_奇數尺寸畫面的右下緣(self) -> None:
        m = np.zeros((41, 61), bool)
        m[40, 60] = True
        assert even_roi(m, 61, 41) == (60, 40, 61, 41)

    def test_空遮罩回_none(self) -> None:
        assert even_roi(np.zeros((10, 10), bool), 10, 10) is None


class TestCameraShift:
    def test_沒動是零(self) -> None:
        rng = np.random.default_rng(3)
        a = rng.integers(0, 255, (H, W, 3), dtype=np.uint8)
        assert camera_shift(a, a) < 0.5

    def test_平移量測得出來(self) -> None:
        rng = np.random.default_rng(3)
        a = rng.integers(0, 255, (128, 128, 3), dtype=np.uint8)
        b = np.roll(a, 6, axis=1)
        assert camera_shift(a, b) > 4


class TestCoverage:
    def test_整張(self) -> None:
        cov = np.zeros((10, 10), bool)
        cov[:5] = True
        assert coverage(cov) == pytest.approx(0.5)

    def test_只算要換掉的那塊(self) -> None:
        # 只有遮罩裡面的覆蓋率有意義：畫面其他地方本來就不會被動到
        cov = np.zeros((10, 10), bool)
        cov[:5] = True
        region = np.zeros((10, 10), bool)
        region[:2] = True
        assert coverage(cov, region) == 1.0

    def test_空區域算全覆蓋(self) -> None:
        assert coverage(np.zeros((4, 4), bool), np.zeros((4, 4), bool)) == 1.0
