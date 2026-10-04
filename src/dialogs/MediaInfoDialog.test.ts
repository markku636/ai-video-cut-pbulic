import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 對話框會 import api（Tauri invoke）與檔案對話框 plugin；伺服器端渲染不跑 effect，這裡只驗「第一個畫面」不會炸
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.reject(new Error("no tauri"))), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const { default: MediaInfoDialog } = await import("./MediaInfoDialog");
const { useProject } = await import("../store/project");

const FP = "d171ec9031ba677f9ee35bb109820ccfdbf33c804141f58ed28635727a4f7984";

beforeEach(() => {
  // zustand 4 在伺服器端渲染讀的是 store 建立當下的初始狀態物件（api.getInitialState），setState 看不到；
  // 這裡沒有 DOM 測試環境，只好直接改那個物件（只在這個測試檔）
  Object.assign(useProject.getInitialState(), {
    media: [
      {
        id: FP.slice(0, 16),
        path: "D:\\v\\sample_clip1.webm",
        name: "sample_clip1.webm",
        fingerprint: FP,
        proxy: null,
        proxyState: "none",
        // 舊專案存的 probe：沒有補充欄位
        probe: {
          path: "D:\\v\\sample_clip1.webm",
          size_bytes: 22768280,
          duration_ms: 0,
          container: "matroska,webm",
          fingerprint: FP,
          audio: { codec: "opus", sample_rate: 48000, channels: 2, bit_rate: null },
          video: {
            codec: "vp9",
            width: 1280,
            height: 720,
            pix_fmt: "yuv420p",
            r_frame_rate: { num: 30, den: 1 },
            avg_frame_rate: { num: 0, den: 1 },
            time_base: { num: 1, den: 1000 },
            nb_frames: null,
            duration_ms: null,
            start_time_ms: 2,
            color_range: "tv",
            color_space: null,
            color_transfer: null,
            color_primaries: null,
            rotation: 0,
            has_b_frames: 0,
            bit_rate: null,
          },
        },
      },
    ],
    activeMediaId: FP.slice(0, 16),
  });
});

describe("MediaInfoDialog 第一個畫面", () => {
  it("用專案裡存的 probe 先畫出六個區塊、表頭晶片與「讀取中」", () => {
    const html = renderToString(createElement(MediaInfoDialog, { mediaId: null, onClose: () => {} }));
    expect(html).toContain("媒體資訊");
    expect(html).toContain("sample_clip1.webm");
    expect(html).toContain("1280×720");
    for (const id of ["file", "video", "color", "timing", "audio", "engine"]) expect(html).toContain(`data-section="${id}"`);
    // 沒有值的列是「—」加 tooltip 原因
    expect(html).toContain("讀取中…");
    expect(html).toContain('data-row="video.fourcc"');
  });

  it("指定的媒體不存在時什麼都不畫（由 effect 關掉）", () => {
    expect(renderToString(createElement(MediaInfoDialog, { mediaId: "nope", onClose: () => {} }))).toBe("");
  });
});
