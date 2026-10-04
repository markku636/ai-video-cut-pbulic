"""量尺 op（計畫 §11、§10 E1 DoD 3–8）：`aivc bench-outside | bench-jitter | bench-corners | bench-speed`。
純數學在 `aivc/bench/*.py`，這裡只做 I/O 與組裝。外掛可以用同一組共用參數／開檔函式加自己的量尺
（例：牌局外掛的 bench-verify、bench-whitespecks、label-auto）。

結果／退出碼約定（與 ops/bench_media.py 的 `bench.frame_map` 相同）：
- 量尺**永遠回傳完整 JSON 結果**（`--json` 時最後一行 `{"id":"cli","ok":…,"result":{…}}`），數字全部在 result 裡；
  門檻沒過 → `result.ok == false`、CLI 退出碼 **1**（靠 `_exit_code`），**不擲例外**——失敗的數字就是量尺的產出，要看得到。
- 輸入本身不合法（沒有 render 檔、幀數對不上、labels 格式錯、專案缺 solve）→ `OpError("Invalid"|"Model", …)`，退出碼 2／4。
- 每個結果都帶 `threshold`（用了哪些門檻）與 `failures`（失敗清單，最多 --max-list 筆；完整逐幀數字在 rows/frames）。

| op | CLI | 門檻（計畫 §11） |
|---|---|---|
| bench.outside | bench-outside | 無損渲染（ffv1…）：排除區外三平面逐位元相同；有損：排除區外合併 PSNR ≥ 45 dB（--min-psnr） |
| bench.jitter  | bench-jitter  | STATIC 段四角二階差分 max == 0（std == 0）；TRACKING 段平滑前／後只記錄 |
| bench.corners | bench-corners | TRACKING+STATIC p@5 ≥ 0.90、p@15 ≥ 0.98；STATIC 平均 ≤ 1.0 px；遠景 p@(4% 平面長邊) ≥ 0.90 |
| bench.speed   | bench-speed   | 總時間 < 300 s × (片長/60 s)、峰值 VRAM < 12288 MB |
`bench.frame_map`（`aivc bench-frame-map`）已在 ops/bench_media.py，這裡不重複註冊。

輸出幀 ↔ 來源幀：渲染輸出第 j 幀 = proxy 第 k=j+offset 幀 = 來源第 map[k] 幀（CfrMap；render 每個 k 寫一幀、定格重送）。
輸出幀數 == N → offset 0；`--range K0:K1` 且輸出幀數 == K1−K0（`render --trim`）→ offset K0；其他幀數 → Invalid。
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

import numpy as np

from .. import env
from . import Ctx, OpError, register

if TYPE_CHECKING:
    from ..media.source import FrameSource
    from ..project import schema as S
    from ..project.resolve import MediaContext
    from ..track.state import Solve

DEFAULT_MIN_PSNR = 45.0
DEFAULT_DILATE_PX = 3
DEFAULT_MAX_LIST = 20


# ---------------------------------------------------------------- 共用參數 / 開檔


def _arg_project(p: argparse.ArgumentParser) -> None:
    p.add_argument("project", help="專案檔 *.aivc.json")
    p.add_argument("--media", default=None)
    p.add_argument("--track", action="append", default=None, help="只量這些 track（可重複；預設全部）")
    p.add_argument("--max-list", type=int, default=DEFAULT_MAX_LIST, help=f"failures 最多列幾筆（預設 {DEFAULT_MAX_LIST}）")


def _arg_render(p: argparse.ArgumentParser) -> None:
    p.add_argument("--render", required=True, metavar="OUT", help="aivc render 的輸出檔")
    p.add_argument("--range", default=None, metavar="K0:K1", help="只比對這段 proxy 幀；輸出若是 --trim 的結果幀數要等於 K1−K0")
    p.add_argument("--every", type=int, default=1, help="每 N 幀取一幀（預設 1 = 全部）")


def _open_project(args: dict[str, Any], ctx: Ctx) -> "MediaContext":
    from ..project import resolve as R

    return R.open_media_context(env.normalize_path(str(args["project"])), args.get("media"), ctx)


def _open_render(out_arg: str, mctx: "MediaContext", rng: tuple[int, int] | None, ctx: Ctx) -> tuple["FrameSource", Any, int, tuple[int, int]]:
    """渲染輸出 → (FrameSource, Probe, offset, (k_lo, k_hi))。會完整解碼一趟建索引（幀數真相）。"""
    from ..bench import common as C
    from ..media.probe import probe as probe_fn
    from ..media.source import FrameSource

    out = env.normalize_path(os.path.abspath(str(out_arg)))
    if not os.path.isfile(out):
        raise OpError("Invalid", f"找不到渲染輸出：{out}", "先跑 aivc render <project> -o OUT，再 --render OUT")
    try:
        pr = probe_fn(out)
    except Exception as e:  # noqa: BLE001
        raise OpError("Invalid", f"渲染輸出不是可解碼的影片：{e}") from e
    W, H = mctx.size
    if (int(pr.width), int(pr.height)) != (W, H):
        raise OpError("Invalid", f"渲染輸出 {pr.width}x{pr.height} 與專案影片 {W}x{H} 尺寸不同")
    fs = FrameSource(out, probe=pr, lru=4, ctx=ctx)
    try:
        n_out = fs.n_frames
        offset, k_range = C.output_frame_offset(n_out, mctx.n_frames, rng)
    except ValueError as e:
        fs.close()
        raise OpError("Invalid", str(e), "確認 --render 是這個專案渲染出來的；--trim 的輸出要帶同樣的 --range") from e
    except Exception as e:  # noqa: BLE001
        fs.close()
        raise OpError("Invalid", f"渲染輸出解碼失敗：{e}") from e
    return fs, pr, offset, k_range


def _select_tracks(mctx: "MediaContext", ids: list[str] | None) -> list["S.TrackV1"]:
    from ..project import resolve as R

    return R.select_tracks(mctx.project, mctx.media_id, ids)


def _load_solve(mctx: "MediaContext", track_id: str) -> "Solve | None":
    from ..project import resolve as R

    return R.load_solve(mctx.cache, track_id)


def _load_hud(mctx: "MediaContext", track_id: str) -> dict[int, dict[str, Any]] | None:
    """solve.hud.v1.json → {k: row}；沒有／壞掉回 None（HUD 只是輔助資訊）。"""
    p = mctx.cache.solve(track_id).with_name("solve.hud.v1.json")
    if not p.is_file():
        return None
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return {int(r["k"]): r for r in d.get("frames", [])}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def _iter_ks(k_range: tuple[int, int], every: int) -> range:
    return range(k_range[0], k_range[1], max(1, int(every)))


def _finish(result: dict[str, Any], ok: bool, human: str, t0: float) -> dict[str, Any]:
    from ..bench.common import jsonable

    out = jsonable(result)
    out["ok"] = bool(ok)
    out["seconds"] = round(time.perf_counter() - t0, 3)
    out["_exit_code"] = 0 if ok else 1
    out["_human"] = human
    return out


# ================================================================ bench.outside


def _outside_args(p: argparse.ArgumentParser) -> None:
    _arg_project(p)
    _arg_render(p)
    p.add_argument("--dilate", type=int, default=DEFAULT_DILATE_PX, help=f"排除區膨脹 px（預設 {DEFAULT_DILATE_PX}）")
    p.add_argument("--min-psnr", type=float, default=DEFAULT_MIN_PSNR, help=f"有損渲染的門檻 dB（預設 {DEFAULT_MIN_PSNR}）")
    p.add_argument("--matte", default=None, metavar="DIR", help="render --emit-matte 的目錄：用真正的 alpha 當排除區（預設用 遮罩 ∪ 四角足跡）")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--lossless", dest="lossless", action="store_true", default=None, help="強制當無損（逐位元相同）")
    g.add_argument("--lossy", dest="lossless", action="store_false", help="強制當有損（PSNR 門檻）")


@register("bench.outside", cli="bench-outside", help="量尺：渲染輸出在所有 track 的膨脹 alpha 區外，與來源逐位元相同（無損）／PSNR ≥ 45 dB（有損）？", args=_outside_args)
def bench_outside(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..bench import common as C
    from ..bench import outside as BO
    from ..geom import homography as hg
    from ..media.source import FrameSource
    from ..project import resolve as R
    from .render import parse_range

    t0 = time.perf_counter()
    mctx = _open_project(args, ctx)
    W, H = mctx.size
    rng = parse_range(args.get("range"), mctx.n_frames)
    fs_out, pr_out, offset, k_range = _open_render(str(args["render"]), mctx, rng, ctx)
    lossless = args.get("lossless")
    if lossless is None:
        lossless = str(pr_out.codec).lower() in BO.LOSSLESS_CODECS
    min_psnr = float(args.get("min_psnr") if args.get("min_psnr") is not None else DEFAULT_MIN_PSNR)
    dilate = int(args.get("dilate") if args.get("dilate") is not None else DEFAULT_DILATE_PX)
    matte_dir = args.get("matte")

    # 每條 track 的幾何來源（solve 可缺、遮罩可缺；都缺的 track 對排除區沒貢獻）
    tracks = _select_tracks(mctx, args.get("track"))
    geo: list[dict[str, Any]] = []
    for t in tracks:
        solve = _load_solve(mctx, t.id)
        mf = R.open_masks(mctx.cache, t.id)
        if mf is not None and (mf.width, mf.height) != (W, H):
            raise OpError("Invalid", f"track {t.id} 的遮罩尺寸 {mf.width}x{mf.height} ≠ 影片 {W}x{H}", "重跑 aivc seg")
        geo.append({"id": t.id, "solve": solve, "mask": R.mask_getter(mf), "hasSolve": solve is not None, "hasMasks": mf is not None})
    if matte_dir is not None and not os.path.isdir(matte_dir):
        raise OpError("Invalid", f"--matte 目錄不存在：{matte_dir}")

    def matte_alpha(track_id: str, k: int) -> np.ndarray | None:
        import cv2

        from ..export.mattes import frame_png_path

        p = frame_png_path(matte_dir, track_id, k)  # type: ignore[arg-type]
        if not p.is_file():
            return None
        a = cv2.imdecode(np.fromfile(str(p), dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
        return None if a is None else a

    ks = list(_iter_ks(k_range, int(args.get("every") or 1)))
    rows: list[dict[str, Any]] = []
    excl_px_total = 0
    try:
        with FrameSource(mctx.video, mctx.index, mctx.cfr, probe=mctx.probe, lru=4, ctx=ctx) as fs_src:
            for i, k in enumerate(ks):
                ctx.check_cancel()
                quads, masks, alphas = [], [], []
                for g in geo:
                    if matte_dir is not None:
                        alphas.append(matte_alpha(g["id"], k))
                    else:
                        s = g["solve"]
                        if s is not None:
                            f = s.frames.get(k)
                            if f is not None and f.H is not None:
                                quads.append(hg.quad_from_h(f.H, s.template_wh))
                        if g["mask"] is not None:
                            masks.append(g["mask"](k))
                excl = BO.exclusion_mask(W, H, quads, masks, alphas, dilate_px=dilate)
                excl_px_total += int(excl.sum())
                src = fs_src.get(mctx.cfr.src_index(k))
                out = fs_out.get(k - offset)
                row = BO.compare_outside((src.y, src.u, src.v), (out.y, out.u, out.v), excl)
                row["k"] = k
                row["exclPx"] = int(excl.sum())
                rows.append(row)
                ctx.progress("bench.outside", i + 1, len(ks), frame=k)
    finally:
        fs_out.close()
    summ = BO.summarize(rows, lossless=lossless, min_psnr=min_psnr, max_list=int(args.get("max_list") or DEFAULT_MAX_LIST))
    lines = [
        f"渲染 {args['render']}（{pr_out.codec}，{'無損→逐位元' if lossless else f'有損→PSNR≥{min_psnr:g} dB'}）vs 來源，{len(rows)} 幀（k {k_range[0]}–{k_range[1] - 1}，offset {offset}，每 {args.get('every') or 1} 幀）",
        f"排除區：{'--emit-matte alpha' if matte_dir else '遮罩 ∪ 四角足跡'} 膨脹 {dilate} px，{len(geo)} 條 track（有 solve {sum(g['hasSolve'] for g in geo)}、有遮罩 {sum(g['hasMasks'] for g in geo)}）；平均 {excl_px_total / max(1, len(rows)):.0f} px/幀",
        f"排除區外：逐位元相同 {summ['identicalFrames']}/{len(rows)} 幀；PSNR min {C.rnd(summ['minPsnr'], 2)} / mean(有限) {C.rnd(summ['meanPsnrFinite'], 2)} dB；排除區內有改動的幀 {summ['compositedFrames']} → {'PASS' if summ['ok'] else 'FAIL'}",
    ]
    for f in summ["failures"]:
        lines.append(f"  BAD k={f['k']:<5} psnr={C.rnd(f['psnr'], 2)!s:>7} diffOutside={f['nDiffOutside']} diffInside={f['nDiffInside']}")
    result = {
        **summ,
        "render": str(args["render"]),
        "codec": pr_out.codec,
        "offset": offset,
        "range": list(k_range),
        "every": int(args.get("every") or 1),
        "dilatePx": dilate,
        "exclusionSource": "matte" if matte_dir else "mask|quad",
        "tracks": [{"id": g["id"], "hasSolve": g["hasSolve"], "hasMasks": g["hasMasks"]} for g in geo],
        "rows": [{"k": r["k"], "psnr": r["psnr"], "identical": r["identical"], "nDiffOutside": r["nDiffOutside"], "nDiffInside": r["nDiffInside"], "exclPx": r["exclPx"]} for r in rows],  # 逐幀數字叫 rows：frames 是 summarize 的幀數，不能被蓋掉
    }
    return _finish(result, summ["ok"], "\n".join(lines), t0)


# ================================================================ bench.jitter


def _jitter_args(p: argparse.ArgumentParser) -> None:
    _arg_project(p)
    p.add_argument("--min-run", type=int, default=3, help="短於此的段不算（二階差分至少要 3 幀；預設 3）")


@register("bench.jitter", cli="bench-jitter", help="量尺：每條 track 的 STATIC 段四角二階差分 == 0？（TRACKING 段平滑前/後只記錄）", args=_jitter_args)
def bench_jitter(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..bench import common as C
    from ..bench import jitter as BJ

    t0 = time.perf_counter()
    mctx = _open_project(args, ctx)
    tracks = _select_tracks(mctx, args.get("track"))
    per: dict[str, dict[str, Any]] = {}
    skipped: list[dict[str, str]] = []
    for i, t in enumerate(tracks):
        ctx.check_cancel()
        solve = _load_solve(mctx, t.id)
        if solve is None or not solve.frames:
            skipped.append({"trackId": t.id, "reason": "沒有 solve.v1.json"})
            continue
        per[t.id] = BJ.jitter_report(solve, _load_hud(mctx, t.id), min_run=max(3, int(args.get("min_run") or 3)))
        ctx.progress("bench.jitter", i + 1, len(tracks), track=t.id)
    if not per:
        raise OpError("Invalid", "沒有任何 track 有 solve", "先跑 aivc track / run")
    ok = all(r["ok"] for r in per.values())
    lines = [f"{len(per)} 條 track（{sum(len(r['staticRuns']) for r in per.values())} 個 STATIC 段）→ {'PASS' if ok else 'FAIL'}"]
    for tid, r in per.items():
        st = r["static"]
        tb, ta = r["tracking"]["before"], r["tracking"]["after"]
        lines.append(
            f"  {'ok ' if r['ok'] else 'BAD'} {tid:<18} static {r['counts'].get('static', 0):>4} 幀/{len(r['staticRuns'])} 段"
            f"  二階差分 max={C.rnd(st['secondDiffMax'], 6) if st else '-'} std={C.rnd(st['secondDiffStd'], 6) if st else '-'}"
            f"  | tracking {r['counts'].get('tracking', 0):>4} 幀 二階差分 std 平滑前 {C.rnd(tb['secondDiffStd'], 3) if tb else '-'} → 後 {C.rnd(ta['secondDiffStd'], 3) if ta else '-'}"
        )
        for f in r["failures"]:
            lines.append(f"       段 [{f['k0']},{f['k1']}) 二階差分 max {f['secondDiffMax']:.6g} ≠ 0")
    for sk in skipped:
        lines.append(f"  skip {sk['trackId']}: {sk['reason']}")
    result = {
        "threshold": {"staticSecondDiffMax": 0.0, "minRun": max(3, int(args.get("min_run") or 3))},
        "tracks": per,
        "skipped": skipped,
        "failures": [{"track": tid, **f} for tid, r in per.items() for f in r["failures"]][: int(args.get("max_list") or DEFAULT_MAX_LIST)],
    }
    return _finish(result, ok, "\n".join(lines), t0)


# ================================================================ bench.corners


def _corners_args(p: argparse.ArgumentParser) -> None:
    _arg_project(p)
    p.add_argument("--labels", required=True, help="標記 JSON（人工標記或外掛的自動標記；格式見 aivc/bench/corners.py）")
    p.add_argument("--p5", type=float, default=0.90, help="p@5 px 門檻（預設 0.90）")
    p.add_argument("--p15", type=float, default=0.98, help="p@15 px 門檻（預設 0.98）")
    p.add_argument("--static-mean", type=float, default=1.0, help="STATIC 幀平均誤差門檻 px（預設 1.0）")
    p.add_argument("--wide-frac", type=float, default=0.04, help="遠景門檻 = 此比例 × 平面長邊（預設 0.04）")
    p.add_argument("--wide-p", type=float, default=0.90, help="遠景 p@(wide-frac) 門檻（預設 0.90）")


@register("bench.corners", cli="bench-corners", help="量尺：solve 四角 vs 標記四角：TRACKING+STATIC p@5≥0.90、p@15≥0.98；STATIC 平均≤1 px；遠景 p@4%% 長邊≥0.90", args=_corners_args)
def bench_corners(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..bench import common as C
    from ..bench import corners as BC
    from ..project import resolve as R

    t0 = time.perf_counter()
    mctx = _open_project(args, ctx)
    lp = Path(env.normalize_path(str(args["labels"])))
    if not lp.is_file():
        raise OpError("Invalid", f"找不到 labels：{lp}", "先產生標記 JSON（人工標記或外掛的自動標記）")
    try:
        labels, meta = BC.parse_labels(json.loads(lp.read_text(encoding="utf-8")))
    except (ValueError, OSError) as e:
        raise OpError("Invalid", f"labels 檔不合法：{e}", "格式見 aivc/bench/corners.py 模組說明") from e
    if args.get("track"):
        keep = set(args["track"])
        labels = [lb for lb in labels if lb.track in keep]
    if not labels:
        raise OpError("Invalid", "labels 裡沒有任何可用的標記（或 --track 濾光了）")
    tracks = {t.id: t for t in mctx.tracks()}
    solves: dict[str, Any] = {}
    kinds: dict[str, str] = {}
    for tid in sorted({lb.track for lb in labels}):
        t = tracks.get(tid)
        if t is None:
            ctx.log("warn", f"labels 提到專案沒有的 track {tid!r}：這些標記全部算 miss")
            solves[tid] = None
            continue
        solves[tid] = _load_solve(mctx, tid)
        sh = R.shot_of(mctx.project, mctx.media_id, t)
        kinds[tid] = sh.kind if sh is not None else "unknown"
    ev = BC.evaluate(
        labels, solves, kinds,
        min_p5=float(args.get("p5") or 0.90), min_p15=float(args.get("p15") or 0.98), max_static_mean=float(args.get("static_mean") or 1.0),
        wide_frac=float(args.get("wide_frac") or 0.04), min_wide=float(args.get("wide_p") or 0.90), max_list=int(args.get("max_list") or DEFAULT_MAX_LIST),
    )
    src = str(meta.get("source", "unknown"))
    lines = [
        f"labels {lp.name}（source={src}{'：偵測器自動標記，不是真值' if src == 'detector' else ''}）{ev['labels']} 筆 / {len(solves)} 條 track；未解 {ev['unsolved']}",
        f"TRACKING+STATIC {ev['moving']} 幀：p@5 {C.rnd(ev['p5'], 4)}（≥{args.get('p5') or 0.9}）p@15 {C.rnd(ev['p15'], 4)}（≥{args.get('p15') or 0.98}）",
        f"STATIC {ev['static']} 幀：平均 {C.rnd(ev['staticMean'], 3)} px（≤{args.get('static_mean') or 1.0}）max {C.rnd(ev['staticMax'], 3)} p@1 {C.rnd(ev['p1'], 4)}（記錄）",
        f"遠景 {ev['wide']} 幀：p@{float(args.get('wide_frac') or 0.04):.0%} 長邊 {C.rnd(ev['pWide'], 4)}（≥{args.get('wide_p') or 0.9}）→ {'PASS' if ev['ok'] else 'FAIL'}",
    ]
    for tid, pt in ev["perTrack"].items():
        lines.append(f"  {tid:<18} labels={pt['labels']} unsolved={pt['unsolved']} mean={C.rnd(pt['meanErr'], 3)} max={C.rnd(pt['maxErr'], 3)} p@5={C.rnd(pt['p5'], 3)} p@15={C.rnd(pt['p15'], 3)}")
    for f in ev["failures"]:
        lines.append(f"  >5px k={f['k']:<5} {f['track']:<18} state={f['state']} err={C.rnd(f['err'], 2)}")
    result = {**ev, "labelsPath": str(lp), "labelsSource": src, "labelsMeta": {k: v for k, v in meta.items() if k not in ("frames",)}}
    return _finish(result, ev["ok"], "\n".join(lines), t0)


# ================================================================ bench.speed


def _speed_args(p: argparse.ArgumentParser) -> None:
    # dest 不能叫 json：cli.py 會把 args 裡的 "json"（全域 --json 旗標）剔掉
    p.add_argument("run_result", metavar="RUN_JSON", help="aivc --json run 的輸出（JSONL）或其 result JSON")
    p.add_argument("--max-seconds", type=float, default=300.0, help="60 s 片的總時間門檻（預設 300；依片長等比）")
    p.add_argument("--max-vram-mb", type=float, default=12288.0, help="峰值 VRAM 門檻 MB（預設 12288）")
    p.add_argument("--duration", type=float, default=None, help="片長秒（預設由 result.frames / fps 算）")
    p.add_argument("--fps", type=float, default=None, help="fps（預設從 result.project 指到的專案檔 media.proxy.fps 讀）")


@register("bench.speed", cli="bench-speed", help="量尺：aivc run 的 timings 總時間 < 300 s×(片長/60 s)、峰值 VRAM < 12 GB？", args=_speed_args)
def bench_speed(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..bench import common as C
    from ..bench import speed as BS

    t0 = time.perf_counter()
    p = Path(env.normalize_path(str(args["run_result"])))
    if not p.is_file():
        raise OpError("Invalid", f"找不到檔案：{p}")
    try:
        result = BS.load_run_result(p.read_text(encoding="utf-8"))
    except (ValueError, OSError) as e:
        raise OpError("Invalid", f"讀不出 run 結果：{e}", "給 aivc --json run … 的 stdout（JSONL）") from e
    fps = args.get("fps")
    fps_source = "--fps" if fps else None
    if not fps:
        pp = result.get("project")
        if isinstance(pp, str) and os.path.isfile(pp):
            try:
                from ..project import schema as S

                proj = S.load(pp).project
                m = proj.active_media()
                if m is not None and m.proxy is not None:
                    fps = m.proxy.fps.value
                    fps_source = f"project {pp}"
            except Exception as e:  # noqa: BLE001 專案檔讀不到就沒有 fps
                ctx.log("warn", f"讀不到專案檔 fps：{e}")
    try:
        chk = BS.check_speed(result, max_seconds=float(args.get("max_seconds") or 300.0), max_vram_mb=float(args.get("max_vram_mb") or 12288.0), duration_s=args.get("duration"), fps=fps)
    except ValueError as e:
        raise OpError("Invalid", str(e)) from e
    lines = [
        f"{p.name}：總時間 {chk['totalSeconds']:.1f} s（門檻 {chk['limitSeconds']:.1f} s；片長 {C.rnd(chk['durationSeconds'], 2)} s{f'，fps 來自 {fps_source}' if fps_source else ''}）"
        f"  峰值 VRAM {C.rnd(chk['peakVramMB'], 0) if chk['vramKnown'] else '未知'} MB（門檻 {chk['threshold']['maxVramMB']:.0f}）→ {'PASS' if chk['ok'] else 'FAIL'}",
        "  stages  " + "  ".join(f"{k}={v:g}s" for k, v in chk["stages"].items()),
    ]
    for n in chk["notes"]:
        lines.append(f"  note {n}")
    for f in chk["failures"]:
        lines.append(f"  BAD {f}")
    return _finish({**chk, "source": str(p), "fpsSource": fps_source}, chk["ok"], "\n".join(lines), t0)


__all__ = ["bench_outside", "bench_jitter", "bench_corners", "bench_speed"]
