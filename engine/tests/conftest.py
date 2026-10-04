"""pytest 共用：範例影片路徑（沒有就 skip）、GPU 標記、測試用的插入來源外掛。"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import pytest

from _sample import sample_path  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
SAMPLE = sample_path()
# 測試用的迷你外掛（fixtures/plugins/aivc_test_insert.py：通用貼圖插入來源）
FIXTURE_PLUGINS = Path(__file__).resolve().parent / "fixtures" / "plugins"


@pytest.fixture(scope="session")
def sample_video() -> Path:
    if not SAMPLE.is_file():
        pytest.skip(f"沒有範例影片 {SAMPLE}（gitignored，見 samples/README.md）")
    return SAMPLE


@pytest.fixture(scope="session")
def image_insert() -> Any:
    """載入測試外掛 aivc_test_insert（走真的 aivc.plugins.load_plugin）：核心本身沒有插入來源，渲染測試要有它才測得到合成。
    它只接手 track.extra 有 testInsert 的 track，整個 session 留著也不影響別的測試。"""
    if str(FIXTURE_PLUGINS) not in sys.path:
        sys.path.insert(0, str(FIXTURE_PLUGINS))
    from aivc import plugins

    info = plugins.load_plugin("aivc_test_insert")
    assert info is not None, plugins.failures()
    return info


def pytest_collection_modifyitems(config, items):  # noqa: ANN001
    if os.environ.get("AIVC_RUN_GPU_TESTS") == "1":
        return
    skip = pytest.mark.skip(reason="GPU 測試：設 AIVC_RUN_GPU_TESTS=1 才跑")
    for item in items:
        if "gpu" in item.keywords:
            item.add_marker(skip)
