/**
 * 助手的「查詢」工具用的純函式：在字幕裡找一句話、把鏡頭列成秒數。
 *
 * 對標 Premiere 的媒體智慧搜尋（「找到我講 XX 的地方」）與 Descript 的文字稿搜尋。
 * 模型看不到字幕全文（那會吃掉整個 context，而且它會開始亂編時間），所以改成給它一個查詢工具：
 * 它講要找什麼、我們回時間，下一輪它再用 set_range / seek_to 接下去。
 *
 * 不碰 store：材料由 run.ts 從目前的專案取出來餵進來。
 */
import type { Rational } from "../api";
import type { CaptionTrackV1, ShotV1 } from "../project/format";
import { cueText } from "../store/captions";

export interface TranscriptHit {
  cueId: string;
  /** 秒（來源時間）。 */
  start: number;
  end: number;
  text: string;
}

/** 比對用的正規化：去空白與標點、英文小寫。ASR 的「呃，」與使用者打的「呃」要對得上。 */
export function looseText(s: string): string {
  return s
    .replace(/[\s　]/g, "")
    .replace(/[，。、？！；：「」『』（）【】…—·,.?!;:"'()[\]{}]/g, "")
    .toLowerCase();
}

const secondsOf = (frame: number, fps: Rational) => (frame * fps.den) / Math.max(1, fps.num);

/**
 * 在字幕裡找一句話。回最多 `limit` 個命中（依時間）；沒有字幕或沒找到回空陣列。
 *
 * 只在**單一段**裡找：跨段的片語（前半在這段、後半在下一段）找不到。這是刻意的 ——
 * 段的邊界是 ASR 的停頓，跨段的話通常也不是使用者想跳到的那一句。
 */
export function searchTranscript(track: CaptionTrackV1 | null, query: string, fps: Rational, limit = 6): TranscriptHit[] {
  const q = looseText(query);
  if (!track || !q) return [];
  const out: TranscriptHit[] = [];
  for (const c of track.cues) {
    const text = cueText(c);
    if (!looseText(text).includes(q)) continue;
    out.push({ cueId: c.id, start: secondsOf(c.startFrame, fps), end: secondsOf(c.endFrame, fps), text });
    if (out.length >= limit) break;
  }
  return out;
}

export interface ShotSpan {
  /** 1-based，給人講「第二個鏡頭」用。 */
  index: number;
  start: number;
  end: number;
}

/** 鏡頭 → 秒數清單（依時間）。 */
export function shotSpans(shots: readonly ShotV1[], fps: Rational): ShotSpan[] {
  return [...shots]
    .sort((a, b) => a.startFrame - b.startFrame)
    .map((s, i) => ({ index: i + 1, start: secondsOf(s.startFrame, fps), end: secondsOf(s.endFrame, fps) }));
}

const s1 = (x: number) => x.toFixed(1);

/** 命中 → 回報給模型的一句話（只講秒數與那一句，模型下一輪靠這個規劃）。 */
export function describeHits(hits: readonly TranscriptHit[], total: number): string {
  if (!hits.length) return "沒有找到（換個說法，或先確認字幕有這句）";
  const rows = hits.map((h) => `${s1(h.start)}–${s1(h.end)} 秒「${h.text}」`);
  const more = total > hits.length ? `（共 ${total} 處，只列前 ${hits.length}）` : "";
  return `找到 ${total} 處${more}：${rows.join("；")}`;
}

export function describeShots(spans: readonly ShotSpan[], limit = 12): string {
  if (!spans.length) return "沒有偵測到鏡頭切換（整支是同一個鏡頭）";
  const rows = spans.slice(0, limit).map((s) => `鏡頭 ${s.index}：${s1(s.start)}–${s1(s.end)} 秒`);
  const more = spans.length > limit ? `（共 ${spans.length} 個，只列前 ${limit}）` : "";
  return `${spans.length} 個鏡頭${more}：${rows.join("；")}`;
}
