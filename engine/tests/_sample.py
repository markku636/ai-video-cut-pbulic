"""參考片段在哪（gitignored 的第三方素材，見 samples/README.md）。

找的順序：`AIVC_SAMPLE_VIDEO`（例如 worktree 指回主 repo 那一份）→ `samples/sample_clip1.webm` →
`samples/` 裡第一支 `.webm`（檔名不限，放一支就好）。都沒有就回 `samples/sample_clip1.webm`，呼叫端看 is_file() 決定 skip。
"""
from __future__ import annotations

import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SAMPLES = REPO / "samples"
DEFAULT_SAMPLE = SAMPLES / "sample_clip1.webm"


def sample_path() -> Path:
    env = os.environ.get("AIVC_SAMPLE_VIDEO")
    if env:
        return Path(env)
    if DEFAULT_SAMPLE.is_file():
        return DEFAULT_SAMPLE
    found = sorted(SAMPLES.glob("*.webm")) if SAMPLES.is_dir() else []
    return found[0] if found else DEFAULT_SAMPLE
