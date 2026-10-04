"""ASR 文件（asr/<key>.v1.json）→ CaptionTrackV1（camelCase dict，跟專案檔同一個形狀）。純函式、決定性。

為什麼 captions.build 重算幀號而不是直接用 ASR 檔裡的 startFrame：ASR 快取以「秒」為準（proxy 時間軸），
使用者之後用 --fps 重建 proxy、或 ASR 是在別的 fps 下跑的，幀號就會對不上；秒 → 幀在這裡一次算清楚。
"""
from __future__ import annotations

from typing import Any, Sequence

from . import presets as PR
from . import text as T
from .normalize import AsrWord, NormalizeOptions, normalize
from .segment import CueWord, group_words
from .timebase import TimeMap
from .timing import Cue, retime


def asr_words(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """ASR 文件的正規化詞（`words`：proxy 秒 `t0/t1`）；舊文件沒有 words 就從 segments 現算。"""
    ws = doc.get("words")
    if isinstance(ws, list) and ws and isinstance(ws[0], dict) and "t0" in ws[0]:
        return ws
    off = float(doc.get("offsetS") or 0.0)
    res = normalize(doc.get("segments") or [], [tuple(v) for v in doc.get("vad") or []], NormalizeOptions(output_language=doc.get("outputLanguage")))
    return [word_to_json(w, off) for w in res.words]


def word_to_json(w: AsrWord, offset_s: float, tm: TimeMap | None = None) -> dict[str, Any]:
    d: dict[str, Any] = {"text": w.text, "t0": round(w.start + offset_s, 4), "t1": round(w.end + offset_s, 4), "prob": round(float(w.prob), 4)}
    d["startMs"] = int(round((w.start + offset_s) * 1000))
    d["endMs"] = int(round((w.end + offset_s) * 1000))
    if tm is not None:
        a, b = tm.word_frames(w.start, w.end)
        d["startFrame"], d["endFrame"] = a, b
    if w.raw is not None and w.raw.strip() != w.text:
        d["raw"] = w.raw
    if w.emphasis:
        d["emphasis"] = True
    if w.flags:
        d["flags"] = sorted(w.flags)
    if w.speaker:
        d["speaker"] = w.speaker
    if w.source != "asr":
        d["source"] = w.source
    d["seg"] = w.seg
    return d


def word_from_json(d: dict[str, Any], offset_s: float) -> AsrWord:
    """word_to_json 的反向（ASR 快取 → AsrWord，時間扣回 ASR 時間軸）：沿用快取的辨識結果只重跑 LLM 校對時用。"""
    text = str(d.get("text", ""))
    flags = d.get("flags")
    return AsrWord(
        text=text, start=float(d.get("t0", 0.0)) - offset_s, end=float(d.get("t1", 0.0)) - offset_s, prob=float(d.get("prob", 1.0)),
        seg=int(d.get("seg", 0) or 0), raw=str(d["raw"]) if isinstance(d.get("raw"), str) else text,
        flags={str(f) for f in flags} if isinstance(flags, list) else set(), emphasis=bool(d.get("emphasis")),
        speaker=d.get("speaker") if isinstance(d.get("speaker"), str) else None, source=str(d.get("source") or "asr"),
    )


def cue_words_from_doc(words: Sequence[dict[str, Any]], fps: tuple[int, int], n_frames: int) -> list[CueWord]:
    tm = TimeMap(fps[0], fps[1], n_frames, 0.0)  # t0/t1 已經是 proxy 秒
    out: list[CueWord] = []
    prev_end = 0
    for w in words:
        text = str(w.get("text", "")).strip()
        if not text:
            continue
        t0, t1 = float(w["t0"]), float(w["t1"])
        a, b = tm.word_frames(t0, t1)
        if a >= n_frames:
            continue
        # 幀層級不重疊：字很密時（每字 < 1 幀）往後推，保證「目前是哪個字」唯一
        a = max(a, prev_end)
        if a >= n_frames:
            break
        b = min(max(b, a + 1), max(n_frames, a + 1))
        prev_end = b
        out.append(
            CueWord(
                text=text, start=a, end=b, start_ms=t0 * 1000.0, end_ms=t1 * 1000.0, prob=float(w.get("prob", 1.0)),
                emphasis=bool(w.get("emphasis")), flags=set(w.get("flags") or ()) & {"lowConfidence", "hallucination"},
                speaker=w.get("speaker"), source=str(w.get("source") or "asr"),
            )
        )
    return out


def cue_to_json(i: int, c: Cue, lang: str) -> dict[str, Any]:
    words = []
    for w in c.words:
        d: dict[str, Any] = {"text": w.text, "startFrame": int(w.start), "endFrame": int(w.end), "prob": round(float(w.prob), 3)}
        if w.emphasis:
            d["emphasis"] = True
        d["source"] = w.source if w.source in ("asr", "user", "llm") else "asr"
        words.append(d)
    cue: dict[str, Any] = {"id": f"c{i + 1}", "startFrame": int(c.start), "endFrame": int(c.end), "words": words}
    speaker = next((w.speaker for w in c.words if w.speaker), None)
    if speaker:
        cue["speaker"] = speaker
    cue["lang"] = lang
    flags = [f for f in ("lowConfidence", "hallucination", "tooFast", "overflow", "edited") if f in c.flags]
    if flags:
        cue["flags"] = flags
    return cue


def build_track(
    doc: dict[str, Any],
    *,
    preset_id: str = PR.DEFAULT_PRESET,
    output_language: str | None = None,
    fps: tuple[int, int],
    n_frames: int,
    cuts: Sequence[int] = (),
    segmentation: dict[str, Any] | None = None,
    asr_path: str = "",
    enabled: bool = True,
) -> dict[str, Any]:
    if preset_id not in PR.PRESET_IDS:
        preset_id = PR.DEFAULT_PRESET
    lang = output_language or doc.get("outputLanguage") or doc.get("language") or ""
    seg = PR.effective_segmentation(preset_id, lang, segmentation)
    words = cue_words_from_doc(asr_words(doc), fps, n_frames)
    groups = group_words(words, seg, cuts)
    cues = retime(groups, seg, fps, n_frames, cuts)
    source = None
    if doc.get("model"):
        source = {
            "backend": "faster-whisper",
            "model": str(doc.get("model")),
            "device": "cpu" if doc.get("device") == "cpu" else "cuda",
            "computeType": str(doc.get("computeType") or ""),
            "asrLanguage": doc.get("asrLanguage"),
            "detected": doc.get("language"),
            "languageProb": doc.get("languageProb"),
            "asrPath": asr_path,
            "transcribedAt": str(doc.get("transcribedAt") or ""),
        }
    return {
        "enabled": bool(enabled),
        "language": lang,
        "source": source,
        "presetId": preset_id,
        "style": {},
        "segmentation": seg,
        "cues": [cue_to_json(i, c, lang) for i, c in enumerate(cues)],
    }


def track_summary(track: dict[str, Any]) -> dict[str, Any]:
    cues = track.get("cues") or []
    flagged = sum(1 for c in cues if any(f != "edited" for f in c.get("flags") or ()))
    return {
        "cues": len(cues),
        "words": sum(len(c.get("words") or ()) for c in cues),
        "flagged": flagged,
        "preset": track.get("presetId"),
        "language": track.get("language"),
        "text": T.join_words(w["text"] for w in (cues[0]["words"] if cues else [])),
    }
