"""ops/seg：CLI 參數解析（純函式，不碰 GPU／影片）＋ 註冊表可載入。"""
from __future__ import annotations

import pytest

from aivc.ops import CLI_INDEX, REGISTRY, OpError, load_all
from aivc.ops.seg import build_request, parse_box, parse_point, parse_range


def test_registered() -> None:
    load_all()
    assert "seg.run" in REGISTRY and CLI_INDEX["seg"].name == "seg.run"
    assert REGISTRY["seg.run"].gpu is True


def test_parse_range() -> None:
    assert parse_range("891:991") == (891, 991)
    for bad in ("891", "10:5", "-1:5", "a:b", "5:5"):
        with pytest.raises(OpError) as ei:
            parse_range(bad)
        assert ei.value.kind == "Invalid"


def test_parse_box() -> None:
    assert parse_box("10,20,30.5,40") == (10.0, 20.0, 30.5, 40.0)
    for bad in ("1,2,3", "1,2,0,4", "1,2,3,-4", "x,y,w,h"):
        with pytest.raises(OpError):
            parse_box(bad)


def test_parse_point() -> None:
    assert parse_point("930:400,600:add") == (1, 930, 400.0, 600.0, 1)
    assert parse_point("2=930:400.5,600:reduce") == (2, 930, 400.5, 600.0, 0)
    assert parse_point("3=1:0,0:1") == (3, 1, 0.0, 0.0, 1)
    for bad in ("930:400,600", "930:400,600:maybe", "x=930:400,600:add", "0=930:400,600:add", "930:400:add"):
        with pytest.raises(OpError):
            parse_point(bad)


def test_build_request_boxes_only_anchor_defaults_to_k0() -> None:
    r = build_request({"frames": "100:200", "box": ["1,2,3,4", "5,6,7,8"], "point": [], "dir": "fwd"})
    assert r.anchor == 100 and r.object_ids == [1, 2] and r.direction == "fwd"
    assert r.boxes[2] == (5.0, 6.0, 7.0, 8.0)


def test_build_request_points_set_anchor_and_merge_with_box() -> None:
    r = build_request({"frames": "100:200", "box": ["1,2,3,4"], "point": ["150:9,9:add", "1=150:1,1:reduce", "2=150:5,5:add"]})
    assert r.anchor == 150
    assert r.points[1] == [(9.0, 9.0, 1), (1.0, 1.0, 0)]
    assert r.points[2] == [(5.0, 5.0, 1)]
    assert r.object_ids == [1, 2]
    assert r.direction == "both"


def test_build_request_rejections() -> None:
    with pytest.raises(OpError):
        build_request({"frames": "100:200", "box": [], "point": []})  # 沒提示
    with pytest.raises(OpError):
        build_request({"frames": "100:200", "box": [], "point": ["120:1,1:add", "130:1,1:add"]})  # 多幀提示
    with pytest.raises(OpError):
        build_request({"frames": "100:200", "box": ["1,2,3,4"], "point": [], "anchor": 250})  # 錨定出界
    with pytest.raises(OpError):
        build_request({"frames": "100:200", "box": [], "point": ["120:1,1:add"], "anchor": 121})  # anchor 與點不合
