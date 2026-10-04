"""物件特效（aivc/fx）：參數驗證、各特效的數學、貼紙／文字的擺放，以及最重要的那條：
**作用範圍外逐位元相同**（yuv420p 的精確定義見 fx/apply.py 模組說明，這裡逐條驗）。

全部 CPU、合成畫面與合成遮罩；不需要影片、模型或 GPU。
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

from aivc.comp import _color  # noqa: E402
from aivc.fx import FxError, apply_effects, load_stack, parse_effect, parse_stack  # noqa: E402
from aivc.fx import effects as E  # noqa: E402
from aivc.fx.footprint import footprint_region  # noqa: E402
from aivc.fx.params import BlurFx, ColorFx, Footprint, MosaicFx, StickerFx, TextFx, effect_json, parse_color  # noqa: E402
from aivc.media.source import Yuv420 as MediaYuv  # noqa: E402
from aivc.objects.track import ObjectTrack  # noqa: E402
from aivc.seg.maskfile import MaskFile  # noqa: E402


# ---------------------------------------------------------------- 共用
def _rect(W: int, H: int, x0: int, y0: int, x1: int, y1: int) -> np.ndarray:
    m = np.zeros((H, W), bool)
    m[y0:y1, x0:x1] = True
    return m


def _rotated(W: int, H: int, cx: float, cy: float, w: float, h: float, deg: float) -> np.ndarray:
    pts = cv2.boxPoints(((cx, cy), (w, h), deg)).astype(np.int32)
    m = np.zeros((H, W), np.uint8)
    cv2.fillPoly(m, [pts], 1)
    return m.astype(bool)


def _track(tmp_path: Path, masks: dict[int, np.ndarray | None], W: int, H: int, name: str = "obj1") -> ObjectTrack:
    p = tmp_path / name / "masks.aivm"
    MaskFile.write(p, W, H, masks.items())
    return ObjectTrack.open(p)


def _noise(W: int, H: int, seed: int = 0) -> np.ndarray:
    return np.random.default_rng(seed).integers(16, 240, (H, W, 3), dtype=np.uint8)


def _sticker_png(tmp_path: Path, w: int = 20, h: int = 10, soft: bool = False) -> str:
    img = np.zeros((h, w, 4), np.uint8)
    img[..., 2] = 255  # BGRA 的 R
    img[..., 3] = 255
    if soft:
        yy, xx = np.mgrid[0:h, 0:w]
        d = np.hypot((xx - (w - 1) / 2) / (w / 2), (yy - (h - 1) / 2) / (h / 2))
        img[..., 3] = np.clip((1.2 - d) * 255, 0, 255).astype(np.uint8)
    p = tmp_path / "sticker.png"
    ok, buf = cv2.imencode(".png", img)
    assert ok
    p.write_bytes(buf.tobytes())
    return str(p)


def assert_outside_identical(before: object, after: object, F: np.ndarray) -> None:
    """fx/apply.py 的契約：F 外的 Y 相同；2×2 區塊完全沒碰到 F 的色度樣本相同。"""
    by, ay = before.y, after.y  # type: ignore[attr-defined]
    H, W = by.shape
    assert np.array_equal(by[~F], ay[~F]), "作用範圍外的 Y 變了"
    Fp = np.pad(F, ((0, H % 2), (0, W % 2)))
    touched = Fp.reshape(Fp.shape[0] // 2, 2, Fp.shape[1] // 2, 2).any(axis=(1, 3))
    for name in ("u", "v"):
        b, a = getattr(before, name), getattr(after, name)
        assert b.shape == touched.shape
        assert np.array_equal(b[~touched], a[~touched]), f"沒碰到作用範圍的 {name} 樣本變了"


# ---------------------------------------------------------------- 參數
class TestParams:
    def test_camel_與_snake_都吃_而且_footprint_可以寫在外層(self) -> None:
        e = parse_effect({"type": "mosaic", "minBlock": 6, "shape": "box", "expand": 3})
        assert isinstance(e, MosaicFx) and e.min_block == 6 and e.footprint == Footprint("box", 3.0, 1.0, True)
        e2 = parse_effect({"type": "mosaic", "min_block": 6, "footprint": {"shape": "ellipse"}, "feather": 0})
        assert e2.footprint.shape == "ellipse" and e2.footprint.feather == 0.0 and e2.footprint.expand == 4.0

    def test_未知鍵與超出範圍會講位置(self) -> None:
        with pytest.raises(FxError, match="stacks\\[0\\].effects\\[1\\]"):
            parse_stack({"stacks": [{"object": 1, "effects": [{"type": "blur"}, {"type": "blur", "radus": 3}]}]})
        with pytest.raises(FxError, match="opacity"):
            parse_effect({"type": "color", "opacity": 1.5})
        with pytest.raises(FxError, match="type"):
            parse_effect({"type": "sparkles"})
        with pytest.raises(FxError, match="image"):
            parse_effect({"type": "sticker"})

    def test_顏色的各種寫法(self) -> None:
        assert parse_color("#FF0000") == (1.0, 0.0, 0.0, 1.0)
        r, g, b, a = parse_color("#00FF0080")
        assert (r, g, b) == (0.0, 1.0, 0.0) and a == pytest.approx(128 / 255)
        assert parse_color([0, 0, 255]) == (0.0, 0.0, 1.0, 1.0)
        assert parse_color("255,255,255") == (1.0, 1.0, 1.0, 1.0)
        for bad in ("red", "#12", [1, 2], [0, 0, 300]):
            with pytest.raises(FxError):
                parse_color(bad)

    def test_tint_沒給量就是一半(self) -> None:
        e = parse_effect({"type": "color", "tint": "#00A0FF"})
        assert isinstance(e, ColorFx) and e.tint_amount == 0.5
        assert parse_effect({"type": "color"}).is_identity  # type: ignore[union-attr]

    def test_特效檔三種寫法(self, tmp_path: Path) -> None:
        a = parse_stack([{"type": "mosaic"}])
        assert len(a) == 1 and a[0].target == "*" and a[0].effects[0].type == "mosaic"
        b = parse_stack({"1": [{"type": "blur"}], "*": [{"type": "outline"}]})
        assert [s.target for s in b] == [1, "*"]
        c = parse_stack({"stacks": [{"masks": "D:/x/obj2/masks.aivm", "effects": [{"type": "glow"}]}, {"object": "all", "effects": []}]})
        assert c[0].target == "D:/x/obj2/masks.aivm" and c[1].target == "*"
        with pytest.raises(FxError):
            parse_stack({"stacks": [{"object": 0, "effects": []}]})
        with pytest.raises(FxError):
            parse_stack({"stacks": [{"object": 1, "masks": "x", "effects": []}]})
        f = tmp_path / "特效.json"
        f.write_text(json.dumps({"1": [{"type": "text", "text": "標籤"}]}, ensure_ascii=False), encoding="utf-8-sig")  # 記事本存的 BOM
        assert load_stack(str(f))[0].effects[0].text == "標籤"  # type: ignore[union-attr]
        assert load_stack('[{"type": "color", "hue": 30}]')[0].effects[0].hue == 30.0  # type: ignore[union-attr]
        with pytest.raises(FxError):
            load_stack("{not json")

    def test_effect_json_是_camelCase_顏色寫回_hex(self) -> None:
        j = effect_json(parse_effect({"type": "text", "text": "x", "strokeColor": "#112233"}))
        assert j["type"] == "text" and j["strokeColor"] == "#112233" and "followRotation" in j and j["offset"] == [0.0, -0.04]


# ---------------------------------------------------------------- 純數學
class TestMath:
    def test_馬賽克每格是格內平均_邊緣不完整格也算(self) -> None:
        img = np.arange(6 * 7 * 3, dtype=np.float32).reshape(6, 7, 3)
        out = E.pixelate(img, 0, 0, 4)
        assert np.allclose(out[0:4, 0:4], img[0:4, 0:4].mean(axis=(0, 1)))
        assert np.allclose(out[4:6, 4:7], img[4:6, 4:7].mean(axis=(0, 1)))
        # 格線對齊 (2, 1)：視窗原點 (0,0) 的第一格只有 2×1
        out2 = E.pixelate(img, 0, 0, 4, grid_x0=2, grid_y0=1)
        assert np.allclose(out2[0:1, 0:2], img[0:1, 0:2].mean(axis=(0, 1)))
        assert np.allclose(out2[1:5, 2:6], img[1:5, 2:6].mean(axis=(0, 1)))

    def test_去飽和就是亮度_色相旋轉保持亮度(self) -> None:
        rng = np.random.default_rng(3)
        lin = rng.random((10, 10, 3), dtype=np.float32) * 0.8
        gray = E.color_transform(lin, ColorFx(desaturate=1.0))
        assert np.allclose(gray[..., 0], gray[..., 1]) and np.allclose(gray[..., 1], gray[..., 2])
        assert np.allclose(gray[..., 0], E.luma(lin)[..., 0], atol=1e-5)
        rot = lin @ E.hue_matrix(120).T
        assert np.allclose(E.luma(rot), E.luma(lin), atol=2e-3)
        assert np.allclose(E.color_transform(lin, ColorFx()), np.clip(lin, 0, 1))

    def test_換色只換接近的顏色_保留明暗(self) -> None:
        red = E.srgb_to_linear((1.0, 0.0, 0.0))
        blue = E.srgb_to_linear((0.0, 0.0, 1.0))
        lin = np.stack([red * 0.5, red, blue]).astype(np.float32)[None]  # 暗紅、亮紅、藍
        e = parse_effect({"type": "color", "replace": {"from": "#FF0000", "to": "#00FF00"}})
        out = E.color_transform(lin, e)  # type: ignore[arg-type]
        assert out[0, 0, 1] > 0 and out[0, 0, 0] < 1e-3 and out[0, 1, 1] > out[0, 0, 1]  # 都變綠、亮的還是比暗的亮
        assert np.allclose(out[0, 2], lin[0, 2])  # 藍色不動

    def test_外光暈不碰物件本身_遠處是零(self) -> None:
        m = _rect(60, 40, 20, 10, 40, 30)
        a = E.glow_alpha(m, 6, 2, 1.0)
        assert not np.any(a[m]) and a[20, 17] > 0 and a[0, 0] == 0.0


# ---------------------------------------------------------------- 作用範圍
class TestFootprint:
    def test_mask_外擴與羽化(self, tmp_path: Path) -> None:
        W, H = 64, 48
        t = _track(tmp_path, {0: _rect(W, H, 20, 15, 30, 25)}, W, H)
        r = footprint_region(t.frame(0), Footprint("mask", 3.0, 2.0), W, H)
        assert r is not None
        full = np.zeros((H, W), np.float32)
        full[r.y0 : r.y1, r.x0 : r.x1] = r.alpha
        assert full[20, 20] > 0.9 and full[20, 18] > 0  # 外擴 3
        assert full[20, 14] == 0.0  # 超過 expand + feather + 1 就是 0
        r2 = footprint_region(t.frame(0), Footprint("mask", -2.0, 0.0), W, H)
        assert r2 is not None and not r2.core[0:2].any()  # 侵蝕

    def test_box_與_ellipse(self, tmp_path: Path) -> None:
        W, H = 64, 48
        t = _track(tmp_path, {0: _rect(W, H, 20, 10, 40, 30)}, W, H)
        rb = footprint_region(t.frame(0), Footprint("box", 0.0, 0.0), W, H)
        re_ = footprint_region(t.frame(0), Footprint("ellipse", 0.0, 0.0), W, H)
        assert rb is not None and re_ is not None
        assert int(rb.core.sum()) == 400 and 280 < int(re_.core.sum()) < 340  # π/4 × 400 ≈ 314

    def test_物件不在就沒有範圍(self, tmp_path: Path) -> None:
        t = _track(tmp_path, {0: None}, 32, 32)
        assert footprint_region(t.frame(0), Footprint(), 32, 32) is None


# ---------------------------------------------------------------- 作用範圍外逐位元相同
EFFECT_CASES = [
    {"type": "mosaic"},
    {"type": "mosaic", "shape": "ellipse", "expand": 6, "feather": 2, "align": "object"},
    {"type": "blur"},
    {"type": "blur", "shape": "box", "radius": 5},
    {"type": "color", "hue": 90, "saturation": 1.5},
    {"type": "color", "desaturate": 1.0, "brightness": 0.7, "feather": 3},
    {"type": "color", "tint": "#20A0FF", "tintAmount": 0.8},
    {"type": "outline", "color": "#FFD400", "width": 3},
    {"type": "outline", "mode": "box"},
    {"type": "glow", "intensity": 2.0, "radius": 6},
    {"type": "text", "text": "AB"},
]


def _support_px(e: object) -> int | None:
    """文件寫的作用範圍上限：遮罩往外最多長幾 px（文字沒有固定上限 → None）。"""
    if isinstance(e, (MosaicFx, BlurFx, ColorFx)):
        fp = e.footprint
        if fp.shape != "mask":
            return None  # box／ellipse 是外接框，另外量
        return int(math.ceil(max(0.0, fp.expand))) + int(math.ceil(fp.feather)) + 1
    t = getattr(e, "type", "")
    if t == "outline":
        if e.mode == "box":  # type: ignore[attr-defined]
            return None  # 方框畫在外接框上，離遮罩本身可以很遠（兩塊分開的物件之間）
        return int(e.width if e.width != "auto" else 1) + 2 * int(e.smooth) + 2  # type: ignore[attr-defined]
    if t == "glow":
        return int(math.ceil(e.spread + float(e.radius))) + 2  # type: ignore[attr-defined]
    return None


@pytest.mark.parametrize("size", [(96, 64), (97, 65)])
@pytest.mark.parametrize("spec", EFFECT_CASES, ids=lambda s: "-".join(f"{k}={v}" for k, v in s.items()))
def test_作用範圍外的_yuv_位元組完全不動(tmp_path: Path, size: tuple[int, int], spec: dict) -> None:
    W, H = size
    obj = _rotated(W, H, 41.3, 30.7, 30, 16, 25.0) | _rect(W, H, 0, 50, 9, H)  # 一塊斜的＋一塊貼著左／下邊
    t = _track(tmp_path, {0: obj}, W, H)
    st = parse_stack([spec])
    pairs = [(s.target, s.effects) for s in st]
    rgb = _noise(W, H)
    support = _support_px(st[0].effects[0])
    for planes in (_color.rgb8_to_yuv420(rgb), _color.rgb8_to_yuv420(rgb, "bt601", "pc")):
        res = apply_effects(planes, 0, {1: t.frame(0)}, pairs)
        assert res.changed, spec
        F = res.footprint(W, H)
        assert F.any() and F.sum() == res.footprint_px
        if support is not None:  # 範圍本身也要是文件說的那麼大，不然「範圍外不動」是空話
            k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * support + 1, 2 * support + 1))
            assert not (F & ~cv2.dilate(obj.astype(np.uint8), k).astype(bool)).any(), f"作用範圍超出遮罩 + {support} px"
        assert_outside_identical(planes, res.frame, F)
        assert not np.array_equal(planes.y[F], res.frame.y[F]), "作用範圍內應該要有東西變"
        # 輸入的平面不可以被就地改掉（render 會重送同一份解碼幀）
        assert np.array_equal(planes.y, _color.rgb8_to_yuv420(rgb, planes.matrix, planes.color_range).y)


def test_貼紙的作用範圍就是它的_alpha(tmp_path: Path) -> None:
    W, H = 97, 65
    t = _track(tmp_path, {0: _rect(W, H, 30, 20, 50, 40)}, W, H)
    img = _sticker_png(tmp_path, 24, 16, soft=True)
    pairs = [("*", (parse_effect({"type": "sticker", "image": img, "rotation": 17, "opacity": 0.8}),))]
    planes = _color.rgb8_to_yuv420(_noise(W, H, 5))
    res = apply_effects(planes, 0, {1: t.frame(0)}, pairs)
    F = res.footprint(W, H)
    assert res.changed and 0 < F.sum() < 24 * 16 * 1.5
    assert_outside_identical(planes, res.frame, F)


def test_media_的_Yuv420_原樣型別回來_rgb8_路徑也守住(tmp_path: Path) -> None:
    W, H = 64, 48
    t = _track(tmp_path, {0: _rect(W, H, 10, 10, 30, 30)}, W, H)
    rgb = _noise(W, H, 9)
    cp = _color.rgb8_to_yuv420(rgb)
    fr = MediaYuv(cp.y, cp.u, cp.v, src_idx=7, matrix="bt709", color_range="tv")
    pairs = [(1, (MosaicFx(),))]
    res = apply_effects(fr, 0, {1: t.frame(0)}, pairs)
    assert isinstance(res.frame, MediaYuv) and res.frame.src_idx == 7
    assert_outside_identical(fr, res.frame, res.footprint(W, H))
    res8 = apply_effects(rgb, 0, {1: t.frame(0)}, pairs)
    F = res8.footprint(W, H)
    assert np.array_equal(rgb[~F], res8.frame[~F]) and not np.array_equal(rgb[F], res8.frame[F])


def test_物件不在或特效是_no_op_時回傳同一個物件(tmp_path: Path) -> None:
    W, H = 32, 32
    t = _track(tmp_path, {0: None, 1: _rect(W, H, 4, 4, 12, 12)}, W, H)
    planes = _color.rgb8_to_yuv420(_noise(W, H))
    r0 = apply_effects(planes, 0, {1: t.frame(0)}, [(1, (MosaicFx(),))])
    assert r0.frame is planes and not r0.changed and r0.skipped == [(1, "absent")]
    r1 = apply_effects(planes, 1, {1: t.frame(1)}, [(1, (ColorFx(),))])  # 恆等調色
    assert r1.frame is planes and not r1.changed
    r2 = apply_effects(planes, 1, {1: t.frame(1)}, [(1, (MosaicFx(opacity=0.0),))])
    assert r2.frame is planes


def test_模糊不留光暈_背景顏色不會被吸進物件(tmp_path: Path) -> None:
    W, H = 64, 48
    rng = np.random.default_rng(1)
    rgb = np.zeros((H, W, 3), np.uint8)
    rgb[..., 2] = 255  # 藍背景
    obj = _rect(W, H, 20, 10, 44, 38)
    rgb[obj] = 0
    rgb[obj, 0] = rng.integers(120, 255, int(obj.sum()))  # 紅色、有紋理的物件（沒有藍）
    t = _track(tmp_path, {0: obj}, W, H)
    res = apply_effects(rgb, 0, {1: t.frame(0)}, [(1, (BlurFx(radius=6, footprint=Footprint("mask", 0.0, 0.0)),))])
    out = res.frame
    assert out[obj, 2].max() == 0, "物件裡出現藍色＝背景被模糊吸進來了（光暈）"
    assert out[obj, 0].std() < rgb[obj, 0].std() * 0.6, "紅色紋理應該被模糊掉"
    import cv2 as _cv

    naive = _cv.GaussianBlur(rgb, (13, 13), 0)
    assert naive[obj, 2].max() > 50, "對照：直覺寫法會滲色，這個測試才有意義"


def test_描邊畫在物件外面_物件內部不動(tmp_path: Path) -> None:
    W, H = 80, 60
    obj = _rect(W, H, 20, 15, 50, 45)
    t = _track(tmp_path, {0: obj}, W, H)
    planes = _color.rgb8_to_yuv420(_noise(W, H, 2))
    res = apply_effects(planes, 0, {1: t.frame(0)}, [(1, (parse_effect({"type": "outline", "width": 3, "smooth": 0}),))])
    F = res.footprint(W, H)
    inner = cv2.erode(obj.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    assert F.any() and not (F & inner).any()


# ---------------------------------------------------------------- 貼紙／文字的擺放
def _footprint_rect(F: np.ndarray) -> tuple[float, float, float, float, float]:
    """F 的 (中心 x, 中心 y, 長邊, 短邊, 長邊角度)，邊界座標。"""
    ys, xs = np.nonzero(F)
    pts = np.stack([xs, ys], 1).astype(np.float32)
    (cx, cy), (w, h), _a = cv2.minAreaRect(pts)
    from aivc.objects.anchors import long_side_angle

    return cx + 0.5, cy + 0.5, max(w, h) + 1, min(w, h) + 1, long_side_angle(pts)


def test_貼紙跟著重心走_寬度是外接框的倍數(tmp_path: Path) -> None:
    W, H = 120, 90
    t = _track(tmp_path, {0: _rect(W, H, 30, 20, 50, 40), 1: _rect(W, H, 60, 40, 80, 60)}, W, H)
    img = _sticker_png(tmp_path, 20, 10)
    e = parse_effect({"type": "sticker", "image": img, "anchor": "centroid", "width": 1.0, "smooth": False})
    for k, cx_expect, cy_expect in ((0, 40.0, 30.0), (1, 70.0, 50.0)):
        res = apply_effects(np.zeros((H, W, 3), np.uint8), k, {1: t.frame(k)}, [(1, (e,))])
        cx, cy, long_, short, _ang = _footprint_rect(res.footprint(W, H))
        assert abs(cx - cx_expect) <= 1.0 and abs(cy - cy_expect) <= 1.0
        assert abs(long_ - 20) <= 2 and abs(short - 10) <= 2


def test_貼紙跟著縮放與旋轉(tmp_path: Path) -> None:
    W, H = 160, 120
    m0 = _rotated(W, H, 60, 60, 40, 12, 0.0)
    m1 = _rotated(W, H, 90, 60, 80, 24, 30.0)  # 面積 ×4、轉 30°
    t = _track(tmp_path, {0: m0, 1: m1}, W, H)
    img = _sticker_png(tmp_path, 40, 6)
    e = parse_effect({"type": "sticker", "image": img, "anchor": "centroid", "width": 1.0, "followScale": True, "followRotation": True, "smooth": False})
    base = apply_effects(np.zeros((H, W, 3), np.uint8), 0, {1: t.frame(0)}, [(1, (e,))])
    after = apply_effects(np.zeros((H, W, 3), np.uint8), 1, {1: t.frame(1)}, [(1, (e,))])
    _, _, l0, _, a0 = _footprint_rect(base.footprint(W, H))
    cx1, cy1, l1, _, a1 = _footprint_rect(after.footprint(W, H))
    turn = t.anchor(1).angle - t.anchor(0).angle  # 量到的物件轉角（方向由 cv2.boxPoints 決定，大小是 30°）
    assert abs(abs(turn) - 30.0) < 2.0, turn
    assert abs(l1 / l0 - 2.0) < 0.15, (l0, l1)
    assert abs((a1 - a0) - turn) < 4.0, (a0, a1, turn)
    assert abs(cx1 - t.anchor(1).centroid[0]) < 2 and abs(cy1 - t.anchor(1).centroid[1]) < 2


def test_偏移以外接框為單位_帽子貼在頭頂(tmp_path: Path) -> None:
    W, H = 100, 100
    t = _track(tmp_path, {0: _rect(W, H, 40, 50, 60, 80)}, W, H)
    img = _sticker_png(tmp_path, 20, 8)
    e = parse_effect({"type": "sticker", "image": img, "anchor": "top", "pivot": "bottom", "offset": [0, -0.1], "smooth": False})
    res = apply_effects(np.zeros((H, W, 3), np.uint8), 0, {1: t.frame(0)}, [(1, (e,))])
    ys, xs = np.nonzero(res.footprint(W, H))
    assert abs((ys.max() + 1) - (50 - 3)) <= 1  # 底邊在框頂往上 0.1×30＝3 px
    assert abs(xs.mean() + 0.5 - 50) <= 1


def test_文字標籤在物件上方(tmp_path: Path) -> None:
    W, H = 200, 160
    t = _track(tmp_path, {0: _rect(W, H, 70, 80, 130, 140)}, W, H)
    e = parse_effect({"type": "text", "text": "AB", "size": 20, "sizeUnits": "px", "background": "#000000A0"})
    assert isinstance(e, TextFx)
    res = apply_effects(_noise(W, H), 0, {1: t.frame(0)}, [(1, (e,))])
    ys, xs = np.nonzero(res.footprint(W, H))
    assert res.changed and ys.max() + 1 <= 80 and ys.max() + 1 >= 80 - 6
    assert abs((xs.min() + xs.max() + 1) / 2 - 100) <= 2


def test_followRotation_smooth_false_跨過正負90不翻面(tmp_path: Path) -> None:
    """回歸：smooth:false 時 heading 以前回 (-90, 90] 的原值，同一段裡從 85° 轉到 95°（原值 84.7 → -84.7）
    角度差變成 -169°，貼紙整個翻過去、帽子跑到物件下面。"""
    from aivc.fx.overlay import placement

    W, H = 240, 240
    angs = [80, 84, 88, 92, 96, 100]
    t = _track(tmp_path, {k: _rotated(W, H, 120, 120, 120, 16, a) for k, a in enumerate(angs)}, W, H)
    assert t.anchor(5).run == 0 and t.anchor(0).angle > 60 and t.anchor(5).angle < -60
    e = StickerFx(image="x.png", anchor="top", pivot="bottom", offset=(0.0, -0.1), follow_rotation=True, smooth=False)
    for k in range(6):
        pl = placement(t.frame(k), e)
        assert pl is not None
        true_turn = t.anchor(k).angle_cont - t.anchor(0).angle_cont
        assert abs(pl.rotation - true_turn) < 1e-6 and abs(pl.rotation) < 25, (k, pl.rotation)
    e_s = StickerFx(image="x.png", follow_rotation=True, smooth=True)
    assert abs(placement(t.frame(5), e_s).rotation) < 25  # type: ignore[union-attr]


def test_平滑的_box_ellipse_範圍一定蓋住原始物件(tmp_path: Path) -> None:
    """回歸（隱私）：box／ellipse 只用平滑後的框，物件抖動或急停時 SG 跟不上，真的物件有一截露在範圍外、原圖照出。
    現在＝平滑框的形狀 ∪ 這一幀原始框的形狀：平滑只會讓範圍變大。"""
    W, H = 320, 200
    rng = np.random.default_rng(7)
    masks: dict[int, np.ndarray] = {}
    for k in range(40):  # ±8 px 手持晃動
        dx, dy = (int(v) for v in rng.integers(-8, 9, 2))
        masks[k] = _rect(W, H, 120 + dx, 60 + dy, 180 + dx, 140 + dy)
    for k in range(40, 52):  # 40 px/幀橫移後急停
        x = 20 + 40 * min(k - 40, 6)
        masks[k] = _rect(W, H, x, 60, x + 60, 140)
    t = _track(tmp_path, masks, W, H)
    for shape in ("box", "ellipse"):
        fp = Footprint(shape, 6.0 if shape == "ellipse" else 4.0, 1.0, True)
        worst = 0
        for k in masks:
            fr = t.frame(k)
            obj = fr.mask
            if shape == "ellipse":  # 橢圓本來就不包長方形的四角：拿內切橢圓形的物件來量
                bx, by, bw, bh = fr.anchor.bbox
                yy, xx = np.mgrid[0:H, 0:W] + 0.5
                obj = obj & ((((xx - (bx + bw / 2)) / (bw / 2)) ** 2 + ((yy - (by + bh / 2)) / (bh / 2)) ** 2) <= 1.0)
            reg = footprint_region(fr, fp, W, H)
            full = np.zeros((H, W), bool)
            full[reg.y0 : reg.y1, reg.x0 : reg.x1] = reg.alpha > 0
            worst = max(worst, int((obj & ~full).sum()))
        assert worst == 0, (shape, worst)
    # 端到端：打碼後物件內的每一個 Y 都要被動到（不能有原圖露出來）
    rgb = _noise(W, H, 4)
    e = parse_effect({"type": "mosaic", "shape": "box", "block": 8})
    k = 46  # 急停那一幀
    res = apply_effects(rgb, k, {1: t.frame(k)}, [(1, (e,))])
    F = res.footprint(W, H)
    assert not (masks[k] & ~F).any()


def test_多個物件分組轉換_結果與一個大_ROI_相同_只算有用的區域(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """回歸（效能）：以前所有工作的讀取範圍取一個外接框，兩個在對角的小物件＝整張畫面轉線性光（1080p 2 ms → 271 ms）。"""
    W, H = 320, 180
    a = _rect(W, H, 10, 10, 40, 40)
    b = _rect(W, H, 270, 130, 300, 165)
    ta = _track(tmp_path, {0: a}, W, H, "a")
    tb = _track(tmp_path, {0: b}, W, H, "b")
    planes = _color.rgb8_to_yuv420(_noise(W, H, 11))
    stack = (parse_effect({"type": "mosaic"}), parse_effect({"type": "outline", "width": 3}))
    areas: list[int] = []
    real = _color.yuv420_to_linear

    def spy(p: object, roi: object = None, **kw: object) -> np.ndarray:
        x0, y0, x1, y1 = roi  # type: ignore[misc]
        areas.append((x1 - x0) * (y1 - y0))
        return real(p, roi, **kw)  # type: ignore[arg-type]

    monkeypatch.setattr(_color, "yuv420_to_linear", spy)
    both = apply_effects(planes, 0, {1: ta.frame(0), 2: tb.frame(0)}, [("*", stack)])
    assert len(areas) == 2 and sum(areas) < 0.15 * W * H, areas
    one = apply_effects(planes, 0, {1: ta.frame(0)}, [(1, stack)])
    seq = apply_effects(one.frame, 0, {2: tb.frame(0)}, [(2, stack)])
    for name in ("y", "u", "v"):
        assert np.array_equal(getattr(both.frame, name), getattr(seq.frame, name)), name
    assert both.footprint_px == one.footprint_px + seq.footprint_px
    assert np.array_equal(both.footprint(W, H), one.footprint(W, H) | seq.footprint(W, H))
    rgb = _noise(W, H, 12)
    r8 = apply_effects(rgb, 0, {1: ta.frame(0), 2: tb.frame(0)}, [("*", stack)])
    r8b = apply_effects(apply_effects(rgb, 0, {1: ta.frame(0)}, [(1, stack)]).frame, 0, {2: tb.frame(0)}, [(2, stack)])
    assert np.array_equal(r8.frame, r8b.frame)
    from aivc.fx.apply import group_jobs

    # 外接框合併後碰到第三塊也要併進來
    # A 與 C 本身不相交，但 A∪B 的外接框碰到 C
    g = group_jobs([(0, 0, 10, 10), (14, 0, 20, 4), (8, 8, 16, 16), (100, 100, 110, 110)], 200, 200)
    assert [m for _r, m in g] == [[0, 1, 2], [3]] and g[0][0] == (0, 0, 20, 16)


def test_描邊碰到畫面邊_不會沿著畫面邊畫一條實心的線(tmp_path: Path) -> None:
    """回歸：視窗被畫面邊切掉，findContours 把視窗邊當成物件邊界 → 走進／走出畫面的物件每幀都有一條貼邊的實心線。"""
    W, H = 160, 120
    obj = _rect(W, H, 0, 30, 50, 90)
    t = _track(tmp_path, {0: obj}, W, H)
    res = apply_effects(np.full((H, W, 3), 90, np.uint8), 0, {1: t.frame(0)}, [(1, (parse_effect({"type": "outline", "width": 12, "color": "#FF0000"}),))])
    F = res.footprint(W, H)
    inner = cv2.erode(obj.astype(np.uint8), np.ones((5, 5), np.uint8), borderType=cv2.BORDER_REPLICATE).astype(bool)
    assert F.any() and not (F & inner).any(), int((F & inner).sum())
    assert F[:, 50:].any(), "真正的邊界照樣描"
    # 框線（box）貼畫面邊時畫在邊上是對的（那就是看得到的框）：不受影響
    rb = apply_effects(np.full((H, W, 3), 90, np.uint8), 0, {1: t.frame(0)}, [(1, (parse_effect({"type": "outline", "mode": "box", "width": 4}),))])
    assert rb.footprint(W, H)[40:80, 0].any()


def test_馬賽克格子大小整段一起算_抖動不會逐幀換格(tmp_path: Path) -> None:
    """回歸：block auto 逐幀 round(短邊 ÷ 10)；靜止的 75 px 臉、遮罩 ±1 px 抖動 → 7、8 px 來回跳，整片馬賽克逐幀重切。"""
    from aivc.fx.apply import plan_effect

    W, H = 200, 160
    rng = np.random.default_rng(1)
    masks = {}
    for k in range(60):
        j = rng.integers(-1, 2, 4)
        masks[k] = _rect(W, H, 60 + int(j[0]), 40 + int(j[1]), 135 + int(j[2]), 134 + int(j[3]))  # 75×94
    t = _track(tmp_path, masks, W, H)
    for align in ("frame", "object"):
        e = MosaicFx(align=align)
        jobs = [plan_effect(e, t.frame(k), W, H, []) for k in range(60)]
        blocks = {j.block for j in jobs}  # type: ignore[union-attr]
        grids = {j.grid for j in jobs}  # type: ignore[union-attr]
        assert len(blocks) == 1, blocks
        assert len(grids) == 1, (align, grids)
        # 逐幀算的舊行為確實會跳（這個測試才有意義）
        per_frame = {E.mosaic_block("auto", 10.0, 4, t.anchor(k).box(True)) for k in range(60)}
        assert len(per_frame) > 1
    # 慢慢放大的物件照樣換格（遲滯不是凍結）
    grow = {k: _rect(W, H, 20, 20, 20 + 40 + 2 * k, 20 + 40 + 2 * k) for k in range(40)}
    tg = _track(tmp_path, grow, W, H, "grow")
    bs = [plan_effect(MosaicFx(), tg.frame(k), W, H, []).block for k in range(40)]  # type: ignore[union-attr]
    assert bs[0] == 4 and bs[-1] >= 11 and all(b2 >= b1 for b1, b2 in zip(bs, bs[1:]))


def test_光暈與羽化_靠近畫面邊不會被鏡射加倍(tmp_path: Path) -> None:
    """回歸：GaussianBlur 預設 BORDER_REFLECT_101，視窗被畫面邊切掉時物件被鏡射成畫面外的幻影，貼邊亮一倍。"""
    from aivc.fx.apply import plan_effect

    H = 120
    near = _rect(200, H, 6, 40, 46, 80)
    wide = _rect(300, H, 106, 40, 146, 80)
    tn = _track(tmp_path, {0: near}, 200, H, "n")
    tw = _track(tmp_path, {0: wide}, 300, H, "w")
    g = parse_effect({"type": "glow", "radius": 30})
    jn = plan_effect(g, tn.frame(0), 200, H, [])
    jw = plan_effect(g, tw.frame(0), 300, H, [])
    an = jn.alpha[60 - jn.read[1], 0 - jn.read[0]]  # type: ignore[union-attr]
    aw = jw.alpha[60 - jw.read[1], 100 - jw.read[0]]  # type: ignore[union-attr]
    assert an == pytest.approx(aw, abs=1e-4), (an, aw)
    fp = Footprint("mask", 0.0, 8.0)
    tn2 = _track(tmp_path, {0: _rect(200, H, 2, 40, 42, 80)}, 200, H, "n2")
    tw2 = _track(tmp_path, {0: _rect(300, H, 102, 40, 142, 80)}, 300, H, "w2")
    rn = footprint_region(tn2.frame(0), fp, 200, H)
    rw = footprint_region(tw2.frame(0), fp, 300, H)
    assert rn.alpha[60 - rn.y0, 0 - rn.x0] == pytest.approx(rw.alpha[60 - rw.y0, 100 - rw.x0], abs=1e-4)  # type: ignore[union-attr]


def test_放大的貼紙_雙線性的邊不被視窗切掉() -> None:
    """回歸：視窗只比來源四角多 1 px，放大 3 倍以上時雙線性暈開的 0.5·z px 被硬切成一道台階。"""
    from aivc.fx.overlay import warp_rgba

    src = np.ones((10, 10, 4), np.float32)
    for rot in (0.0, 30.0):
        x0, y0, out = warp_rgba(src, (200.0, 150.0), (0.5, 0.5), 80.0, rot, 400, 300)  # type: ignore[misc]
        t = math.radians(rot)
        c, s = math.cos(t), math.sin(t)
        z = 8.0
        A_ = np.array([[c * z, -s * z], [s * z, c * z]])
        tvec = np.array([200.0, 150.0]) + A_ @ (np.array([0.5, 0.5]) - np.array([5.0, 5.0])) - 0.5
        full = cv2.warpAffine(src, np.hstack([A_, tvec[:, None]]), (400, 300), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
        inside = np.zeros((300, 400), bool)
        inside[y0 : y0 + out.shape[0], x0 : x0 + out.shape[1]] = True
        assert full[..., 3][~inside].max() == 0.0, (rot, float(full[..., 3][~inside].max()))
        # warpAffine 的定點內插（1/32）在不同原點下取整略有不同：容許 1/32
        assert np.allclose(full[y0 : y0 + out.shape[0], x0 : x0 + out.shape[1], 3], out[..., 3], atol=1 / 32 + 1e-6)


def test_描邊與光暈_顏色的_alpha_有作用(tmp_path: Path) -> None:
    """回歸：#RRGGBBAA 的 A 文件說可以用，但描邊／光暈以前默默丟掉（#FF000000 照樣畫實心紅線）。"""
    W, H = 128, 96
    t = _track(tmp_path, {0: _rect(W, H, 40, 30, 80, 70)}, W, H)
    bg = np.full((H, W, 3), 40, np.uint8)
    for base in ({"type": "outline", "width": 3}, {"type": "glow", "radius": 6, "intensity": 2}):
        full = apply_effects(bg, 0, {1: t.frame(0)}, [(1, (parse_effect({**base, "color": "#FF0000"}),))]).frame
        quarter = apply_effects(bg, 0, {1: t.frame(0)}, [(1, (parse_effect({**base, "color": "#FF000040"}),))]).frame
        none = apply_effects(bg, 0, {1: t.frame(0)}, [(1, (parse_effect({**base, "color": "#FF000000"}),))])
        assert int(quarter[..., 0].max()) < int(full[..., 0].max()), base
        assert none.changed is False and none.frame is bg, base


def test_特效檔裡的相對路徑相對特效檔所在的資料夾(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """回歸：masks／image／fontFile 的相對路徑以前一律相對目前目錄 —— sidecar 的目前目錄是 App 的工作目錄，存成檔案的特效設定永遠找不到。"""
    proj = tmp_path / "proj"
    (proj / "find" / "obj1").mkdir(parents=True)
    (proj / "find" / "obj1" / "masks.aivm").write_bytes(b"x")
    (proj / "hat.png").write_bytes(b"x")
    (proj / "font.ttf").write_bytes(b"x")
    doc = {"stacks": [{"masks": "find/obj1/masks.aivm", "effects": [
        {"type": "sticker", "image": "hat.png"}, {"type": "text", "text": "A", "fontFile": "font.ttf"},
    ]}, {"object": "*", "effects": [{"type": "sticker", "image": "D:/絕對/路徑.png"}]}]}
    (proj / "stack.json").write_text(json.dumps(doc), encoding="utf-8")
    elsewhere = tmp_path / "else"
    elsewhere.mkdir()
    monkeypatch.chdir(elsewhere)
    st = load_stack(str(proj / "stack.json"))
    assert Path(st[0].target) == proj / "find" / "obj1" / "masks.aivm"  # type: ignore[arg-type]
    assert Path(st[0].effects[0].image) == proj / "hat.png"  # type: ignore[union-attr]
    assert Path(st[0].effects[1].font_file) == proj / "font.ttf"  # type: ignore[union-attr]
    assert st[1].target == "*" and st[1].effects[0].image == "D:/絕對/路徑.png"  # type: ignore[union-attr]
    # 特效檔旁邊沒有、目前目錄有 → 照舊用目前目錄（find.v1.json 記的相對路徑就是這個語意）
    (elsewhere / "only_here.png").write_bytes(b"x")
    (proj / "s2.json").write_text(json.dumps([{"type": "sticker", "image": "only_here.png"}]), encoding="utf-8")
    assert load_stack(str(proj / "s2.json"))[0].effects[0].image == "only_here.png"  # type: ignore[union-attr]
    # 直接給 JSON 字串：維持目前目錄的語意（不改寫）
    assert load_stack(json.dumps(doc))[0].target == "find/obj1/masks.aivm"


def test_followRotation_跨段時用折回的角度差(tmp_path: Path) -> None:
    """物件消失又出現：兩段的連續角度各自展開，跨段只能比較折回 (-90, 90] 的值。"""
    W, H = 120, 120
    t = _track(tmp_path, {0: _rotated(W, H, 60, 60, 50, 10, 10.0), 1: None, 2: _rotated(W, H, 60, 60, 50, 10, 40.0)}, W, H)
    assert t.anchor(0).run == 0 and t.anchor(2).run == 1
    img = _sticker_png(tmp_path, 40, 6)
    e = StickerFx(image=img, anchor="centroid", follow_rotation=True, smooth=False)
    from aivc.objects.anchors import wrap180

    res = apply_effects(np.zeros((H, W, 3), np.uint8), 2, {1: t.frame(2)}, [(1, (e,))])
    _, _, _, _, ang = _footprint_rect(res.footprint(W, H))
    turn = wrap180(t.anchor(2).angle - t.anchor(0).angle)
    assert math.isfinite(ang) and abs(abs(turn) - 30.0) < 2.0
    assert abs(wrap180(ang - turn)) < 4.0, (ang, turn)
