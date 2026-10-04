"""`aivc fx`／`aivc fx-preview`（ops/fx.py）端到端：合成測試片 → 套特效 → **無損**（mkv 預設 FFV1）輸出 → 解回來逐位元比。

這是「作用範圍外逐位元相同」在真的解碼／編碼路上的驗證：
- 物件不在的幀：輸出的 Y/U/V 與來源解碼結果完全相同（原樣放行）。
- 有特效的幀：輸出＝`apply_effects` 對同一個解碼幀算出的結果；F 外的 Y、沒碰到 F 的色度樣本與來源相同。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pytest

av = pytest.importorskip("av")
cv2 = pytest.importorskip("cv2")

from fixtures import objclip as OC  # noqa: E402

from aivc.ops import OpError, load_all  # noqa: E402
from aivc.ops._ctx import CliCtx  # noqa: E402
from aivc.seg.maskfile import MaskFile  # noqa: E402

ABSENT = (5, 6, 7)


class _Ctx(CliCtx):
    def __init__(self) -> None:
        super().__init__()
        self.logs: list[tuple[str, str]] = []

    def log(self, level: str, message: str) -> None:
        self.logs.append((level, message))

    def progress(self, stage: str, done: int, total: int, **extra: Any) -> None:
        pass

    def artifact(self, path: str, kind: str = "") -> None:
        pass


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    load_all()


@pytest.fixture(scope="module")
def clip(tmp_path_factory: pytest.TempPathFactory) -> Path:
    p = tmp_path_factory.mktemp("fxclip") / "特效 來源.mkv"
    try:
        OC.write_clip(p)
    except Exception as e:  # noqa: BLE001
        pytest.skip(f"PyAV 無法編出 libx264/matroska 測試片：{e}")
    return p


@pytest.fixture()
def masks(tmp_path: Path) -> Path:
    p = tmp_path / "obj1" / "masks.aivm"
    MaskFile.write(p, OC.W, OC.H, ((k, None if k in ABSENT else OC.truth(k)) for k in range(OC.N)))
    return p


def _decode(path: Path) -> list[Any]:
    """與 op 同一條解碼路（probe 的色彩中繼資料：這支未標色彩的小片會被判成 BT.601）。"""
    from aivc.media.source import FrameSource
    from aivc.ops import media as M

    ctx = _Ctx()
    mc, pr = M.open_media(str(path), ctx)
    idx, cfr, _ = M.ensure_index(str(path), mc, pr, ctx)
    with FrameSource(str(path), idx, cfr, probe=pr, lru=4, ctx=ctx) as fs:
        return [fs.get_proxy_frame(k) for k in range(int(cfr.n_frames))]


def test_fx_無損輸出_範圍外逐位元相同(clip: Path, masks: Path, tmp_path: Path) -> None:
    from aivc.fx import apply_effects, load_stack
    from aivc.objects.track import ObjectTrack
    from aivc.ops.fx import fx_apply

    stack = [{"type": "mosaic", "shape": "ellipse", "expand": 3}, {"type": "outline", "color": "#00FF00", "width": 2}]
    out = tmp_path / "輸出.mkv"
    ctx = _Ctx()
    r = fx_apply({"video": str(clip), "masks": [str(masks)], "effects": json.dumps(stack), "out": str(out)}, ctx)
    assert r["frames"] == OC.N and r["changedFrames"] == OC.N - len(ABSENT) and r["unchangedFrames"] == len(ABSENT)
    assert r["objects"][0]["absentFrames"] == len(ABSENT) and [e["type"] for e in r["objects"][0]["effects"]] == ["mosaic", "outline"]
    src, dst = _decode(clip), _decode(out)
    assert len(src) == len(dst) == OC.N
    track = ObjectTrack.open(masks)
    pairs = [(s.target, s.effects) for s in load_stack(stack)]
    for k in range(OC.N):
        a, b = src[k], dst[k]
        if k in ABSENT:
            for p in ("y", "u", "v"):
                assert np.array_equal(getattr(a, p), getattr(b, p)), f"第 {k} 幀物件不在，應該原樣放行（{p}）"
            continue
        res = apply_effects(a, k, {1: track.frame(k)}, pairs)
        F = res.footprint(OC.W, OC.H)
        for p in ("y", "u", "v"):
            assert np.array_equal(getattr(res.frame, p), getattr(b, p)), f"第 {k} 幀輸出與 apply_effects 不同（{p}）"
        assert np.array_equal(a.y[~F], b.y[~F]), f"第 {k} 幀作用範圍外的 Y 變了"
        touched = F.reshape(OC.H // 2, 2, OC.W // 2, 2).any(axis=(1, 3))
        assert np.array_equal(a.u[~touched], b.u[~touched]) and np.array_equal(a.v[~touched], b.v[~touched])
        assert not np.array_equal(a.y[F], b.y[F])
    assert any("物件 1 有 3 幀不在畫面" in line for line in r["_human"].splitlines())


def test_fx_特效檔用路徑指定物件_也可以不給_masks(clip: Path, masks: Path, tmp_path: Path) -> None:
    from aivc.ops.fx import fx_apply

    stack = {"stacks": [{"masks": str(masks), "effects": [{"type": "color", "desaturate": 1}]}]}
    r = fx_apply({"video": str(clip), "masks": [], "effects": json.dumps(stack), "out": str(tmp_path / "o.mkv"), "frames": "8:12"}, _Ctx())
    assert r["range"] == [8, 12] and r["frames"] == 4 and r["objects"][0]["masks"] == str(masks)


def test_fx_錯誤(clip: Path, masks: Path, tmp_path: Path) -> None:
    from aivc.ops.fx import fx_apply

    base = {"video": str(clip), "masks": [str(masks)], "out": str(tmp_path / "e.mkv")}
    with pytest.raises(OpError) as e:
        fx_apply({**base, "effects": '{"2": [{"type": "mosaic"}]}'}, _Ctx())
    assert e.value.kind == "Invalid" and "物件 2" in str(e.value)
    with pytest.raises(OpError) as e:
        fx_apply({**base, "effects": json.dumps([{"type": "sticker", "image": str(tmp_path / "沒有.png")}])}, _Ctx())
    assert e.value.kind == "Io"
    with pytest.raises(OpError) as e:
        fx_apply({**base, "effects": '[{"type": "mosiac"}]'}, _Ctx())
    assert e.value.kind == "Invalid" and "mosiac" in str(e.value)
    wrong = tmp_path / "w" / "masks.aivm"
    MaskFile.write(wrong, 10, 10, [(0, np.ones((10, 10), bool))])
    with pytest.raises(OpError) as e:
        fx_apply({**base, "masks": [str(wrong)], "effects": '[{"type": "blur"}]'}, _Ctx())
    assert e.value.kind == "Invalid" and "10×10" in str(e.value)
    with pytest.raises(OpError):
        fx_apply({**base, "effects": '[{"type": "blur"}]', "out": str(clip)}, _Ctx())  # 不能蓋掉來源


def test_fx_preview_單幀與並排(clip: Path, masks: Path, tmp_path: Path) -> None:
    from aivc.ops.fx import fx_preview

    r = fx_preview({"video": str(clip), "masks": [str(masks)], "effects": '[{"type": "mosaic"}]', "frame": 10, "out": str(tmp_path / "p.png")}, _Ctx())
    assert r["changed"] and r["footprintPx"] > 0 and r["size"] == [OC.W, OC.H] and r["applied"] == [{"object": 1, "type": "mosaic"}]
    r2 = fx_preview({"video": str(clip), "masks": [str(masks)], "effects": '[{"type": "mosaic"}]', "frame": 6, "out": str(tmp_path / "q.png"), "compare": True}, _Ctx())
    assert not r2["changed"] and r2["visible"] == {"1": False} and r2["skipped"] == [{"object": 1, "reason": "absent"}]
    assert r2["size"] == [2 * OC.W + 3 * 4, OC.H + 2 * 4]
    img = cv2.imdecode(np.fromfile(r2["out"], np.uint8), cv2.IMREAD_COLOR)
    assert img.shape[:2] == (OC.H + 8, 2 * OC.W + 12)
    with pytest.raises(OpError):
        fx_preview({"video": str(clip), "masks": [str(masks)], "effects": "[]", "frame": 999, "out": str(tmp_path / "x.png")}, _Ctx())


def test_fx_frames_音軌跟著裁成同一段(tmp_path: Path) -> None:
    """回歸：--frames K0:K1 以前只裁影像、音軌從來源 0 秒開始整支複製（輸出長度＝整支來源、聲音對不上畫面）。"""
    import subprocess

    from aivc.media import ffmpeg as ff
    from aivc.ops.fx import fx_apply

    src = tmp_path / "有聲.mkv"
    # 4 s、24 fps；1 kHz 的嗶聲只在 3.0–3.5 s，其他時間靜音
    cmd = [
        ff.exe("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", f"color=c=gray:s={OC.W}x{OC.H}:r=24:d=4",
        "-f", "lavfi", "-i", "sine=f=1000:sample_rate=48000:d=4",
        "-filter:a", "volume=enable='not(between(t,3,3.5))':volume=0",
        "-c:v", "ffv1", "-c:a", "flac", "-shortest", str(src),
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
    except (OSError, subprocess.CalledProcessError) as e:
        pytest.skip(f"ffmpeg 做不出有聲測試片：{e}")
    m = tmp_path / "o" / "masks.aivm"
    MaskFile.write(m, OC.W, OC.H, ((k, OC.truth(k % OC.N)) for k in range(96)))
    out = tmp_path / "段.mkv"
    r = fx_apply({"video": str(src), "masks": [str(m)], "effects": '[{"type": "mosaic"}]', "out": str(out), "frames": "72:84"}, _Ctx())
    assert r["frames"] == 12
    with av.open(str(out)) as c:
        a = c.streams.audio[0]
        pcm = np.concatenate([f.to_ndarray().reshape(-1) for f in c.decode(a)]).astype(np.float64)
        rate = a.rate
    dur = pcm.size / rate
    assert abs(dur - 0.5) < 0.06, f"音軌長度 {dur:.3f} s，應該跟影像一樣 0.5 s"
    head = pcm[: int(0.2 * rate)]
    assert np.sqrt(np.mean(head**2)) > 0.05, "開頭就該是 3.0 s 的嗶聲（以前是來源 0 秒的靜音）"
    # inpaint／bg-blur 共用同一個裁音軌的式子（它們的 _encode 有同樣的問題）
    from types import SimpleNamespace

    from aivc.ops.inpaint import audio_trim_args

    cfr = SimpleNamespace(fps_num=24, fps_den=1, n_frames=96)
    assert audio_trim_args((72, 84), cfr) == ["-ss", "3.000000", "-t", "0.500000"]
    assert audio_trim_args((0, 96), cfr) == [] and audio_trim_args(None, cfr) == []


def test_fx_cq0_做不到無損的編碼器要報錯(clip: Path, masks: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """回歸：help 說 --cq 0＝無損，但 .mp4 走 NVENC 時 -cq 0 是「自動」、位元率編碼器不吃品質值 → 默默輸出有損檔。"""
    from aivc.ops import render
    from aivc.ops.fx import fx_apply, plan_encode

    monkeypatch.setattr(render, "usable_encoders", lambda gpu=True: {"hevc_nvenc", "h264_nvenc", "libopenh264", "ffv1", "libvpx-vp9", "prores_ks"})
    base = {"video": str(clip), "masks": [str(masks)], "effects": '[{"type": "mosaic"}]', "cq": 0}
    with pytest.raises(OpError) as e:
        fx_apply({**base, "out": str(tmp_path / "o.mp4")}, _Ctx())
    assert e.value.kind == "Invalid" and ".mkv" in e.value.hint and not (tmp_path / "o.mp4").exists()
    from aivc.ops import media as M

    _mc, pr = M.open_media(str(clip), _Ctx())
    plan, extra = plan_encode(tmp_path / "x.webm", pr, {"cq": 0})
    assert plan.video_codec == "libvpx-vp9" and extra == ["-lossless", "1"]
    plan2, extra2 = plan_encode(tmp_path / "x.mkv", pr, {"cq": 0})
    assert plan2.video_codec == "ffv1" and extra2 == []
    assert plan_encode(tmp_path / "x.mp4", pr, {})[1] == [], "沒給 --cq 0 不受影響"


def test_fx_準備階段用自己的_stage_負的_window_報錯(clip: Path, masks: Path, tmp_path: Path) -> None:
    """回歸：fx.apply 在建索引／算錨點之前就用 "fx.apply" 送 0/1，ServeCtx 的 eta 起點被拉到最前面，剩餘時間灌大好幾倍。"""
    from aivc.ops.fx import STAGE, STAGE_OPEN, fx_apply

    events: list[tuple[str, int]] = []

    class Rec(_Ctx):
        def progress(self, stage: str, done: int, total: int, **extra: Any) -> None:
            events.append((stage, int(done)))

    fx_apply({"video": str(clip), "masks": [str(masks)], "effects": '[{"type": "mosaic"}]', "out": str(tmp_path / "o.mkv")}, Rec())
    main = [d for s, d in events if s == STAGE]
    assert events[0][0] == STAGE_OPEN and main and main[0] == 1, "fx.apply 的第一筆就是第一幀"
    assert any(s == "objects.anchors" for s, _d in events), "算錨點有進度"
    with pytest.raises(OpError) as e:
        fx_apply({"video": str(clip), "masks": [str(masks)], "effects": "[]", "out": str(tmp_path / "w.mkv"), "window": -1}, _Ctx())
    assert e.value.kind == "Invalid"


def test_fx_preview_不是_light(clip: Path) -> None:
    """fx.preview 要解碼（PyAV），與主 lane 首次載入模型同時進行會卡死（seg/text_box.py）→ 留在主 lane。"""
    from aivc.ops import LIGHT_OPS, REGISTRY

    for name in ("fx.preview", "fx.apply", "media.frame", "objects.preview", "objects.export"):
        assert REGISTRY[name].light is False and name not in LIGHT_OPS and REGISTRY[name].gpu is False
    for name in ("seg.find", "seg.select"):
        assert REGISTRY[name].gpu is True and REGISTRY[name].light is False
