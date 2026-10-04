"""分割後端選擇：`auto | sam3 | sam2`（`seg.find` 與 `seg.select` 共用同一條規則）。

| 要求 | SAM 3 權重在本機 | 結果 |
|------|------------------|------|
| auto（預設） | 有 | SAM 3 |
| auto | 沒有 | **後備**：文字 → OWLv2 找框 + SAM 2.1 傳播；點／框 → SAM 2.1。記一行 log 說明原因 |
| sam3 | 有 | SAM 3 |
| sam3 | 沒有、但有 HF token | 照試：ops 層先用 `ops.models.ensure_sam3` 下載（與 `models pull --sam3` 同一條路，有進度、可取消）；沒權限 → OpError(Model) 說明 gated |
| sam3 | 沒有、也沒有 token | 直接 OpError(Model)：沒有 token 不可能下載 gated 模型庫，不必白連一次網 |
| sam2 | — | OWLv2 + SAM 2.1（不檢查 SAM 3） |

「在本機」的判斷**不連網**（`sam3_hf.status`：transformers 有 SAM 3 類別 + HF 快取裡有完整快照）。
`--backend` 沒給時讀環境變數 `AIVC_SAM_BACKEND`（backend.py 的模組說明早就預留了這個名字），再沒有才是 auto。

後備的限制（誠實寫在這裡，help 與 docs 也寫）：
- OWLv2 只在**錨定幀**（預設範圍第一幀，`--samples N` 可多看幾幀）找框，之後全靠 SAM 2.1 傳播 ——
  錨定幀沒出現的物件找不到；鏡頭切換後 SAM 2.1 會追丟或黏到相似的東西（範圍請限制在同一個鏡頭內）。
- OWLv2 對長句、關係描述（「左邊那個人的臉」）弱；SAM 3 的開放詞彙偵測強很多。
"""
from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .backend import SegModelError

BACKEND_CHOICES = ("auto", "sam3", "sam2")
ENV_BACKEND = "AIVC_SAM_BACKEND"
_ALIASES = {"sam2.1": "sam2", "sam21": "sam2", "owl": "sam2", "owlv2": "sam2", "fallback": "sam2", "sam-3": "sam3"}

#: 給人看的後端名稱（find 的後備是兩個模型串起來；select 的後備只有 SAM 2.1）
LABELS_FIND = {"sam3": "SAM 3", "sam2": "OWLv2 + SAM 2.1"}
LABELS_SELECT = {"sam3": "SAM 3 tracker", "sam2": "SAM 2.1"}


@dataclass(frozen=True)
class BackendChoice:
    name: str  # "sam3" | "sam2"
    requested: str  # 使用者要的："auto" | "sam3" | "sam2"
    fallback: bool  # auto 因為 SAM 3 不能用而退到 sam2
    reason: str

    def to_json(self, labels: dict[str, str] = LABELS_FIND) -> dict[str, Any]:
        return {"name": self.name, "label": labels.get(self.name, self.name), "requested": self.requested, "fallback": self.fallback, "reason": self.reason}


def requested_backend(value: str | None) -> str:
    """`--backend` → 正規化的要求值（沒給 → AIVC_SAM_BACKEND → auto）。拼錯的值擲 Invalid，不默默當 auto。"""
    raw = value if value not in (None, "") else os.environ.get(ENV_BACKEND)
    v = (raw or "auto").strip().lower()
    v = _ALIASES.get(v, v)
    if v not in BACKEND_CHOICES:
        src = "--backend" if value not in (None, "") else ENV_BACKEND
        raise SegModelError("Invalid", f"{src} 只能是 {'｜'.join(BACKEND_CHOICES)}，拿到 {raw!r}")
    return v


def choose(requested: str | None, *, status_fn: Callable[[], Any] | None = None, token_fn: Callable[[], tuple[str | None, str]] | None = None) -> BackendChoice:
    """純邏輯（可注入假的 status／token）。見模組說明的表格。"""
    from . import sam3_hf

    req = requested_backend(requested)
    if req == "sam2":
        return BackendChoice("sam2", req, False, "指定 --backend sam2（OWLv2 + SAM 2.1）")
    st = (status_fn or sam3_hf.status)()
    if req == "sam3":
        if st.ready:
            return BackendChoice("sam3", req, False, st.reason)
        if not st.supported:
            raise SegModelError("PyEnv", st.reason, "引擎的 Python 環境需要較新的 transformers；或改用 --backend sam2")
        tok, _src = (token_fn or sam3_hf.find_hf_token)()
        if not tok:
            raise SegModelError("Model", f"{sam3_hf.gated_message()}：本機沒有 SAM 3 權重，也沒有設定 Hugging Face token", sam3_hf.gated_hint())
        return BackendChoice("sam3", req, False, "指定 --backend sam3；權重不在本機，會用 Hugging Face token 嘗試下載")
    if st.ready:
        return BackendChoice("sam3", req, False, st.reason)
    return BackendChoice("sam2", req, True, st.reason)


def fallback_log_line(choice: BackendChoice, task: str = "find") -> str:
    """`auto` 退到後備時印的那一行（ops 層用 ctx.log("warn", …) 送出）。"""
    labels = LABELS_FIND if task == "find" else LABELS_SELECT
    return f"SAM 3 不能用（{choice.reason}）→ 改用 {labels['sam2']}（後備；限制見 aivc {task} --help）"


def make_prompt_backend(
    choice: BackendChoice,
    *,
    device: str | None = "auto",
    sam_variant: str = "small",
    memory_window: int | None = 64,
    non_overlapping: bool = True,
) -> Any:
    """點／框提示用的後端（`open_session` → SegSession）。sam3 → SAM 3 追蹤器；sam2 → SAM 2.1。"""
    if choice.name == "sam3":
        from .sam3_hf import Sam3TrackerBackend

        return Sam3TrackerBackend(device=device, memory_window=memory_window, non_overlapping=non_overlapping)
    from .sam2_hf import Sam2HfBackend

    return Sam2HfBackend(variant=sam_variant, device=device, memory_window=memory_window, non_overlapping=non_overlapping)


def make_finder(
    choice: BackendChoice,
    *,
    device: str | None = "auto",
    sam_variant: str = "small",
    owl_variant: str = "base",
    chunk: int | None = None,
    memory_window: int | None = 64,
) -> Any:
    """文字找物件用的後端（`prepare()` 載模型、`find(frames, req, ctx)` 跑）。"""
    from . import finders

    if choice.name == "sam3":
        return finders.Sam3Finder(device=device, chunk=chunk, memory_window=memory_window)
    return finders.OwlSam2Finder(device=device, owl_variant=owl_variant, sam_variant=sam_variant, memory_window=memory_window)
