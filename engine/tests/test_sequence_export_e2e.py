"""序列輸出的端到端驗收（設計 docs/editor-m2-design.md §13 M2.17、§7.4）。需要範例影片與 ffmpeg，沒有就 skip。

- 範例影片（參考片段，VP9＋Opus、VFR）照 §7.4 剪兩個片段（300＋450 幀）＋一段 44.1 kHz 音樂（增益、淡化、閃避自動化）
  → 輸出 webm：視訊剛好 750 幀、音訊解碼後剛好 1 200 000 個樣本、音訊與視訊長度差 ≤ 1 幀。
  幀數與樣本數用兩種方法量：ffprobe／ffmpeg 解碼（獨立於引擎），以及 App 的「輸出後驗收」實際呼叫的 `media.index`／`media.audio_info`
  （pipeline/exportVideo.ts measureExport）—— 兩邊一致，App 顯示的驗收結果才可信。
- 未剪輯的專案（序列 = 整段一個片段，值等於 v0.0.6）：計畫的 v1 欄位跟沒有序列時逐鍵相同（I4），音訊 `-c:a copy`，
  輸出的音訊封包數 = 來源的封包數（範例是 1000）。

範例影片是 gitignored：放在 `samples/`（找法見 tests/_sample.py），或用 `AIVC_SAMPLE_VIDEO` 指到別的路徑（worktree 共用主 repo 那一份）。
"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures" / "e1"))
import synth_scene as SC  # noqa: E402
from _sample import sample_path  # noqa: E402

from aivc import env  # noqa: E402
from aivc.media import encoder as EN  # noqa: E402
from aivc.media import ffmpeg as ff  # noqa: E402
from aivc.ops import media as MO  # noqa: E402
from aivc.ops import render as RD  # noqa: E402
from aivc.project import resolve as R  # noqa: E402
from aivc.project import schema as S  # noqa: E402
from aivc.sequence import model as SM  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
FPS = S.Rational(30, 1)
N = 1797  # 範例影片的 proxy 幀數（30/1）


@pytest.fixture(scope="module")
def sample() -> Path:
    p = sample_path()
    if not p.is_file():
        pytest.skip(f"沒有範例影片 {p}（gitignored；可用 AIVC_SAMPLE_VIDEO 指定）")
    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")
    if EN.filter_script_args("x")[0] != "-/filter_complex":
        pytest.skip("這份 ffmpeg 沒有 -/filter_complex（FFmpeg 7+）")
    return p


def _run(*args: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(list(args), capture_output=True, **ff.popen_kwargs())


@pytest.fixture(scope="module")
def music(tmp_path_factory: pytest.TempPathFactory, sample: Path) -> Path:
    """30 s、44.1 kHz 立體聲的音樂（有 libmp3lame 就是 mp3，帶 LAME 延遲；沒有就 wav）。"""
    d = tmp_path_factory.mktemp("音樂 素材")
    mp3 = d / "bgm.mp3"
    cp = _run(ff.exe("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:r=44100:d=30", "-ac", "2", "-c:a", "libmp3lame", str(mp3))
    if cp.returncode == 0 and mp3.is_file():
        return mp3
    wav = d / "bgm.wav"
    cp = _run(ff.exe("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=f=440:r=44100:d=30", "-ac", "2", str(wav))
    assert cp.returncode == 0, cp.stderr.decode("utf-8", "replace")[-600:]
    return wav


def project(sample: Path, seq: S.SequenceV2 | None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, music: Path | None = None) -> Path:
    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    p = S.ProjectFile(profile="cards")
    p.media.append(S.MediaV1("m1", str(sample), sample.name, "", {"video": {"width": 1280, "height": 720}}, S.ProxyMetaV1(FPS, N, 1280, 720)))
    p.active_media_id = "m1"
    p.sequence = seq
    if music is not None:
        p.audio_media.append(S.AudioMediaV2("a-1", str(music), music.name, "", None, "music"))
    ppath = tmp_path / "序列 輸出.aivc.json"
    S.save(p, ppath)
    return ppath


def seq_74() -> S.SequenceV2:
    """§7.4：c1 = k 60..360、c2 = k 930..1380（−3 dB、1 s 等功率淡出）；音樂 −12 dB、淡入 2 s、淡出 3 s、序列 10～14 s 閃避 −10 dB。"""
    music = S.AudioLaneV2("lane-1", "A1 音樂", role="music", sync_lock=False, clips=[
        S.AudioClipV2(
            id="a1", source=S.AudioSourceRefV2("audio", "a-1"), start=48_000, length=960_000, src_in=88_200,
            gain_db=-12.0, fade_in=96_000, fade_out=144_000, fade_curve="equalPower",
            envelope=[S.GainPointV2(420_000, 0.0), S.GainPointV2(432_000, -10.0), S.GainPointV2(624_000, -10.0), S.GainPointV2(636_000, 0.0)],
        ),
    ])
    return S.SequenceV2("seq-1", "sample_clip1", FPS, 1280, 720, video=[
        S.VideoClipV2("c1", "m1", 60, 360),
        S.VideoClipV2("c2", "m1", 930, 1380, audio=S.ClipAudioV2(gain_db=-3.0, fade_out=48_000, fade_curve="equalPower")),
    ], audio_lanes=[music])


def ffprobe_count(path: Path, stream: str, what: str) -> int:
    entry = "nb_read_frames" if what == "frames" else "nb_read_packets"
    flag = "-count_frames" if what == "frames" else "-count_packets"
    cp = _run(ff.exe("ffprobe"), "-v", "error", flag, "-select_streams", stream, "-show_entries", f"stream={entry}", "-of", "csv=p=0", str(path))
    assert cp.returncode == 0, cp.stderr.decode("utf-8", "replace")[-600:]
    return int(cp.stdout.decode().strip())


def decoded_samples(path: Path) -> int:
    cp = _run(ff.exe("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(path), "-map", "0:a:0", "-f", "f32le", "-ac", "2", "pipe:1")
    assert cp.returncode == 0, cp.stderr.decode("utf-8", "replace")[-600:]
    return len(cp.stdout) // 8


def plan_and_run(ppath: Path, out: Path, **kw: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    mctx = R.open_media_context(ppath, None, SC.RecordingCtx())
    plan = RD.build_plan(mctx, SC.RecordingCtx(), out=str(out), gpu=False, **kw)
    return plan.to_json(), RD.run_render(mctx, plan, SC.RecordingCtx())


def test_two_clips_and_music_render_750_frames_and_exact_samples(sample: Path, music: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    seq = seq_74()
    assert SM.duration_frames(seq) == 750
    ppath = project(sample, seq, tmp_path, monkeypatch, music)
    out = tmp_path / "序列 成品.webm"
    plan, res = plan_and_run(ppath, out, quality=40)
    assert plan["sequence"]["frames"] == 750 and plan["sequence"]["untouched"] is False
    assert plan["audio"]["mode"] == "mix" and plan["audio"]["samples"] == 1_200_000
    assert res["frames"] == 750

    # 獨立量法：ffprobe 數幀、ffmpeg 解碼數樣本
    frames = ffprobe_count(out, "v:0", "frames")
    samples = decoded_samples(out)
    assert frames == 750
    assert samples == 1_200_000
    assert abs(samples / 48_000 - frames / 30) <= 1 / 30

    # App 的「輸出後驗收」用的量法（exportVideo.ts measureExport → media.index／media.audio_info）：跟上面一致
    idx = MO.index_op({"video": str(out)}, SC.RecordingCtx())
    info = MO.audio_info_op({"video": str(out)}, SC.RecordingCtx())
    assert idx["nSource"] == 750
    assert info["audio"]["nSamples"] == 1_200_000 and info["audio"]["sampleRate"] == 48_000


def test_untouched_sequence_exports_like_v006_with_audio_copy(sample: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    whole = S.SequenceV2("seq-1", "sample_clip1", FPS, 1280, 720, video=[S.VideoClipV2("c1", "m1", 0, N)])
    out = tmp_path / "未剪輯.mkv"
    # 沒有序列（v0.0.6）的計畫
    ppath_none = project(sample, None, tmp_path / "none", monkeypatch)
    mctx = R.open_media_context(ppath_none, None, SC.RecordingCtx())
    plan_none = RD.build_plan(mctx, SC.RecordingCtx(), out=str(out), codec="ffv1", gpu=False).to_json()
    assert "sequence" not in plan_none and "audio" not in plan_none

    ppath = project(sample, whole, tmp_path, monkeypatch)
    plan, res = plan_and_run(ppath, out, codec="ffv1")
    assert plan["sequence"]["untouched"] is True
    # I4：v1 欄位逐鍵相同，只多 sequence／audio 兩塊
    assert {k: v for k, v in plan.items() if k not in ("sequence", "audio")} == plan_none
    assert plan["encode"]["audio_mode"] == "copy"
    assert res["audio"]["mode"] == "copy"

    src_packets = ffprobe_count(sample, "a:0", "packets")
    out_packets = ffprobe_count(out, "a:0", "packets")
    assert out_packets == src_packets
    assert ffprobe_count(out, "v:0", "frames") == N
