"""`aivc chapters <project> [--media ID] --endpoint <url>`（op `assistant.chapters`）：從字幕整理出章節、摘要與 YouTube 章節文字。

對標 Descript 的 Chapters、YouTube Studio 的自動章節、CapCut 的 AI 摘要。材料是字幕（ASR 的逐段時間碼），
模型只做**語意**的那一半：哪裡換了話題、這一段該叫什麼、整支在講什麼。時間永遠是我們的：
章節起點會吸到最近的字幕段起點（模型講的秒數常常差個一兩秒），而且每個起點都夾在影片長度內、
彼此至少隔 `--min-gap` 秒、第一章一定從 0 開始（YouTube 章節的硬規定）。

## 這支不寫專案

回傳 `{chapters, summary, title, keywords, youtube}`，App 拿去加標記、複製到剪貼簿；
要不要進專案由人按。跟 `assistant.chat` 同一個原則。

## 字幕太長怎麼辦

送進 prompt 的逐字稿有字數預算（`MAX_CHARS`）。超過就把相鄰的段合併成較粗的窗口，每個窗口保留第一個時間碼與
前面幾十個字 —— 章節看的是「話題什麼時候換」，不需要每個字。一支兩小時的片也只會送幾千字。
"""

from __future__ import annotations

import argparse
import json
import re
from typing import Any

from .. import env
from ..captions.text import join_words
from ..llm.client import DEFAULT_TIMEOUT_S, chat, extract_json_object
from . import Ctx, OpError, register

STAGE = "assistant.chapters"
#: 逐字稿送進 prompt 的字數預算（含時間碼）。
MAX_CHARS = 14000
#: 合併成窗口時每個窗口保留的字數。
WINDOW_CHARS = 90
DEFAULT_MAX_CHAPTERS = 12
DEFAULT_MIN_GAP_S = 20.0
#: 章節起點吸到字幕段起點的容忍（秒）。
SNAP_TOL_S = 3.0
#: 章節標題最長（字元）；再長就不是標題是句子。
TITLE_MAX = 40
MAX_TOKENS = 2048

LANG_NAME = {
    "zh-tw": "台灣繁體中文",
    "zh-hant": "繁體中文",
    "zh": "繁體中文",
    "zh-cn": "简体中文",
    "zh-hans": "简体中文",
    "en": "English",
    "ja": "日本語",
    "ko": "한국어",
}


def _args(p: argparse.ArgumentParser) -> None:
    p.add_argument("project", help="專案檔 *.aivc.json")
    p.add_argument("--media", default=None)
    p.add_argument("--endpoint", required=True, help="OpenAI 相容端點（…/v1）或 Anthropic base url")
    p.add_argument("--provider", default="openai", choices=["openai", "anthropic"])
    p.add_argument("--model", default=None)
    p.add_argument("--api-key", default=None, help="金鑰（Anthropic 必要）。不會寫進 log 或結果")
    p.add_argument("--language", default=None, help="章節標題與摘要的語言（預設跟字幕一樣）")
    p.add_argument("--max-chapters", type=int, default=None, help=f"最多幾章（預設 {DEFAULT_MAX_CHAPTERS}）")
    p.add_argument("--min-gap", type=float, default=None, help=f"章節之間至少幾秒（預設 {DEFAULT_MIN_GAP_S:g}）")
    p.add_argument("--timeout", type=float, default=None)
    p.add_argument("--dump-prompt", default=None, help="把送出去的逐字稿寫到這個檔（除錯）")


# ---------------------------------------------------------------- 純函式（測試直接打這些）


def lang_name(code: str | None) -> str:
    c = (code or "").strip().lower()
    return LANG_NAME.get(c) or LANG_NAME.get(c.split("-")[0], "") or (code or "台灣繁體中文")


def mmss(seconds: float) -> str:
    """YouTube 章節的時間碼：`m:ss`，一小時以上 `h:mm:ss`。"""
    s = max(0, int(round(seconds)))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def transcript_lines(cues: list[dict[str, Any]], fps: float) -> list[tuple[float, str]]:
    """字幕段 → (起點秒, 文字)。隱藏的段一樣算（它們仍然是講過的話，只是不燒進畫面）。"""
    out: list[tuple[float, str]] = []
    for c in cues:
        words = [str(w.get("text", "")) for w in (c.get("words") or [])]
        text = join_words(words).strip()
        if not text:
            continue
        out.append((float(c.get("startFrame", 0)) / fps, text))
    out.sort(key=lambda x: x[0])
    return out


def compact_transcript(lines: list[tuple[float, str]], budget: int = MAX_CHARS, window_chars: int = WINDOW_CHARS) -> str:
    """把逐字稿壓到預算內：先原樣試，超過就把相鄰段合併成 k 段一窗、每窗只留前面幾十個字。"""
    if not lines:
        return ""

    def render(groups: list[list[tuple[float, str]]], clip: int | None) -> str:
        rows = []
        for g in groups:
            text = " ".join(t for _, t in g) if any(" " in t for _, t in g) else "".join(t for _, t in g)
            if clip is not None and len(text) > clip:
                text = text[:clip] + "…"
            rows.append(f"[{mmss(g[0][0])}] {text}")
        return "\n".join(rows)

    text = render([[ln] for ln in lines], None)
    if len(text) <= budget:
        return text
    k = 2
    while True:
        groups = [lines[i : i + k] for i in range(0, len(lines), k)]
        text = render(groups, window_chars)
        if len(text) <= budget or len(groups) <= 8:
            return text
        k *= 2


def system_prompt(duration_s: float, language: str | None, max_chapters: int, min_gap_s: float) -> str:
    lang = lang_name(language)
    want = max(2, min(max_chapters, int(duration_s // 60) + 2))
    return (
        "你是影片剪輯軟體裡的章節編輯。輸入是一支影片的逐字稿，每行「[時間] 內容」。"
        f"影片長 {duration_s:.0f} 秒。\n"
        "請做三件事：\n"
        f"1. 依話題切成章節：第一章從 0 秒開始；每章至少隔 {min_gap_s:g} 秒；最多 {want} 章（短片 2–4 章就夠）。"
        "章節起點要是逐字稿裡真的換話題的那一行的時間（秒），不要自己編。"
        f"標題用{lang}，像 YouTube 章節那樣短（{TITLE_MAX // 2} 字以內），講這一段在做什麼、不要有標點結尾。\n"
        f"2. 寫一段兩三句的摘要（{lang}），講這支影片講了什麼、給誰看。\n"
        f"3. 給一個影片標題（{lang}，20 字以內）與 3–6 個關鍵字。\n"
        "只輸出一個 JSON 物件，不要有其他文字：\n"
        '{"title": "...", "summary": "...", "keywords": ["..."], "chapters": [{"start": 0, "title": "..."}, {"start": 秒數, "title": "..."}]}'
    )


def _clean_title(s: Any) -> str:
    t = re.sub(r"\s+", " ", str(s or "")).strip()
    t = t.strip("。．.!！?？;；,，:：-—–「」『』\"'")
    return t[:TITLE_MAX]


def _num(v: Any) -> float | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        s = v.strip()
        m = re.fullmatch(r"(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)", s)
        if m:
            h = int(m.group(1) or 0)
            return h * 3600 + int(m.group(2)) * 60 + float(m.group(3))
        try:
            return float(s)
        except ValueError:
            return None
    return None


def parse_chapters(obj: Any, duration_s: float, min_gap_s: float, max_chapters: int) -> tuple[list[dict[str, Any]], dict[str, Any], list[str]]:
    """模型的 JSON → (章節, 其餘欄位, 警告)。

    每一條規則都是為了某種實際會出現的壞輸出：字串秒數、`mm:ss`、超出長度、沒排序、擠在一起、第一章不在 0。
    壞掉的**單筆**只丟那一筆並記警告，不讓整份結果作廢。
    """
    warnings: list[str] = []
    if not isinstance(obj, dict):
        return [], {}, ["模型沒有照格式回 JSON 物件"]
    raw = obj.get("chapters")
    items: list[tuple[float, str]] = []
    if not isinstance(raw, list):
        warnings.append("模型沒有回 chapters 陣列")
        raw = []
    for it in raw:
        if not isinstance(it, dict):
            warnings.append("有一筆章節不是物件，已略過")
            continue
        start = _num(it.get("start", it.get("seconds", it.get("time"))))
        title = _clean_title(it.get("title", it.get("name", "")))
        if start is None:
            warnings.append(f"章節「{title or '?'}」沒有起點秒數，已略過")
            continue
        if start < 0 or start >= duration_s:
            warnings.append(f"章節「{title or '?'}」的起點 {start:.0f} 秒不在影片內，已略過")
            continue
        items.append((start, title))
    items.sort(key=lambda x: x[0])
    chapters: list[dict[str, Any]] = []
    for start, title in items:
        if chapters and start - chapters[-1]["start"] < min_gap_s:
            # 太近：留前一章（先來的通常才是真的換話題），把這一章的標題補給沒有標題的前一章
            if not chapters[-1]["title"] and title:
                chapters[-1]["title"] = title
            warnings.append(f"章節「{title or '?'}」離前一章不到 {min_gap_s:g} 秒，已併掉")
            continue
        chapters.append({"start": start, "title": title})
    if chapters and chapters[0]["start"] > 0:
        if chapters[0]["start"] < min_gap_s:
            chapters[0]["start"] = 0.0
        else:
            chapters.insert(0, {"start": 0.0, "title": ""})
            warnings.append("模型的第一章不在 0 秒，已補一章開場（標題留空，請自己填）")
    if len(chapters) > max_chapters:
        warnings.append(f"模型給了 {len(chapters)} 章，只留前 {max_chapters} 章")
        chapters = chapters[:max_chapters]
    rest = {
        "title": _clean_title(obj.get("title", "")),
        "summary": re.sub(r"\s+", " ", str(obj.get("summary") or "")).strip(),
        "keywords": [str(k).strip() for k in (obj.get("keywords") or []) if str(k).strip()][:10] if isinstance(obj.get("keywords"), list) else [],
    }
    return chapters, rest, warnings


def snap_to_cues(chapters: list[dict[str, Any]], cue_starts: list[float], tol_s: float = SNAP_TOL_S) -> list[dict[str, Any]]:
    """章節起點吸到最近的字幕段起點（容忍內）。第一章永遠 0。"""
    starts = sorted(cue_starts)
    out: list[dict[str, Any]] = []
    for i, c in enumerate(chapters):
        s = float(c["start"])
        if i == 0:
            out.append({**c, "start": 0.0})
            continue
        best = None
        for cs in starts:
            if abs(cs - s) <= tol_s and (best is None or abs(cs - s) < abs(best - s)):
                best = cs
        out.append({**c, "start": best if best is not None else s})
    # 吸完可能撞在一起：撞到就退回原值
    for i in range(1, len(out)):
        if out[i]["start"] <= out[i - 1]["start"]:
            out[i]["start"] = float(chapters[i]["start"])
    return out


def youtube_text(chapters: list[dict[str, Any]]) -> str:
    """YouTube 描述欄的章節格式：每行「時間 標題」、第一行 0:00。沒標題的章用「—」佔位讓人補。"""
    return "\n".join(f"{mmss(c['start'])} {c.get('title') or '—'}" for c in chapters)


# ---------------------------------------------------------------- op


def _load(args: dict[str, Any], ctx: Ctx) -> tuple[dict[str, Any], float, int]:
    """專案 → (字幕 track, fps, proxy 幀數)。獨立成函式讓測試可以不用真影片。"""
    from ..project import resolve as R

    mctx = R.open_media_context(env.normalize_path(str(args["project"])), args.get("media"), ctx)
    track = mctx.project.captions.get(mctx.media_id)
    if not track or not track.get("cues"):
        raise OpError("Invalid", f"media {mctx.media_id} 沒有字幕", hint="先在「字幕」分頁產生字幕")
    fn, fd = mctx.fps
    return track, fn / max(1, fd), mctx.n_frames


@register("assistant.chapters", cli="chapters", help="AI 章節與摘要：從字幕整理出章節（標記）、影片摘要與 YouTube 章節文字", args=_args)
def chapters_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    endpoint = str(args.get("endpoint") or "").strip()
    if not endpoint:
        raise OpError("Invalid", "沒有給 LLM 端點", hint="到設定填 AI 助手的端點")
    provider = str(args.get("provider") or "openai")
    timeout = DEFAULT_TIMEOUT_S if args.get("timeout") is None else float(args["timeout"])
    max_chapters = DEFAULT_MAX_CHAPTERS if args.get("max_chapters") is None else max(1, int(args["max_chapters"]))
    min_gap = DEFAULT_MIN_GAP_S if args.get("min_gap") is None else max(1.0, float(args["min_gap"]))

    ctx.progress(STAGE, 0, 3, message="讀字幕")
    track, fps, n_frames = _load(args, ctx)
    cues = list(track.get("cues") or [])
    lines = transcript_lines(cues, fps)
    if not lines:
        raise OpError("Invalid", "字幕裡沒有任何文字", hint="先產生字幕")
    duration_s = n_frames / fps if n_frames > 0 else lines[-1][0] + 1
    language = str(args.get("language") or track.get("language") or "zh-TW")
    transcript = compact_transcript(lines)
    if args.get("dump_prompt"):
        from ..atomic import write_text

        write_text(env.normalize_path(str(args["dump_prompt"])), transcript)

    ctx.progress(STAGE, 1, 3, message="問模型")
    r = chat(
        endpoint,
        [{"role": "user", "content": transcript}],
        provider=provider,
        model=args.get("model") or None,
        api_key=args.get("api_key"),
        system=system_prompt(duration_s, language, max_chapters, min_gap),
        max_tokens=MAX_TOKENS,
        timeout=timeout,
    )
    ctx.check_cancel()
    ctx.progress(STAGE, 2, 3, message="整理章節")
    obj = extract_json_object(r.text)
    if obj is None:
        raise OpError("Agent", "模型沒有照格式回 JSON", hint="換一個大一點的模型，或再試一次（回覆開頭：" + r.text.strip()[:60].replace("\n", " ") + "）")
    chapters, rest, warnings = parse_chapters(obj, duration_s, min_gap, max_chapters)
    if not chapters:
        raise OpError("Agent", "模型沒有給出任何可用的章節", hint="；".join(warnings[:3]) or "再試一次或換模型")
    chapters = snap_to_cues(chapters, [s for s, _ in lines])
    out = [{"frame": int(round(c["start"] * fps)), "seconds": round(float(c["start"]), 3), "title": c["title"]} for c in chapters]
    ctx.progress(STAGE, 3, 3)
    for w in warnings:
        ctx.log("warn", w)
    return {
        "endpoint": r.endpoint,
        "provider": r.provider,
        "model": r.model,
        "language": language,
        "chapters": out,
        "title": rest["title"],
        "summary": rest["summary"],
        "keywords": rest["keywords"],
        "youtube": youtube_text(chapters),
        "warnings": warnings,
        "transcriptChars": len(transcript),
        "_human": f"{len(out)} 章（{r.model}）" + (f"，{len(warnings)} 則警告" if warnings else ""),
    }


def format_result_text(result: dict[str, Any]) -> str:
    """CLI 給人看的版本：標題、摘要、章節。"""
    parts = []
    if result.get("title"):
        parts.append(f"標題：{result['title']}")
    if result.get("summary"):
        parts.append(f"摘要：{result['summary']}")
    if result.get("keywords"):
        parts.append("關鍵字：" + "、".join(result["keywords"]))
    parts.append(result.get("youtube", ""))
    return "\n".join(parts)


__all__ = ["chapters_op", "compact_transcript", "format_result_text", "json", "mmss", "parse_chapters", "snap_to_cues", "system_prompt", "transcript_lines", "youtube_text"]
