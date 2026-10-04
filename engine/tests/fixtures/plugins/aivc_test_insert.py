"""測試用的迷你外掛：一個通用的「貼圖」插入來源（核心本身沒有任何插入來源，渲染管線要有它才測得到合成）。

用法：
- 同一個行程：`aivc.plugins.load_plugin("aivc_test_insert")`（tests/conftest.py 的 `image_insert` fixture）；
- `aivc serve` 子行程：PYTHONPATH 加上這個目錄、`AIVC_PLUGINS` 加上 `aivc_test_insert`（fixtures/protocol/serve_client.py）。

track.extra["testInsert"] = {"image": RGBA PNG（新面）, "original": RGBA PNG（原面，可省）, "name": 計畫 JSON 的 slot 名,
"target": "card"|"blank"}。沒有 testInsert 的 track 不歸它管；有 testInsert 但沒有 image ＝ 歸它管但這次不換（InsertSkip）。
模板尺寸＝solve 的 template_wh（H 不用換算）。也順便示範外掛的寫法：register(host) 只登記、重的 import 放在用到的地方。
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

PLUGIN_NAME = "test-insert"
__version__ = "0.0.0-test"


@dataclass
class ImageTemplate:
    rgb: Any
    alpha: Any
    ink_mask: Any
    barcode_px: tuple[int, int, int, int] | None = None

    @property
    def size(self) -> tuple[int, int]:
        return int(self.rgb.shape[1]), int(self.rgb.shape[0])


@dataclass
class Binding:
    name: str


_CACHE: dict[tuple[str, int, int], ImageTemplate] = {}


def load_template(path: str, wh: tuple[int, int]) -> ImageTemplate:
    """RGBA PNG → 模板尺寸的 rgb／alpha／墨遮罩（`comp.region.derive_masks_from_template`：暗或有彩度＝墨）。"""
    key = (str(path), int(wh[0]), int(wh[1]))
    hit = _CACHE.get(key)
    if hit is not None:
        return hit
    import cv2
    import numpy as np

    from aivc.comp.region import derive_masks_from_template
    from aivc.imageio import imread_unicode

    img = imread_unicode(str(path), cv2.IMREAD_UNCHANGED)
    if img.shape[2] == 4:
        rgb = cv2.cvtColor(img[..., :3], cv2.COLOR_BGR2RGB)
        a8 = img[..., 3]
    else:
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        a8 = np.full(rgb.shape[:2], 255, np.uint8)
    if (rgb.shape[1], rgb.shape[0]) != tuple(wh):
        rgb = cv2.resize(rgb, tuple(wh), interpolation=cv2.INTER_AREA)
        a8 = cv2.resize(a8, tuple(wh), interpolation=cv2.INTER_AREA)
    ink, _paper = derive_masks_from_template(rgb, a8)
    t = ImageTemplate(np.ascontiguousarray(rgb), a8.astype(np.float32) / 255.0, ink)
    _CACHE[key] = t
    return t


class ImageInsertSource:
    name = "test-image"

    def claim(self, mctx: Any, track: Any, session: Any) -> Any:
        from aivc.ops.render import InsertSkip

        spec = track.extra.get("testInsert")
        if not isinstance(spec, dict):
            return None
        if not spec.get("image"):
            return InsertSkip("testInsert 沒有 image（不替換）")
        return spec

    def describe(self, project: Any, media_id: str, track: Any) -> dict[str, Any] | None:
        spec = track.extra.get("testInsert")
        if not isinstance(spec, dict) or not spec.get("image"):
            return None
        return {"slot": spec.get("name") or track.label, "image": Path(str(spec["image"])).name}

    def build(self, mctx: Any, ctx: Any, track: Any, shot: Any, solve: Any, spec: dict[str, Any], session: Any) -> Any:
        from aivc.ops.render import InsertSpec, resolve_shutter_auto
        from aivc.project import resolve as R

        params = resolve_shutter_auto(R.insert_params_for(track, mctx.project), None, ctx, track.id)
        wh = (int(solve.template_wh[0]), int(solve.template_wh[1]))
        new = load_template(str(spec["image"]), wh)
        orig = load_template(str(spec["original"]), wh) if spec.get("original") else None
        session.cache["test-image.builds"] = session.cache.get("test-image.builds", 0) + 1
        return InsertSpec(
            slot=Binding(str(spec.get("name") or track.label or track.id)), params=params, target=str(spec.get("target") or "card"),
            target_code=Path(str(spec["image"])).stem, original=None if orig is None else Path(str(spec["original"])).stem, rotation=0,
            tmpl_new=new, tmpl_orig=orig, template_wh=wh,
        )

    def setup_jobs(self, jobs: list[Any], mctx: Any, ctx: Any, session: Any) -> None:
        session.cache["test-image.jobs"] = [j.track.id for j in jobs]


SOURCE = ImageInsertSource()


def register(host: Any) -> None:
    host.add_insert_source(SOURCE)
