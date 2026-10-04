"""project/schema.py + paths.py：v1 往返、camelCase key 一字不差、壞輸入 drop-and-warn、拒絕 >1。

核心測的是「沒有外掛」的樣子（`hooks.suspended`，裝不裝外掛結果都一樣）：外掛的鍵（fixture 裡的 cardSlots／deck／slotId／
templateCard）核心不解析，原樣留在 extra 寫回。有外掛時的解析在 plugins/cards/engine/tests/test_project_cards.py。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from aivc import hooks
from aivc.ops import OpError
from aivc.project import paths, schema as S

FIX = Path(__file__).parent / "fixtures" / "project" / "v1"

# 計畫 §5.6 的 key 集合（一字不差；核心認得的部分）
PROJECT_KEYS = {"schemaVersion", "app", "createdAt", "updatedAt", "media", "activeMediaId", "profile", "shots", "tracks", "insertDefaults", "exportDefaults"}
MEDIA_KEYS = {"id", "path", "name", "fingerprint", "probe", "proxy"}
PROXY_KEYS = {"fps", "frames", "width", "height", "scale", "version"}
SHOT_KEYS = {"id", "startFrame", "endFrame", "kind", "source"}
TRACK_KEYS = {"id", "shotId", "label", "kind", "referenceFrame", "trackingRegion", "keyframes", "prompts", "adjust", "options", "insert", "regionPolicy", "stale"}
KEYFRAME_KEYS = {"frame", "quad", "source"}
REFPOINT_KEYS = {"id", "frame", "cornerIndex", "xy", "locked", "primaryFrame"}
INSERT_DEFAULT_KEYS = {"macro", "opacity", "applyMix", "edge", "occlusion", "motionBlur", "resample", "relight", "grain"}
EXPORT_KEYS = {"codec", "quality", "audio", "trackData"}


@pytest.fixture(autouse=True)
def _core_only():  # noqa: ANN202
    with hooks.suspended():
        yield


def _raw(name: str) -> dict:
    return json.loads((FIX / name).read_text(encoding="utf-8"))


def test_load_minimal_fixture_no_warnings() -> None:
    r = S.load(FIX / "minimal.aivc.json")
    assert r.warnings == []
    p = r.project
    assert p.schema_version == 1 and p.profile == "cards" and p.active_media_id == "m1"
    m = p.active_media()
    assert m is not None and m.proxy is not None and m.proxy.frames == 1797 and m.proxy.fps.value == 30.0
    assert [s.kind for s in p.shots["m1"]] == ["close", "wide", "close", "wide"]
    t1 = p.track_by_id("m1", "t1")
    assert t1 is not None
    assert t1.reference_frame == 1080 and t1.tracking_region is not None
    assert [k.source for k in t1.keyframes] == ["detector", "user"]
    assert t1.keyframes[1].locked_corners == [True, False, False, True]
    assert t1.keyframes[0].locked_corners is None
    assert t1.prompts[0].points[1].label == 0
    assert t1.adjust.points[0].corner_index == 0 and t1.adjust.points[0].locked
    assert t1.options.smoothing == 0.4
    assert t1.insert is not None and t1.insert.macro == "custom" and t1.insert.opacity == 95 and t1.insert.edge.falloff == "smoothstep"
    assert t1.insert.grain is None  # 沒寫 = 繼承
    t2 = p.track_by_id("m1", "t2")
    assert t2 is not None and t2.insert is None and t2.region_policy == "hold"
    # 外掛的鍵核心不解析：原樣留在 extra（沒有外掛就沒有 slot_id／card_slots 這些屬性）
    raw = _raw("minimal.aivc.json")
    assert t1.extra["slotId"] == "slot-p1" and "slotId" not in t2.extra and t1.options.extra == {"templateCard": "8H"}
    assert p.extra == {"cardSlots": raw["cardSlots"], "deck": raw["deck"]}
    with pytest.raises(AttributeError):
        _ = t1.slot_id
    assert p.export_defaults.track_data.frame_offset == 1 and p.export_defaults.codec == "libvpx-vp9"
    assert p.insert_defaults.motion_blur is not None and p.insert_defaults.motion_blur.shutter_angle == 180


def test_round_trip_is_byte_stable_and_keys_exact(tmp_path: Path) -> None:
    src = FIX / "minimal.aivc.json"
    r = S.load(src)
    out = tmp_path / "rt.aivc.json"
    S.save(r.project, out, touch_updated_at=False)
    again = S.load(out)
    assert again.warnings == []
    # 第二次序列化與第一次逐字元相同（冪等）
    assert S.dumps(again.project) == S.dumps(r.project)
    # 與原 fixture 的 JSON 值相等（fixture 是 TS 這邊的形狀）
    assert json.loads(out.read_text(encoding="utf-8")) == json.loads(src.read_text(encoding="utf-8"))
    d = json.loads(out.read_text(encoding="utf-8"))
    raw = json.loads(src.read_text(encoding="utf-8"))
    foreign = set(raw) - PROJECT_KEYS  # 核心不認得的頂層鍵（這份 fixture：外掛的 cardSlots／deck）
    assert foreign and set(d) == PROJECT_KEYS | foreign and all(d[k] == raw[k] for k in foreign)
    assert set(d["media"][0]) == MEDIA_KEYS
    assert set(d["media"][0]["proxy"]) == PROXY_KEYS
    assert set(d["shots"]["m1"][0]) == SHOT_KEYS
    t1 = d["tracks"]["m1"][0]
    assert set(t1) == TRACK_KEYS | {"slotId"} and t1["slotId"] == raw["tracks"]["m1"][0]["slotId"]  # 外掛的鍵原樣寫回
    assert set(t1["keyframes"][0]) == KEYFRAME_KEYS
    assert set(t1["keyframes"][1]) == KEYFRAME_KEYS | {"lockedCorners"}
    assert set(t1["adjust"]["points"][0]) == REFPOINT_KEYS
    assert set(t1["options"]) == {"method", "motionModel", "smoothing", "templateCard"}
    assert set(d["tracks"]["m1"][1]) == TRACK_KEYS
    assert set(d["insertDefaults"]) == INSERT_DEFAULT_KEYS
    assert set(d["exportDefaults"]) == EXPORT_KEYS
    assert set(d["exportDefaults"]["trackData"]) == {"format", "flavour", "baked", "frameOffset"}


def test_save_is_atomic_and_touches_updated_at(tmp_path: Path) -> None:
    p = S.ProjectFileV1()
    before = p.updated_at
    out = tmp_path / "sub dir with space" / "x.aivc.json"
    S.save(p, out)
    assert out.is_file() and not out.with_name(out.name + ".part").exists()
    assert S.load(out).project.updated_at >= before
    assert out.read_text(encoding="utf-8").endswith("}\n")


def test_reject_newer_schema(tmp_path: Path) -> None:
    # 引擎支援到 v2（M2 序列）；比它新的 v3 才拒絕
    f = tmp_path / "v3.aivc.json"
    f.write_text(json.dumps({"schemaVersion": 3, "media": []}), encoding="utf-8")
    with pytest.raises(OpError) as ei:
        S.load(f)
    assert ei.value.kind == "Invalid" and "schemaVersion=3" in str(ei.value)
    with pytest.raises(OpError) as ei2:
        S.loads('{"media": []}')
    assert ei2.value.kind == "Invalid"
    with pytest.raises(OpError) as ei3:
        S.loads("{not json")
    assert ei3.value.kind == "Invalid"
    with pytest.raises(OpError) as ei4:
        S.load(tmp_path / "missing.aivc.json")
    assert ei4.value.kind == "Io"


def test_broken_input_is_sanitized_with_warnings() -> None:
    r = S.load(FIX / "broken.aivc.json")
    p, w = r.project, "\n".join(r.warnings)
    # shots：壞範圍與非數字幀號丟掉
    assert [s.id for s in p.shots["m1"]] == ["s1"]
    assert "s-bad" in w and "s-nan" in w
    assert p.shots["m1"][0].extra == {"futureShotKey": 7}
    # tracks：沒 id 的丟掉；t1 保留但欄位被修
    assert [t.id for t in p.tracks["m1"]] == ["t1"]
    t = p.tracks["m1"][0]
    assert t.reference_frame is None  # 1e309 → inf → null
    assert t.tracking_region is None  # 非凸 → null
    assert [k.frame for k in t.keyframes] == [5, 8]  # "abc" / 500(≥proxy.frames) / 非凸 / 3 點 全丟
    assert t.keyframes[1].source == "user" and t.keyframes[1].locked_corners is None  # source robot→user；lockedCorners 長度錯→忽略
    assert len(t.prompts) == 1 and [pt.label for pt in t.prompts[0].points] == [1]  # label 2 / x 非數 丟點；全壞的 prompt 丟；frame -1 丟
    assert t.adjust.points[0].corner_index is None and t.adjust.enabled
    assert t.options.method == "classic" and t.options.smoothing == 1.0
    assert t.insert is not None and t.insert.macro == "standard" and t.insert.motion_blur.samples == "auto"
    assert t.region_policy == "keepBarcode" and t.stale is False
    # 外掛的鍵（slotId 指向不存在的格位、壞的 templateCard、整個 cardSlots／deck）核心不檢查、原樣保存
    raw = _raw("broken.aivc.json")
    raw_t1 = next(x for x in raw["tracks"]["m1"] if isinstance(x, dict) and x.get("id") == "t1")
    assert t.extra == {"futureTrackKey": [1, 2, 3], "slotId": raw_t1["slotId"]}
    # 其他
    assert p.active_media_id == "m1"  # ghost → 第一個 media
    assert p.export_defaults.track_data.format == "nuke"
    assert p.extra == {"futureTopLevelKey": {"keep": "me"}, "cardSlots": raw["cardSlots"], "deck": raw["deck"]}
    # insertDefaults 只給 macro → 其餘補預設
    assert p.insert_defaults.opacity == 100 and p.insert_defaults.edge is not None
    assert len(r.warnings) >= 12
    # 寫回後未知 key 仍在
    d = json.loads(S.dumps(p))
    assert d["futureTopLevelKey"] == {"keep": "me"} and d["tracks"]["m1"][0]["futureTrackKey"] == [1, 2, 3]


def test_resolve_insert_inherits_defaults() -> None:
    defaults = S.InsertV1.defaults()
    defaults.opacity = 90
    track = S.InsertV1(macro="custom", edge=S.EdgeV1(choke=1.0, softness=1.2, falloff="smoothstep"))
    r = S.resolve_insert(track, defaults)
    assert r.macro == "custom" and r.opacity == 90 and r.edge.choke == 1.0 and r.grain.mode == "measured"
    r2 = S.resolve_insert(None, defaults)
    assert r2.macro == "standard" and r2.edge.choke == 0.6


def test_shutter_angle_auto_survives_the_project_round_trip() -> None:
    """`motionBlur.shutterAngle: "auto"` 要一路活到 `InsertParams`。

    兩個踩過的坑：(1) schema 的 `_num` 會把 "auto" 當壞值換成 180；
    (2) profile 把它寫進 `insertDefaults.extra` 的話，存檔看得到、但 `insert_dict_for` 只讀 typed 欄位 →
    `aivc render` 讀存檔會生效、`aivc run` 一路跑下來卻不會（同一份專案兩條路徑不一致）。"""
    from aivc.comp.params import InsertParams
    from aivc.project import resolve as R

    mb = S.MotionBlurV1.from_json({"shutterAngle": "auto"}, lambda m: None, "insertDefaults")
    assert mb.shutter_angle == "auto"
    assert mb.to_json()["shutterAngle"] == "auto"
    assert S.MotionBlurV1.from_json({"shutterAngle": 120.0}, lambda m: None, "x").shutter_angle == 120.0
    assert S.MotionBlurV1.from_json({"shutterAngle": "nope"}, lambda m: None, "x").shutter_angle == 180.0
    defaults = S.InsertV1.defaults()
    defaults.motion_blur = mb
    track = S.TrackV1(id="t", shot_id="s", label="t", kind="planar")
    project = S.ProjectFileV1()
    project.insert_defaults = defaults
    d = R.insert_dict_for(track, project)
    assert d["motionBlur"]["shutterAngle"] == "auto"
    assert InsertParams.from_dict(d).motion_blur.shutter_angle == "auto"


def test_quad_helpers() -> None:
    q = S.Quad.from_points([[0, 0], [10, 0], [10, 5], [0, 5]])
    assert q.to_json() == {"p": [[0.0, 0.0], [10.0, 0.0], [10.0, 5.0], [0.0, 5.0]]}
    assert S.Quad.from_json({"p": [[0, 0], [10, 10], [10, 0], [0, 10]]}) is None
    assert S.Quad.from_json({"p": [[0, 0], [1, 0], [1, 1]]}) is None
    with pytest.raises(ValueError):
        S.Quad.from_points([[0, 0], [10, 10], [10, 0], [0, 10]])


# ---------------------------------------------------------------- paths


def test_media_cache_layout(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache root"))
    fp = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    mc = paths.media_cache(fp)
    root = tmp_path / "cache root" / "media" / "0123456789abcdef"
    assert mc.root == root
    assert mc.probe == root / "probe.v1.json"
    assert mc.index == root / "index.v1.json"
    assert mc.shots == root / "shots.v1.json"
    assert mc.proxy == root / "proxy.mp4"
    assert mc.thumbs == root / "thumbs"
    assert mc.masks("t1") == root / "tracks" / "t1" / "masks.aivm"
    assert mc.solve("t1") == root / "tracks" / "t1" / "solve.v1.json"
    assert mc.face("t1", 412) == root / "tracks" / "t1" / "faces" / "412.png"
    assert mc.rel(mc.masks("t1")) == "tracks/t1/masks.aivm"
    assert mc.status() == {"probe": False, "index": False, "shots": False, "proxy": False, "thumbs": False}
    mc.ensure()
    assert root.is_dir()
    with pytest.raises(ValueError):
        paths.media_cache("short")
    with pytest.raises(ValueError):
        paths.media_cache("zz23456789abcdef0123456789abcdef")


def test_safe_component_blocks_traversal() -> None:
    assert paths.safe_component("t1") == "t1"
    assert paths.safe_component("track/../../etc") == "track_.._.._etc"
    assert paths.safe_component("a\\b") == "a_b"
    for bad in ("", "..", ".", "/", "\\"):
        with pytest.raises(ValueError):
            paths.safe_component(bad)


def test_fingerprint_fallback_matches_rust_layout(tmp_path: Path) -> None:
    import blake3

    f = tmp_path / "small.bin"
    f.write_bytes(b"abc")
    h = blake3.blake3()
    h.update((3).to_bytes(8, "little"))
    h.update(b"abc")
    assert paths.fingerprint_fallback(f) == h.hexdigest()
    assert len(paths.fingerprint_for(f)) == 64
    # 大於 4 MiB：尾巴也要進來，且與只雜湊 head 不同
    big = tmp_path / "big.bin"
    big.write_bytes(b"\0" * (4 * 1024 * 1024 + 10) + b"tail")
    h2 = blake3.blake3()
    size = big.stat().st_size
    h2.update(size.to_bytes(8, "little"))
    data = big.read_bytes()
    h2.update(data[: 4 * 1024 * 1024])
    h2.update(data[size - 4 * 1024 * 1024 :])
    assert paths.fingerprint_fallback(big) == h2.hexdigest()


def test_export_defaults_quality_unset_lets_codec_default_win() -> None:
    """專案層沒選過畫質 → None，交給 encode_plan 依 codec 決定（VP9 16）；以前寫死 24 會蓋過編碼計畫的預設。"""
    from aivc.media import encode_plan as EP
    from aivc.project import schema as S

    warns: list[str] = []
    assert S.ExportDefaultsV1().quality is None
    assert S.ExportDefaultsV1.from_json({"codec": "auto"}, warns.append).quality is None
    assert S.ExportDefaultsV1.from_json({"quality": 20}, warns.append).quality == 20.0  # 使用者明確選過的保留
    assert S.ExportDefaultsV1().to_json()["quality"] is None
    assert EP._DEFAULT_Q["libvpx-vp9"] == 16
