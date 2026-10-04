import { errMessage } from "../api";
import { t } from "../i18n";
import { cacheDirOf, joinPath } from "../pipeline/project";
import { dedupe, runEngineJob } from "../pipeline/engineJob";
import { maskFileFor, maskHints, solveTrack } from "../pipeline/track";
import type { PromptV1, ShotV1, TrackV1 } from "../project/format";
import { useEdits } from "../store/edits";
import { useMasks } from "../store/masks";
import { usePlayback } from "../store/playback";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { intersectRange, useTimeline, type FrameRange } from "../store/timeline";
import { toast, uiConfirm } from "../ui";

/**
 * 範圍版的追蹤 / 遮罩操作（規格 §1.3）：作用區間 = 範圍 ∩ 這條 track 的鏡頭。
 *
 * 既有的 M / Shift+M / Alt+M、追到頭 / 追到尾維持以**鏡頭**為單位（行為可預期），範圍版本是獨立指令；
 * 使用者要的是「只重算這一小段」而不是「有範圍時 M 的行為偷偷變了」。
 *
 * - 追蹤：`track.solve --from K0 --to K1`（引擎 merge_subrange 會把新解併回既有 solve，範圍外的幀保留）。
 * - 遮罩：`seg.run --frames K0:K1 --anchor K --dir both`。**引擎的 seg.run 不合併**：輸出的 .aivm 只含範圍內的幀，
 *   會取代這條 track 目前用的遮罩檔，所以已經有遮罩時先確認（合併要引擎加 write_update_rle，這次不動引擎）。
 */

/** 這條 track 的作用區間（範圍 ∩ 鏡頭）；沒有範圍 / 沒有鏡頭 / 沒有交集 → null。 */
export function trackRangeSpan(track: Pick<TrackV1, "shotId">, shots: readonly Pick<ShotV1, "id" | "startFrame" | "endFrame">[], range: FrameRange | null): FrameRange | null {
  const shot = shots.find((s) => s.id === track.shotId);
  return shot ? intersectRange(range, shot.startFrame, shot.endFrame) : null;
}

/**
 * seg.run v1 限制「所有提示點在同一幀」且錨定幀要在 --frames 內：
 * 播放線那一幀有提示且在區間內就用它；否則取區間內離播放線最近的有提示幀；區間內沒有提示 → null。
 */
export function pickRangePrompt(prompts: readonly PromptV1[], span: FrameRange, playhead: number): PromptV1 | null {
  const inside = prompts.filter((p) => p.frame >= span.in && p.frame < span.out && p.points.length > 0);
  if (!inside.length) return null;
  return inside.find((p) => p.frame === playhead) ?? inside.slice().sort((a, b) => Math.abs(a.frame - playhead) - Math.abs(b.frame - playhead) || a.frame - b.frame)[0];
}

/** seg.run 的 args（dest 名，照 pipeline/mask.ts 的 propagateMasks；差別只有 frames 換成區間）。 */
export function segRangeArgs(o: { video: string; span: FrameRange; prompt: PromptV1; out: string; sam: string }): Record<string, unknown> {
  return {
    video: o.video,
    frames: `${o.span.in}:${o.span.out}`,
    point: o.prompt.points.map((pt) => `${o.prompt.frame}:${pt.x},${pt.y}:${pt.label === 1 ? "add" : "reduce"}`),
    anchor: o.prompt.frame,
    dir: "both",
    out: o.out,
    sam: o.sam || "small",
    previews: 0,
  };
}

interface SegResult {
  objects?: { objId: number; path: string }[];
}

function selectedTrackAndSpan(): { mediaId: string; track: TrackV1; span: FrameRange } | null {
  const mediaId = useProject.getState().activeMediaId;
  const tl = useTimeline.getState();
  if (!mediaId || !tl.selectedTrackId) return null;
  const e = useEdits.getState();
  const track = (e.tracks[mediaId] ?? []).find((x) => x.id === tl.selectedTrackId);
  if (!track) return null;
  const span = trackRangeSpan(track, e.shots[mediaId] ?? [], tl.range);
  return span ? { mediaId, track, span } : null;
}

/** 只追範圍（入點→出點）。 */
export function solveSelectedTrackInRange(): void {
  const sel = selectedTrackAndSpan();
  if (!sel) return void toast.info(t("範圍與這條追蹤的鏡頭沒有重疊"));
  void solveTrack(sel.mediaId, sel.track.id, { from: sel.span.in, to: sel.span.out }).catch((e) => toast.error(errMessage(e)));
}

/** 在範圍內傳播遮罩。 */
export async function propagateSelectedTrackInRange(): Promise<void> {
  const sel = selectedTrackAndSpan();
  if (!sel) return void toast.info(t("範圍與這條追蹤的鏡頭沒有重疊"));
  const { mediaId, track, span } = sel;
  const prompt = pickRangePrompt(track.prompts, span, usePlayback.getState().frame);
  if (!prompt) {
    // 提示點在範圍外：講清楚是哪一幀，使用者才知道要把範圍拉過去、還是在範圍內重點
    const frames = track.prompts.map((p) => p.frame).sort((a, b) => a - b);
    return void toast.info(
      frames.length
        ? t("提示點在第 {frames} 幀，不在範圍 {a}–{b} 內：把範圍拉過去，或在範圍內用加選 / 減選點幾下", { frames: frames.join("、"), a: span.in, b: span.out })
        : t("還沒有提示點：先在範圍內用加選 / 減選點幾下"),
    );
  }
  const media = useProject.getState().media.find((m) => m.id === mediaId);
  if (!media) return;
  try {
    const cacheDir = await cacheDirOf(mediaId);
    if (await maskFileFor(cacheDir, track.id)) {
      const ok = await uiConfirm(t("這條追蹤已經有遮罩。只在範圍內傳播會取代它：範圍外的幀之後沒有遮罩（可以再跑一次整段傳播補回來）。"), {
        title: t("在範圍內傳播遮罩"),
        confirmText: t("傳播"),
      });
      if (!ok) return;
    }
    const out = joinPath(cacheDir, "tracks", track.id, "seg");
    const sam = useSettings.getState().s.engine.sam_variant || "small";
    // 跟整段傳播同一把 dedupe 鑰匙：同一條 track 不會兩份 SAM 同時寫同一個 .aivm
    await dedupe(`mask:${track.id}`, async () => {
      const r = await runEngineJob<SegResult>({ kind: "mask", mediaId, trackId: track.id, op: "seg.run", args: segRangeArgs({ video: media.path, span, prompt, out, sam }), step: "遮罩傳播" });
      const file = r.objects?.[0]?.path;
      if (file) maskHints.set(track.id, file);
      useMasks.getState().clearTrack(track.id);
    });
  } catch (e) {
    toast.error(errMessage(e));
  }
}
