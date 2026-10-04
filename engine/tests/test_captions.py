"""動態字幕（captions/*、render 掛勾）CPU 測試：不需要 GPU、不下載模型。

涵蓋研究規格 §6 的 1–8：ASR 清理、分段、動畫曲線、換行、燒錄（字幕框外逐位元相同）、render 計畫與側車字幕檔、
匯出 golden、專案 schema 往返；另加 VFR 來源的幀號對應與點陣化決定性。
字型：測試一律先用 Pillow 內建字型（CI 沒有中文字型也能跑）；需要 CJK 字形的測試在找不到系統 CJK 字型時 skip。
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np
import pytest

from aivc.captions import anim as A
from aivc.captions import build as B
from aivc.captions import export as X
from aivc.captions import linebreak as LB
from aivc.captions import normalize as N
from aivc.captions import presets as PR
from aivc.captions import text as T
from aivc.captions.burn import CaptionBurner, blend_rgba_into_yuv, burner_for
from aivc.captions.fonts import FontSpec, resolve_font
from aivc.captions.segment import CueWord, group_words
from aivc.captions.timebase import TimeMap, frame_of, frame_to_ms
from aivc.captions.timing import retime
from aivc.media.cfr import CfrMap
from aivc.media.source import Yuv420
from aivc.project import schema as S

REPO = Path(__file__).resolve().parents[2]
BUILTIN = FontSpec(None, 0, None, "Pillow default", False, "builtin")

# 實測：large-v3-turbo 在混語片 auto 偵測成英文，" to" 被標成 0.88–14.40 s（研究規格 §1）
EN_WORDS = [
    (0.24, 0.88, " Welcome", 0.92), (0.88, 14.4, " to", 0.96), (14.4, 14.46, " the", 0.93), (14.46, 15.0, " Magic", 0.91), (15.0, 15.26, " table.", 0.78),
    (15.86, 16.34, " The", 0.98), (16.34, 16.58, " host", 0.98), (16.58, 16.96, " turns", 1.0), (16.96, 17.24, " over", 1.0), (17.24, 17.4, " the", 1.0),
    (17.4, 17.58, " third", 0.98), (17.58, 17.92, " card,", 1.0), (18.18, 18.52, " an", 0.98), (18.52, 18.68, " eight", 0.65), (18.68, 18.84, " of", 1.0),
    (18.84, 19.14, " hearts.", 1.0), (19.76, 20.3, " The", 1.0), (20.3, 20.62, " guest", 1.0), (20.62, 20.94, " wins", 1.0), (20.94, 21.16, " this", 1.0),
    (21.16, 21.52, " round,", 1.0), (21.82, 22.24, " so", 1.0), (22.24, 22.48, " keep", 1.0), (22.48, 22.66, " an", 1.0), (22.66, 22.82, " eye", 1.0),
    (22.82, 22.98, " on", 1.0), (22.98, 23.12, " the", 1.0), (23.12, 23.52, " animated", 1.0), (23.52, 23.98, " captions.", 1.0),
]
EN_VAD = [(0.24, 12.3), (13.6, 24.0)]
# 實測：turbo + 繁中 prompt 的中文前半（詞粒度就是 Whisper 的 unicode token）
ZH_WORDS = [
    (0.24, 0.88, "歡迎", 0.02), (0.88, 1.38, "來到", 0.99), (1.38, 1.68, "百", 0.96), (1.68, 1.9, "家", 0.92), (1.9, 2.12, "姓", 0.64), (2.12, 2.38, "課", 0.87),
    (2.38, 2.62, "堂。", 0.99), (3.12, 3.68, "店", 0.9), (3.68, 3.86, "家", 0.96), (3.86, 4.28, "現在", 0.98), (4.28, 4.6, "翻", 0.99), (4.6, 4.88, "開", 1.0),
    (4.88, 5.26, "第三", 0.96), (5.26, 5.54, "張", 0.99), (5.54, 5.9, "牌,", 0.99), (6.06, 6.34, "是", 0.99), (6.34, 6.56, "紅", 0.84), (6.56, 6.78, "心", 0.6),
    (6.78, 7.02, "8。", 0.45), (7.84, 8.14, "這一", 0.94), (8.14, 8.44, "局", 1.0), (8.44, 8.74, "玩", 0.69), (8.74, 8.94, "家", 0.74), (8.94, 9.18, "贏", 1.0),
    (9.18, 9.4, "了,", 1.0), (9.62, 9.82, "請", 1.0), (9.82, 10.2, "大家", 1.0), (10.2, 10.62, "注意", 0.99), (10.62, 10.94, "動", 1.0), (10.94, 11.18, "態", 1.0),
    (11.18, 11.44, "字", 1.0), (11.44, 11.66, "幕", 1.0), (11.66, 11.82, "的", 1.0), (11.82, 12.02, "效", 1.0), (12.02, 12.32, "果。", 1.0),
]


def segs(words: list[tuple[float, float, str, float]], seg_id: int = 0) -> list[dict]:
    return [{"id": seg_id, "start": words[0][0], "end": words[-1][1], "text": "".join(w[2] for w in words), "avg_logprob": -0.2, "no_speech_prob": 0.01, "compression_ratio": 1.2,
             "words": [{"start": a, "end": b, "word": t, "probability": p} for a, b, t, p in words]}]


def asr_doc(words: list[tuple[float, float, str, float]], vad, lang: str) -> dict:
    res = N.normalize(segs(words), vad, N.NormalizeOptions(output_language=lang))
    return {"version": 1, "model": "large-v3-turbo", "device": "cuda", "computeType": "float16", "language": lang.split("-")[0], "languageProb": 0.9, "outputLanguage": lang,
            "transcribedAt": "2026-09-17T00:00:00.000Z", "words": [B.word_to_json(w, 0.0) for w in res.words]}


def has_opencc() -> bool:
    try:
        import opencc  # noqa: F401

        return True
    except ImportError:
        return False


def cjk_font() -> FontSpec | None:
    spec = resolve_font(PR.preset("subtitle")["style"], "zh-TW")
    return spec if spec.path is not None and spec.cjk else None


# ================================================================ 時間 → 幀


def test_timebase_rounding_and_srt_ms() -> None:
    assert frame_of(1.0, 30, 1) == 30 and frame_of(1.0166, 30, 1) == 30 and frame_of(1.0167, 30, 1) == 31
    assert frame_to_ms(1799, 30000, 1001) == 60027 and X.srt_time(60027) == "00:01:00,027" and X.vtt_time(60027) == "00:01:00.027"
    assert X.ass_time(60027) == "0:01:00.03"
    tm = TimeMap(30, 1, 100, offset_s=0.5)
    assert tm.frame(0.0) == 15 and tm.word_frames(1.0, 1.01) == (45, 46)  # 每個詞至少 1 幀
    assert tm.word_frames(99.0, 100.0) == (99, 100)  # 片尾之後的詞壓在最後一幀
    assert tm.frame(-5.0) == 0


def test_word_frames_on_vfr_proxy_map() -> None:
    """VFR 來源（Chrome 錄影：第 2 幀後 1.2 s 斷層、33/34 ms 抖動）：字幕幀號是 **proxy CFR 幀**，
    不是來源幀序號；proxy 第 k 幀顯示的來源幀要剛好是那個時刻螢幕上的畫面。"""
    pts = [0.0, 36.0] + [1236.0 + i * 33.34 for i in range(0, 90)]
    cfr = CfrMap.from_index(pts, (30, 1))
    assert cfr.n_frames == round((pts[-1] - pts[0]) * 30 / 1000) + 1 and cfr.duplicate_count > 30
    tm = TimeMap.from_cfr(cfr, offset_s=0.0)
    for t in (0.5, 1.25, 2.0, 3.3):
        k = tm.frame(t)
        assert abs(k / 30 - t) <= 0.5 / 30 + 1e-9
        src = cfr.src_index(k)
        # 顯示的來源幀是「proxy 幀中心時刻之前最後一幀」
        assert pts[src] <= (k + 0.5) / 30 * 1000 < (pts[src + 1] if src + 1 < len(pts) else math.inf)
    # 斷層裡的字（1.0 s）落在定格幀上：proxy 幀號照樣前進，來源幀是斷層前那一幀
    k = tm.frame(1.0)
    assert k == 30 and cfr.src_index(k) == 1
    # 音訊比影像早開始 0.2 s → offset −(fileStart) 的效果由 offset_s 表達
    tm2 = TimeMap.from_cfr(cfr, offset_s=0.2)
    assert tm2.frame(1.8) == tm.frame(2.0)
    a, b = tm.word_frames(3.0, 999.0)
    assert b == cfr.n_frames and a < b


# ================================================================ ASR 清理


def test_normalize_vad_fixes_word_spanning_silence() -> None:
    res = N.normalize(segs(EN_WORDS), EN_VAD, N.NormalizeOptions(output_language="en"))
    to = next(w for w in res.words if w.text == "to")
    assert to.start >= 13.6 or to.end - to.start <= 1.2
    assert to.end - to.start <= 1.2
    assert all(w.end > w.start for w in res.words)
    assert all(b.start >= a.start and b.start >= a.end - 1e-9 for a, b in zip(res.words, res.words[1:]))
    # 中文那一半被 auto 偵測整段丟掉 → gaps 抓得到（研究規格 §6 第 11 條的 CPU 版）
    assert res.gaps and res.gaps[0][0] < 2.0 and res.gaps[0][1] >= 12.0


@pytest.mark.skipif(not has_opencc(), reason="沒有 opencc")
def test_normalize_traditional_conversion_keeps_frames() -> None:
    simp = [(i * 0.25, i * 0.25 + 0.25, ch, 0.9) for i, ch in enumerate(["欢", "迎", "来", "到", "百", "家", "姓", "课", "堂。"])]
    res = N.normalize(segs(simp), None, N.NormalizeOptions(output_language="zh-TW"))
    assert [w.text for w in res.words] == ["歡", "迎", "來", "到", "百", "家", "姓", "課", "堂。"]
    assert [(w.start, w.end) for w in res.words] == [(a, b) for a, b, _t, _p in simp]
    # 長度改變的詞組留在擁有它的詞上：内存 → 記憶體（「存」併進前一個詞，時間延長到它的終點）
    words = [N.AsrWord(t, i * 0.2, i * 0.2 + 0.2, seg=0) for i, t in enumerate(["软", "件", "的", "内", "存"])]
    out = N.convert_script(words, N.NormalizeOptions(output_language="zh-TW"))
    assert [(w.text, round(w.start, 2), round(w.end, 2)) for w in out] == [("軟體", 0.0, 0.4), ("的", 0.4, 0.6), ("記憶體", 0.6, 1.0)]
    # 已經是繁體：auto 不動（使用者的港台用詞不被改）
    trad = [N.AsrWord(t, 0, 0.1, seg=0) for t in ["軟", "件"]]
    assert [w.text for w in N.convert_script(trad, N.NormalizeOptions(output_language="zh-TW"))] == ["軟", "件"]


def test_normalize_punctuation_digits_and_latin_subwords() -> None:
    words = [(0.0, 0.2, "牌,", 0.9), (0.2, 0.4, "是", 0.9), (0.4, 0.6, "８", 0.9), (0.6, 0.8, "點", 0.9), (0.8, 1.0, "3.5", 0.9), (1.0, 1.2, "倍.", 0.9)]
    res = N.normalize(segs(words), None, N.NormalizeOptions(output_language="zh-TW", convert="none"))
    assert [w.text for w in res.words] == ["牌，", "是", "8", "點", "3.5", "倍。"]
    # 中文模式下英文被切成 unicode token（" M" "ag" "i" "c"）→ 併回一個詞
    mixed = [(0.0, 0.3, "歡迎", 0.9), (0.3, 0.4, " M", 0.9), (0.4, 0.5, "ag", 0.9), (0.5, 0.6, "i", 0.9), (0.6, 0.8, "c", 0.9), (0.8, 1.0, "課堂", 0.9)]
    res = N.normalize(segs(mixed), None, N.NormalizeOptions(output_language="zh-TW", convert="none"))
    assert [w.text for w in res.words] == ["歡迎", "Magic", "課堂"] and res.words[1].start == 0.3 and res.words[1].end == 0.8
    # 前置標點併回前一詞
    res = N.normalize(segs([(0.0, 0.5, " Hello", 0.9), (0.5, 0.6, ",", 0.9), (0.6, 1.0, " world", 0.3)]), None, N.NormalizeOptions(output_language="en"))
    assert [w.text for w in res.words] == ["Hello,", "world"] and res.words[1].flags == {"lowConfidence"}


def test_normalize_flags_hallucination_and_emphasis() -> None:
    s = segs([(0.0, 1.0, " Thanks", 0.9), (1.0, 2.0, " for", 0.9), (2.0, 3.0, " watching!", 0.9)])
    s[0]["text"] = " Thanks for watching!"
    res = N.normalize(s, None, N.NormalizeOptions(output_language="en", hotwords=["百家姓"]))
    assert all("hallucination" in w.flags for w in res.words) and res.hallucinated_segments == [0]
    assert res.words[2].emphasis and not res.words[0].emphasis  # 驚嘆號結尾
    zh = segs([(0.0, 0.2, "百", 0.9), (0.2, 0.4, "家", 0.9), (0.4, 0.6, "姓", 0.9), (0.6, 0.8, "贏", 0.9), (0.8, 1.0, "50%", 0.9)])
    res = N.normalize(zh, None, N.NormalizeOptions(output_language="zh-TW", convert="none", hotwords=["百家姓"]))
    assert [w.emphasis for w in res.words] == [True, True, True, False, True]
    s = segs([(0.0, 1.0, " hmm", 0.9)])
    s[0].update(compression_ratio=2.6)
    assert N.hallucinated(s[0]) and not N.hallucinated({"text": "ok", "compression_ratio": 1.5, "no_speech_prob": 0.7, "avg_logprob": -0.5})


# ================================================================ 分段 + 配時


def _check_track(track: dict, fps: tuple[int, int], n_frames: int, cuts: list[int] = ()) -> None:
    seg = track["segmentation"]
    cues = track["cues"]
    assert cues
    for a, b in zip(cues, cues[1:]):
        assert a["endFrame"] <= b["startFrame"], (a["id"], b["id"])
    for c in cues:
        assert 0 <= c["startFrame"] < c["endFrame"] <= n_frames
        ws = c["words"]
        assert ws[0]["startFrame"] >= c["startFrame"] and ws[-1]["endFrame"] <= c["endFrame"]
        assert all(w["endFrame"] > w["startFrame"] for w in ws)
        assert all(x["endFrame"] <= y["startFrame"] for x, y in zip(ws, ws[1:]))
        # 句末標點只能出現在則的最後一個詞
        assert not any(T.ends_sentence(w["text"]) for w in ws[:-1]), [w["text"] for w in ws]
        # 行尾的 。，、 不顯示 → 不佔單位預算（segment.seq_units）
        assert T.units(T.strip_line_end(T.join_words(w["text"] for w in ws))) <= seg["maxUnitsPerLine"] * seg["maxLines"] or len(ws) == 1
        if seg.get("maxChars"):
            # 中文字數模式：中日韓字逐字算、maxWords 只數拉丁 token；單一個詞本身超過時只能自成一則
            assert sum(T.cjk_count(w["text"]) for w in ws) <= seg["maxChars"] or len(ws) == 1
            if seg["maxWords"]:
                assert sum(1 for w in ws if not T.has_cjk(w["text"])) <= seg["maxWords"]
        elif seg["maxWords"]:
            assert len(ws) <= seg["maxWords"]
        if seg["snapToShots"]:
            assert not any(ws[0]["startFrame"] < cut <= ws[-1]["startFrame"] for cut in cuts)


@pytest.mark.parametrize("preset", PR.PRESET_IDS)
def test_build_track_invariants_all_presets(preset: str) -> None:
    fps, n = (30, 1), 780
    for words, vad, lang in ((EN_WORDS, EN_VAD, "en"), (ZH_WORDS, [(0.24, 12.3)], "zh-TW")):
        track = B.build_track(asr_doc(words, vad, lang), preset_id=preset, output_language=lang, fps=fps, n_frames=n, cuts=[100, 500])
        _check_track(track, fps, n, [100, 500])
        assert track["presetId"] == preset and track["segmentation"] == PR.effective_segmentation(preset, lang)


def test_build_track_golden_subtitle_and_pop() -> None:
    fps, n = (30, 1), 780
    zh = B.build_track(asr_doc(ZH_WORDS, [(0.24, 12.3)], "zh-TW"), preset_id="subtitle", output_language="zh-TW", fps=fps, n_frames=n)
    texts = ["".join(w["text"] for w in c["words"]) for c in zh["cues"]]
    assert texts == ["歡迎來到百家姓課堂。", "店家現在翻開第三張牌，是紅心8。", "這一局玩家贏了，請大家注意動態字幕的效果。"]
    c0 = zh["cues"][0]
    assert c0["startFrame"] == 7 and "lowConfidence" in c0["flags"]
    # lag-out 400 ms（12 幀）→ 91；離下一則只剩 3 幀 < chain 500 ms → 接到下一則 − gapFrames(2)
    assert c0["endFrame"] == zh["cues"][1]["startFrame"] - 2 == 92
    en = B.build_track(asr_doc(EN_WORDS, EN_VAD, "en"), preset_id="pop", output_language="en", fps=fps, n_frames=n)
    texts = [" ".join(w["text"] for w in c["words"]) for c in en["cues"]]
    assert texts[:4] == ["Welcome", "to the Magic", "table.", "The host"] and all(len(c["words"]) <= 3 for c in en["cues"])
    # 強調：數字 8
    assert any(w.get("emphasis") for c in zh["cues"] for w in c["words"] if w["text"].startswith("8"))


# 實測（2026-09-17 整合跑的 speech_clip.webm，turbo float16 --language zh）：Whisper 把大部分詞切成單字 token，
# 舊規則（pop maxWords=3 逐 token 數）切出「注意動 | 態字 | 幕的效 | 果。」。紅星吧／完家 是那次真的辨識錯字，保留原樣。
ZH_REAL = [
    (0.44, 0.86, "歡迎", 0.07), (0.86, 1.36, "來到", 1.0), (1.36, 1.68, "百", 0.95), (1.68, 1.9, "家", 0.91), (1.9, 2.12, "姓", 0.71), (2.12, 2.38, "課", 0.83),
    (2.38, 2.62, "堂。", 0.99), (3.2, 3.66, "店", 0.91), (3.66, 3.86, "家", 0.96), (3.86, 4.28, "現在", 0.98), (4.28, 4.58, "翻", 0.99), (4.58, 4.88, "開", 1.0),
    (4.88, 5.26, "第三", 0.94), (5.26, 5.52, "張", 0.98), (5.52, 5.9, "牌，", 0.99), (6.02, 6.34, "是", 0.98), (6.34, 6.52, "紅", 0.87), (6.52, 6.78, "星", 0.64),
    (6.78, 7.02, "吧。", 0.47), (7.87, 8.13, "這一", 0.94), (8.13, 8.43, "局", 1.0), (8.43, 8.73, "完", 0.64), (8.73, 8.95, "家", 0.98), (8.95, 9.19, "贏", 1.0),
    (9.19, 9.41, "了，", 1.0), (9.59, 9.81, "請", 0.99), (9.81, 10.21, "大家", 1.0), (10.21, 10.61, "注意", 0.98), (10.61, 10.93, "動", 0.99), (10.93, 11.17, "態", 1.0),
    (11.17, 11.43, "字", 1.0), (11.43, 11.67, "幕", 1.0), (11.67, 11.83, "的", 1.0), (11.83, 12.03, "效", 1.0), (12.03, 12.35, "果。", 1.0),
]


def _cue_words(track: dict) -> list[list[str]]:
    return [[w["text"] for w in c["words"]] for c in track["cues"]]


def test_cjk_pop_bounce_merge_single_char_tokens_and_count_chars() -> None:
    fps, n = (30, 1), 780
    doc = asr_doc(ZH_REAL, [(0.44, 12.35)], "zh-TW")
    pop = B.build_track(doc, preset_id="pop", output_language="zh-TW", fps=fps, n_frames=n)
    assert pop["segmentation"]["maxChars"] == PR.CJK_MAX_CHARS["pop"] == 6
    assert _cue_words(pop) == [
        ["歡迎", "來到"], ["百家姓", "課堂。"], ["店家", "現在"], ["翻開", "第三張", "牌，"], ["是", "紅星吧。"],
        ["這一局"], ["完家贏了，"], ["請", "大家"], ["注意", "動態"], ["字幕的", "效果。"],
    ]
    bounce = B.build_track(doc, preset_id="bounce", output_language="zh-TW", fps=fps, n_frames=n)
    assert _cue_words(bounce) == [
        ["歡迎", "來到"], ["百家姓"], ["課堂。"], ["店家", "現在"], ["翻開"], ["第三張", "牌，"], ["是", "紅星吧。"],
        ["這一局"], ["完家贏了，"], ["請", "大家"], ["注意", "動態"], ["字幕的"], ["效果。"],
    ]
    for tr in (pop, bounce):
        _check_track(tr, fps, n)
        # 詞的時間 = 併起來的第一個 token 起點、最後一個 token 終點；機率取最小（低信心旗標不會因為併詞消失）
        w = next(w for c in tr["cues"] for w in c["words"] if w["text"] == "百家姓")
        assert (w["startFrame"], w["endFrame"], w["prob"]) == (round(1.36 * 30), round(2.12 * 30), 0.71)
    # 原本的測試片（紅心8。含數字：數字不是漢字，不參與併詞）也不再切在詞中間
    zh = B.build_track(asr_doc(ZH_WORDS, [(0.24, 12.3)], "zh-TW"), preset_id="pop", output_language="zh-TW", fps=fps, n_frames=n)
    assert [T.join_words(ws) for ws in _cue_words(zh)] == ["歡迎來到", "百家姓課堂。", "店家現在", "翻開第三張牌，", "是紅心8。", "這一局", "玩家贏了，", "請大家", "注意動態", "字幕的效果。"]
    # 拉丁語言、以及沒有 maxChars 的預設：行為不變（逐 token 數 maxWords、不併詞）
    assert "maxChars" not in PR.effective_segmentation("pop", "en") and "maxChars" not in PR.effective_segmentation("karaoke", "zh-TW")
    en = B.build_track(asr_doc(EN_WORDS, EN_VAD, "en"), preset_id="pop", output_language="en", fps=fps, n_frames=n)
    assert all(len(c["words"]) <= 3 for c in en["cues"])
    # 覆寫：null 關掉中文字數模式（回到逐 token 數 maxWords=3）；其他預設也能開
    off = B.build_track(doc, preset_id="pop", output_language="zh-TW", fps=fps, n_frames=n, segmentation={"maxChars": None})
    assert off["segmentation"]["maxChars"] is None and all(len(c["words"]) <= 3 for c in off["cues"])
    assert ["百", "家"] in _cue_words(off) and ["姓", "課", "堂。"] in _cue_words(off)  # 舊行為：百家 | 姓課堂，切在詞中間
    assert PR.effective_segmentation("subtitle", "zh-TW", {"maxChars": 8})["maxChars"] == 8


def test_cjk_merge_heuristics_and_boundaries() -> None:
    from aivc.captions import segment as SG

    seg = dict(PR.effective_segmentation("pop", "zh-TW"), pauseBreakMs=300)
    t = [0.0]

    def mk(text: str, gap_ms: float = 0.0, dur_ms: float = 200.0, **kw) -> CueWord:
        t[0] += gap_ms
        a = t[0]
        t[0] += dur_ms
        return CueWord(text, int(a * 30 / 1000), int(t[0] * 30 / 1000), a, t[0], **kw)

    def merged(words: list[CueWord], s: dict = seg) -> list[str]:
        return [w.text for w in SG.merge_cjk_words(words, s)]

    # 虛詞接前一個詞、量詞接數詞／指示詞、常用單字自成一詞、4 個單字 → 2+2
    t[0] = 0.0
    assert merged([mk("這"), mk("個"), mk("是"), mk("動"), mk("態"), mk("字"), mk("幕"), mk("的")]) == ["這個", "是", "動態", "字幕的"]
    # 停頓 ≥ 150 ms、前一個 token 有標點、非漢字 token（數字、拉丁、假名）都會切斷
    t[0] = 0.0
    assert merged([mk("好"), mk("棒", gap_ms=200), mk("喔，"), mk("超"), mk("讚"), mk("3"), mk("個"), mk("OK"), mk("的")]) == ["好", "棒喔，", "超讚", "3", "個", "OK", "的"]
    # 併起來會超過 maxChars 就不併（bounce 4 字）：5 個單字 → 3+2，每塊仍 ≤ 4
    t[0] = 0.0
    assert merged([mk(ch) for ch in "百家姓課堂"], dict(seg, maxChars=4)) == ["百家姓", "課堂"]
    t[0] = 0.0
    assert merged([mk(ch) for ch in "一二三"], dict(seg, maxChars=2)) == ["一二", "三"]
    # 換講者、鏡頭切點（snapToShots）是硬斷點，不跨過去併
    t[0] = 0.0
    assert merged([mk("店", speaker="A"), mk("家", speaker="B")]) == ["店", "家"]
    t[0] = 0.0
    ws = [mk("店"), mk("家")]
    assert [w.text for w in SG.merge_cjk_words(ws, dict(seg, snapToShots=True), cuts=[ws[1].start])] == ["店", "家"]
    # 旗標取聯集、強調任一即強調、來源：使用者 > LLM > ASR
    t[0] = 0.0
    m = SG.merge_cjk_words([mk("紅", flags={"lowConfidence"}), mk("心", emphasis=True, source="llm")], seg)
    assert len(m) == 1 and m[0].flags == {"lowConfidence"} and m[0].emphasis and m[0].source == "llm"
    # 沒有 maxChars（字幕、卡拉OK、拉丁語言）：原樣返回
    t[0] = 0.0
    raw = [mk("動"), mk("態")]
    assert SG.merge_cjk_words(raw, PR.effective_segmentation("subtitle", "zh-TW")) == raw
    # 壞值不丟例外、視為關閉
    assert SG.max_chars({"maxChars": "6"}) is None and SG.max_chars({"maxChars": 0}) is None and SG.max_chars({"maxChars": True}) is None
    assert SG.max_chars({"maxChars": float("nan")}) is None and SG.max_chars({"maxChars": 6.0}) == 6


def test_strip_line_end_punctuation_rules() -> None:
    assert T.strip_line_end("效果。") == "效果" and T.strip_line_end("贏了，") == "贏了" and T.strip_line_end("甲、乙、") == "甲、乙"
    assert T.strip_line_end("好嗎？") == "好嗎？" and T.strip_line_end("太棒了！") == "太棒了！" and T.strip_line_end("然後…") == "然後…"
    assert T.strip_line_end("他說「好。」") == "他說「好。」"  # 引號收尾：句號在引號裡，不動
    assert T.strip_line_end("好，。 ") == "好" and T.strip_line_end("。") == "。"  # 整行只剩標點：原樣（不產生空白字幕）
    assert T.strip_line_end("card,") == "card," and T.strip_line_end("table.") == "table."  # 拉丁標點不動
    assert T.strip_line_end_tokens(["字幕", "的", "效果。"]) == ["字幕", "的", "效果"]
    assert T.strip_line_end_tokens(["好", "。"]) == ["好", ""]  # 單獨的標點 token 變空字串，索引不動
    assert T.strip_line_end_tokens(["。", "，"]) == ["。", "，"]


def test_linebreak_ignores_line_final_punctuation_width() -> None:
    toks = list("一二三四五六七八九十") + ["。"]
    # 十個中文字 200 寬剛好放滿；句號在行尾不顯示 → 仍然一行（以前會被擠成兩行）
    r = LB.break_lines(toks, fake_measure, max_w=200, max_lines=2)
    assert r.lines == [list(range(len(toks)))] and r.widths == [200.0] and not r.overflow
    # 行中間的逗號照算寬度，換行在逗號後、上一行的寬度不含逗號
    toks = list("一二三四五六七八，") + list("甲乙丙丁戊己庚辛壬")
    r = LB.break_lines(toks, fake_measure, max_w=180, max_lines=2)
    assert toks[r.lines[0][-1]] == "，" and r.widths == [160.0, 180.0]


def test_segment_break_rules() -> None:
    seg = dict(PR.effective_segmentation("subtitle", "en"), maxUnitsPerLine=14, maxLines=1)
    mk = lambda t, a, b: CueWord(t, int(a * 30), int(b * 30), a * 1000, b * 1000)  # noqa: E731
    words = [mk("The", 0, 0.2), mk("price", 0.2, 0.5), mk("is", 0.5, 0.6), mk("12", 0.6, 0.8), mk("%", 0.8, 0.9), mk("and", 0.9, 1.0), mk("rising", 1.0, 1.3)]
    groups = group_words(words, seg)
    assert [" ".join(w.text for w in g) for g in groups] == ["The price", "is 12 %", "and rising"]
    assert all(not (a[-1].text == "12" and b[0].text == "%") for a, b in zip(groups, groups[1:]))
    # 平衡切點剛好會拆開數字與單位時，+50 懲罰讓它改切在前面
    seg3 = dict(seg, maxUnitsPerLine=9)
    w2 = [mk("It", 0, 0.2), mk("costs", 0.2, 0.5), mk("12", 0.6, 0.8), mk("%", 0.8, 0.9), mk("more", 0.9, 1.0)]
    assert [[w.text for w in g] for g in group_words(w2, seg3)] == [["It", "costs"], ["12", "%", "more"]]
    seg2 = dict(seg, maxUnitsPerLine=100, snapToShots=True)
    groups = group_words(words, seg2, cuts=[int(0.55 * 30)])  # 切點在 is(15) 與 12(18) 之間
    assert [g[0].text for g in groups] == ["The", "12"]
    groups = group_words([mk("Hi.", 0, 0.3), mk("Bye", 0.3, 0.5)], seg2)
    assert len(groups) == 2
    groups = group_words([mk("a", 0, 0.3), mk("b", 1.2, 1.5)], seg2)  # 停頓 900 ms ≥ 700
    assert len(groups) == 2


def test_retime_min_duration_chain_and_snap() -> None:
    fps = (24, 1)
    seg = PR.effective_segmentation("subtitle", "en")
    w = lambda t, a, b: CueWord(t, a, b, a / 24 * 1000, b / 24 * 1000)  # noqa: E731
    cues = retime([[w("One.", 10, 14)], [w("Two.", 40, 44)], [w("Three.", 49, 52)]], seg, fps, 200, cuts=[48])
    # 最短 833 ms = 20 幀（→30）；離下一則 10 幀 < chain 500 ms（12 幀）→ 接到 40 − gap 2 = 38
    assert (cues[0].start, cues[0].end) == (10, 38)
    # 「Two.」夾在兩則之間放不滿最短時長 → tooFast；終點吸到切點 48 − gap
    assert (cues[1].start, cues[1].end) == (40, 46) and "tooFast" in cues[1].flags
    assert cues[2].start == 48  # 起點在切點後 0.5 s 內 → 吸到切點
    assert all(a.end + 2 <= b.start for a, b in zip(cues, cues[1:]))
    # chain：小縫（< 500 ms）接起來
    cues = retime([[w("A", 10, 40)], [w("B", 58, 90)]], seg, fps, 200)
    assert cues[0].end == 56


# ================================================================ 動畫


def test_anim_curves_match_spec_numbers() -> None:
    assert A.ease_out_cubic(0.5) == 0.875
    assert abs(A.ease_out_back(0.5) - 1.0876975) < 1e-7
    assert abs(A.ease_out_back(0.0)) < 1e-12 and abs(A.ease_out_back(1.0) - 1.0) < 1e-12
    ts = np.linspace(0, 1, 100001)
    vals = np.array([A.ease_out_back(float(t)) for t in ts[::10]])
    i = int(np.argmax(vals))
    assert abs(ts[::10][i] - 0.5801) < 1e-3 and abs(vals[i] - 1.1000) < 1e-4
    wd = 2 * math.pi * 5 * math.sqrt(1 - 0.35**2)
    assert abs(wd - 29.43) < 0.01
    settle = math.log(50) / (0.35 * 2 * math.pi * 5)
    assert abs(settle - 0.356) < 1e-3 and abs(A.spring_dy(settle, 1.0)) <= 0.02 + 1e-9


def test_anim_word_states_typewriter_and_pop() -> None:
    starts, ends, cue_end = [10, 16, 25], [14, 22, 30], 34
    st = lambda k: [(s.state, round(s.progress, 4)) for s in A.word_states(starts, ends, cue_end, k)]  # noqa: E731
    assert [s for s, _ in st(9)] == ["future", "future", "future"]
    assert [s for s, _ in st(10)] == ["active", "future", "future"]
    assert [s for s, _ in st(15)] == ["active", "future", "future"]  # A_0 = [10,16)：詞講完到下一個詞開始前仍是 active
    assert [s for s, _ in st(16)] == ["past", "active", "future"]
    assert [s for s, _ in st(33)] == ["past", "past", "active"] and [s for s, _ in st(34)] == ["past", "past", "past"]
    assert st(10)[0][1] == round(0.5 / 4, 4) and st(13)[0][1] == round(3.5 / 4, 4) and st(14)[0][1] == 1.0
    ws = A.word_states(starts, ends, cue_end, 19)[1]
    assert A.typewriter_chars(ws, 5) == math.ceil(3.5 / 6 * 5)
    assert A.typewriter_chars(A.word_states(starts, ends, cue_end, 15)[1], 5) == 0 and A.typewriter_chars(A.word_states(starts, ends, cue_end, 25)[1], 5) == 5
    fps = (30, 1)
    s16 = A.word_pop_scale(A.word_states(starts, ends, cue_end, 16)[1], 16, fps, 1.15, 120)
    assert abs(s16 - (1 + 0.15 * A.ease_out_back(0.5 / 30 * 1000 / 120))) < 1e-12
    assert A.word_pop_scale(A.word_states(starts, ends, cue_end, 30)[1], 30, fps, 1.15, 120) == 1.0  # 退場後 120 ms 回到 1
    ca = A.cue_anim({"cueIn": "pop", "cueInMs": 150}, 10, 10, 40, fps)
    t = 0.5 / 30 * 1000 / 150
    assert abs(ca.scale - (0.7 + 0.3 * A.ease_out_back(t))) < 1e-12 and abs(ca.opacity - A.ease_out_cubic(t)) < 1e-12
    fade = A.cue_anim({"cueIn": "fade", "cueInMs": 80, "cueOut": "fade", "cueOutMs": 80}, 39, 10, 40, fps)
    assert abs(fade.opacity - (0.5 / 30 * 1000 / 80)) < 1e-12


def test_anim_golden_is_stable_and_matches_shared_fixture() -> None:
    g1, g2 = A.golden_cases(), A.golden_cases()
    assert json.dumps(g1, sort_keys=True) == json.dumps(g2, sort_keys=True)
    assert g1["easeOutBack"]["0.5"] == 1.0876975 and g1["easeOutCubic"]["0.5"] == 0.875
    shared = REPO / "fixtures" / "captions" / "anim.golden.json"
    if shared.is_file():  # TS anim.ts 與 Python 共用（前端組產生時才比對）
        doc = json.loads(shared.read_text(encoding="utf-8"))
        for key in ("easeOutCubic", "easeOutBack"):
            for t, v in doc.get(key, {}).items():
                assert abs(getattr(A, {"easeOutCubic": "ease_out_cubic", "easeOutBack": "ease_out_back"}[key])(float(t)) - float(v)) < 1e-6


# ================================================================ 換行


def fake_measure(t: str) -> float:
    return 10.0 * T.units(t)


def test_linebreak_prohibited_positions_and_bottom_heavy() -> None:
    toks = list("一二三四五六七八九十，甲乙丙丁戊己庚辛")
    r = LB.break_lines(toks, fake_measure, max_w=220, max_lines=2)
    assert not r.overflow and len(r.lines) == 2
    assert toks[r.lines[1][0]] != "，"  # 不在全形逗號前換行
    assert r.widths[0] <= r.widths[1]  # 下重上輕：逗號後換行會變上重下輕（220/160），輸給 180/200
    # 逗號後換行有加分：兩種切法都下重上輕時選逗號那一個
    toks = list("一二三四，五六七八九十")
    r = LB.break_lines(toks, fake_measure, max_w=140, max_lines=2)
    assert toks[r.lines[0][-1]] == "，" and r.widths[0] <= r.widths[1]
    toks = ["「", "好", "」", "的"]
    r = LB.break_lines(toks, fake_measure, max_w=60, max_lines=2)  # 唯一合法的切法：「好」｜的
    assert r.lines == [[0, 1, 2], [3]] and not r.overflow


def test_linebreak_single_line_orphans_and_overflow() -> None:
    words = "The waiter turns over the third card".split()
    m = lambda t: 10.0 * len(t)  # noqa: E731
    sp = lambda a, b: 10.0  # noqa: E731
    r = LB.break_lines(words, m, max_w=400, max_lines=2, space_between=sp)
    assert r.lines == [list(range(len(words)))]  # 放得下就一行
    r = LB.break_lines(words, m, max_w=200, max_lines=2, space_between=sp)
    assert len(r.lines) == 2 and not r.overflow
    assert all(not (len(ln) == 1 and len(words[ln[0]]) <= 3) for ln in r.lines)  # 沒有孤兒行
    r = LB.break_lines(["Supercalifragilistic"], m, max_w=150, max_lines=1, space_between=sp)
    assert r.scale == 0.8 and r.overflow
    r = LB.break_lines(["無法換行的超長中文詞彙"], fake_measure, max_w=100, max_lines=2)
    assert r.hard_wrapped and r.tokens is not None and len(r.lines) >= 2


# ================================================================ 點陣化 / 燒錄


def simple_track(preset: str = "subtitle", style: dict | None = None, cues: list | None = None) -> dict:
    cues = cues or [
        {"id": "c1", "startFrame": 2, "endFrame": 8, "words": [{"text": "HELLO", "startFrame": 2, "endFrame": 5, "prob": 0.9}, {"text": "WORLD", "startFrame": 5, "endFrame": 8, "prob": 0.9, "emphasis": True}], "lang": "en"},
        {"id": "c2", "startFrame": 10, "endFrame": 14, "words": [{"text": "AGAIN", "startFrame": 10, "endFrame": 14, "prob": 0.9}], "lang": "en"},
    ]
    return {"enabled": True, "language": "en", "source": None, "presetId": preset, "style": style or {}, "segmentation": PR.effective_segmentation(preset, "en"), "cues": cues}


def test_raster_and_overlay_deterministic() -> None:
    tr = simple_track("pop")
    a = CaptionBurner(tr, 640, 360, (30, 1), font=BUILTIN)
    b = CaptionBurner(tr, 640, 360, (30, 1), font=BUILTIN)
    for k in (2, 3, 6, 11):
        ra, rb = a.rgba_frame(k), b.rgba_frame(k)
        assert ra.shape == (360, 640, 4) and np.array_equal(ra, rb) and ra[..., 3].max() > 0, k
    assert a.rgba_frame(0)[..., 3].max() == 0 and a.rgba_frame(9)[..., 3].max() == 0
    s1 = a.raster_for(a.track_style).sprite("HELLO", "#FFE600", 1.15)
    s2 = b.raster_for(b.track_style).sprite("HELLO", "#FFE600", 1.15)
    assert np.array_equal(s1.rgba, s2.rgba) and (s1.ox, s1.oy) == (s2.ox, s2.oy)
    assert hashlib.sha1(a.rgba_frame(3).tobytes()).hexdigest() == hashlib.sha1(a.rgba_frame(3).tobytes()).hexdigest()  # 快取命中後仍相同


def _checker(w: int, h: int, color_range: str = "tv", matrix: str = "bt709") -> Yuv420:
    rng = np.random.default_rng(7)
    y = rng.integers(16, 236, (h, w), dtype=np.uint8)
    u = rng.integers(16, 241, ((h + 1) // 2, (w + 1) // 2), dtype=np.uint8)
    v = rng.integers(16, 241, ((h + 1) // 2, (w + 1) // 2), dtype=np.uint8)
    return Yuv420(y, u, v, matrix=matrix, color_range=color_range)


@pytest.mark.parametrize("size", [(640, 360), (641, 361)])
def test_burn_only_touches_caption_boxes(size: tuple[int, int]) -> None:
    W, H = size
    for preset in PR.PRESET_IDS:
        b = CaptionBurner(simple_track(preset), W, H, (30, 1), font=BUILTIN)
        fr = _checker(W, H)
        snap = (fr.y.copy(), fr.u.copy(), fr.v.copy())
        for k in range(0, 15):
            out = b.apply(fr, k)
            assert np.array_equal(fr.y, snap[0]) and np.array_equal(fr.u, snap[1]) and np.array_equal(fr.v, snap[2]), "輸入幀被改了"
            if not b.cues_at(k):
                assert out is fr, (preset, k)
                continue
            inside = np.zeros((H, W), bool)
            for x0, y0, x1, y1 in b.boxes_at(k):
                inside[y0:y1, x0:x1] = True
            ch = np.zeros(fr.u.shape, bool)
            for x0, y0, x1, y1 in b.boxes_at(k):
                ch[y0 // 2 : (y1 + 1) // 2, x0 // 2 : (x1 + 1) // 2] = True
            assert np.array_equal(out.y[~inside], fr.y[~inside]) and np.array_equal(out.u[~ch], fr.u[~ch]) and np.array_equal(out.v[~ch], fr.v[~ch]), (preset, k)
            # 框內 alpha = 0 的亮度像素也逐位元相同（Y 只寫 alpha > 0）
            alpha0 = b.rgba_frame(k)[..., 3] == 0
            cov = np.zeros((H, W), bool)
            for x0, y0, canvas in b.overlays(k):
                h, w = canvas.shape[:2]
                sub = cov[y0 : y0 + h, x0 : x0 + w]
                sub |= canvas[: sub.shape[0], : sub.shape[1], 3] > 0
            assert np.array_equal(out.y[~cov], fr.y[~cov]) and (alpha0 | cov).all(), (preset, k)
            assert not np.array_equal(out.y, fr.y), (preset, k)


def test_burn_white_levels_matrix_and_frozen_frame() -> None:
    style = {"font": {"sizePctShortSide": 30}, "stroke": {"widthPct": 0}, "shadow": None, "animation": {"cueIn": "none", "cueOut": "none", "word": "none"}, "colors": {"text": "#FFFFFF"}}
    tr = simple_track("subtitle", style)
    b = CaptionBurner(tr, 640, 360, (30, 1), font=BUILTIN)
    for rng, white in (("tv", 235), ("pc", 255)):
        fr = Yuv420.blank(640, 360, y=16 if rng == "tv" else 0, color_range=rng)
        out = b.apply(fr, 3)
        assert int(out.y.max()) == white and int(out.u[out.u != 128].size) >= 0
    red = simple_track("subtitle", {**style, "colors": {"text": "#FF0000", "emphasis": "#FF0000"}})
    b = CaptionBurner(red, 640, 360, (30, 1), font=BUILTIN)
    y709 = int(b.apply(Yuv420.blank(640, 360, y=16, matrix="bt709"), 3).y.max())
    y601 = int(b.apply(Yuv420.blank(640, 360, y=16, matrix="bt601"), 3).y.max())
    assert (y709, y601) == (63, 81)  # 16 + 219·0.2126、16 + 219·0.299
    # 定格：同一個來源幀物件重送給 k 與 k+1（淡入中）→ 物件本身不變、兩個輸出不同
    fade = CaptionBurner(simple_track("subtitle"), 640, 360, (30, 1), font=BUILTIN)
    fr = _checker(640, 360)
    h0 = hashlib.sha1(fr.to_bytes()).hexdigest()
    o1, o2 = fade.apply(fr, 2), fade.apply(fr, 3)
    assert hashlib.sha1(fr.to_bytes()).hexdigest() == h0 and not np.array_equal(o1.y, o2.y)


def test_blend_rejects_empty_and_clips_to_frame() -> None:
    y = np.full((10, 10), 50, np.uint8)
    u = np.full((5, 5), 128, np.uint8)
    v = np.full((5, 5), 128, np.uint8)
    canvas = np.zeros((6, 6, 4), np.float32)
    assert not blend_rgba_into_yuv(y, u, v, 2, 2, canvas)
    canvas[..., :] = (1.0, 1.0, 1.0, 1.0)
    assert blend_rgba_into_yuv(y, u, v, 7, 7, canvas)  # 超出右下角：裁掉不炸
    assert (y[7:, 7:] == 235).all() and (y[:7, :7] == 50).all()


def test_burner_for_modes() -> None:
    tr = simple_track()
    assert burner_for(tr, 64, 36, (30, 1), "off") is None
    assert burner_for(dict(tr, enabled=False), 64, 36, (30, 1), "auto") is None
    assert burner_for(dict(tr, enabled=False), 64, 36, (30, 1), "on") is not None
    assert burner_for(None, 64, 36, (30, 1), "on") is None


def _first_file(*cands: str) -> str | None:
    import os

    for c in cands:
        p = os.path.expandvars(c)
        if "%" not in p and "$" not in p and Path(p).is_file():
            return p
    return None


LATIN_FONT_FILE = _first_file(
    r"%WINDIR%\Fonts\arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf", "/Library/Fonts/Arial.ttf",
)
CJK_FONT_FILE = _first_file(
    r"%WINDIR%\Fonts\msjh.ttc", r"%WINDIR%\Fonts\NotoSansTC-VF.ttf", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc", "/System/Library/Fonts/PingFang.ttc", "/System/Library/Fonts/Hiragino Sans GB.ttc",
)


def test_font_covers_cjk_is_measured(tmp_path: Path) -> None:
    from aivc.captions import fonts as F

    assert not F.covers_cjk(None) and not F.covers_cjk(str(tmp_path / "missing.ttf"))
    bad = tmp_path / "bad.ttf"
    bad.write_bytes(b"not a font")
    assert not F.covers_cjk(str(bad))
    if LATIN_FONT_FILE is None and CJK_FONT_FILE is None:
        pytest.skip("系統上找不到可用來驗證的拉丁／中文字型檔")
    if LATIN_FONT_FILE is not None:
        assert not F.covers_cjk(LATIN_FONT_FILE), LATIN_FONT_FILE
    if CJK_FONT_FILE is not None:
        assert F.covers_cjk(CJK_FONT_FILE), CJK_FONT_FILE
    if LATIN_FONT_FILE is not None:
        # 使用者明確指定的字型檔照用，但 cjk 照實回報
        F._resolve_cached.cache_clear()
        spec = resolve_font({"font": {"file": LATIN_FONT_FILE, "families": [], "weight": 700}}, "zh-TW")
        assert spec.path == LATIN_FONT_FILE and spec.source == "file" and spec.cjk is False


def test_font_resolution_requires_cjk_coverage_for_cjk_languages(monkeypatch: pytest.MonkeyPatch) -> None:
    """模擬 Linux 沒裝中文字型：fc-match 對任何家族都回 DejaVu Sans（沒有中文字形）。以前會標 cjk=True、燒出方塊沒有警告。"""
    from aivc.captions import fonts as F

    assert not set(F.FALLBACK_CJK) & set(F.FALLBACK_LATIN)  # 中日韓回退清單不能混拉丁字型
    calls: list[str] = []
    world: dict[str, F.FontSpec] = {}

    def fake_lookup(family: str, weight: int) -> F.FontSpec | None:
        calls.append(family)
        return world.get(family) or F.FontSpec("/usr/share/fonts/DejaVuSans.ttf", 0, None, family, False, "fc-match")

    monkeypatch.setattr(F, "lookup_family", fake_lookup)
    monkeypatch.setattr(F, "_fc_lang_font", lambda language, weight: None)
    style = PR.preset("pop")["style"]
    F._resolve_cached.cache_clear()
    try:
        spec = resolve_font(style, "zh-TW")
        assert spec.cjk is False and spec.path == "/usr/share/fonts/DejaVuSans.ttf"
        assert calls[: len(style["font"]["families"])] == style["font"]["families"] and set(F.FALLBACK_CJK) <= set(calls)
        w = F.missing_cjk_warning(spec, needs_cjk=True)
        assert w is not None and w["kind"] == "fontNoCjk" and "方塊" in w["message"]
        assert F.missing_cjk_warning(spec, needs_cjk=False) is None
        # 清單後面的字型真的有中文 → 跳過前面缺字的家族選它
        world["Noto Sans CJK TC"] = F.FontSpec("/usr/share/fonts/NotoSansCJK-Bold.ttc", 0, None, "Noto Sans CJK TC", True, "fc-match")
        F._resolve_cached.cache_clear()
        assert resolve_font(style, "zh-TW").path == "/usr/share/fonts/NotoSansCJK-Bold.ttc"
        # 拉丁語言不要求中文字形：第一個找得到的拉丁字型
        F._resolve_cached.cache_clear()
        assert resolve_font(style, "en").cjk is False
    finally:
        F._resolve_cached.cache_clear()  # 假的解析結果不能留在快取裡污染其他測試
    # 燒錄器：中文 track 用缺字字型 → fontNoCjk 警告（進 render 計畫 / layout.v1.json 的 warnings）；英文 track 不警告
    nocjk = F.FontSpec("/fonts/DejaVuSans.ttf", 0, None, "DejaVu Sans", False, "fc-match")
    zh = simple_track("pop", cues=[{"id": "c1", "startFrame": 0, "endFrame": 5, "words": [{"text": "百家姓", "startFrame": 0, "endFrame": 5}]}])
    zh["language"] = "zh-TW"
    assert [w["kind"] for w in CaptionBurner(zh, 64, 36, (30, 1), font=nocjk).warnings] == ["fontNoCjk"]
    assert CaptionBurner(simple_track("pop"), 64, 36, (30, 1), font=nocjk).warnings == []
    assert [w["kind"] for w in CaptionBurner(simple_track("pop"), 64, 36, (30, 1), font=BUILTIN).warnings] == ["fontFallback"]


@pytest.mark.skipif(cjk_font() is None, reason="沒有系統 CJK 字型")
def test_cjk_layout_real_font_fits_safe_area() -> None:
    doc = asr_doc(ZH_WORDS, [(0.24, 12.3)], "zh-TW")
    for W, H in ((1280, 720), (1080, 1920)):
        track = B.build_track(doc, preset_id="subtitle", output_language="zh-TW", fps=(30, 1), n_frames=780)
        b = CaptionBurner(track, W, H, (30, 1))
        assert b.font.cjk
        for c in b.cues:
            lay = b.context(c).layout
            assert not lay.overflow and len(lay.lines) <= 2
            x0, y0, x1, y1 = lay.box
            assert 0 <= x0 < x1 <= W and 0 <= y0 < y1 <= H
            if H / W >= 1.5:
                assert lay.lines[-1].top + lay.lines[-1].height <= H * 0.82 + 1


# ================================================================ 匯出


def export_track() -> dict:
    return {
        "enabled": True, "language": "zh-TW", "source": None, "presetId": "karaoke", "style": {}, "segmentation": PR.effective_segmentation("subtitle", "zh-TW"),
        "cues": [
            {"id": "c1", "startFrame": 1799, "endFrame": 1830, "words": [{"text": "歡迎", "startFrame": 1799, "endFrame": 1810}, {"text": "來到", "startFrame": 1810, "endFrame": 1830}]},
            {"id": "c2", "startFrame": 1840, "endFrame": 1850, "hidden": True, "words": [{"text": "藏起來", "startFrame": 1840, "endFrame": 1850}]},
            {"id": "c3", "startFrame": 1900, "endFrame": 1950, "speaker": "A", "words": [{"text": "Hello", "startFrame": 1900, "endFrame": 1920}, {"text": "world.", "startFrame": 1920, "endFrame": 1950}]},
        ],
    }


def test_export_srt_vtt_txt_golden(tmp_path: Path) -> None:
    fps = (30000, 1001)
    tr = export_track()
    srt = X.export_text(tr, "srt", fps, 1280, 720)
    assert srt == "1\n00:01:00,027 --> 00:01:01,061\n歡迎來到\n\n2\n00:01:03,397 --> 00:01:05,065\nHello world.\n"
    vtt = X.export_text(tr, "vtt", fps, 1280, 720)
    assert vtt == "WEBVTT\n\n00:01:00.027 --> 00:01:01.061\n歡迎來到\n\n00:01:03.397 --> 00:01:05.065\nHello world.\n"
    vttw = X.export_text(tr, "vtt", fps, 1280, 720, vtt_word_timing=True, speaker_prefix=True)
    assert "歡迎<00:01:00.394>來到" in vttw and "<v A>Hello <00:01:04.064>world." in vttw
    assert X.export_text(tr, "txt", fps, 1280, 720, speaker_prefix=True) == "歡迎來到\nA: Hello world.\n"
    # --range + --trim：裁到範圍、時間減 K0
    srt2 = X.export_text(tr, "srt", fps, 1280, 720, range_frames=(1820, 1910), trim=True)
    assert srt2 == "1\n00:00:00,000 --> 00:00:00,334\n來到\n\n2\n00:00:02,669 --> 00:00:03,003\nHello\n"
    p = tmp_path / "a.srt"
    X.write_text(p, srt)
    raw = p.read_bytes()
    assert not raw.startswith(b"\xef\xbb\xbf") and b"\r\n" not in raw and raw.decode("utf-8") == srt


def test_export_ass_golden() -> None:
    ass = X.export_text(export_track(), "ass", (30000, 1001), 1280, 720)
    lines = ass.splitlines()
    assert lines[0] == "[Script Info]" and "PlayResX: 1280" in lines and "PlayResY: 720" in lines
    style = next(ln for ln in lines if ln.startswith("Style: Default,"))
    assert style == "Style: Default,Microsoft JhengHei,43,&H000AD6FF,&H00FFFFFF,&H00000000,&H5F000000,-1,0,0,0,100,100,0,0,1,4.3,1.3,2,64,64,36,1"
    dia = [ln for ln in lines if ln.startswith("Dialogue:")]
    assert dia == [
        "Dialogue: 0,0:01:00.03,0:01:01.06,Default,,0,0,0,,{\\kf37}歡迎{\\kf67}來到",
        "Dialogue: 0,0:01:03.40,0:01:05.07,Default,A,0,0,0,,{\\kf67}Hello {\\kf100}world.",
    ]


def test_export_and_layout_strip_line_final_cjk_punctuation() -> None:
    fps = (30, 1)
    w = lambda t, a, b: {"text": t, "startFrame": a, "endFrame": b}  # noqa: E731
    tr = {
        "enabled": True, "language": "zh-TW", "source": None, "presetId": "karaoke", "style": {}, "segmentation": dict(PR.effective_segmentation("subtitle", "zh-TW"), maxUnitsPerLine=10, maxLines=2),
        "cues": [
            {"id": "c1", "startFrame": 0, "endFrame": 30, "words": [w("字幕的", 0, 10), w("效果。", 10, 30)]},
            {"id": "c2", "startFrame": 30, "endFrame": 60, "words": [w("好嗎？", 30, 60)]},
            # c1「字幕的效果。」12 單位，句號不顯示 → 10 單位剛好一行。
                # 兩行：第一行以逗號收尾、第二行以句號收尾 → 兩個行尾都拿掉；單獨的「。」token 不留空字、不留時間標記
            {"id": "c3", "startFrame": 60, "endFrame": 90, "words": [w("玩家", 60, 66), w("贏了，", 66, 72), w("請注意", 72, 84), w("。", 84, 90)]},
        ],
    }
    srt = X.export_text(tr, "srt", fps, 1280, 720)
    assert srt.split("\n\n") == ["1\n00:00:00,000 --> 00:00:01,000\n字幕的效果", "2\n00:00:01,000 --> 00:00:02,000\n好嗎？", "3\n00:00:02,000 --> 00:00:03,000\n玩家贏了\n請注意\n"]
    vtt = X.export_text(tr, "vtt", fps, 1280, 720, vtt_word_timing=True)
    assert "字幕的<00:00:00.333>效果\n" in vtt and "玩家<00:00:02.200>贏了\n<00:00:02.400>請注意\n" in vtt
    ass = [ln for ln in X.export_text(tr, "ass", fps, 1280, 720).splitlines() if ln.startswith("Dialogue:")]
    # 卡拉OK 時間照樣逐詞輸出（總長不變），被拿掉的字不顯示
    assert ass[0].endswith("{\\kf33}字幕的{\\kf67}效果") and ass[2].endswith("{\\kf20}玩家{\\kf20}贏了\\N{\\kf40}請注意{\\kf20}")
    assert X.export_text(tr, "txt", fps, 1280, 720).splitlines()[0] == "字幕的效果。"  # 逐字稿保留標點
    # 燒錄／舞台版面：同一條規則（字型用 Pillow 內建：只量寬，不需要中文字形）
    b = CaptionBurner(dict(tr, presetId="subtitle"), 1280, 720, fps, font=BUILTIN)
    texts = lambda cid: [[p.text for p in ln.pieces] for ln in b.context(next(c for c in b.cues if c["id"] == cid)).layout.lines]  # noqa: E731
    assert texts("c1") == [["字幕的", "效果"]] and texts("c2") == [["好嗎？"]]
    lay3 = b.context(next(c for c in b.cues if c["id"] == "c3")).layout
    assert [[p.text for p in ln.pieces] for ln in lay3.lines] in ([["玩家", "贏了"], ["請注意"]], [["玩家", "贏了，", "請注意"]])
    assert all(p.word != 3 for ln in lay3.lines for p in ln.pieces)  # 「。」沒有 piece
    assert b.rgba_frame(70)[..., 3].max() > 0


# ================================================================ 專案 schema


def _project_with_captions() -> str:
    base = S.ProjectFileV1()
    base.media.append(S.MediaV1("m1", "clip.webm", "clip.webm", "0" * 64, None, S.ProxyMetaV1(S.Rational(30, 1), 100, 64, 36)))
    base.active_media_id = "m1"
    base.created_at = base.updated_at = "2026-09-17T00:00:00.000Z"
    d = base.to_json()
    d["captions"] = {
        "m1": {
            "engineFutureKey": {"x": 1},
            "enabled": True,
            "language": "zh-TW",
            "source": {"backend": "faster-whisper", "model": "large-v3-turbo", "device": "cuda", "computeType": "float16", "asrLanguage": "zh", "detected": "zh", "languageProb": 1, "asrPath": "a.json", "transcribedAt": "2026-09-17T00:00:00.000Z", "vramMb": 2600},
            "presetId": "pop",
            "style": {"font": {"weight": 900, "futureFontKey": True}, "colors": {"future": None, "active": "#FFE600"}, "shadow": None, "futureGroup": {"a": 1}},
            "segmentation": dict(PR.effective_segmentation("pop", "zh-TW"), futureSeg=3),
            "cues": [
                {"id": "c1", "startFrame": 2, "endFrame": 20, "words": [{"text": "歡迎", "startFrame": 2, "endFrame": 10, "prob": 0.5, "emphasis": True, "source": "asr", "karaokeKey": [1, 2]}, {"text": "來到", "startFrame": 10, "endFrame": 20}],
                 "speaker": None, "lang": "zh-TW", "styleOverride": {"colors": {"text": "#FF0000"}}, "hidden": False, "flags": ["lowConfidence"], "cueFutureKey": "keep"},
            ],
        }
    }
    return json.dumps(d, ensure_ascii=False, indent=2) + "\n"


def test_schema_captions_round_trip_byte_identical_and_unknown_keys(tmp_path: Path) -> None:
    text = _project_with_captions()
    r = S.loads(text)
    assert r.warnings == []
    assert S.dumps(r.project) == text
    tr = r.project.captions["m1"]
    assert tr["engineFutureKey"] == {"x": 1} and tr["source"]["vramMb"] == 2600 and tr["style"]["futureGroup"] == {"a": 1}
    assert tr["cues"][0]["cueFutureKey"] == "keep" and tr["cues"][0]["words"][0]["karaokeKey"] == [1, 2] and tr["segmentation"]["futureSeg"] == 3
    p = tmp_path / "x.aivc.json"
    S.save(r.project, p, touch_updated_at=False)
    assert p.read_text(encoding="utf-8") == text
    # 沒有字幕 → 不寫 captions 鍵
    none = S.loads(json.dumps({k: v for k, v in json.loads(text).items() if k != "captions"}))
    assert "captions" not in json.loads(S.dumps(none.project))
    empty = json.loads(text)
    empty["captions"] = {}
    assert "captions" not in json.loads(S.dumps(S.loads(json.dumps(empty)).project))
    shared = Path(__file__).parent / "fixtures" / "project" / "v1" / "captions.aivc.json"
    if shared.is_file():  # 前端組建立的共用 fixture：Python 讀寫要逐位元相同
        st = shared.read_text(encoding="utf-8")
        rr = S.loads(st)
        again = S.dumps(rr.project)
        # fixture 本身就是 Python dumps 的輸出（gen 時確認過），所以讀寫要逐位元相同
        assert again == st and rr.warnings == [] and rr.project.captions


def test_schema_v2_doc_keeps_captions_next_to_sequence() -> None:
    """字幕（main）與序列 v2（feat/editor-m2）合併後的護欄：v2 專案檔同時帶 captions、sequence、audioMedia，
    引擎讀進寫出三個鍵都不能少——字幕是不升版號的可省略欄位，不能因為 schemaVersion 變成 2 就被當成未知鍵洗掉，
    序列也不能因為字幕的 sanitize 被動到。"""
    d = json.loads(_project_with_captions())
    d["schemaVersion"] = 2
    d["sequence"] = {
        "id": "seq-1", "name": "clip", "fps": {"num": 30, "den": 1}, "width": 64, "height": 36, "sampleRate": 48000,
        "video": [{"kind": "clip", "id": "c1", "mediaId": "m1", "srcIn": 0, "srcOut": 100, "enabled": True,
                   "audio": {"enabled": True, "gainDb": 0, "fadeIn": 0, "fadeOut": 0, "fadeCurve": "linear", "envelope": []}}],
        "original": {"muted": False, "gainDb": 0}, "audioLanes": [], "audio": {"edgeDeclickMs": 3, "limiter": False},
    }
    d["audioMedia"] = []
    r = S.loads(json.dumps(d, ensure_ascii=False))
    assert r.project.schema_version == 2
    assert r.project.captions["m1"] == d["captions"]["m1"]
    out = json.loads(S.dumps(r.project))
    assert out["schemaVersion"] == 2
    assert out["captions"] == d["captions"]
    assert out["sequence"] == d["sequence"] and out["audioMedia"] == []


def test_schema_captions_drop_and_report() -> None:
    d = json.loads(_project_with_captions())
    t = d["captions"]["m1"]
    t["presetId"] = "neon"
    t["style"]["colors"]["active"] = "yellow"
    t["cues"] = [
        {"id": "ok", "startFrame": 0, "endFrame": 5, "words": [{"text": "a", "startFrame": 0, "endFrame": 3}, {"text": "bad", "startFrame": 4, "endFrame": 9}, {"text": "ov", "startFrame": 2, "endFrame": 4}]},
        {"id": "late", "startFrame": 90, "endFrame": 101, "words": [{"text": "x", "startFrame": 90, "endFrame": 95}]},
        {"id": "empty", "startFrame": 50, "endFrame": 60, "words": []},
        {"id": "ok", "startFrame": 60, "endFrame": 70, "words": [{"text": "dup", "startFrame": 60, "endFrame": 70}]},
        {"id": "overlap", "startFrame": 3, "endFrame": 8, "words": [{"text": "y", "startFrame": 3, "endFrame": 8}], "flags": ["tooFast", "weird"]},
        {"id": "long", "startFrame": 70, "endFrame": 80, "words": [{"text": "z" * 501, "startFrame": 70, "endFrame": 80}]},
    ]
    d["captions"]["ghost"] = {"cues": []}
    r = S.loads(json.dumps(d))
    tr = r.project.captions["m1"]
    assert tr["presetId"] == "subtitle" and "active" not in tr["style"]["colors"]
    assert [c["id"] for c in tr["cues"]] == ["ok"] and [w["text"] for w in tr["cues"][0]["words"]] == ["a"]
    assert "ghost" not in r.project.captions and len(r.warnings) >= 7


def test_presets_file_has_all_ids_and_full_styles() -> None:
    ps = PR.presets()
    assert list(ps) == list(PR.PRESET_IDS)
    keys = {"font", "layout", "colors", "stroke", "shadow", "box", "animation"}
    for pid, p in ps.items():
        assert p["id"] == pid and set(p["style"]) == keys and set(p["segmentation"]) == {"cjk", "latin"}
        for lang in ("cjk", "latin"):
            assert set(p["segmentation"][lang]) == set(S_SEG_KEYS)
    assert PR.effective_style({"presetId": "pop", "style": {"shadow": None, "colors": {"active": "#000000"}}})["shadow"] is None
    assert PR.effective_style({"presetId": "nope"})["font"]["weight"] == 700


S_SEG_KEYS = ("mode", "maxUnitsPerLine", "maxLines", "maxWords", "minDurationMs", "maxDurationMs", "gapFrames", "chainGapMs", "lagOutMs", "pauseBreakMs", "snapToShots", "cpsWarn")


# ================================================================ render 掛勾（合成影片，不需要模型）


@pytest.fixture(scope="module")
def ffmpeg_ready() -> None:
    from aivc import env

    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")


@pytest.fixture
def cap_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    sys.path.insert(0, str(Path(__file__).resolve().parent / "fixtures" / "e1"))
    import synth_scene as SC

    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    n = 16
    rng = np.random.default_rng(3)
    frames = [np.ascontiguousarray(rng.integers(0, 255, (180, 320, 3), dtype=np.uint8)) for _ in range(n)]
    video = SC.write_clip(tmp_path / "clip.mkv", frames)
    ppath, project, _cache = SC.make_project(video, n, [], w=320, h=180)
    track = simple_track("pop")
    track["cues"][1]["endFrame"] = 16
    track["cues"][1]["words"][0]["endFrame"] = 16
    project.captions["m1"] = track
    S.save(project, ppath)
    return ppath, SC


def test_render_plan_and_frames_captions_only_inside_boxes(cap_project, ffmpeg_ready: None, tmp_path: Path) -> None:
    from aivc.media.source import FrameSource
    from aivc.ops import render as RD
    from aivc.project import resolve as R

    ppath, SC = cap_project
    mctx = R.open_media_context(ppath, None, SC.RecordingCtx())
    off = RD.build_plan(mctx, SC.RecordingCtx(), out=str(tmp_path / "off.mkv"), codec="ffv1", gpu=False, captions="off")
    on = RD.build_plan(mctx, SC.RecordingCtx(), out=str(tmp_path / "on.mkv"), codec="ffv1", gpu=False, captions="auto", captions_sidecar="srt")
    assert off.captions is None and off.to_json()["captions"] is None
    d = on.to_json()
    assert d["captions"]["cues"] == 2 and d["captions"]["preset"] == "pop" and "path" in d["captions"]["font"] and d["captionsSidecar"].endswith("on.srt")
    a = list(RD.render_frames(mctx, off, SC.RecordingCtx()))
    b = list(RD.render_frames(mctx, on, SC.RecordingCtx()))
    assert len(a) == len(b) == 16
    with FrameSource(mctx.video) as fs:
        src = [fs.get(i) for i in range(fs.n_frames)]
    for k in range(16):
        assert np.array_equal(a[k].y, src[k].y)
        boxes = on.captions.boxes_at(k)
        if not boxes:
            assert np.array_equal(b[k].y, a[k].y) and np.array_equal(b[k].u, a[k].u) and np.array_equal(b[k].v, a[k].v), k
            continue
        inside = np.zeros(a[k].y.shape, bool)
        ch = np.zeros(a[k].u.shape, bool)
        for x0, y0, x1, y1 in boxes:
            inside[y0:y1, x0:x1] = True
            ch[y0 // 2 : (y1 + 1) // 2, x0 // 2 : (x1 + 1) // 2] = True
        assert not np.array_equal(b[k].y, a[k].y), k
        assert np.array_equal(b[k].y[~inside], a[k].y[~inside]) and np.array_equal(b[k].u[~ch], a[k].u[~ch]) and np.array_equal(b[k].v[~ch], a[k].v[~ch]), k


def test_render_trim_sidecar_shifts_times(cap_project, ffmpeg_ready: None, tmp_path: Path) -> None:
    from aivc.ops import render as RD
    from aivc.project import resolve as R

    ppath, SC = cap_project
    mctx = R.open_media_context(ppath, None, SC.RecordingCtx())
    plan = RD.build_plan(mctx, SC.RecordingCtx(), out=str(tmp_path / "t.mkv"), codec="ffv1", gpu=False, range_spec="4:12", trim=True, captions="on", captions_sidecar="srt")
    ctx = SC.RecordingCtx()
    info = RD.run_render(mctx, plan, ctx)
    assert info["frames"] == 8 and info["captionsSidecar"] and Path(info["captionsSidecar"]).is_file()
    srt = Path(info["captionsSidecar"]).read_text(encoding="utf-8")
    # c1 [2,8) → [4,8) − 4 = [0,4)；c2 [10,16) → [10,12) − 4 = [6,8)
    assert srt == "1\n00:00:00,000 --> 00:00:00,133\nHELLO WORLD\n\n2\n00:00:00,200 --> 00:00:00,267\nAGAIN\n"
    assert any(kind == "captions.srt" for _p, kind in ctx.artifacts)
    from aivc.media.source import FrameSource

    with FrameSource(tmp_path / "t.mkv") as fs:
        assert fs.n_frames == 8


def test_render_sidecar_never_overwrites_without_flag(cap_project, ffmpeg_ready: None, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """同名字幕檔已存在（可能是使用者手修過的）：沒帶 --overwrite-sidecar → 編碼前就報錯、字幕檔與影片都不動；帶了才覆寫。"""
    from aivc.cli import main
    from aivc.ops import OpError
    from aivc.ops import render as RD
    from aivc.project import resolve as R

    ppath, SC = cap_project
    mctx = R.open_media_context(ppath, None, SC.RecordingCtx())
    out = tmp_path / "s.mkv"
    existing = tmp_path / "s.srt"
    existing.write_text("手修過的字幕\n", encoding="utf-8")
    plan = RD.build_plan(mctx, SC.RecordingCtx(), out=str(out), codec="ffv1", gpu=False, captions="on", captions_sidecar="srt")
    d = plan.to_json()
    assert d["captionsSidecarExists"] is True and d["overwriteSidecar"] is False and plan.sidecar_blocked() == existing
    with pytest.raises(OpError) as ei:
        RD.run_render(mctx, plan, SC.RecordingCtx())
    assert ei.value.kind == "Invalid" and "--overwrite-sidecar" in ei.value.hint
    assert existing.read_text(encoding="utf-8") == "手修過的字幕\n" and not out.exists()  # 沒開始編碼
    # 計畫（dry run）不報錯，只回報
    code = main(["--json", "render-plan", str(ppath), "-o", str(out), "--codec", "ffv1", "--no-gpu", "--captions", "on", "--captions-sidecar", "srt"])
    final = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0 and final["result"]["captionsSidecarExists"] is True
    # 編碼期間才冒出來的同名檔：影片照樣完成，字幕檔略過並警告
    fresh = RD.build_plan(mctx, SC.RecordingCtx(), out=str(tmp_path / "late.mkv"), codec="ffv1", gpu=False, captions="on", captions_sidecar="srt")
    assert fresh.to_json()["captionsSidecarExists"] is False
    (tmp_path / "late.srt").write_text("別人寫的\n", encoding="utf-8")
    ctx = SC.RecordingCtx()
    assert RD.write_sidecar(fresh, ctx) is None and (tmp_path / "late.srt").read_text(encoding="utf-8") == "別人寫的\n"
    assert any(level == "warn" and "不覆寫" in msg for level, msg in ctx.logs)
    # --overwrite-sidecar：覆寫
    code = main(["--json", "render", str(ppath), "-o", str(out), "--codec", "ffv1", "--no-gpu", "--captions", "on", "--captions-sidecar", "srt", "--overwrite-sidecar"])
    final = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0 and final["ok"], final
    assert out.is_file() and existing.read_text(encoding="utf-8").startswith("1\n00:00:00,067 --> ")


def test_render_plan_cli_reports_captions(cap_project, ffmpeg_ready: None, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    from aivc.cli import main

    ppath, _SC = cap_project
    code = main(["--json", "render-plan", str(ppath), "-o", str(tmp_path / "x.mkv"), "--codec", "ffv1", "--no-gpu", "--captions", "on", "--captions-sidecar", "vtt"])
    final = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0 and final["result"]["captions"]["cues"] == 2 and final["result"]["captionsSidecar"].endswith("x.vtt")
    code = main(["--json", "render-plan", str(ppath), "-o", str(tmp_path / "x.mkv"), "--codec", "ffv1", "--no-gpu", "--captions", "off"])
    final = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert code == 0 and final["result"]["captions"] is None


def test_captions_ops_build_export_layout_preview(cap_project, tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """captions-build（從 ASR 檔）→ captions-export → captions-layout → captions-preview，全走 CLI。"""
    from aivc.asr import cache as AC
    from aivc.cli import main
    from aivc.media.cache import write_json
    from aivc.project import resolve as R

    ppath, SC = cap_project
    mctx = R.open_media_context(ppath, None, SC.RecordingCtx())
    doc = asr_doc([(0.0, 0.1, " Hi", 0.9), (0.1, 0.3, " there.", 0.9)], None, "en")
    asr = AC.asr_path(Path(mctx.cache.root), "deadbeefdeadbeef")
    write_json(asr, doc)

    def run(*argv: str) -> dict:
        code = main(["--json", *argv])
        out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
        assert code == 0 and out["ok"], out
        return out["result"]

    tr = run("captions-build", str(ppath), "--preset", "karaoke")
    assert tr["presetId"] == "karaoke" and [w["text"] for w in tr["cues"][0]["words"]] == ["Hi", "there."] and tr["source"]["asrPath"] == str(asr)
    saved = S.load(ppath).project.captions["m1"]
    assert saved["cues"] == tr["cues"]
    ex = run("captions-export", str(ppath), "--format", "srt", "-o", str(tmp_path / "c.srt"))
    assert ex["cues"] == 1 and (tmp_path / "c.srt").read_text(encoding="utf-8").startswith("1\n00:00:00,000 --> ")
    lay = run("captions-layout", str(ppath))
    ld = json.loads(Path(lay["path"]).read_text(encoding="utf-8"))
    sp = ld["cues"][0]["lines"][0]["words"][0]["sprites"]
    assert Path(lay["atlas"]).is_file() and sp["active"][2] > 0 and sp["under"][2] > 0 and set(sp["fill"]) == {"future", "active", "past"}
    assert lay["relPath"] == f"captions/{lay['key']}/layout.v1.json" and ld["atlas"]["path"] == "atlas.v1.png"
    # 同一份字幕再要一次：命中快取（不重畫圖集）
    assert run("captions-layout", str(ppath))["key"] == lay["key"]
    pv = run("captions-preview", str(ppath), "--frame", "1", "-o", str(tmp_path / "p.png"))
    from PIL import Image

    im = np.asarray(Image.open(tmp_path / "p.png"))
    assert im.shape == (180, 320, 4) and im[..., 3].max() > 0 and pv["cues"] == ["c1"]
    tr2 = run("captions-build", str(ppath), "--preset", "pop", "--no-save", "--segmentation", '{"maxLines": 1}')
    assert tr2["segmentation"]["maxLines"] == 1 and S.load(ppath).project.captions["m1"]["presetId"] == "karaoke"
