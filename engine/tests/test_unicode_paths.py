"""非 ASCII 路徑（中文資料夾名稱＋空白）下的影像讀寫：aivc.imageio 與所有改用它的呼叫端。

Windows 上 cv2.imread／imwrite 對「換花色 測試」這種路徑安靜失敗（回 None／False），同一個檔放 ASCII 資料夾就正常；
這裡每一條都拿同一份檔案在 ASCII 與中文資料夾各跑一次，結果必須逐位元相同。
Linux／macOS 的 cv2 本來就吃 UTF-8 路徑，所以這些測試只有在 Windows 上才會在修正前失敗。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import cv2
import numpy as np
import pytest

import aivc
from aivc import imageio

CJK_DIR = "換花色 測試"
SRC = Path(aivc.__file__).resolve().parent  # 掃「實際 import 到的」引擎原始碼


def _put(path: Path, img: np.ndarray) -> Path:
    """測試資料用 imencode + tofile 寫（不經過被測的程式碼）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    ok, buf = cv2.imencode(path.suffix, img)
    assert ok
    buf.tofile(str(path))
    return path


def _card_rgba(h: int = 60, w: int = 40) -> np.ndarray:
    rng = np.random.default_rng(7)
    bgra = np.zeros((h, w, 4), np.uint8)
    bgra[..., :3] = 235
    bgra[10:30, 8:20, :3] = rng.integers(0, 80, (20, 12, 3), dtype=np.uint8)  # 墨
    bgra[..., 3] = 255
    bgra[:2, :2, 3] = 0  # 圓角外
    return bgra


def _mask() -> np.ndarray:
    m = np.zeros((100, 100), np.uint8)
    m[20:80, 30:70] = 255
    return m


@pytest.fixture()
def dirs(tmp_path: Path) -> dict[str, Path]:
    out = {}
    for name in ("ascii", CJK_DIR):
        d = tmp_path / name
        _put(d / "card.png", _card_rgba())
        _put(d / "mask.png", _mask())
        _put(d / "photo.jpg", np.dstack([np.tile(np.arange(64, dtype=np.uint8), (48, 1))] * 3))
        out[name] = d
    return out


# ---------------------------------------------------------------- 輔助函式本身


@pytest.mark.parametrize("name,flags", [("card.png", cv2.IMREAD_UNCHANGED), ("card.png", cv2.IMREAD_COLOR), ("mask.png", cv2.IMREAD_GRAYSCALE), ("photo.jpg", None)])
def test_imread_unicode_matches_imread_on_ascii(dirs: dict[str, Path], name: str, flags: int | None) -> None:
    ref = cv2.imread(str(dirs["ascii"] / name), cv2.IMREAD_COLOR if flags is None else flags)  # ASCII 路徑上 imread 正常
    assert ref is not None
    for d in dirs.values():
        got = imageio.imread_unicode(d / name, flags)
        assert got.dtype == ref.dtype and np.array_equal(got, ref), d


def test_imwrite_unicode_roundtrip_overwrite_and_no_temp_left(tmp_path: Path) -> None:
    d = tmp_path / CJK_DIR / "子資料夾 二"
    d.mkdir(parents=True)
    img = _card_rgba()
    out = d / "預覽 frame.png"
    imageio.imwrite_unicode(out, img)
    assert np.array_equal(imageio.imread_unicode(out, cv2.IMREAD_UNCHANGED), img)
    img2 = img.copy()
    img2[..., 0] = 9
    imageio.imwrite_unicode(str(out), img2)  # 覆寫既有檔
    assert np.array_equal(imageio.imread_unicode(out, cv2.IMREAD_UNCHANGED), img2)
    imageio.imwrite_unicode(d / "q.jpg", img[..., :3], [cv2.IMWRITE_JPEG_QUALITY, 90])
    assert imageio.imread_unicode(d / "q.jpg").shape == (60, 40, 3)
    assert sorted(p.name for p in d.iterdir()) == ["q.jpg", "預覽 frame.png"], "暫存檔要被 rename 掉"


def test_imread_unicode_errors(tmp_path: Path) -> None:
    d = tmp_path / CJK_DIR
    d.mkdir()
    with pytest.raises(FileNotFoundError):
        imageio.imread_unicode(d / "沒有這張.png")
    (d / "空.png").write_bytes(b"")
    (d / "壞.png").write_bytes(b"\x89PNG\r\n\x1a\n not really a png")
    for bad in ("空.png", "壞.png"):
        with pytest.raises(ValueError, match="無法解碼"):
            imageio.imread_unicode(d / bad, cv2.IMREAD_UNCHANGED)
    with pytest.raises(OSError):
        imageio.imread_unicode(d)  # 資料夾


def test_imwrite_unicode_bad_extension_raises_and_leaves_nothing(tmp_path: Path) -> None:
    d = tmp_path / CJK_DIR
    d.mkdir()
    for name in ("沒有副檔名", "x.notanimage"):
        with pytest.raises(ValueError, match="無法編碼"):
            imageio.imwrite_unicode(d / name, _mask())
    with pytest.raises(OSError):
        imageio.imwrite_unicode(d / "不存在的資料夾" / "x.png", _mask())
    assert list(d.iterdir()) == []


# ---------------------------------------------------------------- 呼叫端


def test_load_template_under_cjk_path(dirs: dict[str, Path]) -> None:
    from aivc.track.template import load_template

    a, b = (load_template(str(d / "card.png")) for d in dirs.values())
    assert np.array_equal(a.image, b.image) and np.array_equal(a.paper_mask, b.paper_mask) and np.array_equal(a.ink_mask, b.ink_mask)
    assert not b.paper_mask[0, 0] and b.paper_mask[30, 20]  # alpha 有被讀進來
    with pytest.raises(FileNotFoundError, match="讀不到模板圖"):
        load_template(str(dirs[CJK_DIR] / "沒有.png"))


def test_quad_from_mask_op_under_cjk_path(dirs: dict[str, Path]) -> None:
    from aivc.ops import OpError
    from aivc.ops.track import quad_from_mask_op

    a, b = (quad_from_mask_op({"maskPng": str(d / "mask.png")}, None) for d in dirs.values())
    assert a == b and b["quad"] is not None
    with pytest.raises(OpError, match="讀不到遮罩") as ei:
        quad_from_mask_op({"maskPng": str(dirs[CJK_DIR] / "沒有.png")}, None)
    assert ei.value.kind == "Io"


def test_preview_readers_under_cjk_path(dirs: dict[str, Path]) -> None:
    from aivc.ops import OpError
    from aivc.ops import preview as pv

    ascii_dir, cjk = dirs["ascii"], dirs[CJK_DIR]
    assert np.array_equal(pv._read_rgb(str(ascii_dir / "card.png")), pv._read_rgb(str(cjk / "card.png")))
    (ra, aa), (rb, ab) = pv._read_rgba(str(ascii_dir / "card.png")), pv._read_rgba(str(cjk / "card.png"))
    assert np.array_equal(ra, rb) and ab is not None and np.array_equal(aa, ab)
    assert np.array_equal(pv._read_mask(str(ascii_dir / "mask.png"), (50, 50)), pv._read_mask(str(cjk / "mask.png"), (50, 50)))
    (cjk / "壞.png").write_bytes(b"garbage")
    with pytest.raises(OpError, match="無法解碼") as ei:
        pv._read_mask(str(cjk / "壞.png"), (50, 50))
    assert ei.value.kind == "Io"
    with pytest.raises(OpError, match="讀不到影像"):
        pv._read_rgb(str(cjk / "沒有.png"))


def test_preview_composite_cli_reads_and_writes_under_cjk_path(dirs: dict[str, Path], capsys: pytest.CaptureFixture[str]) -> None:
    """整條 preview-composite：幀、新牌面、遮罩都在中文資料夾，輸出也寫進中文資料夾；結果與 ASCII 版逐位元相同。"""
    from aivc.cli import main

    frame = np.full((96, 128, 3), 40, np.uint8)
    frame[20:80, 40:88] = 225
    outs = []
    for d in dirs.values():
        _put(d / "frame.png", frame)
        _put(d / "vis.png", np.full((96, 128), 255, np.uint8))
        out = d / "輸出 結果" / "預覽.png"
        code = main([
            "--json", "preview-composite", "--frame", str(d / "frame.png"), "--quad", "40,20,88,20,88,80,40,80",
            "--template-new", str(d / "card.png"), "--mask", str(d / "vis.png"), "--view", "split", "-o", str(out),
        ])
        line = capsys.readouterr().out.strip().splitlines()[-1]
        assert code == 0, line
        assert json.loads(line)["ok"] is True
        outs.append(imageio.imread_unicode(out, cv2.IMREAD_UNCHANGED))
    assert np.array_equal(outs[0], outs[1])


# ---------------------------------------------------------------- 守門


def test_no_raw_cv2_imread_imwrite_in_engine_source() -> None:
    """cv2 的檔案 API 在 Windows 吃不下非 ASCII 路徑：引擎一律走 aivc.imageio（新檔案也一樣）。

    imread／imwrite 之外，VideoCapture／VideoWriter／imreadmulti／FileStorage 同樣是 ANSI 綁定的
    （今天引擎沒有用到，寫進守門是為了不讓它們哪天悄悄溜進來；影片一律走 PyAV／ffmpeg）。
    """
    pat = re.compile(r"\bcv2\s*\.\s*(imread|imwrite|imreadmulti|imwritemulti|VideoCapture|VideoWriter|FileStorage)\s*\(")
    hits = []
    for py in sorted(SRC.rglob("*.py")):
        if py.name == "imageio.py" and py.parent == SRC:
            continue
        for i, line in enumerate(py.read_text(encoding="utf-8").splitlines(), 1):
            if pat.search(line):
                hits.append(f"{py.relative_to(SRC)}:{i}: {line.strip()}")
    assert not hits, "改用 aivc.imageio.imread_unicode／imwrite_unicode：\n" + "\n".join(hits)
