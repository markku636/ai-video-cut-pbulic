// 效果 / 替換的舞台預覽（fx/preview.ts 的 provider；唯一碰引擎的地方）。
//
// - 物件特效：`fx.preview`（遮罩＝<媒體快取>/tracks/<id>/masks.aivm；特效直接給 JSON 字串，不寫暫存檔）。
// - 平面 track 的特效：遮罩檔有就用（契約：平面 track 的作用範圍＝masks.aivm，沒有才用解出來的四邊形）；
//   沒有遮罩檔時 fx.preview 沒辦法用四邊形當範圍 → 不送，講一句「輸出時用四角範圍」。
// - 平面替換：`media.frame` 存這一幀 → `comp.preview_composite`（幀＋四角＋圖）。影片替換只取第一幀當模板；
//   fit 在預覽裡一律拉伸貼滿四角（preview_composite 沒有 fit），contain / cover 以輸出為準。
//
// 引擎只有一條主 lane：有任何引擎工作在排隊或在跑就不送（同 stagePreview 的紀律），同時只讓一個在飛（previewStore 管）。
// fx.preview 不碰 comp.preview 的預覽 session，所以不看外掛的 blockPreview。
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, errMessage } from "../api";
import { hashOf } from "../stage/previewStore";
import { setFxPreviewProvider, type FxNote, type FxPreviewEntry, type FxPreviewParts } from "../fx/preview";
import type { Quad, ReplaceV1 } from "../project/format";
import { engineReady } from "../store/engine";
import { engineBusy } from "../store/jobs";
import { useProject } from "../store/project";
import { cacheDirOf, joinPath } from "./project";
import { maskFileFor } from "./track";

const FX_TIMEOUT_MS = 120_000;

export function quadArg(q: Quad): string {
  return q.p.map(([x, y]) => `${Math.round(x * 1000) / 1000},${Math.round(y * 1000) / 1000}`).join(",");
}

/** `fx.preview` 的 args（sidecar 的鍵＝CLI dest 名；engine/ops/fx.py _preview_args）。 */
export function fxPreviewArgs(o: { video: string; masks: string; effects: string; frame: number; out: string }): Record<string, unknown> {
  return { video: o.video, masks: [o.masks], effects: o.effects, frame: o.frame, out: o.out, max_width: 0 };
}

/** `comp.preview_composite` 的 args（engine/ops/preview.py _args）。 */
export function compositeArgs(o: { framePng: string; quad: Quad; template: string; out: string }): Record<string, unknown> {
  return { frame: o.framePng, quad: quadArg(o.quad), template_new: o.template, view: "replaced", out: o.out };
}

/** 替換預覽的附註：影片只看第一幀、fit 不是拉伸時以輸出為準。 */
export function replaceNote(r: Pick<ReplaceV1, "kind" | "fit">): FxNote | null {
  if (r.kind === "video" && r.fit !== "stretch") return { key: "預覽：影片只顯示第一幀，並拉伸貼滿四角（{fit} 以輸出為準）", params: { fit: r.fit } };
  if (r.kind === "video") return { key: "預覽：影片替換只顯示第一幀" };
  if (r.fit !== "stretch") return { key: "預覽：拉伸貼滿四角（{fit} 以輸出為準）", params: { fit: r.fit } };
  return null;
}

/** PNG → ImageBitmap（每次都重讀：同一個檔名會被下一次預覽覆寫；位圖跟檔案脫鉤，之後覆寫也不影響畫面）。 */
async function loadBitmap(path: string): Promise<ImageBitmap> {
  const res = await fetch(`${convertFileSrc(path)}?v=${Date.now()}`, { cache: "no-store" });
  return createImageBitmap(await res.blob());
}

async function effectsPreview(parts: FxPreviewParts, video: string, cacheDir: string): Promise<FxPreviewEntry> {
  const masks = parts.trackKind === "object" ? joinPath(cacheDir, "tracks", parts.trackId, "masks.aivm") : await maskFileFor(cacheDir, parts.trackId);
  if (!masks) return { img: null, note: { key: "平面 track 沒有遮罩檔：特效在輸出時套在四角範圍，這裡沒辦法預覽" } };
  const out = joinPath(cacheDir, "fx", `${parts.trackId}.png`);
  const r = await api.engineCall<{ out: string }>("fx.preview", fxPreviewArgs({ video, masks, effects: parts.payload, frame: parts.frame, out }), FX_TIMEOUT_MS);
  return { img: await loadBitmap(r.out || out), note: null };
}

/** 影片替換的模板：取第一幀存成 PNG（路徑雜湊當檔名；已經有就不重取）。 */
async function videoFirstFrame(path: string, cacheDir: string): Promise<string> {
  const png = joinPath(cacheDir, "fx", `replace-${hashOf(path)}-f0.png`);
  const [exists] = await api.pathsExist([png]).catch(() => [false]);
  if (exists) return png;
  const r = await api.engineCall<{ out: string }>("media.frame", { video: path, at: 0, out: png }, FX_TIMEOUT_MS);
  return r.out || png;
}

async function replacePreview(parts: FxPreviewParts, video: string, cacheDir: string): Promise<FxPreviewEntry> {
  const rep = JSON.parse(parts.payload) as ReplaceV1;
  if (!parts.quad) return { img: null, note: { key: "這一幀沒有表面：沒辦法預覽替換" } };
  const [exists] = await api.pathsExist([rep.path]).catch(() => [true]);
  if (!exists) return { img: null, note: { key: "找不到替換檔：{path}", params: { path: rep.path } } };
  const framePng = joinPath(cacheDir, "fx", "frame.png");
  await api.engineCall("media.frame", { video, at: parts.frame, out: framePng }, FX_TIMEOUT_MS);
  const template = rep.kind === "video" ? await videoFirstFrame(rep.path, cacheDir) : rep.path;
  const out = joinPath(cacheDir, "fx", `${parts.trackId}-replace.png`);
  const r = await api.engineCall<{ out: string }>("comp.preview_composite", compositeArgs({ framePng, quad: parts.quad, template, out }), FX_TIMEOUT_MS);
  return { img: await loadBitmap(r.out || out), note: replaceNote(rep) };
}

/** 能不能送（純函式，可測）：引擎就緒、沒有工作在排隊或在跑。 */
export function canFxPreview(s: { ready: boolean; busy: boolean }): boolean {
  return s.ready && !s.busy;
}

async function fetchFxPreview(parts: FxPreviewParts): Promise<FxPreviewEntry | null> {
  if (!canFxPreview({ ready: engineReady(), busy: engineBusy() })) return null;
  const media = useProject.getState().media.find((m) => m.id === parts.mediaId);
  if (!media) return null;
  try {
    const cacheDir = await cacheDirOf(parts.mediaId);
    return parts.kind === "replace" ? await replacePreview(parts, media.path, cacheDir) : await effectsPreview(parts, media.path, cacheDir);
  } catch (e) {
    // 引擎的錯（貼紙檔不在、遮罩跟影片不同尺寸…）原樣講出來，存進快取：同一份設定不再重送，改了參數鍵就變了
    return { img: null, note: { key: errMessage(e) } };
  }
}

export function installFxPreview(): () => void {
  setFxPreviewProvider(fetchFxPreview);
  return () => setFxPreviewProvider(null);
}
