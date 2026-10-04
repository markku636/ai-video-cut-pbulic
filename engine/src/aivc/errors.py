"""錯誤：`OpError` 本體定義在 `aivc.ops`（註冊表旁），這裡只做再匯出與便利建構子。

為什麼分兩層：ops/__init__.py 必須維持零依賴（CLI `--help` 要快、任何 op 模組壞掉也不能拖垮註冊表），
但 op 實作端想寫 `raise errors.invalid("...")` 而不是每次手打 kind 字串。kind 集合鏡射 Rust `error.rs`：
Invalid | Io | Ffmpeg | Canceled | Timeout | Gpu | Model | PyEnv | Engine | Internal。
"""
from __future__ import annotations

import re
import traceback

from .ops import Canceled, OpError

__all__ = [
    "Canceled",
    "OpError",
    "KINDS",
    "invalid",
    "io",
    "ffmpeg",
    "gpu",
    "model",
    "pyenv",
    "engine",
    "timeout",
    "internal",
    "from_exception",
    "exception_line",
]

KINDS: frozenset[str] = frozenset(
    {"Invalid", "Io", "Ffmpeg", "Canceled", "Timeout", "Gpu", "Model", "PyEnv", "Engine", "Internal"}
)


def invalid(message: str, hint: str = "") -> OpError:
    """參數／專案檔不合法（CLI 退出碼 2）。"""
    return OpError("Invalid", message, hint)


def io(message: str, hint: str = "") -> OpError:
    return OpError("Io", message, hint)


def ffmpeg(message: str, hint: str = "") -> OpError:
    return OpError("Ffmpeg", message, hint)


def gpu(message: str, hint: str = "") -> OpError:
    """CUDA 不可用／OOM／arch 不符（CLI 退出碼 3）。"""
    return OpError("Gpu", message, hint)


def model(message: str, hint: str = "") -> OpError:
    """模型缺或載入失敗（CLI 退出碼 4）。"""
    return OpError("Model", message, hint)


def pyenv(message: str, hint: str = "") -> OpError:
    return OpError("PyEnv", message, hint)


def engine(message: str, hint: str = "") -> OpError:
    return OpError("Engine", message, hint)


def timeout(message: str, hint: str = "") -> OpError:
    return OpError("Timeout", message, hint)


def internal(message: str, hint: str = "") -> OpError:
    return OpError("Internal", message, hint)


# Python traceback 的最後一行長得像 `RuntimeError: cuBLAS failed…`；鏡射 local_asr.rs 的 is_exception_line。
_EXC_LINE = re.compile(r"^(?:[A-Za-z_][\w.]*\.)?[A-Z][A-Za-z0-9_]*(?:Error|Exception|Exit|Interrupt|Warning)?\s*:\s*\S")


def exception_line(tb_text: str) -> str:
    """從 traceback 文字取「最後一行像例外的」；沒有就回最後一個非空行。

    為什麼不是單純最後一行：traceback 被截斷時最後一行可能是 `File …, line 26, in main`，那等於什麼都沒說。
    """
    last_nonempty = ""
    hit = ""
    for raw in tb_text.splitlines():
        line = raw.strip()
        if not line:
            continue
        last_nonempty = line
        if _EXC_LINE.match(line) and not line.startswith(("File ", "Traceback")):
            hit = line
    return hit or last_nonempty


def from_exception(e: BaseException, *, tb: str | None = None) -> OpError:
    """把任意例外映射成 OpError（不改動已經是 OpError 的）。

    映射原則：能給使用者可操作提示的才分類（檔案不存在 → Io；CUDA OOM → Gpu），其餘一律 Internal
    並把 traceback 的例外行放進 hint —— 那是 Rust 端 stderr 尾巴以外唯一的線索。
    """
    if isinstance(e, OpError):
        return e
    if isinstance(e, Canceled):
        return OpError("Canceled", "已取消", "")
    text = f"{type(e).__name__}: {e}"
    if tb is None:
        tb = "".join(traceback.format_exception(type(e), e, e.__traceback__))
    hint = exception_line(tb)
    if isinstance(e, FileNotFoundError):
        return OpError("Io", text, "檔案不存在或路徑錯誤")
    if isinstance(e, (PermissionError, IsADirectoryError, OSError)) and not isinstance(e, TimeoutError):
        return OpError("Io", text, hint)
    if isinstance(e, TimeoutError):
        return OpError("Timeout", text, hint)
    low = str(e).lower()
    gpu_oom_hint = _gpu_oom_hint(low, is_memory_error=isinstance(e, MemoryError))
    if gpu_oom_hint:
        return OpError("Gpu", text, gpu_oom_hint)
    if isinstance(e, MemoryError):
        return OpError("Internal", text, hint)
    if type(e).__name__ in {"OutOfMemoryError", "CudaError", "CUDAError"}:
        # torch.OutOfMemoryError（新版 torch 的 MPS／CUDA OOM 都可能是這個型別）訊息沒被上面認出來時的保底
        return OpError("Gpu", text, hint)
    return OpError("Internal", text, hint)


CUDA_OOM_HINT = "GPU 記憶體不足：關掉其他 GPU 程式或改用較小模型"
MPS_OOM_HINT = (
    "Apple GPU（MPS）記憶體不足：Mac 的 GPU 與系統共用記憶體，請關掉其他佔記憶體的 App、改用較小的 SAM 變體（--sam tiny），"
    "或縮短一次處理的鏡頭；調高 PYTORCH_MPS_HIGH_WATERMARK_RATIO 可能讓整台 Mac 卡死，不建議"
)
_MPS_WORD = re.compile(r"\bmps\b")


def _gpu_oom_hint(low: str, *, is_memory_error: bool = False) -> str:
    """GPU 記憶體不足就回給使用者的提示；不是 GPU OOM 回空字串。`low` 是小寫的例外訊息。

    為什麼 MPS 要分開認：Apple Silicon 的 OOM 訊息是 `MPS backend out of memory (MPS allocated: …, max allowed: …)`，
    裡面沒有 "cuda"，以前會被歸成 Internal（CLI 退出碼 1、提示只是 traceback 最後一行），使用者看不出是記憶體不夠。
    MPS 吃的是整機共用記憶體，所以提示不同於 CUDA（關其他 App，而不是「其他 GPU 程式」）。
    MPS 只認完整的 "out of memory" 與獨立的 "mps" 字：「timestamps」「room」這類子字串不能誤判成 GPU OOM。
    CUDA 維持原本的寬鬆規則（"cuda" + "out of memory"／"oom"），不改既有行為。
    """
    if _MPS_WORD.search(low) and ("out of memory" in low or is_memory_error):
        return MPS_OOM_HINT
    if "cuda" in low and ("out of memory" in low or "oom" in low or is_memory_error):
        return CUDA_OOM_HINT
    return ""
