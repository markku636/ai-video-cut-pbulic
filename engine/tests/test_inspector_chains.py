"""Inspector「片段」頁的數字 == 輸出計畫的鏈參數（設計 docs/editor-m2-design.md §13 M2.15「Inspector 的數值與 plan 一致」）。

`fixtures/sequence/inspector-chains.json` 的 project 是輸入、expected 是 `media/audio_graph.build` 算出來的每個片段的鏈
（inUs／outUs／L／delay／leadPad／靜態增益），null = 不進混音。TS 端 `src/inspector/clipFacts.test.ts` 讀同一份 —— 做法同
`fixtures/sequence/map-cases.json`：兩邊各一份實作，公式改了其中一邊，兩邊的測試一起紅。

案例涵蓋：音訊比影片晚 6.5 ms 開始（startUs ≠ videoStartUs）、入點早於串流起點（leadPad）、入點落在 pts 斷層裡、
原音推桿、整條同值的自動化（併進靜態增益）、會變的自動化、停用片段、已分離的原音與分離出來的片段（srcIn 為負）、
44.1 kHz mp3（LAME 延遲 25 057 µs）、靜音軌、在序列結尾之後的片段。

重產 expected：`PYTHONPATH=engine/src python engine/tests/test_inspector_chains.py --write`。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from aivc.media import audio_graph as AG
from aivc.project import schema as S

REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / "fixtures" / "sequence" / "inspector-chains.json"
CHAIN_KEYS = ("inUs", "outUs", "length", "delay", "leadPad", "gainDb")


def _load() -> tuple[dict[str, Any], S.ProjectFile]:
    doc = json.loads(FIXTURE.read_text(encoding="utf-8"))
    r = S.loads(json.dumps(doc["project"], ensure_ascii=False))
    return doc, r.project


def compute(project: S.ProjectFile) -> dict[str, dict[str, Any] | None]:
    seq = project.sequence
    assert seq is not None
    g = AG.build(seq, project)
    by_clip = {c.clip_id: c for c in g.chains}
    ids = [it.id for it in seq.video if isinstance(it, S.VideoClipV2)] + [c.id for lane in seq.audio_lanes for c in lane.clips]
    out: dict[str, dict[str, Any] | None] = {}
    for cid in ids:
        c = by_clip.get(cid)
        out[cid] = None if c is None else {**{k: c.to_json()[k] for k in CHAIN_KEYS}, "envMaxDb": c.env_max_db}
    return out


def test_fixture_is_loaded_without_drops() -> None:
    doc, project = _load()
    seq = project.sequence
    assert seq is not None
    # sanitize 沒有丟掉任何片段（丟了的話 TS 那邊算的是另一份序列）
    assert len(seq.video) == len(doc["project"]["sequence"]["video"])
    assert sum(len(lane.clips) for lane in seq.audio_lanes) == sum(len(lane["clips"]) for lane in doc["project"]["sequence"]["audioLanes"])


def test_expected_chains_match_audio_graph() -> None:
    doc, project = _load()
    assert doc["expected"] == compute(project)


def test_cases_cover_the_interesting_parts() -> None:
    doc, _ = _load()
    exp = doc["expected"]
    # 音訊晚 6.5 ms：影片入點 60 → 容器 2 000 000 µs；片段 c3 從 k=0 開始 → 前面補 312 個樣本的靜音
    assert exp["c1"]["inUs"] == 2_000_000 and exp["c1"]["leadPad"] == 0
    assert exp["c3"]["inUs"] == 0 and exp["c3"]["leadPad"] == 312
    # 入點落在 40.0～41.2 s 的斷層裡：聲音在 41.2 s 才恢復
    assert exp["c4"]["inUs"] == 41_000_000 and exp["c4"]["leadPad"] == 9_600
    # 原音推桿 −1.5 + 片段 −3 + 整條 −2 的自動化 = −6.5
    assert exp["c2"]["gainDb"] == -6.5
    assert exp["c5"] is None and exp["c6"] is None  # 停用、已分離
    assert exp["d1"]["leadPad"] == 312  # 分離出來的片段 srcIn = −312
    assert exp["a1"]["inUs"] == 2_025_057 and exp["a1"]["gainDb"] == -14.0
    assert exp["a2"] is None and exp["a3"] is None and exp["a4"] is None  # 停用、靜音軌、在序列結尾之後


if __name__ == "__main__":
    if "--write" in sys.argv:
        doc, project = _load()
        doc["expected"] = compute(project)
        FIXTURE.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(doc["expected"], ensure_ascii=False, indent=2))
