/**
 * 「現在」的助手材料：執行工具要的 RunContext、給模型看的狀態摘要。
 *
 * 面板裡的 HTTP 助手用 hook 算同一組東西（跟著畫面重繪）；MCP 工具呼叫與 CLI 助手是事件驅動的，
 * 要的是**呼叫當下**的狀態，所以這裡直接讀各個 store 的 getState()。兩邊算法一致：欄位一個一個對照
 * AssistantPanel 的 `state` 與 `execute()`。
 */
import { cacheDirOf } from "../pipeline/project";
import { durationFrames } from "../sequence/map";
import { useEdits } from "../store/edits";
import { usePlayback } from "../store/playback";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useTimeline } from "../store/timeline";
import type { RunContext } from "./run";
import type { AssistantState } from "./systemPrompt";

const FALLBACK_FPS = { num: 30, den: 1 };

function activeMedia() {
  const p = useProject.getState();
  const id = p.activeMediaId;
  const media = id ? p.media.find((m) => m.id === id) ?? null : null;
  return id && media ? { id, media } : null;
}

/** 執行工具要的材料；沒有開啟的影片回 null（呼叫端回一句「先開啟一支影片」）。 */
export async function currentRunContext(): Promise<RunContext | null> {
  const a = activeMedia();
  if (!a) return null;
  const e = useEdits.getState();
  const s = useSettings.getState().s;
  return {
    mediaId: a.id,
    video: a.media.path,
    fps: a.media.proxy?.fps ?? FALLBACK_FPS,
    frames: a.media.proxy?.frames ?? 0,
    cacheDir: await cacheDirOf(a.id),
    sam: s.engine.sam_variant || "small",
    outDir: s.output_dir || null,
    captions: e.captions[a.id] ?? null,
    shots: e.shots[a.id] ?? [],
  };
}

/** 給模型看的狀態（同 AssistantPanel 的 `state`）；沒有開啟的影片回 null。 */
export function currentAssistantState(): AssistantState | null {
  const a = activeMedia();
  if (!a) return null;
  const { media } = a;
  const e = useEdits.getState();
  const fps = media.proxy?.fps ?? FALLBACK_FPS;
  const fpsNum = fps.num / (fps.den || 1) || 1;
  const frames = media.proxy?.frames ?? 0;
  const range = useTimeline.getState().range;
  const seq = e.sequence;
  const outDir = useSettings.getState().s.output_dir;
  return {
    name: media.name,
    durationSeconds: frames / fpsNum,
    fps: fpsNum,
    width: media.proxy?.width ?? 0,
    height: media.proxy?.height ?? 0,
    range: range ? { start: range.in / fpsNum, end: range.out / fpsNum } : null,
    playheadSeconds: usePlayback.getState().frame / fpsNum,
    markers: seq?.markers?.length ?? 0,
    hasCaptions: !!e.captions[a.id]?.cues?.length,
    hasSequence: !!seq && durationFrames(seq) > 0,
    shots: (e.shots[a.id] ?? []).length,
    outDir: outDir || media.path.slice(0, Math.max(0, media.path.lastIndexOf(media.path.includes("\\") ? "\\" : "/"))),
  };
}
