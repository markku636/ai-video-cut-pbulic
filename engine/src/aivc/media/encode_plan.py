"""編碼計畫 `plan(spec, source, encoders)`：純函式、只有 Python 這一份（計畫 §6.7；TS 只顯示 `render.plan --dry-run`）。

規則：
- 容器：spec.container → 輸出副檔名 → 來源容器。webm 預設 libvpx-vp9 `-crf 16 -b:v 0 -row-mt 1`（2026-09-17 量測：範例未合成段 10 s，crf 24→16 平均 PSNR 46.6→48.1 dB、720→1240 kbps、編碼時間 7→8 s；見 plugins/cards/docs/measurements.md）；
  mp4 預設 hevc_nvenc `-preset p6 -tune hq -rc vbr -cq 19` → H.264 階梯（見下）；
  mov 預設 prores_ks（profile 3 HQ、yuv422p10le）；mkv 預設 ffv1（無損中間檔）。
- H.264 階梯 `H264_CHAIN`：h264_nvenc → libopenh264 → h264_videotoolbox → libx264 → mpeg4。
  為什麼是這個順序：Windows 內建的是 LGPL ffmpeg（有 NVENC 與 libopenh264、刻意沒有 GPL 的 libx264），行為維持不變；
  macOS／Linux 用的是使用者自己裝的 ffmpeg（Homebrew、發行版套件），**兩者都沒有 libopenh264**，以前整條鏈在那裡直接失敗
  （proxy 與 mp4 匯出全掛）。Mac 先用 VideoToolbox 硬體編碼（快、省電），再退 libx264（使用者自備的 ffmpeg 帶 GPL 編碼器沒有授權問題），
  最後才是 ffmpeg 內建、任何 build 都有的 mpeg4（MPEG-4 Part 2，畫質／相容性差，選到時一定記進 dropped 讓使用者看到）。
  `codec="h264"` 是別名：只走這條階梯（proxy 用；proxy 要 H.264，不要 mp4 預設的 HEVC）。
- 硬體編碼器（NVENC、VideoToolbox）只在 `encoders` 裡（呼叫端負責試編過濾過，見 `probe_chain`；有列 ≠ 能用）且 spec.gpu 才選；
  點名要硬體編碼器但不可用 → 沿 H.264 階梯找下一個 + notes。選擇只取決於 `encoders` 這個集合，所以同一份清單永遠得到同一個結果。
- 音訊：來源 codec 在容器的「可直接複製」表 → `-c:a copy`；否則重新編碼（webm→libopus、其他→aac 160k）並
  `dropped += ["音軌重新編碼（…）"]`（mp4+opus 就是這種）。webm 不能裝 aac，所以 webm 的 fallback 是 libopus（計畫寫 aac，此處修正）。
- 序列混音（設計 docs/editor-m2-design.md §7.1、M2.6）：`plan(..., mix_reasons=[…])` 或 `EncodeSpec.audio="mix"` →
  `audio_mode="mix"`：webm → libopus 160k、mp4／mov → aac 160k、mkv → flac（無損中間檔不該在音訊上破例有損），
  `dropped += ["音軌重新混音（原因：…）"]`。為什麼原因走參數、不放進 EncodeSpec：EncodeSpec 會原樣寫進 export-plan golden，
  多一個欄位就讓 19 個 v1 案例全部改寫（不變式 I4 要求 v1 零回歸）。`--audio copy`（exportDefaults 預設）在要混音時
  視同 auto 並記 note，不擲錯：使用者沒辦法在不剪輯的前提下滿足它；`--audio none` 仍然不輸出音軌。
- 未知 codec／容器不接受的 codec → OpError(Invalid)，絕不默默換成別的。
- 色彩 tag：range 跟來源（source.color_range：pc 就標 pc，其餘 tv）；矩陣依 source.matrix_assumed（bt709 → bt709 三件；bt601 → smpte170m 三件）。
  為什麼不能一律 tv：rawvideo 管線送進去的是來源原封不動的平面（yuvj420p／pc 不做轉換），標成 tv 會讓**每一幀**（連沒合成的像素）
  都被播放器用錯 range 顯示（黑色被抬、白色被削）。ffmpeg 8.1 實測：輸入輸出都標 pc 時 ffv1／libvpx-vp9／libopenh264／hevc_nvenc
  都零轉換、輸出標 pc；ProRes 位元流沒有 range 旗標（輸出仍標 tv），所以 pc 來源選 prores_ks 時記進 dropped。
- 內容揭露中繼資料（容器層 `-metadata`，預設開）：每支渲染輸出都標明「這是改過／合成的影片」——`comment`、`description`、`title`
  三個 tag 寫同一句話（mp4 →©cmt／desc／©nam；matroska／webm → COMMENT／DESCRIPTION／TITLE）。
  為什麼放在編碼計畫而不是 render：plan() 是唯一一份產生 ffmpeg 參數的地方（App 與 CLI 共用），放這裡就不會有「某條路徑忘了標」；
  預設句子是通用的「已編輯：內容由 AI Video Cut <版本> 修改」；外掛可登記更具體的預設（hooks content-note，最後登記的生效），
  專案／profile 也可以換成自己的句子（`spec.content_note`）。`{version}` 由 `spec.tool_version`（None ＝ 引擎版本）代入。
  proxy（內部快取、不給人看）以 `content_note=""` 關掉。
golden：tests/fixtures/media/export-plan.golden.json。
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Collection, Iterable, Sequence

from ..ops import OpError

_ALL = "*"

# H.264 fallback 階梯（順序＝優先序；理由見模組說明）。mp4 預設階梯＝hevc_nvenc + 這一串。
H264_ALIAS = "h264"
H264_CHAIN: tuple[str, ...] = ("h264_nvenc", "libopenh264", "h264_videotoolbox", "libx264", "mpeg4")

CONTAINERS: dict[str, dict[str, Any]] = {
    "webm": {
        "format": "webm",
        "ext": ".webm",
        "video": {"libvpx-vp9", "libaom-av1", "av1_nvenc"},
        "audio_copy": {"opus", "vorbis"},
        "audio_encode": ("libopus", ["-b:a", "160k"]),
        "default": ["libvpx-vp9"],
    },
    "mp4": {
        "format": "mp4",
        "ext": ".mp4",
        "video": {"hevc_nvenc", "av1_nvenc", *H264_CHAIN},
        "audio_copy": {"aac", "mp3", "ac3", "eac3", "alac"},
        "audio_encode": ("aac", ["-b:a", "160k"]),
        "default": ["hevc_nvenc", *H264_CHAIN],
    },
    "mov": {
        "format": "mov",
        "ext": ".mov",
        "video": {"prores_ks", "hevc_nvenc", *H264_CHAIN},
        "audio_copy": {"aac", "mp3", "ac3", "eac3", "alac", "pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_s16be", "pcm_s24be"},
        "audio_encode": ("aac", ["-b:a", "160k"]),
        "default": ["prores_ks"],
    },
    "mkv": {
        "format": "matroska",
        "ext": ".mkv",
        "video": _ALL,
        "audio_copy": _ALL,
        "audio_encode": ("aac", ["-b:a", "160k"]),
        # 序列混音（§7.1）：mkv 是無損中間檔（ffv1），混出來的聲音也用無損的 flac
        "audio_mix": ("flac", []),
        "default": ["ffv1"],
    },
}

# 音訊編碼器不在這份 ffmpeg 時的替代（例如沒有 libopus 就退到內建 opus）
_AUDIO_ALT = {"libopus": "opus", "aac": "aac_mf"}
MIX_DROPPED = "音軌重新混音"
MIX_COPY_NOTE = "序列已剪輯或加入音訊，無法直接複製音軌（音訊設定為 copy）→ 重新混音"
MIX_NONE_NOTE = "音訊設定為 none：序列的音訊不輸出"

_NVENC = {"hevc_nvenc", "h264_nvenc", "av1_nvenc"}
# 硬體編碼器：驅動／GPU／虛擬機決定開不開得了 session，「ffmpeg -encoders 有列」不代表能用 → 呼叫端必須試編過濾；
# spec.gpu=False（確定性輸出、CI）時一律不選。
HARDWARE_ENCODERS: frozenset[str] = frozenset(_NVENC | {"h264_videotoolbox"})
# 只吃位元率的編碼器（沒有 crf／cq）：quality 參數對它們無效，proxy 要另外給 -b:v。
BITRATE_CODECS: frozenset[str] = frozenset({"libopenh264", "h264_videotoolbox", "mpeg4"})
# GPL 編碼器：Windows 內建的 LGPL ffmpeg 刻意不含；只有使用者自備的 ffmpeg（Homebrew／發行版）才有。
_GPL = {"libx264"}
_DETERMINISTIC = {"libvpx-vp9", "libopenh264", "prores_ks", "ffv1", "libaom-av1"}
_DEFAULT_Q = {"libvpx-vp9": 16, "hevc_nvenc": 19, "h264_nvenc": 19, "av1_nvenc": 24, "libaom-av1": 30, "libx264": 18}
_KNOWN = set(_DEFAULT_Q) | {"libopenh264", "prores_ks", "ffv1", "h264_videotoolbox", "mpeg4"}
_KNOWN_HINT = "可用：libvpx-vp9 hevc_nvenc h264_nvenc libopenh264 h264_videotoolbox libx264 mpeg4 prores_ks ffv1（h264 = 自動走 H.264 階梯）"
# mpeg4 是最後手段：任何 ffmpeg 都有，但畫質／壓縮率差一截、部分播放器不支援 → 使用者一定要看到
MPEG4_DROPPED = (
    "H.264 編碼器都不可用 → 退到 mpeg4（MPEG-4 Part 2）：畫質與壓縮率明顯較差，部分播放器不支援；"
    "請改用含 libx264 或 libopenh264 的 ffmpeg（macOS：brew install ffmpeg；Linux：發行版的 ffmpeg 套件）"
)
_COLOR_TAGS = {
    "bt709": ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709"],
    "bt601": ["-colorspace", "smpte170m", "-color_primaries", "smpte170m", "-color_trc", "smpte170m"],
}
_NO_RANGE_FLAG = {"prores_ks"}  # 位元流沒有 full-range 旗標的編碼器


# 內容揭露：核心的預設句子（通用）。{version} 在 plan() 代入。外掛可以換掉預設（default_content_note）。
DEFAULT_CONTENT_NOTE = "Edited video. Content altered by AI Video Cut {version}."
METADATA_KEYS: tuple[str, ...] = ("comment", "description", "title")


def default_content_note() -> str:
    """沒指定句子時用的預設：外掛登記的（hooks content-note）優先，否則核心的通用句子。"""
    from .. import hooks

    return hooks.content_note() or DEFAULT_CONTENT_NOTE


def metadata_args(note: str | None, version: str) -> list[str]:
    """內容揭露句子 → `-metadata key=value` 參數串（comment/description/title 同一句）。note 為空字串 → []（proxy 用）。

    為什麼三個 tag 都寫：播放器與平台各讀不同欄位（QuickTime 讀 ©nam／©cmt、Windows 檔案內容讀 title／comment、
    ffprobe／MediaInfo 看 description），只寫一個很容易在轉存或上傳時被看不到。"""
    if note is None:
        note = default_content_note()
    text = str(note).replace("{version}", str(version)).strip()
    if not text:
        return []
    out: list[str] = []
    for key in METADATA_KEYS:
        out += ["-metadata", f"{key}={text}"]
    return out


def _engine_version() -> str:
    from .._version import __version__

    return str(__version__)


def color_args(matrix_assumed: str, color_range: str | None) -> list[str]:
    """`-color_range` 跟來源（pc → pc，其他／未知 → tv）＋矩陣三件（未知矩陣退 bt709，與舊行為相同）。"""
    rng = "pc" if color_range == "pc" else "tv"
    return ["-color_range", rng, *_COLOR_TAGS.get(matrix_assumed, _COLOR_TAGS["bt709"])]


@dataclass(frozen=True)
class SourceInfo:
    """plan() 需要知道的來源事實（從 Probe 抽出來，讓 plan 可以用 fixture 測、不碰檔案）。"""

    container: str  # "webm" | "mp4" | "mov" | "mkv" | 其他小寫副檔名
    width: int
    height: int
    fps_num: int
    fps_den: int
    has_audio: bool
    audio_codec: str | None
    matrix_assumed: str = "bt709"
    color_range: str = "tv"  # "tv" | "pc"（probe.range_or_default：沒標就是 tv）

    @classmethod
    def from_probe(cls, p: Any) -> "SourceInfo":
        # getattr：呼叫端（與測試）可能給只有部分欄位的 probe-like 物件；沒有 range 資訊就維持舊的 tv
        rng = getattr(p, "range_or_default", None) or getattr(p, "color_range", None) or "tv"
        return cls(
            container=container_of(p.path, p.container),
            width=int(p.width),
            height=int(p.height),
            fps_num=int(p.fps_num),
            fps_den=int(p.fps_den),
            has_audio=bool(p.has_audio),
            audio_codec=p.audio_codec,
            matrix_assumed=p.matrix_assumed,
            color_range="pc" if rng == "pc" else "tv",
        )


@dataclass(frozen=True)
class EncodeSpec:
    container: str | None = None  # None → 依 out_path 副檔名 → 來源容器
    codec: str | None = None  # None → 容器預設階梯
    quality: int | None = None  # codec 原生的 crf / cq；None → 預設
    audio: str = "auto"  # auto | copy | encode | mix | none（mix：序列重新混音，§7.1）
    gpu: bool = True  # False → 絕不選 NVENC（CI／確定性）
    out_path: str | None = None
    content_note: str | None = None  # 內容揭露句子；None → default_content_note()，"" → 不寫（proxy）
    tool_version: str | None = None  # 代入 {version}；None → 引擎版本（golden 測試釘固定字串，免得每次發版改 golden）


@dataclass
class EncodePlan:
    container: str
    format: str  # ffmpeg -f
    ext: str
    video_codec: str
    video_args: list[str]
    audio_mode: str  # copy | encode | mix | none（mix：輸入與 -map 由音訊濾鏡圖決定，audio_args 只有編碼器）
    audio_codec: str | None
    audio_args: list[str]
    color_args: list[str]
    input_pix_fmt: str = "yuv420p"
    gpu: bool = False
    deterministic: bool = True
    dropped: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    metadata_args: list[str] = field(default_factory=list)  # 容器層內容揭露（`-metadata comment=…` 等），見模組說明

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


def container_of(path: str | None, format_name: str | None = None) -> str:
    """副檔名優先（.webm 與 .mkv 的 ffmpeg format_name 都是 matroska,webm）。"""
    if path:
        ext = path.rsplit(".", 1)[-1].lower() if "." in path.replace("\\", "/").split("/")[-1] else ""
        if ext in ("webm", "mp4", "mov", "mkv"):
            return ext
        if ext in ("m4v",):
            return "mp4"
        if ext:
            return ext
    if format_name:
        names = format_name.split(",")
        # ffmpeg 對 .mkv 與 .webm 都回 "matroska,webm"，沒有副檔名時分不出來 → 選 mkv（超集，什麼 codec 都裝得下）
        if "matroska" in names:
            return "mkv"
        if "webm" in names:
            return "webm"
        if "mp4" in names or "mov" in names:
            return "mp4"
    return "mp4"


def video_bitrate_kbps(width: int, height: int, fps_num: int, fps_den: int, bpp: float = 0.15) -> int:
    """位元率制編碼器（libopenh264）的目標：bits-per-pixel × 像素 × fps，夾在 1.5–40 Mbps。"""
    fps = fps_num / max(fps_den, 1)
    return int(min(40000, max(1500, width * height * fps * bpp / 1000)))


def _video_args(codec: str, quality: int | None, src: SourceInfo) -> list[str]:
    q = quality if quality is not None else _DEFAULT_Q.get(codec)
    if codec == "libvpx-vp9":
        return ["-crf", str(q), "-b:v", "0", "-row-mt", "1", "-pix_fmt", "yuv420p"]
    if codec == "hevc_nvenc":
        return ["-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", str(q), "-b:v", "0", "-pix_fmt", "yuv420p", "-tag:v", "hvc1"]
    if codec == "h264_nvenc":
        return ["-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", str(q), "-b:v", "0", "-pix_fmt", "yuv420p"]
    if codec == "av1_nvenc":
        return ["-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", str(q), "-b:v", "0", "-pix_fmt", "yuv420p"]
    if codec == "libopenh264":
        return ["-b:v", f"{video_bitrate_kbps(src.width, src.height, src.fps_num, src.fps_den)}k", "-pix_fmt", "yuv420p"]
    if codec == "h264_videotoolbox":
        # -q:v（固定品質）只有 Apple Silicon 支援，位元率在每台 Mac 都能用；
        # -allow_sw 1：沒有硬體 session（虛擬機、CI runner）時讓 VideoToolbox 用 Apple 的軟體 H.264，而不是整段失敗
        return ["-b:v", f"{video_bitrate_kbps(src.width, src.height, src.fps_num, src.fps_den)}k", "-allow_sw", "1", "-pix_fmt", "yuv420p"]
    if codec == "libx264":
        return ["-preset", "medium", "-crf", str(q), "-pix_fmt", "yuv420p"]
    if codec == "mpeg4":
        # MPEG-4 Part 2 同位元率下比 H.264 糊得多：bpp 加倍（0.3）撐住畫質；它只是最後手段，檔案大一點可以接受
        return ["-b:v", f"{video_bitrate_kbps(src.width, src.height, src.fps_num, src.fps_den, bpp=0.3)}k", "-pix_fmt", "yuv420p"]
    if codec == "prores_ks":
        return ["-profile:v", "3", "-vendor", "apl0", "-pix_fmt", "yuv422p10le"]
    if codec == "ffv1":
        return ["-level", "3", "-coder", "1", "-context", "1", "-g", "1", "-slices", "4", "-slicecrc", "1", "-pix_fmt", "yuv420p"]
    if codec == "libaom-av1":
        return ["-crf", str(q), "-b:v", "0", "-cpu-used", "4", "-row-mt", "1", "-pix_fmt", "yuv420p"]
    raise OpError("Invalid", f"未知的視訊編碼器 {codec!r}", hint=_KNOWN_HINT)


def pick_encoder(candidates: Iterable[str], encoders: Collection[str], *, gpu: bool = True) -> tuple[str | None, list[str]]:
    """依序回第一個可用的候選，以及前面被跳過的候選（寫進 notes 用）。純函式：只看 `encoders` 集合與 gpu 旗標。"""
    skipped: list[str] = []
    for c in candidates:
        if c in HARDWARE_ENCODERS and not gpu:
            skipped.append(f"{c}（未啟用 GPU）")
            continue
        if c in encoders:
            return c, skipped
        skipped.append(c)
    return None, skipped


def probe_chain(
    listed: Collection[str],
    usable: Callable[[str], bool],
    chain: Iterable[str] = H264_CHAIN,
    *,
    gpu: bool = True,
) -> tuple[frozenset[str], list[dict[str, str]]]:
    """沿階梯試編，找到第一個真的能用的就停；回 (交給 `plan()` 的編碼器集合, 每個候選的狀態)。

    為什麼要試編、不信 `ffmpeg -encoders`：NVENC 沒卡／驅動舊、VideoToolbox 在虛擬機裡都會「有列但開不了 session」，
    軟體編碼器也可能是動態連結缺 .so。為什麼找到就停：每次試編是一個 ffmpeg 子行程，後面的候選 plan 根本不會選到。
    沒試過的硬體編碼器從集合拿掉（不能假設能用）；試編失敗的任何候選也拿掉 → plan 只看這個集合，結果可重現。
    狀態：usable / unusable（有列、試編失敗）/ unlisted（這份 ffmpeg 沒編進去）/ gpuOff（spec 關了 GPU）/ untried（前面已有能用的）。
    """
    enc = set(listed)
    report: list[dict[str, str]] = []
    found = False
    for c in chain:
        if found:
            status = "untried"
            if c in HARDWARE_ENCODERS:
                enc.discard(c)
        elif c in HARDWARE_ENCODERS and not gpu:
            status = "gpuOff"
            enc.discard(c)
        elif c not in enc:
            status = "unlisted"
        elif usable(c):
            status, found = "usable", True
        else:
            status = "unusable"
            enc.discard(c)
        report.append({"codec": c, "status": status})
    return frozenset(enc), report


def _audio_encoder(name: str, enc: Collection[str]) -> str:
    if name in enc:
        return name
    alt = _AUDIO_ALT.get(name)
    if alt and alt in enc:
        return alt
    raise OpError("Ffmpeg", f"這份 ffmpeg 沒有音訊編碼器 {name}")


def plan(spec: EncodeSpec, source: SourceInfo, encoders: Collection[str], *, mix_reasons: Sequence[str] | None = None) -> EncodePlan:
    """mix_reasons：None = 不是序列混音（v0.0.6 行為）；list = 序列不是 untouched、要重新混音，內容是給使用者看的原因。"""
    enc = set(encoders)
    container = (spec.container or container_of(spec.out_path) if (spec.container or spec.out_path) else source.container).lower()
    if container not in CONTAINERS:
        raise OpError("Invalid", f"不支援的輸出容器 {container!r}", hint="webm | mp4 | mov | mkv")
    cinfo = CONTAINERS[container]
    notes: list[str] = []
    dropped: list[str] = []

    # ---- 視訊 ----
    fell_back = False  # 是不是階梯替使用者換的（mpeg4 只有在「被換成」時才記 dropped；點名要 mpeg4 就是使用者的選擇）
    if spec.codec == H264_ALIAS:
        if container == "webm":
            raise OpError("Invalid", "webm 容器不能裝 H.264", hint="輸出 mp4／mov／mkv，或改用 libvpx-vp9")
        picked, skipped = pick_encoder(H264_CHAIN, enc, gpu=spec.gpu)
        if picked is None:
            raise OpError(
                "Ffmpeg", f"這份 ffmpeg 沒有可用的 H.264 編碼器（依序找過 {' → '.join(H264_CHAIN)}）",
                hint="macOS：brew install ffmpeg；Linux：安裝發行版的 ffmpeg 套件；或設定 AIVC_FFMPEG_DIR",
            )
        codec, fell_back = picked, bool(skipped)
        if skipped:
            notes.append(f"H.264 自動：{'、'.join(skipped)} 不可用 → {codec}")
    elif spec.codec:
        codec = spec.codec
        if codec not in _KNOWN:
            raise OpError("Invalid", f"未知的視訊編碼器 {codec!r}", hint=_KNOWN_HINT)
        if cinfo["video"] != _ALL and codec not in cinfo["video"]:
            raise OpError("Invalid", f"容器 {container} 不接受 {codec}", hint=f"{container} 可用：{sorted(cinfo['video'])}")
        if codec in HARDWARE_ENCODERS and (codec not in enc or not spec.gpu):
            if container == "webm":
                raise OpError("Invalid", f"{codec} 不可用，而 webm 沒有 H.264 fallback", hint="改用 libvpx-vp9 或輸出 mp4")
            fb, _ = pick_encoder([c for c in H264_CHAIN if c != codec], enc, gpu=spec.gpu)
            if fb is None:
                raise OpError("Ffmpeg", f"{codec} 不可用，而且這份 ffmpeg 沒有任何 H.264 fallback（{' → '.join(H264_CHAIN)}）")
            notes.append(f"{codec} 不可用（{'未啟用 GPU' if not spec.gpu else '這台機器的 ffmpeg 沒有／不能用'}）→ {fb}")
            codec, fell_back = fb, True
        elif codec not in enc:
            if codec in _GPL:
                # 點名要 GPL 編碼器、而這份 ffmpeg 是刻意不含它的 LGPL build：這是「這個安裝版永遠做不到」的參數，不是執行期故障
                raise OpError("Invalid", f"這份 ffmpeg 沒有 {codec}（GPL；Windows 內建的 LGPL ffmpeg 刻意不含）", hint="改用 --codec auto／h264，或指定含 libx264 的 ffmpeg（AIVC_FFMPEG_DIR）")
            raise OpError("Ffmpeg", f"這份 ffmpeg 沒有編碼器 {codec}", hint=f"有的：{sorted(enc)[:12]}…")
    else:
        picked, _ = pick_encoder(cinfo["default"], enc, gpu=spec.gpu)
        if not picked:
            raise OpError("Ffmpeg", f"容器 {container} 的預設編碼器都不可用：{cinfo['default']}", hint="檢查 AIVC_FFMPEG_DIR 指到內建的 ffmpeg")
        codec = picked
        if cinfo["default"][0] != codec:
            notes.append(f"預設 {cinfo['default'][0]} 不可用 → {codec}")
            fell_back = True
    if codec == "mpeg4" and fell_back:
        dropped.append(MPEG4_DROPPED)

    # ---- 音訊 ----
    audio_mode, audio_codec, audio_args = "none", None, []
    if mix_reasons is not None or spec.audio == "mix":
        # 序列混音不看 source.has_audio：聲音可能全部來自音樂檔，或來自序列裡的其他媒體；有沒有音訊來源由呼叫端（音訊圖）判斷
        if spec.audio == "none":
            notes.append(MIX_NONE_NOTE)
        else:
            enc_name, enc_args = cinfo.get("audio_mix", cinfo["audio_encode"])
            enc_name = _audio_encoder(enc_name, enc)
            audio_mode, audio_codec, audio_args = "mix", enc_name, ["-c:a", enc_name, *enc_args]
            dropped.append(f"{MIX_DROPPED}（原因：{'、'.join(mix_reasons) if mix_reasons else '序列已修改'}）")
            if spec.audio == "copy":
                notes.append(MIX_COPY_NOTE)
    elif spec.audio == "none":
        pass
    elif not source.has_audio or not source.audio_codec:
        notes.append("來源沒有音軌")
    else:
        copy_ok = cinfo["audio_copy"] == _ALL or source.audio_codec in cinfo["audio_copy"]
        if spec.audio in ("auto", "copy") and copy_ok:
            audio_mode, audio_codec, audio_args = "copy", source.audio_codec, ["-c:a", "copy"]
        else:
            enc_name, enc_args = cinfo["audio_encode"]
            enc_name = _audio_encoder(enc_name, enc)  # 例如沒有 libopus 就退到內建 opus
            audio_mode, audio_codec, audio_args = "encode", enc_name, ["-c:a", enc_name, *enc_args]
            if spec.audio == "copy" or spec.audio == "auto":
                dropped.append(f"音軌重新編碼（{source.audio_codec} → {enc_name}；{container} 容器不接受直接複製）")
            else:
                notes.append(f"音軌重新編碼（{source.audio_codec} → {enc_name}）")

    # ---- 色彩 ----
    if source.color_range == "pc" and codec in _NO_RANGE_FLAG:
        dropped.append(f"full range 旗標（{codec} 位元流沒有 range 旗標，播放器會當 tv range 顯示；要保留請改 ffv1／libvpx-vp9／H.264／HEVC）")

    return EncodePlan(
        container=container,
        format=cinfo["format"],
        ext=cinfo["ext"],
        video_codec=codec,
        video_args=_video_args(codec, spec.quality, source),
        audio_mode=audio_mode,
        audio_codec=audio_codec,
        audio_args=audio_args,
        color_args=color_args(source.matrix_assumed, source.color_range),
        gpu=codec in HARDWARE_ENCODERS,
        deterministic=codec in _DETERMINISTIC,
        dropped=dropped,
        notes=notes,
        metadata_args=metadata_args(spec.content_note, spec.tool_version or _engine_version()),
    )
