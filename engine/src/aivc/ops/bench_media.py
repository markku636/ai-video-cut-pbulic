"""`aivc bench-frame-map`（op `bench.frame_map`）：proxy 第 k 幀真的是來源第 map[k] 幀嗎？（計畫 §11 量尺 frame-map）

抽樣 k → 解 proxy.mp4 第 k 幀 與 來源第 map[k] 幀（縮到 proxy 尺寸）比亮度 PSNR；門檻 40 dB（h264 有損，逐位元比不了）。
另外比鄰近來源幀 map[k]±1 的 PSNR：正確幀應該比鄰居高（靜止段鄰居也很像時標 ambiguous，不算失敗）。
固定納入 k=0、1、36、37（1.2 s 斷層兩端）、N−1，其餘用 --seed 決定。
"""
from __future__ import annotations

import argparse
import random
import time
from typing import Any

from . import Ctx, OpError, register
from .media import ensure_index, open_media, resolve_video


def _args(p: argparse.ArgumentParser) -> None:
    p.add_argument("video", help="來源影片（proxy 需先用 aivc proxy 產好）")
    p.add_argument("--samples", type=int, default=20, help="抽樣幀數（預設 20）")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--min-psnr", type=float, default=40.0, help="通過門檻 dB（預設 40）")


@register("bench.frame_map", cli="bench-frame-map", help="量尺：proxy 第 k 幀 == 來源第 map[k] 幀？（抽樣 PSNR ≥ 40 dB）", args=_args)
def bench_frame_map(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..media import cache as C
    from ..media import color
    from ..media.source import FrameSource

    video = resolve_video(args)
    mc, pr = open_media(video, ctx)
    idx, cfr, _ = ensure_index(video, mc, pr, ctx)
    meta = C.read_json(mc.proxy_json)
    if not meta or not mc.proxy_mp4.is_file():
        raise OpError("Invalid", "還沒有 proxy", hint=f'先跑 aivc proxy "{video}"')
    n = cfr.n_frames
    samples = max(1, int(args.get("samples") or 20))
    rng = random.Random(int(args.get("seed") or 0))
    fixed = [k for k in (0, 1, 36, 37, n - 1) if 0 <= k < n]
    pool = [k for k in range(n) if k not in fixed]
    ks = sorted(set(fixed + rng.sample(pool, max(0, min(samples - len(fixed), len(pool))))))
    min_psnr = float(args.get("min_psnr") or 40.0)
    pw, ph = int(meta["width"]), int(meta["height"])

    t0 = time.perf_counter()
    rows: list[dict[str, Any]] = []
    with FrameSource(mc.proxy_mp4, lru=4, ctx=ctx) as pfs, FrameSource(video, idx, cfr, probe=pr, lru=8, ctx=ctx) as sfs:
        proxy_n = pfs.n_frames  # 會完整解碼 proxy 一趟建索引
        for i, k in enumerate(ks):
            ctx.check_cancel()
            src = cfr.src_index(k)
            py = pfs.get(k).y
            cand = {}
            for d in (-1, 0, 1):
                j = src + d
                if 0 <= j < idx.n:
                    fr = sfs.get(j)
                    if (fr.width, fr.height) != (pw, ph):
                        fr = fr.resized(pw, ph)
                    cand[d] = color.psnr(py, fr.y)
            p0 = cand[0]
            others = [v for d, v in cand.items() if d != 0]
            best_other = max(others) if others else float("-inf")
            rows.append(
                {
                    "k": k,
                    "src": src,
                    "psnr": round(p0, 2) if p0 != float("inf") else "inf",
                    "psnrPrev": round(cand.get(-1, float("nan")), 2),
                    "psnrNext": round(cand.get(1, float("nan")), 2),
                    "ok": bool(p0 >= min_psnr),  # numpy.bool 不能 json.dumps
                    "ambiguous": bool(best_other >= min_psnr),  # 鄰居也過門檻（靜止段）→ 分不出來，不算失敗
                }
            )
            ctx.progress("bench", i + 1, len(ks))
    finite = [r["psnr"] for r in rows if isinstance(r["psnr"], float)]
    ok_frames = bool(proxy_n == n)
    ok_all = bool(all(r["ok"] for r in rows) and ok_frames)
    lines = [
        f"proxy 幀數 {proxy_n} vs N {n} → {'OK' if ok_frames else 'MISMATCH'}",
        f"抽樣 {len(rows)} 幀：PSNR min {min(finite) if finite else 'inf'} / mean {sum(finite) / len(finite) if finite else float('inf'):.2f} dB（門檻 {min_psnr}）→ {'PASS' if ok_all else 'FAIL'}",
    ]
    for r in rows:
        flag = "ok " if r["ok"] else "BAD"
        amb = " (鄰居也像)" if r["ambiguous"] else ""
        lines.append(f"  {flag} k={r['k']:<5} src={r['src']:<5} psnr={r['psnr']:>7} prev={r['psnrPrev']:>7} next={r['psnrNext']:>7}{amb}")
    return {
        "ok": ok_all,
        "proxyFrames": proxy_n,
        "expectedFrames": n,
        "minPsnr": min(finite) if finite else None,
        "meanPsnr": round(sum(finite) / len(finite), 3) if finite else None,
        "threshold": min_psnr,
        "samples": rows,
        "seconds": round(time.perf_counter() - t0, 3),
        "_exit_code": 0 if ok_all else 1,
        "_human": "\n".join(lines),
    }
