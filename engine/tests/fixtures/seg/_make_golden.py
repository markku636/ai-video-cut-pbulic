"""產生 golden fixture：cards_64x48.aivm + k0003.png / k0007.png（+ k=5 缺席條目）。

用法：  python tests/fixtures/seg/_make_golden.py
只有在**刻意**改格式時才重跑；test_seg_maskfile 會把重寫出來的 bytes 與這個檔逐位元比對。
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / "src"))

from aivc.seg.maskfile import MaskFile  # noqa: E402
from aivc.seg.preview import save_mask_png  # noqa: E402

W, H = 64, 48


def card_mask(cx: float, cy: float, w: float, h: float, angle_deg: float) -> np.ndarray:
    """旋轉矩形（牌）遮罩，純 numpy，確定性。"""
    yy, xx = np.mgrid[0:H, 0:W]
    a = np.deg2rad(angle_deg)
    dx, dy = xx + 0.5 - cx, yy + 0.5 - cy
    u = dx * np.cos(a) + dy * np.sin(a)
    v = -dx * np.sin(a) + dy * np.cos(a)
    return (np.abs(u) <= w / 2) & (np.abs(v) <= h / 2)


def main() -> None:
    frames = {
        3: card_mask(20, 24, 14, 20, 0),
        5: None,  # 已算過、物件不在
        7: card_mask(44, 26, 14, 20, 90) | card_mask(12, 10, 6, 6, 30),
    }
    for k, m in frames.items():
        if m is not None:
            save_mask_png(HERE / f"k{k:04d}.png", m)
    st = MaskFile.write(HERE / "cards_64x48.aivm", W, H, frames.items())
    print(st)


if __name__ == "__main__":
    main()
