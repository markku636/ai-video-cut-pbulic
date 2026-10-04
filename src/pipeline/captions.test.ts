// 字幕管線的純函式：面板選項 → 引擎 args（dest 名）、範圍重辨識的合併、LLM 建議解析、版面視窗 / 快取路徑。
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));

const P = await import("./captions");
const { emptyCaptionTrack, parseLayoutDoc, CAPTION_PRESETS } = await import("../store/captions");
import type { CaptionCueV1, CaptionTrackV1 } from "../project/format";
import type { TranscribeOptions } from "../store/captions";

const OPTS: TranscribeOptions = { model: "large-v3-turbo", language: "zh", device: "auto", preset: "pop", hotwords: [], initialPrompt: "", refine: false, scope: "all" };
const F30 = { num: 30, den: 1 };

function cue(id: string, s: number, e: number, text = "字"): CaptionCueV1 {
  const n = [...text].length;
  const step = Math.max(1, Math.floor((e - s) / n));
  return { id, startFrame: s, endFrame: e, words: [...text].map((ch, i) => ({ text: ch, startFrame: s + i * step, endFrame: i === n - 1 ? e : s + (i + 1) * step })) };
}

function track(cues: CaptionCueV1[], extra: Partial<CaptionTrackV1> = {}): CaptionTrackV1 {
  return { ...emptyCaptionTrack("subtitle", "zh-TW"), cues, ...extra };
}

describe("engine args（argparse dest 名）", () => {
  it("asr.transcribe：預設值不送；熱詞是陣列（--hotwords action=append）；範圍 K0:K1", () => {
    expect(P.transcribeArgs("C:\\p.aivc.json", "m1", OPTS, null)).toEqual({ project: "C:\\p.aivc.json", media: "m1", model: "large-v3-turbo", language: "zh", device: "auto" });
    expect(P.transcribeArgs("p", "m1", { ...OPTS, language: "", device: "cpu", hotwords: ["百家姓", "店家"], initialPrompt: "  以下是逐字稿。 " }, { in: 30, out: 90 })).toEqual({
      project: "p",
      media: "m1",
      model: "large-v3-turbo",
      language: "auto",
      device: "cpu",
      initial_prompt: "以下是逐字稿。",
      hotwords: ["百家姓", "店家"],
      range: "30:90",
    });
  });
  it("captions.build 一律 no_save（store 才是真相）；輸出語言沒有就不送", () => {
    expect(P.buildArgs("p", "m1", "C:\\asr.json", "karaoke", "zh-TW")).toEqual({ project: "p", media: "m1", asr: "C:\\asr.json", preset: "karaoke", language: "zh-TW", no_save: true });
    expect(P.buildArgs("p", "m1", "a", "subtitle", null)).not.toHaveProperty("language");
  });
  it("captions.export：trim 只在有範圍時送", () => {
    expect(P.exportArgs("p", "m1", "srt", "D:\\out.srt")).toEqual({ project: "p", media: "m1", format: "srt", out: "D:\\out.srt" });
    expect(P.exportArgs("p", "m1", "vtt", "o", null, true)).not.toHaveProperty("trim");
    expect(P.exportArgs("p", "m1", "vtt", "o", { in: 30, out: 90 }, true)).toMatchObject({ range: "30:90", trim: true });
  });
  it("progress stage → 顯示文字", () => {
    expect(P.captionStageLabel("asr.download")).toBe("下載語音模型");
    expect(P.captionStageLabel("asr.load")).toBe("載入語音模型");
    expect(P.captionStageLabel("asr.decode")).toBe("語音辨識");
    expect(P.captionStageLabel("refine")).toBe("本機 LLM 校對");
    expect(P.captionStageLabel("weird")).toBe("weird");
  });
});

describe("mergeCaptionRange（只重辨識 I/O 範圍）", () => {
  it("沒有舊 track → 新的原樣；整支重來 → 段換新、樣式與燒入開關沿用", () => {
    const fresh = track([cue("c1", 0, 10)], { presetId: "pop" });
    expect(P.mergeCaptionRange(null, fresh, null)).toBe(fresh);
    const prev = track([cue("c1", 0, 5)], { enabled: false, style: { font: { sizePctShortSide: 9 } } as never });
    const m = P.mergeCaptionRange(prev, fresh, null);
    expect(m.cues).toBe(fresh.cues);
    expect(m).toMatchObject({ enabled: false, presetId: "pop", style: { font: { sizePctShortSide: 9 } } });
  });
  it("範圍外的舊段原樣留（跨界段只留範圍外的字）、範圍內換新；撞號重新編；新段夾進範圍；來源記下範圍", () => {
    const prev = track([cue("c1", 0, 20, "開場"), cue("c2", 25, 45, "中間"), cue("c3", 100, 120, "結尾")]);
    const fresh = track([cue("c1", 30, 60, "新的一"), cue("c2", 61, 99, "新的二"), cue("c3", 110, 130, "範圍外")], { source: { backend: "faster-whisper", model: "tiny", device: "cpu", computeType: "int8", asrLanguage: "zh", detected: "zh", languageProb: 1, asrPath: "C:\\asr\\r.v1.json", transcribedAt: "" } });
    const m = P.mergeCaptionRange(prev, fresh, { in: 30, out: 100 });
    expect(m.cues.map((c) => [c.id, c.startFrame, c.endFrame, c.words.map((w) => w.text).join("")])).toEqual([
      ["c1", 0, 20, "開場"],
      ["c2", 25, 30, "中"], // 跨界：「中」起點 25 在範圍前 → 留下（裁到 30）；「間」起點 35 在範圍內 → 交給新辨識
      ["c4", 30, 60, "新的一"], // 新 c1 撞到留下來的舊 c1 → 重新編號
      ["c5", 61, 99, "新的二"], // 新 c2 撞到留下來的舊 c2（前半片）→ 重新編號
      ["c3", 100, 120, "結尾"],
    ]);
    expect(m.cues[0]).toBe(prev.cues[0]); // 完全在範圍外 = 同一個物件（舞台版面快取靠參考）
    expect(m.source).toMatchObject({ asrPath: "C:\\asr\\r.v1.json", range: [30, 100] });
    // 舊段的 lag-out 伸進範圍但字都在範圍前：原樣留下；新段比範圍早一兩幀（取整）→ 夾到範圍起點，不去裁舊段
    const overlap = P.mergeCaptionRange(track([cue("c1", 0, 40, "舊段落")]), track([cue("n1", 35, 60, "新")]), { in: 40, out: 60 });
    expect(overlap.cues.map((c) => [c.id, c.startFrame, c.endFrame])).toEqual([
      ["c1", 0, 40],
      ["n1", 40, 60],
    ]);
    expect(overlap.cues[1].words).toEqual([{ text: "新", startFrame: 40, endFrame: 60 }]);
  });
});

describe("parseRefineResult", () => {
  const cues = [cue("c1", 0, 30, "店家翻開紅星"), cue("c2", 40, 50, "好")];
  it("引擎形狀 {proposals:[{cueId, before, after, emphasis, accepted}]}：引擎擋掉的不給人看；沒變也沒強調的略過", () => {
    const items = P.parseRefineResult(
      {
        proposals: [
          { cueId: "c1", before: "x", after: "店家翻開紅心", emphasis: ["紅心"], accepted: true },
          { cueId: "c2", after: "壞", accepted: false, reason: "similarity" },
          { cueId: "c2", after: "好", emphasis: [], accepted: true },
          { cueId: "ghost", after: "x", accepted: true },
        ],
      },
      cues,
    );
    expect(items).toEqual([{ cueId: "c1", before: "店家翻開紅星", after: "店家翻開紅心", emphasis: ["紅心"] }]);
  });
  it("refineWarnings：引擎降級成「0 則建議 + 警告」時要算失敗（驗收 Low：之前只看建議數，跳「沒有修改建議」）", () => {
    // 實測形狀（端點關掉時 captions-refine exit 0）
    const down = P.refineWarnings({ endpoint: "http://localhost:1234/v1", reachable: false, proposals: [], warnings: ["本機 LLM 端點 http://localhost:1234/v1 無法連線，略過校對"] }, "http://localhost:1234/v1");
    expect(down.failed).toBe(true);
    expect(down.warnings.map((w) => w.code)).toEqual(["llmUnreachable"]);
    // 回傳壞掉：連得上、但每批都是格式警告
    expect(P.refineWarnings({ reachable: true, proposals: [], warnings: ["本機 LLM 回傳格式不正確（第 1/1 批：頂層應該是物件，收到 list），保留原文"] }, "e").failed).toBe(true);
    // reachable:false 卻沒附警告：補一則連不上（帶端點）
    expect(P.refineWarnings({ reachable: false }, "http://h/v1").warnings).toEqual([{ code: "llmUnreachable", params: { endpoint: "http://h/v1" }, message: "" }]);
    // 正常、或只有非 LLM 的警告：不算失敗
    expect(P.refineWarnings({ reachable: true, warnings: [] }, "e")).toEqual({ warnings: [], failed: false });
    expect(P.refineWarnings(null, "e").failed).toBe(false);
  });
  it("也收規格 §5.4 的 {cues:[{id, text, emphasis}]}；垃圾輸入回空", () => {
    expect(P.parseRefineResult({ cues: [{ id: "c2", text: "好！", emphasis: [1, "好"] }] }, cues)).toEqual([{ cueId: "c2", before: "好", after: "好！", emphasis: ["好"] }]);
    expect(P.parseRefineResult(null, cues)).toEqual([]);
    expect(P.parseRefineResult({ proposals: "x" }, cues)).toEqual([]);
  });
});

describe("舞台版面視窗 / 快取路徑", () => {
  it("cacheRelPath：<cache>/media/<fp16>/ 之後那段，分隔符統一 /；找不到媒體段或含 .. → null", () => {
    expect(P.cacheRelPath("C:\\Users\\a\\AppData\\Local\\app\\media\\0123456789abcdef\\captions\\k1\\layout.v1.json", "0123456789abcdef")).toBe("captions/k1/layout.v1.json");
    expect(P.cacheRelPath("/tmp/media/0123456789abcdef/captions/k/layout.v1.json", "0123456789abcdef")).toBe("captions/k/layout.v1.json");
    expect(P.cacheRelPath("C:\\x\\layout.v1.json", "0123456789abcdef")).toBeNull();
    expect(P.cacheRelPath("C:\\media\\0123456789abcdef\\..\\x", "0123456789abcdef")).toBeNull();
  });
  it("layoutWindow：播放線 ±90 秒、夾在 [0, frames]", () => {
    expect(P.layoutWindow(100, 5000, F30)).toEqual([0, 2800]);
    expect(P.layoutWindow(4000, 5000, F30)).toEqual([1300, 5000]);
  });
  it("layoutIsCurrent：track 設定 / 視窗內的段換了參考、段數變了、播放線靠近視窗邊緣 → 要重要版面", () => {
    const t = track([cue("c1", 0, 30), cue("c2", 3000, 3030)]);
    const doc = parseLayoutDoc({ version: 1, size: [1280, 720], fps: F30, range: [0, 2800], atlas: { path: "atlas.v1.png", w: 1, h: 1, supersample: 1.25 }, style: CAPTION_PRESETS.subtitle.style, cues: [] })!;
    const l = { mediaId: "m1", doc, atlas: {} as CanvasImageSource, byId: new Map(), cues: new Map(t.cues.map((c) => [c.id, c])), sig: { presetId: t.presetId, style: t.style, segmentation: t.segmentation, language: t.language } };
    expect(P.layoutIsCurrent(l, "m1", t, 100, 5000, F30)).toBe(true);
    expect(P.layoutIsCurrent(l, "m1", t, 2000, 5000, F30)).toBe(false); // 離右緣不到 30 秒
    expect(P.layoutIsCurrent(l, "m2", t, 100, 5000, F30)).toBe(false);
    expect(P.layoutIsCurrent(l, "m1", { ...t, presetId: "pop" }, 100, 5000, F30)).toBe(false);
    expect(P.layoutIsCurrent(l, "m1", { ...t, cues: [{ ...t.cues[0] }, t.cues[1]] }, 100, 5000, F30)).toBe(false);
    expect(P.layoutIsCurrent(l, "m1", { ...t, cues: [...t.cues, cue("c3", 60, 90)] }, 100, 5000, F30)).toBe(false);
    // 視窗外的段變了不影響
    expect(P.layoutIsCurrent(l, "m1", { ...t, cues: [t.cues[0], { ...t.cues[1] }] }, 100, 5000, F30)).toBe(true);
    expect(P.layoutIsCurrent(null, "m1", t, 100, 5000, F30)).toBe(false);
  });
});
