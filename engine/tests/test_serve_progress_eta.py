"""B-14：progress 的 `eta_s` 必須從**這個 stage 的起點**外推，不是從整個 job 的起點。

修正前（2026-09-18 實測，一支 60 s 參考片段的物件偵測，AIVC_CACHE_DIR 用暫存目錄）：
`track` 的第一筆 2/836 回 eta_s=11213.5 s，這個階段實際只跑 39.9 s；`seg` 的 1/209 回 1641.3 s（實際 18.6 s）。
原因是 `ServeCtx._started` 是 job 開始的時間，前面 stage 花掉的秒數全被算進「每單位進度的成本」。
修正後同一條片子：seg 2% 那筆 18.2 s（實際還要 19.2 s）、track 2% 那筆 62.3 s（實際還要 52.0 s）。
"""
from __future__ import annotations

import io
import json
import time

from aivc.serve import Job, ServeCtx, Server

ALPHA_S = 2.0  # 前一個 stage 佔掉的時間
BETA_GAP_S = 0.3  # 後一個 stage 兩筆之間的時間


def _events(out: io.BytesIO) -> list[dict]:
    return [json.loads(line) for line in out.getvalue().decode("utf-8").splitlines() if line.strip()]


def test_eta_is_per_stage_not_from_job_start() -> None:
    out = io.BytesIO()
    srv = Server(io.BytesIO(), out, io.StringIO(), torch_probe=False)
    ctx = ServeCtx(srv, Job("j1", "pipeline.run", {}))

    # 第一個 stage：慢慢跑掉 2 秒（節流器 250 ms，所以每筆都送得出去）
    for i in range(1, 9):
        ctx.progress("alpha", i, 10)
        time.sleep(ALPHA_S / 8)
    # 第二個 stage：0.3 秒內從 1/100 衝到 50/100
    ctx.progress("beta", 1, 100)
    time.sleep(BETA_GAP_S)
    ctx.progress("beta", 50, 100)

    beta = [e for e in _events(out) if e.get("stage") == "beta"]
    assert len(beta) == 2, beta
    # 這個 stage 還沒有任何進展時不送 eta（寧可不顯示也不要騙人）
    assert "eta_s" not in beta[0], beta[0]
    eta = beta[1]["eta_s"]
    # 只看 beta 自己：0.3 秒走了 49 格，剩 50 格 → 約 0.31 s。
    # 從 job 起點算的話分母是 2.3 秒 / 50 格 → 約 2.3 s，落在斷言外面。
    assert 0.1 <= eta <= 1.0, f"eta_s={eta} 看起來還是從 job 起點算的（前一個 stage 的 {ALPHA_S}s 被算進去）"

    alpha = [e for e in _events(out) if e.get("stage") == "alpha"]
    assert "eta_s" not in alpha[0]
    assert alpha[-1]["eta_s"] > 0  # 同一個 stage 內照樣有估計值


def test_progress_reporter_eta_still_wins() -> None:
    """ops 自己用 ProgressReporter 算好的 eta_s（走 extra）不能被覆寫。"""
    out = io.BytesIO()
    srv = Server(io.BytesIO(), out, io.StringIO(), torch_probe=False)
    ctx = ServeCtx(srv, Job("j2", "render.run", {}))
    ctx.progress("encode", 1, 100, eta_s=12.5)
    time.sleep(0.3)
    ctx.progress("encode", 50, 100, eta_s=3.25)
    evs = [e for e in _events(out) if e.get("stage") == "encode"]
    assert [e["eta_s"] for e in evs] == [12.5, 3.25]
