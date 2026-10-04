"""VFR→CFR 對應（純函式）與 PtsIndex 序列化。範例影片的實際數字在 test_media_sample.py。"""
from __future__ import annotations

from fractions import Fraction

import pytest

from aivc.media.cfr import CfrMap
from aivc.media.index import PtsIndex

FPS = (30, 1)


def _cumulative(gaps: list[float], start: float = 0.0) -> list[float]:
    out = [start]
    for g in gaps:
        out.append(out[-1] + g)
    return out


def test_regular_30fps_is_identity() -> None:
    pts = [i * 1000 / 30 for i in range(300)]
    m = CfrMap.from_index(pts, FPS)
    assert m.n_frames == 300 and m.n_source == 300
    assert m.to_list() == list(range(300))
    assert m.runs == ((0, 0, 300),)  # 1:1 段只要一筆
    assert m.duplicate_count == 0 and m.dropped_sources() == []
    assert m.fps == Fraction(30, 1)


def test_chrome_like_33_33_34_ms_is_identity() -> None:
    """Chrome 錄影用整數 ms：33/33/34 循環（平均 33.333）→ 漂移永遠 <半幀，不該有重複或丟幀。"""
    gaps = [33, 33, 34] * 100
    pts = _cumulative(gaps[:299], start=2.0)
    m = CfrMap.from_index(pts, FPS)
    assert m.n_frames == 300
    assert m.to_list() == list(range(300))


def test_1200ms_hole_after_two_frames_duplicates_src1_for_k1_to_k36() -> None:
    """範例的形狀：pts 2, 36, 1236, 1269, 1303, …（第 2 幀後斷 1.2 s）。"""
    # 尾段用真實錄影的 33/33/34 循環（平均恰 33.333 ms、不漂移；33/34 交錯平均 33.5 會每 200 幀漂出半幀→丟幀＋定格）
    # 起點取半整數避開「pts 恰等於取樣時刻」的撞點 —— 這個測試只驗證斷層的定格行為
    tail = _cumulative([33, 33, 34] * 40, start=1236.5)
    pts = [2.0, 36.0] + tail
    m = CfrMap.from_index(pts, FPS)
    lst = m.to_list()
    assert lst[0] == 0
    assert all(lst[k] == 1 for k in range(1, 37)), lst[:40]
    assert lst[37] == 2
    # 36 個 k 對到 src 1 → 至少 35 個重複幀；尾段 33/34 ms 交錯平均 33.5 ms 比 CFR 慢，
    # 121 幀要 121.4 格 → 尾端可能再多一格定格；不變式：N = 來源數 + 重複 − 丟幀，且不丟幀
    assert m.dropped_sources() == []
    assert m.duplicate_count >= 35
    assert m.n_frames == len(pts) + m.duplicate_count
    assert lst[37:117] == list(range(2, 82))  # 斷層之後 1:1（前 80 幀內不會累積到半幀）
    assert m.first_k_of_src(1) == 1 and m.first_k_of_src(2) == 37
    # runs 編碼：k0→src0、k1→src1 是 1:1 合成一筆 (0,0,2)；k2..k36 每個重複幀各一筆；k37 起 1:1
    assert m.runs[0] == (0, 0, 2)
    assert all(r[1] == 1 and r[2] == 1 for r in m.runs[1:35])
    assert m.runs[35][:2] == (36, 1) and m.runs[35][2] >= 2  # k36 顯示 src1，k37 起接 src2… 併在同一筆


def test_49ms_jitter_is_absorbed() -> None:
    """一個 49 ms 間隔只把後面全部平移 +15.67 ms（< 半幀 16.67）→ 仍 1:1、無重複無丟幀。"""
    gaps = [1000 / 30] * 99
    gaps[49] = 49.0
    pts = _cumulative(gaps)
    m = CfrMap.from_index(pts, FPS)
    assert m.n_frames == 100
    assert m.to_list() == list(range(100))
    assert m.duplicate_count == 0 and m.dropped_sources() == []


def test_60ms_jitter_makes_exactly_one_duplicate() -> None:
    """平移 26.67 ms（> 半幀）→ 那一格重複一幀、之後全體晚一格；沒有丟幀。"""
    gaps = [1000 / 30] * 99
    gaps[49] = 60.0
    pts = _cumulative(gaps)
    m = CfrMap.from_index(pts, FPS)
    assert m.n_frames == 101
    lst = m.to_list()
    assert m.duplicate_count == 1 and m.dropped_sources() == []
    assert lst[:50] == list(range(50))
    assert lst[50] == 49 and lst[51:] == list(range(50, 100))


def test_two_frames_in_one_slot_drops_the_earlier() -> None:
    pts = [0.0, 33.0, 38.0, 67.0, 100.0]
    m = CfrMap.from_index(pts, FPS)
    assert m.n_frames == 4
    assert m.to_list() == [0, 2, 3, 4]
    assert m.dropped_sources() == [1]
    assert m.first_k_of_src(1) is None
    assert m.duplicate_count == 0


def test_fraction_fps_and_single_frame() -> None:
    pts = [i * 1001 / 30 for i in range(50)]  # 29.97
    m = CfrMap.from_index(pts, (30000, 1001))
    assert m.n_frames == 50 and m.to_list() == list(range(50))
    m1 = CfrMap.from_index([123.0], FPS)
    assert m1.n_frames == 1 and m1.to_list() == [0]
    with pytest.raises(ValueError):
        CfrMap.from_index([], FPS)
    with pytest.raises(ValueError):
        CfrMap.from_index([0.0, 33.0], (0, 1))


def test_src_index_and_bounds() -> None:
    pts = [2.0, 36.0] + _cumulative([33, 34] * 10, start=1236.0)
    m = CfrMap.from_index(pts, FPS)
    for k in range(m.n_frames):
        assert m.src_index(k) == m.to_list()[k]
    with pytest.raises(IndexError):
        m.src_index(-1)
    with pytest.raises(IndexError):
        m.src_index(m.n_frames)


def test_json_roundtrip_and_validation() -> None:
    pts = [2.0, 36.0] + _cumulative([33, 34] * 10, start=1236.0)
    m = CfrMap.from_index(pts, FPS)
    d = m.to_json()
    assert d["version"] == 1 and d["fps"] == {"num": 30, "den": 1} and d["nFrames"] == m.n_frames
    assert d["runs"][0] == [0, 0, 2]  # k0→src0、k1→src1 是 1:1 段，合成一筆
    m2 = CfrMap.from_json(d)
    assert m2 == m and m2.to_list() == m.to_list()
    with pytest.raises(ValueError):
        CfrMap.from_runs(30, 1, 5, 5, [[0, 0, 2], [3, 2, 2]])  # k=2 沒人覆蓋
    with pytest.raises(ValueError):
        CfrMap.from_runs(30, 1, 5, 5, [[0, 0, 4]])  # 覆蓋 4 ≠ 5
    with pytest.raises(ValueError):
        CfrMap.from_json({**d, "version": 2})


# ---------------------------------------------------------------- PtsIndex
def test_index_sorts_bframe_reorder_and_keeps_key_flags() -> None:
    idx = PtsIndex.from_decoded([0.0, 100.0, 33.0, 67.0], [True, False, False, False], FPS)
    assert idx.pts_ms == [0.0, 33.0, 67.0, 100.0]
    assert idx.key == [True, False, False, False]
    idx2 = PtsIndex.from_decoded([100.0, 0.0], [False, True], FPS)
    assert idx2.key == [True, False]  # key 旗標跟著 pts 走
    with pytest.raises(ValueError):
        PtsIndex.from_decoded([0.0], [], FPS)


def test_index_json_roundtrip_gaps_ticks_keyframes() -> None:
    idx = PtsIndex(30, 1, [2.0, 36.0, 1236.0, 1269.0, 1303.0], [True, False, False, True, False], 1, 1000)
    d = idx.to_json()
    assert d == {
        "version": 1,
        "fps": {"num": 30, "den": 1},
        "n": 5,
        "pts_ms": [2, 36, 1236, 1269, 1303],  # 整數就寫整數，JSON 小一半
        "key": [True, False, False, True, False],
        "time_base": {"num": 1, "den": 1000},
    }
    back = PtsIndex.from_json(d)
    assert back == idx
    assert idx.gaps(40) == [{"src": 1, "pts_ms": 36.0, "gap_ms": 1200.0}]
    assert idx.pts_ticks(2) == 1236
    assert idx.keyframe_at_or_before(2) == 0 and idx.keyframe_at_or_before(4) == 3 and idx.keyframe_at_or_before(0) == 0
    assert idx.fps == Fraction(30, 1) and idx.time_base == Fraction(1, 1000)
    with pytest.raises(ValueError):
        PtsIndex.from_json({**d, "n": 4})
    with pytest.raises(ValueError):
        PtsIndex.from_json({**d, "version": 0})


def test_index_ticks_with_non_ms_time_base() -> None:
    idx = PtsIndex(30000, 1001, [0.0, 33.366666, 66.733333], [True, False, False], 1, 90000)
    assert idx.pts_ticks(1) == 3003 and idx.pts_ticks(2) == 6006
