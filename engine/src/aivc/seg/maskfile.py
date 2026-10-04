"""`.aivm` 遮罩檔：一個 track 一個檔，逐幀 pycocotools RLE（計畫 §5.4）。

版面（全部 little-endian，無對齊補白；沿用 ai-music-cut `media.rs` AIPK 的 magic+version+length 紀律）：

    header  52 bytes
        b"AIVM" | u32 version=1 | u32 width | u32 height | u32 n_entries | u32 first_k | u32 last_k
        | u64 index_off | u64 data_off | u64 data_len
    index   n_entries × 20 bytes，依 k 嚴格遞增
        u32 k | u64 off | u32 len | u8 flags | u8 pad[3]
    data    逐幀 RLE counts bytes 串接

約定（Rust `cache_read` 依 k 讀、TS worker 解碼都必須照這幾條）：
- `off` **相對於 data_off**（不是檔案絕對位移）：data 區塊自足，`off+len <= data_len` 可直接驗。
- `flags & 1`（present）＝這一幀有遮罩；flags=0 的條目代表「已算過、物件不在」，len 必為 0。
  沒有條目的 k ＝ 還沒算（UI 畫上一幀虛線）。兩者語意不同，所以不用空 RLE 代替缺席。
- `first_k/last_k` ＝ 條目中最小／最大的 k（n_entries=0 時皆為 0）。
- 讀取端拒絕：magic/version 不對、`file_size != data_off + data_len`、index 越界、k 非遞增、條目越界。
- 寫入走唯一的 `<path>.<pid>-<8hex>.part` + `os.replace`（換入被鎖會退避重試），讀取端一次讀進記憶體後就關檔（Windows 開著檔案會擋 replace）。
"""
from __future__ import annotations

import os
import struct
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .. import atomic
from . import rle

MAGIC = b"AIVM"
VERSION = 1
FLAG_PRESENT = 1

_HEADER = struct.Struct("<4sIIIIIIQQQ")  # 52 bytes
_ENTRY = struct.Struct("<IQIB3x")  # 20 bytes
HEADER_SIZE = _HEADER.size
ENTRY_SIZE = _ENTRY.size
_U32_MAX = 0xFFFFFFFF


class MaskFileError(ValueError):
    """檔案壞掉／不是 .aivm／版本不支援。"""


@dataclass(frozen=True)
class Header:
    width: int
    height: int
    n_entries: int
    first_k: int
    last_k: int
    index_off: int
    data_off: int
    data_len: int


@dataclass(frozen=True)
class Entry:
    k: int
    off: int  # 相對 data_off
    len: int
    flags: int

    @property
    def present(self) -> bool:
        return bool(self.flags & FLAG_PRESENT)


@dataclass(frozen=True)
class WriteStats:
    path: str
    n_present: int
    n_absent: int
    file_bytes: int


RleFrames = Iterable[tuple[int, bytes | None]]
MaskFrames = Iterable[tuple[int, np.ndarray | None]]


def read_header(path: str | os.PathLike[str]) -> Header:
    """只讀 header（Rust/TS 對照測試用）。"""
    with open(path, "rb") as f:
        raw = f.read(HEADER_SIZE)
    return _parse_header(raw, os.path.getsize(path))


def _parse_header(raw: bytes, file_size: int) -> Header:
    if len(raw) < HEADER_SIZE:
        raise MaskFileError(f"檔案太短（{len(raw)} bytes），不是 .aivm")
    magic, version, width, height, n, first_k, last_k, index_off, data_off, data_len = _HEADER.unpack_from(raw, 0)
    if magic != MAGIC:
        raise MaskFileError(f"magic 錯誤 {magic!r}，不是 .aivm")
    if version != VERSION:
        raise MaskFileError(f"不支援的 .aivm 版本 {version}（只支援 {VERSION}）")
    if width <= 0 or height <= 0:
        raise MaskFileError(f"尺寸不合法 {width}x{height}")
    if index_off != HEADER_SIZE:
        raise MaskFileError(f"index_off={index_off} 不等於 header 大小 {HEADER_SIZE}")
    if index_off + n * ENTRY_SIZE > data_off:
        raise MaskFileError(f"index（{n} 條）超出 data_off={data_off}")
    if data_off + data_len != file_size:
        raise MaskFileError(f"長度不合：data_off+data_len={data_off + data_len} 但檔案 {file_size} bytes（截斷或多餘資料）")
    if n == 0 and (first_k != 0 or last_k != 0):
        raise MaskFileError("n_entries=0 時 first_k/last_k 必須為 0")
    if n > 0 and first_k > last_k:
        raise MaskFileError(f"first_k={first_k} > last_k={last_k}")
    return Header(width, height, n, first_k, last_k, index_off, data_off, data_len)


class MaskFile:
    """已讀進記憶體的 `.aivm`。用 `MaskFile.open()` 取得；寫入用類別方法 `write*`。"""

    def __init__(self, path: str, header: Header, entries: dict[int, Entry], data: bytes) -> None:
        self.path = path
        self._header = header
        self._entries = entries
        self._data = data

    # ---- 讀 ----
    @classmethod
    def open(cls, path: str | os.PathLike[str]) -> MaskFile:
        p = os.fspath(path)
        with open(p, "rb") as f:
            raw = f.read()
        return cls.from_bytes(raw, p)

    @classmethod
    def from_bytes(cls, raw: bytes, path: str | os.PathLike[str] = "") -> MaskFile:
        """已經讀進來的整個檔 → MaskFile（`open` 的解析那一半）。要「解析的就是雜湊的那一份」時用
        （objects/anchors 的快取鍵：讀一次、兩邊共用，中間檔案被換掉也不會對不上）。"""
        p = os.fspath(path)
        header = _parse_header(raw, len(raw))
        entries: dict[int, Entry] = {}
        prev_k = -1
        for i in range(header.n_entries):
            k, off, ln, flags = _ENTRY.unpack_from(raw, header.index_off + i * ENTRY_SIZE)
            if k <= prev_k:
                raise MaskFileError(f"index 第 {i} 條 k={k} 非嚴格遞增（前一條 {prev_k}）")
            prev_k = k
            present = bool(flags & FLAG_PRESENT)
            if present:
                if ln == 0:
                    raise MaskFileError(f"k={k} 標記 present 但 len=0")
                if off + ln > header.data_len:
                    raise MaskFileError(f"k={k} 資料越界：off={off} len={ln} data_len={header.data_len}")
            elif ln != 0:
                raise MaskFileError(f"k={k} 標記缺席但 len={ln}")
            entries[k] = Entry(k, off, ln, flags)
        if header.n_entries:
            ks = list(entries)
            if ks[0] != header.first_k or ks[-1] != header.last_k:
                raise MaskFileError(f"first_k/last_k（{header.first_k}/{header.last_k}）與 index（{ks[0]}/{ks[-1]}）不合")
        data = raw[header.data_off : header.data_off + header.data_len]
        return cls(p, header, entries, data)

    @property
    def header(self) -> Header:
        return self._header

    @property
    def width(self) -> int:
        return self._header.width

    @property
    def height(self) -> int:
        return self._header.height

    def frames(self) -> list[int]:
        """所有條目的 k（含「物件不在」的缺席條目）。"""
        return list(self._entries)

    def frames_present(self) -> list[int]:
        return [k for k, e in self._entries.items() if e.present]

    def has(self, k: int) -> bool:
        return k in self._entries

    def get_rle(self, k: int) -> bytes | None:
        e = self._entries.get(k)
        if e is None or not e.present:
            return None
        return self._data[e.off : e.off + e.len]

    def get(self, k: int) -> np.ndarray | None:
        """k 幀的 bool 遮罩；沒有條目或缺席條目都回 None（用 `has()` 區分）。"""
        counts = self.get_rle(k)
        if counts is None:
            return None
        return rle.decode(counts, self._header.height, self._header.width)

    def __iter__(self) -> Iterator[tuple[int, np.ndarray]]:
        for k, e in self._entries.items():
            if e.present:
                yield k, rle.decode(self._data[e.off : e.off + e.len], self._header.height, self._header.width)

    def iter_rle(self) -> Iterator[tuple[int, bytes | None]]:
        for k, e in self._entries.items():
            yield k, (self._data[e.off : e.off + e.len] if e.present else None)

    def __len__(self) -> int:
        return sum(1 for e in self._entries.values() if e.present)

    # ---- 寫 ----
    @staticmethod
    def write(path: str | os.PathLike[str], width: int, height: int, frames: MaskFrames) -> WriteStats:
        """從 bool 遮罩寫檔。同一 k 出現多次 → 後者勝。mask=None ＝ 該幀物件不在（缺席條目）。"""
        return MaskFile.write_rle(path, width, height, _encode_frames(width, height, frames))

    @staticmethod
    def write_rle(path: str | os.PathLike[str], width: int, height: int, frames: RleFrames) -> WriteStats:
        """從已編碼的 RLE 寫檔（傳播時逐幀編碼就丟進來，不必在記憶體留 bool 陣列）。"""
        if width <= 0 or height <= 0 or width > _U32_MAX or height > _U32_MAX:
            raise ValueError(f"尺寸不合法 {width}x{height}")
        merged: dict[int, bytes | None] = {}
        for k, counts in frames:
            if not isinstance(k, (int, np.integer)) or k < 0 or k > _U32_MAX:
                raise ValueError(f"幀號必須是 0..2^32-1 的整數，拿到 {k!r}")
            if counts is not None and len(counts) == 0:
                raise ValueError(f"k={k} 的 RLE 為空 bytes（空遮罩也至少有一個 count）")
            merged[int(k)] = counts
        ks = sorted(merged)
        blobs: list[bytes] = []
        index = bytearray()
        off = 0
        n_present = 0
        for k in ks:
            counts = merged[k]
            if counts is None:
                index += _ENTRY.pack(k, 0, 0, 0)
                continue
            index += _ENTRY.pack(k, off, len(counts), FLAG_PRESENT)
            blobs.append(counts)
            off += len(counts)
            n_present += 1
        data = b"".join(blobs)
        index_off = HEADER_SIZE
        data_off = index_off + len(index)
        header = _HEADER.pack(
            MAGIC, VERSION, width, height, len(ks), ks[0] if ks else 0, ks[-1] if ks else 0, index_off, data_off, len(data)
        )
        p = Path(path)
        # 唯一暫存名 + 換入重試：輕量 lane 的 geom.quad_from_mask 可能正開著同一個 .aivm 讀（B-06）
        with atomic.atomic_write(p, "wb") as f:
            f.write(header)
            f.write(index)
            f.write(data)
        return WriteStats(str(p), n_present, len(ks) - n_present, len(header) + len(index) + len(data))

    @staticmethod
    def write_update(path: str | os.PathLike[str], width: int, height: int, new_frames: MaskFrames) -> WriteStats:
        """合併寫回：既有檔的幀 + 新幀，同 k 後寫者勝（refine 重傳播只覆寫被重算的幀）。"""
        return MaskFile.write_update_rle(path, width, height, _encode_frames(width, height, new_frames))

    @staticmethod
    def write_update_rle(path: str | os.PathLike[str], width: int, height: int, new_frames: RleFrames) -> WriteStats:
        p = Path(path)
        existing: list[tuple[int, bytes | None]] = []
        if p.is_file():
            old = MaskFile.open(p)
            if (old.width, old.height) != (width, height):
                raise MaskFileError(f"既有 {p} 尺寸 {old.width}x{old.height} 與新遮罩 {width}x{height} 不合")
            existing = list(old.iter_rle())

        def chain() -> Iterator[tuple[int, bytes | None]]:
            yield from existing
            yield from new_frames

        return MaskFile.write_rle(p, width, height, chain())


def _encode_frames(width: int, height: int, frames: MaskFrames) -> Iterator[tuple[int, bytes | None]]:
    for k, mask in frames:
        if mask is None:
            yield k, None
            continue
        if mask.shape != (height, width):
            raise ValueError(f"k={k} 遮罩 shape {mask.shape} 與檔案尺寸 (H={height}, W={width}) 不合")
        yield k, rle.encode(mask)
