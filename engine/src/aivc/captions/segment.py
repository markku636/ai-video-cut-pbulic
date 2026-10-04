"""詞 → 字幕則（研究規格 §5.3 C，一趟掃描）。

硬斷點（在這個詞之前一定斷）：換講者、停頓 ≥ pauseBreakMs、前一詞以句末標點結尾、兩詞之間有鏡頭切點（snapToShots）。
上限斷點（加進來會超過 maxUnitsPerLine×maxLines、maxWords、maxChars、maxDurationMs）不一定斷在這個詞前面：
往回最多 6 個詞找成本最低的切點 `penalty(j) + 0.02·|左單位 − 右單位|` ——
逗號／停頓後 −15、英文連接詞前 −10、中文連接詞前 −8、把數字和單位拆開 +50。
為什麼要往回找：Netflix 規範「斷在標點或連接詞前、不拆數字與單位」；硬塞到滿才斷會出現「…價格是 12 | 元」。
顯示單位不算行尾會被拿掉的 。，、（text.strip_line_end）：預算要跟畫面上真的出現的字一致。

中文（segmentation 有 `maxChars` 時，目前是 pop／bounce 的中日韓版本，presets.CJK_MAX_CHARS）：
Whisper 的中文 token 常常是單字（實測「注意|動|態|字|幕|的|效|果。」），拿 maxWords=3 去數會切成「注意動 | 態字 | 幕的效 | 果。」。
所以先把相鄰、沒有標點、沒有停頓的漢字 token 依不查字典的規則併成詞（merge_cjk_words），再分段：
- 中日韓字數用 maxChars 限制（逐字算，不算標點）；maxWords 只數不含中日韓字的 token（拉丁詞維持原本「幾個詞」的語意）。
- 併好的詞是分段的最小單位 → 分段永遠不會切在詞中間；只有併起來會超過 maxChars 時才不併。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Sequence

from . import text as T

LOOKBACK = 6
# 兩個漢字 token 之間的空檔 < 150 ms 才可能是同一個詞（跟 split_penalty 的「停頓」門檻相同）
JOIN_GAP_MS = 150.0
# 接在前一個詞後面的虛詞（結構助詞、時態、語氣詞、複數）：「字幕的」「贏了」「紅星吧」不該拆開
ZH_SUFFIX = frozenset("的得了著着過过吧嗎吗呢啊呀啦嘛喔哦唷囉们們")
# 自己就是一個詞的常用單字（繫詞、介詞、副詞、代詞、助動詞）：不跟旁邊的單字兩兩配對
ZH_STANDALONE = frozenset("是在和與与跟及或也都就還还很最太更不沒没別别把被給给讓让對对從从向請请我你妳他她它這这那有要會会能")
# 數詞／指示詞：後面緊接的單字多半是量詞（第三|張、這一|局、這|個）→ 併到前一個詞
ZH_NUMERAL_DEMONSTRATIVE = frozenset("零一二三四五六七八九十百千萬万億亿兩两幾几每這这那哪第半")


@dataclass
class CueWord:
    text: str
    start: int  # proxy 幀
    end: int  # exclusive
    start_ms: float = 0.0  # proxy 時間軸毫秒（停頓判斷用；幀四捨五入會吃掉 30 ms 等級的差）
    end_ms: float = 0.0
    prob: float = 1.0
    emphasis: bool = False
    flags: set[str] = field(default_factory=set)
    speaker: str | None = None
    source: str = "asr"


def seq_units(words: Sequence[CueWord]) -> int:
    # 行尾的 。，、 顯示時會拿掉（text.strip_line_end），不佔預算：「第三張牌，」在 bounce（一行 8 單位）要放得下
    return T.units(T.strip_line_end(T.join_words(w.text for w in words)))


def max_chars(seg: dict) -> int | None:
    """segmentation.maxChars（正整數才算；null／缺／壞值 = 不啟用中文字數模式）。專案檔可能被手改，這裡防呆不丟例外。"""
    v = seg.get("maxChars")
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 1:
        return None
    return int(v)


def _fits(words: Sequence[CueWord], seg: dict) -> bool:
    if not words:
        return True
    max_units = int(seg["maxUnitsPerLine"]) * int(seg["maxLines"])
    if seq_units(words) > max_units:
        return False
    mw = seg.get("maxWords")
    mc = max_chars(seg)
    if mc is not None:
        if sum(T.cjk_count(w.text) for w in words) > mc:
            return False
        if mw is not None and sum(1 for w in words if not T.has_cjk(w.text)) > int(mw):
            return False
    elif mw is not None and len(words) > int(mw):
        return False
    return words[-1].end_ms - words[0].start_ms <= float(seg["maxDurationMs"])


def split_penalty(left: Sequence[CueWord], right: Sequence[CueWord]) -> float:
    a, b = left[-1], right[0]
    p = 0.0
    if T.ends_clause(a.text) or T.ends_sentence(a.text) or (b.start_ms - a.end_ms) >= 150:
        p -= 15
    if T.is_en_conjunction(b.text):
        p -= 10
    if T.starts_zh_connective(T.join_words(w.text for w in right[:2])):
        p -= 8
    if T.splits_number_unit(a.text, b.text):
        p += 50
    return p


def best_split(words: Sequence[CueWord], seg: dict, lookback: int = LOOKBACK) -> int:
    """回傳切點 j（左 = words[:j]、右 = words[j:]，1 ≤ j < len）。左邊必須放得下；都放不下就切在最後一個放得下的位置。"""
    n = len(words)
    lo = max(1, n - 1 - lookback)
    best_j, best_cost = None, float("inf")
    for j in range(n - 1, lo - 1, -1):
        left, right = words[:j], words[j:]
        if not _fits(left, seg):
            continue
        cost = split_penalty(left, right) + 0.02 * abs(seq_units(left) - seq_units(right))
        if cost < best_cost:
            best_j, best_cost = j, cost
    if best_j is not None:
        return best_j
    for j in range(n - 1, 0, -1):  # 回看範圍內都放不下（單一超長詞）：最長的合法左段
        if _fits(words[:j], seg):
            return j
    return max(1, n - 1)


def has_cut_between(a: CueWord, b: CueWord, cuts: Sequence[int]) -> bool:
    return any(a.start < c <= b.start for c in cuts)


def hard_break(prev: CueWord, w: CueWord, seg: dict, cuts: Sequence[int]) -> bool:
    if (prev.speaker or None) != (w.speaker or None):
        return True
    if w.start_ms - prev.end_ms >= float(seg["pauseBreakMs"]):
        return True
    if T.ends_sentence(prev.text):
        return True
    return bool(seg.get("snapToShots")) and has_cut_between(prev, w, cuts)


# ---------------------------------------------------------------- 中文：單字 token → 詞（不查字典）


def _han_core(text: str) -> str:
    """去掉尾端的非漢字（標點、引號）之後的本體；本體裡有非漢字（數字、拉丁、假名、開頭引號）→ 空字串（不參與併詞）。"""
    t = text.strip()
    end = len(t)
    while end and not T.is_han_char(t[end - 1]):
        end -= 1
    core = t[:end]
    return core if core and all(T.is_han_char(ch) for ch in core) else ""


def _joinable(prev: CueWord, w: CueWord, seg: dict, cuts: Sequence[int]) -> bool:
    """prev 與 w 可能是同一個詞：兩個都是漢字 token、prev 沒有尾端標點、沒有停頓、沒有硬斷點。"""
    pc, wc = _han_core(prev.text), _han_core(w.text)
    if not pc or not wc or pc != prev.text.strip():
        return False
    if w.start_ms - prev.end_ms >= JOIN_GAP_MS:
        return False
    return not hard_break(prev, w, seg, cuts)


def _merge_tokens(tokens: Sequence[CueWord]) -> CueWord:
    if len(tokens) == 1:
        return tokens[0]
    a, b = tokens[0], tokens[-1]
    sources = {t.source for t in tokens}
    # 詞裡只要有一個字是使用者／LLM 改過的，整個詞就算那個來源（UI 的「已編輯」標記不能因為併詞消失）
    source = "user" if "user" in sources else "llm" if "llm" in sources else a.source
    return CueWord(
        text="".join(t.text.strip() for t in tokens), start=a.start, end=b.end, start_ms=a.start_ms, end_ms=b.end_ms,
        prob=min(t.prob for t in tokens), emphasis=any(t.emphasis for t in tokens), flags=set().union(*(t.flags for t in tokens)),
        speaker=a.speaker, source=source,
    )


def _chunk_sizes(n: int, cap: int) -> list[int]:
    """n 個連續的普通單字怎麼切成詞：1–3 字一個詞；4 → 2+2；5 → 3+2（自動化|剪輯）；更長 → 先取 2。每塊不超過 cap。"""
    sizes: list[int] = []
    while n > 0:
        take = n if n <= 3 else 3 if n == 5 else 2
        take = max(1, min(take, cap))
        sizes.append(take)
        n -= take
    return sizes


def _segment_run(run: Sequence[CueWord], cap: int) -> list[list[CueWord]]:
    """一段相連的漢字 token → 詞（每個詞是要併起來的 token 清單）。

    規則（依序）：Whisper 自己給的多字 token 就是一個詞；虛詞（ZH_SUFFIX）接到前一個詞；
    數詞／指示詞後面的單字（量詞）接到前一個詞；常用單字詞（ZH_STANDALONE）自己一個詞；其餘連續單字用 _chunk_sizes 切。
    任何「接到前一個詞」只在接完仍 ≤ cap（maxChars）時才做。
    """
    atoms: list[list[CueWord]] = []
    pending: list[CueWord] = []

    def chars(atom: Sequence[CueWord]) -> int:
        return sum(len(_han_core(t.text)) for t in atom)

    def flush() -> None:
        i = 0
        for size in _chunk_sizes(len(pending), cap):
            atoms.append(list(pending[i : i + size]))
            i += size
        pending.clear()

    for tok in run:
        core = _han_core(tok.text)
        if len(core) != 1:
            flush()
            atoms.append([tok])
            continue
        if core in ZH_SUFFIX and (pending or atoms):
            flush()
            if chars(atoms[-1]) + 1 <= cap:
                atoms[-1].append(tok)
            else:
                atoms.append([tok])
            continue
        if not pending and atoms and core not in ZH_STANDALONE and _han_core(atoms[-1][-1].text)[-1:] in ZH_NUMERAL_DEMONSTRATIVE and chars(atoms[-1]) + 1 <= cap:
            atoms[-1].append(tok)
            continue
        if core in ZH_STANDALONE:
            flush()
            atoms.append([tok])
            continue
        pending.append(tok)
    flush()
    return atoms


def merge_cjk_words(words: Sequence[CueWord], seg: dict, cuts: Sequence[int] = ()) -> list[CueWord]:
    """相鄰的漢字 token 依 _segment_run 併成詞（segmentation 沒有 maxChars 時原樣返回）。時間取頭尾、機率取最小、旗標取聯集。"""
    cap = max_chars(seg)
    if cap is None or not words:
        return list(words)
    out: list[CueWord] = []
    run: list[CueWord] = []

    def flush() -> None:
        for atom in _segment_run(run, cap):
            out.append(_merge_tokens(atom))
        run.clear()

    for w in words:
        if run and not _joinable(run[-1], w, seg, cuts):
            flush()
        if _han_core(w.text):
            run.append(w)
        else:
            flush()
            out.append(w)
    flush()
    return out


def group_words(words: Sequence[CueWord], seg: dict, cuts: Sequence[int] = ()) -> list[list[CueWord]]:
    cues: list[list[CueWord]] = []
    cur: list[CueWord] = []
    for w in merge_cjk_words(words, seg, cuts):
        if cur and hard_break(cur[-1], w, seg, cuts):
            cues.append(cur)
            cur = []
        cur.append(w)
        # 上限：可能要連切好幾次（例如一個超長的拉丁詞之後又接上）
        while len(cur) > 1 and not _fits(cur, seg):
            j = best_split(cur, seg)
            cues.append(cur[:j])
            cur = cur[j:]
    if cur:
        cues.append(cur)
    return cues
