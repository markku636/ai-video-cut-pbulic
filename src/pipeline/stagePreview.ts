// 舞台的合成預覽（計畫 §10 A4「comp.preview 接 PreviewLayer」）。
//
// stage/previewStore 只管快取與節流、刻意不知道引擎；這裡是唯一的接縫（setPreviewProvider）。
//
// ## 為什麼外掛可以叫這裡不送
//
// 引擎的預覽 session 是**模組層級唯一**，鍵是「專案路徑 + media」（ops/_preview_session.py）。
// 外掛如果有自己的預覽（例如牌外掛的牌局檢視讀 `<mediaCache>/vd/deal.aivc.json`），兩個路徑不同，
// 互相會把對方的 session 踢掉，而被踢掉的「決策表」重建要 1–30 秒。所以外掛說不送就不送（plugins/api.ts stage.blockPreview）。
//
// 引擎只有一條 worker：有任何引擎工作在排隊或在跑就不送（跟外掛的預覽同一個紀律），
// 而且同時只讓一個預覽在飛 —— 預覽是「看得到最好、看不到也不擋事」的東西，絕不跟真正的工作搶。
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../api";
import { stagePreviewBlocked } from "../plugins/queries";
import { engineReady } from "../store/engine";
import { engineBusy } from "../store/jobs";
import { setPreviewProvider, type PreviewKeyParts } from "../stage/previewStore";
import { cacheDirOf, joinPath, projectFileFor } from "./project";

/** `comp.preview`（cli preview-frame）：真正的合成結果（跟輸出同一條 composite_at）。舞台只用得到輸出檔的路徑。 */
const PREVIEW_TIMEOUT_MS = 30_000;

function compPreview(args: { project: string; media: string; frame: number; out: string; crop: "full"; max_width: number; view: "replaced"; prune_keep: number }): Promise<{ out: string }> {
  return api.engineCall<{ out: string }>("comp.preview", { ...args }, PREVIEW_TIMEOUT_MS);
}

/** 同時只讓一個預覽在飛（previewStore 的 in-flight 是逐鍵的，跨鍵還是可能疊在一起）。 */
let inFlight = false;

/**
 * 能不能送這次預覽請求。抽成純函式是為了**可測** —— 這四道守門在保護別人的功能
 * （牌局檢視的 session）不被抖動拖垮，只靠讀程式碼相信它不夠。
 */
export function canPreview(s: { ready: boolean; busy: boolean; blocked: boolean; inFlight: boolean }): boolean {
  return s.ready && !s.busy && !s.blocked && !s.inFlight;
}

/** 內容雜湊併成檔名的一段：檔名帶雜湊 → 不必破快取，引擎也會自己修掉舊的。 */
export function stamp(parts: PreviewKeyParts): string {
  return `${parts.tracksHash}-${parts.targetsHash}-${parts.insertHash}`.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16) || "0";
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

async function fetchStagePreview(parts: PreviewKeyParts): Promise<CanvasImageSource | null> {
  const ok = canPreview({ ready: engineReady(), busy: engineBusy(), blocked: stagePreviewBlocked(), inFlight });
  if (!ok) return null;
  inFlight = true;
  try {
    const project = await projectFileFor(parts.mediaId, { scratch: true });
    const out = joinPath(await cacheDirOf(parts.mediaId), "stage", `k${parts.frame}-${stamp(parts)}.png`);
    // crop full、不縮放：PreviewLayer 的並排 / 差異模式靠「遮罩外兩邊逐位元相同」當正確性儀器，縮過就不成立
    const res = await compPreview({ project, media: parts.mediaId, frame: parts.frame, out, crop: "full", max_width: 0, view: "replaced", prune_keep: 4 });
    return await loadImage(convertFileSrc(res.out));
  } catch {
    return null; // 預覽失敗不吵人：畫面退回 <video>，下一次請求再試
  } finally {
    inFlight = false;
  }
}

export function installStagePreview(): () => void {
  setPreviewProvider(fetchStagePreview);
  return () => setPreviewProvider(null);
}
