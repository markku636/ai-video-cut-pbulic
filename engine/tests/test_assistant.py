"""AI 助手的對話 op（ops/assistant.py）。

這支只做一件事：把話送到 LLM 端點、把文字帶回來。所以測的重點是
**壞掉的時候講不講得出人話**（連不上、沒有模型、回空的、缺金鑰），
以及**金鑰絕對不會出現在結果或錯誤訊息裡**。
"""

from __future__ import annotations

import http.server
import json
import threading
from typing import Any

import pytest

from aivc.ops import OpError
from aivc.ops.assistant import anthropic_text, assistant_chat, assistant_models, openai_text, parse_messages


class Ctx:
    """Ctx 是 Protocol、不能實體化；測試自己給一個最小的（同 test_asr.py）。"""

    def progress(self, stage: str, done: float, total: float, **extra: object) -> None:
        pass

    def log(self, level: str, message: str) -> None:
        pass

    def check_cancel(self) -> None:
        pass

    def artifact(self, path: str, kind: str = "") -> None:
        pass


class _FakeLLM(http.server.BaseHTTPRequestHandler):
    models: list[str] = ["fake-model"]
    reply: str = '{"say":"好","steps":[]}'
    last_request: dict[str, Any] = {}
    last_headers: dict[str, str] = {}

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
        self._send({"data": [{"id": m} for m in type(self).models]})

    def do_POST(self) -> None:  # noqa: N802
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])).decode("utf-8"))
        type(self).last_request = req
        type(self).last_headers = {k.lower(): v for k, v in self.headers.items()}
        if self.path.endswith("messages"):  # Anthropic
            self._send({"content": [{"type": "text", "text": type(self).reply}]})
        else:
            self._send({"choices": [{"message": {"content": type(self).reply}}]})


@pytest.fixture
def fake_llm():  # noqa: ANN201
    _FakeLLM.models = ["fake-model"]
    _FakeLLM.reply = '{"say":"好","steps":[]}'
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _FakeLLM)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/v1"
    srv.shutdown()


class TestParseMessages:
    def test_role_冒號_內容(self) -> None:
        assert parse_messages(["user:你好", "assistant:嗨"]) == [
            {"role": "user", "content": "你好"},
            {"role": "assistant", "content": "嗨"},
        ]

    def test_只切第一個冒號(self) -> None:
        # 訊息本身常常有冒號（時間碼、比例），切太多次會把內容砍掉
        assert parse_messages(["user:把 00:12 到 00:20 剪掉"])[0]["content"] == "把 00:12 到 00:20 剪掉"

    def test_沒寫_role_當_user(self) -> None:
        assert parse_messages(["把開頭剪掉"]) == [{"role": "user", "content": "把開頭剪掉"}]

    def test_不認得的_role_當_user_而不是丟掉(self) -> None:
        assert parse_messages(["tool:something"]) == [{"role": "user", "content": "tool:something"}]

    def test_空白訊息跳過(self) -> None:
        assert parse_messages(["user:  ", "user:真的內容"]) == [{"role": "user", "content": "真的內容"}]

    def test_全空就報錯而且講怎麼寫(self) -> None:
        with pytest.raises(OpError) as e:
            parse_messages(["user:   "])
        assert "--message" in str(e.value.hint or "")


class TestExtractText:
    def test_openai_形狀(self) -> None:
        assert openai_text({"choices": [{"message": {"content": "嗨"}}]}) == "嗨"

    def test_anthropic_把多個_text_區塊接起來(self) -> None:
        r = {"content": [{"type": "text", "text": "a"}, {"type": "thinking", "text": "忽略"}, {"type": "text", "text": "b"}]}
        assert anthropic_text(r) == "ab"

    def test_形狀不對回空字串而不是爆炸(self) -> None:
        for bad in ({}, {"choices": []}, {"choices": [{}]}, {"content": "不是陣列"}, None):
            assert openai_text(bad) == ""
            assert anthropic_text(bad) == ""

    def test_content_是_null(self) -> None:
        assert openai_text({"choices": [{"message": {"content": None}}]}) == ""


class TestChat:
    def test_openai_相容端點跑得通(self, fake_llm: str) -> None:
        r = assistant_chat({"endpoint": fake_llm, "message": ["user:你好"], "system": "你是剪輯助手"}, Ctx())
        assert r["text"] == '{"say":"好","steps":[]}'
        assert r["model"] == "fake-model" and r["provider"] == "openai"
        # system 要放在最前面，而且溫度 0（計畫要穩定，不要每次都不一樣）
        req = _FakeLLM.last_request
        assert req["messages"][0] == {"role": "system", "content": "你是剪輯助手"}
        assert req["temperature"] == 0

    def test_沒指定模型就用端點列出來的第一個(self, fake_llm: str) -> None:
        _FakeLLM.models = ["第一個", "第二個"]
        assert assistant_chat({"endpoint": fake_llm, "message": ["user:嗨"]}, Ctx())["model"] == "第一個"

    def test_指定了就用指定的(self, fake_llm: str) -> None:
        assert assistant_chat({"endpoint": fake_llm, "message": ["user:嗨"], "model": "我指定的"}, Ctx())["model"] == "我指定的"

    def test_連不上會講是哪個端點還有怎麼修(self) -> None:
        with pytest.raises(OpError) as e:
            assistant_chat({"endpoint": "http://127.0.0.1:9/v1", "message": ["user:嗨"]}, Ctx())
        assert "127.0.0.1:9" in str(e.value)
        assert "模型服務" in str(e.value.hint or "")

    def test_連不上的_kind_是_Agent_不是_Io(self) -> None:
        # 標成 Io 的話 App 會顯示「檔案讀寫錯誤：連不上 …」，使用者會跑去查磁碟
        with pytest.raises(OpError) as e:
            assistant_chat({"endpoint": "http://127.0.0.1:9/v1", "message": ["user:嗨"]}, Ctx())
        assert e.value.kind == "Agent"

    def test_端點沒有模型(self, fake_llm: str) -> None:
        _FakeLLM.models = []
        with pytest.raises(OpError) as e:
            assistant_chat({"endpoint": fake_llm, "message": ["user:嗨"]}, Ctx())
        assert "沒有列出任何模型" in str(e.value)

    def test_模型回空的要講話而不是回一個空計畫(self, fake_llm: str) -> None:
        _FakeLLM.reply = "   "
        with pytest.raises(OpError) as e:
            assistant_chat({"endpoint": fake_llm, "message": ["user:嗨"]}, Ctx())
        assert "沒有回任何東西" in str(e.value)

    def test_沒有端點(self) -> None:
        with pytest.raises(OpError):
            assistant_chat({"endpoint": "  ", "message": ["user:嗨"]}, Ctx())


class TestAnthropic:
    def test_帶金鑰與版本標頭_而且_system_走自己的欄位(self, fake_llm: str) -> None:
        r = assistant_chat(
            {"endpoint": fake_llm, "provider": "anthropic", "model": "claude-x", "api_key": "sk-secret-123", "system": "你是剪輯助手", "message": ["user:嗨"]},
            Ctx(),
        )
        assert r["provider"] == "anthropic" and r["model"] == "claude-x"
        assert _FakeLLM.last_headers.get("x-api-key") == "sk-secret-123"
        assert _FakeLLM.last_headers.get("anthropic-version") == "2023-06-01"
        # Anthropic 的 system 不在 messages 裡
        assert _FakeLLM.last_request["system"] == "你是剪輯助手"
        assert all(m["role"] != "system" for m in _FakeLLM.last_request["messages"])

    def test_金鑰不會出現在結果裡(self, fake_llm: str) -> None:
        r = assistant_chat(
            {"endpoint": fake_llm, "provider": "anthropic", "model": "claude-x", "api_key": "sk-secret-123", "message": ["user:嗨"]},
            Ctx(),
        )
        assert "sk-secret-123" not in json.dumps(r, ensure_ascii=False)

    def test_缺金鑰時講得出去哪裡填(self) -> None:
        with pytest.raises(OpError) as e:
            assistant_chat({"endpoint": "https://api.anthropic.com", "provider": "anthropic", "model": "claude-x", "message": ["user:嗨"]}, Ctx())
        assert "keychain" in str(e.value.hint or "")

    def test_缺模型(self) -> None:
        with pytest.raises(OpError) as e:
            assistant_chat({"endpoint": "https://api.anthropic.com", "provider": "anthropic", "api_key": "k", "message": ["user:嗨"]}, Ctx())
        assert "要指定模型" in str(e.value)


class TestModels:
    def test_列出端點上的模型(self, fake_llm: str) -> None:
        _FakeLLM.models = ["a", "b"]
        r = assistant_models({"endpoint": fake_llm}, Ctx())
        assert r["models"] == ["a", "b"] and r["endpoint"] == fake_llm

    def test_一個都沒載入也算連得上(self, fake_llm: str) -> None:
        _FakeLLM.models = []
        r = assistant_models({"endpoint": fake_llm}, Ctx())
        assert r["models"] == [] and "沒載入" in r["_human"]

    def test_連不上講得出端點與怎麼修_而且_kind_是_Agent(self) -> None:
        with pytest.raises(OpError) as e:
            assistant_models({"endpoint": "http://127.0.0.1:9/v1"}, Ctx())
        assert "127.0.0.1:9" in str(e.value) and e.value.kind == "Agent"
        assert "Start Server" in str(e.value.hint or "")

    def test_沒有端點(self) -> None:
        with pytest.raises(OpError):
            assistant_models({"endpoint": "  "}, Ctx())
