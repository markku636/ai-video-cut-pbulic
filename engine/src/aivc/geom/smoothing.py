"""追蹤解的後處理平滑（計畫 §6.4 post、§6.6 平滑列）。

- TRACKING 連續段：Savitzky-Golay（window 9、order 2）作用在 8 個單應性參數上。
- STATIC 連續段：整段換成中位數 H → 靜止牌抖動 = 0（`bench jitter` 的定義）。
- 硬釘（使用者關鍵幀、參考影格）**永不移動**：平滑後把釘點殘差線性內插加回整段，
  釘點本身再精確覆寫回原值 → 不變式「SG 絕不跨越使用者硬釘」。
- LOST / NONE 幀不動。
"""
from __future__ import annotations

from collections.abc import Iterable, Sequence

import numpy as np

Array = np.ndarray

STATE_TRACKING = 1
STATE_STATIC = 2


def h_to_params(H: Array) -> Array:
    """3×3（h22=1）→ 8 參數 row-major h00..h21。"""
    H = np.asarray(H, dtype=np.float64)
    H = H / H[2, 2]
    return H.ravel()[:8].copy()


def params_to_h(p: Array) -> Array:
    return np.append(np.asarray(p, dtype=np.float64), 1.0).reshape(3, 3)


def _runs(ks: Sequence[int], states: Sequence[int], has_h: Sequence[bool]) -> list[tuple[int, int, int]]:
    """把幀切成 (start_idx, end_idx_exclusive, state) 的連續段：k 連續、state 相同、H 都存在。"""
    runs: list[tuple[int, int, int]] = []
    n = len(ks)
    i = 0
    while i < n:
        if not has_h[i]:
            i += 1
            continue
        j = i + 1
        while j < n and has_h[j] and states[j] == states[i] and ks[j] == ks[j - 1] + 1:
            j += 1
        runs.append((i, j, int(states[i])))
        i = j
    return runs


def smooth_sequence(
    ks: Sequence[int],
    Hs: Sequence[Array | None],
    states: Sequence[int],
    pins: Iterable[int] = (),
    window: int = 9,
    order: int = 2,
) -> list[Array | None]:
    """回傳新的 H 清單（與輸入同長、同順序）。`ks` 必須遞增。`window` ≤ 0 表示只做 STATIC 中位數，不做 SG。"""
    from scipy.signal import savgol_filter

    ks = [int(k) for k in ks]
    if any(ks[i] >= ks[i + 1] for i in range(len(ks) - 1)):
        raise ValueError("ks 必須嚴格遞增")
    pin_set = {int(p) for p in pins}
    has_h = [H is not None for H in Hs]
    out: list[Array | None] = [None if H is None else np.asarray(H, dtype=np.float64) / np.asarray(H, dtype=np.float64)[2, 2] for H in Hs]

    for a, b, state in _runs(ks, states, has_h):
        n = b - a
        P = np.stack([h_to_params(Hs[i]) for i in range(a, b)])  # (n,8)
        pinned_local = [i - a for i in range(a, b) if ks[i] in pin_set]
        if state == STATE_STATIC:
            med = np.median(P, axis=0)
            new = np.tile(med, (n, 1))
        elif state == STATE_TRACKING and window > 0 and n >= 3:
            # 偶數視窗的 SG 在兩個樣本中間求值（整段往前偏半幀、段頭段尾又不偏）→ 一律換成奇數（減 1）
            w = int(window) - (1 if int(window) % 2 == 0 else 0)
            win = min(w, n if n % 2 == 1 else n - 1)
            if win <= order:
                continue
            new = savgol_filter(P, win, order, axis=0, mode="interp")
        else:
            continue
        if pinned_local:
            # 釘點殘差線性內插（兩端常數外推），讓平滑曲線通過釘點而不產生階躍
            idx = np.array(pinned_local, dtype=np.float64)
            resid = P[pinned_local] - new[pinned_local]  # (m,8)
            xs = np.arange(n, dtype=np.float64)
            corr = np.stack([np.interp(xs, idx, resid[:, c]) for c in range(8)], axis=1)
            new = new + corr
            new[pinned_local] = P[pinned_local]  # 精確覆寫，避免浮點殘差
        for i in range(a, b):
            out[i] = params_to_h(new[i - a])
    return out
