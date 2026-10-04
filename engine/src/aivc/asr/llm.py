"""選配：本機 LLM（OpenAI 相容端點，例如 LM Studio `http://localhost:1234/v1`）校對字幕（研究規格 §4 captions.refine）。

實測（qwen/qwen3.8-27b）決定的做法：
- 預設 thinking 模式會把 token 全花在推理、content 是空的（`/no_think` 沒用）→ 一律送 `chat_template_kwargs.enable_thinking=false`
  與 `reasoning_effort: "none"`、temperature 0。
- 逐 token JSON 的輸出格式 38 個 token 要吐 603 個輸出 token → 改成「一行一段、詞邊界用 `|`」，回傳 `{cues:[{id,text,emphasis}]}`。
- GPU 被佔滿時約 4 token/s：每批 ≤ 20 段或 600 字、每個請求 120 s 逾時、每批之間檢查取消。
- 模型挑的「關鍵字」會是單一字元（樂、8。），所以強調只在對應到**完整的詞**時才採用。
- 套用規則：與原文相似度 < 0.6 或長度比不在 0.7–1.4 → 整段拒絕（避免 LLM 改寫句意）。
端點連不上 → 回報警告、原樣返回（轉錄結果不能因為選配功能失敗而丟掉）。
"""
from __future__ import annotations

import difflib
import json
import urllib.error
import urllib.request
from dataclasses import dataclass, field, replace
from typing import Any, Sequence

from ..captions import text as T
from ..captions.normalize import AsrWord, remap_texts

BATCH_SEGMENTS = 20
BATCH_CHARS = 600
TIMEOUT_S = 120.0
MIN_SIMILARITY = 0.6
LEN_RATIO = (0.7, 1.4)

SYSTEM_PROMPT = (
    "你是影片字幕校對員。輸入每行一段字幕，格式「段落編號<TAB>文字」，文字中的 | 是詞與詞的邊界。"
    "只做這些事：修正明顯的同音錯字、補上或修正標點、改成台灣繁體中文用詞；不要改寫句意、不要增刪內容、不要翻譯。"
    "保留 | 詞邊界（可以合併或拆開相鄰的詞）。emphasis 列出每段最值得強調的 0–2 個完整詞（數字、專有名詞、關鍵動作）。"
    "只輸出 JSON。"
)

RESPONSE_SCHEMA = {
    "type": "json_schema",
    "json_schema": {
        "name": "caption_refine",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "cues": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"id": {"type": "integer"}, "text": {"type": "string"}, "emphasis": {"type": "array", "items": {"type": "string"}}},
                        "required": ["id", "text", "emphasis"],
                    },
                }
            },
            "required": ["cues"],
        },
    },
}


@dataclass
class RefineReport:
    endpoint: str
    model: str | None = None
    reachable: bool = False
    proposals: list[dict[str, Any]] = field(default_factory=list)
    applied: int = 0
    rejected: int = 0
    warnings: list[str] = field(default_factory=list)
    seconds: float = 0.0

    def to_json(self) -> dict[str, Any]:
        return {"endpoint": self.endpoint, "model": self.model, "reachable": self.reachable, "applied": self.applied, "rejected": self.rejected, "proposals": self.proposals, "warnings": self.warnings, "seconds": round(self.seconds, 2)}


def _url(base: str, path: str) -> str:
    return base.rstrip("/") + "/" + path.lstrip("/")


def _http_json(url: str, payload: dict[str, Any] | None, timeout: float) -> Any:
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"}, method="GET" if payload is None else "POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310 — 使用者指定的本機端點
        return json.loads(r.read().decode("utf-8"))


def list_models(base: str, timeout: float = 3.0) -> list[str] | None:
    """GET /models；連不上 / 不是 OpenAI 形狀 → None。"""
    try:
        d = _http_json(_url(base, "models"), None, timeout)
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None
    items = d.get("data") if isinstance(d, dict) else None
    if not isinstance(items, list):
        return None
    return [str(m.get("id")) for m in items if isinstance(m, dict) and m.get("id")]


def batches(groups: Sequence[Sequence[AsrWord]]) -> list[list[int]]:
    out: list[list[int]] = []
    cur: list[int] = []
    chars = 0
    for i, g in enumerate(groups):
        n = sum(len(w.text) for w in g)
        if cur and (len(cur) >= BATCH_SEGMENTS or chars + n > BATCH_CHARS):
            out.append(cur)
            cur, chars = [], 0
        cur.append(i)
        chars += n
    if cur:
        out.append(cur)
    return out


def accept(before: str, after: str) -> tuple[bool, str]:
    if not after.strip():
        return False, "空白"
    ratio = difflib.SequenceMatcher(None, before, after, autojunk=False).ratio()
    lr = len(after) / max(1, len(before))
    if ratio < MIN_SIMILARITY:
        return False, f"相似度 {ratio:.2f} < {MIN_SIMILARITY}"
    if not LEN_RATIO[0] <= lr <= LEN_RATIO[1]:
        return False, f"長度比 {lr:.2f} 超出 {LEN_RATIO}"
    return True, f"相似度 {ratio:.2f}"


def apply_text(words: list[AsrWord], after_piped: str, emphasis: Sequence[str]) -> list[AsrWord]:
    """把 LLM 的新文字分回原本的詞（時間不動）。`|` 段數與詞數相同 → 一對一；否則 difflib 對齊。"""
    pieces = [p.strip() for p in after_piped.split("|")]
    if len(pieces) == len(words) and all(pieces):
        texts = pieces
    else:
        texts = remap_texts([w.text for w in words], after_piped.replace("|", ""))
    out: list[AsrWord] = []
    for w, t in zip(words, texts):
        if not t:
            if out:
                out[-1].end = max(out[-1].end, w.end)
            continue
        if t != w.text:
            w.text = t
            w.source = "llm"
        out.append(w)
    emph = [e.strip() for e in emphasis if e and len(e.strip()) >= 2]
    for w in out:
        if any(w.text.strip("，。！？、,.!?") == e for e in emph):
            w.emphasis = True
    return out


BAD_OUTPUT_PREFIX = "本機 LLM 回傳格式不正確"


def parse_cues(content: Any) -> tuple[list[Any], str | None]:
    """chat 回覆的 content → (`cues` 陣列, 錯誤說明)。任何形狀不對都回 ([], 說明)，**不丟例外**。

    實測與驗證者抓到的壞形狀：頂層是陣列而不是物件、`cues` 不是陣列、content 不是字串（部分伺服器回 list of parts）、
    JSON 本身壞掉。以前 `json.loads(content).get("cues")` 在陣列上直接 AttributeError，整個 captions.refine 以 Internal 失敗。
    """
    if not isinstance(content, str):
        return [], f"content 不是字串（{type(content).__name__}）"
    try:
        doc = json.loads(content)
    except ValueError as e:
        return [], f"不是合法 JSON（{e}）"
    if not isinstance(doc, dict):
        return [], f"頂層應該是物件，收到 {type(doc).__name__}"
    cues = doc.get("cues")
    if not isinstance(cues, list):
        return [], "缺少 cues 陣列" if cues is None else f"cues 應該是陣列，收到 {type(cues).__name__}"
    return cues, None


def parse_cue(c: Any, allowed: Sequence[int]) -> tuple[int, str, list[str]] | None:
    """一筆建議 → (段落編號, 文字, 強調詞)；不是物件、id 不是整數或不在這一批、text 不是字串 → None。emphasis 壞掉只當沒有強調。"""
    if not isinstance(c, dict):
        return None
    cid = c.get("id")
    if isinstance(cid, bool):
        return None
    if isinstance(cid, str) and cid.strip().lstrip("-").isdigit():
        cid = int(cid.strip())
    if not isinstance(cid, int) or cid not in allowed:
        return None
    text = c.get("text")
    if not isinstance(text, str):
        return None
    emph = c.get("emphasis")
    emphasis = [e for e in emph if isinstance(e, str)] if isinstance(emph, list) else []
    return cid, text, emphasis


def refine(words: list[AsrWord], base_url: str, ctx: Any, *, model: str | None = None, apply: bool = True, timeout: float = TIMEOUT_S) -> tuple[list[AsrWord], RefineReport]:
    """回傳 (詞, 報告)。**任何失敗都降級成警告**：連不上、逾時、回傳格式不對、單筆建議壞掉 → 那一批／那一筆保留原文。
    套用建議時在副本上改，成功才換上去 —— 中途出任何例外，呼叫端拿到的詞都不會是改到一半的狀態。"""
    import time

    t0 = time.perf_counter()
    rep = RefineReport(endpoint=base_url)
    models = list_models(base_url)
    if models is None:
        rep.warnings.append(f"本機 LLM 端點 {base_url} 無法連線，略過校對")
        return words, rep
    rep.reachable = True
    rep.model = model or (models[0] if models else None)
    if not rep.model:
        rep.warnings.append("本機 LLM 端點沒有載入任何模型，略過校對")
        return words, rep
    groups: list[list[AsrWord]] = []
    for w in words:
        if groups and groups[-1][-1].seg == w.seg:
            groups[-1].append(w)
        else:
            groups.append([w])
    todo = batches(groups)
    for bi, idxs in enumerate(todo):
        ctx.check_cancel()
        ctx.progress("asr.refine", bi, len(todo))
        lines = [f"{i}\t" + "|".join(w.text for w in groups[i]) for i in idxs]
        payload = {
            "model": rep.model,
            "temperature": 0,
            "messages": [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": "\n".join(lines)}],
            "response_format": RESPONSE_SCHEMA,
            "chat_template_kwargs": {"enable_thinking": False},
            "reasoning_effort": "none",
        }
        try:
            resp = _http_json(_url(base_url, "chat/completions"), payload, timeout)
            content = resp["choices"][0]["message"]["content"]
        except (urllib.error.URLError, OSError, ValueError, KeyError, IndexError, TypeError, TimeoutError) as e:
            rep.warnings.append(f"第 {bi + 1}/{len(todo)} 批校對失敗（{type(e).__name__}: {e}），保留原文")
            continue
        cues, why_bad = parse_cues(content)
        if why_bad is not None:
            # 前端 pipeline/captionWarnings.ts 用「本機 LLM 回傳格式不正確」開頭辨識這類警告（llmBadOutput）
            rep.warnings.append(f"{BAD_OUTPUT_PREFIX}（第 {bi + 1}/{len(todo)} 批：{why_bad}），保留原文")
            continue
        bad = 0
        for c in cues:
            parsed = parse_cue(c, idxs)
            if parsed is None:
                bad += 1
                continue
            i, after_piped, emphasis = parsed
            before = T.join_words(w.text for w in groups[i])
            after = T.join_words(p for p in after_piped.split("|"))
            ok, why = accept(before.replace(" ", ""), after.replace(" ", ""))
            prop = {"segment": i, "before": before, "after": after, "emphasis": emphasis, "accepted": ok, "reason": why}
            rep.proposals.append(prop)
            if not ok:
                rep.rejected += 1
                continue
            if before == after and not prop["emphasis"]:
                continue
            if apply:
                try:
                    # 副本上套用：apply_text 會就地改詞，失敗時原本的詞不能被改到一半
                    groups[i] = apply_text([replace(w, flags=set(w.flags)) for w in groups[i]], after_piped, prop["emphasis"])
                except Exception as e:  # noqa: BLE001 — 選配功能，任何意外都不能讓轉錄結果丟失
                    prop["accepted"], prop["reason"] = False, f"套用失敗（{type(e).__name__}: {e}）"
                    rep.warnings.append(f"{BAD_OUTPUT_PREFIX}（第 {bi + 1}/{len(todo)} 批第 {i} 段套用失敗：{type(e).__name__}），保留原文")
                    continue
                rep.applied += 1
        if bad:
            rep.warnings.append(f"{BAD_OUTPUT_PREFIX}（第 {bi + 1}/{len(todo)} 批有 {bad} 筆建議缺欄位或不是物件，已略過），其餘照常處理")
    ctx.progress("asr.refine", len(todo), len(todo))
    rep.seconds = time.perf_counter() - t0
    return [w for g in groups for w in g], rep
