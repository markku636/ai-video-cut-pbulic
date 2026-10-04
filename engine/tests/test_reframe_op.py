"""`aivc reframe` 與 `render --reframe` 的參數與對齊（ops/reframe.py、ops/render.load_reframe）。

對齊那一段測得最細：路徑對不上渲染範圍時整條鏡頭會偏移，症狀是「鏡頭慢半拍」——
看得出怪、但很難指出原因，而且要整支重新編碼才發現。所以寧可報錯也不要猜。
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from aivc.ops import OpError
from aivc.ops.reframe import DEFAULT_EVERY_SECONDS, default_every, options_from_args, parse_cuts, parse_size, sample_frames
from aivc.ops.render import load_reframe
from aivc.reframe.doc import to_doc
from aivc.reframe.path import ReframeOptions, static_path

HD = (1920, 1080)


class TestParseCuts:
    def test_逗號分號都收(self) -> None:
        assert parse_cuts("10, 20 ; 30", 100) == [10, 20, 30]

    def test_去重且排序(self) -> None:
        assert parse_cuts("30,10,10", 100) == [10, 30]

    def test_超出範圍的安靜丟掉(self) -> None:
        # 鏡頭表可能比規劃範圍長，那不是使用者的錯
        assert parse_cuts("0, 50, 500", 100) == [50]

    def test_空的(self) -> None:
        assert parse_cuts(None, 100) == [] and parse_cuts("", 100) == []

    def test_不是數字就報錯(self) -> None:
        with pytest.raises(OpError):
            parse_cuts("10,abc", 100)


class TestSampleFrames:
    def test_等距且含頭尾(self) -> None:
        # 尾巴漏掉的話最後一段整段沿用，而那通常正是主體離場的地方
        assert sample_frames(0, 20, 6) == [0, 6, 12, 18, 19]

    def test_剛好整除時不重複最後一幀(self) -> None:
        assert sample_frames(0, 19, 6) == [0, 6, 12, 18]

    def test_每幀都取(self) -> None:
        assert sample_frames(0, 4, 1) == [0, 1, 2, 3]

    def test_起點不是零(self) -> None:
        assert sample_frames(100, 110, 4) == [100, 104, 108, 109]

    def test_單幀(self) -> None:
        assert sample_frames(5, 6, 6) == [5]

    def test_every_不合法(self) -> None:
        with pytest.raises(OpError):
            sample_frames(0, 10, 0)


class TestOptionsFromArgs:
    def test_沒給的用_dataclass_預設(self) -> None:
        o = options_from_args({"aspect": "9:16"})
        assert o.aspect == (9, 16) and o.deadzone == ReframeOptions().deadzone

    def test_有給的覆寫(self) -> None:
        o = options_from_args({"aspect": "1:1", "deadzone": 0.3, "max_speed": 1.5, "bias_y": 0.08})
        assert (o.aspect, o.deadzone, o.max_speed, o.bias_y) == ((1, 1), 0.3, 1.5, 0.08)

    def test_零不會被當成沒給(self) -> None:
        # `--cut-threshold 0`（一律平移）不可以被 `or` 吃掉變回預設 0.35
        assert options_from_args({"cut_threshold": 0.0}).cut_threshold == 0.0

    def test_壞值包成_operror(self) -> None:
        for bad in [{"aspect": "abc"}, {"aspect": "9:16", "zoom": 0}, {"aspect": "9:16", "deadzone": 0.9}]:
            with pytest.raises(OpError):
                options_from_args(bad)


def _plan(n_frames: int, rng: tuple[int, int] | None, trim: bool, size: tuple[int, int] = HD, *, seq: bool = False) -> SimpleNamespace:
    """load_reframe 只用到 RenderPlan 的幾個欄位；為了測對齊不必搬整個渲染計畫進來。"""
    return SimpleNamespace(
        width=size[0], height=size[1], n_frames=n_frames, range=rng, trim=trim, captions=None,
        sequence=SimpleNamespace(needs_render=True) if seq else None,
        write_range=(rng if (trim and rng) else (0, n_frames)),
    )


def _write(tmp: Path, frames: int, *, rng: tuple[int, int] | None = None, source: tuple[int, int] = HD) -> str:
    doc = to_doc(static_path(source, frames, ReframeOptions()), meta={"range": list(rng)} if rng else {})
    f = tmp / "p.reframe.json"
    f.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    return str(f)


class _Ctx:
    def __init__(self) -> None:
        self.logs: list[tuple[str, str]] = []

    def log(self, level: str, msg: str) -> None:
        self.logs.append((level, msg))


class TestLoadReframe:
    def test_幀數剛好就直接用(self, tmp_path: Path) -> None:
        rf = load_reframe(_write(tmp_path, 200), _plan(200, None, False), _Ctx())
        assert len(rf.rects) == 200

    def test_渲染只出一段時照路徑檔記的範圍切出來(self, tmp_path: Path) -> None:
        # 對整支（0..200）規劃、只渲染 [50,80)：要拿到路徑的第 50..79 格，不是第 0..29 格
        spec = _write(tmp_path, 200, rng=(0, 200))
        rf = load_reframe(spec, _plan(200, (50, 80), True), _Ctx())
        assert len(rf.rects) == 30

    def test_渲染範圍超出規劃範圍就報錯(self, tmp_path: Path) -> None:
        spec = _write(tmp_path, 100, rng=(0, 100))
        with pytest.raises(OpError, match=r"規劃的是幀"):
            load_reframe(spec, _plan(200, (50, 150), True), _Ctx())

    def test_沒有記範圍又對不上幀數就報錯(self, tmp_path: Path) -> None:
        with pytest.raises(OpError, match="幀"):
            load_reframe(_write(tmp_path, 100), _plan(200, None, False), _Ctx())

    def test_解析度不同要擋下來(self, tmp_path: Path) -> None:
        # 對 proxy 規劃、拿去渲染原始檔：座標的意義整個不同，偏移會大到離譜
        spec = _write(tmp_path, 200, source=(1280, 720))
        with pytest.raises(OpError, match="規劃的"):
            load_reframe(spec, _plan(200, None, False), _Ctx())

    def test_檔案不存在(self, tmp_path: Path) -> None:
        with pytest.raises(OpError, match="找不到"):
            load_reframe(str(tmp_path / "沒有.json"), _plan(10, None, False), _Ctx())

    def test_不是合法_json(self, tmp_path: Path) -> None:
        f = tmp_path / "bad.json"
        f.write_text("{{{", encoding="utf-8")
        with pytest.raises(OpError, match="JSON"):
            load_reframe(str(f), _plan(10, None, False), _Ctx())

    def test_序列輸出只認幀數完全相等(self, tmp_path: Path) -> None:
        # 序列寫出的是序列幀 t、路徑是素材 proxy 幀 k，兩套幀號無關。
        # 長度碰巧相等時照 meta.range 去切會安靜地套錯段 —— 這條守住「寧可擋下也不要猜」。
        spec = _write(tmp_path, 200, rng=(0, 200))
        with pytest.raises(OpError, match="序列輸出"):
            load_reframe(spec, _plan(200, (50, 80), True, seq=True), _Ctx())
        rf = load_reframe(spec, _plan(200, None, False, seq=True), _Ctx())
        assert len(rf.rects) == 200

    def test_壞掉的路徑檔包成_operror(self, tmp_path: Path) -> None:
        f = tmp_path / "v9.json"
        f.write_text(json.dumps({"version": 99}), encoding="utf-8")
        with pytest.raises(OpError, match="版本"):
            load_reframe(str(f), _plan(10, None, False), _Ctx())


class TestParseSize:
    """`reframe-apply --size`：yuv420 的色度平面是半解析度，所以長寬都必須是偶數。"""

    def test_沒給就是_none(self) -> None:
        assert parse_size(None) is None
        assert parse_size("") is None

    def test_各種寫法(self) -> None:
        assert parse_size("1080x1920") == (1080, 1920)
        assert parse_size(" 1080 X 1920 ") == (1080, 1920)
        assert parse_size("1080×1920") == (1080, 1920)
        assert parse_size("1080*1920") == (1080, 1920)

    def test_奇數要擋下來(self) -> None:
        for bad in ["1079x1920", "1080x1921"]:
            with pytest.raises(OpError, match="偶數"):
                parse_size(bad)

    def test_太小或格式不對(self) -> None:
        for bad in ["0x0", "abc", "1080", "1x1"]:
            with pytest.raises(OpError):
                parse_size(bad)


class TestDefaultEvery:
    """取樣間隔依 fps 換算，不寫死幀數。"""

    def test_常見畫格率(self) -> None:
        assert default_every(24) == 5
        assert default_every(30) == 6
        assert default_every(60) == 12

    def test_每次都是那個秒數(self) -> None:
        for fps in (23.976, 25, 29.97, 50, 59.94):
            assert abs(default_every(fps) / fps - DEFAULT_EVERY_SECONDS) < 0.03, fps

    def test_至少一幀(self) -> None:
        assert default_every(1) == 1
        assert default_every(0) == 6  # fps 不明時當 30
