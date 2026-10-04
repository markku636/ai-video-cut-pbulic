// 文字稿剪輯（對標 Descript / CapCut / Premiere 的 Text-Based Editing）：
// 用字幕的**逐字時間碼**算出「要從序列上剪掉哪幾段」。
//
// 這個檔只做算術，不碰 store、不碰引擎、不碰 i18n。材料是現成的：
// ASR 已經給每個字 startFrame / endFrame（來源幀 k），序列投影與同步鎖軌保護在 silence.ts
// 已經寫好而且有測試，這裡直接重用 —— 差別只在「哪些幀該剪」的判準從音量換成文字。
//
// ## 為什麼預設只剪遲疑音
//
// 「呃、嗯、uh、um」這一類**沒有語意**，剪掉不會改變任何一句話的意思。
// 「那個、這個、就是說」這一類（DISCOURSE_MARKERS）看起來也像贅字，但它們**同時是真的詞**：
// 「那個紅色的」的「那個」是指示詞，剪掉句子就壞了。要分辨得看上下文，那不是字典做得到的事，
// 所以它們預設關、而且**每一段都列出來讓人逐段勾選**（dialog 的清單）——
// 由看得到畫面的人決定，比我在這裡猜一個門檻誠實。
import type { CaptionTrackV1, CaptionWordV1, SequenceV2 } from "../project/format";
import type { SeqFrameRange } from "./ops";
import { mergeRanges, projectToSequence, subtractRanges, syncLockedBusy } from "./silence";

/**
 * 遲疑音：任何語境下都沒有語意，剪掉只會變乾淨。
 *
 * 兩個要小心的：「嗯」也可能是**應答**（「嗯，對」）、「欸」也可能是**招呼**（「欸，你看」）。
 * 沒有上下文分不出來，所以它們照樣列進來，但由清單讓人逐段確認 —— 不是靜悄悄地剪掉。
 */
export const HESITATION_ZH: readonly string[] = ["呃", "痾", "額", "噁", "嗯", "恩", "唔", "呣", "欸", "誒", "哎", "耶"];
/** 英文的遲疑音（ASR 常見拼法都收）。 */
export const HESITATION_EN: readonly string[] = ["uh", "uhh", "uhhh", "um", "umm", "ummm", "er", "err", "erm", "ah", "ahh", "hmm", "hm", "mm", "mmm", "mhm", "eh"];

/**
 * 口頭禪 / 話語標記：**預設不剪**。
 *
 * 每一個都同時是合法的詞（「那個」是指示詞、「就是說」可以是真的在解釋、「其實」可以是轉折），
 * 判斷要看上下文。開了之後請逐段看過清單再套用。
 */
export const DISCOURSE_MARKERS: readonly string[] = ["那個", "這個", "就是說", "你知道嗎", "你知道", "怎麼講", "基本上", "反正", "其實說"];

export type FillerKind = "hesitation" | "discourse" | "repeat";

/** 一段要剪掉的字：來源幀範圍 + 是哪一支媒體的 + 為什麼被挑出來。 */
export interface FillerSpan {
  mediaId: string;
  cueId: string;
  /** 在 cue.words 裡的索引範圍（半開），用來高亮。 */
  i0: number;
  i1: number;
  /** 來源幀（k）半開區間。 */
  k0: number;
  k1: number;
  text: string;
  kind: FillerKind;
}

/**
 * 比對用的正規化：去掉標點與空白、英文轉小寫、去掉重複的尾音。
 *
 * ASR 的輸出常常是「呃，」「um,」這種**字帶標點**的形狀，不剝掉的話字典一個都對不上
 * —— 而症狀是「功能按了沒反應」，不是報錯。
 */
export function normalizeWord(s: string): string {
  return s
    .replace(/[\s　]/g, "")
    .replace(/[，。、？！；：「」『』（）【】…—·,.?!;:"'()[\]{}]/g, "")
    .toLowerCase();
}

/** 遲疑音？（中文逐字比對，英文允許拉長的拼法如 "uhhhh"） */
export function isHesitation(text: string): boolean {
  const w = normalizeWord(text);
  if (!w) return false;
  if (HESITATION_ZH.includes(w)) return true;
  if (HESITATION_EN.includes(w)) return true;
  // 「uhhhhh」「ummmm」：把結尾重複的字母縮成一個再比一次
  return HESITATION_EN.includes(w.replace(/(.)\1+$/, "$1"));
}

export function isDiscourseMarker(text: string): boolean {
  const w = normalizeWord(text);
  return !!w && DISCOURSE_MARKERS.includes(w);
}

export interface FillerOptions {
  /** 連口頭禪一起找（那個、就是說…）。預設 false，理由見 DISCOURSE_MARKERS。 */
  includeDiscourseMarkers: boolean;
  /** 連「重複講的同一個字」一起找（我我我 → 只留最後一個）。 */
  includeRepeats: boolean;
}

export const DEFAULT_FILLER: FillerOptions = { includeDiscourseMarkers: false, includeRepeats: true };

/** 字本身的幀範圍；缺 / 反了就回 null（壞資料不要讓整批剪歪）。 */
function wordRange(w: CaptionWordV1): { k0: number; k1: number } | null {
  const k0 = Math.floor(w.startFrame);
  const k1 = Math.ceil(w.endFrame);
  return Number.isFinite(k0) && Number.isFinite(k1) && k1 > k0 ? { k0, k1 } : null;
}

/**
 * 一條字幕軌裡所有「可以剪掉的字」。
 *
 * 相鄰的同類字會合併成一段（「呃、呃」中間那一點點空白留著也只是雜音），
 * 但**不同類不合併**：清單上要看得出這一段是遲疑音還是口頭禪，才決定得了要不要勾。
 */
export function fillerSpans(mediaId: string, track: CaptionTrackV1 | null, opts: FillerOptions = DEFAULT_FILLER): FillerSpan[] {
  if (!track?.cues?.length) return [];
  const out: FillerSpan[] = [];
  for (const cue of track.cues) {
    const words = cue.words ?? [];
    let run: FillerSpan | null = null;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const kind = kindOf(words, i, opts);
      const r = kind && wordRange(w);
      if (!kind || !r) {
        run = null;
        continue;
      }
      // 同一類而且真的接在上一個字後面才續段；中間隔了別的字就另起一段
      if (run && run.kind === kind && run.i1 === i) {
        run.i1 = i + 1;
        run.k1 = Math.max(run.k1, r.k1);
        run.text += w.text;
      } else {
        run = { mediaId, cueId: cue.id, i0: i, i1: i + 1, k0: r.k0, k1: r.k1, text: w.text, kind };
        out.push(run);
      }
    }
  }
  return out;
}

/**
 * 這個字要不要剪，以及是為什麼。
 *
 * 重複字只剪**前面那幾個**：「我我我覺得」要留最後一個「我」，剪掉整串會把句子挖掉一個詞。
 */
function kindOf(words: readonly CaptionWordV1[], i: number, opts: FillerOptions): FillerKind | null {
  const w = words[i];
  if (isHesitation(w.text)) return "hesitation";
  if (opts.includeDiscourseMarkers && isDiscourseMarker(w.text)) return "discourse";
  if (opts.includeRepeats && i + 1 < words.length) {
    const cur = normalizeWord(w.text);
    if (cur && cur === normalizeWord(words[i + 1].text)) return "repeat";
  }
  return null;
}

/** 整段字幕（一句）的來源幀範圍。 */
export function cueRange(cue: { startFrame: number; endFrame: number }): SeqFrameRange | null {
  const a = Math.floor(cue.startFrame);
  const b = Math.ceil(cue.endFrame);
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? { in: a, out: b } : null;
}

/** 選中的段 → 該媒體的來源幀範圍（同一支媒體的合併、排序）。 */
export function spansToRanges(spans: readonly FillerSpan[], mediaId: string, padFrames = 0): SeqFrameRange[] {
  const mine = spans.filter((s) => s.mediaId === mediaId);
  if (!mine.length) return [];
  const pad = Math.max(0, Math.round(padFrames));
  return mergeRanges(mine.map((s) => ({ in: Math.max(0, s.k0 - pad), out: s.k1 + pad })));
}

export interface TranscriptCutResult {
  /** 找到的段（未投影，給清單用）。 */
  spans: FillerSpan[];
  /** 真的會剪掉的序列幀範圍（已投影、已避開同步鎖軌）。 */
  ranges: SeqFrameRange[];
  /** 序列用到、但還沒有字幕的媒體。 */
  missing: string[];
}

/**
 * 整個序列的語助詞：**每支用到的媒體各自找一次再投影合併**。
 *
 * 跟 silentRangesOfSequence 同一個形狀與同一組理由：只看作用中那一支，接了三支素材時
 * 另外兩支的語助詞會整段留著；沒有字幕的媒體不猜、由 `missing` 讓 UI 講清楚。
 */
export function fillerCutOfSequence(
  seq: SequenceV2,
  trackFor: (mediaId: string) => CaptionTrackV1 | null,
  opts: FillerOptions = DEFAULT_FILLER,
  selected?: (s: FillerSpan) => boolean,
): TranscriptCutResult {
  const ids: string[] = [];
  for (const it of seq.video) if (it.kind === "clip" && !ids.includes(it.mediaId)) ids.push(it.mediaId);
  const spans: FillerSpan[] = [];
  const missing: string[] = [];
  const all: SeqFrameRange[] = [];
  for (const id of ids) {
    const track = trackFor(id);
    if (!track?.cues?.length) {
      missing.push(id);
      continue;
    }
    const found = fillerSpans(id, track, opts);
    spans.push(...found);
    const take = selected ? found.filter(selected) : found;
    all.push(...projectToSequence(seq, id, spansToRanges(take, id)));
  }
  return { spans, ranges: subtractRanges(mergeRanges(all), syncLockedBusy(seq)), missing };
}

/** 一句字幕 → 序列上要剪掉的範圍（同一句可能被用在序列的好幾個地方）。 */
export function cueCutRanges(seq: SequenceV2, mediaId: string, cues: readonly { startFrame: number; endFrame: number }[]): SeqFrameRange[] {
  const k = cues.map(cueRange).filter((r): r is SeqFrameRange => !!r);
  if (!k.length) return [];
  return subtractRanges(projectToSequence(seq, mediaId, mergeRanges(k)), syncLockedBusy(seq));
}

/** 這些段總共佔幾幀（清單上的「會剪掉多少」）。 */
export function totalFrames(ranges: readonly SeqFrameRange[]): number {
  return ranges.reduce((a, r) => a + (r.out - r.in), 0);
}

/**
 * 這些字幕段**還在剪輯裡**嗎（序列上還有用到它的幀）。
 *
 * 字幕是**來源**的逐字稿：序列剪掉一段之後，那幾句並沒有從字幕軌消失（來源還在，
 * 素材也還可以再放回去），只是不會再播到。字幕面板需要這個才講得出
 * 「這句已經不在剪輯裡了」 —— 否則使用者剪完會以為沒剪到。
 *
 * 順帶也涵蓋了所有其他讓句子離開剪輯的操作（移除靜音、手動修剪、刪片段），不只文字稿剪輯。
 */
export function cuesInSequence(seq: SequenceV2, mediaId: string, cues: readonly { id: string; startFrame: number; endFrame: number }[]): Set<string> {
  const used: { a: number; b: number }[] = [];
  for (const it of seq.video) {
    if (it.kind !== "clip" || it.mediaId !== mediaId || it.enabled === false) continue;
    used.push({ a: it.srcIn, b: it.srcOut });
  }
  const out = new Set<string>();
  for (const c of cues) {
    const r = cueRange(c);
    if (r && used.some((u) => Math.min(r.out, u.b) > Math.max(r.in, u.a))) out.add(c.id);
  }
  return out;
}
