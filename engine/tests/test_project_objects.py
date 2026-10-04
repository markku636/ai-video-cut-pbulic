"""專案檔的通用物件鍵（docs/tracking-api.md「專案檔」）：object track、effects、replace——讀進寫出逐位元相同、
鍵放回原位、壞值丟掉並警告、程式新建的 track 依固定順序寫；沒有用到這些鍵的專案跟以前一模一樣。"""
from __future__ import annotations

import json
from typing import Any

import pytest

from aivc.project import schema as S


def _doc(tracks: list[dict[str, Any]], frames: int = 100) -> dict[str, Any]:
    return {
        "schemaVersion": 1, "app": "ai-video-cut", "createdAt": "2026-10-03T00:00:00.000Z", "updatedAt": "2026-10-03T00:00:00.000Z",
        "media": [{"id": "m1", "path": "a.mp4", "name": "a", "fingerprint": "", "probe": None,
                   "proxy": {"fps": {"num": 30, "den": 1}, "frames": frames, "width": 64, "height": 48, "scale": 1.0, "version": 1}}],
        "activeMediaId": "m1", "profile": "generic",
        "shots": {"m1": [{"id": "s1", "startFrame": 0, "endFrame": 60, "kind": "unknown", "source": "auto"},
                         {"id": "s2", "startFrame": 60, "endFrame": frames, "kind": "unknown", "source": "auto"}]},
        "tracks": {"m1": tracks},
        "insertDefaults": S.InsertV1.defaults().to_json(), "exportDefaults": S.ExportDefaultsV1().to_json(),
    }


def _planar_base(tid: str) -> dict[str, Any]:
    return {
        "id": tid, "shotId": "s1", "label": tid, "kind": "planar", "referenceFrame": 0, "trackingRegion": None, "keyframes": [], "prompts": [],
        "adjust": {"points": [], "enabled": False}, "options": {"method": "classic", "motionModel": "perspective", "smoothing": 0.4},
        "insert": None, "regionPolicy": "keepBarcode", "stale": False,
    }


def _text(doc: dict[str, Any]) -> str:
    return json.dumps(doc, ensure_ascii=False, indent=2) + "\n"


OBJECT_TRACK = {
    "id": "o1", "shotId": "s1", "label": "face", "kind": "object", "color": "#FF8800",
    "source": {"type": "text", "text": "face", "phrase": "face", "backend": "sam2", "score": 0.91, "futureSub": [1, 2]},
    "range": [3, 50], "referenceFrame": 10, "trackingRegion": None, "keyframes": [], "prompts": [],
    "adjust": {"points": [], "enabled": False}, "options": {"method": "classic", "motionModel": "perspective", "smoothing": 0.4},
    "insert": None, "regionPolicy": "keepBarcode", "stale": False, "staleReason": None,
    "effects": [
        {"id": "e1", "enabled": True, "type": "mosaic", "blocks": 12, "shape": "ellipse"},
        {"id": "e2", "enabled": False, "type": "blur", "strength": 0.3, "unknownParam": 1},
    ],
    "futureKey": {"a": 1},
}


def test_object_track_roundtrip_byte_identical_and_typed() -> None:
    planar = {**_planar_base("p1"), "effects": [], "replace": {"kind": "video", "path": "b.mp4", "fit": "cover", "offsetFrames": -4, "loop": "hold", "extraR": True}}
    text = _text(_doc([OBJECT_TRACK, planar]))
    r = S.loads(text)
    assert r.warnings == []
    assert _tracks_text(S.dumps(r.project)) == _tracks_text(text)
    if not r.project.ext:
        assert S.dumps(r.project) == text
    o, p = r.project.tracks["m1"]
    assert o.is_object and o.kind == "object" and o.color == "#FF8800" and o.frame_range == (3, 50) and o.reference_frame == 10
    assert o.source is not None and (o.source.type, o.source.text, o.source.phrase, o.source.backend, o.source.score) == ("text", "face", "face", "sam2", 0.91)
    assert [e["id"] for e in o.effects or []] == ["e1", "e2"]
    assert [S.effect_enabled(e) for e in o.effects or []] == [True, False]
    assert S.effect_params(o.effects[1]) == {"type": "blur", "strength": 0.3, "unknownParam": 1}  # type: ignore[index]
    assert o.extra == {"staleReason": None, "futureKey": {"a": 1}}  # 未知鍵照存
    assert not p.is_object and p.effects == [] and p.replace is not None
    assert (p.replace.kind, p.replace.path, p.replace.fit, p.replace.offset_frames, p.replace.loop) == ("video", "b.mp4", "cover", -4, "hold")


def _tracks_text(text: str) -> str:
    """只比 tracks（裝了外掛時頂層會多外掛的預設區段，那不是這裡要測的）；保留鍵序。"""
    return json.dumps(json.loads(text)["tracks"], ensure_ascii=False, indent=1)


@pytest.mark.parametrize("new_keys_at", [
    {"kind": ["color", "source", "range", "effects"]},  # 接在 kind 後面
    {"id": ["replace", "effects"]},  # 很前面
    {"staleReason": ["range", "color", "effects", "replace"], "regionPolicy": ["source"]},  # 殿後、交錯、接在未知鍵後面
])
def test_new_keys_keep_their_original_position(new_keys_at: dict[str, list[str]]) -> None:
    # 核心鍵維持核心的順序（TS 與引擎都照這個順序寫），新鍵插在指定的鍵後面
    base = {**_planar_base("p1"), "staleReason": "x"}
    vals = {"color": "#00FF00", "source": {"type": "select"}, "range": [1, 5], "effects": [{"id": "a", "enabled": True, "type": "glow"}],
            "replace": {"kind": "image", "path": "x.png"}}
    t: dict[str, Any] = {}
    for k, v in base.items():
        t[k] = v
        for nk in new_keys_at.get(k, []):
            t[nk] = vals[nk]
    text = _text(_doc([t]))
    r = S.loads(text)
    assert _tracks_text(S.dumps(r.project)) == _tracks_text(text), list(t)
    if not r.project.ext:  # 沒裝外掛：整份逐位元相同
        assert S.dumps(r.project) == text
    assert S.dumps(S.loads(S.dumps(r.project)).project) == S.dumps(r.project)  # 冪等


def test_program_built_track_writes_keys_after_stale_in_fixed_order() -> None:
    p = S.ProjectFileV1(profile="generic")
    t = S.TrackV1(id="o9", shot_id="s1", kind="object", color="#112233", source=S.ObjectSourceV1.make("select", backend="sam2"),
                  frame_range=(0, 9), effects=[{"id": "e", "enabled": True, "type": "mosaic"}])
    t.replace = S.ReplaceV1.make("image", "a.png", fit="contain")
    p.tracks["m1"] = [t]
    d = p.to_json()["tracks"]["m1"][0]
    keys = list(d)
    assert keys[keys.index("stale") + 1 :] == ["color", "source", "range", "effects", "replace"]
    assert d["range"] == [0, 9] and d["source"] == {"type": "select", "backend": "sam2"}
    assert d["replace"] == {"kind": "image", "path": "a.png", "fit": "contain", "offsetFrames": 0, "loop": "loop"}


def test_untouched_projects_have_none_of_the_new_keys() -> None:
    text = _text(_doc([_planar_base("p1")]))
    r = S.loads(text)
    t = r.project.tracks["m1"][0]
    assert (t.color, t.source, t.frame_range, t.effects, t.replace) == (None, None, None, None, None)
    out = S.dumps(r.project)
    assert _tracks_text(out) == _tracks_text(text)
    assert not {"color", "source", "range", "effects", "replace"} & set(json.loads(out)["tracks"]["m1"][0])


def test_bad_values_are_dropped_with_warnings() -> None:
    bad = {
        **_planar_base("p1"), "kind": "object", "color": "red", "source": {"type": "magic"}, "range": [5, 2],
        "effects": [{"id": "ok", "type": "mosaic"}, {"type": "blur"}, "x", {"id": "noType"}, {"id": "en", "type": "glow", "enabled": "yes"}],
        "replace": {"kind": "gif", "path": "a.gif"},
    }
    r = S.loads(_text(_doc([bad])))
    t = r.project.tracks["m1"][0]
    assert t.color is None and t.source is None and t.frame_range is None and t.replace is None
    assert [e["id"] for e in t.effects or []] == ["ok", "en"]  # 缺 id／type、不是物件的丟掉；enabled 不是布林照留（視為啟用）
    assert S.effect_enabled(t.effects[1])  # type: ignore[index]
    w = "\n".join(r.warnings)
    for frag in ("color='red'", "source.type='magic'", "range=[5, 2]", "effects[1] 缺 id", "effects[2] 不是物件", "effects[3]（noType）缺 type", "enabled='yes'", "replace.kind='gif'"):
        assert frag in w, (frag, r.warnings)
    out = json.loads(S.dumps(r.project))["tracks"]["m1"][0]
    assert "color" not in out and "replace" not in out and len(out["effects"]) == 2


def test_replace_optional_fields_default_and_warn() -> None:
    t = {**_planar_base("p1"), "replace": {"kind": "video", "path": "v.mp4", "fit": "zoom", "loop": 3, "offsetFrames": 1.5}}
    r = S.loads(_text(_doc([t])))
    rp = r.project.tracks["m1"][0].replace
    assert rp is not None and (rp.fit, rp.loop, rp.offset_frames) == ("stretch", "loop", 0)
    assert len([w for w in r.warnings if "replace" in w]) == 3
    # 值照原樣寫回（App 端可能是更新的版本，認得 zoom）
    assert json.loads(S.dumps(r.project))["tracks"]["m1"][0]["replace"]["fit"] == "zoom"
    # 缺 path → 整個丟掉
    r2 = S.loads(_text(_doc([{**_planar_base("p1"), "replace": {"kind": "image"}}])))
    assert r2.project.tracks["m1"][0].replace is None and any("path" in w for w in r2.warnings)


def test_range_cross_checks() -> None:
    t = {**OBJECT_TRACK, "shotId": "s2", "range": [3, 200]}
    r = S.loads(_text(_doc([t])))
    tr = r.project.tracks["m1"][0]
    assert tr.frame_range == (3, 200)  # 超過 proxy 幀數只警告（render 夾）
    assert any("超過 proxy 幀數 100" in w for w in r.warnings)
    assert any("range 起點 3 不在 shot s2" in w for w in r.warnings)


def test_plugin_installed_roundtrip_of_object_tracks_is_identical() -> None:
    """裝了外掛（track 層有外掛認領的鍵 → 未知鍵殿後）時，通用物件的鍵也回到原位。"""
    from aivc import hooks

    hooks.entries("schema-field")  # 觸發外掛探索（有裝就載入）
    text = _text(_doc([OBJECT_TRACK]))
    r = S.loads(text)
    assert _tracks_text(S.dumps(r.project)) == _tracks_text(text)
