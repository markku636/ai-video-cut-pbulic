import { api } from "../api";
import { useProject } from "../store/project";

/**
 * 專案檔 ↔ 引擎的接縫。
 *
 * 吃專案檔的 op（`render.plan|run` / `export.track` / 字幕 / 外掛的 op）都用
 * `R.open_media_context(project_path, media_id)` 讀磁碟上的檔；App 開著時**store 才是真相**，所以：
 * - 給引擎讀之前先把目前狀態寫成檔（`projectFileFor`：有存過就寫回原路徑，沒存過就寫到快取目錄的暫存檔）；
 * - 會改專案的 op 一律 `no_save: true`，結果由這裡收回 store（一筆 undo）；
 * - 會自己產生一份新專案檔的 op（外掛的自動偵測）由外掛用 migrate → sanitize 讀回來，再用 edits.applyDetection 併入。
 */

/** `<app_cache_dir>/media/<fp16>`（Rust `media_cache_status` 回的 dir；引擎 `env.media_cache_dir(fp)` 同一個地方）。 */
export async function cacheDirOf(mediaId: string): Promise<string> {
  const st = await api.mediaCacheStatus(mediaId);
  return st.dir;
}

/** 依第一段的分隔符接路徑（Windows 路徑用反斜線；引擎 `env.normalize_path` 兩種都吃）。 */
export function joinPath(base: string, ...parts: string[]): string {
  const sep = base.includes("\\") ? "\\" : "/";
  return [base.replace(/[\\/]+$/, ""), ...parts].join(sep);
}

/** 沒存過的專案給引擎讀的暫存檔位置：快取目錄裡，清快取就沒了，不會留在使用者的資料夾。 */
export function scratchProjectPath(cacheDir: string): string {
  return joinPath(cacheDir, "project.aivc.json");
}

/**
 * 把目前狀態寫成引擎可讀的專案檔，回路徑。
 * 有路徑 → 寫回原檔（dirty 也順便存掉，避免引擎讀到舊的）；沒有 → 快取目錄的暫存檔（不改 path / dirty）。
 * `scratch: true` 強制用暫存檔（`pipeline.run` 會整份覆寫，不能拿使用者的檔給它寫）。
 */
export async function projectFileFor(mediaId: string, opts: { scratch?: boolean } = {}): Promise<string> {
  const p = useProject.getState();
  if (!opts.scratch && p.path) {
    if (p.dirty) await p.saveTo(p.path);
    return p.path;
  }
  const path = scratchProjectPath(await cacheDirOf(mediaId));
  await p.writeSnapshot(path);
  return path;
}
