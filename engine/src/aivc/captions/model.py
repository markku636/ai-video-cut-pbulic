"""專案檔 `captions: Record<mediaId, CaptionTrackV1>` 的 Python 驗證（drop-and-report），鏡射 TS `src/project/sanitize.ts sanitizeCaptions`。

為什麼要逐欄鏡射 TS 而不是「能讀就好」：
- 同一份專案檔 TS 存、Python 存要**逐位元相同**（fixture 往返測試）；所以已知鍵的順序、未知鍵的位置、
  整數值浮點（6.0 → 6，JS 會寫成 6）都跟 TS 一致。
- track 層的未知鍵在磁碟上**攤平在頂層、排在已知鍵之前**（TS `captionTrackToJson` 是 `{...extra, ...known}`）；
  cue / word / style 層的未知鍵排在已知鍵之後。
- 壞東西只丟最小單位：壞字丟字、沒字的段丟段、壞樣式葉子丟葉子；整條 track 不是物件才整條丟。
這個模組刻意**零重依賴**（schema.py 在每個 op 啟動時都會 import 它）。
"""
from __future__ import annotations

import math
import re
from typing import Any, Callable

Warn = Callable[[str], None]

PRESET_IDS: tuple[str, ...] = ("subtitle", "karaoke", "pop", "bounce", "typewriter", "boxHighlight")
CUE_FLAGS: tuple[str, ...] = ("lowConfidence", "hallucination", "tooFast", "overflow", "edited")
WORD_SOURCES = ("asr", "user", "llm")
MAX_TEXT = 500
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")
UNSAFE_KEYS = frozenset({"__proto__", "constructor", "prototype"})

TRACK_KEYS = ("enabled", "language", "source", "presetId", "style", "segmentation", "cues", "extra")
CUE_KEYS = ("id", "startFrame", "endFrame", "words", "speaker", "lang", "styleOverride", "hidden", "flags")
WORD_KEYS = ("text", "startFrame", "endFrame", "prob", "emphasis", "source")
SOURCE_KEYS = ("backend", "model", "device", "computeType", "asrLanguage", "detected", "languageProb", "asrPath", "transcribedAt")


# ---------------------------------------------------------------- 葉子規則


def _fin(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _is_int(v: Any) -> bool:
    return _fin(v) and float(v) == int(v)


def _norm_num(v: Any) -> Any:
    """整數值的 float → int（JSON.stringify(6.0) 是 "6"；Python 寫 "6.0" 會讓兩邊存檔不同）。"""
    if isinstance(v, float) and math.isfinite(v) and v == int(v):
        return int(v)
    return v


def _num(lo: float, hi: float) -> Callable[[Any], bool]:
    return lambda v: _fin(v) and lo <= v <= hi


def _one_of(*xs: Any) -> Callable[[Any], bool]:
    def ok(v: Any) -> bool:
        # bool 是 int 的子類：True == 1，要排除，否則 weight: true 會被當成合法值
        if isinstance(v, bool):
            return any(x is v for x in xs)
        return isinstance(v, (str, int, float)) and v in xs

    return ok


def _is_color(v: Any) -> bool:
    return isinstance(v, str) and bool(COLOR_RE.match(v))


def _is_bool(v: Any) -> bool:
    return isinstance(v, bool)


STYLE_RULES: dict[str, dict[str, Callable[[Any], bool]]] = {
    "font": {
        "families": lambda v: isinstance(v, list) and 0 < len(v) <= 16 and all(isinstance(x, str) and 0 < len(x) <= 128 for x in v),
        "weight": _one_of(400, 500, 700, 800, 900),
        "sizePctShortSide": _num(0.5, 50),
        "file": lambda v: v is None or (isinstance(v, str) and len(v) <= 1024),
        "letterSpacingEm": _num(-1, 2),
        "uppercaseLatin": _is_bool,
        "cjkLatinSpace": _is_bool,
    },
    "layout": {
        "maxWidthPct": _num(5, 100),
        "lineHeight": _num(0.5, 4),
        "align": _one_of("center", "left", "right"),
        "anchor": _one_of("bottom", "middle", "top"),
        "offsetYPct": _num(-100, 100),
        "safeArea": _one_of("auto", "broadcast", "shorts", "none"),
    },
    "colors": {"text": _is_color, "future": lambda v: v is None or _is_color(v), "active": lambda v: v is None or _is_color(v), "past": lambda v: v is None or _is_color(v), "emphasis": _is_color, "stroke": _is_color},
    "stroke": {"widthPct": _num(0, 100)},
    "shadow": {"color": _is_color, "dxPct": _num(-100, 100), "dyPct": _num(-100, 100), "blurPct": _num(0, 100)},
    "box": {"mode": _one_of("none", "line", "activeWord"), "color": _is_color, "padEm": _num(0, 4), "radiusEm": _num(0, 4)},
    "animation": {
        "cueIn": _one_of("none", "fade", "pop", "slideUp", "spring"),
        "cueInMs": _num(0, 10_000),
        "cueOut": _one_of("none", "fade"),
        "cueOutMs": _num(0, 10_000),
        "word": _one_of("none", "karaoke", "karaokeWipe", "pop", "typewriter", "boxMove"),
        "wordMs": _num(0, 10_000),
        "activeScale": _num(0.1, 5),
        "emphasisScale": _num(0.1, 5),
    },
}


def _json_value(v: Any, depth: int = 0) -> bool:
    if depth > 32:
        return False
    if v is None or isinstance(v, (str, bool)):
        return True
    if isinstance(v, (int, float)):
        return math.isfinite(v)
    if isinstance(v, list):
        return all(_json_value(x, depth + 1) for x in v)
    if isinstance(v, dict):
        return all(isinstance(k, str) and k not in UNSAFE_KEYS and _json_value(x, depth + 1) for k, x in v.items())
    return False


def _copy_unknown(src: dict[str, Any], known: tuple[str, ...] | list[str], out: dict[str, Any], warn: Warn, where: str) -> None:
    for k, v in src.items():
        if k in known:
            continue
        if k in UNSAFE_KEYS or not _json_value(v):
            warn(f"{where}: 未知鍵 {k!r} 不是純 JSON 值，丟棄")
            continue
        out[k] = v


# ---------------------------------------------------------------- 樣式 / 段落規則 / 來源


def sanitize_style(v: Any, warn: Warn, where: str = "captions.style") -> dict[str, Any]:
    if not isinstance(v, dict):
        if v is not None:
            warn(f"{where} 不是物件，忽略")
        return {}
    out: dict[str, Any] = {}
    for group, rules in STYLE_RULES.items():
        if group not in v:
            continue
        g = v[group]
        if group == "shadow" and g is None:
            out["shadow"] = None
            continue
        if not isinstance(g, dict):
            warn(f"{where}.{group} 不是物件，丟棄")
            continue
        sub: dict[str, Any] = {}
        for leaf, ok in rules.items():
            if leaf not in g:
                continue
            if ok(g[leaf]):
                sub[leaf] = _norm_num(g[leaf])
            else:
                warn(f"{where}.{group}.{leaf}={g[leaf]!r} 不合法，丟棄（回到預設值）")
        _copy_unknown(g, list(rules), sub, warn, f"{where}.{group}")
        out[group] = sub
    _copy_unknown(v, list(STYLE_RULES), out, warn, where)
    return out


def _pos_int(lo: int, hi: int) -> Callable[[Any], bool]:
    return lambda v: _is_int(v) and lo <= v <= hi


SEG_RULES: dict[str, Callable[[Any], bool]] = {
    "mode": _one_of("sentence", "phrase", "word"),
    "maxUnitsPerLine": _pos_int(1, 1000),
    "maxLines": lambda v: _is_int(v) and v in (1, 2, 3),
    "maxWords": lambda v: v is None or (_is_int(v) and 1 <= v <= 1000),
    "minDurationMs": _num(0, 600_000),
    "maxDurationMs": _num(1, 600_000),
    "gapFrames": _pos_int(0, 1000),
    "chainGapMs": _num(0, 600_000),
    "lagOutMs": _num(0, 600_000),
    "pauseBreakMs": _num(0, 600_000),
    "snapToShots": _is_bool,
    "cpsWarn": lambda v: v is None or (_fin(v) and 0 <= v <= 1000),
}


def sanitize_segmentation(v: Any, fallback: dict[str, Any], warn: Warn) -> dict[str, Any]:
    if not isinstance(v, dict):
        if v is not None:
            warn("captions.segmentation 不是物件，用預設")
        return {k: fallback[k] for k in SEG_RULES}
    out: dict[str, Any] = {}
    for k, ok in SEG_RULES.items():
        if k not in v:
            out[k] = fallback[k]
        elif ok(v[k]):
            out[k] = _norm_num(v[k])
        else:
            warn(f"captions.segmentation.{k}={v[k]!r} 不合法，用預設 {fallback[k]!r}")
            out[k] = fallback[k]
    _copy_unknown(v, list(SEG_RULES), out, warn, "captions.segmentation")
    return out


def sanitize_source(v: Any, warn: Warn) -> dict[str, Any] | None:
    if v is None:
        return None
    if not isinstance(v, dict) or not isinstance(v.get("model"), str) or not isinstance(v.get("asrPath"), str):
        warn("captions.source 缺 model / asrPath，改為 null")
        return None
    lp = v.get("languageProb")
    out: dict[str, Any] = {
        "backend": "faster-whisper",
        "model": v["model"],
        "device": "cpu" if v.get("device") == "cpu" else "cuda",
        "computeType": v["computeType"] if isinstance(v.get("computeType"), str) else "",
        "asrLanguage": v["asrLanguage"] if isinstance(v.get("asrLanguage"), str) else None,
        "detected": v["detected"] if isinstance(v.get("detected"), str) else None,
        "languageProb": _norm_num(max(0.0, min(1.0, lp))) if _fin(lp) else None,
        "asrPath": v["asrPath"],
        "transcribedAt": v["transcribedAt"] if isinstance(v.get("transcribedAt"), str) else "",
    }
    _copy_unknown(v, SOURCE_KEYS, out, warn, "captions.source")
    return out


# ---------------------------------------------------------------- 字 / 段 / track


def sanitize_words(v: Any, cue_start: int, cue_end: int, warn: Warn, where: str) -> list[dict[str, Any]]:
    if not isinstance(v, list):
        if v is not None:
            warn(f"{where}.words 不是陣列")
        return []
    cand: list[dict[str, Any]] = []
    for x in v:
        if (
            not isinstance(x, dict)
            or not isinstance(x.get("text"), str)
            or len(x["text"]) > MAX_TEXT
            or not _is_int(x.get("startFrame"))
            or not _is_int(x.get("endFrame"))
            or x["startFrame"] >= x["endFrame"]
            or x["startFrame"] < cue_start
            or x["endFrame"] > cue_end
        ):
            warn(f"{where}: 壞的字 {str(x)[:80]}，丟棄")
            continue
        w: dict[str, Any] = {"text": x["text"], "startFrame": int(x["startFrame"]), "endFrame": int(x["endFrame"])}
        if _fin(x.get("prob")) and 0 <= x["prob"] <= 1:
            w["prob"] = _norm_num(x["prob"])
        if isinstance(x.get("emphasis"), bool):
            w["emphasis"] = x["emphasis"]
        if x.get("source") in WORD_SOURCES:
            w["source"] = x["source"]
        _copy_unknown(x, WORD_KEYS, w, warn, f"{where}.word")
        cand.append(w)
    cand.sort(key=lambda w: w["startFrame"])  # sort 是穩定的，跟 JS Array.sort 同序
    out: list[dict[str, Any]] = []
    for w in cand:
        if out and w["startFrame"] < out[-1]["endFrame"]:
            warn(f"{where}: 字 {w['text']!r} 與前一個字重疊，丟棄")
            continue
        out.append(w)
    return out


def sanitize_cues(v: Any, max_frame: int | None, warn: Warn) -> list[dict[str, Any]]:
    if not isinstance(v, list):
        if v is not None:
            warn("captions.cues 不是陣列")
        return []
    seen: set[str] = set()
    cand: list[dict[str, Any]] = []
    for x in v:
        if (
            not isinstance(x, dict)
            or not isinstance(x.get("id"), str)
            or not x["id"]
            or x["id"] in seen
            or not _is_int(x.get("startFrame"))
            or not _is_int(x.get("endFrame"))
            or x["startFrame"] < 0
            or x["startFrame"] >= x["endFrame"]
            or (max_frame is not None and x["endFrame"] > max_frame)
        ):
            warn(f"captions: 壞的段 {str(x)[:80]}，丟棄")
            continue
        s, e = int(x["startFrame"]), int(x["endFrame"])
        words = sanitize_words(x.get("words"), s, e, warn, f"cue {x['id']}")
        if not words:
            warn(f"captions: 段 {x['id']} 沒有有效的字，丟棄")
            continue
        seen.add(x["id"])
        c: dict[str, Any] = {"id": x["id"], "startFrame": s, "endFrame": e, "words": words}
        if "speaker" in x and (x["speaker"] is None or isinstance(x["speaker"], str)):
            c["speaker"] = x["speaker"]
        if isinstance(x.get("lang"), str):
            c["lang"] = x["lang"]
        if "styleOverride" in x:
            c["styleOverride"] = None if x["styleOverride"] is None else sanitize_style(x["styleOverride"], warn, f"cue {x['id']}.styleOverride")
        if isinstance(x.get("hidden"), bool):
            c["hidden"] = x["hidden"]
        if isinstance(x.get("flags"), list):
            flags: list[str] = []
            for f in x["flags"]:
                if f in CUE_FLAGS and f not in flags:
                    flags.append(f)
            if len(flags) != len(x["flags"]):
                warn(f"captions: 段 {x['id']} 有未知或重複的旗標，丟棄")
            c["flags"] = flags
        _copy_unknown(x, CUE_KEYS, c, warn, f"cue {x['id']}")
        cand.append(c)
    cand.sort(key=lambda c: c["startFrame"])
    out: list[dict[str, Any]] = []
    for c in cand:
        if out and c["startFrame"] < out[-1]["endFrame"]:
            warn(f"captions: 段 {c['id']} 與前一段重疊，丟棄")
            continue
        out.append(c)
    return out


def sanitize_track(v: Any, max_frame: int | None, warn: Warn) -> dict[str, Any] | None:
    from .presets import preset_segmentation

    if not isinstance(v, dict):
        warn("captions 的 track 不是物件，丟棄")
        return None
    preset_id = v.get("presetId")
    if preset_id not in PRESET_IDS:
        if preset_id is not None:
            warn(f"captions.presetId={preset_id!r} 不認得，改用 subtitle")
        preset_id = "subtitle"
    language = v["language"] if isinstance(v.get("language"), str) else ""
    extra: dict[str, Any] = {}
    if isinstance(v.get("extra"), dict):
        _copy_unknown(v["extra"], TRACK_KEYS, extra, warn, "captions.extra")
    _copy_unknown(v, TRACK_KEYS, extra, warn, "captions")
    # 磁碟形狀：未知鍵在前、已知鍵在後（TS captionTrackToJson 是 {...flat, ...known}）
    out: dict[str, Any] = dict(extra)
    out.update(
        {
            "enabled": v.get("enabled") is True,
            "language": language,
            "source": sanitize_source(v.get("source"), warn),
            "presetId": preset_id,
            "style": sanitize_style(v.get("style"), warn),
            "segmentation": sanitize_segmentation(v.get("segmentation"), preset_segmentation(preset_id, language), warn),
            "cues": sanitize_cues(v.get("cues"), max_frame, warn),
        }
    )
    return out


def sanitize_captions(v: Any, frames_of: dict[str, int | None], warn: Warn) -> dict[str, dict[str, Any]]:
    """`frames_of` = {mediaId: proxy.frames|None}；指向不存在媒體的 track 丟掉（跟 TS 一樣：沒有媒體就沒有幀號上限可驗）。"""
    if v is None:
        return {}
    if not isinstance(v, dict):
        warn("captions 不是 Record<mediaId, track>，忽略")
        return {}
    out: dict[str, dict[str, Any]] = {}
    for mid, tr in v.items():
        if mid in UNSAFE_KEYS or mid not in frames_of:
            warn(f"captions[{mid!r}] 指向不存在的 media，丟棄")
            continue
        t = sanitize_track(tr, frames_of.get(mid), warn)
        if t is not None:
            out[mid] = t
    return out
