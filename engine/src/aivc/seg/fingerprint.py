"""媒體指紋：blake3(size_le_u64 ‖ 首 min(4 MiB, size) ‖ 尾 4 MiB 只在 size>4 MiB 時)。

必須與 ai-music-cut `src-tauri/src/ffmpeg.rs::fingerprint` 逐位元相同（快取目錄名 = hex 前 16 碼）。
media 模組會有正式版（media/fingerprint.py）；這份是 seg CLI 的本地副本，整合時換掉即可。
"""
from __future__ import annotations

import os

CHUNK = 4 * 1024 * 1024


def fingerprint(path: str | os.PathLike[str]) -> str:
    import blake3

    size = os.path.getsize(path)
    h = blake3.blake3()
    h.update(size.to_bytes(8, "little"))
    with open(path, "rb") as f:
        h.update(f.read(min(CHUNK, size)))
        if size > CHUNK:
            f.seek(size - CHUNK)
            h.update(f.read(CHUNK))
    return h.hexdigest()
