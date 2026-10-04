"""media/audio_info.py＋op `media.audio_info`（設計 §3.4、§13 M2.5）。需要 ffmpeg 產合成素材，沒有就 skip。

驗收：合成素材的 startUs（mp3 LAME 延遲 25 057 µs）、gaps（1 s 斷層）、nSamples；缺快取／壞快取時重算（stale）。
斷層素材用 NUT 容器（時基 = 1/取樣率，樣本級精確），期望值可以由 lavfi sine 每幀 1024 樣本直接算出來。
"""
from __future__ import annotations

import json
import subprocess
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest

from aivc import env
from aivc.cli import main
from aivc.media import audio_info as AI
from aivc.media import cache as C
from aivc.media import ffmpeg as ff
from aivc.project import schema as S


@pytest.fixture(scope="module")
def media_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")
    d = tmp_path_factory.mktemp("audio info 素材")  # 路徑含空格與中文
    return d


def make(media_dir: Path, name: str, *args: str) -> Path:
    out = media_dir / name
    if not out.is_file():
        cmd = [ff.exe("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "error", "-y", *args, str(out)]
        cp = subprocess.run(cmd, capture_output=True, **ff.popen_kwargs())
        if cp.returncode != 0:
            pytest.skip(f"ffmpeg 產不出 {name}：{cp.stderr.decode('utf-8', 'replace')[-300:]}")
    return out


@pytest.fixture(autouse=True)
def _cache(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))


# ---------------------------------------------------------------- PtsAligner（純函式）


def test_aligner_counts_samples_within_jitter() -> None:
    a = AI.PtsAligner(48000)
    # WebM 整數 ms pts：60 ms 一幀，每幀 ±1 ms 抖動 → 不算斷層
    for i, jitter in enumerate([0, 1, -1, 0, 1]):
        a.push(Fraction((i * 60 + jitter) * 1000), 2880)
    assert (a.out, a.gaps, a.overlaps, a.start_us) == (5 * 2880, [], [], 0)


def test_aligner_fills_gap_and_drops_overlap() -> None:
    a = AI.PtsAligner(48000)
    a.push(Fraction(500_000), 48000)  # 0.5 s 起、1 s 長
    a.push(Fraction(2_500_000), 48000)  # 晚 1 s → 斷層
    assert a.start_us == 500_000 and a.gaps == [(1_500_000, 1_000_000)] and a.out == 144000
    a.push(Fraction(3_000_000), 48000)  # 早 0.5 s → 重疊，丟掉這一幀開頭 24000 樣本
    assert a.overlaps == [(3_000_000, 500_000)] and a.out == 168000
    # 目前輸出到絕對 4.0 s；這一幀晚 10 ms：在 20 ms 門檻內，照數
    a.push(Fraction(4_010_000), 960)
    assert a.out == 168960 and len(a.overlaps) == 1 and len(a.gaps) == 1
    # 門檻是「大於」20 ms（aresample：fabs(fdelta) > min_hard_comp）
    b = AI.PtsAligner(48000)
    b.push(Fraction(0), 960)
    b.push(Fraction(40_000), 960)  # 晚剛好 20 ms = 960 樣本 → 不補
    assert b.gaps == [] and b.out == 1920


def test_aligner_nopts_frames_are_appended() -> None:
    a = AI.PtsAligner(44100)
    a.push(None, 1152)
    a.push(Fraction(1_000_000), 1152)  # 第一個有 pts 的幀：前面沒 pts 的樣本算在它之前
    assert a.start_us == Fraction(1_000_000) - Fraction(1152 * 1_000_000, 44100) and a.out == 2304 and a.gaps == []


# ---------------------------------------------------------------- 合成素材


def test_mp3_lame_delay_start_us(media_dir: Path) -> None:
    mp3 = make(media_dir, "樂 lame.mp3", "-f", "lavfi", "-i", "sine=f=1000:d=2:r=44100", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "128k")
    s = AI.scan(mp3)
    assert s.has_audio and s.info is not None
    # LAME 標頭的延遲：1105 樣本 @ 44.1 kHz = 25 056.69 µs → 25 057（設計 §3.2 的實測值）
    assert s.info.to_json() == {"codec": "mp3", "sampleRate": 44100, "channels": 2, "channelLayout": "stereo", "startUs": 25057, "videoStartUs": None, "nSamples": 88200, "gaps": []}
    assert s.stream_start_us == 25057 and s.decoded_samples == 88200 and s.overlaps == []


def test_mp3_with_cover_art_is_still_audio_only(media_dir: Path) -> None:
    mp3 = make(media_dir, "樂 lame.mp3", "-f", "lavfi", "-i", "sine=f=1000:d=2:r=44100", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "128k")
    png = make(media_dir, "cover.png", "-f", "lavfi", "-i", "color=c=red:s=16x16", "-frames:v", "1")
    cover = make(media_dir, "cover.mp3", "-i", str(mp3), "-i", str(png), "-map", "0:a", "-map", "1:v", "-c", "copy", "-disposition:v", "attached_pic", "-id3v2_version", "3")
    s = AI.scan(cover)
    assert s.info is not None and s.info.video_start_us is None and s.info.start_us == 25057 and s.info.n_samples == 88200


def test_audio_later_than_video_start_offsets(media_dir: Path) -> None:
    """音訊晚 250 ms 開始（分離原音會遇到的 startUs ≠ videoStartUs）；PCM＋mkv 整數 ms，數字精確。"""
    mkv = make(
        media_dir, "offset.mkv",
        "-f", "lavfi", "-i", "testsrc=s=160x120:r=30:d=2", "-itsoffset", "0.25", "-f", "lavfi", "-i", "sine=f=1000:d=2:r=48000",
        "-c:v", "mjpeg", "-c:a", "pcm_s16le",
    )
    s = AI.scan(mkv)
    assert s.info is not None
    assert (s.info.start_us, s.info.video_start_us, s.info.n_samples, s.info.channels, s.info.channel_layout) == (250_000, 0, 96000, 1, None)
    assert s.stream_index == 1 and s.audio_streams == 1


def test_one_second_pts_gap_nut_exact(media_dir: Path) -> None:
    """aselect 丟掉 1～2 s 的幀但保留 pts（Chrome 錄影斷層的形狀）。lavfi sine 每幀 1024 樣本：
    t∈[1,2] 的幀是 #47..#93 → 斷層從樣本 47·1024 = 48128（1.002667 s）開始、長 47·1024 樣本；補滿後總長仍是 3 s。"""
    nut = make(media_dir, "gap.nut", "-f", "lavfi", "-i", "sine=f=1000:d=3:r=48000", "-af", "aselect='not(between(t,1,2))'", "-c:a", "pcm_s16le")
    s = AI.scan(nut)
    assert s.info is not None
    assert s.info.gaps == [(1_002_667, 1_002_667)]
    assert s.info.n_samples == 144000 and s.decoded_samples == 144000 - 47 * 1024
    assert s.info.start_us == 0 and s.info.video_start_us is None and s.overlaps == []


def test_one_second_pts_gap_webm_opus(media_dir: Path) -> None:
    """同樣的斷層編成 WebM Opus（整數 ms pts、20 ms 幀）：位置與長度誤差在一個 Opus 幀內。"""
    webm = make(media_dir, "gap.webm", "-f", "lavfi", "-i", "sine=f=1000:d=3:r=48000", "-af", "aselect='not(between(t,1,2))'", "-ac", "2", "-c:a", "libopus", "-b:a", "96k")
    s = AI.scan(webm)
    assert s.info is not None and s.info.codec == "opus" and s.info.sample_rate == 48000
    assert len(s.info.gaps) == 1
    at, dur = s.info.gaps[0]
    assert abs(at - 1_002_667) <= 40_000 and abs(dur - 1_002_667) <= 20_000
    assert abs(s.info.n_samples - 144000) <= 960


def test_mp4_aac_priming_is_compensated(media_dir: Path) -> None:
    """AAC 的 1024 priming 由 mp4 edit list 補償：解碼後第一個樣本就在 0，與影片對齊。"""
    if "libopenh264" not in ff.list_encoders():
        pytest.skip("ffmpeg 沒有 libopenh264")
    mp4 = make(
        media_dir, "aac.mp4",
        "-f", "lavfi", "-i", "testsrc=s=160x120:r=30:d=2", "-f", "lavfi", "-i", "sine=f=1000:d=2:r=48000",
        "-c:v", "libopenh264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    )
    s = AI.scan(mp4)
    assert s.info is not None and s.info.codec == "aac"
    assert s.info.start_us == 0 and s.info.video_start_us == 0 and s.info.gaps == []
    assert 96000 <= s.info.n_samples <= 96000 + 2 * 1024  # 編碼器尾端 padding 最多兩幀


def test_video_without_audio(media_dir: Path) -> None:
    mkv = make(media_dir, "noaudio.mkv", "-f", "lavfi", "-i", "testsrc=s=160x120:r=30:d=1", "-c:v", "mjpeg")
    s = AI.scan(mkv)
    assert not s.has_audio and s.info is None and s.audio_streams == 0


def test_video_start_prefers_index_cache(media_dir: Path, tmp_path: Path) -> None:
    """index.v1.json 已經有 pts_ms[0] 時直接用（CfrMap 的時間原點），不再解影像。"""
    from aivc.media import index as I

    mkv = make(
        media_dir, "offset.mkv",
        "-f", "lavfi", "-i", "testsrc=s=160x120:r=30:d=2", "-itsoffset", "0.25", "-f", "lavfi", "-i", "sine=f=1000:d=2:r=48000",
        "-c:v", "mjpeg", "-c:a", "pcm_s16le",
    )
    mc = C.MediaCache("f" * 64, tmp_path / "mc")
    mc.ensure()
    I.save_index(mc.index_json, I.PtsIndex(30, 1, [33.333333333333336, 66.66666666666667], [True, True], 1, 15360))
    s = AI.scan(mkv, mc=mc)
    assert s.info is not None and s.info.video_start_us == 33333


# ---------------------------------------------------------------- 快取（缺／壞 → 重算）


def test_cache_missing_invalid_force(media_dir: Path, tmp_path: Path) -> None:
    nut = make(media_dir, "gap.nut", "-f", "lavfi", "-i", "sine=f=1000:d=3:r=48000", "-af", "aselect='not(between(t,1,2))'", "-c:a", "pcm_s16le")
    mc = C.for_file(nut)
    p = AI.audio_info_path(mc)
    assert AI.load_cached(mc) == (None, "missing")
    s1, cached, reason = AI.ensure(nut, mc)
    assert (cached, reason) == (False, "missing") and p.is_file()
    s2, cached, reason = AI.ensure(nut, mc)
    assert (cached, reason) == (True, "ok") and s2.to_json() | {"seconds": 0} == s1.to_json() | {"seconds": 0}
    # 舊版本／欄位壞掉 → 當成 stale 重算
    for bad in ({"version": 0, "hasAudio": True}, {"version": 1, "hasAudio": True, "audio": {"codec": "x"}}, "not json"):
        p.write_text(bad if isinstance(bad, str) else json.dumps(bad), encoding="utf-8")
        s3, cached, reason = AI.ensure(nut, mc)
        assert (cached, reason) == (False, "invalid") and s3.info == s1.info
    _, cached, reason = AI.ensure(nut, mc, force=True)
    assert (cached, reason) == (False, "force")
    # 快取的摘要讀回來就是專案檔 media[].audio 的形狀（AudioInfoV2.from_json 零警告）
    warns: list[str] = []
    info = S.AudioInfoV2.from_json(json.loads(p.read_text(encoding="utf-8"))["audio"], warns.append, "t")
    assert warns == [] and info == s1.info


def run_json(capsys: pytest.CaptureFixture[str], argv: list[str]) -> tuple[int, dict[str, Any]]:
    code = main(["--json", *argv])
    lines = capsys.readouterr().out.strip().splitlines()
    return code, json.loads(lines[-1])


def test_cli_op(media_dir: Path, capsys: pytest.CaptureFixture[str]) -> None:
    mp3 = make(media_dir, "樂 lame.mp3", "-f", "lavfi", "-i", "sine=f=1000:d=2:r=44100", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "128k")
    code, final = run_json(capsys, ["audio-info", str(mp3)])
    assert code == 0 and final["ok"], final
    r = final["result"]
    assert r["hasAudio"] and r["cached"] is False and r["reason"] == "missing"
    assert r["audio"]["startUs"] == 25057 and r["audio"]["videoStartUs"] is None and Path(r["audioInfoPath"]).is_file()
    assert Path(r["audioInfoPath"]).name == "audio.v1.json" and Path(r["audioInfoPath"]).parent.name == r["fingerprint"][:16]
    code, final = run_json(capsys, ["audio-info", str(mp3)])
    assert final["result"]["cached"] is True and final["result"]["audio"] == r["audio"]
    code, final = run_json(capsys, ["audio-info", str(media_dir / "nope.mp3")])
    assert code == 2 and final["ok"] is False and final["error"]["kind"] == "Invalid"


def test_sample_video_offsets(sample_video: Path) -> None:
    """範例 WebM：音訊從 0 開始、影片第一幀 pts 2 ms；60 s Opus 沒有斷層。"""
    s = AI.scan(sample_video)
    assert s.info is not None
    assert (s.info.codec, s.info.start_us, s.info.video_start_us, s.info.n_samples, s.info.gaps) == ("opus", 0, 2000, 2_880_000, [])
