// 舞台預覽的守門：四個條件任何一個不成立就不送。
// 這些守門在保護外掛自己的引擎預覽 session（例如 cards 的牌局檢視；模組層級唯一、鍵是專案路徑 + media）不被踢掉，
// 失效的話那邊每張縮圖會退化成 1–30 秒，而且不會有任何錯誤訊息 —— 所以要有測試盯著。
import { describe, expect, it } from "vitest";
import { canPreview, stamp } from "./stagePreview";

const OK = { ready: true, busy: false, blocked: false, inFlight: false };

describe("canPreview", () => {
  it("四個條件都成立才送", () => {
    expect(canPreview(OK)).toBe(true);
  });

  it("引擎沒就緒不送", () => {
    expect(canPreview({ ...OK, ready: false })).toBe(false);
  });

  it("引擎在忙不送 —— 只有一條 worker，預覽絕不跟真正的工作搶", () => {
    expect(canPreview({ ...OK, busy: true })).toBe(false);
  });

  it("外掛說不送就不送 —— 會把外掛自己的預覽 session 踢掉，重建決策表要 1–30 秒", () => {
    expect(canPreview({ ...OK, blocked: true })).toBe(false);
  });

  it("已經有一個在飛就不送（previewStore 的去重是逐鍵的，跨鍵還是會疊）", () => {
    expect(canPreview({ ...OK, inFlight: true })).toBe(false);
  });
});

describe("stamp", () => {
  const parts = (over: Partial<Parameters<typeof stamp>[0]> = {}) => ({ mediaId: "m1", frame: 7, tracksHash: "aa", targetsHash: "bb", insertHash: "cc", ...over });

  it("只留英數、截到 16 字 —— 要當檔名用", () => {
    expect(stamp(parts())).toBe("aabbcc");
    expect(stamp(parts({ tracksHash: "a/b\c:d*e" }))).toBe("abcdebbcc");
    expect(stamp(parts({ tracksHash: "0123456789abcdefGHIJ" }))).toHaveLength(16);
  });

  it("全部是符號時退回 \"0\"，不要吐出空字串當檔名", () => {
    expect(stamp(parts({ tracksHash: "//", targetsHash: "::", insertHash: "**" }))).toBe("0");
  });
});
