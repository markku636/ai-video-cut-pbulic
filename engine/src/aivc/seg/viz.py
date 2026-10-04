"""給人與 AI 看的圖：編號疊色、提示點／框、縮圖、聯絡表（contact sheet）、0–1000 座標格線。

這些圖是**驗收用**的（Claude Code／Codex 看圖確認「選對了沒」，人看預覽），不是成品：
- 文字只畫 ASCII（物件編號、幀號、格線刻度），cv2.putText 畫不了中文；片語留在 JSON 裡。
- 編號標在**離遮罩邊界最遠的點**而不是重心：甜甜圈、C 字形的重心會落在物件外面。
- 顏色沿用 `seg.preview.PALETTE`（依編號取模），同一個物件在疊色圖、縮圖、聯絡表裡顏色一致。
存檔一律走 `seg.preview.save_png`（暫存檔 + os.replace、Unicode 路徑安全）。
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence

import numpy as np

from .preview import color_for

_FONT = 0  # cv2.FONT_HERSHEY_SIMPLEX（不在模組層 import cv2）


def _cv2():  # noqa: ANN202
    import cv2

    return cv2


def put_label(img: np.ndarray, text: str, org: tuple[int, int], *, scale: float = 0.5, color: tuple[int, int, int] = (255, 255, 255), thickness: int = 1) -> None:
    """白字黑邊（任何背景都讀得到）；org 是左下基線點。只吃 ASCII。"""
    cv2 = _cv2()
    t = max(1, int(thickness))
    cv2.putText(img, text, org, _FONT, scale, (0, 0, 0), t + 2, cv2.LINE_AA)
    cv2.putText(img, text, org, _FONT, scale, color, t, cv2.LINE_AA)


def title_bar(img: np.ndarray, text: str, *, scale: float | None = None) -> None:
    """左上角半透明黑底標題（就地）。"""
    cv2 = _cv2()
    h, w = img.shape[:2]
    s = scale if scale is not None else max(0.4, min(0.8, w / 1400.0))
    (tw, th), base = cv2.getTextSize(text, _FONT, s, 1)
    x1, y1 = min(w, tw + 12), min(h, th + base + 10)
    roi = img[0:y1, 0:x1].astype(np.float32)
    img[0:y1, 0:x1] = (roi * 0.45).astype(np.uint8)
    put_label(img, text, (6, th + 5), scale=s, color=(255, 255, 0))


def label_point(mask: np.ndarray) -> tuple[int, int] | None:
    """離遮罩邊界最遠的點（大遮罩先縮小再算，省時間）。空遮罩回 None。"""
    cv2 = _cv2()
    if not mask.any():
        return None
    h, w = mask.shape
    s = max(1, int(max(h, w) // 320))
    small = mask[::s, ::s].astype(np.uint8)
    if not small.any():
        ys, xs = np.nonzero(mask)
        return int(xs.mean()), int(ys.mean())
    dist = cv2.distanceTransform(np.pad(small, 1), cv2.DIST_L2, 3)[1:-1, 1:-1]
    y, x = np.unravel_index(int(np.argmax(dist)), dist.shape)
    return int(x * s + s // 2), int(y * s + s // 2)


def tint_masks(rgb: np.ndarray, masks: Mapping[int, np.ndarray | None], *, alpha: float = 0.45, contour: int = 2) -> np.ndarray:
    """回傳疊好色（填色＋輪廓）的新影像；顏色依物件編號。"""
    cv2 = _cv2()
    out = rgb.astype(np.float32).copy()
    for oid, m in masks.items():
        if m is None or not m.any():
            continue
        c = np.array(color_for(oid), np.float32)
        sel = m.astype(bool)
        out[sel] = out[sel] * (1.0 - alpha) + c * alpha
    out8 = np.ascontiguousarray(out.clip(0, 255).astype(np.uint8))
    for oid, m in masks.items():
        if m is None or not m.any():
            continue
        cnts, _ = cv2.findContours(m.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(out8, cnts, -1, color_for(oid), max(1, int(contour)), lineType=cv2.LINE_AA)
    return out8


def numbered_overlay(rgb: np.ndarray, masks: Mapping[int, np.ndarray | None], *, title: str | None = None) -> np.ndarray:
    """疊色＋每個物件在自己身上標編號（圓底色塊 + 白字）。`seg.find` 的 overlay.png、`preview-object` 的每一格都用它。"""
    cv2 = _cv2()
    out = tint_masks(rgb, masks)
    h, w = out.shape[:2]
    s = max(0.5, min(1.4, min(h, w) / 600.0))
    for oid, m in masks.items():
        if m is None or not m.any():
            continue
        p = label_point(m)
        if p is None:
            continue
        txt = str(oid)
        (tw, th), _ = cv2.getTextSize(txt, _FONT, s, 2)
        r = int(max(tw, th) * 0.75) + 4
        cv2.circle(out, p, r, (0, 0, 0), -1, cv2.LINE_AA)
        cv2.circle(out, p, r - 2, color_for(oid), -1, cv2.LINE_AA)
        put_label(out, txt, (p[0] - tw // 2, p[1] + th // 2), scale=s, thickness=2)
    if title:
        title_bar(out, title)
    return out


def draw_prompts(
    img: np.ndarray,
    points: Sequence[tuple[float, float, int]] = (),
    box: tuple[float, float, float, float] | None = None,
    *,
    derived_box: Sequence[float] | None = None,
    derived_anchor: Sequence[float] | None = None,
) -> np.ndarray:
    """就地畫提示：加選點＝綠底白框圓、減選點＝紅底白 ×、框＝黃色、推導出來的框＝青色細線、錨點＝綠色菱形。"""
    cv2 = _cv2()
    h, w = img.shape[:2]
    r = max(5, int(round(min(h, w) / 80)))
    if derived_box is not None:
        x, y, bw, bh = derived_box
        cv2.rectangle(img, (int(round(x)), int(round(y))), (int(round(x + bw)) - 1, int(round(y + bh)) - 1), (0, 220, 255), 1, cv2.LINE_AA)
    if box is not None:
        x, y, bw, bh = box
        cv2.rectangle(img, (int(round(x)), int(round(y))), (int(round(x + bw)) - 1, int(round(y + bh)) - 1), (255, 220, 0), max(1, r // 3), cv2.LINE_AA)
    for x, y, lb in points:
        c = (int(round(x - 0.5)), int(round(y - 0.5)))
        if lb:
            cv2.circle(img, c, r, (255, 255, 255), -1, cv2.LINE_AA)
            cv2.circle(img, c, r - 2, (40, 200, 40), -1, cv2.LINE_AA)
        else:
            cv2.circle(img, c, r, (255, 255, 255), -1, cv2.LINE_AA)
            cv2.circle(img, c, r - 2, (220, 40, 40), -1, cv2.LINE_AA)
            d = max(2, r - 4)
            cv2.line(img, (c[0] - d, c[1] - d), (c[0] + d, c[1] + d), (255, 255, 255), 2, cv2.LINE_AA)
            cv2.line(img, (c[0] - d, c[1] + d), (c[0] + d, c[1] - d), (255, 255, 255), 2, cv2.LINE_AA)
    if derived_anchor is not None:
        x, y = derived_anchor
        c = (int(round(x - 0.5)), int(round(y - 0.5)))
        pts = np.array([[c[0], c[1] - r], [c[0] + r, c[1]], [c[0], c[1] + r], [c[0] - r, c[1]]], np.int32)
        cv2.fillPoly(img, [pts], (40, 200, 40), cv2.LINE_AA)
        cv2.polylines(img, [pts], True, (255, 255, 255), 1, cv2.LINE_AA)
    return img


def fit_max_side(rgb: np.ndarray, max_side: int | None) -> tuple[np.ndarray, float]:
    """長邊縮到 ≤ max_side（INTER_AREA；不放大）。回 (影像, 縮放倍率)。"""
    cv2 = _cv2()
    h, w = rgb.shape[:2]
    if not max_side or max(h, w) <= int(max_side):
        return rgb, 1.0
    s = int(max_side) / float(max(h, w))
    nw, nh = max(1, int(round(w * s))), max(1, int(round(h * s)))
    return cv2.resize(rgb, (nw, nh), interpolation=cv2.INTER_AREA), nw / float(w)


def thumbnail(rgb: np.ndarray, mask: np.ndarray, oid: int, *, max_side: int = 256, pad: float = 0.2, min_side: int = 96) -> np.ndarray:
    """物件縮圖：外接框外擴 pad、畫輪廓，長邊縮到 max_side（太小的放大到 min_side，看得清楚）。"""
    cv2 = _cv2()
    h, w = mask.shape
    ys, xs = np.nonzero(mask)
    if xs.size == 0:
        crop, cm = rgb, mask
    else:
        x0, x1, y0, y1 = int(xs.min()), int(xs.max()) + 1, int(ys.min()), int(ys.max()) + 1
        px = max(4, int(round((x1 - x0) * pad)))
        py = max(4, int(round((y1 - y0) * pad)))
        x0, y0, x1, y1 = max(0, x0 - px), max(0, y0 - py), min(w, x1 + px), min(h, y1 + py)
        crop, cm = rgb[y0:y1, x0:x1], mask[y0:y1, x0:x1]
    out = np.ascontiguousarray(crop.copy())
    cnts, _ = cv2.findContours(cm.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cv2.drawContours(out, cnts, -1, color_for(oid), max(1, int(round(max(out.shape[:2]) / 160))), lineType=cv2.LINE_AA)
    ch, cw = out.shape[:2]
    s = min(float(max_side) / max(ch, cw), 1.0)
    if max(ch, cw) * s < min_side:
        s = min(4.0, float(min_side) / max(ch, cw))
    if abs(s - 1.0) > 1e-6:
        out = cv2.resize(out, (max(1, int(round(cw * s))), max(1, int(round(ch * s)))), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
    return out


def contact_sheet(tiles: Sequence[np.ndarray], *, cols: int = 3, gap: int = 6, bg: tuple[int, int, int] = (24, 24, 24)) -> np.ndarray:
    """等大格子拼成一張（格子大小＝最大的那一格；小的置中）。"""
    if not tiles:
        return np.full((16, 16, 3), bg, np.uint8)
    cols = max(1, min(int(cols), len(tiles)))
    rows = (len(tiles) + cols - 1) // cols
    th = max(t.shape[0] for t in tiles)
    tw = max(t.shape[1] for t in tiles)
    out = np.full((rows * th + (rows + 1) * gap, cols * tw + (cols + 1) * gap, 3), bg, np.uint8)
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        y = gap + r * (th + gap) + (th - t.shape[0]) // 2
        x = gap + c * (tw + gap) + (tw - t.shape[1]) // 2
        out[y : y + t.shape[0], x : x + t.shape[1]] = t
    return out


def grid_overlay(rgb: np.ndarray, *, step: int = 100, minor: int = 50) -> np.ndarray:
    """0–1000 正規化座標格線（給視覺模型讀座標）：每 step 一條實線＋刻度字、每 minor 一條淡線。

    座標＝`x / 1000 × 寬`（1000 對到右／下邊界），與 `aivc select --coords norm1000` 的換算完全相同；
    格線畫在**輸出圖**上，所以圖被縮小過也照樣對得上。"""
    cv2 = _cv2()
    out = rgb.astype(np.float32).copy()
    h, w = out.shape[:2]
    alpha = np.zeros((h, w), np.float32)
    for v in range(0, 1001, minor):
        a = 0.55 if v % step == 0 else 0.22
        x = min(w - 1, int(round(v / 1000.0 * w)))
        y = min(h - 1, int(round(v / 1000.0 * h)))
        alpha[:, x] = np.maximum(alpha[:, x], a)
        alpha[y, :] = np.maximum(alpha[y, :], a)
    out = out * (1.0 - alpha[..., None]) + np.float32(255.0) * alpha[..., None]  # 白線：任何畫面都看得到
    out8 = np.ascontiguousarray(out.clip(0, 255).astype(np.uint8))
    s = max(0.35, min(0.6, min(h, w) / 1600.0))
    for v in range(step, 1000, step):
        x = int(round(v / 1000.0 * w))
        y = int(round(v / 1000.0 * h))
        (tw, th), _ = cv2.getTextSize(str(v), _FONT, s, 1)
        put_label(out8, str(v), (max(0, x - tw // 2), th + 3), scale=s, color=(255, 255, 0))
        put_label(out8, str(v), (2, min(h - 2, y + th // 2)), scale=s, color=(255, 255, 0))
    put_label(out8, "0", (2, 12), scale=s, color=(255, 255, 0))
    put_label(out8, "x,y: 0-1000", (max(0, w - int(130 * s / 0.45)), h - 6), scale=s, color=(255, 255, 0))
    return out8
