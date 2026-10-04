"""ObjectTrack（aivc/objects）：逐幀錨點的定義、不跨缺口的平滑、角度展開、快取，以及三種匯出格式的來回。

座標與欄位的定義是資料契約（docs/tracking-api.md），這裡的數字都是照那份文件的定義手算的。
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

from aivc.objects import anchors as A  # noqa: E402
from aivc.objects import export as X  # noqa: E402
from aivc.objects.track import ObjectTrack  # noqa: E402
from aivc.seg.maskfile import MaskFile  # noqa: E402

W, H = 80, 60


def _rect(x0: int, y0: int, x1: int, y1: int) -> np.ndarray:
    m = np.zeros((H, W), bool)
    m[y0:y1, x0:x1] = True
    return m


def _rot(cx: float, cy: float, w: float, h: float, deg: float) -> np.ndarray:
    pts = cv2.boxPoints(((cx, cy), (w, h), deg)).astype(np.int32)
    m = np.zeros((H, W), np.uint8)
    cv2.fillPoly(m, [pts], 1)
    return m.astype(bool)


def _write(tmp_path: Path, frames: dict[int, Any], name: str = "obj1") -> Path:
    p = tmp_path / name / "masks.aivm"
    MaskFile.write(p, W, H, frames.items())
    return p


# ---------------------------------------------------------------- 量測
class TestMeasure:
    def test_單一像素_框與重心是邊界座標(self) -> None:
        m = np.zeros((H, W), bool)
        m[20, 10] = True
        area, bbox, cen, ang = A.measure(m)  # type: ignore[misc]
        assert area == 1 and bbox == (10.0, 20.0, 1.0, 1.0) and cen == (10.5, 20.5) and ang == 0.0

    def test_長方形的方向角是長邊(self) -> None:
        assert A.measure(_rect(10, 10, 50, 20))[3] == pytest.approx(0.0, abs=1e-6)  # type: ignore[index]
        assert abs(A.measure(_rect(10, 5, 20, 55))[3]) == pytest.approx(90.0, abs=1e-6)  # type: ignore[index]
        a = A.measure(_rot(40, 30, 50, 10, 30.0))[3]  # type: ignore[index]
        assert abs(abs(a) - 30.0) < 2.0

    def test_wrap180(self) -> None:
        assert A.wrap180(90.0) == 90.0 and A.wrap180(-90.0) == 90.0 and A.wrap180(91.0) == -89.0 and A.wrap180(-181.0) == -1.0

    def test_空遮罩(self) -> None:
        assert A.measure(np.zeros((H, W), bool)) is None


# ---------------------------------------------------------------- 錨點與平滑
def test_缺口把可見分成兩段_平滑不跨段(tmp_path: Path) -> None:
    rng = np.random.default_rng(0)
    frames: dict[int, Any] = {}
    for k in range(0, 10):  # 第一段：x 在 10 附近抖
        x = 10 + int(rng.integers(-1, 2))
        frames[k] = _rect(x, 10, x + 10, 20)
    frames[10] = None  # 物件不在
    frames[11] = np.zeros((H, W), bool)  # 空遮罩也算不在
    for k in range(12, 20):  # 第二段：x 固定在 50
        frames[k] = _rect(50, 30, 60, 40)
    t = ObjectTrack.open(_write(tmp_path, frames))
    an = t.anchors
    assert an.visible_ranges() == [(0, 9), (12, 19)]
    assert an.at(10).visible is False and an.at(10).computed is True and an.at(5).run == 0 and an.at(15).run == 1
    # 第二段完全靜止 → 平滑後仍然精確 55（第一段的 10 不會被平均進來）
    for k in range(12, 20):
        assert an.at(k).smooth.centroid[0] == pytest.approx(55.0, abs=1e-6)
    # 第一段的抖動被平滑壓低
    raw = np.array([an.at(k).centroid[0] for k in range(10)])
    sm = np.array([an.at(k).smooth.centroid[0] for k in range(10)])
    assert np.std(np.diff(sm)) < np.std(np.diff(raw))
    # iter_all：中間沒有條目的幀給 computed=false
    frames2 = {0: _rect(1, 1, 5, 5), 3: _rect(1, 1, 5, 5)}
    t2 = ObjectTrack.open(_write(tmp_path, frames2, "obj2"))
    allf = list(t2.anchors.iter_all())
    assert [a.k for a in allf] == [0, 1, 2, 3] and [a.computed for a in allf] == [True, False, False, True]
    assert t2.anchors.visible_ranges() == [(0, 0), (3, 3)]


def test_角度在段內展開_跨過正負90不跳(tmp_path: Path) -> None:
    angs = [70, 78, 86, 94, 102, 110, 118]  # 94° 以後折回是 -86、-78…
    frames = {k: _rot(40, 30, 50, 8, a) for k, a in enumerate(angs)}
    t = ObjectTrack.open(_write(tmp_path, frames))
    raw = [t.anchor(k).angle for k in range(len(angs))]
    assert max(raw) <= 90 and min(raw) < -60, "折回後應該有負角度"
    cont = [t.anchor(k).smooth.angle_cont for k in range(len(angs))]
    d = np.diff(cont)
    assert np.all(np.abs(d) < 20), cont
    assert abs((cont[-1] - cont[0]) - (angs[-1] - angs[0])) < 6 or abs((cont[0] - cont[-1]) - (angs[-1] - angs[0])) < 6
    assert all(-90 < t.anchor(k).smooth.angle <= 90 for k in range(len(angs)))


def test_近正方形的長邊換邊不算轉動(tmp_path: Path) -> None:
    """實測（145×151 的臉）：minAreaRect 的長邊在 0° 與 90° 之間來回跳。只用 180° 週期展開的話，
    平滑後會出現 65° 這種兩個跳動平均出來的假角度。近正方形改用 90° 週期：連續角度維持不動。"""
    frames = {k: (_rect(20, 20, 41, 40) if k % 2 else _rect(20, 20, 40, 41)) for k in range(9)}  # 21×20 與 20×21 交替
    t = ObjectTrack.open(_write(tmp_path, frames))
    raw = {round(abs(t.anchor(k).angle)) for k in range(9)}
    assert raw == {0, 90}, "量測本身確實在兩個方向間跳"
    assert all(t.anchor(k).elongation < A.NEAR_SQUARE for k in range(9))
    conts = [t.anchor(k).smooth.angle_cont for k in range(9)]
    assert max(conts) - min(conts) < 1.0, conts
    # 連續轉動照樣跟得上（跨過 ±90° 不跳）；量測換邊的 90° 跳動被吃掉
    assert list(A.continuous_angles([80.0, -85.0, -80.0])) == pytest.approx([80.0, 95.0, 100.0])
    assert list(A.continuous_angles([0.0, 90.0, 2.0])) == pytest.approx([0.0, 0.0, 2.0])
    # 實測情境：長短邊比在門檻上下來回時，也不能灌進假跳動（以前依長短邊比切換週期會在這裡跳 72°）
    assert list(A.continuous_angles([90.0, 11.0, 7.0, 1.0, 2.0])) == pytest.approx([90.0, 101.0, 97.0, 91.0, 92.0])


def test_平滑後的框_window_0_就是原值(tmp_path: Path) -> None:
    frames = {k: _rect(10 + k, 10, 20 + k, 20) for k in range(6)}
    p = _write(tmp_path, frames)
    t = ObjectTrack.open(p, window=0, cache=False)
    for k in range(6):
        a = t.anchor(k)
        assert a.smooth.bbox == pytest.approx(a.bbox) and a.smooth.centroid == pytest.approx(a.centroid)


def test_快取_命中_與遮罩一改就重算(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = _write(tmp_path, {k: _rect(10, 10, 20 + k, 20) for k in range(5)})
    t1 = ObjectTrack.open(p)
    cp = A.cache_path(p)
    assert cp.name == "anchors.v1.json" and cp.is_file() and t1.cache_hit is False
    t2 = ObjectTrack.open(p)
    assert t2.cache_hit is True and t2.anchor(3).bbox == t1.anchor(3).bbox
    assert A.cache_path(tmp_path / "x" / "朋友.aivm").name == "朋友.anchors.v1.json"
    MaskFile.write(p, W, H, {k: _rect(30, 30, 40, 40) for k in range(5)}.items())  # 內容變了
    t3 = ObjectTrack.open(p)
    assert t3.cache_hit is False and t3.anchor(0).bbox == (30.0, 30.0, 10.0, 10.0)
    t4 = ObjectTrack.open(p, window=5)  # 平滑參數不同也要重算
    assert t4.cache_hit is False
    cp.write_text("{壞掉", encoding="utf-8")
    assert ObjectTrack.open(p, window=5).cache_hit is False


def test_快取鍵與解析的是同一份位元組_中途被換掉也不會存錯(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """回歸：以前 MaskFile.open 讀一次（解析）、atomic.read_bytes 再讀一次（雜湊）。中間別的行程換掉檔案時，
    舊遮罩算出的錨點會存在新檔的雜湊底下，之後每次開新檔都命中這份錯的快取（打碼位置錯）。"""
    from aivc import atomic

    p = _write(tmp_path, {k: _rect(5, 5, 15, 15) for k in range(4)})
    real = atomic.read_bytes
    swapped = {"done": False}

    def racy(path: Any, *a: Any, **kw: Any) -> bytes:
        if Path(path) == p and not swapped["done"]:
            swapped["done"] = True
            MaskFile.write(p, W, H, {k: _rect(50, 30, 70, 50) for k in range(4)}.items())  # 另一個行程剛好在這時寫完
        return real(path, *a, **kw)

    monkeypatch.setattr(atomic, "read_bytes", racy)
    t1 = ObjectTrack.open(p)
    assert t1.anchor(0).bbox == (50.0, 30.0, 20.0, 20.0) and t1.mask(0)[40, 60], "遮罩與錨點來自同一份內容"
    t2 = ObjectTrack.open(p)
    assert t2.cache_hit is True and t2.anchor(0).bbox == (50.0, 30.0, 20.0, 20.0)
    with pytest.raises(ValueError):
        A.load_or_compute(p, mask_file=MaskFile.open(p))  # 給了已解析的檔就要給那份位元組


def test_偶數視窗改成奇數_平滑值不偏半幀(tmp_path: Path) -> None:
    """回歸：window 8 的 SG 在兩個樣本中間求值，20 px/幀的物件平滑後整段超前 10 px、段頭段尾又不偏（框跳一下）。"""
    from aivc.geom.smoothing import STATE_TRACKING, smooth_sequence

    frames = {k: _rect(2 + 2 * k, 10, 12 + 2 * k, 20) for k in range(30)}
    p = _write(tmp_path, frames)
    for w in (8, 6, 4):
        t = ObjectTrack.open(p, window=w, cache=False)
        assert t.anchors.window == w - 1
        for k in range(30):
            a = t.anchor(k)
            assert a.smooth.centroid[0] == pytest.approx(a.centroid[0], abs=1e-6), (w, k)
            assert a.smooth.bbox[0] == pytest.approx(a.bbox[0], abs=1e-6), (w, k)
    assert A.effective_window(0) == 0 and A.effective_window(-3) == 0 and A.effective_window(9) == 9 and A.effective_window(2) == 1
    # geom.smoothing 同一條規則：等速平移的單應矩陣，偶數視窗也要原樣通過
    Hs = [np.array([[1, 0, 20.0 * k], [0, 1, 0], [0, 0, 1]]) for k in range(20)]
    out = smooth_sequence(list(range(20)), Hs, [STATE_TRACKING] * 20, window=8)
    assert all(float(o[0, 2]) == pytest.approx(20.0 * k, abs=1e-6) for k, o in enumerate(out))


def test_沒命中與命中快取回同一份數字(tmp_path: Path) -> None:
    """回歸：沒命中回全精度、命中回四捨五入過的 → 第一次 fx／fx-preview 與之後的輸出差幾個像素。"""
    rng = np.random.default_rng(3)
    frames = {}
    for k in range(40):
        cx, cy = 40 + rng.uniform(-3, 3), 30 + rng.uniform(-3, 3)
        frames[k] = _rot(cx, cy, 30 + rng.uniform(-2, 2), 12, 20 + rng.uniform(-5, 5))
    p = _write(tmp_path, frames)
    cold = ObjectTrack.open(p)
    warm = ObjectTrack.open(p)
    assert cold.cache_hit is False and warm.cache_hit is True
    assert cold.anchors.to_json() == warm.anchors.to_json()
    for k in range(40):
        a, b = cold.anchor(k), warm.anchor(k)
        assert a.smooth == b.smooth and a.bbox == b.bbox and a.centroid == b.centroid and a.angle_cont == b.angle_cont, k
    assert ObjectTrack.open(p, cache=False).anchors.to_json()["frames"] == warm.anchors.to_json()["frames"]


def test_細長物件短暫變方之後_展開角回到長邊(tmp_path: Path) -> None:
    """回歸：80×16 的長條 → 近正方形量到 14/30/45/54° → 又是同一根水平長條。只用 90° 週期展開時，
    angleCont 停在 90（短邊），之後 smooth.angle 一直是 90°，跟著旋轉的貼紙轉了 ~86°。"""
    frames: dict[int, Any] = {k: _rect(0, 22, 80, 38) for k in range(6)}
    for i, a in enumerate((14, 30, 45, 54)):
        frames[6 + i] = _rot(40, 30, 34, 30, a)
    frames.update({k: _rect(0, 22, 80, 38) for k in range(10, 20)})
    t = ObjectTrack.open(_write(tmp_path, frames), cache=False)
    for k in range(14, 20):
        a = t.anchor(k)
        assert a.elongation > 4 and abs(a.angle) < 1e-6
        assert abs(a.smooth.angle) < 2.0, (k, a.smooth.angle)
        assert abs(A.wrap180(a.angle_cont)) < 1e-6
    # 近正方形照舊用 90° 週期（臉的長短邊比 1.01–1.38，不切換規則）
    assert list(A.continuous_angles([0.0, 90.0, 2.0], [1.05, 1.1, 1.2])) == pytest.approx([0.0, 0.0, 2.0])
    # 細長的幀只能是長邊：近正方形一路飄到 54° 之後回到細長的 0°，是轉回 -54°（不是 90° 規則的 +36° → 90）
    seq = [0.0, 14.0, 30.0, 45.0, 54.0, 0.0]
    assert list(A.continuous_angles(seq, [4.0, 1.1, 1.1, 1.1, 1.1, 4.0])) == pytest.approx(seq)
    assert A.continuous_angles(seq)[-1] == pytest.approx(90.0), "沒給長短邊比＝舊規則（只為了對照）"


def test_未平滑的展開角_跨過正負90不跳(tmp_path: Path) -> None:
    """回歸：heading(smoothed=False, continuous=True) 以前忽略 continuous、回 (-90, 90] 的原值。"""
    angs = [80, 84, 88, 92, 96, 100]
    t = ObjectTrack.open(_write(tmp_path, {k: _rot(40, 30, 60, 8, a) for k, a in enumerate(angs)}), cache=False)
    raw = [t.anchor(k).heading(False) for k in range(6)]
    cont = [t.anchor(k).heading(False, continuous=True) for k in range(6)]
    assert min(raw) < -60 and max(raw) > 60, "原值有折回"
    assert np.all(np.abs(np.diff(cont)) < 10), cont
    assert cont[0] == raw[0] and all(t.anchor(k).has_continuous_heading(False) for k in range(6))


def test_直線遮罩的長短邊比是有限值() -> None:
    """回歸：1 px 寬的直線只有兩個輪廓點 → 以前 elongation=inf（JSON 寫 null、CSV 空白、快取命中後變 None）。"""
    m = np.zeros((H, W), bool)
    m[50, 10:60] = True
    _area, _bbox, _cen, ang, elong = A.measure_full(m)  # type: ignore[misc]
    assert ang == 0.0 and elong == pytest.approx(50.0) and math.isfinite(elong)
    v = np.zeros((H, W), bool)
    v[5:45, 79] = True  # 剛離開畫面右邊、只剩一欄
    assert A.measure_full(v)[4] == pytest.approx(40.0)  # type: ignore[index]
    two = np.zeros((H, W), bool)
    two[3, 3:5] = True
    assert A.measure_full(two)[4] == pytest.approx(2.0)  # type: ignore[index]


class _CancelCtx:
    def __init__(self, cancel_after: int | None = None) -> None:
        self.events: list[tuple[str, int, int]] = []
        self.checks = 0
        self.cancel_after = cancel_after

    def progress(self, stage: str, done: int, total: int, **k: Any) -> None:
        self.events.append((stage, int(done), int(total)))

    def check_cancel(self) -> None:
        from aivc.ops import Canceled

        self.checks += 1
        if self.cancel_after is not None and self.checks > self.cancel_after:
            raise Canceled()


def test_算錨點與匯出_png_有進度可取消(tmp_path: Path) -> None:
    """回歸：長軌跡第一次開要算好幾分鐘，以前整段沒有進度事件、也不檢查取消（主 lane 被占住）。"""
    from aivc.ops import Canceled

    p = _write(tmp_path, {k: _rect(10, 10, 20, 20) for k in range(100)})
    ctx = _CancelCtx()
    t = ObjectTrack.open(p, ctx=ctx, cache=False)
    st = [e for e in ctx.events if e[0] == A.STAGE]
    assert st[0][1] == 0 and st[-1][1] == st[-1][2] == 100 and len(st) >= 4 and ctx.checks >= 3
    with pytest.raises(Canceled):
        ObjectTrack.open(p, ctx=_CancelCtx(cancel_after=1), cache=False)
    assert not A.cache_path(p).exists(), "取消了就不寫快取"
    ctx2 = _CancelCtx()
    X.write_png_sequence(tmp_path / "png", t, ctx=ctx2)
    assert [e for e in ctx2.events if e[0] == "objects.export"][-1][1:] == (100, 100)
    with pytest.raises(Canceled):
        X.write_png_sequence(tmp_path / "png2", t, ctx=_CancelCtx(cancel_after=5))


def test_ObjectFrame_與參考錨點(tmp_path: Path) -> None:
    t = ObjectTrack.open(_write(tmp_path, {0: None, 1: _rect(5, 5, 15, 15), 2: _rect(6, 6, 16, 16)}))
    f0, f2 = t.frame(0), t.frame(2)
    assert f0.visible is False and f0.mask is None
    assert f2.visible and f2.mask is not None and f2.reference is not None and f2.reference.k == 1
    assert f2.lookup is not None and f2.lookup(2) is t.anchor(2)


# ---------------------------------------------------------------- 匯出來回
def _sample_track(tmp_path: Path) -> ObjectTrack:
    frames: dict[int, Any] = {k: _rot(20 + 2 * k, 30, 30, 10, 5.0 * k) for k in range(0, 8)}
    frames[8] = None
    frames.update({k: _rect(40, 20, 55, 35) for k in range(10, 13)})  # k=9 沒有條目
    return ObjectTrack.open(_write(tmp_path, frames))


def test_json_來回(tmp_path: Path) -> None:
    t = _sample_track(tmp_path)
    vi = X.VideoInfo("片.mp4", W, H, (30000, 1001), 200)
    out = tmp_path / "匯出" / "track.json"
    X.write_json(out, X.track_json(t, vi))
    d = X.read_json(out)
    assert d["format"] == "aivc.objecttrack.v1" and d["video"] == {"path": "片.mp4", "width": W, "height": H, "fps": [30000, 1001], "frames": 200}
    assert [f["k"] for f in d["frames"]] == list(range(0, 13)) and d["frames"][9]["computed"] is False
    assert d["visibleRanges"] == [[0, 7], [10, 12]]
    assert d["frames"][3]["t"] == pytest.approx(3 * 1001 / 30000)
    back = X.anchors_from_json(d)
    assert sorted(back) == sorted(t.anchors.frames)
    for k, a in back.items():
        b = t.anchors.at(k)
        assert a.visible == b.visible and a.area == b.area and a.run == b.run
        if a.visible:
            assert a.bbox == pytest.approx(b.bbox, abs=1e-3) and a.centroid == pytest.approx(b.centroid, abs=1e-3)
            assert a.angle == pytest.approx(b.angle, abs=1e-3) and a.smooth.centroid == pytest.approx(b.smooth.centroid, abs=1e-3)
            assert a.elongation == pytest.approx(b.elongation, abs=1e-3)


def test_csv_一幀一列_來回(tmp_path: Path) -> None:
    t = _sample_track(tmp_path)
    vi = X.VideoInfo(None, W, H, (24, 1), 100)
    out = tmp_path / "track.csv"
    X.write_csv(out, t, vi)
    rows = X.read_csv(out)
    assert list(rows[0]) == list(X.CSV_COLUMNS)
    assert [int(r["k"]) for r in rows] == list(range(13))
    r9, r8, r3 = rows[9], rows[8], rows[3]
    assert r9["computed"] == "0" and r9["visible"] == "0" and r9["x"] == ""
    assert r8["computed"] == "1" and r8["visible"] == "0"
    a = t.anchor(3)
    assert float(r3["t"]) == pytest.approx(3 / 24) and int(r3["area"]) == a.area
    assert [float(r3[c]) for c in ("x", "y", "w", "h")] == pytest.approx(list(a.bbox), abs=1e-3)
    assert float(r3["sangle"]) == pytest.approx(a.smooth.angle, abs=1e-3)
    assert float(r3["elong"]) == pytest.approx(a.elongation, abs=1e-3) and a.elongation > 2.0
    assert "-0" not in out.read_text(encoding="utf-8").replace("-0.", "")  # 不寫出 -0


def test_png_序列來回(tmp_path: Path) -> None:
    t = _sample_track(tmp_path)
    d = tmp_path / "序列"
    files = X.write_png_sequence(d, t)
    assert len(files) == 13 and files[0].name == "mask_000000.png"
    back = X.read_png_sequence(d, list(range(13)))
    for k in range(13):
        m = t.mask(k)
        assert np.array_equal(back[k], m if m is not None else np.zeros((H, W), bool)), k
    man = json.loads((d / "mask_sequence.json").read_text(encoding="utf-8"))
    assert man["first"] == 0 and man["last"] == 12 and man["notComputed"] == [9] and man["size"] == [W, H]


def test_png_序列重新匯出到同一個資料夾_清掉範圍外的舊幀(tmp_path: Path) -> None:
    """回歸：以前只寫這次 [first, last] 的檔，上一次的 mask_000000..（範圍外）留著 —— AE／Nuke／ffmpeg 照檔名認序列，
    兩個物件（或新舊兩版）混成一段。別的檔名一律不碰。"""
    d = tmp_path / "png"
    old = ObjectTrack.open(_write(tmp_path, {k: _rect(5, 5, 15, 15) for k in range(12)}, "a"))
    X.write_png_sequence(d, old)
    (d / "筆記.txt").write_text("留著", encoding="utf-8")
    (d / "other_000001.png").write_bytes(b"x")
    new = ObjectTrack.open(_write(tmp_path, {k: _rect(40, 30, 60, 50) for k in range(4, 8)}, "b"))
    X.write_png_sequence(d, new)
    pngs = sorted(p.name for p in d.glob("mask_*.png"))
    assert pngs == [X.png_name(k) for k in range(4, 8)], pngs
    back = X.read_png_sequence(d, list(range(4, 8)))
    assert all(np.array_equal(back[k], _rect(40, 30, 60, 50)) for k in range(4, 8))
    assert (d / "筆記.txt").is_file() and (d / "other_000001.png").is_file()


# ---------------------------------------------------------------- ops：track-export／preview-object（合成測試片）
@pytest.fixture(scope="module")
def clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    pytest.importorskip("av")
    from fixtures import objclip as OC

    p = tmp_path_factory.mktemp("objclip") / "物件.mkv"
    try:
        OC.write_clip(p)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"PyAV 無法編出 libx264/matroska 測試片：{e}")
    return p


@pytest.fixture()
def _cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.ops import load_all

    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    load_all()


def test_track_export_op(clip: Path, tmp_path: Path, _cache: None) -> None:
    from fixtures import objclip as OC

    from aivc.ops import OpError
    from aivc.ops._ctx import CliCtx
    from aivc.ops.objects import objects_export

    m = tmp_path / "o" / "masks.aivm"
    MaskFile.write(m, OC.W, OC.H, ((k, OC.truth(k)) for k in range(OC.N)))
    r = objects_export({"video": str(clip), "masks": str(m), "format": "json", "out": str(tmp_path / "t.json")}, CliCtx())
    assert r["frames"] == OC.N and r["visibleRanges"] == [[0, OC.N - 1]] and r["video"]["fps"] == [24, 1] and r["video"]["frames"] == OC.N
    d = X.read_json(tmp_path / "t.json")
    assert d["frames"][4]["bbox"] == [18.0, 20.0, 12.0, 12.0]  # white_box(4) = (18, 20, 30, 32)
    r2 = objects_export({"video": str(clip), "masks": str(m), "format": "csv", "out": str(tmp_path / "t.csv")}, CliCtx())
    assert r2["anchorsCache"]["hit"] is True and len(X.read_csv(tmp_path / "t.csv")) == OC.N
    r3 = objects_export({"video": str(clip), "masks": str(m), "format": "png", "out": str(tmp_path / "png")}, CliCtx())
    assert r3["files"] == OC.N
    wrong = tmp_path / "w" / "masks.aivm"
    MaskFile.write(wrong, 10, 10, [(0, np.ones((10, 10), bool))])
    with pytest.raises(OpError) as e:
        objects_export({"video": str(clip), "masks": str(wrong), "format": "json", "out": str(tmp_path / "w.json")}, CliCtx())
    assert e.value.kind == "Invalid" and "10×10" in str(e.value)
    assert math.isfinite(d["frames"][0]["angle"])
    # 回歸：同尺寸、但幀號超出這支影片的遮罩（別支影片算的）以前照樣匯出超過片長的幀
    longer = tmp_path / "l" / "masks.aivm"
    MaskFile.write(longer, OC.W, OC.H, ((k, OC.truth(k % OC.N)) for k in range(OC.N * 3)))
    with pytest.raises(OpError) as e2:
        objects_export({"video": str(clip), "masks": str(longer), "format": "json", "out": str(tmp_path / "l.json")}, CliCtx())
    assert e2.value.kind == "Invalid" and str(OC.N * 3 - 1) in str(e2.value) and not (tmp_path / "l.json").exists()
    from aivc.ops.objects import objects_preview

    with pytest.raises(OpError) as e3:
        objects_preview({"video": str(clip), "masks": [str(longer)], "out": str(tmp_path / "l.png")}, CliCtx())
    assert "影片只有" in str(e3.value)


def test_preview_object_聯絡表(clip: Path, tmp_path: Path, _cache: None) -> None:
    from fixtures import objclip as OC

    from aivc.ops import OpError
    from aivc.ops._ctx import CliCtx
    from aivc.ops.objects import auto_frames, objects_preview

    p1 = tmp_path / "o1" / "masks.aivm"
    p2 = tmp_path / "o2" / "masks.aivm"
    MaskFile.write(p1, OC.W, OC.H, ((k, OC.truth(k)) for k in range(OC.N)))
    MaskFile.write(p2, OC.W, OC.H, ((k, OC.truth(k, "blue")) for k in range(OC.N)))
    r = objects_preview({"video": str(clip), "masks": [str(p1), str(p2)], "out": str(tmp_path / "sheet.png"), "tile": 96}, CliCtx())
    assert r["tiles"] == 6 and r["frames"] == auto_frames([MaskFile.open(p1), MaskFile.open(p2)], OC.N) and r["frames"][0] == 0 and r["frames"][-1] == OC.N - 1
    assert r["present"]["0"] == [1] and r["present"][str(OC.N - 1)] == [1, 2]
    r2 = objects_preview({"video": str(clip), "masks": [str(p1)], "frames": "0, 5,19", "out": str(tmp_path / "s2.png"), "cols": 3}, CliCtx())
    assert r2["frames"] == [0, 5, 19] and r2["tiles"] == 3
    img = cv2.imdecode(np.fromfile(r2["out"], np.uint8), cv2.IMREAD_COLOR)
    assert img.shape[1] > img.shape[0]  # 一列三格
    with pytest.raises(OpError):
        objects_preview({"video": str(clip), "masks": [str(p1)], "frames": "0,x", "out": str(tmp_path / "s3.png")}, CliCtx())
