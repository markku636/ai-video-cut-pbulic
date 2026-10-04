"""H.264 fallback 階梯（h264_nvenc → libopenh264 → h264_videotoolbox → libx264 → mpeg4）。

為什麼要這支：以前 proxy 與 mp4 匯出只認 NVENC 與 libopenh264，而 Homebrew 與 Ubuntu 的 ffmpeg 都沒有 openh264，
macOS／Linux 上每支匯入的影片都建不出 proxy；CI 沒抓到，是因為唯一跑真 proxy 的測試要 gitignored 的範例影片、到處都 skip。

兩層：
1. 純函式：用三種真實世界的編碼器清單（Windows 內建 LGPL build、Homebrew、Ubuntu apt）＋「只有內建編碼器」的極簡 build，
   鎖住 `probe_chain` 的試編狀態與 `plan()` 的選擇、notes、dropped、參數 —— 同一份清單永遠得到同一個結果。
2. 整合：用 PATH 上的 ffmpeg 以 lavfi testsrc + sine 現做 2 秒片，跑真的 `aivc proxy`，檢查 proxy 幀數與畫質。
   macOS／Linux 的 CI job 會裝 ffmpeg，那裡**不准 skip**（找不到 ffmpeg 直接 fail），否則又回到「測試都綠、使用者全掛」。
"""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

import pytest

from aivc.media import encode_plan as EP
from aivc.ops import OpError

# ---------------------------------------------------------------- 真實世界的編碼器清單（只列與決策有關的，外加幾個干擾項）

# 內建的 LGPL ffmpeg（Windows 安裝檔；2026-09 實際 `ffmpeg -encoders` 的子集）：有 NVENC 與 openh264，刻意沒有 libx264
WINDOWS_BUNDLE = frozenset({
    "aac", "aac_mf", "av1_nvenc", "ffv1", "h264_amf", "h264_mf", "h264_nvenc", "h264_qsv", "hevc_nvenc",
    "libopenh264", "libopus", "libvpx-vp9", "mpeg4", "opus", "prores_ks",
})
# Homebrew `ffmpeg`（macOS）：VideoToolbox + x264/x265，沒有 openh264、沒有 NVENC
HOMEBREW = frozenset({
    "aac", "alac", "ffv1", "h264_videotoolbox", "hevc_videotoolbox", "prores_videotoolbox", "libx264", "libx265",
    "libvpx-vp9", "libsvtav1", "libopus", "opus", "prores_ks", "mpeg4",
})
# Ubuntu 24.04 apt `ffmpeg`：有 NVENC（ffnvcodec）與 libx264，沒有 openh264
UBUNTU = frozenset({
    "aac", "ffv1", "h264_nvenc", "hevc_nvenc", "av1_nvenc", "h264_vaapi", "h264_qsv", "h264_v4l2m2m", "libx264", "libx265",
    "libvpx-vp9", "libaom-av1", "libopus", "opus", "prores_ks", "mpeg4",
})
# 什麼外部函式庫都沒編進去的 ffmpeg：只剩內建編碼器
MINIMAL = frozenset({"aac", "ffv1", "mpeg4", "opus", "prores_ks"})

SRC = EP.SourceInfo("mp4", 1280, 720, 30, 1, True, "aac", "bt709")  # 音軌可直接複製 → dropped 只反映視訊的決策

ARGS = {
    "h264_nvenc": ["-preset", "p6", "-tune", "hq", "-rc", "vbr", "-cq", "19", "-b:v", "0", "-pix_fmt", "yuv420p"],
    "libopenh264": ["-b:v", "4147k", "-pix_fmt", "yuv420p"],
    "h264_videotoolbox": ["-b:v", "4147k", "-allow_sw", "1", "-pix_fmt", "yuv420p"],
    "libx264": ["-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p"],
    "mpeg4": ["-b:v", "8294k", "-pix_fmt", "yuv420p"],
}


def _prober(works: set[str], calls: list[str] | None = None) -> Callable[[str], bool]:
    """假的 ffmpeg.encoder_usable：只有 works 裡的編碼器試編成功；calls 記錄被試編過誰（驗證不多開子行程）。"""

    def usable(name: str) -> bool:
        if calls is not None:
            calls.append(name)
        return name in works

    return usable


ALL_SOFTWARE = {"libopenh264", "libx264", "mpeg4"}

# (名稱, 清單, 試編會成功的, gpu) → (選到的, 每個候選狀態, notes, dropped)
SCENARIOS: list[tuple[str, frozenset[str], set[str], bool, str, list[str], list[str], list[str]]] = [
    (
        "windows_bundle_nvidia", WINDOWS_BUNDLE, {"h264_nvenc", *ALL_SOFTWARE}, True,
        "h264_nvenc", ["usable", "untried", "untried", "untried", "untried"], [], [],
    ),
    (
        "windows_bundle_no_gpu", WINDOWS_BUNDLE, ALL_SOFTWARE, True,
        "libopenh264", ["unusable", "usable", "untried", "untried", "untried"],
        ["H.264 自動：h264_nvenc 不可用 → libopenh264"], [],
    ),
    (
        "homebrew_apple_silicon", HOMEBREW, {"h264_videotoolbox", *ALL_SOFTWARE}, True,
        "h264_videotoolbox", ["unlisted", "unlisted", "usable", "untried", "untried"],
        ["H.264 自動：h264_nvenc、libopenh264 不可用 → h264_videotoolbox"], [],
    ),
    (
        # GitHub 的 macOS runner 是虛擬機：VideoToolbox 有列但開不了硬體 session
        "homebrew_vm_no_videotoolbox", HOMEBREW, ALL_SOFTWARE, True,
        "libx264", ["unlisted", "unlisted", "unusable", "usable", "untried"],
        ["H.264 自動：h264_nvenc、libopenh264、h264_videotoolbox 不可用 → libx264"], [],
    ),
    (
        "homebrew_gpu_off", HOMEBREW, {"h264_videotoolbox", *ALL_SOFTWARE}, False,
        "libx264", ["gpuOff", "unlisted", "gpuOff", "usable", "untried"],
        ["H.264 自動：h264_nvenc（未啟用 GPU）、libopenh264、h264_videotoolbox（未啟用 GPU） 不可用 → libx264"], [],
    ),
    (
        "ubuntu_nvidia", UBUNTU, {"h264_nvenc", *ALL_SOFTWARE}, True,
        "h264_nvenc", ["usable", "untried", "untried", "untried", "untried"], [], [],
    ),
    (
        # apt 的 ffmpeg 一定帶 NVENC，但沒有 NVIDIA 卡／驅動時試編失敗
        "ubuntu_no_gpu", UBUNTU, ALL_SOFTWARE, True,
        "libx264", ["unusable", "unlisted", "unlisted", "usable", "untried"],
        ["H.264 自動：h264_nvenc、libopenh264、h264_videotoolbox 不可用 → libx264"], [],
    ),
    (
        "minimal_builtin_only", MINIMAL, ALL_SOFTWARE, True,
        "mpeg4", ["unlisted", "unlisted", "unlisted", "unlisted", "usable"],
        ["H.264 自動：h264_nvenc、libopenh264、h264_videotoolbox、libx264 不可用 → mpeg4"], [EP.MPEG4_DROPPED],
    ),
]


def test_chain_order_is_the_contract() -> None:
    assert EP.H264_CHAIN == ("h264_nvenc", "libopenh264", "h264_videotoolbox", "libx264", "mpeg4")
    assert EP.CONTAINERS["mp4"]["default"] == ["hevc_nvenc", *EP.H264_CHAIN]
    assert EP.HARDWARE_ENCODERS == {"hevc_nvenc", "h264_nvenc", "av1_nvenc", "h264_videotoolbox"}


@pytest.mark.parametrize(
    ("name", "listed", "works", "gpu", "want", "statuses", "notes", "dropped"), SCENARIOS, ids=[s[0] for s in SCENARIOS]
)
def test_proxy_chain_per_platform(
    name: str, listed: frozenset[str], works: set[str], gpu: bool, want: str, statuses: list[str], notes: list[str], dropped: list[str]
) -> None:
    calls: list[str] = []
    usable, report = EP.probe_chain(listed, _prober(works, calls), gpu=gpu)
    assert [r["codec"] for r in report] == list(EP.H264_CHAIN)
    assert [r["status"] for r in report] == statuses, name
    # 只試編「有列、且還沒找到能用的」候選：沒列出的不開子行程，找到之後也不再試
    assert calls == [r["codec"] for r in report if r["status"] in ("usable", "unusable")], name

    plan = EP.plan(EP.EncodeSpec(container="mp4", codec=EP.H264_ALIAS, quality=19, gpu=gpu), SRC, usable)
    assert plan.video_codec == want, name
    assert plan.video_args == ARGS[want], name
    assert plan.notes == notes, name
    assert plan.dropped == dropped, name
    assert plan.gpu == (want in ("h264_nvenc", "h264_videotoolbox")), name
    assert plan.audio_mode == "copy" and plan.format == "mp4"


@pytest.mark.parametrize("name", [s[0] for s in SCENARIOS])
def test_choice_is_deterministic_given_the_encoder_list(name: str) -> None:
    _, listed, works, gpu, *_ = next(s for s in SCENARIOS if s[0] == name)
    usable, _ = EP.probe_chain(listed, _prober(works), gpu=gpu)
    spec = EP.EncodeSpec(container="mp4", codec=EP.H264_ALIAS, quality=19, gpu=gpu)
    want = EP.plan(spec, SRC, usable).to_json()
    # 清單的順序／型別不影響結果（set、排序後的 list、反序 list）
    for enc in (set(usable), sorted(usable), sorted(usable, reverse=True), frozenset(usable)):
        assert EP.plan(spec, SRC, enc).to_json() == want


# ---------------------------------------------------------------- mp4 匯出（codec 未指定 → hevc_nvenc + H.264 階梯）

EXPORT_CASES: list[tuple[str, frozenset[str], bool, str, list[str], list[str]]] = [
    ("windows_bundle_no_gpu", WINDOWS_BUNDLE - EP.HARDWARE_ENCODERS, True, "libopenh264", ["預設 hevc_nvenc 不可用 → libopenh264"], []),
    ("homebrew_apple_silicon", HOMEBREW, True, "h264_videotoolbox", ["預設 hevc_nvenc 不可用 → h264_videotoolbox"], []),
    ("homebrew_no_gpu_flag", HOMEBREW, False, "libx264", ["預設 hevc_nvenc 不可用 → libx264"], []),
    ("ubuntu_no_gpu", UBUNTU - EP.HARDWARE_ENCODERS, True, "libx264", ["預設 hevc_nvenc 不可用 → libx264"], []),
    ("minimal_builtin_only", MINIMAL, True, "mpeg4", ["預設 hevc_nvenc 不可用 → mpeg4"], [EP.MPEG4_DROPPED]),
]


@pytest.mark.parametrize(("name", "enc", "gpu", "want", "notes", "dropped"), EXPORT_CASES, ids=[c[0] for c in EXPORT_CASES])
def test_mp4_export_default_ladder(name: str, enc: frozenset[str], gpu: bool, want: str, notes: list[str], dropped: list[str]) -> None:
    plan = EP.plan(EP.EncodeSpec(container="mp4", gpu=gpu), SRC, enc)
    assert plan.video_codec == want, name
    assert plan.notes == notes and plan.dropped == dropped, name
    if want == "libx264":
        assert plan.video_args == ["-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"]  # 匯出預設 crf 18
    assert plan.deterministic is (want == "libopenh264")
    assert plan.gpu is (want in EP.HARDWARE_ENCODERS)


def test_render_plan_records_mpeg4_degradation_in_json() -> None:
    d = EP.plan(EP.EncodeSpec(out_path="/tmp/out.mp4"), SRC, MINIMAL).to_json()
    assert d["video_codec"] == "mpeg4" and EP.MPEG4_DROPPED in d["dropped"] and d["notes"]


# ---------------------------------------------------------------- 點名編碼器

def test_explicit_libx264_on_homebrew() -> None:
    p = EP.plan(EP.EncodeSpec(container="mp4", codec="libx264"), SRC, HOMEBREW)
    assert p.video_codec == "libx264" and p.notes == [] and p.dropped == []
    p = EP.plan(EP.EncodeSpec(container="mov", codec="libx264", quality=22), SRC, HOMEBREW)
    assert p.video_codec == "libx264" and "22" in p.video_args


def test_explicit_libx264_on_lgpl_bundle_is_invalid() -> None:
    with pytest.raises(OpError) as e:
        EP.plan(EP.EncodeSpec(container="mp4", codec="libx264"), SRC, WINDOWS_BUNDLE)
    assert e.value.kind == "Invalid" and "LGPL" in str(e.value)


def test_explicit_hardware_unusable_walks_the_chain() -> None:
    # Mac 虛擬機：點名 VideoToolbox，但試編失敗（不在集合裡）→ libx264
    p = EP.plan(EP.EncodeSpec(container="mp4", codec="h264_videotoolbox"), SRC, HOMEBREW - {"h264_videotoolbox"})
    assert p.video_codec == "libx264"
    assert p.notes == ["h264_videotoolbox 不可用（這台機器的 ffmpeg 沒有／不能用）→ libx264"]
    # Linux 沒卡：點名 hevc_nvenc → libx264
    p = EP.plan(EP.EncodeSpec(container="mp4", codec="hevc_nvenc"), SRC, UBUNTU - EP.HARDWARE_ENCODERS)
    assert p.video_codec == "libx264" and p.notes == ["hevc_nvenc 不可用（這台機器的 ffmpeg 沒有／不能用）→ libx264"]
    # --no-gpu：點名 NVENC 也不選，Windows 內建 build 維持以前的 libopenh264
    p = EP.plan(EP.EncodeSpec(container="mp4", codec="h264_nvenc", gpu=False), SRC, WINDOWS_BUNDLE)
    assert p.video_codec == "libopenh264" and p.notes == ["h264_nvenc 不可用（未啟用 GPU）→ libopenh264"]
    # 極簡 build：退到 mpeg4 也要記 dropped
    p = EP.plan(EP.EncodeSpec(container="mkv", codec="hevc_nvenc"), SRC, MINIMAL)
    assert p.video_codec == "mpeg4" and p.dropped[0] == EP.MPEG4_DROPPED


def test_explicit_mpeg4_is_a_choice_not_a_degradation() -> None:
    p = EP.plan(EP.EncodeSpec(container="mp4", codec="mpeg4"), SRC, MINIMAL)
    assert p.video_codec == "mpeg4" and p.dropped == [] and p.notes == []


def test_no_h264_at_all_raises_ffmpeg() -> None:
    with pytest.raises(OpError) as e:
        EP.plan(EP.EncodeSpec(container="mp4", codec=EP.H264_ALIAS), SRC, frozenset({"aac", "ffv1"}))
    assert e.value.kind == "Ffmpeg" and "brew install ffmpeg" in e.value.hint
    with pytest.raises(OpError) as e:
        EP.plan(EP.EncodeSpec(container="mp4", codec="h264_nvenc"), SRC, frozenset({"aac", "ffv1"}))
    assert e.value.kind == "Ffmpeg"


def test_h264_alias_rejects_webm() -> None:
    with pytest.raises(OpError) as e:
        EP.plan(EP.EncodeSpec(container="webm", codec=EP.H264_ALIAS), SRC, HOMEBREW)
    assert e.value.kind == "Invalid"


def test_probe_chain_drops_untried_hardware() -> None:
    # 找到 openh264 之後就停：清單裡的 h264_videotoolbox 沒試過，不能留在集合裡被當成能用
    listed = frozenset({"libopenh264", "h264_videotoolbox", "hevc_nvenc", "aac"})
    usable, report = EP.probe_chain(listed, _prober({"libopenh264"}))
    assert "h264_videotoolbox" not in usable and "libopenh264" in usable
    assert "hevc_nvenc" in usable  # 階梯外的編碼器不歸 probe_chain 管（render 另外試編 NVENC）
    assert [r["status"] for r in report] == ["unlisted", "usable", "untried", "untried", "untried"]


@pytest.mark.parametrize(
    ("listed", "works", "gpu", "want_calls", "gone"),
    [
        # Mac 虛擬機：VideoToolbox 有列但開不了 session → 匯出計畫的集合裡不能有它（以前 render 只試編 NVENC，會沒試就選到）
        (HOMEBREW, ALL_SOFTWARE, True, ["h264_videotoolbox"], {"h264_videotoolbox"}),
        # 真的 Apple Silicon：試編成功就留著
        (HOMEBREW, {"h264_videotoolbox", *ALL_SOFTWARE}, True, ["h264_videotoolbox"], set()),
        # Windows 內建 build 有卡：NVENC 三個都試、都留
        (WINDOWS_BUNDLE, {"h264_nvenc", "hevc_nvenc", "av1_nvenc", *ALL_SOFTWARE}, True, ["av1_nvenc", "h264_nvenc", "hevc_nvenc"], set()),
        # --no-gpu：一個都不試（省子行程），硬體編碼器全剔除
        (UBUNTU, ALL_SOFTWARE, False, [], {"h264_nvenc", "hevc_nvenc", "av1_nvenc"}),
    ],
    ids=["homebrew_vm", "homebrew_apple_silicon", "windows_bundle_nvidia", "ubuntu_gpu_off"],
)
def test_render_usable_encoders_probes_every_hardware_encoder(
    monkeypatch: pytest.MonkeyPatch, listed: frozenset[str], works: set[str], gpu: bool, want_calls: list[str], gone: set[str]
) -> None:
    from aivc.media import ffmpeg as ff
    from aivc.ops import render as RD

    calls: list[str] = []
    monkeypatch.setattr(ff, "list_encoders", lambda: listed)
    monkeypatch.setattr(ff, "encoder_usable", _prober(works, calls))
    enc = RD.usable_encoders(gpu)
    assert calls == want_calls  # 只試編有列的硬體編碼器、順序固定
    assert enc == set(listed) - gone
    # 接到 plan：Mac 虛擬機的 mp4 匯出落在 libx264，而不是沒試編過的 VideoToolbox
    if listed is HOMEBREW and not gone:
        assert EP.plan(EP.EncodeSpec(container="mp4", gpu=gpu), SRC, enc).video_codec == "h264_videotoolbox"
    elif listed is HOMEBREW:
        assert EP.plan(EP.EncodeSpec(container="mp4", gpu=gpu), SRC, enc).video_codec == "libx264"


# ---------------------------------------------------------------- 整合：真的 ffmpeg、真的 proxy op


def _must_run() -> bool:
    """macOS／Linux 的 CI job 有裝 ffmpeg：那裡 skip 等於沒測，直接 fail。"""
    return os.environ.get("CI", "").lower() in ("1", "true") and sys.platform in ("darwin", "linux")


def _need(reason: str) -> None:
    if _must_run():
        pytest.fail(f"CI（{sys.platform}）不准略過：{reason}")
    pytest.skip(reason)


@pytest.fixture(scope="module")
def path_ffmpeg_dir() -> Path:
    exe = shutil.which("ffmpeg")
    probe = shutil.which("ffprobe")
    if not exe or not probe:
        _need("PATH 上沒有 ffmpeg／ffprobe")
    d = Path(exe).resolve().parent  # type: ignore[arg-type]
    if not (d / Path(probe).name).is_file():  # type: ignore[arg-type]
        _need(f"ffprobe 不在 ffmpeg 同一個目錄：{exe} / {probe}")
    return d


@pytest.fixture()
def use_path_ffmpeg(path_ffmpeg_dir: Path, monkeypatch: pytest.MonkeyPatch, tmp_path_factory: pytest.TempPathFactory) -> Any:
    """讓引擎用 PATH 上那份 ffmpeg（Windows 開發機的解析順序會先找到內建的 LGPL build），並清掉編碼器清單快取。"""
    from aivc.media import ffmpeg as ff

    monkeypatch.setenv("AIVC_FFMPEG_DIR", str(path_ffmpeg_dir))
    monkeypatch.setenv("AIVC_CACHE_DIR", str(tmp_path_factory.mktemp("aivc-cache-fallback")))
    # 先抓住真的函式：測試可能把模組屬性換成假的，而這裡的收尾比 monkeypatch 還原更早執行
    list_encoders, encoder_usable = ff.list_encoders, ff.encoder_usable
    list_encoders.cache_clear()
    encoder_usable.cache_clear()
    yield ff
    list_encoders.cache_clear()  # 別讓後面的測試拿到這份 ffmpeg 的清單
    encoder_usable.cache_clear()


@pytest.fixture(scope="module")
def clip(path_ffmpeg_dir: Path, tmp_path_factory: pytest.TempPathFactory) -> Path:
    """2 秒 320x240@30 的 testsrc + 440 Hz sine（mpeg4 + aac：任何 ffmpeg build 都編得出來）→ 60 幀。"""
    out = tmp_path_factory.mktemp("fallback-clip") / "testsrc 2s.mp4"  # 檔名帶空格：路徑一律 list 參數
    ffmpeg = str(path_ffmpeg_dir / ("ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"))
    cmd = [
        ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=size=320x240:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-t", "2", "-c:v", "mpeg4", "-q:v", "2", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", str(out),
    ]
    cp = subprocess.run(cmd, capture_output=True, timeout=120)
    assert cp.returncode == 0, cp.stderr.decode("utf-8", "replace")
    return out


N_FRAMES = 60


def _run_proxy(capsys: pytest.CaptureFixture[str], video: Path, *extra: str) -> dict[str, Any]:
    from aivc.cli import main

    code = main(["--json", "proxy", str(video), "--force", *extra])
    lines = capsys.readouterr().out.strip().splitlines()
    final = json.loads(lines[-1])
    assert code == 0 and final["ok"], final
    return final["result"]


def _gray_frames(path: Path) -> list[Any]:
    import av

    with av.open(str(path)) as c:
        return [f.to_ndarray(format="gray") for f in c.decode(video=0)]


def _psnr(a: Any, b: Any) -> float:
    import numpy as np

    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    return 99.0 if mse == 0 else 10 * math.log10(255.0 * 255.0 / mse)


def _check_proxy(r: dict[str, Any], clip: Path, want_codec: str | None = None) -> None:
    import av

    assert (r["frames"], r["width"], r["height"], r["gop"]) == (N_FRAMES, 320, 240, 15)
    assert r["codec"] in EP.H264_CHAIN and r["audio"] == "aac"
    if want_codec:
        assert r["codec"] == want_codec
    proxy = Path(r["proxyPath"])
    assert proxy.is_file() and proxy.stat().st_size > 0
    meta = json.loads(Path(r["proxyMetaPath"]).read_text(encoding="utf-8"))
    # 選擇有記進 proxy.v1.json：編碼器、每個候選的狀態、notes／dropped
    assert meta["codec"] == r["codec"] and meta["encoderChain"] == r["encoderChain"]
    assert "encoderNotes" in meta and "encoderDropped" in meta
    with av.open(str(proxy)) as c:
        assert c.streams.video[0].codec_context.name == ("mpeg4" if r["codec"] == "mpeg4" else "h264")
    got = _gray_frames(proxy)
    assert len(got) == N_FRAMES  # 實際解得出來的幀數，不是只信 meta
    src = _gray_frames(clip)
    for k in (0, N_FRAMES // 2, N_FRAMES - 1):
        assert _psnr(src[k], got[k]) > 30.0, (r["codec"], k)


def test_proxy_auto_with_path_ffmpeg(use_path_ffmpeg: Any, clip: Path, capsys: pytest.CaptureFixture[str]) -> None:
    r = _run_proxy(capsys, clip)
    _check_proxy(r, clip)
    chain = {x["codec"]: x["status"] for x in r["encoderChain"]}
    assert chain[r["codec"]] == "usable"
    # 使用者自備的 ffmpeg（Homebrew／apt）一定有 libx264：絕不能掉到 mpeg4，更不能整段失敗
    if sys.platform == "darwin":
        assert r["codec"] in ("h264_videotoolbox", "libx264"), r["encoderChain"]
    elif sys.platform == "linux":
        assert r["codec"] in ("h264_nvenc", "libopenh264", "libx264"), r["encoderChain"]
    # capsys.disabled()：直接寫到終端，CI 的 -q log 裡也看得到「這台 runner 選了哪個編碼器」（被 capsys 吃掉就等於沒記錄）
    with capsys.disabled():
        print(f"\n[aivc-proxy-encoder] {sys.platform}: auto → {r['codec']} chain={r['encoderChain']}", file=sys.stderr)


@pytest.mark.parametrize("codec", EP.H264_CHAIN)
def test_proxy_each_available_encoder_with_path_ffmpeg(codec: str, use_path_ffmpeg: Any, clip: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """每個這份 ffmpeg 真的能用的候選都實際編一次：參數表（-allow_sw、-bf 0、位元率）打錯會在這裡炸，而不是在使用者機器上。"""
    ff = use_path_ffmpeg
    if codec not in ff.list_encoders() or not ff.encoder_usable(codec):
        if codec == "mpeg4":
            pytest.fail("mpeg4 是 ffmpeg 內建編碼器，任何 build 都該有")
        pytest.skip(f"這份 ffmpeg 沒有／不能用 {codec}")
    r = _run_proxy(capsys, clip, "--codec", codec)
    _check_proxy(r, clip, want_codec=codec)
    assert r["encoderChain"] == [{"codec": codec, "status": "requested"}]


def test_proxy_records_mpeg4_fallback_with_builtin_only_list(
    use_path_ffmpeg: Any, clip: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """假裝這份 ffmpeg 只有內建編碼器：proxy 仍建得出來（mpeg4），而且降級寫進 proxy.v1.json 與 log。"""
    ff = use_path_ffmpeg
    real_usable = ff.encoder_usable
    monkeypatch.setattr(ff, "list_encoders", lambda: MINIMAL)
    monkeypatch.setattr(ff, "encoder_usable", lambda name, timeout=45.0: name in MINIMAL and real_usable(name))
    from aivc.cli import main

    code = main(["--json", "proxy", str(clip), "--force"])
    lines = [json.loads(x) for x in capsys.readouterr().out.strip().splitlines()]
    assert code == 0, lines[-1]
    r = lines[-1]["result"]
    _check_proxy(r, clip, want_codec="mpeg4")
    assert [x["status"] for x in r["encoderChain"]] == ["unlisted", "unlisted", "unlisted", "unlisted", "usable"]
    meta = json.loads(Path(r["proxyMetaPath"]).read_text(encoding="utf-8"))
    assert meta["encoderDropped"] == [EP.MPEG4_DROPPED]
    assert any(e.get("event") == "log" and e.get("level") == "warn" and "mpeg4" in e.get("message", "") for e in lines[:-1])
