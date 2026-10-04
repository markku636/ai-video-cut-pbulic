"""`aivc assist --endpoint <url> --message <話>`（op `assistant.chat`）：把一句話變成一份可執行的計畫。

## 為什麼在引擎裡而不是前端直接打

App 的 CSP 只允許 `self` 與 IPC（`tauri.conf.json` 的 `connect-src`）—— 前端**連不出去**，
那是刻意的。所以對外的 HTTP 一律走這裡，跟字幕校對（`asr/llm.py`）同一條路、
同一個端點設定，使用者也只要設定一次。

## 這支不執行任何東西

它只回模型講的話與一份 JSON 計畫。**計畫由 App 驗證、列給人看、人按了才執行**
（`src/assistant/protocol.ts`）。引擎這邊刻意不碰專案，一方面是權限（能不能剪要問指令自己的
`enabled()`，那在前端），一方面是「看得懂正在發生什麼」本身就是這個功能的一部分。

## 支援兩種端點

- **OpenAI 相容**（LM Studio、Ollama、llama.cpp、vLLM…）：預設，不需要金鑰。
- **Anthropic Messages**：`--provider anthropic`，金鑰由 App 從 keychain 取出來用 `--api-key` 帶進來。
  **金鑰不會進 log、不會寫進結果**（`_human` 與回傳值都只講端點）。

HTTP 與協定細節在 `aivc.llm.client`（章節與摘要等其他 LLM op 共用）；這裡只剩訊息的解析與 op 的殼。
"""

from __future__ import annotations

import argparse
from typing import Any

from ..llm.client import DEFAULT_MAX_TOKENS, DEFAULT_TIMEOUT_S, anthropic_text, chat, list_models, openai_text
from . import Ctx, OpError, register

__all__ = ["anthropic_text", "assistant_chat", "assistant_models", "openai_text", "parse_messages"]

STAGE = "assistant.chat"


def _args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--endpoint", required=True, help="OpenAI 相容端點（…/v1）或 Anthropic base url")
    p.add_argument("--provider", default="openai", choices=["openai", "anthropic"], help="端點的協定（預設 openai 相容）")
    p.add_argument("--model", default=None, help="模型名稱；OpenAI 相容端點不給就用它列出來的第一個")
    p.add_argument("--api-key", default=None, help="金鑰（Anthropic 必要）。不會寫進 log 或結果")
    p.add_argument("--system", default=None, help="system prompt（App 會把工具表放這裡）")
    p.add_argument("--message", action="append", required=True, metavar="ROLE:TEXT", help="對話內容，例如 user:把 12 秒到 20 秒剪掉（可重複）")
    p.add_argument("--max-tokens", type=int, default=None, help=f"回覆長度上限（預設 {DEFAULT_MAX_TOKENS}）")
    p.add_argument("--timeout", type=float, default=None, help=f"逾時秒數（預設 {DEFAULT_TIMEOUT_S}）")


def parse_messages(raw: list[str]) -> list[dict[str, str]]:
    """`["user:你好", "assistant:嗨"]` → OpenAI 形狀的訊息串。

    沒寫 role 的一律當 `user`：讓 CLI 好用（`--message "把開頭剪掉"`），
    而 App 一定會寫清楚。冒號只切第一個 —— 訊息本身常常有冒號。
    """
    out: list[dict[str, str]] = []
    for s in raw:
        role, sep, text = str(s).partition(":")
        if not sep:
            role, text = "user", str(s)
        role = role.strip().lower()
        if role not in ("user", "assistant", "system"):
            role, text = "user", str(s)
        if text.strip():
            out.append({"role": role, "content": text.strip()})
    if not out:
        raise OpError("Invalid", "沒有任何訊息", hint='用 --message "user:把開頭剪掉"')
    return out


def _probe_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--endpoint", required=True, help="OpenAI 相容端點（…/v1）")
    p.add_argument("--timeout", type=float, default=None, help="逾時秒數（預設 10）")


@register("assistant.models", cli="assist-models", help="列出 LLM 端點上的模型（設定頁的「測試連線」）", args=_probe_args)
def assistant_models(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    """GET /models。

    設定頁要的是**一句立刻看得到的答案**：通不通、有哪些模型。
    所以這支刻意不產生任何 token —— 按一下測試不該讓本機模型跑一次推論。
    """
    endpoint = str(args["endpoint"]).strip()
    if not endpoint:
        raise OpError("Invalid", "沒有給 LLM 端點")
    timeout = 10.0 if args.get("timeout") is None else float(args["timeout"])
    try:
        ids = list_models(endpoint, timeout)
    except OpError as e:
        raise OpError("Agent", f"連不上 {endpoint}", hint="本機模型服務要先啟動；LM Studio 是在 Developer 分頁按 Start Server") from e
    return {
        "endpoint": endpoint,
        "models": ids,
        "_human": f"{endpoint} 通了，{len(ids)} 個模型" + (f"：{'、'.join(ids[:5])}" if ids else "（一個都沒載入）"),
    }


@register("assistant.chat", cli="assist", help="AI 助手：把一句話變成一份可執行的計畫（不執行）", args=_args)
def assistant_chat(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    endpoint = str(args["endpoint"]).strip()
    if not endpoint:
        raise OpError("Invalid", "沒有給 LLM 端點")
    provider = str(args.get("provider") or "openai")
    timeout = DEFAULT_TIMEOUT_S if args.get("timeout") is None else float(args["timeout"])
    max_tokens = DEFAULT_MAX_TOKENS if args.get("max_tokens") is None else int(args["max_tokens"])
    messages = parse_messages(list(args["message"]))
    system = (args.get("system") or "").strip() or None

    ctx.progress(STAGE, 0, 1)
    r = chat(
        endpoint,
        messages,
        provider=provider,
        model=args.get("model") or None,
        api_key=args.get("api_key"),
        system=system,
        max_tokens=max_tokens,
        timeout=timeout,
    )
    ctx.progress(STAGE, 1, 1)
    return {
        "endpoint": r.endpoint,
        "provider": r.provider,
        "model": r.model,
        "text": r.text,
        "_human": f"{r.provider} · {r.model} 回了 {len(r.text)} 個字",
    }
