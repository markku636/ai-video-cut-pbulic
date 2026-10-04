"""讀單張畫面：PNG/JPG 直接讀；影片用 PyAV **從頭順序解碼數幀**取第 k 幀（來源解碼順序）。

為什麼不 seek：範例 VP9 只有 18 個關鍵幀、VFR、沒有 nb_frames；`seek()` 只能到關鍵幀，而且
seek 之後沒人知道前面有幾幀 —— 幀號會錯。60 s 的片從頭解一趟只要幾秒，正確比快重要。
（正式的 proxy 幀 k ↔ 來源幀 map[k] 對應由 media/ 的 CfrMap 負責；這裡的 k 是**來源解碼順序**的幀號。）
"""
from __future__ import annotations

import os
from collections.abc import Callable, Iterable
from pathlib import Path

import numpy as np

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff"}


def is_image_path(path: str | os.PathLike[str]) -> bool:
    return Path(path).suffix.lower() in IMAGE_EXTS


def read_image_rgb8(path: str | os.PathLike[str]) -> np.ndarray:
    """讀圖成 RGB8。用 np.fromfile + imdecode 而不是 cv2.imread：後者在 Windows 吃不下非 ASCII 路徑。"""
    import cv2

    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(str(p))
    buf = np.fromfile(str(p), dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"無法解碼影像：{p}")
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def write_image_rgb8(path: str | os.PathLike[str], rgb8: np.ndarray) -> None:
    import cv2

    from .. import atomic

    p = Path(path)
    ok, buf = cv2.imencode(p.suffix or ".png", cv2.cvtColor(rgb8, cv2.COLOR_RGB2BGR))
    if not ok:
        raise ValueError(f"無法編碼影像：{p}")
    # 直接 tofile 會讓讀的人（App 預覽）看到寫一半的 PNG；換成暫存檔 + os.replace
    with atomic.atomic_path(p) as tmp:
        buf.tofile(str(tmp))


def video_stream_info(path: str | os.PathLike[str]) -> dict:
    """輕量探測（不解碎）：寬高、fps（r_frame_rate 對應 average_rate/guessed_rate）、估計幀數（可能 None）。"""
    import av

    with av.open(str(path)) as container:
        vs = container.streams.video[0]
        rate = vs.average_rate or vs.guessed_rate or vs.base_rate
        fps = float(rate) if rate else None
        frames = int(vs.frames) if vs.frames else None
        duration_s: float | None = None
        if vs.duration is not None and vs.time_base is not None:
            duration_s = float(vs.duration * vs.time_base)
        elif container.duration is not None:
            duration_s = container.duration / 1_000_000.0
        if frames is None and duration_s and fps:
            frames = int(round(duration_s * fps))
        return {"width": int(vs.codec_context.width), "height": int(vs.codec_context.height), "fps": fps, "frames": frames, "durationS": duration_s}


def read_video_frames_rgb8(
    path: str | os.PathLike[str],
    frames: Iterable[int],
    *,
    progress: Callable[[int, int], None] | None = None,
    check_cancel: Callable[[], None] | None = None,
) -> dict[int, np.ndarray]:
    """從頭順序解碼，收集 `frames` 指定的來源幀（解碾順序幀號）為 RGB8。找不到的幀不在回傳 dict 裡。

    progress(done, total) 每 15 幀呼叫一次；check_cancel 每幀呼叫（合作式取消）。
    """
    import av

    wanted = sorted({int(k) for k in frames if int(k) >= 0})
    out: dict[int, np.ndarray] = {}
    if not wanted:
        return out
    last = wanted[-1]
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(str(p))
    with av.open(str(p)) as container:
        vs = container.streams.video[0]
        vs.thread_type = "AUTO"
        idx = 0
        want_set = set(wanted)
        for frame in container.decode(vs):
            if check_cancel is not None:
                check_cancel()
            if idx in want_set:
                out[idx] = frame.to_ndarray(format="rgb24")
            if progress is not None and (idx % 15 == 0 or idx == last):
                progress(min(idx, last), last)
            if idx >= last:
                break
            idx += 1
    return out
