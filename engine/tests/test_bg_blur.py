"""背景虛化的純函式（bg/blur.py）。

核心那條是 **光暈**：直覺寫法（整張模糊再貼回主體）會在主體邊緣留下主體顏色的殘影，
而那是這個功能唯一看得出好壞的地方。`test_不會把主體的顏色帶進背景` 就是在守它，
而且它是**對照**測試 —— 同一張圖用天真寫法會失敗，用 normalized convolution 會過。
"""

from __future__ import annotations

import numpy as np
import pytest

from aivc.bg.blur import (
    DEFAULT_STRENGTH_PCT,
    MEASURED_TOO_STRONG_PCT,
    MEASURED_TOO_WEAK_PCT,
    MIN_RADIUS_PX,
    BgError,
    blur_radius_px,
    blurred_background,
    normalized_blur,
    solid_background,
    subject_coverage,
)


class TestBlurRadius:
    def test_跟著畫面寬度走(self) -> None:
        # 同一個像素半徑在 720p 與 4K 上是完全不同的視覺強度，所以對外是百分比
        assert blur_radius_px(1000, 1.5) == 15
        assert blur_radius_px(4000, 1.5) == 60

    def test_有下限(self) -> None:
        # 再小的核等於沒做，但還是要重編碼一次 —— 不如夾上去
        assert blur_radius_px(100, 0.1) == MIN_RADIUS_PX

    def test_不合理的輸入會講話(self) -> None:
        with pytest.raises(BgError):
            blur_radius_px(0, 1.5)
        with pytest.raises(BgError):
            blur_radius_px(1000, 0)
        with pytest.raises(BgError):
            blur_radius_px(1000, -1)


class TestNormalizedBlur:
    def _scene(self) -> tuple[np.ndarray, np.ndarray]:
        """左半邊是純藍背景、右半邊是純紅主體（權重 0）。"""
        img = np.zeros((40, 40, 3), np.float32)
        img[:, :20] = (0, 0, 255)  # 背景：藍
        img[:, 20:] = (255, 0, 0)  # 主體：紅
        w = np.zeros((40, 40), np.float32)
        w[:, :20] = 1.0
        return img, w

    def test_不會把主體的顏色帶進背景(self) -> None:
        img, w = self._scene()
        out = normalized_blur(img, w, radius=5)
        # 緊貼邊界的背景像素（x=19）：紅色分量必須是 0
        assert out[20, 19, 0] == pytest.approx(0.0, abs=1e-3), out[20, 19]
        # 對照：天真寫法（整張高斯）在同一個位置會明顯滲入紅色
        import cv2

        naive = cv2.GaussianBlur(img, (11, 11), 0)
        assert naive[20, 19, 0] > 50, "天真寫法本來就該滲色；沒滲代表這個對照沒有意義"

    def test_權重全滿時等同一般模糊(self) -> None:
        rng = np.random.default_rng(3)
        img = rng.random((30, 30, 3), np.float32) * 255
        ones = np.ones((30, 30), np.float32)
        import cv2

        assert np.allclose(normalized_blur(img, ones, 4), cv2.GaussianBlur(img, (9, 9), 0), atol=1e-2)

    def test_權重為零的地方回原值不做除法(self) -> None:
        # 主體正中央附近分母是 0；那些像素等一下會被主體蓋掉，填什麼都看不到，但不可以是 NaN
        img = np.full((40, 40, 3), 128.0, np.float32)
        w = np.zeros((40, 40), np.float32)
        out = normalized_blur(img, w, radius=3)
        assert np.isfinite(out).all()
        assert np.allclose(out, img)

    def test_輸出全都是有限值(self) -> None:
        img, w = self._scene()
        assert np.isfinite(normalized_blur(img, w, 9)).all()

    def test_權重可以是_HW1(self) -> None:
        img, w = self._scene()
        a = normalized_blur(img, w, 3)
        b = normalized_blur(img, w[..., None], 3)
        assert np.allclose(a, b)

    def test_尺寸對不上會講話(self) -> None:
        img, _ = self._scene()
        with pytest.raises(BgError):
            normalized_blur(img, np.ones((10, 10), np.float32), 3)
        with pytest.raises(BgError):
            normalized_blur(img[:, :, 0], np.ones((40, 40), np.float32), 3)


class TestBlurredBackground:
    def test_主體_alpha_越高越不參與模糊(self) -> None:
        img = np.zeros((40, 40, 3), np.float32)
        img[:, :20] = (0, 0, 255)
        img[:, 20:] = (255, 0, 0)
        alpha = np.zeros((40, 40), np.float32)
        alpha[:, 20:] = 1.0  # 右半是主體
        out = blurred_background(img, alpha, radius=5)
        assert out[20, 19, 0] == pytest.approx(0.0, abs=1e-3)

    def test_沒有主體時就是整張模糊(self) -> None:
        rng = np.random.default_rng(5)
        img = rng.random((24, 24, 3), np.float32) * 255
        out = blurred_background(img, np.zeros((24, 24), np.float32), 3)
        import cv2

        assert np.allclose(out, cv2.GaussianBlur(img, (7, 7), 0), atol=1e-2)


class TestSolidBackground:
    def test_整片同一個顏色且形狀不變(self) -> None:
        img = np.zeros((8, 6, 3), np.float32)
        out = solid_background(img, (0.1, 0.2, 0.3))
        assert out.shape == img.shape
        assert np.allclose(out[0, 0], (0.1, 0.2, 0.3))
        assert np.allclose(out[-1, -1], (0.1, 0.2, 0.3))

    def test_回的是可寫的副本(self) -> None:
        # broadcast_to 出來的是唯讀 view；呼叫端會就地改，不 copy 會爆
        out = solid_background(np.zeros((4, 4, 3), np.float32), (1, 1, 1))
        out[0, 0] = 0  # 不該丟例外

    def test_顏色分量數不對會講話(self) -> None:
        with pytest.raises(BgError):
            solid_background(np.zeros((4, 4, 3), np.float32), (1, 1))  # type: ignore[arg-type]


class TestSubjectCoverage:
    def test_半張是主體就是一半(self) -> None:
        a = np.zeros((10, 10), np.float32)
        a[:, :5] = 1.0
        assert subject_coverage(a) == pytest.approx(0.5)

    def test_羽化區算部分(self) -> None:
        assert subject_coverage(np.full((10, 10), 0.25, np.float32)) == pytest.approx(0.25)

    def test_HW1_也吃(self) -> None:
        assert subject_coverage(np.ones((4, 4, 1), np.float32)) == pytest.approx(1.0)


class TestDefaultIsMeasured:
    """預設強度不是憑感覺填的：實測見 blur.py 的常數說明。"""

    def test_落在實測的可用區間裡(self) -> None:
        assert MEASURED_TOO_WEAK_PCT < DEFAULT_STRENGTH_PCT < MEASURED_TOO_STRONG_PCT

    def test_在曲線壓平之後(self) -> None:
        # 0.5% 還看得見洋裝的點點（4.6% 細節）；預設至少要是它的兩倍強
        assert DEFAULT_STRENGTH_PCT >= MEASURED_TOO_WEAK_PCT * 2

    def test_不要為了更糊而更慢(self) -> None:
        # 2% 之後每加一倍半徑只再拿掉 0.07 個百分點的細節，成本卻一路漲
        assert DEFAULT_STRENGTH_PCT <= 2.0
