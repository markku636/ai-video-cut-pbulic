"""動畫曲線與詞狀態（研究規格 §5.3 E/F）。純函式、無 numpy。

**TS `anim.ts` 與這裡要逐值相同**（舞台預覽 = 燒錄成品）：`golden_cases()` 產生共用 golden 的內容，
測試同時比對寫死的規格數字（easeOutBack(0.5)=1.0876975、峰值 1.1000@0.5801、彈簧 2% 收斂 0.356 s）。

時間錨點：所有動畫都在幀中心求值 τ = (k + 0.5 − k_event)·den/num 秒。k_event 是事件開始的幀
（則動畫＝則起點；詞動畫＝詞變成 active 的幀）。用幀中心而不是幀起點：第一幀 τ>0，淡入不會整幀全透明。
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Sequence

C1 = 1.70158
C3 = C1 + 1.0
SPRING_ZETA = 0.35
SPRING_HZ = 5.0
SPRING_AMP_EM = 0.25
SLIDE_EM = 0.3
POP_FROM = 0.7
SPRING_SCALE_FROM = 0.6
SCALE_BUCKET = 64  # 精靈快取：縮放四捨五入到 1/64


def clamp01(t: float) -> float:
    return 0.0 if t <= 0 else 1.0 if t >= 1 else t


def ease_out_cubic(t: float) -> float:
    t = clamp01(t)
    return 1.0 - (1.0 - t) ** 3


def ease_out_back(t: float) -> float:
    t = clamp01(t)
    u = t - 1.0
    return 1.0 + C3 * u**3 + C1 * u**2


def tau_s(k: int, k_event: int, fps_num: int, fps_den: int) -> float:
    return (k + 0.5 - k_event) * fps_den / fps_num


def spring_dy(tau: float, amp: float, zeta: float = SPRING_ZETA, hz: float = SPRING_HZ) -> float:
    """阻尼彈簧：dy = −A·exp(−ζω0τ)·cos(ωd·τ)；ω0 = 2π·5、ωd = ω0·√(1−ζ²) = 29.43（2% 收斂 ≈ 0.356 s）。"""
    if tau < 0:
        return -amp
    w0 = 2.0 * math.pi * hz
    wd = w0 * math.sqrt(1.0 - zeta * zeta)
    return -amp * math.exp(-zeta * w0 * tau) * math.cos(wd * tau)


def scale_bucket(s: float) -> float:
    return round(s * SCALE_BUCKET) / SCALE_BUCKET


# ---------------------------------------------------------------- 則層級


@dataclass(frozen=True)
class CueAnim:
    opacity: float = 1.0
    scale: float = 1.0
    dy_em: float = 0.0  # 以字級（em）為單位的垂直位移；呼叫端乘 font px


def cue_anim(anim: dict[str, Any], k: int, start: int, end: int, fps: tuple[int, int]) -> CueAnim:
    num, den = fps
    tau = tau_s(k, start, num, den)
    kind = anim.get("cueIn") or "none"
    ms_in = float(anim.get("cueInMs") or 0.0)
    t_in = 1.0 if ms_in <= 0 else tau * 1000.0 / ms_in
    opacity, scale, dy = 1.0, 1.0, 0.0
    if kind == "fade":
        opacity = clamp01(t_in)
    elif kind == "pop":
        scale = POP_FROM + (1.0 - POP_FROM) * ease_out_back(t_in)
        opacity = ease_out_cubic(t_in)
    elif kind == "slideUp":
        dy = SLIDE_EM * (1.0 - ease_out_cubic(t_in))
    elif kind == "spring":
        dy = spring_dy(tau, SPRING_AMP_EM)
        scale = SPRING_SCALE_FROM + (1.0 - SPRING_SCALE_FROM) * ease_out_back(t_in)
    if (anim.get("cueOut") or "none") == "fade":
        ms_out = float(anim.get("cueOutMs") or 0.0)
        if ms_out > 0:
            remain = (end - (k + 0.5)) * den / num
            opacity *= clamp01(remain * 1000.0 / ms_out)
    return CueAnim(opacity, scale, dy)


# ---------------------------------------------------------------- 詞層級


FUTURE, ACTIVE, PAST = "future", "active", "past"


@dataclass(frozen=True)
class WordState:
    state: str
    progress: float  # 卡拉OK 擦色／打字機進度 p ∈ [0,1]
    activated: int  # 這個詞變 active 的幀（= s_i）
    deactivated: int  # 不再 active 的幀（= 下一個詞的起點；最後一個詞 = 則終點）


def word_states(starts: Sequence[int], ends: Sequence[int], cue_end: int, k: int) -> list[WordState]:
    """A_i = [s_i, s_{i+1})，最後一個詞 active 到則結束。p = clamp((k + 0.5 − s_i) / max(1, e_i − s_i))。"""
    n = len(starts)
    out: list[WordState] = []
    for i in range(n):
        s = int(starts[i])
        a_end = int(starts[i + 1]) if i + 1 < n else int(cue_end)
        a_end = max(a_end, s + 1)
        if k < s:
            st = FUTURE
        elif k < a_end:
            st = ACTIVE
        else:
            st = PAST
        p = clamp01((k + 0.5 - s) / max(1, int(ends[i]) - s))
        out.append(WordState(st, p, s, a_end))
    return out


def word_pop_scale(ws: WordState, k: int, fps: tuple[int, int], active_scale: float, word_ms: float) -> float:
    if ws.state == FUTURE or active_scale == 1.0:
        return 1.0
    num, den = fps
    if word_ms <= 0:
        return active_scale if ws.state == ACTIVE else 1.0
    if ws.state == ACTIVE:
        t = tau_s(k, ws.activated, num, den) * 1000.0 / word_ms
        return 1.0 + (active_scale - 1.0) * ease_out_back(min(1.0, t))
    t = tau_s(k, ws.deactivated, num, den) * 1000.0 / word_ms
    return 1.0 + (active_scale - 1.0) * (1.0 - ease_out_cubic(min(1.0, t)))


def typewriter_chars(ws: WordState, n_chars: int) -> int:
    if ws.state == PAST:
        return n_chars
    if ws.state == FUTURE:
        return 0
    return min(n_chars, int(math.ceil(ws.progress * n_chars)))


def box_move_t(ws: WordState, k: int, fps: tuple[int, int], word_ms: float) -> float:
    """方框從上一個詞滑到這個詞的進度（easeOutCubic）；wordMs=0 → 直接跳。"""
    if word_ms <= 0:
        return 1.0
    return ease_out_cubic(tau_s(k, ws.activated, fps[0], fps[1]) * 1000.0 / word_ms)


# ---------------------------------------------------------------- 共用 golden


def golden_cases() -> dict[str, Any]:
    """TS 與 Python 共用的 golden 內容（fixtures/captions/anim.golden.json 由這裡產生；值取 7 位小數）。"""

    def r(x: float) -> float:
        return round(x, 7)

    ts = [0.0, 0.1, 0.25, 0.5, 0.5801, 0.75, 0.9, 1.0]
    fps = (30, 1)
    starts, ends, cue_end = [10, 16, 25], [14, 22, 30], 34
    states = {str(k): [(w.state, r(w.progress)) for w in word_states(starts, ends, cue_end, k)] for k in (9, 10, 13, 15, 16, 24, 25, 33, 34)}
    pop = {}
    for k in (16, 17, 18, 19, 20, 25, 26, 27, 28):
        ws = word_states(starts, ends, cue_end, k)[1]
        pop[str(k)] = r(word_pop_scale(ws, k, fps, 1.15, 120.0))
    tw = {}
    for k in (15, 16, 17, 18, 19, 21, 22, 25):
        ws = word_states(starts, ends, cue_end, k)[1]
        tw[str(k)] = typewriter_chars(ws, 5)
    cue = {}
    for kind, ms in (("fade", 80), ("pop", 150), ("slideUp", 120), ("spring", 180)):
        anim = {"cueIn": kind, "cueInMs": ms, "cueOut": "fade", "cueOutMs": 80}
        cue[kind] = {str(k): [r(v) for v in (lambda a: (a.opacity, a.scale, a.dy_em))(cue_anim(anim, k, 10, 40, fps))] for k in (10, 11, 12, 13, 15, 20, 38, 39)}
    return {
        "version": 1,
        "fps": {"num": fps[0], "den": fps[1]},
        "easeOutCubic": {str(t): r(ease_out_cubic(t)) for t in ts},
        "easeOutBack": {str(t): r(ease_out_back(t)) for t in ts},
        "spring": {str(t): r(spring_dy(t, 1.0)) for t in (0.0, 0.05, 0.1, 0.2, 0.356, 0.5)},
        "words": {"starts": starts, "ends": ends, "cueEnd": cue_end, "states": states},
        "wordPop": {"activeScale": 1.15, "wordMs": 120, "word": 1, "scale": pop},
        "typewriter": {"word": 1, "chars": 5, "count": tw},
        "cue": cue,
    }
