// 核心各處「問外掛一句話」的小函式（沒有外掛時都是空答案）。集中在這裡，呼叫端不必各自走一遍登記表。
import type { TrackV1 } from "../project/format";
import type { PluginMediaState, TrackTargetText } from "./api";
import { plugins } from "./registry";

/** 這條追蹤指定了要換成什麼（例如 cards：連結的格位的目標牌）；沒有 = null。 */
export function trackTarget(media: PluginMediaState | undefined, track: TrackV1): TrackTargetText | null {
  for (const p of plugins()) {
    const x = p.tracks?.target?.(media, track);
    if (x) return x;
  }
  return null;
}

export function trackHasTarget(media: PluginMediaState | undefined, track: TrackV1): boolean {
  return trackTarget(media, track) !== null;
}

/** Inspector 追蹤頁標題旁的徽章（例如 cards：連結的格位 id）。 */
export function trackBadges(track: TrackV1): string[] {
  return plugins().flatMap((p) => {
    const b = p.tracks?.badge?.(track);
    return b ? [b] : [];
  });
}

/** `track.solve --template` 的額外候選路徑（例如 cards：牌組裡的模板牌）。 */
export function templateCandidates(mediaId: string, track: TrackV1): string[] {
  return plugins().flatMap((p) => p.tracks?.templateCandidates?.(mediaId, track) ?? []);
}

/** `render.plan` / `render.run` 的額外參數（例如 cards：牌組目錄 `deck`）。 */
export function renderArgs(mediaId: string): Record<string, unknown> {
  return Object.assign({}, ...plugins().map((p) => p.engine?.renderArgs?.(mediaId) ?? {}));
}

/** 有外掛說「現在不要送舞台預覽」（例如外掛有自己的預覽 session）。 */
export function stagePreviewBlocked(): boolean {
  return plugins().some((p) => p.stage?.blockPreview?.() === true);
}
