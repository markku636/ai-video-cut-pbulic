"""ops/render（核心、通用插入）：合成小影片（PyAV ffv1）→ 渲染計畫 → 逐幀生成器（遮罩外逐位元相同、範圍外整幀相同）→ ffmpeg ffv1 輸出
（幀數／時長相同、範圍外解回來逐位元相同、確定性）、--trim、--emit-matte/--emit-faces、render-plan / --dry-run；
插入來源掛勾（hooks insert-source）：沒有來源 → 每條 track 都跳過、第一個接手的來源勝出、TrackJob 子類別的逐幀掛勾順序。

核心沒有任何插入來源：這裡用測試外掛 fixtures/plugins/aivc_test_insert（貼圖）。牌局版在 plugins/cards/engine/tests/test_render_cards.py。"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures" / "e1"))
import synth_scene as SC  # noqa: E402

from aivc import env, hooks  # noqa: E402
from aivc.media import encoder as EN  # noqa: E402
from aivc.media import encode_plan as EP  # noqa: E402
from aivc.media.source import FrameSource  # noqa: E402
from aivc.ops import CLI_INDEX, REGISTRY, OpError, load_all  # noqa: E402
from aivc.ops import render as RD  # noqa: E402
from aivc.project import resolve as R  # noqa: E402

N = 8
Q_P1 = SC.card_quad(250, 410, 122, 80)
Q_B1 = SC.card_quad(750, 412, 122, 80)


@pytest.fixture(scope="module")
def signs(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path]:
    return SC.write_sign_pngs(tmp_path_factory.mktemp("signs"))


@pytest.fixture(scope="module")
def scene(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Any]:
    """8 幀：兩塊「原圖」平面（都靜止）；第 5 幀 t1 上蓋一塊「手」（遮罩減掉）。"""
    import cv2

    orig = SC.make_sign_rgba("orig")
    root = tmp_path_factory.mktemp("scene")
    frames = []
    occluders = {}
    for k in range(N):
        img = SC.felt_frame()
        SC.paste_rgba(img, orig, Q_P1, shade=0.92)
        SC.paste_rgba(img, orig, Q_B1, shade=0.96)
        if k == 5:
            cv2.circle(img, (300, 450), 22, (205, 160, 140), -1)
            occ = np.zeros((SC.H, SC.W), bool)
            cv2.circle(occ.view(np.uint8), (300, 450), 22, 1, -1)
            occluders[k] = occ
        frames.append(img)
    video = SC.write_clip(root / "clip.mkv", frames)
    return {"root": root, "video": video, "frames": frames, "occluders": occluders}


@pytest.fixture
def project(scene: dict[str, Any], signs: tuple[Path, Path], image_insert: Any, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    new, orig = signs
    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    ppath, _proj, _cache = SC.make_project(
        scene["video"], N,
        [
            {"id": "t1", "quad": Q_P1, "image": new, "original": orig, "name": "Player1", "occluders": scene["occluders"]},
            {"id": "t2", "quad": Q_B1, "image": None, "original": orig, "name": "Banker1"},
        ],
    )
    return ppath


@pytest.fixture(scope="module")
def ffmpeg_ready() -> None:
    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")


def _mctx(ppath: Path):
    return R.open_media_context(ppath, None, SC.RecordingCtx())


def _decode_all(video: Path) -> list:
    with FrameSource(video) as fs:
        return [fs.get(i) for i in range(fs.n_frames)]


def test_registered() -> None:
    load_all()
    assert CLI_INDEX["render"].name == "render.run" and CLI_INDEX["render-plan"].name == "render.plan"
    assert "render.plan" in REGISTRY


def test_parse_range_and_audio_input_args() -> None:
    assert RD.parse_range(None, 10) is None and RD.parse_range("2:5", 10) == (2, 5) and RD.parse_range("-3:99", 10) == (0, 10)
    for bad in ("5:2", "x:y", "3"):
        with pytest.raises(OpError):
            RD.parse_range(bad, 10)
    plan = EP.plan(EP.EncodeSpec(container="mkv", codec="ffv1"), EP.SourceInfo("webm", 64, 48, 30, 1, True, "opus"), {"ffv1"})
    args = EN.ffmpeg_args(plan, width=64, height=48, fps=(30, 1), out_part="o.mkv.part", audio_source="in.webm", audio_input_args=["-ss", "1.0", "-t", "0.5"])
    s = " ".join(args)
    assert "-ss 1.0 -t 0.5 -i in.webm" in s and s.index("-ss 1.0") > s.index("pipe:0")


def test_build_plan_jobs_and_skips(project: Path, ffmpeg_ready: None, tmp_path: Path) -> None:
    mctx = _mctx(project)
    ctx = SC.RecordingCtx()
    plan = RD.build_plan(mctx, ctx, out=str(tmp_path / "o.mkv"), codec="ffv1", gpu=False)
    assert plan.encode.video_codec == "ffv1" and plan.encode.audio_mode == "none"  # 合成片沒音軌
    assert [j.track.id for j in plan.jobs] == ["t1"] and plan.skipped == [{"trackId": "t2", "reason": "testInsert 沒有 image（不替換）"}]
    j = plan.jobs[0]
    assert type(j) is RD.TrackJob  # 沒指定 job_cls → 核心的 TrackJob
    assert j.target == "card" and j.target_code == "new" and j.original == "orig" and j.rotation == 0 and j.get_mask is not None
    assert j.template_wh == SC.TEMPLATE_WH and j.H_scale is None and j.degrader is not None and j.degrader.surface_check is None
    assert len(j.frames) == N and plan.n_write == N and plan.n_composite == N
    d = plan.to_json()
    assert d["frames"] == {"total": N, "write": N, "composite": N} and d["tracks"][0]["slot"] == "Player1"
    # 核心的計畫 JSON 每條 track 沒有外掛的鍵（外掛 job 子類別才會加）
    assert list(d["tracks"][0]) == ["id", "shot", "kind", "slot", "target", "original", "rotation", "regionPolicy", "macro", "frames", "masks", "composited", "held", "lost", "coarse", "faded"]
    # --range 只限制合成、不限制寫出；--trim 才裁
    p2 = RD.build_plan(mctx, ctx, out=str(tmp_path / "o.mkv"), codec="ffv1", gpu=False, range_spec="2:5")
    assert p2.n_write == N and p2.n_composite == 3 and p2.range == (2, 5) and not p2.trim
    p3 = RD.build_plan(mctx, ctx, out=str(tmp_path / "o.mkv"), codec="ffv1", gpu=False, range_spec="2:5", trim=True)
    assert p3.n_write == 3 and p3.write_range == (2, 5)


def test_render_frames_outside_mask_byte_identical(project: Path, ffmpeg_ready: None, tmp_path: Path) -> None:
    """編碼前：範圍外整幀位元相同；範圍內只有平面附近改變；遮擋處（手）不被畫過去。"""
    import cv2

    mctx = _mctx(project)
    ctx = SC.RecordingCtx()
    plan = RD.build_plan(mctx, ctx, out=str(tmp_path / "o.mkv"), codec="ffv1", gpu=False, range_spec="2:6")
    src = _decode_all(mctx.video)
    out = list(RD.render_frames(mctx, plan, ctx))
    assert len(out) == N
    near = cv2.dilate(SC.quad_mask(Q_P1).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
    near_c = near.reshape(SC.H // 2, 2, SC.W // 2, 2).any(axis=(1, 3))
    for k in range(N):
        s, o = src[k], out[k]
        if not (2 <= k < 6):
            assert o is s or (np.array_equal(o.y, s.y) and np.array_equal(o.u, s.u) and np.array_equal(o.v, s.v)), k
            continue
        assert not np.array_equal(o.y, s.y), k  # 真的有合成
        assert np.array_equal(o.y[~near], s.y[~near]) and np.array_equal(o.u[~near_c], s.u[~near_c]) and np.array_equal(o.v[~near_c], s.v[~near_c]), k
    # 第 5 幀：手的中心像素不能被新面覆蓋（遮擋 alpha）
    hand = (slice(445, 455), slice(295, 305))
    assert np.array_equal(out[5].y[hand], src[5].y[hand])
    assert plan.jobs[0].composited == 4 and plan.jobs[0].lost == 0


def test_render_op_ffv1_roundtrip_same_frames_and_untouched_bytes(project: Path, ffmpeg_ready: None, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    from aivc.cli import main

    out = tmp_path / "out.mkv"
    code = main(["--json", "render", str(project), "-o", str(out), "--codec", "ffv1", "--no-gpu", "--range", "1:4", "--seed", "3"])
    lines = capsys.readouterr().out.strip().splitlines()
    final = json.loads(lines[-1])
    assert code == 0 and final["ok"], final
    r = final["result"]
    assert r["frames"] == N and r["encoder"] == "ffv1" and r["tracks"][0]["composited"] == 3 and out.is_file() and not list(tmp_path.glob("out.mkv*.part"))
    events = [json.loads(line) for line in lines[:-1]]
    assert any(e.get("event") == "progress" and e.get("stage") == "render" and e.get("done") == N for e in events)
    assert any(e.get("event") == "artifact" and e.get("kind") == "render" for e in events)
    src = _decode_all(_mctx(project).video)
    dec = _decode_all(out)
    assert len(dec) == N and (dec[0].pts_ms, dec[-1].pts_ms) == (src[0].pts_ms, src[-1].pts_ms)  # 時長相同
    for k in range(N):
        same = np.array_equal(dec[k].y, src[k].y) and np.array_equal(dec[k].u, src[k].u) and np.array_equal(dec[k].v, src[k].v)
        assert same == (not 1 <= k < 4), k  # ffv1 無損：範圍外逐位元相同、範圍內有變


def test_render_deterministic_and_trim(project: Path, ffmpeg_ready: None, tmp_path: Path) -> None:
    mctx = _mctx(project)
    ctx = SC.RecordingCtx()
    outs = []
    for i in range(2):
        plan = RD.build_plan(mctx, ctx, out=str(tmp_path / f"d{i}.mkv"), codec="ffv1", gpu=False, seed=11)
        RD.run_render(mctx, plan, ctx)
        outs.append(_decode_all(tmp_path / f"d{i}.mkv"))
    for a, b in zip(*outs):
        assert np.array_equal(a.y, b.y) and np.array_equal(a.u, b.u) and np.array_equal(a.v, b.v)
    plan = RD.build_plan(mctx, ctx, out=str(tmp_path / "trim.mkv"), codec="ffv1", gpu=False, range_spec="2:6", trim=True)
    info = RD.run_render(mctx, plan, ctx)
    assert info["frames"] == 4 and info["trim"] is True and len(_decode_all(tmp_path / "trim.mkv")) == 4


def test_render_emit_matte_and_faces(project: Path, ffmpeg_ready: None, tmp_path: Path) -> None:
    import cv2

    mctx = _mctx(project)
    ctx = SC.RecordingCtx()
    plan = RD.build_plan(mctx, ctx, out=str(tmp_path / "m.mkv"), codec="ffv1", gpu=False, range_spec="0:2", emit_matte=str(tmp_path / "matte"), emit_faces=str(tmp_path / "faces"))
    list(RD.render_frames(mctx, plan, ctx))
    m = cv2.imread(str(tmp_path / "matte" / "t1" / "000000.png"), cv2.IMREAD_GRAYSCALE)
    assert m is not None and m.shape == (SC.H, SC.W) and m.max() == 255 and m[450, 300] > 200 and m[100, 100] == 0
    f = cv2.imread(str(tmp_path / "faces" / "t1" / "000001.png"))
    assert f is not None and f.shape == (440, 315, 3)  # 模板一半
    assert not (tmp_path / "matte" / "t1" / "000002.png").exists()


def test_render_plan_op_and_dry_run(project: Path, ffmpeg_ready: None, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    from aivc.cli import main

    code = main(["--json", "render-plan", str(project), "-o", str(tmp_path / "x.mkv"), "--codec", "ffv1", "--no-gpu"])
    final = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0 and final["result"]["encode"]["video_codec"] == "ffv1" and final["result"]["tracks"][0]["id"] == "t1"
    assert not (tmp_path / "x.mkv").exists()
    code = main(["--json", "render", str(project), "-o", str(tmp_path / "y.mkv"), "--codec", "ffv1", "--no-gpu", "--dry-run"])
    final = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0 and final["result"]["dryRun"] is True and not (tmp_path / "y.mkv").exists()
    # webm 目標 + 沒 NVENC 要 hevc_nvenc → Invalid（webm 沒 H.264 fallback）
    with pytest.raises(OpError):
        RD.build_plan(_mctx(project), SC.RecordingCtx(), out=str(tmp_path / "z.webm"), codec="hevc_nvenc", gpu=False)


def test_render_cancel_cleans_part(project: Path, ffmpeg_ready: None, tmp_path: Path) -> None:
    from aivc.ops import Canceled

    mctx = _mctx(project)
    plan = RD.build_plan(mctx, SC.RecordingCtx(), out=str(tmp_path / "c.mkv"), codec="ffv1", gpu=False)
    with pytest.raises(Canceled):
        RD.run_render(mctx, plan, SC.RecordingCtx(cancel_after=6))
    assert not (tmp_path / "c.mkv").exists() and not list(tmp_path.glob("c.mkv*.part"))  # .part 是唯一名 <out>.<pid>-<hex>.part（B-09）


# ---------------------------------------------------------------- 插入來源掛勾


def test_no_insert_source_skips_every_track_and_output_is_the_source(project: Path, ffmpeg_ready: None, tmp_path: Path) -> None:
    """開源版的樣子：沒有任何插入來源 → 每條 track 都跳過（核心的通用原因）、逐幀輸出就是來源（同一個物件）。"""
    with hooks.suspended():
        mctx = _mctx(project)
        ctx = SC.RecordingCtx()
        plan = RD.build_plan(mctx, ctx, out=str(tmp_path / "n.mkv"), codec="ffv1", gpu=False)
        assert plan.jobs == [] and plan.skipped == [{"trackId": "t1", "reason": RD.NO_SOURCE_REASON}, {"trackId": "t2", "reason": RD.NO_SOURCE_REASON}]
        assert any(level == "warn" and "沒有任何 track 可合成" in msg for level, msg in ctx.logs)
        src = _decode_all(mctx.video)
        out = list(RD.render_frames(mctx, plan, ctx))
        assert all(np.array_equal(o.y, s.y) and np.array_equal(o.u, s.u) and np.array_equal(o.v, s.v) for o, s in zip(out, src))


class _Recorder(RD.TrackJob):
    """記下核心在每一幀依序呼叫了哪些掛勾。"""

    calls: list[tuple[int, str]]

    def frame_params(self, k, dec, params, H_prev, H_next):  # noqa: ANN001, ANN201
        self.calls.append((k, "params"))
        return params, H_prev, H_next

    def frame_face(self, k, dec):  # noqa: ANN001, ANN201
        self.calls.append((k, "face"))
        return super().frame_face(k, dec)

    def frame_visibility(self, k, dec, H, own_mask, alpha_vis, env_):  # noqa: ANN001, ANN201
        self.calls.append((k, "visibility"))
        assert env_.k == k and env_.plan is not None and env_.mask_of(self) is own_mask
        return alpha_vis, None

    def before_composite(self, k, dec, H):  # noqa: ANN001, ANN201
        self.calls.append((k, "before"))

    def composite_kwargs(self, k, dec, face):  # noqa: ANN001, ANN201
        self.calls.append((k, "kwargs"))
        return {}

    def after_composite(self, k, dec, face):  # noqa: ANN001, ANN201
        self.calls.append((k, "after"))

    def ext_json(self) -> dict[str, Any]:
        return {"recorded": len(self.calls)}


class _Source:
    """測試來源：claim 的回答由建構時決定；build 交回貼圖、可指定 job 子類別。"""

    def __init__(self, answers: dict[str, Any], job_cls: type | None = None, image: Path | None = None) -> None:
        self.answers = answers
        self.job_cls = job_cls
        self.image = image
        self.built: list[str] = []
        self.setup: list[list[str]] = []

    def claim(self, mctx, track, session):  # noqa: ANN001, ANN201
        return self.answers.get(track.id)

    def build(self, mctx, ctx, track, shot, solve, claim, session):  # noqa: ANN001, ANN201
        import aivc_test_insert as TI

        self.built.append(track.id)
        wh = tuple(solve.template_wh)
        tmpl = TI.load_template(str(self.image), wh)
        return RD.InsertSpec(slot=TI.Binding(f"{claim}"), params=R.insert_params_for(track, mctx.project), target="card", target_code="x", original=None, rotation=0, tmpl_new=tmpl, tmpl_orig=None, template_wh=wh, job_cls=self.job_cls)

    def setup_jobs(self, jobs, mctx, ctx, session):  # noqa: ANN001, ANN201
        self.setup.append([j.track.id for j in jobs])
        for j in jobs:
            if isinstance(j, _Recorder):
                j.calls = []


def test_first_claiming_source_wins_and_skip_reason_falls_back(project: Path, signs: tuple[Path, Path], ffmpeg_ready: None, tmp_path: Path) -> None:
    new, _orig = signs
    a = _Source({"t1": RD.InsertSkip("A 不換"), "t2": RD.InsertSkip("A 不換 t2")}, image=new)
    b = _Source({"t1": "B"}, image=new)
    with hooks.suspended():
        hooks.add("insert-source", a, owner="test")
        hooks.add("insert-source", b, owner="test")
        plan = RD.build_plan(_mctx(project), SC.RecordingCtx(), out=str(tmp_path / "s.mkv"), codec="ffv1", gpu=False)
    # t1：A 說不換、B 接手 → B 勝出；t2：沒人接手 → 第一個 InsertSkip 的原因
    assert [j.track.id for j in plan.jobs] == ["t1"] and plan.jobs[0].slot.name == "B"
    assert plan.skipped == [{"trackId": "t2", "reason": "A 不換 t2"}]
    assert a.built == [] and b.built == ["t1"]
    # setup_jobs：每個來源都會被叫到（沒有 job 也叫），只拿到自己的 job
    assert a.setup == [[]] and b.setup == [["t1"]]


def test_track_job_subclass_hooks_run_in_order_per_frame(project: Path, signs: tuple[Path, Path], ffmpeg_ready: None, tmp_path: Path) -> None:
    new, _orig = signs
    src = _Source({"t1": "rec"}, job_cls=_Recorder, image=new)
    with hooks.suspended():
        hooks.add("insert-source", src, owner="test")
        mctx = _mctx(project)
        ctx = SC.RecordingCtx()
        plan = RD.build_plan(mctx, ctx, out=str(tmp_path / "h.mkv"), codec="ffv1", gpu=False, range_spec="2:4")
        out = list(RD.render_frames(mctx, plan, ctx))
    j = plan.jobs[0]
    assert isinstance(j, _Recorder) and len(out) == N
    per_frame = ["params", "face", "visibility", "before", "kwargs", "after"]
    assert [c for k, c in j.calls if k == 2] == per_frame and [c for k, c in j.calls if k == 3] == per_frame
    assert {k for k, _ in j.calls} == {2, 3}
    assert plan.to_json()["tracks"][0]["recorded"] == len(j.calls)  # ext_json 接在核心的鍵後面
