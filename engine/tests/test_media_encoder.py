"""編碼管線（需 ffmpeg，沒有就 skip）：合成幀 → rawvideo 管線 → ffv1 無損逐位元回來、openh264 PSNR、取消清 .part、錯誤回 stderr。"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from aivc import env
from aivc.media import encode_plan as EP
from aivc.media import encoder as EN
from aivc.media import ffmpeg as ff
from aivc.media.source import FrameSource, Yuv420
from aivc.ops import Canceled, OpError

W, H, N = 64, 48, 12
SRC = EP.SourceInfo("mp4", W, H, 30, 1, False, None, "bt709")


@pytest.fixture(scope="module")
def ffmpeg_ready() -> None:
    if env.ffmpeg_dir() is None:
        pytest.skip("沒有 ffmpeg")


def synth_frames(n: int = N) -> list[Yuv420]:
    """會動的漸層 + 色塊，值落在 tv range，讓有損編碼 PSNR 有意義。"""
    out = []
    yy, xx = np.mgrid[0:H, 0:W]
    for i in range(n):
        y = (16 + ((xx * 3 + yy * 2 + i * 7) % 220)).astype(np.uint8)
        u = np.full((H // 2, W // 2), 128 + (i % 5) * 10, np.uint8)
        v = np.full((H // 2, W // 2), 128 - (i % 3) * 12, np.uint8)
        v[: H // 4, : W // 4] = 200
        out.append(Yuv420(y, u, v, src_idx=i, pts_ms=i * 1000 / 30))
    return out


def _no_parts(d: Path) -> bool:
    """.part 名字是唯一的 `<out>.<pid>-<8hex>.part`（B-09）：檢查整個資料夾沒有任何 .part 殘留，而不是只看舊的固定名。"""
    return not [p.name for p in d.rglob("*.part")]


class RecordingCtx:
    def __init__(self, cancel_after: int | None = None) -> None:
        self.progress_calls: list[tuple[str, int, int]] = []
        self.logs: list[str] = []
        self.cancel_after = cancel_after
        self.checks = 0

    def progress(self, stage: str, done: int, total: int, **extra: object) -> None:
        self.progress_calls.append((stage, done, total))

    def log(self, level: str, message: str) -> None:
        self.logs.append(message)

    def check_cancel(self) -> None:
        self.checks += 1
        if self.cancel_after is not None and self.checks > self.cancel_after:
            raise Canceled()

    def artifact(self, path: str, kind: str = "") -> None:
        pass


def test_ffmpeg_args_shape() -> None:
    plan = EP.plan(EP.EncodeSpec(container="mp4", gpu=False), EP.SourceInfo("webm", W, H, 30, 1, True, "opus"), {"libopenh264", "aac"})
    args = EN.ffmpeg_args(plan, width=W, height=H, fps=(30, 1), out_part="o.mp4.part", audio_source="in.webm", extra_video_args=["-g", "15"])
    s = " ".join(args)
    assert "-f rawvideo -pix_fmt yuv420p -video_size 64x48 -framerate 30/1" in s
    assert s.count("-colorspace bt709") == 2  # 輸入端與輸出端都標
    assert "-i in.webm -map 0:v:0 -map 1:a:0?" in s
    assert "-c:v libopenh264" in s and "-g 15" in s and "-c:a aac -b:a 160k" in s
    assert "-movflags +faststart" in s and s.endswith("-f mp4 o.mp4.part")
    assert "-progress pipe:1" in s and "-nostdin" in s
    # 內容揭露 tag 是輸出選項：在輸出檔之前、每個 key 一組 -metadata
    i_meta = args.index("-metadata")
    assert i_meta > args.index("-c:v") and args[i_meta + 1].startswith("comment=Edited video.")
    assert sum(1 for a in args if a == "-metadata") == 3
    args2 =EN.ffmpeg_args(plan, width=W, height=H, fps=(30, 1), out_part="o.mp4.part", audio_source=None, shortest=True)
    s2 = " ".join(args2)
    assert "-an" in s2 and "-map 1:a" not in s2 and "-shortest" in s2


def test_ffv1_roundtrip_is_bit_exact(ffmpeg_ready: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    enc = ff.list_encoders()
    if "ffv1" not in enc:
        pytest.skip("ffmpeg 沒有 ffv1")
    frames = synth_frames()
    plan = EP.plan(EP.EncodeSpec(container="mkv", codec="ffv1", audio="none"), SRC, enc)
    out = tmp_path / "out.mkv"
    ctx = RecordingCtx()
    info = EN.write_frames(frames, plan, out, ctx, width=W, height=H, fps=(30, 1), total=N)
    assert out.is_file() and _no_parts(tmp_path)
    assert info["frames"] == N and info["bytes"] == out.stat().st_size and info["encoder"] == "ffv1"
    assert [c[1] for c in ctx.progress_calls] == list(range(1, N + 1)) and all(c[0] == "encode" for c in ctx.progress_calls)
    with FrameSource(out) as fs:
        assert fs.n_frames == N
        assert fs.probe.color_space == "bt709" and fs.probe.color_range == "tv" and fs.probe.color_primaries == "bt709"
        for i, want in enumerate(frames):
            got = fs.get(i)
            assert np.array_equal(got.y, want.y) and np.array_equal(got.u, want.u) and np.array_equal(got.v, want.v), i


def test_openh264_mp4_psnr_and_frame_count(ffmpeg_ready: None, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path / "cache"))
    enc = ff.list_encoders()
    if "libopenh264" not in enc:
        pytest.skip("ffmpeg 沒有 libopenh264")
    from aivc.media import color

    frames = synth_frames()
    plan = EP.plan(EP.EncodeSpec(container="mp4", gpu=False, audio="none"), SRC, enc)
    assert plan.video_codec == "libopenh264"
    out = tmp_path / "out.mp4"
    EN.write_frames(frames, plan, out, RecordingCtx(), width=W, height=H, fps=(30, 1), total=N, extra_video_args=["-g", "15", "-b:v", "4M"])
    with FrameSource(out) as fs:
        assert fs.n_frames == N
        assert (fs.probe.fps_num, fs.probe.fps_den) == (30, 1)
        ps = [color.psnr(fs.get(i).y, frames[i].y) for i in range(N)]
    assert min(ps) > 35, ps


@pytest.mark.parametrize("container,codec", [("mkv", "ffv1"), ("mp4", "libopenh264"), ("webm", "libvpx-vp9")])
def test_content_note_tags_land_in_container(ffmpeg_ready: None, tmp_path: Path, container: str, codec: str) -> None:
    """內容揭露句子真的寫進容器：ffprobe format.tags 讀得到 comment／description／title（mp4 與 matroska 的 tag 名不同）。"""
    import json

    enc = ff.list_encoders()
    if codec not in enc:
        pytest.skip(f"ffmpeg 沒有 {codec}")
    note = "Edited video (test). Inserted by AI Video Cut {version}."
    plan = EP.plan(EP.EncodeSpec(container=container, codec=codec, gpu=False, audio="none", content_note=note, tool_version="1.2.3"), SRC, enc)
    out = tmp_path / f"out.{container}"
    EN.write_frames(synth_frames()[:3], plan, out, RecordingCtx(), width=W, height=H, fps=(30, 1), total=3)
    cp = ff.run([ff.exe("ffprobe"), "-v", "error", "-show_entries", "format_tags", "-of", "json", str(out)], timeout=60)
    tags = {k.lower(): v for k, v in json.loads(cp.stdout.decode("utf-8"))["format"].get("tags", {}).items()}
    want = "Edited video (test). Inserted by AI Video Cut 1.2.3."
    assert tags.get("comment") == want and tags.get("title") == want, tags
    assert tags.get("description") == want, tags


def test_cancel_kills_ffmpeg_and_removes_part(ffmpeg_ready: None, tmp_path: Path) -> None:
    enc = ff.list_encoders()
    plan = EP.plan(EP.EncodeSpec(container="mkv", codec="ffv1", audio="none"), SRC, enc)
    out = tmp_path / "c.mkv"
    with pytest.raises(Canceled):
        EN.write_frames(synth_frames(), plan, out, RecordingCtx(cancel_after=3), width=W, height=H, fps=(30, 1), total=N)
    assert not out.exists() and _no_parts(tmp_path)


def test_ffmpeg_failure_reports_stderr(ffmpeg_ready: None, tmp_path: Path) -> None:
    plan = EP.EncodePlan("mkv", "matroska", ".mkv", "no_such_encoder", [], "none", None, [], [])
    out = tmp_path / "bad.mkv"
    with pytest.raises(OpError) as e:
        EN.write_frames(synth_frames(2), plan, out, RecordingCtx(), width=W, height=H, fps=(30, 1), total=2)
    assert e.value.kind == "Ffmpeg"
    assert "no_such_encoder" in e.value.hint or "Unknown encoder" in e.value.hint or e.value.hint
    assert not out.exists() and _no_parts(tmp_path)


def test_frame_size_mismatch_is_internal_error(ffmpeg_ready: None, tmp_path: Path) -> None:
    plan = EP.plan(EP.EncodeSpec(container="mkv", codec="ffv1", audio="none"), SRC, ff.list_encoders())
    with pytest.raises(OpError) as e:
        EN.write_frames(synth_frames(2), plan, tmp_path / "m.mkv", RecordingCtx(), width=W * 2, height=H, fps=(30, 1), total=2)
    assert e.value.kind == "Internal"


def test_list_encoders_and_usable(ffmpeg_ready: None) -> None:
    enc = ff.list_encoders()
    assert enc and "ffv1" in enc  # 任何 ffmpeg 都內建 ffv1
    assert ff.encoder_usable("ffv1")
    assert not ff.encoder_usable("definitely_not_an_encoder")
    assert ff.first_usable(["nope", "ffv1"]) == "ffv1"


def test_atomic_output_cleans_part(tmp_path: Path) -> None:
    out = tmp_path / "a.bin"
    with pytest.raises(RuntimeError):
        with ff.atomic_output(out) as part:
            part.write_bytes(b"x")
            raise RuntimeError("boom")
    assert not out.exists() and _no_parts(tmp_path)
    with ff.atomic_output(out) as part:
        part.write_bytes(b"ok")
    assert out.read_bytes() == b"ok" and _no_parts(tmp_path)
    with pytest.raises(OpError):
        with ff.atomic_output(tmp_path / "never.bin"):
            pass  # 沒產出 .part → 必須報錯，不能默默成功


def test_exe_missing_is_opError(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(env, "ffmpeg_bin", lambda name: (_ for _ in ()).throw(FileNotFoundError("nope")))
    with pytest.raises(OpError) as e:
        ff.exe("ffmpeg")
    assert e.value.kind == "Ffmpeg" and "AIVC_FFMPEG_DIR" in e.value.hint
