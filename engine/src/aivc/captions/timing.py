"""幀層級時間整理（研究規格 §5.3 D）。全部是整數 proxy 幀；毫秒設定用 fps 換成幀數。

順序有意義：
1. lag-out：字講完後多留一下（讀得完），但不能吃到下一則 − gapFrames。
2. 最短時長：只往後延（往前會蓋到前一則、而且字幕比聲音早出現很怪），到下一則 − gap 為止；還不夠就標 tooFast。
3. chain：兩則之間的小縫（< chainGapMs）接起來，畫面不會閃一下空白。
4. 吸附鏡頭（snapToShots）：起點在切點後 0.5 s 內 → 拉到切點；終點在切點前 0.5 s 內或剛好跨過 → 設為切點 − gap。
5. 超過 maxDurationMs 的則在最佳詞邊界再切。
6. 最後保證：不重疊、每則 ≥ 1 幀、在 [0, n_frames] 內、字都在則內。
7. 閱讀速度 > cpsWarn → tooFast。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Sequence

from . import text as T
from .segment import CueWord, best_split
from .timebase import frame_to_s, ms_to_frames

SNAP_S = 0.5


@dataclass
class Cue:
    start: int
    end: int
    words: list[CueWord]
    flags: set[str] = field(default_factory=set)

    @property
    def text(self) -> str:
        return T.join_words(w.text for w in self.words)


def _fr(ms: float, fps: tuple[int, int]) -> int:
    return ms_to_frames(float(ms), fps[0], fps[1])


def _clamp_words(c: Cue) -> None:
    """字夾進則內；被擠到的字至少 1 幀（則的長度 ≥ 字數時一定做得到，否則最後幾個字共用最後一幀的邊界）。"""
    n = len(c.words)
    nxt = c.end
    for i in range(n - 1, -1, -1):
        w = c.words[i]
        w.end = min(w.end, nxt)
        w.start = max(c.start, min(w.start, w.end - 1))
        if w.end <= w.start:
            w.end = w.start + 1
        nxt = w.start
    prev = c.start
    for w in c.words:
        w.start = max(w.start, prev)
        w.end = max(w.end, w.start + 1)
        prev = w.end
    if c.words and c.words[-1].end > c.end:
        c.end = c.words[-1].end


def _fit_capacity(c: Cue) -> None:
    """則的幀數 < 字數（影片尾端、或被前後夾到）：多出來的字併進最後一個放得下的字，文字不丟。"""
    cap = max(1, c.end - c.start)
    if len(c.words) <= cap:
        return
    keep, extra = c.words[: cap - 1], c.words[cap - 1 :]
    merged = extra[0]
    merged.text = T.join_words(w.text for w in extra)
    merged.end = extra[-1].end
    merged.emphasis = any(w.emphasis for w in extra)
    merged.prob = min(w.prob for w in extra)
    for w in extra[1:]:
        merged.flags |= w.flags
    c.words = keep + [merged]


def retime(groups: Sequence[Sequence[CueWord]], seg: dict, fps: tuple[int, int], n_frames: int, cuts: Sequence[int] = ()) -> list[Cue]:
    gap = int(seg.get("gapFrames") or 0)
    lag = _fr(seg.get("lagOutMs") or 0, fps)
    min_f = max(1, _fr(seg.get("minDurationMs") or 0, fps))
    chain = _fr(seg.get("chainGapMs") or 0, fps)
    max_f = max(1, _fr(seg.get("maxDurationMs") or 7000, fps))
    snap = max(1, int(round(SNAP_S * fps[0] / fps[1])))
    cuts = sorted(int(c) for c in cuts if 0 < int(c) < n_frames)

    cues = [Cue(g[0].start, max(g[-1].end, g[0].start + 1), list(g), set().union(*(w.flags for w in g))) for g in groups if g]
    cues.sort(key=lambda c: c.start)

    # 5（先做）：超長則切開，後面的 lag／最短才看得到正確的鄰居
    split: list[Cue] = []
    for c in cues:
        stack = [c]
        while stack:
            cur = stack.pop(0)
            if cur.end - cur.start > max_f and len(cur.words) > 1:
                j = best_split(cur.words, {**seg, "maxDurationMs": float(seg.get("maxDurationMs") or 7000), "maxWords": None, "maxUnitsPerLine": 10**6})
                a, b = cur.words[:j], cur.words[j:]
                stack[0:0] = [Cue(a[0].start, a[-1].end, a, set(cur.flags)), Cue(b[0].start, b[-1].end, b, set(cur.flags))]
            else:
                split.append(cur)
    cues = split

    def next_start(i: int) -> int:
        return cues[i + 1].start if i + 1 < len(cues) else n_frames + gap

    for i, c in enumerate(cues):
        # 1. lag-out
        limit = next_start(i) - gap
        if c.end > limit:
            c.end = max(c.start + 1, limit)  # 已經壓到下一則（字很密）：先讓位，步驟 6 再把字夾進來
        else:
            c.end = max(c.end, min(c.end + lag, limit))
        # 2. 最短時長（只往後延）
        if c.end - c.start < min_f:
            c.end = max(c.end, min(c.start + min_f, limit))
            # 只有設了閱讀速度警告的預設才標（逐字彈跳這類預設本來就短，標了只會讓「待檢查」徽章失去意義）
            if c.end - c.start < min_f and seg.get("cpsWarn") is not None:
                c.flags.add("tooFast")
        # 3. chain
        ns = next_start(i)
        if i + 1 < len(cues) and 0 < ns - c.end < chain:
            c.end = max(c.end, ns - gap)

    # 4. 吸附鏡頭
    if seg.get("snapToShots") and cuts:
        for i, c in enumerate(cues):
            prev_end = cues[i - 1].end if i > 0 else 0
            for cut in cuts:
                if cut <= c.start < cut + snap and prev_end + gap <= cut:
                    c.start = cut
                    break
            limit = next_start(i) - gap
            last_word_end = c.words[-1].end
            for cut in cuts:
                if c.start < cut - gap and cut - snap < c.end <= cut + snap and last_word_end <= cut - gap and cut - gap <= limit:
                    c.end = cut - gap
                    break

    # 6. 保證不重疊、≥1 幀、在範圍內、字都在則內
    out: list[Cue] = []
    for c in cues:
        if out and c.start < out[-1].end:
            p = out[-1]
            # 前一則讓位；但它的每個字至少要留 1 幀
            p.end = max(c.start, p.start + len(p.words))
            _clamp_words(p)
            c.start = max(c.start, p.end)
        c.start = max(0, min(c.start, n_frames - 1))
        c.end = max(c.start + 1, min(c.end, n_frames))
        _fit_capacity(c)
        _clamp_words(c)
        out.append(c)

    # 7. 閱讀速度
    for c in out:
        cps_warn = seg.get("cpsWarn")
        if cps_warn:
            secs = frame_to_s(c.end - c.start, fps[0], fps[1])
            if secs > 0 and T.cps_chars(c.text) / secs > float(cps_warn):
                c.flags.add("tooFast")
    return out
