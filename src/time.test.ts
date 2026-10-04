import { describe, expect, it } from "vitest";
import { formatMs, timecode } from "./time";

describe("time", () => {
  it("formatMs", () => {
    expect(formatMs(61_234)).toBe("1:01.234");
    expect(formatMs(3_661_000, { millis: false })).toBe("1:01:01");
  });
  it("timecode 30/1", () => {
    expect(timecode(0, { num: 30, den: 1 })).toBe("00:00:00:00");
    expect(timecode(29, { num: 30, den: 1 })).toBe("00:00:00:29");
    expect(timecode(30, { num: 30, den: 1 })).toBe("00:00:01:00");
    expect(timecode(30 * 3600 + 45, { num: 30, den: 1 })).toBe("01:00:01:15");
  });
  it("timecode 30000/1001 用 30 格、ff < 30", () => {
    expect(timecode(29, { num: 30000, den: 1001 })).toBe("00:00:00:29");
    expect(timecode(30, { num: 30000, den: 1001 })).toBe("00:00:01:00");
  });
  it("負數 / 小數夾成 0 / 取整", () => {
    expect(timecode(-5, { num: 30, den: 1 })).toBe("00:00:00:00");
    expect(timecode(31.9, { num: 30, den: 1 })).toBe("00:00:01:01");
  });
});
