"""審查第二輪（色彩／ROI）回歸測試。每一個在舊程式碼上都會失敗：

- 奇數尺寸幀（853×481，VP9／H.264 合法）：牌貼到右緣／下緣時 even_roi 裁成奇數邊 → 舊版 yuv420_to_linear 擲 ValueError，
  整支 render 中斷；色度平面是 ceil(W/2)×ceil(H/2)，舊版 floor 索引還會掉最後一欄色度。
- write_back 對差值 0 的像素也夾 16..235：full range 的 248 變 235、alpha=0 外圈的 8 變 16。
- 合成器寫死 BT.709 tv：BT.601／full range 來源的新牌面顏色錯；編碼計畫一律標 `-color_range tv`。
"""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures" / "comp"))
import synth  # noqa: E402

from aivc import env  # noqa: E402
from aivc.comp import _color  # noqa: E402
from aivc.comp.compositor import composite_frame, rectify_frame  # noqa: E402
from aivc.media import color as media_color  # noqa: E402
from aivc.media import encode_plan as EP  # noqa: E402

OW, OH = 853, 481


def _odd_scene(quad: list[list[float]], noise_sigma: float = 0.004) -> tuple[synth.Scene, _color.Yuv420]:
    """先渲染 854×482（synth 走偶數），再把亮度裁成 853×481、色度保留 427×241（= ceil），就是解碼器給的奇數幀。"""
    sc = synth.render_scene(np.array(quad, dtype=np.float64), frame_wh=(OW + 1, OH + 1), noise_sigma=noise_sigma)
    p = _color.Yuv420(np.ascontiguousarray(sc.planes.y[:OH, :OW]), sc.planes.u.copy(), sc.planes.v.copy())
    assert p.u.shape == ((OH + 1) // 2, (OW + 1) // 2)
    return sc, p


def _run(sc: synth.Scene, planes, params=None, **kw):  # noqa: ANN001
    return composite_frame(
        planes, sc.H, kw.pop("alpha_vis", None), sc.tmpl_orig, sc.tmpl_new,
        sc.ink_orig, sc.ink_new, sc.paper, params=params, barcode_mask=sc.barcode, **kw,
    )


def _own_write_mask(r) -> np.ndarray:  # noqa: ANN001
    # 測試自己算 dilate(alpha>0, 1px)，不信任 result 給的遮罩
    return cv2.dilate((r.alpha_full() > 0).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0


# ---------------------------------------------------------------------------
# 奇數尺寸
# ---------------------------------------------------------------------------
ODD_QUADS = {
    "right": [[760.0, 200.0], [850.0, 196.0], [858.0, 300.0], [752.0, 304.0]],
    "bottom": [[400.0, 380.0], [500.0, 376.0], [506.0, 486.0], [396.0, 484.0]],
    "corner": [[760.0, 380.0], [853.5, 376.0], [860.0, 490.0], [752.0, 488.0]],
}


@pytest.mark.parametrize("where", sorted(ODD_QUADS))
def test_odd_size_card_at_edge_composites_and_outside_is_byte_identical(where: str) -> None:
    sc, p = _odd_scene(ODD_QUADS[where])
    r = _run(sc, p, frame_index=2)
    assert not r.stats.hold, r.stats.hold_reason
    x0, y0, x1, y1 = r.roi
    assert x0 % 2 == 0 and y0 % 2 == 0
    if where in ("right", "corner"):
        assert x1 == OW  # ROI 真的貼到奇數右緣
    if where in ("bottom", "corner"):
        assert y1 == OH  # ROI 真的貼到奇數下緣
    out: _color.Yuv420 = r.out  # type: ignore[assignment]
    assert out.y.shape == p.y.shape and out.u.shape == p.u.shape and out.v.shape == p.v.shape
    own = _own_write_mask(r)
    assert np.array_equal(own, r.write_mask_full())
    assert np.array_equal(out.y[~own], p.y[~own])
    cm = _color.chroma_write_mask(own)
    assert cm.shape == p.u.shape
    assert np.array_equal(out.u[~cm], p.u[~cm])
    assert np.array_equal(out.v[~cm], p.v[~cm])
    assert int((out.y != p.y).sum()) > 500  # 裡面真的有合成
    if where in ("right", "corner"):
        assert own[:, OW - 1].any()  # 奇數邊那一欄在寫回遮罩裡（不是只擦過邊）
    if where in ("bottom", "corner"):
        assert own[OH - 1, :].any()


def test_odd_size_roi_matches_full_and_last_chroma_column_maps_with_ceil() -> None:
    y = np.full((OH, OW), 128, np.uint8)
    u = np.full(((OH + 1) // 2, (OW + 1) // 2), 128, np.uint8)
    v = u.copy()
    u[:, -1] = 200  # 只有最後一欄色度（只蓋到亮度第 852 欄）偏藍
    v[-1, :] = 60  # 只有最後一列色度（只蓋到亮度第 480 列）偏綠
    p = _color.Yuv420(y, u, v)
    full = _color.yuv420_to_linear(p)
    assert full.shape == (OH, OW, 3)
    for roi in ((840, 470, OW, OH), (0, 470, 20, OH), (840, 0, OW, 12), (100, 100, 200, 200)):
        x0, y0, x1, y1 = roi
        assert np.array_equal(_color.yuv420_to_linear(p, roi), full[y0:y1, x0:x1]), roi
    yn = np.float32((128 - 16) / 219)
    blue = _color.ycbcr_to_linear(yn, np.float32((200 - 128) / 224), np.float32(0.0))
    neutral = _color.ycbcr_to_linear(yn, np.float32(0.0), np.float32(0.0))
    assert np.allclose(full[10, OW - 1], blue, atol=1e-6)  # ceil 對應：亮度 852 → 色度 426
    assert np.allclose(full[10, OW - 2], neutral, atol=1e-6)  # 亮度 850/851 → 色度 425
    green = _color.ycbcr_to_linear(yn, np.float32(0.0), np.float32((60 - 128) / 224))
    assert np.allclose(full[OH - 1, 10], green, atol=1e-6)
    assert np.allclose(full[OH - 2, 10], neutral, atol=1e-6)
    # 起點奇數、或終點奇數但不是畫面邊緣，仍然要擋
    for bad in ((1, 0, 10, 10), (0, 0, 11, 10), (0, 0, 10, 479)):
        with pytest.raises(ValueError):
            _color.yuv420_to_linear(p, bad)
    assert _color.even_roi(800.2, 300.0, 900.0, 470.5, OW, OH) == (800, 300, OW, 472)


def test_odd_size_write_back_exact_at_corner() -> None:
    _, p = _odd_scene(ODD_QUADS["corner"], noise_sigma=0.0)
    roi = (840, 470, OW, OH)
    orig = _color.yuv420_to_linear(p, roi)
    # identity：整個 ROI 都在遮罩裡也一個位元都不動
    same = _color.write_back(p, roi, orig, orig, np.ones(orig.shape[:2], bool))
    assert all(np.array_equal(a, b) for a, b in zip(same[:3], p[:3]))
    # 只改右下角那一個像素（色度區塊只有它一個亮度像素在畫面內）→ 只有 Y[480,852] 與 U/V[240,426] 會變，而且差值不被 4 格平均稀釋
    out = orig.copy()
    red = _color.oetf_inverse(np.array([0.8, 0.1, 0.1], np.float32))
    out[-1, -1] = red
    mask = np.zeros(orig.shape[:2], bool)
    mask[-1, -1] = True
    wb = _color.write_back(p, roi, out, orig, mask)
    ym = np.zeros(p.y.shape, bool)
    ym[OH - 1, OW - 1] = True
    cmask = np.zeros(p.u.shape, bool)
    cmask[-1, -1] = True
    assert np.array_equal(wb.y[~ym], p.y[~ym])
    assert np.array_equal(wb.u[~cmask], p.u[~cmask]) and np.array_equal(wb.v[~cmask], p.v[~cmask])
    got = _color.oetf(_color.yuv420_to_linear(wb, roi)[-1, -1])
    assert np.abs(got - np.array([0.8, 0.1, 0.1], np.float32)).max() * 255 <= 2.0


def test_linear_to_yuv420_odd_size_planes() -> None:
    lin = np.full((OH, OW, 3), 0.25, np.float32)
    p = _color.linear_to_yuv420(lin)
    assert p.y.shape == (OH, OW) and p.u.shape == (241, 427) and p.v.shape == (241, 427)
    assert np.abs(_color.yuv420_to_linear(p) - 0.25).max() < 0.01


def test_rectify_frame_odd_size() -> None:
    sc, p = _odd_scene(ODD_QUADS["corner"])
    face = rectify_frame(p, sc.H, (synth.TMPL_W, synth.TMPL_H), (synth.TMPL_W // 2, synth.TMPL_H // 2))
    assert face.shape == (synth.TMPL_H // 2, synth.TMPL_W // 2, 3) and np.isfinite(face).all()


# ---------------------------------------------------------------------------
# write_back：差值 0 的像素不夾範圍
# ---------------------------------------------------------------------------
def _ring_frame(color_range: str) -> tuple[_color.Yuv420, np.ndarray]:
    """64×48：牌面 Y=248，外圈一圈 Y=8（alpha=0 但在 dilate 遮罩裡的那種像素），其餘 Y=128。"""
    y = np.full((48, 64), 128, np.uint8)
    y[10:38, 12:52] = 8
    y[11:37, 13:51] = 248
    c = np.full((24, 32), 128, np.uint8)
    if color_range == "tv":  # tv 用舊的三平面建構（預設 bt709／tv）：舊程式碼上失敗的原因就是「夾範圍」本身
        return _color.Yuv420(y, c, c.copy()), (y == 8)
    return _color.Yuv420(y, c, c.copy(), "bt709", color_range), (y == 8)


@pytest.mark.parametrize("color_range", ["pc", "tv"])
def test_write_back_zero_delta_keeps_out_of_range_bytes(color_range: str) -> None:
    p, ring = _ring_frame(color_range)
    roi = (0, 0, 64, 48)
    orig = _color.yuv420_to_linear(p, roi)
    same = _color.write_back(p, roi, orig.copy(), orig, np.ones((48, 64), bool))  # 替換結果＝原圖
    assert int(same.y[11, 13]) == 248 and int(same.y[10, 12]) == 8
    assert np.array_equal(same.y, p.y) and np.array_equal(same.u, p.u) and np.array_equal(same.v, p.v)
    assert same.matrix == "bt709" and same.color_range == color_range


def test_write_back_changed_pixels_still_clamped_to_legal_range() -> None:
    p, _ = _ring_frame("tv")
    roi = (0, 0, 64, 48)
    orig = _color.yuv420_to_linear(p, roi)
    out = orig.copy()
    out[20:30, 20:40] = 4.0  # 超白：原值 248 的像素 → 不低於原值（不被拉回 235）
    out[0:4, 0:8] = 4.0  # 原值 128 的像素 → 夾到 235
    wb = _color.write_back(p, roi, out, orig, np.ones((48, 64), bool))
    assert int(wb.y[0:4, 0:8].max()) == 235
    assert int(wb.y[20:30, 20:40].min()) == 248
    pf, _ = _ring_frame("pc")
    wbf = _color.write_back(pf, roi, out, _color.yuv420_to_linear(pf, roi), np.ones((48, 64), bool))
    assert int(wbf.y[0:4, 0:8].max()) == 255  # full range 上限是 255


@pytest.mark.parametrize("color_range", ["tv", "pc"])
def test_compositor_alpha_zero_ring_pixels_untouched_even_out_of_range(color_range: str) -> None:
    base = synth.render_scene(noise_sigma=0.004)
    planes = base.planes if color_range == "tv" else _color.linear_to_yuv420(base.frame_lin, "bt709", color_range)
    r0 = _run(base, planes, frame_index=1)
    ring = _own_write_mask(r0) & (r0.alpha_full() == 0)
    assert int(ring.sum()) > 50
    y = planes.y.copy()
    ys, xs = np.nonzero(ring)
    y[ys[::2], xs[::2]] = 8  # 雜訊下衝到 sub-black
    y[ys[1::2], xs[1::2]] = 250 if color_range == "tv" else 255  # super-white
    tweaked = planes._replace(y=y)
    r = _run(base, tweaked, frame_index=1)
    assert np.array_equal(r.alpha_full() == 0, r0.alpha_full() == 0)
    out: _color.Yuv420 = r.out  # type: ignore[assignment]
    assert np.array_equal(out.y[ring], tweaked.y[ring])
    own = _own_write_mask(r)
    assert np.array_equal(out.y[~own], tweaked.y[~own])
    assert int((out.y != tweaked.y).sum()) > 2000  # 牌面真的有合成
    assert out.color_range == color_range


# ---------------------------------------------------------------------------
# 矩陣／range
# ---------------------------------------------------------------------------
RED8 = np.array([204, 26, 26], np.uint8)  # 飽和紅 R'G'B' 0.8/0.1/0.1（8-bit 碼值）
RED_GAMMA = RED8.astype(np.float32) / np.float32(255.0)


def _rgb8_err(lin: np.ndarray) -> int:
    """線性 → 8-bit R'G'B' 碼值，與 RED8 的最大差（碼值）。"""
    return int(np.abs(_color.linear_to_rgb8(lin).astype(np.int16) - RED8.astype(np.int16)).max())


@pytest.mark.parametrize("color_range", ["tv", "pc"])
def test_saturated_red_roundtrip_bt601_and_bt709_within_one_code_value(color_range: str) -> None:
    lin = np.broadcast_to(_color.rgb8_to_linear(RED8), (8, 8, 3)).astype(np.float32)
    codes = {}
    for matrix in ("bt601", "bt709"):
        p = _color.linear_to_yuv420(lin, matrix, color_range)
        assert p.matrix == matrix and p.color_range == color_range
        back = _color.yuv420_to_linear(p)  # 矩陣／range 讀平面自己的中繼資料
        assert _rgb8_err(back) <= 1, matrix
        codes[matrix] = (int(p.y[0, 0]), int(p.u[0, 0]), int(p.v[0, 0]))
        # 再編一次碼值不漂移
        again = _color.linear_to_yuv420(back, matrix, color_range)
        assert (int(again.y[0, 0]), int(again.u[0, 0]), int(again.v[0, 0])) == codes[matrix]
        # 與 media/color.py（解碼／預覽那一側）同一組定義：碼值差 ≤ 1
        my, mu, mv = media_color.rgb_gamma_to_yuv(np.broadcast_to(RED_GAMMA, (8, 8, 3)).copy(), matrix=matrix, full_range=color_range == "pc")
        assert abs(int(my[0, 0]) - codes[matrix][0]) <= 1 and abs(int(mu[0, 0]) - codes[matrix][1]) <= 1 and abs(int(mv[0, 0]) - codes[matrix][2]) <= 1
    assert abs(codes["bt601"][0] - codes["bt709"][0]) > 5  # 兩個矩陣真的不同
    p601 = _color.linear_to_yuv420(lin, "bt601", color_range)
    assert _rgb8_err(_color.yuv420_to_linear(p601, matrix="bt709")) > 5  # 舊行為：BT.601 的碼值用 BT.709 解 → 明顯偏色


def test_full_range_levels() -> None:
    c = np.full((1, 1), 128, np.uint8)
    black = _color.Yuv420(np.zeros((2, 2), np.uint8), c, c, "bt709", "pc")
    white = _color.Yuv420(np.full((2, 2), 255, np.uint8), c, c, "bt709", "pc")
    assert np.allclose(_color.yuv420_to_linear(black), 0.0, atol=1e-6)
    assert np.allclose(_color.yuv420_to_linear(white), 1.0, atol=1e-5)
    assert _color.normalize_range("unknown") == "tv" and _color.normalize_range(None) == "tv"
    with pytest.raises(ValueError):
        _color.normalize_range("fulll")
    with pytest.raises(ValueError):
        _color.yuv420_to_linear(black, matrix="bt2020")


def test_rectify_frame_uses_frame_matrix() -> None:
    lin = np.broadcast_to(_color.rgb8_to_linear(RED8), (64, 64, 3)).astype(np.float32)
    p = _color.linear_to_yuv420(lin, "bt601", "pc")
    H = np.array([[1.0, 0.0, 16.0], [0.0, 1.0, 16.0], [0.0, 0.0, 1.0]])
    assert _rgb8_err(rectify_frame(p, H, (32, 32))) <= 1
    assert _rgb8_err(rectify_frame(p._replace(matrix="bt709", color_range="tv"), H, (32, 32))) > 5


def test_compositor_passes_frame_matrix_and_range(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, dict]] = []
    to_lin, wb = _color.yuv420_to_linear, _color.write_back

    def spy_to_lin(*a, **k):  # noqa: ANN002, ANN003
        calls.append(("to_linear", dict(k)))
        return to_lin(*a, **k)

    def spy_wb(*a, **k):  # noqa: ANN002, ANN003
        calls.append(("write_back", dict(k)))
        return wb(*a, **k)

    monkeypatch.setattr(_color, "yuv420_to_linear", spy_to_lin)
    monkeypatch.setattr(_color, "write_back", spy_wb)
    base = synth.render_scene(noise_sigma=0.004)
    planes = _color.linear_to_yuv420(base.frame_lin, "bt601", "pc")
    r = _run(base, planes, frame_index=1)
    assert not r.stats.hold
    assert [c[0] for c in calls] == ["to_linear", "write_back"]
    assert all(c[1] == {"matrix": "bt601", "color_range": "pc"} for c in calls)
    assert r.out.matrix == "bt601" and r.out.color_range == "pc"  # type: ignore[union-attr]
    # 只給三個平面的舊呼叫端：預設 bt709／tv；也可以用參數覆寫
    calls.clear()
    _run(base, _color.Yuv420(planes.y, planes.u, planes.v), frame_index=1)
    assert all(c[1] == {"matrix": "bt709", "color_range": "tv"} for c in calls)
    calls.clear()
    r2 = _run(base, _color.Yuv420(planes.y, planes.u, planes.v), frame_index=1, matrix="bt601", color_range="pc")
    assert all(c[1] == {"matrix": "bt601", "color_range": "pc"} for c in calls)
    assert all(np.array_equal(a, b) for a, b in zip(r2.out[:3], r.out[:3]))  # type: ignore[index]


# ---------------------------------------------------------------------------
# 編碼計畫的 range／矩陣 tag
# ---------------------------------------------------------------------------
FULL = frozenset({"libvpx-vp9", "libopenh264", "prores_ks", "ffv1", "aac", "libopus"})


def _tags(rng: str, space: str) -> list[str]:
    return ["-color_range", rng, "-colorspace", space, "-color_primaries", space, "-color_trc", space]


def test_encode_plan_tags_follow_source_range_and_matrix() -> None:
    cases = [
        (EP.SourceInfo("mp4", 640, 480, 30, 1, False, None, "bt601", "pc"), _tags("pc", "smpte170m")),
        (EP.SourceInfo("mp4", 1920, 1080, 30, 1, False, None, "bt709", "pc"), _tags("pc", "bt709")),
        (EP.SourceInfo("mp4", 720, 480, 30, 1, False, None, "bt601", "tv"), _tags("tv", "smpte170m")),
        (EP.SourceInfo("mp4", 1280, 720, 30, 1, False, None, "bt709"), _tags("tv", "bt709")),  # 沒給 range → tv（舊行為）
    ]
    for src, want in cases:
        p = EP.plan(EP.EncodeSpec(container="mkv", codec="ffv1"), src, FULL)
        assert p.color_args == want, src
        assert not any("full range" in d for d in p.dropped)
    # 輸入端與輸出端都標同一個 range（只標一邊 ffmpeg 會自動插 range 轉換）
    from aivc.media import encoder as EN

    p = EP.plan(EP.EncodeSpec(container="webm"), cases[0][0], FULL)
    args = EN.ffmpeg_args(p, width=640, height=480, fps=(30, 1), out_part="x.webm.part")
    idx = [i for i, a in enumerate(args) if a == "-color_range"]
    assert len(idx) == 2 and all(args[i + 1] == "pc" for i in idx)
    assert idx[0] < args.index("pipe:0") < idx[1]
    # ProRes 沒有 range 旗標 → 記進 dropped
    p = EP.plan(EP.EncodeSpec(container="mov"), cases[0][0], FULL)
    assert p.video_codec == "prores_ks" and any("full range" in d for d in p.dropped)
    p = EP.plan(EP.EncodeSpec(container="mov"), cases[2][0], FULL)
    assert not any("full range" in d for d in p.dropped)


def test_source_info_from_probe_carries_range() -> None:
    from aivc.media.probe import Probe

    def probe(rng: str | None, matrix: str) -> Probe:
        return Probe(
            path=r"D:\v\phone.mp4", container="mov,mp4,m4a,3gp,3g2,mj2", size_bytes=1, codec="h264", width=640, height=480,
            pix_fmt="yuvj420p", fps_num=30, fps_den=1, time_base_num=1, time_base_den=30, color_range=rng, matrix_assumed=matrix,
        )

    s = EP.SourceInfo.from_probe(probe("pc", "bt601"))
    assert s.color_range == "pc" and s.matrix_assumed == "bt601"
    assert EP.plan(EP.EncodeSpec(container="mkv", codec="ffv1"), s, FULL).color_args == _tags("pc", "smpte170m")
    assert EP.SourceInfo.from_probe(probe(None, "bt709")).color_range == "tv"
    assert EP.SourceInfo.from_probe(probe("unknown", "bt709")).color_range == "tv"


def test_full_range_ffv1_roundtrip_keeps_levels_and_tag(tmp_path: Path) -> None:
    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")
    from aivc.media import encoder as EN
    from aivc.media.probe import probe
    from aivc.media.source import FrameSource
    from aivc.media.source import Yuv420 as SrcYuv420

    W, H = 64, 48
    y = np.full((H, W), 250, np.uint8)
    y[:, : W // 2] = 4
    c = np.full((H // 2, W // 2), 128, np.uint8)
    frames = [SrcYuv420(y, c, c, src_idx=i, color_range="pc") for i in range(3)]
    src = EP.SourceInfo("mkv", W, H, 30, 1, False, None, "bt709", "pc")
    plan = EP.plan(EP.EncodeSpec(container="mkv", codec="ffv1", audio="none"), src, {"ffv1"})
    out = tmp_path / "pc.mkv"
    EN.write_frames(frames, plan, out, width=W, height=H, fps=(30, 1), total=len(frames))
    assert probe(out).color_range == "pc"
    with FrameSource(out) as fs:
        fr = fs.get(0)
    assert fr.color_range == "pc"
    assert np.array_equal(fr.y, y)  # 零轉換：4／250 沒有被當 tv 壓進 16..235


def test_render_frame_planes_carries_colour_metadata() -> None:
    """render 路徑必須把解碼幀的 matrix／color_range 帶進合成器（finding 0 驗證者指出 render.py 那一行沒接上）。"""
    from types import SimpleNamespace

    from aivc.ops.render import frame_planes

    y = np.full((4, 6), 248, np.uint8)
    u = np.full((2, 3), 128, np.uint8)
    v = np.full((2, 3), 128, np.uint8)
    p = frame_planes(SimpleNamespace(y=y, u=u, v=v, matrix="bt601", color_range="pc"))
    assert (p.matrix, p.color_range) == ("bt601", "pc")
    assert p.y is y and p.u is u and p.v is v
    legacy = frame_planes(SimpleNamespace(y=y, u=u, v=v))  # 沒有中繼資料的替身 → 舊預設
    assert (legacy.matrix, legacy.color_range) == ("bt709", "tv")
