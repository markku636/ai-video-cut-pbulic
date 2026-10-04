import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetPreviews, getPreview, hashOf, hasPreviewProvider, previewKey, putPreview, requestPreview, setPreviewProvider, usePreviews } from "./previewStore";

const fakeImage = () => ({ width: 1, height: 1 }) as unknown as CanvasImageSource;

describe("stage/previewStore", () => {
  beforeEach(() => {
    __resetPreviews();
    vi.useRealTimers();
  });

  it("hashOf 穩定且對內容敏感；previewKey 含五個部分", () => {
    expect(hashOf({ a: 1 })).toBe(hashOf({ a: 1 }));
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
    expect(hashOf("x")).toMatch(/^[0-9a-f]{8}$/);
    const k = previewKey({ mediaId: "m", frame: 12, tracksHash: "t", targetsHash: "g", insertHash: "i" });
    expect(k).toBe("m:12:t:g:i");
  });

  it("put / get + 版本號遞增", () => {
    const v0 = usePreviews.getState().version;
    const img = fakeImage();
    putPreview("k", img);
    expect(getPreview("k")).toBe(img);
    expect(getPreview("nope")).toBeNull();
    expect(usePreviews.getState().version).toBe(v0 + 1);
  });

  it("沒有 provider 就不請求；有 provider 時 120 ms 內只送最後一個、同鍵在飛不重送", async () => {
    vi.useFakeTimers();
    const parts = (frame: number) => ({ mediaId: "m", frame, tracksHash: "t", targetsHash: "g", insertHash: "i" });
    expect(hasPreviewProvider()).toBe(false);
    requestPreview(parts(1));
    vi.advanceTimersByTime(500);

    const calls: number[] = [];
    let resolve!: (v: CanvasImageSource | null) => void;
    setPreviewProvider((p) => {
      calls.push(p.frame);
      return new Promise((r) => {
        resolve = r;
      });
    });
    requestPreview(parts(1));
    requestPreview(parts(2));
    requestPreview(parts(3));
    vi.advanceTimersByTime(119);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(2);
    expect(calls).toEqual([3]);
    // 同鍵在飛：再要一次不會重送
    requestPreview(parts(3));
    vi.advanceTimersByTime(200);
    expect(calls).toEqual([3]);
    const img = fakeImage();
    resolve(img);
    await vi.runAllTimersAsync();
    expect(getPreview(previewKey(parts(3)))).toBe(img);
    // 已經有了就不再問
    requestPreview(parts(3));
    vi.advanceTimersByTime(200);
    expect(calls).toEqual([3]);
  });
});
