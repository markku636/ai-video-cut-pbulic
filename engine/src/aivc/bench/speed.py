"""bench speed 的純函式：`aivc run` 的結果 JSON → 時間／VRAM 門檻（計畫 §11：60 s 全片 < 5 min、峰值 VRAM < 12 GB）。

輸入接受三種形狀（都是 ops/run.py 寫出來的）：
- `aivc --json run …` 的 stdout（JSONL：事件一行一筆，最後一行 `{"id":"cli","ok":…,"result":{…}}`）→ 取最後一行的 result；
- 單一 JSON 物件 `{"id","ok","result":{…}}` → result；
- result 本體（有 `timings` 的 dict）。
專案檔 *.aivc.json **沒有** timings（run 不寫進去），給專案檔會被拒絕並提示。

門檻依片長等比：limit = max_seconds × (duration / ref_seconds)。片長 = frames / fps（fps 由 op 從專案檔或 --fps 取得）；
沒有 fps 就用 max_seconds 原值並在 notes 註明。VRAM 沒數字（CPU 跑、或沒裝 torch）不算失敗，但 `vramKnown=false`。
"""
from __future__ import annotations

import json
from typing import Any

DEFAULT_MAX_SECONDS = 300.0
DEFAULT_MAX_VRAM_MB = 12288.0
REF_SECONDS = 60.0


def extract_result(obj: Any) -> dict[str, Any]:
    if isinstance(obj, dict) and isinstance(obj.get("result"), dict):
        return obj["result"]
    if isinstance(obj, dict):
        return obj
    raise ValueError("JSON 不是物件")


def load_run_result(text: str) -> dict[str, Any]:
    """整份 JSON 或 JSONL 最後一行 → result dict。"""
    s = text.strip()
    if not s:
        raise ValueError("檔案是空的")
    try:
        return extract_result(json.loads(s))
    except json.JSONDecodeError:
        pass
    lines = [ln for ln in s.splitlines() if ln.strip()]
    for ln in reversed(lines):  # 最後一個含 result 的 JSON 行
        try:
            obj = json.loads(ln)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and isinstance(obj.get("result"), dict):
            return obj["result"]
    raise ValueError("找不到含 result 的 JSON 行（這不是 aivc --json run 的輸出？）")


def check_speed(
    result: dict[str, Any],
    *,
    max_seconds: float = DEFAULT_MAX_SECONDS,
    max_vram_mb: float = DEFAULT_MAX_VRAM_MB,
    ref_seconds: float = REF_SECONDS,
    duration_s: float | None = None,
    fps: float | None = None,
) -> dict[str, Any]:
    timings = result.get("timings")
    if not isinstance(timings, dict) or not timings:
        if "schemaVersion" in result:
            raise ValueError("這是專案檔（*.aivc.json），沒有 timings；請給 aivc --json run 的輸出（JSONL）")
        raise ValueError("結果裡沒有 timings 區塊（不是 aivc run 的結果？）")
    stages = {k: float(v) for k, v in timings.items() if k != "total" and isinstance(v, (int, float))}
    total = float(timings["total"]) if isinstance(timings.get("total"), (int, float)) else sum(stages.values())
    gpu = result.get("gpu") if isinstance(result.get("gpu"), dict) else {}
    vram = gpu.get("maxMemoryAllocatedMB")
    vram = float(vram) if isinstance(vram, (int, float)) else None
    frames = result.get("frames") if isinstance(result.get("frames"), int) else None
    notes: list[str] = []
    if duration_s is None and frames is not None and fps:
        duration_s = frames / float(fps)
    if duration_s is None:
        notes.append(f"不知道片長（沒有 fps）：門檻用 {max_seconds:g} s 原值，不依片長等比")
        limit = float(max_seconds)
    else:
        limit = float(max_seconds) * (float(duration_s) / float(ref_seconds))
    shots = result.get("shots")
    if isinstance(shots, list) and len(shots) == 1:
        notes.append("結果只處理了 1 個鏡頭（--shot）：時間不是全片的數字，render 仍寫出全部幀")
    ok_time = total < limit
    ok_vram = True if vram is None else vram < float(max_vram_mb)
    if vram is None:
        notes.append("沒有 GPU 峰值記憶體數字（CPU 跑或 torch 不可用）：VRAM 門檻略過")
    slowest = sorted(stages.items(), key=lambda kv: -kv[1])[:3]
    return {
        "ok": bool(ok_time and ok_vram),
        "totalSeconds": total,
        "limitSeconds": limit,
        "durationSeconds": duration_s,
        "frames": frames,
        "stages": stages,
        "slowest": [{"stage": k, "seconds": v} for k, v in slowest],
        "peakVramMB": vram,
        "vramKnown": vram is not None,
        "checks": {"time": bool(ok_time), "vram": None if vram is None else bool(ok_vram)},
        "threshold": {"maxSeconds": float(max_seconds), "refSeconds": float(ref_seconds), "maxVramMB": float(max_vram_mb)},
        "notes": notes,
        "failures": ([f"總時間 {total:.1f} s ≥ 門檻 {limit:.1f} s"] if not ok_time else []) + ([f"峰值 VRAM {vram:.0f} MB ≥ 門檻 {max_vram_mb:.0f} MB"] if vram is not None and not ok_vram else []),
    }
