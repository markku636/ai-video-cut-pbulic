"""aivc.sequence.model：序列對應表 × 共用 golden `fixtures/sequence/map-cases.json`（設計 §3.3、§13 M2.2）。

TS `src/sequence/map.ts` 讀同一份期望值；任何一邊改公式，另一邊的測試就會紅（做法同指紋測試向量）。
除了比 golden，還用 Fraction 暴力算一次，確認 fixture 本身沒寫錯（fixture 錯了兩邊會一起「通過」）。
"""
from __future__ import annotations

import json
import math
from fractions import Fraction
from pathlib import Path
from typing import Any

import pytest

from aivc.project import schema as S
from aivc.sequence import model as M

REPO = Path(__file__).resolve().parents[2]
CASES_PATH = REPO / "fixtures" / "sequence" / "map-cases.json"
DOC: dict[str, Any] = json.loads(CASES_PATH.read_text(encoding="utf-8"))
CASES: list[dict[str, Any]] = DOC["cases"]


def _refs(seq_json: dict[str, Any]) -> tuple[set[str], set[str]]:
    media = {it["mediaId"] for it in seq_json.get("video", []) if it.get("kind") == "clip"}
    audio: set[str] = set()
    for lane in seq_json.get("audioLanes", []):
        for c in lane.get("clips", []):
            src = c.get("source") or {}
            (media if src.get("type") == "media" else audio).add(src.get("mediaId") or src.get("audioId"))
    return media, audio


def load_seq(seq_json: dict[str, Any], frames: dict[str, int] | None = None) -> S.SequenceV2:
    """fixture 的序列 → SequenceV2。引用到的媒體都補一筆（沒給幀數就是 proxy 未知），sanitize 不能丟掉任何東西。"""
    frames = frames or {}
    media_ids, audio_ids = _refs(seq_json)
    fps = S.Rational(seq_json["fps"]["num"], seq_json["fps"]["den"])
    media = {
        mid: S.MediaV1(mid, f"{mid}.webm", proxy=S.ProxyMetaV1(fps, frames[mid], seq_json["width"], seq_json["height"]) if mid in frames else None)
        for mid in media_ids
    }
    audio_media = {aid: S.AudioMediaV2(aid, f"{aid}.mp3") for aid in audio_ids}
    warnings: list[str] = []
    seq = S.SequenceV2.from_json(seq_json, warnings.append, media, audio_media)
    assert seq is not None
    assert warnings == [], warnings  # fixture 本身必須是 sanitize 乾淨的
    assert seq.to_json() == seq_json  # 讀寫往返（值相等）
    return seq


def raw_seq(seq_json: dict[str, Any]) -> S.SequenceV2:
    """不經 sanitize 直接照搬成 dataclass：isUntouched 的 golden 是「純函式對結構」的期望值（TS 端直接吃物件）。

    為什麼不用 from_json：clip-detached 這個 case 的 detachedTo 指向不存在的音訊片段，sanitize 會把它清掉並恢復原音，
    結構就變了；要單獨驗「有 detachedTo 就不是 untouched」這一條，只能繞過 sanitize。
    """

    def gain(obj: S.ClipGainV2, d: dict[str, Any]) -> None:
        obj.gain_db, obj.fade_in, obj.fade_out, obj.fade_curve = d["gainDb"], d["fadeIn"], d["fadeOut"], d["fadeCurve"]
        obj.envelope = [S.GainPointV2(p["at"], p["db"]) for p in d["envelope"]]

    video: list[S.VideoClipV2 | S.GapV2] = []
    for it in seq_json["video"]:
        if it["kind"] == "gap":
            video.append(S.GapV2(it["id"], it["length"]))
            continue
        a = S.ClipAudioV2(enabled=it["audio"]["enabled"], detached_to=it["audio"].get("detachedTo"))
        gain(a, it["audio"])
        video.append(S.VideoClipV2(it["id"], it["mediaId"], it["srcIn"], it["srcOut"], it["enabled"], a))
    lanes = []
    for ln in seq_json["audioLanes"]:
        clips = []
        for c in ln["clips"]:
            src = c["source"]
            ac = S.AudioClipV2(id=c["id"], source=S.AudioSourceRefV2(src["type"], src.get("mediaId") or src.get("audioId")), start=c["start"], length=c["length"], src_in=c["srcIn"], enabled=c["enabled"])
            gain(ac, c)
            clips.append(ac)
        lanes.append(S.AudioLaneV2(ln["id"], ln["name"], ln["role"], ln["muted"], ln["locked"], ln["syncLock"], ln["gainDb"], clips))
    return S.SequenceV2(
        seq_json["id"], seq_json["name"], S.Rational(seq_json["fps"]["num"], seq_json["fps"]["den"]), seq_json["width"], seq_json["height"],
        video=video, original_muted=seq_json["original"]["muted"], original_gain_db=seq_json["original"]["gainDb"], audio_lanes=lanes,
        edge_declick_ms=seq_json["audio"]["edgeDeclickMs"], limiter=seq_json["audio"]["limiter"],
    )


# ---------------------------------------------------------------- 暴力參考實作（Fraction，與 model 的整數算法獨立）


def ref_samples(t: int, num: int, den: int) -> int:
    return math.floor(Fraction(t * 48000 * den, num))


def ref_round(x: Fraction) -> int:
    return math.floor(x + Fraction(1, 2))


def test_fixture_is_the_documented_shape() -> None:
    assert DOC["version"] == 1
    assert {"samplesOfFrame", "placed", "frames", "videoAbsUs", "audioAbsUs", "roundHalfUp", "isUntouched"} <= set(DOC["conventions"])
    names = [c["name"] for c in CASES]
    assert len(names) == len(set(names)) >= 6
    fpss = {(c["sequence"]["fps"]["num"], c["sequence"]["fps"]["den"]) for c in CASES}
    # 設計 §3.3 指定要涵蓋的 fps
    assert {(30, 1), (30000, 1001), (24000, 1001), (25, 1)} <= fpss


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_map_cases(case: dict[str, Any]) -> None:
    seq = load_seq(case["sequence"])
    exp = case["expect"]
    num, den = seq.fps.num, seq.fps.den

    placed = M.place_video(seq)
    assert M.duration_frames(seq) == exp["durationFrames"]
    assert M.total_samples(seq) == exp["totalSamples"]
    assert [{"id": p.item.id, "kind": p.item.kind, "t0": p.t0, "t1": p.t1, "s0": p.s0, "s1": p.s1} for p in placed] == exp["placed"]

    # 29.97 鋪滿性質：Σ片段樣本長 = S(T)，相鄰片段首尾相接（沒有縫、沒有重疊）
    assert sum(p.samples for p in placed) == exp["totalSamples"] == ref_samples(exp["durationFrames"], num, den)
    for a, b in zip(placed, placed[1:]):
        assert a.t1 == b.t0 and a.s1 == b.s0

    starts = [p.t0 for p in placed]
    for fr in exp["frames"]:
        t = fr["t"]
        item, item_k = M.item_at(seq, t)
        assert (item.id if item else None, item_k) == (fr["itemId"], fr["itemK"]), t
        clip, k = M.map_frame(seq, t)
        assert (clip.id if clip else None, k) == (fr["clipId"], fr["k"]), t
        assert M.map_frame_placed(placed, t, starts) == (clip, k)

    for t, s in exp["samplesOfFrame"]:
        assert M.samples_of_frame(t, seq.fps) == s == ref_samples(t, num, den), t


def test_map_frame_exhaustive_against_bruteforce() -> None:
    """每個 case 的每一幀都和「逐項展開」的暴力對應相同（golden 只列了抽樣的 t）。"""
    for case in CASES:
        seq = load_seq(case["sequence"])
        flat: list[tuple[str | None, int | None]] = []
        for it in seq.video:
            if isinstance(it, S.VideoClipV2):
                flat += [(it.id, k) if it.enabled else (None, None) for k in range(it.src_in, it.src_out)]
            else:
                flat += [(None, None)] * it.length
        placed = M.place_video(seq)
        starts = [p.t0 for p in placed]
        for t in range(-2, len(flat) + 2):
            want = flat[t] if 0 <= t < len(flat) else (None, None)
            clip, k = M.map_frame_placed(placed, t, starts)
            assert (clip.id if clip else None, k) == want, (case["name"], t)


def test_abs_us_cases() -> None:
    for c in DOC["absUs"]["video"]:
        fps = S.Rational(c["fps"]["num"], c["fps"]["den"])
        assert M.video_abs_us(c["k"], fps, c["videoStartUs"]) == c["us"], c
        assert c["us"] == c["videoStartUs"] + ref_round(Fraction(c["k"] * 1_000_000 * fps.den, fps.num))
    for c in DOC["absUs"]["audio"]:
        assert M.audio_abs_us(c["srcIn"], c["startUs"], c["sampleRate"]) == c["us"], c
        assert c["us"] == c["startUs"] + ref_round(Fraction(c["srcIn"] * 1_000_000, c["sampleRate"]))


def test_round_half_up_matches_js_math_round() -> None:
    # JS：Math.round(62.5)=63、Math.round(-62.5)=-62、Math.round(-0.4)=-0、Math.round(2.5)=3
    assert [M.round_half_up(n, d) for n, d in [(125, 2), (-125, 2), (-2, 5), (5, 2), (7, 3), (-7, 3), (125, -2)]] == [63, -62, 0, 3, 2, -2, -62]
    assert round(62.5) == 62  # Python 內建是銀行家捨入：這就是 model 不用 round() 的原因


@pytest.mark.parametrize("case", DOC["untouched"]["cases"], ids=[c["name"] for c in DOC["untouched"]["cases"]])
def test_untouched_cases(case: dict[str, Any]) -> None:
    frames = {mid: m["frames"] for mid, m in DOC["untouched"]["media"].items()}
    seq = None if case["sequence"] is None else raw_seq(case["sequence"])
    assert seq is None or seq.to_json() == case["sequence"]  # 照搬沒有漏欄位
    assert M.is_untouched_with(seq, frames.get) is case["expect"]
    # 專案版（查 media[].proxy.frames）結果相同
    p = S.ProjectFile(media=[S.MediaV1(mid, f"{mid}.webm", proxy=S.ProxyMetaV1(S.Rational(30, 1), n, 1280, 720)) for mid, n in frames.items()])
    assert M.is_untouched(seq, p) is case["expect"]


def test_empty_and_long_sequences_stay_integer() -> None:
    """1 小時 29.97 片段：樣本數精確（浮點算 108 000 000 幀會差好幾個樣本）。"""
    seq = S.SequenceV2("s", "s", S.Rational(30000, 1001), 1920, 1080, video=[S.VideoClipV2("c", "m", 0, 107_892)])
    assert M.total_samples(seq) == ref_samples(107_892, 30000, 1001) == 172_799_827
    assert M.describe(seq) == {"id": "s", "frames": 107_892, "clips": 1, "gaps": 0, "disabled": 0, "audioClips": 0}
    empty = S.SequenceV2("s", "s", S.Rational(30, 1), 1, 1)
    assert M.place_video(empty) == [] and M.total_samples(empty) == 0 and M.map_frame(empty, 0) == (None, None)
