"""Probe：ffprobe JSON fixture（不需範例影片）、矩陣啟發式、PyAV vs ffprobe 一致（需範例）。"""
from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import pytest

from aivc.media import probe as P

FIX = Path(__file__).parent / "fixtures" / "media" / "ffprobe-sample.json"


def test_ffprobe_json_of_sample_fixture() -> None:
    doc = json.loads(FIX.read_text(encoding="utf-8"))
    pr = P.probe_from_ffprobe_json(doc, r"D:\x\sample_clip1.webm")
    assert (pr.width, pr.height, pr.codec, pr.pix_fmt) == (1280, 720, "vp9", "yuv420p")
    assert (pr.fps_num, pr.fps_den) == (30, 1)  # r_frame_rate
    assert pr.avg_fps_num is None  # avg 0/0
    assert (pr.time_base_num, pr.time_base_den) == (1, 1000)
    assert pr.duration_ms is None and pr.nb_frames is None  # 沒標頭就 None，不猜
    assert pr.start_ms == 2.0
    assert pr.color_range == "tv"
    assert pr.color_space is None and pr.color_primaries is None and pr.color_trc is None
    assert (pr.matrix_assumed, pr.matrix_source) == ("bt709", "heuristic")
    assert pr.rotation == 0 and pr.has_b_frames == 0
    assert pr.has_audio and pr.audio_codec == "opus" and pr.audio_sample_rate == 48000 and pr.audio_channels == 2
    assert pr.container == "matroska,webm" and pr.size_bytes == 22768280
    assert pr.source == "ffprobe"
    d = pr.to_json()
    assert d["version"] == 1
    assert P.Probe.from_json(d) == pr


def test_ffprobe_json_sd_rotation_duration() -> None:
    doc = {
        "streams": [
            {"codec_type": "video", "codec_name": "h264", "width": 720, "height": 480, "pix_fmt": "yuv420p",
             "r_frame_rate": "30000/1001", "avg_frame_rate": "30000/1001", "time_base": "1/90000", "start_time": "0.000000",
             "duration": "10.010000", "nb_frames": "300", "color_range": "pc", "color_space": "smpte170m",
             "color_primaries": "smpte170m", "color_transfer": "smpte170m", "has_b_frames": 2,
             "side_data_list": [{"side_data_type": "Display Matrix", "rotation": -90}]},
            {"codec_type": "audio", "codec_name": "aac", "sample_rate": "44100", "channels": 1},
        ],
        "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "size": "123", "duration": "10.010000"},
    }
    pr = P.probe_from_ffprobe_json(doc, "x.mp4")
    assert (pr.fps_num, pr.fps_den) == (30000, 1001) and (pr.avg_fps_num, pr.avg_fps_den) == (30000, 1001)
    assert pr.duration_ms == pytest.approx(10010.0) and pr.nb_frames == 300
    assert pr.rotation == 270  # -90 → 270
    assert (pr.matrix_assumed, pr.matrix_source) == ("bt601", "tag")
    assert pr.color_range == "pc" and pr.has_b_frames == 2
    assert pr.audio_channels == 1 and pr.audio_sample_rate == 44100


def test_ffprobe_json_skips_attached_pic_and_requires_video() -> None:
    doc = {"streams": [{"codec_type": "video", "codec_name": "mjpeg", "disposition": {"attached_pic": 1}}], "format": {}}
    with pytest.raises(ValueError):
        P.probe_from_ffprobe_json(doc, "audio_only.m4a")
    doc = {"streams": [{"codec_type": "video", "codec_name": "mjpeg", "disposition": {"attached_pic": 1}},
                       {"codec_type": "video", "codec_name": "vp9", "width": 320, "height": 240, "r_frame_rate": "25/1", "time_base": "1/1000"}],
           "format": {}}
    pr = P.probe_from_ffprobe_json(doc, "x.webm")
    assert pr.codec == "vp9" and pr.matrix_assumed == "bt601" and not pr.has_audio


def test_assumed_matrix_table() -> None:
    assert P.assumed_matrix("bt709", 100) == ("bt709", "tag")
    assert P.assumed_matrix("smpte170m", 2160) == ("bt601", "tag")
    assert P.assumed_matrix("bt470bg", 2160) == ("bt601", "tag")
    assert P.assumed_matrix("bt2020nc", 2160) == ("bt709", "tag")
    assert P.assumed_matrix(None, 576) == ("bt709", "heuristic")
    assert P.assumed_matrix(None, 575) == ("bt601", "heuristic")
    assert P.assumed_matrix("unknown-name", 720) == ("bt709", "heuristic")


def test_frac_helper() -> None:
    from fractions import Fraction

    assert P._frac("30/1") == Fraction(30, 1)
    assert P._frac("0/0") is None and P._frac("") is None and P._frac(None) is None and P._frac("abc") is None


def test_probe_missing_file() -> None:
    with pytest.raises(FileNotFoundError):
        P.probe(r"C:\definitely\missing.webm")


# ---------------------------------------------------------------- 需範例
def test_pyav_probe_of_sample_matches_expectations_and_ffprobe(sample_video: Path) -> None:
    pr = P.probe_pyav(str(sample_video))
    assert pr.source == "pyav"
    assert (pr.width, pr.height, pr.codec) == (1280, 720, "vp9")
    assert (pr.fps_num, pr.fps_den) == (30, 1) and pr.avg_fps_num is None
    assert pr.duration_ms is None and pr.nb_frames is None
    assert pr.color_range == "tv" and pr.color_space is None
    assert (pr.matrix_assumed, pr.matrix_source) == ("bt709", "heuristic")
    assert pr.has_audio and pr.audio_codec == "opus"
    assert pr.start_ms == 2.0 and pr.rotation == 0
    try:
        pr2 = P.probe_ffprobe(str(sample_video))
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"ffprobe 不可用：{e}")
    a, b = asdict(pr), asdict(pr2)
    a.pop("source"), b.pop("source")
    assert a == b
    assert P.probe(str(sample_video)).source == "pyav"  # 正常情況走 PyAV
