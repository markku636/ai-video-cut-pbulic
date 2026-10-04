import { describe, expect, it } from "vitest";
import { parsePersisted } from "./ui";

// 這裡不登記任何外掛（= 開源版）：第一次啟動的分頁是「追蹤」。登記牌外掛之後是「牌」分頁：
// plugins/cards/frontend/store/ui.test.ts。
describe("ui store：持久化還原", () => {
  it("第一次裝（沒存過）→ 專業殼、追蹤分頁", () => {
    const p = parsePersisted(null);
    expect(p.mode).toBe("pro");
    expect(p.tab).toBe("objects");
    expect(p.railOpen).toBe(true);
  });
  it("ai-music-cut 時代的舊 blob（decisions 分頁、simple 模式）→ 退回預設分頁 / pro，不會炸", () => {
    const p = parsePersisted(JSON.stringify({ tab: "decisions", mode: "simple", railOpen: false, railWidth: 400, density: "compact" }));
    expect(p.tab).toBe("objects");
    expect(p.mode).toBe("pro");
    expect(p.railOpen).toBe(false);
    expect(p.railWidth).toBe(400);
    expect(p.density).toBe("compact");
  });
  it("存的是沒裝的外掛的分頁（例如 cards）→ 退回預設分頁", () => {
    expect(parsePersisted(JSON.stringify({ tab: "cards" })).tab).toBe("objects");
  });
  it("profile / hintsSeen 要驗型別；railWidth 夾在範圍內", () => {
    const p = parsePersisted(JSON.stringify({ tab: "track", profile: "generic", hintsSeen: ["a", 3, null, "b"], railWidth: 9999 }));
    expect(p.tab).toBe("track");
    expect(p.profile).toBe("generic");
    expect(p.hintsSeen).toEqual(["a", "b"]);
    expect(p.railWidth).toBe(620);
    expect(parsePersisted(JSON.stringify({ profile: "music" })).profile).toBeNull();
    // 沒裝的外掛的工作模式也不認得
    expect(parsePersisted(JSON.stringify({ profile: "cards" })).profile).toBeNull();
  });
  it("壞掉的 JSON → 預設", () => {
    expect(parsePersisted("{not json").tab).toBe("objects");
  });
});
