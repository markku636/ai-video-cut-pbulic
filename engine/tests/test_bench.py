"""aivc/bench + ops/bench：量尺（outside / jitter / corners / speed），全部用合成資料（不需要 GPU、不需要範例影片）。

- outside：來源 ffv1 小片 + 假渲染（只改四角內的 yuv 位元組）→ 通過；多改一塊四角外 → 失敗（ok=false、退出碼 1）；有損模式 PSNR 門檻；幀數對不上 → Invalid。
- jitter：STATIC 段同一個 H → 0；某幀動 0.01 px → 非零被抓到；TRACKING 段前/後只記錄。
- corners：手做 labels（等於 solve、偏 3 px、偏 20 px、循環位移、未解幀）的數學；格式錯 → Invalid。
- speed：真跑 shot-3 的 result fixture 通過；把 total/VRAM 改大 → 失敗；JSONL / 專案檔 → 正確拒絕。
牌局的量尺（bench-verify、label-auto）在 plugins/cards/engine/tests/test_bench_cards.py。
"""
from __future__ import annotations

import json
import math
import sys
from fractions import Fraction
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures" / "e1"))
import synth_scene as SC  # noqa: E402

from aivc import env  # noqa: E402
from aivc.bench import common as C  # noqa: E402
from aivc.bench import corners as BC  # noqa: E402
from aivc.bench import jitter as BJ  # noqa: E402
from aivc.bench import outside as BO  # noqa: E402
from aivc.bench import speed as BS  # noqa: E402
from aivc.geom import homography as hg  # noqa: E402
from aivc.media.source import FrameSource  # noqa: E402
from aivc.ops import CLI_INDEX, REGISTRY, OpError, load_all  # noqa: E402
from aivc.track.state import FrameSolve, Solve, State  # noqa: E402

FIX = Path(__file__).resolve().parent / "fixtures" / "bench"
N = 6
Q_P1 = SC.card_quad(250, 410, 122, 80)
Q_B1 = SC.card_quad(750, 412, 122, 80)


# ---------------------------------------------------------------- fixtures


@pytest.fixture(scope="module")
def scene(tmp_path_factory: pytest.TempPathFactory) -> dict:
    """N 幀靜止：兩塊平面（原圖）。frames 保留 rgb8 給假渲染用。量尺只看幾何（solve／遮罩），不需要插入來源。"""
    orig = SC.make_sign_rgba("orig")
    root = tmp_path_factory.mktemp("scene")
    frames = []
    for _k in range(N):
        img = SC.felt_frame()
        SC.paste_rgba(img, orig, Q_P1, shade=0.92)
        SC.paste_rgba(img, orig, Q_B1, shade=0.96)
        frames.append(img)
    video = SC.write_clip(root / "clip.mkv", frames)
    return {"root": root, "video": video, "frames": frames}


@pytest.fixture
def project(scene: dict, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    ppath, _proj, _cache = SC.make_project(
        scene["video"], N,
        [{"id": "t1", "quad": Q_P1, "name": "Player1"}, {"id": "t2", "quad": Q_B1, "name": "Banker1"}],
    )
    return ppath


def _decode_all(video: Path) -> list:
    with FrameSource(video) as fs:
        return [fs.get(i) for i in range(fs.n_frames)]


def _write_yuv_clip(path: Path, planes: list[tuple[np.ndarray, np.ndarray, np.ndarray]], fps: int = 30) -> Path:
    """直接寫 yuv420p 平面（不經 rgb 轉換）→ ffv1：假渲染要能精確控制哪些位元組動了。"""
    import av

    h, w = planes[0][0].shape
    with av.open(str(path), "w") as c:
        s = c.add_stream("ffv1", rate=fps)
        s.width, s.height = w, h
        s.pix_fmt = "yuv420p"
        s.codec_context.time_base = Fraction(1, fps)
        for i, (y, u, v) in enumerate(planes):
            arr = np.concatenate([y, u.reshape(-1, w), v.reshape(-1, w)], axis=0)
            f = av.VideoFrame.from_ndarray(np.ascontiguousarray(arr), format="yuv420p")
            f.pts = i
            f.time_base = Fraction(1, fps)
            for pkt in s.encode(f):
                c.mux(pkt)
        for pkt in s.encode():
            c.mux(pkt)
    return path


def _cli(argv: list[str], capsys: pytest.CaptureFixture[str]) -> tuple[int, dict]:
    from aivc.cli import main

    code = main(["--json", *argv])
    lines = capsys.readouterr().out.strip().splitlines()
    return code, json.loads(lines[-1])


@pytest.fixture(scope="module")
def ffmpeg_ready() -> None:
    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")


# ---------------------------------------------------------------- 註冊


def test_registered_and_frame_map_alias_intact() -> None:
    load_all()
    for cli, op in {"bench-outside": "bench.outside", "bench-jitter": "bench.jitter", "bench-corners": "bench.corners", "bench-speed": "bench.speed"}.items():
        assert CLI_INDEX[cli].name == op and op in REGISTRY
    assert CLI_INDEX["bench-frame-map"].name == "bench.frame_map"  # 在 bench_media.py，沒有被重複註冊
    from aivc.cli import build_parser

    build_parser().format_help()  # help 字串裡的 % 都要 escape，否則 argparse 會炸


# ---------------------------------------------------------------- common


def test_output_frame_offset_full_trim_and_mismatch() -> None:
    assert C.output_frame_offset(100, 100, None) == (0, (0, 100))
    assert C.output_frame_offset(100, 100, (10, 20)) == (0, (10, 20))
    assert C.output_frame_offset(10, 100, (10, 20)) == (10, (10, 20))  # --trim 的輸出
    with pytest.raises(ValueError):
        C.output_frame_offset(99, 100, None)
    with pytest.raises(ValueError):
        C.output_frame_offset(11, 100, (10, 20))


def test_psnr_masked_and_pool_and_dilate() -> None:
    a = np.zeros((8, 8), np.uint8)
    b = a.copy()
    b[0, 0] = 10
    keep = np.ones((8, 8), bool)
    sse, nd, n = C.sse_masked(a, b, keep)
    assert (sse, nd, n) == (100.0, 1, 64) and C.psnr_from_sse(sse, n) == pytest.approx(10 * math.log10(255**2 * 64 / 100))
    keep[0, 0] = False
    assert C.sse_masked(a, b, keep) == (0.0, 0, 63) and C.psnr_from_sse(0.0, 63) == math.inf
    m = np.zeros((8, 8), bool)
    m[4, 4] = True
    d = C.dilate_bool(m, 1)
    assert d.sum() == 9 and d[3, 3] and not d[2, 2]
    c = C.pool2x2_any(m)
    assert c.shape == (4, 4) and c[2, 2] and c.sum() == 1
    odd = C.pool2x2_any(np.ones((5, 7), bool), (3, 4))
    assert odd.shape == (3, 4) and odd.all()


def test_cyclic_corner_error_and_footprint() -> None:
    q = Q_P1
    assert C.cyclic_corner_error(q, q) == (0.0, 0)
    err, shift = C.cyclic_corner_error(q, np.roll(q, 1, axis=0))
    assert err == pytest.approx(0.0) and shift == 1  # roll(q,1) 再 roll(-1) 還原
    err, _ = C.cyclic_corner_error(q + [3.0, 0.0], q)
    assert err == pytest.approx(3.0)
    assert C.cyclic_corner_error(q, np.full((4, 2), np.nan))[0] == math.inf
    fp = C.quad_footprint(q, SC.W, SC.H)
    assert fp[450, 300] and not fp[400, 300] and abs(int(fp.sum()) - 122 * 80) <= 122 + 80 + 1  # cv2.fillPoly 含終點邊 → 123×81
    assert C.jsonable({"a": np.float32(1.5), "b": math.inf, "c": np.nan, "d": [np.int64(2)], "e": np.bool_(True)}) == {"a": 1.5, "b": "inf", "c": None, "d": [2], "e": True}
    assert C.runs([1, 2, 3, 7, 8, 10]) == [(1, 4), (7, 9), (10, 11)]


# ---------------------------------------------------------------- outside


def test_outside_pure_exclusion_and_compare() -> None:
    y = np.random.default_rng(0).integers(16, 235, (64, 64), dtype=np.uint8)
    u = np.random.default_rng(1).integers(16, 240, (32, 32), dtype=np.uint8)
    v = u.copy()
    out_y = y.copy()
    out_y[20:30, 20:30] += 5  # 只改四角內
    quad = SC.card_quad(20, 20, 10, 10)
    excl = BO.exclusion_mask(64, 64, [quad], [None], dilate_px=3)
    assert excl[25, 25] and excl[17, 17] and not excl[10, 10]
    r = BO.compare_outside((y, u, v), (out_y, u, v), excl)
    assert r["identical"] and r["psnr"] == math.inf and r["nDiffInside"] == 100 and r["nDiffOutside"] == 0
    out_y[0, 0] ^= 1
    r2 = BO.compare_outside((y, u, v), (out_y, u, v), excl)
    assert not r2["identical"] and r2["nDiffOutside"] == 1 and math.isfinite(r2["psnr"])
    s = BO.summarize([{**r, "k": 0}, {**r2, "k": 1}], lossless=True, min_psnr=45)
    assert not s["ok"] and s["failures"][0]["k"] == 1 and s["identicalFrames"] == 1
    s2 = BO.summarize([{**r, "k": 0}, {**r2, "k": 1}], lossless=False, min_psnr=45)
    assert s2["ok"]  # 一個像素差 1 → PSNR 遠高於 45
    with pytest.raises(ValueError):
        BO.exclusion_mask(64, 64, masks=[np.zeros((8, 8), bool)])


def test_bench_outside_lossless_pass_fail_and_mismatch(project: Path, scene: dict, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    src = _decode_all(scene["video"])
    fp = C.quad_footprint(Q_P1, SC.W, SC.H)
    inner = fp & ~C.dilate_bool(~fp, 2)  # 往內縮 2 px，避免動到色度區塊邊界外
    good, bad = [], []
    for fr in src:
        y = fr.y.copy()
        y[inner] = 200  # 只改牌內
        good.append((y, fr.u.copy(), fr.v.copy()))
        y2 = y.copy()
        y2[100:110, 100:110] = 235  # 四角外多動一塊
        bad.append((y2, fr.u.copy(), fr.v.copy()))
    good_p = _write_yuv_clip(tmp_path / "good.mkv", good)
    bad_p = _write_yuv_clip(tmp_path / "bad.mkv", bad)

    code, res = _cli(["bench-outside", str(project), "--render", str(good_p)], capsys)
    assert code == 0 and res["ok"], res
    r = res["result"]
    assert r["mode"] == "lossless" and r["codec"] == "ffv1" and r["frames"] == N and r["identicalFrames"] == N and r["compositedFrames"] == N
    assert all(f["psnr"] == "inf" and f["identical"] for f in r["rows"]) and r["tracks"][0]["hasSolve"] and r["tracks"][0]["hasMasks"]

    code, res = _cli(["bench-outside", str(project), "--render", str(bad_p)], capsys)
    assert code == 1 and not res["ok"], res
    r = res["result"]
    assert r["nFailures"] == N and r["failures"][0]["nDiffOutside"] == 100 and r["identicalFrames"] == 0
    # 有損模式：門檻低就過、門檻高就不過
    code, res = _cli(["bench-outside", str(project), "--render", str(bad_p), "--lossy", "--min-psnr", "30"], capsys)
    assert code == 0 and res["result"]["mode"] == "lossy" and res["result"]["minPsnr"] > 30
    code, res = _cli(["bench-outside", str(project), "--render", str(bad_p), "--lossy", "--min-psnr", "60"], capsys)
    assert code == 1
    # --range + --every 只比對子集合
    code, res = _cli(["bench-outside", str(project), "--render", str(good_p), "--range", "1:5", "--every", "2"], capsys)
    assert code == 0 and [f["k"] for f in res["result"]["rows"]] == [1, 3]
    # 幀數對不上 → Invalid（退出碼 2）
    short_p = _write_yuv_clip(tmp_path / "short.mkv", good[:3])
    code, res = _cli(["bench-outside", str(project), "--render", str(short_p)], capsys)
    assert code == 2 and res["error"]["kind"] == "Invalid"
    # --trim 的輸出：幀數 == K1−K0
    code, res = _cli(["bench-outside", str(project), "--render", str(short_p), "--range", "2:5"], capsys)
    assert code == 0 and res["result"]["offset"] == 2 and [f["k"] for f in res["result"]["rows"]] == [2, 3, 4]


# ---------------------------------------------------------------- jitter


def _solve_with(frames: dict[int, tuple[np.ndarray | None, State]], tid: str = "t") -> Solve:
    s = Solve(tid, (0, max(frames) + 1), 0, (630, 880))
    for k, (H, st) in frames.items():
        s.frames[k] = FrameSolve(k, H, 1.0 if H is not None else 0.0, st)
    return s


def test_jitter_static_zero_vs_perturbed_and_runs() -> None:
    H = hg.template_to_quad((630, 880), Q_P1)
    Hp = hg.template_to_quad((630, 880), Q_P1 + [0.01, 0.0])
    Hm = hg.template_to_quad((630, 880), Q_P1 + [40.0, 0.0])
    good = _solve_with({k: (H.copy(), State.STATIC) for k in range(10)})
    rep = BJ.jitter_report(good)
    assert rep["ok"] and rep["static"]["secondDiffMax"] == 0.0 and rep["staticRuns"][0]["len"] == 10
    bad = _solve_with({**{k: (H.copy(), State.STATIC) for k in range(10)}, 5: (Hp, State.STATIC)})
    rep = BJ.jitter_report(bad)
    assert not rep["ok"] and rep["static"]["secondDiffMax"] == pytest.approx(0.02, abs=1e-6) and rep["failures"][0]["k0"] == 0
    # 狀態段切分：LOST（H None）與 TRACKING 斷段；短段不算
    mixed = _solve_with({0: (H, State.STATIC), 1: (H, State.STATIC), 2: (None, State.LOST), 3: (H, State.TRACKING), 4: (Hm, State.TRACKING), 5: (H, State.TRACKING), 6: (H, State.STATIC), 7: (H, State.STATIC), 8: (H, State.STATIC)})
    assert BJ.state_runs(mixed.frames) == [(2, 0, 2), (1, 3, 6), (2, 6, 9)]
    rep = BJ.jitter_report(mixed)
    assert rep["ok"] and rep["staticRunsTooShort"] == 1 and len(rep["staticRuns"]) == 1 and rep["tracking"]["after"]["secondDiffMax"] > 10
    hud = {k: {"cornersRaw": (hg.quad_from_h(H, (630, 880)) + [0.5 * (k % 2), 0]).tolist()} for k in range(3, 6)}
    rep = BJ.jitter_report(mixed, hud)
    assert rep["tracking"]["before"]["secondDiffMax"] == pytest.approx(1.0)
    assert BJ.diff_stats(np.zeros((2, 4, 2))) is None and BJ.second_diff(np.zeros((2, 4, 2))).shape == (0, 4, 2)


def test_bench_jitter_op_on_project(project: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code, res = _cli(["bench-jitter", str(project)], capsys)
    assert code == 0 and res["ok"], res
    r = res["result"]
    assert set(r["tracks"]) == {"t1", "t2"} and r["tracks"]["t1"]["static"]["secondDiffMax"] == 0 and r["threshold"]["staticSecondDiffMax"] == 0
    # 把 t2 的一幀動 0.05 px → 失敗、退出碼 1
    from aivc.project import resolve as R

    mctx = R.open_media_context(project, None, SC.RecordingCtx())
    sp = mctx.cache.solve("t2")
    s = Solve.read(sp)
    s.frames[3].H = hg.template_to_quad((630, 880), Q_B1 + [0.05, 0.0])
    s.write(sp)
    code, res = _cli(["bench-jitter", str(project), "--track", "t2"], capsys)
    assert code == 1 and not res["ok"] and res["result"]["failures"][0]["track"] == "t2"


# ---------------------------------------------------------------- corners


def test_corners_labels_format_and_evaluate() -> None:
    H = hg.template_to_quad((630, 880), Q_P1)
    solve = _solve_with({**{k: (H, State.STATIC) for k in range(6)}, 6: (H, State.TRACKING), 7: (None, State.LOST)}, "t1")
    labels, meta = BC.parse_labels(
        {
            "version": 1,
            "source": "human",
            "frames": [
                {"k": 0, "track": "t1", "quad": Q_P1.tolist()},
                {"k": 1, "track": "t1", "quad": (Q_P1 + [3.0, 0.0]).tolist(), "note": "偏 3"},
                {"k": 2, "track": "t1", "quad": np.roll(Q_P1, 2, axis=0).tolist()},  # 循環位移 → 0
                {"k": 6, "track": "t1", "quad": (Q_P1 + [0.0, 20.0]).tolist()},  # tracking 幀偏 20
                {"k": 7, "track": "t1", "quad": Q_P1.tolist()},  # LOST → 未解 = miss
                {"k": 0, "track": "ghost", "quad": Q_P1.tolist()},  # 專案沒有的 track
            ],
        }
    )
    assert meta["source"] == "human" and labels[1].extra == {"note": "偏 3"}
    ev = BC.evaluate(labels, {"t1": solve, "ghost": None}, {"t1": "close"})
    assert ev["labels"] == 6 and ev["unsolved"] == 2 and ev["unknownTracks"] == ["ghost"]
    assert ev["static"] == 3 and ev["staticMean"] == pytest.approx(1.0) and ev["p1"] == pytest.approx(2 / 3)
    assert ev["moving"] == 6 and ev["p5"] == pytest.approx(3 / 6) and ev["p15"] == pytest.approx(3 / 6)
    assert not ev["ok"] and ev["checks"] == {"p5": False, "p15": False, "staticMean": True, "wide": None}
    assert [f["k"] for f in ev["failures"]][:2] == [7, 0]  # 未解的先列
    # 全部命中 → ok；遠景門檻 = 4% 長邊（122 → 4.88 px）
    good = [labels[0], labels[2]]
    ev2 = BC.evaluate(good, {"t1": solve}, {"t1": "wide"})
    assert ev2["ok"] and ev2["wide"] == 2 and ev2["pWide"] == 1.0 and ev2["checks"]["wide"] is True
    ev3 = BC.evaluate([labels[1]], {"t1": solve}, {"t1": "wide"}, wide_frac=0.02)  # 2.44 px < 3 px → 遠景不過
    assert not ev3["ok"] and ev3["checks"]["wide"] is False and ev3["checks"]["p5"] is True
    for bad in ({"frames": "x"}, {"version": 2, "frames": []}, {"frames": [{"k": -1, "track": "t", "quad": Q_P1.tolist()}]}, {"frames": [{"k": 0, "track": "", "quad": Q_P1.tolist()}]}, {"frames": [{"k": 0, "track": "t", "quad": [[1, 2]]}]}):
        with pytest.raises(ValueError):
            BC.parse_labels(bad)
    doc = BC.labels_document(good, source="detector", project="p")
    assert doc["source"] == "detector" and "warning" in doc and len(doc["frames"]) == 2 and doc["frames"][0]["quad"] == Q_P1.tolist()


def test_bench_corners_op(project: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    # 手做 labels：t1 等於 solve、t2 偏 2 px → 都在 p@5 內、static 平均 1.0 px → PASS
    labels = {"version": 1, "source": "human", "frames": [{"k": 1, "track": "t1", "quad": Q_P1.tolist()}, {"k": 2, "track": "t2", "quad": (Q_B1 + [2.0, 0.0]).tolist()}]}
    lp = tmp_path / "labels.json"
    lp.write_text(json.dumps(labels), encoding="utf-8")
    code, res = _cli(["bench-corners", str(project), "--labels", str(lp)], capsys)
    assert code == 0 and res["ok"], res
    r = res["result"]
    assert r["p5"] == 1.0 and r["p15"] == 1.0 and r["staticMean"] == pytest.approx(1.0) and r["labelsSource"] == "human" and r["perTrack"]["t2"]["maxErr"] == pytest.approx(2.0)
    code, res = _cli(["bench-corners", str(project), "--labels", str(lp), "--static-mean", "0.5"], capsys)
    assert code == 1 and res["result"]["checks"]["staticMean"] is False
    lp.write_text('{"frames": "nope"}', encoding="utf-8")
    code, res = _cli(["bench-corners", str(project), "--labels", str(lp)], capsys)
    assert code == 2 and res["error"]["kind"] == "Invalid"


# ---------------------------------------------------------------- speed


def test_speed_pure_and_op(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    fixture = FIX / "run_result_shot3.json"
    res = BS.load_run_result(fixture.read_text(encoding="utf-8"))
    assert res["timings"]["total"] == 255.739 and res["gpu"]["maxMemoryAllocatedMB"] == 3743.9
    chk = BS.check_speed(res, fps=30.0)
    assert chk["ok"] and chk["durationSeconds"] == pytest.approx(1797 / 30) and chk["limitSeconds"] == pytest.approx(299.5) and chk["slowest"][0]["stage"] == "track"
    assert any("1 個鏡頭" in n for n in chk["notes"]) and chk["vramKnown"]
    slow = {**res, "timings": {**res["timings"], "total": 400.0}}
    assert not BS.check_speed(slow, fps=30.0)["ok"] and BS.check_speed(slow, fps=30.0)["checks"] == {"time": False, "vram": True}
    big = {**res, "gpu": {"maxMemoryAllocatedMB": 13000}}
    assert not BS.check_speed(big, fps=30.0)["ok"]
    nogpu = {**res, "gpu": {"maxMemoryAllocatedMB": None}}
    c = BS.check_speed(nogpu)
    assert c["ok"] and not c["vramKnown"] and c["checks"]["vram"] is None and c["limitSeconds"] == 300.0
    # JSONL：最後一行才是 result
    jl = tmp_path / "run.jsonl"
    jl.write_text('{"id":"cli","event":"progress","stage":"x","done":1,"total":2}\n' + fixture.read_text(encoding="utf-8").replace("\n", "") + "\n", encoding="utf-8")
    assert BS.load_run_result(jl.read_text(encoding="utf-8"))["frames"] == 1797
    with pytest.raises(ValueError):
        BS.check_speed({"schemaVersion": 1, "media": []})
    with pytest.raises(ValueError):
        BS.load_run_result("")
    # op：fixture 的 result.project 指到不存在的路徑 → 沒 fps → 用 300 s 原值並註明；--fps 給了就等比
    code, res = _cli(["bench-speed", str(fixture)], capsys)
    assert code == 0 and res["ok"] and res["result"]["totalSeconds"] == 255.739 and res["result"]["fpsSource"] is None and res["result"]["limitSeconds"] == 300.0
    code, res = _cli(["bench-speed", str(jl), "--fps", "30"], capsys)
    assert code == 0 and res["result"]["fpsSource"] == "--fps" and res["result"]["limitSeconds"] == pytest.approx(299.5)
    code, res = _cli(["bench-speed", str(fixture), "--max-seconds", "100"], capsys)
    assert code == 1 and not res["ok"] and "總時間" in res["result"]["failures"][0]
    proj = tmp_path / "p.aivc.json"
    proj.write_text('{"schemaVersion": 1, "media": []}', encoding="utf-8")
    code, res = _cli(["bench-speed", str(proj)], capsys)
    assert code == 2 and "timings" in res["error"]["message"]
