"""seg.maskfile：.aivm 版面 golden、往返、後寫者勝、壞檔拒絕。CPU、不需範例影片。"""
from __future__ import annotations

import struct
from pathlib import Path

import numpy as np
import pytest

from aivc.seg import rle
from aivc.seg.maskfile import ENTRY_SIZE, HEADER_SIZE, MaskFile, MaskFileError, read_header
from aivc.seg.preview import load_mask_png

FIX = Path(__file__).resolve().parent / "fixtures" / "seg"
GOLDEN = FIX / "cards_64x48.aivm"
W, H = 64, 48


def _rand_masks(seed: int, n: int, shape: tuple[int, int] = (H, W)) -> dict[int, np.ndarray]:
    rng = np.random.default_rng(seed)
    return {int(k): rng.random(shape) < 0.25 for k in rng.choice(1000, size=n, replace=False)}


# ---- golden ----
def test_golden_header_layout() -> None:
    """用 struct 直接拆 header，不經過我們的 reader：釘住三方共用的位移。"""
    raw = GOLDEN.read_bytes()
    assert raw[:4] == b"AIVM"
    (version, width, height, n, first_k, last_k) = struct.unpack_from("<6I", raw, 4)
    (index_off, data_off, data_len) = struct.unpack_from("<3Q", raw, 28)
    assert (version, width, height, n, first_k, last_k) == (1, W, H, 3, 3, 7)
    assert index_off == HEADER_SIZE == 52
    assert data_off == index_off + n * ENTRY_SIZE and ENTRY_SIZE == 20
    assert data_off + data_len == len(raw)
    ks, offs, lens, flags = [], [], [], []
    for i in range(n):
        k, off, ln, fl = struct.unpack_from("<IQIB3x", raw, index_off + i * ENTRY_SIZE)
        ks.append(k), offs.append(off), lens.append(ln), flags.append(fl)
    assert ks == [3, 5, 7]
    assert flags == [1, 0, 1]
    assert lens[1] == 0 and offs[0] == 0 and offs[2] == lens[0]  # off 相對 data_off、資料緊密串接
    assert offs[2] + lens[2] == data_len


def test_golden_decodes_to_pngs() -> None:
    mf = MaskFile.open(GOLDEN)
    assert (mf.width, mf.height) == (W, H)
    assert mf.frames() == [3, 5, 7]
    assert mf.frames_present() == [3, 7]
    assert len(mf) == 2
    for k in (3, 7):
        expected = load_mask_png(FIX / f"k{k:04d}.png")
        np.testing.assert_array_equal(mf.get(k), expected)
    assert mf.has(5) and mf.get(5) is None and mf.get_rle(5) is None
    assert not mf.has(4) and mf.get(4) is None
    assert [k for k, _ in mf] == [3, 7]
    assert read_header(GOLDEN) == mf.header


def test_golden_rewrite_is_byte_identical(tmp_path: Path) -> None:
    """decode → 重寫必須逐位元相同：writer 確定性 + 版面穩定。"""
    mf = MaskFile.open(GOLDEN)
    out = tmp_path / "re.aivm"
    MaskFile.write(out, W, H, ((k, mf.get(k)) for k in mf.frames()))
    assert out.read_bytes() == GOLDEN.read_bytes()


# ---- 往返 ----
def test_roundtrip_random(tmp_path: Path) -> None:
    frames = _rand_masks(7, 25)
    out = tmp_path / "m.aivm"
    st = MaskFile.write(out, W, H, frames.items())
    assert st.n_present == 25 and st.n_absent == 0 and st.file_bytes == out.stat().st_size
    mf = MaskFile.open(out)
    assert mf.frames_present() == sorted(frames)
    for k, m in frames.items():
        np.testing.assert_array_equal(mf.get(k), m)
    assert mf.header.first_k == min(frames) and mf.header.last_k == max(frames)


def test_write_empty_file(tmp_path: Path) -> None:
    out = tmp_path / "empty.aivm"
    MaskFile.write(out, W, H, [])
    mf = MaskFile.open(out)
    assert mf.frames() == [] and len(mf) == 0
    assert out.stat().st_size == HEADER_SIZE


def test_later_write_wins_within_one_write(tmp_path: Path) -> None:
    a = np.zeros((H, W), bool)
    a[0:10] = True
    b = np.zeros((H, W), bool)
    b[20:30] = True
    out = tmp_path / "dup.aivm"
    MaskFile.write(out, W, H, [(4, a), (4, b), (2, None), (2, a)])
    mf = MaskFile.open(out)
    np.testing.assert_array_equal(mf.get(4), b)
    np.testing.assert_array_equal(mf.get(2), a)


def test_write_update_merges_and_later_wins(tmp_path: Path) -> None:
    old = _rand_masks(1, 10)
    out = tmp_path / "u.aivm"
    MaskFile.write(out, W, H, old.items())
    new = _rand_masks(2, 6)
    overlap_k = next(iter(old))
    new[overlap_k] = ~old[overlap_k]
    absent_k = sorted(old)[1]
    new[absent_k] = None  # type: ignore[assignment]
    MaskFile.write_update(out, W, H, new.items())
    mf = MaskFile.open(out)
    assert set(mf.frames()) == set(old) | set(new)
    np.testing.assert_array_equal(mf.get(overlap_k), new[overlap_k])
    assert mf.has(absent_k) and mf.get(absent_k) is None
    for k, m in old.items():
        if k not in new:
            np.testing.assert_array_equal(mf.get(k), m)


def test_write_update_creates_when_missing(tmp_path: Path) -> None:
    out = tmp_path / "sub" / "new.aivm"
    MaskFile.write_update(out, W, H, _rand_masks(3, 2).items())
    assert MaskFile.open(out).width == W


def test_write_update_rejects_size_mismatch(tmp_path: Path) -> None:
    out = tmp_path / "s.aivm"
    MaskFile.write(out, W, H, _rand_masks(1, 2).items())
    with pytest.raises(MaskFileError):
        MaskFile.write_update(out, W + 1, H, [(1, np.zeros((H, W + 1), bool))])


def test_write_rejects_bad_inputs(tmp_path: Path) -> None:
    out = tmp_path / "bad.aivm"
    with pytest.raises(ValueError):
        MaskFile.write(out, W, H, [(1, np.zeros((H + 1, W), bool))])
    with pytest.raises(ValueError):
        MaskFile.write(out, W, H, [(-1, np.zeros((H, W), bool))])
    with pytest.raises(ValueError):
        MaskFile.write(out, 0, H, [])
    with pytest.raises(ValueError):
        MaskFile.write_rle(out, W, H, [(1, b"")])
    assert not out.exists() and not (tmp_path / "bad.aivm.part").exists()


# ---- 壞檔拒絕 ----
def _write_good(tmp_path: Path) -> tuple[Path, bytes]:
    out = tmp_path / "good.aivm"
    MaskFile.write(out, W, H, _rand_masks(5, 4).items())
    return out, out.read_bytes()


def test_rejects_wrong_magic(tmp_path: Path) -> None:
    out, raw = _write_good(tmp_path)
    out.write_bytes(b"AIPK" + raw[4:])
    with pytest.raises(MaskFileError, match="magic"):
        MaskFile.open(out)


def test_rejects_wrong_version(tmp_path: Path) -> None:
    out, raw = _write_good(tmp_path)
    out.write_bytes(raw[:4] + struct.pack("<I", 2) + raw[8:])
    with pytest.raises(MaskFileError, match="版本"):
        MaskFile.open(out)


@pytest.mark.parametrize("cut", [10, HEADER_SIZE - 1, HEADER_SIZE + 5, -1, -7])
def test_rejects_truncation(tmp_path: Path, cut: int) -> None:
    out, raw = _write_good(tmp_path)
    out.write_bytes(raw[:cut] if cut > 0 else raw[:cut])
    with pytest.raises(MaskFileError):
        MaskFile.open(out)


def test_rejects_trailing_garbage(tmp_path: Path) -> None:
    out, raw = _write_good(tmp_path)
    out.write_bytes(raw + b"\x00")
    with pytest.raises(MaskFileError, match="長度不合"):
        MaskFile.open(out)


def test_rejects_index_overrun(tmp_path: Path) -> None:
    """把最後一條 index 的 len 加 1 → off+len 超出 data_len。"""
    out, raw = _write_good(tmp_path)
    n = struct.unpack_from("<I", raw, 16)[0]
    pos = HEADER_SIZE + (n - 1) * ENTRY_SIZE
    k, off, ln, fl = struct.unpack_from("<IQIB3x", raw, pos)
    patched = bytearray(raw)
    struct.pack_into("<IQIB3x", patched, pos, k, off, ln + 1, fl)
    out.write_bytes(bytes(patched))
    with pytest.raises(MaskFileError, match="越界"):
        MaskFile.open(out)


def test_rejects_unsorted_k(tmp_path: Path) -> None:
    out, raw = _write_good(tmp_path)
    e0 = raw[HEADER_SIZE : HEADER_SIZE + ENTRY_SIZE]
    e1 = raw[HEADER_SIZE + ENTRY_SIZE : HEADER_SIZE + 2 * ENTRY_SIZE]
    patched = raw[:HEADER_SIZE] + e1 + e0 + raw[HEADER_SIZE + 2 * ENTRY_SIZE :]
    out.write_bytes(patched)
    with pytest.raises(MaskFileError):
        MaskFile.open(out)


def test_rejects_misaligned_data_off(tmp_path: Path) -> None:
    """data_off 往後挪 1 但檔案沒變 → 長度檢查擋下（index/data 錯位的典型症狀）。"""
    out, raw = _write_good(tmp_path)
    data_off = struct.unpack_from("<Q", raw, 36)[0]
    patched = bytearray(raw)
    struct.pack_into("<Q", patched, 36, data_off + 1)
    out.write_bytes(bytes(patched))
    with pytest.raises(MaskFileError):
        MaskFile.open(out)


def test_rejects_present_with_zero_len(tmp_path: Path) -> None:
    out, raw = _write_good(tmp_path)
    k, off, ln, fl = struct.unpack_from("<IQIB3x", raw, HEADER_SIZE)
    patched = bytearray(raw)
    struct.pack_into("<IQIB3x", patched, HEADER_SIZE, k, off, 0, fl)
    # 把 data_len 也縮短對應長度，讓總長仍一致 → 只剩 present/len 檢查會擋
    data_len = struct.unpack_from("<Q", raw, 44)[0]
    struct.pack_into("<Q", patched, 44, data_len - ln)
    out.write_bytes(bytes(patched[: len(patched) - ln]))
    with pytest.raises(MaskFileError):
        MaskFile.open(out)


def test_rle_bytes_in_file_equal_direct_encode(tmp_path: Path) -> None:
    """檔內 counts 就是 pycocotools 的 counts（TS/Rust 可直接用同一解碼器）。"""
    m = _rand_masks(9, 1)
    k, mask = next(iter(m.items()))
    out = tmp_path / "c.aivm"
    MaskFile.write(out, W, H, [(k, mask)])
    assert MaskFile.open(out).get_rle(k) == rle.encode(mask)
