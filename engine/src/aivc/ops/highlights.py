"""`aivc highlights <project> [--media ID] --endpoint <url>`（op `assistant.highlights`）：從字幕挑出最值得單獨拿出來的幾段。

對標 Opus Clip、CapCut 的「AI 精華」、Descript 的 Highlights：長片 → 幾段能直接當短影音的精華。
材料跟章節一樣是字幕的逐字稿；模型只做語意的那一半（哪一段有鉤子、講完了一個完整的想法、值得幾分），
時間的部分全在這裡：

- 起訖吸到字幕段的**起點／終點**（模型講的秒數常常切在半句）；
- 每段長度夾在 `--min-len`／`--max-len` 之間（太短丟掉、太長從起點截到上限）；
- 重疊的只留分數高的；最多 `--count` 段。

回傳的每一段附 `cps`（每秒幾個字，從字幕算），讓 UI 可以標出「講得很快／幾乎沒講話」的段落 —— 那是模型看不到的客觀訊號。
跟 `assistant.chapters` 同一個原則：**不寫專案**，App 列出來讓人挑，按了才加標記／建序列。
"""

from __future__ import annotations

import argparse
import re
from typing import Any

from .. import env
from ..llm.client import DEFAULT_TIMEOUT_S, chat, extract_json_object
from . import Ctx, OpError, register
from .chapters import _clean_title, _load, _num, compact_transcript, lang_name, transcript_lines

STAGE = "assistant.highlights"
DEFAULT_COUNT = 5
DEFAULT_MIN_S = 15.0
DEFAULT_MAX_S = 60.0
SNAP_TOL_S = 3.0
#: 兩段重疊超過較短那段的這個比例就當同一段。
OVERLAP_FRAC = 0.3
MAX_TOKENS = 2048
REASON_MAX = 120


def _args(p: argparse.ArgumentParser) -> None:
    p.add_argument("project", help="專案檔 *.aivc.json")
    p.add_argument("--media", default=None)
    p.add_argument("--endpoint", required=True, help="OpenAI 相容端點（…/v1）或 Anthropic base url")
    p.add_argument("--provider", default="openai", choices=["openai", "anthropic"])
    p.add_argument("--model", default=None)
    p.add_argument("--api-key", default=None, help="金鑰（Anthropic 必要）。不會寫進 log 或結果")
    p.add_argument("--language", default=None, help="標題與理由的語言（預設跟字幕一樣）")
    p.add_argument("--count", type=int, default=None, help=f"最多幾段（預設 {DEFAULT_COUNT}）")
    p.add_argument("--min-len", type=float, default=None, help=f"每段至少幾秒（預設 {DEFAULT_MIN_S:g}）")
    p.add_argument("--max-len", type=float, default=None, help=f"每段最多幾秒（預設 {DEFAULT_MAX_S:g}）")
    p.add_argument("--timeout", type=float, default=None)


# ---------------------------------------------------------------- 純函式


def system_prompt(duration_s: float, language: str | None, count: int, min_s: float, max_s: float) -> str:
    lang = lang_name(language)
    return (
        "你是短影音剪輯師。輸入是一支影片的逐字稿，每行「[時間] 內容」。"
        f"影片長 {duration_s:.0f} 秒。\n"
        f"請挑出最多 {count} 段最值得單獨拿出來當短影音的精華，每段 {min_s:g}–{max_s:g} 秒。"
        "一段要是**完整的一個想法**：開頭有鉤子（一句話就讓人想看下去）、講完有收，不要切在半句。"
        "起訖秒數要用逐字稿裡真的有的時間，不要自己編；段與段不要重疊。\n"
        f"每段給：title（{lang}，像短影音標題那樣短、有吸引力，15 字以內）、reason（{lang}，一句話講為什麼值得）、score（1–10，越高越值得）。\n"
        "只輸出一個 JSON 物件，不要有其他文字：\n"
        '{"clips": [{"start": 秒數, "end": 秒數, "title": "...", "reason": "...", "score": 8}]}'
    )


def _overlap(a: tuple[float, float], b: tuple[float, float]) -> float:
    lo, hi = max(a[0], b[0]), min(a[1], b[1])
    return max(0.0, hi - lo)


def parse_clips(obj: Any, duration_s: float, min_s: float, max_s: float, count: int) -> tuple[list[dict[str, Any]], list[str]]:
    """模型的 JSON → (精華段, 警告)。壞掉的單筆只丟那一筆。回傳依分數由高到低。"""
    warnings: list[str] = []
    if not isinstance(obj, dict):
        return [], ["模型沒有照格式回 JSON 物件"]
    raw = obj.get("clips", obj.get("highlights"))
    if not isinstance(raw, list):
        return [], ["模型沒有回 clips 陣列"]
    items: list[dict[str, Any]] = []
    for it in raw:
        if not isinstance(it, dict):
            warnings.append("有一筆不是物件，已略過")
            continue
        title = _clean_title(it.get("title", ""))
        start = _num(it.get("start"))
        end = _num(it.get("end"))
        if start is None or end is None:
            warnings.append(f"「{title or '?'}」缺起訖秒數，已略過")
            continue
        start = max(0.0, start)
        end = min(float(duration_s), end)
        if end <= start:
            warnings.append(f"「{title or '?'}」的終點不在起點之後，已略過")
            continue
        if end - start < min_s * 0.5:
            warnings.append(f"「{title or '?'}」只有 {end - start:.0f} 秒，太短，已略過")
            continue
        if end - start > max_s * 2:
            warnings.append(f"「{title or '?'}」有 {end - start:.0f} 秒，太長，已截到 {max_s:g} 秒")
            end = start + max_s
        score = _num(it.get("score"))
        score = 5.0 if score is None else max(1.0, min(10.0, score))
        reason = re.sub(r"\s+", " ", str(it.get("reason") or "")).strip()[:REASON_MAX]
        items.append({"start": start, "end": end, "title": title, "reason": reason, "score": score})
    items.sort(key=lambda c: (-c["score"], c["start"]))
    kept: list[dict[str, Any]] = []
    for c in items:
        span = (c["start"], c["end"])
        clash = None
        for k in kept:
            ov = _overlap(span, (k["start"], k["end"]))
            if ov > OVERLAP_FRAC * min(span[1] - span[0], k["end"] - k["start"]):
                clash = k
                break
        if clash is not None:
            warnings.append(f"「{c['title'] or '?'}」跟「{clash['title'] or '?'}」重疊，只留分數高的")
            continue
        kept.append(c)
        if len(kept) >= count:
            break
    if len(items) > len(kept) + sum(1 for w in warnings if "重疊" in w):
        warnings.append(f"模型給了 {len(items)} 段，只留前 {count} 段")
    return kept, warnings


def snap_clips(clips: list[dict[str, Any]], cue_starts: list[float], cue_ends: list[float], tol_s: float = SNAP_TOL_S) -> list[dict[str, Any]]:
    """起點吸到最近的字幕段起點、終點吸到最近的段終點（容忍內）。吸完反過來就退回原值。"""

    def nearest(x: float, xs: list[float]) -> float:
        best = None
        for v in xs:
            if abs(v - x) <= tol_s and (best is None or abs(v - x) < abs(best - x)):
                best = v
        return x if best is None else best

    out: list[dict[str, Any]] = []
    for c in clips:
        s = nearest(float(c["start"]), cue_starts)
        e = nearest(float(c["end"]), cue_ends)
        if e <= s:
            s, e = float(c["start"]), float(c["end"])
        out.append({**c, "start": s, "end": e})
    return out


def chars_per_second(cues: list[dict[str, Any]], fps: float, start_s: float, end_s: float) -> float:
    """這段裡每秒講幾個字（字幕的字數 / 段長）：模型看不到的客觀訊號。"""
    if end_s <= start_s:
        return 0.0
    n = 0
    for c in cues:
        a, b = float(c.get("startFrame", 0)) / fps, float(c.get("endFrame", 0)) / fps
        if b <= start_s or a >= end_s:
            continue
        text = "".join(str(w.get("text", "")) for w in (c.get("words") or []))
        frac = (min(b, end_s) - max(a, start_s)) / max(1e-6, b - a)
        n += len(re.sub(r"\s", "", text)) * frac
    return round(n / (end_s - start_s), 2)


# ---------------------------------------------------------------- op


@register("assistant.highlights", cli="highlights", help="AI 精華片段：從字幕挑出最值得單獨拿出來的幾段（短影音候選）", args=_args)
def highlights_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    endpoint = str(args.get("endpoint") or "").strip()
    if not endpoint:
        raise OpError("Invalid", "沒有給 LLM 端點", hint="到設定填 AI 助手的端點")
    provider = str(args.get("provider") or "openai")
    timeout = DEFAULT_TIMEOUT_S if args.get("timeout") is None else float(args["timeout"])
    count = DEFAULT_COUNT if args.get("count") is None else max(1, int(args["count"]))
    min_s = DEFAULT_MIN_S if args.get("min_len") is None else max(1.0, float(args["min_len"]))
    max_s = DEFAULT_MAX_S if args.get("max_len") is None else max(min_s, float(args["max_len"]))

    ctx.progress(STAGE, 0, 3, message="讀字幕")
    track, fps, n_frames = _load(args, ctx)
    cues = list(track.get("cues") or [])
    lines = transcript_lines(cues, fps)
    if not lines:
        raise OpError("Invalid", "字幕裡沒有任何文字", hint="先產生字幕")
    duration_s = n_frames / fps if n_frames > 0 else lines[-1][0] + 1
    if duration_s < min_s:
        raise OpError("Invalid", f"影片只有 {duration_s:.0f} 秒，比每段最短的 {min_s:g} 秒還短", hint="把「每段至少幾秒」調低")
    language = str(args.get("language") or track.get("language") or "zh-TW")
    transcript = compact_transcript(lines)

    ctx.progress(STAGE, 1, 3, message="問模型")
    r = chat(
        endpoint,
        [{"role": "user", "content": transcript}],
        provider=provider,
        model=args.get("model") or None,
        api_key=args.get("api_key"),
        system=system_prompt(duration_s, language, count, min_s, max_s),
        max_tokens=MAX_TOKENS,
        timeout=timeout,
    )
    ctx.check_cancel()
    ctx.progress(STAGE, 2, 3, message="整理片段")
    obj = extract_json_object(r.text)
    if obj is None:
        raise OpError("Agent", "模型沒有照格式回 JSON", hint="換一個大一點的模型，或再試一次（回覆開頭：" + r.text.strip()[:60].replace("\n", " ") + "）")
    clips, warnings = parse_clips(obj, duration_s, min_s, max_s, count)
    if not clips:
        raise OpError("Agent", "模型沒有挑出任何可用的片段", hint="；".join(warnings[:3]) or "再試一次或換模型")
    starts = [float(c.get("startFrame", 0)) / fps for c in cues]
    ends = [float(c.get("endFrame", 0)) / fps for c in cues]
    clips = snap_clips(clips, starts, ends)
    out = [
        {
            "startFrame": int(round(c["start"] * fps)),
            "endFrame": max(int(round(c["start"] * fps)) + 1, int(round(c["end"] * fps))),
            "start": round(float(c["start"]), 3),
            "end": round(float(c["end"]), 3),
            "title": c["title"],
            "reason": c["reason"],
            "score": float(c["score"]),
            "cps": chars_per_second(cues, fps, float(c["start"]), float(c["end"])),
        }
        for c in clips
    ]
    ctx.progress(STAGE, 3, 3)
    for w in warnings:
        ctx.log("warn", w)
    total = sum(c["end"] - c["start"] for c in out)
    return {
        "endpoint": r.endpoint,
        "provider": r.provider,
        "model": r.model,
        "language": language,
        "clips": out,
        "warnings": warnings,
        "transcriptChars": len(transcript),
        "_human": f"{len(out)} 段精華、共 {total:.0f} 秒（{r.model}）" + (f"，{len(warnings)} 則警告" if warnings else ""),
    }
