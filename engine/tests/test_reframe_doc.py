"""裁切路徑的檔案格式（reframe/doc.py）：往返精確、壞檔的錯誤訊息要指得出問題在哪。

這是**跨行程**的邊界（規劃寫、渲染讀），所以壞檔的每一種形狀都要有自己的訊息：
「段沒鋪滿」跟「段重疊」的修法完全不同，錯誤訊息混在一起等於沒說。
"""

from __future__ import annotations

import json

import pytest

from aivc.reframe.doc import VERSION, from_doc, to_doc
from aivc.reframe.path import Box, ReframeError, ReframeOptions, plan_path, static_path

HD = (1920, 1080)


def _moving() -> object:
    boxes = [[Box(100 + i * 30, 400, 120, 280)] for i in range(40)]
    return plan_path(boxes, HD, 30, ReframeOptions())


class TestRoundTrip:
    def test_往返逐格相同(self) -> None:
        p = _moving()
        assert from_doc(to_doc(p)) == p  # type: ignore[arg-type]

    def test_靜態路徑往返(self) -> None:
        p = static_path(HD, 50, ReframeOptions())
        back = from_doc(to_doc(p))
        assert back == p and len(to_doc(p)["segments"]) == 1

    def test_空路徑往返(self) -> None:
        p = plan_path([], HD, 30, ReframeOptions())
        assert from_doc(to_doc(p)) == p

    def test_真的能過_json(self) -> None:
        # 到處都是 tuple，忘了轉 list 會在 json.dumps 才炸，而那時已經跑完偵測了
        p = _moving()
        assert from_doc(json.loads(json.dumps(to_doc(p), ensure_ascii=False))) == p  # type: ignore[arg-type]

    def test_壓成段之後小很多(self) -> None:
        p = static_path(HD, 5000, ReframeOptions())
        assert len(to_doc(p)["segments"]) == 1  # 5000 幀 → 一段


class TestMeta:
    def test_附註與_fps(self) -> None:
        d = to_doc(static_path(HD, 3, ReframeOptions()), fps=(30000, 1001), meta={"text": "person", "every": 6})
        assert d["fps"] == [30000, 1001]
        assert d["meta"]["text"] == "person"

    def test_沒給就是_none_與空字典(self) -> None:
        d = to_doc(static_path(HD, 3, ReframeOptions()))
        assert d["fps"] is None and d["meta"] == {}


class TestBadDoc:
    def test_版本不合(self) -> None:
        d = to_doc(_moving())  # type: ignore[arg-type]
        d["version"] = VERSION + 1
        with pytest.raises(ReframeError, match="版本"):
            from_doc(d)

    def test_缺欄位(self) -> None:
        d = to_doc(_moving())  # type: ignore[arg-type]
        del d["segments"]
        with pytest.raises(ReframeError, match="缺欄位"):
            from_doc(d)

    def test_段不連續(self) -> None:
        d = to_doc(static_path(HD, 10, ReframeOptions()))
        d["segments"] = [[0, 4, 0, 0], [6, 10, 0, 0]]
        with pytest.raises(ReframeError, match="只鋪到"):
            from_doc(d)

    def test_段重疊(self) -> None:
        d = to_doc(static_path(HD, 10, ReframeOptions()))
        d["segments"] = [[0, 6, 0, 0], [4, 10, 0, 0]]
        with pytest.raises(ReframeError, match="只鋪到"):
            from_doc(d)

    def test_段沒鋪滿(self) -> None:
        d = to_doc(static_path(HD, 10, ReframeOptions()))
        d["segments"] = [[0, 4, 0, 0]]
        with pytest.raises(ReframeError, match="frames 是"):
            from_doc(d)

    def test_反向或空段(self) -> None:
        d = to_doc(static_path(HD, 10, ReframeOptions()))
        d["segments"] = [[0, 0, 0, 0]]
        with pytest.raises(ReframeError, match="空的或反向"):
            from_doc(d)

    def test_段裡不是數字(self) -> None:
        d = to_doc(static_path(HD, 10, ReframeOptions()))
        d["segments"] = [["a", 10, 0, 0]]
        with pytest.raises(ReframeError, match="第 0 段"):
            from_doc(d)

    def test_根本不是物件(self) -> None:
        with pytest.raises(ReframeError):
            from_doc([1, 2, 3])  # type: ignore[arg-type]
