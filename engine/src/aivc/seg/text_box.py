"""用文字找出要追蹤的東西（開放詞彙偵測 → 框），框再交給既有的 `seg.run` 做 SAM 2.1 影片傳播。

## 為什麼是「只做框」而不是另一條追蹤管線

`seg.run` 本來就是框／點提示驅動的：一個 `--box` ＝ 一個物件（id 1..n），之後沿幀傳播遮罩。
所以「打字追蹤」缺的只有**文字 → 框**這一段，後面整條管線原封不動。這個模組刻意只負責那一段。

## 為什麼選 OWLv2 而不是 Grounding DINO

兩者都在已安裝的 transformers 5.17 裡（不必加任何新套件）。選 OWLv2 的理由是**輸出形狀對得上 seg.run**：
它吃一個「片語清單」、每個片語各自給分與框，可以 1:1 對應到 seg 的物件 id；
Grounding DINO 吃的是一整串用句點分隔的提示、做的是 phrase grounding，要再自己把框歸屬回片語。
代價：OWLv2 對長句、關係描述（「桌上左邊那張」）比 Grounding DINO 弱 —— 之後要支援那種描述再換。

## 載入策略

跟 `seg/sam2_hf.py` 同一套：lazy singleton（一個行程一份重模型）、先讀本機快取不連網
（`local_files_only=True`，理由見 sam2_hf 的 `_from_pretrained_local_first`）、
裝置與精度一律問 `aivc.device`，不寫死 cuda/bfloat16。

## ⚠ 要在迴圈裡邊解碼邊 detect：**先呼叫 `load()`**

在引擎 worker（`aivc serve`）裡，**第一次載入模型時如果 PyAV 的解碼器正開著就會卡死**：
請求永遠不回來，而且那個行程的 CPU 一動也不動（是被擋住，不是在算）。
2026-09-19 `reframe.plan` 踩到：同樣的參數 CLI 跑 27 秒、App 送進去永遠停在第一次偵測之前。

模型**載好之後**邊解邊跑是沒問題的（`seg.run` 一直都是先 `backend.loaded()` 再取幀）。
所以規則很簡單：要在持有解碼器的迴圈裡呼叫 `detect()`，就在開解碼器之前先 `load()` 一次。
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from .. import device as dev
from .. import env
from .backend import Box, SegModelError

#: 變體 → HF 模型 id。`models.pull` 與 CLI 的 --owl 選項共用這一份。
MODEL_IDS: dict[str, str] = {
    "base": "google/owlv2-base-patch16-ensemble",
    "large": "google/owlv2-large-patch14-ensemble",
}
DEFAULT_VARIANT = "base"

#: 預設分數門檻。OWLv2 的分數不是機率，0.1 是官方範例的值；低於這個的框幾乎都是雜訊。
DEFAULT_THRESHOLD = 0.1
#: 一次最多回幾個框 —— 每個框在 seg.run 都是一個要追蹤的物件，回太多只會讓人不知道選哪個。
DEFAULT_MAX_BOXES = 8


@dataclass(frozen=True)
class TextBox:
    """一個候選：框（x, y, w, h，來源像素）＋ 命中的片語＋分數。"""

    box: Box
    phrase: str
    score: float


@dataclass
class LoadedOwl:
    model: Any
    processor: Any
    model_id: str
    variant: str
    device: str
    load_seconds: float


_LOADED: LoadedOwl | None = None


def is_loaded() -> bool:
    return _LOADED is not None


def parse_phrases(text: str) -> list[str]:
    """使用者打的字 → 片語清單。

    逗號（半形與全形）與換行都當分隔符：使用者會打「杯子, 手」也會打「杯子、手」。
    去頭尾空白、丟掉空的、**保留輸入順序**並去重 —— 順序就是 seg.run 的物件 id 1..n，
    重排會讓同一句話在不同次執行對到不同的物件。
    """
    out: list[str] = []
    for chunk in text.replace("，", ",").replace("、", ",").replace("\n", ",").split(","):
        p = chunk.strip()
        if p and p not in out:
            out.append(p)
    return out


def boxes_from_detection(
    result: dict[str, Any],
    phrases: list[str],
    *,
    max_boxes: int = DEFAULT_MAX_BOXES,
    min_side: float = 2.0,
) -> list[TextBox]:
    """`post_process_grounded_object_detection` 的一筆結果 → TextBox 清單（純函式，可測）。

    - 框從 [x0, y0, x1, y1] 換成 seg.run 要的 (x, y, w, h)。
    - 依分數由高到低排；同分維持原順序（穩定排序）。
    - 邊長小於 `min_side` 的丟掉：OWLv2 偶爾吐出退化的框，餵給 SAM 會變成空遮罩。
    - `labels` 是片語的索引；超出範圍就記成 "?"（模型或版本不合時不要整批炸掉）。
    """
    scores = [float(s) for s in result.get("scores", [])]
    labels = [int(i) for i in result.get("labels", [])]
    raw = [[float(v) for v in b] for b in result.get("boxes", [])]
    out: list[TextBox] = []
    for i, box in enumerate(raw):
        if len(box) != 4:
            continue
        x0, y0, x1, y1 = box
        w, h = x1 - x0, y1 - y0
        if w < min_side or h < min_side:
            continue
        li = labels[i] if i < len(labels) else -1
        phrase = phrases[li] if 0 <= li < len(phrases) else "?"
        out.append(TextBox((x0, y0, w, h), phrase, scores[i] if i < len(scores) else 0.0))
    out.sort(key=lambda t: -t.score)
    return out[:max_boxes]


def load(variant: str = DEFAULT_VARIANT, device: str | None = None) -> LoadedOwl:
    """載入（或取回已載入的）OWLv2。換 variant/device 會先卸載舊的。"""
    global _LOADED  # noqa: PLW0603
    if variant not in MODEL_IDS:
        raise SegModelError("Invalid", f"未知的 OWLv2 變體 {variant!r}，可選 {sorted(MODEL_IDS)}")

    env.apply_model_env()
    import torch

    try:
        resolved = dev.resolve_device(device, torch)
    except dev.DeviceUnavailable as e:
        raise SegModelError("Gpu", str(e), e.hint) from e
    if _LOADED is not None:
        if _LOADED.variant == variant and _LOADED.device == resolved:
            return _LOADED
        unload()

    from transformers import Owlv2ForObjectDetection, Owlv2Processor

    from .sam2_hf import _from_pretrained_local_first  # 本機快取優先的同一套規則，不另外寫一份

    model_id = MODEL_IDS[variant]
    t0 = time.perf_counter()
    try:
        processor = _from_pretrained_local_first(Owlv2Processor, model_id)
        model = _from_pretrained_local_first(Owlv2ForObjectDetection, model_id)
    except Exception as e:  # noqa: BLE001
        raise SegModelError("Model", f"載入 {model_id} 失敗：{type(e).__name__}: {e}", f"跑 `aivc models pull --owl {variant}` 先把權重抓下來") from e
    # 這個模型只跑一幀、而且輸出是框不是遮罩，半精度省不了多少又多一種 MPS 地雷，一律 float32
    model = model.to(resolved).eval()
    _LOADED = LoadedOwl(model, processor, model_id, variant, resolved, time.perf_counter() - t0)
    return _LOADED


def unload() -> None:
    global _LOADED  # noqa: PLW0603
    if _LOADED is None:
        return
    _LOADED = None
    import gc

    gc.collect()


def detect(
    image_rgb: Any,
    text: str,
    *,
    variant: str = DEFAULT_VARIANT,
    device: str | None = None,
    threshold: float = DEFAULT_THRESHOLD,
    max_boxes: int = DEFAULT_MAX_BOXES,
) -> list[TextBox]:
    """在一張 RGB 影像上用文字找框。`image_rgb` 是 (H, W, 3) uint8 的 numpy 陣列。"""
    phrases = parse_phrases(text)
    if not phrases:
        raise SegModelError("Invalid", "沒有可用的文字提示（逗號分隔，例如「杯子, 手」）")

    loaded = load(variant, device)
    import torch

    h, w = int(image_rgb.shape[0]), int(image_rgb.shape[1])
    inputs = loaded.processor(text=[phrases], images=image_rgb, return_tensors="pt").to(loaded.device)
    with torch.inference_mode():
        outputs = loaded.model(**inputs)
    results = loaded.processor.post_process_grounded_object_detection(outputs, threshold=threshold, target_sizes=[(h, w)])
    return boxes_from_detection(results[0] if results else {}, phrases, max_boxes=max_boxes)
