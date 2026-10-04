"""鏡頭切換偵測（reframe/scene.py）：能分開「換鏡頭」與「同一鏡頭內的劇烈動作／亮度變化」。

最重要的兩條是**不要誤報**：淡入淡出與自動曝光會讓整片灰階位移，動作會讓局部大變，
兩者都不是換鏡頭。誤報一次的後果是鏡頭在那裡硬切一下，比漏報還刺眼。
"""

from __future__ import annotations

import numpy as np

from aivc.reframe.scene import (
    DEFAULT_THRESHOLD,
    MEASURED_CUT_MIN,
    MEASURED_NON_CUT_MAX,
    MIN_GAP,
    SIG_H,
    SIG_W,
    frame_signature,
    scene_cuts,
    signature_distance,
)


def _scene(seed: int, h: int = 180, w: int = 320) -> np.ndarray:
    """一個「畫面」：低頻的隨機圖樣（縮圖之後仍然有結構，不會變成一片灰）。"""
    rng = np.random.default_rng(seed)
    small = rng.integers(20, 235, (9, 16, 3), dtype=np.uint8)
    import cv2

    return cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)


class TestSignature:
    def test_尺寸與型別(self) -> None:
        s = frame_signature(_scene(1))
        assert s.shape == (SIG_H, SIG_W)
        assert s.dtype == np.float32

    def test_灰階圖也吃(self) -> None:
        import cv2

        g = cv2.cvtColor(_scene(1), cv2.COLOR_RGB2GRAY)
        assert frame_signature(g).shape == (SIG_H, SIG_W)

    def test_整體變亮不影響簽章(self) -> None:
        # 除以自己的平均就是為了這件事：自動曝光、淡入淡出不是換鏡頭
        a = _scene(2)
        brighter = np.clip(a.astype(np.int16) + 40, 0, 255).astype(np.uint8)
        assert signature_distance(frame_signature(a), frame_signature(brighter)) < 0.05

    def test_全黑不會除以零(self) -> None:
        z = np.zeros((90, 160, 3), np.uint8)
        assert np.isfinite(frame_signature(z)).all()


class TestSceneCuts:
    """行為測試一律**傳明確的門檻**。

    合成出來的「畫面」跟真素材的量級不一樣（實測真切換 0.61，這裡的合成場景只有 0.2），
    用預設門檻去測等於在測「我的假資料像不像真的」而不是在測邏輯。
    門檻本身由 `TestThresholdIsMeasured` 拿實測值守。
    """

    #: 合成場景之間的距離約 0.2，取一半當行為測試的門檻
    T = 0.1

    def _sigs(self, frames: list[np.ndarray], k0: int = 0) -> list[tuple[int, np.ndarray]]:
        return [(k0 + i, frame_signature(f)) for i, f in enumerate(frames)]

    def test_換鏡頭抓得到(self) -> None:
        a, b = _scene(3), _scene(9)
        frames = [a] * 10 + [b] * 10
        assert scene_cuts(self._sigs(frames), threshold=self.T) == [10]

    def test_第一幀永遠不是切點(self) -> None:
        # 沒有可以比的前一幀，而且「開場」不是切換
        assert scene_cuts(self._sigs([_scene(3)] * 5), threshold=self.T) == []

    def test_同一鏡頭內的動作不誤報(self) -> None:
        # 畫面中央有東西快速移動：局部變很多，但整體構圖沒換
        base = _scene(4)
        frames = []
        for i in range(12):
            f = base.copy()
            f[60:120, 20 + i * 20 : 80 + i * 20] = 250
            frames.append(f)
        assert scene_cuts(self._sigs(frames), threshold=self.T) == []

    def test_淡入不誤報(self) -> None:
        base = _scene(5)
        frames = [np.clip(base.astype(np.float32) * (0.15 + 0.85 * i / 11), 0, 255).astype(np.uint8) for i in range(12)]
        assert scene_cuts(self._sigs(frames), threshold=self.T) == []

    def test_一次切換只報一個切點(self) -> None:
        # 切換之後的幾幀本來就不太像前一幀（動態模糊、壓縮）；全報會變成一串假切點
        a, b = _scene(6), _scene(11)
        noisy = [np.clip(b.astype(np.int16) + np.random.default_rng(i).integers(-30, 30, b.shape), 0, 255).astype(np.uint8) for i in range(4)]
        frames = [a] * 6 + [b] + noisy
        cuts = scene_cuts(self._sigs(frames), threshold=self.T)
        assert cuts == [6], cuts

    def test_min_gap_可以關掉(self) -> None:
        a, b, c = _scene(6), _scene(11), _scene(17)
        frames = [a, b, c]
        assert scene_cuts(self._sigs(frames), threshold=self.T, min_gap=1) == [1, 2]

    def test_幀號照傳進來的算(self) -> None:
        a, b = _scene(3), _scene(9)
        assert scene_cuts(self._sigs([a] * 4 + [b] * 4, k0=700), threshold=self.T) == [704]

    def test_門檻拉高就不報(self) -> None:
        a, b = _scene(3), _scene(9)
        assert scene_cuts(self._sigs([a] * 4 + [b] * 4), threshold=9.0) == []

    def test_空輸入(self) -> None:
        assert scene_cuts([]) == []


class TestThresholdIsMeasured:
    """門檻不是憑感覺填的 —— 這兩個邊界值是量出來的（見 scene.py 的常數說明）。

    實測 參考片段 `samples/sample_clip1.webm`（1797 幀、三個已知鏡頭邊界）：
    真邊界 0.613 / 0.614 / 0.646，非邊界最大 0.257。任何一次調門檻都要重新量，
    而不是改這裡的數字讓測試變綠。
    """

    def test_門檻落在實測的安全區間裡(self) -> None:
        assert MEASURED_NON_CUT_MAX < DEFAULT_THRESHOLD < MEASURED_CUT_MIN

    def test_兩邊都留了餘裕(self) -> None:
        # 只差一點點的門檻換一支素材就翻車
        assert DEFAULT_THRESHOLD / MEASURED_NON_CUT_MAX > 1.2
        assert MEASURED_CUT_MIN / DEFAULT_THRESHOLD > 1.5

    def test_偏向漏報而不是誤報(self) -> None:
        # 漏一個切點只是維持平滑平移；誤報一個會讓畫面莫名硬跳一下
        mid = (MEASURED_NON_CUT_MAX + MEASURED_CUT_MIN) / 2
        assert DEFAULT_THRESHOLD >= mid * 0.75

    def test_常數本身合理(self) -> None:
        assert 0 < DEFAULT_THRESHOLD < 1
        assert MIN_GAP >= 2
