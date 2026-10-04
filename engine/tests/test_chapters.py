"""AI 章節與摘要（ops/chapters.py）。

重點不是模型講什麼（那是它的事），是**我們怎麼把它講的東西變成安全的章節**：
秒數寫成字串或 mm:ss、超出影片長度、沒排序、擠在一起、第一章不在 0、整份不是 JSON ——
每一種都要不炸、而且講得出來哪裡被修掉了。
"""

from __future__ import annotations

import http.server
import json
import threading
from typing import Any

import pytest

from aivc.ops import OpError
from aivc.ops import chapters as C


class Ctx:
    def __init__(self) -> None:
        self.logs: list[tuple[str, str]] = []

    def progress(self, stage: str, done: float, total: float, **extra: object) -> None:
        pass

    def log(self, level: str, message: str) -> None:
        self.logs.append((level, message))

    def check_cancel(self) -> None:
        pass

    def artifact(self, path: str, kind: str = "") -> None:
        pass


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


def _cue(i: int, k0: int, k1: int, *words: str) -> dict[str, Any]:
    n = max(1, len(words))
    step = (k1 - k0) / n
    return {
        "id": f"c{i}",
        "startFrame": k0,
        "endFrame": k1,
        "words": [{"text": w, "startFrame": int(k0 + j * step), "endFrame": int(k0 + (j + 1) * step)} for j, w in enumerate(words)],
    }


#: 30 fps、90 秒：三段話題，換話題的段在 30 s 與 61 s。
TRACK = {
    "language": "zh-TW",
    "cues": [
        _cue(0, 0, 150, "大家好", "今天", "來聊", "百家姓"),
        _cue(1, 150, 600, "規則", "很簡單", "比大小"),
        _cue(2, 900, 1200, "接下來", "講", "策略"),
        _cue(3, 1230, 1800, "看牌路", "下注"),
        _cue(4, 1830, 2400, "最後", "總結", "一下"),
        _cue(5, 2400, 2700, "謝謝", "收看"),
    ],
}
FPS = 30.0
N_FRAMES = 2700


class TestPure:
    def test_transcript_lines_把字接起來並依時間排序(self) -> None:
        lines = C.transcript_lines(list(reversed(TRACK["cues"])), FPS)
        assert lines[0] == (0.0, "大家好今天來聊百家姓")
        assert [s for s, _ in lines] == [0.0, 5.0, 30.0, 41.0, 61.0, 80.0]

    def test_transcript_lines_英文用空白接(self) -> None:
        lines = C.transcript_lines([_cue(0, 0, 30, "hello", "world")], FPS)
        assert lines[0][1] == "hello world"

    def test_compact_短的原樣送(self) -> None:
        text = C.compact_transcript(C.transcript_lines(TRACK["cues"], FPS))
        assert text.startswith("[0:00] 大家好今天來聊百家姓\n[0:05] 規則很簡單比大小")
        assert "[1:20] 謝謝收看" in text

    def test_compact_太長就合併成窗口而且不超過預算(self) -> None:
        lines = [(float(i), "這是第%d段講了很多很多字" % i * 3) for i in range(2000)]
        text = C.compact_transcript(lines, budget=6000, window_chars=40)
        assert len(text) <= 6000
        assert text.startswith("[0:00] ")
        # 窗口保留第一個時間碼、文字被截
        assert "…" in text

    def test_mmss(self) -> None:
        assert C.mmss(0) == "0:00" and C.mmss(65) == "1:05" and C.mmss(3661) == "1:01:01" and C.mmss(59.6) == "1:00"

    def test_system_prompt_講長度語言與上限(self) -> None:
        p = C.system_prompt(600, "en", 12, 20)
        assert "600 秒" in p and "English" in p and "20 秒" in p and "JSON" in p
        assert "最多 12 章" in p
        # 短片不會要求 12 章
        assert "最多 3 章" in C.system_prompt(61, "zh-TW", 12, 20)

    def test_lang_name(self) -> None:
        assert C.lang_name("zh-TW") == "台灣繁體中文" and C.lang_name("en") == "English" and C.lang_name("en-US") == "English"
        assert C.lang_name("fr") == "fr" and C.lang_name(None) == "台灣繁體中文"


class TestParse:
    def test_正常(self) -> None:
        obj = {"title": "百家姓入門", "summary": "講規則與策略。", "keywords": ["百家姓", "策略"], "chapters": [{"start": 0, "title": "開場"}, {"start": 30, "title": "策略"}, {"start": 61, "title": "總結"}]}
        ch, rest, w = C.parse_chapters(obj, 90, 20, 12)
        assert [c["start"] for c in ch] == [0, 30, 61] and [c["title"] for c in ch] == ["開場", "策略", "總結"]
        assert rest == {"title": "百家姓入門", "summary": "講規則與策略。", "keywords": ["百家姓", "策略"]} and w == []

    def test_秒數寫成字串或_mmss_都收(self) -> None:
        obj = {"chapters": [{"start": "0"}, {"start": "0:30", "title": "a"}, {"start": "1:01.5", "title": "b"}]}
        ch, _, _ = C.parse_chapters(obj, 90, 20, 12)
        assert [c["start"] for c in ch] == [0.0, 30.0, 61.5]

    def test_超出影片長度與負數丟掉並警告(self) -> None:
        obj = {"chapters": [{"start": 0, "title": "a"}, {"start": 500, "title": "太遠"}, {"start": -3, "title": "負的"}]}
        ch, _, w = C.parse_chapters(obj, 90, 20, 12)
        assert [c["title"] for c in ch] == ["a"] and len(w) == 2 and "太遠" in w[0] and "負的" in w[1]

    def test_沒排序會排好(self) -> None:
        obj = {"chapters": [{"start": 61, "title": "c"}, {"start": 0, "title": "a"}, {"start": 30, "title": "b"}]}
        ch, _, _ = C.parse_chapters(obj, 90, 20, 12)
        assert [c["title"] for c in ch] == ["a", "b", "c"]

    def test_擠在一起的只留前一章(self) -> None:
        obj = {"chapters": [{"start": 0, "title": "a"}, {"start": 30, "title": "b"}, {"start": 35, "title": "b2"}, {"start": 61, "title": "c"}]}
        ch, _, w = C.parse_chapters(obj, 90, 20, 12)
        assert [c["title"] for c in ch] == ["a", "b", "c"] and any("b2" in x for x in w)

    def test_第一章不在_0_而且很近就吸到_0(self) -> None:
        ch, _, w = C.parse_chapters({"chapters": [{"start": 4, "title": "a"}, {"start": 40, "title": "b"}]}, 90, 20, 12)
        assert ch[0]["start"] == 0 and ch[0]["title"] == "a" and w == []

    def test_第一章離_0_很遠就補一章開場(self) -> None:
        ch, _, w = C.parse_chapters({"chapters": [{"start": 40, "title": "b"}]}, 90, 20, 12)
        assert ch[0] == {"start": 0.0, "title": ""} and ch[1]["title"] == "b" and "開場" in w[0]

    def test_超過上限只留前面幾章(self) -> None:
        obj = {"chapters": [{"start": i * 25, "title": str(i)} for i in range(10)]}
        ch, _, w = C.parse_chapters(obj, 300, 20, 4)
        assert len(ch) == 4 and "10 章" in w[-1]

    @pytest.mark.parametrize("bad", [None, [], "字串", 3, {"chapters": "不是陣列"}, {"chapters": [3, "x", None]}, {"chapters": [{"title": "沒有秒數"}]}])
    def test_壞輸入不炸(self, bad: Any) -> None:
        ch, rest, w = C.parse_chapters(bad, 90, 20, 12)
        assert ch == [] and w

    def test_標題去標點截長度(self) -> None:
        ch, rest, _ = C.parse_chapters({"title": "  很長的標題。", "chapters": [{"start": 0, "title": "「開場」！"}, {"start": 30, "title": "x" * 100}]}, 90, 20, 12)
        assert ch[0]["title"] == "開場" and len(ch[1]["title"]) == C.TITLE_MAX and rest["title"] == "很長的標題"

    def test_keywords_不是陣列就當沒有(self) -> None:
        _, rest, _ = C.parse_chapters({"keywords": "a,b", "chapters": [{"start": 0, "title": "a"}]}, 90, 20, 12)
        assert rest["keywords"] == []


class TestSnap:
    def test_吸到最近的字幕段起點(self) -> None:
        ch = [{"start": 0.0, "title": "a"}, {"start": 31.5, "title": "b"}, {"start": 70.0, "title": "c"}]
        out = C.snap_to_cues(ch, [0, 5, 30, 41, 61, 80], tol_s=3)
        assert [c["start"] for c in out] == [0.0, 30, 70.0]  # 70 離 61 / 80 都超過容忍 → 保留

    def test_第一章永遠_0(self) -> None:
        out = C.snap_to_cues([{"start": 2.0, "title": "a"}], [0, 5])
        assert out[0]["start"] == 0.0

    def test_吸完撞在一起就退回原值(self) -> None:
        ch = [{"start": 0.0, "title": "a"}, {"start": 29.0, "title": "b"}, {"start": 31.0, "title": "c"}]
        out = C.snap_to_cues(ch, [0, 30], tol_s=3)
        assert out[1]["start"] == 30 and out[2]["start"] == 31.0

    def test_youtube_text(self) -> None:
        assert C.youtube_text([{"start": 0, "title": "開場"}, {"start": 65, "title": ""}]) == "0:00 開場\n1:05 —"


class TestOp:
    @pytest.fixture(autouse=True)
    def _stub_load(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(C, "_load", lambda args, ctx: (TRACK, FPS, N_FRAMES))

    def test_端到端(self, fake_llm: str) -> None:
        _FakeLLM.reply = '```json\n{"title":"百家姓入門","summary":"三段。","keywords":["百家姓"],"chapters":[{"start":0,"title":"開場"},{"start":31,"title":"策略"},{"start":"1:02","title":"總結"}]}\n```'
        ctx = Ctx()
        r = C.chapters_op({"project": "x.aivc.json", "endpoint": fake_llm}, ctx)
        assert [c["title"] for c in r["chapters"]] == ["開場", "策略", "總結"]
        # 31 → 吸到字幕段 30 s；1:02 → 吸到 61 s；幀數 = 秒 × 30
        assert [c["seconds"] for c in r["chapters"]] == [0.0, 30.0, 61.0]
        assert [c["frame"] for c in r["chapters"]] == [0, 900, 1830]
        assert r["youtube"] == "0:00 開場\n0:30 策略\n1:01 總結"
        assert r["title"] == "百家姓入門" and r["summary"] == "三段。" and r["keywords"] == ["百家姓"]
        assert r["model"] == "fake-model" and r["language"] == "zh-TW" and r["warnings"] == []
        assert "3 章" in r["_human"]
        # 送出去的：system 講長度與語言、user 是逐字稿、溫度 0
        req = _FakeLLM.last_request
        assert req["temperature"] == 0 and "90 秒" in req["messages"][0]["content"] and "台灣繁體中文" in req["messages"][0]["content"]
        assert req["messages"][1]["content"].startswith("[0:00] 大家好")

    def test_語言可以覆寫(self, fake_llm: str) -> None:
        _FakeLLM.reply = '{"chapters":[{"start":0,"title":"Intro"}]}'
        r = C.chapters_op({"project": "x", "endpoint": fake_llm, "language": "en"}, Ctx())
        assert r["language"] == "en" and "English" in _FakeLLM.last_request["messages"][0]["content"]

    def test_模型不回_JSON_就講人話(self, fake_llm: str) -> None:
        _FakeLLM.reply = "我覺得這支影片很棒"
        with pytest.raises(OpError) as e:
            C.chapters_op({"project": "x", "endpoint": fake_llm}, Ctx())
        assert "JSON" in str(e.value) and "我覺得" in e.value.hint

    def test_模型一章都沒給就報錯並附警告(self, fake_llm: str) -> None:
        _FakeLLM.reply = '{"chapters":[{"start":999,"title":"太遠"}]}'
        with pytest.raises(OpError) as e:
            C.chapters_op({"project": "x", "endpoint": fake_llm}, Ctx())
        assert "章節" in str(e.value) and "太遠" in e.value.hint

    def test_警告會進_log_與結果(self, fake_llm: str) -> None:
        _FakeLLM.reply = '{"chapters":[{"start":40,"title":"b"}]}'
        ctx = Ctx()
        r = C.chapters_op({"project": "x", "endpoint": fake_llm}, ctx)
        assert r["chapters"][0]["title"] == "" and r["warnings"] and ctx.logs[0][0] == "warn"

    def test_沒有端點(self) -> None:
        with pytest.raises(OpError):
            C.chapters_op({"project": "x", "endpoint": ""}, Ctx())

    def test_連不上(self) -> None:
        with pytest.raises(OpError) as e:
            C.chapters_op({"project": "x", "endpoint": "http://127.0.0.1:9/v1", "timeout": 2}, Ctx())
        assert "連不上" in str(e.value)

    def test_逾時要講沒回應_不是連不上(self) -> None:
        # 實測：模型忙著處理上一個請求時 /models 通、chat 卻等到逾時；「連不上」會讓人去檢查網路
        import time

        class Slow(_FakeLLM):
            def do_POST(self) -> None:  # noqa: N802
                time.sleep(3)
                super().do_POST()

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Slow)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            with pytest.raises(OpError) as e:
                C.chapters_op({"project": "x", "endpoint": f"http://127.0.0.1:{srv.server_address[1]}/v1", "timeout": 1}, Ctx())
            assert "沒有回應" in str(e.value) and "1 秒" in str(e.value)
        finally:
            srv.shutdown()

    def test_format_result_text(self) -> None:
        txt = C.format_result_text({"title": "T", "summary": "S", "keywords": ["a", "b"], "youtube": "0:00 x"})
        assert txt == "標題：T\n摘要：S\n關鍵字：a、b\n0:00 x"
