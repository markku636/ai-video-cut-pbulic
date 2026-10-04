"""LLM 端點的共用客戶端（`aivc.llm.client`）。

`ops/assistant.py`（對話）、`ops/chapters.py`（章節與摘要）與之後所有「把文字送去模型」的 op
都走同一支 `chat()`：端點解析、模型挑選、兩種協定（OpenAI 相容／Anthropic Messages）、金鑰不進 log，
只寫一份。字幕校對（`asr/llm.py`）比這早、而且需要 json_schema 回應格式與批次，暫時保留它自己那份。
"""
