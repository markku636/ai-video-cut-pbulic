// 驗收 Medium 1 的重現：整支辨識 → 只重辨識 I/O 範圍 → 「依樣式重新分段」。
// 修正前 rebuildCaptions 拿範圍 ASR 整條重建，範圍外的字幕（含使用者修過的）整片消失；這裡走真的 pipeline 函式（引擎用假的）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptionCueV1 } from "../project/format";
import { presetSegmentation, type TranscribeOptions } from "../store/captions";

const M = "m1";
const FRAMES = 600;
const ALL = "C:\\cache\\media\\m1\\asr\\all.v1.json";
const RANGE = "C:\\cache\\media\\m1\\asr\\range.v1.json";

const markDirty = vi.fn();
const engineCall = vi.fn();
const runEngineJob = vi.fn();
vi.mock("../store/project", () => ({
  useProject: { getState: () => ({ markDirty, activeMediaId: M, media: [{ id: M, proxy: { frames: FRAMES, fps: { num: 30, den: 1 } } }] }), subscribe: () => () => {} },
}));
vi.mock("../api", () => ({ api: { engineCall: (...a: unknown[]) => engineCall(...a) }, errMessage: (e: unknown) => String((e as Error)?.message ?? e), errKind: () => null, decodeJson: (b: unknown) => b }));
vi.mock("./engineJob", () => ({ dedupe: (_k: string, run: () => Promise<unknown>) => run(), runEngineJob: (...a: unknown[]) => runEngineJob(...a), runningJob: () => null }));
vi.mock("./project", () => ({ projectFileFor: async () => "D:\\p\\scratch.aivc.json", cacheDirOf: async () => "C:\\cache\\media\\m1", joinPath: (...p: string[]) => p.join("\\") }));

const { useEdits } = await import("../store/edits");
const { rebuildCaptions, transcribeAndBuild } = await import("./captions");

const OPTS: TranscribeOptions = { model: "large-v3-turbo", language: "zh", device: "auto", preset: "subtitle", hotwords: [], initialPrompt: "", refine: false, scope: "all" };

function cue(id: string, s: number, text: string, per = 10): CaptionCueV1 {
  const words = [...text].map((ch, i) => ({ text: ch, startFrame: s + i * per, endFrame: s + (i + 1) * per }));
  return { id, startFrame: s, endFrame: s + words.length * per, words };
}

/** 假的 captions.build：依 --asr 回整支或範圍的分段結果（形狀照 aivc/captions/build.py，source 不帶 range）。 */
function fakeBuild(args: Record<string, unknown>) {
  const preset = String(args.preset);
  const cues = args.asr === ALL ? [cue("c1", 0, "開場白"), cue("c2", 210, "中段舊字"), cue("c3", 450, "結尾")] : preset === "pop" ? [cue("c1", 215, "中段"), cue("c2", 235, "新字")] : [cue("c1", 215, "中段新字")];
  return {
    enabled: true,
    language: "zh-TW",
    source: { backend: "faster-whisper", model: "large-v3-turbo", device: "cuda", computeType: "float16", asrLanguage: "zh", detected: "zh", languageProb: 0.98, asrPath: args.asr, transcribedAt: "2026-09-17T00:00:00Z" },
    presetId: preset,
    style: {},
    segmentation: presetSegmentation(preset as "subtitle", "zh-TW"),
    cues,
  };
}

const text = (cues: readonly CaptionCueV1[]) => cues.map((c) => c.words.map((w) => w.text).join(""));

beforeEach(() => {
  useEdits.getState().reset();
  engineCall.mockReset();
  runEngineJob.mockReset();
  engineCall.mockImplementation(async (op: string, args: Record<string, unknown>) => (op === "captions.build" ? fakeBuild(args) : null));
  runEngineJob.mockImplementation(async (o: { args: Record<string, unknown> }) => ({ path: o.args.range ? RANGE : ALL, device: "cuda", computeType: "float16", warnings: [], gaps: [] }));
});

describe("範圍重辨識之後重新分段：範圍外的字幕不能消失（驗收 Medium 1）", () => {
  it("整支 → 範圍 [200,400) 重辨識 → 依 pop 重新分段：範圍外（含修過的）原樣，範圍內換新；一筆 undo 回到重新分段前", async () => {
    await transcribeAndBuild(M, OPTS, null);
    // 使用者修過範圍外的一段：重辨識 / 重新分段都不該碰它
    useEdits.getState().setCueText(M, "c3", "結尾！");
    const edited = useEdits.getState().captions[M]!.cues[2];
    expect(edited.flags).toContain("edited");

    await transcribeAndBuild(M, { ...OPTS, preset: "karaoke", scope: "range" }, { in: 200, out: 400 });
    const afterRange = useEdits.getState().captions[M]!;
    expect(text(afterRange.cues)).toEqual(["開場白", "中段新字", "結尾！"]);
    expect(afterRange.cues[2]).toBe(edited);
    expect(afterRange.source).toMatchObject({ asrPath: RANGE, range: [200, 400] });
    // 範圍重辨識沿用 track 的預設分段（subtitle），不是產生表單上剛選的 karaoke
    expect(engineCall.mock.calls[1][1]).toMatchObject({ asr: RANGE, preset: "subtitle" });
    expect(afterRange.presetId).toBe("subtitle");

    useEdits.getState().setCaptionPreset(M, "pop");
    const beforeRebuild = useEdits.getState().captions[M]!;
    const r = await rebuildCaptions(M, "pop");
    expect(engineCall.mock.calls[2][1]).toMatchObject({ asr: RANGE, preset: "pop" });
    expect(r.range).toEqual({ in: 200, out: 400 });

    const rebuilt = useEdits.getState().captions[M]!;
    // 修正前這裡只剩 ["中段", "新字"]
    expect(text(rebuilt.cues)).toEqual(["開場白", "中段", "新字", "結尾！"]);
    expect(rebuilt.cues[0]).toBe(beforeRebuild.cues[0]);
    expect(rebuilt.cues[3]).toBe(edited);
    expect(rebuilt).toMatchObject({ presetId: "pop", segmentation: presetSegmentation("pop", "zh-TW"), source: { asrPath: RANGE, range: [200, 400] } });
    expect(new Set(rebuilt.cues.map((c) => c.id)).size).toBe(4);
    expect(useEdits.getState().past[useEdits.getState().past.length - 1].label).toBe("依樣式重新分段");

    useEdits.getState().undo();
    expect(useEdits.getState().captions[M]).toBe(beforeRebuild);
  });

  it("來源是整支的 ASR：重新分段照舊整條換掉", async () => {
    await transcribeAndBuild(M, OPTS, null);
    const r = await rebuildCaptions(M, "subtitle");
    expect(r.range).toBeNull();
    expect(text(useEdits.getState().captions[M]!.cues)).toEqual(["開場白", "中段舊字", "結尾"]);
  });

  it("重新分段期間字幕被換掉（又跑了一次整支辨識）：過期結果不套用、擲錯", async () => {
    await transcribeAndBuild(M, OPTS, null);
    await transcribeAndBuild(M, OPTS, { in: 200, out: 400 });
    engineCall.mockImplementationOnce(async (_op: string, args: Record<string, unknown>) => {
      // 引擎還在跑的時候，使用者整支重來
      await transcribeAndBuild(M, OPTS, null);
      return fakeBuild(args);
    });
    await expect(rebuildCaptions(M, "pop")).rejects.toThrow();
    expect(useEdits.getState().captions[M]!.source?.asrPath).toBe(ALL);
  });
});
