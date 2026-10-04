"""文字提示 → 框（seg/text_box.py）的純邏輯：片語解析、後處理結果轉成 seg.run 要的框、排序與過濾。

模型推論本身不在這裡測（要 600 MB 權重）；這個檔釘的是「模型吐出東西之後我們怎麼解讀它」，
那才是會靜靜出錯的部分：框的座標系換錯、片語對錯物件、退化框餵進 SAM 變成空遮罩。
"""

from __future__ import annotations

import pytest

from aivc.seg.backend import SegModelError
from aivc.seg.text_box import DEFAULT_MAX_BOXES, MODEL_IDS, boxes_from_detection, load, parse_phrases


class TestParsePhrases:
    def test_逗號與換行都當分隔符(self) -> None:
        assert parse_phrases("牌, 手") == ["牌", "手"]
        assert parse_phrases("牌，手") == ["牌", "手"]  # 全形逗號
        assert parse_phrases("牌、手") == ["牌", "手"]  # 頓號
        assert parse_phrases("牌\n手") == ["牌", "手"]

    def test_去空白與空項(self) -> None:
        assert parse_phrases("  牌  ,, , 手 ") == ["牌", "手"]
        assert parse_phrases("") == []
        assert parse_phrases("  ,  ") == []

    def test_保留輸入順序並去重(self) -> None:
        # 順序就是 seg.run 的物件 id 1..n：重排會讓同一句話在不同次執行對到不同物件
        assert parse_phrases("手, 牌, 手") == ["手", "牌"]


class TestBoxesFromDetection:
    phrases = ["牌", "手"]

    def test_座標從_xyxy_換成_xywh(self) -> None:
        r = {"scores": [0.9], "labels": [0], "boxes": [[10.0, 20.0, 40.0, 60.0]]}
        out = boxes_from_detection(r, self.phrases)
        assert len(out) == 1
        assert out[0].box == (10.0, 20.0, 30.0, 40.0)  # w = 40−10、h = 60−20
        assert out[0].phrase == "牌"
        assert out[0].score == pytest.approx(0.9)

    def test_依分數由高到低排(self) -> None:
        r = {
            "scores": [0.3, 0.9, 0.6],
            "labels": [0, 1, 0],
            "boxes": [[0, 0, 10, 10], [1, 1, 11, 11], [2, 2, 12, 12]],
        }
        assert [b.score for b in boxes_from_detection(r, self.phrases)] == pytest.approx([0.9, 0.6, 0.3])

    def test_退化的框丟掉(self) -> None:
        # 邊長 0 的框餵給 SAM 會變成空遮罩，比「沒偵測到」更難查
        r = {"scores": [0.9, 0.8], "labels": [0, 0], "boxes": [[10, 10, 10, 30], [0, 0, 20, 20]]}
        out = boxes_from_detection(r, self.phrases)
        assert [b.box for b in out] == [(0.0, 0.0, 20.0, 20.0)]

    def test_超出上限就截斷(self) -> None:
        n = DEFAULT_MAX_BOXES + 5
        r = {"scores": [0.5] * n, "labels": [0] * n, "boxes": [[0, 0, 10, 10]] * n}
        assert len(boxes_from_detection(r, self.phrases)) == DEFAULT_MAX_BOXES
        assert len(boxes_from_detection(r, self.phrases, max_boxes=2)) == 2

    def test_標籤超出範圍不炸掉(self) -> None:
        # 模型或版本不合時標籤可能對不上片語；整批炸掉比記成 "?" 更糟
        r = {"scores": [0.9], "labels": [99], "boxes": [[0, 0, 10, 10]]}
        assert boxes_from_detection(r, self.phrases)[0].phrase == "?"

    def test_空結果與缺欄位(self) -> None:
        assert boxes_from_detection({}, self.phrases) == []
        assert boxes_from_detection({"boxes": [[0, 0, 10, 10]]}, self.phrases)[0].score == 0.0

    def test_格式不對的框略過(self) -> None:
        r = {"scores": [0.9, 0.8], "labels": [0, 0], "boxes": [[1, 2, 3], [0, 0, 10, 10]]}
        assert len(boxes_from_detection(r, self.phrases)) == 1


class TestLoad:
    def test_未知變體立刻擲錯而不是去下載(self) -> None:
        with pytest.raises(SegModelError) as e:
            load("不存在的變體")
        assert e.value.kind == "Invalid"
        assert "base" in str(e.value)

    def test_模型表不是空的(self) -> None:
        assert "base" in MODEL_IDS
        assert all(v.startswith("google/owlv2") for v in MODEL_IDS.values())
