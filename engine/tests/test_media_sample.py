"""範例影片的硬數字（計畫 §2 / §5.1）：1762 幀、18 關鍵幀、N=1797、k=1..36→src 1、切點 2.0/30.9/45.3 s、隨機存取＝順序。"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from aivc.media import index as I
from aivc.media import probe as P
from aivc.media import shots as SH
from aivc.media.cfr import CfrMap
from aivc.media.source import FrameSource

EXPECT_N_SOURCE = 1762
EXPECT_KEYFRAMES = 18
EXPECT_N_PROXY = 1797
EXPECT_CUTS_S = (2.0, 30.9, 45.3)


@pytest.fixture(scope="module")
def sample_index(sample_video: Path) -> I.PtsIndex:
    return I.build_index(sample_video)


@pytest.fixture(scope="module")
def sample_cfr(sample_index: I.PtsIndex) -> CfrMap:
    return CfrMap.from_index(sample_index.pts_ms, (sample_index.fps_num, sample_index.fps_den))


def test_index_facts(sample_index: I.PtsIndex) -> None:
    idx = sample_index
    assert idx.n == EXPECT_N_SOURCE
    assert sum(idx.key) == EXPECT_KEYFRAMES and idx.key[0]
    assert (idx.fps_num, idx.fps_den) == (30, 1) and (idx.time_base_num, idx.time_base_den) == (1, 1000)
    assert idx.pts_ms[0] == 2.0 and idx.pts_ms[-1] == 59885.0
    assert idx.pts_ms == sorted(idx.pts_ms)
    gaps = idx.gaps(40)
    assert [(g["src"], g["gap_ms"]) for g in gaps] == [(1, 1200.0), (116, 49.0)]
    assert gaps[1]["pts_ms"] == 5036.0  # 5.085 s 之前那幀
    deltas = np.diff(np.array(idx.pts_ms))
    assert set(np.unique(deltas).tolist()) == {33.0, 34.0, 49.0, 1200.0}


def test_cfr_facts(sample_cfr: CfrMap) -> None:
    m = sample_cfr
    assert m.n_frames == EXPECT_N_PROXY and m.n_source == EXPECT_N_SOURCE
    lst = m.to_list()
    assert lst[0] == 0
    assert all(lst[k] == 1 for k in range(1, 37)) and lst[37] == 2  # 1.2 s 斷層 → 36 個 k 顯示 src 1
    assert m.duplicate_count == 35  # = N − n_source：其餘全部 1:1
    assert m.dropped_sources() == []  # 49 ms 抖動被吸收，沒有丟幀（計畫「5.085 s 一個重複」實測不成立）
    assert lst[37:] == list(range(2, EXPECT_N_SOURCE))
    assert len(m.runs) <= 40  # (0,0,2) + 34 筆單幀重複 + (36,1,…) 一路 1:1 → 36 筆；編碼細節不釘死
    assert m.first_k_of_src(1) == 1 and m.first_k_of_src(2) == 37 and m.first_k_of_src(1761) == 1796


def test_index_save_load_roundtrip(tmp_path: Path, sample_index: I.PtsIndex, sample_cfr: CfrMap) -> None:
    p = tmp_path / "index.v1.json"
    I.save_index(p, sample_index, sample_cfr)
    loaded = I.load_index(p)
    assert loaded is not None
    idx2, cfr_json = loaded
    assert idx2 == sample_index
    assert CfrMap.from_json(cfr_json) == sample_cfr
    assert p.stat().st_size < 40_000  # 1762 幀的索引要小（Rust/TS 讀得快）


def test_random_access_equals_sequential(sample_video: Path, sample_index: I.PtsIndex, sample_cfr: CfrMap) -> None:
    pr = P.probe(sample_video)
    ref: dict[int, np.ndarray] = {}
    with FrameSource(sample_video, sample_index, sample_cfr, probe=pr, lru=4) as seq:
        for fr in seq.iter_frames(470, 530):
            ref[fr.src_idx] = fr.y.copy()
        assert seq.stats["seeks"] == 1
    with FrameSource(sample_video, sample_index, sample_cfr, probe=pr, lru=8) as rnd:
        for target in (500, 480, 529, 470, 505, 504):  # 往回、跨關鍵幀、LRU 命中
            fr = rnd.get(target)
            assert fr.src_idx == target
            assert np.array_equal(fr.y, ref[target]), target
        assert rnd.stats["lru_hits"] >= 0
        k404 = rnd.get(404)
        assert k404.key and sample_index.key[404]
        assert rnd.get(1761).src_idx == 1761 and rnd.get(0).src_idx == 0
        with pytest.raises(IndexError):
            rnd.get(1762)
        assert rnd.get_proxy_frame(20).src_idx == 1 and rnd.get_proxy_frame(37).src_idx == 2
        fr = rnd.get(0)
        assert fr.width == 1280 and fr.height == 720 and fr.u.shape == (360, 640)
        assert fr.matrix == "bt709" and fr.color_range == "tv"
        assert fr.y.flags["C_CONTIGUOUS"] and len(fr.to_bytes()) == 1280 * 720 * 3 // 2
        small = fr.resized(640, 360)
        assert small.y.shape == (360, 640) and small.u.shape == (180, 320)


def test_shots_find_the_three_cuts(sample_video: Path, sample_index: I.PtsIndex, sample_cfr: CfrMap) -> None:
    pr = P.probe(sample_video)
    with FrameSource(sample_video, sample_index, sample_cfr, probe=pr, lru=4) as fs:
        shots, cuts = SH.detect_shots(fs.iter_frames(), sample_cfr, total=sample_index.n)
    fps = float(sample_cfr.fps)
    got_s = [c["k"] / fps for c in cuts]
    assert len(cuts) == 3, cuts
    for want, got in zip(EXPECT_CUTS_S, got_s):
        assert abs(want - got) < 0.1, (want, got)
    assert all(c["score"] > 0.29 for c in cuts)  # 實測 0.30–0.36
    assert [s.startFrame for s in shots] == [0, *[c["k"] for c in cuts]]
    assert shots[-1].endFrame == sample_cfr.n_frames
    for a, b in zip(shots, shots[1:]):
        assert a.endFrame == b.startFrame
    assert all(s.kind == "unknown" and s.source == "auto" for s in shots)
    assert [s.id for s in shots] == ["shot1", "shot2", "shot3", "shot4"]
    # 門檻 0.3（計畫值）會漏 45.3 s 那刀 —— 記錄這個事實，避免有人改回去
    with FrameSource(sample_video, sample_index, sample_cfr, probe=pr, lru=4) as fs:
        _, cuts03 = SH.detect_shots(fs.iter_frames(), sample_cfr, threshold=0.3)
    assert len(cuts03) <= 3


def test_shots_from_cuts_merges_short_tail() -> None:
    shots = SH.shots_from_cuts([{"k": 60}, {"k": 926}, {"k": 1790}], 1797, min_len=12)
    assert [(s.startFrame, s.endFrame) for s in shots] == [(0, 60), (60, 926), (926, 1797)]
    shots = SH.shots_from_cuts([], 100)
    assert [(s.startFrame, s.endFrame) for s in shots] == [(0, 100)]
    assert SH.cut_score(30.0, 0.0) == 0.3 and SH.cut_score(30.0, 25.0) == 0.05 and SH.cut_score(500.0, 0.0) == 1.0
