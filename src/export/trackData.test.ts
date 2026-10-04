import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const { trackDataArgs, trackDataExtension } = await import("./trackData");
const { renderArgs, sidecarPathFor } = await import("../pipeline/exportVideo");

/**
 * 匯出器實作只有 Python 一份（決策 6 / 18）；這裡只守「UI 選項 → 引擎 argparse dest 名」這張對照表，
 * key 錯一個引擎就會用預設值而不報錯（argparse 的 vars(ns) 沒有多餘 key 的檢查）。
 */
describe("export.track args", () => {
  it("baked 是 store_true 旗標；linked 與它互斥，只送其中一個", () => {
    const a = trackDataArgs("D:\\p.aivc.json", "m1", "t1", { format: "nuke", flavour: "cornerpin", baked: true, frameOffset: 1 });
    expect(a).toEqual({ project: "D:\\p.aivc.json", media: "m1", track: "t1", format: "nuke", flavour: "cornerpin", baked: true, frame_offset: 1, stdout: true });
    const b = trackDataArgs("p", "m1", "t1", { format: "ae", flavour: "cornerpin+transform", baked: false, frameOffset: null, stabilize: true, raw: true, out: "D:\\x.txt" });
    expect(b).toEqual({ project: "p", media: "m1", track: "t1", format: "ae", flavour: "cornerpin+transform", linked: true, stabilize: true, raw: true, stdout: true, out: "D:\\x.txt" });
    expect("baked" in b).toBe(false);
  });
  it("frame_offset 是整數；null 不送（讓引擎用 nuke=exportDefaults / ae=0 的預設）", () => {
    expect(trackDataArgs("p", "m", "t", { format: "nuke", flavour: "cornerpin", baked: true, frameOffset: 2.6 }).frame_offset).toBe(3);
    expect("frame_offset" in trackDataArgs("p", "m", "t", { format: "nuke", flavour: "cornerpin", baked: true, frameOffset: null })).toBe(false);
  });
  it("副檔名：nuke → .nk、ae → .txt", () => {
    expect(trackDataExtension("nuke")).toBe("nk");
    expect(trackDataExtension("ae")).toBe("txt");
  });
});

describe("render.plan / render.run args", () => {
  it("range 是 'K0:K1' 字串、trim 只在有 range 時送、codec auto 不送、quality 是整數", () => {
    const a = renderArgs("p", "m1", { outPath: "D:\\out.webm", range: { in: 10, out: 250 }, trim: true, codec: "auto", quality: 24.4, audio: "copy" });
    expect(a).toEqual({ project: "p", out: "D:\\out.webm", media: "m1", quality: 24, audio: "copy", range: "10:250", trim: true });
    const b = renderArgs("p", "m1", { outPath: "o.mp4", range: null, trim: true, codec: "h264_nvenc", quality: null, audio: null, noGpu: true, trackIds: ["t1", "t2"], emitMatte: "D:\\m", emitFaces: "D:\\f", seed: 7 });
    expect(b).toEqual({ project: "p", out: "o.mp4", media: "m1", codec: "h264_nvenc", no_gpu: true, track: ["t1", "t2"], seed: 7, emit_matte: "D:\\m", emit_faces: "D:\\f" });
    expect("trim" in b).toBe(false);
  });
  it("字幕：auto 不送（引擎預設）、on / off 照送、側車字幕檔送 captions_sidecar", () => {
    const base = { outPath: "o.mp4", range: null, codec: null, quality: null, audio: null } as const;
    expect(renderArgs("p", "m1", { ...base, captions: "auto", captionsSidecar: null })).toEqual({ project: "p", out: "o.mp4", media: "m1" });
    expect(renderArgs("p", "m1", { ...base, captions: "on", captionsSidecar: "srt" })).toEqual({ project: "p", out: "o.mp4", media: "m1", captions: "on", captions_sidecar: "srt" });
    expect(renderArgs("p", "m1", { ...base, captions: "off", captionsSidecar: "vtt" })).toEqual({ project: "p", out: "o.mp4", media: "m1", captions: "off", captions_sidecar: "vtt" });
  });
  it("字幕檔覆寫：使用者答應了才送 overwrite_sidecar；沒有字幕檔時不送", () => {
    const base = { outPath: "o.mp4", range: null, codec: null, quality: null, audio: null } as const;
    expect(renderArgs("p", "m1", { ...base, captionsSidecar: "srt", overwriteSidecar: true })).toMatchObject({ captions_sidecar: "srt", overwrite_sidecar: true });
    expect(renderArgs("p", "m1", { ...base, captionsSidecar: "srt", overwriteSidecar: false })).not.toHaveProperty("overwrite_sidecar");
    expect(renderArgs("p", "m1", { ...base, captionsSidecar: null, overwriteSidecar: true })).not.toHaveProperty("overwrite_sidecar");
  });
  it("字幕檔路徑 = 輸出檔換副檔名（= Path.with_suffix：只換最後一段；資料夾名的點、隱藏檔不算副檔名）", () => {
    expect(sidecarPathFor("D:\\out\\clip.mp4", "srt")).toBe("D:\\out\\clip.srt");
    expect(sidecarPathFor("/home/u/a.b.webm", "vtt")).toBe("/home/u/a.b.vtt");
    expect(sidecarPathFor("D:\\v1.2\\clip", "ass")).toBe("D:\\v1.2\\clip.ass");
    expect(sidecarPathFor("/home/u/.hidden", "srt")).toBe("/home/u/.hidden.srt");
  });
});
