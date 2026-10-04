// 跨平台提示的純函式（ffmpeg 安裝指令、硬體需求列）與 app_platform 只問一次。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPlatform, PyEnvStatus } from "../api";
import { FFMPEG_INSTALL_CMD, ffmpegFix, hardwareRows, platformFamily, useEngine } from "./engine";

// vi.mock 會被提到 import 之前；工廠裡延遲取用 invoke，才不會碰到 const 的 TDZ
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

// 假翻譯：加前綴並做佔位符取代，確認 helper 的文字真的經過呼叫端的 t（切語言才會跟著變）
const t = (zh: string, params?: Readonly<Record<string, string | number>>) => `T:${zh.replace(/\{(\w+)\}/g, (w, k: string) => (params && k in params ? String(params[k]) : w))}`;

const WIN: AppPlatform = { os: "windows", arch: "x86_64", bundled_ffmpeg: true, bootstrap_script: "bootstrap-engine.ps1" };
const MAC: AppPlatform = { os: "macos", arch: "aarch64", bundled_ffmpeg: false, bootstrap_script: "bootstrap-engine.sh" };
const LINUX: AppPlatform = { os: "linux", arch: "x86_64", bundled_ffmpeg: false, bootstrap_script: "bootstrap-engine.sh" };

function pyenv(patch: Partial<PyEnvStatus> = {}): PyEnvStatus {
  return { state: "ready", python: "/venv/bin/python", torch: null, cuda: false, mps: false, backend: null, device: null, arch: [], lock_ok: true, message: "", ...patch };
}
// Rust 的 missing 分支是 ..Default::default()：lock_ok = false
const MISSING = pyenv({ state: "missing", python: null, lock_ok: false });
const CUDA_READY = pyenv({ torch: "2.14.0+cu130", cuda: true, backend: "cuda", device: "NVIDIA GeForce RTX 5090", arch: ["sm_90", "sm_120"] });
const MPS_READY = pyenv({ torch: "2.14.0", mps: true, backend: "mps", device: "Apple M2 Pro (MPS)" });

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("platformFamily", () => {
  it("照 app_platform 的 os 分三家；其他 OS 不猜", () => {
    expect(platformFamily(WIN)).toBe("windows");
    expect(platformFamily(MAC)).toBe("macos");
    expect(platformFamily(LINUX)).toBe("linux");
    expect(platformFamily({ os: "freebsd" })).toBe("unknown");
  });
  it("app_platform 還沒回：只有 pyenv 回報 MPS 時認定是 Mac，其他一律 unknown", () => {
    expect(platformFamily(null)).toBe("unknown");
    expect(platformFamily(null, MISSING)).toBe("unknown");
    expect(platformFamily(null, MPS_READY)).toBe("macos");
    // 已經知道平台就以它為準（pyenv 不會蓋過 app_platform）
    expect(platformFamily(LINUX, MPS_READY)).toBe("linux");
  });
});

describe("ffmpegFix", () => {
  it("平台未知：不給指令", () => {
    expect(ffmpegFix(null, t)).toEqual({ kind: "unknown" });
    expect(ffmpegFix({ os: "freebsd", arch: "x86_64", bundled_ffmpeg: false, bootstrap_script: "bootstrap-engine.sh" }, t)).toEqual({ kind: "unknown" });
  });
  it("Windows 內建 ffmpeg：找不到 = 安裝壞了 → 重新安裝，不叫人去裝 GPL build", () => {
    expect(ffmpegFix(WIN, t)).toEqual({ kind: "reinstall" });
  });
  it("macOS：brew install ffmpeg，附 Homebrew 前置提示", () => {
    const fix = ffmpegFix(MAC, t);
    expect(fix.kind).toBe("install");
    if (fix.kind !== "install") return;
    expect(fix.commands.map((c) => c.cmd)).toEqual(["brew install ffmpeg"]);
    expect(fix.commands[0].note).toMatch(/^T:.*brew\.sh/);
  });
  it("Linux：Debian/Ubuntu 的 apt（含 GStreamer 預覽外掛）與 Fedora 的 dnf（RPM Fusion）", () => {
    const fix = ffmpegFix(LINUX, t);
    expect(fix.kind).toBe("install");
    if (fix.kind !== "install") return;
    expect(fix.commands.map((c) => [c.id, c.label, c.cmd])).toEqual([
      ["apt", "Debian / Ubuntu", "sudo apt install ffmpeg gstreamer1.0-libav gstreamer1.0-plugins-good"],
      ["dnf", "Fedora", "sudo dnf install ffmpeg"],
    ]);
    expect(fix.commands[0].note).toBeNull();
    expect(fix.commands[1].note).toMatch(/^T:.*RPM Fusion/);
  });
  it("指令字面值集中在 FFMPEG_INSTALL_CMD（README / bootstrap-engine.sh 的提示要跟著它）", () => {
    expect(FFMPEG_INSTALL_CMD).toEqual({
      brew: "brew install ffmpeg",
      apt: "sudo apt install ffmpeg gstreamer1.0-libav gstreamer1.0-plugins-good",
      dnf: "sudo dnf install ffmpeg",
    });
  });
});

describe("hardwareRows", () => {
  it("Windows：維持原本四列（顯示卡 / CUDA / 架構 / lock），沒有驅動列", () => {
    const rows = hardwareRows({ platform: WIN, pyenv: CUDA_READY, gpu: "NVIDIA GeForce RTX 5090" }, t);
    expect(ids(rows)).toEqual(["gpu", "cuda", "arch", "lock"]);
    expect(rows.every((r) => r.ok === true)).toBe(true);
    expect(rows.every((r) => r.text.startsWith("T:"))).toBe(true);
    expect(rows.find((r) => r.id === "arch")?.text).toContain("sm_120");
  });

  it("app_platform 未知且沒有 MPS：沿用 CUDA 的列（不閃 Mac 的列）", () => {
    expect(ids(hardwareRows({ platform: null, pyenv: MISSING, gpu: null }, t))).toEqual(["gpu", "cuda", "arch", "lock"]);
  });

  it("Linux：多一列 NVIDIA 驅動 R580+，依 CUDA 狀態判斷", () => {
    const ready = hardwareRows({ platform: LINUX, pyenv: CUDA_READY, gpu: "RTX 5090" }, t);
    expect(ids(ready)).toEqual(["gpu", "driver", "cuda", "arch", "lock"]);
    expect(ready[1]).toMatchObject({ ok: true });
    expect(ready[1].text).toContain("R580");

    // 有卡、torch 也裝了、CUDA 卻不可用：驅動太舊是頭號嫌疑 → 警告
    const oldDriver = hardwareRows({ platform: LINUX, pyenv: pyenv({ state: "broken", torch: "2.14.0+cu130", cuda: false }), gpu: "RTX 5090" }, t);
    expect(oldDriver.find((r) => r.id === "driver")).toMatchObject({ ok: false });

    // 還沒裝：只講需求
    const missing = hardwareRows({ platform: LINUX, pyenv: MISSING, gpu: "RTX 5090 (32607 MB)" }, t);
    expect(missing.find((r) => r.id === "driver")).toMatchObject({ ok: null });
    expect(missing.find((r) => r.id === "driver")?.text).toContain("R580");
  });

  it("macOS 就緒：晶片 / MPS / macOS 14 / lock，全部 ✓，完全不提 NVIDIA / CUDA / sm_XY", () => {
    const rows = hardwareRows({ platform: MAC, pyenv: MPS_READY, gpu: "Apple M2 Pro (MPS)" }, t);
    expect(ids(rows)).toEqual(["chip", "mps", "macos", "lock"]);
    expect(rows.map((r) => r.ok)).toEqual([true, true, true, true]);
    expect(rows[0].text).toContain("Apple M2 Pro");
    expect(rows[1].text).toContain("2.14.0");
    for (const r of rows) expect(r.text).not.toMatch(/NVIDIA|CUDA|sm_/);
  });

  it("macOS 未安裝：晶片名來自 sysctl，MPS 列是警告但講的是「安裝時會抓」", () => {
    const rows = hardwareRows({ platform: MAC, pyenv: { ...MISSING, device: "Apple M1 (MPS) (16384 MB)" }, gpu: "Apple M1 (MPS) (16384 MB)" }, t);
    expect(rows.map((r) => [r.id, r.ok])).toEqual([
      ["chip", true],
      ["mps", false],
      ["macos", true],
      ["lock", false],
    ]);
    expect(rows[1].text).toContain("PyPI");
  });

  it("macOS：torch 在但 MPS 不可用 → 警告並點名 macOS 14；pyenv 還沒回 → 只講需求", () => {
    const broken = hardwareRows({ platform: MAC, pyenv: pyenv({ state: "broken", torch: "2.14.0" }), gpu: null }, t);
    expect(broken.find((r) => r.id === "chip")).toMatchObject({ ok: false });
    expect(broken.find((r) => r.id === "mps")).toMatchObject({ ok: false });
    expect(broken.find((r) => r.id === "mps")?.text).toContain("macOS 14");

    const probing = hardwareRows({ platform: MAC, pyenv: null, gpu: null }, t);
    expect(probing.map((r) => [r.id, r.ok])).toEqual([
      ["chip", null],
      ["mps", null],
      ["macos", true],
      ["lock", null],
    ]);
  });

  it("x86_64 的 macOS build：晶片列直接說 Intel Mac 不支援", () => {
    const rows = hardwareRows({ platform: { ...MAC, arch: "x86_64" }, pyenv: MISSING, gpu: null }, t);
    expect(rows[0]).toMatchObject({ id: "chip", ok: false });
    expect(rows[0].text).toContain("Intel Mac");
  });

  it("app_platform 還沒回但 pyenv 說 MPS 可用：已經用 Mac 的列", () => {
    expect(ids(hardwareRows({ platform: null, pyenv: MPS_READY, gpu: "Apple M2 Pro (MPS)" }, t))).toEqual(["chip", "mps", "macos", "lock"]);
  });

  it("backend = cpu（AIVC_ALLOW_CPU=1）：任何平台都多一列警告，排在 lock 前", () => {
    const cpu = pyenv({ torch: "2.14.0+cpu", backend: "cpu" });
    for (const platform of [WIN, LINUX, MAC]) {
      const rows = hardwareRows({ platform, pyenv: cpu, gpu: null }, t);
      expect(ids(rows).slice(-2)).toEqual(["backend", "lock"]);
      expect(rows.find((r) => r.id === "backend")).toMatchObject({ ok: false });
    }
    expect(ids(hardwareRows({ platform: WIN, pyenv: CUDA_READY, gpu: "x" }, t))).not.toContain("backend");
  });
});

describe("useEngine.loadPlatform", () => {
  beforeEach(() => {
    invoke.mockReset();
    useEngine.setState({ platform: null });
  });

  it("問一次 app_platform 存進 store；並行呼叫共用同一次，拿到後不再問", async () => {
    invoke.mockImplementation((cmd: string) => (cmd === "app_platform" ? Promise.resolve(MAC) : Promise.reject(new Error(cmd))));
    await Promise.all([useEngine.getState().loadPlatform(), useEngine.getState().loadPlatform()]);
    expect(useEngine.getState().platform).toEqual(MAC);
    await useEngine.getState().loadPlatform();
    expect(invoke.mock.calls.filter(([c]) => c === "app_platform")).toHaveLength(1);
  });

  it("非 Tauri 環境（invoke 失敗）：留 null 不擲錯，之後還能重試", async () => {
    invoke.mockRejectedValueOnce(new Error("no tauri"));
    await expect(useEngine.getState().loadPlatform()).resolves.toBeUndefined();
    expect(useEngine.getState().platform).toBeNull();
    invoke.mockResolvedValueOnce(LINUX);
    await useEngine.getState().loadPlatform();
    expect(useEngine.getState().platform).toEqual(LINUX);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
