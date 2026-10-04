import { describe, expect, it, vi } from "vitest";
import { SHOWN_AT_KEY, SPLASH_FADE_MS, SPLASH_MIN_MS, hideBootSplash, splashWaitMs, whenWindowShown, windowShownAt } from "./splash";

/** 假的 window：時間自己控，rAF 排進佇列由測試手動推進。 */
function fakeWindow(t0 = 0) {
  const frames: (() => void)[] = [];
  const w = {
    t: t0,
    performance: { now: () => w.t },
    requestAnimationFrame: (cb: () => void) => {
      frames.push(cb);
      return frames.length;
    },
    setTimeout: vi.fn(),
    frame(dt = 16) {
      w.t += dt;
      const due = frames.splice(0, frames.length);
      for (const cb of due) cb();
    },
  } as unknown as Parameters<typeof whenWindowShown>[0] & { t: number; frame: (dt?: number) => void };
  return w;
}

describe("B-18：開場畫面的最短停留從「視窗出現」算起", () => {
  it("視窗 200 ms 時出現、React 220 ms 掛好 → 只再等 230 ms（以前是等到 780 ms，多空等 330 ms）", () => {
    const wait = splashWaitMs({ now: 220, shownAt: 200 });
    expect(wait).toBe(SPLASH_MIN_MS - 20);
    // 舊算法：從導覽開始算 780 ms
    const before = Math.max(0, 780 - 220);
    expect(before - (220 + wait - 220)).toBe(330);
    // 也就是說退場時刻從 780 ms 提前到 450 ms
    expect(220 + wait).toBe(450);
  });

  it("React 掛得比視窗晚很多（慢機器）就完全不等", () => {
    expect(splashWaitMs({ now: 900, shownAt: 200 })).toBe(0);
  });

  it("減少動態偏好時不等", () => {
    expect(splashWaitMs({ now: 0, shownAt: 0, reduced: true })).toBe(0);
  });

  it("量不到視窗出現的時刻就退回導覽起點（最壞情況不會比以前更久）", () => {
    expect(splashWaitMs({ now: 100, shownAt: null })).toBe(SPLASH_MIN_MS - 100);
    expect(splashWaitMs({ now: 1000, shownAt: null })).toBe(0);
  });

  it("windowShownAt 只接受合理的數字", () => {
    expect(windowShownAt({ [SHOWN_AT_KEY]: 132.5 })).toBe(132.5);
    expect(windowShownAt({})).toBeNull();
    expect(windowShownAt({ [SHOWN_AT_KEY]: "132" })).toBeNull();
    expect(windowShownAt({ [SHOWN_AT_KEY]: Number.NaN })).toBeNull();
  });

  it("React 先跑（module script 早於 DOMContentLoaded）時等到 index.html 寫下時刻為止", () => {
    const w = fakeWindow(120);
    const cb = vi.fn();
    whenWindowShown(w, cb);
    expect(cb).not.toHaveBeenCalled();
    w.frame(); // 136 ms，還沒出現
    expect(cb).not.toHaveBeenCalled();
    (w as unknown as Record<string, unknown>)[SHOWN_AT_KEY] = 150;
    w.frame(); // 152 ms
    expect(cb).toHaveBeenCalledWith(150);
  });

  it("hideBootSplash：等到視窗出現才排退場，延遲是「視窗出現 + 250 ms」而不是「導覽 + 780 ms」", () => {
    const w = fakeWindow(300) as unknown as Record<string, unknown> & { t: number; frame: (dt?: number) => void; setTimeout: ReturnType<typeof vi.fn> };
    w.matchMedia = () => ({ matches: false });
    const el = { classList: { contains: () => false, add: vi.fn() }, remove: vi.fn() };
    const doc = { getElementById: (id: string) => (id === "boot-splash" ? el : null) } as unknown as Document;

    hideBootSplash(doc, w as never);
    expect(w.setTimeout).not.toHaveBeenCalled(); // 視窗還沒出現：先不排
    w[SHOWN_AT_KEY] = 320;
    w.frame(20); // 320 ms
    expect(w.setTimeout).toHaveBeenCalledTimes(1);
    expect(w.setTimeout.mock.calls[0][1]).toBe(SPLASH_MIN_MS); // 剛出現 → 等滿 250 ms
    // 舊行為在同一時刻會等 780 - 320 = 460 ms
    expect(w.setTimeout.mock.calls[0][1]).toBeLessThan(780 - 320);

    w.setTimeout.mock.calls[0][0](); // 假裝時間到
    expect(el.classList.add).toHaveBeenCalledWith("done");
    expect(w.setTimeout.mock.calls[1][1]).toBe(SPLASH_FADE_MS);
  });

  it("等不到視窗出現也一定會退場（不能永遠蓋著畫面）", () => {
    const w = fakeWindow(0);
    const cb = vi.fn();
    whenWindowShown(w, cb);
    for (let i = 0; i < 200 && !cb.mock.calls.length; i++) w.frame(16);
    expect(cb).toHaveBeenCalledWith(null);
    expect(w.t).toBeLessThan(2100);
  });
});
