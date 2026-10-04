"""Probe：影片的靜態事實（計畫 §5.2 / §6.8）。PyAV 優先，失敗退到 ffprobe -print_format json。

範例影片（samples/README.md 的 clip1）的預期：duration_ms None、nb_frames None、fps 30/1（r_frame_rate，avg 是 0/0）、
color_range 'tv'、matrix/primaries/trc 全 None → `matrix_assumed='bt709'`（高 720 ≥ 576 的啟發式，並記進 probe）。
色彩 tag 取自**解出來的第一幀**而不是 codec context：VP9/H.264 的色彩資訊在位元流裡，開檔當下 context 常是 unspecified。
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any

# libavutil 列舉 → ffprobe 字串（2 = unspecified → None）
_RANGE = {1: "tv", 2: "pc"}
_SPACE = {
    0: "rgb", 1: "bt709", 4: "fcc", 5: "bt470bg", 6: "smpte170m", 7: "smpte240m", 8: "ycgco",
    9: "bt2020nc", 10: "bt2020c", 11: "smpte2085", 12: "chroma-derived-nc", 13: "chroma-derived-c", 14: "ictcp",
}
_PRIMARIES = {
    1: "bt709", 4: "bt470m", 5: "bt470bg", 6: "smpte170m", 7: "smpte240m", 8: "film", 9: "bt2020",
    10: "smpte428", 11: "smpte431", 12: "smpte432", 22: "jedec-p22",
}
_TRC = {
    1: "bt709", 4: "gamma22", 5: "gamma28", 6: "smpte170m", 7: "smpte240m", 8: "linear", 9: "log100", 10: "log316",
    11: "iec61966-2-4", 12: "bt1361e", 13: "iec61966-2-1", 14: "bt2020-10", 15: "bt2020-12", 16: "smpte2084",
    17: "smpte428", 18: "arib-std-b67",
}
_BT601_SPACES = {"bt470bg", "smpte170m", "fcc", "smpte240m"}


@dataclass
class Probe:
    path: str
    container: str  # ffmpeg format name，例如 "matroska,webm"
    size_bytes: int
    codec: str
    width: int
    height: int
    pix_fmt: str
    fps_num: int  # r_frame_rate
    fps_den: int
    time_base_num: int
    time_base_den: int
    avg_fps_num: int | None = None  # avg_frame_rate；0/0 → None
    avg_fps_den: int | None = None
    start_ms: float | None = None
    duration_ms: float | None = None  # 標頭沒有就是 None（不要猜；真正的長度靠 index）
    nb_frames: int | None = None
    color_range: str | None = None  # "tv" | "pc" | None
    color_space: str | None = None
    color_primaries: str | None = None
    color_trc: str | None = None
    matrix_assumed: str = "bt709"  # 色彩數學實際採用的矩陣："bt709" | "bt601"
    matrix_source: str = "heuristic"  # "tag" | "heuristic"
    rotation: int = 0  # 0/90/180/270（display matrix）
    has_b_frames: int = 0
    has_audio: bool = False
    audio_codec: str | None = None
    audio_sample_rate: int | None = None
    audio_channels: int | None = None
    source: str = "pyav"  # "pyav" | "ffprobe"

    @property
    def fps(self) -> Fraction:
        return Fraction(self.fps_num, self.fps_den)

    @property
    def range_or_default(self) -> str:
        return self.color_range or "tv"

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        d["version"] = 1
        return d

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> "Probe":
        d = dict(d)
        d.pop("version", None)
        return cls(**d)


def assumed_matrix(color_space: str | None, height: int) -> tuple[str, str]:
    """tag 有就信 tag；unknown 時 高≥576 當 BT.709、否則 BT.601（計畫決策 5）。"""
    if color_space == "bt709":
        return "bt709", "tag"
    if color_space in _BT601_SPACES:
        return "bt601", "tag"
    if color_space and color_space.startswith("bt2020"):
        return "bt709", "tag"  # HDR 不在 v1；用 709 矩陣近似，probe 仍保留原 tag
    return ("bt709" if height >= 576 else "bt601"), "heuristic"


def probe(path: str | os.PathLike[str]) -> Probe:
    """PyAV → 失敗退 ffprobe。兩個都失敗擲最後一個例外。"""
    p = os.fspath(path)
    if not os.path.isfile(p):
        raise FileNotFoundError(p)
    try:
        return probe_pyav(p)
    except Exception as first:  # noqa: BLE001
        try:
            return probe_ffprobe(p)
        except Exception as second:  # noqa: BLE001
            raise RuntimeError(f"PyAV 與 ffprobe 都讀不了 {p}：{first!r} / {second!r}") from second


def probe_pyav(path: str) -> Probe:
    import av

    from .index import stream_fps

    with av.open(path) as c:
        if not c.streams.video:
            raise ValueError("沒有影像串流")
        v = c.streams.video[0]
        tb = Fraction(v.time_base)
        fps = stream_fps(v)
        avg = Fraction(v.average_rate) if v.average_rate else None
        duration_ms: float | None = None
        if v.duration:
            duration_ms = float(Fraction(v.duration) * tb * 1000)
        elif c.duration:
            duration_ms = c.duration / 1000.0
        start_ms = float(Fraction(v.start_time) * tb * 1000) if v.start_time is not None else None
        # 解第一幀拿位元流裡的色彩 tag 與 rotation（display matrix 由 PyAV 折成角度）
        frame = None
        for frame in c.decode(v):
            break
        if frame is None:
            raise ValueError("解不出第一幀")
        cc = v.codec_context
        color_range = _RANGE.get(int(frame.color_range or 0)) or _RANGE.get(int(cc.color_range or 0))
        color_space = _SPACE.get(int(frame.colorspace if frame.colorspace is not None else 2))
        if color_space is None:
            color_space = _SPACE.get(int(cc.colorspace or 2))
        primaries = _PRIMARIES.get(int(frame.color_primaries or 2)) or _PRIMARIES.get(int(cc.color_primaries or 2))
        trc = _TRC.get(int(frame.color_trc or 2)) or _TRC.get(int(cc.color_trc or 2))
        rot = int(getattr(frame, "rotation", 0) or 0) % 360
        audio = c.streams.audio[0] if c.streams.audio else None
        matrix, msrc = assumed_matrix(color_space, int(v.height))
        return Probe(
            path=path,
            container=c.format.name,
            size_bytes=os.path.getsize(path),
            codec=cc.name,
            width=int(v.width),
            height=int(v.height),
            pix_fmt=str(frame.format.name),
            fps_num=fps.numerator,
            fps_den=fps.denominator,
            time_base_num=tb.numerator,
            time_base_den=tb.denominator,
            avg_fps_num=avg.numerator if avg else None,
            avg_fps_den=avg.denominator if avg else None,
            start_ms=start_ms,
            duration_ms=duration_ms,
            nb_frames=int(v.frames) if v.frames else None,
            color_range=color_range,
            color_space=color_space,
            color_primaries=primaries,
            color_trc=trc,
            matrix_assumed=matrix,
            matrix_source=msrc,
            rotation=rot,
            has_b_frames=int(cc.has_b_frames or 0),
            has_audio=audio is not None,
            audio_codec=audio.codec_context.name if audio else None,
            audio_sample_rate=int(audio.rate) if audio and audio.rate else None,
            audio_channels=int(audio.channels) if audio and audio.channels else None,
            source="pyav",
        )


def probe_ffprobe(path: str) -> Probe:
    from . import ffmpeg as ff

    out = ff.run([ff.exe("ffprobe"), "-v", "error", "-show_format", "-show_streams", "-print_format", "json", path], timeout=60)
    return probe_from_ffprobe_json(json.loads(out.stdout.decode("utf-8", "replace")), path)


def probe_from_ffprobe_json(doc: dict[str, Any], path: str) -> Probe:
    """純函式：ffprobe JSON → Probe（可用 fixture 測）。"""
    streams = doc.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")), None)
    if video is None:
        raise ValueError("ffprobe：沒有影像串流")
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    fmt = doc.get("format", {})
    fps = _frac(video.get("r_frame_rate")) or _frac(video.get("avg_frame_rate")) or Fraction(30, 1)
    avg = _frac(video.get("avg_frame_rate"))
    tb = _frac(video.get("time_base")) or Fraction(1, 1000)
    dur = video.get("duration") or fmt.get("duration")
    height = int(video.get("height") or 0)
    space = video.get("color_space")
    matrix, msrc = assumed_matrix(space, height)
    rotation = 0
    for sd in video.get("side_data_list") or []:
        if "rotation" in sd:
            rotation = int(round(float(sd["rotation"]))) % 360
    if not rotation and (video.get("tags") or {}).get("rotate"):
        rotation = int(video["tags"]["rotate"]) % 360
    return Probe(
        path=path,
        container=str(fmt.get("format_name", "")),
        size_bytes=int(fmt.get("size") or (os.path.getsize(path) if os.path.isfile(path) else 0)),
        codec=str(video.get("codec_name", "")),
        width=int(video.get("width") or 0),
        height=height,
        pix_fmt=str(video.get("pix_fmt", "")),
        fps_num=fps.numerator,
        fps_den=fps.denominator,
        time_base_num=tb.numerator,
        time_base_den=tb.denominator,
        avg_fps_num=avg.numerator if avg else None,
        avg_fps_den=avg.denominator if avg else None,
        start_ms=float(video["start_time"]) * 1000 if video.get("start_time") is not None else None,
        duration_ms=float(dur) * 1000 if dur is not None else None,
        nb_frames=int(video["nb_frames"]) if video.get("nb_frames") else None,
        color_range=video.get("color_range"),
        color_space=space,
        color_primaries=video.get("color_primaries"),
        color_trc=video.get("color_transfer"),
        matrix_assumed=matrix,
        matrix_source=msrc,
        rotation=rotation,
        has_b_frames=int(video.get("has_b_frames") or 0),
        has_audio=audio is not None,
        audio_codec=audio.get("codec_name") if audio else None,
        audio_sample_rate=int(audio["sample_rate"]) if audio and audio.get("sample_rate") else None,
        audio_channels=int(audio["channels"]) if audio and audio.get("channels") else None,
        source="ffprobe",
    )


def _frac(s: str | None) -> Fraction | None:
    """"30/1" → 30；"0/0" 或空 → None。"""
    if not s:
        return None
    try:
        f = Fraction(s)
    except (ValueError, ZeroDivisionError):
        return None
    return f if f > 0 else None


def save_probe(path: Path, p: Probe) -> Path:
    from .cache import write_json

    return write_json(path, p.to_json())


def load_probe(path: Path) -> Probe | None:
    from .cache import read_json

    d = read_json(path)
    if not d or d.get("version") != 1:
        return None
    try:
        return Probe.from_json(d)
    except TypeError:
        return None
