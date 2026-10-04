"""把一段對話送到 LLM 端點、把文字帶回來。

## 兩種端點

- **OpenAI 相容**（LM Studio、Ollama、llama.cpp、vLLM…）：預設，不需要金鑰；沒指定模型就用端點列出來的第一個。
- **Anthropic Messages**：`provider="anthropic"`，金鑰由 App 從 keychain 取出來帶進 op 參數（`inject_secrets`）。

## 金鑰絕對不進錯誤訊息與結果

所有 `OpError` 只講端點與 HTTP 狀態碼；回傳的 `ChatResult` 也只有端點、協定、模型與文字。
`ops/assistant.py` 的測試守這條。

## 溫度一律 0

這裡送的都是「要模型照格式回 JSON」的請求（計畫、章節、精華），要的是穩定，不是創意。
"""

from __future__ import annotations

import json
import re
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from ..ops import OpError

#: 一次呼叫的預設逾時（秒）。本機小模型第一次載入權重可能很久。
DEFAULT_TIMEOUT_S = 120.0
DEFAULT_MAX_TOKENS = 1024
ANTHROPIC_VERSION = "2023-06-01"


@dataclass(frozen=True)
class ChatResult:
    endpoint: str
    provider: str
    model: str
    text: str


def url_of(base: str, path: str) -> str:
    return base.rstrip("/") + "/" + path.lstrip("/")


def http_json(url: str, payload: dict[str, Any] | None, timeout: float, headers: dict[str, str] | None = None) -> Any:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    h = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(url, data=data, headers=h, method="GET" if payload is None else "POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 — 使用者自己指定的端點
        return json.loads(r.read().decode("utf-8"))


def openai_text(resp: Any) -> str:
    """OpenAI 相容的回覆 → 文字。形狀不對就回空字串（呼叫端會說「模型沒有回東西」）。"""
    try:
        return str(resp["choices"][0]["message"]["content"] or "")
    except (KeyError, IndexError, TypeError):
        return ""


def anthropic_text(resp: Any) -> str:
    """Anthropic Messages 的回覆 → 文字（把所有 text 區塊接起來；thinking 區塊略過）。"""
    try:
        blocks = resp["content"]
    except (KeyError, TypeError):
        return ""
    if not isinstance(blocks, list):
        return ""
    return "".join(str(b.get("text", "")) for b in blocks if isinstance(b, dict) and b.get("type") == "text")


def list_models(endpoint: str, timeout: float) -> list[str]:
    """GET /models → 模型 id 清單。連不上 → OpError（講得出是哪個端點）。"""
    try:
        d = http_json(url_of(endpoint, "models"), None, timeout)
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as e:
        raise OpError("Agent", f"連不上 LLM 端點 {endpoint}", hint="本機模型服務要先啟動，或到設定改端點") from e
    items = d.get("data") if isinstance(d, dict) else None
    return [str(m.get("id")) for m in items if isinstance(m, dict) and m.get("id")] if isinstance(items, list) else []


def pick_model(endpoint: str, want: str | None, timeout: float) -> str:
    """指定了就用指定的；沒有就問端點要第一個。兩個都沒有才報錯。"""
    if want:
        return want
    ids = list_models(endpoint, min(10.0, timeout))
    if not ids:
        raise OpError("Invalid", f"端點 {endpoint} 沒有列出任何模型", hint="先在模型服務裡載入一個模型")
    return ids[0]


def chat(
    endpoint: str,
    messages: list[dict[str, str]],
    *,
    provider: str = "openai",
    model: str | None = None,
    api_key: str | None = None,
    system: str | None = None,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    timeout: float = DEFAULT_TIMEOUT_S,
) -> ChatResult:
    """送一段對話、拿回文字。`messages` 是 OpenAI 形狀（role/content），system 另外給。

    空回覆會直接報 `Internal`：呼叫端不必再各自檢查一次。
    """
    endpoint = (endpoint or "").strip()
    if not endpoint:
        raise OpError("Invalid", "沒有給 LLM 端點")
    msgs = [m for m in messages if m.get("role") != "system"]
    if provider == "anthropic":
        key = (api_key or "").strip()
        if not key:
            raise OpError("Invalid", "Anthropic 需要金鑰", hint="到設定填入 API 金鑰（存在系統 keychain，不會寫進設定檔）")
        if not model:
            raise OpError("Invalid", "Anthropic 要指定模型", hint="到設定填入模型名稱")
        payload: dict[str, Any] = {"model": model, "max_tokens": max_tokens, "messages": msgs}
        if system:
            payload["system"] = system
        try:
            resp = http_json(
                url_of(endpoint, "messages") if "/v1" in endpoint else url_of(endpoint, "v1/messages"),
                payload,
                timeout,
                {"x-api-key": key, "anthropic-version": ANTHROPIC_VERSION},
            )
        except urllib.error.HTTPError as e:
            # 金鑰絕對不可以進錯誤訊息
            raise OpError("Agent", f"Anthropic 回 HTTP {e.code}", hint="檢查金鑰與模型名稱") from e
        except (urllib.error.URLError, OSError, ValueError, TimeoutError) as e:
            if is_timeout(e):
                raise timeout_error(endpoint, timeout) from e
            raise OpError("Agent", f"連不上 {endpoint}") from e
        text = anthropic_text(resp)
        used = model
    else:
        used = pick_model(endpoint, model, timeout)
        payload = {
            "model": used,
            "messages": ([{"role": "system", "content": system}] if system else []) + msgs,
            "temperature": 0,
            "max_tokens": max_tokens,
            # 本機 Qwen3 一類預設 thinking：token 全花在推理、content 空的（asr/llm.py 實測）。
            # 不認得這兩個鍵的伺服器會忽略它們（OpenAI 相容端點對多餘欄位一律不理）。
            "chat_template_kwargs": {"enable_thinking": False},
            "reasoning_effort": "none",
        }
        try:
            resp = http_json(url_of(endpoint, "chat/completions"), payload, timeout)
        except urllib.error.HTTPError as e:
            raise OpError("Agent", f"LLM 端點 {endpoint} 回 HTTP {e.code}", hint="檢查模型名稱；本機服務看它的 log") from e
        except (urllib.error.URLError, OSError, ValueError, TimeoutError) as e:
            if is_timeout(e):
                raise timeout_error(endpoint, timeout) from e
            raise OpError("Agent", f"連不上 LLM 端點 {endpoint}", hint="本機模型服務要先啟動，或到設定改端點") from e
        text = openai_text(resp)
    if not text.strip():
        raise OpError("Internal", "模型沒有回任何東西", hint="換一個模型試試；太小的模型常常回空的")
    return ChatResult(endpoint=endpoint, provider=provider, model=used, text=text)


def is_timeout(e: BaseException) -> bool:
    """urllib 把 socket 逾時包成 URLError(reason=timeout)；直接的 TimeoutError / socket.timeout 也算。"""
    if isinstance(e, (TimeoutError, socket.timeout)):
        return True
    reason = getattr(e, "reason", None)
    return isinstance(reason, (TimeoutError, socket.timeout)) or "timed out" in str(reason or e).lower()


def timeout_error(endpoint: str, timeout: float) -> OpError:
    return OpError(
        "Agent",
        f"LLM 端點 {endpoint} 在 {timeout:.0f} 秒內沒有回應",
        hint="模型可能正在處理別的請求或還在載入；等一下再試，或到設定拉長逾時",
    )


_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def extract_json_object(text: str) -> Any | None:
    """從模型的文字裡挖出第一個 JSON 物件（整段就是 JSON、```json 圍起來、或前後夾著廢話都收）。

    解不出來回 None —— 呼叫端決定要當「模型沒照格式回」還是重試；這裡不猜。
    """
    if not text:
        return None
    candidates = [text.strip()]
    candidates += [m.group(1).strip() for m in _FENCE.finditer(text)]
    a, b = text.find("{"), text.rfind("}")
    if a >= 0 and b > a:
        candidates.append(text[a : b + 1])
    for c in candidates:
        if not c:
            continue
        try:
            v = json.loads(c)
        except ValueError:
            continue
        if isinstance(v, dict):
            return v
    return None
