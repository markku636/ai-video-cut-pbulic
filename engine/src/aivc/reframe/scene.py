"""鏡頭切換偵測（純函式：只吃 numpy 陣列，不讀檔）。

## 為什麼重構圖需要它

追焦器遇到「目標中心一幀跳很遠」時會用切的而不是甩鏡（`path.detect_cuts`）。
但那個判準只看**主體跑到哪裡**：換鏡頭時主體如果剛好落在相近的位置就完全偵不到，
結果是鏡頭平滑地「滑過」一個硬切 —— 那是最刺眼的那一種錯。

有專案時可以直接把鏡頭偵測的結果餵進來（App 的輸出對話框就是這樣做的）。
**沒有專案時**（「轉成直幅」吃的是任何一支影片檔）就靠這裡：規劃時本來就要把範圍內的
每一幀解出來，順手算一個小簽章幾乎不花成本，而且因為是逐幀算的，切點是**幀準**的。

## 判準

把幀縮成 32×18 的灰階、**除以自己的平均**，再比相鄰兩幀的平均絕對差（門檻見 `DEFAULT_THRESHOLD`，是量出來的）。
除以平均是為了消掉整體亮度變化：淡入淡出、自動曝光、閃光燈都不是換鏡頭，
但它們會讓原始灰階值整片位移，不正規化的話全都會被報成切換。

連續好幾幀都超過門檻時只留第一幀（`MIN_GAP`）：一次切換本來就會讓後面一兩幀也不像
前面那幀（動態模糊、壓縮），全留會變成一串假切點。
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Iterable

if TYPE_CHECKING:
    import numpy as np

#: 簽章的尺寸。再小就分不出構圖、再大只是變慢 —— 這是在問「像不像同一個畫面」，不是在比對細節。
SIG_W = 32
SIG_H = 18
#: 平均絕對差超過這個值算切換。
#:
#: **實測**（範例影片 samples/ 的 clip1，1797 幀、三個已知鏡頭邊界 60 / 926 / 1358）：
#:
#:     真鏡頭邊界    0.613  0.614  0.646   ← 全片最大的三個
#:     非邊界最大    0.257（第 37 幀）
#:     非邊界 p99    0.101
#:     非邊界中位    0.0011
#:
#: 0.26 到 0.61 之間都能完美分開，取偏高的 0.35：**誤報比漏報糟**。
#: 漏一個切點只是維持原本的平滑平移（看不太出來），誤報一個會讓畫面莫名硬跳一下。
DEFAULT_THRESHOLD = 0.35
#: 上面那次實測的兩個邊界值。門檻改動時測試會拿它們檢查還在不在安全區間裡。
MEASURED_CUT_MIN = 0.61
MEASURED_NON_CUT_MAX = 0.26
#: 兩個切點至少要隔這麼多幀。一次切換之後的一兩幀本來就不像前面（動態模糊、壓縮），
#: 不設這個會把一次切換報成一串。
MIN_GAP = 6


def frame_signature(rgb: "np.ndarray") -> "np.ndarray":
    """一幀 → 32×18 的灰階簽章（float32，除以自己的平均）。灰階圖也吃。"""
    import cv2
    import numpy as np

    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY) if rgb.ndim == 3 else rgb
    small = cv2.resize(gray, (SIG_W, SIG_H), interpolation=cv2.INTER_AREA).astype(np.float32)
    mean = float(small.mean())
    return small / mean if mean > 1e-6 else small


def signature_distance(a: "np.ndarray", b: "np.ndarray") -> float:
    """兩個簽章的平均絕對差。實測範例素材：同一鏡頭內中位 0.001、最大 0.26；真正的切換 0.61 以上。"""
    import numpy as np

    return float(np.abs(a - b).mean())


def scene_cuts(
    sigs: Iterable[tuple[int, "np.ndarray"]], threshold: float = DEFAULT_THRESHOLD, min_gap: int = MIN_GAP
) -> list[int]:
    """`(幀號, 簽章)` 序列 → 切換發生在哪些幀（那一幀是**新鏡頭的第一幀**）。

    序列要依幀號遞增；中間跳號沒關係（只是那兩幀之間的比較會跨得比較遠）。
    第一幀永遠不算切點：沒有可以比的前一幀，而且「開場」不是切換。
    """
    out: list[int] = []
    prev: "np.ndarray | None" = None
    for k, sig in sigs:
        if prev is not None and signature_distance(sig, prev) > threshold and (not out or k - out[-1] >= min_gap):
            out.append(k)
        prev = sig
    return out
