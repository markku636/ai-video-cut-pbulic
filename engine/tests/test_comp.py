"""合成器單元測試（CPU、不需範例影片）。場景產生器在 tests/fixtures/comp/synth.py。

對應計畫 §11 test_compositor：(a) 遮罩外 planes 逐位元相同 (b) identity 替換 PSNR>40 (c) 確定性
(d) hold 不動 (e) blank 無墨 (f) 動態模糊長度 (g) 巨集 alpha 統計不同；另加 params / 色彩 / blur 數學 / 顆粒 / 遮擋。
這裡測的是**核心**合成器：外掛的掛勾（替代合成路徑、新面加工）整個模組都暫停（`hooks.suspended`），裝不裝外掛結果都一樣。
牌局外掛的印刷（墨色比對、墨邊預模糊）與紙面檢查在 plugins/cards/engine/tests/test_comp_cards.py。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures" / "comp"))
import synth  # noqa: E402

from aivc import hooks  # noqa: E402
from aivc.comp import _color  # noqa: E402
from aivc.comp import blur as blur_mod  # noqa: E402
from aivc.comp import grain as grain_mod  # noqa: E402
from aivc.comp.compositor import composite_frame, occlusion_alpha, quad_alpha  # noqa: E402
from aivc.comp.params import InsertParams  # noqa: E402


@pytest.fixture(autouse=True)
def _core_only():  # noqa: ANN202
    with hooks.suspended():
        yield


@pytest.fixture(scope="module")
def noisy() -> synth.Scene:
    return synth.render_scene(noise_sigma=0.004)


@pytest.fixture(scope="module")
def clean() -> synth.Scene:
    return synth.render_scene(noise_sigma=0.0)


def _run(sc: synth.Scene, params: InsertParams | None = None, *, new=None, **kw):
    return composite_frame(
        sc.planes, sc.H, kw.pop("alpha_vis", None), sc.tmpl_orig, sc.tmpl_new if new is None else new,
        sc.ink_orig, sc.ink_new, sc.paper, params=params, barcode_mask=sc.barcode, **kw,
    )


NO_GRAIN = InsertParams.from_dict({"grain": {"amount": 0}})


# ---------------------------------------------------------------------------
# (a) 遮罩外逐位元相同
# ---------------------------------------------------------------------------
def test_outside_planes_byte_identical(noisy: synth.Scene) -> None:
    r = _run(noisy, frame_index=3)
    assert not r.stats.hold
    wm = r.write_mask_full()
    # 測試自己算 dilate(alpha>0, 1px)，不信任 result 給的遮罩
    import cv2

    own = cv2.dilate((r.alpha_full() > 0).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    assert np.array_equal(own, wm)
    out: _color.Yuv420 = r.out  # type: ignore[assignment]
    assert np.array_equal(out.y[~own], noisy.planes.y[~own])
    cm = _color.chroma_write_mask(own)
    assert np.array_equal(out.u[~cm], noisy.planes.u[~cm])
    assert np.array_equal(out.v[~cm], noisy.planes.v[~cm])
    # 裡面真的有變
    assert int((out.y != noisy.planes.y).sum()) > 2000
    assert r.stats.alpha_area > 5000 and r.stats.grain_source == "measured"


def test_rgb8_input_outside_identical(noisy: synth.Scene) -> None:
    rgb8 = _color.yuv420_to_rgb8(noisy.planes)
    r = composite_frame(rgb8, noisy.H, None, noisy.tmpl_orig, noisy.tmpl_new, noisy.ink_orig, noisy.ink_new, noisy.paper)
    wm = r.write_mask_full()
    assert np.array_equal(r.out[~wm], rgb8[~wm])  # type: ignore[index]
    assert int((r.out != rgb8).any(axis=-1).sum()) > 2000  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# (b) identity 替換
# ---------------------------------------------------------------------------
def test_identity_replacement_psnr(clean: synth.Scene) -> None:
    # 核心沒有新面加工（外掛的印刷／預模糊）：模板原樣貼回去就該幾乎無損
    r = _run(clean, InsertParams.from_dict({"grain": {"amount": 0}}), new=clean.tmpl_orig)
    assert r.stats.ink_match == "" and r.stats.preblur_px == (0.0, 0.0)  # 沒有外掛 → 沒有加工的紀錄
    m = r.alpha_full() >= 0.999
    assert int(m.sum()) > 5000
    out: _color.Yuv420 = r.out  # type: ignore[assignment]
    assert synth.psnr_u8(out.y, clean.planes.y, m) > 40.0
    cm = _color.chroma_write_mask(m)
    assert synth.psnr_u8(out.u, clean.planes.u, cm) > 40.0
    assert synth.psnr_u8(out.v, clean.planes.v, cm) > 40.0


# ---------------------------------------------------------------------------
# (c) 確定性
# ---------------------------------------------------------------------------
def test_deterministic_and_frame_seeded(noisy: synth.Scene) -> None:
    a = _run(noisy, frame_index=5, seed=1)
    b = _run(noisy, frame_index=5, seed=1)
    c = _run(noisy, frame_index=6, seed=1)
    assert all(np.array_equal(x, y) for x, y in zip(a.out, b.out))  # type: ignore[arg-type]
    assert not np.array_equal(a.out.y, c.out.y)  # type: ignore[union-attr]
    p_static = InsertParams.from_dict({"grain": {"perFrameSeed": False}})
    d = _run(noisy, p_static, frame_index=5, seed=1)
    e = _run(noisy, p_static, frame_index=9, seed=1)
    assert np.array_equal(d.out.y, e.out.y)  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# (d) hold
# ---------------------------------------------------------------------------
def test_hold_policy_untouched(clean: synth.Scene) -> None:
    for p, kw in (
        (InsertParams.from_dict({"regionPolicy": "hold"}), {}),
        (InsertParams.from_dict({"applyMix": 0}), {}),
        (InsertParams(), {"conf": 0.2}),
        (InsertParams.from_macro("conservative"), {"conf": 0.45}),  # conservative hold 0.50
    ):
        r = _run(clean, p, **kw)
        assert r.stats.hold and r.out is clean.planes


def test_full_macro_lower_hold_threshold(clean: synth.Scene) -> None:
    r = _run(clean, InsertParams.from_macro("full"), conf=0.3)  # full hold 0.25 → 不 hold
    assert not r.stats.hold


# ---------------------------------------------------------------------------
# (e) blank
# ---------------------------------------------------------------------------
def test_blank_target_has_no_ink(clean: synth.Scene) -> None:
    p = InsertParams.from_dict({"grain": {"amount": 0}, "regionPolicy": "full"})
    r = _run(clean, p, target="blank")
    m = r.alpha_full() >= 0.999
    out: _color.Yuv420 = r.out  # type: ignore[assignment]
    assert clean.planes.y[m].min() < 60  # 原本有黑墨
    assert out.y[m].min() > 150  # 現在只有紙（最暗處是漸層 0.72 的紙）
    # keepBarcode 的 blank 仍保留條碼灰塊
    r2 = _run(clean, NO_GRAIN, target="blank")
    assert r2.out.y[m].min() < 140  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# (f) 動態模糊長度
# ---------------------------------------------------------------------------
def _smear_width(clean: synth.Scene, angle: float, disp: float = 8.0) -> tuple[int, float]:
    q = clean.quad
    Hp = blur_mod.H_from_quad(q - [disp, 0], synth.TMPL_W, synth.TMPL_H)
    Hn = blur_mod.H_from_quad(q + [disp, 0], synth.TMPL_W, synth.TMPL_H)
    p = InsertParams.from_dict({"grain": {"amount": 0}, "edge": {"softness": 0, "choke": 0}, "motionBlur": {"shutterAngle": angle}})
    r = composite_frame(clean.planes, clean.H, None, clean.tmpl_orig, clean.tmpl_orig, clean.ink_orig, clean.ink_orig, None, H_prev=Hp, H_next=Hn, params=p)
    # 量 alpha（覆蓋率）沿牌右緣的過渡帶寬，而不是量亮度：合成底下的原牌是**銳利**的（合成場景沒有動態模糊），
    # 過渡帶靠牌內的那半邊是「牌蓋牌」看不出來，只量亮度會把塗抹長度量成一半。alpha 是每個快門樣本
    # 的四邊形覆蓋平均，正是 180°/360° 語意要驗的量；顏色用同一組樣本累加，所以 alpha 對＝顏色對。
    a = r.alpha_full()
    row = int(q[:, 1].mean())
    cx = int(q[:, 0].mean())
    line = a[row, cx : cx + 120]
    band = np.where((line > 0.03) & (line < 0.97))[0]
    width = int(band.max() - band.min() + 1) if len(band) else 0
    return width, r.stats.samples


def test_motion_blur_length_180_vs_360(clean: synth.Scene) -> None:
    w180, n180 = _smear_width(clean, 180.0)
    w360, n360 = _smear_width(clean, 360.0)
    w0, n0 = _smear_width(clean, 0.0)
    assert n180 == 8 and n360 == 16 and n0 == 1  # ceil(8·0.5/0.5) / ceil(8·1/0.5) / 死區
    assert 2.5 <= w180 <= 5.5, w180  # 8 px × 180° → ≈4 px 塗抹
    assert 6.0 <= w360 <= 10.0, w360  # 360° → ≈8 px
    assert w0 <= 2  # 無模糊只有反鋸齒邊
    assert 1.6 <= w360 / w180 <= 2.6


def test_blur_plan_rules() -> None:
    p = InsertParams().motion_blur
    assert blur_mod.auto_samples(8.0, p) == 8  # 路徑 4 px / 間距 0.5
    assert blur_mod.auto_samples(1.0, p) == 1  # 0.5 px < 0.7 死區
    assert blur_mod.auto_samples(1000.0, p) == p.max_samples  # 安全閥
    # 最快的點：平均 1 px（死區內）但翹起的角走 12 px → 路徑 6 px、最快點間距 ≤ 2·max_step → 6 個樣本
    assert blur_mod.auto_samples(1.0, p, fastest_px=12.0) == 6
    assert blur_mod.auto_samples(8.0, p, fastest_px=8.0) == 8  # 平移：最快 = 平均 → 與舊規則相同
    assert blur_mod.auto_samples(0.5, p, fastest_px=1.2) == 1  # 最快點也在死區內 → 單次 warp
    from dataclasses import replace

    assert blur_mod.shutter_window(replace(p, shutter_phase="start")) == (0.0, 0.5)
    assert blur_mod.shutter_window(replace(p, shutter_phase="end")) == (-0.5, 0.0)
    assert blur_mod.shutter_window(replace(p, shutter_phase="custom", shutter_offset=0.25)) == (0.25, 0.75)
    assert blur_mod.shutter_window(p) == (-0.25, 0.25)
    q = synth.DEFAULT_QUAD
    H = blur_mod.H_from_quad(q, synth.TMPL_W, synth.TMPL_H)
    assert np.allclose(blur_mod.quad_from_H(H, synth.TMPL_W, synth.TMPL_H), q, atol=1e-6)
    plan = blur_mod.plan_blur(H, None, None, synth.TMPL_W, synth.TMPL_H, p)
    assert plan.samples == 1 and plan.displacement_px == 0.0
    Hn = blur_mod.H_from_quad(q + [6, 0], synth.TMPL_W, synth.TMPL_H)
    plan2 = blur_mod.plan_blur(H, None, Hn, synth.TMPL_W, synth.TMPL_H, p)  # 缺 prev → 鏡射外推
    assert plan2.samples == 6 and abs(plan2.displacement_px - 6.0) < 1e-6
    assert np.allclose(np.mean([qq for qq in plan2.quads], axis=0), q, atol=1e-6)  # centered：樣本均值＝k 幀


def test_blur_sample_spacing_never_exceeds_max_step_px() -> None:
    """重影的判準是**樣本間距**，不是樣本數：墨邊 σ≈0.62 px 只蓋得住間距 ≲1 px 的梳齒。

    舊寫法 n = clamp(ceil(path), 1, 9) 在 path > 9 px 時把間距撐到 1.2–3.6 px（clip 125 k=50 Banker1 實測 3.58 px、
    與連續線積分差 22 碼），使用者看到兩三層錯開的重影。"""
    from dataclasses import replace

    p = InsertParams().motion_blur
    for d in (2.0, 8.0, 21.0, 40.0, 63.0):  # 路徑 ≤ 32 px（安全閥 max_samples 之內）
        n = blur_mod.auto_samples(d, p)
        assert n <= p.max_samples
        assert d * p.shutter_frames / n <= p.max_step_px + 1e-9, (d, n)
    assert blur_mod.auto_samples(400.0, p) == p.max_samples  # 甩鏡：安全閥接手（間距放寬）
    # 死區（0.7 px）以上一定至少 2 個樣本：中點法只有 1 個樣本 ＝ 完全沒糊（間距 1.0 時 clip 125 k=27 Player2 差 19 碼）
    for d in (0.71 / p.shutter_frames, 1.0 / p.shutter_frames, 1.4 / p.shutter_frames):
        assert blur_mod.auto_samples(d, p) >= 2, d
    old = replace(p, max_samples=9)
    assert 64.5 * old.shutter_frames / blur_mod.auto_samples(64.5, old) > 3.0  # 舊上限就是重影的來源


def test_shutter_angle_auto_falls_back_to_180_until_render_resolves_it() -> None:
    from dataclasses import replace

    q = InsertParams.from_dict({"motionBlur": {"shutterAngle": "auto"}}).motion_blur
    assert q.shutter_angle == "auto" and q.shutter_frames == 0.5  # 沒解析前＝慣例的 180°，不會炸
    assert replace(q, shutter_angle=105.0).shutter_frames == pytest.approx(105.0 / 360.0)
    with pytest.raises(ValueError):
        InsertParams.from_dict({"motionBlur": {"shutterAngle": "half"}})


def test_single_sample_centered_is_bit_identical_to_no_blur(clean: synth.Scene) -> None:
    q = clean.quad
    Hp = blur_mod.H_from_quad(q - [1, 0], synth.TMPL_W, synth.TMPL_H)  # 1 px/幀 × 0.5 = 0.5 < 死區
    Hn = blur_mod.H_from_quad(q + [1, 0], synth.TMPL_W, synth.TMPL_H)
    a = _run(clean, NO_GRAIN, H_prev=Hp, H_next=Hn)
    b = _run(clean, NO_GRAIN)
    assert a.stats.samples == 1 and np.array_equal(a.out.y, b.out.y)  # type: ignore[union-attr]


# ---------------------------------------------------------------------------
# (g) 巨集
# ---------------------------------------------------------------------------
def test_macros_change_alpha_stats(noisy: synth.Scene) -> None:
    areas = {}
    for name in ("conservative", "standard", "full"):
        r = _run(noisy, InsertParams.from_macro(name))
        areas[name] = (r.stats.alpha_area, r.stats.alpha_max)
    assert areas["conservative"][1] == pytest.approx(0.95, abs=1e-3)
    assert areas["standard"][1] == pytest.approx(1.0, abs=1e-4)
    assert areas["conservative"][0] < areas["standard"][0] < areas["full"][0]


# ---------------------------------------------------------------------------
# params
# ---------------------------------------------------------------------------
def test_params_defaults_and_macros() -> None:
    p = InsertParams()
    assert p.motion_blur.shutter_angle == 180.0 and p.motion_blur.shutter_frames == 0.5
    assert p.edge.choke == 0.6 and p.edge.softness == 0.8 and p.edge.falloff == "linear"
    assert p.occlusion.dilate == 1.0 and p.occlusion.feather == 1.2
    assert p.resample.kernel == "lanczos3" and p.resample.clamp is True and p.resample.supersample == "auto"
    assert p.relight.shading_blur_sigma == 0.015 and p.relight.ink_dilate == 2.0 and p.relight.sheen_lock == "plate"
    assert p.grain.mode == "measured" and p.grain.blocky8x8 and p.grain.per_frame_seed and p.grain.apply_through_alpha_only
    assert p.region_policy == "keepBarcode" and p.smoothing.hold_below_conf == 0.35
    c = InsertParams.from_macro("conservative")
    assert (c.relight.ink_dilate, c.edge.choke, c.edge.softness, c.comp.opacity, c.smoothing.hold_below_conf) == (1.0, 1.0, 1.2, 0.95, 0.5)
    f = InsertParams.from_macro("full")
    assert (f.relight.ink_dilate, f.edge.choke, f.edge.softness, f.comp.opacity, f.smoothing.hold_below_conf) == (3.0, 0.3, 0.5, 1.0, 0.25)
    assert InsertParams.from_macro("standard") == InsertParams()
    assert p.supersample_for(120.0) == 2 and p.supersample_for(45.0) == 3 and p.supersample_for(120.0, "wide") == 3


def test_params_from_dict_inherit_and_camelcase() -> None:
    base = InsertParams.from_dict({"edge": {"choke": 0.9}})
    d = {"macro": "full", "opacity": 80, "applyMix": None, "edge": {"softness": None, "falloff": "smoothstep"},
         "motionBlur": {"shutterAngle": 90, "samples": 3}, "resample": {"kernel": "bicubic", "clamp": False},
         "grain": {"mode": "synthetic", "amount": 50}, "regionPolicy": "full"}
    p = InsertParams.from_dict(d, base)
    assert p.macro == "full" and p.edge.choke == 0.3 and p.edge.softness == 0.5 and p.edge.falloff == "smoothstep"
    assert p.comp.opacity == pytest.approx(0.8) and p.comp.apply_mix == 1.0
    assert p.motion_blur.shutter_angle == 90 and p.motion_blur.samples == 3 and p.motion_blur.shutter_frames == 0.25
    assert p.resample.kernel == "bicubic" and p.resample.clamp is False
    assert p.grain.mode == "synthetic" and p.grain.amount == pytest.approx(0.5) and p.region_policy == "full"
    # None / 空 dict → 原樣繼承
    assert InsertParams.from_dict(None, base) == base and InsertParams.from_dict({"edge": {"choke": None}}, base) == base
    assert InsertParams.from_dict({"edge": {"choke": 0.9}}).macro == "custom"
    # 錯誤要在建構時被抓到
    with pytest.raises(ValueError):
        InsertParams.from_dict({"edge": {"falloff": "cubic"}})
    with pytest.raises(ValueError):
        InsertParams.from_dict({"edge": {"chok": 1}})
    with pytest.raises(ValueError):
        InsertParams.from_dict({"macro": "wild"})
    with pytest.raises(ValueError):
        InsertParams.from_dict({"comp": {"blendMode": "multiply"}})
    with pytest.raises(ValueError):
        InsertParams.from_dict({"opacity": -1})
    # snake_case CLI 風格
    q = InsertParams.from_dict({"shutter_angle": None, "motion_blur": {"shutter_angle": 270}, "hold_below": 0.5, "region": "hold"})
    assert q.motion_blur.shutter_angle == 270 and q.smoothing.hold_below_conf == 0.5 and q.is_hold


# ---------------------------------------------------------------------------
# 色彩
# ---------------------------------------------------------------------------
def test_color_transfer_and_matrix_roundtrip() -> None:
    assert _color.oetf_inverse(np.float32(0.0)) == 0.0 and abs(float(_color.oetf_inverse(np.float32(1.0))) - 1.0) < 1e-6
    v = np.linspace(-0.1, 1.2, 1000, dtype=np.float32)
    assert np.allclose(_color.oetf(_color.oetf_inverse(v)), v, atol=2e-6)
    rng = np.random.default_rng(0)
    lin = rng.uniform(0, 1, (64, 64, 3)).astype(np.float32)
    lin = np.repeat(np.repeat(lin[::2, ::2], 2, axis=0), 2, axis=1)  # 色度 2×2 常數 → 往返可精確
    planes = _color.linear_to_yuv420(lin)
    assert planes.y.min() >= 16 and planes.y.max() <= 235 and planes.u.min() >= 16 and planes.u.max() <= 240
    back = _color.yuv420_to_linear(planes)
    err8 = np.abs(_color.oetf(back) - _color.oetf(lin)) * 255
    # limited range：Y' 只有 219 級（每級 1.16/255）、色度 224 級再乘 1.57/1.86 的矩陣係數 → 單一像素最壞可到 ~2/255
    assert np.percentile(err8, 99) <= 1.6 and err8.max() < 3.0
    # Y' 16 → 0、235 → 1
    p = _color.Yuv420(np.full((2, 2), 16, np.uint8), np.full((1, 1), 128, np.uint8), np.full((1, 1), 128, np.uint8))
    assert np.allclose(_color.yuv420_to_linear(p), 0.0, atol=1e-6)
    p = _color.Yuv420(np.full((2, 2), 235, np.uint8), np.full((1, 1), 128, np.uint8), np.full((1, 1), 128, np.uint8))
    assert np.allclose(_color.yuv420_to_linear(p), 1.0, atol=1e-5)


def test_color_roi_equals_full_and_write_back_zero_delta(noisy: synth.Scene) -> None:
    full = _color.yuv420_to_linear(noisy.planes)
    roi = (96, 72, 266, 188)
    part = _color.yuv420_to_linear(noisy.planes, roi)
    assert np.array_equal(part, full[72:188, 96:266])
    mask = np.ones((188 - 72, 266 - 96), bool)
    same = _color.write_back(noisy.planes, roi, part, part, mask)
    assert all(np.array_equal(a, b) for a, b in zip(same, noisy.planes))
    with pytest.raises(ValueError):
        _color.yuv420_to_linear(noisy.planes, (1, 0, 10, 10))


# ---------------------------------------------------------------------------
# alpha / 遮擋 / 顆粒 / 光影
# ---------------------------------------------------------------------------
def test_quad_alpha_geometry() -> None:
    q = np.array([[10.0, 10.0], [50.0, 10.0], [50.0, 30.0], [10.0, 30.0]])
    a = quad_alpha(q, 64, 40, 1.0, 0.0, 0.0, "linear")
    assert a[20, 30] == 1.0 and a[5, 30] == 0.0 and a[20, 55] == 0.0
    assert abs(float(a.sum()) - 40 * 20) < 2.0  # 覆蓋面積 ≈ 800
    choked = quad_alpha(q, 64, 40, 1.0, 2.0, 0.0, "linear")
    assert abs(float(choked.sum()) - 36 * 16) < 2.0
    soft = quad_alpha(q, 64, 40, 1.0, 0.0, 4.0, "smoothstep")
    assert 0.0 < soft[10, 30] < 1.0 and soft[20, 30] == 1.0
    assert np.allclose(quad_alpha(q[::-1], 64, 40, 1.0, 0.0, 0.0, "linear"), a)  # 反向繞序同結果


def test_occlusion_alpha_dilate_feather() -> None:
    vis = np.ones((40, 80), np.float32)
    vis[:, 40:] = 0.0
    o = occlusion_alpha(vis, 1.0, 1.2)
    assert o[:, 45:].max() < 1e-3 and o[:, :35].min() > 0.999
    assert o[20, 38] < 0.99  # 膨脹 1 px 吃到 x=39，羽化再往外
    o0 = occlusion_alpha(vis, 0.0, 0.0)
    assert o0[20, 39] == 1.0 and o0[20, 40] == 0.0


def test_occlusion_in_composite(noisy: synth.Scene) -> None:
    vis = np.ones((synth.FRAME_H, synth.FRAME_W), bool)
    vis[:, 180:] = False
    r = _run(noisy, alpha_vis=vis)
    a = r.alpha_full()
    assert a[:, 184:].max() < 1e-3 and a[100:160, 120:170].min() > 0.999
    assert 0.35 < r.stats.paper_coverage < 0.65
    out: _color.Yuv420 = r.out  # type: ignore[assignment]
    assert np.array_equal(out.y[:, 186:], noisy.planes.y[:, 186:])


def test_grain_measure_and_synth() -> None:
    rng = np.random.default_rng(3)
    sigma = np.array([0.004, 0.003, 0.005], np.float32)
    res = rng.standard_normal((200, 200, 3), dtype=np.float32) * sigma
    m = grain_mod.measure_sigma(res, np.ones((200, 200), bool))
    assert np.allclose(m, sigma, rtol=0.1)
    assert np.all(np.isnan(grain_mod.measure_sigma(res, np.zeros((200, 200), bool))))
    g1 = grain_mod.synth_grain(64, 96, sigma, seed=grain_mod.frame_seed(0, 1), origin=(8, 16))
    g2 = grain_mod.synth_grain(64, 96, sigma, seed=grain_mod.frame_seed(0, 1), origin=(8, 16))
    g3 = grain_mod.synth_grain(64, 96, sigma, seed=grain_mod.frame_seed(0, 2), origin=(8, 16))
    assert np.array_equal(g1, g2) and not np.array_equal(g1, g3)
    assert np.allclose(g1.reshape(-1, 3).std(axis=0), sigma, rtol=0.25)
    assert grain_mod.synth_grain(8, 8, sigma, seed=1, amount=0.0).max() == 0.0
    plain = grain_mod.synth_grain(64, 96, sigma, seed=5, blocky8x8=False)
    assert plain.shape == (64, 96, 3)
    s, src = grain_mod.resolve_sigma(np.array([np.nan] * 3), "measured")
    assert src == "synthetic" and np.all(np.isfinite(s))
    assert grain_mod.frame_seed(0, 1) != grain_mod.frame_seed(0, 2) and grain_mod.frame_seed(0, 1, per_frame=False) == grain_mod.frame_seed(0, 2, per_frame=False)


def test_measured_grain_matches_scene_noise(noisy: synth.Scene) -> None:
    r = _run(noisy)
    gs = np.array(r.stats.grain_sigma)
    assert np.all((gs > 0.0025) & (gs < 0.0055)), gs  # 場景加了 0.004 線性雜訊


def test_generic_shading_without_template(noisy: synth.Scene) -> None:
    r = composite_frame(noisy.planes, noisy.H, None, None, noisy.tmpl_new, None, noisy.ink_new, noisy.paper)
    assert not r.stats.hold and r.stats.shading_source == "lowpass-mean"
    with pytest.raises(ValueError):
        composite_frame(noisy.planes, noisy.H, None, None, noisy.tmpl_new, None, None, None, params=InsertParams.from_dict({"relight": {"shadingSource": "template-ratio"}}))


def test_keep_barcode_copies_original_pixels(clean: synth.Scene) -> None:
    # 新模板把條碼位置塗成紙：full 政策 → 該處變亮；keepBarcode → 仍是矯正原像素的灰塊
    new_nb = clean.tmpl_new.copy()
    new_nb[clean.barcode] = synth.PAPER8
    keep = _run(clean, NO_GRAIN, new=new_nb)
    full = _run(clean, InsertParams.from_dict({"grain": {"amount": 0}, "regionPolicy": "full"}), new=new_nb)
    # 條碼中心在幀中的位置：模板 (110,160) 經 H
    pt = np.array([[110.0, 160.0, 1.0]]) @ clean.H.T
    x, y = int(pt[0, 0] / pt[0, 2]), int(pt[0, 1] / pt[0, 2])
    orig = clean.planes.y[y - 1 : y + 2, x - 2 : x + 3].astype(int)
    assert np.abs(keep.out.y[y - 1 : y + 2, x - 2 : x + 3].astype(int) - orig).max() <= 3  # type: ignore[union-attr]
    assert full.out.y[y, x] > orig.max() + 40  # type: ignore[union-attr]  # full：條碼位置變成新模板的紙


def test_shading_recovers_gradient(clean: synth.Scene) -> None:
    r = _run(clean, NO_GRAIN)
    est = r.shading
    assert est is not None and est.source == "template-ratio"
    import cv2

    truth = cv2.resize(clean.shade, (est.gain.shape[1], est.gain.shape[0]), interpolation=cv2.INTER_AREA)
    inner = est.paper.copy()
    inner[:8], inner[-8:], inner[:, :8], inner[:, -8:] = False, False, False, False
    rel = np.abs(est.gain - truth)[inner] / truth[inner]
    assert np.percentile(rel, 95) < 0.03  # 光影誤差 <3%（含墨洞內插）


def test_offscreen_and_degenerate(clean: synth.Scene) -> None:
    far = blur_mod.H_from_quad(clean.quad + [2000, 0], synth.TMPL_W, synth.TMPL_H)
    assert composite_frame(clean.planes, far, None, clean.tmpl_orig, clean.tmpl_new, clean.ink_orig, clean.ink_new, clean.paper).stats.hold_reason == "offscreen"
    with pytest.raises(ValueError):
        composite_frame(clean.planes, np.zeros((3, 3)), None, clean.tmpl_orig, clean.tmpl_new, None, None, None)


# ---------------------------------------------------------------------------
# A4 pull-forward：鬼影、墨色、顆粒碼值域、預模糊
# ---------------------------------------------------------------------------
def _ghost_residual(params: dict) -> tuple[float, float, int]:
    """真印刷相對模板平移 (5,10) 模板 px（≈3 幀 px）→ 換成新牌 → 在「原真墨、但不在新墨附近」的區域比對 ground truth
    （同光影直接渲染新牌的場景）。回 (平均相對誤差, p95, 像素數)。"""
    import cv2

    dx, dy = 5, 10
    truth = synth.render_scene(noise_sigma=0.0, tmpl_kind="new")
    sc = synth.render_scene(noise_sigma=0.0, ink_offset_px=(dx, dy))
    shifted = np.roll(sc.ink_orig, (dy, dx), axis=(0, 1))

    def dil(m: np.ndarray, r: int) -> np.ndarray:
        return cv2.dilate(m.astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))) > 0

    reg = dil(shifted, 2) & ~dil(sc.ink_new, 6) & ~dil(sc.barcode, 6) & ~dil(sc.ink_orig, 1) & sc.paper
    T = np.array([[1, 0, -0.5], [0, 1, -0.5], [0, 0, 1.0]])
    regf = cv2.warpPerspective(reg.astype(np.uint8), T @ sc.H @ np.linalg.inv(T), (synth.FRAME_W, synth.FRAME_H), flags=cv2.INTER_NEAREST) > 0
    base = {"grain": {"amount": 0}, "regionPolicy": "full"}
    base.update(params)
    r = composite_frame(sc.planes, sc.H, None, sc.tmpl_orig, sc.tmpl_new, sc.ink_orig, sc.ink_new, sc.paper, params=InsertParams.from_dict(base), barcode_mask=sc.barcode)
    m = regf & (r.alpha_full() >= 0.999)
    out, tr = _color.yuv420_to_linear(r.out), _color.yuv420_to_linear(truth.planes)  # type: ignore[arg-type]
    rel = np.abs(out - tr).max(axis=-1)[m] / np.maximum(tr.mean(axis=-1)[m], 1e-3)
    return float(rel.mean()), float(np.percentile(rel, 95)), int(m.sum())


def test_offset_real_ink_leaves_no_ghost() -> None:
    old_mean, _, n = _ghost_residual({"relight": {"excludeObservedInk": False}})
    new_mean, new_p95, n2 = _ghost_residual({})
    assert n == n2 and n > 200
    assert old_mean > 0.2, old_mean  # 只排模板墨：平移的真墨漏進光影圖 → 新牌面上有鬼影（實測 0.44）
    assert new_mean < 0.03 and new_p95 < 0.08, (new_mean, new_p95)  # 排除觀測墨後（實測 0.012 / 0.034）


def test_grain_in_code_domain_does_not_lift_black_ink() -> None:
    rng = np.random.default_rng(0)
    black = np.full((64, 64, 3), 0.02, np.float32)
    g = rng.standard_normal((64, 64, 3)).astype(np.float32) * 0.014  # 紙（線性 0.8）上量到的 sigma
    ones = np.ones((64, 64), np.float32)
    lin = grain_mod.add_in_code_domain(black, g, ones, np.full(3, 0.8, np.float32))
    y_code = _color.linear_to_yuv420(lin).y.astype(np.float64)
    y_naive = _color.linear_to_yuv420(black + g).y.astype(np.float64)
    y_none = _color.linear_to_yuv420(black).y.astype(np.float64)
    # 碼值域：黑墨上的雜訊與紙上一樣只有 ≈1.3 碼、平均不動；線性域直接加是 ≈9 碼（7 倍），黑墨變成明顯的灰色雜點
    assert 0.8 < y_code.std() < 2.5 and abs(y_code.mean() - y_none.mean()) < 0.6, (y_code.std(), y_code.mean(), y_none.mean())
    assert y_naive.std() > 4 * y_code.std(), (y_naive.std(), y_code.std())
    zero = grain_mod.add_in_code_domain(black, g, np.zeros((64, 64), np.float32), np.full(3, 0.8, np.float32))
    assert zero is black


def test_observed_ink_detection(clean: synth.Scene) -> None:
    """光影估計排除觀測到的真墨（核心）：對齊時觀測墨幾乎都落在模板墨膨脹圈內（漏出去的只有反鋸齒邊）。"""
    from aivc.comp import shading as shading_mod

    r = _run(clean, InsertParams.from_dict({"grain": {"amount": 0}}))
    est = r.shading
    assert est is not None and est.observed_ink is not None
    assert est.observed_ink.sum() > 1000 and est.observed_ink_px < 0.5 * est.observed_ink.sum()
    assert r.stats.ink_match == ""  # 墨色比對是外掛的新面加工
    assert np.allclose(shading_mod.chromaticity(np.array([[[0.5, 0.5, 0.5]]], np.float32)), 1 / 3)


def test_degrader_coarse_fade_hold() -> None:
    """核心的退化器：表面檢查（surface_check）由插入來源給；沒給就只看幾何。"""
    from aivc.comp.fallback import Degrader
    from aivc.geom.quad import raster_quad

    W, Hh, tw, th = 240, 160, 63, 88
    q0 = np.array([[60.0, 40.0], [150.0, 42.0], [148.0, 110.0], [58.0, 108.0]])
    H0 = blur_mod.H_from_quad(q0, tw, th)
    conf = {0: 0.99, 1: 0.2, 2: 0.2, 3: 0.2, 4: 0.2, 5: 0.2}
    Hs: dict[int, np.ndarray | None] = {0: H0, 1: H0, 2: None, 3: H0, 4: H0, 5: H0}
    shifted = q0 + [12.0, 3.0]
    masks = {0: raster_quad(q0, (Hh, W)).astype(bool), 1: raster_quad(q0, (Hh, W)).astype(bool), 2: raster_quad(shifted, (Hh, W)).astype(bool),
             3: raster_quad(q0 + [40.0, 0.0], (Hh, W)).astype(bool), 4: raster_quad(q0 + [40.0, 0.0], (Hh, W)).astype(bool), 5: raster_quad(q0 + [40.0, 0.0], (Hh, W)).astype(bool)}
    bright = np.full((Hh, W), 200, np.uint8)
    dark = np.full((Hh, W), 60, np.uint8)

    def bright_surface(quad: np.ndarray, mask: np.ndarray, planes: np.ndarray) -> bool:
        return float(planes[mask].mean()) >= 128  # 測試用的表面檢查：遮罩內夠亮

    d = Degrader(tmpl_wh=(tw, th), hold_below=0.35, get_mask=masks.get, get_H=Hs.get, get_conf=lambda k: conf[k], surface_check=bright_surface)
    assert d.resolve(0, bright).state == "tracked"
    r1 = d.resolve(1, bright)  # conf 低但遮罩就在追蹤四邊形內 → 沿用追蹤 H
    assert r1.state == "coarse" and r1.reason == "track-in-mask" and np.allclose(r1.H, H0)
    r2 = d.resolve(2, bright)  # 追蹤掉了、遮罩移了 12 px → 遮罩四角
    assert r2.state == "coarse" and r2.reason.startswith("mask-quad")
    assert np.allclose(blur_mod.quad_from_H(r2.H, tw, th), shifted, atol=1.0)
    # 表面檢查不過（遮罩裡太暗）→ 用最後一個好 H 漸變 2 幀，第 3 幀 hold
    r3, r4, r5 = d.resolve(3, dark), d.resolve(4, dark), d.resolve(5, dark)
    assert (r3.state, r4.state, r5.state) == ("fade", "fade", "hold")
    assert r3.opacity == pytest.approx(2 / 3) and r4.opacity == pytest.approx(1 / 3) and np.allclose(r3.H, r2.H)
    assert "not-paper" in r3.reason
    assert d.neighbour_H(0) is not None and d.neighbour_H(2) is not None  # 鄰幀：好 H 或只做幾何檢查的 coarse
    # 沒有表面檢查（surface_check=None）：幾何合理就接受，同一個暗遮罩也是 coarse
    d0 = Degrader(tmpl_wh=(tw, th), hold_below=0.35, get_mask=masks.get, get_H=Hs.get, get_conf=lambda k: conf[k])
    assert [d0.resolve(k, dark).state for k in range(4)] == ["tracked", "coarse", "coarse", "coarse"]
    # 從沒被追蹤到 → 即使遮罩四角合理也不 coarse
    d2 = Degrader(tmpl_wh=(tw, th), hold_below=0.35, get_mask=masks.get, get_H=Hs.get, get_conf=lambda k: 0.2)
    assert d2.resolve(1, bright).state == "hold"
