"""兩條 worker lane 並行之後才成立的其他契約（B-06／B-05／B-10 的審查結論）。

- `ensure_index`：冷快取時兩條 lane 各解一次整支影片（70–136 s 做兩遍，而且輕量 lane 直接爆掉 App 的 60 s 逾時）。
- `geom.quad_from_mask`：主 lane 正在 `os.replace` masks.aivm 時，讀端的 OSError 要是 `Io`，不是 `Internal`。
- `snapshot_complete`：截斷的權重不算完整快取（不然 `aivc models pull` 說「已在快取」，SAM 照樣載不起來）。
- `_rgb8_executor`：`threads=` 不可以在行程裡留下一個過大的執行緒池。
"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from aivc.ops import OpError


class _Ctx:
    def progress(self, *a: Any, **k: Any) -> None: ...
    def log(self, *a: Any, **k: Any) -> None: ...
    def check_cancel(self) -> None: ...
    def artifact(self, *a: Any, **k: Any) -> None: ...


# ---------------------------------------------------------------- 索引只建一次


def test_two_lanes_build_the_index_only_once(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """render.run（主 lane）與 render.plan（輕量 lane）冷快取時同時進來：第二條要等第一條，不可以各解一次。"""
    from aivc.media import cache as C
    from aivc.media import index as I
    from aivc.ops import media as M

    mc = C.MediaCache(fingerprint="f" * 64, dir=tmp_path / "快取 目錄")
    mc.ensure()
    pr = type("Probe", (), {"fps_num": 30, "fps_den": 1})()
    builds: list[float] = []
    real_save = I.save_index

    def fake_build(video: str, ctx: Any, fps: Any = None) -> Any:
        builds.append(time.monotonic())
        time.sleep(0.4)  # 真的 build_index 是整支影片解一遍
        idx = type("Idx", (), {"n": 3, "fps_num": 30, "fps_den": 1, "pts_ms": [0.0, 33.3, 66.7]})()
        return idx

    saved: dict[str, Any] = {}

    def fake_save(path: Path, idx: Any, cfr: Any) -> Any:
        saved["idx"], saved["cfr"] = idx, cfr
        return real_save(path, idx, cfr) if False else path

    def fake_load(path: Path) -> Any:
        return (saved["idx"], None) if "idx" in saved else None

    monkeypatch.setattr(I, "build_index", fake_build)
    monkeypatch.setattr(I, "save_index", fake_save)
    monkeypatch.setattr(I, "load_index", fake_load)

    def run() -> tuple[Any, Any, bool]:
        return M.ensure_index("影片.mp4", mc, pr, _Ctx())

    with ThreadPoolExecutor(2) as ex:
        a, b = ex.submit(run), ex.submit(run)
        ra, rb = a.result(timeout=30), b.result(timeout=30)
    assert len(builds) == 1, f"兩條 lane 各解了一次（{len(builds)} 次）：keyed_lock 沒擋住"
    assert ra[0] is rb[0], "第二條要拿到第一條建好的索引"
    assert sorted((ra[2], rb[2])) == [False, True], "只有一條算「重建」"


# ---------------------------------------------------------------- 遮罩讀取的錯誤型別


def test_quad_from_mask_reports_unreadable_aivm_as_io(tmp_path: Path) -> None:
    from aivc.ops.track import quad_from_mask_op

    missing = tmp_path / "沒有這個.aivm"
    with pytest.raises(OpError) as e:
        quad_from_mask_op({"masks": str(missing), "frame": 0}, _Ctx())
    assert e.value.kind == "Io", f"要是 Io 不是 Internal：{e.value.kind}"

    broken = tmp_path / "半寫的.aivm"
    broken.write_bytes(b"AIVM" + b"\x00" * 8)
    with pytest.raises(OpError) as e2:
        quad_from_mask_op({"masks": str(broken), "frame": 0}, _Ctx())
    assert e2.value.kind == "Io", f"要是 Io 不是 Internal：{e2.value.kind}"


# ---------------------------------------------------------------- B-05：截斷的權重不算完整快取


def test_truncated_safetensors_is_not_a_complete_snapshot(tmp_path: Path) -> None:
    """只看「不是 0 bytes」的話：`aivc models pull` 印「已在快取」什麼也不做，SAM 每次都在同一個地方失敗，
    使用者照著提示做沒有任何幫助（只有 `--force` 救得回來，而那從來沒出現在錯誤訊息裡）。"""
    from aivc.ops.models import REQUIRED_FILES, snapshot_complete

    d = tmp_path / "snapshot"
    d.mkdir()
    for f in REQUIRED_FILES:
        (d / f).write_text("{}", encoding="utf-8")
    w = d / "model.safetensors"

    header = b'{"__metadata__":{}}'
    w.write_bytes(len(header).to_bytes(8, "little") + header + b"\x00" * 4096)
    assert snapshot_complete(d) is True, "完整的權重要算完整"

    w.write_bytes(w.read_bytes()[:16])  # 下載中斷／磁碟滿
    assert snapshot_complete(d) is False, "截斷的權重不是「有快取」"

    w.write_bytes(b"\x00" * 64)  # header 長度 0
    assert snapshot_complete(d) is False

    w.write_bytes(b"x")  # 比 8 bytes 還短
    assert snapshot_complete(d) is False

    w.unlink()
    assert snapshot_complete(d) is False, "完全沒有權重當然不算"


def test_sam_load_hint_points_at_force_when_a_snapshot_exists(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.seg import sam2_hf

    monkeypatch.setenv("HF_HOME", str(tmp_path))
    monkeypatch.setenv("HF_HUB_CACHE", str(tmp_path / "hub"))
    model_id = sam2_hf.MODEL_IDS["small"]
    assert "--force" not in sam2_hf._load_hint(model_id), "沒有快取時「下載」才是答案"
    (tmp_path / "hub" / f"models--{model_id.replace('/', '--')}").mkdir(parents=True)
    hint = sam2_hf._load_hint(model_id)
    assert "--force" in hint and "models pull" in hint, hint


# ---------------------------------------------------------------- B-10：執行緒池不能被養大


def test_rgb8_pool_is_capped_and_recycled(monkeypatch: pytest.MonkeyPatch) -> None:
    """`threads=10000` 在 720 列的畫面上曾經開出 720 條執行緒，而且之後的預設呼叫會沿用那個過大的池。
    切幾條不變（所以輸出仍逐位元相同），只有同時跑的條數有上限。"""
    from aivc.media import color

    monkeypatch.setattr(color, "_rgb8_pool", None, raising=False)
    monkeypatch.delenv(color.RGB8_THREADS_ENV, raising=False)
    h, w = 64, 64
    y = np.random.default_rng(7).integers(0, 256, (h, w), dtype=np.uint8)
    u = np.random.default_rng(8).integers(0, 256, ((h + 1) // 2, (w + 1) // 2), dtype=np.uint8)
    v = np.random.default_rng(9).integers(0, 256, ((h + 1) // 2, (w + 1) // 2), dtype=np.uint8)

    ref = color.yuv420_to_rgb8_fast(y, u, v, threads=1)
    before = threading.active_count()
    got = color.yuv420_to_rgb8_fast(y, u, v, threads=10000)
    assert np.array_equal(ref, got), "夾住 worker 數不可以改變輸出"
    pool = color._rgb8_pool
    assert pool is not None and pool[1] <= max(color._RGB8_MAX_THREADS, color.rgb8_threads())
    assert threading.active_count() - before <= color._RGB8_MAX_THREADS + 2, f"開了太多執行緒：{threading.active_count() - before}"
