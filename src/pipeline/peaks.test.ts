// 波形 job（M2.8）：inflight 共用、記憶體快取命中不重算、進度依 job_id 過濾、壞檔與取消的收尾。
import { beforeEach, describe, expect, it, vi } from "vitest";

type ProgressCb = (ev: { payload: { job_id: string; phase: string; pct: number } }) => void;
const listeners = new Set<ProgressCb>();
const mediaPeaks = vi.fn<(jobId: string, path: string, fingerprint: string, durationMs?: number | null) => Promise<ArrayBuffer>>();

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)), convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_name: string, cb: ProgressCb) => {
    listeners.add(cb);
    return Promise.resolve(() => listeners.delete(cb));
  }),
}));
vi.mock("../api", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../api")>();
  return { ...orig, api: { ...orig.api, mediaPeaks: (...a: Parameters<typeof mediaPeaks>) => mediaPeaks(...a) } };
});

const { useJobs } = await import("../store/jobs");
const { PEAKS_JOB_KIND, cancelPeaks, ensurePeaks, isPeaksInflight, peaksJobOf, peaksKey, peaksOf, peaksSourceOfAudioMedia, peaksSourceOfMedia, usePeaks } = await import("./peaks");
const { PeaksFormatError } = await import("../audio/peaks");

const GOLDEN = (import.meta.glob("../../fixtures/peaks/aivp-v1.golden.json", { eager: true, import: "default" }) as Record<string, { hex: string }>)["../../fixtures/peaks/aivp-v1.golden.json"];

function goldenBuf(): ArrayBuffer {
  const hex = GOLDEN.hex;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out.buffer;
}

const FP = "0123456789abcdef" + "f".repeat(48);
const src = (over: Partial<Parameters<typeof ensurePeaks>[0]> = {}) => ({ mediaId: "m1", path: "D:\\影片\\a.webm", fingerprint: FP, durationMs: 60000, hasAudio: true, ...over });

/** 讓排在 microtask 裡的 listen / invoke 跑完。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  mediaPeaks.mockReset();
  listeners.clear();
  usePeaks.getState().clear();
  useJobs.setState({ jobs: [] });
});

describe("ensurePeaks", () => {
  it("第一次向 Rust 要、解析後進記憶體快取；第二次命中快取不再呼叫", async () => {
    mediaPeaks.mockResolvedValue(goldenBuf());
    const a = await ensurePeaks(src());
    expect(a?.peaks.nBuckets).toBe(3);
    expect(a?.levels.length).toBe(5);
    expect(mediaPeaks).toHaveBeenCalledTimes(1);
    const [jobId, path, fp, dur] = mediaPeaks.mock.calls[0];
    expect([path, fp, dur]).toEqual(["D:\\影片\\a.webm", FP, 60000]);
    expect(useJobs.getState().jobs.find((j) => j.id === jobId)?.status).toBe("done");

    const b = await ensurePeaks(src({ mediaId: "a-0123456789abcdef" }));
    expect(b).toBe(a);
    expect(mediaPeaks).toHaveBeenCalledTimes(1);
    expect(peaksOf(FP)).toBe(a);
  });

  it("同一支媒體同時要兩次：共用同一個 promise，只算一次", async () => {
    const d = deferred<ArrayBuffer>();
    mediaPeaks.mockReturnValue(d.promise);
    const p1 = ensurePeaks(src());
    const p2 = ensurePeaks(src());
    expect(p2).toBe(p1);
    expect(isPeaksInflight(FP)).toBe(true);
    await flush();
    d.resolve(goldenBuf());
    expect(await p1).toBe(await p2);
    expect(mediaPeaks).toHaveBeenCalledTimes(1);
    expect(isPeaksInflight(FP)).toBe(false);
  });

  it("沒有音軌：回 null、不開 job、不呼叫 Rust", async () => {
    expect(await ensurePeaks(src({ hasAudio: false }))).toBeNull();
    expect(mediaPeaks).not.toHaveBeenCalled();
    expect(useJobs.getState().jobs).toEqual([]);
  });

  it("進度只收自己 job_id 的事件", async () => {
    const d = deferred<ArrayBuffer>();
    mediaPeaks.mockReturnValue(d.promise);
    const p = ensurePeaks(src());
    await flush();
    const jobId = mediaPeaks.mock.calls[0][0];
    for (const cb of listeners) {
      cb({ payload: { job_id: "job-別人的", phase: "peaks", pct: 90 } });
      cb({ payload: { job_id: jobId, phase: "peaks", pct: 41.6 } });
    }
    const job = useJobs.getState().jobs.find((j) => j.id === jobId);
    expect(job?.pct).toBe(42);
    expect(job?.kind).toBe(PEAKS_JOB_KIND);
    expect(peaksJobOf(useJobs.getState().jobs, "m1")?.id).toBe(jobId);
    d.resolve(goldenBuf());
    await p;
    expect(listeners.size).toBe(0);
  });

  it("壞檔（magic 不符）：job 標失敗、不進快取；下次再要會重新呼叫", async () => {
    const bad = goldenBuf();
    new Uint8Array(bad, 0, 4).set([0x41, 0x49, 0x50, 0x4b]);
    mediaPeaks.mockResolvedValueOnce(bad);
    await expect(ensurePeaks(src())).rejects.toBeInstanceOf(PeaksFormatError);
    const job = useJobs.getState().jobs[0];
    expect(job.status).toBe("error");
    expect(job.error).toMatch(/magic/);
    expect(peaksOf(FP)).toBeNull();
    expect(isPeaksInflight(FP)).toBe(false);

    mediaPeaks.mockResolvedValueOnce(goldenBuf());
    expect((await ensurePeaks(src()))?.peaks.nBuckets).toBe(3);
    expect(mediaPeaks).toHaveBeenCalledTimes(2);
  });

  it("Rust 擲錯（沒有音軌 / ffmpeg 失敗）照實標在工作清單", async () => {
    mediaPeaks.mockRejectedValueOnce({ kind: "invalid", code: "ERR_INVALID", message: "這個媒體沒有音軌，無法計算波形", status: null });
    await expect(ensurePeaks(src())).rejects.toMatchObject({ code: "ERR_INVALID" });
    expect(useJobs.getState().jobs[0]).toMatchObject({ status: "error", error: "這個媒體沒有音軌，無法計算波形" });
  });

  it("取消 = 放棄等待：promise 以 canceled 結束、job 已取消、結果不進快取；晚到的 bytes 被忽略", async () => {
    const d = deferred<ArrayBuffer>();
    mediaPeaks.mockReturnValue(d.promise);
    const p = ensurePeaks(src());
    await flush();
    cancelPeaks(FP);
    await expect(p).rejects.toMatchObject({ kind: "canceled" });
    expect(useJobs.getState().jobs[0].status).toBe("canceled");
    expect(isPeaksInflight(FP)).toBe(false);
    d.resolve(goldenBuf());
    await flush();
    expect(peaksOf(FP)).toBeNull();
    expect(useJobs.getState().jobs[0].status).toBe("canceled");
  });

  it("快取鍵是指紋前 16 碼（大小寫不分）：影片與音訊媒體共用同一份", () => {
    expect(peaksKey(" 0123456789ABCDEFxyz")).toBe("0123456789abcdef");
  });
});

describe("peaksSourceOf*", () => {
  const probe = (audio: boolean, durationMs = 0, audioDurationMs: number | null = null) =>
    ({
      path: "x",
      size_bytes: 1,
      duration_ms: durationMs,
      container: "matroska,webm",
      video: null,
      fingerprint: FP,
      audio: audio ? { codec: "opus", sample_rate: 48000, channels: 2, bit_rate: null, duration_ms: audioDurationMs } : null,
    }) as const;

  it("影片媒體：時長依序取 audio.v1.json → probe 音軌 → probe 容器 → proxy 幀數；probe 說沒有音軌就不算", () => {
    const base = { id: "m1", path: "D:\\a.webm", name: "a.webm", fingerprint: FP };
    const proxy = { version: 1 as const, fps: { num: 30000, den: 1001 }, frames: 300, width: 1280, height: 720, scale: 1, path: "p" };
    const info = { codec: "opus", sampleRate: 48000, channels: 2, channelLayout: "stereo", startUs: 0, videoStartUs: 0, nSamples: 480000, gaps: [] };
    expect(peaksSourceOfMedia({ ...base, probe: probe(true, 12000, 11000), proxy, audio: info }).durationMs).toBe(10000);
    expect(peaksSourceOfMedia({ ...base, probe: probe(true, 12000, 11000), proxy }).durationMs).toBe(11000);
    expect(peaksSourceOfMedia({ ...base, probe: probe(true, 12000), proxy }).durationMs).toBe(12000);
    // 範例 WebM：容器沒有時長標頭（0）→ 退到 proxy
    expect(peaksSourceOfMedia({ ...base, probe: probe(true, 0), proxy }).durationMs).toBeCloseTo(10010, 6);
    expect(peaksSourceOfMedia({ ...base, probe: probe(true, 0), proxy: null }).durationMs).toBeNull();
    expect(peaksSourceOfMedia({ ...base, probe: probe(false, 5000), proxy }).hasAudio).toBe(false);
    expect(peaksSourceOfMedia({ ...base, probe: null, proxy: null })).toMatchObject({ hasAudio: true, mediaId: "m1", path: "D:\\a.webm" });
  });

  it("音訊媒體：jobs 掛在 a- id 底下", () => {
    const s = peaksSourceOfAudioMedia({ id: "a-0123456789abcdef", path: "D:\\bgm.mp3", name: "bgm.mp3", fingerprint: FP, probe: probe(true, 30000), role: "music", audio: null });
    expect(s).toEqual({ mediaId: "a-0123456789abcdef", path: "D:\\bgm.mp3", fingerprint: FP, durationMs: 30000, hasAudio: true });
  });
});
