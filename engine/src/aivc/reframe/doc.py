"""裁切路徑的檔案格式（`*.reframe.json`）：規劃端寫、渲染端讀。

## 為什麼存成「段」而不是逐幀

一支三分鐘 30 fps 的片有 5400 幀，逐幀存六個數字就是 3 萬多個數字。
但自動重構圖的結果**絕大多數是靜態段**（盲區的功勞），壓成 `[起, 迄, x, y]` 之後
典型只剩幾十段。小到可以直接在編輯器裡打開看、也小到可以塞進專案檔。

段是**半開區間** `[a, b)`，跟專案裡其他所有幀範圍同一個慣例（`sequence/`、`shots`），
少一個「這裡含不含尾」的思考成本。

## 往返必須精確

渲染端讀到的矩形要與規劃端算出的逐位元相同，否則「預覽看到的」與「匯出出來的」會差一兩格。
所以 `from_doc(to_doc(p)) == p`，而且測試就是這樣寫的。
"""

from __future__ import annotations

from typing import Any

from .path import CropRect, ReframeError, ReframePath, segments

VERSION = 1


def to_doc(path: ReframePath, *, fps: tuple[int, int] | None = None, meta: dict[str, Any] | None = None) -> dict[str, Any]:
    """`ReframePath` → 可以 `json.dump` 的字典。`meta` 放「這條路徑是怎麼來的」（提示詞、模型、抽樣間隔）。"""
    return {
        "version": VERSION,
        "source": list(path.source),
        "size": list(path.size),
        "frames": len(path.rects),
        "fps": list(fps) if fps else None,
        "cuts": list(path.cuts),
        "missing": path.missing,
        # [起, 迄不含, x, y]；w/h 整段固定，存在 size 裡就夠了
        "segments": [[a, b, r.x, r.y] for a, b, r in segments(path)],
        "meta": dict(meta or {}),
    }


def from_doc(doc: dict[str, Any]) -> ReframePath:
    """讀回 `ReframePath`。格式不對就擲 `ReframeError`（訊息要能指出是哪一欄，這是跨行程的邊界）。"""
    if not isinstance(doc, dict):
        raise ReframeError("重構圖路徑檔不是物件")
    v = doc.get("version")
    if v != VERSION:
        raise ReframeError(f"重構圖路徑檔版本是 {v!r}，這份程式只認得 {VERSION}")
    try:
        sw, sh = (int(x) for x in doc["source"])
        cw, ch = (int(x) for x in doc["size"])
        n = int(doc["frames"])
        segs = list(doc["segments"])
    except (KeyError, TypeError, ValueError) as e:
        raise ReframeError(f"重構圖路徑檔缺欄位或型別不對：{e}") from e
    if n < 0:
        raise ReframeError(f"frames 不能是負的（拿到 {n}）")

    rects: list[CropRect] = []
    filled = 0
    for i, seg in enumerate(segs):
        try:
            a, b, x, y = (int(z) for z in seg)
        except (TypeError, ValueError) as e:
            raise ReframeError(f"第 {i} 段格式不對（要 [起, 迄, x, y]）：{seg!r}") from e
        if a != filled:
            raise ReframeError(f"第 {i} 段從 {a} 開始，但前面只鋪到 {filled}（段必須連續且不重疊）")
        if b <= a:
            raise ReframeError(f"第 {i} 段是空的或反向（{a} → {b}）")
        rects.extend([CropRect(x=x, y=y, w=cw, h=ch)] * (b - a))
        filled = b
    if filled != n:
        raise ReframeError(f"段共鋪了 {filled} 幀，但 frames 是 {n}")
    return ReframePath(
        source=(sw, sh), size=(cw, ch), rects=rects,
        cuts=[int(c) for c in doc.get("cuts") or []], missing=int(doc.get("missing") or 0),
    )
