"""CLI 端到端（需範例影片 + ffmpeg）：probe → index → shots → proxy → bench-frame-map，全部走 aivc.cli.main --json。"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

import pytest

from aivc import env
from aivc.cli import main
from aivc.ops import media as M
from aivc.ops import OpError


def run_json(capsys: pytest.CaptureFixture[str], argv: list[str]) -> tuple[int, dict[str, Any], list[dict[str, Any]]]:
    code = main(["--json", *argv])
    out = capsys.readouterr().out.strip().splitlines()
    events = [json.loads(line) for line in out]
    final = events[-1]
    assert final["id"] == "cli"
    return code, final, events[:-1]


@pytest.fixture(scope="module")
def cache_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return tmp_path_factory.mktemp("aivc-cache")


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch, cache_dir: Path) -> None:
    monkeypatch.setenv("AIVC_CACHE_DIR", str(cache_dir))


def test_parse_fps_and_proxy_dims() -> None:
    assert M.parse_fps(None) is None and M.parse_fps("30") == (30, 1) and M.parse_fps("30000/1001") == (30000, 1001)
    with pytest.raises(OpError):
        M.parse_fps("abc")
    with pytest.raises(OpError):
        M.parse_fps("0")
    assert M.proxy_dims(1280, 720, 1080) == (1280, 720, 1.0)
    assert M.proxy_dims(3840, 2160, 1080) == (1920, 1080, 0.5)
    assert M.proxy_dims(1281, 721, 1080) == (1280, 720, 1.0)  # 奇數修偶
    w, h, s = M.proxy_dims(1920, 1440, 1080)
    assert (w, h) == (1440, 1080) and abs(s - 0.75) < 1e-9


def test_probe_missing_file_exit_2(capsys: pytest.CaptureFixture[str]) -> None:
    code, final, _ = run_json(capsys, ["probe", r"C:\nope\missing.webm"])
    assert code == 2 and final["ok"] is False and final["error"]["kind"] == "Invalid"


def test_probe_cli(sample_video: Path, capsys: pytest.CaptureFixture[str], cache_dir: Path) -> None:
    code, final, _ = run_json(capsys, ["probe", str(sample_video)])
    assert code == 0 and final["ok"]
    r = final["result"]
    assert len(r["fingerprint"]) == 64 and Path(r["cacheDir"]).name == r["fingerprint"][:16]
    assert Path(r["probePath"]).is_file() and Path(r["probePath"]).parent.parent.parent == cache_dir
    assert r["probe"]["width"] == 1280 and r["probe"]["duration_ms"] is None and r["probe"]["matrix_assumed"] == "bt709"
    # 第二次走快取（probe.v1.json），結果相同
    code2, final2, _ = run_json(capsys, ["probe", str(sample_video)])
    assert code2 == 0 and final2["result"]["probe"] == r["probe"]


def test_index_cli(sample_video: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code, final, events = run_json(capsys, ["index", str(sample_video), "--force"])
    assert code == 0, final
    r = final["result"]
    assert (r["nSource"], r["nFrames"], r["duplicates"], r["dropped"], r["keyframes"]) == (1762, 1797, 35, 0, 18)
    assert r["fps"] == {"num": 30, "den": 1} and r["rebuilt"] is True
    assert [(g["src"], g["gap_ms"]) for g in r["gaps"]["over40ms"]] == [(1, 1200.0), (116, 49.0)]
    assert r["gaps"]["minMs"] == 33.0 and r["gaps"]["maxMs"] == 1200.0
    assert any(e.get("event") == "progress" and e["stage"] == "index" for e in events)
    assert Path(r["indexPath"]).is_file()
    code, final, _ = run_json(capsys, ["index", str(sample_video)])
    assert final["result"]["rebuilt"] is False and final["result"]["nFrames"] == 1797  # 快取
    # --fps 覆寫 → 重建、N 改變
    code, final, _ = run_json(capsys, ["index", str(sample_video), "--fps", "60"])
    assert final["result"]["fps"] == {"num": 60, "den": 1} and final["result"]["nFrames"] == 3594
    run_json(capsys, ["index", str(sample_video), "--fps", "30"])  # 還原給後面的測試


def test_shots_cli(sample_video: Path, capsys: pytest.CaptureFixture[str]) -> None:
    code, final, _ = run_json(capsys, ["shots", str(sample_video), "--force"])
    assert code == 0, final
    r = final["result"]
    assert [c["k"] for c in r["cuts"]] == [60, 926, 1358]  # 45.285 s → (45.283·30)−0.5 = 1357.99 → k=1358
    assert [(s["startFrame"], s["endFrame"]) for s in r["shots"]] == [(0, 60), (60, 926), (926, 1358), (1358, 1797)]
    assert r["params"] == {"threshold": 0.2, "minLen": 12}
    doc = json.loads(Path(r["shotsPath"]).read_text(encoding="utf-8"))
    assert doc["version"] == 1 and doc["shots"] == r["shots"] and doc["nFrames"] == 1797
    code, final, _ = run_json(capsys, ["shots", str(sample_video)])
    assert final["result"]["cached"] is True and final["result"]["shots"] == r["shots"]


def test_proxy_and_frame_map_cli(sample_video: Path, capsys: pytest.CaptureFixture[str]) -> None:
    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")
    code, final, events = run_json(capsys, ["proxy", str(sample_video), "--force"])
    assert code == 0, final
    r = final["result"]
    assert (r["frames"], r["width"], r["height"], r["scale"], r["gop"]) == (1797, 1280, 720, 1.0, 15)
    # 任何 H.264 階梯上的編碼器都算對：Mac 選 VideoToolbox／libx264、Linux 沒卡選 libx264（見 encode_plan.H264_CHAIN）
    assert r["codec"] in M.PROXY_CODECS and r["audio"] == "aac"
    assert Path(r["proxyPath"]).is_file() and Path(r["proxyMetaPath"]).is_file()
    assert any(e.get("event") == "artifact" for e in events)
    assert any(e.get("event") == "progress" and e["stage"] == "proxy" for e in events)
    # 寫 stderr：這個測試用 capsys 解析 stdout 的 JSONL，自己 print 到 stdout 會把下一個 run_json 弄壞
    print(f"\nproxy: {r['codec']} {r['seconds']}s {r['bytes'] / 1e6:.1f} MB decode={r['decodeStats']}", file=sys.stderr)

    code, final, _ = run_json(capsys, ["bench-frame-map", str(sample_video), "--samples", "12"])
    assert code == 0, final
    b = final["result"]
    assert b["ok"] and b["proxyFrames"] == 1797 == b["expectedFrames"]
    assert b["minPsnr"] >= 40.0
    assert {row["k"] for row in b["samples"]} >= {0, 1, 36, 37, 1796}
    print(f"frame-map: min {b['minPsnr']} mean {b['meanPsnr']} dB over {len(b['samples'])} samples", file=sys.stderr)

    code, final, _ = run_json(capsys, ["proxy", str(sample_video)])
    assert final["result"]["cached"] is True
