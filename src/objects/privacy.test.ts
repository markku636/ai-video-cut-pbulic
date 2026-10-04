// 隱私打碼預設：起始文字、「也找車牌」的開關不動到使用者打的其他片語。
import { describe, expect, it } from "vitest";
import { engineText } from "./find";
import { PRIVACY_PLATES, privacyStartText, privacyText } from "./privacy";

describe("隱私打碼的文字", () => {
  it("預設只找人臉；加車牌時送給引擎的是英文", () => {
    expect(privacyStartText()).toBe("人臉");
    expect(engineText(privacyStartText(true)).text).toBe("face, license plate");
  });

  it("勾 / 取消「也找車牌」：只加減那一個片語，其他原樣、不重複", () => {
    expect(privacyText("人臉", true)).toBe(`人臉, ${PRIVACY_PLATES}`);
    expect(privacyText("人臉, 車牌", true)).toBe("人臉, 車牌");
    expect(privacyText("人臉、車牌、logo", false)).toBe("人臉, logo");
    expect(privacyText("人臉", false)).toBe("人臉");
  });
});
