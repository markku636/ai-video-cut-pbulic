"""通用物件進 render（docs/tracking-api.md「專案檔」與「render」）：

- `objects.adopt`：find／select 的遮罩收進快取 tracks/<id>/masks.aivm，回最佳幀／框／面積／可見段／縮圖；
- replace 的幀對應（fps 換算、offsetFrames、loop／hold／stop）與 fit（stretch／contain／cover）；
- render.plan JSON：effects 一節（每個特效的狀態與不合法原因、跳過原因）、tracks[].replace；沒有用到時沒有 effects 鍵；
- render.run（ffv1 無損）：特效作用範圍外逐位元相同、範圍內真的變了；replace 圖片／影片（逐幀對應）真的印上去、範圍外不動；
- 序列渲染（I2）：特效與 replace 在序列第 t 幀 == 只渲染來源第 k 幀；
- track.solve 不給 --template：從參考影格的四角取模板，之後重追重用 template.png。

全部 CPU、合成畫面（PyAV 寫 ffv1）；render 那幾個需要 ffmpeg。
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures" / "e1"))
import synth_scene as SC  # noqa: E402

from aivc import env  # noqa: E402
from aivc.geom import homography as hg  # noqa: E402
from aivc.insert import media as RM  # noqa: E402
from aivc.media.source import FrameSource  # noqa: E402
from aivc.ops import OpError  # noqa: E402
from aivc.ops import render as RD  # noqa: E402
from aivc.project import paths as P  # noqa: E402
from aivc.project import resolve as R  # noqa: E402
from aivc.project import schema as S  # noqa: E402
from aivc.seg.maskfile import MaskFile  # noqa: E402
from aivc.track.state import FrameSolve, Solve, State  # noqa: E402

W, H, N = 320, 240, 10
OBJ_W, OBJ_H = 60, 50
QP = SC.card_quad(180, 130, 100, 80)  # 平面 p1：均勻淺灰（replace 用）
QQ = SC.card_quad(20, 170, 80, 50)  # 平面 p2：只有 solve 四角（特效用）
GREY = (200, 200, 200)


def obj_rect(k: int) -> tuple[int, int, int, int]:
    x = 40 + 4 * k
    return x, 60, x + OBJ_W, 60 + OBJ_H


def obj_mask(k: int) -> np.ndarray:
    m = np.zeros((H, W), bool)
    x0, y0, x1, y1 = obj_rect(k)
    m[y0:y1, x0:x1] = True
    return m


# 物件遮罩：k=0..7 有條目、k=5 缺席（被遮住）、k=8,9 沒算過
OBJ_ENTRIES: dict[int, np.ndarray | None] = {k: (None if k == 5 else obj_mask(k)) for k in range(8)}


@pytest.fixture(scope="module")
def scene(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    root = tmp_path_factory.mktemp("物件 場景")
    rng = np.random.default_rng(7)
    bg = rng.integers(30, 220, (H, W, 3), dtype=np.uint8)
    frames = []
    for k in range(N):
        img = bg.copy()
        x0, y0, x1, y1 = obj_rect(k)
        img[y0:y1, x0:x1] = (230, 140, 40)
        cv2.fillConvexPoly(img, np.round(QP).astype(np.int32), GREY)
        frames.append(img)
    video = SC.write_clip(root / "物件 clip.mkv", frames)
    find = root / "find" / "obj1" / "masks.aivm"
    MaskFile.write(find, W, H, OBJ_ENTRIES.items())
    # replace 素材：左紅右綠的圖片；6 幀 15 fps 的灰階影片（第 s 幀的灰階 = 20 + 40 s）
    img = np.zeros((64, 64, 4), np.uint8)
    img[:, :32] = (30, 30, 230, 255)  # BGRA：紅
    img[:, 32:] = (30, 200, 30, 255)  # 綠
    image = root / "替換 圖.png"
    ok, buf = cv2.imencode(".png", img)
    assert ok
    image.write_bytes(buf.tobytes())
    vframes = [np.full((48, 64, 3), 20 + 40 * s, np.uint8) for s in range(6)]
    rvideo = SC.write_clip(root / "替換 片.mkv", vframes, fps=15)
    return {"root": root, "video": video, "frames": frames, "find_masks": find, "image": image, "rvideo": rvideo}


@pytest.fixture
def cache(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    return tmp_path / "cache"


@pytest.fixture(scope="module")
def ffmpeg_ready() -> None:
    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")


def _solve(cache_root: Any, tid: str, quad: np.ndarray, wh: tuple[int, int]) -> None:
    Hm = hg.template_to_quad(wh, quad)
    s = Solve(tid, (0, N), 0, wh)
    for k in range(N):
        s.frames[k] = FrameSolve(k, Hm, 1.0, State.STATIC, pinned=(k == 0))
    s.write(cache_root.solve(tid), None)


def _track(tid: str, **kw: Any) -> S.TrackV1:
    return S.TrackV1(id=tid, shot_id="s1", label=tid, **kw)


def make_project(scene: dict[str, Any], tmp_path: Path, tracks: list[S.TrackV1], *, adopt: bool = True, seq: S.SequenceV2 | None = None) -> Path:
    from aivc.ops.objects import objects_adopt

    video = scene["video"]
    fp = P.fingerprint_for(video)
    mc = P.media_cache(fp).ensure()
    p = S.ProjectFile(profile="generic")
    p.media.append(S.MediaV1(id="m1", path=str(video), name=video.name, fingerprint=fp, probe=None, proxy=S.ProxyMetaV1(S.Rational(30, 1), N, W, H, 1.0)))
    p.active_media_id = "m1"
    p.shots["m1"] = [S.ShotV1(id="s1", start_frame=0, end_frame=N, kind="close")]
    p.tracks["m1"] = tracks
    p.sequence = seq
    for t in tracks:
        if t.is_object and adopt:
            objects_adopt({"video": str(video), "src": str(scene["find_masks"].parent), "track_id": t.id}, SC.RecordingCtx())
        elif t.id.startswith("p1"):
            _solve(mc, t.id, QP, (100, 80))
        elif t.id.startswith("p2"):
            _solve(mc, t.id, QQ, (80, 50))
    ppath = tmp_path / "物件 專案.aivc.json"
    S.save(p, ppath)
    return ppath


def plan_and_render(ppath: Path, out: Path | None, **kw: Any) -> tuple[RD.RenderPlan, dict[str, Any] | None]:
    ctx = SC.RecordingCtx()
    mctx = R.open_media_context(ppath, None, ctx)
    plan = RD.build_plan(mctx, ctx, out=str(out or ppath.with_suffix(".mkv")), codec="ffv1", gpu=False, **kw)
    res = None if out is None else RD.run_render(mctx, plan, ctx)
    return plan, res


def decode(path: Path) -> list[Any]:
    with FrameSource(path) as fs:
        return [fs.get(i) for i in range(fs.n_frames)]


def dilate(m: np.ndarray, r: int) -> np.ndarray:
    return cv2.dilate(m.astype(np.uint8), np.ones((2 * r + 1, 2 * r + 1), np.uint8)) > 0


def chroma_touched(F: np.ndarray) -> np.ndarray:
    return F.reshape(H // 2, 2, W // 2, 2).any(axis=(1, 3))


def same_outside(a: Any, b: Any, F: np.ndarray) -> bool:
    c = chroma_touched(F)
    return bool(np.array_equal(a.y[~F], b.y[~F]) and np.array_equal(a.u[~c], b.u[~c]) and np.array_equal(a.v[~c], b.v[~c]))


def same(a: Any, b: Any) -> bool:
    return bool(np.array_equal(a.y, b.y) and np.array_equal(a.u, b.u) and np.array_equal(a.v, b.v))


EFFECTS_O1 = [
    {"id": "e1", "enabled": True, "type": "mosaic", "blocks": 6},
    {"id": "e2", "enabled": False, "type": "color", "hue": 180},
    {"id": "e3", "enabled": True, "type": "blur", "bogus": 1},
]
EFFECTS_P2 = [{"id": "f1", "enabled": True, "type": "color", "hue": 120, "saturation": 1.6, "brightness": 1.4}]


# ---------------------------------------------------------------- objects.adopt


def test_adopt_copies_masks_and_reports_best_frame(scene: dict[str, Any], cache: Path) -> None:
    from aivc.ops.objects import objects_adopt

    ctx = SC.RecordingCtx()
    r = objects_adopt({"video": str(scene["video"]), "src": str(scene["find_masks"].parent), "track_id": "o1"}, ctx)
    dst = Path(r["masks"])
    assert dst == P.media_cache(P.fingerprint_for(scene["video"])).masks("o1") and dst.read_bytes() == scene["find_masks"].read_bytes()
    assert dst.with_name("anchors.v1.json").is_file() and Path(r["thumb"]).is_file()
    assert r["visibleRanges"] == [[0, 4], [6, 7]] and r["range"] == [0, 8]
    assert r["bestFrame"] == 0 and r["box"] == [40.0, 60.0, 60.0, 50.0] and r["area"] == OBJ_W * OBJ_H
    assert r["frames"] == {"entries": 8, "present": 7, "absent": 1} and r["size"] == [W, H]
    assert not [p for p in dst.parent.iterdir() if ".part" in p.name]
    # 直接給 masks.aivm 路徑也可以；同一個 id 再 adopt 一次（內容變了）→ 換掉、錨點重算
    other = scene["root"] / "other.aivm"
    MaskFile.write(other, W, H, [(3, obj_mask(9)), (4, obj_mask(9))])
    r2 = objects_adopt({"video": str(scene["video"]), "src": str(other), "track_id": "o1"}, ctx)
    assert r2["visibleRanges"] == [[3, 4]] and r2["box"] == [76.0, 60.0, 60.0, 50.0] and dst.read_bytes() == other.read_bytes()


def test_adopt_rejects_bad_inputs(scene: dict[str, Any], cache: Path) -> None:
    from aivc.ops.objects import objects_adopt

    ctx = SC.RecordingCtx()
    small = scene["root"] / "small.aivm"
    MaskFile.write(small, 32, 24, [(0, np.ones((24, 32), bool))])
    with pytest.raises(OpError) as e:
        objects_adopt({"video": str(scene["video"]), "src": str(small), "track_id": "o1"}, ctx)
    assert e.value.kind == "Invalid" and "32×24" in str(e.value)
    with pytest.raises(OpError) as e:
        objects_adopt({"video": str(scene["video"]), "src": str(scene["find_masks"]), "track_id": "../x"}, ctx)
    assert e.value.kind == "Invalid"
    with pytest.raises(OpError) as e:
        objects_adopt({"video": str(scene["video"]), "src": str(scene["root"] / "nope"), "track_id": "o1"}, ctx)
    assert e.value.kind == "Io"


# ---------------------------------------------------------------- replace：幀對應與 fit


def test_source_index_fps_conversion_offset_and_loop_modes() -> None:
    def si(k: int, *, loop: str = "loop", offset: int = 0, origin: int = 0, tl: tuple[int, int] = (30, 1), src: tuple[int, int] = (15, 1), n: int = 6) -> int | None:
        return RM.source_index(k, origin=origin, offset=offset, timeline_fps=tl, source_fps=src, n_source=n, loop=loop)

    # 30 fps 時間軸、15 fps 素材：每個素材幀用兩次
    assert [si(k) for k in range(6)] == [0, 0, 1, 1, 2, 2]
    # 24 → 30（素材比較快）：t = k/30 s，s = floor(t·24)
    assert [si(k, tl=(30, 1), src=(24, 1), n=100) for k in range(6)] == [0, 0, 1, 2, 3, 4]
    # NTSC：時間軸 30000/1001、素材 24000/1001 → 同上（比例相同）
    assert [si(k, tl=(30000, 1001), src=(24000, 1001), n=100) for k in range(6)] == [0, 0, 1, 2, 3, 4]
    # offset 以時間軸幀計、origin＝鏡頭起點
    assert si(10, origin=10) == 0 and si(10, origin=10, offset=4) == 2 and si(12, origin=10, offset=-2) == 0
    # 超出範圍：loop 繞回、hold 夾住、stop 不印（負的也一樣）
    assert si(12) == 0 and si(13) == 0 and si(14) == 1  # s=6 → 0
    assert si(12, loop="hold") == 5 and si(-3, loop="hold") == 0
    assert si(12, loop="stop") is None and si(-1, loop="stop") is None and si(11, loop="stop") == 5
    assert si(-1) == 5  # floor(-1/2) = -1 → 繞回最後一幀
    assert si(0, n=0) is None
    # frames_for_stop 與逐幀算的一致
    for off in (-5, 0, 3):
        lo, hi = RM.frames_for_stop(6, origin=2, offset=off, timeline_fps=(30, 1), source_fps=(15, 1))
        brute = [k for k in range(-40, 40) if si(k, loop="stop", offset=off, origin=2) is not None]
        assert (lo, hi) == (brute[0], brute[-1] + 1)


def test_fit_modes() -> None:
    rgb = np.zeros((100, 200, 3), np.uint8)
    rgb[:, :100] = (255, 0, 0)
    rgb[:, 100:] = (0, 0, 255)
    out, a = RM.fit_rgba(rgb, None, (100, 100), "stretch")
    assert out.shape == (100, 100, 3) and a.min() == 1.0 and tuple(out[50, 10]) == (255, 0, 0) and tuple(out[50, 90]) == (0, 0, 255)
    out, a = RM.fit_rgba(rgb, None, (100, 100), "contain")
    assert a[:25].max() == 0 and a[75:].max() == 0 and a[25:75].min() == 1.0  # 上下留白
    assert tuple(out[50, 10]) == (255, 0, 0) and tuple(out[50, 90]) == (0, 0, 255)
    out, a = RM.fit_rgba(rgb, None, (100, 100), "cover")
    assert a.min() == 1.0 and tuple(out[50, 10]) == (255, 0, 0) and tuple(out[50, 90]) == (0, 0, 255) and out[50, 48, 0] > 200 and out[50, 52, 2] > 200  # 裁中間
    # alpha：半透明照帶過去
    alpha = np.full((100, 200), 0.5, np.float32)
    _out, a = RM.fit_rgba(rgb, alpha, (50, 50), "stretch")
    assert np.allclose(a, 0.5, atol=1e-3)
    assert RM.template_size((100, 80)) == (512, 410) and RM.template_size((1000, 800)) == (1000, 800)
    with pytest.raises(ValueError):
        RM.fit_rgba(rgb, None, (10, 10), "zoom")


# ---------------------------------------------------------------- 計畫 JSON


def test_plan_json_lists_effects_replace_and_skip_reasons(scene: dict[str, Any], cache: Path, tmp_path: Path) -> None:
    tracks = [
        _track("o1", kind="object", frame_range=(1, 8), effects=EFFECTS_O1, color="#FF8800", source=S.ObjectSourceV1.make("text", text="orange box")),
        _track("o2", kind="object", effects=[{"id": "x", "enabled": True, "type": "glow"}]),  # 沒有 adopt → 沒有遮罩
        _track("p1", replace=S.ReplaceV1.make("image", str(scene["image"]), fit="contain")),
        _track("p2", effects=EFFECTS_P2),
        _track("p3", replace=S.ReplaceV1.make("video", str(scene["root"] / "不存在.mp4"))),
    ]
    ppath = make_project(scene, tmp_path, tracks)
    P.media_cache(P.fingerprint_for(scene["video"])).masks("o2").unlink()  # make_project 每條 object 都 adopt；o2 要「沒有遮罩」
    plan, _ = plan_and_render(ppath, None)
    d = plan.to_json()
    assert [t["id"] for t in d["tracks"]] == ["p1"]
    rp = d["tracks"][0]["replace"]
    assert rp["kind"] == "image" and rp["fit"] == "contain" and rp["templateSize"] == [512, 410] and rp["source"] == {"size": [64, 64], "frames": None, "fps": None}
    skipped = {s["trackId"]: s["reason"] for s in d["skipped"]}
    assert set(skipped) == {"p2", "p3"} and "不存在" in skipped["p3"]  # o1／o2 不是插入候選，不在 skipped
    fx = {t["trackId"]: t for t in d["effects"]}
    assert list(fx) == ["o1", "o2", "p2"]
    o1 = fx["o1"]
    # [1, 8) 裡 present 的條目：1,2,3,4,6,7（5 缺席）
    assert o1["kind"] == "object" and o1["footprint"] == "masks" and o1["range"] == [1, 8] and o1["frames"] == 6 and o1["absentFrames"] == 1 and o1["skipped"] is None
    assert [(e["id"], e["status"]) for e in o1["effects"]] == [("e1", "ok"), ("e2", "disabled"), ("e3", "invalid")]
    assert "bogus" in o1["effects"][2]["reason"]
    assert fx["o2"]["skipped"].startswith("沒有遮罩") and "adopt" in fx["o2"]["skipped"]
    assert fx["p2"]["footprint"] == "quad" and fx["p2"]["frames"] == N and fx["p2"]["skipped"] is None
    human = RD._plan_human(plan)
    assert "特效 o1" in human and "replace image" in human and "不合法" in human
    # --range 夾特效的幀；--track 篩選
    plan2, _ = plan_and_render(ppath, None, range_spec="3:6", track_ids=["o1"])
    d2 = plan2.to_json()
    assert [t["trackId"] for t in d2["effects"]] == ["o1"] and d2["effects"][0]["frames"] == 2  # k=3,4（5 缺席）


def test_plan_json_has_no_effects_key_without_objects_or_effects(scene: dict[str, Any], cache: Path, tmp_path: Path) -> None:
    ppath = make_project(scene, tmp_path, [_track("p1", replace=S.ReplaceV1.make("image", str(scene["image"])))])
    plan, _ = plan_and_render(ppath, None)
    d = plan.to_json()
    assert "effects" not in d and d["tracks"][0]["replace"]["fit"] == "stretch"


# ---------------------------------------------------------------- render：特效


def test_render_effects_outside_footprint_bit_identical(scene: dict[str, Any], cache: Path, tmp_path: Path, ffmpeg_ready: None) -> None:
    tracks = [_track("o1", kind="object", frame_range=(1, 8), effects=EFFECTS_O1), _track("p2", effects=EFFECTS_P2)]
    ppath = make_project(scene, tmp_path, tracks)
    out = tmp_path / "fx.mkv"
    plan, res = plan_and_render(ppath, out)
    assert res is not None and res["frames"] == N
    fx = {t["trackId"]: t for t in res["effects"]}
    assert fx["o1"]["applied"] == 6 and fx["o1"]["absentFrames"] == 1 and fx["p2"]["applied"] == N
    src, dec = decode(scene["video"]), decode(out)
    quad = SC.quad_mask(QQ, W, H)
    for k in range(N):
        F = dilate(quad, 3)
        o_on = k in (1, 2, 3, 4, 6, 7)
        if o_on:
            F = F | dilate(obj_mask(k), 8)
        assert same_outside(dec[k], src[k], F), k
        inner_q = ~dilate(~quad, 3)
        assert not np.array_equal(dec[k].y[inner_q], src[k].y[inner_q]), k  # p2 每一幀都調色
        m = obj_mask(k)
        inner_o = m & ~dilate(~m, 4)
        changed = not np.array_equal(dec[k].y[inner_o], src[k].y[inner_o])
        assert changed == o_on, k  # 範圍外（k=0）、缺席（k=5）、沒算過（k=8,9）都不打碼


def test_render_effects_only_inside_range_and_track_filter(scene: dict[str, Any], cache: Path, tmp_path: Path, ffmpeg_ready: None) -> None:
    ppath = make_project(scene, tmp_path, [_track("o1", kind="object", effects=EFFECTS_O1[:1]), _track("p2", effects=EFFECTS_P2)])
    out = tmp_path / "fx-range.mkv"
    _plan, res = plan_and_render(ppath, out, range_spec="2:4", track_ids=["o1"])
    assert res is not None and [t["trackId"] for t in res["effects"]] == ["o1"] and res["effects"][0]["applied"] == 2
    src, dec = decode(scene["video"]), decode(out)
    for k in range(N):
        assert same(dec[k], src[k]) == (k not in (2, 3)), k


# ---------------------------------------------------------------- render：replace


def _interior(quad: np.ndarray, shrink: int = 6) -> np.ndarray:
    m = SC.quad_mask(quad, W, H)
    return m & ~dilate(~m, shrink)


def test_render_replace_image(scene: dict[str, Any], cache: Path, tmp_path: Path, ffmpeg_ready: None) -> None:
    ppath = make_project(scene, tmp_path, [_track("p1", replace=S.ReplaceV1.make("image", str(scene["image"])))])
    out = tmp_path / "rep.mkv"
    plan, res = plan_and_render(ppath, out)
    assert res is not None and res["tracks"][0]["composited"] == N
    src, dec = decode(scene["video"]), decode(out)
    quad = SC.quad_mask(QP, W, H)
    inner = _interior(QP)
    left = inner.copy()
    left[:, int(QP[0, 0] + 50) :] = False
    right = inner.copy()
    right[:, : int(QP[0, 0] + 50)] = False
    for k in range(N):
        assert same_outside(dec[k], src[k], dilate(quad, 4)), k
        rgb = dec[k].rgb8()
        lm, rm = rgb[left].mean(axis=0), rgb[right].mean(axis=0)
        assert lm[0] > 170 and lm[1] < 90 and rm[1] > 150 and rm[0] < 90, (k, lm, rm)  # 左紅右綠（灰牆的光影 ≈ 1）


@pytest.mark.parametrize(("loop", "offset", "want"), [
    ("stop", 4, {k: (k + 4) // 2 for k in range(8)}),  # k=8,9 → s=6 超出 → 不印
    ("hold", 4, {k: min((k + 4) // 2, 5) for k in range(N)}),
    ("loop", 4, {k: ((k + 4) // 2) % 6 for k in range(N)}),
])
def test_render_replace_video_frame_mapping(scene: dict[str, Any], cache: Path, tmp_path: Path, ffmpeg_ready: None, loop: str, offset: int, want: dict[int, int]) -> None:
    ppath = make_project(scene, tmp_path, [_track("p1", replace=S.ReplaceV1.make("video", str(scene["rvideo"]), offset_frames=offset, loop=loop))])
    out = tmp_path / f"rep-{loop}.mkv"
    plan, res = plan_and_render(ppath, out)
    assert res is not None
    t = res["tracks"][0]
    assert t["composited"] == len(want) and t["replace"]["stopped"] == N - len(want) and t["replace"]["source"]["frames"] == 6
    assert t["replace"]["source"]["fps"] == [15, 1] and plan.n_composite == len(want)
    src, dec = decode(scene["video"]), decode(out)
    rsrc = decode(scene["rvideo"])
    inner = _interior(QP)
    for k in range(N):
        if k not in want:
            assert same(dec[k], src[k]), k  # stop：這一幀原樣
            continue
        got = float(dec[k].y[inner].mean())
        exp = float(rsrc[want[k]].y.mean())
        assert abs(got - exp) < 8.0, (k, got, exp)


# ---------------------------------------------------------------- 序列（I2）


def test_sequence_frames_equal_source_render_with_effects_and_replace(scene: dict[str, Any], cache: Path, tmp_path: Path, ffmpeg_ready: None) -> None:
    tracks = [
        _track("o1", kind="object", frame_range=(1, 8), effects=EFFECTS_O1[:1]),
        _track("p1", replace=S.ReplaceV1.make("video", str(scene["rvideo"]), loop="hold")),
        _track("p2", effects=EFFECTS_P2),
    ]
    seq = S.SequenceV2("seq-1", "倒序", S.Rational(30, 1), W, H, video=[S.VideoClipV2("c1", "m1", 6, 10), S.VideoClipV2("c2", "m1", 0, 5)])
    ppath = make_project(scene, tmp_path, tracks, seq=seq)
    src_out, seq_out = tmp_path / "source.mkv", tmp_path / "seq.mkv"
    _p1, r1 = plan_and_render(ppath, src_out, sequence="ignore")
    plan2, r2 = plan_and_render(ppath, seq_out)
    assert r1 is not None and r2 is not None and r2["frames"] == 9
    d2 = plan2.to_json()
    fx = {t["trackId"]: t for t in d2["effects"]}
    # 序列用到的來源 k：6..9、0..4；o1 的特效幀＝present ∩ [1,8) = 1,2,3,4,6,7 → 全部用到
    assert fx["o1"]["mediaId"] == "m1" and fx["o1"]["frames"] == 6 and fx["o1"]["applied"] == 6
    a, b = decode(src_out), decode(seq_out)
    ks = [6, 7, 8, 9, 0, 1, 2, 3, 4]
    for t, k in enumerate(ks):
        assert same(b[t], a[k]), (t, k)


# ---------------------------------------------------------------- track.solve 不給 --template


@pytest.fixture(scope="module")
def moving_sign(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    root = tmp_path_factory.mktemp("移動 平面")
    sign = SC.make_sign_rgba("new", (90, 126))
    rng = np.random.default_rng(3)
    bg = cv2.GaussianBlur(rng.integers(20, 120, (H, W, 3), dtype=np.uint8), (0, 0), 2.0)
    quads, frames = [], []
    for k in range(8):
        q = SC.card_quad(60 + 3.0 * k, 50 + 1.0 * k, 90, 126)
        img = bg.copy()
        SC.paste_rgba(img, sign, q)
        quads.append(q)
        frames.append(img)
    return {"video": SC.write_clip(root / "sign.mkv", frames), "quads": quads}


def test_track_solve_without_template_uses_reference_quad(moving_sign: dict[str, Any], cache: Path, tmp_path: Path) -> None:
    from aivc.ops.track import track_op

    q0 = moving_sign["quads"][0]
    out = tmp_path / "w1" / "solve.v1.json"
    args = {"video": str(moving_sign["video"]), "shot": "0:8", "quad": ",".join(f"{v:.3f}" for v in q0.ravel()), "reference_frame": 0, "track_id": "w1", "out": str(out)}
    r = track_op(args, SC.RecordingCtx())
    tpl = r["template"]
    assert tpl["source"] == "frame" and tpl["frame"] == 0 and tpl["size"] == [90, 126] and Path(tpl["path"]) == out.with_name("template.png")
    s = Solve.read(out)
    assert s.template_wh == (90, 126) and r["frames"] == 8
    for k, q in enumerate(moving_sign["quads"]):
        f = s.frames.get(k)
        assert f is not None and f.H is not None, k
        err = np.abs(hg.quad_from_h(f.H, s.template_wh) - q).max()
        assert err < 1.5, (k, err)
    # 沒有 --quad 再追一次（重追後半段）：重用存好的 template.png
    r2 = track_op({"video": str(moving_sign["video"]), "shot": "0:8", "track_id": "w1", "out": str(out), "retrack_from": 4}, SC.RecordingCtx())
    assert r2["template"]["source"] == "saved" and r2["action"] == "retrack"
    # 什麼都沒有：清楚的錯誤
    with pytest.raises(OpError) as e:
        track_op({"video": str(moving_sign["video"]), "shot": "0:8", "track_id": "w2", "out": str(tmp_path / "w2" / "solve.v1.json")}, SC.RecordingCtx())
    assert e.value.kind == "Invalid" and "--quad" in str(e.value)


def test_template_size_for_quad() -> None:
    from aivc.ops.track import template_size_for_quad

    assert template_size_for_quad(SC.card_quad(0, 0, 90, 126)) == (90, 126)
    assert template_size_for_quad(SC.card_quad(0, 0, 4000, 1000)) == (1024, 256)
    assert template_size_for_quad(SC.card_quad(0, 0, 3, 3)) == (16, 16)
