"""媒體指紋：與 ai-music-cut `src-tauri/src/ffmpeg.rs::fingerprint`（238–254 行）**逐位元相同**。

    blake3( size_le_u64 ‖ head ‖ tail )
      head = 檔案開頭 min(4 MiB, size) 位元組
      tail = 最後 4 MiB，**只在 size > 4 MiB 時**才餵進去（小檔只雜湊一次，不重複）
      4 MiB < size < 8 MiB 時 head 與 tail 重疊，照樣各餵一次（Rust 也是這樣）

hex 全長 64 碼；快取目錄名取前 16 碼（`env.media_cache_dir`）。
為什麼不雜湊整檔：影片動輒數 GB，開檔要即時；頭尾 + 大小已足以區分「同一個檔案」。
Rust 與 Python 共用測試向量：tests/fixtures/media/fingerprint-vectors.json。
"""
from __future__ import annotations

import os
from typing import BinaryIO

CHUNK = 4 * 1024 * 1024  # 與 Rust 的 CHUNK 常數一致


def fingerprint(path: str | os.PathLike[str]) -> str:
    """回傳 64 碼小寫 hex。找不到檔案會擲 OSError（呼叫端轉成 OpError）。"""
    import blake3  # 在函式內 import：cli --help 不需要它

    with open(os.fspath(path), "rb") as f:
        size = os.fstat(f.fileno()).st_size
        h = blake3.blake3()
        h.update(size.to_bytes(8, "little", signed=False))
        h.update(_read_exact(f, min(CHUNK, size)))
        if size > CHUNK:
            f.seek(size - CHUNK)
            h.update(_read_exact(f, CHUNK))
        return h.hexdigest()


def fingerprint_of_bytes(data: bytes) -> str:
    """同一套佈局算在記憶體緩衝上（測試用參考實作；與 fingerprint(檔案) 必須相同）。"""
    import blake3

    size = len(data)
    parts = [size.to_bytes(8, "little", signed=False), data[: min(CHUNK, size)]]
    if size > CHUNK:
        parts.append(data[size - CHUNK :])
    return blake3.blake3(b"".join(parts)).hexdigest()


def short(fp: str) -> str:
    """快取目錄名 = 前 16 碼（`<app_cache_dir>/media/<fp16>/`）。"""
    return fp[:16]


def _read_exact(f: BinaryIO, n: int) -> bytes:
    """鏡射 Rust `read_exact`：讀不滿就是錯（檔案被截斷／正在寫入）。"""
    buf = bytearray()
    while len(buf) < n:
        chunk = f.read(n - len(buf))
        if not chunk:
            raise OSError(f"檔案比宣告的大小短：要 {n} 位元組只讀到 {len(buf)}")
        buf += chunk
    return bytes(buf)
