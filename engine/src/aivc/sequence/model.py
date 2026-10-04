"""序列對應表的純函式（設計 §3.1、§3.3、§7.1；TS 鏡像 `src/sequence/map.ts`）。

全部是整數運算、零重依賴（不 import numpy／av），render、plan、CLI、測試都能直接用。

時間換算（設計 §3.1）：

    S(t)            = floor(t · 48000 · fps.den / fps.num)            序列幀 t 的起始樣本；一律從絕對 t 算，不累加
    clipLen         = S(t1) − S(t0)                                    相鄰片段鋪滿不留縫、不重疊（29.97 fps 也成立）
    absUs(k)        = videoStartUs + round(k · 1e6 · fps.den / fps.num) proxy 幀 k 的容器絕對時間
    absUs(srcIn)    = startUs + round(srcIn · 1e6 / sampleRate)        音訊片段入點的容器絕對時間

為什麼 S(t) 用 floor 並從 t 直接算：每個片段各自 round 會在接縫留下 ±1 樣本的縫或重疊，200 個片段後漂 200 樣本；
從絕對 t 算的話 Σ(S(t1) − S(t0)) 會 telescoping 成 S(T)，怎麼切都鋪得滿（map-cases 的 29.97-odd-lengths-tiling 驗這件事）。

為什麼 round 是 half-up 而不是 Python 的 round()：TS 端是 `Math.round`（x.5 一律往 +∞），Python 的 round() 是銀行家捨入
（62.5 → 62），同一個片段在兩邊會差 1 µs，golden 就對不起來。這裡用整數分數算，完全不經過浮點。
"""
from __future__ import annotations

from bisect import bisect_right
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Callable, Protocol

from ..project.schema import SEQ_SAMPLE_RATE, GapV2, SequenceV2, VideoClipV2

if TYPE_CHECKING:
    from ..project.schema import ProjectFile

US_PER_SECOND = 1_000_000


class _Fps(Protocol):
    num: int
    den: int


def samples_of_frame(t: int, fps: _Fps, sr: int = SEQ_SAMPLE_RATE) -> int:
    """S(t)：序列幀 t 的起始樣本（floor；Python 的 // 對負數也是 floor，與 TS Math.floor 一致）。"""
    return (t * sr * fps.den) // fps.num


def round_half_up(num: int, den: int) -> int:
    """num/den 四捨五入到整數，x.5 往 +∞（= JS Math.round）；den 可為負。"""
    if den < 0:
        num, den = -num, -den
    return (2 * num + den) // (2 * den)


def video_abs_us(k: int, fps: _Fps, video_start_us: int) -> int:
    """proxy 幀 k 的容器絕對時間（µs）：音訊鏈 `atrim start` 的依據（設計 §7.3 V1 片段的 inUs／outUs）。"""
    return video_start_us + round_half_up(k * US_PER_SECOND * fps.den, fps.num)


def audio_abs_us(src_in: int, start_us: int, sample_rate: int) -> int:
    """音訊片段入點（來源原生樣本，可為負）的容器絕對時間（µs）。0 = 音訊串流第一個解碼樣本。"""
    return start_us + round_half_up(src_in * US_PER_SECOND, sample_rate)


@dataclass(frozen=True)
class Placed:
    """V1 項目在序列上的位置。t0／t1 是序列幀（含／不含）；s0／s1 = S(t0)／S(t1)（原音鏈的 delay 與長度）。"""

    item: VideoClipV2 | GapV2
    t0: int
    t1: int
    s0: int
    s1: int

    @property
    def length(self) -> int:
        return self.t1 - self.t0

    @property
    def samples(self) -> int:
        return self.s1 - self.s0


def _item_len(it: VideoClipV2 | GapV2) -> int:
    return it.src_out - it.src_in if isinstance(it, VideoClipV2) else it.length


def place_video(seq: SequenceV2) -> list[Placed]:
    """V1 磁吸：位置 = 前面所有項目長度之和（位置不存檔，所以只能由順序推）。"""
    out: list[Placed] = []
    t = 0
    for it in seq.video:
        t1 = t + _item_len(it)
        out.append(Placed(it, t, t1, samples_of_frame(t, seq.fps, seq.sample_rate), samples_of_frame(t1, seq.fps, seq.sample_rate)))
        t = t1
    return out


def duration_frames(seq: SequenceV2) -> int:
    """T：序列總幀數。"""
    return sum(_item_len(it) for it in seq.video)


def total_samples(seq: SequenceV2) -> int:
    """S(T)：輸出音訊解碼後應該剛好有的樣本數（不變式 I3）。"""
    return samples_of_frame(duration_frames(seq), seq.fps, seq.sample_rate)


def _find(placed: list[Placed], t: int, starts: list[int] | None = None) -> Placed | None:
    if t < 0 or not placed or t >= placed[-1].t1:
        return None
    keys = starts if starts is not None else [p.t0 for p in placed]
    i = bisect_right(keys, t) - 1
    return placed[i] if i >= 0 else None


def item_at(seq: SequenceV2, t: int, placed: list[Placed] | None = None) -> tuple[VideoClipV2 | GapV2 | None, int | None]:
    """覆蓋 t 的項目（含空白與停用片段）與其來源幀；時間軸命中、UI 標示用。空白的 k 是 None。"""
    p = _find(placed if placed is not None else place_video(seq), t)
    if p is None:
        return None, None
    if isinstance(p.item, VideoClipV2):
        return p.item, p.item.src_in + (t - p.t0)
    return p.item, None


def map_frame_placed(placed: list[Placed], t: int, starts: list[int] | None = None) -> tuple[VideoClipV2 | None, int | None]:
    """`map_frame` 的迴圈版：render 逐幀查表時先 place_video 一次，`starts` 傳 [p.t0…] 省掉每幀重建。"""
    p = _find(placed, t, starts)
    if p is None or not isinstance(p.item, VideoClipV2) or not p.item.enabled:
        return None, None
    return p.item, p.item.src_in + (t - p.t0)


def map_frame(seq: SequenceV2, t: int) -> tuple[VideoClipV2 | None, int | None]:
    """t → (片段, 來源 proxy 幀 k)；空白、停用、超出範圍回 (None, None)（輸出黑畫面）。

    牌面替換永遠依來源 k 合成（決策 D13）：同一個 k 出現在序列哪裡、出現幾次，輸出的像素都相同。
    """
    return map_frame_placed(place_video(seq), t)


def is_untouched_with(seq: SequenceV2 | None, frames_of: Callable[[str], int | None]) -> bool:
    """`-c:a copy` 閘門的純函式核心（設計 §7.1）。frames_of(mediaId) → proxy 幀數（未知回 None）。

    比的是**值**不是 null：B 切一刀再合併、序列已實體化但等於整段未動的片段，仍回到 copy 路徑。
    刻意不看的東西：fadeCurve（淡化長度 0 時不影響輸出）、軌道本身的 muted／gainDb（沒片段就沒聲音）、
    sequence.audio（單一整段片段沒有接縫要防爆音，限幅器也不在 copy 路徑上）。
    媒體幀數未知 → False：沒辦法證明是整段，保守地重新混音（錯的 copy 會輸出與序列不符的聲音）。
    """
    if seq is None:
        return True
    if len(seq.video) != 1:
        return False
    it = seq.video[0]
    if not isinstance(it, VideoClipV2) or not it.enabled or it.src_in != 0:
        return False
    frames = frames_of(it.media_id)
    if frames is None or it.src_out != frames:
        return False
    if not it.audio.is_default:
        return False
    if seq.original_muted or seq.original_gain_db != 0:
        return False
    return all(not lane.clips for lane in seq.audio_lanes)


def is_untouched(seq: SequenceV2 | None, project: "ProjectFile") -> bool:
    """`-c:a copy` 閘門（設計 §7.1）：成立就走 v0.0.6 原路徑（不變式 I4 零回歸）。"""

    def frames_of(media_id: str) -> int | None:
        m = project.media_by_id(media_id)
        return m.proxy.frames if m is not None and m.proxy is not None else None

    return is_untouched_with(seq, frames_of)


def describe(seq: SequenceV2) -> dict[str, Any]:
    """plan JSON 的 `sequence` 區塊用的計數（設計 §7.6）；untouched 由呼叫端依專案算。"""
    clips = [it for it in seq.video if isinstance(it, VideoClipV2)]
    return {
        "id": seq.id,
        "frames": duration_frames(seq),
        "clips": len(clips),
        "gaps": sum(1 for it in seq.video if isinstance(it, GapV2)),
        "disabled": sum(1 for c in clips if not c.enabled),
        "audioClips": sum(len(lane.clips) for lane in seq.audio_lanes),
    }
