/**
 * 平面 track 的替換內容（track.replace；契約 §3）的純函式與標籤表。
 * 這個檔在 check-i18n 的 CORE_TABLE_SOURCES（"fx/"）裡：標籤是 zh key。
 */
import { DEFAULT_REPLACE, type ReplaceFit, type ReplaceKind, type ReplaceLoop, type ReplaceV1 } from "../project/format";

export const REPLACE_FIT_LABEL: Record<ReplaceFit, string> = { stretch: "拉伸貼滿", contain: "完整放進（留邊）", cover: "填滿（裁切）" };
export const REPLACE_LOOP_LABEL: Record<ReplaceLoop, string> = { loop: "重播", hold: "停在最後一幀", stop: "播完就不貼" };

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "bmp"];
export const VIDEO_EXTS = ["mp4", "mov", "webm", "mkv", "m4v", "avi"];

/** 依副檔名猜種類（選檔時用；不認得就照目前選的種類）。 */
export function replaceKindOf(path: string, fallback: ReplaceKind): ReplaceKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (VIDEO_EXTS.includes(ext)) return "video";
  return fallback;
}

/** 選了一個檔 → 新的 replace（保留原本的 fit / offset / loop）。 */
export function replaceWithFile(prev: ReplaceV1 | undefined, path: string, kind: ReplaceKind): ReplaceV1 {
  return { ...DEFAULT_REPLACE, ...(prev ?? {}), kind: replaceKindOf(path, kind), path };
}
