"""SAM 3（`facebook/sam3`）via transformers 5.17：文字 → 多個實例，點／框 → 遮罩。

兩個模型、同一份權重：
- `Sam3VideoModel` + `Sam3VideoProcessor`：**文字提示**（「臉, 車牌」）→ 偵測器每幀都跑，新出現的物件自動配新 id，
  舊物件由內建的 SAM 2 式追蹤器傳播（`Sam3TextTracker`）。
- `Sam3TrackerVideoModel` + `Sam3TrackerVideoProcessor`：**點／框提示**，API 與 `Sam2VideoModel` 逐字相同
  （`add_inputs_to_inference_session`、`model(inference_session, frame_idx, frame, reverse)`、`post_process_masks`），
  所以直接沿用 `sam2_hf.Sam2HfSession`（`Sam3TrackerBackend`）——同一份串流、修剪記憶庫、MPS 退路的程式碼。

## ⚠ 這個模組在開發機上**沒有用真權重驗證過**

`facebook/sam3` 是需要申請存取的模型庫（gated＝manual，作者人工審核）。開發這支的機器帳號被拒絕，
所以這裡的控制流程只用假的 model／processor 測過（tests/test_seg_sam3.py），對照的是 transformers 5.17
安裝在 venv 裡的原始碼（`models/sam3_video/`、`models/sam3_tracker_video/`），不是實際推論結果。
**不可以**改抓第三方重新上傳的 SAM 3 權重來「驗證」：那等於繞過作者的存取決定。

## 讀原始碼確認過、會咬人的行為（transformers 5.17）

1. 串流模式（`model(inference_session=s, frame=pixel_values, frame_idx=i)`）**關掉 hotstart 去重**：
   原本要看未來 15 幀才決定「這是重複的／一閃而過的假物件」，串流做不到 → 誤偵測與重複 id 比較多。
   對策：ops 層用 `min_frames`（預設 3）過濾只出現一兩幀的實例。
2. SAM 3 影片模型呼叫內部追蹤器時**沒有傳 frame**，追蹤器因此走「非串流」分支：物件指標的回看幀數
   = `min(len(session.processed_frames), 16)`。所以**不可以**像 SAM 2.1 那樣把舊幀從 `processed_frames` 刪掉
   （刪到剩 1 幀 → 追蹤器只看得到條件幀的指標，追蹤品質掉很多）。這裡改成把舊幀的值換成 0 元素張量：
   鍵（長度）保留、6 MB/幀的像素釋放。
3. 追蹤器的輸出存在 `session.output_dict_per_obj[i]["non_cond_frame_outputs"]`（每物件每幀約 3.5 MB，預設放 GPU），
   而模型只回看 6 幀記憶（t-1..t-6）+ 16 幀物件指標（t-1..t-15），而且文字追蹤只往前跑 →
   距離**目前幀**超過 `memory_window`（64）的非條件幀可以丟，結果不變。
   **不可以**沿用 sam2_hf 的「離任何條件幀 ≤ window 也留著」：SAM 3 每 16 幀（`recondition_every_nth_frame`）
   會把分數夠高的物件那一幀搬進 cond_frame_outputs，條件幀密到每個非條件幀都離某個條件幀很近 → 一幀都不刪、
   記憶體隨段長線性長（600 幀一段約 2 GB／物件）。sam2_hf 需要那條例外是因為它會先往後再往前傳播。
   另外已經處理過的幀，輸出裡的 `high_res_masks`（1008² bf16 ≈ 2 MB）只在**同一幀**編記憶時用到 → 直接拿掉。
4. 偵測門檻是模型屬性（`score_threshold_detection` 0.5、`new_det_thresh` 0.7）。`--threshold` 會**暫時**改這兩個值、
   跑完一定還原（模型是行程內共用的單例）。`--max` 同理暫時改 `max_num_objects`（模型預設 10000＝不限；
   上限到了 HF 只收分數最高的新偵測）：上限＝`object_cap(--max)`，留 4 倍餘裕給先出現、之後被更高分擠掉的。

## 分段（chunk）

一段很長的範圍分成每 `chunk` 幀一個新 session（預設 600），段與段**重疊一幀**：新段在重疊幀重新偵測，
用遮罩 IoU（≥ 0.5、同片語）把新 id 接回舊的全域 id。代價（誠實寫出來）：舊段在追的物件若在重疊幀的偵測分數
不夠新物件門檻，新段不會重新偵測到它 → 那個實例在段界結束；`--chunk 0` 不分段（記憶體仍有上面 2、3 點的修剪）。

## 存取與 token

權重先讀本機快取（`sam2_hf._from_pretrained_local_first`）；沒有才連 Hub，並帶上使用者的 HF token
（`find_hf_token`：HF_TOKEN → HUGGING_FACE_HUB_TOKEN → HF_TOKEN_PATH → <HF_HOME>/token → ~/.cache/huggingface/token）。
最後一個很重要：`env.apply_model_env()` 把 HF_HOME 指到 App 的資料目錄，使用者用 `hf auth login` 存的 token
在預設的 ~/.cache/huggingface/token，huggingface_hub 自己不會去那裡找。token 本身絕不寫進 log 或錯誤訊息。
"""
from __future__ import annotations

import os
import time
from collections.abc import Callable, Iterable, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

from .. import device as dev
from .. import env
from .backend import SegModelError

MODEL_ID = "facebook/sam3"
MODEL_URL = "https://huggingface.co/facebook/sam3"
#: 只抓 transformers 要的檔：模型庫還有原版 sam3.pt（一樣大），抓了等於下載兩倍。merges.txt 是 tokenizer 的一部分。
ALLOW_PATTERNS = ("*.json", "*.safetensors", "*.txt")
#: 必要檔（2026-10 的檔案清單：config.json、processor_config.json、tokenizer*.json、vocab.json、merges.txt、model.safetensors）。
#: 這個模型庫**沒有** preprocessor_config.json，所以不能用 SAM 2.1 那組 REQUIRED_FILES 判斷快取完整。
REQUIRED_FILES = ("config.json", "processor_config.json", "tokenizer_config.json")
DEFAULT_CHUNK = 600
DEFAULT_MEMORY_WINDOW = 64
LINK_IOU = 0.5


def object_cap(max_instances: int | None) -> int | None:
    """`--max N` → 追蹤時同時追幾個物件的上限（max(4N, 16)）。None ＝ 不限（用模型設定）。"""
    if max_instances is None:
        return None
    return max(4 * int(max_instances), 16)
TOKEN_ENVS = ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN")


# ---------------------------------------------------------------------------
# token 與可用性（全部不連網）
# ---------------------------------------------------------------------------
def _token_files() -> list[tuple[Path, str]]:
    out: list[tuple[Path, str]] = []
    p = os.environ.get("HF_TOKEN_PATH")
    if p:
        out.append((Path(p), "HF_TOKEN_PATH"))
    hf_home = os.environ.get("HF_HOME")
    if hf_home:
        out.append((Path(hf_home) / "token", "HF_HOME/token"))
    xdg = os.environ.get("XDG_CACHE_HOME")
    base = Path(xdg) if xdg and os.path.isabs(xdg) else Path.home() / ".cache"
    out.append((base / "huggingface" / "token", "~/.cache/huggingface/token（hf auth login）"))
    return out


def find_hf_token() -> tuple[str | None, str]:
    """(token, 來源說明)。找不到回 (None, "")。**token 只拿來傳給 Hub，不可以印出來。**"""
    for name in TOKEN_ENVS:
        v = (os.environ.get(name) or "").strip()
        if v:
            return v, f"環境變數 {name}"
    seen: set[str] = set()
    for path, src in _token_files():
        key = os.path.normcase(str(path))
        if key in seen:
            continue
        seen.add(key)
        try:
            t = path.read_text(encoding="utf-8").strip()
        except (OSError, UnicodeDecodeError):
            continue
        if t:
            return t, src
    return None, ""


def hf_kwargs() -> dict[str, Any]:
    tok, _src = find_hf_token()
    return {"token": tok} if tok else {}


def transformers_has_sam3() -> bool:
    """安裝的 transformers 有沒有 SAM 3 影片模型（只找模組規格，不 import torch）。"""
    import importlib.util

    try:
        return all(importlib.util.find_spec(f"transformers.models.{m}") is not None for m in ("sam3_video", "sam3_tracker_video"))
    except (ImportError, ValueError):
        return False


def local_snapshot() -> Path | None:
    """本機 HF 快取裡完整的 facebook/sam3 快照（不連網）；沒有或不完整回 None。"""
    from ..ops.models import cached_snapshot, hub_cache_dir

    env.apply_model_env()
    return cached_snapshot(MODEL_ID, hub_cache_dir(), allow_patterns=list(ALLOW_PATTERNS), required=REQUIRED_FILES)


@dataclass(frozen=True)
class Sam3Status:
    ready: bool  # transformers 支援 + 權重在本機快取
    reason: str  # 給人看的原因（不能用時說為什麼）
    snapshot: str | None = None
    token_source: str = ""
    supported: bool = True  # 安裝的 transformers 有沒有 SAM 3 類別


def status() -> Sam3Status:
    """`--backend auto` 用：SAM 3 現在能不能**不連網**直接用。"""
    _tok, src = find_hf_token()
    if not transformers_has_sam3():
        return Sam3Status(False, "安裝的 transformers 沒有 SAM 3（需要 Sam3VideoModel，transformers ≥ 5）", None, src, supported=False)
    snap = local_snapshot()
    if snap is None:
        why = "SAM 3 權重不在本機快取（facebook/sam3 需要在 Hugging Face 申請存取；有權限的話跑 `aivc models pull --sam3`）"
        return Sam3Status(False, why, None, src)
    return Sam3Status(True, f"SAM 3 權重在本機：{snap}", str(snap), src)


# ---------------------------------------------------------------------------
# 錯誤分類
# ---------------------------------------------------------------------------
_ACCESS_TYPES = {"GatedRepoError"}
_ACCESS_WORDS = ("gated repo", "is restricted", "awaiting a review", "not in the authorized list", "access to model", "you are trying to access a gated")


def _chain(e: BaseException) -> list[BaseException]:
    out: list[BaseException] = []
    cur: BaseException | None = e
    while cur is not None and cur not in out and len(out) < 16:
        out.append(cur)
        cur = cur.__cause__ or cur.__context__
    return out


def is_access_error(e: BaseException) -> bool:
    """這個例外是不是「沒有 gated 模型庫的權限」（GatedRepoError、HTTP 401/403、訊息提到 gated）。"""
    for x in _chain(e):
        if type(x).__name__ in _ACCESS_TYPES:
            return True
        status_code = getattr(getattr(x, "response", None), "status_code", None)
        if status_code in (401, 403):
            return True
        low = str(x).lower()
        if any(w in low for w in _ACCESS_WORDS):
            return True
    return False


def gated_message() -> str:
    return "SAM 3（facebook/sam3）是需要申請存取的模型，這台電腦使用的 Hugging Face 帳號沒有下載權限"


def gated_hint() -> str:
    _tok, src = find_hf_token()
    seen = f"目前讀到的 token 來自：{src}" if src else "目前沒有讀到任何 Hugging Face token"
    return (
        f"到 {MODEL_URL} 登入並申請存取（由模型作者人工審核）；通過後用同一個帳號建立 access token，"
        "設成環境變數 HF_TOKEN（或執行 `hf auth login`），再跑 `aivc models pull --sam3`。"
        f"{seen}。不能用 SAM 3 也沒關係：`--backend auto`（預設）會改用 OWLv2 + SAM 2.1"
    )


def load_error(e: BaseException) -> SegModelError:
    if is_access_error(e):
        return SegModelError("Model", f"{gated_message()}（{type(e).__name__}）", gated_hint())
    return SegModelError(
        "Model",
        f"載入 {MODEL_ID} 失敗：{type(e).__name__}: {str(e).splitlines()[0][:300] if str(e) else ''}",
        f"權重要先下載：`aivc models pull --sam3`（需要 Hugging Face 存取權限，見 {MODEL_URL}）；"
        "或改用 `--backend sam2`（OWLv2 + SAM 2.1）",
    )


# ---------------------------------------------------------------------------
# 載入（行程內各一份；SAM 3 很大，載入時先把其他重模型放掉）
# ---------------------------------------------------------------------------
@dataclass
class LoadedSam3Video:
    model: Any
    processor: Any
    model_id: str
    device: str
    dtype: Any
    load_seconds: float
    preprocess_on_device: bool = False


_VIDEO: LoadedSam3Video | None = None
_TRACKER: Any = None  # sam2_hf.LoadedSam2（SAM 3 追蹤器套進 SAM 2.1 的 session 外殼）


def is_loaded() -> bool:
    return _VIDEO is not None or _TRACKER is not None


def _free_other_models() -> None:
    """決策 14：一次只駐留一個重模型。SAM 3（~0.85 B 參數）載入前先放掉 SAM 2.1／OWLv2。"""
    from . import sam2_hf, text_box

    sam2_hf.unload()
    text_box.unload()


def _resolve(device: str | None) -> tuple[str, Any]:
    env.apply_model_env()
    import torch

    try:
        resolved = dev.resolve_device(device, torch)
    except dev.DeviceUnavailable as e:
        raise SegModelError("Gpu", str(e), e.hint) from e
    return resolved, dev.preferred_dtype(resolved, torch)


def _import_classes(names: tuple[str, str]) -> tuple[Any, Any]:
    try:
        import transformers

        return getattr(transformers, names[0]), getattr(transformers, names[1])
    except (ImportError, AttributeError) as e:
        raise SegModelError(
            "PyEnv",
            f"安裝的 transformers 沒有 {names[0]}（SAM 3 需要 transformers ≥ 5）",
            "引擎的 Python 環境版本太舊；重新安裝引擎環境，或改用 `--backend sam2`",
        ) from e


def load_video(device: str | None = None) -> LoadedSam3Video:
    """文字 → 實例用的 Sam3VideoModel。換 device/dtype 會重載；載入追蹤器版時會先卸掉這個（反之亦然）。"""
    global _VIDEO, _TRACKER  # noqa: PLW0603
    resolved, dtype = _resolve(device)
    if _VIDEO is not None and _VIDEO.device == resolved and _VIDEO.dtype == dtype:
        return _VIDEO
    unload()
    _free_other_models()
    model_cls, proc_cls = _import_classes(("Sam3VideoModel", "Sam3VideoProcessor"))
    from .sam2_hf import _from_pretrained_local_first, _probe_preprocess_device

    kw = hf_kwargs()
    t0 = time.perf_counter()
    try:
        processor = _from_pretrained_local_first(proc_cls, MODEL_ID, **kw)
        model = _from_pretrained_local_first(model_cls, MODEL_ID, dtype=dtype, **kw)
    except Exception as e:  # noqa: BLE001
        raise load_error(e) from e
    model = model.to(resolved).eval()
    _VIDEO = LoadedSam3Video(model, processor, MODEL_ID, resolved, dtype, time.perf_counter() - t0, _probe_preprocess_device(processor, resolved))
    return _VIDEO


def load_tracker(device: str | None = None) -> Any:
    """點／框用的 Sam3TrackerVideoModel，包成 `sam2_hf.LoadedSam2`（給 `Sam2HfSession` 用）。"""
    global _TRACKER  # noqa: PLW0603
    from . import sam2_hf

    resolved, dtype = _resolve(device)
    if _TRACKER is not None and _TRACKER.device == resolved and _TRACKER.dtype == dtype:
        return _TRACKER
    unload()
    _free_other_models()
    model_cls, proc_cls = _import_classes(("Sam3TrackerVideoModel", "Sam3TrackerVideoProcessor"))
    kw = hf_kwargs()
    t0 = time.perf_counter()
    try:
        processor = sam2_hf._from_pretrained_local_first(proc_cls, MODEL_ID, **kw)
        model = sam2_hf._from_pretrained_local_first(model_cls, MODEL_ID, dtype=dtype, **kw)
    except Exception as e:  # noqa: BLE001
        raise load_error(e) from e
    model = model.to(resolved).eval()
    pre = sam2_hf._probe_preprocess_device(processor, resolved)
    _TRACKER = sam2_hf.LoadedSam2(model, processor, MODEL_ID, "sam3", resolved, time.perf_counter() - t0, pre, dtype)
    return _TRACKER


def unload() -> None:
    global _VIDEO, _TRACKER  # noqa: PLW0603
    if _VIDEO is None and _TRACKER is None:
        return
    _VIDEO = None
    _TRACKER = None
    import gc

    gc.collect()
    try:
        dev.empty_cache()
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------------------
# 點／框：SAM 3 追蹤器套 SAM 2.1 的 session
# ---------------------------------------------------------------------------
@dataclass
class Sam3TrackerBackend:
    """`backend.SegBackend` 實作；`open_session` 回 `sam2_hf.Sam2HfSession`（API 相同，見模組說明）。"""

    device: str | None = None
    memory_window: int | None = DEFAULT_MEMORY_WINDOW
    prune_frames: bool = True
    non_overlapping: bool = True
    mask_threshold: float = 0.0
    name: str = "sam3_hf"

    def loaded(self) -> Any:
        return load_tracker(self.device)

    def open_session(self, frame_size: tuple[int, int]) -> Any:
        from .sam2_hf import Sam2HfSession

        # 追蹤器拿到的是 frame（串流分支），物件指標不看 processed_frames 的長度，所以可以照 SAM 2.1 的方式刪舊幀
        return Sam2HfSession(
            self.loaded(), frame_size, memory_window=self.memory_window, prune_frames=self.prune_frames,
            non_overlapping=self.non_overlapping, mask_threshold=self.mask_threshold,
        )

    def unload(self) -> None:
        unload()


# ---------------------------------------------------------------------------
# 文字：串流＋分段
# ---------------------------------------------------------------------------
@dataclass
class TextFrame:
    """一幀的結果：全域 id → bool 遮罩、偵測分數。只列出這一幀看得到的物件。"""

    k: int
    masks: dict[int, np.ndarray]
    scores: dict[int, float]


@dataclass
class TextStats:
    frames: int = 0
    chunks: int = 0
    seconds: float = 0.0
    relinked: int = 0  # 段界接回舊 id 的次數


def _np(x: Any) -> np.ndarray:
    if hasattr(x, "detach"):
        x = x.detach()
        if hasattr(x, "float") and str(getattr(x, "dtype", "")).endswith("bfloat16"):
            x = x.float()
        return x.cpu().numpy()
    return np.asarray(x)


class Sam3TextTracker:
    """SAM 3 文字提示 → 逐幀多實例。`run()` 是產生器：餵 (k, rgb) 遞增序列，yield `TextFrame`。

    k 只用來標記輸出；餵給模型的是**段內連續的本地索引** 0,1,2,…（與 HF 文件的串流範例一致；
    本地索引從 0 起算也讓追蹤器的「回看 ≤ processed_frames 長度」規則維持原意）。
    """

    def __init__(
        self,
        loaded: Any,
        frame_size: tuple[int, int],
        *,
        chunk: int = DEFAULT_CHUNK,
        memory_window: int | None = DEFAULT_MEMORY_WINDOW,
        link_iou: float = LINK_IOU,
        new_det_threshold: float | None = None,
        max_objects: int | None = None,
    ) -> None:
        self._l = loaded
        self.frame_size = (int(frame_size[0]), int(frame_size[1]))
        self.chunk = max(0, int(chunk or 0))
        self.memory_window = memory_window
        self.link_iou = float(link_iou)
        self.new_det_threshold = new_det_threshold
        self.max_objects = None if max_objects is None else max(1, int(max_objects))
        self.phrase_of: dict[int, str] = {}
        self.stats = TextStats()
        self._next_gid = 1
        self._placeholder: Any = None

    # ---- 模型門檻與物件上限（暫時改、一定還原）----
    def _apply_threshold(self) -> Callable[[], None]:
        m = self._l.model
        undo: list[Callable[[], None]] = []
        t = self.new_det_threshold
        if t is not None and hasattr(m, "new_det_thresh"):
            old = (getattr(m, "new_det_thresh"), getattr(m, "score_threshold_detection", None))
            m.new_det_thresh = float(t)
            if old[1] is not None:
                m.score_threshold_detection = min(float(old[1]), float(t))

            def restore_thr() -> None:
                m.new_det_thresh = old[0]
                if old[1] is not None:
                    m.score_threshold_detection = old[1]

            undo.append(restore_thr)
        cap = self.max_objects
        if cap is not None and hasattr(m, "max_num_objects"):
            old_cap = getattr(m, "max_num_objects")
            # 只會調低：模型本來就設了更小的上限就照它的
            if old_cap is None or int(old_cap) <= 0 or int(old_cap) > cap:
                m.max_num_objects = cap

                def restore_cap() -> None:
                    m.max_num_objects = old_cap

                undo.append(restore_cap)

        def restore() -> None:
            for fn in reversed(undo):
                fn()

        return restore

    # ---- session ----
    def _new_session(self, phrases: list[str]) -> Any:
        p = self._l.processor
        s = p.init_video_session(
            inference_device=self._l.device,
            processing_device="cpu",
            video_storage_device="cpu",
            dtype=self._l.dtype,
        )
        p.add_text_prompt(inference_session=s, text=list(phrases))
        self.stats.chunks += 1
        return s

    @staticmethod
    def _close(session: Any) -> None:
        try:
            session.reset_inference_session()
        except Exception:  # noqa: BLE001
            pass

    def _prune(self, session: Any, local: int) -> None:
        """見模組說明第 2、3 點：舊幀換成空張量（長度不變）、離目前幀太遠的非條件幀輸出丟掉、
        舊幀輸出的 high_res_masks 拿掉。"""
        pf = getattr(session, "processed_frames", None)
        if pf:
            if self._placeholder is None:
                try:
                    import torch

                    self._placeholder = torch.empty(0)
                except Exception:  # noqa: BLE001
                    self._placeholder = np.empty(0)
            for f in list(pf):
                if f != local and getattr(pf[f], "numel", lambda: 1)() != 0:
                    pf[f] = self._placeholder
        per_obj = getattr(session, "output_dict_per_obj", None) or {}
        win = None if self.memory_window is None else int(self.memory_window)
        for d in per_obj.values():
            if not isinstance(d, dict):
                continue
            nc = d.get("non_cond_frame_outputs")
            if nc and win is not None:
                # 只看離目前幀多遠（文字追蹤只往前跑）；不能留「靠近條件幀」的，理由見模組說明第 3 點
                for f in [f for f in nc if local - f > win]:
                    del nc[f]
            for store in (nc, d.get("cond_frame_outputs")):
                if not store:
                    continue
                for f, out in store.items():
                    if f < local and isinstance(out, dict):
                        out.pop("high_res_masks", None)

    def _step(self, session: Any, local: int, rgb: np.ndarray) -> dict[int, tuple[np.ndarray, float, str]]:
        """餵一幀 → {本地物件 id: (bool 遮罩, 偵測分數, 片語)}。"""
        w, h = self.frame_size
        if rgb.shape[:2] != (h, w):
            raise ValueError(f"幀尺寸 {rgb.shape[1]}x{rgb.shape[0]} 與 {w}x{h} 不合")
        p = self._l.processor
        if getattr(self._l, "preprocess_on_device", False):
            inputs = p(images=rgb, device=self._l.device, return_tensors="pt")
        else:
            inputs = p(images=rgb, return_tensors="pt")
        try:
            import torch

            ctx_mgr: Any = torch.inference_mode()
        except Exception:  # noqa: BLE001
            from contextlib import nullcontext

            ctx_mgr = nullcontext()
        with ctx_mgr:
            out = self._l.model(inference_session=session, frame=inputs["pixel_values"][0], frame_idx=int(local), reverse=False)
            post = p.postprocess_outputs(session, out, original_sizes=inputs["original_sizes"])
        self._prune(session, int(local))
        ids = [int(v) for v in _np(post["object_ids"]).reshape(-1).tolist()]
        if not ids:
            return {}
        masks = _np(post["masks"]).astype(bool)
        if masks.ndim == 2:
            masks = masks[None]
        scores = [float(v) for v in _np(post["scores"]).reshape(-1).tolist()]
        phrase_of: dict[int, str] = {}
        for text, oids in (post.get("prompt_to_obj_ids") or {}).items():
            for oid in oids:
                phrase_of[int(oid)] = str(text)
        out_d: dict[int, tuple[np.ndarray, float, str]] = {}
        for i, oid in enumerate(ids):
            m = np.ascontiguousarray(masks[i])
            if m.shape != (h, w):
                raise ValueError(f"SAM 3 遮罩 {m.shape} 與幀 {(h, w)} 不合（original_sizes 沒傳對？）")
            out_d[oid] = (m, scores[i] if i < len(scores) else 0.0, phrase_of.get(oid, ""))
        return out_d

    def _gid(self, phrase: str) -> int:
        g = self._next_gid
        self._next_gid += 1
        self.phrase_of[g] = phrase
        return g

    def run(self, frames: Iterable[tuple[int, np.ndarray]], phrases: list[str], check_cancel: Callable[[], None] | None = None) -> Iterator[TextFrame]:
        if not phrases:
            raise ValueError("SAM 3 文字追蹤至少要一個片語")
        restore = self._apply_threshold()
        session: Any = None
        local = 0
        local_to_gid: dict[int, int] = {}
        last_rgb: np.ndarray | None = None
        last_masks: dict[int, np.ndarray] = {}
        try:
            for k, rgb in frames:
                if check_cancel is not None:
                    check_cancel()
                t0 = time.perf_counter()
                if session is None:
                    session = self._new_session(phrases)
                    local, local_to_gid = 0, {}
                elif self.chunk and local >= self.chunk and last_rgb is not None:
                    # 分段：開新 session，把上一幀重新餵一次當重疊幀，用 IoU 把新 id 接回舊的全域 id
                    self._close(session)
                    session = self._new_session(phrases)
                    first = self._step(session, 0, last_rgb)
                    local = 1
                    cur_masks = {oid: v[0] for oid, v in first.items()}
                    cur_labels = {oid: v[2] for oid, v in first.items()}
                    prev_labels = {g: self.phrase_of.get(g, "") for g in last_masks}
                    links = link_by_iou_labels(last_masks, cur_masks, self.link_iou, prev_labels, cur_labels)
                    local_to_gid = dict(links)
                    self.stats.relinked += len(links)
                objs = self._step(session, local, rgb)
                local += 1
                masks: dict[int, np.ndarray] = {}
                scores: dict[int, float] = {}
                for oid, (m, sc, ph) in objs.items():
                    g = local_to_gid.get(oid)
                    if g is None:
                        g = self._gid(ph)
                        local_to_gid[oid] = g
                    masks[g] = m
                    scores[g] = sc
                last_rgb, last_masks = rgb, masks
                self.stats.frames += 1
                self.stats.seconds += time.perf_counter() - t0
                yield TextFrame(int(k), masks, scores)
        finally:
            if session is not None:
                self._close(session)
            restore()


def link_by_iou_labels(
    prev: Mapping[int, np.ndarray], cur: Mapping[int, np.ndarray], threshold: float,
    prev_labels: Mapping[int, str], cur_labels: Mapping[int, str],
) -> dict[int, int]:
    from .instances import link_by_iou

    return link_by_iou(prev, cur, threshold, prev_labels=prev_labels, cur_labels=cur_labels)
