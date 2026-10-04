/// <reference lib="webworker" />
import { decodePeaksMip, PeaksFormatError, transferablesOf, type PeaksMip } from "./peaks";

/**
 * peaks.v1.bin → 解析 + mip 的 worker（設計 §9.3）。一小時的音訊是 72 萬個桶，建 mip 要掃四層，
 * 放主執行緒會在開檔當下卡掉幾格播放；丟到這裡算，結果的 ArrayBuffer 用 transfer 送回（零複製）。
 *
 * 訊息：{ id, buf } → { id, mip } 或 { id, error, format }（format = 檔案格式錯，呼叫端不必退回主執行緒重試）。
 * 接線在 src/pipeline/peaks.ts（`decodePeaks`）；CSP 已有 `worker-src 'self' blob:`。
 */
export interface PeaksWorkerRequest {
  id: number;
  buf: ArrayBuffer;
}

export type PeaksWorkerResponse = { id: number; mip: PeaksMip } | { id: number; error: string; format: boolean };

self.onmessage = (ev: MessageEvent<PeaksWorkerRequest>) => {
  const { id, buf } = ev.data;
  try {
    const mip = decodePeaksMip(buf);
    (self as unknown as Worker).postMessage({ id, mip } satisfies PeaksWorkerResponse, transferablesOf(mip));
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, error: e instanceof Error ? e.message : String(e), format: e instanceof PeaksFormatError } satisfies PeaksWorkerResponse);
  }
};
