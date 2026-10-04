"""插入 Insert 參數（計畫 §6.6 參數表；語意對齊 Nuke CornerPin2D / BCC Corner Pin Studio / Mocha Insert Module）。

- 預設值＝表格的「720p・30fps・VP9・固定機位」欄。
- 三段巨集 conservative / standard / full（表格「巨集」列）：`macro_overrides()`。
- `from_dict(d, base)`：專案檔的 `insert` 物件（camelCase，`null` 欄位＝繼承）與 CLI 旗標（snake_case）
  都吃；合併順序 = base（預設或 insertDefaults）→ 巨集 → 明確欄位。None 一律視為「沒指定」。
- 百分比欄位（opacity / applyMix / keepHighlights / grain.amount）內部存 0..1；輸入 >1 視為百分數（95 → 0.95）。

單位說明（實作時決定，表格沒寫清楚的地方）：
- 邊緣 choke / softness、遮擋 dilate / feather、墨膨脹 inkDilate、動態模糊 deadband 全部是**幀像素**：
  它們要對付的是觀測端（720p 編碼）的模糊半徑，與模板解析度無關。
- shadingBlurSigma 是「牌短邊的比例」，在工作模板空間換成各向異性 sigma（模板通常被透視壓扁）。
- Lens / Light Wrap 兩列 v1 OFF，不在此。Smoothing 列屬追蹤器（track 模組）；為了讓表格完整、
  from_dict 能整份吃進來，這裡仍保留 `SmoothingParams`，但合成器只用其中的 hold_below_conf（render 路徵另讀
  coarse_from_mask / fade_frames 做優雅退化）。
- A4 pull-forward 新增：`relight.excludeObservedInk / observedInkChroma / observedInkDark`（光影估計排除觀測到的真墨）、
  `smoothing.coarseFromMask / fadeFrames`。預設值全部由範例第 3 段 k=1091 量測而來（plugins/cards/docs/measurements.md「A4 pull-forward」）。
- 外掛可以登記自己的群組（`aivc.hooks.ParamGroup`：欄位、預設、enum／範圍、整體驗證）：解析、巨集合併、驗證、to_dict
  都跟核心群組同一套規則；沒有外掛時那些鍵就是未知鍵。
"""
from __future__ import annotations

import math
import re
from dataclasses import MISSING, asdict, dataclass, field, fields, is_dataclass, replace
from typing import Any, Literal

ShutterPhase = Literal["centered", "start", "end", "custom"]
Falloff = Literal["linear", "smoothstep"]
Kernel = Literal["nearest", "bilinear", "bicubic", "lanczos3"]
SheenLock = Literal["plate", "card"]
ShadingSource = Literal["auto", "template-ratio", "lowpass-mean"]
GrainMode = Literal["measured", "synthetic"]
RegionPolicy = Literal["full", "keepBarcode", "hold"]
Macro = Literal["conservative", "standard", "full", "custom"]

MACROS: tuple[str, ...] = ("conservative", "standard", "full")


@dataclass(frozen=True)
class MotionBlurParams:
    """Nuke `shutter=0.5` 幀 ＝ 180°；UI 用角度、內部換算幀（shutter_frames = angle/360）。

    shutter_angle "auto"：用**追蹤時量到的來源動態模糊**（track.extra.edgecard.motionSmearDeg，
    `EC.measure_motion_smear`：快速幀的牌緣剖面擬合 step⊛box(m)⊛gauss(σ) → m/(|n·u|·|d|)）。
    render 在合成前解析成角度，量不到就留 180°。為什麼需要：180° 是電影快門的慣例，不是這支素材的事實——
    clip 125 量到的來源拖尾只有 0.21–0.31 幀（≈75–110°），照 180° 印會比牌本身糊 1.6–2.4 倍（plugins/cards/docs/measurements.md「手接觸」）。

    max_step_px：樣本沿運動路徑的**間距上限**（幀 px）。n = clamp(ceil(path / max_step_px), 1, max_samples)。
    為什麼是間距而不是「樣本數上限」：舊寫法 n = clamp(ceil(path), 1, 9) 在 path > 9 px 時把間距撐到 1.2–3.6 px，
    墨邊（σ≈0.62 px）在這種間距下不會互相蓋住 → 使用者看到的「兩三層錯開的重影」（clip 125 k=50 Banker1 間距 3.58 px，
    與連續線積分差 22 碼；反卷積量到 8–9 個分離的峰）。
    0.5 px 的來源：拿「同一條 H 路徑、間距 0.125 px（≈連續線積分）」當參考量 |Y−Y_連續|（plugins/cards/docs/measurements.md「手接觸」）——
    間距 1.0 → 最差 19 碼、6 幀 > 8 碼；0.5 → 最差 5 碼、0 幀 > 8 碼；0.25 → 最差 1 碼但再慢 24%。取 0.5。
    小 n 的誤差其實不是梳狀漣漪而是**中點法的支撐不足**（n 個中點涵蓋 path·(1−1/n)，n=2 只有一半），所以間距要壓在
    deadband（0.7 px）以下，path 一旦值得糊就至少有 2 個樣本。
    """

    enabled: bool | Literal["auto"] = "auto"  # auto：位移×快門 < deadband 時退化成單次 warp
    shutter_angle: float | Literal["auto"] = 180.0
    shutter_phase: ShutterPhase = "centered"
    shutter_offset: float = 0.0  # 只在 phase=custom 用：快門開啟時刻（幀，相對 k）
    samples: int | Literal["auto"] = "auto"  # auto = clamp(ceil(path / max_step_px), 1, max_samples)
    max_samples: int = 64  # 安全閥（路徑 > 32 px＝甩鏡才會碰到）；舊值 9 是重影的來源
    max_step_px: float = 0.5  # 樣本間距上限（幀 px）
    deadband_px: float = 0.7

    @property
    def shutter_frames(self) -> float:
        """"auto" 在 render 解析（`ops/render.py`）；這裡的後備值是慣例的 180°，讓沒接上的呼叫端不會炸。"""
        a = self.shutter_angle
        return 180.0 / 360.0 if a == "auto" else float(a) / 360.0


@dataclass(frozen=True)
class EdgeParams:
    """BCC Edge Choke / Softness / Falloff；choke 往內縮（幀 px），softness 是過渡帶寬（幀 px）。"""

    choke: float = 0.6
    softness: float = 0.8
    falloff: Falloff = "linear"


@dataclass(frozen=True)
class OcclusionParams:
    """遮擋物（手）的邊緣與插入邊緣分開調：720p VP9 的手比紙邊軟。dilate 是把遮擋物長大，feather 是高斯羽化寬度。"""

    dilate: float = 1.0
    feather: float = 1.2


@dataclass(frozen=True)
class CompMixParams:
    """opacity 給 A/B 與漸變；apply_mix 0 ＝ hold（不替換）。v1 只有 normal 混合。"""

    opacity: float = 1.0
    apply_mix: float = 1.0
    blend_mode: Literal["normal"] = "normal"


@dataclass(frozen=True)
class ResampleParams:
    """Mocha Insert Render Resampling / Nuke filter+clamp。supersample auto = 2×近景、3×遠景。"""

    supersample: int | Literal["auto"] = "auto"
    kernel: Kernel = "lanczos3"
    clamp: bool = True
    downsample: Literal["area"] = "area"  # INTER_AREA；只有一種，留欄位是為了表格對齊


@dataclass(frozen=True)
class RelightParams:
    shading_blur_sigma: float = 0.015  # 牌短邊比例（1.5%）
    ink_dilate: float = 2.0  # 幀 px：排除墨邊在觀測裡的暈開
    keep_highlights: float = 1.0  # 「保留高光」＝ spec add-back 強度
    sheen_lock: SheenLock = "plate"  # plate：反光跟著鏡頭（逐幀估）；card：反光鎖在牌上（用參考幀的 spec）
    shading_source: ShadingSource = "auto"  # auto：有原模板→template-ratio，否則 lowpass-mean（generic profile）
    # A4：光影估計要連「觀測到的真墨」一起排除（真印刷與模板字形沒對齊，只排模板墨會讓真墨漏進 S → 新牌面上出現原墨鬼影）。
    exclude_observed_ink: bool = True
    observed_ink_chroma: float = 0.05  # 與局部紙色的色度座標差（每通道 max |c − c_paper|）超過此值 → 墨
    observed_ink_dark: float = 0.6  # 亮度低於局部紙亮度 × 此值 → 墨


@dataclass(frozen=True)
class GrainParams:
    mode: GrainMode = "measured"
    amount: float = 1.0
    blocky8x8: bool = True
    per_frame_seed: bool = True
    apply_through_alpha_only: bool = True


@dataclass(frozen=True)
class SmoothingParams:
    """追蹤器的平滑參數（表格「平滑」列）。合成器只讀 hold_below_conf；其餘由 track 模組消費。"""

    savgol_window: int = 9
    savgol_order: int = 2
    static_lock_px: float = 0.3
    static_lock_frames: int = 5
    hold_below_conf: float = 0.35
    # A4：conf < hold_below_conf 時的優雅退化（render 路徑，comp/fallback.py）：
    # coarse_from_mask ＝ SAM 遮罩仍在且四角合理（IoU 閘門＋內部像紙）→ 用遮罩四角合成（state "coarse"）；
    # fade_frames ＝ 什麼都不合理時用上一個好 H 把 alpha 在 N 幀內漸變到 0（計畫「2 幀 alpha 漸變」），而不是瞬間跳回原牌面。
    coarse_from_mask: bool = True
    fade_frames: int = 2


def _param_groups() -> list[Any]:
    """外掛登記的參數群組（hooks.ParamGroup），登記順序。"""
    from .. import hooks

    return hooks.param_groups()


@dataclass(frozen=True, init=False)
class InsertParams:
    """核心群組是固定欄位；外掛群組（`hooks.ParamGroup`，例如外掛登記的 `fooBar` → `foo_bar`）放在 `ext`，
    但用起來跟欄位一樣：`params.foo_bar`、`dataclasses.replace(params, foo_bar=…)`、`from_dict({"fooBar": …})`、
    `to_dict()` 的鍵順序（核心群組 → 外掛群組依登記順序 → region_policy）都與外掛化之前相同。
    沒有登記的群組名一律當未知鍵（from_dict 擲 ValueError、建構子擲 TypeError）。"""

    macro: Macro = "standard"
    motion_blur: MotionBlurParams = field(default_factory=MotionBlurParams)
    edge: EdgeParams = field(default_factory=EdgeParams)
    occlusion: OcclusionParams = field(default_factory=OcclusionParams)
    comp: CompMixParams = field(default_factory=CompMixParams)
    resample: ResampleParams = field(default_factory=ResampleParams)
    relight: RelightParams = field(default_factory=RelightParams)
    grain: GrainParams = field(default_factory=GrainParams)
    smoothing: SmoothingParams = field(default_factory=SmoothingParams)
    region_policy: RegionPolicy = "keepBarcode"
    # 外掛群組：name → 群組物件（frozen dataclass），依登記順序
    ext: dict[str, Any] = field(default_factory=dict)

    def __init__(
        self,
        macro: Macro = "standard",
        motion_blur: MotionBlurParams | None = None,
        edge: EdgeParams | None = None,
        occlusion: OcclusionParams | None = None,
        comp: CompMixParams | None = None,
        resample: ResampleParams | None = None,
        relight: RelightParams | None = None,
        grain: GrainParams | None = None,
        smoothing: SmoothingParams | None = None,
        region_policy: RegionPolicy = "keepBarcode",
        ext: dict[str, Any] | None = None,
        **groups: Any,
    ) -> None:
        put = object.__setattr__
        put(self, "macro", macro)
        put(self, "motion_blur", MotionBlurParams() if motion_blur is None else motion_blur)
        put(self, "edge", EdgeParams() if edge is None else edge)
        put(self, "occlusion", OcclusionParams() if occlusion is None else occlusion)
        put(self, "comp", CompMixParams() if comp is None else comp)
        put(self, "resample", ResampleParams() if resample is None else resample)
        put(self, "relight", RelightParams() if relight is None else relight)
        put(self, "grain", GrainParams() if grain is None else grain)
        put(self, "smoothing", SmoothingParams() if smoothing is None else smoothing)
        put(self, "region_policy", region_policy)
        registered = _param_groups()
        names = {g.name for g in registered}
        for name in groups:
            if name not in names:
                raise TypeError(f"InsertParams.__init__() got an unexpected keyword argument {name!r}")
        given = dict(ext or {})
        given.update(groups)
        merged: dict[str, Any] = {}
        for g in registered:
            merged[g.name] = given.pop(g.name) if g.name in given else g.cls()
        merged.update(given)  # 已經沒登記的群組（外掛被拿掉之後）：原樣帶著，不憑空丟資料
        put(self, "ext", merged)

    def __getattr__(self, name: str) -> Any:
        # 只在一般屬性找不到時才進來：外掛群組（params.<群組名>）。雙底線名稱一律不碰（copy／pickle 會來問）
        if name.startswith("__"):
            raise AttributeError(name)
        ext = self.__dict__.get("ext")
        if ext is not None and name in ext:
            return ext[name]
        raise AttributeError(f"InsertParams 沒有參數群組 {name!r}（外掛沒載入？）")

    def group(self, name: str) -> Any:
        """外掛群組或 None（沒登記）。核心程式要用這個問，不能直接 `params.<外掛群組>`。"""
        return self.ext.get(name)

    # ---- 建構 ----
    @classmethod
    def standard(cls) -> "InsertParams":
        return cls()

    @classmethod
    def from_macro(cls, name: str, base: "InsertParams | None" = None) -> "InsertParams":
        """套用巨集到 base（預設＝表格預設）。`custom` ＝ 不動。"""
        base = base or cls()
        if name == "custom":
            return replace(base, macro="custom")
        if name not in MACROS:
            raise ValueError(f"未知巨集 {name!r}（可用：{', '.join(MACROS)}、custom）")
        merged = _deep_merge(base.to_dict(), macro_overrides(name))
        merged["macro"] = name
        return _build(cls, merged)

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None, base: "InsertParams | None" = None) -> "InsertParams":
        """專案 `insert` 物件或 CLI 旗標 → InsertParams。None 欄位＝繼承 base；未知鍵擲 ValueError。"""
        base = base or cls()
        if not d:
            return base
        norm = _normalize(d)
        macro = norm.pop("macro", None)
        out = cls.from_macro(macro, base) if macro else base
        if not norm:
            return out
        merged = _deep_merge(out.to_dict(), norm)
        if macro is None:
            merged["macro"] = "custom" if base.macro != "custom" and _differs(out.to_dict(), merged) else out.macro
        return _build(cls, merged)

    def to_dict(self) -> dict[str, Any]:
        """扁平的巢狀 dict（與外掛化之前的 asdict 同形）：核心群組 → 外掛群組（登記順序）→ region_policy。"""
        d: dict[str, Any] = {}
        for f in fields(self):
            if f.name in ("region_policy", "ext"):
                continue
            v = getattr(self, f.name)
            d[f.name] = asdict(v) if is_dataclass(v) else v
        for name, v in self.ext.items():
            d[name] = asdict(v) if is_dataclass(v) else v
        d["region_policy"] = self.region_policy
        return d

    # ---- 便利屬性 ----
    @property
    def is_hold(self) -> bool:
        return self.region_policy == "hold" or self.comp.apply_mix <= 0.0 or self.comp.opacity <= 0.0

    def supersample_for(self, card_long_side_px: float | None, shot_kind: str | None = None) -> int:
        """auto → 2×近景、3×遠景；沒鏡頭種類時用牌在幀中的長邊（<70 px 視為遠景）。"""
        ss = self.resample.supersample
        if ss != "auto":
            return max(1, int(ss))
        if shot_kind == "wide":
            return 3
        if shot_kind == "close":
            return 2
        if card_long_side_px is not None and card_long_side_px < 70:
            return 3
        return 2


def macro_overrides(name: str) -> dict[str, Any]:
    """表格「巨集」列。standard ＝ 表格預設（空覆寫）。"""
    if name == "standard":
        return {}
    if name == "conservative":
        return {
            "relight": {"ink_dilate": 1.0},
            "edge": {"choke": 1.0, "softness": 1.2},
            "comp": {"opacity": 0.95},
            "smoothing": {"hold_below_conf": 0.50},
        }
    if name == "full":
        return {
            "relight": {"ink_dilate": 3.0},
            "edge": {"choke": 0.3, "softness": 0.5},
            "comp": {"opacity": 1.0},
            "smoothing": {"hold_below_conf": 0.25},
        }
    raise ValueError(f"未知巨集 {name!r}")


# ---------------------------------------------------------------------------
# 鍵名正規化：camelCase（專案檔）/ snake_case（CLI）/ 頂層 opacity、applyMix、blendMode、regionPolicy、holdBelowConf
# ---------------------------------------------------------------------------
_TOP_LEVEL_ALIASES = {
    "opacity": ("comp", "opacity"),
    "apply_mix": ("comp", "apply_mix"),
    "blend_mode": ("comp", "blend_mode"),
    "hold_below_conf": ("smoothing", "hold_below_conf"),
    "hold_below": ("smoothing", "hold_below_conf"),
    "region": ("region_policy",),
}
_GROUP_ALIASES = {"motionblur": "motion_blur", "relight": "relight", "comp": "comp", "mix": "comp"}
_PERCENT_FIELDS = {("comp", "opacity"), ("comp", "apply_mix"), ("relight", "keep_highlights"), ("grain", "amount")}
def _snake(key: str) -> str:
    k = key.replace("-", "_")
    k = re.sub(r"(?<!^)(?=[A-Z])", "_", k).lower()
    return _GROUP_ALIASES.get(k, k)


def _normalize(d: dict[str, Any]) -> dict[str, Any]:
    """→ 嵌套 snake_case dict，去掉 None，百分數轉 0..1，頂層別名歸位。"""
    out: dict[str, Any] = {}
    for raw_key, val in d.items():
        if val is None:
            continue
        key = _snake(str(raw_key))
        if key in _TOP_LEVEL_ALIASES:
            path = _TOP_LEVEL_ALIASES[key]
            cur = out
            for p in path[:-1]:
                cur = cur.setdefault(p, {})
            cur[path[-1]] = val
            continue
        if isinstance(val, dict):
            sub = {_snake(str(k)): v for k, v in val.items() if v is not None}
            if sub:
                out.setdefault(key, {}).update(sub)
            continue
        out[key] = val
    # 百分數 → 0..1
    for group, name in _PERCENT_FIELDS:
        g = out.get(group)
        if isinstance(g, dict) and name in g and isinstance(g[name], (int, float)) and g[name] > 1.0:
            g[name] = float(g[name]) / 100.0
    return out


def _deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    out = dict(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _differs(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return {k: v for k, v in a.items() if k != "macro"} != {k: v for k, v in b.items() if k != "macro"}


def _build(cls: type, data: dict[str, Any]) -> Any:
    """dict → 巢狀 dataclass，並做型別／enum 驗證（給 CLI 一個清楚的錯誤而不是深處炸掉）。

    InsertParams 的外掛群組（hooks.ParamGroup）跟核心群組走同一條路：同一個「沒有欄位」錯誤（可用清單含外掛群組）、
    同一個「必須是物件」錯誤、群組內同一套 enum／範圍驗證。"""
    kwargs: dict[str, Any] = {}
    names: dict[str, Any] = {f.name: f for f in fields(cls)}
    groups: dict[str, Any] = {}
    if cls is InsertParams:
        names.pop("ext", None)
        groups = {g.name: g for g in _param_groups()}
    for k, v in data.items():
        if k in groups:
            if not isinstance(v, dict):
                raise ValueError(f"{cls.__name__}.{k} 必須是物件（群組），收到 {v!r}")
            kwargs[k] = _build(groups[k].cls, v)
            continue
        if k not in names:
            raise ValueError(f"{cls.__name__} 沒有欄位 {k!r}（可用：{', '.join(sorted([*names, *groups]))}）")
        f = names[k]
        inner = f.default_factory() if f.default_factory is not MISSING else None  # type: ignore[misc]
        if is_dataclass(inner):
            if not isinstance(v, dict):
                raise ValueError(f"{cls.__name__}.{k} 必須是物件（群組），收到 {v!r}")
            kwargs[k] = _build(type(inner), v)
        else:
            kwargs[k] = _coerce(cls.__name__, k, v)
    obj = cls(**kwargs)
    _validate(obj)
    return obj


def _coerce(owner: str, name: str, v: Any) -> Any:
    if isinstance(v, str) and v.lower() in {"true", "false", "on", "off"}:
        return v.lower() in {"true", "on"}
    if isinstance(v, str) and v.lower() == "auto":
        return "auto"
    return v


_ENUMS: dict[tuple[str, str], tuple[str, ...]] = {
    ("MotionBlurParams", "shutter_phase"): ("centered", "start", "end", "custom"),
    ("EdgeParams", "falloff"): ("linear", "smoothstep"),
    ("CompMixParams", "blend_mode"): ("normal",),
    ("ResampleParams", "kernel"): ("nearest", "bilinear", "bicubic", "lanczos3"),
    ("ResampleParams", "downsample"): ("area",),
    ("RelightParams", "sheen_lock"): ("plate", "card"),
    ("RelightParams", "shading_source"): ("auto", "template-ratio", "lowpass-mean"),
    ("GrainParams", "mode"): ("measured", "synthetic"),
    ("InsertParams", "region_policy"): ("full", "keepBarcode", "hold"),
    ("InsertParams", "macro"): ("conservative", "standard", "full", "custom"),
}
_RANGES: dict[tuple[str, str], tuple[float, float]] = {
    ("MotionBlurParams", "max_samples"): (1, 256),
    ("MotionBlurParams", "max_step_px"): (0.05, 16.0),
    ("MotionBlurParams", "deadband_px"): (0.0, 100.0),
    ("EdgeParams", "choke"): (-10.0, 50.0),
    ("EdgeParams", "softness"): (0.0, 50.0),
    ("OcclusionParams", "dilate"): (0.0, 50.0),
    ("OcclusionParams", "feather"): (0.0, 50.0),
    ("CompMixParams", "opacity"): (0.0, 1.0),
    ("CompMixParams", "apply_mix"): (0.0, 1.0),
    ("RelightParams", "shading_blur_sigma"): (0.0, 1.0),
    ("RelightParams", "ink_dilate"): (0.0, 50.0),
    ("RelightParams", "keep_highlights"): (0.0, 4.0),
    ("RelightParams", "observed_ink_chroma"): (0.0, 1.0),
    ("RelightParams", "observed_ink_dark"): (0.0, 1.0),
    ("GrainParams", "amount"): (0.0, 4.0),
    ("SmoothingParams", "hold_below_conf"): (0.0, 1.0),
    ("SmoothingParams", "fade_frames"): (0, 30),
}


def _group_rules(obj: Any) -> Any:
    """這個群組物件是哪個外掛群組（hooks.ParamGroup）；核心群組回 None。"""
    t = type(obj)
    for g in _param_groups():
        if g.cls is t:
            return g
    return None


def _validate(obj: Any) -> None:
    cname = type(obj).__name__
    ext = _group_rules(obj)
    for f in fields(obj):
        v = getattr(obj, f.name)
        enum = _ENUMS.get((cname, f.name)) if ext is None else ext.enums.get(f.name)
        if enum is not None and v not in enum:
            raise ValueError(f"{cname}.{f.name}={v!r} 不合法（可用：{', '.join(enum)}）")
        rng = _RANGES.get((cname, f.name)) if ext is None else ext.ranges.get(f.name)
        if rng is not None:
            if not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(float(v)):
                raise ValueError(f"{cname}.{f.name}={v!r} 必須是有限數值")
            if not (rng[0] <= float(v) <= rng[1]):
                raise ValueError(f"{cname}.{f.name}={v!r} 超出範圍 [{rng[0]}, {rng[1]}]")
    if ext is not None and ext.validate is not None:
        ext.validate(obj)
    if cname == "MotionBlurParams":
        s = obj.samples
        if s != "auto" and (not isinstance(s, int) or isinstance(s, bool) or s < 1):
            raise ValueError(f"MotionBlurParams.samples={s!r} 必須是 'auto' 或 ≥1 的整數")
        if obj.enabled not in (True, False, "auto"):
            raise ValueError(f"MotionBlurParams.enabled={obj.enabled!r} 必須是 true/false/'auto'")
        a = obj.shutter_angle
        if a != "auto" and (not isinstance(a, (int, float)) or isinstance(a, bool) or not math.isfinite(float(a)) or not (0.0 <= float(a) <= 720.0)):
            raise ValueError(f"MotionBlurParams.shutter_angle={a!r} 必須是 'auto' 或 0..720")
    if cname == "ResampleParams":
        s = obj.supersample
        if s != "auto" and (not isinstance(s, int) or isinstance(s, bool) or not (1 <= s <= 8)):
            raise ValueError(f"ResampleParams.supersample={s!r} 必須是 'auto' 或 1..8")
