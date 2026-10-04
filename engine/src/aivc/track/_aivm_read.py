"""最小 `.aivm` 遮罩檔讀取器（計畫 §5.4）。seg 模組擁有正式的寫入端／讀取端，整合時以它為準、刪掉這份。

版面（全部 little-endian）：
    magic b"AIVM" | u32 version=1 | u32 width | u32 height | u32 n_entries | u32 first_k | u32 last_k
    | u64 index_off | u64 data_off | u64 data_len
    index: n_entries × { u32 k | u64 off | u32 len | u8 flags(present=1) | u8 pad[3] }
    data : 逐幀 pycocotools 壓縮 RLE counts bytes
`off` 的基準計畫沒寫死：這裡先當**絕對檔案位移**，若所有 off 都落在 data 區之前就改當相對 data_off。
"""
from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .. import atomic

MAGIC = b"AIVM"
VERSION = 1
HEADER = struct.Struct("<4sIIIIIIQQQ")  # 52 bytes
ENTRY = struct.Struct("<IQIB3x")  # 20 bytes
FLAG_PRESENT = 1


@dataclass(frozen=True)
class AivmHeader:
    version: int
    width: int
    height: int
    n_entries: int
    first_k: int
    last_k: int
    index_off: int
    data_off: int
    data_len: int


class AivmReader:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        # 退避重試：主 lane 可能正在 os.replace 這個檔（B-06；Windows 會短暫擋住開檔）
        self._buf = atomic.read_bytes(self.path)
        if len(self._buf) < HEADER.size:
            raise ValueError(f"{self.path}: 檔案太短，不是 .aivm")
        magic, ver, w, h, n, k0, k1, ioff, doff, dlen = HEADER.unpack_from(self._buf, 0)
        if magic != MAGIC:
            raise ValueError(f"{self.path}: magic {magic!r} ≠ AIVM")
        if ver != VERSION:
            raise ValueError(f"{self.path}: 版本 {ver} 不支援（只讀 {VERSION}）")
        if ioff + n * ENTRY.size > len(self._buf) or doff + dlen > len(self._buf):
            raise ValueError(f"{self.path}: index/data 區超出檔案長度")
        self.header = AivmHeader(ver, w, h, n, k0, k1, ioff, doff, dlen)
        self._index: dict[int, tuple[int, int, int]] = {}
        for i in range(n):
            k, off, ln, flags = ENTRY.unpack_from(self._buf, ioff + i * ENTRY.size)
            self._index[int(k)] = (int(off), int(ln), int(flags))
        # 位移基準判定：全部 off+len 都塞得進 data 區（相對）而且有任何 off < data_off → 相對
        rel = n > 0 and all(off + ln <= dlen for off, ln, _ in self._index.values()) and any(off < doff for off, _, _ in self._index.values())
        self._base = doff if rel else 0

    @property
    def width(self) -> int:
        return self.header.width

    @property
    def height(self) -> int:
        return self.header.height

    def frames(self) -> list[int]:
        return sorted(k for k, (_, _, f) in self._index.items() if f & FLAG_PRESENT)

    def has(self, k: int) -> bool:
        e = self._index.get(int(k))
        return e is not None and bool(e[2] & FLAG_PRESENT) and e[1] > 0

    def mask(self, k: int) -> np.ndarray | None:
        """k 的 bool 遮罩 (height, width)；沒有這幀 → None（呼叫端視為全可見或 LOST 由自己決定）。"""
        e = self._index.get(int(k))
        if e is None or not (e[2] & FLAG_PRESENT) or e[1] == 0:
            return None
        off, ln, _ = e
        start = self._base + off
        counts = self._buf[start : start + ln]
        if len(counts) != ln:
            raise ValueError(f"{self.path}: 幀 {k} 的 RLE 超出檔案")
        from pycocotools import mask as mask_util

        m = mask_util.decode({"size": [self.header.height, self.header.width], "counts": bytes(counts)})
        return np.ascontiguousarray(m.reshape(self.header.height, self.header.width) > 0)

    __call__ = mask


def read_aivm(path: str | Path) -> AivmReader:
    return AivmReader(path)
