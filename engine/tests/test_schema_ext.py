"""外掛擴充點的核心行為（不需要任何真的外掛）：

- 沒有外掛時，外掛的鍵（牌局專案的 cardSlots／deck、track 的 slotId／identity、options.templateCard、insert 的
  paperRatio／flip／print／smoothing／stack）讀進寫出**原樣保存**，而且留在原來的位置（TS 寫的檔讀進寫出逐位元相同）；
- `hooks.SchemaField`：外掛認領的鍵由外掛解析、接在登記的位置寫回、`obj.<attr>` 直接讀寫、建構子收關鍵字參數；
- `hooks.ParamGroup`：外掛的插入參數群組跟核心群組同一套解析／巨集合併／驗證／to_dict 順序／dataclasses.replace。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Iterator

import pytest

from aivc import hooks
from aivc.comp.params import InsertParams
from aivc.project import resolve as R
from aivc.project import schema as S

TESTS = Path(__file__).resolve().parent
REPO = TESTS.parents[1]
V1 = TESTS / "fixtures" / "project" / "v1"


@pytest.fixture(autouse=True)
def _no_plugins() -> Iterator[None]:
    with hooks.suspended():
        yield


def _fixtures() -> list[Path]:
    out = [V1 / "minimal.aivc.json", V1 / "captions.aivc.json", V1 / "broken.aivc.json"]
    return out


# ---------------------------------------------------------------- (a) 沒有外掛：外掛的鍵原樣、原位保存


@pytest.mark.parametrize("path", _fixtures(), ids=lambda p: p.name)
def test_foreign_keys_round_trip_verbatim_without_plugins(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    raw = json.loads(text)
    r = S.loads(text)
    out = json.loads(S.dumps(r.project))
    # 頂層：cardSlots／deck 原樣
    for key in ("cardSlots", "deck"):
        if key in raw:
            assert out[key] == raw[key], key
    raw_tracks = {t["id"]: t for ts in (raw.get("tracks") or {}).values() if isinstance(ts, list) for t in ts if isinstance(t, dict) and isinstance(t.get("id"), str) and t.get("id")}
    for ts in out["tracks"].values():
        for t in ts:
            src = raw_tracks[t["id"]]
            for key in ("slotId", "identity", "edgecard", "detections"):
                if key in src:
                    assert t[key] == src[key], (t["id"], key)  # 連指到不存在格位的 slotId 也不動
            if isinstance(src.get("options"), dict) and "templateCard" in src["options"]:
                assert t["options"]["templateCard"] == src["options"]["templateCard"]
            if isinstance(src.get("insert"), dict):
                for g in ("paperRatio", "flip", "print", "smoothing", "stack"):
                    if g in src["insert"]:
                        assert t["insert"][g] == src["insert"][g], (t["id"], g)
    for g in ("paperRatio", "flip", "print", "smoothing", "stack"):
        if g in (raw.get("insertDefaults") or {}):
            assert out["insertDefaults"][g] == raw["insertDefaults"][g], g
    # 再讀再寫逐位元相同（冪等）
    again = S.dumps(S.loads(S.dumps(r.project)).project)
    assert again == S.dumps(r.project)


@pytest.mark.parametrize("path", [p for p in _fixtures() if p.name == "captions.aivc.json"], ids=lambda p: p.name)
def test_canonical_files_are_byte_identical_without_plugins(path: Path) -> None:
    """TS／Python 寫出來的（鍵序是正規順序的）專案：沒有外掛也逐位元相同 —— 外掛的鍵留在原來的位置。"""
    text = path.read_text(encoding="utf-8")
    assert S.dumps(S.loads(text).project) == text


def test_unknown_keys_keep_their_place_and_new_ones_go_last() -> None:
    doc = {
        "schemaVersion": 1, "app": "ai-video-cut", "createdAt": "x", "updatedAt": "y", "media": [], "activeMediaId": None, "profile": "generic",
        "shots": {}, "tracks": {"m1": [{"id": "t", "shotId": "s", "label": "t", "kind": "planar", "futureMid": 1, "referenceFrame": None,
                                       "trackingRegion": None, "keyframes": [], "prompts": [], "adjust": {"points": [], "enabled": False},
                                       "options": {"method": "classic", "fut": 2, "motionModel": "perspective", "smoothing": 0.4}, "insert": None,
                                       "regionPolicy": "keepBarcode", "stale": False}]},
        "sectionA": {"a": 1}, "sectionB": [2], "insertDefaults": S.InsertV1.defaults().to_json(),
        "exportDefaults": S.ExportDefaultsV1().to_json(), "tail": True,
    }
    p = S.loads(json.dumps(doc)).project
    out = json.loads(S.dumps(p))
    assert list(out) == list(doc)  # 頂層：sectionA／sectionB 留在 tracks 後面、tail 在最後
    t = out["tracks"]["m1"][0]
    assert list(t) == list(doc["tracks"]["m1"][0])
    assert list(t["options"]) == list(doc["tracks"]["m1"][0]["options"])
    # 程式自己加的鍵沒有原位置 → 接在最後
    p.tracks["m1"][0].extra["added"] = 3
    p.extra["addedTop"] = 4
    out2 = json.loads(S.dumps(p))
    assert list(out2)[-1] == "addedTop" and list(out2["tracks"]["m1"][0])[-1] == "added"
    # 錨點那個鍵這次沒寫出來（captions 空 → 不寫）：往前找下一個還在的鍵
    doc2 = dict(doc)
    doc2 = {**{k: v for k, v in doc.items() if k != "tail"}}
    keys = list(doc2)
    i = keys.index("exportDefaults")
    reordered = {k: doc2[k] for k in keys[: i + 1]}
    reordered["captions"] = {}
    reordered["afterCaptions"] = 5
    out3 = json.loads(S.dumps(S.loads(json.dumps(reordered)).project))
    assert "captions" not in out3 and list(out3)[-1] == "afterCaptions"


def test_insert_dict_for_does_not_forward_unregistered_groups() -> None:
    """沒有外掛時 insert 的外掛群組（paperRatio／flip／print）不交給 InsertParams（否則「沒有欄位」）；smoothing 是核心的。"""
    t = S.TrackV1(id="t", shot_id="s")
    t.insert = S.InsertV1.from_json({"macro": "custom", "paperRatio": {"enabled": True}, "flip": {"faceDownStart": True}, "smoothing": {"fadeFrames": 4}}, lambda m: None, "t")
    project = S.ProjectFileV1()
    d = R.insert_dict_for(t, project)
    assert "paperRatio" not in d and "flip" not in d and d["smoothing"] == {"fadeFrames": 4}
    assert R.insert_params_for(t, project).smoothing.fade_frames == 4


# ---------------------------------------------------------------- hooks.SchemaField


def _schema_fields() -> list[hooks.SchemaField]:
    def parse_ref(raw: Any, present: bool, warn: Any, env: Any) -> Any:
        if raw is not None and not isinstance(raw, str):
            warn(f"{env.where}: fooRef 不是字串")
            return None
        return raw

    def parse_section(raw: Any, present: bool, warn: Any, env: Any) -> Any:
        return env.per_media(raw, "fooSection", lambda x, _mf: x if isinstance(x, dict) else None)

    return [
        hooks.SchemaField("track", "fooRef", "foo_ref", after="kind", parse=parse_ref, dump=lambda v: (v is not None, v), default=lambda: None),
        hooks.SchemaField("project", "fooSection", "foo_section", after="tracks", parse=parse_section, dump=lambda v: (True, v), default=dict, phase="early"),
        hooks.SchemaField("project", "fooLate", "foo_late", after="fooSection", parse=lambda raw, present, warn, env: raw if present else "dflt", dump=lambda v: (True, v), default=lambda: "dflt", phase="late"),
    ]


def test_schema_fields_parse_place_and_validate() -> None:
    for f in _schema_fields():
        hooks.add("schema-field", f, owner="test")
    seen: list[str] = []

    def check(track: Any, media_id: str, env: Any, warn: Any) -> None:
        seen.append(track.id)
        refs = {x.get("id") for x in env.ext["foo_section"].get(media_id, [])}
        if track.foo_ref is not None and track.foo_ref not in refs:
            warn(f"{track.id} 的 fooRef 不存在")
            track.foo_ref = None

    hooks.add("track-check", check, owner="test")
    doc = {
        "schemaVersion": 1, "app": "ai-video-cut", "createdAt": "x", "updatedAt": "y", "media": [{"id": "m1", "path": "a", "name": "a", "fingerprint": "", "probe": None, "proxy": None}],
        "activeMediaId": "m1", "profile": "generic", "shots": {"m1": [{"id": "s", "startFrame": 0, "endFrame": 5, "kind": "close", "source": "auto"}]},
        "tracks": {"m1": [{"id": "a", "shotId": "s", "fooRef": "r1"}, {"id": "b", "shotId": "s", "fooRef": "nope"}, {"id": "c", "shotId": "s", "fooRef": 3}]},
        "fooSection": {"m1": [{"id": "r1"}, "junk"]},
        "insertDefaults": S.InsertV1.defaults().to_json(), "exportDefaults": S.ExportDefaultsV1().to_json(),
    }
    r = S.loads(json.dumps(doc))
    p = r.project
    assert seen == ["a", "b", "c"]
    assert r.warnings == ["track c: fooRef 不是字串", "b 的 fooRef 不存在"]
    a, b, c = p.tracks["m1"]
    assert (a.foo_ref, b.foo_ref, c.foo_ref) == ("r1", None, None) and "fooRef" not in a.extra
    assert p.foo_section == {"m1": [{"id": "r1"}]} and p.foo_late == "dflt"
    out = json.loads(S.dumps(p))
    assert list(out)[list(out).index("tracks") + 1 : list(out).index("tracks") + 3] == ["fooSection", "fooLate"]
    ta = out["tracks"]["m1"][0]
    assert list(ta)[:5] == ["id", "shotId", "label", "kind", "fooRef"] and ta["fooRef"] == "r1"
    assert "fooRef" not in out["tracks"]["m1"][1]  # dump 說 None 不寫
    # 建構子收外掛欄位、屬性可讀寫、replace 帶著走、不認得的關鍵字照樣擲 TypeError
    t = S.TrackV1(id="n", shot_id="s", foo_ref="r1")
    assert t.foo_ref == "r1" and t.ext == {"foo_ref": "r1"}
    t.foo_ref = "r2"
    assert replace(t, label="x").foo_ref == "r2" and t.foo_ref == "r2"
    with pytest.raises(TypeError):
        S.TrackV1(id="n", shot_id="s", nope=1)
    with pytest.raises(AttributeError):
        _ = t.nope
    assert S.ProjectFileV1().foo_section == {}
    # 外掛不在了：同一份檔案的 fooRef／fooSection 又回到 extra，原樣原位
    with hooks.suspended():
        rr = S.loads(json.dumps(doc))
        assert rr.project.tracks["m1"][2].extra["fooRef"] == 3 and rr.project.extra["fooSection"] == doc["fooSection"]


# ---------------------------------------------------------------- hooks.ParamGroup


@dataclass(frozen=True)
class FooParams:
    enabled: bool = False
    level: float = 0.5
    mode: str = "a"


def _validate_foo(obj: FooParams) -> None:
    if obj.enabled not in (True, False):
        raise ValueError(f"FooParams.enabled={obj.enabled!r} 必須是 true/false")


def test_param_group_behaves_like_a_core_group() -> None:
    hooks.add("param-group", hooks.ParamGroup("foo_bar", FooParams, "fooBar", enums={"mode": ("a", "b")}, ranges={"level": (0.0, 1.0)}, validate=_validate_foo), owner="test")
    p = InsertParams()
    assert p.foo_bar == FooParams() and p.group("foo_bar") == FooParams() and p.group("nope") is None
    d = p.to_dict()
    assert list(d)[-2:] == ["foo_bar", "region_policy"] and d["foo_bar"] == {"enabled": False, "level": 0.5, "mode": "a"}
    q = InsertParams.from_dict({"fooBar": {"enabled": "on", "level": 0.75, "mode": "b"}, "opacity": 90})
    assert q.foo_bar == FooParams(True, 0.75, "b") and q.comp.opacity == pytest.approx(0.9) and q.macro == "custom"
    # 巨集合併保留外掛群組
    assert InsertParams.from_macro("full", q).foo_bar == q.foo_bar
    # dataclasses.replace 認得外掛群組
    r = replace(q, foo_bar=replace(q.foo_bar, level=0.1))
    assert r.foo_bar.level == 0.1 and q.foo_bar.level == 0.75 and r.comp == q.comp
    with pytest.raises(TypeError):
        replace(q, not_a_group=1)
    # 驗證：enum、範圍、整體規則、未知欄位、不是物件
    for bad, msg in (
        ({"fooBar": {"mode": "c"}}, "FooParams.mode='c' 不合法"),
        ({"fooBar": {"level": 2}}, "FooParams.level=2 超出範圍"),
        ({"fooBar": {"enabled": "maybe"}}, "FooParams.enabled='maybe' 必須是 true/false"),
        ({"fooBar": {"nope": 1}}, "FooParams 沒有欄位 'nope'"),
        ({"fooBar": 3}, "InsertParams.foo_bar 必須是物件（群組）"),
    ):
        with pytest.raises(ValueError) as ei:
            InsertParams.from_dict(bad)
        assert msg in str(ei.value), (bad, str(ei.value))
    # 「沒有欄位」的可用清單含外掛群組
    with pytest.raises(ValueError) as ei:
        InsertParams.from_dict({"zzz": {"a": 1}})
    assert "foo_bar" in str(ei.value)
    # forward=True 的群組由 insert_dict_for 從 insert.extra 交過去
    t = S.TrackV1(id="t", shot_id="s")
    t.insert = S.InsertV1.from_json({"macro": "custom", "fooBar": {"level": 0.2}}, lambda m: None, "t")
    assert R.insert_params_for(t, S.ProjectFileV1()).foo_bar.level == 0.2


def test_param_group_unregistered_is_an_unknown_key() -> None:
    with pytest.raises(AttributeError):
        _ = InsertParams().foo_bar
    with pytest.raises(ValueError):
        InsertParams.from_dict({"fooBar": {"level": 0.2}})
    with pytest.raises(TypeError):
        InsertParams(foo_bar=FooParams())
