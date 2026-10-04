"""`aivc probe | index | proxy | shots`（op `media.probe` / `media.index` / `media.proxy` / `media.shots`；計畫 §6.8）。

全部產物寫進 `<cache>/media/<fp16>/`（probe.v1.json / index.v1.json / proxy.mp4 + proxy.v1.json / shots.v1.json），
回傳路徑與摘要數字。重 import（av / numpy / cv2）放在 op 函式內，`aivc --help` 不會碰到。
"""
from __future__ import annotations

import argparse
import os
import time
from fractions import Fraction
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .. import atomic, env
from ..media.encode_plan import H264_CHAIN
from . import Ctx, OpError, register

if TYPE_CHECKING:
    from ..media.cache import MediaCache
    from ..media.cfr import CfrMap
    from ..media.index import PtsIndex
    from ..media.probe import Probe

PROXY_GOP = 15
PROXY_MAX_HEIGHT = 1080


# ---------------------------------------------------------------- 共用參數
def _arg_video(p: argparse.ArgumentParser) -> None:
    p.add_argument("video", help="影片路徑")


def _arg_force(p: argparse.ArgumentParser) -> None:
    p.add_argument("--force", action="store_true", help="忽略既有快取重算")


def _arg_fps(p: argparse.ArgumentParser) -> None:
    p.add_argument("--fps", default=None, help="覆寫 proxy fps（N/D 或 N；預設來源 r_frame_rate）")


def parse_fps(s: str | None) -> tuple[int, int] | None:
    if s is None or s == "":
        return None
    try:
        f = Fraction(str(s))
    except (ValueError, ZeroDivisionError) as e:
        raise OpError("Invalid", f"--fps 格式錯誤：{s!r}", hint="例如 30、30/1、30000/1001") from e
    if f <= 0:
        raise OpError("Invalid", f"--fps 必須 > 0：{s!r}")
    return f.numerator, f.denominator


# ---------------------------------------------------------------- 共用步驟（bench_media 也用）
def resolve_video(args: dict[str, Any]) -> str:
    raw = args.get("video")
    if not raw:
        raise OpError("Invalid", "缺少影片路徑")
    p = env.normalize_path(os.path.abspath(str(raw)))
    if not os.path.isfile(p):
        raise OpError("Invalid", f"找不到影片：{p}")
    return p


_INDEX_LOCK_WAIT_S = 900.0  # 等別條 lane 建索引最多 15 分鐘（最長的片子也夠）；逾時就自己建


def open_media(video: str, ctx: Ctx, force: bool = False) -> tuple["MediaCache", "Probe"]:
    """指紋 → 快取目錄 → probe（有快取就讀）。"""
    from ..media import cache as C
    from ..media import probe as P

    try:
        mc = C.for_file(video)
    except OSError as e:
        raise OpError("Io", f"讀取影片失敗：{e}") from e
    mc.ensure()
    pr = None if force else P.load_probe(mc.probe_json)
    if pr is None or pr.path != video or pr.size_bytes != os.path.getsize(video):
        try:
            pr = P.probe(video)
        except Exception as e:  # noqa: BLE001
            raise OpError("Invalid", f"不是可解碼的影片：{e}", hint="PyAV 與 ffprobe 都讀不了") from e
        P.save_probe(mc.probe_json, pr)
        ctx.log("info", f"probe: {pr.width}x{pr.height} {pr.codec} {pr.fps} range={pr.color_range} matrix={pr.color_space or '?'}→{pr.matrix_assumed}")
    return mc, pr


def ensure_index(
    video: str, mc: "MediaCache", pr: "Probe", ctx: Ctx, fps: tuple[int, int] | None = None, force: bool = False
) -> tuple["PtsIndex", "CfrMap", bool]:
    """index.v1.json（含 cfr）有就讀、fps 不同或 --force 就重建。回 (index, cfr, rebuilt)。"""
    from ..media import index as I
    from ..media.cfr import CfrMap

    want = fps or (pr.fps_num, pr.fps_den)

    def cached() -> tuple["PtsIndex", "CfrMap"] | None:
        loaded = I.load_index(mc.index_json)
        if not loaded:
            return None
        idx, cfr_json = loaded
        if (idx.fps_num, idx.fps_den) != want:
            return None
        try:
            cfr = CfrMap.from_json(cfr_json) if cfr_json else CfrMap.from_index(idx.pts_ms, want)
        except (KeyError, ValueError, TypeError):
            return None  # 壞快取 → 重建
        return (idx, cfr) if cfr.n_source == idx.n else None

    if not force:
        hit = cached()
        if hit:
            return hit[0], hit[1], False
    # 同一支影片的索引，一個行程只建一次（B-06）：兩條 worker lane 冷快取時會各解一次整支影片
    # （render.run 在主 lane、render.plan 在輕量 lane，70–136 s 的解碼做兩遍）。
    # 等鎖時照樣 check_cancel，等太久（極罕見）就自己建一份 —— 暫存檔名是唯一的，重複建只是慢不會壞。
    lock = atomic.keyed_lock(mc.index_json)
    held = False
    deadline = time.monotonic() + _INDEX_LOCK_WAIT_S
    while time.monotonic() < deadline:
        if lock.acquire(timeout=0.25):
            held = True
            break
        ctx.check_cancel()
    try:
        if held and not force:
            hit = cached()  # 等鎖期間別條 lane 可能已經建好了
            if hit:
                return hit[0], hit[1], False
        t0 = time.perf_counter()
        try:
            idx = I.build_index(video, ctx, fps=want)
        except Exception as e:  # noqa: BLE001
            if type(e).__name__ == "Canceled":
                raise
            raise OpError("Invalid", f"解碼失敗：{e}") from e
        cfr = CfrMap.from_index(idx.pts_ms, want)
        I.save_index(mc.index_json, idx, cfr)
        ctx.log("info", f"index: {idx.n} 幀 → proxy {cfr.n_frames} 幀（{time.perf_counter() - t0:.1f}s）")
        return idx, cfr, True
    finally:
        if held:
            lock.release()


def gap_stats(idx: "PtsIndex") -> dict[str, Any]:
    if idx.n < 2:
        return {"count": 0, "minMs": None, "maxMs": None, "medianMs": None, "over40ms": []}
    d = sorted(idx.pts_ms[i] - idx.pts_ms[i - 1] for i in range(1, idx.n))
    return {
        "count": len(d),
        "minMs": round(d[0], 3),
        "maxMs": round(d[-1], 3),
        "medianMs": round(d[len(d) // 2], 3),
        "over40ms": idx.gaps(40.0)[:20],
    }


def proxy_dims(width: int, height: int, max_height: int) -> tuple[int, int, float]:
    """來源解析度為主；超過 max_height 才縮，尺寸取偶數；回 (w, h, scale=proxy/source)。"""
    if height <= max_height:
        return width - width % 2, height - height % 2, 1.0
    scale = max_height / height
    w = int(round(width * scale / 2)) * 2
    h = max_height - max_height % 2
    return w, h, h / height


# ---------------------------------------------------------------- probe
def _probe_args(p: argparse.ArgumentParser) -> None:
    _arg_video(p)
    _arg_force(p)


@register("media.probe", cli="probe", help="影片事實（解析度／fps／色彩 tag／音軌）+ 指紋 → probe.v1.json", args=_probe_args)
def probe_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    video = resolve_video(args)
    mc, pr = open_media(video, ctx, force=bool(args.get("force")))
    d = pr.to_json()
    human = "\n".join(
        [
            f"檔案        {video}",
            f"指紋        {mc.fingerprint}  (dir {mc.dir})",
            f"容器/編碼   {pr.container} / {pr.codec}  {pr.width}x{pr.height} {pr.pix_fmt}",
            f"fps         r_frame_rate {pr.fps_num}/{pr.fps_den}  avg {pr.avg_fps_num}/{pr.avg_fps_den}  time_base {pr.time_base_num}/{pr.time_base_den}",
            f"長度        duration_ms={pr.duration_ms}  nb_frames={pr.nb_frames}  start_ms={pr.start_ms}",
            f"色彩        range={pr.color_range} matrix={pr.color_space} primaries={pr.color_primaries} trc={pr.color_trc} → 採用 {pr.matrix_assumed}（{pr.matrix_source}）",
            f"旋轉/B幀    rotation={pr.rotation}  has_b_frames={pr.has_b_frames}",
            f"音訊        {pr.audio_codec} {pr.audio_sample_rate} Hz {pr.audio_channels} ch" if pr.has_audio else "音訊        （無）",
            f"來源        {pr.source}；已寫 {mc.probe_json}",
        ]
    )
    return {"fingerprint": mc.fingerprint, "cacheDir": str(mc.dir), "probePath": str(mc.probe_json), "probe": d, "_human": human}


# ---------------------------------------------------------------- index
def _index_args(p: argparse.ArgumentParser) -> None:
    _arg_video(p)
    _arg_fps(p)
    _arg_force(p)


@register("media.index", cli="index", help="完整解碼一趟建 PTS 索引 + VFR→CFR 對應 → index.v1.json", args=_index_args)
def index_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    video = resolve_video(args)
    force = bool(args.get("force"))
    mc, pr = open_media(video, ctx, force=False)
    t0 = time.perf_counter()
    idx, cfr, rebuilt = ensure_index(video, mc, pr, ctx, fps=parse_fps(args.get("fps")), force=force)
    dropped = cfr.dropped_sources()
    gaps = gap_stats(idx)
    result = {
        "fingerprint": mc.fingerprint,
        "indexPath": str(mc.index_json),
        "rebuilt": rebuilt,
        "seconds": round(time.perf_counter() - t0, 3),
        "fps": {"num": cfr.fps_num, "den": cfr.fps_den},
        "nSource": idx.n,
        "nFrames": cfr.n_frames,
        "keyframes": sum(idx.key),
        "duplicates": cfr.duplicate_count,
        "dropped": len(dropped),
        "droppedList": dropped[:50],
        "runs": len(cfr.runs),
        "gaps": gaps,
        "firstPtsMs": idx.pts_ms[0],
        "lastPtsMs": idx.pts_ms[-1],
    }
    over = ", ".join(f"src {g['src']}@{g['pts_ms'] / 1000:.3f}s +{g['gap_ms']:.0f}ms" for g in gaps["over40ms"]) or "（無）"
    result["_human"] = "\n".join(
        [
            f"來源幀數    {idx.n}（關鍵幀 {sum(idx.key)}）  pts {idx.pts_ms[0]:.0f}–{idx.pts_ms[-1]:.0f} ms",
            f"proxy 幀數  N = {cfr.n_frames} @ {cfr.fps_num}/{cfr.fps_den} fps  runs={len(cfr.runs)}",
            f"重複/丟幀   duplicates={cfr.duplicate_count}  dropped={len(dropped)}",
            f"間隔        min {gaps['minMs']} / median {gaps['medianMs']} / max {gaps['maxMs']} ms；≥40 ms：{over}",
            f"{'重建' if rebuilt else '快取'}  {mc.index_json}（{result['seconds']}s）",
        ]
    )
    return result


# ---------------------------------------------------------------- proxy
def _proxy_args(p: argparse.ArgumentParser) -> None:
    _arg_video(p)
    _arg_fps(p)
    p.add_argument("--max-height", type=int, default=PROXY_MAX_HEIGHT, help=f"超過才縮（預設 {PROXY_MAX_HEIGHT}）")
    p.add_argument(
        "--codec", default="auto", choices=["auto", *PROXY_CODECS],
        help="auto = 依序試 " + " → ".join(PROXY_CODECS) + "，用第一個真的編得出來的",
    )
    p.add_argument("--cq", type=int, default=19, help="h264_nvenc 的 -cq／libx264 的 -crf（預設 19；只吃位元率的編碼器忽略）")
    _arg_force(p)


# proxy 只做 H.264 階梯（WebView 播放相容性）；順序與理由見 media/encode_plan.H264_CHAIN（純 dataclass 模組，頂層 import 不拖慢 --help）
PROXY_CODECS = H264_CHAIN


@register("media.proxy", cli="proxy", help="CFR proxy.mp4（來源解析度、H.264 階梯 nvenc→openh264→videotoolbox→x264→mpeg4、GOP 15、aac、bt709 tv）", args=_proxy_args)
def proxy_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..media import cache as C
    from ..media import encode_plan as EP
    from ..media import encoder as EN
    from ..media import ffmpeg as ff
    from ..media.source import FrameSource

    video = resolve_video(args)
    force = bool(args.get("force"))
    mc, pr = open_media(video, ctx)
    idx, cfr, _ = ensure_index(video, mc, pr, ctx, fps=parse_fps(args.get("fps")), force=False)
    max_h = int(args.get("max_height") or PROXY_MAX_HEIGHT)
    w, h, scale = proxy_dims(pr.width, pr.height, max_h)

    existing = None if force else C.read_json(mc.proxy_json)
    if existing and mc.proxy_mp4.is_file() and existing.get("frames") == cfr.n_frames and existing.get("width") == w and existing.get("height") == h \
            and existing.get("fps") == {"num": cfr.fps_num, "den": cfr.fps_den}:
        existing["_human"] = f"proxy 已存在：{mc.proxy_mp4}（{existing.get('frames')} 幀 {w}x{h}，--force 重做）"
        existing["proxyPath"] = str(mc.proxy_mp4)
        existing["cached"] = True
        return existing

    # 編碼器：沿 H.264 階梯逐一試編 2 幀，第一個真的能用的勝出。
    # 以前只認 h264_nvenc → libopenh264：Homebrew／Ubuntu 的 ffmpeg 都沒有 openh264，Mac 與 Linux 每支影片的 proxy 都建不起來。
    want = args.get("codec") or "auto"
    listed = ff.list_encoders()
    if want == "auto":
        usable, chain = EP.probe_chain(listed, ff.encoder_usable, PROXY_CODECS)
        spec_codec = EP.H264_ALIAS
    else:
        if want not in PROXY_CODECS:
            raise OpError("Invalid", f"proxy 不支援編碼器 {want!r}", hint="可選：auto " + " ".join(PROXY_CODECS))
        if want not in listed:
            raise OpError("Ffmpeg", f"這份 ffmpeg 沒有 {want}", hint=f"用 --codec auto（ffmpeg：{env.ffmpeg_dir()}）")
        if not ff.encoder_usable(want):
            why = {"h264_nvenc": "沒有 NVIDIA GPU／驅動太舊", "h264_videotoolbox": "VideoToolbox 開不了編碼 session（虛擬機裡常見）"}.get(want, "試編失敗")
            raise OpError("Ffmpeg", f"{want} 不可用（{why}）", hint="用 --codec auto")
        usable, chain, spec_codec = listed, [{"codec": want, "status": "requested"}], want
    # content_note=""：proxy 是內部快取（UI 播放用、不對外），不寫內容揭露 tag；proxy 的 bytes 維持與以前相同
    spec = EP.EncodeSpec(container="mp4", codec=spec_codec, quality=19 if args.get("cq") is None else int(args["cq"]), audio="auto", gpu=True, content_note="")
    plan = EP.plan(spec, EP.SourceInfo.from_probe(pr), usable)
    codec = plan.video_codec
    extra = ["-g", str(PROXY_GOP)]
    if codec in EP.BITRATE_CODECS:
        # proxy 要 PSNR>40 dB 才能當「幀號真相」；只吃位元率的編碼器 → 0.3 bpp（720p30 ≈ 8.3 Mbps），蓋掉計畫的匯出用位元率
        extra += ["-b:v", f"{EP.video_bitrate_kbps(w, h, cfr.fps_num, cfr.fps_den, bpp=0.3)}k"]
    if codec == "libx264":
        # -bf 0：與 Windows 的 openh264 proxy 同樣沒有 B 幀（沒有 edit list／組成時間偏移），各平台 WebView 逐幀定位行為一致；
        # veryfast：每次匯入都要建 proxy，crf 19 下畫質仍遠高於 40 dB，速度比 medium 快數倍（ffmpeg 同名選項後者為準）
        extra += ["-bf", "0", "-preset", "veryfast"]
    for n in plan.notes:
        ctx.log("info", f"proxy 編碼：{n}")
    for d in plan.dropped:
        ctx.log("warn", f"proxy 編碼：{d}")
    ctx.log("info", f"proxy: {w}x{h} scale={scale:.4f} N={cfr.n_frames} codec={codec} audio={plan.audio_mode}:{plan.audio_codec}")

    t0 = time.perf_counter()
    with FrameSource(video, idx, cfr, probe=pr, lru=8, ctx=ctx) as fs:

        def frames():  # noqa: ANN202
            last_src, last_fr = -1, None
            for k in range(cfr.n_frames):
                src = cfr.src_index(k)
                if src != last_src:  # 重複幀直接重送同一份 bytes（每個來源幀只解、只縮一次）
                    fr = fs.get(src)
                    if scale != 1.0:
                        fr = fr.resized(w, h)
                    last_src, last_fr = src, fr
                yield last_fr

        info = EN.write_frames(
            frames(), plan, mc.proxy_mp4, ctx, width=w, height=h, fps=(cfr.fps_num, cfr.fps_den), total=cfr.n_frames,
            audio_source=video, extra_video_args=extra, stage="proxy",
        )
        stats = dict(fs.stats)
    meta = {
        "version": 1,
        "fps": {"num": cfr.fps_num, "den": cfr.fps_den},
        "frames": cfr.n_frames,
        "width": w,
        "height": h,
        "scale": scale,
        "codec": codec,
        # 為什麼選這個編碼器：每個候選的試編狀態 + 計畫的 notes／dropped（Mac／Linux 使用者回報「proxy 很糊」時第一個要看的）
        "encoderChain": chain,
        "encoderNotes": plan.notes,
        "encoderDropped": plan.dropped,
        "gop": PROXY_GOP,
        "audio": plan.audio_codec,
        "sourceFingerprint": mc.fingerprint,
        "sourceFrames": idx.n,
        "bytes": info["bytes"],
        "seconds": info["seconds"],
    }
    C.write_json(mc.proxy_json, meta)
    ctx.artifact(str(mc.proxy_mp4), "proxy")
    dt = time.perf_counter() - t0
    meta.update(
        {
            "proxyPath": str(mc.proxy_mp4),
            "proxyMetaPath": str(mc.proxy_json),
            "cached": False,
            "decodeStats": stats,
            "_human": f"proxy {w}x{h} {cfr.n_frames} 幀 {codec} → {mc.proxy_mp4}（{info['bytes'] / 1e6:.1f} MB，{dt:.1f}s，{cfr.n_frames / dt:.0f} fps）",
        }
    )
    return meta


# ---------------------------------------------------------------- shots
def _shots_args(p: argparse.ArgumentParser) -> None:
    _arg_video(p)
    _arg_fps(p)
    p.add_argument("--threshold", type=float, default=None, help="scene score 門檻（ffmpeg scene 同尺度；預設 0.2，範例切點 0.30–0.36、鏡頭內 ≤0.15）")
    p.add_argument("--min-len", type=int, default=12, help="最短鏡頭長度（proxy 幀；預設 12）")
    _arg_force(p)


@register("media.shots", cli="shots", help="鏡頭切點（160x90 亮度差，ffmpeg scene 同尺度）→ shots.v1.json", args=_shots_args)
def shots_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..media import cache as C
    from ..media import shots as SH
    from ..media.source import FrameSource

    video = resolve_video(args)
    force = bool(args.get("force"))
    threshold = float(args.get("threshold") if args.get("threshold") is not None else SH.DEFAULT_THRESHOLD)
    min_len = int(args.get("min_len") or SH.DEFAULT_MIN_LEN)
    mc, pr = open_media(video, ctx)
    idx, cfr, _ = ensure_index(video, mc, pr, ctx, fps=parse_fps(args.get("fps")), force=False)

    existing = None if force else C.read_json(mc.shots_json)
    if existing and existing.get("nFrames") == cfr.n_frames and existing.get("params", {}).get("threshold") == threshold \
            and existing.get("params", {}).get("minLen") == min_len:
        existing.update({"shotsPath": str(mc.shots_json), "cached": True, "_human": _shots_human(existing["shots"], existing.get("cuts", []), cfr) + "\n（快取）"})
        return existing

    t0 = time.perf_counter()
    with FrameSource(video, idx, cfr, probe=pr, lru=4, ctx=ctx) as fs:
        shots, cuts = SH.detect_shots(fs.iter_frames(), cfr, threshold=threshold, min_len=min_len, ctx=ctx, total=idx.n)
    SH.save_shots(mc.shots_json, shots, cuts, cfr, threshold=threshold, min_len=min_len)
    return {
        "shotsPath": str(mc.shots_json),
        "nFrames": cfr.n_frames,
        "fps": {"num": cfr.fps_num, "den": cfr.fps_den},
        "params": {"threshold": threshold, "minLen": min_len},
        "shots": [s.to_json() for s in shots],
        "cuts": cuts,
        "seconds": round(time.perf_counter() - t0, 3),
        "cached": False,
        "_human": _shots_human([s.to_json() for s in shots], cuts, cfr),
    }


def _shots_human(shots: list[dict[str, Any]], cuts: list[dict[str, Any]], cfr: "CfrMap") -> str:
    fps = float(cfr.fps)
    lines = [f"{len(shots)} 個鏡頭 / {len(cuts)} 個切點（N={cfr.n_frames} @ {cfr.fps_num}/{cfr.fps_den}）"]
    for s in shots:
        lines.append(f"  {s['id']:<7} k {s['startFrame']:>5}–{s['endFrame']:<5} ({s['startFrame'] / fps:6.2f}–{s['endFrame'] / fps:6.2f} s) {s['kind']}")
    for c in cuts:
        lines.append(f"  cut @k={c['k']} ({c['k'] / fps:.2f} s, src {c['src']}) score={c['score']}")
    return "\n".join(lines)


# ---------------------------------------------------------------- audio_info（M2.5）
def _audio_info_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("video", help="影片或音訊檔路徑（mp4／webm／mkv／mp3／wav／m4a／flac／opus…）")
    _arg_force(p)


@register(
    "media.audio_info", cli="audio-info",
    help="音訊時間資訊（startUs／videoStartUs／nSamples／pts 斷層）→ audio.v1.json；序列混音與分離音訊的對齊依據",
    args=_audio_info_args,
)
def audio_info_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    """只解音訊一趟。不走 open_media：它的 probe 要求有影像串流，純音訊檔（音樂、旁白）會被擋掉。"""
    from ..media import audio_info as AI
    from ..media import cache as C

    raw = args.get("video") or args.get("path")
    if not raw:
        raise OpError("Invalid", "缺少媒體路徑")
    path = env.normalize_path(os.path.abspath(str(raw)))
    if not os.path.isfile(path):
        raise OpError("Invalid", f"找不到媒體檔：{path}")
    try:
        mc = C.for_file(path)
    except OSError as e:
        raise OpError("Io", f"讀取媒體檔失敗：{e}") from e
    try:
        scan, cached, reason = AI.ensure(path, mc, ctx, force=bool(args.get("force")))
    except OpError:
        raise
    except Exception as e:  # noqa: BLE001
        if type(e).__name__ == "Canceled":
            raise
        raise OpError("Invalid", f"解不開音訊：{e}", hint="PyAV 讀不了這個檔案的音訊串流") from e
    info = scan.info
    result: dict[str, Any] = {
        "fingerprint": mc.fingerprint,
        "audioInfoPath": str(AI.audio_info_path(mc)),
        "cached": cached,
        # missing／invalid 表示快取缺或過期（stale）而重算；ok 表示直接用快取；force 表示 --force
        "reason": reason,
        "hasAudio": scan.has_audio,
        # 寫進專案檔 media[].audio／audioMedia[].audio 的摘要（TS AudioInfoV2 同形狀）；沒有音訊為 null
        "audio": info.to_json() if info is not None else None,
        **{k: v for k, v in scan.to_json().items() if k not in ("version", "hasAudio", "audio")},
    }
    if info is None:
        result["_human"] = f"沒有可解碼的音訊串流：{path}"
        return result
    offset = f"{(info.start_us - info.video_start_us) / 1000:+.3f} ms（音訊相對影片）" if info.video_start_us is not None else "（純音訊檔）"
    gaps = ", ".join(f"@{a / 1e6:.3f}s +{d / 1000:.0f}ms" for a, d in info.gaps[:10]) or "（無）"
    result["_human"] = "\n".join(
        [
            f"音訊        {info.codec} {info.sample_rate} Hz {info.channels} ch {info.channel_layout or ''}".rstrip(),
            f"起點        startUs={info.start_us}  videoStartUs={info.video_start_us}  {offset}",
            f"長度        nSamples={info.n_samples}（{info.n_samples / info.sample_rate:.3f} s；解出 {scan.decoded_samples} 樣本、{scan.frames} 幀）",
            f"斷層 >20ms  {len(info.gaps)} 個：{gaps}" + (f"；重疊 {len(scan.overlaps)} 個" if scan.overlaps else ""),
            f"{'快取' if cached else '重算（' + reason + '）'}  {AI.audio_info_path(mc)}",
        ]
    )
    return result


__all__ = ["resolve_video", "open_media", "ensure_index", "gap_stats", "proxy_dims", "parse_fps", "PROXY_GOP"]
