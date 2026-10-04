"""track.solve / seg.run 的幀號必須是 CFR proxy 幀號 k（計畫決策 3；review #20），
以及 track.solve 子範圍重解要併進既有 solve、不能把範圍外的幀刪光（review #19）。

測試影片用 PyAV 現做：40 幀、第 12 幀後面挖 1.2 s 的洞（跟範例影片一樣的 VFR 斷層），CfrMap 會多出 ~36 個定格幀。
每幀把自己的「來源幀號」用 8 個黑白方塊畫進畫面，op 拿到第 k 幀時解回來的號碼必須等於 cfr.src_index(k)。
SIFT/ECC 與 SAM 2.1 都換成假的（只記錄收到哪一幀），所以這支測試不需要 GPU、也不依賴追蹤品質。
"""
from __future__ import annotations

import json
from fractions import Fraction
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

av = pytest.importorskip("av")
cv2 = pytest.importorskip("cv2")

from aivc.ops import load_all  # noqa: E402
from aivc.ops._ctx import CliCtx  # noqa: E402

W, H = 96, 64
N_SRC = 40
HOLE_AFTER = 12
BLOCK = 12


def _pixels(i: int) -> np.ndarray:
    img = np.zeros((H, W, 3), np.uint8)
    for b in range(8):
        if (i >> b) & 1:
            img[: H // 2, b * BLOCK : (b + 1) * BLOCK] = 255
    img[H // 2 :, :] = 128
    return img


def decode_number(rgb: np.ndarray) -> int:
    return sum(1 << b for b in range(8) if rgb[H // 4, b * BLOCK + BLOCK // 2].mean() > 127)


def _write_vfr(path: Path) -> None:
    with av.open(str(path), "w", format="matroska") as c:
        s = c.add_stream("libx264", rate=30)
        s.width, s.height = W, H
        s.pix_fmt = "yuv420p"
        s.time_base = Fraction(1, 1000)
        s.codec_context.time_base = Fraction(1, 1000)
        # GOP 8：讓反向走（backward pass）真的要跨關鍵幀 seek
        s.options = {"bf": "0", "crf": "10", "g": "8", "keyint_min": "8", "sc_threshold": "0"}
        t = 0
        for i in range(N_SRC):
            fr = av.VideoFrame.from_ndarray(_pixels(i), format="rgb24").reformat(format="yuv420p")
            fr.pts = t
            fr.time_base = Fraction(1, 1000)
            for p in s.encode(fr):
                c.mux(p)
            t += 33 if i % 3 else 34
            if i == HOLE_AFTER:
                t += 1200  # 1.2 s 斷層 → proxy 定格
        for p in s.encode():
            c.mux(p)


@pytest.fixture(scope="module")
def cache_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return tmp_path_factory.mktemp("aivc-cache-proxy")


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch, cache_dir: Path) -> None:
    monkeypatch.setenv("AIVC_CACHE_DIR", str(cache_dir))


@pytest.fixture(scope="module")
def vfr_clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    p = tmp_path_factory.mktemp("vfr") / "vfr_hole.mkv"
    try:
        _write_vfr(p)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"PyAV 無法編出 libx264/matroska 測試片：{e}")
    return p


@pytest.fixture(scope="module")
def cfr(vfr_clip: Path, cache_dir: Path) -> Any:
    from aivc.ops import media as M

    with pytest.MonkeyPatch.context() as mp:  # module fixture 拿不到 function 級 monkeypatch；結束要還原環境變數
        mp.setenv("AIVC_CACHE_DIR", str(cache_dir))
        ctx = CliCtx()
        mc, pr = M.open_media(str(vfr_clip), ctx)
        idx, m, _ = M.ensure_index(str(vfr_clip), mc, pr, ctx)
    assert idx.n == N_SRC
    assert m.n_frames > idx.n and m.duplicate_count >= 30, "測試片要有 VFR 斷層，否則測不出來源序號／proxy 序號的差別"
    return m


@pytest.fixture()
def template_png(tmp_path: Path) -> Path:
    p = tmp_path / "tpl.png"
    cv2.imwrite(str(p), np.full((28, 20, 3), 200, np.uint8))
    return p


# ---------------------------------------------------------------- ProxyFrames


def test_proxy_frames_follow_cfr_map_both_directions(vfr_clip: Path, cfr: Any) -> None:
    from aivc.ops.track import ProxyFrames

    with ProxyFrames(str(vfr_clip), CliCtx()) as fr:
        assert fr.n == cfr.n_frames and (fr.width, fr.height) == (W, H)
        fwd = {k: decode_number(rgb) for k, rgb in fr.iter_frames(0, fr.n)}
        bwd = {k: decode_number(rgb) for k, rgb in fr.iter_frames_reversed(0, fr.n)}
    expect = {k: cfr.src_index(k) for k in range(cfr.n_frames)}
    assert fwd == expect
    assert bwd == expect


# ---------------------------------------------------------------- 假追蹤器


def _fake_run_track(calls: list[dict[str, Any]], gen: int):
    """換掉 track.runner.run_track：每一幀的 H 平移量 = 解回來的來源幀號（x）與這次呼叫的世代（y）。"""
    from aivc.track.state import FrameSolve, Solve, State

    def fake(inp: Any, ctx: Any = None, *, k_from: int | None = None, k_to: int | None = None, existing: Any = None, seed: Any = None, directions: Any = (1, -1)) -> Solve:
        k0, k1 = inp.shot
        a = k0 if k_from is None else max(k0, k_from)
        b = k1 if k_to is None else min(k1, k_to)
        calls.append({"shot": inp.shot, "a": a, "b": b})
        s = Solve(inp.track_id, (k0, k1), inp.reference_frame, inp.template.wh)
        ks = list(range(a, b))
        if inp.reference_frame is not None:
            ks.append(int(inp.reference_frame))  # 真的 run_track 也一定會寫參考影格那一列
        for k in ks:
            Hm = np.eye(3)
            Hm[0, 2] = decode_number(inp.get_frame(k))
            Hm[1, 2] = gen
            s.frames[k] = FrameSolve(k, Hm, 1.0, State.TRACKING, n_inliers=100 * gen)
        return s

    return fake


def _rows(out: Path) -> dict[int, list]:
    return {int(r[0]): r for r in json.loads(out.read_text(encoding="utf-8"))["frames"]}


def _track(vfr_clip: Path, template_png: Path, out: Path, **extra: Any) -> dict[str, Any]:
    load_all()
    from aivc.ops.track import track_op

    args = {"video": str(vfr_clip), "template": str(template_png), "out": str(out), "track_id": "t1", **extra}
    return track_op(args, CliCtx())


# ---------------------------------------------------------------- #20 track.solve 用 proxy k


def test_track_solve_indexes_proxy_frames(vfr_clip: Path, cfr: Any, template_png: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import aivc.track.runner as runner

    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(runner, "run_track", _fake_run_track(calls, 1))
    out = tmp_path / "solve.v1.json"
    n = cfr.n_frames
    r = _track(vfr_clip, template_png, out, shot=f"0:{n}")
    # 鏡頭上界是 proxy 幀數，不能被來源幀數（40）截斷
    assert calls[0]["shot"] == (0, n)
    assert r["shot"] == [0, n]
    rows = _rows(out)
    assert sorted(rows) == list(range(n))
    got = {k: int(round(row[3])) for k, row in rows.items()}  # row = [k, h00, h01, h02, …]
    assert got == {k: cfr.src_index(k) for k in range(n)}


def test_track_solve_rejects_shot_past_proxy_end(vfr_clip: Path, cfr: Any, template_png: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import aivc.track.runner as runner
    from aivc.ops import OpError

    monkeypatch.setattr(runner, "run_track", _fake_run_track([], 1))
    with pytest.raises(OpError):
        _track(vfr_clip, template_png, tmp_path / "s.json", shot=f"{cfr.n_frames}:{cfr.n_frames + 5}")


# ---------------------------------------------------------------- #20 seg.run 用 proxy k


class _FakeSession:
    def __init__(self, size: tuple[int, int], seen: dict[int, int]) -> None:
        from aivc.seg.backend import SessionStats

        self.frame_size = size
        self.stats = SessionStats()
        self.seen = seen

    def _mask(self, k: int, rgb: np.ndarray) -> np.ndarray:
        n = decode_number(rgb)
        self.seen[k] = n
        m = np.zeros((self.frame_size[1], self.frame_size[0]), bool)
        m[0, : n + 1] = True  # 遮罩第一列的長度 = 來源幀號 + 1，寫進 .aivm 後可以讀回來比對
        return m

    def add_prompt(self, frame_idx: int, obj_id: int, frame_rgb: np.ndarray, *, points: Any = (), box: Any = None) -> np.ndarray:
        return self._mask(frame_idx, frame_rgb)

    def propagate_frames(self, frames: Any, direction: str) -> Any:
        from aivc.seg.backend import FrameMasks

        for k, rgb in frames:
            yield FrameMasks(k, {1: self._mask(k, rgb)}, {1: 1.0})

    def close(self) -> None:
        pass


def test_seg_run_indexes_proxy_frames(vfr_clip: Path, cfr: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import aivc.seg.sam2_hf as sam
    from aivc.track._aivm_read import read_aivm

    seen: dict[int, int] = {}

    class FakeBackend:
        def __init__(self, **_kw: Any) -> None:
            pass

        def loaded(self) -> Any:
            return SimpleNamespace(model_id="fake/sam", variant="small", load_seconds=0.0, preprocess_on_device=False)

        def open_session(self, size: tuple[int, int]) -> _FakeSession:
            return _FakeSession(size, seen)

    monkeypatch.setattr(sam, "Sam2HfBackend", FakeBackend)
    monkeypatch.setattr(sam, "cuda_max_memory_mb", lambda: None)
    monkeypatch.setattr(sam, "hf_cache_size_bytes", lambda _m: None)
    load_all()
    from aivc.ops.seg import seg_run

    n = cfr.n_frames
    anchor = n // 2
    r = seg_run({"video": str(vfr_clip), "frames": f"0:{n}", "box": ["10,10,20,20"], "anchor": anchor, "dir": "both", "out": str(tmp_path / "seg"), "previews": 0}, CliCtx())
    assert r["frameSize"] == [W, H]
    expect = {k: cfr.src_index(k) for k in range(n)}
    assert seen == expect
    reader = read_aivm(r["objects"][0]["path"])
    got = {}
    for k in range(n):
        m = reader.mask(k)
        assert m is not None, f".aivm 缺 proxy 幀 {k}"
        got[k] = int(m[0].sum()) - 1
    assert got == expect


# ---------------------------------------------------------------- #19 子範圍重解要合併


def test_track_subrange_merges_into_existing_solve(vfr_clip: Path, cfr: Any, template_png: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import aivc.track.runner as runner

    n = cfr.n_frames
    out = tmp_path / "solve.v1.json"
    hud = out.with_name("solve.hud.v1.json")
    calls: list[dict[str, Any]] = []
    monkeypatch.setattr(runner, "run_track", _fake_run_track(calls, 1))
    _track(vfr_clip, template_png, out, shot=f"0:{n}", reference_frame=5)
    assert sorted(_rows(out)) == list(range(n))

    # 單步往前（step-forward）：前端送 --from 20 --to 22，沒帶參考影格
    monkeypatch.setattr(runner, "run_track", _fake_run_track(calls, 2))
    r = _track(vfr_clip, template_png, out, shot=f"0:{n}", k_from=20, k_to=22)
    rows = _rows(out)
    assert sorted(rows) == list(range(n)), "範圍外的幀不能被刪"
    assert r["merged"] is True and r["framesReplaced"] == 2
    gens = {k: int(round(row[6])) for k, row in rows.items()}  # h12 = 世代
    assert {k for k, g in gens.items() if g == 2} == {20, 21}
    assert json.loads(out.read_text(encoding="utf-8"))["referenceFrame"] == 5  # 沒指定 → 沿用
    # 幾何仍是 proxy k（合併後沒被打亂）
    assert {k: int(round(row[3])) for k, row in rows.items()} == {k: cfr.src_index(k) for k in range(n)}
    # HUD 側檔：範圍外保留舊的內點數，範圍內換新
    hud_rows = {int(x["k"]): x for x in json.loads(hud.read_text(encoding="utf-8"))["frames"]}
    assert sorted(hud_rows) == list(range(n))
    assert hud_rows[0]["nInliers"] == 100 and hud_rows[20]["nInliers"] == 200

    # resolveAround：明確指定新的參考影格 30、重解 [25, 40)
    monkeypatch.setattr(runner, "run_track", _fake_run_track(calls, 3))
    _track(vfr_clip, template_png, out, shot=f"0:{n}", reference_frame=30, k_from=25, k_to=40)
    obj = json.loads(out.read_text(encoding="utf-8"))
    rows = _rows(out)
    assert obj["referenceFrame"] == 30
    assert sorted(rows) == list(range(n))
    gens = {k: int(round(row[6])) for k, row in rows.items()}
    assert {k for k, g in gens.items() if g == 3} == set(range(25, 40))
    assert {k for k, g in gens.items() if g == 2} == {20, 21}
    assert all(g == 1 for k, g in gens.items() if not (20 <= k < 22 or 25 <= k < 40))


def test_track_subrange_without_existing_file_writes_range_only(vfr_clip: Path, cfr: Any, template_png: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import aivc.track.runner as runner

    monkeypatch.setattr(runner, "run_track", _fake_run_track([], 1))
    out = tmp_path / "solve.v1.json"
    r = _track(vfr_clip, template_png, out, shot=f"0:{cfr.n_frames}", reference_frame=3, k_from=10, k_to=14)
    assert r["merged"] is False
    assert sorted(_rows(out)) == [3, 10, 11, 12, 13]


def test_merge_subrange_rescales_old_frames_when_template_size_changes() -> None:
    from aivc.geom import homography as hg
    from aivc.ops.track import merge_subrange
    from aivc.track.state import FrameSolve, Solve, State

    old = Solve("t1", (0, 10), 2, (20, 28))
    for k in range(10):
        Hm = np.array([[1.5, 0.1, 10.0 + k], [0.0, 1.2, 5.0], [0.0, 0.0, 1.0]])
        old.frames[k] = FrameSolve(k, Hm, 1.0, State.TRACKING)
    before = {k: hg.quad_from_h(old.frames[k].H, old.template_wh) for k in range(10)}
    new = Solve("t1", (0, 10), None, (40, 56))
    for k in (4, 5):
        new.frames[k] = FrameSolve(k, np.eye(3), 1.0, State.TRACKING)
    merged, replaced = merge_subrange(old, new, 4, 6, reference_given=False)
    assert replaced == {4, 5} and merged.reference_frame == 2 and merged.template_wh == (40, 56)
    for k in (0, 3, 6, 9):
        np.testing.assert_allclose(hg.quad_from_h(merged.frames[k].H, merged.template_wh), before[k], atol=1e-9)
