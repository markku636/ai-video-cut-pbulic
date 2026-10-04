"""外掛掛勾（plugin hooks）：核心在固定的幾個位置問「有沒有外掛要接手」，外掛在自己的 `register()` 裡登記。

為什麼要有這層：開源版只有核心（沒有 `plugins/`），私有版多裝一個外掛就要跟以前一模一樣。核心因此不能 import
任何外掛的程式；需要外掛插手的地方（渲染要換什麼、合成器的替代路徑、專案檔的外掛欄位、插入參數的外掛群組……）
一律寫成「查這裡的登記表」，查不到就走核心自己的行為。

規則：
- 這個模組不 import 任何重的東西（cv2／numpy／torch）：`aivc --help` 也會走到登記。
- 每筆登記都帶 owner（外掛名）。外掛的 `register()` 半途失敗時 `aivc.plugins` 用 `remove_owner()` 整批撤掉，
  不留下半套掛勾；測試用 `suspended()` 暫時清空，驗證「沒有外掛時」核心的行為。
- 讀取端每次用時才查、不快取：外掛可能比讀取端晚載入。
- 第一次查詢會先觸發外掛探索（`aivc.plugins.ensure_loaded()`）：直接把 schema／params 當函式庫用、沒經過
  `aivc.ops.load_all()` 的呼叫端（測試、腳本）也看得到外掛的欄位，不會因為進入點不同而讀出不同的專案。

登記的種類（`KINDS`）與誰來讀：
| kind | 值 | 讀的人 |
|---|---|---|
| insert-source | 有 claim／build／setup_jobs 的物件（見 `ops/render.py` 的 InsertSource） | `ops/render._build_jobs`、`ops/seq` |
| param-group | `ParamGroup` | `comp/params.InsertParams`、`project/resolve.insert_dict_for` |
| schema-field | `SchemaField` | `project/schema`（ProjectFile／TrackV1／TrackOptionsV1） |
| track-check | `fn(track, media_id, env, warn)` | `project/schema.ProjectFile.from_json` 的交叉檢查 |
| composite-mode | `CompositeMode` | `comp/compositor.composite_frame` |
| face-stage | `FaceStage` | `comp/compositor.composite_frame`（新面在模板空間、warp 之前的加工） |
| track-method | `TrackMethod` | `ops/track.track_op`（`--method`） |
| op-args | `OpArgs` | `ops/__init__.extend_args`（外掛替核心 op 加 CLI 旗標） |
| content-note | `str` | `media/encode_plan`（預設的內容揭露句子；最後登記的生效） |
| render-finish | `fn(mctx, plan, frame_source, ctx)` | `ops/render.render_frames`（整段寫完之後的附帶交付） |
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

KINDS: tuple[str, ...] = (
    "insert-source",
    "param-group",
    "schema-field",
    "track-check",
    "composite-mode",
    "face-stage",
    "track-method",
    "op-args",
    "content-note",
    "render-finish",
)


@dataclass(frozen=True)
class Entry:
    kind: str
    owner: str
    value: Any


_REG: dict[str, list[Entry]] = {k: [] for k in KINDS}


def _ensure_plugins() -> None:
    # 延遲 import：aivc.plugins 會 import aivc.ops（OpError、LOAD_ERRORS），而 aivc.ops 不 import 這裡
    from . import plugins

    plugins.ensure_loaded()


def add(kind: str, value: Any, *, owner: str) -> Any:
    """登記一筆。回傳 value（可當 decorator 用）。"""
    if kind not in _REG:
        raise ValueError(f"未知的掛勾種類 {kind!r}（可用：{', '.join(KINDS)}）")
    _REG[kind].append(Entry(kind, str(owner), value))
    return value


def entries(kind: str, *, load: bool = True) -> list[Entry]:
    if load:
        _ensure_plugins()
    return list(_REG[kind])


def values(kind: str, *, load: bool = True) -> list[Any]:
    """登記順序（先登記的先問）。"""
    return [e.value for e in entries(kind, load=load)]


def owners() -> set[str]:
    return {e.owner for lst in _REG.values() for e in lst}


def remove_owner(owner: str) -> int:
    """撤掉某個外掛的全部登記（載入失敗的回滾）。回撤掉的筆數。"""
    n = 0
    for kind, lst in _REG.items():
        keep = [e for e in lst if e.owner != owner]
        n += len(lst) - len(keep)
        _REG[kind] = keep
    return n


@contextmanager
def suspended(owner: str | None = None) -> Iterator[None]:
    """暫時拿掉登記（owner=None ＝ 全部；否則只拿掉那個外掛的），離開時原樣放回。測試「沒有外掛時」核心的行為用。

    先把外掛探索做完再存快照：不然探索剛好發生在暫停期間，外掛的登記會在離開時跟著被「還原」掉，之後整個行程都沒有它。"""
    _ensure_plugins()
    saved = {k: list(v) for k, v in _REG.items()}
    try:
        for k in _REG:
            _REG[k] = [] if owner is None else [e for e in _REG[k] if e.owner != owner]
        yield
    finally:
        for k in _REG:
            _REG[k] = saved[k]


# ---------------------------------------------------------------- 各種登記的資料形狀


@dataclass(frozen=True)
class ParamGroup:
    """插入參數（`comp/params.InsertParams`）的外掛群組，例如空白牌比值合成的 `paperRatio`。

    name       InsertParams 上的屬性名（snake_case），也是 from_dict／to_dict 用的群組鍵。
    cls        frozen dataclass，欄位都要有預設值（＝表格預設）。
    json_key   專案檔 insert／insertDefaults 裡的鍵（camelCase）。forward=True 時 `resolve.insert_dict_for`
               會把 insert.extra[json_key] 交給 InsertParams（物件且非空才交）。
    enums／ranges  欄位 → 允許值／[lo, hi]；與核心群組同一套驗證與錯誤訊息。
    validate   額外的整體驗證（擲 ValueError）。
    forward    False ＝ 不從逐 track 的 insert 解析（例如只從 insertDefaults 讀的群組，由外掛自己讀）。
    """

    name: str
    cls: type
    json_key: str
    enums: dict[str, tuple[Any, ...]] = field(default_factory=dict)
    ranges: dict[str, tuple[float, float]] = field(default_factory=dict)
    validate: Callable[[Any], None] | None = None
    forward: bool = True


@dataclass(frozen=True)
class SchemaField:
    """專案檔物件上由外掛認領的鍵（核心不認得的鍵本來就原樣保存在 extra；認領之後由外掛解析／正規化）。

    owner_type  "project"（頂層）| "track" | "track.options"
    key         磁碟上的 JSON 鍵（camelCase）
    attr        Python 屬性名：`obj.<attr>` 讀寫的是 `obj.ext[attr]`
    after       寫檔時接在哪個核心鍵後面（核心鍵順序見各類別的 to_json）
    parse       (raw, present, warn, env) → 值。present＝檔案裡有沒有這個鍵；env 見 schema 各類別
    dump        值 → (要不要寫, JSON 值)
    default     建構時沒給的預設值（每次呼叫產生新物件）
    phase       只對 project：「early」＝ tracks 解析完立刻解析（交叉檢查要用）；「late」＝序列解析完之後
    """

    owner_type: str
    key: str
    attr: str
    after: str
    parse: Callable[[Any, bool, Callable[[str], None], Any], Any]
    dump: Callable[[Any], tuple[bool, Any]]
    default: Callable[[], Any]
    phase: str = "early"


@dataclass(frozen=True)
class CompositeMode:
    """合成器的整條替代路徑（例：空白牌逐像素比值合成）。claims(params) 為真就整幀交給 composite(...)，
    參數與核心 `composite_frame` 相同（另加 stats 關鍵字）。"""

    name: str
    claims: Callable[[Any], bool]
    composite: Callable[..., Any]


@dataclass(frozen=True)
class FaceStage:
    """新面在模板空間（warp 之前）的加工，例：墨色比對＋墨邊預模糊。apply(env) 回新的線性模板。"""

    name: str
    apply: Callable[[Any], Any]


@dataclass(frozen=True)
class TrackMethod:
    """`aivc track --method <name>`：run(args, ctx, video) → op 結果 dict。"""

    name: str
    run: Callable[[dict[str, Any], Any, Any], dict[str, Any]]
    help: str = ""


@dataclass(frozen=True)
class OpArgs:
    """外掛替核心 op 加的 CLI 旗標（sidecar 的 args 本來就是 dict，不需要這個）。"""

    op: str
    add_arguments: Callable[[Any], None]


# ---------------------------------------------------------------- 讀取端用的捷徑


def insert_sources() -> list[Any]:
    return values("insert-source")


def param_groups() -> list[ParamGroup]:
    return values("param-group")


def schema_fields(owner_type: str) -> list[SchemaField]:
    return [f for f in values("schema-field") if f.owner_type == owner_type]


def track_checks() -> list[Callable[..., None]]:
    return values("track-check")


def composite_modes() -> list[CompositeMode]:
    return values("composite-mode")


def face_stages() -> list[FaceStage]:
    return values("face-stage")


def track_methods() -> dict[str, TrackMethod]:
    return {m.name: m for m in values("track-method")}


def op_args(op: str) -> list[Callable[[Any], None]]:
    return [a.add_arguments for a in values("op-args") if a.op == op]


def content_note() -> str | None:
    """最後登記的預設內容揭露句子；沒有外掛登記 → None（用核心的通用句子）。"""
    v = values("content-note")
    return v[-1] if v else None


def render_finish() -> list[Callable[..., None]]:
    return values("render-finish")
