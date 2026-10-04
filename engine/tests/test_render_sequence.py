"""序列渲染（設計 docs/editor-m2-design.md §7.2–§7.6；§13 M2.7）。需要 ffmpeg（內建 n8.1.2 有 `-/filter_complex`），沒有就 skip。

驗收（§13 M2.7）：
- 幀號編進像素的合成素材做倒序兩片段：輸出每一幀解出來的幀號 = 對應表 map(t)，而且整幀逐位元等於來源第 k 幀；
- 不變式 I2：有平面替換（含 A4 退化器的 coarse／淡出幀）時，序列第 t 幀 == 只渲染來源（--source）第 k 幀，ffv1 無損逐位元比
  （插入來源用測試外掛 aivc_test_insert 的貼圖；牌局版在 plugins/cards/engine/tests/test_render_sequence_cards.py）；
  定格（CfrMap 重複幀）時序列用的是來源渲染會用的代表 k；
- 不變式 I3：輸出 mkv（ffv1＋flac）的視訊剛好 T 幀、音訊解碼後剛好 S(T) 個樣本；每一幀的音訊脈衝落在 S(t)+800 樣本（誤差 ≤ 2，實際 0）；
- 空白／停用 → 黑幀與靜音；同一段來源用兩次；片段增益；音樂軌（單聲道 pan、位置以序列樣本計）；
- 顆粒種子只看 track id（`--track` 篩選不改變其他 track 的顆粒）；`--emit-matte` 以序列幀 t 編號放在 media/<mediaId>/；
- `aivc audio-mix` 的 WAV 與渲染成品的音軌逐樣本相同、stem 兩段式與一段式相同；`aivc seq show` 的片段表；
- 取消時 .part、濾鏡圖檔、stem 都清乾淨。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures" / "e1"))
import synth_scene as SC  # noqa: E402

from aivc import env  # noqa: E402
from aivc.media import audio_graph as AG  # noqa: E402
from aivc.media import encode_plan as EP  # noqa: E402
from aivc.media import encoder as EN  # noqa: E402
from aivc.media import ffmpeg as ff  # noqa: E402
from aivc.media.cfr import CfrMap  # noqa: E402
from aivc.media.source import FrameSource, Yuv420  # noqa: E402
from aivc.ops import Canceled, OpError  # noqa: E402
from aivc.ops import render as RD  # noqa: E402
from aivc.project import resolve as R  # noqa: E402
from aivc.project import schema as S  # noqa: E402
from aivc.sequence import model as SM  # noqa: E402
from aivc.track.state import Solve, State  # noqa: E402

FPS = S.Rational(30, 1)
SPF = 1600  # 30 fps 一幀 = 1600 個 48 kHz 樣本
W, H, N = 96, 64, 90  # 幀號素材
BITS = 12
PULSE_AT, PULSE_LEN = 800, 48  # 每一幀中間 1 ms 的脈衝（離片段兩端的 3 ms 防爆音淡化很遠）
MUSIC_AT, MUSIC_EVERY, MUSIC_LEN, MUSIC_VAL = 1_200, 4_800, 24, 8_192
OFFSET_SAMPLES = 12_000  # offset 素材：音訊比影片晚 0.25 s 開始


# ---------------------------------------------------------------- 素材


def _ffmpeg(*args: str) -> None:
    cp = subprocess.run([ff.exe("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "error", "-y", *args], capture_output=True, **ff.popen_kwargs())
    assert cp.returncode == 0, cp.stderr.decode("utf-8", "replace")[-800:]


def numbered_frame(k: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """第 k 幀：第一列 12 個 8×8 方塊是 k 的二進位（亮 = 1），其餘是隨 k 平移的漸層，色度也隨 k 變。"""
    yy, xx = np.mgrid[0:H, 0:W]
    y = (16 + ((xx * 2 + yy + 3 * k) % 200)).astype(np.uint8)
    for b in range(BITS):
        y[0:8, b * 8 : (b + 1) * 8] = 220 if (k >> b) & 1 else 30
    u = np.full((H // 2, W // 2), 100 + (k % 50), np.uint8)
    v = np.full((H // 2, W // 2), 160 - (k % 40), np.uint8)
    return y, u, v


def read_number(y: np.ndarray) -> int:
    return sum(1 << b for b in range(BITS) if y[4, b * 8 + 4] > 128)


def pulse_value(k: int) -> int:
    return 1_000 + 20 * k


@pytest.fixture(scope="module")
def media(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    """ffv1＋pcm_s16le mkv：幀號編進像素、第 k 幀的音訊在 S(k)+800 有一個振幅 = 1000+20k 的脈衝（右聲道反相）。
    配樂：48 kHz 單聲道 3 s，每 4800 樣本（從 1200 起）一個 0.25 的脈衝。路徑含空格與中文。"""
    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")
    d = tmp_path_factory.mktemp("序列 素材")
    raw_v, raw_a, raw_m = d / "v.yuv", d / "a.pcm", d / "m.pcm"
    with raw_v.open("wb") as f:
        for k in range(N):
            for plane in numbered_frame(k):
                f.write(plane.tobytes())
    audio = np.zeros((N * SPF, 2), dtype="<i2")
    for k in range(N):
        s = k * SPF + PULSE_AT
        audio[s : s + PULSE_LEN, 0] = pulse_value(k)
        audio[s : s + PULSE_LEN, 1] = -pulse_value(k)
    raw_a.write_bytes(audio.tobytes())
    music = np.zeros(144_000, dtype="<i2")
    for s in range(MUSIC_AT, len(music) - MUSIC_LEN, MUSIC_EVERY):
        music[s : s + MUSIC_LEN] = MUSIC_VAL
    raw_m.write_bytes(music.tobytes())
    video = d / "幀號 素材.mkv"
    _ffmpeg(
        "-f", "rawvideo", "-pix_fmt", "yuv420p", "-video_size", f"{W}x{H}", "-framerate", "30", "-i", str(raw_v),
        "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", str(raw_a),
        "-map", "0:v", "-map", "1:a", "-c:v", "ffv1", "-c:a", "pcm_s16le", str(video),
    )
    wav = d / "配樂 脈衝.wav"
    _ffmpeg("-f", "s16le", "-ar", "48000", "-ac", "1", "-i", str(raw_m), "-c:a", "pcm_s16le", str(wav))
    # 容器時間不從 0 開始、而且音訊比影片晚 0.25 s 開始（Chrome 錄影的音訊常晚幾 ms，這裡放大）：
    # 影片第一幀 pts 1.5 s、音訊第一個樣本 1.75 s；脈衝仍然對齊「同一容器時間的影片幀」→ k < 8 沒有聲音。
    # 兩條串流各自編成帶起點的檔，再 -copyts 無損合併（同一條命令裡對 raw 輸入加 -itsoffset，n8.1.2 實測會被對齊回同一個起點）
    raw_s = d / "a_shift.pcm"
    raw_s.write_bytes(audio[OFFSET_SAMPLES:].tobytes())
    v_only, a_only, offset = d / "v_only.mkv", d / "a_only.mka", d / "offset.mkv"
    _ffmpeg("-f", "rawvideo", "-pix_fmt", "yuv420p", "-video_size", f"{W}x{H}", "-framerate", "30", "-i", str(raw_v), "-c:v", "ffv1", "-output_ts_offset", "1.5", str(v_only))
    _ffmpeg("-f", "s16le", "-ar", "48000", "-ac", "2", "-i", str(raw_s), "-c:a", "pcm_s16le", "-output_ts_offset", f"{1.5 + OFFSET_SAMPLES / 48000}", str(a_only))
    _ffmpeg("-copyts", "-i", str(v_only), "-i", str(a_only), "-map", "0:v", "-map", "1:a", "-c", "copy", str(offset))
    return {"dir": d, "video": video, "music": wav, "offset": offset}


@pytest.fixture(scope="module")
def graph_ffmpeg(media: dict[str, Path]) -> None:
    if EN.filter_script_args("x")[0] != "-/filter_complex":
        pytest.skip("這份 ffmpeg 沒有 -/filter_complex（FFmpeg 7+）；退路 -filter_complex_script 另外測")


def vclip(cid: str, k0: int, k1: int, **kw: Any) -> S.VideoClipV2:
    audio = kw.pop("audio", None)
    return S.VideoClipV2(cid, "m1", k0, k1, audio=audio or S.ClipAudioV2(), **kw)


def make_project(media: dict[str, Path], seq: S.SequenceV2 | None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, video_key: str = "video") -> Path:
    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    p = S.ProjectFile(profile="cards")
    p.media.append(S.MediaV1("m1", str(media[video_key]), media[video_key].name, "", None, S.ProxyMetaV1(FPS, N, W, H)))
    p.active_media_id = "m1"
    p.sequence = seq
    if seq is not None and seq.audio_lanes:
        p.audio_media.append(S.AudioMediaV2("a-1", str(media["music"]), media["music"].name, "", None, "music"))
    ppath = tmp_path / "序列 專案.aivc.json"
    S.save(p, ppath)
    return ppath


def render(ppath: Path, out: Path, **kw: Any) -> tuple[RD.RenderPlan, dict[str, Any]]:
    mctx = R.open_media_context(ppath, None, SC.RecordingCtx())
    plan = RD.build_plan(mctx, SC.RecordingCtx(), out=str(out), codec="ffv1", gpu=False, **kw)
    return plan, RD.run_render(mctx, plan, SC.RecordingCtx())


def decode_video(path: Path) -> list[Yuv420]:
    with FrameSource(path) as fs:
        return [fs.get(i) for i in range(fs.n_frames)]


def decode_audio(path: Path) -> np.ndarray:
    cp = subprocess.run(
        [ff.exe("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(path), "-map", "0:a:0", "-f", "f32le", "-ac", "2", "pipe:1"],
        capture_output=True, **ff.popen_kwargs(),
    )
    assert cp.returncode == 0, cp.stderr.decode("utf-8", "replace")[-600:]
    return np.frombuffer(cp.stdout, dtype="<f4").reshape(-1, 2)


def audio_codec(path: Path) -> str:
    cp = subprocess.run(
        [ff.exe("ffprobe"), "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(path)],
        capture_output=True, **ff.popen_kwargs(),
    )
    return cp.stdout.decode().strip()


def pulses(ch: np.ndarray, thresh: float = 0.01) -> list[tuple[int, float]]:
    """非零段 → (起點樣本, 段內中位數)。"""
    nz = np.flatnonzero(np.abs(ch) > thresh)
    if len(nz) == 0:
        return []
    runs = np.split(nz, np.flatnonzero(np.diff(nz) > 1) + 1)
    return [(int(r[0]), float(np.median(ch[r]))) for r in runs]


def expected_pulses(seq: S.SequenceV2, gain: dict[str, float] | None = None) -> list[tuple[int, float]]:
    """每個啟用片段的每一幀：(S(t)+800, 振幅×片段增益)。"""
    out: list[tuple[int, float]] = []
    for t in range(SM.duration_frames(seq)):
        clip, k = SM.map_frame(seq, t)
        if clip is None or k is None or not clip.audio.enabled:
            continue
        g = 10 ** (clip.audio.gain_db / 20)
        out.append((SM.samples_of_frame(t, seq.fps) + PULSE_AT, pulse_value(k) / 32768 * g))
    return out


# ---------------------------------------------------------------- 倒序兩片段：幀號、I3、脈衝對齊


def test_reversed_two_clips_frame_numbers_exact_lengths_and_pulses(media: dict[str, Path], graph_ffmpeg: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    seq = S.SequenceV2("seq-1", "倒序", FPS, W, H, video=[vclip("c1", 60, 90), vclip("c2", 10, 40)])
    ppath = make_project(media, seq, tmp_path, monkeypatch)
    out = tmp_path / "輸出 倒序.mkv"
    plan, res = render(ppath, out)
    T = SM.duration_frames(seq)
    d = plan.to_json()
    # 計畫的 v1 欄位是序列的語意
    assert d["frames"] == {"total": T, "write": T, "composite": 0} and d["size"] == [W, H] and d["fps"] == {"num": 30, "den": 1}
    assert res["frames"] == T and res["audio"] == {"mode": "mix", "codec": "flac", "samples": SM.total_samples(seq)}
    assert not out.with_name(out.name + ".part").exists() and not out.with_name(out.name + ".part.audio.txt").exists()
    frames = decode_video(out)
    assert len(frames) == T  # I3：視訊剛好 T 幀
    for t, fr in enumerate(frames):
        _clip, k = SM.map_frame(seq, t)
        assert read_number(fr.y) == k, t
        y, u, v = numbered_frame(int(k))
        assert np.array_equal(fr.y, y) and np.array_equal(fr.u, u) and np.array_equal(fr.v, v), t
    assert audio_codec(out) == "flac"
    pcm = decode_audio(out)
    assert pcm.shape == (SM.total_samples(seq), 2) == (T * SPF, 2)  # I3：音訊解碼後剛好 S(T)
    got_l, got_r = pulses(pcm[:, 0]), pulses(pcm[:, 1])
    want = expected_pulses(seq)
    assert len(got_l) == len(want) == T and len(got_r) == T
    for (gp, gv), (rp, rv), (wp, wv) in zip(got_l, got_r, want):
        assert abs(gp - wp) <= 2 and abs(rp - wp) <= 2, (gp, wp)  # 設計 §7.5：≤ 2 樣本
        assert gv == pytest.approx(wv, abs=1 / 32768) and rv == pytest.approx(-wv, abs=1 / 32768)
    assert [p for p, _ in got_l] == [p for p, _ in want]  # 無損路徑上實際是 0 誤差


def test_container_start_offset_and_late_audio_align_by_absolute_pts(media: dict[str, Path], graph_ffmpeg: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """影片從容器時間 1.5 s 開始、音訊從 1.75 s 開始：音訊鏈用 -copyts 的絕對時間裁切（§7.5），脈衝仍落在 S(t)+800；
    片段入點早於音訊開始的部分補靜音（leadPad），不是把後面的聲音往前拉。"""
    seq = S.SequenceV2("seq-1", "offset", FPS, W, H, video=[vclip("c1", 40, 60), vclip("c2", 0, 20)])
    ppath = make_project(media, seq, tmp_path, monkeypatch, video_key="offset")
    out = tmp_path / "offset out.mkv"
    plan, res = render(ppath, out)
    chains = plan.to_json()["audio"]["chains"]
    assert [(c["inUs"], c["leadPad"]) for c in chains] == [(1_500_000 + 40 * 1_000_000 // 30, 0), (1_500_000, OFFSET_SAMPLES)]
    frames = decode_video(out)
    assert [read_number(f.y) for f in frames] == [SM.map_frame(seq, t)[1] for t in range(40)]
    pcm = decode_audio(out)
    assert pcm.shape == (SM.total_samples(seq), 2)
    # 來源裡還留著的脈衝：第 k 幀的脈衝在影片時間 k·1600+800 樣本，音訊從 12000 樣本才開始 → k ≥ 7
    want = [(p, v) for (p, v), t in zip(expected_pulses(seq), range(40)) if int(SM.map_frame(seq, t)[1]) * SPF + PULSE_AT >= OFFSET_SAMPLES]
    got = pulses(pcm[:, 0])
    assert [p for p, _ in got] == [p for p, _ in want] and len(got) == 20 + 13
    assert float(np.max(np.abs(pcm[20 * SPF : 20 * SPF + OFFSET_SAMPLES]))) == 0.0  # c2 開頭 0.25 s 是真的靜音


def test_two_media_interleaved(media: dict[str, Path], graph_ffmpeg: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """兩支媒體交錯（第二支不是 --media 選到的那支，走 _media_context_for）：每支各自解碼、各自的音訊起點。"""
    seq = S.SequenceV2(
        "seq-1", "two", FPS, W, H,
        video=[S.VideoClipV2("x1", "m2", 0, 10), vclip("c1", 30, 40), S.VideoClipV2("x2", "m2", 50, 60)],
    )
    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    project = S.ProjectFile(profile="cards")
    project.media.append(S.MediaV1("m1", str(media["video"]), media["video"].name, "", None, S.ProxyMetaV1(FPS, N, W, H)))
    project.media.append(S.MediaV1("m2", str(media["offset"]), media["offset"].name, "", None, S.ProxyMetaV1(FPS, N, W, H)))
    project.active_media_id = "m1"
    project.sequence = seq
    ppath = S.save(project, tmp_path / "two.aivc.json")
    assert len(S.load(ppath).project.sequence.video) == 3  # type: ignore[union-attr]
    out = tmp_path / "two.mkv"
    plan, res = render(ppath, out)
    assert plan.sequence is not None and list(plan.sequence.media) == ["m2", "m1"] and res["frames"] == 30
    frames = decode_video(out)
    assert [read_number(f.y) for f in frames] == [*range(0, 10), *range(30, 40), *range(50, 60)]
    pcm = decode_audio(out)
    assert pcm.shape == (30 * SPF, 2)
    # m2 的音訊晚 0.25 s 開始：x1 只有 k=7,8,9 有脈衝；m1、x2 每一幀都有
    want = [t * SPF + PULSE_AT for t in range(30) if t >= 7]  # x1 的 t = k
    assert [p for p, _ in pulses(pcm[:, 0])] == want


def _assert_seek_equals_sequential(video: Path, ks: list[int], upto: int) -> None:
    from aivc.media.index import build_index

    import hashlib

    def digest(fr: Yuv420) -> str:
        return hashlib.sha1(fr.to_bytes()).hexdigest()  # 720p 400 幀全留著要 550 MB，只留雜湊

    index = build_index(video)  # 兩個解碼器共用同一份索引（範例片完整解一趟要幾秒，不要解兩次）
    want = set(ks)
    with FrameSource(video, index, lru=1) as fs:
        seq_digest = {i: digest(fr) for i, fr in enumerate(fs.iter_frames(0, upto)) if i in want}
    with FrameSource(video, index, lru=1) as fs:  # 新的解碼器，只靠 seek 取幀（序列跨片段時就是這樣取）
        for k in ks:
            a = fs.get(k)
            assert a.src_idx == k and digest(a) == seq_digest[k], k
        assert fs.stats["seeks"] > 0


def test_random_seek_decodes_the_same_planes_as_sequential_vp9(media: dict[str, Path], tmp_path: Path) -> None:
    """§14.2「引擎 seek 解碼錯幀」：VP9（altref／hidden frame、關鍵幀稀疏）隨機 k 用 seek 解出來的平面 == 循序解，逐位元。"""
    vp9 = tmp_path / "sparse keys.webm"
    _ffmpeg("-i", str(media["video"]), "-an", "-c:v", "libvpx-vp9", "-g", "40", "-crf", "30", "-b:v", "0", "-auto-alt-ref", "1", "-lag-in-frames", "16", str(vp9))
    rng = np.random.default_rng(7)
    ks = [int(x) for x in rng.integers(0, N, 25)] + [89, 0, 45, 44, 39, 40, 41]
    _assert_seek_equals_sequential(vp9, ks, N)


def test_random_seek_on_sample_video(sample_video: Path) -> None:
    """同上，用真的範例 WebM（Chrome 錄影、VFR、18 個關鍵幀）；只取前 400 幀讓測試維持幾秒。"""
    rng = np.random.default_rng(11)
    _assert_seek_equals_sequential(sample_video, [int(x) for x in rng.integers(0, 400, 12)] + [399, 1, 200], 400)


def test_gap_disabled_repeat_gain_and_music_lane(media: dict[str, Path], graph_ffmpeg: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    music = S.AudioClipV2(id="a1", source=S.AudioSourceRefV2("audio", "a-1"), start=15 * SPF, length=15 * SPF, src_in=0)
    lane = S.AudioLaneV2("lane-1", "A1 音樂", role="music", sync_lock=False, clips=[music])
    seq = S.SequenceV2(
        "seq-1", "混合", FPS, W, H,
        video=[
            vclip("c1", 0, 15), S.GapV2("g1", 5), vclip("c2", 20, 30, enabled=False), vclip("c3", 0, 15),
            vclip("c4", 80, 90, audio=S.ClipAudioV2(gain_db=-6.0)),
        ],
        audio_lanes=[lane],
    )
    ppath = make_project(media, seq, tmp_path, monkeypatch)
    out = tmp_path / "mixed.mkv"
    plan, res = render(ppath, out)
    T = SM.duration_frames(seq)
    assert T == 55 and res["frames"] == T
    reasons = plan.to_json()["audio"]["reasons"]
    assert "1 段空白" in reasons and "停用 1 個片段" in reasons and "加入 1 段音訊" in reasons
    frames = decode_video(out)
    assert len(frames) == T
    for t, fr in enumerate(frames):
        item, k = SM.item_at(seq, t)
        if isinstance(item, S.GapV2) or not item.enabled:  # type: ignore[union-attr]
            assert (fr.y == 16).all() and (fr.u == 128).all() and (fr.v == 128).all(), t  # tv range 黑
            continue
        assert read_number(fr.y) == k and np.array_equal(fr.y, numbered_frame(int(k))[0]), t
    pcm = decode_audio(out)
    assert pcm.shape == (SM.total_samples(seq), 2)
    # 原音：左正右負；配樂：單聲道明寫 pan → 兩聲道都是 +0.25（沒有 −3 dB）
    orig = [(p, v) for p, v in pulses(pcm[:, 0]) if v < 0.2]
    want = expected_pulses(seq)
    assert [p for p, _ in orig] == [p for p, _ in want]
    for (_, gv), (_, wv) in zip(orig, want):
        assert gv == pytest.approx(wv, rel=2e-3, abs=1 / 32768)
    mus_l = [(p, v) for p, v in pulses(pcm[:, 0]) if v >= 0.2]
    mus_r = [(p, v) for p, v in pulses(pcm[:, 1]) if v >= 0.2]
    want_m = [music.start + s for s in range(MUSIC_AT, music.length, MUSIC_EVERY)]
    assert [p for p, _ in mus_l] == want_m == [p for p, _ in mus_r]
    assert all(v == pytest.approx(MUSIC_VAL / 32768, abs=1 / 32768) for _, v in mus_l + mus_r)
    # 空白＋停用（t 15..30）只有配樂
    gap = pcm[15 * SPF : 30 * SPF]
    assert pulses(gap[:, 0]) and all(v >= 0.2 for _, v in pulses(gap[:, 0]))


def test_audio_mix_op_matches_render_and_stems(media: dict[str, Path], graph_ffmpeg: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    from aivc.cli import main

    music = S.AudioClipV2(id="a1", source=S.AudioSourceRefV2("audio", "a-1"), start=4 * SPF, length=40 * SPF, src_in=-2_400, gain_db=-3.0, fade_in=4_800)
    seq = S.SequenceV2(
        "seq-1", "mix", FPS, W, H,
        video=[vclip("c1", 30, 50), vclip("c2", 5, 15, audio=S.ClipAudioV2(gain_db=-2.5)), vclip("c3", 70, 80)],
        audio_lanes=[S.AudioLaneV2("lane-1", "A1", role="music", sync_lock=False, clips=[music])],
    )
    ppath = make_project(media, seq, tmp_path, monkeypatch)
    out_mkv = tmp_path / "full.mkv"
    render(ppath, out_mkv)
    rendered = decode_audio(out_mkv)
    wav = tmp_path / "預覽 mix.wav"
    code = main(["--json", "audio-mix", str(ppath), "-o", str(wav)])
    res = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0 and res["ok"], res
    r = res["result"]
    assert r["samples"] == SM.total_samples(seq) and r["inputs"] == 4 and r["sequence"]["implicit"] is False
    mixed = decode_audio(wav)
    assert mixed.shape == rendered.shape
    # flac 是 s16／s32 整數，float 的 WAV 量化後要跟它一樣
    assert float(np.max(np.abs(np.round(mixed * 32768) - np.round(rendered * 32768)))) <= 1.0
    # --range：先混整條再裁，等於整條的那一段
    code = main(["--json", "audio-mix", str(ppath), "-o", str(tmp_path / "part.wav"), "--range", "12:31"])
    capsys.readouterr()
    part = decode_audio(tmp_path / "part.wav")
    s0, s1 = SM.samples_of_frame(12, FPS), SM.samples_of_frame(31, FPS)
    assert code == 0 and part.shape == (s1 - s0, 2) and float(np.max(np.abs(part - mixed[s0:s1]))) < 1e-6
    # stem 兩段式（每張圖最多 2 路）與一段式逐樣本相同；stem 與濾鏡圖檔都清掉
    project = S.load(ppath).project
    info_of, path_of = RD._audio_resolvers(project, ppath, SC.RecordingCtx())
    staged_out = tmp_path / "staged.wav"
    g = AG.build(seq, project, None, info_of=info_of, path_of=path_of, first_input=0, max_inputs=2, stem_dir=f"{staged_out}.part.stems")
    assert len(g.stems) >= 2
    EN.write_audio(g, staged_out, SC.RecordingCtx())
    assert float(np.max(np.abs(decode_audio(staged_out) - mixed))) < 1e-5
    assert not Path(f"{staged_out}.part.stems").exists() and not Path(f"{staged_out}.part.audio.txt").exists()
    # write_frames 也走 stem（rawvideo 管線＋stem 的最後一張圖）
    g1 = AG.build(seq, project, None, info_of=info_of, path_of=path_of, first_input=1, max_inputs=2, stem_dir=str(tmp_path / "vid.mkv.part.stems"))
    plan = EP.plan(EP.EncodeSpec(container="mkv", codec="ffv1", audio="mix"), EP.SourceInfo("mkv", W, H, 30, 1, True, "pcm_s16le"), ff.list_encoders())
    T = SM.duration_frames(seq)
    frames = (Yuv420(*numbered_frame(t)) for t in range(T))
    EN.write_frames(frames, plan, tmp_path / "vid.mkv", SC.RecordingCtx(), width=W, height=H, fps=(30, 1), total=T, audio_graph=g1)
    assert float(np.max(np.abs(np.round(decode_audio(tmp_path / "vid.mkv") * 32768) - np.round(rendered * 32768)))) <= 1.0
    assert not (tmp_path / "vid.mkv.part.stems").exists()


def test_audio_mix_implicit_sequence_and_errors(media: dict[str, Path], graph_ffmpeg: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    from aivc.cli import main

    ppath = make_project(media, None, tmp_path, monkeypatch)
    wav = tmp_path / "implicit.wav"
    code = main(["--json", "audio-mix", str(ppath), "-o", str(wav)])
    res = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0 and res["result"]["sequence"]["implicit"] is True and res["result"]["samples"] == N * SPF
    pcm = decode_audio(wav)
    assert [p for p, _ in pulses(pcm[:, 0])] == [k * SPF + PULSE_AT for k in range(N)]
    # 輸出檔不能是來源（.part → rename 會把素材換掉）
    code = main(["--json", "audio-mix", str(ppath), "-o", str(media["video"])])
    res = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 2 and res["error"]["kind"] == "Invalid"


def test_encoder_args_for_mix_and_filter_script_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")
    plan = EP.plan(EP.EncodeSpec(container="webm", audio="mix"), EP.SourceInfo("webm", W, H, 30, 1, True, "opus"), {"libvpx-vp9", "libopus"})
    assert plan.audio_mode == "mix"
    args = EN.ffmpeg_args(plan, width=W, height=H, fps=(30, 1), out_part="o.webm.part", audio_inputs=["a b.webm", "c.mp3"], filter_script="o.webm.part.audio.txt")
    s = " ".join(args)
    opt = EN.filter_script_args("x")[0]
    assert args.index("-copyts") < args.index("rawvideo") and "-i pipe:0 -i a b.webm -i c.mp3" in s
    assert f"{opt} o.webm.part.audio.txt -map 0:v:0 -map [aout]" in s and "-c:a libopus -b:a 160k" in s and "-an" not in args
    with pytest.raises(OpError) as e:
        EN.ffmpeg_args(plan, width=W, height=H, fps=(30, 1), out_part="o.webm.part")
    assert e.value.kind == "Internal"
    # 非 mix：不加 -copyts，v1 參數不變
    v1 = EP.plan(EP.EncodeSpec(container="mkv", codec="ffv1"), EP.SourceInfo("webm", W, H, 30, 1, True, "opus"), {"ffv1"})
    assert "-copyts" not in EN.ffmpeg_args(v1, width=W, height=H, fps=(30, 1), out_part="o.mkv.part", audio_source="in.webm")
    # 舊 ffmpeg（沒有 -/filter_complex）→ -filter_complex_script
    EN._filter_script_option_for.cache_clear()
    monkeypatch.setattr(EN.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 1, b"", b"Unrecognized option '/filter_complex'"))
    try:
        assert EN.filter_script_args("g.txt") == ["-filter_complex_script", "g.txt"]
    finally:
        EN._filter_script_option_for.cache_clear()


def test_seq_show_table(media: dict[str, Path], image_insert: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    from aivc.cli import main

    music = S.AudioClipV2(id="a1", source=S.AudioSourceRefV2("audio", "a-1"), start=48_000, length=96_000, src_in=4_410, gain_db=-12.0, fade_in=24_000)
    seq = S.SequenceV2(
        "seq-1", "表", FPS, W, H,
        video=[vclip("c1", 60, 90), S.GapV2("g1", 10), vclip("c2", 0, 45, enabled=False, audio=S.ClipAudioV2(gain_db=-3.0, fade_out=4_800))],
        audio_lanes=[S.AudioLaneV2("lane-1", "A1 音樂", role="music", sync_lock=False, clips=[music])],
    )
    ppath = make_project(media, seq, tmp_path, monkeypatch)
    # 加一條會被替換的 track（shot [70, 80)；插入來源＝測試外掛的貼圖）：c1 的來源範圍 [60, 90) 有 1 條，c2 的 [0, 45) 沒有
    doc = S.load(ppath).project
    doc.shots["m1"] = [S.ShotV1(id="s1", start_frame=70, end_frame=80, kind="close", source="auto")]
    t1 = S.TrackV1(id="t1", shot_id="s1", label="P1", reference_frame=70, keyframes=[], stale=False)
    t1.extra["testInsert"] = {"image": str(tmp_path / "new.png"), "name": "Player1"}
    doc.tracks["m1"] = [t1]
    S.save(doc, ppath)
    code = main(["--json", "seq", "show", str(ppath)])
    res = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0 and res["ok"], res
    d = res["result"]
    assert (d["frames"], d["duration"], d["samples"], d["untouched"], d["implicit"]) == (85, "00:00:02:25", 85 * SPF, False, False)
    c1, g1, c2 = d["video"]
    assert (c1["seqTcIn"], c1["seqTcOut"], c1["srcTcIn"], c1["srcTcOut"], c1["srcIn"], c1["srcOut"], c1["replacements"]) == ("00:00:00:00", "00:00:01:00", "00:00:02:00", "00:00:03:00", 60, 90, 1)
    assert c1["tracks"][0] == {"trackId": "t1", "slot": "Player1", "image": "new.png", "shot": "s1"} and g1["kind"] == "gap" and (g1["seqIn"], g1["seqOut"]) == (30, 40)
    assert c2["enabled"] is False and c2["replacements"] == 0 and c2["audio"]["gainDb"] == -3.0 and c2["offline"] is False
    lane = d["audioLanes"][0]
    assert lane["syncLock"] is False and lane["clips"][0]["startSeconds"] == 1.0 and lane["clips"][0]["source"]["name"] == media["music"].name
    # 沒有插入來源（開源版、沒有外掛）：替換數一律 0
    from aivc import hooks

    with hooks.suspended():
        code = main(["--json", "seq", "show", str(ppath)])
        d0 = json.loads(capsys.readouterr().out.strip().splitlines()[-1])["result"]
    assert code == 0 and [r.get("replacements") for r in d0["video"]] == [0, None, 0]
    code = main(["seq", "show", str(ppath)])
    human = capsys.readouterr().out
    assert code == 0 and "[60, 90)" in human and "[停用]" in human and "（空白：黑畫面＋靜音）" in human and "A1 音樂" in human
    # 隱含序列（sequence == null）：整段素材、未修改
    ppath2 = make_project(media, None, tmp_path / "implicit", monkeypatch)
    code = main(["--json", "seq", "show", str(ppath2)])
    d2 = json.loads(capsys.readouterr().out.strip().splitlines()[-1])["result"]
    assert code == 0 and d2["implicit"] is True and d2["untouched"] is True and d2["video"][0]["srcOut"] == N


def test_cancel_cleans_part_script(media: dict[str, Path], graph_ffmpeg: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    seq = S.SequenceV2("seq-1", "c", FPS, W, H, video=[vclip("c1", 60, 90), vclip("c2", 10, 40)])
    ppath = make_project(media, seq, tmp_path, monkeypatch)
    out = tmp_path / "cancel.mkv"
    mctx = R.open_media_context(ppath, None, SC.RecordingCtx())
    plan = RD.build_plan(mctx, SC.RecordingCtx(), out=str(out), codec="ffv1", gpu=False)
    with pytest.raises(Canceled):
        RD.run_render(mctx, plan, SC.RecordingCtx(cancel_after=20))
    leftovers = [p.name for p in tmp_path.iterdir() if p.name.startswith("cancel.mkv")]
    assert leftovers == []


# ---------------------------------------------------------------- I2：有平面替換（含退化器）時逐位元等於來源渲染


NC = 12
Q_P1 = SC.card_quad(250, 410, 122, 80)
Q_B1 = SC.card_quad(750, 412, 122, 80)


@pytest.fixture(scope="module")
def deck_dir(tmp_path_factory: pytest.TempPathFactory) -> tuple[Path, Path]:
    """（名字沿用）兩張貼圖：新面／原面。"""
    return SC.write_sign_pngs(tmp_path_factory.mktemp("signs"))


@pytest.fixture(scope="module")
def card_clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """12 幀靜止的兩塊原圖平面；左上角一塊隨幀號移動的白塊（離平面很遠），確認輸出真的來自對的來源幀。"""
    orig = SC.make_sign_rgba("orig")
    frames = []
    for i in range(NC):
        img = SC.felt_frame()
        SC.paste_rgba(img, orig, Q_P1, shade=0.92)
        SC.paste_rgba(img, orig, Q_B1, shade=0.96)
        img[10:30, 10 + 30 * i : 30 + 30 * i] = 255
        frames.append(img)
    return SC.write_clip(tmp_path_factory.mktemp("signs-clip") / "signs.mkv", frames)


def card_project(clip: Path, deck_dir: tuple[Path, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch, seq: S.SequenceV2 | None) -> Path:
    """t1（沒有遮罩）：k=6,7 追蹤失敗、沒有遮罩可 coarse → A4 淡出（opacity 取決於 k=5 的「最後一個好 H」，看得見）。
    t2（有遮罩）：k=3 conf 0.2 但 H 與遮罩都在 → coarse 候選（要看這一幀的像素）；k=4,5 追蹤失敗、遮罩還在 → 遮罩四角 coarse 或淡出。
    兩條 track 在「從沒追蹤到過」的全新狀態下都會 hold（輸出原樣），所以序列跳著取 k 時沒有照來源渲染的順序重播退化器，
    輸出一定跟來源渲染不同。插入來源：測試外掛 aivc_test_insert（貼圖）。"""
    new, orig = deck_dir
    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    ppath, project, cache = SC.make_project(
        clip, NC,
        [
            {"id": "t1", "quad": Q_P1, "image": new, "original": orig, "name": "Player1", "states": {6: State.LOST, 7: State.LOST}, "masks": False},
            {"id": "t2", "quad": Q_B1, "image": new, "original": orig, "name": "Banker1", "states": {4: State.LOST, 5: State.LOST}},
        ],
    )
    sp = cache.solve("t2")
    solve = Solve.read(sp)
    solve.frames[3].conf = 0.2
    solve.write(sp, sp.with_name("solve.hud.v1.json"))
    if seq is not None:
        project = S.load(ppath).project
        project.sequence = seq
        S.save(project, ppath)
    return ppath


def test_i2_sequence_frames_equal_source_render_with_degraded_frames(card_clip: Path, deck_dir: tuple[Path, Path], image_insert: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """倒序＋重複使用＋從淡出中間開始的片段：序列第 t 幀 == --source 渲染第 k 幀（ffv1 逐位元）。

    片段順序刻意安排成每一種「狀態錯了就會畫錯」的情況都出現：c1 從 t1 淡出的第一格開始（好 H 還沒出現過）；
    c5 往回跳到淡出第二格（退化器的最後一個好 H 已經是 k=11，不歸零就會 hold）；c3 從 t2 的 coarse 之後開始（要重播 k=3 的完整合成）；
    c4 從 coarse 候選幀本身開始（只要重播 0..2 的追蹤狀態）。"""
    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")
    seq = S.SequenceV2(
        "seq-1", "i2", FPS, SC.W, SC.H,
        video=[vclip_m("c1", 6, 12), vclip_m("c5", 7, 8), vclip_m("c2", 0, 6), vclip_m("c3", 4, 5), S.GapV2("g", 1), vclip_m("c4", 3, 5)],
    )
    ppath = card_project(card_clip, deck_dir, tmp_path, monkeypatch, seq)
    ctx = SC.RecordingCtx()
    mctx = R.open_media_context(ppath, None, ctx)
    src_plan = RD.build_plan(mctx, ctx, out=str(tmp_path / "source.mkv"), codec="ffv1", gpu=False, sequence="ignore", emit_matte=str(tmp_path / "src_matte"))
    assert src_plan.sequence is None
    RD.run_render(mctx, src_plan, ctx)
    t1, t2 = src_plan.jobs
    assert t1.faded >= 1 and t2.faded + t2.coarse >= 1  # 素材本身真的有走退化路徑，這個測試才有意義
    source = decode_video(tmp_path / "source.mkv")
    raw = decode_video(card_clip)

    calls: list[int] = []
    orig = RD._MediaRenderer._replay_composite
    monkeypatch.setattr(RD._MediaRenderer, "_replay_composite", lambda self, k: (calls.append(k), orig(self, k))[1])
    mctx = R.open_media_context(ppath, None, ctx)
    plan = RD.build_plan(mctx, ctx, out=str(tmp_path / "seq.mkv"), codec="ffv1", gpu=False, emit_matte=str(tmp_path / "seq_matte"))
    assert plan.sequence is not None and plan.sequence.needs_render and plan.encode.audio_mode == "none"
    res = RD.run_render(mctx, plan, ctx)
    T = SM.duration_frames(seq)
    out = decode_video(tmp_path / "seq.mkv")
    assert res["frames"] == T == len(out)
    black = Yuv420.blank(SC.W, SC.H)
    for t, fr in enumerate(out):
        item, k = SM.item_at(seq, t)
        if k is None:
            assert np.array_equal(fr.y, black.y) and np.array_equal(fr.u, black.u), t
            continue
        s = source[k]
        assert np.array_equal(fr.y, s.y) and np.array_equal(fr.u, s.u) and np.array_equal(fr.v, s.v), (t, k)
    assert 3 in calls  # 往回跳時 coarse 候選幀（k=3）是完整重播合成的
    # 素材的每一幀都至少有一條 track 看得見地換了（所以上面的逐位元相等不是「兩邊都原樣」的巧合）
    for k in range(NC):
        assert not np.array_equal(source[k].y, raw[k].y), k
    # t=0 是 k=6（t1 淡出；它依賴的 k=5 好 H 在序列裡還沒出現過）：t1 那塊確實不是原樣
    box_p1 = (slice(400, 500), slice(240, 385))
    assert not np.array_equal(out[0].y[box_p1], raw[6].y[box_p1])
    # --emit-matte：序列幀 t 編號、放在 media/<mediaId>/；內容等於來源渲染第 k 幀的 matte
    import cv2

    for t in range(T):
        item, k = SM.item_at(seq, t)
        p = tmp_path / "seq_matte" / "media" / "m1" / "t1" / f"{t:06d}.png"
        if k is None:
            assert not p.exists(), t
            continue
        a, b = cv2.imread(str(p), cv2.IMREAD_GRAYSCALE), cv2.imread(str(tmp_path / "src_matte" / "t1" / f"{k:06d}.png"), cv2.IMREAD_GRAYSCALE)
        assert a is not None and b is not None and np.array_equal(a, b), (t, k)
    tracks = {j["id"]: j for j in plan.to_json()["tracks"]}
    # 計畫 JSON 的 frames = 序列用到的不同來源 k 數（這個序列把 12 幀全用到了）
    assert tracks["t1"]["mediaId"] == "m1" and tracks["t1"]["frames"] == NC and plan.n_composite == T - 1


def vclip_m(cid: str, k0: int, k1: int) -> S.VideoClipV2:
    return S.VideoClipV2(cid, "m1", k0, k1)


def test_grain_seed_depends_only_on_track_id(card_clip: Path, deck_dir: tuple[Path, Path], image_insert: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")
    ppath = card_project(card_clip, deck_dir, tmp_path, monkeypatch, None)
    ctx = SC.RecordingCtx()
    mctx = R.open_media_context(ppath, None, ctx)
    full = RD.build_plan(mctx, ctx, out=str(tmp_path / "a.mkv"), codec="ffv1", gpu=False, seed=5)
    only = RD.build_plan(mctx, ctx, out=str(tmp_path / "b.mkv"), codec="ffv1", gpu=False, seed=5, track_ids=["t2"])
    assert [j.track.id for j in full.jobs] == ["t1", "t2"] and [j.track.id for j in only.jobs] == ["t2"]
    assert full.jobs[1].seed == only.jobs[0].seed == RD.track_seed(5, "t2") and full.jobs[0].seed != full.jobs[1].seed
    assert RD.track_seed(0, "t1") == RD.track_seed(0, "t1") and RD.track_seed(1, "t1") == RD.track_seed(0, "t1") + 1
    # 同一幀：只渲染 t2 時，t2 那塊的像素與兩條一起渲染時相同（顆粒不因 job 序號改變）
    a = RD.composite_at(decode_video(card_clip)[2], 2, full, ctx)
    b = RD.composite_at(decode_video(card_clip)[2], 2, only, ctx)
    box = (slice(400, 505), slice(740, 885))
    assert np.array_equal(a.y[box], b.y[box])


# ---------------------------------------------------------------- 定格：代表 k


NS_DUP = 8
RUNS = [(0, 0, 2), (2, 1, 1), (3, 1, 1), (4, 1, 1), (5, 2, 4), (9, 5, 1), (10, 6, 2)]
MAP = [0, 1, 1, 1, 1, 2, 3, 4, 5, 5, 6, 7]


def test_duplicate_runs_use_the_same_representative_k_as_source_render(card_clip: Path, deck_dir: tuple[Path, Path], image_insert: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """CfrMap 有定格（k=1..4 都是來源 1）：來源渲染只在 k=1 合成、k=2..4 重送；序列從 k=3 開始也要輸出 k=1 的合成結果。"""
    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")
    seq = S.SequenceV2("seq-1", "dup", FPS, SC.W, SC.H, video=[vclip_m("c1", 3, 5), vclip_m("c2", 9, 10), vclip_m("c3", 0, 12)])
    ppath = card_project(card_clip, deck_dir, tmp_path, monkeypatch, seq)
    ctx = SC.RecordingCtx()
    cfr = CfrMap.from_runs(30, 1, len(MAP), NC, RUNS)
    assert cfr.to_list() == MAP

    mctx = R.open_media_context(ppath, None, ctx)
    mctx.cfr = cfr
    src_plan = RD.build_plan(mctx, ctx, out=str(tmp_path / "s.mkv"), codec="ffv1", gpu=False, sequence="ignore")
    source = list(RD.render_frames(mctx, src_plan, ctx))
    assert len(source) == len(MAP)

    mctx = R.open_media_context(ppath, None, ctx)
    mctx.cfr = cfr
    plan = RD.build_plan(mctx, ctx, out=str(tmp_path / "q.mkv"), codec="ffv1", gpu=False)
    out = list(RD.render_sequence_frames(plan, ctx))
    assert len(out) == SM.duration_frames(seq)
    for t, fr in enumerate(out):
        _clip, k = SM.map_frame(seq, t)
        s = source[int(k)]
        assert np.array_equal(fr.y, s.y) and np.array_equal(fr.u, s.u) and np.array_equal(fr.v, s.v), (t, k)
    # 定格內的兩個 k 在來源渲染裡是同一份結果；序列 t=0（k=3）與 t=1（k=4）也是同一個物件（只合成一次）
    assert out[0] is out[1]


def test_sequence_plan_checks_and_range_semantics(card_clip: Path, deck_dir: tuple[Path, Path], image_insert: Any, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")
    seq = S.SequenceV2("seq-1", "r", FPS, SC.W, SC.H, video=[vclip_m("c1", 6, 12), vclip_m("c2", 0, 6)])
    ppath = card_project(card_clip, deck_dir, tmp_path, monkeypatch, seq)
    ctx = SC.RecordingCtx()
    mctx = R.open_media_context(ppath, None, ctx)
    # --range 不 --trim：寫出全部 12 幀、只合成序列幀 [2, 8)
    plan = RD.build_plan(mctx, ctx, out=str(tmp_path / "r.mkv"), codec="ffv1", gpu=False, range_spec="2:8")
    assert (plan.n_write, plan.range, plan.trim, plan.n_frames) == (12, (2, 8), False, 12)
    out = list(RD.render_sequence_frames(plan, ctx))
    raw = decode_video(card_clip)
    for t, fr in enumerate(out):
        _clip, k = SM.map_frame(seq, t)
        same = np.array_equal(fr.y, raw[int(k)].y)
        assert same == (not 2 <= t < 8), t
    # --trim：只寫 [2, 8)
    plan = RD.build_plan(mctx, ctx, out=str(tmp_path / "r.mkv"), codec="ffv1", gpu=False, range_spec="2:8", trim=True)
    assert plan.n_write == 6 and len(list(RD.render_sequence_frames(plan, ctx))) == 6
    # --track 指到不存在的 track
    with pytest.raises(OpError) as e:
        RD.build_plan(mctx, ctx, out=str(tmp_path / "r.mkv"), codec="ffv1", gpu=False, track_ids=["nope"])
    assert e.value.kind == "Invalid"
    # 輸出檔是序列裡的來源 → 擋
    with pytest.raises(OpError):
        RD.build_plan(mctx, ctx, out=str(card_clip), codec="ffv1", gpu=False)
    # 序列尺寸與媒體不同 → 擋（proxy 的 fps 對、但像素尺寸不對）
    bad = S.load(ppath).project
    assert bad.sequence is not None
    bad.sequence.width = 640
    S.save(bad, ppath)
    with pytest.raises(OpError) as e:
        RD.build_plan(R.open_media_context(ppath, None, ctx), ctx, out=str(tmp_path / "r.mkv"), codec="ffv1", gpu=False)
    assert "尺寸" in str(e.value)
