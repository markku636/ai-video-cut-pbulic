"""非 ASCII 路徑安全的影像讀寫：取代 `cv2.imread`／`cv2.imwrite`。

Windows 上 cv2（實測 4.14）用 ANSI 版的檔案 API 開路徑：`C:/Users/王小明/…`、`換花色 測試/8H.png` 這類路徑
`imread` 安靜回 None、`imwrite` 安靜回 False —— 同一個檔放在 ASCII 資料夾就正常。App 的模板預設放在
%LOCALAPPDATA% 底下，所以中文 Windows 使用者名稱會讓整條經典追蹤壞掉。

作法：檔案 IO 交給 Python（`np.fromfile`／`ndarray.tofile` 走 Unicode API），cv2 只做記憶體內的
`imdecode`／`imencode`。解碼結果與 `imread` 相同（同一個解碼器、同一套 EXIF 轉向規則；PNG/JPG 逐位元一致）。

錯誤語意（呼叫端保留自己的「讀不到…」訊息給不存在的檔）：
- 檔案不存在 → FileNotFoundError；是資料夾／沒權限 → 其他 OSError
- 檔案讀得到但解不出來（空檔、損毀、格式不支援）→ ValueError
- 寫入：副檔名不支援或編碼失敗 → ValueError；磁碟／權限問題 → OSError

寫入先寫同資料夾的**唯一**暫存檔（`aivc.atomic`）再 `os.replace`（被鎖會退避重試）：讀的人（App 預覽）不會看到寫一半的 PNG，失敗也不會留下截斷的舊檔。

`tests/test_unicode_paths.py` 有守門測試：`aivc/` 底下出現 `cv2.imread(`／`cv2.imwrite(` 就失敗。
"""
from __future__ import annotations

import os
from collections.abc import Sequence
from pathlib import Path

import numpy as np

from . import atomic


def imread_unicode(path: str | os.PathLike[str], flags: int | None = None) -> np.ndarray:
    """`cv2.imread(path, flags)` 的替代品；flags 省略＝IMREAD_COLOR（與 cv2 預設相同）。回傳 cv2 慣例（BGR/BGRA/灰階）。"""
    import cv2

    p = os.fspath(path)
    buf = np.fromfile(p, dtype=np.uint8)  # 不存在 → FileNotFoundError（呼叫端自己決定訊息）
    img = None
    if buf.size:
        try:
            img = cv2.imdecode(buf, cv2.IMREAD_COLOR if flags is None else int(flags))
        except cv2.error:
            img = None
    if img is None:
        raise ValueError(f"圖檔讀得到但無法解碼（檔案損毀或格式不支援）：{p}")
    return img


def imwrite_unicode(path: str | os.PathLike[str], img: np.ndarray, params: Sequence[int] = ()) -> None:
    """`cv2.imwrite(path, img, params)` 的替代品：格式看副檔名；失敗擲例外（不像 cv2 回 False）。不會自動建資料夾。"""
    import cv2

    p = Path(os.fspath(path))
    ext = p.suffix
    try:
        ok, buf = cv2.imencode(ext, img, list(params))
    except cv2.error as e:
        raise ValueError(f"無法編碼影像（副檔名 {ext or '（無）'}）：{p}：{e}") from e
    if not ok:
        raise ValueError(f"無法編碼影像（副檔名 {ext or '（無）'}）：{p}")
    tmp = atomic.temp_sibling(p, ".tmp")
    try:
        with atomic.inflight(tmp):
            buf.tofile(os.fspath(tmp))
            atomic.replace_retry(tmp, p)
    except BaseException:
        atomic.unlink_quiet(tmp)
        raise
