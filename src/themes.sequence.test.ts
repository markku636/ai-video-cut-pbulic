// 序列時間軸主題 token（M2.10）：tailwind.config.js 顏色表宣告的每個 CSS 變數，每個主題的 buildAppVars 都要給值。
// check-theme-tokens.mjs 只檢查「class 用到的名字在顏色表裡」；這裡補另一半 ——「顏色表裡的名字在執行期真的有值」。
// 少了這條，新 token 忘了在 themes.ts 給值時 Tailwind class 會變成 rgb( / 1) 的無效色，canvas 則退回兜底色，兩邊都不會報錯。
import { describe, expect, it } from "vitest";
import { buildAppVars, DARK_SEQUENCE, LIGHT_SEQUENCE, SEQUENCE_COLOR_VARS, THEMES } from "./themes";

// 專案沒有 @types/node：跟 captionWarnings.test.ts 一樣用 vite 的 ?raw 讀原始文字
const TAILWIND = import.meta.glob("../tailwind.config.js", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;

function colorVarsOfTailwind(): string[] {
  const cfg = Object.values(TAILWIND)[0] ?? "";
  const block = cfg.slice(cfg.indexOf("colors:"), cfg.indexOf("// @colors-end"));
  return [...block.matchAll(/var\((--c-[a-z0-9-]+)\)/g)].map((m) => m[1]);
}

describe("themes：序列時間軸 token", () => {
  it("設計 §9.2 的 12 個 token 都在 tailwind 顏色表（哨兵之上）", () => {
    const vars = colorVarsOfTailwind();
    for (const name of ["clip-video", "clip-audio", "clip-selected", "clip-disabled", "clip-offline", "gap", "waveform", "waveform-rms", "gain-line", "fade", "envelope-point", "used-in-sequence"]) {
      expect(vars).toContain(`--c-${name}`);
    }
    expect(Object.values(SEQUENCE_COLOR_VARS).every((v) => vars.includes(v))).toBe(true);
  });

  it("每個主題都給齊顏色表裡的每個 CSS 變數（R G B 三通道）", () => {
    const vars = colorVarsOfTailwind();
    for (const def of THEMES) {
      const out = buildAppVars(def);
      for (const v of vars) expect(out[v], `${def.id} ${v}`).toMatch(/^\d{1,3} \d{1,3} \d{1,3}$/);
    }
  });

  it("深 / 淺兩組預設各自完整、亮色主題用亮色組", () => {
    expect(Object.keys(LIGHT_SEQUENCE).sort()).toEqual(Object.keys(DARK_SEQUENCE).sort());
    const light = THEMES.find((d) => !d.dark)!;
    expect(buildAppVars(light)["--c-waveform-rms"]).toBe("15 81 50");
    const dark = THEMES.find((d) => d.dark)!;
    expect(buildAppVars(dark)["--c-clip-video"]).toBe("108 140 255");
  });
});
