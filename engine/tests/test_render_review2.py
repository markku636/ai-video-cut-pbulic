"""ops/render 審查第二輪回歸：
- `-o` 指向來源影片本身 → Invalid（`aivc render` 擋；來源位元組不變、不留 .part。`aivc run --reuse` 那條在牌局外掛的測試）。
  過去 ffmpeg 寫 `<out>.part` 所以自己的「輸出＝輸入」檢查不觸發，最後 os.replace 把原始素材換成渲染結果。
- 定格（CfrMap 同一來源幀對到多個 proxy k）跨 `--range` 邊界：範圍內的 k 一定合成、範圍外的 k 一定原封不動。
  過去快取只看來源幀，邊界落在定格中間時兩側互相沿用對方的結果。
- `--emit-matte`／`--emit-faces`：範圍內每個 proxy k 都有 PNG（含定格重複的 k），重複 k 的檔與首次合成那一幀位元相同。
  過去只在真的合成的 k 寫檔，依 proxy k 編號的序列會缺號。
插入來源用測試外掛 aivc_test_insert（貼圖）；牌局版在 plugins/cards/engine/tests/test_render_review2_cards.py。
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures" / "e1"))
import synth_scene as SC  # noqa: E402

from aivc import env  # noqa: E402
from aivc.media.cfr import CfrMap  # noqa: E402
from aivc.media.source import FrameSource  # noqa: E402
from aivc.ops import OpError  # noqa: E402
from aivc.ops import render as RD  # noqa: E402
from aivc.project import resolve as R  # noqa: E402

NS = 8  # 來源幀數
Q_P1 = SC.card_quad(250, 410, 122, 80)
# 合成的 CFR 對應：12 個 proxy 幀、8 個來源幀；k=1..4 都是來源 1（定格）、k=8,9 都是來源 5
RUNS = [(0, 0, 2), (2, 1, 1), (3, 1, 1), (4, 1, 1), (5, 2, 4), (9, 5, 1), (10, 6, 2)]
MAP = [0, 1, 1, 1, 1, 2, 3, 4, 5, 5, 6, 7]
NP = len(MAP)


def _cfr() -> CfrMap:
    cfr = CfrMap.from_runs(30, 1, NP, NS, RUNS)
    assert cfr.to_list() == MAP and cfr.duplicate_count == 4
    return cfr


@pytest.fixture(scope="module")
def ffmpeg_ready() -> None:
    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")


@pytest.fixture(scope="module")
def signs(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path]:
    return SC.write_sign_pngs(tmp_path_factory.mktemp("signs"))


@pytest.fixture(scope="module")
def clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """8 幀靜止的原圖平面；左上角一塊隨幀號移動的白塊（離平面很遠），用來確認第 k 個輸出真的來自來源第 MAP[k] 幀。"""
    orig = SC.make_sign_rgba("orig")
    frames = []
    for i in range(NS):
        img = SC.felt_frame()
        SC.paste_rgba(img, orig, Q_P1, shade=0.92)
        img[10:30, 10 + 30 * i : 30 + 30 * i] = 255
        frames.append(img)
    return SC.write_clip(tmp_path_factory.mktemp("clip") / "clip.mkv", frames)


def _make_project(video: Path, n_frames: int, signs: tuple[Path, Path]) -> Path:
    new, orig = signs
    ppath, _p, _c = SC.make_project(video, n_frames, [{"id": "t1", "quad": Q_P1, "image": new, "original": orig, "name": "Player1"}])
    return ppath


@pytest.fixture
def dup_project(clip: Path, signs: tuple[Path, Path], image_insert: object, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """專案宣告 12 個 proxy 幀（solve／遮罩都 12 幀），MediaContext 的 CfrMap 之後換成含定格的 RUNS。"""
    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    return _make_project(clip, NP, signs)


def _dup_mctx(ppath: Path):
    mctx = R.open_media_context(ppath, None, SC.RecordingCtx())
    mctx.cfr = _cfr()
    return mctx


def _decode_all(video: Path) -> list:
    with FrameSource(video) as fs:
        return [fs.get(i) for i in range(fs.n_frames)]


def _sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


# ---------------------------------------------------------------- 定格跨 --range 邊界（finding 3）


@pytest.mark.parametrize("rng", ["3:10", "0:3", "2:9"])
def test_duplicate_run_straddling_range_edge_is_composited_exactly_in_range(dup_project: Path, ffmpeg_ready: None, tmp_path: Path, rng: str) -> None:
    mctx = _dup_mctx(dup_project)
    ctx = SC.RecordingCtx()
    plan = RD.build_plan(mctx, ctx, out=str(tmp_path / "o.mkv"), codec="ffv1", gpu=False, range_spec=rng)
    k0, k1 = plan.range  # type: ignore[misc]
    src = _decode_all(Path(mctx.video))
    assert len(src) == NS
    out = list(RD.render_frames(mctx, plan, ctx))
    assert len(out) == NP
    marker = (slice(10, 30), slice(0, 10 + 30 * NS))
    for k in range(NP):
        s, o = src[MAP[k]], out[k]
        assert np.array_equal(o.y[marker], s.y[marker]), (rng, k)  # 來源幀對得上
        inside = k0 <= k < k1
        same = np.array_equal(o.y, s.y) and np.array_equal(o.u, s.u) and np.array_equal(o.v, s.v)
        assert same == (not inside), (rng, k, "範圍內該合成" if inside else "範圍外該原封不動")
    # 同一側的定格仍然只合成一次、重送同一個物件
    for k in range(1, NP):
        if MAP[k] == MAP[k - 1] and (k0 <= k < k1) == (k0 <= k - 1 < k1):
            assert out[k] is out[k - 1], (rng, k)
    assert plan.jobs[0].composited == len({MAP[k] for k in range(k0, k1)})


# ---------------------------------------------------------------- --emit-matte／--emit-faces 不缺號（finding 4）


@pytest.mark.parametrize("rng", [None, "3:10"])
def test_emit_matte_and_faces_write_every_proxy_k_including_duplicates(dup_project: Path, ffmpeg_ready: None, tmp_path: Path, rng: str | None) -> None:
    mctx = _dup_mctx(dup_project)
    ctx = SC.RecordingCtx()
    matte, faces = tmp_path / "matte", tmp_path / "faces"
    plan = RD.build_plan(mctx, ctx, out=str(tmp_path / "m.mkv"), codec="ffv1", gpu=False, range_spec=rng, emit_matte=str(matte), emit_faces=str(faces))
    k0, k1 = plan.range if plan.range is not None else (0, NP)
    list(RD.render_frames(mctx, plan, ctx))
    want = set(range(k0, k1))
    for root in (matte, faces):
        got = {int(p.stem) for p in (root / "t1").glob("*.png")}
        assert got == want, (root.name, sorted(want - got), sorted(got - want))
    # 重複的 k 與同一來源幀第一次合成的 k 位元相同（輸出影片那幾幀本來就是同一份結果）
    for k in range(k0 + 1, k1):
        if MAP[k] == MAP[k - 1]:
            for root in (matte, faces):
                assert (root / "t1" / f"{k:06d}.png").read_bytes() == (root / "t1" / f"{k - 1:06d}.png").read_bytes(), (root.name, k)
    import cv2

    m = cv2.imdecode(np.fromfile(str(matte / "t1" / f"{k0 + 1:06d}.png"), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    assert m is not None and m.shape == (SC.H, SC.W) and m.max() == 255


# ---------------------------------------------------------------- -o 不可以是來源影片（finding 2）


def test_ensure_out_not_source_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    video = tmp_path / "clip.mkv"
    video.write_bytes(b"x" * 16)
    RD.ensure_out_not_source(tmp_path / "out.mkv", video)  # 不同檔：不擋
    monkeypatch.chdir(tmp_path)
    for same in (video, str(video), "clip.mkv", tmp_path / "sub" / ".." / "clip.mkv"):
        with pytest.raises(OpError) as ei:
            RD.ensure_out_not_source(same, video)
        assert ei.value.kind == "Invalid" and "-o" in ei.value.hint
    # 硬連結 → samefile 認得
    link = tmp_path / "hard.mkv"
    try:
        os.link(video, link)
    except OSError:
        link = None  # type: ignore[assignment]
    if link is not None:
        with pytest.raises(OpError):
            RD.ensure_out_not_source(link, video)
    # atomic_output 會先刪 `<out>.part`：來源剛好叫這個名字也要擋
    part_src = tmp_path / "take.mkv.part"
    part_src.write_bytes(b"y")
    with pytest.raises(OpError):
        RD.ensure_out_not_source(tmp_path / "take.mkv", part_src)
    if os.name == "nt":
        # 大小寫／斜線不同也算同一檔（兩邊都存在走 samefile；都不存在走 normcase 比對）
        with pytest.raises(OpError):
            RD.ensure_out_not_source(str(video).upper().replace("\\", "/"), video)
        ghost = tmp_path / "Nope" / "Ghost.WEBM"
        with pytest.raises(OpError):
            RD.ensure_out_not_source(str(ghost).lower(), ghost)


def test_build_plan_and_render_cli_refuse_source_as_output(clip: Path, signs: tuple[Path, Path], image_insert: object, ffmpeg_ready: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    from aivc.cli import main

    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    video = tmp_path / "src.mkv"
    shutil.copyfile(clip, video)
    ppath = _make_project(video, NS, signs)
    before = _sha(video)
    mctx = R.open_media_context(ppath, None, SC.RecordingCtx())
    with pytest.raises(OpError) as ei:
        RD.build_plan(mctx, SC.RecordingCtx(), out=str(video), codec="ffv1", gpu=False)
    assert ei.value.kind == "Invalid"
    code = main(["--json", "render", str(ppath), "-o", str(video), "--codec", "ffv1", "--no-gpu"])
    final = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 2 and not final["ok"] and final["error"]["kind"] == "Invalid", final
    assert _sha(video) == before and not list(tmp_path.glob("src.mkv*.part"))
    # 別的輸出檔照常可以渲染
    code = main(["--json", "render", str(ppath), "-o", str(tmp_path / "ok.mkv"), "--codec", "ffv1", "--no-gpu"])
    final = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0 and final["ok"] and (tmp_path / "ok.mkv").is_file() and _sha(video) == before, final
