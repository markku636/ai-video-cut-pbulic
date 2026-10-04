"""編碼器：Yuv420 幀序列 → rawvideo yuv420p 管線 → ffmpeg（計畫 §5.2 / §6.7）。

輸入端 `-f rawvideo -pix_fmt yuv420p <plan.color_args>`（例如 `-color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709`；
range 與矩陣跟來源，full-range 來源是 `-color_range pc`，見 encode_plan.color_args）
→ ffmpeg 零轉換直接進編碼器；輸出端再標一次同樣 tag 進容器。輸入與輸出必須標同一組：只標一邊，ffmpeg 會自動插 scale 做 range 轉換，
遮罩外位元組就不再與來源相同。音訊從來源檔 `-map 1:a:0?` 複製或重編。
`.part` + rename；每幀 ctx.check_cancel() / ctx.progress()；取消即 kill 子行程並清掉 .part。

序列混音（設計 docs/editor-m2-design.md §7.3–§7.6；§13 M2.7）：`plan.audio_mode == "mix"` 時音訊不是從單一來源 copy，
而是 `media/audio_graph` 建好的濾鏡圖：

    ffmpeg … -copyts -f rawvideo … -i pipe:0 -i <來源1> -i <來源2> … -/filter_complex <out>.part.audio.txt -map 0:v:0 -map [aout] …

- `-copyts`：音訊鏈的 `atrim start/end` 是**容器絕對時間**（§7.5 實測：數樣本在 1 s 斷層後早 1.000 s、輸入端 -ss 在 Opus 晚 48 樣本）；
  rawvideo 管線的 pts 本來就從 0 開始，不受影響（M2.0 驗過 mkv／webm／mp4 muxer 的 start_time 都是 0）。
- 濾鏡圖寫檔：自動化運算式幾十段就會撞到 Windows 32 767 字元的命令列上限。FFmpeg 7+ 用 `-/filter_complex <file>`，
  更舊的 ffmpeg（例如 Ubuntu apt 的 6.1）沒有這個語法，退回 `-filter_complex_script <file>`（8.x 已移除，所以不能反過來當預設）。
- 輸入 > 32 路時 audio_graph 會給 stem 兩段式：先依序把每個 stem 渲成 48 kHz f32 WAV，最後一張圖才讀 stem。
  濾鏡圖檔與 stem 檔跟 `.part` 一起清掉（成功、失敗、取消都清）。
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import time
from fractions import Fraction
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable, Sequence

from ..ops import Canceled, OpError
from . import ffmpeg as ff
from .encode_plan import EncodePlan
from .index import NoopCtx
from .source import Yuv420

if TYPE_CHECKING:
    from .audio_graph import AudioGraph

# 序列混音的輸出標籤（audio_graph 的最後一張圖一律輸出到這裡）
AUDIO_OUT_LABEL = "[aout]"
# stem 是中間檔：48 kHz f32 無損，最後一張圖再混一次也不會累積量化誤差
STEM_CODEC = "pcm_f32le"
# 等子行程時多久檢查一次取消：夠短讓取消即時，又不會空轉吃 CPU
_POLL_S = 0.1


@lru_cache(maxsize=4)
def _filter_script_option_for(ffmpeg_exe: str) -> str:
    """實際試跑一次，看這份 ffmpeg 吃不吃 `-/filter_complex <file>`（FFmpeg 7+）。

    為什麼試跑而不是解析版本號：自行編譯的 git 版（`N-12345-g…`）、發行版改過字串的版本號都不可靠；
    多一個 ~50 ms 的子行程換確定答案，而且每個 ffmpeg 路徑只試一次。"""
    fd, name = tempfile.mkstemp(prefix="aivc-fc-", suffix=".txt")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write("anullsrc=r=48000:cl=stereo,atrim=end_sample=48[aout]\n")
        args = [ffmpeg_exe, "-hide_banner", "-nostdin", "-loglevel", "error", "-/filter_complex", name, "-map", AUDIO_OUT_LABEL, "-f", "null", "-"]
        try:
            cp = subprocess.run(args, capture_output=True, timeout=30, **ff.popen_kwargs())
        except (OSError, subprocess.TimeoutExpired):
            return "-filter_complex_script"
        return "-/filter_complex" if cp.returncode == 0 else "-filter_complex_script"
    finally:
        try:
            os.unlink(name)
        except OSError:
            pass


def filter_script_args(path: str | os.PathLike[str]) -> list[str]:
    """`[-/filter_complex, <file>]`；舊 ffmpeg 是 `[-filter_complex_script, <file>]`。"""
    return [_filter_script_option_for(ff.exe("ffmpeg")), os.fspath(path)]


def ffmpeg_args(
    plan: EncodePlan,
    *,
    width: int,
    height: int,
    fps: tuple[int, int] | Fraction,
    out_part: str | os.PathLike[str],
    audio_source: str | None = None,
    extra_video_args: Iterable[str] = (),
    shortest: bool = False,
    audio_input_args: Iterable[str] = (),
    audio_inputs: Sequence[str] = (),
    filter_script: str | os.PathLike[str] | None = None,
    copyts: bool | None = None,
) -> list[str]:
    """`audio_input_args` 放在音訊 `-i` **之前**（輸入選項，例如 `-ss T -t D` 讓 --range --trim 的音軌跟著裁）。

    序列混音（plan.audio_mode == "mix"）：`audio_inputs` 依序是濾鏡圖的 `1:a`、`2:a`…（0 號是 rawvideo 管線），
    `filter_script` 是濾鏡圖檔（必填）；`copyts` 預設在 mix 模式開啟（音訊鏈用容器絕對時間）。"""
    f = Fraction(*fps) if isinstance(fps, tuple) else Fraction(fps)
    mix = plan.audio_mode == "mix"
    if mix and filter_script is None:
        raise OpError("Internal", "音訊模式是 mix，但沒有音訊濾鏡圖檔")
    use_copyts = mix if copyts is None else bool(copyts)
    args = [ff.exe("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-y"]
    if use_copyts:
        # 全域旗標：放在所有輸入之前（設計 §7.4 完整命令）
        args += ["-copyts"]
    args += [
        "-f", "rawvideo", "-pix_fmt", plan.input_pix_fmt, "-video_size", f"{width}x{height}",
        "-framerate", f"{f.numerator}/{f.denominator}", *plan.color_args, "-i", "pipe:0",
    ]
    if mix:
        # 同一支來源也各開一個 -i、不用 asplit：asplit 共用解碼器，沒輪到的那條鏈的輸出會堆在 amix 的 FIFO 裡（§7.4）
        for p in audio_inputs:
            args += ["-i", os.fspath(p)]
        assert filter_script is not None
        args += [*filter_script_args(filter_script), "-map", "0:v:0", "-map", AUDIO_OUT_LABEL]
    elif plan.audio_mode != "none" and audio_source:
        args += [*audio_input_args, "-i", audio_source, "-map", "0:v:0", "-map", "1:a:0?"]
    else:
        args += ["-map", "0:v:0"]
    args += ["-c:v", plan.video_codec, *plan.video_args, *extra_video_args, *plan.color_args]
    if mix or (plan.audio_mode != "none" and audio_source):
        args += plan.audio_args
    else:
        args += ["-an"]
    # 內容揭露 tag（輸出選項，放在 -f 之前）；getattr：舊呼叫端手建的 EncodePlan 替身可能沒有這欄
    args += list(getattr(plan, "metadata_args", None) or [])
    if plan.format in ("mp4", "mov"):
        args += ["-movflags", "+faststart"]
    if shortest:
        args += ["-shortest"]
    args += ["-f", plan.format, os.fspath(out_part)]
    return args


def _wait(proc: ff.FfmpegProcess, ctx: Any, *, stage: str | None = None, total_us: int = 0) -> None:
    """等一支不吃 stdin 的 ffmpeg 跑完：期間持續檢查取消（取消即 kill），有 total_us 時依 -progress 的 out_time_us 回報進度。"""
    assert proc.proc is not None
    try:
        while True:
            ctx.check_cancel()
            try:
                proc.proc.wait(timeout=_POLL_S)
                break
            except subprocess.TimeoutExpired:
                if stage and total_us > 0:
                    ctx.progress(stage, min(proc.out_time_us, total_us), total_us)
        proc.finish()
    except BaseException:
        proc.kill()
        raise


def stem_args(stem: Any) -> tuple[list[str], Path]:
    """一個 stem 的命令與它的濾鏡圖檔路徑（輸入編號從 0 開始：這一趟沒有 rawvideo 管線）。"""
    script = Path(stem.path + ".txt")
    args = [ff.exe("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-y", "-copyts"]
    for i in stem.inputs:
        args += ["-i", i.path]
    args += [*filter_script_args(script), "-map", AUDIO_OUT_LABEL, "-c:a", STEM_CODEC, "-f", "wav", stem.path]
    return args, script


def run_audio_stems(graph: "AudioGraph", ctx: Any | None = None, *, stage: str = "audio-stems") -> list[Path]:
    """依序渲完兩段式的每個 stem（後面的 stem 可能讀前面的輸出）。回傳寫出的檔案（給呼叫端清理）。"""
    ctx = ctx or NoopCtx()
    written: list[Path] = []
    n = len(graph.stems)
    try:
        for i, s in enumerate(graph.stems):
            ctx.check_cancel()
            Path(s.path).parent.mkdir(parents=True, exist_ok=True)
            args, script = stem_args(s)
            written += [script, Path(s.path)]
            script.write_text(s.text, encoding="utf-8")
            ctx.log("debug", " ".join(_quote(a) for a in args))
            _wait(ff.FfmpegProcess(args).start(stdin=False), ctx)
            ctx.progress(stage, i + 1, n)
    except BaseException:
        cleanup_audio_files(written)
        raise
    return written


def cleanup_audio_files(paths: Iterable[Path]) -> None:
    """刪掉濾鏡圖檔與 stem，最後把變空的 stem 目錄也刪掉。

    為什麼不 rmtree 整個目錄：stem 目錄名是由輸出路徑推出來的（`<out>.part.stems`），逐檔刪只會碰到自己寫的東西，
    萬一使用者剛好有同名資料夾也不會被整個清空。"""
    dirs: set[Path] = set()
    for p in paths:
        ff._unlink_quiet(Path(p))
        dirs.add(Path(p).parent)
    for d in sorted(dirs, key=lambda x: len(str(x)), reverse=True):
        if d.name.endswith(".stems"):
            try:
                d.rmdir()  # 只有空目錄才刪得掉
            except OSError:
                pass


def write_frames(
    frames: Iterable[Yuv420],
    plan: EncodePlan,
    out_path: str | os.PathLike[str],
    ctx: Any | None = None,
    *,
    width: int,
    height: int,
    fps: tuple[int, int] | Fraction,
    total: int,
    audio_source: str | None = None,
    extra_video_args: Iterable[str] = (),
    shortest: bool = False,
    stage: str = "encode",
    audio_input_args: Iterable[str] = (),
    audio_graph: "AudioGraph | None" = None,
) -> dict[str, Any]:
    """把 frames 逐幀寫進 ffmpeg；回 {path, frames, bytes, seconds, encoder, out_time_us}。

    audio_graph：plan.audio_mode == "mix" 時必填（序列混音的濾鏡圖；輸入編號必須從 1 開始）。"""
    ctx = ctx or NoopCtx()
    out = Path(out_path)
    t0 = time.perf_counter()
    n = 0
    proc: ff.FfmpegProcess | None = None
    mix = plan.audio_mode == "mix"
    if mix and audio_graph is None:
        raise OpError("Internal", "音訊模式是 mix，但沒有音訊濾鏡圖")
    if mix and audio_graph is not None and audio_graph.first_input != 1:
        raise OpError("Internal", f"音訊濾鏡圖的輸入編號從 {audio_graph.first_input} 開始；和 rawvideo 管線一起跑時必須從 1 開始")
    with ff.atomic_output(out) as part:
        temp: list[Path] = []
        try:
            script: Path | None = None
            if mix and audio_graph is not None:
                script = part.with_name(part.name + ".audio.txt")
                temp.append(script)
                script.write_text(audio_graph.text, encoding="utf-8")
                if audio_graph.stems:
                    temp += run_audio_stems(audio_graph, ctx)
            args = ffmpeg_args(
                plan, width=width, height=height, fps=fps, out_part=part, audio_source=audio_source,
                extra_video_args=extra_video_args, shortest=shortest, audio_input_args=audio_input_args,
                audio_inputs=[i.path for i in audio_graph.inputs] if (mix and audio_graph is not None) else (),
                filter_script=script,
            )
            ctx.log("debug", " ".join(_quote(a) for a in args))
            proc = ff.FfmpegProcess(args).start()
            try:
                for fr in frames:
                    ctx.check_cancel()
                    if fr.width != width or fr.height != height:
                        raise OpError("Internal", f"幀尺寸 {fr.width}x{fr.height} 與計畫 {width}x{height} 不符")
                    proc.write(fr.to_bytes())
                    n += 1
                    ctx.progress(stage, n, total, out_time_us=proc.out_time_us)
                proc.finish()
            except (Canceled, KeyboardInterrupt):
                proc.kill()
                raise
            except BaseException:
                proc.kill()
                raise
        finally:
            cleanup_audio_files(temp)
    return {
        "path": str(out),
        "frames": n,
        "bytes": out.stat().st_size,
        "seconds": round(time.perf_counter() - t0, 3),
        "encoder": plan.video_codec,
        "out_time_us": proc.out_time_us if proc else 0,
    }


def write_audio(
    graph: "AudioGraph",
    out_path: str | os.PathLike[str],
    ctx: Any | None = None,
    *,
    codec: str = "pcm_f32le",
    fmt: str = "wav",
    stage: str = "audio-mix",
) -> dict[str, Any]:
    """只跑音訊圖輸出一個音訊檔（`aivc audio-mix`：QA、比對 App 預覽）。graph 的輸入編號必須從 0 開始。"""
    ctx = ctx or NoopCtx()
    if graph.first_input != 0:
        raise OpError("Internal", f"音訊濾鏡圖的輸入編號從 {graph.first_input} 開始；只輸出音訊時必須從 0 開始")
    out = Path(out_path)
    t0 = time.perf_counter()
    proc: ff.FfmpegProcess | None = None
    total_us = graph.total_samples * 1_000_000 // 48_000
    with ff.atomic_output(out) as part:
        temp: list[Path] = []
        try:
            script = part.with_name(part.name + ".audio.txt")
            temp.append(script)
            script.write_text(graph.text, encoding="utf-8")
            if graph.stems:
                temp += run_audio_stems(graph, ctx)
            args = [ff.exe("ffmpeg"), "-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-y", "-copyts"]
            for i in graph.inputs:
                args += ["-i", i.path]
            args += [*filter_script_args(script), "-map", AUDIO_OUT_LABEL, "-c:a", codec, "-f", fmt, os.fspath(part)]
            ctx.log("debug", " ".join(_quote(a) for a in args))
            proc = ff.FfmpegProcess(args).start(stdin=False)
            _wait(proc, ctx, stage=stage, total_us=total_us)
            ctx.progress(stage, total_us, total_us)
        finally:
            cleanup_audio_files(temp)
    return {
        "path": str(out),
        "samples": graph.total_samples,
        "bytes": out.stat().st_size,
        "seconds": round(time.perf_counter() - t0, 3),
        "codec": codec,
        "out_time_us": proc.out_time_us if proc else 0,
    }


def _quote(a: str) -> str:
    return f'"{a}"' if " " in a else a
