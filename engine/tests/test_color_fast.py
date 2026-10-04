"""color.yuv420_to_rgb8_fast／Yuv420.rgb8 快速路徑：必須與 numpy 參考路徑逐位元相同。

參考（oracle）＝ rgb_gamma_to_rgb8(yuv_to_rgb_gamma(..., chroma_loc="center"))，也就是改版前 Yuv420.rgb8 的算法。
隨機幀涵蓋奇數尺寸、bt601/bt709 × tv/pc、單執行緒與多條切分；cv2 升級後 SIMD 路徑若改變了浮點結果，這裡會先紅。
有實拍樣片（D:/test-files/sample_rgb8.mp4，或 AIVC_TEST_RGB8_CLIP 指定）時再比對 209 幀的 md5。
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

import numpy as np
import pytest

from aivc.media import color
from aivc.media.source import Yuv420

SIZES = [(7, 5), (1, 1), (2, 2), (1, 9), (9, 1), (3, 4), (481, 853), (720, 1260)]
FIXTURE_MD5 = Path(__file__).parent / "fixtures" / "color" / "sample_rgb8_md5.json"
CLIP = Path(os.environ.get("AIVC_TEST_RGB8_CLIP") or "D:/test-files/sample_rgb8.mp4")


def _oracle(y: np.ndarray, u: np.ndarray, v: np.ndarray, matrix: str, full_range: bool) -> np.ndarray:
    return color.rgb_gamma_to_rgb8(color.yuv_to_rgb_gamma(y, u, v, matrix=matrix, full_range=full_range, chroma_loc="center"))


def _planes(rng: np.random.Generator, h: int, w: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    c = ((h + 1) // 2, (w + 1) // 2)
    return rng.integers(0, 256, (h, w), dtype=np.uint8), rng.integers(0, 256, c, dtype=np.uint8), rng.integers(0, 256, c, dtype=np.uint8)


@pytest.mark.parametrize("h,w", SIZES)
@pytest.mark.parametrize("matrix", ["bt709", "bt601"])
@pytest.mark.parametrize("full_range", [False, True])
def test_fast_rgb8_bit_exact_on_random_frames(h: int, w: int, matrix: str, full_range: bool) -> None:
    rng = np.random.default_rng(h * 10007 + w * 31 + (matrix == "bt601") * 2 + full_range)
    y, u, v = _planes(rng, h, w)
    ref = _oracle(y, u, v, matrix, full_range)
    for threads in (None, 1, 3, 8):
        got = color.yuv420_to_rgb8_fast(y, u, v, matrix=matrix, full_range=full_range, threads=threads)
        assert got.dtype == np.uint8 and got.shape == (h, w, 3)
        assert np.array_equal(got, ref), (h, w, matrix, full_range, threads, int(np.abs(got.astype(int) - ref).max()))


def test_fast_rgb8_extreme_planes_exact() -> None:
    """全 0／全 255／棋盤（色度插值落在 1/16 的倍數、RGB 大量超界被裁）也要逐位元相同。"""
    h, w = 64, 90
    yy, xx = np.mgrid[0:h, 0:w]
    cy, cx = np.mgrid[0 : (h + 1) // 2, 0 : (w + 1) // 2]
    checker = ((yy + xx) % 2 * 255).astype(np.uint8)
    cchecker = ((cy + cx) % 2 * 255).astype(np.uint8)
    for y, u, v in [
        (np.zeros((h, w), np.uint8), np.zeros((h // 2, w // 2), np.uint8), np.full((h // 2, w // 2), 255, np.uint8)),
        (np.full((h, w), 255, np.uint8), np.full((h // 2, w // 2), 255, np.uint8), np.zeros((h // 2, w // 2), np.uint8)),
        (checker, cchecker, 255 - cchecker),
    ]:
        for matrix in ("bt709", "bt601"):
            for full_range in (False, True):
                assert np.array_equal(color.yuv420_to_rgb8_fast(y, u, v, matrix=matrix, full_range=full_range, threads=4), _oracle(y, u, v, matrix, full_range))


def test_thread_count_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(color.RGB8_THREADS_ENV, "1")
    assert color.rgb8_threads() == 1
    monkeypatch.setenv(color.RGB8_THREADS_ENV, "3")
    assert color.rgb8_threads() == 3
    monkeypatch.setenv(color.RGB8_THREADS_ENV, "abc")
    assert 1 <= color.rgb8_threads() <= 8
    monkeypatch.delenv(color.RGB8_THREADS_ENV)
    assert 1 <= color.rgb8_threads() <= 8
    rng = np.random.default_rng(3)
    y, u, v = _planes(rng, 720, 1280)
    ref = _oracle(y, u, v, "bt709", False)
    for n in ("1", "2", "16"):
        monkeypatch.setenv(color.RGB8_THREADS_ENV, n)
        assert np.array_equal(color.yuv420_to_rgb8_fast(y, u, v), ref), n


def test_non_uint8_input_uses_reference_path() -> None:
    rng = np.random.default_rng(5)
    y, u, v = _planes(rng, 10, 12)
    y16 = y.astype(np.uint16)
    assert np.array_equal(color.yuv420_to_rgb8_fast(y16, u, v), _oracle(y16, u, v, "bt709", False))
    with pytest.raises(ValueError):
        color.yuv420_to_rgb8_fast(y, u, v, matrix="bt2020")


def test_yuv420_rgb8_uses_fast_path_for_center_only(monkeypatch: pytest.MonkeyPatch) -> None:
    rng = np.random.default_rng(11)
    y, u, v = _planes(rng, 33, 47)
    fr = Yuv420(y, u, v, matrix="bt601", color_range="pc")
    ref_center = _oracle(y, u, v, "bt601", True)
    ref_left = color.rgb_gamma_to_rgb8(color.yuv_to_rgb_gamma(y, u, v, matrix="bt601", full_range=True, chroma_loc="left"))
    calls: list[dict] = []
    real = color.yuv420_to_rgb8_fast

    def spy(*a, **kw):  # noqa: ANN002, ANN003, ANN202
        calls.append(kw)
        return real(*a, **kw)

    monkeypatch.setattr(color, "yuv420_to_rgb8_fast", spy)
    assert np.array_equal(fr.rgb8(), ref_center)
    assert calls == [{"matrix": "bt601", "full_range": True}]
    assert np.array_equal(fr.rgb8("left"), ref_left)
    assert len(calls) == 1, "left 色度走 numpy 參考路徑"


def test_real_clip_frames_match_reference_md5(tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch) -> None:
    """實拍 VD 樣片（1280×720 bt709 tv，209 幀）：快速路徑＝參考路徑，且 md5 與改版前記錄的清單相同。"""
    if not CLIP.is_file():
        pytest.skip(f"沒有樣片 {CLIP}（設 AIVC_TEST_RGB8_CLIP 指定）")
    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path_factory.mktemp("cache")))
    from aivc.media.index import NoopCtx
    from aivc.media.source import FrameSource
    from aivc.ops import media as M

    ctx = NoopCtx()
    mc, pr = M.open_media(str(CLIP), ctx)
    idx, cfr, _ = M.ensure_index(str(CLIP), mc, pr, ctx)
    want = json.loads(FIXTURE_MD5.read_text(encoding="utf-8"))
    got: dict[str, str] = {}
    with FrameSource(str(CLIP), idx, cfr, probe=pr, lru=4, ctx=ctx) as fs:
        for k in range(cfr.n_frames):
            fr = fs.get_proxy_frame(k)
            fast = fr.rgb8()
            if k % 20 == 0:  # 參考路徑一幀 26 ms：抽樣比對即可，md5 清單涵蓋全部
                assert np.array_equal(fast, color.rgb_gamma_to_rgb8(fr.rgb_gamma("center"))), k
            got[str(k)] = hashlib.md5(fast.tobytes()).hexdigest()
    assert got == want
