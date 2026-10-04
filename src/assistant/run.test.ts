// 執行層的純函式：秒 → 幀、引擎參數的補齊。
// 錯得最兇的一定是參數，所以這裡測的是「模型不該決定的東西有沒有被補對」。
import { describe, expect, it } from "vitest";
import { frameImageOf, frameOf, humanOf, LONG_TOOLS, maskDirOf, opArgs, parseFrameSpan, resultNote, viewFrameOf, type RunContext } from "./run";

const ctx: RunContext = { mediaId: "m1", video: "D:\\v\\a.mp4", fps: { num: 24, den: 1 }, frames: 209, cacheDir: "D:\\cache", sam: "small", outDir: "D:\\out" };

describe("frameOf", () => {
  it("秒 → 幀，四捨五入", () => {
    // 12 秒 × 24 fps = 288（片長夠時才看得到沒被夾）
    expect(frameOf(12, ctx.fps, 1000)).toBe(288);
    expect(frameOf(0.5, ctx.fps, 1000)).toBe(12);
  });

  it("夾在影片長度內 —— 超出去會讓引擎報一句看不懂的錯", () => {
    expect(frameOf(9999, ctx.fps, 209)).toBe(208);
    expect(frameOf(-5, ctx.fps, 209)).toBe(0);
  });

  it("空影片不會回 -1", () => {
    expect(frameOf(3, ctx.fps, 0)).toBe(0);
  });

  it("非整數 fps 也對（24000/1001）", () => {
    expect(frameOf(1, { num: 24000, den: 1001 }, 9999)).toBe(24);
  });
});

describe("parseFrameSpan", () => {
  it("K0:K1", () => {
    expect(parseFrameSpan("60:160")).toEqual([60, 160]);
    expect(parseFrameSpan(" 0 : 5 ")).toEqual([0, 5]);
  });

  it("倒過來或看不懂回 null", () => {
    expect(parseFrameSpan("160:60")).toBeNull();
    expect(parseFrameSpan("60")).toBeNull();
    expect(parseFrameSpan("a:b")).toBeNull();
  });
});

describe("maskDirOf", () => {
  it("每次一個獨立資料夾，同一輪對話跑兩次才不會互相覆蓋", () => {
    expect(maskDirOf("D:\\cache", 1234)).toBe("D:\\cache\\assistant-1234");
    expect(maskDirOf("/home/a/cache", 1234)).toBe("/home/a/cache/assistant-1234");
  });
});

describe("opArgs", () => {
  it("一律補上影片路徑 —— 工具表刻意不含 video，少一個模型可以講錯的東西", () => {
    for (const n of ["find_subject", "track_subject", "blur_background", "remove_object", "auto_reframe"]) {
      const a = opArgs(n, { masks: "m", out: "o", box: "1,2,3,4", frames: "0:9", anchor: 0, text: "person", frame: 0, aspect: "9:16" }, ctx);
      expect(a.video, n).toBe(ctx.video);
    }
  });

  it("track_subject 補上 SAM 變體與遮罩落點，box 要包成陣列", () => {
    const a = opArgs("track_subject", { box: "1,2,3,4", frames: "0:9", anchor: 5, out: "" }, ctx, 99);
    expect(a).toMatchObject({ box: ["1,2,3,4"], sam: "small", dir: "both", previews: 0, out: "D:\\cache\\assistant-99" });
  });

  it("遮罩落點不由模型決定 —— 它講什麼都以 App 算的為準（同 video / sam）", () => {
    // 落點是實作細節。讓模型挑等於多開一個它可以講錯的地方，而且工具表也不再收這個參數
    expect(opArgs("track_subject", { box: "1,2,3,4", frames: "0:9", anchor: 5, out: "D:\\模型亂講" }, ctx, 7).out).toBe("D:\\cache\\assistant-7");
  });

  it("blur_background 的 masks 要包成陣列（引擎收的是可重複的 --masks）", () => {
    expect(opArgs("blur_background", { masks: "m.aivm", out: "o.mp4" }, ctx).masks).toEqual(["m.aivm"]);
  });

  it("換色與強度互斥：給了顏色就不送 strength", () => {
    const a = opArgs("blur_background", { masks: "m", out: "o", color: "0,120,0", strength: 2 }, ctx);
    expect(a).toMatchObject({ color: "0,120,0" });
    expect(a).not.toHaveProperty("strength");
  });

  it("沒給輸出路徑就自己算一個 —— 模型不知道使用者的輸出資料夾在哪", () => {
    expect(opArgs("blur_background", { masks: "m" }, ctx).out).toBe("D:\\out\\a.aivc.bg.mp4");
    expect(opArgs("remove_object", { masks: "m" }, ctx).out).toBe("D:\\out\\a.aivc.clean.mp4");
  });

  it("沒設定輸出資料夾就放在來源旁邊", () => {
    const noDir = { ...ctx, outDir: null };
    expect(opArgs("blur_background", { masks: "m" }, noDir).out).toBe("D:\\v\\a.aivc.bg.mp4");
  });

  it("模型真的給了路徑就用它的（這個參數是選填、不是被忽略）", () => {
    expect(opArgs("blur_background", { masks: "m", out: "D:\\他選的.mp4" }, ctx).out).toBe("D:\\他選的.mp4");
  });

  it("沒給的選填參數不會送出去（讓引擎用自己的預設）", () => {
    const a = opArgs("blur_background", { masks: "m", out: "o" }, ctx);
    expect(a).not.toHaveProperty("frames");
    expect(a).not.toHaveProperty("strength");
  });
});

describe("humanOf", () => {
  it("取引擎那一句人話的第一行", () => {
    expect(humanOf({ _human: "100 幀 → out.mp4\n  背景虛化 半徑 19 px" })).toBe("100 幀 → out.mp4");
  });

  it("沒有就回空字串（呼叫端會退回自己的句子）", () => {
    expect(humanOf({})).toBe("");
    expect(humanOf(null)).toBe("");
    expect(humanOf({ _human: 42 })).toBe("");
  });
});

describe("resultNote（把執行結果回報給模型）", () => {
  const step = (name: string, title: string) => ({ tool: { name, title } });

  it("找到的框要帶回去 —— 沒有它，模型規劃不出下一步的 track_subject", () => {
    const note = resultNote(
      [step("find_subject", "用文字找目標")],
      [{ ok: true, message: "找到 1 個", data: { boxes: [{ box: [4.2, 0, 1246.8, 309], phrase: "person", score: 0.18 }] } }],
    );
    expect(note).toContain('框 "4,0,1247,309"');
    expect(note).toContain("person");
  });

  it("找不到東西時講得出下一步怎麼辦", () => {
    const note = resultNote([step("find_subject", "用文字找目標")], [{ ok: true, message: "找到 0 個", data: { boxes: [] } }]);
    expect(note).toContain("英文通常比較準");
  });

  it("最多帶四個框（跟一次最多追幾個對齊，再多也用不到）", () => {
    const boxes = Array.from({ length: 8 }, (_, i) => ({ box: [i, 0, 10, 10], phrase: "x", score: 0.5 }));
    const note = resultNote([step("find_subject", "找")], [{ ok: true, message: "", data: { boxes } }]);
    expect(note.match(/框 "/g)).toHaveLength(4);
  });

  it("追蹤回報遮罩檔的路徑（虛化與移除物件都要它）", () => {
    const note = resultNote(
      [step("track_subject", "追蹤")],
      [{ ok: true, message: "好", data: { objects: [{ path: "D:\\c\\obj1\\masks.aivm" }] } }],
    );
    expect(note).toContain("D:\\c\\obj1\\masks.aivm");
  });

  it("其他 op 回報輸出檔", () => {
    expect(resultNote([step("blur_background", "虛化")], [{ ok: true, message: "好", data: { out: "D:\\o.mp4" } }])).toContain("輸出：D:\\o.mp4");
  });

  it("失敗也要回報 —— 模型要知道才不會接著規劃下一步", () => {
    const note = resultNote([step("cut_range", "剪掉範圍")], [{ ok: false, message: "先標入點與出點" }]);
    expect(note).toContain("失敗");
    expect(note).toContain("先標入點與出點");
  });

  it("沒有 data 就只有一行，不會多印空白", () => {
    expect(resultNote([step("clear_range", "清除範圍")], [{ ok: true, message: "已清除範圍" }])).toBe("1. 清除範圍：成功 —— 已清除範圍");
  });

  it("結果比步驟多時不會爆（防呼叫端算錯）", () => {
    expect(() => resultNote([], [{ ok: true, message: "x" }])).not.toThrow();
  });
});

describe("重構圖的兩步", () => {
  it("第一步的路徑檔落點與對話框那條路一致，模型不必編", () => {
    const a = opArgs("auto_reframe", { aspect: "9:16" }, ctx);
    expect(a.out).toBe("D:\\out\\a.aivc.reframe.9x16.reframe.json");
    expect(a.aspect).toBe("9:16");
  });

  it("第二步要拿第一步的路徑檔，輸出檔名自己算", () => {
    const a = opArgs("apply_reframe", { path: "D:\\out\\a.9x16.reframe.json" }, ctx);
    expect(a).toMatchObject({ path: "D:\\out\\a.9x16.reframe.json", out: "D:\\out\\a.aivc.reframe.mp4" });
  });

  it("沒設定輸出資料夾就放來源旁邊", () => {
    expect(opArgs("apply_reframe", { path: "p.json" }, { ...ctx, outDir: null }).out).toBe("D:\\v\\a.aivc.reframe.mp4");
  });
});

describe("描框（mark_subject）", () => {
  it("輸出檔名跟虛化、移除物件分開，不會互相覆蓋", () => {
    const outs = [
      opArgs("mark_subject", { masks: "m" }, ctx).out,
      opArgs("blur_background", { masks: "m" }, ctx).out,
      opArgs("remove_object", { masks: "m" }, ctx).out,
    ];
    expect(new Set(outs).size).toBe(3);
    expect(outs[0]).toMatch(/aivc\.mark\.mp4$/);
  });

  it("沒給的選項不送，讓引擎用自己的預設", () => {
    const a = opArgs("mark_subject", { masks: "m" }, ctx);
    for (const k of ["mode", "color", "opacity", "frames"]) expect(a).not.toHaveProperty(k);
  });

  it("給了就送；opacity 0 不會被當成沒給", () => {
    const a = opArgs("mark_subject", { masks: "m", mode: "box", color: "0,255,0", opacity: 0 }, ctx);
    expect(a).toMatchObject({ mode: "box", color: "0,255,0", opacity: 0 });
  });

  it("masks 要包成陣列（引擎收的是可重複的 --masks）", () => {
    expect(opArgs("mark_subject", { masks: "m.aivm" }, ctx).masks).toEqual(["m.aivm"]);
  });
});

describe("resultNote：查詢工具回報的是秒數與那一句", () => {
  const step = (name: string, title: string) => ({ tool: { name, title } });

  it("find_in_transcript：列出命中的秒數與文字，並講總數", () => {
    const note = resultNote(
      [step("find_in_transcript", "在字幕裡找一句話")],
      [{ ok: true, message: "找到 2 處", data: { hits: [{ cueId: "c1", start: 5, end: 20, text: "規則很簡單" }], total: 2 } }],
    );
    expect(note).toContain("5.0–20.0 秒「規則很簡單」");
    expect(note).toContain("共 2 處，只列前 1");
  });

  it("find_in_transcript 沒找到：講清楚，模型才不會自己編秒數", () => {
    const note = resultNote([step("find_in_transcript", "在字幕裡找一句話")], [{ ok: true, message: "沒有找到", data: { hits: [], total: 0 } }]);
    expect(note).toContain("沒有找到");
  });

  it("list_shots：鏡頭編號與秒數", () => {
    const note = resultNote([step("list_shots", "列出鏡頭")], [{ ok: true, message: "2 個鏡頭", data: { spans: [{ index: 1, start: 0, end: 2 }, { index: 2, start: 2, end: 10 }] } }]);
    expect(note).toContain("鏡頭 1：0.0–2.0 秒");
    expect(note).toContain("鏡頭 2：2.0–10.0 秒");
  });
});

describe("view_frame：看哪一幀、圖放哪", () => {
  it("frame 優先、其次 seconds、都沒給就是播放線；一律夾在影片範圍內", () => {
    expect(viewFrameOf({ frame: 12, seconds: 9 }, ctx, 100)).toBe(12);
    expect(viewFrameOf({ seconds: 2 }, ctx, 100)).toBe(48);
    expect(viewFrameOf({}, ctx, 100.4)).toBe(100);
    expect(viewFrameOf({ frame: 9999 }, ctx, 0)).toBe(208);
    expect(viewFrameOf({}, ctx, -3)).toBe(0);
  });

  it("圖放在這支媒體的快取裡（MCP 只肯讀 App 快取底下的圖），格線版另外一張", () => {
    expect(frameImageOf("D:\\cache\\media\\ab", 12, true)).toBe("D:\\cache\\media\\ab\\assistant-frames\\frame-12-grid.png");
    expect(frameImageOf("/c/media/ab", 3, false)).toBe("/c/media/ab/assistant-frames/frame-3.png");
  });

  it("HTTP 助手看不到圖：回報裡至少講清楚是哪一幀、圖在哪", () => {
    const note = resultNote([{ tool: { name: "view_frame", title: "看一幀畫面" } }], [{ ok: true, message: "k=12", data: { frame: 12, grid: true, images: ["D:\\c\\f.png"] } }]);
    expect(note).toContain("第 12 幀");
    expect(note).toContain("D:\\c\\f.png");
  });

  it("長工作清單：追蹤與輸出走 job", () => {
    expect(LONG_TOOLS.has("track_subject")).toBe(true);
    expect(LONG_TOOLS.has("view_frame")).toBe(false);
  });
});
