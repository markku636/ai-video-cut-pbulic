"""真模型 smoke（GPU）：後備路線 OWLv2 + SAM 2.1 的 find → select → fx → 聯絡表，跑在一支真影片上。

    AIVC_RUN_GPU_TESTS=1 AIVC_SMOKE_VIDEO=<影片> [AIVC_SMOKE_TEXT="frog"] [AIVC_SMOKE_OUT=<資料夾>] pytest -m gpu tests/test_objects_gpu.py

- 影片：AIVC_SMOKE_VIDEO，沒設就用參考片段（tests/_sample.py；gitignored，沒有就 skip）。
- 文字：AIVC_SMOKE_TEXT（預設 "playing card"：內建素材第 0 幀 OWLv2 分數 ~0.7；"person" 在第 0 幀只有 0.096、低於門檻）。
  **用內建素材＋預設文字時至少要找到一個實例**（以前 0 個實例也是綠燈：OWLv2 整合整個壞掉也抓不到）；
  自帶素材或文字時找不到不算失敗（那是素材的事），但檔案與 JSON 形狀一定要對。
- 產物：AIVC_SMOKE_OUT（預設 pytest 的 tmp_path）——要用眼睛看 overlay.png／sheet.png 時指定一個固定資料夾。
SAM 3 不在這裡測：開發機的 Hugging Face 帳號沒有 facebook/sam3 的存取權（`--backend auto` 會走後備）。
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

pytestmark = pytest.mark.gpu

from _sample import sample_path  # noqa: E402


@pytest.fixture(scope="module")
def video() -> Path:
    p = Path(os.environ.get("AIVC_SMOKE_VIDEO") or sample_path())
    if not p.is_file():
        pytest.skip(f"沒有 smoke 影片 {p}（設 AIVC_SMOKE_VIDEO）")
    return p


@pytest.fixture(scope="module")
def out_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    o = os.environ.get("AIVC_SMOKE_OUT")
    d = Path(o) if o else tmp_path_factory.mktemp("smoke")
    d.mkdir(parents=True, exist_ok=True)
    return d


def _ctx() -> Any:
    from aivc.ops._ctx import CliCtx

    return CliCtx()


def _n_frames(video: Path) -> tuple[int, int, int]:
    from aivc.ops import media as M

    mc, pr = M.open_media(str(video), _ctx())
    _idx, cfr, _ = M.ensure_index(str(video), mc, pr, _ctx())
    return int(cfr.n_frames), int(pr.width), int(pr.height)


DEFAULT_TEXT = "playing card"


def _builtin(video: Path) -> bool:
    """內建素材＋預設文字（沒有被環境變數覆寫）：這個組合一定找得到東西。"""
    return not os.environ.get("AIVC_SMOKE_VIDEO") and not os.environ.get("AIVC_SMOKE_TEXT")


def test_find_後備真模型(video: Path, out_dir: Path) -> None:
    from aivc.ops import load_all
    from aivc.ops.find import seg_find

    load_all()
    n, W, H = _n_frames(video)
    k1 = min(n, 120)
    r = seg_find({"video": str(video), "text": os.environ.get("AIVC_SMOKE_TEXT", DEFAULT_TEXT), "out": str(out_dir / "find"), "frames": f"0:{k1}", "backend": "auto"}, _ctx())
    assert r["format"] == "aivc.find.v1" and Path(r["overlay"]["path"]).is_file()
    saved = json.loads((out_dir / "find" / "find.v1.json").read_text(encoding="utf-8"))
    assert saved["instances"] == r["instances"]
    if _builtin(video):
        assert len(r["instances"]) >= 1, f"內建素材＋{DEFAULT_TEXT!r} 一定找得到：0 個實例＝偵測整合壞了（notes：{r['notes']}）"
    for inst in r["instances"]:
        assert inst["framesPresent"] > 0
        assert Path(inst["masks"]).is_file() and Path(inst["thumb"]).is_file() and inst["firstFrame"] <= inst["bestFrame"] <= inst["lastFrame"]


def test_find_後備真模型_巢狀的不同片語都找得到(video: Path, out_dir: Path) -> None:
    """回歸（真模型）：「person, face」以前臉整個落在人的框裡被當成重複框丟掉（dropped=1，只剩 person）。"""
    if not _builtin(video):
        pytest.skip("這個回歸只對內建參考片段（第 60 幀有人與臉）有意義")
    from aivc.ops import load_all
    from aivc.ops.find import seg_find

    load_all()
    r = seg_find({"video": str(video), "text": "person, face", "out": str(out_dir / "find_nested"), "frames": "60:70", "backend": "sam2"}, _ctx())
    assert {i["phrase"] for i in r["instances"]} == {"person", "face"}, (r["instances"], r["notes"])


def test_select_框選傳播_再套馬賽克(video: Path, out_dir: Path) -> None:
    from aivc.ops import load_all
    from aivc.ops.fx import fx_apply, fx_preview
    from aivc.ops.objects import objects_preview
    from aivc.ops.select import seg_select
    from aivc.seg.maskfile import MaskFile

    load_all()
    n, W, H = _n_frames(video)
    k1 = min(n, 120)
    box = os.environ.get("AIVC_SMOKE_BOX", "350,350,300,300")  # norm1000：畫面中間一塊
    # 明確給 --obj 1：固定的 AIVC_SMOKE_OUT 重跑時要覆寫上一次的 obj1（沒給 --obj 時 select 不覆寫既有物件）
    r = seg_select({"video": str(video), "frame": k1 // 2, "coords": "norm1000", "box": [box], "propagate": f"0:{k1}", "obj": 1, "out": str(out_dir / "select")}, _ctx())
    assert r["area"] > 0 and Path(r["overlay"]).is_file()
    masks = r["propagated"]["masks"]
    mf = MaskFile.open(masks)
    assert mf.frames() == list(range(k1)) and len(mf) > k1 // 2
    sheet = objects_preview({"video": str(video), "masks": [masks], "out": str(out_dir / "select" / "sheet.png")}, _ctx())
    assert Path(sheet["out"]).is_file() and sheet["tiles"] == 6
    out = out_dir / "fx_mosaic.mp4"
    fr = fx_apply({"video": str(video), "masks": [masks], "effects": '[{"type": "mosaic"}]', "out": str(out), "frames": f"0:{k1}"}, _ctx())
    assert out.is_file() and fr["frames"] == k1 and fr["changedFrames"] > 0
    pv = fx_preview({"video": str(video), "masks": [masks], "effects": '[{"type": "mosaic"}]', "frame": k1 // 2, "out": str(out_dir / "fx_preview.png"), "compare": True}, _ctx())
    assert pv["changed"] and Path(pv["out"]).is_file()
