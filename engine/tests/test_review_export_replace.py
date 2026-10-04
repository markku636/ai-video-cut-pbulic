"""審查修正回歸（export-track 尺寸／--linked 跨磁碟）。replace 那段（只給插入旗標不動 target）在牌局外掛的
plugins/cards/engine/tests/test_review_replace_cards.py。

- #7：solve 四角是**來源**像素；proxy 被縮到 1080 時 Nuke 的 Y 翻轉與 AE 的 Source Width/Height 必須用來源尺寸，
  不能拿 media.proxy 的 1920x1080（render 用 mctx.size = probe 尺寸，兩層要一致）。
- #10：Windows 上輸出檔與快取不同磁碟時 os.path.relpath 擲 ValueError；--solve 在快取外時 cache.rel 也會擲 → 退絕對路徑。
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np
import pytest

from aivc.export import ae_keyframes as AE
from aivc.export import nuke_cornerpin as NK
from aivc.geom import homography as hg
from aivc.ops import OpError, load_all
from aivc.track.state import FrameSolve, Solve, State

TW, TH = 630, 880
SRC_W, SRC_H = 3840, 2160
PROXY_W, PROXY_H = 1920, 1080
FP = "a1b2c3d4e5f60718" + "0" * 48


class _Ctx:
    def __init__(self) -> None:
        self.logs: list[tuple[str, str]] = []

    def progress(self, *a, **k): ...  # noqa: ANN002, ANN003, ANN201

    def log(self, level: str, message: str) -> None:
        self.logs.append((level, message))

    def check_cancel(self): ...  # noqa: ANN201

    def artifact(self, *a, **k): ...  # noqa: ANN002, ANN003, ANN201


# ---------------------------------------------------------------- export-track fixtures


def _source_space_solve(k0: int = 0, k1: int = 6) -> tuple[Solve, dict[int, np.ndarray]]:
    """四角落在 4K 來源空間的下半部（y≈1600..1700，比 proxy 的 1080 還大），Y 翻轉用錯高度一眼就看得出來。"""
    solve = Solve("t1", (k0, k1), k0, (TW, TH))
    frames: dict[int, np.ndarray] = {}
    base = np.array([[2000.0, 1580.0], [2244.0, 1584.0], [2240.0, 1676.0], [1996.0, 1672.0]])
    for k in range(k0, k1):
        q = base + np.array([[1.5 * (k - k0), 0.75 * (k - k0)]])
        H = hg.template_to_quad((TW, TH), q)
        solve.frames[k] = FrameSolve(k, H, 0.95, State.TRACKING)
        frames[k] = hg.quad_from_h(H, (TW, TH))
    return solve, frames


def _export_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, cached_probe: bool, media_probe: dict | None) -> tuple[Path, dict[int, np.ndarray]]:
    """專案：影片不在（只剩指紋）、media.proxy = 1920x1080 scale 0.5；快取裡有 solve（來源座標），可選 probe.v1.json。"""
    from aivc.media.probe import Probe, save_probe
    from aivc.project import paths as P
    from aivc.project import schema as S

    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    solve, frames = _source_space_solve()
    cache = P.media_cache(FP).ensure()
    solve.write(cache.solve("t1"), cache.solve("t1").with_name("solve.hud.v1.json"))
    if cached_probe:
        save_probe(cache.probe, Probe(path=str(tmp_path / "missing.mp4"), container="mov,mp4", size_bytes=1, codec="h264", width=SRC_W, height=SRC_H, pix_fmt="yuv420p", fps_num=30, fps_den=1, time_base_num=1, time_base_den=30))
    project = S.ProjectFileV1(profile="cards")
    project.media.append(
        S.MediaV1(id="m1", path=str(tmp_path / "missing.mp4"), name="missing.mp4", fingerprint=FP, probe=media_probe, proxy=S.ProxyMetaV1(S.Rational(30, 1), 6, PROXY_W, PROXY_H, PROXY_H / SRC_H))
    )
    project.active_media_id = "m1"
    project.shots["m1"] = [S.ShotV1(id="s1", start_frame=0, end_frame=6, kind="close")]
    project.tracks["m1"] = [S.TrackV1(id="t1", shot_id="s1", label="Player1", reference_frame=0)]
    p = tmp_path / "p.aivc.json"
    S.save(project, p)
    return p, frames


def _run_cli(argv: list[str], capsys: pytest.CaptureFixture[str]) -> tuple[int, dict]:
    from aivc.cli import main

    code = main(["--json", *argv])
    final = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    return code, final


# ---------------------------------------------------------------- #7 來源尺寸


@pytest.mark.parametrize(
    ("cached_probe", "media_probe"),
    [
        (True, None),  # 快取 probe.v1.json（最常見：aivc probe / proxy 跑過）
        (False, {"video": {"width": SRC_W, "height": SRC_H}}),  # Rust MediaProbe 形狀（UI 寫進專案的）
        (False, None),  # 什麼 probe 都沒有 → proxy 尺寸 ÷ scale 還原來源尺寸
    ],
    ids=["cached-probe", "media-probe", "proxy-div-scale"],
)
def test_export_track_uses_source_size_not_proxy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str], cached_probe: bool, media_probe: dict | None) -> None:
    load_all()
    p, frames = _export_project(tmp_path, monkeypatch, cached_probe=cached_probe, media_probe=media_probe)

    out = tmp_path / "t1.nk"
    code, final = _run_cli(["export-track", str(p), "--track", "t1", "--format", "nuke", "-o", str(out)], capsys)
    assert code == 0 and final["ok"], final
    assert final["result"]["size"] == [SRC_W, SRC_H]
    text = out.read_text(encoding="utf-8")
    assert f"source={SRC_W}x{SRC_H}" in text
    parsed = NK.parse_nuke_cornerpin(text)
    # to1 = BL；frame = k + 1；y_nuke = 2160 − y_src（用 1080 翻會變負的，pin 掉到畫面外）
    bl = frames[0][3]
    x1, y1 = parsed.to[1][1]
    assert x1 == pytest.approx(bl[0], abs=1e-3) and y1 == pytest.approx(SRC_H - bl[1], abs=1e-3)
    assert y1 > 0
    back = NK.corners_from_parsed_nuke(parsed, height=SRC_H, frame_offset=1)
    assert max(float(np.abs(back[k] - frames[k]).max()) for k in back) < 0.01

    code, final = _run_cli(["export-track", str(p), "--track", "t1", "--format", "ae", "--stdout"], capsys)
    assert code == 0 and final["ok"], final
    ae = final["result"]["text"]
    lines = ae.splitlines()
    assert f"\tSource Width\t{SRC_W}" in lines and f"\tSource Height\t{SRC_H}" in lines
    parsed_ae = AE.parse_ae_keyframes(ae)
    assert (parsed_ae.width, parsed_ae.height) == (SRC_W, SRC_H)


def test_export_track_media_probe_beats_proxy_even_with_scale_one(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """proxy.scale 缺（舊專案寫 1.0）但 media.probe 有來源尺寸：仍要用來源尺寸，不能信 proxy。"""
    from aivc.project import schema as S

    load_all()
    p, _frames = _export_project(tmp_path, monkeypatch, cached_probe=False, media_probe={"width": SRC_W, "height": SRC_H})
    proj = S.load(p).project
    assert proj.media[0].proxy is not None
    proj.media[0].proxy.scale = 1.0
    S.save(proj, p)
    code, final = _run_cli(["export-track", str(p), "--track", "t1", "--format", "ae", "--stdout"], capsys)
    assert code == 0 and final["ok"], final
    assert final["result"]["size"] == [SRC_W, SRC_H]


# ---------------------------------------------------------------- #10 --linked 跨磁碟


def test_export_track_linked_cross_drive_falls_back_to_absolute(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    load_all()
    p, _frames = _export_project(tmp_path, monkeypatch, cached_probe=True, media_probe=None)

    def cross_drive(path, start=None):  # noqa: ANN001, ANN202
        raise ValueError("path is on mount 'C:', start on mount 'D:'")

    monkeypatch.setattr(os.path, "relpath", cross_drive)
    out = tmp_path / "shots" / "card.nk"
    code, final = _run_cli(["export-track", str(p), "--track", "t1", "--format", "nuke", "--linked", "-o", str(out)], capsys)
    assert code == 0 and final["ok"], final
    solve_abs = Path(final["result"]["solvePath"]).as_posix()
    assert final["result"]["linked"].startswith(f"solve={solve_abs} ")
    text = out.read_text(encoding="utf-8")
    assert f"# linked: solve={solve_abs} trackId=t1" in text


def test_export_track_linked_solve_outside_cache_without_out(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    """--solve 指到快取外、又沒有 -o：cache.rel 會擲 ValueError（Path.relative_to），一樣退絕對路徑。"""
    from aivc.project import paths as P

    load_all()
    p, _frames = _export_project(tmp_path, monkeypatch, cached_probe=True, media_probe=None)
    elsewhere = tmp_path / "elsewhere" / "solve.v1.json"
    elsewhere.parent.mkdir(parents=True)
    src = P.media_cache(FP).solve("t1")
    elsewhere.write_bytes(src.read_bytes())
    code, final = _run_cli(["export-track", str(p), "--track", "t1", "--format", "nuke", "--linked", "--solve", str(elsewhere)], capsys)
    assert code == 0 and final["ok"], final
    assert final["result"]["linked"].startswith(f"solve={elsewhere.as_posix()} ")
