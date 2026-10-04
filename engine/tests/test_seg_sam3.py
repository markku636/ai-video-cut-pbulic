"""SAM 3 包裝（seg/sam3_hf.py、seg/finders.Sam3Finder）的控制流程 —— **全部用假的 model／processor**。

這台開發機的 Hugging Face 帳號被 facebook/sam3 的作者拒絕存取，所以真權重驗證不了（也不可以改抓第三方的重新上傳）。
這裡守的是對照 transformers 5.17 原始碼寫出來的那些規則：
- 串流：每幀 `processor(images=…)` → `model(inference_session, frame, frame_idx=段內本地索引)` → `postprocess_outputs(…, original_sizes)`。
- `processed_frames` 舊幀換成空張量、**長度不變**（追蹤器用它的長度決定回看幾幀物件指標）；太舊的非條件幀輸出丟掉。
- 分段：新段重餵上一幀當重疊幀，用遮罩 IoU（同片語）把新 id 接回全域 id。
- `--threshold` 暫時改模型的 new_det_thresh／score_threshold_detection，跑完（包括中途取消）一定還原。
- 點／框走 SAM 3 追蹤器，外殼沿用 `Sam2HfSession`。
- 載入：本機快取優先、帶 HF token、沒權限 → gated 說明（token 本身絕不出現在訊息裡）。
"""
from __future__ import annotations

import sys
import types
from types import SimpleNamespace
from typing import Any, Callable

import numpy as np
import pytest

torch = pytest.importorskip("torch")

from aivc.ops import Canceled  # noqa: E402
from aivc.seg import sam3_hf  # noqa: E402
from aivc.seg.backend import SegModelError  # noqa: E402

W, H = 40, 30


def _box(x0: int, y0: int, x1: int, y1: int) -> np.ndarray:
    m = np.zeros((H, W), bool)
    m[y0:y1, x0:x1] = True
    return m


def scene(k: int) -> list[tuple[str, str, np.ndarray, float]]:
    """真值：(物件鍵, 片語, 遮罩, 偵測分數)。A 貓全程、B 狗第 4 幀起、C 低分的貓第 2–3 幀。"""
    out = [("A", "cat", _box(2 + k, 2, 12 + k, 12), 0.95)]
    if k >= 4:
        out.append(("B", "dog", _box(25, 15, 35, 25), 0.9))
    if 2 <= k <= 3:
        out.append(("C", "cat", _box(2, 20, 8, 28), 0.6))
    return out


def frames(n: int) -> list[tuple[int, np.ndarray]]:
    out = []
    for k in range(n):
        img = np.zeros((H, W, 3), np.uint8)
        img[0, 0, 0] = k  # 幀號藏在像素裡，假模型讀得回來
        out.append((k, img))
    return out


class FakeSession:
    def __init__(self) -> None:
        self.processed_frames: dict[int, Any] | None = None
        self.output_dict_per_obj: dict[int, dict[str, dict[int, Any]]] = {}
        self.prompts: list[str] = []
        self.local: dict[str, int] = {}
        self.reset = False

    def reset_inference_session(self) -> None:
        self.reset = True


class FakeProcessor:
    def __init__(self) -> None:
        self.sessions: list[FakeSession] = []
        self.post_sizes: list[Any] = []

    def init_video_session(self, **kw: Any) -> FakeSession:
        assert kw["video_storage_device"] == "cpu" and "dtype" in kw
        s = FakeSession()
        self.sessions.append(s)
        return s

    def add_text_prompt(self, inference_session: FakeSession, text: list[str]) -> FakeSession:
        inference_session.prompts += list(text)
        return inference_session

    def __call__(self, images: np.ndarray, return_tensors: str = "pt", device: Any = None) -> dict[str, Any]:
        return {"pixel_values": torch.from_numpy(images).permute(2, 0, 1)[None].float(), "original_sizes": torch.tensor([[H, W]])}

    def postprocess_outputs(self, session: FakeSession, out: Any, original_sizes: Any = None) -> dict[str, Any]:
        self.post_sizes.append(original_sizes)
        return out.post


class FakeModel:
    def __init__(self, scene_fn: Callable[[int], list[Any]] = scene) -> None:
        self.scene = scene_fn
        self.new_det_thresh = 0.7
        self.score_threshold_detection = 0.5
        self.calls: list[tuple[int, int, int, float]] = []  # (第幾個 session, 本地索引, 真幀號, 當時的門檻)

    def __call__(self, inference_session: FakeSession, frame: Any, frame_idx: int, reverse: bool = False) -> Any:
        s = inference_session
        assert reverse is False
        if s.processed_frames is None:
            s.processed_frames = {}
        s.processed_frames[frame_idx] = frame
        knum = int(frame[0, 0, 0])
        self.calls.append((id(s), frame_idx, knum, self.new_det_thresh))
        ids, masks, scores, p2o = [], [], [], {}
        for key, phrase, m, sc in self.scene(knum):
            if key not in s.local:
                if sc < self.new_det_thresh:
                    continue
                s.local[key] = len(s.local) + 10  # 本地 id 刻意不是 1..n：全域 id 要由包裝重新編
                s.output_dict_per_obj[s.local[key]] = {"cond_frame_outputs": {frame_idx: {"x": 1}}, "non_cond_frame_outputs": {}}
            oid = s.local[key]
            s.output_dict_per_obj[oid]["non_cond_frame_outputs"][frame_idx] = {"x": 1}
            ids.append(oid)
            masks.append(m)
            scores.append(sc)
            p2o.setdefault(phrase, []).append(oid)
        post = {
            "object_ids": torch.tensor(ids, dtype=torch.int64),
            "scores": torch.tensor(scores, dtype=torch.float32),
            "masks": torch.from_numpy(np.stack(masks)) if masks else torch.zeros((0, H, W), dtype=torch.bool),
            "prompt_to_obj_ids": p2o,
        }
        return SimpleNamespace(post=post, frame_idx=frame_idx)


def _loaded(model: FakeModel | None = None) -> Any:
    return sam3_hf.LoadedSam3Video(model or FakeModel(), FakeProcessor(), "facebook/sam3", "cpu", torch.float32, 0.0, False)


# ---------------------------------------------------------------- 文字追蹤
def test_串流_全域編號_片語_修剪(monkeypatch: pytest.MonkeyPatch) -> None:
    ld = _loaded()
    tr = sam3_hf.Sam3TextTracker(ld, (W, H), chunk=0, memory_window=3)
    out = list(tr.run(frames(10), ["cat", "dog"]))
    assert [f.k for f in out] == list(range(10))
    assert tr.phrase_of == {1: "cat", 2: "dog"} and tr.stats.chunks == 1 and tr.stats.frames == 10
    assert set(out[0].masks) == {1} and set(out[9].masks) == {1, 2}
    assert np.array_equal(out[9].masks[1], _box(11, 2, 21, 12)) and out[9].scores[2] == pytest.approx(0.9)
    s = ld.processor.sessions[0]
    assert s.prompts == ["cat", "dog"] and s.reset is True
    # 本地索引是段內 0..n-1；processed_frames 的長度不變、只有最後一幀還留著像素
    assert [c[1] for c in ld.model.calls] == list(range(10))
    assert sorted(s.processed_frames) == list(range(10))
    assert [int(v.numel()) > 0 for v in s.processed_frames.values()] == [False] * 9 + [True]
    # 非條件幀輸出只留「離目前幀 ≤ memory_window」的（文字追蹤只往前跑；不留靠近條件幀的，見模組說明第 3 點）；條件幀永遠留
    for d in s.output_dict_per_obj.values():
        assert d["cond_frame_outputs"] and all(9 - f <= 3 for f in d["non_cond_frame_outputs"])
    a_nc = sorted(s.output_dict_per_obj[10]["non_cond_frame_outputs"])  # A：條件幀 0
    assert a_nc == [6, 7, 8, 9], a_nc
    assert ld.processor.post_sizes[0].tolist() == [[H, W]], "串流要把 original_sizes 傳給 postprocess"


class _RecondModel(FakeModel):
    """模仿 transformers 5.17 的 reconditioning：每 4 幀把分數夠高的物件那一幀從 non_cond 搬到 cond，
    輸出裡帶 high_res_masks（真的模型約 2 MB／物件／幀）。"""

    def __call__(self, inference_session: FakeSession, frame: Any, frame_idx: int, reverse: bool = False) -> Any:
        out = super().__call__(inference_session, frame, frame_idx, reverse)
        for d in inference_session.output_dict_per_obj.values():
            cur = d["non_cond_frame_outputs"].get(frame_idx)
            if cur is not None:
                cur["high_res_masks"] = np.zeros((4, 4))
            if frame_idx % 4 == 0 and frame_idx in d["non_cond_frame_outputs"]:
                d["cond_frame_outputs"][frame_idx] = d["non_cond_frame_outputs"].pop(frame_idx)
        return out


def test_修剪_reconditioning_的條件幀很密也照樣丟舊的非條件幀_高解析遮罩只留目前幀() -> None:
    """回歸：以前「離任何條件幀 ≤ window 的非條件幀也留著」——SAM 3 每 16 幀 recondition 一次，
    條件幀密到每一幀都離某個條件幀很近，一幀都刪不掉（600 幀一段約 2 GB／物件）。"""
    ld = _loaded(_RecondModel())
    tr = sam3_hf.Sam3TextTracker(ld, (W, H), chunk=0, memory_window=3)
    out = list(tr.run(frames(30), ["cat"]))
    assert len(out) == 30
    s = ld.processor.sessions[0]
    for d in s.output_dict_per_obj.values():
        nc = d["non_cond_frame_outputs"]
        assert nc and all(29 - f <= 3 for f in nc), sorted(nc)
        for store in (nc, d["cond_frame_outputs"]):
            for f, o in store.items():
                if f < 29:
                    assert "high_res_masks" not in o, f"第 {f} 幀（已處理完）的 high_res_masks 要拿掉"
        assert len(d["cond_frame_outputs"]) >= 7, "條件幀永遠留"


def test_max_追蹤時就限制物件數_跑完還原() -> None:
    """回歸：--max 以前只在追蹤完才截，Sam3VideoModel.max_num_objects 維持 10000 → 人群鏡頭每張臉都追、都占 GPU。"""
    seen: list[int] = []

    class CapModel(FakeModel):
        def __init__(self) -> None:
            super().__init__(lambda k: [(f"F{i}", "face", _box(i, 0, i + 1, 1), 0.95) for i in range(30)])
            self.max_num_objects = 10000

        def __call__(self, inference_session: FakeSession, frame: Any, frame_idx: int, reverse: bool = False) -> Any:
            seen.append(self.max_num_objects)
            s = inference_session
            room = self.max_num_objects - len(s.local)
            scene = self.scene
            allowed = {key for key, *_ in scene(0)[: max(0, room)]} | set(s.local)
            self.scene = lambda k: [t for t in scene(k) if t[0] in allowed]
            try:
                return super().__call__(inference_session, frame, frame_idx, reverse)
            finally:
                self.scene = scene

    model = CapModel()
    from aivc.seg.finders import FindRequest, Sam3Finder

    f = Sam3Finder(device="cpu", chunk=0, loader=lambda d: _loaded(model))
    f.prepare()
    run = f.find(_Frames(), FindRequest(0, 4, 0, ("face",), max_instances=2), _NullCtx())
    assert set(seen) == {sam3_hf.object_cap(2)} == {16}
    assert len(run.instances) == 16 and model.max_num_objects == 10000, "上限要還原（模型是共用單例）"
    assert sam3_hf.object_cap(8) == 32 and sam3_hf.object_cap(None) is None


def test_分段_重疊幀用_IoU_接回同一個全域_id() -> None:
    ld = _loaded()
    tr = sam3_hf.Sam3TextTracker(ld, (W, H), chunk=4, memory_window=None)
    out = list(tr.run(frames(10), ["cat", "dog"]))
    assert tr.stats.chunks == 3 and len(ld.processor.sessions) == 3
    assert [f.k for f in out] == list(range(10)), "重疊幀只拿來接 id，不重複輸出"
    assert all(set(f.masks) == ({1} if f.k < 4 else {1, 2}) for f in out), [(f.k, sorted(f.masks)) for f in out]
    assert tr.phrase_of == {1: "cat", 2: "dog"}
    # 第二段的第一次呼叫＝重餵第 3 幀、本地索引 0；第三段重餵第 6 幀
    by_session: dict[int, list[tuple[int, int]]] = {}
    for sid, local, knum, _t in ld.model.calls:
        by_session.setdefault(sid, []).append((local, knum))
    seqs = list(by_session.values())
    assert seqs[0] == [(0, 0), (1, 1), (2, 2), (3, 3)]
    assert seqs[1][0] == (0, 3) and seqs[1][1:] == [(1, 4), (2, 5), (3, 6)]
    assert seqs[2][0] == (0, 6) and seqs[2][1:] == [(1, 7), (2, 8), (3, 9)]
    assert tr.stats.relinked == 1 + 2


def test_門檻暫時改_跑完與取消都還原() -> None:
    model = FakeModel()
    ld = _loaded(model)
    tr = sam3_hf.Sam3TextTracker(ld, (W, H), chunk=0, new_det_threshold=0.5)
    out = list(tr.run(frames(6), ["cat", "dog"]))
    assert {c[3] for c in model.calls} == {0.5}
    assert (model.new_det_thresh, model.score_threshold_detection) == (0.7, 0.5)
    assert tr.phrase_of == {1: "cat", 2: "cat", 3: "dog"}, "0.6 分的 C（第 2 幀出現）在門檻 0.5 下要被偵測，排在 B 前面"
    assert {g for f in out if f.k in (2, 3) for g in f.masks} == {1, 2}
    model2 = FakeModel()
    tr2 = sam3_hf.Sam3TextTracker(_loaded(model2), (W, H), chunk=0, new_det_threshold=0.3)
    n = {"i": 0}

    def cancel() -> None:
        n["i"] += 1
        if n["i"] > 2:
            raise Canceled()

    with pytest.raises(Canceled):
        list(tr2.run(frames(6), ["cat"], cancel))
    assert (model2.new_det_thresh, model2.score_threshold_detection) == (0.7, 0.5)


def test_不同片語的實例不會被接在一起() -> None:
    from aivc.seg.instances import link_by_iou

    m = _box(0, 0, 10, 10)
    assert link_by_iou({1: m}, {7: m}, 0.5, prev_labels={1: "cat"}, cur_labels={7: "dog"}) == {}
    assert link_by_iou({1: m}, {7: m}, 0.5, prev_labels={1: "cat"}, cur_labels={7: "cat"}) == {7: 1}
    # 一對一：兩個新物件都疊在同一個舊物件上，只有 IoU 高的那個接得上
    assert link_by_iou({1: m}, {7: m, 8: _box(0, 0, 10, 6)}, 0.5) == {7: 1}


class _Frames:
    width, height = W, H

    def iter_frames(self, k0: int, k1: int) -> Any:
        return iter(frames(k1)[k0:k1])


class _NullCtx:
    def progress(self, *a: Any, **k: Any) -> None: ...
    def log(self, *a: Any, **k: Any) -> None: ...
    def check_cancel(self) -> None: ...
    def artifact(self, *a: Any, **k: Any) -> None: ...


def test_Sam3Finder_補缺席條目_過濾一閃而過的實例() -> None:
    from aivc.seg.finders import FindRequest, Sam3Finder

    f = Sam3Finder(device="cpu", chunk=0, loader=lambda d: _loaded())
    f.prepare()
    run = f.find(_Frames(), FindRequest(0, 10, 0, ("cat", "dog"), threshold=0.5), _NullCtx())
    phr = sorted((t.phrase, t.first_frame, t.last_frame, t.n_present) for t in run.instances)
    assert phr == [("cat", 0, 9, 10), ("dog", 4, 9, 6)], "C 只出現 2 幀 < min_frames 3，要被丟掉"
    assert run.dropped == 1 and any("min-frames" in n or "少於" in n for n in run.notes)
    dog = next(t for t in run.instances if t.phrase == "dog")
    assert sorted(dog.rle) == list(range(10)) and dog.rle[0] is None and dog.score == pytest.approx(0.9)


# ---------------------------------------------------------------- 點／框：SAM 3 追蹤器套 Sam2HfSession
class _TrkSession:
    def __init__(self) -> None:
        self.processed_frames: dict[int, Any] = {}
        self.output_dict_per_obj: dict[int, dict[str, dict[int, Any]]] = {}
        self.boxes: dict[int, Any] = {}

    def get_obj_num(self) -> int:
        return len(self.output_dict_per_obj)

    def reset_inference_session(self) -> None:
        pass


class _TrkProcessor:
    def __init__(self) -> None:
        self.inputs: list[dict[str, Any]] = []

    def init_video_session(self, **kw: Any) -> _TrkSession:
        return _TrkSession()

    def add_inputs_to_inference_session(self, inference_session: _TrkSession, frame_idx: int, obj_ids: list[int], original_size: Any, clear_old_inputs: bool, **kw: Any) -> None:
        self.inputs.append({"frame": frame_idx, "obj": obj_ids, "size": original_size, **kw})
        x0, y0, x1, y1 = kw["input_boxes"][0][0]
        inference_session.boxes[obj_ids[0]] = (int(x0), int(y0), int(x1), int(y1))
        inference_session.output_dict_per_obj.setdefault(len(inference_session.output_dict_per_obj), {"cond_frame_outputs": {frame_idx: 1}, "non_cond_frame_outputs": {}})

    def __call__(self, images: np.ndarray, return_tensors: str = "pt", device: Any = None) -> dict[str, Any]:
        return {"pixel_values": torch.from_numpy(images).permute(2, 0, 1)[None].float()}

    def post_process_masks(self, masks: list[Any], original_sizes: Any, mask_threshold: float = 0.0, binarize: bool = False, apply_non_overlapping_constraints: bool = False) -> list[Any]:
        return masks


class _TrkModel:
    def __call__(self, inference_session: _TrkSession, frame_idx: int, frame: Any, reverse: bool = False) -> Any:
        s = inference_session
        s.processed_frames[frame_idx] = frame
        ids = sorted(s.boxes)
        pred = torch.full((len(ids), 1, H, W), -10.0)
        for i, oid in enumerate(ids):
            x0, y0, x1, y1 = s.boxes[oid]
            sh = frame_idx  # 物件每幀往右 1 px
            pred[i, 0, y0:y1, x0 + sh : x1 + sh] = 10.0
        return SimpleNamespace(pred_masks=pred, object_score_logits=torch.full((len(ids), 1), 3.0), object_ids=ids, frame_idx=frame_idx)


def test_SAM3_追蹤器沿用_Sam2HfSession(monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.seg import sam2_hf

    fake = sam2_hf.LoadedSam2(_TrkModel(), _TrkProcessor(), "facebook/sam3", "sam3", "cpu", 0.0, False, torch.float32)
    monkeypatch.setattr(sam3_hf, "load_tracker", lambda device=None: fake)
    be = sam3_hf.Sam3TrackerBackend(device="cpu")
    sess = be.open_session((W, H))
    assert isinstance(sess, sam2_hf.Sam2HfSession)
    img = np.zeros((H, W, 3), np.uint8)
    fm = sess.add_prompt_frame(0, 1, img, box=(5, 5, 10, 8))
    assert fm.masks[1][5:13, 5:15].all() and fm.masks[1].sum() == 80 and fm.scores[1] == pytest.approx(3.0)
    assert fake.processor.inputs[0]["input_boxes"] == [[[5.0, 5.0, 15.0, 13.0]]] and fake.processor.inputs[0]["size"] == (H, W)
    got = list(sess.propagate_frames(((k, img) for k in range(1, 4)), "fwd"))
    assert [g.k for g in got] == [1, 2, 3] and got[-1].masks[1][5:13, 8:18].all()
    s = sess._session
    assert sorted(s.processed_frames) == [0, 3], "串流分支：舊幀直接刪掉（條件幀 0 保留）"
    sess.close()


# ---------------------------------------------------------------- 載入
def _fake_transformers(monkeypatch: pytest.MonkeyPatch, calls: list[tuple[str, dict[str, Any]]], *, network_error: BaseException | None = None) -> None:
    class _M:
        def to(self, d: str) -> "_M":
            return self

        def eval(self) -> "_M":
            return self

    def cls(name: str, product: Any) -> type:
        class C:
            @staticmethod
            def from_pretrained(model_id: str, **kw: Any) -> Any:
                calls.append((name, dict(kw, model_id=model_id)))
                if kw.get("local_files_only"):
                    raise OSError("not in local cache")
                if network_error is not None:
                    raise network_error
                return product

        C.__name__ = name
        return C

    mod = types.ModuleType("transformers")
    for n in ("Sam3VideoModel", "Sam3TrackerVideoModel"):
        setattr(mod, n, cls(n, _M()))
    for n in ("Sam3VideoProcessor", "Sam3TrackerVideoProcessor"):
        setattr(mod, n, cls(n, object()))
    monkeypatch.setitem(sys.modules, "transformers", mod)
    monkeypatch.setattr(sam3_hf, "_resolve", lambda device: ("cpu", "float32"))
    monkeypatch.setattr(sam3_hf, "_VIDEO", None)
    monkeypatch.setattr(sam3_hf, "_TRACKER", None)


def test_載入_本機優先_帶_token_先放掉其他重模型(monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.seg import sam2_hf, text_box

    calls: list[tuple[str, dict[str, Any]]] = []
    _fake_transformers(monkeypatch, calls)
    freed: list[str] = []
    monkeypatch.setattr(sam2_hf, "unload", lambda: freed.append("sam2"))
    monkeypatch.setattr(text_box, "unload", lambda: freed.append("owl"))
    monkeypatch.setattr(sam3_hf, "find_hf_token", lambda: ("hf_秘密", "環境變數 HF_TOKEN"))
    v = sam3_hf.load_video("cpu")
    assert freed == ["sam2", "owl"] and v.model_id == "facebook/sam3"
    assert [(n, kw.get("local_files_only"), kw.get("token")) for n, kw in calls] == [
        ("Sam3VideoProcessor", True, "hf_秘密"), ("Sam3VideoProcessor", None, "hf_秘密"),
        ("Sam3VideoModel", True, "hf_秘密"), ("Sam3VideoModel", None, "hf_秘密"),
    ]
    assert sam3_hf.is_loaded() and sam3_hf.load_video("cpu") is v
    t = sam3_hf.load_tracker("cpu")
    assert t.model_id == "facebook/sam3" and t.variant == "sam3" and sam3_hf._VIDEO is None, "追蹤器版載入前先卸掉影片版"
    # SAM 2.1 要載入時，SAM 3 先讓位（sam2_hf._unload_sam3）
    sam2_hf._unload_sam3()
    assert not sam3_hf.is_loaded()


def test_載入_沒權限是_gated_說明_token_不外洩(monkeypatch: pytest.MonkeyPatch) -> None:
    class GatedRepoError(Exception):
        pass

    calls: list[tuple[str, dict[str, Any]]] = []
    err = OSError("You are trying to access a gated repo.")
    err.__cause__ = GatedRepoError("403 Client Error: Access to model facebook/sam3 is restricted")
    _fake_transformers(monkeypatch, calls, network_error=err)
    from aivc.seg import sam2_hf, text_box

    monkeypatch.setattr(sam2_hf, "unload", lambda: None)
    monkeypatch.setattr(text_box, "unload", lambda: None)
    monkeypatch.setattr(sam3_hf, "find_hf_token", lambda: ("hf_不可以出現", "~/.cache/huggingface/token（hf auth login）"))
    with pytest.raises(SegModelError) as e:
        sam3_hf.load_video("cpu")
    assert e.value.kind == "Model" and "需要申請存取" in str(e.value)
    assert "https://huggingface.co/facebook/sam3" in e.value.hint and "HF_TOKEN" in e.value.hint and "hf auth login" in e.value.hint
    assert "hf_不可以出現" not in str(e.value) + e.value.hint


def test_載入_其他錯誤不誤判成權限(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []
    _fake_transformers(monkeypatch, calls, network_error=ConnectionError("proxy refused"))
    from aivc.seg import sam2_hf, text_box

    monkeypatch.setattr(sam2_hf, "unload", lambda: None)
    monkeypatch.setattr(text_box, "unload", lambda: None)
    monkeypatch.setattr(sam3_hf, "find_hf_token", lambda: (None, ""))
    with pytest.raises(SegModelError) as e:
        sam3_hf.load_tracker("cpu")
    assert "ConnectionError" in str(e.value) and "models pull --sam3" in e.value.hint and "需要申請" not in str(e.value)
