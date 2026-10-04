// 波形峰值（M2.8，設計 §3.4 / §9.3）：Rust media_peaks → peaks.v1.bin → worker 解析 + mip → 記憶體快取。
//
// 形狀照 ai-music-cut pipeline/waveform.ts：inflight Map（同一支媒體同時只跑一份）+ 工作清單一列 + job_id 過濾進度 +
// 完成後 1.5 s 自動移除。這裡是唯一呼叫 api.mediaPeaks 的地方。
//
// 快取鍵是**指紋前 16 碼**（= Rust 快取目錄名），不是 mediaId：同一支 mp4 可以同時是 V1 影片（mediaId）
// 與音樂來源（"a-…"），兩邊共用同一份峰值，不必算兩次。
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api, errMessage, isCanceled, type AppErrorShape, type MediaProgress } from "../api";
import { decodePeaksMip, PeaksFormatError, type PeaksMip } from "../audio/peaks";
import type { PeaksWorkerRequest, PeaksWorkerResponse } from "../audio/peaks.worker";
import type { AudioMediaV2, ProjectMediaV2 } from "../project/format";
import { newJobId, useJobs, type Job, type JobKind } from "../store/jobs";

/**
 * 工作清單的種類。store/jobs.ts 的 JobKind 還沒有「波形」，暫借 thumbs（同樣是 Rust 端算的時間軸衍生圖，
 * 而且目前沒有別的 job 用它，不會跟縮圖混在一起）。M2.8 的檔案範圍不含 jobs.ts / 標籤表 / en.ts，
 * 接上 UI（M2.9 / M2.14）時改成專屬的 "waveform" 並補標籤與翻譯。
 */
export const PEAKS_JOB_KIND: JobKind = "thumbs";
/** 工作清單上的步驟文字（zh key；StatusBar 會 t() 它）。 */
export const PEAKS_JOB_STEP = "計算波形";
const AUTO_REMOVE_MS = 1500;

/** 要算峰值的來源（影片媒體或音訊媒體都攤成這個形狀）。 */
export interface PeaksSource {
  /** 工作清單掛在哪個媒體底下（影片 mediaId 或音訊媒體的 "a-…" id）。 */
  mediaId: string;
  path: string;
  fingerprint: string;
  /** 已知的音訊時長（ms），只給進度百分比用；不知道就 null（進度顯示不確定）。 */
  durationMs: number | null;
  /** probe 明確說沒有音軌 → 不開 job（Rust 也會擲 Invalid，但沒必要讓工作清單冒一列紅字）。probe 未知時當成有。 */
  hasAudio: boolean;
}

function positive(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** 時長來源優先序：audio.v1.json（pts 對齊後的真實樣本數）→ probe 音軌 → probe 容器 → proxy 幀數。 */
export function peaksSourceOfMedia(m: ProjectMediaV2): PeaksSource {
  const a = m.audio;
  const fromInfo = a && a.sampleRate > 0 ? positive((a.nSamples / a.sampleRate) * 1000) : null;
  const fromProxy = m.proxy && m.proxy.fps.num > 0 ? positive((m.proxy.frames * m.proxy.fps.den * 1000) / m.proxy.fps.num) : null;
  return {
    mediaId: m.id,
    path: m.path,
    fingerprint: m.fingerprint,
    durationMs: fromInfo ?? positive(m.probe?.audio?.duration_ms) ?? positive(m.probe?.duration_ms) ?? fromProxy,
    hasAudio: m.probe ? m.probe.audio !== null : true,
  };
}

export function peaksSourceOfAudioMedia(am: AudioMediaV2): PeaksSource {
  const a = am.audio;
  const fromInfo = a && a.sampleRate > 0 ? positive((a.nSamples / a.sampleRate) * 1000) : null;
  return {
    mediaId: am.id,
    path: am.path,
    fingerprint: am.fingerprint,
    durationMs: fromInfo ?? positive(am.probe?.audio?.duration_ms) ?? positive(am.probe?.duration_ms),
    hasAudio: am.probe ? am.probe.audio !== null : true,
  };
}

/** 快取鍵：指紋前 16 碼（Rust media_dir / Python env.media_cache_dir 同一個切法）。 */
export function peaksKey(fingerprint: string): string {
  return fingerprint.trim().slice(0, 16).toLowerCase();
}

interface PeaksStore {
  /** key = peaksKey(fingerprint)。衍生資料：不進 undo、不存檔（§6），丟了就重新向 Rust 要（有磁碟快取，很快）。 */
  byKey: Record<string, PeaksMip>;
  put: (key: string, mip: PeaksMip) => void;
  drop: (key: string) => void;
  clear: () => void;
}

export const usePeaks = create<PeaksStore>((set) => ({
  byKey: {},
  put: (key, mip) => set((s) => ({ byKey: { ...s.byKey, [key]: mip } })),
  drop: (key) =>
    set((s) => {
      if (!(key in s.byKey)) return s;
      const next = { ...s.byKey };
      delete next[key];
      return { byKey: next };
    }),
  clear: () => set({ byKey: {} }),
}));

/** 已經載入的峰值（沒有就 null，不會觸發計算）。 */
export function peaksOf(fingerprint: string): PeaksMip | null {
  return usePeaks.getState().byKey[peaksKey(fingerprint)] ?? null;
}

// ---- worker ----

let worker: Worker | null | undefined;
let nextRequestId = 1;
const waiting = new Map<number, { buf: ArrayBuffer; resolve: (m: PeaksMip) => void; reject: (e: unknown) => void }>();

function decodeOnMainThread(buf: ArrayBuffer): Promise<PeaksMip> {
  try {
    return Promise.resolve(decodePeaksMip(buf));
  } catch (e) {
    return Promise.reject(e);
  }
}

function peaksWorker(): Worker | null {
  if (worker !== undefined) return worker;
  // vitest（node）沒有 Worker：直接在主執行緒算，結果一樣
  if (typeof Worker === "undefined") return (worker = null);
  try {
    const w = new Worker(new URL("../audio/peaks.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<PeaksWorkerResponse>) => {
      const d = ev.data;
      const p = waiting.get(d.id);
      if (!p) return;
      waiting.delete(d.id);
      if ("mip" in d) p.resolve(d.mip);
      else p.reject(d.format ? new PeaksFormatError(d.error) : new Error(d.error));
    };
    w.onerror = (ev) => {
      // worker 腳本載不起來（CSP、打包路徑）：之後一律主執行緒算；排隊中的用保留的原始 bytes 重算，不讓呼叫端卡住
      ev.preventDefault();
      w.terminate();
      worker = null;
      const pending = [...waiting.values()];
      waiting.clear();
      for (const p of pending) decodeOnMainThread(p.buf).then(p.resolve, p.reject);
    };
    worker = w;
  } catch {
    worker = null;
  }
  return worker;
}

/** 解析 + 建 mip：有 worker 在 worker 算，沒有就主執行緒（結果相同）。 */
export function decodePeaks(buf: ArrayBuffer): Promise<PeaksMip> {
  const w = peaksWorker();
  if (!w) return decodeOnMainThread(buf);
  return new Promise<PeaksMip>((resolve, reject) => {
    const id = nextRequestId++;
    waiting.set(id, { buf, resolve, reject });
    // 刻意不 transfer：structured clone 複製一份（一小時 2.9 MB，一兩毫秒），主執行緒保留原本這份，
    // worker 萬一載入失敗還能就地重算；結果那一趟才用 transfer 送回（見 peaks.worker.ts）。
    w.postMessage({ id, buf } satisfies PeaksWorkerRequest);
  });
}

// ---- job ----

const CANCELED: AppErrorShape = { kind: "canceled", code: "ERR_CANCELED", message: "已取消", status: null };

const inflight = new Map<string, { promise: Promise<PeaksMip | null>; jobId: string }>();

/**
 * 取得（或啟動計算）某個來源的峰值：記憶體有 → 直接回；進行中 → 共用同一個 promise；否則開一個 job。
 * 沒有音軌回 null。
 *
 * 取消 = **放棄等待**：job 標成已取消、promise 以 canceled 錯誤結束、不進記憶體快取。Rust 目前沒有指令能設
 * `media_peaks` 的取消旗標（M2.8 只註冊 media_peaks），所以 ffmpeg 會把這一趟算完並寫進磁碟快取 —— 下次再要時直接命中。
 */
export function ensurePeaks(src: PeaksSource): Promise<PeaksMip | null> {
  if (!src.hasAudio) return Promise.resolve(null);
  const key = peaksKey(src.fingerprint);
  const have = usePeaks.getState().byKey[key];
  if (have) return Promise.resolve(have);
  const cur = inflight.get(key);
  if (cur) return cur.promise;

  const jobId = newJobId();
  let abandon: () => void = () => {};
  const abandoned = new Promise<never>((_, reject) => {
    abandon = () => reject(CANCELED);
  });
  // 沒有被取消時這個 promise 永遠不會結束；被取消但 race 已經結束時也不能變成 unhandled rejection
  abandoned.catch(() => {});

  useJobs.getState().upsert({
    id: jobId,
    kind: PEAKS_JOB_KIND,
    mediaId: src.mediaId,
    step: PEAKS_JOB_STEP,
    pct: null,
    message: "",
    status: "running",
    startedAt: Date.now(),
    cancel: () => abandon(),
  });

  const promise = (async () => {
    let unlisten: (() => void) | null = null;
    try {
      // 先掛監聽再 invoke，第一筆進度才不會漏掉；每筆都比對 job_id（兩支媒體同時算時進度才不會畫錯列）
      unlisten = await listen<MediaProgress>("media-progress", (ev) => {
        if (ev.payload.job_id !== jobId) return;
        useJobs.getState().upsert({ id: jobId, pct: Math.round(ev.payload.pct) });
      });
      const buf = await Promise.race([api.mediaPeaks(jobId, src.path, src.fingerprint, src.durationMs), abandoned]);
      const mip = await Promise.race([decodePeaks(buf), abandoned]);
      usePeaks.getState().put(key, mip);
      useJobs.getState().upsert({ id: jobId, status: "done", pct: 100, endedAt: Date.now() });
      setTimeout(() => {
        const j = useJobs.getState().jobs.find((x) => x.id === jobId);
        if (j?.status === "done") useJobs.getState().remove(jobId);
      }, AUTO_REMOVE_MS);
      return mip;
    } catch (e) {
      const canceled = isCanceled(e);
      useJobs.getState().upsert({ id: jobId, status: canceled ? "canceled" : "error", error: canceled ? undefined : errMessage(e), endedAt: Date.now() });
      throw e;
    } finally {
      unlisten?.();
      if (inflight.get(key)?.jobId === jobId) inflight.delete(key);
    }
  })();
  inflight.set(key, { promise, jobId });
  return promise;
}

/** 移除媒體 / 關專案時：放棄進行中的計算（工作清單標成已取消）。 */
export function cancelPeaks(fingerprint: string): void {
  const cur = inflight.get(peaksKey(fingerprint));
  if (cur) useJobs.getState().cancel(cur.jobId);
}

/** 這個指紋現在有沒有在算。 */
export function isPeaksInflight(fingerprint: string): boolean {
  return inflight.has(peaksKey(fingerprint));
}

/** 某媒體最近一筆波形 job（placeholder 顯示「計算中 / 失敗」用）。 */
export function peaksJobOf(jobs: readonly Job[], mediaId: string | null): Job | null {
  if (!mediaId) return null;
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i];
    if (j.kind === PEAKS_JOB_KIND && j.step === PEAKS_JOB_STEP && j.mediaId === mediaId) return j;
  }
  return null;
}
