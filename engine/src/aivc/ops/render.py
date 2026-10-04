"""`aivc render <project> -o OUT [--codec …] [--quality N] [--audio auto|copy|encode|none] [--range K0:K1 [--trim]]
[--dry-run] [--emit-matte DIR] [--emit-faces DIR]` 與 `aivc render-plan <project> -o OUT`（op `render.run` / `render.plan`；計畫 §6.7 / §6.8）。
外掛可以替這兩支 op 加旗標（hooks op-args），旗標的值放在 build_plan 的 options["op_args"] 給它自己的插入來源讀。

流程（§5.1 的時間模型 + §6.6 的合成器 + §6.7 的編碼器）：
- 來源**依 PTS 順序只解一趟**；proxy 第 k 幀 = 來源第 map[k] 幀（`CfrMap`）。**同一來源幀對到多個 k（定格）
  只合成一次、重送同一份合成結果** → 輸出總長 = 來源牆鐘時間，`-c:a copy` 不失步。定格跨 --range 邊界時兩側分開合成；
  `-o` 指向來源影片本身一律拒絕（`ensure_out_not_source`）。
- 「換什麼」由插入來源決定（hooks insert-source，例：牌局外掛的格位＋牌組）：每條 track 依序問登記的來源，接手的來源交回
  InsertSpec（新面模板 tmpl_new、原面模板 tmpl_orig（沒有 → lowpass 光影）、插入參數…），沒人接手就跳過。核心自己只有一個來源
  ——平面 track 的 `replace`（`aivc/insert/`：圖片／影片取代表面），排在外掛的來源後面；沒有 replace、也沒有外掛接手的 track 跳過。
  object track（`kind: "object"`）不問插入來源（它沒有平面幾何），只走下面的特效 pass。
- 特效 pass（`aivc/fx/tracks.py`）：track.effects（object 用 ObjectTrack 遮罩；planar 用 masks.aivm、沒有就用 solve 四角）在平面合成
  **之後**、字幕燒入**之前**逐 proxy 幀套 `aivc.fx.apply_effects`；作用範圍外的位元組不動。計畫 JSON 只有在專案有 object track
  或任何 track 帶 effects 時才多一個 `effects` 鍵（每條 track 的特效、狀態與跳過原因）。
- 每幀對有 job 的 track 依序呼叫 `comp.compositor.composite_frame`：H 來自 solve.v1.json、alpha_vis 來自 masks.aivm；
  外掛的 job 子類別可在固定的幾個位置插手（TrackJob.frame_* 掛勾）。
  合成器只寫回 dilate(alpha>0,1px) 內的位元組，其餘幀 bytes 與來源逐位元相同（test_render 有斷言）。
- rawvideo yuv420p 餵進 ffmpeg stdin（`media/encoder.write_frames`：`-progress pipe:1`、out.part → rename、取消即 kill）；
  編碼計畫 `media/encode_plan.plan()`（webm → libvpx-vp9 crf 24 + `-c:a copy`；mp4 → hevc_nvenc → H.264 階梯 h264_nvenc → libopenh264 → h264_videotoolbox → libx264 → mpeg4；ffv1/prores 中間檔）。
- `--range K0:K1`：**預設只限制合成範圔、仍寫出每一幀**（音訊不動、時長不變）；加 `--trim` 才把輸出裁成 [K0,K1)
  （音訊用 `-ss K0/fps -t (K1-K0)/fps` 跟著裁；`-c:a copy` 下是封包粒度 ≈ Opus 20 ms）。
- `--dry-run` = `render-plan`：只印計畫（編碼器、音訊模式、要合成的 track／幀數），不解碼不編碼。
- `--emit-matte DIR`／`--emit-faces DIR`：附帶交付 alpha PNG 序列／矯正後的表面（`export/mattes.py`）。
- 字幕（feat/captions）：`--captions auto|on|off`（auto = 專案字幕 track 的 enabled）在平面合成**之後**逐 proxy 幀燒入
  （`captions/burn.py`：只改字幕 alpha 範圍內的位元組、沒有字幕的幀回傳同一個物件）；k 是絕對幀號，--range 不影響字幕，
  --trim 只決定寫出哪些幀。`--captions-sidecar srt|vtt|ass` 在編碼完成後寫 `<輸出檔名>.<格式>`（--trim 時時間減 K0）。
  字幕檔已存在時**不覆寫**，除非帶 `--overwrite-sidecar`：存檔對話框只問過影片檔要不要覆蓋，旁邊同名的 .srt 是使用者沒看到的副作用
  （可能是手修過的字幕）。render.run／run 在開始編碼前就擋（不白跑幾分鐘）；render-plan 只回報 `captionsSidecarExists`。
- 優雅退化（A4，`comp/fallback.py`）：conf < holdBelowConf 時不直接 hold——SAM 遮罩還在且四角合理、內部像紙 → 用遮罩／仍貼遮罩的
  追蹤四角合成（state coarse）；都不合理 → 用最後一個好 H 在 fadeFrames（2）幀內把 opacity 漸變到 0；再來才 hold。
  逐 track 統計 `coarse`／`faded`（`held` 只剩真正回原幀的幀）。
- 序列（schema v2，設計 docs/editor-m2-design.md §7.1、§7.6；M2.6 只做計畫）：`sequence="auto"`（預設）時讀專案的序列；
  `--source`（`sequence="ignore"`）完全忽略序列、等於 v0.0.6。序列為 null 或 `is_untouched`（比的是值：B 切一刀再合併也算）
  → 走原路徑（`-c:a copy`），計畫 JSON 的 v1 欄位完全不變（不變式 I4），**沒有序列時連 `sequence`／`audio` 兩個鍵都不出現**。
  否則計畫多兩塊：`sequence`（片段／空白／停用／音訊片段數、幀數與時間碼）與 `audio`（mix 模式、原因、`media/audio_graph`
  建好的濾鏡圖全文、輸入數、樣本數 S(T)、來源都有 peaks.v1.bin 時的估計峰值），並先擋 fps／尺寸不符、proxy 缺或片段離線（§3.5：「請以 N/D fps 重建 proxy」）。
- 序列渲染（§7.2、M2.7）：計畫的 v1 欄位改成**序列**的語意（size／fps＝序列、frames.total＝T、range＝序列幀），
  `render_sequence_frames` 逐個序列幀 t 查 (媒體, 來源 proxy 幀 k)，空白／停用輸出黑幀，其餘依來源 k 合成（每支媒體一份
  完整的 track job，與只渲染那支素材時相同）；音訊走 `media/encoder` 的多輸入＋`-/filter_complex` 檔（`-copyts`）。
  不變式 I2（序列第 t 幀 == 只渲染來源時第 k 幀，逐位元）靠三件事：顆粒種子只看 track id（`track_seed`，不看 job 順序）、
  定格重複的 k 一律用來源渲染會用的那個「代表 k」合成（`_MediaRenderer.canonical`）、A4 退化器的狀態在跳著取 k 時
  照來源渲染的順序重播（`_MediaRenderer._advance`）。`--emit-matte／--emit-faces` 以序列幀 t 編號、放在 `<DIR>/media/<mediaId>/<trackId>/`。
  序列輸出暫不支援 `--captions-sidecar`（字幕 cue 要跨片段切開重排，M2.later），燒入字幕照常依來源 k。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from bisect import bisect_right
from collections import Counter
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Iterator

import numpy as np

from .. import env
from . import Ctx, OpError, register

if TYPE_CHECKING:
    from ..comp.params import InsertParams
    from ..media.audio_graph import AudioGraph
    from ..media.encode_plan import EncodePlan
    from ..media.source import Yuv420
    from ..project import schema as S
    from ..project.resolve import MediaContext
    from ..track.state import Solve

_HELP_RUN = "渲染輸出：來源解一趟 → 每幀合成有目標的 track → rawvideo 管線 → ffmpeg（-c:a copy、.part+rename）"
_HELP_PLAN = "只印渲染計畫（編碼器／音訊／要合成的 track 與幀數），不解碼不編碼"


def _common_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("project", help="專案檔 *.aivc.json")
    p.add_argument("-o", "--out", required=True, help="輸出檔（副檔名決定容器：.webm/.mp4/.mov/.mkv）")
    p.add_argument("--media", default=None)
    p.add_argument("--codec", default=None, help="libvpx-vp9 | hevc_nvenc | h264_nvenc | libopenh264 | prores_ks | ffv1（預設依容器／exportDefaults）")
    p.add_argument("--quality", type=int, default=None, help="crf / cq（預設 exportDefaults.quality）")
    p.add_argument("--audio", choices=["auto", "copy", "encode", "none"], default=None, help="預設 exportDefaults.audio")
    p.add_argument("--no-gpu", action="store_true", help="不用 NVENC（確定性輸出／CI）")
    p.add_argument("--range", default=None, metavar="K0:K1", help="只合成 [K0,K1) 的 proxy 幀；仍寫出全部幀（除非 --trim）")
    p.add_argument("--trim", action="store_true", help="與 --range 併用：輸出只保留 [K0,K1)（音訊跟著裁）")
    p.add_argument("--track", action="append", default=None, help="只渲染這些 track（可重複）")
    p.add_argument("--seed", type=int, default=0, help="顆粒種子")
    p.add_argument("--emit-matte", default=None, metavar="DIR", help="alpha PNG 序列（每 track 一個子目錄）")
    p.add_argument("--emit-faces", default=None, metavar="DIR", help="矯正後的表面 PNG（每 track 一個子目錄；模板尺寸的一半）")
    p.add_argument("--captions", choices=["auto", "on", "off"], default="auto", help="燒入字幕：auto = 專案字幕 track 的 enabled；on = 有 track 就燒；off = 不燒")
    p.add_argument("--captions-sidecar", choices=["srt", "vtt", "ass"], default=None, help="另外輸出字幕檔（<輸出檔名>.<格式>；--trim 時時間跟著平移）")
    p.add_argument("--overwrite-sidecar", action="store_true", help="字幕檔已存在時覆寫（預設：已存在就在編碼前報錯）")
    p.add_argument("--source", action="store_true", help="忽略專案的序列，只輸出目前素材（v0.0.6 行為）")
    p.add_argument("--reframe", default=None, metavar="JSON", help="自動重構圖：套用 aivc reframe 產生的裁切路徑（輸出尺寸改成裁切尺寸）")


def _run_args(p: argparse.ArgumentParser) -> None:
    _common_args(p)
    p.add_argument("--dry-run", action="store_true", help="只印計畫（= render-plan）")


def parse_range(s: str | None, n_frames: int) -> tuple[int, int] | None:
    if not s:
        return None
    try:
        a, b = str(s).split(":")
        k0, k1 = int(a), int(b)
    except ValueError as e:
        raise OpError("Invalid", f"--range 要 K0:K1，收到 {s!r}") from e
    k0, k1 = max(0, k0), min(n_frames, k1)
    if k1 <= k0:
        raise OpError("Invalid", f"--range 為空：{s}（proxy 幀數 {n_frames}）")
    return k0, k1


def _same_path(a: str | os.PathLike[str], b: str | os.PathLike[str]) -> bool:
    """兩個路徑是否指向同一個檔。兩邊都存在 → os.path.samefile（大小寫、8.3 短檔名、硬連結、symlink 都認得）；
    否則退回正規化絕對路徑比對（Windows 上 normcase 不分大小寫、/ 與 \\ 視為相同）。"""
    pa, pb = env.normalize_path(a), env.normalize_path(b)
    try:
        if os.path.exists(pa) and os.path.exists(pb):
            return os.path.samefile(pa, pb)
    except OSError:
        pass
    return os.path.normcase(os.path.abspath(pa)) == os.path.normcase(os.path.abspath(pb))


def ensure_out_not_source(out: str | os.PathLike[str], video: str | os.PathLike[str]) -> None:
    """輸出檔不能是來源影片本身（`aivc render` 與 `aivc run` 的 render 階段都經過 build_plan → 這裡）。

    為什麼要自己擋：編碼器寫的是 `<out>.part`，ffmpeg 自己的「輸出＝輸入」檢查永遠不會觸發；解碼器讀完關檔後
    atomic_output 會 os.replace(part, out)，原始素材就被渲染結果蓋掉（快取指紋也對不上，solve／遮罩全變孤兒）。
    `<out>.part` 剛好是來源也一樣危險：`<out>` 存在時 atomic_output 會先做一次 rename 探測（ensure_replaceable），
    來源影片會在整段渲染期間變成 `<out>.part.<pid>-<8hex>.probe`。"""
    out_s = env.normalize_path(out)
    for cand in (out_s, out_s + ".part"):
        if _same_path(cand, video):
            raise OpError(
                "Invalid",
                f"輸出檔 {out_s} 會覆蓋來源影片 {video}（渲染以 .part → rename 寫出，原始素材會被取代且無法復原）",
                "-o 請換一個檔名或資料夾（例如 <名稱>.render.webm）；來源影片必須保持不動，快取與專案都靠它的指紋",
            )


def usable_encoders(gpu: bool) -> set[str]:
    """`ffmpeg -encoders` 列出的 ∖ 試編失敗的硬體編碼器（有列 ≠ 能用）。gpu=False 時直接剔除硬體編碼器，省下試編。

    硬體編碼器清單取 encode_plan.HARDWARE_ENCODERS（NVENC + h264_videotoolbox）：以前只試編 NVENC，
    Mac 上 mp4 匯出會在沒試編的情況下選到 VideoToolbox（虛擬機／沒有硬體 session 時只能靠 -allow_sw 兜底）。
    sorted：試編順序固定，log 與除錯可重現（集合本身的結果與順序無關）。
    """
    from ..media import encode_plan as EP
    from ..media import ffmpeg as ff

    enc = set(ff.list_encoders())
    for c in sorted(EP.HARDWARE_ENCODERS):
        if c in enc and (not gpu or not ff.encoder_usable(c)):
            enc.discard(c)
    return enc


# ---------------------------------------------------------------- 插入來源（hooks insert-source）


@dataclass
class InsertSkip:
    """插入來源說「這次不換」：reason 進計畫 JSON 的 skipped（沒有任何來源接手時才用）。

    weak=True：「這條 track 根本沒綁到我這裡」（例：牌局來源看到沒有格位的 track）——只有沒有別的來源給更具體的原因時才用它；
    weak=False（預設）：「這條 track 是我的、使用者選了不換」（例：格位 target=null）。"""

    reason: str
    weak: bool = False


@dataclass
class InsertSpec:
    """插入來源對一條 track 的回答：印什麼、用什麼參數。核心再補上 solve、遮罩、幀範圍、顆粒種子、退化器。

    tmpl_new／tmpl_orig 是「插入模板」：要有 `.rgb`（H,W,3 uint8）、`.alpha`（覆蓋率）、`.ink_mask`（bool）、`.size`
    （w,h）、`.barcode_px`（保留區框 x0,y0,x1,y1 或 None）。template_wh 是 solve 的 H 要換算到的模板尺寸。"""

    slot: Any  # 綁定物件：計畫 JSON 的 "slot" 取它的 .name
    params: "InsertParams"
    target: str  # 合成器 target："card"（印新面）| "blank"（只留表面底色）
    target_code: str  # 計畫 JSON 的 "target"
    original: str | None  # 計畫 JSON 的 "original"
    rotation: int
    tmpl_new: Any
    tmpl_orig: Any | None
    template_wh: tuple[int, int]
    job_cls: type | None = None  # TrackJob 的子類別（外掛的逐 job 狀態與逐幀掛勾）；None ＝ TrackJob
    surface_check: Callable[..., bool] | None = None  # 退化器的表面檢查（comp/fallback.Degrader.surface_check）


@dataclass
class InsertSession:
    """一次 build_plan 的插入狀態。序列渲染時跨媒體共用：同一份選項、同一份快取（外掛載入的素材、渲染過的模板只做一次）。

    options：build_plan 的外掛選項（`**options`，例：外掛自己的 run 傳進來的物件）；CLI／sidecar 的原始參數在 options["op_args"]。"""

    options: dict[str, Any] = field(default_factory=dict)
    cache: dict[str, Any] = field(default_factory=dict)
    ctx: Any = None  # build_plan 的 Ctx（claim 要讀素材時記 log／進度用；外掛可以不理它）

    @property
    def op_args(self) -> dict[str, Any]:
        v = self.options.get("op_args")
        return v if isinstance(v, dict) else {}


NO_SOURCE_REASON = "沒有要替換的內容（不替換）"


def insert_sources() -> list[Any]:
    """登記的插入來源（hooks insert-source），登記順序。介面（duck typing）：

    - `claim(mctx, track, session)` → 不歸我（None）／`InsertSkip(reason)`／任何其他值＝接手（原樣交回 build）。
    - `build(mctx, ctx, track, shot, solve, claim, session)` → `InsertSpec`。核心已確認 shot 存在、solve 讀得到。
    - `setup_jobs(jobs, mctx, ctx, session)`（可省）：這次建好的、屬於它的 job 全部到齊後呼叫一次（例：包上自己的退化器）。
    - `describe(project, media_id, track)`（可省）：不讀 solve 的快速摘要（`aivc seq show` 的替換數），回 dict 或 None。

    核心的 replace 來源（`aivc.insert.source`）永遠排在最後：外掛先問；`hooks.suspended()` 也拿不掉它（它不是外掛）。"""
    from .. import hooks
    from ..insert.source import SOURCE

    return [*hooks.insert_sources(), SOURCE]


def resolve_shutter_auto(params: "InsertParams", measured_deg: Any, ctx: Ctx, track_id: str) -> "InsertParams":
    """motionBlur.shutterAngle="auto" → 插入來源量到的來源拖尾角度（20–360° 才採用，其餘 180°＝慣例）。

    量測本身是插入來源的事（例：牌局外掛的追蹤器量 motionSmearDeg）；沒量到（None）就記一筆 info。
    插入來源在自己的 build 裡、該解析的時間點呼叫（log 的先後跟著它的流程）。"""
    if params.motion_blur.shutter_angle != "auto":
        return params
    deg = measured_deg
    resolved = float(deg) if isinstance(deg, (int, float)) and 20.0 <= float(deg) <= 360.0 else 180.0
    params = replace(params, motion_blur=replace(params.motion_blur, shutter_angle=resolved))
    if deg is None:
        ctx.log("info", f"track {track_id}：shutterAngle=auto 但追蹤沒量到來源拖尾 → 用 180°")
    return params


# ---------------------------------------------------------------- 計畫


@dataclass
class FrameFace:
    """這一幀要印的那一面（TrackJob.frame_face）：模板、輪廓、合成器 target、保留區遮罩。tag 給外掛自己記帳（例："back"）。"""

    tmpl: Any
    paper: np.ndarray
    target: str
    barcode: np.ndarray | None
    tag: str | None = None


@dataclass
class FrameEnv:
    """逐幀掛勾看得到的同一幀共用東西：整份計畫、帶快取的 `mask_of(job)`（每條 job 這一幀的 SAM 遮罩只讀一次）。"""

    k: int
    plan: "RenderPlan"
    mask_of: Callable[["TrackJob"], np.ndarray | None]


@dataclass
class TrackJob:
    """一條要合成的 track。插入來源（hooks insert-source）用 InsertSpec 給「印什麼」，核心補上 solve／遮罩／幀範圍。

    逐幀合成（composite_at）在固定的位置呼叫下面幾個 `frame_*` 掛勾；外掛用 InsertSpec.job_cls 指定子類別覆寫它們、
    加自己的逐 job 狀態（例：牌局外掛的翻牌與收牌）。沒覆寫＝一般的平面插入。"""

    track: "S.TrackV1"
    shot: "S.ShotV1"
    slot: Any  # 綁定物件（插入來源給的；計畫 JSON 的 "slot" 取它的 .name）
    solve: "Solve"
    params: "InsertParams"
    target: str  # card | blank
    target_code: str
    original: str | None
    rotation: int
    tmpl_new: Any
    tmpl_orig: Any | None
    paper: np.ndarray  # 模板空間輪廓（含墨）
    barcode: np.ndarray | None
    frames: set[int]
    get_mask: Callable[[int], np.ndarray | None] | None = None
    H_scale: np.ndarray | None = None
    seed: int = 0
    composited: int = 0
    held: Counter = field(default_factory=Counter)
    lost: int = 0
    coarse: int = 0  # A4：conf 低但用遮罩四角合成的幀
    faded: int = 0  # A4：用最後一個好 H 漸變淡出的幀
    degrader: Any = None  # comp.fallback.Degrader（外掛可以在 setup_jobs 裡包上自己的）
    # 序列渲染才有：這條 track 屬於哪支媒體、序列（合成範圍內）實際用到它幾個 k。
    # frames 仍是整支素材的 k（I2：合成結果要跟只渲染素材時相同），計畫 JSON 的 frames 改報 used_frames。
    media_id: str | None = None
    used_frames: int | None = None
    template_wh: tuple[int, int] = (0, 0)  # H 的模板座標尺寸（InsertSpec.template_wh）
    surface_check: Callable[..., bool] | None = None  # 給退化器（InsertSpec.surface_check）

    def H_at(self, k: int) -> np.ndarray | None:
        f = self.solve.frames.get(int(k))
        if f is None or f.H is None:
            return None
        return f.H if self.H_scale is None else f.H @ self.H_scale

    def to_json(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.track.id,
            "shot": self.shot.id,
            "kind": self.shot.kind,
            "slot": self.slot.name,
            "target": self.target_code,
            "original": self.original,
            "rotation": self.rotation,
            "regionPolicy": self.params.region_policy,
            "macro": self.params.macro,
            "frames": len(self.frames),
            "masks": self.get_mask is not None,
            "composited": self.composited,
            "held": dict(self.held),
            "lost": self.lost,
            "coarse": self.coarse,
            "faded": self.faded,
        }
        d.update(self.ext_json())  # 外掛子類別的鍵（接在 faded 後面）
        if self.media_id is not None:
            # 只有序列渲染才加鍵：v1 計畫 JSON 逐鍵不變（不變式 I4）
            d["mediaId"] = self.media_id
            d["frames"] = int(self.used_frames or 0)
        return d

    # ---- 外掛子類別覆寫的掛勾（預設＝一般路徑）----
    def ext_json(self) -> dict[str, Any]:
        """計畫 JSON 每條 track 多出來的鍵。"""
        return {}

    def frame_params(self, k: int, dec: Any, params: "InsertParams", H_prev: np.ndarray | None, H_next: np.ndarray | None) -> tuple["InsertParams", np.ndarray | None, np.ndarray | None]:
        """退化器決定之後（核心已處理 coarse 的鄰幀、fade 的不透明度）：這一幀的插入參數與動態模糊鄰幀 H。
        核心不認得的退化狀態（外掛自己的）也在這裡處理。只有走退化器的幀才會呼叫。"""
        return params, H_prev, H_next

    def frame_face(self, k: int, dec: Any) -> FrameFace:
        """這一幀印哪一面。"""
        return FrameFace(self.tmpl_new, self.paper, self.target, self.barcode)

    def frame_visibility(self, k: int, dec: Any, H: np.ndarray, own_mask: np.ndarray | None, alpha_vis: np.ndarray | None, env: FrameEnv) -> tuple[np.ndarray | None, np.ndarray | None]:
        """(可見遮罩, 額外遮擋物)。預設：SAM 遮罩、沒有額外遮擋物。"""
        return alpha_vis, None

    def before_composite(self, k: int, dec: Any, H: np.ndarray) -> None:
        """合成器呼叫之前（例：記下這一幀實際用的輪廓）。"""

    def composite_kwargs(self, k: int, dec: Any, face: FrameFace) -> dict[str, Any]:
        """多交給 composite_frame 的關鍵字參數（例：另一面的模板）。"""
        return {}

    def after_composite(self, k: int, dec: Any, face: FrameFace) -> None:
        """合成成功之後（hold 的幀不會呼叫）：外掛自己的統計。"""


def track_seed(base: int, track_id: str) -> int:
    """顆粒種子 = 基底 + track id 的穩定雜湊（設計 §7.2、§14.2；M2.7）。

    為什麼不再用 `seed + job 序號 × 7919`：序列渲染、`--track` 篩選只要少建一個 job，後面每條 track 的序號就變了，
    同一個來源幀的顆粒跟著變，「序列第 t 幀 == 來源第 k 幀」（I2）就不成立。blake2b 取 4 位元組：跨行程、跨平台穩定
    （Python 內建 hash() 每次啟動都加鹽，不能用）。"""
    h = int.from_bytes(hashlib.blake2b(str(track_id).encode("utf-8"), digest_size=4).digest(), "little")
    return int(base) + h


def timecode(frames: int, fps: tuple[int, int]) -> str:
    """hh:mm:ss:ff（NDF：29.97 以 30 格計，同 App 的 timecode()；drop-frame 在 M2.later）。"""
    nominal = max(1, round(fps[0] / max(fps[1], 1)))
    s, ff = divmod(max(0, int(frames)), nominal)
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    return f"{h:02d}:{m:02d}:{s:02d}:{ff:02d}"


@dataclass
class SequencePlan:
    """專案序列在這次輸出裡的樣子（設計 §7.1、§7.6）。untouched → v0.0.6 原路徑；否則需要序列渲染（M2.7）與重新混音。"""

    seq: "S.SequenceV2"
    untouched: bool
    frames: int  # T
    reasons: list[str]  # 為什麼要重新混音（untouched 時為空）
    graph: "AudioGraph | None"  # untouched 時 None
    range: tuple[int, int] | None = None  # 序列幀 [T0, T1)
    trim: bool = False
    # 序列引用的來源裡有沒有任何音軌（含被靜音的）：False 時不輸出音軌，而不是輸出一條靜音
    has_audio_sources: bool = False
    # build_plan 填：寫出範圍內會出現的每支 V1 媒體（依第一次出現的順序）
    media: dict[str, "SequenceMedia"] = field(default_factory=dict)

    @property
    def needs_render(self) -> bool:
        return not self.untouched

    def sequence_json(self) -> dict[str, Any]:
        from ..sequence.model import describe

        d = describe(self.seq)
        fps = (self.seq.fps.num, self.seq.fps.den)
        return {
            "id": d["id"], "frames": d["frames"], "duration": timecode(d["frames"], fps), "fps": {"num": fps[0], "den": fps[1]},
            "clips": d["clips"], "gaps": d["gaps"], "disabled": d["disabled"], "audioClips": d["audioClips"], "untouched": self.untouched,
            "range": None if self.range is None else list(self.range), "trim": self.trim,
        }

    def audio_json(self, encode: "EncodePlan") -> dict[str, Any]:
        g = self.graph
        return {
            "mode": encode.audio_mode,
            "codec": encode.audio_codec,
            "reasons": list(self.reasons),
            "inputs": len(g.inputs) if g is not None else 0,
            "samples": g.total_samples if g is not None and encode.audio_mode == "mix" else None,
            "graph": g.text if g is not None and encode.audio_mode == "mix" else None,
            "peakEstimateDbfs": g.peak_estimate_dbfs if g is not None else None,
            "limiter": bool(self.seq.limiter),
            "notes": list(g.notes) if g is not None else [],
            # 給 Inspector／輸出對話框對數字（M2.15「Inspector 的數值與 plan 一致」）與 M2.7 的執行端（stem 兩段式）
            "chains": [c.to_json() for c in g.chains] if g is not None else [],
            "stems": [s.to_json() for s in g.stems] if g is not None else [],
        }


@dataclass
class RenderPlan:
    out: Path
    encode: "EncodePlan"
    width: int
    height: int
    fps: tuple[int, int]
    n_frames: int
    range: tuple[int, int] | None
    trim: bool
    jobs: list[TrackJob]
    skipped: list[dict[str, str]]
    emit_matte: Path | None = None
    emit_faces: Path | None = None
    seed: int = 0
    captions: Any = None  # captions.burn.CaptionBurner | None（字幕燒錄：平面合成之後、每個 proxy 幀一次）
    captions_track: dict[str, Any] | None = None  # 側車字幕檔用（不燒也能輸出）
    captions_sidecar: str | None = None
    overwrite_sidecar: bool = False
    sequence: SequencePlan | None = None  # None = 沒有序列（隱含序列）或 --source
    # 序列渲染時由 build_plan 算好（會合成的序列幀數）；jobs 的 frames 是各媒體自己的 k，不能直接取聯集
    composite_count: int | None = None
    # 自動重構圖的裁切路徑（reframe.path.ReframePath | None）。刻意**不**改 width/height：
    # 那兩個是合成空間（遮罩、空白幀、字幕排版都用它），裁切是合成完之後、進編碼器之前的最後一步。
    reframe: Any = None
    # build_plan 的外掛選項（插入來源與 render-finish 掛勾讀；CLI／sidecar 原始參數在 options["op_args"]）
    options: dict[str, Any] = field(default_factory=dict)
    # 特效 pass（fx.tracks.EffectsPlan | None）：平面合成之後、字幕之前。序列計畫的這個欄位是所有媒體的 track 合在一起（只給 JSON），
    # 真正套用的是每支媒體子計畫（SequenceMedia.plan.effects）
    effects: Any = None

    @property
    def out_size(self) -> tuple[int, int]:
        """真正寫進編碼器的尺寸。沒有重構圖時就是合成尺寸。"""
        return tuple(self.reframe.size) if self.reframe is not None else (self.width, self.height)  # type: ignore[return-value]

    @property
    def write_range(self) -> tuple[int, int]:
        return self.range if (self.trim and self.range) else (0, self.n_frames)

    @property
    def n_write(self) -> int:
        a, b = self.write_range
        return b - a

    @property
    def n_composite(self) -> int:
        if self.composite_count is not None:
            return self.composite_count
        return len(set().union(*(j.frames for j in self.jobs))) if self.jobs else 0

    def to_json(self) -> dict[str, Any]:
        d = self._v1_json()
        if self.reframe is not None:
            d["reframe"] = {"size": list(self.reframe.size), "source": list(self.reframe.source), "cuts": list(self.reframe.cuts)}
        if self.sequence is not None:
            # 只有專案真的有序列時才加鍵：v1 專案的計畫 JSON 逐鍵不變（不變式 I4）
            d["sequence"] = self.sequence.sequence_json()
            d["audio"] = self.sequence.audio_json(self.encode)
        if self.effects is not None:
            # 同上：專案有 object track 或 track 帶 effects 才加鍵
            d["effects"] = self.effects.to_json()
        return d

    def _v1_json(self) -> dict[str, Any]:
        return {
            "out": str(self.out),
            "encode": self.encode.to_json(),
            "size": [self.width, self.height],
            "fps": {"num": self.fps[0], "den": self.fps[1]},
            "frames": {"total": self.n_frames, "write": self.n_write, "composite": self.n_composite},
            "range": None if self.range is None else list(self.range),
            "trim": self.trim,
            "tracks": [j.to_json() for j in self.jobs],
            "skipped": self.skipped,
            "emitMatte": None if self.emit_matte is None else str(self.emit_matte),
            "emitFaces": None if self.emit_faces is None else str(self.emit_faces),
            "captions": None if self.captions is None else self.captions.to_json(),
            "captionsSidecar": self.sidecar_path_str(),
            # UI 用：存在且沒帶 --overwrite-sidecar 時 render.run 會在編碼前報錯 → 先問使用者要不要覆寫
            "captionsSidecarExists": bool(self.sidecar_path() is not None and self.sidecar_path().exists()),
            "overwriteSidecar": self.overwrite_sidecar,
        }

    def sidecar_path(self) -> Path | None:
        if not self.captions_sidecar or self.captions_track is None:
            return None
        return self.out.with_suffix(f".{self.captions_sidecar}")

    def sidecar_path_str(self) -> str | None:
        p = self.sidecar_path()
        return None if p is None else str(p)

    def sidecar_blocked(self) -> Path | None:
        """要寫的字幕檔已經存在、又沒有 --overwrite-sidecar → 那個路徑；否則 None。"""
        p = self.sidecar_path()
        return p if (p is not None and not self.overwrite_sidecar and p.exists()) else None


def build_plan(
    mctx: "MediaContext",
    ctx: Ctx,
    *,
    out: str,
    codec: str | None = None,
    quality: int | None = None,
    audio: str | None = None,
    gpu: bool = True,
    range_spec: str | None = None,
    trim: bool = False,
    track_ids: list[str] | None = None,
    seed: int = 0,
    emit_matte: str | None = None,
    emit_faces: str | None = None,
    captions: str | None = "auto",
    captions_sidecar: str | None = None,
    overwrite_sidecar: bool = False,
    sequence: str | None = "auto",
    **options: Any,
) -> RenderPlan:
    """options：外掛選項，原樣交給插入來源（InsertSession.options）與 render-finish 掛勾（RenderPlan.options）。
    核心不解讀；CLI／sidecar 的原始參數放在 options["op_args"]（`_plan_from_args`）。"""
    from ..media import encode_plan as EP

    project, media_id = mctx.project, mctx.media_id
    W, H = mctx.size
    N = mctx.n_frames
    out_path = Path(env.normalize_path(out))
    # 在列編碼器（會試編 NVENC）之前就擋：render／run 的 render 階段／render-plan 都會經過這裡
    ensure_out_not_source(out_path, mctx.video)
    cap_mode = str(captions or "auto")
    if cap_mode not in ("auto", "on", "off"):
        raise OpError("Invalid", f"--captions 要 auto|on|off，收到 {captions!r}")
    seq_plan = sequence_plan(mctx, ctx, out_path=out_path, mode=sequence, range_spec=range_spec, trim=trim)
    ed = project.export_defaults
    want_codec = codec or (None if (ed.codec or "auto") == "auto" else ed.codec)
    q = quality if quality is not None else (int(ed.quality) if ed.quality else None)
    # 內容揭露句子：專案 extra.contentNote（profile 可寫入自己的句子）→ 否則編碼計畫的預設。空字串不允許關掉：
    # 渲染輸出一律要標明是改過的影片（proxy 才用 ""，而 proxy 不走這裡）
    note = project.extra.get("contentNote") if isinstance(project.extra.get("contentNote"), str) and project.extra.get("contentNote").strip() else None
    spec = EP.EncodeSpec(container=None, codec=want_codec, quality=q, audio=audio or ed.audio or "auto", gpu=gpu, out_path=str(out_path), content_note=note)
    session = InsertSession(dict(options), ctx=ctx)
    if seq_plan is not None and seq_plan.needs_render:
        return _build_sequence_render_plan(
            mctx, ctx, seq_plan, out_path=out_path, spec=spec, gpu=gpu, track_ids=track_ids, session=session, seed=seed,
            emit_matte=emit_matte, emit_faces=emit_faces, cap_mode=cap_mode, captions_sidecar=captions_sidecar, overwrite_sidecar=overwrite_sidecar,
        )
    rng = parse_range(range_spec, N)

    # ---- 編碼計畫 ----
    enc_plan = EP.plan(spec, EP.SourceInfo.from_probe(mctx.probe), usable_encoders(gpu))

    # ---- 每條 track ----
    jobs, skipped = _build_jobs(mctx, ctx, track_ids=track_ids, session=session, seed=seed, rng=rng)
    fx_plan = _effects_for_media(mctx, ctx, track_ids, rng)
    # ---- 字幕（feat/captions）----
    cap_track = project.captions.get(media_id) if getattr(project, "captions", None) else None
    burner = _burner_for_media(mctx, ctx, cap_mode, (W, H), mctx.fps)
    if captions_sidecar and not cap_track:
        ctx.log("warn", "--captions-sidecar 但沒有字幕 track：不輸出字幕檔")
    if not jobs and burner is None and (fx_plan is None or not fx_plan.usable):
        ctx.log("warn", "沒有任何 track 可合成（沒有要替換的內容或沒有 solve）：輸出等於重新編碼的來源")
    return RenderPlan(
        out=out_path, encode=enc_plan, width=W, height=H, fps=mctx.fps, n_frames=N, range=rng, trim=bool(trim and rng), jobs=jobs, skipped=skipped,
        emit_matte=Path(env.normalize_path(emit_matte)) if emit_matte else None,
        emit_faces=Path(env.normalize_path(emit_faces)) if emit_faces else None,
        seed=int(seed),
        captions=burner, captions_track=cap_track or None, captions_sidecar=captions_sidecar or None, overwrite_sidecar=bool(overwrite_sidecar),
        sequence=seq_plan, options=session.options, effects=fx_plan,
    )


def _effects_for_media(mctx: "MediaContext", ctx: Ctx, track_ids: list[str] | None, rng: tuple[int, int] | None) -> Any:
    """這支媒體的特效 pass（`aivc/fx/tracks.py`）；沒有 object track、也沒有 track 帶 effects → None。"""
    from ..fx import tracks as FT

    plan = FT.build(mctx, ctx, track_ids=track_ids, rng=rng)
    if plan is not None:
        for t in plan.tracks:
            for e in t.entries:
                if e.status == "invalid":
                    ctx.log("warn", f"track {t.track_id} 的特效 {e.id}（{e.type}）不合法，略過：{e.reason}")
    return plan


def _burner_for_media(mctx: "MediaContext", ctx: Ctx, cap_mode: str, size: tuple[int, int], fps: tuple[int, int]) -> Any:
    """一支媒體的字幕燒錄器（沒有字幕 track 或 --captions off → None）。"""
    project, media_id = mctx.project, mctx.media_id
    cap_track = project.captions.get(media_id) if getattr(project, "captions", None) else None
    burner = None
    if cap_track and cap_mode != "off":
        from ..captions.burn import burner_for

        burner = burner_for(cap_track, size[0], size[1], fps, cap_mode)
        # 字型缺字（找不到任何字型／字型沒有中日韓字形）：燒出來會是方塊，一定要讓人看到（計畫 JSON 的 captions.warnings 也有同一筆）
        for w in burner.warnings if burner is not None else ():
            if w.get("kind") in ("fontFallback", "fontNoCjk"):
                ctx.log("warn", f"字幕：{w.get('message')}")
    elif cap_mode == "on":
        ctx.log("warn", f"--captions on 但 media {media_id} 沒有字幕 track（先跑 aivc captions-build）")
    return burner


def _new_degrader(job: TrackJob) -> Any:
    from ..comp.fallback import Degrader

    sm = job.params.smoothing
    return Degrader(
        tmpl_wh=tuple(job.template_wh),  # type: ignore[arg-type]
        hold_below=float(sm.hold_below_conf),
        get_mask=job.get_mask, get_H=job.H_at, get_conf=(lambda k, _j=job: float(_j.solve.frames[k].conf) if k in _j.solve.frames else 0.0),
        coarse_from_mask=bool(sm.coarse_from_mask), fade_frames=int(sm.fade_frames), surface_check=job.surface_check,
    )


def _claim(mctx: "MediaContext", track: "S.TrackV1", sources: list[Any], session: InsertSession) -> tuple[Any, Any, str | None]:
    """(來源, claim, 跳過原因)。第一個接手的來源勝出；都沒接手時回第一個（非 weak）InsertSkip 的原因，
    沒有就用第一個 weak 的，再沒有就是核心的通用原因。"""
    strong: str | None = None
    weak: str | None = None
    for src in sources:
        r = src.claim(mctx, track, session)
        if r is None:
            continue
        if isinstance(r, InsertSkip):
            if r.weak:
                weak = weak or r.reason
            else:
                strong = strong or r.reason
            continue
        return src, r, None
    return None, None, strong or weak or NO_SOURCE_REASON


def _build_jobs(
    mctx: "MediaContext",
    ctx: Ctx,
    *,
    track_ids: list[str] | None,
    session: InsertSession,
    seed: int,
    rng: tuple[int, int] | None,
) -> tuple[list[TrackJob], list[dict[str, str]]]:
    """一支媒體的 track job（v1 與序列渲染共用）。rng：只合成 [K0,K1) 的來源 k（None = 整支）。回 (jobs, skipped)。

    每條 track 依序問登記的插入來源（hooks insert-source）要不要接手；沒人接手就跳過（計畫 JSON 的 skipped 寫原因）。
    session 由呼叫端給：序列有多支媒體時共用（插入來源的素材與模板快取只做一次）。"""
    from ..project import resolve as R

    project, media_id = mctx.project, mctx.media_id
    W, H = mctx.size
    N = mctx.n_frames
    jobs: list[TrackJob] = []
    owners: list[Any] = []
    skipped: list[dict[str, str]] = []
    shots = {s.id: s for s in mctx.shots()}
    tracks = R.select_tracks(project, media_id, track_ids)
    sources = insert_sources()

    for t in tracks:
        if t.is_object:
            continue  # object track 沒有平面幾何：不問插入來源，只走特效 pass（計畫 JSON 的 effects）
        src, claim, skip = _claim(mctx, t, sources, session)
        if src is None:
            skipped.append({"trackId": t.id, "reason": str(skip)})
            continue
        shot = shots.get(t.shot_id)
        if shot is None:
            skipped.append({"trackId": t.id, "reason": f"shotId {t.shot_id!r} 不存在"})
            continue
        solve = R.load_solve(mctx.cache, t.id)
        if solve is None:
            skipped.append({"trackId": t.id, "reason": "沒有 solve.v1.json（先跑 aivc track / run）"})
            continue
        spec: InsertSpec = src.build(mctx, ctx, t, shot, solve, claim, session)
        tmpl_new = spec.tmpl_new
        paper = tmpl_new.alpha > 0.5
        bc = getattr(tmpl_new, "barcode_px", None)
        barcode = None
        if bc is not None and bc[2] > bc[0] and bc[3] > bc[1]:
            barcode = np.zeros(paper.shape, dtype=bool)
            barcode[bc[1] : bc[3], bc[0] : bc[2]] = True
        mf = R.open_masks(mctx.cache, t.id)
        if mf is not None and (mf.width, mf.height) != (W, H):
            raise OpError("Invalid", f"track {t.id} 的遮罩尺寸 {mf.width}x{mf.height} ≠ 影片 {W}x{H}", "重跑 aivc seg")
        lo, hi = shot.start_frame, min(shot.end_frame, N)
        if rng is not None:
            lo, hi = max(lo, rng[0]), min(hi, rng[1])
        frames = {k for k in solve.frames if lo <= k < hi}
        H_scale = None
        if tuple(solve.template_wh) != tuple(spec.template_wh):
            tw, th = solve.template_wh
            nw, nh = spec.template_wh
            H_scale = np.diag([tw / nw, th / nh, 1.0])
        cls = spec.job_cls or TrackJob
        jobs.append(
            cls(
                track=t, shot=shot, slot=spec.slot, solve=solve, params=spec.params,
                target=spec.target, target_code=spec.target_code, original=spec.original, rotation=spec.rotation,
                tmpl_new=tmpl_new, tmpl_orig=spec.tmpl_orig, paper=paper, barcode=barcode, frames=frames,
                get_mask=R.mask_getter(mf), H_scale=H_scale, seed=track_seed(seed, t.id),
                template_wh=tuple(spec.template_wh), surface_check=spec.surface_check,
            )
        )
        owners.append(src)
    for j in jobs:
        j.degrader = _new_degrader(j)
    # 每個插入來源拿到自己的 job（依登記順序；同一個來源的 job 保持 track 順序）。沒有 job 也呼叫：
    # 來源可能要先驗自己的設定（例：專案層級的設定不合法要在這裡就擋）
    for src in sources:
        mine = [j for j, o in zip(jobs, owners) if o is src]
        setup = getattr(src, "setup_jobs", None)
        if setup is not None:
            setup(mine, mctx, ctx, session)
    return jobs, skipped


# ---------------------------------------------------------------- 序列（M2.6：計畫）


def _check_sequence_media(project: "S.ProjectFile", seq: "S.SequenceV2") -> None:
    """序列能不能渲染（設計 §3.5：sanitize 保留並警告的東西，到輸出時要擋下並告訴使用者怎麼修）。"""
    from ..project import schema as SCH
    from ..sequence.model import duration_frames

    if duration_frames(seq) <= 0:
        raise OpError("Invalid", "序列是空的（沒有任何片段或空白）", "在時間軸加入媒體，或加 --source 只輸出目前素材")
    if seq.width <= 0 or seq.height <= 0:
        raise OpError("Invalid", f"序列尺寸 {seq.width}x{seq.height} 無效", "在 App 裡重新加入媒體讓序列取得尺寸，或加 --source 只輸出目前素材")
    fps = seq.fps
    for it in seq.video:
        if not isinstance(it, SCH.VideoClipV2):
            continue
        m = project.media_by_id(it.media_id)
        if m is None:  # sanitize 已丟掉；程式建的序列才可能走到這裡
            raise OpError("Invalid", f"片段 {it.id} 引用的媒體 {it.media_id!r} 不在專案裡")
        name = m.name or m.id
        if m.proxy is None:
            raise OpError("Invalid", f"片段 {it.id} 的媒體 {name} 沒有 proxy（幀數與 fps 未知）", "先建立 proxy 再輸出序列")
        pf = m.proxy.fps
        if pf.num * fps.den != fps.num * pf.den:
            raise OpError("Invalid", f"媒體 {name} 的 proxy 是 {pf.num}/{pf.den} fps，序列是 {fps.num}/{fps.den} fps", f"請以 {fps.num}/{fps.den} fps 重建 proxy")
        if it.src_out > m.proxy.frames:
            raise OpError(
                "Invalid", f"片段 {it.id}（{name}）離線：來源範圍 [{it.src_in}, {it.src_out}) 超過 proxy 的 {m.proxy.frames} 幀",
                f"以 {fps.num}/{fps.den} fps 重建 proxy，或修剪這個片段",
            )
        size = m.source_size
        if size is not None and size != (seq.width, seq.height):
            raise OpError("Invalid", f"媒體 {name} 的尺寸 {size[0]}x{size[1]} ≠ 序列 {seq.width}x{seq.height}", "目前序列要求 V1 所有媒體同尺寸")


def _audio_resolvers(project: "S.ProjectFile", project_path: Path, ctx: Ctx) -> tuple[Callable[[str, str], Any], Callable[[str, str], str]]:
    """audio_graph.build 的 info_of／path_of：專案檔裡的 `audio` 優先（App 開檔時已寫入）；沒有就讀 audio.v1.json 快取，
    再沒有才只解音訊一趟（約 500 倍即時）並寫快取——舊專案或 CLI 建的專案也能出計畫，不用先開 App。"""
    from ..media import audio_info as AI
    from ..media import cache as C
    from ..project import resolve as R

    infos: dict[tuple[str, str], Any] = {}
    paths: dict[tuple[str, str], str] = {}

    def what(kind: str) -> str:
        return "媒體" if kind == "media" else "音訊檔"

    def item(kind: str, ref_id: str) -> Any:
        m = project.media_by_id(ref_id) if kind == "media" else project.audio_media_by_id(ref_id)
        if m is None:
            raise OpError("Invalid", f"序列引用的{what(kind)} {ref_id!r} 不在專案裡")
        return m

    def path_of(kind: str, ref_id: str) -> str:
        key = (kind, ref_id)
        if key not in paths:
            m = item(kind, ref_id)
            try:
                paths[key] = R.video_path_of(m, project_path)
            except OpError as e:
                raise OpError("Io", f"找不到{what(kind)} {m.name or ref_id}：{m.path}", "檔案搬過位置？在 App 裡重新連結，或加 --source 只輸出目前素材") from e
        return paths[key]

    def info_of(kind: str, ref_id: str) -> Any:
        key = (kind, ref_id)
        if key not in infos:
            m = item(kind, ref_id)
            info = m.audio
            if info is None:
                p = path_of(kind, ref_id)
                try:
                    scan, _cached, _reason = AI.ensure(p, C.for_file(p), ctx)
                except OpError:
                    raise
                except Exception as e:  # noqa: BLE001
                    if type(e).__name__ == "Canceled":
                        raise
                    raise OpError("Invalid", f"解不開{what(kind)} {m.name or ref_id} 的音訊：{e}", "PyAV 讀不了這個檔案的音訊串流") from e
                info = scan.info if scan.has_audio else None
            infos[key] = info
        return infos[key]

    return info_of, path_of


PEAKS_FILE = "peaks.v1.bin"
_PEAKS_HEADER = "<4sIIIIQq"  # "AIVP" | u32 version | u32 pps | u32 sr | u32 n_buckets | u64 total_samples | i64 stream_start_us
_PEAKS_BUCKET_US = 5_000


def read_peaks_abs(path: Path) -> np.ndarray | None:
    """`peaks.v1.bin`（Rust peaks.rs，設計 §3.4）→ 每個 5 ms 桶的絕對峰值（0..127，桶 i = 容器絕對時間 [5i, 5i+5) ms）。

    這裡只讀、不產生（波形是 App 的 Rust 端算的）。檔案不在、magic／版本／桶設定／長度任何一項不符都回 None：
    峰值只是提示用的估計，讀不懂就當「未知」，絕不能因為快取格式變了讓輸出計畫失敗。"""
    import struct

    try:
        data = path.read_bytes()
    except OSError:
        return None
    head = struct.calcsize(_PEAKS_HEADER)
    if len(data) < head:
        return None
    magic, version, pps, sr, n, _total, _start = struct.unpack_from(_PEAKS_HEADER, data)
    if magic != b"AIVP" or version != 1 or pps != 200 or sr != 48_000 or len(data) != head + 4 * n:
        return None
    mins = np.frombuffer(data, dtype=np.int8, count=n, offset=head).astype(np.int16)
    maxs = np.frombuffer(data, dtype=np.int8, count=n, offset=head + n).astype(np.int16)
    return np.maximum(np.abs(mins), np.abs(maxs))


def _peak_resolver() -> Callable[[Any], float | None]:
    """audio_graph.build 的 peak_of：鏈的來源在 [inUs, outUs) 內的峰值 dBFS；來源還沒有 peaks.v1.bin → None（整體估計就是未知）。"""
    import math

    from ..media import cache as C

    loaded: dict[str, np.ndarray | None] = {}

    def peak_of(chain: Any) -> float | None:
        if chain.path not in loaded:
            try:
                loaded[chain.path] = read_peaks_abs(C.for_file(chain.path).dir / PEAKS_FILE)
            except OSError:
                loaded[chain.path] = None
        arr = loaded[chain.path]
        if arr is None:
            return None
        lo = max(0, chain.in_us // _PEAKS_BUCKET_US)
        hi = min(len(arr), -(-chain.out_us // _PEAKS_BUCKET_US))
        p = float(arr[lo:hi].max()) / 127 if hi > lo else 0.0
        return 20 * math.log10(p) if p > 0 else -120.0  # 範圍內全是靜音（或在串流之外）：遠低於任何門檻

    return peak_of


def sequence_plan(mctx: "MediaContext", ctx: Ctx, *, out_path: Path, mode: str | None, range_spec: str | None, trim: bool) -> SequencePlan | None:
    """`sequence` 參數（auto | ignore）→ 這次輸出的序列計畫；None = 沒有序列或忽略序列（v0.0.6 原路徑）。"""
    from ..media import audio_graph as AG
    from ..project import schema as SCH
    from ..sequence import model as SM

    m = str(mode or "auto")
    if m not in ("auto", "ignore"):
        raise OpError("Invalid", f"sequence 要 auto|ignore，收到 {mode!r}")
    project = mctx.project
    seq = project.sequence if m == "auto" else None
    if seq is None:
        return None
    frames = SM.duration_frames(seq)
    if SM.is_untouched(seq, project):
        only = seq.video[0]
        if isinstance(only, SCH.VideoClipV2) and only.media_id != mctx.media_id:
            ctx.log("warn", f"序列是媒體 {only.media_id} 整段未剪，但這次輸出的是 {mctx.media_id}：照 --media 輸出")
        return SequencePlan(seq, True, frames, [], None)
    _check_sequence_media(project, seq)
    rng = parse_range(range_spec, frames)
    window = rng if (trim and rng is not None) else None
    info_of, path_of = _audio_resolvers(project, mctx.project_path, ctx)

    def frames_of(media_id: str) -> int | None:
        mm = project.media_by_id(media_id)
        return mm.proxy.frames if mm is not None and mm.proxy is not None else None

    graph = AG.build(
        seq, project, window, info_of=info_of, path_of=path_of, peak_of=_peak_resolver(), first_input=1, stem_dir=f"{out_path}.part.stems",
    )
    # 有沒有任何音訊來源（含被靜音的）：全部靜音時仍輸出一條剛好 S(T) 的靜音音軌；序列裡根本沒有聲音來源才不輸出音軌
    has_audio = (
        bool(graph.chains)
        or any(info_of("media", it.media_id) is not None for it in seq.video if isinstance(it, SCH.VideoClipV2))
        or any(c.source is not None and info_of(c.source.type, c.source.ref_id) is not None for lane in seq.audio_lanes for c in lane.clips)
    )
    return SequencePlan(seq, False, frames, AG.mix_reasons(seq, frames_of), graph, rng, bool(window), has_audio)


# ---------------------------------------------------------------- 序列（M2.7：渲染計畫）


@dataclass
class SequenceMedia:
    """序列渲染裡的一支 V1 媒體：自己的 MediaContext 與「只渲染這支素材」時的計畫。

    plan.jobs 是整支素材的 track job（frames 不限序列用到的 k）：A4 退化器的狀態、定格的代表 k 都要跟來源渲染一模一樣，
    合成結果才會逐位元相同（I2）；序列實際用到幾幀記在 job.used_frames 給計畫 JSON。"""

    media_id: str
    mctx: "MediaContext"
    plan: RenderPlan
    used: set[int]  # 寫出且在合成範圍內的來源 k


def _media_context_for(base: "MediaContext", media_id: str, ctx: Ctx) -> "MediaContext":
    """序列裡另一支媒體的 MediaContext：沿用已讀進來的專案物件（不重讀專案檔、不重複警告），其餘同 open_media_context。"""
    from ..project import paths as P
    from ..project import resolve as R
    from .media import ensure_index, open_media

    if media_id == base.media_id:
        return base
    media = R.select_media(base.project, media_id)
    video = R.video_path_of(media, base.project_path)
    mc, pr = open_media(video, ctx)
    want_fps = (media.proxy.fps.num, media.proxy.fps.den) if media.proxy is not None else None
    idx, cfr, _ = ensure_index(video, mc, pr, ctx, fps=want_fps)
    if media.proxy is not None and media.proxy.frames != cfr.n_frames:
        ctx.log("warn", f"媒體 {media.name or media_id}：專案 proxy.frames={media.proxy.frames} 但索引算出 {cfr.n_frames} 幀；以索引為準")
    return R.MediaContext(base.project, base.project_path, media, video, P.media_cache(mc.fingerprint), pr, idx, cfr, [])


def _build_sequence_render_plan(
    mctx: "MediaContext",
    ctx: Ctx,
    seq_plan: SequencePlan,
    *,
    out_path: Path,
    spec: Any,
    gpu: bool,
    track_ids: list[str] | None,
    session: InsertSession,
    seed: int,
    emit_matte: str | None,
    emit_faces: str | None,
    cap_mode: str,
    captions_sidecar: str | None,
    overwrite_sidecar: bool,
) -> RenderPlan:
    """序列需要重新渲染時的計畫（設計 §7.2）：v1 欄位改用序列的尺寸、fps、幀數與序列幀範圍。"""
    from dataclasses import replace as dc_replace

    from ..media import encode_plan as EP
    from ..project import schema as SCH
    from ..sequence import model as SM

    seq = seq_plan.seq
    W, H = int(seq.width), int(seq.height)
    fps = (int(seq.fps.num), int(seq.fps.den))
    T = seq_plan.frames
    rng, trim = seq_plan.range, seq_plan.trim
    w_lo, w_hi = rng if (trim and rng is not None) else (0, T)
    c_lo, c_hi = rng if rng is not None else (0, T)

    # ---- 寫出範圍內出現的媒體、合成範圍內用到的來源 k ----
    order: list[str] = []
    used: dict[str, set[int]] = {}
    max_out: dict[str, int] = {}
    for p in SM.place_video(seq):
        it = p.item
        if not isinstance(it, SCH.VideoClipV2) or not it.enabled:
            continue
        a, b = max(p.t0, w_lo), min(p.t1, w_hi)
        if a >= b:
            continue
        if it.media_id not in used:
            order.append(it.media_id)
            used[it.media_id] = set()
        max_out[it.media_id] = max(max_out.get(it.media_id, 0), it.src_in + (b - p.t0))
        ca, cb = max(a, c_lo), min(b, c_hi)
        if ca < cb:
            used[it.media_id].update(range(it.src_in + (ca - p.t0), it.src_in + (cb - p.t0)))

    # ---- 開每支媒體、擋序列要求（尺寸、fps、幀數、色彩一致）----
    contexts: dict[str, "MediaContext"] = {}
    color: tuple[str, str] | None = None
    for m_id in order:
        mc = _media_context_for(mctx, m_id, ctx)
        name = mc.media.name or m_id
        ensure_out_not_source(out_path, mc.video)
        if mc.size != (W, H):
            raise OpError("Invalid", f"媒體 {name} 的尺寸 {mc.size[0]}x{mc.size[1]} ≠ 序列 {W}x{H}", "目前序列要求 V1 所有媒體同尺寸")
        if mc.fps[0] * fps[1] != fps[0] * mc.fps[1]:
            raise OpError("Invalid", f"媒體 {name} 的索引是 {mc.fps[0]}/{mc.fps[1]} fps，序列是 {fps[0]}/{fps[1]} fps", f"請以 {fps[0]}/{fps[1]} fps 重建 proxy")
        if max_out[m_id] > mc.n_frames:
            raise OpError("Invalid", f"媒體 {name} 的片段用到第 {max_out[m_id] - 1} 幀，但素材只有 {mc.n_frames} 幀（片段離線）", f"以 {fps[0]}/{fps[1]} fps 重建 proxy，或修剪片段")
        mine = (str(mc.probe.matrix_assumed), str(mc.probe.range_or_default))
        if color is None:
            color = mine
        elif mine != color:
            # 合成器與 rawvideo 管線都只有一組色彩 tag：混用會讓其中一支媒體整段顏色被播放器解讀錯
            raise OpError("Invalid", f"媒體 {name} 的色彩（矩陣 {mine[0]}、範圍 {mine[1]}）與序列第一支媒體（{color[0]}、{color[1]}）不同", "目前序列要求 V1 所有媒體同色彩範圍與矩陣")
        contexts[m_id] = mc
    if seq_plan.graph is not None:
        for c in seq_plan.graph.chains:
            ensure_out_not_source(out_path, c.path)

    # ---- 編碼計畫：尺寸／fps 用序列的，色彩跟第一支媒體 ----
    probe = contexts[order[0]].probe if order else mctx.probe
    src_info = dc_replace(EP.SourceInfo.from_probe(probe), width=W, height=H, fps_num=fps[0], fps_den=fps[1])
    mix_reasons: list[str] | None = seq_plan.reasons
    if not seq_plan.has_audio_sources:
        # 序列裡沒有任何來源有音軌：不能照 v1 規則看「目前素材」（它可能不在序列裡）去 copy 它的聲音
        spec = dc_replace(spec, audio="none")
        mix_reasons = None
    enc_plan = EP.plan(spec, src_info, usable_encoders(gpu), mix_reasons=mix_reasons)
    if not seq_plan.has_audio_sources:
        enc_plan.notes.append("序列裡沒有任何音訊來源：不輸出音軌")
    if captions_sidecar:
        ctx.log("warn", "序列輸出還不支援另外輸出字幕檔（--captions-sidecar）：略過")
        enc_plan.notes.append("序列輸出還不支援另外輸出字幕檔：已略過 --captions-sidecar")

    # ---- --track 可以指到序列裡任何一支媒體的 track ----
    if track_ids:
        known = {t.id for m_id in order for t in contexts[m_id].tracks()}
        missing = [x for x in track_ids if x not in known]
        if missing:
            raise OpError("Invalid", f"序列用到的媒體裡沒有 track {missing}", f"有的：{sorted(known)}")

    # ---- 每支媒體的 job（整支素材的 k）----
    matte_root = Path(env.normalize_path(emit_matte)) if emit_matte else None
    faces_root = Path(env.normalize_path(emit_faces)) if emit_faces else None
    media: dict[str, SequenceMedia] = {}
    top_jobs: list[TrackJob] = []
    skipped: list[dict[str, str]] = []
    fx_tracks: list[Any] = []
    first_burner = None
    for m_id in order:
        mc = contexts[m_id]
        mine_ids = None if not track_ids else [x for x in track_ids if any(t.id == x for t in mc.tracks())]
        if mine_ids == []:
            jobs, sk = [], []  # --track 都指到別的媒體：select_tracks 給空清單會回傳全部，不能直接丟進去
            fxm = None
        else:
            jobs, sk = _build_jobs(mc, ctx, track_ids=mine_ids, session=session, seed=seed, rng=None)
            fxm = _effects_for_media(mc, ctx, mine_ids, None)
        comp = used[m_id]
        for ft in fxm.tracks if fxm is not None else ():
            ft.media_id = m_id
            ft.used_frames = len(ft.frames & comp)
            ft.absent_ks &= comp  # 只報序列用得到的缺席幀
            fx_tracks.append(ft)
        for j in jobs:
            j.media_id = m_id
            j.used_frames = len(j.frames & comp)
            if j.used_frames:
                top_jobs.append(j)
            else:
                skipped.append({"trackId": j.track.id, "mediaId": m_id, "reason": "不在序列使用範圍內"})
        skipped += [{**s, "mediaId": m_id} for s in sk]
        burner = _burner_for_media(mc, ctx, cap_mode, (W, H), fps)
        first_burner = first_burner or burner
        sub = RenderPlan(
            out=out_path, encode=enc_plan, width=W, height=H, fps=fps, n_frames=mc.n_frames, range=None, trim=False, jobs=jobs, skipped=sk,
            emit_matte=None if matte_root is None else matte_root / "media" / m_id,
            emit_faces=None if faces_root is None else faces_root / "media" / m_id,
            seed=int(seed), captions=burner, options=session.options, effects=fxm,
        )
        media[m_id] = SequenceMedia(m_id, mc, sub, comp)
    seq_plan.media = media

    # 會合成的序列幀：合成範圍 ∩ 寫出範圍內、片段啟用、而且那個 k 至少有一條 track 有解
    union = {m_id: set().union(*(j.frames for j in media[m_id].plan.jobs)) if media[m_id].plan.jobs else set() for m_id in order}
    n_comp = 0
    lo, hi = max(w_lo, c_lo), min(w_hi, c_hi)
    for p in SM.place_video(seq):
        it = p.item
        if not isinstance(it, SCH.VideoClipV2) or not it.enabled or it.media_id not in union:
            continue
        a, b = max(p.t0, lo), min(p.t1, hi)
        n_comp += sum(1 for t in range(a, b) if it.src_in + (t - p.t0) in union[it.media_id])
    if not top_jobs and first_burner is None and not any(t.skipped is None and t.used_frames for t in fx_tracks):
        ctx.log("warn", "序列用到的範圍裡沒有任何 track 可合成：輸出等於重新編碼的片段")
    from ..fx.tracks import EffectsPlan

    return RenderPlan(
        out=out_path, encode=enc_plan, width=W, height=H, fps=fps, n_frames=T, range=rng, trim=bool(trim and rng is not None),
        jobs=top_jobs, skipped=skipped, emit_matte=matte_root, emit_faces=faces_root, seed=int(seed),
        captions=first_burner, captions_track=None, captions_sidecar=None, overwrite_sidecar=bool(overwrite_sidecar),
        sequence=seq_plan, composite_count=n_comp, options=session.options, effects=EffectsPlan(fx_tracks) if fx_tracks else None,
    )


# ---------------------------------------------------------------- 逐幀合成


def frame_planes(fr: Any) -> Any:
    """解碼幀 → 合成器的 `_color.Yuv420`，**帶上這幀的色彩中繼資料**（matrix bt709|bt601、color_range tv|pc）。

    為什麼獨立成函式：以前這裡只傳三個平面，合成器一律用 BT.709 limited 的數學 —— BT.601 的 SD 來源新面色偏、
    full-range 來源被夾到 16..235（review 2026-09-17 finding 0；色彩組修了 _color／compositor／encode_plan，
    驗證者指出 render 這一行沒接上，整條路徑仍然錯）。沒有中繼資料的物件（測試替身）退回舊預設。
    """
    from ..comp import _color

    return _color.Yuv420(fr.y, fr.u, fr.v, getattr(fr, "matrix", "bt709") or "bt709", getattr(fr, "color_range", "tv") or "tv")


def composite_at(
    fr: "Yuv420", k: int, plan: RenderPlan, ctx: Ctx, emitted: list[tuple[Path, str, Path]] | None = None, emit_index: int | None = None,
) -> "Yuv420":
    """一幀：依序合成每條在 k 有解的 track。回傳新 Yuv420（沒動到任何 track 時回原物件）。

    emitted：給 render_frames 用——把這一幀寫出的 --emit-matte／--emit-faces PNG 記成 (root, trackId, path)，
    定格重複的 k 不再合成時才能照抄成 `<k>.png`，序列不缺號。
    emit_index：PNG 的檔名編號（None = k）。序列渲染傳序列幀 t，才能跟輸出片直接疊（設計 §7.2）。

    每條 job 依序：退化器決定（coarse／fade／hold 核心處理）→ `job.frame_params` → 印哪一面（`frame_face`）→
    可見遮罩與額外遮擋物（`frame_visibility`）→ `before_composite` → 合成器（加上 `composite_kwargs`）→ `after_composite`。
    外掛的 job 子類別覆寫那幾個掛勾；一般的 job 走預設（見 TrackJob）。"""
    from ..comp import _color
    from ..comp.compositor import composite_frame, rectify_frame
    from ..export import mattes

    from dataclasses import replace as dc_replace

    idx = k if emit_index is None else int(emit_index)

    def _matte(job: TrackJob, alpha: np.ndarray | None) -> None:
        assert plan.emit_matte is not None
        p = mattes.write_matte(plan.emit_matte, job.track.id, idx, alpha, (plan.width, plan.height))
        if emitted is not None:
            emitted.append((plan.emit_matte, job.track.id, p))

    planes = frame_planes(fr)
    touched = False
    mask_cache: dict[int, np.ndarray | None] = {}

    def mask_of(job: TrackJob) -> np.ndarray | None:
        key = id(job)
        if key not in mask_cache:
            mask_cache[key] = job.get_mask(k) if job.get_mask is not None else None
        return mask_cache[key]

    env = FrameEnv(int(k), plan, mask_of)
    for job in plan.jobs:
        if k not in job.frames:
            continue
        params = job.params
        H_prev, H_next = job.H_at(k - 1), job.H_at(k + 1)
        dec = None
        if job.degrader is not None and not params.is_hold:
            dec = job.degrader.resolve(k, planes)
            H = dec.H
            if dec.state == "coarse":
                H_prev, H_next = job.degrader.neighbour_H(k - 1), job.degrader.neighbour_H(k + 1)
            elif dec.state == "fade":
                H_prev = H_next = None
                params = dc_replace(params, comp=dc_replace(params.comp, opacity=params.comp.opacity * float(dec.opacity)))
            elif dec.state == "hold":
                job.held[dec.reason.split(" ")[0] or "hold"] += 1
                if plan.emit_matte is not None:
                    _matte(job, None)
                continue
            params, H_prev, H_next = job.frame_params(k, dec, params, H_prev, H_next)
        else:
            H = job.H_at(k)
        if H is None:
            job.lost += 1
            if plan.emit_matte is not None:
                _matte(job, None)
            continue
        face = job.frame_face(k, dec)
        if plan.emit_faces is not None:
            nw, nh = job.tmpl_new.size
            face_lin = rectify_frame(planes, H, (nw, nh), (nw // 2, nh // 2))
            fp = mattes.write_face(plan.emit_faces, job.track.id, idx, _color.linear_to_rgb8(face_lin))
            if emitted is not None:
                emitted.append((plan.emit_faces, job.track.id, fp))
        alpha_vis = None
        own_mask = mask_of(job)
        if own_mask is not None:
            alpha_vis = own_mask.astype(np.float32)
        alpha_vis, occluder = job.frame_visibility(k, dec, H, own_mask, alpha_vis, env)
        fsolve = job.solve.frames.get(k)
        # 退化路徑已經自己決定要不要合成（coarse／fade 幀的 conf 本來就低），合成器的 conf 閘門只在沒有 degrader 時生效
        conf = 1.0 if dec is not None else float(fsolve.conf if fsolve is not None else 0.0)
        job.before_composite(k, dec, H)
        res = composite_frame(
            planes, H, alpha_vis,
            None if job.tmpl_orig is None else job.tmpl_orig.rgb, face.tmpl.rgb,
            None if job.tmpl_orig is None else job.tmpl_orig.ink_mask, face.tmpl.ink_mask, face.paper,
            H_prev, H_next, params,
            barcode_mask=face.barcode, target=face.target, conf=conf, frame_index=int(k), seed=job.seed,
            shot_kind=job.shot.kind if job.shot.kind in ("close", "wide") else None,
            occluder=occluder, warp=None if dec is None else getattr(dec, "warp", None),
            **job.composite_kwargs(k, dec, face),
        )
        if res.stats.hold:
            job.held[res.stats.hold_reason.split(" ")[0] or "hold"] += 1
            if plan.emit_matte is not None:
                _matte(job, None)
            continue
        planes = res.out  # type: ignore[assignment]
        touched = True
        job.composited += 1
        job.after_composite(k, dec, face)
        if dec is not None and dec.state == "coarse":
            job.coarse += 1
        elif dec is not None and dec.state == "fade":
            job.faded += 1
        if plan.emit_matte is not None:
            _matte(job, res.alpha_full())
    if not touched:
        return fr
    return fr.with_planes(planes.y, planes.u, planes.v)


def render_frames(mctx: "MediaContext", plan: RenderPlan, ctx: Ctx) -> Iterator["Yuv420"]:
    """來源依 PTS 順序解一趟；每個 proxy 幀 k 產一幀；重複 k 重送同一份合成結果（每個來源幀只合成一次）。

    快取鍵是（來源幀, 每條 track 的「k 是否在 job.frames」）而不是只看來源幀：--range 的 K0／K1（或 shot／solve 邊界）
    落在定格中間時，同一來源幀在邊界兩側的 k 必須分開算——否則範圍內的 k 會重送範圍外那份沒合成的幀，範圍外的 k 反而帶著合成結果。
    重送快取結果時，--emit-matte／--emit-faces 也把該次寫出的 PNG 照抄成 `<k>.png`，依 proxy k 編號的序列才不缺號。
    整段走完之後呼叫外掛的 render-finish 掛勾（同一個 FrameSource；例：牌局外掛的掀牌幾何報告）。"""
    from .. import hooks
    from ..export import mattes
    from ..media.source import FrameSource

    k_lo, k_hi = plan.write_range
    with FrameSource(mctx.video, mctx.index, mctx.cfr, probe=mctx.probe, lru=4, ctx=ctx) as fs:
        last_key: tuple[int, tuple[bool, ...]] | None = None
        last_out = None
        last_emitted: list[tuple[Path, str, Path]] = []
        for k in range(k_lo, k_hi):
            ctx.check_cancel()
            src = mctx.cfr.src_index(k)
            key = (src, tuple(k in j.frames for j in plan.jobs))
            if key != last_key:
                fr = fs.get(src)  # 同一來源幀因邊界重算時走 FrameSource 的 LRU，不重解
                last_emitted = []
                last_out = composite_at(fr, k, plan, ctx, emitted=last_emitted)
                last_key = key
            else:
                for root, track_id, png in last_emitted:
                    mattes.copy_frame(png, root, track_id, k)
            assert last_out is not None
            # 特效（物件遮罩是逐 proxy 幀的）與字幕都在合成之後、逐 k 疊；兩者都回新平面、絕不改 last_out
            # （last_out 會被定格的下一個 k 重送，而遮罩／字幕狀態每個 k 都不同）。沒有作用時回同一個物件
            out = last_out if plan.effects is None else plan.effects.apply(last_out, k, ctx)
            yield plan.captions.apply(out, k) if plan.captions is not None else out
        for finish in hooks.render_finish():
            finish(mctx, plan, fs, ctx)


# ---------------------------------------------------------------- 序列逐幀（M2.7）


def _needs_planes(degrader: Any, k: int) -> bool:
    """退化器在 k 會不會走 coarse 路徑（要看這一幀的像素做紙面檢查）。只看這條 track 自己的狀態，跟同一幀的其他 track 無關。
    條件與 comp.fallback.Degrader.resolve 逐項對應：追蹤得到 → 不用；沒開 coarseFromMask 或從沒追蹤到過 → 不用。"""
    H = degrader.get_H(k)
    if H is not None and degrader.get_conf(k) >= degrader.hold_below:
        return False
    return bool(degrader.coarse_from_mask and degrader.last_good is not None)


class _MediaRenderer:
    """序列渲染裡一支媒體的解碼器＋合成狀態，負責讓「依來源 k 合成」與取幀順序無關（不變式 I2）。

    只渲染素材時（render_frames）k 由小到大走一趟，有兩件事隱含地依賴這個順序，序列跳著取 k（倒序片段、同一段用兩次）時要補回來：
    1. 定格：同一來源幀、每條 track 是否在 frames 都相同的連續 k，只在第一個 k 合成、其餘重送 → 這一段的輸出是用
       「第一個 k」的 H、遮罩與顆粒種子算的。`canonical(k)` 找出那個代表 k，序列一律用它合成。
    2. A4 退化器（comp/fallback.py）有狀態：最後一個好 H、參考面積、coarse 幾何快取，淡出幀的 opacity 取決於距離最後一個好 H 幾幀。
       `_advance` 在合成代表 k 之前，把「來源渲染在它之前會呼叫退化器的每個代表 k」照順序重播一次；往回跳時先歸零再從頭重播。
       追蹤得到的幀只更新狀態、不必解碼；會走 coarse 的幀要這一幀（含前面 track 已經合成上去的像素）做紙面檢查，
       只好真的解碼並完整合成一次（不寫 PNG、不計統計）。"""

    def __init__(self, sm: SequenceMedia, ctx: Ctx) -> None:
        from dataclasses import replace as dc_replace

        self.sm = sm
        self.plan = sm.plan
        self.ctx = ctx
        self.cfr = sm.mctx.cfr
        self.fs: Any = None
        self.pos = -1  # 退化器已經照來源渲染的順序處理到哪個 k（含）；-1 = 全新狀態
        self._canon: dict[int, int] = {}
        ks: set[int] = set()
        for j in self.plan.jobs:
            if j.degrader is not None and not j.params.is_hold:
                ks.update(j.frames)
        self._deg_ks = sorted(ks)
        # 重播用：同一批 TrackJob（退化器狀態要真的推進），但不寫 PNG
        self._replay_plan = dc_replace(self.plan, emit_matte=None, emit_faces=None)
        self.stats = {"replayed": 0, "replayComposites": 0, "resets": 0}

    def __enter__(self) -> "_MediaRenderer":
        from ..media.source import FrameSource

        m = self.sm.mctx
        self.fs = FrameSource(m.video, m.index, m.cfr, probe=m.probe, lru=4, ctx=self.ctx)
        return self

    def __exit__(self, *exc: Any) -> None:
        if self.fs is not None:
            self.fs.close()

    def src(self, k: int) -> int:
        return self.cfr.src_index(k)

    def _key(self, k: int) -> tuple[int, tuple[bool, ...]]:
        return (self.cfr.src_index(k), tuple(k in j.frames for j in self.plan.jobs))

    def canonical(self, k: int) -> int:
        """來源渲染實際合成 k 這一幀時用的 k（render_frames 的快取鍵往回找到這一段的第一個 k）。"""
        hit = self._canon.get(k)
        if hit is not None:
            return hit
        key = self._key(k)
        k0 = k
        while k0 > 0 and self._key(k0 - 1) == key:
            k0 -= 1
        for x in range(k0, k + 1):
            self._canon[x] = k0
        return k0

    def frame(self, k: int) -> "Yuv420":
        """不合成（--range 之外）：來源幀原樣。"""
        return self.fs.get(self.src(k))

    def composite(self, kc: int, *, emitted: list[tuple[Path, str, Path]], emit_index: int) -> "Yuv420":
        """合成代表 k（呼叫端保證 kc == canonical(kc)）。"""
        if kc <= self.pos:
            self._reset()
        self._advance(kc)
        out = composite_at(self.fs.get(self.src(kc)), kc, self.plan, self.ctx, emitted=emitted, emit_index=emit_index)
        self.pos = kc
        return out

    def _reset(self) -> None:
        from dataclasses import replace as dc_replace

        for j in self.plan.jobs:
            if j.degrader is not None:
                j.degrader = dc_replace(j.degrader, last_good=None, ref_area=None, _geo_cache={})
        self.pos = -1
        self.stats["resets"] += 1

    def _advance(self, until: int) -> None:
        i = bisect_right(self._deg_ks, self.pos)
        while i < len(self._deg_ks) and self._deg_ks[i] < until:
            k = self._deg_ks[i]
            i += 1
            if self.canonical(k) != k:
                continue  # 來源渲染在這個 k 重送前一格的結果，不會呼叫退化器
            self.ctx.check_cancel()
            active = [j for j in self.plan.jobs if j.degrader is not None and not j.params.is_hold and k in j.frames]
            if any(_needs_planes(j.degrader, k) for j in active):
                self._replay_composite(k)
            else:
                for j in active:
                    j.degrader.resolve(k, None)  # 追蹤得到／從沒追蹤到過／淡出／hold：都不看像素
            self.stats["replayed"] += 1
            self.pos = k

    def _replay_composite(self, k: int) -> None:
        saved = [(j.composited, Counter(j.held), j.lost, j.coarse, j.faded) for j in self.plan.jobs]
        composite_at(self.fs.get(self.src(k)), k, self._replay_plan, self.ctx)
        for j, (c, h, lo, co, fa) in zip(self.plan.jobs, saved):
            j.composited, j.held, j.lost, j.coarse, j.faded = c, h, lo, co, fa
        self.stats["replayComposites"] += 1


def _black_frame(plan: RenderPlan) -> "Yuv420":
    """空白與停用片段的黑幀：tv range Y16 U128 V128、pc range Y0（跟輸出標的 range 一致，否則黑色會被抬灰或壓掉）。"""
    from ..media.source import Yuv420

    ca = plan.encode.color_args
    rng = ca[ca.index("-color_range") + 1] if "-color_range" in ca else "tv"
    return Yuv420.blank(plan.width, plan.height, y=0 if rng == "pc" else 16, color_range=rng)


def render_sequence_frames(plan: RenderPlan, ctx: Ctx) -> Iterator["Yuv420"]:
    """序列幀 t → (媒體, 來源 k) → 合成（設計 §7.2）。每個 t 產一幀；空白／停用 → 黑幀；--range 之外 → 來源幀原樣（字幕照燒）。

    快取鍵是（媒體, 代表 k）：連續的 t 對到同一個代表 k（定格、或同一格用在相鄰位置）只合成一次，
    --emit-matte／--emit-faces 的 PNG 照抄成 `<t>.png`。片段內循序解碼；跨片段時 FrameSource 自己 seek 到 ≤ 目標的關鍵幀。"""
    from contextlib import ExitStack

    from ..export import mattes
    from ..sequence import model as SM

    sp = plan.sequence
    if sp is None or not sp.needs_render:
        raise OpError("Internal", "render_sequence_frames 需要序列渲染計畫")
    placed = SM.place_video(sp.seq)
    starts = [p.t0 for p in placed]
    w_lo, w_hi = plan.write_range
    c_lo, c_hi = plan.range if plan.range is not None else (0, plan.n_frames)
    black = _black_frame(plan)
    with ExitStack() as stack:
        renderers: dict[str, _MediaRenderer] = {}
        last_key: tuple[Any, ...] | None = None
        last_out: Any = None
        last_emitted: list[tuple[Path, str, Path]] = []
        for t in range(w_lo, w_hi):
            ctx.check_cancel()
            clip, k = SM.map_frame_placed(placed, t, starts)
            if clip is None or k is None:
                yield black
                continue
            r = renderers.get(clip.media_id)
            if r is None:
                sm = sp.media.get(clip.media_id)
                if sm is None:
                    raise OpError("Internal", f"序列計畫缺少媒體 {clip.media_id}（片段 {clip.id}）")
                r = renderers[clip.media_id] = stack.enter_context(_MediaRenderer(sm, ctx))
            composite = c_lo <= t < c_hi
            kc = r.canonical(k) if composite else k
            key = (clip.media_id, "comp", kc) if composite else (clip.media_id, "src", r.src(k))
            if key != last_key:
                last_emitted = []
                last_out = r.composite(kc, emitted=last_emitted, emit_index=t) if composite else r.frame(k)
                last_key = key
            else:
                for root, track_id, png in last_emitted:
                    mattes.copy_frame(png, root, track_id, t)
            burner = r.plan.captions
            # 特效與字幕都依來源 k（綁在素材上；特效只在合成範圍內，與來源渲染相同 → I2）；apply 不改 last_out，下一個 t 還會重送它
            out = r.plan.effects.apply(last_out, k, ctx) if (composite and r.plan.effects is not None) else last_out
            yield burner.apply(out, k) if burner is not None else out


def _reframed(frames: Any, plan: RenderPlan) -> Any:
    """合成完、進編碼器之前的最後一步：套自動重構圖的裁切。沒有就原樣放行。

    放在這裡而不是合成裡面的理由：裁切只是「留下哪一塊」，不該影響 H 矩陣、遮罩、
    字幕排版或空白幀的尺寸。包在最外層一層，前面所有東西都不必知道有這件事。
    """
    if plan.reframe is None:
        return frames
    from ..reframe.apply import crop_frames

    return crop_frames(frames, plan.reframe.rects)


def _run_sequence_render(plan: RenderPlan, ctx: Ctx) -> dict[str, Any]:
    from ..media import encoder as EN

    sp = plan.sequence
    assert sp is not None
    t0 = time.perf_counter()
    graph = sp.graph if plan.encode.audio_mode == "mix" else None
    ow, oh = plan.out_size
    try:
        info = EN.write_frames(
            _reframed(render_sequence_frames(plan, ctx), plan), plan.encode, plan.out, ctx,
            width=ow, height=oh, fps=plan.fps, total=plan.n_write, stage="render", audio_graph=graph,
        )
    finally:
        for sm in sp.media.values():
            close_jobs(sm.plan)
    ctx.artifact(str(plan.out), "render")
    dt = time.perf_counter() - t0
    res = {
        "out": str(plan.out),
        "frames": info["frames"],
        "bytes": info["bytes"],
        "seconds": round(dt, 3),
        "fps": round(info["frames"] / dt, 2) if dt > 0 else None,
        "encoder": plan.encode.video_codec,
        "audio": {"mode": plan.encode.audio_mode, "codec": plan.encode.audio_codec, "samples": graph.total_samples if graph is not None else None},
        "dropped": plan.encode.dropped,
        "notes": plan.encode.notes,
        "outTimeUs": info.get("out_time_us", 0),
        "tracks": [j.to_json() for j in plan.jobs],
        "skipped": plan.skipped,
        "range": None if plan.range is None else list(plan.range),
        "trim": plan.trim,
        "captions": None if plan.captions is None else plan.captions.to_json(),
        "captionsSidecar": None,
        "sequence": sp.sequence_json(),
    }
    if plan.effects is not None:
        res["effects"] = plan.effects.to_json()
    return res


def close_jobs(plan: RenderPlan) -> None:
    """渲染結束（含失敗、取消）：關掉 job 自己開的東西（例：replace 影片素材的解碼器）。沒有 close 的 job 不理。"""
    for j in plan.jobs:
        close = getattr(j, "close", None)
        if close is not None:
            try:
                close()
            except Exception:  # noqa: BLE001  收尾不能蓋掉原本的錯誤
                pass


def run_render(mctx: "MediaContext", plan: RenderPlan, ctx: Ctx) -> dict[str, Any]:
    from ..media import encoder as EN

    blocked = plan.sidecar_blocked()
    if blocked is not None:
        # 編碼前就擋：影片編完才發現字幕檔寫不了，使用者得整個重跑
        raise OpError("Invalid", f"字幕檔 {blocked} 已存在，不覆寫", "加 --overwrite-sidecar 覆寫，或換一個輸出檔名")
    if plan.sequence is not None and plan.sequence.needs_render:
        return _run_sequence_render(plan, ctx)
    t0 = time.perf_counter()
    audio_in: list[str] = []
    if plan.trim and plan.range is not None:
        num, den = plan.fps
        k0, k1 = plan.range
        audio_in = ["-ss", f"{k0 * den / num:.6f}", "-t", f"{(k1 - k0) * den / num:.6f}"]
    ow, oh = plan.out_size
    try:
        info = EN.write_frames(
            _reframed(render_frames(mctx, plan, ctx), plan), plan.encode, plan.out, ctx,
            width=ow, height=oh, fps=plan.fps, total=plan.n_write,
            audio_source=mctx.video, stage="render", audio_input_args=audio_in,
        )
    finally:
        close_jobs(plan)
    ctx.artifact(str(plan.out), "render")
    sidecar = write_sidecar(plan, ctx)
    dt = time.perf_counter() - t0
    res = {
        "out": str(plan.out),
        "frames": info["frames"],
        "bytes": info["bytes"],
        "seconds": round(dt, 3),
        "fps": round(info["frames"] / dt, 2) if dt > 0 else None,
        "encoder": plan.encode.video_codec,
        "audio": {"mode": plan.encode.audio_mode, "codec": plan.encode.audio_codec},
        "dropped": plan.encode.dropped,
        "notes": plan.encode.notes,
        "outTimeUs": info.get("out_time_us", 0),
        "tracks": [j.to_json() for j in plan.jobs],
        "skipped": plan.skipped,
        "range": None if plan.range is None else list(plan.range),
        "trim": plan.trim,
        "captions": None if plan.captions is None else plan.captions.to_json(),
        "captionsSidecar": sidecar,
    }
    if plan.effects is not None:
        res["effects"] = plan.effects.to_json()
    return res


def write_sidecar(plan: RenderPlan, ctx: Ctx) -> str | None:
    """編碼完才寫字幕檔（.part → rename）：影片失敗／取消時不會留下對不上的字幕檔。--trim 時時間減去 K0，跟成品對齊。"""
    path = plan.sidecar_path()
    if path is None or plan.captions_track is None:
        return None
    from ..captions.export import export_text, write_text

    if plan.sidecar_blocked() is not None:
        # 編碼期間才冒出來的同名檔（其他程式寫的）：影片已經好了，不為了字幕檔讓整個 op 失敗，警告並略過
        ctx.log("warn", f"字幕檔 {path} 在編碼期間被建立，不覆寫（加 --overwrite-sidecar 可覆寫）")
        return None
    # 沒 --trim 時成品仍是全長 → 字幕檔也全長；--trim 才裁到範圍並平移
    rng = plan.range if plan.trim else None
    text = export_text(plan.captions_track, str(plan.captions_sidecar), plan.fps, plan.width, plan.height, range_frames=rng, trim=bool(rng))
    write_text(path, text)
    ctx.artifact(str(path), f"captions.{plan.captions_sidecar}")
    return str(path)


def load_reframe(spec: str, plan: RenderPlan, ctx: Ctx) -> Any:
    """讀 `*.reframe.json` 並對齊到這次要寫出的幀。

    ## 為什麼要對齊而不是照順序套

    路徑是規劃時對著某個範圍算的，渲染時可能只出其中一段（`--range … --trim`）。
    照順序套會整體偏移，而偏移的症狀是「鏡頭慢半拍」—— 看得出怪但很難指出原因。
    所以：幀數剛好相等就直接用；否則用路徑檔裡記的規劃範圍把索引換算回來；
    換算不出來就**報錯**，不要猜。猜錯的成本是整支重新編碼。
    """
    from ..reframe.doc import from_doc
    from ..reframe.path import ReframeError

    path_file = Path(env.normalize_path(spec))
    if not path_file.is_file():
        raise OpError("Io", f"找不到重構圖路徑檔 {path_file}", hint="先跑 aivc reframe <影片> 產生")
    try:
        doc = json.loads(path_file.read_text(encoding="utf-8"))
        rf = from_doc(doc)
    except json.JSONDecodeError as e:
        raise OpError("Invalid", f"重構圖路徑檔不是合法 JSON：{e}") from e
    except ReframeError as e:
        raise OpError("Invalid", str(e)) from e

    sw, sh = rf.source
    if (sw, sh) != (plan.width, plan.height):
        raise OpError(
            "Invalid",
            f"重構圖路徑是對 {sw}×{sh} 規劃的，這次要渲染的是 {plan.width}×{plan.height}",
            hint="對同一支（通常是 proxy）重新規劃一次",
        )
    k0, k1 = plan.write_range
    n_write = k1 - k0
    meta = doc.get("meta") or {}
    rng = meta.get("range")
    seq = getattr(plan, "sequence", None)
    if seq is not None and getattr(seq, "needs_render", False):
        # 序列渲染寫出的是**序列幀 t**，而路徑是對某支素材的 **proxy 幀 k** 規劃的 —— 兩套幀號無關。
        # 長度碰巧相等時照 meta.range 去切就會安靜地套錯段，所以這裡只認「幀數剛好等於序列長度」，
        # 其餘一律擋下。要對序列做重構圖，得先把序列輸出成一支影片再規劃（見 plugins/cards/docs/progress.md）。
        if len(rf.rects) != n_write:
            raise OpError(
                "Invalid",
                f"序列輸出有 {n_write} 幀，重構圖路徑有 {len(rf.rects)} 幀",
                hint="序列的幀號與素材的 proxy 幀號無關：先把序列輸出成一支影片，再對那支跑 aivc reframe",
            )
        return rf
    # 路徑檔記了規劃範圍就**一律**以它為準。不可以先比幀數就放行：
    # 對 [0,100) 規劃、渲染 [50,150) 時兩邊都是 100 幀，比幀數會直接通過，
    # 結果是整條鏡頭偏移 50 幀 —— 這正是這支函式存在的理由。
    if isinstance(rng, (list, tuple)) and len(rng) == 2 and int(rng[1]) - int(rng[0]) == len(rf.rects):
        p0, p1 = int(rng[0]), int(rng[1])
        if p0 <= k0 and k1 <= p1:
            a = k0 - p0
            return replace(rf, rects=rf.rects[a : a + n_write])
        raise OpError(
            "Invalid",
            f"重構圖路徑規劃的是幀 [{p0},{p1})，這次要寫的是 [{k0},{k1})",
            hint="用同樣的 --range 重新跑一次 aivc reframe，或規劃整支影片",
        )
    if len(rf.rects) == n_write:
        return rf
    raise OpError(
        "Invalid",
        f"重構圖路徑有 {len(rf.rects)} 幀，這次要寫 {n_write} 幀（{k0}:{k1}），而且路徑檔沒記可用的規劃範圍",
        hint="用同樣的 --range 重新跑一次 aivc reframe，或規劃整支影片",
    )


def _plan_from_args(args: dict[str, Any], ctx: Ctx) -> tuple["MediaContext", RenderPlan]:
    from ..project import resolve as R

    mctx = R.open_media_context(env.normalize_path(str(args["project"])), args.get("media"), ctx)
    plan = build_plan(
        mctx, ctx, out=str(args["out"]), codec=args.get("codec"), quality=args.get("quality"), audio=args.get("audio"),
        gpu=not args.get("no_gpu"), range_spec=args.get("range"), trim=bool(args.get("trim")), track_ids=args.get("track"),
        seed=int(args.get("seed") or 0), emit_matte=args.get("emit_matte"), emit_faces=args.get("emit_faces"),
        captions=args.get("captions") or "auto", captions_sidecar=args.get("captions_sidecar"), overwrite_sidecar=bool(args.get("overwrite_sidecar")),
        # CLI --source；App 走 sidecar 時傳 sequence: "auto" | "ignore"（設計 §7.6）
        sequence="ignore" if args.get("source") else (args.get("sequence") or "auto"),
        # 外掛旗標（hooks op-args 加的，例如牌組目錄）原樣交給插入來源
        op_args=dict(args),
    )
    if args.get("reframe"):
        plan.reframe = load_reframe(str(args["reframe"]), plan, ctx)
        if plan.captions is not None:
            # 字幕是照合成尺寸排版、在裁切之前燒進去的，所以直幅裁切會把左右兩側的字切掉。
            # 這不是可以在這裡修好的事（要重排字幕），但一定要講，不然使用者會以為是字幕壞了。
            ctx.log("warn", "同時燒字幕與自動重構圖：字幕是照原尺寸排版再被裁，兩側可能被切掉；考慮 --captions off 改用側車字幕")
    return mctx, plan


def _plan_human(plan: RenderPlan) -> str:
    e = plan.encode
    lines = [
        f"輸出        {plan.out}  ({e.container}/{e.video_codec} {' '.join(e.video_args)}；音訊 {e.audio_mode}:{e.audio_codec}）",
        f"幀          total={plan.n_frames} write={plan.n_write} composite={plan.n_composite}  range={plan.range} trim={plan.trim}  {plan.width}x{plan.height} @ {plan.fps[0]}/{plan.fps[1]}",
    ]
    if plan.reframe is not None:
        rf = plan.reframe
        lines.append(f"  重構圖  {plan.width}x{plan.height} → {rf.size[0]}x{rf.size[1]}  {len(rf.cuts)} 個切點  漏偵測 {rf.missing} 幀")
    for j in plan.jobs:
        where = f" @{j.media_id}" if j.media_id is not None else ""
        n = j.used_frames if j.media_id is not None else len(j.frames)
        lines.append(f"  track {j.track.id:<18} {j.slot.name:<9} {str(j.original):<5} → {j.target_code:<5} rot={j.rotation:<3} {j.shot.id}/{j.shot.kind}{where} frames={n} masks={'yes' if j.get_mask else 'no'} {j.params.macro}/{j.params.region_policy}")
        rp = j.ext_json().get("replace")
        if isinstance(rp, dict):
            src = rp.get("source") or {}
            more = f" 素材 {src.get('frames')} 幀 @ {'/'.join(map(str, src.get('fps') or [])) or '-'}" if rp.get("kind") == "video" else ""
            lines.append(f"    replace {rp.get('kind')} {rp.get('path')}  fit={rp.get('fit')} offset={rp.get('offsetFrames')} loop={rp.get('loop')}{more}" + (f"  stop 略過 {rp.get('stopped')} 幀" if rp.get("stopped") else ""))
    if plan.effects is not None:
        for ft in plan.effects.tracks:
            where = f" @{ft.media_id}" if ft.media_id is not None else ""
            n = ft.used_frames if ft.media_id is not None else len(ft.frames)
            effs = "、".join(f"{e.type}{'' if e.status == 'ok' else '（' + ('停用' if e.status == 'disabled' else '不合法') + '）'}" for e in ft.entries) or "無"
            state = f"skip：{ft.skipped}" if ft.skipped else f"frames={n} footprint={ft.footprint}"
            lines.append(f"  特效 {ft.track_id:<18} {ft.kind:<6}{where} {effs}  {state}")
    if plan.captions is not None:
        c = plan.captions.to_json()
        lines.append(f"  字幕  {c['preset']} {c['cues']} 則 / {c['frames']} 幀  字型 {c['font']['path'] or c['font']['family']}" + "".join(f"  [{w.get('kind')}{' ' + str(w.get('cueId')) if w.get('cueId') else ''}]" for w in c["warnings"]))
    if plan.sidecar_path() is not None:
        lines.append(f"  字幕檔 {plan.sidecar_path()}")
    sp = plan.sequence
    if sp is not None:
        sj = sp.sequence_json()
        lines.append(
            f"序列        {sj['id']}  {sj['frames']} 幀（{sj['duration']}）  片段 {sj['clips']}／空白 {sj['gaps']}／停用 {sj['disabled']}／音訊 {sj['audioClips']}"
            + ("  未修改 → 原路徑" if sp.untouched else f"  range={sp.range} trim={sp.trim}")
        )
        g = sp.graph
        if g is not None and e.audio_mode == "mix":
            peak = "未知" if g.peak_estimate_dbfs is None else f"{g.peak_estimate_dbfs:+.1f} dBFS"
            lines.append(f"音訊混音    {len(g.chains)} 路 → {g.total_samples} 樣本  {e.audio_codec}  stem {len(g.stems)}  估計峰值 {peak}  原因：{'、'.join(sp.reasons)}")
            for n in g.notes:
                lines.append(f"  note  {n}")
    for s in plan.skipped:
        lines.append(f"  skip  {s['trackId']:<18} {s['reason']}")
    for n in e.notes:
        lines.append(f"  note  {n}")
    for d in e.dropped:
        lines.append(f"  drop  {d}")
    return "\n".join(lines)


@register("render.plan", cli="render-plan", help=_HELP_PLAN, args=_common_args)
def render_plan_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    _mctx, plan = _plan_from_args(args, ctx)
    d = plan.to_json()
    d["_human"] = _plan_human(plan)
    return d


@register("render.run", cli="render", help=_HELP_RUN, args=_run_args)
def render_op(args: dict[str, Any], ctx: Ctx) -> dict[str, Any]:
    mctx, plan = _plan_from_args(args, ctx)
    if args.get("dry_run"):
        d = plan.to_json()
        d["dryRun"] = True
        d["_human"] = _plan_human(plan)
        return d
    ctx.log("info", _plan_human(plan))
    res = run_render(mctx, plan, ctx)
    res["plan"] = plan.to_json()
    held = sum(sum(j.held.values()) for j in plan.jobs)
    res["_human"] = (
        f"{res['frames']} 幀 → {plan.out}（{res['bytes'] / 1e6:.1f} MB，{res['seconds']}s，{res['fps']} fps；{plan.encode.video_codec}，音訊 {plan.encode.audio_mode}）\n"
        + "\n".join(f"  track {j.track.id:<18} composited={j.composited}（coarse={j.coarse} fade={j.faded}） held={dict(j.held)} lost={j.lost}" for j in plan.jobs)
        + (f"\n  hold 合計 {held} 幀" if held else "")
        + "".join(
            f"\n  特效 {ft.track_id:<18} applied={ft.applied} absent={ft.absent}" + (f"（skip：{ft.skipped}）" if ft.skipped else "")
            for ft in (plan.effects.tracks if plan.effects is not None else ())
        )
    )
    return res
