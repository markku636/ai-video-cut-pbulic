"""`aivc seq show <project> [--media ID]`（op `sequence.show`；設計 §7.6、§13 M2.7）：人類可讀的序列片段表。

每個 V1 項目一列：序列時間碼、來源時間碼、來源 proxy 幀範圍 k、幀數、原音設定、這段來源範圍裡的替換數（插入來源說會換的 track）；
音訊軌列出每個片段的序列位置（秒＋樣本）、來源入點、增益、淡化與自動化點數。

**唯讀**：M2 的 CLI 不提供剪輯寫入。剪輯語意只有 TS `src/sequence/ops.ts` 一份（決策 12），Python 再寫一份一定漂移；
要自動化剪輯走 M6 的 MCP → App bridge。所以這裡只有 `show` 一個動作，子命令仍寫成 `seq show` 讓將來加動作時不必改名。

為什麼時間碼要兩種：序列 TC 是成品上的位置，來源 TC 是素材上的位置（proxy fps、NDF）；平面替換、追蹤、遮罩都以來源 k 為鍵（D13），
對照「序列哪一段用了素材哪一段、那一段有幾條 track 會被換」是除錯 I2 與剪輯結果最直接的方式。
"""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .. import env
from . import Ctx, OpError, register

if TYPE_CHECKING:
    from ..project import schema as S

_HELP = "序列片段表（唯讀）：序列 TC、來源 TC、k 範圍、原音、替換數與音訊軌片段"


def _args(p: argparse.ArgumentParser) -> None:
    p.add_argument("action", choices=["show"], help="show：列出序列（目前唯一的動作；剪輯在 App 裡做）")
    p.add_argument("project", help="專案檔 *.aivc.json")
    p.add_argument("--media", default=None, help="序列為 null（隱含序列）時用哪支媒體；預設 activeMediaId")


def _seconds(samples: int, sr: int) -> str:
    return f"{samples / sr:.3f}s"


def _replacements(project: "S.ProjectFile", media_id: str, k0: int, k1: int) -> list[dict[str, Any]]:
    """來源範圍 [k0,k1) 內會被替換的 track：插入來源（hooks insert-source）的 describe 說會換、而且 track 所屬鏡頭與範圍有交集
    （不讀 solve，CLI 要快）。每筆＝{trackId, …describe 給的鍵, shot}；沒有插入來源 → 一律空。"""
    from .render import insert_sources

    describers = [src for src in insert_sources() if hasattr(src, "describe")]
    shots = {s.id: s for s in project.shots.get(media_id, [])}
    out: list[dict[str, Any]] = []
    for t in project.tracks.get(media_id, []):
        shot = shots.get(t.shot_id)
        if shot is None:
            continue
        desc = next((d for d in (src.describe(project, media_id, t) for src in describers) if d is not None), None)
        if desc is None:
            continue
        if shot.start_frame < k1 and k0 < shot.end_frame:
            out.append({"trackId": t.id, **desc, "shot": shot.id})
    return out


def describe_sequence(project: "S.ProjectFile", seq: "S.SequenceV2", *, implicit: bool) -> dict[str, Any]:
    from ..project import schema as SCH
    from ..sequence import model as SM
    from .render import timecode

    fps = (int(seq.fps.num), int(seq.fps.den))
    sr = int(seq.sample_rate)
    frames = SM.duration_frames(seq)
    items: list[dict[str, Any]] = []
    for i, p in enumerate(SM.place_video(seq)):
        it = p.item
        row: dict[str, Any] = {
            "index": i + 1, "kind": it.kind, "id": it.id,
            "seqIn": p.t0, "seqOut": p.t1, "frames": p.length, "seqTcIn": timecode(p.t0, fps), "seqTcOut": timecode(p.t1, fps),
            "sampleIn": p.s0, "samples": p.samples,
        }
        if isinstance(it, SCH.VideoClipV2):
            m = project.media_by_id(it.media_id)
            mfps = (int(m.proxy.fps.num), int(m.proxy.fps.den)) if m is not None and m.proxy is not None else fps
            reps = _replacements(project, it.media_id, it.src_in, it.src_out)
            a = it.audio
            row.update({
                "mediaId": it.media_id, "mediaName": (m.name or m.id) if m is not None else None, "label": it.label, "enabled": it.enabled,
                "srcIn": it.src_in, "srcOut": it.src_out, "srcTcIn": timecode(it.src_in, mfps), "srcTcOut": timecode(it.src_out, mfps),
                # sanitize 保留、render 會擋的狀態（§3.5）：媒體不在、proxy 未知或片段超出 proxy 幀數
                "offline": m is None or m.proxy is None or it.src_out > m.proxy.frames,
                "audio": {
                    "enabled": a.enabled, "gainDb": a.gain_db, "fadeIn": a.fade_in, "fadeOut": a.fade_out, "fadeCurve": a.fade_curve,
                    "envelopePoints": len(a.envelope), "detachedTo": a.detached_to,
                },
                "replacements": len(reps), "tracks": reps,
            })
        items.append(row)
    lanes: list[dict[str, Any]] = []
    for lane in seq.audio_lanes:
        clips: list[dict[str, Any]] = []
        for c in lane.clips:
            src = c.source
            ref = None
            if src is not None:
                ref = project.media_by_id(src.ref_id) if src.type == "media" else project.audio_media_by_id(src.ref_id)
            clips.append({
                "id": c.id, "label": c.label, "enabled": c.enabled,
                "source": None if src is None else {"type": src.type, "id": src.ref_id, "name": (ref.name or ref.id) if ref is not None else None},
                "start": c.start, "length": c.length, "end": c.start + c.length,
                "startSeconds": round(c.start / sr, 6), "lengthSeconds": round(c.length / sr, 6), "srcIn": c.src_in,
                "gainDb": c.gain_db, "fadeIn": c.fade_in, "fadeOut": c.fade_out, "fadeCurve": c.fade_curve,
                "envelopePoints": len(c.envelope), "detachedFrom": c.detached_from,
            })
        lanes.append({
            "id": lane.id, "name": lane.name, "role": lane.role, "muted": lane.muted, "locked": lane.locked,
            "syncLock": lane.sync_lock, "gainDb": lane.gain_db, "clips": clips,
        })
    return {
        "id": seq.id, "name": seq.name, "implicit": implicit,
        "untouched": SM.is_untouched(None if implicit else seq, project),
        "fps": {"num": fps[0], "den": fps[1]}, "size": [seq.width, seq.height], "sampleRate": sr,
        "frames": frames, "duration": timecode(frames, fps), "samples": SM.total_samples(seq),
        "original": {"muted": seq.original_muted, "gainDb": seq.original_gain_db},
        "audio": {"edgeDeclickMs": seq.edge_declick_ms, "limiter": seq.limiter},
        **{k: v for k, v in SM.describe(seq).items() if k not in ("id", "frames")},
        "video": items,
        "audioLanes": lanes,
    }


def _human(d: dict[str, Any]) -> str:
    fps = d["fps"]
    head = (
        f"序列 {d['id']}「{d['name']}」{'（隱含：整段素材、未剪輯）' if d['implicit'] else ''}  {fps['num']}/{fps['den']} fps  "
        f"{d['size'][0]}x{d['size'][1]}  {d['frames']} 幀（{d['duration']}，NDF）  S(T)={d['samples']}  "
        + ("未修改 → 輸出走原路徑（-c:a copy）" if d["untouched"] else "已剪輯 → 依序列渲染並重新混音")
    )
    lines = [head, f"{'#':>3}  {'V1':<10} {'序列 TC':<25} {'來源 TC':<25} {'k 範圍':<14} {'幀':>5}  {'媒體':<18} {'換':>3}  原音"]
    for r in d["video"]:
        seq_tc = f"{r['seqTcIn']}→{r['seqTcOut']}"
        if r["kind"] == "gap":
            lines.append(f"{r['index']:>3}  {r['id'][:10]:<10} {seq_tc:<25} {'（空白：黑畫面＋靜音）':<25} {'':<14} {r['frames']:>5}")
            continue
        a = r["audio"]
        if a["detachedTo"]:
            audio = f"已分離 → {a['detachedTo']}"
        elif not a["enabled"]:
            audio = "靜音"
        else:
            parts = [f"{a['gainDb']:+g} dB"]
            if a["fadeIn"] or a["fadeOut"]:
                parts.append(f"淡入 {a['fadeIn']}／淡出 {a['fadeOut']} 樣本")
            if a["envelopePoints"]:
                parts.append(f"自動化 {a['envelopePoints']} 點")
            audio = "、".join(parts)
        flags = ("" if r["enabled"] else " [停用]") + (" [離線]" if r["offline"] else "")
        name = str(r["mediaName"] or r["mediaId"])[:18]
        src_tc = f"{r['srcTcIn']}→{r['srcTcOut']}"
        k_rng = f"[{r['srcIn']}, {r['srcOut']})"
        lines.append(f"{r['index']:>3}  {r['id'][:10]:<10} {seq_tc:<25} {src_tc:<25} {k_rng:<14} {r['frames']:>5}  {name:<18} {r['replacements']:>3}  {audio}{flags}")
    o = d["original"]
    bus = "靜音" if o["muted"] else f"推桿 {o['gainDb']:+g} dB"
    lines.append(f"A0 原音  {bus}  防爆音 {d['audio']['edgeDeclickMs']:g} ms  限幅器 {'開' if d['audio']['limiter'] else '關'}")
    sr = d["sampleRate"]
    for lane in d["audioLanes"]:
        lines.append(
            f"{lane['name']}（{lane['id']}，{lane['role']}）  {'靜音 ' if lane['muted'] else ''}{'鎖定 ' if lane['locked'] else ''}"
            f"同步鎖 {'開' if lane['syncLock'] else '關'}  推桿 {lane['gainDb']:+g} dB  {len(lane['clips'])} 段"
        )
        for c in lane["clips"]:
            src = c["source"] or {}
            fades = f"  淡入 {_seconds(c['fadeIn'], sr)}／淡出 {_seconds(c['fadeOut'], sr)}" if (c["fadeIn"] or c["fadeOut"]) else ""
            env_ = f"  自動化 {c['envelopePoints']} 點" if c["envelopePoints"] else ""
            lines.append(
                f"     {c['id'][:12]:<12} {_seconds(c['start'], sr)} → {_seconds(c['end'], sr)}（{c['start']}＋{c['length']} 樣本）"
                f"  {src.get('name') or src.get('id') or '?'} 入點 {c['srcIn']}  {c['gainDb']:+g} dB{fades}{env_}{'' if c['enabled'] else '  [靜音]'}"
            )
    return "\n".join(lines)


@register("sequence.show", cli="seq", help=_HELP, args=_args)
def seq_show_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    from ..project import schema as SCH
    from .audio_mix import implicit_sequence

    action = str(args.get("action") or "show")
    if action != "show":
        raise OpError("Invalid", f"seq 只支援 show（收到 {action!r}）", "剪輯在 App 裡做；CLI 是唯讀的")
    raw = args.get("project")
    if not raw:
        raise OpError("Invalid", "缺少專案檔路徑")
    r = SCH.load(Path(env.normalize_path(str(raw))))
    for w in r.warnings:
        ctx.log("warn", f"專案檔：{w}")
    project = r.project
    implicit = project.sequence is None
    seq = implicit_sequence(project, args.get("media")) if implicit else project.sequence
    assert seq is not None
    d = describe_sequence(project, seq, implicit=implicit)
    d["_human"] = _human(d)
    return d
