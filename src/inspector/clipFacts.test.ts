// M2.15 驗收「Inspector 的數值與 plan 一致」：fixtures/sequence/inspector-chains.json 的 expected 是 engine audio_graph.build 算的，
// engine/tests/test_inspector_chains.py 驗它仍然成立；這裡用 TS 的 clipFacts 算同一份序列，每個片段逐欄相等。
import { describe, expect, it } from "vitest";
import { migrate } from "../project/migrate";
import { parseProjectFile } from "../project/sanitize";
import { makeSeqCtx } from "../sequence/context";
import { A_MUSIC, CTX, M1, aclip, lane, seqOf, vclip } from "../sequence/testkit";
import { detachAudio } from "../sequence/audioOps";
import type { PeaksMip } from "../audio/peaks";
import fixture from "../../fixtures/sequence/inspector-chains.json";
import { audioClipFacts, envelopeContribution, formatUsClock, leadPadUs, roundHalfUpDiv, sourcePeakDbfs, v1ClipFacts, vfrFactsInRange, type ChainFacts } from "./clipFacts";

type Expected = Record<string, (Omit<ChainFacts, "envMaxDb"> & { envMaxDb: number }) | null>;

function load() {
  const parsed = parseProjectFile(migrate(JSON.parse(JSON.stringify(fixture.project))).doc);
  const seq = parsed.file.sequence!;
  const ctx = makeSeqCtx(parsed.file.media, parsed.file.audioMedia);
  return { seq, ctx };
}

describe("Inspector 鏈參數 == 引擎音訊圖（fixtures/sequence/inspector-chains.json）", () => {
  const { seq, ctx } = load();
  const expected = fixture.expected as unknown as Expected;

  it("sanitize 沒有丟片段（兩邊算的是同一份序列）", () => {
    expect(seq.video.map((v) => v.id)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6"]);
    expect(seq.audioLanes.flatMap((l) => l.clips.map((c) => c.id))).toEqual(["a1", "a2", "d1", "a3", "a4"]);
  });

  for (const id of Object.keys(fixture.expected)) {
    it(`片段 ${id}`, () => {
      const facts = id.startsWith("c") ? v1ClipFacts(seq, id, ctx) : audioClipFacts(seq, id, ctx);
      expect(facts).not.toBeNull();
      const want = expected[id];
      if (want === null) {
        expect(facts!.chain).toBeNull();
        expect(facts!.silent).not.toBeNull();
      } else {
        expect(facts!.silent).toBeNull();
        expect(facts!.chain).toEqual(want);
      }
    });
  }

  it("不進混音的原因各自講得出來", () => {
    expect(v1ClipFacts(seq, "c5", ctx)!.silent).toBe("clipDisabled");
    expect(v1ClipFacts(seq, "c6", ctx)!.silent).toBe("detached");
    expect(audioClipFacts(seq, "a2", ctx)!.silent).toBe("clipDisabled");
    expect(audioClipFacts(seq, "a3", ctx)!.silent).toBe("laneMuted");
    expect(audioClipFacts(seq, "a4", ctx)!.silent).toBe("afterEnd");
  });

  it("音訊相對視訊的偏移 = startUs − videoStartUs（+6.5 ms：音訊晚開始）", () => {
    expect(v1ClipFacts(seq, "c1", ctx)!.audioOffsetUs).toBe(6500);
    expect(formatUsClock(audioClipFacts(seq, "a1", ctx)!.srcInUs!)).toBe("00:00:02.025");
  });
});

describe("分離後的 srcIn 在 startUs ≠ videoStartUs 時正確（M2.15 驗收：startUs = 6 500、videoStartUs = 0）", () => {
  it("分離出來的片段跟原本的原音在混音裡是同一段聲音：inUs、L、delay 都相同", () => {
    const base = seqOf([vclip("c1", "m1", 0, 30), vclip("c2", "m1", 60, 120)]);
    const before = v1ClipFacts(base, "c2", CTX)!.chain!;
    const after = detachAudio(base, "c2", CTX, { id: "d2" });
    const d = audioClipFacts(after, "d2", CTX)!;
    // srcIn = round((2 000 000 − 6 500) · 48 000 / 1e6) = 95 688
    expect(d.clip.srcIn).toBe(95688);
    expect(d.chain!.inUs).toBe(before.inUs);
    expect(d.chain!.length).toBe(before.length);
    expect(d.chain!.delay).toBe(before.delay);
    expect(v1ClipFacts(after, "c2", CTX)!.silent).toBe("detached");
  });

  it("片段從 k=0 開始（早於音訊串流起點）：兩邊都補 312 個樣本的靜音", () => {
    const after = detachAudio(seqOf([vclip("c1", "m1", 0, 30)]), "c1", CTX, { id: "d1" });
    const d = audioClipFacts(after, "d1", CTX)!;
    expect(d.clip.srcIn).toBe(-312);
    expect(d.chain!.leadPad).toBe(312);
    expect(v1ClipFacts(seqOf([vclip("c1", "m1", 0, 30)]), "c1", CTX)!.chain!.leadPad).toBe(312);
  });
});

describe("小工具", () => {
  it("roundHalfUpDiv 同 Python round_half_up（x.5 往 +∞，負數也一樣）", () => {
    expect(roundHalfUpDiv(5, 2)).toBe(3);
    expect(roundHalfUpDiv(-5, 2)).toBe(-2);
    expect(roundHalfUpDiv(6500 * 48000, 1_000_000)).toBe(312);
  });

  it("leadPadUs：早於串流起點、落在斷層裡取較大者", () => {
    expect(leadPadUs({ startUs: 6500, gaps: [] }, 0)).toBe(6500);
    expect(leadPadUs({ startUs: 0, gaps: [{ atUs: 1000, durUs: 500 }] }, 1200)).toBe(300);
    expect(leadPadUs({ startUs: 0, gaps: [{ atUs: 1000, durUs: 500 }] }, 1500)).toBe(0);
  });

  it("自動化：整條同值併進靜態增益、會變的記最大值、整條 ≤ −90 dB 視為靜音", () => {
    const g = { gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear" as const };
    expect(envelopeContribution({ ...g, envelope: [] })).toEqual({ constDb: 0, maxDb: 0 });
    expect(envelopeContribution({ ...g, envelope: [{ at: 0, db: -2 }, { at: 10, db: -2 }] })).toEqual({ constDb: -2, maxDb: 0 });
    expect(envelopeContribution({ ...g, envelope: [{ at: 0, db: -12 }, { at: 10, db: 3 }] })).toEqual({ constDb: 0, maxDb: 3 });
    expect(envelopeContribution({ ...g, envelope: [{ at: 0, db: -96 }] })).toBeNull();
  });

  it("片段峰值：桶範圍同 render.py（floor(in/5ms)..ceil(out/5ms)），全靜音 −120、沒有峰值 null", () => {
    const n = 10;
    const mins = new Int8Array(n);
    const maxs = new Int8Array(n);
    maxs[3] = 127;
    mins[6] = -64;
    const mip = { peaks: {} as PeaksMip["peaks"], levels: [{ span: 1, n, mins, maxs, rmsU8: new Uint8Array(n) }] } as PeaksMip;
    expect(sourcePeakDbfs(mip, 15_000, 20_000)).toBeCloseTo(0, 6);
    expect(sourcePeakDbfs(mip, 20_000, 35_000)).toBeCloseTo(20 * Math.log10(64 / 127), 6);
    expect(sourcePeakDbfs(mip, 40_000, 50_000)).toBe(-120);
    expect(sourcePeakDbfs(null, 0, 1)).toBeNull();
  });

  it("VFR 事實：片段內的定格重複幀與來源斷層（片段第一幀跟片段外相同不算）", () => {
    // 來源 0..4 在 0,33,66,1266,1300 ms；k: 0→0,1→1,2→2,3→2（定格）,4→3,5→4
    const raw = { pts_ms: [0, 33, 66, 1266, 1300], cfr: { runs: [[0, 0, 3], [3, 2, 1], [4, 3, 2]] } };
    expect(vfrFactsInRange(raw, 0, 6)).toEqual({ duplicates: 1, gaps: [{ k: 4, gapMs: 1200 }] });
    expect(vfrFactsInRange(raw, 3, 6)).toEqual({ duplicates: 0, gaps: [{ k: 4, gapMs: 1200 }] });
    expect(vfrFactsInRange(raw, 0, 3)).toEqual({ duplicates: 0, gaps: [] });
    expect(vfrFactsInRange({ pts_ms: [0] }, 0, 1)).toBeNull();
  });

  it("音樂來源（44.1 kHz mp3）：入點容器時間帶 LAME 延遲", () => {
    const seq = seqOf([vclip("c1", "m1", 0, 300)], [lane("l1", "music", [aclip("a1", A_MUSIC.id, 0, 48000, { srcIn: 44100 })])]);
    expect(audioClipFacts(seq, "a1", CTX)!.srcInUs).toBe(1_025_057);
    expect(M1.audio!.startUs).toBe(6500);
  });
});
