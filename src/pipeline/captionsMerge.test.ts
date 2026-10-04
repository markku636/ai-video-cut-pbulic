// 範圍重辨識 / 重新分段的段落合併（驗收 Medium 1）：邊界案例逐條寫死，再用隨機輸入驗不變式（範圍外一個字都不丟、結果過得了 sanitize）。
import { describe, expect, it } from "vitest";
import type { CaptionCueV1, CaptionSourceV1, CaptionTrackV1 } from "../project/format";
import { emptyReport, sanitizeCaptionTrack } from "../project/sanitize";
import { emptyCaptionTrack, presetSegmentation } from "../store/captions";
import { mergeCaptionRange, mergeCuesInRange, rebuiltTrack, sourceRange } from "./captionsMerge";

/** 每個字各佔 per 幀、從 s 開始連著排；段尾 = 最後一個字的尾巴 + lag。 */
function cue(id: string, s: number, text: string, per = 5, lag = 0): CaptionCueV1 {
  const words = [...text].map((ch, i) => ({ text: ch, startFrame: s + i * per, endFrame: s + (i + 1) * per }));
  return { id, startFrame: s, endFrame: s + words.length * per + lag, words };
}

const SRC = (asrPath: string, extra: Partial<CaptionSourceV1> = {}): CaptionSourceV1 => ({ backend: "faster-whisper", model: "large-v3-turbo", device: "cuda", computeType: "float16", asrLanguage: "zh", detected: "zh", languageProb: 0.99, asrPath, transcribedAt: "2026-09-17T00:00:00Z", ...extra });

function track(cues: CaptionCueV1[], extra: Partial<CaptionTrackV1> = {}): CaptionTrackV1 {
  return { ...emptyCaptionTrack("subtitle", "zh-TW"), cues, ...extra };
}

const shape = (cues: readonly CaptionCueV1[]) => cues.map((c) => [c.id, c.startFrame, c.endFrame, c.words.map((w) => w.text).join("")]);

describe("sourceRange", () => {
  it("只收整數、in < out 的 [K0, K1]；夾進 [0, frames]；其他一律當整支（null）", () => {
    expect(sourceRange(SRC("a", { range: [30, 90] }))).toEqual({ in: 30, out: 90 });
    expect(sourceRange(SRC("a", { range: [-5, 9999] }), 600)).toEqual({ in: 0, out: 600 });
    for (const bad of [undefined, null, "30:90", [30], [90, 30], [30, 30], [1.5, 9], ["30", "90"], { in: 30, out: 90 }]) expect(sourceRange(SRC("a", { range: bad }))).toBeNull();
    expect(sourceRange(SRC("a", { range: [700, 800] }), 600)).toBeNull();
    expect(sourceRange(null)).toBeNull();
  });
});

describe("mergeCuesInRange 邊界", () => {
  it("一段橫跨整個範圍：拆成前後兩片，前片沿用 id、後片新編號，範圍內的字換成新辨識", () => {
    const prev = [cue("c1", 0, "一二三四五六七八")]; // 字起點 0,5,…,35
    const fresh = [cue("c1", 12, "新字")];
    const out = mergeCuesInRange(prev, fresh, { in: 10, out: 25 });
    expect(shape(out)).toEqual([
      ["c1", 0, 10, "一二"],
      ["c2", 12, 22, "新字"], // 新 c1 撞號；新編號接在「全部最大編號」之後、依時間先後發
      ["c3", 25, 40, "六七八"],
    ]);
  });

  it("段從範圍內開始、字在範圍後：保留原 id，段頭夾到範圍終點；字起點剛好 = out 算範圍外", () => {
    const out = mergeCuesInRange([cue("c7", 20, "甲乙丙")], [], { in: 10, out: 25 }); // 甲 20 在範圍內、乙 25 = out、丙 30
    expect(shape(out)).toEqual([["c7", 25, 35, "乙丙"]]);
  });

  it("跨在範圍起點上的字（起點在範圍前）歸舊段、尾巴裁到 in；新辨識比範圍多出來的幀（取整 / lag-out）夾掉", () => {
    const prev = [{ id: "c1", startFrame: 0, endFrame: 30, words: [{ text: "長", startFrame: 5, endFrame: 18 }, { text: "字", startFrame: 18, endFrame: 30 }] }];
    const fresh = [{ id: "c1", startFrame: 9, endFrame: 45, words: [{ text: "新", startFrame: 9, endFrame: 20 }, { text: "辨", startFrame: 20, endFrame: 44 }] }];
    const out = mergeCuesInRange(prev, fresh, { in: 12, out: 40 });
    expect(out.map((c) => [c.id, c.startFrame, c.endFrame, c.words.map((w) => [w.text, w.startFrame, w.endFrame])])).toEqual([
      ["c1", 0, 12, [["長", 5, 12]]],
      [
        "c2",
        12,
        40,
        [
          ["新", 12, 20],
          ["辨", 20, 40],
        ],
      ],
    ]);
  });

  it("範圍內沒有新字（辨識不出東西）：範圍內的舊字清掉、範圍外原樣", () => {
    const prev = [cue("c1", 0, "早"), cue("c2", 20, "中"), cue("c3", 50, "晚")];
    expect(shape(mergeCuesInRange(prev, [], { in: 15, out: 40 }))).toEqual([
      ["c1", 0, 5, "早"],
      ["c3", 50, 55, "晚"],
    ]);
  });
});

describe("rebuiltTrack（依樣式重新分段）", () => {
  const whole = track([cue("c1", 0, "開場白"), cue("c2", 100, "中段"), cue("c3", 300, "結尾")], { source: SRC("C:\\asr\\all.v1.json") });

  it("來源是整支 ASR → 段落整個換成新分段；預設 / 分段規則換新，樣式與燒入開關沿用", () => {
    const fresh = track([cue("c1", 0, "開場白中段結尾")], { presetId: "pop", segmentation: presetSegmentation("pop", "zh-TW"), source: SRC("C:\\asr\\all.v1.json") });
    const { track: t, range } = rebuiltTrack({ ...whole, enabled: false }, fresh, "pop");
    expect(range).toBeNull();
    expect(t.cues).toBe(fresh.cues);
    expect(t).toMatchObject({ presetId: "pop", enabled: false, segmentation: presetSegmentation("pop", "zh-TW") });
    expect(t.source?.range).toBeUndefined();
  });

  it("來源只涵蓋一段（範圍重辨識留下的）→ 只重建那段，範圍外的段是同一批物件；來源的範圍留著（下次重新分段還是只動這段）", () => {
    const cur = track(whole.cues, { source: SRC("C:\\asr\\range.v1.json", { range: [90, 200] }) });
    // captions.build 拿範圍 ASR 建出來的只有範圍內的字；source.range 引擎不會帶（前端補）
    const fresh = track([cue("c1", 100, "中"), cue("c2", 105, "段")], { presetId: "bounce", source: SRC("C:\\asr\\range.v1.json") });
    const { track: t, range } = rebuiltTrack(cur, fresh, "bounce", 600);
    expect(range).toEqual({ in: 90, out: 200 });
    expect(shape(t.cues)).toEqual([
      ["c1", 0, 15, "開場白"],
      ["c4", 100, 105, "中"],
      ["c2", 105, 110, "段"], // 舊 c2 在範圍內被換掉了，id 空出來給新的 c2
      ["c3", 300, 310, "結尾"],
    ]);
    expect(t.cues[0]).toBe(cur.cues[0]);
    expect(t.cues[3]).toBe(cur.cues[2]);
    expect(t.presetId).toBe("bounce");
    expect(t.source).toMatchObject({ asrPath: "C:\\asr\\range.v1.json", range: [90, 200] });
  });
});

describe("mergeCaptionRange（範圍重辨識）", () => {
  it("沒有舊字幕時也記下範圍：之後的重新分段才不會把範圍 ASR 當整支", () => {
    const fresh = track([cue("c1", 40, "新")], { source: SRC("r") });
    expect(mergeCaptionRange(null, fresh, { in: 30, out: 60 }).source?.range).toEqual([30, 60]);
    expect(mergeCaptionRange(null, fresh, null)).toBe(fresh);
  });
  it("source.range 存檔再開還在（sanitize 當未知鍵原樣保留、零回報；Python captions/model.py 的 _copy_unknown 同樣原樣保留）", () => {
    const merged = mergeCaptionRange(track([cue("c1", 0, "舊")]), track([cue("c1", 40, "新")], { source: SRC("r") }), { in: 30, out: 60 });
    const report = emptyReport();
    const reopened = sanitizeCaptionTrack(JSON.parse(JSON.stringify(merged)), 600, report);
    expect(report.total).toBe(0);
    expect(sourceRange(reopened?.source, 600)).toEqual({ in: 30, out: 60 });
  });
});

// ---- 不變式：隨機輸入（固定種子，失敗可重現）----

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomCues(r: () => number, prefix: string, frames: number): CaptionCueV1[] {
  const out: CaptionCueV1[] = [];
  let k = Math.floor(r() * 10);
  let n = 1;
  while (k < frames - 5) {
    const words = [];
    let w = k + Math.floor(r() * 3);
    const count = 1 + Math.floor(r() * 5);
    for (let i = 0; i < count && w < frames - 2; i++) {
      const len = 1 + Math.floor(r() * 6);
      const end = Math.min(frames - 1, w + len);
      if (end <= w) break;
      words.push({ text: `${prefix}${n}.${i}`, startFrame: w, endFrame: end });
      w = end + Math.floor(r() * 3);
    }
    if (!words.length) break;
    const end = Math.min(frames, words[words.length - 1].endFrame + Math.floor(r() * 6));
    out.push({ id: r() < 0.1 ? `x${n}` : `c${n}`, startFrame: k, endFrame: end, words });
    n++;
    k = end + Math.floor(r() * 12);
  }
  return out;
}

describe("mergeCuesInRange 不變式（300 組隨機輸入）", () => {
  it("排序、不重疊、字在段內、id 唯一、過得了 sanitize；範圍外的舊字一個不少、範圍內只剩新辨識的字", () => {
    const r = rng(20260917);
    const FRAMES = 400;
    for (let iter = 0; iter < 300; iter++) {
      const prev = randomCues(r, "舊", FRAMES);
      const a = Math.floor(r() * (FRAMES - 20));
      const b = a + 1 + Math.floor(r() * (FRAMES - a - 1));
      const fresh = randomCues(r, "新", FRAMES);
      const out = mergeCuesInRange(prev, fresh, { in: a, out: b });
      const ctx = `iter ${iter} range [${a}, ${b})`;

      const report = emptyReport();
      const clean = sanitizeCaptionTrack(track(out), FRAMES, report);
      expect(report.total, ctx).toBe(0);
      expect(clean?.cues.length, ctx).toBe(out.length);
      expect(new Set(out.map((c) => c.id)).size, ctx).toBe(out.length);

      const got = out.flatMap((c) => c.words);
      const oldOutside = prev.flatMap((c) => c.words).filter((w) => w.startFrame < a || w.startFrame >= b);
      for (const w of oldOutside) {
        const hit = got.find((g) => g.text === w.text && g.startFrame === w.startFrame);
        expect(hit, `${ctx} lost ${w.text}`).toBeTruthy();
        // 只有跨在範圍起點上的字會被裁尾巴（裁到 in），其他逐欄不變
        expect(hit!.endFrame, ctx).toBe(w.startFrame < a ? Math.min(w.endFrame, a) : w.endFrame);
      }
      for (const g of got) if (g.startFrame >= a && g.startFrame < b) expect(g.text.startsWith("新"), `${ctx} ${g.text}`).toBe(true);
      expect(got.filter((g) => g.text.startsWith("舊")).length, ctx).toBe(oldOutside.length);
    }
  });
});
