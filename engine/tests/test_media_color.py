"""色彩：tv range 端點、灰階單調、隨機幀往返、色度反元素、轉移函數；慢測試對 ffmpeg 同幀 rgb24。"""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pytest

from aivc import env
from aivc.media import color


def _grey(y_val: int, h: int = 8, w: int = 8) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    return (
        np.full((h, w), y_val, np.uint8),
        np.full((h // 2, w // 2), 128, np.uint8),
        np.full((h // 2, w // 2), 128, np.uint8),
    )


def test_tv_range_endpoints() -> None:
    for matrix in ("bt709", "bt601"):
        y, u, v = _grey(16)
        assert np.all(color.rgb_gamma_to_rgb8(color.yuv_to_rgb_gamma(y, u, v, matrix=matrix)) == 0)
        assert np.all(color.rgb_linear_to_rgb8(color.yuv420_to_rgb_linear(y, u, v, matrix=matrix)) == 0)
        y, u, v = _grey(235)
        assert np.all(color.rgb_gamma_to_rgb8(color.yuv_to_rgb_gamma(y, u, v, matrix=matrix)) == 255)
        assert np.all(color.rgb_linear_to_rgb8(color.yuv420_to_rgb_linear(y, u, v, matrix=matrix)) == 255)
    # pc range：0 → 0、255 → 255
    y, u, v = _grey(0)
    assert np.all(color.rgb_gamma_to_rgb8(color.yuv_to_rgb_gamma(y, u, v, full_range=True)) == 0)
    y, u, v = _grey(255)
    assert np.all(color.rgb_gamma_to_rgb8(color.yuv_to_rgb_gamma(y, u, v, full_range=True)) == 255)


def test_grey_ramp_monotonic_and_neutral() -> None:
    y = np.tile(np.arange(16, 236, dtype=np.uint8), (2, 1))  # 2×220
    u = np.full((1, 110), 128, np.uint8)
    v = np.full((1, 110), 128, np.uint8)
    rgb8 = color.rgb_gamma_to_rgb8(color.yuv_to_rgb_gamma(y, u, v))
    row = rgb8[0]
    assert np.all(row[:, 0] == row[:, 1]) and np.all(row[:, 1] == row[:, 2])  # 灰就是灰
    assert np.all(np.diff(row[:, 0].astype(int)) >= 0)
    assert row[0, 0] == 0 and row[-1, 0] == 255
    lin = color.yuv420_to_rgb_linear(y, u, v)[0, :, 0]
    assert np.all(np.diff(lin) > 0)  # 線性域嚴格遞增（無 knee 造成的倒退）


@pytest.mark.parametrize("matrix,loc", [("bt709", "center"), ("bt601", "center"), ("bt709", "left")])
def test_roundtrip_random_frames_within_one_level(matrix: str, loc: str) -> None:
    """yuv → 線性 RGB → yuv：合法範圍內的隨機幀必須逐位元回來（|err| ≤ 1/255 是硬門檻，實際為 0）。"""
    rng = np.random.default_rng(1234)
    for _ in range(3):
        y = rng.integers(16, 236, (48, 64), dtype=np.uint8)
        u = rng.integers(16, 241, (24, 32), dtype=np.uint8)
        v = rng.integers(16, 241, (24, 32), dtype=np.uint8)
        lin = color.yuv420_to_rgb_linear(y, u, v, matrix=matrix, chroma_loc=loc)
        assert lin.dtype == np.float32 and lin.shape == (48, 64, 3)
        y2, u2, v2 = color.rgb_linear_to_yuv420(lin, matrix=matrix, chroma_loc=loc)
        for a, b in ((y, y2), (u, u2), (v, v2)):
            err = np.abs(a.astype(int) - b.astype(int))
            assert err.max() <= 1
        assert np.array_equal(y, y2) and np.array_equal(u, u2) and np.array_equal(v, v2)


def test_roundtrip_full_0_255_random_clips_only_at_ends() -> None:
    rng = np.random.default_rng(7)
    y = rng.integers(0, 256, (32, 32), dtype=np.uint8)
    u = rng.integers(0, 256, (16, 16), dtype=np.uint8)
    v = rng.integers(0, 256, (16, 16), dtype=np.uint8)
    y2, u2, v2 = color.rgb_linear_to_yuv420(color.yuv420_to_rgb_linear(y, u, v))
    for a, b in ((y, y2), (u, u2), (v, v2)):
        err = np.abs(a.astype(int) - b.astype(int))
        assert err.max() <= 1  # 0 / 255 被裁到 1 / 254
        inside = (a >= 1) & (a <= 254)
        assert err[inside].max() == 0


def test_box_downsample_is_lossy_on_random_but_exact_on_flat() -> None:
    rng = np.random.default_rng(3)
    u = rng.integers(16, 241, (16, 16), dtype=np.uint8)
    up = color.upsample_chroma(u, 32, 32)
    assert np.abs(color.downsample_chroma(up, mode="box") - u).max() > 1  # 平均會把細節抹掉
    flat = np.full((16, 16), 77, np.uint8)
    assert np.allclose(color.downsample_chroma(color.upsample_chroma(flat, 32, 32), mode="box"), 77)
    with pytest.raises(ValueError):
        color.downsample_chroma(up, mode="nearest")


@pytest.mark.parametrize("loc", ["center", "left"])
def test_inverse_downsample_is_exact_left_inverse(loc: str) -> None:
    rng = np.random.default_rng(11)
    c = rng.uniform(0, 255, (30, 40)).astype(np.float32)
    up = color.upsample_chroma(c, 60, 80, chroma_loc=loc)
    back = color.downsample_chroma(up, chroma_loc=loc, mode="inverse")
    assert np.abs(back - c).max() < 1e-3


def test_bilinear_center_and_left_weights() -> None:
    c = np.array([[0.0, 100.0]], dtype=np.float32)
    center = color.upsample_chroma(c, 2, 4, "center")
    assert np.allclose(center[0], [0, 25, 75, 100])  # 邊界 clamp：0.75·0+0.25·0=0；中央 0.25/0.75 混合
    assert np.allclose(center[0], center[1])  # 垂直方向兩列同值（單列來源 clamp）
    left = color.upsample_chroma(c, 2, 4, "left")
    assert np.allclose(left[0], [0, 50, 100, 100])  # 偶數位對齊來源、奇數位是中點
    with pytest.raises(ValueError):
        color.upsample_chroma(c, 2, 4, "topleft")


def test_odd_dimensions_do_not_crash() -> None:
    rng = np.random.default_rng(5)
    y = rng.integers(16, 236, (33, 47), dtype=np.uint8)
    u = rng.integers(16, 241, (17, 24), dtype=np.uint8)
    v = rng.integers(16, 241, (17, 24), dtype=np.uint8)
    lin = color.yuv420_to_rgb_linear(y, u, v)
    assert lin.shape == (33, 47, 3)
    y2, u2, v2 = color.rgb_linear_to_yuv420(lin)
    assert y2.shape == (33, 47) and u2.shape == (17, 24) and v2.shape == (17, 24)
    assert np.array_equal(y, y2)


def test_transfer_functions_roundtrip_monotonic_and_known_values() -> None:
    x = np.linspace(-0.5, 2.0, 2001, dtype=np.float32)
    for t in ("bt709", "srgb"):
        back = color.eotf(color.oetf(x, t), t)
        assert np.abs(back - x).max() < 2e-5
        assert np.all(np.diff(color.oetf(x, t)) > 0)
        assert color.oetf(np.float32(0.0), t) == 0 and abs(float(color.oetf(np.float32(1.0), t)) - 1.0) < 1e-6
    assert abs(float(color.oetf(np.float32(0.5), "bt709")) - 0.7055) < 2e-3  # 1.0993·0.5^0.45 − 0.0993
    assert abs(float(color.eotf(np.float32(0.5), "srgb")) - 0.2140) < 1e-3
    assert float(color.eotf(np.float32(-0.2), "bt709")) < 0  # 奇函數延伸
    with pytest.raises(ValueError):
        color.eotf(x, "gamma22")
    with pytest.raises(ValueError):
        color.yuv_to_rgb_gamma(*_grey(100), matrix="bt2020")


def test_psnr_helper() -> None:
    a = np.zeros((4, 4), np.uint8)
    assert color.psnr(a, a) == float("inf")
    b = a.copy()
    b[0, 0] = 16  # mse = 256/16 = 16 → 10·log10(65025/16) ≈ 36.09
    assert abs(color.psnr(a, b) - 36.09) < 0.01


# ---------------------------------------------------------------- 慢：對 ffmpeg 同一幀
@pytest.mark.slow
def test_matches_ffmpeg_rgb24_on_sample_frame(sample_video: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")
    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    from aivc.media import ffmpeg as ff
    from aivc.media.source import FrameSource

    n = 40  # 第 41 個解碼幀（近景、有牌）
    with FrameSource(sample_video) as fs:
        fr = fs.get(n)
        ours_center = fr.rgb8("center").astype(int)
        ours_left = fr.rgb8("left").astype(int)
    h, w = fr.height, fr.width
    raw = ff.extract_frame_rgb24(
        os.fspath(sample_video), n,
        "scale=in_range=tv:out_range=pc:in_color_matrix=bt709:flags=bicubic+accurate_rnd+full_chroma_int,format=rgb24",
    )
    ref = np.frombuffer(raw, np.uint8).reshape(h, w, 3).astype(int)
    d_center = np.abs(ours_center - ref)
    d_left = np.abs(ours_left - ref)
    print(
        f"\nffmpeg vs ours: center mean={d_center.mean():.3f} p99={np.percentile(d_center, 99):.1f} max={d_center.max()} | "
        f"left mean={d_left.mean():.3f} p99={np.percentile(d_left, 99):.1f} max={d_left.max()}"
    )
    assert d_center.mean() < 1.0  # 計畫 §11 color 量尺：同幀均差 < 1
    assert np.percentile(d_center, 99) <= 6  # 差異只該在色度邊緣（不同上採樣核心）
