// 效果 / 替換預覽送給引擎的 args（sidecar 的鍵＝CLI dest 名）與守門。
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const { canFxPreview, compositeArgs, fxPreviewArgs, quadArg, replaceNote } = await import("./fxPreview");
const { rectQuad } = await import("../video/quad");

describe("fx.preview / comp.preview_composite 的 args", () => {
  it("fx.preview：masks 是陣列、effects 直接給 JSON 字串（不寫暫存檔）、不縮圖", () => {
    expect(fxPreviewArgs({ video: "D:\\v.mp4", masks: "C:\\c\\tracks\\o1\\masks.aivm", effects: '[{"type":"mosaic"}]', frame: 12, out: "C:\\c\\fx\\o1.png" })).toEqual({
      video: "D:\\v.mp4",
      masks: ["C:\\c\\tracks\\o1\\masks.aivm"],
      effects: '[{"type":"mosaic"}]',
      frame: 12,
      out: "C:\\c\\fx\\o1.png",
      max_width: 0,
    });
  });

  it("preview_composite：四角是 TL,TR,BR,BL 八個數字的字串；view replaced", () => {
    const q = rectQuad(10, 20, 100, 50);
    expect(quadArg(q)).toBe("10,20,110,20,110,70,10,70");
    expect(compositeArgs({ framePng: "f.png", quad: q, template: "ad.png", out: "o.png" })).toEqual({ frame: "f.png", quad: "10,20,110,20,110,70,10,70", template_new: "ad.png", view: "replaced", out: "o.png" });
    expect(quadArg({ p: [[0.12345, 1], [2, 3], [4, 5], [6, 7]] })).toBe("0.123,1,2,3,4,5,6,7");
  });
});

describe("replaceNote", () => {
  it("影片只看第一幀；fit 不是拉伸時講「以輸出為準」；圖片拉伸不吵", () => {
    expect(replaceNote({ kind: "image", fit: "stretch" })).toBeNull();
    expect(replaceNote({ kind: "image", fit: "cover" })).toMatchObject({ params: { fit: "cover" } });
    expect(replaceNote({ kind: "video", fit: "stretch" })?.key).toBe("預覽：影片替換只顯示第一幀");
    expect(replaceNote({ kind: "video", fit: "contain" })).toMatchObject({ params: { fit: "contain" } });
  });
});

describe("canFxPreview", () => {
  it("引擎就緒而且沒有工作在排隊或在跑才送（主 lane 只有一條，預覽不跟真正的工作搶）", () => {
    expect(canFxPreview({ ready: true, busy: false })).toBe(true);
    expect(canFxPreview({ ready: false, busy: false })).toBe(false);
    expect(canFxPreview({ ready: true, busy: true })).toBe(false);
  });
});
