import { describe, expect, it, vi } from "vitest";

// api.ts 一 import 就把 Tauri 的 invoke / listen 拉進來；這裡只驗純函式，Tauri 全部 stub
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const { HINT_MAX_CHARS, errMessage, hintTail } = await import("./api");

const eng = (message: string, hint = "", kind = "Ffmpeg") => ({ kind, message, hint });

describe("B-11：長工作的錯誤要帶出引擎 hint（死因只在 hint 裡）", () => {
  it("ffmpeg 提前結束會接上 stderr 尾巴的真正死因", () => {
    const e = eng(
      "ffmpeg 提前結束（寫入管線失敗）",
      "Output #0, mp4, to 'D:\\ro\\out.mp4.part':\nError opening output file D:\\ro\\out.mp4.part: Permission denied",
    );
    expect(errMessage(e)).toBe("ffmpeg 提前結束（寫入管線失敗）（Output #0, mp4, to 'D:\\ro\\out.mp4.part': Error opening output file D:\\ro\\out.mp4.part: Permission denied）");
  });

  it("Gpu / Model / PyEnv 的建議也一起帶出來", () => {
    expect(errMessage(eng("CUDA 不可用", "跑 `aivc doctor` 檢查 venv 的 torch", "Gpu"))).toContain("aivc doctor");
  });

  it("只留 hint 的最後 3 行（前面全是 banner）", () => {
    const hint = ["ffmpeg version n8.0", "  configuration: --enable-gpl", "frame= 12 fps=0.0", "av_interleaved_write_frame(): No space left on device", "Conversion failed!"].join("\n");
    const out = errMessage(eng("ffmpeg 提前結束（寫入管線失敗）", hint));
    expect(out).toContain("No space left on device");
    expect(out).toContain("Conversion failed!");
    expect(out).not.toContain("ffmpeg version n8.0");
    expect(out).not.toContain("configuration");
  });

  it("超長的 hint 截到 400 字以內，保留尾巴", () => {
    const tail = hintTail("x".repeat(900) + "真正的死因");
    expect(tail.length).toBeLessThanOrEqual(HINT_MAX_CHARS);
    expect(tail.endsWith("真正的死因")).toBe(true);
    expect(tail.startsWith("…")).toBe(true);
  });

  it("hint 空白、或跟 message 一樣、或已經包在 message 裡時不重複貼", () => {
    expect(errMessage(eng("找不到模型"))).toBe("找不到模型");
    expect(errMessage(eng("找不到模型", "   \n  "))).toBe("找不到模型");
    expect(errMessage(eng("找不到模型", "找不到模型"))).toBe("找不到模型");
    expect(errMessage(eng("找不到模型（快去下載）", "快去下載"))).toBe("找不到模型（快去下載）");
  });

  it("其他形狀不受影響：AppError 沒有 hint、Error、字串、退路", () => {
    expect(errMessage({ kind: "io", code: "ERR_IO", message: "檔案讀寫錯誤：x" })).toBe("檔案讀寫錯誤：x");
    expect(errMessage(new Error("炸了"))).toBe("炸了");
    expect(errMessage("字串")).toBe("字串");
    expect(errMessage(undefined)).toBe("發生未知錯誤");
  });
});
