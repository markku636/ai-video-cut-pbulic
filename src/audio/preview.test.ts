// A 軌 Web Audio 預覽（M2.16）：planAudioSources 純函式、時鐘換算，加上用假 AudioContext 走真的排程程式
//（開始排程的 when / offset / duration、漂移 > 40 ms 重排、只改推桿不重排、停下時淡出）。
import { describe, expect, it } from "vitest";
import type { AudioSourceRefV2, SequenceV2 } from "../project/format";
import { aclip, lane, seqOf, vclip } from "../sequence/testkit";
import {
  audioSeqAt,
  clipCurve,
  ctxTimeAtPerf,
  ctxTimeOfSeq,
  driftMs,
  PLAN_WINDOW_SAMPLES,
  planAudioSources,
  sameClips,
  SequenceAudioPreview,
  sourceRoute,
  type PreviewDeps,
  type SourceInfo,
} from "./preview";

const VO: AudioSourceRefV2 = { type: "audio", audioId: "a-vo" };
const srOf = (ref: AudioSourceRefV2) => (ref.type === "audio" && ref.audioId === "a-music" ? 44100 : 48000);

describe("planAudioSources（M2.16 驗收的純函式）", () => {
  const seq = seqOf(
    [vclip("c1", "m1", 0, 900)],
    [
      lane("mus", "music", [aclip("m1", "a-music", 48000, 960000, { srcIn: 88200 }), aclip("m2", "a-music", 2_000_000, 48000, { enabled: false })], { muted: true }),
      lane("vo", "voiceover", [{ ...aclip("v1", "a-vo", 480000, 96000, { srcIn: -4800 }), source: VO }]),
    ],
  );

  it("視窗內的片段依開始時間排序；已經在播的從視窗起點接著排，來源秒數跟著往後推（原生取樣率換算）", () => {
    const p = planAudioSources(seq, 96000, PLAN_WINDOW_SAMPLES, srOf);
    expect(p.map((x) => x.clipId)).toEqual(["m1", "v1"]);
    const [m1, v1] = p;
    expect(m1).toMatchObject({ laneId: "mus", clipStart: 48000, clipLength: 960000, startSample: 96000, endSample: 1_008_000, atOffset: 48000 });
    expect(m1.sourceSec).toBeCloseTo(88200 / 44100 + 1, 12);
    expect(v1).toMatchObject({ laneId: "vo", startSample: 480000, atOffset: 0 });
    // srcIn 為負 = 片段開頭補靜音：來源秒數是負的，排程時等到 0 才出聲
    expect(v1.sourceSec).toBeCloseTo(-0.1, 12);
  });

  it("靜音軌照排（M / S 在軌道 GainNode 上切才能立刻生效）；停用片段不排；視窗外不排；沒給取樣率當 48 kHz", () => {
    expect(planAudioSources(seq, 0, 48000, srOf).map((x) => x.clipId)).toEqual([]);
    expect(planAudioSources(seq, 0, 48001, srOf).map((x) => x.clipId)).toEqual(["m1"]);
    expect(planAudioSources(seq, 1_900_000, 1_000_000, srOf)).toEqual([]);
    expect(planAudioSources(seq, 1_008_000, 1, srOf).map((x) => x.clipId)).toEqual([]);
    const noSr = planAudioSources(seq, 96000, 10, () => null);
    expect(noSr[0].sourceSec).toBeCloseTo(88200 / 48000 + 1, 12);
  });

  it("同時開始的依軌道順序", () => {
    const s = seqOf([], [lane("b", "sfx", [aclip("x", "a-vo", 1000, 10)]), lane("a", "sfx", [aclip("y", "a-vo", 1000, 10)])]);
    expect(planAudioSources(s, 0, 5000).map((x) => x.clipId)).toEqual(["x", "y"]);
  });
});

describe("時鐘換算與來源路線", () => {
  it("audioSeqAt / ctxTimeOfSeq 互逆；速度倍率照乘", () => {
    const a = { anchorCtx: 10, anchorSeq: 480000, rate: 2 };
    expect(audioSeqAt(a, 11)).toBe(480000 + 96000);
    expect(ctxTimeOfSeq(a, 576000)).toBeCloseTo(11, 12);
  });

  it("ctxTimeAtPerf 用 getOutputTimestamp 把 performance 時刻換成聽到的 context 時間；沒有時間戳回 null", () => {
    expect(ctxTimeAtPerf({ contextTime: 3, performanceTime: 1000 }, 1250)).toBeCloseTo(3.25, 12);
    expect(ctxTimeAtPerf({}, 1250)).toBeNull();
    expect(ctxTimeAtPerf({ contextTime: 3, performanceTime: 0 }, 1250)).toBeNull();
    expect(driftMs(48000 + 1920, 48000)).toBeCloseTo(40, 12);
  });

  it("> 10 分鐘、長度未知、影片檔 → <audio> 元素；其他整檔解碼", () => {
    expect(sourceRoute({ durationSec: 300, video: false })).toBe("buffer");
    expect(sourceRoute({ durationSec: 601, video: false })).toBe("element");
    expect(sourceRoute({ durationSec: null, video: false })).toBe("element");
    expect(sourceRoute({ durationSec: 10, video: true })).toBe("element");
  });

  it("clipCurve：中途進場的前 5 ms 從 0 拉上來；從片段開頭進場不加（防爆音已經是 0 起）", () => {
    const g = { gainDb: 0, fadeIn: 0, fadeOut: 0, fadeCurve: "linear" as const, envelope: [] };
    const mid = clipCurve(g, 480000, 48000, 144);
    expect(mid[0]).toBe(0);
    expect(mid[2]).toBeCloseTo(1, 6); // 240 × 2 = 480 樣本 > 240 樣本的 5 ms 斜坡
    const head = clipCurve(g, 480000, 0, 144);
    expect(head[0]).toBe(0);
    expect(head[1]).toBe(1);
  });

  it("sameClips：只改軌道推桿 / 靜音（clips 參照不變）算同一批", () => {
    const s = seqOf([], [lane("a", "music", [aclip("x", "a-vo", 0, 10)])]);
    const faded: SequenceV2 = { ...s, audioLanes: [{ ...s.audioLanes[0], gainDb: -6 }] };
    expect(sameClips(s, faded)).toBe(true);
    expect(sameClips(s, { ...s, audioLanes: [{ ...s.audioLanes[0], clips: [...s.audioLanes[0].clips] }] })).toBe(false);
    expect(sameClips(s, { ...s, audioLanes: [] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------- 假 AudioContext

class FakeParam {
  value = 0;
  log: [string, ...unknown[]][] = [];
  setValueAtTime(v: number, t: number) {
    this.log.push(["set", v, t]);
    return this;
  }
  setTargetAtTime(v: number, t: number, c: number) {
    this.value = v;
    this.log.push(["target", v, t, c]);
    return this;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.log.push(["ramp", v, t]);
    return this;
  }
  setValueCurveAtTime(values: Float32Array, t: number, d: number) {
    this.log.push(["curve", values.length, t, d]);
    return this;
  }
  cancelAndHoldAtTime(t: number) {
    this.log.push(["hold", t]);
    return this;
  }
  cancelScheduledValues(t: number) {
    this.log.push(["cancel", t]);
    return this;
  }
}

class FakeNode {
  connected: unknown[] = [];
  connect(n: unknown) {
    this.connected.push(n);
    return n;
  }
  disconnect() {}
}

class FakeGain extends FakeNode {
  gain = new FakeParam();
}

class FakeSource extends FakeNode {
  buffer: unknown = null;
  playbackRate = new FakeParam();
  started: [number, number, number] | null = null;
  stopped: number | null = null;
  start(when: number, offset: number, dur: number) {
    this.started = [when, offset, dur];
  }
  stop(t: number) {
    this.stopped = t;
  }
}

class FakeCtx {
  currentTime = 5;
  perf = 1000;
  state = "running";
  destination = new FakeNode();
  baseLatency = 0;
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  getOutputTimestamp() {
    return { contextTime: this.currentTime, performanceTime: this.perf };
  }
  resume() {
    return Promise.resolve();
  }
}

function setup(seq: SequenceV2) {
  const ctx = new FakeCtx();
  let current = seq;
  const infos: Record<string, SourceInfo> = {
    "a-music": { path: "D:\\m.mp3", sampleRate: 44100, durationSec: 120, video: false },
    "a-vo": { path: "D:\\vo.wav", sampleRate: 48000, durationSec: 60, video: false },
  };
  const deps: PreviewDeps = {
    createContext: () => ctx as unknown as AudioContext,
    sequence: () => current,
    lookup: (ref) => (ref.type === "audio" ? infos[ref.audioId] ?? null : null),
    solo: () => [],
    master: () => ({ volume: 1, muted: false }),
    loadBuffer: async (_c, info) => ({ duration: info.durationSec }) as unknown as AudioBuffer,
    createElement: () => null,
    now: () => ctx.perf,
  };
  const e = new SequenceAudioPreview(deps);
  return { e, ctx, setSeq: (s: SequenceV2) => (current = s) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("SequenceAudioPreview 排程（假 AudioContext）", () => {
  const seq = seqOf([vclip("c1", "m1", 0, 900)], [lane("mus", "music", [aclip("m1", "a-music", 0, 960000, { srcIn: 44100 })]), lane("vo", "voiceover", [aclip("v1", "a-vo", 96000, 48000)], { muted: true })]);

  it("開始：排程在未來（≥ now + 20 ms），序列位置同步往後推；AudioBufferSource 的 when / offset / duration 對得上", async () => {
    const { e, ctx } = setup(seq);
    e.beforePlay(true);
    await flush();
    e.onClock({ playing: true, seqSample: 48000, perfMs: 1000, rate: 1 });
    expect(e.stats.starts).toBe(1);
    expect(ctx.sources).toHaveLength(2);
    const [m, v] = ctx.sources;
    // 畫面在 ctx 5.000 s 顯示 1.000 s；最早能排 5.020 s → 那時是序列 1.020 s
    expect(m.started![0]).toBeCloseTo(5.02, 9);
    expect(m.started![1]).toBeCloseTo(1 + 1.02, 9); // srcIn 44100 @ 44.1 kHz = 1 s
    expect(m.started![2]).toBeCloseTo((960000 - 48960) / 48000, 9);
    // 旁白片段從序列 2 s 開始：5.02 + (96000 − 48960)/48000
    expect(v.started![0]).toBeCloseTo(5.02 + 0.98, 9);
    expect(v.started![1]).toBe(0);
  });

  it("暖機內不計；暖機結束偏差 > 5 ms 重錨一次（不算重排）；之後 ≤ 40 ms 不重排、> 40 ms 重排（舊的淡出停掉）", async () => {
    const { e, ctx } = setup(seq);
    e.beforePlay(true);
    await flush();
    e.onClock({ playing: true, seqSample: 48000, perfMs: 1000, rate: 1 });
    ctx.currentTime = 5.1;
    ctx.perf = 1100;
    e.onClock({ playing: true, seqSample: 52800 + 4800, perfMs: 1100, rate: 1 });
    expect(e.stats.samples).toBe(1);
    expect(e.stats.drifts).toEqual([]); // 暖機內：100 ms 的偏差也不算、不重排
    expect(e.stats.resyncs).toBe(0);
    ctx.currentTime = 5.4;
    ctx.perf = 1400;
    // 排程推算：48960 + (5.4 − 5.02)·48000 = 67200；畫面在 67200 + 1 ms → 暖機結束、偏差 ≤ 5 ms，不重錨
    e.onClock({ playing: true, seqSample: 67200 + 48, perfMs: 1400, rate: 1 });
    expect(e.stats.reanchors).toBe(0);
    ctx.currentTime = 5.5;
    ctx.perf = 1500;
    // 排程推算：72000；畫面在 72000 + 10 ms
    e.onClock({ playing: true, seqSample: 72000 + 480, perfMs: 1500, rate: 1 });
    expect(e.stats.resyncs).toBe(0);
    expect(e.stats.lastDriftMs).toBeCloseTo(10, 6);
    expect(e.stats.maxAbsDriftMs).toBeCloseTo(10, 6);
    const first = ctx.sources[0];
    e.onClock({ playing: true, seqSample: 72000 + 2400, perfMs: 1500, rate: 1 });
    expect(e.stats.resyncs).toBe(1);
    expect(first.stopped).not.toBeNull();
    expect(ctx.sources.length).toBeGreaterThan(2);
  });

  it("開播頭幾幀的錨點偏了（暖機結束時差 17 ms）→ 重錨一次，之後以新錨點比", async () => {
    const { e, ctx } = setup(seq);
    e.beforePlay(true);
    await flush();
    e.onClock({ playing: true, seqSample: 48000, perfMs: 1000, rate: 1 });
    ctx.currentTime = 5.4;
    ctx.perf = 1400;
    e.onClock({ playing: true, seqSample: 67200 - 816, perfMs: 1400, rate: 1 });
    expect(e.stats.reanchors).toBe(1);
    expect(e.stats.starts).toBe(2);
    expect(e.stats.resyncs).toBe(0);
    ctx.currentTime = 5.5;
    ctx.perf = 1500;
    // 新錨點：畫面 66384 在 ctx 5.42 → 66384 + 0.02·48000 = 67344；5.5 時推算 67344 + 0.08·48000 = 71184
    e.onClock({ playing: true, seqSample: 71184 + 96, perfMs: 1500, rate: 1 });
    expect(e.stats.lastDriftMs).toBeCloseTo(2, 6);
    expect(e.stats.reanchors).toBe(1);
  });

  it("只拖推桿（clips 參照不變）→ 不重排、只更新軌道增益；換了片段 → 重排", async () => {
    const { e, ctx, setSeq } = setup(seq);
    e.beforePlay(true);
    await flush();
    e.onClock({ playing: true, seqSample: 48000, perfMs: 1000, rate: 1 });
    const faded: SequenceV2 = { ...seq, audioLanes: [{ ...seq.audioLanes[0], gainDb: -6 }, seq.audioLanes[1]] };
    setSeq(faded);
    e.onClock({ playing: true, seqSample: 48000, perfMs: 1000, rate: 1 });
    expect(e.stats.starts).toBe(1);
    const edited: SequenceV2 = { ...faded, audioLanes: [{ ...faded.audioLanes[0], clips: [aclip("m1", "a-music", 0, 480000)] }, faded.audioLanes[1]] };
    setSeq(edited);
    e.onClock({ playing: true, seqSample: 48000, perfMs: 1000, rate: 1 });
    expect(e.stats.starts).toBe(2);
    void ctx;
  });

  it("靜音軌的匯流排增益是 0（片段照排）；playing: false → 全部 5 ms 淡出停掉", async () => {
    const { e, ctx } = setup(seq);
    e.beforePlay(true);
    await flush();
    e.onClock({ playing: true, seqSample: 48000, perfMs: 1000, rate: 1 });
    const laneTargets = ctx.gains.map((g) => g.gain.log.find((l) => l[0] === "target")).filter(Boolean);
    expect(laneTargets.some((l) => l![1] === 0)).toBe(true);
    expect(laneTargets.some((l) => l![1] === 1)).toBe(true);
    e.onClock({ playing: false, seqSample: 0, perfMs: 1100, rate: 1 });
    expect(ctx.sources.every((s) => s.stopped !== null && s.stopped > ctx.currentTime)).toBe(true);
  });

  it("來源還沒解碼好：先不排，解好之後從當下的位置補上", async () => {
    const releases: (() => void)[] = [];
    const { e, ctx } = setup(seq);
    // 換掉 loadBuffer：卡住直到 release
    (e as unknown as { deps: PreviewDeps }).deps.loadBuffer = (_c, info) =>
      new Promise((r) => {
        releases.push(() => r({ duration: info.durationSec } as unknown as AudioBuffer));
      });
    e.beforePlay(true);
    e.onClock({ playing: true, seqSample: 48000, perfMs: 1000, rate: 1 });
    expect(ctx.sources).toHaveLength(0);
    ctx.currentTime = 5.3;
    expect(releases).toHaveLength(2);
    releases.forEach((f) => f());
    await flush();
    await flush();
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources.every((x) => x.started![0] >= 5.3)).toBe(true);
  });
});
