import type { ShotV1, TrackV1 } from "../project/format";
import { useTimeline } from "../store/timeline";
import { useEdits, useProject, type MediaItemLike } from "./_contracts";

/**
 * 「目前這支影片的 …」選擇器。stage / frametimeline / inspector 三邊都要問同樣的問題，
 * 集中在這裡才不會有人用 media[0] 有人用 activeMediaId。
 * 空陣列共用同一個常數：每次回新的 [] 會讓每個訂閱者每次都重繪。
 */
const NO_TRACKS: TrackV1[] = [];
const NO_SHOTS: ShotV1[] = [];

export function useActiveMediaId(): string | null {
  return useProject((s) => s.activeMediaId);
}

export function useActiveMedia(): MediaItemLike | null {
  return useProject((s) => (s.activeMediaId ? s.media.find((m) => m.id === s.activeMediaId) ?? null : null));
}

export function useActiveTracks(): TrackV1[] {
  const id = useActiveMediaId();
  return useEdits((s) => (id ? s.tracks[id] ?? NO_TRACKS : NO_TRACKS));
}

export function useActiveShots(): ShotV1[] {
  const id = useActiveMediaId();
  return useEdits((s) => (id ? s.shots[id] ?? NO_SHOTS : NO_SHOTS));
}

/** 選中的 track；沒選就退回第一條（面板永遠有東西可看，選了才換）。 */
export function useSelectedTrack(): TrackV1 | null {
  const tracks = useActiveTracks();
  const selId = useTimeline((s) => s.selectedTrackId);
  return tracks.find((t) => t.id === selId) ?? tracks[0] ?? null;
}

/** 非 React 程式碼（ticker、pointer handler）用的同步版本。 */
export function activeTracksNow(): TrackV1[] {
  const id = useProject.getState().activeMediaId;
  return id ? useEdits.getState().tracks[id] ?? NO_TRACKS : NO_TRACKS;
}

export function activeShotsNow(): ShotV1[] {
  const id = useProject.getState().activeMediaId;
  return id ? useEdits.getState().shots[id] ?? NO_SHOTS : NO_SHOTS;
}

export function shotOf(shots: ShotV1[], shotId: string): ShotV1 | null {
  return shots.find((s) => s.id === shotId) ?? null;
}

/** track 所屬鏡頭的幀範圍 [start, end)；找不到鏡頭就用整段。 */
export function trackRange(track: TrackV1, shots: ShotV1[], frames: number): [number, number] {
  const shot = shotOf(shots, track.shotId);
  return shot ? [shot.startFrame, shot.endFrame] : [0, Math.max(0, frames)];
}
