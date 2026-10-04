"""專案檔 `*.aivc.json` schema v2 的 Python 鏡像（計畫 §5.6；v2 序列與音訊見 docs/editor-m2-design.md §3.3、§3.5、§4）。

**TS `src/project/format.ts` 是 SoT**；這裡只是讀寫同一份 camelCase JSON。原則：
- 磁碟上的 key 一字不差（camelCase）；dataclass 欄位用 snake_case，靠每個類別自己的 to_json/from_json 對映。
- **不認識的 key 一律保留**（`extra`）再寫回：TS 加了新欄位、Python 舊版存檔不能把它們弄丟。
  專案檔頂層、track、track.options 這三層的未知鍵還記得原本的位置（`Extra`），寫回時放回原位；
  外掛可以認領某些鍵（`hooks.SchemaField`，例：牌局外掛的 cardSlots／deck／slotId／templateCard），由外掛解析、寫在登記的位置。
- 載入時 sanitize：丟掉並回報（不是擲錯）——非有限幀號、非凸 quad、壞 label、未知目標牌、重疊的音訊片段；
  只有 schemaVersion > 2 才拒絕。
- 未指定的預設值鏡射計畫 §6.6 插入參數表；`insert: null` 的欄位在合成時繼承 `insertDefaults`（`resolve_insert`）。
- **最低版本寫檔**（設計 §4.3）：沒用到 v2 功能（`sequence is None` 且 `audio_media` 空）就寫 `schemaVersion: 1`
  並省略那兩個鍵——App 每 2 秒自動存檔，沒有這條規則，用新版打開舊專案什麼都沒剪也會被悄悄升版，退回 v0.0.6 就打不開。
"""
from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from .. import atomic
from ..ops import OpError

SCHEMA_VERSION = 2
APP_NAME = "ai-video-cut"

# ---- schema v2：序列與音訊（設計 §3.2；數值與 TS format.ts 同名常數一致）----
SEQ_SAMPLE_RATE = 48_000
FADE_CURVES = ("linear", "equalPower")
AUDIO_ROLES = ("music", "voiceover", "sfx", "other")
AUDIO_SOURCE_TYPES = ("media", "audio")
GAIN_DB_MIN, GAIN_DB_MAX = -96.0, 12.0
# 片段邊緣自動的防爆音淡化（ms）；使用者的淡入淡出比它長就不另外加
DEFAULT_EDGE_DECLICK_MS = 3.0
# ≤ 這個 dB 視為 −∞（靜音）
SILENCE_DB = -90.0
# srcIn 可為負（前面補靜音），但超過 10 秒的負值只可能是壞資料
MAX_NEGATIVE_SRC_IN_SECONDS = 10

SHOT_KINDS = ("close", "wide", "unknown")
SHOT_SOURCES = ("auto", "user")
KEYFRAME_SOURCES = ("user", "detector")
TRACK_METHODS = ("classic", "dense")
MOTION_MODELS = ("translation", "similarity", "affine", "perspective")
REGION_POLICIES = ("full", "keepBarcode", "hold")
INSERT_MACROS = ("conservative", "standard", "full", "custom")
# 磁碟上的 profile 列舉（TS format.ts 同名常數）：值本身是檔案格式的一部分，開源版也照樣讀寫、不改值
PROFILES = ("cards", "generic")
# 通用物件（docs/tracking-api.md「專案檔」一節）：track.kind 除了 planar 還有 object；都是可省略的鍵、不升 schemaVersion
TRACK_KIND_OBJECT = "object"
OBJECT_SOURCE_TYPES = ("text", "select", "ai")
REPLACE_KINDS = ("image", "video")
REPLACE_FITS = ("stretch", "contain", "cover")
REPLACE_LOOPS = ("loop", "hold", "stop")
# 特效物件裡由專案檔管的鍵；其餘的鍵原樣交給 aivc.fx.params.parse_effect
EFFECT_META_KEYS = ("id", "enabled")
_HEX_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")

Warn = Callable[[str], None]


# ---------------------------------------------------------------- 小工具


def _is_finite_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _int(v: Any) -> int | None:
    """有限且為整數值的數字 → int；其他 None。"""
    if isinstance(v, bool) or not _is_finite_number(v):
        return None
    f = float(v)
    return int(f) if f == int(f) else None


def _num(v: Any, default: float | None = None) -> float | None:
    return float(v) if _is_finite_number(v) else default


def _bool(v: Any, default: bool) -> bool:
    return v if isinstance(v, bool) else default


def _enum(v: Any, allowed: Iterable[str], default: str | None, warn: Warn, what: str) -> str | None:
    allowed = tuple(allowed)
    if isinstance(v, str) and v in allowed:
        return v
    if v is not None or default is None:
        warn(f"{what}={v!r} 不在 {allowed}，改用 {default!r}")
    return default


def _str(v: Any, default: str = "") -> str:
    return v if isinstance(v, str) else default


def _point(v: Any) -> list[float] | None:
    if isinstance(v, (list, tuple)) and len(v) == 2 and all(_is_finite_number(x) for x in v):
        return [float(v[0]), float(v[1])]
    return None


def _convex4(pts: list[list[float]]) -> bool:
    sign = 0
    for i in range(4):
        ax, ay = pts[(i + 1) % 4][0] - pts[i][0], pts[(i + 1) % 4][1] - pts[i][1]
        bx, by = pts[(i + 2) % 4][0] - pts[(i + 1) % 4][0], pts[(i + 2) % 4][1] - pts[(i + 1) % 4][1]
        cross = ax * by - ay * bx
        if abs(cross) < 1e-9:
            return False
        s = 1 if cross > 0 else -1
        if sign == 0:
            sign = s
        elif s != sign:
            return False
    return sign != 0


def _rest(d: dict[str, Any], known: Iterable[str]) -> dict[str, Any]:
    k = set(known)
    return {key: v for key, v in d.items() if key not in k}


def now_iso() -> str:
    """JS `new Date().toISOString()` 同款：`2026-09-16T12:34:56.789Z`。"""
    dt = datetime.now(timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


# ---------------------------------------------------------------- 外掛欄位（hooks.SchemaField）
#
# 核心不認得的鍵一律留在 `extra` 原樣寫回（上面第 5 條）；外掛登記 `hooks.SchemaField` 認領某些鍵之後，
# 由外掛解析／正規化，值放在物件的 `ext`，寫檔時接在登記的核心鍵後面（與外掛化之前同一個位置）。
# `obj.<attr>` 讀寫都轉到 `obj.ext[attr]`；建構子也收外掛欄位的關鍵字參數。
# 沒有外掛時那些屬性不存在（AttributeError）——核心程式本來就不該用到它們。
# 兩個 dict 別搞混：`extra`＝沒人認得的鍵（原樣保存）；`ext`＝外掛解析過的欄位。


def _ext_fields(owner_type: str) -> list[Any]:
    from .. import hooks

    return hooks.schema_fields(owner_type)


class _ExtAttrs:
    """`obj.<attr>` ↔ `obj.ext[attr]`（attr 是某個 SchemaField 的 attr）。子類別設 `_EXT_OWNER`。"""

    _EXT_OWNER = ""

    def __getattr__(self, name: str) -> Any:
        # 只在一般屬性找不到時才進來；雙底線名稱一律不碰（copy／pickle 會來問）
        if name.startswith("__") or name == "ext":
            raise AttributeError(name)
        ext = self.__dict__.get("ext")
        if ext is not None:
            if name in ext:
                return ext[name]
            for f in _ext_fields(self._EXT_OWNER):
                if f.attr == name:  # 外掛比物件晚載入：補預設值
                    ext[name] = f.default()
                    return ext[name]
        raise AttributeError(f"{type(self).__name__} 沒有屬性 {name!r}")

    def __setattr__(self, name: str, value: Any) -> None:
        if name not in type(self).__dataclass_fields__ and not name.startswith("_") and any(f.attr == name for f in _ext_fields(self._EXT_OWNER)):  # type: ignore[attr-defined]
            self.__dict__.setdefault("ext", {})[name] = value
            return
        object.__setattr__(self, name, value)


def _accept_ext_kwargs(cls: Any) -> Any:
    """包住 dataclass 生成的 __init__：多收外掛欄位的關鍵字參數（例：外掛登記了 attr="foo" → `TrackV1(..., foo=…)`），其餘照舊。"""
    gen = cls.__init__

    def __init__(self: Any, *args: Any, **kwargs: Any) -> None:
        known_fields = cls.__dataclass_fields__
        ext_kw = {k: kwargs.pop(k) for k in [k for k in kwargs if k not in known_fields]}
        gen(self, *args, **kwargs)
        # dataclasses.replace 會把舊物件的 ext 原樣傳進來：複製一份，兩個物件不共用同一個 dict
        ext = dict(self.__dict__.get("ext") or {})
        regs = _ext_fields(cls._EXT_OWNER)
        attrs = {f.attr for f in regs}
        for k, v in ext_kw.items():
            if k not in attrs:
                raise TypeError(f"{cls.__name__}.__init__() got an unexpected keyword argument {k!r}")
            ext[k] = v
        for f in regs:
            if f.attr not in ext:
                ext[f.attr] = f.default()
        object.__setattr__(self, "ext", ext)

    __init__.__doc__ = gen.__doc__
    cls.__init__ = __init__
    return cls


def _parse_ext(owner_type: str, d: dict[str, Any], warn: "Warn", env: Any, phase: str | None = None) -> dict[str, Any]:
    """依登記順序解析外掛欄位 → {attr: 值}。phase 只對 project 有意義（early／late）。"""
    out: dict[str, Any] = {}
    for f in _ext_fields(owner_type):
        if phase is not None and f.phase != phase:
            continue
        out[f.attr] = f.parse(d.get(f.key), f.key in d, warn, env)
    return out


def _ext_keys(owner_type: str) -> tuple[str, ...]:
    return tuple(f.key for f in _ext_fields(owner_type))


class Extra(dict):
    """`extra`（沒人認得的鍵）＋每個鍵在原檔裡的位置：`anchors[k]` ＝ 原檔裡排在 k 前面的鍵（由近到遠）。

    為什麼要記位置：開源版沒有外掛，外掛的鍵（例：TS 寫在 tracks 後面的頂層區段、track 的 kind 後面的鍵）對核心來說是未知鍵；
    寫回時如果一律丟到最後，值沒變、鍵序卻變了 —— App 每 2 秒自動存檔，同一份專案在兩個版本之間開來開去，diff 就永遠不乾淨。
    記住「它原本接在誰後面」，寫回時放回去：沒改過的檔案讀進寫出逐位元相同。程式自己加的鍵沒有位置 → 照舊接在最後。
    只在「這一層沒有外掛認領鍵」時才用（見 `_emit`）；有外掛時照外掛化之前的規則，未知鍵殿後。
    它就是 dict（比較、json.dumps、deepcopy 都照舊）；`dict(extra)` 會丟掉位置（退回接在最後），不影響內容。"""

    anchors: dict[str, tuple[str, ...]]

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.anchors = {}


def _rest_anchored(d: dict[str, Any], known: Iterable[str]) -> Extra:
    """同 `_rest`，另外記下每個未知鍵在原檔裡前面是哪些鍵（見 Extra）。"""
    k = set(known)
    out = Extra()
    keys = list(d)
    for i, key in enumerate(keys):
        if key in k:
            continue
        out[key] = d[key]
        out.anchors[key] = tuple(reversed(keys[:i]))
    return out


def _emit(core: list[tuple[str, Any]], owner_type: str, ext: dict[str, Any], extra: dict[str, Any] | None = None) -> dict[str, Any]:
    """核心鍵依序寫，外掛欄位接在各自的 after 後面（同一個 after 依登記順序），最後放 extra：
    - 這一層有外掛認領的鍵 → extra 全部殿後（外掛定義了版面；TS 的規則也是 extra 殿後；與外掛化之前的引擎逐位元相同）；
    - 沒有（開源版、或外掛沒裝）→ 有原檔位置的（Extra.anchors）接回原本前面那個鍵後面（那個鍵這次沒寫出來就再往前找），
      其餘接在最後。外掛的鍵在沒裝外掛時就是這種「不知道該放哪」的未知鍵：留在原位，檔案讀進寫出才逐位元相同。"""
    fields_ = _ext_fields(owner_type)
    out: dict[str, Any] = {}
    placed: set[str] = set()

    def put(f: Any) -> None:
        placed.add(f.attr)
        include, value = f.dump(ext[f.attr] if f.attr in ext else f.default())
        if include:
            out[f.key] = value

    def place_after(key: str) -> None:
        # after 可以是核心鍵，也可以是另一個外掛欄位的鍵（鏈起來）；同一個 after 依登記順序
        for f in fields_:
            if f.after == key and f.attr not in placed:
                put(f)
                place_after(f.key)

    for key, val in core:
        out[key] = val
        place_after(key)
    for f in fields_:  # 錨點鍵這次沒寫出來（不該發生）：接在最後，至少不丟資料
        if f.attr not in placed:
            put(f)
    if not extra:
        return out
    if fields_:
        # 這一層有外掛認領鍵：外掛定義了正規的版面，其餘未知鍵照 TS 規則殿後（與外掛化之前的引擎逐位元相同）
        out.update(extra)
        return out
    anchors: dict[str, tuple[str, ...]] = getattr(extra, "anchors", None) or {}
    order = list(out)
    for k, v in extra.items():
        if k in out:
            continue  # 不會發生（_rest 已排除核心鍵）；萬一有，核心的值優先
        pos = len(order)
        for a in anchors.get(k, ()):
            if a in out:
                pos = order.index(a) + 1
                break
        order.insert(pos, k)
        out[k] = v
    return {k: out[k] for k in order}


@dataclass
class TrackParseEnv:
    """track／track.options 的外掛欄位解析看得到的東西。"""

    where: str  # "track <id>"（警告字句的前綴）
    max_frame: int | None


@dataclass
class ProjectParseEnv:
    """頂層外掛欄位解析與交叉檢查（hooks track-check）看得到的東西。ext＝已經解析好的外掛欄位（early 先、late 後）。"""

    media_ids: set[str]
    max_frames: dict[str, int | None]
    shots: dict[str, list["ShotV1"]]
    tracks: dict[str, list["TrackV1"]]
    ext: dict[str, Any]
    per_media: Callable[[Any, str, Callable[[Any, int | None], Any]], dict[str, list[Any]]]


# ---------------------------------------------------------------- 基本型


@dataclass
class Rational:
    num: int
    den: int

    def to_json(self) -> dict[str, int]:
        return {"num": self.num, "den": self.den}

    @classmethod
    def from_json(cls, d: Any) -> "Rational | None":
        if not isinstance(d, dict):
            return None
        num, den = _int(d.get("num")), _int(d.get("den"))
        if num is None or den is None or den == 0:
            return None
        return cls(num, den)

    @property
    def value(self) -> float:
        return self.num / self.den


@dataclass
class Quad:
    """來源像素座標的凸四邊形，TL,TR,BR,BL。"""

    p: list[list[float]]

    def to_json(self) -> dict[str, Any]:
        return {"p": [[float(x), float(y)] for x, y in self.p]}

    @classmethod
    def from_json(cls, d: Any) -> "Quad | None":
        pts = d.get("p") if isinstance(d, dict) else d
        if not isinstance(pts, (list, tuple)) or len(pts) != 4:
            return None
        out = [_point(pt) for pt in pts]
        if any(pt is None for pt in out):
            return None
        pts4 = [pt for pt in out if pt is not None]
        if not _convex4(pts4):
            return None
        return cls(pts4)

    @classmethod
    def from_points(cls, pts: Iterable[Iterable[float]]) -> "Quad":
        q = cls([[float(x), float(y)] for x, y in pts])
        if len(q.p) != 4 or not _convex4(q.p):
            raise ValueError("quad 必須是 4 個點的凸四邊形")
        return q


# ---------------------------------------------------------------- media / shots


@dataclass
class ProxyMetaV1:
    fps: Rational
    frames: int
    width: int
    height: int
    scale: float = 1.0
    version: int = 1
    extra: dict[str, Any] = field(default_factory=dict)

    _KEYS = ("fps", "frames", "width", "height", "scale", "version")

    def to_json(self) -> dict[str, Any]:
        return {"fps": self.fps.to_json(), "frames": self.frames, "width": self.width, "height": self.height, "scale": self.scale, "version": self.version, **self.extra}

    @classmethod
    def from_json(cls, d: Any, warn: Warn) -> "ProxyMetaV1 | None":
        if not isinstance(d, dict):
            return None
        fps = Rational.from_json(d.get("fps"))
        frames, width, height = _int(d.get("frames")), _int(d.get("width")), _int(d.get("height"))
        if fps is None or frames is None or width is None or height is None:
            warn("media.proxy 欄位不完整，視為沒有 proxy")
            return None
        return cls(fps, frames, width, height, _num(d.get("scale"), 1.0) or 1.0, _int(d.get("version")) or 1, _rest(d, cls._KEYS))


@dataclass
class MediaV1:
    """`ProjectMediaV2 = ProjectMediaV1 & { audio?: AudioInfoV2 | null }`：類別名沿用 V1，舊 import 不必改。"""

    id: str
    path: str
    name: str = ""
    fingerprint: str = ""
    probe: dict[str, Any] | None = None  # Rust MediaProbe，這裡不解析
    proxy: ProxyMetaV1 | None = None
    extra: dict[str, Any] = field(default_factory=dict)
    # 衍生的音訊時間資訊（audio.v1.json 摘要）；不進 undo、缺了就重算
    audio: "AudioInfoV2 | None" = None
    # `audio` 鍵在檔案裡是否存在（含 null）：v1 檔沒有這個鍵，讀進寫出必須逐位元相同，不能憑空多出 "audio": null
    audio_key: bool = False

    _KEYS = ("id", "path", "name", "fingerprint", "probe", "proxy", "audio")

    def to_json(self) -> dict[str, Any]:
        d: dict[str, Any] = {"id": self.id, "path": self.path, "name": self.name, "fingerprint": self.fingerprint, "probe": self.probe, "proxy": self.proxy.to_json() if self.proxy else None}
        if self.audio is not None or self.audio_key:
            d["audio"] = self.audio.to_json() if self.audio is not None else None
        d.update(self.extra)
        return d

    @classmethod
    def from_json(cls, d: Any, warn: Warn) -> "MediaV1 | None":
        if not isinstance(d, dict) or not isinstance(d.get("id"), str) or not d["id"]:
            warn("media 項目缺 id，丟棄")
            return None
        probe = d.get("probe") if isinstance(d.get("probe"), dict) else None
        audio = AudioInfoV2.from_json(d.get("audio"), warn, f"media {d['id']}.audio") if d.get("audio") is not None else None
        return cls(d["id"], _str(d.get("path")), _str(d.get("name")), _str(d.get("fingerprint")), probe, ProxyMetaV1.from_json(d.get("proxy"), warn), _rest(d, cls._KEYS), audio, "audio" in d)

    @property
    def source_size(self) -> tuple[int, int] | None:
        """來源像素尺寸（probe.video.width/height）；序列在來源像素空間工作。"""
        v = self.probe.get("video") if isinstance(self.probe, dict) else None
        if not isinstance(v, dict):
            return None
        w, h = _int(v.get("width")), _int(v.get("height"))
        return (w, h) if w and h else None


@dataclass
class ShotV1:
    id: str
    start_frame: int
    end_frame: int  # exclusive
    kind: str = "unknown"
    source: str = "auto"
    extra: dict[str, Any] = field(default_factory=dict)

    _KEYS = ("id", "startFrame", "endFrame", "kind", "source")

    def to_json(self) -> dict[str, Any]:
        return {"id": self.id, "startFrame": self.start_frame, "endFrame": self.end_frame, "kind": self.kind, "source": self.source, **self.extra}

    @classmethod
    def from_json(cls, d: Any, warn: Warn, max_frame: int | None = None) -> "ShotV1 | None":
        if not isinstance(d, dict) or not isinstance(d.get("id"), str):
            warn("shot 缺 id，丟棄")
            return None
        s, e = _int(d.get("startFrame")), _int(d.get("endFrame"))
        if s is None or e is None or s < 0 or e <= s:
            warn(f"shot {d['id']} 幀範圍不合法 ({d.get('startFrame')!r}, {d.get('endFrame')!r})，丟棄")
            return None
        if max_frame is not None and s >= max_frame:
            warn(f"shot {d['id']} 起點 {s} 超出 proxy 幀數 {max_frame}，丟棄")
            return None
        kind = _enum(d.get("kind"), SHOT_KINDS, "unknown", warn, f"shot {d['id']}.kind") or "unknown"
        source = _enum(d.get("source"), SHOT_SOURCES, "auto", warn, f"shot {d['id']}.source") or "auto"
        return cls(d["id"], s, e, kind, source, _rest(d, cls._KEYS))


# ---------------------------------------------------------------- track 子結構


@dataclass
class KeyframeV1:
    frame: int
    quad: Quad
    source: str = "user"
    locked_corners: list[bool] | None = None  # Point Lock；None = 不寫這個 key

    def to_json(self) -> dict[str, Any]:
        d: dict[str, Any] = {"frame": self.frame, "quad": self.quad.to_json(), "source": self.source}
        if self.locked_corners is not None:
            d["lockedCorners"] = list(self.locked_corners)
        return d

    @classmethod
    def from_json(cls, d: Any, warn: Warn, where: str, max_frame: int | None) -> "KeyframeV1 | None":
        if not isinstance(d, dict):
            warn(f"{where}: keyframe 不是物件，丟棄")
            return None
        f = _int(d.get("frame"))
        if f is None or f < 0 or (max_frame is not None and f >= max_frame):
            warn(f"{where}: keyframe frame={d.get('frame')!r} 不是有效幀號，丟棄")
            return None
        q = Quad.from_json(d.get("quad"))
        if q is None:
            warn(f"{where}: keyframe frame={f} 的 quad 不是凸四邊形，丟棄")
            return None
        src = _enum(d.get("source"), KEYFRAME_SOURCES, "user", warn, f"{where}: keyframe {f}.source") or "user"
        lc = d.get("lockedCorners")
        locked: list[bool] | None = None
        if lc is not None:
            if isinstance(lc, list) and len(lc) == 4 and all(isinstance(b, bool) for b in lc):
                locked = list(lc)
            else:
                warn(f"{where}: keyframe {f}.lockedCorners 不是 4 個布林，忽略")
        return cls(f, q, src, locked)


@dataclass
class PromptPointV1:
    x: float
    y: float
    label: int  # 1 加選 / 0 減選

    def to_json(self) -> dict[str, Any]:
        return {"x": self.x, "y": self.y, "label": self.label}


@dataclass
class PromptV1:
    frame: int
    points: list[PromptPointV1] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {"frame": self.frame, "points": [p.to_json() for p in self.points]}

    @classmethod
    def from_json(cls, d: Any, warn: Warn, where: str, max_frame: int | None) -> "PromptV1 | None":
        if not isinstance(d, dict):
            warn(f"{where}: prompt 不是物件，丟棄")
            return None
        f = _int(d.get("frame"))
        if f is None or f < 0 or (max_frame is not None and f >= max_frame):
            warn(f"{where}: prompt frame={d.get('frame')!r} 不是有效幀號，丟棄")
            return None
        pts: list[PromptPointV1] = []
        for raw in d.get("points") or []:
            if not isinstance(raw, dict) or not _is_finite_number(raw.get("x")) or not _is_finite_number(raw.get("y")) or raw.get("label") not in (0, 1) or isinstance(raw.get("label"), bool):
                warn(f"{where}: prompt {f} 有壞的點 {raw!r}，丟棄該點")
                continue
            pts.append(PromptPointV1(float(raw["x"]), float(raw["y"]), int(raw["label"])))
        if not pts:
            warn(f"{where}: prompt {f} 沒有有效的點，丟棄")
            return None
        return cls(f, pts)


@dataclass
class ReferencePointV1:
    id: str
    frame: int
    corner_index: int | None
    xy: list[float]
    locked: bool = False
    primary_frame: int = 0

    def to_json(self) -> dict[str, Any]:
        return {"id": self.id, "frame": self.frame, "cornerIndex": self.corner_index, "xy": list(self.xy), "locked": self.locked, "primaryFrame": self.primary_frame}

    @classmethod
    def from_json(cls, d: Any, warn: Warn, where: str, max_frame: int | None) -> "ReferencePointV1 | None":
        if not isinstance(d, dict) or not isinstance(d.get("id"), str):
            warn(f"{where}: 參考點缺 id，丟棄")
            return None
        f = _int(d.get("frame"))
        xy = _point(d.get("xy"))
        if f is None or f < 0 or (max_frame is not None and f >= max_frame) or xy is None:
            warn(f"{where}: 參考點 {d['id']} 幀號或座標無效，丟棄")
            return None
        ci = d.get("cornerIndex")
        corner = _int(ci) if ci is not None else None
        if ci is not None and corner not in (0, 1, 2, 3):
            warn(f"{where}: 參考點 {d['id']}.cornerIndex={ci!r} 無效，改為 null")
            corner = None
        pf = _int(d.get("primaryFrame"))
        return cls(d["id"], f, corner, xy, _bool(d.get("locked"), False), pf if pf is not None else f)


@dataclass
class AdjustV1:
    points: list[ReferencePointV1] = field(default_factory=list)
    enabled: bool = False

    def to_json(self) -> dict[str, Any]:
        return {"points": [p.to_json() for p in self.points], "enabled": self.enabled}

    @classmethod
    def from_json(cls, d: Any, warn: Warn, where: str, max_frame: int | None) -> "AdjustV1":
        if not isinstance(d, dict):
            return cls()
        pts = [p for p in (ReferencePointV1.from_json(x, warn, where, max_frame) for x in d.get("points") or []) if p is not None]
        return cls(pts, _bool(d.get("enabled"), False))


@_accept_ext_kwargs
@dataclass
class TrackOptionsV1(_ExtAttrs):
    method: str = "classic"
    motion_model: str = "perspective"
    smoothing: float = 0.4  # UI「平滑 40%」= savgol(9,2)
    extra: dict[str, Any] = field(default_factory=dict)
    ext: dict[str, Any] = field(default_factory=dict)  # 外掛欄位（hooks.SchemaField，owner "track.options"）

    _EXT_OWNER = "track.options"
    _KEYS = ("method", "motionModel", "smoothing")

    def to_json(self) -> dict[str, Any]:
        return _emit([("method", self.method), ("motionModel", self.motion_model), ("smoothing", self.smoothing)], self._EXT_OWNER, self.ext, self.extra)

    @classmethod
    def from_json(cls, d: Any, warn: Warn, where: str) -> "TrackOptionsV1":
        if not isinstance(d, dict):
            return cls()
        method = _enum(d.get("method"), TRACK_METHODS, "classic", warn, f"{where}: options.method") or "classic"
        mm = _enum(d.get("motionModel"), MOTION_MODELS, "perspective", warn, f"{where}: options.motionModel") or "perspective"
        sm = _num(d.get("smoothing"), 0.4)
        sm = min(max(sm if sm is not None else 0.4, 0.0), 1.0)
        ext = _parse_ext(cls._EXT_OWNER, d, warn, TrackParseEnv(where, None))
        return cls(method, mm, sm, _rest_anchored(d, cls._KEYS + _ext_keys(cls._EXT_OWNER)), ext)


# ---------------------------------------------------------------- insert（計畫 §6.6 參數表）


@dataclass
class EdgeV1:
    choke: float = 0.6
    softness: float = 0.8
    falloff: str = "linear"

    def to_json(self) -> dict[str, Any]:
        return {"choke": self.choke, "softness": self.softness, "falloff": self.falloff}

    @classmethod
    def from_json(cls, d: Any, warn: Warn, where: str) -> "EdgeV1 | None":
        if not isinstance(d, dict):
            return None
        return cls(_num(d.get("choke"), 0.6) or 0.0, _num(d.get("softness"), 0.8) or 0.0, _enum(d.get("falloff"), ("linear", "smoothstep"), "linear", warn, f"{where}.edge.falloff") or "linear")


@dataclass
class OcclusionV1:
    dilate: float = 1.0
    feather: float = 1.2

    def to_json(self) -> dict[str, Any]:
        return {"dilate": self.dilate, "feather": self.feather}

    @classmethod
    def from_json(cls, d: Any) -> "OcclusionV1 | None":
        if not isinstance(d, dict):
            return None
        return cls(_num(d.get("dilate"), 1.0) or 0.0, _num(d.get("feather"), 1.2) or 0.0)


@dataclass
class MotionBlurV1:
    shutter_angle: float | str = 180.0  # Nuke shutter 0.5 幀 = 180°；"auto" ＝ 用追蹤量到的來源拖尾（render 解析）
    shutter_phase: str = "centered"
    samples: int | str = "auto"  # int 或 "auto"（間距 ≤ max_step_px）

    def to_json(self) -> dict[str, Any]:
        return {"shutterAngle": self.shutter_angle, "shutterPhase": self.shutter_phase, "samples": self.samples}

    @classmethod
    def from_json(cls, d: Any, warn: Warn, where: str) -> "MotionBlurV1 | None":
        if not isinstance(d, dict):
            return None
        s = d.get("samples", "auto")
        samples: int | str = "auto"
        if s == "auto":
            samples = "auto"
        elif _int(s) is not None and 1 <= int(s) <= 64:
            samples = int(s)
        else:
            warn(f"{where}.motionBlur.samples={s!r} 無效，改用 auto")
        phase = _enum(d.get("shutterPhase"), ("centered", "start", "end", "custom"), "centered", warn, f"{where}.motionBlur.shutterPhase") or "centered"
        a = d.get("shutterAngle")
        angle: float | str = "auto" if a == "auto" else (_num(a, 180.0) or 0.0)
        return cls(angle, phase, samples)


@dataclass
class ResampleV1:
    kernel: str = "lanczos3"
    clamp: bool = True  # 白紙黑角標不 clamp 必振鈴

    def to_json(self) -> dict[str, Any]:
        return {"kernel": self.kernel, "clamp": self.clamp}

    @classmethod
    def from_json(cls, d: Any, warn: Warn, where: str) -> "ResampleV1 | None":
        if not isinstance(d, dict):
            return None
        return cls(_enum(d.get("kernel"), ("nearest", "bilinear", "bicubic", "lanczos3"), "lanczos3", warn, f"{where}.resample.kernel") or "lanczos3", _bool(d.get("clamp"), True))


@dataclass
class RelightV1:
    keep_highlights: float = 100.0
    sheen_lock: str = "plate"

    def to_json(self) -> dict[str, Any]:
        return {"keepHighlights": self.keep_highlights, "sheenLock": self.sheen_lock}

    @classmethod
    def from_json(cls, d: Any, warn: Warn, where: str) -> "RelightV1 | None":
        if not isinstance(d, dict):
            return None
        return cls(_num(d.get("keepHighlights"), 100.0) or 0.0, _enum(d.get("sheenLock"), ("plate", "card"), "plate", warn, f"{where}.relight.sheenLock") or "plate")


@dataclass
class GrainV1:
    mode: str = "measured"
    amount: float = 100.0

    def to_json(self) -> dict[str, Any]:
        return {"mode": self.mode, "amount": self.amount}

    @classmethod
    def from_json(cls, d: Any, warn: Warn, where: str) -> "GrainV1 | None":
        if not isinstance(d, dict):
            return None
        return cls(_enum(d.get("mode"), ("measured", "synthetic"), "measured", warn, f"{where}.grain.mode") or "measured", _num(d.get("amount"), 100.0) or 0.0)


@dataclass
class InsertV1:
    """track.insert（欄位 None = 繼承 insertDefaults）或 insertDefaults 本體（全部非 None）。"""

    macro: str = "standard"
    opacity: float | None = None
    apply_mix: float | None = None
    edge: EdgeV1 | None = None
    occlusion: OcclusionV1 | None = None
    motion_blur: MotionBlurV1 | None = None
    resample: ResampleV1 | None = None
    relight: RelightV1 | None = None
    grain: GrainV1 | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    _KEYS = ("macro", "opacity", "applyMix", "edge", "occlusion", "motionBlur", "resample", "relight", "grain")

    @classmethod
    def defaults(cls) -> "InsertV1":
        """計畫 §6.6 標準（standard）巨集的預設值。"""
        return cls("standard", 100.0, 100.0, EdgeV1(), OcclusionV1(), MotionBlurV1(), ResampleV1(), RelightV1(), GrainV1())

    def to_json(self) -> dict[str, Any]:
        d: dict[str, Any] = {"macro": self.macro}
        if self.opacity is not None:
            d["opacity"] = self.opacity
        if self.apply_mix is not None:
            d["applyMix"] = self.apply_mix
        for key, sub in (("edge", self.edge), ("occlusion", self.occlusion), ("motionBlur", self.motion_blur), ("resample", self.resample), ("relight", self.relight), ("grain", self.grain)):
            if sub is not None:
                d[key] = sub.to_json()
        d.update(self.extra)
        return d

    @classmethod
    def from_json(cls, d: Any, warn: Warn, where: str) -> "InsertV1 | None":
        if not isinstance(d, dict):
            return None
        return cls(
            macro=_enum(d.get("macro"), INSERT_MACROS, "standard", warn, f"{where}.macro") or "standard",
            opacity=_num(d.get("opacity")),
            apply_mix=_num(d.get("applyMix")),
            edge=EdgeV1.from_json(d.get("edge"), warn, where),
            occlusion=OcclusionV1.from_json(d.get("occlusion")),
            motion_blur=MotionBlurV1.from_json(d.get("motionBlur"), warn, where),
            resample=ResampleV1.from_json(d.get("resample"), warn, where),
            relight=RelightV1.from_json(d.get("relight"), warn, where),
            grain=GrainV1.from_json(d.get("grain"), warn, where),
            extra=_rest(d, cls._KEYS),
        )


def resolve_insert(track_insert: InsertV1 | None, defaults: InsertV1) -> InsertV1:
    """track.insert 的 None 欄位繼承 insertDefaults（Silhouette「Default」哨兵語意）。"""
    base = InsertV1.defaults()
    for name in ("opacity", "apply_mix", "edge", "occlusion", "motion_blur", "resample", "relight", "grain"):
        v = getattr(defaults, name)
        if v is not None:
            setattr(base, name, v)
    base.macro = defaults.macro
    base.extra = dict(defaults.extra)
    if track_insert is not None:
        base.macro = track_insert.macro
        for name in ("opacity", "apply_mix", "edge", "occlusion", "motion_blur", "resample", "relight", "grain"):
            v = getattr(track_insert, name)
            if v is not None:
                setattr(base, name, v)
        base.extra.update(track_insert.extra)
    return base


# ---------------------------------------------------------------- 通用物件：來源、替換、特效（docs/tracking-api.md「專案檔」）
#
# 這幾個子物件一律**存原始 dict**、用唯讀屬性取型別化的值：讀進寫出逐位元相同（鍵序、null、整數／小數的寫法都不動），
# 未知鍵自然保留。載入時只做會讓資料不能用的檢查（缺必要欄位 → 整個丟掉並警告）；選填欄位壞掉只警告、屬性回預設值。


def _warn_str(d: dict[str, Any], key: str, warn: Warn, where: str) -> None:
    v = d.get(key)
    if v is not None and not isinstance(v, str):
        warn(f"{where}.{key}={v!r} 不是字串，忽略")


@dataclass
class ObjectSourceV1:
    """track.source：物件是怎麼找到的 `{type: "text"|"select"|"ai", text?, phrase?, backend?, score?}`。"""

    raw: dict[str, Any]

    @classmethod
    def make(cls, type: str, **kw: Any) -> "ObjectSourceV1":
        if type not in OBJECT_SOURCE_TYPES:
            raise ValueError(f"source.type 要是 {OBJECT_SOURCE_TYPES} 之一，收到 {type!r}")
        return cls({"type": type, **{k: v for k, v in kw.items() if v is not None}})

    @property
    def type(self) -> str:
        return str(self.raw.get("type"))

    def _s(self, key: str) -> str | None:
        v = self.raw.get(key)
        return v if isinstance(v, str) else None

    @property
    def text(self) -> str | None:
        return self._s("text")

    @property
    def phrase(self) -> str | None:
        return self._s("phrase")

    @property
    def backend(self) -> str | None:
        return self._s("backend")

    @property
    def score(self) -> float | None:
        v = self.raw.get("score")
        return float(v) if _is_finite_number(v) else None

    def to_json(self) -> dict[str, Any]:
        return dict(self.raw)

    @classmethod
    def from_json(cls, d: Any, warn: Warn, where: str) -> "ObjectSourceV1 | None":
        if not isinstance(d, dict):
            warn(f"{where} 不是物件，丟棄")
            return None
        if d.get("type") not in OBJECT_SOURCE_TYPES:
            warn(f"{where}.type={d.get('type')!r} 不在 {OBJECT_SOURCE_TYPES}，丟棄 source")
            return None
        for key in ("text", "phrase", "backend"):
            _warn_str(d, key, warn, where)
        sc = d.get("score")
        if sc is not None and not _is_finite_number(sc):
            warn(f"{where}.score={sc!r} 不是有限數字，忽略")
        return cls(dict(d))


@dataclass
class ReplaceV1:
    """平面 track 的 replace：`{kind: "image"|"video", path, fit: "stretch"|"contain"|"cover", offsetFrames: int, loop: "loop"|"hold"|"stop"}`。

    選填欄位缺了用預設（fit=stretch、offsetFrames=0、loop=loop）；寫檔照原樣（沒寫的鍵不會憑空多出來）。
    幀對應（offsetFrames、loop）的定義見 `aivc.insert.media.source_index`。"""

    raw: dict[str, Any]

    @classmethod
    def make(cls, kind: str, path: str, *, fit: str = "stretch", offset_frames: int = 0, loop: str = "loop") -> "ReplaceV1":
        if kind not in REPLACE_KINDS or fit not in REPLACE_FITS or loop not in REPLACE_LOOPS:
            raise ValueError(f"replace 參數不合法：kind={kind!r} fit={fit!r} loop={loop!r}")
        return cls({"kind": kind, "path": str(path), "fit": fit, "offsetFrames": int(offset_frames), "loop": loop})

    @property
    def kind(self) -> str:
        return str(self.raw.get("kind"))

    @property
    def path(self) -> str:
        return str(self.raw.get("path") or "")

    @property
    def fit(self) -> str:
        v = self.raw.get("fit")
        return v if v in REPLACE_FITS else "stretch"

    @property
    def offset_frames(self) -> int:
        v = _int(self.raw.get("offsetFrames"))
        return 0 if v is None else v

    @property
    def loop(self) -> str:
        v = self.raw.get("loop")
        return v if v in REPLACE_LOOPS else "loop"

    def to_json(self) -> dict[str, Any]:
        return dict(self.raw)

    @classmethod
    def from_json(cls, d: Any, warn: Warn, where: str) -> "ReplaceV1 | None":
        if not isinstance(d, dict):
            warn(f"{where} 不是物件，丟棄")
            return None
        if d.get("kind") not in REPLACE_KINDS:
            warn(f"{where}.kind={d.get('kind')!r} 不在 {REPLACE_KINDS}，丟棄 replace")
            return None
        if not isinstance(d.get("path"), str) or not d["path"].strip():
            warn(f"{where}.path 缺或不是字串，丟棄 replace")
            return None
        if d.get("fit") is not None and d.get("fit") not in REPLACE_FITS:
            warn(f"{where}.fit={d.get('fit')!r} 不在 {REPLACE_FITS}，改用 stretch")
        if d.get("loop") is not None and d.get("loop") not in REPLACE_LOOPS:
            warn(f"{where}.loop={d.get('loop')!r} 不在 {REPLACE_LOOPS}，改用 loop")
        if d.get("offsetFrames") is not None and _int(d.get("offsetFrames")) is None:
            warn(f"{where}.offsetFrames={d.get('offsetFrames')!r} 不是整數，改用 0")
        return cls(dict(d))


def effect_enabled(e: dict[str, Any]) -> bool:
    """特效物件的 enabled（缺或不是布林 → 啟用；只有明確的 false 才停用）。"""
    return e.get("enabled") is not False


def effect_params(e: dict[str, Any]) -> dict[str, Any]:
    """特效物件去掉 id／enabled → `aivc.fx.params.parse_effect` 吃的 dict（未知鍵留著，讓 parse_effect 報錯）。"""
    return {k: v for k, v in e.items() if k not in EFFECT_META_KEYS}


def _effects_from_json(raw: Any, warn: Warn, where: str) -> list[dict[str, Any]] | None:
    """track.effects：陣列，每筆 `{id, enabled, type, ...參數}`。參數不在這裡驗（render.plan 會逐筆回報不合法的原因）。"""
    if not isinstance(raw, list):
        warn(f"{where}.effects 不是陣列，丟棄")
        return None
    out: list[dict[str, Any]] = []
    for i, e in enumerate(raw):
        w = f"{where}.effects[{i}]"
        if not isinstance(e, dict):
            warn(f"{w} 不是物件，丟棄")
            continue
        if not isinstance(e.get("id"), str) or not e["id"]:
            warn(f"{w} 缺 id，丟棄")
            continue
        if not isinstance(e.get("type"), str) or not e["type"]:
            warn(f"{w}（{e['id']}）缺 type，丟棄")
            continue
        if "enabled" in e and not isinstance(e["enabled"], bool):
            warn(f"{w}（{e['id']}）.enabled={e['enabled']!r} 不是布林，視為啟用")
        out.append(dict(e))
    return out


def _range_from_json(raw: Any, warn: Warn, where: str, max_frame: int | None) -> tuple[int, int] | None:
    """track.range `[k0, k1]`（半開、proxy 幀號）。超過 proxy 幀數只警告（render 時夾進去），值照存。"""
    if not isinstance(raw, (list, tuple)) or len(raw) != 2:
        warn(f"{where}.range={raw!r} 不是 [k0, k1]，丟棄")
        return None
    k0, k1 = _int(raw[0]), _int(raw[1])
    if k0 is None or k1 is None or k0 < 0 or k1 <= k0:
        warn(f"{where}.range={raw!r} 不是有效的半開範圍，丟棄")
        return None
    if max_frame is not None and k1 > max_frame:
        warn(f"{where}.range 終點 {k1} 超過 proxy 幀數 {max_frame}（輸出時夾到 {max_frame}）")
    return (k0, k1)


# 通用物件的 track 鍵（寫檔時依這個順序接在 stale 後面；讀進來的檔案則放回原本的位置，見 _reanchor）
_OBJECT_KEYS = ("color", "source", "range", "effects", "replace")


def _reanchor(out: dict[str, Any], anchors: dict[str, tuple[str, ...]]) -> dict[str, Any]:
    """把讀檔時記下位置的鍵放回原位（接在原檔排在它前面、這次也有寫出的最近那個鍵後面）。

    為什麼：TS 端寫這幾個鍵的位置不一定跟引擎的預設順序相同；App 每 2 秒自動存檔、引擎的 run／detect 也會寫專案，
    沒動到的檔案讀進寫出要逐位元相同。依原檔順序處理，前一個鍵已經就位，後一個鍵才找得到它。"""
    if not anchors:
        return out
    order = list(out)
    for key in sorted((k for k in anchors if k in out), key=lambda k: len(anchors[k])):
        order.remove(key)
        pos = 0
        for a in anchors[key]:
            if a in order:
                pos = order.index(a) + 1
                break
        order.insert(pos, key)
    return {k: out[k] for k in order}


# ---------------------------------------------------------------- track


@_accept_ext_kwargs
@dataclass
class TrackV1(_ExtAttrs):
    id: str
    shot_id: str
    label: str = ""
    kind: str = "planar"
    reference_frame: int | None = None
    tracking_region: Quad | None = None
    keyframes: list[KeyframeV1] = field(default_factory=list)
    prompts: list[PromptV1] = field(default_factory=list)
    adjust: AdjustV1 = field(default_factory=AdjustV1)
    options: TrackOptionsV1 = field(default_factory=TrackOptionsV1)
    insert: InsertV1 | None = None
    region_policy: str = "keepBarcode"
    stale: bool = False
    extra: dict[str, Any] = field(default_factory=dict)
    ext: dict[str, Any] = field(default_factory=dict)  # 外掛欄位（hooks.SchemaField，owner "track"）
    # ---- 通用物件（可省略的鍵；None ＝ 檔案裡沒有這個鍵）----
    color: str | None = None  # "#RRGGBB"：UI 上這條 track 的顏色
    source: ObjectSourceV1 | None = None  # object track：怎麼找到的
    frame_range: tuple[int, int] | None = None  # 磁碟上的 `range`：[k0, k1) 半開（object track 的有效範圍）
    effects: list[dict[str, Any]] | None = None  # [{id, enabled, type, ...參數}]（object 與 planar track 都可以有）
    replace: ReplaceV1 | None = None  # planar track：用圖片／影片取代表面
    # 讀檔時上面這幾個鍵在原檔的位置（排在它前面的鍵，由近到遠）：寫回時放回原位（_reanchor）
    key_anchors: dict[str, tuple[str, ...]] = field(default_factory=dict, repr=False, compare=False)

    _EXT_OWNER = "track"
    _KEYS = ("id", "shotId", "label", "kind", "referenceFrame", "trackingRegion", "keyframes", "prompts", "adjust", "options", "insert", "regionPolicy", "stale", *_OBJECT_KEYS)

    @property
    def is_object(self) -> bool:
        return self.kind == TRACK_KIND_OBJECT

    def to_json(self) -> dict[str, Any]:
        core: list[tuple[str, Any]] = [
            ("id", self.id),
            ("shotId", self.shot_id),
            ("label", self.label),
            ("kind", self.kind),
            ("referenceFrame", self.reference_frame),
            ("trackingRegion", self.tracking_region.to_json() if self.tracking_region else None),
            ("keyframes", [k.to_json() for k in self.keyframes]),
            ("prompts", [p.to_json() for p in self.prompts]),
            ("adjust", self.adjust.to_json()),
            ("options", self.options.to_json()),
            ("insert", self.insert.to_json() if self.insert else None),
            ("regionPolicy", self.region_policy),
            ("stale", self.stale),
        ]
        # 通用物件的鍵只在有值時寫：沒有用到的專案存回去跟以前逐位元相同
        for key, val in (
            ("color", self.color),
            ("source", None if self.source is None else self.source.to_json()),
            ("range", None if self.frame_range is None else [int(self.frame_range[0]), int(self.frame_range[1])]),
            ("effects", None if self.effects is None else [dict(e) for e in self.effects]),
            ("replace", None if self.replace is None else self.replace.to_json()),
        ):
            if val is not None:
                core.append((key, val))
        d = _emit(core, self._EXT_OWNER, self.ext, self.extra)
        return _reanchor(d, self.key_anchors)

    @classmethod
    def from_json(cls, d: Any, warn: Warn, max_frame: int | None = None) -> "TrackV1 | None":
        if not isinstance(d, dict) or not isinstance(d.get("id"), str) or not d["id"]:
            warn("track 缺 id，丟棄")
            return None
        where = f"track {d['id']}"
        shot_id = d.get("shotId")
        if not isinstance(shot_id, str):
            warn(f"{where}: 缺 shotId")
            shot_id = ""
        rf = d.get("referenceFrame")
        ref: int | None = None
        if rf is not None:
            ref = _int(rf)
            if ref is None or ref < 0 or (max_frame is not None and ref >= max_frame):
                warn(f"{where}: referenceFrame={rf!r} 無效，改為 null")
                ref = None
        tr = d.get("trackingRegion")
        region: Quad | None = None
        if tr is not None:
            region = Quad.from_json(tr)
            if region is None:
                warn(f"{where}: trackingRegion 不是凸四邊形，改為 null")
        kfs = [k for k in (KeyframeV1.from_json(x, warn, where, max_frame) for x in d.get("keyframes") or []) if k is not None]
        prompts = [p for p in (PromptV1.from_json(x, warn, where, max_frame) for x in d.get("prompts") or []) if p is not None]
        # 外掛欄位在這個位置解析（keyframes／prompts 之後、adjust／options 之前）：警告的先後與外掛化之前相同
        ext = _parse_ext(cls._EXT_OWNER, d, warn, TrackParseEnv(where, max_frame))
        # ---- 通用物件的鍵（都可省略）----
        color: str | None = None
        if d.get("color") is not None:
            if isinstance(d["color"], str) and _HEX_COLOR.match(d["color"]):
                color = d["color"]
            else:
                warn(f"{where}: color={d['color']!r} 不是 #RRGGBB，丟棄")
        source = ObjectSourceV1.from_json(d["source"], warn, f"{where}.source") if d.get("source") is not None else None
        frame_range = _range_from_json(d["range"], warn, where, max_frame) if d.get("range") is not None else None
        effects = _effects_from_json(d["effects"], warn, where) if d.get("effects") is not None else None
        replace = ReplaceV1.from_json(d["replace"], warn, f"{where}.replace") if d.get("replace") is not None else None
        parsed = {"color": color, "source": source, "range": frame_range, "effects": effects, "replace": replace}
        keys = list(d)
        anchors = {k: tuple(reversed(keys[: keys.index(k)])) for k in _OBJECT_KEYS if k in d and parsed[k] is not None}
        return cls(
            color=color,
            source=source,
            frame_range=frame_range,
            effects=effects,
            replace=replace,
            key_anchors=anchors,
            id=d["id"],
            shot_id=shot_id,
            label=_str(d.get("label"), d["id"]),
            kind=_str(d.get("kind"), "planar"),
            reference_frame=ref,
            tracking_region=region,
            keyframes=kfs,
            prompts=prompts,
            adjust=AdjustV1.from_json(d.get("adjust"), warn, where, max_frame),
            options=TrackOptionsV1.from_json(d.get("options"), warn, where),
            insert=InsertV1.from_json(d.get("insert"), warn, f"{where}.insert"),
            region_policy=_enum(d.get("regionPolicy"), REGION_POLICIES, "keepBarcode", warn, f"{where}: regionPolicy") or "keepBarcode",
            stale=_bool(d.get("stale"), False),
            extra=_rest_anchored(d, cls._KEYS + _ext_keys(cls._EXT_OWNER)),
            ext=ext,
        )


@dataclass
class TrackDataExportV1:
    format: str = "nuke"
    flavour: str = "cornerpin"
    baked: bool = True
    frame_offset: int = 1

    def to_json(self) -> dict[str, Any]:
        return {"format": self.format, "flavour": self.flavour, "baked": self.baked, "frameOffset": self.frame_offset}

    @classmethod
    def from_json(cls, d: Any, warn: Warn) -> "TrackDataExportV1":
        if not isinstance(d, dict):
            return cls()
        fo = _int(d.get("frameOffset"))
        return cls(
            _enum(d.get("format"), ("nuke", "ae"), "nuke", warn, "exportDefaults.trackData.format") or "nuke",
            _enum(d.get("flavour"), ("cornerpin", "cornerpin+transform"), "cornerpin", warn, "exportDefaults.trackData.flavour") or "cornerpin",
            _bool(d.get("baked"), True),
            fo if fo is not None else 1,
        )


@dataclass
class ExportDefaultsV1:
    codec: str = "auto"  # auto = encode_plan 依來源容器決定（webm → libvpx-vp9）
    # None ＝ 交給 encode_plan 依 codec 決定（webm VP9 crf 16、NVENC cq 19）。以前寫死 24：它會蓋過編碼計畫的預設，
    # 2026-09-17 把 VP9 預設改 16 之後，所有從專案檔渲染的輸出仍是 crf 24（範例全片 9.8 MB）。存成數字才代表使用者明確選過。
    quality: float | None = None
    audio: str = "copy"
    track_data: TrackDataExportV1 = field(default_factory=TrackDataExportV1)
    extra: dict[str, Any] = field(default_factory=dict)

    _KEYS = ("codec", "quality", "audio", "trackData")

    def to_json(self) -> dict[str, Any]:
        return {"codec": self.codec, "quality": self.quality, "audio": self.audio, "trackData": self.track_data.to_json(), **self.extra}

    @classmethod
    def from_json(cls, d: Any, warn: Warn) -> "ExportDefaultsV1":
        if not isinstance(d, dict):
            return cls()
        return cls(_str(d.get("codec"), "auto"), _num(d.get("quality"), None), _str(d.get("audio"), "copy"), TrackDataExportV1.from_json(d.get("trackData"), warn), _rest(d, cls._KEYS))


# ---------------------------------------------------------------- sequence / audio（schema v2；設計 §3.2–§3.5）
#
# 時間單位全部是整數（設計 §3.1）：V1 片段 srcIn/srcOut 是該媒體的 proxy 幀、Gap.length 是序列幀；
# 音訊片段 start/length/fade*/envelope.at 是序列樣本（48 kHz）；音訊片段 srcIn 是來源原生取樣率的樣本（可為負）。
# 規則與 TS `project/sanitize.ts` 同一張表（§3.5）：丟掉並回報，不擲錯。


def _db(v: Any, default: float = 0.0) -> float:
    """dB 夾在 [−96, +12]；非有限數用 default。"""
    x = _num(v, default)
    return min(max(float(default if x is None else x), GAIN_DB_MIN), GAIN_DB_MAX)


def _sample(v: Any) -> int | None:
    """樣本位置：有限數取最接近的整數（x.5 往 +∞，同 JS Math.round）。
    為什麼不像幀號一樣要求整數值：別的寫入端（試算、舊腳本）可能寫出 48000.0000001，為了一個浮點尾巴丟掉整段音樂不划算。"""
    if not _is_finite_number(v):
        return None
    return math.floor(float(v) + 0.5)


def _frac_eq(a: Rational, b: Rational) -> bool:
    return a.num * b.den == b.num * a.den


_GAIN_KEYS = ("gainDb", "fadeIn", "fadeOut", "fadeCurve", "envelope")


@dataclass
class GainPointV2:
    """音量自動化點。at：相對片段起點的序列樣本；兩點之間在 dB 域線性內插（同 ai-music-cut OverlayPoint）。"""

    at: int
    db: float

    def to_json(self) -> dict[str, Any]:
        return {"at": self.at, "db": self.db}


@dataclass
class ClipGainV2:
    """片段層的音訊參數：V1 原音與音訊片段共用同一組欄位，渲染與預覽只寫一套。"""

    gain_db: float = 0.0
    fade_in: int = 0  # 序列樣本
    fade_out: int = 0  # 序列樣本；fade_in + fade_out ≤ 片段長度
    fade_curve: str = "linear"
    envelope: list[GainPointV2] = field(default_factory=list)  # 依 at 排序、at ∈ [0, length]

    def gain_json(self) -> dict[str, Any]:
        return {"gainDb": self.gain_db, "fadeIn": self.fade_in, "fadeOut": self.fade_out, "fadeCurve": self.fade_curve, "envelope": [p.to_json() for p in self.envelope]}

    @property
    def is_neutral(self) -> bool:
        """0 dB、無淡化、無自動化。曲線不看：兩端淡化都是 0 時曲線不影響輸出（`-c:a copy` 閘門用，設計 §7.1）。"""
        return self.gain_db == 0 and self.fade_in == 0 and self.fade_out == 0 and not self.envelope

    def _load_gain(self, d: dict[str, Any], warn: Warn, where: str) -> None:
        self.gain_db = _db(d.get("gainDb"))
        if d.get("gainDb") is not None and self.gain_db != d.get("gainDb"):
            warn(f"{where}: gainDb={d.get('gainDb')!r} 超出 [{GAIN_DB_MIN:g}, {GAIN_DB_MAX:g}] 或無效，改為 {self.gain_db:g}")
        for key, attr in (("fadeIn", "fade_in"), ("fadeOut", "fade_out")):
            raw = d.get(key)
            n = _sample(raw) if raw is not None else 0
            if n is None or n < 0:
                warn(f"{where}: {key}={raw!r} 無效，改為 0")
                n = 0
            setattr(self, attr, n)
        self.fade_curve = _enum(d.get("fadeCurve"), FADE_CURVES, "linear", warn, f"{where}: fadeCurve") or "linear"
        pts: list[GainPointV2] = []
        raw_env = d.get("envelope")
        if raw_env is not None and not isinstance(raw_env, list):
            warn(f"{where}: envelope 不是陣列，清空")
            raw_env = []
        for raw in raw_env or []:
            at = _sample(raw.get("at")) if isinstance(raw, dict) else None
            db = raw.get("db") if isinstance(raw, dict) else None
            if at is None or not _is_finite_number(db):
                warn(f"{where}: 自動化點 {raw!r} 無效，丟棄")
                continue
            pts.append(GainPointV2(at, float(db)))
        self.envelope = pts

    def sanitize_gain(self, length: int, warn: Warn, where: str) -> None:
        """依片段長度修正：淡化超長等比縮小、自動化點夾進 [0, length] 並排序、dB 夾住（設計 §3.5）。

        等比縮小一律 floor（`fadeIn·L // (fadeIn+fadeOut)`），兩邊加起來保證 ≤ L；TS 端用同一個算式。
        """
        total = self.fade_in + self.fade_out
        if length > 0 and total > length:
            fi, fo = self.fade_in * length // total, self.fade_out * length // total
            warn(f"{where}: 淡入 {self.fade_in} + 淡出 {self.fade_out} 樣本超過片段長度 {length}，等比縮成 {fi} + {fo}")
            self.fade_in, self.fade_out = fi, fo
        fixed: list[GainPointV2] = []
        changed = False
        for p in self.envelope:
            at = max(0, min(p.at, length)) if length > 0 else max(0, p.at)
            db = min(max(p.db, GAIN_DB_MIN), GAIN_DB_MAX)
            changed = changed or at != p.at or db != p.db
            fixed.append(GainPointV2(at, db))
        ordered = sorted(fixed, key=lambda p: p.at)  # sorted 是穩定排序：同一個 at 的兩點（階梯）保留原順序
        if changed or ordered != fixed:
            warn(f"{where}: 自動化點超出片段範圍、dB 超界或未排序，已修正")
        self.envelope = ordered


@dataclass
class ClipAudioV2(ClipGainV2):
    """V1 片段自帶的原音（FCP 式元件）：跟著片段走，波紋編輯不必另外搬音訊（設計 §3.2 D3）。"""

    enabled: bool = True  # False = 原音靜音（「靜音原音」或已分離）
    detached_to: str | None = None  # 分離出去的 AudioClipV2.id；有值時 enabled 必為 False
    extra: dict[str, Any] = field(default_factory=dict)

    _KEYS = ("enabled", *_GAIN_KEYS, "detachedTo")

    def to_json(self) -> dict[str, Any]:
        d: dict[str, Any] = {"enabled": self.enabled, **self.gain_json()}
        if self.detached_to is not None:
            d["detachedTo"] = self.detached_to
        d.update(self.extra)
        return d

    @property
    def is_default(self) -> bool:
        """= DEFAULT_CLIP_AUDIO（啟用、0 dB、無淡化、無自動化、未分離）。"""
        return self.enabled and self.detached_to is None and self.is_neutral

    @classmethod
    def from_json(cls, d: Any, warn: Warn, where: str) -> "ClipAudioV2":
        if d is None:
            return cls()
        if not isinstance(d, dict):
            warn(f"{where}: audio 不是物件，改用預設（原音啟用、0 dB）")
            return cls()
        a = cls(enabled=_bool(d.get("enabled"), True), extra=_rest(d, cls._KEYS))
        a._load_gain(d, warn, where)
        dt = d.get("detachedTo")
        if dt is not None and (not isinstance(dt, str) or not dt):
            warn(f"{where}: detachedTo={dt!r} 不是字串，忽略")
            dt = None
        a.detached_to = dt
        return a


@dataclass
class VideoClipV2:
    id: str
    media_id: str
    src_in: int  # proxy 幀（含）
    src_out: int  # proxy 幀（不含）
    enabled: bool = True  # False = 停用：佔時間、輸出黑畫面與靜音（Resolve D／Premiere Enable）
    audio: ClipAudioV2 = field(default_factory=ClipAudioV2)
    label: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)
    kind: str = "clip"

    _KEYS = ("kind", "id", "mediaId", "srcIn", "srcOut", "enabled", "audio", "label")

    @property
    def length(self) -> int:
        """序列幀數（M2 不做變速：1 個 proxy 幀 = 1 個序列幀）。"""
        return self.src_out - self.src_in

    def to_json(self) -> dict[str, Any]:
        d: dict[str, Any] = {"kind": "clip", "id": self.id, "mediaId": self.media_id, "srcIn": self.src_in, "srcOut": self.src_out, "enabled": self.enabled, "audio": self.audio.to_json()}
        if self.label is not None:
            d["label"] = self.label
        d.update(self.extra)
        return d


@dataclass
class GapV2:
    """磁吸主軌上的空白（FCP Gap clip）：黑畫面＋靜音。"""

    id: str
    length: int  # 序列幀
    extra: dict[str, Any] = field(default_factory=dict)
    kind: str = "gap"

    _KEYS = ("kind", "id", "length")

    def to_json(self) -> dict[str, Any]:
        return {"kind": "gap", "id": self.id, "length": self.length, **self.extra}


@dataclass
class AudioSourceRefV2:
    """`{type:"media", mediaId}`（影片媒體的原音，分離出來的）或 `{type:"audio", audioId}`（純音訊媒體）。"""

    type: str
    ref_id: str  # 磁碟上是 mediaId / audioId
    extra: dict[str, Any] = field(default_factory=dict)

    @staticmethod
    def key_for(kind: str) -> str:
        return "mediaId" if kind == "media" else "audioId"

    def to_json(self) -> dict[str, Any]:
        return {"type": self.type, self.key_for(self.type): self.ref_id, **self.extra}

    @classmethod
    def from_json(cls, d: Any, warn: Warn, where: str) -> "AudioSourceRefV2 | None":
        if not isinstance(d, dict) or d.get("type") not in AUDIO_SOURCE_TYPES:
            warn(f"{where}: source={d!r} 不是 {{type: media|audio}}，丟棄片段")
            return None
        key = cls.key_for(d["type"])
        rid = d.get(key)
        if not isinstance(rid, str) or not rid:
            warn(f"{where}: source 缺 {key}，丟棄片段")
            return None
        return cls(d["type"], rid, _rest(d, ("type", key)))


@dataclass
class AudioClipV2(ClipGainV2):
    id: str = ""
    source: AudioSourceRefV2 | None = None
    start: int = 0  # 序列樣本
    length: int = 0  # 序列樣本，≥ 1
    src_in: int = 0  # 來源原生取樣率的樣本；0 = 音訊串流 start；可為負（前面補靜音）
    enabled: bool = True  # False = 片段靜音
    detached_from: str | None = None  # 從哪個 V1 片段分離出來
    label: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    _KEYS = ("id", "source", "start", "length", "srcIn", "enabled", *_GAIN_KEYS, "detachedFrom", "label")

    @property
    def end(self) -> int:
        return self.start + self.length

    def to_json(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "id": self.id,
            "source": self.source.to_json() if self.source else None,
            "start": self.start,
            "length": self.length,
            "srcIn": self.src_in,
            "enabled": self.enabled,
            **self.gain_json(),
        }
        if self.detached_from is not None:
            d["detachedFrom"] = self.detached_from
        if self.label is not None:
            d["label"] = self.label
        d.update(self.extra)
        return d


@dataclass
class AudioLaneV2:
    id: str
    name: str  # "A1 音樂"；可改名
    role: str = "other"
    muted: bool = False  # 靜音會影響輸出；獨奏只是監聽，不存檔（設計 D11）
    locked: bool = False
    sync_lock: bool = True  # V1 波紋編輯時要不要跟著移；音樂軌預設 False（設計 D10、§0.1 Q3）
    gain_db: float = 0.0  # 軌道推桿
    clips: list[AudioClipV2] = field(default_factory=list)  # 依 start 排序、不重疊
    extra: dict[str, Any] = field(default_factory=dict)

    _KEYS = ("id", "name", "role", "muted", "locked", "syncLock", "gainDb", "clips")

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "role": self.role,
            "muted": self.muted,
            "locked": self.locked,
            "syncLock": self.sync_lock,
            "gainDb": self.gain_db,
            "clips": [c.to_json() for c in self.clips],
            **self.extra,
        }


def default_sync_lock(role: str) -> bool:
    """音樂軌預設不跟著 V1 波紋移動：一刀剪掉 V1 中間 3 秒，墊樂應該停在原地（ai-music-cut mix.rs 的經驗）。"""
    return role != "music"


@dataclass
class SequenceV2:
    id: str
    name: str
    fps: Rational  # = V1 所有媒體的 proxy fps（M2 不做 conform）
    width: int  # 來源像素尺寸
    height: int
    sample_rate: int = SEQ_SAMPLE_RATE
    video: list[VideoClipV2 | GapV2] = field(default_factory=list)  # V1 磁吸主軌：位置 = 前面所有項目長度和
    original_muted: bool = False  # A0「原音」匯流排
    original_gain_db: float = 0.0
    audio_lanes: list[AudioLaneV2] = field(default_factory=list)
    edge_declick_ms: float = DEFAULT_EDGE_DECLICK_MS
    limiter: bool = False  # 預設關；估峰值 > −1 dBFS 時 render.plan 提示（§0.1 Q4）
    extra: dict[str, Any] = field(default_factory=dict)
    # 巢狀物件 original / audio 裡不認得的鍵也要保留（攤平成欄位後沒有別的地方放）
    original_extra: dict[str, Any] = field(default_factory=dict)
    audio_extra: dict[str, Any] = field(default_factory=dict)

    _KEYS = ("id", "name", "fps", "width", "height", "sampleRate", "video", "original", "audioLanes", "audio")

    def clip_by_id(self, clip_id: str) -> VideoClipV2 | AudioClipV2 | None:
        for it in self.video:
            if isinstance(it, VideoClipV2) and it.id == clip_id:
                return it
        for lane in self.audio_lanes:
            for c in lane.clips:
                if c.id == clip_id:
                    return c
        return None

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "fps": self.fps.to_json(),
            "width": self.width,
            "height": self.height,
            "sampleRate": self.sample_rate,
            "video": [it.to_json() for it in self.video],
            "original": {"muted": self.original_muted, "gainDb": self.original_gain_db, **self.original_extra},
            "audioLanes": [lane.to_json() for lane in self.audio_lanes],
            "audio": {"edgeDeclickMs": self.edge_declick_ms, "limiter": self.limiter, **self.audio_extra},
            **self.extra,
        }

    @classmethod
    def from_json(cls, d: Any, warn: Warn, media: dict[str, MediaV1], audio_media: dict[str, "AudioMediaV2"]) -> "SequenceV2 | None":
        """sanitize 規則表（設計 §3.5）。整條序列只有在「連 fps 都推不出來」時才丟（變回隱含序列）。"""
        from ..sequence.model import samples_of_frame  # 延遲 import：model 在模組層 import 本檔

        if not isinstance(d, dict):
            warn(f"sequence={d!r} 不是物件，視為隱含序列（null）")
            return None
        raw_video = d.get("video") if isinstance(d.get("video"), list) else []
        if d.get("video") is not None and not isinstance(d.get("video"), list):
            warn("sequence.video 不是陣列，清空")
        fps = Rational.from_json(d.get("fps"))
        if fps is not None and (fps.num <= 0 or fps.den <= 0):
            fps = None
        if fps is None:
            # 壞的 fps 用第一個片段媒體的 proxy fps 補（序列 fps 本來就等於 V1 媒體的 proxy fps）；補不出來才整條丟
            for raw in raw_video:
                m = media.get(raw.get("mediaId")) if isinstance(raw, dict) and isinstance(raw.get("mediaId"), str) else None
                if m is not None and m.proxy is not None:
                    fps = Rational(m.proxy.fps.num, m.proxy.fps.den)
                    break
            if fps is None:
                warn(f"sequence.fps={d.get('fps')!r} 無效且推不出來，整條序列丟棄（視為隱含序列）")
                return None
            warn(f"sequence.fps={d.get('fps')!r} 無效，改用 V1 媒體的 proxy fps {fps.num}/{fps.den}")
        width, height = _int(d.get("width")), _int(d.get("height"))
        if width is None or height is None or width <= 0 or height <= 0:
            warn(f"sequence 尺寸 {d.get('width')!r}x{d.get('height')!r} 無效，改為 0（輸出前會被 render.plan 擋下）")
            width, height = 0, 0
        if d.get("sampleRate") != SEQ_SAMPLE_RATE:
            warn(f"sequence.sampleRate={d.get('sampleRate')!r} 不是 {SEQ_SAMPLE_RATE}，改為 {SEQ_SAMPLE_RATE}")
        seq = cls(
            id=d["id"] if isinstance(d.get("id"), str) and d["id"] else "seq-1",
            name=_str(d.get("name")),
            fps=fps,
            width=width,
            height=height,
            extra=_rest(d, cls._KEYS),
        )

        # ---- V1 ----
        clip_media_warned: set[str] = set()
        for i, raw in enumerate(raw_video):
            where = f"sequence.video[{i}]"
            if not isinstance(raw, dict):
                warn(f"{where} 不是物件，丟棄")
                continue
            rid = raw.get("id") if isinstance(raw.get("id"), str) else ""
            kind = raw.get("kind")
            if kind == "gap":
                n = _int(raw.get("length"))
                if n is None or n < 1:
                    warn(f"{where}（空白 {rid}）length={raw.get('length')!r} 不是 ≥ 1 的整數，丟棄")
                    continue
                seq.video.append(GapV2(rid, n, _rest(raw, GapV2._KEYS)))
            elif kind == "clip":
                mid = raw.get("mediaId")
                if not isinstance(mid, str) or mid not in media:
                    warn(f"{where}（片段 {rid}）mediaId={mid!r} 不存在，丟棄")
                    continue
                a, b = _int(raw.get("srcIn")), _int(raw.get("srcOut"))
                if a is None or b is None or a < 0 or b <= a:
                    warn(f"{where}（片段 {rid}）來源範圍 [{raw.get('srcIn')!r}, {raw.get('srcOut')!r}) 不合法，丟棄")
                    continue
                m = media[mid]
                if m.proxy is not None and b > m.proxy.frames:
                    # proxy 以不同 fps 重建時片段會超界：保留並標離線，不能默默刪掉使用者的剪輯
                    warn(f"{where}（片段 {rid}）srcOut={b} 超過 {mid} 的 proxy 幀數 {m.proxy.frames}，保留並標為離線")
                if mid not in clip_media_warned:
                    if m.proxy is not None and not _frac_eq(m.proxy.fps, fps):
                        warn(f"媒體 {mid} 的 proxy fps {m.proxy.fps.num}/{m.proxy.fps.den} ≠ 序列 {fps.num}/{fps.den}：請以 {fps.num}/{fps.den} fps 重建 proxy")
                        clip_media_warned.add(mid)
                    elif m.source_size is not None and width and m.source_size != (width, height):
                        warn(f"媒體 {mid} 的尺寸 {m.source_size[0]}x{m.source_size[1]} ≠ 序列 {width}x{height}（M2 要求 V1 所有媒體同尺寸）")
                        clip_media_warned.add(mid)
                label = raw.get("label") if isinstance(raw.get("label"), str) else None
                seq.video.append(
                    VideoClipV2(rid, mid, a, b, _bool(raw.get("enabled"), True), ClipAudioV2.from_json(raw.get("audio"), warn, f"{where}.audio"), label, _rest(raw, VideoClipV2._KEYS))
                )
            else:
                warn(f"{where} kind={kind!r} 不是 clip／gap，丟棄")
        # 原音的淡化上限依片段在序列上的樣本長度 S(t1) − S(t0)，29.97 fps 時跟位置有關，所以要先排好位置
        t = 0
        for it in seq.video:
            if isinstance(it, VideoClipV2):
                n = samples_of_frame(t + it.length, fps) - samples_of_frame(t, fps)
                it.audio.sanitize_gain(n, warn, f"片段 {it.id} 的原音")
            t += it.length

        # ---- A0 / audio ----
        orig = d.get("original") if isinstance(d.get("original"), dict) else {}
        seq.original_muted = _bool(orig.get("muted"), False)
        seq.original_gain_db = _db(orig.get("gainDb"))
        if orig.get("gainDb") is not None and orig.get("gainDb") != seq.original_gain_db:
            warn(f"A0 原音推桿 gainDb={orig.get('gainDb')!r} 超出 [{GAIN_DB_MIN:g}, {GAIN_DB_MAX:g}] 或無效，改為 {seq.original_gain_db:g}")
        seq.original_extra = _rest(orig, ("muted", "gainDb"))
        aud = d.get("audio") if isinstance(d.get("audio"), dict) else {}
        ms = _num(aud.get("edgeDeclickMs"), DEFAULT_EDGE_DECLICK_MS)
        if ms is None or ms < 0:
            warn(f"sequence.audio.edgeDeclickMs={aud.get('edgeDeclickMs')!r} 無效，改為 {DEFAULT_EDGE_DECLICK_MS:g}")
            ms = DEFAULT_EDGE_DECLICK_MS
        seq.edge_declick_ms = float(ms)
        seq.limiter = _bool(aud.get("limiter"), False)
        seq.audio_extra = _rest(aud, ("edgeDeclickMs", "limiter"))

        # ---- A1…An ----
        raw_lanes = d.get("audioLanes") if isinstance(d.get("audioLanes"), list) else []
        lane_ids: set[str] = set()
        for li, raw_lane in enumerate(raw_lanes):
            if not isinstance(raw_lane, dict):
                warn(f"sequence.audioLanes[{li}] 不是物件，丟棄")
                continue
            role = _enum(raw_lane.get("role"), AUDIO_ROLES, "other", warn, f"音軌 {li}.role") or "other"
            lid = raw_lane.get("id") if isinstance(raw_lane.get("id"), str) and raw_lane["id"] else ""
            if not lid or lid in lane_ids:
                new = _unique_id("lane", lane_ids | {x.get("id") for x in raw_lanes if isinstance(x, dict) and isinstance(x.get("id"), str)})
                warn(f"音軌 {li} 的 id={lid!r} 缺少或重複，改為 {new!r}")
                lid = new
            lane_ids.add(lid)
            lane = AudioLaneV2(
                id=lid,
                name=_str(raw_lane.get("name"), f"A{len(seq.audio_lanes) + 1}"),
                role=role,
                muted=_bool(raw_lane.get("muted"), False),
                locked=_bool(raw_lane.get("locked"), False),
                sync_lock=_bool(raw_lane.get("syncLock"), default_sync_lock(role)),
                gain_db=_db(raw_lane.get("gainDb")),
                extra=_rest(raw_lane, AudioLaneV2._KEYS),
            )
            if raw_lane.get("gainDb") is not None and raw_lane.get("gainDb") != lane.gain_db:
                warn(f"音軌 {lid} 推桿 gainDb={raw_lane.get('gainDb')!r} 超出 [{GAIN_DB_MIN:g}, {GAIN_DB_MAX:g}] 或無效，改為 {lane.gain_db:g}")
            clips: list[AudioClipV2] = []
            for ci, raw_clip in enumerate(raw_lane.get("clips") if isinstance(raw_lane.get("clips"), list) else []):
                c = _audio_clip_from_json(raw_clip, warn, f"音軌 {lid} clips[{ci}]", media, audio_media)
                if c is not None:
                    clips.append(c)
            clips.sort(key=lambda c: c.start)
            for c in clips:
                if lane.clips and lane.clips[-1].end > c.start:
                    prev = lane.clips[-1]
                    warn(f"音軌 {lid}：片段 {c.id}（{c.start}–{c.end}）與 {prev.id}（{prev.start}–{prev.end}）重疊，丟棄後者")
                    continue
                lane.clips.append(c)
            seq.audio_lanes.append(lane)

        # ---- id 唯一（V1＋所有軌）----
        all_ids: set[str] = {it.id for it in seq.video if it.id} | {c.id for lane in seq.audio_lanes for c in lane.clips if c.id}
        taken: set[str] = set()
        items: list[VideoClipV2 | GapV2 | AudioClipV2] = [*seq.video, *(c for lane in seq.audio_lanes for c in lane.clips)]
        for it in items:
            if it.id and it.id not in taken:
                taken.add(it.id)
                continue
            base = it.id or ("gap" if isinstance(it, GapV2) else "clip" if isinstance(it, VideoClipV2) else "aclip")
            new = _unique_id(base, taken | all_ids)
            warn(f"序列片段 id={it.id!r} {'重複' if it.id else '缺少'}，重新發號為 {new!r}")
            it.id = new
            taken.add(new)

        # ---- 分離參照 ----
        audio_ids = {c.id for lane in seq.audio_lanes for c in lane.clips}
        video_clip_ids = {it.id for it in seq.video if isinstance(it, VideoClipV2)}
        for it in seq.video:
            if not isinstance(it, VideoClipV2) or it.audio.detached_to is None:
                continue
            if it.audio.detached_to not in audio_ids:
                warn(f"片段 {it.id} 的 detachedTo={it.audio.detached_to!r} 不存在，清掉並恢復原音")
                it.audio.detached_to = None
                it.audio.enabled = True
            elif it.audio.enabled:
                # 分離出去的音訊片段還在軌上：原音再響一次會變成兩份疊在一起
                warn(f"片段 {it.id} 已分離到 {it.audio.detached_to} 但原音仍啟用，改為靜音")
                it.audio.enabled = False
        for lane in seq.audio_lanes:
            for c in lane.clips:
                if c.detached_from is not None and c.detached_from not in video_clip_ids:
                    warn(f"音訊片段 {c.id} 的 detachedFrom={c.detached_from!r} 不存在，清掉")
                    c.detached_from = None
        return seq


def _unique_id(base: str, taken: set[Any]) -> str:
    n = 2
    while f"{base}-{n}" in taken:
        n += 1
    return f"{base}-{n}"


def _audio_clip_from_json(d: Any, warn: Warn, where: str, media: dict[str, MediaV1], audio_media: dict[str, "AudioMediaV2"]) -> AudioClipV2 | None:
    if not isinstance(d, dict):
        warn(f"{where} 不是物件，丟棄")
        return None
    rid = d.get("id") if isinstance(d.get("id"), str) else ""
    where = f"{where}（{rid}）" if rid else where
    src = AudioSourceRefV2.from_json(d.get("source"), warn, where)
    if src is None:
        return None
    info: AudioInfoV2 | None
    if src.type == "media":
        m = media.get(src.ref_id)
        if m is None:
            warn(f"{where}: 來源媒體 {src.ref_id!r} 不存在，丟棄")
            return None
        info = m.audio
    else:
        am = audio_media.get(src.ref_id)
        if am is None:
            warn(f"{where}: 來源音訊 {src.ref_id!r} 不存在，丟棄")
            return None
        info = am.audio
    start, length, src_in = _sample(d.get("start")), _sample(d.get("length")), _sample(d.get("srcIn") if d.get("srcIn") is not None else 0)
    native = info.sample_rate if info is not None else SEQ_SAMPLE_RATE
    if start is None or start < 0 or length is None or length < 1 or src_in is None or src_in < -MAX_NEGATIVE_SRC_IN_SECONDS * native:
        warn(f"{where}: start={d.get('start')!r} length={d.get('length')!r} srcIn={d.get('srcIn')!r} 不合法（start ≥ 0、length ≥ 1、srcIn ≥ −10 秒），丟棄")
        return None
    c = AudioClipV2(id=rid, source=src, start=start, length=length, src_in=src_in, enabled=_bool(d.get("enabled"), True), extra=_rest(d, AudioClipV2._KEYS))
    c._load_gain(d, warn, where)
    c.sanitize_gain(length, warn, where)
    df = d.get("detachedFrom")
    c.detached_from = df if isinstance(df, str) and df else None
    c.label = d.get("label") if isinstance(d.get("label"), str) else None
    return c


@dataclass
class AudioInfoV2:
    """衍生的音訊時間資訊（引擎 audio.v1.json 的摘要，`aivc.media.audio_info`）：可重生、不進 undo、缺了就標 stale 重算。"""

    codec: str
    sample_rate: int
    channels: int
    channel_layout: str | None
    start_us: int  # 第一個解碼樣本的容器絕對時間（µs）；mp3 的 LAME 延遲會出現在這裡
    video_start_us: int | None  # 影片第一幀 pts（µs）；純音訊檔為 None
    n_samples: int  # 以 pts 對齊並補滿斷層後的原生樣本數
    gaps: list[tuple[int, int]] = field(default_factory=list)  # (at_us, dur_us)，> 20 ms 的 pts 斷層
    extra: dict[str, Any] = field(default_factory=dict)

    _KEYS = ("codec", "sampleRate", "channels", "channelLayout", "startUs", "videoStartUs", "nSamples", "gaps")

    def to_json(self) -> dict[str, Any]:
        return {
            "codec": self.codec,
            "sampleRate": self.sample_rate,
            "channels": self.channels,
            "channelLayout": self.channel_layout,
            "startUs": self.start_us,
            "videoStartUs": self.video_start_us,
            "nSamples": self.n_samples,
            "gaps": [{"atUs": a, "durUs": b} for a, b in self.gaps],
            **self.extra,
        }

    @classmethod
    def from_json(cls, d: Any, warn: Warn, where: str) -> "AudioInfoV2 | None":
        if not isinstance(d, dict):
            warn(f"{where} 不是物件，視為缺快取（會重算）")
            return None
        sr, ch, n, start = _int(d.get("sampleRate")), _int(d.get("channels")), _int(d.get("nSamples")), _int(d.get("startUs"))
        vs_raw = d.get("videoStartUs")
        vs = _int(vs_raw) if vs_raw is not None else None
        if sr is None or sr <= 0 or ch is None or ch <= 0 or n is None or n < 0 or start is None or (vs_raw is not None and vs is None):
            warn(f"{where} 欄位不完整（sampleRate／channels／nSamples／startUs／videoStartUs），視為缺快取（會重算）")
            return None
        gaps: list[tuple[int, int]] = []
        for g in d.get("gaps") if isinstance(d.get("gaps"), list) else []:
            at, dur = (_int(g.get("atUs")), _int(g.get("durUs"))) if isinstance(g, dict) else (None, None)
            if at is None or dur is None or dur <= 0:
                warn(f"{where}.gaps 有壞項 {g!r}，丟棄")
                continue
            gaps.append((at, dur))
        layout = d.get("channelLayout")
        return cls(_str(d.get("codec")), sr, ch, layout if isinstance(layout, str) else None, start, vs, n, gaps, _rest(d, cls._KEYS))


@dataclass
class AudioMediaV2:
    """純音訊媒體（音樂／旁白／音效檔）。和 `media[]` 分開：現有程式大量假設 media 是有 proxy、有 track 的影片（設計 §3.2）。"""

    id: str  # "a-" + 指紋前 16 碼
    path: str
    name: str = ""
    fingerprint: str = ""
    probe: dict[str, Any] | None = None  # Rust MediaProbe，這裡不解析
    role: str = "other"
    audio: AudioInfoV2 | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    _KEYS = ("id", "path", "name", "fingerprint", "probe", "role", "audio")

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "path": self.path,
            "name": self.name,
            "fingerprint": self.fingerprint,
            "probe": self.probe,
            "role": self.role,
            "audio": self.audio.to_json() if self.audio is not None else None,
            **self.extra,
        }

    @classmethod
    def from_json(cls, d: Any, warn: Warn) -> "AudioMediaV2 | None":
        if not isinstance(d, dict) or not isinstance(d.get("id"), str) or not d["id"]:
            warn("audioMedia 項目缺 id，丟棄")
            return None
        path = d.get("path")
        if not isinstance(path, str) or not path:
            # 與 TS sanitizeAudioMedia 同規則：沒有路徑的音訊媒體什麼都做不了（渲染找不到輸入），留著只會讓兩邊讀出不同的專案
            warn(f"audioMedia {d['id']} 缺 path，丟棄")
            return None
        where = f"audioMedia {d['id']}"
        probe = d.get("probe") if isinstance(d.get("probe"), dict) else None
        audio = AudioInfoV2.from_json(d.get("audio"), warn, f"{where}.audio") if d.get("audio") is not None else None
        name = d.get("name")
        return cls(
            d["id"],
            path,
            # 沒寫 name 就用檔名（TS 也是 path 最後一段、兩種斜線都切）：UI 顯示與兩邊寫出的檔案才一致
            name if isinstance(name, str) and name else re.split(r"[\\/]", path)[-1],
            _str(d.get("fingerprint")),
            probe,
            _enum(d.get("role"), AUDIO_ROLES, "other", warn, f"{where}.role") or "other",
            audio,
            _rest(d, cls._KEYS),
        )


@_accept_ext_kwargs
@dataclass
class ProjectFile(_ExtAttrs):
    media: list[MediaV1] = field(default_factory=list)
    active_media_id: str | None = None
    profile: str = "cards"
    shots: dict[str, list[ShotV1]] = field(default_factory=dict)
    tracks: dict[str, list[TrackV1]] = field(default_factory=dict)
    insert_defaults: InsertV1 = field(default_factory=InsertV1.defaults)
    export_defaults: ExportDefaultsV1 = field(default_factory=ExportDefaultsV1)
    # 動態字幕（feat/captions）：Record<mediaId, CaptionTrackV1>，camelCase dict 原樣保存（驗證在 captions/model.py，
    # 鏡射 TS sanitizeCaptions）。可省略的欄位、不升 schemaVersion：舊檔沒有這個鍵照樣讀；空的時候**不寫**這個鍵，
    # 沒有字幕的專案存回去跟以前逐位元相同。
    captions: dict[str, dict[str, Any]] = field(default_factory=dict)
    app: str = APP_NAME
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)
    # 讀檔時檔案上寫的版本（診斷用）。**寫檔不看它**：to_json 一律用 written_version()，
    # 否則引擎自己建的專案（run／detect）預設 2、什麼序列都沒有也會寫成 v2，v0.0.6 就打不開（§4.3）。
    schema_version: int = SCHEMA_VERSION
    extra: dict[str, Any] = field(default_factory=dict)
    # ---- schema v2（設計 §3.3）----
    # None = 隱含序列（目前媒體整段、未剪）；第一次剪輯時才由 App 實體化。
    sequence: SequenceV2 | None = None
    audio_media: list[AudioMediaV2] = field(default_factory=list)
    # 外掛欄位（hooks.SchemaField，owner "project"）：外掛認領的頂層鍵解析後放這裡，`project.<attr>` 直接讀寫
    ext: dict[str, Any] = field(default_factory=dict)

    _EXT_OWNER = "project"
    _KEYS = ("schemaVersion", "app", "createdAt", "updatedAt", "media", "activeMediaId", "profile", "shots", "tracks", "insertDefaults", "exportDefaults", "captions", "sequence", "audioMedia")

    def written_version(self) -> int:
        """寫進檔案的版本（§4.3 最低版本寫檔）；與 TS `writtenSchemaVersion` 同一條規則。"""
        return written_version(self)

    def audio_media_by_id(self, audio_id: str) -> AudioMediaV2 | None:
        return next((a for a in self.audio_media if a.id == audio_id), None)

    # ---- 便利查詢 ----
    def media_by_id(self, media_id: str) -> MediaV1 | None:
        return next((m for m in self.media if m.id == media_id), None)

    def active_media(self) -> MediaV1 | None:
        if self.active_media_id:
            return self.media_by_id(self.active_media_id)
        return self.media[0] if self.media else None

    def track_by_id(self, media_id: str, track_id: str) -> TrackV1 | None:
        return next((t for t in self.tracks.get(media_id, []) if t.id == track_id), None)

    def to_json(self) -> dict[str, Any]:
        written = written_version(self)
        core: list[tuple[str, Any]] = [
            ("schemaVersion", written),
            ("app", self.app),
            ("createdAt", self.created_at),
            ("updatedAt", self.updated_at),
            ("media", [m.to_json() for m in self.media]),
            ("activeMediaId", self.active_media_id),
            ("profile", self.profile),
            ("shots", {k: [s.to_json() for s in v] for k, v in self.shots.items()}),
            ("tracks", {k: [t.to_json() for t in v] for k, v in self.tracks.items()}),
            ("insertDefaults", self.insert_defaults.to_json()),
            ("exportDefaults", self.export_defaults.to_json()),
        ]
        if self.captions:
            core.append(("captions", self.captions))
        # 寫 1 時 sequence／audioMedia 兩個鍵整個省略（不是寫 null）：v0.0.6 不認得它們（鍵順序同 TS buildProjectFile）
        if written == 2:
            core.append(("sequence", self.sequence.to_json() if self.sequence is not None else None))
            core.append(("audioMedia", [a.to_json() for a in self.audio_media]))
        return _emit(core, self._EXT_OWNER, self.ext, self.extra)

    @classmethod
    def from_json(cls, d: Any, warn: Warn) -> "ProjectFile":
        if not isinstance(d, dict):
            raise OpError("Invalid", "專案檔不是 JSON 物件")
        ver = d.get("schemaVersion")
        if _int(ver) is None:
            raise OpError("Invalid", f"專案檔缺 schemaVersion（{ver!r}）", "這不是 *.aivc.json 專案檔")
        if int(ver) > SCHEMA_VERSION:
            raise OpError("Invalid", f"專案檔 schemaVersion={ver} 比引擎支援的 {SCHEMA_VERSION} 新", "請更新 AI Video Cut")
        media = [m for m in (MediaV1.from_json(x, warn) for x in d.get("media") or []) if m is not None]
        media_ids = {m.id for m in media}
        max_frames: dict[str, int | None] = {m.id: (m.proxy.frames if m.proxy else None) for m in media}

        def per_media(raw: Any, section: str, parse: Callable[[Any, int | None], Any]) -> dict[str, list[Any]]:
            """Record<mediaId, []> 的通用解析（外掛的同形欄位也用這個：同一份警告字句）。"""
            out: dict[str, list[Any]] = {}
            if raw is None:
                return out
            if not isinstance(raw, dict):
                warn(f"{section} 不是 Record<mediaId, []>，忽略")
                return out
            for mid, items in raw.items():
                if mid not in media_ids:
                    warn(f"{section}[{mid!r}] 指向不存在的 media，保留但無法驗證幀範圍")
                if not isinstance(items, list):
                    warn(f"{section}[{mid!r}] 不是陣列，忽略")
                    continue
                parsed = [parse(x, max_frames.get(mid)) for x in items]
                out[mid] = [x for x in parsed if x is not None]
            return out

        shots = per_media(d.get("shots"), "shots", lambda x, mf: ShotV1.from_json(x, warn, mf))
        tracks = per_media(d.get("tracks"), "tracks", lambda x, mf: TrackV1.from_json(x, warn, mf))
        env = ProjectParseEnv(media_ids, max_frames, shots, tracks, {}, per_media)
        env.ext.update(_parse_ext(cls._EXT_OWNER, d, warn, env, phase="early"))
        # 交叉檢查：track 指向的 shot 要存在（只警告不丟，UI 可修）；外掛的逐 track 檢查（hooks track-check）接在後面，
        # 同一條 track 的警告排在一起
        from .. import hooks

        checks = hooks.track_checks()
        for mid, ts in tracks.items():
            shot_by_id = {s.id: s for s in shots.get(mid, [])}
            for t in ts:
                if t.shot_id and t.shot_id not in shot_by_id:
                    warn(f"track {t.id} 的 shotId={t.shot_id!r} 不存在於 shots[{mid!r}]")
                elif t.frame_range is not None and t.shot_id in shot_by_id:
                    # object track 的 shotId ＝ 範圍起點所在的鏡頭（只警告：UI 可修，渲染只看 range）
                    sh = shot_by_id[t.shot_id]
                    if not sh.start_frame <= t.frame_range[0] < sh.end_frame:
                        warn(f"track {t.id} 的 range 起點 {t.frame_range[0]} 不在 shot {sh.id} [{sh.start_frame}, {sh.end_frame}) 裡")
                for check in checks:
                    check(t, mid, env, warn)
        active = d.get("activeMediaId")
        if active is not None and active not in media_ids:
            warn(f"activeMediaId={active!r} 不存在，改為 {'第一個 media' if media else 'null'}")
            active = media[0].id if media else None
        profile = _enum(d.get("profile"), PROFILES, "cards", warn, "profile") or "cards"
        from ..captions.model import sanitize_captions  # 零重依賴模組；放函式內避免 project ↔ captions 循環 import

        captions = sanitize_captions(d.get("captions"), max_frames, warn)

        # ---- schema v2：audioMedia 先解（序列裡的音訊片段要查來源存不存在），再解 sequence ----
        # v1 檔沒有這兩個鍵 → sequence=None、audio_media=[]。有鍵就照解、不看版本號：TS migrate 的 toV2 也是
        # `isRecord(doc.sequence) ? doc.sequence : null`，兩邊對同一份檔案才會得到同一個序列。
        audio_media: list[AudioMediaV2] = []
        raw_am = d.get("audioMedia")
        if raw_am is not None and not isinstance(raw_am, list):
            warn("audioMedia 不是陣列，忽略")
            raw_am = []
        seen_am: set[str] = set()
        for x in raw_am or []:
            am = AudioMediaV2.from_json(x, warn)
            if am is None:
                continue
            if am.id in seen_am:
                # 片段用 id 找來源；兩筆同 id 時後面那筆永遠找不到，留著只會讓 UI 顯示一個點不到的檔案
                warn(f"audioMedia id={am.id!r} 重複，丟棄後者")
                continue
            seen_am.add(am.id)
            audio_media.append(am)
        media_by_id = {m.id: m for m in media}
        sequence = None
        if d.get("sequence") is not None:
            sequence = SequenceV2.from_json(d.get("sequence"), warn, media_by_id, {a.id: a for a in audio_media})
        # 外掛的 late 欄位：序列之後、insertDefaults 之前（外掛化之前牌組設定就在這個位置解析）
        env.ext.update(_parse_ext(cls._EXT_OWNER, d, warn, env, phase="late"))
        return cls(
            media=media,
            active_media_id=active if isinstance(active, str) else None,
            profile=profile,
            shots=shots,
            tracks=tracks,
            insert_defaults=resolve_insert(None, InsertV1.from_json(d.get("insertDefaults"), warn, "insertDefaults") or InsertV1.defaults()),
            export_defaults=ExportDefaultsV1.from_json(d.get("exportDefaults"), warn),
            captions=captions,
            app=_str(d.get("app"), APP_NAME),
            created_at=_str(d.get("createdAt"), now_iso()),
            updated_at=_str(d.get("updatedAt"), now_iso()),
            schema_version=int(ver),
            extra=_rest_anchored(d, cls._KEYS + _ext_keys(cls._EXT_OWNER)),
            sequence=sequence,
            audio_media=audio_media,
            ext=env.ext,
        )


# 設計 §3.3：類別改名 ProjectFile 後保留舊名別名。project/__init__.py、ops、字幕與測試都還 import ProjectFileV1，
# 少了這行整個 aivc.project 會在 import 時就炸（WIP 草稿漏掉，合併 main 的字幕程式後更多呼叫端依賴它）。
ProjectFileV1 = ProjectFile


def written_version(p: ProjectFile) -> int:
    """最低版本寫檔（設計 §4.3）：有實體化的序列或任何音訊媒體才寫 2，否則寫 1。

    為什麼：App 每 2 秒自動存檔，引擎的 run／detect 也會寫專案檔。沒有這條規則的話，新版打開舊專案什麼都沒剪，
    檔案就被悄悄升成 v2，退回 v0.0.6 會被「較新版本」擋在門外。字幕不算 v2 功能（main 加字幕時沒升版號）。
    與 TS `writtenSchemaVersion` 同一條規則。
    """
    return 2 if (p.sequence is not None or p.audio_media) else 1


# ---------------------------------------------------------------- load / save


@dataclass
class LoadResult:
    project: ProjectFileV1
    warnings: list[str]
    path: Path | None = None


def loads(text: str) -> LoadResult:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        raise OpError("Invalid", f"專案檔不是合法 JSON：{e}") from e
    warnings: list[str] = []
    project = ProjectFileV1.from_json(data, warnings.append)
    return LoadResult(project, warnings)


def load(path: str | os.PathLike[str]) -> LoadResult:
    p = Path(path)
    if not p.is_file():
        raise OpError("Io", f"找不到專案檔：{p}")
    try:
        # 退避重試：另一條 lane / App 正在 os.replace 這個檔時，Windows 會短暫擋住開檔（B-06）
        text = atomic.read_text(p)
    except UnicodeDecodeError as e:
        raise OpError("Invalid", f"專案檔不是 UTF-8：{p}") from e
    except OSError as e:
        raise OpError("Io", f"讀取專案檔失敗：{e}") from e
    r = loads(text)
    r.path = p
    return r


def dumps(project: ProjectFileV1) -> str:
    """JS `JSON.stringify(x, null, 2)` 同款縮排；非 ASCII 原樣寫（UTF-8）。"""
    return json.dumps(project.to_json(), ensure_ascii=False, indent=2) + "\n"


def save(project: ProjectFileV1, path: str | os.PathLike[str], *, touch_updated_at: bool = True) -> Path:
    """原子寫入：先寫**唯一**的 `.part` 再 rename，半途被砍不會留下壞掉的專案檔。

    暫存名帶 pid + 亂數、換入時退避重試（`aivc.atomic`）：輕量 lane 的 `render.plan` 可能正在
    `read_text` 同一個專案檔，固定暫存名會互搬、`os.replace` 會撞 WinError 5／32（B-06）。
    """
    p = Path(path)
    if touch_updated_at:
        project.updated_at = now_iso()
    try:
        atomic.write_text(p, dumps(project))
    except OSError as e:
        raise OpError("Io", f"寫入專案檔失敗：{e}") from e
    return p
