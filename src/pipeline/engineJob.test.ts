import { describe, expect, it, vi } from "vitest";
import type { EngineProgress } from "../api";
import type { Job } from "../store/jobs";

// engineJob → api → Tauri；這裡只驗純函式
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const { NO_PIPELINE_PROGRESS, etaText, jobProgressText, jobRemainingS, nextPipelineProgress } = await import("./engineJob");

const ev = (stage: string, done: number, total: number, extra: Partial<EngineProgress> = {}): EngineProgress => ({
  job_id: "j1",
  stage,
  done,
  total,
  pct: (done / total) * 100,
  ...extra,
});
/** pipeline 大步事件：pct 由 Rust 算（done/total），step 是 stage 名。 */
const step = (i: number, name: string): EngineProgress => ev("pipeline", i, 9, { step: name });

// 繁中原文就是 key：測試裡的 t 直接回原文並填佔位符（與 i18n.interpolate 同語意）
const tr = ((zh: string, params?: Record<string, string | number>) => (params ? zh.replace(/\{(\w+)\}/g, (w, k: string) => (k in params ? String(params[k]) : w)) : zh)) as never;

const feed = (events: EngineProgress[]) => events.reduce(nextPipelineProgress, NO_PIPELINE_PROGRESS);

describe("B-14：偵測進度要單調、要講第幾步、要講還剩多久", () => {
  it("大步索引與總步數跟著 pipeline 事件走", () => {
    const p = feed([step(0, "probe"), step(1, "index"), step(2, "shots"), step(3, "detect"), step(4, "seg")]);
    expect(p.stageIdx).toBe(4);
    expect(p.stageCount).toBe(9);
  });

  it("總進度 = (第幾步 + 這一步的細進度) / 總步數，而且**不會倒退**", () => {
    // 物件遮罩（第 5 步，index 4）跑到最後一幀：以前這裡會顯示 100%
    const segDone = feed([step(4, "seg"), ev("seg", 209, 209)]);
    expect(segDone.overall).toBeCloseTo((5 / 9) * 100, 5);
    // 接著追蹤的第一筆（3/836 ≈ 0.36%）：以前 pct 直接掉回 0
    const trackStart = nextPipelineProgress(nextPipelineProgress(segDone, step(5, "track")), ev("track", 3, 836));
    expect(trackStart.overall).toBeGreaterThanOrEqual(segDone.overall!);
    expect(trackStart.overall).toBeCloseTo(((5 + 3 / 836) / 9) * 100, 3);
  });

  it("實際數字：偵測 13/15 → 43%、物件遮罩 90/209 → 49%", () => {
    expect(Math.round(feed([step(3, "detect"), ev("detect", 13, 15)]).overall!)).toBe(43);
    expect(Math.round(feed([step(4, "seg"), ev("seg", 90, 209)]).overall!)).toBe(49);
  });

  it("細進度亂跳也不會讓總進度倒退", () => {
    const p = feed([step(5, "track"), ev("track", 800, 836), ev("track.all", 1, 4), ev("track", 5, 836)]);
    expect(p.overall).toBeCloseTo(((5 + 800 / 836) / 9) * 100, 3);
  });

  it("不是多段 op（沒有 pipeline 事件）時照舊用它自己的百分比", () => {
    const p = feed([ev("seg.propagate", 40, 100)]);
    expect(p.stageIdx).toBeNull();
    expect(p.overall).toBe(40);
  });

  it("引擎的 eta_s 收下來；換大步時把上一段的剩餘時間丟掉", () => {
    const seg = feed([step(4, "seg"), ev("seg", 100, 209, { eta_s: 9.4 })]);
    expect(seg.etaS).toBe(9.4);
    const nextStage = nextPipelineProgress(seg, step(5, "track"));
    expect(nextStage.etaS).toBeNull();
  });

  it("剩餘時間取「這一步還要多久」與「照總進度外推」的大值", () => {
    const now = 1_000_000;
    const job = { pct: 55, etaS: 40, startedAt: now - 30_000 };
    // 照總進度：30 s 走了 55% → 還要 24.5 s；引擎說這一步還要 40 s → 取 40
    expect(jobRemainingS(job, now)).toBeCloseTo(40, 5);
    expect(jobRemainingS({ ...job, etaS: null }, now)).toBeCloseTo((30 * 45) / 55, 5);
    // 剛開始（進度太小 / 時間太短）不亂猜
    expect(jobRemainingS({ pct: 1, etaS: null, startedAt: now - 30_000 }, now)).toBeNull();
    expect(jobRemainingS({ pct: 50, etaS: null, startedAt: now - 500 }, now)).toBeNull();
    // 離譜的數字寧可不顯示
    expect(jobRemainingS({ pct: 0.0001, etaS: 99_999, startedAt: now - 30_000 }, now)).toBeNull();
  });

  it("秒數的人話：不到一分鐘講秒，超過講分秒", () => {
    expect(etaText(40.4, tr)).toBe("約剩 40 秒");
    expect(etaText(0, tr)).toBe("約剩 0 秒");
    expect(etaText(125, tr)).toBe("約剩 2 分 05 秒");
  });

  it("狀態列那一行：物件遮罩（第 4/9 步）· 43% · 約剩 40 秒", () => {
    const now = 1_000_000;
    const job: Pick<Job, "kind" | "step" | "pct" | "stageIdx" | "stageCount" | "etaS" | "status" | "startedAt"> = {
      kind: "recognize",
      step: "物件遮罩",
      pct: 43,
      stageIdx: 3,
      stageCount: 9,
      etaS: 40,
      status: "running",
      startedAt: now - 20_000,
    };
    expect(jobProgressText(job, tr, now)).toBe("物件遮罩（第 4/9 步）· 43% · 約剩 40 秒");
    // 排隊中：沒有百分比也沒有剩餘時間
    expect(jobProgressText({ ...job, status: "queued", pct: null, stageIdx: undefined, stageCount: undefined, etaS: null }, tr, now)).toBe("物件遮罩 · 排隊中");
    // 最後一步不會顯示成「第 10/9 步」
    expect(jobProgressText({ ...job, stageIdx: 9, pct: 100, etaS: null }, tr, now)).toContain("（第 9/9 步）");
  });
});
