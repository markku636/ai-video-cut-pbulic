"""AI 配音（文字轉語音）：`aivc tts-speakers --endpoint <url>` 與 `aivc tts --endpoint <url> --voice <id> --text <話> --out <wav>`。

對標 CapCut 的「文字轉語音」、Descript 的 Overdub：打一段字、挑一個聲音、生成旁白放到音軌。
後端是自架的 Seal-TTS REST API（`/v1/speakers` 列聲音、`/v1/tts` 合成），金鑰走 keychain
（跟 Anthropic 一樣由 Rust `inject_secrets` 塞進 `api_key`，前端與 log 都碰不到）。

## 為什麼在引擎裡

同 `assistant.chat`：App 的 CSP 不讓前端連外，對外 HTTP 一律經引擎。
合成回來的是整段音訊位元組（`response_mode: stream`），這裡直接寫成檔案 —— 大 payload 一律走檔案路徑（協定決策 7）。

## 檔案格式

預設 `wav`：放上序列要逐樣本對齊，無損最省事；`mp3` 給只想存檔分享的人。
"""

from __future__ import annotations

import argparse
import json
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .. import env
from ..atomic import write_bytes
from . import Ctx, OpError, register

STAGE = "tts.synth"
DEFAULT_TIMEOUT_S = 180.0
DEFAULT_FORMAT = "wav"
FORMATS = ("wav", "mp3")
#: 一次合成的字數上限：再長就該分段（每段一個檔，時間軸上也好挪）。
MAX_CHARS = 2000
SPEED_RANGE = (0.5, 2.0)


def _url(base: str, path: str) -> str:
    return base.rstrip("/") + "/" + path.lstrip("/")


def _headers(api_key: str | None) -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    if api_key:
        h["X-API-Key"] = api_key
    return h


def _fail(endpoint: str, e: Exception) -> OpError:
    if isinstance(e, urllib.error.HTTPError):
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:200]
        except Exception:  # noqa: BLE001
            pass
        # 金鑰絕對不可以進錯誤訊息；伺服器回的 detail 也只留前 200 字
        hint = "金鑰不對或沒有權限；到設定重貼一次" if e.code in (401, 403) else detail
        return OpError("Agent", f"TTS 伺服器回 HTTP {e.code}", hint=hint)
    return OpError("Agent", f"連不上 TTS 伺服器 {endpoint}", hint="確認位址（例如 http://localhost:7866）與網路；伺服器要先啟動")


def parse_speakers(doc: Any) -> list[dict[str, Any]]:
    """`/v1/speakers` 的回覆 → 只留 `status == ready` 的聲音，欄位收斂成 UI 要的那幾個。"""
    items = doc.get("speakers") if isinstance(doc, dict) else doc
    if not isinstance(items, list):
        return []
    out: list[dict[str, Any]] = []
    for s in items:
        if not isinstance(s, dict) or not s.get("id"):
            continue
        if str(s.get("status") or "ready") != "ready":
            continue
        out.append(
            {
                "id": str(s["id"]),
                "name": str(s.get("display_name") or s.get("name") or s["id"]),
                "gender": s.get("gender"),
                "engine": s.get("engine"),
                "paradigm": s.get("paradigm"),
            }
        )
    return out


def _speakers_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--endpoint", required=True, help="Seal-TTS 位址（例如 http://localhost:7866）")
    p.add_argument("--api-key", default=None, help="金鑰。不會寫進 log 或結果")
    p.add_argument("--timeout", type=float, default=None, help="逾時秒數（預設 15）")


@register("tts.speakers", cli="tts-speakers", help="列出 TTS 伺服器上可用的聲音（設定頁的「測試連線」與配音對話框的下拉）", args=_speakers_args)
def tts_speakers(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    endpoint = str(args.get("endpoint") or "").strip()
    if not endpoint:
        raise OpError("Invalid", "沒有給 TTS 位址", hint="到設定填 AI 配音的伺服器位址")
    timeout = 15.0 if args.get("timeout") is None else float(args["timeout"])
    req = urllib.request.Request(_url(endpoint, "v1/speakers"), headers=_headers(args.get("api_key")), method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 — 使用者自己指定的端點
            doc = json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as e:
        raise _fail(endpoint, e) from e
    speakers = parse_speakers(doc)
    return {
        "endpoint": endpoint,
        "speakers": speakers,
        "_human": f"{endpoint} 通了，{len(speakers)} 個聲音" + (f"：{'、'.join(s['name'] for s in speakers[:5])}" if speakers else "（沒有 ready 的聲音）"),
    }


def _synth_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--endpoint", required=True, help="Seal-TTS 位址")
    p.add_argument("--api-key", default=None, help="金鑰。不會寫進 log 或結果")
    p.add_argument("--voice", required=True, help="聲音 id（tts-speakers 列出來的）")
    p.add_argument("--text", required=True, help="要唸的字")
    p.add_argument("--out", required=True, help="輸出音檔路徑（副檔名決定格式：.wav / .mp3）")
    p.add_argument("--speed", type=float, default=None, help="語速倍率（預設 1.0，0.5–2.0）")
    p.add_argument("--instruct", default=None, help="情緒／語氣指令（選填，伺服器支援才有效）")
    p.add_argument("--timeout", type=float, default=None, help=f"逾時秒數（預設 {DEFAULT_TIMEOUT_S:g}）")


def synth_payload(voice: str, text: str, fmt: str, speed: float | None, instruct: str | None) -> dict[str, Any]:
    """`/v1/tts` 的 body。`response_mode: stream` = 直接回音訊位元組；`normalize` 讓多段旁白音量一致。"""
    body: dict[str, Any] = {"speaker": voice, "text": text, "response_mode": "stream", "format": fmt, "normalize": True, "best_of": 1}
    if speed is not None and abs(speed - 1.0) > 1e-6:
        body["speed"] = speed
    if instruct:
        body["instruct"] = instruct
    return body


@register("tts.synth", cli="tts", help="AI 配音：一段文字 → 音檔（Seal-TTS 伺服器合成，金鑰走 keychain）", args=_synth_args)
def tts_synth(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    endpoint = str(args.get("endpoint") or "").strip()
    if not endpoint:
        raise OpError("Invalid", "沒有給 TTS 位址", hint="到設定填 AI 配音的伺服器位址")
    voice = str(args.get("voice") or "").strip()
    if not voice:
        raise OpError("Invalid", "沒有選聲音")
    text = re.sub(r"\s+", " ", str(args.get("text") or "")).strip()
    if not text:
        raise OpError("Invalid", "沒有要唸的字")
    if len(text) > MAX_CHARS:
        raise OpError("Invalid", f"文字太長（{len(text)} 字，上限 {MAX_CHARS}）", hint="分成幾段各做一個檔，時間軸上也比較好挪")
    out = Path(env.normalize_path(str(args.get("out") or "")))
    if not str(args.get("out") or "").strip():
        raise OpError("Invalid", "沒有給輸出路徑")
    fmt = out.suffix.lower().lstrip(".") or DEFAULT_FORMAT
    if fmt not in FORMATS:
        raise OpError("Invalid", f"不支援的格式 .{fmt}", hint="用 .wav 或 .mp3")
    speed = None if args.get("speed") is None else float(args["speed"])
    if speed is not None and not (SPEED_RANGE[0] <= speed <= SPEED_RANGE[1]):
        raise OpError("Invalid", f"語速 {speed:g} 超出範圍 {SPEED_RANGE[0]}–{SPEED_RANGE[1]}")
    timeout = DEFAULT_TIMEOUT_S if args.get("timeout") is None else float(args["timeout"])

    ctx.progress(STAGE, 0, 2, message="合成")
    payload = synth_payload(voice, text, fmt, speed, args.get("instruct"))
    req = urllib.request.Request(
        _url(endpoint, "v1/tts"),
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers=_headers(args.get("api_key")),
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
            ctype = str(r.headers.get("Content-Type") or "")
            data = r.read()
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as e:
        raise _fail(endpoint, e) from e
    ctx.check_cancel()
    if not data:
        raise OpError("Agent", "TTS 伺服器回了空的音訊")
    if "json" in ctype.lower():
        # 伺服器改回 JSON（例如錯誤物件、或 url 模式）就講清楚，不要把 JSON 存成 .wav
        snippet = data[:200].decode("utf-8", "replace")
        raise OpError("Agent", "TTS 伺服器回的不是音訊", hint=snippet)
    out.parent.mkdir(parents=True, exist_ok=True)
    write_bytes(out, data)
    ctx.progress(STAGE, 2, 2)
    ctx.artifact(str(out), f"audio.{fmt}")
    return {
        "endpoint": endpoint,
        "voice": voice,
        "chars": len(text),
        "format": fmt,
        "bytes": len(data),
        "out": str(out),
        "_human": f"{len(text)} 字 → {out.name}（{len(data) / 1024:.0f} KB）",
    }
