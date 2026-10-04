import { isProjectPath, isVideoPath } from "../brand";

/** 最近開啟清單的純函式：專案檔與影片混在同一份清單裡。 */

export type RecentKind = "project" | "video";

export const RECENT_MAX = 10;

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function kindOf(path: string): RecentKind {
  return isProjectPath(path) ? "project" : "video";
}

export function isOpenablePath(path: string): boolean {
  return isProjectPath(path) || isVideoPath(path);
}

/** 放到最前面、去重、最多 RECENT_MAX 筆。 */
export function pushRecent(list: readonly string[], path: string): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, RECENT_MAX);
}

export function removeRecent(list: readonly string[], path: string): string[] {
  return list.filter((p) => p !== path);
}
