"""SAM 2.1 via transformers `Sam2VideoModel` + `Sam2VideoProcessor`（串流模式，計畫 §6.2）。

實測 transformers 5.17.0 的 API（名稱與 HF 文件一致，這裡記下幾個文件沒寫清楚、會咬人的行為）：
- `processor.init_video_session(video=None, inference_device, inference_state_device, video_storage_device, dtype)`
  不傳 video ＝ 串流；`inference_state_device` 預設等於 inference_device（記憶庫放 GPU）。
- `processor.add_inputs_to_inference_session(session, frame_idx, obj_ids, input_points, input_labels, input_boxes,
  original_size=(H, W), clear_old_inputs)`：**`session.obj_with_new_inputs` 是被指派、不是追加**，
  所以連續對兩個物件下提示再跑一次 forward，第一個物件的提示會被吃掉（沒有 cond 輸出 → 傳播時擲錯）。
  對策：每下一個物件的提示就跑一次 forward（同幀特徵有快取，成本只有那個物件的 decoder）。
- `model(inference_session=s, frame_idx=k, frame=pixel_values[0], reverse=bool)`：串流下可指定 frame_idx（我們用真實幀號，
  記憶庫依 k-1..k-6／k+1..k+6 找前幀，所以餵幀順序必須沿方向連續）。**`reverse=True` 就是反向傳播**，
  同一個 session 先 fwd 再 bwd 皆可，不需要第二個 session（計畫 §6.2 的疑問已驗證）。
- `session.processed_frames[k]` 存每幀 3×1024×1024 bf16 像素（6 MB/幀）於 video_storage_device，只在算該幀特徵時讀一次
  → 每幀算完就丟（`prune_frames`），否則一個 430 幀鏡頭吃 2.6 GB RAM。
- 記憶庫每物件每幀存 maskmem_features/pos_enc/pred_masks（~1 MB），模型只回看 num_maskmem-1=6 幀 + 16 個物件指標，
  所以距離目前幀與所有 cond 幀都超過 `memory_window`（預設 64）的非 cond 輸出可以丟，結果不變。
- `processor.post_process_masks([pred_masks], original_sizes=[[H, W]], binarize=False, apply_non_overlapping_constraints)`
  → 上採樣到原尺寸的 logits，我們自己 `> mask_threshold` 得 bool。
- `out.object_score_logits[i] < 0` ＝ 模型判定物件不在（被遮／掃走），此時 pred_masks 已被模型清空。

模型每行程只載一份（lazy singleton；`unload()` 釋放 VRAM）。權重首次使用時下載到 HF_HOME（env.apply_model_env）。
載入一律先讀本機快取、不連網（`_from_pretrained_local_first`），快取沒有才連 Hub；已下載的模型不會自動更新，
要更新跑 `aivc models pull --force`。

裝置與精度一律問 `aivc.device`（CUDA bfloat16／MPS float16 或 float32／CPU float32 且需 AIVC_ALLOW_CPU=1），
這裡不再寫死 "cuda" 與 bfloat16：macOS 沒有 CUDA，而 MPS 的 bf16 覆蓋面不如 fp16。
MPS fp16 出 NaN 或運算不支援時，本模組呼叫 `device.mark_mps_float16_unusable()` 並擲 SegModelError(Gpu)；
同行程下一次 `load()` 會發現偏好 dtype 變成 float32 而重載（使用者重試一次即可）。
"""
from __future__ import annotations

import math
import time
from collections.abc import Iterable, Iterator, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

from .. import device as dev
from .. import env
from .backend import Box, Direction, FrameMasks, Point, SegModelError, SessionStats, validate_box, validate_points

MODEL_IDS: dict[str, str] = {
    "tiny": "facebook/sam2.1-hiera-tiny",
    "small": "facebook/sam2.1-hiera-small",
    "base": "facebook/sam2.1-hiera-base-plus",
    "large": "facebook/sam2.1-hiera-large",
}
DEFAULT_VARIANT = "small"


@dataclass
class LoadedSam2:
    model: Any
    processor: Any
    model_id: str
    variant: str
    device: str
    load_seconds: float
    preprocess_on_device: bool  # 影像前處理（resize/normalize）能不能直接在 GPU 做
    dtype: Any = None  # torch dtype；None 只出現在舊呼叫端／測試替身，session 端視同 bfloat16


_LOADED: LoadedSam2 | None = None  # 行程內唯一的重模型（決策 14：一次只駐留一個）

# MPS fp16 出事時的提示（device 的黏著退路已經切到 float32，所以重試就會好）
_MPS_RETRY_HINT = f"已切換為 float32，再執行一次即可；要一開始就用 float32，設 {dev.MPS_DTYPE_ENV}=float32"


def is_loaded() -> bool:
    return _LOADED is not None


def load(variant: str = DEFAULT_VARIANT, device: str | None = None) -> LoadedSam2:
    """載入（或取回已載入的）SAM 2.1。換 variant/device/dtype 會先卸載舊的。

    device：None / "auto" 自動選（cuda → mps → 放行時 cpu）；明確指定就照辦，不可用擲 SegModelError(Gpu)。
    """
    global _LOADED  # noqa: PLW0603
    if variant not in MODEL_IDS:
        raise SegModelError("Invalid", f"未知的 SAM 變體 {variant!r}，可選 {sorted(MODEL_IDS)}")

    env.apply_model_env()
    import torch

    try:
        resolved = dev.resolve_device(device, torch)
    except dev.DeviceUnavailable as e:
        raise SegModelError("Gpu", str(e), e.hint) from e
    dtype = dev.preferred_dtype(resolved, torch)
    if _LOADED is not None:
        if _LOADED.variant == variant and _LOADED.device == resolved and _LOADED.dtype == dtype:
            return _LOADED
        unload()
    _unload_sam3()

    from transformers import Sam2VideoModel, Sam2VideoProcessor

    model_id = MODEL_IDS[variant]
    t0 = time.perf_counter()
    try:
        processor = _from_pretrained_local_first(Sam2VideoProcessor, model_id)
        model = _from_pretrained_local_first(Sam2VideoModel, model_id, dtype=dtype)
    except Exception as e:  # noqa: BLE001
        raise SegModelError("Model", f"載入 {model_id} 失敗：{type(e).__name__}: {e}", _load_hint(model_id)) from e
    try:
        model = model.to(resolved).eval()
    except Exception as e:  # noqa: BLE001
        if dev.device_kind(resolved) == "mps" and dev.is_mps_dtype_error(e):
            dev.mark_mps_float16_unusable(f"{type(e).__name__}: {e}")
            raise SegModelError("Gpu", f"MPS 不支援 {dev.preferred_dtype_name(resolved)} 權重：{e}", _MPS_RETRY_HINT) from e
        raise
    preprocess_on_device = _probe_preprocess_device(processor, resolved)
    _LOADED = LoadedSam2(model, processor, model_id, variant, resolved, time.perf_counter() - t0, preprocess_on_device, dtype)
    return _LOADED


#: `_from_pretrained_local_first` 吞掉的「本機那次」失敗原因（只留最後一筆，給提示文字用）。
_LAST_LOCAL_ERROR: list[str] = []


def _load_hint(model_id: str) -> str:
    """載入失敗的提示。本機已經有這個 repo 的快照時，「下載」不是答案——Hub 會解析到同一顆壞掉的 blob（etag 相同），
    只有 `--force` 重抓才救得回來，而那件事以前只寫在 commit message 與 `--force` 自己的 help 裡（B-05）。"""
    try:
        from .. import env
        from ..ops.models import hub_cache_dir

        env.apply_model_env()
        if (hub_cache_dir() / f"models--{model_id.replace('/', '--')}").is_dir():
            variant = next((v for v, m in MODEL_IDS.items() if m == model_id), "small")
            why = f"（本機載入失敗：{_LAST_LOCAL_ERROR[-1]}）" if _LAST_LOCAL_ERROR else ""
            return f"本機已有 {model_id} 的快取但載不起來{why}；`aivc models pull` 會直接說「已在快取」，要用 `aivc models pull --sam {variant} --force` 重新下載"
    except Exception:  # noqa: BLE001 — 提示文字算不出來不該蓋掉真正的錯誤
        pass
    return "首次使用需要網路下載權重（small 約 185 MB）；或用 `aivc models pull`"


def _from_pretrained_local_first(cls: Any, model_id: str, **kw: Any) -> Any:
    """先只讀本機快取（`local_files_only=True`，不連網）；本機沒有／不完整才照舊連 Hub（首次下載）。

    為什麼：不加這個旗標，transformers 每次載入都向 Hub 發 ~29 個 HTTPS 請求確認版本（線上 3.8 s vs 本機 0.3 s，
    run.py 每次 pipeline.run 後都卸載，所以 serve 每跑一次就付一次）；代理拒絕連線時卡 150 s 以上，
    封包被丟的防火牆後面 transformers 5.17 沒接住 httpx.ConnectTimeout，seg 直接失敗。
    代價：已下載的模型不再自動跟 Hub 對版本 —— 要更新請明確跑 `aivc models pull --force`。
    本機那次的任何例外（找不到、半套快照、版本差異）都先當成「沒有快取」再連網試一次，與 ops/models.cached_snapshot
    同一原則；但**權重被截斷不是沒有快取**：Hub 會解析到同一顆 blob，第二次一定同樣失敗。所以本機那次的原因
    要留下來（`_LAST_LOCAL_ERROR`）並鏈在最終例外的 `__cause__` 上，提示才講得出 `--force`（B-05）。
    """
    try:
        return cls.from_pretrained(model_id, local_files_only=True, **kw)
    except Exception as local_err:  # noqa: BLE001
        # 本機那次的原因要留下來：權重被截斷、dtype／OOM、transformers 版本不合都會被這個 fallback 吃掉，
        # 使用者只看得到「連網那次」的訊息，而連網那次拿到的是同一顆快取 blob（etag 一樣），一定同樣失敗。
        _LAST_LOCAL_ERROR.append(f"{type(local_err).__name__}: {local_err}")
        del _LAST_LOCAL_ERROR[:-1]
        try:
            return cls.from_pretrained(model_id, **kw)
        except Exception as net_err:
            raise net_err from local_err


def _unload_sam3() -> None:
    """決策 14（一次只駐留一個重模型）：SAM 3（`aivc find`／`select` 的首選後端，~0.85 B 參數）在記憶體裡時先放掉。
    反方向在 `sam3_hf._free_other_models`。只看 sys.modules：從沒用過 SAM 3 的行程連模組都不 import。"""
    import sys

    mod = sys.modules.get("aivc.seg.sam3_hf")
    if mod is not None and mod.is_loaded():
        mod.unload()


def unload() -> None:
    global _LOADED  # noqa: PLW0603
    if _LOADED is None:
        return
    _LOADED = None
    import gc

    gc.collect()
    try:
        dev.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def _probe_preprocess_device(processor: Any, device: str) -> bool:
    """fast image processor 可以把 resize/normalize 丟到 GPU（省 CPU 十幾毫秒/幀）；不行就退回 CPU。

    MPS 也試：torchvision 的 resize/normalize 在 MPS 有 kernel；沒有的話例外 → 退回 CPU 前處理，結果相同。
    """
    kind = dev.device_kind(device)
    if kind not in ("cuda", "mps"):
        return False
    try:
        dummy = np.zeros((16, 16, 3), np.uint8)
        enc = processor(images=dummy, return_tensors="pt", device=device)
        return dev.device_kind(str(enc["pixel_values"].device)) == kind
    except Exception:  # noqa: BLE001
        return False


class Sam2HfSession:
    """一個串流 session（一個鏡頭）。實作 backend.SegSession。"""

    def __init__(
        self,
        loaded: LoadedSam2,
        frame_size: tuple[int, int],
        *,
        memory_window: int | None = 64,
        prune_frames: bool = True,
        non_overlapping: bool = True,
        mask_threshold: float = 0.0,
    ) -> None:
        import torch

        self._l = loaded
        self.frame_size = (int(frame_size[0]), int(frame_size[1]))
        self.memory_window = memory_window
        self.prune_frames = prune_frames
        self.non_overlapping = non_overlapping
        self.mask_threshold = float(mask_threshold)
        self.stats = SessionStats()
        self._cond_frames: set[int] = set()
        self._obj_ids: list[int] = []
        self._dtype = loaded.dtype if loaded.dtype is not None else torch.bfloat16
        # 只有 MPS fp16 需要數值／不支援運算的偵測（CUDA bf16 路徑維持原樣，不多付同步成本）
        self._mps_fp16 = dev.device_kind(loaded.device) == "mps" and self._dtype == torch.float16
        self._session = loaded.processor.init_video_session(
            inference_device=loaded.device,
            inference_state_device=loaded.device,
            video_storage_device="cpu",
            dtype=self._dtype,
        )

    # ---- SegSession ----
    @property
    def object_ids(self) -> list[int]:
        return list(self._obj_ids)

    @property
    def cond_frames(self) -> list[int]:
        return sorted(self._cond_frames)

    def add_prompt(
        self,
        frame_idx: int,
        obj_id: int,
        frame_rgb: np.ndarray,
        *,
        points: Sequence[Point] = (),
        box: Box | None = None,
    ) -> np.ndarray:
        return self.add_prompt_frame(frame_idx, obj_id, frame_rgb, points=points, box=box).masks[int(obj_id)]

    def add_prompt_frame(
        self,
        frame_idx: int,
        obj_id: int,
        frame_rgb: np.ndarray,
        *,
        points: Sequence[Point] = (),
        box: Box | None = None,
    ) -> FrameMasks:
        """`add_prompt` 的完整版：回這一幀所有物件的 FrameMasks（含 object score logit；`aivc select` 拿它當信心分數）。"""
        import torch

        pts = validate_points(points)
        bx = validate_box(box) if box is not None else None
        if not pts and bx is None:
            raise ValueError("add_prompt 至少要有一個點或一個框")
        self._check_frame(frame_rgb)
        w, h = self.frame_size
        t0 = time.perf_counter()
        kwargs: dict[str, Any] = {}
        if pts:
            kwargs["input_points"] = [[[[x, y] for x, y, _ in pts]]]
            kwargs["input_labels"] = [[[label for _, _, label in pts]]]
        if bx is not None:
            x, y, bw, bh = bx
            kwargs["input_boxes"] = [[[x, y, x + bw, y + bh]]]
        # 有框 → 重新開始（SAM2 規定框必須先於點）；只有點 → 累加到既有提示（逐點加選／減選）
        self._l.processor.add_inputs_to_inference_session(
            inference_session=self._session,
            frame_idx=int(frame_idx),
            obj_ids=[int(obj_id)],
            original_size=(h, w),
            clear_old_inputs=bx is not None,
            **kwargs,
        )
        with torch.inference_mode():
            pix = self._preprocess(frame_rgb)
            out = self._forward(frame_idx=int(frame_idx), frame=pix)
            fm = self._postprocess(out)
        self._cond_frames.add(int(frame_idx))
        if int(obj_id) not in self._obj_ids:
            self._obj_ids.append(int(obj_id))
        self.stats.prompt_frames += 1
        self.stats.prompt_seconds += time.perf_counter() - t0
        return fm

    def propagate_frames(self, frames: Iterable[tuple[int, np.ndarray]], direction: Direction) -> Iterator[FrameMasks]:
        import torch

        if direction not in ("fwd", "bwd"):
            raise ValueError(f"direction 只能是 'fwd' 或 'bwd'，拿到 {direction!r}")
        if not self._obj_ids:
            raise RuntimeError("還沒有任何提示（先 add_prompt）")
        reverse = direction == "bwd"
        last_k: int | None = None
        for k, rgb in frames:
            k = int(k)
            if last_k is not None and ((k <= last_k) if not reverse else (k >= last_k)):
                raise ValueError(f"傳播幀序必須沿 {direction} 嚴格單調：{last_k} → {k}")
            last_k = k
            self._check_frame(rgb)
            t0 = time.perf_counter()
            with torch.inference_mode():
                pix = self._preprocess(rgb)
                out = self._forward(frame_idx=k, frame=pix, reverse=reverse)
                fm = self._postprocess(out)
            self._prune(k)
            dt = time.perf_counter() - t0
            self.stats.propagated_frames += 1
            self.stats.propagate_seconds += dt
            self.stats.per_frame_seconds.append(dt)
            yield fm

    def propagate(self, frames: Iterable[tuple[int, np.ndarray]], direction: Direction) -> Iterator[tuple[int, int, np.ndarray]]:
        for fm in self.propagate_frames(frames, direction):
            for obj_id, m in fm.masks.items():
                yield fm.k, obj_id, m

    def close(self) -> None:
        try:
            self._session.reset_inference_session()
        except Exception:  # noqa: BLE001
            pass
        self._session = None
        self._cond_frames.clear()
        self._obj_ids.clear()

    # ---- internals ----
    def _forward(self, **kwargs: Any) -> Any:
        try:
            return self._l.model(inference_session=self._session, **kwargs)
        except Exception as e:  # noqa: BLE001
            if self._mps_fp16 and dev.is_mps_dtype_error(e):
                self._mps_fp16_failed(f"{type(e).__name__}: {e}", e)
            raise

    def _mps_fp16_failed(self, reason: str, cause: BaseException | None = None) -> None:
        """MPS fp16 在這台機器上不能用：記下黏著退路（同行程改 float32）並大聲失敗，不回傳空遮罩。

        不在這裡原地換 dtype 重跑：session 的記憶庫已是 fp16 張量，混精度會在更深處出錯；
        下一次 load() 看到偏好 dtype 變了會整個重載，比較乾淨。
        """
        dev.mark_mps_float16_unusable(reason)
        raise SegModelError("Gpu", f"Apple GPU（MPS）float16 推論失敗：{reason}", _MPS_RETRY_HINT) from cause

    def _check_frame(self, rgb: np.ndarray) -> None:
        w, h = self.frame_size
        if rgb.ndim != 3 or rgb.shape[2] != 3 or rgb.dtype != np.uint8:
            raise ValueError(f"幀必須是 RGB8 (H, W, 3) uint8，拿到 shape={rgb.shape} dtype={rgb.dtype}")
        if rgb.shape[0] != h or rgb.shape[1] != w:
            raise ValueError(f"幀尺寸 {rgb.shape[1]}x{rgb.shape[0]} 與 session {w}x{h} 不合")

    def _preprocess(self, rgb: np.ndarray) -> Any:
        if self._l.preprocess_on_device:
            enc = self._l.processor(images=rgb, return_tensors="pt", device=self._l.device)
        else:
            enc = self._l.processor(images=rgb, return_tensors="pt")
        return enc["pixel_values"][0].to(self._l.device, dtype=self._dtype)

    def _postprocess(self, out: Any) -> FrameMasks:
        w, h = self.frame_size
        pred = out.pred_masks
        if pred.dim() == 3:
            pred = pred.unsqueeze(0)
        # fp16 注意力溢位會讓 logits 變 NaN：NaN > 門檻恆為 False → 遮罩安靜地全空。寧可大聲失敗
        if self._mps_fp16 and not bool(pred.isfinite().all()):
            self._mps_fp16_failed("pred_masks 含 NaN/Inf（fp16 溢位）")
        up = self._l.processor.post_process_masks(
            [pred.float()],
            original_sizes=[[h, w]],
            mask_threshold=self.mask_threshold,
            binarize=False,
            apply_non_overlapping_constraints=self.non_overlapping and len(out.object_ids) > 1,
        )[0]
        binary = (up > self.mask_threshold).squeeze(1).cpu().numpy()
        if binary.ndim == 2:
            binary = binary[None]
        scores = out.object_score_logits.float().reshape(-1).cpu().tolist()
        if self._mps_fp16 and not all(math.isfinite(v) for v in scores):
            self._mps_fp16_failed("object_score_logits 含 NaN/Inf（fp16 溢位）")
        obj_ids = list(out.object_ids)
        masks = {int(oid): np.ascontiguousarray(binary[i]) for i, oid in enumerate(obj_ids)}
        sc = {int(oid): float(scores[i]) if i < len(scores) else 0.0 for i, oid in enumerate(obj_ids)}
        return FrameMasks(int(out.frame_idx), masks, sc)

    def _prune(self, k: int) -> None:
        s = self._session
        if self.prune_frames and s.processed_frames:
            for fk in [f for f in s.processed_frames if f != k and f not in self._cond_frames]:
                del s.processed_frames[fk]
        if self.memory_window is not None:
            win = int(self.memory_window)
            cond = self._cond_frames
            for obj_idx in range(s.get_obj_num()):
                nc = s.output_dict_per_obj[obj_idx]["non_cond_frame_outputs"]
                stale = [f for f in nc if abs(f - k) > win and all(abs(f - c) > win for c in cond)]
                for f in stale:
                    del nc[f]


@dataclass
class Sam2HfBackend:
    """backend.SegBackend 實作。`open_session` 才真正載模型。"""

    variant: str = DEFAULT_VARIANT
    device: str | None = None  # None ＝ 自動（cuda → mps → 放行時 cpu），見 aivc.device.resolve_device
    memory_window: int | None = 64
    prune_frames: bool = True
    non_overlapping: bool = True
    mask_threshold: float = 0.0
    name: str = "sam2_hf"

    def loaded(self) -> LoadedSam2:
        return load(self.variant, self.device)

    def open_session(self, frame_size: tuple[int, int]) -> Sam2HfSession:
        return Sam2HfSession(
            self.loaded(),
            frame_size,
            memory_window=self.memory_window,
            prune_frames=self.prune_frames,
            non_overlapping=self.non_overlapping,
            mask_threshold=self.mask_threshold,
        )

    def unload(self) -> None:
        unload()


def cuda_max_memory_mb() -> float | None:
    """GPU 峰值記憶體（MB）。名稱沿用（ops/seg、ops/run 已經 import 它），實際上 CUDA 與 MPS 都支援：
    MPS 沒有峰值 API，回的是 Metal 驅動配置總量（上限估計），細節見 device.max_memory_allocated_mb。"""
    return gpu_max_memory_mb()


def gpu_max_memory_mb() -> float | None:
    try:
        return dev.max_memory_allocated_mb()
    except Exception:  # noqa: BLE001
        return None


def hf_cache_size_bytes(model_id: str) -> int | None:
    """該模型在 HF_HOME/hub 的快取大小（回報下載量用）。"""
    import os
    from pathlib import Path

    env.apply_model_env()
    hub = Path(os.environ.get("HF_HUB_CACHE") or (Path(os.environ["HF_HOME"]) / "hub"))
    d = hub / ("models--" + model_id.replace("/", "--"))
    if not d.is_dir():
        return None
    # Windows 沒有 symlink 權限時 hub 會把 blobs 複製進 snapshots → 只數 blobs 才不會加倍
    if (d / "blobs").is_dir():
        d = d / "blobs"
    total = 0
    for p in d.rglob("*"):
        try:
            if p.is_file() and not p.is_symlink():
                total += p.stat().st_size
        except OSError:
            pass
    return total
