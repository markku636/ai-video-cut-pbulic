"""序列音訊濾鏡圖（設計 docs/editor-m2-design.md §7.3–§7.6；§13 M2.6）：純函式，不碰 ffmpeg、不讀檔。

`build(seq, project, window)` 把序列變成一張 ffmpeg `filter_complex` 文字（寫檔後用 `-/filter_complex <file>` 傳，
避開 Windows 32 767 字元的命令列上限）。每個「會發聲」的片段一個 `-i` 輸入、一條鏈：

    [i:a]atrim=start=<inUs>:end=<outUs>              容器絕對時間（全域 -copyts），6 位小數 = µs
        ,asetpts=PTS-STARTPTS                         片段內相對時間；保留內部斷層的 pts
        ,aresample=48000:async=1:min_hard_comp=0.020:first_pts=0
        [,pan=stereo|c0=c0|c1=c0]                     單聲道來源
        ,aformat=sample_fmts=fltp:channel_layouts=stereo
        [,adelay=delays=<leadPad>S:all=1]             入點早於音訊實際開始（串流起點或 pts 斷層裡）
        ,apad,atrim=end_sample=<L>                    精確長度
        [,asetnsamples=n=240:p=0,volume=eval=frame:volume='<運算式>']   有音量自動化才加
        ,afade=t=in…,afade=t=out…                     使用者淡化或 3 ms 防爆音淡化，取長的
        [,volume=volume=<片段＋軌道>dB]               0 dB 時省略
        ,adelay=delays=<delay>S:all=1[cN]
    [c1]…[cN]amix=inputs=N:duration=longest:dropout_transition=0:normalize=0,apad,atrim=end_sample=<S(T)>
        [,alimiter=…][,atrim=start_sample=…:end_sample=…,asetpts=PTS-STARTPTS][aout]

各項選擇的理由都在設計 §7.3（實測在 §7.5）：不數樣本、不用輸入端 -ss（Opus 晚 48 樣本）、`normalize=0`（預設每路除以路數）、
`asetnsamples p=0`（p=1 會把長度墊長）、單聲道明寫 pan（swr 的 center mix −3 dB 會讓整段變小聲）、限幅器兩個預設都要明寫。
golden：設計 §7.4 那張圖逐字相同（tests/test_audio_graph.py）。

本模組刻意多做、設計表沒寫死的地方（都有測試）：
- 音訊片段的 outUs = inUs + ceil(length·1e6/48000)：§7.4 表格多寫了「+1 個原生樣本」，但同一節逐字實跑過的圖沒有；
  golden 以實跑的圖為準。少那一個樣本只會讓鏈尾最多 1 個樣本變成 apad 的靜音，而那裡一定在防爆音淡出底下。
- leadPad 除了「入點早於串流起點」，入點落在 **pts 斷層裡**也算：atrim 之後第一個幀是斷層結束處，asetpts 會把它拉到 0，
  不補的話整段早「斷層剩下的長度」（和串流起點是同一類錯位）。
- 增益 ≤ −90 dB（SILENCE_DB）、自動化整條 ≤ −90 dB 的片段視為靜音，不開輸入；整條相同 dB 的自動化併進靜態增益。
- 自動化運算式超過 32 段改用平衡的 if 樹：ffmpeg 運算式解析器的巢狀上限約 90 層（n8.1.2 實測 90 可、100 不可）。
- 起點已在序列結尾之後的音訊片段不開輸入（輸出一定被 atrim 裁掉）。
- 沒有任何會發聲的片段 → `anullsrc` 產生剛好 S(T) 個樣本的靜音（輸出仍有音軌，長度不變式 I3 照樣成立）。
- > 32 個輸入（每個輸入一條 demux／decode 執行緒）→ 兩段式 stem：依軌分組、每組最多 32 路先各自渲成 48 kHz f32 WAV
  （只涵蓋該組實際佔用的時間段，1 小時序列切 200 刀時不會寫出 7 個 1 小時的檔），最後一張圖用 adelay 放回原位混音；
  stem 數量本身又超過 32 時再往上疊一層。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Callable, Iterable, Sequence

from ..ops import OpError
from ..project.schema import SILENCE_DB, AudioInfoV2, ClipGainV2, GapV2, SequenceV2, VideoClipV2
from ..sequence.model import audio_abs_us, duration_frames, place_video, round_half_up, samples_of_frame, total_samples, video_abs_us

if TYPE_CHECKING:
    from ..project.schema import ProjectFile

# 同時開啟的輸入上限：每個 -i 一條 demux／decode 執行緒（設計 §7.3「太多片段時的退路」）
MAX_INPUTS = 32
# 估計峰值超過這個就提示可能削波（§0.1 Q4：限幅器預設關，只提示）
PEAK_WARN_DBFS = -1.0
# level=0：不自動拉響度；latency=1：補償 attack 延遲，不破壞 A/V 對齊（兩個預設值都是坑，§7.3）
LIMITER = "alimiter=limit=0.891:attack=5:release=50:level=0:latency=1"
# volume eval=frame 每個音訊 frame 求一次值；切成 5 ms 一個 frame，Opus 20 ms 一個 frame 的拉鍊雜音就聽不出來
ENVELOPE_FRAME_SAMPLES = 240
# 自動化運算式在這個段數以內用線性巢狀（和設計 §7.4 的圖逐字相同），超過改平衡樹
LINEAR_NEST_MAX_REGIONS = 32
FADE_CURVE_FILTER = {"linear": "tri", "equalPower": "qsin"}

SourceKind = str  # "media" | "audio"
InfoOf = Callable[[SourceKind, str], "AudioInfoV2 | None"]
PathOf = Callable[[SourceKind, str], str]


# ---------------------------------------------------------------- 數字格式


def fmt_seconds_us(us: int) -> str:
    """整數 µs → `%.6f` 秒（atrim start/end）。由整數算，不經過浮點：ffmpeg 超過 6 位小數是截斷不是四捨五入（§14.3）。"""
    sign = "-" if us < 0 else ""
    a = abs(int(us))
    return f"{sign}{a // 1_000_000}.{a % 1_000_000:06d}"


def fmt_ratio(num: int, den: int, places: int = 6) -> str:
    """num/den 的最短十進位（最多 places 位、x.5 往 +∞），給運算式裡的秒數：420000/48000 → "8.75"。"""
    scale = 10**places
    q = round_half_up(num * scale, den)
    if q == 0:
        return "0"
    sign = "-" if q < 0 else ""
    q = abs(q)
    whole, frac = divmod(q, scale)
    s = f"{whole}.{frac:0{places}d}".rstrip("0").rstrip(".")
    return sign + s


def fmt_number(x: float, places: int = 6) -> str:
    """浮點 dB 的最短寫法：-10.0 → "-10"、-3.3333333 → "-3.333333"；-0 正規化成 0（避免 "volume=-0dB" 這種假差異）。"""
    s = f"{float(x):.{places}f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


# ---------------------------------------------------------------- 音量自動化運算式


def _lin(db: float) -> str:
    """hold／定值段：0 dB 寫 1、≤ −90 dB 寫 0（SILENCE_DB 視為 −∞，與 TS dbToLinear 同規則）。"""
    if db == 0:
        return "1"
    if db <= SILENCE_DB:
        return "0"
    return f"pow(10,{fmt_number(db)}/20)"


def _ramp(a0: int, d0: float, a1: int, d1: float, sr: int) -> str:
    """[a0, a1) 在 dB 域線性內插。從 0 dB 出發／回到 0 dB 的寫法與設計 §7.4 逐字相同（閃避斜坡最常見的兩種）。"""
    if d0 == d1:
        return _lin(d0)
    t0, t1, span = fmt_ratio(a0, sr), fmt_ratio(a1, sr), fmt_ratio(a1 - a0, sr)
    if d0 == 0:
        return f"pow(10,{fmt_number(d1)}*(t-{t0})/{span}/20)"
    if d1 == 0:
        return f"pow(10,{fmt_number(d0)}*({t1}-t)/{span}/20)"
    delta = d1 - d0
    op = "+" if delta >= 0 else "-"
    return f"pow(10,({fmt_number(d0)}{op}{fmt_number(abs(delta))}*(t-{t0})/{span})/20)"


def envelope_expr(env: Sequence[Any], sr: int) -> str:
    """自動化點（依 at 排序；at 是片段內序列樣本）→ volume 運算式，t = 片段內秒數。

    語意與 TS `src/sequence/envelope.ts` envelopeDbAt 相同：第一點之前 hold 第一點、最後一點之後 hold 最後一點、兩點之間 dB 域線性內插；
    同一個 at 的兩點是階梯（t 剛好落在上面時取後出現的那點 = 右側值）。零長度的段永遠不會被選到，直接略過。
    """
    pts = list(env)
    if not pts:
        return "1"
    uppers: list[int] = []  # 每個區段的上界（不含）
    exprs: list[str] = []
    uppers.append(pts[0].at)
    exprs.append(_lin(pts[0].db))
    for a, b in zip(pts, pts[1:]):
        if b.at <= a.at:
            continue
        uppers.append(b.at)
        exprs.append(_ramp(a.at, a.db, b.at, b.db, sr))
    exprs.append(_lin(pts[-1].db))  # 最後一點之後（沒有上界）
    linear = len(exprs) <= LINEAR_NEST_MAX_REGIONS

    def node(lo: int, hi: int) -> str:
        if lo == hi:
            return exprs[lo]
        # 線性：if(lt(t,u0), r0, if(lt(t,u1), r1, …))（設計 §7.4 逐字）；太多段時從中間切，巢狀深度 log2(n)
        mid = lo + 1 if linear else (lo + hi + 1) // 2
        return f"if(lt(t,{fmt_ratio(uppers[mid - 1], sr)}),{node(lo, mid - 1)},{node(mid, hi)})"

    return node(0, len(exprs) - 1)


def envelope_db_at(env: Sequence[Any], at: float) -> float:
    """參考實作（測試與峰值估計用）：與 envelope_expr 同語意，t 剛好在階梯上取右側值。"""
    pts = list(env)
    if not pts:
        return 0.0
    if at < pts[0].at:
        return float(pts[0].db)
    for a, b in zip(pts, pts[1:]):
        if a.at <= at < b.at:
            return float(a.db + (b.db - a.db) * (at - a.at) / (b.at - a.at))
    return float(pts[-1].db)


# ---------------------------------------------------------------- 資料結構


@dataclass(frozen=True)
class Chain:
    """一個會發聲的片段對應的輸入與鏈（輸入編號在組圖時才決定：一段式從 1 開始、stem 從 0 開始）。"""

    label: str  # c1…（V1 原音）／m1…（音軌片段）
    clip_id: str
    lane_id: str | None  # None = A0 原音
    source_type: str  # "media" | "audio"
    source_id: str
    path: str
    in_us: int
    out_us: int
    length: int  # L：序列樣本
    delay: int  # 序列樣本
    lead_pad: int  # 48 kHz 樣本
    channels: int
    gain_db: float  # 靜態增益（片段＋軌道或 A0 推桿＋定值自動化）
    env_max_db: float  # 自動化曲線最大值（峰值估計的上界；沒有運算式時 0）
    pre: str  # adelay 之前的整段鏈

    @property
    def end(self) -> int:
        return self.delay + self.length

    def body(self, delay: int | None = None) -> str:
        return f"{self.pre},adelay=delays={self.delay if delay is None else delay}S:all=1"

    def text(self, index: int, delay: int | None = None) -> str:
        return f"[{index}:a]{self.body(delay)}[{self.label}]"

    def to_json(self) -> dict[str, Any]:
        return {
            "label": self.label,
            "clipId": self.clip_id,
            "laneId": self.lane_id,
            "source": {"type": self.source_type, "id": self.source_id},
            "path": self.path,
            "inUs": self.in_us,
            "outUs": self.out_us,
            "length": self.length,
            "delay": self.delay,
            "leadPad": self.lead_pad,
            "channels": self.channels,
            "gainDb": self.gain_db,
        }


@dataclass(frozen=True)
class GraphInput:
    """ffmpeg `-i` 一個輸入（依順序）：來源檔（clip_id 有值）或 stem WAV（clip_id 為 None）。"""

    path: str
    chain_id: str
    clip_id: str | None

    def to_json(self) -> dict[str, Any]:
        return {"path": self.path, "chainId": self.chain_id, "clipId": self.clip_id}


@dataclass
class StemGraph:
    """兩段式的一張小圖：`ffmpeg -copyts <inputs> -/filter_complex <text> -map [aout] -c:a pcm_f32le -f wav <path>`。

    輸入編號從 0 開始（這一趟沒有 rawvideo 管線）。start／samples 是它在序列（或上一層 stem）時間軸上涵蓋的樣本範圍。"""

    id: str
    path: str
    inputs: list[GraphInput]
    text: str
    start: int
    samples: int

    def to_json(self) -> dict[str, Any]:
        return {"id": self.id, "path": self.path, "inputs": [i.to_json() for i in self.inputs], "start": self.start, "samples": self.samples, "graph": self.text}


@dataclass
class AudioGraph:
    inputs: list[GraphInput]  # 最後一張圖的 -i 依序（第一個的編號 = first_input）
    text: str  # 最後一張圖（輸出標籤 [aout]）
    total_samples: int  # 輸出樣本數（有 window 時 = S(T1) − S(T0)）
    sequence_samples: int  # S(T)
    window: tuple[int, int] | None
    chains: list[Chain]
    stems: list[StemGraph] = field(default_factory=list)  # 非空 = 兩段式：依序先跑完（後面的 stem 可能吃前面的輸出）
    notes: list[str] = field(default_factory=list)
    peak_estimate_dbfs: float | None = None
    limiter: bool = False
    first_input: int = 1

    @property
    def silent(self) -> bool:
        return not self.chains

    def to_json(self) -> dict[str, Any]:
        return {
            "inputs": [i.to_json() for i in self.inputs],
            "graph": self.text,
            "samples": self.total_samples,
            "sequenceSamples": self.sequence_samples,
            "window": None if self.window is None else list(self.window),
            "chains": [c.to_json() for c in self.chains],
            "stems": [s.to_json() for s in self.stems],
            "notes": list(self.notes),
            "peakEstimateDbfs": self.peak_estimate_dbfs,
            "limiter": self.limiter,
            "firstInput": self.first_input,
        }


# ---------------------------------------------------------------- 原因（encode_plan 的 dropped 用）


def mix_reasons(seq: SequenceV2, frames_of: Callable[[str], int | None]) -> list[str]:
    """為什麼不能 `-c:a copy`（設計 §7.1：原因列出分割、停用片段、增益或淡化、音訊片段數）。

    `is_untouched_with` 回 False 時呼叫；順序固定（UI 與 golden 依序顯示）。frames_of(mediaId) → proxy 幀數（未知 None）。"""
    reasons: list[str] = []
    clips = [it for it in seq.video if isinstance(it, VideoClipV2)]
    gaps = sum(1 for it in seq.video if isinstance(it, GapV2))

    def whole(c: VideoClipV2) -> bool | None:
        n = frames_of(c.media_id)
        return None if n is None else (c.src_in == 0 and c.src_out == n)

    if len(clips) > 1 or any(whole(c) is False for c in clips):
        reasons.append("分割 / 修剪過片段")
    elif any(whole(c) is None for c in clips):
        reasons.append("媒體幀數未知（無法確認片段是整段）")
    if not clips and not gaps:
        reasons.append("序列是空的")
    if gaps:
        reasons.append(f"{gaps} 段空白")
    disabled = sum(1 for c in clips if not c.enabled)
    if disabled:
        reasons.append(f"停用 {disabled} 個片段")
    if any(not c.audio.is_neutral for c in clips):
        reasons.append("片段增益或淡化")
    if any(not c.audio.enabled for c in clips):
        reasons.append("原音靜音或已分離")
    if seq.original_muted or seq.original_gain_db != 0:
        reasons.append("原音軌靜音或推桿")
    n_audio = sum(len(lane.clips) for lane in seq.audio_lanes)
    if n_audio:
        reasons.append(f"加入 {n_audio} 段音訊")
    return reasons or ["序列已修改"]


# ---------------------------------------------------------------- 建圖


def _declick_samples(seq: SequenceV2) -> int:
    """D = round(edgeDeclickMs · sr / 1000)；3 ms × 48 kHz = 144。"""
    return max(0, math.floor(float(seq.edge_declick_ms) * seq.sample_rate / 1000 + 0.5))


def _fade(user: int, declick: int, length: int, curve: str) -> tuple[int, str] | None:
    """淡化長度取 max(使用者, 防爆音)，夾在片段長度內；使用者的淡化 ≥ 防爆音時用片段的曲線，否則是防爆音的 tri（§7.4 c2 淡入 tri、淡出 qsin）。"""
    ns = min(max(int(user), declick), length)
    if ns <= 0:
        return None
    use_user = user > 0 and user >= declick
    return ns, (FADE_CURVE_FILTER.get(curve, "tri") if use_user else "tri")


def _lead_pad_us(info: AudioInfoV2, in_us: int) -> int:
    """入點之前「還沒有聲音」的長度（µs）：早於串流起點，或落在 pts 斷層裡（斷層 = (atUs, durUs)，聲音在 at+dur 恢復）。"""
    pad = info.start_us - in_us
    for at, dur in info.gaps:
        if at <= in_us < at + dur:
            pad = max(pad, at + dur - in_us)
    return max(0, pad)


@dataclass
class _Built:
    chain: Chain | None
    note: str | None = None


def _chain(
    *,
    label: str,
    clip_id: str,
    lane_id: str | None,
    source_type: str,
    source_id: str,
    path: str,
    info: AudioInfoV2,
    in_us: int,
    out_us: int,
    length: int,
    delay: int,
    gain: ClipGainV2,
    bus_db: float,
    sr: int,
    declick: int,
) -> _Built:
    env = list(gain.envelope)
    env_const = 0.0
    expr: str | None = None
    env_max = 0.0
    if env:
        dbs = [float(p.db) for p in env]
        if max(dbs) <= SILENCE_DB:
            return _Built(None, f"片段 {clip_id} 的音量自動化整條 ≤ {SILENCE_DB:g} dB：視為靜音，不輸入")
        if all(d == dbs[0] for d in dbs):
            env_const = dbs[0]  # 整條同一個 dB = 靜態增益，不必每 5 ms 求一次運算式
        else:
            expr = envelope_expr(env, sr)
            env_max = max(dbs)
    if gain.gain_db <= SILENCE_DB:
        return _Built(None, f"片段 {clip_id} 增益 ≤ {SILENCE_DB:g} dB：視為靜音，不輸入")
    lead_pad = round_half_up(_lead_pad_us(info, in_us) * sr, 1_000_000)
    parts = [
        f"atrim=start={fmt_seconds_us(in_us)}:end={fmt_seconds_us(out_us)}",
        "asetpts=PTS-STARTPTS",
        f"aresample={sr}:async=1:min_hard_comp=0.020:first_pts=0",
    ]
    if info.channels == 1:
        parts.append("pan=stereo|c0=c0|c1=c0")
    parts.append("aformat=sample_fmts=fltp:channel_layouts=stereo")
    if lead_pad > 0:
        parts.append(f"adelay=delays={lead_pad}S:all=1")
    parts += ["apad", f"atrim=end_sample={length}"]
    if expr is not None:
        parts += [f"asetnsamples=n={ENVELOPE_FRAME_SAMPLES}:p=0", f"volume=eval=frame:volume='{expr}'"]
    fin = _fade(gain.fade_in, declick, length, gain.fade_curve)
    if fin is not None:
        parts.append(f"afade=t=in:ss=0:ns={fin[0]}:curve={fin[1]}")
    fout = _fade(gain.fade_out, declick, length, gain.fade_curve)
    if fout is not None:
        parts.append(f"afade=t=out:ss={length - fout[0]}:ns={fout[0]}:curve={fout[1]}")
    static_db = float(gain.gain_db) + float(bus_db) + env_const
    db_text = fmt_number(static_db, 4)
    if db_text != "0":
        parts.append(f"volume=volume={db_text}dB")
    return _Built(
        Chain(
            label=label, clip_id=clip_id, lane_id=lane_id, source_type=source_type, source_id=source_id, path=path,
            in_us=in_us, out_us=out_us, length=length, delay=delay, lead_pad=lead_pad, channels=int(info.channels),
            gain_db=static_db, env_max_db=env_max, pre=",".join(parts),
        )
    )


def _defaults(project: "ProjectFile | None", info_of: InfoOf | None, path_of: PathOf | None) -> tuple[InfoOf, PathOf]:
    def lookup(kind: str, ref_id: str) -> Any:
        if project is None:
            raise OpError("Internal", "audio_graph.build 沒有 project，必須給 info_of／path_of")
        m = project.media_by_id(ref_id) if kind == "media" else project.audio_media_by_id(ref_id)
        if m is None:
            raise OpError("Invalid", f"序列引用的{'媒體' if kind == 'media' else '音訊'} {ref_id!r} 不在專案裡")
        return m

    return (info_of or (lambda k, i: lookup(k, i).audio)), (path_of or (lambda k, i: lookup(k, i).path))


def _mix_line(labels: Iterable[str], total: int, *, limiter: bool, window: tuple[int, int] | None) -> str:
    labels = list(labels)
    s = "".join(f"[{x}]" for x in labels) + f"amix=inputs={len(labels)}:duration=longest:dropout_transition=0:normalize=0,apad,atrim=end_sample={total}"
    if limiter:
        s += "," + LIMITER  # 限幅器看整條混音（範圍輸出也一樣），裁範圍放在它之後
    if window is not None:
        s += f",atrim=start_sample={window[0]}:end_sample={window[1]},asetpts=PTS-STARTPTS"
    return s + "[aout]"


def _join(lines: list[str]) -> str:
    return ";\n".join(lines) + "\n"


def _chunks(items: list[Any], n: int) -> list[list[Any]]:
    return [items[i : i + n] for i in range(0, len(items), n)]


def _stem_path(stem_dir: str, name: str) -> str:
    sep = "\\" if ("\\" in stem_dir and "/" not in stem_dir) else "/"
    return f"{stem_dir.rstrip(chr(92) + '/')}{sep}{name}"


@dataclass(frozen=True)
class _Node:
    """最後一張圖（或上一層 stem）的一個輸入：一個 stem WAV 與它在時間軸上的起點。"""

    path: str
    start: int
    samples: int


def _plan_stems(chains: list[Chain], total: int, max_inputs: int, stem_dir: str) -> tuple[list[StemGraph], list[_Node]]:
    """依軌分組（A0 一組、每條音軌一組，時間上天然不重疊）→ 每組每 max_inputs 路一個 stem；stem 數還是太多就再疊一層。"""
    groups: dict[str | None, list[Chain]] = {}
    for c in chains:
        groups.setdefault(c.lane_id, []).append(c)
    stems: list[StemGraph] = []
    nodes: list[_Node] = []
    for group in groups.values():
        for part in _chunks(group, max_inputs):
            start = min(c.delay for c in part)
            end = min(max(c.end for c in part), total)  # 超出序列結尾的部分最後一定被裁掉，不寫進 stem
            sid = f"stem-{len(stems) + 1}"
            path = _stem_path(stem_dir, f"{sid}.wav")
            lines = [c.text(i, c.delay - start) for i, c in enumerate(part)]
            lines.append(_mix_line((c.label for c in part), end - start, limiter=False, window=None))
            stems.append(StemGraph(sid, path, [GraphInput(c.path, c.label, c.clip_id) for c in part], _join(lines), start, end - start))
            nodes.append(_Node(path, start, end - start))
    while len(nodes) > max_inputs:
        upper: list[_Node] = []
        for part in _chunks(nodes, max_inputs):
            start = min(n.start for n in part)
            end = max(n.start + n.samples for n in part)
            sid = f"stem-{len(stems) + 1}"
            path = _stem_path(stem_dir, f"{sid}.wav")
            lines = [f"[{i}:a]adelay=delays={n.start - start}S:all=1[s{i + 1}]" for i, n in enumerate(part)]
            lines.append(_mix_line((f"s{i + 1}" for i in range(len(part))), end - start, limiter=False, window=None))
            stems.append(StemGraph(sid, path, [GraphInput(n.path, f"s{i + 1}", None) for i, n in enumerate(part)], _join(lines), start, end - start))
            upper.append(_Node(path, start, end - start))
        nodes = upper
    return stems, nodes


def estimate_peak_dbfs(chains: Sequence[Chain], peak_of: Callable[[Chain], float | None] | None) -> float | None:
    """保守的峰值上界（設計 §7.6）：每路 = 來源在 [inUs, outUs) 的峰值 + 靜態增益 + 自動化最大值（淡化 ≤ 1 不計），
    同一時間在響的各路振幅直接相加。任何一路的來源峰值未知（peaks.v1.bin 還沒算）→ None，不瞎猜。"""
    if peak_of is None or not chains:
        return None
    spans: list[tuple[int, int, float]] = []
    for c in chains:
        p = peak_of(c)
        if p is None:
            return None
        spans.append((c.delay, c.end, 10 ** ((float(p) + c.gain_db + c.env_max_db) / 20)))
    best = max(sum(a for s, e, a in spans if s <= s0 < e) for s0, _, _ in spans)
    return round(20 * math.log10(best), 2) if best > 0 else None


def build(
    seq: SequenceV2,
    project: "ProjectFile | None" = None,
    window: tuple[int, int] | None = None,
    *,
    info_of: InfoOf | None = None,
    path_of: PathOf | None = None,
    peak_of: Callable[[Chain], float | None] | None = None,
    first_input: int = 1,
    max_inputs: int = MAX_INPUTS,
    stem_dir: str = "stems",
) -> AudioGraph:
    """序列 → 音訊濾鏡圖（設計 §7.6 `build(seq, project, window)`）。

    - window：範圍輸出 `--range T0:T1 --trim` 的序列幀 [T0, T1)；先建整條混音，最後裁（§7.3）。
    - info_of(kind, id)：來源的 AudioInfoV2；None = 這個來源沒有音軌（片段略過並記 note）。預設讀 project 裡的 `audio`。
    - path_of(kind, id)：來源檔路徑。預設 project 裡的 `path`（呼叫端負責解析相對路徑）。
    - peak_of(chain)：來源在鏈的時間窗內的峰值 dBFS（M2.8 的 peaks.v1.bin）；None → peak_estimate_dbfs 為 None。
    - first_input：第一個音訊輸入的 -i 編號（渲染時 0 號是 rawvideo 管線，所以預設 1）。
    """
    sr = int(seq.sample_rate)
    frames = duration_frames(seq)
    seq_samples = total_samples(seq)
    if window is not None:
        t0, t1 = int(window[0]), int(window[1])
        if not (0 <= t0 < t1 <= frames):
            raise OpError("Invalid", f"範圍 [{t0}, {t1}) 超出序列 [0, {frames}) 或為空")
        out_window: tuple[int, int] | None = (samples_of_frame(t0, seq.fps, sr), samples_of_frame(t1, seq.fps, sr))
    else:
        out_window = None
    get_info, get_path = _defaults(project, info_of, path_of)
    declick = _declick_samples(seq)
    notes: list[str] = []
    chains: list[Chain] = []

    def note(msg: str) -> None:
        if msg not in notes:
            notes.append(msg)

    def info_or_note(kind: str, ref_id: str, clip_id: str) -> AudioInfoV2 | None:
        info = get_info(kind, ref_id)
        if info is None:
            note(f"{'媒體' if kind == 'media' else '音訊'} {ref_id} 沒有音軌：片段 {clip_id} 不發聲")
        elif info.channels > 2:
            note(f"{'媒體' if kind == 'media' else '音訊'} {ref_id} 是 {info.channels} 聲道：以 ITU 係數降混成立體聲")
        return info

    # ---- A0：V1 片段自帶的原音 ----
    n_a0 = 0
    if not seq.original_muted and seq.original_gain_db > SILENCE_DB:
        for p in place_video(seq):
            it = p.item
            if not isinstance(it, VideoClipV2) or not it.enabled or not it.audio.enabled or p.samples <= 0:
                continue
            info = info_or_note("media", it.media_id, it.id)
            if info is None:
                continue
            vs = info.video_start_us
            if vs is None:
                note(f"媒體 {it.media_id} 沒有影片起點（videoStartUs）：以音訊起點 {info.start_us} µs 對齊")
                vs = info.start_us
            built = _chain(
                label=f"c{n_a0 + 1}", clip_id=it.id, lane_id=None,
                source_type="media", source_id=it.media_id, path=get_path("media", it.media_id), info=info,
                in_us=video_abs_us(it.src_in, seq.fps, vs), out_us=video_abs_us(it.src_out, seq.fps, vs),
                length=p.samples, delay=p.s0, gain=it.audio, bus_db=seq.original_gain_db, sr=sr, declick=declick,
            )
            if built.note:
                note(built.note)
            if built.chain is not None:
                chains.append(built.chain)
                n_a0 += 1
    elif seq.video:
        note("A0 原音軌已靜音：V1 片段的原音不輸出")

    # ---- A1…An：音訊片段 ----
    n_lane_chains = 0
    for lane in seq.audio_lanes:
        if lane.muted or lane.gain_db <= SILENCE_DB:
            if lane.clips:
                note(f"音軌 {lane.name or lane.id} 已靜音：{len(lane.clips)} 段不輸出")
            continue
        for c in lane.clips:
            if not c.enabled or c.source is None or c.length < 1:
                continue
            if c.start >= seq_samples:
                note(f"音訊片段 {c.id} 在序列結尾之後：不輸出")
                continue
            info = info_or_note(c.source.type, c.source.ref_id, c.id)
            if info is None:
                continue
            in_us = audio_abs_us(c.src_in, info.start_us, info.sample_rate)
            built = _chain(
                label=f"m{n_lane_chains + 1}", clip_id=c.id, lane_id=lane.id, source_type=c.source.type, source_id=c.source.ref_id,
                path=get_path(c.source.type, c.source.ref_id), info=info,
                in_us=in_us, out_us=in_us + -(-c.length * 1_000_000 // sr),
                length=c.length, delay=c.start, gain=c, bus_db=lane.gain_db, sr=sr, declick=declick,
            )
            if built.note:
                note(built.note)
            if built.chain is not None:
                chains.append(built.chain)
                n_lane_chains += 1

    out_samples = seq_samples if out_window is None else out_window[1] - out_window[0]
    peak = estimate_peak_dbfs(chains, peak_of)
    if peak is not None and peak > PEAK_WARN_DBFS and not seq.limiter:
        note(f"可能削波（估計峰值 {peak:+.1f} dBFS）：建議降低音樂增益或開啟限幅器")

    if not chains:
        # 沒有任何會發聲的片段：仍輸出剛好 S(T) 個樣本的靜音音軌（長度與有聲音時一致）
        text = _join([f"anullsrc=r={sr}:cl=stereo,atrim=end_sample={out_samples}[aout]"])
        return AudioGraph([], text, out_samples, seq_samples, out_window, [], [], notes, None, bool(seq.limiter), first_input)

    if len(chains) <= max_inputs:
        lines = [c.text(first_input + i) for i, c in enumerate(chains)]
        lines.append(_mix_line((c.label for c in chains), seq_samples, limiter=bool(seq.limiter), window=out_window))
        inputs = [GraphInput(c.path, c.label, c.clip_id) for c in chains]
        return AudioGraph(inputs, _join(lines), out_samples, seq_samples, out_window, chains, [], notes, peak, bool(seq.limiter), first_input)

    stems, nodes = _plan_stems(chains, seq_samples, max_inputs, stem_dir)
    note(f"{len(chains)} 路輸入超過 {max_inputs}：先渲成 {len(stems)} 個 stem 再混音")
    lines = [f"[{first_input + i}:a]adelay=delays={n.start}S:all=1[s{i + 1}]" for i, n in enumerate(nodes)]
    lines.append(_mix_line((f"s{i + 1}" for i in range(len(nodes))), seq_samples, limiter=bool(seq.limiter), window=out_window))
    inputs = [GraphInput(n.path, f"s{i + 1}", None) for i, n in enumerate(nodes)]
    return AudioGraph(inputs, _join(lines), out_samples, seq_samples, out_window, chains, stems, notes, peak, bool(seq.limiter), first_input)


__all__ = [
    "MAX_INPUTS",
    "PEAK_WARN_DBFS",
    "LIMITER",
    "ENVELOPE_FRAME_SAMPLES",
    "AudioGraph",
    "Chain",
    "GraphInput",
    "StemGraph",
    "build",
    "envelope_db_at",
    "envelope_expr",
    "estimate_peak_dbfs",
    "fmt_number",
    "fmt_ratio",
    "fmt_seconds_us",
    "mix_reasons",
]
