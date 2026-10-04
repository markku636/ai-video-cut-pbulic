"""後端選擇（auto｜sam3｜sam2）、HF token 的來源、SAM 3 可用性、`aivc models pull --sam3`，
以及 select 的提示換算（norm1000、補修正點的提示推導）與 find 的小工具。全部不連網、不需要 GPU。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from aivc.ops import OpError
from aivc.seg import backends as B
from aivc.seg import sam3_hf
from aivc.seg.backend import SegModelError

READY = sam3_hf.Sam3Status(True, "測試：在本機", "x")
MISSING = sam3_hf.Sam3Status(False, "測試：權重不在本機")
UNSUPPORTED = sam3_hf.Sam3Status(False, "測試：transformers 沒有 SAM 3", supported=False)


@pytest.fixture(autouse=True)
def _no_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(B.ENV_BACKEND, raising=False)


# ---------------------------------------------------------------- 選擇規則
def test_要求值_預設_環境變數_別名_拼錯(monkeypatch: pytest.MonkeyPatch) -> None:
    assert B.requested_backend(None) == "auto" and B.requested_backend("") == "auto"
    monkeypatch.setenv(B.ENV_BACKEND, "sam2")
    assert B.requested_backend(None) == "sam2" and B.requested_backend("sam3") == "sam3"  # 明確給的優先
    assert B.requested_backend("SAM2.1") == "sam2" and B.requested_backend("owlv2") == "sam2"
    with pytest.raises(SegModelError) as e:
        B.requested_backend("sam4")
    assert e.value.kind == "Invalid"
    monkeypatch.setenv(B.ENV_BACKEND, "bogus")
    with pytest.raises(SegModelError) as e2:
        B.requested_backend(None)
    assert B.ENV_BACKEND in str(e2.value)


def test_auto_有權重用_SAM3_沒有就後備() -> None:
    c = B.choose(None, status_fn=lambda: READY)
    assert (c.name, c.fallback, c.requested) == ("sam3", False, "auto")
    c2 = B.choose("auto", status_fn=lambda: MISSING)
    assert (c2.name, c2.fallback) == ("sam2", True) and c2.reason == MISSING.reason
    line = B.fallback_log_line(c2, "find")
    assert "OWLv2 + SAM 2.1" in line and MISSING.reason in line
    assert "SAM 2.1" in B.fallback_log_line(c2, "select")
    assert c2.to_json()["label"] == "OWLv2 + SAM 2.1" and c2.to_json(B.LABELS_SELECT)["label"] == "SAM 2.1"


def test_sam2_不看_SAM3_狀態() -> None:
    def boom() -> Any:
        raise AssertionError("sam2 不該去查 SAM 3")

    assert B.choose("sam2", status_fn=boom).name == "sam2"


def test_明確要_sam3_的三種情況() -> None:
    assert B.choose("sam3", status_fn=lambda: READY).name == "sam3"
    # 沒權重但有 token → 照試（會從 Hub 下載；沒權限時載入那裡會給 gated 說明）
    c = B.choose("sam3", status_fn=lambda: MISSING, token_fn=lambda: ("hf_x", "環境變數 HF_TOKEN"))
    assert c.name == "sam3" and "下載" in c.reason
    # 沒權重也沒 token → 不白連一次網，直接說明
    with pytest.raises(SegModelError) as e:
        B.choose("sam3", status_fn=lambda: MISSING, token_fn=lambda: (None, ""))
    assert e.value.kind == "Model" and "https://huggingface.co/facebook/sam3" in e.value.hint and "HF_TOKEN" in e.value.hint
    with pytest.raises(SegModelError) as e2:
        B.choose("sam3", status_fn=lambda: UNSUPPORTED, token_fn=lambda: ("hf_x", ""))
    assert e2.value.kind == "PyEnv"


def test_工廠回對的類別() -> None:
    from aivc.seg.finders import OwlSam2Finder, Sam3Finder
    from aivc.seg.sam2_hf import Sam2HfBackend

    s3 = B.BackendChoice("sam3", "auto", False, "")
    s2 = B.BackendChoice("sam2", "auto", True, "")
    assert isinstance(B.make_prompt_backend(s3, device="cpu"), sam3_hf.Sam3TrackerBackend)
    b = B.make_prompt_backend(s2, device="cpu", sam_variant="tiny")
    assert isinstance(b, Sam2HfBackend) and b.variant == "tiny"
    assert isinstance(B.make_finder(s3, chunk=7), Sam3Finder) and B.make_finder(s3, chunk=7).chunk == 7
    assert isinstance(B.make_finder(s2), OwlSam2Finder)


# ---------------------------------------------------------------- token 與可用性
def _clear_token_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for k in ("HF_TOKEN", "HUGGING_FACE_HUB_TOKEN", "HF_TOKEN_PATH"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("HF_HOME", str(tmp_path / "app-hf"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "xdg"))


def test_token_來源順序(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _clear_token_env(monkeypatch, tmp_path)
    assert sam3_hf.find_hf_token() == (None, "")
    user = tmp_path / "xdg" / "huggingface" / "token"  # hf auth login 存的位置（App 把 HF_HOME 指走了，huggingface_hub 自己找不到）
    user.parent.mkdir(parents=True)
    user.write_text("hf_user\n", encoding="utf-8")
    tok, src = sam3_hf.find_hf_token()
    assert tok == "hf_user" and "hf auth login" in src
    app = tmp_path / "app-hf" / "token"
    app.parent.mkdir(parents=True)
    app.write_text("hf_app", encoding="utf-8")
    assert sam3_hf.find_hf_token() == ("hf_app", "HF_HOME/token")
    monkeypatch.setenv("HUGGING_FACE_HUB_TOKEN", "hf_legacy")
    assert sam3_hf.find_hf_token()[0] == "hf_legacy"
    monkeypatch.setenv("HF_TOKEN", " hf_env ")
    assert sam3_hf.find_hf_token() == ("hf_env", "環境變數 HF_TOKEN")
    assert sam3_hf.hf_kwargs() == {"token": "hf_env"}
    hint = sam3_hf.gated_hint()
    assert "hf_env" not in hint and "環境變數 HF_TOKEN" in hint


def test_status_不連網(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _clear_token_env(monkeypatch, tmp_path)
    monkeypatch.setattr(sam3_hf, "transformers_has_sam3", lambda: False)
    st = sam3_hf.status()
    assert not st.ready and not st.supported
    monkeypatch.setattr(sam3_hf, "transformers_has_sam3", lambda: True)
    monkeypatch.setattr(sam3_hf, "local_snapshot", lambda: None)
    st2 = sam3_hf.status()
    assert not st2.ready and st2.supported and "models pull --sam3" in st2.reason
    monkeypatch.setattr(sam3_hf, "local_snapshot", lambda: tmp_path / "snap")
    assert sam3_hf.status().ready


def test_這版_transformers_真的有_SAM3_類別() -> None:
    assert sam3_hf.transformers_has_sam3(), "transformers 5.17 應該有 sam3_video／sam3_tracker_video（要換版本記得一起看這裡）"


def test_權限錯誤的判斷() -> None:
    class GatedRepoError(Exception):
        pass

    class HTTPError(Exception):
        def __init__(self, code: int) -> None:
            super().__init__(f"{code}")
            self.response = type("R", (), {"status_code": code})()

    assert sam3_hf.is_access_error(GatedRepoError("x"))
    wrapped = OSError("You are trying to access a gated repo.")
    assert sam3_hf.is_access_error(wrapped)
    chained = RuntimeError("load failed")
    chained.__cause__ = HTTPError(403)
    assert sam3_hf.is_access_error(chained)
    assert not sam3_hf.is_access_error(ConnectionError("refused")) and not sam3_hf.is_access_error(HTTPError(404))
    e = sam3_hf.load_error(GatedRepoError("x"))
    assert e.kind == "Model" and "申請存取" in str(e)


def test_local_snapshot_用_SAM3_的必要檔(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """facebook/sam3 沒有 preprocessor_config.json：用 SAM 2.1 那組必要檔判斷會永遠說「不完整」。"""
    from aivc.ops import models as MO

    monkeypatch.setenv("HF_HOME", str(tmp_path / "hf"))
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    snap = tmp_path / "hf" / "hub" / "models--facebook--sam3" / "snapshots" / "abc"
    snap.mkdir(parents=True)
    for f in ("config.json", "processor_config.json", "tokenizer_config.json", "tokenizer.json", "vocab.json"):
        (snap / f).write_text("{}", encoding="utf-8")
    (snap / "merges.txt").write_text("#", encoding="utf-8")
    header = b'{"__metadata__":{}}'
    (snap / "model.safetensors").write_bytes(len(header).to_bytes(8, "little") + header + bytes(64))
    calls: list[dict[str, Any]] = []

    def fake(**kw: Any) -> str:
        calls.append(kw)
        assert kw.get("local_files_only") is True
        return str(snap)

    monkeypatch.setattr(MO, "_snapshot_download", fake)
    assert sam3_hf.local_snapshot() == snap
    assert "*.txt" in calls[0]["allow_patterns"]
    assert MO.cached_snapshot("facebook/sam3", tmp_path / "hf" / "hub") is None, "預設（SAM 2.1）必要檔判斷：缺 preprocessor_config.json"


# ---------------------------------------------------------------- models pull --sam3
class _Hub:
    def __init__(self, fail: BaseException | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self.fail = fail
        self.done: set[str] = set()

    def __call__(self, **kw: Any) -> str:
        self.calls.append(kw)
        repo = kw["repo_id"]
        d = Path(kw["cache_dir"]) / ("models--" + repo.replace("/", "--")) / "snapshots" / "r1"
        if kw.get("local_files_only"):
            if repo in self.done:
                return str(d)
            raise FileNotFoundError("no local")
        if repo == "facebook/sam3" and self.fail is not None:
            raise self.fail
        d.mkdir(parents=True, exist_ok=True)
        names = ["config.json", "processor_config.json", "tokenizer_config.json"] if repo == "facebook/sam3" else ["config.json", "preprocessor_config.json"]
        for f in names:
            (d / f).write_text("{}", encoding="utf-8")
        header = b'{"__metadata__":{}}'
        (d / "model.safetensors").write_bytes(len(header).to_bytes(8, "little") + header + bytes(32))
        self.done.add(repo)
        return str(d)


class _Ctx:
    def __init__(self) -> None:
        self.logs: list[str] = []

    def progress(self, *a: Any, **k: Any) -> None: ...
    def log(self, level: str, message: str) -> None:
        self.logs.append(message)

    def check_cancel(self) -> None: ...
    def artifact(self, *a: Any, **k: Any) -> None: ...


def test_models_pull_sam3_帶_token_用自己的樣式與必要檔(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from aivc.ops import models as MO

    monkeypatch.setenv("HF_HOME", str(tmp_path / "hf"))
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    monkeypatch.delenv("HF_HUB_OFFLINE", raising=False)
    hub = _Hub()
    monkeypatch.setattr(MO, "_snapshot_download", hub)
    monkeypatch.setattr(sam3_hf, "find_hf_token", lambda: ("hf_tok", "環境變數 HF_TOKEN"))
    ctx = _Ctx()
    r = MO.pull_op({"sam": "small", "sam3": True}, ctx)
    assert [m["variant"] for m in r["models"]] == ["small", "sam3"]
    online = [c for c in hub.calls if not c.get("local_files_only")]
    sam3_call = next(c for c in online if c["repo_id"] == "facebook/sam3")
    small_call = next(c for c in online if c["repo_id"] == "facebook/sam2.1-hiera-small")
    assert sam3_call["token"] == "hf_tok" and "*.txt" in sam3_call["allow_patterns"]
    assert "token" not in small_call and small_call["allow_patterns"] == ["*.json", "*.safetensors"], "SAM 2.1 的下載參數跟以前逐字相同"
    assert any("Hugging Face token：環境變數 HF_TOKEN" in m for m in ctx.logs) and not any("hf_tok" in m for m in ctx.logs)
    r2 = MO.pull_op({"sam": "small", "sam3": True}, _Ctx())
    assert all(m["cached"] for m in r2["models"]), "第二次全部在快取"


def test_models_pull_sam3_沒權限是清楚的說明(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from aivc.ops import models as MO

    class GatedRepoError(Exception):
        pass

    monkeypatch.setenv("HF_HOME", str(tmp_path / "hf"))
    monkeypatch.delenv("HF_HUB_CACHE", raising=False)
    monkeypatch.setattr(MO, "_snapshot_download", _Hub(fail=GatedRepoError("403 Forbidden: access restricted")))
    monkeypatch.setattr(sam3_hf, "find_hf_token", lambda: ("hf_tok", "~/.cache/huggingface/token（hf auth login）"))
    with pytest.raises(OpError) as e:
        MO.pull_op({"sam": "small", "sam3": True}, _Ctx())
    assert e.value.kind == "Model" and "需要申請存取" in str(e.value) and "facebook/sam3" in str(e.value)
    assert "https://huggingface.co/facebook/sam3" in e.value.hint and "aivc models pull --sam3" in e.value.hint
    assert "hf_tok" not in str(e.value) + e.value.hint


def test_models_cli_吃_sam3_旗標(monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.cli import build_parser

    ns = build_parser().parse_args(["models", "pull", "--sam3"])
    assert ns.sam3 is True and ns.sam == "small"
    assert build_parser().parse_args(["models", "pull"]).sam3 is False


# ---------------------------------------------------------------- select 的提示
def test_norm1000_換算與範圍檢查() -> None:
    from aivc.seg.prompts import PromptError, norm1000_to_px, parse_box, parse_point, px_to_norm1000, to_pixels

    assert norm1000_to_px(500, 250, 1920, 1080) == (960.0, 270.0)
    assert px_to_norm1000(960, 270, 1920, 1080) == (500.0, 250.0)
    assert parse_point("10,20") == (10.0, 20.0, 1) and parse_point("10,20:neg") == (10.0, 20.0, 0) and parse_point("1，2:add") == (1.0, 2.0, 1)
    p = to_pixels([(500, 500, 1), (1000, 1000, 0)], (100, 200, 300, 400), "norm1000", 640, 360)
    assert p.points[0] == (320.0, 180.0, 1) and p.points[1][2] == 0 and p.points[1][0] < 640 and p.points[1][1] < 360
    assert p.box == pytest.approx((64.0, 72.0, 192.0, 144.0))
    for bad in (([(1001, 5, 1)], None), ([], (900, 0, 200, 10))):
        with pytest.raises(PromptError):
            to_pixels(bad[0], bad[1], "norm1000", 640, 360)
    with pytest.raises(PromptError, match="norm1000"):
        to_pixels([(700, 5, 1)], None, "px", 640, 360)
    with pytest.raises(PromptError):
        parse_box("1,2,0,4")
    with pytest.raises(PromptError):
        parse_point("1,2:maybe")
    with pytest.raises(PromptError):
        to_pixels([], (2000, 2000, 10, 10), "px", 640, 360)  # 框完全在畫面外


def test_補修正點的提示推導() -> None:
    from aivc.seg.prompts import SelectPrompts, interior_anchor, refine_prompts

    old = np.zeros((60, 80), bool)
    old[50:60, 10:40] = True  # 貼著下緣（distanceTransform 會把畫面外當前景——錨點不能落在邊上）
    a = interior_anchor(old)
    assert a is not None and 50 < a[1] < 59 and 10 < a[0] < 40
    # 加選點緊貼著舊遮罩（延伸它）：框擴到包住新的加選點（+2 px）
    p = refine_prompts(old, SelectPrompts(((44.0, 55.0, 1), (25.0, 55.0, 0))), 80, 60)
    assert p.box == pytest.approx((10.0, 50.0, 36.0, 10.0)), "框＝舊外接框擴到包住新的加選點（+2 px）"
    assert p.derived["from"] == "old-mask-bbox" and p.points[0][2] == 1 and len(p.points) == 3
    ax, ay = p.derived["anchor"]
    assert abs(ax - 25.0) >= 4, "錨點要避開減選點"
    same = SelectPrompts(((5.0, 5.0, 1),), (1.0, 1.0, 5.0, 5.0))
    assert refine_prompts(old, same, 80, 60) is same, "給了框＝重新框選，不推導"
    assert refine_prompts(None, SelectPrompts(((5.0, 5.0, 1),)), 80, 60).box is None


def test_補修正點_舊遮罩在錯的東西上_不讓舊遮罩蓋掉使用者的點() -> None:
    """回歸：`--from` 的舊遮罩追歪到相鄰的牌上，使用者在對的牌上點加選、在錯的牌上點減選 ——
    以前錨點與框照樣從舊遮罩（錯的牌）推，結果遮罩橫跨三張牌、再傳播下去。"""
    from aivc.seg.prompts import SelectPrompts, refine_prompts

    W, H = 200, 60
    card1 = np.zeros((H, W), bool)
    card1[20:40, 10:40] = True  # 舊遮罩：黏在第 1 張牌上
    user = SelectPrompts(((150.0, 30.0, 1), (25.0, 30.0, 0)))  # 加選在第 3 張牌、減選在第 1 張牌
    p = refine_prompts(card1, user, W, H)
    assert p.box is None and p.points == user.points, "加選點都不在舊遮罩上＝重新指定目標：原樣送使用者的點"
    assert p.derived["from"] == "user-points" and "anchor" not in p.derived
    only_add = refine_prompts(card1, SelectPrompts(((150.0, 30.0, 1),)), W, H)
    assert only_add.box is None and len(only_add.points) == 1
    # 舊遮罩漏到兩塊（不相連）、只給減選點在錯的那塊 → 只用沒被點掉的那塊推框與錨點
    leak = card1.copy()
    leak[20:40, 140:170] = True
    q = refine_prompts(leak, SelectPrompts(((25.0, 30.0, 0),)), W, H)
    assert q.box == pytest.approx((140.0, 20.0, 30.0, 20.0)) and q.derived["droppedComponents"] == 1
    assert 140 < q.derived["anchor"][0] < 170, "錨點落在留下來的那塊"
    # 每一塊都有減選點（在同一個東西上修掉一部分）：照舊全部保留
    r = refine_prompts(card1, SelectPrompts(((12.0, 22.0, 0),)), W, H)
    assert r.box == pytest.approx((10.0, 20.0, 30.0, 20.0)) and "droppedComponents" not in r.derived
    # 有加選點在某一塊上：只用那一塊（另一塊即使沒被點到也不參與）
    s = refine_prompts(leak, SelectPrompts(((150.0, 30.0, 1),)), W, H)
    assert s.box == pytest.approx((140.0, 20.0, 30.0, 20.0)) and s.derived["droppedComponents"] == 1


# ---------------------------------------------------------------- find 的小工具
def test_取樣幀與去重() -> None:
    from aivc.seg.finders import sample_frames
    from aivc.seg.instances import box_containment, box_iou, is_duplicate, order_instances
    from aivc.seg.instances import InstanceTrack

    assert sample_frames(0, 100, 0, 1) == [0]
    # 回歸：--samples N 是「總共 N 幀」；錨定幀不在格點上時換掉離它最近的格點（以前另外加上去 → N+1 幀）
    assert sample_frames(0, 100, 30, 3) == [30, 0, 99]
    assert sample_frames(0, 100, 0, 3) == [0, 50, 99]
    for anchor in (0, 13, 31, 50, 77, 99):
        for n in (2, 3, 5):
            ks = sample_frames(0, 100, anchor, n)
            assert len(ks) == n and ks[0] == anchor and len(set(ks)) == n, (anchor, n, ks)
    assert sample_frames(10, 11, 10, 5) == [10]
    assert box_iou((0, 0, 10, 10), (5, 0, 10, 10)) == pytest.approx(1 / 3)
    assert box_containment((0, 0, 100, 100), (10, 10, 5, 5)) == 1.0
    assert is_duplicate((0, 0, 100, 100), (10, 10, 5, 5)) and not is_duplicate((0, 0, 10, 10), (50, 50, 10, 10))
    a = InstanceTrack(1, "a", 8, 8, score=0.5)
    b = InstanceTrack(2, "b", 8, 8, score=0.9)
    c = InstanceTrack(3, "c", 8, 8, score=0.9)
    m = np.zeros((8, 8), bool)
    m[2:4, 2:5] = True
    b.add(5, m)
    c.add(2, m)
    assert [t.key for t in order_instances([a, b, c])] == [3, 2, 1], "同分先出現的在前"
    assert c.bbox(2) == (2.0, 2.0, 3.0, 2.0) and c.area(2) == 6 and c.best_frame() == 2 and c.bbox(3) is None


class _BoxSession:
    """SAM 2.1 session 替身：遮罩＝提示框本身，傳播時每幀照抄。"""

    def __init__(self, size: tuple[int, int]) -> None:
        self.size = size
        self.boxes: dict[int, tuple[float, ...]] = {}

    def _mask(self, box: tuple[float, ...]) -> np.ndarray:
        W, H = self.size
        m = np.zeros((H, W), bool)
        x, y, w, h = (int(round(v)) for v in box)
        m[y : y + h, x : x + w] = True
        return m

    def add_prompt(self, k: int, oid: int, rgb: np.ndarray, *, points: Any = (), box: Any = None) -> np.ndarray:
        self.boxes[oid] = tuple(box)
        return self._mask(box)

    def propagate_frames(self, frames: Any, direction: str) -> Any:
        from aivc.seg.backend import FrameMasks

        for k, _rgb in frames:
            yield FrameMasks(int(k), {o: self._mask(b) for o, b in self.boxes.items()}, {o: 1.0 for o in self.boxes})

    def close(self) -> None:
        pass


class _BoxBackend:
    def loaded(self) -> Any:
        from types import SimpleNamespace

        return SimpleNamespace(model_id="fake/sam")

    def open_session(self, size: tuple[int, int]) -> _BoxSession:
        return _BoxSession(size)


class _Frames:
    width, height = 120, 90

    def get(self, k: int) -> np.ndarray:
        return np.zeros((self.height, self.width, 3), np.uint8)

    def iter_frames(self, k0: int, k1: int) -> Any:
        return ((k, self.get(k)) for k in range(k0, k1))

    def iter_frames_reversed(self, k0: int, k1: int) -> Any:
        return ((k, self.get(k)) for k in range(k1 - 1, k0 - 1, -1))


class _NullCtx:
    def __init__(self) -> None:
        self.events: list[tuple[str, int, int]] = []

    def progress(self, stage: str, done: int, total: int, **k: Any) -> None:
        self.events.append((stage, int(done), int(total)))

    def log(self, *a: Any, **k: Any) -> None: ...
    def check_cancel(self) -> None: ...


def test_後備_不同片語的巢狀物件不算重複_臉在人的框裡() -> None:
    """回歸：「person, face」——臉整個落在人的框裡（包含 1.0），以前被當成重複框丟掉，只剩人。
    去重的「包含」規則只在同一個片語內用；不同片語只有幾乎重合（同義詞）才算同一個。"""
    from aivc.seg.finders import FindRequest, OwlSam2Finder
    from aivc.seg.instances import is_same_object
    from aivc.seg.text_box import TextBox

    def detect(rgb: np.ndarray, text: str, **_kw: Any) -> list[Any]:
        return [
            TextBox((10.0, 5.0, 60.0, 80.0), "person", 0.5),
            TextBox((12.0, 7.0, 56.0, 76.0), "person", 0.3),  # 同片語的重複框（OWLv2 沒有 NMS）
            TextBox((30.0, 10.0, 16.0, 18.0), "face", 0.2),  # 在人的框裡
            TextBox((80.0, 40.0, 30.0, 20.0), "car", 0.4),
            TextBox((80.5, 40.0, 30.0, 20.5), "vehicle", 0.35),  # 同義詞：幾乎重合
        ]

    f = OwlSam2Finder(detect=detect, owl_loader=lambda v, d: object(), backend=_BoxBackend())
    f.prepare()
    run = f.find(_Frames(), FindRequest(0, 6, 0, ("person", "face", "car", "vehicle")), _NullCtx())
    assert sorted(t.phrase for t in run.instances) == ["car", "face", "person"]
    assert run.dropped == 2, "同片語的重複框與同義詞的重疊框照樣去掉"
    assert is_same_object((0, 0, 100, 100), "a", (10, 10, 5, 5), "a")
    assert not is_same_object((0, 0, 100, 100), "person", (10, 10, 5, 5), "face")
    # --samples：之後取樣幀的「既有實例」也只在同片語內比 —— 臉不會被人的遮罩擋掉
    run2 = f.find(_Frames(), FindRequest(0, 6, 0, ("person", "face"), samples=3), _NullCtx())
    assert sorted(t.phrase for t in run2.instances) == ["car", "face", "person"]


def test_後備_多組傳播的進度累加_偵測用自己的_stage() -> None:
    """回歸：ServeCtx 以 stage 第一筆事件當 eta 起點；每組傳播 done 都從 1 重來的話，第二組的 eta 會把第一組算進去。"""
    from aivc.seg.finders import STAGE, STAGE_DETECT, FindRequest, OwlSam2Finder
    from aivc.seg.text_box import TextBox

    def detect(rgb: np.ndarray, text: str, **_kw: Any) -> list[Any]:
        detect.n += 1  # type: ignore[attr-defined]
        return [TextBox((10.0 + 40 * detect.n, 5.0, 20.0, 20.0), "thing", 0.5)]  # type: ignore[attr-defined]

    detect.n = 0  # type: ignore[attr-defined]
    ctx = _NullCtx()
    f = OwlSam2Finder(detect=detect, owl_loader=lambda v, d: object(), backend=_BoxBackend())
    f.find(_Frames(), FindRequest(0, 5, 0, ("thing",), samples=2), ctx)
    prop = [(d, t) for s, d, t in ctx.events if s == STAGE]
    assert [d for d, _t in prop] == list(range(1, 9)) and prop[-1][1] == 8, prop
    assert all(s in (STAGE, STAGE_DETECT) for s, _d, _t in ctx.events)


def test_InstanceTrack_缺席條目(tmp_path: Path) -> None:
    from aivc.seg.instances import InstanceTrack
    from aivc.seg.maskfile import MaskFile

    t = InstanceTrack(1, "x", 8, 6)
    m = np.zeros((6, 8), bool)
    m[1:3, 1:3] = True
    t.add(3, m)
    t.add(4, np.zeros((6, 8), bool))
    t.mark_absent(range(2, 6))
    assert sorted(t.rle) == [2, 3, 4, 5] and t.present_frames() == [3] and t.first_frame == t.last_frame == 3
    st = MaskFile.write_rle(tmp_path / "m.aivm", 8, 6, sorted(t.rle.items()))
    assert (st.n_present, st.n_absent) == (1, 3)
    with pytest.raises(ValueError):
        t.add(9, np.zeros((5, 5), bool))
    assert os.path.getsize(st.path) > 0
