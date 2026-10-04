import type { CaptionCueV1, CaptionPresetId, CaptionSourceV1, CaptionTrackV1, CaptionWordV1 } from "../project/format";
import type { FrameRange } from "../store/timeline";

/**
 * 範圍重辨識 / 重新分段的段落合併（純函式，vitest 直接驗；pipeline/captions.ts 轉出）。
 *
 * 為什麼獨立一個檔：驗收 Medium 1 的資料遺失就出在這裡 —— 範圍 ASR 只聽了 I/O 那一段，
 * 之前「依樣式重新分段」拿它當整支重建，範圍外的字幕整片消失。合併規則有好幾個邊界（跨界段、撞號、幀取整），
 * 跟引擎呼叫 / store 混在一起就很難逐條測。
 */

/**
 * track.source 的 ASR 檔涵蓋哪一段（proxy 幀 [in, out)）；整支 / 沒記 / 形狀不對 → null。
 * `range` 在專案檔是兩邊原樣保留的未知鍵（見 format.ts CaptionSourceV1.range），所以這裡要自己驗：整數、in < out、不出片長。
 */
export function sourceRange(source: CaptionSourceV1 | null | undefined, frames: number | null = null): FrameRange | null {
  const r = source?.range;
  if (!Array.isArray(r) || r.length !== 2) return null;
  const [a, b] = r as unknown[];
  if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
  const lo = Math.max(0, a as number);
  const hi = frames != null && frames > 0 ? Math.min(frames, b as number) : (b as number);
  return lo < hi ? { in: lo, out: hi } : null;
}

/** 來源記上涵蓋範圍（跟 ASR 檔自己的 `range` 同形狀 [K0, K1]）；range null = 整支，原樣回傳。 */
export function withSourceRange(source: CaptionSourceV1, range: FrameRange | null): CaptionSourceV1 {
  if (!range) return source;
  return { ...source, range: [range.in, range.out] };
}

/** 字夾進 [lo, hi)（呼叫端保證字跟區間有交集，所以夾完仍 ≥ 1 幀）；沒動回原物件。 */
function clipWord(w: CaptionWordV1, lo: number, hi: number): CaptionWordV1 {
  const s = Math.max(w.startFrame, lo);
  const e = Math.min(w.endFrame, hi);
  return s === w.startFrame && e === w.endFrame ? w : { ...w, startFrame: s, endFrame: e };
}

/**
 * 舊段落在範圍外的部分。字以**起點**判定歸屬：起點在 in 之前的留下（尾巴裁到 in）、起點在 out（含）之後的留下。
 * 完全在範圍外的段回傳同一個物件 —— 舞台版面快取用物件參考判斷過期，換物件會白白重排。
 * 跨越整個範圍的段會拆成前後兩片，後半片要新 id（放在 renamed）。
 */
function oldPiecesOutside(prev: readonly CaptionCueV1[], { in: a, out: b }: FrameRange): { kept: CaptionCueV1[]; renamed: CaptionCueV1[] } {
  const kept: CaptionCueV1[] = [];
  const renamed: CaptionCueV1[] = [];
  for (const c of prev) {
    if (c.endFrame <= a || c.startFrame >= b) {
      kept.push(c);
      continue;
    }
    const head = c.words.filter((w) => w.startFrame < a).map((w) => clipWord(w, c.startFrame, a));
    const tail = c.words.filter((w) => w.startFrame >= b);
    if (head.length) kept.push({ ...c, endFrame: Math.min(c.endFrame, a), words: head });
    if (tail.length) (head.length ? renamed : kept).push({ ...c, startFrame: Math.max(c.startFrame, b), words: tail });
  }
  return { kept, renamed };
}

/** 新段落在範圍內的部分：只取跟範圍有交集的字、段與字都夾進 [in, out)（範圍 ASR 只聽了這段音訊，超出去的只可能是幀取整或 lag-out）。 */
function freshPiecesInside(fresh: readonly CaptionCueV1[], { in: a, out: b }: FrameRange): CaptionCueV1[] {
  const out: CaptionCueV1[] = [];
  for (const c of fresh) {
    if (c.endFrame <= a || c.startFrame >= b) continue;
    if (c.startFrame >= a && c.endFrame <= b) {
      out.push(c);
      continue;
    }
    const words = c.words.filter((w) => w.endFrame > a && w.startFrame < b).map((w) => clipWord(w, a, b));
    if (words.length) out.push({ ...c, startFrame: Math.max(c.startFrame, a), endFrame: Math.min(c.endFrame, b), words });
  }
  return out;
}

function cueNumber(id: string): number {
  return Number(/^c(\d+)$/.exec(id)?.[1] ?? 0);
}

/**
 * 範圍 [in, out) 交給新的辨識結果，範圍外的舊字幕一個字都不丟。
 * - 舊段：範圍外原樣、跨界的只留範圍外那幾個字（oldPiecesOutside）—— 舊做法是整段換掉，跨界段落在範圍外的字就跟著沒了；
 * - 新段：只留範圍內（freshPiecesInside）；兩邊都以範圍邊界切齊，天生不重疊，不必事後互相裁切；
 * - id：舊段沿用；拆出來的後半片、跟留下的舊段撞號的新段（引擎每次從 c1 起算）編成 c<全部最大編號+1>…，
 *   新編號一定大於任何既有編號，所以不會跟還沒登記到的段撞號。
 */
export function mergeCuesInRange(prev: readonly CaptionCueV1[], fresh: readonly CaptionCueV1[], range: FrameRange): CaptionCueV1[] {
  const { kept, renamed } = oldPiecesOutside(prev, range);
  const inside = freshPiecesInside(fresh, range);
  const taken = new Set(kept.map((c) => c.id));
  let n = Math.max(0, ...[...kept, ...renamed, ...inside].map((c) => cueNumber(c.id)));
  const nextId = () => {
    let id = `c${++n}`;
    while (taken.has(id)) id = `c${++n}`;
    taken.add(id);
    return id;
  };
  const out = [...kept];
  for (const c of [...inside, ...renamed].sort((x, y) => x.startFrame - y.startFrame)) {
    if (renamed.includes(c) || taken.has(c.id)) out.push({ ...c, id: nextId() });
    else {
      taken.add(c.id);
      out.push(c);
    }
  }
  return out.sort((x, y) => x.startFrame - y.startFrame);
}

/**
 * 只重辨識一段（時間軸 I/O）時的合併：範圍內換成新的、範圍外原樣；樣式 / 開關 / 預設沿用舊的。
 * 來源換成這次的範圍 ASR 並**記下範圍** —— 之後「依樣式重新分段」才知道這份 ASR 只涵蓋這段，不會拿它蓋掉整支。
 * 沒有舊 track → 新的（來源一樣記範圍）；range null（整支重來）→ 段落 / 來源 / 預設換新的，使用者調過的樣式與燒入開關留著。
 */
export function mergeCaptionRange(prev: CaptionTrackV1 | null, fresh: CaptionTrackV1, range: FrameRange | null): CaptionTrackV1 {
  const source = fresh.source ? withSourceRange(fresh.source, range) : null;
  if (!prev) return range ? { ...fresh, source } : fresh;
  if (!range) return { ...fresh, enabled: prev.enabled, style: prev.style };
  return { ...prev, source: source ?? prev.source, cues: mergeCuesInRange(prev.cues, fresh.cues, range) };
}

/**
 * 「依樣式重新分段」的結果：預設 / 分段規則換成這次的；段落 ——
 * - 來源是整支的 ASR → 整個換掉（原本的行為）；
 * - 來源只涵蓋一段（範圍重辨識留下的）→ 只重建範圍內的段，範圍外原樣。
 * `cur` 要傳引擎回來**之後**的 store 值：引擎跑的這段時間使用者可能又改了範圍外的字，那些修改不能被請求當下的舊快照蓋掉。
 */
export function rebuiltTrack(cur: CaptionTrackV1, fresh: CaptionTrackV1, preset: CaptionPresetId, frames: number | null = null): { track: CaptionTrackV1; range: FrameRange | null } {
  const range = sourceRange(cur.source, frames);
  const source = fresh.source ? withSourceRange(fresh.source, range) : cur.source;
  const cues = range ? mergeCuesInRange(cur.cues, fresh.cues, range) : fresh.cues;
  return { track: { ...cur, presetId: preset, segmentation: fresh.segmentation, cues, source }, range };
}
