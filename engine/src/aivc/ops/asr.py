"""動態字幕的 ops（研究規格 §5.4）：語音辨識 → 字幕則 → 版面／圖集 → 預覽 → 匯出 → 選配 LLM 校對。

| op | CLI | 說明 |
|---|---|---|
| asr.transcribe   | transcribe        | faster-whisper（詞級時間、VAD、語言、模型、GPU→CPU 退路）→ `<cache>/asr/<key>.v1.json` |
| asr.doctor       | asr-doctor        | 非阻斷的 ASR 環境檢查（env.doctor 的 asr 區段）|
| captions.build   | captions-build    | ASR 檔 → CaptionTrackV1（決定性；預設寫回專案，--no-save 只回傳）|
| captions.layout  | captions-layout   | 舞台預覽用的 layout.v1.json + atlas.v1.png（±範圍）|
| captions.preview | captions-preview  | 第 k 幀的字幕疊圖 PNG（QA／golden）|
| captions.export  | captions-export   | SRT / VTT / ASS / TXT（UTF-8 無 BOM、LF）|
| captions.refine  | captions-refine   | 本機 LLM 校對建議（只回傳 proposal，不寫專案）|

sidecar 送的是 argparse 的 dest 名（`initial_prompt`、`compute_type`、`no_save`…），CLI 與 sidecar 共用同一支函式。
重 import（av / faster_whisper / Pillow / cv2）一律在函式內：`aivc --help` 與其他 op 的啟動不受影響。
"""
from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .. import env
from . import Ctx, OpError, register

if TYPE_CHECKING:
    from ..media.cfr import CfrMap
    from ..media.index import PtsIndex


# ---------------------------------------------------------------- 共用


def _parse_range(s: Any, n_frames: int) -> tuple[int, int] | None:
    from .render import parse_range

    return parse_range(str(s), n_frames) if s else None


def _hotwords(v: Any) -> list[str]:
    if not v:
        return []
    items = v if isinstance(v, (list, tuple)) else [v]
    out: list[str] = []
    for it in items:
        for part in str(it).replace("，", ",").replace("、", ",").replace("\n", ",").split(","):
            p = part.strip()
            if p and p not in out:
                out.append(p)
    return out


class _Media:
    """專案或單支影片 → 影片路徑、快取根、索引、CFR、（專案時）MediaContext。"""

    def __init__(self, args: dict[str, Any], ctx: Ctx) -> None:
        from ..project import paths as P
        from ..project import resolve as R
        from .media import ensure_index, open_media, resolve_video

        self.mctx = None
        if args.get("project"):
            self.mctx = R.open_media_context(env.normalize_path(str(args["project"])), args.get("media"), ctx)
            self.video = self.mctx.video
            self.cache_root = Path(self.mctx.cache.root)
            self.index: PtsIndex = self.mctx.index
            self.cfr: CfrMap = self.mctx.cfr
            self.size = self.mctx.size
            self.media_id: str | None = self.mctx.media_id
        elif args.get("video"):
            self.video = resolve_video(args)
            mc, pr = open_media(self.video, ctx)
            self.index, self.cfr, _ = ensure_index(self.video, mc, pr, ctx)
            self.cache_root = Path(P.media_cache(mc.fingerprint).root)
            self.size = (int(pr.width), int(pr.height))
            self.media_id = None
        else:
            raise OpError("Invalid", "需要 --project（加 --media）或影片路徑", "例如 aivc transcribe clip.webm 或 aivc transcribe --project x.aivc.json")

    @property
    def fps(self) -> tuple[int, int]:
        return int(self.cfr.fps_num), int(self.cfr.fps_den)


# ---------------------------------------------------------------- asr.transcribe


def _transcribe_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("video", nargs="?", default=None, help="影片路徑（或用 --project）")
    p.add_argument("--project", default=None, help="專案檔 *.aivc.json")
    p.add_argument("--media", default=None, help="專案內的 media id（預設 activeMediaId）")
    p.add_argument("--model", default="large-v3-turbo", help="tiny|base|small|medium|large-v3-turbo|large-v3|auto 或 HF repo id")
    p.add_argument("--language", default="auto", help="auto|zh|en|ja|ko|yue…（auto 在混語片會整段掉字，建議明確指定）")
    p.add_argument("--output-language", default=None, help="輸出文字語言（預設：zh → zh-TW 台灣繁體；其他同 ASR 語言）")
    p.add_argument("--convert", default="auto", choices=["auto", "none", "s2twp", "s2t", "s2hk", "t2s"], help="OpenCC 繁簡轉換（auto：輸出 zh-TW 且原文是簡體才轉）")
    p.add_argument("--device", default="auto", choices=["auto", "cuda", "cpu"], help="auto = GPU，失敗退 CPU int8；cuda = 不准退 CPU")
    p.add_argument("--compute-type", default="auto", help="auto|float16|int8_float16|int8|bfloat16…")
    p.add_argument("--beam-size", type=int, default=5)
    p.add_argument("--initial-prompt", default=None, help="Whisper 提示（預設：中文 → 繁中逐字稿提示）")
    p.add_argument("--hotwords", action="append", default=None, help="熱詞（逗號分隔或重複旗標）")
    p.add_argument("--vad-min-silence-ms", type=int, default=500, help="VAD 最短靜音（函式庫預設 2000 太長，句間停頓會被吞）")
    p.add_argument("--range", default=None, metavar="K0:K1", help="只辨識 proxy 幀 [K0,K1)")
    p.add_argument("--llm-url", default=None, help="選配：OpenAI 相容端點（例如 http://localhost:1234/v1）校對文字；連不上就略過")
    p.add_argument("--llm-model", default=None, help="LLM 模型 id（預設端點上的第一個）")
    p.add_argument("--force", action="store_true", help="忽略 ASR 快取重跑")
    p.add_argument("--keep-loaded", action="store_true", help="跑完不卸載模型（連續辨識多段時用）")


def transcribe_media(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..asr import audio as AU
    from ..asr import cache as AC
    from ..asr import models as M
    from ..captions import normalize as N
    from ..captions.build import word_to_json
    from ..captions.timebase import TimeMap
    from ..media.cache import write_json
    from ..project.schema import now_iso

    env.apply_model_env()
    t_all = time.perf_counter()
    md = _Media(args, ctx)
    num, den = md.fps
    n_frames = int(md.cfr.n_frames)
    rng = _parse_range(args.get("range"), n_frames)
    try:
        info = M.resolve_model(args.get("model"))
    except ValueError as e:
        raise OpError("Invalid", str(e)) from e
    asr_lang = M.asr_language(args.get("language"))
    out_lang_arg = args.get("output_language")
    convert = str(args.get("convert") or "auto")
    prompt = args.get("initial_prompt") or M.default_prompt(asr_lang, out_lang_arg)
    hot = _hotwords(args.get("hotwords"))
    beam = int(args.get("beam_size") or 5)
    # 0 是合法值（任何長度的靜音都切），不可以用 `or`
    min_sil = 500 if args.get("vad_min_silence_ms") is None else int(args["vad_min_silence_ms"])
    speech_pad = 200
    llm_url = args.get("llm_url") or None
    params = {
        "model": f"{info.repo}@{info.revision or 'main'}", "language": asr_lang, "outputLanguage": out_lang_arg, "convert": convert, "prompt": prompt,
        "hotwords": hot, "beam": beam, "vadMinSilenceMs": min_sil, "speechPadMs": speech_pad, "range": list(rng) if rng else None,
        "fps": [num, den], "nFrames": n_frames, "llm": [llm_url, args.get("llm_model")] if llm_url else None,
    }
    key = AC.cache_key(params)
    path = AC.asr_path(md.cache_root, key)
    # 沒有 LLM 的那份（key 跟「沒帶 --llm-url」完全相同）：辨識結果**先**寫這裡，LLM 校對失敗／當掉／取消都不會丟掉轉錄。
    # 驗證者實測：以前 refine 丟例外時整個 op 失敗、ASR 結果只在記憶體裡 → 幾分鐘的 GPU 辨識白跑。
    base_path = AC.asr_path(md.cache_root, AC.cache_key({**params, "llm": None}))
    base: dict[str, Any] | None = None
    if not args.get("force"):
        if llm_url:
            doc = AC.load(path)
            if doc is not None and _llm_complete(doc):
                ctx.log("info", f"ASR 快取命中（含 LLM 校對）：{path}")
                ctx.artifact(str(path), "asr")
                return _transcribe_result(path, doc, cached=True)
        base = AC.load(base_path)
        if base is not None and not llm_url:
            ctx.log("info", f"ASR 快取命中：{base_path}")
            ctx.artifact(str(base_path), "asr")
            return _transcribe_result(base_path, base, cached=True)
    if base is not None:
        # 只差 LLM 校對（上次沒連上／格式壞掉／被取消）：沿用辨識結果，不重跑 Whisper
        ctx.log("info", f"沿用 ASR 快取 {base_path}，只重跑本機 LLM 校對")
        return _refine_and_write(base, path, str(llm_url), args.get("llm_model"), ctx)

    # ---- 音訊 ----
    ctx.progress("asr.load", 0, 1, step="audio")
    try:
        dec = AU.decode_audio(md.video, ctx)
    except AU.NoAudio as e:
        raise OpError("Invalid", f"{md.video} 沒有音軌，無法產生字幕") from e
    except Exception as e:  # noqa: BLE001
        if type(e).__name__ == "Canceled":
            raise
        raise OpError("Io", f"音訊解碼失敗：{type(e).__name__}: {e}") from e
    video_start_s = float(md.index.pts_ms[0]) / 1000.0 if md.index.pts_ms else 0.0
    file_start_s = min(video_start_s, dec.start_s)
    base_offset = dec.start_s - file_start_s  # tProxy = tAsr + offset（規格 §5.3 A）
    samples = dec.samples
    offset = base_offset
    if rng is not None:
        t0p, t1p = rng[0] * den / num, rng[1] * den / num
        i0 = max(0, int(round((t0p - base_offset) * AU.SAMPLE_RATE)))
        i1 = min(len(samples), max(i0, int(round((t1p - base_offset) * AU.SAMPLE_RATE))))
        samples = samples[i0:i1]
        offset = base_offset + i0 / AU.SAMPLE_RATE
    if samples.size < AU.SAMPLE_RATE // 10:
        raise OpError("Invalid", "要辨識的音訊不到 0.1 秒", "檢查 --range 或影片音軌")
    ctx.check_cancel()
    try:
        vad = AU.speech_regions(samples, min_sil, speech_pad)
    except ImportError as e:
        raise OpError("PyEnv", f"缺少語音辨識套件：{e}", "重新安裝引擎依賴") from e

    # ---- 辨識 ----
    from ..asr import whisper as W

    first_run_hint = "第一次在這張 GPU 上跑，CUDA 可能要先編譯 kernel（實測約 20 秒，只有一次）"
    ctx.log("info", f"語音辨識：{info.name} language={asr_lang or 'auto'} device={args.get('device') or 'auto'}（{first_run_hint}）")
    try:
        raw = W.transcribe(
            samples, info, ctx, device=str(args.get("device") or "auto"), compute_type=args.get("compute_type"), language=asr_lang,
            initial_prompt=prompt, hotwords=hot, beam_size=beam, vad_min_silence_ms=min_sil, speech_pad_ms=speech_pad,
        )
    finally:
        if not args.get("keep_loaded"):
            W.unload_all()

    # ---- 清理 ----
    out_lang = out_lang_arg or M.default_output_language(asr_lang, raw.language)
    res = N.normalize(raw.segments, vad, N.NormalizeOptions(output_language=out_lang, convert=convert, hotwords=hot))
    words = res.words
    warnings = list(res.warnings)
    if asr_lang is None:
        warnings.append("語言設為自動偵測：混合語言的影片可能整段掉字（檢查 gaps），建議明確指定語言")
    tm = TimeMap(num, den, n_frames, offset)
    segs_json = []
    for s in raw.segments:
        a, b = tm.word_frames(float(s["start"]), float(s["end"]))
        segs_json.append({**s, "startMs": tm.ms(float(s["start"])), "endMs": tm.ms(float(s["end"])), "startFrame": a, "endFrame": b})
    gaps = [(round(a + offset, 3), round(b + offset, 3)) for a, b in res.gaps]
    doc: dict[str, Any] = {
        "version": 1,
        "backend": "faster-whisper",
        "model": info.name,
        "modelRepo": info.repo,
        "modelRevision": info.revision,
        "device": raw.device,
        "computeType": raw.compute_type,
        "asrLanguage": asr_lang,
        "language": raw.language,
        "languageProb": round(raw.language_prob, 4),
        "outputLanguage": out_lang,
        "prompt": prompt,
        "hotwords": hot,
        "duration_sec": round(raw.duration_s, 3),
        "durationS": round(raw.duration_s, 3),
        "offsetS": round(offset, 6),
        "audioStartS": round(dec.start_s, 6),
        "fileStartS": round(file_start_s, 6),
        "fps": {"num": num, "den": den},
        "nFrames": n_frames,
        "range": list(rng) if rng else None,
        "vad": [list(v) for v in vad],
        "params": {"beamSize": beam, "vadMinSilenceMs": min_sil, "speechPadMs": speech_pad, "convert": convert, "hallucinationSilenceThreshold": 2.0},
        "segments": segs_json,
        "words": [word_to_json(w, offset, tm) for w in words],
        "gaps": [list(g) for g in gaps],
        "gapFrames": [[tm.frame(a - offset), tm.frame(b - offset)] for a, b in gaps],
        "hallucinatedSegments": res.hallucinated_segments,
        "warnings": warnings,
        "fallbackReason": raw.fallback_reason,
        "attempts": raw.attempts,
        "llm": None,
        "transcribedAt": now_iso(),
        "seconds": round(raw.seconds, 3),
        "loadSeconds": round(raw.load_seconds, 3),
        "totalSeconds": round(time.perf_counter() - t_all, 3),
        "rtf": round(raw.seconds / max(raw.duration_s, 1e-6), 4),
    }
    write_json(base_path, doc)
    ctx.artifact(str(base_path), "asr")
    if not llm_url:
        return _transcribe_result(base_path, doc, cached=False)
    return _refine_and_write(doc, path, str(llm_url), args.get("llm_model"), ctx, words=words)


def _llm_complete(doc: dict[str, Any]) -> bool:
    """快取裡的 LLM 版本是不是「真的校對完」：連得上、每一批都成功。沒做完的不算命中（下次沿用辨識結果重跑校對）。"""
    llm = doc.get("llm")
    if not isinstance(llm, dict):
        return False
    if "complete" in llm:
        return llm.get("complete") is True
    return bool(llm.get("reachable")) and not llm.get("warnings")  # 這個欄位出現之前寫的快取


def _refine_and_write(base: dict[str, Any], path: Path, llm_url: str, llm_model: Any, ctx: Ctx, *, words: list[Any] | None = None) -> dict[str, Any]:
    """辨識結果（已寫進 base 那份快取）→ 本機 LLM 校對 → 寫 LLM 那份快取。

    校對的任何失敗（連不上、回傳格式壞掉、程式例外）都只變成警告、詞維持辨識結果；只有取消會往上丟（辨識結果已經落地）。
    """
    from ..asr import llm as L
    from ..captions.build import word_from_json, word_to_json
    from ..captions.timebase import TimeMap
    from ..media.cache import write_json

    fps = base.get("fps") or {}
    offset = float(base.get("offsetS") or 0.0)
    tm = TimeMap(int(fps.get("num") or 30), int(fps.get("den") or 1), int(base.get("nFrames") or 0), offset)
    if words is None:
        words = [word_from_json(w, offset) for w in base.get("words") or [] if isinstance(w, dict)]
    warnings = list(base.get("warnings") or [])
    try:
        refined, rep = L.refine(words, llm_url, ctx, model=llm_model)
        report: dict[str, Any] = rep.to_json()
        report["complete"] = bool(rep.reachable and rep.model and not rep.warnings)
        warnings.extend(rep.warnings)
    except Exception as e:  # noqa: BLE001 — 選配功能的任何意外都不能讓轉錄結果丟失
        if type(e).__name__ == "Canceled":
            raise
        refined = words
        msg = f"{L.BAD_OUTPUT_PREFIX}（校對時發生例外 {type(e).__name__}: {e}），保留辨識結果"
        report = {"endpoint": llm_url, "model": llm_model, "reachable": False, "applied": 0, "rejected": 0, "proposals": [], "warnings": [msg], "seconds": 0.0, "complete": False}
        warnings.append(msg)
    doc = {**base, "words": [word_to_json(w, offset, tm) for w in refined], "warnings": warnings, "llm": report}
    write_json(path, doc)
    ctx.artifact(str(path), "asr")
    return _transcribe_result(path, doc, cached=False)


def _transcribe_result(path: Path, doc: dict[str, Any], cached: bool) -> dict[str, Any]:
    words = doc.get("words") or []
    r = {
        "path": str(path),
        "language": doc.get("language"),
        "languageProb": doc.get("languageProb"),
        "outputLanguage": doc.get("outputLanguage"),
        "durationS": doc.get("durationS"),
        "device": doc.get("device"),
        "computeType": doc.get("computeType"),
        "model": doc.get("model"),
        "seconds": doc.get("seconds"),
        "loadSeconds": doc.get("loadSeconds"),
        "rtf": doc.get("rtf"),
        "words": len(words),
        "segments": len(doc.get("segments") or []),
        "gaps": doc.get("gaps") or [],
        "gapFrames": doc.get("gapFrames") or [],
        "warnings": doc.get("warnings") or [],
        "fallbackReason": doc.get("fallbackReason"),
        "cached": cached,
    }
    preview = "".join(w.get("text", "") for w in words[:40]) if words else ""
    r["_human"] = (
        f"{'（快取）' if cached else ''}{r['model']} {r['device']}/{r['computeType']} 語言 {r['language']}({r['languageProb']}) → {r['outputLanguage']}："
        f"{r['words']} 詞 / {r['segments']} 段，{r['seconds']}s（RTF {r['rtf']}）\n  {preview}…\n  → {path}"
        + (f"\n  退路：{r['fallbackReason']}" if r["fallbackReason"] else "")
        + "".join(f"\n  警告：{w}" for w in r["warnings"])
    )
    return r


@register("asr.transcribe", cli="transcribe", help="本機語音辨識（faster-whisper 詞級時間 + VAD）→ ASR 快取檔", args=_transcribe_args, gpu=True)
def transcribe_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    return transcribe_media(args, ctx)


@register("asr.doctor", cli="asr-doctor", help="語音辨識環境檢查（faster-whisper / CTranslate2 / cuBLAS 12；非阻斷）")
def asr_doctor_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..asr.doctor import asr_section

    d = asr_section()
    d["_human"] = json.dumps(d, ensure_ascii=False, indent=2)
    return d


# ---------------------------------------------------------------- captions.build


def _project_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("project", help="專案檔 *.aivc.json")
    p.add_argument("--media", default=None)


def _build_args(p: argparse.ArgumentParser) -> None:
    _project_args(p)
    p.add_argument("--asr", default=None, help="ASR 檔（預設：這支媒體最新的 asr/*.v1.json）")
    p.add_argument("--preset", default="subtitle", help="subtitle|karaoke|pop|bounce|typewriter|boxHighlight")
    p.add_argument("--language", default=None, help="輸出語言（預設 ASR 檔的 outputLanguage）")
    p.add_argument("--segmentation", default=None, help="分段規則覆寫（JSON 物件，例如 '{\"maxLines\":1}'）")
    p.add_argument("--disabled", action="store_true", help="建立但不啟用（render --captions auto 不燒）")
    p.add_argument("--no-save", action="store_true", help="只回傳 CaptionTrackV1，不寫回專案")


def _shot_cuts(mctx: Any) -> list[int]:
    return sorted({int(s.start_frame) for s in mctx.shots() if int(s.start_frame) > 0})


@register("captions.build", cli="captions-build", help="ASR 檔 → 字幕 track（分段、配時；預設寫回專案）", args=_build_args)
def captions_build_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..asr import cache as AC
    from ..captions.build import build_track, track_summary
    from ..media.cache import write_json
    from ..project import resolve as R

    mctx = R.open_media_context(env.normalize_path(str(args["project"])), args.get("media"), ctx)
    asr_path = Path(env.normalize_path(str(args["asr"]))) if args.get("asr") else AC.newest(Path(mctx.cache.root))
    if asr_path is None or not asr_path.is_file():
        raise OpError("Invalid", "找不到 ASR 檔", "先跑 aivc transcribe --project … 或用 --asr 指定")
    doc = AC.load(asr_path)
    if doc is None:
        raise OpError("Invalid", f"ASR 檔壞掉或版本不符：{asr_path}", "加 --force 重跑 aivc transcribe")
    seg = None
    if args.get("segmentation"):
        raw = args["segmentation"]
        try:
            seg = raw if isinstance(raw, dict) else json.loads(str(raw))
        except ValueError as e:
            raise OpError("Invalid", f"--segmentation 不是 JSON：{e}") from e
        if not isinstance(seg, dict):
            raise OpError("Invalid", "--segmentation 必須是 JSON 物件")
    track = build_track(
        doc, preset_id=str(args.get("preset") or "subtitle"), output_language=args.get("language"), fps=mctx.fps, n_frames=mctx.n_frames,
        cuts=_shot_cuts(mctx), segmentation=seg, asr_path=str(asr_path), enabled=not args.get("disabled"),
    )
    out = Path(mctx.cache.root) / "captions" / "track.v1.json"
    write_json(out, track)
    ctx.artifact(str(out), "captions.track")
    if not args.get("no_save"):
        mctx.project.captions[mctx.media_id] = track
        mctx.save()
        ctx.artifact(str(mctx.project_path), "project")
    s = track_summary(track)
    result = dict(track)
    result["_human"] = f"{s['cues']} 則 / {s['words']} 詞（{s['preset']}，{s['language']}），待檢查 {s['flagged']}；第一則：{s['text']}" + ("" if args.get("no_save") else f"\n  → {mctx.project_path}")
    return result


# ---------------------------------------------------------------- captions.layout / preview


def _track_of(mctx: Any) -> dict[str, Any]:
    track = mctx.project.captions.get(mctx.media_id)
    if not track:
        raise OpError("Invalid", f"media {mctx.media_id} 沒有字幕 track", "先跑 aivc captions-build")
    return track


def _layout_args(p: argparse.ArgumentParser) -> None:
    _project_args(p)
    p.add_argument("--range", default=None, metavar="K0:K1", help="只排這段（UI 送播放頭 ±90 秒）")


@register("captions.layout", cli="captions-layout", help="舞台預覽用的字幕版面 layout.v1.json + 精靈圖集 atlas.v1.png", args=_layout_args)
def captions_layout_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from PIL import Image

    from .. import atomic
    from ..captions.atlas import build_layout, layout_key
    from ..captions.burn import CaptionBurner
    from ..media.cache import write_json
    from ..project import resolve as R

    mctx = R.open_media_context(env.normalize_path(str(args["project"])), args.get("media"), ctx)
    track = _track_of(mctx)
    W, H = mctx.size
    rng = _parse_range(args.get("range"), mctx.n_frames) or (0, mctx.n_frames)
    burner = CaptionBurner(track, W, H, mctx.fps)
    key = layout_key(track, W, H, mctx.fps, rng[0], rng[1], burner.font.to_json(), 1.25)
    d = Path(mctx.cache.root) / "captions" / key
    lp, ap = d / "layout.v1.json", d / "atlas.v1.png"
    if not (lp.is_file() and ap.is_file()):
        doc, atlas = build_layout(burner, rng[0], rng[1])
        doc["key"] = key
        d.mkdir(parents=True, exist_ok=True)
        # 唯一暫存名（B-06）：captions.layout 跑在輕量 lane，兩個 range 同時排版同一支影片會撞固定的 `.part`
        with atomic.atomic_path(ap) as part:
            Image.fromarray(atlas, "RGBA").save(part, format="PNG")
        write_json(lp, doc)
    else:
        doc = json.loads(atomic.read_text(lp))
    rel = lambda p: p.relative_to(Path(mctx.cache.root)).as_posix()  # noqa: E731
    ctx.artifact(str(lp), "captions.layout")
    return {
        "path": str(lp), "atlas": str(ap), "relPath": rel(lp), "atlasRelPath": rel(ap), "key": key, "fingerprint": mctx.cache.root.name,
        "font": doc.get("font"), "warnings": doc.get("warnings") or [], "cues": len(doc.get("cues") or []), "range": list(rng),
        "_human": f"{len(doc.get('cues') or [])} 則 → {lp}（字型 {(doc.get('font') or {}).get('path')}）",
    }


def _preview_args(p: argparse.ArgumentParser) -> None:
    _project_args(p)
    p.add_argument("--frame", "-k", type=int, required=True, help="proxy 幀號")
    p.add_argument("-o", "--out", default=None, help="PNG 輸出（預設 <cache>/captions/preview/<k>.png）")
    p.add_argument("--over-video", action="store_true", help="疊在該幀畫面上（否則透明背景）")


@register("captions.preview", cli="captions-preview", help="第 k 幀的字幕疊圖 PNG（QA／golden 測試）", args=_preview_args)
def captions_preview_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    import numpy as np
    from PIL import Image

    from ..captions.burn import CaptionBurner
    from ..project import resolve as R

    mctx = R.open_media_context(env.normalize_path(str(args["project"])), args.get("media"), ctx)
    track = _track_of(mctx)
    W, H = mctx.size
    k = int(args["frame"])
    if not 0 <= k < mctx.n_frames:
        raise OpError("Invalid", f"幀號 {k} 超出 [0, {mctx.n_frames})")
    b = CaptionBurner(track, W, H, mctx.fps)
    out = Path(env.normalize_path(str(args["out"]))) if args.get("out") else Path(mctx.cache.root) / "captions" / "preview" / f"{k}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    if args.get("over_video"):
        from ..media.source import FrameSource

        with FrameSource(mctx.video, mctx.index, mctx.cfr, probe=mctx.probe, lru=2, ctx=ctx) as fs:
            fr = fs.get(mctx.cfr.src_index(k))
        img = b.apply(fr, k).rgb8()
        Image.fromarray(np.ascontiguousarray(img), "RGB").save(out)
    else:
        Image.fromarray(b.rgba_frame(k), "RGBA").save(out)
    ctx.artifact(str(out), "captions.preview")
    return {"path": str(out), "frame": k, "cues": [c.get("id") for c in b.cues_at(k)], "boxes": [list(x) for x in b.boxes_at(k)], "font": b.font.to_json(), "warnings": b.warnings, "_human": f"→ {out}"}


# ---------------------------------------------------------------- captions.export


def _export_args(p: argparse.ArgumentParser) -> None:
    _project_args(p)
    p.add_argument("--format", default="srt", choices=["srt", "vtt", "ass", "txt"])
    p.add_argument("-o", "--out", default=None, help="輸出檔（預設：專案旁 <影片名>.<格式>）")
    p.add_argument("--range", default=None, metavar="K0:K1", help="只輸出與範圍重疊的則")
    p.add_argument("--trim", action="store_true", help="與 --range 併用：時間減去 K0（對應 render --trim）")
    p.add_argument("--speaker-prefix", action="store_true", help="有講者時加「講者: 」前綴")
    p.add_argument("--vtt-word-timing", action="store_true", help="VTT 逐詞時間標記（卡拉OK）")


@register("captions.export", cli="captions-export", help="字幕檔匯出 SRT / VTT / ASS / TXT", args=_export_args)
def captions_export_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..captions.export import export_text, write_text
    from ..project import resolve as R

    mctx = R.open_media_context(env.normalize_path(str(args["project"])), args.get("media"), ctx)
    track = _track_of(mctx)
    fmt = str(args.get("format") or "srt")
    rng = _parse_range(args.get("range"), mctx.n_frames)
    W, H = mctx.size
    text = export_text(track, fmt, mctx.fps, W, H, range_frames=rng, trim=bool(args.get("trim")), speaker_prefix=bool(args.get("speaker_prefix")), vtt_word_timing=bool(args.get("vtt_word_timing")))
    out = Path(env.normalize_path(str(args["out"]))) if args.get("out") else Path(mctx.video).with_suffix(f".{fmt}")
    from .render import ensure_out_not_source

    ensure_out_not_source(out, mctx.video)
    write_text(out, text)
    ctx.artifact(str(out), f"captions.{fmt}")
    n = text.count(" --> ") if fmt in ("srt", "vtt") else text.count("Dialogue:") if fmt == "ass" else len(text.splitlines())
    return {"path": str(out), "format": fmt, "cues": n, "bytes": len(text.encode("utf-8")), "_human": f"{n} 則 → {out}"}


# ---------------------------------------------------------------- captions.refine


def _refine_args(p: argparse.ArgumentParser) -> None:
    _project_args(p)
    p.add_argument("--endpoint", default=None, help="OpenAI 相容端點（預設 http://localhost:1234/v1）")
    p.add_argument("--model", default=None)
    p.add_argument("--tasks", default="tw,punct,typo,emphasis", help="保留給 UI；目前一次做完")


@register("captions.refine", cli="captions-refine", help="本機 LLM 校對建議（只回傳 proposal，不寫專案）", args=_refine_args)
def captions_refine_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..asr import llm as L
    from ..captions.normalize import AsrWord
    from ..project import resolve as R

    mctx = R.open_media_context(env.normalize_path(str(args["project"])), args.get("media"), ctx)
    track = _track_of(mctx)
    words: list[AsrWord] = []
    cue_of: dict[int, str] = {}
    for i, c in enumerate(track.get("cues") or []):
        cue_of[i] = str(c.get("id"))
        for w in c.get("words") or []:
            words.append(AsrWord(str(w.get("text", "")), float(w["startFrame"]), float(w["endFrame"]), float(w.get("prob", 1.0)), seg=i))
    endpoint = str(args.get("endpoint") or "http://localhost:1234/v1")
    _new, rep = L.refine(words, endpoint, ctx, model=args.get("model"), apply=False)
    d = rep.to_json()
    for p in d["proposals"]:
        p["cueId"] = cue_of.get(int(p.pop("segment")))
    d["_human"] = f"{len(d['proposals'])} 則建議（採用 {sum(1 for p in d['proposals'] if p['accepted'])}、拒絕 {rep.rejected}）" + "".join(f"\n  警告：{w}" for w in d["warnings"])
    return d
