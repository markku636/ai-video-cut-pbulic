"""AI 配音（ops/tts.py）：列聲音、合成寫檔。

測的是**壞掉的時候講不講得出人話**（連不上、401、回 JSON 不是音訊、空回覆、文字太長、格式不對）
以及金鑰只進 header、不進結果與錯誤訊息。
"""

from __future__ import annotations

import http.server
import json
import threading
from pathlib import Path
from typing import Any

import pytest

from aivc.ops import OpError
from aivc.ops.tts import parse_speakers, synth_payload, tts_speakers, tts_synth


class Ctx:
    def progress(self, stage: str, done: float, total: float, **extra: object) -> None:
        pass

    def log(self, level: str, message: str) -> None:
        pass

    def check_cancel(self) -> None:
        pass

    def artifact(self, path: str, kind: str = "") -> None:
        pass


class _FakeTTS(http.server.BaseHTTPRequestHandler):
    speakers: list[dict[str, Any]] = [{"id": "v1", "display_name": "小美", "status": "ready", "gender": "female", "engine": "cosyvoice3"}, {"id": "v2", "display_name": "訓練中", "status": "training"}]
    audio: bytes = b"RIFF....WAVEfake"
    content_type: str = "audio/wav"
    status: int = 200
    last_request: dict[str, Any] = {}
    last_headers: dict[str, str] = {}

    def log_message(self, *a) -> None:  # noqa: ANN002
        pass

    def do_GET(self) -> None:  # noqa: N802
        type(self).last_headers = {k.lower(): v for k, v in self.headers.items()}
        body = json.dumps({"count": len(type(self).speakers), "speakers": type(self).speakers}, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(body.__len__()))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:  # noqa: N802
        type(self).last_request = json.loads(self.rfile.read(int(self.headers["Content-Length"])).decode("utf-8"))
        type(self).last_headers = {k.lower(): v for k, v in self.headers.items()}
        self.send_response(type(self).status)
        self.send_header("Content-Type", type(self).content_type)
        self.send_header("Content-Length", str(len(type(self).audio)))
        self.end_headers()
        self.wfile.write(type(self).audio)


@pytest.fixture
def fake_tts():  # noqa: ANN201
    _FakeTTS.status = 200
    _FakeTTS.content_type = "audio/wav"
    _FakeTTS.audio = b"RIFF....WAVEfake"
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _FakeTTS)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


class TestSpeakers:
    def test_只留_ready_並收斂欄位(self) -> None:
        out = parse_speakers({"speakers": _FakeTTS.speakers})
        assert out == [{"id": "v1", "name": "小美", "gender": "female", "engine": "cosyvoice3", "paradigm": None}]

    def test_形狀不對回空(self) -> None:
        assert parse_speakers(None) == [] and parse_speakers({"speakers": "x"}) == [] and parse_speakers([{"status": "ready"}]) == []

    def test_op_帶金鑰進_header_不進結果(self, fake_tts: str) -> None:
        r = tts_speakers({"endpoint": fake_tts, "api_key": "sk-secret-xyz"}, Ctx())
        assert [s["name"] for s in r["speakers"]] == ["小美"] and "小美" in r["_human"]
        assert _FakeTTS.last_headers.get("x-api-key") == "sk-secret-xyz"
        assert "sk-secret-xyz" not in json.dumps(r, ensure_ascii=False)

    def test_連不上(self) -> None:
        with pytest.raises(OpError) as e:
            tts_speakers({"endpoint": "http://127.0.0.1:9", "timeout": 2}, Ctx())
        assert "連不上" in str(e.value)

    def test_沒有端點(self) -> None:
        with pytest.raises(OpError):
            tts_speakers({"endpoint": ""}, Ctx())


class TestSynth:
    def test_payload(self) -> None:
        assert synth_payload("v1", "你好", "wav", None, None) == {"speaker": "v1", "text": "你好", "response_mode": "stream", "format": "wav", "normalize": True, "best_of": 1}
        p = synth_payload("v1", "你好", "mp3", 1.2, "開心")
        assert p["speed"] == 1.2 and p["instruct"] == "開心" and p["format"] == "mp3"

    def test_端到端寫檔(self, fake_tts: str, tmp_path: Path) -> None:
        out = tmp_path / "vo" / "line1.wav"
        r = tts_synth({"endpoint": fake_tts, "api_key": "k-123456789012", "voice": "v1", "text": "  你好，  世界 ", "out": str(out), "speed": 1.1}, Ctx())
        assert out.read_bytes() == b"RIFF....WAVEfake" and r["out"] == str(out) and r["format"] == "wav" and r["chars"] == 6
        req = _FakeTTS.last_request
        assert req["speaker"] == "v1" and req["text"] == "你好， 世界" and req["format"] == "wav" and req["speed"] == 1.1 and req["response_mode"] == "stream"
        assert _FakeTTS.last_headers.get("x-api-key") == "k-123456789012"
        assert "k-123456789012" not in json.dumps(r, ensure_ascii=False)

    def test_mp3_依副檔名(self, fake_tts: str, tmp_path: Path) -> None:
        r = tts_synth({"endpoint": fake_tts, "voice": "v1", "text": "x", "out": str(tmp_path / "a.mp3")}, Ctx())
        assert r["format"] == "mp3" and _FakeTTS.last_request["format"] == "mp3"

    @pytest.mark.parametrize(
        ("args", "needle"),
        [
            ({"voice": "", "text": "x", "out": "a.wav"}, "沒有選聲音"),
            ({"voice": "v1", "text": "   ", "out": "a.wav"}, "沒有要唸的字"),
            ({"voice": "v1", "text": "x" * 3000, "out": "a.wav"}, "太長"),
            ({"voice": "v1", "text": "x", "out": "a.ogg"}, "不支援的格式"),
            ({"voice": "v1", "text": "x", "out": "a.wav", "speed": 5}, "語速"),
            ({"voice": "v1", "text": "x", "out": ""}, "輸出路徑"),
        ],
    )
    def test_參數檢查在打伺服器之前(self, fake_tts: str, args: dict[str, Any], needle: str) -> None:
        with pytest.raises(OpError) as e:
            tts_synth({"endpoint": fake_tts, **args}, Ctx())
        assert needle in str(e.value)

    def test_401_講金鑰不對而且不洩漏金鑰(self, fake_tts: str, tmp_path: Path) -> None:
        _FakeTTS.status = 401
        with pytest.raises(OpError) as e:
            tts_synth({"endpoint": fake_tts, "api_key": "sk-leak-me-please", "voice": "v1", "text": "x", "out": str(tmp_path / "a.wav")}, Ctx())
        assert "401" in str(e.value) and "金鑰" in e.value.hint and "sk-leak" not in str(e.value) + e.value.hint

    def test_回_JSON_不是音訊就講清楚(self, fake_tts: str, tmp_path: Path) -> None:
        _FakeTTS.content_type = "application/json"
        _FakeTTS.audio = b'{"detail":"speaker not found"}'
        out = tmp_path / "a.wav"
        with pytest.raises(OpError) as e:
            tts_synth({"endpoint": fake_tts, "voice": "v1", "text": "x", "out": str(out)}, Ctx())
        assert "不是音訊" in str(e.value) and "speaker not found" in e.value.hint and not out.exists()

    def test_空回覆(self, fake_tts: str, tmp_path: Path) -> None:
        _FakeTTS.audio = b""
        with pytest.raises(OpError) as e:
            tts_synth({"endpoint": fake_tts, "voice": "v1", "text": "x", "out": str(tmp_path / "a.wav")}, Ctx())
        assert "空的" in str(e.value)
