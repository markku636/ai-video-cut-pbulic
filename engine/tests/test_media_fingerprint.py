"""指紋：與 ai-music-cut ffmpeg.rs::fingerprint 逐位元相同的佈局（blake3(size_le_u64 ‖ head ‖ tail)）。"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from aivc import env
from aivc.media import cache
from aivc.media import fingerprint as F

FIXTURE = Path(__file__).parent / "fixtures" / "media" / "fingerprint-vectors.json"
CHUNK = F.CHUNK


def pattern(n: int) -> bytes:
    """與 fixture 的 generator 一致：byte[i] = (i*7+3) & 0xFF（Rust 端可用同一式重生）。"""
    return ((np.arange(n, dtype=np.uint64) * 7 + 3) & 0xFF).astype(np.uint8).tobytes()


def reference(data: bytes) -> str:
    """把佈局攤開來寫一次，當作文件：size LE u64、head=min(4MiB,size)、tail 只在 size>4MiB。"""
    import blake3

    size = len(data)
    buf = size.to_bytes(8, "little") + data[: min(CHUNK, size)]
    if size > CHUNK:
        buf += data[-CHUNK:]
    return blake3.blake3(buf).hexdigest()


@pytest.mark.parametrize("size", [0, 1, 10_000, CHUNK - 1, CHUNK, CHUNK + 1, CHUNK + 100])
def test_layout_matches_reference(tmp_path: Path, size: int) -> None:
    data = pattern(size)
    p = tmp_path / f"f{size}.bin"
    p.write_bytes(data)
    got = F.fingerprint(p)
    assert got == reference(data) == F.fingerprint_of_bytes(data)
    assert len(got) == 64 and got == got.lower()


def test_vectors_fixture(tmp_path: Path) -> None:
    """跨語言共用向量：Rust 端用同樣 generator 重生檔案，必須得到同樣 hex。"""
    doc = json.loads(FIXTURE.read_text(encoding="utf-8"))
    assert doc["generator"] == "byte[i] = (i*7+3) & 0xFF"
    assert doc["layout"].startswith("blake3(")
    for vec in doc["vectors"]:
        p = tmp_path / f"v{vec['size']}.bin"
        p.write_bytes(pattern(vec["size"]))
        got = F.fingerprint(p)
        assert got == vec["blake3_hex"], vec
        assert F.short(got) == vec["dir16"]


def test_ported_rust_unit_test(tmp_path: Path) -> None:
    """ffmpeg.rs `fingerprint_is_stable_and_size_sensitive` 的 Python 版。"""
    a = tmp_path / "a.bin"
    a.write_bytes(bytes([7]) * 10_000)
    f1 = F.fingerprint(a)
    assert f1 == F.fingerprint(a)
    a.write_bytes(bytes([7]) * 10_001)
    assert f1 != F.fingerprint(a)
    e = tmp_path / "e.bin"
    e.write_bytes(b"")
    assert len(F.fingerprint(e)) == 64


def test_only_head_and_tail_are_hashed(tmp_path: Path) -> None:
    """>8 MiB 的檔案中段改動不會被察覺（設計如此：開檔要即時）；頭、尾任何一位元組改動都會。"""
    n = 9 * 1024 * 1024
    base = bytearray(pattern(n))
    p = tmp_path / "big.bin"
    p.write_bytes(base)
    fp0 = F.fingerprint(p)

    mid = bytearray(base)
    mid[4 * 1024 * 1024 + 512 * 1024] ^= 0xFF  # 4.5 MiB：head 到 4 MiB、tail 從 5 MiB 起，這一位元組兩邊都不碰
    p.write_bytes(mid)
    assert F.fingerprint(p) == fp0

    head = bytearray(base)
    head[1024] ^= 0xFF
    p.write_bytes(head)
    assert F.fingerprint(p) != fp0

    tail = bytearray(base)
    tail[-1] ^= 0xFF
    p.write_bytes(tail)
    assert F.fingerprint(p) != fp0


def test_overlap_region_between_4_and_8_mib_hashed_twice(tmp_path: Path) -> None:
    """4 MiB < size < 8 MiB：head 與 tail 重疊，重疊區各餵一次（跟 Rust 一樣，不能「去重」）。"""
    n = 6 * 1024 * 1024
    data = pattern(n)
    p = tmp_path / "mid.bin"
    p.write_bytes(data)
    import blake3

    twice = blake3.blake3(n.to_bytes(8, "little") + data[:CHUNK] + data[-CHUNK:]).hexdigest()
    once = blake3.blake3(n.to_bytes(8, "little") + data).hexdigest()
    assert F.fingerprint(p) == twice != once


def test_truncated_file_raises(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = tmp_path / "t.bin"
    p.write_bytes(b"x" * 100)
    real_fstat = F.os.fstat

    class FakeStat:
        st_size = 200

    monkeypatch.setattr(F.os, "fstat", lambda fd: FakeStat())  # 宣告 200 但只有 100 → read_exact 必須報錯
    with pytest.raises(OSError):
        F.fingerprint(p)
    monkeypatch.setattr(F.os, "fstat", real_fstat)


def test_cache_dir_uses_first_16_hex(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    p = tmp_path / "v.bin"
    p.write_bytes(pattern(1234))
    mc = cache.for_file(p)
    assert mc.dir == env.media_cache_dir(mc.fingerprint)
    assert mc.dir.name == mc.fingerprint[:16]
    assert mc.dir.parent == tmp_path / "cache" / "media"
    assert mc.probe_json.name == "probe.v1.json" and mc.index_json.name == "index.v1.json"
    assert mc.shots_json.name == "shots.v1.json" and mc.proxy_mp4.name == "proxy.mp4"


def test_write_json_is_atomic(tmp_path: Path) -> None:
    p = tmp_path / "x.json"
    cache.write_json(p, {"a": 1, "中文": "ok"})
    assert not p.with_suffix(".json.part").exists()
    assert cache.read_json(p) == {"a": 1, "中文": "ok"}
    p.write_text("{broken", encoding="utf-8")
    assert cache.read_json(p) is None
    assert cache.read_json(tmp_path / "missing.json") is None
