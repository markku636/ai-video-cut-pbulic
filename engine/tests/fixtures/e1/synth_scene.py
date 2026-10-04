"""E1 測試用合成場景（核心版、通用）：深色背景＋藍色檯面 + 貼上去的平面（RGBA 圖）→ PyAV 寫成小 ffv1 影片 → 專案檔 + solve + 遮罩。

不需要範例影片、不需要 GPU；只需要 PyAV（寫片）與 ffmpeg（render 那一步）。
座標慣例與引擎一致：quad = TL,TR,BR,BL 邊界慣例；貼圖用 `hg.edge_to_cv` 轉成 cv2 中心慣例。
核心本身沒有插入來源：要合成就用測試外掛 `fixtures/plugins/aivc_test_insert.py`（track.extra["testInsert"]，見 make_project）。
牌局版（格位＋牌組）在外掛的測試 plugins/cards/engine/tests/fixtures/e1/synth_scene.py。
"""
from __future__ import annotations

from fractions import Fraction
from pathlib import Path

import cv2
import numpy as np

from aivc.geom import homography as hg
from aivc.project import paths as P
from aivc.project import schema as S
from aivc.seg.maskfile import MaskFile
from aivc.track.state import FrameSolve, Solve, State

FELT_RGB = (18, 52, 132)
BG_RGB = (24, 40, 36)
W, H = 1280, 720
TEMPLATE_WH = (630, 880)


def felt_frame(w: int = W, h: int = H, felt_from: float = 0.36) -> np.ndarray:
    img = np.zeros((h, w, 3), np.uint8)
    img[:] = BG_RGB
    img[int(h * felt_from) :, :] = FELT_RGB
    return img


def card_quad(x: float, y: float, w: float, h: float) -> np.ndarray:
    """軸對齊的四邊形（TL,TR,BR,BL）。名字沿用舊的；任何平面都適用。"""
    return np.array([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], dtype=np.float64)


def paste_rgba(frame_rgb8: np.ndarray, rgba: np.ndarray, quad: np.ndarray, shade: float = 1.0) -> np.ndarray:
    """把 RGBA 貼圖（任意 w×h）依 quad 貼進幀（TL,TR,BR,BL ↔ 貼圖四角）。就地修改並回傳。"""
    th, tw = rgba.shape[:2]
    Hm = hg.template_to_quad((tw, th), quad)
    M = hg.edge_to_cv(Hm)
    Wf, Hf = frame_rgb8.shape[1], frame_rgb8.shape[0]
    rgb = cv2.warpPerspective(rgba[..., :3].astype(np.float32) * shade, M, (Wf, Hf), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    a = cv2.warpPerspective(rgba[..., 3].astype(np.float32) / 255.0, M, (Wf, Hf), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)[..., None]
    out = frame_rgb8.astype(np.float32) * (1 - a) + rgb * a
    frame_rgb8[...] = np.clip(out, 0, 255).astype(np.uint8)
    return frame_rgb8


def quad_mask(quad: np.ndarray, w: int = W, h: int = H) -> np.ndarray:
    m = np.zeros((h, w), np.uint8)
    cv2.fillConvexPoly(m, np.round(quad).astype(np.int32), 1)
    return m.astype(bool)


def write_clip(path: str | Path, frames: list[np.ndarray], fps: int = 30, codec: str = "ffv1") -> Path:
    """rgb8 幀 → yuv420p ffv1 .mkv（PyAV 內建編碼器，不需要 ffmpeg）。"""
    import av

    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with av.open(str(p), "w") as c:
        s = c.add_stream(codec, rate=fps)
        s.width, s.height = int(frames[0].shape[1]), int(frames[0].shape[0])
        s.pix_fmt = "yuv420p"
        s.codec_context.time_base = Fraction(1, fps)
        for i, rgb in enumerate(frames):
            f = av.VideoFrame.from_ndarray(np.ascontiguousarray(rgb), format="rgb24").reformat(format="yuv420p")
            f.pts = i
            f.time_base = Fraction(1, fps)
            for pkt in s.encode(f):
                c.mux(pkt)
        for pkt in s.encode():
            c.mux(pkt)
    return p


def make_sign_rgba(kind: str = "new", wh: tuple[int, int] = TEMPLATE_WH) -> np.ndarray:
    """測試用的平面圖（RGBA，白底圓角）：new＝紅塊＋黑橫條；orig＝藍塊＋黑直條。兩張的墨位置不同，換上去看得出來。"""
    w, h = wh
    img = np.zeros((h, w, 4), np.uint8)
    img[..., :3] = 250
    r = int(min(w, h) * 0.06)
    a = np.zeros((h, w), np.uint8)
    cv2.rectangle(a, (r, 0), (w - 1 - r, h - 1), 255, -1)
    cv2.rectangle(a, (0, r), (w - 1, h - 1 - r), 255, -1)
    for cx, cy in ((r, r), (w - 1 - r, r), (r, h - 1 - r), (w - 1 - r, h - 1 - r)):
        cv2.circle(a, (cx, cy), r, 255, -1, cv2.LINE_AA)
    img[..., 3] = a
    if kind == "new":
        cv2.rectangle(img, (int(w * 0.12), int(h * 0.10)), (int(w * 0.45), int(h * 0.30)), (205, 35, 35, 255), -1)
        for i in range(4):
            y = int(h * (0.45 + 0.1 * i))
            cv2.rectangle(img, (int(w * 0.15), y), (int(w * 0.85), y + int(h * 0.04)), (25, 25, 25, 255), -1)
    else:
        cv2.rectangle(img, (int(w * 0.55), int(h * 0.65)), (int(w * 0.88), int(h * 0.88)), (35, 60, 205, 255), -1)
        for i in range(3):
            x = int(w * (0.15 + 0.12 * i))
            cv2.rectangle(img, (x, int(h * 0.12)), (x + int(w * 0.05), int(h * 0.55)), (25, 25, 25, 255), -1)
    img[a == 0, :3] = 0
    return img


def write_sign_pngs(root: Path) -> tuple[Path, Path]:
    """(new.png, orig.png)：給 testInsert 的 image／original。"""
    from aivc.imageio import imwrite_unicode

    root.mkdir(parents=True, exist_ok=True)
    out = []
    for kind in ("new", "orig"):
        p = root / f"{kind}.png"
        rgba = make_sign_rgba(kind)
        imwrite_unicode(p, cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA))
        out.append(p)
    return out[0], out[1]


def make_project(
    video: Path,
    n_frames: int,
    tracks: list[dict],
    *,
    fps: int = 30,
    w: int = W,
    h: int = H,
    shot_kind: str = "close",
) -> tuple[Path, S.ProjectFileV1, P.MediaCache]:
    """tracks: [{id, quad, image?, original?, name?, target?, states?, masks?, occluders?, conf?, ref?, template_wh?, region?}]
    → 專案檔（影片旁邊）、solve、遮罩都寫好。

    image／original：RGBA PNG 路徑 → track.extra["testInsert"]（測試外掛 aivc_test_insert 讀）；image 省略 ＝ 不換。
    solve：每幀同一個 H（靜止），state 預設 STATIC、conf 1.0。遮罩：quad 多邊形（可用 occluders={k: bool mask} 減掉遮擋物）。
    """
    fp = P.fingerprint_for(video)
    cache = P.media_cache(fp).ensure()
    project = S.ProjectFileV1(profile="generic")
    media = S.MediaV1(id="m1", path=str(video), name=video.name, fingerprint=fp, probe=None, proxy=S.ProxyMetaV1(S.Rational(fps, 1), n_frames, w, h, 1.0))
    project.media.append(media)
    project.active_media_id = "m1"
    project.shots["m1"] = [S.ShotV1(id="s1", start_frame=0, end_frame=n_frames, kind=shot_kind, source="auto")]
    tlist: list[S.TrackV1] = []
    for spec in tracks:
        tid, quad = spec["id"], np.asarray(spec["quad"], dtype=np.float64)
        name = spec.get("name", tid)
        t = S.TrackV1(id=tid, shot_id="s1", label=name, reference_frame=spec.get("ref", 0), keyframes=[S.KeyframeV1(frame=spec.get("ref", 0), quad=S.Quad.from_points(quad), source="detector")], stale=False)
        t.extra["testInsert"] = {"image": str(spec["image"]) if spec.get("image") else None, "original": str(spec["original"]) if spec.get("original") else None, "name": name, "target": spec.get("target", "card")}
        if spec.get("region"):
            t.region_policy = spec["region"]
        tlist.append(t)
        tw, th = spec.get("template_wh", TEMPLATE_WH)
        Hm = hg.template_to_quad((tw, th), quad)
        solve = Solve(tid, (0, n_frames), spec.get("ref", 0), (tw, th))
        states = spec.get("states") or {}
        for k in range(n_frames):
            st = states.get(k, State.STATIC)
            solve.frames[k] = FrameSolve(k, None if st == State.LOST else Hm, spec.get("conf", 1.0) if st != State.LOST else 0.0, st, pinned=(k == spec.get("ref", 0)))
        solve.write(cache.solve(tid), cache.solve(tid).with_name("solve.hud.v1.json"))
        if spec.get("masks", True):
            base = quad_mask(quad, w, h)
            occ = spec.get("occluders") or {}
            MaskFile.write(cache.masks(tid), w, h, ((k, (base & ~occ[k]) if k in occ else base) for k in range(n_frames)))
    project.tracks["m1"] = tlist
    ppath = video.with_name(video.stem + ".aivc.json")
    S.save(project, ppath)
    return ppath, project, cache


class RecordingCtx:
    """測試用 Ctx：記進度／log，可在第 n 次 check_cancel 取消。"""

    def __init__(self, cancel_after: int | None = None) -> None:
        self.progress_calls: list[tuple[str, int, int, dict]] = []
        self.logs: list[tuple[str, str]] = []
        self.artifacts: list[tuple[str, str]] = []
        self.cancel_after = cancel_after
        self.checks = 0

    def progress(self, stage: str, done: int, total: int, **extra: object) -> None:
        self.progress_calls.append((stage, done, total, dict(extra)))

    def log(self, level: str, message: str) -> None:
        self.logs.append((level, message))

    def check_cancel(self) -> None:
        from aivc.ops import Canceled

        self.checks += 1
        if self.cancel_after is not None and self.checks > self.cancel_after:
            raise Canceled()

    def artifact(self, path: str, kind: str = "") -> None:
        self.artifacts.append((path, kind))

    def stages(self) -> list[str]:
        out: list[str] = []
        for s, *_ in self.progress_calls:
            if not out or out[-1] != s:
                out.append(s)
        return out


__all__ = ["FELT_RGB", "BG_RGB", "W", "H", "TEMPLATE_WH", "felt_frame", "card_quad", "paste_rgba", "quad_mask", "write_clip", "make_sign_rgba", "write_sign_pngs", "make_project", "RecordingCtx"]
