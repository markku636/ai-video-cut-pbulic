import { api } from "../api";
import { projectFileFor } from "../pipeline/project";
import type { TrackDataFlavour, TrackDataFormat } from "../project/format";

/**
 * 追蹤資料互通（計畫 §17.5 / 決策 6、18）：**匯出器只有 Python 一份**（`aivc.export.nuke_cornerpin` / `ae_keyframes`），
 * 這裡只是對 `export.track` op 的薄呼叫；文字回來給剪貼簿或由引擎直接寫檔。
 *
 * args = engine/ops/export_track.py `_args` 的 dest 名：`project` / `track` / `media` / `format nuke|ae` / `flavour cornerpin|cornerpin+transform` /
 * `baked` | `linked`（互斥 store_true）/ `frame_offset` / `stabilize` / `raw` / `solve` / `stdout` / `out`。
 * `stdout: true` → 文字放在 result.text（sidecar 的 stdout 是 JSONL，不能混）。
 */
export interface TrackDataOpts {
  format: TrackDataFormat;
  flavour: TrackDataFlavour;
  /** true = 曲線內嵌（預設）；false = linked：多一行註解記 solve.v1.json 相對路徑（Nuke）。 */
  baked: boolean;
  /** null = 引擎預設（nuke 用 exportDefaults 的、ae 用 0）。 */
  frameOffset: number | null;
  /** Nuke：invert true（stabilize 語意）。 */
  stabilize?: boolean;
  /** 用平滑前的解（solve.hud.v1.json cornersRaw）。 */
  raw?: boolean;
  /** 給了就由引擎寫檔（.nk / .txt）；沒給只回文字。 */
  out?: string | null;
}

/** export.track 的回覆。 */
export interface TrackDataResult {
  trackId: string;
  format: TrackDataFormat;
  flavour: TrackDataFlavour;
  baked: boolean;
  frameOffset: number;
  /** 有解的幀數（lost 略過）。 */
  keys: number;
  frames: number;
  solvePath: string;
  size: [number, number];
  fps: { num: number; den: number };
  linked: string | null;
  bytes: number;
  /** stdout 或沒有 out 時才有。 */
  text?: string;
  out?: string;
  _human?: string;
}

/** 純函式：UI 選項 → 引擎 args（vitest 驗這張表，實作不在 TS）。 */
export function trackDataArgs(project: string, mediaId: string, trackId: string, o: TrackDataOpts): Record<string, unknown> {
  return {
    project,
    media: mediaId,
    track: trackId,
    format: o.format,
    flavour: o.flavour,
    ...(o.baked ? { baked: true } : { linked: true }),
    ...(o.frameOffset != null && Number.isFinite(o.frameOffset) ? { frame_offset: Math.round(o.frameOffset) } : {}),
    ...(o.stabilize ? { stabilize: true } : {}),
    ...(o.raw ? { raw: true } : {}),
    stdout: true,
    ...(o.out ? { out: o.out } : {}),
  };
}

/** 叫引擎產生 Nuke / AE 文字（並在 `out` 有給時寫檔）。 */
export async function exportTrackData(mediaId: string, trackId: string, o: TrackDataOpts): Promise<TrackDataResult> {
  const project = await projectFileFor(mediaId);
  return api.engineCall<TrackDataResult>("export.track", trackDataArgs(project, mediaId, trackId, o), 60_000);
}

export function trackDataExtension(format: TrackDataFormat): string {
  return format === "nuke" ? "nk" : "txt";
}
