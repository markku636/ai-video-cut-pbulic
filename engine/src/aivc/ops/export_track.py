"""`aivc export-track <project> --track ID --format nuke|ae [--flavour cornerpin|cornerpin+transform] [--baked|--linked]
[--frame-offset N] [--stdout] -o FILE`（op `export.track`；計畫 §6.8 / §17.5）。

只做「找檔 + 寫檔」：座標／格式全在 `aivc.export.*` 純函式裡（那裡才有 export-roundtrip 測試）。
- solve 來源：`--solve PATH` → `<cache>/media/<fp16>/tracks/<trackId>/solve.v1.json`（aivc track / run 寫的）。
- 尺寸：**來源**像素尺寸（solve 四角是來源座標，render 也用 probe 尺寸）：快取 probe.v1.json／影片 probe → media.probe
  → media.proxy ÷ scale（proxy 在來源高於 1080 時是縮圖尺寸，不能直接拿來翻 Y）。fps：media.proxy → probe。
  影片不在也能匯出，只要快取有 probe 或專案有 probe／proxy 欄位。
- `--linked` 的 solve 路徑：相對輸出檔目錄（沒有 -o 則相對快取根）；跨磁碟或 --solve 在快取外算不出相對路徑時退絕對路徑。
- Nuke knob（motionblur/shutter/shutteroffset/filter/clamp）由該 track 解析後的 insert 參數推得。
- `--stdout`：人類模式直接印文字；`--json` 模式放在 result.text（stdout 是 JSONL，不能混）。
- frameOffset 預設：exportDefaults.trackData.frameOffset（通常 1）；AE 若沒明確指定則用 0（AE 合成從 0 起算）。
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
from typing import Any

from .. import env
from . import Ctx, OpError, register

_HELP = "匯出追蹤資料：Nuke CornerPin2D .nk 片段或 After Effects 關鍵幀剪貼簿文字"


def _args(p: argparse.ArgumentParser) -> None:
    p.add_argument("project", help="專案檔 *.aivc.json")
    p.add_argument("--track", default=None, help="track id（專案只有一條時可省略）")
    p.add_argument("--media", default=None, help="media id（預設 activeMediaId）")
    p.add_argument("--format", choices=["nuke", "ae"], default=None, help="預設 exportDefaults.trackData.format")
    p.add_argument("--flavour", choices=["cornerpin", "cornerpin+transform"], default=None, help="cornerpin+transform 只對 ae 有意義（Nuke 忽略）")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--baked", action="store_true", help="曲線內嵌（預設）")
    g.add_argument("--linked", action="store_true", help="多一行註解記 solve.v1.json 相對路徑與 trackId（Nuke）")
    p.add_argument("--frame-offset", type=int, default=None, help="frame = k + offset；預設 nuke 1 / ae 0（或 exportDefaults）")
    p.add_argument("--stabilize", action="store_true", help="Nuke：invert true（stabilize 語意）")
    p.add_argument("--raw", action="store_true", help="用平滑前的解（solve.hud.v1.json cornersRaw）；預設用平滑後")
    p.add_argument("--solve", default=None, help="直接指定 solve.v1.json（預設從快取找）")
    p.add_argument("--stdout", action="store_true", help="印到 stdout（--json 模式放在 result.text）")
    p.add_argument("-o", "--out", default=None, help="輸出檔（.nk / .txt）")


def quads_from_solve(solve: Any) -> dict[int, Any]:
    """Solve → {k: quad(4,2)|None}（LOST 幀為 None，不寫 key）。"""
    return {int(k): solve.corners(int(k)) for k in sorted(solve.frames)}


def source_size_of(media: Any, probe: Any | None) -> tuple[tuple[int, int], str]:
    """來源像素尺寸 (w, h) 與出處。

    tracker 讀的是原片（不是 proxy），solve 四角在來源座標；render 用 mctx.size（probe）翻譯同一份資料。
    若這裡拿 media.proxy.width/height（R.frame_size_of 的第一順位），4K 片會用 1080 翻 Nuke 的 Y、AE 標 1920x1080，
    與 render 不一致，所以順序刻意和 frame_size_of 相反：probe → media.probe → proxy ÷ scale（最後手段）。
    """
    if probe is not None and int(probe.width) > 0 and int(probe.height) > 0:
        return (int(probe.width), int(probe.height)), "probe"
    pr = media.probe or {}
    v = pr.get("video") if isinstance(pr.get("video"), dict) else pr  # Rust MediaProbe：{video:{width,height}} 或平的
    if isinstance(v, dict):
        try:
            w, h = int(v.get("width") or 0), int(v.get("height") or 0)
        except (TypeError, ValueError):
            w = h = 0
        if w > 0 and h > 0:
            return (w, h), "media.probe"
    px = media.proxy
    if px is not None and px.width > 0 and px.height > 0:
        # proxy.v1.json 的 scale = proxy/source（ops/media.proxy_dims）；偶數化可能讓奇數邊差 1 px，所以只當最後手段
        s = float(px.scale) if px.scale and px.scale > 0 else 1.0
        return (int(round(px.width / s)), int(round(px.height / s))), "proxy/scale"
    raise OpError("Invalid", f"media {media.id} 沒有來源尺寸資訊", "先跑 aivc probe / proxy")


def linked_solve_ref(solve_path: Path, out_path: Path | None, cache: Any | None) -> str:
    """--linked 註解裡的 solve 路徑（POSIX 分隔）：有 -o 相對輸出檔目錄，沒有則相對快取根。

    Windows 上輸出存到 D:、快取在 C:（%LOCALAPPDATA%）時 os.path.relpath 擲 ValueError；--solve 指到快取外時
    cache.rel（Path.relative_to）也擲。跨磁碟根本沒有相對路徑可寫 → 退絕對路徑（Nuke 端仍找得到檔）。
    """
    try:
        if out_path is not None:
            rel = os.path.relpath(solve_path, out_path.parent)
        elif cache is not None:
            rel = cache.rel(solve_path)
        else:
            rel = os.path.abspath(solve_path)
    except ValueError:
        rel = os.path.abspath(solve_path)
    return rel.replace(os.sep, "/")


@register("export.track", cli="export-track", help=_HELP, args=_args)
def export_track_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..export import ae_keyframes as AE
    from ..export import nuke_cornerpin as NK
    from ..project import resolve as R
    from ..project import schema as S
    from ..track.state import Solve

    project_path = Path(env.normalize_path(str(args["project"])))
    r = S.load(project_path)
    for w in r.warnings:
        ctx.log("warn", f"專案檔：{w}")
    project = r.project
    media = R.select_media(project, args.get("media"))
    tracks = project.tracks.get(media.id, [])
    tid = args.get("track")
    if tid is None:
        if len(tracks) != 1:
            raise OpError("Invalid", f"專案有 {len(tracks)} 條 track，請用 --track 指定", f"有的：{[t.id for t in tracks]}")
        track = tracks[0]
    else:
        track = project.track_by_id(media.id, str(tid))
        if track is None:
            raise OpError("Invalid", f"找不到 track {tid!r}", f"有的：{[t.id for t in tracks]}")

    # ---- solve ----
    video: str | None
    try:
        video = R.video_path_of(media, project_path)
    except OpError:
        video = None
    cache = R.cache_for(media, video) if (media.fingerprint or video) else None
    if args.get("solve"):
        solve_path = Path(env.normalize_path(str(args["solve"])))
    else:
        if cache is None:
            raise OpError("Invalid", "專案 media 沒有指紋也找不到影片，無法定位 solve；請用 --solve PATH")
        solve_path = cache.solve(track.id)
    if not solve_path.is_file():
        raise OpError("Io", f"找不到追蹤解 {solve_path}", "先跑 aivc track 或 aivc run，或用 --solve 指定")
    try:
        solve = Solve.read(solve_path)
    except (ValueError, KeyError) as e:
        raise OpError("Invalid", f"solve 檔壞掉：{e}") from e
    frames = quads_from_solve(solve)
    if args.get("raw"):
        hud = solve_path.with_name("solve.hud.v1.json")
        if hud.is_file():
            import json

            import numpy as np

            rows = json.loads(hud.read_text(encoding="utf-8")).get("frames", [])
            raw = {int(row["k"]): (None if row.get("cornersRaw") is None else np.asarray(row["cornersRaw"], dtype=np.float64)) for row in rows}
            frames = {k: raw.get(k, q) for k, q in frames.items()}
        else:
            ctx.log("warn", f"--raw 需要 {hud.name}，找不到，改用平滑後的解")

    # ---- 尺寸 / fps ----
    # 快取 probe 以指紋為鍵，影片搬走了也還能用 → 不必等 video 存在才讀；沒有快取才現場 probe 影片
    probe = None
    try:
        from ..media.probe import load_probe

        probe = load_probe(cache.probe) if cache is not None else None
        if probe is None and video is not None:
            from ..media.probe import probe as _probe

            probe = _probe(video)
    except Exception:  # noqa: BLE001
        probe = None
    (width, height), size_from = source_size_of(media, probe)
    if size_from == "proxy/scale":
        ctx.log("warn", f"找不到來源 probe，尺寸由 proxy ÷ scale 反推為 {width}x{height}（奇數邊可能差 1 px）；先跑 aivc probe 可精確")
    fps = R.fps_of(media, probe)

    # ---- 格式 / 口味 / 偏移 ----
    td = project.export_defaults.track_data
    fmt = str(args.get("format") or td.format)
    flavour = str(args.get("flavour") or td.flavour)
    baked = not bool(args.get("linked")) if (args.get("baked") or args.get("linked")) else bool(td.baked)
    if args.get("frame_offset") is not None:
        frame_offset = int(args["frame_offset"])
    elif fmt == "ae":
        frame_offset = AE.DEFAULT_FRAME_OFFSET
    else:
        frame_offset = int(td.frame_offset)

    out_path = Path(env.normalize_path(str(args["out"]))) if args.get("out") else None
    linked_note: str | None = None
    if not baked:
        rel = linked_solve_ref(solve_path, out_path, cache)
        linked_note = f"solve={rel} trackId={track.id} fingerprint={(media.fingerprint or '')[:16]}"

    n_keys = sum(1 for q in frames.values() if q is not None)
    if fmt == "nuke":
        params = R.insert_params_for(track, project)
        opts = NK.options_from_insert(params, frame_offset=frame_offset, node_name=f"aivc_{track.id}_CornerPin2D".replace("-", "_"), invert=bool(args.get("stabilize")))
        header = [
            f"aivc export-track format=nuke flavour=cornerpin baked={'true' if baked else 'false'} frameOffset={frame_offset}",
            f"trackId={track.id} shot=[{solve.shot[0]},{solve.shot[1]}) template={solve.template_wh[0]}x{solve.template_wh[1]} source={width}x{height} keys={n_keys}",
            "to1=BL to2=BR to3=TR to4=TL ; y_nuke = height - y_src ; frame = k + frameOffset",
        ]
        text = NK.nuke_cornerpin(frames, height=height, template_wh=solve.template_wh, options=opts, header_lines=header, linked=linked_note)
        ext = ".nk"
    else:
        text = AE.ae_keyframes(frames, fps=fps, width=width, height=height, template_wh=solve.template_wh, frame_offset=frame_offset, flavour=flavour)
        if linked_note:
            ctx.log("info", f"AE 剪貼簿文字沒有註解語法，--linked 只回在 result.linked：{linked_note}")
        ext = ".txt"

    result: dict[str, Any] = {
        "trackId": track.id,
        "format": fmt,
        "flavour": flavour if fmt == "ae" else "cornerpin",
        "baked": baked,
        "frameOffset": frame_offset,
        "keys": n_keys,
        "frames": len(frames),
        "solvePath": str(solve_path),
        "size": [width, height],
        "fps": {"num": fps[0], "den": fps[1]},
        "linked": linked_note,
        "bytes": len(text.encode("utf-8")),
    }
    if out_path is not None:
        if out_path.suffix == "":
            out_path = out_path.with_suffix(ext)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text, encoding="utf-8", newline="\n")
        ctx.artifact(str(out_path), "track-export")
        result["out"] = str(out_path)
    if args.get("stdout") or out_path is None:
        result["text"] = text
        result["_human"] = text if args.get("stdout") else f"{n_keys} 個 key（{fmt}）；沒有 -o，用 --stdout 印出或 -o 存檔"
    else:
        result["_human"] = f"{fmt} {result['flavour']} {'baked' if baked else 'linked'} → {out_path}（{n_keys} keys，frame={frame_offset}+k，{width}x{height} @ {fps[0]}/{fps[1]}）"
    return result
