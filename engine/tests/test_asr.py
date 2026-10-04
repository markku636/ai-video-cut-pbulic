"""asr/*（ops/asr.py 的 transcribe）測試。

CPU 測試（不需要 GPU、不下載模型）：cuBLAS PATH 前置冪等、退路表、快取鍵、模型／語言別名、
轉錄退路迴圈（假後端）、音訊解碼與 proxy 幀對齊、transcribe op 全流程（假 Whisper）、LLM 校對（本機假端點）。
GPU 測試（@gpu，Windows）：測試當下用 SAPI 合成台灣華語語音（不進 repo），真的跑 large-v3-turbo，
量繁體輸出、文字相似度、詞起點誤差與第二次執行時間（研究規格 §6 第 10 條）。
"""
from __future__ import annotations

import difflib
import http.server
import json
import os
import statistics
import subprocess
import sys
import threading
from fractions import Fraction
from pathlib import Path

import numpy as np
import pytest

from aivc.asr import cache as AC
from aivc.asr import cuda_dll as CD
from aivc.asr import llm as L
from aivc.asr import models as M
from aivc.asr import whisper as W
from aivc.captions.normalize import AsrWord
from aivc.ops import OpError


class Ctx:
    def __init__(self) -> None:
        self.progress_calls: list[tuple] = []
        self.logs: list[tuple[str, str]] = []
        self.artifacts: list[tuple[str, str]] = []

    def progress(self, stage: str, done: int, total: int, **extra: object) -> None:
        self.progress_calls.append((stage, done, total, extra))

    def log(self, level: str, message: str) -> None:
        self.logs.append((level, message))

    def check_cancel(self) -> None:
        pass

    def artifact(self, path: str, kind: str = "") -> None:
        self.artifacts.append((path, kind))


# ================================================================ cuBLAS PATH


def test_cuda_dll_path_prepend_is_idempotent(tmp_path: Path) -> None:
    d = tmp_path / "nvidia" / "cublas" / "bin"
    d.mkdir(parents=True)
    env = {"PATH": os.pathsep.join([r"C:\Windows", r"C:\tools"])}
    added = CD.ensure_cuda_dll_path(env, [d])
    assert added == [str(d)] and env["PATH"].split(os.pathsep)[0] == str(d)
    before = env["PATH"]
    assert CD.ensure_cuda_dll_path(env, [d]) == [] and env["PATH"] == before
    # 大小寫／斜線不同也視為已存在（Windows）
    if sys.platform == "win32":
        env2 = {"PATH": str(d).upper().replace("\\", "/")}
        assert CD.ensure_cuda_dll_path(env2, [d]) == []
    assert CD.ensure_cuda_dll_path({"PATH": ""}, []) == []


# ================================================================ 模型表 / 語言 / 退路


def test_model_and_language_aliases() -> None:
    assert M.resolve_model("turbo").repo == "mobiuslabsgmbh/faster-whisper-large-v3-turbo" and M.resolve_model("large").name == "large-v3"
    assert M.resolve_model("auto", free_vram_mb=32000).name == "large-v3-turbo"
    assert M.resolve_model("auto", free_vram_mb=2000).name == "small" and M.resolve_model("auto", cuda=False).name == "small"
    assert M.resolve_model("someone/custom-ct2").revision is None
    with pytest.raises(ValueError):
        M.resolve_model("gigantic")
    assert M.MODELS["large-v3-turbo"].revision and M.MODELS["large-v3"].revision
    assert [M.asr_language(x) for x in ("auto", "", None, "zh-TW", "ZH_hant", "en-US", "ja", "yue")] == [None, None, None, "zh", "zh", "en", "ja", "yue"]
    assert M.default_output_language("zh") == "zh-TW" and M.default_output_language(None, "en") == "en"
    assert M.default_prompt("zh", None) == M.PROMPT_ZH_TW and M.default_prompt("zh", "zh-CN") == M.PROMPT_ZH_CN and M.default_prompt("en", None) is None


def test_error_classification_and_fallback_table() -> None:
    assert M.classify_error("RuntimeError: Library cublas64_12.dll is not found or cannot be loaded") == "cuda"
    assert M.classify_error("RuntimeError: CUDA failed with error out of memory") == "oom"
    assert M.classify_error("RuntimeError: CUBLAS_STATUS_NOT_SUPPORTED") == "cuda"
    assert M.classify_error("ValueError: Requested float16 compute type, but the target device or backend do not support efficient float16 computation.") == "cuda"
    assert M.classify_error("ValueError: bad audio") == "other"
    assert M.first_attempt("auto", "auto", True) == ("cuda", "float16") and M.first_attempt("auto", None, False) == ("cpu", "int8")
    assert M.first_attempt("cpu", "auto", True) == ("cpu", "int8") and M.first_attempt("cuda", "int8_float16", True) == ("cuda", "int8_float16")
    # cublas 錯 → CPU int8；OOM → int8_float16 → CPU；--device cuda 不准退 CPU；其他錯不重試
    assert M.next_attempt("cuda", "cuda", "float16", True) == ("cpu", "int8")
    assert M.next_attempt("oom", "cuda", "float16", True) == ("cuda", "int8_float16")
    assert M.next_attempt("oom", "cuda", "int8_float16", True) == ("cpu", "int8")
    assert M.next_attempt("oom", "cuda", "int8_float16", False) is None and M.next_attempt("cuda", "cuda", "float16", False) is None
    assert M.next_attempt("other", "cuda", "float16", True) is None and M.next_attempt("cuda", "cpu", "int8", True) is None


def test_cache_key_stable_and_sensitive(tmp_path: Path) -> None:
    p = {"model": "a@b", "language": "zh", "prompt": "x", "hotwords": ["百家姓"], "range": None}
    assert AC.cache_key(p) == AC.cache_key(dict(reversed(list(p.items())))) and len(AC.cache_key(p)) == 16
    assert AC.cache_key(p) != AC.cache_key({**p, "hotwords": []}) and AC.cache_key(p) != AC.cache_key({**p, "range": [0, 10]})
    assert AC.asr_path(tmp_path, "abcd").as_posix().endswith("asr/abcd.v1.json")
    assert AC.newest(tmp_path) is None and AC.load(tmp_path / "nope.json") is None


# ================================================================ 退路迴圈（假後端）


class _Seg:
    def __init__(self, i: int, s: float, e: float, words: list[tuple[float, float, str, float]]) -> None:
        self.id, self.start, self.end, self.text = i, s, e, "".join(w[2] for w in words)
        self.avg_logprob, self.no_speech_prob, self.compression_ratio = -0.2, 0.01, 1.3
        self.words = [type("Wd", (), {"start": a, "end": b, "word": t, "probability": p})() for a, b, t, p in words]


class _Info:
    language, language_probability, duration = "zh", 0.99, 3.0


def test_transcribe_falls_back_from_cuda_to_cpu(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str]] = []

    class FakeModel:
        def __init__(self, dev: str, ct: str) -> None:
            self.dev, self.ct = dev, ct

        def transcribe(self, audio, **kw):  # noqa: ANN001, ANN003
            assert kw["word_timestamps"] and kw["vad_filter"] and kw["vad_parameters"]["min_silence_duration_ms"] == 500
            if self.dev == "cuda":
                def gen():
                    raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")
                    yield  # noqa: unreachable
                return gen(), _Info()
            return iter([_Seg(0, 0.0, 1.0, [(0.0, 0.5, "歡迎", 0.9), (0.5, 1.0, "光臨", 0.8)])]), _Info()

    monkeypatch.setattr(W, "cuda_device_count", lambda: 1)
    monkeypatch.setattr(W, "load", lambda info, dev, ct, ctx: (calls.append((dev, ct)), FakeModel(dev, ct))[1])
    ctx = Ctx()
    raw = W.transcribe(np.zeros(48000, np.float32), M.MODELS["tiny"], ctx, language="zh")
    assert calls == [("cuda", "float16"), ("cpu", "int8")]
    assert raw.device == "cpu" and raw.compute_type == "int8" and "cublas64_12" in (raw.fallback_reason or "") and raw.attempts[0]["kind"] == "cuda"
    assert [w["word"] for w in raw.segments[0]["words"]] == ["歡迎", "光臨"]
    assert any(c[0] == "asr.decode" and c[1] == c[2] for c in ctx.progress_calls)
    # --device cuda：不准退 CPU → Gpu
    with pytest.raises(OpError) as ei:
        W.transcribe(np.zeros(48000, np.float32), M.MODELS["tiny"], Ctx(), device="cuda", language="zh")
    assert ei.value.kind == "Gpu"


def test_transcribe_oom_goes_int8_float16_first(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, str]] = []

    class FakeModel:
        def __init__(self, dev: str, ct: str) -> None:
            self.dev, self.ct = dev, ct

        def transcribe(self, audio, **kw):  # noqa: ANN001, ANN003
            if self.ct == "float16":
                raise RuntimeError("CUDA failed with error out of memory")
            return iter([_Seg(0, 0.0, 1.0, [(0.0, 1.0, " ok", 0.9)])]), _Info()

    monkeypatch.setattr(W, "cuda_device_count", lambda: 1)
    monkeypatch.setattr(W, "load", lambda info, dev, ct, ctx: (calls.append((dev, ct)), FakeModel(dev, ct))[1])
    raw = W.transcribe(np.zeros(16000, np.float32), M.MODELS["tiny"], Ctx())
    assert calls == [("cuda", "float16"), ("cuda", "int8_float16")] and raw.compute_type == "int8_float16"


# ================================================================ 音訊 + transcribe op（假 Whisper）


def _clip_with_audio(path: Path, n_frames: int = 45, fps: int = 30, audio_offset_s: float = 0.0) -> Path:
    """ffv1 影像 + pcm_s16le 48 kHz 立體聲（440 Hz 正弦）；audio_offset_s > 0 表示音訊比影像晚開始。"""
    import av

    with av.open(str(path), "w") as c:
        vs = c.add_stream("ffv1", rate=fps)
        vs.width, vs.height, vs.pix_fmt = 64, 36, "yuv420p"
        vs.codec_context.time_base = Fraction(1, fps)
        as_ = c.add_stream("pcm_s16le", rate=48000)
        as_.layout = "stereo"
        dur = n_frames / fps
        t = np.arange(int(48000 * dur)) / 48000
        pcm = (np.sin(2 * np.pi * 440 * t) * 8000).astype(np.int16)
        stereo = np.stack([pcm, pcm])
        for i in range(n_frames):
            f = av.VideoFrame.from_ndarray(np.full((36, 64, 3), i * 5 % 255, np.uint8), format="rgb24").reformat(format="yuv420p")
            f.pts, f.time_base = i, Fraction(1, fps)
            for pkt in vs.encode(f):
                c.mux(pkt)
        chunk = 1024
        start = int(round(audio_offset_s * 48000))
        for i in range(0, stereo.shape[1], chunk):
            # s16 是 packed 格式：(1, 樣本數×聲道) 的交錯排列
            fr = av.AudioFrame.from_ndarray(np.ascontiguousarray(stereo[:, i : i + chunk].T.reshape(1, -1)), format="s16", layout="stereo")
            fr.sample_rate = 48000
            fr.pts, fr.time_base = start + i, Fraction(1, 48000)
            for pkt in as_.encode(fr):
                c.mux(pkt)
        for s in (vs, as_):
            for pkt in s.encode():
                c.mux(pkt)
    return path


def test_decode_audio_resamples_to_16k_mono(tmp_path: Path) -> None:
    from aivc.asr import audio as AU

    clip = _clip_with_audio(tmp_path / "a.mkv", audio_offset_s=0.25)
    dec = AU.decode_audio(clip, Ctx())
    assert abs(dec.start_s - 0.25) < 1e-3 and dec.source_rate == 48000 and dec.channels == 2
    assert abs(dec.duration_s - 1.5) < 0.05 and dec.samples.dtype == np.float32 and 0.1 < float(np.abs(dec.samples).max()) < 0.5
    video_only = tmp_path / "v.mkv"
    sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures" / "e1"))
    import synth_scene as SC

    SC.write_clip(video_only, [np.zeros((36, 64, 3), np.uint8)] * 3)
    with pytest.raises(AU.NoAudio):
        AU.decode_audio(video_only)


def _opus_webm_with_gap(path: Path, gap_s: float, before_s: float = 0.5, after_s: float = 0.5) -> Path:
    """Opus/WebM（48 kHz 單聲道 440 Hz）：前 before_s 秒之後的封包時間戳整體往後推 gap_s —— 模擬錄影掉音訊封包的斷層。"""
    import av

    rate, fs = 48000, 960
    total = int(round((before_s + after_s) * rate))
    t = np.arange(total) / rate
    pcm = (np.sin(2 * np.pi * 440 * t) * 12000).astype(np.int16)
    with av.open(str(path), "w", format="webm") as c:
        st = c.add_stream("libopus", rate=rate)
        st.layout = "mono"

        def mux(packets) -> None:  # noqa: ANN001
            for pkt in packets:
                if pkt.pts is not None and gap_s and float(pkt.pts * pkt.time_base) >= before_s - 1e-6:
                    shift = int(round(gap_s / pkt.time_base))
                    pkt.pts += shift
                    if pkt.dts is not None:
                        pkt.dts += shift
                c.mux(pkt)

        for i in range(0, total, fs):
            chunk = pcm[i : i + fs]
            if chunk.size < fs:
                chunk = np.pad(chunk, (0, fs - chunk.size))
            fr = av.AudioFrame.from_ndarray(chunk.reshape(1, -1), format="s16", layout="mono")
            fr.sample_rate = rate
            fr.pts, fr.time_base = i, Fraction(1, rate)
            mux(st.encode(fr))
        mux(st.encode(None))
    return path


def test_decode_audio_pads_timestamp_gaps(tmp_path: Path) -> None:
    """音訊封包斷層 1 秒：解出來的樣本要在斷層位置補 1 秒靜音，斷層之後的聲音維持在原本的時間（以前會提早 1 秒 → 字幕整段漂移）。"""
    from aivc.asr import audio as AU

    sr = AU.SAMPLE_RATE

    def rms(x: np.ndarray, a: float, b: float) -> float:
        seg = x[int(a * sr) : int(b * sr)]
        return float(np.sqrt(np.mean(seg**2))) if seg.size else 0.0

    # 沒有斷層：不能誤補（Opus 20 ms 一幀、重取樣器的延遲都在容忍範圍內）
    plain = AU.decode_audio(_opus_webm_with_gap(tmp_path / "plain.webm", 0.0), Ctx())
    assert plain.codec == "opus" and abs(plain.duration_s - 1.0) < 0.05, plain.duration_s
    dec = AU.decode_audio(_opus_webm_with_gap(tmp_path / "gap.webm", 1.0), Ctx())
    x = dec.samples
    assert abs(dec.duration_s - 2.0) < 0.05, dec.duration_s
    assert rms(x, 0.1, 0.4) > 0.1 and rms(x, 1.6, 1.9) > 0.1
    assert rms(x, 0.6, 1.45) < 1e-3  # 斷層 = 靜音
    # 斷層後第一個有聲樣本在 ~1.5 s（音訊時間軸，扣掉第一幀起點）
    onset = int(np.argmax(np.abs(x[int(1.0 * sr) :]) > 0.05)) / sr + 1.0
    assert abs(onset - 1.5) < 0.03, onset


def test_transcribe_op_with_fake_whisper_writes_frames_and_caches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.asr import audio as AU
    from aivc.ops import asr as OA

    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    clip = _clip_with_audio(tmp_path / "clip.mkv", n_frames=90, audio_offset_s=0.5)
    n_calls = []

    def fake(audio, info, ctx, **kw):  # noqa: ANN001, ANN003
        n_calls.append(kw)
        assert kw["language"] == "zh" and kw["initial_prompt"] == M.PROMPT_ZH_TW and kw["hotwords"] == ["百家姓", "玩家"]
        segs = [{"id": 0, "start": 0.1, "end": 1.0, "text": "欢迎来到百家姓", "avg_logprob": -0.1, "no_speech_prob": 0.0, "compression_ratio": 1.1,
                 "words": [{"start": 0.1, "end": 0.4, "word": "欢迎", "probability": 0.9}, {"start": 0.4, "end": 0.7, "word": "来到", "probability": 0.3}, {"start": 0.7, "end": 1.0, "word": "百家姓,", "probability": 0.9}]}]
        return W.RawTranscript(segs, "zh", 0.98, len(audio) / 16000, "cpu", "int8", 0.05, 0.01, None, [])

    monkeypatch.setattr(W, "transcribe", fake)
    monkeypatch.setattr(W, "unload_all", lambda: 0)
    monkeypatch.setattr(AU, "speech_regions", lambda samples, a, b: [(0.05, 1.05)])
    ctx = Ctx()
    args = {"video": str(clip), "language": "zh", "model": "tiny", "hotwords": ["百家姓, 玩家"], "device": "auto"}
    r = OA.transcribe_media(dict(args), ctx)
    assert r["cached"] is False and r["words"] == 3 and r["device"] == "cpu" and r["outputLanguage"] == "zh-TW"
    doc = json.loads(Path(r["path"]).read_text(encoding="utf-8"))
    # 音訊晚影像 0.5 s 開始 → offset 0.5：ASR 0.1 s = proxy 0.6 s = 第 18 幀
    assert doc["offsetS"] == 0.5 and doc["fps"] == {"num": 30, "den": 1} and doc["nFrames"] == 90
    ws = doc["words"]
    assert [w["text"] for w in ws] == ["歡迎", "來到", "百家姓，"]
    assert (ws[0]["startFrame"], ws[0]["endFrame"], ws[0]["startMs"]) == (18, 27, 600) and ws[1]["flags"] == ["lowConfidence"] and ws[2]["emphasis"] is True
    assert doc["segments"][0]["startFrame"] == 18 and doc["segments"][0]["words"][0]["word"] == "欢迎"  # 原始片段保留
    assert ("asr" in {k for _p, k in ctx.artifacts}) and Path(r["path"]).parent.name == "asr"
    r2 = OA.transcribe_media(dict(args), Ctx())
    assert r2["cached"] is True and len(n_calls) == 1 and r2["path"] == r["path"]
    # --range 只辨識一段：offset 加上範圍起點
    r3 = OA.transcribe_media({**args, "range": "30:90"}, Ctx())
    d3 = json.loads(Path(r3["path"]).read_text(encoding="utf-8"))
    assert d3["range"] == [30, 90] and abs(d3["offsetS"] - 1.0) < 1e-6 and d3["words"][0]["startFrame"] == 33


def test_transcribe_op_errors(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.ops import asr as OA

    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    with pytest.raises(OpError) as ei:
        OA.transcribe_media({}, Ctx())
    assert ei.value.kind == "Invalid"
    sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures" / "e1"))
    import synth_scene as SC

    v = SC.write_clip(tmp_path / "silent.mkv", [np.zeros((36, 64, 3), np.uint8)] * 5)
    with pytest.raises(OpError) as ei:
        OA.transcribe_media({"video": str(v), "model": "tiny"}, Ctx())
    assert ei.value.kind == "Invalid" and "音軌" in str(ei.value)
    with pytest.raises(OpError):
        OA.transcribe_media({"video": str(v), "model": "gigantic"}, Ctx())


def test_hotwords_parsing() -> None:
    from aivc.ops.asr import _hotwords

    assert _hotwords(None) == [] and _hotwords("百家姓，玩家、店家") == ["百家姓", "玩家", "店家"] and _hotwords(["a,b", "b", " c "]) == ["a", "b", "c"]


def test_env_doctor_asr_section_is_non_blocking(monkeypatch: pytest.MonkeyPatch) -> None:
    """env.doctor 帶 asr 區段，但語音辨識缺件／探測爆掉都不能讓閘門變紅（字幕是選配）。"""
    from aivc import doctor as D
    from aivc.asr import doctor as AD
    from aivc.ops import doctor as OD

    monkeypatch.setattr(D, "run", lambda quick=False: D.DoctorReport())
    d = OD.doctor_op({"quick": True}, None)  # type: ignore[arg-type]
    assert d["ok"] is True and d["_exit_code"] == 0 and d["problems"] == []
    assert "asr" in d and d["asr"]["cudaDevices"] is None  # quick：只查版本、不載 CUDA DLL
    assert "語音辨識（選配）" in d["_human"]

    def boom(probe_cuda: bool = True) -> dict:
        raise RuntimeError("ctranslate2 炸了")

    monkeypatch.setattr(AD, "asr_section", boom)
    d = OD.doctor_op({"quick": False}, None)  # type: ignore[arg-type]
    assert d["ok"] is True and d["problems"] == [] and "ctranslate2 炸了" in d["asr"]["notes"][0]


# ================================================================ sidecar：worker 第一次 import ctranslate2 不能卡 stdin


@pytest.mark.skipif(os.name != "nt", reason="同步 I/O 序列化是 Windows 行為")
def test_serve_worker_first_ctranslate2_import_does_not_wait_for_stdin() -> None:
    """test_serve_stdin 的同一個 Windows 死結（worker 在主執行緒卡 ReadFile 時 import 原生擴充）：
    ctranslate2 / faster_whisper / onnxruntime 都是大型原生擴充，asr.doctor 會在 worker 裡第一次 import 它們。"""
    pytest.importorskip("ctranslate2")
    import time

    engine = Path(__file__).resolve().parents[1]
    env = dict(os.environ, PYTHONUTF8="1", PYTHONPATH=os.pathsep.join([str(engine / "src"), os.environ.get("PYTHONPATH", "")]))
    proc = subprocess.Popen([sys.executable, "-X", "utf8", "-m", "aivc", "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
    replies: dict[str, dict] = {}

    def reader() -> None:
        assert proc.stdout is not None
        for raw in proc.stdout:
            try:
                obj = json.loads(raw.decode("utf-8"))
            except ValueError:
                continue
            if "ok" in obj:
                replies[str(obj["id"])] = obj

    threading.Thread(target=reader, daemon=True).start()

    def send(obj: dict) -> None:
        assert proc.stdin is not None
        proc.stdin.write((json.dumps(obj) + "\n").encode("utf-8"))
        proc.stdin.flush()

    def wait_for(rid: str, timeout: float) -> dict | None:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            if rid in replies:
                return replies[rid]
            time.sleep(0.05)
        return None

    try:
        send({"id": "h", "op": "hello", "args": {"torch": False}})
        assert wait_for("h", 60) is not None
        send({"id": "d", "op": "asr.doctor", "args": {}})
        got = wait_for("d", 60)  # 修正前會一直等到下一行 stdin；不送任何東西也要完成
        assert got is not None, "worker 第一次 import ctranslate2 卡住了"
        assert got["ok"] is True and got["result"]["ctranslate2"]
    finally:
        try:
            send({"id": "s", "op": "shutdown"})
            proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            proc.kill()


# ================================================================ LLM 校對（本機假端點）


class _FakeLLM(http.server.BaseHTTPRequestHandler):
    reply: dict = {}
    # 設了就直接當成 message.content 回傳（字串原樣；其他值 json.dumps）—— 測壞掉的 LLM 輸出
    raw_content: object = None

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
        assert req["chat_template_kwargs"] == {"enable_thinking": False} and req["temperature"] == 0 and req["model"] == "fake-model"
        rc = type(self).raw_content
        if rc is not None:
            self._send({"choices": [{"message": {"content": rc if isinstance(rc, str) else json.dumps(rc, ensure_ascii=False)}}]})
            return
        lines = req["messages"][1]["content"].split("\n")
        cues = []
        for ln in lines:
            i, text = ln.split("\t")
            cues.append({"id": int(i), "text": type(self).reply.get(int(i), text), "emphasis": ["百家姓", "姓"]})
        self._send({"choices": [{"message": {"content": json.dumps({"cues": cues}, ensure_ascii=False)}}]})


@pytest.fixture
def fake_llm():
    _FakeLLM.raw_content = None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _FakeLLM)
    th = threading.Thread(target=srv.serve_forever, daemon=True)
    th.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}/v1"
    srv.shutdown()
    _FakeLLM.raw_content = None


def test_llm_refine_applies_accepted_and_rejects_rewrites(fake_llm: str) -> None:
    words = [AsrWord("歡迎", 0, 0.5, seg=0), AsrWord("來到", 0.5, 1, seg=0), AsrWord("百家性", 1, 1.5, seg=0), AsrWord("今天", 2, 2.5, seg=1), AsrWord("天氣", 2.5, 3, seg=1)]
    _FakeLLM.reply = {0: "歡迎|來到|百家姓", 1: "我完全改寫了這一整句內容"}
    ctx = Ctx()
    out, rep = L.refine(words, fake_llm, ctx)
    assert rep.reachable and rep.model == "fake-model" and rep.applied == 1 and rep.rejected == 1
    assert [w.text for w in out] == ["歡迎", "來到", "百家姓", "今天", "天氣"] and out[2].source == "llm" and out[2].emphasis and not out[0].emphasis
    assert [(w.start, w.end) for w in out] == [(0, 0.5), (0.5, 1), (1, 1.5), (2, 2.5), (2.5, 3)]
    # 只要建議不套用（captions.refine）
    words2 = [AsrWord("百家性", 0, 1, seg=0)]
    _FakeLLM.reply = {0: "百家姓"}
    out2, rep2 = L.refine(words2, fake_llm, Ctx(), apply=False)
    assert out2[0].text == "百家性" and rep2.proposals[0]["after"] == "百家姓" and rep2.proposals[0]["accepted"]


@pytest.mark.parametrize(
    "content",
    [
        [{"id": 0, "text": "歡迎|來到|百家姓"}],  # 頂層是陣列（驗證者實測：以前 AttributeError → Internal exit 1）
        {"cues": {"id": 0, "text": "百家姓"}},  # cues 不是陣列
        {"result": []},  # 缺 cues
        "這不是 JSON",
        {"cues": ["歡迎來到百家姓", 3, None]},  # cues 裡不是物件
        {"cues": [{"id": 0}, {"text": "百家姓"}, {"id": True, "text": "x"}, {"id": 99, "text": "x"}, {"id": 0, "text": 5}]},  # 缺欄位／型別不對／id 不在這一批
    ],
    ids=["list", "cues-object", "no-cues", "not-json", "non-object-cues", "missing-fields"],
)
def test_llm_malformed_output_degrades_to_warning(fake_llm: str, content: object) -> None:
    words = [AsrWord("歡迎", 0, 0.5, seg=0), AsrWord("來到", 0.5, 1, seg=0), AsrWord("百家性", 1, 1.5, seg=0)]
    _FakeLLM.raw_content = content
    for apply in (True, False):
        out, rep = L.refine(words, fake_llm, Ctx(), apply=apply)
        assert rep.reachable and rep.applied == 0 and rep.proposals == []
        assert [w.text for w in out] == ["歡迎", "來到", "百家性"] and all(w.source == "asr" for w in out)
        assert len(rep.warnings) == 1 and rep.warnings[0].startswith(L.BAD_OUTPUT_PREFIX), rep.warnings
    # emphasis 壞掉只當沒有強調；字串 id 也收；好的建議照常套用、壞的那筆只記警告
    _FakeLLM.raw_content = {"cues": [{"id": "0", "text": "歡迎|來到|百家姓", "emphasis": "百家姓"}, "垃圾"]}
    out, rep = L.refine(words, fake_llm, Ctx())
    assert [w.text for w in out] == ["歡迎", "來到", "百家姓"] and rep.applied == 1 and not out[2].emphasis
    assert len(rep.warnings) == 1 and "1 筆" in rep.warnings[0]
    assert L.parse_cues(None)[1] and L.parse_cues("[1]")[1] and L.parse_cues('{"cues": []}') == ([], None)


def test_llm_apply_failure_leaves_words_untouched(fake_llm: str, monkeypatch: pytest.MonkeyPatch) -> None:
    words = [AsrWord("百家性", 0, 1, seg=0)]
    _FakeLLM.reply = {0: "百家姓"}

    def boom(ws, after, emphasis):  # noqa: ANN001
        ws[0].text = "改到一半"
        raise RuntimeError("炸了")

    monkeypatch.setattr(L, "apply_text", boom)
    out, rep = L.refine(words, fake_llm, Ctx())
    assert [w.text for w in out] == ["百家性"] and words[0].text == "百家性" and rep.applied == 0
    assert rep.warnings and rep.warnings[0].startswith(L.BAD_OUTPUT_PREFIX) and rep.proposals[0]["accepted"] is False


def _fake_whisper(monkeypatch: pytest.MonkeyPatch, calls: list) -> None:
    from aivc.asr import audio as AU

    def fake(audio, info, ctx, **kw):  # noqa: ANN001, ANN003
        calls.append(kw)
        segs = [{"id": 0, "start": 0.1, "end": 1.0, "text": "欢迎来到百家性", "avg_logprob": -0.1, "no_speech_prob": 0.0, "compression_ratio": 1.1,
                 "words": [{"start": 0.1, "end": 0.4, "word": "欢迎", "probability": 0.9}, {"start": 0.4, "end": 0.7, "word": "来到", "probability": 0.9}, {"start": 0.7, "end": 1.0, "word": "百家性", "probability": 0.9}]}]
        return W.RawTranscript(segs, "zh", 0.98, len(audio) / 16000, "cpu", "int8", 0.05, 0.01, None, [])

    monkeypatch.setattr(W, "transcribe", fake)
    monkeypatch.setattr(W, "unload_all", lambda: 0)
    monkeypatch.setattr(AU, "speech_regions", lambda samples, a, b: [(0.05, 1.05)])


def test_transcribe_llm_writes_asr_before_refine_and_survives_refine_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fake_llm: str) -> None:
    from aivc.asr import cache as AC
    from aivc.ops import asr as OA

    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    clip = _clip_with_audio(tmp_path / "clip.mkv", n_frames=45, audio_offset_s=0.5)
    calls: list = []
    _fake_whisper(monkeypatch, calls)
    base_args = {"video": str(clip), "language": "zh", "model": "tiny"}
    seen_on_disk: list[bool] = []
    real_refine = L.refine

    class Canceled(Exception):
        pass

    # 1) 校對開始時辨識結果已經落地；校對被取消 → 例外往上丟，但辨識結果還在
    def cancel_refine(words, url, ctx, **kw):  # noqa: ANN001, ANN003
        docs = [AC.load(p) for p in (tmp_path / "cache").rglob("asr/*.v1.json")]
        seen_on_disk.append(len(docs) == 1 and docs[0] is not None and len(docs[0]["words"]) == 3 and docs[0]["llm"] is None)
        raise Canceled()

    monkeypatch.setattr(L, "refine", cancel_refine)
    with pytest.raises(Canceled):
        OA.transcribe_media({**base_args, "llm_url": fake_llm}, Ctx())
    assert seen_on_disk == [True] and len(calls) == 1
    plain = OA.transcribe_media(dict(base_args), Ctx())  # 不帶 LLM：直接命中剛才的辨識結果
    assert plain["cached"] is True and len(calls) == 1 and plain["words"] == 3

    # 2) 校對本身丟例外 → 警告 + 辨識結果照樣回傳（不重跑 Whisper）
    def boom(words, url, ctx, **kw):  # noqa: ANN001, ANN003
        raise RuntimeError("LLM 模組炸了")

    monkeypatch.setattr(L, "refine", boom)
    r = OA.transcribe_media({**base_args, "llm_url": fake_llm}, Ctx())
    doc = json.loads(Path(r["path"]).read_text(encoding="utf-8"))
    assert len(calls) == 1 and r["cached"] is False and [w["text"] for w in doc["words"]] == ["歡迎", "來到", "百家性"]
    assert doc["llm"]["complete"] is False and any(w.startswith(L.BAD_OUTPUT_PREFIX) and "炸了" in w for w in r["warnings"])
    assert doc["words"][0]["startFrame"] == plain_frames(plain) and r["path"] != plain["path"]

    # 3) LLM 回傳壞掉的 JSON → 警告、詞不變；沒校對完的快取不算命中，下次沿用辨識結果重跑校對
    monkeypatch.setattr(L, "refine", real_refine)
    _FakeLLM.raw_content = [{"id": 0, "text": "歡迎|來到|百家姓"}]
    r = OA.transcribe_media({**base_args, "llm_url": fake_llm}, Ctx())
    assert r["cached"] is False and len(calls) == 1 and any(w.startswith(L.BAD_OUTPUT_PREFIX) for w in r["warnings"])
    # 4) LLM 恢復正常 → 只重跑校對，結果快取起來
    _FakeLLM.raw_content = None
    _FakeLLM.reply = {0: "歡迎|來到|百家姓"}
    r = OA.transcribe_media({**base_args, "llm_url": fake_llm}, Ctx())
    doc = json.loads(Path(r["path"]).read_text(encoding="utf-8"))
    assert len(calls) == 1 and [w["text"] for w in doc["words"]] == ["歡迎", "來到", "百家姓"] and doc["llm"]["complete"] is True and doc["words"][2]["source"] == "llm"
    assert doc["offsetS"] == 0.5 and doc["words"][0]["startFrame"] == plain_frames(plain)
    again = OA.transcribe_media({**base_args, "llm_url": fake_llm}, Ctx())
    assert again["cached"] is True and again["path"] == r["path"] and len(calls) == 1


def plain_frames(result: dict) -> int:
    return json.loads(Path(result["path"]).read_text(encoding="utf-8"))["words"][0]["startFrame"]


def test_llm_unreachable_is_skipped() -> None:
    words = [AsrWord("hi", 0, 1, seg=0)]
    out, rep = L.refine(words, "http://127.0.0.1:9/v1", Ctx())
    assert out is words and not rep.reachable and rep.warnings and "無法連線" in rep.warnings[0]
    ok, _ = L.accept("歡迎來到百家性", "歡迎來到百家姓")
    bad, why = L.accept("歡迎來到百家性", "歡迎")
    assert ok and not bad and "相似度" in why
    bad, why = L.accept("歡迎來到百家性", "歡迎來到百家性課堂今天")  # 相似度 0.78 但長度比 1.57
    assert not bad and "長度比" in why


# ================================================================ GPU：真的跑 faster-whisper（SAPI 語音，測試時產生）

ZH_TEXT = "歡迎來到百家姓課堂。店家現在翻開第三張牌，是紅心八。這一局玩家贏了，請大家注意動態字幕的效果。"
_PS = r"""
param([string]$Voice, [string]$TextFile, [string]$OutWav, [string]$OutJson)
Add-Type -AssemblyName System.Speech
$text = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8).Trim()
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice($Voice)
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile($OutWav, $fmt)
Register-ObjectEvent -InputObject $s -EventName SpeakProgress -SourceIdentifier sp | Out-Null
$s.Speak($text)
$s.SetOutputToNull()
Start-Sleep -Milliseconds 200
$events = New-Object System.Collections.ArrayList
foreach ($e in (Get-Event -SourceIdentifier sp)) { $a = $e.SourceEventArgs; [void]$events.Add([ordered]@{ charPos = $a.CharacterPosition; charCount = $a.CharacterCount; ms = [int]$a.AudioPosition.TotalMilliseconds }) }
Unregister-Event -SourceIdentifier sp
$s.Dispose()
[System.IO.File]::WriteAllText($OutJson, (ConvertTo-Json -InputObject @($events) -Depth 3), (New-Object System.Text.UTF8Encoding($false)))
"""


def _mux_wav_to_clip(wav: Path, out: Path) -> Path:
    import av

    with av.open(str(wav)) as src:
        pcm = np.concatenate([f.to_ndarray().reshape(-1) for f in src.decode(audio=0)])
    n = int(len(pcm) / 16000 * 30) + 1
    with av.open(str(out), "w") as c:
        vs = c.add_stream("ffv1", rate=30)
        vs.width, vs.height, vs.pix_fmt = 64, 36, "yuv420p"
        vs.codec_context.time_base = Fraction(1, 30)
        as_ = c.add_stream("pcm_s16le", rate=16000)
        as_.layout = "mono"
        for i in range(n):
            f = av.VideoFrame.from_ndarray(np.zeros((36, 64, 3), np.uint8), format="rgb24").reformat(format="yuv420p")
            f.pts, f.time_base = i, Fraction(1, 30)
            for pkt in vs.encode(f):
                c.mux(pkt)
        for i in range(0, len(pcm), 1600):
            fr = av.AudioFrame.from_ndarray(np.ascontiguousarray(pcm[i : i + 1600].reshape(1, -1)), format="s16", layout="mono")
            fr.sample_rate, fr.pts, fr.time_base = 16000, i, Fraction(1, 16000)
            for pkt in as_.encode(fr):
                c.mux(pkt)
        for s in (vs, as_):
            for pkt in s.encode():
                c.mux(pkt)
    return out


@pytest.mark.gpu
def test_gpu_turbo_zh_traditional_accuracy_and_speed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import time

    import opencc

    from aivc.ops import asr as OA

    if sys.platform != "win32":
        pytest.skip("SAPI 只有 Windows")
    d = tmp_path
    (d / "gt.ps1").write_text(_PS, encoding="utf-8-sig")
    (d / "zh.txt").write_text(ZH_TEXT, encoding="utf-8")
    wav, gtp = d / "zh.wav", d / "zh.json"
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(d / "gt.ps1"), "Microsoft Hanhan Desktop", str(d / "zh.txt"), str(wav), str(gtp)], check=True, capture_output=True, timeout=120)
    gt = json.loads(gtp.read_text(encoding="utf-8-sig"))
    clip = _mux_wav_to_clip(wav, d / "zh.mkv")
    monkeypatch.setenv("AIVC_CACHE_DIR", str(d / "cache"))
    args = {"video": str(clip), "language": "zh", "model": "large-v3-turbo", "device": "auto", "keep_loaded": True}
    r = OA.transcribe_media(dict(args), Ctx())
    assert (r["device"], r["computeType"]) == ("cuda", "float16"), r
    t0 = time.perf_counter()
    r2 = OA.transcribe_media({**args, "force": True, "keep_loaded": False}, Ctx())
    assert time.perf_counter() - t0 <= 3.0 and r2["seconds"] <= 3.0
    doc = json.loads(Path(r2["path"]).read_text(encoding="utf-8"))
    text = "".join(w["text"] for w in doc["words"])
    assert opencc.OpenCC("s2t").convert(text) == text  # 已經是繁體
    strip = lambda s: "".join(ch for ch in s if ch.isalnum())  # noqa: E731
    sim = difflib.SequenceMatcher(None, strip(ZH_TEXT), strip(text), autojunk=False).ratio()
    assert sim >= 0.90, (sim, text)
    # 詞起點誤差：SAPI 每個詞的第一個字 ↔ 對到的 ASR 字所屬詞的起點
    gt_chars = []
    for e in gt:
        seg = ZH_TEXT[e["charPos"] : e["charPos"] + e["charCount"]]
        for j, ch in enumerate(c for c in seg if c.isalnum()):
            gt_chars.append((ch, e["ms"] / 1000.0, j == 0))
    asr_chars = [(ch, w["t0"]) for w in doc["words"] for ch in w["text"] if ch.isalnum()]
    sm = difflib.SequenceMatcher(None, [c for c, *_ in gt_chars], [c for c, _ in asr_chars], autojunk=False)
    errs = sorted(abs(asr_chars[b.b + i][1] - gt_chars[b.a + i][1]) * 1000 for b in sm.get_matching_blocks() for i in range(b.size) if gt_chars[b.a + i][2])
    assert errs and statistics.median(errs) <= 120 and errs[int(0.9 * (len(errs) - 1))] <= 350, errs
    # CPU int8：RTF ≤ 0.6
    r3 = OA.transcribe_media({**args, "device": "cpu", "force": True, "keep_loaded": False}, Ctx())
    assert (r3["device"], r3["computeType"]) == ("cpu", "int8") and r3["rtf"] <= 0.6, r3
    print(json.dumps({"gpuSecond": r2["seconds"], "gpuRtf": r2["rtf"], "load": r2["loadSeconds"], "similarity": round(sim, 3), "onsetMedianMs": round(statistics.median(errs), 1),
                      "onsetP90Ms": round(errs[int(0.9 * (len(errs) - 1))], 1), "onsets": len(errs), "cpuSeconds": r3["seconds"], "cpuRtf": r3["rtf"], "text": text}, ensure_ascii=False))
