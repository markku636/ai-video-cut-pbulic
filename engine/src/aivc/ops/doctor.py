"""`aivc doctor` / op `env.doctor`：環境閘門（實作在 aivc.doctor）。"""
from __future__ import annotations

import argparse
from dataclasses import asdict
from typing import Any

from . import Ctx, register


def _args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--quick", action="store_true", help="略過 bf16 GEMM 煙霧測試")


@register("env.doctor", cli="doctor", help="環境閘門：Windows／Linux 要 torch +cu130＋CUDA（sm_XY、bf16 GEMM）；macOS 要 MPS；另檢查 cv2<5 與 ffmpeg", args=_args)
def doctor_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from .. import doctor

    quick = bool(args.get("quick"))
    r = doctor.run(quick=quick)
    d = asdict(r)
    d["ok"] = r.ok
    d["_exit_code"] = 0 if r.ok else 3
    d["_human"] = doctor.format_human(r)
    # 語音辨識（字幕）是選配：只附一個 asr 區段，**不進 problems、不影響 ok / exit code** —— 沒裝 faster-whisper 的人照樣能追蹤與輸出。
    # 區段本身出錯也吞掉（寫進 notes），閘門不能因為選配功能的探測失敗而變紅。
    try:
        from ..asr.doctor import asr_section

        asr = asr_section(probe_cuda=not quick)
    except Exception as e:  # noqa: BLE001
        asr = {"notes": [f"asr 檢查失敗：{type(e).__name__}: {e}"]}
    d["asr"] = asr
    d["_human"] += "\n" + _asr_human(asr)
    # 外掛（aivc.plugins）也只列出來，**不進 problems、不影響 ok / exit code**：壞掉的外掛不能讓核心的閘門變紅
    # （核心照常可用，只是外掛的功能不在；hello.loadErrors 也會告訴 App）。安裝腳本跑閘門時，log 裡看得到外掛有沒有載起來。
    pl = _plugins_section()
    d["plugins"] = pl
    d["_human"] += "\n" + _plugins_human(pl)
    return d


def _plugins_section() -> dict[str, Any]:
    try:
        from .. import plugins

        plugins.ensure_loaded()
        return {"loaded": [{"name": p.name, "module": p.module, "version": p.version, "source": p.source} for p in plugins.loaded()], "failed": plugins.failures()}
    except Exception as e:  # noqa: BLE001
        return {"loaded": [], "failed": {"?": f"外掛檢查失敗：{type(e).__name__}: {e}"}}


def _plugins_human(s: dict[str, Any]) -> str:
    loaded = s.get("loaded") or []
    head = "外掛  " + (" · ".join(f"{p['name']} {p.get('version') or '?'}" for p in loaded) if loaded else "（無）")
    return "\n".join([head, *(f"  - {msg}" for msg in (s.get("failed") or {}).values())])


def _asr_human(a: dict[str, Any]) -> str:
    fw, ct2 = a.get("fasterWhisper"), a.get("ctranslate2")
    head = f"語音辨識（選配）  faster-whisper {fw or '未安裝'} · ctranslate2 {ct2 or '未安裝'}"
    if a.get("cudaDevices") is not None and fw and ct2:
        head += f" · CUDA 裝置 {a.get('cudaDevices')} · cuBLAS 12 {'可載入' if a.get('cublas12') else ('不可載入' if a.get('cublas12') is False else '-')}"
    return "\n".join([head, *(f"  - {n}" for n in a.get("notes") or [])])
