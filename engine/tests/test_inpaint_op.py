"""`aivc inpaint` 的參數與遮罩合併（ops/inpaint.py）。

實際的補繪品質在 `test_inpaint_plate.py`（純函式）與真影片上驗；這裡只守邊界：
範圍解析、多物件合併、缺幀的處理、尺寸不合要擋下來。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from aivc.ops import REGISTRY, OpError, load_all
from aivc.ops.inpaint import DEFAULT_DILATE, DEFAULT_FEATHER, dilate_mask, open_masks, parse_frames, union_mask


class _FakeMaskFile:
    """只實作 `get(k)`：union_mask 用得到的就這一個方法。"""

    def __init__(self, frames: dict[int, np.ndarray]) -> None:
        self._f = frames

    def get(self, k: int) -> np.ndarray | None:
        return self._f.get(k)


class TestParseFrames:
    def test_沒給就是整支(self) -> None:
        assert parse_frames(None, 209) == (0, 209)
        assert parse_frames("", 209) == (0, 209)

    def test_夾進影片長度(self) -> None:
        assert parse_frames("-10:9999", 209) == (0, 209)

    def test_一般情況(self) -> None:
        assert parse_frames("40:80", 209) == (40, 80)

    def test_格式不對(self) -> None:
        for bad in ["40", "40:80:90", "a:b"]:
            with pytest.raises(OpError):
                parse_frames(bad, 209)

    def test_空範圍(self) -> None:
        with pytest.raises(OpError):
            parse_frames("80:40", 209)


class TestUnionMask:
    def test_多個物件取聯集(self) -> None:
        a = np.zeros((10, 10), bool)
        a[0:3, 0:3] = True
        b = np.zeros((10, 10), bool)
        b[7:10, 7:10] = True
        m = union_mask([_FakeMaskFile({5: a}), _FakeMaskFile({5: b})], 5, 10, 10)
        assert m[1, 1] and m[8, 8] and not m[5, 5]

    def test_缺這一幀的檔案當作沒有這個物件(self) -> None:
        # seg 的傳播可能在某些幀失去目標；那不該讓整支停下來
        a = np.ones((4, 4), bool)
        m = union_mask([_FakeMaskFile({5: a}), _FakeMaskFile({})], 5, 4, 4)
        assert m.all()

    def test_全部都缺就是空遮罩(self) -> None:
        m = union_mask([_FakeMaskFile({}), _FakeMaskFile({})], 5, 4, 4)
        assert not m.any() and m.shape == (4, 4)

    def test_沒有遮罩檔(self) -> None:
        assert not union_mask([], 0, 4, 4).any()


class TestDilateMask:
    def test_零或負數是直通(self) -> None:
        m = np.zeros((10, 10), bool)
        m[5, 5] = True
        assert dilate_mask(m, 0) is m
        assert dilate_mask(m, -3) is m

    def test_膨脹會長大且保持_bool(self) -> None:
        m = np.zeros((20, 20), bool)
        m[10, 10] = True
        d = dilate_mask(m, 3)
        assert d.dtype == bool
        assert d[10, 10] and d[10, 13] and not d[10, 15]
        assert d.sum() > m.sum()


class TestOpenMasks:
    def test_檔案不存在(self, tmp_path: Path) -> None:
        with pytest.raises(OpError, match="找不到"):
            open_masks([str(tmp_path / "沒有.aivm")], 100, 100)

    def test_不是遮罩檔(self, tmp_path: Path) -> None:
        f = tmp_path / "bad.aivm"
        f.write_bytes(b"not a mask file at all, really not")
        with pytest.raises(OpError):
            open_masks([str(f)], 100, 100)


class TestDefaultsViaApi:
    """CLI 走 argparse 會補預設值，但 App 是直接送字典的 —— 兩條路的預設必須一樣。

    第一版把預設寫在 `add_argument(default=3)`、body 裡用 `args.get("dilate") or 0`，
    結果 App 沒送這個鍵時變成「不膨脹也不羽化」＝硬邊，跟 CLI 的行為不一樣。
    """

    def test_argparse_的預設與模組常數一致(self) -> None:
        import argparse

        load_all()
        p = argparse.ArgumentParser()
        REGISTRY["inpaint.remove"].add_arguments(p)  # type: ignore[union-attr]
        ns = p.parse_args(["v.mp4", "--masks", "m.aivm"])
        # 兩邊都刻意是 None：真正的預設只有模組常數那一份，body 用 `is None` 取
        assert ns.dilate is None and ns.feather is None and ns.cq is None

    def test_零是合法值不是沒給(self) -> None:
        import argparse

        load_all()
        p = argparse.ArgumentParser()
        REGISTRY["inpaint.remove"].add_arguments(p)  # type: ignore[union-attr]
        ns = p.parse_args(["v.mp4", "--masks", "m.aivm", "--dilate", "0", "--feather", "0", "--cq", "0"])
        assert (ns.dilate, ns.feather, ns.cq) == (0, 0, 0)

    def test_常數本身是合理的(self) -> None:
        assert DEFAULT_DILATE > 0 and DEFAULT_FEATHER > 0
