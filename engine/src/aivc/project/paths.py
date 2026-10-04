"""快取版面（計畫 §5.3）：`<cache_root>/media/<fp16>/probe.v1.json index.v1.json shots.v1.json proxy.mp4 thumbs/ tracks/<trackId>/{masks.aivm, solve.v1.json, faces/<k>.png}`。

全部可重生；專案檔只存指紋，缺檔就標 stale。Rust 端用同一套相對路徑做 `cache_read(fingerprint, relPath)`，
所以這裡的字串就是跨語言契約 —— 改名要三端一起改。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .. import env

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_component(s: str) -> str:
    """把任意 id 變成安全的單層目錄名：只留 [A-Za-z0-9._-]，禁止 `..`、空字串與路徑分隔（防路徑穿越）。"""
    cleaned = _SAFE.sub("_", s or "").strip("._")
    if not cleaned or cleaned in (".", ".."):
        raise ValueError(f"不安全的路徑元件：{s!r}")
    return cleaned


@dataclass(frozen=True)
class MediaCache:
    root: Path  # = env.media_cache_dir(fingerprint)

    # ---- 頂層檔 ----
    @property
    def probe(self) -> Path:
        return self.root / "probe.v1.json"

    @property
    def index(self) -> Path:
        return self.root / "index.v1.json"

    @property
    def shots(self) -> Path:
        return self.root / "shots.v1.json"

    @property
    def proxy(self) -> Path:
        return self.root / "proxy.mp4"

    @property
    def thumbs(self) -> Path:
        return self.root / "thumbs"

    @property
    def tracks(self) -> Path:
        return self.root / "tracks"

    @property
    def detect(self) -> Path:
        """偵測結果／疊圖（給 Start Screen 自動偵測的預覽）。"""
        return self.root / "detect"

    # ---- 每條 track ----
    def track_dir(self, track_id: str) -> Path:
        return self.tracks / safe_component(track_id)

    def masks(self, track_id: str) -> Path:
        return self.track_dir(track_id) / "masks.aivm"

    def solve(self, track_id: str) -> Path:
        return self.track_dir(track_id) / "solve.v1.json"

    def faces_dir(self, track_id: str) -> Path:
        return self.track_dir(track_id) / "faces"

    def face(self, track_id: str, k: int) -> Path:
        return self.faces_dir(track_id) / f"{int(k)}.png"

    # ---- 工具 ----
    def rel(self, p: Path) -> str:
        """相對於快取根的 POSIX 路徑（Rust cache_read 的 relPath）。"""
        return p.relative_to(self.root).as_posix()

    def ensure(self) -> "MediaCache":
        self.root.mkdir(parents=True, exist_ok=True)
        return self

    def status(self) -> dict[str, bool]:
        return {"probe": self.probe.is_file(), "index": self.index.is_file(), "shots": self.shots.is_file(), "proxy": self.proxy.is_file(), "thumbs": self.thumbs.is_dir()}


def media_cache(fingerprint: str) -> MediaCache:
    if not fingerprint or len(fingerprint) < 16 or not re.fullmatch(r"[0-9a-fA-F]+", fingerprint):
        raise ValueError(f"指紋必須是 ≥16 碼的十六進位字串：{fingerprint!r}")
    return MediaCache(env.media_cache_dir(fingerprint.lower()))


def fingerprint_for(path: str | Path) -> str:
    """媒體指紋（完整 64 碼 hex）。優先用 media/fingerprint.py（與 Rust 共用測試向量的正本）；沒有就用這裡的鏡像。"""
    try:
        from ..media import fingerprint as fp_mod  # type: ignore[import-not-found]

        for name in ("fingerprint", "media_fingerprint", "compute", "fingerprint_file"):
            fn = getattr(fp_mod, name, None)
            if callable(fn):
                return str(fn(str(path)))
    except Exception:  # noqa: BLE001  media 模組還沒有／介面不同 → 退回鏡像
        pass
    return fingerprint_fallback(path)


def fingerprint_fallback(path: str | Path) -> str:
    """blake3(size_le_u64 ‖ head=min(4 MiB,size) ‖ tail=4 MiB 只在 size>4 MiB) —— 逐位元鏡射 ai-music-cut ffmpeg.rs `fingerprint()`。

    不讀整檔：60 分鐘的來源可達數 GB，開檔就要等。前 16 碼 hex 是快取目錄名。
    """
    import blake3

    chunk = 4 * 1024 * 1024
    p = Path(path)
    size = p.stat().st_size
    h = blake3.blake3()
    h.update(size.to_bytes(8, "little", signed=False))
    with p.open("rb") as f:
        h.update(f.read(min(chunk, size)))
        if size > chunk:
            f.seek(size - chunk)
            h.update(f.read(chunk))
    return h.hexdigest()
