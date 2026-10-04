// 實驗功能旗標（settings.experimental.sequence）：M2.17 起預設開、localStorage 還原只收布林值（明確存了 false 的維持關）、沒有 localStorage 也不炸。
import { describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({ api: {} }));

const { DEFAULT_EXPERIMENTAL, parseExperimental, sequenceEditingEnabled, useSettings } = await import("./settings");

describe("settings：實驗功能旗標", () => {
  it("預設開（M2.17 打開旗標：序列剪輯正式出貨）", () => {
    expect(DEFAULT_EXPERIMENTAL.sequence).toBe(true);
    expect(parseExperimental(null)).toEqual({ sequence: true });
    // node 測試環境沒有 localStorage：store 初始化走 catch，一樣是預設
    expect(useSettings.getState().experimental).toEqual({ sequence: true });
    expect(sequenceEditingEnabled()).toBe(true);
  });

  it("還原：只收布林值，壞 JSON / 型別不對退回預設；明確存了 false（使用者自己關的）維持關", () => {
    expect(parseExperimental(JSON.stringify({ sequence: true }))).toEqual({ sequence: true });
    expect(parseExperimental(JSON.stringify({ sequence: false }))).toEqual({ sequence: false });
    expect(parseExperimental(JSON.stringify({ sequence: "yes" }))).toEqual({ sequence: true });
    expect(parseExperimental("null")).toEqual({ sequence: true });
    expect(parseExperimental("{broken")).toEqual({ sequence: true });
  });

  it("setExperimental：改了才換物件；存不了 localStorage 也照樣在這次執行生效", () => {
    const before = useSettings.getState().experimental;
    useSettings.getState().setExperimental({ sequence: true });
    expect(useSettings.getState().experimental).toBe(before);
    useSettings.getState().setExperimental({ sequence: false });
    expect(sequenceEditingEnabled()).toBe(false);
    // 不會混進送給 Rust 的 AppSettings（store.rs 沒有這個欄位，會被 serde 丟掉）
    expect("experimental" in useSettings.getState().s).toBe(false);
    useSettings.getState().setExperimental({ sequence: true });
  });
});
