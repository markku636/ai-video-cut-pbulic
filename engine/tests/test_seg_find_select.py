"""`aivc find`／`aivc select`／`aivc frame` 的 op 層（CPU；模型全換成假的）。`preview-object` 在 test_objects.py。

測試片用 PyAV 現做（fixtures/objclip.py）：白方塊全程往右走、藍長方形第 8 幀才出現。
OWLv2 與 SAM 2.1 換成「找顏色」的替身，所以這裡驗的是：檔案與 JSON 的形狀、幀號（proxy k）、
後備的取樣幀去重、雙向傳播、`--from` 只重算 K 之後、norm1000 換算 —— 不是分割品質（那在 GPU smoke 測）。
"""
from __future__ import annotations

import json
import math
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import numpy as np
import pytest

av = pytest.importorskip("av")
cv2 = pytest.importorskip("cv2")

from fixtures import objclip as OC  # noqa: E402

from aivc.ops import OpError, load_all  # noqa: E402
from aivc.ops._ctx import CliCtx  # noqa: E402
from aivc.seg.maskfile import MaskFile  # noqa: E402


class _Ctx(CliCtx):
    def __init__(self) -> None:
        super().__init__()
        self.logs: list[tuple[str, str]] = []
        self.artifacts: list[str] = []

    def log(self, level: str, message: str) -> None:
        self.logs.append((level, message))

    def progress(self, stage: str, done: int, total: int, **extra: Any) -> None:
        pass

    def artifact(self, path: str, kind: str = "") -> None:
        self.artifacts.append(path)


@pytest.fixture(scope="module")
def cache_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return tmp_path_factory.mktemp("aivc-cache-objects")


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch, cache_dir: Path) -> None:
    monkeypatch.setenv("AIVC_CACHE_DIR", str(cache_dir))
    monkeypatch.delenv("AIVC_SAM_BACKEND", raising=False)
    load_all()


@pytest.fixture(scope="module")
def clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    p = tmp_path_factory.mktemp("clip") / "物件 測試.mkv"
    try:
        OC.write_clip(p)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"PyAV 無法編出 libx264/matroska 測試片：{e}")
    return p


def _iou(a: np.ndarray | None, b: np.ndarray | None) -> float:
    if a is None or b is None:
        return 1.0 if (a is None and b is None) else 0.0
    u = np.count_nonzero(a | b)
    return np.count_nonzero(a & b) / u if u else 1.0


def _no_sam3(monkeypatch: pytest.MonkeyPatch, token: str | None = None) -> None:
    """auto 一定走後備：SAM 3 權重「不在本機」、token 依參數。"""
    from aivc.seg import sam3_hf

    monkeypatch.setattr(sam3_hf, "status", lambda: sam3_hf.Sam3Status(False, "測試：SAM 3 權重不在本機"))
    monkeypatch.setattr(sam3_hf, "find_hf_token", lambda: (token, "測試" if token else ""))


def _fake_fallback(monkeypatch: pytest.MonkeyPatch, log: list[Any] | None = None) -> list[Any]:
    from aivc.seg import backends, finders

    log = [] if log is None else log

    def make_finder(choice: Any, **kw: Any) -> Any:
        assert choice.name == "sam2"
        return finders.OwlSam2Finder(detect=OC.fake_detect, owl_loader=lambda v, d: SimpleNamespace(model_id="fake/owl"), backend=OC.FakePromptBackend(log))

    monkeypatch.setattr(backends, "make_finder", make_finder)
    return log


# ---------------------------------------------------------------- seg.find
def test_find_後備_取樣幀找到後來才出現的物件_重複框去掉(clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.ops.find import seg_find

    _no_sam3(monkeypatch)
    log = _fake_fallback(monkeypatch)
    out = tmp_path / "找"
    ctx = _Ctx()
    r = seg_find({"video": str(clip), "text": "white square, blue box", "out": str(out), "samples": 3}, ctx)
    assert any(lv == "warn" and "OWLv2 + SAM 2.1" in msg for lv, msg in ctx.logs), "auto 退到後備要說一聲"
    assert r["backend"]["name"] == "sam2" and r["backend"]["fallback"] is True and r["backend"]["requested"] == "auto"
    assert [i["phrase"] for i in r["instances"]] == ["white square", "blue box"]  # 分數高的在前
    white, blue = r["instances"]
    assert white["id"] == 1 and white["firstFrame"] == 0 and white["lastFrame"] == OC.N - 1 and white["seedFrame"] == 0
    assert blue["firstFrame"] == OC.BLUE_FROM and blue["lastFrame"] == OC.N - 1 and blue["seedFrame"] == 10
    assert r["dropped"] >= 2, "fake_detect 每個物件都多吐一個重疊框，要被去重"
    # 檔案
    for inst in r["instances"]:
        assert Path(inst["masks"]).is_file() and Path(inst["thumb"]).is_file()
        assert set(inst) >= {"id", "phrase", "score", "firstFrame", "lastFrame", "bestFrame", "box", "area", "thumb"}
        assert len(inst["box"]) == 4
    assert Path(r["overlay"]["path"]).is_file() and r["overlay"]["frame"] == 0
    saved = json.loads((out / "find.v1.json").read_text(encoding="utf-8"))
    assert saved["format"] == "aivc.find.v1" and saved["instances"] == r["instances"] and saved["frames"] == {"k0": 0, "k1": OC.N, "anchor": 0}
    # 遮罩內容：每一幀都有條目（雙向傳播），與真值相符
    mw = MaskFile.open(white["masks"])
    mb = MaskFile.open(blue["masks"])
    assert mw.frames() == list(range(OC.N)) and mb.frames() == list(range(OC.N))
    for k in range(OC.N):
        assert _iou(mw.get(k), OC.truth(k, "white")) > 0.9, k
        assert _iou(mb.get(k), OC.truth(k, "blue")) > 0.9 if k >= OC.BLUE_FROM else mb.get(k) is None
    # 藍色那組在第 10 幀下提示 → 往後、往前都傳播過
    dirs = {d for e in log if e[0] == "frame" for d in [e[2]]}
    assert dirs == {"fwd", "bwd"}
    img = cv2.imdecode(np.fromfile(r["overlay"]["path"], np.uint8), cv2.IMREAD_COLOR)
    assert img.shape[:2] == (OC.H, OC.W)


def test_find_max_與排序(clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.ops.find import seg_find

    _no_sam3(monkeypatch)
    _fake_fallback(monkeypatch)
    r = seg_find({"video": str(clip), "text": "blue box, white square", "out": str(tmp_path / "f"), "samples": 3, "max_instances": 1}, _Ctx())
    assert [i["phrase"] for i in r["instances"]] == ["white square"]
    assert not (tmp_path / "f" / "obj2").exists()


def test_find_重跑到同一個資料夾_清掉上次多出來的實例_不碰使用者的檔(clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.ops.find import seg_find

    _no_sam3(monkeypatch)
    _fake_fallback(monkeypatch)
    out = tmp_path / "同一個"
    r1 = seg_find({"video": str(clip), "text": "white square, blue box", "out": str(out), "samples": 3}, _Ctx())
    assert len(r1["instances"]) == 2 and (out / "obj2" / "masks.aivm").is_file()
    (out / "obj1" / "我的筆記.txt").write_text("留著", encoding="utf-8")
    r2 = seg_find({"video": str(clip), "text": "white square, blue box", "out": str(out), "samples": 3, "max": 1}, _Ctx())  # sidecar 送 "max"
    assert len(r2["instances"]) == 1 and not (out / "obj2").exists()
    assert any("obj2" in n for n in r2["notes"])
    assert (out / "obj1" / "我的筆記.txt").is_file() and (out / "obj1" / "masks.aivm").is_file()
    (out / "obj1" / "我的筆記.txt").unlink()
    (out / "obj5").mkdir()
    (out / "obj5" / "masks.aivm").write_bytes(b"x")  # 上一次的 find.v1.json 沒有列它 → 不碰
    seg_find({"video": str(clip), "text": "white square", "out": str(out)}, _Ctx())
    assert (out / "obj5" / "masks.aivm").is_file()


def test_find_sam3_路徑_疊色預覽挑看得到最多實例的幀(clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """SAM 3 後端換成直接回真值的假 finder：驗 op 層（排序、overlay 幀、JSON），SAM 3 本身的控制流程在 test_seg_sam3.py。"""
    from aivc.ops.find import seg_find
    from aivc.seg import backends, finders, sam3_hf
    from aivc.seg.instances import InstanceTrack

    monkeypatch.setattr(sam3_hf, "status", lambda: sam3_hf.Sam3Status(True, "測試：SAM 3 在本機", "x"))

    class Fake:
        def prepare(self) -> dict[str, Any]:
            return {"ids": ["facebook/sam3"], "loadSeconds": 0.0}

        def find(self, frames: Any, req: Any, ctx: Any) -> Any:
            insts = []
            for key, which, score in ((1, "white", 0.7), (2, "blue", 0.9)):
                t = InstanceTrack(key, which, frames.width, frames.height, score=score)
                for k in range(req.k0, req.k1):
                    t.add(k, OC.truth(k, which))
                insts.append(t)
            return finders.FindRun(insts, overlay_frame=None, notes=["假的"], dropped=0)

    seen: list[str] = []

    def make_finder(choice: Any, **kw: Any) -> Any:
        seen.append(choice.name)
        return Fake()

    monkeypatch.setattr(backends, "make_finder", make_finder)
    r = seg_find({"video": str(clip), "text": "white, blue", "out": str(tmp_path / "s3")}, _Ctx())
    assert seen == ["sam3"] and r["backend"]["name"] == "sam3" and r["backend"]["fallback"] is False
    assert [i["phrase"] for i in r["instances"]] == ["blue", "white"]
    assert r["overlay"]["frame"] == OC.BLUE_FROM, "兩個都看得到的第一幀（面積相同取最早）"
    assert r["notes"] == ["假的"]


def test_find_明確要_sam3_但沒權重也沒_token_是_gated_錯誤(clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.ops.find import seg_find

    _no_sam3(monkeypatch, token=None)
    with pytest.raises(OpError) as e:
        seg_find({"video": str(clip), "text": "face", "out": str(tmp_path / "x"), "backend": "sam3"}, _Ctx())
    assert e.value.kind == "Model" and "facebook/sam3" in str(e.value)
    assert "https://huggingface.co/facebook/sam3" in e.value.hint and "HF_TOKEN" in e.value.hint and "auto" in e.value.hint


def test_find_參數錯誤(clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.ops.find import seg_find

    _no_sam3(monkeypatch)
    _fake_fallback(monkeypatch)
    bads = (
        {"text": " , "}, {"text": "x", "anchor": 99}, {"text": "x", "frames": "0:999"}, {"text": "x", "max_instances": 0},
        # 回歸：--min-frames 0 會留下一幀都沒出現的實例（box=None），寫完 find.v1.json 才在 _human 擲 TypeError
        {"text": "x", "min_frames": 0}, {"text": "x", "min_frames": -2}, {"text": "x", "chunk": -1},
    )
    for bad in bads:
        with pytest.raises(OpError) as e:
            seg_find({"video": str(clip), "out": str(tmp_path / "x"), **bad}, _Ctx())
        assert e.value.kind == "Invalid", bad
    assert not (tmp_path / "x" / "find.v1.json").exists()


def test_find_human_沒有框的實例不會炸(clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """_human 那一行遇到 box=None（例如 SAM 3 後端回了沒出現的實例）印「—」，不擲 TypeError。"""
    from aivc.ops.find import seg_find
    from aivc.seg import backends, finders, sam3_hf
    from aivc.seg.instances import InstanceTrack

    monkeypatch.setattr(sam3_hf, "status", lambda: sam3_hf.Sam3Status(True, "測試：SAM 3 在本機", "x"))

    class Fake:
        def prepare(self) -> dict[str, Any]:
            return {"ids": ["facebook/sam3"], "loadSeconds": 0.0}

        def find(self, frames: Any, req: Any, ctx: Any) -> Any:
            t = InstanceTrack(1, "ghost", frames.width, frames.height, score=0.5)
            t.mark_absent(range(req.k0, req.k1))
            return finders.FindRun([t])

    monkeypatch.setattr(backends, "make_finder", lambda choice, **kw: Fake())
    r = seg_find({"video": str(clip), "text": "ghost", "out": str(tmp_path / "g")}, _Ctx())
    assert r["instances"][0]["box"] is None and "—" in r["_human"]


def test_find_中文片語要警告(clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """回歸：help 以前示範「臉, 車牌」，但 OWLv2／SAM 3 只懂英文 —— 0 個實例、note 只說「沒找到」，使用者以為畫面沒有臉。"""
    from aivc.ops.find import _args, seg_find

    _no_sam3(monkeypatch)
    _fake_fallback(monkeypatch)
    ctx = _Ctx()
    r = seg_find({"video": str(clip), "text": "臉, white square", "out": str(tmp_path / "zh")}, ctx)
    assert any(lv == "warn" and "臉" in msg and "英文" in msg for lv, msg in ctx.logs)
    assert any("英文" in n for n in r["notes"]) and "英文" in r["_human"]
    saved = json.loads((tmp_path / "zh" / "find.v1.json").read_text(encoding="utf-8"))
    assert any("英文" in n for n in saved["notes"])
    ctx2 = _Ctx()
    seg_find({"video": str(clip), "text": "white square", "out": str(tmp_path / "en")}, ctx2)
    assert not any("英文" in msg for _lv, msg in ctx2.logs)
    import argparse

    p = argparse.ArgumentParser()
    _args(p)
    text_help = next(a.help for a in p._actions if a.dest == "text")
    assert "車牌" not in text_help and "英文" in text_help


def test_find_不覆寫_select_手動加進來的物件(clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """回歸：find 重跑到同一個 --out 會無條件寫 obj1..objN，把使用者用 select --obj 2 加的物件蓋掉。"""
    from aivc.ops.find import seg_find
    from aivc.ops.select import seg_select

    _no_sam3(monkeypatch)
    log: list[Any] = []
    _fake_fallback(monkeypatch, log)
    from aivc.seg import backends

    monkeypatch.setattr(backends, "make_prompt_backend", lambda choice, **kw: OC.FakePromptBackend(log))
    out = tmp_path / "混"
    r1 = seg_find({"video": str(clip), "text": "white square", "out": str(out)}, _Ctx())
    assert [i["id"] for i in r1["instances"]] == [1]
    x0, y0, x1, y1 = OC.BLUE_BOX
    seg_select({"video": str(clip), "frame": 10, "box": [f"{x0},{y0},{x1 - x0},{y1 - y0}"], "propagate": "10:20", "obj": 2, "out": str(out)}, _Ctx())
    mine = (out / "obj2" / "masks.aivm").read_bytes()
    r2 = seg_find({"video": str(clip), "text": "white square, blue box", "out": str(out), "samples": 3}, _Ctx())
    assert [i["id"] for i in r2["instances"]] == [1, 3], "obj2 是使用者的：跳過這個編號"
    assert (out / "obj2" / "masks.aivm").read_bytes() == mine
    assert any("obj2" in n for n in r2["notes"])
    # 再跑一次只找一個：上一次 find 寫的 obj3 清掉，使用者的 obj2 還在
    r3 = seg_find({"video": str(clip), "text": "white square", "out": str(out)}, _Ctx())
    assert [i["id"] for i in r3["instances"]] == [1] and not (out / "obj3").exists()
    assert (out / "obj2" / "masks.aivm").read_bytes() == mine


def test_明確要_sam3_權重不在本機_先下載_有進度可取消(clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """回歸：以前直接讓 from_pretrained 在 gpu op 裡默默抓 ~3.4 GB（沒有進度、取消要等下載完）。"""
    from aivc.ops import models as MD
    from aivc.ops.find import seg_find
    from aivc.ops.select import seg_select
    from aivc.seg import backends, sam3_hf

    _no_sam3(monkeypatch, token="hf_測試")
    calls: list[tuple[str, Any, Any]] = []

    def fake_download(repo: str, hub: Path, ctx: Any, **kw: Any) -> Path:
        calls.append((repo, ctx, kw.get("token")))
        ctx.progress("models.pull", 5, 10, step=repo)
        raise OpError("Model", f"{repo}：沒有權限（測試）")

    from aivc import env as aenv

    monkeypatch.setattr(MD, "download", fake_download)
    monkeypatch.setattr(MD, "hub_cache_dir", lambda: tmp_path / "hub")
    monkeypatch.setattr(aenv, "apply_model_env", lambda: None)
    monkeypatch.setattr(backends, "make_finder", lambda *a, **k: pytest.fail("下載失敗就不該載模型"))
    ctx = _Ctx()
    with pytest.raises(OpError) as e:
        seg_find({"video": str(clip), "text": "face", "out": str(tmp_path / "f"), "backend": "sam3"}, ctx)
    assert calls and calls[0][0] == sam3_hf.MODEL_ID and calls[0][1] is ctx and calls[0][2] == "hf_測試"
    assert e.value.kind == "Model" and "facebook/sam3" in str(e.value) and "huggingface.co/facebook/sam3" in e.value.hint
    with pytest.raises(OpError):
        seg_select({"video": str(clip), "frame": 1, "point": ["5,5"], "out": str(tmp_path / "s"), "backend": "sam3"}, _Ctx())
    assert len(calls) == 2
    # 權重已在本機 → 不下載
    monkeypatch.setattr(sam3_hf, "status", lambda: sam3_hf.Sam3Status(True, "在本機", "x"))
    assert MD.ensure_sam3(_Ctx()) is None and len(calls) == 2


# ---------------------------------------------------------------- seg.select
def _fake_prompt(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    from aivc.seg import backends

    log: list[Any] = []
    monkeypatch.setattr(backends, "make_prompt_backend", lambda choice, **kw: OC.FakePromptBackend(log))
    return log


def test_select_單幀_框選(clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.ops.select import seg_select
    from aivc.seg.preview import load_mask_png

    _no_sam3(monkeypatch)
    log = _fake_prompt(monkeypatch)
    x0, y0, x1, y1 = OC.white_box(5)
    out = tmp_path / "選"
    r = seg_select({"video": str(clip), "frame": 5, "box": [f"{x0 - 2},{y0 - 2},{x1 - x0 + 4},{y1 - y0 + 4}"], "out": str(out)}, _Ctx())
    assert r["format"] == "aivc.select.v1" and r["frame"] == 5 and r["propagated"] is None
    assert r["backend"]["name"] == "sam2" and r["backend"]["label"] == "SAM 2.1"
    assert r["box"] == [float(x0), float(y0), float(x1 - x0), float(y1 - y0)] and r["area"] == (x1 - x0) * (y1 - y0)
    assert r["score"] == pytest.approx(1 / (1 + math.exp(-1.0)), abs=1e-4)
    assert _iou(load_mask_png(r["mask"]), OC.truth(5)) > 0.95
    assert Path(r["overlay"]).is_file()
    assert json.loads((out / "select.v1.json").read_text(encoding="utf-8"))["prompts"] == r["prompts"]
    assert log[0][:3] == ("prompt", 5, 1)


def test_select_norm1000_換算成像素(clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.ops.select import seg_select

    _no_sam3(monkeypatch)
    log = _fake_prompt(monkeypatch)
    r = seg_select({"video": str(clip), "frame": 5, "coords": "norm1000", "point": ["270,400", "900,900:neg"], "out": str(tmp_path / "n")}, _Ctx())
    pts = log[0][3]
    assert pts[0] == pytest.approx((270 / 1000 * OC.W, 400 / 1000 * OC.H, 1))
    assert pts[1] == pytest.approx((900 / 1000 * OC.W, 900 / 1000 * OC.H, 0))
    assert r["coords"] == "norm1000" and r["prompts"]["points"][0] == [25.92, 25.6, 1]
    r2 = seg_select({"video": str(clip), "frame": 5, "coords": "norm1000", "box": ["0,0,500,500"], "out": str(tmp_path / "n2")}, _Ctx())
    assert r2["prompts"]["box"] == [0.0, 0.0, 48.0, 32.0]


def test_select_傳播兩個方向(clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.ops.select import seg_select

    _no_sam3(monkeypatch)
    log = _fake_prompt(monkeypatch)
    x0, y0, x1, y1 = OC.white_box(10)
    r = seg_select({"video": str(clip), "frame": 10, "point": [f"{x0 + 5},{y0 + 5}"], "propagate": "0:20", "out": str(tmp_path / "p"), "obj": 3}, _Ctx())
    p = r["propagated"]
    assert p["masks"].endswith(str(Path("obj3") / "masks.aivm")) and p["recomputed"] == [0, 20] and p["keptFromOld"] is None
    mf = MaskFile.open(p["masks"])
    assert mf.frames() == list(range(20))
    assert all(_iou(mf.get(k), OC.truth(k)) > 0.9 for k in range(20))
    assert [e[1] for e in log if e[0] == "frame" and e[2] == "bwd"] == list(range(9, -1, -1))


def test_select_from_只從_K_往後重算_前面與範圍外保留(clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """「在中段補一個修正點，只從那一幀往後重算」：舊檔 k<K 與 k≥K1 的條目原封不動，[K, K1) 換成新算的。"""
    from aivc.ops.select import seg_select

    _no_sam3(monkeypatch)
    log = _fake_prompt(monkeypatch)
    old_path = tmp_path / "舊" / "obj2" / "masks.aivm"
    shifted = {k: np.roll(OC.truth(k), 3, axis=1) for k in range(OC.N)}  # 追歪 3 px 的舊遮罩
    MaskFile.write(old_path, OC.W, OC.H, shifted.items())
    K = 12
    x0, y0, x1, y1 = OC.white_box(K)
    # sidecar 直接送 "from"（CLI 的 dest 是 from_masks）
    r = seg_select({"video": str(clip), "frame": K, "point": [f"{x0 + 4},{y0 + 6}"], "from": str(old_path), "propagate": "0:16", "out": str(tmp_path / "修")}, _Ctx())
    p = r["propagated"]
    assert r["obj"] == 2 and p["recomputed"] == [K, 16] and p["keptFromOld"] == {"before": K, "after": OC.N - 16}
    assert r["prompts"]["derived"]["from"] == "old-mask-bbox" and r["prompts"]["box"] is not None
    assert not any(e[0] == "frame" and e[2] == "bwd" for e in log), "--from 不往前傳播"
    mf = MaskFile.open(p["masks"])
    assert mf.frames() == list(range(OC.N))
    for k in range(OC.N):
        m = mf.get(k)
        if K <= k < 16:
            assert _iou(m, OC.truth(k)) > 0.9, k
        else:
            assert np.array_equal(m, shifted[k]), f"第 {k} 幀應該原封不動保留舊遮罩"


def test_select_from_舊遮罩黏在別的東西上_加選點在對的東西上就重新指定目標(clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """回歸：舊遮罩追歪到藍框上，使用者在白方塊點加選、在藍框點減選 —— 以前錨點與框還是從藍框推，結果還在藍框上。"""
    from aivc.ops.select import seg_select

    _no_sam3(monkeypatch)
    log = _fake_prompt(monkeypatch)
    old_path = tmp_path / "歪" / "obj1" / "masks.aivm"
    wrong = {k: OC.truth(k, "blue") for k in range(OC.BLUE_FROM, OC.N)}
    MaskFile.write(old_path, OC.W, OC.H, wrong.items())
    K = 12
    x0, y0, x1, y1 = OC.white_box(K)
    bx0, by0, bx1, by1 = OC.BLUE_BOX
    ctx = _Ctx()
    r = seg_select({
        "video": str(clip), "frame": K, "point": [f"{x0 + 4},{y0 + 6}", f"{(bx0 + bx1) // 2},{(by0 + by1) // 2}:neg"],
        "from": str(old_path), "propagate": f"{K}:16", "out": str(tmp_path / "修"),
    }, ctx)
    assert r["prompts"]["derived"]["from"] == "user-points" and r["prompts"]["box"] is None
    prompt = next(e for e in log if e[0] == "prompt")
    assert prompt[4] is None and len(prompt[3]) == 2, "只送使用者的兩個點，沒有推導的錨點與框"
    mf = MaskFile.open(r["propagated"]["masks"])
    assert all(_iou(mf.get(k), OC.truth(k)) > 0.9 for k in range(K, 16))
    assert any("重新指定目標" in m for _lv, m in ctx.logs)


def test_select_沒給_obj_不覆寫既有的物件(clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """回歸：沒給 --obj 一律寫 obj1，第二次 select 到同一個 --out 會無聲蓋掉上一個物件的整條追蹤。"""
    from aivc.ops.select import seg_select

    _no_sam3(monkeypatch)
    _fake_prompt(monkeypatch)
    out = tmp_path / "兩個"
    x0, y0, x1, y1 = OC.white_box(10)
    seg_select({"video": str(clip), "frame": 10, "box": [f"{x0},{y0},{x1 - x0},{y1 - y0}"], "propagate": "0:20", "out": str(out)}, _Ctx())
    first = (out / "obj1" / "masks.aivm").read_bytes()
    bx0, by0, bx1, by1 = OC.BLUE_BOX
    blue = {"video": str(clip), "frame": 10, "box": [f"{bx0},{by0},{bx1 - bx0},{by1 - by0}"], "propagate": "8:20", "out": str(out)}
    with pytest.raises(OpError) as e:
        seg_select(blue, _Ctx())
    assert e.value.kind == "Invalid" and "--obj 2" in e.value.hint
    assert (out / "obj1" / "masks.aivm").read_bytes() == first
    r = seg_select({**blue, "obj": 2}, _Ctx())
    assert r["obj"] == 2 and (out / "obj1" / "masks.aivm").read_bytes() == first
    r1 = seg_select({**blue, "obj": 1}, _Ctx())  # 明確給 --obj 1 ＝ 要重做：照覆寫
    assert r1["obj"] == 1 and (out / "obj1" / "masks.aivm").read_bytes() != first
    # 沒有 --propagate（只選單幀、不寫 masks.aivm）不受影響
    seg_select({k: v for k, v in blue.items() if k != "propagate"}, _Ctx())


def test_select_參數錯誤(clip: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.ops.select import seg_select

    _no_sam3(monkeypatch)
    _fake_prompt(monkeypatch)
    base = {"video": str(clip), "out": str(tmp_path / "e")}
    cases = [
        {"frame": 1, "box": ["1,1,5,5", "10,10,5,5"]},
        {"frame": 1, "point": ["5,5"], "from_masks": str(tmp_path / "x.aivm")},
        {"frame": 1, "coords": "norm1000", "point": ["1200,5"]},
        {"frame": 1, "point": ["500,5"]},  # px 座標在畫面外（多半是忘了 --coords norm1000）
        {"frame": 99, "point": ["5,5"]},
        {"frame": 1, "point": ["5,5"], "propagate": "5:10"},
        {"frame": 1},
        {"frame": 1, "point": ["5;5"]},
    ]
    for c in cases:
        with pytest.raises(OpError) as e:
            seg_select({**base, **c}, _Ctx())
        assert e.value.kind == "Invalid", c


# ---------------------------------------------------------------- media.frame／objects.preview
def test_frame_縮圖與格線(clip: Path, tmp_path: Path) -> None:
    from aivc.ops.frame import frame_op

    a = frame_op({"video": str(clip), "at": 3, "out": str(tmp_path / "a.png"), "max_side": 48}, _Ctx())
    b = frame_op({"video": str(clip), "at": 3, "out": str(tmp_path / "b.png"), "max_side": 48, "grid": True}, _Ctx())
    assert a["size"] == [48, 32] and a["sourceSize"] == [OC.W, OC.H] and a["scale"] == 0.5 and b["grid"] is True
    ia = cv2.imdecode(np.fromfile(a["out"], np.uint8), cv2.IMREAD_COLOR)
    ib = cv2.imdecode(np.fromfile(b["out"], np.uint8), cv2.IMREAD_COLOR)
    assert ia.shape == ib.shape == (32, 48, 3) and not np.array_equal(ia, ib)
    full = frame_op({"video": str(clip), "at": 3, "out": str(tmp_path / "c.png")}, _Ctx())
    assert full["size"] == [OC.W, OC.H] and full["scale"] == 1.0
    with pytest.raises(OpError):
        frame_op({"video": str(clip), "at": 999, "out": str(tmp_path / "d.png")}, _Ctx())
