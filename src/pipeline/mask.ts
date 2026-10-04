import { useEdits } from "../store/edits";
import { useMasks } from "../store/masks";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { cacheDirOf, joinPath } from "./project";
import { dedupe, runEngineJob } from "./engineJob";
import { maskHints } from "./track";

/**
 * 物件遮罩（引擎 `seg.run`；計畫 §9 Object Mask）：把 track 的提示點餵給 SAM 2.1、沿鏡頭傳播，輸出 `.aivm`。
 *
 * args = engine/ops/seg.py `_args` 的 dest 名：`video` / `frames "K0:K1"` / `box` ["x,y,w,h"] / `point` ["[OBJ=]K:x,y:add|reduce"] /
 * `anchor` / `dir fwd|bwd|both` / `out`（目錄）/ `sam` / `memory_window` / `overlap` / `previews` / `device`。
 * v1 限制：**所有提示點必須在同一幀**（build_request 會擋），所以只送錨定幀那一幀的提示；錨定幀沒有提示就改用離它最近有提示的幀。
 * 輸出落在 `<out>/obj1/masks.aivm`（每物件一個）；路徑記進 maskHints 讓 track.solve / quad_from_mask 找得到。
 */
export type PropagateDir = "fwd" | "bwd" | "both";

interface SegResult {
  outDir?: string;
  objects?: { objId: number; path: string; framesPresent?: number; framesAbsent?: number }[];
}

export function propagateMasks(mediaId: string, trackId: string, dir: PropagateDir, anchor: number): Promise<void> {
  return dedupe(`mask:${trackId}`, async () => {
    const e = useEdits.getState();
    const t = (e.tracks[mediaId] ?? []).find((x) => x.id === trackId);
    const m = useProject.getState().media.find((x) => x.id === mediaId);
    if (!t || !m) return;
    const shot = (e.shots[mediaId] ?? []).find((s) => s.id === t.shotId);
    if (!shot) throw new Error("這條追蹤不在任何鏡頭裡");
    if (!t.prompts.length) throw new Error("還沒有提示點：先用加選（A）/ 減選（Shift+X）在畫面上點幾下");
    // 同一幀限制：優先錨定幀，否則最近的有提示的幀
    const at = t.prompts.find((p) => p.frame === anchor) ?? t.prompts.slice().sort((a, b) => Math.abs(a.frame - anchor) - Math.abs(b.frame - anchor))[0];
    const point = at.points.map((pt) => `${at.frame}:${pt.x},${pt.y}:${pt.label === 1 ? "add" : "reduce"}`);
    const cacheDir = await cacheDirOf(mediaId);
    const out = joinPath(cacheDir, "tracks", t.id, "seg");
    const s = useSettings.getState().s.engine;
    const r = await runEngineJob<SegResult>({
      kind: "mask",
      mediaId,
      trackId,
      op: "seg.run",
      args: { video: m.path, frames: `${shot.startFrame}:${shot.endFrame}`, point, anchor: at.frame, dir, out, sam: s.sam_variant || "small", previews: 0 },
      step: "遮罩傳播",
    });
    const file = r.objects?.[0]?.path;
    if (file) maskHints.set(t.id, file);
    // 舊位圖全部作廢；MaskLayer 會依需要再讀
    useMasks.getState().clearTrack(trackId);
  });
}
