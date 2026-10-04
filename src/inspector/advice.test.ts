// 「建議」分頁的規則：哪些狀態會產生哪一條、排序、上限、以及每一條都要有文字。
//
// 這張表最容易壞的地方是「加了新的 code 卻忘了寫文字」—— 症狀是面板上出現空白列。
// 按鈕文字刻意不在這張表裡：按鈕用指令自己的標題，少一份要維護的字。
// 最後一組測試逐一比對 code 與 ADVICE_TEXT，加了新 code 就會紅。
// 外掛的條目（例如牌的格位建議）由外掛算好、從 extra 傳進來：牌的規則在 plugins/cards/frontend/advice.test.ts。
import { describe, expect, it } from "vitest";
import type { PluginAdviceItem } from "../plugins/api";
import { ADVICE_TEXT, LOW_CONF_FRAMES, MAX_ADVICE, adviceFor, lowConfidenceFrames, type AdviceInput, type TrackFacts } from "./advice";
import type { Solve, SolveFrame } from "../store/solves";

const track = (over: Partial<TrackFacts> = {}): TrackFacts => ({
  id: "t1",
  label: "Player1",
  stale: false,
  solved: true,
  lowConfidenceFrames: 0,
  hasMask: true,
  ...over,
});

const input = (over: Partial<AdviceInput> = {}): AdviceInput => ({
  engineReady: true,
  hasMedia: true,
  profile: "generic",
  tracks: [track()],
  silentRanges: 0,
  ...over,
});

const codes = (i: AdviceInput) => adviceFor(i).map((a) => a.code);

describe("一切正常", () => {
  it("沒有問題也沒有建議", () => {
    expect(adviceFor(input())).toEqual([]);
  });
});

describe("擋路的東西排最前面", () => {
  it("引擎沒啟動", () => {
    const a = adviceFor(input({ engineReady: false }));
    expect(a[0]).toEqual({ code: "engine-not-ready", kind: "problem", command: "help.engineSetup" });
  });

  it("沒有素材時就不再往下檢查（其餘全是 0，列出來只是雜訊）", () => {
    expect(codes(input({ hasMedia: false, tracks: [] }))).toEqual(["no-media"]);
  });

  it("沒有素材但引擎也沒開 → 兩條都要講", () => {
    expect(codes(input({ hasMedia: false, engineReady: false }))).toEqual(["engine-not-ready", "no-media"]);
  });
});

describe("追蹤", () => {
  it("改過沒重解是問題（畫面上看到的不是會輸出的）", () => {
    expect(adviceFor(input({ tracks: [track({ stale: true })] }))[0]).toMatchObject({ code: "track-stale", kind: "problem", command: "track.trackToEnd" });
  });

  it("還沒解算是建議", () => {
    expect(codes(input({ tracks: [track({ solved: false })] }))).toContain("track-not-solved");
  });

  it("還沒解算的不會同時被說「信心低」或「沒有遮罩」", () => {
    // 那兩件事都要先有解算結果才談得上；一次噴三條等於沒有排序
    const c = codes(input({ tracks: [track({ solved: false, hasMask: false, lowConfidenceFrames: 100 })] }));
    expect(c).toContain("track-not-solved");
    expect(c).not.toContain("track-low-confidence");
    expect(c).not.toContain("track-no-mask");
  });

  it("零星幾幀紅燈不提（那是正常的）", () => {
    expect(codes(input({ tracks: [track({ lowConfidenceFrames: LOW_CONF_FRAMES - 1 })] }))).not.toContain("track-low-confidence");
    expect(codes(input({ tracks: [track({ lowConfidenceFrames: LOW_CONF_FRAMES })] }))).toContain("track-low-confidence");
  });

  it("沒有追蹤時提「建立追蹤」，而且依模式給不同入口（工作模式的自動偵測；沒有就新增追蹤）", () => {
    expect(adviceFor(input({ tracks: [] })).find((a) => a.code === "no-tracks")?.command).toBe("track.new");
    expect(adviceFor(input({ tracks: [], noTracksCommand: "x.detect" })).find((a) => a.code === "no-tracks")?.command).toBe("x.detect");
  });

  it("只有物件 track（沒有平面 track）：不提「建立追蹤」，也不算「還沒解算」", () => {
    expect(codes(input({ tracks: [], objects: 2 }))).toEqual([]);
  });

  it("沒有遮罩會提（手經過時新牌面會蓋在上面）", () => {
    expect(codes(input({ tracks: [track({ hasMask: false })] }))).toContain("track-no-mask");
  });
});

describe("序列", () => {
  it("有夠長的靜音就提", () => {
    const a = adviceFor(input({ silentRanges: 5 }));
    expect(a[0]).toMatchObject({ code: "sequence-silence", params: { n: 5 }, command: "sequence.removeSilence" });
  });
});

describe("外掛的條目（extra）排進固定的位置", () => {
  const ex = (code: string, kind: PluginAdviceItem["kind"], slot: PluginAdviceItem["slot"]): PluginAdviceItem => ({ code, kind, slot, params: { n: 1 } });

  it("head 排在引擎之後、其餘問題之前；afterUnsolved 接在「還沒解算」後面；tail 在最後；slot 不會漏到結果裡", () => {
    const a = adviceFor(
      input({
        engineReady: false,
        tracks: [track({ stale: true }), track({ solved: false, hasMask: false })],
        extra: [ex("x-tail", "suggestion", "tail"), ex("x-head", "problem", "head"), ex("x-mid", "suggestion", "afterUnsolved")],
      }),
    );
    // 上限 MAX_ADVICE 條：這裡剛好 6 條（沒有遮罩的那條還沒解算，不另外提）
    expect(a.map((x) => x.code)).toEqual(["engine-not-ready", "x-head", "track-stale", "track-not-solved", "x-mid", "x-tail"]);
    expect(codes(input({ silentRanges: 2, extra: [ex("x-tail", "suggestion", "tail")] }))).toEqual(["sequence-silence", "x-tail"]);
    expect(a.every((x) => !("slot" in x))).toBe(true);
  });

  it("沒有素材時外掛的條目也不出現", () => {
    expect(codes(input({ hasMedia: false, extra: [ex("x-head", "problem", "head")] }))).toEqual(["no-media"]);
  });
});

describe("排序與上限", () => {
  it("問題一律排在建議前面", () => {
    const a = adviceFor(input({ engineReady: false, tracks: [track({ stale: true, hasMask: false })], silentRanges: 1 }));
    const firstSuggestion = a.findIndex((x) => x.kind === "suggestion");
    expect(firstSuggestion).toBeGreaterThan(0);
    expect(a.slice(0, firstSuggestion).every((x) => x.kind === "problem")).toBe(true);
  });

  it("最多 {MAX_ADVICE} 條", () => {
    const many = adviceFor(
      input({
        engineReady: false,
        tracks: [track({ stale: true, lowConfidenceFrames: 99 }), track({ solved: false }), track({ hasMask: false })],
        silentRanges: 3,
      }),
    );
    expect(many.length).toBeLessThanOrEqual(MAX_ADVICE);
  });
});

describe("lowConfidenceFrames", () => {
  const f = (conf: number, state = 1): SolveFrame => ({ k: 0, h: [1, 0, 0, 0, 1, 0, 0, 0] as unknown as SolveFrame["h"], conf, state: state as SolveFrame["state"] });
  const solve = (frames: SolveFrame[]): Solve => ({ version: 1, trackId: "t1", shot: [0, frames.length], anchorK: 0, template: { w: 10, h: 10 }, frames });

  it("沒有解算回 0（那是「還沒解」，不是「解得爛」）", () => {
    expect(lowConfidenceFrames(undefined)).toBe(0);
  });

  it("數紅燈：信心 <0.35 或 lost", () => {
    expect(lowConfidenceFrames(solve([f(0.9), f(0.5), f(0.2), f(0.9, 3)]))).toBe(2);
  });
});

describe("每一條 code 都要有文字", () => {
  it("標題與說明都不是空的", () => {
    for (const [code, txt] of Object.entries(ADVICE_TEXT)) {
      expect(txt.title.trim(), code).not.toBe("");
      expect(txt.hint.trim(), code).not.toBe("");
    }
  });

  it("帶 {n} 的標題一定會拿到 n（否則面板會印出字面的 {n}）", () => {
    const needsN = Object.entries(ADVICE_TEXT).filter(([, v]) => v.title.includes("{n}")).map(([k]) => k);
    const produced = adviceFor(
      input({
        engineReady: false,
        tracks: [track({ stale: true, lowConfidenceFrames: 99 })],
        silentRanges: 2,
      }),
    );
    for (const a of produced) {
      if (needsN.includes(a.code)) expect(a.params?.n, a.code).toBeTypeOf("number");
    }
  });
});
