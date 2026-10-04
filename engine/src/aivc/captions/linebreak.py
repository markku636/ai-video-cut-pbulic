"""則內換行（研究規格 §5.3 G）。輸入是 token 與「量寬函式」，所以測試不需要字型（假寬度），燒錄用 Pillow 真寬度，
匯出 SRT 用顯示單位（CJK=2）當寬度 —— 同一套規則三處共用。

- 禁則：不能在 `，。、；：？！」』）》〉】…—%` 開頭的 token 前面換行；不能在 `「『（《〈【` 結尾的 token 後面換行。
- 成本：非最後一行 `100·((maxW−w)/maxW)²`（填滿一點）；上行比下行長 → `+20·超出的百分點`（下重上輕的金字塔，Netflix 規範）；孤兒行（只有一個 ≤3 字母的英文詞 +40、只有一個中文字 +60）；句末標點後換行 −30、逗號／停頓後 −15。
- 一行放得下就一行（成本 0）。放不下：字級 0.9、0.8 重試；再不行把長 CJK 詞拆成單字硬換行；還是不行 → 貪婪換行並標 overflow。
- 行寬不算行尾的 。，、（顯示時會拿掉，text.strip_line_end）：每個 token 預先算「落在行尾時省下的寬度」，放不放得下、
  金字塔比較都用拿掉之後的寬度 —— 否則「……效果。」會因為一個畫面上不存在的句號被擠到兩行。
  句末／逗號後換行的加分仍看原本的 token（標點還在資料裡，只是不顯示）。TS CaptionLayer.breakLines 要鏡射。
為什麼用窮舉而不是 DP：上下行比較（金字塔）讓狀態依賴上一行寬度；maxLines ≤ 3、token 通常 < 40，組合數 < 1 萬。
"""
from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations
from typing import Callable, Sequence

from . import text as T

MAX_EXHAUSTIVE_TOKENS = 60


@dataclass
class LineBreakResult:
    lines: list[list[int]]  # 每行的 token 索引
    widths: list[float]
    scale: float = 1.0
    overflow: bool = False
    hard_wrapped: bool = False  # True = tokens 被拆成單字（呼叫端要用 result_tokens）
    tokens: list[str] | None = None


def _line_width(idx: Sequence[int], widths: Sequence[float], space: Callable[[int], float], scale: float, tails: Sequence[float] | None = None) -> float:
    if not idx:
        return 0.0
    w = sum(widths[i] for i in idx) * scale
    w += sum(space(i) for i in idx[1:]) * scale
    if tails is not None:
        w -= tails[idx[-1]] * scale  # 行尾的 。，、 不顯示
    return w


def _can_break_before(tokens: Sequence[str], j: int) -> bool:
    a, b = tokens[j - 1], tokens[j]
    return not (b and b[0] in T.NO_BREAK_BEFORE) and not (a and a[-1] in T.NO_BREAK_AFTER)


def _cost(lines: list[list[int]], lw: list[float], tokens: Sequence[str], max_w: float, pause_after: Sequence[bool] | None) -> float:
    cost = 0.0
    n = len(lines)
    for li, idx in enumerate(lines):
        w = lw[li]
        if li < n - 1:
            cost += 100.0 * ((max_w - w) / max_w) ** 2
            last = tokens[idx[-1]]
            if T.ends_sentence(last):
                cost -= 30
            elif T.ends_clause(last) or (pause_after is not None and pause_after[idx[-1]]):
                cost -= 15
            nxt = lw[li + 1]
            if w > nxt:
                # 每超出 maxW 的 1 個百分點 +20（TS CaptionLayer.breakLines 鏡射同一個權重）：只要有下重上輕的切法就不選上重下輕，
                # 標點加分在下重上輕的候選之間才起作用。若改用「20 × 分數」，平方項會讓最佳上行停在 0.8·maxW，金字塔就不成立。
                cost += 20.0 * ((w - nxt) / max_w * 100.0)
        if len(idx) == 1:
            t = tokens[idx[0]].strip()
            if T.has_cjk(t) and T.cjk_count(t) == 1:
                cost += 60
            elif not T.has_cjk(t) and T.latin_letters(t) <= 3 and any(ch.isalpha() for ch in t):
                cost += 40
    return cost


def _best(tokens: Sequence[str], widths: Sequence[float], space: Callable[[int], float], max_w: float, max_lines: int, scale: float, pause_after: Sequence[bool] | None, tails: Sequence[float] | None = None) -> tuple[list[list[int]], list[float]] | None:
    n = len(tokens)
    if n == 0:
        return [], []
    breakable = [j for j in range(1, n) if _can_break_before(tokens, j)]
    best: tuple[float, list[list[int]], list[float]] | None = None
    for nl in range(1, max_lines + 1):
        if nl - 1 > len(breakable):
            break
        for cut in combinations(breakable, nl - 1):
            bounds = [0, *cut, n]
            lines = [list(range(bounds[i], bounds[i + 1])) for i in range(nl)]
            lw = [_line_width(idx, widths, space, scale, tails) for idx in lines]
            if any(w > max_w + 1e-6 for w in lw):
                continue
            c = _cost(lines, lw, tokens, max_w, pause_after)
            if best is None or c < best[0] - 1e-9:
                best = (c, lines, lw)
        if best is not None and nl == 1:
            return best[1], best[2]  # 一行放得下：永遠選一行
    return (best[1], best[2]) if best is not None else None


def _greedy(tokens: Sequence[str], widths: Sequence[float], space: Callable[[int], float], max_w: float, scale: float, tails: Sequence[float] | None = None) -> tuple[list[list[int]], list[float]]:
    lines: list[list[int]] = [[]]
    for i in range(len(tokens)):
        cand = lines[-1] + [i]
        if lines[-1] and _line_width(cand, widths, space, scale, tails) > max_w:
            lines.append([i])
        else:
            lines[-1] = cand
    return lines, [_line_width(idx, widths, space, scale, tails) for idx in lines]


def break_lines(
    tokens: Sequence[str],
    measure: Callable[[str], float],
    max_w: float,
    max_lines: int,
    space_between: Callable[[str, str], float] | None = None,
    pause_after: Sequence[bool] | None = None,
    scales: Sequence[float] = (1.0, 0.9, 0.8),
) -> LineBreakResult:
    toks = list(tokens)
    if space_between is None:
        space_between = lambda a, b: measure(" ") if T.needs_space(a, b) else 0.0  # noqa: E731
    max_lines = max(1, int(max_lines))

    def tails_of(tk: list[str], widths: list[float]) -> list[float]:
        # 這個 token 落在行尾時，拿掉 。，、 省下的寬度（沒有這些標點 = 0，不必再量一次）
        return [max(0.0, widths[i] - measure(T.trim_line_end_punct(t))) if T.trim_line_end_punct(t) != t else 0.0 for i, t in enumerate(tk)]

    def attempt(tk: list[str], pa: Sequence[bool] | None) -> tuple[list[list[int]], list[float], float] | None:
        widths = [measure(t) for t in tk]
        sp = [0.0] + [space_between(tk[i - 1], tk[i]) for i in range(1, len(tk))]
        space = lambda i: sp[i]  # noqa: E731
        if len(tk) > MAX_EXHAUSTIVE_TOKENS:
            return None
        tails = tails_of(tk, widths)
        for s in scales:
            r = _best(tk, widths, space, max_w, max_lines, s, pa, tails)
            if r is not None:
                return r[0], r[1], s
        return None

    r = attempt(toks, pause_after)
    if r is not None:
        return LineBreakResult(r[0], r[1], r[2])
    pieces = T.token_pieces(toks)
    if len(pieces) != len(toks):
        r = attempt(pieces, None)
        if r is not None:
            return LineBreakResult(r[0], r[1], r[2], hard_wrapped=True, tokens=pieces)
    widths = [measure(t) for t in pieces]
    sp = [0.0] + [space_between(pieces[i - 1], pieces[i]) for i in range(1, len(pieces))]
    s = scales[-1] if scales else 1.0
    lines, lw = _greedy(pieces, widths, lambda i: sp[i], max_w, s, tails_of(pieces, widths))
    overflow = len(lines) > max_lines or any(w > max_w + 1e-6 for w in lw)
    return LineBreakResult(lines, lw, s, overflow=overflow, hard_wrapped=len(pieces) != len(toks), tokens=pieces if len(pieces) != len(toks) else None)
