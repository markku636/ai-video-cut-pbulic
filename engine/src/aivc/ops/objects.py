"""ObjectTrack 的三支 op：匯出資料（`objects.export`）、看圖驗收（`objects.preview`）、收進專案的快取（`objects.adopt`）。

- `aivc track-export <video> --masks M.aivm --format json|csv|png --out PATH`
  逐幀錨點（可見、面積、外接框、重心、方向角＋平滑版）匯出成 JSON（`aivc.objecttrack.v1`）／CSV（一幀一列）／
  PNG 遮罩序列（`--out` 是資料夾）。格式定義見 docs/tracking-api.md。影片用來取尺寸、fps 與 proxy 幀數，
  並檢查遮罩是對這支影片算的（尺寸相同、條目的幀號都在 proxy 幀數內）。
  （與 `aivc export-track` 不同：那支匯出平面四角的 Nuke／AE 追蹤資料。）
- `aivc preview-object <video> --masks M.aivm [--masks …] --frames K1,K2,… --out sheet.png`
  聯絡表：每格是一幀的疊色＋編號＋幀號。給 Claude Code／Codex（或人）一眼確認「整段都追對了嗎」。
  `--frames` 省略＝在物件出現的範圍均勻取 6 幀。
- `aivc adopt <video> --src DIR/obj<N>|M.aivm --track-id ID`
  把 find／select 的遮罩收進這支影片的 media 快取 `tracks/<ID>/masks.aivm`（跟平面 track 的遮罩同一個位置；專案檔的
  object track 只記 id，render 從這裡讀）。複製走唯一暫存名＋os.replace，讀的人不會看到寫一半的檔；同時算好錨點快取
  `anchors.v1.json` 與縮圖 `thumb.png`，回 `{masks, visibleRanges, bestFrame, box, area, thumb}`（＋range、frames 摘要）。
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import Any

from .. import env
from . import Ctx, OpError, register

DEFAULT_SHEET_FRAMES = 6


def check_mask_fits(path: str, width: int, height: int, n_entries: int, last_k: int, W: int, H: int, n_frames: int | None) -> None:
    """遮罩是不是對這支影片算的：尺寸相同，而且條目的幀號都在影片的 proxy 幀數內。
    （只比尺寸不夠：1080p 以上的 16:9 素材 proxy 一律 1920×1080，別支影片的遮罩照樣過、匯出超過片長的幀。）"""
    if (width, height) != (W, H):
        raise OpError("Invalid", f"遮罩 {path} 是 {width}×{height}，影片是 {W}×{H}", hint="遮罩與影片要是同一支（通常是 proxy）")
    if n_frames is not None and n_entries > 0 and last_k >= n_frames:
        raise OpError(
            "Invalid", f"遮罩 {path} 到第 {last_k} 幀，但影片只有 {n_frames} 幀（proxy 幀號 0..{n_frames - 1}）",
            hint="遮罩與影片要是同一支（通常是 proxy）",
        )


def _open_masks(paths: list[str], W: int, H: int, n_frames: int | None = None) -> list[Any]:
    from ..seg.maskfile import MaskFile, MaskFileError

    out = []
    for p in paths:
        path = env.normalize_path(str(p))
        if not Path(path).is_file():
            raise OpError("Io", f"找不到遮罩檔 {path}", hint="先跑 aivc find／select／seg 產生 masks.aivm")
        try:
            mf = MaskFile.open(path)
        except (MaskFileError, OSError) as e:
            raise OpError("Invalid", f"讀不了遮罩檔 {path}：{e}") from e
        h = mf.header
        check_mask_fits(path, mf.width, mf.height, h.n_entries, h.last_k, W, H, n_frames)
        out.append(mf)
    return out


# ---------------------------------------------------------------- objects.export
def _export_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("video", help="影片路徑（取尺寸／fps／幀數；遮罩必須是對這支影片算的）")
    p.add_argument("--masks", required=True, metavar="AIVM", help="aivc find／select／seg 寫出的 masks.aivm")
    p.add_argument("--format", choices=["json", "csv", "png"], default="json", help="json（aivc.objecttrack.v1）｜csv（一幀一列）｜png（遮罩序列，--out 是資料夾）")
    p.add_argument("--out", required=True, help="輸出檔（json／csv）或資料夾（png）")
    p.add_argument("--window", type=int, default=None, help="Savitzky-Golay 平滑視窗（幀，預設 9；0＝不平滑）")
    p.add_argument("--no-cache", action="store_true", help="不讀也不寫 anchors.v1.json 快取")


@register("objects.export", cli="track-export", help="匯出物件追蹤資料（逐幀外接框／重心／方向角）：JSON、CSV 或 PNG 遮罩序列", args=_export_args)
def objects_export(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..objects import export as X
    from ..objects.anchors import DEFAULT_WINDOW
    from ..objects.track import ObjectTrack
    from . import media as M

    video = env.normalize_path(str(args["video"]))
    if not Path(video).is_file():
        raise OpError("Io", f"找不到影片 {video}")
    fmt = str(args.get("format") or "json")
    if fmt not in ("json", "csv", "png"):
        raise OpError("Invalid", f"--format 只能是 json｜csv｜png（拿到 {fmt!r}）")
    window = DEFAULT_WINDOW if args.get("window") is None else int(args["window"])
    if window < 0:
        raise OpError("Invalid", f"--window 不能是負的（拿到 {window}）")
    mc, pr = M.open_media(video, ctx)
    _idx, cfr, _ = M.ensure_index(video, mc, pr, ctx)
    W, H = int(pr.width), int(pr.height)
    mpath = env.normalize_path(str(args["masks"]))
    if not Path(mpath).is_file():
        raise OpError("Io", f"找不到遮罩檔 {mpath}", hint="先跑 aivc find／select／seg 產生 masks.aivm")
    try:
        # 讀一次檔就好（以前先 _open_masks 檢查、再 ObjectTrack.open 讀第二次）；錨點要算時有進度、可取消
        track = ObjectTrack.open(mpath, window=window, cache=not args.get("no_cache"), ctx=ctx)
    except (OSError, ValueError) as e:
        raise OpError("Invalid", f"讀不了遮罩檔 {mpath}：{e}") from e
    h = track.masks.header
    check_mask_fits(mpath, h.width, h.height, h.n_entries, h.last_k, W, H, int(cfr.n_frames))
    vi = X.VideoInfo(video, W, H, (int(cfr.fps_num), int(cfr.fps_den)), int(cfr.n_frames))
    out = Path(env.normalize_path(str(args["out"])))
    n_rows = sum(1 for _ in track.anchors.iter_all())
    if fmt == "json":
        X.write_json(out, X.track_json(track, vi))
        written = [str(out)]
    elif fmt == "csv":
        X.write_csv(out, track, vi)
        written = [str(out)]
    else:
        written = [str(p) for p in X.write_png_sequence(out, track, ctx=ctx)]
    ctx.artifact(str(out), kind="track-export")
    ranges = track.anchors.visible_ranges()
    return {
        "format": fmt,
        "out": str(out),
        "files": len(written),
        "frames": n_rows,
        "visibleRanges": [list(r) for r in ranges],
        "framesVisible": sum(1 for a in track.anchors.frames.values() if a.visible),
        "video": vi.to_json(),
        "masks": mpath,
        "anchorsCache": {"hit": track.cache_hit, "enabled": not args.get("no_cache")},
        "_human": f"{fmt} → {out}（{n_rows} 幀，可見 {len(ranges)} 段：{', '.join(f'{a}–{b}' for a, b in ranges) or '無'}）",
    }


# ---------------------------------------------------------------- objects.preview
def _preview_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("video", help="影片路徑（通常是 proxy）")
    p.add_argument("--masks", action="append", required=True, metavar="AIVM", help="masks.aivm（可重複；依順序編號 1..n、各一個顏色）")
    p.add_argument("--frames", default=None, metavar="K1,K2,…", help=f"要看哪幾幀（預設：物件出現的範圍均勻取 {DEFAULT_SHEET_FRAMES} 幀）")
    p.add_argument("--out", required=True, help="輸出 PNG")
    p.add_argument("--cols", type=int, default=None, help="每列幾格（預設 3）")
    p.add_argument("--tile", type=int, default=480, help="每格長邊像素（預設 480）")


def parse_frame_list(s: str | None) -> list[int] | None:
    if not s:
        return None
    out: list[int] = []
    for part in str(s).replace("，", ",").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            v = int(part)
        except ValueError as e:
            raise OpError("Invalid", f"--frames 要寫成 K1,K2,…（整數），拿到 {part!r}") from e
        if v < 0:
            raise OpError("Invalid", f"--frames 不能有負的幀號（{v}）")
        if v not in out:
            out.append(v)
    if not out:
        raise OpError("Invalid", "--frames 是空的")
    return out


def auto_frames(mask_files: list[Any], n_frames: int, count: int = DEFAULT_SHEET_FRAMES) -> list[int]:
    """所有遮罩檔「有物件」的幀的範圍裡均勻取 count 幀；都沒有物件就整支影片均勻取。"""
    present = sorted({k for mf in mask_files for k in mf.frames_present()})
    lo, hi = (present[0], present[-1]) if present else (0, max(0, n_frames - 1))
    if hi <= lo or count <= 1:
        return [lo]
    return sorted({int(round(lo + i * (hi - lo) / (count - 1))) for i in range(count)})


@register("objects.preview", cli="preview-object", help="物件預覽聯絡表：指定幾幀的疊色＋編號＋幀號拼成一張（給 AI／人驗收追蹤）", args=_preview_args)
def objects_preview(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..seg import preview, viz
    from .track import ProxyFrames

    video = env.normalize_path(str(args["video"]))
    if not Path(video).is_file():
        raise OpError("Io", f"找不到影片 {video}")
    out = Path(env.normalize_path(str(args["out"])))
    tile = int(args.get("tile") or 480)
    if tile < 64:
        raise OpError("Invalid", f"--tile 至少 64（拿到 {tile}）")
    frames = ProxyFrames(video, ctx)
    try:
        mfs = _open_masks(list(args["masks"]), frames.width, frames.height, int(frames.n))
        ks = parse_frame_list(args.get("frames")) or auto_frames(mfs, frames.n)
        bad = [k for k in ks if not 0 <= k < frames.n]
        if bad:
            raise OpError("Invalid", f"--frames 有超出 proxy 幀範圍 [0, {frames.n}) 的幀：{bad}")
        tiles = []
        present: dict[str, list[int]] = {}
        for i, k in enumerate(ks):
            ctx.check_cancel()
            masks = {j + 1: mf.get(k) for j, mf in enumerate(mfs)}
            here = [j for j, m in masks.items() if m is not None and m.any()]
            present[str(k)] = here
            absent = [j for j in masks if j not in here]
            title = f"k={k}  t={frames.seconds(k):.2f}s" + (f"  absent: {','.join(map(str, absent))}" if absent else "")
            img = viz.numbered_overlay(frames.get(k), masks)
            img, _ = viz.fit_max_side(img, tile)
            viz.title_bar(img, title)
            tiles.append(img)
            ctx.progress("objects.preview", i + 1, len(ks), frame=k)
    finally:
        frames.close()
    cols = int(args.get("cols") or min(3, len(tiles)))
    sheet = viz.contact_sheet(tiles, cols=max(1, cols))
    path = preview.save_png(out, sheet)
    ctx.artifact(path, kind="preview")
    return {
        "out": path,
        "frames": ks,
        "tiles": len(tiles),
        "size": [int(sheet.shape[1]), int(sheet.shape[0])],
        "present": present,
        "_human": f"{len(tiles)} 格（幀 {', '.join(map(str, ks))}）→ {path}",
    }


# ---------------------------------------------------------------- objects.adopt
def _adopt_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("video", help="影片路徑（遮罩要是對這支影片算的；快取位置由它的指紋決定）")
    p.add_argument("--src", required=True, help="aivc find／select 的 obj<N> 資料夾，或 masks.aivm 路徑")
    p.add_argument("--track-id", dest="track_id", required=True, help="專案檔裡的 track id（快取資料夾名）")


def _adopt_src(raw: Any) -> Path:
    """obj<N> 資料夾 → 裡面的 masks.aivm；檔案路徑原樣。"""
    p = Path(env.normalize_path(str(raw)))
    if p.is_dir():
        p = p / "masks.aivm"
    if not p.is_file():
        raise OpError("Io", f"找不到遮罩檔 {p}", hint="--src 給 aivc find／select 輸出的 obj<N> 資料夾或 masks.aivm")
    return p


def best_frame_of(anchors: Any) -> Any:
    """面積最大的可見幀（同面積取最早；與 find.v1.json 的 bestFrame 同一個定義）。沒有可見幀 → None。"""
    best = None
    for a in anchors.frames.values():
        if a.visible and (best is None or a.area > best.area or (a.area == best.area and a.k < best.k)):
            best = a
    return best


@register("objects.adopt", cli="adopt", help="把 find／select 的物件遮罩收進影片的快取 tracks/<trackId>/masks.aivm（專案的 object track 用）", args=_adopt_args)
def objects_adopt(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from .. import atomic
    from ..objects.track import ObjectTrack
    from ..project import paths as PP
    from ..seg import preview, viz
    from ..seg.maskfile import MaskFile, MaskFileError
    from . import media as M
    from .track import ProxyFrames

    video = env.normalize_path(str(args["video"]))
    if not Path(video).is_file():
        raise OpError("Io", f"找不到影片 {video}")
    track_id = str(args.get("track_id") or args.get("trackId") or "").strip()
    try:
        safe = PP.safe_component(track_id)
    except ValueError:
        safe = None
    if safe != track_id:
        # 快取路徑會把不安全的字元換掉：不同的 id 可能落到同一個資料夾，寧可直接拒絕
        raise OpError("Invalid", f"--track-id 不能當資料夾名：{track_id!r}", hint="只用英數與 . _ -（不能以 . 或 _ 開頭結尾）")
    src = _adopt_src(args["src"])
    mc, pr = M.open_media(video, ctx)
    W, H = int(pr.width), int(pr.height)
    try:
        raw = atomic.read_bytes(src)
        mf = MaskFile.open(src)  # 先驗：壞檔不能搬進快取
    except (MaskFileError, OSError) as e:
        raise OpError("Invalid", f"讀不了遮罩檔 {src}：{e}") from e
    if (mf.width, mf.height) != (W, H):
        raise OpError("Invalid", f"遮罩是 {mf.width}×{mf.height}，影片是 {W}×{H}", hint="遮罩與影片要是同一支（通常是 proxy）")
    dst = PP.media_cache(mc.fingerprint).masks(track_id)
    same = dst.is_file() and os.path.normcase(os.path.abspath(dst)) == os.path.normcase(os.path.abspath(src))
    if not same:
        atomic.write_bytes(dst, raw)  # 唯一暫存名＋os.replace：render／UI 讀的人不會看到寫一半的檔
    ctx.artifact(str(dst), kind="masks")
    try:
        track = ObjectTrack.open(dst)
    except (MaskFileError, OSError, ValueError) as e:
        raise OpError("Invalid", f"讀不了遮罩檔 {dst}：{e}") from e
    ranges = track.anchors.visible_ranges()
    best = best_frame_of(track.anchors)
    thumb = None
    if best is not None:
        _idx, cfr, _ = M.ensure_index(video, mc, pr, ctx)
        if best.k < int(cfr.n_frames):
            frames = ProxyFrames(video, ctx)
            try:
                m = track.mask(best.k)
                if m is not None:
                    thumb = preview.save_png(dst.with_name("thumb.png"), viz.thumbnail(frames.get(best.k), m, 1))
                    ctx.artifact(thumb, kind="thumb")
            finally:
                frames.close()
    if thumb is None:
        atomic.unlink_quiet(dst.with_name("thumb.png"))  # 上一次 adopt 留下的縮圖已經不是這個物件
    present = len(mf.frames_present())
    box = None if best is None or best.bbox is None else [round(float(v), 2) for v in best.bbox]
    return {
        "trackId": track_id,
        "masks": str(dst),
        "visibleRanges": [list(r) for r in ranges],
        # 建議的 track.range（半開）：第一個到最後一個可見幀
        "range": [ranges[0][0], ranges[-1][1] + 1] if ranges else None,
        "bestFrame": None if best is None else int(best.k),
        "box": box,
        "area": 0 if best is None else int(best.area),
        "thumb": thumb,
        "frames": {"entries": len(mf.frames()), "present": present, "absent": len(mf.frames()) - present},
        "size": [W, H],
        "_human": f"{src} → {dst}（可見 {len(ranges)} 段：{', '.join(f'{a}–{b}' for a, b in ranges) or '無'}；最佳幀 {None if best is None else best.k}）",
    }
