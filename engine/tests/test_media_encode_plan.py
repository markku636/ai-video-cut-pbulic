"""encode_plan.plan() golden 測試（fixtures/media/export-plan.golden.json；AIVC_UPDATE_GOLDEN=1 重生）。"""
from __future__ import annotations

import json
import os
from dataclasses import asdict
from pathlib import Path
from typing import Any

import pytest

from aivc.media import encode_plan as EP
from aivc.ops import OpError

GOLDEN = Path(__file__).parent / "fixtures" / "media" / "export-plan.golden.json"

FULL = frozenset({"libvpx-vp9", "hevc_nvenc", "h264_nvenc", "av1_nvenc", "libopenh264", "prores_ks", "ffv1", "aac", "libopus", "opus"})
CPU_ONLY = frozenset(FULL - {"hevc_nvenc", "h264_nvenc", "av1_nvenc"})

SRC_WEBM_OPUS = EP.SourceInfo("webm", 1280, 720, 30, 1, True, "opus", "bt709")  # 範例影片
SRC_MP4_AAC = EP.SourceInfo("mp4", 1920, 1080, 30000, 1001, True, "aac", "bt709")
SRC_MP4_SILENT = EP.SourceInfo("mp4", 1920, 1080, 25, 1, False, None, "bt709")
SRC_SD_601 = EP.SourceInfo("mov", 720, 480, 30000, 1001, True, "pcm_s16le", "bt601")

CASES: list[tuple[str, EP.EncodeSpec, EP.SourceInfo, frozenset[str]]] = [
    ("webm_default_vp9_copy_opus", EP.EncodeSpec(), SRC_WEBM_OPUS, FULL),
    ("webm_quality_override", EP.EncodeSpec(quality=30), SRC_WEBM_OPUS, FULL),
    ("mp4_default_hevc_nvenc_aac_dropped", EP.EncodeSpec(container="mp4"), SRC_WEBM_OPUS, FULL),
    ("mp4_cpu_only_encoders_fallback_openh264", EP.EncodeSpec(container="mp4"), SRC_WEBM_OPUS, CPU_ONLY),
    ("mp4_gpu_false_openh264", EP.EncodeSpec(container="mp4", gpu=False), SRC_WEBM_OPUS, FULL),
    ("mp4_explicit_h264_nvenc_cq23", EP.EncodeSpec(container="mp4", codec="h264_nvenc", quality=23), SRC_WEBM_OPUS, FULL),
    ("mp4_explicit_hevc_nvenc_unavailable_note", EP.EncodeSpec(container="mp4", codec="hevc_nvenc"), SRC_WEBM_OPUS, CPU_ONLY),
    ("mp4_from_mp4_aac_copy", EP.EncodeSpec(container="mp4"), SRC_MP4_AAC, FULL),
    ("mp4_silent_source", EP.EncodeSpec(container="mp4"), SRC_MP4_SILENT, FULL),
    ("mp4_audio_none", EP.EncodeSpec(container="mp4", audio="none"), SRC_MP4_AAC, FULL),
    ("mp4_audio_encode_forced", EP.EncodeSpec(container="mp4", audio="encode"), SRC_MP4_AAC, FULL),
    ("mp4_container_from_out_path", EP.EncodeSpec(out_path=r"D:\out\final.MP4"), SRC_WEBM_OPUS, FULL),
    ("webm_from_mp4_aac_reencode_libopus", EP.EncodeSpec(container="webm"), SRC_MP4_AAC, FULL),
    ("webm_no_libopus_falls_to_opus", EP.EncodeSpec(container="webm"), SRC_MP4_AAC, frozenset(FULL - {"libopus"})),
    ("mov_default_prores_ks", EP.EncodeSpec(container="mov"), SRC_WEBM_OPUS, FULL),
    ("mov_sd_601_pcm_copy", EP.EncodeSpec(), SRC_SD_601, FULL),
    ("mkv_default_ffv1_copy_anything", EP.EncodeSpec(container="mkv"), SRC_WEBM_OPUS, FULL),
    ("mkv_explicit_vp9", EP.EncodeSpec(container="mkv", codec="libvpx-vp9"), SRC_WEBM_OPUS, FULL),
    ("mkv_explicit_hevc_nvenc", EP.EncodeSpec(container="mkv", codec="hevc_nvenc"), SRC_MP4_AAC, FULL),
]


GOLDEN_TOOL_VERSION = "0.0.0-golden"  # 內容揭露句子裡的版本：釘死，發版不必重生 golden


def _run_all() -> dict[str, Any]:
    """核心的編碼計畫（外掛的掛勾暫停：外掛可以換掉預設的內容揭露句子，golden 只記核心的樣子）。"""
    from dataclasses import replace

    from aivc import hooks

    out: dict[str, Any] = {}
    with hooks.suspended():
        for name, spec, src, enc in CASES:
            spec = replace(spec, tool_version=GOLDEN_TOOL_VERSION)
            out[name] = {"spec": asdict(spec), "source": asdict(src), "encoders": sorted(enc), "plan": EP.plan(spec, src, enc).to_json()}
    return out


def test_golden() -> None:
    got = _run_all()
    if os.environ.get("AIVC_UPDATE_GOLDEN") == "1":
        GOLDEN.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN.write_text(json.dumps({"version": 1, "cases": got}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        pytest.skip("golden 已重生")
    assert GOLDEN.is_file(), "缺 golden：AIVC_UPDATE_GOLDEN=1 pytest tests/test_media_encode_plan.py"
    want = json.loads(GOLDEN.read_text(encoding="utf-8"))
    assert want["version"] == 1
    assert set(want["cases"]) == set(got), "案例清單變了：更新 golden"
    for name in got:
        assert got[name] == want["cases"][name], name


def test_plan_invariants() -> None:
    for name, spec, src, enc in CASES:
        p = EP.plan(spec, src, enc)
        assert p.input_pix_fmt == "yuv420p", name
        assert "-color_range" in p.color_args and "tv" in p.color_args, name
        assert p.video_codec in enc, name
        assert p.gpu == (p.video_codec.endswith("_nvenc")), name
        assert p.deterministic != p.gpu or not p.gpu, name
        if p.audio_mode == "copy":
            assert p.audio_args == ["-c:a", "copy"] and p.audio_codec == src.audio_codec, name
        if p.audio_mode == "encode":
            assert p.audio_args[:2] == ["-c:a", p.audio_codec], name
            assert p.audio_codec in enc, name
        if p.audio_mode == "none":
            assert p.audio_args == [] and p.audio_codec is None, name
        if spec.audio == "auto" and p.audio_mode == "encode":
            assert any("音軌重新編碼" in d for d in p.dropped), name  # 使用者要看到「音訊被動了」
        if p.container == "webm":
            assert p.audio_codec in (None, "opus", "vorbis", "libopus"), name  # webm 絕不能塞 aac


def test_specific_expectations() -> None:
    p = EP.plan(EP.EncodeSpec(), SRC_WEBM_OPUS, FULL)
    assert p.video_codec == "libvpx-vp9" and p.video_args[:4] == ["-crf", "16", "-b:v", "0"] and p.audio_mode == "copy"
    p = EP.plan(EP.EncodeSpec(container="mp4"), SRC_WEBM_OPUS, FULL)
    assert p.video_codec == "hevc_nvenc" and "-cq" in p.video_args and p.audio_codec == "aac" and p.dropped
    p = EP.plan(EP.EncodeSpec(container="mp4"), SRC_WEBM_OPUS, CPU_ONLY)
    assert p.video_codec == "libopenh264" and p.deterministic and p.notes
    p = EP.plan(EP.EncodeSpec(), SRC_SD_601, FULL)
    assert p.video_codec == "prores_ks" and p.audio_mode == "copy" and "smpte170m" in p.color_args


def test_content_note_metadata_default_on() -> None:
    """每個渲染計畫預設帶內容揭露 tag（comment/description/title 同一句、含引擎版本）；proxy 用 "" 關掉；profile 可換句子；
    外掛可以換掉**預設**句子（hooks content-note，最後登記的生效），明確給的句子不受影響。"""
    from aivc import hooks
    from aivc._version import __version__

    with hooks.suspended():
        for name, spec, src, enc in CASES:
            p = EP.plan(spec, src, enc)
            md = p.metadata_args
            assert md[0::2] == ["-metadata"] * 3, name
            keys = [kv.split("=", 1)[0] for kv in md[1::2]]
            vals = {kv.split("=", 1)[1] for kv in md[1::2]}
            assert keys == ["comment", "description", "title"], name
            assert vals == {f"Edited video. Content altered by AI Video Cut {__version__}."}, name
        custom = "Edited by a profile. AI Video Cut {version}."
        p = EP.plan(EP.EncodeSpec(container="mp4", content_note=custom, tool_version="9.9.9"), SRC_MP4_AAC, FULL)
        assert "comment=Edited by a profile. AI Video Cut 9.9.9." in p.metadata_args
        assert "title=Edited by a profile. AI Video Cut 9.9.9." in p.metadata_args
        assert EP.plan(EP.EncodeSpec(container="mp4", content_note=""), SRC_MP4_AAC, FULL).metadata_args == []
        # 外掛登記的預設句子
        hooks.add("content-note", "Edited by plugin {version}.", owner="test")
        hooks.add("content-note", "Edited by later plugin {version}.", owner="test")
        p = EP.plan(EP.EncodeSpec(container="mp4", tool_version="9.9.9"), SRC_MP4_AAC, FULL)
        assert "comment=Edited by later plugin 9.9.9." in p.metadata_args
        p = EP.plan(EP.EncodeSpec(container="mp4", content_note=custom, tool_version="9.9.9"), SRC_MP4_AAC, FULL)
        assert "comment=Edited by a profile. AI Video Cut 9.9.9." in p.metadata_args


def test_errors() -> None:
    with pytest.raises(OpError) as e:
        EP.plan(EP.EncodeSpec(container="mp4", codec="libx264"), SRC_WEBM_OPUS, FULL)  # 沒打包 libx264（GPL）
    assert e.value.kind == "Invalid"
    with pytest.raises(OpError) as e:
        EP.plan(EP.EncodeSpec(container="webm", codec="libopenh264"), SRC_WEBM_OPUS, FULL)
    assert e.value.kind == "Invalid"
    with pytest.raises(OpError) as e:
        EP.plan(EP.EncodeSpec(container="webm", codec="av1_nvenc"), SRC_WEBM_OPUS, CPU_ONLY)  # webm 沒有 h264 fallback
    assert e.value.kind == "Invalid"
    with pytest.raises(OpError) as e:
        EP.plan(EP.EncodeSpec(container="avi"), SRC_WEBM_OPUS, FULL)
    assert e.value.kind == "Invalid"
    with pytest.raises(OpError) as e:
        EP.plan(EP.EncodeSpec(container="mkv", codec="ffv1"), SRC_WEBM_OPUS, frozenset({"libopenh264"}))
    assert e.value.kind == "Ffmpeg"
    with pytest.raises(OpError) as e:
        EP.plan(EP.EncodeSpec(container="mp4"), SRC_WEBM_OPUS, frozenset({"ffv1"}))  # 預設階梯全空
    assert e.value.kind == "Ffmpeg"
    with pytest.raises(OpError) as e:
        EP.plan(EP.EncodeSpec(container="webm"), SRC_MP4_AAC, frozenset({"libvpx-vp9"}))  # 沒有 opus 編碼器
    assert e.value.kind == "Ffmpeg"


def test_helpers() -> None:
    assert EP.container_of(r"C:\a b\x.webm") == "webm"
    assert EP.container_of("x.MKV") == "mkv"
    assert EP.container_of("x.m4v") == "mp4"
    assert EP.container_of("noext", "matroska,webm") == "mkv"
    assert EP.container_of("noext.webm", "matroska,webm") == "webm"
    assert EP.container_of(None, "mov,mp4,m4a,3gp,3g2,mj2") == "mp4"
    assert EP.container_of(None, None) == "mp4"
    assert EP.video_bitrate_kbps(1280, 720, 30, 1) == 4147
    assert EP.video_bitrate_kbps(64, 48, 30, 1) == 1500  # 下限
    assert EP.video_bitrate_kbps(7680, 4320, 60, 1) == 40000  # 上限


def test_source_info_from_probe_like() -> None:
    class P:
        path = r"D:\v\clip.webm"
        container = "matroska,webm"
        width, height, fps_num, fps_den = 1280, 720, 30, 1
        has_audio, audio_codec, matrix_assumed = True, "opus", "bt709"

    assert EP.SourceInfo.from_probe(P()) == SRC_WEBM_OPUS
