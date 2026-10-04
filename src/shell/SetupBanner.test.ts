// 橫幅接線：store 裡的 app_platform → ffmpeg 缺時給哪個平台的安裝指令（靜態渲染，不需要 DOM）。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPlatform, EngineInfo, FfmpegStatus, PyEnvStatus } from "../api";
import SetupBanner from "./SetupBanner";

// renderToStaticMarkup 走 useSyncExternalStore 的 server snapshot，zustand 4 那裡回的是 store 的「初始」狀態，
// setState 改不到畫面；所以三個 store 換成直接讀下面這幾個變數的假 hook（helper 仍用 store/engine.ts 的真實作）。
type Sel<S> = (s: S) => unknown;
const st = vi.hoisted(() => ({
  settings: { loaded: true, ffmpeg: null as FfmpegStatus | null, probing: false },
  engine: { info: null as EngineInfo | null, pyenv: null as PyEnvStatus | null, platform: null as AppPlatform | null, probing: false },
}));
vi.mock("../store/settings", () => ({ useSettings: Object.assign((sel: Sel<typeof st.settings>) => sel(st.settings), { getState: () => st.settings }) }));
vi.mock("../store/project", () => ({ useProject: (sel: Sel<{ media: unknown[] }>) => sel({ media: [] }) }));
vi.mock("../store/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../store/engine")>()),
  useEngine: Object.assign((sel: Sel<typeof st.engine>) => sel(st.engine), { getState: () => st.engine }),
}));
vi.mock("../commands/appActions", () => ({ openSettings: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const NO_FFMPEG: FfmpegStatus = { found: false, ffmpeg_path: null, ffprobe_path: null, version: null, source: null, encoders: [], usable: [] };
const MISSING: PyEnvStatus = { state: "missing", python: null, torch: null, cuda: false, mps: false, backend: null, device: null, arch: [], lock_ok: false, message: "" };
const plat = (os: string, bundled: boolean): AppPlatform => ({ os, arch: os === "macos" ? "aarch64" : "x86_64", bundled_ffmpeg: bundled, bootstrap_script: bundled ? "bootstrap-engine.ps1" : "bootstrap-engine.sh" });

const render = () => renderToStaticMarkup(createElement(SetupBanner));

beforeEach(() => {
  st.settings.ffmpeg = NO_FFMPEG;
  st.engine.pyenv = MISSING;
  st.engine.platform = null;
});

describe("SetupBanner：ffmpeg 缺", () => {
  it("macOS：顯示 brew install ffmpeg 與複製鈕", () => {
    st.engine.platform = plat("macos", false);
    const html = render();
    expect(html).toContain("brew install ffmpeg");
    expect(html).toContain('data-testid="ffmpeg-install-commands"');
    expect(html).toContain("複製");
    expect(html).not.toContain("重新安裝 AI Video Cut");
  });

  it("Linux：apt 與 dnf 兩條都列出", () => {
    st.engine.platform = plat("linux", false);
    const html = render();
    expect(html).toContain("sudo apt install ffmpeg gstreamer1.0-libav gstreamer1.0-plugins-good");
    expect(html).toContain("sudo dnf install ffmpeg");
    expect(html).toContain("RPM Fusion");
  });

  it("Windows（內建 ffmpeg）：叫人重新安裝，不給套件管理器指令", () => {
    st.engine.platform = plat("windows", true);
    const html = render();
    expect(html).toContain("重新安裝 AI Video Cut");
    expect(html).not.toContain("ffmpeg-install-commands");
    expect(html).not.toMatch(/brew|apt install|dnf install/);
  });

  it("平台還沒問到：維持原本的一句話，不猜指令", () => {
    const html = render();
    expect(html).toContain("找不到 ffmpeg：無法讀取影片資訊、建 proxy 或輸出。");
    expect(html).not.toContain("ffmpeg-install-commands");
  });
});

describe("SetupBanner：引擎未安裝的文字依平台", () => {
  beforeEach(() => {
    st.settings.ffmpeg = { ...NO_FFMPEG, found: true };
  });

  it("Mac 不講 CUDA / 6 GB", () => {
    st.engine.platform = plat("macos", false);
    const html = render();
    expect(html).toContain("PyTorch MPS");
    expect(html).not.toMatch(/CUDA|6 GB/);
  });

  it("Windows / Linux 維持 CUDA 的說法", () => {
    for (const p of [plat("windows", true), plat("linux", false)]) {
      st.engine.platform = p;
      expect(render()).toContain("Python + CUDA");
    }
  });
});
