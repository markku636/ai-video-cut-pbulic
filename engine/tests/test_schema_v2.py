"""project/schema.py 的 schema v2（設計 §3.3、§3.5、§4；§13 M2.2）：

- v1／v2 讀寫往返、`extra` 在每一層都保留；
- 最低版本寫檔（§4.3）：沒用到 v2 功能就寫 1 並省略兩個鍵，引擎自己建的專案也一樣；
- `schemaVersion 3` 拒絕；
- sanitize 規則表（§3.5）逐條：丟掉並回報，不擲錯。
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from aivc.ops import OpError
from aivc.project import schema as S
from aivc.sequence import model as SM

ENGINE_FIX = Path(__file__).parent / "fixtures" / "project" / "v1"
REPO = Path(__file__).resolve().parents[2]
SHARED_V2 = REPO / "fixtures" / "project" / "v2" / "two-clips-music.aivc.json"

DEFAULT_AUDIO = {"enabled": True, "gainDb": 0, "fadeIn": 0, "fadeOut": 0, "fadeCurve": "linear", "envelope": []}


def _audio_info(**over: Any) -> dict[str, Any]:
    d = {"codec": "opus", "sampleRate": 48000, "channels": 2, "channelLayout": "stereo", "startUs": 0, "videoStartUs": 0, "nSamples": 2_875_200, "gaps": []}
    d.update(over)
    return d


def v2_doc() -> dict[str, Any]:
    """設計 §7.4 的範例專案（兩個片段＋一段音樂），每一層都塞一個未知鍵驗 extra。"""
    return {
        "schemaVersion": 2,
        "app": "ai-video-cut",
        "createdAt": "2026-09-17T00:00:00.000Z",
        "updatedAt": "2026-09-17T00:00:00.000Z",
        "media": [
            {
                "id": "m1", "path": "D:\\s\\sample_clip1.webm", "name": "sample_clip1.webm", "fingerprint": "ab" * 32,
                "probe": {"video": {"width": 1280, "height": 720}},
                "proxy": {"fps": {"num": 30, "den": 1}, "frames": 1797, "width": 1280, "height": 720, "scale": 1, "version": 1},
                # gaps 的每一項是衍生快取（可重生）：只收 atUs／durUs，不保留項目內的未知鍵
                "audio": _audio_info(futureAudioKey=1, gaps=[{"atUs": 1_000_000, "durUs": 1_200_000}]),
                "mediaFuture": True,
            }
        ],
        "activeMediaId": "m1",
        "profile": "cards",
        "shots": {},
        "tracks": {},
        "cardSlots": {},
        "deck": {"styleId": "demo-deck", "source": "builtin"},
        "insertDefaults": S.InsertV1.defaults().to_json(),
        "exportDefaults": {"codec": "auto", "quality": None, "audio": "copy", "trackData": {"format": "nuke", "flavour": "cornerpin", "baked": True, "frameOffset": 1}},
        "sequence": {
            "id": "seq-1", "name": "sample_clip1", "fps": {"num": 30, "den": 1}, "width": 1280, "height": 720, "sampleRate": 48000,
            "video": [
                {"kind": "clip", "id": "c1", "mediaId": "m1", "srcIn": 60, "srcOut": 360, "enabled": True, "audio": dict(DEFAULT_AUDIO, clipAudioFuture=[1]), "label": "開場", "clipFuture": 2},
                {"kind": "gap", "id": "g1", "length": 15, "gapFuture": "y"},
                {"kind": "clip", "id": "c2", "mediaId": "m1", "srcIn": 930, "srcOut": 1380, "enabled": True,
                 "audio": {"enabled": True, "gainDb": -3, "fadeIn": 0, "fadeOut": 48000, "fadeCurve": "equalPower", "envelope": []}},
            ],
            "original": {"muted": False, "gainDb": 0, "originalFuture": 1},
            "audioLanes": [
                {
                    "id": "lane-1", "name": "A1 音樂", "role": "music", "muted": False, "locked": False, "syncLock": False, "gainDb": 0, "laneFuture": {"z": 1},
                    "clips": [
                        {"id": "a1", "source": {"type": "audio", "audioId": "a-5f00000000000000", "srcFuture": 1}, "start": 48000, "length": 960000, "srcIn": 88200,
                         "enabled": True, "gainDb": -12, "fadeIn": 96000, "fadeOut": 144000, "fadeCurve": "equalPower",
                         "envelope": [{"at": 420000, "db": 0}, {"at": 432000, "db": -10}, {"at": 624000, "db": -10}, {"at": 636000, "db": 0}], "clipFuture": "k"}
                    ],
                },
                {
                    "id": "lane-2", "name": "A2 原音（分離）", "role": "other", "muted": False, "locked": False, "syncLock": True, "gainDb": -1.5,
                    "clips": [],
                },
            ],
            "audio": {"edgeDeclickMs": 3, "limiter": False, "audioFuture": 9},
            "seqFuture": "keep",
        },
        "audioMedia": [
            {"id": "a-5f00000000000000", "path": "D:\\music\\bgm.mp3", "name": "bgm.mp3", "fingerprint": "5f" * 32, "probe": None, "role": "music",
             "audio": _audio_info(codec="mp3", sampleRate=44100, startUs=25057, videoStartUs=None, nSamples=1_323_000), "amFuture": 3}
        ],
        "projectFuture": {"keep": True},
    }


def load(doc: dict[str, Any]) -> tuple[S.ProjectFile, list[str]]:
    r = S.loads(json.dumps(doc, ensure_ascii=False))
    return r.project, r.warnings


# ---------------------------------------------------------------- 往返與最低版本寫檔


def test_v2_round_trip_keeps_everything_and_extra() -> None:
    doc = v2_doc()
    p, warnings = load(doc)
    assert warnings == []
    assert p.schema_version == 2 and p.written_version() == 2 and S.written_version(p) == 2
    seq = p.sequence
    assert seq is not None and [it.kind for it in seq.video] == ["clip", "gap", "clip"]
    c2 = seq.video[2]
    assert isinstance(c2, S.VideoClipV2) and c2.audio.gain_db == -3 and c2.audio.fade_curve == "equalPower"
    a1 = seq.audio_lanes[0].clips[0]
    assert a1.source is not None and (a1.source.type, a1.source.ref_id) == ("audio", "a-5f00000000000000")
    assert [pt.at for pt in a1.envelope] == [420000, 432000, 624000, 636000]
    assert p.audio_media[0].audio is not None and p.audio_media[0].audio.start_us == 25057 and p.audio_media[0].audio.video_start_us is None
    assert p.media[0].audio is not None and p.media[0].audio.gaps == [(1_000_000, 1_200_000)]
    assert p.audio_media_by_id("a-5f00000000000000") is p.audio_media[0]
    out = p.to_json()
    assert out == doc  # 值相等（Python 把 dB 寫成浮點，JSON 語意相同）
    assert list(out)[-3:] == ["sequence", "audioMedia", "projectFuture"]  # 鍵順序同 TS buildProjectFile，extra 殿後
    # 冪等：第二次讀寫逐字元相同
    text = S.dumps(p)
    assert S.dumps(S.loads(text).project) == text
    # 序列長度：300 + 15 + 450 幀
    assert SM.duration_frames(seq) == 765 and SM.total_samples(seq) == 1_224_000


def test_v1_fixture_stays_v1_and_has_no_v2_keys(tmp_path: Path) -> None:
    for name in ("minimal.aivc.json", "captions.aivc.json"):
        src = ENGINE_FIX / name
        r = S.load(src)
        assert r.project.sequence is None and r.project.audio_media == [] and r.project.written_version() == 1
        out = tmp_path / name
        S.save(r.project, out, touch_updated_at=False)
        d = json.loads(out.read_text(encoding="utf-8"))
        assert d["schemaVersion"] == 1 and "sequence" not in d and "audioMedia" not in d
        assert "audio" not in d["media"][0]  # v1 媒體沒有 audio 鍵，也不能憑空多出 "audio": null
        assert d == json.loads(src.read_text(encoding="utf-8"))


def test_engine_created_project_writes_v1() -> None:
    """ops/run.py、ops/detect.py 用 ProjectFileV1() 建檔：預設 schema_version=2，但寫出必須是 1（§4.3）。"""
    p = S.ProjectFileV1(profile="cards")
    assert p.schema_version == S.SCHEMA_VERSION == 2
    d = p.to_json()
    assert d["schemaVersion"] == 1 and "sequence" not in d and "audioMedia" not in d
    p.captions = {"m1": {"cues": []}}
    assert p.to_json()["schemaVersion"] == 1  # 字幕不算 v2 功能


@pytest.mark.parametrize(
    ("mutate", "written"),
    [
        (lambda d: None, 2),
        (lambda d: d.update(sequence=None), 2),  # 還有 audioMedia
        # 還有序列（音訊媒體沒了，引用它的音樂片段會被 sanitize 丟掉，先清掉免得干擾比對）
        (lambda d: (d.update(audioMedia=[]), d["sequence"]["audioLanes"][0].update(clips=[])), 2),
        (lambda d: d.update(sequence=None, audioMedia=[]), 1),
        (lambda d: (d.pop("sequence"), d.pop("audioMedia")), 1),
    ],
)
def test_written_version_rule(mutate: Any, written: int) -> None:
    doc = v2_doc()
    mutate(doc)
    p, _ = load(doc)
    out = p.to_json()
    assert out["schemaVersion"] == written == p.written_version()
    assert ("sequence" in out and "audioMedia" in out) is (written == 2)
    if written == 2:
        assert out["sequence"] == (doc.get("sequence") if doc.get("sequence") is not None else None)


def test_v2_doc_with_nothing_v2_downgrades_to_v1_on_write() -> None:
    """v2 檔但序列是 null、沒有音訊媒體（例如切一刀又全部 undo 回 null）：寫回 v1，v0.0.6 打得開。"""
    doc = v2_doc()
    doc["sequence"], doc["audioMedia"] = None, []
    del doc["media"][0]["audio"]
    p, warnings = load(doc)
    assert warnings == [] and p.schema_version == 2 and p.written_version() == 1
    out = p.to_json()
    assert out["schemaVersion"] == 1 and "sequence" not in out and "audioMedia" not in out


def test_media_audio_null_key_is_preserved() -> None:
    doc = v2_doc()
    doc["media"][0]["audio"] = None
    p, _ = load(doc)
    assert p.media[0].audio is None and p.to_json()["media"][0]["audio"] is None


def test_reject_schema_version_3_accept_1_and_2() -> None:
    for ver in (1, 2):
        d = v2_doc()
        d["schemaVersion"] = ver
        p, _ = load(d)
        assert p.schema_version == ver and p.sequence is not None  # 有鍵就照解（同 TS migrate toV2）
    d = v2_doc()
    d["schemaVersion"] = 3
    with pytest.raises(OpError) as ei:
        load(d)
    assert ei.value.kind == "Invalid" and "schemaVersion=3" in str(ei.value) and "更新" in ei.value.hint


def _canon(x: Any) -> str:
    """比「值」的標準形：整數值的 float 轉 int（Python 寫 -3.0、TS 寫 -3，JSON 上是同一個數），bool 保持 bool
    （直接用 == 比的話 True == 1 會讓 enabled: 1 這種漂移混過去），鍵排序（鍵順序由 TS 的逐位元測試負責）。"""

    def norm(v: Any) -> Any:
        if isinstance(v, float) and v.is_integer():
            return int(v)
        if isinstance(v, dict):
            return {k: norm(w) for k, w in v.items()}
        if isinstance(v, list):
            return [norm(w) for w in v]
        return v

    return json.dumps(norm(x), ensure_ascii=False, sort_keys=True)


def test_shared_v2_fixture_is_clean_and_matches_ts_output() -> None:
    """共用的 `fixtures/project/v2/two-clips-music.aivc.json`（§7.4 的專案；TS sanitize.sequence.test.ts 讀同一份）：
    零警告、仍寫 v2、寫出冪等，而且 sequence／audioMedia／media[].audio 寫出的值跟檔案本身相同（TS 那邊驗的是逐位元相同）。
    fixture 是 commit 進 repo 的：不存在就是紅，不 skip（skip 會讓兩邊各自「通過」卻讀不同的東西）。"""
    raw = json.loads(SHARED_V2.read_text(encoding="utf-8"))
    r = S.load(SHARED_V2)
    assert r.warnings == []
    assert r.project.written_version() == 2 and r.project.sequence is not None
    text = S.dumps(r.project)
    out = json.loads(text)
    for key in ("schemaVersion", "sequence", "audioMedia"):
        assert _canon(out[key]) == _canon(raw[key]), key
    assert [_canon(m.get("audio")) for m in out["media"]] == [_canon(m.get("audio")) for m in raw["media"]]
    again = S.loads(text)
    assert S.dumps(again.project) == text and again.warnings == []


def test_shared_broken_fixture_matches_ts_report_and_sanitized_golden() -> None:
    """共用的壞檔 `broken-sequence.aivc.json`：
    - 筆數：Python 的丟棄＋修正筆數 = TS 報告 golden（`broken-sequence.report.json`）的 total + warnings；
      寫出再讀只剩「媒體的事實」三條（離線、fps 不符、尺寸不符）。兩邊訊息文字不同，所以比筆數。
    - 內容：修正後的 sequence／audioMedia／media[].audio 跟 `broken-sequence.sanitized.json` 的值相同 ——
      TS 測試比對同一份 golden。只比筆數的話，「兩邊都丟一筆但丟的是不同筆」會混過去。"""
    base = SHARED_V2.parent
    report = json.loads((base / "broken-sequence.report.json").read_text(encoding="utf-8"))
    gold = json.loads((base / "broken-sequence.sanitized.json").read_text(encoding="utf-8"))
    r = S.load(base / "broken-sequence.aivc.json")
    assert len(r.warnings) == report["total"] + len(report["warnings"]), r.warnings
    out = json.loads(S.dumps(r.project))
    assert _canon(out["sequence"]) == _canon(gold["sequence"])
    assert _canon(out["audioMedia"]) == _canon(gold["audioMedia"])
    # 原本沒有 audio 鍵的媒體不能長出 audio 鍵（兩邊寫出的檔案鍵集合要一樣）
    assert _canon([{"id": m["id"], "audio": m["audio"]} if "audio" in m else {"id": m["id"]} for m in out["media"]]) == _canon(gold["media"])
    again = S.loads(S.dumps(r.project))
    assert len(again.warnings) == report["again"]["total"] + len(report["again"]["warnings"]), again.warnings
    assert json.loads(S.dumps(again.project)) == out


# ---------------------------------------------------------------- sanitize 規則表（§3.5）


def seq_of(doc: dict[str, Any]) -> dict[str, Any]:
    return doc["sequence"]


def test_sanitize_v1_clips_and_gaps() -> None:
    doc = v2_doc()
    v = seq_of(doc)["video"]
    v.append({"kind": "clip", "id": "ghost", "mediaId": "nope", "srcIn": 0, "srcOut": 10, "enabled": True, "audio": DEFAULT_AUDIO})
    v.append({"kind": "gap", "id": "g0", "length": 0})
    v.append({"kind": "clip", "id": "bad", "mediaId": "m1", "srcIn": 10, "srcOut": 10, "enabled": True, "audio": DEFAULT_AUDIO})
    v.append({"kind": "clip", "id": "neg", "mediaId": "m1", "srcIn": -1, "srcOut": 10, "enabled": True, "audio": DEFAULT_AUDIO})
    v.append({"kind": "clip", "id": "off", "mediaId": "m1", "srcIn": 1700, "srcOut": 1900, "enabled": True, "audio": DEFAULT_AUDIO})
    v.append({"kind": "title", "id": "t"})
    p, w = load(doc)
    assert p.sequence is not None
    assert [it.id for it in p.sequence.video] == ["c1", "g1", "c2", "off"]
    joined = "\n".join(w)
    assert "ghost" in joined and "g0" in joined and "bad" in joined and "neg" in joined and "title" in joined
    # 超界：保留並標離線（proxy 以不同 fps 重建時，片段不能被默默刪掉）
    assert any("off" in x and "離線" in x for x in w)


def test_sanitize_fps_and_size_mismatch_warns_but_keeps() -> None:
    doc = v2_doc()
    seq_of(doc)["fps"] = {"num": 25, "den": 1}
    p, w = load(doc)
    assert p.sequence is not None and len(p.sequence.video) == 3
    assert any("重建 proxy" in x and "25/1" in x for x in w)
    doc = v2_doc()
    seq_of(doc)["width"] = 1920
    p, w = load(doc)
    assert p.sequence is not None and any("尺寸" in x for x in w)


def test_sanitize_bad_fps_falls_back_to_proxy_fps_or_drops_sequence() -> None:
    doc = v2_doc()
    seq_of(doc)["fps"] = {"num": 0, "den": 1}
    p, w = load(doc)
    assert p.sequence is not None and (p.sequence.fps.num, p.sequence.fps.den) == (30, 1) and any("fps" in x for x in w)
    doc = v2_doc()
    seq_of(doc)["fps"] = "30"
    seq_of(doc)["video"] = [{"kind": "gap", "id": "g", "length": 3}]
    p, w = load(doc)
    assert p.sequence is None and any("隱含序列" in x for x in w)
    # 序列丟掉後還有 audioMedia → 仍寫 v2（audioMedia 不能因為序列壞掉而消失）
    assert p.written_version() == 2


def test_sanitize_audio_clips() -> None:
    doc = v2_doc()
    clips = seq_of(doc)["audioLanes"][0]["clips"]
    base = clips[0]
    clips.append(dict(copy.deepcopy(base), id="overlap", start=500_000))  # 與 a1（48000..1008000）重疊 → 丟後者
    clips.append(dict(copy.deepcopy(base), id="nosrc", source={"type": "audio", "audioId": "a-missing"}, start=5_000_000))
    clips.append(dict(copy.deepcopy(base), id="badtype", source={"type": "video", "mediaId": "m1"}, start=6_000_000))
    clips.append(dict(copy.deepcopy(base), id="neglen", start=7_000_000, length=0))
    clips.append(dict(copy.deepcopy(base), id="negstart", start=-1))
    clips.append(dict(copy.deepcopy(base), id="farneg", start=8_000_000, srcIn=-10 * 44100 - 1))  # 44.1 kHz 來源：−10 秒是下限
    clips.append(dict(copy.deepcopy(base), id="okneg", start=9_000_000, srcIn=-10 * 44100, fadeIn=0, fadeOut=0, envelope=[]))
    clips.append(dict(copy.deepcopy(base), id="frommedia", source={"type": "media", "mediaId": "m1"}, start=20_000_000, fadeIn=0, fadeOut=0, envelope=[]))
    p, w = load(doc)
    assert p.sequence is not None
    assert [c.id for c in p.sequence.audio_lanes[0].clips] == ["a1", "okneg", "frommedia"]
    joined = "\n".join(w)
    for bad in ("overlap", "a-missing", "badtype", "neglen", "negstart", "farneg"):
        assert bad in joined, bad


def test_sanitize_fades_envelope_and_gain_clamp() -> None:
    doc = v2_doc()
    a1 = seq_of(doc)["audioLanes"][0]["clips"][0]
    a1.update(length=1000, fadeIn=900, fadeOut=600, gainDb=40, envelope=[{"at": 2000, "db": 50}, {"at": -5, "db": -200}, {"at": 500, "db": -6}, {"at": "x", "db": 0}])
    c2 = seq_of(doc)["video"][2]["audio"]
    c2["fadeOut"] = 10_000_000  # 原音淡出超過片段長度 S(765) − S(315) = 720 000
    p, w = load(doc)
    assert p.sequence is not None
    c = p.sequence.audio_lanes[0].clips[0]
    # 等比縮小一律 floor：900·1000//1500 = 600、600·1000//1500 = 400，加起來 ≤ length
    assert (c.fade_in, c.fade_out) == (600, 400) and c.fade_in + c.fade_out <= c.length
    assert c.gain_db == 12.0
    assert [(pt.at, pt.db) for pt in c.envelope] == [(0, -96.0), (500, -6.0), (1000, 12.0)]
    v2 = p.sequence.video[2]
    assert isinstance(v2, S.VideoClipV2) and v2.audio.fade_out == 720_000
    joined = "\n".join(w)
    assert "等比" in joined and "自動化點" in joined and "gainDb" in joined


def test_sanitize_original_fades_use_sample_length_at_29_97() -> None:
    """29.97 fps 時片段樣本長依位置而定（1601／1602）：淡化上限要用 S(t1) − S(t0)，不是 length × 1601.6。"""
    doc = v2_doc()
    doc["media"][0]["proxy"]["fps"] = {"num": 30000, "den": 1001}
    s = seq_of(doc)
    s["fps"] = {"num": 30000, "den": 1001}
    s["video"] = [
        {"kind": "clip", "id": "x", "mediaId": "m1", "srcIn": 0, "srcOut": 1, "enabled": True, "audio": dict(DEFAULT_AUDIO, fadeIn=5000)},
        {"kind": "clip", "id": "y", "mediaId": "m1", "srcIn": 1, "srcOut": 2, "enabled": True, "audio": dict(DEFAULT_AUDIO, fadeOut=5000)},
    ]
    p, _ = load(doc)
    assert p.sequence is not None
    x, y = p.sequence.video
    assert isinstance(x, S.VideoClipV2) and isinstance(y, S.VideoClipV2)
    assert x.audio.fade_in == 1601 and y.audio.fade_out == 3203 - 1601 == 1602


def test_sanitize_detached_refs() -> None:
    doc = v2_doc()
    s = seq_of(doc)
    s["video"][0]["audio"] = dict(DEFAULT_AUDIO, enabled=False, detachedTo="nowhere")
    s["video"][2]["audio"] = dict(DEFAULT_AUDIO, enabled=True, detachedTo="det")  # 目標存在但原音還開著 → 關掉
    s["audioLanes"][1]["clips"] = [
        {"id": "det", "source": {"type": "media", "mediaId": "m1"}, "start": 0, "length": 480000, "srcIn": 96000, "enabled": True, "detachedFrom": "c2", **{k: v for k, v in DEFAULT_AUDIO.items() if k != "enabled"}},
        {"id": "orphan", "source": {"type": "media", "mediaId": "m1"}, "start": 480000, "length": 1000, "srcIn": 0, "enabled": True, "detachedFrom": "gone", **{k: v for k, v in DEFAULT_AUDIO.items() if k != "enabled"}},
    ]
    p, w = load(doc)
    assert p.sequence is not None
    c1, _, c2 = p.sequence.video
    assert isinstance(c1, S.VideoClipV2) and c1.audio.detached_to is None and c1.audio.enabled is True
    assert isinstance(c2, S.VideoClipV2) and c2.audio.detached_to == "det" and c2.audio.enabled is False
    det, orphan = p.sequence.audio_lanes[1].clips
    assert det.detached_from == "c2" and orphan.detached_from is None
    joined = "\n".join(w)
    assert "nowhere" in joined and "gone" in joined and "仍啟用" in joined


def test_sanitize_duplicate_ids_are_renumbered_across_v1_and_lanes() -> None:
    doc = v2_doc()
    s = seq_of(doc)
    s["video"][2]["id"] = "c1"  # V1 內重複
    s["audioLanes"][0]["clips"][0]["id"] = "g1"  # 與 V1 的空白重複
    s["audioLanes"][1]["id"] = "lane-1"  # 軌道 id 重複
    p, w = load(doc)
    assert p.sequence is not None
    ids = [it.id for it in p.sequence.video] + [c.id for ln in p.sequence.audio_lanes for c in ln.clips]
    assert len(ids) == len(set(ids)) and ids[0] == "c1" and ids[1] == "g1"
    assert len({ln.id for ln in p.sequence.audio_lanes}) == 2
    assert sum("重新發號" in x for x in w) == 2 and any("音軌" in x and "重複" in x for x in w)


def test_sanitize_lane_defaults_and_enums() -> None:
    doc = v2_doc()
    lanes = seq_of(doc)["audioLanes"]
    del lanes[0]["syncLock"]  # music → 預設 False（§0.1 Q3）
    del lanes[1]["syncLock"]  # other → 預設 True
    lanes[1]["role"] = "karaoke"
    seq_of(doc)["audioLanes"][0]["clips"][0]["fadeCurve"] = "log"
    seq_of(doc)["sampleRate"] = 44100
    p, w = load(doc)
    assert p.sequence is not None
    assert [ln.sync_lock for ln in p.sequence.audio_lanes] == [False, True]
    assert p.sequence.audio_lanes[1].role == "other" and p.sequence.audio_lanes[0].clips[0].fade_curve == "linear"
    assert p.sequence.sample_rate == 48000
    joined = "\n".join(w)
    assert "karaoke" in joined and "log" in joined and "44100" in joined
    assert S.default_sync_lock("music") is False and all(S.default_sync_lock(r) for r in ("voiceover", "sfx", "other"))


def test_sanitize_audio_media_and_audio_info() -> None:
    doc = v2_doc()
    doc["audioMedia"].append(copy.deepcopy(doc["audioMedia"][0]))  # 重複 id
    doc["audioMedia"].append({"path": "x.mp3"})  # 缺 id
    doc["media"][0]["audio"] = {"codec": "opus", "sampleRate": 0}  # 不完整 → 視為缺快取（會重算）
    doc["audioMedia"][0]["role"] = "podcast"
    p, w = load(doc)
    assert [a.id for a in p.audio_media] == ["a-5f00000000000000"] and p.audio_media[0].role == "other"
    assert p.media[0].audio is None
    joined = "\n".join(w)
    assert "重複" in joined and "缺 id" in joined and "缺快取" in joined and "podcast" in joined


def test_sanitize_audio_media_path_required_and_name_from_path() -> None:
    """與 TS sanitizeAudioMedia 同規則：id 與 path 都必填（缺 path 的不佔 id，後面同 id 的有效項目照收）；
    沒寫 name 就用路徑最後一段（兩種斜線都切）。"""
    doc = v2_doc()
    doc["sequence"]["audioLanes"][0]["clips"] = []
    doc["audioMedia"] = [
        {"id": "a-nopath"},
        {"id": "a-empty", "path": ""},
        {"id": "a-nopath", "path": "D:\\music\\later.wav"},
        {"id": "a-slash", "path": "/home/u/sfx/hit.ogg", "name": ""},
    ]
    p, w = load(doc)
    assert [(a.id, a.path, a.name) for a in p.audio_media] == [("a-nopath", "D:\\music\\later.wav", "later.wav"), ("a-slash", "/home/u/sfx/hit.ogg", "hit.ogg")]
    assert sum("缺 path" in x for x in w) == 2 and not any("重複" in x for x in w)


def test_non_object_sequence_and_audio_media_are_dropped_with_warning() -> None:
    doc = v2_doc()
    doc["sequence"], doc["audioMedia"] = [1, 2], {"a": 1}
    p, w = load(doc)
    assert p.sequence is None and p.audio_media == [] and p.written_version() == 1
    assert any("sequence" in x for x in w) and any("audioMedia" in x for x in w)
