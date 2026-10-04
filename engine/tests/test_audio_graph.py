"""media/audio_graph.py、encode_plan 的 mix 模式、render.plan 的 sequence／audio 區塊（設計 §7.1–§7.6；§13 M2.6）。

驗收（§13 M2.6）：
- golden：§7.4 的濾鏡圖逐字相同（內嵌一份，並與設計文件的區塊比對，兩邊任何一邊改了都會紅）；
- 案例：29.97 fps、inUs 早於串流開始（leadPad）、停用片段、靜音軌、空白、單聲道 pan、範圍 trim、> 32 輸入改走 stem；
- v1 專案的計畫不變（I4）：沒有序列時計畫 JSON 沒有 sequence／audio 兩個鍵，encode_plan golden 由 test_media_encode_plan 把關。
另外用內建 ffmpeg 實跑產生的圖（語法、樣本數剛好 S(T)、stem 兩段式與一段式逐樣本相同、leadPad 真的是靜音）。
"""
from __future__ import annotations

import json
import math
import re
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
from aivc.media import audio_info as AI  # noqa: E402
from aivc.media import cache as C  # noqa: E402
from aivc.media import encode_plan as EP  # noqa: E402
from aivc.media import ffmpeg as ff  # noqa: E402
from aivc.ops import OpError  # noqa: E402
from aivc.ops import render as RD  # noqa: E402
from aivc.project import resolve as R  # noqa: E402
from aivc.project import schema as S  # noqa: E402
from aivc.sequence import model as SM  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
FIXTURE_74 = REPO / "fixtures" / "project" / "v2" / "two-clips-music.aivc.json"
DESIGN = REPO / "docs" / "editor-m2-design.md"

# 設計 §7.4「濾鏡圖檔 out.webm.part.audio.txt」逐字（已在 n8.1.2 實跑過的那張）
GOLDEN_74 = """[1:a]atrim=start=2.000000:end=12.000000,asetpts=PTS-STARTPTS,aresample=48000:async=1:min_hard_comp=0.020:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end_sample=480000,afade=t=in:ss=0:ns=144:curve=tri,afade=t=out:ss=479856:ns=144:curve=tri,adelay=delays=0S:all=1[c1];
[2:a]atrim=start=31.000000:end=46.000000,asetpts=PTS-STARTPTS,aresample=48000:async=1:min_hard_comp=0.020:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end_sample=720000,afade=t=in:ss=0:ns=144:curve=tri,afade=t=out:ss=672000:ns=48000:curve=qsin,volume=volume=-3dB,adelay=delays=480000S:all=1[c2];
[3:a]atrim=start=2.025057:end=22.025057,asetpts=PTS-STARTPTS,aresample=48000:async=1:min_hard_comp=0.020:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end_sample=960000,asetnsamples=n=240:p=0,volume=eval=frame:volume='if(lt(t,8.75),1,if(lt(t,9),pow(10,-10*(t-8.75)/0.25/20),if(lt(t,13),pow(10,-10/20),if(lt(t,13.25),pow(10,-10*(13.25-t)/0.25/20),1))))',afade=t=in:ss=0:ns=96000:curve=qsin,afade=t=out:ss=816000:ns=144000:curve=qsin,volume=volume=-12dB,adelay=delays=48000S:all=1[m1];
[c1][c2][m1]amix=inputs=3:duration=longest:dropout_transition=0:normalize=0,apad,atrim=end_sample=1200000[aout]
"""


# ---------------------------------------------------------------- 建構小工具


def load_74(mutate: Any = None) -> S.ProjectFile:
    doc = json.loads(FIXTURE_74.read_text(encoding="utf-8"))
    if mutate is not None:
        mutate(doc)
    r = S.loads(json.dumps(doc, ensure_ascii=False))
    return r.project


def info(**over: Any) -> S.AudioInfoV2:
    d: dict[str, Any] = dict(codec="opus", sample_rate=48000, channels=2, channel_layout="stereo", start_us=0, video_start_us=0, n_samples=600 * 48000, gaps=[])
    d.update(over)
    return S.AudioInfoV2(**d)


def vclip(cid: str, k0: int, k1: int, media: str = "m1", enabled: bool = True, **audio: Any) -> S.VideoClipV2:
    return S.VideoClipV2(cid, media, k0, k1, enabled=enabled, audio=S.ClipAudioV2(**audio))


def aclip(cid: str, start: int, length: int, src_in: int = 0, source: tuple[str, str] = ("audio", "a-1"), **gain: Any) -> S.AudioClipV2:
    return S.AudioClipV2(id=cid, source=S.AudioSourceRefV2(*source), start=start, length=length, src_in=src_in, **gain)


def lane(lid: str, clips: list[S.AudioClipV2], role: str = "music", **kw: Any) -> S.AudioLaneV2:
    return S.AudioLaneV2(lid, f"A {lid}", role=role, sync_lock=role != "music", clips=clips, **kw)


def mkseq(video: list[Any], lanes: list[S.AudioLaneV2] | None = None, fps: tuple[int, int] = (30, 1), **kw: Any) -> S.SequenceV2:
    return S.SequenceV2("seq-1", "t", S.Rational(*fps), 1280, 720, video=list(video), audio_lanes=list(lanes or []), **kw)


def build(seq: S.SequenceV2, infos: dict[tuple[str, str], S.AudioInfoV2 | None] | None = None, **kw: Any) -> AG.AudioGraph:
    infos = infos if infos is not None else {}

    def info_of(kind: str, ref: str) -> S.AudioInfoV2 | None:
        if (kind, ref) in infos:
            return infos[(kind, ref)]  # 可以是 None（來源沒有音軌）
        return info() if kind == "media" else info(codec="mp3", sample_rate=44100, video_start_us=None)

    return AG.build(seq, None, info_of=info_of, path_of=lambda kind, ref: f"{kind}-{ref}.src", **kw)


def chain_of(g: AG.AudioGraph, clip_id: str) -> AG.Chain:
    return next(c for c in g.chains if c.clip_id == clip_id)


def eval_expr(expr: str, t: float) -> float:
    """把 ffmpeg 運算式轉成 Python 求值（只用得到 if／lt／pow 與四則運算，優先序與 ffmpeg 相同）。"""
    py = re.sub(r"\b(if|lt|pow)\(", r"_\1(", expr)
    # Python 會先把 if 的兩個分支都算出來：沒被選到的斜坡在區段外可能是 10^(幾千)，溢位時回 inf（反正不會被選到）
    env_ = {"_if": lambda c, a, b: a if c else b, "_lt": lambda a, b: 1.0 if a < b else 0.0, "_pow": lambda a, b: math.inf if b > 300 else math.pow(a, b), "t": t}
    return float(eval(py, {"__builtins__": {}}, env_))  # noqa: S307 — 測試自己產生的運算式


def paren_depth(s: str) -> int:
    depth = best = 0
    for ch in s:
        depth += ch == "("
        depth -= ch == ")"
        best = max(best, depth)
    return best


# ---------------------------------------------------------------- golden：§7.4


def test_design_74_graph_verbatim() -> None:
    project = load_74()
    assert project.sequence is not None
    g = AG.build(project.sequence, project)
    assert g.text == GOLDEN_74
    assert [i.chain_id for i in g.inputs] == ["c1", "c2", "m1"] and [i.clip_id for i in g.inputs] == ["c1", "c2", "a1"]
    # 同一支來源用兩個 -i（不用 asplit：背壓，§7.4）
    assert g.inputs[0].path == g.inputs[1].path == project.media[0].path and g.inputs[2].path == r"D:\music\bgm.mp3"
    assert (g.total_samples, g.sequence_samples, g.window, g.stems, g.notes, g.peak_estimate_dbfs) == (1_200_000, 1_200_000, None, [], [], None)
    # §7.4 的數字表
    table = [(c.label, c.in_us, c.out_us, c.length, c.delay, c.gain_db) for c in g.chains]
    assert table == [
        ("c1", 2_000_000, 12_000_000, 480_000, 0, 0.0),
        ("c2", 31_000_000, 46_000_000, 720_000, 480_000, -3.0),
        ("m1", 2_025_057, 22_025_057, 960_000, 48_000, -12.0),
    ]


def test_embedded_golden_equals_design_doc_block() -> None:
    """內嵌的 golden 就是設計文件那個區塊：文件改了圖（例如 M2.0 的更正）而程式沒跟上，這裡會紅。"""
    if not DESIGN.is_file():
        pytest.skip("沒有設計文件")
    doc = DESIGN.read_text(encoding="utf-8")
    m = re.search(r"濾鏡圖檔 `out\.webm\.part\.audio\.txt`[^\n]*\n\n```text\n(.*?)```", doc, re.S)
    assert m, "設計 §7.4 的濾鏡圖區塊找不到（標題改了？）"
    assert m.group(1) == GOLDEN_74


def test_2997_variant_tiles_exactly() -> None:
    """§7.4 最後一段：同樣的片段在 30000/1001 fps。"""

    def to_2997(doc: dict[str, Any]) -> None:
        doc["sequence"]["fps"] = {"num": 30000, "den": 1001}
        doc["media"][0]["proxy"]["fps"] = {"num": 30000, "den": 1001}
        doc["sequence"]["audioLanes"] = []

    project = load_74(to_2997)
    seq = project.sequence
    assert seq is not None
    g = AG.build(seq, project)
    c1, c2 = g.chains
    assert (c1.in_us, c1.out_us, c1.length, c1.delay) == (2_002_000, 12_012_000, 480_480, 0)
    assert (c2.in_us, c2.out_us, c2.length, c2.delay) == (31_031_000, 46_046_000, 720_720, 480_480)
    assert g.total_samples == SM.total_samples(seq) == 1_201_200 == c1.length + c2.length  # 鋪滿：Σ片段長 = S(T)
    assert "atrim=start=2.002000:end=12.012000," in g.text and "afade=t=out:ss=480336:ns=144:curve=tri" in g.text
    assert g.text.endswith("[c1][c2]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0,apad,atrim=end_sample=1201200[aout]\n")


# ---------------------------------------------------------------- 邊界案例


def test_lead_pad_when_in_point_precedes_stream_start() -> None:
    """音訊比影片晚 6.5 ms 開始（startUs = 6 500、videoStartUs = 0）：V1 片段從 k=0 開始、分離出來的音訊片段 srcIn 為負，都要補 312 樣本。"""
    src = info(start_us=6_500, video_start_us=0)
    # TS detachAudio：srcIn = round((videoStartUs + absUs(k=0) − startUs) · sr / 1e6) = −312
    seq = mkseq([vclip("v1", 0, 30), vclip("v2", 30, 60)], [lane("l1", [aclip("d1", 48_000, 48_000, src_in=-312, source=("media", "m1"))], role="other")])
    g = build(seq, {("media", "m1"): src})
    v1, v2, d1 = chain_of(g, "v1"), chain_of(g, "v2"), chain_of(g, "d1")
    assert (v1.in_us, v1.lead_pad) == (0, 312) and (d1.in_us, d1.lead_pad) == (0, 312)
    assert "aformat=sample_fmts=fltp:channel_layouts=stereo,adelay=delays=312S:all=1,apad,atrim=end_sample=48000" in v1.pre
    assert v2.lead_pad == 0 and "adelay" not in v2.pre  # 入點在串流裡：只有最後放位置的那個 adelay
    assert v2.body().count("adelay") == 1


def test_lead_pad_when_in_point_falls_inside_pts_gap() -> None:
    """入點落在 1 s 的 pts 斷層裡（5.0～6.0 s）：atrim 之後第一個幀在 6.0 s，asetpts 會把它拉到 0 → 要補 0.5 s。"""
    src = info(gaps=[(5_000_000, 1_000_000)])
    g = build(mkseq([vclip("v1", 165, 240), vclip("v2", 240, 270)]), {("media", "m1"): src})
    assert chain_of(g, "v1").lead_pad == 24_000 and chain_of(g, "v2").lead_pad == 0


def test_disabled_and_detached_clips_are_silent_but_keep_time() -> None:
    seq = mkseq([vclip("v1", 0, 30), vclip("v2", 30, 60, enabled=False), vclip("v3", 60, 90, enabled=False), vclip("v4", 90, 120)])
    seq.video[2] = vclip("v3", 60, 90, enabled=True)
    seq.video[2].audio.enabled = False  # 原音靜音／已分離（片段本身啟用，畫面照常）
    g = build(seq)
    assert [(c.clip_id, c.label, c.delay) for c in g.chains] == [("v1", "c1", 0), ("v4", "c2", SM.samples_of_frame(90, seq.fps))]
    assert g.total_samples == SM.samples_of_frame(120, seq.fps) and len(g.inputs) == 2


def test_gap_keeps_magnetic_positions() -> None:
    seq = mkseq([vclip("v1", 0, 30), S.GapV2("g1", 15), vclip("v2", 30, 60)])
    g = build(seq)
    assert [(c.delay, c.length) for c in g.chains] == [(0, 48_000), (72_000, 48_000)]
    assert g.total_samples == 120_000 and "atrim=end_sample=120000[aout]" in g.text


def test_muted_lane_and_muted_original() -> None:
    music = lane("l1", [aclip("a1", 0, 48_000)], muted=True)
    g = build(mkseq([vclip("v1", 0, 60)], [music]))
    assert [c.clip_id for c in g.chains] == ["v1"] and any("已靜音" in n for n in g.notes)
    # A0 靜音、音軌也靜音：沒有任何會發聲的片段 → 剛好 S(T) 的靜音，仍有音軌
    seq = mkseq([vclip("v1", 0, 60)], [music], original_muted=True)
    g = build(seq)
    assert g.silent and g.inputs == [] and g.text == "anullsrc=r=48000:cl=stereo,atrim=end_sample=96000[aout]\n"
    # 軌道推桿 ≤ −90 dB 等同靜音；A0 推桿加進 V1 片段的靜態增益
    g = build(mkseq([vclip("v1", 0, 60, gain_db=-2.5)], [lane("l1", [aclip("a1", 0, 48_000)], gain_db=-96)], original_gain_db=-1))
    assert [c.clip_id for c in g.chains] == ["v1"] and "volume=volume=-3.5dB" in chain_of(g, "v1").pre


def test_mono_source_uses_explicit_pan_and_multichannel_note() -> None:
    seq = mkseq([vclip("v1", 0, 60)], [lane("l1", [aclip("mono", 0, 48_000), aclip("surround", 48_000, 48_000, source=("audio", "a-51"))])])
    g = build(seq, {("audio", "a-1"): info(channels=1, channel_layout="mono", sample_rate=44100, video_start_us=None), ("audio", "a-51"): info(channels=6, channel_layout="5.1")})
    assert "first_pts=0,pan=stereo|c0=c0|c1=c0,aformat=sample_fmts=fltp:channel_layouts=stereo," in chain_of(g, "mono").pre
    assert "pan=" not in chain_of(g, "surround").pre and "pan=" not in chain_of(g, "v1").pre
    assert any("6 聲道" in n for n in g.notes)


def test_range_trim_after_full_mix_and_limiter() -> None:
    seq = mkseq([vclip("v1", 0, 90)], limiter=True)
    g = build(seq, window=(30, 60))
    assert g.text.endswith(
        "amix=inputs=1:duration=longest:dropout_transition=0:normalize=0,apad,atrim=end_sample=144000,"
        "alimiter=limit=0.891:attack=5:release=50:level=0:latency=1,atrim=start_sample=48000:end_sample=96000,asetpts=PTS-STARTPTS[aout]\n"
    )
    assert (g.total_samples, g.sequence_samples, g.window) == (48_000, 144_000, (48_000, 96_000))
    for bad in ((60, 30), (-1, 10), (0, 91)):
        with pytest.raises(OpError):
            build(seq, window=bad)
    # 全靜音的範圍輸出：直接產生範圍長度
    assert build(mkseq([vclip("v1", 0, 90)], original_muted=True), window=(30, 60)).text == "anullsrc=r=48000:cl=stereo,atrim=end_sample=48000[aout]\n"


def test_fades_declick_curves_and_short_clips() -> None:
    seq = mkseq(
        [vclip("v1", 0, 30, fade_in=100, fade_out=144, fade_curve="equalPower"), vclip("v2", 30, 60, fade_in=4800, fade_curve="linear")],
        [lane("l1", [aclip("tiny", 0, 100, fade_curve="equalPower")])],
    )
    g = build(seq)
    v1, v2, tiny = chain_of(g, "v1"), chain_of(g, "v2"), chain_of(g, "tiny")
    assert "afade=t=in:ss=0:ns=144:curve=tri,afade=t=out:ss=47856:ns=144:curve=qsin" in v1.pre  # 100 < D → 防爆音 tri；剛好 = D 用片段曲線
    assert "afade=t=in:ss=0:ns=4800:curve=tri,afade=t=out:ss=47856:ns=144:curve=tri" in v2.pre  # linear → tri
    assert "afade=t=in:ss=0:ns=100:curve=tri,afade=t=out:ss=0:ns=100:curve=tri" in tiny.pre  # 比 D 短的片段：夾在長度內
    no_declick = mkseq([vclip("v1", 0, 30)], edge_declick_ms=0)
    assert "afade" not in build(no_declick).chains[0].pre


def test_audio_clip_timing_and_skips() -> None:
    mp3 = info(codec="mp3", sample_rate=44100, start_us=25_057, video_start_us=None)
    seq = mkseq(
        [vclip("v1", 0, 30)],
        [lane("l1", [aclip("a1", 12_000, 30_000, src_in=44_100), aclip("off", 0, 10, enabled=False), aclip("late", 48_000, 4_800)])],
    )
    g = build(seq, {("audio", "a-1"): mp3})
    a1 = chain_of(g, "a1")
    # inUs = startUs + srcIn·1e6/sr；outUs = inUs + ceil(length·1e6/48000)（§7.4 逐字的圖沒有 +1 原生樣本）
    assert (a1.in_us, a1.out_us, a1.delay, a1.length, a1.label) == (1_025_057, 1_025_057 + 625_000, 12_000, 30_000, "m1")
    assert [c.clip_id for c in g.chains] == ["v1", "a1"]  # 停用的不輸入；起點 = S(T) 的在序列之外
    assert any("late" in n and "結尾之後" in n for n in g.notes)
    # 沒有音軌的來源：略過並說明
    g = build(mkseq([vclip("v1", 0, 30, media="silent")]), {("media", "silent"): None})
    assert g.silent and any("silent" in n and "沒有音軌" in n for n in g.notes)


def test_constant_envelope_folds_into_gain_and_silence_skips_input() -> None:
    P = S.GainPointV2
    seq = mkseq(
        [vclip("v1", 0, 30, envelope=[P(0, -6), P(24_000, -6)]), vclip("v2", 30, 90, enabled=False)],
        [lane("l1", [aclip("a1", 0, 48_000, gain_db=-3, envelope=[P(0, -6)]), aclip("mute", 48_000, 48_000, envelope=[P(0, -96), P(10, -91)]), aclip("g96", 96_000, 48_000, gain_db=-96)], gain_db=-1.5)],
    )
    g = build(seq)
    assert "asetnsamples" not in chain_of(g, "v1").pre and chain_of(g, "v1").pre.endswith("volume=volume=-6dB")
    assert chain_of(g, "a1").pre.endswith("volume=volume=-10.5dB")
    assert [c.clip_id for c in g.chains] == ["v1", "a1"] and sum("視為靜音" in n for n in g.notes) == 2


@pytest.mark.parametrize(
    "points",
    [
        [(420_000, 0), (432_000, -10), (624_000, -10), (636_000, 0)],  # §7.4 的閃避
        [(0, -6)],
        [(4_800, 3), (9_600, -12)],  # 一般斜坡（兩端都不是 0）
        [(4_800, -12), (9_600, -3), (14_400, 6), (19_200, 6)],
        [(4_800, 0), (4_800, -20), (9_600, -20), (9_600, 0)],  # 階梯（閃避斜坡 0）
        [(0, 0), (240, -96), (48_000, -96), (48_240, 0)],  # muteRange（−96 dB、5 ms 斜坡）
    ],
)
def test_envelope_expression_matches_reference_curve(points: list[tuple[int, float]]) -> None:
    env_ = [S.GainPointV2(a, d) for a, d in points]
    expr = AG.envelope_expr(env_, 48_000)
    samples = sorted({0, 1, 240, 4_799, 4_800, 4_801, 7_200, 9_599, 9_600, 12_000, 19_200, 48_000, 48_120, 48_240, 60_000, 419_999, 420_000, 426_000, 432_000, 530_000, 636_000, 700_000})
    for at in samples:
        db = AG.envelope_db_at(env_, at)
        want = 0.0 if db <= S.SILENCE_DB else 10 ** (db / 20)
        got = eval_expr(expr, at / 48_000)
        assert got == pytest.approx(want, rel=1e-6, abs=2e-5), (at, db, expr)


def test_long_envelope_uses_balanced_tree_within_ffmpeg_nesting_limit() -> None:
    pts = [S.GainPointV2(4_800 * i, (-10.0 if i % 2 else 0.0)) for i in range(80)]
    expr = AG.envelope_expr(pts, 48_000)
    assert paren_depth(expr) < 20  # 線性巢狀 80 段會超過 ffmpeg 解析器約 90 層的上限
    for at in range(0, 4_800 * 81, 1_200):
        db = AG.envelope_db_at(pts, at)
        assert eval_expr(expr, at / 48_000) == pytest.approx(10 ** (db / 20), rel=1e-6, abs=1e-9)
    short = AG.envelope_expr(pts[:8], 48_000)
    assert short.startswith("if(lt(t,0),1,if(lt(t,0.1),") and paren_depth(short) > 8  # 少的時候維持 §7.4 的線性寫法


def test_stems_when_more_than_32_inputs() -> None:
    video = [vclip(f"v{i}", 3 * i, 3 * i + 3) for i in range(40)]
    music = lane("l1", [aclip("a1", 0, 96_000), aclip("a2", 96_000, 144_000)])
    seq = mkseq(video, [music])
    g = build(seq, stem_dir=r"C:\out\final.webm.part.stems")
    assert len(g.chains) == 42 and [len(s.inputs) for s in g.stems] == [32, 8, 2]
    s1, s2, s3 = g.stems
    assert s1.path == r"C:\out\final.webm.part.stems\stem-1.wav" and s1.start == 0 and s1.samples == SM.samples_of_frame(96, seq.fps)
    assert s2.start == SM.samples_of_frame(96, seq.fps) and s2.samples == SM.samples_of_frame(120, seq.fps) - s2.start
    assert s2.text.startswith("[0:a]atrim=") and "adelay=delays=0S:all=1[c33]" in s2.text  # stem 內從 0 編號、位置相對 stem 起點
    assert s2.text.endswith(f"[c33][c34][c35][c36][c37][c38][c39][c40]amix=inputs=8:duration=longest:dropout_transition=0:normalize=0,apad,atrim=end_sample={s2.samples}[aout]\n")
    assert s3.start == 0 and s3.samples == SM.total_samples(seq)  # 音樂超出序列結尾的部分不寫進 stem
    assert g.text == (
        "[1:a]adelay=delays=0S:all=1[s1];\n"
        f"[2:a]adelay=delays={s2.start}S:all=1[s2];\n"
        "[3:a]adelay=delays=0S:all=1[s3];\n"
        f"[s1][s2][s3]amix=inputs=3:duration=longest:dropout_transition=0:normalize=0,apad,atrim=end_sample={SM.total_samples(seq)}[aout]\n"
    )
    assert [i.path for i in g.inputs] == [s.path for s in g.stems] and all(i.clip_id is None for i in g.inputs)
    assert sorted(c for s in g.stems for c in (i.clip_id for i in s.inputs)) == sorted(c.clip_id for c in g.chains)
    assert any("stem" in n for n in g.notes)
    # 32 路剛好不用 stem
    assert build(mkseq(video[:32])).stems == []


def test_stems_nest_when_stem_count_exceeds_limit() -> None:
    seq = mkseq([vclip(f"v{i}", 2 * i, 2 * i + 2) for i in range(9)])
    g = build(seq, max_inputs=2, stem_dir="st")
    assert len(g.inputs) <= 2 and all(len(s.inputs) <= 2 for s in g.stems)
    produced: set[str] = set()
    for s in g.stems:  # 依序執行得起來：吃的 stem 一定在前面產生過
        assert all(i.clip_id is not None or i.path in produced for i in s.inputs)
        produced.add(s.path)
    assert all(i.path in produced for i in g.inputs)
    leaves = [i.clip_id for s in g.stems for i in s.inputs if i.clip_id is not None]
    assert sorted(leaves) == sorted(c.clip_id for c in g.chains) and len(leaves) == 9


def test_peak_estimate_sums_overlapping_chains_and_warns() -> None:
    seq = mkseq([vclip("v1", 0, 60)], [lane("l1", [aclip("a1", 0, 48_000, gain_db=-12, envelope=[S.GainPointV2(0, 0), S.GainPointV2(24_000, -20)])])])
    g = build(seq, peak_of=lambda c: -6.0)
    want = 20 * math.log10(10 ** (-6 / 20) + 10 ** (-18 / 20))
    assert g.peak_estimate_dbfs == pytest.approx(round(want, 2)) and not any("削波" in n for n in g.notes)
    hot = build(seq, peak_of=lambda c: 0.0)
    assert hot.peak_estimate_dbfs is not None and hot.peak_estimate_dbfs > AG.PEAK_WARN_DBFS and any("可能削波" in n for n in hot.notes)
    seq.limiter = True
    assert not any("削波" in n for n in build(seq, peak_of=lambda c: 0.0).notes)
    assert build(seq, peak_of=lambda c: None if c.clip_id == "a1" else -3.0).peak_estimate_dbfs is None
    assert build(seq).peak_estimate_dbfs is None  # peaks.v1.bin（M2.8）還沒有：不瞎猜


def test_mix_reasons() -> None:
    project = load_74()
    frames = {"m1": 1797}
    assert AG.mix_reasons(project.sequence, frames.get) == ["分割 / 修剪過片段", "片段增益或淡化", "加入 1 段音訊"]  # 設計 §7.6 的例子
    seq = mkseq([vclip("v1", 0, 1797, enabled=False), S.GapV2("g", 3)], original_muted=True)
    assert AG.mix_reasons(seq, frames.get) == ["1 段空白", "停用 1 個片段", "原音軌靜音或推桿"]
    assert AG.mix_reasons(mkseq([vclip("v1", 0, 10)]), {}.get) == ["媒體幀數未知（無法確認片段是整段）"]
    detached = mkseq([vclip("v1", 0, 1797)])
    detached.video[0].audio.enabled = False
    assert AG.mix_reasons(detached, frames.get) == ["原音靜音或已分離"]
    assert AG.mix_reasons(mkseq([]), frames.get) == ["序列是空的"]


def test_number_formatting() -> None:
    assert AG.fmt_seconds_us(2_025_057) == "2.025057" and AG.fmt_seconds_us(-500_000) == "-0.500000" and AG.fmt_seconds_us(0) == "0.000000"
    assert AG.fmt_ratio(420_000, 48_000) == "8.75" and AG.fmt_ratio(1, 48_000) == "0.000021" and AG.fmt_ratio(0, 48_000) == "0" and AG.fmt_ratio(-12_000, 48_000) == "-0.25"
    assert AG.fmt_number(-10.0) == "-10" and AG.fmt_number(-0.0) == "0" and AG.fmt_number(-0.1 + -0.2, 4) == "-0.3" and AG.fmt_number(1e-9) == "0"


# ---------------------------------------------------------------- encode_plan：mix 模式


SRC_WEBM = EP.SourceInfo("webm", 1280, 720, 30, 1, True, "opus", "bt709")
SRC_SILENT = EP.SourceInfo("mp4", 1280, 720, 30, 1, False, None, "bt709")
ENC = frozenset({"libvpx-vp9", "libopenh264", "prores_ks", "ffv1", "aac", "libopus", "opus", "flac"})
WHY = ["分割 / 修剪過片段", "加入 1 段音訊"]


@pytest.mark.parametrize(
    ("container", "codec", "args"),
    [("webm", "libopus", ["-c:a", "libopus", "-b:a", "160k"]), ("mp4", "aac", ["-c:a", "aac", "-b:a", "160k"]), ("mov", "aac", ["-c:a", "aac", "-b:a", "160k"]), ("mkv", "flac", ["-c:a", "flac"])],
)
def test_encode_plan_mix_codec_per_container(container: str, codec: str, args: list[str]) -> None:
    p = EP.plan(EP.EncodeSpec(container=container, gpu=False), SRC_WEBM, ENC, mix_reasons=WHY)
    assert (p.audio_mode, p.audio_codec, p.audio_args) == ("mix", codec, args)
    assert "音軌重新混音（原因：分割 / 修剪過片段、加入 1 段音訊）" in p.dropped
    assert not any("音軌重新編碼" in d for d in p.dropped)


def test_encode_plan_mix_audio_setting_interplay() -> None:
    copy_ = EP.plan(EP.EncodeSpec(container="webm", audio="copy"), SRC_WEBM, ENC, mix_reasons=WHY)
    assert copy_.audio_mode == "mix" and EP.MIX_COPY_NOTE in copy_.notes  # exportDefaults 預設 copy：視同 auto，不擲錯
    auto = EP.plan(EP.EncodeSpec(container="webm"), SRC_WEBM, ENC, mix_reasons=WHY)
    assert auto.audio_mode == "mix" and auto.notes == []
    none = EP.plan(EP.EncodeSpec(container="webm", audio="none"), SRC_WEBM, ENC, mix_reasons=WHY)
    assert (none.audio_mode, none.audio_args, none.dropped) == ("none", [], []) and EP.MIX_NONE_NOTE in none.notes
    # 目前素材沒有音軌也照樣混音（聲音可能全部來自音樂檔）
    silent = EP.plan(EP.EncodeSpec(container="mp4", gpu=False), SRC_SILENT, ENC, mix_reasons=WHY)
    assert silent.audio_mode == "mix" and "來源沒有音軌" not in silent.notes
    explicit = EP.plan(EP.EncodeSpec(container="mkv", audio="mix"), SRC_WEBM, ENC)
    assert explicit.audio_mode == "mix" and "音軌重新混音（原因：序列已修改）" in explicit.dropped
    fallback = EP.plan(EP.EncodeSpec(container="webm"), SRC_WEBM, ENC - {"libopus"}, mix_reasons=WHY)
    assert fallback.audio_codec == "opus"
    with pytest.raises(OpError) as e:
        EP.plan(EP.EncodeSpec(container="mkv"), SRC_WEBM, ENC - {"flac"}, mix_reasons=WHY)
    assert e.value.kind == "Ffmpeg"
    # mix_reasons=None 與不給參數完全相同（v1 行為；golden 由 test_media_encode_plan 把關）
    assert EP.plan(EP.EncodeSpec(container="mp4"), SRC_WEBM, ENC, mix_reasons=None) == EP.plan(EP.EncodeSpec(container="mp4"), SRC_WEBM, ENC)


# ---------------------------------------------------------------- render.plan（真的素材）


def _ffmpeg(*args: str) -> None:
    cp = subprocess.run([ff.exe("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "error", "-y", *args], capture_output=True, **ff.popen_kwargs())
    assert cp.returncode == 0, cp.stderr.decode("utf-8", "replace")[-600:]


def _decode_f32(path: Path) -> np.ndarray:
    cp = subprocess.run([ff.exe("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "error", "-i", str(path), "-map", "0:a:0", "-ac", "2", "-f", "f32le", "pipe:1"], capture_output=True, **ff.popen_kwargs())
    assert cp.returncode == 0, cp.stderr.decode("utf-8", "replace")[-600:]
    return np.frombuffer(cp.stdout, dtype="<f4").reshape(-1, 2)


@pytest.fixture(scope="module")
def graph_ffmpeg(av_media: dict[str, Path]) -> None:
    """實跑濾鏡圖要 FFmpeg 7+ 的 `-/filter_complex <檔案>`（內建的 n8.1.2 有）；Ubuntu apt 的 6.1 沒有 → 這幾個實跑測試 skip，
    純函式與 render.plan 測試照跑。M2.7 的執行端要替舊版準備 `-filter_complex_script` 退路。"""
    gf = av_media["dir"] / "probe.audio.txt"
    gf.write_text("anullsrc=r=48000:cl=stereo,atrim=end_sample=480[aout]\n", encoding="utf-8")
    cp = subprocess.run(
        [ff.exe("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "error", "-/filter_complex", str(gf), "-map", "[aout]", "-f", "null", "-"],
        capture_output=True, **ff.popen_kwargs(),
    )
    if cp.returncode != 0:
        pytest.skip(f"這份 ffmpeg 不支援 -/filter_complex（需要 FFmpeg 7+）：{cp.stderr.decode('utf-8', 'replace')[-200:]}")


def run_graph(g: AG.AudioGraph, out: Path) -> np.ndarray:
    """依 M2.7 的執行方式跑音訊圖（不含 rawvideo）：stem 依序各跑一趟，最後一張圖輸出 WAV。first_input 必須是 0。"""
    assert g.first_input == 0
    for s in g.stems:
        Path(s.path).parent.mkdir(parents=True, exist_ok=True)
        gf = Path(s.path + ".txt")
        gf.write_text(s.text, encoding="utf-8")
        _ffmpeg("-copyts", *[x for i in s.inputs for x in ("-i", i.path)], "-/filter_complex", str(gf), "-map", "[aout]", "-c:a", "pcm_f32le", "-f", "wav", s.path)
    gf = out.with_suffix(".audio.txt")
    gf.write_text(g.text, encoding="utf-8")
    ins = [x for i in g.inputs for x in ("-i", i.path)]
    _ffmpeg("-copyts", *ins, "-/filter_complex", str(gf), "-map", "[aout]", "-c:a", "pcm_f32le", "-f", "wav", str(out))
    return _decode_f32(out)


@pytest.fixture(scope="module")
def av_media(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")
    d = tmp_path_factory.mktemp("audio graph 素材")  # 路徑含空格與中文
    video, music = d / "片段 av.mkv", d / "配樂 mono.wav"
    _ffmpeg("-f", "lavfi", "-i", "testsrc=size=64x48:rate=30:d=2", "-f", "lavfi", "-i", "sine=f=1000:r=48000:d=2", "-ac", "2", "-c:v", "ffv1", "-c:a", "pcm_s16le", "-shortest", str(video))
    _ffmpeg("-f", "lavfi", "-i", "sine=f=440:r=44100:d=3", "-ac", "1", "-c:a", "pcm_s16le", str(music))
    return {"dir": d, "video": video, "music": music}


def _project(av: dict[str, Path], seq: S.SequenceV2 | None, *, with_audio_info: bool = False) -> S.ProjectFile:
    p = S.ProjectFile(profile="cards")
    m = S.MediaV1("m1", str(av["video"]), av["video"].name, "", None, S.ProxyMetaV1(S.Rational(30, 1), 60, 64, 48))
    if with_audio_info:
        m.audio = info(codec="pcm_s16le", n_samples=96_000)
    p.media.append(m)
    p.active_media_id = "m1"
    if seq is not None:
        p.sequence = seq
        p.audio_media.append(S.AudioMediaV2("a-1", str(av["music"]), av["music"].name, "", None, "music"))
    return p


def _seq_two_clips_music(**kw: Any) -> S.SequenceV2:
    return S.SequenceV2(
        "seq-1", "t", S.Rational(30, 1), 64, 48,
        video=[vclip("c1", 6, 30), vclip("c2", 36, 54, gain_db=-3, fade_out=4_800, fade_curve="equalPower")],
        audio_lanes=[lane("lane-1", [aclip("a1", 4_800, 48_000, src_in=4_410, gain_db=-12, envelope=[S.GainPointV2(0, 0), S.GainPointV2(24_000, -10)])])],
        **kw,
    )


def _plan(av: dict[str, Path], project: S.ProjectFile, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **kw: Any) -> tuple[Path, RD.RenderPlan]:
    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    ppath = tmp_path / "proj.aivc.json"
    S.save(project, ppath)
    mctx = R.open_media_context(ppath, None, SC.RecordingCtx())
    return ppath, RD.build_plan(mctx, SC.RecordingCtx(), out=str(tmp_path / "out.mkv"), codec="ffv1", gpu=False, **kw)


def test_render_plan_v1_project_has_no_sequence_keys(av_media: dict[str, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _, plan = _plan(av_media, _project(av_media, None), tmp_path, monkeypatch)
    d = plan.to_json()
    assert plan.sequence is None and "sequence" not in d and "audio" not in d  # I4：v1 計畫逐鍵不變
    assert d["encode"]["audio_mode"] == "copy" and d["frames"]["total"] == 60


def test_render_plan_untouched_sequence_keeps_copy_path(av_media: dict[str, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    seq = S.SequenceV2("seq-1", "t", S.Rational(30, 1), 64, 48, video=[vclip("clip-1", 0, 60)])
    _, plan = _plan(av_media, _project(av_media, seq), tmp_path, monkeypatch)
    d = plan.to_json()
    assert plan.sequence is not None and not plan.sequence.needs_render
    assert d["sequence"]["untouched"] is True and d["sequence"]["duration"] == "00:00:02:00"
    assert d["encode"]["audio_mode"] == "copy" and d["audio"]["mode"] == "copy" and d["audio"]["graph"] is None and d["audio"]["reasons"] == []


def test_render_plan_sequence_and_audio_blocks(av_media: dict[str, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ppath, plan = _plan(av_media, _project(av_media, _seq_two_clips_music()), tmp_path, monkeypatch)
    d = plan.to_json()
    assert d["sequence"] == {
        "id": "seq-1", "frames": 42, "duration": "00:00:01:12", "fps": {"num": 30, "den": 1},
        "clips": 2, "gaps": 0, "disabled": 0, "audioClips": 1, "untouched": False, "range": None, "trim": False,
    }
    a = d["audio"]
    assert (a["mode"], a["codec"], a["inputs"], a["samples"]) == ("mix", "flac", 3, SM.samples_of_frame(42, S.Rational(30, 1)))
    assert a["reasons"] == ["分割 / 修剪過片段", "片段增益或淡化", "加入 1 段音訊"]
    assert any(x.startswith("音軌重新混音（原因：") for x in d["encode"]["dropped"])
    # 專案檔沒有 audio 資訊 → 引擎自己跑 audio_info（並寫 audio.v1.json 快取）；單聲道配樂明寫 pan
    assert [c["path"] for c in a["chains"]] == [str(av_media["video"])] * 2 + [str(av_media["music"])]
    assert "pan=stereo|c0=c0|c1=c0" in a["graph"] and a["graph"].startswith("[1:a]atrim=start=0.200000:end=1.000000,")
    assert AI.audio_info_path(C.for_file(av_media["music"])).is_file()
    # M2.7 起需要序列渲染的計畫，v1 欄位改報序列的幀數（素材是 60 幀、序列 42 幀）
    assert a["peakEstimateDbfs"] is None and a["stems"] == [] and d["frames"]["total"] == 42
    human = RD._plan_human(plan)
    assert "序列        seq-1  42 幀（00:00:01:12）" in human and "音訊混音    3 路 → 67200 樣本  flac" in human
    # M2.7：依序列輸出（完整驗收在 test_render_sequence.py）
    res = RD.run_render(R.open_media_context(ppath, None, SC.RecordingCtx()), plan, SC.RecordingCtx())
    assert res["frames"] == 42 and res["audio"]["samples"] == 67_200 and (tmp_path / "out.mkv").is_file()


def _write_peaks(path: Path, peak: int, n: int, *, magic: bytes = b"AIVP") -> None:
    """照 Rust peaks.rs 的版面寫一份 peaks.v1.bin（每個桶 min = −peak、max = peak）。"""
    import struct

    cache_dir = C.for_file(path).dir
    cache_dir.mkdir(parents=True, exist_ok=True)
    body = bytes((-peak) & 0xFF for _ in range(n)) + bytes([peak] * n) + bytes(2 * n)
    (cache_dir / RD.PEAKS_FILE).write_bytes(struct.pack("<4sIIIIQq", magic, 1, 200, 48_000, n, n * 240, 0) + body)


def test_render_plan_peak_estimate_from_peaks_cache(av_media: dict[str, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """來源都有 peaks.v1.bin → 估計峰值 = 同時響的各路（來源峰值 × 靜態增益 × 自動化最大值）振幅相加；有一個沒有 → 未知。"""
    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    _, plan = _plan(av_media, _project(av_media, _seq_two_clips_music()), tmp_path, monkeypatch)
    assert plan.to_json()["audio"]["peakEstimateDbfs"] is None  # 還沒有波形快取
    _write_peaks(av_media["video"], 64, 400)
    _write_peaks(av_media["music"], 127, 600)
    _, plan = _plan(av_media, _project(av_media, _seq_two_clips_music()), tmp_path, monkeypatch)
    a = plan.to_json()["audio"]
    # c1（0 dB）與 a1（−12 dB，自動化最大 0 dB）同時響最大聲：64/127 + 10^(−12/20)
    assert a["peakEstimateDbfs"] == pytest.approx(round(20 * math.log10(64 / 127 + 10 ** (-12 / 20)), 2))
    assert not any("削波" in n for n in a["notes"])
    hot = _seq_two_clips_music()
    hot.audio_lanes[0].clips[0].gain_db = 0
    _, plan = _plan(av_media, _project(av_media, hot), tmp_path, monkeypatch)
    a = plan.to_json()["audio"]
    assert a["peakEstimateDbfs"] > -1 and any("可能削波" in n for n in a["notes"])
    # 格式對不上（magic 錯、被截斷）→ 當作未知，不讓計畫失敗
    _write_peaks(av_media["music"], 127, 600, magic=b"AIPK")
    _, plan = _plan(av_media, _project(av_media, _seq_two_clips_music()), tmp_path, monkeypatch)
    assert plan.to_json()["audio"]["peakEstimateDbfs"] is None
    bad = tmp_path / "short.bin"
    bad.write_bytes(b"AIVP\x01")
    assert RD.read_peaks_abs(bad) is None and RD.read_peaks_abs(tmp_path / "missing.bin") is None


def test_read_peaks_abs_matches_shared_aivp_golden(tmp_path: Path) -> None:
    """Rust peaks.rs 打包、TS src/audio/peaks.ts 解析的是同一份 `fixtures/peaks/aivp-v1.golden.json`；引擎這邊也讀它。
    為什麼要第三份：peaks.v1.bin 是 Rust 寫、Python 讀（估計峰值），上面的 _write_peaks 是照「我以為的版面」自己寫的，
    版面若在 Rust 那邊改了（例如欄位順序、min/max 對調），兩邊各自的測試都綠、估計卻會默默讀歪。"""
    golden = json.loads((REPO / "fixtures" / "peaks" / "aivp-v1.golden.json").read_text(encoding="utf-8"))
    path = tmp_path / "golden.peaks.v1.bin"
    path.write_bytes(bytes.fromhex(golden["hex"]))
    got = RD.read_peaks_abs(path)
    exp = golden["expect"]
    assert got is not None and got.tolist() == [max(abs(a), abs(b)) for a, b in zip(exp["mins"], exp["maxs"])]
    # 截掉最後一個位元組（長度與 n_buckets 對不上）→ 未知，不讓計畫失敗
    path.write_bytes(bytes.fromhex(golden["hex"])[:-1])
    assert RD.read_peaks_abs(path) is None


def test_render_plan_source_flag_and_cli(av_media: dict[str, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    from aivc.cli import main

    ppath, plan = _plan(av_media, _project(av_media, _seq_two_clips_music()), tmp_path, monkeypatch, sequence="ignore")
    assert plan.sequence is None and "sequence" not in plan.to_json() and plan.encode.audio_mode == "copy"
    code = main(["--json", "render-plan", str(ppath), "-o", str(tmp_path / "x.mkv"), "--codec", "ffv1", "--no-gpu"])
    res = json.loads(capsys.readouterr().out.strip().splitlines()[-1])["result"]
    assert code == 0 and res["audio"]["mode"] == "mix" and res["sequence"]["clips"] == 2
    code = main(["--json", "render-plan", str(ppath), "-o", str(tmp_path / "x.mkv"), "--codec", "ffv1", "--no-gpu", "--source"])
    res = json.loads(capsys.readouterr().out.strip().splitlines()[-1])["result"]
    assert code == 0 and "sequence" not in res and res["encode"]["audio_mode"] == "copy"
    # M2.7：render 依序列輸出（42 幀）；加 --source 則是整段素材（60 幀）
    code = main(["--json", "render", str(ppath), "-o", str(tmp_path / "y.mkv"), "--codec", "ffv1", "--no-gpu"])
    res = json.loads(capsys.readouterr().out.strip().splitlines()[-1])["result"]
    assert code == 0 and res["frames"] == 42 and res["audio"]["mode"] == "mix" and (tmp_path / "y.mkv").is_file()
    code = main(["--json", "render", str(ppath), "-o", str(tmp_path / "z.mkv"), "--codec", "ffv1", "--no-gpu", "--source"])
    res = json.loads(capsys.readouterr().out.strip().splitlines()[-1])["result"]
    assert code == 0 and res["frames"] == 60 and res["audio"]["mode"] == "copy"


def test_render_plan_sequence_range_uses_sequence_frames(av_media: dict[str, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """序列比素材長（同一段用三次、T = 90 > N = 60）：--range 以序列幀計，不會被素材幀數擋下。"""
    seq = S.SequenceV2("seq-1", "t", S.Rational(30, 1), 64, 48, video=[vclip("c1", 0, 30), vclip("c2", 0, 30), vclip("c3", 0, 30)])
    _, plan = _plan(av_media, _project(av_media, seq, with_audio_info=True), tmp_path, monkeypatch, range_spec="65:80", trim=True)
    d = plan.to_json()
    assert d["sequence"]["range"] == [65, 80] and d["sequence"]["trim"] is True
    assert d["audio"]["samples"] == 15 * 1600 and "atrim=start_sample=104000:end_sample=128000,asetpts=PTS-STARTPTS[aout]" in d["audio"]["graph"]


def test_render_plan_rejects_unrenderable_sequences(av_media: dict[str, Path], tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # proxy fps 與序列不符（sanitize 保留並警告；輸出時擋下並教使用者怎麼修，§3.5）
    seq = S.SequenceV2("seq-1", "t", S.Rational(25, 1), 64, 48, video=[vclip("c1", 0, 10), vclip("c2", 20, 30)])
    with pytest.raises(OpError) as e:
        _plan(av_media, _project(av_media, seq), tmp_path, monkeypatch)
    assert e.value.kind == "Invalid" and "重建 proxy" in e.value.hint
    # 片段離線（srcOut 超過 proxy 幀數）
    seq = S.SequenceV2("seq-1", "t", S.Rational(30, 1), 64, 48, video=[vclip("c1", 0, 10), vclip("c2", 50, 70)])
    with pytest.raises(OpError) as e:
        _plan(av_media, _project(av_media, seq), tmp_path, monkeypatch)
    assert "離線" in str(e.value)
    # 序列裡沒有任何來源有音軌 → 不輸出音軌（不能去 copy 目前素材的聲音）
    project = _project(av_media, S.SequenceV2("seq-1", "t", S.Rational(30, 1), 64, 48, video=[vclip("c1", 0, 10), vclip("c2", 20, 30)]))
    project.media[0].audio = None
    monkeypatch.setattr(RD, "_audio_resolvers", lambda *a, **k: ((lambda kind, ref: None), (lambda kind, ref: "x")))
    _, plan = _plan(av_media, project, tmp_path, monkeypatch)
    assert plan.encode.audio_mode == "none" and "序列裡沒有任何音訊來源：不輸出音軌" in plan.encode.notes


# ---------------------------------------------------------------- 實跑 ffmpeg


def test_graph_runs_with_exact_sample_count_and_stems_match(av_media: dict[str, Path], graph_ffmpeg: None, tmp_path: Path) -> None:
    """同一個序列：一段式與 stem 兩段式（每張圖最多 2 路、疊兩層）輸出逐樣本相同，而且剛好 S(T) 或範圍長度。"""
    video, music = str(av_media["video"]), str(av_media["music"])
    src_video = info(codec="pcm_s16le", n_samples=96_000)
    src_music = info(codec="pcm_s16le", sample_rate=44_100, channels=1, channel_layout="mono", video_start_us=None, n_samples=132_300)
    P = S.GainPointV2
    seq = mkseq(
        [vclip("c1", 3, 12), S.GapV2("g", 4), vclip("c2", 30, 39, fade_in=2_400), vclip("c3", 12, 21, gain_db=-6), vclip("c4", 45, 57, envelope=[P(0, 0), P(4_800, -20), P(9_600, 0)])],
        [lane("l1", [aclip("a1", 0, 30_000, src_in=-4_410, gain_db=-6), aclip("a2", 40_000, 20_000, fade_in=9_600, fade_curve="equalPower", envelope=[P(0, -3), P(10_000, 3)])])],
        limiter=True,
    )
    infos = {("media", "m1"): src_video, ("audio", "a-1"): src_music}
    paths = {("media", "m1"): video, ("audio", "a-1"): music}
    kw = dict(info_of=lambda k, i: infos[(k, i)], path_of=lambda k, i: paths[(k, i)], first_input=0)
    single = AG.build(seq, None, **kw)
    assert single.stems == [] and len(single.chains) == 6
    one = run_graph(single, tmp_path / "single.wav")
    assert one.shape == (SM.total_samples(seq), 2)
    staged = AG.build(seq, None, max_inputs=2, stem_dir=str(tmp_path / "stems 目錄"), **kw)
    assert len(staged.stems) > 3 and len(staged.inputs) <= 2
    two = run_graph(staged, tmp_path / "staged.wav")
    assert two.shape == one.shape and float(np.max(np.abs(two - one))) < 1e-5
    # 範圍輸出：限幅器之後才裁，長度剛好
    ranged = AG.build(seq, None, window=(5, 30), **kw)
    part = run_graph(ranged, tmp_path / "ranged.wav")
    assert part.shape == (ranged.total_samples, 2) == (SM.samples_of_frame(30, seq.fps) - SM.samples_of_frame(5, seq.fps), 2)


def test_lead_pad_is_real_silence_then_signal(av_media: dict[str, Path], graph_ffmpeg: None, tmp_path: Path) -> None:
    """音訊片段 srcIn = −0.25 s：前 12 000 個樣本要是靜音（不是把聲音往前拉），之後才有 440 Hz。"""
    src_music = info(codec="pcm_s16le", sample_rate=44_100, channels=1, channel_layout="mono", video_start_us=None, n_samples=132_300)
    seq = mkseq([vclip("c1", 0, 30)], [lane("l1", [aclip("a1", 4_800, 36_000, src_in=-11_025)])], original_muted=True, edge_declick_ms=0)
    g = AG.build(seq, None, info_of=lambda k, i: src_music, path_of=lambda k, i: str(av_media["music"]), first_input=0)
    assert chain_of(g, "a1").lead_pad == 12_000
    out = run_graph(g, tmp_path / "lead.wav")
    assert out.shape == (48_000, 2)
    assert float(np.max(np.abs(out[:4_800 + 12_000]))) == 0.0
    assert float(np.max(np.abs(out[4_800 + 12_000 + 48 : 4_800 + 12_000 + 2_000]))) > 0.05  # lavfi sine 振幅 1/8
    assert float(np.max(np.abs(out[4_800 + 36_000 :]))) == 0.0


def test_envelope_expression_runs_in_ffmpeg(av_media: dict[str, Path], graph_ffmpeg: None, tmp_path: Path) -> None:
    """運算式在真的 volume 濾鏡裡求值：80 點平衡樹解析得了，而且 5 ms frame 的增益等於參考曲線。"""
    pts = [S.GainPointV2(2_400 * i, (-12.0 if i % 2 else 0.0)) for i in range(80)]
    expr = AG.envelope_expr(pts, 48_000)
    gf = tmp_path / "env.txt"
    gf.write_text(f"aevalsrc=0.5|0.5:s=48000:d=4,asetnsamples=n=240:p=0,volume=eval=frame:volume='{expr}'[aout]\n", encoding="utf-8")
    out_wav = tmp_path / "env.wav"
    _ffmpeg("-/filter_complex", str(gf), "-map", "[aout]", "-c:a", "pcm_f32le", "-f", "wav", str(out_wav))
    got = _decode_f32(out_wav)[:, 0]
    for frame in range(0, len(got) // 240):
        at = frame * 240
        want = 0.5 * 10 ** (AG.envelope_db_at(pts, at) / 20)
        assert got[at] == pytest.approx(want, rel=1e-5, abs=1e-6), at
