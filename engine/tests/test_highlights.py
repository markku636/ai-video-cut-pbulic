"""AI 精華片段（ops/highlights.py）。

跟章節同一個測法：模型講什麼不管，管的是我們怎麼把它講的變成安全的片段——
起訖缺一個、終點在起點前、太短、太長、重疊、超過數量、整份不是 JSON。
"""

from __future__ import annotations

import http.server
import json
import threading
from typing import Any

import pytest

from aivc.ops import OpError
from aivc.ops import highlights as H
from tests.test_chapters import FPS, N_FRAMES, TRACK, Ctx


class _FakeLLM(http.server.BaseHTTPRequestHandler):
    reply: str = "{}"
    last_request: dict[str, Any] = {}

    def log_message(self, *a) -> None:  # noqa: ANN002
        pass

    def _send(self, obj: dict) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        self._send({"data": [{"id": "fake-model"}]})

    def do_POST(self) -> None:  # noqa: N802
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])).decode("utf-8"))
        type(self).last_request = req
        self._send({"choices": [{"message": {"content": type(self).reply}}]})


@pytest.fixture
def fake_llm():  # noqa: ANN201
    _FakeLLM.reply = "{}"
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _FakeLLM)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/v1"
    srv.shutdown()


class TestParse:
    def test_正常_依分數排序(self) -> None:
        obj = {"clips": [{"start": 0, "end": 20, "title": "a", "reason": "r", "score": 6}, {"start": 30, "end": 61, "title": "b", "score": 9}]}
        clips, w = H.parse_clips(obj, 90, 15, 60, 5)
        assert [c["title"] for c in clips] == ["b", "a"] and clips[0]["score"] == 9 and clips[1]["reason"] == "r" and w == []

    def test_缺起訖_終點在前_丟掉(self) -> None:
        obj = {"clips": [{"start": 0, "title": "沒終點"}, {"start": 40, "end": 20, "title": "倒過來"}, {"start": 0, "end": 20, "title": "好的"}]}
        clips, w = H.parse_clips(obj, 90, 15, 60, 5)
        assert [c["title"] for c in clips] == ["好的"] and len(w) == 2

    def test_太短丟掉_太長截到上限(self) -> None:
        obj = {"clips": [{"start": 0, "end": 3, "title": "太短"}, {"start": 0, "end": 200, "title": "太長"}]}
        clips, w = H.parse_clips(obj, 300, 15, 60, 5)
        assert len(clips) == 1 and clips[0]["title"] == "太長" and clips[0]["end"] == 60
        assert any("太短" in x for x in w) and any("截到 60" in x for x in w)

    def test_終點夾在影片長度內(self) -> None:
        clips, _ = H.parse_clips({"clips": [{"start": 60, "end": 500, "title": "a"}]}, 90, 15, 60, 5)
        assert clips[0]["end"] == 90

    def test_重疊只留分數高的(self) -> None:
        obj = {"clips": [{"start": 0, "end": 30, "title": "低", "score": 4}, {"start": 10, "end": 40, "title": "高", "score": 9}, {"start": 50, "end": 80, "title": "另一段", "score": 5}]}
        clips, w = H.parse_clips(obj, 90, 15, 60, 5)
        assert [c["title"] for c in clips] == ["高", "另一段"] and any("重疊" in x for x in w)

    def test_只留前_count_段(self) -> None:
        obj = {"clips": [{"start": i * 20, "end": i * 20 + 18, "title": str(i), "score": 10 - i} for i in range(6)]}
        clips, w = H.parse_clips(obj, 300, 15, 60, 3)
        assert len(clips) == 3 and "只留前 3 段" in w[-1]

    def test_分數壞掉當_5_並夾在_1到10(self) -> None:
        obj = {"clips": [{"start": 0, "end": 20, "title": "a", "score": "x"}, {"start": 30, "end": 50, "title": "b", "score": 99}]}
        clips, _ = H.parse_clips(obj, 90, 15, 60, 5)
        assert {c["title"]: c["score"] for c in clips} == {"a": 5.0, "b": 10.0}

    @pytest.mark.parametrize("bad", [None, "x", [], {"clips": "no"}, {"clips": [1, None]}])
    def test_壞輸入不炸(self, bad: Any) -> None:
        clips, w = H.parse_clips(bad, 90, 15, 60, 5)
        assert clips == [] and w


class TestSnap:
    def test_起點吸段起點_終點吸段終點(self) -> None:
        out = H.snap_clips([{"start": 31.0, "end": 58.5, "title": "a"}], [0, 5, 30, 41, 61, 80], [5, 20, 40, 60, 80, 90])
        assert out[0]["start"] == 30 and out[0]["end"] == 60

    def test_吸反了就退回(self) -> None:
        out = H.snap_clips([{"start": 29.0, "end": 31.0, "title": "a"}], [30], [30])
        assert out[0]["start"] == 29.0 and out[0]["end"] == 31.0

    def test_chars_per_second(self) -> None:
        # 第一段 0–5 s 有 10 個字；只看 0–5 s → 2.0 字/秒；看 0–10 s 加上第二段前三分之一（8 個字 × 5/15）
        assert H.chars_per_second(TRACK["cues"], FPS, 0, 5) == 2.0
        assert H.chars_per_second(TRACK["cues"], FPS, 0, 10) == round((10 + 8 * (5 / 15)) / 10, 2)
        assert H.chars_per_second(TRACK["cues"], FPS, 5, 5) == 0.0


class TestOp:
    @pytest.fixture(autouse=True)
    def _stub_load(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(H, "_load", lambda args, ctx: (TRACK, FPS, N_FRAMES))

    def test_端到端(self, fake_llm: str) -> None:
        _FakeLLM.reply = '{"clips":[{"start":31,"end":58,"title":"看牌路下注","reason":"有策略","score":8},{"start":"0:00","end":"0:19","title":"開場","reason":"鉤子","score":6}]}'
        ctx = Ctx()
        r = H.highlights_op({"project": "x", "endpoint": fake_llm, "min_len": 10}, ctx)
        assert [c["title"] for c in r["clips"]] == ["看牌路下注", "開場"]
        # 31→30（段起點）、58→60（段終點）；0:19→20
        assert (r["clips"][0]["start"], r["clips"][0]["end"]) == (30.0, 60.0)
        assert (r["clips"][0]["startFrame"], r["clips"][0]["endFrame"]) == (900, 1800)
        assert (r["clips"][1]["start"], r["clips"][1]["end"]) == (0.0, 20.0)
        assert r["clips"][0]["cps"] > 0 and r["model"] == "fake-model" and r["warnings"] == []
        assert "2 段精華" in r["_human"]
        req = _FakeLLM.last_request
        assert "10–60 秒" in req["messages"][0]["content"] and req["messages"][1]["content"].startswith("[0:00]")

    def test_影片比最短段還短就擋下(self, fake_llm: str) -> None:
        with pytest.raises(OpError) as e:
            H.highlights_op({"project": "x", "endpoint": fake_llm, "min_len": 500}, Ctx())
        assert "比每段最短" in str(e.value)

    def test_模型不回_JSON(self, fake_llm: str) -> None:
        _FakeLLM.reply = "都很精彩"
        with pytest.raises(OpError) as e:
            H.highlights_op({"project": "x", "endpoint": fake_llm}, Ctx())
        assert "JSON" in str(e.value)

    def test_一段都不能用就報錯附警告(self, fake_llm: str) -> None:
        _FakeLLM.reply = '{"clips":[{"start":0,"end":2,"title":"太短"}]}'
        with pytest.raises(OpError) as e:
            H.highlights_op({"project": "x", "endpoint": fake_llm}, Ctx())
        assert "太短" in e.value.hint
