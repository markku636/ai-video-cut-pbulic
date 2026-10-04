"""op `comp.preview_composite` 從 sidecar 呼叫（只有呼叫端給的鍵、沒有 argparse 預設值）。

舞台的替換預覽（src/pipeline/fxPreview.ts compositeArgs）只送 frame／quad／template_new／view／out；
以前 op 直接讀 args["target"] → KeyError，平面 track 一選就在舞台上顯示「引擎錯誤：KeyError: 'target'」。
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

from aivc import imageio  # noqa: E402
from aivc.ops._ctx import CliCtx  # noqa: E402
from aivc.ops.preview import preview_composite  # noqa: E402


class _Ctx(CliCtx):
    def progress(self, stage: str, done: int, total: int, **extra: Any) -> None:
        pass

    def log(self, level: str, message: str) -> None:
        pass


def test_sidecar_args_without_cli_defaults(tmp_path: Path) -> None:
    frame = np.full((96, 128, 3), 40, np.uint8)
    frame[20:80, 40:88] = 225
    imageio.imwrite_unicode(tmp_path / "frame.png", frame)
    card = np.zeros((60, 48, 3), np.uint8)
    card[:, :, 2] = 230  # 紅色（BGR）
    imageio.imwrite_unicode(tmp_path / "new.png", card)
    out = tmp_path / "out.png"
    # 跟 compositeArgs 同形：沒有 target / gain / gamma / zoom / conf …
    args = {"frame": str(tmp_path / "frame.png"), "quad": "40,20,88,20,88,80,40,80", "template_new": str(tmp_path / "new.png"), "view": "replaced", "out": str(out)}
    r = preview_composite(args, _Ctx())
    assert Path(r["out"]) == out
    img = imageio.imread_unicode(out, cv2.IMREAD_COLOR)
    assert img.shape[:2] == (96, 128)
    # 四角裡面換成紅色、外面維持原幀
    cy, cx = 50, 64
    assert img[cy, cx, 2] > 150 and img[cy, cx, 0] < 120
    assert abs(int(img[5, 5, 1]) - 40) <= 2
