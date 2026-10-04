"""`aivc audio-mix <project> -o mix.wav [--range T0:T1] [--media ID] [--codec pcm_f32le|pcm_s24le|pcm_s16le]`（op `audio.mix`；設計 §7.6、§13 M2.7）。

只跑序列的音訊濾鏡圖、輸出一個 WAV，不解碼也不編碼任何視訊。用途：
- QA：逐樣本確認混音（脈衝對齊、樣本數剛好 S(T)、淡化與閃避的形狀），不必等整支影片渲染完；
- App 的「輸出音訊預覽（WAV）」：Web Audio 預覽只有 ±10 ms，要逐樣本對就用這個（§8.3 精度聲明）。

為什麼跟 render 用同一份 `media/audio_graph.build` 與 `media/encoder` 的執行端：WAV 預覽必須跟成品的聲音一模一樣，
兩份實作一定會漂移。唯一差別是輸入編號從 0 開始（沒有 rawvideo 管線）。

序列為 null（隱含序列）時混「目前媒體整段」：跟 App 的隱含序列同義，未剪輯的專案也能先聽一次原音的混音結果。
`--range T0:T1` 是序列幀，輸出只保留 [T0,T1)（先混整條、最後裁，同 render --range --trim）。
"""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .. import env
from . import Ctx, OpError, register

if TYPE_CHECKING:
    from ..project import schema as S

_HELP = "只輸出序列的混音 WAV（同 render 的音訊濾鏡圖；QA 與逐樣本比對 App 預覽用）"
_CODECS = ("pcm_f32le", "pcm_s24le", "pcm_s16le")


def _args(p: argparse.ArgumentParser) -> None:
    p.add_argument("project", help="專案檔 *.aivc.json")
    p.add_argument("-o", "--out", required=True, help="輸出 WAV")
    p.add_argument("--range", default=None, metavar="T0:T1", help="只輸出序列幀 [T0,T1)（先混整條再裁）")
    p.add_argument("--media", default=None, help="序列為 null（隱含序列）時用哪支媒體；預設 activeMediaId")
    p.add_argument("--codec", choices=list(_CODECS), default="pcm_f32le", help="WAV 取樣格式（預設 32-bit float：不削波、不量化，逐樣本比對用）")


def implicit_sequence(project: "S.ProjectFile", media_id: str | None) -> "S.SequenceV2":
    """隱含序列（sequence == null）的記憶體內實體化：目前媒體整段、原音預設（同 TS materialize，§5.1）。不寫回專案檔。"""
    from ..project import resolve as R
    from ..project import schema as SCH

    m = R.select_media(project, media_id)
    if m.proxy is None:
        raise OpError("Invalid", f"媒體 {m.name or m.id} 沒有 proxy（幀數與 fps 未知），無法決定隱含序列的長度", "先建立 proxy")
    size = m.source_size or (int(m.proxy.width), int(m.proxy.height))
    return SCH.SequenceV2(
        "implicit", m.name or m.id, SCH.Rational(m.proxy.fps.num, m.proxy.fps.den), size[0], size[1],
        video=[SCH.VideoClipV2("clip-1", m.id, 0, int(m.proxy.frames))],
    )


@register("audio.mix", cli="audio-mix", help=_HELP, args=_args)
def audio_mix_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..media import audio_graph as AG
    from ..media import encoder as EN
    from ..project import schema as SCH
    from ..sequence import model as SM
    from .render import _audio_resolvers, _check_sequence_media, _peak_resolver, ensure_out_not_source, parse_range, timecode

    raw = args.get("project")
    if not raw:
        raise OpError("Invalid", "缺少專案檔路徑")
    project_path = Path(env.normalize_path(str(raw))).resolve()
    r = SCH.load(project_path)
    for w in r.warnings:
        ctx.log("warn", f"專案檔：{w}")
    project = r.project
    implicit = project.sequence is None
    seq = implicit_sequence(project, args.get("media")) if implicit else project.sequence
    assert seq is not None
    codec = str(args.get("codec") or "pcm_f32le")
    if codec not in _CODECS:
        raise OpError("Invalid", f"--codec 要 {'|'.join(_CODECS)}，收到 {codec!r}")
    _check_sequence_media(project, seq)
    frames = SM.duration_frames(seq)
    rng = parse_range(args.get("range"), frames)
    out = Path(env.normalize_path(str(args["out"])))
    info_of, path_of = _audio_resolvers(project, project_path, ctx)
    graph = AG.build(
        seq, project, rng, info_of=info_of, path_of=path_of, peak_of=_peak_resolver(), first_input=0, stem_dir=f"{out}.part.stems",
    )
    # 跟 render 同一條規則：輸出檔不能蓋掉任何一個來源（.part → rename 會把素材換掉）
    for c in graph.chains:
        ensure_out_not_source(out, c.path)
    for n in graph.notes:
        ctx.log("info", f"音訊：{n}")
    info = EN.write_audio(graph, out, ctx, codec=codec)
    ctx.artifact(str(out), "audio.mix")
    fps = (seq.fps.num, seq.fps.den)
    t0, t1 = rng if rng is not None else (0, frames)
    result: dict[str, Any] = {
        "out": str(out),
        "samples": graph.total_samples,
        "sampleRate": int(seq.sample_rate),
        "channels": 2,
        "codec": codec,
        "bytes": info["bytes"],
        "seconds": info["seconds"],
        "range": None if rng is None else [t0, t1],
        "sequence": {**SM.describe(seq), "implicit": implicit, "duration": timecode(frames, fps), "fps": {"num": fps[0], "den": fps[1]}},
        "inputs": len(graph.inputs),
        "chains": [c.to_json() for c in graph.chains],
        "stems": len(graph.stems),
        "notes": list(graph.notes),
        "peakEstimateDbfs": graph.peak_estimate_dbfs,
        "graph": graph.text,
    }
    peak = "未知" if graph.peak_estimate_dbfs is None else f"{graph.peak_estimate_dbfs:+.1f} dBFS"
    result["_human"] = "\n".join(
        [
            f"{graph.total_samples} 樣本（{graph.total_samples / seq.sample_rate:.3f} s @ {seq.sample_rate} Hz 立體聲 {codec}）→ {out}",
            f"序列 {'（隱含：整段素材）' if implicit else seq.id}  幀 [{t0}, {t1})  {timecode(t0, fps)} → {timecode(t1, fps)}"
            f"  {len(graph.chains)} 路{'、stem ' + str(len(graph.stems)) if graph.stems else ''}  估計峰值 {peak}  {info['seconds']}s",
            *(f"  note  {n}" for n in graph.notes),
        ]
    )
    return result
