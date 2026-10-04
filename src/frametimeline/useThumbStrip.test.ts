// 審查 13：thumb_strip 吃的是媒體指紋（Rust media_dir 取前 16 碼 hex），不是 proxy 路徑；失敗的格子要能重試。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxyMeta } from "../api";

const thumbStrip = vi.fn();
vi.mock("../api", () => ({ api: { thumbStrip: (...a: unknown[]) => thumbStrip(...a) } }));
vi.mock("@tauri-apps/api/core", () => ({ convertFileSrc: (p: string) => `asset://${p}` }));
vi.mock("../store/project", () => ({ useProject: () => null }));

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_v: string) {
    queueMicrotask(() => this.onload?.());
  }
}

const { clearThumbCache, ensureThumbTiles, fingerprintOfProxy, getThumbTile, normalizeFingerprint, retryDelay, THUMB_RETRY_BASE_MS } = await import("./useThumbStrip");

const FP = `0123456789ABCDEF${"0".repeat(48)}`;
const proxy: ProxyMeta = { version: 1, fps: { num: 30, den: 1 }, frames: 1797, width: 1280, height: 720, scale: 1, path: "C:\\Users\\alice\\AppData\\Local\\cache\\media\\0123456789abcdef\\proxy.mp4" };
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.stubGlobal("Image", FakeImage);
  thumbStrip.mockReset();
  clearThumbCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useThumbStrip：送給 Rust 的是指紋", () => {
  it("ensureThumbTiles 用 16 碼小寫指紋呼叫 thumb_strip，不是 proxy 的絕對路徑", async () => {
    thumbStrip.mockResolvedValue("C:\\cache\\thumbs\\t-0-32-h44-v1.png");
    ensureThumbTiles(FP, proxy, [0, 5, 40], 44);
    expect(thumbStrip).toHaveBeenCalledTimes(2);
    for (const call of thumbStrip.mock.calls) {
      expect(call[0]).toBe("0123456789abcdef");
      expect(String(call[0])).not.toContain("proxy.mp4");
    }
    expect(thumbStrip.mock.calls.map((c) => c[2]).sort((a, b) => a - b)).toEqual([0, 32]);
    await flush();
    await flush();
    expect(getThumbTile(FP.slice(0, 16).toLowerCase(), 0, 44)).toBeInstanceOf(FakeImage);
  });

  it("指紋正規化：路徑 / 非 hex 回 null（不送）；proxy → 媒體指紋靠物件同一性找回，指紋缺就用 id", () => {
    expect(normalizeFingerprint(proxy.path)).toBeNull();
    expect(normalizeFingerprint("")).toBeNull();
    ensureThumbTiles(proxy.path, proxy, [0], 44);
    expect(thumbStrip).not.toHaveBeenCalled();
    const other = { ...proxy };
    expect(fingerprintOfProxy(proxy, [{ id: "ffffffffffffffff", fingerprint: "", proxy: other }, { id: "0123456789abcdef", fingerprint: FP, proxy }])).toBe("0123456789abcdef");
    expect(fingerprintOfProxy(proxy, [{ id: "0123456789abcdef", fingerprint: "", proxy }])).toBe("0123456789abcdef");
    expect(fingerprintOfProxy(null, [])).toBeNull();
    expect(fingerprintOfProxy(proxy, [])).toBeNull();
  });
});

describe("useThumbStrip：失敗的格子可以重試", () => {
  it("失敗後退避期間不重送；退避過了下一次 ensure 重送，成功就有圖", async () => {
    thumbStrip.mockRejectedValueOnce(new Error("fingerprint invalid")).mockResolvedValue("C:\\cache\\thumbs\\t-0-32-h44-v1.png");
    const t0 = Date.now();
    ensureThumbTiles(FP, proxy, [0], 44, t0);
    await flush();
    await flush();
    expect(thumbStrip).toHaveBeenCalledTimes(1);
    expect(getThumbTile("0123456789abcdef", 0, 44)).toBeNull();

    ensureThumbTiles(FP, proxy, [0], 44, Date.now());
    expect(thumbStrip).toHaveBeenCalledTimes(1);

    ensureThumbTiles(FP, proxy, [0], 44, Date.now() + THUMB_RETRY_BASE_MS + 1);
    expect(thumbStrip).toHaveBeenCalledTimes(2);
    await flush();
    await flush();
    expect(getThumbTile("0123456789abcdef", 0, 44)).toBeInstanceOf(FakeImage);
    // 成功之後不再送
    ensureThumbTiles(FP, proxy, [0], 44, Date.now() + 10 * THUMB_RETRY_BASE_MS);
    expect(thumbStrip).toHaveBeenCalledTimes(2);
  });

  it("退避是指數成長、有上限", () => {
    expect(retryDelay(1)).toBe(THUMB_RETRY_BASE_MS);
    expect(retryDelay(2)).toBe(2 * THUMB_RETRY_BASE_MS);
    expect(retryDelay(100)).toBe(60_000);
  });
});
