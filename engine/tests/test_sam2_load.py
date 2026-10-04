"""SAM 2.1 載入：先讀本機快取（local_files_only=True，不連網），沒有才連 Hub。

不碰真的 transformers／權重：用假的 Sam2VideoModel／Sam2VideoProcessor 記下每次 from_pretrained 的參數。
修正前 load() 直接 from_pretrained(model_id) —— 每次載入都向 Hub 發 ~29 個請求，代理拒絕時卡 150 s。
"""
from __future__ import annotations

import sys
import types
from typing import Any

import pytest


class _Model:
    def to(self, device: str) -> _Model:
        return self

    def eval(self) -> _Model:
        return self


def _install(monkeypatch: pytest.MonkeyPatch, calls: list[tuple[str, dict[str, Any]]], *, local_error: dict[str, BaseException] | None = None,
             network_error: BaseException | None = None) -> None:
    """假 transformers＋假 torch＋固定裝置 cpu/float32。local_error[cls] 在 local_files_only=True 時擲；network_error 在沒帶旗標時擲。"""
    local_error = local_error or {}

    def fake_cls(name: str, product: Any) -> type:
        class Fake:
            @staticmethod
            def from_pretrained(model_id: str, **kw: Any) -> Any:
                calls.append((name, dict(kw, model_id=model_id)))
                if kw.get("local_files_only"):
                    if name in local_error:
                        raise local_error[name]
                elif network_error is not None:
                    raise network_error
                return product

        Fake.__name__ = name
        return Fake

    mod = types.ModuleType("transformers")
    mod.Sam2VideoModel = fake_cls("Sam2VideoModel", _Model())  # type: ignore[attr-defined]
    mod.Sam2VideoProcessor = fake_cls("Sam2VideoProcessor", object())  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "transformers", mod)
    monkeypatch.setitem(sys.modules, "torch", types.ModuleType("torch"))

    from aivc.seg import sam2_hf

    monkeypatch.setattr(sam2_hf, "_LOADED", None)
    monkeypatch.setattr(sam2_hf.dev, "resolve_device", lambda requested, torch_mod=None: "cpu")
    monkeypatch.setattr(sam2_hf.dev, "preferred_dtype", lambda device, torch_mod=None: "float32")
    monkeypatch.setattr(sam2_hf.dev, "empty_cache", lambda torch_mod=None: None)


def test_cached_model_loads_without_touching_the_network(monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.seg import sam2_hf

    calls: list[tuple[str, dict[str, Any]]] = []
    _install(monkeypatch, calls)
    loaded = sam2_hf.load("small", "cpu")
    assert calls == [
        ("Sam2VideoProcessor", {"local_files_only": True, "model_id": "facebook/sam2.1-hiera-small"}),
        ("Sam2VideoModel", {"local_files_only": True, "dtype": "float32", "model_id": "facebook/sam2.1-hiera-small"}),
    ]
    assert loaded.model_id == "facebook/sam2.1-hiera-small" and loaded.dtype == "float32"
    monkeypatch.setattr(sam2_hf, "_LOADED", None)


@pytest.mark.parametrize("missing", [["Sam2VideoProcessor", "Sam2VideoModel"], ["Sam2VideoModel"]])
def test_missing_or_partial_cache_falls_back_to_download(monkeypatch: pytest.MonkeyPatch, missing: list[str]) -> None:
    """空的 HF_HOME（兩個都沒有）或半套快照（只有權重缺）：本機那次失敗 → 第二次不帶旗標（照舊下載）。"""
    from aivc.seg import sam2_hf

    calls: list[tuple[str, dict[str, Any]]] = []
    errors: dict[str, BaseException] = {name: OSError(f"{name}: not in local cache") for name in missing}
    _install(monkeypatch, calls, local_error=errors)
    sam2_hf.load("tiny", "cpu")
    by_cls: dict[str, list[dict[str, Any]]] = {}
    for name, kw in calls:
        by_cls.setdefault(name, []).append(kw)
    for name in ("Sam2VideoProcessor", "Sam2VideoModel"):
        flags = [kw.get("local_files_only") for kw in by_cls[name]]
        assert flags == ([True, None] if name in missing else [True]), (name, by_cls[name])
    assert by_cls["Sam2VideoModel"][-1]["dtype"] == "float32", "下載那次也要帶 dtype"
    monkeypatch.setattr(sam2_hf, "_LOADED", None)


def test_local_miss_and_network_failure_raise_model_error_with_hint(monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.seg import sam2_hf
    from aivc.seg.backend import SegModelError

    calls: list[tuple[str, dict[str, Any]]] = []
    _install(monkeypatch, calls, local_error={"Sam2VideoProcessor": FileNotFoundError("no cache")}, network_error=ConnectionError("proxy refused"))
    with pytest.raises(SegModelError) as ei:
        sam2_hf.load("small", "cpu")
    assert ei.value.kind == "Model" and "ConnectionError" in str(ei.value) and "aivc models pull" in ei.value.hint
    assert [kw.get("local_files_only") for _, kw in calls] == [True, None]
    assert sam2_hf._LOADED is None


def test_already_loaded_does_not_call_from_pretrained_again(monkeypatch: pytest.MonkeyPatch) -> None:
    from aivc.seg import sam2_hf

    calls: list[tuple[str, dict[str, Any]]] = []
    _install(monkeypatch, calls)
    a = sam2_hf.load("small", "cpu")
    n = len(calls)
    assert sam2_hf.load("small", "cpu") is a and len(calls) == n
    monkeypatch.setattr(sam2_hf, "_LOADED", None)
