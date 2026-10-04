// 模型回來的東西 → 計畫。這一層的工作是「擋下不合法的並講得出原因」，所以測的幾乎全是壞輸入。
import { describe, expect, it } from "vitest";
import { toolByName, toolsPrompt, TOOLS } from "./catalogue";
import { buildPlan, checkParam, parseModelPlan, planSummary, runnable, toStep } from "./protocol";

const t = (zh: string, v?: Record<string, string | number>) => (v ? zh.replace(/\{(\w+)\}/g, (_, k) => String(v[k])) : zh);
const okEnabled = () => ({ ok: true }) as const;

describe("catalogue", () => {
  it("工具名字不重覆（改名等於換一個工具，重覆會讓查表拿到錯的）", () => {
    expect(new Set(TOOLS.map((x) => x.name)).size).toBe(TOOLS.length);
  });

  it("名字一律小寫底線（模型對這種格式最穩）", () => {
    for (const x of TOOLS) expect(x.name, x.name).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("command / op 一定要有 target，state / query 一定沒有", () => {
    for (const x of TOOLS) {
      if (x.kind === "state" || x.kind === "query") expect(x.target, x.name).toBeUndefined();
      else expect(x.target, x.name).toBeTruthy();
    }
  });

  it("每個工具都講得出「什麼時候用」", () => {
    for (const x of TOOLS) expect(x.describe.length, x.name).toBeGreaterThan(8);
  });

  it("會改東西的都標了 danger", () => {
    // 這幾個確實會改專案或寫檔案；漏標的話計畫上不會變紅
    for (const n of ["cut_range", "blur_background", "remove_object", "split_at_playhead"]) {
      expect(toolByName(n)?.danger, n).toBe(true);
    }
    // 開對話框的不算：它只是把東西打開給人看
    expect(toolByName("remove_silence")?.danger).toBeFalsy();
  });

  it("給模型的說明含名字、參數與 [會改東西] 標記", () => {
    const p = toolsPrompt();
    expect(p).toContain("set_range");
    expect(p).toContain("start_seconds");
    expect(p).toContain("[會改東西]");
  });
});

describe("parseModelPlan", () => {
  it("整段就是 JSON", () => {
    const r = parseModelPlan('{"say":"好","steps":[{"tool":"clear_range","args":{}}]}');
    expect(r).toEqual({ say: "好", calls: [{ name: "clear_range", args: {} }] });
  });

  it("夾在 ```json 區塊裡也吃（小模型很愛這樣包）", () => {
    const r = parseModelPlan('我來做這件事：\n```json\n{"say":"ok","steps":[{"tool":"clear_range"}]}\n```\n就這樣');
    expect(r?.calls).toEqual([{ name: "clear_range", args: {} }]);
  });

  it("前後有廢話也吃（取第一個 { 到最後一個 }）", () => {
    expect(parseModelPlan('當然可以 {"say":"x","steps":[]} 需要我繼續嗎')?.say).toBe("x");
  });

  it("純文字回 null —— 助手只是在講話，不是壞掉", () => {
    expect(parseModelPlan("這支影片大概有三個鏡頭。")).toBeNull();
    expect(parseModelPlan("")).toBeNull();
  });

  it("壞 JSON 回 null 而不是丟例外", () => {
    expect(parseModelPlan('{"steps": [')).toBeNull();
  });

  it("沒有 steps 陣列回 null", () => {
    expect(parseModelPlan('{"say":"x"}')).toBeNull();
  });

  it("跳過形狀不對的步驟，不讓一顆壞掉的毀掉整份", () => {
    const r = parseModelPlan('{"steps":[{"tool":"clear_range"},{"nope":1},"字串",{"tool":123}]}');
    expect(r?.calls).toEqual([{ name: "clear_range", args: {} }]);
  });

  it("args 不是物件就當空的（給陣列是模型常見的錯）", () => {
    expect(parseModelPlan('{"steps":[{"tool":"clear_range","args":[1,2]}]}')?.calls[0].args).toEqual({});
  });
});

describe("checkParam", () => {
  const num = { name: "n", type: "number" as const, describe: "", min: 0, max: 10 };

  it("數字寫成字串也收 —— 模型很常這樣，為這件事整步作廢不值得", () => {
    expect(checkParam(num, "5")).toEqual([5, null]);
  });

  it("空字串與看不懂的字是真的錯", () => {
    expect(checkParam(num, "")[1]).toMatch(/要是數字/);
    expect(checkParam(num, "abc")[1]).toMatch(/要是數字/);
    expect(checkParam(num, null)[1]).toMatch(/要是數字/);
  });

  it("超出範圍講得出上下限", () => {
    expect(checkParam(num, -1)[1]).toBe("n 不可以小於 0（拿到 -1）");
    expect(checkParam(num, 99)[1]).toBe("n 不可以大於 10（拿到 99）");
  });

  it("choices 只收表上的", () => {
    const p = { name: "aspect", type: "string" as const, describe: "", choices: ["9:16", "1:1"] };
    expect(checkParam(p, "9:16")).toEqual(["9:16", null]);
    expect(checkParam(p, "3:2")[1]).toMatch(/只能是/);
  });

  it("布林收 true / false 與它們的字串", () => {
    const p = { name: "b", type: "boolean" as const, describe: "" };
    expect(checkParam(p, true)).toEqual([true, null]);
    expect(checkParam(p, "false")).toEqual([false, null]);
    expect(checkParam(p, "yes")[1]).toMatch(/true 或 false/);
  });
});

describe("toStep", () => {
  it("正常的一步", () => {
    const s = toStep({ name: "set_range", args: { start_seconds: 12, end_seconds: 20 } });
    expect(s.problem).toBeNull();
    expect(s.args).toEqual({ start_seconds: 12, end_seconds: 20 });
  });

  it("模型幻想的工具會被擋下並講出名字", () => {
    const s = toStep({ name: "make_it_cinematic", args: {} });
    expect(s.problem).toBe("不認得這個工具：make_it_cinematic");
  });

  it("少了必填參數", () => {
    expect(toStep({ name: "set_range", args: { start_seconds: 1 } }).problem).toBe("少了 end_seconds");
  });

  it("多個問題一次講完，不是修一個再跑一次才發現下一個", () => {
    const s = toStep({ name: "set_range", args: { start_seconds: -5 } });
    expect(s.problem).toContain("不可以小於 0");
    expect(s.problem).toContain("少了 end_seconds");
  });

  it("用不到的參數只講一聲、不擋 —— 為一個多餘的鍵把正確的計畫判死太脆", () => {
    const s = toStep({ name: "clear_range", args: { fade: 3 } });
    expect(s.problem).toBeNull();
    expect(s.unused).toBe("fade");
    expect(s.warning).toBeUndefined();
    expect(runnable(s)).toBe(true);
  });

  it("選填參數不給是正常的", () => {
    const s = toStep({ name: "blur_background", args: { masks: "m.aivm", out: "o.mp4" } });
    expect(s.problem).toBeNull();
    expect(s.args).not.toHaveProperty("strength");
  });

  it("「現在不能按」是提醒不是錯誤 —— set_range 之後再 cut_range 是最常見的計畫", () => {
    // 建計畫的當下範圍還不存在，enabled() 當然說不行；那時候判死等於把這種計畫全部否決
    const s = toStep({ name: "cut_range", args: {} }, () => ({ ok: false, why: "先標入點與出點" }));
    expect(s.problem).toBeNull();
    expect(s.warning).toBe("先標入點與出點");
    expect(runnable(s)).toBe(true);
  });

  it("指令能按時沒有提醒", () => {
    expect(toStep({ name: "cut_range", args: {} }, () => ({ ok: true })).warning).toBeUndefined();
  });

  it("這個版本沒有那個指令是**真的**擋下來（不是提醒）", () => {
    const s = toStep({ name: "cut_range", args: {} }, () => null);
    expect(s.problem).toMatch(/沒有/);
    expect(runnable(s)).toBe(false);
  });

  it("op 與 state 不查 enabled（它們不是指令）", () => {
    const never = () => ({ ok: false, why: "不該被問到" }) as const;
    expect(toStep({ name: "clear_range", args: {} }, never).problem).toBeNull();
    expect(toStep({ name: "find_subject", args: { text: "person", frame: 10 } }, never).problem).toBeNull();
  });
});

describe("buildPlan / planSummary", () => {
  const plan = (json: string, en = okEnabled) => buildPlan(parseModelPlan(json)!, en);

  it("步驟順序照模型給的（它們常互相依賴：先設範圍再剪）", () => {
    const p = plan('{"say":"剪掉 12-20 秒","steps":[{"tool":"set_range","args":{"start_seconds":12,"end_seconds":20}},{"tool":"cut_range","args":{}}]}');
    expect(p.steps.map((s) => s.tool.name)).toEqual(["set_range", "cut_range"]);
    expect(p.steps.every(runnable)).toBe(true);
    expect(p.say).toBe("剪掉 12-20 秒");
  });

  it("壞的那一步不會毀掉其他步驟 —— 好的照樣列出來", () => {
    const p = plan('{"steps":[{"tool":"clear_range"},{"tool":"nope"},{"tool":"cut_shot_at_playhead"}]}');
    expect(p.steps.map(runnable)).toEqual([true, false, true]);
  });

  it("摘要不把「現在還不能按」算成不能執行（前面的步驟會把狀態擺好）", () => {
    const p = buildPlan(parseModelPlan('{"steps":[{"tool":"set_range","args":{"start_seconds":2,"end_seconds":4}},{"tool":"cut_range"}]}')!, () => ({ ok: false, why: "先標入點與出點" }));
    expect(planSummary(p, t)).toBe("2 步・其中 1 步會改東西");
  });

  it("摘要把「會改東西」單獨講出來", () => {
    const p = plan('{"steps":[{"tool":"set_range","args":{"start_seconds":1,"end_seconds":2}},{"tool":"cut_range"}]}');
    expect(planSummary(p, t)).toBe("2 步・其中 1 步會改東西");
  });

  it("摘要也講不能執行的步數", () => {
    const p = plan('{"steps":[{"tool":"clear_range"},{"tool":"nope"}]}');
    expect(planSummary(p, t)).toBe("1 步・1 步不能執行");
  });

  it("全部都不能執行時講清楚，不要顯示「1 步」讓人以為按了會動", () => {
    const p = plan('{"steps":[{"tool":"nope"},{"tool":"nope2"}]}');
    expect(planSummary(p, t)).toBe("這份計畫的 2 步都不能執行");
  });

  it("多餘參數不影響能不能跑", () => {
    const p = plan('{"steps":[{"tool":"clear_range","args":{"fade":2}}]}');
    expect(p.steps.every(runnable)).toBe(true);
    expect(planSummary(p, t)).toBe("1 步");
  });

  it("空計畫", () => {
    expect(planSummary(plan('{"steps":[]}'), t)).toBe("沒有要做的事");
  });
});
