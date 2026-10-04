"""`aivc track` / op `track.solve`：模板→幀平面追蹤，輸出 solve.v1.json（＋HUD 側檔）。

`aivc track <video> [--template PNG] --shot K0:K1 [--masks m.aivm] [--reference-frame K] [--quad x1,y1,…,x4,y4]
           [--keyframe K:x1,y1,…,x4,y4]* [--tracking-region x1,y1,…] [--upsample 2] [--motion-model …]
           [--no-smoothing] [--out solve.v1.json] [--clear-forwards K | --clear-backwards K | --retrack-from K [--backwards]]
           [--from K --to K]`
幀號一律是 **CFR proxy 幀號 k**（計畫決策 3）：前端送來的鏡頭／關鍵幀／參考影格都是 proxy k，
render.run 也用 proxy k 讀 solve，所以這裡跟 run.py 走同一條路（media.ensure_index → FrameSource.get_proxy_frame）。
VFR 來源（範例 1762 幀 → proxy 1797 幀）若用來源解碼序號，整條結果會偏 35 幀、最後一個鏡頭被截斷。

沒有 `--template`（一般的平面：牆、螢幕、招牌）：參考影格的四角（`--quad` + `--reference-frame`，或 `--keyframe`）矯正出模板
（`track.template.template_from_frame`，尺寸＝四角在幀裡的大小），存成 solve 旁邊的 `template.png`；之後的 `--retrack-from`／
`--clear-*` 沒給四角就重用它。回傳的 `template` 說明模板從哪來。

`--method`：核心只有 classic；外掛可以登記別的追蹤方法（hooks track-method，例：牌局外掛的空白牌追蹤），
它們自己的旗標用 hooks op-args 加在這支 op 上。
"""
from __future__ import annotations

import argparse
import json
import time
from collections import OrderedDict
from fractions import Fraction
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterator

import numpy as np

from .. import env
from . import Ctx, OpError, register

if TYPE_CHECKING:
    from ..media.index import PtsIndex
    from ..track.state import Solve


# ---------------------------------------------------------------- proxy 幀來源（seg.run 也用）


def _lru_for_gop(idx: "PtsIndex") -> int:
    """FrameSource 的 LRU 至少要裝得下一整個 GOP：反向走（backward pass）時一次 miss 會從關鍵幀往前解整段，
    解出來的幀全進 LRU，之後往回走都命中；LRU 比 GOP 小就變成每幀 seek 一次（範例 GOP ~100 幀 → 慢 100×）。"""
    keys = [i for i, k in enumerate(idx.key) if k] or [0]
    gop = max(b - a for a, b in zip(keys, keys[1:] + [idx.n]))
    return min(320, max(64, gop + 8))


class ProxyFrames:
    """proxy 幀號 k → rgb8 (H,W,3)。index / cfr 用 media 模組的快取（與 run.py、前端 proxy 同一份 CfrMap），
    所以 track.solve / seg.run 的 k 跟 UI 時間軸、render.run 對得上。重複幀（VFR 缺幀定格）共用同一張 rgb。"""

    def __init__(self, video: str, ctx: Ctx, *, lru: int | None = None, rgb_cache: int = 16) -> None:
        from ..media.source import FrameSource
        from . import media as M

        self.video = video
        self.mc, self.probe = M.open_media(video, ctx)
        self.index, self.cfr, _ = M.ensure_index(video, self.mc, self.probe, ctx)
        self.n = int(self.cfr.n_frames)
        self.width, self.height = int(self.probe.width), int(self.probe.height)
        self._fs = FrameSource(video, self.index, self.cfr, probe=self.probe, lru=lru or _lru_for_gop(self.index), ctx=ctx)
        # rgb 小快取以「來源幀」為 key：同一步裡重複取同一幀、或定格的多個 k，都不必重做 yuv→rgb
        self._rgb: OrderedDict[int, np.ndarray] = OrderedDict()
        self._rgb_cap = max(1, int(rgb_cache))

    def __len__(self) -> int:
        return self.n

    def __enter__(self) -> "ProxyFrames":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    def close(self) -> None:
        self._rgb.clear()
        self._fs.close()

    def src_index(self, k: int) -> int:
        return self.cfr.src_index(int(k))

    def seconds(self, k: int) -> float:
        return float(Fraction(int(k) * self.cfr.fps_den, self.cfr.fps_num))

    def get(self, k: int) -> np.ndarray:
        k = int(k)
        if not 0 <= k < self.n:
            raise IndexError(f"proxy 幀 {k} 超出 [0,{self.n})")
        src = self.cfr.src_index(k)
        hit = self._rgb.get(src)
        if hit is not None:
            self._rgb.move_to_end(src)
            return hit
        arr = self._fs.get_proxy_frame(k).rgb8()
        self._rgb[src] = arr
        while len(self._rgb) > self._rgb_cap:
            self._rgb.popitem(last=False)
        return arr

    __call__ = get

    def iter_frames(self, k0: int, k1: int) -> Iterator[tuple[int, np.ndarray]]:
        """(k, rgb) for k in [k0, k1)，遞增；惰性（呼叫端邊取邊丟）。"""
        for k in range(max(0, k0), min(k1, self.n)):
            yield k, self.get(k)

    def iter_frames_reversed(self, k0: int, k1: int) -> Iterator[tuple[int, np.ndarray]]:
        """(k, rgb) for k = k1-1 … k0，遞減。"""
        for k in range(min(k1, self.n) - 1, max(0, k0) - 1, -1):
            yield k, self.get(k)


# ---------------------------------------------------------------- 參數


def _parse_quad(s: str) -> np.ndarray:
    vals = [float(v) for v in s.replace(";", ",").split(",") if v.strip()]
    if len(vals) != 8:
        raise OpError("Invalid", f"四角需要 8 個數字（x1,y1,…,x4,y4，TL,TR,BR,BL），收到 {len(vals)} 個")
    return np.asarray(vals, dtype=np.float64).reshape(4, 2)


def _parse_shot(s: str) -> tuple[int, int]:
    try:
        a, b = s.split(":")
        k0, k1 = int(a), int(b)
    except ValueError as e:
        raise OpError("Invalid", f"--shot 格式為 K0:K1，收到 {s!r}") from e
    if k1 <= k0:
        raise OpError("Invalid", f"--shot 範圍為空：{s}")
    return k0, k1


def _methods() -> dict[str, Any]:
    from .. import hooks

    return hooks.track_methods()


def _args(p: argparse.ArgumentParser) -> None:
    p.add_argument("video", help="影片路徑")
    extra = _methods()
    help_text = "classic＝模板→幀 SIFT+ECC" + "".join(f"；{name}＝{m.help}" for name, m in extra.items() if m.help)
    p.add_argument("--method", default="classic", choices=("classic", *extra), help=help_text)
    p.add_argument("--template", default=None, help="模板 PNG（RGBA 的 alpha 當表面範圍）；省略＝從參考影格的四角（--quad／--keyframe）取出模板，存成 solve 旁的 template.png")
    p.add_argument("--shot", required=True, help="鏡頭範圍 K0:K1（半開，proxy 幀號）")
    p.add_argument("--masks", help=".aivm 遮罩檔（proxy 幀號；沒有就當全可見）")
    p.add_argument("--reference-frame", type=int, help="參考影格 K（不給就自動：關鍵幀→遮罩靜止幀）")
    p.add_argument("--quad", help="參考影格的表面四角 x1,y1,…,x4,y4（TL,TR,BR,BL）")
    p.add_argument("--keyframe", action="append", default=[], help="硬釘 K:x1,y1,…,x4,y4，可重複")
    p.add_argument("--tracking-region", help="追蹤區域四角 x1,y1,…,x4,y4（預設＝整個表面）")
    p.add_argument("--upsample", type=int, default=1, choices=(1, 2, 3), help="遠景放大 ROI 解（2）")
    p.add_argument("--motion-model", default="perspective", choices=("translation", "similarity", "affine", "perspective"))
    p.add_argument("--no-smoothing", action="store_true", help="關閉 Savitzky-Golay 平滑（STATIC 中位數仍做）")
    p.add_argument("--smoothing-window", type=int, default=9)
    p.add_argument("--track-id", default="track1")
    p.add_argument("--out", help="solve.v1.json 路徑（預設 <cache>/media/<fp16>/tracks/<trackId>/solve.v1.json）")
    p.add_argument("--no-hud", action="store_true", help="不寫 solve.hud.v1.json 側檔")
    p.add_argument("--clear-forwards", type=int, help="只清除既有 solve 中 K 之後的幀並存回")
    p.add_argument("--clear-backwards", type=int, help="只清除既有 solve 中 K 之前的幀並存回")
    p.add_argument("--retrack-from", type=int, help="從 K 起重追（預設往後；--backwards 往前），其餘幀保留")
    p.add_argument("--backwards", action="store_true")
    p.add_argument("--from", dest="k_from", type=int, help="只追 [K_FROM, K_TO) 子範圍；既有 solve 在範圍外的幀保留")
    p.add_argument("--to", dest="k_to", type=int)


# ---------------------------------------------------------------- 子範圍合併


def _subrange(shot: tuple[int, int], k_from: int | None, k_to: int | None) -> tuple[int, int]:
    """與 run_track 相同的夾法：子範圍夾進鏡頭。"""
    a = shot[0] if k_from is None else max(shot[0], int(k_from))
    b = shot[1] if k_to is None else min(shot[1], int(k_to))
    return a, b


def merge_subrange(existing: "Solve", fresh: "Solve", k_from: int | None, k_to: int | None, *, reference_given: bool) -> tuple["Solve", set[int]]:
    """子範圍重解（resolveAround / 單步 / 追到頭尾）只換 [a, b) 的幀，其餘沿用既有 solve。

    以前 run_track 只回範圍內的幀、write 直接蓋檔 → 範圍外的解全被刪（review #19）。
    - referenceFrame：沒明確指定就沿用既有的；有指定就用新的，並把新參考影格那一列（本次追蹤的種子）一起換掉。
    - 鏡頭以本次 --shot 為準：鏡頭外的舊幀丟掉（solve 屬於鏡頭，不能把別的鏡頭的幾何帶去 render）。
    - 模板尺寸不同：舊 H 右乘縮放，讓舊幀的四角維持不變（H 把模板座標映到畫面）。
    回 (合併後的 solve, 本次換掉的 k 集合)。
    """
    from ..track.state import Solve

    a, b = _subrange(fresh.shot, k_from, k_to)
    s0, s1 = fresh.shot
    take_ref = reference_given or existing.reference_frame is None  # 舊檔沒有參考影格也只能用新的
    ref = fresh.reference_frame if take_ref else existing.reference_frame
    merged = Solve(fresh.track_id, fresh.shot, ref, fresh.template_wh)
    scale = None
    if tuple(existing.template_wh) != tuple(fresh.template_wh):
        scale = np.diag([existing.template_wh[0] / fresh.template_wh[0], existing.template_wh[1] / fresh.template_wh[1], 1.0])
    for k, f in existing.frames.items():
        if a <= k < b or not (s0 <= k < s1):
            continue
        if scale is not None:
            f.H = None if f.H is None else f.H @ scale
            f.H_raw = None if f.H_raw is None else f.H_raw @ scale
        f.pinned = k == ref
        merged.frames[k] = f
    replaced: set[int] = set()
    for k, f in fresh.frames.items():
        if a <= k < b or (take_ref and k == fresh.reference_frame):
            merged.frames[k] = f
            replaced.add(k)
    return merged, replaced


def _write_merged_hud(hud: Path, merged: "Solve", replaced: set[int], template_changed: bool) -> None:
    """HUD 側檔同樣只換本次重解的幀：舊幀的內點／外點／cc 從既有側檔搬過來（Solve.read 讀不回那些欄位）。"""
    old: dict[int, dict] = {}
    if hud.is_file() and not template_changed:
        try:
            old = {int(r["k"]): r for r in json.loads(hud.read_text(encoding="utf-8")).get("frames", [])}
        except (OSError, ValueError, KeyError, TypeError):
            old = {}
    obj = merged.hud_json_obj()
    obj["frames"] = [old[r["k"]] if (r["k"] not in replaced and r["k"] in old) else r for r in obj["frames"]]
    hud.parent.mkdir(parents=True, exist_ok=True)
    hud.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")


# ---------------------------------------------------------------- 沒有 --template：從參考影格的四角取模板

TEMPLATE_PNG = "template.png"  # 從畫面取出的模板存在 solve 旁邊：之後 --retrack-from／--clear-* 沒有四角也能重用
TEMPLATE_MAX_SIDE = 1024
TEMPLATE_MIN_SIDE = 16


def template_size_for_quad(quad: np.ndarray) -> tuple[int, int]:
    """四角（TL,TR,BR,BL）→ 模板 (w, h)：上下邊平均長 × 左右邊平均長（表面在幀裡的原生大小，不放大），長邊上限 1024。"""
    q = np.asarray(quad, np.float64).reshape(4, 2)
    w = 0.5 * (np.linalg.norm(q[1] - q[0]) + np.linalg.norm(q[2] - q[3]))
    h = 0.5 * (np.linalg.norm(q[3] - q[0]) + np.linalg.norm(q[2] - q[1]))
    s = min(1.0, TEMPLATE_MAX_SIDE / max(w, h, 1e-9))
    return max(TEMPLATE_MIN_SIDE, int(round(w * s))), max(TEMPLATE_MIN_SIDE, int(round(h * s)))


def template_from_reference(frames: Any, keyframes: dict[int, np.ndarray], reference_frame: Any, saved: Path, ctx: Ctx) -> tuple[Any, dict[str, Any]]:
    """沒有 --template 的 classic 追蹤：參考影格（--reference-frame；沒給就取最早的關鍵幀）的四角矯正出模板
    （`track.template.template_from_frame`），存成 solve 旁邊的 template.png；沒有四角時讀上次存的 template.png。"""
    from ..seg import preview
    from ..track.template import load_template, template_from_frame

    ref = None if reference_frame is None else int(reference_frame)
    if ref is not None and ref not in keyframes:
        ref = None if keyframes else ref
    if ref is None and keyframes:
        ref = min(keyframes)
    if ref is not None and ref in keyframes:
        if not 0 <= ref < frames.n:
            raise OpError("Invalid", f"參考影格 {ref} 超出 proxy 幀範圍 [0, {frames.n})")
        quad = keyframes[ref]
        wh = template_size_for_quad(quad)
        tmpl = template_from_frame(frames.get(ref), quad, wh, name=f"frame {ref}")
        path = preview.save_png(saved, tmpl.image)
        ctx.artifact(path, "template")
        ctx.log("info", f"沒有 --template：從第 {ref} 幀的四角取模板 {wh[0]}×{wh[1]} → {path}")
        return tmpl, {"source": "frame", "frame": ref, "size": [wh[0], wh[1]], "path": path}
    if saved.is_file():
        tmpl = load_template(str(saved))
        return tmpl, {"source": "saved", "path": str(saved), "size": [tmpl.w, tmpl.h]}
    others = list(_methods())
    raise OpError(
        "Invalid", "classic 追蹤需要 --template，或參考影格的四角（--quad 搭配 --reference-frame，或 --keyframe K:…）",
        f"沒有模板也可以改用其他追蹤方法：--method {'|'.join(others)}" if others else "給四角時會從那一幀取出模板（存成 solve 旁邊的 template.png）",
    )


# ---------------------------------------------------------------- op


@register("track.solve", cli="track", help="平面追蹤：模板→幀 SIFT+MAGSAC+ECC，輸出 solve.v1.json", args=_args)
def track_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..track.runner import TrackInputs, clear_backwards, clear_forwards, retrack_from, run_track
    from ..track.state import Solve, TrackOptions
    from ..track.template import load_template

    video = Path(env.normalize_path(args["video"]))
    if not video.is_file():
        raise OpError("Io", f"找不到影片 {video}")
    method = str(args.get("method") or "classic")
    if method != "classic":
        m = _methods().get(method)
        if m is None:
            raise OpError("Invalid", f"未知的追蹤方法 {method!r}", f"可用：{', '.join(['classic', *_methods()])}")
        return m.run(args, ctx, video)
    template_path: Path | None = None
    if args.get("template"):
        template_path = Path(env.normalize_path(args["template"]))
        if not template_path.is_file():
            raise OpError("Io", f"找不到模板 {template_path}")
    shot = _parse_shot(args["shot"])
    track_id = str(args.get("track_id") or "track1")

    template = load_template(str(template_path)) if template_path is not None else None
    keyframes: dict[int, np.ndarray] = {}
    for kf in args.get("keyframe") or []:
        try:
            ks, qs = kf.split(":", 1)
            keyframes[int(ks)] = _parse_quad(qs)
        except ValueError as e:
            raise OpError("Invalid", f"--keyframe 格式為 K:x1,y1,…,x4,y4，收到 {kf!r}") from e
    if args.get("quad"):
        if args.get("reference_frame") is None:
            raise OpError("Invalid", "--quad 需要搭配 --reference-frame K")
        keyframes[int(args["reference_frame"])] = _parse_quad(args["quad"])

    opts = TrackOptions(
        motion_model=str(args.get("motion_model") or "perspective"),
        smoothing=0 if args.get("no_smoothing") else int(args.get("smoothing_window") or 9),
        upsample=int(args.get("upsample") or 1),
    )
    frames = ProxyFrames(str(video), ctx)
    try:
        # 預設輸出落在 media 快取目錄（與 run.py 的 P.media_cache(fp).solve(tid) 同一個 <fp16>）
        out = Path(env.normalize_path(args["out"])) if args.get("out") else frames.mc.dir / "tracks" / track_id / "solve.v1.json"
        hud = None if args.get("no_hud") else out.with_name("solve.hud.v1.json")
        if shot[0] >= frames.n:
            raise OpError("Invalid", f"--shot 下界 {shot[0]} 超過 proxy 幀數 {frames.n}")
        if shot[1] > frames.n:
            ctx.log("warn", f"--shot 上界 {shot[1]} 超過 proxy 幀數 {frames.n}，截斷")
            shot = (shot[0], frames.n)
        template_info: dict[str, Any] = {"source": "file", "path": str(template_path)} if template_path is not None else {}
        if template is None:
            template, template_info = template_from_reference(frames, keyframes, args.get("reference_frame"), out.with_name(TEMPLATE_PNG), ctx)
            if args.get("reference_frame") is None and template_info.get("frame") is not None:
                args = {**args, "reference_frame": int(template_info["frame"])}
        get_mask = None
        if args.get("masks"):
            from ..track._aivm_read import read_aivm

            reader = read_aivm(env.normalize_path(args["masks"]))
            if (reader.width, reader.height) != (frames.width, frames.height):
                raise OpError("Invalid", f"遮罩尺寸 {reader.width}×{reader.height} ≠ 影片 {frames.width}×{frames.height}")
            get_mask = reader.mask

        inp = TrackInputs(
            get_frame=frames.get,
            template=template,
            shot=shot,
            get_mask=get_mask,
            reference_frame=args.get("reference_frame"),
            user_keyframes=keyframes,
            tracking_region=_parse_quad(args["tracking_region"]) if args.get("tracking_region") else None,
            options=opts,
            track_id=track_id,
        )

        t0 = time.perf_counter()
        replaced: set[int] | None = None
        template_changed = False
        if args.get("clear_forwards") is not None or args.get("clear_backwards") is not None or args.get("retrack_from") is not None:
            if not out.is_file():
                raise OpError("Io", f"要修改的 solve 不存在：{out}", "先跑一次完整追蹤")
            solve = Solve.read(out)
            action = "edit"
            if args.get("clear_forwards") is not None:
                clear_forwards(solve, int(args["clear_forwards"]))
            if args.get("clear_backwards") is not None:
                clear_backwards(solve, int(args["clear_backwards"]))
            if args.get("retrack_from") is not None:
                action = "retrack"
                solve = retrack_from(inp, solve, int(args["retrack_from"]), ctx, direction=-1 if args.get("backwards") else 1)
        else:
            action = "solve"
            k_from, k_to = args.get("k_from"), args.get("k_to")
            solve = run_track(inp, ctx, k_from=k_from, k_to=k_to)
            if (k_from is not None or k_to is not None) and out.is_file():
                try:
                    existing = Solve.read(out)
                except (OSError, ValueError, KeyError, TypeError, IndexError) as e:
                    ctx.log("warn", f"既有 solve 讀不了（{e}），子範圍結果直接覆蓋")
                else:
                    template_changed = tuple(existing.template_wh) != tuple(solve.template_wh)
                    solve, replaced = merge_subrange(existing, solve, k_from, k_to, reference_given=args.get("reference_frame") is not None)
    finally:
        frames.close()
    elapsed = time.perf_counter() - t0
    if replaced is None:
        solve.write(out, hud)
    else:
        solve.write(out, None)
        if hud is not None:
            _write_merged_hud(hud, solve, replaced, template_changed)
    ctx.artifact(str(out), "solve")
    if hud is not None:
        ctx.artifact(str(hud), "solve-hud")
    n = len(solve.frames)
    confs = [f.conf for f in solve.frames.values()]
    return {
        "action": action,
        "solvePath": str(out),
        "hudPath": None if hud is None else str(hud),
        "trackId": track_id,
        "shot": [shot[0], shot[1]],
        "referenceFrame": solve.reference_frame,
        "frames": n,
        "merged": replaced is not None,  # 子範圍併進既有 solve（action 仍是 "solve"，呼叫端不必改）
        "framesReplaced": None if replaced is None else len(replaced),
        "counts": solve.counts(),
        "meanConf": round(float(np.mean(confs)), 4) if confs else 0.0,
        "elapsedS": round(elapsed, 2),
        "sPerFrame": round(elapsed / n, 4) if n else None,
        "template": template_info,
    }


@register("geom.quad_from_mask", cli=None, help="遮罩 → 四角（sidecar 用）")
def quad_from_mask_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    """args: {maskPng: path} 或 {masks: aivm 路徑, frame: k}；可選 refTl:[x,y]。"""
    import cv2

    from ..geom.quad import quad_from_mask

    if args.get("maskPng"):
        from ..imageio import imread_unicode

        try:
            m = imread_unicode(env.normalize_path(args["maskPng"]), cv2.IMREAD_GRAYSCALE)
        except OSError as e:
            raise OpError("Io", f"讀不到遮罩 {args['maskPng']}") from e
        except ValueError as e:
            raise OpError("Io", str(e)) from e
        mask = m > 127
    elif args.get("masks") is not None and args.get("frame") is not None:
        from ..track._aivm_read import read_aivm

        try:
            mask = read_aivm(env.normalize_path(args["masks"])).mask(int(args["frame"]))
        except OSError as e:  # 主 lane 正在 os.replace masks.aivm（B-06）／檔案不見：要是 Io 不是 Internal
            raise OpError("Io", f"讀不到遮罩檔 {args['masks']}：{e}") from e
        except ValueError as e:  # 半寫／舊版的 .aivm
            raise OpError("Io", f"遮罩檔無法解析：{e}") from e
        if mask is None:
            return {"quad": None, "conf": 0.0, "method": "absent"}
    else:
        raise OpError("Invalid", "需要 maskPng 或 masks+frame")
    ref = args.get("refTl")
    r = quad_from_mask(mask, ref_tl=None if ref is None else np.asarray(ref, dtype=np.float64))
    return {"quad": None if r.quad is None else np.round(r.quad, 3).tolist(), "conf": round(r.conf, 4), "iou": round(r.iou, 4), "method": r.method}
