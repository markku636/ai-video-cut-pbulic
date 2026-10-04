"""`aivc select <video> --frame K (--point x,y[:neg] … | --box x,y,w,h) --out DIR`（op `seg.select`）：在一幀上選出物件。

    aivc select <video> --frame K (--point x,y[:neg] ... | --box x,y,w,h) [--coords px|norm1000]
                [--propagate K0:K1] [--from DIR/obj<N>/masks.aivm] [--obj N] [--backend auto|sam3|sam2] --out DIR

三種用法，產物都是同一套：
- **手動**：使用者點加選／減選點、拉框（UI 送 px 座標）。
- **AI**：Claude Code／Codex 先看 `aivc frame --grid` 的圖，給 0–1000 座標（`--coords norm1000`），
  再看這支產出的 `overlay.png` 確認選對了沒、不對就再補點。
- **中段補修正點**（`--from` ＋ `--propagate`）：既有遮罩在 K 之前的幀原樣保留，只從 K 往後重算到範圍結尾
  （「在中段補一個修正點，只從那一幀往後重算」）。只給點沒給框時，提示由舊遮罩推導（外接框＋內部錨點，見 seg/prompts.py）。

產物：
- 沒有 `--propagate`：`DIR/mask.png`（0/255）、`DIR/overlay.png`（疊色＋提示點／框）、`DIR/select.v1.json`。
- 有 `--propagate`：另外寫 `DIR/obj<N>/masks.aivm`（N：`--obj`，沒給就從 `--from` 的路徑 obj<N> 推，再沒有就是 1）。
  **沒給 `--obj`（也沒有 `--from`）而 `DIR/obj1/masks.aivm` 已經存在 → OpError(Invalid)**：不默默蓋掉上一個物件，
  要新物件給下一個空號、要重做就明確給 `--obj 1`。
  `--from` 時寫出的檔＝舊檔 k < K 的條目 ＋ 新算的 [K, K1) ＋ 舊檔 k ≥ K1 的條目（範圍外的不碰）。

分數 `score`＝sigmoid(object score logit)：模型認為「這一幀有這個物件」的信心（SAM 2.1／SAM 3 追蹤器都只給這個）。
"""
from __future__ import annotations

import argparse
import json
import math
import re
import time
from pathlib import Path
from typing import Any

import numpy as np

from .. import atomic, env
from . import Ctx, OpError, register

STAGE = "seg.select"
FORMAT = "aivc.select.v1"


EPILOG = """例：
  手動：  aivc select clip.mp4 --frame 120 --point 640,360 --point 700,380:neg --out sel
  AI：    aivc frame clip.mp4 --at 120 --out f.png --grid      （看圖讀 0–1000 座標）
          aivc select clip.mp4 --frame 120 --coords norm1000 --box 420,300,180,260 --out sel   （再看 sel/overlay.png）
  傳播：  aivc select clip.mp4 --frame 120 --box ... --propagate 100:240 --out sel   → sel/obj1/masks.aivm
  修正：  aivc select clip.mp4 --frame 180 --point 690,400:neg --from sel/obj1/masks.aivm --propagate 100:240 --out sel
          （k < 180 保留舊遮罩，只從 180 往後重算；只給點時用舊遮罩「與點一致的那幾塊」的外接框＋內部錨點當提示；
            加選點都不在舊遮罩上＝重新指定目標，只用你給的點。漏出去的部分跟物件連在一起時，改給 --box 重新框選）
  第二個物件：aivc select clip.mp4 --frame 120 --box ... --propagate 100:240 --obj 2 --out sel
後端：auto＝本機有 SAM 3 權重用 SAM 3 追蹤器，否則 SAM 2.1（SAM 3 需要在 https://huggingface.co/facebook/sam3 申請存取）。"""


def _args(p: argparse.ArgumentParser) -> None:
    from ..seg.backends import BACKEND_CHOICES
    from ..seg.prompts import COORDS

    p.epilog = EPILOG
    p.formatter_class = argparse.RawDescriptionHelpFormatter
    p.add_argument("video", help="影片路徑（通常是 proxy）")
    p.add_argument("--frame", type=int, required=True, help="在哪一幀選（proxy 幀號 K）")
    p.add_argument("--point", action="append", default=[], metavar="x,y[:neg]", help="提示點；:neg＝減選（不屬於物件），預設加選。可重複")
    p.add_argument("--box", action="append", default=[], metavar="x,y,w,h", help="框（左上角＋寬高）；一次選一個物件，最多一個框")
    p.add_argument("--coords", choices=list(COORDS), default="px", help="座標單位：px（預設）｜norm1000（兩軸 0–1000，給 AI；換算 x/1000×寬）")
    p.add_argument("--propagate", default=None, metavar="K0:K1", help="沿 [K0, K1) 傳播並寫 obj<N>/masks.aivm（K 要在範圍內）")
    p.add_argument("--from", dest="from_masks", default=None, metavar="AIVM", help="修正既有遮罩：K 之前的幀保留，只從 K 往後重算（要配 --propagate）")
    p.add_argument("--obj", type=int, default=None, help="輸出的物件編號（obj<N>；預設從 --from 的路徑推，否則 1。沒給 --obj 而 obj1 已存在時報錯、不覆寫）")
    p.add_argument("--out", required=True, help="輸出目錄")
    p.add_argument("--backend", choices=list(BACKEND_CHOICES), default=None, help="auto（預設）：本機有 SAM 3 權重用 SAM 3 追蹤器，否則 SAM 2.1")
    p.add_argument("--sam", choices=["tiny", "small", "base", "large"], default="small", help="SAM 2.1 變體（預設 small）")
    p.add_argument("--device", default="auto", help="推論裝置 auto｜cuda｜cuda:N｜mps｜cpu（cpu 需 AIVC_ALLOW_CPU=1）")


def _range(s: str, n: int) -> tuple[int, int]:
    try:
        a, b = (int(v) for v in str(s).split(":"))
    except ValueError as e:
        raise OpError("Invalid", f"--propagate 要寫成 K0:K1，拿到 {s!r}") from e
    if a < 0 or b <= a or b > n:
        raise OpError("Invalid", f"--propagate 需要 0 <= K0 < K1 <= {n}，拿到 {a}:{b}")
    return a, b


def obj_from_path(p: str | None) -> int | None:
    if not p:
        return None
    for part in reversed(Path(p).parts[:-1]):
        m = re.fullmatch(r"obj(\d+)", part)
        if m:
            return max(1, int(m.group(1)))
    return None


def next_free_obj(out_dir: Path) -> int:
    """out_dir 底下第一個還沒有 masks.aivm 的 obj<N>（給錯誤訊息建議用的編號）。"""
    n = 1
    while (out_dir / f"obj{n}" / "masks.aivm").exists():
        n += 1
    return n


def _sigmoid(x: float) -> float:
    try:
        return 1.0 / (1.0 + math.exp(-float(x)))
    except OverflowError:
        return 0.0 if x < 0 else 1.0


@register("seg.select", cli="select", help="手動／AI 選取：一幀上用點或框選出物件（可傳播成 .aivm；--from 在中段補修正點只往後重算）", args=_args, gpu=True)
def seg_select(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..seg.backend import SegModelError
    from ..seg.backends import LABELS_SELECT, choose, fallback_log_line
    from ..seg.prompts import PromptError, parse_box, parse_point
    from .track import ProxyFrames

    video = env.normalize_path(str(args["video"]))
    if not Path(video).is_file():
        raise OpError("Io", f"找不到影片 {video}")
    if args.get("from_masks") is None and args.get("from"):
        args = {**args, "from_masks": args["from"]}  # sidecar 直接送 "from" 也可以（CLI 的 dest 是 from_masks）
    try:
        raw_points = [parse_point(s) for s in (args.get("point") or [])]
        boxes = [parse_box(s) for s in (args.get("box") or [])]
    except PromptError as e:
        raise OpError("Invalid", str(e)) from e
    if len(boxes) > 1:
        raise OpError("Invalid", f"一次選一個物件，最多一個 --box（拿到 {len(boxes)} 個）", hint="多個物件請分次 select、每次給不同的 --obj N，或用 aivc seg 的多個 --box")
    if args.get("from_masks") and not args.get("propagate"):
        raise OpError("Invalid", "--from 要配 --propagate（修正後要知道往後重算到哪一幀）")
    if not raw_points and not boxes and not args.get("from_masks"):
        raise OpError("Invalid", "至少要一個 --point 或 --box")
    try:
        choice = choose(args.get("backend"))
    except SegModelError as e:
        raise OpError(e.kind, str(e), e.hint) from e
    if choice.fallback:
        ctx.log("info", fallback_log_line(choice, "select"))
    if choice.name == "sam3":
        from .models import ensure_sam3

        ensure_sam3(ctx)  # 權重不在本機：在這裡下載（有進度、可取消），見 ops/models.ensure_sam3
    frames = ProxyFrames(video, ctx)
    try:
        return _select(args, ctx, video, frames, raw_points, boxes[0] if boxes else None, choice, LABELS_SELECT)
    finally:
        frames.close()


def _select(args: dict[str, Any], ctx: Ctx, video: str, frames: Any, raw_points: list[Any], raw_box: Any, choice: Any, labels: dict[str, str]) -> dict[str, Any]:
    from ..seg import backends as B
    from ..seg import preview, viz
    from ..seg.backend import SegModelError
    from ..seg.maskfile import MaskFile, MaskFileError
    from ..seg.prompts import PromptError, refine_prompts, to_pixels

    W, H, n = int(frames.width), int(frames.height), int(frames.n)
    K = int(args["frame"])
    if not 0 <= K < n:
        raise OpError("Invalid", f"--frame {K} 超出 proxy 幀範圍 [0, {n})")
    prop = _range(args["propagate"], n) if args.get("propagate") else None
    if prop is not None and not prop[0] <= K < prop[1]:
        raise OpError("Invalid", f"--frame {K} 不在 --propagate [{prop[0]}, {prop[1]}) 內")
    coords = str(args.get("coords") or "px")
    try:
        prompts = to_pixels(raw_points, raw_box, coords, W, H)
    except PromptError as e:
        raise OpError("Invalid", str(e)) from e
    out_dir = Path(env.normalize_path(str(args["out"])))
    from_path = env.normalize_path(str(args["from_masks"])) if args.get("from_masks") else None
    old = None
    if from_path:
        try:
            old = MaskFile.open(from_path)
        except FileNotFoundError as e:
            raise OpError("Io", f"找不到 --from 遮罩檔 {from_path}") from e
        except (MaskFileError, OSError) as e:
            raise OpError("Invalid", f"讀不了 --from 遮罩檔 {from_path}：{e}") from e
        if (old.width, old.height) != (W, H):
            raise OpError("Invalid", f"--from 遮罩是 {old.width}×{old.height}，影片是 {W}×{H}", hint="遮罩與影片要是同一支（通常是 proxy）")
        prompts = refine_prompts(old.get(K), prompts, W, H)
        if prompts.empty:
            raise OpError("Invalid", f"--from 的遮罩在第 {K} 幀是空的，又沒有給 --point／--box：沒有東西可以重算", hint="在這一幀補一個加選點或框")
        if (prompts.derived or {}).get("from") == "user-points":
            ctx.log("info", f"加選點都不在 --from 遮罩第 {K} 幀的物件上：當成重新指定目標，只用這次給的點（舊遮罩 k < {K} 的幀照樣保留）")
        elif (prompts.derived or {}).get("droppedComponents"):
            ctx.log("info", f"--from 遮罩第 {K} 幀有 {prompts.derived['droppedComponents']} 塊與這次的點不一致（含減選點／離加選點太遠），推導提示時沒用它們")
    obj = int(args["obj"]) if args.get("obj") is not None else (obj_from_path(from_path) or 1)
    if obj < 1:
        raise OpError("Invalid", f"--obj 從 1 開始（拿到 {obj}）")
    if prop is not None and args.get("obj") is None and from_path is None:
        target = out_dir / f"obj{obj}" / "masks.aivm"
        if target.exists():
            # 沒說要覆寫哪一個：以前一律寫 obj1，第二次 select 到同一個 --out 會把上一個物件整條追蹤蓋掉
            free = next_free_obj(out_dir)
            raise OpError(
                "Invalid", f"{target} 已經存在：沒有給 --obj 時不會覆寫既有的物件",
                hint=f"新的物件請加 --obj {free}；要重做 obj{obj} 請明確給 --obj {obj}（或用 --from {target} 只從這一幀往後修）",
            )

    backend = B.make_prompt_backend(choice, device=args.get("device") or "auto", sam_variant=args.get("sam") or "small")
    t0 = time.perf_counter()
    try:
        loaded = backend.loaded()  # 先載模型再解碼
    except SegModelError as e:
        raise OpError(e.kind, str(e), e.hint) from e
    load_s = time.perf_counter() - t0
    ctx.progress(STAGE, 0, 1, phase="prompt", frame=K)
    rgb = frames.get(K)
    session = backend.open_session((W, H))
    rles: dict[int, bytes | None] = {}
    t_prop = 0.0
    try:
        pts = list(prompts.points)
        if hasattr(session, "add_prompt_frame"):
            fm = session.add_prompt_frame(K, obj, rgb, points=pts, box=prompts.box)
            mask = fm.masks[obj]
            logit = fm.scores.get(obj)
        else:
            mask = session.add_prompt(K, obj, rgb, points=pts, box=prompts.box)
            logit = None
        if prop is not None:
            from ..seg import rle as _rle

            rles[K] = _rle.encode(mask) if mask.any() else None
            k0, k1 = prop
            fwd_n = k1 - 1 - K
            bwd_n = 0 if old is not None else K - k0
            total = max(1, fwd_n + bwd_n)
            done = 0
            tp = time.perf_counter()

            def feed(it: Any) -> Any:
                for k, img in it:
                    ctx.check_cancel()
                    yield k, img

            def record(fm2: Any) -> None:
                nonlocal done
                m = fm2.masks.get(obj)
                present = m is not None and fm2.scores.get(obj, 0.0) >= 0 and bool(m.any())
                rles[int(fm2.k)] = _rle.encode(m) if present else None
                done += 1
                ctx.progress(STAGE, done, total, phase="propagate", frame=fm2.k)

            if fwd_n > 0:
                for fm2 in session.propagate_frames(feed(frames.iter_frames(K + 1, k1)), "fwd"):
                    record(fm2)
            if bwd_n > 0:
                for fm2 in session.propagate_frames(feed(frames.iter_frames_reversed(k0, K)), "bwd"):
                    record(fm2)
            t_prop = time.perf_counter() - tp
    finally:
        session.close()

    out_dir.mkdir(parents=True, exist_ok=True)
    ys, xs = np.nonzero(mask)
    box = None if xs.size == 0 else [float(xs.min()), float(ys.min()), float(xs.max() + 1 - xs.min()), float(ys.max() + 1 - ys.min())]
    if xs.size == 0:
        ctx.log("warn", f"第 {K} 幀選出來的遮罩是空的：檢查提示座標（{coords}）")
    mask_png = preview.save_mask_png(out_dir / "mask.png", mask)
    img = viz.tint_masks(rgb, {obj: mask})
    derived = prompts.derived or {}
    user_points = prompts.points[1:] if derived.get("anchor") else prompts.points  # 推導出來的錨點另外畫成菱形
    viz.draw_prompts(img, user_points, None if derived else prompts.box, derived_box=derived.get("box"), derived_anchor=derived.get("anchor"))
    viz.title_bar(img, f"k={K}  obj{obj}  area={int(xs.size)}" + (f"  score={_sigmoid(logit):.3f}" if logit is not None else ""))
    overlay = preview.save_png(out_dir / "overlay.png", img)
    ctx.artifact(overlay, kind="preview")

    propagated = None
    if prop is not None:
        k0, k1 = prop
        new_items = sorted(rles.items())
        kept_before = kept_after = 0
        if old is not None:
            merged: dict[int, bytes | None] = {}
            for k, c in old.iter_rle():
                if k < K:
                    merged[k] = c
                    kept_before += 1
                elif k >= k1:
                    merged[k] = c
                    kept_after += 1
            merged.update(dict(new_items))
            items = sorted(merged.items())
        else:
            items = new_items
        path = out_dir / f"obj{obj}" / "masks.aivm"
        st = MaskFile.write_rle(path, W, H, items)
        ctx.artifact(st.path, kind="masks")
        propagated = {
            "range": [k0, k1],
            "recomputed": [K if old is not None else k0, k1],
            "masks": st.path,
            "framesPresent": st.n_present,
            "framesAbsent": st.n_absent,
            "keptFromOld": {"before": kept_before, "after": kept_after} if old is not None else None,
            "propagateSeconds": round(t_prop, 3),
        }

    result = {
        "format": FORMAT,
        "video": video,
        "frame": K,
        "obj": obj,
        "frameSize": [W, H],
        "coords": coords,
        "prompts": prompts.to_json(),
        "backend": choice.to_json(labels),
        "model": {"id": getattr(loaded, "model_id", None), "loadSeconds": round(load_s, 3)},
        "mask": mask_png,
        "overlay": overlay,
        "box": [round(v, 2) for v in box] if box is not None else None,
        "area": int(xs.size),
        "score": None if logit is None else round(_sigmoid(logit), 4),
        "from": from_path,
        "propagated": propagated,
    }
    atomic.write_text(out_dir / "select.v1.json", json.dumps(result, ensure_ascii=False, indent=1))
    result["_human"] = (
        f"第 {K} 幀 obj{obj}：面積 {int(xs.size)} px" + (f"，框 {[round(v) for v in box]}" if box else "（空的）")
        + (f"，信心 {result['score']:.3f}" if result["score"] is not None else "")
        + f"（{labels.get(choice.name, choice.name)}）\n  疊色預覽：{overlay}"
        + (f"\n  傳播 {propagated['recomputed'][0]}–{propagated['recomputed'][1] - 1} → {propagated['masks']}（在 {propagated['framesPresent']} 幀）" if propagated else "")
    )
    return result
