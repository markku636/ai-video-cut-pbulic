import { errMessage } from "../api";
import { engineReady, pyenvReady } from "../store/engine";
import { useEdits } from "../store/edits";
import { useProject } from "../store/project";
import type { ShotV1 } from "../project/format";
import { sanitizeShots, emptyReport } from "../project/sanitize";
import { dedupe, runEngineJob } from "./engineJob";

/**
 * proxy 與鏡頭（引擎 `media.proxy` / `media.shots`；計畫 §5.3 快取）。
 *
 * 開檔流程：probe / 指紋在 Rust（引擎沒起來也做，清單先出現）→ 這裡問引擎建 proxy → 成功後從快取讀 proxy.v1.json。
 * 引擎沒安裝時**不丟錯**：把 proxyState 留在 none，SetupBanner 會擋住並帶人去安裝；裝好後再叫一次就好。
 *
 * 閘門是「引擎就緒 **或** pyenv 就緒」：`engine_job_start` 會自己 ensure_started（含 hello），不必等引擎先起來。
 * 只看 engineReady 的話，開檔當下引擎還沒啟動 → 這裡直接 return，之後的補建又排在 pipeline.run 後面
 * （引擎是單一 worker），影片要等整條管線跑完才看得到（整合煙霧測試實際發生過）。
 * `startEngine`：呼叫端確定要用引擎（例如 runPipeline），連 pyenv 狀態都還沒回來也照送。
 */
export function ensureProxy(mediaId: string, opts: { force?: boolean; startEngine?: boolean } = {}): Promise<void> {
  return dedupe(`proxy:${mediaId}`, async () => {
    const p = useProject.getState();
    const m = p.media.find((x) => x.id === mediaId);
    if (!m) return;
    if (m.proxyState === "ready" && !opts.force) return;
    if (!engineReady() && !pyenvReady() && !opts.startEngine) return; // 引擎沒裝：SetupBanner 負責說話
    p.updateMedia(mediaId, { proxyState: "building", error: undefined });
    try {
      await runEngineJob({ kind: "proxy", mediaId, op: "media.proxy", args: { video: m.path, force: !!opts.force }, gpu: false, step: "建 proxy" });
      await useProject.getState().refreshProxy(mediaId);
      const after = useProject.getState().media.find((x) => x.id === mediaId);
      if (after && after.proxyState !== "ready") useProject.getState().updateMedia(mediaId, { proxyState: "stale" });
    } catch (e) {
      useProject.getState().updateMedia(mediaId, { proxyState: "error", error: errMessage(e) });
      throw e;
    }
  });
}

interface ShotsResult {
  shots?: unknown;
  nFrames?: number;
}

/** 鏡頭偵測：結果整份換掉 edits 的鏡頭清單（一筆 undo）。 */
export function detectShots(mediaId: string): Promise<ShotV1[]> {
  return dedupe(`shots:${mediaId}`, async () => {
    const m = useProject.getState().media.find((x) => x.id === mediaId);
    if (!m) return [];
    const r = await runEngineJob<ShotsResult>({ kind: "shots", mediaId, op: "media.shots", args: { video: m.path }, gpu: false, step: "鏡頭偵測" });
    // 引擎的 shots.v1.json 與專案檔的 ShotV1 同形（id/startFrame/endFrame/kind）；照 sanitize 收，壞的丟
    const shots = sanitizeShots(r.shots, m.proxy?.frames ?? r.nFrames ?? null, emptyReport()).map((s) => ({ ...s, source: "auto" as const }));
    useEdits.getState().setShots(mediaId, shots, "鏡頭偵測");
    return shots;
  });
}
