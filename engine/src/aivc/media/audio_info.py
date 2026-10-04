"""音訊時間資訊 `audio.v1.json`（設計 docs/editor-m2-design.md §3.4、§7.3、§13 M2.5）。

只解音訊串流一趟（PyAV，範例 60 s Opus 約 0.1 s ≈ 570 倍即時），記下渲染對齊需要的事實：

- `startUs`：第一個**解碼後**樣本的容器絕對時間（µs）。解碼器丟掉的樣本已經算進去：
  mp3 的 LAME 延遲（44.1 kHz 1105 樣本 → 25 057 µs）、Opus pre-skip、AAC priming（mp4 edit list）。
  渲染鏈用 `-copyts` 加 `atrim start=<絕對時間>` 裁切，看到的就是這條時間軸，所以這裡要用解碼後的 pts，
  不是容器標頭的 `start_time`（兩者在 mp3 上剛好相同；標頭值另外記成 `streamStartUs` 供診斷）。
- `videoStartUs`：影片第一幀 pts（= index.v1.json 的 `pts_ms[0]`，CfrMap 的時間原點）；純音訊檔（含只有封面圖的 mp3）為 null。
- `nSamples`／`gaps`：模擬 `aresample=async=1:min_hard_comp=0.020` 的硬補償，以原生取樣率計。
  pts 比目前輸出位置晚超過 20 ms → 斷層（補靜音、記進 gaps）；早超過 20 ms → 重疊（丟樣本、記進 overlaps）。
  為什麼不直接數解出來的樣本：Chrome 錄影常有音訊斷層，數樣本會讓斷層之後的聲音整段提早（§7.5 實測早 1.000 s）。
  為什麼不做軟補償：`async=1` 不大於 1.0001，swresample 不會設 max_soft_comp，只有硬補償（與渲染的行為一致）。

為什麼另開 `audio.v1.json` 而不塞進 `index.v1.json`：舊快取沒有這段，加欄位等於讓每個人的 index 重解一次視訊。
快取目錄以指紋為鍵（檔案內容變了就是別的目錄），所以版本號對、欄位完整就能直接用；壞掉或舊版就當缺快取重算。
"""
from __future__ import annotations

import os
import re
import time
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path
from typing import Any

from ..project.schema import AudioInfoV2
from .cache import MediaCache, read_json, write_json
from .index import NoopCtx, load_index

AUDIO_INFO_VERSION = 1
AUDIO_INFO_FILE = "audio.v1.json"
# 與渲染鏈 aresample 的 min_hard_comp=0.020 相同：小於這個的 pts 抖動（WebM 整數 ms）不算斷層
HARD_COMP_US = 20_000
US = 1_000_000
# attached_pic（AV_DISPOSITION_ATTACHED_PIC）：mp3／m4a 的封面圖會被 demuxer 當成一條影像串流，不能讓它把純音訊檔變成「影片」
_ATTACHED_PIC = 0x0400
# 取影片起點時最多看幾個解碼幀（B 幀重排後第一個輸出通常就是最小 pts，多看幾個保險）
_VIDEO_START_FRAMES = 4


def audio_info_path(mc: MediaCache) -> Path:
    return mc.dir / AUDIO_INFO_FILE


def _us(pts: int, tb: Fraction) -> Fraction:
    return Fraction(pts) * tb * US


def _round_us(x: Fraction) -> int:
    """µs 四捨五入（x.5 往 +∞，同 sequence.model.round_half_up／JS Math.round）。"""
    return int((x + Fraction(1, 2)).__floor__())


@dataclass
class AudioScan:
    """一次掃描的完整結果；`info` 是寫進專案檔 `media[].audio` 的摘要，其餘是只留在快取裡的診斷。"""

    has_audio: bool
    info: AudioInfoV2 | None = None
    stream_index: int | None = None  # 容器內的串流編號（`0:a:0` 對到哪一條）
    audio_streams: int = 0
    stream_start_us: int | None = None  # 容器標頭的 start_time（µs）
    decoded_samples: int = 0  # 真的解出來的樣本數（不含補靜音、含重疊）
    frames: int = 0
    overlaps: list[tuple[int, int]] = field(default_factory=list)  # (at_us, dur_us)：pts 往回跳 > 20 ms，渲染時會丟樣本
    format_changes: int = 0  # 串流中途換取樣率／聲道（罕見；nSamples 以第一段的取樣率換算）
    seconds: float = 0.0

    def to_json(self) -> dict[str, Any]:
        return {
            "version": AUDIO_INFO_VERSION,
            "hasAudio": self.has_audio,
            "audio": self.info.to_json() if self.info is not None else None,
            "streamIndex": self.stream_index,
            "audioStreams": self.audio_streams,
            "streamStartUs": self.stream_start_us,
            "decodedSamples": self.decoded_samples,
            "frames": self.frames,
            "overlaps": [{"atUs": a, "durUs": d} for a, d in self.overlaps],
            "formatChanges": self.format_changes,
            "seconds": round(self.seconds, 3),
        }

    @classmethod
    def from_json(cls, d: Any) -> "AudioScan | None":
        """快取 → AudioScan；版本不對、欄位壞掉回 None（呼叫端當缺快取重算）。"""
        if not isinstance(d, dict) or d.get("version") != AUDIO_INFO_VERSION or not isinstance(d.get("hasAudio"), bool):
            return None
        info = None
        if d["hasAudio"]:
            problems: list[str] = []
            info = AudioInfoV2.from_json(d.get("audio"), problems.append, "audio.v1.json")
            if info is None or problems:
                return None
        try:
            overlaps = [(int(o["atUs"]), int(o["durUs"])) for o in d.get("overlaps") or []]
            return cls(
                has_audio=d["hasAudio"],
                info=info,
                stream_index=d.get("streamIndex") if isinstance(d.get("streamIndex"), int) else None,
                audio_streams=int(d.get("audioStreams") or 0),
                stream_start_us=d.get("streamStartUs") if isinstance(d.get("streamStartUs"), int) else None,
                decoded_samples=int(d.get("decodedSamples") or 0),
                frames=int(d.get("frames") or 0),
                overlaps=overlaps,
                format_changes=int(d.get("formatChanges") or 0),
                seconds=float(d.get("seconds") or 0.0),
            )
        except (KeyError, TypeError, ValueError):
            return None


class PtsAligner:
    """`aresample=async=1:min_hard_comp=0.020` 的硬補償模擬（原生取樣率、純函式，測試直接餵 (pts, 樣本數)）。

    輸出位置 out 從第一個有 pts 的幀開始算 0。每一幀先算「依 pts 應該在第幾個樣本」，和目前 out 差超過 20 ms：
    晚了 → 補靜音（斷層）、早了 → 丟掉這一幀開頭的樣本（重疊）；20 ms 以內照數樣本（WebM 的整數 ms pts 抖動不算）。
    """

    def __init__(self, sample_rate: int) -> None:
        self.sample_rate = sample_rate
        self.start_us: Fraction | None = None
        self.out = 0
        self.gaps: list[tuple[int, int]] = []
        self.overlaps: list[tuple[int, int]] = []
        self._thr = HARD_COMP_US * sample_rate // US

    @property
    def elapsed_us(self) -> int:
        return int(Fraction(self.out * US, self.sample_rate))

    def push(self, at_us: Fraction | None, n: int) -> None:
        if at_us is None:
            # 沒有 pts 的幀：接在上一幀後面（swresample 對 NOPTS 也是這樣）
            self.out += n
            return
        if self.start_us is None:
            # 第一個有 pts 的幀之前若有沒 pts 的幀，它們算在起點之前
            self.start_us = at_us - Fraction(self.out * US, self.sample_rate)
        want = _round_us((at_us - self.start_us) * self.sample_rate / US)
        delta = want - self.out
        if delta > self._thr:
            self.gaps.append((_round_us(self.start_us + Fraction(self.out * US, self.sample_rate)), _round_us(Fraction(delta * US, self.sample_rate))))
            self.out += delta
        elif delta < -self._thr:
            self.overlaps.append((_round_us(at_us), _round_us(Fraction(-delta * US, self.sample_rate))))
            n -= min(-delta, n)
        self.out += n


def _is_attached_pic(stream: Any) -> bool:
    try:
        return bool(int(stream.disposition) & _ATTACHED_PIC)
    except (TypeError, ValueError):
        return False


def _layout_name(layout: Any) -> str | None:
    """聲道佈局名；未指定佈局時 PyAV 回 "1 channels" 這種占位字串，當成 null（ffprobe 同樣不給 channel_layout）。"""
    name = getattr(layout, "name", None)
    if not isinstance(name, str) or not name or re.fullmatch(r"\d+ channels?", name):
        return None
    return name


def _codec_name(stream: Any) -> str:
    """ffprobe 的 codec_name（mp3、aac、opus）；PyAV 的 codec_context.name 是解碼器名（mp3float），UI 看不懂。"""
    cc = stream.codec_context
    try:
        return str(cc.codec.canonical_name or cc.name)
    except AttributeError:
        return str(cc.name)


def _video_start_us_from_index(mc: MediaCache | None) -> int | None:
    if mc is None:
        return None
    loaded = load_index(mc.index_json)
    if not loaded or not loaded[0].pts_ms:
        return None
    # pts_ms 是 Fraction(pts)·tb·1000 轉 float：µs 精度內可逆，四捨五入回整數 µs
    return _round_us(Fraction(loaded[0].pts_ms[0]).limit_denominator(1_000_000) * 1000)


def scan(path: str | os.PathLike[str], ctx: Any | None = None, mc: MediaCache | None = None) -> AudioScan:
    """解第一條音訊串流一趟（`0:a:0`，與渲染 `-map`／`[i:a]` 選到的同一條）。影片起點優先讀 index 快取。"""
    import av  # 重 import 放函式內（aivc --help 不碰）

    ctx = ctx or NoopCtx()
    t_start = time.perf_counter()
    video_start = _video_start_us_from_index(mc)
    with av.open(os.fspath(path)) as c:
        audio_streams = list(c.streams.audio)
        videos = [s for s in c.streams.video if not _is_attached_pic(s)]
        if not audio_streams:
            return AudioScan(has_audio=False, audio_streams=0, seconds=time.perf_counter() - t_start)
        a = audio_streams[0]
        v = videos[0] if videos and video_start is None else None
        a_tb = Fraction(a.time_base)
        stream_start = _round_us(_us(a.start_time, a_tb)) if a.start_time is not None else None
        total_us: int | None = None
        if a.duration:
            total_us = _round_us(_us(a.duration, a_tb))
        elif c.duration:
            total_us = int(c.duration)  # AV_TIME_BASE = µs

        video_pts: list[Fraction] = []
        aligner: PtsAligner | None = None
        channels = 0
        layout: str | None = None
        decoded = frames = format_changes = 0
        streams = (a, v) if v is not None else (a,)
        for packet in c.demux(*streams):
            if packet.stream.type == "video":
                if len(video_pts) >= _VIDEO_START_FRAMES:
                    continue  # 影片起點已經拿到：影像封包只讀不解
                for vf in packet.decode():
                    p = vf.pts if vf.pts is not None else vf.dts
                    if p is not None:
                        video_pts.append(_us(p, Fraction(vf.time_base or v.time_base)))  # type: ignore[union-attr]
                continue
            for fr in packet.decode():
                n = int(fr.samples)
                if n <= 0:
                    continue
                rate = int(fr.sample_rate)
                if aligner is None:
                    aligner, layout, channels = PtsAligner(rate), _layout_name(fr.layout), len(fr.layout.channels)
                elif rate != aligner.sample_rate or len(fr.layout.channels) != channels:
                    format_changes += 1
                decoded += n
                frames += 1
                p = fr.pts if fr.pts is not None else fr.dts
                tb = Fraction(fr.time_base) if fr.time_base else a_tb
                # 中途換取樣率：換算成第一段的率（aresample 也會重取樣成同一個率）
                aligner.push(_us(p, tb) if p is not None else None, n * aligner.sample_rate // rate)
                if frames % 256 == 0:
                    ctx.check_cancel()
                    if total_us:
                        ctx.progress("audio_info", min(aligner.elapsed_us, total_us), total_us)
        if video_pts:
            video_start = _round_us(min(video_pts))
        if aligner is not None and aligner.start_us is None and aligner.out > 0:
            # 整條串流都沒有 pts（極罕見的裸流）：只能數樣本，起點用容器標頭的 start_time
            aligner.start_us = Fraction(stream_start or 0)
        if aligner is None or aligner.start_us is None:
            # 有音訊串流但一個樣本都解不出來（壞檔、DRM）：當作沒有音訊，UI 顯示「無音訊」而不是算出假的時間
            return AudioScan(has_audio=False, stream_index=a.index, audio_streams=len(audio_streams), stream_start_us=stream_start, seconds=time.perf_counter() - t_start)
        ctx.progress("audio_info", total_us or 1, total_us or 1)
        info = AudioInfoV2(
            codec=_codec_name(a),
            sample_rate=aligner.sample_rate,
            channels=channels,
            channel_layout=layout,
            start_us=_round_us(aligner.start_us),
            video_start_us=video_start if videos else None,
            n_samples=aligner.out,
            gaps=aligner.gaps,
        )
        return AudioScan(
            has_audio=True,
            info=info,
            stream_index=a.index,
            audio_streams=len(audio_streams),
            stream_start_us=stream_start,
            decoded_samples=decoded,
            frames=frames,
            overlaps=aligner.overlaps,
            format_changes=format_changes,
            seconds=time.perf_counter() - t_start,
        )


def load_cached(mc: MediaCache) -> tuple[AudioScan | None, str]:
    """回 (掃描結果, 狀態)；狀態 = "ok" | "missing" | "invalid"（舊版本或壞 JSON → 呼叫端標 stale 重算）。"""
    p = audio_info_path(mc)
    if not p.is_file():
        return None, "missing"
    s = AudioScan.from_json(read_json(p))
    return (s, "ok") if s is not None else (None, "invalid")


def save(mc: MediaCache, s: AudioScan) -> Path:
    return write_json(audio_info_path(mc), s.to_json())


def ensure(path: str | os.PathLike[str], mc: MediaCache, ctx: Any | None = None, force: bool = False) -> tuple[AudioScan, bool, str]:
    """有效快取就用，否則重算並寫檔。回 (結果, cached, reason)；reason ∈ ok／missing／invalid／force。"""
    if not force:
        cached, state = load_cached(mc)
        if cached is not None:
            return cached, True, state
    else:
        state = "force"
    mc.ensure()
    s = scan(path, ctx, mc)
    save(mc, s)
    return s, False, state


__all__ = ["AUDIO_INFO_VERSION", "AUDIO_INFO_FILE", "HARD_COMP_US", "AudioScan", "audio_info_path", "scan", "load_cached", "save", "ensure"]
