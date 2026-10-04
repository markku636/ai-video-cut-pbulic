"""export/：Nuke CornerPin2D 與 AE 關鍵幀文字的 export-roundtrip（計畫 §11：重建四角 vs solve 最大誤差 < 0.01 px）、
golden 標頭、座標轉換釘死、knob 對照、op 端到端（tmp 專案 + tmp 快取）。"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from aivc.export import ae_keyframes as AE
from aivc.export import nuke_cornerpin as NK
from aivc.geom import homography as hg
from aivc.ops import CLI_INDEX, REGISTRY, OpError, load_all
from aivc.track.state import FrameSolve, Solve, State

TW, TH = 630, 880
HEIGHT, WIDTH = 720, 1280


def fake_solve(k0: int = 926, k1: int = 1000, lost_every: int = 17, seed: int = 3) -> tuple[Solve, dict[int, np.ndarray | None]]:
    rng = np.random.default_rng(seed)
    solve = Solve("t1", (k0, k1), (k0 + k1) // 2, (TW, TH))
    frames: dict[int, np.ndarray | None] = {}
    base = np.array([[248.0, 410.0], [366.0, 412.0], [355.0, 487.0], [230.0, 483.0]])
    for k in range(k0, k1):
        q = base + rng.normal(0, 0.9, (4, 2)) + np.array([[0.03 * (k - k0), 0.011 * (k - k0)]])
        lost = lost_every > 0 and (k - k0 + 1) % lost_every == 0  # 每 lost_every 幀丟一幀（永不丟第一幀）
        H = None if lost else hg.template_to_quad((TW, TH), q)
        solve.frames[k] = FrameSolve(k, H, 0.0 if lost else 0.93, State.LOST if lost else State.TRACKING)
        frames[k] = None if lost else hg.quad_from_h(H, (TW, TH))
    return solve, frames


# ---------------------------------------------------------------- 座標轉換釘死


def test_nuke_corner_mapping_and_y_flip() -> None:
    quad = np.array([[10.0, 20.0], [110.0, 22.0], [108.0, 90.0], [12.0, 92.0]])  # TL,TR,BR,BL
    to = NK.quad_to_nuke(quad, HEIGHT)
    assert to[1] == (12.0, HEIGHT - 92.0)  # to1 = BL
    assert to[2] == (108.0, HEIGHT - 90.0)  # to2 = BR
    assert to[3] == (110.0, HEIGHT - 22.0)  # to3 = TR
    assert to[4] == (10.0, HEIGHT - 20.0)  # to4 = TL
    back = NK.quad_from_nuke(to, HEIGHT)
    assert np.allclose(back, quad)


def test_nuke_from_rect_and_knobs_golden() -> None:
    solve, frames = fake_solve(0, 3, lost_every=999)
    text = NK.nuke_cornerpin(frames, height=HEIGHT, template_wh=(TW, TH), options=NK.NukeOptions(motionblur=3, shutter=0.5, filter="Lanczos4", clamp=True))
    lines = text.splitlines()
    assert lines[0] == "CornerPin2D {"
    assert " from1 {0 0}" in lines and " from2 {630 0}" in lines and " from3 {630 880}" in lines and " from4 {0 880}" in lines
    assert " motionblur 3" in lines and " shutter 0.5" in lines and " shutteroffset centred" in lines
    assert " filter Lanczos4" in lines and " clamp true" in lines and " black_outside true" in lines and " invert false" in lines
    assert lines[-1] == "}"
    # 曲線語法 {curve x<F> v …}，frame = k + 1
    to1 = next(line for line in lines if line.startswith(" to1 "))
    assert to1.startswith(" to1 {{curve x1 ") and " x3 " in to1 and "x0 " not in to1
    assert " x4 " not in to1  # 只有 k=0,1,2 → x1..x3


def test_nuke_linked_flavour_adds_comment_and_stabilize_inverts() -> None:
    _s, frames = fake_solve(0, 2, lost_every=999)
    text = NK.nuke_cornerpin(frames, height=HEIGHT, template_wh=(TW, TH), options=NK.NukeOptions(invert=True), header_lines=["hello"], linked="solve=tracks/t1/solve.v1.json trackId=t1")
    assert text.startswith("# hello\n# linked: solve=tracks/t1/solve.v1.json trackId=t1\nCornerPin2D {")
    p = NK.parse_nuke_cornerpin(text)
    assert p.comments == ["hello", "linked: solve=tracks/t1/solve.v1.json trackId=t1"]
    assert p.knobs["invert"] == "true"


def test_nuke_roundtrip_under_0_01px() -> None:
    solve, frames = fake_solve()
    text = NK.nuke_cornerpin(frames, height=HEIGHT, template_wh=(TW, TH), options=NK.NukeOptions(frame_offset=1))
    parsed = NK.parse_nuke_cornerpin(text)
    back = NK.corners_from_parsed_nuke(parsed, height=HEIGHT, frame_offset=1)
    want = {k: q for k, q in frames.items() if q is not None}
    assert set(back) == set(want)  # LOST 幀沒有 key
    err = max(float(np.abs(back[k] - want[k]).max()) for k in want)
    assert err < 0.01, err
    assert parsed.from_ == {1: (0.0, 0.0), 2: (630.0, 0.0), 3: (630.0, 880.0), 4: (0.0, 880.0)}


def test_nuke_parse_curve_implicit_frames() -> None:
    assert NK.parse_curve("x5 1.5 2.5 x9 3") == {5: 1.5, 6: 2.5, 9: 3.0}
    assert NK.format_curve([]) == "0"
    assert NK.format_curve([(1, 1.0), (2, 2.25)]) == "{curve x1 1 x2 2.25}"


def test_nuke_options_from_insert_params() -> None:
    from aivc.comp.params import InsertParams

    p = InsertParams.from_dict({"motionBlur": {"samples": 5, "shutterAngle": 90, "shutterPhase": "start"}, "resample": {"kernel": "bicubic", "clamp": False}})
    o = NK.options_from_insert(p, frame_offset=1)
    assert o.motionblur == 5 and abs(o.shutter - 0.25) < 1e-9 and o.shutteroffset == "start" and o.filter == "Cubic" and o.clamp is False
    o2 = NK.options_from_insert(InsertParams())  # samples auto → 1；180° → 0.5；lanczos3 → Lanczos4
    assert o2.motionblur == 1 and o2.shutter == 0.5 and o2.filter == "Lanczos4" and o2.shutteroffset == "centred"


# ---------------------------------------------------------------- AE


def test_ae_header_golden_and_fps_formatting() -> None:
    _s, frames = fake_solve(0, 2, lost_every=999)
    text = AE.ae_keyframes(frames, fps=(30000, 1001), width=WIDTH, height=HEIGHT, template_wh=(TW, TH))
    lines = text.splitlines()
    assert lines[0] == "Adobe After Effects 8.0 Keyframe Data"
    assert lines[1] == ""
    assert lines[2] == "\tUnits Per Second\t29.97"
    assert lines[3] == "\tSource Width\t1280" and lines[4] == "\tSource Height\t720"
    assert lines[5] == "\tSource Pixel Aspect Ratio\t1" and lines[6] == "\tComp Pixel Aspect Ratio\t1"
    assert lines[7] == ""
    assert lines[8] == "Effects\tADBE Corner Pin #1\tADBE Corner Pin-0002"
    assert lines[9] == "\tFrame\tX pixels\tY pixels\t"
    assert lines[10].startswith("\t0\t")  # AE 預設 frameOffset 0
    assert lines[-1] == "End of Keyframe Data"
    assert text.count("Effects\tADBE Corner Pin #1\tADBE Corner Pin-000") == 4
    assert "Transform\tPosition" not in text
    assert AE.format_fps(30, 1) == "30" and AE.format_fps(24000, 1001) == "23.976" and AE.format_fps(60000, 1001) == "59.94"


def test_ae_roundtrip_under_0_01px_and_corner_order_assumption() -> None:
    _s, frames = fake_solve()
    text = AE.ae_keyframes(frames, fps=(30, 1), width=WIDTH, height=HEIGHT, template_wh=(TW, TH), frame_offset=0)
    parsed = AE.parse_ae_keyframes(text)
    assert parsed.fps == 30.0 and parsed.width == WIDTH and parsed.height == HEIGHT
    back = AE.corners_from_parsed_ae(parsed, frame_offset=0)
    want = {k: q for k, q in frames.items() if q is not None}
    assert set(back) == set(want)
    err = max(float(np.abs(back[k] - want[k]).max()) for k in want)
    assert err < 0.01, err
    # [U] 順序假設寫死在 AE_CORNER_ORDER：0002=UL(TL) 0003=UR(TR) 0004=LL(BL) 0005=LR(BR)
    k = next(iter(want))
    q = want[k]
    assert parsed.corner_block("ADBE Corner Pin-0002")[k][:2] == pytest.approx(tuple(q[0]), abs=1e-3)
    assert parsed.corner_block("ADBE Corner Pin-0003")[k][:2] == pytest.approx(tuple(q[1]), abs=1e-3)
    assert parsed.corner_block("ADBE Corner Pin-0004")[k][:2] == pytest.approx(tuple(q[3]), abs=1e-3)
    assert parsed.corner_block("ADBE Corner Pin-0005")[k][:2] == pytest.approx(tuple(q[2]), abs=1e-3)


def test_ae_transform_flavour_blocks() -> None:
    _s, frames = fake_solve(0, 3, lost_every=999)
    text = AE.ae_keyframes(frames, fps=(30, 1), width=WIDTH, height=HEIGHT, template_wh=(TW, TH), flavour="cornerpin+transform")
    parsed = AE.parse_ae_keyframes(text)
    assert ("Transform", "Position") in parsed.blocks and ("Transform", "Scale") in parsed.blocks and ("Transform", "Rotation") in parsed.blocks
    pos = parsed.blocks[("Transform", "Position")][0]
    q = frames[0]
    assert pos[:2] == pytest.approx(tuple(q.mean(axis=0)), abs=1e-3) and pos[2] == 0.0
    assert parsed.columns[("Transform", "Position")] == ["X pixels", "Y pixels", "Z pixels"]
    with pytest.raises(ValueError):
        AE.ae_keyframes(frames, fps=(30, 1), width=WIDTH, height=HEIGHT, flavour="nope")
    with pytest.raises(ValueError):
        AE.parse_ae_keyframes("not ae\n")


# ---------------------------------------------------------------- op


def test_export_track_registered() -> None:
    load_all()
    assert "export.track" in REGISTRY and CLI_INDEX["export-track"].name == "export.track"


@pytest.fixture
def tmp_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Solve, dict]:
    """專案檔（media 沒有影片、但有指紋與 proxy 尺寸）+ 快取裡的 solve.v1.json。"""
    from aivc.project import paths as P
    from aivc.project import schema as S

    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    fp = "d171ec9031ba677f" + "0" * 48
    solve, frames = fake_solve()
    cache = P.media_cache(fp).ensure()
    solve.write(cache.solve("t1"), cache.solve("t1").with_name("solve.hud.v1.json"))
    project = S.ProjectFileV1(profile="cards")
    project.media.append(S.MediaV1(id="m1", path=str(tmp_path / "missing.webm"), name="missing.webm", fingerprint=fp, proxy=S.ProxyMetaV1(S.Rational(30, 1), 1797, WIDTH, HEIGHT, 1.0)))
    project.active_media_id = "m1"
    project.shots["m1"] = [S.ShotV1(id="s3", start_frame=926, end_frame=1358, kind="close")]
    project.tracks["m1"] = [S.TrackV1(id="t1", shot_id="s3", label="Player1", reference_frame=963, insert=S.InsertV1(macro="custom", motion_blur=S.MotionBlurV1(90.0, "centered", 4)))]
    p = tmp_path / "p.aivc.json"
    S.save(project, p)
    return p, solve, frames


def test_export_track_op_nuke_and_ae(tmp_project: tuple[Path, Solve, dict], tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    from aivc.cli import main

    p, solve, frames = tmp_project
    out = tmp_path / "t1.nk"
    code = main(["--json", "export-track", str(p), "--track", "t1", "--format", "nuke", "--linked", "-o", str(out)])
    lines = capsys.readouterr().out.strip().splitlines()
    final = json.loads(lines[-1])
    assert code == 0 and final["ok"], final
    r = final["result"]
    assert r["format"] == "nuke" and r["baked"] is False and r["frameOffset"] == 1 and r["keys"] == sum(1 for q in frames.values() if q is not None)
    text = out.read_text(encoding="utf-8")
    assert "# linked: solve=" in text and "trackId=t1" in text
    parsed = NK.parse_nuke_cornerpin(text)
    assert parsed.knobs["motionblur"] == "4" and parsed.knobs["shutter"] == "0.25"  # 90° → 0.25 幀，samples 4
    back = NK.corners_from_parsed_nuke(parsed, height=HEIGHT, frame_offset=1)
    err = max(float(np.abs(back[k] - frames[k]).max()) for k in back)
    assert err < 0.01
    # AE 走 --stdout：--json 模式文字在 result.text
    code = main(["--json", "export-track", str(p), "--track", "t1", "--format", "ae", "--stdout"])
    final = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0 and final["ok"]
    assert final["result"]["frameOffset"] == 0 and final["result"]["text"].startswith("Adobe After Effects 8.0 Keyframe Data")
    back2 = AE.corners_from_parsed_ae(AE.parse_ae_keyframes(final["result"]["text"]), frame_offset=0)
    assert max(float(np.abs(back2[k] - frames[k]).max()) for k in back2) < 0.01


def test_export_track_op_errors(tmp_project: tuple[Path, Solve, dict], tmp_path: Path) -> None:
    from aivc.ops.export_track import export_track_op

    p, _s, _f = tmp_project

    class Ctx:
        def progress(self, *a, **k): ...

        def log(self, *a, **k): ...

        def check_cancel(self): ...

        def artifact(self, *a, **k): ...

    with pytest.raises(OpError) as e:
        export_track_op({"project": str(p), "track": "nope", "out": str(tmp_path / "x.nk")}, Ctx())
    assert e.value.kind == "Invalid"
    with pytest.raises(OpError) as e:
        export_track_op({"project": str(p), "track": "t1", "solve": str(tmp_path / "missing.json"), "out": str(tmp_path / "x.nk")}, Ctx())
    assert e.value.kind == "Io"
